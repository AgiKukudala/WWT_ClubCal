import { Router } from "express";
import {
  type JobHealthDTO,
  legacyImportSchema,
  type NotificationDTO,
  type RoomDTO,
  roomSchema,
  userRoleSchema,
} from "@clubcal/shared";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, isUniqueViolation, notFound } from "../lib/errors.js";
import { hhmm } from "../lib/time.js";
import { commitImport, previewImport } from "../modules/admin/legacyImport.js";
import { roomBusy } from "../modules/bookings/bookings.js";
import { syncRemindersForUser } from "../modules/reminders/sync.js";
import type { AppDeps } from "./app.js";
import { idParam, parse } from "./validate.js";

async function listRooms(db: Db, ids?: string[]): Promise<RoomDTO[]> {
  let q = db.selectFrom("rooms").selectAll();
  if (ids) q = q.where("id", "in", ids);
  const rooms = await q.orderBy("name").execute();
  if (rooms.length === 0) return [];
  const hours = await db.selectFrom("room_hours").selectAll().where("room_id", "in", rooms.map((r) => r.id)).orderBy("weekday").execute();
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    location: r.location,
    capacity: r.capacity,
    timezone: r.timezone,
    features: r.features,
    isActive: r.is_active,
    hours: hours.filter((h) => h.room_id === r.id).map((h) => ({ weekday: h.weekday, opens: hhmm(h.opens_at), closes: hhmm(h.closes_at) })),
  }));
}

export function miscRoutes({ db }: AppDeps) {
  const r = Router();
  r.use(requireAuth);

  // ------------------------------------------------------------ rooms
  r.get("/rooms", async (_req, res) => {
    res.json({ items: await listRooms(db) });
  });

  r.get("/rooms/:id/busy", async (req, res) => {
    const id = idParam(req.params.id);
    const q = parse(z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }), req.query);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from || to.getTime() - from.getTime() > 31 * 86_400_000) throw badRequest("Choose a range of at most 31 days");
    const busy = await roomBusy(db, [id], from, to);
    // Busy blocks only: event details are not exposed through room availability.
    res.json({ items: busy.map((b) => ({ startsAt: new Date(b.starts_at).toISOString(), endsAt: new Date(b.ends_at).toISOString() })) });
  });

  const saveRoom = async (actorId: string, input: z.infer<typeof roomSchema>, id?: string) =>
    db.transaction().execute(async (tx) => {
      const values = {
        name: input.name,
        location: input.location,
        capacity: input.capacity,
        timezone: input.timezone,
        features: input.features,
        is_active: input.isActive,
      };
      let roomId = id;
      try {
        if (id) {
          const u = await tx.updateTable("rooms").set({ ...values, updated_at: new Date() }).where("id", "=", id).executeTakeFirst();
          if (Number(u.numUpdatedRows) === 0) throw notFound("Room");
        } else {
          roomId = (await tx.insertInto("rooms").values(values).returning("id").executeTakeFirstOrThrow()).id;
        }
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("A room with that name already exists.");
        throw err;
      }
      await tx.deleteFrom("room_hours").where("room_id", "=", roomId!).execute();
      if (input.hours.length) {
        await tx
          .insertInto("room_hours")
          .values(input.hours.map((h) => ({ room_id: roomId!, weekday: h.weekday, opens_at: h.opens, closes_at: h.closes })))
          .execute();
      }
      await audit(tx, actorId, id ? "room.updated" : "room.created", "room", roomId!, { ...input });
      return roomId!;
    });

  r.post("/rooms", requireRole("admin"), async (req, res) => {
    const id = await saveRoom(req.actor!.user.id, parse(roomSchema, req.body));
    res.status(201).json((await listRooms(db, [id]))[0]);
  });

  // Existing reservations are honored when hours or capacity change; new bookings use the new rules.
  r.put("/rooms/:id", requireRole("admin"), async (req, res) => {
    const id = await saveRoom(req.actor!.user.id, parse(roomSchema, req.body), idParam(req.params.id));
    res.json((await listRooms(db, [id]))[0]);
  });

  // ------------------------------------------------------------ notifications
  r.get("/notifications", async (req, res) => {
    const q = parse(z.object({ before: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    let query = db.selectFrom("notifications").selectAll().where("user_id", "=", req.actor!.user.id);
    if (q.before) query = query.where("created_at", "<", new Date(q.before));
    const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(q.limit).execute();
    const items: NotificationDTO[] = rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      occurrenceId: n.occurrence_id,
      createdAt: n.created_at.toISOString(),
      readAt: n.read_at?.toISOString() ?? null,
      emailStatus: n.email_status,
    }));
    res.set("Cache-Control", "no-store").json({ items, nextBefore: rows.length === q.limit ? items[items.length - 1]!.createdAt : null });
  });

  r.get("/notifications/unread-count", async (req, res) => {
    const row = await db
      .selectFrom("notifications")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("user_id", "=", req.actor!.user.id)
      .where("read_at", "is", null)
      .executeTakeFirstOrThrow();
    res.set("Cache-Control", "no-store").json({ count: Number(row.n), serverTime: new Date().toISOString() });
  });

  r.post("/notifications/:id/read", async (req, res) => {
    await db
      .updateTable("notifications")
      .set({ read_at: new Date() })
      .where("id", "=", idParam(req.params.id))
      .where("user_id", "=", req.actor!.user.id)
      .where("read_at", "is", null)
      .execute();
    res.json({ ok: true });
  });

  r.post("/notifications/read-all", async (req, res) => {
    await db.updateTable("notifications").set({ read_at: new Date() }).where("user_id", "=", req.actor!.user.id).where("read_at", "is", null).execute();
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ admin
  const admin = Router();
  admin.use(requireRole("admin"));

  admin.get("/users", async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    let query = db.selectFrom("users").select(["id", "email", "display_name", "role", "created_at", "disabled_at"]);
    if (q.q) {
      const p = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or([eb("email", "ilike", p), eb("display_name", "ilike", p)]));
    }
    const rows = await query.orderBy("display_name").limit(q.limit).offset(q.offset).execute();
    res.json({
      items: rows.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role, createdAt: u.created_at.toISOString(), disabled: u.disabled_at !== null })),
    });
  });

  admin.patch("/users/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const input = parse(userRoleSchema.partial().extend({ disabled: z.boolean().optional() }), req.body);
    if (id === req.actor!.user.id) throw conflict("You cannot change your own role or disable your own account.");
    await db.transaction().execute(async (tx) => {
      const u = await tx.selectFrom("users").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      if (!u) throw notFound("User");
      if (input.role && input.role !== u.role) {
        await tx.updateTable("users").set({ role: input.role, updated_at: new Date() }).where("id", "=", id).execute();
        if (input.role === "student") {
          // Losing the organizer role removes club management rights.
          await tx.updateTable("club_memberships").set({ role: "member" }).where("user_id", "=", id).execute();
        }
        await audit(tx, req.actor!.user.id, "user.role_changed", "user", id, { from: u.role, to: input.role });
      }
      if (input.disabled !== undefined && input.disabled !== (u.disabled_at !== null)) {
        await tx.updateTable("users").set({ disabled_at: input.disabled ? new Date() : null }).where("id", "=", id).execute();
        if (input.disabled) await tx.deleteFrom("sessions").where("user_id", "=", id).execute();
        await syncRemindersForUser(tx, id);
        await audit(tx, req.actor!.user.id, input.disabled ? "user.disabled" : "user.enabled", "user", id);
      }
    });
    res.json({ ok: true });
  });

  admin.get("/audit", async (req, res) => {
    const q = parse(
      z.object({
        entityType: z.string().max(40).optional(),
        action: z.string().max(60).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    let query = db
      .selectFrom("audit_log as a")
      .leftJoin("users as u", "u.id", "a.actor_id")
      .select(["a.id", "a.action", "a.entity_type", "a.entity_id", "a.details", "a.created_at", "u.id as uid", "u.display_name"]);
    if (q.entityType) query = query.where("a.entity_type", "=", q.entityType);
    if (q.action) query = query.where("a.action", "like", `${q.action.replace(/[\\%_]/g, "")}%`);
    if (q.before) query = query.where("a.id", "<", String(q.before));
    const rows = await query.orderBy("a.id", "desc").limit(q.limit).execute();
    res.json({
      items: rows.map((a) => ({
        id: a.id,
        actor: a.uid ? { id: a.uid, displayName: a.display_name! } : null,
        action: a.action,
        entityType: a.entity_type,
        entityId: a.entity_id,
        details: a.details,
        createdAt: a.created_at.toISOString(),
      })),
    });
  });

  admin.get("/jobs", async (_req, res) => {
    const reminders = await db.selectFrom("reminders").select(["status", (eb) => eb.fn.countAll<string>().as("n")]).groupBy("status").execute();
    const emails = await db.selectFrom("notifications").select(["email_status", (eb) => eb.fn.countAll<string>().as("n")]).groupBy("email_status").execute();
    const failedReminders = await db
      .selectFrom("reminders")
      .select(["id", "last_error", "attempts", "updated_at"])
      .where("status", "=", "failed")
      .orderBy("updated_at", "desc")
      .limit(20)
      .execute();
    const failedEmails = await db
      .selectFrom("notifications")
      .select(["id", "email_last_error", "email_attempts", "created_at"])
      .where("email_status", "=", "failed")
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();
    let queues: JobHealthDTO["queues"] = [];
    try {
      const rows = await sql<{ name: string; queued: string; active: string; failed: string }>`
        SELECT name,
               count(*) FILTER (WHERE state IN ('created', 'retry'))::text AS queued,
               count(*) FILTER (WHERE state = 'active')::text AS active,
               count(*) FILTER (WHERE state = 'failed')::text AS failed
        FROM pgboss.job GROUP BY name ORDER BY name`.execute(db);
      queues = rows.rows.map((q) => ({ name: q.name, queued: Number(q.queued), active: Number(q.active), failed: Number(q.failed) }));
    } catch {
      queues = [];
    }
    const body: JobHealthDTO = {
      reminders: reminders.map((r) => ({ status: r.status, count: Number(r.n) })),
      emails: emails.map((r) => ({ status: r.email_status, count: Number(r.n) })),
      recentFailures: [
        ...failedReminders.map((f) => ({ kind: "reminder" as const, id: f.id, error: f.last_error, attempts: f.attempts, updatedAt: f.updated_at.toISOString() })),
        ...failedEmails.map((f) => ({ kind: "email" as const, id: f.id, error: f.email_last_error, attempts: f.email_attempts, updatedAt: f.created_at.toISOString() })),
      ],
      queues,
    };
    res.set("Cache-Control", "no-store").json(body);
  });

  admin.post("/import/preview", async (req, res) => {
    const input = parse(legacyImportSchema, req.body);
    res.json(await previewImport(db, req.actor!, input));
  });

  admin.post("/import/commit", async (req, res) => {
    const input = parse(legacyImportSchema.extend({ fileSha256: z.string().regex(/^[0-9a-f]{64}$/) }), req.body);
    res.status(201).json(await commitImport(db, req.actor!, input, input.fileSha256));
  });

  r.use("/admin", admin);
  return r;
}
