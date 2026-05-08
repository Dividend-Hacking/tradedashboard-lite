/**
 * SupabaseClientStore — browser-side Supabase implementation. Used by
 * client components when the active mode is "cloud". Realtime
 * subscriptions are wired through Supabase's postgres_changes channels.
 *
 * Reuses one cached Supabase client per page load. The browser client is
 * stateful (auth tokens, realtime sockets) so re-creating it per call is
 * wasteful and can cause subscription leaks.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type { Store } from "./index";
import type { Trade } from "@/types/trade";
import type { LiveBar, LiveTicker, LiveState } from "@/types/live";
import type { TradeZone, ZoneSection } from "@/types/trade-zone";
import type { DataRequest } from "@/types/replay";
import type { DashboardSyncState } from "@/lib/utils/backtest-dashboard-sync";

/** Map a Supabase postgres_changes eventType into our union. */
function mapKind(eventType: string): "insert" | "update" | "delete" {
  if (eventType === "INSERT") return "insert";
  if (eventType === "UPDATE") return "update";
  return "delete";
}
import {
  buildSupabaseTrades,
  buildSupabaseReplay,
  buildSupabasePractice,
  buildSupabaseZones,
  buildSupabaseLive,
  buildSupabaseOrderRequests,
  buildSupabaseTraderPrefs,
  buildSupabasePresets,
  buildSupabaseDashboardState,
  buildSupabaseLiveBridgeEndpoint,
} from "./supabase-shared";

let cached: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!cached) cached = createBrowserClient() as unknown as SupabaseClient;
  return cached;
}

export function buildSupabaseClientStore(): Store {
  const client = getClient();

  const baseTrades = buildSupabaseTrades(client);
  const baseLive = buildSupabaseLive(client);
  const baseDashboard = buildSupabaseDashboardState(client);

  return {
    mode: "cloud",
    trades: {
      ...baseTrades,
      subscribeForInstrument(instrument, onChange) {
        const channel = client
          .channel(`trades-realtime-${instrument}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "trades",
              filter: `instrument=eq.${instrument}`,
            },
            (payload) => {
              const row = (payload.new ?? payload.old) as Trade | null;
              if (row) onChange(row);
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
      subscribeAll(onChange) {
        const channel = client
          .channel("trades-realtime-all")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "trades" },
            (payload) => {
              const row = (payload.new ?? payload.old) as Trade | null;
              if (row) onChange(row, mapKind(payload.eventType));
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
    },

    live: {
      ...baseLive,
      subscribeBars(instrument, timeframe, onChange) {
        const channel = client
          .channel(`live-bars-${instrument}-${timeframe}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "live_bars",
              filter: `instrument=eq.${instrument}`,
            },
            (payload) => {
              const row = payload.new as LiveBar | null;
              // Server-side filter only matches instrument; check timeframe in JS.
              if (row && row.timeframe === timeframe) onChange(row);
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
      subscribeStates(instrument, onChange) {
        const channel = client
          .channel(`live-state-${instrument}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "live_state",
              filter: `instrument=eq.${instrument}`,
            },
            (payload) => {
              const row = (payload.new ?? payload.old) as LiveState | null;
              if (row) onChange(row);
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
      subscribeTicker(instrument, onChange) {
        const channel = client
          .channel(`live-ticker-${instrument}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "live_ticker",
              filter: `instrument=eq.${instrument}`,
            },
            (payload) => {
              const row = (payload.new ?? payload.old) as LiveTicker | null;
              if (row) onChange(row);
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
    },

    dashboardState: {
      ...baseDashboard,
      subscribe(clientId, onUpdate) {
        const channel = client
          .channel("backtest-dashboard-state-realtime")
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "backtest_dashboard_state",
              filter: "id=eq.singleton",
            },
            (payload) => {
              const row = payload.new as { state?: unknown; client_id?: string | null } | null;
              if (!row || !row.state) return;
              if (row.client_id && row.client_id === clientId) return;
              const stateObj = row.state as Record<string, unknown>;
              if (typeof stateObj !== "object" || Object.keys(stateObj).length === 0) return;
              onUpdate(stateObj as unknown as DashboardSyncState);
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
    },

    replay: {
      ...buildSupabaseReplay(client),
      subscribeDataRequests(onChange) {
        const channel = client
          .channel("data-requests-realtime-all")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "data_requests" },
            (payload) => {
              const row = (payload.new ?? payload.old) as DataRequest | null;
              if (row) onChange(row, mapKind(payload.eventType));
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
    },
    practice: buildSupabasePractice(client),
    zones: {
      ...buildSupabaseZones(client),
      subscribeZones(onChange) {
        const channel = client
          .channel("trade-zones-realtime-all")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "trade_zones" },
            (payload) => {
              const row = (payload.new ?? payload.old) as TradeZone | null;
              if (row) onChange(row, mapKind(payload.eventType));
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
      subscribeSections(onChange) {
        const channel = client
          .channel("zone-sections-realtime-all")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "zone_sections" },
            (payload) => {
              const row = (payload.new ?? payload.old) as ZoneSection | null;
              if (row) onChange(row, mapKind(payload.eventType));
            }
          )
          .subscribe();
        return () => {
          try { client.removeChannel(channel); } catch { /* noop */ }
        };
      },
    },
    orderRequests: buildSupabaseOrderRequests(client),
    traderPrefs: buildSupabaseTraderPrefs(client),
    presets: buildSupabasePresets(client),
    livebridgeEndpoint: buildSupabaseLiveBridgeEndpoint(client),
  };
}
