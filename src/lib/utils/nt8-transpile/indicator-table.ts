/**
 * indicator-table.ts — Map DSL indicator names to C# call expressions
 * emitted by the transpiler.
 *
 * Single source of truth for how each indicator surfaces in the generated
 * NinjaScript. Two output channels:
 *
 *   1. csCall(name, args, ctx) → string
 *      - For most indicators the transpiler emits a call into the
 *        `_dsl.<Name>(...)` static helpers in DslIndicators.cs that
 *        operate over the strategy's rolling bar buffer (`_bars`).
 *      - For indicators NT8 ships natively (none in v1; we own all the
 *        math to keep parity with the dashboard byte-for-byte) this
 *        could later flip to `Indicator.X(...)`. Not used in v1.
 *
 *   2. requiresTicks(name) → boolean
 *      - Mirror of TICK_REQUIRED_INDICATORS in script-expr.ts. The
 *        transpiler ORs across every indicator call in the AST to
 *        decide whether the generated strategy needs an
 *        `AddDataSeries(BarsPeriodType.Tick, 1)` channel.
 *
 * The generated C# treats every indicator as "compute on-demand at
 * the current bar". The DslIndicators helpers cache full series
 * keyed by name+period internally so repeated calls within a bar
 * (or across bars within a window) don't re-walk the bar buffer.
 *
 * Parity: every formula here MUST match script-expr.ts line-for-line.
 * That correspondence is enforced by the parity harness, not the
 * type system, so any new DSL indicator MUST be added to both
 * sides at the same time.
 */

/** Indicators that need raw tick data — POC family + tick microstructure.
 *  Mirrors TICK_REQUIRED_INDICATORS in script-expr.ts:950. */
export const TICK_REQUIRED_INDICATORS = new Set<string>([
  "POC",
  "VAH",
  "VAL",
  "VA_width",
  "dist_to_POC",
  "trades_at_bid",
  "trades_at_ask",
  "tick_imbalance",
  "tick_count",
  "mean_trade_size",
  "large_trade_count",
  "vwap_tick",
]);

/** Bid/ask scalars that need at least bar-level bid/ask volume. They
 *  don't need a tick channel per se — NT8 exposes per-bar bid/ask via
 *  GetVolumeAtBid(idx) / GetVolumeAtAsk(idx) on tick-merged series —
 *  but we wire the same tick channel for them so we have one consistent
 *  path for any order-flow data. The transpiler folds this into
 *  `requiresTicks` too. */
export const BIDASK_SCALARS = new Set<string>([
  "delta",
  "delta_ratio",
  "buy_pressure",
  "bar_volume_bid",
  "bar_volume_ask",
  "buy_volume",
  "sell_volume",
]);

/** True when a DSL call requires the tick data series in NT8. */
export function callRequiresTicks(name: string): boolean {
  return TICK_REQUIRED_INDICATORS.has(name);
}

/** Stable C# identifier suffix for an indicator call — used to name
 *  the cached series field on the generated strategy class so we don't
 *  recompute the same series multiple times within a bar. */
export function indicatorCacheSlot(name: string, args: number[]): string {
  if (args.length === 0) return `_ind_${name}`;
  return `_ind_${name}_${args.map((a) => String(a).replace(/[^A-Za-z0-9]/g, "_")).join("_")}`;
}

/** Map a DSL indicator name to the C# helper method on DslIndicators.
 *  The helper signature is always
 *      double DslIndicators.<Method>(IList<DslBar> bars, int barIdx, params double[] args)
 *  so the transpiler can emit calls uniformly without knowing the
 *  per-indicator arity. The C# side dispatches on argument count.
 *
 *  Returns null for unrecognized names — caller emits a
 *  TranspileError and falls through to NaN at runtime. */
export function csIndicatorMethod(name: string): string | null {
  // Single-period MA family.
  switch (name) {
    case "ATR":
      return "Atr";
    case "EMA":
      return "Ema";
    case "SMA":
      return "Sma";
    case "WMA":
      return "Wma";
    case "HMA":
      return "Hma";
    case "DEMA":
      return "Dema";
    case "TEMA":
      return "Tema";
    case "VWMA":
      return "Vwma";
    // Trend strength / direction.
    case "ADX":
      return "Adx";
    case "DIplus":
      return "DiPlus";
    case "DIminus":
      return "DiMinus";
    // Oscillators.
    case "RSI":
      return "Rsi";
    case "ROC":
      return "Roc";
    case "MOM":
      return "Mom";
    case "CCI":
      return "Cci";
    case "WilliamsR":
      return "WilliamsR";
    case "TRIX":
      return "Trix";
    case "MFI":
      return "Mfi";
    case "Fisher":
      return "Fisher";
    case "UO":
      return "Uo";
    case "Choppiness":
      return "Choppiness";
    case "Ulcer":
      return "Ulcer";
    case "Zscore":
      return "Zscore";
    case "Stoch_K":
      return "StochK";
    case "Stoch_D":
      return "StochD";
    // Volatility.
    case "NATR":
      return "Natr";
    case "HV":
      return "Hv";
    case "TR":
      return "Tr";
    case "stdev":
      return "Stdev";
    // Channels.
    case "BB_mid":
      return "BbMid";
    case "BB_upper":
      return "BbUpper";
    case "BB_lower":
      return "BbLower";
    case "BB_width":
      return "BbWidth";
    case "BB_percent":
      return "BbPercent";
    case "Donchian_upper":
      return "DonchianUpper";
    case "Donchian_lower":
      return "DonchianLower";
    case "Donchian_mid":
      return "DonchianMid";
    case "Keltner_mid":
      return "KeltnerMid";
    case "Keltner_upper":
      return "KeltnerUpper";
    case "Keltner_lower":
      return "KeltnerLower";
    // Trailing systems.
    case "Supertrend":
      return "Supertrend";
    case "PSAR":
      return "Psar";
    // MACD legs.
    case "MACD_line":
      return "MacdLine";
    case "MACD_signal":
      return "MacdSignal";
    case "MACD_hist":
      return "MacdHist";
    // Volume / accumulation.
    case "volume":
    case "trailVol":
      return "VolumeMa";
    case "OBV":
      return "Obv";
    case "AD":
      return "Ad";
    case "CMF":
      return "Cmf";
    case "CVD":
      return "Cvd";
    case "AO":
      return "Ao";
    case "NVI":
      return "Nvi";
    case "PVI":
      return "Pvi";
    case "VWAP":
      return "Vwap";
    case "KVO":
      return "Kvo";
    case "ForceIndex":
      return "ForceIndex";
    case "EMV":
      return "Emv";
    // Rolling extremums (positional lookback).
    case "HHV":
      return "Hhv";
    case "LLV":
      return "Llv";
    case "close_n":
      return "CloseN";
    case "high_n":
      return "HighN";
    case "low_n":
      return "LowN";
    case "open_n":
      return "OpenN";
    case "volume_n":
      return "VolumeN";
    // Aroon / Vortex.
    case "Aroon_up":
      return "AroonUp";
    case "Aroon_down":
      return "AroonDown";
    case "Aroon_osc":
      return "AroonOsc";
    case "VortexPlus":
      return "VortexPlus";
    case "VortexMinus":
      return "VortexMinus";
    // Linear regression family.
    case "LRSlope":
      return "LrSlope";
    case "LRIntercept":
      return "LrIntercept";
    case "LRValue":
      return "LrValue";
    case "R2":
      return "R2";
    // Ichimoku family.
    case "Ichimoku_tenkan":
      return "IchimokuTenkan";
    case "Ichimoku_kijun":
      return "IchimokuKijun";
    case "Ichimoku_senkouA":
      return "IchimokuSenkouA";
    case "Ichimoku_senkouB":
      return "IchimokuSenkouB";
    case "Ichimoku_chikou":
      return "IchimokuChikou";
    // Tick / volume profile (route via DslTickAggregator).
    case "POC":
      return "Poc";
    case "VAH":
      return "Vah";
    case "VAL":
      return "Val";
    case "VA_width":
      return "VaWidth";
    case "dist_to_POC":
      return "DistToPoc";
    case "trades_at_bid":
      return "TradesAtBid";
    case "trades_at_ask":
      return "TradesAtAsk";
    case "tick_imbalance":
      return "TickImbalance";
    case "tick_count":
      return "TickCount";
    case "mean_trade_size":
      return "MeanTradeSize";
    case "large_trade_count":
      return "LargeTradeCount";
    case "vwap_tick":
      return "VwapTick";
    // Kalman-OU bundle — six sibling indicators that all share one
    // filter pass internally on the C# side. The DSL `let kf =
    // KALMAN_OU(close, 60, 0.5); kf.x_pred` syntax is rewritten at
    // parse time (strategy-evaluator.ts:231-272) into flat calls like
    // `KALMAN_OU_x_pred(1, 60, 0.5)`, so the transpiler only ever
    // sees these sibling names — never the bare `KALMAN_OU` or the
    // `kf.field` member-access form.
    case "KALMAN_OU_x":
      return "KalmanOuX";
    case "KALMAN_OU_mu":
      return "KalmanOuMu";
    case "KALMAN_OU_sigma":
      return "KalmanOuSigma";
    case "KALMAN_OU_phi":
      return "KalmanOuPhi";
    case "KALMAN_OU_P":
      return "KalmanOuP";
    case "KALMAN_OU_x_pred":
      return "KalmanOuXPred";
    default:
      return null;
  }
}

/** Tick-routed indicators emit `_ticks.<Method>(...)` instead of
 *  `_dsl.<Method>(...)` because the tick aggregator owns the tick
 *  buffer and bid/ask attribution. The tick aggregator is null when
 *  the strategy doesn't need ticks; the transpiler wires the field
 *  conditionally. */
export function isTickRouted(name: string): boolean {
  return TICK_REQUIRED_INDICATORS.has(name);
}
