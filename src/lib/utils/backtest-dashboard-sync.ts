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

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { SimRules } from "./zone-simulator";
import { PresetFilters } from "./backtest-presets";

/** Snake-cased column names match the table layout in the matching
 *  migration (`backtest_dashboard_state`). */
const TABLE = "backtest_dashboard_state";
const ROW_ID = "singleton";

/** Module-level singleton Supabase client.
 *
 *  `createBrowserClient` is meant to be reused — every call instantiates
 *  fresh auth/realtime stacks. The dashboard fires `pushDashboardState`
 *  on every settled input change, so without this cache we'd rebuild
 *  the client (and its websocket plumbing) hundreds of times per
 *  session, adding GC pressure and incidental main-thread work that
 *  showed up as variable-change lag. SSR-safe: the lazy getter only
 *  runs the constructor in the browser. */
let cachedClient: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!cachedClient) cachedClient = createClient() as unknown as SupabaseClient;
  return cachedClient;
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

/** Snake_case row shape for upserts. Matches the migration columns. */
interface DashboardStateRow {
  id: string;
  state: DashboardSyncState;
  client_id: string | null;
  updated_at?: string;
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
    const supabase = getClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("state")
      .eq("id", ROW_ID)
      .maybeSingle();
    if (error) {
      // Missing table / not exposed via PostgREST → trip the disable
      // flag so subsequent pushes don't keep slamming the network.
      // 42P01 = relation does not exist; PGRST205 = schema cache miss.
      const code = (error as { code?: string }).code ?? "";
      if (code === "42P01" || code === "PGRST205") {
        tripSyncDisabled(`load failed (${code}): ${error.message}`);
      } else {
        console.warn("[dashboard-sync] load failed:", error.message);
      }
      return null;
    }
    if (!data) return null;
    const state = (data as { state: unknown }).state;
    if (!state || typeof state !== "object") return null;
    // Empty-object guard: a freshly-seeded singleton row holds {}, and
    // we don't want to apply that as "version: undefined" garbage.
    if (Object.keys(state as Record<string, unknown>).length === 0) return null;
    return state as DashboardSyncState;
  } catch (err) {
    console.warn("[dashboard-sync] load threw:", err);
    return null;
  }
}

/**
 * Upsert the singleton row with the new snapshot. Stamps the calling
 * `clientId` into `client_id` so the realtime payload fans out with
 * enough info for other tabs (and this tab) to recognize the source.
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
    const supabase = getClient();
    const row: DashboardStateRow = {
      id: ROW_ID,
      state,
      client_id: clientId,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from(TABLE)
      .upsert(row, { onConflict: "id" });
    if (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code === "42P01" || code === "PGRST205") {
        tripSyncDisabled(`upsert failed (${code}): ${error.message}`);
      } else {
        console.warn("[dashboard-sync] upsert failed:", error.message);
      }
    }
  } catch (err) {
    console.warn("[dashboard-sync] upsert threw:", err);
  }
}

/**
 * Subscribe to realtime UPDATE/INSERT events on the singleton row.
 * Calls `onUpdate(state)` whenever a DIFFERENT client (matched by
 * `client_id`) writes. Same-client echoes are filtered out so we
 * don't loop our own write back into our own state.
 *
 * Returns an unsubscribe function for useEffect cleanup. Idempotent —
 * removing the channel multiple times is harmless.
 */
export function subscribeToDashboardState(
  clientId: string,
  onUpdate: (state: DashboardSyncState) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  if (syncDisabled) return () => {};
  const supabase = getClient();
  const channel = supabase
    .channel("backtest-dashboard-state-realtime")
    .on(
      "postgres_changes",
      {
        // UPDATE only — INSERTs come from us seeding the singleton row,
        // and DELETEs aren't expected. Narrowing the event mask cuts
        // some realtime-side dispatch on every change.
        event: "UPDATE",
        schema: "public",
        table: TABLE,
        filter: `id=eq.${ROW_ID}`,
      },
      (payload) => {
        const row = payload.new as DashboardStateRow | null;
        if (!row || !row.state) return;
        // Echo-suppress: skip writes we made ourselves.
        if (row.client_id && row.client_id === clientId) return;
        // Defensive shape guard — apply the same empty-state filter as
        // loadDashboardState so a stray reset to {} doesn't blank UI.
        if (
          typeof row.state !== "object" ||
          Object.keys(row.state as unknown as Record<string, unknown>).length === 0
        ) {
          return;
        }
        onUpdate(row.state as DashboardSyncState);
      }
    )
    .subscribe((status, err) => {
      if (err) console.warn("[dashboard-sync] subscribe error:", err);
    });
  return () => {
    try {
      supabase.removeChannel(channel);
    } catch {
      // ignore — channel teardown errors shouldn't fail unmount.
    }
  };
}
