/**
 * monte-carlo.ts — Bootstrap Monte Carlo simulation for projecting future
 * equity curves from historical backtest trade outcomes.
 *
 * The premise: take the historical trade P&L distribution as a sampling
 * universe and resample with replacement to project what the equity curve
 * could look like over a future horizon (a week, a month, a year). Across
 * many simulated runs we extract the median path (the "most likely"
 * scenario), confidence bands, and a probability of profit.
 *
 * Bootstrap (resampling with replacement) is appropriate here because:
 *  - It treats each historical trade as an i.i.d. draw from the strategy's
 *    edge distribution. Trade order independence is an assumption — if the
 *    strategy has serial correlation (e.g. losses cluster) this understates
 *    drawdown risk. We mitigate by sampling enough trades that any
 *    autocorrelation gets washed out across simulations.
 *  - It makes no parametric assumption (no "trades are normally distributed"
 *    fiction). The fat tails and skew of the actual P&L histogram are
 *    preserved in every simulated path.
 *  - It's cheap: O(numSims × numTrades) per run. With numSims = 1000 and
 *    numTrades up to ~5000 (1Y at 20 trades/day) this is ~5M ops, well
 *    under 100ms in pure JS — fast enough to run synchronously when the
 *    user clicks a horizon button.
 */

import { SimZoneResult, SimSummary } from "./zone-simulator";

/**
 * One projection horizon. Names line up with the dashboard buttons.
 * Trading-day counts are calendar-conventional:
 *  - 1W = 5 trading days
 *  - 1M = 21 trading days
 *  - 1Y = 252 trading days
 */
export type MonteCarloHorizon = "1W" | "1M" | "1Y";

export const HORIZON_DAYS: Record<MonteCarloHorizon, number> = {
  "1W": 5,
  "1M": 21,
  "1Y": 252,
};

/**
 * One point on a Monte Carlo equity curve. Indexed by simulated trade
 * number rather than by date — projecting calendar dates would require
 * synthesizing a session schedule, and trade-count indexing matches how
 * the historical equity curve below is rendered.
 *
 * Each point carries the cross-simulation distribution of cumulative P&L
 * at that trade index, so the chart can shade the p5..p95 band and draw
 * the median line in one pass.
 */
export interface MonteCarloPoint {
  /** Trade index (1-based) — used as the X-axis label. */
  tradeIndex: number;
  /** Median cumulative P&L across all simulations at this trade index. */
  median: number;
  /** Mean cumulative P&L across all simulations. Useful sanity check
   *  vs median — when far apart, the distribution is skewed. */
  mean: number;
  /** 5th percentile — the "bad-case" floor of the confidence band. */
  p5: number;
  /** 95th percentile — the "good-case" ceiling of the confidence band. */
  p95: number;
  /** 25th and 75th percentiles — the inner (interquartile) band, drawn
   *  as a darker shade so the chart shows both a wide and a tight cone. */
  p25: number;
  p75: number;
}

/**
 * Aggregate stats over all simulations. These power the stat panel that
 * sits next to the projected equity curve.
 *
 * "Final" = cumulative P&L at the last trade of the horizon (i.e. the
 * end-state of one simulated run). The percentiles and median are taken
 * across the FINAL values of all simulations, not along a single path.
 */
export interface MonteCarloStats {
  numSimulations: number;
  numTrades: number;
  /** Fraction (0..1) of simulated runs that ended above zero P&L. */
  pctProfitable: number;
  medianFinal: number;
  meanFinal: number;
  p5Final: number;
  p95Final: number;
  bestFinal: number;
  worstFinal: number;
  /** Median of the worst peak-to-trough drawdown observed within each
   *  simulation. Reported as a positive number (the magnitude lost from
   *  a running high). Captures path-dependent risk that the final-P&L
   *  percentiles miss — a run can end profitable but suffer a brutal
   *  drawdown midway through. */
  medianMaxDrawdown: number;
  /** 95th percentile of in-simulation drawdown — the "1-in-20 worst
   *  drawdown the strategy plausibly serves up over this horizon."
   *  Positive number. */
  p95MaxDrawdown: number;
}

export interface MonteCarloResult {
  horizon: MonteCarloHorizon;
  /** Display unit — drives whether we resampled scaledPoints or netDollars. */
  mode: "points" | "dollars";
  /** Per-trade-index distribution. Length === numTrades. */
  curve: MonteCarloPoint[];
  stats: MonteCarloStats;
}

/**
 * Compute the Pth percentile of a sorted array using linear interpolation
 * between adjacent samples. The array MUST be sorted ascending. Returns
 * 0 for empty arrays so callers don't need to special-case the empty
 * trades scenario (the curve will just be flat at zero).
 *
 * Uses the simple "type 7" definition (R/Excel default): rank = (N-1)*p,
 * then linearly interpolate between floor(rank) and ceil(rank). This
 * matches what most users intuit when they hear "5th percentile."
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Estimate trades-per-day from the historical run. Used to convert a
 * "1 month" horizon into a concrete trade count.
 *
 * Uses summary.tradingDays (unique calendar days that produced at least
 * one trade) rather than the calendar span — strategies that only trade
 * on certain days (e.g. NFP day) would get a misleading rate from
 * span-based math. Falls back to 1 if tradingDays is zero (e.g. the
 * historical run had no trades), so we never divide by zero.
 */
export function tradesPerDay(summary: SimSummary): number {
  if (summary.tradingDays <= 0) return 0;
  return summary.totalTrades / summary.tradingDays;
}

/**
 * Convert a horizon to a simulated trade count, given the historical
 * trade rate. Floors to an integer and clamps to a minimum of 1 — even a
 * very low-frequency strategy should produce at least one simulated
 * trade so the chart isn't empty.
 *
 * Example: tradesPerDay = 3.2, horizon = 1M (21 days) → 67 trades.
 */
export function horizonToTradeCount(
  horizon: MonteCarloHorizon,
  tpd: number
): number {
  const days = HORIZON_DAYS[horizon];
  const count = Math.floor(tpd * days);
  return Math.max(1, count);
}

/**
 * Run the Monte Carlo simulation.
 *
 * @param trades   Historical trades — the resampling pool. We extract a
 *                 single P&L number from each (scaledPoints in points mode,
 *                 netDollars in dollars mode) and sample from that pool.
 * @param numTrades How many trades each simulated run contains. Computed
 *                  from the horizon and historical trades-per-day.
 * @param mode     Which P&L field to sample — drives whether the result
 *                 is denominated in points or dollars.
 * @param numSims  How many independent simulated runs to perform. 1000 is
 *                 the default — gives stable percentiles without being
 *                 noticeably slow. Lower numbers (100) are faster but
 *                 produce visibly jittery confidence bands; higher (10k)
 *                 doesn't materially change the result for our chart.
 * @param horizon  Pass-through label for the result.
 *
 * Returns null when there's nothing to sample from (no historical trades).
 * The dashboard treats null as "don't render" rather than throwing, so the
 * MC controls can stay clickable while a backtest is empty.
 */
export function runMonteCarlo(
  trades: SimZoneResult[],
  numTrades: number,
  mode: "points" | "dollars",
  horizon: MonteCarloHorizon,
  numSims = 1000
): MonteCarloResult | null {
  if (trades.length === 0 || numTrades < 1) return null;

  // Extract the P&L pool once — every simulation samples from this same
  // array, so building it on every draw would be wasteful. We use scaled
  // (size-adjusted) points to match what the historical equity curve
  // shows; if the user has scaling enabled, the projection inherits it.
  const pnlPool: number[] =
    mode === "dollars"
      ? trades.map((t) => t.netDollars)
      : trades.map((t) => t.scaledPoints);

  const poolSize = pnlPool.length;

  // For each simulation, store the full equity curve plus its max drawdown.
  // We need the full curve (not just the final value) because we compute
  // per-trade-index percentiles across simulations to draw the confidence
  // band. allCurves[sim][trade] = cumulative P&L.
  const allCurves: number[][] = new Array(numSims);
  const finalValues: number[] = new Array(numSims);
  const maxDrawdowns: number[] = new Array(numSims);

  for (let sim = 0; sim < numSims; sim++) {
    const curve = new Array(numTrades);
    let cum = 0;
    let peak = 0;
    let worstDd = 0;
    for (let i = 0; i < numTrades; i++) {
      // Bootstrap draw — pick a uniform-random trade from the historical
      // pool and add its P&L to the running sum. Math.random's quality is
      // fine here; we're not generating crypto seeds, and the bootstrap
      // distribution is robust to the LCG-ish artifacts a poor RNG might
      // introduce.
      const idx = (Math.random() * poolSize) | 0;
      cum += pnlPool[idx];
      curve[i] = cum;
      // Track in-simulation drawdown so we can report path-dependent
      // risk separately from final P&L. peak monotonically rises with the
      // running max; worstDd is the largest peak-minus-cum gap seen.
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > worstDd) worstDd = dd;
    }
    allCurves[sim] = curve;
    finalValues[sim] = cum;
    maxDrawdowns[sim] = worstDd;
  }

  // Per-trade-index percentiles. For each i in [0..numTrades), gather the
  // i-th value from every simulation, sort once, and read off the
  // percentiles. Sorting numSims values numTrades times is the dominant
  // cost — O(numTrades × numSims × log numSims). For 1000 sims × 5000
  // trades that's ~50M comparisons, which V8 chews through in well under
  // a second. We keep one Float64Array as a scratch buffer to avoid
  // allocating per trade.
  const scratch: number[] = new Array(numSims);
  const curve: MonteCarloPoint[] = new Array(numTrades);

  for (let i = 0; i < numTrades; i++) {
    let sum = 0;
    for (let s = 0; s < numSims; s++) {
      const v = allCurves[s][i];
      scratch[s] = v;
      sum += v;
    }
    // In-place ascending sort. We mutate `scratch` because we don't need
    // the original order — every i recomputes the buffer from allCurves.
    scratch.sort((a, b) => a - b);
    curve[i] = {
      tradeIndex: i + 1,
      median: percentile(scratch, 0.5),
      mean: sum / numSims,
      p5: percentile(scratch, 0.05),
      p95: percentile(scratch, 0.95),
      p25: percentile(scratch, 0.25),
      p75: percentile(scratch, 0.75),
    };
  }

  // Final-value statistics. Sort once and read off percentiles.
  const sortedFinals = [...finalValues].sort((a, b) => a - b);
  const sortedDds = [...maxDrawdowns].sort((a, b) => a - b);
  const profitable = finalValues.filter((v) => v > 0).length;
  const meanFinal =
    finalValues.reduce((acc, v) => acc + v, 0) / finalValues.length;

  const stats: MonteCarloStats = {
    numSimulations: numSims,
    numTrades,
    pctProfitable: profitable / numSims,
    medianFinal: percentile(sortedFinals, 0.5),
    meanFinal,
    p5Final: percentile(sortedFinals, 0.05),
    p95Final: percentile(sortedFinals, 0.95),
    bestFinal: sortedFinals[sortedFinals.length - 1],
    worstFinal: sortedFinals[0],
    medianMaxDrawdown: percentile(sortedDds, 0.5),
    p95MaxDrawdown: percentile(sortedDds, 0.95),
  };

  return { horizon, mode, curve, stats };
}
