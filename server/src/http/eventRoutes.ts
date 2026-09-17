import { Router } from "express";
import {
  cancelSchema,
  createEventSchema,
  findTimesSchema,
  MAX_RANGE_DAYS,
  occurrenceQuerySchema,
  reviewSchema,
  rsvpSchema,
  submitSchema,
  updateOccurrenceSchema,
  updateSeriesSchema,
} from "@clubcal/shared";
import { z } from "zod";
import { canManageClub, isAdmin } from "../auth/context.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { config } from "../config.js";
import { forbidden, notFound } from "../lib/errors.js";
import { buildCalendar } from "../lib/ics.js";
import {
  cancelEvent,
  createEvent,
  deleteSeries,
  getSeries,
  reviewSeries,
  submitSeries,
  updateOccurrence,
  updateSeries,
} from "../modules/events/service.js";
import { getOccurrence, listOccurrences, listSeriesOccurrences } from "../modules/occurrences/read.js";
import { listAttendees, setRsvp } from "../modules/rsvps/rsvps.js";
import { findTimes } from "../modules/scheduling/findTimes.js";
import { canViewSeries } from "../modules/visibility.js";
import type { AppDeps } from "./app.js";
import { idParam, parse } from "./validate.js";

const icsQuery = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    clubId: z.uuid().optional(),
    mine: z.enum(["true", "false"]).optional(),
  })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= MAX_RANGE_DAYS * 86_400_000, {
    message: `Choose a range of at most ${MAX_RANGE_DAYS} days`,
  });

function icsFilename(name: string) {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "event";
}

export function eventRoutes(deps: AppDeps) {
  const { db, queue } = deps;
  const r = Router();
  r.use(requireAuth);
  const host = new URL(config.PUBLIC_URL).hostname;

  r.get("/occurrences", async (req, res) => {
    const q = parse(occurrenceQuerySchema, req.query);
    const page = await listOccurrences(db, req.actor!, { ...q, mine: q.mine === "true" });
    res.set("Cache-Control", "no-store").json(page);
  });

  r.get("/occurrences/:id", async (req, res) => {
    const occ = await getOccurrence(db, req.actor!, idParam(req.params.id));
    if (!occ) throw notFound("Event");
    res.set("Cache-Control", "no-store").json(occ);
  });

  r.patch("/occurrences/:id", async (req, res) => {
    const input = parse(updateOccurrenceSchema, req.body);
    await updateOccurrence(deps, req.actor!, idParam(req.params.id), input);
    res.json(await getOccurrence(db, req.actor!, req.params.id));
  });

  r.post("/occurrences/:id/cancel", async (req, res) => {
    const input = parse(cancelSchema, req.body);
    const result = await cancelEvent(deps, req.actor!, idParam(req.params.id), input.scope, input.reason);
    res.json({ cancelled: result.cancelled, occurrence: await getOccurrence(db, req.actor!, req.params.id) });
  });

  r.put("/occurrences/:id/rsvp", async (req, res) => {
    const { response } = parse(rsvpSchema, req.body);
    const result = await setRsvp(db, queue, req.actor!, idParam(req.params.id), response);
    res.json(result);
  });

  r.get("/occurrences/:id/attendees", async (req, res) => {
    const id = idParam(req.params.id);
    const occ = await getOccurrence(db, req.actor!, id);
    if (!occ) throw notFound("Event");
    if (!occ.canManage) throw forbidden("Only organizers of this club can see the attendee list.");
    res.json({ attendees: await listAttendees(db, id) });
  });

  r.get("/occurrences/:id/ics", async (req, res) => {
    const occ = await getOccurrence(db, req.actor!, idParam(req.params.id));
    if (!occ) throw notFound("Event");
    const body = buildCalendar([occ], { name: occ.title, host, publicUrl: config.PUBLIC_URL });
    res
      .type("text/calendar; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${icsFilename(occ.title)}.ics"`)
      .set("Cache-Control", "no-store")
      .send(body);
  });

  r.get("/calendar.ics", async (req, res) => {
    const q = parse(icsQuery, req.query);
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await listOccurrences(db, req.actor!, {
        from: q.from,
        to: q.to,
        clubId: q.clubId,
        mine: q.mine === "true",
        status: undefined,
        limit: 500,
        cursor,
      });
      // Exported calendars only contain published events (approved or cancelled).
      items.push(...page.items.filter((i) => i.seriesStatus === "approved" || i.status === "cancelled"));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && items.length < 5000);
    const name = q.mine === "true" ? "My ClubCal schedule" : "ClubCal events";
    res
      .type("text/calendar; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${icsFilename(name)}.ics"`)
      .set("Cache-Control", "no-store")
      .send(buildCalendar(items, { name, host, publicUrl: config.PUBLIC_URL }));
  });

  r.post("/series", requireRole("organizer", "admin"), async (req, res) => {
    const input = parse(createEventSchema, req.body);
    const { series, occurrences } = await createEvent(deps, req.actor!, input);
    res.status(201).json({ seriesId: series.id, status: series.status, firstOccurrenceId: occurrences[0]?.id ?? null, occurrenceCount: occurrences.length });
  });

  r.get("/series/:id", async (req, res) => {
    res.json(await getSeries(db, req.actor!, idParam(req.params.id)));
  });

  r.get("/series/:id/occurrences", async (req, res) => {
    const id = idParam(req.params.id);
    await getSeries(db, req.actor!, id); // visibility check (404 if hidden)
    res.json({ items: await listSeriesOccurrences(db, req.actor!, id) });
  });

  r.put("/series/:id", requireRole("organizer", "admin"), async (req, res) => {
    const input = parse(updateSeriesSchema, req.body);
    const s = await updateSeries(deps, req.actor!, idParam(req.params.id), input);
    res.json(await getSeries(db, req.actor!, s.id));
  });

  r.post("/series/:id/submit", requireRole("organizer", "admin"), async (req, res) => {
    const { expectedVersion } = parse(submitSchema, req.body);
    const s = await submitSeries(deps, req.actor!, idParam(req.params.id), expectedVersion);
    res.json(await getSeries(db, req.actor!, s.id));
  });

  r.post("/series/:id/review", requireRole("admin"), async (req, res) => {
    const input = parse(reviewSchema, req.body);
    const s = await reviewSeries(deps, req.actor!, idParam(req.params.id), input.decision, input.comment, input.expectedVersion);
    res.json(await getSeries(db, req.actor!, s.id));
  });

  r.delete("/series/:id", requireRole("organizer", "admin"), async (req, res) => {
    await deleteSeries(deps, req.actor!, idParam(req.params.id));
    res.status(204).end();
  });

  r.get("/series/:id/audit", async (req, res) => {
    const id = idParam(req.params.id);
    const s = await db.selectFrom("event_series").select(["club_id", "status", "visibility"]).where("id", "=", id).executeTakeFirst();
    if (!s || !canViewSeries(req.actor!, s)) throw notFound("Event");
    if (!canManageClub(req.actor!, s.club_id)) throw forbidden();
    const rows = await db
      .selectFrom("audit_log as a")
      .leftJoin("users as u", "u.id", "a.actor_id")
      .select(["a.id", "a.action", "a.entity_type", "a.entity_id", "a.details", "a.created_at", "u.id as uid", "u.display_name"])
      .where((eb) =>
        eb.or([
          eb.and([eb("a.entity_type", "=", "series"), eb("a.entity_id", "=", id)]),
          eb.and([
            eb("a.entity_type", "=", "occurrence"),
            eb("a.entity_id", "in", eb.selectFrom("event_occurrences").select("id").where("series_id", "=", id)),
            eb("a.action", "not like", "rsvp.%"),
          ]),
        ]),
      )
      .orderBy("a.created_at", "desc")
      .limit(100)
      .execute();
    res.json({
      items: rows.map((a) => ({
        id: a.id,
        actor: a.uid ? { id: a.uid, displayName: a.display_name! } : null,
        action: a.action,
        entityType: a.entity_type,
        entityId: a.entity_id,
        details: a.details,
        createdAt: a.created_at.toISOString(),
      })),
    });
  });

  r.post("/scheduling/find-times", requireRole("organizer", "admin"), async (req, res) => {
    const input = parse(findTimesSchema, req.body);
    res.json(await findTimes(db, req.actor!, input));
  });

  r.get("/categories", async (req, res) => {
    const rows = await db
      .selectFrom("clubs")
      .select("category")
      .where("archived_at", "is", null)
      .union(db.selectFrom("event_series").select("category").where("status", "=", "approved"))
      .execute();
    res.json({ categories: [...new Set(rows.map((r) => r.category))].sort() });
  });

  r.get("/approvals", requireRole("admin"), async (req, res) => {
    if (!isAdmin(req.actor!)) throw forbidden();
    const rows = await db
      .selectFrom("event_series as s")
      .innerJoin("clubs as c", "c.id", "s.club_id")
      .innerJoin("users as u", "u.id", "s.created_by")
      .select([
        "s.id",
        "s.title",
        "s.submitted_at",
        "s.version",
        "s.room_id",
        "s.recurrence_weekdays",
        "s.reviewed_at",
        "c.name as club_name",
        "c.color as club_color",
        "u.display_name as organizer_name",
        (eb) =>
          eb
            .selectFrom("event_occurrences as o")
            .select("o.id")
            .whereRef("o.series_id", "=", "s.id")
            .where("o.cancelled_at", "is", null)
            .orderBy("o.starts_at")
            .limit(1)
            .as("first_occurrence_id"),
        (eb) =>
          eb
            .selectFrom("event_occurrences as o")
            .select((e) => e.fn.min("o.starts_at").as("m"))
            .whereRef("o.series_id", "=", "s.id")
            .where("o.cancelled_at", "is", null)
            .as("first_starts_at"),
      ])
      .where("s.status", "=", "pending")
      .orderBy("s.submitted_at")
      .limit(200)
      .execute();
    res.json({
      items: rows.map((r) => ({
        seriesId: r.id,
        title: r.title,
        clubName: r.club_name,
        clubColor: r.club_color,
        organizerName: r.organizer_name,
        submittedAt: r.submitted_at?.toISOString() ?? null,
        version: r.version,
        hasRoom: r.room_id !== null,
        isRecurring: r.recurrence_weekdays !== null,
        isResubmission: r.reviewed_at !== null,
        firstOccurrenceId: r.first_occurrence_id,
        firstStartsAt: r.first_starts_at ? new Date(r.first_starts_at as unknown as string).toISOString() : null,
      })),
    });
  });

  return r;
}
