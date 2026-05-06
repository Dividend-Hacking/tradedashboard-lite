/**
 * Zone Simulator Engine
 *
 * Walks each trade zone bar-by-bar and applies configurable TP/SL/trailing/timer/BE
 * rules to determine exit point and outcome. All functions are pure — no side effects,
 * no React hooks. Called via useMemo in the simulator panel for real-time updates.
 *
 * P&L is computed from raw OHLCV + start_price + direction (not from pre-computed
 * columns which may be null for older zones).
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { parseRawTimestamp } from "./format";
import { lookupTickSpec } from "./futures";
import {
  resolveRulesForTrade,
  evaluate as evaluateExpr,
  NUMERIC_RULE_KEYS,
  type EntryEvalCtx,
  type NumericValue as ScriptNumericValue,
  type Expr as ScriptExpr,
} from "./script-expr";
import type { FilterIfDirective, FilterIfStatement } from "./backtest-script";

// ─── Rule Configuration ──────────────────────────────────────────────────────
//
// ⚠️  NT8 PRESET SYNC — READ BEFORE ADDING / RENAMING / REMOVING FIELDS  ⚠️
//
// SimRules is the source of truth for the dashboard simulator AND for every
// preset JSON saved out of the dashboard. Those JSON files are ALSO read by
// the NinjaTrader 8 strategy at runtime via PresetLoader.cs. Any field added
// here that's not mirrored on the C# side will silently fall back to its
// default in NT8, producing a real divergence between the dashboard backtest
// and live/NT8 backtest results that's hard to spot.
//
// **When you add or change a field on this interface, you MUST also update:**
//
//   1. ninjatrader/AddOns/PresetSchema.cs
//      → add the matching property on the `Rules` class with a sensible
//        default. Use Pascal-case (e.g. `MyNewFlag`).
//
//   2. ninjatrader/AddOns/PresetLoader.cs
//      → add a `r.MyNewFlag = GetBool(d, "myNewFlag", r.MyNewFlag);` line
//        inside the rules-block parser. The JSON key is camelCase to match
//        what this file emits. Use GetInt / GetDouble / GetString as
//        appropriate.
//
//   3. ninjatrader/AddOns/PresetExecutor.cs
//      → if the field changes RUNTIME BEHAVIOR (signal gating, exit logic,
//        sizing, daily-limit handling, etc.), wire it into the executor's
//        OnBar / OnPositionFilled / OnPositionClosed code paths. If it's
//        purely a UI/display flag with no runtime effect, just leave it
//        deserialized — that's enough for round-trip parity.
//
//   4. (If the field is a knob exposed in the UI) make sure the dashboard's
//      simulator-controls.tsx renders an editor for it, so saved presets
//      capture the user's choice.
//
//   5. After making the C# changes, run `cd ninjatrader && ./deploy-nt8.sh`
//      so the .cs files land in the Parallels shared folder, then F5 in NT8
//      NinjaScript Editor to compile.
//
// Rule of thumb: if the dashboard reads it, the NT8 executor probably
// should too. Skipping any of steps 1-3 means a preset that "works" in the
// dashboard but silently breaks parity in NT8 — exactly what we just spent
// a long parity-debugging arc fixing.
//
// The diff tool at `scripts/diff-backtests.mjs` will catch resulting
// divergence after the fact, but adding the C# side at the same time as the
// TS side is much cheaper than discovering a $5k gap later.

export interface SimRules {
  stopLossEnabled: boolean;
  stopLossPoints: number;
  takeProfitEnabled: boolean;
  takeProfitPoints: number;
  trailingStopEnabled: boolean;
  trailingStopPoints: number; // Distance behind the peak
  timedExitEnabled: boolean;
  timedExitBars: number;
  breakEvenEnabled: boolean;
  breakEvenTrigger: number; // Move SL to entry after this many points of profit
  exitAtBarClose: boolean; // true = exit at candle close, false = exit at exact trigger level
  // Post-zone bar extension — append N bars from replay_bars after the zone's
  // end_time so the simulator can answer "what if I held this trade longer?".
  // Extension bars are pulled from the matching replay_session and merged into
  // the zone's bar list at the SimulatorPanel level. The core walk below is
  // unchanged — extension bars look like normal bars with bar_index continuing
  // monotonically and analytics columns left null (the walk only uses OHLC).
  extensionBarsEnabled: boolean;
  extensionBars: number;
  // ── Per-rule additive ATR adjustments ──────────────────────────────
  // Each rule's effective threshold is: basePoints + atrAdjust × zoneATR(14).
  // adjust = 0  → identical to fixed-points behavior (the safe default)
  // adjust > 0  → wider in high-vol regimes (e.g. SL=10 + 0.5×ATR=8 → SL=14)
  // adjust < 0  → tighter in high-vol regimes
  // Zones with no computed ATR (no replay match) fall back to base only.
  // The "Optimize ATR Adjust" button grid-searches these while keeping the
  // base point values frozen — letting you test "given my proven SL/TP, can
  // I improve EV by tweaking them per-zone based on volatility?".
  slAtrAdjust: number;
  tpAtrAdjust: number;
  trailAtrAdjust: number;
  beAtrAdjust: number;
  // Cross-zone overlap handling — see PositionMode docs above. Default keeps
  // each zone simulated in isolation (current behavior).
  positionMode: PositionMode;
  // ── Scaling Modifier (anti-martingale / pyramiding) ─────────────────
  // Walks position size across trades chronologically: after a winner add
  // scalingWinStep contracts, after a loser subtract scalingLossStep. The
  // running size is clamped to [scalingMinSize, scalingMaxSize]. By default
  // it never resets — a long winning streak can compound up to the max, and
  // a losing streak can drift down to the min — so the walk is continuous
  // across days. With scalingResetDaily on, the running size snaps back to
  // scalingStartSize at every calendar-day boundary so each session starts
  // fresh. Applied as a post-pass after applyPositionMode, so cross-zone
  // overlap handling is untouched. When disabled, every trade uses size = 1
  // and scaledPoints === exitPoints.
  scalingEnabled: boolean;
  scalingStartSize: number;
  scalingWinStep: number;
  scalingLossStep: number;
  scalingMinSize: number;
  scalingMaxSize: number;
  // When true, the running size resets back to scalingStartSize at the
  // boundary between calendar days (same dayKey logic the daily TP/SL
  // pass uses). Lets users model "every session starts fresh" rather
  // than a streak that compounds across days. Off by default —
  // preserves the legacy continuous-walk behavior.
  scalingResetDaily: boolean;
  // ── Daily TP / SL ────────────────────────────────────────────────────
  // Cross-trade kill switches that "stop trading for the day" once
  // realized cumulative scaledPoints crosses a threshold. Applied as a
  // final post-pass after scaling so the running P&L it watches reflects
  // exactly what shows up in the equity curve. Drops any candidate trade
  // whose startTime falls AFTER the moment a per-day cumulative crossed
  // a limit; the trade that crosses it is itself kept (its outcome is
  // what tripped the wire). When both are off, the post-pass is a no-op.
  // Points values are absolute — dailyStopLossPoints stored as a
  // positive number, treated as a -X threshold internally.
  dailyStopLossEnabled: boolean;
  dailyStopLossPoints: number;
  dailyTakeProfitEnabled: boolean;
  dailyTakeProfitPoints: number;
  // When true, trades that are still IN FLIGHT at the moment a daily
  // limit is hit get force-closed at that bar (exit reason "daily")
  // instead of being allowed to run to their natural exit. Off by
  // default — preserves the lazy "stop entering new trades" behavior.
  // The exit price is the close of the in-flight trade's bar at (or
  // just past) the trigger trade's exit time, computed via the same
  // earlyCloseAtTime helper that "Close Previous" position-mode uses.
  dailyLimitExactMode: boolean;
  // ── Daily trade-count caps ──────────────────────────────────────────
  // Hard caps on the NUMBER of trades per calendar day. Independent of
  // the P&L-based daily kill switches above so users can run "stop after
  // 3 wins / 3 losses regardless of points" rules. Both apply BEFORE the
  // P&L kill switches: once the count threshold is hit on a day, every
  // remaining same-day entry is dropped, exactly like the lazy mode of
  // dailyStopLoss/TP. Defaults OFF so existing presets are unchanged.
  maxTradesPerDayEnabled: boolean;
  maxTradesPerDay: number;
  maxLossesPerDayEnabled: boolean;
  maxLossesPerDay: number;
  // ── Cooldown between trades ─────────────────────────────────────────
  // After a trade closes, drop any new entry whose startTime falls
  // within `cooldownBarsBetweenTrades` bars of the previous trade's
  // exitTime (measured by the difference in the synthetic-zone bar
  // index, which is 1-bar-per-bar for the backtest data). Caps clearly
  // related "revenge"/over-trading. Bars counted by minute-difference of
  // timestamps so the gate works without needing the bar map plumbed
  // through. Defaults OFF.
  cooldownBetweenTradesEnabled: boolean;
  cooldownBetweenTradesBars: number;
  // ── Fill convention ─────────────────────────────────────────────────
  // Where the entry actually fills:
  //   "close"     — fill at the trigger bar's CLOSE (legacy behavior;
  //                 assumes a "be in-position by close" market order
  //                 that gets the closing print).
  //   "next_open" — fill at the FOLLOWING bar's OPEN (matches NinjaTrader
  //                 with Calculate.OnBarClose: the strategy decides on bar
  //                 close, the order fires, and the next available print
  //                 is the next bar's open). This is the realistic live
  //                 behavior, so it's the default for new presets.
  // Existing presets pre-dating this field will inherit the default via
  // normalizePresetForLoad, which deep-merges DEFAULT_SIM_RULES first.
  fillMode: "close" | "next_open";
  // ── Slippage (per side, in price points) ────────────────────────────
  // Subtracted from each round-trip's exitPoints (entry costs +slip,
  // exit costs +slip → net P&L drops by 2 × slippagePoints). Models the
  // fact that real fills are rarely at the exact trigger price.
  // Set to 0 to disable. Default 0 so existing presets are unchanged.
  slippagePoints: number;
  // ── Commission (per round-trip, in dollars) ─────────────────────────
  // Flat $ cost added per closed trade. Reported in SimZoneResult and
  // summarized in $ totals. Use pointValue below to convert per-trade
  // points to dollars when computing net $ P&L.
  commissionPerRoundTrip: number;
  // ── Point value (dollars per 1.0 price point per contract) ──────────
  // 20 for NQ / E-mini Nasdaq. 2 for MNQ / Micro Nasdaq. 50 for ES.
  // 5 for MES. 1000 for CL. 100 for GC. Used only when
  // commissionPerRoundTrip > 0 (so $ totals can be computed). Defaults
  // to 20 (NQ) since that's the dashboard's primary instrument.
  pointValue: number;
  // ── Tick / point config mode ───────────────────────────────────────
  // "auto" (default) → lookupTickSpec(zone.instrument) supplies
  // ticksPerPoint / tickValue / pointValue from the per-instrument
  // table in futures.ts. The rules.ticks* fields below are IGNORED in
  // auto mode (only kept around as a fallback for unrecognized
  // instruments).
  // "manual" → use the rules.ticks* / rules.pointValue fields below
  // verbatim, no per-instrument lookup. For non-standard contracts or
  // intentional overrides.
  // The dashboard's "Fills & Costs" panel surfaces the auto-detected
  // values read-only when in auto mode; flipping to manual makes them
  // editable.
  tickConfigMode: "auto" | "manual";
  // ── Ticks per price point (Script v3 tick helper) ──────────────────
  // How many minimum-price-increments fit in 1.0 price point. NQ = 4
  // (ticks are 0.25 points). ES = 4. CL = 100 (0.01 ticks). Used by the
  // `ticks(n)` script helper to translate tick counts into point
  // distances inside Optimize bounds and rule expressions —
  // `Optimize.X.Y(30, ticks(4), 40)` resolves the min bound to
  // `n / ticksPerPoint` price points at evaluation time. ONLY consulted
  // in manual mode (see tickConfigMode above).
  ticksPerPoint: number;
  // ── Dollar value per tick ──────────────────────────────────────────
  // Equivalent to `pointValue / ticksPerPoint` for standard contracts.
  // ONLY consulted in manual mode.
  tickValue: number;
}

export const DEFAULT_SIM_RULES: SimRules = {
  stopLossEnabled: true,
  stopLossPoints: 10,
  takeProfitEnabled: true,
  takeProfitPoints: 20,
  trailingStopEnabled: false,
  trailingStopPoints: 8,
  timedExitEnabled: false,
  timedExitBars: 20,
  breakEvenEnabled: false,
  breakEvenTrigger: 5,
  exitAtBarClose: true,
  extensionBarsEnabled: false,
  extensionBars: 20,
  // All ATR adjustments default to 0 → identical to fixed-points behavior
  slAtrAdjust: 0,
  tpAtrAdjust: 0,
  trailAtrAdjust: 0,
  beAtrAdjust: 0,
  positionMode: "default",
  // Scaling disabled by default so existing behavior is unchanged.
  scalingEnabled: false,
  scalingStartSize: 1,
  scalingWinStep: 1,
  scalingLossStep: 1,
  scalingMinSize: 1,
  scalingMaxSize: 5,
  scalingResetDaily: false,
  // Daily kill switches default OFF so legacy behavior is unchanged. The
  // 50/50 starting points are a reasonable mid-point for the typical NQ
  // backtest where individual trades clear a few points each.
  dailyStopLossEnabled: false,
  dailyStopLossPoints: 50,
  dailyTakeProfitEnabled: false,
  dailyTakeProfitPoints: 50,
  dailyLimitExactMode: false,
  // Daily trade-count caps default OFF so legacy behavior is unchanged.
  // 5/3 are reasonable starting points: half a typical session-trading
  // budget on the trade cap, "two strikes" on the loss cap.
  maxTradesPerDayEnabled: false,
  maxTradesPerDay: 5,
  maxLossesPerDayEnabled: false,
  maxLossesPerDay: 3,
  cooldownBetweenTradesEnabled: false,
  cooldownBetweenTradesBars: 5,
  // Fill at next bar's open by default — matches NinjaTrader's
  // Calculate.OnBarClose live behavior. Old presets get this via the
  // forward-compat deep-merge in normalizePresetForLoad, which will
  // shift their backtest entry prices by ~one bar's gap. That's
  // intentional: backtests should reflect realistic fills, and users
  // who want to reproduce a historical close-fill report can flip it
  // back per preset.
  fillMode: "next_open",
  // Costs default to zero so existing backtests are unchanged unless
  // the user opts in. NQ point value is the most common default; users
  // override per preset for other instruments.
  slippagePoints: 0,
  commissionPerRoundTrip: 0,
  pointValue: 20,
  // Auto-resolve tick / point config from the zone's instrument symbol
  // by default. The rules.ticksPerPoint / tickValue / pointValue values
  // below are only consulted when tickConfigMode is "manual" OR when
  // the instrument isn't in INSTRUMENT_TICK_SPECS (e.g. an unrecognized
  // symbol or a custom contract).
  tickConfigMode: "auto",
  // NQ defaults — used as the fallback when auto-resolution misses.
  // ticksPerPoint × tickValue = 4 × 5 = 20 = pointValue (consistent).
  ticksPerPoint: 4,
  tickValue: 5,
};

// ─── Tick / point config resolver ───────────────────────────────────────────
//
// Single source of truth for "what tick config applies to this trade".
// Always go through this rather than reading rules.ticksPerPoint etc.
// directly, otherwise auto-resolution from instrument symbol gets
// silently bypassed.
//
// Resolution order:
//   1. tickConfigMode === "manual" → use rules.* verbatim. Lets the
//      user force a specific config for non-standard contracts.
//   2. lookupTickSpec(instrument) returns a spec → use it. The "auto"
//      path; covers every symbol in INSTRUMENT_TICK_SPECS (futures.ts).
//   3. Lookup misses (unrecognized symbol) → fall back to rules.* as
//      a soft default. Same effect as legacy behavior, so a brand-new
//      instrument the dashboard doesn't recognize keeps working.
export interface ResolvedTickConfig {
  ticksPerPoint: number;
  tickValue: number;
  pointValue: number;
  /** Where the values came from — exposed so the UI can label things
   *  (e.g. "Auto: NQ → 4 ticks/pt") and so tests can assert behavior. */
  source: "manual" | "auto" | "fallback";
}

export function resolveTickConfig(
  instrument: string | null | undefined,
  rules: Pick<SimRules, "tickConfigMode" | "ticksPerPoint" | "tickValue" | "pointValue">
): ResolvedTickConfig {
  if (rules.tickConfigMode === "manual") {
    return {
      ticksPerPoint: rules.ticksPerPoint,
      tickValue: rules.tickValue,
      pointValue: rules.pointValue,
      source: "manual",
    };
  }
  const auto = instrument ? lookupTickSpec(instrument) : null;
  if (auto) {
    return {
      ticksPerPoint: auto.ticksPerPoint,
      tickValue: auto.tickValue,
      pointValue: auto.pointValue,
      source: "auto",
    };
  }
  return {
    ticksPerPoint: rules.ticksPerPoint,
    tickValue: rules.tickValue,
    pointValue: rules.pointValue,
    source: "fallback",
  };
}

// ─── Result Types ────────────────────────────────────────────────────────────

export type ExitReason = "tp" | "sl" | "trail" | "be" | "timer" | "end" | "next" | "daily";

/**
 * How the simulator should handle the case where a new zone opens while a
 * previous zone is still in its trade. Applied as a post-processing step
 * after the per-zone bar walk, so it doesn't affect the core engine.
 *
 *  default        — current behavior; every zone simulated independently.
 *  close-previous — any new zone closes ALL currently-open positions at the
 *                   new zone's start time, then opens the new one.
 *  add-close      — only OPPOSING open positions are closed; same-direction
 *                   ones keep running independently alongside the new one.
 *  null           — if any position is still open, the new zone is dropped.
 *  add-null       — if any opposing position is open, the new zone is dropped;
 *                   otherwise it opens normally (stacks with same-direction).
 *  reverse-null   — opposing signal flips the side: close opposing open
 *                   positions and open the new one. Same-direction signals
 *                   are dropped (keep current position). Reverse entries
 *                   reset the scaling walk back to scalingStartSize.
 *  reverse-add    — opposing signal flips the side (close opposing, open new
 *                   with size reset). Same-direction signals stack normally.
 */
export type PositionMode =
  | "default"
  | "close-previous"
  | "add-close"
  | "null"
  | "add-null"
  | "reverse-null"
  | "reverse-add";

export interface SimZoneResult {
  zoneId: number;
  direction: string;
  originalPoints: number; // Zone's actual points_move
  exitPoints: number; // Simulated P&L at exit, per-contract (raw points)
  exitReason: ExitReason;
  exitBarIndex: number;
  exitTime: string; // Bar_time of the exit bar — used for cross-zone overlap checks
  barsHeld: number;
  peakMfe: number; // Best P&L reached before exit
  maxDrawdown: number; // Worst P&L reached before exit (negative)
  instrument: string;
  startTime: string;
  // ── Scaling Modifier outputs ───────────────────────────────────────
  // Assigned by the post-pass in simulateAllZones. When scaling is off,
  // positionSize is 1 and scaledPoints === exitPoints. When on, positionSize
  // reflects the additive walk (+win / −loss step, clamped min/max) and
  // scaledPoints = exitPoints × positionSize.
  positionSize: number;
  scaledPoints: number;
  // ── Costs (computed in simulateZone from SimRules) ─────────────────
  // Round-trip slippage already subtracted from exitPoints (so exitPoints
  // is the *net-of-slippage* P&L per contract). slippageApplied is the
  // total points subtracted (= 2 × slippagePoints when enabled). Surfaced
  // separately so the UI can attribute the hit if desired.
  slippageApplied: number;
  // Commission charged for this round-trip in dollars (= rules.commissionPerRoundTrip).
  // Tracked per trade so summaries can multiply by qty if scaling is on.
  commissionDollars: number;
  // Net P&L in dollars: scaledPoints × pointValue − commissionDollars × qty.
  // Filled in by applyScalingModifier so the value reflects the final size.
  // Independent of scaledPoints so callers wanting raw points still have it.
  netDollars: number;
  // ── Script v2: per-trade prints ────────────────────────────────────
  // When the user writes one or more `ontrade.print = expr [, "label"]`
  // directives in the script, each expression is evaluated at this
  // trade's entry bar and the resulting numeric values land here keyed
  // by label. NaN values are kept (so the trade table can render "—" for
  // a warmup miss instead of dropping the row). Absent when no
  // ontrade.print directives are active OR when the simulator is called
  // without a scriptOverlay.
  script_prints?: Record<string, number>;
  // ── Effective rule thresholds at this trade's entry ────────────────
  // The actual SL/TP/Trail/BE point distances simulateZone used for THIS
  // trade — already resolved (base + slAtrAdjust × ATR), and reflecting
  // any per-trade `rules.*` overrides from a script overlay or the online
  // optimizer. Stored on the result so chart overlays (computeTrailPath)
  // can render lines at the same prices the simulator actually checked,
  // even when the global `rules` object would resolve to different values.
  // Always populated by simulateZone — undefined only on legacy SimZoneResult
  // objects that were built before this field existed.
  effSlPoints?: number;
  effTpPoints?: number;
  effTrailPoints?: number;
  effBePoints?: number;
  // ── Online-optimizer warmup tag ────────────────────────────────────
  // True when this trade was emitted before the optimizer's lookback
  // window filled (i.e. fired with the script's literal/default rules
  // rather than optimizer-resolved values). Set only by
  // `runOnlineOptimizedBacktest`; absent on trades produced by the
  // flat simulator path. Lets the dashboard label warmup trades
  // visually AND lets the `Warmup = false` script flag exclude them
  // from the final trade list.
  isWarmup?: boolean;
  // ── Reverse-entry tag (positionMode reverse-* modes) ──────────────
  // True when applyPositionMode opened this trade as a side-flip against
  // an opposing position. The scaling walk uses this to snap size back to
  // scalingStartSize at the reverse, matching the user's mental model
  // ("on a reversal, sizing starts over").
  isReverseEntry?: boolean;
}

export interface SimSummary {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  avgPoints: number;
  totalPoints: number;
  expectancy: number; // (winRate * avgWin) - (lossRate * avgLoss), scaled
  // Per-size EV: the same expectancy formula but computed on the RAW
  // per-contract exitPoints instead of the size-scaled scaledPoints. A trade
  // done at 4× size contributes 1/4 as much to this metric as it does to the
  // regular expectancy, so this number reflects the strategy's underlying EV
  // per one contract — independent of the scaling modifier's sizing. When
  // scaling is disabled, expectancyPerSize === expectancy.
  expectancyPerSize: number;
  avgWinPoints: number;
  avgLossPoints: number;
  profitFactor: number;
  avgBarsHeld: number;
  bestTrade: number;
  worstTrade: number;
  byExitReason: Record<string, number>;
  // Average points per trading day — totalPoints divided by the number of
  // unique calendar dates that produced at least one trade. Useful for sizing
  // expectations against a daily P&L target rather than per-trade EV. Days
  // with zero trades aren't in the denominator (we only count days we actually
  // traded), so this is "average earnings on a day we trade", not "average
  // earnings across all calendar days in the period".
  dailyEv: number;
  tradingDays: number;
  // Average trades per hour during active sessions. Computed as
  // totalTrades / sum-per-day(lastExitTime − firstStartTime). Only counts
  // hours within a day's actual trading window — overnight gaps and
  // no-trade days are excluded — so it answers "while I'm in the seat,
  // how often does this strategy fire?".
  avgTradesPerHour: number;
  // Per-trade Sharpe ratio = mean(returns) / sample-stdev(returns), risk-free
  // rate assumed 0. Computed independently on two return series so we can
  // compare the strategy's risk-adjusted quality before vs after the rule set:
  //   sharpeOriginal  — uses each zone's original points_move (the unmodified
  //                     outcome that would have occurred with no sim rules).
  //   sharpeSimulated — uses scaledPoints (the sim-rule exit P&L, including
  //                     any scaling modifier). When scaling is disabled this
  //                     is equivalent to the per-contract simulated outcome.
  // Returns 0 when there are fewer than 2 trades or the series has zero
  // variance (can't divide by 0). This is a per-trade Sharpe, not annualized —
  // the number is directly comparable across the two series because both use
  // the same trade count and sampling basis.
  sharpeOriginal: number;
  sharpeSimulated: number;
  /** Maximum peak-to-trough drawdown (in points) on the cumulative
   *  scaledPoints curve, in chronological start-time order. Stored as a
   *  POSITIVE number representing the worst loss from a running high.
   *  Zero when no losing run occurred. Powers the `MinDrawdown`
   *  optimization objective — the optimizer maximizes -maxDrawdown so
   *  smaller drawdowns score higher. */
  maxDrawdown: number;
  /** Sum of all winning trades' scaledPoints (positive number). */
  grossProfit: number;
  /** Sum of all losing trades' scaledPoints, expressed as a positive
   *  magnitude (the amount lost). */
  grossLoss: number;
  /** Total commissions paid across all trades, in dollars.
   *  Computed as Σ commissionDollars × positionSize. */
  totalCommissions: number;
  /** Longest streak of consecutive winning trades (chronological order). */
  maxConsecutiveWinners: number;
  /** Longest streak of consecutive losing trades (chronological order). */
  maxConsecutiveLosers: number;
  /** Extrapolated EV per month — dailyEv × 21 (typical trading days
   *  per month). Useful for sizing expectations against monthly P&L
   *  goals when the backtest spans only a partial month. */
  monthlyEv: number;
  // ── Dollar-denominated parallels ────────────────────────────────────
  // Same metric definitions as their points counterparts above, but
  // computed from each trade's `netDollars` (which already bakes in the
  // per-instrument pointValue and per-trade commissions). Used by the
  // dashboard's points/dollars toggle so the UI can swap displayed values
  // without re-running the simulator. Multi-instrument sessions are
  // handled correctly because pointValue is resolved per trade.
  totalDollars: number;
  avgDollars: number;
  expectancyDollars: number;
  avgWinDollars: number;
  avgLossDollars: number;
  bestTradeDollars: number;
  worstTradeDollars: number;
  grossProfitDollars: number;
  grossLossDollars: number;
  dailyEvDollars: number;
  monthlyEvDollars: number;
  maxDrawdownDollars: number;
  profitFactorDollars: number;
  // ── Instrument metadata ────────────────────────────────────────────
  // The dominant (most-traded) instrument across `results`, plus the
  // tick-config values that apply to it. Resolved through the same
  // `resolveTickConfig` path the simulator itself uses, so a manual
  // override from the "Fills & Costs" panel surfaces here verbatim and
  // an auto-detected symbol surfaces the canonical CME spec from
  // futures.ts. All three are undefined when `results` is empty (no
  // dominant trade to anchor on). Multi-instrument sessions report only
  // the most-frequent symbol — these stat cards are a single-row summary,
  // not a per-instrument breakdown.
  primaryInstrument?: string;
  pointValue?: number;
  ticksPerPoint?: number;
}

// ─── Core Bar-Walk Engine ────────────────────────────────────────────────────

/**
 * Simulates a single zone bar-by-bar with the given rules.
 * Computes P&L from raw OHLCV to handle null pre-computed columns.
 *
 * @param zoneAtr - Optional ATR(14) value at entry for this zone. When
 *   rules.atrModeEnabled is true, all point-based rule fields are multiplied
 *   by this ATR before being applied. If null/undefined and ATR mode is on,
 *   the rule values fall back to their raw point values for that zone.
 */
export function simulateZone(
  zone: TradeZone,
  bars: TradeZoneBar[],
  rules: SimRules,
  zoneAtr?: number | null
): SimZoneResult | null {
  if (bars.length === 0) return null;

  // ─── Resolve effective rule values (base + ATR adjustment) ─────────
  // Each effective threshold is: basePoints + atrAdjust × zoneATR.
  // When the zone has no ATR (atr unknown), only the base is used. When the
  // adjustment is 0 (default), the rule is identical to fixed points — so this
  // stays a no-op for users who don't want ATR scaling at all.
  // We resolve these once here so the hot loop below stays numeric & unchanged.
  // Math.max keeps SL/TP/Trail strictly positive; a wildly negative adjustment
  // can't flip the threshold to the wrong side of entry and break the simulation.
  const atr = zoneAtr != null && zoneAtr > 0 ? zoneAtr : 0;
  const effSl = Math.max(0, rules.stopLossPoints + rules.slAtrAdjust * atr);
  const effTp = Math.max(0, rules.takeProfitPoints + rules.tpAtrAdjust * atr);
  const effTrail = Math.max(0, rules.trailingStopPoints + rules.trailAtrAdjust * atr);
  const effBe = Math.max(0, rules.breakEvenTrigger + rules.beAtrAdjust * atr);

  const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);
  const isLong = zone.direction === "Long";

  // ── Resolve entry price per fillMode ───────────────────────────────
  // "close"     → fill at the trigger bar's close (what zone.start_price
  //               already records). Legacy behavior; used to be the only
  //               option.
  // "next_open" → fill at the FOLLOWING bar's open. Mirrors NinjaTrader
  //               with Calculate.OnBarClose: the strategy fires on bar 0
  //               close, the order goes to market, and the next available
  //               print is bar 1's open. When bar 1 is missing (rare —
  //               usually means the zone has only the entry bar), fall
  //               back to start_price so the simulator doesn't crash.
  const fillMode = rules.fillMode || "next_open";
  const bar1 = sorted.find((b) => b.bar_index === 1);
  const entryPrice =
    fillMode === "next_open" && bar1
      ? bar1.bar_open
      : zone.start_price;

  // ── Slippage (per-side, in points) ─────────────────────────────────
  // Subtracted from each round-trip's exitPoints. The full round-trip
  // hit is 2 × slippagePoints (one per side). We track the round-trip
  // cost so it can be reported separately on SimZoneResult.
  const slipPerSide = Math.max(0, rules.slippagePoints || 0);
  const slipRoundTrip = slipPerSide * 2;

  let runningPeak = 0; // Best favorable P&L so far
  let runningDrawdown = 0; // Worst adverse P&L so far
  let beActivated = false;

  for (const bar of sorted) {
    // Compute direction-aware P&L from raw OHLCV
    // highPnl = best favorable price this bar, lowPnl = worst adverse price this bar
    const highPnl = isLong
      ? bar.bar_high - entryPrice
      : entryPrice - bar.bar_low;
    const lowPnl = isLong
      ? bar.bar_low - entryPrice
      : entryPrice - bar.bar_high;
    const closePnl = isLong
      ? bar.bar_close - entryPrice
      : entryPrice - bar.bar_close;
    const openPnl = isLong
      ? bar.bar_open - entryPrice
      : entryPrice - bar.bar_open;

    // Skip the entry bar (bar_index 0) for exit checks and peak tracking.
    // Entry happens at bar 0's CLOSE, so its high/low include price action
    // before entry and must not inflate runningPeak or trigger exits.
    if (bar.bar_index === 0) continue;

    // exitAtBarClose: true = close at candle close, false = close at exact trigger level
    const atClose = rules.exitAtBarClose;

    // ── OHLC Path Heuristic ──
    // Standard backtesting approach: infer intra-bar price path from the bar type.
    // Bullish bar (close >= open): assume O → L → H → C  (dipped first, then rallied)
    //   → check adverse exits (SL) first, then favorable (TP)
    // Bearish bar (close < open):  assume O → H → L → C  (rallied first, then dipped)
    //   → check favorable exits (TP/trail peak) first, then adverse (SL)
    const isBullishBar = bar.bar_close >= bar.bar_open;

    // In exact mode, if price gaps past the stop/TP level (the bar opens beyond it),
    // the fill is at the bar's open, not the trigger level. This helper picks the
    // correct exact-mode exit P&L: the trigger level if achievable, else the open.
    // For adverse exits (SL/trail/BE): if openPnl already past trigger → fill at openPnl
    // For favorable exits (TP): if openPnl already past trigger → fill at openPnl
    const exactAdverse = (triggerPnl: number) =>
      openPnl <= triggerPnl ? openPnl : triggerPnl;
    const exactFavorable = (triggerPnl: number) =>
      openPnl >= triggerPnl ? openPnl : triggerPnl;

    // Helper closures for adverse and favorable exit checks
    const checkAdverse = (): SimZoneResult | null => {
      // Stop Loss — uses effSl (ATR-scaled when atrMode is on, raw points otherwise)
      if (rules.stopLossEnabled && lowPnl <= -effSl) {
        const exitPnl = atClose ? closePnl : exactAdverse(-effSl);
        return result(zone, bar, exitPnl, "sl", runningPeak, runningDrawdown, sorted, slipRoundTrip, rules, effSl, effTp, effTrail, effBe);
      }
      // Break Even SL (only after activation)
      if (rules.breakEvenEnabled && beActivated && lowPnl <= 0) {
        const exitPnl = atClose ? closePnl : exactAdverse(0);
        return result(zone, bar, exitPnl, "be", runningPeak, runningDrawdown, sorted, slipRoundTrip, rules, effSl, effTp, effTrail, effBe);
      }
      // Trailing Stop — acts as a SL from bar 1, trailing upward as profit grows.
      // Trail level starts at -effTrail (like a fixed SL) and rises with peak.
      if (rules.trailingStopEnabled) {
        const trailLevel = runningPeak - effTrail;
        if (lowPnl <= trailLevel) {
          const exitPnl = atClose ? closePnl : exactAdverse(trailLevel);
          return result(zone, bar, exitPnl, "trail", runningPeak, runningDrawdown, sorted, slipRoundTrip, rules, effSl, effTp, effTrail, effBe);
        }
      }
      return null;
    };

    const checkFavorable = (): SimZoneResult | null => {
      // Update peak BEFORE checking TP (the high happens before the close on this path)
      if (highPnl > runningPeak) runningPeak = highPnl;
      // Take Profit — uses effTp (ATR-scaled when atrMode is on, raw points otherwise)
      if (rules.takeProfitEnabled && highPnl >= effTp) {
        const exitPnl = atClose ? closePnl : exactFavorable(effTp);
        return result(zone, bar, exitPnl, "tp", runningPeak, runningDrawdown, sorted, slipRoundTrip, rules, effSl, effTp, effTrail, effBe);
      }
      // Update BE activation when favorable move crosses the BE trigger
      if (rules.breakEvenEnabled && highPnl >= effBe) {
        beActivated = true;
      }
      return null;
    };

    // Check exits in path-order based on bar type
    let exitResult: SimZoneResult | null = null;
    if (isBullishBar) {
      // Bullish: O → L → H → C — adverse first, then favorable
      // Update drawdown from low (happens first)
      if (lowPnl < runningDrawdown) runningDrawdown = lowPnl;
      exitResult = checkAdverse();
      if (!exitResult) exitResult = checkFavorable();
    } else {
      // Bearish: O → H → L → C — favorable first, then adverse
      exitResult = checkFavorable();
      if (!exitResult) {
        // Update drawdown from low (happens second)
        if (lowPnl < runningDrawdown) runningDrawdown = lowPnl;
        exitResult = checkAdverse();
      }
    }

    if (exitResult) return exitResult;

    // ── Timed Exit ── (always at close regardless of bar type)
    if (rules.timedExitEnabled && bar.bar_index >= rules.timedExitBars - 1) {
      return result(zone, bar, closePnl, "timer", runningPeak, runningDrawdown, sorted, slipRoundTrip, rules, effSl, effTp, effTrail, effBe);
    }
  }

  // No exit triggered — use the zone's original points_move so that
  // simulated results match the original exactly when all rules are OFF.
  // We still subtract slippage so the report is fair vs runs that did
  // hit an exit; slippage is a function of taking the round-trip, not
  // of which exit triggered.
  const lastBar = sorted[sorted.length - 1];
  return result(zone, lastBar, zone.points_move, "end", runningPeak, runningDrawdown, sorted, slipRoundTrip, rules, effSl, effTp, effTrail, effBe);
}

/**
 * Build a SimZoneResult. Subtracts round-trip slippage from the raw
 * points so callers always read net-of-slippage exitPoints. Captures
 * the slippage and commission inputs from rules so the per-trade
 * report carries the full cost breakdown for downstream summaries.
 */
function result(
  zone: TradeZone,
  exitBar: TradeZoneBar,
  points: number,
  reason: ExitReason,
  peakMfe: number,
  maxDd: number,
  _allBars: TradeZoneBar[],
  slipRoundTrip: number,
  rules: SimRules,
  // Effective point thresholds the simulator used for this trade — already
  // resolved (base + atrAdjust × ATR) and reflecting any per-trade rule
  // overrides from a script overlay or the online optimizer. Attached to
  // the SimZoneResult so chart overlays (computeTrailPath) draw SL/TP/Trail
  // /BE lines at the same prices the simulator actually checked, instead of
  // recomputing from a stale global `rules` object.
  effSl: number,
  effTp: number,
  effTrail: number,
  effBe: number
): SimZoneResult {
  // Slippage hits both sides — apply once at exit-write time so the rest
  // of the simulator (peak/drawdown tracking, exit checks) operates on
  // pre-slippage prices and we don't have to worry about slippage
  // breaking trigger-level math.
  const netPoints = Math.round((points - slipRoundTrip) * 100) / 100;
  return {
    zoneId: zone.id,
    direction: zone.direction,
    originalPoints: zone.points_move,
    exitPoints: netPoints, // net-of-slippage, rounded 2dp
    exitReason: reason,
    exitBarIndex: exitBar.bar_index,
    exitTime: exitBar.bar_time,
    barsHeld: exitBar.bar_index + 1,
    peakMfe: Math.round(peakMfe * 100) / 100,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    instrument: zone.instrument,
    startTime: zone.start_time,
    positionSize: 1,
    scaledPoints: netPoints,
    slippageApplied: slipRoundTrip,
    commissionDollars: Math.max(0, rules.commissionPerRoundTrip || 0),
    // Filled in by applyScalingModifier once positionSize is known.
    // Provisional value here uses size=1 so a result that bypasses
    // scaling still has a sensible $ figure.
    netDollars: Math.round(
      (netPoints * (rules.pointValue || 0) - Math.max(0, rules.commissionPerRoundTrip || 0)) * 100
    ) / 100,
    effSlPoints: effSl,
    effTpPoints: effTp,
    effTrailPoints: effTrail,
    effBePoints: effBe,
  };
}

// ─── Trail Path Computation ──────────────────────────────────────────────────

/**
 * Computes the per-bar trailing stop PRICE level for visualization.
 * Returns an array (one per bar up to exit bar) of the actual stop price.
 * Returns null for bars where the trail hasn't activated yet.
 * Also includes SL/TP price levels and the exit bar index for chart overlays.
 */
export interface TrailPathData {
  trailPrices: (number | null)[]; // Trailing stop price per bar (null = not yet active)
  slPrice: number | null; // Static SL price level
  tpPrice: number | null; // Static TP price level
  bePrice: number | null; // BE price (= entry) once activated
  bePrices: (number | null)[]; // Per-bar BE status (null = not active, entryPrice = active)
  exitBarIndex: number;
}

export function computeTrailPath(
  zone: TradeZone,
  bars: TradeZoneBar[],
  rules: SimRules,
  simResult: SimZoneResult,
  zoneAtr?: number | null
): TrailPathData {
  // Effective thresholds = the SAME point distances the simulator used to
  // build this trade's exit. simulateZone now stores them on SimZoneResult
  // (effSlPoints / effTpPoints / effTrailPoints / effBePoints) so that any
  // per-trade overrides from a script overlay or the online optimizer flow
  // through to the chart automatically — the SL/TP/Trail/BE overlay lines
  // match the simulator's actual exit checks even when the global `rules`
  // object would resolve to different values (e.g. base SL=0 with the real
  // distance coming from a per-trade `rules.stopLossPoints` override).
  //
  // Falls back to recomputing from `rules + atr` for legacy SimZoneResult
  // objects that predate these fields (possible when callers built results
  // outside simulateZone).
  const atr = zoneAtr != null && zoneAtr > 0 ? zoneAtr : 0;
  const effSl = simResult.effSlPoints ??
    Math.max(0, rules.stopLossPoints + rules.slAtrAdjust * atr);
  const effTp = simResult.effTpPoints ??
    Math.max(0, rules.takeProfitPoints + rules.tpAtrAdjust * atr);
  const effTrail = simResult.effTrailPoints ??
    Math.max(0, rules.trailingStopPoints + rules.trailAtrAdjust * atr);
  const effBe = simResult.effBePoints ??
    Math.max(0, rules.breakEvenTrigger + rules.beAtrAdjust * atr);

  const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);
  const isLong = zone.direction === "Long";

  // Mirror simulateZone's fillMode resolution so chart overlays anchor to
  // the same entry price the simulator used. Without this, the SL/TP/BE
  // lines would render off the trigger bar's close while the simulated
  // exits would be measured from the next bar's open — a subtle mismatch
  // that's most visible when the gap is large.
  const fillMode = rules.fillMode || "next_open";
  const bar1 = sorted.find((b) => b.bar_index === 1);
  const entryPrice =
    fillMode === "next_open" && bar1
      ? bar1.bar_open
      : zone.start_price;

  // Static SL/TP price levels (ATR-scaled when applicable)
  const slPrice = rules.stopLossEnabled
    ? (isLong ? entryPrice - effSl : entryPrice + effSl)
    : null;
  const tpPrice = rules.takeProfitEnabled
    ? (isLong ? entryPrice + effTp : entryPrice - effTp)
    : null;

  const trailPrices: (number | null)[] = [];
  const bePrices: (number | null)[] = [];
  let runningPeak = 0;
  let beActivated = false;

  for (const bar of sorted) {
    if (bar.bar_index > simResult.exitBarIndex) break;

    const highPnl = isLong ? bar.bar_high - entryPrice : entryPrice - bar.bar_low;

    if (highPnl > runningPeak) runningPeak = highPnl;

    // Trail price: active immediately, starts at -effTrail and trails up
    // (effTrail is ATR-scaled in ATR mode, raw points otherwise — see top of fn)
    if (rules.trailingStopEnabled) {
      const trailPnl = runningPeak - effTrail;
      // Convert P&L level back to price
      const trailPrice = isLong ? entryPrice + trailPnl : entryPrice - trailPnl;
      trailPrices.push(trailPrice);
    } else {
      trailPrices.push(null);
    }

    // BE activation tracking — uses effBe (base + atr adjust)
    if (rules.breakEvenEnabled && highPnl >= effBe) {
      beActivated = true;
    }
    bePrices.push(beActivated ? entryPrice : null);
  }

  return {
    trailPrices,
    slPrice,
    tpPrice,
    bePrice: rules.breakEvenEnabled ? entryPrice : null,
    bePrices,
    exitBarIndex: simResult.exitBarIndex,
  };
}

// ─── Batch Simulation ────────────────────────────────────────────────────────

/** Optional Script v2 overlay. When present, the simulator resolves
 *  per-trade rule expressions and per-trade `ontrade.print` directives
 *  at each zone's entry bar, falling back to literal `rules` values on
 *  any NaN result. When absent (the default for legacy callers), the
 *  function behaves byte-identically to v1 — no expressions, no prints,
 *  no warnings. The byte-identical guarantee is why we keep this opt-in
 *  rather than making it the only code path. */
export interface ScriptOverlay {
  /** Path → compiled expression. The simulator only honors entries whose
   *  path begins with "rules." and whose key is in NUMERIC_RULE_KEYS. */
  numericOverrides?: Record<string, ScriptNumericValue>;
  /** `ontrade.print` directives — evaluated at each entry bar and
   *  attached to the SimZoneResult as `script_prints`. */
  tradePrints?: Array<{ label: string; expr: ScriptExpr }>;
  /** `filter.if = ...` directives — evaluated at each entry bar.
   *  Multiple directives AND together: a "reject" verdict from any one
   *  drops the trade. Action statements in the taken branch can stack
   *  per-trade rule overrides on top of `numericOverrides` and emit
   *  conditional prints (merged into `script_prints`). When omitted or
   *  empty, the simulator behaves byte-identically to the
   *  pre-filter.if path. */
  filterIfs?: FilterIfDirective[];
  /** Pre-computed indicator series, keyed by (zone.id, indicator-key).
   *  Built once per run by `precomputeIndicators`, not per trade. Empty
   *  map means "no expressions need indicator data" — evaluator returns
   *  NaN for any indicator lookup, which the resolver then falls back
   *  on. */
  indicatorByZone?: Map<number, Map<string, number[]>>;
  /** Out-param: warnings collected during evaluation. Caller mutates an
   *  array it owns and inspects after the run. */
  warnings?: string[];
  /** Script v3: per-path Optimize directive specs. When present, the
   *  caller routes through `runOnlineOptimizedBacktest` instead of the
   *  flat simulateAllZones path so each new signal can re-optimize
   *  rules.* fields against the lookback window. v1 honors only
   *  rules.* numeric Optimize. Filters and params are rejected at
   *  parse time. */
  optimizeOverrides?: Record<string, import("./script-expr").OptimizeSpec>;
  /** Joint vs independent search across directives. Honored only when
   *  optimizeOverrides has at least one entry. */
  optimizeAll?: boolean;
  /** When false, trades emitted before the optimizer's lookback fills
   *  are EXCLUDED from the returned trade list. Default true (current
   *  behavior — include them). The optimizer still uses warmup trades
   *  internally for its lookback math regardless of this flag. */
  warmup?: boolean;
  /** Stable seed for the TPE RNG. Same seed + same inputs → identical
   *  optimization trace. Derived in the dashboard from a hash of the
   *  script text + selected sessions. */
  optimizeSeed?: number;
}

// ─── filter.if runtime ─────────────────────────────────────────────────────
//
// Walks a parsed FilterIfDirective at trade entry and returns either a
// verdict + a bag of side effects, or just a verdict for the simple
// gate case. Rule overrides accumulate into a flat path→number map that
// the caller layers on top of resolveRulesForTrade's output. Conditional
// prints accumulate into a label→number map merged into script_prints.
// Nested filter.if recurses with the same EntryEvalCtx — there's no
// scoping, since the language has no variables.
//
// Verdict resolution rules (matching the parser-side spec):
//   - Empty / undefined slot → default verdict (true → pass, false → reject)
//   - Non-empty slot:
//       * Side effects (assignments, prints, nested with their own
//         verdicts) accumulate as encountered.
//       * `pass` / `reject` halt the slot and lock that verdict.
//       * Slot finishes with no terminator → implicit PASS (the user
//         wrote actions but no explicit reject, which the spec defines
//         as "do these things and let the trade through").
//   - A nested filter.if's verdict bubbles up into the outer slot but
//     does NOT terminate the slot — subsequent statements still run
//     and can shadow it. Last verdict-producing statement in the slot
//     wins. (This matches "halt on explicit pass/reject; otherwise
//     keep walking" — nested verdicts are NOT explicit terminators
//     because their kind is "nested", not "verdict".)

interface FilterIfRuntimeResult {
  verdict: "pass" | "reject";
  /** path → resolved number; the caller stamps these onto SimRules
   *  AFTER `resolveRulesForTrade` so they win over any baseline
   *  numericOverrides for the same path. NaN values fall through and
   *  are skipped (warning emitted). */
  ruleOverrides: Map<string, number>;
  /** label → number; merged into the trade's `script_prints`. When a
   *  label collides with a top-level ontrade.print column, the filter
   *  print wins (it's the more specific signal). */
  prints: Map<string, number>;
}

/**
 * Optional metrics bag callers can pass to `simulateAllZones` /
 * `runOnlineOptimizedBacktest` to capture the funnel of "signals
 * generated → after each filter.if → final trades." Used by the
 * dashboard's per-run summary export so Claude Code (and other
 * terminal-side analysis tools) can diagnose why a script produced
 * fewer trades than expected.
 *
 * Shape rationale:
 *   - `filterRejections` is a Map<directiveIndex, count> rather than
 *     an array so callers don't have to pre-allocate one slot per
 *     directive. The caller knows the directive count from
 *     `scriptOverlay.filterIfs.length`; absent indices = zero rejections.
 *   - We attribute each signal's reject to the FIRST directive that
 *     voted reject. Subsequent rejecting directives in the same signal
 *     don't double-count — that matches "what would have been needed
 *     to let this signal through" semantics, which is what users want
 *     when iterating on filter conditions.
 *   - `zonesConsidered` is the input population (zones.length minus
 *     zones with empty bars) so the funnel always starts at the right
 *     numerator regardless of which path produced trades.
 */
export interface SimulateMetrics {
  /** Total signals/zones the simulator considered for THIS run.
   *  Set once, before any filter eval. */
  zonesConsidered: number;
  /** directive index → count of signals it rejected (first-reject-only).
   *  Empty when no `filter.if` directives are present. */
  filterRejections: Map<number, number>;
}

/** Allocate a fresh metrics object. Helper so callers don't have to
 *  remember the field shapes. */
export function emptySimulateMetrics(): SimulateMetrics {
  return { zonesConsidered: 0, filterRejections: new Map() };
}

function emptyRuntimeResult(verdict: "pass" | "reject"): FilterIfRuntimeResult {
  return { verdict, ruleOverrides: new Map(), prints: new Map() };
}

/** Run the statements in one branch slot. Returns the verdict (default
 *  passed in by the caller — true branch defaults to pass, false branch
 *  defaults to reject) plus accumulated side effects. Mutates the
 *  passed-in maps so a caller (the outer evaluator) can pre-seed
 *  overrides from the nested case. */
function runFilterIfSlot(
  statements: FilterIfStatement[],
  defaultVerdict: "pass" | "reject",
  slotDefined: boolean,
  ctx: EntryEvalCtx,
  ruleOverrides: Map<string, number>,
  prints: Map<string, number>,
  warnings: string[]
): "pass" | "reject" {
  // Empty/undefined slot → default verdict, no side effects.
  if (!slotDefined || statements.length === 0) return defaultVerdict;

  // Non-empty slot: implicit verdict is PASS (the spec says defining a
  // slot REPLACES the default; any actions without explicit reject
  // mean "do these things and let the trade through"). Loop walks the
  // statements; explicit pass/reject halts.
  let verdict: "pass" | "reject" = "pass";
  for (const stmt of statements) {
    switch (stmt.kind) {
      case "verdict":
        // Explicit terminator — set verdict and STOP. Anything after is
        // dead code; we silently skip it (the parser already accepted
        // it, and re-flagging here would double-warn).
        return stmt.verdict;
      case "assignment": {
        const v =
          stmt.value.kind === "literal"
            ? stmt.value.value
            : stmt.value.kind === "expr"
              ? evaluateExpr(stmt.value.expr, { kind: "entry", ...ctx })
              : NaN;
        if (Number.isFinite(v)) {
          ruleOverrides.set(stmt.path, v);
        } else {
          warnings.push(
            `${stmt.path}: filter.if assignment evaluated to NaN at zone ${ctx.zone.id} bar ${ctx.barIndex} — skipped (baseline value used).`
          );
        }
        break;
      }
      case "print": {
        const pv = evaluateExpr(stmt.directive.expr, { kind: "entry", ...ctx });
        prints.set(stmt.directive.label, pv);
        break;
      }
      case "nested": {
        // Nested filter.if produces its own verdict + side effects;
        // both flow into the outer accumulators. The verdict updates
        // the running verdict for THIS slot (so a nested reject on
        // the if_true branch can still flip the outer trade to
        // reject), but it doesn't halt the slot — explicit pass/
        // reject keywords are the only terminators.
        const sub = evaluateFilterIfDirective(stmt.directive, ctx, warnings);
        for (const [k, v] of sub.ruleOverrides) ruleOverrides.set(k, v);
        for (const [k, v] of sub.prints) prints.set(k, v);
        verdict = sub.verdict;
        break;
      }
    }
  }
  return verdict;
}

/** Evaluate one filter.if directive against an entry context. Public
 *  so the outer simulator loop can call it for each top-level
 *  directive in scriptOverlay.filterIfs. */
export function evaluateFilterIfDirective(
  d: FilterIfDirective,
  ctx: EntryEvalCtx,
  warnings: string[]
): FilterIfRuntimeResult {
  const condValue = evaluateExpr(d.cond, { kind: "entry", ...ctx });
  // NaN-as-fail: missing data routes to the if_false branch. Same
  // discipline as preset filters (warmup ⇒ drop). The user can opt
  // out by writing `cond || ATR == ATR` style guards.
  const branchTrue = Number.isFinite(condValue) && condValue !== 0;
  const ruleOverrides = new Map<string, number>();
  const prints = new Map<string, number>();
  const verdict = branchTrue
    ? runFilterIfSlot(d.ifTrue, "pass", d.ifTrueDefined, ctx, ruleOverrides, prints, warnings)
    : runFilterIfSlot(d.ifFalse, "reject", d.ifFalseDefined, ctx, ruleOverrides, prints, warnings);
  return { verdict, ruleOverrides, prints };
}

/** Run every top-level filter.if directive against the entry context
 *  and AND their verdicts. Side effects accumulate across all
 *  directives that PRODUCE a pass — once we know the trade is
 *  rejected, we still walk the rest so users see all warnings (the
 *  cost is tiny relative to the rest of the simulator). The final
 *  result tells the caller whether to keep the trade and what
 *  overrides/prints to layer on.
 *
 *  When `rejectionCountsOut` is provided, each signal that's rejected
 *  bumps the count for the FIRST directive that voted reject. Counting
 *  only the first-rejecter (instead of all rejecters) matches the
 *  user's mental model when tuning filters: "what would I need to
 *  loosen to let more signals through?" — the answer is the first
 *  filter to say no. Optional out-param so non-instrumented callers
 *  pay zero cost. */
function evaluateAllFilterIfs(
  directives: FilterIfDirective[],
  ctx: EntryEvalCtx,
  warnings: string[],
  rejectionCountsOut?: Map<number, number>
): FilterIfRuntimeResult {
  if (directives.length === 0) return emptyRuntimeResult("pass");
  const ruleOverrides = new Map<string, number>();
  const prints = new Map<string, number>();
  let verdict: "pass" | "reject" = "pass";
  let firstRejectIdx = -1;
  for (let i = 0; i < directives.length; i++) {
    const d = directives[i];
    const r = evaluateFilterIfDirective(d, ctx, warnings);
    for (const [k, v] of r.ruleOverrides) ruleOverrides.set(k, v);
    for (const [k, v] of r.prints) prints.set(k, v);
    if (r.verdict === "reject") {
      verdict = "reject";
      if (firstRejectIdx === -1) firstRejectIdx = i;
    }
  }
  if (firstRejectIdx >= 0 && rejectionCountsOut) {
    rejectionCountsOut.set(
      firstRejectIdx,
      (rejectionCountsOut.get(firstRejectIdx) ?? 0) + 1
    );
  }
  return { verdict, ruleOverrides, prints };
}

export function simulateAllZones(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atrByZoneId?: Map<number, number> | null,
  scriptOverlay?: ScriptOverlay | null,
  // Optional metrics out-param. Populated as the simulation walks; the
  // caller reads it after this function returns. See SimulateMetrics
  // for the field semantics. Out-param (rather than a new return type)
  // keeps the existing 60+ call sites of simulateAllZones untouched.
  metricsOut?: SimulateMetrics
): SimZoneResult[] {
  const results: SimZoneResult[] = [];
  // Seed the metrics population with the input zone count BEFORE we
  // start filtering. `zones.length` is the right denominator for the
  // funnel — it's the count of signals the strategy emitted that have
  // backing bars by the time we reach this loop.
  if (metricsOut) metricsOut.zonesConsidered = zones.length;
  for (const zone of zones) {
    const bars = barsByZoneId.get(zone.id);
    if (!bars || bars.length === 0) continue;
    const zoneAtr = atrByZoneId?.get(zone.id) ?? null;

    // Resolve per-trade rules + evaluate per-trade prints when an
    // overlay is active. Without an overlay, this is a no-op and the
    // call below is byte-identical to v1.
    let perTradeRules: SimRules = rules;
    let prints: Record<string, number> | undefined;
    if (
      scriptOverlay &&
      (scriptOverlay.numericOverrides ||
        scriptOverlay.tradePrints ||
        (scriptOverlay.filterIfs && scriptOverlay.filterIfs.length > 0))
    ) {
      // Entry bar = bar with bar_index 0 (the trigger bar). When the
      // run uses fillMode="next_open" this is still the bar we
      // snapshot indicators against — the user's mental model is "at
      // the moment the signal fires," which is bar 0's close.
      const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);
      const entryBar = sorted.find((b) => b.bar_index === 0) ?? sorted[0];
      const indicatorByKey =
        scriptOverlay.indicatorByZone?.get(zone.id) ?? new Map<string, number[]>();
      // Resolve tickConfig from instrument symbol (auto mode) or from
      // rules.* (manual mode). Built per-zone because different zones
      // can carry different instruments — the user might mix selected
      // sessions across symbols. resolveTickConfig() is the only entry
      // point; never read rules.ticksPerPoint directly here.
      const tickCfg = resolveTickConfig(zone.instrument, rules);
      const ctx: EntryEvalCtx = {
        bar: entryBar,
        barIndex: entryBar.bar_index,
        indicatorByKey,
        zone,
        tickConfig: {
          ticksPerPoint: tickCfg.ticksPerPoint,
          tickValue: tickCfg.tickValue,
          pointValue: tickCfg.pointValue,
        },
      };
      // Numeric overlay → resolve to concrete SimRules.
      if (scriptOverlay.numericOverrides) {
        const warnings = scriptOverlay.warnings ?? [];
        perTradeRules = resolveRulesForTrade(
          rules,
          scriptOverlay.numericOverrides,
          ctx,
          warnings
        );
      }
      // Per-trade prints → evaluate each, store under its label.
      if (scriptOverlay.tradePrints && scriptOverlay.tradePrints.length > 0) {
        prints = {};
        for (const p of scriptOverlay.tradePrints) {
          prints[p.label] = evaluateExpr(p.expr, { kind: "entry", ...ctx });
        }
      }
      // filter.if directives — evaluate AFTER numericOverrides resolution
      // so any rule overrides emitted by a taken branch can stack on
      // top of the baseline. A "reject" verdict drops the trade
      // entirely (skip simulateZone). On "pass", we layer the
      // directive's rule overrides onto perTradeRules and merge its
      // prints into the prints bag.
      if (scriptOverlay.filterIfs && scriptOverlay.filterIfs.length > 0) {
        const warnings = scriptOverlay.warnings ?? [];
        // Pass the metrics out-param's filterRejections map so the
        // helper can attribute first-reject counts per directive.
        // Undefined when no metrics requested → zero overhead.
        const fr = evaluateAllFilterIfs(
          scriptOverlay.filterIfs,
          ctx,
          warnings,
          metricsOut?.filterRejections
        );
        if (fr.verdict === "reject") {
          // Skip this zone entirely — same effect as a preset filter
          // dropping the synthetic zone in the dashboard memo.
          continue;
        }
        if (fr.ruleOverrides.size > 0) {
          // Stamp filter.if overrides onto a copy of perTradeRules.
          // Validate each path against NUMERIC_RULE_KEYS — the parser
          // already gated this, but the runtime double-checks so any
          // future serializer round-trip can't smuggle in an invalid
          // path.
          const stamped: Record<string, unknown> = { ...(perTradeRules as unknown as Record<string, unknown>) };
          for (const [path, val] of fr.ruleOverrides) {
            if (!path.startsWith("rules.")) continue;
            const key = path.slice("rules.".length);
            if (!NUMERIC_RULE_KEYS.has(key as keyof SimRules)) continue;
            stamped[key] = val;
          }
          perTradeRules = stamped as unknown as SimRules;
        }
        if (fr.prints.size > 0) {
          prints = prints ?? {};
          for (const [label, val] of fr.prints) {
            prints[label] = val;
          }
        }
      }
    }

    const r = simulateZone(zone, bars, perTradeRules, zoneAtr);
    if (r) {
      if (prints) r.script_prints = prints;
      results.push(r);
    }
  }

  // Dedupe by *logical-trade* identity BEFORE any post-pass.
  //
  // When the user selects multiple replay_sessions whose bar windows
  // OVERLAP in time, runBacktestForSession runs the signal generator on
  // each session independently and emits separate synthetic zones for
  // the SAME logical entry. Each zone has a different zoneId (idOffset
  // is per-session) so a zoneId-based dedupe lets them all through.
  //
  // Why dedupe NOW (before applyScalingModifier / applyDailyLimits):
  // the scaling walk advances state PER trade. A duplicate winner
  // double-credits the win step; a duplicate loser double-credits the
  // loss step. The state then leaks into legitimately-non-duplicate
  // trades, inflating their qty. Same hazard for daily-limit accounting.
  //
  // Key: (startTime, direction, instrument, startPrice) uniquely
  // identifies a logical trade. SimZoneResult doesn't carry startPrice
  // directly so we resolve via the backing zones map keyed by zoneId.
  //
  // Tie-break: keep the FIRST occurrence (earliest by zoneId order).
  // All subsequent copies should be byte-identical unless there's
  // session-specific indicator drift — in which case the user's
  // session data has a real overlap they need to resolve at the source.
  // We warn loudly so it's not silent.
  const zoneByIdForDedupe = new Map<number, TradeZone>();
  for (const z of zones) zoneByIdForDedupe.set(z.id, z);
  const tradeKey = (r: SimZoneResult): string => {
    const z = zoneByIdForDedupe.get(r.zoneId);
    const startPrice = z ? z.start_price : 0;
    return `${r.startTime}|${r.direction}|${r.instrument}|${startPrice}`;
  };
  const seenKey = new Set<string>();
  const deduped: SimZoneResult[] = [];
  for (const r of results) {
    const key = tradeKey(r);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    deduped.push(r);
  }
  if (deduped.length !== results.length) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        `[simulateAllZones] dedupe dropped ${
          results.length - deduped.length
        } overlapping-session duplicate(s). Some selected replay_sessions cover the same bars; pick one session per date or fix the start/end_time of any session that spans multiple days.`
      );
    }
  }

  // Post-process: apply cross-zone overlap handling per rules.positionMode.
  // No-op when mode is "default" (returns the array unchanged).
  const gated = applyPositionMode(zones, deduped, barsByZoneId, rules);

  // Apply per-day TRADE COUNT and LOSS COUNT caps + cooldown, BEFORE the
  // scaling walk. This ordering matches the lazy-mode daily-limit
  // semantics (drop new entries past the cap, leave already-running
  // trades alone) so downstream scaling/daily-limit passes see the
  // surviving set only and don't double-count drops.
  const countCapped = applyTradeCountCaps(gated, rules);

  // Two-pass scaling around daily-limit:
  //
  //   Pass 1: provisional sizes so applyDailyLimits has scaledPoints to
  //           compare against the threshold.
  //   Pass 2: final sizes on the surviving + force-closed trades, so
  //           positionSize for each kept trade reflects ONLY the
  //           live-correct walk through trades that actually realized.
  //
  // Without Pass 2, scaling state walks through trades that
  // applyDailyLimits later drops (post-halt entries that never realized
  // in live trading). Those phantom trades pump state for surviving
  // entries on subsequent days, producing inflated qty values that
  // don't match what NT8's per-leg OnPositionClosed produces.
  const provisional = applyScalingModifier(countCapped, rules);
  const survived = applyDailyLimits(provisional, zones, barsByZoneId, rules);
  const final = applyScalingModifier(survived, rules);

  return final.sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );
}

// ─── Scaling Modifier Post-Pass ──────────────────────────────────────────────
//
// Walks the final (post-overlap-gating) result list in chronological order and
// assigns a running positionSize to each trade. After a winner the next
// trade's size goes up by scalingWinStep; after a loser it goes down by
// scalingLossStep; flat trades (exit = 0) leave size unchanged. The running
// size is clamped to [scalingMinSize, scalingMaxSize] so long streaks can't
// produce absurd sizes. scaledPoints = exitPoints × positionSize (rounded 2dp).
//
// When scalingEnabled is false, this is effectively a no-op — positionSize
// stays at 1 and scaledPoints stays === exitPoints, so every downstream
// consumer can read scaledPoints unconditionally.
export function applyScalingModifier(
  results: SimZoneResult[],
  rules: SimRules
): SimZoneResult[] {
  // When scaling is off, we still need to refresh netDollars so it
  // reflects the FINAL positionSize (1 in this case). Doing it once
  // here keeps the contract "netDollars is always size-correct" without
  // forcing every caller to re-derive it.
  if (!rules.scalingEnabled) {
    const pv = rules.pointValue || 0;
    for (const r of results) {
      r.netDollars =
        Math.round(
          (r.scaledPoints * pv - r.commissionDollars * r.positionSize) * 100
        ) / 100;
    }
    return results;
  }

  // Walk entries chronologically by START time. The size for each new
  // entry depends ONLY on prior trades whose exitTime < this entry's
  // startTime — i.e., trades that had ALREADY CLOSED at the moment the
  // new entry would have fired in real time.
  //
  // Why this matters: with positionMode="add-null" the simulator can have
  // overlapping stacked entries — trade N+1 enters while trade N is still
  // in flight. The previous version of this pass walked trades sequentially
  // and advanced `size` based on each trade's outcome BEFORE moving on,
  // which gave trade N+1 look-ahead knowledge of trade N's result. That's
  // unreproducible in live trading (NT8 doesn't know a trade's outcome
  // until it actually closes), so the dashboard backtest systematically
  // over-aggressed sizing on stacked sequences and reported optimistic
  // P&L. This version only credits a step from a prior trade once that
  // trade's exitTime has actually passed.
  //
  // Implementation: maintain two cursors — entries sorted by startTime
  // and a separate list sorted by exitTime — and advance the exitTime
  // cursor past every closed trade before sizing each new entry. O(n log n)
  // for the sorts, O(n) for the walk.
  const sortedByStart = [...results].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );
  const sortedByExit = [...results].sort((a, b) =>
    a.exitTime < b.exitTime ? -1 : a.exitTime > b.exitTime ? 1 : 0
  );

  const minSize = Math.min(rules.scalingMinSize, rules.scalingMaxSize);
  const maxSize = Math.max(rules.scalingMinSize, rules.scalingMaxSize);
  const clamp = (v: number) => Math.max(minSize, Math.min(maxSize, v));

  // Same calendar-day key the daily-limit pass uses, so "new day" means
  // the same thing in both places. Falls back to the raw timestamp when
  // parseRawTimestamp can't read it — defensive vs malformed data.
  const dayKey = (timestamp: string): string => {
    const { year, month, day } = parseRawTimestamp(timestamp);
    if (!year && !month && !day) return timestamp;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

  const stepFor = (closed: SimZoneResult, currentSize: number): number => {
    if (closed.exitPoints > 0) return clamp(currentSize + rules.scalingWinStep);
    if (closed.exitPoints < 0) return clamp(currentSize - rules.scalingLossStep);
    return currentSize; // flat trade — no step
  };

  const startSize = clamp(rules.scalingStartSize);
  let size = startSize;
  let prevDay: string | null = null;
  let exitCursor = 0;
  const pv = rules.pointValue || 0;

  for (const r of sortedByStart) {
    // Daily reset: when scalingResetDaily is on and we've crossed into a
    // new calendar day, snap size back to startSize BEFORE assigning to
    // this trade. We also advance the exit cursor past any closed trades
    // from prior days — they're absorbed by the reset and shouldn't
    // contribute steps once we're in the new day.
    if (rules.scalingResetDaily) {
      const today = dayKey(r.startTime);
      if (prevDay !== null && today !== prevDay) {
        size = startSize;
        while (
          exitCursor < sortedByExit.length &&
          dayKey(sortedByExit[exitCursor].exitTime) !== today
        ) {
          exitCursor++;
        }
      }
      prevDay = today;
    }

    // Apply size steps from every trade that closed STRICTLY BEFORE this
    // entry's startTime. A trade whose exitTime equals this startTime is
    // treated as already-closed (the exit fill happened first). Any trade
    // whose exitTime is later is still in flight and contributes nothing
    // to this entry's sizing — that's the live-correct semantics.
    while (
      exitCursor < sortedByExit.length &&
      sortedByExit[exitCursor].exitTime <= r.startTime
    ) {
      // Skip the current entry itself if we hit it via the exit cursor
      // (can happen when a trade has zero duration — exitTime === startTime).
      if (sortedByExit[exitCursor] !== r) {
        size = stepFor(sortedByExit[exitCursor], size);
      }
      exitCursor++;
    }

    // Reverse-entry reset: positionMode reverse-null/reverse-add tag the
    // flipped trade. On a reverse, the scaling walk snaps back to
    // scalingStartSize so subsequent steps build from a clean base.
    if (r.isReverseEntry) size = startSize;

    r.positionSize = size;
    r.scaledPoints = Math.round(r.exitPoints * size * 100) / 100;
    // netDollars reflects the size-scaled P&L net of commissions for
    // this trade's full bracket: every contract pays the round-trip
    // commission, so we multiply commissionDollars by size.
    r.netDollars =
      Math.round(
        (r.scaledPoints * pv - r.commissionDollars * size) * 100
      ) / 100;
  }

  return sortedByStart;
}

// ─── Trade-Count + Cooldown Post-Pass ──────────────────────────────────────
//
// Applies hard count-based gates BEFORE the P&L-based daily limits. Three
// independent rules:
//
//   1. maxTradesPerDay — drop new entries once the day's running entry
//      count hits the cap. Counts every trade, win/loss/flat alike.
//   2. maxLossesPerDay — drop new entries once the day's running LOSS
//      count hits the cap. Losses are per-contract `exitPoints < 0`
//      (size doesn't matter: a 1-lot loss counts the same as a 5-lot
//      loss for "I'm three losers down today, stop").
//   3. cooldownBetweenTrades — drop entries whose startTime is fewer
//      than `cooldownBetweenTradesBars` minutes after the last KEPT
//      trade's exitTime. We use minutes-since-prev-exit because the
//      synthetic-zone bars are 1-min by default; for sub-minute
//      timeframes the cooldown still works as a proportional gate
//      (e.g. 5 cooldown bars on 15s data = 1.25 minutes in wall-clock
//      ≈ 5 of the source bars). Approximate but no bar map needed.
//
// Walks chronologically by startTime, maintaining per-day counters and a
// "last kept exit time" cursor. Trades that survive go through unchanged
// (this pass doesn't modify scaledPoints / positionSize — those get
// (re)written by the scaling post-pass downstream).
export function applyTradeCountCaps(
  results: SimZoneResult[],
  rules: SimRules
): SimZoneResult[] {
  const tradeCapOn =
    rules.maxTradesPerDayEnabled && rules.maxTradesPerDay > 0;
  const lossCapOn =
    rules.maxLossesPerDayEnabled && rules.maxLossesPerDay > 0;
  const cooldownOn =
    rules.cooldownBetweenTradesEnabled && rules.cooldownBetweenTradesBars > 0;
  if (!tradeCapOn && !lossCapOn && !cooldownOn) return results;

  const dayKey = (timestamp: string): string => {
    const { year, month, day } = parseRawTimestamp(timestamp);
    if (!year && !month && !day) return timestamp;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

  // Convert ISO-ish timestamps to a comparable epoch-minute. We avoid
  // Date.parse on the raw string because the project's timestamps come
  // in a couple flavors; parseRawTimestamp handles both. Returns NaN
  // when unparsable so the cooldown gate degrades to a no-op for bad
  // rows rather than dropping them all.
  const toMinutes = (timestamp: string): number => {
    const { year, month, day, hour, minute } = parseRawTimestamp(timestamp);
    if (!year && !month && !day) return NaN;
    // Cheap epoch-ish ordinal: treat the date as a sortable integer
    // and add HH:MM. We never compare across very-different years so
    // overflow isn't a concern.
    return (
      year * 525600 + month * 43800 + day * 1440 + (hour || 0) * 60 + (minute || 0)
    );
  };

  const sortedByStart = [...results].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );

  const tradeCountByDay = new Map<string, number>();
  const lossCountByDay = new Map<string, number>();
  let lastKeptExitMin: number | null = null;
  const kept: SimZoneResult[] = [];

  for (const r of sortedByStart) {
    const day = dayKey(r.startTime);
    const tradesToday = tradeCountByDay.get(day) ?? 0;
    const lossesToday = lossCountByDay.get(day) ?? 0;

    // Trade count cap — drop the moment we'd exceed.
    if (tradeCapOn && tradesToday >= rules.maxTradesPerDay) continue;
    // Loss count cap — drop once the day already booked the cap's worth
    // of losers. The trade that BECOMES the Nth loser is itself kept
    // (matching the lazy "the trigger trade lands, the next ones don't"
    // semantics of dailyStopLoss).
    if (lossCapOn && lossesToday >= rules.maxLossesPerDay) continue;
    // Cooldown — measured against the last KEPT trade's exit, regardless
    // of day boundary. A trade that closes at 15:55 and another that
    // would enter at 16:00 with cooldown=10 still gets dropped, which
    // matches what a live trader's "wait 10 minutes after a loss"
    // discipline would do.
    if (cooldownOn && lastKeptExitMin !== null) {
      const startMin = toMinutes(r.startTime);
      if (
        Number.isFinite(startMin) &&
        startMin - lastKeptExitMin < rules.cooldownBetweenTradesBars
      ) {
        continue;
      }
    }

    kept.push(r);
    tradeCountByDay.set(day, tradesToday + 1);
    if (r.exitPoints < 0) {
      lossCountByDay.set(day, lossesToday + 1);
    }
    const exitMin = toMinutes(r.exitTime);
    if (Number.isFinite(exitMin)) lastKeptExitMin = exitMin;
  }

  return kept;
}

// ─── Daily TP / SL Post-Pass ────────────────────────────────────────────────
//
// Implements per-day kill switches: once the day's realized cumulative P&L
// (sum of scaledPoints over already-closed trades) crosses the configured
// daily TP or daily SL, no NEW trades are entered for the remainder of that
// day. The trade whose realization tripped the wire is itself kept — its
// outcome is what crossed the line.
//
// Two modes (selected by rules.dailyLimitExactMode):
//   Lazy (default): trades already in flight at the moment of trigger
//     keep running to their natural exit. Only LATER would-be entries
//     get filtered. The trigger trade itself is kept at its natural
//     exit, so the day's total can OVERSHOOT the limit by up to the
//     trigger's own P&L magnitude (typical loose interpretation).
//   Exact:          treats the limit as a HARD CAP on the day's
//     realized P&L. The trigger trade's contribution is clipped so
//     cumulative lands exactly at the threshold (no overshoot from the
//     trigger itself), and any in-flight trade is force-closed at the
//     trigger bar via earlyCloseAtTime — its contribution is then
//     CLIPPED so it can't push the day's running total past either
//     limit. After exact mode runs, the day's total is guaranteed to
//     sit within [-dailySL, +dailyTP] (when both are on). The
//     trigger's exit reason becomes "daily"; force-closed in-flight
//     trades also use "daily". Position size assigned by the scaling
//     pass is preserved, and exitPoints is back-derived from the
//     clipped scaledPoints / positionSize so the per-contract figure
//     stays internally consistent.
//
// Day grouping uses the calendar date extracted from each trade's startTime
// via parseRawTimestamp (no timezone math), so futures sessions that sit
// inside one calendar day (typical RTH backtests) bucket the obvious way.
// Sessions that span midnight will split across two days — fine for our use
// case but worth noting if we ever extend to overnight futures.
//
// Algorithm — per day:
//   1. Walk trades in EXIT-time order, accumulating scaledPoints. The first
//      trade whose realization crosses TP or SL becomes the "trigger" and
//      its exitTime is the day's hit time T. (Trigger detection ignores
//      exact-mode rewrites — we want the trigger derived from the
//      simulator's chosen exits, since that's the moment P&L would have
//      been realized live.)
//   2. If no trigger fires that day, every trade is kept as-is.
//   3. Otherwise, for each trade on the day:
//        - startTime > T  → drop (would have been entered after the kill).
//        - exitTime <= T  → keep as-is (already exited before the kill).
//        - in flight (startTime <= T < exitTime):
//            lazy mode  → keep as-is (let it run).
//            exact mode → force-close at T, preserving the scaling-pass
//                         positionSize and recomputing scaledPoints.
//
// Cross-day ordering is preserved by chronological sort of the final result.

export function applyDailyLimits(
  results: SimZoneResult[],
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  rules: SimRules
): SimZoneResult[] {
  const tpOn = rules.dailyTakeProfitEnabled && rules.dailyTakeProfitPoints > 0;
  const slOn = rules.dailyStopLossEnabled && rules.dailyStopLossPoints > 0;
  if (!tpOn && !slOn) return results;
  if (results.length === 0) return results;
  const exactMode = !!rules.dailyLimitExactMode;

  // Lookup map for resolving zoneId → TradeZone (needed by earlyCloseAtTime
  // in exact mode). Only built when exact mode is on; lazy mode never
  // touches zones / bars.
  const zonesById = exactMode ? new Map<number, TradeZone>() : null;
  if (zonesById) for (const z of zones) zonesById.set(z.id, z);

  // Day key — YYYY-MM-DD pulled from the timestamp. Falls back to the raw
  // startTime when the parse fails so unparsable timestamps still group
  // each-into-their-own bucket (defensive against malformed data).
  const dayKey = (timestamp: string): string => {
    const { year, month, day } = parseRawTimestamp(timestamp);
    if (!year && !month && !day) return timestamp;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

  // Group by day, preserving original ordering within each group.
  const byDay = new Map<string, SimZoneResult[]>();
  for (const r of results) {
    const key = dayKey(r.startTime);
    const arr = byDay.get(key);
    if (arr) arr.push(r);
    else byDay.set(key, [r]);
  }

  const tpThresh = rules.dailyTakeProfitPoints;
  const slThresh = -Math.abs(rules.dailyStopLossPoints);

  // pointValue used by the in-flight force-close path to recompute
  // netDollars after rewriting scaledPoints (matches applyScalingModifier).
  const pvForDailyClip = rules.pointValue || 0;

  const finalKept: SimZoneResult[] = [];

  for (const [, dayTrades] of byDay) {
    // Phase 1 — find T (the daily-DD threshold-crossing time).
    //
    // LAZY mode: T = exit time of the FIRST trade whose REALIZED cum
    // crosses the threshold. New entries after T are dropped; the
    // trigger trade and earlier trades keep their natural P&L.
    //
    // EXACT mode: T = first BAR-CLOSE TIME where (realized cum so far +
    // sum of all in-flight trades' bar-close unrealized) crosses the
    // threshold. This matches the user's stated semantics: "exact mode
    // closes as soon as unrealized hits the daily loss limit". Walk a
    // merged per-day bar timeline; at each bar, accumulate realized
    // (trades that have fully closed before this bar) plus aggregate
    // unrealized from in-flight trades using THIS bar's close. Force-
    // close every in-flight trade at T in Phase 2.
    let T: string | null = null;

    if (!exactMode) {
      const byExit = [...dayTrades].sort((a, b) =>
        a.exitTime < b.exitTime ? -1 : a.exitTime > b.exitTime ? 1 : 0
      );
      let cum = 0;
      for (const t of byExit) {
        cum += t.scaledPoints;
        if ((tpOn && cum >= tpThresh) || (slOn && cum <= slThresh)) {
          T = t.exitTime;
          break;
        }
      }
    } else {
      // Build a merged per-day bar timeline. Two zones covering the
      // same underlying market bar should produce the same close, so
      // de-dup on bar_time (first-seen wins). If the data has session-
      // overlap drift, the dedupe pass earlier in simulateAllZones
      // should have removed the duplicate trades; remaining bar-close
      // mismatches at the same bar_time would be silent data corruption.
      const barsByTime = new Map<string, TradeZoneBar>();
      for (const t of dayTrades) {
        const bs = barsByZoneId.get(t.zoneId) ?? [];
        for (const b of bs) {
          if (!barsByTime.has(b.bar_time)) barsByTime.set(b.bar_time, b);
        }
      }
      const sortedTimes = [...barsByTime.keys()].sort();

      // Pre-resolve each trade's effective entry price once.
      const fillModeRule = rules.fillMode || "next_open";
      const entryPriceByZone = new Map<number, number>();
      for (const t of dayTrades) {
        const z = zonesById?.get(t.zoneId);
        const bs = barsByZoneId.get(t.zoneId) ?? [];
        const bar1 = bs.find((b) => b.bar_index === 1);
        const ep =
          fillModeRule === "next_open" && bar1
            ? bar1.bar_open
            : (z?.start_price ?? 0);
        entryPriceByZone.set(t.zoneId, ep);
      }

      for (const time of sortedTimes) {
        const bar = barsByTime.get(time)!;

        let realized = 0;
        let unrealized = 0;
        for (const t of dayTrades) {
          if (t.exitTime <= time) {
            // Already closed by this bar — count its full realized P&L.
            realized += t.scaledPoints;
          } else if (t.startTime <= time) {
            // In flight at this bar — bar-close unrealized.
            const ep = entryPriceByZone.get(t.zoneId) ?? 0;
            const isLong = t.direction === "Long";
            const u =
              (isLong ? bar.bar_close - ep : ep - bar.bar_close) *
              Math.max(1, t.positionSize);
            unrealized += u;
          }
          // else: not entered yet at `time` — contributes nothing.
        }

        const dayPnl = realized + unrealized;
        if (
          (slOn && dayPnl <= slThresh) ||
          (tpOn && dayPnl >= tpThresh)
        ) {
          T = time;
          break;
        }
      }
    }

    // No threshold crossed today → keep every trade unchanged.
    if (T === null) {
      finalKept.push(...dayTrades);
      continue;
    }

    // ── Phase 2 — apply at T ─────────────────────────────────────────────
    //  • t.startTime > T  → drop (post-halt entry blocked).
    //  • t.exitTime <= T  → pass through with natural P&L (already
    //    realized; includes the trigger trade itself).
    //  • t.exitTime >  T  → in-flight at T:
    //      - EXACT mode: force-close at T via earlyCloseAtTime
    //        (exitReason="daily"). Recompute scaledPoints + netDollars
    //        from the bar-close fill price.
    //      - LAZY mode: pass through with natural P&L (the historical
    //        "stop entering, let the rest run" behavior).
    for (const t of dayTrades) {
      if (t.startTime > T) continue;
      if (t.exitTime <= T) {
        finalKept.push(t);
        continue;
      }
      // In-flight at T.
      if (!exactMode) {
        finalKept.push(t);
        continue;
      }
      const z = zonesById?.get(t.zoneId);
      const bars = barsByZoneId.get(t.zoneId);
      if (!z || !bars) {
        // Defensive — keep original P&L if lookup fails.
        finalKept.push(t);
        continue;
      }
      const forceClosed = earlyCloseAtTime(z, bars, T, rules);
      if (!forceClosed) {
        finalKept.push(t);
        continue;
      }
      forceClosed.positionSize = t.positionSize;
      forceClosed.scaledPoints =
        Math.round(forceClosed.exitPoints * t.positionSize * 100) / 100;
      forceClosed.netDollars =
        Math.round(
          (forceClosed.scaledPoints * pvForDailyClip -
            forceClosed.commissionDollars * t.positionSize) *
            100
        ) / 100;
      forceClosed.exitReason = "daily";
      finalKept.push(forceClosed);
    }
  }

  // Re-sort across days so downstream consumers (equity curve, table) see
  // chronological order. Matches the convention of applyScalingModifier.
  return finalKept.sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );
}

// ─── Cross-Zone Position Mode ───────────────────────────────────────────────
//
// The base simulator runs each zone in isolation, so two zones whose time
// windows overlap (which gets common when "Extend Bars" is on) get treated as
// independent trades. In real trading you can't be long and short the same
// instrument at the same time — so this post-processing step rewrites results
// per the user's PositionMode preference. See the PositionMode docs at the
// top of this file for the per-mode semantics.

/**
 * Walks zones in chronological start-time order and applies overlap rules.
 * For "default" mode, returns the input array unchanged. For other modes,
 * may close some prior results early (exit reason → "next") and/or drop
 * conflicting candidates entirely.
 */
export function applyPositionMode(
  zones: TradeZone[],
  results: SimZoneResult[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  rules: SimRules
): SimZoneResult[] {
  if (rules.positionMode === "default") return results;

  // Lookup map for resolving zoneId → TradeZone (needed to early-close)
  const zonesById = new Map<number, TradeZone>();
  for (const z of zones) zonesById.set(z.id, z);

  // Sort by chronological start time. ISO timestamps sort lexicographically
  // when they share the same format/timezone (Postgrest returns UTC ISO).
  const candidates = [...results].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );

  const finalResults: SimZoneResult[] = [];

  for (const candidate of candidates) {
    const candStart = candidate.startTime;
    const candDir = candidate.direction;

    // Currently-open positions = anything in finalResults whose exit time is
    // strictly AFTER the candidate's start time. (If equal, the prior is
    // already done at the moment the candidate opens.)
    const openIdx: number[] = [];
    for (let i = 0; i < finalResults.length; i++) {
      if (finalResults[i].exitTime > candStart) openIdx.push(i);
    }

    // No conflict — open the candidate as-is regardless of mode
    if (openIdx.length === 0) {
      finalResults.push(candidate);
      continue;
    }

    // Does the candidate oppose any currently-open position? Used by the
    // "add-*" modes which only act when directions disagree.
    const anyOpposing = openIdx.some((i) => finalResults[i].direction !== candDir);

    switch (rules.positionMode) {
      case "close-previous": {
        // Force-close every currently-open position at the candidate's start.
        for (const i of openIdx) {
          const r = finalResults[i];
          const z = zonesById.get(r.zoneId);
          const bars = barsByZoneId.get(r.zoneId);
          if (!z || !bars) continue;
          const closed = earlyCloseAtTime(z, bars, candStart, rules);
          if (closed) finalResults[i] = closed;
        }
        finalResults.push(candidate);
        break;
      }
      case "add-close": {
        // Close only opposing positions; same-direction ones keep running.
        for (const i of openIdx) {
          if (finalResults[i].direction === candDir) continue;
          const r = finalResults[i];
          const z = zonesById.get(r.zoneId);
          const bars = barsByZoneId.get(r.zoneId);
          if (!z || !bars) continue;
          const closed = earlyCloseAtTime(z, bars, candStart, rules);
          if (closed) finalResults[i] = closed;
        }
        finalResults.push(candidate);
        break;
      }
      case "null": {
        // Anything open → drop the candidate entirely
        break;
      }
      case "add-null": {
        // Drop only when an opposing position is open; otherwise stack normally
        if (anyOpposing) break;
        finalResults.push(candidate);
        break;
      }
      case "reverse-null": {
        // Opposing open → flip the side: close opposing positions and open
        // the new one (tagged as a reverse so the scaling walk resets size).
        // Same-direction open → drop the candidate (keep current position).
        if (!anyOpposing) break;
        for (const i of openIdx) {
          if (finalResults[i].direction === candDir) continue;
          const r = finalResults[i];
          const z = zonesById.get(r.zoneId);
          const bars = barsByZoneId.get(r.zoneId);
          if (!z || !bars) continue;
          const closed = earlyCloseAtTime(z, bars, candStart, rules);
          if (closed) finalResults[i] = closed;
        }
        finalResults.push({ ...candidate, isReverseEntry: true });
        break;
      }
      case "reverse-add": {
        // Opposing open → flip (close opposing, open new with reverse tag).
        // Same-direction open → stack normally (no reverse tag).
        if (anyOpposing) {
          for (const i of openIdx) {
            if (finalResults[i].direction === candDir) continue;
            const r = finalResults[i];
            const z = zonesById.get(r.zoneId);
            const bars = barsByZoneId.get(r.zoneId);
            if (!z || !bars) continue;
            const closed = earlyCloseAtTime(z, bars, candStart, rules);
            if (closed) finalResults[i] = closed;
          }
          finalResults.push({ ...candidate, isReverseEntry: true });
        } else {
          finalResults.push(candidate);
        }
        break;
      }
    }
  }

  return finalResults;
}

/**
 * Walks `bars` from the start until reaching one whose bar_time >= closeAtTime,
 * computing direction-aware running peak/drawdown along the way, and returns a
 * SimZoneResult exiting at that bar's close. Returns null if `closeAtTime` is
 * past the zone's last bar (caller should leave the original result alone).
 *
 * Mirrors the entry-bar handling and direction logic in simulateZone so the
 * truncated peak/MFE/drawdown numbers stay consistent with how a normal exit
 * would have computed them.
 */
function earlyCloseAtTime(
  zone: TradeZone,
  bars: TradeZoneBar[],
  closeAtTime: string,
  rules?: SimRules
): SimZoneResult | null {
  if (bars.length === 0) return null;
  const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);
  const isLong = zone.direction === "Long";

  // Mirror simulateZone: when fillMode is next_open, the entry was at
  // bar 1 open, not the trigger bar's close. Match here so the peak/DD
  // and force-close P&L are measured from the same anchor the original
  // simulation used.
  const fillMode = rules?.fillMode || "next_open";
  const bar1 = sorted.find((b) => b.bar_index === 1);
  const entryPrice =
    fillMode === "next_open" && bar1
      ? bar1.bar_open
      : zone.start_price;
  const slipRoundTrip = Math.max(0, (rules?.slippagePoints || 0) * 2);

  let runningPeak = 0;
  let runningDd = 0;
  let exitBar: TradeZoneBar | null = null;

  for (const bar of sorted) {
    // Skip the entry bar — its high/low includes pre-entry price action and
    // shouldn't inflate peak/dd. Same convention as simulateZone.
    if (bar.bar_index === 0) continue;

    const highPnl = isLong ? bar.bar_high - entryPrice : entryPrice - bar.bar_low;
    const lowPnl = isLong ? bar.bar_low - entryPrice : entryPrice - bar.bar_high;
    if (highPnl > runningPeak) runningPeak = highPnl;
    if (lowPnl < runningDd) runningDd = lowPnl;

    if (bar.bar_time >= closeAtTime) {
      exitBar = bar;
      break;
    }
  }

  // The new position opens past this zone's last bar — nothing to truncate.
  if (!exitBar) return null;

  const closePnl = isLong
    ? exitBar.bar_close - entryPrice
    : entryPrice - exitBar.bar_close;

  // Net of round-trip slippage so this synthetic exit pays the same
  // cost as a normal SL/TP/timer exit through `result()`.
  const netPnl = closePnl - slipRoundTrip;
  const rounded = Math.round(netPnl * 100) / 100;
  const commission = Math.max(0, rules?.commissionPerRoundTrip || 0);
  const pv = rules?.pointValue || 0;
  return {
    zoneId: zone.id,
    direction: zone.direction,
    originalPoints: zone.points_move,
    exitPoints: rounded,
    exitReason: "next",
    exitBarIndex: exitBar.bar_index,
    exitTime: exitBar.bar_time,
    barsHeld: exitBar.bar_index + 1,
    peakMfe: Math.round(runningPeak * 100) / 100,
    maxDrawdown: Math.round(runningDd * 100) / 100,
    instrument: zone.instrument,
    startTime: zone.start_time,
    positionSize: 1,
    scaledPoints: rounded,
    slippageApplied: slipRoundTrip,
    commissionDollars: commission,
    netDollars: Math.round((rounded * pv - commission) * 100) / 100,
  };
}

// ─── Summary Statistics ──────────────────────────────────────────────────────

export function computeSimSummary(
  results: SimZoneResult[],
  // Optional rules — when supplied, the dominant-instrument tick config is
  // resolved through `resolveTickConfig` so a "manual" override from the
  // Fills & Costs panel surfaces verbatim. When omitted, we fall back to
  // the auto-only path (lookupTickSpec on the dominant symbol) which
  // matches the legacy behavior for the optimizer/replay call sites that
  // don't have rules in scope.
  rules?: Pick<SimRules, "tickConfigMode" | "ticksPerPoint" | "tickValue" | "pointValue">
): SimSummary {
  const empty: SimSummary = {
    totalTrades: 0, winners: 0, losers: 0, winRate: 0, avgPoints: 0,
    totalPoints: 0, expectancy: 0, expectancyPerSize: 0, avgWinPoints: 0,
    avgLossPoints: 0, profitFactor: 0, avgBarsHeld: 0, bestTrade: 0,
    worstTrade: 0, byExitReason: {}, dailyEv: 0, tradingDays: 0,
    avgTradesPerHour: 0, sharpeOriginal: 0, sharpeSimulated: 0,
    maxDrawdown: 0, grossProfit: 0, grossLoss: 0, totalCommissions: 0,
    maxConsecutiveWinners: 0, maxConsecutiveLosers: 0, monthlyEv: 0,
    totalDollars: 0, avgDollars: 0, expectancyDollars: 0,
    avgWinDollars: 0, avgLossDollars: 0, bestTradeDollars: 0,
    worstTradeDollars: 0, grossProfitDollars: 0, grossLossDollars: 0,
    dailyEvDollars: 0, monthlyEvDollars: 0, maxDrawdownDollars: 0,
    profitFactorDollars: 0,
  };
  if (results.length === 0) return empty;

  // Win/loss classification is on the raw per-contract outcome (exitPoints):
  // a scaled-down loser is still a loser. All magnitudes (totals, avgs, profit
  // factor) use scaledPoints so they reflect the user's position sizing. When
  // scaling is disabled, scaledPoints === exitPoints so numbers are unchanged.
  const winners = results.filter((r) => r.exitPoints > 0);
  const losers = results.filter((r) => r.exitPoints < 0);

  const totalPts = results.reduce((s, r) => s + r.scaledPoints, 0);
  const grossWins = winners.reduce((s, r) => s + r.scaledPoints, 0);
  const grossLosses = Math.abs(losers.reduce((s, r) => s + r.scaledPoints, 0));

  const avgWin = winners.length > 0 ? grossWins / winners.length : 0;
  const avgLoss = losers.length > 0 ? grossLosses / losers.length : 0;
  const wr = winners.length / results.length;

  // Per-size EV — same formula, but the magnitudes come from raw per-contract
  // exitPoints. Each trade's scaledPoints/positionSize === exitPoints by
  // construction, so this is equivalent to "divide each trade's contribution
  // by its position size". Gives the user the underlying strategy EV per one
  // contract, which is independent of the scaling modifier.
  const grossWinsPerSize = winners.reduce((s, r) => s + r.exitPoints, 0);
  const grossLossesPerSize = Math.abs(losers.reduce((s, r) => s + r.exitPoints, 0));
  const avgWinPerSize = winners.length > 0 ? grossWinsPerSize / winners.length : 0;
  const avgLossPerSize = losers.length > 0 ? grossLossesPerSize / losers.length : 0;

  const byExitReason: Record<string, number> = {};
  for (const r of results) byExitReason[r.exitReason] = (byExitReason[r.exitReason] || 0) + 1;

  const pts = results.map((r) => r.scaledPoints);

  // Count unique trading days by slicing the YYYY-MM-DD prefix off each
  // startTime ISO string. This is timezone-naive on purpose: the startTime
  // values are whatever Postgrest returned (UTC ISO), and a trade that opens
  // just after midnight UTC will land on the following day even if the user
  // considers it part of the prior session. Good enough for "average points
  // per day" — the denominator is a few days off only for a sliver of edge
  // cases and the metric stays intuitive.
  const uniqueDays = new Set<string>();
  for (const r of results) {
    if (r.startTime) uniqueDays.add(r.startTime.slice(0, 10));
  }
  const tradingDays = uniqueDays.size;
  const totalScaled = pts.reduce((s, v) => s + v, 0);

  // Avg trades per hour — bucket trades by day, take each day's window from
  // the earliest start to the latest exit, sum the windows, then divide total
  // trades by total window-hours. Excluding cross-day gaps keeps the metric
  // anchored to actual trading activity instead of being diluted by nights
  // and weekends. Days where the window collapses to zero (shouldn't happen
  // with valid bars but guarded anyway) are skipped to avoid div-by-zero.
  const dayWindows = new Map<string, { minStart: number; maxExit: number }>();
  for (const r of results) {
    if (!r.startTime || !r.exitTime) continue;
    const day = r.startTime.slice(0, 10);
    const startMs = Date.parse(r.startTime);
    const exitMs = Date.parse(r.exitTime);
    if (Number.isNaN(startMs) || Number.isNaN(exitMs)) continue;
    const w = dayWindows.get(day);
    if (!w) dayWindows.set(day, { minStart: startMs, maxExit: exitMs });
    else {
      if (startMs < w.minStart) w.minStart = startMs;
      if (exitMs > w.maxExit) w.maxExit = exitMs;
    }
  }
  let activeHours = 0;
  for (const w of dayWindows.values()) {
    const hrs = (w.maxExit - w.minStart) / (1000 * 60 * 60);
    if (hrs > 0) activeHours += hrs;
  }
  const avgTradesPerHour = activeHours > 0 ? results.length / activeHours : 0;

  // Per-trade Sharpe for both series. Uses sample standard deviation
  // (denominator n-1) which is the standard convention for a sampled series
  // and matches what Excel's STDEV / numpy's std(ddof=1) would produce. With
  // fewer than 2 trades or zero variance we return 0 rather than NaN/Infinity
  // so the metric stays render-safe in the UI. Risk-free rate is assumed 0,
  // which is the typical simplification when comparing trade-level returns.
  const sharpe = (values: number[]): number => {
    if (values.length < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance =
      values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1);
    const std = Math.sqrt(variance);
    return std > 0 ? mean / std : 0;
  };
  const originalPts = results.map((r) => r.originalPoints);
  const sharpeOriginal = sharpe(originalPts);
  const sharpeSimulated = sharpe(pts);

  // Max drawdown — worst peak-to-trough on the cumulative scaledPoints
  // curve in CHRONOLOGICAL start-time order. We sort a copy so the
  // metric is stable even if the caller passed results in some other
  // order (e.g. zoneId order). Positive number; 0 when there's never
  // a drawdown (purely-winning sequence).
  const chrono = [...results].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );
  let runningSum = 0;
  let peak = 0;
  let maxDD = 0;
  // Streak counters walked alongside the drawdown loop — both walks
  // need chronological order so we share the same loop body.
  let curWinStreak = 0;
  let curLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const r of chrono) {
    runningSum += r.scaledPoints;
    if (runningSum > peak) peak = runningSum;
    const dd = peak - runningSum;
    if (dd > maxDD) maxDD = dd;
    // Classify by exitPoints (per-contract, pre-scaling) so the streak
    // matches the win/loss counts above. Scratch trades (exitPoints == 0)
    // break both streaks but don't extend either.
    if (r.exitPoints > 0) {
      curWinStreak++;
      curLossStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else if (r.exitPoints < 0) {
      curLossStreak++;
      curWinStreak = 0;
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    } else {
      curWinStreak = 0;
      curLossStreak = 0;
    }
  }

  // Total commissions in dollars — each result carries the per-round-trip
  // commission rate; for scaled trades we charge per contract (matches how
  // netDollars is computed throughout the rest of the engine).
  const totalCommissions = results.reduce(
    (s, r) => s + r.commissionDollars * (r.positionSize || 1),
    0
  );

  // ── Dollar-denominated metric pass ────────────────────────────────────
  // Mirrors the points-based computations above but reads each trade's
  // pre-baked netDollars (which already accounts for per-instrument
  // pointValue, position scaling, and commission). For multi-instrument
  // sessions this is the only correct way — a single converting factor
  // would be wrong because pointValue varies per symbol. Win/loss class
  // is still anchored to per-contract exitPoints so the buckets match
  // the points view (a $-positive trade after commissions but exitPoints
  // == 0 stays "scratch", and vice versa).
  const dollarValues = results.map((r) => r.netDollars);
  const totalDollars = dollarValues.reduce((s, v) => s + v, 0);
  const winnerDollars = winners.reduce((s, r) => s + r.netDollars, 0);
  const loserDollars = Math.abs(losers.reduce((s, r) => s + r.netDollars, 0));
  const avgWinDollars = winners.length > 0 ? winnerDollars / winners.length : 0;
  const avgLossDollars = losers.length > 0 ? loserDollars / losers.length : 0;

  // Max drawdown in dollars — same chrono-walk as the points version,
  // just summing netDollars instead of scaledPoints.
  let runningSumD = 0;
  let peakD = 0;
  let maxDDDollars = 0;
  for (const r of chrono) {
    runningSumD += r.netDollars;
    if (runningSumD > peakD) peakD = runningSumD;
    const dd = peakD - runningSumD;
    if (dd > maxDDDollars) maxDDDollars = dd;
  }

  // ── Dominant-instrument tick config ────────────────────────────────
  // Pick the most-traded instrument across `results` and resolve its
  // pointValue / ticksPerPoint through the same path the simulator
  // itself uses. We frequency-rank rather than take results[0] so
  // multi-instrument sessions report the symbol that dominates the P&L
  // surface, not whichever zone happened to be processed first. Ties
  // break on insertion order (Map preserves first-insert order), which
  // is good enough — exact-tie multi-instrument sessions are rare and
  // either choice gives a representative reading.
  const instrumentCounts = new Map<string, number>();
  for (const r of results) {
    if (!r.instrument) continue;
    instrumentCounts.set(r.instrument, (instrumentCounts.get(r.instrument) ?? 0) + 1);
  }
  let primaryInstrument: string | undefined;
  let topCount = 0;
  for (const [sym, count] of instrumentCounts) {
    if (count > topCount) { topCount = count; primaryInstrument = sym; }
  }
  // Route through resolveTickConfig when rules are provided so a
  // manual-mode override (Fills & Costs panel) wins over the CME defaults.
  // Without rules we fall back to the auto-only path (the optimizer call
  // sites don't carry rules to summary computation, and they're always
  // operating on a known symbol from INSTRUMENT_TICK_SPECS anyway).
  let pointValue: number | undefined;
  let ticksPerPoint: number | undefined;
  if (primaryInstrument) {
    if (rules) {
      const cfg = resolveTickConfig(primaryInstrument, rules);
      pointValue = cfg.pointValue;
      ticksPerPoint = cfg.ticksPerPoint;
    } else {
      const spec = lookupTickSpec(primaryInstrument);
      if (spec) {
        pointValue = spec.pointValue;
        ticksPerPoint = spec.ticksPerPoint;
      }
    }
  }

  return {
    totalTrades: results.length,
    winners: winners.length,
    losers: losers.length,
    winRate: wr,
    avgPoints: totalPts / results.length,
    totalPoints: totalPts,
    expectancy: wr * avgWin - (1 - wr) * avgLoss,
    expectancyPerSize: wr * avgWinPerSize - (1 - wr) * avgLossPerSize,
    avgWinPoints: avgWin,
    avgLossPoints: losers.length > 0 ? -avgLoss : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    avgBarsHeld: results.reduce((s, r) => s + r.barsHeld, 0) / results.length,
    bestTrade: Math.max(...pts),
    worstTrade: Math.min(...pts),
    byExitReason,
    dailyEv: tradingDays > 0 ? totalScaled / tradingDays : 0,
    tradingDays,
    avgTradesPerHour,
    sharpeOriginal,
    sharpeSimulated,
    maxDrawdown: maxDD,
    grossProfit: grossWins,
    grossLoss: grossLosses,
    totalCommissions,
    maxConsecutiveWinners: maxWinStreak,
    maxConsecutiveLosers: maxLossStreak,
    // Monthly EV — extrapolate dailyEv across a typical 21-trading-day
    // month. Uses the same denominator semantics as dailyEv (avg per
    // active day, not per calendar day).
    monthlyEv: tradingDays > 0 ? (totalScaled / tradingDays) * 21 : 0,
    // Dollar-denominated parallels (already net of commissions where it
    // makes sense — netDollars subtracts commissions per round-trip).
    totalDollars,
    avgDollars: totalDollars / results.length,
    expectancyDollars: wr * avgWinDollars - (1 - wr) * avgLossDollars,
    avgWinDollars,
    avgLossDollars: losers.length > 0 ? -avgLossDollars : 0,
    bestTradeDollars: Math.max(...dollarValues),
    worstTradeDollars: Math.min(...dollarValues),
    grossProfitDollars: winnerDollars,
    grossLossDollars: loserDollars,
    dailyEvDollars: tradingDays > 0 ? totalDollars / tradingDays : 0,
    monthlyEvDollars: tradingDays > 0 ? (totalDollars / tradingDays) * 21 : 0,
    maxDrawdownDollars: maxDDDollars,
    profitFactorDollars:
      loserDollars > 0
        ? winnerDollars / loserDollars
        : winnerDollars > 0
          ? Infinity
          : 0,
    primaryInstrument,
    pointValue,
    ticksPerPoint,
  };
}
