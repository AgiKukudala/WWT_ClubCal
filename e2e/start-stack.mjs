// Starts an isolated stack for Playwright: resets the e2e database, migrates, seeds demo data,
// then runs the built API (serving the built web app) and the worker. Requires `npm run build`.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.E2E_DATABASE_URL ?? "postgres://postgres@localhost:54329/clubcal_e2e";
const port = process.env.E2E_PORT ?? "3100";
const env = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: url,
  PORT: port,
  SESSION_SECRET: "e2e-only-session-secret-value",
  APP_ORIGIN: `http://localhost:${port}`,
  PUBLIC_URL: `http://localhost:${port}`,
  STATIC_DIR: path.join(root, "web/dist"),
  REMINDER_POLL_SECONDS: "2",
  SMTP_HOST: process.env.E2E_SMTP_HOST ?? "",
  LOG_LEVEL: "warn",
  LOGIN_MAX_FAILURES: "50",
};

const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
await c.end();

const dist = path.join(root, "server/dist");
for (const script of ["migrate.js", "seed.js"]) {
  const r = spawnSync(process.execPath, [path.join(dist, script)], { env, cwd: path.join(root, "server"), stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const procs = ["main.js", "worker.js"].map((s) =>
  spawn(process.execPath, [path.join(dist, s)], { env, cwd: path.join(root, "server"), stdio: "inherit" }),
);
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const p of procs) p.on("exit", (code) => code && process.exit(code));
