import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Ctx, eventBody, login, makeClub, makeUser, PASSWORD, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

describe("registration and sessions", () => {
  it("registers students only, even if a privileged role is requested", async () => {
    const agent = request.agent(ctx.app);
    const res = await agent
      .post("/api/auth/register")
      .send({ email: "New.Person@Example.edu", displayName: "New Person", password: "long-enough-pw", role: "admin" });
    expect(res.status).toBe(201);
    const session = await agent.get("/api/auth/session");
    expect(session.body.user).toMatchObject({ email: "new.person@example.edu", role: "student" });
    const row = await ctx.db.selectFrom("users").select(["role", "password_hash"]).where("email", "=", "new.person@example.edu").executeTakeFirstOrThrow();
    expect(row.role).toBe("student");
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain("long-enough-pw");
  });

  it("rejects duplicate emails and weak passwords", async () => {
    await request(ctx.app).post("/api/auth/register").send({ email: "a@b.edu", displayName: "A", password: "long-enough-pw" }).expect(201);
    const dup = await request(ctx.app).post("/api/auth/register").send({ email: "A@B.edu", displayName: "A", password: "long-enough-pw" });
    expect(dup.status).toBe(409);
    const weak = await request(ctx.app).post("/api/auth/register").send({ email: "c@b.edu", displayName: "C", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.fields.password).toBeDefined();
  });

  it("sets an HttpOnly SameSite cookie, stores only a token hash, and logout invalidates it", async () => {
    const u = await makeUser(ctx.db, "student");
    const res = await request(ctx.app).post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers["set-cookie"]![0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Expires=/i);
    const token = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    const stored = await ctx.db.selectFrom("sessions").select("id").execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toBe(token);

    const me = await request(ctx.app).get("/api/auth/session").set("Cookie", cookie);
    expect(me.body.user.id).toBe(u.id);
    const csrf = me.body.csrfToken;
    await request(ctx.app).post("/api/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", csrf).expect(200);
    const after = await request(ctx.app).get("/api/clubs").set("Cookie", cookie);
    expect(after.status).toBe(401);
    expect(await ctx.db.selectFrom("sessions").select("id").execute()).toHaveLength(0);
  });

  it("expired sessions are rejected", async () => {
    const u = await makeUser(ctx.db);
    const s = await login(ctx.app, u.email);
    await ctx.db.updateTable("sessions").set({ created_at: new Date(Date.now() - 10_000), expires_at: new Date(Date.now() - 1000) }).execute();
    expect((await s.get("/api/clubs")).status).toBe(401);
  });

  it("rate limits repeated failed logins per account", async () => {
    const u = await makeUser(ctx.db);
    for (let i = 0; i < 5; i++) {
      const r = await request(ctx.app).post("/api/auth/login").send({ email: u.email, password: "wrong-password" });
      expect(r.status).toBe(401);
    }
    const blocked = await request(ctx.app).post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
  });

  it("does not reveal whether an email exists", async () => {
    const a = await request(ctx.app).post("/api/auth/login").send({ email: "nobody@x.edu", password: "whatever-pw" });
    const u = await makeUser(ctx.db);
    const b = await request(ctx.app).post("/api/auth/login").send({ email: u.email, password: "whatever-pw" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });
});

describe("CSRF and origin checks", () => {
  it("requires the session CSRF token on state-changing requests", async () => {
    const u = await makeUser(ctx.db);
    const club = await makeClub(ctx.db);
    const s = await login(ctx.app, u.email);
    const missing = await s.agent.post(`/api/clubs/${club.id}/join`).send({});
    expect(missing.status).toBe(403);
    const wrong = await s.agent.post(`/api/clubs/${club.id}/join`).set("X-CSRF-Token", "nope").send({});
    expect(wrong.status).toBe(403);
    const ok = await s.post(`/api/clubs/${club.id}/join`);
    expect(ok.status).toBe(200);
  });

  it("rejects cross-origin writes", async () => {
    const u = await makeUser(ctx.db);
    const club = await makeClub(ctx.db);
    const s = await login(ctx.app, u.email);
    const res = await s.agent.post(`/api/clubs/${club.id}/join`).set("X-CSRF-Token", s.csrf).set("Origin", "https://evil.example").send({});
    expect(res.status).toBe(403);
  });
});

describe("role enforcement", () => {
  it("keeps students out of administrative and organizer endpoints", async () => {
    const student = await makeUser(ctx.db, "student");
    const club = await makeClub(ctx.db);
    await addMember(ctx.db, club.id, student.id);
    const s = await login(ctx.app, student.email);
    expect((await s.get("/api/admin/users")).status).toBe(403);
    expect((await s.get("/api/admin/audit")).status).toBe(403);
    expect((await s.get("/api/approvals")).status).toBe(403);
    expect((await s.post("/api/series", eventBody(club.id))).status).toBe(403);
    expect((await s.post("/api/clubs", { name: "X Club", slug: "x", category: "a", color: "#000000" })).status).toBe(403);
    expect((await s.patch(`/api/admin/users/${student.id}`, { role: "admin" })).status).toBe(403);
    expect((await s.get(`/api/clubs/${club.id}/members`)).status).toBe(403);
  });

  it("requires authentication for API data", async () => {
    expect((await request(ctx.app).get("/api/clubs")).status).toBe(401);
    expect((await request(ctx.app).get(`/api/occurrences?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`)).status).toBe(401);
  });

  it("administrators can promote organizers; losing the role removes club management", async () => {
    const admin = await makeUser(ctx.db, "admin");
    const student = await makeUser(ctx.db, "student");
    const club = await makeClub(ctx.db);
    const a = await login(ctx.app, admin.email);
    await a.put(`/api/clubs/${club.id}/members`, { userId: student.id, role: "organizer" }).expect(200);
    const promoted = await ctx.db.selectFrom("users").select("role").where("id", "=", student.id).executeTakeFirstOrThrow();
    expect(promoted.role).toBe("organizer");
    const o = await login(ctx.app, student.email);
    expect((await o.post("/api/series", eventBody(club.id))).status).toBe(201);
    await a.patch(`/api/admin/users/${student.id}`, { role: "student" }).expect(200);
    expect((await o.post("/api/series", eventBody(club.id))).status).toBe(403);
    const audit = await ctx.db.selectFrom("audit_log").select("action").where("entity_id", "=", student.id).execute();
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(["user.role_changed"]));
  });
});
