/**
 * Type definitions for the Live Trading platform.
 *
 * Maps to Supabase tables: live_bars, live_ticker, order_requests, live_state.
 * NT8 LiveBridge AddOn streams data to these tables; web subscribes via Realtime.
 */

// ─── Streaming Market Data ──────────────────────────────────────────────────

/** Single OHLCV bar streamed from NT8 */
export interface LiveBar {
  id: number;
  instrument: string;
  timeframe: string;
  bar_time: string;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
  created_at: string;
}

/** Last price tick for an instrument (single-row UPSERT) */
export interface LiveTicker {
  instrument: string;
  last_price: number;
  bid: number | null;
  ask: number | null;
  updated_at: string;
}

// ─── Order Management ───────────────────────────────────────────────────────

/** Available account published by NT8 */
export interface LiveAccount {
  account_name: string;
  updated_at: string;
}

/** Order request from web → NT8 */
export interface OrderRequest {
  id: number;
  instrument: string;
  account: string | null;
  action: "buy_long" | "sell_short" | "close" | "cancel_all" | "modify_sl";
  sl_points: number | null;
  tp_points: number | null;
  trail_enabled: boolean;
  quantity: number | null;
  new_sl_price: number | null;
  status: "pending" | "processing" | "filled" | "rejected" | "error";
  error_message: string | null;
  fill_price: number | null;
  created_at: string;
  updated_at: string;
}

// ─── Position State ─────────────────────────────────────────────────────────

// ─── Trade Timer ────────────────────────────────────────────────────────────

/**
 * User-configurable settings for the post-entry trade timer.
 *
 * The trade timer enforces a minimum time-in-trade discipline window:
 * once a trade is placed, a countdown begins. Optionally the timer can
 * force-close the trade at zero, and/or block any new entries until the
 * countdown expires (even if the trade was closed early). Stored in
 * localStorage under "liveTrader.tradeTimer".
 */
export interface TradeTimerSettings {
  /** Master switch — when false the timer is fully bypassed. */
  enabled: boolean;
  /** Countdown length in seconds (default 300 = 5 minutes). */
  durationSec: number;
  /** When true, an open position is auto-closed at 0. */
  autoCloseOnZero: boolean;
  /** When true, new entries are blocked until the countdown reaches 0,
   *  even if the trade was closed early. This is the anti-revenge-trade lock. */
  lockoutUntilZero: boolean;
}

/** A single SL/TP bracket pair from an entry or add-to-position fill */
export interface Bracket {
  entry_price: number;
  sl_price: number | null;
  tp_price: number | null;
  qty: number;
}

/** Current position + working orders for an instrument + account */
export interface LiveState {
  instrument: string;
  account: string;
  position_direction: "Long" | "Short" | null;
  position_quantity: number;
  position_entry_price: number;
  unrealized_pnl: number;
  /** Primary SL/TP (first bracket) — backward compat */
  sl_price: number | null;
  tp_price: number | null;
  trail_enabled: boolean;
  /** Quantity of the first entry — used by "Add" to replicate lot size */
  original_entry_qty?: number;
  /** All active bracket pairs (original + adds) */
  brackets?: Bracket[];
  updated_at: string;
}
