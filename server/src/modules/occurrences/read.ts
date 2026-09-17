import { sql } from "kysely";
import type { EventStatus, OccurrenceDTO, OccurrencePage, RsvpStatus, Visibility } from "@clubcal/shared";
import { type Actor, canManageClub } from "../../auth/context.js";
import type { DbOrTx } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { seriesVisibleTo } from "../visibility.js";

export interface OccurrenceFilters {
  from: string;
  to: string;
  clubId?: string;
  roomId?: string;
  category?: string;
  q?: string;
  status?: EventStatus;
  mine?: boolean;
  limit: number;
  cursor?: string;
  ids?: string[];
  includeDrafts?: boolean;
}

function baseQuery(db: DbOrTx, actor: Actor) {
  return db
    .selectFrom("event_occurrences as o")
    .innerJoin("event_series as s", "s.id", "o.series_id")
    .innerJoin("clubs as c", "c.id", "s.club_id")
    .innerJoin("users as cu", "cu.id", "s.created_by")
    .leftJoin("rooms as r", "r.id", "o.room_id")
    .leftJoin("rsvps as my", (j) => j.onRef("my.occurrence_id", "=", "o.id").on("my.user_id", "=", actor.user.id))
    .where(seriesVisibleTo(actor))
    .select([
      "o.id",
      "o.series_id",
      "o.starts_at",
      "o.ends_at",
      "o.all_day_start",
      "o.all_day_end",
      "o.capacity",
      "o.cancelled_at",
      "o.cancel_reason",
      "o.is_exception",
      "o.version as occurrence_version",
      "s.title",
      "s.description",
      "s.category",
      "s.visibility",
      "s.status as series_status",
      "s.timezone",
      "s.is_all_day",
      "s.recurrence_weekdays",
      "s.version as series_version",
      "s.club_id",
      "c.name as club_name",
      "c.color as club_color",
      "c.slug as club_slug",
      "cu.id as organizer_id",
      "cu.display_name as organizer_name",
      "r.id as room_id",
      "r.name as room_name",
      "r.location as room_location",
      "r.capacity as room_capacity",
      "my.status as my_status",
      "my.waitlist_position as my_position",
      (eb) =>
        eb
          .selectFrom("rsvps as g")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("g.occurrence_id", "=", "o.id")
          .where("g.status", "=", "going")
          .as("going_count"),
      (eb) =>
        eb
          .selectFrom("rsvps as w")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("w.occurrence_id", "=", "o.id")
          .where("w.status", "=", "waitlisted")
          .as("waitlist_count"),
      (eb) =>
        eb
          .selectFrom("rsvps as w2")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("w2.occurrence_id", "=", "o.id")
          .where("w2.status", "=", "waitlisted")
          .where(sql<boolean>`w2.waitlist_position <= my.waitlist_position`)
          .as("my_rank"),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>["executeTakeFirstOrThrow"]>>;

function toDTO(actor: Actor, r: Row): OccurrenceDTO {
  const cancelled = r.cancelled_at !== null;
  return {
    id: r.id,
    seriesId: r.series_id,
    title: r.title,
    description: r.description,
    category: r.category,
    club: { id: r.club_id, name: r.club_name, color: r.club_color, slug: r.club_slug },
    organizer: { id: r.organizer_id, displayName: r.organizer_name },
    room: r.room_id
      ? { id: r.room_id, name: r.room_name!, location: r.room_location!, capacity: r.room_capacity! }
      : null,
    capacity: r.capacity,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    allDay: r.is_all_day,
    allDayStart: r.all_day_start,
    allDayEnd: r.all_day_end,
    timezone: r.timezone,
    visibility: r.visibility as Visibility,
    status: cancelled ? "cancelled" : (r.series_status as EventStatus),
    seriesStatus: r.series_status as EventStatus,
    occurrenceCancelled: cancelled,
    cancelReason: r.cancel_reason,
    isRecurring: r.recurrence_weekdays !== null,
    isException: r.is_exception,
    occurrenceVersion: r.occurrence_version,
    seriesVersion: r.series_version,
    goingCount: Number(r.going_count ?? 0),
    waitlistCount: Number(r.waitlist_count ?? 0),
    myRsvp: (r.my_status as RsvpStatus | null) ?? null,
    myWaitlistPosition: r.my_status === "waitlisted" ? Number(r.my_rank ?? 0) : null,
    canManage: canManageClub(actor, r.club_id),
  };
}

function encodeCursor(startsAt: Date, id: string) {
  return Buffer.from(`${startsAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { startsAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const startsAt = new Date(ts ?? "");
  if (!id || Number.isNaN(startsAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest("Invalid cursor");
  return { startsAt, id };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listOccurrences(db: DbOrTx, actor: Actor, f: OccurrenceFilters): Promise<OccurrencePage> {
  let q = baseQuery(db, actor)
    .where("o.starts_at", "<", new Date(f.to))
    .where("o.ends_at", ">", new Date(f.from))
    .where("c.archived_at", "is", null);
  if (f.clubId) q = q.where("s.club_id", "=", f.clubId);
  if (f.roomId) q = q.where("o.room_id", "=", f.roomId);
  if (f.category) q = q.where("s.category", "=", f.category);
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    q = q.where((eb) => eb.or([eb("s.title", "ilike", pattern), eb("s.description", "ilike", pattern)]));
  }
  if (f.status === "cancelled") {
    q = q.where((eb) => eb.or([eb("s.status", "=", "cancelled"), eb("o.cancelled_at", "is not", null)]));
  } else if (f.status) {
    q = q.where("s.status", "=", f.status).where("o.cancelled_at", "is", null);
  } else if (!f.includeDrafts) {
    q = q.where("s.status", "in", ["approved", "pending", "cancelled"]);
  }
  if (f.mine) q = q.where("my.status", "in", ["going", "waitlisted"]);
  if (f.ids) q = q.where("o.id", "in", f.ids.length ? f.ids : ["00000000-0000-0000-0000-000000000000"]);
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    q = q.where((eb) =>
      eb.or([eb("o.starts_at", ">", c.startsAt), eb.and([eb("o.starts_at", "=", c.startsAt), eb("o.id", ">", c.id)])]),
    );
  }
  const rows = await q.orderBy("o.starts_at").orderBy("o.id").limit(f.limit + 1).execute();
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDTO(actor, r)),
    nextCursor: rows.length > f.limit && last ? encodeCursor(last.starts_at, last.id) : null,
  };
}

/** Returns the occurrence if (and only if) the actor may see it. */
export async function getOccurrence(db: DbOrTx, actor: Actor, id: string): Promise<OccurrenceDTO | null> {
  const row = await baseQuery(db, actor).where("o.id", "=", id).executeTakeFirst();
  return row ? toDTO(actor, row) : null;
}

export async function listSeriesOccurrences(db: DbOrTx, actor: Actor, seriesId: string): Promise<OccurrenceDTO[]> {
  const rows = await baseQuery(db, actor).where("o.series_id", "=", seriesId).orderBy("o.starts_at").limit(400).execute();
  return rows.map((r) => toDTO(actor, r));
}
