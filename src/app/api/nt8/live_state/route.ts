/**
 * NT8 ingest: live_state. LiveBridge upserts the position snapshot per
 * (instrument, account) on every fill / state change.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "live_state",
  writableColumns: [
    "instrument",
    "account",
    "position_direction",
    "position_quantity",
    "position_entry_price",
    "unrealized_pnl",
    "sl_price",
    "tp_price",
    "trail_enabled",
    "updated_at",
  ],
  boolColumns: ["trail_enabled"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
