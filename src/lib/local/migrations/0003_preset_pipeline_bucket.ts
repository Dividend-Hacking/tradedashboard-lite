/**
 * Pipeline bucket + script/param_meta on backtest_presets.
 *
 * Adds the columns the cloud table already has after the matching Supabase
 * migration:
 *
 *   - bucket: pipeline stage the preset currently lives in. Drives the
 *     /pipeline page's drag-drop board and the preset-selector badge.
 *     Defaults to 'new' so any preset created before the column existed
 *     shows up at the leftmost stage on first load.
 *
 *   - script + param_meta: the v2 DSL fields that the dashboard already
 *     writes to localStorage but that the original schema dropped on the
 *     floor. Backfilling NULL is fine — normalizePresetForLoad keeps the
 *     editor's current text when these are missing.
 *
 * SQLite has no CHECK constraint with an enum-like list at column-level
 * shorthand, so we encode the same allow-list as a CHECK clause inline.
 * We rely on application code to never write outside the set, but the
 * DB still rejects bad rows defensively.
 */
export const migration0003 = {
  version: 3,
  sql: /* sql */ `
    ALTER TABLE backtest_presets
      ADD COLUMN bucket TEXT NOT NULL DEFAULT 'new'
        CHECK (bucket IN ('new','in_sample','out_of_sample','sim','live','failed'));

    ALTER TABLE backtest_presets ADD COLUMN script     TEXT;
    ALTER TABLE backtest_presets ADD COLUMN param_meta TEXT;

    CREATE INDEX idx_backtest_presets_bucket
      ON backtest_presets(bucket);
  `,
};
