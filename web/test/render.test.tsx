import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { OccurrenceDTO } from "@clubcal/shared";
import { AgendaList, EventCard, MonthView } from "../src/components/calendar";
import { DateTime } from "luxon";

const evil = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

function occ(over: Partial<OccurrenceDTO> = {}): OccurrenceDTO {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    seriesId: "22222222-2222-4222-8222-222222222222",
    title: evil,
    description: `<b>bold?</b>`,
    category: "General",
    club: { id: "c1", name: `<i>Club</i>`, color: "#2563eb", slug: "club" },
    organizer: { id: "u1", displayName: "Org" },
    room: null,
    capacity: 10,
    startsAt: "2026-10-05T20:30:00.000Z",
    endsAt: "2026-10-05T21:30:00.000Z",
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timezone: "America/Chicago",
    visibility: "public",
    status: "approved",
    seriesStatus: "approved",
    occurrenceCancelled: false,
    cancelReason: null,
    isRecurring: false,
    isException: false,
    occurrenceVersion: 1,
    seriesVersion: 1,
    goingCount: 3,
    waitlistCount: 0,
    myRsvp: null,
    myWaitlistPosition: null,
    canManage: false,
    ...over,
  };
}

describe("untrusted event content", () => {
  it("renders titles and club names as text, never as markup", () => {
    const { container } = render(
      <MemoryRouter>
        <EventCard o={occ()} zone="America/Chicago" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: evil })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("i")).toBeNull();
    expect(container.textContent).toContain("<i>Club</i>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("month view chips escape titles too", () => {
    const { container } = render(
      <MemoryRouter>
        <MonthView anchor={DateTime.fromISO("2026-10-01", { zone: "America/Chicago" })} items={[occ()]} zone="America/Chicago" onPickDay={() => {}} />
      </MemoryRouter>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(within(container).getByText(evil)).toBeInTheDocument();
  });
});

describe("agenda view", () => {
  it("groups by the viewer's local day and shows status labels and waitlist position", () => {
    render(
      <MemoryRouter>
        <AgendaList
          zone="America/Chicago"
          items={[
            occ({ id: "a", title: "Late night", startsAt: "2026-10-06T04:30:00.000Z", endsAt: "2026-10-06T04:45:00.000Z" }),
            occ({ id: "b", title: "Waitlisted thing", myRsvp: "waitlisted", myWaitlistPosition: 2 }),
            occ({ id: "c", title: "Pending thing", status: "pending", seriesStatus: "pending" }),
            occ({ id: "d", title: "Field day", allDay: true, allDayStart: "2026-10-07", allDayEnd: "2026-10-09", startsAt: "2026-10-07T05:00:00.000Z", endsAt: "2026-10-09T05:00:00.000Z" }),
          ]}
        />
      </MemoryRouter>,
    );
    const days = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // 04:30Z on Oct 6 is 11:30 PM on Oct 5 in Chicago; the all-day event spans two days.
    expect(days).toEqual(["Monday, October 5", "Wednesday, October 7", "Thursday, October 8"]);
    expect(screen.getByText("Waitlist #2")).toBeInTheDocument();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getAllByText("All day")).toHaveLength(2);
  });

  it("shows a helpful empty state", () => {
    render(
      <MemoryRouter>
        <AgendaList zone="UTC" items={[]} emptyTitle="Nothing here" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});
