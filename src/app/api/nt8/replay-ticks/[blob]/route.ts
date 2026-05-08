/**
 * NT8 ingest: tick blob upload. DataExporter POSTs the gzipped CSV body
 * directly (Content-Type: application/gzip). Local mode writes it to
 * ~/.tradedashboard/data/ticks/<blob>.
 *
 * Mirrors Supabase Storage's PUT /storage/v1/object/<bucket>/<path>
 * shape closely enough that the AddOn can switch by URL only.
 */

import fs from "node:fs";
import { NextResponse } from "next/server";
import { readMode } from "@/lib/mode";
import { tickBlobPathFor, tickBlobDir } from "@/lib/local/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ blob: string }> }
) {
  const { mode } = await readMode();
  if (mode !== "local") {
    return NextResponse.json(
      { error: "Local-mode endpoint not available in cloud mode" },
      { status: 503 }
    );
  }
  const { blob } = await params;
  // Defense in depth: don't allow path traversal in the blob name.
  if (blob.includes("/") || blob.includes("..")) {
    return NextResponse.json({ error: "Invalid blob name" }, { status: 400 });
  }

  // Ensure the destination directory exists; first run on a fresh DB
  // hasn't called getDb() yet so the dir bootstrap may not have run.
  fs.mkdirSync(tickBlobDir(), { recursive: true });

  const arrayBuf = await req.arrayBuffer();
  const target = tickBlobPathFor(blob);
  fs.writeFileSync(target, Buffer.from(arrayBuf));
  return NextResponse.json({ Key: blob, size: arrayBuf.byteLength });
}

/** PUT mirrors POST so AddOns that follow the Storage convention work. */
export const PUT = POST;
