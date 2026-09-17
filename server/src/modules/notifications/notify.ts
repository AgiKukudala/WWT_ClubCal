import type { Tx } from "../../db/index.js";
import { emailConfigured } from "../../lib/mailer.js";
import type { JobQueue } from "../../queue/boss.js";

export interface NotificationInput {
  userId: string;
  kind: string;
  title: string;
  body: string;
  occurrenceId?: string | null;
  /** Unique delivery identifier. A second insert with the same key is a no-op. */
  dedupeKey: string;
}

/**
 * Creates an in-app notification (exactly once per dedupe key) and, when the user
 * opted in and SMTP is configured, enqueues an email job in the same transaction.
 * Returns true if a new notification was created.
 */
export async function notify(tx: Tx, queue: JobQueue, n: NotificationInput): Promise<boolean> {
  const user = await tx
    .selectFrom("users")
    .select(["email_notifications", "disabled_at"])
    .where("id", "=", n.userId)
    .executeTakeFirst();
  if (!user || user.disabled_at) return false;
  const wantsEmail = user.email_notifications && emailConfigured();
  const inserted = await tx
    .insertInto("notifications")
    .values({
      user_id: n.userId,
      kind: n.kind,
      title: n.title.slice(0, 200),
      body: n.body.slice(0, 2000),
      occurrence_id: n.occurrenceId ?? null,
      dedupe_key: n.dedupeKey,
      email_status: wantsEmail ? "pending" : "not_requested",
    })
    .onConflict((oc) => oc.column("dedupe_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!inserted) return false;
  if (wantsEmail) await queue.enqueueEmail(tx, inserted.id);
  return true;
}

export async function notifyMany(tx: Tx, queue: JobQueue, userIds: Iterable<string>, make: (userId: string) => NotificationInput) {
  for (const id of new Set(userIds)) await notify(tx, queue, make(id));
}

export async function adminIds(tx: Tx): Promise<string[]> {
  const rows = await tx.selectFrom("users").select("id").where("role", "=", "admin").where("disabled_at", "is", null).execute();
  return rows.map((r) => r.id);
}

export async function attendeeIds(tx: Tx, occurrenceIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (occurrenceIds.length === 0) return out;
  const rows = await tx
    .selectFrom("rsvps")
    .select(["occurrence_id", "user_id"])
    .where("occurrence_id", "in", occurrenceIds)
    .where("status", "in", ["going", "waitlisted"])
    .execute();
  for (const r of rows) {
    const list = out.get(r.occurrence_id) ?? [];
    list.push(r.user_id);
    out.set(r.occurrence_id, list);
  }
  return out;
}
