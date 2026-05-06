/**
 * Trade Interface
 *
 * Maps all 45 columns from the Supabase `trades` table.
 * Represents a single MNQ futures trade with full context:
 * entry/exit data, P&L, risk metrics, market context, and grading.
 *
 * Nullable DB columns are typed as `T | null`.
 */
export interface Trade {
  // --- Identity ---
  id: number;

  // --- Timing ---
  /** ISO timestamp of trade entry */
  entry_time: string;
  /** ISO timestamp of trade exit (null if still open) */
  exit_time: string | null;
  /** Wall-clock time when entry was processed (differs from entry_time during playback) */
  real_entry_time: string | null;
  /** Wall-clock time when exit was processed (differs from exit_time during playback) */
  real_exit_time: string | null;

  // --- Core Trade Data ---
  instrument: string;
  /** "Long" or "Short" */
  direction: string;
  entry_price: number;
  exit_price: number | null;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  quantity: number | null;

  // --- P&L ---
  pnl_points: number | null;
  pnl_dollars: number | null;

  // --- Risk / Reward ---
  initial_stop_distance: number | null;
  /** Actual realized R:R of the trade */
  actual_rr: number | null;
  /** Planned R:R from the setup */
  setup_rr: number | null;

  // --- MFE / MAE (Maximum Favorable/Adverse Excursion) ---
  mfe_points: number | null;
  mae_points: number | null;
  mfe_r_multiple: number | null;
  mae_r_multiple: number | null;
  post_exit_mfe_points: number | null;
  post_exit_mfe_r: number | null;
  post_exit_mae_points: number | null;

  // --- Strategy & Account ---
  strategy_signal_name: string | null;
  account_name: string | null;

  // --- Risk Parameters ---
  risk_units: number | null;
  atr_multiplier: number | null;
  rr_multiplier: number | null;
  sl_mode: string | null;

  // --- Market Context at Entry ---
  ctx_atr14: number | null;
  ctx_atr14_15s: number | null;
  ctx_price_vs_ema20: string | null;
  ctx_dist_ema20_atr: number | null;
  ctx_price_vs_ema200: string | null;
  ctx_dist_ema200_atr: number | null;
  ctx_bollinger_pos: string | null;
  ctx_bollinger_bw: number | null;
  ctx_market_regime: string | null;
  ctx_adx14: number | null;

  // --- Metadata ---
  custom_tags: Record<string, unknown> | null;
  notes: string | null;
  trade_grade: string | null;
  trade_mistake: string | null;
  trade_regime: string | null;
  /** "Win", "Loss", or "Breakeven" */
  trade_status: string;
  created_at: string | null;
}

/**
 * TradeBar — one OHLC candle captured around a live trade.
 * Mirrors the `trade_bars` Supabase table. `bar_index` is 0-based and
 * trade-local (NinjaScript assigns it starting at the oldest pre-entry
 * context bar so the entry bar falls ~25 in).
 */
export interface TradeBar {
  id: number;
  trade_id: number;
  bar_index: number;
  bar_time: string;
  bar_open: number | null;
  bar_high: number | null;
  bar_low: number | null;
  bar_close: number | null;
  bar_volume: number | null;
  is_entry_bar: boolean;
  is_exit_bar: boolean;
}
