/**
 * Trader Preferences — Persistence helpers for the live trade tool.
 *
 * Stores the user's TP/SL/asset/timeframe/account choices in a single
 * Supabase row (`trader_preferences`, id=1) so they survive page reloads
 * and are consistent across browser tabs/devices.
 *
 * The app currently has no auth context, so we use a one-row table with
 * a CHECK (id = 1) constraint. When auth lands, swap the `id = 1` filter
 * for `user_id = auth.uid()` and add RLS.
 */

import { createClient } from "@/lib/supabase/client";
import type { IndicatorConfig } from "@/types/indicators";

/** Shape of a row in the `trader_preferences` table. All fields are nullable
 *  so callers can store partial state without forcing defaults at the DB level. */
export type TraderPreferences = {
  sl_points: number | null;
  tp_points: number | null;
  sl_enabled: boolean | null;
  tp_enabled: boolean | null;
  trail_enabled: boolean | null;
  instrument_label: string | null;
  timeframe: string | null;
  selected_account: string | null;
  /** Number of contracts per trade. Null falls back to 1 in UI/server. */
  quantity: number | null;
  /** When true, dashed preview SL/TP lines are drawn on the live chart while
   *  no position is open, showing where the stop and target would land for
   *  both a Long and a Short entry at the user's configured point distances. */
  show_preview_sl_tp: boolean | null;
  /** Indicator configs for the Live Trader chart. Persisted as JSONB;
   *  array order defines pane order for sub-pane indicators (volume /
   *  ATR / ADX). */
  live_indicators: IndicatorConfig[] | null;
  /** Indicator configs for the Practice / Replay chart. Scoped
   *  separately from live_indicators so a study-heavy practice setup
   *  doesn't clutter the live chart. */
  practice_indicators: IndicatorConfig[] | null;
  /** Visibility toggles for the replay chart's zone and trade overlays.
   *  Shape: `{ activeZones: boolean, completedZones: boolean, trades: boolean }`.
   *  Null means all three default to `true`. Zones are split into active vs
   *  completed so the user can keep a live zone playing on-chart while hiding
   *  the clutter from previously-finished ones. An older shape with just
   *  `{ zones, trades }` may still exist in the DB and is upgraded at
   *  hydration time (zones → both activeZones and completedZones). */
  chart_overlays: {
    activeZones: boolean;
    completedZones: boolean;
    trades: boolean;
  } | null;
};

/**
 * Fetch the single trader_preferences row from Supabase.
 * Returns null when the row doesn't exist (fresh DB) or on error,
 * letting callers fall back to hardcoded defaults.
 */
export async function fetchTraderPreferences(): Promise<TraderPreferences | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("trader_preferences")
    .select(
      "sl_points, tp_points, sl_enabled, tp_enabled, trail_enabled, instrument_label, timeframe, selected_account, quantity, show_preview_sl_tp, live_indicators, practice_indicators, chart_overlays"
    )
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;
  return data as TraderPreferences;
}

// ─── Debounced upsert ──────────────────────────────────────────────
// We accumulate partial patches and flush them as a single upsert 500ms
// after the user stops editing. This keeps Supabase write volume low
// while typing into number inputs (which fire onChange every keystroke).

let pendingPatch: Partial<TraderPreferences> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

/**
 * Queue a partial preferences update. Multiple calls within DEBOUNCE_MS
 * are merged and flushed in a single upsert. Safe to call from React
 * effects or event handlers without worrying about request floods.
 */
export function saveTraderPreferencesDebounced(patch: Partial<TraderPreferences>): void {
  // Merge into the pending patch — later values for the same key win.
  pendingPatch = { ...pendingPatch, ...patch };

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    void flushPendingPatch();
  }, DEBOUNCE_MS);
}

/** Internal: send the merged patch to Supabase and clear the pending buffer. */
async function flushPendingPatch(): Promise<void> {
  const patch = pendingPatch;
  pendingPatch = {};
  flushTimer = null;
  if (Object.keys(patch).length === 0) return;

  const supabase = createClient();
  const { error } = await supabase
    .from("trader_preferences")
    .upsert(
      { id: 1, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  if (error) {
    // Non-fatal — log but don't throw. Persistence is a convenience,
    // not load-bearing for the trading flow itself.
    console.error("[trader-preferences] save failed:", error);
  }
}
