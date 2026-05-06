/**
 * Practice Trading Engine — Pure TypeScript state machine for managing
 * practice trades during market replay.
 *
 * Handles position entry/exit, SL/TP processing on each new bar, and
 * running P&L tracking. Max 1 open position at a time.
 *
 * Reuses the OHLC path heuristic from zone-simulator.ts:
 *   - Bullish bars (close >= open): assume O → L → H → C (adverse first)
 *   - Bearish bars (close < open): assume O → H → L → C (favorable first)
 * This determines whether SL or TP is checked first within a bar.
 */

import { ReplayBar } from "@/types/replay";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PracticePosition {
  /** Client-generated unique ID */
  id: string;
  direction: "Long" | "Short";
  entryPrice: number;
  entryBarIndex: number;
  entryTime: string;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  status: "open" | "closed";
  exitPrice?: number;
  exitBarIndex?: number;
  exitTime?: string;
  exitReason?: "manual" | "sl" | "tp" | "session_end";
  pnlPoints?: number;
}

export interface PracticeTradingState {
  /** All positions (open + closed) */
  positions: PracticePosition[];
  /** Currently open position (null if flat) */
  openPosition: PracticePosition | null;
  /** Running total P&L from closed positions */
  totalPnl: number;
  /** Win/loss counters */
  winCount: number;
  lossCount: number;
}

// ─── State Factory ──────────────────────────────────────────────────────────

export function createPracticeTradingState(): PracticeTradingState {
  return {
    positions: [],
    openPosition: null,
    totalPnl: 0,
    winCount: 0,
    lossCount: 0,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a simple unique ID for positions */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Calculate P&L in points given direction */
function calcPnl(direction: "Long" | "Short", entryPrice: number, exitPrice: number): number {
  return direction === "Long"
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
}

/**
 * Close an open position and update state totals.
 * Returns new state with the position closed.
 */
function closePosition(
  state: PracticeTradingState,
  exitPrice: number,
  exitBarIndex: number,
  exitTime: string,
  exitReason: "manual" | "sl" | "tp" | "session_end"
): PracticeTradingState {
  const pos = state.openPosition;
  if (!pos) return state;

  const pnl = Math.round(calcPnl(pos.direction, pos.entryPrice, exitPrice) * 100) / 100;
  const isWin = pnl > 0;

  const closedPos: PracticePosition = {
    ...pos,
    status: "closed",
    exitPrice,
    exitBarIndex,
    exitTime,
    exitReason,
    pnlPoints: pnl,
  };

  // Replace the open position in the positions array with the closed version
  const updatedPositions = state.positions.map((p) =>
    p.id === pos.id ? closedPos : p
  );

  return {
    positions: updatedPositions,
    openPosition: null,
    totalPnl: Math.round((state.totalPnl + pnl) * 100) / 100,
    winCount: state.winCount + (isWin ? 1 : 0),
    lossCount: state.lossCount + (pnl < 0 ? 1 : 0),
  };
}

// ─── User Actions ───────────────────────────────────────────────────────────

/** Enter a long position at the given price */
export function enterLong(
  state: PracticeTradingState,
  price: number,
  barIndex: number,
  barTime: string,
  slPrice?: number,
  tpPrice?: number
): PracticeTradingState {
  // Can't enter if already in a position
  if (state.openPosition) return state;

  const position: PracticePosition = {
    id: generateId(),
    direction: "Long",
    entryPrice: price,
    entryBarIndex: barIndex,
    entryTime: barTime,
    stopLossPrice: slPrice ?? null,
    takeProfitPrice: tpPrice ?? null,
    status: "open",
  };

  return {
    ...state,
    positions: [...state.positions, position],
    openPosition: position,
  };
}

/** Enter a short position at the given price */
export function enterShort(
  state: PracticeTradingState,
  price: number,
  barIndex: number,
  barTime: string,
  slPrice?: number,
  tpPrice?: number
): PracticeTradingState {
  if (state.openPosition) return state;

  const position: PracticePosition = {
    id: generateId(),
    direction: "Short",
    entryPrice: price,
    entryBarIndex: barIndex,
    entryTime: barTime,
    stopLossPrice: slPrice ?? null,
    takeProfitPrice: tpPrice ?? null,
    status: "open",
  };

  return {
    ...state,
    positions: [...state.positions, position],
    openPosition: position,
  };
}

/** Manually exit the open position at the given price */
export function exitPosition(
  state: PracticeTradingState,
  price: number,
  barIndex: number,
  barTime: string
): PracticeTradingState {
  if (!state.openPosition) return state;
  return closePosition(state, price, barIndex, barTime, "manual");
}

/** Close all positions at session end */
export function closeAtSessionEnd(
  state: PracticeTradingState,
  price: number,
  barIndex: number,
  barTime: string
): PracticeTradingState {
  if (!state.openPosition) return state;
  return closePosition(state, price, barIndex, barTime, "session_end");
}

/** Update the stop loss price on the open position */
export function updateStopLoss(
  state: PracticeTradingState,
  slPrice: number | null
): PracticeTradingState {
  if (!state.openPosition) return state;

  const updated = { ...state.openPosition, stopLossPrice: slPrice };
  return {
    ...state,
    openPosition: updated,
    positions: state.positions.map((p) => (p.id === updated.id ? updated : p)),
  };
}

/** Update the take profit price on the open position */
export function updateTakeProfit(
  state: PracticeTradingState,
  tpPrice: number | null
): PracticeTradingState {
  if (!state.openPosition) return state;

  const updated = { ...state.openPosition, takeProfitPrice: tpPrice };
  return {
    ...state,
    openPosition: updated,
    positions: state.positions.map((p) => (p.id === updated.id ? updated : p)),
  };
}

// ─── Bar Processing ─────────────────────────────────────────────────────────

/**
 * Process a newly revealed bar — check if SL or TP was hit.
 *
 * Uses the OHLC path heuristic from zone-simulator.ts to determine
 * which price extreme was reached first within the bar:
 *   - Bullish bars (close >= open): O → L → H → C — check SL before TP
 *   - Bearish bars (close < open): O → H → L → C — check TP before SL
 *
 * For Long positions: SL is below entry, TP is above entry
 * For Short positions: SL is above entry, TP is below entry
 */
export function processBar(
  state: PracticeTradingState,
  bar: ReplayBar
): PracticeTradingState {
  const pos = state.openPosition;
  if (!pos) return state;

  // Don't check the entry bar itself — entry happens at that bar's close,
  // so only subsequent bars can trigger SL/TP
  if (bar.bar_index <= pos.entryBarIndex) return state;

  const sl = pos.stopLossPrice;
  const tp = pos.takeProfitPrice;

  // If no SL or TP set, nothing to check
  if (sl === null && tp === null) return state;

  const isBullishBar = bar.bar_close >= bar.bar_open;

  // Determine if SL/TP were hit within this bar
  let slHit = false;
  let tpHit = false;

  if (pos.direction === "Long") {
    // Long: SL triggers when price drops to or below SL level
    if (sl !== null) slHit = bar.bar_low <= sl;
    // Long: TP triggers when price rises to or above TP level
    if (tp !== null) tpHit = bar.bar_high >= tp;
  } else {
    // Short: SL triggers when price rises to or above SL level
    if (sl !== null) slHit = bar.bar_high >= sl;
    // Short: TP triggers when price drops to or below TP level
    if (tp !== null) tpHit = bar.bar_low <= tp;
  }

  // If neither hit, no action needed
  if (!slHit && !tpHit) return state;

  // If both hit within the same bar, use the OHLC path heuristic
  // to determine which was hit first
  if (slHit && tpHit) {
    if (pos.direction === "Long") {
      // Long: bullish bar (O→L→H→C) = SL first; bearish bar (O→H→L→C) = TP first
      if (isBullishBar) {
        return closePosition(state, sl!, bar.bar_index, bar.bar_time, "sl");
      } else {
        return closePosition(state, tp!, bar.bar_index, bar.bar_time, "tp");
      }
    } else {
      // Short: bullish bar (O→L→H→C) = TP first; bearish bar (O→H→L→C) = SL first
      if (isBullishBar) {
        return closePosition(state, tp!, bar.bar_index, bar.bar_time, "tp");
      } else {
        return closePosition(state, sl!, bar.bar_index, bar.bar_time, "sl");
      }
    }
  }

  // Only one hit
  if (slHit) {
    return closePosition(state, sl!, bar.bar_index, bar.bar_time, "sl");
  }
  return closePosition(state, tp!, bar.bar_index, bar.bar_time, "tp");
}
