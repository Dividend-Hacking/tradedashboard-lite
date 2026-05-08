/**
 * Polling realtime endpoint for live_ticker. Returns the ticker row only
 * if its updated_at strictly exceeds the caller's cursor. Local mode only.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { liveRepo } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") return NextResponse.json(null);
  const url = new URL(req.url);
  const instrument = url.searchParams.get("instrument") ?? "";
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  if (!instrument) return NextResponse.json(null);
  const row = liveRepo.getTicker(instrument);
  if (!row || row.updated_at <= since) return NextResponse.json(null);
  return NextResponse.json(row);
}
