import { DateTime, Interval } from "luxon";
import type { OccurrenceDTO } from "@clubcal/shared";

export type View = "month" | "week" | "agenda";
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const parseDay = (iso: string | null | undefined, zone: string) => {
  const d = iso ? DateTime.fromISO(iso, { zone }) : DateTime.now().setZone(zone);
  return (d.isValid ? d : DateTime.now().setZone(zone)).startOf("day");
};

/** Sunday-start weeks, as most US school calendars display them. */
export const startOfWeek = (d: DateTime) => d.minus({ days: d.weekday % 7 }).startOf("day");

export function viewRange(view: View, anchor: DateTime): { start: DateTime; end: DateTime } {
  if (view === "month") {
    const start = startOfWeek(anchor.startOf("month"));
    return { start, end: start.plus({ days: 42 }) };
  }
  if (view === "week") {
    const start = startOfWeek(anchor);
    return { start, end: start.plus({ days: 7 }) };
  }
  return { start: anchor, end: anchor.plus({ days: 30 }) };
}

export function shiftAnchor(view: View, anchor: DateTime, dir: 1 | -1): DateTime {
  if (view === "month") return anchor.plus({ months: dir }).startOf("month");
  if (view === "week") return anchor.plus({ weeks: dir });
  return anchor.plus({ days: 30 * dir });
}

export function rangeTitle(view: View, anchor: DateTime): string {
  if (view === "month") return anchor.toFormat("LLLL yyyy");
  const { start, end } = viewRange(view, anchor);
  const last = end.minus({ days: 1 });
  const sameYear = start.year === last.year;
  return `${start.toFormat(sameYear ? "LLL d" : "LLL d, yyyy")} – ${last.toFormat(start.month === last.month && sameYear ? "d, yyyy" : "LLL d, yyyy")}`;
}

/** Local calendar days (in `zone`) an occurrence touches. All-day events use their own dates. */
export function eventDays(o: OccurrenceDTO, zone: string): string[] {
  if (o.allDay && o.allDayStart && o.allDayEnd) {
    const out: string[] = [];
    for (let d = DateTime.fromISO(o.allDayStart); d < DateTime.fromISO(o.allDayEnd); d = d.plus({ days: 1 })) out.push(d.toISODate()!);
    return out;
  }
  const s = DateTime.fromISO(o.startsAt, { zone });
  const e = DateTime.fromISO(o.endsAt, { zone }).minus({ milliseconds: 1 });
  const out: string[] = [];
  for (let d = s.startOf("day"); d <= e; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

export function groupByDay(items: OccurrenceDTO[], zone: string): Map<string, OccurrenceDTO[]> {
  const map = new Map<string, OccurrenceDTO[]>();
  for (const o of items) for (const d of eventDays(o, zone)) map.set(d, [...(map.get(d) ?? []), o]);
  for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt));
  return map;
}

export function timeLabel(o: OccurrenceDTO, zone: string): string {
  if (o.allDay) return "All day";
  const s = DateTime.fromISO(o.startsAt, { zone });
  const e = DateTime.fromISO(o.endsAt, { zone });
  return `${s.toFormat("h:mm a")} – ${e.toFormat(s.hasSame(e, "day") ? "h:mm a" : "LLL d h:mm a")}`;
}

export function fullWhen(o: OccurrenceDTO, zone: string): string {
  if (o.allDay && o.allDayStart && o.allDayEnd) {
    const s = DateTime.fromISO(o.allDayStart);
    const last = DateTime.fromISO(o.allDayEnd).minus({ days: 1 });
    return s.hasSame(last, "day") ? `${s.toFormat("cccc, LLLL d, yyyy")} · All day` : `${s.toFormat("ccc, LLL d")} – ${last.toFormat("ccc, LLL d, yyyy")} · All day`;
  }
  const s = DateTime.fromISO(o.startsAt, { zone });
  return `${s.toFormat("cccc, LLLL d, yyyy")} · ${timeLabel(o, zone)} ${s.toFormat("ZZZZ")}`;
}

export function relative(iso: string): string {
  return DateTime.fromISO(iso).toRelative({ style: "short" }) ?? "";
}

export function localDateTime(iso: string, zone: string) {
  const d = DateTime.fromISO(iso, { zone });
  return { date: d.toISODate()!, time: d.toFormat("HH:mm") };
}

/** Assigns side-by-side lanes to overlapping timed events in a single day column. */
export function layoutDay(items: OccurrenceDTO[], zone: string, day: string) {
  const dayStart = DateTime.fromISO(day, { zone });
  const dayEnd = dayStart.plus({ days: 1 });
  const blocks = items
    .filter((o) => !o.allDay)
    .map((o) => {
      const iv = Interval.fromDateTimes(DateTime.max(DateTime.fromISO(o.startsAt, { zone }), dayStart), DateTime.min(DateTime.fromISO(o.endsAt, { zone }), dayEnd));
      return { o, start: iv.start!.diff(dayStart, "minutes").minutes, end: iv.end!.diff(dayStart, "minutes").minutes, lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const laneEnds: number[] = [];
  let cluster: typeof blocks = [];
  let clusterEnd = -1;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => (c.lanes = n));
    cluster = [];
    laneEnds.length = 0;
  };
  for (const b of blocks) {
    if (b.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = b.end;
    b.lane = lane;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return blocks;
}

export const allTimeZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "UTC"];
  }
};
