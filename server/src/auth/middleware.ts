import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@clubcal/shared";
import { allowedOrigins } from "../config.js";
import type { Db } from "../db/index.js";
import type { User } from "../db/types.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { type Actor, assertRole } from "./context.js";
import { clearSessionCookie, hashToken, safeEqual, sessionCookieName } from "./sessions.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOUCH_INTERVAL_MS = 5 * 60_000;

export async function loadActor(db: Db, token: string): Promise<Actor | null> {
  const id = hashToken(token);
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .selectAll("u")
    .select(["s.id as session_id", "s.csrf_token", "s.last_seen_at", "s.expires_at"])
    .where("s.id", "=", id)
    .executeTakeFirst();
  if (!row || row.expires_at <= new Date() || row.disabled_at) return null;
  if (Date.now() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db.updateTable("sessions").set({ last_seen_at: new Date() }).where("id", "=", id).execute();
  }
  const { session_id, csrf_token, last_seen_at: _l, expires_at: _e, ...user } = row;
  return { ...(await buildActor(db, user)), sessionId: session_id, csrfToken: csrf_token };
}

/** Builds an actor (permissions context) for a user. Also used by CLI tools and tests. */
export async function buildActor(db: Db, user: User): Promise<Actor> {
  const memberships = await db
    .selectFrom("club_memberships as m")
    .innerJoin("clubs as c", "c.id", "m.club_id")
    .select(["m.club_id", "m.role"])
    .where("m.user_id", "=", user.id)
    .where("c.archived_at", "is", null)
    .execute();
  return {
    user,
    sessionId: "",
    csrfToken: "",
    memberClubIds: new Set(memberships.map((m) => m.club_id)),
    organizerClubIds: new Set(
      user.role === "organizer" ? memberships.filter((m) => m.role === "organizer").map((m) => m.club_id) : [],
    ),
  };
}

export function sessionMiddleware(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.[sessionCookieName()];
      if (typeof token === "string" && token.length > 0 && token.length < 200) {
        const actor = await loadActor(db, token);
        if (actor) req.actor = actor;
        else clearSessionCookie(res);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * CSRF defence in depth:
 *  1. SameSite=Lax session cookie.
 *  2. Unsafe requests with an Origin header must come from an allowed origin.
 *  3. Unsafe requests from a signed-in session must echo the per-session CSRF token
 *     in the X-CSRF-Token header (synchronizer token pattern).
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin && !allowedOrigins().includes(origin)) return next(forbidden("Cross-origin request rejected."));
  if (req.get("sec-fetch-site") === "cross-site") return next(forbidden("Cross-site request rejected."));
  if (req.actor) {
    const header = req.get("x-csrf-token") ?? "";
    if (!safeEqual(header, req.actor.csrfToken)) return next(forbidden("Missing or invalid CSRF token. Reload the page and try again."));
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.actor) return next(unauthorized());
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorized());
    try {
      assertRole(req.actor, ...roles);
      next();
    } catch (e) {
      next(e);
    }
  };
}
