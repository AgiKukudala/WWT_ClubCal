import { describe, expect, it } from "vitest";
import { parseLegacyClock, parseLegacyEvents } from "./legacy.js";
import { createEventSchema, findTimesSchema, occurrenceQuerySchema } from "./schemas.js";

describe("legacy parser", () => {
  it("parses 12-hour clock strings produced by the old convertTime()", () => {
    expect(parseLegacyClock("12:05 AM")).toBe("00:05");
    expect(parseLegacyClock("12:30 PM")).toBe("12:30");
    expect(parseLegacyClock("3:45 PM")).toBe("15:45");
    expect(parseLegacyClock("13:00 PM")).toBeNull();
    expect(parseLegacyClock("9:61 AM")).toBeNull();
    expect(parseLegacyClock("17:10")).toBe("17:10");
  });

  it("reports invalid rows instead of guessing", () => {
    const json = JSON.stringify([
      { day: 13, month: 11, year: 2022, events: [{ title: "Chess", time: "3:30 PM - 5:00 PM" }] },
      { day: 31, month: 2, year: 2023, events: [{ title: "Bad date", time: "1:00 PM - 2:00 PM" }] },
      { day: 1, month: 3, year: 2023, events: [{ title: "Backwards", time: "5:00 PM - 4:00 PM" }, { title: "", time: "x" }] },
    ]);
    const { rows, fatal } = parseLegacyEvents(json);
    expect(fatal).toBeNull();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ date: "2022-11-13", startTime: "15:30", endTime: "17:00", problem: null });
    expect(rows[1]!.problem).toMatch(/day\/month\/year/);
    expect(rows[2]!.problem).toMatch(/not after start/);
    expect(rows[3]!.problem).toMatch(/Title/);
  });

  it("rejects non-array JSON", () => {
    expect(parseLegacyEvents("{}").fatal).toMatch(/array/);
    expect(parseLegacyEvents("nope").fatal).toMatch(/JSON/);
  });
});

describe("schemas", () => {
  const base = {
    clubId: "8f7c1b36-4f0e-4b36-9d4e-0d5d0b8a4a11",
    title: "Robotics build night",
    category: "STEM",
    visibility: "public",
    timezone: "America/Chicago",
    allDay: false,
    startDate: "2026-03-02",
    startTime: "15:30",
    durationMinutes: 90,
  } as const;

  it("accepts a valid timed event and trims the title", () => {
    const r = createEventSchema.parse({ ...base, title: "  Build  " });
    expect(r.title).toBe("Build");
    expect(r.submit).toBe(false);
  });

  it("rejects series longer than one year and unknown zones", () => {
    expect(createEventSchema.safeParse({ ...base, recurrence: { weekdays: [1], until: "2027-03-02" } }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, recurrence: { weekdays: [1], until: "2027-03-01" } }).success).toBe(true);
    expect(createEventSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, startDate: "2026-02-30" }).success).toBe(false);
  });

  it("requires timed events for room bookings", () => {
    const r = createEventSchema.safeParse({ ...base, allDay: true, startTime: null, durationMinutes: null, allDayDays: 1, roomId: base.clubId });
    expect(r.success).toBe(false);
  });

  it("bounds calendar range queries", () => {
    expect(occurrenceQuerySchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }).success).toBe(false);
    expect(occurrenceQuerySchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" }).success).toBe(true);
  });

  it("bounds availability searches to two weeks", () => {
    const ok = findTimesSchema.safeParse({ durationMinutes: 60, from: "2026-01-05", to: "2026-01-18", timezone: "America/Chicago" });
    const tooLong = findTimesSchema.safeParse({ durationMinutes: 60, from: "2026-01-05", to: "2026-01-19", timezone: "America/Chicago" });
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });
});
