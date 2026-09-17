import { ChevronLeft, ChevronRight, Download, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { OccurrenceDTO } from "@clubcal/shared";
import { qs } from "../api/client";
import { useCategories, useClubs, useOccurrences, useRooms } from "../api/hooks";
import { isManager, useUser } from "../auth";
import { AgendaList, MonthView, WeekView } from "../components/calendar";
import { Button, ErrorState, PageHeader, Spinner } from "../components/ui";
import { parseDay, rangeTitle, shiftAnchor, type View, viewRange } from "../lib/dates";

const VIEWS: { id: View; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "agenda", label: "Agenda" },
];

function defaultView(): View {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 720px)").matches ? "agenda" : "month";
}

export function CalendarPage() {
  const me = useUser();
  const zone = me.timezone;
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) || defaultView();
  const anchor = parseDay(params.get("date"), zone);
  const clubId = params.get("club") ?? "";
  const roomId = params.get("room") ?? "";
  const category = params.get("category") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const [extra, setExtra] = useState<OccurrenceDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) update({ q: search.trim() || null });
    }, 350);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const { start, end } = viewRange(view, anchor);
  const filters = { from: start.toUTC().toISO()!, to: end.toUTC().toISO()!, clubId: clubId || undefined, roomId: roomId || undefined, category: category || undefined, q: q || undefined };
  const query = useOccurrences({ ...filters, limit: view === "agenda" ? 100 : 500 });
  useEffect(() => {
    setExtra([]);
    setCursor(undefined);
  }, [JSON.stringify(filters), view]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = useOccurrences({ ...filters, limit: 100, cursor }, Boolean(cursor));
  useEffect(() => {
    if (more.data && cursor) setExtra((e) => [...e, ...more.data.items.filter((i) => !e.some((x) => x.id === i.id))]);
  }, [more.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const clubs = useClubs();
  const rooms = useRooms();
  const categories = useCategories();
  const items = useMemo(() => [...(query.data?.items ?? []), ...extra], [query.data, extra]);
  const nextCursor = cursor ? more.data?.nextCursor : query.data?.nextCursor;
  const hasFilters = Boolean(clubId || roomId || category || q);

  return (
    <div className="stack">
      <PageHeader title="Calendar" subtitle="Published events for every club you can see.">
        <a className="btn btn-secondary" href={`/api/calendar.ics${qs({ from: filters.from, to: filters.to, clubId: filters.clubId })}`} download>
          <Download size={16} aria-hidden /> Export .ics
        </a>
        {isManager(me) && (
          <Link className="btn btn-primary" to="/events/new">
            <Plus size={16} aria-hidden /> New event
          </Link>
        )}
      </PageHeader>

      <div className="toolbar">
        <div className="row">
          <Button onClick={() => update({ date: shiftAnchor(view, anchor, -1).toISODate() })} aria-label="Previous">
            <ChevronLeft size={18} />
          </Button>
          <Button onClick={() => update({ date: null })}>Today</Button>
          <Button onClick={() => update({ date: shiftAnchor(view, anchor, 1).toISODate() })} aria-label="Next">
            <ChevronRight size={18} />
          </Button>
          <h2 className="range-title" aria-live="polite">
            {rangeTitle(view, anchor)}
          </h2>
        </div>
        <div className="segmented" role="tablist" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => update({ view: v.id })}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="search">
          <Search size={16} aria-hidden />
          <span className="sr-only">Search events</span>
          <input type="search" placeholder="Search titles and descriptions" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          <span className="sr-only">Club</span>
          <select value={clubId} onChange={(e) => update({ club: e.target.value || null })}>
            <option value="">All clubs</option>
            {clubs.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Room</span>
          <select value={roomId} onChange={(e) => update({ room: e.target.value || null })}>
            <option value="">All rooms</option>
            {rooms.data?.items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Category</span>
          <select value={category} onChange={(e) => update({ category: e.target.value || null })}>
            <option value="">All categories</option>
            {categories.data?.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {hasFilters && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch("");
              update({ club: null, room: null, category: null, q: null });
            }}
          >
            <X size={16} aria-hidden /> Clear filters
          </Button>
        )}
      </form>

      {query.isPending ? (
        <Spinner label="Loading events…" />
      ) : query.isError && !query.data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <>
          {query.isError && <div className="alert alert-warning">Showing the last loaded data; refreshing failed.</div>}
          {view === "month" && <MonthView anchor={anchor} items={items} zone={zone} onPickDay={(d) => update({ view: "week", date: d })} />}
          {view === "week" && <WeekView anchor={anchor} items={items} zone={zone} />}
          {view === "agenda" && <AgendaList items={items} zone={zone} emptyTitle={hasFilters ? "No events match these filters" : "No events in the next 30 days"} />}
          {view !== "month" && items.length === 0 ? null : view === "month" && items.length === 0 ? (
            <p className="muted center">{hasFilters ? "No events match these filters this month." : "No events this month yet."}</p>
          ) : null}
          {nextCursor && (
            <div className="center">
              <Button onClick={() => setCursor(nextCursor)} busy={more.isFetching}>
                Load more events
              </Button>
            </div>
          )}
        </>
      )}
      <p className="muted small">
        Status labels: <strong>Published</strong> events are visible to students; <em>Awaiting approval</em> events are only shown to their club's organizers and administrators.
      </p>
    </div>
  );
}
