import type { EventStatus, Role, RsvpStatus, Visibility } from "./schemas.js";

export interface MeDTO {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  timezone: string;
  remind24h: boolean;
  remind1h: boolean;
  emailNotifications: boolean;
  organizerClubIds: string[];
  memberClubIds: string[];
}

export interface SessionDTO {
  user: MeDTO | null;
  csrfToken: string | null;
}

export interface ClubSummaryDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  color: string;
  memberCount: number;
  myRole: "member" | "organizer" | null;
  isDemo: boolean;
}

export interface ClubMemberDTO {
  userId: string;
  displayName: string;
  email: string;
  role: "member" | "organizer";
  joinedAt: string;
}

export interface RoomDTO {
  id: string;
  name: string;
  location: string;
  capacity: number;
  timezone: string;
  features: string[];
  isActive: boolean;
  hours: { weekday: number; opens: string; closes: string }[];
}

export interface OccurrenceDTO {
  id: string;
  seriesId: string;
  title: string;
  description: string;
  category: string;
  club: { id: string; name: string; color: string; slug: string };
  organizer: { id: string; displayName: string };
  room: { id: string; name: string; location: string; capacity: number } | null;
  capacity: number | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** For all-day events: first local date (inclusive) and end (exclusive). */
  allDayStart: string | null;
  allDayEnd: string | null;
  timezone: string;
  visibility: Visibility;
  /** Effective status: the series status, or `cancelled` if this occurrence was cancelled. */
  status: EventStatus;
  seriesStatus: EventStatus;
  occurrenceCancelled: boolean;
  cancelReason: string | null;
  isRecurring: boolean;
  isException: boolean;
  occurrenceVersion: number;
  seriesVersion: number;
  goingCount: number;
  waitlistCount: number;
  myRsvp: RsvpStatus | null;
  myWaitlistPosition: number | null;
  canManage: boolean;
}

export interface SeriesDTO {
  id: string;
  clubId: string;
  title: string;
  description: string;
  category: string;
  visibility: Visibility;
  status: EventStatus;
  timezone: string;
  allDay: boolean;
  startDate: string;
  startTime: string | null;
  durationMinutes: number | null;
  allDayDays: number | null;
  roomId: string | null;
  capacity: number | null;
  recurrence: { weekdays: number[]; until: string } | null;
  version: number;
  reviewComment: string | null;
  reviewedAt: string | null;
  submittedAt: string | null;
  createdBy: { id: string; displayName: string };
  occurrenceCount: number;
}

export interface OccurrencePage {
  items: OccurrenceDTO[];
  nextCursor: string | null;
}

export interface ConflictDetail {
  date: string;
  startsAt: string;
  endsAt: string;
  reason: "room_booked" | "outside_hours" | "room_inactive" | "capacity_exceeds_room" | "past";
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string[]>;
    conflicts?: ConflictDetail[];
    currentVersion?: number;
  };
}

export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string;
  occurrenceId: string | null;
  createdAt: string;
  readAt: string | null;
  emailStatus: string;
}

export interface AttendeeDTO {
  userId: string;
  displayName: string;
  status: RsvpStatus;
  waitlistPosition: number | null;
  respondedAt: string;
}

export interface AuditEntryDTO {
  id: string;
  actor: { id: string; displayName: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TimeSuggestionDTO {
  startsAt: string;
  endsAt: string;
  localDate: string;
  localStart: string;
  localEnd: string;
  room: { id: string; name: string; capacity: number; location: string };
  score: number;
  availableParticipants: number;
  unknownParticipants: { id: string; displayName: string }[];
  reasons: string[];
}

export interface FindTimesResultDTO {
  suggestions: TimeSuggestionDTO[];
  consideredSlots: number;
  roomsConsidered: number;
  participantsWithoutAvailability: { id: string; displayName: string }[];
  scoringRule: string;
}

export interface LegacyPreviewRow {
  index: number;
  title: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  status: "ok" | "invalid" | "duplicate";
  problem: string | null;
}

export interface LegacyPreviewDTO {
  fileSha256: string;
  alreadyImported: boolean;
  rows: LegacyPreviewRow[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
}

export interface UserSummaryDTO {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  disabled: boolean;
}

export interface JobHealthDTO {
  reminders: { status: string; count: number }[];
  emails: { status: string; count: number }[];
  recentFailures: {
    kind: "reminder" | "email";
    id: string;
    error: string | null;
    attempts: number;
    updatedAt: string;
  }[];
  queues: { name: string; queued: number; active: number; failed: number }[];
}
