import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { OccurrenceDTO } from "@clubcal/shared";
import { layoutDay, rangeTitle, shiftAnchor, viewRange } from "../src/lib/dates";

const base = { allDay: false, allDayStart: null, allDayEnd: null } as unknown as OccurrenceDTO;
const ev = (id: string, s: string, e: string) => ({ ...base, id, startsAt: s, endsAt: e }) as OccurrenceDTO;

describe("calendar ranges", () => {
  it("month view covers six full Sunday-start weeks", () => {
    const { start, end } = viewRange("month", DateTime.fromISO("2026-09-16", { zone: "America/Chicago" }));
    expect(start.toISODate()).toBe("2026-08-30");
    expect(end.diff(start, "days").days).toBe(42);
    expect(start.weekday).toBe(7);
  });
  it("week navigation and titles", () => {
    const a = DateTime.fromISO("2026-12-30", { zone: "UTC" });
    expect(rangeTitle("week", a)).toBe("Dec 27, 2026 – Jan 2, 2027");
    expect(shiftAnchor("month", a, 1).toISODate()).toBe("2027-01-01");
  });
});

describe("week layout", () => {
  it("places overlapping events side by side and back-to-back events in the same lane", () => {
    const z = "UTC";
    const blocks = layoutDay(
      [
        ev("a", "2026-10-05T10:00:00Z", "2026-10-05T11:00:00Z"),
        ev("b", "2026-10-05T10:30:00Z", "2026-10-05T11:30:00Z"),
        ev("c", "2026-10-05T11:30:00Z", "2026-10-05T12:00:00Z"),
      ],
      z,
      "2026-10-05",
    );
    const byId = Object.fromEntries(blocks.map((b) => [b.o.id, b]));
    expect([byId.a!.lane, byId.b!.lane]).toEqual([0, 1]);
    expect(byId.a!.lanes).toBe(2);
    expect(byId.c!.lanes).toBe(1);
    expect(byId.a!.start).toBe(600);
  });
});
