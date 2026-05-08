/**
 * Polling realtime endpoint for data_requests changes.
 * Returns rows with updated_at strictly > cursor so the
 * "pending → processing → completed" lifecycle propagates.
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
      "SELECT * FROM data_requests WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 500"
    )
    .all(since);
  return NextResponse.json(rows);
}
