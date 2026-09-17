import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DateTime } from "luxon";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { useClub, useClubMembers, useOccurrences } from "../api/hooks";
import { useUser } from "../auth";
import { AgendaList } from "../components/calendar";
import { ApiErrorAlert, Button, ConfirmDialog, DemoBadge, ErrorState, Field, PageHeader, Spinner, useToast } from "../components/ui";
import { useMembership } from "./ClubsPage";

function EditClub({ clubId, description, color }: { clubId: string; description: string; color: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ description, color });
  useEffect(() => setForm({ description, color }), [description, color]);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/clubs/${clubId}`, form),
    onSuccess: () => {
      toast("Club updated.");
      void qc.invalidateQueries({ queryKey: ["club"] });
      void qc.invalidateQueries({ queryKey: ["clubs"] });
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Description">{(p) => <textarea {...p} rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
      <Field label="Calendar color">{(p) => <input {...p} type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />}</Field>
      <ApiErrorAlert error={save.error} />
      <div>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save club details
        </Button>
      </div>
    </form>
  );
}

function Members({ clubId }: { clubId: string }) {
  const me = useUser();
  const members = useClubMembers(clubId, true);
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<{ userId: string; displayName: string } | null>(null);
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/api/clubs/${clubId}/members/${userId}`),
    onSuccess: () => {
      toast("Member removed.");
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ["club-members", clubId] });
      void qc.invalidateQueries({ queryKey: ["clubs"] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: "member" | "organizer" }) => api.put(`/api/clubs/${clubId}/members`, v),
    onSuccess: () => {
      toast("Role updated.");
      void qc.invalidateQueries({ queryKey: ["club-members", clubId] });
      void qc.invalidateQueries({ queryKey: ["club"] });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  if (members.isPending) return <Spinner />;
  if (members.isError) return <ErrorState error={members.error} />;
  return (
    <>
      {members.data.items.length === 0 ? (
        <p className="muted">No members yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data.items.map((m) => (
                <tr key={m.userId}>
                  <td>{m.displayName}</td>
                  <td className="muted">{m.email}</td>
                  <td>
                    {me.role === "admin" ? (
                      <select
                        aria-label={`Role for ${m.displayName}`}
                        value={m.role}
                        disabled={setRole.isPending}
                        onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as "member" | "organizer" })}
                      >
                        <option value="member">Member</option>
                        <option value="organizer">Organizer</option>
                      </select>
                    ) : (
                      <span className="badge">{m.role === "organizer" ? "Organizer" : "Member"}</span>
                    )}
                  </td>
                  <td className="muted">{DateTime.fromISO(m.joinedAt).toLocaleString(DateTime.DATE_MED)}</td>
                  <td>
                    {(m.role === "member" || me.role === "admin") && m.userId !== me.id && (
                      <Button variant="ghost" onClick={() => setRemoving(m)}>
                        Remove
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
        open={removing !== null}
        title="Remove member?"
        body={`${removing?.displayName} will lose access to members-only events, and their spots at upcoming members-only events will be released.`}
        confirmLabel="Remove"
        busy={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </>
  );
}

export function ClubDetailPage() {
  const { idOrSlug } = useParams();
  const me = useUser();
  const club = useClub(idOrSlug);
  const m = useMembership({ id: club.data?.id ?? "", name: club.data?.name ?? "" });
  const start = DateTime.now().setZone(me.timezone).startOf("day");
  const events = useOccurrences({ from: start.toUTC().toISO()!, to: start.plus({ days: 60 }).toUTC().toISO()!, clubId: club.data?.id, limit: 200 }, Boolean(club.data));
  if (club.isPending) return <Spinner />;
  if (club.isError) return <ErrorState error={club.error} onRetry={() => club.refetch()} />;
  const c = club.data;
  return (
    <div className="stack">
      <div className="club-hero" style={{ ["--club" as string]: c.color }}>
        <PageHeader title={c.name} subtitle={`${c.category} · ${c.memberCount} member${c.memberCount === 1 ? "" : "s"}`}>
          {c.isDemo && <DemoBadge />}
          {c.canManage && (
            <Link className="btn btn-primary" to={`/events/new?club=${c.id}`}>
              <Plus size={16} aria-hidden /> New event
            </Link>
          )}
          {c.myRole === "member" && (
            <Button onClick={() => m.mutate("leave")} busy={m.isPending}>
              Leave club
            </Button>
          )}
          {!c.myRole && (
            <Button variant="primary" onClick={() => m.mutate("join")} busy={m.isPending}>
              Join club
            </Button>
          )}
        </PageHeader>
        <p className="description">{c.description || <span className="muted">No description yet.</span>}</p>
        <p className="small muted">Organizers: {c.organizers.length ? c.organizers.map((o) => o.displayName).join(", ") : "none assigned"}</p>
      </div>
      <section className="stack-sm">
        <h2 className="section-title">Upcoming events (next 60 days)</h2>
        {events.isPending ? <Spinner /> : events.isError ? <ErrorState error={events.error} /> : <AgendaList items={events.data.items} zone={me.timezone} emptyTitle="Nothing scheduled yet" />}
        {!c.myRole && <p className="small muted">Join the club to also see its members-only events.</p>}
      </section>
      {c.canManage && (
        <div className="grid-2 align-start">
          <section className="panel">
            <h2>Club details</h2>
            <EditClub clubId={c.id} description={c.description} color={c.color} />
          </section>
          <section className="panel">
            <h2>Members</h2>
            <Members clubId={c.id} />
          </section>
        </div>
      )}
    </div>
  );
}
