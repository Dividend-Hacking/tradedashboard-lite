/**
 * Store — data-access factory for in-scope tables.
 *
 * The Store layer decouples call sites from the active backend. Every
 * in-scope read/write goes through a Repo method on this Store; the
 * factory `getClientStore(mode)` returns the right implementation based
 * on the active mode (cloud → Supabase, local → SQLite via /api/local).
 *
 * Out of scope: the AI assistant. It continues to import the Supabase
 * client directly because all of its tables stay on Supabase regardless
 * of mode.
 *
 * **Server vs client split**: this module is the *client-safe* entry.
 * Server components, server actions, and route handlers should import
 * `getServerStore` from `@/lib/store/server` instead. Mixing the two
 * would force Turbopack to pull `next/headers` (used by the Supabase
 * server client) into the browser bundle, which breaks the build.
 *
 * The interfaces themselves (TradesRepo, ReplayRepo, …) live in
 * src/lib/store/repos/* and are deliberately narrow: each method matches
 * a real call shape today, not an arbitrary PostgREST cosplay.
 */

import type { Mode } from "@/lib/mode";

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

export type { Mode };

/** The full surface area of in-scope data access. Add a repo here when
 *  introducing a new in-scope table; never widen call sites past this
 *  type — that's the whole point of the abstraction. */
export interface Store {
  mode: Mode;
  trades: TradesRepo;
  replay: ReplayRepo;
  practice: PracticeRepo;
  zones: ZonesRepo;
  live: LiveRepo;
  orderRequests: OrderRequestsRepo;
  traderPrefs: TraderPrefsRepo;
  presets: PresetsRepo;
  dashboardState: DashboardStateRepo;
  livebridgeEndpoint: LiveBridgeEndpointRepo;
}

// ─── Client-side factory ────────────────────────────────────────────────────

/**
 * Build a Store for use in the browser. The mode comes from the React
 * context provided at the root layout (server-injected) so we don't
 * ship the disk-reading logic to the client. Client repos either talk
 * to Supabase directly (cloud) or to /api/local/* (local).
 *
 * Client-only — server contexts should call `getServerStore()` from
 * `@/lib/store/server`.
 */
export function getClientStore(mode: Mode): Store {
  if (mode === "local") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("./local-client") as typeof import("./local-client");
    return m.buildLocalClientStore();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require("./supabase-client") as typeof import("./supabase-client");
  return m.buildSupabaseClientStore();
}
