/**
 * API route for saving replay progress via navigator.sendBeacon().
 * Used on tab close (beforeunload) since server actions can't be
 * called from synchronous beforeunload handlers.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const { sessionId, lastBarIndex } = await req.json();

  if (typeof sessionId !== "number" || typeof lastBarIndex !== "number") {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("replay_sessions")
    .update({ last_bar_index: lastBarIndex })
    .eq("id", sessionId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
