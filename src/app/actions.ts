/**
 * Server Actions
 *
 * Server-side mutations for the trade dashboard. These run on the server
 * with full Supabase auth context via the server client.
 */

"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Delete multiple trades by their IDs.
 *
 * Uses the server Supabase client so the DELETE runs with proper auth.
 * Accepts an array of trade IDs and removes all matching rows from
 * the `trades` table in a single query.
 *
 * @param ids - Array of trade IDs to delete
 * @returns Object with success boolean and optional error message
 */
export async function deleteTrades(
  ids: number[]
): Promise<{ success: boolean; error?: string }> {
  // Guard against empty array — nothing to delete
  if (!ids.length) {
    return { success: true };
  }

  try {
    const supabase = await createClient();

    // Delete all trades whose id is in the provided array
    const { error } = await supabase.from("trades").delete().in("id", ids);

    if (error) {
      console.error("Failed to delete trades:", error.message);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    console.error("Unexpected error deleting trades:", err);
    return { success: false, error: "An unexpected error occurred." };
  }
}

/**
 * Delete multiple trade zones by their IDs.
 *
 * Uses the server Supabase client so the DELETE runs with proper auth.
 * Cascading FK on trade_zone_bars means bar data is automatically removed.
 *
 * @param ids - Array of zone IDs to delete
 * @returns Object with success boolean and optional error message
 */
export async function deleteZones(
  ids: number[]
): Promise<{ success: boolean; error?: string }> {
  if (!ids.length) {
    return { success: true };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("trade_zones")
      .delete()
      .in("id", ids);

    if (error) {
      console.error("Failed to delete zones:", error.message);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    console.error("Unexpected error deleting zones:", err);
    return { success: false, error: "An unexpected error occurred." };
  }
}
