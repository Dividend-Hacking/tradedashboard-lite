/**
 * built-in-strategies.ts — DSL translations of the legacy hardcoded
 * strategies that previously lived as `generateSignals` functions in
 * backtest-engine.ts.
 *
 * Each entry exports:
 *   - id: same string the legacy registry used (so existing presets and
 *     NT8 conversion can keep recognizing builtins by id)
 *   - label, description: surfaced in the dashboard's "Templates" picker
 *   - script: the DSL text (loaded into the editor when the user picks
 *     this template)
 *   - paramMeta: defaults / min / max / step / type for every params.X
 *     reference in the script — drives the inferred-param sidebar
 *
 * Parity goal: at default params, evaluating each of these scripts via
 * `evaluateStrategyScript` should produce a `BacktestSignal[]` byte-
 * identical to what the legacy `generateSignals` produced. The parity
 * test harness in strategy-evaluator-parity.test.ts (TODO) is the gate
 * for deleting the legacy generators.
 *
 * Translation conventions:
 *   - `range_high`, `range_low` are computed via `high(N)` / `low(N)`
 *     which exclude the current bar — matches v1's inner loop iterating
 *     `for j in [i-lookback, i-1]`.
 *   - `move5`, `move10` use postfix `[k]` to look back N bars on `close`.
 *   - "Stale break" detection uses `bars_since_high(N)` / `bars_since_low(N)`,
 *     which precompute the bar-distance to the argmax/argmin of the
 *     forward-iterated lookback window — same first-occurrence-wins
 *     tie-breaking the legacy code used.
 *   - V2/V3 lockouts are expressed via `bars_since(signal.long)` plus
 *     `any_bar_in(elapsed, pos < exit)` for the "released by exit-zone
 *     dip" condition. The two together reproduce v2's stateful
 *     `longLockedSinceBar = -1` release semantics.
 */

export interface ParamMeta {
  default: number;
  min?: number;
  max?: number;
  step?: number;
  type?: "int" | "float";
  label?: string;
  description?: string;
  /** Worked examples surfaced on the /script-reference page. */
  examples?: { snippet: string; scenario: string }[];
}

export interface StrategyTemplate {
  id: string;
  label: string;
  description: string;
  /** The DSL script text. */
  script: string;
  /** Inferred-param metadata. Keys MUST match every `params.X` reference
   *  in `script`. The dashboard sidebar reads these as defaults/UI hints
   *  and writes user-tuned values back into `preset.paramMeta`. */
  paramMeta: Record<string, ParamMeta>;
  /** Legacy strategy id — kept on builtins so the auto-trader and NT8
   *  conversion paths can recognize templates by id while the dashboard
   *  has migrated to script-based authoring. New user strategies don't
   *  set this. */
  legacyStrategyId?: string;
}

// ─── Signal V1: range_size-break + pullback ────────────────────────────────────

const SIGNAL_V1_SCRIPT = `// Signal V1 — range_size-break + pullback
// Fires at recent-range_size edges with a small counter-trend pullback,
// filtering out flat momentum and stale levels.

// Pre-entry range_size (excludes current bar).
let range_high = high(params.lookback)
let range_low  = low(params.lookback)
let range_size      = range_high - range_low

// Volatility & validity.
let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

// Position in range_size.
let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

// 5- and 10-bar momentum measured from the bar BEFORE current.
let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

// F2 flat momentum filter — both windows must be quiet to reject.
let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

// F3 stale level — the rolling-window extremum was set more than
// staleBarsBack bars ago AND price has poked past it.
let bs_long_level  = bars_since_high(params.lookback)
let bs_short_level = bars_since_low(params.lookback)
let long_stale     = long_pos > params.staleBreakThreshold && bs_long_level > params.staleBarsBack
let short_stale    = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

// Long setup: at-edge fires unconditionally; near-edge requires a small
// counter-trend pullback (move5 in [-pullback*atr, 0]).
let long_at_edge      = long_pos >= params.atEdgeThreshold
let long_near_edge    = long_pos >= params.nearEdgeThreshold
let long_pullback_min = 0 - params.pullbackAtrFraction * atr
let long_pullback_ok  = move5 >= long_pullback_min && move5 <= 0
let long_setup        = long_at_edge || (long_near_edge && long_pullback_ok)

// Short setup mirrors long.
let short_at_edge      = short_pos >= params.atEdgeThreshold
let short_near_edge    = short_pos >= params.nearEdgeThreshold
let short_pullback_max = params.pullbackAtrFraction * atr
let short_pullback_ok  = move5 >= 0 && move5 <= short_pullback_max
let short_setup        = short_at_edge || (short_near_edge && short_pullback_ok)

// Triggers (candle direction).
let long_trigger  = close > open
let short_trigger = close < open

signal.long.if = valid,
                 !is_flat,
                 long_setup,
                 !long_stale,
                 long_trigger

signal.short.if = valid,
                  !is_flat,
                  short_setup,
                  !short_stale,
                  short_trigger
`;

const SIGNAL_V1_PARAMS: Record<string, ParamMeta> = {
  lookback: {
    default: 20,
    min: 5,
    max: 200,
    step: 1,
    type: "int",
    label: "Lookback (bars)",
    description: "How many bars back to look at when figuring out the recent high and low. Bigger = wider range, fewer signals. Smaller = faster but more noise.",
    examples: [
      { snippet: "params.lookback = 20", scenario: "Use the last 20 bars to define the trading range." },
    ],
  },
  atrPeriod: {
    default: 14,
    min: 5,
    max: 50,
    step: 1,
    type: "int",
    label: "ATR period",
    description: "How many bars are used to calculate the typical price wiggle (ATR). 14 is the classic setting.",
  },
  atEdgeThreshold: {
    default: 0.85,
    min: 0.5,
    max: 1.5,
    step: 0.05,
    type: "float",
    label: "At-edge threshold",
    description: "How close to the edge of the range price has to be (as a 0–1 score) before the strategy fires no matter what. Higher = stricter; only fires at extremes.",
    examples: [
      { snippet: "params.atEdgeThreshold = 0.9", scenario: "Only fire at the very edge of the range — 90% of the way there." },
    ],
  },
  nearEdgeThreshold: {
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    type: "float",
    label: "Near-edge threshold",
    description: "Less strict edge — fires only with a small pullback against the trend. 0.5 = halfway up the range.",
  },
  pullbackAtrFraction: {
    default: 0.4,
    min: 0,
    max: 2,
    step: 0.1,
    type: "float",
    label: "Pullback × ATR",
    description: "How big a counter-trend pullback is allowed before firing. Measured in ATR units (so it scales with volatility).",
  },
  flatAtrFraction: {
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.05,
    type: "float",
    label: "Flat × ATR",
    description: "If both the 5-bar and 10-bar price moves are smaller than this × ATR, the market is too quiet and trades get rejected.",
  },
  staleBreakThreshold: {
    default: 1.05,
    min: 1,
    max: 2,
    step: 0.05,
    type: "float",
    label: "Stale-break threshold",
    description: "If price has poked past the range edge too much, treat it as a stale level and reject re-tests.",
  },
  staleBarsBack: {
    default: 15,
    min: 0,
    max: 50,
    step: 1,
    type: "int",
    label: "Stale bars back",
    description: "How long ago a high/low was set to consider it \"stale\". Old broken levels often re-test poorly.",
  },
};

// ─── Signal V2: V1 + cross-into-zone + lockout + base filter ──────────────

const SIGNAL_V2_SCRIPT = `// Signal V2 — V1 + cross-into-zone + lockout + base filter

// Pre-entry range_size (excludes current bar).
let range_high = high(params.lookback)
let range_low  = low(params.lookback)
let range_size      = range_high - range_low

let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

let bs_long_level  = bars_since_high(params.lookback)
let bs_short_level = bars_since_low(params.lookback)
let long_stale     = long_pos > params.staleBreakThreshold && bs_long_level > params.staleBarsBack
let short_stale    = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

// Base filter: range_size/ATR within bounds AND drift below threshold.
// Drift = |close[1] - close[lookback]| / range_size.
let range_in_atr = range_size / atr
let drift        = abs(close[1] - close[params.lookback])
let drift_frac   = drift / range_size
let is_base      = range_in_atr >= params.baseRangeAtrMin
                && range_in_atr <= params.baseRangeAtrMax
                && drift_frac   <  params.baseDriftFraction

// Cross-into-zone — position transitions from < enter to >= enter.
let long_crossed_in  = cross_up(long_pos,  params.zoneEnterV2)
let short_crossed_in = cross_up(short_pos, params.zoneEnterV2)

// Lockout state — fires set bars_since(signal); release after either
// the cooldown bars elapse OR position dips below the exit threshold.
let long_elapsed       = bars_since(signal.long)
let long_in_window     = long_elapsed < params.cooldownBarsV2
let long_released      = any_bar_in(long_elapsed, long_pos < params.zoneExitV2)
let long_locked        = long_in_window && !long_released

let short_elapsed      = bars_since(signal.short)
let short_in_window    = short_elapsed < params.cooldownBarsV2
let short_released     = any_bar_in(short_elapsed, short_pos < params.zoneExitV2)
let short_locked       = short_in_window && !short_released

// Setup gates (same as V1).
let long_at_edge      = long_pos >= params.atEdgeThreshold
let long_near_edge    = long_pos >= params.nearEdgeThreshold
let long_pullback_min = 0 - params.pullbackAtrFraction * atr
let long_pullback_ok  = move5 >= long_pullback_min && move5 <= 0
let long_setup        = long_at_edge || (long_near_edge && long_pullback_ok)

let short_at_edge      = short_pos >= params.atEdgeThreshold
let short_near_edge    = short_pos >= params.nearEdgeThreshold
let short_pullback_max = params.pullbackAtrFraction * atr
let short_pullback_ok  = move5 >= 0 && move5 <= short_pullback_max
let short_setup        = short_at_edge || (short_near_edge && short_pullback_ok)

let long_trigger  = close > open
let short_trigger = close < open

signal.long.if = valid,
                 !long_locked,
                 long_crossed_in,
                 is_base,
                 !is_flat,
                 long_setup,
                 !long_stale,
                 long_trigger

signal.short.if = valid,
                  !short_locked,
                  short_crossed_in,
                  is_base,
                  !is_flat,
                  short_setup,
                  !short_stale,
                  short_trigger
`;

const SIGNAL_V2_PARAMS: Record<string, ParamMeta> = {
  ...SIGNAL_V1_PARAMS,
  zoneEnterV2: {
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    type: "float",
    label: "Zone enter (cross up)",
    description: "Price has to cross from below this level to above it on a single bar to trigger. Stops re-fires when price is just hanging out near the edge.",
    examples: [
      { snippet: "params.zoneEnterV2 = 0.5", scenario: "Trigger only when price has freshly crossed up through the halfway mark of the range." },
    ],
  },
  zoneExitV2: {
    default: 0.3,
    min: 0,
    max: 1,
    step: 0.05,
    type: "float",
    label: "Zone exit (release)",
    description: "After firing, the strategy locks itself out until price drops back below this level. Prevents back-to-back re-entries.",
  },
  cooldownBarsV2: {
    default: 30,
    min: 0,
    max: 200,
    step: 1,
    type: "int",
    label: "Cooldown (bars)",
    description: "Backup lockout — if price never drops below the exit threshold, the strategy unlocks itself after this many bars anyway.",
  },
  baseRangeAtrMin: {
    default: 1.5,
    min: 0,
    max: 10,
    step: 0.1,
    type: "float",
    label: "Base range_size × ATR (min)",
    description: "Smallest allowed base size, measured in ATR units. Filters out ultra-tight, chop-prone bases.",
  },
  baseRangeAtrMax: {
    default: 4.0,
    min: 0,
    max: 20,
    step: 0.1,
    type: "float",
    label: "Base range_size × ATR (max)",
    description: "Largest allowed base size, in ATR units. Filters out already-trending bases that are too wide to call a base.",
  },
  baseDriftFraction: {
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    type: "float",
    label: "Base drift fraction",
    description: "How much the base is allowed to drift before it's considered a trend instead of a base. Smaller = stricter (only flat bases allowed).",
  },
};

// ─── Signal V3: V2 + multi-bar acceptance + body/range_size trigger ────────────

const SIGNAL_V3_SCRIPT = `// Signal V3 — V2 + multi-bar acceptance + body/range_size trigger

let range_high = high(params.lookback)
let range_low  = low(params.lookback)
let range_size      = range_high - range_low

let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

let bs_long_level  = bars_since_high(params.lookback)
let bs_short_level = bars_since_low(params.lookback)
let long_stale     = long_pos > params.staleBreakThreshold && bs_long_level > params.staleBarsBack
let short_stale    = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

let range_in_atr = range_size / atr
let drift        = abs(close[1] - close[params.lookback])
let drift_frac   = drift / range_size
let is_base      = range_in_atr >= params.baseRangeAtrMin
                && range_in_atr <= params.baseRangeAtrMax
                && drift_frac   <  params.baseDriftFraction

// V3 multi-bar acceptance: instead of a single-bar cross, position must
// be at-or-above the enter zone for acceptanceBarsV3 consecutive bars.
// Equivalent to: every bar in the last N bars had pos >= enter, AND the
// bar BEFORE the streak had pos < enter.
let long_streak_full   = !any_bar_in(params.acceptanceBarsV3, long_pos  < params.zoneEnterV2)
let long_pre_streak    = long_pos[params.acceptanceBarsV3] < params.zoneEnterV2
let long_accepted      = long_streak_full && long_pre_streak

let short_streak_full  = !any_bar_in(params.acceptanceBarsV3, short_pos < params.zoneEnterV2)
let short_pre_streak   = short_pos[params.acceptanceBarsV3] < params.zoneEnterV2
let short_accepted     = short_streak_full && short_pre_streak

// Lockout state (same as V2).
let long_elapsed       = bars_since(signal.long)
let long_in_window     = long_elapsed < params.cooldownBarsV2
let long_released      = any_bar_in(long_elapsed, long_pos < params.zoneExitV2)
let long_locked        = long_in_window && !long_released

let short_elapsed      = bars_since(signal.short)
let short_in_window    = short_elapsed < params.cooldownBarsV2
let short_released     = any_bar_in(short_elapsed, short_pos < params.zoneExitV2)
let short_locked       = short_in_window && !short_released

let long_at_edge      = long_pos >= params.atEdgeThreshold
let long_near_edge    = long_pos >= params.nearEdgeThreshold
let long_pullback_min = 0 - params.pullbackAtrFraction * atr
let long_pullback_ok  = move5 >= long_pullback_min && move5 <= 0
let long_setup        = long_at_edge || (long_near_edge && long_pullback_ok)

let short_at_edge      = short_pos >= params.atEdgeThreshold
let short_near_edge    = short_pos >= params.nearEdgeThreshold
let short_pullback_max = params.pullbackAtrFraction * atr
let short_pullback_ok  = move5 >= 0 && move5 <= short_pullback_max
let short_setup        = short_at_edge || (short_near_edge && short_pullback_ok)

// V3 body/range_size trigger — body must occupy >= bodyRatioMinV3 of the bar's
// range_size. Replaces V2's bare close>open / close<open.
let bar_range  = high - low
let body_ratio = if bar_range > 0 then abs(close - open) / bar_range else 0
let long_trigger  = close > open && body_ratio >= params.bodyRatioMinV3
let short_trigger = close < open && body_ratio >= params.bodyRatioMinV3

signal.long.if = valid,
                 !long_locked,
                 long_accepted,
                 is_base,
                 !is_flat,
                 long_setup,
                 !long_stale,
                 long_trigger

signal.short.if = valid,
                  !short_locked,
                  short_accepted,
                  is_base,
                  !is_flat,
                  short_setup,
                  !short_stale,
                  short_trigger
`;

const SIGNAL_V3_PARAMS: Record<string, ParamMeta> = {
  ...SIGNAL_V2_PARAMS,
  acceptanceBarsV3: {
    default: 2,
    min: 1,
    max: 20,
    step: 1,
    type: "int",
    label: "Acceptance bars (in-zone streak)",
    description: "How many bars in a row price has to stay in the trigger zone before firing. Bigger = stricter, fewer false starts.",
    examples: [
      { snippet: "params.acceptanceBarsV3 = 3", scenario: "Wait for 3 bars in a row in the zone before triggering — slower but more confirmed." },
    ],
  },
  bodyRatioMinV3: {
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    type: "float",
    label: "Body / range_size (min)",
    description: "How much of the trigger bar has to be \"body\" (not wicks). 0.5 = body must be at least half the bar's full range. Filters out wicky, indecisive candles.",
  },
};

// ─── Signal V2 Failed: invert V2 directions ───────────────────────────────
//
// In the legacy code this was a thin wrapper that flipped V2's emitted
// directions. We translate by writing the V2 conditions on the OPPOSITE
// side: where V2's long.if fires, this strategy's short.if fires.

const SIGNAL_V2_FAILED_SCRIPT = `// Signal V2 Failed — fade-on-V2-criteria
// Identical gating to V2, but each side fires the OPPOSITE direction.

let range_high = high(params.lookback)
let range_low  = low(params.lookback)
let range_size      = range_high - range_low

let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

let bs_long_level  = bars_since_high(params.lookback)
let bs_short_level = bars_since_low(params.lookback)
let long_stale     = long_pos > params.staleBreakThreshold && bs_long_level > params.staleBarsBack
let short_stale    = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

let range_in_atr = range_size / atr
let drift        = abs(close[1] - close[params.lookback])
let drift_frac   = drift / range_size
let is_base      = range_in_atr >= params.baseRangeAtrMin
                && range_in_atr <= params.baseRangeAtrMax
                && drift_frac   <  params.baseDriftFraction

let long_crossed_in  = cross_up(long_pos,  params.zoneEnterV2)
let short_crossed_in = cross_up(short_pos, params.zoneEnterV2)

// Lockouts — note this strategy's firings are flipped, so a long-side
// V2 setup fires a SHORT signal here. The lockout reads the short
// firings array to gate long-side V2 setups (which fire short), and
// vice versa.
let long_elapsed     = bars_since(signal.short)
let long_in_window   = long_elapsed < params.cooldownBarsV2
let long_released    = any_bar_in(long_elapsed, long_pos < params.zoneExitV2)
let long_locked      = long_in_window && !long_released

let short_elapsed    = bars_since(signal.long)
let short_in_window  = short_elapsed < params.cooldownBarsV2
let short_released   = any_bar_in(short_elapsed, short_pos < params.zoneExitV2)
let short_locked     = short_in_window && !short_released

let long_at_edge      = long_pos >= params.atEdgeThreshold
let long_near_edge    = long_pos >= params.nearEdgeThreshold
let long_pullback_min = 0 - params.pullbackAtrFraction * atr
let long_pullback_ok  = move5 >= long_pullback_min && move5 <= 0
let long_setup        = long_at_edge || (long_near_edge && long_pullback_ok)

let short_at_edge      = short_pos >= params.atEdgeThreshold
let short_near_edge    = short_pos >= params.nearEdgeThreshold
let short_pullback_max = params.pullbackAtrFraction * atr
let short_pullback_ok  = move5 >= 0 && move5 <= short_pullback_max
let short_setup        = short_at_edge || (short_near_edge && short_pullback_ok)

let long_trigger  = close > open
let short_trigger = close < open

// V2 long-side setup → fires SHORT here. V2 short-side setup → fires LONG.
signal.short.if = valid,
                  !long_locked,
                  long_crossed_in,
                  is_base,
                  !is_flat,
                  long_setup,
                  !long_stale,
                  long_trigger

signal.long.if = valid,
                 !short_locked,
                 short_crossed_in,
                 is_base,
                 !is_flat,
                 short_setup,
                 !short_stale,
                 short_trigger
`;

const SIGNAL_V2_FAILED_PARAMS = SIGNAL_V2_PARAMS;

// ─── Failed Break V1: fade-native (thrust + sweep + trending base) ────────

const FAILED_BREAK_V1_SCRIPT = `// Failed Break V1 — fade-native rebuild of v2_failed.
// FIX 1: pullback gate replaced by a SAME-DIRECTION thrust into the level.
// FIX 2: wick-sweep gate added — the bar must pierce the level by sweep × ATR.
// FIX 3: base filter flipped — drift must be HIGH (trending), no upper bound on range_size/ATR.

let range_high = high(params.lookback)
let range_low  = low(params.lookback)
let range_size      = range_high - range_low

let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

let bs_long_level  = bars_since_high(params.lookback)
let bs_short_level = bars_since_low(params.lookback)
let long_stale     = long_pos > params.staleBreakThreshold && bs_long_level > params.staleBarsBack
let short_stale    = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

// Fade-tuned base filter: rangeInAtr lower-bound only, drift HIGH (trending).
let range_in_atr = range_size / atr
let drift        = abs(close[1] - close[params.lookback])
let drift_frac   = drift / range_size
let is_fade_base = range_in_atr >= params.fadeRangeAtrMin && drift_frac >= params.fadeDriftFractionMin

let long_crossed_in  = cross_up(long_pos,  params.zoneEnterV2)
let short_crossed_in = cross_up(short_pos, params.zoneEnterV2)

// Lockouts — same flipped semantics as v2_failed: long-side V2 setup
// fires SHORT here, so the lockout reads the short firings.
let long_elapsed     = bars_since(signal.short)
let long_in_window   = long_elapsed < params.cooldownBarsV2
let long_released    = any_bar_in(long_elapsed, long_pos < params.zoneExitV2)
let long_locked      = long_in_window && !long_released

let short_elapsed    = bars_since(signal.long)
let short_in_window  = short_elapsed < params.cooldownBarsV2
let short_released   = any_bar_in(short_elapsed, short_pos < params.zoneExitV2)
let short_locked     = short_in_window && !short_released

// FIX 1: thrust into the level (same direction, not pullback).
let thrust_min            = params.thrustAtrFraction * atr
let long_breakout_at_edge = long_pos >= params.atEdgeThreshold
let long_breakout_near    = long_pos >= params.nearEdgeThreshold && move5 >= thrust_min
let long_breakout_setup   = long_breakout_at_edge || long_breakout_near

let short_breakout_at_edge = short_pos >= params.atEdgeThreshold
let short_breakout_near    = short_pos >= params.nearEdgeThreshold && move5 <= 0 - thrust_min
let short_breakout_setup   = short_breakout_at_edge || short_breakout_near

// FIX 2: wick must pierce the level by sweep × ATR.
let sweep_min   = params.sweepAtrFraction * atr
let long_sweep  = high >= range_high + sweep_min
let short_sweep = low  <= range_low  - sweep_min

let long_trigger  = close > open
let short_trigger = close < open

// LONG-side breakout poke → SHORT signal. SHORT-side poke → LONG signal.
signal.short.if = valid,
                  !long_locked,
                  long_crossed_in,
                  is_fade_base,
                  !is_flat,
                  long_breakout_setup,
                  long_sweep,
                  !long_stale,
                  long_trigger

signal.long.if = valid,
                 !short_locked,
                 short_crossed_in,
                 is_fade_base,
                 !is_flat,
                 short_breakout_setup,
                 short_sweep,
                 !short_stale,
                 short_trigger
`;

// Most of these are shared with V1/V2 — buildParamSchemaEntries dedupes by
// param key so the descriptions on the V1 entry above are what appears in
// docs. Only the FADE-specific params need their own friendly descriptions.
const FAILED_BREAK_V1_PARAMS: Record<string, ParamMeta> = {
  lookback: { default: 20, min: 5, max: 200, step: 1, type: "int", label: "Lookback (bars)" },
  atrPeriod: { default: 14, min: 5, max: 50, step: 1, type: "int", label: "ATR period" },
  atEdgeThreshold: { default: 0.85, min: 0.5, max: 1.5, step: 0.05, type: "float", label: "At-edge threshold" },
  nearEdgeThreshold: { default: 0.5, min: 0, max: 1, step: 0.05, type: "float", label: "Near-edge threshold" },
  thrustAtrFraction: {
    default: 0.5,
    min: 0,
    max: 3,
    step: 0.1,
    type: "float",
    label: "Thrust × ATR (into level)",
    description: "How big a same-direction price thrust into the level is required before fading. Bigger = waits for stronger pushes (which then fail bigger).",
  },
  sweepAtrFraction: {
    default: 0.1,
    min: 0,
    max: 2,
    step: 0.05,
    type: "float",
    label: "Sweep wick × ATR",
    description: "How far the wick has to poke past the level. Picks up classic stop-sweep failed breakouts.",
  },
  flatAtrFraction: { default: 0.2, min: 0, max: 1, step: 0.05, type: "float", label: "Flat × ATR" },
  staleBreakThreshold: { default: 1.05, min: 1, max: 2, step: 0.05, type: "float", label: "Stale-break threshold" },
  staleBarsBack: { default: 15, min: 0, max: 50, step: 1, type: "int", label: "Stale bars back" },
  zoneEnterV2: { default: 0.5, min: 0, max: 1, step: 0.05, type: "float", label: "Zone enter (cross up)" },
  zoneExitV2: { default: 0.3, min: 0, max: 1, step: 0.05, type: "float", label: "Zone exit (release)" },
  cooldownBarsV2: { default: 30, min: 0, max: 200, step: 1, type: "int", label: "Cooldown (bars)" },
  fadeRangeAtrMin: {
    default: 1.0,
    min: 0,
    max: 10,
    step: 0.1,
    type: "float",
    label: "Fade range_size × ATR (min)",
    description: "Smallest range size (in ATR units) the fade strategy will accept. Skips ranges that are too tight.",
  },
  fadeDriftFractionMin: {
    default: 0.4,
    min: 0,
    max: 2,
    step: 0.05,
    type: "float",
    label: "Fade drift fraction (min)",
    description: "How trending the approach needs to be for a fade. Bigger = requires a more obvious one-way push before fading it.",
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────

export const BUILTIN_STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: "signal_v1",
    label: "Signal v1 (range_size-break + pullback)",
    description: "Fires at recent-range_size edges with a small counter-trend pullback. Filters out flat momentum and re-tests of stale levels.",
    script: SIGNAL_V1_SCRIPT,
    paramMeta: SIGNAL_V1_PARAMS,
    legacyStrategyId: "signal_v1",
  },
  {
    id: "signal_v2",
    label: "Signal v2 (cross-into-zone + lockout + base filter)",
    description: "V1 setup gates plus: fires only on the bar that crosses into the zone, per-direction lockout to prevent re-fires, and a base-quality filter on the lookback window.",
    script: SIGNAL_V2_SCRIPT,
    paramMeta: SIGNAL_V2_PARAMS,
    legacyStrategyId: "signal_v2",
  },
  {
    id: "signal_v3",
    label: "Signal v3 (V2 + multi-bar acceptance + body/range_size trigger)",
    description: "V2 with two tightenings for fast/low-timeframe data: requires the in-zone position to hold for N consecutive bars before firing, and the trigger bar's body must occupy a minimum fraction of its range_size.",
    script: SIGNAL_V3_SCRIPT,
    paramMeta: SIGNAL_V3_PARAMS,
    legacyStrategyId: "signal_v3",
  },
  {
    id: "signal_v2_failed",
    label: "Signal v2 failed (inverse — fade the breakout)",
    description: "Identical gating to v2 (same params), but every signal's direction is flipped. Where v2 prints Long on an upside breakout this prints Short.",
    script: SIGNAL_V2_FAILED_SCRIPT,
    paramMeta: SIGNAL_V2_FAILED_PARAMS,
    legacyStrategyId: "signal_v2_failed",
  },
  {
    id: "failed_break_v1",
    label: "Failed Break v1 (fade-native: thrust + sweep + trending base)",
    description: "Fade-native rebuild of v2_failed. Replaces V2's counter-trend pullback with a same-direction thrust, adds a wick-sweep gate, and flips the base filter to require a trending approach.",
    script: FAILED_BREAK_V1_SCRIPT,
    paramMeta: FAILED_BREAK_V1_PARAMS,
    legacyStrategyId: "failed_break_v1",
  },
];

/** Look up a builtin template by its legacy strategy id. Used by the
 *  preset upgrader to migrate v1 presets that referenced strategies by
 *  id into v2 presets that carry the script text. */
export function findTemplateByLegacyId(id: string): StrategyTemplate | undefined {
  return BUILTIN_STRATEGY_TEMPLATES.find((t) => t.legacyStrategyId === id);
}

/** Build a `Record<string, number>` of default param values for a
 *  template — the same shape `defaultParamsFor` produced for the legacy
 *  StrategyDef registry. */
export function defaultParamsFor(template: StrategyTemplate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, m] of Object.entries(template.paramMeta)) out[k] = m.default;
  return out;
}
