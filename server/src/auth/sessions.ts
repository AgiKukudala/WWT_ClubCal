import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { config, cookieSecure } from "../config.js";
import type { DbOrTx } from "../db/index.js";

export const sessionCookieName = () => (cookieSecure() ? "__Host-clubcal_session" : "clubcal_session");

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function createSession(db: DbOrTx, userId: string, userAgent: string | undefined) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
  await db
    .insertInto("sessions")
    .values({
      id: hashToken(token),
      user_id: userId,
      csrf_token: csrfToken,
      user_agent: userAgent?.slice(0, 300) ?? null,
      expires_at: expiresAt,
    })
    .execute();
  return { token, csrfToken, expiresAt };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(sessionCookieName(), { httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/" });
}

export async function deleteExpiredSessions(db: DbOrTx) {
  const r = await db.deleteFrom("sessions").where("expires_at", "<", new Date()).executeTakeFirst();
  return Number(r.numDeletedRows);
}
