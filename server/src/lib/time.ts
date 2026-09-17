import { DateTime, IANAZone } from "luxon";

export type LocalResolution = "exact" | "gap_shifted" | "ambiguous_earlier";

export interface ResolvedInstant {
  instant: Date;
  resolution: LocalResolution;
}

const MINUTE = 60_000;

/**
 * Convert a wall-clock date+time in an IANA zone into an instant with an explicit,
 * documented policy for daylight-saving edge cases:
 *
 *  - Nonexistent local time (spring-forward gap, e.g. 02:30 on the US DST start day):
 *    interpreted with the offset in effect *before* the transition, which moves it
 *    forward by the size of the gap (02:30 → 03:30 local). Reported as `gap_shifted`.
 *  - Ambiguous local time (fall-back overlap, e.g. 01:30 on the US DST end day):
 *    the *earlier* instant (the first 01:30, still on daylight time) is chosen.
 *    Reported as `ambiguous_earlier`.
 */
export function resolveLocal(date: string, time: string, zoneName: string): ResolvedInstant {
  const zone = IANAZone.create(zoneName);
  if (!zone.isValid) throw new Error(`Invalid time zone ${zoneName}`);
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = new Set<number>([
    zone.offset(naive - 36 * 60 * MINUTE),
    zone.offset(naive),
    zone.offset(naive + 36 * 60 * MINUTE),
  ]);
  const valid: number[] = [];
  for (const off of offsets) {
    const candidate = naive - off * MINUTE;
    if (zone.offset(candidate) === off) valid.push(candidate);
  }
  valid.sort((a, b) => a - b);
  if (valid.length === 1) return { instant: new Date(valid[0]!), resolution: "exact" };
  if (valid.length > 1) return { instant: new Date(valid[0]!), resolution: "ambiguous_earlier" };
  // Gap: use the offset in effect just before the transition.
  const before = zone.offset(naive - 36 * 60 * MINUTE);
  return { instant: new Date(naive - before * MINUTE), resolution: "gap_shifted" };
}

export interface LocalParts {
  date: string;
  time: string; // HH:MM
  weekday: number; // ISO
  minutes: number; // minutes since local midnight
}

export function localParts(instant: Date, zone: string): LocalParts {
  const dt = DateTime.fromJSDate(instant, { zone });
  return {
    date: dt.toISODate()!,
    time: dt.toFormat("HH:mm"),
    weekday: dt.weekday,
    minutes: dt.hour * 60 + dt.minute,
  };
}

export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: "UTC" }).weekday;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate()!;
}

export function todayIn(zone: string, now = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toISODate()!;
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h! * 60 + m!;
}

export function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Postgres TIME comes back as HH:MM:SS; normalise to HH:MM. */
export const hhmm = (t: string) => t.slice(0, 5);

export interface SeriesShape {
  timezone: string;
  allDay: boolean;
  startDate: string;
  startTime: string | null;
  durationMinutes: number | null;
  allDayDays: number | null;
  recurrence: { weekdays: number[]; until: string } | null;
}

export interface PlannedOccurrence {
  date: string;
  startsAt: Date;
  endsAt: Date;
  allDayStart: string | null;
  allDayEnd: string | null;
  resolution: LocalResolution;
}

export const MAX_OCCURRENCES = 371;

/** Every date a series produces, in order. Weekly recurrence only, bounded by `until`. */
export function seriesDates(shape: Pick<SeriesShape, "startDate" | "recurrence">): string[] {
  if (!shape.recurrence) return [shape.startDate];
  const days = new Set(shape.recurrence.weekdays);
  const out: string[] = [];
  for (let d = shape.startDate; d <= shape.recurrence.until; d = addDays(d, 1)) {
    if (days.has(isoWeekday(d))) out.push(d);
    if (out.length > MAX_OCCURRENCES) throw new Error("Series produces too many occurrences");
  }
  return out;
}

export function planOccurrence(shape: SeriesShape, date: string, startTime = shape.startTime, durationMinutes = shape.durationMinutes): PlannedOccurrence {
  if (shape.allDay) {
    const end = addDays(date, shape.allDayDays ?? 1);
    const s = resolveLocal(date, "00:00", shape.timezone);
    const e = resolveLocal(end, "00:00", shape.timezone);
    return { date, startsAt: s.instant, endsAt: e.instant, allDayStart: date, allDayEnd: end, resolution: s.resolution };
  }
  // Local wall-clock time is preserved per occurrence; duration is elapsed time.
  const s = resolveLocal(date, startTime!, shape.timezone);
  return {
    date,
    startsAt: s.instant,
    endsAt: new Date(s.instant.getTime() + durationMinutes! * MINUTE),
    allDayStart: null,
    allDayEnd: null,
    resolution: s.resolution,
  };
}

export function planSeries(shape: SeriesShape): PlannedOccurrence[] {
  return seriesDates(shape).map((d) => planOccurrence(shape, d));
}

export function formatLocalRange(startsAt: Date, endsAt: Date, zone: string): string {
  const s = DateTime.fromJSDate(startsAt, { zone });
  const e = DateTime.fromJSDate(endsAt, { zone });
  return `${s.toFormat("ccc LLL d, h:mm a")}–${e.toFormat(s.hasSame(e, "day") ? "h:mm a" : "ccc LLL d, h:mm a")} ${s.toFormat("ZZZZ")}`;
}
