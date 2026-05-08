/**
 * LocalClientStore — browser-side adapter that talks to the SQLite repos
 * over /api/local/rpc. Used by client components when the active mode
 * is "local".
 *
 * Realtime methods spin up setInterval polls against /api/local/realtime/*
 * endpoints (1.5s for live data, 2s for dashboard-state). Single user,
 * single machine — short polling is indistinguishable from real realtime
 * at this scale, and avoids the SSE/WebSocket plumbing. Cleanup clears
 * the interval.
 */

import type { Store } from "./index";
import type { Trade } from "@/types/trade";
import type { LiveBar, LiveTicker, LiveState } from "@/types/live";
import type { TradeZone, ZoneSection } from "@/types/trade-zone";
import type { DataRequest } from "@/types/replay";
import type { DashboardSyncState } from "@/lib/utils/backtest-dashboard-sync";

/** Make a JSON-RPC call to /api/local/rpc and unwrap the result. Map-shaped
 *  payloads are rebuilt from the { __map, entries } envelope. */
async function rpc(
  repo: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const res = await fetch("/api/local/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, method, args }),
  });
  const body = (await res.json()) as
    | { ok: true; result: unknown }
    | { ok: false; error: string };
  if (!body.ok) {
    throw new Error(`local rpc ${repo}.${method} failed: ${body.error}`);
  }
  return revive(body.result);
}

function revive(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { __map?: boolean }).__map === true
  ) {
    const entries = (value as { entries: Array<[unknown, unknown]> }).entries;
    return new Map(entries.map(([k, v]) => [k, revive(v)]));
  }
  if (Array.isArray(value)) return value.map(revive);
  return value;
}

const REALTIME_LIVE_MS = 1500;
const REALTIME_TRADES_MS = 2000;
const REALTIME_DASHBOARD_MS = 2000;

/** Poll one URL on a fixed interval. The fetcher should compute the next
 *  cursor and update the closure; cleanup clears the timer and stops the
 *  fetch loop. Errors are swallowed — single-user dev tool, log and move on. */
function startPolling(
  fetcher: () => Promise<void>,
  intervalMs: number
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (cancelled) return;
    try {
      await fetcher();
    } catch (err) {
      console.warn("[local-client] poll error:", err);
    }
    if (!cancelled) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

export function buildLocalClientStore(): Store {
  return {
    mode: "local",

    trades: {
      async listAllOrderedByEntryTime() {
        return (await rpc("trades", "listAllOrderedByEntryTime")) as Trade[];
      },
      async listForInstrumentSinceUtc(instrument, sinceIso) {
        return (await rpc("trades", "listForInstrumentSinceUtc", [
          instrument,
          sinceIso,
        ])) as Trade[];
      },
      async deleteByIds(ids) {
        return (await rpc("trades", "deleteByIds", [ids])) as { deleted: number };
      },
      async updateTags(id, patch) {
        await rpc("trades", "updateTags", [id, patch]);
      },
      async listBarsForTrade(tradeId) {
        return (await rpc("trades", "listBarsForTrade", [tradeId])) as Awaited<
          ReturnType<Store["trades"]["listBarsForTrade"]>
        >;
      },
      subscribeForInstrument(instrument, onChange) {
        let cursor = new Date().toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/trades?instrument=${encodeURIComponent(instrument)}&since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = (await res.json()) as Trade[];
          for (const row of rows) {
            if (row.entry_time > cursor) cursor = row.entry_time;
            onChange(row);
          }
        }, REALTIME_TRADES_MS);
      },
      subscribeAll(onChange) {
        // Cursor starts at "now" so we don't replay every existing trade
        // through onChange on mount — the consumer already has the
        // initial set from server-side getServerStore().
        let cursor = new Date().toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/trades-all?since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = (await res.json()) as Trade[];
          for (const row of rows) {
            const ts = row.created_at ?? row.entry_time;
            if (ts && ts > cursor) cursor = ts;
            // Local mode emits "update" for everything — the consumer's
            // upsert-on-id pattern handles both insert and update cases.
            onChange(row, "update");
          }
        }, REALTIME_TRADES_MS);
      },
    },

    replay: {
      async listSessions() {
        return (await rpc("replay", "listSessions")) as Awaited<
          ReturnType<Store["replay"]["listSessions"]>
        >;
      },
      async getSession(id) {
        return (await rpc("replay", "getSession", [id])) as Awaited<
          ReturnType<Store["replay"]["getSession"]>
        >;
      },
      async updateLastBarIndex(sessionId, lastBarIndex) {
        await rpc("replay", "updateLastBarIndex", [sessionId, lastBarIndex]);
      },
      async deleteSessions(ids) {
        return (await rpc("replay", "deleteSessions", [ids])) as Awaited<
          ReturnType<Store["replay"]["deleteSessions"]>
        >;
      },
      async listBarsForSession(sessionId) {
        return (await rpc("replay", "listBarsForSession", [sessionId])) as Awaited<
          ReturnType<Store["replay"]["listBarsForSession"]>
        >;
      },
      async listBarsForSessions(sessionIds) {
        return (await rpc("replay", "listBarsForSessions", [sessionIds])) as Awaited<
          ReturnType<Store["replay"]["listBarsForSessions"]>
        >;
      },
      async getTickBlobUrl(blobPath, expiresSec) {
        // Server-side signing happens via a tiny dedicated endpoint so the
        // HMAC key never leaves the server. /api/local/replay-ticks-url
        // returns the same format as the server-side store.
        const res = await fetch(
          `/api/local/replay-ticks-url?path=${encodeURIComponent(blobPath)}&expires=${expiresSec}`
        );
        if (!res.ok) throw new Error(`Failed to sign tick blob URL: ${res.status}`);
        const body = (await res.json()) as { url: string };
        return body.url;
      },
      async listPendingDataRequests() {
        return (await rpc("replay", "listPendingDataRequests")) as Awaited<
          ReturnType<Store["replay"]["listPendingDataRequests"]>
        >;
      },
      async findExistingSession(instrument, timeframe, sessionDate, granularity) {
        return (await rpc("replay", "findExistingSession", [
          instrument,
          timeframe,
          sessionDate,
          granularity,
        ])) as Awaited<ReturnType<Store["replay"]["findExistingSession"]>>;
      },
      async findInFlightRequest(instrument, timeframe, sessionDate, granularity) {
        return (await rpc("replay", "findInFlightRequest", [
          instrument,
          timeframe,
          sessionDate,
          granularity,
        ])) as Awaited<ReturnType<Store["replay"]["findInFlightRequest"]>>;
      },
      async insertDataRequest(req) {
        return (await rpc("replay", "insertDataRequest", [req])) as { id: number };
      },
      async insertDataRequestsBulk(reqs) {
        return (await rpc("replay", "insertDataRequestsBulk", [reqs])) as {
          inserted: number;
        };
      },
      async deleteDataRequests(ids) {
        return (await rpc("replay", "deleteDataRequests", [ids])) as {
          deleted: number;
        };
      },
      async listSessionsForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
        return (await rpc("replay", "listSessionsForBaseInWindow", [
          base,
          timeframe,
          granularity,
          fromDate,
          toDate,
        ])) as { session_date: string }[];
      },
      async listInFlightForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
        return (await rpc("replay", "listInFlightForBaseInWindow", [
          base,
          timeframe,
          granularity,
          fromDate,
          toDate,
        ])) as { session_date: string }[];
      },
      async listFailedForBaseInWindow(
        base,
        timeframe,
        granularity,
        fromDate,
        toDate,
        maxRetries
      ) {
        return (await rpc("replay", "listFailedForBaseInWindow", [
          base,
          timeframe,
          granularity,
          fromDate,
          toDate,
          maxRetries,
        ])) as { id: number; session_date: string }[];
      },
      async listNoDataForBaseInWindow(base, timeframe, granularity, fromDate, toDate) {
        return (await rpc("replay", "listNoDataForBaseInWindow", [
          base,
          timeframe,
          granularity,
          fromDate,
          toDate,
        ])) as { session_date: string }[];
      },
      async clearNoDataRequests() {
        return (await rpc("replay", "clearNoDataRequests", [])) as {
          cleared: number;
        };
      },
      async recoverStaleRequests(opts) {
        return (await rpc("replay", "recoverStaleRequests", [opts])) as {
          resetStuck: number;
          retriedError: number;
          gaveUp: number;
        };
      },
      async getQueueSummary() {
        return (await rpc("replay", "getQueueSummary", [])) as Awaited<
          ReturnType<Store["replay"]["getQueueSummary"]>
        >;
      },
      async retryAllErrored() {
        return (await rpc("replay", "retryAllErrored", [])) as {
          retried: number;
        };
      },
      subscribeDataRequests(onChange) {
        let cursor = new Date(0).toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/data-requests?since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = (await res.json()) as DataRequest[];
          for (const row of rows) {
            if (row.updated_at > cursor) cursor = row.updated_at;
            onChange(row, "update");
          }
        }, REALTIME_TRADES_MS);
      },
      async listSessionsByInstrumentsAndTimeframes(instruments, timeframes) {
        return (await rpc("replay", "listSessionsByInstrumentsAndTimeframes", [
          instruments,
          timeframes,
        ])) as Awaited<
          ReturnType<Store["replay"]["listSessionsByInstrumentsAndTimeframes"]>
        >;
      },
      async listBarsForSessionInTimeRange(sessionId, fromIso, toIso) {
        return (await rpc("replay", "listBarsForSessionInTimeRange", [
          sessionId,
          fromIso,
          toIso,
        ])) as Awaited<
          ReturnType<Store["replay"]["listBarsForSessionInTimeRange"]>
        >;
      },
    },

    practice: {
      async listSessions() {
        return (await rpc("practice", "listSessions")) as Awaited<
          ReturnType<Store["practice"]["listSessions"]>
        >;
      },
      async getSession(id) {
        return (await rpc("practice", "getSession", [id])) as Awaited<
          ReturnType<Store["practice"]["getSession"]>
        >;
      },
      async listTradesForSession(practiceSessionId) {
        return (await rpc("practice", "listTradesForSession", [practiceSessionId])) as Awaited<
          ReturnType<Store["practice"]["listTradesForSession"]>
        >;
      },
      async saveSession(session, trades) {
        return (await rpc("practice", "saveSession", [session, trades])) as {
          practiceSessionId: number;
        };
      },
      async deleteSession(practiceSessionId) {
        await rpc("practice", "deleteSession", [practiceSessionId]);
      },
    },

    zones: {
      async listZones() {
        return (await rpc("zones", "listZones")) as Awaited<
          ReturnType<Store["zones"]["listZones"]>
        >;
      },
      async saveZone(zone, bars) {
        return (await rpc("zones", "saveZone", [zone, bars])) as { zoneId: number };
      },
      async deleteZones(ids) {
        return (await rpc("zones", "deleteZones", [ids])) as { deleted: number };
      },
      async listBarsForZone(zoneId) {
        return (await rpc("zones", "listBarsForZone", [zoneId])) as Awaited<
          ReturnType<Store["zones"]["listBarsForZone"]>
        >;
      },
      async listBarsForZones(zoneIds) {
        return (await rpc("zones", "listBarsForZones", [zoneIds])) as Awaited<
          ReturnType<Store["zones"]["listBarsForZones"]>
        >;
      },
      async listSections() {
        return (await rpc("zones", "listSections")) as Awaited<
          ReturnType<Store["zones"]["listSections"]>
        >;
      },
      async createSection(name) {
        return (await rpc("zones", "createSection", [name])) as Awaited<
          ReturnType<Store["zones"]["createSection"]>
        >;
      },
      async renameSection(id, name) {
        await rpc("zones", "renameSection", [id, name]);
      },
      async deleteSection(id) {
        await rpc("zones", "deleteSection", [id]);
      },
      async findSectionByName(name) {
        return (await rpc("zones", "findSectionByName", [name])) as Awaited<
          ReturnType<Store["zones"]["findSectionByName"]>
        >;
      },
      async reassignZonesToSection(fromId, toId) {
        await rpc("zones", "reassignZonesToSection", [fromId, toId]);
      },
      subscribeZones(onChange) {
        let cursor = new Date().toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/trade-zones?since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = (await res.json()) as TradeZone[];
          for (const row of rows) {
            if (row.created_at > cursor) cursor = row.created_at;
            onChange(row, "update");
          }
        }, REALTIME_TRADES_MS);
      },
      async listZonesInWindow(sectionId, instrument, fromIso, toIso) {
        return (await rpc("zones", "listZonesInWindow", [
          sectionId,
          instrument,
          fromIso,
          toIso,
        ])) as Awaited<ReturnType<Store["zones"]["listZonesInWindow"]>>;
      },
      async countZonesPerSectionInWindow(instrument, fromIso, toIso) {
        return (await rpc("zones", "countZonesPerSectionInWindow", [
          instrument,
          fromIso,
          toIso,
        ])) as Awaited<
          ReturnType<Store["zones"]["countZonesPerSectionInWindow"]>
        >;
      },
      subscribeSections(onChange) {
        // Sections poll returns the full list each tick. We just compare
        // ids/names against the previous snapshot to fire upserts only
        // for things that changed; deletes are best-effort because the
        // local mode dashboard's manage-sections panel optimistically
        // updates anyway.
        let prev = new Map<number, string>();
        return startPolling(async () => {
          const res = await fetch("/api/local/realtime/zone-sections");
          if (!res.ok) return;
          const rows = (await res.json()) as ZoneSection[];
          const next = new Map(rows.map((s) => [s.id, s.name]));
          for (const row of rows) {
            const before = prev.get(row.id);
            if (before === undefined) {
              onChange(row, "insert");
            } else if (before !== row.name) {
              onChange(row, "update");
            }
          }
          for (const [id, name] of prev.entries()) {
            if (!next.has(id)) {
              onChange({ id, name, created_at: "" }, "delete");
            }
          }
          prev = next;
        }, REALTIME_DASHBOARD_MS);
      },
    },

    live: {
      async listBarsForInstrument(instrument, timeframe, limit) {
        return (await rpc("live", "listBarsForInstrument", [
          instrument,
          timeframe,
          limit,
        ])) as LiveBar[];
      },
      async deleteBarsForInstrument(instrument, timeframe) {
        await rpc("live", "deleteBarsForInstrument", [instrument, timeframe]);
      },
      async listStatesForInstrument(instrument) {
        return (await rpc("live", "listStatesForInstrument", [instrument])) as LiveState[];
      },
      async getTicker(instrument) {
        return (await rpc("live", "getTicker", [instrument])) as LiveTicker | null;
      },
      async listAccounts() {
        return (await rpc("live", "listAccounts")) as Awaited<
          ReturnType<Store["live"]["listAccounts"]>
        >;
      },
      async insertCommand(command) {
        await rpc("live", "insertCommand", [command]);
      },
      subscribeBars(instrument, timeframe, onChange) {
        let cursor = new Date(0).toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/live-bars?instrument=${encodeURIComponent(instrument)}&timeframe=${encodeURIComponent(timeframe)}&since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = (await res.json()) as LiveBar[];
          for (const row of rows) {
            if (row.bar_time > cursor) cursor = row.bar_time;
            onChange(row);
          }
        }, REALTIME_LIVE_MS);
      },
      subscribeStates(instrument, onChange) {
        let cursor = new Date(0).toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/live-state?instrument=${encodeURIComponent(instrument)}&since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const rows = (await res.json()) as LiveState[];
          for (const row of rows) {
            if (row.updated_at > cursor) cursor = row.updated_at;
            onChange(row);
          }
        }, REALTIME_LIVE_MS);
      },
      subscribeTicker(instrument, onChange) {
        let cursor = new Date(0).toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/live-ticker?instrument=${encodeURIComponent(instrument)}&since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const row = (await res.json()) as LiveTicker | null;
          if (row && row.updated_at > cursor) {
            cursor = row.updated_at;
            onChange(row);
          }
        }, REALTIME_LIVE_MS);
      },
    },

    orderRequests: {
      async insert(row) {
        return (await rpc("orderRequests", "insert", [row])) as { id: number };
      },
    },

    traderPrefs: {
      async fetch() {
        return (await rpc("traderPrefs", "fetch")) as Awaited<
          ReturnType<Store["traderPrefs"]["fetch"]>
        >;
      },
      async upsertPatch(patch) {
        await rpc("traderPrefs", "upsertPatch", [patch]);
      },
    },

    presets: {
      async list() {
        return (await rpc("presets", "list")) as Awaited<
          ReturnType<Store["presets"]["list"]>
        >;
      },
      async upsert(preset) {
        await rpc("presets", "upsert", [preset]);
      },
      async delete(id) {
        await rpc("presets", "delete", [id]);
      },
    },

    dashboardState: {
      async load() {
        return (await rpc("dashboardState", "load")) as DashboardSyncState | null;
      },
      async push(state, clientId) {
        await rpc("dashboardState", "push", [state, clientId]);
      },
      subscribe(clientId, onUpdate) {
        let cursor = new Date(0).toISOString();
        return startPolling(async () => {
          const url = `/api/local/realtime/dashboard-state?clientId=${encodeURIComponent(clientId)}&since=${encodeURIComponent(cursor)}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const body = (await res.json()) as
            | { state: DashboardSyncState; updated_at: string }
            | null;
          if (body && body.updated_at > cursor) {
            cursor = body.updated_at;
            onUpdate(body.state);
          }
        }, REALTIME_DASHBOARD_MS);
      },
    },

    livebridgeEndpoint: {
      async fetch() {
        return (await rpc("livebridgeEndpoint", "fetch")) as Awaited<
          ReturnType<Store["livebridgeEndpoint"]["fetch"]>
        >;
      },
      async upsert(row) {
        await rpc("livebridgeEndpoint", "upsert", [row]);
      },
    },
  };
}
