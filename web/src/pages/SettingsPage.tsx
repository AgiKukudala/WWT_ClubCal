import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAvailability } from "../api/hooks";
import { useUser } from "../auth";
import { ApiErrorAlert, Button, Field, PageHeader, Spinner, useToast } from "../components/ui";
import { allTimeZones, WEEKDAY_LONG } from "../lib/dates";

function Availability() {
  const avail = useAvailability();
  const toast = useToast();
  const qc = useQueryClient();
  const [windows, setWindows] = useState<{ weekday: number; start: string; end: string }[] | null>(null);
  useEffect(() => {
    if (avail.data && windows === null) setWindows(avail.data.windows);
  }, [avail.data, windows]);
  const save = useMutation({
    mutationFn: () => api.put("/api/me/availability", { windows }),
    onSuccess: () => {
      toast("Availability saved.");
      void qc.invalidateQueries({ queryKey: ["availability"] });
    },
  });
  if (!windows) return <Spinner />;
  const update = (i: number, patch: Partial<(typeof windows)[number]>) => setWindows(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="small muted">
        Organizers use this when searching for meeting times. If you leave it empty, you'll be listed as “availability unknown” rather than assumed free.
      </p>
      {windows.length === 0 && <p className="muted">No availability declared.</p>}
      {windows.map((w, i) => (
        <div className="row wrap availability-row" key={i}>
          <label>
            <span className="sr-only">Day</span>
            <select value={w.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })}>
              {WEEKDAY_LONG.map((d, k) => (
                <option key={d} value={k + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">From</span>
            <input type="time" value={w.start} onChange={(e) => update(i, { start: e.target.value })} />
          </label>
          <span aria-hidden>–</span>
          <label>
            <span className="sr-only">Until</span>
            <input type="time" value={w.end} onChange={(e) => update(i, { end: e.target.value })} />
          </label>
          <Button type="button" variant="ghost" onClick={() => setWindows(windows.filter((_, j) => j !== i))} aria-label={`Remove ${WEEKDAY_LONG[w.weekday - 1]} window`}>
            <Trash2 size={16} />
          </Button>
        </div>
      ))}
      <ApiErrorAlert error={save.error} />
      <div className="row wrap">
        <Button type="button" onClick={() => setWindows([...windows, { weekday: 1, start: "15:00", end: "17:00" }])} disabled={windows.length >= 50}>
          <Plus size={16} aria-hidden /> Add time window
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save availability
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const me = useUser();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    displayName: me.displayName,
    timezone: me.timezone,
    remind24h: me.remind24h,
    remind1h: me.remind1h,
    emailNotifications: me.emailNotifications,
  });
  const save = useMutation({
    mutationFn: () => api.patch("/api/me", form),
    onSuccess: async () => {
      toast("Settings saved.");
      await qc.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <div className="stack narrow">
      <PageHeader title="Settings" subtitle={me.email} />
      <form className="panel stack" onSubmit={submit}>
        <h2>Profile & reminders</h2>
        <Field label="Display name">{(p) => <input {...p} value={form.displayName} maxLength={100} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
        <Field label="Time zone" hint="Calendar times are shown in this zone.">
          {(p) => (
            <select {...p} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {allTimeZones().map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          )}
        </Field>
        <fieldset className="stack-sm">
          <legend>Reminders for events you're going to</legend>
          <label className="check">
            <input type="checkbox" checked={form.remind24h} onChange={(e) => setForm({ ...form, remind24h: e.target.checked })} /> 24 hours before
          </label>
          <label className="check">
            <input type="checkbox" checked={form.remind1h} onChange={(e) => setForm({ ...form, remind1h: e.target.checked })} /> 1 hour before
          </label>
          <label className="check">
            <input type="checkbox" checked={form.emailNotifications} onChange={(e) => setForm({ ...form, emailNotifications: e.target.checked })} /> Also send notifications by email
          </label>
          <p className="small muted">
            In-app notifications always work. Email only goes out if the school configured an SMTP server; in the local development setup, emails are captured by
            Mailpit and never reach real inboxes. Reminders are sent by the server's background worker, so they arrive even if this page is closed — but only
            while that server is running.
          </p>
        </fieldset>
        <ApiErrorAlert error={save.error} />
        <div>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
      <section className="panel stack">
        <h2>My weekly availability</h2>
        <Availability />
      </section>
    </div>
  );
}
