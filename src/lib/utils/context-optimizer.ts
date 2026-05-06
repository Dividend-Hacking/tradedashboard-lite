/**
 * Context-filter optimizers — one per filter in the simulator's context
 * bar (ADX / ATR / trend / Bollinger). Each function sweeps a candidate
 * grid, simulates the full rule set on each candidate's zone subset, and
 * returns the candidate with the highest average points per trade.
 *
 * Design choices (approved by user):
 *   - Metric: avg points/trade (same as the existing TIME optimizer).
 *   - Min trades: 20 — candidates producing fewer trades are skipped,
 *     preventing "optimize" from picking a lucky micro-subset.
 *   - Scope: each optimizer operates on a pre-built base pool that
 *     already has the OTHER currently-enabled filters applied, so
 *     narrowing is additive (respects the user's prior choices).
 *
 * The grids are intentionally small (< 100 candidates each), so each run
 * is < 100ms on a typical zone pool and doesn't need rAF-chunking.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimRules, simulateAllZones } from "./zone-simulator";

/** Minimum trades a candidate must produce to be considered valid. */
export const CONTEXT_OPT_MIN_TRADES = 20;

/** Shared shape: every optimizer returns at least a score + trade count. */
interface OptScore {
  /** Average scaledPoints across the simulated trades. Higher is better. */
  avg: number;
  /** Number of trades after applying the candidate — used to enforce the
   *  min-trades floor. */
  count: number;
}

/** Runs the simulator and returns avg points/trade. Returns avg=-Infinity
 *  when the candidate has fewer than CONTEXT_OPT_MIN_TRADES so the caller
 *  can safely compare with `avg > best.avg`. */
function scoreCandidate(
  zones: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): OptScore {
  if (zones.length < CONTEXT_OPT_MIN_TRADES) {
    return { avg: -Infinity, count: zones.length };
  }
  const results = simulateAllZones(zones, bars, rules, atr);
  if (results.length < CONTEXT_OPT_MIN_TRADES) {
    return { avg: -Infinity, count: results.length };
  }
  let sum = 0;
  for (const r of results) sum += r.scaledPoints;
  return { avg: sum / results.length, count: results.length };
}

// ─── ADX optimizer ──────────────────────────────────────────────────────
// ADX is 0–100 and clusters in the 10–40 band for NQ-like instruments.
// Bin set is denser in that region to catch meaningful edges. Exhaustive
// pairs = C(11, 2) = 55 candidates.
const ADX_BINS = [0, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100];

export interface AdxOptResult extends OptScore {
  min: number;
  max: number;
}

export function optimizeAdx(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): AdxOptResult | null {
  let best: AdxOptResult | null = null;
  for (let i = 0; i < ADX_BINS.length - 1; i++) {
    for (let j = i + 1; j < ADX_BINS.length; j++) {
      const min = ADX_BINS[i];
      const max = ADX_BINS[j];
      const filtered = basePool.filter(
        (z) => z.ctx_adx14 != null && z.ctx_adx14 >= min && z.ctx_adx14 <= max
      );
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) best = { min, max, avg, count };
    }
  }
  return best;
}

// ─── ATR optimizer ──────────────────────────────────────────────────────
// ATR bins tuned for NQ 5-min (typical: 3–25 pts). The 100 cap catches
// extreme-vol days without truncating. C(12, 2) = 66 candidates.
const ATR_BINS = [0, 2, 4, 6, 8, 10, 12, 15, 20, 30, 50, 100];

export interface AtrOptResult extends OptScore {
  min: number;
  max: number;
}

export function optimizeAtr(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): AtrOptResult | null {
  let best: AtrOptResult | null = null;
  for (let i = 0; i < ATR_BINS.length - 1; i++) {
    for (let j = i + 1; j < ATR_BINS.length; j++) {
      const min = ATR_BINS[i];
      const max = ATR_BINS[j];
      const filtered = basePool.filter(
        (z) => z.ctx_atr14 != null && z.ctx_atr14 >= min && z.ctx_atr14 <= max
      );
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) best = { min, max, avg, count };
    }
  }
  return best;
}

// ─── Trend optimizer ────────────────────────────────────────────────────
// 3×3 = 9 combinations of (ema20Mode × ema200Mode). We DO include
// ("any", "any") — it represents "trend filter off" and is the baseline
// a real edge must beat.
export type TrendMode = "any" | "with" | "against";
const TREND_MODES: TrendMode[] = ["any", "with", "against"];

export interface TrendOptResult extends OptScore {
  ema20Mode: TrendMode;
  ema200Mode: TrendMode;
}

/** Applies a single (ema20Mode, ema200Mode) candidate to a pool. Mirrors
 *  the live filter logic in simulator-panel.tsx so the optimizer and the
 *  runtime filter agree on semantics. */
function applyTrend(
  zones: TradeZone[],
  ema20Mode: TrendMode,
  ema200Mode: TrendMode
): TradeZone[] {
  if (ema20Mode === "any" && ema200Mode === "any") return zones;
  return zones.filter((z) => {
    const isLong = z.direction === "Long";
    if (ema20Mode !== "any") {
      if (z.ctx_price_vs_ema20 == null) return false;
      const isWith =
        (isLong && z.ctx_price_vs_ema20 === "above") ||
        (!isLong && z.ctx_price_vs_ema20 === "below");
      if (ema20Mode === "with" && !isWith) return false;
      if (ema20Mode === "against" && isWith) return false;
    }
    if (ema200Mode !== "any") {
      if (z.ctx_price_vs_ema200 == null) return false;
      const isWith =
        (isLong && z.ctx_price_vs_ema200 === "above") ||
        (!isLong && z.ctx_price_vs_ema200 === "below");
      if (ema200Mode === "with" && !isWith) return false;
      if (ema200Mode === "against" && isWith) return false;
    }
    return true;
  });
}

export function optimizeTrend(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): TrendOptResult | null {
  let best: TrendOptResult | null = null;
  for (const ema20Mode of TREND_MODES) {
    for (const ema200Mode of TREND_MODES) {
      const filtered = applyTrend(basePool, ema20Mode, ema200Mode);
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) best = { ema20Mode, ema200Mode, avg, count };
    }
  }
  return best;
}

// ─── Bollinger optimizer ────────────────────────────────────────────────
// 7 non-empty subsets of {above_upper, inside, below_lower}. We skip the
// empty set (no zones) and include the full set (same as filter off).
const BB_POSITIONS = ["above_upper", "inside", "below_lower"] as const;
type BbPos = (typeof BB_POSITIONS)[number];

export interface BollingerOptResult extends OptScore {
  allowed: BbPos[];
}

/** Yields all 7 non-empty subsets as sorted arrays for stable JSON output. */
function* bollingerSubsets(): Generator<BbPos[]> {
  // 2^3 - 1 = 7 non-empty subsets. Bitmask enumeration is tidier than
  // hand-writing seven arrays.
  for (let mask = 1; mask < 1 << BB_POSITIONS.length; mask++) {
    const subset: BbPos[] = [];
    for (let k = 0; k < BB_POSITIONS.length; k++) {
      if (mask & (1 << k)) subset.push(BB_POSITIONS[k]);
    }
    yield subset;
  }
}

export function optimizeBollinger(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): BollingerOptResult | null {
  let best: BollingerOptResult | null = null;
  for (const subset of bollingerSubsets()) {
    const allowed = new Set<string>(subset);
    const filtered = basePool.filter(
      (z) => z.ctx_bollinger_pos != null && allowed.has(z.ctx_bollinger_pos)
    );
    const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
    if (avg === -Infinity) continue;
    if (!best || avg > best.avg) best = { allowed: subset, avg, count };
  }
  return best;
}

// ─── RSI optimizer ──────────────────────────────────────────────────────
// RSI is 0–100. Bins denser around the conventional oversold (30) and
// overbought (70) cutoffs since most useful gates land there. Pairs =
// C(11, 2) = 55 candidates.
const RSI_BINS = [0, 20, 30, 40, 45, 50, 55, 60, 70, 80, 100];

export interface RsiOptResult extends OptScore {
  min: number;
  max: number;
}

export function optimizeRsi(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): RsiOptResult | null {
  let best: RsiOptResult | null = null;
  for (let i = 0; i < RSI_BINS.length - 1; i++) {
    for (let j = i + 1; j < RSI_BINS.length; j++) {
      const min = RSI_BINS[i];
      const max = RSI_BINS[j];
      const filtered = basePool.filter(
        (z) => z.ctx_rsi != null && z.ctx_rsi >= min && z.ctx_rsi <= max
      );
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) best = { min, max, avg, count };
    }
  }
  return best;
}

// ─── BB-width optimizer ─────────────────────────────────────────────────
// Band width is data-dependent (NQ 5-min bands run very differently from
// CL 1-min), so fixed bins would either be too coarse for tight markets
// or miss the high-vol tail. We compute percentile-based candidates from
// the basePool's own bw distribution, then sweep min/max pairs over those
// percentiles. Result: the optimizer always has bins that actually
// partition the data into roughly-equal-sized groups.
//
// 9 percentile candidates → C(9, 2) + 1 = 37 pairs (including [0, max]
// which is "filter off"). Cheap.
const BB_WIDTH_PERCENTILES = [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1];

export interface BbWidthOptResult extends OptScore {
  min: number;
  max: number;
}

export function optimizeBbWidth(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): BbWidthOptResult | null {
  // Collect non-null BW values, sort ascending so percentile lookup is
  // a simple index calc. Empty / all-null → no candidate to evaluate.
  const widths: number[] = [];
  for (const z of basePool) {
    if (z.ctx_bollinger_bw != null && Number.isFinite(z.ctx_bollinger_bw)) {
      widths.push(z.ctx_bollinger_bw);
    }
  }
  if (widths.length < CONTEXT_OPT_MIN_TRADES) return null;
  widths.sort((a, b) => a - b);
  const pctValue = (p: number): number => {
    const idx = Math.min(widths.length - 1, Math.max(0, Math.floor(p * (widths.length - 1))));
    return widths[idx];
  };
  // Round to 2dp so the saved min/max look like clean numbers in the UI.
  const cands = BB_WIDTH_PERCENTILES.map((p) => Math.round(pctValue(p) * 100) / 100);

  let best: BbWidthOptResult | null = null;
  for (let i = 0; i < cands.length - 1; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const min = cands[i];
      const max = cands[j];
      if (max < min) continue;
      const filtered = basePool.filter(
        (z) =>
          z.ctx_bollinger_bw != null &&
          z.ctx_bollinger_bw >= min &&
          z.ctx_bollinger_bw <= max
      );
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) best = { min, max, avg, count };
    }
  }
  return best;
}

// ─── MA-distance optimizer ──────────────────────────────────────────────
// Distance is in ATR units, so bins are fixed-but-wide enough to span the
// typical [-5, 5] range. Tries all THREE modes (absolute / above / below)
// and keeps the best-performing combination. Bins for absolute mode use
// the positive side; above/below mirror via sign filtering.
const MA_DIST_BINS = [0, 0.25, 0.5, 1, 1.5, 2, 3, 5];

export interface MaDistanceOptResult extends OptScore {
  mode: "absolute" | "above" | "below";
  min: number;
  max: number;
}

function maDistanceFilterMatches(
  d: number,
  mode: "absolute" | "above" | "below",
  min: number,
  max: number
): boolean {
  if (mode === "absolute") {
    const ad = Math.abs(d);
    return ad >= min && ad <= max;
  }
  if (mode === "above") {
    if (d < 0) return false;
    return d >= min && d <= max;
  }
  if (d > 0) return false;
  const ad = Math.abs(d);
  return ad >= min && ad <= max;
}

export function optimizeMaDistance(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): MaDistanceOptResult | null {
  let best: MaDistanceOptResult | null = null;
  const modes: ("absolute" | "above" | "below")[] = ["absolute", "above", "below"];
  for (const mode of modes) {
    for (let i = 0; i < MA_DIST_BINS.length - 1; i++) {
      for (let j = i + 1; j < MA_DIST_BINS.length; j++) {
        const min = MA_DIST_BINS[i];
        const max = MA_DIST_BINS[j];
        const filtered = basePool.filter((z) => {
          const d = z.ctx_ma_distance_atr ?? null;
          if (d == null) return false;
          return maDistanceFilterMatches(d, mode, min, max);
        });
        const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
        if (avg === -Infinity) continue;
        if (!best || avg > best.avg) best = { mode, min, max, avg, count };
      }
    }
  }
  return best;
}

// ─── Volume-ratio optimizer ─────────────────────────────────────────────
// Ratio is 0..N where 1 = at average. Bins cover below-average through
// 5x average — the 5x ceiling catches high-vol spikes without bleeding
// into the long tail.
const VOLUME_BINS = [0, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 100];

export interface VolumeOptResult extends OptScore {
  min: number;
  max: number;
}

export function optimizeVolume(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): VolumeOptResult | null {
  let best: VolumeOptResult | null = null;
  for (let i = 0; i < VOLUME_BINS.length - 1; i++) {
    for (let j = i + 1; j < VOLUME_BINS.length; j++) {
      const min = VOLUME_BINS[i];
      const max = VOLUME_BINS[j];
      const filtered = basePool.filter(
        (z) =>
          z.ctx_volume_ratio != null &&
          z.ctx_volume_ratio >= min &&
          z.ctx_volume_ratio <= max
      );
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) best = { min, max, avg, count };
    }
  }
  return best;
}

// ─── ADX direction optimizer ────────────────────────────────────────────
// Tries each non-baseline mode (rising/falling/flat) at a small set of
// flatThreshold candidates and picks the best. We DON'T include "any"
// in the search since that's the no-op baseline (filter off) the user is
// already comparing against. Lookback is held at the basePool's stamped
// value — changing lookback would require re-running the backtest with a
// different IndicatorConfig, outside the optimizer's scope.
export type AdxTrendDir = "rising" | "falling" | "flat";
const ADX_TREND_DIRS: AdxTrendDir[] = ["rising", "falling", "flat"];
// Threshold candidates in ADX points. 0 = treat any non-zero slope as
// rising/falling; larger values widen the flat band. Five candidates
// keeps the search cheap (3 modes × 5 thresholds = 15 evals).
const ADX_TREND_THRESHOLDS = [0, 0.5, 1, 2, 4];

export interface AdxTrendOptResult extends OptScore {
  mode: AdxTrendDir;
  flatThreshold: number;
}

function adxTrendMatches(
  slope: number,
  mode: AdxTrendDir,
  thresh: number
): boolean {
  if (mode === "rising") return slope > thresh;
  if (mode === "falling") return slope < -thresh;
  return Math.abs(slope) <= thresh;
}

export function optimizeAdxTrend(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): AdxTrendOptResult | null {
  let best: AdxTrendOptResult | null = null;
  for (const mode of ADX_TREND_DIRS) {
    for (const t of ADX_TREND_THRESHOLDS) {
      const filtered = basePool.filter((z) => {
        const slope = z.ctx_adx_slope ?? null;
        if (slope == null) return false;
        return adxTrendMatches(slope, mode, t);
      });
      const { avg, count } = scoreCandidate(filtered, bars, rules, atr);
      if (avg === -Infinity) continue;
      if (!best || avg > best.avg) {
        best = { mode, flatThreshold: t, avg, count };
      }
    }
  }
  return best;
}
