/**
 * calculations.ts — Pure technical-indicator math.
 *
 * All calculators take a normalized bar array (any object with OHLCV +
 * bar_time fields, matching LiveBar / ReplayBar) and return arrays of
 * points ready to hand to lightweight-charts `series.setData(...)`.
 *
 * Design notes:
 *   - Leading warmup values are OMITTED rather than emitted as null, so
 *     lightweight-charts renders a clean line that starts at the first
 *     valid index (no whiteline gap).
 *   - Time conversion uses `rawTimestampToUnix` — the same helper the
 *     candlestick series uses — so indicator X-coords line up exactly
 *     with the bars.
 *   - No floating-point short-circuits: every math path is deterministic
 *     so the same bars always produce the same values.
 *   - All functions are pure — no shared state, safe to call every tick.
 */

import type { SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import { rawTimestampToUnix } from "@/lib/utils/format";

/** Minimal bar shape accepted by every calculator. Both LiveBar and
 *  ReplayBar satisfy this (they just add an `instrument`/`timeframe`
 *  tag that indicators don't care about). */
export interface IndicatorBar {
  bar_time: string;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
}

/** A single line-indicator point. `time` is always a UTCTimestamp (unix
 *  seconds) even though the type says `Time` — lightweight-charts accepts
 *  both and the chart uses UTCTimestamp throughout. */
export interface LinePoint {
  time: Time;
  value: number;
}

/** A single histogram-indicator point (currently just volume). The
 *  `color` is optional so the caller can override the default tint per
 *  point — we color bars by up/down close like every other charting
 *  tool. */
export interface HistogramPoint {
  time: Time;
  value: number;
  color?: string;
}

/** Convert a bar timestamp to the `Time` type lightweight-charts expects.
 *  Factored so every calculator uses identical conversion — any drift
 *  here would desync indicator X-coords from candles. */
function barTime(bar: IndicatorBar): Time {
  return rawTimestampToUnix(bar.bar_time) as UTCTimestamp;
}

// ─── Simple Moving Average ────────────────────────────────────────────
// Standard arithmetic mean of the last `period` closes. Emits a point
// starting at index `period - 1` (first bar where we have a full window).
// Uses a rolling sum instead of recomputing the window each step so the
// cost stays O(n) even for long histories.

export function sma(bars: IndicatorBar[], period: number): LinePoint[] {
  if (period <= 0 || bars.length < period) return [];
  const out: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].bar_close;
    if (i >= period) sum -= bars[i - period].bar_close;
    if (i >= period - 1) {
      out.push({ time: barTime(bars[i]), value: sum / period });
    }
  }
  return out;
}

// ─── Exponential Moving Average ──────────────────────────────────────
// Seeded with the SMA of the first `period` closes (industry-standard
// approach — matches TradingView / pandas-ta). Smoothing factor
// α = 2 / (period + 1). First output point lands at index `period - 1`.

export function ema(bars: IndicatorBar[], period: number): LinePoint[] {
  if (period <= 0 || bars.length < period) return [];
  const out: LinePoint[] = [];
  const alpha = 2 / (period + 1);

  // Seed: simple mean of the first `period` closes.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += bars[i].bar_close;
  let prev = seed / period;
  out.push({ time: barTime(bars[period - 1]), value: prev });

  for (let i = period; i < bars.length; i++) {
    prev = bars[i].bar_close * alpha + prev * (1 - alpha);
    out.push({ time: barTime(bars[i]), value: prev });
  }
  return out;
}

// ─── Volume Histogram ────────────────────────────────────────────────
// Colored by up/down close so the pane reads the same as the candles
// above. Up bars get a green tint, down get red; neutral bars (open ==
// close) inherit the up color. Alpha-mixed so the volume pane doesn't
// dominate the candles visually.

const VOLUME_UP_COLOR = "rgba(34, 197, 94, 0.5)";   // translucent green
const VOLUME_DOWN_COLOR = "rgba(239, 68, 68, 0.5)"; // translucent red

export function volume(bars: IndicatorBar[]): HistogramPoint[] {
  const out: HistogramPoint[] = [];
  for (const bar of bars) {
    const up = bar.bar_close >= bar.bar_open;
    out.push({
      time: barTime(bar),
      value: bar.bar_volume,
      color: up ? VOLUME_UP_COLOR : VOLUME_DOWN_COLOR,
    });
  }
  return out;
}

// ─── ATR (Wilder smoothing) ──────────────────────────────────────────
// True Range = max(high - low, |high - prevClose|, |low - prevClose|).
// Wilder's smoothing: seed with SMA of first `period` TR values, then
// ATR_t = (ATR_{t-1} * (period - 1) + TR_t) / period.
// First output lands at index `period` (we need TR[0..period-1] for the
// seed, and TR[i] needs bars[i-1], so TR starts at index 1).

export function atr(bars: IndicatorBar[], period: number): LinePoint[] {
  if (period <= 0 || bars.length < period + 1) return [];

  // Compute true range for every index >= 1. TR[0] is undefined because
  // we have no previous close; we start the array at index 1 of bars.
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const pc = bars[i - 1].bar_close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }

  // Seed — mean of the first `period` TRs.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += trs[i];
  let prev = seed / period;

  const out: LinePoint[] = [];
  // First ATR value corresponds to bars[period] (since trs[0] ↔ bars[1]).
  out.push({ time: barTime(bars[period]), value: prev });

  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    // trs[i] corresponds to bars[i + 1]
    out.push({ time: barTime(bars[i + 1]), value: prev });
  }
  return out;
}

// ─── ADX (Wilder) ────────────────────────────────────────────────────
// Standard Wilder implementation:
//   +DM_t = high_t - high_{t-1} if that's positive and larger than
//           low_{t-1} - low_t, else 0
//   -DM_t = low_{t-1} - low_t   if that's positive and larger than
//           high_t - high_{t-1}, else 0
//   TR_t  = classic true range
// Wilder-smooth each series over `period`, then:
//   +DI = 100 * smoothed(+DM) / smoothed(TR)
//   -DI = 100 * smoothed(-DM) / smoothed(TR)
//   DX  = 100 * |+DI - -DI| / (+DI + -DI)
//   ADX = Wilder-smoothed DX over `period`
//
// First ADX value appears at index `2*period` (one smoothing for +DI/-DI,
// a second for ADX). We emit only the ADX line — users who want +DI/-DI
// can add those as separate indicator kinds in a future phase.

export function adx(bars: IndicatorBar[], period: number): LinePoint[] {
  // Need 2*period + 1 bars to produce any ADX value (DM/TR start at
  // index 1, then two Wilder smooths of length `period` each).
  if (period <= 0 || bars.length < 2 * period + 1) return [];

  // Raw per-bar +DM / -DM / TR arrays, each starting at index 1 of bars.
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].bar_high - bars[i - 1].bar_high;
    const downMove = bars[i - 1].bar_low - bars[i].bar_low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const pc = bars[i - 1].bar_close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder-smooth: seed = sum of first `period`; subsequent =
  // prev - prev/period + curr. (This is the classic Wilder running-sum
  // form; dividing by `period` at the end gives the average.)
  function wilder(series: number[]): number[] {
    const smoothed: number[] = [];
    if (series.length < period) return smoothed;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += series[i];
    smoothed.push(sum);
    for (let i = period; i < series.length; i++) {
      sum = sum - sum / period + series[i];
      smoothed.push(sum);
    }
    return smoothed;
  }

  const plusSmooth = wilder(plusDM);   // indices align: smoothed[0] ↔ raw[period-1]
  const minusSmooth = wilder(minusDM);
  const trSmooth = wilder(trs);

  // Compute DX for each aligned smoothed index.
  const dx: number[] = [];
  for (let i = 0; i < trSmooth.length; i++) {
    if (trSmooth[i] === 0) {
      dx.push(0);
      continue;
    }
    const plusDI = (100 * plusSmooth[i]) / trSmooth[i];
    const minusDI = (100 * minusSmooth[i]) / trSmooth[i];
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }

  // ADX = Wilder-smoothed DX over `period` periods, then averaged.
  if (dx.length < period) return [];
  let adxSum = 0;
  for (let i = 0; i < period; i++) adxSum += dx[i];
  let prev = adxSum / period;

  const out: LinePoint[] = [];
  // First ADX value lines up with bars index: raw[i] ↔ bars[i + 1],
  // smoothed[0] ↔ raw[period - 1] ↔ bars[period], dx[0] ↔ bars[period],
  // and first ADX at dx[period - 1] ↔ bars[2*period - 1]. Emit there.
  out.push({ time: barTime(bars[2 * period - 1]), value: prev });

  for (let i = period; i < dx.length; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    // dx[i] ↔ bars[i + period]
    out.push({ time: barTime(bars[i + period]), value: prev });
  }
  return out;
}

// ─── Signal (range-break + pullback triangles) ──────────────────────────
// A bar-by-bar setup detector that paints a triangle when an evaluated
// bar passes three layers of checks:
//
//   1. SETUP — where is price relative to the prior `lookback`-bar range?
//        long_position  = (close - low_N)  / (high_N - low_N)
//        short_position = (high_N - close) / (high_N - low_N)
//        • At-edge  (position ≥ AT_EDGE_THRESHOLD = 0.85): fires
//          unconditionally — price is poking the recent extreme.
//        • Near-edge (NEAR_EDGE_THRESHOLD ≤ position < AT_EDGE_THRESHOLD):
//          fires only when the prior 5-bar move was a SMALL counter-trend
//          pullback in the trade direction (F1 filter). The reasoning:
//          edge in this zone came from buying small dips, NOT from
//          chasing deep dives.
//
//   2. REJECTS — even if setup is valid, skip the bar if either:
//        • F2 (flat momentum): both move_5 and move_10 are within
//          ±FLAT_ATR_FRACTION × ATR. No directional context.
//        • F3 (stale level): position > STALE_BREAK_THRESHOLD (true
//          breakout) AND the level being broken was set more than
//          STALE_BARS_BACK bars ago. Price already had time to back off
//          and is re-attacking a tested level.
//
//   3. TRIGGER — the candidate bar must close in the trade direction:
//          close > open for longs, close < open for shorts.
//
// All thresholds are stable constants below — they were calibrated on
// 5-min bars and don't need per-instrument tuning because momentum
// thresholds are scaled by ATR. Only the lookback is user-configurable
// (via the indicator config's `period`).
//
// Output: lightweight-charts SeriesMarkers, one per fired bar — arrowUp
// painted below long-fire bars, arrowDown above short-fire bars. The
// markers plugin places these on whatever series we attach them to.

const ATR_PERIOD = 14;
const AT_EDGE_THRESHOLD = 0.85;        // |≥| to fire unconditionally
const NEAR_EDGE_THRESHOLD = 0.5;       // |≥| with pullback to fire (F1)
const PULLBACK_ATR_FRACTION = 0.4;     // F1 — magnitude of allowed pullback
const FLAT_ATR_FRACTION = 0.2;         // F2 — flat-momentum threshold
const STALE_BREAK_THRESHOLD = 1.05;    // F3 — must be a true break to apply
const STALE_BARS_BACK = 15;            // F3 — bars-since-level cutoff

/** Standard Wilder ATR as a flat number array, aligned 1-to-1 with the
 *  bars array (entry i represents the ATR after bar i closes). Bars
 *  before the warmup window are filled with NaN so callers can detect
 *  "no value yet" without bounds-checking. We re-implement the math
 *  here (rather than calling `atr()` above) because the series form is
 *  awkward to reuse — that one returns `LinePoint[]` keyed by time. */
export function atrSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (bars.length < period + 1) return out;

  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const pc = bars[i - 1].bar_close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder seed = simple mean of the first `period` TRs.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += trs[i];
  let prev = seed / period;
  // First ATR value belongs to bars[period] (since trs[0] ↔ bars[1]).
  out[period] = prev;

  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}

export function signalTriangles(
  bars: IndicatorBar[],
  lookback: number,
  /** Color used for both long-fire (arrowUp) and short-fire (arrowDown)
   *  triangles. Direction is communicated by the arrow shape, so a
   *  single color keeps the picker UX simple — the user's chosen color
   *  paints all signals. */
  color: string,
): SeriesMarker<Time>[] {
  // We need at least `lookback` historical bars + ATR warmup + a 5-bar
  // momentum window starting at `i-1`, so `i-5` must be valid.
  // Earliest evaluable index is therefore max(lookback, ATR_PERIOD, 5).
  const minIndex = Math.max(lookback, ATR_PERIOD + 1, 5);
  if (lookback <= 0 || bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, ATR_PERIOD);
  const markers: SeriesMarker<Time>[] = [];

  for (let i = minIndex; i < bars.length; i++) {
    const atrV = atrVals[i];
    if (!Number.isFinite(atrV) || atrV <= 0) continue;

    // Pre-entry range: bars[i-lookback..i-1] (excludes the current bar
    // so the trigger can't be its own range setter — that's important,
    // a 1.0 reading means "we just broke the previous range," not
    // "we're at our own high").
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    let highIdx = i - 1;
    let lowIdx = i - 1;
    for (let j = i - lookback; j < i; j++) {
      const h = bars[j].bar_high;
      const l = bars[j].bar_low;
      if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
      if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
    }
    const range = rangeHigh - rangeLow;
    if (range <= 0) continue; // degenerate flat window — skip

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const longPos  = (close - rangeLow)  / range;
    const shortPos = (rangeHigh - close) / range;

    // 5- and 10-bar momentum, ending one bar BEFORE the trigger bar.
    // Using close[i-1] (not close[i]) so the trigger candle's own
    // direction doesn't double-count once we check it later.
    const move5  = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[i - 10 < 0 ? 0 : i - 10].bar_close;

    // F2 — flat momentum: both windows within ±FLAT × ATR. Same logic
    // for both directions since "flat" is direction-agnostic.
    const flatBound = FLAT_ATR_FRACTION * atrV;
    const isFlat = Math.abs(move5) < flatBound && Math.abs(move10) < flatBound;
    if (isFlat) continue;

    // ─── Long branch ────────────────────────────────────────────────
    // F3 (long): position > 1.05 means we just broke the prior high;
    // if that high was set > 15 bars ago we're re-testing a stale level
    // — skip.
    const longBarsSinceLevel = i - highIdx;
    const longStale = longPos > STALE_BREAK_THRESHOLD && longBarsSinceLevel > STALE_BARS_BACK;

    let longSetup = false;
    if (longPos >= AT_EDGE_THRESHOLD) {
      longSetup = true;
    } else if (longPos >= NEAR_EDGE_THRESHOLD) {
      // F1 — small counter-trend pullback into the long zone:
      //   move5 ∈ [-0.4×ATR, 0]
      const pullbackMin = -PULLBACK_ATR_FRACTION * atrV;
      longSetup = move5 >= pullbackMin && move5 <= 0;
    }

    const longTrigger = close > open;
    if (longSetup && !longStale && longTrigger) {
      markers.push({
        time: barTime(bars[i]),
        position: "belowBar",
        color,
        shape: "arrowUp",
      });
      continue; // a bar can't simultaneously fire long and short
    }

    // ─── Short branch (mirror of long) ──────────────────────────────
    const shortBarsSinceLevel = i - lowIdx;
    const shortStale = shortPos > STALE_BREAK_THRESHOLD && shortBarsSinceLevel > STALE_BARS_BACK;

    let shortSetup = false;
    if (shortPos >= AT_EDGE_THRESHOLD) {
      shortSetup = true;
    } else if (shortPos >= NEAR_EDGE_THRESHOLD) {
      // F1 mirrored — small counter-trend pullback into the short zone
      // is a small UP move just before the trigger:
      //   move5 ∈ [0, 0.4×ATR]
      const pullbackMax = PULLBACK_ATR_FRACTION * atrV;
      shortSetup = move5 >= 0 && move5 <= pullbackMax;
    }

    const shortTrigger = close < open;
    if (shortSetup && !shortStale && shortTrigger) {
      markers.push({
        time: barTime(bars[i]),
        position: "aboveBar",
        color,
        shape: "arrowDown",
      });
    }
  }

  return markers;
}

// ─── Signal v2 (selective: cross-into-zone, lockout, base filter) ───────
// V1 of the signal indicator fires liberally — every bar that happens to
// sit in the zone with a valid trigger paints a triangle. In practice
// the breakout edge is a small fraction of bars, so V1 over-marks.
//
// V2 keeps V1's setup tier logic (at-edge / near-edge with pullback) and
// reject filters (flat momentum, stale level, trigger-bar direction)
// but layers three additional gates on top:
//
//   1. CROSS-INTO-ZONE — fire only on the bar where price transitions
//      from outside the zone (longPos < ZONE_ENTER_V2) to inside
//      (longPos ≥ ZONE_ENTER_V2). Prevents repeated fires while price
//      sits in the zone over multiple bars.
//
//   2. PER-DIRECTION LOCKOUT — once a direction fires, it's locked
//      until either (a) price clearly leaves the zone for that
//      direction (longPos < ZONE_EXIT_V2) or (b) COOLDOWN_BARS_V2
//      bars have elapsed since the fire. Long and short have separate
//      lockouts so a long firing doesn't suppress a subsequent short.
//
//   3. BASE FILTER — the lookback window must actually look like a
//      base, not just any 20 bars:
//        • range / ATR ∈ [BASE_RANGE_ATR_MIN, BASE_RANGE_ATR_MAX] —
//          excludes ultra-tight ranges (no breakout potential) and
//          already-trending windows (range too wide).
//        • |close[i-1] - close[i-lookback]| / range < BASE_DRIFT_FRACTION
//          — net end-to-end drift across the window is small relative
//          to the range, i.e., the window churned rather than trended.
//
// All other tunables (AT_EDGE_THRESHOLD, FLAT_ATR_FRACTION, etc.) are
// shared with V1 so the underlying setup definition stays identical.

const ZONE_ENTER_V2 = 0.5;          // longPos / shortPos crossing-up threshold
const ZONE_EXIT_V2 = 0.3;           // crossing-down threshold to release lockout
const COOLDOWN_BARS_V2 = 30;        // safety-net time-based lockout release
const BASE_RANGE_ATR_MIN = 1.5;     // base must span at least 1.5 × ATR
const BASE_RANGE_ATR_MAX = 4.0;     // and at most 4.0 × ATR
const BASE_DRIFT_FRACTION = 0.5;    // |net drift| / range < this → not trending

export function signalTrianglesV2(
  bars: IndicatorBar[],
  lookback: number,
  /** Same single-color treatment as V1 — direction is conveyed by
   *  arrowUp / arrowDown shape. */
  color: string,
): SeriesMarker<Time>[] {
  const minIndex = Math.max(lookback, ATR_PERIOD + 1, 5);
  if (lookback <= 0 || bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, ATR_PERIOD);
  const markers: SeriesMarker<Time>[] = [];

  // Per-direction state across the bar loop.
  // `prev*Pos` carries the position-in-range from the previous evaluable
  // bar so we can detect a cross-up event. Reset to null whenever a bar
  // is unevaluable (degenerate range, missing ATR) so we don't fabricate
  // a cross when re-entering valid territory.
  let prevLongPos: number | null = null;
  let prevShortPos: number | null = null;
  // -1 means "not currently locked out". Otherwise stores the bar index
  // when we fired, so cooldown elapsed can be computed as i - locked.
  let longLockedSinceBar = -1;
  let shortLockedSinceBar = -1;

  for (let i = minIndex; i < bars.length; i++) {
    const atrV = atrVals[i];
    if (!Number.isFinite(atrV) || atrV <= 0) {
      prevLongPos = null;
      prevShortPos = null;
      continue;
    }

    // Pre-entry range over bars[i - lookback .. i - 1] (excludes current).
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    let highIdx = i - 1;
    let lowIdx = i - 1;
    for (let j = i - lookback; j < i; j++) {
      const h = bars[j].bar_high;
      const l = bars[j].bar_low;
      if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
      if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
    }
    const range = rangeHigh - rangeLow;
    if (range <= 0) {
      prevLongPos = null;
      prevShortPos = null;
      continue;
    }

    // Base filter — both gates must pass for the window to qualify.
    const rangeInAtr = range / atrV;
    const isReasonableSize = rangeInAtr >= BASE_RANGE_ATR_MIN && rangeInAtr <= BASE_RANGE_ATR_MAX;
    const drift = Math.abs(bars[i - 1].bar_close - bars[i - lookback].bar_close);
    const isLowDrift = drift / range < BASE_DRIFT_FRACTION;
    const isBase = isReasonableSize && isLowDrift;

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const longPos = (close - rangeLow) / range;
    const shortPos = (rangeHigh - close) / range;

    // 5- / 10-bar momentum (one bar before trigger so trigger direction
    // doesn't double-count). Bounded at index 0 for safety.
    const move5 = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[Math.max(0, i - 10)].bar_close;

    const flatBound = FLAT_ATR_FRACTION * atrV;
    const isFlat = Math.abs(move5) < flatBound && Math.abs(move10) < flatBound;

    // ─── Lockout release ────────────────────────────────────────────
    // Independent per direction. Either price drops out of the zone
    // (clear "left the setup") or enough bars elapse (stale lockout).
    if (longLockedSinceBar >= 0) {
      const elapsed = i - longLockedSinceBar;
      if (longPos < ZONE_EXIT_V2 || elapsed >= COOLDOWN_BARS_V2) {
        longLockedSinceBar = -1;
      }
    }
    if (shortLockedSinceBar >= 0) {
      const elapsed = i - shortLockedSinceBar;
      if (shortPos < ZONE_EXIT_V2 || elapsed >= COOLDOWN_BARS_V2) {
        shortLockedSinceBar = -1;
      }
    }

    // ─── Cross-into-zone detection ──────────────────────────────────
    // `prev*Pos` is null on the very first evaluable bar — treat that
    // as "we don't know" and skip firing rather than assuming an entry.
    const longCrossedIn =
      prevLongPos !== null && prevLongPos < ZONE_ENTER_V2 && longPos >= ZONE_ENTER_V2;
    const shortCrossedIn =
      prevShortPos !== null && prevShortPos < ZONE_ENTER_V2 && shortPos >= ZONE_ENTER_V2;

    let firedLong = false;

    // ─── Long branch ────────────────────────────────────────────────
    if (longLockedSinceBar < 0 && longCrossedIn && isBase && !isFlat) {
      let longSetup = false;
      if (longPos >= AT_EDGE_THRESHOLD) {
        longSetup = true;
      } else if (longPos >= NEAR_EDGE_THRESHOLD) {
        const pullbackMin = -PULLBACK_ATR_FRACTION * atrV;
        longSetup = move5 >= pullbackMin && move5 <= 0;
      }

      const longBarsSinceLevel = i - highIdx;
      const longStale = longPos > STALE_BREAK_THRESHOLD && longBarsSinceLevel > STALE_BARS_BACK;
      const longTrigger = close > open;

      if (longSetup && !longStale && longTrigger) {
        markers.push({
          time: barTime(bars[i]),
          position: "belowBar",
          color,
          shape: "arrowUp",
        });
        longLockedSinceBar = i;
        firedLong = true;
      }
    }

    // ─── Short branch (mirror; skip if long fired this bar) ─────────
    if (!firedLong && shortLockedSinceBar < 0 && shortCrossedIn && isBase && !isFlat) {
      let shortSetup = false;
      if (shortPos >= AT_EDGE_THRESHOLD) {
        shortSetup = true;
      } else if (shortPos >= NEAR_EDGE_THRESHOLD) {
        const pullbackMax = PULLBACK_ATR_FRACTION * atrV;
        shortSetup = move5 >= 0 && move5 <= pullbackMax;
      }

      const shortBarsSinceLevel = i - lowIdx;
      const shortStale = shortPos > STALE_BREAK_THRESHOLD && shortBarsSinceLevel > STALE_BARS_BACK;
      const shortTrigger = close < open;

      if (shortSetup && !shortStale && shortTrigger) {
        markers.push({
          time: barTime(bars[i]),
          position: "aboveBar",
          color,
          shape: "arrowDown",
        });
        shortLockedSinceBar = i;
      }
    }

    // Carry positions forward for the next bar's cross detection.
    prevLongPos = longPos;
    prevShortPos = shortPos;
  }

  return markers;
}

// ─── Signal v3 (V2 + multi-bar acceptance + body/range trigger) ────────
// V3 keeps every V2 gate (base filter, near/at-edge, pullback, flat,
// stale, lockout, cooldown) and tightens the two parts most prone to
// noise on small (15s/30s) timeframes:
//
//   1. MULTI-BAR ACCEPTANCE — replaces V2's prevPos cross-detection with
//      a per-direction in-zone STREAK counter. Increments while pos ≥
//      ZONE_ENTER_V2, resets to 0 otherwise. Fires on the bar that brings
//      the streak to ACCEPTANCE_BARS_V3. The lockout suppresses re-fires
//      so a streak climbing past the threshold doesn't double-fire.
//
//   2. BODY / RANGE TRIGGER — replaces V2's bare close>open / close<open
//      with a body-dominance gate: |close − open| / (high − low) ≥
//      BODY_RATIO_MIN_V3. Bar direction is still required. Wicky / doji /
//      zero-range bars are rejected even when their close direction
//      agrees with the breakout side.
//
// All shared constants (AT_EDGE_THRESHOLD, FLAT_ATR_FRACTION, base filter,
// lockout, etc.) come from the same calibration as V1 / V2 — change once,
// applied to all three. The two new constants below are intentionally the
// only V3-specific tunables; the indicator surface is single-period
// (lookback) so users don't tune these per-instance.

const ACCEPTANCE_BARS_V3 = 2;     // in-zone streak length to fire
const BODY_RATIO_MIN_V3 = 0.5;    // |close-open| / (high-low) ≥ this

export function signalTrianglesV3(
  bars: IndicatorBar[],
  lookback: number,
  /** Same single-color treatment as V1 / V2 — direction is conveyed by
   *  arrowUp / arrowDown shape. */
  color: string,
): SeriesMarker<Time>[] {
  const minIndex = Math.max(lookback, ATR_PERIOD + 1, 5);
  if (lookback <= 0 || bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, ATR_PERIOD);
  const markers: SeriesMarker<Time>[] = [];

  // Per-direction streak counters (replaces V2's prevPos tracking) and
  // independent lockout sentinels (-1 = unlocked).
  let longStreak = 0;
  let shortStreak = 0;
  let longLockedSinceBar = -1;
  let shortLockedSinceBar = -1;

  for (let i = minIndex; i < bars.length; i++) {
    const atrV = atrVals[i];
    if (!Number.isFinite(atrV) || atrV <= 0) {
      longStreak = 0;
      shortStreak = 0;
      continue;
    }

    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    let highIdx = i - 1;
    let lowIdx = i - 1;
    for (let j = i - lookback; j < i; j++) {
      const h = bars[j].bar_high;
      const l = bars[j].bar_low;
      if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
      if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
    }
    const range = rangeHigh - rangeLow;
    if (range <= 0) {
      longStreak = 0;
      shortStreak = 0;
      continue;
    }

    // Base filter (same as V2) — both gates must pass.
    const rangeInAtr = range / atrV;
    const isReasonableSize = rangeInAtr >= BASE_RANGE_ATR_MIN && rangeInAtr <= BASE_RANGE_ATR_MAX;
    const drift = Math.abs(bars[i - 1].bar_close - bars[i - lookback].bar_close);
    const isLowDrift = drift / range < BASE_DRIFT_FRACTION;
    const isBase = isReasonableSize && isLowDrift;

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const high = bars[i].bar_high;
    const low = bars[i].bar_low;
    const longPos = (close - rangeLow) / range;
    const shortPos = (rangeHigh - close) / range;

    const move5 = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[Math.max(0, i - 10)].bar_close;
    const flatBound = FLAT_ATR_FRACTION * atrV;
    const isFlat = Math.abs(move5) < flatBound && Math.abs(move10) < flatBound;

    // Lockout release — position-based OR time-based (same as V2).
    if (longLockedSinceBar >= 0) {
      const elapsed = i - longLockedSinceBar;
      if (longPos < ZONE_EXIT_V2 || elapsed >= COOLDOWN_BARS_V2) longLockedSinceBar = -1;
    }
    if (shortLockedSinceBar >= 0) {
      const elapsed = i - shortLockedSinceBar;
      if (shortPos < ZONE_EXIT_V2 || elapsed >= COOLDOWN_BARS_V2) shortLockedSinceBar = -1;
    }

    // Streak update — increment while in zone, reset otherwise.
    longStreak  = longPos  >= ZONE_ENTER_V2 ? longStreak  + 1 : 0;
    shortStreak = shortPos >= ZONE_ENTER_V2 ? shortStreak + 1 : 0;

    const longAccepted  = longStreak  === ACCEPTANCE_BARS_V3;
    const shortAccepted = shortStreak === ACCEPTANCE_BARS_V3;

    // Body/range trigger gate. Zero-range bars score 0 → rejected.
    const barRange = high - low;
    const bodyRatio = barRange > 0 ? Math.abs(close - open) / barRange : 0;

    let firedLong = false;

    if (longLockedSinceBar < 0 && longAccepted && isBase && !isFlat) {
      let longSetup = false;
      if (longPos >= AT_EDGE_THRESHOLD) {
        longSetup = true;
      } else if (longPos >= NEAR_EDGE_THRESHOLD) {
        const pullbackMin = -PULLBACK_ATR_FRACTION * atrV;
        longSetup = move5 >= pullbackMin && move5 <= 0;
      }
      const longBarsSinceLevel = i - highIdx;
      const longStale = longPos > STALE_BREAK_THRESHOLD && longBarsSinceLevel > STALE_BARS_BACK;
      const longTrigger = close > open && bodyRatio >= BODY_RATIO_MIN_V3;
      if (longSetup && !longStale && longTrigger) {
        markers.push({
          time: barTime(bars[i]),
          position: "belowBar",
          color,
          shape: "arrowUp",
        });
        longLockedSinceBar = i;
        firedLong = true;
      }
    }

    if (!firedLong && shortLockedSinceBar < 0 && shortAccepted && isBase && !isFlat) {
      let shortSetup = false;
      if (shortPos >= AT_EDGE_THRESHOLD) {
        shortSetup = true;
      } else if (shortPos >= NEAR_EDGE_THRESHOLD) {
        const pullbackMax = PULLBACK_ATR_FRACTION * atrV;
        shortSetup = move5 >= 0 && move5 <= pullbackMax;
      }
      const shortBarsSinceLevel = i - lowIdx;
      const shortStale = shortPos > STALE_BREAK_THRESHOLD && shortBarsSinceLevel > STALE_BARS_BACK;
      const shortTrigger = close < open && bodyRatio >= BODY_RATIO_MIN_V3;
      if (shortSetup && !shortStale && shortTrigger) {
        markers.push({
          time: barTime(bars[i]),
          position: "aboveBar",
          color,
          shape: "arrowDown",
        });
        shortLockedSinceBar = i;
      }
    }
  }

  return markers;
}

// ─── Regime (trade-or-stand-aside classifier) ───────────────────────────
// A post-hoc analysis of the trader's actual fills (Dataset A / B) showed
// four useful regime tiers driven by ADX magnitude and one "no-go"
// pre-entry shape. This indicator collapses that into a per-bar decision:
//
//   1. Compute ADX(14), EMA(period), ATR(14), and the envelope of the
//      last REGIME_CHOP_LOOKBACK bars.
//   2. If ADX is in the "death zone" [REGIME_DEATH_MIN, REGIME_DEATH_MAX) →
//        STAND ASIDE (DEATH ZONE).      The clearest "don't trade" band
//        in the data — average pts/trade was negative.
//   3. Else if wide × wide chop
//        (current bar range  > REGIME_CHOP_RANGE_ATR × ATR    AND
//         last-N bars range  > REGIME_CHOP_RECENT_ATR × ATR)
//      → STAND ASIDE (CHOP).             38% SL rate in this shape.
//   4. Else if close > EMA + REGIME_EMA_BUFFER_ATR × ATR → LONG BIAS
//        elif close < EMA − REGIME_EMA_BUFFER_ATR × ATR → SHORT BIAS
//        else                                          → STAND ASIDE
//                                                         (NO DIRECTION,
//                                                          price hugging
//                                                          the EMA).
//
// Output shape: HistogramPoint[] where `value` is the ADX magnitude (so
// the pane height carries useful information — you can watch ADX climb
// into / out of the death zone visually) and `color` is the regime tier.
//
// Tunables are constants below — calibrated on the analysis data and
// intentionally kept off the IndicatorConfig surface so the panel UI
// stays single-period (the only user-facing knob is the EMA bias period).

const REGIME_ADX_PERIOD = 14;             // Wilder ADX lookback
const REGIME_ATR_PERIOD = 14;             // Wilder ATR lookback
const REGIME_CHOP_LOOKBACK = 5;            // bars in the recent envelope
const REGIME_DEATH_MIN = 22;               // ADX death-zone lower bound
const REGIME_DEATH_MAX = 30;               // ADX death-zone upper bound
const REGIME_CHOP_RANGE_ATR = 0.85;        // current bar range > this × ATR
const REGIME_CHOP_RECENT_ATR = 0.4;        // last-N envelope > this × ATR
const REGIME_EMA_BUFFER_ATR = 0.25;        // |close − EMA| must exceed this × ATR

// Public regime constants — exported so future consumers (alerting,
// strategy gates, screenshotting) can read indicator state without
// re-parsing colors.
export const REGIME_LONG = 1;
export const REGIME_SHORT = -1;
export const REGIME_ASIDE_NEUTRAL = 0;
export const REGIME_ASIDE_DEATH = -2;
export const REGIME_ASIDE_CHOP = -3;
export type RegimeState =
  | typeof REGIME_LONG
  | typeof REGIME_SHORT
  | typeof REGIME_ASIDE_NEUTRAL
  | typeof REGIME_ASIDE_DEATH
  | typeof REGIME_ASIDE_CHOP;

// Per-state bar colors. Translucent so the pane reads like volume — not
// dominating the candle pane above. Kept as `rgba(...)` strings to match
// VOLUME_UP_COLOR / VOLUME_DOWN_COLOR conventions in this file.
const REGIME_COLOR_LONG          = "rgba(34, 197, 94, 0.7)";   // emerald
const REGIME_COLOR_SHORT         = "rgba(239, 68, 68, 0.7)";   // red
const REGIME_COLOR_ASIDE_NEUTRAL = "rgba(148, 163, 184, 0.5)"; // slate-400
const REGIME_COLOR_ASIDE_DEATH   = "rgba(71, 85, 105, 0.7)";   // slate-600
const REGIME_COLOR_ASIDE_CHOP    = "rgba(245, 158, 11, 0.7)";  // amber-500

function regimeColor(state: RegimeState): string {
  switch (state) {
    case REGIME_LONG:          return REGIME_COLOR_LONG;
    case REGIME_SHORT:         return REGIME_COLOR_SHORT;
    case REGIME_ASIDE_NEUTRAL: return REGIME_COLOR_ASIDE_NEUTRAL;
    case REGIME_ASIDE_DEATH:   return REGIME_COLOR_ASIDE_DEATH;
    case REGIME_ASIDE_CHOP:    return REGIME_COLOR_ASIDE_CHOP;
  }
}

/** EMA values aligned 1-to-1 with the bars array — entries before the
 *  warmup window are NaN. Mirrors atrSeries above; we re-implement
 *  rather than calling the exported `ema()` because the `LinePoint[]`
 *  return shape is keyed by time, not index, and we need index-aligned
 *  values for the per-bar regime classification. */
export function emaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;

  // Seed: SMA of the first `period` closes — same convention as ema().
  let seed = 0;
  for (let i = 0; i < period; i++) seed += bars[i].bar_close;
  let prev = seed / period;
  out[period - 1] = prev;

  const alpha = 2 / (period + 1);
  for (let i = period; i < bars.length; i++) {
    prev = bars[i].bar_close * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** ADX values aligned 1-to-1 with bars. Same Wilder math as the public
 *  `adx()` calculator above — duplicated here to expose an index-keyed
 *  array (matches atrSeries / emaSeries). NaN before the warmup window
 *  (first valid index = 2 * period - 1, since we Wilder-smooth twice). */
export function adxSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < 2 * period + 1) return out;

  // Raw +DM / -DM / TR, each starting at index 1 of bars.
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].bar_high - bars[i - 1].bar_high;
    const downMove = bars[i - 1].bar_low - bars[i].bar_low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const pc = bars[i - 1].bar_close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder running-sum smoothing: smoothed[0] aligns with raw[period - 1].
  function wilder(series: number[]): number[] {
    const smoothed: number[] = [];
    if (series.length < period) return smoothed;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += series[i];
    smoothed.push(sum);
    for (let i = period; i < series.length; i++) {
      sum = sum - sum / period + series[i];
      smoothed.push(sum);
    }
    return smoothed;
  }

  const plusSmooth = wilder(plusDM);
  const minusSmooth = wilder(minusDM);
  const trSmooth = wilder(trs);

  // DX series, aligned with smoothed indices.
  const dx: number[] = [];
  for (let i = 0; i < trSmooth.length; i++) {
    if (trSmooth[i] === 0) {
      dx.push(0);
      continue;
    }
    const plusDI = (100 * plusSmooth[i]) / trSmooth[i];
    const minusDI = (100 * minusSmooth[i]) / trSmooth[i];
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dx.length < period) return out;

  // Wilder-smooth DX once more to get ADX.
  let adxSum = 0;
  for (let i = 0; i < period; i++) adxSum += dx[i];
  let prev = adxSum / period;
  // First ADX value belongs to bars[2*period - 1] — same alignment as
  // the public `adx()` function returns.
  out[2 * period - 1] = prev;

  for (let i = period; i < dx.length; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    // dx[i] ↔ bars[i + period]
    out[i + period] = prev;
  }
  return out;
}

/** Classify a single bar into a regime tier given pre-computed inputs.
 *  Pulled out as a pure function so the rule order stays explicit — and
 *  so the test surface is one function rather than the larger loop. */
function classifyRegime(
  close: number,
  emaVal: number,
  adxVal: number,
  atrVal: number,
  currentRange: number,
  recentRange: number,
): RegimeState {
  // Rule 2: ADX death zone wins outright — stand aside no matter what
  // direction price points. This is the highest-conviction "don't" in
  // the data set.
  if (adxVal >= REGIME_DEATH_MIN && adxVal < REGIME_DEATH_MAX) {
    return REGIME_ASIDE_DEATH;
  }
  // Rule 3: wide × wide chop. Both gates must trigger — a single wide
  // bar in an otherwise tight base is fine, and a slow-bleed wide
  // envelope without a wide current bar is also fine.
  const isWideCurrent = currentRange > REGIME_CHOP_RANGE_ATR * atrVal;
  const isWideRecent = recentRange > REGIME_CHOP_RECENT_ATR * atrVal;
  if (isWideCurrent && isWideRecent) {
    return REGIME_ASIDE_CHOP;
  }
  // Rule 4: directional bias with a small ATR buffer around the EMA so
  // the regime doesn't flap when price grazes the moving average.
  const buffer = REGIME_EMA_BUFFER_ATR * atrVal;
  if (close - emaVal > buffer) return REGIME_LONG;
  if (emaVal - close > buffer) return REGIME_SHORT;
  return REGIME_ASIDE_NEUTRAL;
}

/** Per-bar regime histogram. Value = ADX (so the pane height shows
 *  trend strength), color = regime tier. Bars before the warmup window
 *  (insufficient ADX/EMA/ATR data) are skipped — same convention as
 *  the other calculators which omit warmup points rather than emitting
 *  null/NaN. */
export function regime(
  bars: IndicatorBar[],
  emaPeriod: number,
): HistogramPoint[] {
  // Warmup is bounded by the most demanding calculation. ADX needs
  // 2 * period - 1 bars to produce its first value; ATR needs period;
  // EMA needs emaPeriod; the chop window needs REGIME_CHOP_LOOKBACK.
  const minIndex = Math.max(
    2 * REGIME_ADX_PERIOD - 1,
    REGIME_ATR_PERIOD,
    emaPeriod - 1,
    REGIME_CHOP_LOOKBACK - 1,
  );
  if (emaPeriod <= 0 || bars.length <= minIndex) return [];

  const adxArr = adxSeries(bars, REGIME_ADX_PERIOD);
  const atrArr = atrSeries(bars, REGIME_ATR_PERIOD);
  const emaArr = emaSeries(bars, emaPeriod);

  const out: HistogramPoint[] = [];
  for (let i = minIndex; i < bars.length; i++) {
    const adxVal = adxArr[i];
    const atrVal = atrArr[i];
    const emaVal = emaArr[i];
    if (!Number.isFinite(adxVal) || !Number.isFinite(atrVal) || !Number.isFinite(emaVal)) continue;
    if (atrVal <= 0) continue;

    // Recent envelope: max(High[i-N+1..i]) - min(Low[i-N+1..i]). Inclusive
    // of the current bar — matches the analysis definition of "the last
    // N bars covered > X × ATR of price space."
    let recentHigh = bars[i].bar_high;
    let recentLow = bars[i].bar_low;
    const startJ = Math.max(0, i - REGIME_CHOP_LOOKBACK + 1);
    for (let j = startJ; j < i; j++) {
      if (bars[j].bar_high > recentHigh) recentHigh = bars[j].bar_high;
      if (bars[j].bar_low < recentLow) recentLow = bars[j].bar_low;
    }
    const recentRange = recentHigh - recentLow;
    const currentRange = bars[i].bar_high - bars[i].bar_low;

    const state = classifyRegime(
      bars[i].bar_close,
      emaVal,
      adxVal,
      atrVal,
      currentRange,
      recentRange,
    );

    out.push({
      time: barTime(bars[i]),
      // Plot ADX magnitude as bar height — color carries the regime
      // decision, height carries the trend-strength magnitude. Together
      // the user sees both axes of the rule set in one pane.
      value: adxVal,
      color: regimeColor(state),
    });
  }
  return out;
}

// ─── Series helpers for the script-expression engine ────────────────────────
//
// These return number[] aligned 1-to-1 with the bars array (NaN before the
// warmup window). They mirror atrSeries/emaSeries/adxSeries above so the
// expression evaluator has a uniform shape to consume. Used exclusively by
// `precomputeIndicators` in script-expr.ts → simulator integration; the
// chart-pane indicator code keeps using the time-keyed `LinePoint[]`
// versions.

/** Simple moving average aligned 1-to-1 with bars; NaN before warmup. */
export function smaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].bar_close;
    if (i >= period) sum -= bars[i - period].bar_close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Trailing average of bar_volume over `period` bars, NaN before warmup.
 *  Used by the script DSL's `volume(n)` and `trailVol(n)` calls. */
export function volumeMaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].bar_volume;
    if (i >= period) sum -= bars[i - period].bar_volume;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Sample standard deviation of close-to-close log returns over `period`
 *  bars, NaN before warmup. Used by the DSL's `stdev(n)` call. We use
 *  log returns (not raw price diffs) so the magnitude is comparable
 *  across instruments at different price levels. */
export function stdevReturnsSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period + 1) return out;
  // Log returns; rets[i] corresponds to bars[i+1].
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].bar_close;
    const cur = bars[i].bar_close;
    if (prev > 0 && cur > 0) {
      rets.push(Math.log(cur / prev));
    } else {
      rets.push(0);
    }
  }
  // Rolling sample-stdev over `period` returns. Sample variance uses
  // (n-1) in the denominator — Bessel's correction. The first valid
  // bars-index is `period` because we need `period` returns and the
  // first return belongs to bars[1].
  for (let i = period; i < bars.length; i++) {
    const start = i - period; // index into rets[]
    let mean = 0;
    for (let j = start; j < start + period; j++) mean += rets[j];
    mean /= period;
    let variance = 0;
    for (let j = start; j < start + period; j++) {
      const d = rets[j] - mean;
      variance += d * d;
    }
    variance /= period - 1;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

// ─── Extended indicator library (DSL-only, index-aligned `*Series`) ────────
//
// All helpers below return number[] aligned 1-to-1 with bars (NaN before the
// warmup window). They power the script-DSL expression engine via
// `computeIndicatorSeries` in script-expr.ts. Pure functions, no shared
// state — same conventions as the existing helpers above.

// ─── Moving averages ────────────────────────────────────────────────────────

/** Weighted moving average — linear weights 1..N over the trailing
 *  `period` closes. Heavier weights on recent bars; denominator is the
 *  triangular sum N*(N+1)/2. NaN before index `period - 1`. */
export function wmaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < bars.length; i++) {
    let weighted = 0;
    for (let k = 0; k < period; k++) {
      const w = period - k;
      weighted += bars[i - k].bar_close * w;
    }
    out[i] = weighted / denom;
  }
  return out;
}

/** Hull MA: WMA(2*WMA(p/2) - WMA(p), sqrt(p)). Less laggy than EMA at the
 *  cost of a longer warmup — first valid index is `period - 1 + sqrt`. */
export function hmaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const half = Math.max(1, Math.floor(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  const wmaHalf = wmaSeries(bars, half);
  const wmaFull = wmaSeries(bars, period);
  // Synthesize a "bars" series whose close = 2*wmaHalf - wmaFull, then run
  // a WMA(sqrt) over it. We can't reuse wmaSeries directly because it
  // reads from bar_close, so we inline the rolling weighted-sum here.
  const denom = (sqrtP * (sqrtP + 1)) / 2;
  for (let i = sqrtP - 1; i < bars.length; i++) {
    let weighted = 0;
    let valid = true;
    for (let k = 0; k < sqrtP; k++) {
      const idx = i - k;
      const a = wmaHalf[idx];
      const b = wmaFull[idx];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        valid = false;
        break;
      }
      const synth = 2 * a - b;
      weighted += synth * (sqrtP - k);
    }
    if (valid) out[i] = weighted / denom;
  }
  return out;
}

/** Helper — run an EMA over an arbitrary input series (not bar_close).
 *  Used by chained EMAs (DEMA / TEMA / TRIX / MACD signal). Seeds with a
 *  simple mean of the first `period` finite values; NaN until that seed
 *  is valid. */
function emaOfSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  // Find the first index where we have `period` consecutive finite values
  // ending at that index. Simpler: seed at the first index `i` such that
  // values[i - period + 1 .. i] are all finite.
  let seedAt = -1;
  for (let i = period - 1; i < values.length; i++) {
    let ok = true;
    for (let k = 0; k < period; k++) {
      if (!Number.isFinite(values[i - k])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      seedAt = i;
      break;
    }
  }
  if (seedAt < 0) return out;
  let sum = 0;
  for (let k = 0; k < period; k++) sum += values[seedAt - k];
  let prev = sum / period;
  out[seedAt] = prev;
  const alpha = 2 / (period + 1);
  for (let i = seedAt + 1; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      // Hold last EMA on missing input; this matches how chained EMAs
      // (TRIX) are computed in pandas-ta.
      out[i] = prev;
      continue;
    }
    prev = v * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** Double Exponential MA = 2*EMA - EMA(EMA). Reduces lag without the
 *  smoothing penalty of a longer plain EMA. */
export function demaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const e1 = emaSeries(bars, period);
  const e2 = emaOfSeries(e1, period);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(e1[i]) && Number.isFinite(e2[i])) {
      out[i] = 2 * e1[i] - e2[i];
    }
  }
  return out;
}

/** Triple Exponential MA = 3*EMA - 3*EMA(EMA) + EMA(EMA(EMA)). */
export function temaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const e1 = emaSeries(bars, period);
  const e2 = emaOfSeries(e1, period);
  const e3 = emaOfSeries(e2, period);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(e1[i]) && Number.isFinite(e2[i]) && Number.isFinite(e3[i])) {
      out[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
    }
  }
  return out;
}

/** Volume-weighted moving average over `period` bars. */
export function vwmaSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  let pvSum = 0;
  let vSum = 0;
  for (let i = 0; i < bars.length; i++) {
    pvSum += bars[i].bar_close * bars[i].bar_volume;
    vSum += bars[i].bar_volume;
    if (i >= period) {
      pvSum -= bars[i - period].bar_close * bars[i - period].bar_volume;
      vSum -= bars[i - period].bar_volume;
    }
    if (i >= period - 1 && vSum > 0) out[i] = pvSum / vSum;
  }
  return out;
}

// ─── Momentum / oscillators ────────────────────────────────────────────────

/** Wilder Relative Strength Index over `period` bars. RSI = 100 -
 *  100/(1+RS), RS = avgGain / avgLoss with Wilder smoothing. NaN before
 *  index `period`. */
export function rsiSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period + 1) return out;
  // Seed = simple mean of first `period` gains/losses (returns at indices
  // 1..period). Then Wilder smoothing for subsequent bars.
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = bars[i].bar_close - bars[i - 1].bar_close;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < bars.length; i++) {
    const diff = bars[i].bar_close - bars[i - 1].bar_close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Rate of Change as a percentage: 100 * (close[i] - close[i-period]) /
 *  close[i-period]. NaN before index `period`. */
export function rocSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length <= period) return out;
  for (let i = period; i < bars.length; i++) {
    const prev = bars[i - period].bar_close;
    if (prev !== 0) out[i] = (100 * (bars[i].bar_close - prev)) / prev;
  }
  return out;
}

/** Raw momentum: close[i] - close[i-period]. */
export function momSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length <= period) return out;
  for (let i = period; i < bars.length; i++) {
    out[i] = bars[i].bar_close - bars[i - period].bar_close;
  }
  return out;
}

/** Commodity Channel Index over `period` bars. TP = (h+l+c)/3,
 *  CCI = (TP - SMA(TP, period)) / (0.015 * mean_dev(TP, period)). */
export function cciSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const tp: number[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    tp[i] = (bars[i].bar_high + bars[i].bar_low + bars[i].bar_close) / 3;
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tp[i];
  for (let i = period - 1; i < bars.length; i++) {
    if (i >= period) sum += tp[i] - tp[i - period];
    const mean = sum / period;
    let mad = 0;
    for (let k = 0; k < period; k++) mad += Math.abs(tp[i - k] - mean);
    mad /= period;
    out[i] = mad === 0 ? 0 : (tp[i] - mean) / (0.015 * mad);
  }
  return out;
}

/** Williams %R over `period` bars. WR = -100 * (HHV - close) /
 *  (HHV - LLV). Range [-100, 0]. */
export function williamsRSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = 0; k < period; k++) {
      if (bars[i - k].bar_high > hh) hh = bars[i - k].bar_high;
      if (bars[i - k].bar_low < ll) ll = bars[i - k].bar_low;
    }
    const span = hh - ll;
    out[i] = span === 0 ? 0 : (-100 * (hh - bars[i].bar_close)) / span;
  }
  return out;
}

/** TRIX — 1-bar %ROC of the triple-smoothed EMA of log-close. Standard
 *  signed momentum oscillator that filters out high-frequency noise. */
export function trixSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  // Triple EMA of log(close).
  const logClose: number[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].bar_close;
    logClose[i] = c > 0 ? Math.log(c) : NaN;
  }
  const e1 = emaOfSeries(logClose, period);
  const e2 = emaOfSeries(e1, period);
  const e3 = emaOfSeries(e2, period);
  for (let i = 1; i < bars.length; i++) {
    const cur = e3[i];
    const prev = e3[i - 1];
    if (Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0) {
      out[i] = 100 * (cur - prev) / Math.abs(prev);
    }
  }
  return out;
}

/** Money Flow Index — RSI applied to typical-price × volume (signed by
 *  whether TP rose or fell vs the prior bar). Range [0, 100]. */
export function mfiSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period + 1) return out;
  const tp: number[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    tp[i] = (bars[i].bar_high + bars[i].bar_low + bars[i].bar_close) / 3;
  }
  // Signed money flow per bar (i >= 1).
  const posMF: number[] = new Array(bars.length).fill(0);
  const negMF: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const flow = tp[i] * bars[i].bar_volume;
    if (tp[i] > tp[i - 1]) posMF[i] = flow;
    else if (tp[i] < tp[i - 1]) negMF[i] = flow;
  }
  // Rolling sum over `period` bars (window i-period+1 .. i, inclusive).
  let pos = 0;
  let neg = 0;
  for (let i = 1; i <= period; i++) {
    pos += posMF[i];
    neg += negMF[i];
  }
  out[period] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  for (let i = period + 1; i < bars.length; i++) {
    pos += posMF[i] - posMF[i - period];
    neg += negMF[i] - negMF[i - period];
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// ─── MACD family ────────────────────────────────────────────────────────────

/** MACD line: EMA(fast) - EMA(slow). Standard (12, 26). */
export function macdLineSeries(
  bars: IndicatorBar[],
  fast: number,
  slow: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (fast <= 0 || slow <= 0 || bars.length < Math.max(fast, slow)) return out;
  const eFast = emaSeries(bars, fast);
  const eSlow = emaSeries(bars, slow);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(eFast[i]) && Number.isFinite(eSlow[i])) {
      out[i] = eFast[i] - eSlow[i];
    }
  }
  return out;
}

/** MACD signal line: EMA(signal) of the MACD line. */
export function macdSignalSeries(
  bars: IndicatorBar[],
  fast: number,
  slow: number,
  signal: number
): number[] {
  const line = macdLineSeries(bars, fast, slow);
  return emaOfSeries(line, signal);
}

/** MACD histogram = line - signal. */
export function macdHistSeries(
  bars: IndicatorBar[],
  fast: number,
  slow: number,
  signal: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  const line = macdLineSeries(bars, fast, slow);
  const sig = emaOfSeries(line, signal);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(line[i]) && Number.isFinite(sig[i])) {
      out[i] = line[i] - sig[i];
    }
  }
  return out;
}

// ─── Bollinger Bands ────────────────────────────────────────────────────────
//
// Uses population stdev of CLOSE PRICES (not log returns) over the SMA
// window — standard Bollinger convention, distinct from `stdevReturnsSeries`
// which uses log returns. Hand-rolled here so the rolling sum stays O(1)
// per bar.

function rollingClosePopStdev(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let mean = 0;
    for (let k = 0; k < period; k++) mean += bars[i - k].bar_close;
    mean /= period;
    let variance = 0;
    for (let k = 0; k < period; k++) {
      const d = bars[i - k].bar_close - mean;
      variance += d * d;
    }
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

/** Bollinger middle band — SMA(close, period). */
export function bbMidSeries(bars: IndicatorBar[], period: number): number[] {
  return smaSeries(bars, period);
}

/** Bollinger upper band — mid + mult * popStdev(close). */
export function bbUpperSeries(
  bars: IndicatorBar[],
  period: number,
  mult: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const mid = smaSeries(bars, period);
  const sd = rollingClosePopStdev(bars, period);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(mid[i]) && Number.isFinite(sd[i])) {
      out[i] = mid[i] + mult * sd[i];
    }
  }
  return out;
}

/** Bollinger lower band — mid - mult * popStdev(close). */
export function bbLowerSeries(
  bars: IndicatorBar[],
  period: number,
  mult: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const mid = smaSeries(bars, period);
  const sd = rollingClosePopStdev(bars, period);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(mid[i]) && Number.isFinite(sd[i])) {
      out[i] = mid[i] - mult * sd[i];
    }
  }
  return out;
}

/** Bollinger bandwidth — (upper - lower) / mid. Useful as a volatility
 *  regime gauge: low bandwidth = squeeze, high = expansion. */
export function bbWidthSeries(
  bars: IndicatorBar[],
  period: number,
  mult: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const mid = smaSeries(bars, period);
  const sd = rollingClosePopStdev(bars, period);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(mid[i]) && Number.isFinite(sd[i]) && mid[i] !== 0) {
      out[i] = (2 * mult * sd[i]) / mid[i];
    }
  }
  return out;
}

/** Bollinger %B — (close - lower) / (upper - lower). 0 = at lower band,
 *  1 = at upper, > 1 = above upper, < 0 = below lower. */
export function bbPercentSeries(
  bars: IndicatorBar[],
  period: number,
  mult: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const mid = smaSeries(bars, period);
  const sd = rollingClosePopStdev(bars, period);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(mid[i]) && Number.isFinite(sd[i])) {
      const span = 2 * mult * sd[i];
      if (span > 0) {
        const lower = mid[i] - mult * sd[i];
        out[i] = (bars[i].bar_close - lower) / span;
      }
    }
  }
  return out;
}

// ─── Stochastic ─────────────────────────────────────────────────────────────

/** Fast Stochastic %K over `period` bars. K = 100 * (close - LLV) /
 *  (HHV - LLV). Range [0, 100]. */
export function stochKSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = 0; k < period; k++) {
      if (bars[i - k].bar_high > hh) hh = bars[i - k].bar_high;
      if (bars[i - k].bar_low < ll) ll = bars[i - k].bar_low;
    }
    const span = hh - ll;
    out[i] = span === 0 ? 50 : (100 * (bars[i].bar_close - ll)) / span;
  }
  return out;
}

/** Generic SMA over an arbitrary number[] series. Used by stochDSeries
 *  to smooth %K. NaN propagates: any NaN inside the window invalidates
 *  that output. */
function smaOfSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < period; k++) {
      const v = values[i - k];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

/** Slow Stochastic %D — SMA of SMA(K, smoothK), smoothD. With smoothK=3
 *  and smoothD=3 this is the canonical "slow stochastic %D". */
export function stochDSeries(
  bars: IndicatorBar[],
  period: number,
  smoothK: number,
  smoothD: number
): number[] {
  const k = stochKSeries(bars, period);
  const slowK = smaOfSeries(k, smoothK);
  return smaOfSeries(slowK, smoothD);
}

// ─── Donchian channels ─────────────────────────────────────────────────────

/** Donchian upper — rolling highest high over `period` bars (current
 *  bar inclusive). */
export function donchianUpperSeries(
  bars: IndicatorBar[],
  period: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    for (let k = 0; k < period; k++) {
      if (bars[i - k].bar_high > hh) hh = bars[i - k].bar_high;
    }
    out[i] = hh;
  }
  return out;
}

/** Donchian lower — rolling lowest low. */
export function donchianLowerSeries(
  bars: IndicatorBar[],
  period: number
): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let ll = Infinity;
    for (let k = 0; k < period; k++) {
      if (bars[i - k].bar_low < ll) ll = bars[i - k].bar_low;
    }
    out[i] = ll;
  }
  return out;
}

/** Donchian midline — (upper + lower) / 2. */
export function donchianMidSeries(
  bars: IndicatorBar[],
  period: number
): number[] {
  const upper = donchianUpperSeries(bars, period);
  const lower = donchianLowerSeries(bars, period);
  const out = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(upper[i]) && Number.isFinite(lower[i])) {
      out[i] = (upper[i] + lower[i]) / 2;
    }
  }
  return out;
}

// ─── Volatility ────────────────────────────────────────────────────────────

/** True Range per bar — max(h-l, |h-prevC|, |l-prevC|). Index 0 is NaN
 *  (no previous close). Useful as a raw volatility input or filter. */
export function trSeries(bars: IndicatorBar[]): number[] {
  const out = new Array(bars.length).fill(NaN);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const pc = bars[i - 1].bar_close;
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/** Normalized ATR — 100 * ATR / close. Volatility expressed as a percent
 *  of price; comparable across instruments at different price levels. */
export function natrSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period + 1) return out;
  const a = atrSeries(bars, period);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].bar_close;
    if (Number.isFinite(a[i]) && c > 0) out[i] = (100 * a[i]) / c;
  }
  return out;
}

/** Historical volatility — un-annualized sample stdev of log returns.
 *  Same convention as `stdevReturnsSeries`; users multiply by sqrt(252)
 *  (or the relevant bar-to-year factor) to annualize if desired. */
export function hvSeries(bars: IndicatorBar[], period: number): number[] {
  return stdevReturnsSeries(bars, period);
}

// ─── Volume / cumulative ───────────────────────────────────────────────────

/** On-Balance Volume — running cumulative volume signed by close vs
 *  prior close. Index 0 = 0 (canonical seed). */
export function obvSeries(bars: IndicatorBar[]): number[] {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i].bar_close;
    const prev = bars[i - 1].bar_close;
    if (cur > prev) out[i] = out[i - 1] + bars[i].bar_volume;
    else if (cur < prev) out[i] = out[i - 1] - bars[i].bar_volume;
    else out[i] = out[i - 1];
  }
  return out;
}

/** Accumulation/Distribution line — running cumulative of money-flow
 *  multiplier × volume. MFM = ((c-l) - (h-c)) / (h-l). */
export function adSeries(bars: IndicatorBar[]): number[] {
  const out = new Array(bars.length).fill(NaN);
  let cum = 0;
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const c = bars[i].bar_close;
    const span = h - l;
    const mfm = span === 0 ? 0 : ((c - l) - (h - c)) / span;
    cum += mfm * bars[i].bar_volume;
    out[i] = cum;
  }
  return out;
}

/** Chaikin Money Flow over `period` bars. CMF = sum(MFM * vol) /
 *  sum(vol). Range [-1, 1]; positive = buying pressure. */
export function cmfSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  const mfv: number[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const c = bars[i].bar_close;
    const span = h - l;
    const mfm = span === 0 ? 0 : ((c - l) - (h - c)) / span;
    mfv[i] = mfm * bars[i].bar_volume;
  }
  let mfvSum = 0;
  let vSum = 0;
  for (let i = 0; i < bars.length; i++) {
    mfvSum += mfv[i];
    vSum += bars[i].bar_volume;
    if (i >= period) {
      mfvSum -= mfv[i - period];
      vSum -= bars[i - period].bar_volume;
    }
    if (i >= period - 1 && vSum > 0) out[i] = mfvSum / vSum;
  }
  return out;
}

// ─── Lookback scalars ──────────────────────────────────────────────────────

/** Highest high over the last `period` bars (current bar inclusive). */
export function hhvSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    for (let k = 0; k < period; k++) {
      if (bars[i - k].bar_high > hh) hh = bars[i - k].bar_high;
    }
    out[i] = hh;
  }
  return out;
}

/** Lowest low over the last `period` bars (current bar inclusive). */
export function llvSeries(bars: IndicatorBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let ll = Infinity;
    for (let k = 0; k < period; k++) {
      if (bars[i - k].bar_low < ll) ll = bars[i - k].bar_low;
    }
    out[i] = ll;
  }
  return out;
}

/** close[i - n] — close price `n` bars before the current bar.
 *  closeNSeries(_, 1) is the previous bar's close. NaN when i < n. */
export function closeNSeries(bars: IndicatorBar[], n: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (n < 0) return out;
  for (let i = n; i < bars.length; i++) out[i] = bars[i - n].bar_close;
  return out;
}

/** high[i - n]. */
export function highNSeries(bars: IndicatorBar[], n: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (n < 0) return out;
  for (let i = n; i < bars.length; i++) out[i] = bars[i - n].bar_high;
  return out;
}

/** low[i - n]. */
export function lowNSeries(bars: IndicatorBar[], n: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (n < 0) return out;
  for (let i = n; i < bars.length; i++) out[i] = bars[i - n].bar_low;
  return out;
}

/** open[i - n]. */
export function openNSeries(bars: IndicatorBar[], n: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (n < 0) return out;
  for (let i = n; i < bars.length; i++) out[i] = bars[i - n].bar_open;
  return out;
}

/** volume[i - n]. */
export function volumeNSeries(bars: IndicatorBar[], n: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (n < 0) return out;
  for (let i = n; i < bars.length; i++) out[i] = bars[i - n].bar_volume;
  return out;
}
