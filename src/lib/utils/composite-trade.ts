/**
 * Composite Trade Builder
 *
 * Takes the simulator's winning trades and merges them into a single "perfect
 * trade" curve — like averaging a stack of faces into a composite portrait.
 * The point isn't the average value (averages of disparate trades can look
 * meaningless); it's the SHAPE — when do winners typically pull back? how
 * deep? do they grind up linearly or pop fast and chop?
 *
 * Each trade is normalized along two axes:
 *   1. Time: 0 → 1 across (entry bar) → (exit bar). Trades of different
 *      lengths get resampled onto a common grid so we can stack them.
 *   2. Price: each bar's P&L is divided by the trade's exit P&L so every
 *      winner ends at 1.0. This isolates "shape" from "magnitude" — a
 *      +2 pt scalp and a +25 pt runner contribute the same shape weight.
 *
 * At each grid point we collect the values across all winners and compute
 * percentiles (p10/p25/p50/p75/p90) so the chart can show the "envelope"
 * a typical winner stays inside, not just the mean.
 *
 * Pure / synchronous. Cheap enough (O(trades × gridPoints)) to recompute
 * inline whenever the user toggles the panel.
 */

import { SimZoneResult } from "./zone-simulator";
import { TradeZone, TradeZoneBar } from "@/types/trade-zone";

/** A single trade's normalized P&L curve, sampled at the common grid. */
export interface NormalizedTradePath {
  zoneId: number;
  /** Length of `valuesPct` matches the grid; each entry is P&L as a fraction
   *  of the trade's final exit P&L (so the curve ends at 1.0). */
  valuesPct: number[];
  /** Same shape as valuesPct but in raw points (signed). Useful when a user
   *  wants to see absolute dollars rather than normalized shape. */
  valuesPoints: number[];
  /** Trade's actual exit P&L in points. Used to label individual lines. */
  exitPoints: number;
  /** Bars held (excluding the entry bar). Used for tooltip context. */
  barsHeld: number;
}

/** Per-grid-point distribution stats across all winning trades. */
export interface CompositeTradePoint {
  /** Normalized time, 0 → 1. */
  t: number;
  /** Same value as a percentage label (e.g. 0, 5, 10... 100) for the X axis. */
  tPct: number;

  // ── Normalized (% of exit P&L) ──
  meanPct: number;
  medianPct: number;
  p10Pct: number;
  p25Pct: number;
  p75Pct: number;
  p90Pct: number;

  // ── Raw points ──
  meanPoints: number;
  medianPoints: number;
  p10Points: number;
  p25Points: number;
  p75Points: number;
  p90Points: number;

  /** Number of trades contributing to this grid point. Always equal to the
   *  total winner count for the grid points at the chosen resolution — but
   *  surfaced anyway so future resampling tweaks (e.g. dropping NaN-filled
   *  points) stay observable in the UI. */
  sampleSize: number;
}

export interface CompositeTradeResult {
  /** Per-grid-point distribution stats. The "perfect trade" curve. */
  points: CompositeTradePoint[];
  /** Each individual winner's normalized path — for the faint background
   *  spaghetti overlay. */
  trades: NormalizedTradePath[];
  /** How many winners went into the composite. */
  winnerCount: number;
  /** How many trades were skipped (not winners, or had no usable bars). */
  skippedCount: number;
}

/**
 * Build a composite from simulated trades.
 *
 * @param trades        Sim results from the backtest. Only winners
 *                      (scaledPoints > 0) are included in the composite.
 * @param zones         The TradeZone objects matched to those trades by id.
 *                      Provides start_price and direction for P&L recompute.
 * @param barsByZoneId  Per-zone bars indexed by zone id. Bar 0 is the entry
 *                      bar; later bars are the trade's lifetime.
 * @param gridSize      Number of grid points in the normalized timeline.
 *                      51 = sample every 2% (default — gives a smooth curve
 *                      without being absurdly granular).
 */
export function buildCompositeTrade(
  trades: SimZoneResult[],
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  gridSize: number = 51
): CompositeTradeResult {
  // Index zones by id once so the per-trade loop is O(1) lookup, not O(n).
  const zoneById = new Map<number, TradeZone>();
  for (const z of zones) zoneById.set(z.id, z);

  // ── Per-trade normalization pass ──────────────────────────────
  // For each winner, walk bars 0..exitBarIndex, compute direction-aware
  // P&L from entry, then resample onto the common grid. We use linear
  // interpolation between adjacent bars — close enough for visualization
  // and avoids the kinks that nearest-neighbor sampling would produce.
  const normalized: NormalizedTradePath[] = [];
  let skipped = 0;

  for (const t of trades) {
    // Filter — only WINNERS contribute to the "perfect trade" composite.
    // Use scaledPoints because that's what the rest of the dashboard treats
    // as the trade's final P&L (incorporates the scaling modifier).
    if (t.scaledPoints <= 0) {
      skipped++;
      continue;
    }

    const zone = zoneById.get(t.zoneId);
    const bars = barsByZoneId.get(t.zoneId);
    if (!zone || !bars || bars.length === 0) {
      skipped++;
      continue;
    }

    // Sort bars by index defensively — engine generally hands them in
    // order, but the simulator does too and still re-sorts.
    const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);

    // Slice up to and including the exit bar. exitBarIndex is the bar at
    // which the simulator decided to close, so the trade's "lifetime" is
    // bars 0..exitBarIndex inclusive. Bar 0's close is the entry — its
    // P&L is 0 by definition (entry happens at that close).
    const lifetime = sorted.filter((b) => b.bar_index <= t.exitBarIndex);
    if (lifetime.length < 2) {
      // Need at least two points to draw a curve — the entry bar plus
      // one more. If we don't have it, we can't form a path.
      skipped++;
      continue;
    }

    const isLong = zone.direction === "Long";
    const entryPrice = zone.start_price;

    // Build (time, P&L points) pairs for this trade. Time is normalized
    // to [0, 1] across the lifetime. We use bar_close as the
    // representative price for the bar — the simulator's exit logic
    // mostly resolves to closes (especially in exit-at-bar-close mode),
    // and using close keeps the composite smooth rather than zig-zagging
    // through high/low whipsaws that the trade may never have actually
    // crossed.
    const N = lifetime.length;
    const times: number[] = new Array(N);
    const points: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const bar = lifetime[i];
      times[i] = i / (N - 1);
      const pnl = isLong
        ? bar.bar_close - entryPrice
        : entryPrice - bar.bar_close;
      points[i] = pnl;
    }
    // Force the trade's first sample to exactly 0 (entry P&L is zero by
    // definition) and last sample to exactly the simulator's exit P&L
    // (ensures every winner ends at 1.0 in normalized space, even if the
    // exit bar's close didn't land precisely there because of intra-bar
    // exits like TP, SL, or trail).
    points[0] = 0;
    points[N - 1] = t.scaledPoints;

    // Resample onto the common grid via linear interpolation. We march
    // through the trade's bars once and the grid once — O(N + grid).
    const valuesPoints: number[] = new Array(gridSize);
    const valuesPct: number[] = new Array(gridSize);
    let j = 0;
    for (let g = 0; g < gridSize; g++) {
      const tg = g / (gridSize - 1);
      // Advance j until the bar after our current grid point is just
      // ahead of tg, i.e. times[j] <= tg < times[j+1].
      while (j < N - 2 && times[j + 1] < tg) j++;
      const t0 = times[j];
      const t1 = times[j + 1];
      const p0 = points[j];
      const p1 = points[j + 1];
      const span = t1 - t0;
      const frac = span > 0 ? (tg - t0) / span : 0;
      const interp = p0 + (p1 - p0) * frac;
      valuesPoints[g] = interp;
      // Normalize by exit P&L. We already filtered scaledPoints > 0 so
      // this never divides by zero.
      valuesPct[g] = interp / t.scaledPoints;
    }

    normalized.push({
      zoneId: t.zoneId,
      valuesPct,
      valuesPoints,
      exitPoints: t.scaledPoints,
      barsHeld: t.barsHeld,
    });
  }

  // ── Per-grid distribution pass ────────────────────────────────
  // For each grid point, collect the column of values across all winners,
  // sort, and pull percentiles. Sorting per column is O(W log W) where W
  // is winner count — at gridSize=51 and a few thousand winners this is
  // imperceptible.
  const compositePoints: CompositeTradePoint[] = [];
  for (let g = 0; g < gridSize; g++) {
    const tg = g / (gridSize - 1);
    const colPct: number[] = [];
    const colPoints: number[] = [];
    for (const path of normalized) {
      colPct.push(path.valuesPct[g]);
      colPoints.push(path.valuesPoints[g]);
    }
    colPct.sort((a, b) => a - b);
    colPoints.sort((a, b) => a - b);

    const meanPct =
      colPct.length === 0
        ? 0
        : colPct.reduce((acc, v) => acc + v, 0) / colPct.length;
    const meanPoints =
      colPoints.length === 0
        ? 0
        : colPoints.reduce((acc, v) => acc + v, 0) / colPoints.length;

    compositePoints.push({
      t: tg,
      tPct: Math.round(tg * 1000) / 10, // e.g. 0.5 → 50.0
      meanPct,
      medianPct: percentile(colPct, 0.5),
      p10Pct: percentile(colPct, 0.1),
      p25Pct: percentile(colPct, 0.25),
      p75Pct: percentile(colPct, 0.75),
      p90Pct: percentile(colPct, 0.9),
      meanPoints,
      medianPoints: percentile(colPoints, 0.5),
      p10Points: percentile(colPoints, 0.1),
      p25Points: percentile(colPoints, 0.25),
      p75Points: percentile(colPoints, 0.75),
      p90Points: percentile(colPoints, 0.9),
      sampleSize: colPct.length,
    });
  }

  return {
    points: compositePoints,
    trades: normalized,
    winnerCount: normalized.length,
    skippedCount: skipped,
  };
}

// ─── Composite OHLC bars ────────────────────────────────────────────────
// A separate output shape for the "super trade as a candlestick chart"
// view. Instead of normalizing trade lengths onto a fixed grid, we keep
// raw bar indices (bar 0 = entry, bar 1 = next bar, …) and average the
// OHLC across every winner that REACHED that bar index. The result is a
// synthetic candlestick series that shows what a typical winning long
// (or short) looks like bar-by-bar in raw points relative to entry.

/** A single synthetic candle in the composite series — averaged OHLC across
 *  every winning trade in this direction that has a bar at this index.
 *
 *  Values are in "price-delta space" — raw (bar_price − entry_price), with
 *  NO sign flip for shorts. That makes both charts mirror what actually
 *  shows up on a price chart: a winning long climbs (+ deltas, mostly
 *  green candles) and a winning short falls (− deltas, mostly red candles).
 *  The Y axis is "price relative to entry", so the user reads off literal
 *  price movement — which is what you want when judging "do my winning
 *  shorts behave the way I expect them to?".
 */
export interface CompositeBar {
  barIndex: number;
  open: number; // Avg of (bar_open − entry)·dir across contributing winners
  high: number; // Avg of best favorable price
  low: number;  // Avg of worst adverse price (signed — usually negative)
  close: number;
  /** How many winners reached this bar. The denominator falls off as the
   *  bar index grows because shorter trades drop out of the average. */
  sampleSize: number;
}

export interface CompositeBarsResult {
  // Winners — by direction
  longBars: CompositeBar[];
  shortBars: CompositeBar[];
  longWinnerCount: number;
  shortWinnerCount: number;
  // Losers — by direction. Same averaging logic, just filtered to
  // scaledPoints < 0 instead of > 0. Comparing winner-shape vs
  // loser-shape side-by-side is where the actual edge story lives:
  // what does a setup that fails look like, vs one that works?
  longLoserBars: CompositeBar[];
  shortLoserBars: CompositeBar[];
  longLoserCount: number;
  shortLoserCount: number;
}

/**
 * Build per-direction composite candlestick series from the simulator's
 * winning trades. For each winner, every bar from entry through exit
 * (and optionally the N bars BEFORE entry too) is converted to
 * price-delta space. Then for each bar index, we average across all
 * winners that reached that bar to produce a single synthetic candle.
 *
 * Pre-entry bars are usually the most interesting part — they show
 * what the SETUP looks like for a typical winner (e.g. "winning longs
 * are usually consolidating sideways for ~10 bars then break out", or
 * "winning shorts come after a sharp adverse move that exhausts").
 * They're keyed by negative bar_index (-N..-1) and live in their own
 * map so the dashboard can flip them on/off independently.
 *
 * @param trades              Sim results — only winners are included.
 * @param zones               TradeZones; provides start_price + direction.
 * @param barsByZoneId        Per-zone bars (entry + post-entry) keyed by
 *                            zone id.
 * @param preEntryBarsByZoneId Optional per-zone pre-entry bars. Each
 *                            bar carries a NEGATIVE bar_index (-N..-1)
 *                            so they sort chronologically before bar 0.
 *                            Pass an empty map (or omit) to skip the
 *                            pre-entry context.
 * @param minSampleSize       Drop bars where fewer than this many winners
 *                            contributed. Default 3 — keeps the chart
 *                            from showing wild single-trade outliers
 *                            at the deep tail or far back in pre-entry.
 */
export function buildCompositeBars(
  trades: SimZoneResult[],
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  preEntryBarsByZoneId: Map<number, TradeZoneBar[]> = new Map(),
  minSampleSize: number = 3
): CompositeBarsResult {
  const zoneById = new Map<number, TradeZone>();
  for (const z of zones) zoneById.set(z.id, z);

  // Per-(direction × outcome) accumulators. Four total buckets:
  //   long winners, long losers, short winners, short losers.
  // We sum running totals + counts, then divide once at the end. Doing
  // this in one pass beats sorting all bars per index, and preserves
  // the natural order of bar indices for the chart's X axis.
  // Map<barIndex, { sumO, sumH, sumL, sumC, count }>
  type Accum = { sumO: number; sumH: number; sumL: number; sumC: number; count: number };
  const longWinAcc = new Map<number, Accum>();
  const shortWinAcc = new Map<number, Accum>();
  const longLoseAcc = new Map<number, Accum>();
  const shortLoseAcc = new Map<number, Accum>();
  let longWinners = 0;
  let shortWinners = 0;
  let longLosers = 0;
  let shortLosers = 0;

  for (const t of trades) {
    // Skip exact break-evens — they pollute both buckets at zero
    // contribution, and don't represent either pattern. Strictly
    // positive → winner; strictly negative → loser.
    if (t.scaledPoints === 0) continue;
    const zone = zoneById.get(t.zoneId);
    const bars = barsByZoneId.get(t.zoneId);
    if (!zone || !bars || bars.length === 0) continue;

    const isLong = zone.direction === "Long";
    const isWinner = t.scaledPoints > 0;
    const entryPrice = zone.start_price;
    // Pick the right bucket once per trade.
    const acc = isLong
      ? isWinner
        ? longWinAcc
        : longLoseAcc
      : isWinner
        ? shortWinAcc
        : shortLoseAcc;
    if (isLong && isWinner) longWinners++;
    else if (isLong) longLosers++;
    else if (isWinner) shortWinners++;
    else shortLosers++;

    // Sort defensively + slice to the trade's actual lifetime, then
    // prepend any pre-entry bars (negative bar_index) so they're folded
    // into the same accumulator at their natural index. Pre-entry bars
    // already carry the right negative indices (-N..-1) — we just add
    // them upstream of the entry-onward window.
    const preEntry = preEntryBarsByZoneId.get(t.zoneId) ?? [];
    const lifetime = [
      ...preEntry,
      ...bars.filter((b) => b.bar_index <= t.exitBarIndex),
    ].sort((a, b) => a.bar_index - b.bar_index);

    for (const bar of lifetime) {
      // Raw price-delta OHLC (price − entry). No sign flip for shorts —
      // we want the chart to show LITERAL price movement so users see
      // "winning shorts ride the price down" with red descending
      // candles, not a mirror image dressed up as profit. The chart
      // header tells the user which direction is winning here; the
      // Y axis is "points away from entry", same convention for both.
      const o = bar.bar_open - entryPrice;
      const h = bar.bar_high - entryPrice;
      const l = bar.bar_low - entryPrice;
      const c = bar.bar_close - entryPrice;

      const existing = acc.get(bar.bar_index);
      if (existing) {
        existing.sumO += o;
        existing.sumH += h;
        existing.sumL += l;
        existing.sumC += c;
        existing.count += 1;
      } else {
        acc.set(bar.bar_index, { sumO: o, sumH: h, sumL: l, sumC: c, count: 1 });
      }
    }
  }

  // Materialize each accumulator into a sorted array of CompositeBars
  // and drop the long tail where too few trades survive — those bars
  // are noisy because a single outlier dominates the average.
  const finalize = (acc: Map<number, Accum>): CompositeBar[] => {
    const out: CompositeBar[] = [];
    const indices = Array.from(acc.keys()).sort((a, b) => a - b);
    for (const bi of indices) {
      const a = acc.get(bi)!;
      if (a.count < minSampleSize) continue;
      out.push({
        barIndex: bi,
        open: a.sumO / a.count,
        high: a.sumH / a.count,
        low: a.sumL / a.count,
        close: a.sumC / a.count,
        sampleSize: a.count,
      });
    }
    return out;
  };

  return {
    longBars: finalize(longWinAcc),
    shortBars: finalize(shortWinAcc),
    longWinnerCount: longWinners,
    shortWinnerCount: shortWinners,
    longLoserBars: finalize(longLoseAcc),
    shortLoserBars: finalize(shortLoseAcc),
    longLoserCount: longLosers,
    shortLoserCount: shortLosers,
  };
}

/**
 * Linear-interpolated percentile over a SORTED array.
 *
 * `q` is the quantile, [0, 1]. Returns 0 when the array is empty so callers
 * don't have to special-case "no winners yet" — the composite chart renders
 * cleanly as a flat zero line in that state.
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
