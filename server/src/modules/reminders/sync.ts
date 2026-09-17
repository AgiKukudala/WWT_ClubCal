import { sql } from "kysely";
import type { Tx } from "../../db/index.js";

export const REMINDER_OFFSETS = [1440, 60] as const;

/**
 * Reconciles durable reminder rows with the current state of the given occurrences.
 *
 * Desired reminders = (approved, not cancelled occurrence) × (user RSVP'd `going`,
 * active account, preference enabled) × offset. Rows no longer desired — because the
 * event moved, was cancelled, the user left, or disabled the reminder — become
 * `obsolete`. Rows keyed by the event start they were computed for, so a moved event
 * gets fresh rows while already-sent reminders are never resent for the same start.
 */
export async function syncReminders(tx: Tx, occurrenceIds: string[], userIds?: string[]): Promise<void> {
  if (occurrenceIds.length === 0) return;
  const userFilter = userIds ? sql`AND r.user_id = ANY(${userIds}::uuid[])` : sql``;
  const rmUserFilter = userIds ? sql`AND rm.user_id = ANY(${userIds}::uuid[])` : sql``;
  const desired = sql`
    SELECT o.id AS occurrence_id, r.user_id, off.m AS offset_minutes, o.starts_at,
           o.starts_at - make_interval(mins => off.m) AS due_at
    FROM event_occurrences o
    JOIN event_series s ON s.id = o.series_id
    JOIN rsvps r ON r.occurrence_id = o.id AND r.status = 'going'
    JOIN users u ON u.id = r.user_id AND u.disabled_at IS NULL
    CROSS JOIN (VALUES (60), (1440)) AS off(m)
    WHERE o.id = ANY(${occurrenceIds}::uuid[]) ${userFilter}
      AND s.status = 'approved' AND o.cancelled_at IS NULL
      AND ((off.m = 60 AND u.remind_1h) OR (off.m = 1440 AND u.remind_24h))`;

  await sql`
    UPDATE reminders rm SET status = 'obsolete', updated_at = now()
    WHERE rm.occurrence_id = ANY(${occurrenceIds}::uuid[]) ${rmUserFilter}
      AND rm.status IN ('scheduled', 'queued')
      AND NOT EXISTS (
        SELECT 1 FROM (${desired}) d
        WHERE d.occurrence_id = rm.occurrence_id AND d.user_id = rm.user_id
          AND d.offset_minutes = rm.offset_minutes AND d.starts_at = rm.event_starts_at)`.execute(tx);

  await sql`
    INSERT INTO reminders (occurrence_id, user_id, offset_minutes, event_starts_at, due_at)
    SELECT occurrence_id, user_id, offset_minutes, starts_at, due_at FROM (${desired}) d
    WHERE d.due_at > now()
    ON CONFLICT (occurrence_id, user_id, offset_minutes, event_starts_at)
    DO UPDATE SET status = 'scheduled', due_at = EXCLUDED.due_at, last_error = NULL, updated_at = now()
    WHERE reminders.status = 'obsolete'`.execute(tx);
}

/** Future occurrences a user is going to (for preference changes). */
export async function syncRemindersForUser(tx: Tx, userId: string) {
  const rows = await tx
    .selectFrom("rsvps as r")
    .innerJoin("event_occurrences as o", "o.id", "r.occurrence_id")
    .select("o.id")
    .where("r.user_id", "=", userId)
    .where("o.starts_at", ">", new Date())
    .execute();
  await syncReminders(tx, rows.map((r) => r.id), [userId]);
}
