/**
 * NT8 ingest: trade_zone_bars. TradeZoneWriter POSTs all bars in one
 * array for each saved zone (with the resolved zone_id FK).
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "trade_zone_bars",
  writableColumns: [
    "zone_id",
    "bar_time",
    "bar_open",
    "bar_high",
    "bar_low",
    "bar_close",
    "bar_volume",
    "bar_index",
    "mfe_from_start",
    "mae_from_start",
    "drawdown_from_entry",
    "runup_from_entry",
    "close_vs_entry",
    "high_since_entry",
    "retrace_from_peak",
  ],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
