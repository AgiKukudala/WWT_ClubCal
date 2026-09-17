# Interview guide: explaining ClubCal

A plain-language walkthrough of what was built, why, and the trade-offs. Every claim points to real code.

## 1. The 30-second pitch

"The original project was a static calendar that saved events in each browser's localStorage and checked an admin password in JavaScript. So nobody actually shared a calendar and anyone could 'be admin'. I rebuilt it as a real multi-user system: React front end, an Express/TypeScript API, and PostgreSQL. It has server-side sessions, role- and club-scoped permissions, an approval workflow, room booking with database-enforced conflict prevention, RSVPs with waitlists, bounded weekly recurrence, reminders delivered by a background worker, and .ics export. It all runs locally with `docker compose up` and no API keys."

## 2. What was wrong with the old version (and how I checked)

I read the files before changing anything. See `legacy/README.md` for the table.

- `localStorage` means no sharing between devices.
- `admin/adminpass` sits in `login.js`, and the stored role was never even read.
- `student.html` crashes because it loads the admin script.
- Titles went through `innerHTML`, which is an XSS risk.
- `script.js` and `student.js` were identical copies.
- Times were strings like "3:30 PM - 5:00 PM" with no date model or time zone.
- The zip file was byte-identical to the working files, so it had nothing to recover.

## 3. Architecture in one breath

One API process plus one worker process, both talking to PostgreSQL (`docs/ARCHITECTURE.md`). I chose a **modular monolith**: modules for auth, events, bookings, RSVPs, reminders and scheduling, but one deployable. The load is a school's clubs, not millions of users, and one database gives me real transactions across "change event + move reservation + notify + audit". Microservices would force distributed transactions for no benefit.

PostgreSQL does four jobs: data, sessions, login throttling and the job queue (pg-boss). That keeps operations to one stateful service.

## 4. Things worth drilling into

### Double-booking prevention
- **Code:** `server/migrations/0001_initial.sql` (`room_reservations_no_overlap`), `modules/bookings/bookings.ts`.
- An `EXCLUDE USING gist (room_id WITH =, during WITH &&)` constraint on `tstzrange` columns. The database, not application code, guarantees two active reservations for a room never overlap, even when two requests race.
- Ranges are half-open `[start, end)`, so back-to-back meetings are fine.
- Before inserting, I run one query that checks every requested date. That way a recurring series reports *all* conflicting dates, not just the first. The constraint is the backstop for races: the losing transaction gets `23P01`, which I map to a friendly 409.
- **Proof:** `test/bookings.test.ts` fires 2 and 8 concurrent HTTP requests and asserts exactly one 201.
- **Why a separate reservations table?** Only *approved* events should hold rooms, and approval status lives on the series. So a reservation row exists only while it should block others. Pending events don't squat on rooms.

### RSVP capacity under concurrency
- **Code:** `modules/rsvps/rsvps.ts`.
- I lock the occurrence row (`SELECT … FOR UPDATE`) before counting attendees. That serializes RSVPs for one event without locking the whole table.
- The waitlist order comes from a sequence (FIFO).
- Promotion happens in the same transaction as the cancellation that freed the spot, together with the notification and reminder rows. There is never a moment where a spot is free but nobody was promoted.
- **Proof:** 25 parallel RSVPs for 5 seats → exactly 5 going, waitlist positions 1..20.
- **Alternative considered:** `SERIALIZABLE` isolation with retries. It works, but it needs retry loops everywhere. A single row lock is simpler and easy to reason about.

### Optimistic concurrency
- Series and occurrences have a `version` column, and edits must send `expectedVersion`.
- A stale edit gets 409 `version_conflict`, and the UI offers "load latest". I chose this over "last write wins" because two organizers editing the same event is realistic, and silently losing someone's changes is worse than asking them to reload.

### Time zones and recurrence
- **Code:** `lib/time.ts`, `test/recurrence.test.ts`.
- I store *instants* (`timestamptz`) for occurrences and *intent* (local date, local time, IANA zone) for the series. A "3:30 PM every Tuesday" club stays at 3:30 PM after DST ends, even though its UTC time moves by an hour. The test asserts exactly that for November 2026.
- DST edge cases have written rules:
  - a nonexistent time (2:30 AM on spring-forward day) moves forward by the gap;
  - an ambiguous time (1:30 AM on fall-back day) takes the first occurrence.
- Both are recorded in the audit log, and the time finder never suggests them.
- **Deliberately bounded:** weekly on chosen weekdays, with an end date under one year. I don't claim RRULE support. Materializing occurrences gives each date a stable ID for RSVPs and reminders, and makes range queries simple.
- **Trade-off:** editing a whole series rewrites future dates and drops single-date overrides. It's simple and predictable, but less flexible than Google Calendar's "this and following".

### Reminders that are actually reliable
- **Code:** `modules/reminders/sync.ts`, `modules/reminders/worker.ts`, `src/worker.ts`.
- **Where the schedule lives:** reminder rows in PostgreSQL. Whenever an event, RSVP or preference changes, `syncReminders` reconciles "what should exist" with "what does exist" in the same transaction.
- **How they're sent:** the worker picks up due rows with `FOR UPDATE SKIP LOCKED` and enqueues a pg-boss job in the same transaction.
- **Why a stale job can't send the wrong thing:** the job re-reads everything before sending (still approved? same start time? still going? preference on?). Moved or cancelled events therefore never trigger stale reminders.
- **Duplicates:** in-app notifications have a unique `dedupe_key` (`reminder:<id>`), so a retried job can't create a second one.
- **Email is at-least-once, and I say so.** If the process dies after the SMTP server accepted the message but before I record success, a retry resends it. Exactly-once delivery to an external system isn't achievable without the receiver's cooperation.
- **Crash test:** `test/reminders.test.ts` enqueues a job, stops that worker, starts a new one, and asserts exactly one notification.
- **Honest limitation:** reminders need the worker running. A sleeping laptop sends nothing, and reminders due while it was down are delivered late, or skipped if the event already started.

### Security basics
- **Passwords:** argon2id.
- **Sessions:** server-side session rows. The cookie holds a random token; the database stores only its hash.
- **Cookies:** HttpOnly + SameSite=Lax, plus Secure/`__Host-` in production.
- **CSRF:** a synchronizer token plus an Origin check.
- **Login throttling:** stored in the database.
- **Validation:** Zod on every input.
- **Output:** React text nodes only (no `dangerouslySetInnerHTML`), plus a strict CSP.
- **Permissions:** checked in the service layer against freshly loaded rows, not just hidden in the UI.
- **Registration:** can't pick a role. Organizers get power only for clubs they're assigned to.
- **Hidden events** return 404 rather than 403, so IDs can't be probed.
- **Recovery without an email provider:** `npm run admin:reset-password`.

### "Find available times"
- **Code:** `modules/scheduling/findTimes.ts`.
- It's ordinary scheduling logic, not AI:
  - walk 15-minute slots;
  - drop slots where a room is closed or booked, or where a participant who declared availability is busy;
  - score the rest with a published formula;
  - explain each suggestion with real facts.
- People who never declared availability are labeled *unknown*, not assumed free. Suggestions are advisory, and booking re-validates.

## 5. Trade-offs I'd mention unprompted

| Decision | Upside | Cost / what I'd do at scale |
|---|---|---|
| Polling every 20 s (paused when the tab is hidden) instead of WebSockets | No sticky connections, trivial to operate, works through proxies | Up to ~20 s staleness; could add SSE later |
| pg-boss (Postgres queue) instead of Redis | One stateful service, transactional enqueue | Throughput limited by Postgres, which is plenty here |
| Reapproval sends the whole series back to pending | Simple, explainable policy; admins keep control of rooms | An edited event disappears for students until re-approved; a "change request" model would keep the old version live |
| Series-level approval status | Simple state machine | Can't approve individual dates separately |
| Materialized occurrences (≤ 371) | Stable IDs, simple queries | Not suitable for infinite recurrence |
| UTC times in .ics (no VTIMEZONE) | Correct and simpler | Calendar apps show them converted, which is still correct |
| Capacity reduction demotes the newest attendees | Never exceeds room safety limits | Some users lose a confirmed spot (they're notified and put first in line) |
| Registration limiter is in-process | Simple | Per-instance; the login limiter is the one that matters and it's in the DB |

## 6. How I verified it

- **Type checks:** every package plus the e2e project.
- **Server:** 68 Vitest tests against a real PostgreSQL database that is rebuilt from migrations on every run.
- **Front end:** component tests, including XSS-as-text.
- **Browser:** Playwright end-to-end on the built app with a real worker. The organizer submits, the admin approves, a student on a phone-sized screen RSVPs, a real 1-hour reminder arrives from the worker, and the cancellation shows up.
- **Docker Compose:** brought up from scratch, seeded, an email observed in Mailpit (including a failed first attempt that succeeded on retry after fixing configuration), data surviving `down`/`up`, and a `pg_dump`/`pg_restore` round trip.
- **Benchmark:** a script prints measured numbers only.

## 7. What I'd build next

- A "change request" flow so approved events stay live while edits await approval.
- ICS subscription feeds with per-user secret tokens, which would give read-only live sync without OAuth.
- Server-Sent Events for instant updates.
- Admin-configurable reminder offsets.
- Holiday/closure calendars for rooms.
- Accessibility audit with a screen reader, beyond the current semantic and keyboard work.
- Optional Google/Microsoft sync behind OAuth (needs provider credentials, so it is off by default).
