import { config } from "./config.js";
import { createDb, createPool } from "./db/index.js";
import { createApp } from "./http/app.js";
import { log } from "./lib/log.js";
import { bossQueue, createBoss, ensureQueues } from "./queue/boss.js";

const pool = createPool();
const db = createDb(pool);
// The web process only *enqueues* jobs (supervise/schedule disabled); the worker processes them.
const boss = createBoss("api");
await boss.start();
await ensureQueues(boss);

const app = createApp({ db, queue: bossQueue(boss) });
const server = app.listen(config.PORT, () => log.info("api listening", { port: config.PORT, env: config.NODE_ENV }));

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  server.close();
  await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  await db.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
