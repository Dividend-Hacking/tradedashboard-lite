/**
 * tick-indicators.ts — Tick-resolution indicator math for the backtest DSL.
 *
 * Where the helpers in `calculations.ts` operate on aggregated bars (OHLCV +
 * optional bid/ask volume), the helpers here consume the raw `ParsedTicks`
 * stream plus a per-bar `tickRanges` map (built by
 * `aggregateTicksWithRanges` in `tick-aggregation.ts`). That gives us
 * per-trade resolution for indicators that genuinely need it:
 *
 *   - Volume profile metrics (POC, VAH, VAL, value-area width) over a
 *     rolling N-bar window. A bar's OHLC collapses hundreds of trades
 *     into one row, so projecting a profile from bars would have to
 *     spread volume across the high–low range — strictly worse than
 *     walking the raw ticks.
 *   - True bid/ask trade COUNTS (not just volume) — a bar carries
 *     bid/ask volume sums, but never the trade count.
 *   - Tick-resolution VWAP, mean trade size, large-trade detection.
 *
 * Design conventions (mirror `calculations.ts`):
 *   - Each helper returns `number[]` aligned 1-to-1 with bars (NaN for
 *     bars whose rolling window can't be filled). The DSL evaluator
 *     looks up `series[barIndex]` exactly like for bar indicators.
 *   - Callers must supply `tickRanges` of length `2 * bars.length`,
 *     packed `[start0, end0, start1, end1, ...]` (half-open). When
 *     `tickRanges` is missing or shorter than expected, we return
 *     all-NaN — order-flow indicators on a plain `ohlcv` session
 *     should degrade cleanly without throwing.
 *   - Volume profile reuses `computeVolumeProfile` so the value-area
 *     algorithm matches what the chart overlay renders.
 *   - Bucket size for profile metrics: caller-supplied or auto-derived
 *     via `defaultBucketSize` (range/100 fallback used by the chart).
 */

import type { ParsedTicks } from "@/lib/utils/tick-aggregation";
import {
  computeVolumeProfile,
  type VolumeProfile,
} from "@/lib/utils/volume-profile";

/** Tick context threaded through `precomputeIndicators` for tick-driven
 *  indicators. `barTickRanges` is the packed `[start, end)` array
 *  produced by `aggregateTicksWithRanges`; index `i` of the bar array
 *  maps to `[barTickRanges[2*i], barTickRanges[2*i + 1])` in `ticks`. */
export interface TickContext {
  ticks: ParsedTicks;
  barTickRanges: Int32Array;
}

/** Heuristic bucket size for volume-profile indicators when the caller
 *  doesn't override. Walks the tick subset's price range and divides by
 *  100 — the same default the chart overlay uses. Min-clamps to a tiny
 *  positive number so a flat-range window doesn't blow up.
 *
 *  We don't try to infer the instrument's true tick size here — that's
 *  carried in `rules.ticksPerPoint` and could be threaded through a
 *  future `TickContext.tickSize` field. For DSL purposes a 100-bucket
 *  histogram is plenty for POC/VAH/VAL queries; users tracking very
 *  thin levels can pass an explicit bucket size once the DSL surfaces
 *  named args. */
function defaultBucketSize(
  ticks: ParsedTicks,
  startIdx: number,
  endIdx: number,
): number {
  if (endIdx <= startIdx) return 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = startIdx; i < endIdx; i++) {
    const p = ticks.prices[i];
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  const span = hi - lo;
  if (!isFinite(span) || span <= 0) return 1;
  return Math.max(span / 100, 1e-9);
}

/** Window helper — given a bar index `i` and a window size `N`, return
 *  `[startTick, endTick)` covering the union of the last `N` bars'
 *  ticks. Returns null when the window can't be filled (i < N - 1) or
 *  when `barTickRanges` is missing / malformed. */
function windowTickRange(
  i: number,
  windowBars: number,
  barTickRanges: Int32Array,
): { start: number; end: number } | null {
  if (windowBars <= 0) return null;
  const firstBar = i - windowBars + 1;
  if (firstBar < 0) return null;
  const startSlot = firstBar * 2;
  const endSlot = i * 2 + 1;
  if (endSlot >= barTickRanges.length) return null;
  const start = barTickRanges[startSlot];
  const end = barTickRanges[endSlot];
  if (end <= start) return null;
  return { start, end };
}

/** Build a rolling-window VolumeProfile cache. Profile metrics POC, VAH,
 *  VAL share the same profile build for the same window length, so we
 *  compute once per bar and pull the metric we want from the result.
 *
 *  Callers pass `(barCount, ctx, windowBars)` — the cache is keyed by
 *  bar index, indices < `windowBars - 1` get null entries. The caller
 *  iterates and copies the required metric into a number[] series.
 *
 *  Performance: O(barCount × windowBars × ticksPerBar). For a 5-day NQ
 *  session with 5k bars, 20-bar window, ~1k ticks/bar that's ~100M
 *  Map operations inside `computeVolumeProfile` — borderline. We keep
 *  the build single-pass and rely on the JIT; if this shows up as a
 *  bottleneck, we can swap to a streaming bucket-update structure
 *  (add new bar's bins, subtract dropped bar's bins) keyed on
 *  bar-level bid/ask histograms.
 */
function buildProfileCache(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  valueAreaPct: number,
): Array<VolumeProfile | null> {
  const out: Array<VolumeProfile | null> = new Array(barCount).fill(null);
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    const bucketSize = defaultBucketSize(ctx.ticks, range.start, range.end);
    const profile = computeVolumeProfile(ctx.ticks, {
      bucketSize,
      valueAreaPct,
      // The volume-profile module's startMs/endMs filter operates on
      // tick TIMESTAMPS — not indices. To honor our index range without
      // re-scanning, we let the underlying loop walk every tick but only
      // those inside our index window will count. A future micro-opt:
      // add a `startIdx` / `endIdx` option to `computeVolumeProfile` so
      // we don't pay the timestamp comparison on every tick.
      startMs: ctx.ticks.times[range.start],
      endMs:
        range.end < ctx.ticks.count
          ? ctx.ticks.times[range.end]
          : Number.POSITIVE_INFINITY,
    });
    out[i] = profile;
  }
  return out;
}

/** Per-zone profile cache keyed by `(windowBars, valueAreaPct)` so
 *  POC(20), VAH(20), VAL(20) in the same script all share one build.
 *  Built lazily as `computeIndicatorSeries` calls request profiles
 *  per zone; the precompute layer above already caches the resulting
 *  number[] series so this object is short-lived (one zone's worth). */
export class ProfileCache {
  private map = new Map<string, Array<VolumeProfile | null>>();

  constructor(
    private readonly barCount: number,
    private readonly ctx: TickContext,
  ) {}

  get(windowBars: number, valueAreaPct: number): Array<VolumeProfile | null> {
    const key = `${windowBars}:${valueAreaPct}`;
    let cached = this.map.get(key);
    if (!cached) {
      cached = buildProfileCache(
        this.barCount,
        this.ctx,
        windowBars,
        valueAreaPct,
      );
      this.map.set(key, cached);
    }
    return cached;
  }
}

/** Point-of-control series for a rolling N-bar window. NaN until N bars
 *  worth of ticks are available. */
export function pocSeries(
  barCount: number,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(barCount).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < barCount; i++) {
    const p = profiles[i];
    if (p && p.poc != null) out[i] = p.poc;
  }
  return out;
}

/** Value-area-high series for a rolling N-bar window. */
export function vahSeries(
  barCount: number,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(barCount).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < barCount; i++) {
    const p = profiles[i];
    if (p && p.vah != null) out[i] = p.vah;
  }
  return out;
}

/** Value-area-low series for a rolling N-bar window. */
export function valSeries(
  barCount: number,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(barCount).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < barCount; i++) {
    const p = profiles[i];
    if (p && p.val != null) out[i] = p.val;
  }
  return out;
}

/** Value-area width series — VAH − VAL over the rolling window. Useful
 *  as a microstructure regime gauge (compressed value area = balance,
 *  wide = trend transition). */
export function vaWidthSeries(
  barCount: number,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(barCount).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < barCount; i++) {
    const p = profiles[i];
    if (p && p.vah != null && p.val != null) out[i] = p.vah - p.val;
  }
  return out;
}

/** Distance from current close to the rolling-window POC, normalized by
 *  close (`(close − POC) / close`). Sign flips around the POC: positive
 *  = price above the high-volume node, negative = below. NaN until both
 *  the window fills AND the bar carries a finite close. The bars[] is
 *  used only for the close lookup — same array passed to the bar-level
 *  series. */
export function distToPocSeries(
  bars: ReadonlyArray<{ bar_close: number }>,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(bars.length).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < bars.length; i++) {
    const p = profiles[i];
    const c = bars[i].bar_close;
    if (p && p.poc != null && c !== 0 && Number.isFinite(c)) {
      out[i] = (c - p.poc) / c;
    }
  }
  return out;
}

/** Count of trades over the last N bars whose aggressor was the bid
 *  side (sell-aggressor). NaN until the window fills. */
export function tradesAtBidSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  return tickWindowCount(barCount, ctx, windowBars, 1);
}

/** Count of trades over the last N bars whose aggressor was the ask
 *  side (buy-aggressor). */
export function tradesAtAskSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  return tickWindowCount(barCount, ctx, windowBars, 2);
}

/** Tick imbalance — `(askCount − bidCount) / totalCount` over the last
 *  N bars. Range [−1, 1]. Mirrors the bar-level `delta_ratio` but at
 *  trade-count resolution. */
export function tickImbalanceSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let bid = 0;
    let ask = 0;
    for (let k = range.start; k < range.end; k++) {
      const s = ctx.ticks.sides[k];
      if (s === 1) bid++;
      else if (s === 2) ask++;
    }
    const total = bid + ask;
    if (total > 0) out[i] = (ask - bid) / total;
  }
  return out;
}

/** Total tick count over the last N bars. Useful as a microstructure
 *  regime gauge (high tick count → fast / chaotic market). */
export function tickCountSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    out[i] = range.end - range.start;
  }
  return out;
}

/** Mean trade size over the last N bars. */
export function meanTradeSizeSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let sum = 0;
    for (let k = range.start; k < range.end; k++) sum += ctx.ticks.sizes[k];
    const n = range.end - range.start;
    if (n > 0) out[i] = sum / n;
  }
  return out;
}

/** Count of trades with size >= `threshold` over the last N bars. The
 *  cutoff is an absolute size (contracts). Used to detect block / sweep
 *  prints without having to set the threshold per instrument — users
 *  pass the integer cutoff appropriate for their market. */
export function largeTradeCountSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  threshold: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!Number.isFinite(threshold) || threshold <= 0) return out;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let count = 0;
    for (let k = range.start; k < range.end; k++) {
      if (ctx.ticks.sizes[k] >= threshold) count++;
    }
    out[i] = count;
  }
  return out;
}

/** True VWAP from raw ticks over the last N bars — `Σ(price * size) /
 *  Σ(size)`. Distinct from the bar-aggregated `VWAP(N)` because the
 *  weighting uses every trade rather than a per-bar OHLCV summary. */
export function vwapTickSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let pv = 0;
    let v = 0;
    for (let k = range.start; k < range.end; k++) {
      const sz = ctx.ticks.sizes[k];
      pv += ctx.ticks.prices[k] * sz;
      v += sz;
    }
    if (v > 0) out[i] = pv / v;
  }
  return out;
}

/** Internal helper — count ticks over the last N bars whose `sides[]`
 *  byte equals `wanted` (1=bid, 2=ask). NaN until window fills. */
function tickWindowCount(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  wanted: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let count = 0;
    for (let k = range.start; k < range.end; k++) {
      if (ctx.ticks.sides[k] === wanted) count++;
    }
    out[i] = count;
  }
  return out;
}
