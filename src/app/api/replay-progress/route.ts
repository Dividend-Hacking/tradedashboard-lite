/**
 * API route for saving replay progress via navigator.sendBeacon().
 * Used on tab close (beforeunload) since server actions can't be
 * called from synchronous beforeunload handlers. Routes to the active
 * backend (Supabase or local SQLite) via the Store layer.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerStore } from "@/lib/store/server";

// Mark Node runtime explicitly so the local-mode path (better-sqlite3)
// can load. Default in App Router is Node, but be explicit so a future
// runtime flip doesn't silently break local mode.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { sessionId, lastBarIndex } = await req.json();

  if (typeof sessionId !== "number" || typeof lastBarIndex !== "number") {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    const store = await getServerStore();
    await store.replay.updateLastBarIndex(sessionId, lastBarIndex);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
