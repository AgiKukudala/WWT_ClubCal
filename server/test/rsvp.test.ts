import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setRsvp } from "../src/modules/rsvps/rsvps.js";
import { actorFor, type Ctx, eventBody, login, makeClub, makeRoom, makeUser, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

async function publishedEvent(capacity: number | null, over: Record<string, unknown> = {}) {
  const admin = await makeUser(ctx.db, "admin");
  const club = await makeClub(ctx.db);
  const a = await login(ctx.app, admin.email);
  const res = await a.post("/api/series", eventBody(club.id, { capacity, submit: true, ...over }));
  expect(res.status).toBe(201);
  return { admin: a, adminUser: admin, club, occurrenceId: res.body.firstOccurrenceId as string, seriesId: res.body.seriesId as string };
}

async function statusCounts(occurrenceId: string) {
  const rows = await ctx.db
    .selectFrom("rsvps")
    .select(["status", (eb) => eb.fn.countAll<string>().as("n")])
    .where("occurrence_id", "=", occurrenceId)
    .groupBy("status")
    .execute();
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

describe("RSVPs and waitlists", () => {
  it("concurrent RSVPs never exceed capacity and the overflow is waitlisted in order", async () => {
    const { occurrenceId } = await publishedEvent(5);
    const users = await Promise.all(Array.from({ length: 25 }, () => makeUser(ctx.db)));
    const actors = await Promise.all(users.map((u) => actorFor(ctx.db, u.id)));
    const results = await Promise.all(actors.map((a) => setRsvp(ctx.db, ctx.queue, a, occurrenceId, "going")));
    expect(results.filter((r) => r.status === "going")).toHaveLength(5);
    expect(results.filter((r) => r.status === "waitlisted")).toHaveLength(20);
    expect(await statusCounts(occurrenceId)).toEqual({ going: 5, waitlisted: 20 });
    const positions = results.filter((r) => r.status === "waitlisted").map((r) => r.waitlistPosition).sort((a, b) => a! - b!);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("concurrent RSVPs over HTTP also respect capacity", async () => {
    const { occurrenceId } = await publishedEvent(3);
    const sessions = await Promise.all(Array.from({ length: 10 }, async () => login(ctx.app, (await makeUser(ctx.db)).email)));
    const res = await Promise.all(sessions.map((s) => s.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await statusCounts(occurrenceId)).toEqual({ going: 3, waitlisted: 7 });
  });

  it("promotes the first waitlisted person atomically and notifies them", async () => {
    const { occurrenceId } = await publishedEvent(1);
    const [u1, u2, u3] = [await makeUser(ctx.db), await makeUser(ctx.db), await makeUser(ctx.db)];
    const [a1, a2, a3] = [await actorFor(ctx.db, u1.id), await actorFor(ctx.db, u2.id), await actorFor(ctx.db, u3.id)];
    expect((await setRsvp(ctx.db, ctx.queue, a1, occurrenceId, "going")).status).toBe("going");
    expect((await setRsvp(ctx.db, ctx.queue, a2, occurrenceId, "going")).waitlistPosition).toBe(1);
    expect((await setRsvp(ctx.db, ctx.queue, a3, occurrenceId, "going")).waitlistPosition).toBe(2);

    await setRsvp(ctx.db, ctx.queue, a1, occurrenceId, "not_going");
    const rows = await ctx.db.selectFrom("rsvps").select(["user_id", "status"]).where("occurrence_id", "=", occurrenceId).execute();
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r.status]));
    expect(byUser).toEqual({ [u1.id]: "not_going", [u2.id]: "going", [u3.id]: "waitlisted" });
    const notes = await ctx.db.selectFrom("notifications").select(["user_id", "kind"]).where("kind", "=", "rsvp.promoted").execute();
    expect(notes).toEqual([{ user_id: u2.id, kind: "rsvp.promoted" }]);
    // u3 is now first in line.
    const s3 = await login(ctx.app, u3.email);
    expect((await s3.get(`/api/occurrences/${occurrenceId}`)).body.myWaitlistPosition).toBe(1);
  });

  it("concurrent cancellations promote exactly as many people as spots opened", async () => {
    const { occurrenceId } = await publishedEvent(3);
    const users = await Promise.all(Array.from({ length: 8 }, () => makeUser(ctx.db)));
    const actors = await Promise.all(users.map((u) => actorFor(ctx.db, u.id)));
    for (const a of actors) await setRsvp(ctx.db, ctx.queue, a, occurrenceId, "going");
    await Promise.all(actors.slice(0, 3).map((a) => setRsvp(ctx.db, ctx.queue, a, occurrenceId, "not_going")));
    expect(await statusCounts(occurrenceId)).toEqual({ going: 3, waitlisted: 2, not_going: 3 });
    const going = await ctx.db.selectFrom("rsvps").select("user_id").where("occurrence_id", "=", occurrenceId).where("status", "=", "going").execute();
    // FIFO: the first three waitlisted users were promoted.
    expect(going.map((g) => g.user_id).sort()).toEqual(users.slice(3, 6).map((u) => u.id).sort());
    const promotions = await ctx.db.selectFrom("notifications").select("id").where("kind", "=", "rsvp.promoted").execute();
    expect(promotions).toHaveLength(3);
  });

  it("repeating the same response is idempotent and keeps waitlist position", async () => {
    const { occurrenceId } = await publishedEvent(1);
    const [u1, u2] = [await makeUser(ctx.db), await makeUser(ctx.db)];
    const s1 = await login(ctx.app, u1.email);
    const s2 = await login(ctx.app, u2.email);
    await s1.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" }).expect(200);
    const first = await s2.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" });
    const retries = await Promise.all([1, 2, 3].map(() => s2.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" })));
    expect(first.body).toMatchObject({ status: "waitlisted", waitlistPosition: 1, changed: true });
    for (const r of retries) expect(r.body).toMatchObject({ status: "waitlisted", waitlistPosition: 1, changed: false });
    const again = await s1.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" });
    expect(again.body).toMatchObject({ status: "going", changed: false });
    expect(await statusCounts(occurrenceId)).toEqual({ going: 1, waitlisted: 1 });
  });

  it("capacity reduction moves the most recent attendees to the front of the waitlist", async () => {
    const room = await makeRoom(ctx.db, 50);
    const { admin, occurrenceId } = await publishedEvent(3, { roomId: room.id });
    const users = await Promise.all(Array.from({ length: 4 }, () => makeUser(ctx.db)));
    for (const u of users) await setRsvp(ctx.db, ctx.queue, await actorFor(ctx.db, u.id), occurrenceId, "going");
    const occ = await admin.get(`/api/occurrences/${occurrenceId}`);
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(occ.body.startsAt));
    const res = await admin.patch(`/api/occurrences/${occurrenceId}`, {
      expectedVersion: occ.body.occurrenceVersion, date: d, startTime: "15:00", durationMinutes: 60, roomId: room.id, capacity: 1,
    });
    expect(res.status).toBe(200);
    const rows = await ctx.db
      .selectFrom("rsvps")
      .select(["user_id", "status", "waitlist_position"])
      .where("occurrence_id", "=", occurrenceId)
      .orderBy("waitlist_position")
      .execute();
    const going = rows.filter((r) => r.status === "going").map((r) => r.user_id);
    const waiting = rows.filter((r) => r.status === "waitlisted").map((r) => r.user_id);
    expect(going).toEqual([users[0]!.id]);
    // Demoted users (2nd, 3rd) are ahead of the user who was already waiting (4th).
    expect(waiting).toEqual([users[1]!.id, users[2]!.id, users[3]!.id]);
    const demoted = await ctx.db.selectFrom("notifications").select("user_id").where("kind", "=", "rsvp.demoted").execute();
    expect(demoted.map((d2) => d2.user_id).sort()).toEqual([users[1]!.id, users[2]!.id].sort());
  });

  it("cancelled or unpublished events refuse RSVPs", async () => {
    const { admin, occurrenceId } = await publishedEvent(10);
    const u = await makeUser(ctx.db);
    const s = await login(ctx.app, u.email);
    await s.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" }).expect(200);
    await admin.post(`/api/occurrences/${occurrenceId}/cancel`, { scope: "occurrence", reason: "Weather" }).expect(200);
    const res = await s.put(`/api/occurrences/${occurrenceId}/rsvp`, { response: "going" });
    expect(res.status).toBe(409);
    const view = await s.get(`/api/occurrences/${occurrenceId}`);
    expect(view.body.status).toBe("cancelled");
    expect(view.body.myRsvp).toBe("going");
    const note = await ctx.db.selectFrom("notifications").select(["kind", "body"]).where("user_id", "=", u.id).executeTakeFirstOrThrow();
    expect(note.kind).toBe("event.cancelled");
    expect(note.body).toContain("Weather");
  });

  it("organizers can list attendees; students cannot", async () => {
    const { admin, occurrenceId } = await publishedEvent(1);
    const [u1, u2] = [await makeUser(ctx.db, "student", "Alpha"), await makeUser(ctx.db, "student", "Beta")];
    await setRsvp(ctx.db, ctx.queue, await actorFor(ctx.db, u1.id), occurrenceId, "going");
    await setRsvp(ctx.db, ctx.queue, await actorFor(ctx.db, u2.id), occurrenceId, "going");
    const list = await admin.get(`/api/occurrences/${occurrenceId}/attendees`);
    expect(list.body.attendees.map((a: { displayName: string; status: string; waitlistPosition: number | null }) => [a.displayName, a.status, a.waitlistPosition])).toEqual([
      ["Alpha", "going", null],
      ["Beta", "waitlisted", 1],
    ]);
    const s = await login(ctx.app, u1.email);
    expect((await s.get(`/api/occurrences/${occurrenceId}/attendees`)).status).toBe(403);
  });
});
