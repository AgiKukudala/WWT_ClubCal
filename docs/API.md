# ClubCal HTTP API

Base path: `/api`. JSON in and out. Every endpoint except `health`, `auth/session`, `auth/register` and `auth/login` requires a signed-in session.

## Conventions

- **Authentication:** a session cookie (`clubcal_session`, or `__Host-clubcal_session` when Secure) set by login or registration. It is HttpOnly and `SameSite=Lax`, and it expires after `SESSION_TTL_HOURS` (default 7 days).
- **CSRF:** every non-GET request made while signed in must send `X-CSRF-Token: <csrfToken>`. Get the token from `GET /api/auth/session`. Requests whose `Origin` is not listed in `APP_ORIGIN`, or that carry `Sec-Fetch-Site: cross-site`, are rejected.
- **Errors:** `{"error": {"code", "message", "fields"?, "conflicts"?, "currentVersion"?}}`

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Validation failed; `fields` maps field paths to messages |
| 401 | `unauthorized` | Not signed in / wrong credentials |
| 403 | `forbidden` | Signed in but not allowed (also CSRF/origin failures) |
| 404 | `not_found` | Missing **or not visible to you** (hidden events are never "403") |
| 409 | `conflict` | Business-rule conflict; room problems include `conflicts[]` with `date`, `startsAt`, `endsAt`, `reason` (`room_booked`, `outside_hours`, `room_inactive`, `capacity_exceeds_room`), `message` |
| 409 | `version_conflict` | Optimistic-concurrency failure; `currentVersion` is included |
| 429 | `rate_limited` | Too many failed logins / registrations |

- **Times:** instants are ISO 8601 UTC strings. Local scheduling fields are `startDate` (YYYY-MM-DD), `startTime` (HH:MM, 24-hour) and `timezone` (an IANA name). ISO weekdays: 1 = Monday … 7 = Sunday.
- **Versions:** `series.version` and `occurrence.occurrenceVersion` must be echoed as `expectedVersion` on edits.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `200 {status:"ok", database:"ok"}`; `503` when the database is unreachable |

## Auth & profile

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/auth/session` | – | `{user: MeDTO \| null, csrfToken}` |
| POST | `/auth/register` | `{email, displayName, password (≥10), timezone?}` | Always creates a **student**; any `role` field is ignored. Signs in. `201` |
| POST | `/auth/login` | `{email, password}` | Rotates the session. `401` on bad credentials, `429` after repeated failures |
| POST | `/auth/logout` | – | Deletes the server-side session |
| PATCH | `/me` | `{displayName?, timezone?, remind24h?, remind1h?, emailNotifications?}` | Reminder changes reschedule pending reminders |
| GET | `/me/availability` | – | `{windows:[{weekday,start,end}]}` in your timezone |
| PUT | `/me/availability` | `{windows:[…]}` (≤50) | Replaces all windows |

## Events

An **event series** holds the title, description, club, rules and approval status. A one-off event is a series with a single occurrence. **Occurrences** are the individual dated instances. They carry the start/end, room and capacity, and RSVPs belong to them.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/occurrences?from&to[&clubId&roomId&category&q&status&mine&limit&cursor]` | any | Range required, at most 100 days. `limit` ≤ 500 (default 200). Keyset pagination: pass `nextCursor` back as `cursor`. Without `status`, returns approved, pending and cancelled items you may see. `mine=true` returns only your going/waitlisted events |
| GET | `/occurrences/:id` | any | `OccurrenceDTO` (`status`, `myRsvp`, `myWaitlistPosition`, counts, `canManage`) |
| PATCH | `/occurrences/:id` | club manager | Reschedule one date: `{expectedVersion, date, startTime, durationMinutes, roomId, capacity}` |
| POST | `/occurrences/:id/cancel` | club manager | `{scope:"occurrence"\|"series", reason}`. Releases rooms, invalidates reminders, notifies attendees |
| PUT | `/occurrences/:id/rsvp` | any who can see it | `{response:"going"\|"not_going"}` → `{status, waitlistPosition, changed}`. Idempotent |
| GET | `/occurrences/:id/attendees` | club manager | Going list, then waitlist in order |
| GET | `/occurrences/:id/ics` | any who can see it | `text/calendar` download |
| GET | `/calendar.ics?from&to[&clubId&mine=true]` | any | Published (approved or cancelled) events you may see |
| POST | `/series` | organizer of the club, admin | `CreateEventInput` (below). `201 {seriesId, status, firstOccurrenceId, occurrenceCount}` |
| GET | `/series/:id` | any who can see it | `SeriesDTO` |
| GET | `/series/:id/occurrences` | same | All dates in the series |
| PUT | `/series/:id` | club manager | Whole-series edit: same fields as create (except `clubId`/`submit`) plus `expectedVersion` |
| POST | `/series/:id/submit` | club manager | `{expectedVersion}`: draft/rejected → pending |
| POST | `/series/:id/review` | admin | `{decision:"approve"\|"reject", comment, expectedVersion}`. A comment is required to reject. Approval re-validates all bookings |
| DELETE | `/series/:id` | club manager | Only draft/rejected/pending events with no RSVPs. `204` |
| GET | `/series/:id/audit` | club manager | Audit trail for the series and its dates |
| GET | `/approvals` | admin | Pending queue |
| GET | `/manage/series?[clubId&status]` | organizer/admin | Every series in clubs you manage |
| GET | `/categories` | any | Known categories |

`CreateEventInput`:

```json
{
  "clubId": "uuid", "title": "Robotics build night", "description": "", "category": "STEM",
  "visibility": "public | club", "timezone": "America/Chicago",
  "allDay": false, "startDate": "2026-10-06", "startTime": "15:30", "durationMinutes": 90,
  "allDayDays": null, "roomId": "uuid | null", "capacity": 16,
  "recurrence": { "weekdays": [2, 4], "until": "2026-12-15" },
  "submit": true
}
```

Rules:

- All-day events need `allDayDays` (1–14) and cannot book rooms.
- A series must end before the same date one year later.
- A room event without `capacity` uses the room's capacity.
- `submit:false` saves a draft. `submit:true` makes it pending, or approved immediately when an administrator submits it.

## Scheduling

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/scheduling/find-times` | organizer/admin | `{durationMinutes, from, to (≤14 days), timezone, minCapacity, requiredFeatures[], roomIds[], participantIds[], earliest, latest, limit}`. Participants must belong to a club you manage |

The response is `{suggestions:[{startsAt, endsAt, localDate, localStart, localEnd, room, score, availableParticipants, unknownParticipants, reasons[]}], consideredSlots, roomsConsidered, participantsWithoutAvailability, scoringRule}`.

## Clubs

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/clubs` | any | Includes `memberCount`, `myRole` |
| GET | `/clubs/:idOrSlug` | any | Adds `organizers[]`, `canManage` |
| POST | `/clubs` | admin | `{name, slug, category, color, description}` |
| PATCH | `/clubs/:id` | admin; organizers only `description`/`color` | |
| DELETE | `/clubs/:id` | admin | Archives the club (blocked while it has upcoming events) |
| POST | `/clubs/:id/join` · `/clubs/:id/leave` | any | Idempotent. Leaving releases your spots at the club's members-only events |
| GET | `/clubs/:id/members` | club manager | |
| PUT | `/clubs/:id/members` | admin | `{userId, role:"member"\|"organizer"}`. Assigning an organizer promotes a student |
| DELETE | `/clubs/:id/members/:userId` | club manager (admins for organizers) | |

## Rooms

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/rooms` | any | Includes weekly `hours` |
| GET | `/rooms/:id/busy?from&to` | any | Busy blocks only, ≤31 days, no event details |
| POST | `/rooms` · PUT `/rooms/:id` | admin | `{name, location, capacity, timezone, features[], isActive, hours:[{weekday, opens, closes}]}` |

## Notifications

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?[before&limit]` | Newest first |
| GET | `/notifications/unread-count` | Polled by the UI every 20 s |
| POST | `/notifications/:id/read` · `/notifications/read-all` | |

## Administration (admin only)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/users?[q&limit&offset]` | |
| PATCH | `/admin/users/:id` | `{role?, disabled?}`. You can't change yourself. Disabling revokes sessions |
| GET | `/admin/audit?[entityType&action&before&limit]` | |
| GET | `/admin/jobs` | Reminder and email status counts, queue depths, recent failures |
| POST | `/admin/import/preview` | `{clubId, timezone, category, visibility, json}` → per-row results + `fileSha256`. Writes nothing |
| POST | `/admin/import/commit` | Same body + `fileSha256` from the preview. `409` if the file changed or was already imported |
