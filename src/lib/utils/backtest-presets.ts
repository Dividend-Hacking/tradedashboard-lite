/**
 * BacktestPresets
 *
 * Two-tier persistence for the Backtesting tab's full configuration: the
 * chosen strategy + its parameter values, the SimRules block (SL/TP/Trail/
 * BE/Timer/Scaling/Daily/Position-mode/ATR-adjust), and every entry filter
 * (time-of-day, ADX, ATR, trend, Bollinger).
 *
 * Storage layout:
 *   - **Supabase `backtest_presets` table** is the durable source of truth.
 *     Survives reinstalls, syncs across devices, recoverable if a browser
 *     wipes localStorage. Single-user, RLS off (matches `trader_preferences`
 *     pattern in the same project).
 *   - **localStorage** is a fast cache so the UI can render instantly on
 *     mount without an async round-trip — and so presets stay accessible if
 *     the network/Supabase are down.
 *
 * Read path:
 *   - `loadPresets()` is synchronous — returns the localStorage cache.
 *     Components seed initial state from this.
 *   - `syncPresetsFromSupabase()` pulls the server list in the background,
 *     reconciles with local cache by `updated_at` (last-write-wins), writes
 *     back to localStorage, and dispatches a "presets-changed" event so
 *     subscribed components refresh.
 *   - First-run migration: if Supabase is empty and localStorage has rows,
 *     the local rows are pushed up. Critical so existing presets aren't
 *     orphaned when the table first appears.
 *
 * Write path:
 *   - `createPreset` / `updatePreset` / `deletePreset` write to localStorage
 *     synchronously (so the UI updates immediately) AND fire a background
 *     Supabase write. The Supabase write is fire-and-forget — failures log
 *     but don't surface in the UI; the next `syncPresetsFromSupabase` will
 *     retry by re-uploading any local rows that are newer than server.
 *
 * Preset shape:
 *   - `strategyId` + `params` capture the strategy generator state.
 *   - `rules` is a verbatim SimRules — re-applied through setRules().
 *   - `filters` lifts the four context filters and the time-of-day filter
 *     into one nested object so the UI can apply them in one pass.
 *
 * Forward-compat:
 *   - `version` lets us migrate older saved presets when the shape changes
 *     (e.g. a new SimRules field) without throwing them away.
 *   - On load we deep-merge missing fields against the current defaults
 *     (mergePresetIntoDefaults), so a v1 preset still applies cleanly after
 *     v2 adds a field.
 */
import { SimRules, DEFAULT_SIM_RULES } from "./zone-simulator";
import { createClient } from "@/lib/supabase/client";

/** Schema version. Bump when the preset shape adds/removes/renames fields. */
export const PRESET_SCHEMA_VERSION = 1;

/** Bollinger position keys — must stay in sync with backtest-dashboard.tsx. */
export type BollingerPos = "above_upper" | "inside" | "below_lower";

/** Trend-mode enum — must stay in sync with backtest-dashboard.tsx. */
export type TrendMode = "any" | "with" | "against";

/**
 * Full filter snapshot. Each sub-filter mirrors the dashboard's local state
 * exactly so loading a preset is a straight setX-for-X pass.
 *
 * ⚠️  NT8 PRESET SYNC — READ BEFORE ADDING / RENAMING FILTER FIELDS  ⚠️
 *
 * This shape is serialized verbatim into the preset JSON files the dashboard
 * exports, AND those JSON files are read by the NinjaTrader 8 strategy via
 * PresetLoader.cs. Any change here that's not mirrored on the C# side gets
 * silently defaulted in NT8, producing a backtest that diverges from the
 * dashboard.
 *
 * **When you add or change a filter field on this interface, you MUST also:**
 *
 *   1. Update `ninjatrader/AddOns/PresetSchema.cs` → add the matching
 *      property on the `Filters` (or sub-filter) class.
 *   2. Update `ninjatrader/AddOns/PresetLoader.cs` → add the JSON-parse
 *      lines that map the camelCase JSON key into the new C# property.
 *   3. Update `ninjatrader/AddOns/PresetFilterEvaluator.cs` → wire the
 *      new field into the Pass() check so the filter actually gates
 *      signal acceptance in NT8.
 *   4. Run `cd ninjatrader && ./deploy-nt8.sh`, then F5 in NT8 to compile.
 *
 * Same rule applies to SimRules — see the matching block in zone-simulator.ts.
 */
/** Type of moving average for any of the configurable MA-based filters
 *  (trend legs, MA-distance). EMAs react faster to recent prices; SMAs
 *  give equal weight across the window. */
export type MaType = "ema" | "sma";

/** ADX slope direction at entry. "any" disables the filter; "rising" /
 *  "falling" gate on the sign of the slope; "flat" gates on |slope|
 *  staying within the configured threshold. */
export type AdxTrendMode = "any" | "rising" | "falling" | "flat";

/** "absolute" — |distance| in [min, max]; "above" — distance must be in
 *  [min, max] AND positive; "below" — must be negative AND in
 *  [-max, -min]. Lets users say "I want price within 1 ATR of EMA50" or
 *  "I want price at least 2 ATR ABOVE EMA50". */
export type MaDistanceMode = "absolute" | "above" | "below";

/** One time-of-day window. Same wrap-midnight semantics as before:
 *  from <= to    →   inclusive [from, to]
 *  from >  to    →   wraps midnight (e.g. 22:00→06:00). */
export interface TimeWindow {
  from: string; // HH:MM
  to: string;   // HH:MM
}

export interface PresetFilters {
  time: {
    enabled: boolean;
    /** Legacy single-window fields. Kept for backwards compat with stored
     *  presets and for consumers that haven't been updated to read the
     *  full `windows` array yet. When `windows` is populated these
     *  reflect the FIRST window. normalizePresetForLoad ensures both
     *  representations are in sync after load. */
    from: string;
    to: string;
    /** Multi-window source of truth. A bar passes when its time falls in
     *  ANY of these windows (OR semantics). Always non-empty after
     *  normalizePresetForLoad — older saves with just from/to get
     *  migrated to a single-element array. */
    windows: TimeWindow[];
  };
  adx: {
    enabled: boolean;
    min: number;
    max: number;
    /** Wilder ADX period. Defaults to 14 to preserve legacy behavior. */
    period: number;
  };
  atr: {
    enabled: boolean;
    min: number;
    max: number;
    /** Wilder ATR period. Defaults to 14. Drives BOTH this filter AND
     *  the per-rule ATR-adjust math on SL/TP/Trail/BE. */
    period: number;
  };
  trend: {
    enabled: boolean;
    ema20Mode: TrendMode;
    ema200Mode: TrendMode;
    /** Configurable "fast" trend leg. Period + type let users replace
     *  the legacy hardcoded EMA(20) with anything (e.g. EMA(9), SMA(50)). */
    fastPeriod: number;
    fastType: MaType;
    /** Configurable "slow" trend leg. */
    slowPeriod: number;
    slowType: MaType;
  };
  bollinger: {
    enabled: boolean;
    /** Stored as an array (not Set) so it round-trips through JSON. */
    allowed: BollingerPos[];
    /** Configurable BB period. Default 20. */
    period: number;
    /** Configurable stddev multiplier. Default 2.0 (i.e. ±2σ). */
    stdDev: number;
  };
  /** New filter: keep only entries whose Bollinger BAND WIDTH (upper −
   *  lower, in price points) sits in [min, max]. Useful for filtering
   *  out compressed-volatility ranges or wide chop. Shares the same BB
   *  period+stddev as the bollinger position filter so the user only
   *  has one setting to tune. */
  bbWidth: {
    enabled: boolean;
    min: number;
    max: number;
  };
  /** New filter: distance from a configurable MA at entry. Mode picks
   *  whether the gate is symmetric ("absolute") or directional. Min/max
   *  are in ATR units (using filters.atr.period) so the threshold is
   *  meaningful across instruments. */
  maDistance: {
    enabled: boolean;
    period: number;
    type: MaType;
    mode: MaDistanceMode;
    min: number;
    max: number;
  };
  /** New filter: current bar volume / N-bar average volume in [min, max].
   *  1.0 = at average. Lets users keep only "above-average volume"
   *  entries (min=1.5) or screen out volume spikes (max=3). */
  volume: {
    enabled: boolean;
    period: number;
    minRatio: number;
    maxRatio: number;
  };
  /** New filter: keep only entries whose Wilder RSI(period) at entry
   *  is in [min, max]. RSI is 0–100 — classic oversold/overbought
   *  ranges are < 30 / > 70 respectively. */
  rsi: {
    enabled: boolean;
    period: number;
    min: number;
    max: number;
  };
  /** New filter: gate on the DIRECTION of ADX at entry — rising,
   *  falling, or flat. Useful for e.g. "only trade when trend strength
   *  is building" (rising) or "only trade ranges" (flat).
   *  - lookback: bars looked back when computing the slope. Lives on
   *    IndicatorConfig.adxSlopeLookback so changes invalidate the
   *    backtest cache; this filter just stores the value alongside for
   *    preset round-trip parity.
   *  - flatThreshold: |slope| ≤ this is "flat". 1.0 default — small
   *    enough that single-bar Wilder noise doesn't tip a flat regime
   *    into rising/falling.
   *  - mode: "any" disables the filter (baseline for the optimizer). */
  adxTrend: {
    enabled: boolean;
    mode: AdxTrendMode;
    lookback: number;
    flatThreshold: number;
  };
}

/** A complete saved configuration. The id is a uuid-ish stable token so the
 *  list UI can key rows; createdAt/updatedAt are ISO strings for easy display.
 *
 *  ⚠️  NT8 PRESET SYNC — top-level fields and `params` ⚠️
 *
 *  This shape is the on-disk preset JSON layout. PresetLoader.cs in the NT8
 *  AddOns folder reads each top-level field by name. If you add a new
 *  top-level field here (alongside `strategyId`, `params`, `rules`,
 *  `filters`), wire it into PresetLoader.cs and PresetSchema.cs the same
 *  way as a SimRules field.
 *
 *  When you add a NEW STRATEGY (a new `strategyId` value with its own
 *  `params` keys), update:
 *    - src/lib/utils/preset-strategies.ts (TS signal generator)
 *    - ninjatrader/AddOns/PresetSignals.cs (C# port of the generator)
 *    - any new param keys must be readable from `params` on both sides
 *
 *  See the matching sync block on SimRules in zone-simulator.ts and on
 *  PresetFilters above for the full check-list. The diff tool at
 *  `scripts/diff-backtests.mjs` is the canonical way to verify parity
 *  after a change. */
export interface BacktestPreset {
  version: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  strategyId: string;
  params: Record<string, number>;
  rules: SimRules;
  filters: PresetFilters;
}

/** Default filter state — matches the initial useState defaults in
 *  backtest-dashboard.tsx so a "blank" preset would be a no-op overlay.
 *  Period/type defaults reproduce the legacy hardcoded values so a fresh
 *  preset behaves identically to pre-customization. */
export const DEFAULT_PRESET_FILTERS: PresetFilters = {
  time: {
    enabled: false,
    from: "09:30",
    to: "16:00",
    windows: [{ from: "09:30", to: "16:00" }],
  },
  adx: { enabled: false, min: 0, max: 100, period: 14 },
  atr: { enabled: false, min: 0, max: 100, period: 14 },
  trend: {
    enabled: false,
    ema20Mode: "with",
    ema200Mode: "any",
    fastPeriod: 20,
    fastType: "ema",
    slowPeriod: 200,
    slowType: "ema",
  },
  bollinger: {
    enabled: false,
    allowed: ["above_upper", "inside", "below_lower"],
    period: 20,
    stdDev: 2,
  },
  bbWidth: { enabled: false, min: 0, max: 1000 },
  maDistance: {
    enabled: false,
    period: 50,
    type: "ema",
    mode: "absolute",
    min: 0,
    max: 5,
  },
  volume: { enabled: false, period: 20, minRatio: 0, maxRatio: 100 },
  rsi: { enabled: false, period: 14, min: 0, max: 100 },
  adxTrend: {
    enabled: false,
    mode: "rising",
    lookback: 5,
    flatThreshold: 1,
  },
};

/** Single localStorage key — value is a JSON array of presets so we can
 *  read/write the whole list atomically without a separate index entry. */
const STORAGE_KEY = "backtest.presets.v1";

/** Safe guard for SSR — server has no window.localStorage. */
function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

/** Read the raw array. Returns [] on first run, parse errors, or SSR. */
export function loadPresets(): BacktestPreset[] {
  if (!hasStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as BacktestPreset[];
  } catch {
    // Corrupted JSON — fall back to empty rather than throwing into the UI.
    return [];
  }
}

/** Overwrite the saved array. Caller is responsible for sorting/uniqueness. */
function writePresets(presets: BacktestPreset[]): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

/** Generate a reasonably-unique id without pulling in a uuid lib. */
function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Inputs for createPreset — everything except the auto-managed fields. */
export interface NewPresetInput {
  name: string;
  strategyId: string;
  params: Record<string, number>;
  rules: SimRules;
  filters: PresetFilters;
}

/** Append a new preset to the saved list and return it. The list is kept
 *  in insertion order with newest first so the dropdown shows recent saves
 *  at the top without an explicit sort. localStorage is updated synchronously;
 *  Supabase write fires in the background. */
export function createPreset(input: NewPresetInput): BacktestPreset {
  const now = new Date().toISOString();
  const preset: BacktestPreset = {
    version: PRESET_SCHEMA_VERSION,
    id: makeId(),
    name: input.name.trim() || "Untitled preset",
    createdAt: now,
    updatedAt: now,
    strategyId: input.strategyId,
    // Defensive shallow copies — caller may keep mutating its state.
    params: { ...input.params },
    rules: { ...input.rules },
    filters: {
      time: {
        ...input.filters.time,
        // Deep-copy the windows array so callers can keep mutating their
        // local state without our stored copy aliasing.
        windows: (input.filters.time.windows ?? []).map((w) => ({
          from: w.from,
          to: w.to,
        })),
      },
      adx: { ...input.filters.adx },
      atr: { ...input.filters.atr },
      trend: { ...input.filters.trend },
      bollinger: {
        ...input.filters.bollinger,
        allowed: [...input.filters.bollinger.allowed],
      },
      bbWidth: { ...input.filters.bbWidth },
      maDistance: { ...input.filters.maDistance },
      volume: { ...input.filters.volume },
      rsi: { ...input.filters.rsi },
      adxTrend: { ...input.filters.adxTrend },
    },
  };
  const next = [preset, ...loadPresets()];
  writePresets(next);
  pushPresetToSupabase(preset).catch(() => {});
  emitPresetsChanged();
  return preset;
}

/** Replace an existing preset's payload (keeps id + createdAt, bumps
 *  updatedAt). Returns the updated preset, or null if the id wasn't found. */
export function updatePreset(
  id: string,
  patch: Partial<NewPresetInput>
): BacktestPreset | null {
  const list = loadPresets();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const prev = list[idx];
  const next: BacktestPreset = {
    ...prev,
    name: (patch.name ?? prev.name).trim() || prev.name,
    strategyId: patch.strategyId ?? prev.strategyId,
    params: patch.params ? { ...patch.params } : prev.params,
    rules: patch.rules ? { ...patch.rules } : prev.rules,
    filters: patch.filters
      ? {
          time: {
            ...patch.filters.time,
            windows: (patch.filters.time.windows ?? []).map((w) => ({
              from: w.from,
              to: w.to,
            })),
          },
          adx: { ...patch.filters.adx },
          atr: { ...patch.filters.atr },
          trend: { ...patch.filters.trend },
          bollinger: {
            ...patch.filters.bollinger,
            allowed: [...patch.filters.bollinger.allowed],
          },
          bbWidth: { ...patch.filters.bbWidth },
          maDistance: { ...patch.filters.maDistance },
          volume: { ...patch.filters.volume },
          rsi: { ...patch.filters.rsi },
          adxTrend: { ...patch.filters.adxTrend },
        }
      : prev.filters,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = next;
  writePresets(list);
  pushPresetToSupabase(next).catch(() => {});
  emitPresetsChanged();
  return next;
}

/** Remove a preset by id. No-op if not found. localStorage update is
 *  synchronous; Supabase delete fires in the background. */
export function deletePreset(id: string): void {
  const next = loadPresets().filter((p) => p.id !== id);
  writePresets(next);
  deletePresetFromSupabase(id).catch(() => {});
  emitPresetsChanged();
}

/**
 * Merge a saved preset's rules into the current DEFAULT_SIM_RULES so any
 * SimRules fields added since the preset was saved get sensible defaults
 * instead of `undefined`. Same deal for filters: missing sub-filters fall
 * back to the current defaults. This is the load-time forward-compat shim.
 */
export function normalizePresetForLoad(preset: BacktestPreset): BacktestPreset {
  return {
    ...preset,
    rules: { ...DEFAULT_SIM_RULES, ...preset.rules },
    filters: {
      time: (() => {
        // Build the time block defensively: pull whatever fields the
        // saved preset has, then synthesize `windows` from from/to if
        // missing (older presets predate multi-window). Conversely,
        // when `windows` is present, mirror windows[0] back into
        // from/to so legacy consumers (auto-trader summary string,
        // simulator-panel state) keep showing the right value.
        const merged = {
          ...DEFAULT_PRESET_FILTERS.time,
          ...(preset.filters?.time ?? {}),
        };
        const rawWindows = preset.filters?.time?.windows;
        const windows: TimeWindow[] =
          Array.isArray(rawWindows) && rawWindows.length > 0
            ? rawWindows.map((w) => ({
                from: w?.from ?? merged.from,
                to: w?.to ?? merged.to,
              }))
            : [{ from: merged.from, to: merged.to }];
        return {
          ...merged,
          windows,
          from: windows[0].from,
          to: windows[0].to,
        };
      })(),
      adx: { ...DEFAULT_PRESET_FILTERS.adx, ...(preset.filters?.adx ?? {}) },
      atr: { ...DEFAULT_PRESET_FILTERS.atr, ...(preset.filters?.atr ?? {}) },
      trend: {
        ...DEFAULT_PRESET_FILTERS.trend,
        ...(preset.filters?.trend ?? {}),
      },
      bollinger: {
        ...DEFAULT_PRESET_FILTERS.bollinger,
        ...(preset.filters?.bollinger ?? {}),
        // Always force an array — older saves might have an undefined here.
        allowed:
          preset.filters?.bollinger?.allowed ??
          DEFAULT_PRESET_FILTERS.bollinger.allowed,
      },
      // New post-customization filters — older saves don't have these
      // keys at all, so deep-merge against the defaults so they always
      // resolve to a complete shape after load.
      bbWidth: {
        ...DEFAULT_PRESET_FILTERS.bbWidth,
        ...(preset.filters?.bbWidth ?? {}),
      },
      maDistance: {
        ...DEFAULT_PRESET_FILTERS.maDistance,
        ...(preset.filters?.maDistance ?? {}),
      },
      volume: {
        ...DEFAULT_PRESET_FILTERS.volume,
        ...(preset.filters?.volume ?? {}),
      },
      rsi: {
        ...DEFAULT_PRESET_FILTERS.rsi,
        ...(preset.filters?.rsi ?? {}),
      },
      adxTrend: {
        ...DEFAULT_PRESET_FILTERS.adxTrend,
        ...(preset.filters?.adxTrend ?? {}),
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Supabase sync layer
// ─────────────────────────────────────────────────────────────────────────

/** Custom event name dispatched after any preset change (local mutation or
 *  Supabase pull). Components subscribe to this on `window` to refresh their
 *  cached presets list without polling. */
export const PRESETS_CHANGED_EVENT = "backtest-presets-changed";

/** Fire the change event. Wrapped so SSR (no window) is a no-op. */
function emitPresetsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PRESETS_CHANGED_EVENT));
}

/** Map a Supabase row (snake_case columns) into the BacktestPreset shape
 *  the rest of the app uses. Defensive about missing/null jsonb sub-objects
 *  for the same forward-compat reason as normalizePresetForLoad. */
interface PresetRow {
  id: string;
  name: string;
  version: number;
  strategy_id: string;
  params: Record<string, number>;
  rules: SimRules;
  filters: PresetFilters;
  created_at: string;
  updated_at: string;
}

function rowToPreset(row: PresetRow): BacktestPreset {
  return {
    version: row.version ?? PRESET_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    strategyId: row.strategy_id,
    params: row.params ?? {},
    rules: row.rules ?? DEFAULT_SIM_RULES,
    filters: row.filters ?? DEFAULT_PRESET_FILTERS,
  };
}

/** Inverse of rowToPreset — produce the snake_case shape for upsert. */
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
  };
}

/** Upsert a single preset to Supabase. Fire-and-forget at call sites; we
 *  don't surface failures to the UI because the localStorage write already
 *  succeeded and the next sync will retry. */
async function pushPresetToSupabase(preset: BacktestPreset): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const supabase = createClient();
    const { error } = await supabase
      .from("backtest_presets")
      .upsert(presetToRow(preset), { onConflict: "id" });
    if (error) {
      console.warn("[backtest-presets] Supabase upsert failed:", error.message);
    }
  } catch (err) {
    console.warn("[backtest-presets] Supabase upsert threw:", err);
  }
}

/** Delete a preset from Supabase by id. Fire-and-forget. */
async function deletePresetFromSupabase(id: string): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const supabase = createClient();
    const { error } = await supabase
      .from("backtest_presets")
      .delete()
      .eq("id", id);
    if (error) {
      console.warn("[backtest-presets] Supabase delete failed:", error.message);
    }
  } catch (err) {
    console.warn("[backtest-presets] Supabase delete threw:", err);
  }
}

/**
 * Pull the full preset list from Supabase, reconcile with local cache by
 * `updated_at`, and rewrite localStorage to the merged result. Dispatches
 * `presets-changed` if anything changed so subscribed components refresh.
 *
 * Reconciliation rules (single-user, no auth, last-write-wins):
 *   - Server has row, local doesn't → take server (covers a fresh device).
 *   - Local has row, server doesn't → push local up (first-run migration
 *     OR a row created while offline). Important: we don't *delete* local
 *     rows that are missing from the server, because the user might have
 *     just created them on this device before this sync ran.
 *   - Both have the row → keep whichever has the newer `updatedAt`. Push
 *     local up if local is newer.
 *
 * Returns the merged preset list. Safe to call multiple times concurrently
 * (idempotent upserts).
 */
export async function syncPresetsFromSupabase(): Promise<BacktestPreset[]> {
  if (typeof window === "undefined") return [];

  let serverRows: PresetRow[] = [];
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("backtest_presets")
      .select("*");
    if (error) {
      console.warn("[backtest-presets] Supabase fetch failed:", error.message);
      return loadPresets();
    }
    serverRows = (data ?? []) as PresetRow[];
  } catch (err) {
    console.warn("[backtest-presets] Supabase fetch threw:", err);
    return loadPresets();
  }

  const local = loadPresets();
  const localById = new Map(local.map((p) => [p.id, p]));
  const serverById = new Map(serverRows.map((r) => [r.id, rowToPreset(r)]));

  const merged: BacktestPreset[] = [];
  const idsToPush: BacktestPreset[] = [];

  // Walk every id seen on either side.
  const allIds = new Set<string>([...localById.keys(), ...serverById.keys()]);
  for (const id of allIds) {
    const localCopy = localById.get(id);
    const serverCopy = serverById.get(id);

    if (localCopy && serverCopy) {
      // Both exist — pick whichever has the newer updatedAt. Equal timestamps
      // resolve to the server side so all devices converge to a single source
      // when no real edit has happened.
      const localTs = Date.parse(localCopy.updatedAt);
      const serverTs = Date.parse(serverCopy.updatedAt);
      if (Number.isFinite(localTs) && localTs > serverTs) {
        merged.push(localCopy);
        idsToPush.push(localCopy);
      } else {
        merged.push(serverCopy);
      }
    } else if (serverCopy) {
      // Only on server — adopt it locally.
      merged.push(serverCopy);
    } else if (localCopy) {
      // Only local — push up. Could be first-run migration or an offline edit.
      merged.push(localCopy);
      idsToPush.push(localCopy);
    }
  }

  // Sort newest-first to match the createPreset insertion ordering, so the
  // dropdown UI feels consistent regardless of where data came from.
  merged.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );

  // Persist the merged result to localStorage. Detect whether we actually
  // changed anything before emitting an event so we don't trigger needless
  // re-renders on a no-op sync.
  const before = JSON.stringify(local);
  const after = JSON.stringify(merged);
  if (before !== after) {
    writePresets(merged);
    emitPresetsChanged();
  }

  // Push any locally-newer rows up. Don't await — the sync result has
  // already been returned to the caller; uploads can finish in their own time.
  for (const p of idsToPush) {
    pushPresetToSupabase(p).catch(() => {});
  }

  return merged;
}
