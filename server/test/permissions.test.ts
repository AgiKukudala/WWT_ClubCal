import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Ctx, eventBody, login, makeClub, makeUser, range, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

async function world() {
  const admin = await makeUser(ctx.db, "admin");
  const orgA = await makeUser(ctx.db, "organizer");
  const orgB = await makeUser(ctx.db, "organizer");
  const member = await makeUser(ctx.db, "student");
  const outsider = await makeUser(ctx.db, "student");
  const clubA = await makeClub(ctx.db, "Club A");
  const clubB = await makeClub(ctx.db, "Club B");
  await addMember(ctx.db, clubA.id, orgA.id, "organizer");
  await addMember(ctx.db, clubB.id, orgB.id, "organizer");
  await addMember(ctx.db, clubA.id, member.id);
  return { admin, orgA, orgB, member, outsider, clubA, clubB };
}

describe("organizer scope", () => {
  it("an organizer cannot create, edit, cancel or submit another club's events, even by direct ID", async () => {
    const w = await world();
    const a = await login(ctx.app, w.orgA.email);
    const b = await login(ctx.app, w.orgB.email);
    const admin = await login(ctx.app, w.admin.email);

    expect((await b.post("/api/series", eventBody(w.clubA.id))).status).toBe(403);

    const created = await a.post("/api/series", eventBody(w.clubA.id, { submit: true }));
    expect(created.status).toBe(201);
    const { seriesId, firstOccurrenceId } = created.body;
    const s = await admin.get(`/api/series/${seriesId}`);
    await admin.post(`/api/series/${seriesId}/review`, { decision: "approve", expectedVersion: s.body.version }).expect(200);
    const approved = await a.get(`/api/series/${seriesId}`);

    const put = await b.put(`/api/series/${seriesId}`, { ...eventBody(w.clubA.id), title: "hijacked", expectedVersion: approved.body.version });
    expect(put.status).toBe(403);
    const occ = await b.get(`/api/occurrences/${firstOccurrenceId}`);
    expect(occ.status).toBe(200); // public events are readable…
    expect(occ.body.canManage).toBe(false); // …but not manageable
    const patch = await b.patch(`/api/occurrences/${firstOccurrenceId}`, {
      expectedVersion: occ.body.occurrenceVersion, date: approved.body.startDate, startTime: "16:00", durationMinutes: 60, roomId: null, capacity: null,
    });
    expect(patch.status).toBe(403);
    expect((await b.post(`/api/occurrences/${firstOccurrenceId}/cancel`, { scope: "series" })).status).toBe(403);
    expect((await b.get(`/api/occurrences/${firstOccurrenceId}/attendees`)).status).toBe(403);
    expect((await b.get(`/api/series/${seriesId}/audit`)).status).toBe(403);
    expect((await b.del(`/api/series/${seriesId}`)).status).toBe(403);
    // Organizers cannot approve anything.
    expect((await a.post(`/api/series/${seriesId}/review`, { decision: "approve", expectedVersion: approved.body.version })).status).toBe(403);

    const title = await ctx.db.selectFrom("event_series").select("title").where("id", "=", seriesId).executeTakeFirstOrThrow();
    expect(title.title).toBe("Test meeting");
  });

  it("an organizer's drafts in another club are invisible (404), not just forbidden", async () => {
    const w = await world();
    const a = await login(ctx.app, w.orgA.email);
    const b = await login(ctx.app, w.orgB.email);
    const created = await a.post("/api/series", eventBody(w.clubA.id));
    expect((await b.get(`/api/series/${created.body.seriesId}`)).status).toBe(404);
    expect((await b.get(`/api/occurrences/${created.body.firstOccurrenceId}`)).status).toBe(404);
    expect((await b.post(`/api/series/${created.body.seriesId}/submit`, { expectedVersion: 1 })).status).toBe(404);
  });
});

describe("event visibility", () => {
  it("club-only and unpublished events are hidden from users who may not see them", async () => {
    const w = await world();
    const admin = await login(ctx.app, w.admin.email);
    const org = await login(ctx.app, w.orgA.email);
    const clubOnly = await admin.post("/api/series", eventBody(w.clubA.id, { title: "Members only", visibility: "club", submit: true }));
    const draft = await org.post("/api/series", eventBody(w.clubA.id, { title: "Secret draft", startTime: "17:00" }));
    const pending = await org.post("/api/series", eventBody(w.clubA.id, { title: "Pending thing", startTime: "18:00", submit: true }));
    const pub = await admin.post("/api/series", eventBody(w.clubA.id, { title: "Open house", startTime: "12:00", submit: true }));
    expect(clubOnly.body.status).toBe("approved");

    const outsider = await login(ctx.app, w.outsider.email);
    const member = await login(ctx.app, w.member.email);
    const q = new URLSearchParams(range()).toString();

    const outsiderList = await outsider.get(`/api/occurrences?${q}`);
    expect(outsiderList.body.items.map((i: { title: string }) => i.title)).toEqual(["Open house"]);
    expect((await outsider.get(`/api/occurrences/${clubOnly.body.firstOccurrenceId}`)).status).toBe(404);
    expect((await outsider.get(`/api/occurrences/${draft.body.firstOccurrenceId}`)).status).toBe(404);
    expect((await outsider.get(`/api/series/${pending.body.seriesId}`)).status).toBe(404);
    expect((await outsider.put(`/api/occurrences/${clubOnly.body.firstOccurrenceId}/rsvp`, { response: "going" })).status).toBe(404);
    expect((await outsider.get(`/api/occurrences/${clubOnly.body.firstOccurrenceId}/ics`)).status).toBe(404);
    const ics = await outsider.get(`/api/calendar.ics?${q}`);
    expect(ics.status).toBe(200);
    expect(ics.text).toContain("Open house");
    expect(ics.text).not.toContain("Members only");

    const memberList = await member.get(`/api/occurrences?${q}`);
    expect(memberList.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["Members only", "Open house"]);
    expect((await member.get(`/api/occurrences/${draft.body.firstOccurrenceId}`)).status).toBe(404);

    const orgList = await org.get(`/api/occurrences?${q}`);
    expect(orgList.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["Members only", "Open house", "Pending thing"]);
    const orgDrafts = await org.get(`/api/occurrences?${q}&status=draft`);
    expect(orgDrafts.body.items.map((i: { title: string }) => i.title)).toEqual(["Secret draft"]);
    expect(pub.status).toBe(201);
  });

  it("separate browser sessions see the same persisted calendar", async () => {
    const w = await world();
    const orgSession = await login(ctx.app, w.orgA.email);
    const adminSession = await login(ctx.app, w.admin.email);
    const studentSession1 = await login(ctx.app, w.outsider.email);
    const studentSession2 = await login(ctx.app, w.outsider.email); // same user, second device
    const created = await orgSession.post("/api/series", eventBody(w.clubA.id, { title: "Shared calendar event", submit: true }));
    const series = await adminSession.get(`/api/series/${created.body.seriesId}`);
    await adminSession.post(`/api/series/${created.body.seriesId}/review`, { decision: "approve", expectedVersion: series.body.version }).expect(200);
    const q = new URLSearchParams(range()).toString();
    const [l1, l2] = await Promise.all([studentSession1.get(`/api/occurrences?${q}`), studentSession2.get(`/api/occurrences?${q}`)]);
    expect(l1.body.items.map((i: { id: string }) => i.id)).toEqual([created.body.firstOccurrenceId]);
    expect(l2.body.items).toEqual(l1.body.items);
    await studentSession1.put(`/api/occurrences/${created.body.firstOccurrenceId}/rsvp`, { response: "going" }).expect(200);
    const fromOtherDevice = await studentSession2.get(`/api/occurrences/${created.body.firstOccurrenceId}`);
    expect(fromOtherDevice.body.myRsvp).toBe("going");
  });

  it("leaving a club releases spots at its club-only events", async () => {
    const w = await world();
    const admin = await login(ctx.app, w.admin.email);
    const ev = await admin.post("/api/series", eventBody(w.clubA.id, { visibility: "club", capacity: 1, submit: true }));
    const other = await makeUser(ctx.db);
    await addMember(ctx.db, w.clubA.id, other.id);
    const m = await login(ctx.app, w.member.email);
    const o = await login(ctx.app, other.email);
    await m.put(`/api/occurrences/${ev.body.firstOccurrenceId}/rsvp`, { response: "going" }).expect(200);
    const wait = await o.put(`/api/occurrences/${ev.body.firstOccurrenceId}/rsvp`, { response: "going" });
    expect(wait.body.status).toBe("waitlisted");
    await m.post(`/api/clubs/${w.clubA.id}/leave`).expect(200);
    const after = await o.get(`/api/occurrences/${ev.body.firstOccurrenceId}`);
    expect(after.body.myRsvp).toBe("going");
    expect((await m.get(`/api/occurrences/${ev.body.firstOccurrenceId}`)).status).toBe(404);
  });
});
