/**
 * Polling realtime endpoint for backtest_dashboard_state. Returns the
 * singleton row only if (a) updated_at is newer than the caller's cursor
 * AND (b) the writer's client_id differs from the caller's (echo-suppress).
 *
 * Mirrors the Supabase Realtime channel's filter logic so cross-tab sync
 * doesn't loop a write back into its own state.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { dashboardStateRepo } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") return NextResponse.json(null);
  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId") ?? "";
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  const row = dashboardStateRepo.loadWithMeta();
  if (!row) return NextResponse.json(null);
  if (row.updated_at <= since) return NextResponse.json(null);
  if (clientId && row.client_id === clientId) return NextResponse.json(null);
  return NextResponse.json({ state: row.state, updated_at: row.updated_at });
}
