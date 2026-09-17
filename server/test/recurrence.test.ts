import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { planSeries, resolveLocal, seriesDates } from "../src/lib/time.js";
import { type Ctx, eventBody, futureDate, login, makeClub, makeRoom, makeUser, resetDb, setupCtx } from "./helpers.js";

const TZ = "America/Chicago";
const localTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

describe("local time resolution (pure)", () => {
  it("resolves ordinary times exactly", () => {
    expect(resolveLocal("2026-07-01", "15:30", TZ)).toEqual({ instant: new Date("2026-07-01T20:30:00Z"), resolution: "exact" });
    expect(resolveLocal("2026-12-01", "15:30", TZ)).toEqual({ instant: new Date("2026-12-01T21:30:00Z"), resolution: "exact" });
  });

  it("shifts nonexistent spring-forward times forward by the gap", () => {
    // 2027-03-14 02:00 CST jumps to 03:00 CDT.
    const r = resolveLocal("2027-03-14", "02:30", TZ);
    expect(r.resolution).toBe("gap_shifted");
    expect(r.instant.toISOString()).toBe("2027-03-14T08:30:00.000Z");
    expect(localTime(r.instant.toISOString())).toBe("03:30");
  });

  it("chooses the earlier instant for ambiguous fall-back times", () => {
    // 2026-11-01 01:30 happens twice: 06:30Z (CDT) and 07:30Z (CST).
    const r = resolveLocal("2026-11-01", "01:30", TZ);
    expect(r.resolution).toBe("ambiguous_earlier");
    expect(r.instant.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("handles zones without DST and southern-hemisphere transitions", () => {
    expect(resolveLocal("2026-03-08", "02:30", "Asia/Tokyo").resolution).toBe("exact");
    // Sydney: clocks go forward 2026-10-04 02:00 -> 03:00.
    expect(resolveLocal("2026-10-04", "02:15", "Australia/Sydney").resolution).toBe("gap_shifted");
  });

  it("keeps the local meeting time across DST changes while UTC shifts", () => {
    const planned = planSeries({
      timezone: TZ, allDay: false, startDate: "2026-10-20", startTime: "15:30", durationMinutes: 60, allDayDays: null,
      recurrence: { weekdays: [2], until: "2026-11-10" },
    });
    expect(planned.map((p) => p.startsAt.toISOString())).toEqual([
      "2026-10-20T20:30:00.000Z",
      "2026-10-27T20:30:00.000Z",
      "2026-11-03T21:30:00.000Z",
      "2026-11-10T21:30:00.000Z",
    ]);
    expect(planned.every((p) => localTime(p.startsAt.toISOString()) === "15:30")).toBe(true);
    expect(planned.every((p) => p.endsAt.getTime() - p.startsAt.getTime() === 3600_000)).toBe(true);
  });

  it("uses elapsed duration for meetings spanning the transition", () => {
    const [p] = planSeries({
      timezone: TZ, allDay: false, startDate: "2026-11-01", startTime: "00:30", durationMinutes: 120, allDayDays: null, recurrence: null,
    });
    expect(p!.endsAt.toISOString()).toBe("2026-11-01T07:30:00.000Z"); // 01:30 CST local, two real hours later
  });

  it("generates only the selected weekdays within the bounded range", () => {
    expect(seriesDates({ startDate: "2026-09-01", recurrence: { weekdays: [1, 3], until: "2026-09-14" } })).toEqual([
      "2026-09-02", "2026-09-07", "2026-09-09", "2026-09-14",
    ]);
    expect(seriesDates({ startDate: "2026-09-01", recurrence: { weekdays: [1, 2, 3, 4, 5, 6, 7], until: "2027-08-31" } })).toHaveLength(365);
  });
});

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

async function admin() {
  const u = await makeUser(ctx.db, "admin");
  return { s: await login(ctx.app, u.email), club: await makeClub(ctx.db) };
}

describe("recurring series (database)", () => {
  it("materializes occurrences across the November DST change at the same local time", async () => {
    const { s, club } = await admin();
    const res = await s.post("/api/series", eventBody(club.id, {
      title: "Sunday early practice", startDate: "2026-10-25", startTime: "01:30", durationMinutes: 45,
      recurrence: { weekdays: [7], until: "2026-11-08" }, submit: true,
    }));
    expect(res.status).toBe(201);
    const occ = await s.get(`/api/series/${res.body.seriesId}/occurrences`);
    expect(occ.body.items.map((o: { startsAt: string }) => o.startsAt)).toEqual([
      "2026-10-25T06:30:00.000Z",
      "2026-11-01T06:30:00.000Z", // ambiguous 01:30 → earlier (CDT)
      "2026-11-08T07:30:00.000Z",
    ]);
    const audit = await ctx.db.selectFrom("audit_log").select("details").where("action", "=", "series.created").executeTakeFirstOrThrow();
    expect(audit.details.dstAdjusted).toEqual([{ date: "2026-11-01", resolution: "ambiguous_earlier" }]);
  });

  it("rejects series longer than one year", async () => {
    const { s, club } = await admin();
    const start = futureDate(3);
    const tooLong = await s.post("/api/series", eventBody(club.id, { startDate: start, recurrence: { weekdays: [1], until: futureDate(3 + 366) } }));
    expect(tooLong.status).toBe(400);
  });

  it("edits or cancels a single occurrence without touching the rest; RSVPs stay per occurrence", async () => {
    const { s, club } = await admin();
    const room = await makeRoom(ctx.db);
    const start = futureDate(20);
    const res = await s.post("/api/series", eventBody(club.id, {
      startDate: start, startTime: "15:00", roomId: room.id, capacity: 10,
      recurrence: { weekdays: [1, 2, 3, 4, 5, 6, 7], until: futureDate(23) }, submit: true,
    }));
    expect(res.body.occurrenceCount).toBe(4);
    const list = (await s.get(`/api/series/${res.body.seriesId}/occurrences`)).body.items as { id: string; occurrenceVersion: number; startsAt: string }[];
    const student = await makeUser(ctx.db);
    const st = await login(ctx.app, student.email);
    await st.put(`/api/occurrences/${list[1]!.id}/rsvp`, { response: "going" }).expect(200);

    const moved = await s.patch(`/api/occurrences/${list[1]!.id}`, {
      expectedVersion: list[1]!.occurrenceVersion, date: futureDate(21), startTime: "17:00", durationMinutes: 60, roomId: room.id, capacity: 10,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.isException).toBe(true);
    expect(localTime(moved.body.startsAt)).toBe("17:00");
    const after = (await s.get(`/api/series/${res.body.seriesId}/occurrences`)).body.items as { id: string; startsAt: string }[];
    expect(after.filter((o) => localTime(o.startsAt) === "15:00")).toHaveLength(3);

    await s.post(`/api/occurrences/${list[2]!.id}/cancel`, { scope: "occurrence", reason: "Assembly" }).expect(200);
    const statuses = (await s.get(`/api/series/${res.body.seriesId}/occurrences`)).body.items.map((o: { status: string }) => o.status);
    expect(statuses).toEqual(["approved", "approved", "cancelled", "approved"]);
    // RSVPs are tied to the individual occurrence.
    expect((await st.get(`/api/occurrences/${list[1]!.id}`)).body.myRsvp).toBe("going");
    expect((await st.get(`/api/occurrences/${list[0]!.id}`)).body.myRsvp).toBeNull();
    const reminders = await ctx.db.selectFrom("reminders").select("occurrence_id").where("status", "=", "scheduled").execute();
    expect(new Set(reminders.map((r) => r.occurrence_id))).toEqual(new Set([list[1]!.id]));
  });

  it("whole-series edits revalidate every booking and apply nothing if any occurrence conflicts", async () => {
    const { s, club } = await admin();
    const room = await makeRoom(ctx.db);
    const start = futureDate(30);
    const res = await s.post("/api/series", eventBody(club.id, {
      title: "Daily", startDate: start, startTime: "09:00", roomId: room.id,
      recurrence: { weekdays: [1, 2, 3, 4, 5, 6, 7], until: futureDate(34) }, submit: true,
    }));
    expect(res.body.occurrenceCount).toBe(5);
    // Another event occupies 11:00 on the 3rd day.
    await s.post("/api/series", eventBody(club.id, { title: "Blocker", startDate: futureDate(32), startTime: "11:00", roomId: room.id, submit: true })).expect(201);
    const series = (await s.get(`/api/series/${res.body.seriesId}`)).body;
    const move = await s.put(`/api/series/${res.body.seriesId}`, {
      ...eventBody(club.id), title: "Daily", startDate: start, startTime: "10:30", durationMinutes: 60, roomId: room.id,
      capacity: series.capacity, recurrence: series.recurrence, expectedVersion: series.version,
    });
    expect(move.status).toBe(409);
    expect(move.body.error.conflicts.map((c: { date: string }) => c.date)).toEqual([futureDate(32)]);
    const times = (await s.get(`/api/series/${res.body.seriesId}/occurrences`)).body.items.map((o: { startsAt: string }) => localTime(o.startsAt));
    expect(times).toEqual(["09:00", "09:00", "09:00", "09:00", "09:00"]);
    const unchanged = (await s.get(`/api/series/${res.body.seriesId}`)).body;
    expect(unchanged.version).toBe(series.version);
  });

  it("shrinking a series cancels dropped dates that have responses and deletes the rest", async () => {
    const { s, club } = await admin();
    const start = futureDate(40);
    const res = await s.post("/api/series", eventBody(club.id, {
      startDate: start, recurrence: { weekdays: [1, 2, 3, 4, 5, 6, 7], until: futureDate(43) }, submit: true,
    }));
    const list = (await s.get(`/api/series/${res.body.seriesId}/occurrences`)).body.items as { id: string }[];
    const student = await makeUser(ctx.db);
    const st = await login(ctx.app, student.email);
    await st.put(`/api/occurrences/${list[3]!.id}/rsvp`, { response: "going" }).expect(200);
    const series = (await s.get(`/api/series/${res.body.seriesId}`)).body;
    const shrink = await s.put(`/api/series/${res.body.seriesId}`, {
      ...eventBody(club.id), startDate: start, startTime: "15:00", durationMinutes: 60,
      recurrence: { weekdays: series.recurrence.weekdays, until: futureDate(41) }, expectedVersion: series.version,
    });
    expect(shrink.status).toBe(200);
    const after = (await s.get(`/api/series/${res.body.seriesId}/occurrences`)).body.items as { id: string; status: string }[];
    expect(after.map((o) => o.status)).toEqual(["approved", "approved", "cancelled"]);
    expect(after[2]!.id).toBe(list[3]!.id);
    const note = await ctx.db.selectFrom("notifications").select("kind").where("user_id", "=", student.id).executeTakeFirstOrThrow();
    expect(note.kind).toBe("event.cancelled");
  });
});
