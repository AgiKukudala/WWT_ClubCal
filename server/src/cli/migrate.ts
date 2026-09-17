import { createPool } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { createBoss, ensureQueues } from "../queue/boss.js";

const pool = createPool();
try {
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database schema is up to date.");
  const boss = createBoss("migrate");
  await boss.start();
  await ensureQueues(boss);
  await boss.stop({ graceful: false });
  console.log("Job queue schema is up to date.");
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
