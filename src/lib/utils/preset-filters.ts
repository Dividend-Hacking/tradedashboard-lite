/**
 * Pure preset-filter evaluator.
 *
 * Lifts the per-filter pass/fail logic out of backtest-dashboard.tsx (where
 * it lived inside a `useMemo` over `runResult.syntheticZones`) so the same
 * gates can be applied at runtime in the live auto-trader without the
 * dashboard's React/state baggage.
 *
 * One pure function takes a per-bar context snapshot (the same `ctx_*`
 * shape the synthetic zones use) plus the entry direction + bar timestamp,
 * and returns true iff every enabled sub-filter passes. When a filter is
 * disabled it's a no-op; when it's enabled but the relevant `ctx_*` is
 * null (warmup window, indicator unavailable) the entry is dropped — same
 * behavior as the dashboard.
 */
import { PresetFilters } from "./backtest-presets";
import { parseRawTimestamp } from "./format";

/** Per-bar context snapshot — mirrors the `ctx_*` fields stamped onto
 *  synthetic zones by backtest-engine.snapshotContext(). All fields are
 *  null-tolerant so warmup-window bars don't crash the evaluator.
 *
 *  Field names with `_14` / `_20` / `_200` suffixes are kept for
 *  backwards compat with stored real zones; their VALUES reflect
 *  whatever indicator periods the dashboard was configured with at the
 *  time the snapshot was built. New ctx_* fields below back the
 *  customization-pass filters (BB width, MA distance, volume). */
export interface FilterContext {
  ctx_atr14: number | null;
  ctx_adx14: number | null;
  ctx_price_vs_ema20: string | null;   // "above" | "below" | null
  ctx_price_vs_ema200: string | null;  // "above" | "below" | null
  ctx_bollinger_pos: string | null;    // "above_upper" | "inside" | "below_lower" | null
  ctx_bollinger_bw?: number | null;
  ctx_ma_distance_atr?: number | null;
  ctx_volume_ratio?: number | null;
  ctx_rsi?: number | null;
  ctx_adx_slope?: number | null;
  /** Bid/ask delta imbalance at entry — (ask − bid) / (ask + bid). Range
   *  [−1, +1]; null on bars without a bid/ask split (plain `ohlcv`). */
  ctx_delta_ratio?: number | null;
}

/** Evaluate every enabled sub-filter against a snapshot. Returns true iff
 *  ALL enabled filters pass. Disabled filters are no-ops. The trend filter
 *  needs `direction` since "with"/"against" are direction-relative; the
 *  time filter needs the bar's ISO timestamp to extract HH:MM. */
export function evaluatePresetFilters(
  ctx: FilterContext,
  filters: PresetFilters,
  direction: "Long" | "Short",
  barTime: string
): boolean {
  // ── ADX ────────────────────────────────────────────────────────────
  // Drop when the indicator hasn't warmed up (null) OR when value falls
  // outside [min, max]. Same null-as-fail behavior as the dashboard.
  if (filters.adx.enabled) {
    if (ctx.ctx_adx14 == null) return false;
    if (ctx.ctx_adx14 < filters.adx.min || ctx.ctx_adx14 > filters.adx.max) return false;
  }

  // ── ATR ────────────────────────────────────────────────────────────
  if (filters.atr.enabled) {
    if (ctx.ctx_atr14 == null) return false;
    if (ctx.ctx_atr14 < filters.atr.min || ctx.ctx_atr14 > filters.atr.max) return false;
  }

  // ── Trend (EMA20 + EMA200) ────────────────────────────────────────
  // "with"   = price on the same side as the trade direction (Long+above / Short+below)
  // "against"= price on the opposite side
  // "any"    = filter is a no-op for that EMA leg
  if (filters.trend.enabled) {
    const isLong = direction === "Long";
    if (filters.trend.ema20Mode !== "any") {
      if (ctx.ctx_price_vs_ema20 == null) return false;
      const isWith =
        (isLong && ctx.ctx_price_vs_ema20 === "above") ||
        (!isLong && ctx.ctx_price_vs_ema20 === "below");
      if (filters.trend.ema20Mode === "with" && !isWith) return false;
      if (filters.trend.ema20Mode === "against" && isWith) return false;
    }
    if (filters.trend.ema200Mode !== "any") {
      if (ctx.ctx_price_vs_ema200 == null) return false;
      const isWith =
        (isLong && ctx.ctx_price_vs_ema200 === "above") ||
        (!isLong && ctx.ctx_price_vs_ema200 === "below");
      if (filters.trend.ema200Mode === "with" && !isWith) return false;
      if (filters.trend.ema200Mode === "against" && isWith) return false;
    }
  }

  // ── Bollinger position ────────────────────────────────────────────
  // Only entries whose close sits in an allowed BB region pass.
  if (filters.bollinger.enabled) {
    if (ctx.ctx_bollinger_pos == null) return false;
    if (!filters.bollinger.allowed.includes(ctx.ctx_bollinger_pos as "above_upper" | "inside" | "below_lower")) {
      return false;
    }
  }

  // ── Bollinger band-width ──────────────────────────────────────────
  // Range gate on (upper − lower) in price points. Drops entries with
  // a missing BB (warmup window) when this filter is on, same null-as-
  // fail discipline as the other indicator filters.
  if (filters.bbWidth?.enabled) {
    if (ctx.ctx_bollinger_bw == null) return false;
    if (
      ctx.ctx_bollinger_bw < filters.bbWidth.min ||
      ctx.ctx_bollinger_bw > filters.bbWidth.max
    )
      return false;
  }

  // ── MA distance ───────────────────────────────────────────────────
  // Three modes — see PresetFilters.MaDistanceMode docs:
  //   "absolute" — keep when |distance| in [min, max]
  //   "above"    — keep when distance ≥ 0 AND distance in [min, max]
  //   "below"    — keep when distance ≤ 0 AND |distance| in [min, max]
  // Distance is in ATR units; `min`/`max` in the filter config use the
  // same units. Null distance (warmup) drops the entry.
  if (filters.maDistance?.enabled) {
    const d = ctx.ctx_ma_distance_atr;
    if (d == null) return false;
    const { mode, min, max } = filters.maDistance;
    if (mode === "absolute") {
      const ad = Math.abs(d);
      if (ad < min || ad > max) return false;
    } else if (mode === "above") {
      if (d < 0) return false;
      if (d < min || d > max) return false;
    } else {
      // "below": negative side
      if (d > 0) return false;
      const ad = Math.abs(d);
      if (ad < min || ad > max) return false;
    }
  }

  // ── Volume ratio ──────────────────────────────────────────────────
  // current bar volume / N-bar average volume in [minRatio, maxRatio].
  // Null ratio (warmup or zero-volume rows) drops the entry.
  if (filters.volume?.enabled) {
    const r = ctx.ctx_volume_ratio;
    if (r == null) return false;
    if (r < filters.volume.minRatio || r > filters.volume.maxRatio) return false;
  }

  // ── RSI ───────────────────────────────────────────────────────────
  // Wilder RSI in [min, max]. 0–100 scale; null drops same as the
  // other indicator filters.
  if (filters.rsi?.enabled) {
    const v = ctx.ctx_rsi;
    if (v == null) return false;
    if (v < filters.rsi.min || v > filters.rsi.max) return false;
  }

  // ── ADX direction ─────────────────────────────────────────────────
  // Gates on the SIGN of ctx_adx_slope (= ADX[i] − ADX[i-lookback]).
  //   "rising"  → slope > flatThreshold
  //   "falling" → slope < -flatThreshold
  //   "flat"    → |slope| ≤ flatThreshold
  //   "any"     → no-op (filter disabled in practice; same as enabled=false)
  // Null slope (warmup / lookback bar missing) drops the entry.
  if (filters.adxTrend?.enabled && filters.adxTrend.mode !== "any") {
    const slope = ctx.ctx_adx_slope;
    if (slope == null) return false;
    const thresh = Math.abs(filters.adxTrend.flatThreshold);
    if (filters.adxTrend.mode === "rising") {
      if (slope <= thresh) return false;
    } else if (filters.adxTrend.mode === "falling") {
      if (slope >= -thresh) return false;
    } else {
      // "flat"
      if (Math.abs(slope) > thresh) return false;
    }
  }

  // ── Bid/ask delta imbalance ───────────────────────────────────────
  // (ask − bid) / (ask + bid) at entry, in [−1, +1]. Null drops same
  // as the other indicator filters — plain `ohlcv` sessions reject
  // every trade when this filter is on, which is the desired fail-
  // closed behavior for a knob whose data isn't present.
  if (filters.delta?.enabled) {
    const d = ctx.ctx_delta_ratio;
    if (d == null) return false;
    if (d < filters.delta.min || d > filters.delta.max) return false;
  }

  // ── Time-of-day ───────────────────────────────────────────────────
  // Multi-window: a bar passes when its time falls in ANY window (OR
  // semantics). Each window has the same wrap-around handling as the
  // legacy single-window filter — from <= to → inclusive [from, to];
  // from > to → wraps midnight (e.g. 22:00→06:00).
  // Falls back to the legacy [from, to] pair when `windows` is missing
  // or empty so a partially-loaded preset still gates correctly.
  if (filters.time.enabled) {
    const parseHM = (t: string): number => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const { hour, minute } = parseRawTimestamp(barTime);
    const barMin = hour * 60 + minute;
    const windows =
      filters.time.windows && filters.time.windows.length > 0
        ? filters.time.windows
        : [{ from: filters.time.from, to: filters.time.to }];
    let matched = false;
    for (const w of windows) {
      const fromMin = parseHM(w.from);
      const toMin = parseHM(w.to);
      if (fromMin <= toMin) {
        if (barMin >= fromMin && barMin <= toMin) {
          matched = true;
          break;
        }
      } else {
        // Wrap-around — inside the window when bar is at/after fromMin
        // OR at/before toMin.
        if (barMin >= fromMin || barMin <= toMin) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) return false;
  }

  return true;
}
