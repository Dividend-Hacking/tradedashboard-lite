/**
 * Polling realtime endpoint for live_bars. Returns rows with bar_time
 * strictly greater than ?since= (cursor advances on the client).
 *
 * Local mode only. The cloud-mode equivalent uses Supabase Realtime
 * postgres_changes channels.
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
  const timeframe = url.searchParams.get("timeframe") ?? "";
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  if (!instrument || !timeframe) return NextResponse.json([]);
  const rows = liveRepo.listBarsForInstrumentSince(instrument, timeframe, since);
  return NextResponse.json(rows);
}
