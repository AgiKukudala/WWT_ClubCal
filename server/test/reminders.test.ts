import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Mailer } from "../src/lib/mailer.js";
import { deliverReminder, dispatchDueReminders, recordEmailFailure, sendNotificationEmail } from "../src/modules/reminders/worker.js";
import { createBoss } from "../src/queue/boss.js";
import { startWorker } from "../src/worker.js";
import { type Ctx, eventBody, login, makeClub, makeUser, resetDb, setupCtx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(() => ctx.close());
beforeEach(() => resetDb(ctx.db));

/** An approved event starting `hoursAhead` from now, with one student going. */
async function eventWithAttendee(hoursAhead: number) {
  const admin = await makeUser(ctx.db, "admin");
  const student = await makeUser(ctx.db);
  const club = await makeClub(ctx.db);
  const a = await login(ctx.app, admin.email);
  const start = new Date(Math.ceil((Date.now() + hoursAhead * 3600_000) / 900_000) * 900_000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(fmt.formatToParts(start).map((p) => [p.type, p.value]));
  const res = await a.post("/api/series", eventBody(club.id, { startDate: `${parts.year}-${parts.month}-${parts.day}`, startTime: `${parts.hour}:${parts.minute}`, submit: true }));
  expect(res.status).toBe(201);
  const s = await login(ctx.app, student.email);
  await s.put(`/api/occurrences/${res.body.firstOccurrenceId}/rsvp`, { response: "going" }).expect(200);
  return { admin: a, student, studentSession: s, occurrenceId: res.body.firstOccurrenceId as string, seriesId: res.body.seriesId as string, start };
}

const reminderRows = (occurrenceId: string) =>
  ctx.db.selectFrom("reminders").selectAll().where("occurrence_id", "=", occurrenceId).orderBy("offset_minutes").orderBy("created_at").execute();
const notificationsFor = (userId: string, kind = "reminder") =>
  ctx.db.selectFrom("notifications").selectAll().where("user_id", "=", userId).where("kind", "=", kind).execute();

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out waiting; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("reminder scheduling", () => {
  it("schedules 24h and 1h reminders durably and respects preferences", async () => {
    const { student, studentSession, occurrenceId, start } = await eventWithAttendee(48);
    let rows = await reminderRows(occurrenceId);
    expect(rows.map((r) => [r.offset_minutes, r.status])).toEqual([[60, "scheduled"], [1440, "scheduled"]]);
    expect(rows[0]!.due_at.getTime()).toBe(start.getTime() - 3600_000);
    await studentSession.patch("/api/me", { remind24h: false }).expect(200);
    rows = await reminderRows(occurrenceId);
    expect(rows.map((r) => [r.offset_minutes, r.status])).toEqual([[60, "scheduled"], [1440, "obsolete"]]);
    await studentSession.patch("/api/me", { remind24h: true }).expect(200);
    rows = await reminderRows(occurrenceId);
    expect(rows.map((r) => r.status)).toEqual(["scheduled", "scheduled"]);
    expect(student.id).toBeTruthy();
  });

  it("does not schedule reminders whose time already passed", async () => {
    const { occurrenceId } = await eventWithAttendee(3);
    const rows = await reminderRows(occurrenceId);
    expect(rows.map((r) => r.offset_minutes)).toEqual([60]);
  });
});

describe("reminder delivery", () => {
  it("survives a worker restart: jobs enqueued while no worker runs are delivered exactly once later", async () => {
    const { student, occurrenceId, start } = await eventWithAttendee(3);
    const dueNow = new Date(start.getTime() - 59 * 60_000);

    // "Worker A" dispatches the due reminder, then dies before processing it.
    const bossA = createBoss("worker");
    await bossA.start();
    const { bossQueue } = await import("../src/queue/boss.js");
    expect(await dispatchDueReminders(ctx.db, bossQueue(bossA), dueNow)).toBe(1);
    await bossA.stop({ graceful: false });
    const [queued] = await reminderRows(occurrenceId);
    expect(queued!.status).toBe("queued");
    const job = await sql<{ state: string }>`SELECT state FROM pgboss.job WHERE id::text = ${queued!.job_id}`.execute(ctx.db);
    expect(job.rows[0]!.state).toBe("created");
    expect(await notificationsFor(student.id)).toHaveLength(0);

    // Dispatching again (e.g. a second worker) does not duplicate the job.
    expect(await dispatchDueReminders(ctx.db, ctx.queue, dueNow)).toBe(0);

    // "Worker B" starts later, finds the persisted job and delivers it.
    const bossB = createBoss("worker");
    await bossB.start();
    const worker = await startWorker({ db: ctx.db, boss: bossB, loop: false });
    try {
      const rows = await waitFor(() => reminderRows(occurrenceId), (r) => r[0]!.status === "sent");
      expect(rows[0]!.status).toBe("sent");
      const notes = await notificationsFor(student.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.dedupe_key).toBe(`reminder:${queued!.id}`);
      expect(notes[0]!.title).toMatch(/Starting in 1 hour/);
    } finally {
      await worker.stop();
      await bossB.stop({ graceful: false });
    }
  });

  it("redelivery after a crash never duplicates the in-app notification", async () => {
    const { student, occurrenceId, start } = await eventWithAttendee(3);
    const [r] = await reminderRows(occurrenceId);
    const at = new Date(start.getTime() - 59 * 60_000);
    // Simulate: first attempt committed the notification but the job was retried anyway.
    expect(await deliverReminder(ctx.db, ctx.queue, r!.id, at)).toBe("sent");
    await ctx.db.updateTable("reminders").set({ status: "queued" }).where("id", "=", r!.id).execute();
    expect(await deliverReminder(ctx.db, ctx.queue, r!.id, at)).toBe("sent");
    expect(await deliverReminder(ctx.db, ctx.queue, r!.id, at)).toBe("noop");
    expect(await notificationsFor(student.id)).toHaveLength(1);
  });

  it("an edited event never produces the obsolete reminder", async () => {
    const { admin, student, occurrenceId, seriesId, start } = await eventWithAttendee(3);
    const [old] = await reminderRows(occurrenceId);
    const oldDue = new Date(start.getTime() - 59 * 60_000);
    await dispatchDueReminders(ctx.db, ctx.queue, oldDue); // already queued when the edit happens
    const series = (await admin.get(`/api/series/${seriesId}`)).body;
    const res = await admin.put(`/api/series/${seriesId}`, {
      ...eventBody(series.clubId), startDate: series.startDate, startTime: series.startTime, durationMinutes: 90,
      expectedVersion: series.version,
    });
    expect(res.status).toBe(200);
    // A duration-only change keeps the start time, so the queued reminder stays valid.
    expect((await reminderRows(occurrenceId)).find((r) => r.id === old!.id)!.status).toBe("queued");

    // Move this occurrence one hour later (explicit local date + time, safe across midnight).
    const later = new Date(start.getTime() + 3600_000);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(later)
        .map((p) => [p.type, p.value]),
    );
    const occ = (await admin.get(`/api/occurrences/${occurrenceId}`)).body;
    const moved = await admin.patch(`/api/occurrences/${occurrenceId}`, {
      expectedVersion: occ.occurrenceVersion, date: `${parts.year}-${parts.month}-${parts.day}`, startTime: `${parts.hour}:${parts.minute}`,
      durationMinutes: 90, roomId: null, capacity: null,
    });
    expect(moved.status).toBe(200);
    const rows = await reminderRows(occurrenceId);
    const oldRow = rows.find((r) => r.id === old!.id)!;
    expect(oldRow.status).toBe("obsolete");
    const fresh = rows.filter((r) => r.status === "scheduled");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.event_starts_at.getTime()).toBe(later.getTime());

    // The already-queued job for the old time is a no-op.
    expect(await deliverReminder(ctx.db, ctx.queue, old!.id, oldDue)).toBe("noop");
    // Even if it had not been marked obsolete, the start-time recheck would stop it.
    await ctx.db.updateTable("reminders").set({ status: "queued" }).where("id", "=", old!.id).execute();
    expect(await deliverReminder(ctx.db, ctx.queue, old!.id, oldDue)).toBe("obsolete");
    const again = await ctx.db.selectFrom("reminders").select("last_error").where("id", "=", old!.id).executeTakeFirstOrThrow();
    expect(again.last_error).toBe("event time changed");
    expect(await notificationsFor(student.id)).toHaveLength(0);
  });

  it("a cancelled event or a withdrawn RSVP produces no reminder", async () => {
    const e1 = await eventWithAttendee(3);
    const [r1] = await reminderRows(e1.occurrenceId);
    await e1.admin.post(`/api/occurrences/${e1.occurrenceId}/cancel`, { scope: "occurrence" }).expect(200);
    expect((await reminderRows(e1.occurrenceId))[0]!.status).toBe("obsolete");
    await ctx.db.updateTable("reminders").set({ status: "queued" }).where("id", "=", r1!.id).execute();
    expect(await deliverReminder(ctx.db, ctx.queue, r1!.id, new Date(e1.start.getTime() - 59 * 60_000))).toBe("obsolete");
    expect(await notificationsFor(e1.student.id)).toHaveLength(0);

    const e2 = await eventWithAttendee(4);
    await e2.studentSession.put(`/api/occurrences/${e2.occurrenceId}/rsvp`, { response: "not_going" }).expect(200);
    const due = new Date(e2.start.getTime() - 59 * 60_000);
    expect(await dispatchDueReminders(ctx.db, ctx.queue, due)).toBe(0);
    expect(await notificationsFor(e2.student.id)).toHaveLength(0);
  });

  it("skips reminders that could not be delivered before the event started", async () => {
    const { student, occurrenceId, start } = await eventWithAttendee(3);
    const [r] = await reminderRows(occurrenceId);
    expect(await deliverReminder(ctx.db, ctx.queue, r!.id, new Date(start.getTime() + 60_000))).toBe("skipped");
    expect(await notificationsFor(student.id)).toHaveLength(0);
  });
});

describe("email delivery", () => {
  it("is at-least-once with visible failures, and skips users who opted out", async () => {
    const { student } = await eventWithAttendee(3);
    const n = await ctx.db
      .insertInto("notifications")
      .values({ user_id: student.id, kind: "test", title: "Hello", body: "World", dedupe_key: "test:1", email_status: "pending" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.db.updateTable("users").set({ email_notifications: true }).where("id", "=", student.id).execute();
    const sent: string[] = [];
    let fail = true;
    const mailer: Mailer = {
      async send(m) {
        if (fail) throw new Error("SMTP 451 temporary failure");
        sent.push(m.to);
      },
    };
    await expect(sendNotificationEmail(ctx.db, mailer, n.id, "http://x")).rejects.toThrow(/451/);
    await recordEmailFailure(ctx.db, n.id, "SMTP 451 temporary failure", false);
    let row = await ctx.db.selectFrom("notifications").selectAll().where("id", "=", n.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ email_status: "pending", email_attempts: 1, email_last_error: "SMTP 451 temporary failure" });
    fail = false;
    expect(await sendNotificationEmail(ctx.db, mailer, n.id, "http://x")).toBe("sent");
    expect(await sendNotificationEmail(ctx.db, mailer, n.id, "http://x")).toBe("noop");
    expect(sent).toEqual([student.email]);
    row = await ctx.db.selectFrom("notifications").selectAll().where("id", "=", n.id).executeTakeFirstOrThrow();
    expect(row.email_status).toBe("sent");

    const n2 = await ctx.db
      .insertInto("notifications")
      .values({ user_id: student.id, kind: "test", title: "Again", dedupe_key: "test:2", email_status: "pending" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.db.updateTable("users").set({ email_notifications: false }).where("id", "=", student.id).execute();
    expect(await sendNotificationEmail(ctx.db, mailer, n2.id, "http://x")).toBe("noop");
    expect(sent).toHaveLength(1);
  });
});
