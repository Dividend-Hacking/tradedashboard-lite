/**
 * Data-request recovery: retry_count, claimed_at, idempotent active set.
 *
 * Adds the columns and indices needed for the local-mode downloader sweeper:
 *
 *   - retry_count: bumped each time the sweeper resets a stuck `processing`
 *     row or auto-retries an `error` row. Caps at 3; beyond that the row is
 *     left as terminal `error` and the user must re-queue manually.
 *
 *   - claimed_at: set by NT8's ClaimRows PATCH when a row enters `processing`,
 *     nulled on terminal status. Distinct from `updated_at` so NT8's 60s
 *     heartbeat can advance `updated_at` (proving liveness) without resetting
 *     the staleness clock the sweeper uses.
 *
 *   - uq_active_data_requests: unique partial index on the active set
 *     (pending + processing). Makes `INSERT OR IGNORE` safe — duplicate
 *     submissions from concurrent tabs no longer race to create twin rows.
 *
 *   - idx_data_requests_processing: keeps the sweeper's "stuck row" scan
 *     cheap enough to run on every NT8 poll (every ~5s) without measurable
 *     overhead.
 */
export const migration0002 = {
  version: 2,
  sql: /* sql */ `
    ALTER TABLE data_requests ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE data_requests ADD COLUMN claimed_at  TEXT;

    -- Pre-existing data may already contain duplicate pending/processing
    -- rows for the same (instrument, timeframe, session_date, granularity)
    -- — the original schema had no unique constraint, so concurrent range
    -- submits could create them. Drop everything except the oldest row in
    -- each duplicate group BEFORE we create the unique partial index, or
    -- the index creation will fail and roll the whole migration back.
    DELETE FROM data_requests
     WHERE status IN ('pending','processing')
       AND id NOT IN (
         SELECT MIN(id) FROM data_requests
          WHERE status IN ('pending','processing')
          GROUP BY instrument, timeframe, session_date, granularity
       );

    CREATE UNIQUE INDEX uq_active_data_requests
      ON data_requests(instrument, timeframe, session_date, granularity)
      WHERE status IN ('pending', 'processing');

    CREATE INDEX idx_data_requests_processing
      ON data_requests(status, claimed_at)
      WHERE status = 'processing';
  `,
};
