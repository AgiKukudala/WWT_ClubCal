import type { FindTimesInput, FindTimesResultDTO, TimeSuggestionDTO } from "@clubcal/shared";
import { SLOT_MINUTES } from "@clubcal/shared";
import { type Actor, isAdmin } from "../../auth/context.js";
import type { Db } from "../../db/index.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { addDays, hhmm, localParts, minutesToTime, resolveLocal, timeToMinutes } from "../../lib/time.js";
import { hoursProblem, loadRoom, type RoomInfo, roomBusy } from "../bookings/bookings.js";

export const SCORING_RULE =
  "score = 100 − 15 × (participants without declared availability) − round(20 × spare-seat fraction) − 2 × (days after the first searched day). " +
  "Slots where any participant is known to be unavailable, the room is closed, or the room is booked are excluded. " +
  "Ties break by earlier start, then room name. At most 3 suggestions per day are returned.";

interface Interval {
  start: number;
  end: number;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * Deterministic availability search. Suggestions are advisory: creating the event
 * re-validates hours and conflicts inside the booking transaction.
 */
export async function findTimes(db: Db, actor: Actor, input: FindTimesInput, now = new Date()): Promise<FindTimesResultDTO> {
  if (actor.user.role === "student") throw forbidden();

  // Participants must belong to a club the requester manages (admins: anyone).
  const participantIds = [...new Set(input.participantIds)];
  let participants: { id: string; display_name: string; timezone: string }[] = [];
  if (participantIds.length) {
    let q = db.selectFrom("users as u").select(["u.id", "u.display_name", "u.timezone"]).where("u.id", "in", participantIds).where("u.disabled_at", "is", null);
    if (!isAdmin(actor)) {
      const managed = [...actor.organizerClubIds];
      if (managed.length === 0) throw forbidden("You do not manage any clubs.");
      q = q.where((eb) =>
        eb.exists(eb.selectFrom("club_memberships as m").select("m.user_id").whereRef("m.user_id", "=", "u.id").where("m.club_id", "in", managed)),
      );
    }
    participants = await q.execute();
    if (participants.length !== participantIds.length) throw badRequest("Some participants are not members of your clubs.", { participantIds: ["Unknown participant"] });
  }

  let roomQ = db.selectFrom("rooms").select(["id", "name", "location", "capacity", "features"]).where("is_active", "=", true).where("capacity", ">=", input.minCapacity);
  if (input.roomIds.length) roomQ = roomQ.where("id", "in", input.roomIds);
  const roomRows = (await roomQ.orderBy("name").execute()).filter((r) =>
    input.requiredFeatures.every((f) => r.features.map((x) => x.toLowerCase()).includes(f.toLowerCase())),
  );
  const rooms: (RoomInfo & { location: string })[] = [];
  for (const r of roomRows) rooms.push({ ...(await loadRoom(db, r.id)), location: r.location });

  const rangeStart = resolveLocal(input.from, "00:00", input.timezone).instant;
  const rangeEnd = resolveLocal(addDays(input.to, 1), "00:00", input.timezone).instant;

  const busyByRoom = new Map<string, Interval[]>();
  for (const b of await roomBusy(db, rooms.map((r) => r.id), rangeStart, rangeEnd)) {
    const list = busyByRoom.get(b.room_id) ?? [];
    list.push({ start: new Date(b.starts_at).getTime(), end: new Date(b.ends_at).getTime() });
    busyByRoom.set(b.room_id, list);
  }

  const windows = new Map<string, { weekday: number; start: number; end: number }[]>();
  const busyByUser = new Map<string, Interval[]>();
  if (participants.length) {
    const avail = await db.selectFrom("user_availability").selectAll().where("user_id", "in", participants.map((p) => p.id)).execute();
    for (const a of avail) {
      const list = windows.get(a.user_id) ?? [];
      list.push({ weekday: a.weekday, start: timeToMinutes(hhmm(a.start_time)), end: timeToMinutes(hhmm(a.end_time)) });
      windows.set(a.user_id, list);
    }
    const commitments = await db
      .selectFrom("rsvps as r")
      .innerJoin("event_occurrences as o", "o.id", "r.occurrence_id")
      .innerJoin("event_series as s", "s.id", "o.series_id")
      .select(["r.user_id", "o.starts_at", "o.ends_at"])
      .where("r.user_id", "in", participants.map((p) => p.id))
      .where("r.status", "=", "going")
      .where("s.status", "=", "approved")
      .where("o.cancelled_at", "is", null)
      .where("o.starts_at", "<", rangeEnd)
      .where("o.ends_at", ">", rangeStart)
      .execute();
    for (const c of commitments) {
      const list = busyByUser.get(c.user_id) ?? [];
      list.push({ start: c.starts_at.getTime(), end: c.ends_at.getTime() });
      busyByUser.set(c.user_id, list);
    }
  }
  const unknown = participants.filter((p) => !windows.has(p.id));
  const known = participants.filter((p) => windows.has(p.id));

  const suggestions: TimeSuggestionDTO[] = [];
  let considered = 0;
  const earliest = timeToMinutes(input.earliest);
  const latest = timeToMinutes(input.latest);

  for (let day = input.from, dayIndex = 0; day <= input.to; day = addDays(day, 1), dayIndex++) {
    for (let m = earliest; m + input.durationMinutes <= latest; m += SLOT_MINUTES) {
      const start = resolveLocal(day, minutesToTime(m), input.timezone);
      if (start.resolution !== "exact") continue; // never suggest DST-shifted wall times
      const slot: Interval = { start: start.instant.getTime(), end: start.instant.getTime() + input.durationMinutes * 60_000 };
      if (slot.start <= now.getTime()) continue;
      considered++;

      const blocked = known.some((p) => {
        const s = localParts(new Date(slot.start), p.timezone);
        const e = localParts(new Date(slot.end), p.timezone);
        if (s.date !== e.date && e.minutes !== 0) return true;
        const endMin = s.date === e.date ? e.minutes : 1440;
        const inside = windows.get(p.id)!.some((w) => w.weekday === s.weekday && w.start <= s.minutes && endMin <= w.end);
        return !inside;
      }) || participants.some((p) => (busyByUser.get(p.id) ?? []).some((b) => overlaps(b, slot)));
      if (blocked) continue;

      for (const room of rooms) {
        if (hoursProblem(room, new Date(slot.start), new Date(slot.end))) continue;
        if ((busyByRoom.get(room.id) ?? []).some((b) => overlaps(b, slot))) continue;
        const spare = room.capacity - input.minCapacity;
        const spareFraction = room.capacity > 0 ? spare / room.capacity : 0;
        const score = 100 - 15 * unknown.length - Math.round(20 * spareFraction) - 2 * dayIndex;
        const reasons: string[] = [];
        if (participants.length === 0) reasons.push("No participants were specified, so attendee availability was not considered.");
        else if (known.length > 0)
          reasons.push(`${known.length} of ${participants.length} participant${participants.length === 1 ? "" : "s"} declared availability covering this slot and have no conflicting RSVPs.`);
        if (unknown.length > 0)
          reasons.push(`Availability unknown for ${unknown.map((u) => u.display_name).join(", ")} (no availability declared; only their RSVPs were checked).`);
        reasons.push(`${room.name} seats ${room.capacity} (needs ${input.minCapacity}; ${spare} spare).`);
        const window = room.hours.get(localParts(new Date(slot.start), room.timezone).weekday)!;
        reasons.push(`Inside ${room.name}'s opening hours (${minutesToTime(window.opens)}–${minutesToTime(window.closes)}) and not booked.`);
        if (dayIndex > 0) reasons.push(`${dayIndex} day${dayIndex === 1 ? "" : "s"} after the start of the search range.`);
        suggestions.push({
          startsAt: new Date(slot.start).toISOString(),
          endsAt: new Date(slot.end).toISOString(),
          localDate: day,
          localStart: minutesToTime(m),
          localEnd: localParts(new Date(slot.end), input.timezone).time,
          room: { id: room.id, name: room.name, capacity: room.capacity, location: room.location },
          score,
          availableParticipants: known.length,
          unknownParticipants: unknown.map((u) => ({ id: u.id, displayName: u.display_name })),
          reasons,
        });
      }
    }
  }

  suggestions.sort((a, b) => b.score - a.score || a.startsAt.localeCompare(b.startsAt) || a.room.name.localeCompare(b.room.name));
  const perDay = new Map<string, number>();
  const picked: TimeSuggestionDTO[] = [];
  for (const s of suggestions) {
    const n = perDay.get(s.localDate) ?? 0;
    if (n >= 3) continue;
    perDay.set(s.localDate, n + 1);
    picked.push(s);
    if (picked.length >= input.limit) break;
  }
  return {
    suggestions: picked,
    consideredSlots: considered,
    roomsConsidered: rooms.length,
    participantsWithoutAvailability: unknown.map((u) => ({ id: u.id, displayName: u.display_name })),
    scoringRule: SCORING_RULE,
  };
}
