/**
 * NT8 ingest: live_ticker. LiveBridge upserts last_price / bid / ask
 * on every print.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "live_ticker",
  writableColumns: ["instrument", "last_price", "bid", "ask"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
