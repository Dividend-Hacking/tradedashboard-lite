/**
 * useAutoTrader
 *
 * React hook that wires the pure auto-trader engine to live trader state.
 *
 * Responsibilities:
 *   - Owns the engine state (arm/disarm, daily counters, active entry,
 *     activity log).
 *   - Watches the rolling `bars` array; when a new bar_time appears, calls
 *     `decideOnNewBar` once and dispatches the returned actions through
 *     the live trader's existing buy/sell/close/modify-sl callbacks.
 *   - Watches `position` for fill / close transitions, registering the
 *     active entry on fill and rolling the daily-realized + scaling
 *     counters on close.
 *   - When the deployed preset has dailyLimitExactMode on, runs a
 *     low-frequency interval that checks intra-bar P&L against the daily
 *     thresholds and fires a `close` action when crossed.
 *
 * The engine itself is pure logic — see auto-trader-engine.ts. This hook is
 * the only place that touches React state, callbacks, or DOM.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveBar, LiveState } from "@/types/live";
import type { BacktestPreset } from "@/lib/utils/backtest-presets";
import {
  initialAutoTraderState,
  armEngine,
  disarmEngine,
  decideOnNewBar,
  onPositionFilled,
  onPositionClosed,
  checkDailyExact,
  type AutoTraderState,
} from "@/lib/utils/auto-trader-engine";

interface UseAutoTraderArgs {
  bars: LiveBar[];
  position: LiveState | null;
  lastPrice: number | null;
  /** Optional ref to the latest tick price — when present, used in
   *  preference to lastPrice for the daily-exact check so the kill-switch
   *  reacts at WS-tick latency rather than 250ms React-state cadence. */
  tickPriceRef?: React.RefObject<number | null>;
  onBuyLong: (sl: number | null, tp: number | null, trail: boolean, qty: number) => Promise<void> | void;
  onSellShort: (sl: number | null, tp: number | null, trail: boolean, qty: number) => Promise<void> | void;
  onClose: () => Promise<void> | void;
  onModifySl: (newPrice: number) => Promise<void> | void;
}

export function useAutoTrader({
  bars,
  position,
  lastPrice,
  tickPriceRef,
  onBuyLong,
  onSellShort,
  onClose,
  onModifySl,
}: UseAutoTraderArgs) {
  const [state, setState] = useState<AutoTraderState>(() => initialAutoTraderState());

  // Stable refs to handlers so the per-bar effect doesn't have to re-bind
  // every render. The effect's deps are intentionally just bars/position —
  // we don't want a re-render of an unrelated handler to re-fire decisions.
  // Refs are updated in an effect (not during render) per react-hooks/refs.
  const handlersRef = useRef({ onBuyLong, onSellShort, onClose, onModifySl });
  useEffect(() => {
    handlersRef.current = { onBuyLong, onSellShort, onClose, onModifySl };
  }, [onBuyLong, onSellShort, onClose, onModifySl]);

  // Pending entry context — captured when an entry action fires so we can
  // tag the eventual fill (next position transition) with the right
  // entryBarTime + zoneAtr. NT8 fills are usually <500ms but a few seconds
  // is the practical worst case (during fast markets).
  const pendingEntryRef = useRef<{
    barTime: string;
    zoneAtr: number | null;
    direction: "Long" | "Short";
  } | null>(null);

  // Track the previous position to detect transitions (flat→pos / pos→flat).
  const prevPositionRef = useRef<LiveState | null>(null);

  // Always-current state ref for use inside intervals where setState
  // closures would be stale. Updated in an effect to satisfy react-hooks/refs.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ── Per-bar decision loop ──────────────────────────────────────────
  // Triggered whenever bars or position change. The engine internally
  // debounces by bar_time so re-renders that don't bring a new closed
  // bar are no-ops.
  useEffect(() => {
    if (!stateRef.current.armed) return;
    const decision = decideOnNewBar({
      state: stateRef.current,
      bars,
      position,
    });

    // Even when no actions, the state may have advanced lastProcessedBarTime
    // or appended a "filtered out" log entry — commit it.
    setState(decision.state);

    for (const action of decision.actions) {
      switch (action.kind) {
        case "buy_long":
          pendingEntryRef.current = {
            barTime: action.entryBarTime,
            zoneAtr: action.zoneAtr,
            direction: "Long",
          };
          handlersRef.current.onBuyLong(
            action.sl_points,
            action.tp_points,
            action.trail_enabled,
            action.qty
          );
          break;
        case "sell_short":
          pendingEntryRef.current = {
            barTime: action.entryBarTime,
            zoneAtr: action.zoneAtr,
            direction: "Short",
          };
          handlersRef.current.onSellShort(
            action.sl_points,
            action.tp_points,
            action.trail_enabled,
            action.qty
          );
          break;
        case "close":
          handlersRef.current.onClose();
          break;
        case "modify_sl":
          handlersRef.current.onModifySl(action.price);
          break;
      }
    }
  }, [bars, position]);

  // ── Position lifecycle detection ───────────────────────────────────
  // Detect flat→position (fill) and position→flat (close). The transitions
  // are computed from the previous render's position so we don't double-fire
  // on incremental state updates (e.g. brackets refresh).
  useEffect(() => {
    const prev = prevPositionRef.current;
    const wasFlat = !prev?.position_direction;
    const isFlat = !position?.position_direction;

    if (!stateRef.current.armed) {
      prevPositionRef.current = position;
      return;
    }

    // ── Fill detected ──
    if (wasFlat && !isFlat && position) {
      // Only register as the engine's entry if we were expecting one. A
      // user-initiated manual entry while armed is intentionally NOT tracked
      // by the engine (BE/timer/scaling won't fire on it). This prevents
      // confusion if the user clicks Buy while the engine is also armed.
      if (pendingEntryRef.current) {
        const pending = pendingEntryRef.current;
        // If the actual fill direction matches what we requested, use the
        // pending context. Mismatches (rare — would mean NT8 reversed an
        // existing position the engine didn't know about) fall back to
        // tracking from this bar's data.
        const entryBarTime =
          pending.direction === position.position_direction
            ? pending.barTime
            : bars.at(-1)?.bar_time ?? new Date().toISOString();

        setState((s) =>
          onPositionFilled({
            state: s,
            position,
            entryBarTime,
            zoneAtr: pending.zoneAtr,
          })
        );
        pendingEntryRef.current = null;
      }
    }

    // ── Close detected ──
    if (!wasFlat && isFlat && stateRef.current.activeEntry) {
      const ae = stateRef.current.activeEntry;
      // Realized P&L: best estimate is the last seen price minus entry,
      // direction-adjusted. NT8 will publish a final state with
      // unrealized_pnl reset to 0 and position_direction null, so we use
      // the last known price ref for accuracy.
      const exitPrice =
        tickPriceRef?.current ?? lastPrice ?? prev?.position_entry_price ?? ae.entryPrice;
      const isLong = ae.direction === "Long";
      const exitPoints = isLong
        ? exitPrice - ae.entryPrice
        : ae.entryPrice - exitPrice;
      setState((s) =>
        onPositionClosed({ state: s, exitPoints, qty: ae.qty })
      );
    }

    prevPositionRef.current = position;
  }, [position, bars, lastPrice, tickPriceRef]);

  // ── Daily exact-mode tick ──────────────────────────────────────────
  // Light 1Hz interval that checks day-cumulative PnL (realized +
  // unrealized × qty) against the daily thresholds. Only spins up when
  // the deployed preset has dailyLimitExactMode on AND a daily limit
  // enabled, so disarmed / lazy-mode sessions cost nothing.
  useEffect(() => {
    const rules = state.preset?.rules;
    if (
      !state.armed ||
      !rules?.dailyLimitExactMode ||
      (!rules.dailyStopLossEnabled && !rules.dailyTakeProfitEnabled)
    ) {
      return;
    }
    const id = window.setInterval(() => {
      const action = checkDailyExact(
        stateRef.current,
        position,
        tickPriceRef?.current ?? lastPrice
      );
      if (action) {
        handlersRef.current.onClose();
        setState((s) => ({
          ...s,
          dailyHalted: true,
          log: [
            ...s.log,
            { ts: Date.now(), level: "warn" as const, message: action.reason },
          ].slice(-50),
        }));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [
    state.armed,
    state.preset?.rules.dailyLimitExactMode,
    state.preset?.rules.dailyStopLossEnabled,
    state.preset?.rules.dailyTakeProfitEnabled,
    state.preset,
    position,
    lastPrice,
    tickPriceRef,
  ]);

  // ── Public API ──────────────────────────────────────────────────────
  const arm = useCallback((preset: BacktestPreset) => {
    setState((s) => armEngine(s, preset));
    pendingEntryRef.current = null;
  }, []);

  const disarm = useCallback(() => {
    setState((s) => disarmEngine(s));
    pendingEntryRef.current = null;
  }, []);

  return { state, arm, disarm };
}
