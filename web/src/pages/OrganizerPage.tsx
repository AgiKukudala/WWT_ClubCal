import { useMutation } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { DateTime } from "luxon";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { FindTimesResultDTO } from "@clubcal/shared";
import { ApiError, api } from "../api/client";
import { useClubMembers, useClubs, useManagedSeries, useRooms } from "../api/hooks";
import { canManageClub, useUser } from "../auth";
import { ApiErrorAlert, Button, EmptyState, ErrorState, Field, PageHeader, Spinner, StatusBadge } from "../components/ui";

const STATUSES = ["", "draft", "pending", "rejected", "approved", "cancelled"] as const;

function MyEvents() {
  const me = useUser();
  const [status, setStatus] = useState<string>("");
  const series = useManagedSeries(status || undefined);
  return (
    <div className="stack">
      <div className="segmented" role="tablist" aria-label="Filter by status">
        {STATUSES.map((s) => (
          <button key={s || "all"} role="tab" aria-selected={status === s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
            {s ? <StatusBadge status={s} /> : "All"}
          </button>
        ))}
      </div>
      {series.isPending ? (
        <Spinner />
      ) : series.isError ? (
        <ErrorState error={series.error} onRetry={() => series.refetch()} />
      ) : series.data.items.length === 0 ? (
        <EmptyState title="No events here">
          <Link to="/events/new">Create an event</Link> for one of your clubs.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Club</th>
                <th scope="col">First date</th>
                <th scope="col">Status</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {series.data.items.map((s) => (
                <tr key={s.seriesId}>
                  <td>
                    {s.firstOccurrenceId ? <Link to={`/events/${s.firstOccurrenceId}`}>{s.title}</Link> : s.title}
                    {s.isRecurring && <span className="muted small"> · weekly</span>}
                    {s.status === "rejected" && s.reviewComment && <div className="small muted">“{s.reviewComment}”</div>}
                  </td>
                  <td>
                    <span className="club-badge">
                      <span className="dot" style={{ background: s.club.color }} aria-hidden />
                      {s.club.name}
                    </span>
                  </td>
                  <td>{s.firstStartsAt ? DateTime.fromISO(s.firstStartsAt).setZone(me.timezone).toFormat("ccc LLL d, h:mm a") : "—"}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="muted small">{DateTime.fromISO(s.updatedAt).toRelative()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FindTimes() {
  const me = useUser();
  const clubs = useClubs();
  const rooms = useRooms();
  const manageable = useMemo(() => (clubs.data?.items ?? []).filter((c) => canManageClub(me, c.id)), [clubs.data, me]);
  const today = DateTime.now().setZone(me.timezone);
  const [form, setForm] = useState({
    clubId: "",
    durationMinutes: 60,
    from: today.plus({ days: 1 }).toISODate()!,
    to: today.plus({ days: 7 }).toISODate()!,
    minCapacity: 10,
    requiredFeatures: "",
    roomIds: [] as string[],
    participantIds: [] as string[],
    earliest: "14:30",
    latest: "18:00",
  });
  const clubId = form.clubId || manageable[0]?.id || "";
  const members = useClubMembers(clubId, Boolean(clubId));
  const search = useMutation({
    mutationFn: () =>
      api.post<FindTimesResultDTO>("/api/scheduling/find-times", {
        durationMinutes: Number(form.durationMinutes),
        from: form.from,
        to: form.to,
        timezone: me.timezone,
        minCapacity: Number(form.minCapacity),
        requiredFeatures: form.requiredFeatures.split(",").map((s) => s.trim()).filter(Boolean),
        roomIds: form.roomIds,
        participantIds: form.participantIds,
        earliest: form.earliest,
        latest: form.latest,
      }),
  });
  const err = search.error instanceof ApiError ? search.error : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search.mutate();
  };
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="stack">
      <p className="muted">
        Finds 15-minute-aligned slots where a room is open and free and every selected participant who declared availability is free. Suggestions are advice only —
        the booking is checked again when the event is approved.
      </p>
      <form className="panel stack" onSubmit={submit}>
        <div className="grid-3">
          <Field label="Duration (minutes)" error={err?.fields.durationMinutes}>
            {(p) => <input {...p} type="number" min={15} max={480} step={15} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />}
          </Field>
          <Field label="From date" error={err?.fields.from}>
            {(p) => <input {...p} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}
          </Field>
          <Field label="To date" error={err?.fields.to} hint="Up to 14 days.">
            {(p) => <input {...p} type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}
          </Field>
          <Field label="Earliest start">{(p) => <input {...p} type="time" value={form.earliest} onChange={(e) => setForm({ ...form, earliest: e.target.value })} />}</Field>
          <Field label="Latest end" error={err?.fields.latest}>
            {(p) => <input {...p} type="time" value={form.latest} onChange={(e) => setForm({ ...form, latest: e.target.value })} />}
          </Field>
          <Field label="Seats needed">{(p) => <input {...p} type="number" min={1} value={form.minCapacity} onChange={(e) => setForm({ ...form, minCapacity: Number(e.target.value) })} />}</Field>
        </div>
        <Field label="Required room features" hint="Comma separated, e.g. projector, 3d-printers">
          {(p) => <input {...p} value={form.requiredFeatures} onChange={(e) => setForm({ ...form, requiredFeatures: e.target.value })} />}
        </Field>
        <fieldset>
          <legend>Rooms to consider (none selected = all)</legend>
          <div className="checks">
            {rooms.data?.items
              .filter((r) => r.isActive)
              .map((r) => (
                <label className="check" key={r.id}>
                  <input type="checkbox" checked={form.roomIds.includes(r.id)} onChange={() => setForm({ ...form, roomIds: toggle(form.roomIds, r.id) })} />
                  {r.name} <span className="muted small">({r.capacity}{r.features.length ? `; ${r.features.join(", ")}` : ""})</span>
                </label>
              ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Participants</legend>
          <label>
            <span className="small muted">From club </span>
            <select value={clubId} onChange={(e) => setForm({ ...form, clubId: e.target.value, participantIds: [] })}>
              {manageable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="checks">
            {members.data?.items.map((m) => (
              <label className="check" key={m.userId}>
                <input type="checkbox" checked={form.participantIds.includes(m.userId)} onChange={() => setForm({ ...form, participantIds: toggle(form.participantIds, m.userId) })} />
                {m.displayName}
              </label>
            ))}
            {members.data?.items.length === 0 && <span className="muted">This club has no members yet.</span>}
          </div>
        </fieldset>
        <ApiErrorAlert error={search.error} />
        <div>
          <Button type="submit" variant="primary" busy={search.isPending}>
            <Sparkles size={16} aria-hidden /> Find available times
          </Button>
        </div>
      </form>

      {search.data && (
        <section className="stack-sm" aria-live="polite">
          <h2 className="section-title">
            {search.data.suggestions.length ? `Top ${search.data.suggestions.length} suggestions` : "No slots found"}
          </h2>
          <p className="small muted">
            Checked {search.data.consideredSlots} time slots across {search.data.roomsConsidered} room{search.data.roomsConsidered === 1 ? "" : "s"}. {search.data.scoringRule}
          </p>
          {search.data.participantsWithoutAvailability.length > 0 && (
            <div className="alert alert-warning">
              Availability unknown for: {search.data.participantsWithoutAvailability.map((p) => p.displayName).join(", ")}. They haven't declared availability, so they may
              not actually be free.
            </div>
          )}
          {search.data.suggestions.length === 0 && <p className="muted">Try a longer date range, a shorter meeting, fewer required participants, or other rooms.</p>}
          <ol className="suggestions">
            {search.data.suggestions.map((s) => (
              <li key={`${s.startsAt}-${s.room.id}`} className="panel">
                <div className="row between wrap">
                  <strong>
                    {DateTime.fromISO(s.localDate).toFormat("ccc, LLL d")} · {DateTime.fromFormat(s.localStart, "HH:mm").toFormat("h:mm a")}–
                    {DateTime.fromFormat(s.localEnd, "HH:mm").toFormat("h:mm a")} · {s.room.name}
                  </strong>
                  <span className="badge">Score {s.score}</span>
                </div>
                <ul className="small">
                  {s.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <Link
                  className="btn btn-secondary"
                  to={`/events/new?club=${clubId}&date=${s.localDate}&time=${s.localStart}&duration=${form.durationMinutes}&room=${s.room.id}`}
                >
                  <Plus size={16} aria-hidden /> Use this time
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

export function OrganizerPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "find" ? "find" : "events";
  return (
    <div className="stack">
      <PageHeader title="Organizer" subtitle="Plan meetings, book rooms and track approvals for your clubs.">
        <Link className="btn btn-primary" to="/events/new">
          <Plus size={16} aria-hidden /> New event
        </Link>
      </PageHeader>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "events"} className={tab === "events" ? "on" : ""} onClick={() => setParams({})}>
          My club events
        </button>
        <button role="tab" aria-selected={tab === "find"} className={tab === "find" ? "on" : ""} onClick={() => setParams({ tab: "find" })}>
          Find available times
        </button>
      </div>
      <div role="tabpanel">{tab === "events" ? <MyEvents /> : <FindTimes />}</div>
    </div>
  );
}
