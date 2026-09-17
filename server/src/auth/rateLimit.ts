import { config } from "../config.js";
import type { Db } from "../db/index.js";
import { tooManyRequests } from "../lib/errors.js";

/**
 * Login throttling backed by PostgreSQL so it holds across app instances and restarts.
 * Limits failed attempts per account and (more loosely) per client IP in a sliding window.
 */
export async function assertLoginAllowed(db: Db, email: string, ip: string) {
  const since = new Date(Date.now() - config.LOGIN_WINDOW_MINUTES * 60_000);
  const row = await db
    .selectFrom("login_attempts")
    .select((eb) => [
      eb.fn.countAll<string>().filterWhere("email", "=", email).as("by_email"),
      eb.fn.countAll<string>().filterWhere("ip", "=", ip).as("by_ip"),
    ])
    .where("succeeded", "=", false)
    .where("attempted_at", ">", since)
    .where((eb) => eb.or([eb("email", "=", email), eb("ip", "=", ip)]))
    .executeTakeFirstOrThrow();
  if (Number(row.by_email) >= config.LOGIN_MAX_FAILURES || Number(row.by_ip) >= config.LOGIN_MAX_FAILURES * 4) {
    throw tooManyRequests(`Too many failed sign-in attempts. Try again in ${config.LOGIN_WINDOW_MINUTES} minutes.`);
  }
}

export async function recordLoginAttempt(db: Db, email: string, ip: string, succeeded: boolean) {
  await db.insertInto("login_attempts").values({ email, ip, succeeded }).execute();
  if (succeeded) {
    // A successful login clears the account's failure streak.
    await db.deleteFrom("login_attempts").where("email", "=", email).where("succeeded", "=", false).execute();
  }
}

export async function pruneLoginAttempts(db: Db) {
  await db.deleteFrom("login_attempts").where("attempted_at", "<", new Date(Date.now() - 24 * 3600_000)).execute();
}

/** Small in-process limiter for registration bursts (per IP). */
export function fixedWindowLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return;
    }
    cur.count += 1;
    if (cur.count > limit) throw tooManyRequests("Too many requests. Please wait and try again.");
  };
}
