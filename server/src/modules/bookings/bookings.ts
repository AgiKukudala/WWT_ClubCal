import { sql } from "kysely";
import type { ConflictDetail } from "@clubcal/shared";
import type { DbOrTx, Tx } from "../../db/index.js";
import { conflict, notFound } from "../../lib/errors.js";
import { formatLocalRange, hhmm, localParts, timeToMinutes } from "../../lib/time.js";

export interface BookingCandidate {
  occurrenceId?: string;
  date: string;
  roomId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number | null;
}

export interface RoomInfo {
  id: string;
  name: string;
  capacity: number;
  timezone: string;
  isActive: boolean;
  hours: Map<number, { opens: number; closes: number }>;
}

export async function loadRoom(db: DbOrTx, roomId: string): Promise<RoomInfo> {
  const room = await db.selectFrom("rooms").selectAll().where("id", "=", roomId).executeTakeFirst();
  if (!room) throw notFound("Room");
  const hours = await db.selectFrom("room_hours").selectAll().where("room_id", "=", roomId).execute();
  return {
    id: room.id,
    name: room.name,
    capacity: room.capacity,
    timezone: room.timezone,
    isActive: room.is_active,
    hours: new Map(hours.map((h) => [h.weekday, { opens: timeToMinutes(hhmm(h.opens_at)), closes: timeToMinutes(hhmm(h.closes_at)) }])),
  };
}

/** Pure opening-hours check. Bookings must start and end on the same local day inside the window. */
export function hoursProblem(room: RoomInfo, startsAt: Date, endsAt: Date): string | null {
  const s = localParts(startsAt, room.timezone);
  const e = localParts(endsAt, room.timezone);
  const window = room.hours.get(s.weekday);
  if (!window) return `${room.name} is closed on that day.`;
  const endMinutes = e.date === s.date ? e.minutes : e.minutes === 0 && e.date > s.date ? 24 * 60 : Number.POSITIVE_INFINITY;
  if (s.minutes < window.opens || endMinutes > window.closes) {
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return `${room.name} is open ${fmt(window.opens)}–${fmt(window.closes)} on that day.`;
  }
  return null;
}

/**
 * Validates every candidate (room active, capacity, opening hours, overlaps) and
 * returns *all* problems so the caller can report them together. Private details of
 * other events are never included — only that the slot is taken.
 */
export async function findBookingConflicts(db: DbOrTx, candidates: BookingCandidate[]): Promise<ConflictDetail[]> {
  if (candidates.length === 0) return [];
  const rooms = new Map<string, RoomInfo>();
  for (const id of new Set(candidates.map((c) => c.roomId))) rooms.set(id, await loadRoom(db, id));
  const problems: ConflictDetail[] = [];
  const push = (c: BookingCandidate, reason: ConflictDetail["reason"], message: string) =>
    problems.push({ date: c.date, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), reason, message });

  for (const c of candidates) {
    const room = rooms.get(c.roomId)!;
    if (!room.isActive) push(c, "room_inactive", `${room.name} is not currently bookable.`);
    else if (c.capacity !== null && c.capacity > room.capacity)
      push(c, "capacity_exceeds_room", `Capacity ${c.capacity} exceeds ${room.name}'s limit of ${room.capacity}.`);
    else {
      const hp = hoursProblem(room, c.startsAt, c.endsAt);
      if (hp) push(c, "outside_hours", hp);
    }
  }

  const own = candidates.map((c) => c.occurrenceId).filter((x): x is string => Boolean(x));
  const taken = await sql<{ idx: string }>`
    SELECT DISTINCT x.idx::text AS idx
    FROM unnest(${candidates.map((c) => c.roomId)}::uuid[],
                ${candidates.map((c) => c.startsAt.toISOString())}::timestamptz[],
                ${candidates.map((c) => c.endsAt.toISOString())}::timestamptz[])
         WITH ORDINALITY AS x(room_id, s, e, idx)
    JOIN room_reservations r ON r.room_id = x.room_id AND r.during && tstzrange(x.s, x.e, '[)')
    WHERE NOT (r.occurrence_id = ANY(${own}::uuid[]))`.execute(db);
  for (const { idx } of taken.rows) {
    const c = candidates[Number(idx) - 1]!;
    const room = rooms.get(c.roomId)!;
    push(c, "room_booked", `${room.name} is already reserved during ${formatLocalRange(c.startsAt, c.endsAt, room.timezone)}.`);
  }

  // Candidates in the same request must not overlap each other either.
  const sorted = candidates.map((c, i) => ({ c, i })).sort((a, b) => a.c.startsAt.getTime() - b.c.startsAt.getTime());
  for (let a = 0; a < sorted.length; a++) {
    for (let b = a + 1; b < sorted.length && sorted[b]!.c.startsAt < sorted[a]!.c.endsAt; b++) {
      if (sorted[b]!.c.roomId === sorted[a]!.c.roomId) {
        push(sorted[b]!.c, "room_booked", "This occurrence overlaps another occurrence of the same series in the same room.");
      }
    }
  }
  problems.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  return problems;
}

/**
 * Replaces the reservations held by the given occurrences. Validates first and throws
 * a 409 listing every conflict; otherwise inserts. The exclusion constraint remains
 * the final arbiter when two transactions race past validation at the same time.
 */
export async function reserve(tx: Tx, candidates: (BookingCandidate & { occurrenceId: string })[]): Promise<void> {
  if (candidates.length === 0) return;
  await release(tx, candidates.map((c) => c.occurrenceId));
  const problems = await findBookingConflicts(tx, candidates);
  if (problems.length > 0) {
    const n = new Set(problems.map((p) => p.date)).size;
    throw conflict(
      n === 1 ? `The room booking could not be made: ${problems[0]!.message}` : `${n} occurrences could not be booked. Nothing was changed.`,
      problems,
    );
  }
  await tx
    .insertInto("room_reservations")
    .values(
      candidates.map((c) => ({
        room_id: c.roomId,
        occurrence_id: c.occurrenceId,
        during: sql<string>`tstzrange(${c.startsAt.toISOString()}::timestamptz, ${c.endsAt.toISOString()}::timestamptz, '[)')` as unknown as string,
      })),
    )
    .execute();
}

export async function release(tx: Tx, occurrenceIds: string[]): Promise<void> {
  if (occurrenceIds.length === 0) return;
  await tx.deleteFrom("room_reservations").where("occurrence_id", "in", occurrenceIds).execute();
}

/** Busy blocks for a room (no event details) — used by pickers and the availability finder. */
export async function roomBusy(db: DbOrTx, roomIds: string[], from: Date, to: Date) {
  if (roomIds.length === 0) return [];
  return db
    .selectFrom("room_reservations")
    .select(["room_id", "occurrence_id", sql<Date>`lower(during)`.as("starts_at"), sql<Date>`upper(during)`.as("ends_at")])
    .where("room_id", "in", roomIds)
    .where(sql<boolean>`during && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`)
    .orderBy(sql`lower(during)`)
    .execute();
}
