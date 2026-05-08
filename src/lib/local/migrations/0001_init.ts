/**
 * Initial schema for Local Mode.
 *
 * Mirrors the in-scope Supabase tables column-for-column with SQLite-native
 * types. Conventions:
 *   - bigint / integer  → INTEGER
 *   - numeric / float   → REAL
 *   - boolean           → INTEGER (0/1) — translated at the repo boundary
 *   - timestamptz / date → TEXT (ISO 8601 / YYYY-MM-DD)
 *   - jsonb             → TEXT — repos serialize/deserialize via lib/local/json.ts
 *
 * Singleton tables (trader_preferences id=1, backtest_dashboard_state
 * id='singleton', livebridge_endpoint id='default') keep their CHECK
 * constraints so the local DB can't accidentally hold multiple rows.
 *
 * Composite-key tables (live_state on instrument+account) preserve the
 * Postgres compound primary key.
 *
 * Foreign keys are declared with ON DELETE CASCADE where the cloud schema
 * cascades, so deleting a replay session cleans up its bars (and any
 * derived practice sessions) in one statement.
 */

export const migration0001 = {
  version: 1,
  sql: /* sql */ `
    -- ── Replay (NT8 historical data downloads) ──────────────────────────────

    CREATE TABLE replay_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument      TEXT    NOT NULL,
      timeframe       TEXT    NOT NULL,
      session_date    TEXT    NOT NULL,                     -- YYYY-MM-DD
      start_time      TEXT    NOT NULL,                     -- ISO timestamptz
      end_time        TEXT    NOT NULL,
      bar_count       INTEGER NOT NULL DEFAULT 0,
      notes           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_bar_index  INTEGER NOT NULL DEFAULT 0,
      granularity     TEXT    NOT NULL DEFAULT 'ohlcv',
      tick_blob_path  TEXT,
      tick_count      INTEGER,
      UNIQUE(instrument, timeframe, session_date, granularity)
    );
    CREATE INDEX idx_replay_sessions_date       ON replay_sessions(session_date);
    CREATE INDEX idx_replay_sessions_instr_tf   ON replay_sessions(instrument, timeframe);

    CREATE TABLE replay_bars (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
      bar_index       INTEGER NOT NULL,
      bar_time        TEXT    NOT NULL,
      bar_open        REAL    NOT NULL,
      bar_high        REAL    NOT NULL,
      bar_low         REAL    NOT NULL,
      bar_close       REAL    NOT NULL,
      bar_volume      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      bar_volume_bid  INTEGER,
      bar_volume_ask  INTEGER,
      UNIQUE(session_id, bar_index)
    );
    CREATE INDEX idx_replay_bars_session ON replay_bars(session_id, bar_index);

    CREATE TABLE data_requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument         TEXT    NOT NULL,
      timeframe          TEXT    NOT NULL,
      session_date       TEXT    NOT NULL,
      status             TEXT    NOT NULL DEFAULT 'pending',
      error_message      TEXT,
      replay_session_id  INTEGER          REFERENCES replay_sessions(id) ON DELETE SET NULL,
      created_at         TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      granularity        TEXT    NOT NULL DEFAULT 'ohlcv'
    );
    CREATE INDEX idx_data_requests_status ON data_requests(status, created_at);

    -- ── Live trading (NT8 LiveBridge) ───────────────────────────────────────

    CREATE TABLE live_bars (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument  TEXT    NOT NULL,
      timeframe   TEXT    NOT NULL,
      bar_time    TEXT    NOT NULL,
      bar_open    REAL    NOT NULL,
      bar_high    REAL    NOT NULL,
      bar_low     REAL    NOT NULL,
      bar_close   REAL    NOT NULL,
      bar_volume  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(instrument, timeframe, bar_time)
    );
    CREATE INDEX idx_live_bars_instr_time ON live_bars(instrument, bar_time DESC);

    CREATE TABLE live_ticker (
      instrument  TEXT    NOT NULL,
      last_price  REAL    NOT NULL,
      bid         REAL,
      ask         REAL,
      updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (instrument)
    );

    CREATE TABLE live_state (
      instrument            TEXT    NOT NULL,
      account               TEXT    NOT NULL DEFAULT 'Sim101',
      position_direction    TEXT,
      position_quantity     INTEGER          DEFAULT 0,
      position_entry_price  REAL,
      unrealized_pnl        REAL             DEFAULT 0,
      sl_price              REAL,
      tp_price              REAL,
      trail_enabled         INTEGER          DEFAULT 0,
      updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (instrument, account)
    );

    CREATE TABLE live_accounts (
      account_name  TEXT NOT NULL PRIMARY KEY,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE live_commands (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      command     TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ── Order requests (web → NT8) ──────────────────────────────────────────

    CREATE TABLE order_requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument      TEXT    NOT NULL,
      account         TEXT,
      action          TEXT    NOT NULL,
      sl_points       REAL,
      tp_points       REAL,
      trail_enabled   INTEGER          DEFAULT 0,
      quantity        INTEGER,
      new_sl_price    REAL,
      new_tp_price    REAL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      error_message   TEXT,
      fill_price      REAL,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_order_requests_status ON order_requests(status, created_at);

    -- ── Trader preferences (singleton id=1) ─────────────────────────────────

    CREATE TABLE trader_preferences (
      id                    INTEGER PRIMARY KEY CHECK (id = 1),
      sl_points             REAL,
      tp_points             REAL,
      sl_enabled            INTEGER,
      tp_enabled            INTEGER,
      trail_enabled         INTEGER,
      instrument_label      TEXT,
      timeframe             TEXT,
      selected_account      TEXT,
      quantity              INTEGER,
      show_preview_sl_tp    INTEGER,
      live_indicators       TEXT DEFAULT '[]',                -- jsonb
      practice_indicators   TEXT DEFAULT '[]',                -- jsonb
      chart_overlays        TEXT,                             -- jsonb
      updated_at            TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ── LiveBridge endpoint discovery (singleton id='default') ─────────────

    CREATE TABLE livebridge_endpoint (
      id          TEXT NOT NULL PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
      candidates  TEXT NOT NULL,                              -- jsonb (array of {host, last_ok})
      port        INTEGER NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ── Trades (NT8 TradeTracker) ───────────────────────────────────────────

    CREATE TABLE trades (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_time              TEXT    NOT NULL,
      exit_time               TEXT,
      real_entry_time         TEXT,
      real_exit_time          TEXT,
      instrument              TEXT    NOT NULL,
      direction               TEXT    NOT NULL,
      entry_price             REAL    NOT NULL,
      exit_price              REAL,
      stop_loss_price         REAL,
      take_profit_price       REAL,
      quantity                INTEGER,
      pnl_points              REAL,
      pnl_dollars             REAL,
      strategy_signal_name    TEXT,
      account_name            TEXT,
      initial_stop_distance   REAL,
      actual_rr               REAL,
      setup_rr                REAL,
      mfe_points              REAL,
      mae_points              REAL,
      mfe_r_multiple          REAL,
      mae_r_multiple          REAL,
      post_exit_mfe_points    REAL,
      post_exit_mfe_r         REAL,
      post_exit_mae_points    REAL,
      ctx_atr14               REAL,
      ctx_atr14_15s           REAL,
      ctx_price_vs_ema20      TEXT,
      ctx_dist_ema20_atr      REAL,
      ctx_price_vs_ema200     TEXT,
      ctx_dist_ema200_atr     REAL,
      ctx_bollinger_pos       TEXT,
      ctx_bollinger_bw        REAL,
      ctx_market_regime       TEXT,
      ctx_adx14               REAL,
      risk_units              REAL    DEFAULT 0,
      atr_multiplier          REAL    DEFAULT 0,
      rr_multiplier           REAL    DEFAULT 0,
      sl_mode                 TEXT    DEFAULT '',
      custom_tags             TEXT    DEFAULT '{}',           -- jsonb
      notes                   TEXT,
      trade_grade             TEXT,
      trade_mistake           TEXT,
      trade_regime            TEXT,
      trade_status            TEXT    NOT NULL DEFAULT 'open',
      created_at              TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_trades_instrument_entry ON trades(instrument, entry_time);
    CREATE INDEX idx_trades_status           ON trades(trade_status);
    CREATE INDEX idx_trades_account_time     ON trades(account_name, entry_time);

    CREATE TABLE trade_bars (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id      INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
      bar_index     INTEGER NOT NULL,
      bar_time      TEXT    NOT NULL,
      bar_open      REAL,
      bar_high      REAL,
      bar_low       REAL,
      bar_close     REAL,
      bar_volume    INTEGER,
      is_entry_bar  INTEGER NOT NULL DEFAULT 0,
      is_exit_bar   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(trade_id, bar_index)
    );

    -- ── Practice (user trading inside replay sessions) ──────────────────────

    CREATE TABLE practice_sessions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      replay_session_id  INTEGER NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
      started_at         TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ended_at           TEXT,
      total_pnl_points   REAL             DEFAULT 0,
      total_trades       INTEGER          DEFAULT 0,
      win_count          INTEGER          DEFAULT 0,
      loss_count         INTEGER          DEFAULT 0,
      notes              TEXT,
      created_at         TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_practice_sessions_replay ON practice_sessions(replay_session_id);

    CREATE TABLE practice_trades (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      practice_session_id  INTEGER NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
      direction            TEXT    NOT NULL,
      entry_bar_index      INTEGER NOT NULL,
      entry_price          REAL    NOT NULL,
      exit_bar_index       INTEGER,
      exit_price           REAL,
      stop_loss_price      REAL,
      take_profit_price    REAL,
      pnl_points           REAL,
      exit_reason          TEXT,
      entry_time           TEXT    NOT NULL,
      exit_time            TEXT,
      created_at           TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_practice_trades_session ON practice_trades(practice_session_id);

    -- ── Trade zones (chart-drawn analytical regions) ────────────────────────

    CREATE TABLE zone_sections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE trade_zones (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument             TEXT    NOT NULL,
      direction              TEXT    NOT NULL,
      start_time             TEXT    NOT NULL,
      end_time               TEXT    NOT NULL,
      start_price            REAL    NOT NULL,
      end_price              REAL    NOT NULL,
      bar_count              INTEGER NOT NULL,
      points_move            REAL    NOT NULL,
      duration_seconds       INTEGER NOT NULL,
      notes                  TEXT,
      chart_timeframe        TEXT,
      created_at             TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ctx_atr14              REAL,
      ctx_adx14              REAL,
      ctx_ema20              REAL,
      ctx_ema200             REAL,
      ctx_price_vs_ema20     TEXT,
      ctx_price_vs_ema200    TEXT,
      ctx_dist_ema20_atr     REAL,
      ctx_bollinger_pos      TEXT,
      ctx_bollinger_bw       REAL,
      entry_hour             INTEGER,
      entry_day_of_week      INTEGER,
      section_id             INTEGER          REFERENCES zone_sections(id) ON DELETE SET NULL,
      sl_price               REAL,
      tp_price               REAL,
      hit_outcome            TEXT
    );
    CREATE INDEX idx_trade_zones_start ON trade_zones(start_time);
    CREATE INDEX idx_trade_zones_section ON trade_zones(section_id);

    CREATE TABLE trade_zone_bars (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id               INTEGER NOT NULL REFERENCES trade_zones(id) ON DELETE CASCADE,
      bar_time              TEXT    NOT NULL,
      bar_open              REAL    NOT NULL,
      bar_high              REAL    NOT NULL,
      bar_low               REAL    NOT NULL,
      bar_close             REAL    NOT NULL,
      bar_volume            INTEGER NOT NULL,
      bar_index             INTEGER NOT NULL,
      mfe_from_start        REAL,
      mae_from_start        REAL,
      created_at            TEXT             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      drawdown_from_entry   REAL,
      runup_from_entry      REAL,
      close_vs_entry        REAL,
      high_since_entry      REAL,
      retrace_from_peak     REAL,
      UNIQUE(zone_id, bar_index)
    );

    -- ── Backtest dashboard ──────────────────────────────────────────────────

    CREATE TABLE backtest_presets (
      id           TEXT    NOT NULL PRIMARY KEY,
      name         TEXT    NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      strategy_id  TEXT    NOT NULL,
      params       TEXT    NOT NULL,                           -- jsonb
      rules        TEXT    NOT NULL,                           -- jsonb
      filters      TEXT    NOT NULL,                           -- jsonb
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE backtest_dashboard_state (
      id          TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
      state       TEXT NOT NULL DEFAULT '{}',                  -- jsonb
      client_id   TEXT,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `,
};
