import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Ctx, eventBody, futureDate, login, makeClub, makeRoom, makeUser, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

async function adminAndClub() {
  const admin = await makeUser(ctx.db, "admin");
  const club = await makeClub(ctx.db);
  return { admin: await login(ctx.app, admin.email), club };
}

describe("room reservations", () => {
  it("simultaneous overlapping bookings: exactly one succeeds, the other gets a 409", async () => {
    const { club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    const a1 = await makeUser(ctx.db, "admin");
    const a2 = await makeUser(ctx.db, "admin");
    const [s1, s2] = [await login(ctx.app, a1.email), await login(ctx.app, a2.email)];
    const date = futureDate(7);
    const [r1, r2] = await Promise.all([
      s1.post("/api/series", eventBody(club.id, { title: "First", startDate: date, startTime: "15:00", durationMinutes: 60, roomId: room.id, submit: true })),
      s2.post("/api/series", eventBody(club.id, { title: "Second", startDate: date, startTime: "15:30", durationMinutes: 60, roomId: room.id, submit: true })),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.message).toMatch(/reserved|booked/i);
    // No private details of the other event leak into the explanation.
    expect(JSON.stringify(loser.body)).not.toMatch(/First|Second/);
    const count = await ctx.db.selectFrom("room_reservations").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
    // The losing request left nothing behind.
    const series = await ctx.db.selectFrom("event_series").select("title").execute();
    expect(series).toHaveLength(1);
  });

  it("many concurrent requests for the same slot produce exactly one reservation", async () => {
    const { club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    const sessions = await Promise.all(
      Array.from({ length: 8 }, async () => login(ctx.app, (await makeUser(ctx.db, "admin")).email)),
    );
    const date = futureDate(8);
    const results = await Promise.all(
      sessions.map((s, i) => s.post("/api/series", eventBody(club.id, { title: `Req ${i}`, startDate: date, startTime: "10:00", roomId: room.id, submit: true }))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it("adjacent reservations (half-open intervals) both succeed", async () => {
    const { admin, club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    const date = futureDate(9);
    const a = await admin.post("/api/series", eventBody(club.id, { startDate: date, startTime: "13:00", durationMinutes: 60, roomId: room.id, submit: true }));
    const b = await admin.post("/api/series", eventBody(club.id, { startDate: date, startTime: "14:00", durationMinutes: 60, roomId: room.id, submit: true }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("the database itself rejects overlapping active reservations", async () => {
    const { admin, club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    const a = await admin.post("/api/series", eventBody(club.id, { roomId: room.id, submit: true }));
    const b = await admin.post("/api/series", eventBody(club.id, { roomId: room.id, startDate: futureDate(11), submit: true }));
    const bOcc = b.body.firstOccurrenceId;
    const aRes = await ctx.db.selectFrom("room_reservations").select("during").where("occurrence_id", "=", a.body.firstOccurrenceId).executeTakeFirstOrThrow();
    await ctx.db.deleteFrom("room_reservations").where("occurrence_id", "=", bOcc).execute();
    await expect(
      sql`INSERT INTO room_reservations (room_id, occurrence_id, during) VALUES (${room.id}, ${bOcc}, ${aRes.during}::tstzrange)`.execute(ctx.db),
    ).rejects.toMatchObject({ code: "23P01" });
    await expect(
      sql`INSERT INTO room_reservations (room_id, occurrence_id, during) VALUES (${room.id}, ${bOcc}, tstzrange(now() + interval '2 hours', now() + interval '1 hour'))`.execute(ctx.db),
    ).rejects.toBeTruthy();
  });

  it("rejects bookings outside opening hours and over room capacity", async () => {
    const { admin, club } = await adminAndClub();
    const room = await makeRoom(ctx.db, 10, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: "08:00", closes: "17:00" })));
    const late = await admin.post("/api/series", eventBody(club.id, { startTime: "16:30", durationMinutes: 60, roomId: room.id, submit: true }));
    expect(late.status).toBe(409);
    expect(late.body.error.conflicts[0].reason).toBe("outside_hours");
    const early = await admin.post("/api/series", eventBody(club.id, { startTime: "07:45", durationMinutes: 30, roomId: room.id, submit: true }));
    expect(early.status).toBe(409);
    const big = await admin.post("/api/series", eventBody(club.id, { capacity: 11, roomId: room.id, submit: true }));
    expect(big.status).toBe(409);
    expect(big.body.error.conflicts[0].reason).toBe("capacity_exceeds_room");
    const exact = await admin.post("/api/series", eventBody(club.id, { startTime: "16:00", durationMinutes: 60, roomId: room.id, submit: true }));
    expect(exact.status).toBe(201);
    expect(exact.body.status).toBe("approved");
    const closedRoom = await makeRoom(ctx.db, 10, [{ weekday: 1, opens: "08:00", closes: "17:00" }]);
    let d = 10;
    while (new Date(`${futureDate(d)}T12:00:00Z`).getUTCDay() !== 2) d++;
    const closed = await admin.post("/api/series", eventBody(club.id, { startDate: futureDate(d), roomId: closedRoom.id, submit: true }));
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toMatch(/closed/);
  });

  it("pending events do not hold rooms; approval rechecks availability transactionally", async () => {
    const { admin, club } = await adminAndClub();
    const org = await makeUser(ctx.db, "organizer");
    await addMember(ctx.db, club.id, org.id, "organizer");
    const o = await login(ctx.app, org.email);
    const room = await makeRoom(ctx.db);
    const pending = await o.post("/api/series", eventBody(club.id, { title: "Pending", roomId: room.id, submit: true }));
    expect(pending.body.status).toBe("pending");
    expect(await ctx.db.selectFrom("room_reservations").selectAll().execute()).toHaveLength(0);

    // Someone else takes the room first.
    const winner = await admin.post("/api/series", eventBody(club.id, { title: "Winner", roomId: room.id, submit: true }));
    expect(winner.status).toBe(201);

    const s = await admin.get(`/api/series/${pending.body.seriesId}`);
    const review = await admin.post(`/api/series/${pending.body.seriesId}/review`, { decision: "approve", expectedVersion: s.body.version });
    expect(review.status).toBe(409);
    expect(review.body.error.conflicts).toHaveLength(1);
    const still = await ctx.db.selectFrom("event_series").select(["status", "version"]).where("id", "=", pending.body.seriesId).executeTakeFirstOrThrow();
    expect(still).toEqual({ status: "pending", version: s.body.version });
    // No approval notification was sent for the failed approval.
    const notes = await ctx.db.selectFrom("notifications").select("kind").where("user_id", "=", org.id).execute();
    expect(notes.map((n) => n.kind)).not.toContain("approval.approved");
  });

  it("recurring bookings report every conflicting date and apply nothing on conflict", async () => {
    const { admin, club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    const start = futureDate(14);
    const blocker1 = futureDate(21);
    const blocker2 = futureDate(28);
    await admin.post("/api/series", eventBody(club.id, { startDate: blocker1, startTime: "15:30", roomId: room.id, submit: true })).expect(201);
    await admin.post("/api/series", eventBody(club.id, { startDate: blocker2, startTime: "14:30", roomId: room.id, submit: true })).expect(201);
    const weekday = ((new Date(`${start}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const res = await admin.post(
      "/api/series",
      eventBody(club.id, { title: "Weekly", startDate: start, startTime: "15:00", durationMinutes: 60, roomId: room.id, submit: true, recurrence: { weekdays: [weekday], until: futureDate(42) } }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.conflicts.map((c: { date: string }) => c.date)).toEqual([blocker1, blocker2]);
    expect(await ctx.db.selectFrom("event_series").select("id").where("title", "=", "Weekly").execute()).toHaveLength(0);
    expect(await ctx.db.selectFrom("room_reservations").select("id").execute()).toHaveLength(2);
  });

  it("cancelling releases the room so it can be booked again", async () => {
    const { admin, club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    const a = await admin.post("/api/series", eventBody(club.id, { roomId: room.id, submit: true }));
    expect((await admin.post("/api/series", eventBody(club.id, { roomId: room.id, submit: true }))).status).toBe(409);
    await admin.post(`/api/occurrences/${a.body.firstOccurrenceId}/cancel`, { scope: "occurrence", reason: "Moved" }).expect(200);
    expect((await admin.post("/api/series", eventBody(club.id, { roomId: room.id, submit: true }))).status).toBe(201);
  });

  it("room busy endpoint exposes time blocks only", async () => {
    const { admin, club } = await adminAndClub();
    const room = await makeRoom(ctx.db);
    await admin.post("/api/series", eventBody(club.id, { title: "Very Private Title", roomId: room.id, submit: true })).expect(201);
    const student = await makeUser(ctx.db);
    const s = await login(ctx.app, student.email);
    const busy = await s.get(`/api/rooms/${room.id}/busy?from=${new Date().toISOString()}&to=${new Date(Date.now() + 20 * 86_400_000).toISOString()}`);
    expect(busy.status).toBe(200);
    expect(busy.body.items).toHaveLength(1);
    expect(JSON.stringify(busy.body)).not.toContain("Very Private Title");
  });
});
