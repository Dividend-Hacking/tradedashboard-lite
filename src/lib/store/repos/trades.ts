/**
 * TradesRepo — read/write/subscribe for the `trades` table.
 *
 * The `trades` table is written by NT8's TradeTracker AddOn (one row per
 * completed live trade) and read by the dashboard, trade detail panel,
 * live trader, and auto trader. This repo exposes only the methods the
 * call sites actually use today.
 *
 * Realtime: subscribeForInstrument fans out new/updated trades for one
 * instrument to a callback. In cloud mode it's a Supabase postgres_changes
 * channel; in local mode it's a polled /api/local/realtime/trades endpoint.
 */

import type { Trade, TradeBar } from "@/types/trade";
import type { TradeTagsPatch } from "../types";

export interface TradesRepo {
  /** Dashboard home — every trade, ordered by entry_time. */
  listAllOrderedByEntryTime(): Promise<Trade[]>;

  /** Live/auto trader — one instrument, sliced to today's trades only. */
  listForInstrumentSinceUtc(instrument: string, sinceIso: string): Promise<Trade[]>;

  /** Bulk delete from the dashboard's manage-trades modal. */
  deleteByIds(ids: number[]): Promise<{ deleted: number }>;

  /** Tag-only patch from the trade detail panel (grade, mistake, regime,
   *  notes, custom_tags). Single-row UPDATE filtered by id. */
  updateTags(id: number, patch: TradeTagsPatch): Promise<void>;

  /** Fetch the OHLCV context bars captured around one trade. Used by the
   *  live tagger and trade detail panel to render a mini chart. */
  listBarsForTrade(tradeId: number): Promise<TradeBar[]>;

  /** Live updates for one instrument. Returns an unsubscribe fn. */
  subscribeForInstrument(
    instrument: string,
    onChange: (trade: Trade) => void
  ): () => void;

  /** Global subscription used by the main Dashboard. The callback fires
   *  with the row plus the change kind so the consumer can apply
   *  insert/update/delete semantics without re-querying. In local mode
   *  the polling backend always reports "update" — the dashboard treats
   *  that as upsert, so behavior is identical for the new-row and
   *  metadata-changed cases; deletes only propagate via the user's own
   *  optimistic state in local mode. */
  subscribeAll(
    onChange: (row: Trade, kind: "insert" | "update" | "delete") => void
  ): () => void;
}
