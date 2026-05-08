/**
 * Shared input/patch types for the Store layer.
 *
 * Repo methods take these structured inputs (rather than full row shapes
 * with autogen columns like id/created_at) so callers don't have to think
 * about which columns the backend manages. Output shapes reuse the
 * existing domain types in src/types/* — the Store layer never invents
 * a new "row shape", just adapts the I/O at the boundary.
 */

import type { Granularity } from "@/types/replay";

// ── Trades ───────────────────────────────────────────────────────────────────

/** Tag-only patch produced by the user from the trade detail panel. */
export interface TradeTagsPatch {
  trade_grade?: string | null;
  trade_mistake?: string | null;
  trade_regime?: string | null;
  notes?: string | null;
  custom_tags?: Record<string, unknown> | null;
}

// ── Replay ───────────────────────────────────────────────────────────────────

export interface NewDataRequest {
  instrument: string;
  timeframe: string;
  session_date: string;
  granularity: Granularity;
}

// ── Practice ─────────────────────────────────────────────────────────────────

/** One practice trade row written via savePracticeSession. Mirrors the
 *  practice_trades schema minus the FK and id (handled by the repo). */
export interface PracticeTradeInput {
  direction: string;
  entry_bar_index: number;
  entry_price: number;
  exit_bar_index: number | null;
  exit_price: number | null;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  pnl_points: number | null;
  exit_reason: string | null;
  entry_time: string;
  exit_time: string | null;
}

export interface NewPracticeSession {
  replay_session_id: number;
  total_pnl_points: number;
  win_count: number;
  loss_count: number;
  notes?: string | null;
}

// ── Zones ────────────────────────────────────────────────────────────────────

/** One bar within a saved zone. Mirrors trade_zone_bars columns minus the
 *  FK + id. Numeric fields are required at the boundary because saveZone
 *  always computes them from the bar window. */
export interface ZoneBarInput {
  bar_time: string;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
  bar_index: number;
  mfe_from_start: number;
  mae_from_start: number;
  drawdown_from_entry: number;
  runup_from_entry: number;
  close_vs_entry: number;
  high_since_entry: number;
  retrace_from_peak: number;
}

export interface NewZone {
  instrument: string;
  direction: string;
  start_time: string;
  end_time: string;
  start_price: number;
  end_price: number;
  points_move: number;
  duration_seconds: number;
  chart_timeframe: string;
  section_id: number | null;
  sl_price: number | null;
  tp_price: number | null;
  hit_outcome: "sl" | "tp" | null;
}

// ── Order requests ───────────────────────────────────────────────────────────

export interface NewOrderRequest {
  instrument: string;
  account: string | null;
  action: "buy_long" | "sell_short" | "close" | "cancel_all" | "modify_sl";
  sl_points?: number | null;
  tp_points?: number | null;
  trail_enabled?: boolean;
  quantity?: number | null;
  new_sl_price?: number | null;
  new_tp_price?: number | null;
}

// ── LiveBridge endpoint ──────────────────────────────────────────────────────

export interface LiveBridgeEndpointRow {
  id: "default";
  candidates: Array<{ host: string; last_ok?: string | null }>;
  port: number;
  updated_at: string;
}
