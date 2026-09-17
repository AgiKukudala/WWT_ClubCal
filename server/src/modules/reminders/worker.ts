import { sql } from "kysely";
import type { Db } from "../../db/index.js";
import { formatLocalRange } from "../../lib/time.js";
import type { Mailer } from "../../lib/mailer.js";
import type { JobQueue } from "../../queue/boss.js";
import { notify } from "../notifications/notify.js";

/**
 * Moves due reminders from `scheduled` to `queued`, enqueuing one pg-boss job per
 * reminder in the same transaction (singletonKey = reminder id). SKIP LOCKED lets
 * several workers dispatch concurrently without double-enqueueing.
 */
export async function dispatchDueReminders(db: Db, queue: JobQueue, now = new Date(), batch = 200): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const due = await tx
      .selectFrom("reminders")
      .select("id")
      .where("status", "=", "scheduled")
      .where("due_at", "<=", now)
      .orderBy("due_at")
      .limit(batch)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const r of due) {
      const jobId = await queue.enqueueReminder(tx, r.id);
      await tx.updateTable("reminders").set({ status: "queued", job_id: jobId, updated_at: now }).where("id", "=", r.id).execute();
    }
    return due.length;
  });
}

/**
 * Recovery sweep: a reminder stuck in `queued` whose job no longer exists in an
 * open state (e.g. the queue was purged) goes back to `scheduled`.
 */
export async function recoverOrphanedReminders(db: Db): Promise<number> {
  const r = await sql`
    UPDATE reminders rm SET status = 'scheduled', job_id = NULL, updated_at = now()
    WHERE rm.status = 'queued' AND rm.updated_at < now() - interval '10 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.job j
        WHERE j.id::text = rm.job_id AND j.state IN ('created', 'retry', 'active'))`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export type DeliveryOutcome = "sent" | "obsolete" | "skipped" | "noop";

/**
 * Delivers one reminder. Everything is rechecked against current data under a row
 * lock; the in-app notification uses the reminder id as its unique delivery key, so
 * retries after a crash cannot create duplicates.
 */
export async function deliverReminder(db: Db, queue: JobQueue, reminderId: string, now = new Date()): Promise<DeliveryOutcome> {
  return db.transaction().execute(async (tx) => {
    const rm = await tx.selectFrom("reminders").selectAll().where("id", "=", reminderId).forUpdate().executeTakeFirst();
    if (!rm || (rm.status !== "queued" && rm.status !== "scheduled" && rm.status !== "failed")) return "noop";
    const ctx = await tx
      .selectFrom("event_occurrences as o")
      .innerJoin("event_series as s", "s.id", "o.series_id")
      .innerJoin("users as u", (j) => j.on("u.id", "=", rm.user_id))
      .leftJoin("rsvps as r", (j) => j.onRef("r.occurrence_id", "=", "o.id").onRef("r.user_id", "=", "u.id"))
      .leftJoin("rooms as room", "room.id", "o.room_id")
      .select([
        "o.id",
        "o.starts_at",
        "o.ends_at",
        "o.cancelled_at",
        "s.status",
        "s.title",
        "s.timezone",
        "u.disabled_at",
        "u.remind_1h",
        "u.remind_24h",
        "r.status as rsvp",
        "room.name as room_name",
      ])
      .where("o.id", "=", rm.occurrence_id)
      .executeTakeFirst();

    let problem: string | null = null;
    let outcome: DeliveryOutcome = "obsolete";
    if (!ctx) problem = "event no longer exists";
    else if (ctx.status !== "approved") problem = `event is ${ctx.status}`;
    else if (ctx.cancelled_at) problem = "occurrence cancelled";
    else if (ctx.starts_at.getTime() !== rm.event_starts_at.getTime()) problem = "event time changed";
    else if (ctx.rsvp !== "going") problem = "recipient is no longer attending";
    else if (ctx.disabled_at) problem = "recipient account disabled";
    else if ((rm.offset_minutes === 60 && !ctx.remind_1h) || (rm.offset_minutes === 1440 && !ctx.remind_24h)) problem = "recipient turned this reminder off";
    else if (ctx.starts_at <= now) {
      problem = "event already started before the reminder could be delivered";
      outcome = "skipped";
    }
    if (problem || !ctx) {
      await tx.updateTable("reminders").set({ status: outcome, last_error: problem, processed_at: now, updated_at: now }).where("id", "=", rm.id).execute();
      return outcome;
    }

    const when = formatLocalRange(ctx.starts_at, ctx.ends_at, ctx.timezone);
    await notify(tx, queue, {
      userId: rm.user_id,
      kind: "reminder",
      title: `${rm.offset_minutes === 60 ? "Starting in 1 hour" : "Tomorrow"}: ${ctx.title}`,
      body: `${when}${ctx.room_name ? ` · ${ctx.room_name}` : ""}`,
      occurrenceId: ctx.id,
      dedupeKey: `reminder:${rm.id}`,
    });
    await tx
      .updateTable("reminders")
      .set({ status: "sent", processed_at: now, attempts: rm.attempts + 1, last_error: null, updated_at: now })
      .where("id", "=", rm.id)
      .execute();
    return "sent";
  });
}

export async function recordReminderFailure(db: Db, reminderId: string, error: string, final: boolean) {
  await db
    .updateTable("reminders")
    .set((eb) => ({
      attempts: eb("attempts", "+", 1),
      last_error: error.slice(0, 500),
      status: final ? "failed" : "queued",
      updated_at: new Date(),
    }))
    .where("id", "=", reminderId)
    .where("status", "in", ["queued", "scheduled"])
    .execute();
}

/**
 * Sends a notification email. At-least-once: if the process dies after the SMTP
 * server accepted the message but before `sent` is recorded, the retry sends again.
 */
export async function sendNotificationEmail(db: Db, mailer: Mailer, notificationId: string, publicUrl: string): Promise<"sent" | "noop"> {
  const n = await db
    .selectFrom("notifications as n")
    .innerJoin("users as u", "u.id", "n.user_id")
    .select(["n.id", "n.title", "n.body", "n.occurrence_id", "n.email_status", "u.email", "u.display_name", "u.disabled_at", "u.email_notifications"])
    .where("n.id", "=", notificationId)
    .executeTakeFirst();
  if (!n || n.email_status === "sent" || n.email_status === "skipped") return "noop";
  if (n.disabled_at || !n.email_notifications) {
    await db.updateTable("notifications").set({ email_status: "skipped" }).where("id", "=", n.id).execute();
    return "noop";
  }
  const link = n.occurrence_id ? `\n\nView: ${publicUrl}/events/${n.occurrence_id}` : "";
  await mailer.send({
    to: n.email,
    subject: `[ClubCal] ${n.title}`,
    text: `Hi ${n.display_name},\n\n${n.title}\n${n.body}${link}\n\nYou can turn off email notifications in ClubCal settings.`,
  });
  await db
    .updateTable("notifications")
    .set((eb) => ({ email_status: "sent", email_sent_at: new Date(), email_attempts: eb("email_attempts", "+", 1), email_last_error: null }))
    .where("id", "=", n.id)
    .execute();
  return "sent";
}

export async function recordEmailFailure(db: Db, notificationId: string, error: string, final: boolean) {
  await db
    .updateTable("notifications")
    .set((eb) => ({ email_attempts: eb("email_attempts", "+", 1), email_last_error: error.slice(0, 500), email_status: final ? "failed" : "pending" }))
    .where("id", "=", notificationId)
    .where("email_status", "=", "pending")
    .execute();
}
