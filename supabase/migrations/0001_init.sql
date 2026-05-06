-- Trade Dashboard Lite — initial schema
--
-- Apply this once to a fresh Supabase project, either via:
--   supabase db push                                 (Supabase CLI)
-- or by pasting the file into the SQL Editor in the Supabase dashboard.
--
-- The schema is single-user by design: one Supabase project per user, no RLS,
-- no auth. The trader_preferences table is locked to a single row (id = 1)
-- via a CHECK constraint — that row is the user's persisted UI settings.
--
-- Idempotent: tables and sequences use IF NOT EXISTS, so re-running is safe.
-- Constraints and indexes are guarded with DO blocks where Postgres lacks
-- IF NOT EXISTS support natively.

-- ─── Sequences ────────────────────────────────────────────────────────────
-- Created up front because table DEFAULTs reference them via nextval().

CREATE SEQUENCE IF NOT EXISTS checklist_categories_id_seq;
CREATE SEQUENCE IF NOT EXISTS checklist_completions_id_seq;
CREATE SEQUENCE IF NOT EXISTS checklist_items_id_seq;
CREATE SEQUENCE IF NOT EXISTS data_requests_id_seq;
CREATE SEQUENCE IF NOT EXISTS journal_entries_id_seq;
CREATE SEQUENCE IF NOT EXISTS live_bars_id_seq;
CREATE SEQUENCE IF NOT EXISTS live_commands_id_seq;
CREATE SEQUENCE IF NOT EXISTS note_folders_id_seq;
CREATE SEQUENCE IF NOT EXISTS notes_id_seq;
CREATE SEQUENCE IF NOT EXISTS order_requests_id_seq;
CREATE SEQUENCE IF NOT EXISTS practice_sessions_id_seq;
CREATE SEQUENCE IF NOT EXISTS practice_trades_id_seq;
CREATE SEQUENCE IF NOT EXISTS replay_bars_id_seq;
CREATE SEQUENCE IF NOT EXISTS replay_sessions_id_seq;
CREATE SEQUENCE IF NOT EXISTS strategy_logs_id_seq;
CREATE SEQUENCE IF NOT EXISTS trade_bars_id_seq;
CREATE SEQUENCE IF NOT EXISTS trade_zone_bars_id_seq;
CREATE SEQUENCE IF NOT EXISTS trade_zones_id_seq;
CREATE SEQUENCE IF NOT EXISTS trades_id_seq;
CREATE SEQUENCE IF NOT EXISTS zone_sections_id_seq;

-- ─── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_dashboard_state (
  id text NOT NULL DEFAULT 'singleton'::text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_id text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_presets (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  strategy_id text NOT NULL,
  params jsonb NOT NULL,
  rules jsonb NOT NULL,
  filters jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_categories (
  id bigint NOT NULL DEFAULT nextval('checklist_categories_id_seq'::regclass) PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['daily'::text, 'todo'::text])),
  "position" integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id bigint NOT NULL DEFAULT nextval('checklist_items_id_seq'::regclass) PRIMARY KEY,
  category_id bigint NOT NULL REFERENCES checklist_categories(id) ON DELETE CASCADE,
  text text NOT NULL,
  "position" integer DEFAULT 0,
  completed boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_completions (
  id bigint NOT NULL DEFAULT nextval('checklist_completions_id_seq'::regclass) PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  completion_date date NOT NULL,
  completed_at timestamp with time zone DEFAULT now(),
  UNIQUE (item_id, completion_date)
);

CREATE TABLE IF NOT EXISTS replay_sessions (
  id bigint NOT NULL DEFAULT nextval('replay_sessions_id_seq'::regclass) PRIMARY KEY,
  instrument text NOT NULL,
  timeframe text NOT NULL,
  session_date date NOT NULL,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone NOT NULL,
  bar_count integer NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  last_bar_index integer NOT NULL DEFAULT 0,
  UNIQUE (instrument, timeframe, session_date)
);

CREATE TABLE IF NOT EXISTS replay_bars (
  id bigint NOT NULL DEFAULT nextval('replay_bars_id_seq'::regclass) PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  bar_index integer NOT NULL,
  bar_time timestamp with time zone NOT NULL,
  bar_open numeric(12,2) NOT NULL,
  bar_high numeric(12,2) NOT NULL,
  bar_low numeric(12,2) NOT NULL,
  bar_close numeric(12,2) NOT NULL,
  bar_volume bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_requests (
  id bigint NOT NULL DEFAULT nextval('data_requests_id_seq'::regclass) PRIMARY KEY,
  instrument text NOT NULL,
  timeframe text NOT NULL,
  session_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text
    CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'error'::text])),
  error_message text,
  replay_session_id bigint REFERENCES replay_sessions(id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id bigint NOT NULL DEFAULT nextval('journal_entries_id_seq'::regclass) PRIMARY KEY,
  entry_date date NOT NULL UNIQUE,
  next_day_goals text,
  thoughts text,
  submitted boolean DEFAULT false,
  submitted_at timestamp with time zone,
  recap_generated_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  gratitude text,
  trade_journal text
);

CREATE TABLE IF NOT EXISTS live_accounts (
  account_name text NOT NULL PRIMARY KEY,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_bars (
  id bigint NOT NULL DEFAULT nextval('live_bars_id_seq'::regclass) PRIMARY KEY,
  instrument text NOT NULL,
  timeframe text NOT NULL,
  bar_time timestamp with time zone NOT NULL,
  bar_open double precision NOT NULL,
  bar_high double precision NOT NULL,
  bar_low double precision NOT NULL,
  bar_close double precision NOT NULL,
  bar_volume bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_commands (
  id bigint NOT NULL DEFAULT nextval('live_commands_id_seq'::regclass) PRIMARY KEY,
  command text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_state (
  instrument text NOT NULL,
  position_direction text,
  position_quantity integer DEFAULT 0,
  position_entry_price double precision,
  unrealized_pnl double precision DEFAULT 0,
  sl_price double precision,
  tp_price double precision,
  trail_enabled boolean DEFAULT false,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'Sim101'::text,
  PRIMARY KEY (instrument, account)
);

CREATE TABLE IF NOT EXISTS live_strategies (
  instance_id text NOT NULL PRIMARY KEY,
  strategy_name text NOT NULL,
  preset_name text,
  preset_path text,
  instrument text,
  account_name text,
  chart_timeframe text,
  nt_state text NOT NULL DEFAULT 'unknown'::text,
  enabled boolean NOT NULL DEFAULT false,
  in_window boolean,
  has_open_position boolean DEFAULT false,
  position_direction text,
  position_quantity integer DEFAULT 0,
  position_entry_price numeric,
  position_stop_price numeric,
  position_take_profit_price numeric,
  unrealized_pnl numeric DEFAULT 0,
  realized_pnl_today numeric DEFAULT 0,
  trades_today integer DEFAULT 0,
  wins_today integer DEFAULT 0,
  losses_today integer DEFAULT 0,
  total_trades integer DEFAULT 0,
  total_pnl numeric DEFAULT 0,
  last_trade_at timestamp with time zone,
  last_error text,
  last_error_at timestamp with time zone,
  error_count integer DEFAULT 0,
  warning_count integer DEFAULT 0,
  started_at timestamp with time zone DEFAULT now(),
  last_heartbeat_at timestamp with time zone DEFAULT now(),
  host_machine text,
  nt_version text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_ticker (
  instrument text NOT NULL PRIMARY KEY,
  last_price double precision NOT NULL,
  bid double precision,
  ask double precision,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS livebridge_endpoint (
  id text NOT NULL DEFAULT 'default'::text PRIMARY KEY,
  candidates jsonb NOT NULL,
  port integer NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS note_folders (
  id bigint NOT NULL DEFAULT nextval('note_folders_id_seq'::regclass) PRIMARY KEY,
  name text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id bigint NOT NULL DEFAULT nextval('notes_id_seq'::regclass) PRIMARY KEY,
  folder_id bigint REFERENCES note_folders(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Untitled'::text,
  content text NOT NULL DEFAULT ''::text,
  pinned boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_requests (
  id bigint NOT NULL DEFAULT nextval('order_requests_id_seq'::regclass) PRIMARY KEY,
  instrument text NOT NULL,
  action text NOT NULL,
  sl_points double precision,
  tp_points double precision,
  trail_enabled boolean DEFAULT false,
  quantity integer,
  new_sl_price double precision,
  status text NOT NULL DEFAULT 'pending'::text
    CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'filled'::text, 'rejected'::text, 'error'::text])),
  error_message text,
  fill_price double precision,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  account text,
  new_tp_price double precision
);

CREATE TABLE IF NOT EXISTS practice_sessions (
  id bigint NOT NULL DEFAULT nextval('practice_sessions_id_seq'::regclass) PRIMARY KEY,
  replay_session_id bigint NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  started_at timestamp with time zone DEFAULT now(),
  ended_at timestamp with time zone,
  total_pnl_points numeric(10,2) DEFAULT 0,
  total_trades integer DEFAULT 0,
  win_count integer DEFAULT 0,
  loss_count integer DEFAULT 0,
  notes text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS practice_trades (
  id bigint NOT NULL DEFAULT nextval('practice_trades_id_seq'::regclass) PRIMARY KEY,
  practice_session_id bigint NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  direction text NOT NULL,
  entry_bar_index integer NOT NULL,
  entry_price numeric(12,2) NOT NULL,
  exit_bar_index integer,
  exit_price numeric(12,2),
  stop_loss_price numeric(12,2),
  take_profit_price numeric(12,2),
  pnl_points numeric(10,2),
  exit_reason text,
  entry_time timestamp with time zone NOT NULL,
  exit_time timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS script_editor_state (
  id text NOT NULL PRIMARY KEY,
  content text NOT NULL DEFAULT ''::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_logs (
  id bigint NOT NULL DEFAULT nextval('strategy_logs_id_seq'::regclass) PRIMARY KEY,
  instance_id text,
  strategy_name text,
  account_name text,
  instrument text,
  level text NOT NULL DEFAULT 'info'::text,
  category text,
  message text NOT NULL,
  meta jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trades (
  id bigint NOT NULL DEFAULT nextval('trades_id_seq'::regclass) PRIMARY KEY,
  entry_time timestamp with time zone NOT NULL,
  exit_time timestamp with time zone,
  instrument text NOT NULL,
  direction text NOT NULL,
  entry_price numeric NOT NULL,
  exit_price numeric,
  stop_loss_price numeric,
  quantity integer,
  pnl_points numeric,
  pnl_dollars numeric,
  strategy_signal_name text,
  account_name text,
  initial_stop_distance numeric,
  actual_rr numeric,
  take_profit_price numeric,
  setup_rr numeric,
  mfe_points numeric,
  mae_points numeric,
  mfe_r_multiple numeric,
  mae_r_multiple numeric,
  post_exit_mfe_points numeric,
  post_exit_mfe_r numeric,
  post_exit_mae_points numeric,
  ctx_atr14 numeric,
  ctx_price_vs_ema20 text,
  ctx_dist_ema20_atr numeric,
  ctx_price_vs_ema200 text,
  ctx_dist_ema200_atr numeric,
  ctx_bollinger_pos text,
  ctx_market_regime text,
  ctx_adx14 numeric,
  ctx_bollinger_bw numeric,
  custom_tags jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  ctx_atr14_15s double precision,
  risk_units double precision DEFAULT 0,
  atr_multiplier double precision DEFAULT 0,
  rr_multiplier double precision DEFAULT 0,
  sl_mode text DEFAULT ''::text,
  notes text,
  trade_grade text,
  trade_mistake text,
  trade_regime text,
  trade_status text NOT NULL DEFAULT 'open'::text,
  real_entry_time timestamp with time zone,
  real_exit_time timestamp with time zone
);

CREATE TABLE IF NOT EXISTS trade_bars (
  id bigint NOT NULL DEFAULT nextval('trade_bars_id_seq'::regclass) PRIMARY KEY,
  trade_id bigint NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  bar_index integer NOT NULL,
  bar_time timestamp with time zone NOT NULL,
  bar_open numeric(12,4),
  bar_high numeric(12,4),
  bar_low numeric(12,4),
  bar_close numeric(12,4),
  bar_volume bigint,
  is_entry_bar boolean NOT NULL DEFAULT false,
  is_exit_bar boolean NOT NULL DEFAULT false,
  UNIQUE (trade_id, bar_index)
);

CREATE TABLE IF NOT EXISTS zone_sections (
  id bigint NOT NULL DEFAULT nextval('zone_sections_id_seq'::regclass) PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_zones (
  id bigint NOT NULL DEFAULT nextval('trade_zones_id_seq'::regclass) PRIMARY KEY,
  instrument text NOT NULL,
  direction text NOT NULL,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone NOT NULL,
  start_price numeric NOT NULL,
  end_price numeric NOT NULL,
  bar_count integer NOT NULL,
  points_move numeric NOT NULL,
  duration_seconds integer NOT NULL,
  notes text,
  chart_timeframe text,
  created_at timestamp with time zone DEFAULT now(),
  ctx_atr14 numeric,
  ctx_adx14 numeric,
  ctx_ema20 numeric,
  ctx_ema200 numeric,
  ctx_price_vs_ema20 text,
  ctx_price_vs_ema200 text,
  ctx_dist_ema20_atr numeric,
  ctx_bollinger_pos text,
  ctx_bollinger_bw numeric,
  entry_hour integer,
  entry_day_of_week integer,
  section_id bigint REFERENCES zone_sections(id) ON DELETE SET NULL,
  sl_price numeric,
  tp_price numeric,
  hit_outcome text CHECK ((hit_outcome IS NULL) OR (hit_outcome = ANY (ARRAY['sl'::text, 'tp'::text])))
);

CREATE TABLE IF NOT EXISTS trade_zone_bars (
  id bigint NOT NULL DEFAULT nextval('trade_zone_bars_id_seq'::regclass) PRIMARY KEY,
  zone_id bigint NOT NULL REFERENCES trade_zones(id) ON DELETE CASCADE,
  bar_time timestamp with time zone NOT NULL,
  bar_open numeric NOT NULL,
  bar_high numeric NOT NULL,
  bar_low numeric NOT NULL,
  bar_close numeric NOT NULL,
  bar_volume bigint NOT NULL,
  bar_index integer NOT NULL,
  mfe_from_start numeric,
  mae_from_start numeric,
  created_at timestamp with time zone DEFAULT now(),
  drawdown_from_entry numeric,
  runup_from_entry numeric,
  close_vs_entry numeric,
  high_since_entry numeric,
  retrace_from_peak numeric
);

-- The single-row settings table. CHECK forces id = 1 so the app's
-- "select * from trader_preferences where id = 1" query is always valid.
CREATE TABLE IF NOT EXISTS trader_preferences (
  id integer NOT NULL DEFAULT 1 PRIMARY KEY CHECK (id = 1),
  sl_points numeric,
  tp_points numeric,
  sl_enabled boolean,
  tp_enabled boolean,
  trail_enabled boolean,
  instrument_label text,
  timeframe text,
  selected_account text,
  updated_at timestamp with time zone DEFAULT now(),
  quantity integer,
  show_preview_sl_tp boolean,
  live_indicators jsonb DEFAULT '[]'::jsonb,
  practice_indicators jsonb DEFAULT '[]'::jsonb,
  chart_overlays jsonb
);

-- ─── Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS backtest_presets_updated_at_idx ON backtest_presets USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS checklist_categories_position_idx ON checklist_categories USING btree ("position");
CREATE INDEX IF NOT EXISTS checklist_completions_completion_date_idx ON checklist_completions USING btree (completion_date);
CREATE INDEX IF NOT EXISTS checklist_items_category_id_position_idx ON checklist_items USING btree (category_id, "position");
CREATE INDEX IF NOT EXISTS data_requests_status_idx ON data_requests USING btree (status) WHERE (status = 'pending'::text);
CREATE UNIQUE INDEX IF NOT EXISTS data_requests_unique_pending ON data_requests USING btree (instrument, timeframe, session_date) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));
CREATE INDEX IF NOT EXISTS idx_live_bars_instrument_time ON live_bars USING btree (instrument, bar_time DESC);
CREATE INDEX IF NOT EXISTS live_strategies_account_instrument_idx ON live_strategies USING btree (account_name, instrument);
CREATE INDEX IF NOT EXISTS live_strategies_heartbeat_idx ON live_strategies USING btree (last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS live_strategies_strategy_name_idx ON live_strategies USING btree (strategy_name);
CREATE INDEX IF NOT EXISTS note_folders_position_idx ON note_folders USING btree ("position", id);
CREATE INDEX IF NOT EXISTS notes_folder_idx ON notes USING btree (folder_id);
CREATE INDEX IF NOT EXISTS notes_pinned_idx ON notes USING btree (pinned) WHERE (pinned = true);
CREATE INDEX IF NOT EXISTS notes_updated_at_idx ON notes USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_replay_bars_session ON replay_bars USING btree (session_id, bar_index);
CREATE INDEX IF NOT EXISTS strategy_logs_created_idx ON strategy_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS strategy_logs_instance_created_idx ON strategy_logs USING btree (instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS strategy_logs_level_created_idx ON strategy_logs USING btree (level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_bars_trade_id ON trade_bars USING btree (trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_zone_bars_zone_id ON trade_zone_bars USING btree (zone_id);
CREATE INDEX IF NOT EXISTS idx_trade_zones_section_id ON trade_zones USING btree (section_id);

-- ─── Seed data ────────────────────────────────────────────────────────────
-- The app expects a 'default' zone_section to exist (sections-actions.ts uses
-- it as the fallback when a section is deleted). Insert it idempotently.

INSERT INTO zone_sections (name) VALUES ('default')
  ON CONFLICT (name) DO NOTHING;
