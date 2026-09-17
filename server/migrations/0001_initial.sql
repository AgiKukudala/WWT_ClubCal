-- ClubCal initial schema.
-- All instants are timestamptz (UTC on disk). Local scheduling intent (IANA zone,
-- local start date/time) is preserved on event_series so recurrence can be
-- re-materialized across daylight-saving changes.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('admin', 'organizer', 'student');
CREATE TYPE membership_role AS ENUM ('member', 'organizer');
CREATE TYPE event_status AS ENUM ('draft', 'pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE event_visibility AS ENUM ('public', 'club');
CREATE TYPE rsvp_status AS ENUM ('going', 'not_going', 'waitlisted');
CREATE TYPE reminder_status AS ENUM ('scheduled', 'queued', 'sent', 'obsolete', 'skipped', 'failed');
CREATE TYPE email_status AS ENUM ('not_requested', 'pending', 'sent', 'failed', 'skipped');

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE CHECK (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+$'),
  display_name        text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  password_hash       text NOT NULL,
  role                user_role NOT NULL DEFAULT 'student',
  timezone            text NOT NULL DEFAULT 'America/Chicago',
  remind_24h          boolean NOT NULL DEFAULT true,
  remind_1h           boolean NOT NULL DEFAULT true,
  email_notifications boolean NOT NULL DEFAULT false,
  is_demo             boolean NOT NULL DEFAULT false,
  disabled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           text PRIMARY KEY,           -- SHA-256 of the opaque cookie token; raw token never stored
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE login_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        citext NOT NULL,
  ip           text NOT NULL,
  succeeded    boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email, attempted_at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, attempted_at);

-- Explicit weekly availability declared by a user, interpreted in users.timezone.
CREATE TABLE user_availability (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- ISO: 1 = Monday
  start_time time NOT NULL,
  end_time   time NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX user_availability_user_idx ON user_availability (user_id);

-- ---------------------------------------------------------------- clubs
CREATE TABLE clubs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        citext NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  category    text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  color       text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  is_demo     boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE club_memberships (
  club_id   uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      membership_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX club_memberships_user_idx ON club_memberships (user_id, role);

-- ---------------------------------------------------------------- rooms
CREATE TABLE rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       citext NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  location   text NOT NULL CHECK (length(location) BETWEEN 1 AND 120),
  capacity   integer NOT NULL CHECK (capacity BETWEEN 1 AND 10000),
  timezone   text NOT NULL,
  features   text[] NOT NULL DEFAULT '{}',
  is_active  boolean NOT NULL DEFAULT true,
  is_demo    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One opening window per ISO weekday, local to rooms.timezone. No row = closed.
CREATE TABLE room_hours (
  room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  weekday   smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens_at  time NOT NULL,
  closes_at time NOT NULL,
  PRIMARY KEY (room_id, weekday),
  CHECK (opens_at < closes_at)
);

-- ---------------------------------------------------------------- events
CREATE TABLE legacy_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imported_by uuid NOT NULL REFERENCES users(id),
  club_id     uuid NOT NULL REFERENCES clubs(id),
  timezone    text NOT NULL,
  file_sha256 text NOT NULL UNIQUE,
  row_count   integer NOT NULL CHECK (row_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_series (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id             uuid NOT NULL REFERENCES clubs(id),
  created_by          uuid NOT NULL REFERENCES users(id),
  title               text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  category            text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  visibility          event_visibility NOT NULL DEFAULT 'public',
  status              event_status NOT NULL DEFAULT 'draft',
  timezone            text NOT NULL,
  is_all_day          boolean NOT NULL DEFAULT false,
  start_date          date NOT NULL,
  local_start_time    time,
  duration_minutes    integer CHECK (duration_minutes BETWEEN 15 AND 1440),
  all_day_days        integer CHECK (all_day_days BETWEEN 1 AND 14),
  recurrence_weekdays smallint[],
  recurrence_until    date,
  room_id             uuid REFERENCES rooms(id),
  capacity            integer CHECK (capacity BETWEEN 1 AND 10000),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  review_comment      text CHECK (length(review_comment) <= 1000),
  reviewed_by         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  submitted_at        timestamptz,
  legacy_import_id    uuid REFERENCES legacy_imports(id),
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT series_time_shape CHECK (
    (is_all_day AND local_start_time IS NULL AND duration_minutes IS NULL AND all_day_days IS NOT NULL AND room_id IS NULL)
    OR (NOT is_all_day AND local_start_time IS NOT NULL AND duration_minutes IS NOT NULL AND all_day_days IS NULL)
  ),
  CONSTRAINT series_recurrence_shape CHECK (
    (recurrence_weekdays IS NULL AND recurrence_until IS NULL)
    OR (recurrence_weekdays IS NOT NULL AND recurrence_until IS NOT NULL
        AND recurrence_until >= start_date
        AND recurrence_until <= start_date + 366
        AND cardinality(recurrence_weekdays) BETWEEN 1 AND 7
        AND recurrence_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
  )
);
CREATE INDEX event_series_club_idx ON event_series (club_id, status);
CREATE INDEX event_series_status_idx ON event_series (status, submitted_at);

CREATE TABLE event_occurrences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id       uuid NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,            -- series-local date this occurrence was generated for (stable key)
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  all_day_start   date,                     -- all-day events: local dates, end exclusive
  all_day_end     date,
  room_id         uuid REFERENCES rooms(id),
  capacity        integer CHECK (capacity BETWEEN 1 AND 10000),
  is_exception    boolean NOT NULL DEFAULT false,
  cancelled_at    timestamptz,
  cancel_reason   text CHECK (length(cancel_reason) <= 500),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, occurrence_date),
  CHECK (ends_at > starts_at),
  CHECK ((all_day_start IS NULL) = (all_day_end IS NULL)),
  CHECK (all_day_start IS NULL OR all_day_end > all_day_start)
);
CREATE INDEX event_occurrences_range_idx ON event_occurrences USING gist (tstzrange(starts_at, ends_at, '[)'));
CREATE INDEX event_occurrences_start_idx ON event_occurrences (starts_at, id);
CREATE INDEX event_occurrences_series_idx ON event_occurrences (series_id, starts_at);
CREATE INDEX event_occurrences_room_idx ON event_occurrences (room_id, starts_at) WHERE room_id IS NOT NULL;

-- Active room holds. A row exists only while the occurrence is approved, not cancelled
-- and has a room. The exclusion constraint is the authoritative double-booking guard;
-- '[)' ranges make back-to-back meetings legal.
CREATE TABLE room_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES rooms(id),
  occurrence_id uuid NOT NULL UNIQUE REFERENCES event_occurrences(id) ON DELETE CASCADE,
  during        tstzrange NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_half_open CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)
                                          AND NOT lower_inf(during) AND NOT upper_inf(during)),
  CONSTRAINT room_reservations_no_overlap EXCLUDE USING gist (room_id WITH =, during WITH &&)
);

CREATE TABLE legacy_import_rows (
  fingerprint text PRIMARY KEY,
  import_id   uuid NOT NULL REFERENCES legacy_imports(id) ON DELETE CASCADE,
  series_id   uuid NOT NULL REFERENCES event_series(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- RSVPs
CREATE SEQUENCE waitlist_position_seq;

CREATE TABLE rsvps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id     uuid NOT NULL REFERENCES event_occurrences(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            rsvp_status NOT NULL,
  waitlist_position bigint,
  responded_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (occurrence_id, user_id),
  CHECK ((status = 'waitlisted') = (waitlist_position IS NOT NULL))
);
CREATE INDEX rsvps_occurrence_status_idx ON rsvps (occurrence_id, status);
CREATE UNIQUE INDEX rsvps_waitlist_order_idx ON rsvps (occurrence_id, waitlist_position) WHERE status = 'waitlisted';
CREATE INDEX rsvps_user_idx ON rsvps (user_id, status);

-- ---------------------------------------------------------------- notifications & reminders
CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL DEFAULT '',
  occurrence_id    uuid REFERENCES event_occurrences(id) ON DELETE SET NULL,
  dedupe_key       text NOT NULL UNIQUE,     -- unique delivery identifier
  email_status     email_status NOT NULL DEFAULT 'not_requested',
  email_attempts   integer NOT NULL DEFAULT 0,
  email_last_error text,
  email_sent_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_email_idx ON notifications (email_status) WHERE email_status IN ('pending', 'failed');

CREATE TABLE reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id   uuid NOT NULL REFERENCES event_occurrences(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offset_minutes  integer NOT NULL CHECK (offset_minutes IN (60, 1440)),
  event_starts_at timestamptz NOT NULL,     -- the start time this reminder was computed for
  due_at          timestamptz NOT NULL,
  status          reminder_status NOT NULL DEFAULT 'scheduled',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  job_id          text,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (occurrence_id, user_id, offset_minutes, event_starts_at)
);
CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE status = 'scheduled';
CREATE INDEX reminders_occurrence_idx ON reminders (occurrence_id, status);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
