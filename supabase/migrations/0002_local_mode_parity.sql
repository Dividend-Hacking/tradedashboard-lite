-- Trade Dashboard Lite — schema delta to bring cloud (Supabase) in line
-- with local-mode SQLite after the May 2026 tick-data + DSL revamp.
--
-- Apply this AFTER 0001_init.sql against the same Supabase project. The
-- whole file is idempotent: ADD COLUMN IF NOT EXISTS guards every add,
-- and the UNIQUE-constraint swap is wrapped in DO blocks. Re-running it
-- is safe and has no effect once the schema is current.
--
-- What changed since 0001_init.sql:
--   - Tick-by-tick support: replay sessions now record their tick blob
--     path + tick count, and replay bars carry per-bar bid/ask volume.
--   - Replay sessions are now keyed on (instrument, timeframe, date,
--     granularity) so the same date can have both 'ohlcv' and 'tick'
--     sessions side by side.
--   - Data requests inherit the same granularity column so the queue
--     can dispatch tick downloads independently of bar downloads.

-- ─── replay_sessions: tick-data columns + new UNIQUE key ────────────────

ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS granularity    text    NOT NULL DEFAULT 'ohlcv';
ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS tick_blob_path text;
ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS tick_count     integer;

-- Drop the old (instrument, timeframe, session_date) UNIQUE and re-add
-- with granularity included. Postgres has no DROP CONSTRAINT IF EXISTS
-- guard prior to PG15 in older Supabase projects, so we look it up by
-- name and drop only if found. The auto-generated name follows the
-- usual `<table>_<col1>_<col2>_<col3>_key` pattern.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'replay_sessions'::regclass
    AND contype = 'u'
    AND conkey = ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'instrument'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'timeframe'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'session_date')
    ];

  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE replay_sessions DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'replay_sessions'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'instrument'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'timeframe'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'session_date'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'replay_sessions'::regclass AND attname = 'granularity')
      ]
  ) THEN
    ALTER TABLE replay_sessions
      ADD CONSTRAINT replay_sessions_instrument_timeframe_session_date_granularity_key
      UNIQUE (instrument, timeframe, session_date, granularity);
  END IF;
END $$;

-- ─── replay_bars: per-bar bid/ask volume for tick reconstruction ────────

ALTER TABLE replay_bars
  ADD COLUMN IF NOT EXISTS bar_volume_bid integer;
ALTER TABLE replay_bars
  ADD COLUMN IF NOT EXISTS bar_volume_ask integer;

-- ─── data_requests: granularity for tick vs OHLCV downloads ─────────────

ALTER TABLE data_requests
  ADD COLUMN IF NOT EXISTS granularity text NOT NULL DEFAULT 'ohlcv';
