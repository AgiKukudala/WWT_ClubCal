import { Download } from "lucide-react";
import { DateTime } from "luxon";
import { Link } from "react-router-dom";
import { qs } from "../api/client";
import { useOccurrences } from "../api/hooks";
import { useUser } from "../auth";
import { AgendaList } from "../components/calendar";
import { ErrorState, PageHeader, Spinner } from "../components/ui";

export function SchedulePage() {
  const me = useUser();
  const start = DateTime.now().setZone(me.timezone).startOf("day");
  const range = { from: start.toUTC().toISO()!, to: start.plus({ days: 90 }).toUTC().toISO()! };
  const mine = useOccurrences({ ...range, mine: true, limit: 500 });
  return (
    <div className="stack">
      <PageHeader title="My Schedule" subtitle="Events you're going to or waitlisted for in the next 90 days.">
        <a className="btn btn-secondary" href={`/api/calendar.ics${qs({ ...range, mine: "true" })}`} download>
          <Download size={16} aria-hidden /> Download my events (.ics)
        </a>
      </PageHeader>
      <p className="small muted">
        The .ics file is a snapshot you can import into Google Calendar, Outlook or Apple Calendar. It does not update automatically — download it again after
        changes. Reminders from ClubCal arrive in <Link to="/notifications">Notifications</Link>.
      </p>
      {mine.isPending ? (
        <Spinner />
      ) : mine.isError && !mine.data ? (
        <ErrorState error={mine.error} onRetry={() => mine.refetch()} />
      ) : (
        <AgendaList items={mine.data.items} zone={me.timezone} emptyTitle="You haven't RSVP'd to anything yet" />
      )}
      {mine.data?.items.length === 0 && (
        <p className="center">
          <Link className="btn btn-primary" to="/?view=agenda">
            Browse upcoming events
          </Link>
        </p>
      )}
    </div>
  );
}
