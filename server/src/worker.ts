import { writeFile } from "node:fs/promises";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { deleteExpiredSessions } from "./auth/sessions.js";
import { pruneLoginAttempts } from "./auth/rateLimit.js";
import { config } from "./config.js";
import { createDb, createPool, type Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { type Mailer, smtpMailer } from "./lib/mailer.js";
import {
  deliverReminder,
  dispatchDueReminders,
  recordEmailFailure,
  recordReminderFailure,
  recoverOrphanedReminders,
  sendNotificationEmail,
} from "./modules/reminders/worker.js";
import { bossQueue, createBoss, ensureQueues, QUEUES } from "./queue/boss.js";

export interface WorkerHandle {
  stop(): Promise<void>;
  tick(): Promise<void>;
}

/** Starts job handlers and the dispatch loop. Exported so tests can start/stop workers. */
export async function startWorker(opts: { db: Db; boss: PgBoss; mailer?: Mailer; pollSeconds?: number; loop?: boolean }): Promise<WorkerHandle> {
  const { db, boss } = opts;
  const mailer = opts.mailer ?? smtpMailer;
  const queue = bossQueue(boss);
  await ensureQueues(boss);

  await boss.work<{ reminderId: string }>(QUEUES.deliverReminder, { includeMetadata: true, pollingIntervalSeconds: 2 }, async ([raw]) => {
    const job = raw as JobWithMetadata<{ reminderId: string }> | undefined;
    if (!job) return;
    try {
      const outcome = await deliverReminder(db, queue, job.data.reminderId);
      log.debug("reminder processed", { id: job.data.reminderId, outcome });
    } catch (err) {
      const final = job.retryCount >= job.retryLimit;
      await recordReminderFailure(db, job.data.reminderId, String((err as Error).message ?? err), final);
      log.warn("reminder delivery failed", { id: job.data.reminderId, attempt: job.retryCount + 1, final, err: String(err) });
      throw err;
    }
  });

  await boss.work<{ notificationId: string }>(QUEUES.sendEmail, { includeMetadata: true, pollingIntervalSeconds: 2 }, async ([raw]) => {
    const job = raw as JobWithMetadata<{ notificationId: string }> | undefined;
    if (!job) return;
    try {
      await sendNotificationEmail(db, mailer, job.data.notificationId, config.PUBLIC_URL);
    } catch (err) {
      const final = job.retryCount >= job.retryLimit;
      await recordEmailFailure(db, job.data.notificationId, String((err as Error).message ?? err), final);
      log.warn("email delivery failed", { id: job.data.notificationId, attempt: job.retryCount + 1, final, err: String(err) });
      throw err;
    }
  });

  let lastMaintenance = 0;
  const tick = async () => {
    const n = await dispatchDueReminders(db, queue);
    // Liveness signal for container health checks: only written after a successful DB round-trip.
    if (process.env.HEARTBEAT_FILE) await writeFile(process.env.HEARTBEAT_FILE, String(Date.now())).catch(() => {});
    if (n) log.info("reminders dispatched", { count: n });
    if (Date.now() - lastMaintenance > 10 * 60_000) {
      lastMaintenance = Date.now();
      const recovered = await recoverOrphanedReminders(db);
      if (recovered) log.warn("recovered orphaned reminders", { count: recovered });
      await deleteExpiredSessions(db);
      await pruneLoginAttempts(db);
    }
  };

  let timer: NodeJS.Timeout | null = null;
  let running = true;
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      log.error("dispatch tick failed", { err: String(err) });
    }
    if (running) timer = setTimeout(loop, (opts.pollSeconds ?? config.REMINDER_POLL_SECONDS) * 1000);
  };
  if (opts.loop !== false) void loop();

  return {
    tick,
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await boss.offWork(QUEUES.deliverReminder).catch(() => {});
      await boss.offWork(QUEUES.sendEmail).catch(() => {});
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("worker.js");
if (isMain) {
  const pool = createPool();
  const db = createDb(pool);
  const boss = createBoss("worker");
  await boss.start();
  const handle = await startWorker({ db, boss });
  log.info("worker started", { pollSeconds: config.REMINDER_POLL_SECONDS, smtp: Boolean(config.SMTP_HOST) });
  const shutdown = async (signal: string) => {
    log.info("worker shutting down", { signal });
    await handle.stop();
    await boss.stop({ graceful: true, timeout: 15_000 }).catch(() => {});
    await db.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
