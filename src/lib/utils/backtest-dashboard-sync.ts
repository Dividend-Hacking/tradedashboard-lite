/**
 * BacktestDashboardSync
 *
 * Cross-tab realtime sync for the BacktestDashboard's full input state.
 * Lets the user park the dashboard on two monitors at once: edit knobs on
 * monitor A, see the resulting backtest update on monitor B (or vice
 * versa) without any manual save/load step.
 *
 * Wire model:
 *   - Single Supabase row keyed by id='singleton' in
 *     `backtest_dashboard_state`. Column `state` is jsonb holding the
 *     full DashboardSyncState snapshot. Single user, so a singleton row
 *     mirrors the existing `trader_preferences` / `backtest_presets`
 *     no-RLS convention in this project.
 *   - Every page load mints a random `clientId` (tab-scoped, lives in a
 *     ref). Every write stamps that clientId into the row's `client_id`
 *     column. Realtime payloads whose `client_id` matches our own are
 *     ignored — that's the echo-suppression so a write doesn't bounce
 *     back into our own state.
 *   - Writes are debounced by callers; this layer just exposes a flat
 *     async upsert.
 *
 * Read path:
 *   - `loadDashboardState` is async (one round-trip on mount). Consumers
 *     are expected to render with their default in-memory state until
 *     the load resolves, then apply the remote snapshot through the
 *     same setters they'd use for a preset load.
 *   - `subscribeToDashboardState` opens a realtime channel and invokes
 *     `onUpdate` whenever a DIFFERENT client writes. Returns an unsub
 *     function; callers should wire this into a useEffect cleanup.
 *
 * Forward-compat:
 *   - `version` field on DashboardSyncState lets us migrate older saved
 *     snapshots when the shape changes. Today we just check the field
 *     and apply any future migration shim before returning to the caller.
 */

import { getClientStore, type Mode } from "@/lib/store";
import { SimRules } from "./zone-simulator";
import { PresetFilters } from "./backtest-presets";

/** Read the active mode from the window-level global the ModeProvider
 *  publishes on mount. Lets this plain util module pick the right
 *  backend without converting to a hook. */
function activeMode(): Mode {
  if (typeof window === "undefined") return "cloud";
  const w = window as unknown as { __tradeDashMode?: Mode };
  return w.__tradeDashMode ?? "cloud";
}

/** Hard-disable flag flipped on a 4xx that means "table missing / RLS
 *  blocked / schema cache stale". Once tripped, every subsequent push
 *  returns immediately so a misconfigured environment can't keep
 *  hammering the network on every keystroke. The flag clears on page
 *  reload — the user is expected to fix the underlying cause and
 *  refresh. We also keep a single console.warn (gated by another flag)
 *  so the user sees the cause once instead of one warning per push. */
let syncDisabled = false;
let syncWarned = false;
function tripSyncDisabled(reason: string): void {
  syncDisabled = true;
  if (!syncWarned) {
    syncWarned = true;
    console.warn(
      `[dashboard-sync] disabled for this page load: ${reason}. ` +
        `Likely cause: 'backtest_dashboard_state' table missing or not in supabase_realtime publication. ` +
        `Reload after fixing to re-enable sync.`
    );
  }
}

/** Schema version. Bump when the snapshot shape adds/removes/renames
 *  fields that older clients can't tolerate; bridge older rows in
 *  `loadDashboardState`. */
export const DASHBOARD_SYNC_SCHEMA_VERSION = 1;

/**
 * Full snapshot of every dashboard input that affects the backtest
 * computation. Mirrors the shape used to build presets, plus the day
 * picker fields (selected sessions + instrument/timeframe filters)
 * which are NOT part of presets but ARE part of "what determines what
 * I'm looking at right now".
 *
 * Things intentionally NOT synced (per-tab UI preferences):
 *   - mode (ui vs script editor) — each monitor can be in a different
 *     view mode without affecting the other.
 *   - scriptText — local editor draft state.
 *   - Optimizer in-flight state, modal open/close, toast — UI-only.
 *   - barsBySessionId — derived from selectedSessionIds and lazily
 *     fetched per-tab.
 */
export interface DashboardSyncState {
  version: number;
  /** Selected replay session ids (the day-picker selection). Stored as
   *  an array so it round-trips through JSON. */
  selectedSessionIds: number[];
  /** Day-picker instrument filter. Empty array = "All". */
  instrumentFilter: string[];
  /** Day-picker timeframe filter. Empty string = "All". */
  timeframeFilter: string;
  /** Active strategy id from the registry. */
  strategyId: string;
  /** Flat strategy parameter dict (any param key is allowed; the active
   *  generator reads what it needs). */
  params: Record<string, number>;
  /** Verbatim SimRules block — same shape used by presets. */
  rules: SimRules;
  /** Verbatim filter block — same shape used by presets. */
  filters: PresetFilters;
}

/** Generate a per-tab client id for echo-suppression. Re-uses the same
 *  format as backtest-presets.makeId so logs/debug feel consistent. */
export function generateClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Pull the singleton row and return its decoded state. Returns null if
 * the row is missing or the state is empty (`{}`) — callers should
 * treat null as "nothing remote yet, keep using local defaults" and
 * NOT clobber user-visible state with a partial shape.
 */
export async function loadDashboardState(): Promise<DashboardSyncState | null> {
  if (typeof window === "undefined") return null;
  if (syncDisabled) return null;
  try {
    const store = getClientStore(activeMode());
    return await store.dashboardState.load();
  } catch (err) {
    // Missing table / not exposed via PostgREST → trip the disable
    // flag so subsequent pushes don't keep slamming the network.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("42P01") || message.includes("PGRST205")) {
      tripSyncDisabled(`load failed: ${message}`);
    } else {
      console.warn("[dashboard-sync] load failed:", message);
    }
    return null;
  }
}

/**
 * Upsert the singleton row with the new snapshot. Stamps the calling
 * `clientId` so the realtime payload fans out with enough info for
 * other tabs (and this tab) to recognize the source.
 *
 * Fire-and-forget pattern: callers don't surface errors to the UI
 * since the local state already reflects the user's edit; the next
 * change will retry the write.
 */
export async function pushDashboardState(
  state: DashboardSyncState,
  clientId: string
): Promise<void> {
  if (typeof window === "undefined") return;
  if (syncDisabled) return;
  try {
    const store = getClientStore(activeMode());
    await store.dashboardState.push(state, clientId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("42P01") || message.includes("PGRST205")) {
      tripSyncDisabled(`upsert failed: ${message}`);
    } else {
      console.warn("[dashboard-sync] upsert failed:", message);
    }
  }
}

/**
 * Subscribe to realtime UPDATE events on the singleton row. Calls
 * `onUpdate(state)` whenever a DIFFERENT client writes (echo-suppressed
 * by the underlying repo). Returns an unsubscribe function.
 */
export function subscribeToDashboardState(
  clientId: string,
  onUpdate: (state: DashboardSyncState) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  if (syncDisabled) return () => {};
  const store = getClientStore(activeMode());
  return store.dashboardState.subscribe(clientId, (state) => {
    if (
      typeof state !== "object" ||
      Object.keys(state as unknown as Record<string, unknown>).length === 0
    ) {
      return;
    }
    onUpdate(state);
  });
}
