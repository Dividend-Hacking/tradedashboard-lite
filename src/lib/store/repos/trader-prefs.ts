/**
 * TraderPrefsRepo — singleton trader_preferences row (id=1).
 *
 * Holds TP/SL/instrument/account/quantity/indicator state for the live
 * trader, plus the chart_overlays toggle for the practice chart. Writes
 * are debounced at the call site; this repo just exposes a flat upsert.
 */

import type { TraderPreferences } from "@/lib/trader-preferences";

export interface TraderPrefsRepo {
  fetch(): Promise<TraderPreferences | null>;
  /** Partial-row upsert. The repo handles merging with the existing row
   *  if one exists (Supabase via .upsert(), local via INSERT … ON CONFLICT). */
  upsertPatch(patch: Partial<TraderPreferences>): Promise<void>;
}
