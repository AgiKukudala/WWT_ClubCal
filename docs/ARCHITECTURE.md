# Architecture

ClubCal is a **modular monolith**: one Express process serves the API and the built React app from the same origin. A second process, the **worker**, runs background jobs. Both share one PostgreSQL database, which is the only stateful component: it holds application data, sessions, the rate-limit ledger and the job queue. There is no Redis, message broker or external service.

```
Browser (React SPA) ──HTTPS──▶ app (Express)
    ▲  polls every 20 s             │  Kysely / SQL transactions
    │                               ▼
    └──────────────────────── PostgreSQL ◀──── worker (pg-boss handlers + dispatch loop)
                                    │                    │
                                    │                    └──SMTP──▶ Mailpit (local) / real relay
                                    └── pgboss schema (job queue)
```

## Code map

| Path | Responsibility |
|---|---|
| `shared/src/schemas.ts` | Zod request schemas shared by server and UI (single source of validation rules) |
| `shared/src/legacy.ts` | Strict parser for the old `localStorage` JSON |
| `server/migrations/*.sql` | Schema. Applied in order by `db/migrate.ts` under an advisory lock, with checksums |
| `server/src/auth/*` | Password hashing, sessions, CSRF, rate limiting, the `Actor` permission context |
| `server/src/modules/visibility.ts` | The one place that decides who may read which events |
| `server/src/modules/events/service.ts` | Create / edit / submit / review / cancel / delete, including the reapproval policy |
| `server/src/modules/bookings/bookings.ts` | Opening-hours checks, conflict reports, reservation writes |
| `server/src/modules/rsvps/rsvps.ts` | RSVP, waitlist, promotion and demotion |
| `server/src/modules/reminders/*` | Reminder reconciliation (`sync.ts`) and delivery (`worker.ts`) |
| `server/src/modules/scheduling/findTimes.ts` | Deterministic availability search |
| `server/src/lib/time.ts` | Local-time ↔ instant conversion and recurrence expansion |
| `server/src/lib/ics.ts` | RFC 5545 writer |
| `server/src/http/*` | Routers (thin: parse → call service → shape response) and the error mapper |
| `server/src/worker.ts` | Worker entrypoint |
| `web/src/*` | SPA: TanStack Query hooks, pages, calendar components |

## Request flow

1. `helmet` sets security headers (strict CSP: scripts only from our origin, no inline scripts, no framing).
2. `/api` → JSON body parser (3 MB limit) → cookie parser.
3. **Session middleware** hashes the cookie token (SHA-256) and looks up `sessions` joined to `users`. Expired sessions and disabled users are ignored and their cookie is cleared. It loads the user's club memberships into an `Actor` object: `organizerClubIds` (only for users whose global role is `organizer`) and `memberClubIds`.
4. **CSRF middleware** runs for non-GET requests. It rejects foreign `Origin`s and `Sec-Fetch-Site: cross-site`, and requires `X-CSRF-Token` to match the session's token (timing-safe compare).
5. The router validates input with the shared Zod schema. Failures become `400` with per-field messages.
6. The domain service runs inside **one database transaction**, including permission checks against fresh rows.
7. The error handler maps `HttpError`s, and PostgreSQL errors (exclusion violation `23P01` → 409, check/FK violations → 400), to JSON. Unexpected errors are logged and returned as a generic 500.

## Authentication & permissions

- **Passwords:** argon2id (library defaults). Login against an unknown email still performs a hash verification, so response timing doesn't reveal which accounts exist.
- **Sessions:** server-side rows keyed by a SHA-256 hash of a 256-bit random token. The raw token exists only in the HttpOnly, `SameSite=Lax` cookie (Secure and `__Host-` prefixed in production). Sessions have an absolute expiry. Login deletes any previous session (no fixation). Logout and account disabling delete rows immediately.
- **Rate limiting:** failed logins are recorded in `login_attempts`. More than `LOGIN_MAX_FAILURES` per email, or 4× that per IP, within the window returns 429. The ledger lives in the database, so the limit holds across restarts and instances. A registration burst limiter runs in-process.
- **Roles:** `student` (the default and the only self-registered role), `organizer`, `admin`.
  - An organizer can manage a club only if their global role is `organizer` **and** they hold an `organizer` membership in that club. Demoting a user to student also downgrades those memberships.
  - `canManageClub(actor, clubId)` is checked by every write. Reads go through `seriesVisibleTo(actor)`:
    - admin: everything;
    - organizers: everything in their clubs (including drafts);
    - everyone else: approved or cancelled events that are public, or club-only events of clubs they belong to.
- **No existence leaks:** an event you can't see returns 404 even for direct ID requests, RSVPs, `.ics` downloads and audit reads. Room availability endpoints expose time blocks only. Booking-conflict messages name the room and time but never the other event.

## Data model (main tables)

`users`, `sessions`, `login_attempts`, `user_availability`, `clubs`, `club_memberships`, `rooms`, `room_hours`, `event_series`, `event_occurrences`, `room_reservations`, `rsvps`, `notifications`, `reminders`, `audit_log`, `legacy_imports`, `legacy_import_rows`, plus the `pgboss` schema.

- **IDs** are UUIDs, except bigint identities for append-only logs.
- **`event_series`** stores *intent*: IANA `timezone`, local `start_date` and `local_start_time`, `duration_minutes` (or `all_day_days`), and optional `recurrence_weekdays` + `recurrence_until`. It also carries status, visibility, `version`, and reviewer fields. CHECK constraints enforce that an event is either timed or all-day (never both), that all-day events have no room, and that recurrence is bounded.
- **`event_occurrences`** stores *facts*: `starts_at`/`ends_at` as `timestamptz`, plus `all_day_start`/`all_day_end` as dates for all-day events (end exclusive). Each row keeps its own room, capacity, cancellation and `version`. `(series_id, occurrence_date)` is unique, so each generated date has a stable identity that survives edits.
- **Indexes:**
  - a GiST index on `tstzrange(starts_at, ends_at)` and btree `(starts_at, id)`, for bounded range queries and keyset pagination;
  - partial indexes for due reminders, unread notifications and the waitlist order;
  - membership lookups by user.

## Room bookings and conflict prevention

`room_reservations(room_id, occurrence_id UNIQUE, during tstzrange)` has:

```sql
CONSTRAINT room_reservations_no_overlap EXCLUDE USING gist (room_id WITH =, during WITH &&)
CHECK (lower_inc(during) AND NOT upper_inc(during) ...)   -- always half-open [start, end)
```

- A reservation row exists **only** while an occurrence is approved, not cancelled, and has a room. Pending events hold nothing. Cancelling, rejecting, or sending an event back for reapproval deletes its rows.
- **Half-open intervals** mean a 1–2 PM meeting and a 2–3 PM meeting do not overlap.
- `reserve()` releases the occurrences' own rows, then runs `findBookingConflicts()` for **all** candidates at once. That call checks the room is active, the event capacity is ≤ the room capacity, the booking falls within opening hours on the same local day in the room's time zone, and there is no overlap with other reservations (one `unnest … JOIN` query). It also catches overlaps between dates of the same request. Every problem is reported together (409 with `conflicts[]`), and the transaction rolls back, so nothing is partially applied.
- **Races:** two transactions can both pass the pre-check. The second `INSERT` then blocks on the first's index entry and fails with `23P01` once the first commits. The error handler turns that into a 409 ("just reserved by another request"). The tests fire 2 and 8 simultaneous requests and always observe exactly one success.

## Approval workflow & reapproval policy

```
draft ──submit──▶ pending ──approve──▶ approved ──cancel──▶ cancelled
  ▲                  │                    │
  └──── (edit) ◀── rejected ◀──reject─────┘ (organizer edits time/room/capacity/recurrence → pending)
```

- Administrators' own submissions are approved directly (they are the approvers).
- **Approval** locks the series row (`SELECT … FOR UPDATE`), checks `expectedVersion`, re-reserves every upcoming occurrence, runs waitlist promotion, reschedules reminders, writes the audit record and creates notifications. All of this happens in one transaction.
- **Reapproval policy:**
  - An *organizer's* change to date, time, time zone, duration, repeat pattern, room or capacity of an **approved** series moves it back to `pending`. That releases its rooms, hides it from students until re-approved, keeps RSVPs, and notifies attendees and admins.
  - Title, description, category and visibility edits apply immediately.
  - An *administrator's* edits stay approved, but every booking is still re-validated.
  - Editing a single occurrence follows the same rule; the whole series goes back to pending.
- **Deletion vs. cancellation:** drafts, rejected events, and never-published pending events without responses are deleted. Published events are cancelled, so attendees keep a visible record.
- **Audit:** `audit(tx, …)` is always called with the same transaction as the change. Records hold actor, action, entity, timestamp and details (a field-level `{from, to}` diff for edits, the reviewer comment, counts).

## Optimistic concurrency

Series and occurrences carry integer `version` columns. Every edit, submit and review sends `expectedVersion`. The service locks the row and compares the versions, returning `409 version_conflict` with `currentVersion` on a mismatch. Successful changes increment the version. The UI shows a "load latest version" prompt instead of silently overwriting.

## RSVPs & waitlists

- `rsvps` has `UNIQUE(occurrence_id, user_id)`, and `waitlist_position` is non-null exactly when the status is `waitlisted` (CHECK constraint).
- `setRsvp` locks the **occurrence row** (`FOR UPDATE`). All capacity decisions for one occurrence are therefore serialized. Under that lock it counts `going`, then either confirms the user or assigns a position from a global sequence (FIFO).
- **Idempotent:** repeating "going" while going or waitlisted returns the current state without changing position; repeating "not going" is a no-op.
- **Promotion:** when a going user leaves or capacity grows, `rebalance()` promotes the lowest positions one by one. Each promotion writes the RSVP change, a notification (dedupe key `promoted:<rsvp>:<position>`), an audit row and reminder rows, all in the same transaction.
- **Capacity reduction:** the most recently confirmed attendees are moved to the *front* of the waitlist, keeping their relative order, and notified. The room capacity is never exceeded.
- **Cancelled or unpublished events** refuse RSVP changes (409). Existing responses stay, so attendees still see "cancelled" in their schedule and get notified.
- Leaving a club (or being removed) releases your spots at that club's members-only upcoming events.

## Time handling & recurrence

- Timed occurrences are instants (`timestamptz`); the series keeps the local wall-clock intent plus the IANA zone. The UI renders in the viewer's own time zone and notes the event's zone when it differs. All-day events use date columns and are exported as `VALUE=DATE`.
- `resolveLocal(date, time, zone)` has explicit rules:
  - **Nonexistent** local times (spring-forward gap) use the pre-transition offset, which moves them forward by the gap (02:30 → 03:30). The result is flagged `gap_shifted`.
  - **Ambiguous** local times (fall-back) take the **earlier** instant (flag `ambiguous_earlier`).
  - Adjusted dates are listed in the creation audit record.
  - The availability finder never suggests adjusted times.
- **Recurrence is deliberately limited:** weekly, on selected ISO weekdays, with a required end date before the same date one year later (≤ 371 occurrences). Each occurrence is materialized at the same local time, so its UTC offset changes across DST. Duration is elapsed time.
- **Series-wide edits** re-materialize the series, keyed by `occurrence_date`:
  - past occurrences are left alone;
  - individually cancelled ones stay cancelled;
  - other dates are updated, and series-wide scheduling edits replace single-date overrides;
  - dates that disappear are cancelled if anyone responded, otherwise deleted;
  - new future dates are inserted.
  - Then every booking is re-validated, and any conflict aborts the whole edit with the list of conflicting dates.
- **Single-occurrence edits** (`PATCH /occurrences/:id`) mark the row `is_exception`. RSVPs and reminders always belong to individual occurrences.
- **Not supported (by design):** RRULE import, monthly/yearly rules, "this and following", or infinite series.

## Reminders & notifications

- **Durable schedule:** `reminders(occurrence_id, user_id, offset_minutes ∈ {1440, 60}, event_starts_at, due_at, status)`, unique on `(occurrence, user, offset, event_starts_at)`.
- **Reconciliation.** `syncReminders(tx, occurrenceIds, userIds?)` runs in every transaction that changes an event, an RSVP, a preference or an account state. It computes the *desired* set: an approved, uncancelled occurrence × a `going` user with an active account × each enabled offset. Then:
  - rows no longer desired become `obsolete`;
  - missing future rows are inserted;
  - an obsolete row for the same start time is revived rather than duplicated;
  - because rows are keyed by start time, moving an event creates new rows, while a reminder already sent for an unchanged start is never sent twice.
- **Dispatch** (worker loop, every `REMINDER_POLL_SECONDS`): `SELECT … WHERE status='scheduled' AND due_at <= now() FOR UPDATE SKIP LOCKED`. For each row it enqueues a pg-boss job (`singletonKey = reminder id`) **in the same transaction** (pg-boss `fromKysely` adapter) and marks the row `queued`. Several workers can run safely.
- **Delivery** (pg-boss handler) locks the reminder and **rechecks** everything against current data:
  - the series is approved and the occurrence not cancelled;
  - the start time still equals `event_starts_at` (the "current version" check that makes stale jobs harmless);
  - the user is still going, active, and has the preference on;
  - the event hasn't started (otherwise `skipped`).
  - It then creates the in-app notification with dedupe key `reminder:<id>` (UNIQUE) and marks the reminder `sent`, in one transaction. A retry after a crash therefore can't create a second notification.
- **Retries:** the queue retries 5 times with exponential backoff capped at 10 minutes, and has a 2-minute active timeout, so a job held by a dead worker is retried. Failures increment `attempts` and store `last_error`; the final failure sets `failed`. Admin → *Reminders & email* shows counts, queue depths and recent failures.
- **Recovery:**
  - jobs are rows in PostgreSQL, so a stopped worker simply picks them up after restart (tested);
  - a periodic sweep returns long-`queued` reminders whose job no longer exists to `scheduled`;
  - reminders that come due while no worker is running are delivered on restart unless the event has already begun.
- **Email:** `notify()` inserts the notification and, if the user opted in and SMTP is configured, enqueues `send-email` in the same transaction. The email handler is **at-least-once**: a crash after SMTP accepts the message but before `email_status='sent'` is written leads to a resend. Exactly-once external email is not claimed.
- **Freshness in the browser:** TanStack Query polls calendar queries, the event detail page and the unread count every 20 s. It pauses while the tab is hidden, refetches on focus and reconnect, and retries with exponential backoff. The header shows "Updated … ago", or a warning while offline or failing. Reminders never depend on an open browser.

## Availability finder

Inputs: duration, date range (≤ 14 days), a time-of-day window, minimum seats, required room features, optional room list, and explicit participants (who must be members of the requester's clubs).

1. Candidate starts are every 15 minutes from `earliest` to `latest − duration` in the requester's zone. DST-adjusted local times are skipped, as are past times.
2. A slot is **excluded** if any participant *with declared availability* is not fully available (weekly windows interpreted in that participant's zone), or if any participant already has a `going` RSVP overlapping the slot.
3. For each remaining slot and eligible room: the room must be open for the entire slot and have no overlapping reservation.
4. **Score** = `100 − 15 × (participants without declared availability) − round(20 × spare-seat fraction) − 2 × (day index)`. Ties break by earlier start, then room name. At most 3 suggestions per day are returned.
5. Each suggestion lists the factual reasons: who was checked, who is *unknown* (never assumed free), room size vs. need, and opening hours.

Suggestions are advisory. Creating and approving the event re-validates everything transactionally.

## Calendar export

`lib/ics.ts` writes RFC 5545:

- CRLF line endings and 75-octet folding that never splits UTF-8 characters;
- TEXT escaping for `\ ; , newline`;
- `UID: occurrence-<uuid>@<host>` (stable across downloads) and `DTSTAMP`;
- UTC `DTSTART`/`DTEND` for timed events, `VALUE=DATE` with an exclusive end for all-day events;
- `STATUS` CONFIRMED / TENTATIVE / CANCELLED, and `SEQUENCE` derived from versions.

Exports reuse the same visibility-filtered query as the calendar and include only published (approved or cancelled) events. It is a snapshot download, not a subscription or sync.

## Legacy import

The old app kept `[{day, month, year, events:[{title, time:"h:mm AM - h:mm PM"}]}]` in each browser. The admin import flow:

1. Parses the JSON strictly and requires an explicit IANA time zone.
2. **Preview:** returns per-row results (invalid dates, unparseable or backwards times, empty titles) without writing anything.
3. **Commit:** requires the SHA-256 of the canonicalized file from the preview, to prove nothing changed in between. `legacy_imports.file_sha256` is UNIQUE, which blocks importing the same file twice. `legacy_import_rows.fingerprint` (club, date, times, lower-cased title) is the primary key, which catches duplicates across files.
4. Creates approved, room-less events in a single transaction and writes an audit entry.

## Deployment notes

- The Docker image is multi-stage on `node:22-bookworm-slim` and runs as a non-root user with a health check. Compose starts, in order:
  - `db` (healthy);
  - `migrate` (one-shot; must exit 0);
  - `app` and `worker`, which have health checks (HTTP `/api/health`, and a worker heartbeat written after each successful dispatch round-trip);
  - `mailpit`.
- Data lives in named volumes.
- For a real deployment, put the app behind HTTPS and set:
  - `NODE_ENV=production` (already set in the image);
  - `COMPOSE_COOKIE_SECURE=true`;
  - a strong `SESSION_SECRET` and `POSTGRES_PASSWORD`;
  - `COMPOSE_APP_ORIGIN`/`COMPOSE_PUBLIC_URL` to the public URL;
  - `COMPOSE_TRUST_PROXY=true` if a reverse proxy sets `X-Forwarded-For`;
  - real SMTP settings.
- Scale-out: the app is stateless apart from the in-process registration limiter. Several workers can run concurrently (`SKIP LOCKED`, singleton job keys).
