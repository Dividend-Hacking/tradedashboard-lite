/**
 * Supabase repo builders — shared between server and client stores.
 *
 * Each builder takes a Supabase client and returns the non-realtime
 * portion of one repo. Realtime methods are layered on by the client
 * store; the server store substitutes throwers because Realtime
 * requires a long-lived browser WebSocket.
 *
 * Behavioral notes:
 *   - Trades and trade_zones can exceed Supabase's 1000-row response
 *     cap; listAllOrderedByEntryTime / zones.listZones page through
 *     with .range() until exhausted (mirrors the helper in app/page.tsx).
 *   - replay_bars is paged similarly — a busy 1-second OHLCV session is
 *     ~23k bars and a single .select() truncates silently.
 *   - Tick-blob URLs use Supabase Storage's signed-URL feature so the
 *     browser can fetch the gzipped CSV without an auth header.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Trade, TradeBar } from "@/types/trade";
import type {
  Granularity,
  ReplaySession,
  ReplayBar,
  DataRequest,
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
import type { TradesRepo } from "./repos/trades";
import type { ReplayRepo } from "./repos/replay";
import type { PracticeRepo } from "./repos/practice";
import type { ZonesRepo } from "./repos/zones";
import type { LiveRepo } from "./repos/live";
import type { OrderRequestsRepo } from "./repos/order-requests";
import type { TraderPrefsRepo } from "./repos/trader-prefs";
import type { PresetsRepo } from "./repos/presets";
import type { DashboardStateRepo } from "./repos/dashboard-state";
import type { LiveBridgeEndpointRepo } from "./repos/livebridge-endpoint";
import type {
  TradeTagsPatch,
  NewDataRequest,
  NewPracticeSession,
  PracticeTradeInput,
  NewZone,
  ZoneBarInput,
  NewOrderRequest,
  LiveBridgeEndpointRow,
} from "./types";

const PAGE_SIZE = 1000;

/** Generic pager for tables that exceed Supabase's 1000-row cap. */
async function fetchAllPages<T>(
  client: SupabaseClient,
  table: string,
  orderColumn: string,
  ascending = true
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await client
      .from(table)
      .select("*")
      .order(orderColumn, { ascending })
      .range(from, to);
    if (error) throw new Error(error.message);
    const batch = (data as T[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

// ── trades ─────────────────────────────────────────────────────────────────

export function buildSupabaseTrades(
  client: SupabaseClient
): Omit<TradesRepo, "subscribeForInstrument" | "subscribeAll"> {
  return {
    async listAllOrderedByEntryTime() {
      return fetchAllPages<Trade>(client, "trades", "entry_time");
    },
    async listForInstrumentSinceUtc(instrument, sinceIso) {
      const { data, error } = await client
        .from("trades")
        .select("*")
        .eq("instrument", instrument)
        .gte("entry_time", sinceIso)
        .order("entry_time", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as Trade[]) ?? [];
    },
    async deleteByIds(ids) {
      if (ids.length === 0) return { deleted: 0 };
      const { error, count } = await client
        .from("trades")
        .delete({ count: "exact" })
        .in("id", ids);
      if (error) throw new Error(error.message);
      return { deleted: count ?? ids.length };
    },
    async updateTags(id, patch) {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        normalized[key] = value === "" ? null : value;
      }
      const { error } = await client
        .from("trades")
        .update(normalized)
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    async listBarsForTrade(tradeId) {
      const { data, error } = await client
        .from("trade_bars")
        .select(
          "id, trade_id, bar_index, bar_time, bar_open, bar_high, bar_low, bar_close, bar_volume, is_entry_bar, is_exit_bar"
        )
        .eq("trade_id", tradeId)
        .order("bar_index", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as TradeBar[]) ?? [];
    },
  };
}

// ── replay ─────────────────────────────────────────────────────────────────

export function buildSupabaseReplay(
  client: SupabaseClient
): Omit<ReplayRepo, "subscribeDataRequests"> {
  return {
    async listSessions() {
      const { data, error } = await client
        .from("replay_sessions")
        .select("*")
        .order("session_date", { ascending: false });
      if (error) throw new Error(error.message);
      return (data as ReplaySession[]) ?? [];
    },
    async getSession(id) {
      const { data, error } = await client
        .from("replay_sessions")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ReplaySession | null) ?? null;
    },
    async updateLastBarIndex(sessionId, lastBarIndex) {
      const { error } = await client
        .from("replay_sessions")
        .update({ last_bar_index: lastBarIndex })
        .eq("id", sessionId);
      if (error) throw new Error(error.message);
    },
    async deleteSessions(ids) {
      // Mirror the existing 5-batch deleteReplaySessions logic so we stay
      // under Supabase's 8s statement timeout when removing busy sessions.
      if (ids.length === 0) return { deleted: 0 };

      const { data: rows, error: fetchErr } = await client
        .from("replay_sessions")
        .select("id, tick_blob_path")
        .in("id", ids);
      if (fetchErr) return { deleted: 0, error: fetchErr.message };

      const blobPaths = (rows ?? [])
        .map((r) => (r as { tick_blob_path: string | null }).tick_blob_path)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      if (blobPaths.length > 0) {
        await client.storage.from("replay-ticks").remove(blobPaths);
      }

      const BATCH_SIZE = 5;
      let totalDeleted = 0;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const { error: barsErr } = await client
          .from("replay_bars")
          .delete()
          .in("session_id", batch);
        if (barsErr) {
          return {
            deleted: totalDeleted,
            error: `Bars delete failed at batch ${i}: ${barsErr.message}`,
          };
        }
        const { error: detachErr } = await client
          .from("data_requests")
          .update({ replay_session_id: null })
          .in("replay_session_id", batch);
        if (detachErr) {
          return {
            deleted: totalDeleted,
            error: `Detach failed at batch ${i}: ${detachErr.message}`,
          };
        }
        const { error: delErr, count } = await client
          .from("replay_sessions")
          .delete({ count: "exact" })
          .in("id", batch);
        if (delErr) {
          return {
            deleted: totalDeleted,
            error: `Sessions delete failed at batch ${i}: ${delErr.message}`,
          };
        }
        totalDeleted += count ?? batch.length;
      }
      return { deleted: totalDeleted };
    },
    async listBarsForSession(sessionId) {
      const rows: ReplayBar[] = [];
      let from = 0;
      while (true) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await client
          .from("replay_bars")
          .select("*")
          .eq("session_id", sessionId)
          .order("bar_index", { ascending: true })
          .range(from, to);
        if (error) throw new Error(error.message);
        const batch = (data as ReplayBar[]) ?? [];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) return rows;
        from += PAGE_SIZE;
      }
    },
    async listBarsForSessions(sessionIds) {
      const out = new Map<number, ReplayBar[]>();
      for (const id of sessionIds) {
        out.set(id, []);
      }
      if (sessionIds.length === 0) return out;
      let from = 0;
      while (true) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await client
          .from("replay_bars")
          .select("*")
          .in("session_id", sessionIds)
          .order("bar_index", { ascending: true })
          .range(from, to);
        if (error) throw new Error(error.message);
        const batch = (data as ReplayBar[]) ?? [];
        for (const row of batch) {
          const list = out.get(row.session_id);
          if (list) list.push(row);
        }
        if (batch.length < PAGE_SIZE) return out;
        from += PAGE_SIZE;
      }
    },
    async getTickBlobUrl(blobPath, expiresSec) {
      const { data, error } = await client.storage
        .from("replay-ticks")
        .createSignedUrl(blobPath, expiresSec);
      if (error || !data?.signedUrl) {
        throw new Error(error?.message ?? "Failed to sign tick blob URL");
      }
      return data.signedUrl;
    },
    async listPendingDataRequests() {
      const { data, error } = await client
        .from("data_requests")
        .select("*")
        .in("status", ["pending", "processing"])
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data as DataRequest[]) ?? [];
    },
    async findExistingSession(instrument, timeframe, sessionDate, granularity) {
      const { data, error } = await client
        .from("replay_sessions")
        .select("id")
        .eq("instrument", instrument)
        .eq("timeframe", timeframe)
        .eq("session_date", sessionDate)
        .eq("granularity", granularity)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: number } | null) ?? null;
    },
    async findInFlightRequest(instrument, timeframe, sessionDate, granularity) {
      const { data, error } = await client
        .from("data_requests")
        .select("id, status")
        .eq("instrument", instrument)
        .eq("timeframe", timeframe)
        .eq("session_date", sessionDate)
        .eq("granularity", granularity)
        .in("status", ["pending", "processing"])
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: number; status: string } | null) ?? null;
    },
    async insertDataRequest(req: NewDataRequest) {
      const { data, error } = await client
        .from("data_requests")
        .insert(req)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { id: (data as { id: number }).id };
    },
    async insertDataRequestsBulk(reqs: NewDataRequest[]) {
      if (reqs.length === 0) return { inserted: 0 };
      const { error } = await client.from("data_requests").insert(reqs);
      if (error) throw new Error(error.message);
      // Cloud has no UNIQUE on the active subset — no idempotent skip count
      // is available, so report the input length. Local mode reports actual.
      return { inserted: reqs.length };
    },
    async deleteDataRequests(ids: number[]) {
      if (ids.length === 0) return { deleted: 0 };
      const { error, count } = await client
        .from("data_requests")
        .delete({ count: "exact" })
        .in("id", ids);
      if (error) throw new Error(error.message);
      return { deleted: count ?? ids.length };
    },
    async listSessionsForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
      const { data, error } = await client
        .from("replay_sessions")
        .select("session_date")
        .ilike("instrument", `${base} %`)
        .eq("timeframe", timeframe)
        .eq("granularity", granularity)
        .gte("session_date", fromDate)
        .lte("session_date", toDate);
      if (error) throw new Error(error.message);
      return (data as { session_date: string }[]) ?? [];
    },
    async listInFlightForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
      const { data, error } = await client
        .from("data_requests")
        .select("session_date")
        .ilike("instrument", `${base} %`)
        .eq("timeframe", timeframe)
        .eq("granularity", granularity)
        .in("status", ["pending", "processing"])
        .gte("session_date", fromDate)
        .lte("session_date", toDate);
      if (error) throw new Error(error.message);
      return (data as { session_date: string }[]) ?? [];
    },
    // ── Local-only recovery surface ─────────────────────────────────────────
    //
    // The retry_count / claimed_at recovery loop is implemented for local
    // mode (SQLite) only. Cloud mode would need its own Postgres migration
    // and a server-side worker to drive the sweep; these stubs keep the
    // ReplayRepo interface shape uniform without committing cloud users to
    // semantics they haven't opted into.
    async listFailedForBaseInWindow() {
      return [];
    },
    async listNoDataForBaseInWindow() {
      return [];
    },
    async clearNoDataRequests() {
      return { cleared: 0 };
    },
    async recoverStaleRequests() {
      return { resetStuck: 0, retriedError: 0, gaveUp: 0 };
    },
    async getQueueSummary() {
      return {
        completed: 0,
        pending: 0,
        processing: 0,
        errored: 0,
        noData: 0,
        lastActivityAt: null,
      };
    },
    async retryAllErrored() {
      return { retried: 0 };
    },
    async listSessionsByInstrumentsAndTimeframes(instruments, timeframes) {
      const { data, error } = await client
        .from("replay_sessions")
        .select("id, instrument, timeframe, start_time, end_time")
        .in("instrument", instruments as string[])
        .in("timeframe", timeframes as string[]);
      if (error) throw new Error(error.message);
      return (data as Pick<
        ReplaySession,
        "id" | "instrument" | "timeframe" | "start_time" | "end_time"
      >[]) ?? [];
    },
    async listBarsForSessionInTimeRange(sessionId, fromIso, toIso) {
      const rows: ReplayBar[] = [];
      let from = 0;
      while (true) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await client
          .from("replay_bars")
          .select("*")
          .eq("session_id", sessionId)
          .gte("bar_time", fromIso)
          .lte("bar_time", toIso)
          .order("bar_time", { ascending: true })
          .range(from, to);
        if (error) throw new Error(error.message);
        const batch = (data as ReplayBar[]) ?? [];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) return rows;
        from += PAGE_SIZE;
      }
    },
  };
}

// ── practice ───────────────────────────────────────────────────────────────

export function buildSupabasePractice(client: SupabaseClient): PracticeRepo {
  return {
    async listSessions() {
      const { data, error } = await client
        .from("practice_sessions")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data as PracticeSession[]) ?? [];
    },
    async getSession(id) {
      const { data, error } = await client
        .from("practice_sessions")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as PracticeSession | null) ?? null;
    },
    async listTradesForSession(practiceSessionId) {
      const { data, error } = await client
        .from("practice_trades")
        .select("*")
        .eq("practice_session_id", practiceSessionId)
        .order("entry_time", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as PracticeTrade[]) ?? [];
    },
    async saveSession(session: NewPracticeSession, trades: PracticeTradeInput[]) {
      const { data: sessionData, error: sessionError } = await client
        .from("practice_sessions")
        .insert({
          replay_session_id: session.replay_session_id,
          ended_at: new Date().toISOString(),
          total_pnl_points: session.total_pnl_points,
          total_trades: trades.length,
          win_count: session.win_count,
          loss_count: session.loss_count,
          notes: session.notes ?? null,
        })
        .select("id")
        .single();
      if (sessionError || !sessionData) {
        throw new Error(sessionError?.message ?? "Failed to create practice session");
      }
      const practiceSessionId = (sessionData as { id: number }).id;
      if (trades.length > 0) {
        const tradeRows = trades.map((t) => ({
          practice_session_id: practiceSessionId,
          ...t,
        }));
        const { error: tradesError } = await client
          .from("practice_trades")
          .insert(tradeRows);
        if (tradesError) throw new Error(tradesError.message);
      }
      return { practiceSessionId };
    },
    async deleteSession(practiceSessionId) {
      const { error } = await client
        .from("practice_sessions")
        .delete()
        .eq("id", practiceSessionId);
      if (error) throw new Error(error.message);
    },
  };
}

// ── zones ──────────────────────────────────────────────────────────────────

export function buildSupabaseZones(
  client: SupabaseClient
): Omit<ZonesRepo, "subscribeZones" | "subscribeSections"> {
  return {
    async listZones() {
      return fetchAllPages<TradeZone>(client, "trade_zones", "start_time");
    },
    async saveZone(zone: NewZone, bars: ZoneBarInput[]) {
      const { data: zoneData, error: zoneError } = await client
        .from("trade_zones")
        .insert({
          ...zone,
          bar_count: bars.length,
        })
        .select("id")
        .single();
      if (zoneError || !zoneData) {
        throw new Error(zoneError?.message ?? "Failed to create zone");
      }
      const zoneId = (zoneData as { id: number }).id;
      if (bars.length > 0) {
        const barRows = bars.map((b) => ({ zone_id: zoneId, ...b }));
        const { error: barsError } = await client
          .from("trade_zone_bars")
          .insert(barRows);
        if (barsError) throw new Error(barsError.message);
      }
      return { zoneId };
    },
    async deleteZones(ids) {
      if (ids.length === 0) return { deleted: 0 };
      const { error, count } = await client
        .from("trade_zones")
        .delete({ count: "exact" })
        .in("id", ids);
      if (error) throw new Error(error.message);
      return { deleted: count ?? ids.length };
    },
    async listBarsForZone(zoneId) {
      const { data, error } = await client
        .from("trade_zone_bars")
        .select("*")
        .eq("zone_id", zoneId)
        .order("bar_index", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as TradeZoneBar[]) ?? [];
    },
    async listBarsForZones(zoneIds) {
      const out = new Map<number, TradeZoneBar[]>();
      if (zoneIds.length === 0) return out;
      const { data, error } = await client
        .from("trade_zone_bars")
        .select("*")
        .in("zone_id", zoneIds)
        .order("bar_index", { ascending: true });
      if (error) throw new Error(error.message);
      for (const row of (data as TradeZoneBar[]) ?? []) {
        const list = out.get(row.zone_id) ?? [];
        list.push(row);
        out.set(row.zone_id, list);
      }
      return out;
    },
    async listSections() {
      const { data, error } = await client
        .from("zone_sections")
        .select("*")
        .order("name", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as ZoneSection[]) ?? [];
    },
    async createSection(name) {
      const { data, error } = await client
        .from("zone_sections")
        .insert({ name })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return data as ZoneSection;
    },
    async renameSection(id, name) {
      const { error } = await client
        .from("zone_sections")
        .update({ name })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    async deleteSection(id) {
      const { error } = await client
        .from("zone_sections")
        .delete()
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    async findSectionByName(name) {
      const { data, error } = await client
        .from("zone_sections")
        .select("id, name")
        .eq("name", name)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: number; name: string } | null) ?? null;
    },
    async reassignZonesToSection(fromId, toId) {
      const { error } = await client
        .from("trade_zones")
        .update({ section_id: toId })
        .eq("section_id", fromId);
      if (error) throw new Error(error.message);
    },
    async listZonesInWindow(sectionId, instrument, fromIso, toIso) {
      let q = client
        .from("trade_zones")
        .select("*")
        .eq("instrument", instrument)
        .gte("start_time", fromIso)
        .lte("end_time", toIso)
        .order("start_time", { ascending: true });
      if (sectionId !== null) q = q.eq("section_id", sectionId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data as TradeZone[]) ?? [];
    },
    async countZonesPerSectionInWindow(instrument, fromIso, toIso) {
      const counts = new Map<number, number>();
      let from = 0;
      while (true) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await client
          .from("trade_zones")
          .select("section_id")
          .eq("instrument", instrument)
          .gte("start_time", fromIso)
          .lte("end_time", toIso)
          .range(from, to);
        if (error) throw new Error(error.message);
        const batch = (data as { section_id: number | null }[]) ?? [];
        for (const r of batch) {
          if (r.section_id == null) continue;
          counts.set(r.section_id, (counts.get(r.section_id) ?? 0) + 1);
        }
        if (batch.length < PAGE_SIZE) return counts;
        from += PAGE_SIZE;
      }
    },
  };
}

// ── live ───────────────────────────────────────────────────────────────────

export function buildSupabaseLive(
  client: SupabaseClient
): Omit<LiveRepo, "subscribeBars" | "subscribeStates" | "subscribeTicker"> {
  return {
    async listBarsForInstrument(instrument, timeframe, limit) {
      const { data, error } = await client
        .from("live_bars")
        .select("*")
        .eq("instrument", instrument)
        .eq("timeframe", timeframe)
        .order("bar_time", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      // Reverse so caller sees ascending order (matches existing live-trader code).
      return ((data as LiveBar[]) ?? []).reverse();
    },
    async deleteBarsForInstrument(instrument, timeframe) {
      const { error } = await client
        .from("live_bars")
        .delete()
        .eq("instrument", instrument)
        .eq("timeframe", timeframe);
      if (error) throw new Error(error.message);
    },
    async listStatesForInstrument(instrument) {
      const { data, error } = await client
        .from("live_state")
        .select("*")
        .eq("instrument", instrument);
      if (error) throw new Error(error.message);
      return (data as LiveState[]) ?? [];
    },
    async getTicker(instrument) {
      const { data, error } = await client
        .from("live_ticker")
        .select("*")
        .eq("instrument", instrument)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as LiveTicker | null) ?? null;
    },
    async listAccounts() {
      const { data, error } = await client
        .from("live_accounts")
        .select("*")
        .order("account_name", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as LiveAccount[]) ?? [];
    },
    async insertCommand(command) {
      const { error } = await client.from("live_commands").insert({ command });
      if (error) throw new Error(error.message);
    },
  };
}

// ── order_requests ─────────────────────────────────────────────────────────

export function buildSupabaseOrderRequests(client: SupabaseClient): OrderRequestsRepo {
  return {
    async insert(row: NewOrderRequest) {
      const { data, error } = await client
        .from("order_requests")
        .insert({
          instrument: row.instrument,
          account: row.account,
          action: row.action,
          sl_points: row.sl_points ?? null,
          tp_points: row.tp_points ?? null,
          trail_enabled: row.trail_enabled ?? false,
          new_sl_price: row.new_sl_price ?? null,
          new_tp_price: row.new_tp_price ?? null,
          quantity: row.quantity ?? 1,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { id: (data as { id: number }).id };
    },
  };
}

// ── trader_preferences ─────────────────────────────────────────────────────

export function buildSupabaseTraderPrefs(client: SupabaseClient): TraderPrefsRepo {
  return {
    async fetch() {
      const { data, error } = await client
        .from("trader_preferences")
        .select(
          "sl_points, tp_points, sl_enabled, tp_enabled, trail_enabled, instrument_label, timeframe, selected_account, quantity, show_preview_sl_tp, live_indicators, practice_indicators, chart_overlays"
        )
        .eq("id", 1)
        .maybeSingle();
      if (error || !data) return null;
      return data as TraderPreferences;
    },
    async upsertPatch(patch) {
      const { error } = await client
        .from("trader_preferences")
        .upsert(
          { id: 1, ...patch, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
      if (error) throw new Error(error.message);
    },
  };
}

// ── presets ────────────────────────────────────────────────────────────────

interface PresetRow {
  id: string;
  name: string;
  version: number;
  strategy_id: string;
  params: Record<string, number>;
  rules: BacktestPreset["rules"];
  filters: BacktestPreset["filters"];
  created_at: string;
  updated_at: string;
  // Added in the pipeline-bucket migration. Defaults to 'new' on the DB side
  // so any pre-existing rows show up at the leftmost stage on first load.
  bucket?: BacktestPreset["bucket"];
  // Added in the same migration so the v2 DSL fields actually round-trip
  // through Supabase (previously they only lived in localStorage and were
  // dropped on every cross-device sync).
  script?: string | null;
  param_meta?: BacktestPreset["paramMeta"] | null;
  // Free-form per-preset notes surfaced in the /pipeline detail panel.
  // Nullable so existing rows backfill cleanly.
  notes?: string | null;
}

function rowToPreset(row: PresetRow): BacktestPreset {
  return {
    version: row.version,
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    strategyId: row.strategy_id,
    params: row.params,
    rules: row.rules,
    filters: row.filters,
    bucket: row.bucket ?? "new",
    script: row.script ?? undefined,
    paramMeta: row.param_meta ?? undefined,
    notes: row.notes ?? undefined,
  };
}

function presetToRow(p: BacktestPreset): PresetRow {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    strategy_id: p.strategyId,
    params: p.params,
    rules: p.rules,
    filters: p.filters,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    bucket: p.bucket ?? "new",
    script: p.script ?? null,
    param_meta: p.paramMeta ?? null,
    notes: p.notes ?? null,
  };
}

export function buildSupabasePresets(client: SupabaseClient): PresetsRepo {
  return {
    async list() {
      const { data, error } = await client.from("backtest_presets").select("*");
      if (error) throw new Error(error.message);
      return ((data as PresetRow[]) ?? []).map(rowToPreset);
    },
    async upsert(preset) {
      const { error } = await client
        .from("backtest_presets")
        .upsert(presetToRow(preset), { onConflict: "id" });
      if (error) throw new Error(error.message);
    },
    async delete(id) {
      const { error } = await client
        .from("backtest_presets")
        .delete()
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
  };
}

// ── dashboard_state ────────────────────────────────────────────────────────

export function buildSupabaseDashboardState(
  client: SupabaseClient
): Omit<DashboardStateRepo, "subscribe"> {
  return {
    async load() {
      const { data, error } = await client
        .from("backtest_dashboard_state")
        .select("state")
        .eq("id", "singleton")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const state = (data as { state: unknown }).state;
      if (!state || typeof state !== "object") return null;
      if (Object.keys(state as Record<string, unknown>).length === 0) return null;
      return state as DashboardSyncState;
    },
    async push(state, clientId) {
      const { error } = await client
        .from("backtest_dashboard_state")
        .upsert(
          {
            id: "singleton",
            state,
            client_id: clientId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "id" }
        );
      if (error) throw new Error(error.message);
    },
  };
}

// ── livebridge_endpoint ────────────────────────────────────────────────────

export function buildSupabaseLiveBridgeEndpoint(
  client: SupabaseClient
): LiveBridgeEndpointRepo {
  return {
    async fetch() {
      const { data, error } = await client
        .from("livebridge_endpoint")
        .select("*")
        .eq("id", "default")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as LiveBridgeEndpointRow | null) ?? null;
    },
    async upsert(row) {
      const { error } = await client
        .from("livebridge_endpoint")
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
      if (error) throw new Error(error.message);
    },
  };
}
