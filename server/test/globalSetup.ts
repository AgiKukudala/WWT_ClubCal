import pg from "pg";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/clubcal_test";
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // Start every run from an empty database so migrations are exercised from scratch.
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
  await client.end();
  process.env.DATABASE_URL = url;
  const { createPool } = await import("../src/db/index.js");
  const { migrate } = await import("../src/db/migrate.js");
  const { createBoss, ensureQueues } = await import("../src/queue/boss.js");
  const pool = createPool(url);
  await migrate(pool);
  // Running twice proves migrations are repeatable (second run is a no-op).
  const again = await migrate(pool);
  if (again.length !== 0) throw new Error("migrations are not idempotent");
  await pool.end();
  const boss = createBoss("migrate", url);
  await boss.start();
  await ensureQueues(boss);
  await boss.stop({ graceful: false });
}
