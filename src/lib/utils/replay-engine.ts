/**
 * Replay Engine — Pure TypeScript state machine for bar-by-bar playback.
 *
 * No React, no side effects. The React component drives this via useReducer
 * and a setInterval that dispatches stepForward at the configured speed.
 *
 * Design mirrors zone-simulator.ts: pure functions operating on immutable state.
 */

import { ReplayBar } from "@/types/replay";

// ─── State ──────────────────────────────────────────────────────────────────

export interface ReplayState {
  /** All bars for the session, ordered by bar_index */
  bars: ReplayBar[];
  /** How many bars are currently visible (0 = none, bars.length = all) */
  currentIndex: number;
  /** Whether playback is actively advancing */
  isPlaying: boolean;
  /** Playback speed in bars per second */
  speed: number;
}

/** Available playback speeds */
export const REPLAY_SPEEDS = [1, 2, 4, 8, 16, 32] as const;

// ─── Derived Helpers ────────────────────────────────────────────────────────

/** Get bars visible so far (bars[0..currentIndex-1]) */
export function getVisibleBars(state: ReplayState): ReplayBar[] {
  return state.bars.slice(0, state.currentIndex);
}

/** Get the most recently revealed bar, or null if none */
export function getCurrentBar(state: ReplayState): ReplayBar | null {
  if (state.currentIndex === 0) return null;
  return state.bars[state.currentIndex - 1];
}

/** Progress as 0-1 fraction */
export function getProgress(state: ReplayState): number {
  if (state.bars.length === 0) return 0;
  return state.currentIndex / state.bars.length;
}

/** Whether all bars have been revealed */
export function isAtEnd(state: ReplayState): boolean {
  return state.currentIndex >= state.bars.length;
}

/** Whether we're at the very beginning */
export function isAtStart(state: ReplayState): boolean {
  return state.currentIndex === 0;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type ReplayAction =
  | { type: "STEP_FORWARD" }
  | { type: "STEP_BACKWARD" }
  | { type: "JUMP_TO"; index: number }
  | { type: "SET_SPEED"; speed: number }
  | { type: "TOGGLE_PLAY" }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "RESET" };

// ─── State Factory ──────────────────────────────────────────────────────────

/** Create initial replay state from a set of bars */
export function createReplayState(bars: ReplayBar[]): ReplayState {
  return {
    bars,
    currentIndex: 0,
    isPlaying: false,
    speed: 2,
  };
}

// ─── Reducer ────────────────────────────────────────────────────────────────

/**
 * Pure reducer for replay state. Use with React's useReducer.
 * Each action returns a new state object (no mutations).
 */
export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "STEP_FORWARD": {
      if (state.currentIndex >= state.bars.length) {
        // Already at end — auto-pause
        return { ...state, isPlaying: false };
      }
      const nextIndex = state.currentIndex + 1;
      // Auto-pause if we just revealed the last bar
      const shouldPause = nextIndex >= state.bars.length;
      return {
        ...state,
        currentIndex: nextIndex,
        isPlaying: shouldPause ? false : state.isPlaying,
      };
    }

    case "STEP_BACKWARD": {
      if (state.currentIndex <= 0) return state;
      return {
        ...state,
        currentIndex: state.currentIndex - 1,
        isPlaying: false, // Always pause on manual step back
      };
    }

    case "JUMP_TO": {
      const clamped = Math.max(0, Math.min(action.index, state.bars.length));
      return {
        ...state,
        currentIndex: clamped,
        isPlaying: false, // Pause on random access
      };
    }

    case "SET_SPEED": {
      return { ...state, speed: action.speed };
    }

    case "TOGGLE_PLAY": {
      // Don't allow play if already at end
      if (!state.isPlaying && state.currentIndex >= state.bars.length) {
        return state;
      }
      return { ...state, isPlaying: !state.isPlaying };
    }

    case "PLAY": {
      if (state.currentIndex >= state.bars.length) return state;
      return { ...state, isPlaying: true };
    }

    case "PAUSE": {
      return { ...state, isPlaying: false };
    }

    case "RESET": {
      return { ...state, currentIndex: 0, isPlaying: false };
    }

    default:
      return state;
  }
}
