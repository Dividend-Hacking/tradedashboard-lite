/**
 * Polling realtime endpoint for live_state. Returns all rows for one
 * instrument whose updated_at exceeds the caller's cursor. Local mode only.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { liveRepo } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") return NextResponse.json([]);
  const url = new URL(req.url);
  const instrument = url.searchParams.get("instrument") ?? "";
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  if (!instrument) return NextResponse.json([]);
  const rows = liveRepo
    .listStatesForInstrument(instrument)
    .filter((row) => row.updated_at > since);
  return NextResponse.json(rows);
}
