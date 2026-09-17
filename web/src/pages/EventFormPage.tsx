import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { oneYearAfter, type SeriesDTO } from "@clubcal/shared";
import { ApiError, api } from "../api/client";
import { useClubs, useRefreshEvents, useRooms, useSeries, useSeriesOccurrences } from "../api/hooks";
import { canManageClub, useUser } from "../auth";
import { Alert, ApiErrorAlert, Button, ErrorState, Field, PageHeader, Spinner, useToast } from "../components/ui";
import { allTimeZones, WEEKDAY_LONG, WEEKDAYS } from "../lib/dates";

interface FormState {
  clubId: string;
  title: string;
  description: string;
  category: string;
  visibility: "public" | "club";
  timezone: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  durationMinutes: number;
  allDayDays: number;
  roomId: string;
  capacity: string;
  repeat: boolean;
  weekdays: number[];
  until: string;
}

const DURATIONS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480];

function fromSeries(s: SeriesDTO): FormState {
  return {
    clubId: s.clubId,
    title: s.title,
    description: s.description,
    category: s.category,
    visibility: s.visibility,
    timezone: s.timezone,
    allDay: s.allDay,
    startDate: s.startDate,
    startTime: s.startTime ?? "15:00",
    durationMinutes: s.durationMinutes ?? 60,
    allDayDays: s.allDayDays ?? 1,
    roomId: s.roomId ?? "",
    capacity: s.capacity === null ? "" : String(s.capacity),
    repeat: s.recurrence !== null,
    weekdays: s.recurrence?.weekdays ?? [],
    until: s.recurrence?.until ?? "",
  };
}

export function EventFormPage() {
  const me = useUser();
  const { seriesId } = useParams();
  const [params] = useSearchParams();
  const editing = Boolean(seriesId);
  const series = useSeries(seriesId);
  const occurrences = useSeriesOccurrences(seriesId, editing);
  const clubs = useClubs();
  const rooms = useRooms();
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useRefreshEvents();
  const qc = useQueryClient();
  const tomorrow = DateTime.now().setZone(me.timezone).plus({ days: 1 }).toISODate()!;

  const [form, setForm] = useState<FormState>(() => ({
    clubId: params.get("club") ?? "",
    title: "",
    description: "",
    category: "",
    visibility: "public",
    timezone: me.timezone,
    allDay: false,
    startDate: params.get("date") ?? tomorrow,
    startTime: params.get("time") ?? "15:30",
    durationMinutes: Number(params.get("duration") ?? 60),
    allDayDays: 1,
    roomId: params.get("room") ?? "",
    capacity: "",
    repeat: false,
    weekdays: [],
    until: "",
  }));
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  useEffect(() => {
    if (series.data && loadedVersion === null) {
      setForm(fromSeries(series.data));
      setLoadedVersion(series.data.version);
    }
  }, [series.data, loadedVersion]);

  const manageable = useMemo(() => (clubs.data?.items ?? []).filter((c) => canManageClub(me, c.id)), [clubs.data, me]);
  useEffect(() => {
    if (!editing && !form.clubId && manageable.length > 0) {
      const c = manageable[0]!;
      setForm((f) => ({ ...f, clubId: c.id, category: f.category || c.category }));
    }
  }, [manageable, editing, form.clubId]);

  const room = rooms.data?.items.find((r) => r.id === form.roomId);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const maxUntil = form.startDate ? DateTime.fromISO(oneYearAfter(form.startDate)).minus({ days: 1 }).toISODate()! : undefined;

  const payload = (submit: boolean) => ({
    clubId: form.clubId,
    title: form.title,
    description: form.description,
    category: form.category,
    visibility: form.visibility,
    timezone: form.timezone,
    allDay: form.allDay,
    startDate: form.startDate,
    startTime: form.allDay ? null : form.startTime,
    durationMinutes: form.allDay ? null : Number(form.durationMinutes),
    allDayDays: form.allDay ? Number(form.allDayDays) : null,
    roomId: form.allDay || !form.roomId ? null : form.roomId,
    capacity: form.capacity === "" ? null : Number(form.capacity),
    recurrence: form.repeat ? { weekdays: form.weekdays, until: form.until } : null,
    ...(editing ? { expectedVersion: loadedVersion } : { submit }),
  });

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      if (editing) return api.put<SeriesDTO>(`/api/series/${seriesId}`, payload(false));
      return api.post<{ seriesId: string; status: string; firstOccurrenceId: string }>("/api/series", payload(submit));
    },
    onSuccess: async (res) => {
      await refresh();
      if (editing) {
        const s = res as SeriesDTO;
        toast(s.status === "pending" && series.data?.status === "approved" ? "Saved. The changes need re-approval before students see them." : "Changes saved.");
        await qc.invalidateQueries({ queryKey: ["series", seriesId] });
        const first = occurrences.data?.items.find((o) => o.status !== "cancelled") ?? occurrences.data?.items[0];
        navigate(first ? `/events/${first.id}` : "/organizer");
      } else {
        const r = res as { status: string; firstOccurrenceId: string };
        toast(r.status === "approved" ? "Event published." : r.status === "pending" ? "Submitted for approval." : "Draft saved.");
        navigate(`/events/${r.firstOccurrenceId}`);
      }
    },
  });

  const err = save.error instanceof ApiError ? save.error : null;
  const fieldErr = (k: string) => err?.fields[k];
  const clientProblems: string[] = [];
  if (form.repeat && form.weekdays.length === 0) clientProblems.push("Pick at least one weekday.");
  if (form.repeat && !form.until) clientProblems.push("Choose when the series ends.");
  if (room && form.capacity && Number(form.capacity) > room.capacity) clientProblems.push(`${room.name} only holds ${room.capacity}.`);

  const onSubmit = (submit: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    if (clientProblems.length) return;
    save.mutate(submit);
  };

  if (editing && series.isPending) return <Spinner />;
  if (editing && series.isError) return <ErrorState error={series.error} />;
  if (!editing && clubs.data && manageable.length === 0) {
    return <ErrorState error={new Error("You aren't an organizer for any club yet. Ask an administrator to assign you.")} />;
  }
  const versionConflict = err?.code === "version_conflict";
  const wasApproved = series.data?.status === "approved";

  return (
    <div className="stack narrow">
      <PageHeader
        title={editing ? `Edit ${series.data?.recurrence ? "series" : "event"}` : "New event"}
        subtitle={editing ? "Changes apply to every upcoming date in this series. Past dates are not changed." : "Drafts are private to your club's organizers until approved."}
      />
      {editing && wasApproved && me.role !== "admin" && (
        <Alert kind="info">This event is published. Changing its date, time, room, capacity or repeat pattern will send it back for administrator approval and release its room until then.</Alert>
      )}
      {versionConflict && (
        <Alert kind="warning">
          Someone else changed this event while you were editing.{" "}
          <Button
            variant="ghost"
            onClick={() => {
              setLoadedVersion(null);
              save.reset();
              void series.refetch();
            }}
          >
            Load the latest version
          </Button>{" "}
          (your unsaved edits will be replaced).
        </Alert>
      )}
      {!versionConflict && <ApiErrorAlert error={save.error} />}
      <form className="panel stack" onSubmit={onSubmit(!editing)} noValidate>
        <fieldset className="stack">
          <legend>Basics</legend>
          <Field label="Club" error={fieldErr("clubId")}>
            {(p) => (
              <select {...p} value={form.clubId} disabled={editing} required onChange={(e) => set("clubId", e.target.value)}>
                {editing && series.data && !manageable.some((c) => c.id === series.data.clubId) && <option value={series.data.clubId}>Current club</option>}
                {manageable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Title" error={fieldErr("title")}>
            {(p) => <input {...p} value={form.title} maxLength={120} required onChange={(e) => set("title", e.target.value)} />}
          </Field>
          <Field label="Description" error={fieldErr("description")} hint="Plain text. Line breaks are kept.">
            {(p) => <textarea {...p} rows={4} maxLength={5000} value={form.description} onChange={(e) => set("description", e.target.value)} />}
          </Field>
          <div className="grid-2">
            <Field label="Category" error={fieldErr("category")} hint="e.g. STEM, Arts, Service">
              {(p) => <input {...p} value={form.category} maxLength={40} required list="category-options" onChange={(e) => set("category", e.target.value)} />}
            </Field>
            <fieldset className="field">
              <legend>Who can see it</legend>
              <label className="check">
                <input type="radio" name="visibility" checked={form.visibility === "public"} onChange={() => set("visibility", "public")} /> Everyone at school
              </label>
              <label className="check">
                <input type="radio" name="visibility" checked={form.visibility === "club"} onChange={() => set("visibility", "club")} /> Club members only
              </label>
            </fieldset>
          </div>
          <datalist id="category-options">
            {[...new Set((clubs.data?.items ?? []).map((c) => c.category))].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </fieldset>

        <fieldset className="stack">
          <legend>When</legend>
          <label className="check">
            <input type="checkbox" checked={form.allDay} onChange={(e) => set("allDay", e.target.checked)} /> All-day event (no room booking)
          </label>
          <div className="grid-3">
            <Field label={form.repeat ? "First date" : "Date"} error={fieldErr("startDate")}>
              {(p) => <input {...p} type="date" value={form.startDate} required onChange={(e) => set("startDate", e.target.value)} />}
            </Field>
            {form.allDay ? (
              <Field label="Number of days" error={fieldErr("allDayDays")}>
                {(p) => <input {...p} type="number" min={1} max={14} value={form.allDayDays} onChange={(e) => set("allDayDays", Number(e.target.value))} />}
              </Field>
            ) : (
              <>
                <Field label="Start time" error={fieldErr("startTime")}>
                  {(p) => <input {...p} type="time" step={300} value={form.startTime} required onChange={(e) => set("startTime", e.target.value)} />}
                </Field>
                <Field label="Duration" error={fieldErr("durationMinutes")}>
                  {(p) => (
                    <select {...p} value={form.durationMinutes} onChange={(e) => set("durationMinutes", Number(e.target.value))}>
                      {[...new Set([...DURATIONS, form.durationMinutes])].sort((a, b) => a - b).map((d) => (
                        <option key={d} value={d}>
                          {d < 60 ? `${d} min` : `${Math.floor(d / 60)} h${d % 60 ? ` ${d % 60} min` : ""}`}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </>
            )}
          </div>
          <Field label="Time zone" error={fieldErr("timezone")} hint="The meeting keeps this local time, even across daylight-saving changes.">
            {(p) => (
              <select {...p} value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {allTimeZones().map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.repeat} onChange={(e) => set("repeat", e.target.checked)} /> Repeats weekly
          </label>
          {form.repeat && (
            <div className="repeat-box stack">
              <fieldset>
                <legend>On these days</legend>
                <div className="row wrap">
                  {WEEKDAYS.map((d, i) => (
                    <label key={d} className="day-toggle">
                      <input
                        type="checkbox"
                        checked={form.weekdays.includes(i + 1)}
                        onChange={(e) => set("weekdays", e.target.checked ? [...form.weekdays, i + 1].sort() : form.weekdays.filter((w) => w !== i + 1))}
                      />
                      <span aria-label={WEEKDAY_LONG[i]}>{d}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Last date" error={fieldErr("recurrence.until")} hint="Series can run for up to one year.">
                {(p) => <input {...p} type="date" min={form.startDate} max={maxUntil} value={form.until} onChange={(e) => set("until", e.target.value)} />}
              </Field>
              <p className="small muted">Only weekly repetition with an end date is supported. Individual dates can be rescheduled or cancelled afterwards.</p>
            </div>
          )}
        </fieldset>

        <fieldset className="stack">
          <legend>Where & how many</legend>
          {!form.allDay && (
            <Field
              label="Room"
              error={fieldErr("roomId")}
              hint={
                room ? (
                  <>
                    {room.location} · seats {room.capacity} · open{" "}
                    {room.hours.length ? room.hours.map((h) => `${WEEKDAYS[h.weekday - 1]} ${h.opens}–${h.closes}`).join(", ") : "never (no hours set)"}
                  </>
                ) : (
                  <>
                    Rooms are reserved when the event is approved. <Link to={`/organizer?tab=find`}>Find available times</Link>
                  </>
                )
              }
            >
              {(p) => (
                <select {...p} value={form.roomId} onChange={(e) => set("roomId", e.target.value)}>
                  <option value="">No room / off-site</option>
                  {rooms.data?.items
                    .filter((r) => r.isActive || r.id === form.roomId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} (seats {r.capacity})
                      </option>
                    ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Attendance limit" error={fieldErr("capacity")} hint={room ? `Leave blank to use the room's ${room.capacity} seats.` : "Leave blank for no limit. Extra RSVPs join a waitlist."}>
            {(p) => <input {...p} type="number" min={1} max={room?.capacity ?? 10000} value={form.capacity} onChange={(e) => set("capacity", e.target.value)} />}
          </Field>
        </fieldset>

        {clientProblems.length > 0 && (
          <p className="field-error" role="status">
            {clientProblems.join(" ")}
          </p>
        )}

        <div className="row end wrap">
          <Button type="button" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          {editing ? (
            <Button type="submit" variant="primary" busy={save.isPending} disabled={clientProblems.length > 0}>
              Save changes
            </Button>
          ) : (
            <>
              <Button type="button" busy={save.isPending && save.variables === false} disabled={clientProblems.length > 0} onClick={() => onSubmit(false)()}>
                Save draft
              </Button>
              <Button type="submit" variant="primary" busy={save.isPending && save.variables === true} disabled={clientProblems.length > 0}>
                {me.role === "admin" ? "Publish" : "Submit for approval"}
              </Button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
