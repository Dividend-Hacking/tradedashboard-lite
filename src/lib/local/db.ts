/**
 * Local DB — better-sqlite3 connection singleton.
 *
 * Backs the trading + practice + backtesting tables when the app runs in
 * Local Mode. The DB file lives at ~/.tradedashboard/local.db; tick blobs
 * (gzipped CSV exports from NT8) live in ~/.tradedashboard/data/ticks/.
 *
 * One connection per Node process. Cached on globalThis so Next.js dev-mode
 * HMR doesn't open a new handle on every reload (the previous handle would
 * leak file descriptors). The first call to getDb() creates the directory
 * tree, opens the DB with WAL + foreign-key enforcement, and runs any
 * pending migrations.
 *
 * Server-side only — better-sqlite3 is a native module and cannot run in
 * the edge runtime. Every route file that imports from here must export
 * `runtime = "nodejs"`.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMigrations } from "./migrations";

/** Root directory for all local-mode persistence. */
export function localRoot(): string {
  return path.join(os.homedir(), ".tradedashboard");
}

/** Absolute path to the SQLite DB file. */
export function dbPath(): string {
  return path.join(localRoot(), "local.db");
}

/** Absolute path to the tick blob storage directory. */
export function tickBlobDir(): string {
  return path.join(localRoot(), "data", "ticks");
}

/** Build the absolute tick-blob path for a given session id. The relative
 *  filename portion (e.g. "session-42.csv.gz") is what gets stored in
 *  replay_sessions.tick_blob_path so the same column works in both modes. */
export function tickBlobPathFor(blobName: string): string {
  return path.join(tickBlobDir(), blobName);
}

function ensureDirs(): void {
  fs.mkdirSync(localRoot(), { recursive: true });
  fs.mkdirSync(tickBlobDir(), { recursive: true });
}

// Cache the connection on globalThis so dev-mode HMR reloads reuse it
// instead of leaking handles. In production this still works correctly
// because globalThis is a single-process scope.
type GlobalWithDb = typeof globalThis & { __tradeDashDb?: Database.Database };
const g = globalThis as GlobalWithDb;

/**
 * Get the DB connection. Lazy: opens the file, enables WAL + FK, and runs
 * migrations on first call. Subsequent calls in the same process return
 * the cached handle.
 *
 * Migrations also run on a cached-handle hit when a higher migration
 * version has been added to the registry since the last run — without
 * this, dev-mode HMR (which preserves the globalThis cache across module
 * reloads) would silently skip newly-added migrations until the user
 * restarted the Node process. The check is one cheap SELECT against
 * _migrations and short-circuits when there's nothing new.
 */
export function getDb(): Database.Database {
  if (g.__tradeDashDb) {
    runMigrations(g.__tradeDashDb);
    return g.__tradeDashDb;
  }

  ensureDirs();
  const db = new Database(dbPath());

  // WAL: concurrent readers don't block the writer (NT8 polling + web
  // app rendering hit this DB simultaneously).
  db.pragma("journal_mode = WAL");
  // Enforce foreign keys — Postgres did, so SQLite should too.
  db.pragma("foreign_keys = ON");
  // NORMAL is the standard WAL pairing — durable across crashes, faster
  // than FULL because fsync is deferred to checkpoint time.
  db.pragma("synchronous = NORMAL");

  runMigrations(db);

  g.__tradeDashDb = db;
  return db;
}
