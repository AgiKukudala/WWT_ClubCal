import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { OccurrenceDTO } from "@clubcal/shared";
import { ApiError, api } from "../api/client";
import { useOccurrence, useRefreshEvents, useRooms } from "../api/hooks";
import { useUser } from "../auth";
import { Alert, ApiErrorAlert, Button, ErrorState, Field, PageHeader, Spinner, useToast } from "../components/ui";
import { fullWhen, localDateTime } from "../lib/dates";

/** Reschedules one date of a series (or a single event) without touching the rest. */
export function OccurrenceEditPage() {
  const { id } = useParams();
  const me = useUser();
  const occ = useOccurrence(id);
  const rooms = useRooms();
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useRefreshEvents();
  const [form, setForm] = useState<{ date: string; startTime: string; durationMinutes: number; roomId: string; capacity: string; version: number } | null>(null);

  useEffect(() => {
    const o = occ.data;
    if (o && !form) {
      const { date, time } = localDateTime(o.startsAt, o.timezone);
      setForm({
        date,
        startTime: time,
        durationMinutes: Math.round((Date.parse(o.endsAt) - Date.parse(o.startsAt)) / 60000),
        roomId: o.room?.id ?? "",
        capacity: o.capacity === null ? "" : String(o.capacity),
        version: o.occurrenceVersion,
      });
    }
  }, [occ.data, form]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<OccurrenceDTO>(`/api/occurrences/${id}`, {
        expectedVersion: form!.version,
        date: form!.date,
        startTime: form!.startTime,
        durationMinutes: Number(form!.durationMinutes),
        roomId: form!.roomId || null,
        capacity: form!.capacity === "" ? null : Number(form!.capacity),
      }),
    onSuccess: async (o) => {
      await refresh();
      toast(o.seriesStatus === "pending" ? "Saved. The series is awaiting re-approval." : "Date updated. Attendees were notified.");
      navigate(`/events/${id}`);
    },
  });

  if (occ.isPending || (!form && !occ.isError)) return <Spinner />;
  if (occ.isError) return <ErrorState error={occ.error} />;
  const o = occ.data;
  const f = form!;
  const err = save.error instanceof ApiError ? save.error : null;
  const room = rooms.data?.items.find((r) => r.id === f.roomId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="stack narrow">
      <PageHeader title={`Reschedule: ${o.title}`} subtitle={`Currently ${fullWhen(o, me.timezone)}`} />
      {o.seriesStatus === "approved" && me.role !== "admin" && (
        <Alert kind="info">This event is published. Saving a change here sends the series back for administrator approval.</Alert>
      )}
      {err?.code === "version_conflict" ? (
        <Alert kind="warning">
          This date was changed by someone else.{" "}
          <Button
            variant="ghost"
            onClick={() => {
              setForm(null);
              save.reset();
              void occ.refetch();
            }}
          >
            Reload latest
          </Button>
        </Alert>
      ) : (
        <ApiErrorAlert error={save.error} />
      )}
      <form className="panel stack" onSubmit={submit}>
        <p className="small muted">Times are in the event's time zone ({o.timezone}).</p>
        <div className="grid-3">
          <Field label="Date" error={err?.fields.date}>
            {(p) => <input {...p} type="date" value={f.date} required onChange={(e) => setForm({ ...f, date: e.target.value })} />}
          </Field>
          <Field label="Start time" error={err?.fields.startTime}>
            {(p) => <input {...p} type="time" step={300} value={f.startTime} required onChange={(e) => setForm({ ...f, startTime: e.target.value })} />}
          </Field>
          <Field label="Duration (minutes)" error={err?.fields.durationMinutes}>
            {(p) => <input {...p} type="number" min={15} max={1440} step={5} value={f.durationMinutes} onChange={(e) => setForm({ ...f, durationMinutes: Number(e.target.value) })} />}
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Room" hint={room ? `Seats ${room.capacity}` : undefined}>
            {(p) => (
              <select {...p} value={f.roomId} onChange={(e) => setForm({ ...f, roomId: e.target.value })}>
                <option value="">No room / off-site</option>
                {rooms.data?.items
                  .filter((r) => r.isActive || r.id === f.roomId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} (seats {r.capacity})
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <Field label="Attendance limit" error={err?.fields.capacity} hint="Lowering it moves the most recent attendees to the front of the waitlist.">
            {(p) => <input {...p} type="number" min={1} value={f.capacity} onChange={(e) => setForm({ ...f, capacity: e.target.value })} />}
          </Field>
        </div>
        <div className="row end">
          <Button type="button" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save this date
          </Button>
        </div>
      </form>
    </div>
  );
}
