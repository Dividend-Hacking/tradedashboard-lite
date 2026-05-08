/**
 * PresetsRepo — backtest_presets table.
 *
 * Backtest presets are the user's saved strategy + rules + filters
 * configurations. The UI keeps a localStorage cache for instant render
 * and reconciles with the server (cloud) or the local SQLite (local)
 * via this repo's list/upsert/delete methods.
 *
 * `list` returns the full set newest-first (the dashboard sort order);
 * upsert is keyed on id; delete is by id. The reconciliation logic in
 * src/lib/utils/backtest-presets.ts uses these directly.
 */

import type { BacktestPreset } from "@/lib/utils/backtest-presets";

export interface PresetsRepo {
  list(): Promise<BacktestPreset[]>;
  upsert(preset: BacktestPreset): Promise<void>;
  delete(id: string): Promise<void>;
}
