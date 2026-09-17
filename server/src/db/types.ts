import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { EventStatus, Role, RsvpStatus, Visibility } from "@clubcal/shared";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** DATE columns are returned as YYYY-MM-DD strings (see the pg type parser in db/index.ts). */
type DateCol = ColumnType<string, string, string>;
/** TIME columns come back as HH:MM:SS strings. */
type TimeCol = ColumnType<string, string, string>;

export type ReminderStatus = "scheduled" | "queued" | "sent" | "obsolete" | "skipped" | "failed";
export type EmailStatus = "not_requested" | "pending" | "sent" | "failed" | "skipped";

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  role: ColumnType<Role, Role | undefined, Role>;
  timezone: ColumnType<string, string | undefined, string>;
  remind_24h: ColumnType<boolean, boolean | undefined, boolean>;
  remind_1h: ColumnType<boolean, boolean | undefined, boolean>;
  email_notifications: ColumnType<boolean, boolean | undefined, boolean>;
  is_demo: ColumnType<boolean, boolean | undefined, boolean>;
  disabled_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  csrf_token: string;
  user_agent: string | null;
  created_at: DefaultTimestamp;
  last_seen_at: DefaultTimestamp;
  expires_at: Timestamp;
}

export interface LoginAttemptsTable {
  id: Generated<string>;
  email: string;
  ip: string;
  succeeded: boolean;
  attempted_at: DefaultTimestamp;
}

export interface UserAvailabilityTable {
  id: Generated<string>;
  user_id: string;
  weekday: number;
  start_time: TimeCol;
  end_time: TimeCol;
}

export interface ClubsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  category: string;
  color: string;
  is_demo: ColumnType<boolean, boolean | undefined, boolean>;
  archived_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface ClubMembershipsTable {
  club_id: string;
  user_id: string;
  role: ColumnType<"member" | "organizer", "member" | "organizer" | undefined, "member" | "organizer">;
  joined_at: DefaultTimestamp;
}

export interface RoomsTable {
  id: Generated<string>;
  name: string;
  location: string;
  capacity: number;
  timezone: string;
  features: ColumnType<string[], string[] | undefined, string[]>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  is_demo: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RoomHoursTable {
  room_id: string;
  weekday: number;
  opens_at: TimeCol;
  closes_at: TimeCol;
}

export interface LegacyImportsTable {
  id: Generated<string>;
  imported_by: string;
  club_id: string;
  timezone: string;
  file_sha256: string;
  row_count: number;
  created_at: DefaultTimestamp;
}

export interface LegacyImportRowsTable {
  fingerprint: string;
  import_id: string;
  series_id: string;
}

export interface EventSeriesTable {
  id: Generated<string>;
  club_id: string;
  created_by: string;
  title: string;
  description: ColumnType<string, string | undefined, string>;
  category: string;
  visibility: ColumnType<Visibility, Visibility | undefined, Visibility>;
  status: ColumnType<EventStatus, EventStatus | undefined, EventStatus>;
  timezone: string;
  is_all_day: ColumnType<boolean, boolean | undefined, boolean>;
  start_date: DateCol;
  local_start_time: TimeCol | null;
  duration_minutes: number | null;
  all_day_days: number | null;
  recurrence_weekdays: number[] | null;
  recurrence_until: DateCol | null;
  room_id: string | null;
  capacity: number | null;
  version: ColumnType<number, number | undefined, number>;
  review_comment: string | null;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  submitted_at: Timestamp | null;
  legacy_import_id: string | null;
  is_demo: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface EventOccurrencesTable {
  id: Generated<string>;
  series_id: string;
  occurrence_date: DateCol;
  starts_at: Timestamp;
  ends_at: Timestamp;
  all_day_start: DateCol | null;
  all_day_end: DateCol | null;
  room_id: string | null;
  capacity: number | null;
  is_exception: ColumnType<boolean, boolean | undefined, boolean>;
  cancelled_at: Timestamp | null;
  cancel_reason: string | null;
  version: ColumnType<number, number | undefined, number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RoomReservationsTable {
  id: Generated<string>;
  room_id: string;
  occurrence_id: string;
  during: string;
  created_at: DefaultTimestamp;
}

export interface RsvpsTable {
  id: Generated<string>;
  occurrence_id: string;
  user_id: string;
  status: RsvpStatus;
  waitlist_position: ColumnType<string | null, string | number | bigint | null, string | number | bigint | null>;
  responded_at: DefaultTimestamp;
  created_at: DefaultTimestamp;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  kind: string;
  title: string;
  body: ColumnType<string, string | undefined, string>;
  occurrence_id: string | null;
  dedupe_key: string;
  email_status: ColumnType<EmailStatus, EmailStatus | undefined, EmailStatus>;
  email_attempts: ColumnType<number, number | undefined, number>;
  email_last_error: string | null;
  email_sent_at: Timestamp | null;
  created_at: DefaultTimestamp;
  read_at: Timestamp | null;
}

export interface RemindersTable {
  id: Generated<string>;
  occurrence_id: string;
  user_id: string;
  offset_minutes: number;
  event_starts_at: Timestamp;
  due_at: Timestamp;
  status: ColumnType<ReminderStatus, ReminderStatus | undefined, ReminderStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  last_error: string | null;
  job_id: string | null;
  processed_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface AuditLogTable {
  id: Generated<string>;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: ColumnType<Record<string, unknown>, string | Record<string, unknown> | undefined, never>;
  created_at: DefaultTimestamp;
}

export interface DB {
  users: UsersTable;
  sessions: SessionsTable;
  login_attempts: LoginAttemptsTable;
  user_availability: UserAvailabilityTable;
  clubs: ClubsTable;
  club_memberships: ClubMembershipsTable;
  rooms: RoomsTable;
  room_hours: RoomHoursTable;
  legacy_imports: LegacyImportsTable;
  legacy_import_rows: LegacyImportRowsTable;
  event_series: EventSeriesTable;
  event_occurrences: EventOccurrencesTable;
  room_reservations: RoomReservationsTable;
  rsvps: RsvpsTable;
  notifications: NotificationsTable;
  reminders: RemindersTable;
  audit_log: AuditLogTable;
}

export type User = Selectable<UsersTable>;
export type Series = Selectable<EventSeriesTable>;
export type Occurrence = Selectable<EventOccurrencesTable>;
export type NewOccurrence = Insertable<EventOccurrencesTable>;
export type SeriesUpdate = Updateable<EventSeriesTable>;
export type Room = Selectable<RoomsTable>;
