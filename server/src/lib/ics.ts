import type { OccurrenceDTO } from "@clubcal/shared";

/**
 * Minimal RFC 5545 writer. Timed events are emitted in UTC (the instant is exact and
 * needs no VTIMEZONE); the event's IANA zone is recorded in X-CLUBCAL-TIMEZONE for
 * reference. All-day events use VALUE=DATE with an exclusive DTEND.
 */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds content lines to 75 octets, never splitting a UTF-8 sequence. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curLen = 0;
  let limit = 75;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, "utf8");
    if (curLen + len > limit) {
      parts.push(cur);
      cur = "";
      curLen = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const utc = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateValue = (d: string) => d.replace(/-/g, "");

export function buildCalendar(events: OccurrenceDTO[], opts: { name: string; host: string; now?: Date; publicUrl: string }): string {
  const stamp = utc((opts.now ?? new Date()).toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ClubCal//School Club Scheduling//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`,
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:occurrence-${e.id}@${opts.host}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (e.allDay && e.allDayStart && e.allDayEnd) {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(e.allDayStart)}`);
      lines.push(`DTEND;VALUE=DATE:${dateValue(e.allDayEnd)}`);
    } else {
      lines.push(`DTSTART:${utc(e.startsAt)}`);
      lines.push(`DTEND:${utc(e.endsAt)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    const desc = [e.description, `Club: ${e.club.name}`, `${opts.publicUrl}/events/${e.id}`].filter(Boolean).join("\n\n");
    lines.push(`DESCRIPTION:${escapeText(desc)}`);
    if (e.room) lines.push(`LOCATION:${escapeText(`${e.room.name}, ${e.room.location}`)}`);
    lines.push(`CATEGORIES:${escapeText(e.category)}`);
    lines.push(`STATUS:${e.status === "cancelled" ? "CANCELLED" : e.status === "approved" ? "CONFIRMED" : "TENTATIVE"}`);
    lines.push(`SEQUENCE:${e.occurrenceVersion + e.seriesVersion - 2}`);
    lines.push(`URL:${opts.publicUrl}/events/${e.id}`);
    lines.push(`X-CLUBCAL-TIMEZONE:${escapeText(e.timezone)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
