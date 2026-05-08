/**
 * NT8 ingest: data_requests. DataExporter polls this table every 15s
 * looking for `status=eq.pending` rows and PATCHes them to processing
 * → completed/error as it works through them.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";
import { replayRepo } from "@/lib/local/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "data_requests",
  writableColumns: [
    "instrument",
    "timeframe",
    "session_date",
    "granularity",
    "status",
    "error_message",
    "replay_session_id",
    // Set by NT8's ClaimRows on transition into 'processing' and nulled
    // on terminal status. Sweeper compares against now-10min to detect
    // crashed runs.
    "claimed_at",
    // Sweeper writes retry_count internally; NT8 doesn't normally PATCH
    // it, but allowing it here lets us back-out via curl during testing.
    "retry_count",
    // Heartbeat PATCHes bump updated_at while a long batch is mid-flight
    // so the staleness clock can tell live-but-slow from dead.
    "updated_at",
  ],
  // NT8 polls this endpoint every ~5s. Use that natural rhythm to drive
  // the recovery loop — no separate setInterval needed in the Next server.
  beforeGet: () => {
    replayRepo.recoverStaleRequests();
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
