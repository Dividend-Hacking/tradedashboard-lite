/**
 * Server Actions for the Live Trading platform.
 *
 * Submits order requests to the order_requests table, which NT8's
 * LiveBridge AddOn polls every 500ms and executes.
 */

"use server";

import { createClient } from "@/lib/supabase/server";

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
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("order_requests")
    .insert({
      instrument,
      account,
      action,
      sl_points: slPoints ?? null,
      tp_points: tpPoints ?? null,
      trail_enabled: trailEnabled ?? false,
      new_sl_price: newSlPrice ?? null,
      new_tp_price: newTpPrice ?? null,
      // Default to 1 contract when caller doesn't specify, matching the
      // hardcoded LiveBridge fallback so behaviour is unchanged for callers
      // that haven't been updated.
      quantity: quantity ?? 1,
    })
    .select("id")
    .single();

  if (error) {
    return { error: error.message };
  }

  return { success: true, requestId: data.id };
}

/**
 * Update grade / mistake / regime / notes tags on a trade row.
 *
 * Mirrors the NinjaTrader TradeTagger PATCH: the panel debounces edits for
 * ~500ms and then fires this action. Empty strings from the UI are converted
 * to null so an unselected dropdown clears the tag (matches
 * FormatJsonStringOrNull in TradeTagger.cs).
 *
 * Keyed by trade.id rather than NT's composite filter — the web side has a
 * stable primary key available.
 */
export async function updateTradeTags(
  tradeId: number,
  patch: {
    trade_grade?: string | null;
    trade_mistake?: string | null;
    trade_regime?: string | null;
    notes?: string | null;
  },
) {
  const supabase = await createClient();

  // Normalize empty strings to null so cleared dropdowns wipe the tag.
  const normalized: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    normalized[key] = value === "" ? null : value;
  }

  const { error } = await supabase
    .from("trades")
    .update(normalized)
    .eq("id", tradeId);

  if (error) return { error: error.message };
  return { success: true };
}

/**
 * Clean live bar data and request NT8 to reseed historical bars.
 * Deletes all rows from live_bars, then inserts a "reseed_bars" command
 * into live_commands — LiveBridge polls this and recreates its BarStreamer,
 * which automatically posts the last 100 warmup bars.
 */
export async function cleanLiveData(instrument: string) {
  const supabase = await createClient();

  // Step 1: Delete all live bars for this instrument
  const { error: deleteError } = await supabase
    .from("live_bars")
    .delete()
    .eq("instrument", instrument);

  if (deleteError) {
    return { error: "Failed to delete bars: " + deleteError.message };
  }

  // Step 2: Insert a reseed command for NT8 to pick up
  const { error: cmdError } = await supabase
    .from("live_commands")
    .insert({ command: "reseed_bars" });

  if (cmdError) {
    return { error: "Failed to send reseed command: " + cmdError.message };
  }

  return { success: true };
}
