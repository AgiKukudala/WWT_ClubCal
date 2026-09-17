import { Router } from "express";
import {
  availabilitySchema,
  loginSchema,
  type MeDTO,
  preferencesSchema,
  registerSchema,
  type SessionDTO,
} from "@clubcal/shared";
import type { Actor } from "../auth/context.js";
import { requireAuth } from "../auth/middleware.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { assertLoginAllowed, fixedWindowLimiter, recordLoginAttempt } from "../auth/rateLimit.js";
import { clearSessionCookie, createSession, setSessionCookie } from "../auth/sessions.js";
import { audit } from "../lib/audit.js";
import { conflict, isUniqueViolation, unauthorized } from "../lib/errors.js";
import { hhmm } from "../lib/time.js";
import { syncRemindersForUser } from "../modules/reminders/sync.js";
import type { AppDeps } from "./app.js";
import { parse } from "./validate.js";

export function toMe(a: Actor): MeDTO {
  return {
    id: a.user.id,
    email: a.user.email,
    displayName: a.user.display_name,
    role: a.user.role,
    timezone: a.user.timezone,
    remind24h: a.user.remind_24h,
    remind1h: a.user.remind_1h,
    emailNotifications: a.user.email_notifications,
    organizerClubIds: [...a.organizerClubIds],
    memberClubIds: [...a.memberClubIds],
  };
}

export function authRoutes({ db }: AppDeps) {
  const r = Router();
  const registerLimit = fixedWindowLimiter(20, 60 * 60_000);

  r.get("/auth/session", (req, res) => {
    const body: SessionDTO = req.actor ? { user: toMe(req.actor), csrfToken: req.actor.csrfToken } : { user: null, csrfToken: null };
    res.set("Cache-Control", "no-store").json(body);
  });

  r.post("/auth/register", async (req, res) => {
    registerLimit(req.ip ?? "unknown");
    const input = parse(registerSchema, req.body);
    const passwordHash = await hashPassword(input.password);
    // Role is never taken from the request: every self-registration is a student.
    const user = await db.transaction().execute(async (tx) => {
      try {
        const u = await tx
          .insertInto("users")
          .values({
            email: input.email,
            display_name: input.displayName,
            password_hash: passwordHash,
            role: "student",
            timezone: input.timezone ?? "America/Chicago",
          })
          .returning(["id"])
          .executeTakeFirstOrThrow();
        await audit(tx, u.id, "user.registered", "user", u.id, {});
        return u;
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("An account with that email already exists.");
        throw err;
      }
    });
    const s = await createSession(db, user.id, req.get("user-agent"));
    setSessionCookie(res, s.token, s.expiresAt);
    res.status(201).json({ ok: true });
  });

  r.post("/auth/login", async (req, res) => {
    const input = parse(loginSchema, req.body);
    const ip = req.ip ?? "unknown";
    await assertLoginAllowed(db, input.email, ip);
    const user = await db.selectFrom("users").select(["id", "password_hash", "disabled_at"]).where("email", "=", input.email).executeTakeFirst();
    const ok = await verifyPassword(user?.password_hash ?? null, input.password);
    await recordLoginAttempt(db, input.email, ip, ok && !user?.disabled_at);
    if (!ok || !user || user.disabled_at) throw unauthorized("Incorrect email or password.");
    if (req.actor) await db.deleteFrom("sessions").where("id", "=", req.actor.sessionId).execute();
    const s = await createSession(db, user.id, req.get("user-agent"));
    setSessionCookie(res, s.token, s.expiresAt);
    res.json({ ok: true });
  });

  r.post("/auth/logout", async (req, res) => {
    if (req.actor) await db.deleteFrom("sessions").where("id", "=", req.actor.sessionId).execute();
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.patch("/me", requireAuth, async (req, res) => {
    const actor = req.actor!;
    const input = parse(preferencesSchema, req.body);
    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable("users")
        .set({
          display_name: input.displayName ?? actor.user.display_name,
          timezone: input.timezone ?? actor.user.timezone,
          remind_24h: input.remind24h ?? actor.user.remind_24h,
          remind_1h: input.remind1h ?? actor.user.remind_1h,
          email_notifications: input.emailNotifications ?? actor.user.email_notifications,
          updated_at: new Date(),
        })
        .where("id", "=", actor.user.id)
        .execute();
      if (input.remind1h !== undefined || input.remind24h !== undefined) await syncRemindersForUser(tx, actor.user.id);
      await audit(tx, actor.user.id, "user.preferences_updated", "user", actor.user.id, { ...input });
    });
    res.json({ ok: true });
  });

  r.get("/me/availability", requireAuth, async (req, res) => {
    const rows = await db
      .selectFrom("user_availability")
      .select(["weekday", "start_time", "end_time"])
      .where("user_id", "=", req.actor!.user.id)
      .orderBy("weekday")
      .orderBy("start_time")
      .execute();
    res.json({ windows: rows.map((w) => ({ weekday: w.weekday, start: hhmm(w.start_time), end: hhmm(w.end_time) })) });
  });

  r.put("/me/availability", requireAuth, async (req, res) => {
    const { windows } = parse(availabilitySchema, req.body);
    const userId = req.actor!.user.id;
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom("user_availability").where("user_id", "=", userId).execute();
      if (windows.length) {
        await tx
          .insertInto("user_availability")
          .values(windows.map((w) => ({ user_id: userId, weekday: w.weekday, start_time: w.start, end_time: w.end })))
          .execute();
      }
      await audit(tx, userId, "user.availability_updated", "user", userId, { windows: windows.length });
    });
    res.json({ ok: true });
  });

  return r;
}
