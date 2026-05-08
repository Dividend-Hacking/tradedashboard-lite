/**
 * NT8 ingest: live_commands. LiveBridge GETs `status=eq.pending` and
 * PATCHes status to "processed" after handling each command.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "live_commands",
  writableColumns: ["command", "status"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
