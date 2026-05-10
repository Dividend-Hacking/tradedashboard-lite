/**
 * Free-form notes column on backtest_presets.
 *
 * Mirrors the matching Supabase migration (backtest_presets_add_notes).
 * Nullable so existing rows backfill cleanly — the dashboard treats a
 * missing/empty value as "no notes" and renders an empty textarea.
 */
export const migration0004 = {
  version: 4,
  sql: /* sql */ `
    ALTER TABLE backtest_presets ADD COLUMN notes TEXT;
  `,
};
