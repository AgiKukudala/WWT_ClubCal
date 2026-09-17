import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Ctx, eventBody, futureDate, login, makeClub, makeRoom, makeUser, range, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

async function orgWorld() {
  const admin = await makeUser(ctx.db, "admin");
  const org = await makeUser(ctx.db, "organizer");
  const org2 = await makeUser(ctx.db, "organizer");
  const club = await makeClub(ctx.db);
  await addMember(ctx.db, club.id, org.id, "organizer");
  await addMember(ctx.db, club.id, org2.id, "organizer");
  return {
    club,
    admin: await login(ctx.app, admin.email),
    org: await login(ctx.app, org.email),
    org2: await login(ctx.app, org2.email),
    orgUser: org,
  };
}

const seriesPayload = (clubId: string, s: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  ...eventBody(clubId),
  title: s.title,
  description: s.description,
  category: s.category,
  visibility: s.visibility,
  timezone: s.timezone,
  allDay: s.allDay,
  startDate: s.startDate,
  startTime: s.startTime,
  durationMinutes: s.durationMinutes,
  allDayDays: s.allDayDays,
  roomId: s.roomId,
  capacity: s.capacity,
  recurrence: s.recurrence,
  expectedVersion: s.version,
  ...over,
});

describe("approval workflow", () => {
  it("draft → pending → rejected → pending → approved, with audit trail and notifications", async () => {
    const w = await orgWorld();
    const created = await w.org.post("/api/series", eventBody(w.club.id, { title: "Bake sale" }));
    expect(created.body.status).toBe("draft");
    const id = created.body.seriesId;
    let s = await w.org.get(`/api/series/${id}`);
    s = await w.org.post(`/api/series/${id}/submit`, { expectedVersion: s.body.version });
    expect(s.body.status).toBe("pending");
    const queue = await w.admin.get("/api/approvals");
    expect(queue.body.items.map((i: { seriesId: string }) => i.seriesId)).toEqual([id]);

    const noComment = await w.admin.post(`/api/series/${id}/review`, { decision: "reject", expectedVersion: s.body.version });
    expect(noComment.status).toBe(400);
    s = await w.admin.post(`/api/series/${id}/review`, { decision: "reject", comment: "Pick a different date", expectedVersion: s.body.version });
    expect(s.body).toMatchObject({ status: "rejected", reviewComment: "Pick a different date" });
    expect((await w.admin.post(`/api/series/${id}/review`, { decision: "approve", expectedVersion: s.body.version })).status).toBe(409);

    s = await w.org.post(`/api/series/${id}/submit`, { expectedVersion: s.body.version });
    s = await w.admin.post(`/api/series/${id}/review`, { decision: "approve", comment: "", expectedVersion: s.body.version });
    expect(s.body.status).toBe("approved");

    const audit = await w.org.get(`/api/series/${id}/audit`);
    expect(audit.body.items.map((a: { action: string }) => a.action).reverse()).toEqual([
      "series.created",
      "series.submitted",
      "series.rejected",
      "series.submitted",
      "series.approved",
    ]);
    expect(audit.body.items[0].actor.displayName).toBeTruthy();
    const notes = await ctx.db.selectFrom("notifications").select("kind").where("user_id", "=", w.orgUser.id).orderBy("created_at").execute();
    expect(notes.map((n) => n.kind)).toEqual(["approval.rejected", "approval.approved"]);
  });

  it("organizer changes to time/room/capacity of an approved event require re-approval; text edits do not", async () => {
    const w = await orgWorld();
    const room = await makeRoom(ctx.db);
    const created = await w.org.post("/api/series", eventBody(w.club.id, { roomId: room.id, submit: true }));
    const id = created.body.seriesId;
    let s = await w.admin.get(`/api/series/${id}`);
    s = await w.admin.post(`/api/series/${id}/review`, { decision: "approve", expectedVersion: s.body.version });
    const student = await makeUser(ctx.db);
    const st = await login(ctx.app, student.email);
    await st.put(`/api/occurrences/${created.body.firstOccurrenceId}/rsvp`, { response: "going" }).expect(200);

    s = await w.org.put(`/api/series/${id}`, seriesPayload(w.club.id, s.body, { description: "Bring snacks" }));
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("approved");
    expect(await ctx.db.selectFrom("room_reservations").select("id").execute()).toHaveLength(1);

    s = await w.org.put(`/api/series/${id}`, seriesPayload(w.club.id, s.body, { startTime: "16:00" }));
    expect(s.body.status).toBe("pending");
    expect(await ctx.db.selectFrom("room_reservations").select("id").execute()).toHaveLength(0);
    // Students no longer see it while it awaits re-approval, and were told why.
    expect((await st.get(`/api/occurrences/${created.body.firstOccurrenceId}`)).status).toBe(404);
    const note = await ctx.db.selectFrom("notifications").select("title").where("user_id", "=", student.id).executeTakeFirstOrThrow();
    expect(note.title).toMatch(/Being rescheduled/);

    s = await w.admin.post(`/api/series/${id}/review`, { decision: "approve", expectedVersion: s.body.version });
    expect(s.body.status).toBe("approved");
    const occ = await st.get(`/api/occurrences/${created.body.firstOccurrenceId}`);
    expect(occ.body.myRsvp).toBe("going");
    expect(new Date(occ.body.startsAt).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })).toBe("4:00 PM");
    expect(await ctx.db.selectFrom("room_reservations").select("id").execute()).toHaveLength(1);

    // Administrator edits stay approved.
    s = await w.admin.put(`/api/series/${id}`, seriesPayload(w.club.id, s.body, { startTime: "17:00" }));
    expect(s.body.status).toBe("approved");
  });

  it("stale edits return 409 instead of overwriting", async () => {
    const w = await orgWorld();
    const created = await w.org.post("/api/series", eventBody(w.club.id, { title: "Original" }));
    const id = created.body.seriesId;
    const v1a = await w.org.get(`/api/series/${id}`);
    const v1b = await w.org2.get(`/api/series/${id}`);
    const first = await w.org.put(`/api/series/${id}`, seriesPayload(w.club.id, v1a.body, { title: "Edit by organizer 1" }));
    expect(first.status).toBe(200);
    const second = await w.org2.put(`/api/series/${id}`, seriesPayload(w.club.id, v1b.body, { title: "Edit by organizer 2" }));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "version_conflict", currentVersion: first.body.version });
    const row = await ctx.db.selectFrom("event_series").select("title").where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.title).toBe("Edit by organizer 1");

    // Occurrence-level edits are versioned too.
    const occ = await w.admin.get(`/api/occurrences/${created.body.firstOccurrenceId}`);
    const body = { expectedVersion: occ.body.occurrenceVersion, date: futureDate(12), startTime: "09:00", durationMinutes: 30, roomId: null, capacity: null };
    const [x, y] = await Promise.all([w.org.patch(`/api/occurrences/${occ.body.id}`, body), w.org2.patch(`/api/occurrences/${occ.body.id}`, { ...body, startTime: "10:00" })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });

  it("validates input and reports field errors", async () => {
    const w = await orgWorld();
    const bad = await w.org.post("/api/series", eventBody(w.club.id, { title: "", startTime: "25:00", timezone: "Nowhere/City" }));
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(["title", "startTime", "timezone"]));
    const past = await w.org.post("/api/series", eventBody(w.club.id, { startDate: "2020-01-01" }));
    expect(past.status).toBe(400);
    const range2 = await w.org.get(`/api/occurrences?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z`);
    expect(range2.status).toBe(400);
  });

  it("deletes drafts but only cancels published events", async () => {
    const w = await orgWorld();
    const draft = await w.org.post("/api/series", eventBody(w.club.id));
    const pub = await w.admin.post("/api/series", eventBody(w.club.id, { submit: true }));
    expect((await w.org.del(`/api/series/${pub.body.seriesId}`)).status).toBe(409);
    expect((await w.org.del(`/api/series/${draft.body.seriesId}`)).status).toBe(204);
    expect((await w.org.post(`/api/occurrences/${draft.body.firstOccurrenceId}/cancel`, { scope: "series" })).status).toBe(404);
    const cancelled = await w.org.post(`/api/occurrences/${pub.body.firstOccurrenceId}/cancel`, { scope: "series", reason: "" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.occurrence.status).toBe("cancelled");
  });

  it("filters and paginates the calendar", async () => {
    const w = await orgWorld();
    const room = await makeRoom(ctx.db);
    for (let i = 0; i < 5; i++) {
      await w.admin.post("/api/series", eventBody(w.club.id, { title: `Chess ${i}`, category: "Games", startDate: futureDate(5 + i), roomId: i === 0 ? room.id : null, submit: true })).expect(201);
    }
    await w.admin.post("/api/series", eventBody(w.club.id, { title: "Art show 100%_off", category: "Arts", startDate: futureDate(6), startTime: "11:00", submit: true })).expect(201);
    const q = new URLSearchParams(range()).toString();
    const p1 = await w.org.get(`/api/occurrences?${q}&limit=4`);
    expect(p1.body.items).toHaveLength(4);
    const p2 = await w.org.get(`/api/occurrences?${q}&limit=4&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(6);
    expect((await w.org.get(`/api/occurrences?${q}&category=Arts`)).body.items).toHaveLength(1);
    expect((await w.org.get(`/api/occurrences?${q}&roomId=${room.id}`)).body.items).toHaveLength(1);
    expect((await w.org.get(`/api/occurrences?${q}&q=chess`)).body.items).toHaveLength(5);
    expect((await w.org.get(`/api/occurrences?${q}&q=${encodeURIComponent("%_")}`)).body.items).toHaveLength(1);
    expect((await w.org.get(`/api/occurrences?${q}&clubId=${w.club.id}`)).body.items).toHaveLength(6);
    expect((await w.org.get(`/api/occurrences?cursor=garbage&${q}`)).status).toBe(400);
  });

  it("stores all-day events as dates, separate from timed instants", async () => {
    const w = await orgWorld();
    const d = futureDate(15);
    const res = await w.admin.post("/api/series", { ...eventBody(w.club.id), allDay: true, startTime: null, durationMinutes: null, allDayDays: 2, startDate: d, submit: true });
    expect(res.status).toBe(201);
    const occ = await w.admin.get(`/api/occurrences/${res.body.firstOccurrenceId}`);
    expect(occ.body).toMatchObject({ allDay: true, allDayStart: d });
    expect(occ.body.allDayEnd > d).toBe(true);
    const withRoom = await w.admin.post("/api/series", { ...eventBody(w.club.id), allDay: true, startTime: null, durationMinutes: null, allDayDays: 1, roomId: (await makeRoom(ctx.db)).id });
    expect(withRoom.status).toBe(400);
  });

  it("untrusted titles are stored and returned verbatim as data", async () => {
    const w = await orgWorld();
    const title = `<img src=x onerror="alert(1)"> & <script>alert("x")</script>`;
    const res = await w.admin.post("/api/series", eventBody(w.club.id, { title, submit: true }));
    const occ = await w.admin.get(`/api/occurrences/${res.body.firstOccurrenceId}`);
    expect(occ.headers["content-type"]).toMatch(/application\/json/);
    expect(occ.body.title).toBe(title);
  });
});
