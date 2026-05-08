/**
 * Polling realtime endpoint for trades. Returns trades whose entry_time
 * strictly exceeds the caller's cursor (local mode only).
 *
 * Note: trades can be created with a backdated entry_time during practice/
 * replay, in which case they may not appear via this since-cursor. That
 * matches the cloud-mode subscription behavior, which fires on row INSERT
 * regardless of entry_time — but the client's polling pattern for trades
 * is "watch for new fills", and live trades have entry_time ≈ now.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { tradesRepo } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") return NextResponse.json([]);
  const url = new URL(req.url);
  const instrument = url.searchParams.get("instrument") ?? "";
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  if (!instrument) return NextResponse.json([]);
  const rows = tradesRepo.listForInstrumentSince(instrument, since);
  return NextResponse.json(rows);
}
