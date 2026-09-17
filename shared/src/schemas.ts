import { z } from "zod";

export const ROLES = ["admin", "organizer", "student"] as const;
export type Role = (typeof ROLES)[number];

export const EVENT_STATUSES = ["draft", "pending", "approved", "rejected", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const VISIBILITIES = ["public", "club"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const RSVP_STATUSES = ["going", "not_going", "waitlisted"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** Hard upper bound on occurrences a series may materialize (7 weekdays × 53 weeks). */
export const MAX_SERIES_OCCURRENCES = 371;
/** Maximum span of a single calendar range query. */
export const MAX_RANGE_DAYS = 100;
export const SLOT_MINUTES = 15;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const uuid = z.uuid();
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Not a real calendar date");
export const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");
export const timeZone = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown IANA time zone");
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB color");
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const registerSchema = z.object({
  email,
  displayName: trimmed(1, 100),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  timezone: timeZone.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export const preferencesSchema = z.object({
  displayName: trimmed(1, 100).optional(),
  timezone: timeZone.optional(),
  remind24h: z.boolean().optional(),
  remind1h: z.boolean().optional(),
  emailNotifications: z.boolean().optional(),
});

export const availabilityWindowSchema = z
  .object({ weekday: z.number().int().min(1).max(7), start: localTime, end: localTime })
  .refine((w) => w.start < w.end, { message: "End must be after start", path: ["end"] });
export const availabilitySchema = z.object({
  windows: z.array(availabilityWindowSchema).max(50),
});

export const recurrenceSchema = z.object({
  /** ISO weekdays: 1 = Monday … 7 = Sunday */
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  until: isoDate,
});
export type RecurrenceInput = z.infer<typeof recurrenceSchema>;

/** The same calendar date one year later (Feb 29 maps to Mar 1). A series must end before it. */
export function oneYearAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const eventFields = {
  clubId: uuid,
  title: trimmed(1, 120),
  description: z.string().trim().max(5000).default(""),
  category: trimmed(1, 40),
  visibility: z.enum(VISIBILITIES),
  timezone: timeZone,
  allDay: z.boolean(),
  startDate: isoDate,
  startTime: localTime.nullish(),
  durationMinutes: z.number().int().min(15).max(1440).nullish(),
  allDayDays: z.number().int().min(1).max(14).nullish(),
  roomId: uuid.nullish(),
  capacity: z.number().int().min(1).max(10000).nullish(),
  recurrence: recurrenceSchema.nullish(),
};

type EventShape = {
  allDay: boolean;
  startDate: string;
  startTime?: string | null;
  durationMinutes?: number | null;
  allDayDays?: number | null;
  roomId?: string | null;
  recurrence?: RecurrenceInput | null;
};

function refineEvent(v: EventShape, ctx: z.RefinementCtx) {
  if (v.allDay) {
    if (v.startTime) ctx.addIssue({ code: "custom", path: ["startTime"], message: "All-day events have no start time" });
    if (v.roomId) ctx.addIssue({ code: "custom", path: ["roomId"], message: "Room bookings require a timed event" });
  } else {
    if (!v.startTime) ctx.addIssue({ code: "custom", path: ["startTime"], message: "Start time is required" });
    if (!v.durationMinutes) ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "Duration is required" });
  }
  if (v.recurrence) {
    const span = daysBetween(v.startDate, v.recurrence.until);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["recurrence", "until"], message: "End date must be on or after the start date" });
    if (v.recurrence.until >= oneYearAfter(v.startDate)) ctx.addIssue({ code: "custom", path: ["recurrence", "until"], message: "A series may span at most one year" });
  }
}

export const createEventSchema = z
  .object({ ...eventFields, submit: z.boolean().default(false) })
  .superRefine(refineEvent);
export type CreateEventInput = z.infer<typeof createEventSchema>;

/** Whole-series edit. All scheduling fields are resent so the server can revalidate everything. */
export const updateSeriesSchema = z
  .object({ ...eventFields, expectedVersion: z.number().int().min(1) })
  .omit({ clubId: true })
  .superRefine(refineEvent);
export type UpdateSeriesInput = z.infer<typeof updateSeriesSchema>;

/** Single-occurrence edit: only scheduling fields may differ from the series. */
export const updateOccurrenceSchema = z.object({
  expectedVersion: z.number().int().min(1),
  date: isoDate,
  startTime: localTime,
  durationMinutes: z.number().int().min(15).max(1440),
  roomId: uuid.nullable(),
  capacity: z.number().int().min(1).max(10000).nullable(),
});
export type UpdateOccurrenceInput = z.infer<typeof updateOccurrenceSchema>;

export const cancelSchema = z.object({
  scope: z.enum(["occurrence", "series"]),
  reason: z.string().trim().max(500).default(""),
});

export const submitSchema = z.object({ expectedVersion: z.number().int().min(1) });

export const reviewSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    comment: z.string().trim().max(1000).default(""),
    expectedVersion: z.number().int().min(1),
  })
  .refine((v) => v.decision === "approve" || v.comment.length > 0, {
    message: "A comment is required when rejecting",
    path: ["comment"],
  });

export const rsvpSchema = z.object({ response: z.enum(["going", "not_going"]) });

export const occurrenceQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    clubId: uuid.optional(),
    roomId: uuid.optional(),
    category: z.string().trim().min(1).max(40).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    mine: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    cursor: z.string().max(200).optional(),
  })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from), { message: "`to` must be after `from`", path: ["to"] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= MAX_RANGE_DAYS * 86_400_000, {
    message: `Range may not exceed ${MAX_RANGE_DAYS} days`,
    path: ["to"],
  });

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes")
  .max(60);

export const clubSchema = z.object({
  name: trimmed(2, 80),
  slug,
  description: z.string().trim().max(2000).default(""),
  category: trimmed(1, 40),
  color: hexColor,
});
export const updateClubSchema = clubSchema.partial();

export const memberRoleSchema = z.object({
  userId: uuid,
  role: z.enum(["member", "organizer"]),
});

export const roomHoursSchema = z
  .object({ weekday: z.number().int().min(1).max(7), opens: localTime, closes: localTime })
  .refine((h) => h.opens < h.closes, { message: "Closing must be after opening", path: ["closes"] });

export const roomSchema = z.object({
  name: trimmed(1, 80),
  location: trimmed(1, 120),
  capacity: z.number().int().min(1).max(10000),
  timezone: timeZone,
  features: z.array(trimmed(1, 40)).max(20).default([]),
  isActive: z.boolean().default(true),
  hours: z
    .array(roomHoursSchema)
    .max(7)
    .refine((hs) => new Set(hs.map((h) => h.weekday)).size === hs.length, "One window per weekday"),
});

export const userRoleSchema = z.object({ role: z.enum(ROLES) });

export const findTimesSchema = z
  .object({
    durationMinutes: z.number().int().min(15).max(480),
    from: isoDate,
    to: isoDate,
    timezone: timeZone,
    minCapacity: z.number().int().min(1).max(10000).default(1),
    requiredFeatures: z.array(trimmed(1, 40)).max(10).default([]),
    roomIds: z.array(uuid).max(50).default([]),
    participantIds: z.array(uuid).max(100).default([]),
    earliest: localTime.default("07:00"),
    latest: localTime.default("21:00"),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .refine((v) => v.to >= v.from, { message: "End date must be on or after start date", path: ["to"] })
  .refine((v) => daysBetween(v.from, v.to) <= 13, { message: "Search at most 14 days at a time", path: ["to"] })
  .refine((v) => v.earliest < v.latest, { message: "Latest must be after earliest", path: ["latest"] });
export type FindTimesInput = z.infer<typeof findTimesSchema>;

export const legacyImportSchema = z.object({
  clubId: uuid,
  timezone: timeZone,
  category: trimmed(1, 40).default("General"),
  visibility: z.enum(VISIBILITIES).default("public"),
  /** Raw JSON text copied from the old app's localStorage["events"] value. */
  json: z.string().min(2).max(2_000_000),
});
