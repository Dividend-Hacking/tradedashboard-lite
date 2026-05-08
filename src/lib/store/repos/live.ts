/**
 * LiveRepo — live_bars, live_state, live_ticker, live_accounts, live_commands.
 *
 * The live data stream from NT8's LiveBridge AddOn. Reads are filtered
 * by instrument; writes are usually upserts keyed on (instrument, account)
 * or the natural key. Realtime sub methods either tap Supabase Realtime
 * (cloud) or short-poll /api/local/realtime/* (local).
 */

import type { LiveBar, LiveTicker, LiveState, LiveAccount } from "@/types/live";

export interface LiveRepo {
  // ── live_bars ─────────────────────────────────────────────────────────────
  listBarsForInstrument(
    instrument: string,
    timeframe: string,
    limit: number
  ): Promise<LiveBar[]>;
  /** Manual reset from the DB Manager modal — clears all bars for one
   *  (instrument, timeframe). */
  deleteBarsForInstrument(instrument: string, timeframe: string): Promise<void>;
  subscribeBars(
    instrument: string,
    timeframe: string,
    onChange: (bar: LiveBar) => void
  ): () => void;

  // ── live_state ────────────────────────────────────────────────────────────
  listStatesForInstrument(instrument: string): Promise<LiveState[]>;
  subscribeStates(
    instrument: string,
    onChange: (state: LiveState) => void
  ): () => void;

  // ── live_ticker ───────────────────────────────────────────────────────────
  getTicker(instrument: string): Promise<LiveTicker | null>;
  subscribeTicker(
    instrument: string,
    onChange: (ticker: LiveTicker) => void
  ): () => void;

  // ── live_accounts ─────────────────────────────────────────────────────────
  listAccounts(): Promise<LiveAccount[]>;

  // ── live_commands ─────────────────────────────────────────────────────────
  /** Insert a one-shot command for NT8 to execute (e.g. "publish_accounts"). */
  insertCommand(command: string): Promise<void>;
}
