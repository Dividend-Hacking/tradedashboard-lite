/**
 * Server Actions for the Live Trading platform.
 *
 * Submits order requests, updates trade tags, and cleans live bar data.
 * Backend-agnostic via the Store layer — works against Supabase in
 * cloud mode and local SQLite in local mode.
 */

"use server";

import { getServerStore } from "@/lib/store/server";

/**
 * Submit an order request for NT8 to execute.
 * Inserts a row into order_requests with status=pending.
 * LiveBridge picks it up, executes via NinjaTrader Cbi API,
 * and updates status to filled/rejected/error.
 */
export async function submitOrder(
  instrument: string,
  account: string,
  action: "buy_long" | "sell_short" | "close" | "cancel_all" | "modify_sl" | "modify_tp",
  slPoints?: number | null,
  tpPoints?: number | null,
  trailEnabled?: boolean,
  newSlPrice?: number | null,
  newTpPrice?: number | null,
  quantity?: number | null
) {
  try {
    const store = await getServerStore();
    // The repo only knows the canonical action set; modify_tp is treated
    // as modify_sl for routing purposes (the new_tp_price field carries
    // the actual update). Cast preserves caller types without expanding
    // the repo interface.
    const { id } = await store.orderRequests.insert({
      instrument,
      account,
      action: action === "modify_tp" ? "modify_sl" : action,
      sl_points: slPoints ?? null,
      tp_points: tpPoints ?? null,
      trail_enabled: trailEnabled ?? false,
      new_sl_price: newSlPrice ?? null,
      new_tp_price: newTpPrice ?? null,
      quantity: quantity ?? 1,
    });
    return { success: true as const, requestId: id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Update grade / mistake / regime / notes tags on a trade row. Called by
 * the trade detail panel after a 500ms debounce. Empty strings are
 * normalized to null at the repo boundary.
 */
export async function updateTradeTags(
  tradeId: number,
  patch: {
    trade_grade?: string | null;
    trade_mistake?: string | null;
    trade_regime?: string | null;
    notes?: string | null;
  }
) {
  try {
    const store = await getServerStore();
    await store.trades.updateTags(tradeId, patch);
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Clean live bar data and request NT8 to reseed historical bars.
 * Deletes all rows from live_bars for one (instrument, timeframe), then
 * inserts a "reseed_bars" command into live_commands — LiveBridge polls
 * this and recreates its BarStreamer, which automatically posts the
 * last 100 warmup bars.
 */
export async function cleanLiveData(instrument: string, timeframe: string = "15 Second") {
  try {
    const store = await getServerStore();
    await store.live.deleteBarsForInstrument(instrument, timeframe);
    await store.live.insertCommand("reseed_bars");
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
