/**
 * Type definitions for the Market Replay & Practice Trading tool.
 *
 * Maps to four Supabase tables:
 *   - replay_sessions: exported bar data sets from NinjaTrader
 *   - replay_bars: OHLCV bars within a session
 *   - practice_sessions: individual practice attempts on a replay session
 *   - practice_trades: trades made during a practice session
 */

// ─── Replay Data (from NT8 export) ─────────────────────────────────────────

/** One exported data set — a specific instrument/timeframe/date from NinjaTrader */
export interface ReplaySession {
  id: number;
  instrument: string;
  timeframe: string;        // e.g. "1 Minute", "5 Minute", "15 Second"
  session_date: string;     // ISO date string (YYYY-MM-DD)
  start_time: string;       // ISO timestamptz of first bar
  end_time: string;         // ISO timestamptz of last bar
  bar_count: number;
  last_bar_index: number;   // last viewed bar position (0 = never started)
  notes: string | null;
  created_at: string;
}

/** Single OHLCV bar within a replay session */
export interface ReplayBar {
  id: number;
  session_id: number;
  bar_index: number;        // 0-based sequential position
  bar_time: string;         // ISO timestamptz — bar open time
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
}

// ─── Practice Data (user's practice trading results) ────────────────────────

/** One practice attempt on a replay session */
export interface PracticeSession {
  id: number;
  replay_session_id: number;
  started_at: string;
  ended_at: string | null;
  total_pnl_points: number;
  total_trades: number;
  win_count: number;
  loss_count: number;
  notes: string | null;
  created_at: string;
}

/** Single trade within a practice session */
export interface PracticeTrade {
  id: number;
  practice_session_id: number;
  direction: "Long" | "Short";
  entry_bar_index: number;
  entry_price: number;
  exit_bar_index: number | null;
  exit_price: number | null;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  pnl_points: number | null;
  exit_reason: "manual" | "sl" | "tp" | "session_end" | null;
  entry_time: string;
  exit_time: string | null;
  created_at: string;
}

// ─── Data Requests (web → NT8 on-demand export) ────────────────────────────

/** On-demand data export request — inserted by web, processed by NT8 */
export interface DataRequest {
  id: number;
  instrument: string;
  timeframe: string;
  session_date: string;
  status: "pending" | "processing" | "completed" | "error";
  error_message: string | null;
  replay_session_id: number | null;
  created_at: string;
  updated_at: string;
}
