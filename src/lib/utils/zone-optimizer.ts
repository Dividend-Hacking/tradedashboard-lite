/**
 * Zone Optimizer — Grid search over SL × TP × TSL to maximize total points (P&L).
 *
 * Uses a generator pattern so the caller can drive execution in rAF chunks,
 * keeping the UI responsive with a progress indicator. The generator yields
 * progress updates every ~200 combos and returns the best result on completion.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import {
  SimRules,
  simulateAllZones,
  computeSimSummary,
  SimSummary,
} from "./zone-simulator";

// Note: this file intentionally has no dependency on the worker runner.
// `runOptimizeChunked` and `runAtrAdjustOptimizeChunked` now live in
// `optimizer-worker-runner.ts`. Keeping this module dependency-free of the
// runner means the worker bundle (which imports the generators below)
// doesn't transitively pull in `new URL(.../optimizer.worker.ts, ...)` —
// which previously caused Webpack to recursively re-bundle the worker
// and hang the dev server.

// ─── Types ───────────────────────────────────────────────────────────────────

/** Range definition for a single parameter in the grid search */
export interface ParamRange {
  min: number;
  max: number;
  step: number;
}

/**
 * SL:TP ratio lock for the optimizer. When non-null, the take-profit value
 * is *derived* (TP = base × ratio) instead of grid-searched, where `base` is
 * the SL value (or TSL when hard SL is disabled). null = "Free" (TP grid).
 */
export type SlTpRatio = null | 1 | 1.5 | 2 | 3 | 4;

/**
 * What the optimizer maximizes.
 *   "total-points" — highest aggregate P&L (default; historical behavior).
 *                    Tie-break on profit factor.
 *   "sharpe"       — highest per-trade Sharpe ratio (mean / sample-stdev of
 *                    scaledPoints). Favors smoother equity curves over
 *                    fat-tailed home runs. Tie-break on total points.
 *   "balanced"     — weighted blend of the two. Because totalPoints and
 *                    Sharpe live on completely different scales, this mode
 *                    runs a min-max normalization across every candidate
 *                    tested in the run, then picks the combo that maximizes
 *                    `w·np + (1-w)·ns` where np/ns are the normalized 0..1
 *                    points and Sharpe scores and `w` = balancedPointsWeight.
 *                    Requires an O(n) post-pass over the collected
 *                    candidates so it's slightly slower than the other two,
 *                    but the search itself dominates runtime.
 */
export type OptimizeObjective = "total-points" | "sharpe" | "balanced";

/** Configuration for the optimizer grid search */
export interface OptimizeConfig {
  slRange: ParamRange;
  tpRange: ParamRange;
  tslRange: ParamRange;
  /** Whether to also test with trailing stop disabled */
  includeTslDisabled: boolean;
  /**
   * Lock the SL:TP risk-reward ratio. When set, TP is derived per-combo
   * (TP = base × ratio) and the TP grid is skipped — only TPs that match
   * the locked R:R are tested. Derived TPs outside [tpRange.min, tpRange.max]
   * are skipped (they still count toward `tested` so progress stays accurate).
   * Derived TPs are kept *exact* (no snapping to tpRange.step) so the user's
   * R:R stays true (snapping 7×1.5=10.5 → 10 would silently change the ratio).
   */
  slTpRatio?: SlTpRatio;
  /**
   * When true, hard SL is disabled for the run: stopLossEnabled is forced
   * false, the SL grid axis collapses (no SL search), and the TSL "disabled"
   * sentinel is excluded (TSL must be enabled — it's the only stop). When a
   * ratio is also set, TP derives from TSL instead of SL.
   */
  disableStopLoss?: boolean;
  /**
   * When true, trailing stop is disabled entirely for the run: trailingStop-
   * Enabled is forced false, the TSL grid axis collapses to a single combo,
   * and the "also test without TSL" flag is ignored. Mutually exclusive with
   * disableStopLoss (you'd have no stops at all). When a ratio is set and
   * disableStopLoss is true, the ratio falls back to Free since there's no
   * base to derive TP from.
   */
  disableTrailingStop?: boolean;
  /**
   * Optimization objective. Defaults to "total-points" when omitted so any
   * existing call site that hasn't been updated keeps the legacy behavior.
   * "sharpe" maximizes per-trade Sharpe (smoother equity curve) with
   * totalPoints as the tie-breaker. "balanced" combines both via
   * balancedPointsWeight below.
   */
  objective?: OptimizeObjective;
  /**
   * Only used when `objective === "balanced"`. 0..1 weight on the
   * normalized total-points score; the Sharpe score gets `1 - weight`.
   *   weight = 1.0  → equivalent to "total-points"
   *   weight = 0.0  → equivalent to "sharpe"
   *   weight = 0.5  → equal blend (default)
   * Values outside [0, 1] are clamped at runtime.
   */
  balancedPointsWeight?: number;
}

/** Result of the optimization run */
export interface OptimizeResult {
  /** The optimal SL/TP/TSL values and enabled flags to apply */
  bestRules: Partial<SimRules>;
  /** The best expectancy found (kept for display, derived from bestSummary) */
  bestExpectancy: number;
  /** The best total points (primary optimization target) */
  bestTotalPoints: number;
  /** Full summary stats at the best combo */
  bestSummary: SimSummary;
  /** How many parameter combos were evaluated */
  combinationsTested: number;
  /** Wall-clock time in ms */
  elapsedMs: number;
}

/** Yielded by the generator on each progress checkpoint */
export interface OptimizeProgress {
  /** 0–1 fraction of combos completed */
  progress: number;
  /** Running best result so far */
  current: OptimizeResult;
}

// ─── Default Config ──────────────────────────────────────────────────────────

export const DEFAULT_OPTIMIZE_CONFIG: OptimizeConfig = {
  slRange: { min: 2, max: 50, step: 2 },
  tpRange: { min: 2, max: 80, step: 2 },
  tslRange: { min: 2, max: 40, step: 2 },
  includeTslDisabled: true,
  slTpRatio: null,
  disableStopLoss: false,
  disableTrailingStop: false,
  objective: "total-points",
  balancedPointsWeight: 0.5,
};

// ─── Combo-counting helper ───────────────────────────────────────────────────

/**
 * Builds the ascending value list for a ParamRange (inclusive of max when it
 * lands on a step). Mirrors the loop arithmetic used in optimizeGenerator so
 * countCombos and the actual run agree on totals.
 */
function buildRange(r: ParamRange): number[] {
  const out: number[] = [];
  if (r.step <= 0 || r.min > r.max) return out;
  for (let v = r.min; v <= r.max + 1e-9; v += r.step) out.push(v);
  return out;
}

/**
 * Computes the exact number of combinations the optimizer will test for the
 * given config — used by the modal UI to warn before starting expensive runs.
 * Mirrors the branch logic in optimizeGenerator (ratio lock collapses TP axis;
 * disableStopLoss collapses SL axis and forbids the null TSL sentinel; derived
 * TPs outside tpRange bounds still count as tested, matching the runtime).
 */
export function countCombos(config: OptimizeConfig): number {
  const disableSL = !!config.disableStopLoss;
  const disableTSL = !!config.disableTrailingStop;
  // Both stops can't be off at once — treat as zero combos so the modal can
  // disable the Run button rather than silently rendering an invalid run.
  if (disableSL && disableTSL) return 0;
  // When SL is disabled and there's no TSL to derive from either, the ratio
  // has no base and effectively reverts to Free (TP grid).
  const ratio = disableSL && disableTSL ? null : config.slTpRatio ?? null;

  const slCount = disableSL ? 1 : buildRange(config.slRange).length;
  // TSL disabled → single sentinel combo. Otherwise: range size + maybe the
  // null sentinel for "TSL off" (only when SL is on and the user opted in).
  const tslOnCount = disableTSL ? 0 : buildRange(config.tslRange).length;
  const tslCount = disableTSL
    ? 1
    : tslOnCount + (!disableSL && config.includeTslDisabled ? 1 : 0);
  const tpCount = ratio !== null ? 1 : buildRange(config.tpRange).length;

  return slCount * tslCount * tpCount;
}

/**
 * Grid for the ATR-Adjust optimizer. Values are ADDITIVE per-zone modifiers:
 * the simulator uses `basePoints + adjust × zoneATR` as the effective threshold.
 *
 * The user's existing SL/TP/Trail point values stay FROZEN — this optimizer
 * only varies the adjustment terms, answering "given my proven base, can I
 * make money by stretching/tightening per-zone based on volatility?".
 *
 * Range covers both directions (-2 to +2 for SL/TP, -1 to +2 for trail) so
 * the user can discover whether high-vol zones do better with TIGHTER stops
 * (negative adjust) or wider ones (positive). adjust=0 is always tested,
 * which means the optimizer never returns a result worse than the base.
 *
 * Step 0.1 → 17 × 17 × 16 ≈ 4.6k combos (manageable on the rAF runner).
 * BE adjustment is not optimized (would push combos to ~75k); it's a manual
 * field for users who want to tweak it.
 */
export interface AtrAdjustOptimizeConfig {
  slAdjustRange: ParamRange;
  tpAdjustRange: ParamRange;
  trailAdjustRange: ParamRange;
}

export const DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG: AtrAdjustOptimizeConfig = {
  slAdjustRange: { min: -2, max: 2, step: 0.25 },
  tpAdjustRange: { min: -2, max: 2, step: 0.25 },
  trailAdjustRange: { min: -1, max: 2, step: 0.25 },
};

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generator that sweeps all SL × TP × TSL combos, yielding progress every
 * YIELD_INTERVAL iterations. Keeps all other rules from baseRules intact.
 */
export function* optimizeGenerator(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  baseRules: SimRules,
  config: OptimizeConfig = DEFAULT_OPTIMIZE_CONFIG,
  atrByZoneId?: Map<number, number> | null
): Generator<OptimizeProgress, OptimizeResult, void> {
  const startMs = performance.now();

  // Branch decisions for the run — read once, applied throughout the loop.
  // disableSL: hard SL is off → SL axis collapses, TSL forced on, ratio (if
  // any) derives TP from TSL instead of SL.
  // disableTSL: trailing stop is off → TSL axis collapses to a single null
  // combo. Mutually exclusive with disableSL (would mean no stops at all).
  // ratio: when locked, TP is computed per-combo from `base × ratio` (kept
  // exact, no step snapping) rather than grid-searched.
  const disableSL = !!config.disableStopLoss;
  const disableTSL = !!config.disableTrailingStop;
  // Caller is responsible for not setting both — but if they do, fall back
  // to a no-op result rather than running with no stops.
  if (disableSL && disableTSL) {
    return {
      bestRules: {},
      bestExpectancy: 0,
      bestTotalPoints: 0,
      bestSummary: computeSimSummary([]),
      combinationsTested: 0,
      elapsedMs: 0,
    };
  }
  const ratio = config.slTpRatio ?? null;
  const objective: OptimizeObjective = config.objective ?? "total-points";
  // Clamp balancedPointsWeight to [0, 1] — UI provides a 0..1 slider but
  // defending against bad config values keeps the math sane.
  const pointsWeight =
    objective === "balanced"
      ? Math.max(0, Math.min(1, config.balancedPointsWeight ?? 0.5))
      : 1;
  const sharpeWeight = 1 - pointsWeight;

  // Lightweight per-candidate record — only used in "balanced" mode for the
  // final normalization pass. Storing 50k of these is sub-1MB; storing the
  // full SimSummary objects would balloon memory needlessly. We re-simulate
  // the winning combo at the end to recover its summary.
  type Candidate = {
    sl: number | null;
    tp: number;
    tsl: number | null;
    totalPoints: number;
    sharpe: number;
  };
  const candidates: Candidate[] = objective === "balanced" ? [] : [];

  // SL axis. When disabled, use a single sentinel so the loop body still runs
  // once per (tsl, tp) combo without a separate code path.
  const slValues: (number | null)[] = disableSL ? [null] : buildRange(config.slRange);

  // TP axis. Skipped (single sentinel) when ratio is locked — the actual TP
  // is derived inside the loop. The sentinel is meaningless in that branch.
  const tpAxis: number[] = ratio !== null ? [0] : buildRange(config.tpRange);

  // TSL values: null = trailing stop disabled. Three branches:
  //   disableTSL on → exactly [null] (TSL off for every combo).
  //   disableSL on  → no null sentinel (TSL must be on, it's the only stop).
  //   otherwise     → range, plus optional null when includeTslDisabled is on.
  const tslValues: (number | null)[] = [];
  if (disableTSL) {
    tslValues.push(null);
  } else {
    if (!disableSL && config.includeTslDisabled) tslValues.push(null);
    for (const v of buildRange(config.tslRange)) tslValues.push(v);
  }

  const totalCombos = slValues.length * tpAxis.length * tslValues.length;
  const YIELD_INTERVAL = 200; // Yield progress every N combos

  let tested = 0;
  let bestTotalPoints = -Infinity;
  let bestSummary: SimSummary | null = null;
  let bestSl: number | null = slValues[0];
  let bestTp: number = tpAxis[0];
  let bestTsl: number | null = null;

  for (const sl of slValues) {
    for (const tsl of tslValues) {
      // Compute the TP iteration for this (sl, tsl). With ratio locked, TP is
      // derived from the active stop (SL when enabled, otherwise TSL); with
      // ratio Free, TP comes from the grid axis built above.
      let tps: number[];
      if (ratio !== null) {
        const base = disableSL ? (typeof tsl === "number" ? tsl : null) : sl;
        tps = base !== null ? [base * ratio] : [];
      } else {
        tps = tpAxis;
      }

      for (const tp of tps) {
        // Bounds check for derived TPs — count them as tested so the progress
        // bar still tracks the pre-computed totalCombos accurately.
        if (ratio !== null && (tp < config.tpRange.min || tp > config.tpRange.max)) {
          tested++;
          continue;
        }

        const testRules: SimRules = {
          ...baseRules,
          stopLossEnabled: !disableSL,
          // When disabled, leave the user's existing SL points untouched so
          // toggling the modal's "disable" off later restores their value.
          stopLossPoints: disableSL ? baseRules.stopLossPoints : (sl as number),
          takeProfitEnabled: true,
          takeProfitPoints: tp,
          // disableTSL forces it off; otherwise disableSL forces it on (TSL is
          // the only stop) and the null sentinel toggles it off when chosen.
          trailingStopEnabled: disableTSL ? false : disableSL || tsl !== null,
          trailingStopPoints: tsl ?? baseRules.trailingStopPoints,
        };

        // Run simulation and compute summary — pass atrByZoneId so SL/TP/TSL
        // values are interpreted as ATR multipliers when atrModeEnabled is on.
        // NOTE: in ATR mode, the optimizer's grid values (e.g. slRange 2..50)
        // become ATR multipliers, not points. Use a smaller grid in that case.
        const results = simulateAllZones(zones, barsByZoneId, testRules, atrByZoneId);
        const summary = computeSimSummary(results);

        // Pick the comparison primary by the configured objective.
        //   total-points: max aggregate P&L; tie-break on profit factor.
        //   sharpe:       max per-trade Sharpe (smoother equity curve);
        //                 tie-break on totalPoints so two combos with the
        //                 same risk-adjusted return prefer more raw P&L.
        //   balanced:     during the loop we just track a "running best by
        //                 points" so the progress yield has something to
        //                 show; the actual winner is picked AFTER the loop
        //                 by a min-max normalization pass over `candidates`.
        // Empty / degenerate result sets produce 0/0/0 summaries which lose
        // every comparison naturally.
        let isBetter = false;
        if (objective === "sharpe") {
          if (summary.sharpeSimulated > (bestSummary?.sharpeSimulated ?? -Infinity)) {
            isBetter = true;
          } else if (
            bestSummary !== null &&
            summary.sharpeSimulated === bestSummary.sharpeSimulated &&
            summary.totalPoints > bestSummary.totalPoints
          ) {
            isBetter = true;
          }
        } else {
          // total-points AND balanced both use the "best totalPoints so far"
          // as the running best for progress display purposes.
          if (summary.totalPoints > bestTotalPoints) {
            isBetter = true;
          } else if (
            summary.totalPoints === bestTotalPoints &&
            bestSummary !== null &&
            summary.profitFactor > bestSummary.profitFactor
          ) {
            isBetter = true;
          }
        }

        if (isBetter) {
          bestTotalPoints = summary.totalPoints;
          bestSummary = summary;
          bestSl = sl;
          bestTp = tp;
          bestTsl = tsl;
        }

        // For "balanced": record every candidate so we can normalize +
        // re-score at the end. The lightweight record is intentional —
        // storing full summaries here would chew memory on big runs.
        if (objective === "balanced") {
          candidates.push({
            sl,
            tp,
            tsl,
            totalPoints: summary.totalPoints,
            sharpe: summary.sharpeSimulated,
          });
        }

        tested++;

        // Yield progress at regular intervals
        if (tested % YIELD_INTERVAL === 0) {
          yield {
            progress: tested / totalCombos,
            current: buildResult(bestSl, bestTp, bestTsl, bestTotalPoints, bestSummary!, tested, startMs, disableSL, disableTSL, baseRules),
          };
        }
      }
    }
  }

  // ─── Balanced post-pass ────────────────────────────────────────────────
  // For total-points / sharpe objectives the running tracker above already
  // knows the winner — fall through to the standard buildResult. For
  // "balanced" we have to look across ALL candidates and pick the one with
  // the best weighted-and-normalized score, then re-simulate it to get the
  // final summary (we threw away each candidate's summary during the loop
  // to keep memory bounded).
  if (objective === "balanced" && candidates.length > 0) {
    let minP = Infinity, maxP = -Infinity;
    let minS = Infinity, maxS = -Infinity;
    for (const c of candidates) {
      if (c.totalPoints < minP) minP = c.totalPoints;
      if (c.totalPoints > maxP) maxP = c.totalPoints;
      if (c.sharpe < minS) minS = c.sharpe;
      if (c.sharpe > maxS) maxS = c.sharpe;
    }
    // Avoid divide-by-zero when every candidate has identical points or
    // identical Sharpe (degenerate but possible). In that case the
    // normalized component contributes 0 to the score, leaving the other
    // axis to break the tie naturally.
    const pSpan = maxP - minP;
    const sSpan = maxS - minS;

    let bestScore = -Infinity;
    let bestCandidate: Candidate | null = null;
    for (const c of candidates) {
      const np = pSpan > 0 ? (c.totalPoints - minP) / pSpan : 0;
      const ns = sSpan > 0 ? (c.sharpe - minS) / sSpan : 0;
      const score = pointsWeight * np + sharpeWeight * ns;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = c;
      }
    }

    if (bestCandidate !== null) {
      // Re-simulate the winner to recover its full summary. One extra
      // simulator pass at the end is cheap relative to the search itself
      // (10s of milliseconds vs. many seconds).
      const winnerRules: SimRules = {
        ...baseRules,
        stopLossEnabled: !disableSL,
        stopLossPoints: disableSL ? baseRules.stopLossPoints : (bestCandidate.sl as number),
        takeProfitEnabled: true,
        takeProfitPoints: bestCandidate.tp,
        trailingStopEnabled: disableTSL ? false : disableSL || bestCandidate.tsl !== null,
        trailingStopPoints: bestCandidate.tsl ?? baseRules.trailingStopPoints,
      };
      const winnerResults = simulateAllZones(zones, barsByZoneId, winnerRules, atrByZoneId);
      const winnerSummary = computeSimSummary(winnerResults);
      return buildResult(
        bestCandidate.sl,
        bestCandidate.tp,
        bestCandidate.tsl,
        bestCandidate.totalPoints,
        winnerSummary,
        tested,
        startMs,
        disableSL,
        disableTSL,
        baseRules
      );
    }
  }

  // Final result for total-points / sharpe (and the empty-candidates fallback
  // for balanced — same as the legacy behavior).
  return buildResult(bestSl, bestTp, bestTsl, bestTotalPoints, bestSummary!, tested, startMs, disableSL, disableTSL, baseRules);
}

/**
 * Build an OptimizeResult. When `disableSL` is true, the result preserves the
 * user's original SL points (so toggling disable off later restores them) and
 * marks `stopLossEnabled: false`; TSL is forced enabled. Otherwise behaves as
 * before — emit the searched SL/TP/TSL combo.
 */
function buildResult(
  sl: number | null,
  tp: number,
  tsl: number | null,
  totalPoints: number,
  summary: SimSummary,
  tested: number,
  startMs: number,
  disableSL: boolean,
  disableTSL: boolean,
  baseRules: SimRules
): OptimizeResult {
  return {
    bestRules: {
      stopLossEnabled: !disableSL,
      stopLossPoints: disableSL ? baseRules.stopLossPoints : (sl as number),
      takeProfitEnabled: true,
      takeProfitPoints: tp,
      // disableTSL: force off; otherwise disableSL forces on, else use sentinel.
      trailingStopEnabled: disableTSL ? false : disableSL || tsl !== null,
      trailingStopPoints: tsl ?? baseRules.trailingStopPoints,
    },
    bestExpectancy: summary.expectancy, // Derived from summary for display
    bestTotalPoints: totalPoints,
    bestSummary: summary,
    combinationsTested: tested,
    elapsedMs: Math.round(performance.now() - startMs),
  };
}

// `runOptimizeChunked` (the worker-backed runner) lives in
// `optimizer-worker-runner.ts`. Import it from there.

// ─── ATR-Adjust Optimizer ────────────────────────────────────────────────────
// Separate from the points optimizer because the search axes are completely
// different — we vary the *adjustment* terms (slAtrAdjust/tpAtrAdjust/...) while
// holding the user's proven base point values (stopLossPoints/...) FROZEN.
// Reuses the same OptimizeResult shape and rAF-chunked execution pattern.

/**
 * Generator that grids over (slAdjust × tpAdjust × trailAdjust), keeping the
 * user's base SL/TP/Trail point values frozen. The "found" result is applied
 * by merging the best adjustment values back into the rules.
 */
export function* atrAdjustOptimizeGenerator(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  baseRules: SimRules,
  config: AtrAdjustOptimizeConfig = DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG,
  atrByZoneId?: Map<number, number> | null
): Generator<OptimizeProgress, OptimizeResult, void> {
  const startMs = performance.now();

  // Build value arrays for each adjustment axis. Step 0.25 won't drift in
  // floating point because 0.25 is exact in binary.
  const slAdj: number[] = [];
  for (let v = config.slAdjustRange.min; v <= config.slAdjustRange.max + 1e-9; v += config.slAdjustRange.step) {
    slAdj.push(Math.round(v * 100) / 100);
  }
  const tpAdj: number[] = [];
  for (let v = config.tpAdjustRange.min; v <= config.tpAdjustRange.max + 1e-9; v += config.tpAdjustRange.step) {
    tpAdj.push(Math.round(v * 100) / 100);
  }
  const trailAdj: number[] = [];
  for (let v = config.trailAdjustRange.min; v <= config.trailAdjustRange.max + 1e-9; v += config.trailAdjustRange.step) {
    trailAdj.push(Math.round(v * 100) / 100);
  }

  const totalCombos = slAdj.length * tpAdj.length * trailAdj.length;
  const YIELD_INTERVAL = 200;

  let tested = 0;
  let bestTotalPoints = -Infinity;
  let bestSummary: SimSummary | null = null;
  let bestSlAdj = 0;
  let bestTpAdj = 0;
  let bestTrailAdj = 0;

  for (const sa of slAdj) {
    for (const ta of tpAdj) {
      for (const tla of trailAdj) {
        // Build test rules: keep user's base points frozen, vary only adjusts.
        // We do NOT toggle stopLossEnabled/etc here — if the user has a rule
        // off, it stays off and that adjust is irrelevant for this run.
        const testRules: SimRules = {
          ...baseRules,
          slAtrAdjust: sa,
          tpAtrAdjust: ta,
          trailAtrAdjust: tla,
        };

        const results = simulateAllZones(zones, barsByZoneId, testRules, atrByZoneId);
        const summary = computeSimSummary(results);

        // Same objective + tie-break as the points optimizer
        if (
          summary.totalPoints > bestTotalPoints ||
          (summary.totalPoints === bestTotalPoints &&
            bestSummary !== null &&
            summary.profitFactor > bestSummary.profitFactor)
        ) {
          bestTotalPoints = summary.totalPoints;
          bestSummary = summary;
          bestSlAdj = sa;
          bestTpAdj = ta;
          bestTrailAdj = tla;
        }

        tested++;

        if (tested % YIELD_INTERVAL === 0) {
          yield {
            progress: tested / totalCombos,
            current: buildAdjustResult(bestSlAdj, bestTpAdj, bestTrailAdj, bestTotalPoints, bestSummary!, tested, startMs),
          };
        }
      }
    }
  }

  return buildAdjustResult(bestSlAdj, bestTpAdj, bestTrailAdj, bestTotalPoints, bestSummary!, tested, startMs);
}

/** Build an OptimizeResult whose bestRules carries the adjustment values. */
function buildAdjustResult(
  slAdj: number,
  tpAdj: number,
  trailAdj: number,
  totalPoints: number,
  summary: SimSummary,
  tested: number,
  startMs: number
): OptimizeResult {
  return {
    bestRules: {
      slAtrAdjust: slAdj,
      tpAtrAdjust: tpAdj,
      trailAtrAdjust: trailAdj,
    },
    bestExpectancy: summary?.expectancy ?? 0,
    bestTotalPoints: totalPoints,
    bestSummary: summary,
    combinationsTested: tested,
    elapsedMs: Math.round(performance.now() - startMs),
  };
}

// `runAtrAdjustOptimizeChunked` (the worker-backed runner) lives in
// `optimizer-worker-runner.ts`. Import it from there.
