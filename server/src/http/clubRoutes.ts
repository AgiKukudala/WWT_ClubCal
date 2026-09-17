import { Router } from "express";
import { type ClubSummaryDTO, clubSchema, memberRoleSchema, updateClubSchema } from "@clubcal/shared";
import { sql } from "kysely";
import { z } from "zod";
import { type Actor, assertCanManageClub, canManageClub, isAdmin } from "../auth/context.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../lib/errors.js";
import { lockOccurrence, rebalance } from "../modules/rsvps/rsvps.js";
import { syncReminders } from "../modules/reminders/sync.js";
import type { AppDeps } from "./app.js";
import { idParam, parse } from "./validate.js";

async function clubSummaries(db: Db, actor: Actor, filter?: { idOrSlug?: string }): Promise<ClubSummaryDTO[]> {
  let q = db
    .selectFrom("clubs as c")
    .leftJoin("club_memberships as me", (j) => j.onRef("me.club_id", "=", "c.id").on("me.user_id", "=", actor.user.id))
    .select([
      "c.id",
      "c.slug",
      "c.name",
      "c.description",
      "c.category",
      "c.color",
      "c.is_demo",
      "me.role as my_role",
      (eb) =>
        eb.selectFrom("club_memberships as m").select((e) => e.fn.countAll<string>().as("n")).whereRef("m.club_id", "=", "c.id").as("member_count"),
    ])
    .where("c.archived_at", "is", null);
  if (filter?.idOrSlug) {
    const v = filter.idOrSlug;
    q = /^[0-9a-f-]{36}$/i.test(v) ? q.where("c.id", "=", v) : q.where("c.slug", "=", v);
  }
  const rows = await q.orderBy("c.name").execute();
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    category: r.category,
    color: r.color,
    memberCount: Number(r.member_count ?? 0),
    myRole: r.my_role ?? null,
    isDemo: r.is_demo,
  }));
}

export function clubRoutes(deps: AppDeps) {
  const { db, queue } = deps;
  const r = Router();
  r.use(requireAuth);

  r.get("/clubs", async (req, res) => {
    res.json({ items: await clubSummaries(db, req.actor!) });
  });

  r.get("/clubs/:idOrSlug", async (req, res) => {
    const [club] = await clubSummaries(db, req.actor!, { idOrSlug: req.params.idOrSlug });
    if (!club) throw notFound("Club");
    const organizers = await db
      .selectFrom("club_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["u.id", "u.display_name"])
      .where("m.club_id", "=", club.id)
      .where("m.role", "=", "organizer")
      .orderBy("u.display_name")
      .execute();
    res.json({ ...club, organizers: organizers.map((o) => ({ id: o.id, displayName: o.display_name })), canManage: canManageClub(req.actor!, club.id) });
  });

  r.post("/clubs", requireRole("admin"), async (req, res) => {
    const input = parse(clubSchema, req.body);
    const club = await db.transaction().execute(async (tx) => {
      try {
        const c = await tx.insertInto("clubs").values(input).returning("id").executeTakeFirstOrThrow();
        await audit(tx, req.actor!.user.id, "club.created", "club", c.id, input);
        return c;
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("A club with that name or URL slug already exists.");
        throw err;
      }
    });
    res.status(201).json({ id: club.id });
  });

  r.patch("/clubs/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const actor = req.actor!;
    assertCanManageClub(actor, id);
    const input = parse(updateClubSchema, req.body);
    if (!isAdmin(actor) && (input.slug !== undefined || input.name !== undefined || input.category !== undefined)) {
      throw forbidden("Organizers can change a club's description and color; ask an administrator to rename it.");
    }
    await db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom("clubs").selectAll().where("id", "=", id).where("archived_at", "is", null).forUpdate().executeTakeFirst();
      if (!before) throw notFound("Club");
      try {
        await tx.updateTable("clubs").set({ ...input, updated_at: new Date() }).where("id", "=", id).execute();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("A club with that name or URL slug already exists.");
        throw err;
      }
      await audit(tx, actor.user.id, "club.updated", "club", id, input);
    });
    res.json({ ok: true });
  });

  r.delete("/clubs/:id", requireRole("admin"), async (req, res) => {
    const id = idParam(req.params.id);
    await db.transaction().execute(async (tx) => {
      const upcoming = await tx
        .selectFrom("event_series as s")
        .innerJoin("event_occurrences as o", "o.series_id", "s.id")
        .select("o.id")
        .where("s.club_id", "=", id)
        .where("s.status", "in", ["approved", "pending"])
        .where("o.cancelled_at", "is", null)
        .where("o.ends_at", ">", new Date())
        .limit(1)
        .executeTakeFirst();
      if (upcoming) throw conflict("Cancel this club's upcoming events before archiving it.");
      const r2 = await tx.updateTable("clubs").set({ archived_at: new Date() }).where("id", "=", id).where("archived_at", "is", null).executeTakeFirst();
      if (Number(r2.numUpdatedRows) === 0) throw notFound("Club");
      await audit(tx, req.actor!.user.id, "club.archived", "club", id);
    });
    res.status(204).end();
  });

  r.post("/clubs/:id/join", async (req, res) => {
    const id = idParam(req.params.id);
    const actor = req.actor!;
    await db.transaction().execute(async (tx) => {
      const club = await tx.selectFrom("clubs").select("id").where("id", "=", id).where("archived_at", "is", null).executeTakeFirst();
      if (!club) throw notFound("Club");
      const ins = await tx
        .insertInto("club_memberships")
        .values({ club_id: id, user_id: actor.user.id, role: "member" })
        .onConflict((oc) => oc.columns(["club_id", "user_id"]).doNothing())
        .returning("user_id")
        .executeTakeFirst();
      if (ins) await audit(tx, actor.user.id, "club.joined", "club", id);
    });
    res.json({ ok: true });
  });

  r.post("/clubs/:id/leave", async (req, res) => {
    const id = idParam(req.params.id);
    const actor = req.actor!;
    await db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom("club_memberships").select("role").where("club_id", "=", id).where("user_id", "=", actor.user.id).forUpdate().executeTakeFirst();
      if (!m) return; // idempotent
      if (m.role === "organizer") throw conflict("Organizers must be unassigned by an administrator before leaving.");
      await tx.deleteFrom("club_memberships").where("club_id", "=", id).where("user_id", "=", actor.user.id).execute();
      await releaseClubOnlyRsvps(tx, queue, id, actor.user.id);
      await audit(tx, actor.user.id, "club.left", "club", id);
    });
    res.json({ ok: true });
  });

  r.get("/clubs/:id/members", async (req, res) => {
    const id = idParam(req.params.id);
    assertCanManageClub(req.actor!, id);
    const rows = await db
      .selectFrom("club_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["u.id", "u.display_name", "u.email", "m.role", "m.joined_at"])
      .where("m.club_id", "=", id)
      .orderBy(sql`m.role DESC`)
      .orderBy("u.display_name")
      .execute();
    res.json({
      items: rows.map((m) => ({ userId: m.id, displayName: m.display_name, email: m.email, role: m.role, joinedAt: m.joined_at.toISOString() })),
    });
  });

  // Administrators assign organizers (and may add members directly).
  r.put("/clubs/:id/members", requireRole("admin"), async (req, res) => {
    const id = idParam(req.params.id);
    const input = parse(memberRoleSchema, req.body);
    await db.transaction().execute(async (tx) => {
      const club = await tx.selectFrom("clubs").select("id").where("id", "=", id).where("archived_at", "is", null).executeTakeFirst();
      if (!club) throw notFound("Club");
      const user = await tx.selectFrom("users").select(["id", "role"]).where("id", "=", input.userId).forUpdate().executeTakeFirst();
      if (!user) throw badRequest("Unknown user", { userId: ["Unknown user"] });
      if (input.role === "organizer" && user.role === "student") {
        await tx.updateTable("users").set({ role: "organizer", updated_at: new Date() }).where("id", "=", user.id).execute();
        await audit(tx, req.actor!.user.id, "user.role_changed", "user", user.id, { from: "student", to: "organizer" });
      }
      await tx
        .insertInto("club_memberships")
        .values({ club_id: id, user_id: input.userId, role: input.role })
        .onConflict((oc) => oc.columns(["club_id", "user_id"]).doUpdateSet({ role: input.role }))
        .execute();
      await audit(tx, req.actor!.user.id, "club.member_role_set", "club", id, input);
    });
    res.json({ ok: true });
  });

  r.delete("/clubs/:id/members/:userId", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = idParam(req.params.userId);
    const actor = req.actor!;
    assertCanManageClub(actor, id);
    await db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom("club_memberships").select("role").where("club_id", "=", id).where("user_id", "=", userId).forUpdate().executeTakeFirst();
      if (!m) throw notFound("Membership");
      if (m.role === "organizer" && !isAdmin(actor)) throw forbidden("Only administrators can remove organizers.");
      await tx.deleteFrom("club_memberships").where("club_id", "=", id).where("user_id", "=", userId).execute();
      await releaseClubOnlyRsvps(tx, queue, id, userId);
      await audit(tx, actor.user.id, "club.member_removed", "club", id, { userId });
    });
    res.status(204).end();
  });

  // Organizer dashboard: every series (any status) in clubs the actor manages.
  r.get("/manage/series", requireRole("organizer", "admin"), async (req, res) => {
    const q = parse(z.object({ clubId: z.uuid().optional(), status: z.enum(["draft", "pending", "approved", "rejected", "cancelled"]).optional() }), req.query);
    const actor = req.actor!;
    const managed = isAdmin(actor) ? null : [...actor.organizerClubIds];
    if (managed && managed.length === 0) return void res.json({ items: [] });
    let query = db
      .selectFrom("event_series as s")
      .innerJoin("clubs as c", "c.id", "s.club_id")
      .select([
        "s.id",
        "s.title",
        "s.status",
        "s.version",
        "s.review_comment",
        "s.recurrence_weekdays",
        "s.updated_at",
        "c.id as club_id",
        "c.name as club_name",
        "c.color as club_color",
        (eb) =>
          eb.selectFrom("event_occurrences as o").select("o.id").whereRef("o.series_id", "=", "s.id").orderBy("o.starts_at").limit(1).as("first_occurrence_id"),
        (eb) =>
          eb.selectFrom("event_occurrences as o").select((e) => e.fn.min("o.starts_at").as("m")).whereRef("o.series_id", "=", "s.id").as("first_starts_at"),
      ])
      .where("c.archived_at", "is", null);
    if (managed) query = query.where("s.club_id", "in", managed);
    if (q.clubId) query = query.where("s.club_id", "=", q.clubId);
    if (q.status) query = query.where("s.status", "=", q.status);
    const rows = await query.orderBy("s.updated_at", "desc").limit(200).execute();
    res.json({
      items: rows.map((s) => ({
        seriesId: s.id,
        title: s.title,
        status: s.status,
        version: s.version,
        reviewComment: s.review_comment,
        isRecurring: s.recurrence_weekdays !== null,
        updatedAt: s.updated_at.toISOString(),
        club: { id: s.club_id, name: s.club_name, color: s.club_color },
        firstOccurrenceId: s.first_occurrence_id,
        firstStartsAt: s.first_starts_at ? new Date(s.first_starts_at as unknown as string).toISOString() : null,
      })),
    });
  });

  return r;
}

/** When someone leaves a club, their spots at its upcoming club-only events are released. */
async function releaseClubOnlyRsvps(tx: Parameters<typeof rebalance>[0], queue: AppDeps["queue"], clubId: string, userId: string) {
  const rows = await tx
    .selectFrom("rsvps as r")
    .innerJoin("event_occurrences as o", "o.id", "r.occurrence_id")
    .innerJoin("event_series as s", "s.id", "o.series_id")
    .select(["r.occurrence_id", "r.status"])
    .where("r.user_id", "=", userId)
    .where("s.club_id", "=", clubId)
    .where("s.visibility", "=", "club")
    .where("r.status", "in", ["going", "waitlisted"])
    .where("o.ends_at", ">", new Date())
    .execute();
  for (const row of rows) {
    await lockOccurrence(tx, row.occurrence_id);
    await tx
      .updateTable("rsvps")
      .set({ status: "not_going", waitlist_position: null, responded_at: new Date() })
      .where("occurrence_id", "=", row.occurrence_id)
      .where("user_id", "=", userId)
      .execute();
    if (row.status === "going") await rebalance(tx, queue, row.occurrence_id, userId);
    await syncReminders(tx, [row.occurrence_id], [userId]);
  }
}
