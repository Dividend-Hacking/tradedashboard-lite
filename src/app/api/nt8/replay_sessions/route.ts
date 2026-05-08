/**
 * NT8 ingest: replay_sessions. DataExporter POSTs the session metadata
 * once per export and PATCHes tick_blob_path / tick_count after the
 * tick blob upload completes.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "replay_sessions",
  writableColumns: [
    "instrument",
    "timeframe",
    "session_date",
    "start_time",
    "end_time",
    "bar_count",
    "granularity",
    "tick_blob_path",
    "tick_count",
    "last_bar_index",
    "notes",
  ],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
