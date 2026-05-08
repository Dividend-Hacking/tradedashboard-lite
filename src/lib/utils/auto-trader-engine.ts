/**
 * Auto-Trader Engine
 *
 * Pure logic for running a backtest preset against the live bar feed.
 * Mirrors the backtest pipeline (signal generator → context filters → SimRules
 * exits) so a deployed preset trades live exactly as it backtested.
 *
 * Design split:
 *   - This module is stateless logic. It exposes `decideOnNewBar()` and
 *     `decideOnTick()` pure functions that take the engine state + market
 *     data and return zero or more `AutoTraderAction`s plus the next state.
 *   - The React hook (`useAutoTrader`) owns the state container, subscribes
 *     to live bars / position state, and dispatches actions through the live
 *     trader's existing `handleBuyLong`/`handleSellShort`/`handleClose` /
 *     `handleModifySl` callbacks. Keeping the engine pure makes it
 *     testable in isolation and lets us re-run identical decisions in a
 *     dev/replay context.
 *
 * What's honored from a preset:
 *   - Strategy generator (`signal_v1` / `signal_v2`) — full bar history each
 *     call, same generators the backtest uses, so signals match exactly.
 *   - PresetFilters (time / ADX / ATR / trend / Bollinger) — evaluated on
 *     the signal bar's context snapshot.
 *   - SimRules entry-side: stopLossPoints, takeProfitPoints, trailingStop —
 *     pushed to NT8 as sl_points / tp_points / trail_enabled on the entry
 *     order. ATR-adjust is applied here too (basePoints + atrAdjust × ATR
 *     at entry bar) so the preset's volatility scaling translates directly.
 *   - SimRules exit-side managed client-side after fill:
 *       - breakEvenEnabled: when running peak P&L crosses effBe, send
 *         modify_sl to entry price (mirrors simulator's BE behavior).
 *       - timedExitEnabled: after N bars since entry, send `close`.
 *       - dailyStopLossEnabled / dailyTakeProfitEnabled: track day-cumulative
 *         realized scaledPoints and halt new entries when crossed. Honored
 *         in lazy mode by default; exact mode (close in-flight) is also
 *         supported via dailyLimitExactMode.
 *       - scalingEnabled: walks position size between trades using
 *         start/win/loss/min/max + optional dailyReset, sets the qty for
 *         the next entry order.
 *       - positionMode: governs whether to fire when not flat. Maps to
 *         NT8's order semantics:
 *           default / null      → only fire when flat
 *           close-previous       → send opposite-direction order regardless
 *                                  (NT8 reverses); same-direction adds
 *           add-close            → same-direction adds; opposite reverses
 *           add-null             → same-direction adds; opposite skipped
 *
 * What is NOT honored (out of scope for v1):
 *   - exitAtBarClose / extensionBars — these are simulator-only nuances.
 *     Live exits are real fills triggered by NT8; SL/TP fire at trigger
 *     prices, not bar close.
 *   - The simulator's ATR-aware trailing distance — live trailing already
 *     exists in live-trader.tsx and uses a fixed distance captured at
 *     activation. The engine sets trail_enabled per the preset; the live
 *     RAF loop drives the per-tick stop movement.
 */

import type { ReplayBar } from "@/types/replay";
import type { LiveBar, LiveState } from "@/types/live";
import {
  STRATEGIES,
  buildContextSeries,
  snapshotContext,
  type ContextSeries,
  type BacktestSignal,
} from "./backtest-engine";
import { evaluatePresetFilters, type FilterContext } from "./preset-filters";
import type { BacktestPreset } from "./backtest-presets";
import type { SimRules } from "./zone-simulator";
import { rawDateString } from "./format";

// ─── Types ─────────────────────────────────────────────────────────────────

/** A single deployed entry the engine is currently managing exits for.
 *  Captured at fill time (when liveState transitions from flat to in-position).
 *  Tracks just enough to evaluate BE / timed-exit / daily-exact rules. */
export interface ActiveEntry {
  direction: "Long" | "Short";
  entryPrice: number;
  /** Bar timestamp of the bar the entry order was sent on. Used to count
   *  bars-held for the timed exit rule. */
  entryBarTime: string;
  qty: number;
  /** ATR(14) at entry — feeds the SimRules ATR-adjust math the same way
   *  the simulator's `zoneAtr` does. Null when ATR hadn't warmed up. */
  zoneAtr: number | null;
  /** True once we've sent the BE modify_sl. Prevents repeat sends as price
   *  oscillates around the BE trigger. */
  beTriggered: boolean;
  /** Rolling peak favorable P&L since entry (points). Updated each bar. */
  peakPnl: number;
}

/** Engine state — all mutable bookkeeping in one shape so the hook can
 *  shallow-replace it on each decision. Designed to be JSON-serializable
 *  in case we want to persist sessions (not done in v1). */
export interface AutoTraderState {
  armed: boolean;
  /** The frozen snapshot of the deployed preset. We capture-by-value at
   *  arm time so editing/deleting the preset later doesn't mutate live
   *  trading behavior mid-session. */
  preset: BacktestPreset | null;
  /** YYYY-MM-DD of the current trading day for daily-limit / scaling-reset
   *  accounting. Cleared when armed; set on first processed bar; rolled
   *  forward when a new bar's day differs (resets daily counters). */
  dayKey: string | null;
  /** Cumulative scaledPoints realized today across closed trades. Compared
   *  against dailyStopLoss/TakeProfit thresholds. */
  dailyRealizedPoints: number;
  /** True once a daily threshold has been crossed today — blocks new
   *  entries until the day rolls over. */
  dailyHalted: boolean;
  /** Current size for the next entry order (scaling walk output). Starts
   *  at scalingStartSize when armed; updated after each closed trade. */
  nextEntrySize: number;
  /** Outcome of the last closed trade — drives the scaling step direction.
   *  null on first arm or when scaling is off. */
  lastTradeWasWin: boolean | null;
  /** The currently-managed entry (null when flat or before fill). */
  activeEntry: ActiveEntry | null;
  /** bar_time of the last bar we processed for new-signal detection.
   *  Used to debounce: bars upsert as they form, so we only trigger on a
   *  bar_time we haven't seen before. */
  lastProcessedBarTime: string | null;
  /** Recent activity log for the UI. Capped at 50 entries to bound memory. */
  log: LogEntry[];
}

/** Recent activity row for the UI status panel. */
export interface LogEntry {
  ts: number;
  level: "info" | "signal" | "trade" | "warn" | "error";
  message: string;
}

/** Actions returned by the engine for the hook to dispatch. Multiple
 *  actions per decision are supported (e.g. modify_sl + close in the same
 *  bar) so the hook can drain them in order. */
export type AutoTraderAction =
  | {
      kind: "buy_long";
      sl_points: number | null;
      tp_points: number | null;
      trail_enabled: boolean;
      qty: number;
      reason: string;
      /** bar_time of the signal bar — the hook stashes this so a later
       *  position-fill transition can be tagged to this exact entry. */
      entryBarTime: string;
      /** ATR(14) captured at the entry bar's snapshot. Carried through so
       *  the BE check uses the same effBe the simulator would. */
      zoneAtr: number | null;
    }
  | {
      kind: "sell_short";
      sl_points: number | null;
      tp_points: number | null;
      trail_enabled: boolean;
      qty: number;
      reason: string;
      entryBarTime: string;
      zoneAtr: number | null;
    }
  | { kind: "close"; reason: string }
  | { kind: "modify_sl"; price: number; reason: string };

export interface DecisionResult {
  state: AutoTraderState;
  actions: AutoTraderAction[];
}

// ─── Initial state ─────────────────────────────────────────────────────────

/** Build a fresh disarmed state. */
export function initialAutoTraderState(): AutoTraderState {
  return {
    armed: false,
    preset: null,
    dayKey: null,
    dailyRealizedPoints: 0,
    dailyHalted: false,
    nextEntrySize: 1,
    lastTradeWasWin: null,
    activeEntry: null,
    lastProcessedBarTime: null,
    log: [],
  };
}

/** Arm the engine with a preset. Resets all per-session counters so a
 *  re-arm always starts clean. */
export function armEngine(
  state: AutoTraderState,
  preset: BacktestPreset
): AutoTraderState {
  return {
    ...initialAutoTraderState(),
    armed: true,
    preset,
    nextEntrySize: preset.rules.scalingEnabled
      ? Math.max(1, Math.floor(preset.rules.scalingStartSize))
      : 1,
    log: appendLog(state.log, {
      level: "info",
      message: `Armed with preset "${preset.name}" (${preset.strategyId})`,
    }),
  };
}

/** Disarm — engine stops generating actions; existing position is left
 *  untouched (the user can manage it manually). */
export function disarmEngine(state: AutoTraderState): AutoTraderState {
  return {
    ...state,
    armed: false,
    activeEntry: null,
    log: appendLog(state.log, { level: "info", message: "Disarmed" }),
  };
}

// ─── Per-bar decision ──────────────────────────────────────────────────────

/** Inputs for `decideOnNewBar`. Decoupled from React shapes so the engine
 *  can be tested with synthetic data. */
export interface DecideOnNewBarInput {
  state: AutoTraderState;
  /** Full closed-bar history for the active instrument/timeframe, oldest
   *  first. The latest entry is the just-closed bar that triggered this
   *  decision call. */
  bars: LiveBar[];
  /** Current position state, or null when flat. */
  position: LiveState | null;
}

/** Main decision function — call once per newly-closed bar. Returns the
 *  next state and any actions to dispatch. Pure: no React, no DOM, no
 *  network. The hook is responsible for wiring actions to the live trader's
 *  existing buy/sell/close/modify callbacks. */
export function decideOnNewBar(input: DecideOnNewBarInput): DecisionResult {
  const { bars, position } = input;
  const initial = input.state;
  const actions: AutoTraderAction[] = [];

  // The LATEST bar in the live feed is always in-progress (its OHLC
  // updates as ticks arrive). The previous bar is the most recent FULLY
  // CLOSED one — that's what we evaluate signals on, mirroring the
  // backtest convention where every input bar is a closed bar. When a
  // new bar opens, the just-closed bar becomes our actionable target on
  // the next call here.
  const closedBars = bars.length > 1 ? bars.slice(0, -1) : [];
  const latestClosed = closedBars.at(-1);

  // Disarmed → no-op (but still mark this closed bar as "seen" so a
  // re-arm doesn't immediately fire on a bar that already closed).
  if (!initial.armed || !initial.preset) {
    return {
      state: {
        ...initial,
        lastProcessedBarTime: latestClosed?.bar_time ?? initial.lastProcessedBarTime,
      },
      actions,
    };
  }

  if (!latestClosed) return { state: initial, actions };

  // Debounce: same closed-bar we already processed → skip. The in-progress
  // bar getting an OHLC update doesn't change `latestClosed.bar_time`, so
  // intra-bar tick noise doesn't re-fire signals.
  if (initial.lastProcessedBarTime === latestClosed.bar_time) {
    return { state: initial, actions };
  }

  // Capture the preset once for narrowing — it's frozen for the duration
  // of this call (next bar will re-read state.preset). Same with rules.
  const preset = initial.preset;
  const rules = preset.rules;

  // Working copy of the bookkeeping fields we may mutate. Folded back
  // into a single new state object at every return so TS narrowing
  // never has to span reassignments.
  let dayKey = initial.dayKey;
  let dailyRealizedPoints = initial.dailyRealizedPoints;
  let dailyHalted = initial.dailyHalted;
  let nextEntrySize = initial.nextEntrySize;
  let lastTradeWasWin = initial.lastTradeWasWin;
  let activeEntry: ActiveEntry | null = initial.activeEntry;
  let log = initial.log;

  // Roll the day key forward when we cross midnight (or first bar after arm).
  const newDayKey = rawDateString(latestClosed.bar_time);
  if (dayKey !== newDayKey) {
    dayKey = newDayKey;
    dailyRealizedPoints = 0;
    dailyHalted = false;
    if (rules.scalingEnabled && rules.scalingResetDaily) {
      nextEntrySize = Math.max(1, Math.floor(rules.scalingStartSize));
      lastTradeWasWin = null;
    }
  }

  // Helper to fold the working copy into a fresh state object. Used at
  // every return path so we always emit a complete, narrowing-safe state.
  const buildState = (): AutoTraderState => ({
    armed: initial.armed,
    preset,
    dayKey,
    dailyRealizedPoints,
    dailyHalted,
    nextEntrySize,
    lastTradeWasWin,
    activeEntry,
    lastProcessedBarTime: latestClosed.bar_time,
    log,
  });

  // ── Active entry exit checks (BE / timed) ────────────────────────
  // Run BEFORE entry checks so a timed-exit + same-bar reversal fires in
  // the right order: close first, then the new entry on the next bar.
  if (activeEntry) {
    const ae = activeEntry;
    // Update peak P&L from this bar's high/low.
    const isLong = ae.direction === "Long";
    const highPnl = isLong
      ? latestClosed.bar_high - ae.entryPrice
      : ae.entryPrice - latestClosed.bar_low;
    const newPeak = highPnl > ae.peakPnl ? highPnl : ae.peakPnl;
    activeEntry = { ...ae, peakPnl: newPeak };

    // ── Break-Even SL move ──
    // When peak favorable PnL crosses effBe (base + ATR adjust × zoneAtr),
    // send modify_sl to entry price. Idempotent via beTriggered flag.
    if (rules.breakEvenEnabled && !activeEntry.beTriggered) {
      const atr = ae.zoneAtr != null && ae.zoneAtr > 0 ? ae.zoneAtr : 0;
      const effBe = Math.max(0, rules.breakEvenTrigger + rules.beAtrAdjust * atr);
      if (newPeak >= effBe) {
        actions.push({
          kind: "modify_sl",
          price: parseFloat(ae.entryPrice.toFixed(2)),
          reason: `BE triggered (peak ${newPeak.toFixed(2)} ≥ ${effBe.toFixed(2)})`,
        });
        activeEntry = { ...activeEntry, beTriggered: true };
        log = appendLog(log, {
          level: "trade",
          message: `BE → SL moved to entry @ ${ae.entryPrice.toFixed(2)}`,
        });
      }
    }

    // ── Timed exit ──
    // Count of CLOSED bars after the entry bar. Matches simulator's
    // `bar.bar_index >= timedExitBars - 1` semantics where bar_index is
    // 0-based from the entry bar.
    if (rules.timedExitEnabled) {
      // Count bars relative to the closed-bar series so the held count
      // never includes the in-progress live bar (which would otherwise
      // off-by-one the timed exit by one bar).
      const entryIdx = closedBars.findIndex((b) => b.bar_time === ae.entryBarTime);
      if (entryIdx >= 0) {
        const barsHeld = closedBars.length - 1 - entryIdx;
        if (barsHeld >= rules.timedExitBars - 1) {
          actions.push({
            kind: "close",
            reason: `Timed exit (held ${barsHeld + 1} bars, max ${rules.timedExitBars})`,
          });
          log = appendLog(log, {
            level: "trade",
            message: `Timed exit → close after ${barsHeld + 1} bars`,
          });
          // Don't clear activeEntry here — let the position-disappears
          // detector in the hook do it once the close actually fills.
          // Returning early avoids firing a new entry on the same bar.
          return { state: buildState(), actions };
        }
      }
    }
  }

  // ── Daily kill-switch (lazy mode — block new entries) ───────────
  // Exact mode is handled separately by the hook's tick interval.
  if (dailyHalted) {
    return { state: buildState(), actions };
  }

  // ── Strategy signal generation ───────────────────────────────────
  // Need full history every call — generators iterate from index 0. Cap
  // at a generous rolling buffer in the hook (e.g. 1000 bars) so the
  // ATR/EMA/ADX/Bollinger warmups have plenty of headroom.
  const strategy = STRATEGIES.find((s) => s.id === preset.strategyId);
  if (!strategy) {
    log = appendLog(log, {
      level: "error",
      message: `Unknown strategy "${preset.strategyId}" — disarming`,
    });
    return {
      state: { ...buildState(), armed: false },
      actions,
    };
  }

  const replayBars: ReplayBar[] = closedBars.map((b, i) => ({
    id: i,
    session_id: 0,
    bar_index: i,
    bar_time: b.bar_time,
    bar_open: b.bar_open,
    bar_high: b.bar_high,
    bar_low: b.bar_low,
    bar_close: b.bar_close,
    bar_volume: b.bar_volume,
  }));

  let signals: BacktestSignal[] = [];
  try {
    signals = strategy.generateSignals(replayBars, preset.params);
  } catch (e) {
    log = appendLog(log, {
      level: "error",
      message: `Strategy error: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { state: buildState(), actions };
  }

  // Only the signal at the just-closed bar is actionable (everything
  // earlier was already evaluated on a previous tick or pre-arm).
  const latestIdx = replayBars.length - 1;
  const signalNow = signals.find((s) => s.barIndex === latestIdx);
  if (!signalNow) {
    return { state: buildState(), actions };
  }

  // ── Filter evaluation ────────────────────────────────────────────
  // Build context series fresh from the rolling buffer so ATR/ADX/EMA/BB
  // values are exactly what backtest-engine.snapshotContext would see.
  const ctxSeries: ContextSeries = buildContextSeries(replayBars);
  const snapshot = snapshotContext(
    ctxSeries,
    replayBars[latestIdx].bar_close,
    latestIdx
  );

  const filterCtx: FilterContext = {
    ctx_atr14: snapshot.ctx_atr14,
    ctx_adx14: snapshot.ctx_adx14,
    ctx_price_vs_ema20: snapshot.ctx_price_vs_ema20,
    ctx_price_vs_ema200: snapshot.ctx_price_vs_ema200,
    ctx_bollinger_pos: snapshot.ctx_bollinger_pos,
  };

  if (
    !evaluatePresetFilters(filterCtx, preset.filters, signalNow.direction, latestClosed.bar_time)
  ) {
    log = appendLog(log, {
      level: "signal",
      message: `${signalNow.direction} signal filtered out`,
    });
    return { state: buildState(), actions };
  }

  // ── Position-mode gating ─────────────────────────────────────────
  // Decide whether the signal can fire given the current position state.
  // NT8 handles reversals natively when we send an opposite-direction
  // order while in position, so for "close-previous" / "add-close" we
  // can just send the order — NT8's order book does the right thing.
  const inPosition = position?.position_direction != null;
  const samedir =
    inPosition && position!.position_direction === signalNow.direction;
  const opposite = inPosition && !samedir;

  let canFire = true;
  switch (rules.positionMode) {
    case "default":
    case "null":
      canFire = !inPosition;
      break;
    case "add-null":
      canFire = !inPosition || samedir;
      break;
    case "close-previous":
    case "add-close":
      // close-previous: any new signal reverses or stacks; add-close is the
      // same in NT8 semantics (NT8 always closes opposite + opens new on
      // an opposite-direction order, and adds on same-direction). The
      // simulator-side distinction (close opposing vs close all) collapses
      // here because live trading is single-position-per-account.
      canFire = true;
      break;
    case "reverse-null":
      // Opposing → reverse the side (NT8 closes prior + opens new on an
      // opposite order). Same-direction → drop (caller does not re-enter).
      // Flat → fire normally.
      canFire = !inPosition || opposite;
      break;
    case "reverse-add":
      // Opposing → reverse; same-direction → add (stack); flat → fire.
      // NT8 handles all three natively from a plain entry order.
      canFire = true;
      break;
  }

  if (!canFire) {
    log = appendLog(log, {
      level: "signal",
      message: `${signalNow.direction} signal blocked (positionMode=${rules.positionMode}, ${samedir ? "same-dir" : opposite ? "opposite" : "flat"})`,
    });
    return { state: buildState(), actions };
  }

  // ── Build the entry order ────────────────────────────────────────
  // SL/TP/Trail come from the SimRules with the same ATR-adjust as the
  // simulator: effective = base + atrAdjust × zoneAtr (zoneAtr = ctx_atr14).
  const zoneAtr = snapshot.ctx_atr14;
  const atr = zoneAtr != null && zoneAtr > 0 ? zoneAtr : 0;
  const effSl = rules.stopLossEnabled
    ? Math.max(0, rules.stopLossPoints + rules.slAtrAdjust * atr)
    : null;
  const effTp = rules.takeProfitEnabled
    ? Math.max(0, rules.takeProfitPoints + rules.tpAtrAdjust * atr)
    : null;
  const trail = rules.trailingStopEnabled;

  const qty = Math.max(1, Math.floor(nextEntrySize));

  const reason = `${preset.strategyId} ${signalNow.direction} @ bar ${latestIdx} (ATR=${atr.toFixed(2)})`;

  if (signalNow.direction === "Long") {
    actions.push({
      kind: "buy_long",
      sl_points: effSl,
      tp_points: effTp,
      trail_enabled: trail,
      qty,
      reason,
      entryBarTime: latestClosed.bar_time,
      zoneAtr,
    });
  } else {
    actions.push({
      kind: "sell_short",
      sl_points: effSl,
      tp_points: effTp,
      trail_enabled: trail,
      qty,
      reason,
      entryBarTime: latestClosed.bar_time,
      zoneAtr,
    });
  }

  log = appendLog(log, {
    level: "trade",
    message: `Entry ${signalNow.direction} qty=${qty} SL=${effSl?.toFixed(1) ?? "off"} TP=${effTp?.toFixed(1) ?? "off"}${trail ? " TRAIL" : ""}`,
  });

  return { state: buildState(), actions };
}

// ─── Position lifecycle hooks ──────────────────────────────────────────────
// The hook calls these when liveState transitions are observed.

export interface OnFilledInput {
  state: AutoTraderState;
  /** The bar that the entry order was sent on (latest closed bar at order
   *  time). Used to seed entryBarTime for the timed-exit clock. */
  entryBarTime: string;
  position: LiveState;
  /** ATR(14) at the entry bar — captured from the same snapshot the entry
   *  decision used. Required for ATR-adjust on BE. */
  zoneAtr: number | null;
}

/** Register an active entry once a fill is observed. Called from the hook
 *  when liveState transitions from flat to in-position AFTER an engine
 *  entry action was dispatched on the latest bar. */
export function onPositionFilled(input: OnFilledInput): AutoTraderState {
  const { state, position, entryBarTime, zoneAtr } = input;
  if (!state.armed) return state;
  return {
    ...state,
    activeEntry: {
      direction: position.position_direction!,
      entryPrice: position.position_entry_price,
      entryBarTime,
      qty: position.position_quantity || 1,
      zoneAtr,
      beTriggered: false,
      peakPnl: 0,
    },
    log: appendLog(state.log, {
      level: "trade",
      message: `Filled ${position.position_direction} ${position.position_quantity} @ ${position.position_entry_price.toFixed(2)}`,
    }),
  };
}

export interface OnClosedInput {
  state: AutoTraderState;
  /** Realized P&L of the trade in points (per-contract). The hook computes
   *  this from entry price + last seen exit/fill price; falls back to the
   *  position's unrealized_pnl-at-close when available. */
  exitPoints: number;
  /** Quantity that was on at close — used to walk daily realized via
   *  scaledPoints = exitPoints × qty (mirrors the simulator). */
  qty: number;
}

/** Update daily/scaling counters on close. Called by the hook when
 *  liveState transitions from in-position to flat. */
export function onPositionClosed(input: OnClosedInput): AutoTraderState {
  const { state, exitPoints, qty } = input;
  if (!state.armed || !state.preset) return state;
  const rules = state.preset.rules;

  const scaledPoints = exitPoints * Math.max(1, qty);
  const isWin = exitPoints > 0;

  // ── Update scaling walk for next entry ──
  // additive walk +winStep on win, −lossStep on loss, clamped [min,max].
  let nextSize = state.nextEntrySize;
  if (rules.scalingEnabled) {
    const step = isWin
      ? Math.max(0, Math.floor(rules.scalingWinStep))
      : -Math.max(0, Math.floor(rules.scalingLossStep));
    const desired = Math.floor(state.nextEntrySize) + step;
    nextSize = clamp(
      desired,
      Math.max(1, Math.floor(rules.scalingMinSize)),
      Math.max(1, Math.floor(rules.scalingMaxSize))
    );
  }

  // ── Daily realized + halt check ──
  const newDailyRealized = state.dailyRealizedPoints + scaledPoints;
  let dailyHalted = state.dailyHalted;
  if (rules.dailyTakeProfitEnabled && newDailyRealized >= rules.dailyTakeProfitPoints) {
    dailyHalted = true;
  }
  if (rules.dailyStopLossEnabled && newDailyRealized <= -rules.dailyStopLossPoints) {
    dailyHalted = true;
  }

  return {
    ...state,
    activeEntry: null,
    nextEntrySize: nextSize,
    lastTradeWasWin: isWin,
    dailyRealizedPoints: newDailyRealized,
    dailyHalted,
    log: appendLog(state.log, {
      level: "trade",
      message: `Closed ${isWin ? "WIN" : "LOSS"} ${exitPoints.toFixed(2)}pts × ${qty} = ${scaledPoints.toFixed(2)} (day: ${newDailyRealized.toFixed(2)})${dailyHalted ? " — DAILY HALT" : ""}`,
    }),
  };
}

// ─── Daily exact-mode tick check ───────────────────────────────────────────

/** Evaluate the dailyLimitExactMode kill — runs on every bar (or tick if
 *  the hook chooses) with the current position's unrealized PnL. When the
 *  cumulative day PnL (realized + unrealized × qty) crosses a threshold,
 *  emit a close action so the simulator's "force-close in flight" behavior
 *  is replicated. Only active when both dailyLimitExactMode is on and one
 *  of dailyStopLoss / dailyTakeProfit is enabled. */
export function checkDailyExact(
  state: AutoTraderState,
  position: LiveState | null,
  lastPrice: number | null
): AutoTraderAction | null {
  if (!state.armed || !state.preset || !state.activeEntry) return null;
  const rules = state.preset.rules;
  if (!rules.dailyLimitExactMode) return null;
  if (!rules.dailyStopLossEnabled && !rules.dailyTakeProfitEnabled) return null;
  if (!position?.position_direction || lastPrice == null) return null;

  const isLong = position.position_direction === "Long";
  const unrealizedPts = isLong
    ? lastPrice - position.position_entry_price
    : position.position_entry_price - lastPrice;
  const qty = position.position_quantity || 1;
  const dayPnl = state.dailyRealizedPoints + unrealizedPts * qty;

  if (rules.dailyTakeProfitEnabled && dayPnl >= rules.dailyTakeProfitPoints) {
    return { kind: "close", reason: `Daily TP exact (day=${dayPnl.toFixed(2)})` };
  }
  if (rules.dailyStopLossEnabled && dayPnl <= -rules.dailyStopLossPoints) {
    return { kind: "close", reason: `Daily SL exact (day=${dayPnl.toFixed(2)})` };
  }
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Append to the log and trim to the most recent 50 entries. The cap keeps
 *  long sessions from leaking memory while still preserving enough history
 *  for the user to reconstruct what fired today. */
function appendLog(log: LogEntry[], entry: Omit<LogEntry, "ts">): LogEntry[] {
  const next = [...log, { ...entry, ts: Date.now() }];
  if (next.length > 50) return next.slice(next.length - 50);
  return next;
}

/** Read the SimRules in case the engine consumer wants to display effective
 *  exit thresholds for the current entry. Re-exported as a convenience. */
export type { SimRules };
