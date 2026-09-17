/**
 * Parser for the event JSON the original browser-only calendar stored in
 * `localStorage["events"]` (see legacy/script.js). Shape:
 *
 *   [{ day: 13, month: 11, year: 2022,            // month is 1-based
 *      events: [{ title: "Chess", time: "3:30 PM - 5:00 PM" }] }]
 *
 * The old app produced times through `convertTime`, i.e. "h:mm AM - h:mm PM".
 * Parsing is deliberately strict: anything ambiguous is reported, never guessed.
 */

export interface LegacyParsedRow {
  index: number;
  title: string;
  date: string | null;
  startTime: string | null; // HH:MM 24h
  endTime: string | null; // HH:MM 24h
  problem: string | null;
}

const TWELVE_HOUR = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/;
const TWENTY_FOUR_HOUR = /^(\d{1,2}):(\d{2})$/;

export function parseLegacyClock(input: string): string | null {
  const s = input.trim();
  let m = TWELVE_HOUR.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = m[3]!.toUpperCase() === "PM";
    const h24 = (h % 12) + (pm ? 12 : 0);
    return `${String(h24).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  m = TWENTY_FOUR_HOUR.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return null;
}

function toIsoDate(year: unknown, month: unknown, day: unknown): string | null {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (![y, mo, d].every(Number.isInteger)) return null;
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return check.toISOString().startsWith(iso) ? iso : null;
}

export function parseLegacyEvents(jsonText: string): { rows: LegacyParsedRow[]; fatal: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { rows: [], fatal: "The text is not valid JSON." };
  }
  if (!Array.isArray(data)) {
    return { rows: [], fatal: "Expected a JSON array (the value of localStorage['events'])." };
  }
  const rows: LegacyParsedRow[] = [];
  let index = 0;
  for (const day of data) {
    const dayObj = (day ?? {}) as Record<string, unknown>;
    const date = toIsoDate(dayObj.year, dayObj.month, dayObj.day);
    const events = Array.isArray(dayObj.events) ? dayObj.events : null;
    if (!events) {
      rows.push({ index: index++, title: "", date, startTime: null, endTime: null, problem: "Day entry has no events list" });
      continue;
    }
    for (const ev of events) {
      const evObj = (ev ?? {}) as Record<string, unknown>;
      const title = typeof evObj.title === "string" ? evObj.title.trim() : "";
      const row: LegacyParsedRow = { index: index++, title, date, startTime: null, endTime: null, problem: null };
      rows.push(row);
      if (!date) {
        row.problem = "Invalid day/month/year";
        continue;
      }
      if (title.length === 0 || title.length > 120) {
        row.problem = "Title must be 1–120 characters";
        continue;
      }
      if (typeof evObj.time !== "string") {
        row.problem = "Missing time";
        continue;
      }
      const parts = evObj.time.split(" - ");
      if (parts.length !== 2) {
        row.problem = `Unrecognised time range "${evObj.time}"`;
        continue;
      }
      const start = parseLegacyClock(parts[0]!);
      const end = parseLegacyClock(parts[1]!);
      row.startTime = start;
      row.endTime = end;
      if (!start || !end) {
        row.problem = `Unrecognised time range "${evObj.time}"`;
      } else if (end <= start) {
        row.problem = "End time is not after start time (overnight events are not imported)";
      } else if (!(minutesBetween(start, end) >= 15)) {
        row.problem = "Events must last at least 15 minutes";
      }
    }
  }
  return { rows, fatal: null };
}

export function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh! * 60 + em! - (sh! * 60 + sm!);
}
