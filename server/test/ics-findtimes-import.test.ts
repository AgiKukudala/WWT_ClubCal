import ICAL from "ical.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeText, foldLine } from "../src/lib/ics.js";
import { addMember, type Ctx, eventBody, futureDate, login, makeClub, makeRoom, makeUser, range, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

describe("ics helpers", () => {
  it("escapes text per RFC 5545", () => {
    expect(escapeText("a,b;c\\d\nnext")).toBe("a\\,b\\;c\\\\d\\nnext");
  });
  it("folds long lines at 75 octets without splitting UTF-8", () => {
    const line = `SUMMARY:${"é".repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n")) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n ").join("")).toBe(line);
  });
});

describe(".ics export", () => {
  it("exports parseable, correctly timed events with stable UIDs", async () => {
    const admin = await makeUser(ctx.db, "admin");
    const club = await makeClub(ctx.db, "Chess, Go; & More");
    const room = await makeRoom(ctx.db);
    const a = await login(ctx.app, admin.email);
    const title = "Finals, round 1; bring boards\\pieces";
    const res = await a.post("/api/series", eventBody(club.id, {
      title, description: "Line one\nLine two", startDate: "2026-11-02", startTime: "15:30", durationMinutes: 90, roomId: room.id, submit: true,
    }));
    const allDay = await a.post("/api/series", { ...eventBody(club.id), title: "Field day", allDay: true, startTime: null, durationMinutes: null, allDayDays: 2, startDate: futureDate(20), submit: true });

    const one = await a.get(`/api/occurrences/${res.body.firstOccurrenceId}/ics`);
    expect(one.status).toBe(200);
    expect(one.headers["content-type"]).toMatch(/text\/calendar/);
    expect(one.headers["content-disposition"]).toMatch(/attachment; filename=".+\.ics"/);
    expect(one.text).toMatch(/\r\n/);
    const comp = new ICAL.Component(ICAL.parse(one.text));
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const ev = new ICAL.Event(vevent);
    expect(ev.uid).toBe(`occurrence-${res.body.firstOccurrenceId}@localhost`);
    expect(ev.summary).toBe(title);
    expect(ev.description).toContain("Line one\nLine two");
    expect(ev.startDate.toJSDate().toISOString()).toBe("2026-11-02T21:30:00.000Z"); // 15:30 CST (after DST ends)
    expect(ev.endDate.toJSDate().toISOString()).toBe("2026-11-02T23:00:00.000Z");
    expect(vevent.getFirstPropertyValue("status")).toBe("CONFIRMED");
    expect(String(vevent.getFirstPropertyValue("dtstamp"))).toBeTruthy();

    const again = await a.get(`/api/occurrences/${res.body.firstOccurrenceId}/ics`);
    expect(new ICAL.Event(new ICAL.Component(ICAL.parse(again.text)).getFirstSubcomponent("vevent")!).uid).toBe(ev.uid);

    await a.post(`/api/occurrences/${res.body.firstOccurrenceId}/cancel`, { scope: "occurrence" }).expect(200);
    const q = new URLSearchParams({ from: "2026-09-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }).toString();
    const cal = await a.get(`/api/calendar.ics?${q}`);
    const all = new ICAL.Component(ICAL.parse(cal.text)).getAllSubcomponents("vevent");
    const byUid = Object.fromEntries(all.map((v) => [String(v.getFirstPropertyValue("uid")), v]));
    const cancelled = byUid[ev.uid]!;
    expect(cancelled.getFirstPropertyValue("status")).toBe("CANCELLED");
    expect(Number(cancelled.getFirstPropertyValue("sequence"))).toBeGreaterThan(0);
    const fieldDay = all.find((v) => v.getFirstPropertyValue("summary") === "Field day")!;
    const dtstart = fieldDay.getFirstProperty("dtstart")!;
    expect(dtstart.type).toBe("date");
    expect(String(dtstart.getFirstValue())).toBe(futureDate(20));
    expect(allDay.status).toBe(201);
  });

  it("personal export only contains the requester's RSVPs and never drafts", async () => {
    const admin = await makeUser(ctx.db, "admin");
    const org = await makeUser(ctx.db, "organizer");
    const club = await makeClub(ctx.db);
    await addMember(ctx.db, club.id, org.id, "organizer");
    const a = await login(ctx.app, admin.email);
    const o = await login(ctx.app, org.email);
    const e1 = await a.post("/api/series", eventBody(club.id, { title: "Going to this", submit: true }));
    await a.post("/api/series", eventBody(club.id, { title: "Not going", startTime: "10:00", submit: true }));
    await o.post("/api/series", eventBody(club.id, { title: "Draft idea", startTime: "11:00" }));
    const student = await makeUser(ctx.db);
    const s = await login(ctx.app, student.email);
    await s.put(`/api/occurrences/${e1.body.firstOccurrenceId}/rsvp`, { response: "going" }).expect(200);
    const q = new URLSearchParams(range()).toString();
    const mine = await s.get(`/api/calendar.ics?${q}&mine=true`);
    const titles = new ICAL.Component(ICAL.parse(mine.text)).getAllSubcomponents("vevent").map((v) => v.getFirstPropertyValue("summary"));
    expect(titles).toEqual(["Going to this"]);
    const orgAll = await o.get(`/api/calendar.ics?${q}`);
    expect(orgAll.text).not.toContain("Draft idea");
  });
});

describe("find available times", () => {
  async function setup() {
    const org = await makeUser(ctx.db, "organizer");
    const club = await makeClub(ctx.db);
    await addMember(ctx.db, club.id, org.id, "organizer");
    const p1 = await makeUser(ctx.db, "student", "Avail Ann");
    const p2 = await makeUser(ctx.db, "student", "Unknown Uma");
    const stranger = await makeUser(ctx.db, "student", "Stranger");
    await addMember(ctx.db, club.id, p1.id);
    await addMember(ctx.db, club.id, p2.id);
    return { org, club, p1, p2, stranger, s: await login(ctx.app, org.email) };
  }

  it("excludes booked rooms and unavailable participants, labels unknown availability, and ranks deterministically", async () => {
    const { club, p1, p2, s } = await setup();
    // A Monday a few weeks out.
    let offset = 14;
    while (new Date(`${futureDate(offset)}T12:00:00Z`).getUTCDay() !== 1) offset++;
    const day = futureDate(offset);
    const small = await makeRoom(ctx.db, 12, [{ weekday: 1, opens: "15:00", closes: "17:00" }]);
    const big = await makeRoom(ctx.db, 200, [{ weekday: 1, opens: "15:00", closes: "17:00" }]);
    await ctx.db.insertInto("user_availability").values({ user_id: p1.id, weekday: 1, start_time: "15:00", end_time: "16:30" }).execute();
    const admin = await login(ctx.app, (await makeUser(ctx.db, "admin")).email);
    await admin.post("/api/series", eventBody(club.id, { startDate: day, startTime: "15:00", durationMinutes: 30, roomId: small.id, submit: true })).expect(201);

    const body = { durationMinutes: 60, from: day, to: day, timezone: "America/Chicago", minCapacity: 10, participantIds: [p1.id, p2.id], roomIds: [small.id, big.id] };
    const res = await s.post("/api/scheduling/find-times", body);
    expect(res.status).toBe(200);
    const got = res.body.suggestions.map((x: { localStart: string; room: { id: string } }) => `${x.localStart}@${x.room.id === small.id ? "small" : "big"}`);
    // p1 is only available 15:00–16:30, so 60-minute slots may start 15:00–15:30.
    // Small room is booked 15:00–15:30. At most 3 per day are returned.
    expect(got).toEqual(["15:30@small", "15:00@big", "15:15@big"]);
    const top = res.body.suggestions[0];
    expect(top.score).toBe(100 - 15 - Math.round(20 * (2 / 12)));
    expect(top.unknownParticipants.map((u: { displayName: string }) => u.displayName)).toEqual(["Unknown Uma"]);
    expect(top.reasons.join(" ")).toMatch(/Availability unknown for Unknown Uma/);
    expect(top.reasons.join(" ")).toMatch(/seats 12/);
    expect(res.body.participantsWithoutAvailability).toHaveLength(1);
    expect(res.body.scoringRule).toMatch(/score = 100/);

    const again = await s.post("/api/scheduling/find-times", body);
    expect(again.body.suggestions).toEqual(res.body.suggestions);

    // Participants committed elsewhere are excluded.
    const busy = await admin.post("/api/series", eventBody(club.id, { startDate: day, startTime: "15:45", durationMinutes: 15, submit: true }));
    const p1s = await login(ctx.app, p1.email);
    await p1s.put(`/api/occurrences/${busy.body.firstOccurrenceId}/rsvp`, { response: "going" }).expect(200);
    const after = await s.post("/api/scheduling/find-times", body);
    expect(after.body.suggestions).toEqual([]);
  });

  it("only lets organizers probe members of their own clubs", async () => {
    const { s, stranger } = await setup();
    const res = await s.post("/api/scheduling/find-times", { durationMinutes: 60, from: futureDate(3), to: futureDate(4), timezone: "America/Chicago", participantIds: [stranger.id] });
    expect(res.status).toBe(400);
    const student = await login(ctx.app, stranger.email);
    expect((await student.post("/api/scheduling/find-times", { durationMinutes: 60, from: futureDate(3), to: futureDate(4), timezone: "America/Chicago" })).status).toBe(403);
  });
});

describe("legacy localStorage import", () => {
  const legacy = JSON.stringify([
    { day: 5, month: 10, year: 2026, events: [{ title: "Old <b>chess</b> meetup", time: "3:30 PM - 5:00 PM" }, { title: "Broken", time: "5:00 PM - 4:00 PM" }] },
    { day: 6, month: 10, year: 2026, events: [{ title: "Robotics", time: "12:00 PM - 1:15 PM" }, { title: "Robotics", time: "12:00 PM - 1:15 PM" }] },
  ]);

  it("previews, commits once, and refuses duplicate imports", async () => {
    const admin = await makeUser(ctx.db, "admin");
    const club = await makeClub(ctx.db);
    const a = await login(ctx.app, admin.email);
    const noTz = await a.post("/api/admin/import/preview", { clubId: club.id, json: legacy });
    expect(noTz.status).toBe(400);
    const preview = await a.post("/api/admin/import/preview", { clubId: club.id, timezone: "America/New_York", json: legacy });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ validCount: 2, invalidCount: 1, duplicateCount: 1, alreadyImported: false });
    expect(preview.body.rows.map((r: { status: string }) => r.status)).toEqual(["ok", "invalid", "ok", "duplicate"]);
    // Nothing is written by a preview.
    expect(await ctx.db.selectFrom("event_series").select("id").execute()).toHaveLength(0);

    const stale = await a.post("/api/admin/import/commit", { clubId: club.id, timezone: "America/New_York", json: legacy, fileSha256: "0".repeat(64) });
    expect(stale.status).toBe(409);
    const commit = await a.post("/api/admin/import/commit", { clubId: club.id, timezone: "America/New_York", json: legacy, fileSha256: preview.body.fileSha256 });
    expect(commit.status).toBe(201);
    expect(commit.body.imported).toBe(2);
    const occ = await ctx.db
      .selectFrom("event_occurrences as o")
      .innerJoin("event_series as s", "s.id", "o.series_id")
      .select(["s.title", "o.starts_at", "o.ends_at", "s.status"])
      .orderBy("o.starts_at")
      .execute();
    expect(occ.map((o) => [o.title, o.starts_at.toISOString(), o.ends_at.toISOString(), o.status])).toEqual([
      ["Old <b>chess</b> meetup", "2026-10-05T19:30:00.000Z", "2026-10-05T21:00:00.000Z", "approved"],
      ["Robotics", "2026-10-06T16:00:00.000Z", "2026-10-06T17:15:00.000Z", "approved"],
    ]);

    const again = await a.post("/api/admin/import/commit", { clubId: club.id, timezone: "America/New_York", json: legacy, fileSha256: preview.body.fileSha256 });
    expect(again.status).toBe(409);
    // A different file containing an already-imported row flags it as duplicate.
    const overlapping = JSON.stringify([{ day: 5, month: 10, year: 2026, events: [{ title: "old <B>CHESS</b> meetup", time: "3:30 PM - 5:00 PM" }] }]);
    const p2 = await a.post("/api/admin/import/preview", { clubId: club.id, timezone: "America/New_York", json: overlapping });
    expect(p2.body.rows[0]).toMatchObject({ status: "duplicate", problem: "Already imported earlier" });
    const audit = await ctx.db.selectFrom("audit_log").select("details").where("action", "=", "legacy.imported").executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ imported: 2, skippedInvalid: 1, skippedDuplicates: 1 });

    const org = await makeUser(ctx.db, "organizer");
    const o = await login(ctx.app, org.email);
    expect((await o.post("/api/admin/import/preview", { clubId: club.id, timezone: "UTC", json: legacy })).status).toBe(403);
  });
});
