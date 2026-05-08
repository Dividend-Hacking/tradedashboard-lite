/**
 * Server-side URL signer for tick blobs. The HMAC key lives only on the
 * server (per-process random nonce), so the browser-side store calls this
 * route to mint a short-lived URL it can hand to the chart.
 *
 * Local mode only.
 */

import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { signTickBlobPath } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { mode } = await readMode();
  if (mode !== "local") {
    return NextResponse.json({ error: "Not in local mode" }, { status: 503 });
  }
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const expires = Number(url.searchParams.get("expires") ?? "3600");
  if (!path) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }
  const token = signTickBlobPath(path, expires);
  return NextResponse.json({
    url: `/api/local/replay-ticks/${encodeURIComponent(path)}?t=${token}`,
  });
}
