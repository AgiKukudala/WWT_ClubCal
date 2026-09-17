import { sql } from "kysely";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import type { Role } from "@clubcal/shared";
import { buildActor } from "../src/auth/middleware.js";
import { hashPassword } from "../src/auth/passwords.js";
import { createDb, createPool, type Db } from "../src/db/index.js";
import { createApp } from "../src/http/app.js";
import { bossQueue, createBoss, type JobQueue } from "../src/queue/boss.js";
import type { PgBoss } from "pg-boss";

export const PASSWORD = "correct-horse-battery";
let passwordHash: Promise<string> | null = null;

export interface Ctx {
  db: Db;
  boss: PgBoss;
  queue: JobQueue;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

export async function setupCtx(): Promise<Ctx> {
  const pool = createPool(process.env.DATABASE_URL, 40);
  const db = createDb(pool);
  const boss = createBoss("api");
  await boss.start();
  const queue = bossQueue(boss);
  const app = createApp({ db, queue });
  return {
    db,
    boss,
    queue,
    app,
    async close() {
      await boss.stop({ graceful: false }).catch(() => {});
      await db.destroy();
    },
  };
}

export async function resetDb(db: Db) {
  await sql`TRUNCATE users, sessions, login_attempts, user_availability, clubs, club_memberships, rooms, room_hours,
    legacy_imports, legacy_import_rows, event_series, event_occurrences, room_reservations, rsvps, notifications,
    reminders, audit_log RESTART IDENTITY CASCADE`.execute(db);
  await sql`DELETE FROM pgboss.job`.execute(db);
}

let seq = 0;
export async function makeUser(db: Db, role: Role = "student", name?: string) {
  passwordHash ??= hashPassword(PASSWORD);
  seq += 1;
  return db
    .insertInto("users")
    .values({
      email: `${role}${seq}-${Date.now()}@test.local`,
      display_name: name ?? `${role} ${seq}`,
      password_hash: await passwordHash,
      role,
      timezone: "America/Chicago",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function makeClub(db: Db, name?: string) {
  const n = ++seq;
  return db
    .insertInto("clubs")
    .values({ name: name ?? `Club ${n}`, slug: `club-${n}-${Date.now()}`, category: "General", color: "#2255aa" })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function addMember(db: Db, clubId: string, userId: string, role: "member" | "organizer" = "member") {
  await db.insertInto("club_memberships").values({ club_id: clubId, user_id: userId, role }).execute();
}

/** Room open 07:00–20:00 every day in America/Chicago unless hours are given. */
export async function makeRoom(db: Db, capacity = 30, hours?: { weekday: number; opens: string; closes: string }[]) {
  const room = await db
    .insertInto("rooms")
    .values({ name: `Room ${++seq}`, location: "Test building", capacity, timezone: "America/Chicago" })
    .returningAll()
    .executeTakeFirstOrThrow();
  const hs = hours ?? [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: "07:00", closes: "20:00" }));
  if (hs.length) {
    await db.insertInto("room_hours").values(hs.map((h) => ({ room_id: room.id, weekday: h.weekday, opens_at: h.opens, closes_at: h.closes }))).execute();
  }
  return room;
}

export async function actorFor(db: Db, userId: string) {
  const u = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
  return buildActor(db, u);
}

export interface Session {
  agent: TestAgent;
  csrf: string;
  get(url: string): request.Test;
  post(url: string, body?: object): request.Test;
  put(url: string, body?: object): request.Test;
  patch(url: string, body?: object): request.Test;
  del(url: string): request.Test;
}

export async function login(app: Ctx["app"], email: string, password = PASSWORD): Promise<Session> {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const s = await agent.get("/api/auth/session");
  const csrf = s.body.csrfToken as string;
  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: (url, body) => agent.post(url).set("X-CSRF-Token", csrf).send(body ?? {}),
    put: (url, body) => agent.put(url).set("X-CSRF-Token", csrf).send(body ?? {}),
    patch: (url, body) => agent.patch(url).set("X-CSRF-Token", csrf).send(body ?? {}),
    del: (url) => agent.delete(url).set("X-CSRF-Token", csrf),
  };
}

/** A date N days from today in America/Chicago, as YYYY-MM-DD. */
export function futureDate(days: number, from = new Date()): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export const eventBody = (clubId: string, over: Record<string, unknown> = {}) => ({
  clubId,
  title: "Test meeting",
  description: "",
  category: "General",
  visibility: "public",
  timezone: "America/Chicago",
  allDay: false,
  startDate: futureDate(10),
  startTime: "15:00",
  durationMinutes: 60,
  submit: false,
  ...over,
});

export const range = (fromDays = -1, toDays = 60) => ({
  from: new Date(Date.now() + fromDays * 86_400_000).toISOString(),
  to: new Date(Date.now() + toDays * 86_400_000).toISOString(),
});
