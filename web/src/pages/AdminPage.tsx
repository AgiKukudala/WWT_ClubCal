import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { type FormEvent, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { LegacyPreviewDTO, RoomDTO } from "@clubcal/shared";
import { ApiError, api, errorMessage } from "../api/client";
import { useApprovals, useAudit, useClubs, useJobHealth, useRefreshEvents, useRooms, useUsers } from "../api/hooks";
import { useUser } from "../auth";
import { Alert, ApiErrorAlert, Button, ConfirmDialog, EmptyState, ErrorState, Field, Modal, PageHeader, Spinner, useToast } from "../components/ui";
import { allTimeZones, WEEKDAY_LONG } from "../lib/dates";

function Approvals() {
  const me = useUser();
  const approvals = useApprovals(true);
  const refresh = useRefreshEvents();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<{ seriesId: string; version: number; title: string } | null>(null);
  const [comment, setComment] = useState("");
  const decide = useMutation({
    mutationFn: (v: { seriesId: string; version: number; decision: "approve" | "reject"; comment: string }) =>
      api.post(`/api/series/${v.seriesId}/review`, { decision: v.decision, comment: v.comment, expectedVersion: v.version }),
    onSuccess: (_d, v) => {
      toast(v.decision === "approve" ? "Approved and published." : "Sent back to the organizer.");
      setRejecting(null);
      setComment("");
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  if (approvals.isPending) return <Spinner />;
  if (approvals.isError) return <ErrorState error={approvals.error} onRetry={() => approvals.refetch()} />;
  if (approvals.data.items.length === 0) return <EmptyState title="Nothing waiting for approval">New submissions from organizers will appear here.</EmptyState>;
  return (
    <>
      <p className="small muted">Approving re-checks room availability. If a room was taken in the meantime you'll see which dates conflict and nothing is published.</p>
      <ul className="approval-list">
        {approvals.data.items.map((a) => (
          <li key={a.seriesId} className="panel" style={{ ["--club" as string]: a.clubColor }}>
            <div className="row between wrap">
              <div>
                <strong>{a.firstOccurrenceId ? <Link to={`/events/${a.firstOccurrenceId}`}>{a.title}</Link> : a.title}</strong>
                <div className="small muted">
                  {a.clubName} · by {a.organizerName} · {a.firstStartsAt ? DateTime.fromISO(a.firstStartsAt).setZone(me.timezone).toFormat("ccc LLL d, h:mm a") : "no dates"}
                  {a.isRecurring && " · weekly series"}
                  {a.hasRoom && " · needs a room"}
                  {a.isResubmission && " · resubmitted/edited"}
                </div>
              </div>
              <div className="row">
                <Button
                  variant="primary"
                  busy={decide.isPending && decide.variables?.seriesId === a.seriesId && decide.variables.decision === "approve"}
                  onClick={() => decide.mutate({ seriesId: a.seriesId, version: a.version, decision: "approve", comment: "" })}
                >
                  Approve
                </Button>
                <Button variant="danger" onClick={() => setRejecting({ seriesId: a.seriesId, version: a.version, title: a.title })}>
                  Request changes
                </Button>
              </div>
            </div>
            {decide.error instanceof ApiError && decide.variables?.seriesId === a.seriesId && <ApiErrorAlert error={decide.error} />}
          </li>
        ))}
      </ul>
      <Modal title={`Request changes: ${rejecting?.title ?? ""}`} open={rejecting !== null} onClose={() => setRejecting(null)}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (rejecting) decide.mutate({ ...rejecting, decision: "reject", comment });
          }}
        >
          <Field label="What needs to change?">{(p) => <textarea {...p} required rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
          <div className="row end">
            <Button type="button" onClick={() => setRejecting(null)}>
              Back
            </Button>
            <Button type="submit" variant="danger" busy={decide.isPending} disabled={!comment.trim()}>
              Send back
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function ClubsAdmin() {
  const clubs = useClubs();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", slug: "", category: "", color: "#2563eb", description: "" });
  const [archive, setArchive] = useState<{ id: string; name: string } | null>(null);
  const [assign, setAssign] = useState<{ clubId: string; name: string } | null>(null);
  const [userQuery, setUserQuery] = useState("");
  const users = useUsers(userQuery);
  const create = useMutation({
    mutationFn: () => api.post("/api/clubs", form),
    onSuccess: () => {
      toast("Club created.");
      setForm({ name: "", slug: "", category: "", color: "#2563eb", description: "" });
      void qc.invalidateQueries({ queryKey: ["clubs"] });
    },
  });
  const doArchive = useMutation({
    mutationFn: (id: string) => api.del(`/api/clubs/${id}`),
    onSuccess: () => {
      toast("Club archived.");
      setArchive(null);
      void qc.invalidateQueries({ queryKey: ["clubs"] });
    },
  });
  const doAssign = useMutation({
    mutationFn: (v: { clubId: string; userId: string }) => api.put(`/api/clubs/${v.clubId}/members`, { userId: v.userId, role: "organizer" }),
    onSuccess: () => {
      toast("Organizer assigned.");
      setAssign(null);
      void qc.invalidateQueries();
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const err = create.error instanceof ApiError ? create.error : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <div className="grid-2 align-start">
      <section className="panel stack">
        <h2>Clubs</h2>
        {clubs.isPending ? (
          <Spinner />
        ) : clubs.isError ? (
          <ErrorState error={clubs.error} />
        ) : (
          <ul className="plain-list">
            {clubs.data.items.map((c) => (
              <li key={c.id} className="row between wrap">
                <Link to={`/clubs/${c.slug}`} className="club-badge">
                  <span className="dot" style={{ background: c.color }} aria-hidden />
                  {c.name}
                </Link>
                <span className="row">
                  <Button variant="ghost" onClick={() => setAssign({ clubId: c.id, name: c.name })}>
                    Assign organizer
                  </Button>
                  <Button variant="ghost" onClick={() => setArchive({ id: c.id, name: c.name })}>
                    Archive
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form className="panel stack" onSubmit={submit}>
        <h2>Create a club</h2>
        <ApiErrorAlert error={create.error} />
        <Field label="Name" error={err?.fields.name}>
          {(p) => (
            <input
              {...p}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug || "" })}
              onBlur={() => !form.slug && setForm((f) => ({ ...f, slug: f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }))}
            />
          )}
        </Field>
        <Field label="URL slug" error={err?.fields.slug} hint="Lowercase letters, numbers and dashes.">
          {(p) => <input {...p} required value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />}
        </Field>
        <div className="grid-2">
          <Field label="Category" error={err?.fields.category}>
            {(p) => <input {...p} required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />}
          </Field>
          <Field label="Color" error={err?.fields.color}>
            {(p) => <input {...p} type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />}
          </Field>
        </div>
        <Field label="Description">{(p) => <textarea {...p} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        <div>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Create club
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={archive !== null}
        title={`Archive ${archive?.name}?`}
        body="The club disappears from the directory and calendars. Clubs with upcoming published or pending events can't be archived until those are cancelled."
        confirmLabel="Archive club"
        busy={doArchive.isPending}
        onClose={() => {
          setArchive(null);
          doArchive.reset();
        }}
        onConfirm={() => archive && doArchive.mutate(archive.id)}
      >
        <ApiErrorAlert error={doArchive.error} />
      </ConfirmDialog>
      <Modal title={`Assign an organizer to ${assign?.name ?? ""}`} open={assign !== null} onClose={() => setAssign(null)}>
        <div className="stack">
          <Field label="Search users by name or email">{(p) => <input {...p} type="search" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} />}</Field>
          <p className="small muted">Students assigned as organizers are promoted to the organizer role.</p>
          <ul className="plain-list scroll">
            {users.data?.items
              .filter((u) => !u.disabled)
              .map((u) => (
                <li key={u.id} className="row between">
                  <span>
                    {u.displayName} <span className="muted small">{u.email} · {u.role}</span>
                  </span>
                  <Button busy={doAssign.isPending && doAssign.variables?.userId === u.id} onClick={() => assign && doAssign.mutate({ clubId: assign.clubId, userId: u.id })}>
                    Assign
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      </Modal>
    </div>
  );
}

type RoomForm = { name: string; location: string; capacity: number; timezone: string; features: string; isActive: boolean; hours: Record<number, { open: boolean; opens: string; closes: string }> };

function roomToForm(r?: RoomDTO, tz = "America/Chicago"): RoomForm {
  const hours: RoomForm["hours"] = {};
  for (let d = 1; d <= 7; d++) {
    const h = r?.hours.find((x) => x.weekday === d);
    hours[d] = h ? { open: true, opens: h.opens, closes: h.closes } : { open: !r && d <= 5, opens: "07:00", closes: "18:00" };
  }
  return { name: r?.name ?? "", location: r?.location ?? "", capacity: r?.capacity ?? 30, timezone: r?.timezone ?? tz, features: r?.features.join(", ") ?? "", isActive: r?.isActive ?? true, hours };
}

function RoomsAdmin() {
  const me = useUser();
  const rooms = useRooms();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id?: string; form: RoomForm } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const f = editing!.form;
      const body = {
        name: f.name,
        location: f.location,
        capacity: Number(f.capacity),
        timezone: f.timezone,
        features: f.features.split(",").map((s) => s.trim()).filter(Boolean),
        isActive: f.isActive,
        hours: Object.entries(f.hours)
          .filter(([, h]) => h.open)
          .map(([d, h]) => ({ weekday: Number(d), opens: h.opens, closes: h.closes })),
      };
      return editing!.id ? api.put(`/api/rooms/${editing!.id}`, body) : api.post("/api/rooms", body);
    },
    onSuccess: () => {
      toast("Room saved.");
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["rooms"] });
    },
  });
  const f = editing?.form;
  const setF = (patch: Partial<RoomForm>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  return (
    <div className="stack">
      <div>
        <Button variant="primary" onClick={() => setEditing({ form: roomToForm(undefined, me.timezone) })}>
          Add room
        </Button>
      </div>
      {rooms.isPending ? (
        <Spinner />
      ) : rooms.isError ? (
        <ErrorState error={rooms.error} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Location</th>
                <th scope="col">Seats</th>
                <th scope="col">Hours</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rooms.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.features.length > 0 && <div className="small muted">{r.features.join(", ")}</div>}
                  </td>
                  <td>{r.location}</td>
                  <td>{r.capacity}</td>
                  <td className="small">{r.hours.map((h) => `${WEEKDAY_LONG[h.weekday - 1]!.slice(0, 3)} ${h.opens}–${h.closes}`).join(" · ") || "Closed"}</td>
                  <td>{r.isActive ? "Bookable" : <span className="badge status-cancelled">Inactive</span>}</td>
                  <td>
                    <Button variant="ghost" onClick={() => setEditing({ id: r.id, form: roomToForm(r) })}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal title={editing?.id ? "Edit room" : "Add room"} open={editing !== null} onClose={() => setEditing(null)}>
        {f && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <ApiErrorAlert error={save.error} />
            <div className="grid-2">
              <Field label="Name">{(p) => <input {...p} required value={f.name} onChange={(e) => setF({ name: e.target.value })} />}</Field>
              <Field label="Seats">{(p) => <input {...p} type="number" min={1} required value={f.capacity} onChange={(e) => setF({ capacity: Number(e.target.value) })} />}</Field>
            </div>
            <Field label="Location">{(p) => <input {...p} required value={f.location} onChange={(e) => setF({ location: e.target.value })} />}</Field>
            <Field label="Features" hint="Comma separated">
              {(p) => <input {...p} value={f.features} onChange={(e) => setF({ features: e.target.value })} />}
            </Field>
            <Field label="Time zone">
              {(p) => (
                <select {...p} value={f.timezone} onChange={(e) => setF({ timezone: e.target.value })}>
                  {allTimeZones().map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              )}
            </Field>
            <fieldset>
              <legend>Opening hours</legend>
              {WEEKDAY_LONG.map((d, i) => {
                const h = f.hours[i + 1]!;
                const setH = (patch: Partial<typeof h>) => setF({ hours: { ...f.hours, [i + 1]: { ...h, ...patch } } });
                return (
                  <div className="row wrap hours-row" key={d}>
                    <label className="check">
                      <input type="checkbox" checked={h.open} onChange={(e) => setH({ open: e.target.checked })} /> {d}
                    </label>
                    {h.open && (
                      <>
                        <input type="time" aria-label={`${d} opens`} value={h.opens} onChange={(e) => setH({ opens: e.target.value })} />
                        <span aria-hidden>–</span>
                        <input type="time" aria-label={`${d} closes`} value={h.closes} onChange={(e) => setH({ closes: e.target.value })} />
                      </>
                    )}
                  </div>
                );
              })}
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ isActive: e.target.checked })} /> Available for new bookings
            </label>
            <p className="small muted">Existing reservations are kept when hours or capacity change; new and edited bookings follow the new rules.</p>
            <div className="row end">
              <Button type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={save.isPending}>
                Save room
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function UsersAdmin() {
  const me = useUser();
  const [q, setQ] = useState("");
  const users = useUsers(q);
  const qc = useQueryClient();
  const toast = useToast();
  const [disabling, setDisabling] = useState<{ id: string; name: string } | null>(null);
  const update = useMutation({
    mutationFn: (v: { id: string; role?: string; disabled?: boolean }) => api.patch(`/api/admin/users/${v.id}`, { role: v.role, disabled: v.disabled }),
    onSuccess: () => {
      toast("User updated.");
      setDisabling(null);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <div className="stack">
      <label className="search">
        <span className="sr-only">Search users</span>
        <input type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <p className="small muted">
        Password resets are done on the server: <code>npm run admin:reset-password -- --email person@school.edu</code>
      </p>
      {users.isPending ? (
        <Spinner />
      ) : users.isError ? (
        <ErrorState error={users.error} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select aria-label={`Role for ${u.displayName}`} value={u.role} disabled={u.id === me.id || update.isPending} onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}>
                      <option value="student">Student</option>
                      <option value="organizer">Organizer</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </td>
                  <td>
                    {u.id === me.id ? (
                      <span className="muted small">You</span>
                    ) : u.disabled ? (
                      <Button variant="ghost" onClick={() => update.mutate({ id: u.id, disabled: false })}>
                        Re-enable
                      </Button>
                    ) : (
                      <Button variant="ghost" onClick={() => setDisabling({ id: u.id, name: u.displayName })}>
                        Disable
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={disabling !== null}
        title={`Disable ${disabling?.name}?`}
        body="They are signed out everywhere, can't sign in, and stop receiving reminders. You can re-enable the account later."
        confirmLabel="Disable account"
        busy={update.isPending}
        onClose={() => setDisabling(null)}
        onConfirm={() => disabling && update.mutate({ id: disabling.id, disabled: true })}
      />
    </div>
  );
}

function Deliveries() {
  const jobs = useJobHealth();
  if (jobs.isPending) return <Spinner />;
  if (jobs.isError) return <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />;
  const j = jobs.data;
  return (
    <div className="stack">
      <p className="small muted">
        Reminders are stored in PostgreSQL and delivered by the worker process through a PostgreSQL-backed job queue with retries. In-app notifications are
        de-duplicated; email is at-least-once, so a crash at the wrong moment can send a duplicate email.
      </p>
      <div className="grid-3">
        <section className="panel">
          <h2>Reminders</h2>
          <dl className="facts">
            {j.reminders.length === 0 && <dd className="muted">None yet</dd>}
            {j.reminders.map((r) => (
              <div key={r.status} className="contents">
                <dt>{r.status}</dt>
                <dd>{r.count}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel">
          <h2>Email</h2>
          <dl className="facts">
            {j.emails.map((r) => (
              <div key={r.status} className="contents">
                <dt>{r.status.replace("_", " ")}</dt>
                <dd>{r.count}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel">
          <h2>Queues</h2>
          {j.queues.length === 0 ? (
            <p className="muted">No jobs recorded yet.</p>
          ) : (
            <dl className="facts">
              {j.queues.map((q) => (
                <div key={q.name} className="contents">
                  <dt>{q.name}</dt>
                  <dd>
                    {q.queued} queued · {q.active} active · {q.failed} failed
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Recent failures</h2>
        {j.recentFailures.length === 0 ? (
          <p className="muted">No failed deliveries.</p>
        ) : (
          <ul className="plain-list">
            {j.recentFailures.map((f) => (
              <li key={`${f.kind}-${f.id}`}>
                <strong>{f.kind}</strong> <span className="mono small">{f.id}</span> — {f.error ?? "unknown error"} ({f.attempts} attempts,{" "}
                {DateTime.fromISO(f.updatedAt).toRelative()})
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AuditLog() {
  const [type, setType] = useState("");
  const audit = useAudit(type || undefined);
  return (
    <div className="stack">
      <label>
        <span className="small muted">Filter </span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All records</option>
          {["series", "occurrence", "club", "room", "user", "legacy_import"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      {audit.isPending ? (
        <Spinner />
      ) : audit.isError ? (
        <ErrorState error={audit.error} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap small">{DateTime.fromISO(a.createdAt).toFormat("LLL d, HH:mm:ss")}</td>
                  <td>{a.actor?.displayName ?? <span className="muted">system</span>}</td>
                  <td className="mono small">{a.action}</td>
                  <td>
                    <code className="details">{JSON.stringify(a.details)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportLegacy() {
  const me = useUser();
  const clubs = useClubs();
  const refresh = useRefreshEvents();
  const [form, setForm] = useState({ clubId: "", timezone: "", category: "General", visibility: "public", json: "" });
  const [preview, setPreview] = useState<LegacyPreviewDTO | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const body = () => ({ ...form, clubId: form.clubId || clubs.data?.items[0]?.id });
  const doPreview = useMutation({
    mutationFn: () => api.post<LegacyPreviewDTO>("/api/admin/import/preview", body()),
    onSuccess: (p) => {
      setPreview(p);
      setDone(null);
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post<{ imported: number }>("/api/admin/import/commit", { ...body(), fileSha256: preview!.fileSha256 }),
    onSuccess: (r) => {
      setDone(r.imported);
      setPreview(null);
      void refresh();
    },
  });
  const err = doPreview.error instanceof ApiError ? doPreview.error : null;
  const change = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setPreview(null);
  };
  return (
    <div className="stack">
      <Alert kind="info">
        The old calendar kept events only in each browser's own storage, so the server cannot read them. On a computer that has the old calendar data, open the old
        page, press F12 → Console, run <code>copy(localStorage.getItem("events"))</code>, and paste the result below. Each person's browser must be exported separately.
      </Alert>
      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          doPreview.mutate();
        }}
      >
        <div className="grid-2">
          <Field label="Import into club" error={err?.fields.clubId}>
            {(p) => (
              <select {...p} value={form.clubId} onChange={(e) => change({ clubId: e.target.value })}>
                {clubs.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Time zone the old times were written in (required)" error={err?.fields.timezone}>
            {(p) => (
              <select {...p} required value={form.timezone} onChange={(e) => change({ timezone: e.target.value })}>
                <option value="">Choose a time zone…</option>
                {allTimeZones().map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Category">{(p) => <input {...p} value={form.category} onChange={(e) => change({ category: e.target.value })} />}</Field>
          <Field label="Visibility">
            {(p) => (
              <select {...p} value={form.visibility} onChange={(e) => change({ visibility: e.target.value })}>
                <option value="public">Everyone</option>
                <option value="club">Club members only</option>
              </select>
            )}
          </Field>
        </div>
        <Field label="Exported events JSON" error={err?.fields.json}>
          {(p) => <textarea {...p} rows={8} className="mono" required value={form.json} onChange={(e) => change({ json: e.target.value })} placeholder='[{"day":13,"month":11,"year":2025,"events":[{"title":"Chess","time":"3:30 PM - 5:00 PM"}]}]' />}
        </Field>
        <ApiErrorAlert error={doPreview.error} />
        <div>
          <Button type="submit" busy={doPreview.isPending} disabled={!form.timezone || !form.json}>
            Preview import
          </Button>
        </div>
      </form>
      {done !== null && <Alert kind="success">Imported {done} event{done === 1 ? "" : "s"} as published events.</Alert>}
      {preview && (
        <section className="panel stack">
          <h2>Preview</h2>
          {preview.alreadyImported && <Alert kind="warning">This exact file was already imported. Committing again is blocked.</Alert>}
          <p>
            {preview.validCount} will be imported · {preview.invalidCount} invalid · {preview.duplicateCount} duplicate. Times are interpreted in {form.timezone}; shown
            here as written.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Title</th>
                  <th scope="col">Date</th>
                  <th scope="col">Time</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.index} className={r.status === "ok" ? "" : "row-muted"}>
                    <td>{r.index + 1}</td>
                    <td>{r.title || <em className="muted">(empty)</em>}</td>
                    <td>{r.date ?? "—"}</td>
                    <td>{r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : "—"}</td>
                    <td>{r.status === "ok" ? "Will import" : `${r.status === "invalid" ? "Skipped" : "Duplicate"}: ${r.problem}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ApiErrorAlert error={commit.error} />
          <div>
            <Button variant="primary" busy={commit.isPending} disabled={preview.alreadyImported || preview.validCount === 0} onClick={() => commit.mutate()}>
              Import {preview.validCount} event{preview.validCount === 1 ? "" : "s"}
            </Button>
          </div>
        </section>
      )}
      <p className="small muted">Signed in as {me.displayName}. Every import is recorded in the audit log.</p>
    </div>
  );
}

const TABS = [
  ["approvals", "Approvals"],
  ["clubs", "Clubs"],
  ["rooms", "Rooms"],
  ["users", "Users"],
  ["deliveries", "Reminders & email"],
  ["audit", "Audit log"],
  ["import", "Import old calendar"],
] as const;

export function AdminPage() {
  return (
    <div className="stack">
      <PageHeader title="Administration" />
      <nav className="tabs" aria-label="Admin sections">
        {TABS.map(([path, label]) => (
          <NavLink key={path} to={`/admin/${path}`} className={({ isActive }) => (isActive ? "on" : "")}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="approvals" replace />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="clubs" element={<ClubsAdmin />} />
        <Route path="rooms" element={<RoomsAdmin />} />
        <Route path="users" element={<UsersAdmin />} />
        <Route path="deliveries" element={<Deliveries />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="import" element={<ImportLegacy />} />
      </Routes>
    </div>
  );
}
