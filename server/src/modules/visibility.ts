import { type ExpressionBuilder, sql, type SqlBool, type Expression } from "kysely";
import type { Actor } from "../auth/context.js";
import type { DB } from "../db/types.js";

type SeriesScope = ExpressionBuilder<DB & { s: DB["event_series"] }, "s">;

/**
 * The single source of truth for who may read which events. Every read path
 * (lists, detail by ID, .ics export, RSVP) goes through this predicate.
 *
 *  - Administrators: everything.
 *  - Organizers: everything belonging to clubs they are assigned to (drafts included).
 *  - Everyone signed in: approved (or approved-then-cancelled) public events.
 *  - Club members: approved (or cancelled) club-only events of their clubs.
 */
export function seriesVisibleTo(actor: Actor) {
  return (eb: SeriesScope): Expression<SqlBool> => {
    if (actor.user.role === "admin") return sql<boolean>`true`;
    const managed = [...actor.organizerClubIds];
    const member = [...actor.memberClubIds];
    const published = eb("s.status", "in", ["approved", "cancelled"]);
    const audience =
      member.length > 0
        ? eb.or([eb("s.visibility", "=", "public"), eb("s.club_id", "in", member)])
        : eb("s.visibility", "=", "public");
    const branches = [eb.and([published, audience])];
    if (managed.length > 0) branches.push(eb("s.club_id", "in", managed));
    return eb.or(branches);
  };
}

export function canViewSeries(
  actor: Actor,
  s: { club_id: string; status: string; visibility: string },
): boolean {
  if (actor.user.role === "admin") return true;
  if (actor.user.role === "organizer" && actor.organizerClubIds.has(s.club_id)) return true;
  if (s.status !== "approved" && s.status !== "cancelled") return false;
  return s.visibility === "public" || actor.memberClubIds.has(s.club_id);
}
