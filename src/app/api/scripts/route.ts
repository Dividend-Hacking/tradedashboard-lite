/**
 * API route: GET /api/scripts
 *
 * Lists every `.dsl` file under `backtests/scripts/` so the dashboard's
 * script picker can populate its dropdown. Returns each entry's name,
 * size, and mtime — the dashboard sorts by mtime to show "most recent
 * first," and uses size for the optional file-info row in the picker.
 *
 * Like all routes in `/api/scripts`, this is dev-only with no auth — same
 * trust posture as `convert-to-nt8/route.ts`. The dashboard runs locally
 * on the user's machine; anyone who can reach `localhost:3000` is the user.
 */
import { NextResponse } from "next/server";
import { listScripts } from "@/lib/utils/script-file-bridge";

export async function GET() {
  try {
    const scripts = await listScripts();
    return NextResponse.json({ scripts });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
