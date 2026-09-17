/**
 * Reproducible local benchmark. Creates its own throwaway club/room/users, measures,
 * prints results, and deletes everything it created. Numbers depend entirely on the
 * machine; nothing here is a published performance claim.
 *
 *   npm run bench -- [--users 200] [--capacity 50] [--bookers 40] [--events 300]
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildActor } from "../auth/middleware.js";
import { createDb, createPool } from "../db/index.js";
import type { User } from "../db/types.js";
import { createEvent } from "../modules/events/service.js";
import { listOccurrences } from "../modules/occurrences/read.js";
import { setRsvp } from "../modules/rsvps/rsvps.js";
import { bossQueue, createBoss } from "../queue/boss.js";
import { addDays, todayIn } from "../lib/time.js";
import { arg } from "./args.js";

const nUsers = Number(arg("users") ?? 200);
const capacity = Number(arg("capacity") ?? 50);
const nBookers = Number(arg("bookers") ?? 40);
const nEvents = Number(arg("events") ?? 300);
const TZ = "America/Chicago";

const pool = createPool(undefined, 50);
const db = createDb(pool);
const boss = createBoss("api");
await boss.start();
const queue = bossQueue(boss);
const deps = { db, queue };
const tag = `bench-${randomUUID().slice(0, 8)}`;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const fmt = (ms: number) => `${ms.toFixed(1)} ms`;

let clubId = "";
let roomId = "";
try {
  clubId = (await db.insertInto("clubs").values({ name: tag, slug: tag, category: "Bench", color: "#000000" }).returning("id").executeTakeFirstOrThrow()).id;
  roomId = (await db.insertInto("rooms").values({ name: tag, location: "bench", capacity: 10000, timezone: TZ }).returning("id").executeTakeFirstOrThrow()).id;
  await db.insertInto("room_hours").values([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ room_id: roomId, weekday, opens_at: "00:00", closes_at: "23:59" }))).execute();
  const admin = await db
    .insertInto("users")
    .values({ email: `${tag}-admin@bench.local`, display_name: "bench admin", password_hash: "x", role: "admin" })
    .returningAll()
    .executeTakeFirstOrThrow();
  const adminActor = await buildActor(db, admin);
  const users: User[] = await db
    .insertInto("users")
    .values(Array.from({ length: nUsers }, (_, i) => ({ email: `${tag}-u${i}@bench.local`, display_name: `u${i}`, password_hash: "x" })))
    .returningAll()
    .execute();
  const actors = await Promise.all(users.map((u) => buildActor(db, u)));
  const day = addDays(todayIn(TZ), 30);

  // 1. Concurrent RSVPs against a capacity-limited event.
  const ev = await createEvent(deps, adminActor, {
    clubId, title: `${tag} rsvp`, description: "", category: "Bench", visibility: "public", timezone: TZ,
    allDay: false, startDate: day, startTime: "12:00", durationMinutes: 60, capacity, submit: true,
  });
  const occId = ev.occurrences[0]!.id;
  const lat: number[] = [];
  let t0 = performance.now();
  const results = await Promise.all(
    actors.map(async (a) => {
      const s = performance.now();
      const r = await setRsvp(db, queue, a, occId, "going");
      lat.push(performance.now() - s);
      return r.status;
    }),
  );
  const rsvpWall = performance.now() - t0;
  const going = results.filter((r) => r === "going").length;
  console.log(`\nConcurrent RSVPs: ${nUsers} users, capacity ${capacity}`);
  console.log(`  going=${going} waitlisted=${results.length - going} (correct: ${going === Math.min(capacity, nUsers)})`);
  console.log(`  wall=${fmt(rsvpWall)} throughput=${((nUsers / rsvpWall) * 1000).toFixed(0)} rsvp/s p50=${fmt(pct(lat, 50))} p95=${fmt(pct(lat, 95))}`);

  // 2. Concurrent conflicting room bookings.
  t0 = performance.now();
  const booking = await Promise.allSettled(
    Array.from({ length: nBookers }, (_, i) =>
      createEvent(deps, adminActor, {
        clubId, title: `${tag} booking ${i}`, description: "", category: "Bench", visibility: "public", timezone: TZ,
        allDay: false, startDate: addDays(day, 1), startTime: "10:00", durationMinutes: 60, roomId, submit: true,
      }),
    ),
  );
  const ok = booking.filter((b) => b.status === "fulfilled").length;
  console.log(`\nConcurrent overlapping bookings: ${nBookers} requests for one room/slot`);
  console.log(`  succeeded=${ok} rejected=${nBookers - ok} (correct: ${ok === 1}) wall=${fmt(performance.now() - t0)}`);

  // 3. Calendar range query over many events.
  for (let i = 0; i < nEvents; i++) {
    await createEvent(deps, adminActor, {
      clubId, title: `${tag} filler ${i}`, description: "", category: "Bench", visibility: "public", timezone: TZ,
      allDay: false, startDate: addDays(day, 2 + (i % 28)), startTime: `${String(8 + (i % 10)).padStart(2, "0")}:00`, durationMinutes: 30, submit: true,
    });
  }
  const student = actors[0]!;
  const qlat: number[] = [];
  const from = new Date(`${addDays(day, 0)}T00:00:00Z`).toISOString();
  const to = new Date(`${addDays(day, 35)}T00:00:00Z`).toISOString();
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    await listOccurrences(db, student, { from, to, limit: 500 });
    qlat.push(performance.now() - s);
  }
  console.log(`\nMonth view query: ${nEvents + 2} events in range, 30 runs`);
  console.log(`  p50=${fmt(pct(qlat, 50))} p95=${fmt(pct(qlat, 95))}`);
  console.log(`\nMachine: node ${process.version}, ${process.platform}/${process.arch}. Results are local measurements only.`);
} finally {
  if (clubId) await db.deleteFrom("event_series").where("club_id", "=", clubId).execute();
  await db.deleteFrom("audit_log").where("actor_id", "in", db.selectFrom("users").select("id").where("email", "like", `${tag}-%`)).execute();
  await db.deleteFrom("users").where("email", "like", `${tag}-%`).execute();
  if (roomId) await db.deleteFrom("rooms").where("id", "=", roomId).execute();
  if (clubId) await db.deleteFrom("clubs").where("id", "=", clubId).execute();
  await boss.stop({ graceful: false }).catch(() => {});
  await db.destroy();
}
