/**
 * Internal local-mode JSON-RPC endpoint.
 *
 * One route that dispatches to any of the local SQLite repos. Exists so
 * the browser-side local-client store can talk to better-sqlite3 without
 * 30 separate route files. Per-table routes would be more RESTful but
 * also massively more boilerplate for a single-user, single-machine
 * private data plane.
 *
 * Request body: { repo: string, method: string, args: unknown[] }
 * Response: { ok: true, result: <serialized return> } | { ok: false, error: string }
 *
 * Map<number, X[]> returns get serialized as { __map: true, entries: [...] }
 * so they round-trip through JSON without lossiness.
 *
 * Security: this route MUST be local-mode only — flips off when mode=cloud.
 * Even so, treat it as untrusted: this is a private dev-server endpoint
 * but the dev script binds 0.0.0.0 so the Parallels VM can reach the
 * NT8 ingest routes, meaning anyone on the same LAN could hit /api/local
 * too. That's the same trust model as Supabase's anon key in cloud mode
 * — single-user, no real auth — and the mode-gate keeps cloud-mode users
 * from accidentally exposing the SQLite DB.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import {
  tradesRepo,
  replayRepo,
  practiceRepo,
  zonesRepo,
  liveRepo,
  orderRequestsRepo,
  traderPrefsRepo,
  presetsRepo,
  dashboardStateRepo,
  livebridgeEndpointRepo,
} from "@/lib/local/repos";

// better-sqlite3 is a native module — must run on the Node runtime.
export const runtime = "nodejs";
// Always evaluate live; never cache. Repo state changes on every write.
export const dynamic = "force-dynamic";

const REPOS: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
  trades: tradesRepo as Record<string, (...args: unknown[]) => unknown>,
  replay: replayRepo as Record<string, (...args: unknown[]) => unknown>,
  practice: practiceRepo as Record<string, (...args: unknown[]) => unknown>,
  zones: zonesRepo as Record<string, (...args: unknown[]) => unknown>,
  live: liveRepo as Record<string, (...args: unknown[]) => unknown>,
  orderRequests: orderRequestsRepo as Record<string, (...args: unknown[]) => unknown>,
  traderPrefs: traderPrefsRepo as Record<string, (...args: unknown[]) => unknown>,
  presets: presetsRepo as Record<string, (...args: unknown[]) => unknown>,
  dashboardState: dashboardStateRepo as Record<string, (...args: unknown[]) => unknown>,
  livebridgeEndpoint: livebridgeEndpointRepo as Record<string, (...args: unknown[]) => unknown>,
};

/** Serialize values that JSON.stringify would lose: Maps, Buffers, etc. */
function serialize(value: unknown): unknown {
  if (value instanceof Map) {
    return {
      __map: true,
      entries: Array.from(value.entries()).map(([k, v]) => [k, serialize(v)]),
    };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    // Pass through plain objects unchanged — they JSON-stringify fine.
    return value;
  }
  return value;
}

export async function POST(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") {
    return NextResponse.json(
      { ok: false, error: "Local-mode endpoint not available in cloud mode" },
      { status: 503 }
    );
  }

  let body: { repo?: string; method?: string; args?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const repoName = body.repo ?? "";
  const methodName = body.method ?? "";
  const args = Array.isArray(body.args) ? body.args : [];

  const repo = REPOS[repoName];
  if (!repo) {
    return NextResponse.json(
      { ok: false, error: `Unknown repo: ${repoName}` },
      { status: 400 }
    );
  }
  const fn = repo[methodName];
  if (typeof fn !== "function") {
    return NextResponse.json(
      { ok: false, error: `Unknown method: ${repoName}.${methodName}` },
      { status: 400 }
    );
  }

  try {
    const result = fn(...args);
    return NextResponse.json({ ok: true, result: serialize(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
