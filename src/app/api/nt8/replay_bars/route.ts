/**
 * NT8 ingest: replay_bars. DataExporter POSTs an array of bars (often
 * 1k-25k per session) after fetching them from NinjaTrader's BarsRequest.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "replay_bars",
  writableColumns: [
    "session_id",
    "bar_index",
    "bar_time",
    "bar_open",
    "bar_high",
    "bar_low",
    "bar_close",
    "bar_volume",
    "bar_volume_bid",
    "bar_volume_ask",
  ],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
