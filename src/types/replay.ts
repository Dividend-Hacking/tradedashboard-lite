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

/**
 * Granularity of an exported session. Drives both how the data was fetched
 * from NT8 and where it lives:
 *   - 'ohlcv'        — bars in replay_bars, no bid/ask split (existing path)
 *   - 'ohlcv_bidask' — bars in replay_bars + bar_volume_bid/ask populated
 *   - 'tick'         — every trade in a gzipped CSV blob in Storage; side=null
 *   - 'tick_bidask'  — same as 'tick' but each row has side='bid'|'ask'|null
 */
export type Granularity = "ohlcv" | "ohlcv_bidask" | "tick" | "tick_bidask";

/** One exported data set — a specific instrument/timeframe/date from NinjaTrader */
export interface ReplaySession {
  id: number;
  instrument: string;
  timeframe: string;        // e.g. "1 Minute", "5 Minute", "15 Second", "1 Second", "Tick"
  session_date: string;     // ISO date string (YYYY-MM-DD)
  start_time: string;       // ISO timestamptz of first bar/tick
  end_time: string;         // ISO timestamptz of last bar/tick
  bar_count: number;        // bar count for OHLCV sessions; 0 for pure tick sessions
  last_bar_index: number;   // last viewed bar position (0 = never started)
  notes: string | null;
  created_at: string;
  granularity: Granularity;
  /** Storage path under the `replay-ticks` bucket, e.g. "session-1234.csv.gz".
   *  Populated only for 'tick' / 'tick_bidask' granularities. */
  tick_blob_path: string | null;
  /** Number of ticks in the blob. Separate from bar_count to keep semantics clean. */
  tick_count: number | null;
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
  /** Sell-aggressor volume for this bar — populated for 'ohlcv_bidask' only. */
  bar_volume_bid: number | null;
  /** Buy-aggressor volume for this bar — populated for 'ohlcv_bidask' only. */
  bar_volume_ask: number | null;
}

/**
 * Single trade row inside a tick CSV blob. Rows are stored gzipped in Supabase
 * Storage rather than Postgres because a busy session is 3-8M trades. The web
 * client downloads + parses the blob on demand for footprint/volume-profile
 * charts. NOT a database row — this type describes one parsed CSV line.
 */
export interface ReplayTick {
  tick_index: number;
  tick_time: string;        // ISO timestamptz with millisecond precision
  price: number;
  size: number;
  /** Aggressor side: 'bid' = sell-aggressor, 'ask' = buy-aggressor.
   *  null when the data feed didn't classify the trade or the granularity
   *  is plain 'tick' (no side attribution requested). */
  side: "bid" | "ask" | null;
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
  /** Lifecycle:
   *    pending → processing → completed   (happy path)
   *    pending → processing → error       (transient — auto-retried)
   *    pending → processing → no_data     (terminal — broker has no bars
   *                                        for this date, e.g. holiday
   *                                        we missed or pre-contract date) */
  status: "pending" | "processing" | "completed" | "error" | "no_data";
  error_message: string | null;
  replay_session_id: number | null;
  created_at: string;
  updated_at: string;
  /** Which data variant was requested. NT8's DataExporter polls this field
   *  to decide whether to run a single Last BarsRequest, three parallel
   *  Last/Bid/Ask requests for bid/ask split, or a tick request. */
  granularity: Granularity;
  /** Number of times the sweeper has reset this row (stuck `processing`
   *  or transient `error`). Stops auto-retrying at 3. */
  retry_count: number;
  /** Set when NT8 PATCHes the row to `processing`; nulled on terminal
   *  status. Sweeper compares against `now - 10min` to detect crashes. */
  claimed_at: string | null;
}

/** Summary counts shown in the queue banner (server-rendered on first paint
 *  so the page survives a refresh without a flash of empty state). */
export interface DataRequestQueueSummary {
  completed: number;
  pending: number;
  processing: number;
  errored: number;
  /** Days the broker confirmed have no bars (terminal). Distinguished from
   *  `errored` so the user isn't pushed to retry something that won't ever
   *  succeed, and the sweeper leaves them alone. */
  noData: number;
  /** Most recent updated_at across all rows; null if the table is empty. */
  lastActivityAt: string | null;
}
