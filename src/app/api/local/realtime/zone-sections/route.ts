/**
 * Polling realtime endpoint for zone_sections changes.
 *
 * Sections are tiny (usually <20 rows) and rarely changed, so we always
 * return the full list. The client diffs against its current state. The
 * `since` parameter is accepted for symmetry with the other realtime
 * endpoints but ignored — sending the whole list is simpler and the
 * payload is trivial.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { getDb } from "@/lib/local/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") return NextResponse.json([]);
  const rows = getDb()
    .prepare("SELECT * FROM zone_sections ORDER BY name ASC")
    .all();
  return NextResponse.json(rows);
}
