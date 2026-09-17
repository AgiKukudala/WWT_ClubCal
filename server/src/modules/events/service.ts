import type {
  CreateEventInput,
  EventStatus,
  SeriesDTO,
  UpdateOccurrenceInput,
  UpdateSeriesInput,
} from "@clubcal/shared";
import { type Actor, assertCanManageClub, canManageClub, isAdmin } from "../../auth/context.js";
import type { Db, DbOrTx, Tx } from "../../db/index.js";
import type { Occurrence, Series } from "../../db/types.js";
import { audit, diff } from "../../lib/audit.js";
import { badRequest, conflict, forbidden, notFound, versionConflict } from "../../lib/errors.js";
import { formatLocalRange, hhmm, planOccurrence, planSeries, type SeriesShape } from "../../lib/time.js";
import type { JobQueue } from "../../queue/boss.js";
import { type BookingCandidate, findBookingConflicts, release, reserve } from "../bookings/bookings.js";
import { adminIds, attendeeIds, notify, notifyMany } from "../notifications/notify.js";
import { syncReminders } from "../reminders/sync.js";
import { rebalance } from "../rsvps/rsvps.js";
import { canViewSeries } from "../visibility.js";

export interface Deps {
  db: Db;
  queue: JobQueue;
  now?: () => Date;
}

const nowOf = (d: Deps) => (d.now ? d.now() : new Date());

// ------------------------------------------------------------------ helpers

export function shapeOf(s: Series): SeriesShape {
  return {
    timezone: s.timezone,
    allDay: s.is_all_day,
    startDate: s.start_date,
    startTime: s.local_start_time ? hhmm(s.local_start_time) : null,
    durationMinutes: s.duration_minutes,
    allDayDays: s.all_day_days,
    recurrence: s.recurrence_weekdays && s.recurrence_until ? { weekdays: s.recurrence_weekdays, until: s.recurrence_until } : null,
  };
}

function inputShape(i: CreateEventInput | UpdateSeriesInput): SeriesShape {
  return {
    timezone: i.timezone,
    allDay: i.allDay,
    startDate: i.startDate,
    startTime: i.allDay ? null : (i.startTime ?? null),
    durationMinutes: i.allDay ? null : (i.durationMinutes ?? null),
    allDayDays: i.allDay ? (i.allDayDays ?? 1) : null,
    recurrence: i.recurrence ? { weekdays: [...new Set(i.recurrence.weekdays)].sort(), until: i.recurrence.until } : null,
  };
}

async function resolveCapacity(db: DbOrTx, roomId: string | null | undefined, capacity: number | null | undefined) {
  if (!roomId) return { roomId: null, capacity: capacity ?? null };
  const room = await db.selectFrom("rooms").select(["capacity", "is_active"]).where("id", "=", roomId).executeTakeFirst();
  if (!room) throw badRequest("Unknown room", { roomId: ["Unknown room"] });
  // Room events always have a capacity: default to the room's own limit.
  return { roomId, capacity: capacity ?? room.capacity };
}

async function lockSeries(tx: Tx, id: string): Promise<Series> {
  const s = await tx.selectFrom("event_series").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  if (!s) throw notFound("Event");
  return s;
}

function assertVisibleAndManageable(actor: Actor, s: Series) {
  if (!canViewSeries(actor, s)) throw notFound("Event");
  if (!canManageClub(actor, s.club_id)) throw forbidden("Only this club's organizers or an administrator can change this event.");
}

function candidatesFor(occs: Pick<Occurrence, "id" | "occurrence_date" | "room_id" | "starts_at" | "ends_at" | "capacity">[]) {
  return occs
    .filter((o) => o.room_id)
    .map((o) => ({
      occurrenceId: o.id,
      date: o.occurrence_date,
      roomId: o.room_id!,
      startsAt: o.starts_at,
      endsAt: o.ends_at,
      capacity: o.capacity,
    }));
}

async function activeFutureOccurrences(tx: Tx, seriesId: string, now: Date) {
  return tx
    .selectFrom("event_occurrences")
    .selectAll()
    .where("series_id", "=", seriesId)
    .where("cancelled_at", "is", null)
    .where("ends_at", ">", now)
    .orderBy("starts_at")
    .execute();
}

/** Re-reserves rooms for an approved series' upcoming occurrences, or releases them otherwise. */
async function applyBookings(tx: Tx, series: Pick<Series, "id" | "status">, now: Date) {
  const occs = await activeFutureOccurrences(tx, series.id, now);
  if (series.status === "approved") {
    await release(tx, occs.filter((o) => !o.room_id).map((o) => o.id));
    await reserve(tx, candidatesFor(occs));
  } else {
    await release(tx, occs.map((o) => o.id));
  }
  return occs;
}

const MATERIAL_FIELDS = [
  "timezone",
  "is_all_day",
  "start_date",
  "local_start_time",
  "duration_minutes",
  "all_day_days",
  "recurrence_weekdays",
  "recurrence_until",
  "room_id",
  "capacity",
] as const;

export function toSeriesDTO(s: Series, creator: { id: string; display_name: string }, occurrenceCount: number): SeriesDTO {
  const shape = shapeOf(s);
  return {
    id: s.id,
    clubId: s.club_id,
    title: s.title,
    description: s.description,
    category: s.category,
    visibility: s.visibility,
    status: s.status,
    timezone: s.timezone,
    allDay: s.is_all_day,
    startDate: s.start_date,
    startTime: shape.startTime,
    durationMinutes: s.duration_minutes,
    allDayDays: s.all_day_days,
    roomId: s.room_id,
    capacity: s.capacity,
    recurrence: shape.recurrence,
    version: s.version,
    reviewComment: s.review_comment,
    reviewedAt: s.reviewed_at?.toISOString() ?? null,
    submittedAt: s.submitted_at?.toISOString() ?? null,
    createdBy: { id: creator.id, displayName: creator.display_name },
    occurrenceCount,
  };
}

export async function getSeries(db: Db, actor: Actor, id: string): Promise<SeriesDTO> {
  const s = await db.selectFrom("event_series").selectAll().where("id", "=", id).executeTakeFirst();
  if (!s || !canViewSeries(actor, s)) throw notFound("Event");
  const creator = await db.selectFrom("users").select(["id", "display_name"]).where("id", "=", s.created_by).executeTakeFirstOrThrow();
  const count = await db
    .selectFrom("event_occurrences")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("series_id", "=", id)
    .executeTakeFirstOrThrow();
  return toSeriesDTO(s, creator, Number(count.n));
}

// ------------------------------------------------------------------ create

export async function createEvent(deps: Deps, actor: Actor, input: CreateEventInput, opts: { legacyImportId?: string; allowPast?: boolean; isDemo?: boolean } = {}) {
  assertCanManageClub(actor, input.clubId);
  const now = nowOf(deps);
  const shape = inputShape(input);
  const planned = planSeries(shape);
  if (planned.length === 0) throw badRequest("The recurrence rule produces no dates. Check the weekdays and end date.", { recurrence: ["No matching dates"] });
  if (!opts.allowPast && planned[0]!.startsAt < now) throw badRequest("Events cannot start in the past.", { startDate: ["Choose a future date/time"] });

  return deps.db.transaction().execute(async (tx) => {
    const club = await tx.selectFrom("clubs").select(["id", "archived_at"]).where("id", "=", input.clubId).executeTakeFirst();
    if (!club || club.archived_at) throw badRequest("Unknown or archived club", { clubId: ["Unknown club"] });
    const { roomId, capacity } = await resolveCapacity(tx, input.roomId, input.capacity);

    // Administrators are the approvers, so their submissions are approved directly.
    const status: EventStatus = input.submit ? (isAdmin(actor) ? "approved" : "pending") : "draft";

    if (roomId) {
      // Validate hours/capacity up front even for drafts, so organizers learn early.
      const problems = (
        await findBookingConflicts(
          tx,
          planned.map((p) => ({ date: p.date, roomId, startsAt: p.startsAt, endsAt: p.endsAt, capacity })),
        )
      ).filter((p) => status === "approved" || p.reason !== "room_booked");
      if (problems.length) {
        throw conflict(problems.length === 1 ? problems[0]!.message : `${problems.length} occurrences have booking problems. Nothing was saved.`, problems);
      }
    }

    const series = await tx
      .insertInto("event_series")
      .values({
        club_id: input.clubId,
        created_by: actor.user.id,
        title: input.title,
        description: input.description,
        category: input.category,
        visibility: input.visibility,
        status,
        timezone: shape.timezone,
        is_all_day: shape.allDay,
        start_date: shape.startDate,
        local_start_time: shape.startTime,
        duration_minutes: shape.durationMinutes,
        all_day_days: shape.allDayDays,
        recurrence_weekdays: shape.recurrence?.weekdays ?? null,
        recurrence_until: shape.recurrence?.until ?? null,
        room_id: roomId,
        capacity,
        submitted_at: input.submit ? now : null,
        reviewed_by: status === "approved" ? actor.user.id : null,
        reviewed_at: status === "approved" ? now : null,
        legacy_import_id: opts.legacyImportId ?? null,
        is_demo: opts.isDemo ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const occs = await tx
      .insertInto("event_occurrences")
      .values(
        planned.map((p) => ({
          series_id: series.id,
          occurrence_date: p.date,
          starts_at: p.startsAt,
          ends_at: p.endsAt,
          all_day_start: p.allDayStart,
          all_day_end: p.allDayEnd,
          room_id: roomId,
          capacity,
        })),
      )
      .returningAll()
      .execute();

    if (status === "approved") await reserve(tx, candidatesFor(occs));

    await audit(tx, actor.user.id, "series.created", "series", series.id, {
      status,
      title: series.title,
      occurrences: occs.length,
      dstAdjusted: planned.filter((p) => p.resolution !== "exact").map((p) => ({ date: p.date, resolution: p.resolution })),
      legacyImportId: opts.legacyImportId ?? undefined,
    });
    if (status === "pending") await notifyAdminsOfSubmission(tx, deps.queue, series);
    return { series, occurrences: occs };
  });
}

async function notifyAdminsOfSubmission(tx: Tx, queue: JobQueue, s: Series) {
  await notifyMany(tx, queue, await adminIds(tx), (userId) => ({
    userId,
    kind: "approval.requested",
    title: `Approval requested: ${s.title}`,
    body: "An organizer submitted an event for review.",
    dedupeKey: `submitted:${s.id}:${s.version}:${userId}`,
  }));
}

// ------------------------------------------------------------------ submit / review

export async function submitSeries(deps: Deps, actor: Actor, id: string, expectedVersion: number) {
  return deps.db.transaction().execute(async (tx) => {
    const s = await lockSeries(tx, id);
    assertVisibleAndManageable(actor, s);
    if (s.version !== expectedVersion) throw versionConflict(s.version);
    if (s.status !== "draft" && s.status !== "rejected") throw conflict(`Only drafts or rejected events can be submitted (this one is ${s.status}).`);
    const upcoming = await activeFutureOccurrences(tx, s.id, nowOf(deps));
    if (upcoming.length === 0) throw conflict("This event has no upcoming occurrences to submit.");
    const updated = await tx
      .updateTable("event_series")
      .set({ status: "pending", submitted_at: nowOf(deps), version: s.version + 1, updated_at: nowOf(deps) })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, actor.user.id, "series.submitted", "series", id, { from: s.status });
    await notifyAdminsOfSubmission(tx, deps.queue, updated);
    return updated;
  });
}

export async function reviewSeries(deps: Deps, actor: Actor, id: string, decision: "approve" | "reject", comment: string, expectedVersion: number) {
  if (!isAdmin(actor)) throw forbidden("Only administrators can review events.");
  const now = nowOf(deps);
  return deps.db.transaction().execute(async (tx) => {
    const s = await lockSeries(tx, id);
    if (s.version !== expectedVersion) throw versionConflict(s.version);
    if (s.status !== "pending") throw conflict(`Only pending events can be reviewed (this one is ${s.status}).`);
    const status: EventStatus = decision === "approve" ? "approved" : "rejected";
    const updated = await tx
      .updateTable("event_series")
      .set({ status, review_comment: comment || null, reviewed_by: actor.user.id, reviewed_at: now, version: s.version + 1, updated_at: now })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Approval re-checks every room booking inside this transaction.
    const occs = await applyBookings(tx, updated, now);
    const ids = occs.map((o) => o.id);
    if (status === "approved") for (const oid of ids) await rebalance(tx, deps.queue, oid, actor.user.id);
    await syncReminders(tx, ids);
    await audit(tx, actor.user.id, `series.${decision === "approve" ? "approved" : "rejected"}`, "series", id, { comment });

    const recipients = new Set<string>([s.created_by]);
    const orgs = await tx.selectFrom("club_memberships").select("user_id").where("club_id", "=", s.club_id).where("role", "=", "organizer").execute();
    orgs.forEach((o) => recipients.add(o.user_id));
    await notifyMany(tx, deps.queue, recipients, (userId) => ({
      userId,
      kind: `approval.${status}`,
      title: `${status === "approved" ? "Approved" : "Changes requested"}: ${s.title}`,
      body: comment || (status === "approved" ? "The event is now published." : "The event was not approved."),
      occurrenceId: ids[0] ?? null,
      dedupeKey: `review:${id}:${updated.version}:${userId}`,
    }));
    if (status === "approved") {
      // Attendees of a re-approved (edited) event learn it is back on.
      const attendees = await attendeeIds(tx, ids);
      for (const [oid, users] of attendees) {
        await notifyMany(tx, deps.queue, users, (userId) => ({
          userId,
          kind: "event.updated",
          title: `Updated event confirmed: ${s.title}`,
          body: "The organizer's changes were approved. Check the event for the current time and room.",
          occurrenceId: oid,
          dedupeKey: `reapproved:${oid}:${updated.version}:${userId}`,
        }));
      }
    }
    return updated;
  });
}

// ------------------------------------------------------------------ update series

export async function updateSeries(deps: Deps, actor: Actor, id: string, input: UpdateSeriesInput) {
  const now = nowOf(deps);
  return deps.db.transaction().execute(async (tx) => {
    const s = await lockSeries(tx, id);
    assertVisibleAndManageable(actor, s);
    if (s.version !== input.expectedVersion) throw versionConflict(s.version);
    if (s.status === "cancelled") throw conflict("Cancelled events cannot be edited.");

    const shape = inputShape(input);
    const { roomId, capacity } = await resolveCapacity(tx, input.roomId, input.capacity);
    const next = {
      title: input.title,
      description: input.description,
      category: input.category,
      visibility: input.visibility,
      timezone: shape.timezone,
      is_all_day: shape.allDay,
      start_date: shape.startDate,
      local_start_time: shape.startTime,
      duration_minutes: shape.durationMinutes,
      all_day_days: shape.allDayDays,
      recurrence_weekdays: shape.recurrence?.weekdays ?? null,
      recurrence_until: shape.recurrence?.until ?? null,
      room_id: roomId,
      capacity,
    };
    const before = { ...s, local_start_time: s.local_start_time ? hhmm(s.local_start_time) : null };
    const changes = diff(before, next);
    if (Object.keys(changes).length === 0) return s;
    const material = MATERIAL_FIELDS.some((f) => f in changes);

    // Reapproval policy: organizers' material changes to an approved event send it
    // back to review (releasing its rooms). Administrators' edits stay approved.
    let status = s.status;
    if (material && s.status === "approved" && !isAdmin(actor)) status = "pending";

    const updated = await tx
      .updateTable("event_series")
      .set({
        ...next,
        status,
        version: s.version + 1,
        updated_at: now,
        submitted_at: status === "pending" && s.status !== "pending" ? now : s.submitted_at,
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const touched = material ? await rematerialize(tx, updated, now) : { changedIds: [] as string[], removedIds: [] as string[] };
    const occs = material || status !== s.status ? await applyBookings(tx, updated, now) : await activeFutureOccurrences(tx, id, now);
    const allIds = occs.map((o) => o.id).concat(touched.removedIds);
    if (material) for (const o of occs) await rebalance(tx, deps.queue, o.id, actor.user.id);
    await syncReminders(tx, allIds);

    await audit(tx, actor.user.id, "series.updated", "series", id, {
      changes,
      statusChange: status !== s.status ? { from: s.status, to: status } : undefined,
      rescheduledOccurrences: touched.changedIds.length,
      removedOccurrences: touched.removedIds.length,
    });

    if (s.status === "approved" && (material || status !== s.status)) {
      const attendees = await attendeeIds(tx, allIds);
      for (const [oid, users] of attendees) {
        const removed = touched.removedIds.includes(oid);
        await notifyMany(tx, deps.queue, users, (userId) => ({
          userId,
          kind: removed ? "event.cancelled" : "event.updated",
          title: `${removed ? "Cancelled" : status === "pending" ? "Being rescheduled" : "Updated"}: ${updated.title}`,
          body: removed
            ? "This date was removed from the series."
            : status === "pending"
              ? "The organizer changed the time, room or capacity. The event is awaiting re-approval."
              : "The time, room or capacity changed. Check the event details.",
          occurrenceId: oid,
          dedupeKey: `series-update:${oid}:${updated.version}:${userId}`,
        }));
      }
    }
    if (status === "pending" && s.status !== "pending") await notifyAdminsOfSubmission(tx, deps.queue, updated);
    return updated;
  });
}

/**
 * Brings occurrences in line with the series rule. Past occurrences are left alone;
 * individually cancelled occurrences stay cancelled; series-wide scheduling edits
 * replace per-occurrence overrides. Dates dropped from the rule are cancelled if
 * anyone responded, otherwise deleted.
 */
async function rematerialize(tx: Tx, s: Series, now: Date) {
  const shape = shapeOf(s);
  const planned = planSeries(shape);
  const existing = await tx.selectFrom("event_occurrences").selectAll().where("series_id", "=", s.id).execute();
  const byDate = new Map(existing.map((o) => [o.occurrence_date, o]));
  const plannedDates = new Set(planned.map((p) => p.date));
  const changedIds: string[] = [];
  const removedIds: string[] = [];

  for (const p of planned) {
    const cur = byDate.get(p.date);
    if (cur && cur.ends_at <= now) continue;
    if (!cur) {
      if (p.startsAt <= now) continue;
      await tx
        .insertInto("event_occurrences")
        .values({
          series_id: s.id,
          occurrence_date: p.date,
          starts_at: p.startsAt,
          ends_at: p.endsAt,
          all_day_start: p.allDayStart,
          all_day_end: p.allDayEnd,
          room_id: s.room_id,
          capacity: s.capacity,
        })
        .execute();
      continue;
    }
    const same =
      cur.starts_at.getTime() === p.startsAt.getTime() &&
      cur.ends_at.getTime() === p.endsAt.getTime() &&
      cur.room_id === s.room_id &&
      cur.capacity === s.capacity &&
      cur.all_day_start === p.allDayStart &&
      !cur.is_exception;
    if (same) continue;
    await tx
      .updateTable("event_occurrences")
      .set({
        starts_at: p.startsAt,
        ends_at: p.endsAt,
        all_day_start: p.allDayStart,
        all_day_end: p.allDayEnd,
        room_id: s.room_id,
        capacity: s.capacity,
        is_exception: false,
        version: cur.version + 1,
        updated_at: now,
      })
      .where("id", "=", cur.id)
      .execute();
    changedIds.push(cur.id);
  }

  for (const o of existing) {
    if (plannedDates.has(o.occurrence_date) || o.ends_at <= now || o.cancelled_at) continue;
    const responses = await tx.selectFrom("rsvps").select("id").where("occurrence_id", "=", o.id).limit(1).executeTakeFirst();
    if (responses) {
      await tx
        .updateTable("event_occurrences")
        .set({ cancelled_at: now, cancel_reason: "Removed from the series schedule", version: o.version + 1, updated_at: now })
        .where("id", "=", o.id)
        .execute();
      removedIds.push(o.id);
    } else {
      await tx.deleteFrom("event_occurrences").where("id", "=", o.id).execute();
    }
  }
  await release(tx, removedIds);
  const remaining = await tx
    .selectFrom("event_occurrences")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("series_id", "=", s.id)
    .executeTakeFirstOrThrow();
  if (Number(remaining.n) === 0) throw badRequest("The new schedule produces no dates.", { recurrence: ["No matching dates"] });
  return { changedIds, removedIds };
}

// ------------------------------------------------------------------ update one occurrence

export async function updateOccurrence(deps: Deps, actor: Actor, occurrenceId: string, input: UpdateOccurrenceInput) {
  const now = nowOf(deps);
  return deps.db.transaction().execute(async (tx) => {
    const occ0 = await tx.selectFrom("event_occurrences").select("series_id").where("id", "=", occurrenceId).executeTakeFirst();
    if (!occ0) throw notFound("Event");
    // Lock order everywhere: series, then occurrence.
    const s = await lockSeries(tx, occ0.series_id);
    const occ = await tx.selectFrom("event_occurrences").selectAll().where("id", "=", occurrenceId).forUpdate().executeTakeFirstOrThrow();
    assertVisibleAndManageable(actor, s);
    if (occ.version !== input.expectedVersion) throw versionConflict(occ.version);
    if (s.status === "cancelled" || occ.cancelled_at) throw conflict("Cancelled events cannot be edited.");
    if (s.is_all_day) throw badRequest("All-day occurrences can only be changed for the whole series.");
    if (occ.ends_at <= now) throw conflict("Past occurrences cannot be edited.");

    const planned = planOccurrence(shapeOf(s), input.date, input.startTime, input.durationMinutes);
    if (planned.startsAt <= now) throw badRequest("The new time is in the past.", { date: ["Choose a future time"] });
    const { roomId, capacity } = await resolveCapacity(tx, input.roomId, input.capacity);
    const changes = diff(
      { starts_at: occ.starts_at, ends_at: occ.ends_at, room_id: occ.room_id, capacity: occ.capacity },
      { starts_at: planned.startsAt, ends_at: planned.endsAt, room_id: roomId, capacity },
    );
    if (Object.keys(changes).length === 0) return occ;

    let status = s.status;
    if (s.status === "approved" && !isAdmin(actor)) status = "pending";

    const updatedOcc = await tx
      .updateTable("event_occurrences")
      .set({ starts_at: planned.startsAt, ends_at: planned.endsAt, room_id: roomId, capacity, is_exception: true, version: occ.version + 1, updated_at: now })
      .where("id", "=", occurrenceId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const seriesUpdate = await tx
      .updateTable("event_series")
      .set({ status, version: s.version + 1, updated_at: now, submitted_at: status !== s.status ? now : s.submitted_at })
      .where("id", "=", s.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const occs = await applyBookings(tx, seriesUpdate, now);
    await rebalance(tx, deps.queue, occurrenceId, actor.user.id);
    await syncReminders(tx, occs.map((o) => o.id));
    await audit(tx, actor.user.id, "occurrence.updated", "occurrence", occurrenceId, {
      seriesId: s.id,
      changes,
      statusChange: status !== s.status ? { from: s.status, to: status } : undefined,
    });

    if (s.status === "approved") {
      const attendees = await attendeeIds(tx, status === "pending" ? occs.map((o) => o.id) : [occurrenceId]);
      for (const [oid, users] of attendees) {
        await notifyMany(tx, deps.queue, users, (userId) => ({
          userId,
          kind: "event.updated",
          title: `${status === "pending" ? "Being rescheduled" : "Updated"}: ${s.title}`,
          body:
            oid === occurrenceId
              ? `Now ${formatLocalRange(planned.startsAt, planned.endsAt, s.timezone)}.${status === "pending" ? " Awaiting re-approval." : ""}`
              : "Another date in this series changed and the series is awaiting re-approval.",
          occurrenceId: oid,
          dedupeKey: `occ-update:${oid}:${seriesUpdate.version}:${userId}`,
        }));
      }
      if (status === "pending") await notifyAdminsOfSubmission(tx, deps.queue, seriesUpdate);
    }
    return updatedOcc;
  });
}

// ------------------------------------------------------------------ cancel & delete

export async function cancelEvent(deps: Deps, actor: Actor, occurrenceId: string, scope: "occurrence" | "series", reason: string) {
  const now = nowOf(deps);
  return deps.db.transaction().execute(async (tx) => {
    const occ0 = await tx.selectFrom("event_occurrences").select("series_id").where("id", "=", occurrenceId).executeTakeFirst();
    if (!occ0) throw notFound("Event");
    const s = await lockSeries(tx, occ0.series_id);
    assertVisibleAndManageable(actor, s);
    if (s.status === "cancelled") throw conflict("This event is already cancelled.");
    if (s.status !== "approved" && s.status !== "pending") {
      throw conflict("Drafts and rejected events are deleted rather than cancelled.");
    }
    if (s.status === "pending") {
      // A pending series is only "cancellable" if it was published before (people responded);
      // otherwise cancelling would expose a never-approved event as a public cancellation.
      const responded = await tx
        .selectFrom("rsvps as r")
        .innerJoin("event_occurrences as o", "o.id", "r.occurrence_id")
        .select("r.id")
        .where("o.series_id", "=", s.id)
        .limit(1)
        .executeTakeFirst();
      if (!responded) throw conflict("This event was never published. Delete it instead of cancelling.");
    }

    let targets: Occurrence[];
    if (scope === "occurrence") {
      const occ = await tx.selectFrom("event_occurrences").selectAll().where("id", "=", occurrenceId).forUpdate().executeTakeFirstOrThrow();
      if (occ.cancelled_at) throw conflict("This occurrence is already cancelled.");
      if (occ.ends_at <= now) throw conflict("Past occurrences cannot be cancelled.");
      targets = [occ];
    } else {
      targets = await activeFutureOccurrences(tx, s.id, now);
    }
    const ids = targets.map((t) => t.id);
    for (const t of targets) {
      await tx
        .updateTable("event_occurrences")
        .set({ cancelled_at: now, cancel_reason: reason || null, version: t.version + 1, updated_at: now })
        .where("id", "=", t.id)
        .execute();
    }
    const seriesUpdate = await tx
      .updateTable("event_series")
      .set({ status: scope === "series" ? "cancelled" : s.status, version: s.version + 1, updated_at: now })
      .where("id", "=", s.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await release(tx, ids);
    await syncReminders(tx, ids);
    await audit(tx, actor.user.id, scope === "series" ? "series.cancelled" : "occurrence.cancelled", scope === "series" ? "series" : "occurrence", scope === "series" ? s.id : occurrenceId, {
      reason,
      occurrences: ids.length,
    });
    const attendees = await attendeeIds(tx, ids);
    for (const [oid, users] of attendees) {
      const t = targets.find((x) => x.id === oid)!;
      await notifyMany(tx, deps.queue, users, (userId) => ({
        userId,
        kind: "event.cancelled",
        title: `Cancelled: ${s.title}`,
        body: `${formatLocalRange(t.starts_at, t.ends_at, s.timezone)} was cancelled.${reason ? ` Reason: ${reason}` : ""}`,
        occurrenceId: oid,
        dedupeKey: `cancelled:${oid}:${userId}`,
      }));
    }
    return { series: seriesUpdate, cancelled: ids.length };
  });
}

export async function deleteSeries(deps: Deps, actor: Actor, id: string) {
  return deps.db.transaction().execute(async (tx) => {
    const s = await lockSeries(tx, id);
    assertVisibleAndManageable(actor, s);
    if (!["draft", "rejected", "pending"].includes(s.status)) throw conflict("Approved events must be cancelled, not deleted.");
    const responded = await tx
      .selectFrom("rsvps as r")
      .innerJoin("event_occurrences as o", "o.id", "r.occurrence_id")
      .select("r.id")
      .where("o.series_id", "=", id)
      .limit(1)
      .executeTakeFirst();
    if (responded) throw conflict("People have already responded to this event; cancel it instead.");
    await tx.deleteFrom("event_series").where("id", "=", id).execute();
    await audit(tx, actor.user.id, "series.deleted", "series", id, { title: s.title, status: s.status });
  });
}

export { notify };
