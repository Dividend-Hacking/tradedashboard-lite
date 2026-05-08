/**
 * Generic table handler for NT8 ingest routes.
 *
 * NT8 AddOns talk PostgREST: GET with filters/order/limit, POST with a
 * JSON object or array, PATCH with filters in the URL and a JSON body.
 * In local mode every /api/nt8/<table> route uses this handler — the
 * route file just supplies the table name and column allow-list.
 *
 * Behavioral notes:
 *   - GET returns rows as JSON. Returns 200 + [] when no matches (no 404).
 *   - POST with `Prefer: return=representation` returns the inserted rows;
 *     otherwise returns the row count.
 *   - PATCH applies the body fields to all rows matching the URL filters.
 *   - We allow-list columns to prevent accidental writes to autogen
 *     columns (id, created_at) or columns NT8 shouldn't touch.
 *   - Always re-checks mode on every request — flips back to cloud mid-
 *     session should immediately stop accepting writes here.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/local/db";
import { writeJson, writeBool } from "@/lib/local/json";
import {
  parsePostgRESTQuery,
  compileWhere,
  compileOrderLimit,
} from "@/lib/local/postgrest-shim";
import { readMode } from "@/lib/mode";

export interface TableHandlerConfig {
  /** SQLite table name. */
  table: string;
  /** Columns NT8 may insert/update. Anything else in the body is dropped. */
  writableColumns: readonly string[];
  /** Columns whose JS value should be JSON.stringified before binding
   *  (jsonb columns). */
  jsonColumns?: readonly string[];
  /** Columns whose JS boolean should be coerced to 0/1. */
  boolColumns?: readonly string[];
  /** Optional callback fired after a successful POST insert — used for
   *  side effects (e.g. patching a related row). Receives the inserted
   *  row(s); return value ignored. */
  afterInsert?: (rows: Record<string, unknown>[]) => void;
  /** Optional callback fired before each GET, before the SELECT runs.
   *  Used by data_requests to sweep stuck/errored rows back to pending so
   *  NT8's poll itself drives the recovery loop — no separate timer infra. */
  beforeGet?: () => void;
}

function maybeMode503(): NextResponse | null {
  // Sync wrapper called from the async handlers below.
  return null;
}

export function makeTableHandlers(cfg: TableHandlerConfig) {
  return {
    async GET(req: Request) {
      const { mode } = await readMode();
      if (mode !== "local") {
        return NextResponse.json(
          { error: "Local-mode endpoint not available in cloud mode" },
          { status: 503 }
        );
      }
      try {
        // Run any pre-GET side effect (e.g. data_requests sweeper). Failures
        // here are non-fatal — log and serve the SELECT anyway, since a
        // hot-loop recovery bug shouldn't take NT8's poll loop down.
        if (cfg.beforeGet) {
          try {
            cfg.beforeGet();
          } catch (err) {
            console.warn(
              `[nt8-table:${cfg.table}] beforeGet hook threw — ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
        const url = new URL(req.url);
        const q = parsePostgRESTQuery(url.searchParams);
        const where = compileWhere(q.filters);
        const sql = `SELECT * FROM "${cfg.table}"${where.sql}${compileOrderLimit(q)}`;
        const rows = getDb().prepare(sql).all(...where.params);
        return NextResponse.json(rows);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 }
        );
      }
    },

    async POST(req: Request) {
      const { mode } = await readMode();
      if (mode !== "local") {
        return NextResponse.json(
          { error: "Local-mode endpoint not available in cloud mode" },
          { status: 503 }
        );
      }
      try {
        const body = await req.json();
        const arr = Array.isArray(body) ? body : [body];
        if (arr.length === 0) return NextResponse.json([]);

        const prefer = req.headers.get("prefer") ?? "";
        const wantsRepresentation = prefer.includes("return=representation");

        // Compute the union of writable columns actually present in the
        // input. NT8 sometimes omits optional columns; we only INSERT
        // what's present so SQLite defaults take over.
        const writable = new Set(cfg.writableColumns);
        const columnsPresent = new Set<string>();
        for (const row of arr) {
          for (const k of Object.keys(row as Record<string, unknown>)) {
            if (writable.has(k)) columnsPresent.add(k);
          }
        }
        const cols = Array.from(columnsPresent);
        if (cols.length === 0) {
          return NextResponse.json(
            { error: "No writable columns in request body" },
            { status: 400 }
          );
        }

        const placeholders = cols.map(() => "?").join(", ");
        const colsList = cols.map((c) => `"${c}"`).join(", ");
        const sql = `INSERT INTO "${cfg.table}" (${colsList}) VALUES (${placeholders}) RETURNING *`;

        const db = getDb();
        const stmt = db.prepare(sql);
        const inserted: Record<string, unknown>[] = [];
        const tx = db.transaction((rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            const params: unknown[] = cols.map((c) => {
              const raw = row[c];
              if (cfg.jsonColumns?.includes(c)) return writeJson(raw);
              if (cfg.boolColumns?.includes(c)) return writeBool(raw);
              return raw === undefined ? null : raw;
            });
            const out = stmt.get(...params) as Record<string, unknown>;
            inserted.push(out);
          }
        });
        tx(arr);

        if (cfg.afterInsert) cfg.afterInsert(inserted);

        if (wantsRepresentation) {
          return NextResponse.json(inserted);
        }
        return NextResponse.json({ count: inserted.length });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 }
        );
      }
    },

    async PATCH(req: Request) {
      const { mode } = await readMode();
      if (mode !== "local") {
        return NextResponse.json(
          { error: "Local-mode endpoint not available in cloud mode" },
          { status: 503 }
        );
      }
      try {
        const url = new URL(req.url);
        const q = parsePostgRESTQuery(url.searchParams);
        const where = compileWhere(q.filters);
        if (!where.sql) {
          // Refuse unfiltered UPDATE — this almost always means a bug.
          return NextResponse.json(
            { error: "PATCH requires at least one filter" },
            { status: 400 }
          );
        }
        const body = (await req.json()) as Record<string, unknown>;
        const writable = new Set(cfg.writableColumns);
        const sets: string[] = [];
        const setParams: unknown[] = [];
        for (const [k, v] of Object.entries(body)) {
          if (!writable.has(k)) continue;
          sets.push(`"${k}" = ?`);
          if (cfg.jsonColumns?.includes(k)) setParams.push(writeJson(v));
          else if (cfg.boolColumns?.includes(k)) setParams.push(writeBool(v));
          else setParams.push(v === undefined ? null : v);
        }
        if (sets.length === 0) {
          return NextResponse.json(
            { error: "No writable columns in PATCH body" },
            { status: 400 }
          );
        }
        const sql = `UPDATE "${cfg.table}" SET ${sets.join(", ")}${where.sql}`;
        const info = getDb()
          .prepare(sql)
          .run(...setParams, ...where.params);
        return NextResponse.json({ count: info.changes });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 }
        );
      }
    },

    async DELETE(req: Request) {
      const { mode } = await readMode();
      if (mode !== "local") {
        return NextResponse.json(
          { error: "Local-mode endpoint not available in cloud mode" },
          { status: 503 }
        );
      }
      try {
        const url = new URL(req.url);
        const q = parsePostgRESTQuery(url.searchParams);
        const where = compileWhere(q.filters);
        if (!where.sql) {
          return NextResponse.json(
            { error: "DELETE requires at least one filter" },
            { status: 400 }
          );
        }
        const sql = `DELETE FROM "${cfg.table}"${where.sql}`;
        const info = getDb().prepare(sql).run(...where.params);
        return NextResponse.json({ count: info.changes });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 }
        );
      }
    },
  };
}

/** Tiny no-op so eslint doesn't flag the (unused) helper above. */
void maybeMode503;
