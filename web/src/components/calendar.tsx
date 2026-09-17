import { DateTime } from "luxon";
import { MapPin, Repeat, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { OccurrenceDTO } from "@clubcal/shared";
import { groupByDay, layoutDay, timeLabel, viewRange, WEEKDAYS } from "../lib/dates";
import { StatusBadge } from "./ui";

/** Event titles and descriptions are always rendered as React text nodes — never as HTML. */
export function EventChip({ o, zone }: { o: OccurrenceDTO; zone: string }) {
  const start = DateTime.fromISO(o.startsAt, { zone });
  return (
    <Link
      to={`/events/${o.id}`}
      className={`chip ${o.status === "cancelled" ? "is-cancelled" : ""} ${o.status !== "approved" && o.status !== "cancelled" ? "is-tentative" : ""}`}
      style={{ ["--club" as string]: o.club.color }}
      title={`${o.title} · ${o.club.name} · ${timeLabel(o, zone)}`}
    >
      {!o.allDay && <span className="chip-time">{start.toFormat(start.minute ? "h:mm" : "h")}{start.toFormat("a").toLowerCase()[0]}</span>}
      <span className="chip-title">{o.title}</span>
    </Link>
  );
}

export function RsvpPill({ o }: { o: OccurrenceDTO }) {
  if (o.myRsvp === "going") return <span className="badge rsvp-going">Going</span>;
  if (o.myRsvp === "waitlisted") return <span className="badge rsvp-wait">Waitlist #{o.myWaitlistPosition}</span>;
  return null;
}

export function EventCard({ o, zone }: { o: OccurrenceDTO; zone: string }) {
  const full = o.capacity !== null && o.goingCount >= o.capacity;
  return (
    <article className={`event-card ${o.status === "cancelled" ? "is-cancelled" : ""}`} style={{ ["--club" as string]: o.club.color }}>
      <div className="event-card-time">
        <span>{timeLabel(o, zone)}</span>
      </div>
      <div className="event-card-main">
        <h3>
          <Link to={`/events/${o.id}`}>{o.title}</Link>
        </h3>
        <div className="meta">
          <span className="club-badge">
            <span className="dot" style={{ background: o.club.color }} aria-hidden />
            {o.club.name}
          </span>
          {o.room && (
            <span>
              <MapPin size={14} aria-hidden /> {o.room.name}
            </span>
          )}
          {o.capacity !== null && (
            <span>
              <Users size={14} aria-hidden /> {o.goingCount}/{o.capacity}
              {full ? " · full" : ""}
              {o.waitlistCount > 0 ? ` · ${o.waitlistCount} waiting` : ""}
            </span>
          )}
          {o.isRecurring && (
            <span>
              <Repeat size={14} aria-hidden /> Recurring
            </span>
          )}
        </div>
      </div>
      <div className="event-card-side">
        {o.status !== "approved" && <StatusBadge status={o.status} />}
        {o.visibility === "club" && <span className="badge">Members only</span>}
        <RsvpPill o={o} />
      </div>
    </article>
  );
}

export function MonthView({ anchor, items, zone, onPickDay }: { anchor: DateTime; items: OccurrenceDTO[]; zone: string; onPickDay: (d: string) => void }) {
  const { start } = viewRange("month", anchor);
  const byDay = groupByDay(items, zone);
  const today = DateTime.now().setZone(zone).toISODate();
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => start.plus({ days: w * 7 + d })));
  const heads = ["Sun", ...WEEKDAYS.slice(0, 6)];
  return (
    <div className="month" role="grid" aria-label={anchor.toFormat("LLLL yyyy")}>
      <div className="month-head" role="row">
        {heads.map((h) => (
          <div key={h} role="columnheader">
            {h}
          </div>
        ))}
      </div>
      {weeks.map((week, i) => (
        <div className="month-row" role="row" key={i}>
          {week.map((day) => {
            const iso = day.toISODate()!;
            const list = byDay.get(iso) ?? [];
            const inMonth = day.month === anchor.month;
            return (
              <div key={iso} role="gridcell" className={`day ${inMonth ? "" : "outside"} ${iso === today ? "today" : ""}`}>
                <button className="day-num" onClick={() => onPickDay(iso)} aria-label={`${day.toFormat("cccc, LLLL d")}, ${list.length} event${list.length === 1 ? "" : "s"}. Open week view.`}>
                  {day.day}
                </button>
                <div className="day-events">
                  {list.slice(0, 3).map((o) => (
                    <EventChip key={o.id} o={o} zone={zone} />
                  ))}
                  {list.length > 3 && (
                    <button className="more" onClick={() => onPickDay(iso)}>
                      +{list.length - 3} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const HOUR_PX = 44;
const FIRST_HOUR = 0;
const LAST_HOUR = 24;

export function WeekView({ anchor, items, zone }: { anchor: DateTime; items: OccurrenceDTO[]; zone: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Start the scrollable day at 7 AM.
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
  }, []);
  const { start } = viewRange("week", anchor);
  const days = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
  const byDay = groupByDay(items, zone);
  const today = DateTime.now().setZone(zone).toISODate();
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
  return (
    <div className="week" aria-label="Week view">
      <div className="week-head">
        <div />
        {days.map((d) => (
          <div key={d.toISODate()} className={d.toISODate() === today ? "today" : ""}>
            <span className="muted small">{d.toFormat("ccc")}</span> <strong>{d.day}</strong>
          </div>
        ))}
      </div>
      <div className="week-allday">
        <div className="muted small">All day</div>
        {days.map((d) => (
          <div key={d.toISODate()}>
            {(byDay.get(d.toISODate()!) ?? [])
              .filter((o) => o.allDay)
              .map((o) => (
                <EventChip key={o.id} o={o} zone={zone} />
              ))}
          </div>
        ))}
      </div>
      <div className="week-scroll" ref={scrollRef}>
      <div className="week-body" style={{ height: hours.length * HOUR_PX }}>
        <div className="week-hours">
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR_PX }} className="muted small">
              {DateTime.fromObject({ hour: h }).toFormat("h a")}
            </div>
          ))}
        </div>
        {days.map((d) => {
          const iso = d.toISODate()!;
          const blocks = layoutDay(byDay.get(iso) ?? [], zone, iso);
          return (
            <div key={iso} className={`week-col ${iso === today ? "today" : ""}`} aria-label={d.toFormat("cccc LLLL d")}>
              {hours.map((h) => (
                <div key={h} className="hour-line" style={{ height: HOUR_PX }} />
              ))}
              {blocks.map((b) => {
                const top = Math.max(0, ((b.start - FIRST_HOUR * 60) / 60) * HOUR_PX);
                const bottom = Math.min(hours.length * HOUR_PX, ((b.end - FIRST_HOUR * 60) / 60) * HOUR_PX);
                const height = Math.max(20, bottom - top);
                return (
                  <Link
                    key={b.o.id}
                    to={`/events/${b.o.id}`}
                    className={`block ${b.o.status === "cancelled" ? "is-cancelled" : ""} ${b.o.status !== "approved" && b.o.status !== "cancelled" ? "is-tentative" : ""}`}
                    style={{ top, height, left: `${(b.lane / b.lanes) * 100}%`, width: `${100 / b.lanes}%`, ["--club" as string]: b.o.club.color }}
                  >
                    <strong>{b.o.title}</strong>
                    <span>{timeLabel(b.o, zone)}</span>
                    {b.o.room && <span>{b.o.room.name}</span>}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

export function AgendaList({ items, zone, emptyTitle = "No events in this range" }: { items: OccurrenceDTO[]; zone: string; emptyTitle?: string }) {
  const byDay = groupByDay(items, zone);
  const days = [...byDay.keys()].sort();
  if (days.length === 0) {
    return (
      <div className="state empty">
        <strong>{emptyTitle}</strong>
        <span className="muted">Try another date range or clear the filters.</span>
      </div>
    );
  }
  const today = DateTime.now().setZone(zone).toISODate();
  return (
    <div className="agenda">
      {days.map((d) => (
        <section key={d} className="agenda-day" aria-labelledby={`agenda-${d}`}>
          <h2 id={`agenda-${d}`} className={d === today ? "today" : ""}>
            {DateTime.fromISO(d).toFormat("cccc, LLLL d")}
            {d === today && <span className="badge">Today</span>}
          </h2>
          <div className="stack-sm">
            {byDay.get(d)!.map((o) => (
              <EventCard key={`${d}-${o.id}`} o={o} zone={zone} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
