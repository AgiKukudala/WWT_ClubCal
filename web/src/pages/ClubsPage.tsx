import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ClubSummaryDTO } from "@clubcal/shared";
import { api, errorMessage } from "../api/client";
import { useClubs, useRefreshEvents } from "../api/hooks";
import { Button, DemoBadge, EmptyState, ErrorState, PageHeader, Spinner, useToast } from "../components/ui";

export function useMembership(club: Pick<ClubSummaryDTO, "id" | "name">) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useRefreshEvents();
  return useMutation({
    mutationFn: (action: "join" | "leave") => api.post(`/api/clubs/${club.id}/${action}`),
    onSuccess: async (_d, action) => {
      toast(action === "join" ? `You joined ${club.name}.` : `You left ${club.name}.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ["clubs"] }), qc.invalidateQueries({ queryKey: ["club"] }), qc.invalidateQueries({ queryKey: ["session"] }), refresh()]);
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
}

function ClubCard({ club }: { club: ClubSummaryDTO }) {
  const m = useMembership(club);
  return (
    <article className="club-card" style={{ ["--club" as string]: club.color }}>
      <div className="club-card-top">
        <h2>
          <Link to={`/clubs/${club.slug}`}>{club.name}</Link>
        </h2>
        <span className="badge">{club.category}</span>
      </div>
      <p className="clamp">{club.description || <span className="muted">No description yet.</span>}</p>
      <div className="row between">
        <span className="muted small">
          <Users size={14} aria-hidden /> {club.memberCount} member{club.memberCount === 1 ? "" : "s"}
          {club.isDemo && (
            <>
              {" "}
              · <DemoBadge />
            </>
          )}
        </span>
        {club.myRole === "organizer" ? (
          <span className="badge rsvp-going">You organize</span>
        ) : club.myRole === "member" ? (
          <Button onClick={() => m.mutate("leave")} busy={m.isPending} aria-label={`Leave ${club.name}`}>
            Leave
          </Button>
        ) : (
          <Button variant="primary" onClick={() => m.mutate("join")} busy={m.isPending} aria-label={`Join ${club.name}`}>
            Join
          </Button>
        )}
      </div>
    </article>
  );
}

export function ClubsPage() {
  const clubs = useClubs();
  const [filter, setFilter] = useState("");
  if (clubs.isPending) return <Spinner />;
  if (clubs.isError) return <ErrorState error={clubs.error} onRetry={() => clubs.refetch()} />;
  const list = clubs.data.items.filter((c) => `${c.name} ${c.category} ${c.description}`.toLowerCase().includes(filter.toLowerCase()));
  const mine = list.filter((c) => c.myRole);
  const others = list.filter((c) => !c.myRole);
  return (
    <div className="stack">
      <PageHeader title="Clubs" subtitle="Join clubs to see their members-only events.">
        <label className="search">
          <span className="sr-only">Filter clubs</span>
          <input type="search" placeholder="Filter clubs" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
      </PageHeader>
      {clubs.data.items.length === 0 ? (
        <EmptyState title="No clubs yet">An administrator can create clubs from the Admin area.</EmptyState>
      ) : (
        <>
          {mine.length > 0 && (
            <section className="stack-sm">
              <h2 className="section-title">Your clubs</h2>
              <div className="card-grid">
                {mine.map((c) => (
                  <ClubCard key={c.id} club={c} />
                ))}
              </div>
            </section>
          )}
          <section className="stack-sm">
            <h2 className="section-title">{mine.length ? "More clubs" : "All clubs"}</h2>
            {others.length === 0 ? (
              <p className="muted">{filter ? "No clubs match that filter." : "You're in every club!"}</p>
            ) : (
              <div className="card-grid">
                {others.map((c) => (
                  <ClubCard key={c.id} club={c} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
