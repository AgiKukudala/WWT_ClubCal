import { fromKysely, PgBoss } from "pg-boss";
import { config } from "../config.js";
import type { Tx } from "../db/index.js";

export const QUEUES = {
  deliverReminder: "deliver-reminder",
  sendEmail: "send-email",
} as const;

/** Retry policy: 6 attempts total with exponential backoff capped at 10 minutes. */
export const RETRY_POLICY = {
  retryLimit: 5,
  retryDelay: 20,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 120,
  retentionSeconds: 7 * 24 * 3600,
  deleteAfterSeconds: 7 * 24 * 3600,
} as const;

export type BossRole = "api" | "worker" | "migrate";

/**
 * - api: only enqueues (no supervision, no schema changes)
 * - worker: processes jobs and runs pg-boss maintenance/supervision
 * - migrate: installs/upgrades the pgboss schema, then stops
 */
export function createBoss(role: BossRole, connectionString = config.DATABASE_URL): PgBoss {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    max: role === "worker" ? 5 : 3,
    application_name: `clubcal-${role}`,
    migrate: role === "migrate",
    createSchema: role === "migrate",
    supervise: role === "worker",
    schedule: false,
  });
  boss.on("error", (err) => process.stderr.write(`pg-boss error: ${err.message}\n`));
  return boss;
}

export async function ensureQueues(boss: PgBoss) {
  for (const name of Object.values(QUEUES)) {
    const existing = await boss.getQueue(name);
    if (!existing) await boss.createQueue(name, { ...RETRY_POLICY });
  }
}

/**
 * The narrow queue interface the domain services depend on. Jobs are enqueued
 * inside the caller's transaction, so they exist if and only if the change commits.
 */
export interface JobQueue {
  enqueueEmail(tx: Tx, notificationId: string): Promise<void>;
  enqueueReminder(tx: Tx, reminderId: string): Promise<string | null>;
}

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async enqueueEmail(tx, notificationId) {
      await boss.send(QUEUES.sendEmail, { notificationId }, { singletonKey: notificationId, db: fromKysely(tx) });
    },
    async enqueueReminder(tx, reminderId) {
      return boss.send(QUEUES.deliverReminder, { reminderId }, { singletonKey: reminderId, db: fromKysely(tx) });
    },
  };
}
