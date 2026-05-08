/**
 * Trade Zone Types
 *
 * TypeScript interfaces for the trade_zones and trade_zone_bars Supabase tables.
 * Trade zones are drawn on NinjaTrader charts to mark hypothetical entry-to-exit
 * regions for later analysis of optimal exits, entries, and timing.
 */

/** A single trade zone — one drawn rectangle on the chart */
export interface TradeZone {
  id: number;
  instrument: string;
  direction: string; // "Long" or "Short"
  start_time: string; // ISO timestamp — chronologically earlier anchor
  end_time: string; // ISO timestamp — chronologically later anchor
  start_price: number; // Entry price (first anchor placed by user)
  end_price: number; // Exit price (second anchor placed by user)
  bar_count: number; // Number of 15s bars captured within the zone
  points_move: number; // Signed point delta (direction-aware)
  duration_seconds: number; // end_time - start_time in seconds
  notes: string | null; // User-entered notes from properties panel
  chart_timeframe: string | null; // e.g., "15 Second"
  // Market context at entry (computed from bars before the zone)
  ctx_atr14: number | null; // ATR(14) Wilder at entry — volatility / SL sizing
  ctx_adx14: number | null; // ADX(14) at entry — trending vs ranging
  ctx_ema20: number | null; // EMA(20) value at entry
  ctx_ema200: number | null; // EMA(200) value at entry
  ctx_price_vs_ema20: string | null; // "above" or "below"
  ctx_price_vs_ema200: string | null; // "above" or "below"
  ctx_dist_ema20_atr: number | null; // Distance from EMA20 in ATR units
  ctx_bollinger_pos: string | null; // "above_upper", "inside", "below_lower"
  ctx_bollinger_bw: number | null; // Bollinger bandwidth (upper-lower)/middle
  // Optional extended context — populated for synthetic backtest zones
  // when the dashboard's customized indicator config is in use; absent on
  // real Supabase-stored zones. Marked optional so the cast-free spread
  // in backtest-engine.runBacktestForSession works without a separate
  // synthetic-zone subtype, and so any caller that only reads the legacy
  // fields keeps compiling.
  ctx_ma_distance_value?: number | null;
  ctx_ma_distance_atr?: number | null;
  ctx_dist_ema200_atr?: number | null;
  ctx_volume?: number | null;
  ctx_volume_ratio?: number | null;
  ctx_rsi?: number | null;
  ctx_adx_slope?: number | null;
  /** Bid/ask delta imbalance at entry — (ask − bid) / (ask + bid), in
   *  [−1, +1]. Populated for synthetic backtest zones whose source bars
   *  carry a bid/ask split (tick / tick_bidask / ohlcv_bidask sessions);
   *  absent / null otherwise. Drives the delta-imbalance entry filter. */
  ctx_delta_ratio?: number | null;
  entry_hour: number | null; // Hour of entry (0-23)
  entry_day_of_week: number | null; // 0=Sun..6=Sat
  section_id: number | null; // FK → zone_sections.id (NULL = "default" fallback)
  // Visual SL/TP set by the user when placing a practice zone. NULL if no
  // level was configured. hit_outcome records which one (if any) price
  // touched first during the zone's bar window.
  sl_price: number | null;
  tp_price: number | null;
  hit_outcome: "sl" | "tp" | null;
  created_at: string; // ISO timestamp
}

/** A section used to bucket zones (e.g. "in-sample", "out-sample", per-strategy).
 *  Sections let the risk simulator and practice sessions work with subsets of
 *  zones instead of the whole flat pool. */
export interface ZoneSection {
  id: number;
  name: string;
  created_at: string;
}

/** A single 15-second bar within a trade zone */
export interface TradeZoneBar {
  id: number;
  zone_id: number; // FK → trade_zones.id
  bar_time: string; // ISO timestamp — bar open time
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
  bar_index: number; // 0-based sequential position within the zone
  mfe_from_start: number | null; // Cumulative max favorable excursion from entry
  mae_from_start: number | null; // Cumulative max adverse excursion from entry
  // Per-bar risk analytics
  drawdown_from_entry: number | null; // Running max adverse move from entry
  runup_from_entry: number | null; // Running max favorable move from entry
  close_vs_entry: number | null; // This bar's P&L vs entry (direction-aware, signed)
  high_since_entry: number | null; // Running best favorable price reached
  retrace_from_peak: number | null; // How much given back from the peak
  created_at: string;
  // ─── Order-flow split (optional) ──────────────────────────────────────
  // Populated only when the source data carries bid/ask attribution
  // (replay sessions with `ohlcv_bidask` or `tick_bidask` granularity).
  // Plain `ohlcv` sessions and DB-loaded zones leave these undefined,
  // and order-flow indicators (delta, CVD, etc.) treat undefined/null
  // as missing data → NaN.
  bar_volume_bid?: number | null;
  bar_volume_ask?: number | null;
}
