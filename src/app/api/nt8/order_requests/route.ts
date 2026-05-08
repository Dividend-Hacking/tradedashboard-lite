/**
 * NT8 ingest: order_requests. LiveBridge GETs `status=eq.pending` and
 * PATCHes status / fill_price / error_message after executing the order.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "order_requests",
  writableColumns: [
    "instrument",
    "account",
    "action",
    "sl_points",
    "tp_points",
    "trail_enabled",
    "quantity",
    "new_sl_price",
    "new_tp_price",
    "status",
    "error_message",
    "fill_price",
  ],
  boolColumns: ["trail_enabled"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
