/**
 * NT8 ingest: live_accounts. LiveBridge POSTs the list of NT8 accounts
 * on demand (when the web app inserts a "publish_accounts" command).
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "live_accounts",
  writableColumns: ["account_name"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
