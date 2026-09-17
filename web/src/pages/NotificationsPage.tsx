import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Mail } from "lucide-react";
import { DateTime } from "luxon";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useNotifications } from "../api/hooks";
import { useUser } from "../auth";
import { Button, EmptyState, ErrorState, PageHeader, Spinner } from "../components/ui";

export function NotificationsPage() {
  const me = useUser();
  const list = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: ["notifications"] }), qc.invalidateQueries({ queryKey: ["unread"] })]);
  const markAll = useMutation({ mutationFn: () => api.post("/api/notifications/read-all"), onSuccess: invalidate });
  const markOne = useMutation({ mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`), onSuccess: invalidate });

  const unread = list.data?.items.filter((n) => !n.readAt).length ?? 0;
  return (
    <div className="stack narrow">
      <PageHeader title="Notifications" subtitle="Reminders, waitlist updates, approvals and changes to your events.">
        <Link className="btn btn-ghost" to="/settings">
          Reminder settings
        </Link>
        <Button onClick={() => markAll.mutate()} disabled={unread === 0} busy={markAll.isPending}>
          <CheckCheck size={16} aria-hidden /> Mark all read
        </Button>
      </PageHeader>
      {list.isPending ? (
        <Spinner />
      ) : list.isError && !list.data ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="You're all caught up">Reminders appear here 24 hours and 1 hour before events you're going to.</EmptyState>
      ) : (
        <ul className="notifications">
          {list.data.items.map((n) => (
            <li key={n.id} className={n.readAt ? "" : "unread"}>
              <Bell size={16} aria-hidden className="n-icon" />
              <div className="n-body">
                <button
                  className="link-like"
                  onClick={() => {
                    if (!n.readAt) markOne.mutate(n.id);
                    if (n.occurrenceId) navigate(`/events/${n.occurrenceId}`);
                  }}
                >
                  {!n.readAt && <span className="sr-only">Unread: </span>}
                  {n.title}
                </button>
                {n.body && <p>{n.body}</p>}
                <span className="small muted">
                  {DateTime.fromISO(n.createdAt).setZone(me.timezone).toFormat("ccc LLL d, h:mm a")}
                  {n.emailStatus === "sent" && (
                    <>
                      {" "}
                      · <Mail size={12} aria-hidden /> emailed
                    </>
                  )}
                  {n.emailStatus === "failed" && " · email delivery failed"}
                </span>
              </div>
              {!n.readAt && (
                <Button variant="ghost" onClick={() => markOne.mutate(n.id)} aria-label={`Mark "${n.title}" as read`}>
                  Mark read
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
