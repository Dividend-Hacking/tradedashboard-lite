/**
 * Polling realtime endpoint for trade_zones changes.
 * Returns zones with created_at strictly > cursor.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { getDb } from "@/lib/local/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") return NextResponse.json([]);
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  const rows = getDb()
    .prepare(
      "SELECT * FROM trade_zones WHERE created_at > ? ORDER BY created_at ASC LIMIT 500"
    )
    .all(since);
  return NextResponse.json(rows);
}
