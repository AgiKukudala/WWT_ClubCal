import { sql } from "kysely";
import type { AttendeeDTO, RsvpStatus } from "@clubcal/shared";
import type { Actor } from "../../auth/context.js";
import type { Db, Tx } from "../../db/index.js";
import { audit } from "../../lib/audit.js";
import { conflict, notFound } from "../../lib/errors.js";
import type { JobQueue } from "../../queue/boss.js";
import { notify } from "../notifications/notify.js";
import { syncReminders } from "../reminders/sync.js";
import { canViewSeries } from "../visibility.js";

export interface RsvpResult {
  status: RsvpStatus;
  waitlistPosition: number | null;
  changed: boolean;
}

/** Locks the occurrence row: every RSVP/capacity change for one occurrence is serialised through it. */
export async function lockOccurrence(tx: Tx, occurrenceId: string) {
  return tx
    .selectFrom("event_occurrences as o")
    .innerJoin("event_series as s", "s.id", "o.series_id")
    .select([
      "o.id",
      "o.capacity",
      "o.starts_at",
      "o.ends_at",
      "o.cancelled_at",
      "s.id as series_id",
      "s.title",
      "s.status",
      "s.club_id",
      "s.visibility",
    ])
    .where("o.id", "=", occurrenceId)
    .forUpdate("o")
    .executeTakeFirst();
}

async function waitlistRank(tx: Tx, occurrenceId: string, position: string | null): Promise<number | null> {
  if (position === null) return null;
  const r = await tx
    .selectFrom("rsvps")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("occurrence_id", "=", occurrenceId)
    .where("status", "=", "waitlisted")
    .where("waitlist_position", "<=", position)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * Sets the actor's response. Idempotent: repeating the same response returns the
 * current state without moving the user in the waitlist.
 */
export async function setRsvp(db: Db, queue: JobQueue, actor: Actor, occurrenceId: string, response: "going" | "not_going"): Promise<RsvpResult> {
  return db.transaction().execute(async (tx) => {
    const occ = await lockOccurrence(tx, occurrenceId);
    if (!occ || !canViewSeries(actor, occ)) throw notFound("Event");
    if (occ.status !== "approved" || occ.cancelled_at) throw conflict("RSVPs are only open for approved, active events.");
    if (occ.ends_at <= new Date()) throw conflict("This event has already ended.");
    const userId = actor.user.id;

    const existing = await tx
      .selectFrom("rsvps")
      .select(["id", "status", "waitlist_position"])
      .where("occurrence_id", "=", occurrenceId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    if (response === "going" && existing && existing.status !== "not_going") {
      return { status: existing.status, waitlistPosition: await waitlistRank(tx, occurrenceId, existing.waitlist_position), changed: false };
    }
    if (response === "not_going" && existing?.status === "not_going") {
      return { status: "not_going", waitlistPosition: null, changed: false };
    }

    let status: RsvpStatus;
    let position: string | null = null;
    if (response === "going") {
      const going = await countGoing(tx, occurrenceId);
      if (occ.capacity === null || going < occ.capacity) {
        status = "going";
      } else {
        status = "waitlisted";
        position = (await sql<{ v: string }>`SELECT nextval('waitlist_position_seq')::text AS v`.execute(tx)).rows[0]!.v;
      }
    } else {
      status = "not_going";
    }

    await tx
      .insertInto("rsvps")
      .values({ occurrence_id: occurrenceId, user_id: userId, status, waitlist_position: position, responded_at: new Date() })
      .onConflict((oc) =>
        oc.columns(["occurrence_id", "user_id"]).doUpdateSet({ status, waitlist_position: position, responded_at: new Date() }),
      )
      .execute();

    await audit(tx, userId, `rsvp.${status}`, "occurrence", occurrenceId, { previous: existing?.status ?? null });

    if (existing?.status === "going" && status === "not_going") {
      await rebalance(tx, queue, occurrenceId, actor.user.id);
    }
    await syncReminders(tx, [occurrenceId], [userId]);
    return { status, waitlistPosition: await waitlistRank(tx, occurrenceId, position), changed: true };
  });
}

async function countGoing(tx: Tx, occurrenceId: string): Promise<number> {
  const r = await tx
    .selectFrom("rsvps")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("occurrence_id", "=", occurrenceId)
    .where("status", "=", "going")
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * Brings `going` in line with capacity. The caller must hold the occurrence lock
 * (lockOccurrence) so promotion and demotion are atomic with the triggering change.
 *
 *  - Spots open: promote the head of the FIFO waitlist, one by one, with a notification.
 *  - Capacity reduced below confirmed count: the most recently confirmed attendees are
 *    moved to the *front* of the waitlist (keeping their relative order) and notified.
 */
export async function rebalance(tx: Tx, queue: JobQueue, occurrenceId: string, actorId: string | null): Promise<void> {
  const occ = await tx
    .selectFrom("event_occurrences as o")
    .innerJoin("event_series as s", "s.id", "o.series_id")
    .select(["o.capacity", "o.cancelled_at", "o.ends_at", "s.status", "s.title"])
    .where("o.id", "=", occurrenceId)
    .executeTakeFirstOrThrow();
  if (occ.status !== "approved" || occ.cancelled_at) return;

  const going = await countGoing(tx, occurrenceId);
  const promoted: string[] = [];

  if (occ.capacity !== null && going > occ.capacity) {
    const excess = going - occ.capacity;
    const demote = await tx
      .selectFrom("rsvps")
      .select(["id", "user_id"])
      .where("occurrence_id", "=", occurrenceId)
      .where("status", "=", "going")
      .orderBy("responded_at", "desc")
      .orderBy("id", "desc")
      .limit(excess)
      .execute();
    const head = await tx
      .selectFrom("rsvps")
      .select((eb) => eb.fn.min("waitlist_position").as("m"))
      .where("occurrence_id", "=", occurrenceId)
      .where("status", "=", "waitlisted")
      .executeTakeFirst();
    let next = head?.m != null ? BigInt(head.m as string) - 1n : 0n;
    // `demote` is newest-first; the newest goes furthest back among the demoted.
    for (const r of demote) {
      await tx.updateTable("rsvps").set({ status: "waitlisted", waitlist_position: next.toString() }).where("id", "=", r.id).execute();
      await notify(tx, queue, {
        userId: r.user_id,
        kind: "rsvp.demoted",
        title: `Moved to the waitlist: ${occ.title}`,
        body: "The event's capacity was reduced. You are at the front of the waitlist and will be promoted automatically if a spot opens.",
        occurrenceId,
        dedupeKey: `demoted:${r.id}:${next}`,
      });
      await audit(tx, actorId, "rsvp.demoted", "occurrence", occurrenceId, { userId: r.user_id });
      next -= 1n;
    }
    await syncReminders(tx, [occurrenceId], demote.map((d) => d.user_id));
    return;
  }

  if (occ.ends_at <= new Date()) return;
  let open = occ.capacity === null ? Number.POSITIVE_INFINITY : occ.capacity - going;
  while (open > 0) {
    const nextUp = await tx
      .selectFrom("rsvps")
      .select(["id", "user_id", "waitlist_position"])
      .where("occurrence_id", "=", occurrenceId)
      .where("status", "=", "waitlisted")
      .orderBy("waitlist_position")
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (!nextUp) break;
    await tx
      .updateTable("rsvps")
      .set({ status: "going", waitlist_position: null, responded_at: new Date() })
      .where("id", "=", nextUp.id)
      .execute();
    await notify(tx, queue, {
      userId: nextUp.user_id,
      kind: "rsvp.promoted",
      title: `You're in: ${occ.title}`,
      body: "A spot opened up and you were moved from the waitlist to the attendee list.",
      occurrenceId,
      dedupeKey: `promoted:${nextUp.id}:${nextUp.waitlist_position}`,
    });
    await audit(tx, actorId, "rsvp.promoted", "occurrence", occurrenceId, { userId: nextUp.user_id });
    promoted.push(nextUp.user_id);
    open -= 1;
  }
  if (promoted.length) await syncReminders(tx, [occurrenceId], promoted);
}

export async function listAttendees(db: Db, occurrenceId: string): Promise<AttendeeDTO[]> {
  const rows = await db
    .selectFrom("rsvps as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select(["r.user_id", "u.display_name", "r.status", "r.waitlist_position", "r.responded_at"])
    .where("r.occurrence_id", "=", occurrenceId)
    .orderBy(sql`CASE r.status WHEN 'going' THEN 0 WHEN 'waitlisted' THEN 1 ELSE 2 END`)
    .orderBy("r.waitlist_position")
    .orderBy("r.responded_at")
    .execute();
  let rank = 0;
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    status: r.status,
    waitlistPosition: r.status === "waitlisted" ? ++rank : null,
    respondedAt: r.responded_at.toISOString(),
  }));
}
