/**
 * Local-mode migration runner.
 *
 * Numbered migration files (0001_init, 0002_..., …) are applied in order.
 * Each migration's version number is recorded in the _migrations table so
 * subsequent runs skip already-applied migrations. New schema changes ship
 * as a new file with an incremented version — never edit a past migration.
 *
 * Migrations are wrapped in a single transaction each so a failure leaves
 * the DB at the last good version. SQLite supports DDL inside transactions,
 * so even multi-CREATE migrations are atomic.
 */

import type { Database } from "better-sqlite3";
import { migration0001 } from "./0001_init";
import { migration0002 } from "./0002_data_request_recovery";
import { migration0003 } from "./0003_preset_pipeline_bucket";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
];

export function runMigrations(db: Database): void {
  // Bootstrap the migrations registry table itself.
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  );

  const applied = new Set<number>(
    db
      .prepare<[], { version: number }>("SELECT version FROM _migrations")
      .all()
      .map((r) => r.version)
  );

  const recordStmt = db.prepare(
    "INSERT INTO _migrations(version, applied_at) VALUES(?, ?)"
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      recordStmt.run(m.version, new Date().toISOString());
    });
    tx();
  }
}
