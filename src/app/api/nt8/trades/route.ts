/**
 * NT8 ingest: trades. SupabaseWriter (in TradeTracker) POSTs a row when
 * a trade closes, GETs by composite key (entry_time + exit_time +
 * instrument + account_name) to resolve the id, and PATCHes for
 * post-exit MFE/MAE updates.
 */

import { makeTableHandlers } from "@/lib/local/nt8-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = makeTableHandlers({
  table: "trades",
  writableColumns: [
    "entry_time",
    "exit_time",
    "real_entry_time",
    "real_exit_time",
    "instrument",
    "direction",
    "entry_price",
    "exit_price",
    "stop_loss_price",
    "take_profit_price",
    "quantity",
    "pnl_points",
    "pnl_dollars",
    "strategy_signal_name",
    "account_name",
    "initial_stop_distance",
    "actual_rr",
    "setup_rr",
    "mfe_points",
    "mae_points",
    "mfe_r_multiple",
    "mae_r_multiple",
    "post_exit_mfe_points",
    "post_exit_mfe_r",
    "post_exit_mae_points",
    "ctx_atr14",
    "ctx_atr14_15s",
    "ctx_price_vs_ema20",
    "ctx_dist_ema20_atr",
    "ctx_price_vs_ema200",
    "ctx_dist_ema200_atr",
    "ctx_bollinger_pos",
    "ctx_bollinger_bw",
    "ctx_market_regime",
    "ctx_adx14",
    "risk_units",
    "atr_multiplier",
    "rr_multiplier",
    "sl_mode",
    "custom_tags",
    "notes",
    "trade_grade",
    "trade_mistake",
    "trade_regime",
    "trade_status",
  ],
  jsonColumns: ["custom_tags"],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
