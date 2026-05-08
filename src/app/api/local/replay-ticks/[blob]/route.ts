/**
 * Tick blob streamer. Verifies the HMAC token in the query string, then
 * serves the gzipped CSV from ~/.tradedashboard/data/ticks/.
 *
 * Token format and verification live in src/lib/local/repos.ts so the
 * signing/verification pair always agree on the HMAC key.
 *
 * 404 on missing files; 403 on bad/expired token. The Tick Viewer treats
 * both as a "blob unavailable" state and shows a fallback message.
 */

import fs from "node:fs";
import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { tickBlobPathFor } from "@/lib/local/db";
import { verifyTickBlobToken } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ blob: string }> }
) {
  const { mode } = await readMode();
  if (mode !== "local") {
    return NextResponse.json({ error: "Not in local mode" }, { status: 503 });
  }
  const { blob } = await params;
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";

  if (!verifyTickBlobToken(blob, token)) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 403 });
  }

  const filePath = tickBlobPathFor(blob);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Blob not found" }, { status: 404 });
  }

  const body = fs.readFileSync(filePath);
  return new Response(body, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(body.length),
      "cache-control": "private, max-age=60",
    },
  });
}
