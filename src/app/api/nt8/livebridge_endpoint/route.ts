/**
 * NT8 ingest: livebridge_endpoint. LiveBridge POSTs the discovered host
 * + port on every successful WebSocket bind so the web client can find
 * it later without a fresh discovery sweep.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "livebridge_endpoint",
  writableColumns: ["id", "candidates", "port"],
  jsonColumns: ["candidates"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
