import type { DbOrTx } from "../db/index.js";

/** Writes an audit record. Always call with the same transaction as the change it describes. */
export async function audit(
  db: DbOrTx,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insertInto("audit_log")
    .values({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, details: JSON.stringify(details) })
    .execute();
}

/** Field-level diff for audit details; only includes keys whose values changed. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = normalise(before[key]);
    const b = normalise(after[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = { from: a, to: b };
  }
  return out;
}

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  return v;
}
