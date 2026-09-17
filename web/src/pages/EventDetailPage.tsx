import { useMutation } from "@tanstack/react-query";
import { CalendarX2, Check, Download, Edit3, History, MapPin, Repeat, Send, Trash2, Users, X } from "lucide-react";
import { DateTime } from "luxon";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { OccurrenceDTO } from "@clubcal/shared";
import { ApiError, api, errorMessage } from "../api/client";
import { useAttendees, useOccurrence, useRefreshEvents, useRsvp, useSeries, useSeriesAudit, useSeriesOccurrences } from "../api/hooks";
import { useUser } from "../auth";
import { RsvpPill } from "../components/calendar";
import { Alert, ApiErrorAlert, Button, ClubBadge, ConfirmDialog, ErrorState, Field, Modal, PageHeader, Spinner, StatusBadge, useToast } from "../components/ui";
import { fullWhen, timeLabel } from "../lib/dates";

function RsvpPanel({ o }: { o: OccurrenceDTO }) {
  const rsvp = useRsvp(o.id);
  const toast = useToast();
  const ended = new Date(o.endsAt) <= new Date();
  const open = o.status === "approved" && !ended;
  const full = o.capacity !== null && o.goingCount >= o.capacity;
  const respond = (r: "going" | "not_going") =>
    rsvp.mutate(r, {
      onSuccess: (res) =>
        toast(res.status === "going" ? "You're going!" : res.status === "waitlisted" ? `Event is full — you're #${res.waitlistPosition} on the waitlist.` : "Response saved."),
      onError: (e) => toast(errorMessage(e), "error"),
    });
  return (
    <section className="panel" aria-labelledby="rsvp-h">
      <h2 id="rsvp-h">Your response</h2>
      {o.status === "cancelled" ? (
        <Alert kind="warning">This event was cancelled{o.cancelReason ? `: ${o.cancelReason}` : "."}</Alert>
      ) : !open ? (
        <p className="muted">{ended ? "This event has ended." : "Responses open once the event is published."}</p>
      ) : (
        <>
          <p className="muted">
            {o.capacity === null ? `${o.goingCount} going · no attendance limit` : `${o.goingCount} of ${o.capacity} spots taken${o.waitlistCount ? ` · ${o.waitlistCount} on the waitlist` : ""}`}
          </p>
          <div className="row wrap">
            <Button variant={o.myRsvp === "going" || o.myRsvp === "waitlisted" ? "primary" : "secondary"} aria-pressed={o.myRsvp === "going" || o.myRsvp === "waitlisted"} busy={rsvp.isPending && rsvp.variables === "going"} onClick={() => respond("going")}>
              <Check size={16} aria-hidden /> {full && o.myRsvp !== "going" ? "Join waitlist" : "Going"}
            </Button>
            <Button aria-pressed={o.myRsvp === "not_going"} busy={rsvp.isPending && rsvp.variables === "not_going"} onClick={() => respond("not_going")}>
              <X size={16} aria-hidden /> Not going
            </Button>
            <RsvpPill o={o} />
          </div>
          {o.myRsvp === "waitlisted" && <p className="small muted">You'll be moved in automatically (and notified) if a spot opens.</p>}
        </>
      )}
    </section>
  );
}

function ManagePanel({ o }: { o: OccurrenceDTO }) {
  const me = useUser();
  const navigate = useNavigate();
  const refresh = useRefreshEvents();
  const toast = useToast();
  const series = useSeries(o.seriesId);
  const [cancelScope, setCancelScope] = useState<"occurrence" | "series" | null>(null);
  const [reason, setReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [review, setReview] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");

  const cancel = useMutation({
    mutationFn: () => api.post<{ cancelled: number }>(`/api/occurrences/${o.id}/cancel`, { scope: cancelScope, reason }),
    onSuccess: (r) => {
      toast(`Cancelled ${r.cancelled} occurrence${r.cancelled === 1 ? "" : "s"}. Attendees were notified.`);
      setCancelScope(null);
      void refresh();
    },
  });
  const submit = useMutation({
    mutationFn: () => api.post(`/api/series/${o.seriesId}/submit`, { expectedVersion: series.data!.version }),
    onSuccess: () => {
      toast("Submitted for approval.");
      void refresh();
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/series/${o.seriesId}`),
    onSuccess: () => {
      toast("Event deleted.");
      void refresh();
      navigate("/organizer");
    },
  });
  const decide = useMutation({
    mutationFn: () => api.post(`/api/series/${o.seriesId}/review`, { decision: review, comment, expectedVersion: series.data!.version }),
    onSuccess: () => {
      toast(review === "approve" ? "Approved and published." : "Returned to the organizer.");
      setReview(null);
      setComment("");
      void refresh();
    },
  });

  const s = series.data;
  const past = new Date(o.endsAt) <= new Date();
  const editable = o.status !== "cancelled" && !past;
  return (
    <section className="panel" aria-labelledby="manage-h">
      <h2 id="manage-h">Manage</h2>
      {s?.reviewComment && (s.status === "rejected" || s.status === "approved") && (
        <Alert kind={s.status === "rejected" ? "warning" : "info"}>
          Reviewer comment: <em>{s.reviewComment}</em>
        </Alert>
      )}
      {o.seriesStatus === "approved" && me.role !== "admin" && editable && (
        <p className="small muted">Changing the time, room or capacity of a published event sends it back for approval. Title and description edits publish immediately.</p>
      )}
      <ApiErrorAlert error={submit.error ?? del.error ?? (review ? null : decide.error)} />
      <div className="row wrap">
        {editable && (
          <Link className="btn btn-secondary" to={`/series/${o.seriesId}/edit`}>
            <Edit3 size={16} aria-hidden /> Edit {o.isRecurring ? "series" : "event"}
          </Link>
        )}
        {editable && o.isRecurring && !o.allDay && (
          <Link className="btn btn-secondary" to={`/events/${o.id}/edit`}>
            <Edit3 size={16} aria-hidden /> Edit this date only
          </Link>
        )}
        {editable && !o.isRecurring && !o.allDay && (
          <Link className="btn btn-ghost" to={`/events/${o.id}/edit`}>
            Reschedule
          </Link>
        )}
        {s && (s.status === "draft" || s.status === "rejected") && (
          <Button variant="primary" onClick={() => submit.mutate()} busy={submit.isPending}>
            <Send size={16} aria-hidden /> Submit for approval
          </Button>
        )}
        {s && (s.status === "draft" || s.status === "rejected" || (s.status === "pending" && o.goingCount + o.waitlistCount === 0)) && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} aria-hidden /> Delete
          </Button>
        )}
        {editable && (o.seriesStatus === "approved" || (o.seriesStatus === "pending" && o.goingCount + o.waitlistCount > 0)) && (
          <>
            <Button variant="danger" onClick={() => setCancelScope("occurrence")}>
              <CalendarX2 size={16} aria-hidden /> Cancel {o.isRecurring ? "this date" : "event"}
            </Button>
            {o.isRecurring && (
              <Button variant="danger" onClick={() => setCancelScope("series")}>
                Cancel whole series
              </Button>
            )}
          </>
        )}
      </div>
      {me.role === "admin" && s?.status === "pending" && (
        <div className="review-box">
          <strong>Approval decision</strong>
          <p className="small muted">Approving re-checks every room booking in this series and publishes it. Rejecting requires a comment.</p>
          <div className="row wrap">
            <Button variant="primary" onClick={() => setReview("approve")}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => setReview("reject")}>
              Request changes
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={cancelScope !== null}
        title={cancelScope === "series" ? "Cancel the whole series?" : "Cancel this event?"}
        body={
          cancelScope === "series"
            ? "All upcoming dates in this series will be cancelled, their rooms released, and everyone who responded will be notified. This can't be undone."
            : `${fullWhen(o, me.timezone)} will be cancelled and attendees notified. This can't be undone.`
        }
        confirmLabel="Cancel event"
        busy={cancel.isPending}
        onClose={() => {
          setCancelScope(null);
          cancel.reset();
        }}
        onConfirm={() => cancel.mutate()}
      >
        <Field label="Reason (shown to attendees)">{(p) => <input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ApiErrorAlert error={cancel.error} />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this event?"
        body="The unpublished event and all of its dates will be permanently removed."
        confirmLabel="Delete"
        busy={del.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate(undefined, { onSettled: () => setConfirmDelete(false) })}
      />
      <Modal title={review === "approve" ? "Approve event" : "Request changes"} open={review !== null} onClose={() => setReview(null)}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate();
          }}
        >
          <Field label={review === "approve" ? "Comment (optional)" : "What needs to change?"}>
            {(p) => <textarea {...p} rows={3} value={comment} required={review === "reject"} maxLength={1000} onChange={(e) => setComment(e.target.value)} />}
          </Field>
          <ApiErrorAlert error={decide.error} />
          <div className="row end">
            <Button type="button" onClick={() => setReview(null)}>
              Back
            </Button>
            <Button type="submit" variant={review === "approve" ? "primary" : "danger"} busy={decide.isPending}>
              {review === "approve" ? "Approve & publish" : "Send back"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  "series.created": "Created",
  "series.submitted": "Submitted for approval",
  "series.approved": "Approved",
  "series.rejected": "Changes requested",
  "series.updated": "Edited",
  "series.cancelled": "Series cancelled",
  "occurrence.updated": "Date rescheduled",
  "occurrence.cancelled": "Date cancelled",
};

export function EventDetailPage() {
  const { id } = useParams();
  const me = useUser();
  const occ = useOccurrence(id);
  const o = occ.data;
  const attendees = useAttendees(id, Boolean(o?.canManage));
  const audit = useSeriesAudit(o?.seriesId, Boolean(o?.canManage));
  const siblings = useSeriesOccurrences(o?.seriesId, Boolean(o?.isRecurring));

  if (occ.isPending) return <Spinner />;
  if (!o) return <ErrorState error={occ.error} onRetry={() => occ.refetch()} />;
  const zone = me.timezone;
  const eventZoneDiffers = !o.allDay && o.timezone !== zone;

  return (
    <div className="detail">
      <PageHeader title={o.title}>
        <a className="btn btn-secondary" href={`/api/occurrences/${o.id}/ics`} download>
          <Download size={16} aria-hidden /> Add to calendar (.ics)
        </a>
      </PageHeader>
      {occ.isError && !(occ.error instanceof ApiError && occ.error.status === 404) && <Alert kind="warning">Couldn't refresh; showing the last loaded version.</Alert>}
      {occ.isError && occ.error instanceof ApiError && occ.error.status === 404 && <Alert kind="warning">This event is no longer available to you (it may be awaiting re-approval or was removed).</Alert>}
      <div className="detail-grid">
        <div className="stack">
          <section className="panel club-accent" style={{ ["--club" as string]: o.club.color }}>
            <div className="row wrap">
              <Link to={`/clubs/${o.club.slug}`}>
                <ClubBadge name={o.club.name} color={o.club.color} />
              </Link>
              <StatusBadge status={o.status} />
              {o.visibility === "club" && <span className="badge">Members only</span>}
              <span className="badge">{o.category}</span>
            </div>
            <dl className="facts">
              <dt>When</dt>
              <dd>
                {fullWhen(o, zone)}
                {eventZoneDiffers && (
                  <div className="small muted">
                    Scheduled in {o.timezone}: {timeLabel(o, o.timezone)}
                  </div>
                )}
              </dd>
              <dt>Where</dt>
              <dd>
                {o.room ? (
                  <>
                    <MapPin size={14} aria-hidden /> {o.room.name} — {o.room.location}
                  </>
                ) : (
                  <span className="muted">No room booked</span>
                )}
              </dd>
              <dt>Organizer</dt>
              <dd>{o.organizer.displayName}</dd>
              <dt>Capacity</dt>
              <dd>
                <Users size={14} aria-hidden /> {o.capacity === null ? "No limit" : `${o.capacity} people`}
              </dd>
              {o.isRecurring && (
                <>
                  <dt>Repeats</dt>
                  <dd>
                    <Repeat size={14} aria-hidden /> Part of a weekly series{o.isException ? " (this date was rescheduled individually)" : ""}
                  </dd>
                </>
              )}
            </dl>
            {o.description ? <p className="description">{o.description}</p> : <p className="muted">No description.</p>}
          </section>
          {o.canManage && <ManagePanel o={o} />}
          {o.isRecurring && siblings.data && (
            <section className="panel">
              <h2>All dates in this series</h2>
              <ul className="date-list">
                {siblings.data.items.map((s) => (
                  <li key={s.id} className={s.id === o.id ? "current" : ""}>
                    <Link to={`/events/${s.id}`} aria-current={s.id === o.id ? "page" : undefined}>
                      {DateTime.fromISO(s.startsAt, { zone }).toFormat("ccc LLL d")} · {timeLabel(s, zone)}
                    </Link>
                    {s.status !== "approved" && <StatusBadge status={s.status} />}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className="stack">
          <RsvpPanel o={o} />
          {o.canManage && (
            <section className="panel">
              <h2>Attendees</h2>
              {attendees.isPending ? (
                <Spinner />
              ) : attendees.isError ? (
                <ErrorState error={attendees.error} />
              ) : attendees.data.attendees.filter((a) => a.status !== "not_going").length === 0 ? (
                <p className="muted">No responses yet.</p>
              ) : (
                <ol className="attendees">
                  {attendees.data.attendees
                    .filter((a) => a.status !== "not_going")
                    .map((a) => (
                      <li key={a.userId}>
                        {a.displayName}{" "}
                        <span className={`badge ${a.status === "going" ? "rsvp-going" : "rsvp-wait"}`}>{a.status === "going" ? "Going" : `Waitlist #${a.waitlistPosition}`}</span>
                      </li>
                    ))}
                </ol>
              )}
            </section>
          )}
          {o.canManage && audit.data && (
            <section className="panel">
              <h2>
                <History size={16} aria-hidden /> History
              </h2>
              <ul className="timeline">
                {audit.data.items.map((a) => (
                  <li key={a.id}>
                    <strong>{ACTION_LABELS[a.action] ?? a.action}</strong>
                    <span className="muted small">
                      {" "}
                      by {a.actor?.displayName ?? "system"} · {DateTime.fromISO(a.createdAt).setZone(zone).toFormat("LLL d, h:mm a")}
                    </span>
                    {typeof a.details.comment === "string" && a.details.comment && <div className="small">“{a.details.comment}”</div>}
                    {a.details.changes && typeof a.details.changes === "object" ? (
                      <div className="small muted">Changed: {Object.keys(a.details.changes as object).join(", ").replace(/_/g, " ")}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
