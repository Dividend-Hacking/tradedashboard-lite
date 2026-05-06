/**
 * Backtest Engine
 *
 * Strategy-driven backtesting on top of replay_sessions / replay_bars data.
 *
 * Pipeline:
 *   1. A `StrategyDef` consumes a per-session bar array and emits
 *      `{ barIndex, direction }` entry events. Each strategy exposes a
 *      `paramFields` schema so the UI can render numeric inputs for every
 *      tunable knob (lookback, ATR thresholds, lockout windows, etc).
 *   2. For each event, `runBacktestForSession` builds a SYNTHETIC TradeZone
 *      and TradeZoneBar[] starting at the entry bar (bar_index 0) and going
 *      forward `maxHoldBars` bars, then hands them to the existing
 *      `simulateAllZones` from zone-simulator.ts. This re-uses the proven
 *      SL/TP/Trail/BE/Timer exit logic and ALL the summary stats — so the
 *      backtest output drops directly into SimulatorStatCards / SimulatorTable
 *      / SimulatorResultsChart with zero changes.
 *   3. `runBacktestAcrossSessions` fans out across multiple sessions
 *      (selected days) and concatenates the results. Synthetic zone IDs are
 *      kept globally unique by offsetting per session so the overlap
 *      handling and table key-uniqueness keep working.
 *
 * Why duplicate the signal math here instead of re-using calculations.ts?
 * The chart indicators take only a `lookback` knob and bake every other
 * threshold as a stable constant — that keeps the indicator panel UI simple.
 * Backtesting needs to expose ALL of those constants as adjustable parameters,
 * so this module owns its own parameterized copy. The default values match
 * calculations.ts exactly (sourced from the same calibration), so the default
 * backtest matches what users see plotted on the chart.
 */

import { ReplayBar } from "@/types/replay";
import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import {
  SimRules,
  SimZoneResult,
  SimSummary,
  simulateAllZones,
  computeSimSummary,
} from "./zone-simulator";
import { precomputeIndicators, maxIndicatorPeriod } from "./script-expr";
import { runOnlineOptimizedBacktest } from "./script-online-optimizer";

// ─── Public types ───────────────────────────────────────────────────────────

/** A single entry signal — strategies emit these. The entry price is taken
 *  as bars[barIndex].bar_close (i.e. we fill on the close of the trigger
 *  candle, same convention as practice trading). */
export interface BacktestSignal {
  barIndex: number;
  direction: "Long" | "Short";
}

/** UI param-field descriptor. Used by the dashboard to auto-render a labeled
 *  numeric input for every adjustable strategy knob. */
export interface StrategyParamField {
  key: string;
  label: string;
  type: "int" | "float";
  min: number;
  max: number;
  step: number;
  default: number;
  description?: string;
}

/** A strategy: name, parameter schema, and a pure function from bars+params
 *  to entry signals. The dashboard treats StrategyDefs as a flat registry —
 *  add a new entry to STRATEGIES below to expose a new strategy in the UI. */
export interface StrategyDef {
  id: string;
  label: string;
  description: string;
  paramFields: StrategyParamField[];
  generateSignals: (
    bars: ReplayBar[],
    params: Record<string, number>
  ) => BacktestSignal[];
}

// ─── Shared helpers (Wilder ATR series, index-aligned) ─────────────────────

/** Simple moving average aligned 1-to-1 with `bars`, NaN before warmup.
 *  Used by the configurable trend / MA-distance filters when the user picks
 *  type="sma". Math is straightforward — average of the last `period`
 *  closes. */
function smaSeries(bars: ReplayBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].bar_close;
  out[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    sum += bars[i].bar_close - bars[i - period].bar_close;
    out[i] = sum / period;
  }
  return out;
}

/** Rolling-mean of bar volume, aligned 1-to-1 with `bars`. NaN before warmup.
 *  Drives the volume filter — current bar volume / N-bar average gives a
 *  ratio the user can clamp to a [min, max] band. */
function volumeMaSeries(bars: ReplayBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].bar_volume ?? 0;
  out[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    sum += (bars[i].bar_volume ?? 0) - (bars[i - period].bar_volume ?? 0);
    out[i] = sum / period;
  }
  return out;
}

/** Dispatch to ema or sma based on a config string. Lets every "MA filter"
 *  in the system pick its smoothing flavor without each filter having to
 *  duplicate the dispatch. */
function maSeriesByType(
  bars: ReplayBar[],
  period: number,
  type: "ema" | "sma"
): number[] {
  return type === "sma" ? smaSeries(bars, period) : emaSeries(bars, period);
}

/** Wilder ATR aligned 1-to-1 with `bars` (NaN before warmup). Same math as
 *  the `atrSeries` helper in calculations.ts — duplicated here so this module
 *  has zero coupling to the indicator-rendering code. */
function atrSeries(bars: ReplayBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (bars.length < period + 1) return out;

  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].bar_high;
    const l = bars[i].bar_low;
    const pc = bars[i - 1].bar_close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  let seed = 0;
  for (let i = 0; i < period; i++) seed += trs[i];
  let prev = seed / period;
  out[period] = prev;

  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}

/** EMA aligned 1-to-1 with `bars`, NaN before warmup. SMA-seeded for the
 *  first valid value at index `period - 1`, then standard 2/(period+1)
 *  smoothing. Mirrors `emaSeries` in calculations.ts so the values match
 *  what the chart panel renders. */
function emaSeries(bars: ReplayBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period) return out;
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

/** Wilder ADX aligned 1-to-1 with `bars`. NaN before the warmup window
 *  (first valid index = 2 × period - 1, since DX is Wilder-smoothed twice).
 *  Math mirrors `adxSeries` in calculations.ts; comments there explain the
 *  per-step alignment. */
function adxSeries(bars: ReplayBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < 2 * period + 1) return out;

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

  let adxSum = 0;
  for (let i = 0; i < period; i++) adxSum += dx[i];
  let prev = adxSum / period;
  out[2 * period - 1] = prev;
  for (let i = period; i < dx.length; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i + period] = prev;
  }
  return out;
}

/** Wilder RSI aligned 1-to-1 with `bars`, NaN before warmup. Standard
 *  Wilder smoothing on gain/loss arrays — same convention NinjaTrader's
 *  built-in RSI uses, so the C# port can be a direct mirror without
 *  divergence on identical inputs. First valid index = `period`. */
function rsiSeries(bars: ReplayBar[], period: number): number[] {
  const out = new Array(bars.length).fill(NaN);
  if (period <= 0 || bars.length < period + 1) return out;

  // Per-bar gains / losses. Same length as bars, with index 0 = 0
  // (no previous bar to diff against).
  const gains: number[] = new Array(bars.length).fill(0);
  const losses: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].bar_close - bars[i - 1].bar_close;
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  // Seed: simple averages over the first `period` gain/loss values
  // (indices 1..period). Final RSI for the seed bar lands at out[period].
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // Avoid div-by-zero — when avgLoss is zero we treat RSI as 100
  // (all gains, no losses).
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < bars.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Bollinger band metadata at every bar index. The position string matches
 *  the convention used elsewhere in the app: "above_upper" when close is
 *  above the +2σ band, "below_lower" when below the −2σ band, "inside"
 *  otherwise. `bw` is band width in price units (upper − lower) — useful
 *  for downstream filters even though the current UI doesn't surface it.
 *  NaN/null before the warmup window. */
interface BollingerPoint {
  pos: "above_upper" | "inside" | "below_lower" | null;
  bw: number;
}
function bollingerSeries(
  bars: ReplayBar[],
  period: number,
  multiplier: number
): BollingerPoint[] {
  const out: BollingerPoint[] = new Array(bars.length).fill(null).map(() => ({
    pos: null,
    bw: NaN,
  }));
  if (period <= 0 || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].bar_close;
    const mean = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = bars[j].bar_close - mean;
      varSum += d * d;
    }
    // Sample stddev (n-1 divisor) — matches the convention most charting
    // libraries use for Bollinger; switching to population would shift the
    // bands marginally tighter.
    const stdev = Math.sqrt(varSum / Math.max(1, period - 1));
    const upper = mean + multiplier * stdev;
    const lower = mean - multiplier * stdev;
    const close = bars[i].bar_close;
    out[i] = {
      pos:
        close > upper
          ? "above_upper"
          : close < lower
            ? "below_lower"
            : "inside",
      bw: upper - lower,
    };
  }
  return out;
}

/** Knob bag for the context-series builder — every indicator the dashboard
 *  exposes through filters and ATR-adjustments has its period and (where
 *  relevant) its smoothing flavor here. Defaults reproduce the legacy
 *  hardcoded behavior so callers that don't pass a config get identical
 *  output to the pre-customization version. Nothing in this struct is
 *  optional at the type level — `defaultIndicatorConfig()` builds the full
 *  shape so callers stay defensive against future fields. */
export interface IndicatorConfig {
  /** Wilder ATR period — drives `ctx_atr14`, the ATR filter, and the
   *  per-rule ATR-adjust math (SL/TP/Trail/BE × ATR). The field name
   *  stays `ctx_atr14` for backwards compat with stored real zones, but
   *  the value is computed with this period. */
  atrPeriod: number;
  /** Wilder ADX period — drives `ctx_adx14` and the ADX filter. Same
   *  field-name preservation as ATR. */
  adxPeriod: number;
  /** Bollinger SMA period (the band's centerline). */
  bbPeriod: number;
  /** Bollinger stddev multiplier — bandwidth = mean ± multiplier × σ. */
  bbStdDev: number;
  /** "Fast" leg of the trend filter and the source for `ctx_ema20` /
   *  `ctx_price_vs_ema20` / `ctx_dist_ema20_atr`. Period and type
   *  configurable so users can swap a 9-EMA in or move to an SMA. */
  trendFastPeriod: number;
  trendFastType: "ema" | "sma";
  /** "Slow" leg of the trend filter (`ctx_ema200`, `ctx_price_vs_ema200`). */
  trendSlowPeriod: number;
  trendSlowType: "ema" | "sma";
  /** Reference MA for the new "distance from MA" filter — fully
   *  independent of the trend-filter MAs so users can filter on, say,
   *  EMA(50) distance while still using EMA(20)/EMA(200) for trend. */
  maDistancePeriod: number;
  maDistanceType: "ema" | "sma";
  /** N-bar average of `bar_volume` for the volume-ratio filter. */
  volumeMaPeriod: number;
  /** Wilder RSI period for the RSI range filter. Default 14 — same
   *  convention NinjaTrader's built-in RSI uses. */
  rsiPeriod: number;
  /** Number of bars looked back when computing the ADX slope (rising /
   *  falling / flat). Slope = ADX[i] - ADX[i - lookback]. Default 5
   *  bars — short enough to react to regime shifts, long enough to
   *  smooth single-bar noise. */
  adxSlopeLookback: number;
}

/** Defaults reproduce the legacy hardcoded values so a caller that omits
 *  the config gets ATR(14), ADX(14), EMA(20), EMA(200), Bollinger(20, 2)
 *  — same output the dashboard produced before periods were exposed. */
export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  atrPeriod: 14,
  adxPeriod: 14,
  bbPeriod: 20,
  bbStdDev: 2,
  trendFastPeriod: 20,
  trendFastType: "ema",
  trendSlowPeriod: 200,
  trendSlowType: "ema",
  maDistancePeriod: 50,
  maDistanceType: "ema",
  volumeMaPeriod: 20,
  rsiPeriod: 14,
  adxSlopeLookback: 5,
};

/** Pre-computed context series for one session — passed to each signal's
 *  context lookup so we don't recompute the indicators per signal.
 *  Exported so the live auto-trader can reuse the same indicator math
 *  on its rolling bar buffer.
 *
 *  Field names keep the legacy `_14` / `_20` / `_200` suffixes for
 *  backwards compat with stored real zones, but the underlying values
 *  are computed using whatever periods `IndicatorConfig` specified.
 *  `maDistance` and `volumeMa` are new fields added to support the
 *  distance-from-MA and volume-ratio filters. */
export interface ContextSeries {
  atr14: number[];
  adx14: number[];
  ema20: number[];   // trend filter "fast" leg
  ema200: number[];  // trend filter "slow" leg
  bollinger: BollingerPoint[];
  maDistance: number[];
  volumeMa: number[];
  rsi: number[];
}

export function buildContextSeries(
  bars: ReplayBar[],
  config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG
): ContextSeries {
  return {
    atr14: atrSeries(bars, config.atrPeriod),
    adx14: adxSeries(bars, config.adxPeriod),
    ema20: maSeriesByType(bars, config.trendFastPeriod, config.trendFastType),
    ema200: maSeriesByType(bars, config.trendSlowPeriod, config.trendSlowType),
    bollinger: bollingerSeries(bars, config.bbPeriod, config.bbStdDev),
    maDistance: maSeriesByType(
      bars,
      config.maDistancePeriod,
      config.maDistanceType
    ),
    volumeMa: volumeMaSeries(bars, config.volumeMaPeriod),
    rsi: rsiSeries(bars, config.rsiPeriod),
  };
}

/** Per-bar context snapshot, stamped onto a synthetic zone's `ctx_*` fields
 *  so the existing context filters and optimizers (which read those fields)
 *  work against backtest signals identically to real trade zones. Exported
 *  for live auto-trader reuse.
 *
 *  Fields with `_14` / `_20` / `_200` suffixes preserve the legacy column
 *  names (real zones in Supabase still use them) but their VALUES now
 *  reflect whatever IndicatorConfig was passed when the snapshot was
 *  built. New fields below the legacy block back the
 *  distance-from-MA and volume-ratio filters added in the
 *  customization pass. */
export interface ContextSnapshot {
  ctx_atr14: number | null;
  ctx_adx14: number | null;
  ctx_ema20: number | null;
  ctx_ema200: number | null;
  ctx_price_vs_ema20: string | null;
  ctx_price_vs_ema200: string | null;
  ctx_dist_ema20_atr: number | null;
  ctx_bollinger_pos: string | null;
  ctx_bollinger_bw: number | null;
  /** Signed distance from the configurable maDistance MA in price points
   *  (close − MA). Long-positive when price is above the MA; short users
   *  who want "below" filter against the negative side. Null when the MA
   *  hasn't warmed up. */
  ctx_ma_distance_value: number | null;
  /** Same distance normalized by ATR — useful when comparing across
   *  instruments / volatility regimes. Null when ATR or the MA hasn't
   *  warmed up. */
  ctx_ma_distance_atr: number | null;
  /** Signed distance from the trend filter's slow MA in ATR units —
   *  symmetric with `ctx_dist_ema20_atr` so a "distance from EMA200"
   *  filter slot has a value to read. */
  ctx_dist_ema200_atr: number | null;
  /** Raw bar volume at entry. */
  ctx_volume: number | null;
  /** bar_volume / N-bar average volume — 1.0 = average, > 1 = above
   *  average, < 1 = below. Drives the volume filter. */
  ctx_volume_ratio: number | null;
  /** Wilder RSI value at entry. 0–100. Drives the RSI range filter. */
  ctx_rsi: number | null;
  /** ADX slope at entry — ADX[i] − ADX[i − adxSlopeLookback]. Positive
   *  = ADX rising (trend strength building), negative = falling (trend
   *  losing strength), near zero = flat. Drives the ADX-direction
   *  filter. Null when the lookback bar isn't available. */
  ctx_adx_slope: number | null;
}

/** Materialize the snapshot at one bar index. Each field gracefully falls
 *  back to null when its underlying indicator hasn't warmed up yet (e.g.,
 *  EMA200 needs 200 bars; signals fired earlier than that just have a null
 *  ctx_ema200 and are dropped by any filter that requires it — same
 *  behavior as legacy zones with missing context). */
export function snapshotContext(
  ctx: ContextSeries,
  closeAtBar: number,
  index: number,
  bar?: ReplayBar,
  /** Bars to look back when computing the ADX slope. Optional so older
   *  callers compile; defaults to the IndicatorConfig default of 5. */
  adxSlopeLookback: number = DEFAULT_INDICATOR_CONFIG.adxSlopeLookback
): ContextSnapshot {
  const atr = ctx.atr14[index];
  const adx = ctx.adx14[index];
  const e20 = ctx.ema20[index];
  const e200 = ctx.ema200[index];
  const bb = ctx.bollinger[index] ?? { pos: null, bw: NaN };
  const maDist = ctx.maDistance[index];
  const volMa = ctx.volumeMa[index];
  const rsi = ctx.rsi[index];
  // ADX slope — current ADX minus ADX `adxSlopeLookback` bars ago.
  // Both bars must have a valid ADX (post-warmup) for the slope to be
  // meaningful; otherwise null so the filter drops the entry.
  const lookbackIdx = index - Math.max(1, adxSlopeLookback);
  const adxPrev = lookbackIdx >= 0 ? ctx.adx14[lookbackIdx] : NaN;
  const adxSlope =
    Number.isFinite(adx) && Number.isFinite(adxPrev)
      ? adx - adxPrev
      : NaN;

  const finite = (v: number) => (Number.isFinite(v) ? v : null);
  const priceVs = (ema: number) =>
    Number.isFinite(ema) ? (closeAtBar > ema ? "above" : "below") : null;
  // Normalized distance from the trend filter's fast/slow MAs in ATR
  // units — the simulator's trend-context filters read these. Field
  // name is "ema20" for the fast leg only because of the legacy zone
  // schema; the value reflects whatever fastPeriod/fastType the config
  // specified.
  const distFastAtr =
    Number.isFinite(e20) && Number.isFinite(atr) && atr > 0
      ? (closeAtBar - e20) / atr
      : null;
  const distSlowAtr =
    Number.isFinite(e200) && Number.isFinite(atr) && atr > 0
      ? (closeAtBar - e200) / atr
      : null;
  // Distance to the dedicated maDistance MA — both raw points and
  // ATR-normalized so the filter UI can offer either flavor.
  const maDistanceValue = Number.isFinite(maDist) ? closeAtBar - maDist : null;
  const maDistanceAtr =
    maDistanceValue !== null && Number.isFinite(atr) && atr > 0
      ? maDistanceValue / atr
      : null;
  // Volume ratio — defensive against zero/missing volume bars (some
  // datasets have null volume rows that would NaN the divide).
  const rawVolume = bar ? bar.bar_volume ?? null : null;
  const volumeRatio =
    rawVolume !== null && Number.isFinite(volMa) && volMa > 0
      ? rawVolume / volMa
      : null;

  return {
    ctx_atr14: finite(atr),
    ctx_adx14: finite(adx),
    ctx_ema20: finite(e20),
    ctx_ema200: finite(e200),
    ctx_price_vs_ema20: priceVs(e20),
    ctx_price_vs_ema200: priceVs(e200),
    ctx_dist_ema20_atr: distFastAtr,
    ctx_bollinger_pos: bb.pos,
    ctx_bollinger_bw: Number.isFinite(bb.bw) ? bb.bw : null,
    ctx_ma_distance_value: maDistanceValue,
    ctx_ma_distance_atr: maDistanceAtr,
    ctx_dist_ema200_atr: distSlowAtr,
    ctx_volume: rawVolume,
    ctx_volume_ratio: volumeRatio,
    ctx_rsi: Number.isFinite(rsi) ? rsi : null,
    ctx_adx_slope: Number.isFinite(adxSlope) ? adxSlope : null,
  };
}

// ─── Strategy: Signal V1 (range-break + pullback) ───────────────────────────
//
// Mirrors signalTriangles() in src/lib/indicators/calculations.ts, with every
// hard-coded threshold promoted to a parameter. Defaults match the indicator
// constants so a default backtest aligns with the on-chart triangles.

const SIGNAL_V1_FIELDS: StrategyParamField[] = [
  { key: "lookback", label: "Lookback (bars)", type: "int", min: 5, max: 200, step: 1, default: 20,
    description: "Range window — pre-entry bars used to compute high/low extremes" },
  { key: "atrPeriod", label: "ATR period", type: "int", min: 5, max: 50, step: 1, default: 14,
    description: "Wilder ATR period — drives all ATR-relative thresholds below" },
  { key: "atEdgeThreshold", label: "At-edge threshold", type: "float", min: 0.5, max: 1.5, step: 0.05, default: 0.85,
    description: "Position-in-range >= this fires unconditionally (poking the extreme)" },
  { key: "nearEdgeThreshold", label: "Near-edge threshold", type: "float", min: 0, max: 1, step: 0.05, default: 0.5,
    description: "Position-in-range >= this fires only when there's a small counter-trend pullback" },
  { key: "pullbackAtrFraction", label: "Pullback × ATR", type: "float", min: 0, max: 2, step: 0.1, default: 0.4,
    description: "Allowed counter-trend pullback magnitude in ATR units (F1 filter)" },
  { key: "flatAtrFraction", label: "Flat × ATR", type: "float", min: 0, max: 1, step: 0.05, default: 0.2,
    description: "If both 5- and 10-bar moves are within ±this × ATR → reject (F2 flat momentum)" },
  { key: "staleBreakThreshold", label: "Stale-break threshold", type: "float", min: 1, max: 2, step: 0.05, default: 1.05,
    description: "Position > this is a true breakout — combined with stale-bars below to reject re-tests" },
  { key: "staleBarsBack", label: "Stale bars back", type: "int", min: 0, max: 50, step: 1, default: 15,
    description: "If breaking a level set more than this many bars ago → reject (F3 stale level)" },
];

function signalV1Events(bars: ReplayBar[], p: Record<string, number>): BacktestSignal[] {
  const lookback = Math.max(1, Math.floor(p.lookback));
  const atrPeriod = Math.max(2, Math.floor(p.atrPeriod));
  const atEdge = p.atEdgeThreshold;
  const nearEdge = p.nearEdgeThreshold;
  const pullbackFrac = p.pullbackAtrFraction;
  const flatFrac = p.flatAtrFraction;
  const staleThresh = p.staleBreakThreshold;
  const staleBack = Math.floor(p.staleBarsBack);

  // We need: lookback historical bars + ATR warmup + 5-bar momentum window
  const minIndex = Math.max(lookback, atrPeriod + 1, 5);
  if (bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, atrPeriod);
  const events: BacktestSignal[] = [];

  for (let i = minIndex; i < bars.length; i++) {
    const atrV = atrVals[i];
    if (!Number.isFinite(atrV) || atrV <= 0) continue;

    // Pre-entry range over bars[i-lookback..i-1] (excludes the trigger bar)
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
    if (range <= 0) continue;

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const longPos = (close - rangeLow) / range;
    const shortPos = (rangeHigh - close) / range;

    const move5 = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[Math.max(0, i - 10)].bar_close;

    // F2 flat momentum
    const flatBound = flatFrac * atrV;
    if (Math.abs(move5) < flatBound && Math.abs(move10) < flatBound) continue;

    // ─── Long branch ────────────────────────────────────────────────
    const longBarsSinceLevel = i - highIdx;
    const longStale = longPos > staleThresh && longBarsSinceLevel > staleBack;

    let longSetup = false;
    if (longPos >= atEdge) {
      longSetup = true;
    } else if (longPos >= nearEdge) {
      const pullbackMin = -pullbackFrac * atrV;
      longSetup = move5 >= pullbackMin && move5 <= 0;
    }
    const longTrigger = close > open;
    if (longSetup && !longStale && longTrigger) {
      events.push({ barIndex: i, direction: "Long" });
      continue; // a bar can't fire both directions
    }

    // ─── Short branch (mirror) ──────────────────────────────────────
    const shortBarsSinceLevel = i - lowIdx;
    const shortStale = shortPos > staleThresh && shortBarsSinceLevel > staleBack;

    let shortSetup = false;
    if (shortPos >= atEdge) {
      shortSetup = true;
    } else if (shortPos >= nearEdge) {
      const pullbackMax = pullbackFrac * atrV;
      shortSetup = move5 >= 0 && move5 <= pullbackMax;
    }
    const shortTrigger = close < open;
    if (shortSetup && !shortStale && shortTrigger) {
      events.push({ barIndex: i, direction: "Short" });
    }
  }

  return events;
}

// ─── Strategy: Signal V2 (cross-into-zone + lockout + base filter) ──────────
//
// Mirrors signalTrianglesV2() in calculations.ts. Adds the V2-only knobs on
// top of the V1 schema: cross-up enter / exit thresholds, cooldown lockout,
// and the base filter (range/ATR ratio + drift fraction).

const SIGNAL_V2_FIELDS: StrategyParamField[] = [
  ...SIGNAL_V1_FIELDS,
  { key: "zoneEnterV2", label: "Zone enter (cross up)", type: "float", min: 0, max: 1, step: 0.05, default: 0.5,
    description: "Position transitions from < this to >= this on a single bar to fire" },
  { key: "zoneExitV2", label: "Zone exit (release)", type: "float", min: 0, max: 1, step: 0.05, default: 0.3,
    description: "Position drops below this to release the per-direction lockout" },
  { key: "cooldownBarsV2", label: "Cooldown (bars)", type: "int", min: 0, max: 200, step: 1, default: 30,
    description: "Time-based lockout release if position never drops below the exit threshold" },
  { key: "baseRangeAtrMin", label: "Base range × ATR (min)", type: "float", min: 0, max: 10, step: 0.1, default: 1.5,
    description: "Lookback range / ATR must be >= this — excludes ultra-tight bases" },
  { key: "baseRangeAtrMax", label: "Base range × ATR (max)", type: "float", min: 0, max: 20, step: 0.1, default: 4.0,
    description: "Lookback range / ATR must be <= this — excludes already-trending windows" },
  { key: "baseDriftFraction", label: "Base drift fraction", type: "float", min: 0, max: 1, step: 0.05, default: 0.5,
    description: "|close[start..end]| / range must be < this — confirms churn (not trend) inside the base" },
];

function signalV2Events(bars: ReplayBar[], p: Record<string, number>): BacktestSignal[] {
  const lookback = Math.max(1, Math.floor(p.lookback));
  const atrPeriod = Math.max(2, Math.floor(p.atrPeriod));
  const atEdge = p.atEdgeThreshold;
  const nearEdge = p.nearEdgeThreshold;
  const pullbackFrac = p.pullbackAtrFraction;
  const flatFrac = p.flatAtrFraction;
  const staleThresh = p.staleBreakThreshold;
  const staleBack = Math.floor(p.staleBarsBack);
  const enterV2 = p.zoneEnterV2;
  const exitV2 = p.zoneExitV2;
  const cooldown = Math.max(0, Math.floor(p.cooldownBarsV2));
  const baseMin = p.baseRangeAtrMin;
  const baseMax = p.baseRangeAtrMax;
  const driftFrac = p.baseDriftFraction;

  const minIndex = Math.max(lookback, atrPeriod + 1, 5);
  if (bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, atrPeriod);
  const events: BacktestSignal[] = [];

  // Per-direction state across the bar loop (same convention as the indicator).
  let prevLongPos: number | null = null;
  let prevShortPos: number | null = null;
  let longLockedSinceBar = -1;
  let shortLockedSinceBar = -1;

  for (let i = minIndex; i < bars.length; i++) {
    const atrV = atrVals[i];
    if (!Number.isFinite(atrV) || atrV <= 0) {
      prevLongPos = null;
      prevShortPos = null;
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
      prevLongPos = null;
      prevShortPos = null;
      continue;
    }

    // Base filter — both gates must pass for the window to qualify
    const rangeInAtr = range / atrV;
    const isReasonableSize = rangeInAtr >= baseMin && rangeInAtr <= baseMax;
    const drift = Math.abs(bars[i - 1].bar_close - bars[i - lookback].bar_close);
    const isLowDrift = drift / range < driftFrac;
    const isBase = isReasonableSize && isLowDrift;

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const longPos = (close - rangeLow) / range;
    const shortPos = (rangeHigh - close) / range;

    const move5 = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[Math.max(0, i - 10)].bar_close;
    const flatBound = flatFrac * atrV;
    const isFlat = Math.abs(move5) < flatBound && Math.abs(move10) < flatBound;

    // Lockout release
    if (longLockedSinceBar >= 0) {
      const elapsed = i - longLockedSinceBar;
      if (longPos < exitV2 || elapsed >= cooldown) longLockedSinceBar = -1;
    }
    if (shortLockedSinceBar >= 0) {
      const elapsed = i - shortLockedSinceBar;
      if (shortPos < exitV2 || elapsed >= cooldown) shortLockedSinceBar = -1;
    }

    // Cross-into-zone detection
    const longCrossedIn =
      prevLongPos !== null && prevLongPos < enterV2 && longPos >= enterV2;
    const shortCrossedIn =
      prevShortPos !== null && prevShortPos < enterV2 && shortPos >= enterV2;

    let firedLong = false;

    if (longLockedSinceBar < 0 && longCrossedIn && isBase && !isFlat) {
      let longSetup = false;
      if (longPos >= atEdge) {
        longSetup = true;
      } else if (longPos >= nearEdge) {
        const pullbackMin = -pullbackFrac * atrV;
        longSetup = move5 >= pullbackMin && move5 <= 0;
      }
      const longBarsSinceLevel = i - highIdx;
      const longStale = longPos > staleThresh && longBarsSinceLevel > staleBack;
      const longTrigger = close > open;
      if (longSetup && !longStale && longTrigger) {
        events.push({ barIndex: i, direction: "Long" });
        longLockedSinceBar = i;
        firedLong = true;
      }
    }

    if (!firedLong && shortLockedSinceBar < 0 && shortCrossedIn && isBase && !isFlat) {
      let shortSetup = false;
      if (shortPos >= atEdge) {
        shortSetup = true;
      } else if (shortPos >= nearEdge) {
        const pullbackMax = pullbackFrac * atrV;
        shortSetup = move5 >= 0 && move5 <= pullbackMax;
      }
      const shortBarsSinceLevel = i - lowIdx;
      const shortStale = shortPos > staleThresh && shortBarsSinceLevel > staleBack;
      const shortTrigger = close < open;
      if (shortSetup && !shortStale && shortTrigger) {
        events.push({ barIndex: i, direction: "Short" });
        shortLockedSinceBar = i;
      }
    }

    prevLongPos = longPos;
    prevShortPos = shortPos;
  }

  return events;
}

// ─── Strategy: Signal V3 (V2 + multi-bar acceptance + body/range trigger) ──
//
// V2 fires on the single bar that crosses up into the zone, with a bare
// close > open / close < open trigger. On fast / low-timeframe data both
// gates are noisy: a one-bar wick into the zone can fire even when price
// immediately falls back out, and "close above open" rejects nothing on
// dojis. V3 keeps every other V2 gate (base filter, near/at-edge logic,
// pullback, flat, stale, lockout, cooldown) but tightens the acceptance
// and the trigger:
//
//   1. MULTI-BAR ACCEPTANCE — replaces V2's prevPos cross-detection with a
//      per-direction in-zone STREAK counter. The streak increments on each
//      bar where pos >= zoneEnterV2 and resets to 0 the moment pos drops
//      below. The signal fires on the bar that brings the streak up to
//      `acceptanceBarsV3`. After firing, the existing per-direction lockout
//      suppresses re-fires until pos drops below zoneExitV2 OR cooldown
//      elapses — same as V2 — so a streak that keeps climbing past the
//      threshold doesn't double-fire.
//
//   2. BODY / RANGE TRIGGER — replaces close > open with a body-dominance
//      gate: |close - open| / (high - low) >= `bodyRatioMinV3`. The bar
//      direction (close > open for long, close < open for short) is still
//      required, but a wicky/tiny body bar no longer qualifies. Bars with
//      zero range (degenerate ticks) score 0 and are rejected.
//
// Defaults (acceptanceBarsV3 = 2, bodyRatioMinV3 = 0.5) trade ~one bar of
// latency for materially less wick-noise on small (15s / 30s) timeframes.

const SIGNAL_V3_FIELDS: StrategyParamField[] = [
  ...SIGNAL_V2_FIELDS,
  { key: "acceptanceBarsV3", label: "Acceptance bars (in-zone streak)", type: "int", min: 1, max: 20, step: 1, default: 2,
    description: "Position must stay >= zoneEnterV2 for this many consecutive bars before firing — replaces V2's single-bar cross trigger. Higher = stricter / later." },
  { key: "bodyRatioMinV3", label: "Body / range (min)", type: "float", min: 0, max: 1, step: 0.05, default: 0.5,
    description: "Trigger bar's |close - open| / (high - low) must be >= this — replaces V2's bare close>open trigger so wicky / doji bars are rejected even when their close direction agrees." },
];

function signalV3Events(bars: ReplayBar[], p: Record<string, number>): BacktestSignal[] {
  const lookback = Math.max(1, Math.floor(p.lookback));
  const atrPeriod = Math.max(2, Math.floor(p.atrPeriod));
  const atEdge = p.atEdgeThreshold;
  const nearEdge = p.nearEdgeThreshold;
  const pullbackFrac = p.pullbackAtrFraction;
  const flatFrac = p.flatAtrFraction;
  const staleThresh = p.staleBreakThreshold;
  const staleBack = Math.floor(p.staleBarsBack);
  const enterV2 = p.zoneEnterV2;
  const exitV2 = p.zoneExitV2;
  const cooldown = Math.max(0, Math.floor(p.cooldownBarsV2));
  const baseMin = p.baseRangeAtrMin;
  const baseMax = p.baseRangeAtrMax;
  const driftFrac = p.baseDriftFraction;
  const acceptanceBars = Math.max(1, Math.floor(p.acceptanceBarsV3));
  const bodyRatioMin = p.bodyRatioMinV3;

  const minIndex = Math.max(lookback, atrPeriod + 1, 5);
  if (bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, atrPeriod);
  const events: BacktestSignal[] = [];

  // V3 streak counters replace V2's prev*Pos cross-detection. A direction's
  // streak increments each bar that pos >= enterV2 and resets to 0 on any
  // bar that drops below. The signal fires on the bar that brings the
  // streak up to acceptanceBars; after that the lockout suppresses further
  // fires until exit-zone or cooldown — so the streak climbing past the
  // threshold doesn't double-fire.
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

    // Base filter — both gates must pass for the window to qualify (same as V2)
    const rangeInAtr = range / atrV;
    const isReasonableSize = rangeInAtr >= baseMin && rangeInAtr <= baseMax;
    const drift = Math.abs(bars[i - 1].bar_close - bars[i - lookback].bar_close);
    const isLowDrift = drift / range < driftFrac;
    const isBase = isReasonableSize && isLowDrift;

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const high = bars[i].bar_high;
    const low = bars[i].bar_low;
    const longPos = (close - rangeLow) / range;
    const shortPos = (rangeHigh - close) / range;

    const move5 = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[Math.max(0, i - 10)].bar_close;
    const flatBound = flatFrac * atrV;
    const isFlat = Math.abs(move5) < flatBound && Math.abs(move10) < flatBound;

    // Lockout release (same as V2)
    if (longLockedSinceBar >= 0) {
      const elapsed = i - longLockedSinceBar;
      if (longPos < exitV2 || elapsed >= cooldown) longLockedSinceBar = -1;
    }
    if (shortLockedSinceBar >= 0) {
      const elapsed = i - shortLockedSinceBar;
      if (shortPos < exitV2 || elapsed >= cooldown) shortLockedSinceBar = -1;
    }

    // V3 streak update — counter advances while in zone, resets otherwise.
    longStreak  = longPos  >= enterV2 ? longStreak  + 1 : 0;
    shortStreak = shortPos >= enterV2 ? shortStreak + 1 : 0;

    // Fire only on the bar that completes the streak. Equality (not >=)
    // means a continuing streak past the threshold won't re-fire even
    // before the lockout engages — defensive; the lockout would catch it
    // anyway, but pinning it to the exact bar makes the trigger semantics
    // explicit.
    const longAccepted  = longStreak  === acceptanceBars;
    const shortAccepted = shortStreak === acceptanceBars;

    // Body/range trigger gate (V3 replaces V2's bare close>open / close<open):
    // bar's body must occupy >= bodyRatioMin of its full range. Zero-range
    // bars (degenerate ticks) score 0 and are rejected. Direction is still
    // required — long needs close > open, short needs close < open.
    const barRange = high - low;
    const bodyRatio = barRange > 0 ? Math.abs(close - open) / barRange : 0;

    let firedLong = false;

    if (longLockedSinceBar < 0 && longAccepted && isBase && !isFlat) {
      let longSetup = false;
      if (longPos >= atEdge) {
        longSetup = true;
      } else if (longPos >= nearEdge) {
        const pullbackMin = -pullbackFrac * atrV;
        longSetup = move5 >= pullbackMin && move5 <= 0;
      }
      const longBarsSinceLevel = i - highIdx;
      const longStale = longPos > staleThresh && longBarsSinceLevel > staleBack;
      const longTrigger = close > open && bodyRatio >= bodyRatioMin;
      if (longSetup && !longStale && longTrigger) {
        events.push({ barIndex: i, direction: "Long" });
        longLockedSinceBar = i;
        firedLong = true;
      }
    }

    if (!firedLong && shortLockedSinceBar < 0 && shortAccepted && isBase && !isFlat) {
      let shortSetup = false;
      if (shortPos >= atEdge) {
        shortSetup = true;
      } else if (shortPos >= nearEdge) {
        const pullbackMax = pullbackFrac * atrV;
        shortSetup = move5 >= 0 && move5 <= pullbackMax;
      }
      const shortBarsSinceLevel = i - lowIdx;
      const shortStale = shortPos > staleThresh && shortBarsSinceLevel > staleBack;
      const shortTrigger = close < open && bodyRatio >= bodyRatioMin;
      if (shortSetup && !shortStale && shortTrigger) {
        events.push({ barIndex: i, direction: "Short" });
        shortLockedSinceBar = i;
      }
    }
  }

  return events;
}

// ─── Strategy: Signal V2 Failed (inverse of V2 — failed-breakout fade) ──────
//
// Same gating as V2 — bar selection, base filter, cross-into-zone detection,
// per-direction lockout, near/at-edge logic, pullback, flat, stale checks,
// candle-direction trigger — but each emitted signal's direction is flipped.
// Where V2 would print Long (a breakout to the upside at the recent high),
// this strategy prints Short, betting the breakout fails. Symmetric on the
// other side.
//
// Implemented as a wrapper over signalV2Events so the criteria stay in
// lockstep — any future tweak to V2's gates is automatically inherited
// here, and parity with NT8 (PresetSignals.GenerateV2Failed) only needs
// the same wrapper.
function signalV2FailedEvents(
  bars: ReplayBar[],
  p: Record<string, number>
): BacktestSignal[] {
  const base = signalV2Events(bars, p);
  const flipped: BacktestSignal[] = new Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const e = base[i];
    flipped[i] = {
      barIndex: e.barIndex,
      direction: e.direction === "Long" ? "Short" : "Long",
    };
  }
  return flipped;
}

// ─── Strategy: Failed Break V1 (fade-native, fixes V2-failed mis-signs) ────
//
// V2-failed was just signalV2Events with its emitted directions inverted.
// That structurally mis-signs three of V2's gates for fade setups:
//
//   1. Pullback gate (V1/V2 near-edge branch): V2 fires the near-edge case
//      only when there's a small COUNTER-TREND pullback into the level —
//      good for continuation, terrible for fades. A fade-able breakout
//      typically arrives via an aggressive THRUST into the level (5-bar
//      move with the breakout, not against it). We replace the pullback
//      gate with a same-direction thrust requirement.
//
//   2. No poke / sweep detection: V2 only checks close-relative position
//      (longPos / shortPos). The textbook fade-able breakout pierces the
//      level on the WICK (stop-run) and closes back inside. We add a
//      `bar_high >= rangeHigh + sweepFrac × atr` gate (and the symmetric
//      short-side check), independent of close.
//
//   3. Base filter rewards the wrong regime: V2's base filter (range/ATR
//      bounded above + low drift) selects tight pre-breakout coils — the
//      regime where breakouts SUCCEED. Fade-able breakouts come out of
//      already-trending / extended approaches, so we drop the upper bound
//      on rangeInAtr and FLIP the drift sign — drift / range must be
//      ABOVE a minimum (trending into the level), not below.
//
// Everything else is intentionally identical to V2: bar warmup, ATR series,
// cross-into-zone detection, per-direction lockout (zoneExitV2 / cooldown),
// flat momentum filter, stale-level rejection, and the close>open /
// close<open candle-direction trigger. Direction is emitted PRE-FLIPPED
// (long-side breakout poke → emits Short, short-side poke → emits Long),
// so this strategy stands on its own and does not wrap signalV2Events.
//
// Mirrored byte-for-byte by PresetSignals.GenerateFailedBreakV1 in NT8.

const FAILED_BREAK_V1_FIELDS: StrategyParamField[] = [
  { key: "lookback", label: "Lookback (bars)", type: "int", min: 5, max: 200, step: 1, default: 20,
    description: "Range window — pre-entry bars used to compute high/low extremes" },
  { key: "atrPeriod", label: "ATR period", type: "int", min: 5, max: 50, step: 1, default: 14,
    description: "Wilder ATR period — drives all ATR-relative thresholds below" },
  { key: "atEdgeThreshold", label: "At-edge threshold", type: "float", min: 0.5, max: 1.5, step: 0.05, default: 0.85,
    description: "Position-in-range >= this fires unconditionally (close is poking the extreme)" },
  { key: "nearEdgeThreshold", label: "Near-edge threshold", type: "float", min: 0, max: 1, step: 0.05, default: 0.5,
    description: "Position-in-range >= this fires only when there's a same-direction thrust into the level" },
  { key: "thrustAtrFraction", label: "Thrust × ATR (into level)", type: "float", min: 0, max: 3, step: 0.1, default: 0.5,
    description: "Fade-only replacement for V1 pullback: 5-bar move toward the level must be >= this × ATR — confirms an aggressive approach (not a counter-trend stall)" },
  { key: "sweepAtrFraction", label: "Sweep wick × ATR", type: "float", min: 0, max: 2, step: 0.05, default: 0.1,
    description: "Bar's wick must extend beyond the level by >= this × ATR — the stop-run/poke that distinguishes a fade-able breakout from a clean one" },
  { key: "flatAtrFraction", label: "Flat × ATR", type: "float", min: 0, max: 1, step: 0.05, default: 0.2,
    description: "If both 5- and 10-bar moves are within ±this × ATR → reject (F2 flat momentum, same as V2)" },
  { key: "staleBreakThreshold", label: "Stale-break threshold", type: "float", min: 1, max: 2, step: 0.05, default: 1.05,
    description: "Position > this is a true breakout — combined with stale-bars below to reject re-tests (same as V2)" },
  { key: "staleBarsBack", label: "Stale bars back", type: "int", min: 0, max: 50, step: 1, default: 15,
    description: "If breaking a level set more than this many bars ago → reject (F3 stale level, same as V2)" },
  { key: "zoneEnterV2", label: "Zone enter (cross up)", type: "float", min: 0, max: 1, step: 0.05, default: 0.5,
    description: "Position transitions from < this to >= this on a single bar to fire (same as V2)" },
  { key: "zoneExitV2", label: "Zone exit (release)", type: "float", min: 0, max: 1, step: 0.05, default: 0.3,
    description: "Position drops below this to release the per-direction lockout (same as V2)" },
  { key: "cooldownBarsV2", label: "Cooldown (bars)", type: "int", min: 0, max: 200, step: 1, default: 30,
    description: "Time-based lockout release if position never drops below the exit threshold (same as V2)" },
  { key: "fadeRangeAtrMin", label: "Fade range × ATR (min)", type: "float", min: 0, max: 10, step: 0.1, default: 1.0,
    description: "Lookback range / ATR must be >= this — same purpose as V2's baseRangeAtrMin but no upper bound (fades welcome already-trending windows)" },
  { key: "fadeDriftFractionMin", label: "Fade drift fraction (min)", type: "float", min: 0, max: 2, step: 0.05, default: 0.4,
    description: "FLIPPED sign vs V2: |close[start..end]| / range must be >= this — fades want a trending approach into the level, not the tight churn V2 requires" },
];

function failedBreakV1Events(bars: ReplayBar[], p: Record<string, number>): BacktestSignal[] {
  const lookback = Math.max(1, Math.floor(p.lookback));
  const atrPeriod = Math.max(2, Math.floor(p.atrPeriod));
  const atEdge = p.atEdgeThreshold;
  const nearEdge = p.nearEdgeThreshold;
  const thrustFrac = p.thrustAtrFraction;
  const sweepFrac = p.sweepAtrFraction;
  const flatFrac = p.flatAtrFraction;
  const staleThresh = p.staleBreakThreshold;
  const staleBack = Math.floor(p.staleBarsBack);
  const enterV2 = p.zoneEnterV2;
  const exitV2 = p.zoneExitV2;
  const cooldown = Math.max(0, Math.floor(p.cooldownBarsV2));
  const fadeRangeMin = p.fadeRangeAtrMin;
  const fadeDriftMin = p.fadeDriftFractionMin;

  const minIndex = Math.max(lookback, atrPeriod + 1, 5);
  if (bars.length <= minIndex) return [];

  const atrVals = atrSeries(bars, atrPeriod);
  const events: BacktestSignal[] = [];

  let prevLongPos: number | null = null;
  let prevShortPos: number | null = null;
  let longLockedSinceBar = -1;
  let shortLockedSinceBar = -1;

  for (let i = minIndex; i < bars.length; i++) {
    const atrV = atrVals[i];
    if (!Number.isFinite(atrV) || atrV <= 0) {
      prevLongPos = null;
      prevShortPos = null;
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
      prevLongPos = null;
      prevShortPos = null;
      continue;
    }

    // Fade-tuned base filter: lower-bound only on rangeInAtr (no max),
    // and drift must be HIGH (trending approach), opposite of V2.
    const rangeInAtr = range / atrV;
    const drift = Math.abs(bars[i - 1].bar_close - bars[i - lookback].bar_close);
    const isFadeBase = rangeInAtr >= fadeRangeMin && drift / range >= fadeDriftMin;

    const close = bars[i].bar_close;
    const open = bars[i].bar_open;
    const high = bars[i].bar_high;
    const low = bars[i].bar_low;
    const longPos = (close - rangeLow) / range;
    const shortPos = (rangeHigh - close) / range;

    const move5 = bars[i - 1].bar_close - bars[i - 5].bar_close;
    const move10 = bars[i - 1].bar_close - bars[Math.max(0, i - 10)].bar_close;
    const flatBound = flatFrac * atrV;
    const isFlat = Math.abs(move5) < flatBound && Math.abs(move10) < flatBound;

    // Lockout release (identical to V2)
    if (longLockedSinceBar >= 0) {
      const elapsed = i - longLockedSinceBar;
      if (longPos < exitV2 || elapsed >= cooldown) longLockedSinceBar = -1;
    }
    if (shortLockedSinceBar >= 0) {
      const elapsed = i - shortLockedSinceBar;
      if (shortPos < exitV2 || elapsed >= cooldown) shortLockedSinceBar = -1;
    }

    // Cross-into-zone detection (identical to V2)
    const longCrossedIn =
      prevLongPos !== null && prevLongPos < enterV2 && longPos >= enterV2;
    const shortCrossedIn =
      prevShortPos !== null && prevShortPos < enterV2 && shortPos >= enterV2;

    let firedLong = false;

    // Long-side breakout poke → fade SHORT.
    if (longLockedSinceBar < 0 && longCrossedIn && isFadeBase && !isFlat) {
      let longBreakoutSetup = false;
      if (longPos >= atEdge) {
        longBreakoutSetup = true;
      } else if (longPos >= nearEdge) {
        // FIX 1 — thrust into the level, not a pullback away from it.
        const thrustMin = thrustFrac * atrV;
        longBreakoutSetup = move5 >= thrustMin;
      }
      // FIX 2 — wick must pierce the level by sweepFrac × ATR.
      const sweepMin = sweepFrac * atrV;
      const longSweep = high >= rangeHigh + sweepMin;

      const longBarsSinceLevel = i - highIdx;
      const longStale = longPos > staleThresh && longBarsSinceLevel > staleBack;
      const longTrigger = close > open;
      if (longBreakoutSetup && longSweep && !longStale && longTrigger) {
        events.push({ barIndex: i, direction: "Short" });
        longLockedSinceBar = i;
        firedLong = true;
      }
    }

    // Short-side breakout poke → fade LONG.
    if (!firedLong && shortLockedSinceBar < 0 && shortCrossedIn && isFadeBase && !isFlat) {
      let shortBreakoutSetup = false;
      if (shortPos >= atEdge) {
        shortBreakoutSetup = true;
      } else if (shortPos >= nearEdge) {
        // FIX 1 mirror — thrust DOWN into the level (move5 negative beyond threshold).
        const thrustMin = thrustFrac * atrV;
        shortBreakoutSetup = move5 <= -thrustMin;
      }
      // FIX 2 mirror — wick must pierce the level downward.
      const sweepMin = sweepFrac * atrV;
      const shortSweep = low <= rangeLow - sweepMin;

      const shortBarsSinceLevel = i - lowIdx;
      const shortStale = shortPos > staleThresh && shortBarsSinceLevel > staleBack;
      const shortTrigger = close < open;
      if (shortBreakoutSetup && shortSweep && !shortStale && shortTrigger) {
        events.push({ barIndex: i, direction: "Long" });
        shortLockedSinceBar = i;
      }
    }

    prevLongPos = longPos;
    prevShortPos = shortPos;
  }

  return events;
}

// ─── Strategy registry ──────────────────────────────────────────────────────
//
// New strategies plug in by appending an entry here. The dashboard reads the
// list to populate the dropdown and auto-renders the parameter editor from
// `paramFields`, so no UI changes are needed when adding a strategy.

export const STRATEGIES: StrategyDef[] = [
  {
    id: "signal_v1",
    label: "Signal v1 (range-break + pullback)",
    description:
      "Fires at recent-range edges with a small counter-trend pullback. Filters out flat momentum and re-tests of stale levels.",
    paramFields: SIGNAL_V1_FIELDS,
    generateSignals: signalV1Events,
  },
  {
    id: "signal_v2",
    label: "Signal v2 (cross-into-zone + lockout + base filter)",
    description:
      "V1 setup gates plus: fires only on the bar that crosses into the zone, per-direction lockout to prevent re-fires, and a base-quality filter on the lookback window.",
    paramFields: SIGNAL_V2_FIELDS,
    generateSignals: signalV2Events,
  },
  {
    id: "signal_v3",
    label: "Signal v3 (V2 + multi-bar acceptance + body/range trigger)",
    description:
      "V2 with two tightenings for fast/low-timeframe data: requires the in-zone position to hold for N consecutive bars before firing (replaces V2's single-bar cross), and the trigger bar's body must occupy a minimum fraction of its range (replaces V2's bare close>open).",
    paramFields: SIGNAL_V3_FIELDS,
    generateSignals: signalV3Events,
  },
  {
    id: "signal_v2_failed",
    label: "Signal v2 failed (inverse — fade the breakout)",
    description:
      "Identical gating to v2 (same params), but every signal's direction is flipped. Where v2 prints Long on an upside breakout this prints Short, betting the breakout fails.",
    // Reuses V2's param schema verbatim — same knobs, same defaults.
    paramFields: SIGNAL_V2_FIELDS,
    generateSignals: signalV2FailedEvents,
  },
  {
    id: "failed_break_v1",
    label: "Failed Break v1 (fade-native: thrust + sweep + trending base)",
    description:
      "Fade-native rebuild of v2_failed. Replaces V2's counter-trend pullback with a same-direction thrust into the level, adds a wick-sweep gate (poke beyond the high/low), and flips the base filter to require a trending approach instead of a tight coil.",
    paramFields: FAILED_BREAK_V1_FIELDS,
    generateSignals: failedBreakV1Events,
  },
];

/** Build a default-params dict for a strategy by reading its paramFields.
 *  Used by the dashboard when first selecting a strategy or to reset. */
export function defaultParamsFor(strategy: StrategyDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of strategy.paramFields) out[f.key] = f.default;
  return out;
}

// ─── Synthetic-zone construction + per-session backtest ─────────────────────

/** Clamp on the post-entry walk length per signal. The simulator exits early
 *  on its own (SL/TP/Trail/BE/Timer), so this is just an upper bound to keep
 *  the synthetic bar arrays from getting absurd on long sessions with no
 *  exit rule firing. 500 bars at 1-min ≈ a full RTH session. */
const DEFAULT_MAX_HOLD_BARS = 500;

/** How many bars BEFORE each entry bar to capture for the AI export's
 *  "setup context" view. Matches MAX_PRE_ENTRY_BARS in SimulatorPanel so
 *  the two exports have parity. Pre-entry bars carry negative bar_index
 *  (-N..-1) so they sort before the entry bar (index 0) in the export. */
const DEFAULT_PRE_ENTRY_BARS = 30;

/** Hard ceiling on the auto-sized pre-entry warmup window. Caps memory
 *  cost when a user writes something pathological like `EMA(50000)` —
 *  we'd rather warn and produce NaN at entry than allocate 50k bars per
 *  zone × N zones. 1000 bars covers any reasonable indicator period
 *  (200-EMA, 500-EMA, ADX(50), etc.) with headroom. */
const MAX_AUTO_PRE_ENTRY_BARS = 1000;

/** Walk every Expr referenced by a ScriptOverlay (numericOverrides RHS,
 *  tradePrints, Optimize bound expressions, filter.if cond + per-branch
 *  assignment / print RHS + nested filter.if). Used both to drive
 *  `precomputeIndicators` and to size the pre-entry warmup window so
 *  long-period indicators (EMA(200), ATR(50), …) are warmed up by the
 *  entry bar. Local to this file so we don't import from
 *  backtest-script (which already imports from here — would be a cycle).
 *  The dashboard memo has its own copy of this walker; both must stay
 *  in sync. */
function collectOverlayExprs(
  overlay: import("./zone-simulator").ScriptOverlay
): import("./script-expr").Expr[] {
  const out: import("./script-expr").Expr[] = [];
  if (overlay.numericOverrides) {
    for (const path of Object.keys(overlay.numericOverrides)) {
      const nv = overlay.numericOverrides[path];
      if (nv.kind === "expr") out.push(nv.expr);
    }
  }
  if (overlay.tradePrints) {
    for (const p of overlay.tradePrints) out.push(p.expr);
  }
  if (overlay.optimizeOverrides) {
    for (const path of Object.keys(overlay.optimizeOverrides)) {
      const spec = overlay.optimizeOverrides[path];
      if (spec.kind === "optimize-numeric") {
        out.push(spec.min.expr);
        out.push(spec.max.expr);
        if (spec.step) out.push(spec.step.expr);
      }
    }
  }
  if (overlay.filterIfs) {
    const walkStmts = (
      stmts: import("./backtest-script").FilterIfStatement[]
    ): void => {
      for (const s of stmts) {
        if (s.kind === "assignment" && s.value.kind === "expr") {
          out.push(s.value.expr);
        } else if (s.kind === "print") {
          out.push(s.directive.expr);
        } else if (s.kind === "nested") {
          walkDirective(s.directive);
        }
      }
    };
    const walkDirective = (
      d: import("./backtest-script").FilterIfDirective
    ): void => {
      out.push(d.cond);
      walkStmts(d.ifTrue);
      walkStmts(d.ifFalse);
    };
    for (const d of overlay.filterIfs) walkDirective(d);
  }
  return out;
}

export interface BacktestRunResult {
  trades: SimZoneResult[];
  /** Synthetic TradeZones — one per fired signal. Same shape as real zones so
   *  components like SimulatorTable can render them without modification. */
  syntheticZones: TradeZone[];
  /** Synthetic per-zone bar map, also matching the real-zone shape. */
  syntheticBarsByZoneId: Map<number, TradeZoneBar[]>;
  /** Pre-entry bars per synthetic zone — the N bars BEFORE entry, with
   *  negative bar_index so they sort chronologically before the zone bars.
   *  Used by the "Export For AI" JSON to give the LLM the setup context
   *  that led into each entry. Always populated (may be empty for signals
   *  fired close to the start of a session). */
  syntheticPreEntryBarsByZoneId: Map<number, TradeZoneBar[]>;
  /** Per-zone ATR(14) at entry, lifted from each synthetic zone's
   *  `ctx_atr14`. Required by the simulator's ATR-adjust math
   *  (effective threshold = basePoints + atrAdjust × zoneATR) — without
   *  this map the ± ATR fields on SL/TP/Trail/BE silently no-op. Zones
   *  whose ATR couldn't be computed (signal fired before the warmup
   *  window) are absent from the map and fall back to base points only,
   *  matching the simulator's null-tolerant behavior. */
  syntheticAtrByZoneId: Map<number, number>;
  /** Total signal count BEFORE the session-end walk-truncation drop. Useful
   *  for debugging "I see N triangles but only M trades in the table". */
  totalSignals: number;
  /** Optimization history per directive path (Script v3). Empty when the
   *  script had no `Optimize.X.Y(...)` directives. Each entry records
   *  the optimizer's APPLIED (post-smoothing) value at that point in
   *  the run, plus the pre-smoothing raw best-trial value, the
   *  smoothing window, and the best objective achieved during the
   *  local TPE search. The Output panel renders the smoothed series
   *  as the primary trace and the raw series as a faint background
   *  trace when smoothing is active. `rawValue` and `smoothWindow`
   *  are optional for back-compat with persisted runs that predate
   *  SMA smoothing. */
  optimizationHistory?: Record<string, Array<{
    tradeIndex: number;
    value: number;
    rawValue?: number;
    smoothWindow?: number;
    objective: number;
    trialsRun: number;
  }>>;
  /** Warnings surfaced by the online optimizer — e.g. "directive never
   *  warmed up", "OptimizeAll downgraded to independent due to mixed
   *  objectives". Surfaced as a yellow banner in the dashboard. */
  optimizationWarnings?: string[];
}

/** Convert one ReplayBar to a TradeZoneBar with the supplied zone_id and
 *  bar_index. Trade-zone-only fields (mfe_from_start, ctx_*, etc.) get null
 *  since the simulator only reads OHLCV + bar_index + bar_time. */
function replayBarToZoneBar(
  bar: ReplayBar,
  zoneId: number,
  barIndex: number
): TradeZoneBar {
  return {
    id: bar.id,
    zone_id: zoneId,
    bar_time: bar.bar_time,
    bar_open: bar.bar_open,
    bar_high: bar.bar_high,
    bar_low: bar.bar_low,
    bar_close: bar.bar_close,
    bar_volume: bar.bar_volume,
    bar_index: barIndex,
    mfe_from_start: null,
    mae_from_start: null,
    drawdown_from_entry: null,
    runup_from_entry: null,
    close_vs_entry: null,
    high_since_entry: null,
    retrace_from_peak: null,
    created_at: bar.bar_time,
  };
}

/** Run a strategy on one session's bars. Returns synthetic zones + bars +
 *  simulated trades. `idOffset` is the starting numeric id to use for synth
 *  zones; the caller passes the running global counter so multi-session
 *  results don't collide. */
export function runBacktestForSession(args: {
  bars: ReplayBar[];
  instrument: string;
  strategy: StrategyDef;
  params: Record<string, number>;
  rules: SimRules;
  idOffset: number;
  maxHoldBars?: number;
  /** How many bars BEFORE each entry to capture for the AI export.
   *  Defaults to DEFAULT_PRE_ENTRY_BARS (30). */
  maxPreEntryBars?: number;
  /** Indicator periods + types. Defaults to DEFAULT_INDICATOR_CONFIG so
   *  callers that don't care get the legacy hardcoded behavior. */
  indicatorConfig?: IndicatorConfig;
  /** Script v2 overlay — when present, expressions on rules.* fields and
   *  ontrade.print directives are evaluated at each trade's entry bar.
   *  Without it, behavior is byte-identical to the legacy run. The
   *  overlay is BUILT BY THE CALLER (the dashboard run-memo) and
   *  threaded through unchanged here — this keeps engine code free of
   *  expression-engine knowledge except for the typed pass-through. */
  scriptOverlay?: import("./zone-simulator").ScriptOverlay | null;
}): BacktestRunResult {
  const {
    bars,
    instrument,
    strategy,
    params,
    rules,
    idOffset,
    maxHoldBars = DEFAULT_MAX_HOLD_BARS,
    maxPreEntryBars = DEFAULT_PRE_ENTRY_BARS,
    indicatorConfig = DEFAULT_INDICATOR_CONFIG,
    scriptOverlay,
  } = args;

  // Auto-size the pre-entry bar window when the script references
  // long-period indicators. Without this, `filter.if = close > EMA(200)`
  // silently rejects every trade: the engine's default 30-bar pre-entry
  // window can't warm up an EMA(200) by bar_index 0, the indicator
  // returns NaN, the comparison returns NaN, &&/|| treat NaN as
  // not-passing, and the directive routes every trade to if_false →
  // reject. Walking the overlay's expressions and pulling enough history
  // makes the warmup match what the script actually needs. The user's
  // `maxPreEntryBars` arg becomes a FLOOR (still honored for the AI
  // export's setup-context slider), and the auto value is capped at
  // MAX_AUTO_PRE_ENTRY_BARS to bound memory.
  const overlayExprs = scriptOverlay ? collectOverlayExprs(scriptOverlay) : [];
  const requiredWarmup = scriptOverlay ? maxIndicatorPeriod(overlayExprs) : 0;
  const effectivePreEntryBars = Math.min(
    MAX_AUTO_PRE_ENTRY_BARS,
    // +10 buffer absorbs the off-by-one between "first valid index" and
    // "value at the entry bar after we slice off pre-entry bars" — the
    // entry bar is bar_index 0 of the post-entry array, but the warmup
    // is computed across the combined (pre + post) series.
    Math.max(maxPreEntryBars, requiredWarmup + 10)
  );
  if (scriptOverlay && requiredWarmup > MAX_AUTO_PRE_ENTRY_BARS) {
    scriptOverlay.warnings = scriptOverlay.warnings ?? [];
    scriptOverlay.warnings.push(
      `Indicator period requires ${requiredWarmup} pre-entry bars, exceeds max warmup window (${MAX_AUTO_PRE_ENTRY_BARS}). Indicator values may be NaN at entry, causing filter.if conditions to reject every trade.`
    );
  }

  if (bars.length === 0) {
    return {
      trades: [],
      syntheticZones: [],
      syntheticBarsByZoneId: new Map(),
      syntheticPreEntryBarsByZoneId: new Map(),
      syntheticAtrByZoneId: new Map(),
      totalSignals: 0,
    };
  }

  const signals = strategy.generateSignals(bars, params);

  // Pre-compute every indicator series ONCE per session so the per-signal
  // ctx_* snapshot is just a constant-time array lookup. Way cheaper than
  // re-running ATR/ADX/EMA/Bollinger inside the signal loop.
  const ctxSeries = signals.length > 0 ? buildContextSeries(bars, indicatorConfig) : null;

  const syntheticZones: TradeZone[] = [];
  const syntheticBarsByZoneId = new Map<number, TradeZoneBar[]>();
  const syntheticPreEntryBarsByZoneId = new Map<number, TradeZoneBar[]>();
  // Per-zone ATR(14) at entry — same value the snapshot stamps onto
  // ctx_atr14, exposed as a Map<zoneId, number> so the simulator's
  // ATR-adjust math has the lookup it expects. Without this the ± ATR
  // fields on SL/TP/Trail/BE silently no-op for backtest results.
  const syntheticAtrByZoneId = new Map<number, number>();

  signals.forEach((sig, sigIdx) => {
    const entryBar = bars[sig.barIndex];
    if (!entryBar) return;

    // Determine the post-entry walk window: from the trigger bar (entry,
    // bar_index 0 in the synthetic zone) forward up to maxHoldBars total.
    const walkEnd = Math.min(bars.length, sig.barIndex + maxHoldBars);
    const walkLen = walkEnd - sig.barIndex;
    if (walkLen <= 1) return; // need at least one bar AFTER entry to simulate

    const exitBar = bars[walkEnd - 1];
    const entryPrice = entryBar.bar_close;
    const isLong = sig.direction === "Long";
    const pointsMove = isLong
      ? exitBar.bar_close - entryPrice
      : entryPrice - exitBar.bar_close;

    const zoneId = idOffset + sigIdx + 1;

    // Stamp the indicator state at entry onto the synthetic zone so the
    // existing context filters (ADX/ATR/Trend/Bollinger) — which all read
    // ctx_* fields off TradeZone — work against backtest signals
    // identically to real trade zones. Falls back to nulls when the
    // strategy fires before an indicator has warmed up.
    const ctx: ContextSnapshot = ctxSeries
      ? snapshotContext(
          ctxSeries,
          entryPrice,
          sig.barIndex,
          entryBar,
          indicatorConfig.adxSlopeLookback
        )
      : {
          ctx_atr14: null,
          ctx_adx14: null,
          ctx_ema20: null,
          ctx_ema200: null,
          ctx_price_vs_ema20: null,
          ctx_price_vs_ema200: null,
          ctx_dist_ema20_atr: null,
          ctx_bollinger_pos: null,
          ctx_bollinger_bw: null,
          ctx_ma_distance_value: null,
          ctx_ma_distance_atr: null,
          ctx_dist_ema200_atr: null,
          ctx_volume: null,
          ctx_volume_ratio: null,
          ctx_rsi: null,
          ctx_adx_slope: null,
        };

    // Build synthetic TradeZone matching the real-zone shape so downstream
    // components (table, simulator results) treat it identically.
    const zone: TradeZone = {
      id: zoneId,
      instrument,
      direction: sig.direction,
      start_time: entryBar.bar_time,
      end_time: exitBar.bar_time,
      start_price: entryPrice,
      end_price: exitBar.bar_close,
      bar_count: walkLen,
      points_move: Math.round(pointsMove * 100) / 100,
      duration_seconds: 0,
      notes: null,
      chart_timeframe: null,
      ...ctx,
      entry_hour: null,
      entry_day_of_week: null,
      section_id: null,
      sl_price: null,
      tp_price: null,
      hit_outcome: null,
      created_at: entryBar.bar_time,
    };

    // Synthetic bar list: indices 0..walkLen-1 mapped from the source bars.
    // The simulator skips bar_index 0 for exit/peak checks (entry bar), so
    // mapping the trigger bar to index 0 matches the existing convention.
    const zoneBars: TradeZoneBar[] = [];
    for (let k = 0; k < walkLen; k++) {
      zoneBars.push(replayBarToZoneBar(bars[sig.barIndex + k], zoneId, k));
    }

    // Pre-entry bars — up to N bars immediately before the entry candle.
    // bar_index runs −effectivePreEntryBars..−1 so the bar right before
    // entry sorts at -1 and the export's chronological sort works
    // without any special-casing. Clamps at the start of the session if
    // the signal fires too early to fill the window.
    // `effectivePreEntryBars` is auto-sized from the script's indicator
    // periods (see top of runBacktestForSession) — for non-script runs
    // it equals `maxPreEntryBars`.
    const preStart = Math.max(0, sig.barIndex - effectivePreEntryBars);
    const preBars: TradeZoneBar[] = [];
    for (let k = preStart; k < sig.barIndex; k++) {
      preBars.push(replayBarToZoneBar(bars[k], zoneId, k - sig.barIndex));
    }

    syntheticZones.push(zone);
    syntheticBarsByZoneId.set(zoneId, zoneBars);
    syntheticPreEntryBarsByZoneId.set(zoneId, preBars);
    // Only register an ATR entry when the indicator actually warmed up —
    // matches the risk simulator's `fetchZoneAtr` map convention where
    // missing entries fall back to base points only.
    if (ctx.ctx_atr14 != null && ctx.ctx_atr14 > 0) {
      syntheticAtrByZoneId.set(zoneId, ctx.ctx_atr14);
    }
  });

  // ── Script v2: build per-zone indicator cache ──────────────────────
  // When an overlay is present, walk every compiled expression in
  // numericOverrides + tradePrints and precompute exactly the indicator
  // series each zone needs. Done here (after zones exist, before
  // simulator runs) so the simulator's per-trade evaluator can do O(1)
  // map lookups instead of recomputing series. When the overlay has no
  // expressions referencing indicator data, this just produces empty
  // per-zone maps — cheap.
  let overlayForSim: import("./zone-simulator").ScriptOverlay | null =
    scriptOverlay ?? null;
  if (
    overlayForSim &&
    (overlayForSim.numericOverrides ||
      overlayForSim.tradePrints ||
      overlayForSim.optimizeOverrides ||
      (overlayForSim.filterIfs && overlayForSim.filterIfs.length > 0)) &&
    !overlayForSim.indicatorByZone
  ) {
    // Script v2.1 / v3: `overlayExprs` (computed at the top of this
    // function) already covers numericOverrides RHS, tradePrints,
    // Optimize bound expressions, and filter.if cond + per-branch
    // assignment / print RHS + nested filter.if. Same list also drove
    // `effectivePreEntryBars` so `precomputeIndicators` and the
    // pre-entry slice agree on what's needed.
    overlayForSim = {
      ...overlayForSim,
      // Pass syntheticPreEntryBarsByZoneId so series like ATR/EMA/ADX have
      // their warmup window covered by pre-entry bars, and the value at
      // bar_index 0 (entry) is the warmed-up reading the user expects.
      // Without this, ontrade.print of ATR (or any indicator) renders as
      // "–" in the per-trade table because the lookup hits NaN.
      indicatorByZone: precomputeIndicators(
        syntheticZones,
        syntheticBarsByZoneId,
        overlayExprs,
        syntheticPreEntryBarsByZoneId
      ),
    };
  }

  // ── Script v3: online TPE optimizer path ──────────────────────────
  // When the overlay carries Optimize directives, the SIMULATION is
  // deferred to the caller — the dashboard run memo aggregates zones
  // across all selected sessions and runs the optimizer ONCE on the
  // concatenated set. This is critical: a per-session optimizer would
  // mean each session has its own 30-trade warmup window, so 10
  // sessions × 30 = 300 trades worth of warmup, often never reaching
  // post-warmup at all. Running the optimizer ONCE on the combined
  // chronologically-sorted zones means warmup happens just once and
  // optimization spans session boundaries cleanly.
  //
  // We signal "deferred" by returning empty trades when an optimize
  // overlay is present. The dashboard memo detects this case and runs
  // runOnlineOptimizedBacktest after the per-session loop completes.
  let optimizationHistory: BacktestRunResult["optimizationHistory"];
  let optimizationWarnings: string[] | undefined;
  let trades: SimZoneResult[];
  if (overlayForSim?.optimizeOverrides && Object.keys(overlayForSim.optimizeOverrides).length > 0) {
    // Deferred — caller will run the optimizer on the combined set.
    trades = [];
  } else {
    // Re-use the proven simulator. positionMode + scaling post-passes apply
    // automatically, so cross-signal overlap and pyramiding work out of the box.
    // Pass the per-zone ATR map so the ± ATR adjustment fields on SL/TP/Trail/BE
    // actually take effect — without this, the simulator falls back to base
    // points only and the ± ATR inputs silently no-op.
    trades = simulateAllZones(
      syntheticZones,
      syntheticBarsByZoneId,
      rules,
      syntheticAtrByZoneId,
      overlayForSim
    );
  }

  return {
    trades,
    syntheticZones,
    syntheticBarsByZoneId,
    syntheticPreEntryBarsByZoneId,
    syntheticAtrByZoneId,
    totalSignals: signals.length,
    optimizationHistory,
    optimizationWarnings,
  };
}

/** Convenience: run a strategy across multiple sessions and concatenate the
 *  results. Synthetic-zone IDs are kept globally unique by passing the running
 *  zone count as `idOffset` to each session. */
export function runBacktestAcrossSessions(args: {
  sessions: { instrument: string; bars: ReplayBar[] }[];
  strategy: StrategyDef;
  params: Record<string, number>;
  rules: SimRules;
  maxHoldBars?: number;
  maxPreEntryBars?: number;
  indicatorConfig?: IndicatorConfig;
  /** Script v2 overlay — see runBacktestForSession. Threaded into every
   *  per-session run so expressions/prints stay consistent across the
   *  multi-session concatenation. */
  scriptOverlay?: import("./zone-simulator").ScriptOverlay | null;
}): BacktestRunResult {
  const {
    sessions,
    strategy,
    params,
    rules,
    maxHoldBars,
    maxPreEntryBars,
    indicatorConfig,
    scriptOverlay,
  } = args;

  const allTrades: SimZoneResult[] = [];
  const allZones: TradeZone[] = [];
  const allBars = new Map<number, TradeZoneBar[]>();
  const allPreEntryBars = new Map<number, TradeZoneBar[]>();
  const allAtr = new Map<number, number>();
  let idOffset = 0;
  let totalSignals = 0;

  for (const sess of sessions) {
    const r = runBacktestForSession({
      bars: sess.bars,
      instrument: sess.instrument,
      strategy,
      params,
      rules,
      idOffset,
      maxHoldBars,
      maxPreEntryBars,
      indicatorConfig,
      scriptOverlay,
    });
    allTrades.push(...r.trades);
    allZones.push(...r.syntheticZones);
    for (const [k, v] of r.syntheticBarsByZoneId) allBars.set(k, v);
    for (const [k, v] of r.syntheticPreEntryBarsByZoneId) allPreEntryBars.set(k, v);
    for (const [k, v] of r.syntheticAtrByZoneId) allAtr.set(k, v);
    idOffset += r.syntheticZones.length;
    totalSignals += r.totalSignals;
  }

  // Sort trades chronologically so the equity curve / per-day chart render in
  // time order across the multi-session concatenation.
  allTrades.sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );

  return {
    trades: allTrades,
    syntheticZones: allZones,
    syntheticBarsByZoneId: allBars,
    syntheticPreEntryBarsByZoneId: allPreEntryBars,
    syntheticAtrByZoneId: allAtr,
    totalSignals,
  };
}

// ─── Per-strategy-param optimizer ──────────────────────────────────────────
//
// Single-axis sweep: holds every other strategy parameter constant at the
// user's current values, sweeps `paramKey` across [min, max] in steps of
// `step`, and picks the value that maximizes total scaledPoints across the
// selected sessions. Used by the per-input OPT buttons on the backtesting
// tab — the user can dial in one knob at a time without leaving the page.
//
// Each candidate value re-runs the full pipeline (signal generation +
// per-zone simulator + scaling + daily limits), so this is more expensive
// than the SL/TP/TSL grid (which only re-runs the simulator over a fixed
// signal set). Range sizes typically come out to tens-to-hundreds of
// candidates per param. Runs in the worker so a long sweep doesn't block
// the dashboard, and yields after each candidate so cancel messages can
// land between iterations.

export interface StrategyParamOptimizeResult {
  /** The best value found, ready to drop into params[paramKey]. */
  bestValue: number;
  /** Total scaledPoints at the best value (the objective being maximized). */
  bestTotalPoints: number;
  /** Full summary at the best candidate so the caller can surface stats. */
  bestSummary: SimSummary;
  /** How many candidates were evaluated (useful for debugging). */
  valuesTested: number;
  /** Wall-clock time in ms. */
  elapsedMs: number;
}

/** Generator that drives the per-param sweep — yields progress every
 *  candidate so the worker can post updates and cancel in between. */
export function* strategyParamOptimizeGenerator(args: {
  sessions: { instrument: string; bars: ReplayBar[] }[];
  strategyId: string;
  baseParams: Record<string, number>;
  paramKey: string;
  range: { min: number; max: number; step: number };
  rules: SimRules;
  maxHoldBars?: number;
  indicatorConfig?: IndicatorConfig;
}): Generator<{ progress: number }, StrategyParamOptimizeResult, void> {
  const { sessions, strategyId, baseParams, paramKey, range, rules, maxHoldBars, indicatorConfig } =
    args;
  const startMs = performance.now();

  // Resolve the strategy def from the registry. The worker doesn't carry
  // a closure over the dashboard's selection, so we look it up by id here.
  // Falls back to a no-op result when the id is unknown — defensive
  // against stale messages or future strategy renames.
  const strategy = STRATEGIES.find((s) => s.id === strategyId);
  if (!strategy) {
    return {
      bestValue: baseParams[paramKey] ?? 0,
      bestTotalPoints: 0,
      bestSummary: computeSimSummary([]),
      valuesTested: 0,
      elapsedMs: Math.round(performance.now() - startMs),
    };
  }

  // Build the candidate value list. Floats accumulate in epsilon-aware
  // increments to keep step boundaries exact (e.g., step=0.05 would
  // otherwise drift after a few hundred iterations). Int fields work
  // identically — JS numbers are happy with int arithmetic.
  const values: number[] = [];
  if (range.step > 0 && range.min <= range.max) {
    for (let v = range.min; v <= range.max + 1e-9; v += range.step) {
      // Round to the nearest step to avoid floating-point drift in the
      // emitted value (the input shows e.g. "0.55" not "0.5500000001").
      values.push(Math.round(v / range.step) * range.step);
    }
  }
  if (values.length === 0) {
    return {
      bestValue: baseParams[paramKey] ?? range.min,
      bestTotalPoints: 0,
      bestSummary: computeSimSummary([]),
      valuesTested: 0,
      elapsedMs: Math.round(performance.now() - startMs),
    };
  }

  let bestValue = values[0];
  let bestTotalPoints = -Infinity;
  let bestSummary: SimSummary | null = null;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    // Clone params so the calling site's reference is left intact when the
    // worker round-trips the result back. Spread is shallow but params
    // values are primitive numbers so it's enough.
    const candParams = { ...baseParams, [paramKey]: v };
    const r = runBacktestAcrossSessions({
      sessions,
      strategy,
      params: candParams,
      rules,
      maxHoldBars,
      indicatorConfig,
    });
    const summary = computeSimSummary(r.trades);

    // Maximize totalPoints — same objective as the SL/TP/TSL optimizer's
    // default. Tie-break on profit factor (steadier trade-by-trade is
    // preferred when raw P&L is identical). Empty results lose every
    // comparison naturally because they produce 0 totalPoints.
    if (
      summary.totalPoints > bestTotalPoints ||
      (summary.totalPoints === bestTotalPoints &&
        bestSummary !== null &&
        summary.profitFactor > bestSummary.profitFactor)
    ) {
      bestTotalPoints = summary.totalPoints;
      bestSummary = summary;
      bestValue = v;
    }

    // Yield once per candidate. The pump in the worker uses this to post
    // progress AND to give the worker's event loop a chance to receive
    // cancel messages between candidates.
    yield { progress: (i + 1) / values.length };
  }

  return {
    bestValue,
    bestTotalPoints: Number.isFinite(bestTotalPoints) ? bestTotalPoints : 0,
    bestSummary: bestSummary ?? computeSimSummary([]),
    valuesTested: values.length,
    elapsedMs: Math.round(performance.now() - startMs),
  };
}
