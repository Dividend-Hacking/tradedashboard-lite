/**
 * ReplayRepo — covers replay_sessions, replay_bars, data_requests, and
 * the tick blob storage. Together these implement the "downloaded days"
 * surface area that local mode needs to mirror.
 *
 * Tick blob URL handling: cloud returns a Supabase Storage signed URL;
 * local returns a path to /api/local/replay-ticks/<blob>?token=… that
 * streams the gzipped CSV from disk. Both look the same to the chart
 * client (just a URL it fetches and decompresses).
 */

import type {
  Granularity,
  ReplaySession,
  ReplayBar,
  DataRequest,
  DataRequestQueueSummary,
} from "@/types/replay";
import type { NewDataRequest } from "../types";

export interface ReplayRepo {
  // ── replay_sessions ───────────────────────────────────────────────────────
  listSessions(): Promise<ReplaySession[]>;
  getSession(id: number): Promise<ReplaySession | null>;
  /** Persist user's playback position so resume works after reload. */
  updateLastBarIndex(sessionId: number, lastBarIndex: number): Promise<void>;
  deleteSessions(ids: number[]): Promise<{ deleted: number; error?: string }>;

  // ── replay_bars ───────────────────────────────────────────────────────────
  /** Single-session OHLCV. Returns ALL bars (server-side pagination is
   *  the impl's responsibility — caller doesn't care). */
  listBarsForSession(sessionId: number): Promise<ReplayBar[]>;
  /** Multi-session bulk fetch (the backtest dashboard needs N sessions
   *  worth of bars at once). Map keyed by session id. */
  listBarsForSessions(sessionIds: number[]): Promise<Map<number, ReplayBar[]>>;

  // ── replay-ticks blob storage ─────────────────────────────────────────────
  /** Returns a URL the browser can fetch the gzipped CSV from. expiresSec
   *  is honored in cloud mode (signed URL) and ignored in local mode. */
  getTickBlobUrl(blobPath: string, expiresSec: number): Promise<string>;

  // ── data_requests ─────────────────────────────────────────────────────────
  listPendingDataRequests(): Promise<DataRequest[]>;
  /** Dedupe guard for requestDataExport: existing replay session for the
   *  same (instrument, timeframe, session_date, granularity)? */
  findExistingSession(
    instrument: string,
    timeframe: string,
    sessionDate: string,
    granularity: Granularity
  ): Promise<{ id: number } | null>;
  /** Dedupe guard for requestDataExport: in-flight (pending or processing)
   *  data request for the same combination? */
  findInFlightRequest(
    instrument: string,
    timeframe: string,
    sessionDate: string,
    granularity: Granularity
  ): Promise<{ id: number; status: string } | null>;
  insertDataRequest(req: NewDataRequest): Promise<{ id: number }>;
  /** Bulk-queue requests, idempotent on the active set. The `inserted`
   *  count reflects rows that were actually new — duplicates of an
   *  already-pending/processing entry are silently skipped. */
  insertDataRequestsBulk(reqs: NewDataRequest[]): Promise<{ inserted: number }>;
  /** Cancel/delete one or more data_requests rows. NT8's DataExporter polls
   *  for `status=eq.pending` so deleting a pending row immediately takes it
   *  off the queue. Processing rows can be deleted too — the in-flight
   *  upload will fail to PATCH a missing row and silently abort. */
  deleteDataRequests(ids: number[]): Promise<{ deleted: number }>;
  /** pickRandomDataDay / requestDateRangeExport — list session_dates already
   *  downloaded for a base symbol over a window. The base argument is the
   *  root (e.g. "NQ") and is matched with ilike "<base> %" so any contract
   *  suffix counts. */
  listSessionsForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string
  ): Promise<{ session_date: string }[]>;
  /** Same window but for in-flight requests, so rapid clicks don't double-queue. */
  listInFlightForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string
  ): Promise<{ session_date: string }[]>;

  /** `no_data` rows in the window — broker confirmed no bars exist for this
   *  date. Gap detection includes them in `taken` so re-requesting the range
   *  won't reattempt them. */
  listNoDataForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string
  ): Promise<{ session_date: string }[]>;

  /** Drop every `no_data` row. Used by the "Clear no-data" banner button so
   *  a re-submitted range request can re-attempt those dates. */
  clearNoDataRequests(): Promise<{ cleared: number }>;

  /** Terminal-failed rows (status='error', retry_count >= maxRetries) in a
   *  base + timeframe + granularity + date window. The gap-refill path
   *  deletes these so a re-requested range can re-queue those dates fresh. */
  listFailedForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string,
    maxRetries?: number
  ): Promise<{ id: number; session_date: string }[]>;

  /** Sweep stuck `processing` and transient `error` rows back to `pending`.
   *  Cheap to call on every NT8 GET poll; idempotent. Returns counts so
   *  the caller can log on demand. */
  recoverStaleRequests(opts?: {
    stuckAfterSec?: number;
    errorBackoffSec?: number;
    maxRetries?: number;
  }): Promise<{ resetStuck: number; retriedError: number; gaveUp: number }>;

  /** Counts for the queue summary banner, server-rendered on first paint
   *  so a refresh shows real state instead of waiting for the 2s poll. */
  getQueueSummary(): Promise<DataRequestQueueSummary>;

  /** Reset every `error` row to `pending` with retry_count=0 (skipping any
   *  whose active twin is already in the queue). Powers the "Retry errored"
   *  button in the queue banner. */
  retryAllErrored(): Promise<{ retried: number }>;

  /** Realtime feed of data_requests changes — used by the data export
   *  status banner so the UI updates pending → processing → completed
   *  without a manual refresh. Same kind/upsert convention as the other
   *  subscribeAll methods on this Store. */
  subscribeDataRequests(
    onChange: (
      row: DataRequest,
      kind: "insert" | "update" | "delete"
    ) => void
  ): () => void;

  /** Used by zone analytics fetchers to find candidate replay sessions whose
   *  instrument and timeframe match a set of zones. Returns just the columns
   *  needed (id, instrument, timeframe, start_time, end_time). */
  listSessionsByInstrumentsAndTimeframes(
    instruments: readonly string[],
    timeframes: readonly string[]
  ): Promise<
    Pick<
      ReplaySession,
      "id" | "instrument" | "timeframe" | "start_time" | "end_time"
    >[]
  >;

  /** Used by zone ATR / pre-entry / extension fetchers — bounded time range
   *  scan inside one replay session. Returns full ReplayBar rows so callers
   *  can pick what they need (high/low/close for ATR, full OHLC for charts).
   *  Pagination is the impl's responsibility. */
  listBarsForSessionInTimeRange(
    sessionId: number,
    fromIso: string,
    toIso: string
  ): Promise<ReplayBar[]>;
}
