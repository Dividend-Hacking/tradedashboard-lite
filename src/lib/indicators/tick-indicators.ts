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

// ─── Top-of-book quote indicators ──────────────────────────────────────────
//
// These read from the optional `bestBids`/`bestAsks`/`bestBidSizes`/
// `bestAskSizes` typed arrays added in the v2 tick CSV schema. They
// degrade cleanly when those arrays are absent or sparse: the
// `hasQuotes` flag short-circuits to all-NaN, and individual ticks
// missing quote data are skipped from the per-window aggregate rather
// than poisoning it with NaN.
//
// All five indicators share the same shape: per-bar window of ticks,
// accumulate over ticks that have meaningful quote data (bid > 0 AND
// ask > 0 — sizes are allowed to be 0 except where size weighting is
// required), then divide.

/** Mean bid-ask spread over the last N bars, computed per tick as
 *  `best_ask − best_bid` and averaged across ticks in the window.
 *  Returns NaN for bars whose window has no quote-bearing ticks, or
 *  when the session predates the v2 quote columns. */
export function meanSpreadSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const bb = ctx.ticks.bestBids;
  const ba = ctx.ticks.bestAsks;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let sum = 0;
    let n = 0;
    for (let k = range.start; k < range.end; k++) {
      const b = bb[k];
      const a = ba[k];
      if (b > 0 && a > 0) {
        sum += a - b;
        n++;
      }
    }
    if (n > 0) out[i] = sum / n;
  }
  return out;
}

/** Mean best-bid size over the last N bars. Skips ticks that have no
 *  observed bid quote. Useful to spot thinning vs. stacked bids. */
export function bidSizeSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const sz = ctx.ticks.bestBidSizes;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let sum = 0;
    let n = 0;
    for (let k = range.start; k < range.end; k++) {
      const s = sz[k];
      if (s > 0) {
        sum += s;
        n++;
      }
    }
    if (n > 0) out[i] = sum / n;
  }
  return out;
}

/** Mean best-ask size over the last N bars. */
export function askSizeSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const sz = ctx.ticks.bestAskSizes;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let sum = 0;
    let n = 0;
    for (let k = range.start; k < range.end; k++) {
      const s = sz[k];
      if (s > 0) {
        sum += s;
        n++;
      }
    }
    if (n > 0) out[i] = sum / n;
  }
  return out;
}

/** Resting-liquidity imbalance — `(ΣaskSize − ΣbidSize) / (ΣaskSize +
 *  ΣbidSize)` over the last N bars. Range [−1, 1]. Mirrors
 *  `tickImbalanceSeries` (which is about aggressor counts) but reflects
 *  the side that's stacked at the inside quote:
 *    positive → more offers resting (sellers willing to wait)
 *    negative → more bids resting (buyers willing to wait)
 *
 *  We sum sizes before dividing (rather than averaging per-tick ratios)
 *  so a few ticks with large size aren't underweighted by ticks with
 *  small size. */
export function quoteImbalanceSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const bs = ctx.ticks.bestBidSizes;
  const as_ = ctx.ticks.bestAskSizes;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let bidSum = 0;
    let askSum = 0;
    for (let k = range.start; k < range.end; k++) {
      bidSum += bs[k];
      askSum += as_[k];
    }
    const total = bidSum + askSum;
    if (total > 0) out[i] = (askSum - bidSum) / total;
  }
  return out;
}

/** Microprice — size-weighted mid quote, averaged over ticks in the
 *  last N bars. Per-tick formula:
 *    `(bid * askSize + ask * bidSize) / (bidSize + askSize)`
 *  i.e. the price tilts toward the side with LESS resting size, since
 *  that side will move next. A widely-used short-term fair-value proxy
 *  that often beats the simple mid for prediction.
 *
 *  We average the per-tick microprice (rather than computing once on
 *  summed sizes) because each tick's microprice is itself a valid
 *  fair-value estimate at that instant; the simple mean weights each
 *  observation equally. */
export function micropriceSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const bb = ctx.ticks.bestBids;
  const ba = ctx.ticks.bestAsks;
  const bs = ctx.ticks.bestBidSizes;
  const as_ = ctx.ticks.bestAskSizes;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let sum = 0;
    let n = 0;
    for (let k = range.start; k < range.end; k++) {
      const b = bb[k];
      const a = ba[k];
      const bSz = bs[k];
      const aSz = as_[k];
      const total = bSz + aSz;
      if (b > 0 && a > 0 && total > 0) {
        sum += (b * aSz + a * bSz) / total;
        n++;
      }
    }
    if (n > 0) out[i] = sum / n;
  }
  return out;
}

// ─── HVN / LVN nearest-node distances ──────────────────────────────────────
//
// `POC`, `VAH`, `VAL` collapse the whole profile to a single scalar each —
// but a multi-modal distribution can have several distinct high-volume
// nodes (HVN — local maxima in the bucket volume distribution) and
// liquidity gaps (LVN — local minima). Those nodes are the natural
// magnets / breakout markers for auction-style strategies.
//
// We find local extrema by walking `profile.levels` (already sorted
// ascending by price) and looking for strict local max/min relative to
// the immediate neighbors. To filter noise we require:
//   - HVN volume >= HVN_FRAC * maxLevelVolume   (at least half the POC's volume)
//   - LVN volume <= LVN_FRAC * maxLevelVolume   (at most half the POC's volume)
// AND for LVNs only: the node is NOT on the profile boundary, since the
// edges of the distribution naturally taper toward zero and would
// trigger false "valley" matches.
//
// Both functions return the SIGNED normalized distance from current
// close to the nearest qualifying node — positive = node is above
// price, negative = below — mirroring `dist_to_POC` so the DSL surface
// stays consistent.

/** Fraction of POC volume required for a local maximum to count as an
 *  HVN. 0.5 = "at least half as busy as the POC." Lower values surface
 *  more peaks (including weak ones); higher values restrict to the
 *  strongest 1-3 nodes. */
const HVN_MIN_VOLUME_FRAC = 0.5;
/** Fraction of POC volume below which a local minimum counts as an LVN.
 *  0.5 = "no more than half the POC's volume." */
const LVN_MAX_VOLUME_FRAC = 0.5;

/** Walk a profile's levels[] and return the midpoint prices of all
 *  qualifying high-volume nodes (strict local maxima above the volume
 *  floor). Returns an empty array when the profile is null or has
 *  fewer than 3 levels (no interior point to compare). */
function findHvnPrices(profile: VolumeProfile | null): number[] {
  if (!profile || profile.levels.length < 3) return [];
  const threshold = HVN_MIN_VOLUME_FRAC * profile.maxLevelVolume;
  const out: number[] = [];
  const ls = profile.levels;
  for (let k = 1; k < ls.length - 1; k++) {
    const v = ls[k].totalVolume;
    if (v < threshold) continue;
    if (v > ls[k - 1].totalVolume && v > ls[k + 1].totalVolume) {
      out.push((ls[k].priceLow + ls[k].priceHigh) / 2);
    }
  }
  return out;
}

/** Walk a profile's levels[] and return the midpoint prices of all
 *  qualifying low-volume nodes (strict local minima below the volume
 *  ceiling, excluding the boundary levels). */
function findLvnPrices(profile: VolumeProfile | null): number[] {
  if (!profile || profile.levels.length < 3) return [];
  const ceiling = LVN_MAX_VOLUME_FRAC * profile.maxLevelVolume;
  const out: number[] = [];
  const ls = profile.levels;
  for (let k = 1; k < ls.length - 1; k++) {
    const v = ls[k].totalVolume;
    if (v > ceiling) continue;
    if (v < ls[k - 1].totalVolume && v < ls[k + 1].totalVolume) {
      out.push((ls[k].priceLow + ls[k].priceHigh) / 2);
    }
  }
  return out;
}

/** Pick the price closest to `target` from a list. Returns NaN when the
 *  list is empty. */
function nearestPrice(prices: number[], target: number): number {
  if (prices.length === 0) return NaN;
  let best = prices[0];
  let bestDist = Math.abs(prices[0] - target);
  for (let i = 1; i < prices.length; i++) {
    const d = Math.abs(prices[i] - target);
    if (d < bestDist) {
      bestDist = d;
      best = prices[i];
    }
  }
  return best;
}

/** Signed normalized distance from current close to the nearest
 *  high-volume node in the rolling N-bar profile:
 *    (nearestHVN − close) / close
 *  Positive = the node is above price (resistance/magnet above);
 *  negative = below. NaN when no qualifying HVN exists, the window
 *  hasn't filled, or close is non-finite/zero.
 *
 *  Reuses the same `ProfileCache` the POC/VAH/VAL family uses, so a
 *  strategy that asks for both POC and HVN over the same (windowBars,
 *  valueAreaPct) pays for the profile build exactly once. */
export function nearestHvnSeries(
  bars: ReadonlyArray<{ bar_close: number }>,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(bars.length).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].bar_close;
    if (!Number.isFinite(c) || c === 0) continue;
    const hvns = findHvnPrices(profiles[i]);
    const p = nearestPrice(hvns, c);
    if (Number.isFinite(p)) out[i] = (p - c) / c;
  }
  return out;
}

/** Signed normalized distance from current close to the nearest
 *  low-volume node (liquidity gap) in the rolling N-bar profile. Same
 *  shape as `nearestHvnSeries`. LVNs act as magnets when approached
 *  from outside and break-through points when traversed. */
export function nearestLvnSeries(
  bars: ReadonlyArray<{ bar_close: number }>,
  cache: ProfileCache,
  windowBars: number,
  valueAreaPct = 0.7,
): number[] {
  const out = new Array(bars.length).fill(NaN);
  const profiles = cache.get(windowBars, valueAreaPct);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].bar_close;
    if (!Number.isFinite(c) || c === 0) continue;
    const lvns = findLvnPrices(profiles[i]);
    const p = nearestPrice(lvns, c);
    if (Number.isFinite(p)) out[i] = (p - c) / c;
  }
  return out;
}

// ─── Footprint imbalance ───────────────────────────────────────────────────
//
// Classic footprint-chart signal: within ONE bar, K consecutive price
// buckets (ascending for bullish, descending for bearish) where one
// side's volume swamps the other by a `ratio` multiplier. Detects
// concentrated aggression at a specific price zone — stronger evidence
// than bar-level delta because it shows WHERE in the bar the buying
// (or selling) happened.
//
// The existing volume-profile family operates over MULTI-bar windows
// and only exposes summary scalars (POC/VAH/VAL). Per-(bar, price) bid/
// ask binning is a new primitive; we build it once per bar on demand
// via `FootprintCache` and let multiple DSL calls share the binning.

/** One price bucket's bid/ask volume within a single bar. */
interface FootprintLevel {
  bucketKey: number;   // floor(price / bucketSize); used as Map key
  bidVol: number;
  askVol: number;
}

/** A bar's footprint — buckets sorted ASCENDING by price. */
interface BarFootprint {
  bucketSize: number;
  levels: FootprintLevel[];
}

/** Build a single bar's footprint by binning its ticks per price. The
 *  bucket size is the same heuristic the rolling volume-profile uses
 *  (`defaultBucketSize` — span/100 with a min clamp), computed from
 *  the bar's own tick range so single-tick bars don't blow up. */
function buildBarFootprint(
  ctx: TickContext,
  barIdx: number,
): BarFootprint | null {
  const startSlot = barIdx * 2;
  const endSlot = barIdx * 2 + 1;
  if (endSlot >= ctx.barTickRanges.length) return null;
  const start = ctx.barTickRanges[startSlot];
  const end = ctx.barTickRanges[endSlot];
  if (end <= start) return null;

  const bucketSize = defaultBucketSize(ctx.ticks, start, end);
  const map = new Map<number, FootprintLevel>();
  for (let k = start; k < end; k++) {
    const key = Math.floor(ctx.ticks.prices[k] / bucketSize);
    let lvl = map.get(key);
    if (!lvl) {
      lvl = { bucketKey: key, bidVol: 0, askVol: 0 };
      map.set(key, lvl);
    }
    const sz = ctx.ticks.sizes[k];
    const side = ctx.ticks.sides[k];
    if (side === 1) lvl.bidVol += sz;
    else if (side === 2) lvl.askVol += sz;
  }

  // Sort buckets ascending so "consecutive ascending price" maps to
  // walking the array forward.
  const levels = Array.from(map.values()).sort(
    (a, b) => a.bucketKey - b.bucketKey,
  );
  return { bucketSize, levels };
}

/** Per-zone footprint cache. Each bar's footprint is built once and
 *  shared between the up/down stacked-imbalance calls. Same lazy-slot
 *  shape as `ProfileCache` and `HeikenAshiCache`. */
export class FootprintCache {
  private bars: Array<BarFootprint | null | undefined>;

  constructor(
    private readonly barCount: number,
    private readonly ctx: TickContext,
  ) {
    // `undefined` = not yet computed; `null` = computed and empty;
    // BarFootprint = computed with data. Lets us memoize misses too.
    this.bars = new Array(barCount);
  }

  get(barIdx: number): BarFootprint | null {
    const cached = this.bars[barIdx];
    if (cached !== undefined) return cached;
    const fp = buildBarFootprint(this.ctx, barIdx);
    this.bars[barIdx] = fp;
    return fp;
  }
}

/** Walk a bar's footprint and return the maximum run length of
 *  CONSECUTIVE price buckets satisfying the imbalance test. Buckets
 *  must be both contiguous in price (no gap-bucket between them) AND
 *  pass `predicate(bidVol, askVol)`. */
function maxImbalanceRun(
  footprint: BarFootprint,
  predicate: (bid: number, ask: number) => boolean,
): number {
  const ls = footprint.levels;
  if (ls.length === 0) return 0;
  let best = 0;
  let run = 0;
  let prevKey = Number.MIN_SAFE_INTEGER;
  for (let i = 0; i < ls.length; i++) {
    const lvl = ls[i];
    const contiguous = lvl.bucketKey === prevKey + 1;
    if (predicate(lvl.bidVol, lvl.askVol)) {
      run = contiguous ? run + 1 : 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
    prevKey = lvl.bucketKey;
  }
  return best;
}

/** Per-bar max-consecutive-run-length of bullish stacked imbalances —
 *  ascending price buckets where `askVol >= ratio * bidVol` and
 *  bidVol > 0 (or askVol > 0 when bidVol is zero, to avoid div-by-
 *  zero rejecting one-sided ladders). User typically filters with
 *  e.g. `>= 3` for the classic "3 stacked" signal. Tick-required;
 *  bid/ask side requires `tick_bidask` granularity. */
export function stackedImbalanceUpSeries(
  barCount: number,
  ctx: TickContext,
  cache: FootprintCache,
  ratio: number,
): number[] {
  const out = new Array<number>(barCount).fill(0);
  if (!(ratio > 0)) return out;
  for (let i = 0; i < barCount; i++) {
    const fp = cache.get(i);
    if (!fp) continue;
    out[i] = maxImbalanceRun(fp, (bid, ask) => {
      // Ask-dominant level: either ask volume swamps bid volume by the
      // ratio, OR bid is zero and ask is positive (a one-sided buy
      // ladder still counts as bullish absorption).
      if (ask <= 0) return false;
      if (bid <= 0) return true;
      return ask >= ratio * bid;
    });
  }
  return out;
}

/** Per-bar max-consecutive-run-length of bearish stacked imbalances.
 *  Note that "descending in price" for footprint stacks is equivalent
 *  to "ascending in price with bid-dominant condition" — we still walk
 *  buckets in ascending-price order (the order they're stored) and
 *  count runs. A run of bid-dominant buckets that happens to span
 *  prices P, P+1, P+2 is the same signal regardless of which price the
 *  trader THINKS as the start. */
export function stackedImbalanceDownSeries(
  barCount: number,
  ctx: TickContext,
  cache: FootprintCache,
  ratio: number,
): number[] {
  const out = new Array<number>(barCount).fill(0);
  if (!(ratio > 0)) return out;
  for (let i = 0; i < barCount; i++) {
    const fp = cache.get(i);
    if (!fp) continue;
    out[i] = maxImbalanceRun(fp, (bid, ask) => {
      if (bid <= 0) return false;
      if (ask <= 0) return true;
      return bid >= ratio * ask;
    });
  }
  return out;
}

// ─── Sweep detection (v2 quote data) ───────────────────────────────────────
//
// A sweep = aggressive market order that eats the entire visible inside
// quote, often stepping through multiple levels. With v2 tick data we
// can check this directly per tick: trade size >= the resting size that
// was at the inside quote AT THE MOMENT of that trade. Each tick is
// evaluated independently — no sequential walk needed.

/** Count of buy-aggressor ticks in the last N bars whose trade size
 *  was at least as large as the resting best-ask size at the moment of
 *  the trade. Optionally filter by an absolute size floor (`sizeMin`).
 *  v2 quote data required — returns NaN for legacy sessions. */
export function sweepUpSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  sizeMin: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const sides = ctx.ticks.sides;
  const sizes = ctx.ticks.sizes;
  const askSz = ctx.ticks.bestAskSizes;
  const floor = Number.isFinite(sizeMin) && sizeMin > 0 ? sizeMin : 0;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let count = 0;
    for (let k = range.start; k < range.end; k++) {
      if (sides[k] !== 2) continue;
      const sz = sizes[k];
      const visible = askSz[k];
      if (visible > 0 && sz >= visible && sz >= floor) count++;
    }
    out[i] = count;
  }
  return out;
}

/** Sell-aggressor sweeps: trade size >= best_bid_size at the moment of
 *  trade. v2 quote data required. */
export function sweepDownSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  sizeMin: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const sides = ctx.ticks.sides;
  const sizes = ctx.ticks.sizes;
  const bidSz = ctx.ticks.bestBidSizes;
  const floor = Number.isFinite(sizeMin) && sizeMin > 0 ? sizeMin : 0;
  for (let i = windowBars - 1; i < barCount; i++) {
    const range = windowTickRange(i, windowBars, ctx.barTickRanges);
    if (!range) continue;
    let count = 0;
    for (let k = range.start; k < range.end; k++) {
      if (sides[k] !== 1) continue;
      const sz = sizes[k];
      const visible = bidSz[k];
      if (visible > 0 && sz >= visible && sz >= floor) count++;
    }
    out[i] = count;
  }
  return out;
}

// ─── Iceberg detection (v2 quote data) ─────────────────────────────────────
//
// An iceberg = hidden resting size behind the displayed quote. The
// signature: trades keep printing at the same inside price, but the
// displayed size doesn't decay as it "should" — it refills back to a
// similar level. Trick: requires SEQUENTIAL tick comparison (this tick
// vs the next tick's quote state), which no prior indicator in this
// module does. We introduce the pattern here: maintain a small
// per-price refill counter Map that's reset whenever the inside quote
// price moves or the size collapses, and accumulated whenever the
// post-trade size returns to the pre-trade level.
//
// Threshold for "size came back" is intentionally relaxed (>= 70% of
// pre-trade size) since real refills rarely match to the contract.

/** Threshold under which we still consider best-ask/bid size to have
 *  "refilled" after a print. Captures partial refills that still
 *  signal hidden depth without requiring exact matches. */
const ICEBERG_REFILL_FRAC = 0.7;

/** Walk a bar's tick range looking for repeated buy-aggressor prints at
 *  the same best-ask price where the post-trade ask size returns to
 *  (≥ 70% of) its pre-trade level. Returns the longest such refill
 *  streak observed within the bar (across all prices touched). */
function maxIcebergStreakAtAsk(ctx: TickContext, barIdx: number): number {
  const startSlot = barIdx * 2;
  const endSlot = barIdx * 2 + 1;
  if (endSlot >= ctx.barTickRanges.length) return 0;
  const start = ctx.barTickRanges[startSlot];
  const end = ctx.barTickRanges[endSlot];
  if (end - start < 2) return 0;

  const sides = ctx.ticks.sides;
  const askPx = ctx.ticks.bestAsks;
  const askSz = ctx.ticks.bestAskSizes;
  const refills = new Map<number, number>();
  let best = 0;
  for (let k = start; k < end - 1; k++) {
    if (sides[k] !== 2) continue;
    const priceKey = askPx[k];
    const before = askSz[k];
    const after = askSz[k + 1];
    // If the next tick's best ask has moved to a different price OR we
    // didn't have a meaningful pre-trade size, the refill chain at
    // this price is broken.
    if (!(before > 0) || askPx[k + 1] !== priceKey) {
      refills.delete(priceKey);
      continue;
    }
    if (after >= ICEBERG_REFILL_FRAC * before) {
      const c = (refills.get(priceKey) ?? 0) + 1;
      refills.set(priceKey, c);
      if (c > best) best = c;
    } else {
      // Size dropped meaningfully — the displayed liquidity was real
      // (or at least mostly real); reset this price's counter so
      // subsequent prints don't carry stale credit.
      refills.delete(priceKey);
    }
  }
  return best;
}

/** Mirror of `maxIcebergStreakAtAsk` for the bid side. */
function maxIcebergStreakAtBid(ctx: TickContext, barIdx: number): number {
  const startSlot = barIdx * 2;
  const endSlot = barIdx * 2 + 1;
  if (endSlot >= ctx.barTickRanges.length) return 0;
  const start = ctx.barTickRanges[startSlot];
  const end = ctx.barTickRanges[endSlot];
  if (end - start < 2) return 0;

  const sides = ctx.ticks.sides;
  const bidPx = ctx.ticks.bestBids;
  const bidSz = ctx.ticks.bestBidSizes;
  const refills = new Map<number, number>();
  let best = 0;
  for (let k = start; k < end - 1; k++) {
    if (sides[k] !== 1) continue;
    const priceKey = bidPx[k];
    const before = bidSz[k];
    const after = bidSz[k + 1];
    if (!(before > 0) || bidPx[k + 1] !== priceKey) {
      refills.delete(priceKey);
      continue;
    }
    if (after >= ICEBERG_REFILL_FRAC * before) {
      const c = (refills.get(priceKey) ?? 0) + 1;
      refills.set(priceKey, c);
      if (c > best) best = c;
    } else {
      refills.delete(priceKey);
    }
  }
  return best;
}

/** Count of bars in the last N whose max ask-side iceberg refill streak
 *  was >= `minRefills`. v2 quote data required. Each bar is evaluated
 *  independently (no cross-bar streak chaining) — iceberg evidence
 *  should be visible within a single bar to be actionable. */
export function icebergAtAskSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  minRefills: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const threshold = Number.isFinite(minRefills) && minRefills > 0
    ? Math.floor(minRefills)
    : 1;
  // Precompute per-bar streak counts so the rolling window only does
  // O(windowBars) work per bar instead of re-walking ticks.
  const streaks = new Array<number>(barCount).fill(0);
  for (let i = 0; i < barCount; i++) {
    streaks[i] = maxIcebergStreakAtAsk(ctx, i);
  }
  for (let i = windowBars - 1; i < barCount; i++) {
    let count = 0;
    for (let j = i - windowBars + 1; j <= i; j++) {
      if (streaks[j] >= threshold) count++;
    }
    out[i] = count;
  }
  return out;
}

/** Bid-side iceberg counter — mirror of `icebergAtAskSeries`. */
export function icebergAtBidSeries(
  barCount: number,
  ctx: TickContext,
  windowBars: number,
  minRefills: number,
): number[] {
  const out = new Array(barCount).fill(NaN);
  if (!ctx.ticks.hasQuotes) return out;
  const threshold = Number.isFinite(minRefills) && minRefills > 0
    ? Math.floor(minRefills)
    : 1;
  const streaks = new Array<number>(barCount).fill(0);
  for (let i = 0; i < barCount; i++) {
    streaks[i] = maxIcebergStreakAtBid(ctx, i);
  }
  for (let i = windowBars - 1; i < barCount; i++) {
    let count = 0;
    for (let j = i - windowBars + 1; j <= i; j++) {
      if (streaks[j] >= threshold) count++;
    }
    out[i] = count;
  }
  return out;
}
