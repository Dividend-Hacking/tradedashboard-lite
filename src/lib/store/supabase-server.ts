/**
 * SupabaseServerStore — server-side Supabase implementation of the Store
 * interface. Used by server components, server actions, and route handlers
 * when the active mode is "cloud".
 *
 * Single Supabase client created once per call to buildSupabaseServerStore()
 * so multiple repo calls in one page render don't each await cookies().
 *
 * Realtime subscribe* methods throw — Realtime requires a long-lived
 * WebSocket connection from the browser, which has no analogue on the
 * server. Server contexts that need live data should fetch + render once
 * and let a client component handle subscriptions.
 */

import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "./index";
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

const subscribeNotSupportedOnServer = (): never => {
  throw new Error(
    "Realtime subscriptions are not supported on the server. " +
      "Move this call into a client component."
  );
};

export async function buildSupabaseServerStore(): Promise<Store> {
  const client = (await createClient()) as unknown as SupabaseClient;

  const trades: TradesRepo = {
    ...buildSupabaseTrades(client),
    subscribeForInstrument: subscribeNotSupportedOnServer,
    subscribeAll: subscribeNotSupportedOnServer,
  };
  const live: LiveRepo = {
    ...buildSupabaseLive(client),
    subscribeBars: subscribeNotSupportedOnServer,
    subscribeStates: subscribeNotSupportedOnServer,
    subscribeTicker: subscribeNotSupportedOnServer,
  };
  const dashboardState: DashboardStateRepo = {
    ...buildSupabaseDashboardState(client),
    subscribe: subscribeNotSupportedOnServer,
  };

  const replay: ReplayRepo = {
    ...buildSupabaseReplay(client),
    subscribeDataRequests: subscribeNotSupportedOnServer,
  };
  const practice: PracticeRepo = buildSupabasePractice(client);
  const zones: ZonesRepo = {
    ...buildSupabaseZones(client),
    subscribeZones: subscribeNotSupportedOnServer,
    subscribeSections: subscribeNotSupportedOnServer,
  };
  const orderRequests: OrderRequestsRepo = buildSupabaseOrderRequests(client);
  const traderPrefs: TraderPrefsRepo = buildSupabaseTraderPrefs(client);
  const presets: PresetsRepo = buildSupabasePresets(client);
  const livebridgeEndpoint: LiveBridgeEndpointRepo = buildSupabaseLiveBridgeEndpoint(client);

  return {
    mode: "cloud",
    trades,
    replay,
    practice,
    zones,
    live,
    orderRequests,
    traderPrefs,
    presets,
    dashboardState,
    livebridgeEndpoint,
  };
}
