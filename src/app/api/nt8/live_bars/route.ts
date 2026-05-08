/**
 * NT8 ingest: live_bars. LiveBridge streams the active bar to this
 * endpoint as it forms and finalizes.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "live_bars",
  writableColumns: [
    "instrument",
    "timeframe",
    "bar_time",
    "bar_open",
    "bar_high",
    "bar_low",
    "bar_close",
    "bar_volume",
  ],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
