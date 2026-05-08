/**
 * Polling realtime endpoint for the global trades feed (Dashboard).
 * Returns trades whose entry_time strictly exceeds the caller's cursor.
 *
 * Limitations: cannot detect DELETE — local mode users see deleted rows
 * disappear via the Dashboard's optimistic-update path, not via this
 * polling stream. INSERTs and field UPDATES are picked up because both
 * change the entry_time/created_at fields the cursor advances on.
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
      "SELECT * FROM trades WHERE created_at > ? OR entry_time > ? ORDER BY entry_time ASC LIMIT 500"
    )
    .all(since, since);
  return NextResponse.json(rows);
}
