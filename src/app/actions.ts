/**
 * Server Actions
 *
 * Server-side mutations for the trade dashboard. These run on the server
 * and dispatch to the active backend (Supabase in cloud mode, local
 * SQLite in local mode) via the Store layer.
 */

"use server";

import { getServerStore } from "@/lib/store/server";

/**
 * Delete multiple trades by their IDs. Backend-agnostic via the Store.
 */
export async function deleteTrades(
  ids: number[]
): Promise<{ success: boolean; error?: string }> {
  if (!ids.length) return { success: true };
  try {
    const store = await getServerStore();
    await store.trades.deleteByIds(ids);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "An unexpected error occurred.";
    console.error("Failed to delete trades:", message);
    return { success: false, error: message };
  }
}

/**
 * Delete multiple trade zones by their IDs. Cascading FK on
 * trade_zone_bars means bar data is automatically removed.
 */
export async function deleteZones(
  ids: number[]
): Promise<{ success: boolean; error?: string }> {
  if (!ids.length) return { success: true };
  try {
    const store = await getServerStore();
    await store.zones.deleteZones(ids);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "An unexpected error occurred.";
    console.error("Failed to delete zones:", message);
    return { success: false, error: message };
  }
}
