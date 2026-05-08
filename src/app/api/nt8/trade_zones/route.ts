/**
 * NT8 ingest: trade_zones. TradeZoneWriter POSTs zone metadata with
 * Prefer: return=representation so the response carries the new id
 * for the trade_zone_bars insert that follows.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "trade_zones",
  writableColumns: [
    "instrument",
    "direction",
    "start_time",
    "end_time",
    "start_price",
    "end_price",
    "bar_count",
    "points_move",
    "duration_seconds",
    "notes",
    "chart_timeframe",
    "ctx_atr14",
    "ctx_adx14",
    "ctx_ema20",
    "ctx_ema200",
    "ctx_price_vs_ema20",
    "ctx_price_vs_ema200",
    "ctx_dist_ema20_atr",
    "ctx_bollinger_pos",
    "ctx_bollinger_bw",
    "entry_hour",
    "entry_day_of_week",
    "section_id",
    "sl_price",
    "tp_price",
    "hit_outcome",
  ],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
