import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  // src/db -> ../../migrations ; dist -> ../migrations
  return process.env.MIGRATIONS_DIR ?? path.resolve(here, here.includes(`${path.sep}src${path.sep}`) ? "../../migrations" : "../migrations");
}

/**
 * Applies pending *.sql migrations in lexical order. Each file runs in its own
 * transaction; an advisory lock serialises concurrent runners (e.g. two containers).
 * Already-applied files are verified by checksum so edited history is detected.
 */
export async function migrate(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727274001)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const dir = migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlText = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sqlText).digest("hex");
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274001)").catch(() => {});
    client.release();
  }
  return applied;
}
