import { sql } from "kysely";
import { buildActor } from "../auth/middleware.js";
import { hashPassword } from "../auth/passwords.js";
import type { Db } from "../db/index.js";
import { addDays, isoWeekday, todayIn } from "../lib/time.js";
import type { JobQueue } from "../queue/boss.js";
import { cancelEvent, createEvent, reviewSeries } from "../modules/events/service.js";
import { setRsvp } from "../modules/rsvps/rsvps.js";

/** Development-only credentials. The seed refuses to run when NODE_ENV=production. */
export const DEMO_PASSWORD = "clubcal-demo-password";
export const DEMO_TZ = "America/Chicago";
export const DEMO_USERS = {
  admin: { email: "admin@demo.clubcal.test", name: "Avery Admin (demo)", role: "admin" },
  rivera: { email: "rivera@demo.clubcal.test", name: "Ms. Rivera (demo organizer)", role: "organizer" },
  patel: { email: "patel@demo.clubcal.test", name: "Mr. Patel (demo organizer)", role: "organizer" },
  sam: { email: "sam@demo.clubcal.test", name: "Sam Student (demo)", role: "student" },
  jordan: { email: "jordan@demo.clubcal.test", name: "Jordan Lee (demo)", role: "student" },
  alex: { email: "alex@demo.clubcal.test", name: "Alex Kim (demo)", role: "student" },
  priya: { email: "priya@demo.clubcal.test", name: "Priya N. (demo)", role: "student" },
} as const;

const SYNTHETIC = "Synthetic demo data — not a real school event.";

export async function hasDemoData(db: Db) {
  return Boolean(await db.selectFrom("users").select("id").where("is_demo", "=", true).limit(1).executeTakeFirst());
}

/** Deletes only rows flagged as demo data (and everything that hangs off them). */
export async function removeDemoData(db: Db) {
  await db.transaction().execute(async (tx) => {
    const demoClubs = tx.selectFrom("clubs").select("id").where("is_demo", "=", true);
    await tx.deleteFrom("event_series").where((eb) => eb.or([eb("club_id", "in", demoClubs), eb("is_demo", "=", true)])).execute();
    await tx.deleteFrom("legacy_imports").where("club_id", "in", demoClubs).execute();
    await tx.deleteFrom("room_hours").where("room_id", "in", tx.selectFrom("rooms").select("id").where("is_demo", "=", true)).execute();
    await tx.deleteFrom("rooms").where("is_demo", "=", true).execute();
    await tx.deleteFrom("clubs").where("is_demo", "=", true).execute();
    const demoUsers = tx.selectFrom("users").select("id").where("is_demo", "=", true);
    await tx.updateTable("audit_log").set({ actor_id: null }).where("actor_id", "in", demoUsers).execute();
    await tx.deleteFrom("users").where("is_demo", "=", true).execute();
  });
}

export async function seedDemo(db: Db, queue: JobQueue, now = new Date()) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ids: Record<keyof typeof DEMO_USERS, string> = {} as never;
  for (const [key, u] of Object.entries(DEMO_USERS) as [keyof typeof DEMO_USERS, (typeof DEMO_USERS)[keyof typeof DEMO_USERS]][]) {
    const row = await db
      .insertInto("users")
      .values({ email: u.email, display_name: u.name, password_hash: passwordHash, role: u.role, timezone: DEMO_TZ, is_demo: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids[key] = row.id;
  }

  const clubDefs = [
    { slug: "robotics", name: "Robotics Club (demo)", category: "STEM", color: "#2563eb", description: `Build and program robots for regional competitions. ${SYNTHETIC}` },
    { slug: "chess", name: "Chess Club (demo)", category: "Games", color: "#7c3aed", description: `Casual and competitive chess for all levels. ${SYNTHETIC}` },
    { slug: "drama", name: "Drama Society (demo)", category: "Arts", color: "#db2777", description: `Stage productions, improv and technical theatre. ${SYNTHETIC}` },
    { slug: "green-team", name: "Green Team (demo)", category: "Service", color: "#047857", description: `Environmental service projects around campus. ${SYNTHETIC}` },
    { slug: "debate", name: "Debate Union (demo)", category: "Academic", color: "#b45309", description: `Policy and parliamentary debate practice. ${SYNTHETIC}` },
  ];
  const clubs: Record<string, string> = {};
  for (const c of clubDefs) {
    clubs[c.slug] = (await db.insertInto("clubs").values({ ...c, is_demo: true }).returning("id").executeTakeFirstOrThrow()).id;
  }

  const weekday = [1, 2, 3, 4, 5];
  const roomDefs = [
    { name: "Room 101 (demo)", location: "Main Building, 1st floor", capacity: 30, features: ["projector", "whiteboard"], hours: weekday.map((d) => ({ d, o: "07:00", c: "18:00" })) },
    { name: "Makerspace Lab (demo)", location: "STEM Wing, B12", capacity: 20, features: ["3d-printers", "workbenches"], hours: weekday.map((d) => ({ d, o: "08:00", c: "18:30" })) },
    { name: "Library Commons (demo)", location: "Library, ground floor", capacity: 60, features: ["projector"], hours: [...weekday.map((d) => ({ d, o: "07:30", c: "17:00" })), { d: 6, o: "09:00", c: "13:00" }] },
    { name: "Auditorium (demo)", location: "Arts Center", capacity: 300, features: ["stage", "sound-system", "projector"], hours: [...weekday.map((d) => ({ d, o: "08:00", c: "21:00" })), { d: 6, o: "10:00", c: "16:00" }] },
  ];
  const rooms: Record<string, string> = {};
  for (const r of roomDefs) {
    const id = (
      await db
        .insertInto("rooms")
        .values({ name: r.name, location: r.location, capacity: r.capacity, timezone: DEMO_TZ, features: r.features, is_demo: true })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await db.insertInto("room_hours").values(r.hours.map((h) => ({ room_id: id, weekday: h.d, opens_at: h.o, closes_at: h.c }))).execute();
    rooms[r.name] = id;
  }

  const member = (club: string, user: keyof typeof DEMO_USERS, role: "member" | "organizer" = "member") =>
    db.insertInto("club_memberships").values({ club_id: clubs[club]!, user_id: ids[user], role }).execute();
  await member("robotics", "rivera", "organizer");
  await member("chess", "rivera", "organizer");
  await member("drama", "patel", "organizer");
  await member("green-team", "patel", "organizer");
  await member("debate", "patel", "organizer");
  for (const s of ["sam", "jordan", "alex", "priya"] as const) await member("robotics", s);
  await member("chess", "sam");
  await member("chess", "jordan");
  await member("drama", "alex");
  await member("green-team", "sam");
  await member("green-team", "priya");

  // Declared availability for the "Find available times" demo.
  const avail = (user: keyof typeof DEMO_USERS, days: number[], start: string, end: string) =>
    db.insertInto("user_availability").values(days.map((d) => ({ user_id: ids[user], weekday: d, start_time: start, end_time: end }))).execute();
  await avail("sam", [1, 2, 3, 4, 5], "15:00", "18:00");
  await avail("jordan", [1, 3, 5], "15:30", "17:30");
  await avail("alex", [2, 4], "14:30", "17:00");

  const actor = async (k: keyof typeof DEMO_USERS) => {
    const u = await db.selectFrom("users").selectAll().where("id", "=", ids[k]).executeTakeFirstOrThrow();
    return buildActor(db, u);
  };
  const [admin, rivera, patel] = [await actor("admin"), await actor("rivera"), await actor("patel")];
  const deps = { db, queue, now: () => now };
  const today = todayIn(DEMO_TZ, now);
  const nextWeekday = (from: string, iso: number) => {
    let d = addDays(from, 1);
    while (isoWeekday(d) !== iso) d = addDays(d, 1);
    return d;
  };

  // 1. Weekly robotics build nights (approved, room-booked, recurring).
  const robotics = await createEvent(deps, rivera, {
    clubId: clubs.robotics!, title: "Robotics build night", description: `Drivetrain and autonomous work for the spring competition. ${SYNTHETIC}`,
    category: "STEM", visibility: "public", timezone: DEMO_TZ, allDay: false,
    startDate: addDays(today, 1), startTime: "15:30", durationMinutes: 90, roomId: rooms["Makerspace Lab (demo)"], capacity: 16,
    recurrence: { weekdays: [2, 4], until: addDays(today, 56) }, submit: true,
  });
  await reviewSeries(deps, admin, robotics.series.id, "approve", "Room confirmed.", robotics.series.version);

  // 2. Club-only chess ladder, Wednesdays.
  const chess = await createEvent(deps, rivera, {
    clubId: clubs.chess!, title: "Chess ladder night", description: `Members-only ladder matches. ${SYNTHETIC}`,
    category: "Games", visibility: "club", timezone: DEMO_TZ, allDay: false,
    startDate: addDays(today, 1), startTime: "15:15", durationMinutes: 75, roomId: rooms["Room 101 (demo)"], capacity: 24,
    recurrence: { weekdays: [3], until: addDays(today, 42) }, submit: true,
  });
  await reviewSeries(deps, admin, chess.series.id, "approve", "", chess.series.version);

  // 3. Small-capacity workshop to show the waitlist.
  const soldering = await createEvent(deps, rivera, {
    clubId: clubs.robotics!, title: "Intro to soldering workshop", description: `Hands-on safety and soldering basics. Only 3 stations. ${SYNTHETIC}`,
    category: "STEM", visibility: "public", timezone: DEMO_TZ, allDay: false,
    startDate: nextWeekday(today, 5), startTime: "16:00", durationMinutes: 60, roomId: rooms["Makerspace Lab (demo)"], capacity: 3, submit: true,
  });
  await reviewSeries(deps, admin, soldering.series.id, "approve", "", soldering.series.version);

  // 4. An event starting in about two hours (no room) so reminders are easy to observe.
  const soonStart = new Date(Math.ceil((now.getTime() + 2 * 3600_000) / 900_000) * 900_000);
  const soonLocal = new Intl.DateTimeFormat("en-CA", { timeZone: DEMO_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(soonStart);
  const part = (t: string) => soonLocal.find((p) => p.type === t)!.value;
  const puzzle = await createEvent(deps, admin, {
    clubId: clubs.chess!, title: "Online puzzle hour", description: `Solve tactics puzzles together on the club's online board. ${SYNTHETIC}`,
    category: "Games", visibility: "public", timezone: DEMO_TZ, allDay: false,
    startDate: `${part("year")}-${part("month")}-${part("day")}`, startTime: `${part("hour")}:${part("minute")}`, durationMinutes: 45, submit: true,
  });

  // 5. All-day service day.
  await createEvent(deps, admin, {
    clubId: clubs["green-team"]!, title: "Campus cleanup day", description: `Gloves and bags provided; meet at the front office. ${SYNTHETIC}`,
    category: "Service", visibility: "public", timezone: DEMO_TZ, allDay: true, startDate: nextWeekday(today, 6), allDayDays: 1, submit: true,
  });

  // 6. Pending approval (auditorium) and a draft, for the admin/organizer workflows.
  await createEvent(deps, patel, {
    clubId: clubs.drama!, title: "Spring play auditions", description: `Prepare a one-minute monologue. ${SYNTHETIC}`,
    category: "Arts", visibility: "public", timezone: DEMO_TZ, allDay: false,
    startDate: nextWeekday(today, 2), startTime: "16:00", durationMinutes: 120, roomId: rooms["Auditorium (demo)"], capacity: 80, submit: true,
  });
  await createEvent(deps, patel, {
    clubId: clubs.debate!, title: "Practice tournament (draft)", description: `Two rounds of parliamentary debate. ${SYNTHETIC}`,
    category: "Academic", visibility: "public", timezone: DEMO_TZ, allDay: false,
    startDate: nextWeekday(today, 4), startTime: "15:00", durationMinutes: 120, roomId: rooms["Library Commons (demo)"], capacity: 40, submit: false,
  });
  // 7. Library study jam (approved, green team) — shows another room/club color.
  const study = await createEvent(deps, patel, {
    clubId: clubs["green-team"]!, title: "Recycling awareness poster session", description: `Design posters for the cafeteria. ${SYNTHETIC}`,
    category: "Service", visibility: "public", timezone: DEMO_TZ, allDay: false,
    startDate: nextWeekday(today, 1), startTime: "15:00", durationMinutes: 60, roomId: rooms["Library Commons (demo)"], capacity: 30, submit: true,
  });
  await reviewSeries(deps, admin, study.series.id, "approve", "", study.series.version);

  // RSVPs (through the real RSVP service).
  const firstRobotics = robotics.occurrences[0]!.id;
  for (const s of ["sam", "jordan", "alex"] as const) await setRsvp(db, queue, await actor(s), firstRobotics, "going");
  for (const s of ["sam", "jordan", "alex", "priya"] as const) await setRsvp(db, queue, await actor(s), soldering.occurrences[0]!.id, "going");
  await setRsvp(db, queue, await actor("sam"), chess.occurrences[0]!.id, "going");
  await setRsvp(db, queue, await actor("sam"), puzzle.occurrences[0]!.id, "going");
  await setRsvp(db, queue, await actor("jordan"), puzzle.occurrences[0]!.id, "going");

  // One cancelled occurrence in the robotics series.
  const cancelTarget = robotics.occurrences[3];
  if (cancelTarget) await cancelEvent(deps, rivera, cancelTarget.id, "occurrence", "Staff professional development day");

  await sql`ANALYZE`.execute(db);
  return { users: DEMO_USERS, password: DEMO_PASSWORD };
}
