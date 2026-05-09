/**
 * Local-mode SQLite repos.
 *
 * One module that implements the non-realtime portion of every Store
 * repo against the better-sqlite3 connection from db.ts. Used by:
 *   - src/lib/store/local-server.ts to back server-side getServerStore()
 *     calls when mode=local.
 *   - src/app/api/local/* route handlers, which expose these methods
 *     to the browser so client-side getClientStore() can fetch them.
 *
 * Returned shapes match the Supabase shapes exactly — booleans are
 * un-INTified, jsonb columns are JSON-parsed, NULLs are preserved.
 */

import crypto from "node:crypto";
import { getDb } from "./db";
import { readJson, writeJson, readBool, writeBool } from "./json";
import type { Trade, TradeBar } from "@/types/trade";
import type {
  Granularity,
  ReplaySession,
  ReplayBar,
  DataRequest,
  DataRequestQueueSummary,
  PracticeSession,
  PracticeTrade,
} from "@/types/replay";
import type {
  TradeZone,
  TradeZoneBar,
  ZoneSection,
} from "@/types/trade-zone";
import type {
  LiveBar,
  LiveTicker,
  LiveState,
  LiveAccount,
} from "@/types/live";
import type { TraderPreferences } from "@/lib/trader-preferences";
import type { BacktestPreset } from "@/lib/utils/backtest-presets";
import type { DashboardSyncState } from "@/lib/utils/backtest-dashboard-sync";
import type {
  TradeTagsPatch,
  NewDataRequest,
  NewPracticeSession,
  PracticeTradeInput,
  NewZone,
  ZoneBarInput,
  NewOrderRequest,
  LiveBridgeEndpointRow,
} from "@/lib/store/types";

// ── Row mappers ─────────────────────────────────────────────────────────────
//
// SQLite stores booleans as 0/1 and jsonb as TEXT. The mappers turn rows
// back into the cloud shape so callers don't need a per-mode branch.

function mapTrade(r: Record<string, unknown>): Trade {
  return {
    id: r.id as number,
    entry_time: r.entry_time as string,
    exit_time: r.exit_time as string | null,
    real_entry_time: r.real_entry_time as string | null,
    real_exit_time: r.real_exit_time as string | null,
    instrument: r.instrument as string,
    direction: r.direction as string,
    entry_price: r.entry_price as number,
    exit_price: r.exit_price as number | null,
    stop_loss_price: r.stop_loss_price as number | null,
    take_profit_price: r.take_profit_price as number | null,
    quantity: r.quantity as number | null,
    pnl_points: r.pnl_points as number | null,
    pnl_dollars: r.pnl_dollars as number | null,
    initial_stop_distance: r.initial_stop_distance as number | null,
    actual_rr: r.actual_rr as number | null,
    setup_rr: r.setup_rr as number | null,
    mfe_points: r.mfe_points as number | null,
    mae_points: r.mae_points as number | null,
    mfe_r_multiple: r.mfe_r_multiple as number | null,
    mae_r_multiple: r.mae_r_multiple as number | null,
    post_exit_mfe_points: r.post_exit_mfe_points as number | null,
    post_exit_mfe_r: r.post_exit_mfe_r as number | null,
    post_exit_mae_points: r.post_exit_mae_points as number | null,
    strategy_signal_name: r.strategy_signal_name as string | null,
    account_name: r.account_name as string | null,
    risk_units: r.risk_units as number | null,
    atr_multiplier: r.atr_multiplier as number | null,
    rr_multiplier: r.rr_multiplier as number | null,
    sl_mode: r.sl_mode as string | null,
    ctx_atr14: r.ctx_atr14 as number | null,
    ctx_atr14_15s: r.ctx_atr14_15s as number | null,
    ctx_price_vs_ema20: r.ctx_price_vs_ema20 as string | null,
    ctx_dist_ema20_atr: r.ctx_dist_ema20_atr as number | null,
    ctx_price_vs_ema200: r.ctx_price_vs_ema200 as string | null,
    ctx_dist_ema200_atr: r.ctx_dist_ema200_atr as number | null,
    ctx_bollinger_pos: r.ctx_bollinger_pos as string | null,
    ctx_bollinger_bw: r.ctx_bollinger_bw as number | null,
    ctx_market_regime: r.ctx_market_regime as string | null,
    ctx_adx14: r.ctx_adx14 as number | null,
    custom_tags: readJson<Record<string, unknown>>(r.custom_tags) as Record<string, unknown> | null,
    notes: r.notes as string | null,
    trade_grade: r.trade_grade as string | null,
    trade_mistake: r.trade_mistake as string | null,
    trade_regime: r.trade_regime as string | null,
    trade_status: r.trade_status as string,
    created_at: r.created_at as string | null,
  };
}

function mapReplaySession(r: Record<string, unknown>): ReplaySession {
  return {
    id: r.id as number,
    instrument: r.instrument as string,
    timeframe: r.timeframe as string,
    session_date: r.session_date as string,
    start_time: r.start_time as string,
    end_time: r.end_time as string,
    bar_count: r.bar_count as number,
    last_bar_index: r.last_bar_index as number,
    notes: r.notes as string | null,
    created_at: r.created_at as string,
    granularity: r.granularity as Granularity,
    tick_blob_path: r.tick_blob_path as string | null,
    tick_count: r.tick_count as number | null,
  };
}

function mapReplayBar(r: Record<string, unknown>): ReplayBar {
  return {
    id: r.id as number,
    session_id: r.session_id as number,
    bar_index: r.bar_index as number,
    bar_time: r.bar_time as string,
    bar_open: r.bar_open as number,
    bar_high: r.bar_high as number,
    bar_low: r.bar_low as number,
    bar_close: r.bar_close as number,
    bar_volume: r.bar_volume as number,
    bar_volume_bid: r.bar_volume_bid as number | null,
    bar_volume_ask: r.bar_volume_ask as number | null,
  };
}

function mapDataRequest(r: Record<string, unknown>): DataRequest {
  return {
    id: r.id as number,
    instrument: r.instrument as string,
    timeframe: r.timeframe as string,
    session_date: r.session_date as string,
    status: r.status as DataRequest["status"],
    error_message: r.error_message as string | null,
    replay_session_id: r.replay_session_id as number | null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    granularity: r.granularity as Granularity,
    retry_count: (r.retry_count as number | null) ?? 0,
    claimed_at: (r.claimed_at as string | null) ?? null,
  };
}

function mapPracticeSession(r: Record<string, unknown>): PracticeSession {
  return {
    id: r.id as number,
    replay_session_id: r.replay_session_id as number,
    started_at: r.started_at as string,
    ended_at: r.ended_at as string | null,
    total_pnl_points: (r.total_pnl_points as number | null) ?? 0,
    total_trades: (r.total_trades as number | null) ?? 0,
    win_count: (r.win_count as number | null) ?? 0,
    loss_count: (r.loss_count as number | null) ?? 0,
    notes: r.notes as string | null,
    created_at: r.created_at as string,
  };
}

function mapPracticeTrade(r: Record<string, unknown>): PracticeTrade {
  return {
    id: r.id as number,
    practice_session_id: r.practice_session_id as number,
    direction: r.direction as PracticeTrade["direction"],
    entry_bar_index: r.entry_bar_index as number,
    entry_price: r.entry_price as number,
    exit_bar_index: r.exit_bar_index as number | null,
    exit_price: r.exit_price as number | null,
    stop_loss_price: r.stop_loss_price as number | null,
    take_profit_price: r.take_profit_price as number | null,
    pnl_points: r.pnl_points as number | null,
    exit_reason: r.exit_reason as PracticeTrade["exit_reason"],
    entry_time: r.entry_time as string,
    exit_time: r.exit_time as string | null,
    created_at: r.created_at as string,
  };
}

function mapTradeZone(r: Record<string, unknown>): TradeZone {
  return {
    id: r.id as number,
    instrument: r.instrument as string,
    direction: r.direction as string,
    start_time: r.start_time as string,
    end_time: r.end_time as string,
    start_price: r.start_price as number,
    end_price: r.end_price as number,
    bar_count: r.bar_count as number,
    points_move: r.points_move as number,
    duration_seconds: r.duration_seconds as number,
    notes: r.notes as string | null,
    chart_timeframe: r.chart_timeframe as string | null,
    ctx_atr14: r.ctx_atr14 as number | null,
    ctx_adx14: r.ctx_adx14 as number | null,
    ctx_ema20: r.ctx_ema20 as number | null,
    ctx_ema200: r.ctx_ema200 as number | null,
    ctx_price_vs_ema20: r.ctx_price_vs_ema20 as string | null,
    ctx_price_vs_ema200: r.ctx_price_vs_ema200 as string | null,
    ctx_dist_ema20_atr: r.ctx_dist_ema20_atr as number | null,
    ctx_bollinger_pos: r.ctx_bollinger_pos as string | null,
    ctx_bollinger_bw: r.ctx_bollinger_bw as number | null,
    entry_hour: r.entry_hour as number | null,
    entry_day_of_week: r.entry_day_of_week as number | null,
    section_id: r.section_id as number | null,
    sl_price: r.sl_price as number | null,
    tp_price: r.tp_price as number | null,
    hit_outcome: r.hit_outcome as TradeZone["hit_outcome"],
    created_at: r.created_at as string,
  };
}

function mapTradeZoneBar(r: Record<string, unknown>): TradeZoneBar {
  return {
    id: r.id as number,
    zone_id: r.zone_id as number,
    bar_time: r.bar_time as string,
    bar_open: r.bar_open as number,
    bar_high: r.bar_high as number,
    bar_low: r.bar_low as number,
    bar_close: r.bar_close as number,
    bar_volume: r.bar_volume as number,
    bar_index: r.bar_index as number,
    mfe_from_start: r.mfe_from_start as number | null,
    mae_from_start: r.mae_from_start as number | null,
    drawdown_from_entry: r.drawdown_from_entry as number | null,
    runup_from_entry: r.runup_from_entry as number | null,
    close_vs_entry: r.close_vs_entry as number | null,
    high_since_entry: r.high_since_entry as number | null,
    retrace_from_peak: r.retrace_from_peak as number | null,
    created_at: r.created_at as string,
  };
}

function mapLiveBar(r: Record<string, unknown>): LiveBar {
  return {
    id: r.id as number,
    instrument: r.instrument as string,
    timeframe: r.timeframe as string,
    bar_time: r.bar_time as string,
    bar_open: r.bar_open as number,
    bar_high: r.bar_high as number,
    bar_low: r.bar_low as number,
    bar_close: r.bar_close as number,
    bar_volume: r.bar_volume as number,
    created_at: r.created_at as string,
  };
}

function mapLiveTicker(r: Record<string, unknown>): LiveTicker {
  return {
    instrument: r.instrument as string,
    last_price: r.last_price as number,
    bid: r.bid as number | null,
    ask: r.ask as number | null,
    updated_at: r.updated_at as string,
  };
}

function mapLiveState(r: Record<string, unknown>): LiveState {
  return {
    instrument: r.instrument as string,
    account: r.account as string,
    position_direction: r.position_direction as LiveState["position_direction"],
    position_quantity: (r.position_quantity as number | null) ?? 0,
    position_entry_price: (r.position_entry_price as number | null) ?? 0,
    unrealized_pnl: (r.unrealized_pnl as number | null) ?? 0,
    sl_price: r.sl_price as number | null,
    tp_price: r.tp_price as number | null,
    trail_enabled: !!readBool(r.trail_enabled),
    updated_at: r.updated_at as string,
  };
}

function mapLiveAccount(r: Record<string, unknown>): LiveAccount {
  return {
    account_name: r.account_name as string,
    updated_at: r.updated_at as string,
  };
}

// ── Trades ─────────────────────────────────────────────────────────────────

export const tradesRepo = {
  listAllOrderedByEntryTime(): Trade[] {
    const rows = getDb()
      .prepare("SELECT * FROM trades ORDER BY entry_time ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapTrade);
  },

  listForInstrumentSinceUtc(instrument: string, sinceIso: string): Trade[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM trades WHERE instrument = ? AND entry_time >= ? ORDER BY entry_time ASC"
      )
      .all(instrument, sinceIso) as Record<string, unknown>[];
    return rows.map(mapTrade);
  },

  deleteByIds(ids: number[]): { deleted: number } {
    if (ids.length === 0) return { deleted: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const info = getDb()
      .prepare(`DELETE FROM trades WHERE id IN (${placeholders})`)
      .run(...ids);
    return { deleted: info.changes };
  },

  updateTags(id: number, patch: TradeTagsPatch): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, raw] of Object.entries(patch)) {
      if (raw === undefined) continue;
      const value = raw === "" ? null : raw;
      sets.push(`${key} = ?`);
      params.push(key === "custom_tags" ? writeJson(value) : value);
    }
    if (sets.length === 0) return;
    params.push(id);
    getDb().prepare(`UPDATE trades SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  },

  /** Last entry_time across all trades — used by the polling realtime
   *  endpoint as a "since" cursor. */
  latestEntryTime(): string | null {
    const row = getDb()
      .prepare("SELECT MAX(entry_time) AS latest FROM trades")
      .get() as { latest: string | null } | undefined;
    return row?.latest ?? null;
  },

  listForInstrumentSince(instrument: string, sinceIso: string): Trade[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM trades WHERE instrument = ? AND entry_time > ? ORDER BY entry_time ASC"
      )
      .all(instrument, sinceIso) as Record<string, unknown>[];
    return rows.map(mapTrade);
  },

  listBarsForTrade(tradeId: number): TradeBar[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM trade_bars WHERE trade_id = ? ORDER BY bar_index ASC"
      )
      .all(tradeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      trade_id: r.trade_id as number,
      bar_index: r.bar_index as number,
      bar_time: r.bar_time as string,
      bar_open: r.bar_open as number | null,
      bar_high: r.bar_high as number | null,
      bar_low: r.bar_low as number | null,
      bar_close: r.bar_close as number | null,
      bar_volume: r.bar_volume as number | null,
      is_entry_bar: !!readBool(r.is_entry_bar),
      is_exit_bar: !!readBool(r.is_exit_bar),
    }));
  },
};

// ── Replay ─────────────────────────────────────────────────────────────────

export const replayRepo = {
  listSessions(): ReplaySession[] {
    const rows = getDb()
      .prepare("SELECT * FROM replay_sessions ORDER BY session_date DESC")
      .all() as Record<string, unknown>[];
    return rows.map(mapReplaySession);
  },

  getSession(id: number): ReplaySession | null {
    const row = getDb()
      .prepare("SELECT * FROM replay_sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapReplaySession(row) : null;
  },

  upsertSession(row: {
    instrument: string;
    timeframe: string;
    session_date: string;
    start_time: string;
    end_time: string;
    bar_count: number;
    granularity: Granularity;
    tick_blob_path?: string | null;
    tick_count?: number | null;
  }): { id: number } {
    // INSERT … ON CONFLICT to mirror PostgREST upsert semantics on the
    // (instrument, timeframe, session_date, granularity) UNIQUE constraint.
    const stmt = getDb().prepare(
      `INSERT INTO replay_sessions
        (instrument, timeframe, session_date, start_time, end_time, bar_count, granularity, tick_blob_path, tick_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instrument, timeframe, session_date, granularity) DO UPDATE SET
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         bar_count = excluded.bar_count,
         tick_blob_path = excluded.tick_blob_path,
         tick_count = excluded.tick_count
       RETURNING id`
    );
    const out = stmt.get(
      row.instrument,
      row.timeframe,
      row.session_date,
      row.start_time,
      row.end_time,
      row.bar_count,
      row.granularity,
      row.tick_blob_path ?? null,
      row.tick_count ?? null
    ) as { id: number };
    return { id: out.id };
  },

  updateLastBarIndex(sessionId: number, lastBarIndex: number): void {
    getDb()
      .prepare("UPDATE replay_sessions SET last_bar_index = ? WHERE id = ?")
      .run(lastBarIndex, sessionId);
  },

  patchTickBlob(sessionId: number, blobPath: string, tickCount: number | null): void {
    getDb()
      .prepare(
        "UPDATE replay_sessions SET tick_blob_path = ?, tick_count = ? WHERE id = ?"
      )
      .run(blobPath, tickCount, sessionId);
  },

  /** Returns the tick_blob_path values for the given ids — used by deleteSessions
   *  to compute which files on disk to clean up. */
  getTickBlobPathsForIds(ids: number[]): string[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT tick_blob_path FROM replay_sessions WHERE id IN (${placeholders}) AND tick_blob_path IS NOT NULL`
      )
      .all(...ids) as { tick_blob_path: string }[];
    return rows.map((r) => r.tick_blob_path);
  },

  deleteSessions(ids: number[]): { deleted: number } {
    if (ids.length === 0) return { deleted: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const db = getDb();
    // FK ON DELETE CASCADE on replay_bars + practice_sessions handles the
    // child rows. data_requests references replay_session_id with ON DELETE
    // SET NULL so those rows just lose the FK rather than cascading.
    const info = db
      .prepare(`DELETE FROM replay_sessions WHERE id IN (${placeholders})`)
      .run(...ids);
    return { deleted: info.changes };
  },

  listBarsForSession(sessionId: number): ReplayBar[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM replay_bars WHERE session_id = ? ORDER BY bar_index ASC"
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(mapReplayBar);
  },

  listBarsForSessions(sessionIds: number[]): Map<number, ReplayBar[]> {
    const out = new Map<number, ReplayBar[]>();
    for (const id of sessionIds) out.set(id, []);
    if (sessionIds.length === 0) return out;
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT * FROM replay_bars WHERE session_id IN (${placeholders}) ORDER BY bar_index ASC`
      )
      .all(...sessionIds) as Record<string, unknown>[];
    for (const raw of rows) {
      const row = mapReplayBar(raw);
      const list = out.get(row.session_id);
      if (list) list.push(row);
    }
    return out;
  },

  /** Bulk insert bars — used by /api/nt8/replay-bars when NT8 uploads. */
  insertBarsBulk(
    sessionId: number,
    bars: Array<{
      bar_index: number;
      bar_time: string;
      bar_open: number;
      bar_high: number;
      bar_low: number;
      bar_close: number;
      bar_volume: number;
      bar_volume_bid?: number | null;
      bar_volume_ask?: number | null;
    }>
  ): void {
    if (bars.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO replay_bars
        (session_id, bar_index, bar_time, bar_open, bar_high, bar_low, bar_close, bar_volume, bar_volume_bid, bar_volume_ask)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction((rows: typeof bars) => {
      for (const b of rows) {
        stmt.run(
          sessionId,
          b.bar_index,
          b.bar_time,
          b.bar_open,
          b.bar_high,
          b.bar_low,
          b.bar_close,
          b.bar_volume,
          b.bar_volume_bid ?? null,
          b.bar_volume_ask ?? null
        );
      }
    });
    tx(bars);
  },

  listPendingDataRequests(): DataRequest[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM data_requests WHERE status IN ('pending', 'processing') ORDER BY created_at DESC"
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapDataRequest);
  },

  /** NT8's polling endpoint — single oldest pending request. */
  pickNextPendingRequest(): DataRequest | null {
    const row = getDb()
      .prepare(
        "SELECT * FROM data_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
      )
      .get() as Record<string, unknown> | undefined;
    return row ? mapDataRequest(row) : null;
  },

  updateDataRequestStatus(
    id: number,
    patch: {
      status?: string;
      error_message?: string | null;
      replay_session_id?: number | null;
      claimed_at?: string | null;
      retry_count?: number;
    }
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.error_message !== undefined) {
      sets.push("error_message = ?");
      params.push(patch.error_message);
    }
    if (patch.replay_session_id !== undefined) {
      sets.push("replay_session_id = ?");
      params.push(patch.replay_session_id);
    }
    if (patch.claimed_at !== undefined) {
      sets.push("claimed_at = ?");
      params.push(patch.claimed_at);
    }
    if (patch.retry_count !== undefined) {
      sets.push("retry_count = ?");
      params.push(patch.retry_count);
    }
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(id);
    getDb()
      .prepare(`UPDATE data_requests SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  },

  findExistingSession(
    instrument: string,
    timeframe: string,
    sessionDate: string,
    granularity: Granularity
  ): { id: number } | null {
    const row = getDb()
      .prepare(
        `SELECT id FROM replay_sessions
         WHERE instrument = ? AND timeframe = ? AND session_date = ? AND granularity = ?`
      )
      .get(instrument, timeframe, sessionDate, granularity) as
      | { id: number }
      | undefined;
    return row ?? null;
  },

  findInFlightRequest(
    instrument: string,
    timeframe: string,
    sessionDate: string,
    granularity: Granularity
  ): { id: number; status: string } | null {
    const row = getDb()
      .prepare(
        `SELECT id, status FROM data_requests
         WHERE instrument = ? AND timeframe = ? AND session_date = ? AND granularity = ?
           AND status IN ('pending', 'processing') LIMIT 1`
      )
      .get(instrument, timeframe, sessionDate, granularity) as
      | { id: number; status: string }
      | undefined;
    return row ?? null;
  },

  insertDataRequest(req: NewDataRequest): { id: number } {
    const out = getDb()
      .prepare(
        `INSERT INTO data_requests (instrument, timeframe, session_date, granularity)
         VALUES (?, ?, ?, ?) RETURNING id`
      )
      .get(req.instrument, req.timeframe, req.session_date, req.granularity) as {
      id: number;
    };
    return out;
  },

  /**
   * Bulk-queue data requests, idempotent on the active set.
   *
   * The unique partial index `uq_active_data_requests` covers
   * (instrument, timeframe, session_date, granularity) WHERE status IN
   * ('pending','processing'), so OR IGNORE silently drops a row that's
   * already in flight. Two browser tabs submitting overlapping ranges
   * within the same millisecond can no longer create duplicate work.
   *
   * Completed/error rows are NOT in the partial index, so a NEW pending
   * row for a previously-completed (or failed) date is allowed — that's
   * how the gap-refill path works after deleting terminal failures.
   */
  insertDataRequestsBulk(reqs: NewDataRequest[]): { inserted: number } {
    if (reqs.length === 0) return { inserted: 0 };
    const db = getDb();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO data_requests (instrument, timeframe, session_date, granularity)
       VALUES (?, ?, ?, ?)`
    );
    let inserted = 0;
    const tx = db.transaction((rows: NewDataRequest[]) => {
      for (const r of rows) {
        const info = stmt.run(
          r.instrument,
          r.timeframe,
          r.session_date,
          r.granularity
        );
        inserted += info.changes;
      }
    });
    tx(reqs);
    return { inserted };
  },

  deleteDataRequests(ids: number[]): { deleted: number } {
    if (ids.length === 0) return { deleted: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const info = getDb()
      .prepare(`DELETE FROM data_requests WHERE id IN (${placeholders})`)
      .run(...ids);
    return { deleted: info.changes };
  },

  listSessionsForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string
  ): { session_date: string }[] {
    const rows = getDb()
      .prepare(
        `SELECT session_date FROM replay_sessions
         WHERE instrument LIKE ? || ' %'
           AND timeframe = ? AND granularity = ?
           AND session_date >= ? AND session_date <= ?`
      )
      .all(base, timeframe, granularity, fromDate, toDate) as {
      session_date: string;
    }[];
    return rows;
  },

  listInFlightForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string
  ): { session_date: string }[] {
    const rows = getDb()
      .prepare(
        `SELECT session_date FROM data_requests
         WHERE instrument LIKE ? || ' %'
           AND timeframe = ? AND granularity = ?
           AND status IN ('pending', 'processing')
           AND session_date >= ? AND session_date <= ?`
      )
      .all(base, timeframe, granularity, fromDate, toDate) as {
      session_date: string;
    }[];
    return rows;
  },

  /**
   * `no_data` rows in the window — broker confirmed no bars exist for this
   * date (off-calendar holiday, pre-contract date, broker outage marked
   * permanent, etc.). Gap detection adds these to `taken` so re-requesting
   * a range doesn't re-queue them. User can clear them via the banner's
   * "Clear no-data" button if they want to retry.
   */
  listNoDataForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string
  ): { session_date: string }[] {
    const rows = getDb()
      .prepare(
        `SELECT session_date FROM data_requests
         WHERE instrument LIKE ? || ' %'
           AND timeframe = ? AND granularity = ?
           AND status = 'no_data'
           AND session_date >= ? AND session_date <= ?`
      )
      .all(base, timeframe, granularity, fromDate, toDate) as {
      session_date: string;
    }[];
    return rows;
  },

  /** Drop every `no_data` row. Used by the banner's "Clear no-data" button —
   *  after this, the dates are back in the gap-detection candidate pool, so
   *  a re-submitted range request can re-queue them. */
  clearNoDataRequests(): { cleared: number } {
    const info = getDb()
      .prepare(`DELETE FROM data_requests WHERE status = 'no_data'`)
      .run();
    return { cleared: info.changes };
  },

  /**
   * Terminal-failed rows for a given base symbol/timeframe/granularity within
   * a date window — i.e. status='error' AND retry_count >= MAX. These are the
   * rows the sweeper has given up on; the gap-refill path deletes them so
   * `requestDateRangeExport` can re-queue those dates as fresh `pending`.
   */
  listFailedForBaseInWindow(
    base: string,
    timeframe: string,
    granularity: Granularity,
    fromDate: string,
    toDate: string,
    maxRetries: number = 3
  ): { id: number; session_date: string }[] {
    const rows = getDb()
      .prepare(
        `SELECT id, session_date FROM data_requests
         WHERE instrument LIKE ? || ' %'
           AND timeframe = ? AND granularity = ?
           AND status = 'error'
           AND retry_count >= ?
           AND session_date >= ? AND session_date <= ?`
      )
      .all(base, timeframe, granularity, maxRetries, fromDate, toDate) as {
      id: number;
      session_date: string;
    }[];
    return rows;
  },

  /**
   * Sweep stuck/transient-error rows back to `pending`.
   *
   * Two recovery paths, both bounded by retry_count to avoid hot loops:
   *
   *   1. `processing` rows whose claimed_at is older than `stuckAfterSec`
   *      (default 10min). These are NT8 crashes, VM disconnects, or the
   *      5-min BarsRequest timeout firing without a clean error PATCH.
   *      Reset to `pending`, null claimed_at, bump retry_count. Past the
   *      retry limit, mark terminal `error` so the queue stops re-trying.
   *
   *   2. `error` rows whose updated_at is older than `errorBackoffSec`
   *      (default 30s). Auto-retry transient errors (network blips, NT8
   *      restart). Permanent errors ("Instrument not found") just hit
   *      retry_count=3 and stop on their own.
   *
   * Cheap enough (indexed) to call on every NT8 GET poll. Returns a
   * summary so the caller can log it on demand.
   */
  recoverStaleRequests(opts?: {
    stuckAfterSec?: number;
    errorBackoffSec?: number;
    maxRetries?: number;
  }): { resetStuck: number; retriedError: number; gaveUp: number } {
    const stuckAfterSec = opts?.stuckAfterSec ?? 600; // 10 min
    const errorBackoffSec = opts?.errorBackoffSec ?? 30;
    const maxRetries = opts?.maxRetries ?? 3;
    const db = getDb();

    let resetStuck = 0;
    let retriedError = 0;
    let gaveUp = 0;

    const tx = db.transaction(() => {
      // (1a) Stuck `processing` under retry limit → back to pending.
      const resetInfo = db
        .prepare(
          `UPDATE data_requests
             SET status = 'pending',
                 claimed_at = NULL,
                 retry_count = retry_count + 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE status = 'processing'
             AND retry_count < ?
             AND claimed_at IS NOT NULL
             AND claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
        )
        .run(maxRetries, `-${stuckAfterSec} seconds`);
      resetStuck = resetInfo.changes;

      // (1b) Stuck `processing` over retry limit → terminal error.
      const giveUpInfo = db
        .prepare(
          `UPDATE data_requests
             SET status = 'error',
                 claimed_at = NULL,
                 error_message = COALESCE(error_message,
                   'Retry limit exceeded after stuck processing'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE status = 'processing'
             AND retry_count >= ?
             AND claimed_at IS NOT NULL
             AND claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
        )
        .run(maxRetries, `-${stuckAfterSec} seconds`);
      gaveUp = giveUpInfo.changes;

      // (2) Errored rows under retry limit + past the backoff → re-queue.
      const retryInfo = db
        .prepare(
          `UPDATE data_requests
             SET status = 'pending',
                 claimed_at = NULL,
                 retry_count = retry_count + 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE status = 'error'
             AND retry_count < ?
             AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
        )
        .run(maxRetries, `-${errorBackoffSec} seconds`);
      retriedError = retryInfo.changes;
    });
    tx();

    return { resetStuck, retriedError, gaveUp };
  },

  /**
   * Counts for the queue summary banner. Single SQL roundtrip — the
   * banner is server-rendered on every page load so this stays cheap.
   */
  getQueueSummary(): DataRequestQueueSummary {
    const db = getDb();
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'completed'  THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN status = 'error'      THEN 1 ELSE 0 END) AS errored,
           SUM(CASE WHEN status = 'no_data'    THEN 1 ELSE 0 END) AS noData,
           MAX(updated_at) AS lastActivityAt
         FROM data_requests`
      )
      .get() as {
      completed: number | null;
      pending: number | null;
      processing: number | null;
      errored: number | null;
      noData: number | null;
      lastActivityAt: string | null;
    };
    return {
      completed: counts.completed ?? 0,
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
      errored: counts.errored ?? 0,
      noData: counts.noData ?? 0,
      lastActivityAt: counts.lastActivityAt ?? null,
    };
  },

  /**
   * Reset every `error` row back to `pending` with retry_count=0.
   * Powers the "Retry errored" button in the queue banner — gives the
   * user a single click to re-attempt every failed day, including ones
   * that hit the auto-retry cap. Idempotent on the active set thanks to
   * the unique partial index: if a duplicate `pending` row already
   * exists for the same (instrument, timeframe, session_date,
   * granularity), the conflicting error row stays errored — but that's
   * fine, the active row will cover the work.
   */
  retryAllErrored(): { retried: number } {
    const db = getDb();
    // Two-step to dodge the partial unique index: select candidates that
    // don't already have an active twin, then update only those.
    const candidates = db
      .prepare(
        `SELECT id FROM data_requests e
          WHERE status = 'error'
            AND NOT EXISTS (
              SELECT 1 FROM data_requests a
              WHERE a.status IN ('pending','processing')
                AND a.instrument  = e.instrument
                AND a.timeframe   = e.timeframe
                AND a.session_date = e.session_date
                AND a.granularity = e.granularity
            )`
      )
      .all() as { id: number }[];
    if (candidates.length === 0) return { retried: 0 };
    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    const info = db
      .prepare(
        `UPDATE data_requests
            SET status = 'pending',
                retry_count = 0,
                claimed_at = NULL,
                error_message = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN (${placeholders})`
      )
      .run(...ids);
    return { retried: info.changes };
  },

  listSessionsByInstrumentsAndTimeframes(
    instruments: readonly string[],
    timeframes: readonly string[]
  ): Pick<
    ReplaySession,
    "id" | "instrument" | "timeframe" | "start_time" | "end_time"
  >[] {
    if (instruments.length === 0 || timeframes.length === 0) return [];
    const instrPlaceholders = instruments.map(() => "?").join(",");
    const tfPlaceholders = timeframes.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT id, instrument, timeframe, start_time, end_time
         FROM replay_sessions
         WHERE instrument IN (${instrPlaceholders})
           AND timeframe IN (${tfPlaceholders})`
      )
      .all(...instruments, ...timeframes) as Array<{
      id: number;
      instrument: string;
      timeframe: string;
      start_time: string;
      end_time: string;
    }>;
    return rows;
  },

  listBarsForSessionInTimeRange(
    sessionId: number,
    fromIso: string,
    toIso: string
  ): ReplayBar[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM replay_bars
         WHERE session_id = ? AND bar_time >= ? AND bar_time <= ?
         ORDER BY bar_time ASC`
      )
      .all(sessionId, fromIso, toIso) as Record<string, unknown>[];
    return rows.map(mapReplayBar);
  },
};

// ── Practice ───────────────────────────────────────────────────────────────

export const practiceRepo = {
  listSessions(): PracticeSession[] {
    const rows = getDb()
      .prepare("SELECT * FROM practice_sessions ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map(mapPracticeSession);
  },

  getSession(id: number): PracticeSession | null {
    const row = getDb()
      .prepare("SELECT * FROM practice_sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapPracticeSession(row) : null;
  },

  listTradesForSession(practiceSessionId: number): PracticeTrade[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM practice_trades WHERE practice_session_id = ? ORDER BY entry_time ASC"
      )
      .all(practiceSessionId) as Record<string, unknown>[];
    return rows.map(mapPracticeTrade);
  },

  saveSession(
    session: NewPracticeSession,
    trades: PracticeTradeInput[]
  ): { practiceSessionId: number } {
    const db = getDb();
    let practiceSessionId = 0;
    const tx = db.transaction(() => {
      const out = db
        .prepare(
          `INSERT INTO practice_sessions
            (replay_session_id, ended_at, total_pnl_points, total_trades, win_count, loss_count, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get(
          session.replay_session_id,
          new Date().toISOString(),
          session.total_pnl_points,
          trades.length,
          session.win_count,
          session.loss_count,
          session.notes ?? null
        ) as { id: number };
      practiceSessionId = out.id;
      if (trades.length > 0) {
        const stmt = db.prepare(
          `INSERT INTO practice_trades
            (practice_session_id, direction, entry_bar_index, entry_price,
             exit_bar_index, exit_price, stop_loss_price, take_profit_price,
             pnl_points, exit_reason, entry_time, exit_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const t of trades) {
          stmt.run(
            practiceSessionId,
            t.direction,
            t.entry_bar_index,
            t.entry_price,
            t.exit_bar_index,
            t.exit_price,
            t.stop_loss_price,
            t.take_profit_price,
            t.pnl_points,
            t.exit_reason,
            t.entry_time,
            t.exit_time
          );
        }
      }
    });
    tx();
    return { practiceSessionId };
  },

  deleteSession(practiceSessionId: number): void {
    getDb()
      .prepare("DELETE FROM practice_sessions WHERE id = ?")
      .run(practiceSessionId);
  },
};

// ── Zones ──────────────────────────────────────────────────────────────────

export const zonesRepo = {
  listZones(): TradeZone[] {
    const rows = getDb()
      .prepare("SELECT * FROM trade_zones ORDER BY start_time ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapTradeZone);
  },

  saveZone(zone: NewZone, bars: ZoneBarInput[]): { zoneId: number } {
    const db = getDb();
    let zoneId = 0;
    const tx = db.transaction(() => {
      const out = db
        .prepare(
          `INSERT INTO trade_zones
            (instrument, direction, start_time, end_time, start_price, end_price,
             points_move, duration_seconds, bar_count, chart_timeframe,
             section_id, sl_price, tp_price, hit_outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get(
          zone.instrument,
          zone.direction,
          zone.start_time,
          zone.end_time,
          zone.start_price,
          zone.end_price,
          zone.points_move,
          zone.duration_seconds,
          bars.length,
          zone.chart_timeframe,
          zone.section_id,
          zone.sl_price,
          zone.tp_price,
          zone.hit_outcome
        ) as { id: number };
      zoneId = out.id;
      if (bars.length > 0) {
        const stmt = db.prepare(
          `INSERT INTO trade_zone_bars
            (zone_id, bar_time, bar_open, bar_high, bar_low, bar_close, bar_volume,
             bar_index, mfe_from_start, mae_from_start,
             drawdown_from_entry, runup_from_entry, close_vs_entry,
             high_since_entry, retrace_from_peak)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const b of bars) {
          stmt.run(
            zoneId,
            b.bar_time,
            b.bar_open,
            b.bar_high,
            b.bar_low,
            b.bar_close,
            b.bar_volume,
            b.bar_index,
            b.mfe_from_start,
            b.mae_from_start,
            b.drawdown_from_entry,
            b.runup_from_entry,
            b.close_vs_entry,
            b.high_since_entry,
            b.retrace_from_peak
          );
        }
      }
    });
    tx();
    return { zoneId };
  },

  deleteZones(ids: number[]): { deleted: number } {
    if (ids.length === 0) return { deleted: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const info = getDb()
      .prepare(`DELETE FROM trade_zones WHERE id IN (${placeholders})`)
      .run(...ids);
    return { deleted: info.changes };
  },

  listBarsForZone(zoneId: number): TradeZoneBar[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM trade_zone_bars WHERE zone_id = ? ORDER BY bar_index ASC"
      )
      .all(zoneId) as Record<string, unknown>[];
    return rows.map(mapTradeZoneBar);
  },

  listBarsForZones(zoneIds: number[]): Map<number, TradeZoneBar[]> {
    const out = new Map<number, TradeZoneBar[]>();
    if (zoneIds.length === 0) return out;
    const placeholders = zoneIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT * FROM trade_zone_bars WHERE zone_id IN (${placeholders}) ORDER BY bar_index ASC`
      )
      .all(...zoneIds) as Record<string, unknown>[];
    for (const raw of rows) {
      const row = mapTradeZoneBar(raw);
      const list = out.get(row.zone_id) ?? [];
      list.push(row);
      out.set(row.zone_id, list);
    }
    return out;
  },

  listSections(): ZoneSection[] {
    const rows = getDb()
      .prepare("SELECT * FROM zone_sections ORDER BY name ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      created_at: r.created_at as string,
    }));
  },

  createSection(name: string): ZoneSection {
    const out = getDb()
      .prepare(
        "INSERT INTO zone_sections (name) VALUES (?) RETURNING id, name, created_at"
      )
      .get(name) as Record<string, unknown>;
    return {
      id: out.id as number,
      name: out.name as string,
      created_at: out.created_at as string,
    };
  },

  renameSection(id: number, name: string): void {
    getDb().prepare("UPDATE zone_sections SET name = ? WHERE id = ?").run(name, id);
  },

  deleteSection(id: number): void {
    getDb().prepare("DELETE FROM zone_sections WHERE id = ?").run(id);
  },

  findSectionByName(name: string): { id: number; name: string } | null {
    const row = getDb()
      .prepare("SELECT id, name FROM zone_sections WHERE name = ?")
      .get(name) as { id: number; name: string } | undefined;
    return row ?? null;
  },

  reassignZonesToSection(fromId: number, toId: number): void {
    getDb()
      .prepare("UPDATE trade_zones SET section_id = ? WHERE section_id = ?")
      .run(toId, fromId);
  },

  listZonesInWindow(
    sectionId: number | null,
    instrument: string,
    fromIso: string,
    toIso: string
  ): TradeZone[] {
    const sql = sectionId !== null
      ? `SELECT * FROM trade_zones
         WHERE section_id = ? AND instrument = ? AND start_time >= ? AND end_time <= ?
         ORDER BY start_time ASC`
      : `SELECT * FROM trade_zones
         WHERE instrument = ? AND start_time >= ? AND end_time <= ?
         ORDER BY start_time ASC`;
    const params = sectionId !== null
      ? [sectionId, instrument, fromIso, toIso]
      : [instrument, fromIso, toIso];
    const rows = getDb()
      .prepare(sql)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapTradeZone);
  },

  countZonesPerSectionInWindow(
    instrument: string,
    fromIso: string,
    toIso: string
  ): Map<number, number> {
    const rows = getDb()
      .prepare(
        `SELECT section_id, COUNT(*) AS cnt FROM trade_zones
         WHERE instrument = ? AND start_time >= ? AND end_time <= ?
           AND section_id IS NOT NULL
         GROUP BY section_id`
      )
      .all(instrument, fromIso, toIso) as Array<{
      section_id: number;
      cnt: number;
    }>;
    const out = new Map<number, number>();
    for (const r of rows) out.set(r.section_id, r.cnt);
    return out;
  },
};

// ── Live ───────────────────────────────────────────────────────────────────

export const liveRepo = {
  listBarsForInstrument(
    instrument: string,
    timeframe: string,
    limit: number
  ): LiveBar[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM live_bars
         WHERE instrument = ? AND timeframe = ?
         ORDER BY bar_time DESC LIMIT ?`
      )
      .all(instrument, timeframe, limit) as Record<string, unknown>[];
    return rows.map(mapLiveBar).reverse();
  },

  /** Used by the polling realtime endpoint — newer-than cursor. */
  listBarsForInstrumentSince(
    instrument: string,
    timeframe: string,
    sinceIso: string
  ): LiveBar[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM live_bars
         WHERE instrument = ? AND timeframe = ? AND bar_time > ?
         ORDER BY bar_time ASC`
      )
      .all(instrument, timeframe, sinceIso) as Record<string, unknown>[];
    return rows.map(mapLiveBar);
  },

  upsertBars(
    rows: Array<{
      instrument: string;
      timeframe: string;
      bar_time: string;
      bar_open: number;
      bar_high: number;
      bar_low: number;
      bar_close: number;
      bar_volume: number;
    }>
  ): void {
    if (rows.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO live_bars (instrument, timeframe, bar_time, bar_open, bar_high, bar_low, bar_close, bar_volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instrument, timeframe, bar_time) DO UPDATE SET
         bar_open = excluded.bar_open,
         bar_high = excluded.bar_high,
         bar_low = excluded.bar_low,
         bar_close = excluded.bar_close,
         bar_volume = excluded.bar_volume`
    );
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        stmt.run(
          r.instrument,
          r.timeframe,
          r.bar_time,
          r.bar_open,
          r.bar_high,
          r.bar_low,
          r.bar_close,
          r.bar_volume
        );
      }
    });
    tx(rows);
  },

  deleteBarsForInstrument(instrument: string, timeframe: string): void {
    getDb()
      .prepare("DELETE FROM live_bars WHERE instrument = ? AND timeframe = ?")
      .run(instrument, timeframe);
  },

  listStatesForInstrument(instrument: string): LiveState[] {
    const rows = getDb()
      .prepare("SELECT * FROM live_state WHERE instrument = ?")
      .all(instrument) as Record<string, unknown>[];
    return rows.map(mapLiveState);
  },

  upsertState(row: {
    instrument: string;
    account: string;
    position_direction?: string | null;
    position_quantity?: number | null;
    position_entry_price?: number | null;
    unrealized_pnl?: number | null;
    sl_price?: number | null;
    tp_price?: number | null;
    trail_enabled?: boolean | null;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO live_state
          (instrument, account, position_direction, position_quantity,
           position_entry_price, unrealized_pnl, sl_price, tp_price, trail_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(instrument, account) DO UPDATE SET
           position_direction = excluded.position_direction,
           position_quantity = excluded.position_quantity,
           position_entry_price = excluded.position_entry_price,
           unrealized_pnl = excluded.unrealized_pnl,
           sl_price = excluded.sl_price,
           tp_price = excluded.tp_price,
           trail_enabled = excluded.trail_enabled,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(
        row.instrument,
        row.account,
        row.position_direction ?? null,
        row.position_quantity ?? 0,
        row.position_entry_price ?? null,
        row.unrealized_pnl ?? 0,
        row.sl_price ?? null,
        row.tp_price ?? null,
        writeBool(row.trail_enabled ?? false)
      );
  },

  getTicker(instrument: string): LiveTicker | null {
    const row = getDb()
      .prepare("SELECT * FROM live_ticker WHERE instrument = ?")
      .get(instrument) as Record<string, unknown> | undefined;
    return row ? mapLiveTicker(row) : null;
  },

  upsertTicker(row: {
    instrument: string;
    last_price: number;
    bid?: number | null;
    ask?: number | null;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO live_ticker (instrument, last_price, bid, ask, updated_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(instrument) DO UPDATE SET
           last_price = excluded.last_price,
           bid = excluded.bid,
           ask = excluded.ask,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(row.instrument, row.last_price, row.bid ?? null, row.ask ?? null);
  },

  listAccounts(): LiveAccount[] {
    const rows = getDb()
      .prepare("SELECT * FROM live_accounts ORDER BY account_name ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapLiveAccount);
  },

  upsertAccount(accountName: string): void {
    getDb()
      .prepare(
        `INSERT INTO live_accounts (account_name, updated_at)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(account_name) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(accountName);
  },

  insertCommand(command: string): void {
    getDb()
      .prepare("INSERT INTO live_commands (command) VALUES (?)")
      .run(command);
  },

  listPendingCommands(): Array<{ id: number; command: string; status: string; created_at: string; updated_at: string }> {
    const rows = getDb()
      .prepare(
        "SELECT * FROM live_commands WHERE status = 'pending' ORDER BY created_at ASC"
      )
      .all() as Array<{ id: number; command: string; status: string; created_at: string; updated_at: string }>;
    return rows;
  },

  updateCommandStatus(id: number, status: string): void {
    getDb()
      .prepare(
        `UPDATE live_commands SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      )
      .run(status, id);
  },
};

// ── Order requests ─────────────────────────────────────────────────────────

export const orderRequestsRepo = {
  insert(row: NewOrderRequest): { id: number } {
    const out = getDb()
      .prepare(
        `INSERT INTO order_requests
          (instrument, account, action, sl_points, tp_points, trail_enabled,
           quantity, new_sl_price, new_tp_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        row.instrument,
        row.account,
        row.action,
        row.sl_points ?? null,
        row.tp_points ?? null,
        writeBool(row.trail_enabled ?? false),
        row.quantity ?? 1,
        row.new_sl_price ?? null,
        row.new_tp_price ?? null
      ) as { id: number };
    return out;
  },

  listPending(): Array<Record<string, unknown>> {
    return getDb()
      .prepare(
        "SELECT * FROM order_requests WHERE status = 'pending' ORDER BY created_at ASC"
      )
      .all() as Array<Record<string, unknown>>;
  },

  updateStatus(
    id: number,
    patch: { status?: string; error_message?: string | null; fill_price?: number | null }
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.error_message !== undefined) {
      sets.push("error_message = ?");
      params.push(patch.error_message);
    }
    if (patch.fill_price !== undefined) {
      sets.push("fill_price = ?");
      params.push(patch.fill_price);
    }
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(id);
    getDb()
      .prepare(`UPDATE order_requests SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  },
};

// ── Trader prefs ───────────────────────────────────────────────────────────

export const traderPrefsRepo = {
  fetch(): TraderPreferences | null {
    const row = getDb()
      .prepare("SELECT * FROM trader_preferences WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sl_points: row.sl_points as number | null,
      tp_points: row.tp_points as number | null,
      sl_enabled: readBool(row.sl_enabled),
      tp_enabled: readBool(row.tp_enabled),
      trail_enabled: readBool(row.trail_enabled),
      instrument_label: row.instrument_label as string | null,
      timeframe: row.timeframe as string | null,
      selected_account: row.selected_account as string | null,
      quantity: row.quantity as number | null,
      show_preview_sl_tp: readBool(row.show_preview_sl_tp),
      live_indicators: readJson(row.live_indicators),
      practice_indicators: readJson(row.practice_indicators),
      chart_overlays: readJson(row.chart_overlays),
    };
  },

  upsertPatch(patch: Partial<TraderPreferences>): void {
    // Flatten to columns, coercing booleans and stringifying jsonb fields.
    const columns: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (
        key === "sl_enabled" ||
        key === "tp_enabled" ||
        key === "trail_enabled" ||
        key === "show_preview_sl_tp"
      ) {
        columns[key] = writeBool(value as boolean | null | undefined);
      } else if (
        key === "live_indicators" ||
        key === "practice_indicators" ||
        key === "chart_overlays"
      ) {
        columns[key] = writeJson(value);
      } else {
        columns[key] = value;
      }
    }
    columns.updated_at = new Date().toISOString();

    const db = getDb();
    const cols = Object.keys(columns);
    const placeholders = cols.map(() => "?").join(", ");
    const setClause = cols.map((c) => `${c} = excluded.${c}`).join(", ");

    db.prepare(
      `INSERT INTO trader_preferences (id, ${cols.join(", ")})
       VALUES (1, ${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${setClause}`
    ).run(...cols.map((c) => columns[c]));
  },
};

// ── Presets ────────────────────────────────────────────────────────────────

export const presetsRepo = {
  list(): BacktestPreset[] {
    const rows = getDb()
      .prepare("SELECT * FROM backtest_presets")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      version: r.version as number,
      id: r.id as string,
      name: r.name as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      strategyId: r.strategy_id as string,
      params: readJson<Record<string, number>>(r.params) ?? {},
      rules: readJson(r.rules) as BacktestPreset["rules"],
      filters: readJson(r.filters) as BacktestPreset["filters"],
      bucket: ((r.bucket as string | undefined) ?? "new") as BacktestPreset["bucket"],
      script: (r.script as string | null | undefined) ?? undefined,
      paramMeta:
        readJson<BacktestPreset["paramMeta"]>(r.param_meta) ?? undefined,
    }));
  },

  upsert(preset: BacktestPreset): void {
    getDb()
      .prepare(
        `INSERT INTO backtest_presets
          (id, name, version, strategy_id, params, rules, filters,
           bucket, script, param_meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           strategy_id = excluded.strategy_id,
           params = excluded.params,
           rules = excluded.rules,
           filters = excluded.filters,
           bucket = excluded.bucket,
           script = excluded.script,
           param_meta = excluded.param_meta,
           updated_at = excluded.updated_at`
      )
      .run(
        preset.id,
        preset.name,
        preset.version,
        preset.strategyId,
        writeJson(preset.params),
        writeJson(preset.rules),
        writeJson(preset.filters),
        preset.bucket ?? "new",
        preset.script ?? null,
        preset.paramMeta ? writeJson(preset.paramMeta) : null,
        preset.createdAt,
        preset.updatedAt
      );
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM backtest_presets WHERE id = ?").run(id);
  },
};

// ── Dashboard state ────────────────────────────────────────────────────────

export const dashboardStateRepo = {
  load(): DashboardSyncState | null {
    const row = getDb()
      .prepare("SELECT state FROM backtest_dashboard_state WHERE id = 'singleton'")
      .get() as { state: string } | undefined;
    if (!row) return null;
    const state = readJson<Record<string, unknown>>(row.state);
    if (!state || Object.keys(state).length === 0) return null;
    return state as unknown as DashboardSyncState;
  },

  /** Returns the row's updated_at and client_id so the polling endpoint
   *  can echo-suppress and only return when something new happened. */
  loadWithMeta(): {
    state: DashboardSyncState;
    client_id: string | null;
    updated_at: string;
  } | null {
    const row = getDb()
      .prepare(
        "SELECT state, client_id, updated_at FROM backtest_dashboard_state WHERE id = 'singleton'"
      )
      .get() as
      | { state: string; client_id: string | null; updated_at: string }
      | undefined;
    if (!row) return null;
    const state = readJson<Record<string, unknown>>(row.state);
    if (!state || Object.keys(state).length === 0) return null;
    return {
      state: state as unknown as DashboardSyncState,
      client_id: row.client_id,
      updated_at: row.updated_at,
    };
  },

  push(state: DashboardSyncState, clientId: string): void {
    getDb()
      .prepare(
        `INSERT INTO backtest_dashboard_state (id, state, client_id, updated_at)
         VALUES ('singleton', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           client_id = excluded.client_id,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(writeJson(state), clientId);
  },
};

// ── Livebridge endpoint ────────────────────────────────────────────────────

export const livebridgeEndpointRepo = {
  fetch(): LiveBridgeEndpointRow | null {
    const row = getDb()
      .prepare("SELECT * FROM livebridge_endpoint WHERE id = 'default'")
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: "default",
      candidates: readJson(row.candidates) ?? [],
      port: row.port as number,
      updated_at: row.updated_at as string,
    };
  },

  upsert(row: Omit<LiveBridgeEndpointRow, "updated_at">): void {
    getDb()
      .prepare(
        `INSERT INTO livebridge_endpoint (id, candidates, port, updated_at)
         VALUES ('default', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(id) DO UPDATE SET
           candidates = excluded.candidates,
           port = excluded.port,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(writeJson(row.candidates), row.port);
  },
};

// ── Tick-blob URL signing ──────────────────────────────────────────────────
//
// Local mode has no real auth — the DB and tick blobs are on the user's
// own machine. We still return a URL with a short-lived HMAC token so the
// route can verify the path wasn't tampered with (defense in depth in case
// the dev server is bound to 0.0.0.0 for the VM and the same host happens
// to be on a hostile LAN). The token derives from a per-process startup
// nonce, so it only stays valid until the dev server restarts — fine for
// the intended replay-bar fetch flow.
//
// The key is cached on globalThis so that (a) HMR reloads of this module
// in dev don't regenerate it and invalidate already-minted URLs, and (b)
// the App Router's separate module registries for server components and
// route handlers both observe the same key — otherwise the signing path
// and verification path use different keys and every fetch returns 403.

type GlobalWithHmac = typeof globalThis & { __tradeDashTickHmacKey?: Buffer };
const gKey = globalThis as GlobalWithHmac;
const HMAC_KEY: Buffer =
  gKey.__tradeDashTickHmacKey ??
  (gKey.__tradeDashTickHmacKey = crypto.randomBytes(32));

export function signTickBlobPath(blobPath: string, expiresInSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  const sig = crypto
    .createHmac("sha256", HMAC_KEY)
    .update(`${blobPath}:${exp}`)
    .digest("hex");
  return `${exp}.${sig}`;
}

export function verifyTickBlobToken(blobPath: string, token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac("sha256", HMAC_KEY)
    .update(`${blobPath}:${exp}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(parts[1], "hex"),
    Buffer.from(expected, "hex")
  );
}
