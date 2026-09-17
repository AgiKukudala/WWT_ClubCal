import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import { config } from "../config.js";
import type { DB } from "./types.js";

// DATE -> 'YYYY-MM-DD' string (never a JS Date shifted by the server's zone).
pg.types.setTypeParser(1082, (v) => v);
// BIGINT stays a string to avoid precision loss; callers convert where safe.
pg.types.setTypeParser(20, (v) => v);

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
export type DbOrTx = Db | Tx;

export function createPool(connectionString = config.DATABASE_URL, max = 10) {
  const pool = new pg.Pool({ connectionString, max });
  pool.on("error", (err) => {
    // Idle client errors (e.g. DB restart) must not crash the process.
    process.stderr.write(`pg pool error: ${err.message}\n`);
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
