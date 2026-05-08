/**
 * NT8 ingest: trade_bars. SupabaseWriter POSTs ~25 pre-entry through
 * exit bars per closed trade, with the resolved trade_id FK.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "trade_bars",
  writableColumns: [
    "trade_id",
    "bar_index",
    "bar_time",
    "bar_open",
    "bar_high",
    "bar_low",
    "bar_close",
    "bar_volume",
    "is_entry_bar",
    "is_exit_bar",
  ],
  boolColumns: ["is_entry_bar", "is_exit_bar"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
