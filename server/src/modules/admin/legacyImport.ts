import { createHash } from "node:crypto";
import { type LegacyPreviewDTO, type LegacyPreviewRow, minutesBetween, parseLegacyEvents } from "@clubcal/shared";
import { type Actor, isAdmin } from "../../auth/context.js";
import type { Db, DbOrTx } from "../../db/index.js";
import { audit } from "../../lib/audit.js";
import { badRequest, conflict, forbidden } from "../../lib/errors.js";
import { resolveLocal } from "../../lib/time.js";

export interface ImportRequest {
  clubId: string;
  timezone: string;
  category: string;
  visibility: "public" | "club";
  json: string;
}

function fileHash(json: string): string {
  // Hash the canonical JSON so whitespace differences do not defeat duplicate detection.
  return createHash("sha256").update(JSON.stringify(JSON.parse(json))).digest("hex");
}

const fingerprint = (clubId: string, r: { date: string | null; startTime: string | null; endTime: string | null; title: string }) =>
  createHash("sha256").update([clubId, r.date, r.startTime, r.endTime, r.title.trim().toLowerCase()].join("|")).digest("hex");

async function analyse(db: DbOrTx, req: ImportRequest) {
  const { rows, fatal } = parseLegacyEvents(req.json);
  if (fatal) throw badRequest(fatal, { json: [fatal] });
  const club = await db.selectFrom("clubs").select("id").where("id", "=", req.clubId).where("archived_at", "is", null).executeTakeFirst();
  if (!club) throw badRequest("Unknown club", { clubId: ["Unknown club"] });
  const sha = fileHash(req.json);
  const prior = await db.selectFrom("legacy_imports").select("id").where("file_sha256", "=", sha).executeTakeFirst();
  const prints = rows.map((r) => (r.problem ? null : fingerprint(req.clubId, r)));
  const known = new Set(
    prints.some(Boolean)
      ? (await db.selectFrom("legacy_import_rows").select("fingerprint").where("fingerprint", "in", prints.filter((p): p is string => Boolean(p))).execute()).map((r) => r.fingerprint)
      : [],
  );
  const seen = new Set<string>();
  const out: (LegacyPreviewRow & { fingerprint: string | null })[] = rows.map((r, i) => {
    const fp = prints[i] ?? null;
    let status: LegacyPreviewRow["status"] = r.problem ? "invalid" : "ok";
    let problem = r.problem;
    if (fp && (known.has(fp) || seen.has(fp))) {
      status = "duplicate";
      problem = known.has(fp) ? "Already imported earlier" : "Repeated within this file";
    }
    if (fp) seen.add(fp);
    return { index: r.index, title: r.title, date: r.date, startTime: r.startTime, endTime: r.endTime, status, problem, fingerprint: fp };
  });
  return { sha, alreadyImported: Boolean(prior), rows: out };
}

export async function previewImport(db: Db, actor: Actor, req: ImportRequest): Promise<LegacyPreviewDTO> {
  if (!isAdmin(actor)) throw forbidden();
  const a = await analyse(db, req);
  return {
    fileSha256: a.sha,
    alreadyImported: a.alreadyImported,
    rows: a.rows.map(({ fingerprint: _f, ...r }) => r),
    validCount: a.rows.filter((r) => r.status === "ok").length,
    invalidCount: a.rows.filter((r) => r.status === "invalid").length,
    duplicateCount: a.rows.filter((r) => r.status === "duplicate").length,
  };
}

export async function commitImport(db: Db, actor: Actor, req: ImportRequest, expectedSha: string) {
  if (!isAdmin(actor)) throw forbidden();
  return db.transaction().execute(async (tx) => {
    // Serialise imports so two admins cannot import the same file concurrently.
    await tx.selectFrom("clubs").select("id").where("id", "=", req.clubId).forUpdate().execute();
    const a = await analyse(tx, req);
    if (a.sha !== expectedSha) throw conflict("The file changed since it was previewed. Preview it again.");
    if (a.alreadyImported) throw conflict("This exact file has already been imported.");
    const ok = a.rows.filter((r) => r.status === "ok");
    const imp = await tx
      .insertInto("legacy_imports")
      .values({ imported_by: actor.user.id, club_id: req.clubId, timezone: req.timezone, file_sha256: a.sha, row_count: ok.length })
      .returning("id")
      .executeTakeFirstOrThrow();
    const now = new Date();
    for (const r of ok) {
      const start = resolveLocal(r.date!, r.startTime!, req.timezone);
      const duration = minutesBetween(r.startTime!, r.endTime!);
      const s = await tx
        .insertInto("event_series")
        .values({
          club_id: req.clubId,
          created_by: actor.user.id,
          title: r.title,
          description: "Imported from the original browser-only calendar.",
          category: req.category,
          visibility: req.visibility,
          status: "approved",
          timezone: req.timezone,
          start_date: r.date!,
          local_start_time: r.startTime!,
          duration_minutes: duration,
          reviewed_by: actor.user.id,
          reviewed_at: now,
          submitted_at: now,
          legacy_import_id: imp.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("event_occurrences")
        .values({
          series_id: s.id,
          occurrence_date: r.date!,
          starts_at: start.instant,
          ends_at: new Date(start.instant.getTime() + duration * 60_000),
        })
        .execute();
      await tx.insertInto("legacy_import_rows").values({ fingerprint: r.fingerprint!, import_id: imp.id, series_id: s.id }).execute();
    }
    await audit(tx, actor.user.id, "legacy.imported", "legacy_import", imp.id, {
      clubId: req.clubId,
      timezone: req.timezone,
      imported: ok.length,
      skippedInvalid: a.rows.filter((r) => r.status === "invalid").length,
      skippedDuplicates: a.rows.filter((r) => r.status === "duplicate").length,
    });
    return { importId: imp.id, imported: ok.length };
  });
}
