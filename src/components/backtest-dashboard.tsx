/**
 * BacktestDashboard
 *
 * The "Backtesting" tab. Walkthrough:
 *   1. User picks one or more downloaded sessions (replay_sessions rows) from
 *      the day picker. Each session is one instrument/timeframe/date already
 *      in Supabase from the practice-trading data export pipeline.
 *   2. User picks a strategy. Strategy registry is `STRATEGIES` in
 *      backtest-engine.ts — adding a strategy there auto-populates the
 *      dropdown and the parameter editor (paramFields drives the inputs).
 *   3. User adjusts strategy parameters (lookback, ATR thresholds, etc.) and
 *      the standard SimRules (SL/TP/Trail/BE/Timer/Scaling) via the same
 *      SimulatorControls component the risk simulator uses.
 *   4. The dashboard fetches replay_bars for the selected sessions on demand
 *      (only when a day toggles on, cached after that), runs the strategy +
 *      backtest engine, and renders the results using the SAME components as
 *      the risk simulator — stat cards, equity curve, per-trade chart,
 *      per-day chart, results table.
 *
 * Design notes:
 *   - Bar fetches are per-session and cached in a Map so toggling a day off
 *     and back on doesn't re-hit Supabase.
 *   - The backtest computation is wrapped in a useMemo so it re-runs only
 *     when sessions, strategy, params, or rules change. Strategy generation
 *     is fast (pure JS over OHLCV); the simulator walk is also fast — both
 *     run synchronously without UI lag for typical session sizes.
 *   - Each fired signal becomes a SYNTHETIC TradeZone (see backtest-engine.ts)
 *     so SimulatorTable / SimulatorResultsChart treat them identically to
 *     real risk-simulator zones.
 *
 * ⚠️  NT8 PRESET SYNC ⚠️
 *
 * Every preset saved from this dashboard is exported as JSON and consumed
 * by the NinjaTrader 8 strategy at runtime (via the "TO NT8" button or
 * `ninjatrader/new-strategy.sh`). Anything you wire into the dashboard's
 * config — a new SimRules field, a new filter, a new strategy parameter,
 * a new strategy id — needs the SAME field plumbed through on the C# side
 * or NT8 silently ignores it and the backtest diverges.
 *
 * Check the per-file sync notices before editing:
 *   - `src/lib/utils/zone-simulator.ts`        → SimRules sync checklist
 *   - `src/lib/utils/backtest-presets.ts`      → BacktestPreset / Filters sync
 *   - `ninjatrader/AddOns/PresetSchema.cs`     → C# Preset class
 *   - `ninjatrader/AddOns/PresetLoader.cs`     → JSON deserializer
 *   - `ninjatrader/AddOns/PresetExecutor.cs`   → runtime behavior consumer
 *   - `ninjatrader/AddOns/PresetSignals.cs`    → C# port of strategy generators
 *   - `ninjatrader/AddOns/PresetFilterEvaluator.cs` → C# filter gate
 *
 * After editing the C# side: `cd ninjatrader && ./deploy-nt8.sh`, then F5
 * in NT8 NinjaScript Editor to compile. Verify parity with
 * `scripts/diff-backtests.mjs <dash.csv> <nt8.csv>`.
 */

"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { ReplaySession, ReplayBar } from "@/types/replay";
import { getClientStore } from "@/lib/store";
import {
  aggregateTicks,
  aggregateTicksWithRanges,
  type ParsedTicks,
} from "@/lib/utils/tick-aggregation";
import { fetchAndParseTicks } from "@/lib/utils/tick-blob-loader";
import { useMode } from "@/components/mode-provider";
import { formatDate, parseRawTimestamp } from "@/lib/utils/format";
import {
  SimRules,
  SimZoneResult,
  DEFAULT_SIM_RULES,
  computeSimSummary,
  simulateAllZones,
  resolveTickConfig,
} from "@/lib/utils/zone-simulator";
import type { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import {
  buildDetailedExport,
  downloadDetailedExport,
  buildNt8ComparableTradesCsv,
  downloadNt8ComparableTradesCsv,
} from "@/lib/utils/zone-detailed-export";
import { ExportDetailedModal } from "./export-detailed-modal";
import BacktestScriptChart from "./backtest-script-chart";
import {
  STRATEGIES,
  StrategyDef,
  StrategyParamField,
  defaultParamsFor,
  runBacktestForSession,
  applyBindingsToOverlay,
  type BacktestRunResult,
  type IndicatorConfig,
  DEFAULT_INDICATOR_CONFIG,
} from "@/lib/utils/backtest-engine";
import {
  DEFAULT_OPTIMIZE_CONFIG,
  DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG,
  type OptimizeConfig,
  type AtrAdjustOptimizeConfig,
} from "@/lib/utils/zone-optimizer";
import {
  runOptimizeChunked,
  runAtrAdjustOptimizeChunked,
  runTimeOptimizeChunked,
  optimizeAdxInWorker,
  optimizeAtrInWorker,
  optimizeTrendInWorker,
  optimizeBollingerInWorker,
  optimizeRsiInWorker,
  optimizeBbWidthInWorker,
  optimizeMaDistanceInWorker,
  optimizeVolumeInWorker,
  optimizeAdxTrendInWorker,
  runStrategyParamOptimizeInWorker,
} from "@/lib/utils/optimizer-worker-runner";
import { OptimizeConfigModal } from "./optimize-config-modal";
import { OptimizeAtrConfigModal } from "./optimize-atr-config-modal";
import { SimulatorControls } from "./simulator-controls";
import { SimulatorStatCards } from "./simulator-stat-cards";
import { SimulatorResultsChart } from "./simulator-results-chart";
import { SimulatorResultsByDayChart } from "./simulator-results-by-day-chart";
import { SimulatorTable } from "./simulator-table";
import { SimulatorSegmentCharts } from "./simulator-segment-charts";
import { SimulatorHeatmap } from "./simulator-heatmap";
import { ZoneEquityCurve, ZoneEquityPoint } from "./charts/zone-equity-curve";
import { MonteCarloCurve } from "./charts/monte-carlo-curve";
import {
  runMonteCarlo,
  tradesPerDay,
  horizonToTradeCount,
  type MonteCarloHorizon,
  type MonteCarloResult,
} from "@/lib/utils/monte-carlo";
import { CompositeTradeChart } from "./composite-trade-chart";
import { CompositeBarsChart } from "./composite-bars-chart";
import {
  buildCompositeTrade,
  buildCompositeBars,
} from "@/lib/utils/composite-trade";
import { BacktestPresetsPanel } from "./backtest-presets-panel";
import { BacktestScriptEditor } from "./backtest-script-editor";
import { BacktestScriptStrategyPanel } from "./backtest-script-strategy-panel";
import {
  parseStrategyScript,
  buildLetBindings,
  type Stmt as StrategyStmt,
} from "@/lib/utils/strategy-evaluator";
import {
  BUILTIN_STRATEGY_TEMPLATES,
  type StrategyTemplate,
} from "@/lib/utils/built-in-strategies";
import { ScriptOutputPanel } from "./script-output-panel";
import { TerminalDrawer } from "./terminal-drawer";
import {
  BacktestConfig,
  applyLoadStrategyRewrite,
  collectOverlayExprs,
  defaultBacktestConfig,
  parseBacktestScript,
  serializeBacktestScript,
  ScriptError,
} from "@/lib/utils/backtest-script";
import { downloadScriptReferenceMarkdown } from "@/lib/utils/script-reference-export";
import { buildRunSummary } from "@/lib/utils/run-summary";
import {
  buildSummarySymbolTable,
  evaluateSummaryPrintsWithEntries,
  expressionReferencesEntryContext,
  precomputeIndicators,
  type Expr as ScriptExpr,
  type EntryEvalCtx,
  type TickContext,
} from "@/lib/utils/script-expr";
import {
  deriveSeed,
  runOnlineOptimizedBacktest,
} from "@/lib/utils/script-online-optimizer";
import {
  BacktestPreset,
  PresetFilters,
  BollingerPos,
  MaType,
  MaDistanceMode,
  AdxTrendMode,
  TimeWindow,
  loadPresets,
  createPreset,
  updatePreset as updatePresetInStorage,
  deletePreset as deletePresetInStorage,
  normalizePresetForLoad,
  syncPresetsFromSupabase,
  PRESETS_CHANGED_EVENT,
} from "@/lib/utils/backtest-presets";
import {
  DashboardSyncState,
  DASHBOARD_SYNC_SCHEMA_VERSION,
  generateClientId,
  loadDashboardState,
  pushDashboardState,
  subscribeToDashboardState,
} from "@/lib/utils/backtest-dashboard-sync";
import {
  loadScriptDraft,
  saveScriptDraft,
  syncScriptDraftFromSupabase,
} from "@/lib/utils/script-editor-state";

interface BacktestDashboardProps {
  /** All downloaded sessions, fetched server-side. The day picker iterates
   *  over this list — sessions appear most-recent-first. */
  sessions: ReplaySession[];
}

/**
 * Resolve the dashboard's per-eval `params.X` chain into a fully-flattened
 * dict suitable for persistence (preset.params) and for sending to NT8 via
 * /api/convert-to-nt8.
 *
 * Mirrors the resolution chain at backtest-dashboard.tsx:2819-2848 — the
 * runtime's resolution. Callers (handleSavePreset / handleUpdatePreset)
 * pass the four state slices and get back a Record<string, number> that
 * has every params.X reference in the script resolved to a finite number.
 *
 * Without this, the dashboard runtime would silently fill in defaults
 * each eval, but the saved preset would only carry the legacy `params`
 * dict — missing every script-inferred default. The transpiler then sees
 * a hole and emits `double.NaN`, which cascades through the strategy and
 * kills signals (round-7 of the parity work surfaced this via the
 * `Params resolved: 11/12. MISSING: minBodyRatio` diagnostic).
 *
 * Resolution order (highest priority first):
 *   1. scriptParams[key]        — user's explicit sidebar input
 *   2. scriptParamMeta[key].default — paramMeta default for this script
 *   3. legacyParams[key]        — legacy strategy's params dict
 *   4. cross-template paramMeta — search BUILTIN_STRATEGY_TEMPLATES for
 *                                 any template that defines this key
 *   5. 0 — last-resort fallback (matches the runtime's chain)
 */
function resolveParamsForPersistence(
  scriptText: string,
  scriptParams: Record<string, number>,
  scriptParamMeta: Record<string, { default?: number } | undefined>,
  legacyParams: Record<string, number>
): Record<string, number> {
  const resolved: Record<string, number> = { ...legacyParams };
  if (!scriptText || scriptText.trim() === "") return resolved;
  let parsedRefs: string[];
  try {
    parsedRefs = parseStrategyScript(scriptText).paramRefs;
  } catch {
    return resolved;
  }
  for (const ref of parsedRefs) {
    const key = ref.replace(/^params\./, "");
    if (Object.prototype.hasOwnProperty.call(scriptParams, key)) {
      resolved[key] = scriptParams[key];
      continue;
    }
    if (scriptParamMeta[key]?.default !== undefined) {
      resolved[key] = scriptParamMeta[key]!.default!;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(legacyParams, key)) {
      // already in resolved via the spread, no-op
      continue;
    }
    // Cross-template default search.
    let crossDefault: number | undefined;
    for (const t of BUILTIN_STRATEGY_TEMPLATES) {
      const m = t.paramMeta[key];
      if (m?.default !== undefined) {
        crossDefault = m.default;
        break;
      }
    }
    resolved[key] = crossDefault ?? 0;
  }
  return resolved;
}

export function BacktestDashboard({ sessions }: BacktestDashboardProps) {
  // Active data backend (Cloud/Local). Renamed from `mode` because the
  // file already uses a `mode` local for UI view-mode (ui vs script).
  const backendMode = useMode();

  // ─── Day selection ────────────────────────────────────────────────
  // Multi-select of session ids. Empty by default so the user has to opt in
  // to running a backtest (no surprise bar fetches on tab open).
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<number>>(
    () => new Set()
  );

  // ─── Day picker filters ───────────────────────────────────────────
  // Narrow the day picker by instrument (e.g. "ES", "NQ") and timeframe
  // (e.g. "1 Minute", "5 Minute") so users with a large session library
  // can quickly find what they want.
  //   - instrumentFilter is a Set so users can pick MULTIPLE assets at
  //     once (e.g. "show me ES and NQ together"). Empty set = "All".
  //   - timeframeFilter is single-select (a string, "" = "All"). One
  //     timeframe at a time keeps backtests apples-to-apples.
  // Filters drive both what's visible in the chip grid AND what bulk
  // operations (Select All, Random, Walk-Forward) operate on. Existing
  // selections are preserved across filter changes — changing a filter
  // never silently deselects work the user already did.
  const [instrumentFilter, setInstrumentFilter] = useState<Set<string>>(
    () => new Set()
  );
  const [timeframeFilter, setTimeframeFilter] = useState<string>("");

  // Extract the contract type ("root symbol") from a full instrument
  // string. NinjaTrader instruments look like "GC 02-26", "ES 03-26",
  // "NQ 12-25" — `{TYPE} {MM}-{YY}`. We group by the prefix so a user
  // who selects "GC" gets every GC contract regardless of expiration
  // (02-26, 04-26, 06-26, …) instead of having to chip-pick each
  // expiration individually. Falls back to the raw string if there's
  // no space, so unusual symbols still appear in the filter.
  const contractTypeOf = (instrument: string): string => {
    const sp = instrument.indexOf(" ");
    return sp === -1 ? instrument : instrument.slice(0, sp);
  };

  // Distinct contract types and timeframes present in the dataset.
  // We only show options that actually exist in the user's downloaded
  // sessions, so the dropdowns can never produce empty results because
  // of a typo'd filter value. Sorted for stable display.
  const availableInstruments = useMemo(
    () =>
      Array.from(new Set(sessions.map((s) => contractTypeOf(s.instrument)))).sort(
        (a, b) => a.localeCompare(b)
      ),
    [sessions]
  );
  const availableTimeframes = useMemo(
    () =>
      Array.from(new Set(sessions.map((s) => s.timeframe))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [sessions]
  );

  // Toggle one instrument in/out of the active filter set. An empty set
  // means "all instruments pass" — same convention as the multi-select
  // day picker, so the empty state and the "everything" state are the
  // same thing.
  const toggleInstrumentFilter = (sym: string) => {
    setInstrumentFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      return next;
    });
  };

  // Sessions that pass the active filters. This is the working set the
  // chip grid renders and that bulk operations target. When both
  // filters are "All", this is equal to `sessions` (same object identity
  // is not guaranteed — but the memo only re-runs when inputs change).
  const filteredSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (instrumentFilter.size === 0 ||
            instrumentFilter.has(contractTypeOf(s.instrument))) &&
          (!timeframeFilter || s.timeframe === timeframeFilter)
      ),
    [sessions, instrumentFilter, timeframeFilter]
  );

  // Count of currently-selected sessions that are hidden by the active
  // filters. Surfaced in the header so users aren't confused when
  // "Clear" or counts include sessions they can't see right now.
  const hiddenSelectedCount = useMemo(() => {
    if (selectedSessionIds.size === 0) return 0;
    const visibleIds = new Set(filteredSessions.map((s) => s.id));
    let hidden = 0;
    for (const id of selectedSessionIds) {
      if (!visibleIds.has(id)) hidden++;
    }
    return hidden;
  }, [selectedSessionIds, filteredSessions]);

  // ─── Strategy selection ───────────────────────────────────────────
  // Default to signal_v2 (preferred starting strategy for new sessions)
  // when present in the registry; fall back to the first registered
  // strategy if it isn't. `strategyId` is the source of truth;
  // `currentStrategy` is derived.
  const defaultStrategy: StrategyDef =
    STRATEGIES.find((s) => s.id === "signal_v2") ?? STRATEGIES[0];
  const [strategyId, setStrategyId] = useState<string>(defaultStrategy.id);
  const currentStrategy: StrategyDef =
    STRATEGIES.find((s) => s.id === strategyId) ?? defaultStrategy;

  // Flat parameter map — one global namespace for every param across every
  // strategy. The strategy is just a "preset" identifier: switching it
  // doesn't blow away the user's customizations, it only fills in any
  // param keys the new strategy declares that aren't already set. Users
  // can set any param via the script DSL or via per-strategy UI inputs;
  // generators read whichever keys they need from this dict and ignore the
  // rest. The "Reset Defaults" button explicitly overwrites every key
  // with the active strategy's defaults — that's the way to "snap back"
  // to a strategy preset.
  const [params, setParams] = useState<Record<string, number>>(() =>
    defaultParamsFor(defaultStrategy)
  );

  // When the user switches strategies, MERGE the new strategy's defaults in
  // for any param keys that aren't already set. Existing user values are
  // preserved across strategy switches — the user explicitly chose them
  // and would be annoyed by silent resets. This also means params from a
  // previously selected strategy stick around (e.g. switching v1 → v2 →
  // v1 still shows v1 with whatever values the user dialed in).
  useEffect(() => {
    setParams((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const f of currentStrategy.paramFields) {
        if (next[f.key] === undefined) {
          next[f.key] = f.default;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [strategyId, currentStrategy]);

  // ─── Sim rules state ──────────────────────────────────────────────
  // Same SimRules shape the risk simulator uses, so the SimulatorControls
  // component is a drop-in. Defaults match risk simulator defaults.
  const [rules, setRules] = useState<SimRules>(DEFAULT_SIM_RULES);

  // Display unit for the equity curve and stat cards — toggled by the
  // pill switch under the equity curve. "points" is the historical
  // default (raw price-point P&L); "dollars" multiplies through by the
  // current point value and net of commissions where applicable.
  const [displayMode, setDisplayMode] = useState<"points" | "dollars">("points");

  // ── Monte Carlo state ──────────────────────────────────────────────
  // When the user clicks a horizon button (1W/1M/1Y) we bootstrap
  // 1000 simulations off the current trade results and stash the result
  // here. Null means "no projection running" — the chart stays hidden.
  // We deliberately store the result rather than recomputing on every
  // render so the user sees a stable projection until they click again
  // (the bootstrap is randomized; clicking 1M twice would otherwise show
  // two visibly different curves).
  const [monteCarloResult, setMonteCarloResult] =
    useState<MonteCarloResult | null>(null);
  // Tracks which simulation is mid-flight so we can disable the buttons
  // and show a brief spinner. The bootstrap itself is fast (~30ms for
  // 1Y), but rendering the resulting band is heavy enough that we want
  // a one-frame "running" state to keep the click feeling responsive.
  const [monteCarloRunning, setMonteCarloRunning] =
    useState<MonteCarloHorizon | null>(null);

  // ─── Time-of-day filter ──────────────────────────────────────────
  // Same shape as the risk simulator's time filter — narrow synthetic
  // signals to those whose entry bar falls within [timeFrom, timeTo]
  // (HH:MM, supports wrap across midnight). Applied AFTER the backtest
  // engine fires signals, so toggling time on/off doesn't re-run the
  // strategy generator (free) — it only re-runs the cheap simulator pass
  // over the surviving synthetic zones.
  const [timeFilterEnabled, setTimeFilterEnabled] = useState(false);
  // Multi-window time filter — each window is OR'd against the others
  // (bar passes when its time falls in ANY window). Default to a single
  // 09:30–16:00 RTH window so existing presets behave the same; users
  // add more rows via the "+ Add window" button.
  const [timeWindows, setTimeWindows] = useState<TimeWindow[]>([
    { from: "09:30", to: "16:00" },
  ]);
  // Defensive view of windows[0] for the legacy preset shape (`from`/`to`
  // are kept on PresetFilters for backwards compat). Reading these
  // through derived values means we never have to keep timeFrom/timeTo
  // state in sync separately.
  const timeFrom = timeWindows[0]?.from ?? "09:30";
  const timeTo = timeWindows[0]?.to ?? "16:00";

  // ─── Context filters (ADX / ATR / Trend / Bollinger) ─────────────
  // Same shape and defaults as the risk simulator's context filters. They
  // read the ctx_* fields the backtest engine now stamps onto each
  // synthetic zone — so toggling them on filters out signals whose
  // entry-bar indicator state doesn't match. Each filter is independent
  // and starts OFF; defaults on enable are the widest possible range so
  // users narrow from there. Zones with NULL values for the relevant
  // ctx_* field are dropped (strict: if you ask to filter by X, you can't
  // keep rows without X).
  const [adxFilterEnabled, setAdxFilterEnabled] = useState(false);
  const [adxMin, setAdxMin] = useState(0);
  const [adxMax, setAdxMax] = useState(100);
  // Configurable Wilder ADX period — was hardcoded 14, now user-tunable.
  const [adxPeriod, setAdxPeriod] = useState(14);

  const [atrFilterEnabled, setAtrFilterEnabled] = useState(false);
  const [atrMin, setAtrMin] = useState(0);
  const [atrMax, setAtrMax] = useState(100);
  // Configurable Wilder ATR period — drives BOTH this filter AND the
  // ± ATR adjustment math on SL/TP/Trail/BE in zone-simulator.
  const [atrPeriod, setAtrPeriod] = useState(14);

  type TrendMode = "any" | "with" | "against";
  const [trendFilterEnabled, setTrendFilterEnabled] = useState(false);
  const [ema20Mode, setEma20Mode] = useState<TrendMode>("with");
  const [ema200Mode, setEma200Mode] = useState<TrendMode>("any");
  // Configurable trend-MA periods + types. Default 20/200 EMA preserves
  // legacy behavior; users can swap to e.g. EMA(9)/SMA(50).
  const [trendFastPeriod, setTrendFastPeriod] = useState(20);
  const [trendFastType, setTrendFastType] = useState<MaType>("ema");
  const [trendSlowPeriod, setTrendSlowPeriod] = useState(200);
  const [trendSlowType, setTrendSlowType] = useState<MaType>("ema");

  const [bollingerFilterEnabled, setBollingerFilterEnabled] = useState(false);
  const [bollingerAllowed, setBollingerAllowed] = useState<Set<string>>(
    () => new Set(["above_upper", "inside", "below_lower"])
  );
  // Configurable BB period + stddev multiplier. Default 20/2 preserves
  // the legacy hardcoded behavior. Shared with the BB-width filter
  // below — one tuning, two filters.
  const [bollingerPeriod, setBollingerPeriod] = useState(20);
  const [bollingerStdDev, setBollingerStdDev] = useState(2);

  // ─── New filter: Bollinger band-width range ──────────────────────
  const [bbWidthFilterEnabled, setBbWidthFilterEnabled] = useState(false);
  const [bbWidthMin, setBbWidthMin] = useState(0);
  const [bbWidthMax, setBbWidthMax] = useState(1000);

  // ─── New filter: distance from a configurable MA, in ATR units ──
  const [maDistanceFilterEnabled, setMaDistanceFilterEnabled] = useState(false);
  const [maDistancePeriod, setMaDistancePeriod] = useState(50);
  const [maDistanceType, setMaDistanceType] = useState<MaType>("ema");
  const [maDistanceMode, setMaDistanceMode] =
    useState<MaDistanceMode>("absolute");
  const [maDistanceMin, setMaDistanceMin] = useState(0);
  const [maDistanceMax, setMaDistanceMax] = useState(5);

  // ─── New filter: bar volume / N-bar avg ratio ──────────────────
  const [volumeFilterEnabled, setVolumeFilterEnabled] = useState(false);
  const [volumeMaPeriod, setVolumeMaPeriod] = useState(20);
  const [volumeMinRatio, setVolumeMinRatio] = useState(0);
  const [volumeMaxRatio, setVolumeMaxRatio] = useState(100);

  // ─── New filter: Wilder RSI in [min, max] ──────────────────────
  const [rsiFilterEnabled, setRsiFilterEnabled] = useState(false);
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [rsiMin, setRsiMin] = useState(0);
  const [rsiMax, setRsiMax] = useState(100);

  // ─── New filter: ADX direction (rising/falling/flat) ───────────
  // Slope is stamped onto each synthetic zone at signal time using
  // adxSlopeLookback in IndicatorConfig. The mode + flatThreshold
  // can be tuned without re-running the backtest; lookback changes
  // invalidate the cache same as adxPeriod.
  const [adxTrendFilterEnabled, setAdxTrendFilterEnabled] = useState(false);
  const [adxTrendMode, setAdxTrendMode] = useState<AdxTrendMode>("rising");
  const [adxTrendLookback, setAdxTrendLookback] = useState(5);
  const [adxTrendFlatThreshold, setAdxTrendFlatThreshold] = useState(1);

  // ─── New filter: bid/ask delta imbalance ──────────────────────
  // Gates trades on (ask − bid) / (ask + bid) at the entry bar — only
  // meaningful for sessions whose source bars carry a bid/ask split
  // (tick / tick_bidask after aggregation, or ohlcv_bidask). On plain
  // OHLCV sessions ctx_delta_ratio is null and every trade is rejected
  // when this filter is on; that's the deliberate fail-closed default.
  const [deltaFilterEnabled, setDeltaFilterEnabled] = useState(false);
  const [deltaMin, setDeltaMin] = useState(-1);
  const [deltaMax, setDeltaMax] = useState(1);

  // ─── Indicator config bundle ─────────────────────────────────────
  // Aggregates every indicator-period knob the filters expose so the
  // backtest engine has one struct to read. Kept in a memo so the
  // runResult cache key can be a stable JSON of the same struct.
  const indicatorConfig = useMemo<IndicatorConfig>(
    () => ({
      atrPeriod,
      adxPeriod,
      bbPeriod: bollingerPeriod,
      bbStdDev: bollingerStdDev,
      trendFastPeriod,
      trendFastType,
      trendSlowPeriod,
      trendSlowType,
      maDistancePeriod,
      maDistanceType,
      volumeMaPeriod,
      rsiPeriod,
      adxSlopeLookback: adxTrendLookback,
    }),
    [
      atrPeriod,
      adxPeriod,
      bollingerPeriod,
      bollingerStdDev,
      trendFastPeriod,
      trendFastType,
      trendSlowPeriod,
      trendSlowType,
      maDistancePeriod,
      maDistanceType,
      volumeMaPeriod,
      rsiPeriod,
      adxTrendLookback,
    ]
  );

  // ─── Context optimizer busy flag ─────────────────────────────────
  // The four context optimizers (ADX/ATR/Trend/Bollinger) each spawn a
  // worker. Gate them on a single shared flag so two can't run at once.
  const [contextOptimizing, setContextOptimizing] = useState(false);

  // ─── Toast (optimizer feedback) ──────────────────────────────────
  // Inline feedback when a context optimizer can't find a candidate that
  // satisfies its 20-trade floor. Auto-clears.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // ─── Presets (localStorage-backed save/load of full configuration) ─
  // The presets feature persists strategy + params + rules + every filter
  // under one named entry in localStorage. Day selection is intentionally
  // NOT included — presets describe a *strategy configuration*, not a data
  // window, so loading a preset doesn't surprise-replace the user's
  // current selection of trading days. The actual storage I/O lives in
  // backtest-presets.ts; this component owns the in-memory mirror so the
  // dropdown re-renders synchronously after each mutation.
  const [presets, setPresets] = useState<BacktestPreset[]>([]);

  // Lazy-load on mount — localStorage isn't available during SSR, so we
  // defer the read until after the first client render. The dashboard
  // renders fine with an empty preset list; the panel just shows
  // "No saved presets" until this populates. We also kick off a Supabase
  // sync on mount so presets saved on another device or recovered from a
  // wiped localStorage land here automatically, and subscribe to the
  // cross-component `presets-changed` event so any in-app create/update/
  // delete refreshes the dropdown without a manual reload.
  useEffect(() => {
    setPresets(loadPresets());
    const refresh = () => setPresets(loadPresets());
    window.addEventListener(PRESETS_CHANGED_EVENT, refresh);
    syncPresetsFromSupabase().catch(() => {});
    return () => window.removeEventListener(PRESETS_CHANGED_EVENT, refresh);
  }, []);

  // Snapshot the dashboard's current filter state into the preset shape.
  // Pulled into a memo so saving a preset is one allocation, and so the
  // "current state" is consistent across save/update calls fired in the
  // same render. The Set→Array conversion for bollinger.allowed is the
  // only non-trivial bit — sets don't round-trip through JSON.
  const currentFilters = useMemo<PresetFilters>(
    () => ({
      time: {
        enabled: timeFilterEnabled,
        // Windows are the canonical multi-window source. from/to mirror
        // windows[0] for backwards-compat consumers (auto-trader summary,
        // simulator-panel state load).
        from: timeFrom,
        to: timeTo,
        windows: timeWindows.map((w) => ({ from: w.from, to: w.to })),
      },
      adx: {
        enabled: adxFilterEnabled,
        min: adxMin,
        max: adxMax,
        period: adxPeriod,
      },
      atr: {
        enabled: atrFilterEnabled,
        min: atrMin,
        max: atrMax,
        period: atrPeriod,
      },
      trend: {
        enabled: trendFilterEnabled,
        ema20Mode,
        ema200Mode,
        fastPeriod: trendFastPeriod,
        fastType: trendFastType,
        slowPeriod: trendSlowPeriod,
        slowType: trendSlowType,
      },
      bollinger: {
        enabled: bollingerFilterEnabled,
        allowed: Array.from(bollingerAllowed) as BollingerPos[],
        period: bollingerPeriod,
        stdDev: bollingerStdDev,
      },
      bbWidth: {
        enabled: bbWidthFilterEnabled,
        min: bbWidthMin,
        max: bbWidthMax,
      },
      maDistance: {
        enabled: maDistanceFilterEnabled,
        period: maDistancePeriod,
        type: maDistanceType,
        mode: maDistanceMode,
        min: maDistanceMin,
        max: maDistanceMax,
      },
      volume: {
        enabled: volumeFilterEnabled,
        period: volumeMaPeriod,
        minRatio: volumeMinRatio,
        maxRatio: volumeMaxRatio,
      },
      rsi: {
        enabled: rsiFilterEnabled,
        period: rsiPeriod,
        min: rsiMin,
        max: rsiMax,
      },
      adxTrend: {
        enabled: adxTrendFilterEnabled,
        mode: adxTrendMode,
        lookback: adxTrendLookback,
        flatThreshold: adxTrendFlatThreshold,
      },
      delta: {
        enabled: deltaFilterEnabled,
        min: deltaMin,
        max: deltaMax,
      },
    }),
    [
      timeFilterEnabled,
      timeWindows,
      adxFilterEnabled,
      adxMin,
      adxMax,
      adxPeriod,
      atrFilterEnabled,
      atrMin,
      atrMax,
      atrPeriod,
      trendFilterEnabled,
      ema20Mode,
      ema200Mode,
      trendFastPeriod,
      trendFastType,
      trendSlowPeriod,
      trendSlowType,
      bollingerFilterEnabled,
      bollingerAllowed,
      bollingerPeriod,
      bollingerStdDev,
      bbWidthFilterEnabled,
      bbWidthMin,
      bbWidthMax,
      maDistanceFilterEnabled,
      maDistancePeriod,
      maDistanceType,
      maDistanceMode,
      maDistanceMin,
      maDistanceMax,
      volumeFilterEnabled,
      volumeMaPeriod,
      volumeMinRatio,
      volumeMaxRatio,
      rsiFilterEnabled,
      rsiPeriod,
      rsiMin,
      rsiMax,
      adxTrendFilterEnabled,
      adxTrendMode,
      adxTrendLookback,
      adxTrendFlatThreshold,
      deltaFilterEnabled,
      deltaMin,
      deltaMax,
    ]
  );

  /** Apply a saved preset to every relevant piece of dashboard state.
   *  normalizePresetForLoad fills in any fields that didn't exist when
   *  the preset was saved, so older saves still apply cleanly after we
   *  add new SimRules / filter fields. The rulesVersion + paramsVersion
   *  bumps force the uncontrolled numeric inputs in SimulatorControls
   *  and the strategy-param editor to remount and pick up the new values
   *  — same trick the optimizers use when they mutate state. */

  // Refs that mirror the script editor state so the preset handlers
  // (defined here, ABOVE the script useState declarations on line ~1229)
  // can read the latest values without triggering the temporal dead
  // zone. Two useEffects below the state declarations sync them whenever
  // scriptText / scriptParamMeta change.
  const scriptTextRef = useRef<string>("");
  const scriptParamMetaRef = useRef<
    Record<string, NonNullable<import("./backtest-script-strategy-panel").InferredParam["meta"]>>
  >({});
  // Round-7 addition: scriptParams holds the user's sidebar values for
  // inferred params.X references. handleSavePreset / handleUpdatePreset
  // need this to compute the resolved params dict (without it, presets
  // get saved missing every script-inferred default → NaN in NT8).
  const scriptParamsRef = useRef<Record<string, number>>({});
  const setScriptTextRef = useRef<((text: string) => void) | null>(null);
  const setScriptParamMetaRef = useRef<
    | ((m: Record<string, NonNullable<import("./backtest-script-strategy-panel").InferredParam["meta"]>>) => void)
    | null
  >(null);

  const handleLoadPreset = useCallback((preset: BacktestPreset) => {
    const safe = normalizePresetForLoad(preset);

    setStrategyId(safe.strategyId);
    // A preset is a complete snapshot of params for its strategy, so we
    // overwrite the whole flat dict on load. Any params that came from a
    // different strategy are intentionally cleared — the user explicitly
    // asked to load this preset.
    setParams({ ...safe.params });
    setParamsVersion((v) => v + 1);

    setRules(safe.rules);
    setRulesVersion((v) => v + 1);

    setTimeFilterEnabled(safe.filters.time.enabled);
    // normalizePresetForLoad guarantees `windows` is non-empty (older
    // saves get migrated from from/to). Deep-copy so the preset's
    // stored array isn't aliased into editable dashboard state.
    setTimeWindows(
      safe.filters.time.windows.map((w) => ({ from: w.from, to: w.to }))
    );

    setAdxFilterEnabled(safe.filters.adx.enabled);
    setAdxMin(safe.filters.adx.min);
    setAdxMax(safe.filters.adx.max);
    setAdxPeriod(safe.filters.adx.period);

    setAtrFilterEnabled(safe.filters.atr.enabled);
    setAtrMin(safe.filters.atr.min);
    setAtrMax(safe.filters.atr.max);
    setAtrPeriod(safe.filters.atr.period);

    setTrendFilterEnabled(safe.filters.trend.enabled);
    setEma20Mode(safe.filters.trend.ema20Mode);
    setEma200Mode(safe.filters.trend.ema200Mode);
    setTrendFastPeriod(safe.filters.trend.fastPeriod);
    setTrendFastType(safe.filters.trend.fastType);
    setTrendSlowPeriod(safe.filters.trend.slowPeriod);
    setTrendSlowType(safe.filters.trend.slowType);

    setBollingerFilterEnabled(safe.filters.bollinger.enabled);
    setBollingerAllowed(new Set(safe.filters.bollinger.allowed));
    setBollingerPeriod(safe.filters.bollinger.period);
    setBollingerStdDev(safe.filters.bollinger.stdDev);

    // New filter sub-objects — normalize-for-load already filled in
    // defaults if the saved preset predates these fields, so it's safe
    // to read each branch unconditionally here.
    setBbWidthFilterEnabled(safe.filters.bbWidth.enabled);
    setBbWidthMin(safe.filters.bbWidth.min);
    setBbWidthMax(safe.filters.bbWidth.max);

    setMaDistanceFilterEnabled(safe.filters.maDistance.enabled);
    setMaDistancePeriod(safe.filters.maDistance.period);
    setMaDistanceType(safe.filters.maDistance.type);
    setMaDistanceMode(safe.filters.maDistance.mode);
    setMaDistanceMin(safe.filters.maDistance.min);
    setMaDistanceMax(safe.filters.maDistance.max);

    setVolumeFilterEnabled(safe.filters.volume.enabled);
    setVolumeMaPeriod(safe.filters.volume.period);
    setVolumeMinRatio(safe.filters.volume.minRatio);
    setVolumeMaxRatio(safe.filters.volume.maxRatio);

    setRsiFilterEnabled(safe.filters.rsi.enabled);
    setRsiPeriod(safe.filters.rsi.period);
    setRsiMin(safe.filters.rsi.min);
    setRsiMax(safe.filters.rsi.max);

    setAdxTrendFilterEnabled(safe.filters.adxTrend.enabled);
    setAdxTrendMode(safe.filters.adxTrend.mode);
    setAdxTrendLookback(safe.filters.adxTrend.lookback);
    setAdxTrendFlatThreshold(safe.filters.adxTrend.flatThreshold);

    setDeltaFilterEnabled(safe.filters.delta.enabled);
    setDeltaMin(safe.filters.delta.min);
    setDeltaMax(safe.filters.delta.max);

    // Round-4 fix: restore script + paramMeta. Older presets predate
    // these fields — guard with explicit checks so loading them doesn't
    // wipe the user's current editor state. New saves always write both.
    // We call through refs because the actual setters live below in the
    // file (script useState is declared after this handler) — the refs
    // are populated by useEffects further down.
    if (typeof safe.script === "string" && safe.script.length > 0) {
      setScriptTextRef.current?.(safe.script);
    }
    if (safe.paramMeta && setScriptParamMetaRef.current) {
      setScriptParamMetaRef.current(safe.paramMeta);
    }

    showToast(`Loaded preset "${safe.name}"`);
  }, [showToast]);

  /** Persist a new preset under `name`. Re-reads from storage afterward
   *  so the dropdown reflects the freshly-saved entry without a manual
   *  refresh.
   *
   *  Round-4 fix: also persist `script` and `paramMeta`. Without
   *  `script`, /api/convert-to-nt8 silently falls back to the legacy
   *  strategyId template (which has no `filters.X = Y` directives) and
   *  NT8 produces wildly wrong trade counts. */
  const handleSavePreset = useCallback(
    (name: string) => {
      // Round-7: resolve the full param chain (scriptParams + paramMeta
      // defaults + cross-template defaults + 0-fallback) before saving,
      // so the persisted preset.params is the same flattened dict the
      // dashboard runtime resolves to per-eval. Without this, the
      // transpiler later sees a hole and emits double.NaN, killing
      // signals in NT8.
      const resolvedParams = resolveParamsForPersistence(
        scriptTextRef.current,
        scriptParamsRef.current,
        scriptParamMetaRef.current,
        params,
      );
      createPreset({
        name,
        strategyId,
        params: resolvedParams,
        rules,
        filters: currentFilters,
        // Refs are populated by useEffects below — see scriptTextRef
        // declaration above handleLoadPreset for the rationale.
        script: scriptTextRef.current,
        paramMeta: scriptParamMetaRef.current,
      });
      setPresets(loadPresets());
      showToast(`Saved preset "${name}"`);
    },
    [strategyId, params, rules, currentFilters, showToast]
  );

  /** Overwrite an existing preset with the current dashboard state. The
   *  preset keeps its id and createdAt; updatedAt advances. */
  const handleUpdatePreset = useCallback(
    (preset: BacktestPreset) => {
      const resolvedParams = resolveParamsForPersistence(
        scriptTextRef.current,
        scriptParamsRef.current,
        scriptParamMetaRef.current,
        params,
      );
      updatePresetInStorage(preset.id, {
        strategyId,
        params: resolvedParams,
        rules,
        filters: currentFilters,
        script: scriptTextRef.current,
        paramMeta: scriptParamMetaRef.current,
      });
      setPresets(loadPresets());
      showToast(`Updated preset "${preset.name}"`);
    },
    [strategyId, params, rules, currentFilters, showToast]
  );

  /** Remove a preset by id. Confirm prompt is handled in the panel. */
  const handleDeletePreset = useCallback(
    (preset: BacktestPreset) => {
      deletePresetInStorage(preset.id);
      setPresets(loadPresets());
      showToast(`Deleted preset "${preset.name}"`);
    },
    [showToast]
  );

  // ─── Cross-tab realtime sync ─────────────────────────────────────
  // Mirrors every dashboard input into a singleton supabase row so two
  // browser windows of the dashboard stay in lockstep — change a knob
  // on monitor A, monitor B sees it instantly. The user case is
  // "edit on one screen, observe on another" without any save/load
  // ceremony, so the sync runs continuously rather than on explicit
  // commit.
  //
  // Wiring:
  //   1. On mount: fetch the singleton row and apply it (one-shot
  //      hydration, async — defaults render until the load resolves).
  //   2. Subscribe to realtime updates and apply incoming snapshots
  //      from OTHER tabs (echo-suppressed via a per-tab clientId).
  //   3. On any local state change: debounce 250ms then push the
  //      snapshot upstream. Skip pushes whose JSON matches the most
  //      recently applied snapshot — that's how we avoid bouncing our
  //      own apply back into the network.
  //
  // Day-picker selection (sessions, instrument/timeframe filter) IS
  // synced because it's part of "what backtest am I looking at".
  // UI-local state (script editor draft, modals, optimizer flags,
  // toast) is intentionally NOT synced.
  //
  // Per-tab id used to suppress echoes of our own writes. Created
  // lazily via useState so it's stable across renders without an extra
  // render pass.
  const [clientId] = useState<string>(() =>
    typeof window === "undefined" ? "" : generateClientId()
  );

  // Set true once the initial Supabase load resolves. Until then we
  // suppress all push effects so a slow load can't be raced by a
  // local-default push that would clobber a remote row mid-flight.
  const dashboardHydratedRef = useRef(false);

  // JSON of the most recently applied/pushed snapshot. The push
  // effect compares the live snapshot's JSON to this ref and skips if
  // equal — handles the apply-then-effect echo and lets us no-op on
  // identical-shape changes.
  const lastSyncedJsonRef = useRef<string>("");

  // Latched by applyRemoteState BEFORE its setters run. The push
  // effect consumes the flag in the very next render (the one that
  // reflects the batched setters), where it latches lastSyncedJsonRef
  // to the ACTUAL post-commit snapshot JSON and skips the push. This
  // replaces a fragile pre-compute-the-equivalent-shape trick that
  // mismatched currentFilters' real key order, leaving lastSyncedJson
  // out of sync with what the snapshot would produce. The drift caused
  // every realtime apply to push the same state right back, which the
  // *other* tab then re-applied and pushed — a cross-tab ping-pong
  // that re-ran applyRemoteState on every cycle and made the dashboard
  // feel sluggish on every input change.
  const pendingApplyRef = useRef(false);

  /** Apply a remote snapshot through the same setter chain the preset
   *  loader uses. Reuses normalizePresetForLoad so older saved snapshots
   *  with newer-defaulted filter fields apply cleanly. Bumps the
   *  params/rulesVersion keys so the uncontrolled SimulatorControls
   *  inputs remount with the incoming values (same trick presets and
   *  optimizers use). Silent — no toast — because sync is the steady
   *  state, not a user action worth notifying about. */
  const applyRemoteState = useCallback((s: DashboardSyncState) => {
    // Defensive shape merge — normalizePresetForLoad expects a
    // BacktestPreset envelope, so we wrap our snapshot in a synthetic
    // one (id/name don't matter — the function only reads
    // strategyId/params/rules/filters).
    const safe = normalizePresetForLoad({
      version: s.version ?? DASHBOARD_SYNC_SCHEMA_VERSION,
      id: "__remote__",
      name: "__remote__",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      strategyId: s.strategyId,
      params: s.params ?? {},
      rules: s.rules ?? DEFAULT_SIM_RULES,
      filters: s.filters,
    });

    // Tell the push effect to latch (not push) on the next render.
    // React 18 batches all of the setters below into one re-render, so
    // by the time the push effect fires `dashboardSnapshot` reflects
    // the entire new state and we can stringify it for-real. No more
    // guessing the resulting shape.
    pendingApplyRef.current = true;

    // Day-picker selection — a Set in local state, an array on the
    // wire. Empty array = "no sessions selected" (matches the initial
    // empty-Set default).
    setSelectedSessionIds(new Set(s.selectedSessionIds ?? []));
    // Normalize legacy saved filters: older snapshots stored full contract
    // names like "GC 02-26"; the filter now keys off contract type ("GC")
    // so each entry is mapped through `contractTypeOf` on load.
    setInstrumentFilter(
      new Set((s.instrumentFilter ?? []).map((v) => contractTypeOf(v)))
    );
    setTimeframeFilter(s.timeframeFilter ?? "");

    // Strategy + params + rules — same flow handleLoadPreset uses.
    setStrategyId(safe.strategyId);
    setParams({ ...safe.params });
    setParamsVersion((v) => v + 1);
    setRules(safe.rules);
    setRulesVersion((v) => v + 1);

    // Time-of-day filter — windows is the canonical representation;
    // deep-copy so the remote payload's array isn't aliased into
    // editable dashboard state.
    setTimeFilterEnabled(safe.filters.time.enabled);
    setTimeWindows(
      safe.filters.time.windows.map((w) => ({ from: w.from, to: w.to }))
    );

    // Per-filter setter chain — mirrors handleLoadPreset 1:1. Keep
    // these in sync when adding new filter fields.
    setAdxFilterEnabled(safe.filters.adx.enabled);
    setAdxMin(safe.filters.adx.min);
    setAdxMax(safe.filters.adx.max);
    setAdxPeriod(safe.filters.adx.period);

    setAtrFilterEnabled(safe.filters.atr.enabled);
    setAtrMin(safe.filters.atr.min);
    setAtrMax(safe.filters.atr.max);
    setAtrPeriod(safe.filters.atr.period);

    setTrendFilterEnabled(safe.filters.trend.enabled);
    setEma20Mode(safe.filters.trend.ema20Mode);
    setEma200Mode(safe.filters.trend.ema200Mode);
    setTrendFastPeriod(safe.filters.trend.fastPeriod);
    setTrendFastType(safe.filters.trend.fastType);
    setTrendSlowPeriod(safe.filters.trend.slowPeriod);
    setTrendSlowType(safe.filters.trend.slowType);

    setBollingerFilterEnabled(safe.filters.bollinger.enabled);
    setBollingerAllowed(new Set(safe.filters.bollinger.allowed));
    setBollingerPeriod(safe.filters.bollinger.period);
    setBollingerStdDev(safe.filters.bollinger.stdDev);

    setBbWidthFilterEnabled(safe.filters.bbWidth.enabled);
    setBbWidthMin(safe.filters.bbWidth.min);
    setBbWidthMax(safe.filters.bbWidth.max);

    setMaDistanceFilterEnabled(safe.filters.maDistance.enabled);
    setMaDistancePeriod(safe.filters.maDistance.period);
    setMaDistanceType(safe.filters.maDistance.type);
    setMaDistanceMode(safe.filters.maDistance.mode);
    setMaDistanceMin(safe.filters.maDistance.min);
    setMaDistanceMax(safe.filters.maDistance.max);

    setVolumeFilterEnabled(safe.filters.volume.enabled);
    setVolumeMaPeriod(safe.filters.volume.period);
    setVolumeMinRatio(safe.filters.volume.minRatio);
    setVolumeMaxRatio(safe.filters.volume.maxRatio);

    setRsiFilterEnabled(safe.filters.rsi.enabled);
    setRsiPeriod(safe.filters.rsi.period);
    setRsiMin(safe.filters.rsi.min);
    setRsiMax(safe.filters.rsi.max);

    setAdxTrendFilterEnabled(safe.filters.adxTrend.enabled);
    setAdxTrendMode(safe.filters.adxTrend.mode);
    setAdxTrendLookback(safe.filters.adxTrend.lookback);
    setAdxTrendFlatThreshold(safe.filters.adxTrend.flatThreshold);

    setDeltaFilterEnabled(safe.filters.delta.enabled);
    setDeltaMin(safe.filters.delta.min);
    setDeltaMax(safe.filters.delta.max);
  }, []);

  /** Snapshot every synced dashboard input. Memoized on its inputs so
   *  the push effect only fires when something a sync cares about
   *  actually changed. Mirrors `currentFilters` for the filter half
   *  and adds the day-picker fields the preset shape doesn't include. */
  const dashboardSnapshot = useMemo<DashboardSyncState>(
    () => ({
      version: DASHBOARD_SYNC_SCHEMA_VERSION,
      selectedSessionIds: Array.from(selectedSessionIds),
      instrumentFilter: Array.from(instrumentFilter),
      timeframeFilter,
      strategyId,
      params,
      rules,
      filters: currentFilters,
    }),
    [
      selectedSessionIds,
      instrumentFilter,
      timeframeFilter,
      strategyId,
      params,
      rules,
      currentFilters,
    ]
  );

  // Mount: hydrate from supabase, then subscribe to realtime updates.
  // We open the subscription only AFTER the initial load resolves so
  // the first apply is always the load (deterministic hydration), not
  // an interleaved realtime payload. `cancelled` guards against the
  // unlikely case where the component unmounts mid-load.
  useEffect(() => {
    if (!clientId) return; // SSR safety — no client-side sync server-side.
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    loadDashboardState()
      .then((remote) => {
        if (cancelled) return;
        if (remote) applyRemoteState(remote);
        dashboardHydratedRef.current = true;
        unsubscribe = subscribeToDashboardState(clientId, (incoming) => {
          applyRemoteState(incoming);
        });
      })
      .catch(() => {
        // Hydration is best-effort — local defaults stay if the
        // network is down. Mark hydrated so subsequent edits still
        // push (they'll seed the row when supabase comes back).
        dashboardHydratedRef.current = true;
        unsubscribe = subscribeToDashboardState(clientId, (incoming) => {
          applyRemoteState(incoming);
        });
      });

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [clientId, applyRemoteState]);

  // Push: any local change debounces and flushes upstream. Skips
  // pre-hydration writes (so we don't clobber the remote row with our
  // own pre-load defaults) and skips writes whose JSON matches the
  // most recently applied snapshot (echo of our own apply). 250ms
  // debounce keeps typing into a numeric input from spamming the
  // network — burst-then-settle.
  //
  // Crucially, we DEFER the JSON.stringify into the setTimeout
  // callback rather than running it inline. The hot path is the
  // useEffect that fires on every state change (every keystroke /
  // toggle); doing JSON work there piles synchronous cost on top of
  // the existing currentFilters / runResult re-renders and made the
  // UI feel laggy. By the time the 250ms timer fires the user has
  // stopped typing, so the stringify+compare runs at most once per
  // settled change instead of once per intermediate state.
  useEffect(() => {
    if (!clientId) return;

    // Just-applied a remote snapshot? React has now committed all of
    // applyRemoteState's setters into a single render, so the live
    // dashboardSnapshot finally reflects the inbound state. Latch its
    // JSON into lastSyncedJsonRef and skip the push — otherwise we'd
    // bounce the same state back to supabase, which the other tab
    // would re-apply, which would push back, etc. (the ping-pong).
    if (pendingApplyRef.current) {
      pendingApplyRef.current = false;
      lastSyncedJsonRef.current = JSON.stringify(dashboardSnapshot);
      return;
    }

    if (!dashboardHydratedRef.current) return;

    const t = setTimeout(() => {
      const json = JSON.stringify(dashboardSnapshot);
      if (json === lastSyncedJsonRef.current) return;
      lastSyncedJsonRef.current = json;
      pushDashboardState(dashboardSnapshot, clientId);
    }, 250);
    return () => clearTimeout(t);
  }, [dashboardSnapshot, clientId]);

  // ─── UI ↔ Script mode toggle ─────────────────────────────────────
  // Two ways to drive the dashboard config:
  //   - "ui"     — the original click-through controls (strategy picker,
  //                rules editor, filter bars). Default.
  //   - "script" — a single text editor where every config field becomes
  //                a `path = value` line. Same state lives underneath in
  //                both modes; the script editor's "Apply" button writes
  //                back through the same setters the UI uses.
  // Day selection, presets, exports, and results live OUTSIDE this gate
  // — they're equally useful regardless of how the user is editing the
  // config. The split mirrors the BacktestPreset shape (strategy + params
  // + rules + filters), since that's exactly the slice the script DSL
  // covers. State is declared here (before the script bridge callbacks
  // that consume the setters) so block-scoped TDZ rules stay happy.
  const [mode, setMode] = useState<"ui" | "script">("script");

  // ── Script-mode "View" sub-toggle ──────────────────────────────────
  // Within script mode the user picks between two views of the LEFT
  // column:
  //   - "ui"    — the existing click-through controls (presets, day
  //               picker, results, stat cards). Default.
  //   - "chart" — a TradingView lightweight-charts candlestick chart
  //               of the stitched bars from every selected session,
  //               with markers for both raw script signals AND the
  //               filtered trades that survive all rules.
  // The right rail (script editor + output panel) is unchanged in
  // both views — chart mode lets the user iterate the script while
  // watching signal/trade markers update side-by-side.
  // Persisted to localStorage so the user's last view + layer choices
  // stick across reloads (mirrors the SCRIPT_SPLIT_KEY pattern below).
  const SCRIPT_VIEW_KEY = "tradedashboard.scriptView";
  const SCRIPT_CHART_LAYERS_KEY = "tradedashboard.scriptChartLayers";
  const [scriptViewMode, setScriptViewMode] = useState<"ui" | "chart">("ui");
  const [showSignalsLayer, setShowSignalsLayer] = useState(true);
  const [showTradesLayer, setShowTradesLayer] = useState(true);
  // Hydrate from localStorage on mount. Wrapped in try/catch because
  // both `getItem` and `JSON.parse` can throw when storage is disabled
  // (private mode) or the persisted JSON is malformed from a previous
  // version — we silently fall back to defaults rather than break the
  // dashboard's render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(SCRIPT_VIEW_KEY);
      if (v === "ui" || v === "chart") setScriptViewMode(v);
      const layersRaw = window.localStorage.getItem(SCRIPT_CHART_LAYERS_KEY);
      if (layersRaw) {
        const parsed = JSON.parse(layersRaw) as {
          signals?: boolean;
          trades?: boolean;
        };
        if (typeof parsed.signals === "boolean")
          setShowSignalsLayer(parsed.signals);
        if (typeof parsed.trades === "boolean")
          setShowTradesLayer(parsed.trades);
      }
    } catch {
      // Quota / disabled storage / parse failure — silent ignore.
    }
  }, []);
  // Persist on change. Two effects (one per concern) so unrelated state
  // changes don't cause redundant writes — toggling a layer doesn't
  // re-write the view-mode key and vice versa.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SCRIPT_VIEW_KEY, scriptViewMode);
    } catch {
      // Silent ignore.
    }
  }, [scriptViewMode]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        SCRIPT_CHART_LAYERS_KEY,
        JSON.stringify({ signals: showSignalsLayer, trades: showTradesLayer })
      );
    } catch {
      // Silent ignore.
    }
  }, [showSignalsLayer, showTradesLayer]);

  // The script editor is fully controlled via this string. It is NOT
  // automatically kept in sync with UI-side state — the user has to click
  // "Apply" to push changes from script→UI, or "Sync from UI" to pull the
  // current state back into the editor. That asymmetry is intentional:
  // re-serializing the script on every UI change would clobber the user's
  // in-progress edits and reorder/reformat their personal layout.
  //
  // Initial value is hydrated synchronously from the localStorage cache
  // managed by `script-editor-state.ts`. On the server (SSR) the cache
  // helper short-circuits to an empty string; on the client we get the
  // last-saved draft so the editor never opens empty after a reload while
  // the Supabase round-trip is in flight. A subsequent useEffect performs
  // the durable sync from Supabase and updates state if the server copy is
  // newer than the cache.
  const [scriptText, setScriptText] = useState<string>(
    () => loadScriptDraft().content
  );
  // True once the user has typed in the editor during this session. We use
  // this to avoid clobbering in-progress edits when the async Supabase
  // sync resolves AFTER the user has already started editing — local
  // edits take priority over a server copy that turned out to be newer
  // than the stale cached draft.
  const scriptUserEditedRef = useRef(false);
  // Snapshot of `scriptText` taken at Apply/Run time. The backtest run
  // memos read THIS — never the live `scriptText` — so typing in the
  // editor doesn't invalidate the run memos on every keystroke. Without
  // this split, each debounced editor emit recreated `runResult`'s
  // aggregator arrays/Maps (cache hits returned the same `result`
  // object, but the outer memo still rebuilt its arrays), cascading
  // re-renders into the chart and trade table mid-typing.
  const [appliedScriptText, setAppliedScriptText] = useState<string>("");
  // Per-key value overrides for inferred params.X references in the
  // strategy DSL. The script-strategy panel renders one input per
  // params.X reference and writes here. The run path overlays these on
  // top of the dropdown's `params` dict before passing into
  // evaluateStrategyScript via strategyOverride. Never read for legacy
  // (dropdown-only) strategies.
  const [scriptParams, setScriptParams] = useState<Record<string, number>>({});
  // UI hints (default / min / max / step / type / label) for inferred
  // params. Populated by the most-recently loaded template OR by the
  // active preset's paramMeta. Empty when the user authors from
  // scratch — inputs render with no min/max/step constraints in that
  // case, matching their default values.
  const [scriptParamMeta, setScriptParamMeta] = useState<
    Record<string, NonNullable<import("./backtest-script-strategy-panel").InferredParam["meta"]>>
  >({});

  // Mirror script editor state into the refs declared earlier so the
  // preset handlers (defined above the script useState) can read the
  // latest values. Two separate effects so a re-render that only changes
  // one doesn't trigger spurious updates on the other. Initial mount
  // also runs both, populating the setter refs that handleLoadPreset
  // uses to restore script + paramMeta from a loaded preset.
  useEffect(() => {
    scriptTextRef.current = scriptText;
    setScriptTextRef.current = setScriptText;
  }, [scriptText]);
  useEffect(() => {
    scriptParamMetaRef.current = scriptParamMeta;
    setScriptParamMetaRef.current = setScriptParamMeta;
  }, [scriptParamMeta]);
  useEffect(() => {
    scriptParamsRef.current = scriptParams;
  }, [scriptParams]);
  // `scriptInitialized` flips true the first time the user enters Script
  // mode, so we know whether to seed the editor with the current state.
  // Initialized eagerly to `true` whenever a non-empty draft was hydrated
  // from the persistence cache — in that case we already have content to
  // show, and the auto-seed-from-UI on first entry into Script mode would
  // overwrite the user's saved work.
  const scriptInitialized = useRef(loadScriptDraft().content.length > 0);
  const [scriptErrors, setScriptErrors] = useState<ScriptError[]>([]);
  // Inline confirmation banner shown above the editor after a successful
  // apply. Cleared by the next edit so the banner isn't permanent.
  const [scriptApplied, setScriptApplied] = useState<{
    lines: number;
    warnings: number;
  } | null>(null);
  // ── Script v2 state ───────────────────────────────────────────────
  // Captured by handleApplyScript when the user applies a script. The
  // run memo reads these to build the simulator's scriptOverlay; the
  // output panel reads `summaryPrints`/`tradePrints` to render the
  // Strategy / Per-Trade sections. A fresh apply replaces these
  // wholesale (reflecting the latest script source).
  const [scriptNumericOverrides, setScriptNumericOverrides] = useState<
    Record<string, import("@/lib/utils/script-expr").NumericValue> | null
  >(null);
  const [scriptSummaryPrints, setScriptSummaryPrints] = useState<
    import("@/lib/utils/backtest-script").PrintDirective[]
  >([]);
  const [scriptTradePrints, setScriptTradePrints] = useState<
    import("@/lib/utils/backtest-script").PrintDirective[]
  >([]);
  // ── Script v3: Optimize directive state ───────────────────────────
  // Path → OptimizeSpec captured at Apply/Run time. Threaded into the
  // simulator's ScriptOverlay so the online optimizer (in
  // backtest-engine) walks each new signal and re-optimizes the
  // referenced rules.* fields. `optimizeAll` controls joint vs
  // independent search.
  const [scriptOptimizeOverrides, setScriptOptimizeOverrides] = useState<
    Record<string, import("@/lib/utils/script-expr").OptimizeSpec> | null
  >(null);
  const [scriptOptimizeAll, setScriptOptimizeAll] = useState<boolean>(false);
  // `Warmup` flag from the script. Default true (include warmup trades
  // in the final trade list — matches legacy behavior). When false, the
  // online optimizer excludes pre-lookback trades from its return so
  // stats reflect only the post-warmup optimized phase.
  const [scriptWarmup, setScriptWarmup] = useState<boolean>(true);
  // ── Script v2.1: filter.if directives ─────────────────────────────
  // Per-trade conditional filters with action statements (rule
  // overrides, conditional prints, nested filter.if). Captured at
  // Apply and threaded through ScriptOverlay so the simulator can
  // gate each trade and stack rule overrides on top of
  // numericOverrides. Empty array → no conditional filters and the
  // simulator behaves byte-identically to the pre-filter.if path.
  const [scriptFilterIfs, setScriptFilterIfs] = useState<
    import("@/lib/utils/backtest-script").FilterIfDirective[]
  >([]);
  // ── Script Run loading state ──────────────────────────────────────
  // Lights up between the user clicking Run and the next backtest run
  // memo settling. Backtest compute is synchronous on the main thread
  // — for long scripts (TPE across many trades, multi-session, etc.)
  // this can take several seconds. The double-rAF in handleRun lets
  // the browser PAINT the spinner BEFORE the blocking memo kicks in;
  // a useEffect on `runResult` clears the flag once the memo finishes
  // and React commits the new result.
  const [isRunning, setIsRunning] = useState(false);

  // ── Disk-backed script (Claude Code bridge) ──────────────────────────
  // When non-null, every change to `scriptText` is debounced and PUT to
  // `backtests/scripts/<activeScriptName>`, AND a Server-Sent-Events
  // subscription pulls external edits (e.g. Claude Code in a terminal
  // editing the same file) back into the editor. When null, behaviour is
  // identical to the pre-bridge dashboard: scriptText lives only in
  // localStorage + Supabase, never on disk.
  //
  // Why this exists: Claude Code (and any other terminal-side tool) can't
  // see browser-only state. Mirroring the script to a real file lets the
  // user say "edit my backtest script" in their terminal and have the
  // dashboard reflect the change live, and lets Claude analyse run results
  // (also written to disk — see `pendingResultExportRef` below) without
  // having to drive the browser at all.
  const [activeScriptName, setActiveScriptName] = useState<string | null>(null);

  // The list of `.dsl` files currently sitting in `backtests/scripts/`.
  // Populated by `refreshAvailableScripts` on mount and after every
  // create/delete from the picker. Sorted most-recent-first by the API.
  const [availableScripts, setAvailableScripts] = useState<
    Array<{ name: string; mtimeMs: number; sizeBytes: number }>
  >([]);

  // Most-recent mtime our own PUT produced. The SSE subscription compares
  // incoming `changed` events against this and drops anything at-or-before
  // — that's how we tell our own write's echo from a genuine external
  // change. Without this guard the editor would ping-pong: type → PUT →
  // SSE echo → setScriptText (with the same value, but enough to bump the
  // editor's external-sync logic) → re-emit → loop.
  const lastPutMtimeRef = useRef<number>(0);

  // Set true by handleRun, consumed by the post-run export effect. The
  // export effect's deps (`trades`, `runResult`, …) recompute on every
  // filter toggle too — without this gate we'd write a JSON snapshot to
  // disk on every UI fiddle. Setting the flag at click-time and clearing
  // it at consume-time means we write exactly one snapshot per Run press.
  const pendingResultExportRef = useRef<boolean>(false);

  // ── Script-mode run progress (per-signal optimizer + multi-session
  //    walk) ──────────────────────────────────────────────────────────
  // Drives the progress bar in the script editor's sticky nav. Set by
  // the async optimizer effect (`onProgress` callback) and the multi-
  // session walk effect. Null means "no run in progress" — the bar is
  // hidden. We track a stage label so the UI can show a meaningful
  // string ("Optimizing", "Simulating sessions", etc.) instead of just
  // a percent — long runs spend most of their time in the optimizer
  // phase, but a slow first-time multi-session bar fetch + walk can
  // also benefit from feedback.
  const [scriptRunProgress, setScriptRunProgress] = useState<{
    stage: "simulating" | "optimizing";
    current: number;
    total: number;
  } | null>(null);

  // Async-optimizer result cache. The optimizer is the slowest part of
  // a script run (TPE trials × signals); on big data sets a fully
  // synchronous call inside a useMemo blocks the main thread for
  // multiple seconds and the browser flags the page as unresponsive.
  // We move it OUT of useMemo into a useEffect that awaits a yield
  // hook between every signal — the page stays interactive AND the
  // sticky-nav progress bar can paint between iterations.
  //
  // `configKey` identifies the inputs that produced this result; the
  // downstream `tradesAndOptimization` useMemo compares it against the
  // current config to decide whether to use this result or wait for a
  // newer run to land. While a run is in flight we keep showing the
  // last result so filter toggles don't flicker the chart to empty.
  const [asyncOptResult, setAsyncOptResult] = useState<{
    configKey: string;
    trades: SimZoneResult[];
    optimizationHistory?: NonNullable<BacktestRunResult["optimizationHistory"]>;
    optimizationWarnings?: string[];
    /** Funnel metrics captured during the optimizer's per-signal walk
     *  (signals considered, per-directive filter rejection counts).
     *  Threaded through to `tradesAndOptimization` so the per-run
     *  summary export sees the same shape regardless of which
     *  simulator path produced the trades. */
    metrics?: import("@/lib/utils/zone-simulator").SimulateMetrics;
  } | null>(null);
  // Cancel token for the in-flight async optimizer run. When inputs
  // change before the previous run completes, we flip the previous
  // run's flag so it bails between signals (the optimizer checks
  // cancelRef.current at every signal boundary). Without this, two
  // overlapping runs would race to setAsyncOptResult and the user
  // could see the OLD config's result clobber the NEW one.
  const asyncOptCancelRef = useRef<{ current: boolean } | null>(null);

  // ── Script v2 split-pane resize state ──────────────────────────────
  // The left pane's width as a percentage of the outer flex container.
  // Right pane fills the rest. Default 60% (user-confirmed during plan
  // mode), persisted to localStorage on every drag-release. Hydrated
  // from storage on mount so the user's preferred ratio survives
  // reloads. Bounded to [30%, 80%] so neither pane can collapse to
  // unusable width.
  const SCRIPT_SPLIT_KEY = "tradedashboard.scriptSplit";
  const SCRIPT_SPLIT_MIN = 30;
  const SCRIPT_SPLIT_MAX = 80;
  const [scriptLeftPct, setScriptLeftPct] = useState<number>(60);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(SCRIPT_SPLIT_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= SCRIPT_SPLIT_MIN && n <= SCRIPT_SPLIT_MAX) {
        setScriptLeftPct(n);
      }
    }
  }, []);
  // Mirror current value into a ref so onPointerUp can persist the
  // FINAL value without depending on a stale closure (we don't add
  // scriptLeftPct as a dep on onPointerUp because that would re-bind
  // window listeners on every drag tick).
  const scriptLeftPctRef = useRef(60);
  useEffect(() => {
    scriptLeftPctRef.current = scriptLeftPct;
  }, [scriptLeftPct]);
  const splitDraggingRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  // Native MouseEvent / PointerEvent both expose .clientX so the
  // handler reads the same property regardless of which event fires.
  // Using `MouseEvent` as the param type works because PointerEvent
  // extends MouseEvent in the DOM-types hierarchy too.
  const onSplitMove = useCallback((e: MouseEvent) => {
    if (!splitDraggingRef.current) return;
    const el = splitContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = Math.max(SCRIPT_SPLIT_MIN, Math.min(SCRIPT_SPLIT_MAX, pct));
    setScriptLeftPct(clamped);
  }, []);

  const onSplitUp = useCallback(() => {
    if (!splitDraggingRef.current) return;
    splitDraggingRef.current = false;
    window.removeEventListener("pointermove", onSplitMove);
    window.removeEventListener("pointerup", onSplitUp);
    window.removeEventListener("mousemove", onSplitMove);
    window.removeEventListener("mouseup", onSplitUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          SCRIPT_SPLIT_KEY,
          String(scriptLeftPctRef.current)
        );
      } catch {
        // Quota / disabled storage — silent ignore.
      }
    }
  }, [onSplitMove]);

  // Bound to BOTH onPointerDown and onMouseDown — using the supertype
  // React.MouseEvent (PointerEvent extends MouseEvent in React's types)
  // so the same handler accepts either. Two listeners are intentional:
  // pointer events handle modern touch/pen reliably, the mouse fallback
  // catches the rare environment where pointer events misbehave.
  const onSplitDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // De-dupe between pointer + mouse events — if both fire for the
      // same physical down, only the first should arm the drag.
      if (splitDraggingRef.current) return;
      splitDraggingRef.current = true;
      window.addEventListener("pointermove", onSplitMove);
      window.addEventListener("pointerup", onSplitUp);
      window.addEventListener("mousemove", onSplitMove);
      window.addEventListener("mouseup", onSplitUp);
      // Lock cursor + suppress text selection across the whole page
      // while dragging — otherwise the drag selects text under the
      // cursor as it moves.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onSplitMove, onSplitUp]
  );

  /** Stable handler passed to the editor. Stability matters here because
   *  the editor is wrapped in `React.memo`: a fresh inline arrow function
   *  on every dashboard render would defeat the memoization and cause
   *  the (heavy) editor to re-render whenever ANY dashboard state
   *  changed. Depending on `scriptApplied` is fine — that toggle only
   *  flips on Apply / first-edit-after-apply, neither of which is in the
   *  hot typing path. */
  const handleScriptChange = useCallback(
    (next: string) => {
      setScriptText(next);
      if (scriptApplied) setScriptApplied(null);
      // Mark the editor as user-touched so the async Supabase sync
      // resolving after this point won't overwrite in-progress edits with
      // a stale server copy.
      scriptUserEditedRef.current = true;
      // Persist to localStorage synchronously and fire a Supabase upsert
      // in the background. The upstream editor already debounces emits
      // by ~150ms so this fires at most ~7x/sec during sustained typing
      // — fine for a single-user app and acceptable network volume.
      saveScriptDraft(next);
    },
    [scriptApplied]
  );

  // ─── Script ↔ dashboard-state bridge ──────────────────────────────
  // Snapshot every script-controllable piece of state into a single
  // BacktestConfig object. Used to seed the editor on first toggle into
  // Script mode and to re-sync on demand. Mirrors the state-snapshot logic
  // used by handleSavePreset (sans the preset metadata) — keep them aligned
  // when adding new script-able fields.
  const buildConfigSnapshot = useCallback((): BacktestConfig => {
    return {
      strategy: strategyId,
      params: { ...params },
      rules: { ...rules },
      filters: {
        time: {
          enabled: timeFilterEnabled,
          from: timeFrom,
          to: timeTo,
          // BacktestConfig serializes windows as "HH:MM-HH:MM" strings
          // (matches the script DSL stringArray format). The dashboard
          // keeps them as objects; convert here so the editor sees the
          // wire shape it expects.
          windows: timeWindows.map((w) => `${w.from}-${w.to}`),
        },
        adx: {
          enabled: adxFilterEnabled,
          min: adxMin,
          max: adxMax,
          period: adxPeriod,
        },
        atr: {
          enabled: atrFilterEnabled,
          min: atrMin,
          max: atrMax,
          period: atrPeriod,
        },
        trend: {
          enabled: trendFilterEnabled,
          ema20: ema20Mode,
          ema200: ema200Mode,
          fastPeriod: trendFastPeriod,
          fastType: trendFastType,
          slowPeriod: trendSlowPeriod,
          slowType: trendSlowType,
        },
        bollinger: {
          enabled: bollingerFilterEnabled,
          allowed: Array.from(bollingerAllowed) as BollingerPos[],
          period: bollingerPeriod,
          stdDev: bollingerStdDev,
        },
        bbWidth: {
          enabled: bbWidthFilterEnabled,
          min: bbWidthMin,
          max: bbWidthMax,
        },
        maDistance: {
          enabled: maDistanceFilterEnabled,
          period: maDistancePeriod,
          type: maDistanceType,
          mode: maDistanceMode,
          min: maDistanceMin,
          max: maDistanceMax,
        },
        volume: {
          enabled: volumeFilterEnabled,
          period: volumeMaPeriod,
          minRatio: volumeMinRatio,
          maxRatio: volumeMaxRatio,
        },
        rsi: {
          enabled: rsiFilterEnabled,
          period: rsiPeriod,
          min: rsiMin,
          max: rsiMax,
        },
        adxTrend: {
          enabled: adxTrendFilterEnabled,
          mode: adxTrendMode,
          lookback: adxTrendLookback,
          flatThreshold: adxTrendFlatThreshold,
        },
        delta: {
          enabled: deltaFilterEnabled,
          min: deltaMin,
          max: deltaMax,
        },
      },
    };
  }, [
    strategyId,
    params,
    rules,
    timeFilterEnabled,
    timeWindows,
    timeFrom,
    timeTo,
    adxFilterEnabled,
    adxMin,
    adxMax,
    adxPeriod,
    atrFilterEnabled,
    atrMin,
    atrMax,
    atrPeriod,
    trendFilterEnabled,
    ema20Mode,
    ema200Mode,
    trendFastPeriod,
    trendFastType,
    trendSlowPeriod,
    trendSlowType,
    bollingerFilterEnabled,
    bollingerAllowed,
    bollingerPeriod,
    bollingerStdDev,
    bbWidthFilterEnabled,
    bbWidthMin,
    bbWidthMax,
    maDistanceFilterEnabled,
    maDistancePeriod,
    maDistanceType,
    maDistanceMode,
    maDistanceMin,
    maDistanceMax,
    volumeFilterEnabled,
    volumeMaPeriod,
    volumeMinRatio,
    volumeMaxRatio,
    rsiFilterEnabled,
    rsiPeriod,
    rsiMin,
    rsiMax,
    adxTrendFilterEnabled,
    adxTrendMode,
    adxTrendLookback,
    adxTrendFlatThreshold,
    deltaFilterEnabled,
    deltaMin,
    deltaMax,
  ]);

  /** Pull the dashboard's current state into the editor. The user can
   *  click "Sync from UI" any time they want to discard their script edits
   *  and re-derive a script from whatever the click-through controls
   *  currently say. Also runs automatically the first time the user enters
   *  Script mode so the editor doesn't open empty. */
  const syncScriptFromState = useCallback(() => {
    const snapshot = buildConfigSnapshot();
    const text = serializeBacktestScript(snapshot);
    setScriptText(text);
    setScriptErrors([]);
    setScriptApplied(null);
    // Persist the freshly-derived script as the active draft so the
    // editor hydrates to the same content next reload. Treat this as a
    // user-initiated edit for the purposes of guarding against late
    // server-sync overwrites.
    scriptUserEditedRef.current = true;
    saveScriptDraft(text);
  }, [buildConfigSnapshot]);

  /** Pull the current contents of `backtests/scripts/` into
   *  `availableScripts` so the picker dropdown stays in sync with disk.
   *  Called on mount, after Save-as-new, and could be called after a
   *  delete (no UI for that yet). Network failure leaves the list as-is
   *  rather than blanking it — a transient blip shouldn't make a file
   *  the user just selected disappear from the dropdown. */
  const refreshAvailableScripts = useCallback(async () => {
    try {
      const r = await fetch("/api/scripts");
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data?.scripts)) {
        setAvailableScripts(data.scripts);
      }
    } catch {
      // Server not reachable / dev not running — silent. The picker
      // already handles the empty-list case.
    }
  }, []);

  /** Load a disk-backed script into the editor and bind future edits to
   *  it. After this call:
   *    - `scriptText` holds the file's content (and the editor reflects it
   *      via its external-value sync).
   *    - `activeScriptName` is set, so the debounced-PUT effect mirrors
   *      every keystroke back to disk and the SSE effect picks up external
   *      edits live.
   *    - The localStorage draft is overwritten with the file's content so
   *      the next reload (which hydrates from localStorage synchronously)
   *      shows the same starting point even before the file fetch resolves.
   *
   *  Failure modes: a network error or 404 silently no-ops — the picker
   *  re-renders with the previous selection.
   */
  const handleLoadScript = useCallback(
    async (name: string) => {
      try {
        const r = await fetch(`/api/scripts/${encodeURIComponent(name)}`);
        if (!r.ok) return;
        const data = await r.json();
        if (typeof data?.content !== "string") return;
        // Seed lastPutMtimeRef with the just-loaded mtime so the SSE
        // subscription that arms on `setActiveScriptName` doesn't treat
        // the watcher's catch-up event as a fresh external write.
        if (typeof data?.mtimeMs === "number") {
          lastPutMtimeRef.current = data.mtimeMs;
        }
        setScriptText(data.content);
        saveScriptDraft(data.content);
        setActiveScriptName(name);
        setScriptErrors([]);
        setScriptApplied(null);
        scriptUserEditedRef.current = true;
      } catch {
        // Server unreachable — leave state untouched.
      }
    },
    []
  );

  /** Save the current `scriptText` to disk as a NEW file the user names,
   *  then bind the editor to it. Used by the picker's "Save as new…"
   *  option and by the first-run path when no disk script exists yet.
   *
   *  Names are validated client-side against the same regex the API
   *  enforces so the user gets immediate feedback rather than a 400 from
   *  the server. The `.dsl` suffix is appended automatically when the
   *  user omits it — matches the behaviour most editors have for
   *  "save as" prompts.
   */
  const handleSaveAsNewScript = useCallback(async () => {
    const raw = window.prompt(
      "Save script to disk as (e.g. my-script):",
      activeScriptName ? activeScriptName.replace(/\.dsl$/, "") + "-copy" : ""
    );
    if (!raw) return;
    const name = raw.endsWith(".dsl") ? raw : `${raw}.dsl`;
    if (!/^[A-Za-z0-9._-]+\.dsl$/.test(name)) {
      window.alert(
        "Name must contain only letters, digits, dot, dash, or underscore (and end in .dsl)."
      );
      return;
    }
    try {
      const r = await fetch(`/api/scripts/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: scriptText }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        window.alert(`Save failed: ${err?.error ?? r.statusText}`);
        return;
      }
      const data = await r.json();
      if (typeof data?.mtimeMs === "number") {
        lastPutMtimeRef.current = data.mtimeMs;
      }
      setActiveScriptName(name);
      void refreshAvailableScripts();
    } catch (err) {
      window.alert(`Save failed: ${(err as Error).message}`);
    }
  }, [scriptText, activeScriptName, refreshAvailableScripts]);

  /** Replace the editor with a fresh script derived from the canonical
   *  default config — every schema field emitted at its default value.
   *  Useful as a "start over" reset that ignores whatever the dashboard
   *  controls currently say (which is what Sync from UI honors). Mirrors
   *  the persistence behavior of syncScriptFromState so the reset
   *  survives a reload. */
  const loadDefaultScript = useCallback(() => {
    // includeFilterIfTemplates surfaces the modern `filter.if = ...`
    // examples block in place of the legacy `filters.X.enabled = false`
    // scaffolding (which is now hidden by default). Sync from UI does
    // NOT pass this flag — that path is a faithful state serialiser
    // and shouldn't inject template content.
    const text = serializeBacktestScript(defaultBacktestConfig(), {
      includeFilterIfTemplates: true,
    });
    setScriptText(text);
    setScriptErrors([]);
    setScriptApplied(null);
    scriptUserEditedRef.current = true;
    saveScriptDraft(text);
  }, []);

  /** Parse the editor and apply only the fields the user actually wrote.
   *  Uses the same setters the click-through UI uses, so optimizers /
   *  other components see the change exactly as if a UI input had been
   *  edited. Out-of-strategy params are tolerated (warnings only) so
   *  swapping `strategy = "..."` works in two passes if needed. */
  const handleApplyScript = useCallback(() => {
    // ── loadstrategy rewrite (visible) ─────────────────────────────
    // If the script contains `loadstrategy = X`, materialize the swap
    // in the EDITOR text before we parse: the loadstrategy line is
    // replaced by `strategy = "X"` plus the new strategy's full
    // params.* defaults block, and any prior strategy / params lines
    // are dropped. The user immediately sees the new params in the
    // editor and can edit individual values from there. We re-feed
    // the rewritten text into the editor + the draft persistence
    // layer, then parse the rewritten text below.
    let textForParse = scriptText;
    const rewrite = applyLoadStrategyRewrite(scriptText);
    if (rewrite && rewrite.ok) {
      textForParse = rewrite.text;
      setScriptText(textForParse);
      saveScriptDraft(textForParse);
      scriptUserEditedRef.current = true;
      showToast(
        `loadstrategy → ${rewrite.strategyId} · ${rewrite.paramCount} params loaded into script`
      );
    } else if (rewrite && !rewrite.ok) {
      // Malformed loadstrategy line — surface the error and bail
      // BEFORE parsing. parseBacktestScript would also flag it via
      // the pre-pass, but exiting here keeps the editor's text
      // untouched (no destructive rewrite on a typo).
      setScriptErrors([
        { line: rewrite.line, message: rewrite.error, severity: "error" },
      ]);
      return;
    }

    const result = parseBacktestScript(textForParse);
    setScriptErrors(result.errors);
    const cfg = result.config;

    // Freeze the script text the run memos see at this moment. After
    // this, further keystrokes only update `scriptText` (which the
    // editor reads) — the run pipeline stays pinned to whatever was
    // applied here until the user clicks Run again.
    setAppliedScriptText(textForParse);

    // ── Script v2: capture overlay artifacts ────────────────────────
    // numericOverrides drive per-trade rule evaluation; summaryPrints /
    // tradePrints drive the output panel + inline cards/columns. Always
    // replace — empty/undefined collections mean "no script-driven
    // outputs", and we want the dashboard to reflect that immediately.
    setScriptNumericOverrides(cfg.numericOverrides ?? null);
    setScriptSummaryPrints(cfg.summaryPrints ?? []);
    setScriptTradePrints(cfg.tradePrints ?? []);
    // ── Script v3: capture Optimize directives + OptimizeAll. Empty
    // map (or absent) means "no optimization" and the run memo will
    // skip the online optimizer path entirely.
    setScriptOptimizeOverrides(cfg.optimizeOverrides ?? null);
    setScriptOptimizeAll(cfg.optimizeAll ?? false);
    setScriptWarmup(cfg.warmup ?? true);
    // ── Script v2.1: capture filter.if directives. Always replace —
    // empty array means "no conditional filters this run".
    setScriptFilterIfs(cfg.filterIfs ?? []);

    // Strategy first — it determines which params the dashboard expects.
    let strategyChanged = false;
    if (cfg.strategy && cfg.strategy !== strategyId) {
      const found = STRATEGIES.find((s) => s.id === cfg.strategy);
      if (found) {
        setStrategyId(cfg.strategy);
        strategyChanged = true;
      }
    }

    if (cfg.params) {
      // Merge user-set params into the global flat dict. We don't gate
      // by strategy here — the user can set any param and the active
      // generator just reads what it needs. Existing param values stay
      // in place if the script doesn't mention them, so partial scripts
      // (e.g. tweaking just `params.lookback`) Just Work.
      //
      // EXCEPTION — when the script used `loadstrategy = X`, the parser
      // sets cfg.replaceParams so the dashboard does a full REPLACE
      // instead of merge. That guarantees stale params from the
      // previously selected strategy don't leak through (e.g. when
      // signal_v1 had a `lookback` and signal_v2 doesn't, we don't
      // want lookback hanging around in the params dict).
      if (cfg.replaceParams) {
        setParams({ ...cfg.params });
      } else {
        setParams((prev) => ({ ...prev, ...cfg.params }));
      }
      setParamsVersion((v) => v + 1);
    }

    // Apply rules from the script with two new conventions:
    //   1. EVERY *Enabled flag defaults to false on each Apply — the
    //      script is the source of truth, and a flag the user didn't
    //      mention should NOT silently inherit `true` from a previous
    //      Apply or from DEFAULT_SIM_RULES' historical defaults.
    //   2. Setting a value field (e.g. `rules.stopLossPoints = 10`)
    //      auto-enables its sibling (`stopLossEnabled = true`) UNLESS
    //      the user explicitly set the enabled flag on the script.
    //      This makes "I want a stop at 10" expressible as one line
    //      instead of two.
    // Numerical-only fields (slAtrAdjust, scalingStartSize, etc.) are
    // unaffected — they don't have a single boolean to flip.
    if (cfg.rules) {
      const VALUE_TO_ENABLED: Record<string, keyof SimRules> = {
        stopLossPoints: "stopLossEnabled",
        takeProfitPoints: "takeProfitEnabled",
        trailingStopPoints: "trailingStopEnabled",
        timedExitBars: "timedExitEnabled",
        breakEvenTrigger: "breakEvenEnabled",
        extensionBars: "extensionBarsEnabled",
        dailyStopLossPoints: "dailyStopLossEnabled",
        dailyTakeProfitPoints: "dailyTakeProfitEnabled",
        maxTradesPerDay: "maxTradesPerDayEnabled",
        maxLossesPerDay: "maxLossesPerDayEnabled",
        cooldownBetweenTradesBars: "cooldownBetweenTradesEnabled",
      };
      const ALL_RULES_DISABLED: Partial<SimRules> = {
        stopLossEnabled: false,
        takeProfitEnabled: false,
        trailingStopEnabled: false,
        timedExitEnabled: false,
        breakEvenEnabled: false,
        extensionBarsEnabled: false,
        dailyStopLossEnabled: false,
        dailyTakeProfitEnabled: false,
        maxTradesPerDayEnabled: false,
        maxLossesPerDayEnabled: false,
        cooldownBetweenTradesEnabled: false,
        // scalingEnabled is intentionally omitted from auto-inference
        // — it's a multi-field feature with no single "value" to key
        // off. Reset to false here too so users have to opt-in via an
        // explicit `rules.scalingEnabled = true`.
        scalingEnabled: false,
      };
      const inferred: Partial<SimRules> = { ...ALL_RULES_DISABLED };
      const cfgRules = cfg.rules as Record<string, unknown>;
      for (const [valKey, enKey] of Object.entries(VALUE_TO_ENABLED)) {
        if (valKey in cfgRules && !(enKey in cfgRules)) {
          (inferred as Record<string, boolean>)[enKey as string] = true;
        }
      }
      // Merge order: previous state → all-disabled → inferred enables
      // from value-field presence → script's explicit overrides last.
      setRules((prev) => ({ ...prev, ...inferred, ...cfg.rules }));
      setRulesVersion((v) => v + 1);
    } else {
      // Script has no rules at all — still reset the *Enabled flags to
      // false so a previously-applied script with `rules.stopLossPoints`
      // doesn't leave its enable lit when the next script omits it.
      setRules((prev) => ({
        ...prev,
        stopLossEnabled: false,
        takeProfitEnabled: false,
        trailingStopEnabled: false,
        timedExitEnabled: false,
        breakEvenEnabled: false,
        extensionBarsEnabled: false,
        dailyStopLossEnabled: false,
        dailyTakeProfitEnabled: false,
        maxTradesPerDayEnabled: false,
        maxLossesPerDayEnabled: false,
        cooldownBetweenTradesEnabled: false,
        scalingEnabled: false,
      }));
      setRulesVersion((v) => v + 1);
    }

    if (cfg.filters?.time) {
      const t = cfg.filters.time;
      if (t.enabled !== undefined) setTimeFilterEnabled(t.enabled);
      // Multi-window is the source of truth — when the script writes
      // `filters.time.windows`, parse "HH:MM-HH:MM" entries and replace
      // the whole list. When only legacy from/to are written, update
      // windows[0] in-place so the dashboard renders the change.
      if (t.windows !== undefined) {
        const parsed: TimeWindow[] = [];
        for (const raw of t.windows) {
          if (typeof raw !== "string") continue;
          const dashIdx = raw.indexOf("-");
          if (dashIdx <= 0) continue;
          const from = raw.slice(0, dashIdx).trim();
          const to = raw.slice(dashIdx + 1).trim();
          if (from && to) parsed.push({ from, to });
        }
        if (parsed.length > 0) setTimeWindows(parsed);
      } else if (t.from !== undefined || t.to !== undefined) {
        setTimeWindows((prev) => {
          const first = prev[0] ?? { from: "09:30", to: "16:00" };
          const next = [...prev];
          next[0] = {
            from: t.from ?? first.from,
            to: t.to ?? first.to,
          };
          return next;
        });
      }
    }
    if (cfg.filters?.adx) {
      const a = cfg.filters.adx;
      if (a.enabled !== undefined) setAdxFilterEnabled(a.enabled);
      if (a.min !== undefined) setAdxMin(a.min);
      if (a.max !== undefined) setAdxMax(a.max);
      if (a.period !== undefined) setAdxPeriod(a.period);
    }
    if (cfg.filters?.atr) {
      const a = cfg.filters.atr;
      if (a.enabled !== undefined) setAtrFilterEnabled(a.enabled);
      if (a.min !== undefined) setAtrMin(a.min);
      if (a.max !== undefined) setAtrMax(a.max);
      if (a.period !== undefined) setAtrPeriod(a.period);
    }
    if (cfg.filters?.trend) {
      const t = cfg.filters.trend;
      if (t.enabled !== undefined) setTrendFilterEnabled(t.enabled);
      if (t.ema20 !== undefined) setEma20Mode(t.ema20);
      if (t.ema200 !== undefined) setEma200Mode(t.ema200);
      if (t.fastPeriod !== undefined) setTrendFastPeriod(t.fastPeriod);
      if (t.fastType !== undefined) setTrendFastType(t.fastType);
      if (t.slowPeriod !== undefined) setTrendSlowPeriod(t.slowPeriod);
      if (t.slowType !== undefined) setTrendSlowType(t.slowType);
    }
    if (cfg.filters?.bollinger) {
      const b = cfg.filters.bollinger;
      if (b.enabled !== undefined) setBollingerFilterEnabled(b.enabled);
      if (b.allowed !== undefined) setBollingerAllowed(new Set(b.allowed));
      if (b.period !== undefined) setBollingerPeriod(b.period);
      if (b.stdDev !== undefined) setBollingerStdDev(b.stdDev);
    }
    if (cfg.filters?.bbWidth) {
      const b = cfg.filters.bbWidth;
      if (b.enabled !== undefined) setBbWidthFilterEnabled(b.enabled);
      if (b.min !== undefined) setBbWidthMin(b.min);
      if (b.max !== undefined) setBbWidthMax(b.max);
    }
    if (cfg.filters?.maDistance) {
      const m = cfg.filters.maDistance;
      if (m.enabled !== undefined) setMaDistanceFilterEnabled(m.enabled);
      if (m.period !== undefined) setMaDistancePeriod(m.period);
      if (m.type !== undefined) setMaDistanceType(m.type);
      if (m.mode !== undefined) setMaDistanceMode(m.mode);
      if (m.min !== undefined) setMaDistanceMin(m.min);
      if (m.max !== undefined) setMaDistanceMax(m.max);
    }
    if (cfg.filters?.volume) {
      const v = cfg.filters.volume;
      if (v.enabled !== undefined) setVolumeFilterEnabled(v.enabled);
      if (v.period !== undefined) setVolumeMaPeriod(v.period);
      if (v.minRatio !== undefined) setVolumeMinRatio(v.minRatio);
      if (v.maxRatio !== undefined) setVolumeMaxRatio(v.maxRatio);
    }
    if (cfg.filters?.rsi) {
      const r = cfg.filters.rsi;
      if (r.enabled !== undefined) setRsiFilterEnabled(r.enabled);
      if (r.period !== undefined) setRsiPeriod(r.period);
      if (r.min !== undefined) setRsiMin(r.min);
      if (r.max !== undefined) setRsiMax(r.max);
    }
    if (cfg.filters?.adxTrend) {
      const a = cfg.filters.adxTrend;
      if (a.enabled !== undefined) setAdxTrendFilterEnabled(a.enabled);
      if (a.mode !== undefined) setAdxTrendMode(a.mode);
      if (a.lookback !== undefined) setAdxTrendLookback(a.lookback);
      if (a.flatThreshold !== undefined) setAdxTrendFlatThreshold(a.flatThreshold);
    }
    if (cfg.filters?.delta) {
      const d = cfg.filters.delta;
      if (d.enabled !== undefined) setDeltaFilterEnabled(d.enabled);
      if (d.min !== undefined) setDeltaMin(d.min);
      if (d.max !== undefined) setDeltaMax(d.max);
    }

    // Banner feedback. We count "applied lines" as anything that didn't
    // raise a hard error — warnings are still applied, so a row that
    // raised "out of suggested range" still counts.
    const errorLines = result.errors.filter((e) => e.severity === "error").length;
    const totalLines = scriptText
      .split(/\n/)
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("#");
      }).length;
    setScriptApplied({
      lines: Math.max(0, totalLines - errorLines),
      warnings: result.errors.filter((e) => e.severity === "warning").length,
    });

    // Plain `strategy = X` toast — only when the strategy actually
    // changed. Skip when we already toasted from the loadstrategy
    // rewrite path above (that branch returned early-ish via the
    // textForParse swap, but we still flow through this code path).
    if (strategyChanged && !rewrite) {
      showToast(`Applied script · strategy → ${cfg.strategy}`);
    }
  }, [scriptText, strategyId, showToast]);

  // ─── Auto-apply script on edit ───────────────────────────────────
  // The editor is the single source of truth for the strategy. Whenever
  // `scriptText` changes (load preset, type in editor, sync from disk,
  // SSE echo, etc.), automatically run handleApplyScript so the runtime
  // memos / strategyOverride track the editor verbatim. Eliminates the
  // "I edited the script but the dashboard is running the previously-
  // applied version" footgun.
  //
  // Debounced 250ms so a sustained typing burst doesn't hammer the
  // parser. parseStrategyScript is called once when the user pauses.
  // Skipping when scriptText is empty avoids running on first mount
  // before the localStorage / Supabase / disk hydration completes.
  useEffect(() => {
    if (!scriptText) return;
    const t = setTimeout(() => {
      handleApplyScript();
    }, 250);
    return () => clearTimeout(t);
  }, [scriptText, handleApplyScript]);

  /** Run handler — wraps handleApplyScript with a loading-state flip
   *  so the user sees visible feedback while the (synchronous)
   *  backtest compute runs. Two requestAnimationFrame layers force
   *  the browser to PAINT the spinner BEFORE we trigger the memo
   *  recompute: the first rAF schedules a callback for the next
   *  frame's start, the second one runs after that frame is painted.
   *  Without this double-rAF, the React batching can fold the
   *  setIsRunning(true) into the same commit as the heavy compute,
   *  and the user sees the button never change state on the way in.
   *  The clear-side is handled by a useEffect on `runResult` so the
   *  spinner stays up until the new backtest result actually
   *  commits. */
  const handleRun = useCallback(() => {
    setIsRunning(true);
    // Arm the disk-results export so the post-run effect knows this
    // upcoming `trades` recompute was triggered by an explicit Run click,
    // not by a filter-toggle / param-tweak that also invalidates the same
    // memos. Cleared by the export effect once it fires (or when no
    // `activeScriptName` is set, in which case there's nothing to export).
    pendingResultExportRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        handleApplyScript();
      });
    });
  }, [handleApplyScript]);

  /** Abort an in-flight script run. Flips the optimizer's cancel flag
   *  so its main loop breaks at the next signal boundary (worst case
   *  one yield interval — ~50ms — before it actually stops). The
   *  effect's post-await guard then sees the cancel and skips the
   *  setAsyncOptResult write, so the LAST GOOD result keeps showing
   *  in the chart instead of being clobbered by a partial trade list.
   *  Progress + spinner clear synchronously so the UI snaps back even
   *  if the optimizer hasn't reached its next yield point yet. */
  const handleCancelRun = useCallback(() => {
    if (asyncOptCancelRef.current) {
      asyncOptCancelRef.current.current = true;
    }
    setScriptRunProgress(null);
    setIsRunning(false);
  }, []);

  // ─── Bar cache: session_id → ReplayBar[] ─────────────────────────
  // Filled lazily as days are selected. Toggling a day off does NOT clear the
  // cache so re-selecting it is instant. `loadingSessionIds` tracks fetches
  // in flight so the UI can render a spinner per-day.
  const [barsBySessionId, setBarsBySessionId] = useState<Map<number, ReplayBar[]>>(
    () => new Map()
  );
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<number>>(
    () => new Set()
  );
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Refs that mirror the maps above. The fetch callback reads from these
  // (not the state) for its already-cached / already-loading short-circuits
  // so its useCallback identity stays stable across renders. Without this,
  // every fetch completion would change `fetchBarsForSession`'s identity
  // → re-fire the trigger useEffect → re-iterate every selected session
  // (cheap individually, but explodes when you click many sessions in a
  // row because the runResult memo also re-runs on each cycle).
  const barsBySessionIdRef = useRef(barsBySessionId);
  const loadingSessionIdsRef = useRef(loadingSessionIds);
  useEffect(() => {
    barsBySessionIdRef.current = barsBySessionId;
  }, [barsBySessionId]);
  useEffect(() => {
    loadingSessionIdsRef.current = loadingSessionIds;
  }, [loadingSessionIds]);

  // ─── Tick aggregation state ──────────────────────────────────────
  // For tick / tick_bidask sessions there is no replay_bars row to fetch —
  // the gzipped CSV blob has to be downloaded, decompressed, parsed into
  // typed arrays, and aggregated to bars at a user-chosen timeframe. The
  // existing strategies, simulator, optimizer, and presets all consume
  // ReplayBar[], so the synthesized bars slot in transparently once
  // they're in `barsBySessionId`.
  //
  // Default 15s — preserves the original "15s OHLCV" feel of the
  // backtester. Visible only when a tick session is selected.
  const [aggregationTimeframeSec, setAggregationTimeframeSec] = useState(15);

  // ParsedTicks (typed arrays) cached per session id. Survives timeframe
  // changes so re-aggregating at a different period is a ~50ms walk
  // instead of a multi-second blob download + parse. Kept in a ref since
  // the typed arrays can be tens of MB — we don't want React capturing
  // them in render closures or triggering renders just because they exist.
  const ticksBySessionIdRef = useRef<Map<number, ParsedTicks>>(new Map());

  // Per-bar tick ranges produced by aggregateTicksWithRanges, keyed by
  // session id and re-built whenever bars are re-aggregated. Tick-driven
  // DSL indicators (POC/VAH/VAL, vwap_tick, large_trade_count, etc.)
  // need this to map zone bars back to their constituent ticks without
  // re-walking the entire tick stream.
  const tickRangesBySessionIdRef = useRef<Map<number, Int32Array>>(new Map());

  // Tracks which `aggregationTimeframeSec` value each cached tick-derived
  // bar set was synthesized at, so a timeframe change can invalidate
  // stale entries without scanning the bars themselves. Stays in a ref
  // (not state) because consumers only read it via fetchBarsForSession.
  const barAggregationSecondsRef = useRef<Map<number, number>>(new Map());

  // Same for the active aggregation timeframe — the fetcher reads it
  // through a ref so the useCallback can keep stable identity.
  const aggregationTimeframeSecRef = useRef(aggregationTimeframeSec);
  useEffect(() => {
    aggregationTimeframeSecRef.current = aggregationTimeframeSec;
  }, [aggregationTimeframeSec]);

  // Quick check used by the UI: are any selected sessions tick-derived?
  // Drives whether the timeframe selector renders. Memoized so the chip
  // grid + timeframe panel don't both re-walk the selection on every
  // render.
  const hasTickSession = useMemo(() => {
    if (selectedSessionIds.size === 0) return false;
    for (const id of selectedSessionIds) {
      const s = sessions.find((x) => x.id === id);
      if (s && (s.granularity === "tick" || s.granularity === "tick_bidask")) {
        return true;
      }
    }
    return false;
  }, [selectedSessionIds, sessions]);

  // ─── Optimizer state (SL/TP/TSL grid search + ATR-Adjust) ────────
  // Mirrors the risk simulator's optimizer plumbing: a config modal opens
  // first so the user can tune ranges, then a chunked run drives a progress
  // bar back through SimulatorControls. Both optimizers consume the same
  // synthetic-zone array the live preview uses, so the search space exactly
  // matches what the user is currently looking at.
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState<number | null>(null);
  const cancelRef = useRef(false);
  const [showOptimizeConfigModal, setShowOptimizeConfigModal] = useState(false);
  // Session-lived config (not persisted) so reopening the modal preserves the
  // last values without surviving a page reload.
  const [optimizeConfig, setOptimizeConfig] = useState<OptimizeConfig>(DEFAULT_OPTIMIZE_CONFIG);

  const [optimizingAtr, setOptimizingAtr] = useState(false);
  const [optimizeAtrProgress, setOptimizeAtrProgress] = useState<number | null>(null);
  const atrCancelRef = useRef(false);
  const [showOptimizeAtrConfigModal, setShowOptimizeAtrConfigModal] = useState(false);
  const [optimizeAtrConfig, setOptimizeAtrConfig] = useState<AtrAdjustOptimizeConfig>(
    DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG
  );

  // ─── Time optimization state ──────────────────────────────────────
  // Mirrors the risk simulator: a min-window-size modal opens first, then
  // runTimeOptimizeChunked sweeps every contiguous 30-min window over the
  // currently-loaded synthetic zones and applies the best one (by avg
  // points/trade) back into the time filter inputs.
  const [optimizingTime, setOptimizingTime] = useState(false);
  const [optimizeTimeProgress, setOptimizeTimeProgress] = useState<number | null>(null);
  const [showTimeOptModal, setShowTimeOptModal] = useState(false);
  const timeCancelRef = useRef(false);

  // ─── Export modal state (AI JSON export) ──────────────────────────
  // CSV export is triggered immediately on click; the AI export needs a
  // modal so the user can pick how many pre-entry bars to bundle per trade.
  const [showExportDetailedModal, setShowExportDetailedModal] = useState(false);
  // Same MAX_PRE_ENTRY_BARS the risk simulator uses, so the slider's upper
  // bound matches what the backtest engine emits per synthetic zone.
  const MAX_PRE_ENTRY_BARS = 30;

  // ─── Composite ("perfect winning trade") panel ────────────────────
  // Toggles the composite-trade panel below the equity curve. The
  // composite stacks every winning trade onto a normalized timeline
  // (entry → exit) and shows the median/percentile envelope so the
  // user can read the SHAPE of a typical winner. Computation is gated
  // behind this flag — building it is cheap, but we still avoid the
  // work (and the chart's spaghetti render) until the user opts in.
  const [showCompositeTrade, setShowCompositeTrade] = useState(false);

  // Sibling toggle for the OHLC-bars composite. Renders the same set of
  // winners as `showCompositeTrade` but visualizes them as a candlestick
  // chart (one for longs, one for shorts) using TradingView's
  // lightweight-charts. Independent toggle so the user can show one,
  // the other, or both — whichever is most useful for the question
  // they're asking.
  const [showCompositeBars, setShowCompositeBars] = useState(false);

  // Force-remount key for SimulatorControls so the uncontrolled numeric inputs
  // pick up the new rule values after an optimizer run merges its result. The
  // risk simulator uses the same trick (rulesVersion).
  const [rulesVersion, setRulesVersion] = useState(0);

  // Bumped when a strategy-param optimizer mutates the param value, so
  // the uncontrolled `defaultValue` input remounts and shows the new
  // number. Without this the input would visually retain whatever the
  // user last typed, even though state has the optimizer's pick.
  const [paramsVersion, setParamsVersion] = useState(0);

  // Per-strategy-param optimizer state. `optimizingParamKey` doubles as
  // the busy lock — only one param can run at a time. `paramOptCancelRef`
  // is forwarded to the worker runner so clicking the same OPT button
  // again mid-run cancels gracefully.
  const [optimizingParamKey, setOptimizingParamKey] = useState<string | null>(
    null
  );
  const [optimizeParamProgress, setOptimizeParamProgress] = useState<
    number | null
  >(null);
  const paramOptCancelRef = useRef(false);

  // Cancel any in-flight optimizer when the component unmounts so the chunked
  // generator stops scheduling rAFs after the user navigates away.
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      atrCancelRef.current = true;
      timeCancelRef.current = true;
      paramOptCancelRef.current = true;
    };
  }, []);

  // First time the user enters Script mode, seed the editor with the
  // current dashboard state so they're not staring at an empty box. We use
  // a ref to make this a one-shot — subsequent toggles back to Script
  // preserve whatever the user had typed.
  useEffect(() => {
    if (mode === "script" && !scriptInitialized.current) {
      scriptInitialized.current = true;
      syncScriptFromState();
    }
  }, [mode, syncScriptFromState]);

  // ── Supabase sync for the script draft ────────────────────────────────
  // On mount, reconcile the localStorage cache (already used to seed
  // `scriptText`) with the server copy of the draft. If the server copy
  // is newer, adopt it locally — UNLESS the user has already started
  // typing in this session, in which case the in-progress edit wins
  // (last-write-wins by `updated_at` would otherwise let a stale-but-
  // newer-timestamped server row overwrite live keystrokes).
  //
  // Runs once on mount only. Subsequent saves go straight to Supabase
  // via `saveScriptDraft` inside `handleScriptChange`, so we never need
  // to re-pull during a session.
  useEffect(() => {
    let cancelled = false;
    void syncScriptDraftFromSupabase().then((merged) => {
      if (cancelled) return;
      if (scriptUserEditedRef.current) return;
      // Only apply if it actually differs from what we already have on
      // screen — avoids resetting the textarea (and the user's caret
      // position) when the cache and server agreed.
      setScriptText((prev) => (prev === merged.content ? prev : merged.content));
      // If the merged draft contains content we should treat the editor
      // as "initialized" — entering Script mode shouldn't auto-seed from
      // UI state and clobber the freshly-pulled server draft.
      if (merged.content.length > 0) {
        scriptInitialized.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── On-demand bar fetcher ────────────────────────────────────────
  // Branches on session granularity:
  //   - 'ohlcv' / 'ohlcv_bidask' → fetch replay_bars rows from the store
  //     (Supabase pages through the 1000-row PostgREST cap; local SQLite
  //     returns the full session in one query).
  //   - 'tick' / 'tick_bidask'   → download the gzipped CSV blob, parse
  //     to typed arrays (cached for the lifetime of the page so timeframe
  //     swaps re-aggregate from memory), and aggregate to ReplayBar[] at
  //     the active aggregationTimeframeSec.
  //
  // Skips work if a fresh cache entry already exists for this session at
  // the active timeframe. Errors surface via setFetchError so the user
  // sees the cause without the page crashing.
  const fetchBarsForSession = useCallback(
    async (sessionId: number) => {
      // Read via refs so this callback's identity stays stable. Reading
      // the state directly would force a new useCallback closure on every
      // bars/loading state change, cascading into spurious effect re-runs
      // and (worst case) the runResult memo re-running per intermediate
      // load step.
      if (loadingSessionIdsRef.current.has(sessionId)) return;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;

      const isTickSession =
        session.granularity === "tick" ||
        session.granularity === "tick_bidask";

      // Stale-cache check: for tick sessions we only short-circuit when
      // bars are cached AND the cached aggregation seconds match the
      // current timeframe. OHLCV sessions just need a cache hit.
      if (barsBySessionIdRef.current.has(sessionId)) {
        if (!isTickSession) return;
        const cachedSec = barAggregationSecondsRef.current.get(sessionId);
        if (cachedSec === aggregationTimeframeSecRef.current) return;
        // else fall through and re-aggregate at the new timeframe
      }

      setLoadingSessionIds((prev) => {
        const next = new Set(prev);
        next.add(sessionId);
        return next;
      });

      try {
        const store = getClientStore(backendMode);

        if (isTickSession) {
          // 1. Fetch + parse the blob (or reuse the cached typed arrays).
          let parsed = ticksBySessionIdRef.current.get(sessionId);
          if (!parsed) {
            if (!session.tick_blob_path) {
              throw new Error(
                `Tick session ${sessionId} has no tick_blob_path`
              );
            }
            const signedUrl = await store.replay.getTickBlobUrl(
              session.tick_blob_path,
              3600
            );
            parsed = await fetchAndParseTicks(signedUrl);
            ticksBySessionIdRef.current.set(sessionId, parsed);
          }

          // 2. Aggregate to bars at the active timeframe. Always reads
          // through the ref so a timeframe change between the fetch
          // start and finish picks up the user's latest choice.
          // We use the with-ranges variant so tick-driven indicators
          // (POC/VAH/VAL, vwap_tick, etc.) can map zone bars back to
          // their constituent ticks without re-walking the stream.
          const sec = aggregationTimeframeSecRef.current;
          const aggregated = aggregateTicksWithRanges(
            parsed,
            { kind: "time", seconds: sec },
            sessionId
          );
          barAggregationSecondsRef.current.set(sessionId, sec);
          tickRangesBySessionIdRef.current.set(sessionId, aggregated.tickRanges);

          setBarsBySessionId((prev) => {
            const next = new Map(prev);
            next.set(sessionId, aggregated.bars);
            return next;
          });
        } else {
          // OHLCV / ohlcv_bidask path — unchanged.
          const allBars = await store.replay.listBarsForSession(sessionId);
          setBarsBySessionId((prev) => {
            const next = new Map(prev);
            next.set(sessionId, allBars);
            return next;
          });
        }
      } catch (err) {
        setFetchError(
          err instanceof Error ? err.message : "Unknown error fetching bars"
        );
      } finally {
        setLoadingSessionIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }
    },
    // `sessions` is needed because the fetcher does a granularity lookup;
    // `backendMode` because the store impl differs between Cloud / Local.
    // aggregationTimeframeSec is read via ref so it isn't a dep — that
    // keeps the callback identity stable across timeframe swaps.
    [backendMode, sessions]
  );

  // Trigger fetches whenever the selection set grows. Already-loaded sessions
  // short-circuit inside fetchBarsForSession, so it's safe to fire blindly.
  useEffect(() => {
    for (const id of selectedSessionIds) {
      fetchBarsForSession(id);
    }
    // fetchBarsForSession depends on `sessions` so it remains stable
    // across renders that don't change the session library; we only
    // re-run when the selection or session library changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionIds]);

  // ─── Aggregation-timeframe change handler ───────────────────────
  // When the user picks a different timeframe, every selected tick
  // session whose cached bars were built at the OLD seconds value is
  // stale. We evict those entries from the bar cache + the
  // aggregation-seconds tracking ref, then re-trigger the fetcher —
  // which will hit the ParsedTicks cache and re-aggregate in ~50ms
  // (no network). OHLCV sessions are untouched since they aren't
  // timeframe-dependent on the dashboard side.
  //
  // CRITICAL: the staleness check + ref mutation MUST run synchronously
  // in the effect body, NOT inside a setState updater closure. The
  // updater is invoked later (during the render commit), so any flag
  // mutated inside it is still false when we'd check it after the
  // setState call returns — which would silently skip the re-fetch and
  // leave the bar cache empty. Compute the stale list up front, then
  // apply the eviction + fetch.
  useEffect(() => {
    const stale: number[] = [];
    for (const id of selectedSessionIds) {
      const session = sessions.find((s) => s.id === id);
      if (!session) continue;
      const isTick =
        session.granularity === "tick" ||
        session.granularity === "tick_bidask";
      if (!isTick) continue;
      const cachedSec = barAggregationSecondsRef.current.get(id);
      if (cachedSec === aggregationTimeframeSec) continue;
      stale.push(id);
    }
    if (stale.length === 0) return;

    // Synchronously drop the stale aggregation-seconds entries. The
    // fetcher reads this ref on its next call to decide whether to
    // re-aggregate — keeping it consistent with the bar-cache eviction
    // below avoids a fetch short-circuiting on stale tracking data.
    for (const id of stale) {
      barAggregationSecondsRef.current.delete(id);
      // Tick ranges are aggregation-bound (their indices align to the
      // bars at this timeframe); evict them too so the fetcher rebuilds
      // both arrays together at the new timeframe.
      tickRangesBySessionIdRef.current.delete(id);
    }

    // Evict the stale bar entries via setState. Even though the
    // updater runs later, the fetcher's bar-cache check tolerates the
    // transient (it falls through to re-aggregate when cachedSec
    // doesn't match), so we can fire the re-fetch right away.
    setBarsBySessionId((prev) => {
      const next = new Map(prev);
      for (const id of stale) next.delete(id);
      return next;
    });

    for (const id of stale) {
      fetchBarsForSession(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregationTimeframeSec]);

  // Toggle one session in/out of the selection
  const toggleSession = (id: number) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bulk select / clear helpers — convenient for "all of last week" type runs.
  // Select All operates on the *filtered* set so users can use filters as a
  // scoping tool ("all ES 5-Min sessions") without having to chip through
  // each one. It's additive: existing selections survive so combining
  // filters works ("select all ES, then switch to NQ and add those too").
  const selectAll = () =>
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      for (const s of filteredSessions) next.add(s.id);
      return next;
    });
  const clearAll = () => setSelectedSessionIds(new Set());

  // ─── Random sampler ──────────────────────────────────────────────
  // Picks `count` distinct sessions uniformly at random and REPLACES the
  // current selection. Useful for cross-validation style backtests where
  // you want to see how a strategy holds up on a random subset of days.
  // Caller passes a raw count (or a percentage helper computes it) so the
  // user can always know exactly how many days they're sampling.
  // Uses Fisher-Yates partial shuffle to avoid O(n²) rejection sampling
  // when count is close to sessions.length.
  const pickRandom = useCallback(
    (count: number) => {
      // Sample from the filtered set so users can scope ("random 10 of my
      // ES 1-Min days"). With no filters active, this is identical to
      // sampling from the full session list.
      if (filteredSessions.length === 0) return;
      const n = Math.max(0, Math.min(count, filteredSessions.length));
      if (n === 0) {
        setSelectedSessionIds(new Set());
        return;
      }
      const ids = filteredSessions.map((s) => s.id);
      // Partial Fisher-Yates: only shuffle the first n positions, since
      // those are the ones we keep. Each iteration swaps the i-th slot
      // with a random slot at or after i.
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(Math.random() * (ids.length - i));
        const tmp = ids[i];
        ids[i] = ids[j];
        ids[j] = tmp;
      }
      setSelectedSessionIds(new Set(ids.slice(0, n)));
    },
    [filteredSessions]
  );

  // Number-input value for the "exact N" picker. Clamped against
  // sessions.length when the user clicks Pick. Default starts at a
  // reasonable mid value so the input has something sensible visible.
  const [randomCount, setRandomCount] = useState<number>(10);

  // ─── Walk-forward window state ────────────────────────────────────
  // Walk-forward analysis: take a contiguous chronological slice of
  // length `walkForwardWindow`, run the backtest, then slide the slice
  // forward by `walkForwardStep` and run again. The user re-rolls by
  // hitting Next; the dashboard's existing memos re-run automatically
  // each time the selection changes. Defaults match the user's stated
  // ask ("first N days, then switch to the next 10" → window 10, step 10).
  const [walkForwardWindow, setWalkForwardWindow] = useState<number>(10);
  const [walkForwardStep, setWalkForwardStep] = useState<number>(10);
  // Index into the chronologically-sorted session list. 0 = oldest day
  // is the first day of the window.
  const [walkForwardStart, setWalkForwardStart] = useState<number>(0);

  // Sessions sorted by session_date ASC so walk-forward steps from the
  // oldest day toward the newest. Built from the *filtered* set so
  // walk-forward respects active instrument/timeframe filters — e.g.
  // filtering to ES 5-Min lets you walk forward through just that
  // subset instead of the whole library. The day-picker chip grid
  // still uses the original `sessions` prop ordering (most-recent-first
  // by convention) — only walk-forward consumes the chronological view.
  const sessionsChrono = useMemo(
    () =>
      [...filteredSessions].sort((a, b) =>
        a.session_date < b.session_date
          ? -1
          : a.session_date > b.session_date
            ? 1
            : 0
      ),
    [filteredSessions]
  );

  /** Apply a walk-forward window starting at `start` (chronological index).
   *  REPLACES the current selection — same convention as the random picker
   *  and the bulk Select All / Clear buttons, since walk-forward is
   *  meant to be the active selection, not additive. Clamps `start` so
   *  the window never runs past the end of the dataset. */
  const applyWalkForwardWindow = useCallback(
    (start: number) => {
      if (sessionsChrono.length === 0) return;
      const winSize = Math.max(1, walkForwardWindow);
      const maxStart = Math.max(0, sessionsChrono.length - winSize);
      const clamped = Math.max(0, Math.min(start, maxStart));
      const slice = sessionsChrono.slice(clamped, clamped + winSize);
      setWalkForwardStart(clamped);
      setSelectedSessionIds(new Set(slice.map((s) => s.id)));
    },
    [sessionsChrono, walkForwardWindow]
  );

  // Convenience derived values for the walk-forward UI.
  const wfWindowEnd = Math.min(
    sessionsChrono.length,
    walkForwardStart + Math.max(1, walkForwardWindow)
  );
  const canWfPrev = walkForwardStart > 0;
  const canWfNext =
    sessionsChrono.length > 0 &&
    walkForwardStart + Math.max(1, walkForwardWindow) < sessionsChrono.length;

  // When the user changes instrument/timeframe filters the chronological
  // index space changes underneath us — reset to the start so the
  // position indicator and Prev/Next buttons stay coherent. This does
  // NOT auto-apply a window; it just rewinds the cursor so the next
  // Start/Next click begins from day 1 of the new filtered set.
  useEffect(() => {
    setWalkForwardStart(0);
    // instrumentFilter is a Set — useEffect identity-compares, and we
    // always create a new Set on mutation, so this fires correctly on
    // any change to the filter contents.
  }, [instrumentFilter, timeframeFilter]);

  // ─── Backtest run (memoized + per-session cached) ─────────────────
  // The dashboard re-runs the memo whenever any of: the selection set, the
  // strategy/params/rules, or the bars-by-session map changes. The bars
  // map changes once per fetch completion, so naively this would call
  // `runBacktestForSession` once per loaded session × per memo run —
  // O(N²) total work as the user loads N sessions. With manual
  // click-by-click selection that explodes into noticeable lag and
  // eventually a tab crash.
  //
  // Fix: keep a per-session cache keyed by sessionId + a stringified
  // bundle of strategy/params/rules. The expensive call
  // `runBacktestForSession` runs at most ONCE per (session, config). On
  // subsequent memo runs (e.g. when the next session's bars arrive),
  // already-loaded sessions just hit the cache and we only compute the
  // newcomer. Total work to load N sessions → O(N), not O(N²).
  //
  // Cache invalidation: per-entry. When configKey changes for a session
  // (because the user tweaked params), that one entry gets recomputed
  // and overwritten on next access. Stale entries from past configs
  // stick around until their session is re-selected, but each session
  // only ever holds one entry, so total cache size is bounded by the
  // number of sessions ever selected.
  //
  // Zone-id stability: `runBacktestForSession` takes an `idOffset` so
  // generated zone IDs don't collide across sessions. We use sessionId
  // × 1e6 as the offset — gives every session its own 1M-zone ID range,
  // way more than any realistic strategy emits, and avoids the
  // sequential-running-counter that the old `runBacktestAcrossSessions`
  // path had to recompute on every memo run.
  // Cache keyed by sessionId. Stores both the configKey AND the bars
  // reference, because bars can change without the config changing —
  // e.g. when the tick-aggregation timeframe is swapped, aggregateTicks
  // produces a fresh ReplayBar[] array but strategy/params/rules stay
  // put, so a configKey-only check would silently return last run's
  // result and the user would see identical P&L across timeframes.
  const backtestCacheRef = useRef(
    new Map<
      number,
      { configKey: string; bars: ReplayBar[]; result: BacktestRunResult }
    >()
  );

  const runResult = useMemo(() => {
    const ready = Array.from(selectedSessionIds)
      .map((id) => {
        const sess = sessions.find((s) => s.id === id);
        const bars = barsBySessionId.get(id);
        if (!sess || !bars) return null;
        return { id, instrument: sess.instrument, bars };
      })
      .filter(
        (x): x is { id: number; instrument: string; bars: ReplayBar[] } => x !== null
      );

    if (ready.length === 0) {
      return {
        trades: [],
        syntheticZones: [],
        syntheticBarsByZoneId: new Map<number, TradeZoneBar[]>(),
        syntheticPreEntryBarsByZoneId: new Map<number, TradeZoneBar[]>(),
        syntheticAtrByZoneId: new Map<number, number>(),
        syntheticTickCtxByZoneId: new Map<number, TickContext>(),
        totalSignals: 0,
      };
    }

    // ── Strategy DSL override ───────────────────────────────────────
    // When the applied script declares `signal.long.if = …` /
    // `signal.short.if = …` statements, parse them out and pass to the
    // engine via `strategyOverride`. The engine then bypasses
    // `currentStrategy.generateSignals()` and runs the new per-bar
    // evaluator on the user's DSL. `let` bindings travel with the
    // signal stmts so they're in scope during evaluation. Inferred
    // params.X values come from `scriptParams` (sidebar inputs); we
    // overlay them on top of the dropdown's `params` so users can mix
    // both conventions during transition.
    let strategyOverrideForRun: {
      stmts: StrategyStmt[];
      paramOverrides: Record<string, number>;
    } | null = null;
    let strategyOverrideKey: string | null = null;
    if (appliedScriptText) {
      const parsedStrategy = parseStrategyScript(appliedScriptText);
      const hasSignals = parsedStrategy.stmts.some((s) => s.kind === "signal");
      if (hasSignals && parsedStrategy.errors.every((e) => e.severity !== "error")) {
        // Keep `let` bindings (referenced by signal expressions) and
        // the signal stmts themselves. Drop generic `assign` stmts —
        // those route through the existing line-based DSL machinery
        // (rules.X = …, filters.X = …) and shouldn't double-apply.
        const stmts = parsedStrategy.stmts.filter(
          (s) => s.kind === "let" || s.kind === "signal"
        );
        const paramOverrides: Record<string, number> = { ...params };
        for (const ref of parsedStrategy.paramRefs) {
          const key = ref.replace(/^params\./, "");
          // Resolution order:
          //   1. Explicit user value from the inferred-params sidebar
          //   2. Template-supplied default (preset paramMeta)
          //   3. Dropdown-strategy value (`params`) — present for keys
          //      shared with the active legacy strategy
          //   4. Cross-template default — search all builtin templates
          //      for a paramMeta entry with this key. Lets a freshly-
          //      opened disk .dsl that uses common params (lookback,
          //      atrPeriod, …) get sensible defaults without forcing
          //      the user to type each one.
          //   5. Fallback to 0 — better than `undefined`, which would
          //      resolve to NaN in the evaluator and silently kill every
          //      signal that touches the param.
          if (Object.prototype.hasOwnProperty.call(scriptParams, key)) {
            paramOverrides[key] = scriptParams[key];
          } else if (scriptParamMeta[key]?.default !== undefined) {
            paramOverrides[key] = scriptParamMeta[key]!.default!;
          } else if (paramOverrides[key] === undefined) {
            let defaulted = 0;
            for (const t of BUILTIN_STRATEGY_TEMPLATES) {
              const m = t.paramMeta[key];
              if (m?.default !== undefined) {
                defaulted = m.default;
                break;
              }
            }
            paramOverrides[key] = defaulted;
          }
        }
        strategyOverrideForRun = { stmts, paramOverrides };
        // Cache key — sources are stable across parses since
        // parseStrategyScript is deterministic on a given text.
        strategyOverrideKey = JSON.stringify({
          sources: stmts.map((s) =>
            s.kind === "signal"
              ? `sig.${s.side}:${s.source}`
              : `let.${s.name}:${s.source}`
          ),
          paramOverrides,
        });
      }
    }

    // ── Script v2 + v3 overlay (built once per memo run) ───────────
    // Compiled expressions live on numericOverrides / tradePrints;
    // their `expr` AST objects don't survive JSON.stringify cleanly, so
    // we serialize via the user-typed `source` strings for the cache
    // key and pass the live AST objects to the engine. v3 adds Optimize
    // directive specs + the OptimizeAll flag — when present the engine
    // routes through the online TPE optimizer instead of the flat
    // simulator. When no script overrides are active, overlayForRun
    // stays null and the engine falls into its byte-identical legacy
    // path. Seed is derived from script text + selected sessions so
    // re-runs on the same data produce identical optimization traces.
    const hasOptimize =
      scriptOptimizeOverrides && Object.keys(scriptOptimizeOverrides).length > 0;
    const hasFilterIfs = scriptFilterIfs.length > 0;
    const overlayForRun: import("@/lib/utils/zone-simulator").ScriptOverlay | null =
      scriptNumericOverrides ||
      scriptTradePrints.length > 0 ||
      hasOptimize ||
      hasFilterIfs
        ? {
            numericOverrides: scriptNumericOverrides ?? undefined,
            tradePrints: scriptTradePrints.map((p) => ({
              label: p.label,
              expr: p.expr,
            })),
            optimizeOverrides: scriptOptimizeOverrides ?? undefined,
            optimizeAll: scriptOptimizeAll,
            warmup: scriptWarmup,
            filterIfs: hasFilterIfs ? scriptFilterIfs : undefined,
            // Seed: stable hash of the script text + sorted session IDs.
            // Computed inline so the memo's cache key sees consistent
            // values; the engine uses this directly via the overlay.
            optimizeSeed: hasOptimize
              ? deriveSeed(appliedScriptText, Array.from(selectedSessionIds))
              : undefined,
          }
        : null;

    // Single string that uniquely identifies "the current backtest
    // configuration" so we can detect cache invalidation per-session.
    // Cheap: params / rules are flat numeric structs; strategy id is a
    // short string. JSON.stringify is plenty fast at this scope.
    const configKey = JSON.stringify({
      strategyId: currentStrategy.id,
      params,
      rules,
      // Strategy DSL override invalidates cache when its sources or
      // inferred-param overrides change.
      strategyOverride: strategyOverrideKey,
      // indicatorConfig affects the ctx_* fields stamped onto synthetic
      // zones, so it has to invalidate the cache the same way params /
      // rules do. Otherwise a user who changes adxPeriod from 14→20
      // would still see ADX(14) values driving their filter results.
      indicatorConfig,
      // Script overlay: include the user-typed expression sources +
      // labels so cache invalidates whenever the user changes a script
      // expression. We don't serialize the AST itself — `source` is the
      // canonical key and re-parses to the same AST.
      scriptOverlay: overlayForRun
        ? {
            overrides: scriptNumericOverrides
              ? Object.fromEntries(
                  Object.entries(scriptNumericOverrides).map(([k, v]) => [
                    k,
                    v.kind === "expr"
                      ? `expr:${v.source}`
                      : v.kind === "optimize"
                        ? `opt:${v.source}`
                        : `lit:${v.value}`,
                  ])
                )
              : null,
            tradePrints: scriptTradePrints.map((p) => ({
              label: p.label,
              source: p.source,
            })),
            // Optimize overrides — keyed by path + source string. The
            // seed is also part of the key so changing the script text
            // (which affects the seed) invalidates the cache too.
            optimize: scriptOptimizeOverrides
              ? Object.fromEntries(
                  Object.entries(scriptOptimizeOverrides).map(([k, spec]) => [
                    k,
                    `${spec.objective}|${spec.lookbackUnit}|${spec.lookback}`,
                  ])
                )
              : null,
            optimizeAll: scriptOptimizeAll,
            warmup: scriptWarmup,
            optimizeSeed: overlayForRun?.optimizeSeed ?? null,
            // filter.if directives — the verbatim RHS source captures
            // every byte of the AST (cond + branch statements). Prefix
            // with scope so `filter.long.if = X` and `filter.short.if = X`
            // get distinct cache keys despite sharing RHS text.
            filterIfs: scriptFilterIfs.map((d) => `${d.scope ?? "both"}|${d.source}`),
          }
        : null,
    });

    const allTrades: SimZoneResult[] = [];
    const allZones: TradeZone[] = [];
    const allBars = new Map<number, TradeZoneBar[]>();
    const allPreEntryBars = new Map<number, TradeZoneBar[]>();
    const allAtr = new Map<number, number>();
    const allTickCtx = new Map<number, TickContext>();
    let totalSignals = 0;
    // Script v3: aggregate optimization history across sessions. Each
    // session has its own per-zone walk, so each session contributes
    // its own warmup + post-warmup history. We concatenate per path —
    // good enough for v1 since the typical user runs a single session
    // window. Cross-session joint optimization is a v1.1 follow-up.
    const allOptimizationHistory: Record<
      string,
      Array<{ tradeIndex: number; value: number; objective: number; trialsRun: number }>
    > = {};
    const allOptimizationWarnings: string[] = [];

    const cache = backtestCacheRef.current;
    for (const s of ready) {
      const cached = cache.get(s.id);
      let result: BacktestRunResult;
      // Both the config AND the bars reference must match to reuse a
      // cached result. The bars-identity check catches tick-aggregation
      // timeframe swaps, which change the bar set without touching any
      // config field.
      if (cached && cached.configKey === configKey && cached.bars === s.bars) {
        result = cached.result;
      } else {
        // Tick-resolution data — present only for sessions sourced from
        // a tick blob. When absent (plain OHLCV / ohlcv_bidask), the
        // engine falls back to bar-level indicators only and tick-
        // driven indicator calls in the DSL evaluate to NaN.
        const sessionTicks = ticksBySessionIdRef.current.get(s.id) ?? null;
        const sessionTickRanges =
          tickRangesBySessionIdRef.current.get(s.id) ?? null;
        result = runBacktestForSession({
          bars: s.bars,
          instrument: s.instrument,
          strategy: currentStrategy,
          params,
          rules,
          // Per-session deterministic offset → cache-stable zone IDs
          // (re-running the same session yields the same IDs every time).
          idOffset: s.id * 1_000_000,
          indicatorConfig,
          scriptOverlay: overlayForRun,
          strategyOverride: strategyOverrideForRun,
          sessionTicks,
          sessionTickRanges,
        });
        cache.set(s.id, { configKey, bars: s.bars, result });
      }

      allTrades.push(...result.trades);
      allZones.push(...result.syntheticZones);
      for (const [k, v] of result.syntheticBarsByZoneId) allBars.set(k, v);
      for (const [k, v] of result.syntheticPreEntryBarsByZoneId)
        allPreEntryBars.set(k, v);
      for (const [k, v] of result.syntheticAtrByZoneId) allAtr.set(k, v);
      for (const [k, v] of result.syntheticTickCtxByZoneId) allTickCtx.set(k, v);
      totalSignals += result.totalSignals;
      // Append per-path optimization history. Trade indices are
      // SESSION-LOCAL — they reset at each session boundary. The
      // Output panel renders these as a sparkline so absolute indices
      // matter less than the trajectory shape.
      if (result.optimizationHistory) {
        for (const [path, records] of Object.entries(result.optimizationHistory)) {
          if (!allOptimizationHistory[path]) allOptimizationHistory[path] = [];
          allOptimizationHistory[path].push(...records);
        }
      }
      if (result.optimizationWarnings) {
        allOptimizationWarnings.push(...result.optimizationWarnings);
      }
    }

    // Same chronological sort runBacktestAcrossSessions used to apply
    // — keeps the equity curve / per-day chart in time order across
    // the multi-session concatenation.
    allTrades.sort((a, b) =>
      a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
    );

    // Cross-session dedupe by logical-trade key — both ZONES and TRADES.
    // When the user selects multiple replay_sessions whose bar windows
    // overlap (e.g. session 122 spans 2026-04-05 → 2026-04-08, fully
    // overlapping session 123 for 2026-04-08), each session fires
    // signal_v2 independently on the shared bars and we get two synthetic
    // zones with different zoneIds for the same logical trade.
    //
    // Why both lists: the dashboard's `trades` memo re-runs
    // simulateAllZones on the FILTERED zones whenever a filter is active,
    // so scaling/dailyLimits run again on whatever zones we hand them. If
    // the zones list still has overlap-twins, the second simulateAllZones
    // call's scaling pass sees both copies of every prior winner and the
    // running size jumps 2x (e.g. 1→3 instead of 1→2 after a single win).
    // That bug surfaced as scaled-up qty values across the diff. Dedupe
    // zones here so every downstream consumer sees one zone per logical
    // trade — and dedupe trades to the same key so the no-filter
    // short-circuit (`return runResult.trades`) is also clean.
    const allZonesById = new Map<number, TradeZone>();
    for (const z of allZones) allZonesById.set(z.id, z);
    const tradeKeyForResult = (r: SimZoneResult): string => {
      const z = allZonesById.get(r.zoneId);
      const startPrice = z ? z.start_price : 0;
      return `${r.startTime}|${r.direction}|${r.instrument}|${startPrice}`;
    };
    const zoneKey = (z: TradeZone): string =>
      `${z.start_time}|${z.direction}|${z.instrument}|${z.start_price}`;

    const seenZoneKey = new Set<string>();
    const dedupedZones: TradeZone[] = [];
    for (const z of allZones) {
      const k = zoneKey(z);
      if (seenZoneKey.has(k)) continue;
      seenZoneKey.add(k);
      dedupedZones.push(z);
    }

    const seenTradeKey = new Set<string>();
    const dedupedTrades: SimZoneResult[] = [];
    for (const t of allTrades) {
      const k = tradeKeyForResult(t);
      if (seenTradeKey.has(k)) continue;
      seenTradeKey.add(k);
      dedupedTrades.push(t);
    }
    const totalDropped =
      allTrades.length - dedupedTrades.length + (allZones.length - dedupedZones.length);
    if (totalDropped > 0) {
      console.warn(
        `[backtest-dashboard] cross-session dedupe dropped ${
          allTrades.length - dedupedTrades.length
        } trade(s) and ${
          allZones.length - dedupedZones.length
        } zone(s) — overlapping replay_sessions detected. Pick one session per date or fix any session whose start/end_time spans multiple days.`
      );
    }

    // ── Script v3: optimizer runs DOWNSTREAM in the trades memo, not
    //    here. The trades memo gets the filtered zone set
    //    (timeFilteredZones), which is what the user actually sees in
    //    the table — so optimization history matches displayed trades
    //    1-to-1. Running the optimizer here on the unfiltered zones
    //    would inflate the history (every fired signal contributes a
    //    history entry, even those a context/time filter later drops),
    //    which is what produced the "424 updates / 79 trades"
    //    discrepancy. We pass the per-session aggregated history along
    //    only as a fallback for the no-Optimize case (legacy path).
    return {
      trades: dedupedTrades,
      syntheticZones: dedupedZones,
      syntheticBarsByZoneId: allBars,
      syntheticPreEntryBarsByZoneId: allPreEntryBars,
      syntheticAtrByZoneId: allAtr,
      syntheticTickCtxByZoneId: allTickCtx,
      totalSignals,
      optimizationHistory:
        Object.keys(allOptimizationHistory).length > 0
          ? allOptimizationHistory
          : undefined,
      optimizationWarnings:
        allOptimizationWarnings.length > 0 ? allOptimizationWarnings : undefined,
    };
  }, [selectedSessionIds, sessions, barsBySessionId, currentStrategy, params, rules, indicatorConfig, scriptNumericOverrides, scriptTradePrints, scriptOptimizeOverrides, scriptOptimizeAll, scriptWarmup, scriptFilterIfs, appliedScriptText, scriptParams, scriptParamMeta]);

  // ─── Apply context filters (ADX / ATR / Trend / Bollinger) ────────
  // Runs BEFORE the time filter so the chain is:
  //   syntheticZones → context → time → simulator/optimizers
  // Mirrors the risk simulator's filter ordering. All four sub-filters
  // AND together; zones with NULL on a relevant ctx_* field are dropped
  // when that filter is on. Returns the input reference when no filter
  // is active so downstream useMemos stay stable.
  const contextFilteredZones = useMemo(() => {
    const noneActive =
      !adxFilterEnabled &&
      !atrFilterEnabled &&
      !trendFilterEnabled &&
      !bollingerFilterEnabled &&
      !bbWidthFilterEnabled &&
      !maDistanceFilterEnabled &&
      !volumeFilterEnabled &&
      !rsiFilterEnabled &&
      !(adxTrendFilterEnabled && adxTrendMode !== "any") &&
      !deltaFilterEnabled;
    if (noneActive) return runResult.syntheticZones;
    return runResult.syntheticZones.filter((z) => {
      if (adxFilterEnabled) {
        if (z.ctx_adx14 == null) return false;
        if (z.ctx_adx14 < adxMin || z.ctx_adx14 > adxMax) return false;
      }
      if (atrFilterEnabled) {
        if (z.ctx_atr14 == null) return false;
        if (z.ctx_atr14 < atrMin || z.ctx_atr14 > atrMax) return false;
      }
      if (trendFilterEnabled) {
        const isLong = z.direction === "Long";
        if (ema20Mode !== "any") {
          if (z.ctx_price_vs_ema20 == null) return false;
          const isWith =
            (isLong && z.ctx_price_vs_ema20 === "above") ||
            (!isLong && z.ctx_price_vs_ema20 === "below");
          if (ema20Mode === "with" && !isWith) return false;
          if (ema20Mode === "against" && isWith) return false;
        }
        if (ema200Mode !== "any") {
          if (z.ctx_price_vs_ema200 == null) return false;
          const isWith =
            (isLong && z.ctx_price_vs_ema200 === "above") ||
            (!isLong && z.ctx_price_vs_ema200 === "below");
          if (ema200Mode === "with" && !isWith) return false;
          if (ema200Mode === "against" && isWith) return false;
        }
      }
      if (bollingerFilterEnabled) {
        if (z.ctx_bollinger_pos == null) return false;
        if (!bollingerAllowed.has(z.ctx_bollinger_pos)) return false;
      }
      // BB band width — drop entries whose BB width at entry is
      // outside [min, max] in price points. Null bw (warmup) drops.
      if (bbWidthFilterEnabled) {
        const bw = z.ctx_bollinger_bw;
        if (bw == null) return false;
        if (bw < bbWidthMin || bw > bbWidthMax) return false;
      }
      // Distance from configurable MA in ATR units. Three modes —
      // see PresetFilters.MaDistanceMode docs.
      if (maDistanceFilterEnabled) {
        const d = z.ctx_ma_distance_atr ?? null;
        if (d == null) return false;
        if (maDistanceMode === "absolute") {
          const ad = Math.abs(d);
          if (ad < maDistanceMin || ad > maDistanceMax) return false;
        } else if (maDistanceMode === "above") {
          if (d < 0) return false;
          if (d < maDistanceMin || d > maDistanceMax) return false;
        } else {
          // "below"
          if (d > 0) return false;
          const ad = Math.abs(d);
          if (ad < maDistanceMin || ad > maDistanceMax) return false;
        }
      }
      // Volume ratio — current bar volume / N-bar avg.
      if (volumeFilterEnabled) {
        const r = z.ctx_volume_ratio ?? null;
        if (r == null) return false;
        if (r < volumeMinRatio || r > volumeMaxRatio) return false;
      }
      // RSI — Wilder smoothed in [min, max].
      if (rsiFilterEnabled) {
        const v = z.ctx_rsi ?? null;
        if (v == null) return false;
        if (v < rsiMin || v > rsiMax) return false;
      }
      // ADX direction — gate on the sign of ctx_adx_slope.
      if (adxTrendFilterEnabled && adxTrendMode !== "any") {
        const slope = z.ctx_adx_slope ?? null;
        if (slope == null) return false;
        const thresh = Math.abs(adxTrendFlatThreshold);
        if (adxTrendMode === "rising") {
          if (slope <= thresh) return false;
        } else if (adxTrendMode === "falling") {
          if (slope >= -thresh) return false;
        } else if (adxTrendMode === "flat") {
          if (Math.abs(slope) > thresh) return false;
        }
      }
      // Bid/ask delta imbalance — only meaningful for sessions whose
      // source bars carry a bid/ask split. ctx_delta_ratio is null on
      // plain ohlcv bars, which fail-closes (rejects every trade) when
      // this filter is on — the same null-as-fail discipline the other
      // indicator filters use.
      if (deltaFilterEnabled) {
        const d = z.ctx_delta_ratio ?? null;
        if (d == null) return false;
        if (d < deltaMin || d > deltaMax) return false;
      }
      return true;
    });
  }, [
    runResult.syntheticZones,
    adxFilterEnabled,
    adxMin,
    adxMax,
    atrFilterEnabled,
    atrMin,
    atrMax,
    trendFilterEnabled,
    ema20Mode,
    ema200Mode,
    bollingerFilterEnabled,
    bollingerAllowed,
    bbWidthFilterEnabled,
    bbWidthMin,
    bbWidthMax,
    maDistanceFilterEnabled,
    maDistanceMode,
    maDistanceMin,
    maDistanceMax,
    volumeFilterEnabled,
    volumeMinRatio,
    volumeMaxRatio,
    rsiFilterEnabled,
    rsiMin,
    rsiMax,
    adxTrendFilterEnabled,
    adxTrendMode,
    adxTrendFlatThreshold,
    deltaFilterEnabled,
    deltaMin,
    deltaMax,
  ]);

  // ─── Apply time-of-day filter to context-filtered synthetic zones ──
  // Filter operates on the synthetic-zone level so all consumers below
  // (simulator results, equity curve, stat cards, optimizers) see the
  // narrowed set without each having to know about the time window.
  // Returns the input array reference when the filter is off so React
  // memos don't invalidate unnecessarily.
  const timeFilteredZones = useMemo(() => {
    if (!timeFilterEnabled || timeWindows.length === 0) return contextFilteredZones;
    const parseTime = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    // Pre-parse every window once so the per-zone loop is just a tight
    // OR over fixed-min ranges. Wrap-around windows (from > to) keep
    // the same semantics as the legacy single-window filter.
    const parsed = timeWindows.map((w) => ({
      from: parseTime(w.from),
      to: parseTime(w.to),
    }));
    return contextFilteredZones.filter((z) => {
      const { hour, minute } = parseRawTimestamp(z.start_time);
      const zm = hour * 60 + minute;
      for (const w of parsed) {
        if (w.from <= w.to) {
          if (zm >= w.from && zm <= w.to) return true;
        } else {
          if (zm >= w.from || zm <= w.to) return true;
        }
      }
      return false;
    });
  }, [contextFilteredZones, timeFilterEnabled, timeWindows]);

  // Re-simulate when ANY filter is active (context or time). When all
  // filters are off, `timeFilteredZones === runResult.syntheticZones`
  // by reference identity — that lets us short-circuit and reuse the
  // backtest engine's already-computed trades. ATR map is plumbed
  // through so the SL/TP/Trail/BE ± ATR adjustment fields take effect
  // here too — without it the re-simulation would silently ignore the
  // adjustments while the initial backtest result honored them.
  //
  // Script v2 overlay is also threaded through — without it, any active
  // filter would silently bypass `rules.*` expression overrides
  // (resolveRulesForTrade only fires when an overlay is present). The
  // indicator cache is precomputed here on the filtered zones so
  // expressions like `rules.slAtrAdjust = ATR(14)/2` keep working
  // post-filter, not just on the unfiltered first pass.
  // ── Trades + (optionally) optimization history, computed AFTER all
  //    filters. Single combined memo so trades and optimization
  //    history are produced from the SAME zone set — eliminates the
  //    "424 updates / 79 trades" mismatch where the optimizer used to
  //    run on unfiltered zones while the chart used the filtered set.
  //
  //    Two paths inside:
  //      1. No script overlay AND no filter → return runResult.trades
  //         as-is (legacy fast path, byte-identical to pre-script).
  //      2. Filter active OR script overlay active → re-run the
  //         simulator (or online optimizer) on the FILTERED zone set
  //         (`timeFilteredZones`), which is exactly the set the chart
  //         renders.
  const tradesAndOptimization = useMemo<{
    trades: SimZoneResult[];
    optimizationHistory?: NonNullable<BacktestRunResult["optimizationHistory"]>;
    optimizationWarnings?: string[];
    /** Per-run funnel metrics — populated by simulateAllZones (or the
     *  async optimizer's cached result). Used by the post-run summary
     *  export to write the disk snapshot Claude Code reads. Empty when
     *  the fast path returned (no filters, no overlay) — the summary
     *  builder treats that as "0 rejections, all signals became trades." */
    metrics?: import("@/lib/utils/zone-simulator").SimulateMetrics;
  }>(() => {
    const hasOpt =
      scriptOptimizeOverrides && Object.keys(scriptOptimizeOverrides).length > 0;
    const hasFilterIfsHere = scriptFilterIfs.length > 0;
    const noFilter = timeFilteredZones === runResult.syntheticZones;
    // Fast path: no overlay, no filter. Return runResult straight
    // through — preserves the byte-identical legacy behavior.
    if (
      noFilter &&
      !scriptNumericOverrides &&
      scriptTradePrints.length === 0 &&
      !hasOpt &&
      !hasFilterIfsHere
    ) {
      return {
        trades: runResult.trades,
        optimizationHistory: runResult.optimizationHistory,
        optimizationWarnings: runResult.optimizationWarnings,
        // No filters were applied, so the funnel is trivially "considered
        // == accepted, zero rejections." Surface that explicitly so the
        // summary builder doesn't have to special-case the fast path.
        metrics: {
          zonesConsidered: runResult.syntheticZones.length,
          filterRejections: new Map(),
        },
      };
    }

    // Build the overlay shape the simulator/optimizer reads.
    let overlayForFilterSim: import("@/lib/utils/zone-simulator").ScriptOverlay | null =
      scriptNumericOverrides ||
      scriptTradePrints.length > 0 ||
      hasOpt ||
      hasFilterIfsHere
        ? {
            numericOverrides: scriptNumericOverrides ?? undefined,
            tradePrints: scriptTradePrints.map((p) => ({
              label: p.label,
              expr: p.expr,
            })),
            optimizeOverrides: scriptOptimizeOverrides ?? undefined,
            optimizeAll: scriptOptimizeAll,
            warmup: scriptWarmup,
            filterIfs: hasFilterIfsHere ? scriptFilterIfs : undefined,
          }
        : null;

    // Inline strategy-DSL `let` bindings into this overlay's expressions
    // — same substitution `runBacktestForSession` does on its own
    // overlay. Without it, names like `bar_delta_ratio` (from a strategy
    // `let`) resolve to NaN in the entry-context evaluator, and the
    // filter-sim simulator emits NaN for every print/filter.if/rule
    // expression that references a let. The two paths must stay in
    // sync; if you add a let-substitution call in one, add it in the
    // other.
    if (overlayForFilterSim && appliedScriptText) {
      const letBindings = buildLetBindings(parseStrategyScript(appliedScriptText).stmts);
      if (letBindings.size > 0) {
        overlayForFilterSim = applyBindingsToOverlay(overlayForFilterSim, letBindings);
      }
    }

    // Precompute indicator series for the filtered zones whenever the
    // overlay has expressions. Cheap because the exprs list is usually
    // tiny (a handful of rule expressions + tradePrints + filter.if
    // condition + assignment RHS exprs).
    if (
      overlayForFilterSim &&
      (overlayForFilterSim.numericOverrides ||
        overlayForFilterSim.tradePrints ||
        (overlayForFilterSim.filterIfs && overlayForFilterSim.filterIfs.length > 0))
    ) {
      // Pre-entry bars are required for indicator warmup at bar_index 0
      // — see precomputeIndicators in script-expr.ts. Without them
      // ATR/EMA/ADX evaluated at the entry bar are NaN. The pre-entry
      // window itself is auto-sized by runBacktestForSession based on
      // the overlay's max indicator period, so EMA(200) etc. are warmed
      // up by the time we reach this precompute.
      overlayForFilterSim = {
        ...overlayForFilterSim,
        indicatorByZone: precomputeIndicators(
          timeFilteredZones,
          runResult.syntheticBarsByZoneId,
          collectOverlayExprs(overlayForFilterSim),
          runResult.syntheticPreEntryBarsByZoneId,
          runResult.syntheticTickCtxByZoneId.size > 0
            ? runResult.syntheticTickCtxByZoneId
            : undefined,
        ),
      };
    }

    // Optimization path — the optimizer is now async/yieldable so this
    // branch READS from `asyncOptResult` instead of computing inline.
    // The companion useEffect below (`async optimizer runner`) owns the
    // compute: it awaits a yield hook between every signal so the
    // browser can paint the progress bar and the page never trips the
    // "unresponsive" dialog on big runs. While a fresh run is in flight
    // we still serve the LAST result so filter toggles don't flicker
    // the chart to empty — when the new result lands, the memo re-runs
    // and downstream consumers swap to it. When inputs differ AND
    // there's no prior result, we return empty trades and let the
    // progress bar carry the UX.
    if (
      overlayForFilterSim?.optimizeOverrides &&
      Object.keys(overlayForFilterSim.optimizeOverrides).length > 0
    ) {
      if (asyncOptResult) {
        return {
          trades: asyncOptResult.trades,
          optimizationHistory: asyncOptResult.optimizationHistory,
          optimizationWarnings: asyncOptResult.optimizationWarnings,
          metrics: asyncOptResult.metrics,
        };
      }
      return {
        trades: [],
        optimizationHistory: undefined,
        optimizationWarnings: undefined,
        metrics: undefined,
      };
    }

    // No-Optimize path — flat simulator on the filtered zones. We
    // allocate a metrics bag, pass it as the new out-param, and
    // return it alongside the trades so the per-run summary export
    // can read the funnel without re-running the simulator.
    const metrics: import("@/lib/utils/zone-simulator").SimulateMetrics = {
      zonesConsidered: 0,
      filterRejections: new Map(),
    };
    const flatTrades = simulateAllZones(
      timeFilteredZones,
      runResult.syntheticBarsByZoneId,
      rules,
      runResult.syntheticAtrByZoneId,
      overlayForFilterSim,
      metrics
    );
    return {
      trades: flatTrades,
      optimizationHistory: undefined,
      optimizationWarnings: undefined,
      metrics,
    };
  }, [
    timeFilteredZones,
    runResult.trades,
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticPreEntryBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    runResult.optimizationHistory,
    runResult.optimizationWarnings,
    rules,
    scriptNumericOverrides,
    scriptTradePrints,
    scriptOptimizeOverrides,
    scriptOptimizeAll,
    scriptWarmup,
    scriptFilterIfs,
    appliedScriptText,
    selectedSessionIds,
    asyncOptResult,
  ]);
  const trades = tradesAndOptimization.trades;

  // ─── Script-mode chart inputs ──────────────────────────────────────
  // Builds the bar array consumed by <BacktestScriptChart> when
  // scriptViewMode === "chart". The chart shows one continuous time
  // axis stitched from every selected session — bars are concatenated
  // in chronological order, deduped by bar_time so overlapping sessions
  // don't trip lightweight-charts' "strictly ascending time" assertion.
  //
  // Two early-return guards produce a non-null `warning` instead of bars:
  //   - No sessions selected → "Pick at least one date".
  //   - Multiple instruments selected → can't render coherent candles
  //     because price scales differ across products. The user has to
  //     narrow the selection before the chart can show anything useful.
  //
  // The signal + trade marker arrays passed to the chart come straight
  // from `runResult.syntheticZones` (raw, pre-filter signals) and
  // `trades` (post-filter trades) — see plan note about why no engine
  // refactor is needed.
  const scriptChartInputs = useMemo<{
    bars: ReplayBar[];
    warning: string | null;
  }>(() => {
    const ready = Array.from(selectedSessionIds)
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is ReplaySession => !!s)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));

    if (ready.length === 0) {
      return {
        bars: [],
        warning: "Pick at least one date to render a chart.",
      };
    }

    const instruments = new Set(ready.map((s) => s.instrument));
    if (instruments.size > 1) {
      return {
        bars: [],
        warning:
          "Chart unavailable when multiple instruments are selected. Pick a single instrument.",
      };
    }

    // Stitch + dedupe. Set<string> on bar_time is cheap (a few hundred
    // entries per session) and prevents the "Cannot update oldest data"
    // assertion that fires if two stitched sessions share a timestamp.
    const seen = new Set<string>();
    const bars: ReplayBar[] = [];
    for (const s of ready) {
      const sessionBars = barsBySessionId.get(s.id) ?? [];
      for (const b of sessionBars) {
        if (!seen.has(b.bar_time)) {
          seen.add(b.bar_time);
          bars.push(b);
        }
      }
    }
    bars.sort((a, b) => a.bar_time.localeCompare(b.bar_time));

    if (bars.length === 0) {
      return {
        bars: [],
        warning:
          "Bars are still loading for the selected sessions — give it a moment and the chart will fill in.",
      };
    }

    return { bars, warning: null };
  }, [selectedSessionIds, sessions, barsBySessionId]);

  // ─── Async optimizer runner ─────────────────────────────────────────
  // Owns the call to `runOnlineOptimizedBacktest` (now async). Triggers
  // whenever the optimizer's inputs change: builds a configKey, bails if
  // the cached `asyncOptResult` already matches, otherwise cancels any
  // in-flight run and starts a new one. The optimizer's `onSignalDone`
  // hook awaits `yieldToMain()` (a setTimeout-zero) between every signal
  // so the main thread can paint the sticky-nav progress bar and stay
  // responsive — without it, large runs (lookback × signals × trials)
  // block long enough for Chrome to flag the page as unresponsive.
  //
  // Why a useEffect, not useMemo: useMemo can't await. Moving JUST the
  // optimizer (the slowest path) into an effect lets us preserve the
  // existing fast paths (filter toggles, no-overlay runs) as sync memos
  // while gaining yieldability where it actually matters.
  useEffect(() => {
    const hasOpt =
      scriptOptimizeOverrides && Object.keys(scriptOptimizeOverrides).length > 0;
    if (!hasOpt) {
      // No optimizer overlay — clear any stale async result + progress.
      // This ensures switching the script to a non-optimizer version
      // doesn't leave the cached result showing as if it were current.
      if (asyncOptResult !== null) setAsyncOptResult(null);
      if (scriptRunProgress !== null) setScriptRunProgress(null);
      return;
    }
    if (timeFilteredZones.length === 0) {
      // Nothing to optimize over — no zones survived the filters or
      // bars haven't loaded yet. Avoid spinning up an empty run.
      return;
    }

    // Build the same overlay shape the (now-empty) sync optimizer
    // branch used to build. Mirrors lines 2620-2698 above so the
    // optimizer sees an identical input.
    const hasFilterIfsHere = scriptFilterIfs.length > 0;
    let overlayForFilterSim: import("@/lib/utils/zone-simulator").ScriptOverlay = {
      numericOverrides: scriptNumericOverrides ?? undefined,
      tradePrints: scriptTradePrints.map((p) => ({ label: p.label, expr: p.expr })),
      optimizeOverrides: scriptOptimizeOverrides ?? undefined,
      optimizeAll: scriptOptimizeAll,
      warmup: scriptWarmup,
      filterIfs: hasFilterIfsHere ? scriptFilterIfs : undefined,
    };
    // Inline strategy-DSL `let` bindings — see comment in tradesAndOptimization
    // memo. Without this, the optimizer's filter-sim emits NaN for every
    // print/filter.if/rule expression that references a let.
    if (appliedScriptText) {
      const letBindings = buildLetBindings(parseStrategyScript(appliedScriptText).stmts);
      if (letBindings.size > 0) {
        overlayForFilterSim = applyBindingsToOverlay(overlayForFilterSim, letBindings);
      }
    }
    if (
      overlayForFilterSim.numericOverrides ||
      (overlayForFilterSim.tradePrints && overlayForFilterSim.tradePrints.length > 0) ||
      (overlayForFilterSim.filterIfs && overlayForFilterSim.filterIfs.length > 0)
    ) {
      overlayForFilterSim = {
        ...overlayForFilterSim,
        indicatorByZone: precomputeIndicators(
          timeFilteredZones,
          runResult.syntheticBarsByZoneId,
          collectOverlayExprs(overlayForFilterSim),
          runResult.syntheticPreEntryBarsByZoneId,
          runResult.syntheticTickCtxByZoneId.size > 0
            ? runResult.syntheticTickCtxByZoneId
            : undefined,
        ),
      };
    }

    // ConfigKey: identifies "is the current input the same as what
    // produced asyncOptResult?". Includes everything the optimizer
    // reads. We hash zone IDs (a stable per-zone identity) instead of
    // full zone objects — cheap to stringify, unique enough that any
    // change to the visible trade set invalidates.
    const configKey = JSON.stringify({
      zoneIds: timeFilteredZones.map((z) => z.id),
      rules,
      optimize: scriptOptimizeOverrides
        ? Object.fromEntries(
            Object.entries(scriptOptimizeOverrides).map(([k, spec]) => [
              k,
              `${spec.objective}|${spec.lookbackUnit}|${spec.lookback}`,
            ])
          )
        : null,
      optimizeAll: scriptOptimizeAll,
      warmup: scriptWarmup,
      tradePrints: scriptTradePrints.map((p) => ({ label: p.label, source: p.source })),
      numericOverrides: scriptNumericOverrides
        ? Object.fromEntries(
            Object.entries(scriptNumericOverrides).map(([k, v]) => [
              k,
              v.kind === "expr"
                ? `expr:${v.source}`
                : v.kind === "optimize"
                  ? `opt:${v.source}`
                  : `lit:${v.value}`,
            ])
          )
        : null,
      filterIfs: scriptFilterIfs.map((d) => `${d.scope ?? "both"}|${d.source}`),
      seed: deriveSeed(appliedScriptText, Array.from(selectedSessionIds)),
    });

    if (asyncOptResult && asyncOptResult.configKey === configKey) {
      // Already up-to-date — cached result matches current inputs.
      // Clear any lingering progress (e.g. effect re-fired after a
      // dependency-only render).
      if (scriptRunProgress !== null) setScriptRunProgress(null);
      return;
    }

    // Cancel any in-flight run before starting a new one. The previous
    // run's loop checks `cancelRef.current` between signals — flipping
    // it here makes that loop break out, avoiding a stale-write race
    // where an OLDER run's setAsyncOptResult clobbers the newer one's.
    if (asyncOptCancelRef.current) {
      asyncOptCancelRef.current.current = true;
    }
    const myCancel = { current: false };
    asyncOptCancelRef.current = myCancel;

    setScriptRunProgress({ stage: "optimizing", current: 0, total: timeFilteredZones.length });

    // Throttled yield hook — keeps the page responsive WITHOUT paying
    // the per-signal cost of a setTimeout(0). Two tricks:
    //   1. Time budget: only yield once every YIELD_INTERVAL_MS has
    //      elapsed since the last yield. Most signals fall through as a
    //      cheap `performance.now()` check + early return — at typical
    //      optimizer speeds (~1ms/signal) we yield every ~50 signals
    //      instead of every single one. The earlier "yield every
    //      signal" path was making big runs feel SLOWER than the old
    //      sync code because browsers clamp nested setTimeout(0) to
    //      ~4ms; 1000 signals × 4ms = 4s of pure overhead.
    //   2. MessageChannel postMessage: avoids the setTimeout 4ms clamp
    //      entirely. The macrotask queued via postMessage runs on the
    //      next event-loop tick with NO minimum delay, so when we DO
    //      yield, it's true zero-cost. Fall back to setTimeout in
    //      environments without MessageChannel (none in modern
    //      browsers, but defensive).
    const YIELD_INTERVAL_MS = 50;
    let lastYieldTs = performance.now();
    const yieldToMain = (): Promise<void> => {
      if (typeof MessageChannel === "undefined") {
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      return new Promise<void>((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          ch.port1.close();
          resolve();
        };
        ch.port2.postMessage(null);
      });
    };

    (async () => {
      // Allocate the metrics out-param BEFORE invoking the optimizer so
      // the per-signal filter loop can populate it as it goes. Read it
      // back after the await — it's a plain mutated object.
      const optMetrics: import("@/lib/utils/zone-simulator").SimulateMetrics = {
        zonesConsidered: 0,
        filterRejections: new Map(),
      };
      try {
        const opt = await runOnlineOptimizedBacktest({
          zones: timeFilteredZones,
          barsByZoneId: runResult.syntheticBarsByZoneId,
          baseRules: rules,
          atrByZoneId: runResult.syntheticAtrByZoneId,
          optimizeOverrides: overlayForFilterSim.optimizeOverrides!,
          joint: overlayForFilterSim.optimizeAll ?? false,
          seed: deriveSeed(appliedScriptText, Array.from(selectedSessionIds)),
          tradePrints: overlayForFilterSim.tradePrints,
          indicatorByZone: overlayForFilterSim.indicatorByZone,
          filterIfs: overlayForFilterSim.filterIfs,
          warmup: overlayForFilterSim.warmup,
          cancelRef: myCancel,
          metricsOut: optMetrics,
          onProgress: (done, total) => {
            if (myCancel.current) return;
            setScriptRunProgress({ stage: "optimizing", current: done, total });
          },
          // Time-budget yield (see yieldToMain comments above). Returns
          // synchronously most of the time, only awaits when 50ms has
          // elapsed since the last yield — keeps the run fast while
          // still leaving the browser room to paint progress + handle
          // input events.
          onSignalDone: async () => {
            const now = performance.now();
            if (now - lastYieldTs < YIELD_INTERVAL_MS) return;
            lastYieldTs = now;
            await yieldToMain();
          },
        });
        if (myCancel.current) return;
        setAsyncOptResult({
          configKey,
          trades: opt.trades,
          optimizationHistory:
            Object.keys(opt.optimizationHistory).length > 0
              ? opt.optimizationHistory
              : undefined,
          optimizationWarnings: opt.warnings.length > 0 ? opt.warnings : undefined,
          metrics: optMetrics,
        });
        setScriptRunProgress(null);
      } catch (err) {
        if (!myCancel.current) {
          console.error("[backtest-dashboard] async optimizer failed:", err);
          setScriptRunProgress(null);
        }
      }
    })();

    // Cleanup: on unmount or before re-running, signal cancel so the
    // in-flight run drops its result instead of writing stale state.
    return () => {
      myCancel.current = true;
    };
    // The exhaustive-deps lint includes asyncOptResult / scriptRunProgress,
    // but reading those inside is just for short-circuit guards — adding
    // them as deps would re-fire the effect every time we update them
    // (infinite loop). Same pattern as the runResult.commit effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    timeFilteredZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticPreEntryBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    scriptNumericOverrides,
    scriptTradePrints,
    scriptOptimizeOverrides,
    scriptOptimizeAll,
    scriptWarmup,
    scriptFilterIfs,
    appliedScriptText,
    selectedSessionIds,
  ]);

  // Pass `rules` so a manual tick-config override (Fills & Costs panel)
  // surfaces in the Ticker / Point Value / Ticks-per-Point stat cards
  // instead of being hidden behind the auto-detected CME defaults.
  const summary = useMemo(() => computeSimSummary(trades, rules), [trades, rules]);

  // Clear the Run button's loading flag whenever the backtest result
  // commits. Watching `runResult` directly is the cleanest "compute
  // done" signal — any input change that causes a re-run also clears
  // the flag. The `if (isRunning)` guard makes this idempotent so we
  // don't churn state on dependency-only changes when the user wasn't
  // pressing Run.
  //
  // For Optimize-mode scripts the actual compute lives in the async
  // optimizer effect, NOT runResult — clearing on runResult would
  // flip the spinner off too early. We additionally watch
  // `scriptRunProgress`: when it transitions back to null (the async
  // run committed), the spinner clears.
  useEffect(() => {
    if (isRunning && scriptRunProgress === null) setIsRunning(false);
    // We intentionally only depend on runResult + scriptRunProgress —
    // re-running on `isRunning` would loop. Using the result reference
    // as the trigger is what gives us "compute done" semantics for free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runResult, scriptRunProgress]);

  // List refresher (declared earlier in the file alongside the script
  // handlers — see refreshAvailableScripts above). The mount effect
  // populates `availableScripts` so the picker dropdown is filled
  // before the user clicks it.
  useEffect(() => {
    void refreshAvailableScripts();
  }, [refreshAvailableScripts]);

  // ── Disk-backed script: debounced PUT on every edit ─────────────────
  // Mirrors `scriptText` to disk whenever a disk-backed script is active.
  // The 400ms debounce piggy-backs on the editor's own 150ms emit cadence
  // so a sustained typing burst produces ~2 disk writes/sec — still
  // comfortably under what an SSD handles. Captures the post-write mtime
  // into `lastPutMtimeRef` so the SSE subscription below can recognise
  // its own echo.
  useEffect(() => {
    if (!activeScriptName) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/scripts/${encodeURIComponent(activeScriptName)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: scriptText }),
          }
        );
        if (r.ok) {
          const data = await r.json();
          if (typeof data?.mtimeMs === "number") {
            lastPutMtimeRef.current = data.mtimeMs;
          }
        }
      } catch {
        // Network blip — local + Supabase copies are still authoritative.
        // The next keystroke retries.
      }
    }, 400);
    return () => clearTimeout(t);
  }, [scriptText, activeScriptName]);

  // ── Disk-backed script: SSE subscription to external edits ──────────
  // Opens an EventSource on `/api/scripts/watch?name=<active>` and
  // dispatches `changed` events into `setScriptText`. The editor's
  // existing external-value sync (backtest-script-editor.tsx:1080-1126)
  // handles the dispatch race-free.
  //
  // Echo suppression: the SSE event carries the post-write mtime; if it's
  // at-or-before the most recent mtime our own PUT produced, the event is
  // an echo of our write and we drop it. The `+1ms` slack guards against
  // filesystems with second-granularity mtime (where consecutive PUT and
  // watcher-read can land on the same wall second).
  useEffect(() => {
    if (!activeScriptName) return;
    const url = `/api/scripts/watch?name=${encodeURIComponent(activeScriptName)}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      let evt: {
        type?: string;
        name?: string;
        mtimeMs?: number;
        content?: string;
      };
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      if (evt.type !== "changed") return;
      if (
        typeof evt.mtimeMs === "number" &&
        evt.mtimeMs <= lastPutMtimeRef.current + 1
      ) {
        return;
      }
      if (typeof evt.content !== "string") return;
      // Bump lastPutMtimeRef to the incoming mtime so the next debounced
      // PUT (which fires from this very setScriptText call) doesn't read
      // its own broadcast as a fresh external change.
      if (typeof evt.mtimeMs === "number") {
        lastPutMtimeRef.current = evt.mtimeMs;
      }
      setScriptText(evt.content);
      saveScriptDraft(evt.content);
      // Treat external edits as user-driven so the late Supabase sync
      // doesn't clobber them with a stale server copy.
      scriptUserEditedRef.current = true;
    };
    es.onerror = () => {
      // EventSource auto-reconnects on its own — log only so we know it's
      // happening, don't tear the connection down ourselves.
      console.warn("[script-bridge] SSE error; browser will reconnect.");
    };
    return () => es.close();
  }, [activeScriptName]);

  // ── Disk-backed script: per-Run results export ──────────────────────
  // Fires after a Run completes, building the same DetailedExport JSON
  // the AI-export modal produces plus the NT8-comparable per-trade CSV,
  // and POSTing both to `/api/scripts/results`. The result lands at
  // `backtests/dashboard-results/<base>__<ISO>.{json,csv}` so Claude
  // Code (or any terminal-side analysis tool) can read the outcome of
  // the run without driving the browser.
  //
  // The `pendingResultExportRef` flag (set in handleRun, cleared here)
  // ensures we write at most one snapshot per Run press — without it,
  // any filter toggle that re-derives `trades` would also trigger an
  // export. Fire-and-forget; failures log but don't surface, since this
  // is auxiliary to the in-browser flow.
  useEffect(() => {
    // Diagnostic logging — added in Phase C.1 because runs were silently
    // not producing files and we had zero visibility into WHICH bail
    // condition was hitting. Each early-return path logs a one-liner
    // identifying itself; the `pendingResultExportRef` bail is silent
    // because that effect re-runs on every render and would spam the
    // console. Reading these in DevTools tells you in one click whether
    // the export is firing, skipping (and why), or POSTing successfully.
    if (isRunning) {
      console.log("[results-export] skip: run still in progress");
      return;
    }
    if (!pendingResultExportRef.current) return;
    if (!activeScriptName) {
      console.log(
        "[results-export] skip: no activeScriptName (pick a disk-backed script in the dropdown)"
      );
      pendingResultExportRef.current = false;
      return;
    }
    if (trades.length === 0) {
      console.log(
        "[results-export] skip: trades.length === 0 (no signals survived filters or no bars loaded)"
      );
      pendingResultExportRef.current = false;
      return;
    }
    pendingResultExportRef.current = false;
    console.log(
      `[results-export] writing ${trades.length} trades to backtests/dashboard-results/${activeScriptName.replace(
        /\.dsl$/,
        ""
      )}__<ISO>.{json,csv,summary.json}`
    );
    const payload = buildDetailedExport({
      results: trades,
      zones: timeFilteredZones,
      barsByZoneId: runResult.syntheticBarsByZoneId,
      preEntryBarsByZoneId: runResult.syntheticPreEntryBarsByZoneId,
      atrByZoneId: runResult.syntheticAtrByZoneId,
      rules,
      summary,
      sections: [],
      preEntryBarsCount: 0,
    });
    const csv = buildNt8ComparableTradesCsv({
      results: trades,
      zones: timeFilteredZones,
      barsByZoneId: runResult.syntheticBarsByZoneId,
      rules,
    });
    // Lean per-run summary — readable by terminal-side analysis tools
    // (Claude Code, jq) without choking on the 38 MB DetailedExport.
    // Includes filter rejection funnel, optimization picks, and trade
    // rows in JSON form. See `RunSummary` in run-summary.ts for shape.
    //
    // Wrapped in try/catch because the summary build is auxiliary —
    // it must never block or break the JSON+CSV writes that the
    // dashboard already produced reliably for months. If a future
    // bug in run-summary.ts throws (NaN in arithmetic, missing zone,
    // etc.), the POST still goes out with the summary field omitted
    // and the user still gets the .json/.csv pair. Errors log to the
    // console so I can diagnose without the user having to.
    let summaryJson: ReturnType<typeof buildRunSummary> | null = null;
    try {
      summaryJson = buildRunSummary({
        scriptName: activeScriptName,
        scriptSource: appliedScriptText,
        trades,
        zones: timeFilteredZones,
        barsByZoneId: runResult.syntheticBarsByZoneId,
        stats: summary,
        selectedSessionIds,
        sessions,
        metrics: tradesAndOptimization.metrics,
        filterIfs: scriptFilterIfs,
        optimizationHistory: tradesAndOptimization.optimizationHistory,
        optimizationWarnings: tradesAndOptimization.optimizationWarnings,
      });
    } catch (err) {
      console.warn("[backtest-dashboard] buildRunSummary threw:", err);
    }
    void fetch("/api/scripts/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scriptName: activeScriptName,
        payload,
        csv,
        ...(summaryJson ? { summary: summaryJson } : {}),
      }),
    })
      .then((r) => {
        console.log(`[results-export] POST /api/scripts/results → ${r.status}`);
      })
      .catch((err) => {
        console.warn("[results-export] POST failed:", err);
      });
    // Deliberately NOT depending on `trades` etc. here — the effect runs
    // when isRunning flips false, and we read the latest values straight
    // out of the closure scope. Re-running on every trade tweak is exactly
    // what we want to avoid (the pendingResultExportRef guard handles it,
    // but skipping the deps keeps the wiring tighter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // ── Script v2: evaluate `print = ...` directives once per run ─────
  // Builds the summary symbol table from the SimSummary, then runs each
  // compiled expression. Returns an array of {label, source, value} for
  // the output panel + inline stat cards. NaN values are kept so the UI
  // can render "—" rather than dropping a row.
  const summaryPrintsResult = useMemo(() => {
    if (scriptSummaryPrints.length === 0) return [];
    const symbols = buildSummarySymbolTable(summary);

    // If any print references per-trade symbols (bar fields / indicator
    // aliases / indicator calls), build entry contexts so the evaluator
    // can fall back to averaging across trade entries. Skip the work
    // when every print uses summary-only symbols — the indicator
    // precompute would be wasted.
    const needsEntries = scriptSummaryPrints.some((p) =>
      expressionReferencesEntryContext(p.expr)
    );
    let entryCtxs: EntryEvalCtx[] = [];
    if (needsEntries) {
      const exprs: ScriptExpr[] = scriptSummaryPrints.map((p) => p.expr);
      const indicatorByZone = precomputeIndicators(
        runResult.syntheticZones,
        runResult.syntheticBarsByZoneId,
        exprs,
        // Pre-entry bars warm up ATR/EMA/ADX so the value at bar_index 0
        // is real — the summary-print average across entries would
        // otherwise be NaN-poisoned.
        runResult.syntheticPreEntryBarsByZoneId,
        runResult.syntheticTickCtxByZoneId.size > 0
          ? runResult.syntheticTickCtxByZoneId
          : undefined,
      );
      const zoneById = new Map<number, TradeZone>();
      for (const z of runResult.syntheticZones) zoneById.set(z.id, z);
      // One entry context per surviving trade — `trades` already
      // reflects the active context+time filters, so the average
      // matches what the user is actually looking at on screen.
      for (const t of trades) {
        const zone = zoneById.get(t.zoneId);
        if (!zone) continue;
        const bars = runResult.syntheticBarsByZoneId.get(zone.id);
        if (!bars || bars.length === 0) continue;
        const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);
        const entryBar = sorted.find((b) => b.bar_index === 0) ?? sorted[0];
        const indicatorByKey =
          indicatorByZone.get(zone.id) ?? new Map<string, number[]>();
        // Resolve tickConfig per-zone so summary prints with `ticks(n)`
        // / `tickValue` references get the correct per-instrument
        // numbers when sessions span multiple symbols.
        const tickCfg = resolveTickConfig(zone.instrument, rules);
        entryCtxs.push({
          bar: entryBar,
          barIndex: entryBar.bar_index,
          indicatorByKey,
          zone,
          tickConfig: {
            ticksPerPoint: tickCfg.ticksPerPoint,
            tickValue: tickCfg.tickValue,
            pointValue: tickCfg.pointValue,
          },
        });
      }
    }

    return evaluateSummaryPrintsWithEntries(
      scriptSummaryPrints,
      symbols,
      entryCtxs
    );
  }, [
    scriptSummaryPrints,
    summary,
    trades,
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticPreEntryBarsByZoneId,
  ]);

  // Per-trade prints union of label keys — the trade table needs to know
  // which extra columns to render. We compute this here (not in the
  // table component) so memoization is cheap and the column list stays
  // stable across trade re-renders.
  const tradePrintsLabels = useMemo(() => {
    return scriptTradePrints.map((p) => p.label);
  }, [scriptTradePrints]);

  // Equity curve points — simulated only (the original/raw-signal curve
  // was removed from the backtesting dashboard view). Both points and
  // dollar cumulatives are precomputed so the user's points/dollars
  // toggle is a free re-render.
  const equityCurveData = useMemo((): ZoneEquityPoint[] => {
    if (trades.length === 0) return [];
    let simCum = 0;
    let simDollars = 0;
    return trades.map((r) => {
      simCum += r.scaledPoints;
      simDollars += r.netDollars;
      return {
        label: formatDate(r.startTime),
        // Kept at 0 — backtest dashboard hides the original line, but
        // the field is required by the shared ZoneEquityPoint type.
        originalCumulative: 0,
        simulatedCumulative: Math.round(simCum * 100) / 100,
        simulatedDollars: Math.round(simDollars * 100) / 100,
      };
    });
  }, [trades]);

  // ── Monte Carlo handler ─────────────────────────────────────────────
  // Kicks off a 1000-simulation bootstrap over the current trade pool,
  // sized to the requested horizon. We yield a frame before running so
  // the "RUNNING…" button label paints — without the rAF the synchronous
  // bootstrap blocks the UI thread and the spinner state never shows.
  const handleRunMonteCarlo = useCallback(
    (horizon: MonteCarloHorizon) => {
      if (trades.length === 0) return;
      setMonteCarloRunning(horizon);
      // Defer one frame so React paints the "running" state before we
      // hog the main thread. The bootstrap itself is ~30ms even at 1Y,
      // so the user-visible "running" flash is brief but it confirms the
      // click registered.
      requestAnimationFrame(() => {
        const tpd = tradesPerDay(summary);
        const numTrades = horizonToTradeCount(horizon, tpd);
        const result = runMonteCarlo(trades, numTrades, displayMode, horizon);
        setMonteCarloResult(result);
        setMonteCarloRunning(null);
      });
    },
    [trades, summary, displayMode]
  );

  // Clear stale Monte Carlo results when the underlying data changes —
  // running a new backtest, switching units, or any rule change makes the
  // existing projection meaningless. We watch a coarse signal (trades and
  // displayMode) so re-runs land on a clean slate without the user having
  // to remember to dismiss the panel manually.
  useEffect(() => {
    setMonteCarloResult(null);
  }, [trades, displayMode]);

  // Composite winning-trade builder — only computes when the user has
  // toggled the panel open. Stacks every winner on a normalized
  // timeline (entry → exit) so we can render the median "perfect trade"
  // shape with percentile bands. Gated by `showCompositeTrade` so the
  // O(trades × gridPoints) work is skipped while the panel is closed.
  const compositeTrade = useMemo(() => {
    if (!showCompositeTrade) return null;
    return buildCompositeTrade(
      trades,
      timeFilteredZones,
      runResult.syntheticBarsByZoneId
    );
  }, [
    showCompositeTrade,
    trades,
    timeFilteredZones,
    runResult.syntheticBarsByZoneId,
  ]);

  // Composite OHLC-bars builder — same gating logic as compositeTrade
  // but produces averaged candles per direction. Only computed when the
  // bars panel is open so we don't pay for the per-direction averaging
  // walks unless the user asked for them.
  const compositeBars = useMemo(() => {
    if (!showCompositeBars) return null;
    return buildCompositeBars(
      trades,
      timeFilteredZones,
      runResult.syntheticBarsByZoneId,
      // Pre-entry bars (-30..-1) so the chart can render "the typical
      // setup that led into a winning trade", which is usually where
      // the most actionable patterns live.
      runResult.syntheticPreEntryBarsByZoneId
    );
  }, [
    showCompositeBars,
    trades,
    timeFilteredZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticPreEntryBarsByZoneId,
  ]);

  // Refs for the strategy params editor — using uncontrolled inputs so typing
  // doesn't re-render the whole tree on every keystroke. We commit on blur /
  // step via the change handler.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleParamChange = (key: string, value: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setParams((prev) => ({ ...prev, [key]: value }));
    }, 150);
  };
  // Reset = "load this strategy's preset". Overwrites every key in the
  // flat dict with the active strategy's defaults, dropping any params
  // the user had carried over from a previous strategy.
  const resetParams = () => {
    setParams(defaultParamsFor(currentStrategy));
    setParamsVersion((v) => v + 1);
  };

  /** Per-param optimizer — sweeps a single strategy parameter across its
   *  field-defined [min, max] in step increments and applies the best value.
   *  Holds every other strategy param at its current value. Runs in the
   *  shared optimizer worker so it survives a backgrounded tab. Clicking
   *  the same OPT button while it's running cancels and applies the
   *  best-so-far value. */
  const handleOptimizeParam = useCallback(
    async (field: StrategyParamField) => {
      // Already optimizing this param? Treat the click as a cancel.
      if (optimizingParamKey === field.key) {
        paramOptCancelRef.current = true;
        return;
      }
      // Block if another param's optimizer is running, or if we don't
      // have any sessions to backtest against.
      if (optimizingParamKey !== null) return;

      const ready = Array.from(selectedSessionIds)
        .map((id) => {
          const sess = sessions.find((s) => s.id === id);
          const bars = barsBySessionId.get(id);
          if (!sess || !bars) return null;
          return { instrument: sess.instrument, bars };
        })
        .filter(
          (x): x is { instrument: string; bars: ReplayBar[] } => x !== null
        );
      if (ready.length === 0) return;

      paramOptCancelRef.current = false;
      setOptimizingParamKey(field.key);
      setOptimizeParamProgress(0);

      try {
        const result = await runStrategyParamOptimizeInWorker(
          ready,
          strategyId,
          params,
          field.key,
          { min: field.min, max: field.max, step: field.step },
          rules,
          (p) => setOptimizeParamProgress(p),
          paramOptCancelRef,
          // Pass the dashboard's current indicator config so optimizer
          // candidates compute ATR/ADX/EMA/BB with the same periods the
          // user has configured for filters / ATR-adjust. Without this,
          // the optimizer would silently use period-14 defaults.
          indicatorConfig
        );
        // Apply the winner. Round to a sensible precision for ints and
        // float fields with bigger steps; tiny-step floats keep their
        // full value. The generator already rounds to step boundaries
        // internally, so this is mostly belt-and-suspenders.
        const finalValue =
          field.type === "int"
            ? Math.round(result.bestValue)
            : Math.round(result.bestValue * 1e6) / 1e6;
        setParams((prev) => ({ ...prev, [field.key]: finalValue }));
        setParamsVersion((v) => v + 1);
      } finally {
        setOptimizingParamKey(null);
        setOptimizeParamProgress(null);
      }
    },
    [
      optimizingParamKey,
      selectedSessionIds,
      sessions,
      barsBySessionId,
      strategyId,
      params,
      rules,
      indicatorConfig,
    ]
  );

  // Loading hint for the run banner
  const loadingCount = Array.from(selectedSessionIds).filter(
    (id) => !barsBySessionId.has(id)
  ).length;

  // ─── Optimizer callbacks ─────────────────────────────────────────
  // Both follow the same shape as the risk simulator: button click opens a
  // config modal; the modal's "Run" calls the actual optimizer with the
  // currently-loaded synthetic zones + bars + base rules. Disabled until at
  // least one trade has been produced — there's nothing to optimize against
  // an empty result set. Optimizers consume `timeFilteredZones` so the
  // grid search respects the active time window — same convention as the
  // risk simulator, where SL/TP/TSL search runs over the time-filtered
  // pool, not the raw set.
  const canOptimize =
    trades.length > 0 &&
    !optimizing &&
    !optimizingAtr &&
    !optimizingTime &&
    !contextOptimizing;

  const openOptimizeModal = useCallback(() => {
    if (!canOptimize) return;
    setShowOptimizeConfigModal(true);
  }, [canOptimize]);

  const runOptimizeNow = useCallback(
    (config: OptimizeConfig) => {
      if (timeFilteredZones.length === 0) return;
      setShowOptimizeConfigModal(false);
      cancelRef.current = false;
      setOptimizing(true);
      setOptimizeProgress(0);

      // Pass the per-zone ATR map so the optimizer's grid search sees
      // the same ± ATR adjustment math the live preview uses. Without
      // it, the optimizer would silently ignore the user's ± ATR
      // values and pick a "best" combo that doesn't match what the
      // dashboard displays.
      runOptimizeChunked(
        timeFilteredZones,
        runResult.syntheticBarsByZoneId,
        rules,
        config,
        (p) => setOptimizeProgress(p),
        cancelRef,
        runResult.syntheticAtrByZoneId
      ).then((result) => {
        setRules((prev) => ({ ...prev, ...result.bestRules }));
        setRulesVersion((v) => v + 1);
        setOptimizing(false);
        setOptimizeProgress(null);
      });
    },
    [
      timeFilteredZones,
      runResult.syntheticBarsByZoneId,
      runResult.syntheticAtrByZoneId,
      rules,
    ]
  );

  const openOptimizeAtrModal = useCallback(() => {
    if (!canOptimize) return;
    setShowOptimizeAtrConfigModal(true);
  }, [canOptimize]);

  const runOptimizeAtrNow = useCallback(
    (config: AtrAdjustOptimizeConfig) => {
      if (timeFilteredZones.length === 0) return;
      setShowOptimizeAtrConfigModal(false);
      atrCancelRef.current = false;
      setOptimizingAtr(true);
      setOptimizeAtrProgress(0);

      // ATR-Adjust optimizer especially needs the ATR map — its whole
      // purpose is to grid-search the ± ATR fields. Without the map,
      // every combo collapses to base points and the optimizer can't
      // distinguish them.
      runAtrAdjustOptimizeChunked(
        timeFilteredZones,
        runResult.syntheticBarsByZoneId,
        rules,
        config,
        (p) => setOptimizeAtrProgress(p),
        atrCancelRef,
        runResult.syntheticAtrByZoneId
      ).then((result) => {
        setRules((prev) => ({ ...prev, ...result.bestRules }));
        setRulesVersion((v) => v + 1);
        setOptimizingAtr(false);
        setOptimizeAtrProgress(null);
      });
    },
    [
      timeFilteredZones,
      runResult.syntheticBarsByZoneId,
      runResult.syntheticAtrByZoneId,
      rules,
    ]
  );

  // ─── Context-filter optimizers ────────────────────────────────────
  // Each "Optimize X" button builds a base pool that includes every OTHER
  // currently-active filter (so narrowing is additive), then hands the
  // pool to the corresponding worker-backed optimizer. The min-trades
  // floor (20, enforced inside the optimizer) gates against lucky
  // micro-subsets.
  const parseTimeMinutes = useCallback((t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }, []);

  // Build a pool with every enabled filter applied EXCEPT the one named.
  // Mirrors `buildBasePool` in simulator-panel.tsx so backtest and
  // simulator agree on the additive-narrowing semantics.
  const buildBasePool = useCallback(
    (
      exclude:
        | "adx"
        | "atr"
        | "trend"
        | "bollinger"
        | "bbWidth"
        | "maDistance"
        | "volume"
        | "rsi"
        | "adxTrend"
        | "delta"
    ) => {
      let pool = runResult.syntheticZones;
      if (adxFilterEnabled && exclude !== "adx") {
        pool = pool.filter(
          (z) => z.ctx_adx14 != null && z.ctx_adx14 >= adxMin && z.ctx_adx14 <= adxMax
        );
      }
      if (atrFilterEnabled && exclude !== "atr") {
        pool = pool.filter(
          (z) => z.ctx_atr14 != null && z.ctx_atr14 >= atrMin && z.ctx_atr14 <= atrMax
        );
      }
      if (trendFilterEnabled && exclude !== "trend") {
        pool = pool.filter((z) => {
          const isLong = z.direction === "Long";
          if (ema20Mode !== "any") {
            if (z.ctx_price_vs_ema20 == null) return false;
            const isWith =
              (isLong && z.ctx_price_vs_ema20 === "above") ||
              (!isLong && z.ctx_price_vs_ema20 === "below");
            if (ema20Mode === "with" && !isWith) return false;
            if (ema20Mode === "against" && isWith) return false;
          }
          if (ema200Mode !== "any") {
            if (z.ctx_price_vs_ema200 == null) return false;
            const isWith =
              (isLong && z.ctx_price_vs_ema200 === "above") ||
              (!isLong && z.ctx_price_vs_ema200 === "below");
            if (ema200Mode === "with" && !isWith) return false;
            if (ema200Mode === "against" && isWith) return false;
          }
          return true;
        });
      }
      if (bollingerFilterEnabled && exclude !== "bollinger") {
        pool = pool.filter(
          (z) =>
            z.ctx_bollinger_pos != null && bollingerAllowed.has(z.ctx_bollinger_pos)
        );
      }
      if (bbWidthFilterEnabled && exclude !== "bbWidth") {
        pool = pool.filter((z) => {
          const bw = z.ctx_bollinger_bw ?? null;
          if (bw == null) return false;
          return bw >= bbWidthMin && bw <= bbWidthMax;
        });
      }
      if (maDistanceFilterEnabled && exclude !== "maDistance") {
        pool = pool.filter((z) => {
          const d = z.ctx_ma_distance_atr ?? null;
          if (d == null) return false;
          if (maDistanceMode === "absolute") {
            const ad = Math.abs(d);
            return ad >= maDistanceMin && ad <= maDistanceMax;
          }
          if (maDistanceMode === "above") {
            if (d < 0) return false;
            return d >= maDistanceMin && d <= maDistanceMax;
          }
          if (d > 0) return false;
          const ad = Math.abs(d);
          return ad >= maDistanceMin && ad <= maDistanceMax;
        });
      }
      if (volumeFilterEnabled && exclude !== "volume") {
        pool = pool.filter((z) => {
          const r = z.ctx_volume_ratio ?? null;
          if (r == null) return false;
          return r >= volumeMinRatio && r <= volumeMaxRatio;
        });
      }
      if (rsiFilterEnabled && exclude !== "rsi") {
        pool = pool.filter(
          (z) => z.ctx_rsi != null && z.ctx_rsi >= rsiMin && z.ctx_rsi <= rsiMax
        );
      }
      if (
        adxTrendFilterEnabled &&
        adxTrendMode !== "any" &&
        exclude !== "adxTrend"
      ) {
        const thresh = Math.abs(adxTrendFlatThreshold);
        pool = pool.filter((z) => {
          const slope = z.ctx_adx_slope ?? null;
          if (slope == null) return false;
          if (adxTrendMode === "rising") return slope > thresh;
          if (adxTrendMode === "falling") return slope < -thresh;
          // "flat"
          return Math.abs(slope) <= thresh;
        });
      }
      if (deltaFilterEnabled && exclude !== "delta") {
        pool = pool.filter((z) => {
          const d = z.ctx_delta_ratio ?? null;
          if (d == null) return false;
          return d >= deltaMin && d <= deltaMax;
        });
      }
      if (timeFilterEnabled && timeWindows.length > 0) {
        const parsed = timeWindows.map((w) => ({
          from: parseTimeMinutes(w.from),
          to: parseTimeMinutes(w.to),
        }));
        pool = pool.filter((z) => {
          const { hour, minute } = parseRawTimestamp(z.start_time);
          const zm = hour * 60 + minute;
          for (const w of parsed) {
            if (w.from <= w.to) {
              if (zm >= w.from && zm <= w.to) return true;
            } else {
              if (zm >= w.from || zm <= w.to) return true;
            }
          }
          return false;
        });
      }
      return pool;
    },
    [
      runResult.syntheticZones,
      adxFilterEnabled,
      adxMin,
      adxMax,
      atrFilterEnabled,
      atrMin,
      atrMax,
      trendFilterEnabled,
      ema20Mode,
      ema200Mode,
      bollingerFilterEnabled,
      bollingerAllowed,
      bbWidthFilterEnabled,
      bbWidthMin,
      bbWidthMax,
      maDistanceFilterEnabled,
      maDistanceMode,
      maDistanceMin,
      maDistanceMax,
      volumeFilterEnabled,
      volumeMinRatio,
      volumeMaxRatio,
      rsiFilterEnabled,
      rsiMin,
      rsiMax,
      adxTrendFilterEnabled,
      adxTrendMode,
      adxTrendFlatThreshold,
      deltaFilterEnabled,
      deltaMin,
      deltaMax,
      timeFilterEnabled,
      timeWindows,
      parseTimeMinutes,
    ]
  );

  const runOptimizeAdx = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeAdxInWorker(
        buildBasePool("adx"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("ADX optimizer: no range produced at least 20 trades.");
        return;
      }
      setAdxFilterEnabled(true);
      setAdxMin(result.min);
      setAdxMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeAtr = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeAtrInWorker(
        buildBasePool("atr"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("ATR optimizer: no range produced at least 20 trades.");
        return;
      }
      setAtrFilterEnabled(true);
      setAtrMin(result.min);
      setAtrMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeTrend = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeTrendInWorker(
        buildBasePool("trend"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("Trend optimizer: no combination produced at least 20 trades.");
        return;
      }
      setTrendFilterEnabled(true);
      setEma20Mode(result.ema20Mode);
      setEma200Mode(result.ema200Mode);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeBollinger = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeBollingerInWorker(
        buildBasePool("bollinger"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("Bollinger optimizer: no subset produced at least 20 trades.");
        return;
      }
      setBollingerFilterEnabled(true);
      setBollingerAllowed(new Set(result.allowed));
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeBbWidth = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeBbWidthInWorker(
        buildBasePool("bbWidth"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("BB-width optimizer: no range produced at least 20 trades.");
        return;
      }
      setBbWidthFilterEnabled(true);
      setBbWidthMin(result.min);
      setBbWidthMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeMaDistance = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeMaDistanceInWorker(
        buildBasePool("maDistance"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("MA-distance optimizer: no range produced at least 20 trades.");
        return;
      }
      setMaDistanceFilterEnabled(true);
      setMaDistanceMode(result.mode);
      setMaDistanceMin(result.min);
      setMaDistanceMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeVolume = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeVolumeInWorker(
        buildBasePool("volume"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("Volume optimizer: no range produced at least 20 trades.");
        return;
      }
      setVolumeFilterEnabled(true);
      setVolumeMinRatio(result.min);
      setVolumeMaxRatio(result.max);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeRsi = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeRsiInWorker(
        buildBasePool("rsi"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("RSI optimizer: no range produced at least 20 trades.");
        return;
      }
      setRsiFilterEnabled(true);
      setRsiMin(result.min);
      setRsiMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  const runOptimizeAdxTrend = useCallback(async () => {
    if (runResult.syntheticZones.length === 0 || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeAdxTrendInWorker(
        buildBasePool("adxTrend"),
        runResult.syntheticBarsByZoneId,
        rules,
        runResult.syntheticAtrByZoneId
      );
      if (!result) {
        showToast("ADX-direction optimizer: no mode produced at least 20 trades.");
        return;
      }
      setAdxTrendFilterEnabled(true);
      setAdxTrendMode(result.mode);
      setAdxTrendFlatThreshold(result.flatThreshold);
    } finally {
      setContextOptimizing(false);
    }
  }, [
    runResult.syntheticZones,
    runResult.syntheticBarsByZoneId,
    runResult.syntheticAtrByZoneId,
    rules,
    contextOptimizing,
    buildBasePool,
    showToast,
  ]);

  // ─── Time optimizer callback ─────────────────────────────────────
  // Sweeps every contiguous 30-min sub-window over the CONTEXT-filtered
  // synthetic zones (mirrors simulator-panel.tsx — context filters are
  // permanent constraints, so the time sweep respects them). The time
  // filter itself is bypassed during the sweep so the optimizer can
  // search outside the user's current window. Auto-enables the time
  // filter so the result is immediately visible.
  const handleOptimizeTime = useCallback(
    (minWindowMinutes: number) => {
      if (contextFilteredZones.length === 0 || optimizingTime) return;

      setShowTimeOptModal(false);
      timeCancelRef.current = false;
      setOptimizingTime(true);
      setOptimizeTimeProgress(0);

      runTimeOptimizeChunked(
        contextFilteredZones,
        runResult.syntheticBarsByZoneId,
        rules,
        minWindowMinutes,
        (p) => setOptimizeTimeProgress(p),
        timeCancelRef,
        runResult.syntheticAtrByZoneId
      ).then((result) => {
        setTimeFilterEnabled(true);
        // Optimizer finds ONE best window — REPLACE the windows list
        // with that single window. Users who want to stack additional
        // windows on top can re-add them manually after the optimizer
        // applies. Same convention the other context optimizers use
        // (they overwrite the user's prior min/max with the best one).
        setTimeWindows([{ from: result.bestTimeFrom, to: result.bestTimeTo }]);
        setOptimizingTime(false);
        setOptimizeTimeProgress(null);
      });
    },
    [
      contextFilteredZones,
      runResult.syntheticBarsByZoneId,
      runResult.syntheticAtrByZoneId,
      rules,
      optimizingTime,
    ]
  );

  // ─── CSV export ───────────────────────────────────────────────────
  // Mirrors the risk simulator's CSV export: one row per simulated trade
  // with date, time, instrument, direction, original/sim points, position
  // size, scaled points, exit reason, bars held, peak MFE, max drawdown.
  // Operates on the post-time-filter `trades` so the file matches what's
  // visible on screen.
  const handleExportCsv = useCallback(() => {
    if (trades.length === 0) return;

    const headers = [
      "Date", "Time", "Instrument", "Direction",
      "Original Points", "Simulated Points",
      "Position Size", "Scaled Points",
      "Exit Reason", "Bars Held", "Peak MFE", "Max Drawdown",
    ];
    const rows = trades.map((r) => {
      const { year, month, day, hour, minute, second } = parseRawTimestamp(r.startTime);
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
      return [
        dateStr,
        timeStr,
        r.instrument,
        r.direction,
        r.originalPoints.toFixed(2),
        r.exitPoints.toFixed(2),
        r.positionSize.toString(),
        r.scaledPoints.toFixed(2),
        r.exitReason.toUpperCase(),
        r.barsHeld,
        r.peakMfe.toFixed(2),
        r.maxDrawdown.toFixed(2),
      ].join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const filename = `backtest-trades-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.csv`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [trades]);

  // ─── AI JSON export ───────────────────────────────────────────────
  // Reuses the same `buildDetailedExport` helper the risk simulator uses,
  // so the JSON shape is identical and the user can swap files between
  // tools without retraining their LLM prompt. Synthetic zones don't carry
  // `ctx_*` market context (we don't compute it during the backtest run)
  // or `section_id`, so those fields fall back to null in the output.
  const handleExportDetailed = useCallback(
    (preEntryBarsCount: number) => {
      if (trades.length === 0) return;

      const payload = buildDetailedExport({
        results: trades,
        zones: timeFilteredZones,
        barsByZoneId: runResult.syntheticBarsByZoneId,
        // Engine-emitted pre-entry bars give the AI the setup context that
        // led INTO each entry — same role as the simulator's pre-entry
        // fetch, but sourced directly from the session bars we already
        // have in memory (no extra Supabase round-trip).
        preEntryBarsByZoneId: runResult.syntheticPreEntryBarsByZoneId,
        // Per-zone ATR(14) at entry, computed by the backtest engine
        // alongside ctx_atr14. Lets the AI export's `atr_at_entry`
        // field carry the same value the simulator uses for ATR-adjust
        // math, instead of falling back to null.
        atrByZoneId: runResult.syntheticAtrByZoneId,
        rules,
        summary,
        // No sections concept in the backtest tab — the export's
        // section field falls back to null when the array is empty.
        sections: [],
        preEntryBarsCount,
      });

      const now = new Date();
      const filename = `backtest-trades-detailed-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.json`;

      downloadDetailedExport(payload, filename);
      setShowExportDetailedModal(false);
    },
    [
      trades,
      timeFilteredZones,
      runResult.syntheticBarsByZoneId,
      runResult.syntheticPreEntryBarsByZoneId,
      runResult.syntheticAtrByZoneId,
      // Compiler relies on `trades` already being in this list — others
      // here are passed straight to buildDetailedExport.
      rules,
      summary,
    ]
  );

  // ─── NT8-comparable CSV export ────────────────────────────────────
  // Per-trade row table whose column schema matches NinjaScript's
  // PresetStrategy.ExportTradesCsv exactly. Pair with the
  // scripts/diff-backtests.mjs tool to find parity bugs between this
  // simulator and the live NT8 strategy. Emits the SAME final-results
  // set the JSON export uses (post-overlap-gating, post-scaling,
  // post-daily-limits) so the diff sees what the user actually sees.
  const handleExportNt8Csv = useCallback(() => {
    if (trades.length === 0) return;
    const csv = buildNt8ComparableTradesCsv({
      results: trades,
      zones: timeFilteredZones,
      barsByZoneId: runResult.syntheticBarsByZoneId,
      rules,
    });
    const now = new Date();
    const filename = `backtest-trades-${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.csv`;
    downloadNt8ComparableTradesCsv(csv, filename);
    setShowExportDetailedModal(false);
  }, [trades, timeFilteredZones, runResult.syntheticBarsByZoneId, rules]);

  return (
    <div
      ref={splitContainerRef}
      // In Script mode the dashboard renders as a 2-column flex layout:
      // left = the existing UI controls + results (the click-through
      // surface), right = the script editor + output panel in a sticky
      // rail. The user-confirmed default is 60/40 left/right; ratio
      // persists in localStorage and is editable via the drag divider
      // between the two panes (see splitContainerRef + onSplitDown).
      // No `gap` because the divider itself provides the visual
      // separation — adding gap would make the divider hit-target feel
      // detached from the columns it's resizing.
      className={mode === "script" ? "flex flex-row gap-0 items-start" : "space-y-4"}
    >
      <div
        className={mode === "script" ? "min-w-0 space-y-4 pr-3" : "contents"}
        // Width is set as an inline percentage so the drag divider can
        // mutate it directly without reaching into Tailwind's spacing
        // scale. In UI mode the wrapper uses `display: contents` so the
        // outer space-y-4 layout sees the children as direct kids —
        // legacy single-column behavior is byte-identical.
        style={mode === "script" ? { width: `${scriptLeftPct}%` } : undefined}
      >
      {/* ── Sticky walk-forward control bar ──────────────────────────
          Sticky-positioned at the very top of the left column so the
          most-used "advance the window" buttons are always reachable
          regardless of scroll depth. Renders unconditionally (both
          modes) once at least one session is downloaded — when no
          sessions are loaded there's nothing to walk through and the
          bar would just be a row of disabled buttons. The detailed
          Window/Step number inputs stay in the original day-picker
          location below; this bar only surfaces the navigation. */}
      {sessions.length > 0 && (
        <div
          className="sticky z-20 -mt-1 -mx-1 px-3 py-2 rounded-md bg-card/95 backdrop-blur border border-card-border flex items-center gap-2 flex-wrap shadow-sm"
          style={{ top: "0.5rem" }}
        >
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Walk Fwd
          </span>
          <button
            onClick={() => applyWalkForwardWindow(0)}
            className="px-2.5 py-1 rounded text-xs font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
            title="Jump to the first window (oldest N days)"
          >
            Start
          </button>
          <button
            onClick={() =>
              applyWalkForwardWindow(walkForwardStart - Math.max(1, walkForwardStep))
            }
            disabled={!canWfPrev}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              canWfPrev
                ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
            title={`Slide back ${Math.max(1, walkForwardStep)} day${walkForwardStep === 1 ? "" : "s"}`}
          >
            ← Prev
          </button>
          <button
            onClick={() =>
              applyWalkForwardWindow(walkForwardStart + Math.max(1, walkForwardStep))
            }
            disabled={!canWfNext}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              canWfNext
                ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
            title={`Advance ${Math.max(1, walkForwardStep)} day${walkForwardStep === 1 ? "" : "s"} forward`}
          >
            Next →
          </button>
          {/* ── Script-mode View sub-toggle ──────────────────────
              Only visible in script mode. Switches the left column
              between the legacy controls (UI) and a TradingView
              candlestick chart (Chart) of the selected sessions.
              Lives in the walk-forward sticky bar so it stays in
              reach while the user scrolls deep into the trade
              table. `ml-auto` pushes it (and the days span that
              follows) to the right edge of the bar — keeps the
              walk-forward buttons grouped at the left. */}
          {mode === "script" && (
            <div
              className="ml-auto inline-flex rounded-md overflow-hidden border border-card-border"
              role="group"
              aria-label="Script view"
            >
              {(["ui", "chart"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setScriptViewMode(v)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    scriptViewMode === v
                      ? "bg-accent-green/20 text-accent-green"
                      : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                  title={
                    v === "ui"
                      ? "Show controls + day picker + results"
                      : "Show a candlestick chart of the selected sessions with signal/trade markers"
                  }
                >
                  {v === "ui" ? "UI" : "Chart"}
                </button>
              ))}
            </div>
          )}
          {selectedSessionIds.size > 0 && (
            <span
              className={`text-xs text-muted-foreground ${
                mode === "script" ? "" : "ml-auto"
              }`}
            >
              Days {walkForwardStart + 1}–{wfWindowEnd} of {sessionsChrono.length}
            </span>
          )}
        </div>
      )}

      {/* ── Script-mode Chart-view branch ──────────────────────────────
          When the user picks "Chart" in the View toggle (script mode
          only), all the click-through left-column children (Presets,
          Mode toggle, Day picker, Results, Stat cards, ...) are
          collapsed and replaced with a candlestick chart of the
          selected sessions. The walk-forward sticky bar above stays
          visible because it owns the UI/Chart toggle that gets you
          back here. The right rail (script editor + output panel) is
          unaffected — it lives outside this wrapper.

          UI-mode branch: render the entire legacy left-column
          subtree, byte-identical to the pre-feature behavior. */}
      {!(mode === "script" && scriptViewMode === "chart") && (
        <>
      {/* ── Presets — saved configurations of strategy + params + rules
            + filters. Sits at the top so users land on it first when
            they want to switch between known-good setups. Day selection
            is intentionally NOT part of a preset (see comment near
            handleLoadPreset). */}
      <BacktestPresetsPanel
        presets={presets}
        onLoad={handleLoadPreset}
        onSaveAs={handleSavePreset}
        onUpdate={handleUpdatePreset}
        onDelete={handleDeletePreset}
        liveScript={scriptText}
        liveParamMeta={scriptParamMeta}
      />

      {/* ── UI ↔ Script mode toggle ─────────────────────────────────
          Sits at the top of the editing surface so it's always visible
          regardless of mode. In "ui" the click-through controls below are
          live; in "script" they're hidden and the script editor takes
          their place. Day selection / results / exports stay visible in
          both — they aren't config, they're the act of running a backtest. */}
      <div className="bg-card border border-card-border rounded-lg p-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Mode
          </span>
          <div className="inline-flex rounded-md overflow-hidden border border-card-border">
            {(["ui", "script"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                }`}
              >
                {m === "ui" ? "UI" : "Script"}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground/70 ml-2">
            {mode === "ui"
              ? "Edit configuration via the click-through controls below."
              : "Edit the full configuration as a script. Use ⌃space / ⌘space for suggestions."}
          </span>
        </div>
        {/* Reference / Sync from UI / Apply buttons used to live here.
            They've been promoted to the sticky control bar at the top
            of the right rail so they're always reachable while editing
            the script — see the aside near the bottom of this return. */}
      </div>

      {/* Script editor lives in the RIGHT RAIL when mode === "script"
          (see the aside near the bottom of this return). The inline
          render here intentionally produces nothing in script mode so the
          editor isn't double-mounted. */}

      {/* ── Day picker ────────────────────────────────────────────────
          Multi-select chip grid of every downloaded session. Click a chip to
          toggle. Loading sessions show a small spinner inline so the user
          knows the bar fetch is in flight. */}
      <div className="bg-card border border-card-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
            Downloaded Days (
            {instrumentFilter.size > 0 || timeframeFilter
              ? `${filteredSessions.length} of ${sessions.length}`
              : `${sessions.length}`}{" "}
            available
            {hiddenSelectedCount > 0
              ? ` · ${hiddenSelectedCount} selected hidden`
              : ""}
            )
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={selectAll}
              disabled={filteredSessions.length === 0}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                filteredSessions.length === 0
                  ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                  : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              }`}
              title={
                instrumentFilter.size > 0 || timeframeFilter
                  ? "Add every session that matches the current filters to your selection"
                  : "Select every downloaded session"
              }
            >
              Select All
            </button>
            <button
              onClick={clearAll}
              disabled={selectedSessionIds.size === 0}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                selectedSessionIds.size === 0
                  ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                  : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              }`}
            >
              Clear
            </button>
          </div>
        </div>

        {/* Filter row — narrow the day picker by instrument and/or
            timeframe. Options are derived from the actual session
            library so users can never pick an empty filter. The
            "Reset" pill clears both filters in one click; it's only
            shown when at least one filter is active to keep the row
            compact. Bulk operations (Select All, Random, Walk Fwd)
            all operate on the filtered set so users can use these
            filters as a scoping tool. */}
        {sessions.length > 0 &&
          (availableInstruments.length > 1 ||
            availableTimeframes.length > 1) && (
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                Filter
              </span>
              {availableInstruments.length > 1 && (
                <div
                  className="flex items-center gap-1.5"
                  title="Show only sessions for the selected assets — click multiple to combine, click again to remove"
                >
                  <span className="text-xs text-muted-foreground">Asset</span>
                  {/* Multi-select chip row — clicking a symbol toggles it
                      in/out of the filter set. With nothing selected, every
                      asset passes (label: "All"); with one or more
                      selected, only those assets pass. The "All" chip is a
                      one-click way back to the unfiltered state. */}
                  <button
                    onClick={() => setInstrumentFilter(new Set())}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      instrumentFilter.size === 0
                        ? "bg-accent-green/20 text-accent-green"
                        : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                    }`}
                    aria-pressed={instrumentFilter.size === 0}
                    title="Show sessions for every asset"
                  >
                    All
                  </button>
                  {availableInstruments.map((sym) => {
                    const active = instrumentFilter.has(sym);
                    return (
                      <button
                        key={sym}
                        onClick={() => toggleInstrumentFilter(sym)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                          active
                            ? "bg-accent-green/20 text-accent-green"
                            : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                        }`}
                        aria-pressed={active}
                        title={
                          active
                            ? `Remove ${sym} from the filter`
                            : `Add ${sym} to the filter`
                        }
                      >
                        {sym}
                      </button>
                    );
                  })}
                </div>
              )}
              {availableTimeframes.length > 1 && (
                <label
                  className="flex items-center gap-1.5"
                  title="Show only sessions recorded at this timeframe"
                >
                  <span className="text-xs text-muted-foreground">Timeframe</span>
                  <select
                    value={timeframeFilter}
                    onChange={(e) => setTimeframeFilter(e.target.value)}
                    className="bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                    aria-label="Filter sessions by timeframe"
                  >
                    <option value="">All ({availableTimeframes.length})</option>
                    {availableTimeframes.map((tf) => (
                      <option key={tf} value={tf}>
                        {tf}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(instrumentFilter.size > 0 || timeframeFilter) && (
                <button
                  onClick={() => {
                    setInstrumentFilter(new Set());
                    setTimeframeFilter("");
                  }}
                  className="px-2 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
                  title="Clear all filters"
                >
                  Reset
                </button>
              )}
            </div>
          )}

        {/* Random selection row — picks N distinct sessions uniformly at
            random and REPLACES the current selection. Useful for
            cross-validation style backtests. The number input lets the
            user dial in an exact count; the percentage chips are
            shortcuts that compute Math.ceil(sessions.length × pct) and
            apply immediately. Each click re-rolls — no determinism
            knob, just hit the chip again to resample. */}
        {sessions.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">
              Random
            </span>
            <input
              type="number"
              min={1}
              max={filteredSessions.length || 1}
              value={randomCount}
              onChange={(e) => setRandomCount(Number(e.target.value) || 0)}
              className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              aria-label="Random sample size"
            />
            <button
              onClick={() => pickRandom(randomCount)}
              disabled={randomCount <= 0 || filteredSessions.length === 0}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                randomCount <= 0 || filteredSessions.length === 0
                  ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                  : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
              }`}
            >
              Pick {Math.min(randomCount, filteredSessions.length)}
            </button>
            {/* Percentage shortcuts — apply on click so the user gets a
                one-tap "give me 25% of the dataset" experience. Each
                shows the exact count it'll resolve to so users aren't
                surprised by rounding. Clicking the same chip again
                re-rolls a fresh sample. Percentages are computed off
                the filtered set, so "25% of my ES days" works as
                expected when an instrument filter is active. */}
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider ml-1">
              or
            </span>
            {[5, 10, 25, 50].map((pct) => {
              const count = Math.max(
                1,
                Math.ceil(filteredSessions.length * (pct / 100))
              );
              return (
                <button
                  key={pct}
                  onClick={() => pickRandom(count)}
                  disabled={filteredSessions.length === 0}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    filteredSessions.length === 0
                      ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                      : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                  title={`Pick ${count} session${count === 1 ? "" : "s"} (${pct}% of ${filteredSessions.length})`}
                >
                  {pct}% ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Walk-forward row — pick a contiguous chronological slice and
            slide it forward one step at a time. Classic walk-forward
            analysis: train on slice 1, test on slice 2, etc., to see
            how a strategy holds up out-of-sample over time.
            Window is the slice size; Step is how many days each ←/→
            click advances. The position indicator shows which slice
            is currently active relative to the full dataset. */}
        {sessions.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">
              Walk Fwd
            </span>
            <label className="flex items-center gap-1.5" title="Days per window">
              <span className="text-xs text-muted-foreground">Window</span>
              <input
                type="number"
                min={1}
                max={sessionsChrono.length || 1}
                value={walkForwardWindow}
                onChange={(e) =>
                  setWalkForwardWindow(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                aria-label="Walk-forward window size"
              />
            </label>
            <label className="flex items-center gap-1.5" title="Days each Next/Prev advances by">
              <span className="text-xs text-muted-foreground">Step</span>
              <input
                type="number"
                min={1}
                max={sessionsChrono.length || 1}
                value={walkForwardStep}
                onChange={(e) =>
                  setWalkForwardStep(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                aria-label="Walk-forward step size"
              />
            </label>

            {/* Reset / Start: snap the window back to the first N days. */}
            <button
              onClick={() => applyWalkForwardWindow(0)}
              className="px-2 py-1 rounded text-xs font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
              title="Jump to the first window (oldest N days)"
            >
              Start
            </button>

            {/* Prev / Next: slide the window by one step in either
                direction. Prev disables at start of dataset; Next
                disables when the window would run past the end. */}
            <button
              onClick={() =>
                applyWalkForwardWindow(walkForwardStart - Math.max(1, walkForwardStep))
              }
              disabled={!canWfPrev}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                canWfPrev
                  ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
              }`}
              title={`Slide back ${Math.max(1, walkForwardStep)} day${walkForwardStep === 1 ? "" : "s"}`}
            >
              ← Prev
            </button>
            <button
              onClick={() =>
                applyWalkForwardWindow(walkForwardStart + Math.max(1, walkForwardStep))
              }
              disabled={!canWfNext}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                canWfNext
                  ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                  : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
              }`}
              title={`Advance ${Math.max(1, walkForwardStep)} day${walkForwardStep === 1 ? "" : "s"} forward`}
            >
              Next →
            </button>

            {/* Position indicator — only visible once the user has
                applied a walk-forward window at least once. Format:
                "Days 11–20 of 60". Index labels are 1-based for human
                readability (vs the 0-based walkForwardStart state). */}
            {selectedSessionIds.size > 0 && (
              <span className="text-xs text-muted-foreground">
                Days {walkForwardStart + 1}–{wfWindowEnd} of {sessionsChrono.length}
              </span>
            )}
          </div>
        )}

        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No downloaded sessions yet. Use the Practice Trading page to request data first.
          </p>
        ) : filteredSessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions match the current filters. Try clearing the asset or
            timeframe filter above.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {filteredSessions.map((s) => {
              const active = selectedSessionIds.has(s.id);
              const loading = loadingSessionIds.has(s.id);
              const ready = barsBySessionId.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => toggleSession(s.id)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-2 ${
                    active
                      ? "bg-accent-green/20 text-accent-green"
                      : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                  title={`${s.instrument} — ${s.timeframe} — ${s.bar_count} bars`}
                >
                  <span>{formatDate(s.session_date)}</span>
                  <span className="text-[10px] opacity-70">{s.instrument}</span>
                  {/* Granularity chip — call out tick-derived sessions so
                      the user knows which rows route through the in-browser
                      aggregation path (and respect the timeframe selector
                      above the strategy panel). Plain ohlcv rows get no
                      chip to keep the chip grid uncluttered. */}
                  {(s.granularity === "tick" ||
                    s.granularity === "tick_bidask" ||
                    s.granularity === "ohlcv_bidask") && (
                    <span
                      className={`text-[9px] px-1 py-px rounded uppercase tracking-wider font-semibold ${
                        active
                          ? "bg-accent-green/30 text-accent-green"
                          : "bg-white/10 text-muted-foreground"
                      }`}
                      title={`Source granularity: ${s.granularity}`}
                    >
                      {s.granularity === "tick"
                        ? "tick"
                        : s.granularity === "tick_bidask"
                          ? "tick+ba"
                          : "ohlcv+ba"}
                    </span>
                  )}
                  {/* Loading dot — only when this specific session is fetching */}
                  {loading && (
                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {/* Ready dot — selected and bars in cache */}
                  {active && ready && !loading && (
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
                  )}
                </button>
              );
            })}
          </div>
        )}
        {fetchError && (
          <p className="text-xs text-accent-red mt-3">⚠ {fetchError}</p>
        )}
      </div>

      {/* ── Tick aggregation timeframe ─────────────────────────────────
          Visible only when at least one selected session is tick or
          tick_bidask. The bar fetcher routes those sessions through
          aggregateTicks() at this period; OHLCV sessions ignore it.
          Chips cover the common cases; the custom field accepts any
          positive seconds value (1s..3600s). Changing the timeframe
          evicts cached tick-derived bars and re-aggregates from the
          ParsedTicks cache (~50ms, no network). */}
      {hasTickSession && (
        <div className="bg-card border border-card-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
              Tick Aggregation
            </h3>
            <span className="text-[10px] text-muted-foreground">
              Bar period · current {aggregationTimeframeSec}s
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { label: "15s", sec: 15 },
              { label: "30s", sec: 30 },
              { label: "1m", sec: 60 },
              { label: "5m", sec: 300 },
              { label: "15m", sec: 900 },
            ].map((chip) => {
              const isActive = aggregationTimeframeSec === chip.sec;
              return (
                <button
                  key={chip.sec}
                  onClick={() => setAggregationTimeframeSec(chip.sec)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-accent-green/20 text-accent-green"
                      : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                  title={`Aggregate ticks into ${chip.label} bars`}
                >
                  {chip.label}
                </button>
              );
            })}
            <label className="flex items-center gap-1.5 ml-2" title="Custom bar period in seconds">
              <span className="text-xs text-muted-foreground">Custom</span>
              <input
                type="number"
                min={1}
                max={3600}
                step={1}
                value={aggregationTimeframeSec}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(3600, Number(e.target.value) || 1));
                  setAggregationTimeframeSec(n);
                }}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                aria-label="Custom aggregation seconds"
              />
              <span className="text-xs text-muted-foreground">s</span>
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Tick / tick+ba sessions are aggregated to bars at this period.
            Plain OHLCV sessions ignore this setting.
          </p>
        </div>
      )}

      {/* Script-strategy panel — only renders when the script contains
          `signal.long.if = …` / `signal.short.if = …` statements OR
          `params.X` references. Lets users author from scratch without
          using the dropdown, and load any builtin template as a starting
          point. Sits ABOVE the legacy panel so when active it's the
          first thing the user sees. */}
      <BacktestScriptStrategyPanel
        scriptText={scriptText}
        scriptParams={scriptParams}
        paramMeta={scriptParamMeta}
        onParamChange={(key, value) =>
          setScriptParams((prev) => ({ ...prev, [key]: value }))
        }
        onLoadTemplate={(tpl: StrategyTemplate) => {
          // Prepend the template's script with a separator so any
          // existing rules/filters lines below remain. Most users start
          // empty so this just installs the template.
          const sep = scriptText.trim() === "" ? "" : `\n\n// ── existing script preserved below ──\n`;
          setScriptText(tpl.script + sep + scriptText);
          // Seed paramMeta + scriptParams with the template's defaults.
          // The user's previously-tuned scriptParams for matching keys
          // are preserved (preference > template default).
          setScriptParamMeta((prev) => ({ ...tpl.paramMeta, ...prev }));
          setScriptParams((prev) => {
            const next = { ...prev };
            for (const [k, m] of Object.entries(tpl.paramMeta)) {
              if (next[k] === undefined) next[k] = m.default;
            }
            return next;
          });
        }}
      />

      {/* All click-through configuration — strategy picker, parameter
          editor, time filter, context filters, and SimRules — only render
          in UI mode. In script mode the editor on the right is the single
          source of truth, so showing these controls would let users
          accidentally tweak values that the script then silently
          overrides on the next Apply. Day picker / results / exports
          live OUTSIDE this gate because they're not configuration. */}
      {mode === "ui" && (
      <>
      {/* ── Strategy picker + parameter editor ───────────────────────
          Strategy dropdown drives which paramFields render below it. Each
          field is a labeled numeric input; reset button restores defaults
          for the current strategy. Inputs are uncontrolled with a 150ms
          debounce so typing stays smooth. */}
      <div className="bg-card border border-card-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
            Strategy
          </h3>
          <button
            onClick={resetParams}
            className="px-2 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            Reset Defaults
          </button>
        </div>
        <select
          value={strategyId}
          onChange={(e) => setStrategyId(e.target.value)}
          className="w-full bg-card border border-card-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green mb-2"
        >
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground mb-3">{currentStrategy.description}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {currentStrategy.paramFields.map((field) => {
            // The `key` prop tied to strategyId AND paramsVersion forces
            // the uncontrolled input to remount when the user switches
            // strategies OR when an optimizer mutates this value, so the
            // displayed defaultValue stays in sync with state.
            const value = params[field.key] ?? field.default;
            const isOptimizingThis = optimizingParamKey === field.key;
            const optDisabled =
              (optimizingParamKey !== null && !isOptimizingThis) ||
              selectedSessionIds.size === 0 ||
              loadingCount > 0;
            return (
              <label
                key={`${strategyId}.${field.key}.${paramsVersion}`}
                className="flex flex-col gap-1"
                title={field.description}
              >
                <span className="text-xs text-muted-foreground">{field.label}</span>
                <div className="flex items-stretch gap-1.5">
                  <input
                    type="number"
                    defaultValue={value}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      handleParamChange(field.key, Number.isFinite(n) ? n : field.default);
                    }}
                    className="flex-1 min-w-0 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                  />
                  {/* Per-param OPT button. Sweeps [field.min, field.max] in
                      step increments, holds every other param at its
                      current value, and applies the value with the highest
                      total scaledPoints. Click again mid-run to cancel
                      (applies best-so-far). Tooltip surfaces the live
                      progress percentage when running. */}
                  <button
                    onClick={() => handleOptimizeParam(field)}
                    disabled={optDisabled}
                    title={
                      isOptimizingThis
                        ? `Optimizing ${field.label}... ${optimizeParamProgress !== null ? `${Math.round(optimizeParamProgress * 100)}%` : ""}\nClick to cancel and apply best-so-far.`
                        : selectedSessionIds.size === 0
                          ? "Select at least one downloaded day to enable per-param optimization."
                          : `Sweep ${field.label} across [${field.min}, ${field.max}] step ${field.step} and pick the value with the highest total points.`
                    }
                    className={`px-2 rounded-md text-[10px] font-bold tracking-wider transition-colors whitespace-nowrap ${
                      isOptimizingThis
                        ? "bg-accent-green/30 text-accent-green"
                        : optDisabled
                          ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                          : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                    }`}
                  >
                    {isOptimizingThis
                      ? optimizeParamProgress !== null
                        ? `${Math.round(optimizeParamProgress * 100)}%`
                        : "..."
                      : "OPT"}
                  </button>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* ── Time-of-day filter ──────────────────────────────────────
          Same control bar pattern as the risk simulator: a master toggle,
          an OPTIMIZE TIME button (opens a min-window modal), and the two
          time inputs (only shown when the filter is on). The filter
          narrows the synthetic zones produced by the strategy generator
          BEFORE they hit the simulator + optimizers. */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setTimeFilterEnabled(!timeFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            timeFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {timeFilterEnabled ? "TIME FILTER ON" : "TIME FILTER OFF"}
        </button>

        {/* OPTIMIZE TIME — opens the min-window modal, then runs the time
            optimizer. While running, clicking again cancels via timeCancelRef.
            Disabled until at least one synthetic zone has been produced. */}
        <button
          onClick={
            optimizingTime
              ? () => {
                  timeCancelRef.current = true;
                }
              : () => setShowTimeOptModal(true)
          }
          disabled={runResult.syntheticZones.length === 0 || optimizing || optimizingAtr}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            optimizingTime
              ? "bg-accent-green/20 text-accent-green"
              : runResult.syntheticZones.length === 0 || optimizing || optimizingAtr
                ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
          }`}
        >
          {optimizingTime
            ? `OPTIMIZING TIME ${optimizeTimeProgress !== null ? `${Math.round(optimizeTimeProgress * 100)}%` : "..."}`
            : "OPTIMIZE TIME"}
        </button>

        {/* Export buttons used to live here; they were extracted to a
            standalone row that renders in BOTH UI and Script mode (see
            below the rules section), so script-mode users can still
            export their backtest results. */}

        {timeFilterEnabled && (
          <>
            {/* Each window is editable + removable; the "+ Add window"
                button appends a new row. Bars pass when their time falls
                in ANY window (OR semantics). The last surviving window
                CAN be removed — clicking remove on the only row leaves
                the windows list empty, which short-circuits the time
                filter to a no-op (functionally identical to disabling
                the filter, but keeps the master toggle's intent). */}
            {timeWindows.map((w, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1.5 bg-card/40 border border-card-border rounded-md pl-2 pr-1 py-0.5"
              >
                <label className="text-xs text-muted-foreground">From</label>
                <input
                  type="time"
                  value={w.from}
                  onChange={(e) =>
                    setTimeWindows((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], from: e.target.value };
                      return next;
                    })
                  }
                  className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                />
                <label className="text-xs text-muted-foreground">To</label>
                <input
                  type="time"
                  value={w.to}
                  onChange={(e) =>
                    setTimeWindows((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], to: e.target.value };
                      return next;
                    })
                  }
                  className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                />
                <button
                  onClick={() =>
                    setTimeWindows((prev) => prev.filter((_, i) => i !== idx))
                  }
                  className="px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-white/10"
                  title="Remove this window"
                  aria-label="Remove window"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setTimeWindows((prev) => [
                  ...prev,
                  // Default a new window to the latest one's `to` as the
                  // start so users typing two consecutive sessions just
                  // adjust the end time. If there are no windows yet, fall
                  // back to a sensible RTH afternoon default.
                  prev.length > 0
                    ? { from: prev[prev.length - 1].to, to: "16:00" }
                    : { from: "09:30", to: "16:00" },
                ])
              }
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              title="Add another time window — passes are OR'd"
            >
              + Add window
            </button>
            <span className="text-xs text-muted-foreground">
              {timeFilteredZones.length} of {runResult.syntheticZones.length} signals
            </span>
          </>
        )}
      </div>

      {/* ── Context filters — read ctx_* fields the backtest engine
            stamps onto each synthetic zone at signal entry. Same UX as
            the risk simulator's filter bars: independent toggles, an
            OPTIMIZE button per filter (worker-backed, runs in
            background tabs), and per-filter inputs that appear when the
            toggle is on. All four AND together and apply BEFORE the
            time filter so optimizers downstream respect them. */}

      {/* ADX range filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setAdxFilterEnabled(!adxFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            adxFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {adxFilterEnabled ? "ADX FILTER ON" : "ADX FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeAdx}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep ADX min/max ranges, keep the one with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {adxFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min</label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={adxMin}
                onChange={(e) => setAdxMin(Number(e.target.value))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max</label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={adxMax}
                onChange={(e) => setAdxMax(Number(e.target.value))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <input
                type="number"
                min={2}
                max={200}
                step={1}
                value={adxPeriod}
                onChange={(e) => setAdxPeriod(Math.max(2, Number(e.target.value) || 14))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              ADX({adxPeriod}) at entry — higher = trending, lower = choppy
            </span>
          </>
        )}
      </div>

      {/* ATR range filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setAtrFilterEnabled(!atrFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            atrFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {atrFilterEnabled ? "ATR FILTER ON" : "ATR FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeAtr}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep ATR min/max ranges, keep the one with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {atrFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={atrMin}
                onChange={(e) => setAtrMin(Number(e.target.value))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={atrMax}
                onChange={(e) => setAtrMax(Number(e.target.value))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <input
                type="number"
                min={2}
                max={200}
                step={1}
                value={atrPeriod}
                onChange={(e) => setAtrPeriod(Math.max(2, Number(e.target.value) || 14))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="Wilder ATR period — drives this filter AND the ± ATR adjust math on SL/TP/Trail/BE."
              />
            </div>
            <span className="text-xs text-muted-foreground">
              ATR({atrPeriod}) at entry, in points
            </span>
          </>
        )}
      </div>

      {/* Trend-alignment filter (price vs EMA20 / EMA200) */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setTrendFilterEnabled(!trendFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            trendFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {trendFilterEnabled ? "TREND FILTER ON" : "TREND FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeTrend}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Try all 9 combinations of EMA20 × EMA200 modes, keep the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {trendFilterEnabled && (
          <>
            {/* Fast leg — type + period drive ctx_ema20 / ctx_price_vs_ema20 */}
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Fast</label>
              <select
                value={trendFastType}
                onChange={(e) => setTrendFastType(e.target.value as MaType)}
                className="bg-card border border-card-border rounded-md px-1.5 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="EMA reacts faster; SMA gives equal weight."
              >
                <option value="ema">EMA</option>
                <option value="sma">SMA</option>
              </select>
              <input
                type="number"
                min={2}
                max={500}
                step={1}
                value={trendFastPeriod}
                onChange={(e) =>
                  setTrendFastPeriod(Math.max(2, Number(e.target.value) || 20))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="Period of the fast trend MA"
              />
              <select
                value={ema20Mode}
                onChange={(e) => setEma20Mode(e.target.value as TrendMode)}
                className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              >
                <option value="any">Any</option>
                <option value="with">With trend</option>
                <option value="against">Against trend</option>
              </select>
            </div>
            {/* Slow leg — type + period drive ctx_ema200 / ctx_price_vs_ema200 */}
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Slow</label>
              <select
                value={trendSlowType}
                onChange={(e) => setTrendSlowType(e.target.value as MaType)}
                className="bg-card border border-card-border rounded-md px-1.5 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              >
                <option value="ema">EMA</option>
                <option value="sma">SMA</option>
              </select>
              <input
                type="number"
                min={2}
                max={1000}
                step={1}
                value={trendSlowPeriod}
                onChange={(e) =>
                  setTrendSlowPeriod(Math.max(2, Number(e.target.value) || 200))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="Period of the slow trend MA"
              />
              <select
                value={ema200Mode}
                onChange={(e) => setEma200Mode(e.target.value as TrendMode)}
                className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              >
                <option value="any">Any</option>
                <option value="with">With trend</option>
                <option value="against">Against trend</option>
              </select>
            </div>
            <span className="text-xs text-muted-foreground">
              With = long above MA / short below
            </span>
          </>
        )}
      </div>

      {/* Bollinger position filter (multi-select chips) */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setBollingerFilterEnabled(!bollingerFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            bollingerFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {bollingerFilterEnabled ? "BOLLINGER FILTER ON" : "BOLLINGER FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeBollinger}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Try all 7 non-empty subsets of Bollinger positions, keep the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {bollingerFilterEnabled && (
          <>
            {[
              { value: "above_upper", label: "Above upper" },
              { value: "inside", label: "Inside" },
              { value: "below_lower", label: "Below lower" },
            ].map((opt) => {
              const active = bollingerAllowed.has(opt.value);
              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    setBollingerAllowed((prev) => {
                      const next = new Set(prev);
                      if (next.has(opt.value)) next.delete(opt.value);
                      else next.add(opt.value);
                      return next;
                    });
                  }}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    active
                      ? "bg-accent-green/20 text-accent-green"
                      : "bg-white/5 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <input
                type="number"
                min={2}
                max={500}
                step={1}
                value={bollingerPeriod}
                onChange={(e) =>
                  setBollingerPeriod(Math.max(2, Number(e.target.value) || 20))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">σ × </label>
              <input
                type="number"
                min={0.5}
                max={5}
                step={0.1}
                value={bollingerStdDev}
                onChange={(e) =>
                  setBollingerStdDev(Math.max(0.1, Number(e.target.value) || 2))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              price vs {bollingerPeriod}-SMA ± {bollingerStdDev}σ at entry
            </span>
          </>
        )}
      </div>

      {/* BB band-width range filter — uses the same period+stdDev as
          the bollinger position filter above so users tune one set. */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setBbWidthFilterEnabled(!bbWidthFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            bbWidthFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {bbWidthFilterEnabled ? "BB WIDTH FILTER ON" : "BB WIDTH FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeBbWidth}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep band-width percentile bins, keep the range with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {bbWidthFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min</label>
              <input
                type="number"
                min={0}
                step={0.25}
                value={bbWidthMin}
                onChange={(e) => setBbWidthMin(Number(e.target.value))}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max</label>
              <input
                type="number"
                min={0}
                step={0.25}
                value={bbWidthMax}
                onChange={(e) => setBbWidthMax(Number(e.target.value))}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              upper − lower band, in price points (uses BB period/stdDev above)
            </span>
          </>
        )}
      </div>

      {/* MA distance filter — distance from a configurable MA, in ATR units */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setMaDistanceFilterEnabled(!maDistanceFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            maDistanceFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {maDistanceFilterEnabled ? "MA DIST FILTER ON" : "MA DIST FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeMaDistance}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep |distance|/above/below modes × ATR-unit bins, keep the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {maDistanceFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <select
                value={maDistanceType}
                onChange={(e) => setMaDistanceType(e.target.value as MaType)}
                className="bg-card border border-card-border rounded-md px-1.5 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              >
                <option value="ema">EMA</option>
                <option value="sma">SMA</option>
              </select>
              <input
                type="number"
                min={2}
                max={1000}
                step={1}
                value={maDistancePeriod}
                onChange={(e) =>
                  setMaDistancePeriod(Math.max(2, Number(e.target.value) || 50))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="MA period"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Mode</label>
              <select
                value={maDistanceMode}
                onChange={(e) =>
                  setMaDistanceMode(e.target.value as MaDistanceMode)
                }
                className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="absolute = |distance| in [min, max]; above/below = price must be on that side."
              >
                <option value="absolute">|distance|</option>
                <option value="above">above MA</option>
                <option value="below">below MA</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min</label>
              <input
                type="number"
                min={0}
                max={50}
                step={0.05}
                value={maDistanceMin}
                onChange={(e) => setMaDistanceMin(Number(e.target.value))}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max</label>
              <input
                type="number"
                min={0}
                max={50}
                step={0.05}
                value={maDistanceMax}
                onChange={(e) => setMaDistanceMax(Number(e.target.value))}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              distance from {maDistanceType.toUpperCase()}({maDistancePeriod}), in ATR({atrPeriod}) units
            </span>
          </>
        )}
      </div>

      {/* Volume ratio filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setVolumeFilterEnabled(!volumeFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            volumeFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {volumeFilterEnabled ? "VOLUME FILTER ON" : "VOLUME FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeVolume}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep volume-ratio bins, keep the range with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {volumeFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <input
                type="number"
                min={2}
                max={500}
                step={1}
                value={volumeMaPeriod}
                onChange={(e) =>
                  setVolumeMaPeriod(Math.max(2, Number(e.target.value) || 20))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="N-bar lookback for the volume average."
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min ratio</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.05}
                value={volumeMinRatio}
                onChange={(e) => setVolumeMinRatio(Number(e.target.value))}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max ratio</label>
              <input
                type="number"
                min={0}
                max={1000}
                step={0.05}
                value={volumeMaxRatio}
                onChange={(e) => setVolumeMaxRatio(Number(e.target.value))}
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              entry-bar volume / {volumeMaPeriod}-bar avg
            </span>
          </>
        )}
      </div>

      {/* RSI range filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setRsiFilterEnabled(!rsiFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            rsiFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {rsiFilterEnabled ? "RSI FILTER ON" : "RSI FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeRsi}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep RSI min/max bins, keep the range with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {rsiFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min</label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={rsiMin}
                onChange={(e) => setRsiMin(Number(e.target.value))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max</label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={rsiMax}
                onChange={(e) => setRsiMax(Number(e.target.value))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <input
                type="number"
                min={2}
                max={200}
                step={1}
                value={rsiPeriod}
                onChange={(e) => setRsiPeriod(Math.max(2, Number(e.target.value) || 14))}
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              RSI({rsiPeriod}) at entry — &lt;30 oversold / &gt;70 overbought
            </span>
          </>
        )}
      </div>

      {/* ADX direction filter — gates on rising/falling/flat ADX slope */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setAdxTrendFilterEnabled(!adxTrendFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            adxTrendFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
        >
          {adxTrendFilterEnabled ? "ADX DIR FILTER ON" : "ADX DIR FILTER OFF"}
        </button>
        <button
          onClick={runOptimizeAdxTrend}
          disabled={runResult.syntheticZones.length === 0 || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Try rising/falling/flat at several flat-threshold values, keep the best avg points/trade (min 20 trades). Respects other active filters."
        >
          {contextOptimizing ? "OPTIMIZING..." : "OPTIMIZE"}
        </button>
        {adxTrendFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Mode</label>
              <select
                value={adxTrendMode}
                onChange={(e) =>
                  setAdxTrendMode(e.target.value as AdxTrendMode)
                }
                className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              >
                <option value="any">Any</option>
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
                <option value="flat">Flat</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Lookback</label>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={adxTrendLookback}
                onChange={(e) =>
                  setAdxTrendLookback(Math.max(1, Number(e.target.value) || 5))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="Bars looked back when computing ADX slope. Changing this re-runs the backtest."
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Flat thresh</label>
              <input
                type="number"
                min={0}
                max={50}
                step={0.1}
                value={adxTrendFlatThreshold}
                onChange={(e) =>
                  setAdxTrendFlatThreshold(Number(e.target.value))
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="|slope| ≤ this is flat. Wider band → tighter rising/falling gates."
              />
            </div>
            <span className="text-xs text-muted-foreground">
              ADX slope over last {adxTrendLookback} bar{adxTrendLookback === 1 ? "" : "s"}
            </span>
          </>
        )}
      </div>

      {/* Bid/ask delta-imbalance filter — gates on (ask − bid) / (ask + bid)
          at the entry bar. Only meaningful for sessions whose source bars
          carry a bid/ask split (tick / tick_bidask after aggregation, or
          ohlcv_bidask). Plain ohlcv sessions reject every trade when this
          is on — deliberate fail-closed default for a knob whose data
          isn't present. */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setDeltaFilterEnabled(!deltaFilterEnabled)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            deltaFilterEnabled
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground"
          }`}
          title="Gate on bid/ask delta imbalance at entry. Requires tick / tick_bidask / ohlcv_bidask source data."
        >
          {deltaFilterEnabled ? "DELTA FILTER ON" : "DELTA FILTER OFF"}
        </button>
        {deltaFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Min</label>
              <input
                type="number"
                min={-1}
                max={1}
                step={0.05}
                value={deltaMin}
                onChange={(e) =>
                  setDeltaMin(Math.max(-1, Math.min(1, Number(e.target.value))))
                }
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="Lower bound. -1 = pure sell-aggressor, 0 = balanced, +1 = pure buy-aggressor."
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Max</label>
              <input
                type="number"
                min={-1}
                max={1}
                step={0.05}
                value={deltaMax}
                onChange={(e) =>
                  setDeltaMax(Math.max(-1, Math.min(1, Number(e.target.value))))
                }
                className="w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                title="Upper bound."
              />
            </div>
            <span className="text-xs text-muted-foreground">
              (ask − bid) / (ask + bid) ∈ [{deltaMin.toFixed(2)}, {deltaMax.toFixed(2)}]
            </span>
          </>
        )}
      </div>

      {/* Total context-filtered count — only visible when any context
          filter is active, so users see exactly how many signals
          survived BEFORE the time filter narrows further. */}
      {(adxFilterEnabled ||
        atrFilterEnabled ||
        trendFilterEnabled ||
        bollingerFilterEnabled ||
        bbWidthFilterEnabled ||
        maDistanceFilterEnabled ||
        volumeFilterEnabled ||
        rsiFilterEnabled ||
        (adxTrendFilterEnabled && adxTrendMode !== "any") ||
        deltaFilterEnabled) && (
        <div className="text-xs text-muted-foreground">
          {contextFilteredZones.length} of {runResult.syntheticZones.length} signals pass context filters
        </div>
      )}

      {/* ── Sim rules (SL/TP/Trail/BE/Timer/Scaling/Position-mode) ──
          Identical control panel to the risk simulator. Optimizer buttons
          run the same chunked grid search against this tab's synthetic-zone
          backtest results. `key={rulesVersion}` forces a remount so the
          uncontrolled inputs reflect new values after an optimizer merge. */}
      <SimulatorControls
        key={rulesVersion}
        rules={rules}
        onRulesChange={setRules}
        onOptimize={openOptimizeModal}
        optimizing={optimizing}
        optimizeProgress={optimizeProgress}
        onOptimizeAtr={openOptimizeAtrModal}
        optimizingAtr={optimizingAtr}
        optimizeAtrProgress={optimizeAtrProgress}
      />
      </>
      )}

      {/* ── Exports row — visible in BOTH modes ─────────────────────
          The export buttons used to live inside the time filter row, but
          they're about RESULTS (current trade list) not config, so they
          stay visible in script mode too. Buttons disable themselves when
          there are no trades to write so users get visual feedback that
          they need to run a backtest first. */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleExportCsv}
          disabled={trades.length === 0}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            trades.length > 0
              ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
          }`}
        >
          EXPORT CSV
        </button>
        <button
          onClick={() => setShowExportDetailedModal(true)}
          disabled={trades.length === 0}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            trades.length > 0
              ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
          }`}
          title="Download a detailed JSON bundle (trades + bars + levels) for AI pattern analysis"
        >
          EXPORT FOR AI
        </button>
        {/* Composite winning trade — stacks every winner from the current
            backtest onto a normalized timeline and shows the "perfect trade"
            shape (median + percentile envelope). Disabled until trades exist
            so users don't open it on an empty backtest. */}
        <button
          onClick={() => setShowCompositeTrade((v) => !v)}
          disabled={trades.length === 0}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            trades.length === 0
              ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
              : showCompositeTrade
                ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
          }`}
          title="Stack every winning trade onto a normalized timeline and see the median 'perfect trade' shape"
        >
          {showCompositeTrade ? "HIDE COMPOSITE TRADE" : "COMPOSITE WINNER"}
        </button>
        {/* Composite candlestick view — averages OHLC bar-by-bar and
            renders separate long/short candle charts via lightweight-charts.
            Independent of the line-curve composite above, so users can
            open one, the other, or both. */}
        <button
          onClick={() => setShowCompositeBars((v) => !v)}
          disabled={trades.length === 0}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            trades.length === 0
              ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
              : showCompositeBars
                ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
          }`}
          title="Average winners' OHLC bar-by-bar and render long/short composite candle charts"
        >
          {showCompositeBars ? "HIDE COMPOSITE BARS" : "COMPOSITE BARS"}
        </button>
      </div>

      {/* ── Run banner — quick summary of selected days + signal count ── */}
      <div className="bg-card border border-card-border rounded-lg p-3 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {selectedSessionIds.size === 0
            ? "Select one or more days above to run the backtest."
            : `${selectedSessionIds.size} session${selectedSessionIds.size === 1 ? "" : "s"} selected · ${runResult.totalSignals} signal${runResult.totalSignals === 1 ? "" : "s"} fired · ${trades.length} trade${trades.length === 1 ? "" : "s"} simulated`}
        </span>
        {loadingCount > 0 && (
          <span className="text-xs text-muted-foreground flex items-center gap-2">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading bars for {loadingCount} session{loadingCount === 1 ? "" : "s"}...
          </span>
        )}
      </div>

      {/* ── Results — same components as the risk simulator ──────────
          When no trades are produced, these all render as no-ops (each
          component returns null on empty input), so the screen quietly stays
          on the run banner above. */}
      <ZoneEquityCurve
        data={equityCurveData}
        showSimulated={true}
        showOriginal={false}
        mode={displayMode}
      />

      {/* Equity-curve action row — Monte Carlo horizon buttons on the
          left, Points/Dollars unit toggle on the right. Both sit
          directly under the equity curve so the controls that affect
          everything below are clustered. */}
      <div className="flex items-center justify-between gap-2 -mt-2 flex-wrap">
        {/* ── Monte Carlo horizon buttons ─────────────────────────────
            Click any horizon to bootstrap-resample the current trade
            results into a projected equity curve at that timeframe.
            Disabled when there are no trades to sample from. While a
            run is in flight the active horizon shows "RUNNING…" so the
            click feels acknowledged before the bootstrap finishes. */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Monte Carlo:
          </span>
          {(["1W", "1M", "1Y"] as MonteCarloHorizon[]).map((horizon) => {
            const running = monteCarloRunning === horizon;
            const active = monteCarloResult?.horizon === horizon && !monteCarloRunning;
            return (
              <button
                key={horizon}
                type="button"
                onClick={() => handleRunMonteCarlo(horizon)}
                disabled={trades.length === 0 || monteCarloRunning !== null}
                className={`px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? "bg-sky-500 text-white border-sky-500"
                    : "bg-card text-muted-foreground border-card-border hover:text-foreground hover:border-foreground"
                }`}
                title={
                  trades.length === 0
                    ? "Run a backtest first — Monte Carlo resamples your historical trades."
                    : `Resample ${trades.length} historical trades into a projected ${horizon === "1W" ? "1-week" : horizon === "1M" ? "1-month" : "1-year"} equity curve.`
                }
              >
                {running ? "RUNNING…" : horizon}
              </button>
            );
          })}
        </div>
        {/* Points / Dollars toggle — controls the unit for the equity curve
            above and every metric in the SimulatorStatCards below. */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Display:</span>
          <div className="inline-flex rounded-md border border-card-border bg-card overflow-hidden">
            <button
              type="button"
              onClick={() => setDisplayMode("points")}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                displayMode === "points"
                  ? "bg-sky-500 text-white"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Points
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode("dollars")}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                displayMode === "dollars"
                  ? "bg-sky-500 text-white"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Dollars
            </button>
          </div>
        </div>
      </div>

      {/* ── Monte Carlo projection chart ──
          Renders only when the user has clicked a horizon button. Shows
          the median path with 5–95 / 25–75 confidence bands plus a row
          of stat tiles (% profitable, median final, drawdown, etc.). */}
      {monteCarloResult && (
        <MonteCarloCurve
          result={monteCarloResult}
          onDismiss={() => setMonteCarloResult(null)}
        />
      )}

      {/* ── Composite winning trade ──
          Inserts the "perfect trade" composite right after the equity curve,
          so the user is reading top-down: cumulative P&L → typical-winner
          shape → per-trade table. Only mounts when the toggle is on, so the
          chart cost (and the spaghetti render) is fully on-demand. */}
      {showCompositeTrade && compositeTrade && (
        <CompositeTradeChart
          composite={compositeTrade}
          onClose={() => setShowCompositeTrade(false)}
        />
      )}

      {/* ── Composite candlestick bars (long + short) ──
          Sibling of the line-curve composite — averages OHLC per bar
          and renders TradingView-style candlesticks for each direction. */}
      {showCompositeBars && compositeBars && (
        <CompositeBarsChart
          composite={compositeBars}
          onClose={() => setShowCompositeBars(false)}
        />
      )}

      <SimulatorStatCards summary={summary} mode={displayMode} />
      <SimulatorResultsChart results={trades} />
      <SimulatorResultsByDayChart results={trades} />
      <SimulatorTable
        results={trades}
        zones={timeFilteredZones}
        barsByZoneId={runResult.syntheticBarsByZoneId}
        rules={rules}
      />

      {/* Bivariate heatmap — pick any two of the segment-analysis dimensions
          and see joint P&L distribution across their buckets. Useful for
          spotting "edge only when X AND Y" combinations the per-axis
          histograms can't surface. */}
      <SimulatorHeatmap
        results={trades}
        zones={timeFilteredZones}
        barsByZoneId={runResult.syntheticBarsByZoneId}
        preEntryBarsByZoneId={runResult.syntheticPreEntryBarsByZoneId}
        atrByZoneId={runResult.syntheticAtrByZoneId}
        scalingEnabled={rules.scalingEnabled}
      />

      {/* Segment-analysis histograms — group results by ADX/ATR/EMA/Bollinger
          /volume/RSI/time-of-day/MAE/MFE/etc. Each continuous chart has an
          inline bucket-count input so users can re-bin live. Reads ctx_*
          fields off the synthetic zones plus the per-zone bar / atr / pre-entry
          maps the backtest engine emits. */}
      <SimulatorSegmentCharts
        results={trades}
        zones={timeFilteredZones}
        barsByZoneId={runResult.syntheticBarsByZoneId}
        preEntryBarsByZoneId={runResult.syntheticPreEntryBarsByZoneId}
        atrByZoneId={runResult.syntheticAtrByZoneId}
        scalingEnabled={rules.scalingEnabled}
      />

      {/* ── Optimize SL/TP/TSL Config Modal ─────────────────────────
          Same modal the risk simulator uses. Lets the user constrain
          ranges, lock SL:TP ratio, or disable hard SL before kicking off
          the grid search. */}
      {showOptimizeConfigModal && (
        <OptimizeConfigModal
          config={optimizeConfig}
          onChange={setOptimizeConfig}
          onClose={() => setShowOptimizeConfigModal(false)}
          onRun={runOptimizeNow}
        />
      )}

      {/* ── Optimize ATR Adjust Config Modal ────────────────────────
          Mirrors the SL/TP/TSL modal — keeps base SL/TP/Trail values frozen
          and grids over the per-rule ATR adjustments only. */}
      {showOptimizeAtrConfigModal && (
        <OptimizeAtrConfigModal
          config={optimizeAtrConfig}
          onChange={setOptimizeAtrConfig}
          onClose={() => setShowOptimizeAtrConfigModal(false)}
          onRun={runOptimizeAtrNow}
        />
      )}

      {/* ── Time Optimize Modal — pick min window before sweep ──────
          Same min-window options as the risk simulator's modal.
          Selecting a value kicks off the optimizer and closes the modal. */}
      {showTimeOptModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowTimeOptModal(false)}
        >
          <div
            className="bg-card border border-card-border rounded-lg p-6 w-full max-w-sm shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-foreground">Optimize Time</h3>
              <button
                onClick={() => setShowTimeOptModal(false)}
                className="text-muted-foreground hover:text-foreground text-xl leading-none"
              >
                &times;
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Select the minimum window size. The optimizer will find the best
              time-of-day window (by avg points/trade) at least this wide.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "30 min", value: 30 },
                { label: "1 hour", value: 60 },
                { label: "2 hours", value: 120 },
                { label: "3 hours", value: 180 },
                { label: "4 hours", value: 240 },
                { label: "6 hours", value: 360 },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleOptimizeTime(opt.value)}
                  className="px-3 py-2 rounded-md text-sm font-medium bg-white/5 text-foreground hover:bg-accent-green/20 hover:text-accent-green transition-colors"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Export For AI Modal ─────────────────────────────────────
          Same modal the risk simulator uses. Lets the user pick how
          many pre-entry bars to bundle per trade before triggering the
          JSON download. */}
      {showExportDetailedModal && (
        <ExportDetailedModal
          tradeCount={trades.length}
          maxPreEntryBars={MAX_PRE_ENTRY_BARS}
          defaultPreEntryBars={20}
          onClose={() => setShowExportDetailedModal(false)}
          onExport={handleExportDetailed}
          onExportNt8Csv={handleExportNt8Csv}
        />
      )}

      {/* The script reference now lives at /script-reference and opens
          in a new tab from the "Reference ↗" button in the script-mode
          sticky control bar. The previous slide-out panel was removed. */}
        </>
      )}

      {/* Chart view of script mode — a candlestick chart of the stitched
          bars from every selected session, with two layered marker
          tracks (raw signals + filtered trades). Independent of the
          UI subtree above so the layout stays simple: exactly one of
          {legacy children, chart} renders at a time. */}
      {mode === "script" && scriptViewMode === "chart" && (
        <BacktestScriptChart
          bars={scriptChartInputs.bars}
          signalZones={runResult.syntheticZones}
          trades={trades}
          showSignals={showSignalsLayer}
          showTrades={showTradesLayer}
          onToggleSignals={setShowSignalsLayer}
          onToggleTrades={setShowTradesLayer}
          warning={scriptChartInputs.warning}
        />
      )}

      </div>

      {/* ── Script v2 drag divider + right rail ──────────────────────
          The divider is a 6px column-resize strip; pointerdown on it
          captures pointermove/up on the window so the drag continues
          even when the cursor leaves the strip. Sticky-positions the
          aside so the editor + output panel stay in view while the
          user scrolls the left column. Renders only in script mode;
          the legacy single-column `<div>` is reused under the UI-mode
          branch via `contents` so semantics stay identical when the
          user is not scripting. */}
      {mode === "script" && (
        <>
          <div
            onPointerDown={onSplitDown}
            onMouseDown={onSplitDown}
            // Sticky-positioned just like the aside so the divider is
            // ALWAYS visible regardless of scroll position. Without this
            // (e.g. plain `align-self: stretch`), the divider's hit area
            // collapses to a small natural height and clicks below that
            // strip miss it entirely. Sticky + an explicit viewport-tall
            // height makes the entire visible vertical strip clickable.
            // Width 8px to give a comfortable hit target; visual indicator
            // is the bg color + col-resize cursor.
            className="cursor-col-resize bg-[#2a2a3a] hover:bg-accent-green/40 active:bg-accent-green/60 transition-colors flex-shrink-0 rounded"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(scriptLeftPct)}
            aria-valuemin={SCRIPT_SPLIT_MIN}
            aria-valuemax={SCRIPT_SPLIT_MAX}
            title="Drag to resize"
            style={{
              width: "8px",
              position: "sticky",
              top: "1rem",
              height: "calc(100vh - 2rem)",
              alignSelf: "flex-start",
              // touchAction: 'none' tells the browser not to interpret
              // gestures on this element as scrolling — required for
              // pointer/touch drags to receive every move event.
              touchAction: "none",
            }}
          />
        <aside
          className="flex-shrink-0 space-y-3 pl-3"
          style={{
            // Width fills whatever the left pane didn't take, minus the
            // divider's 8px so the three children sum to exactly 100%.
            width: `calc(${100 - scriptLeftPct}% - 8px)`,
            position: "sticky",
            top: "1rem",
            alignSelf: "flex-start",
            maxHeight: "calc(100vh - 2rem)",
            overflowY: "auto",
          }}
        >
          {/* ── Sticky control bar at the top of the right rail ──────
              Apply / Sync from UI / Reference are the script-mode
              actions the user reaches for repeatedly while iterating.
              Pinned to the top of the (already-sticky) rail so they're
              always reachable — even if the editor is scrolled deep or
              the output panel below has many rows. The bar uses the
              same `position: sticky; top: 0` trick INSIDE the aside's
              own scroll container, so as the rail content scrolls
              within the rail, this bar stays put. */}
          <div
            className="sticky z-10 -mt-1 -mx-1 px-3 py-2 rounded-md bg-card/95 backdrop-blur border border-card-border flex items-center justify-end gap-2 flex-wrap shadow-sm"
            style={{ top: 0 }}
          >
            <a
              href="/script-reference"
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              title="Open the script reference in a new tab"
            >
              Reference ↗
            </a>
            {/* Download a single self-contained Markdown reference of the
                entire DSL — schema + expression symbols + summary
                identifiers + Optimize directive + a canonical default
                script. Built so a user can paste the file into an AI
                chat (Claude / ChatGPT / Gemini) and ask the model to
                author or modify scripts with full context. */}
            <button
              onClick={downloadScriptReferenceMarkdown}
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              title="Download the full script reference as a Markdown file optimized for pasting into an AI chat (Claude / ChatGPT / Gemini) so it can write custom scripts for you."
            >
              Download for AI ↓
            </button>
            {/* Disk-backed script picker. When a script is selected, all
                edits stream to `backtests/scripts/<name>.dsl` and external
                edits to that file (e.g. from Claude Code in a terminal)
                stream back into the editor. The dropdown shows files
                from the directory plus two pseudo-options:
                  - "Local only" — unbind from disk; edits stay in
                    localStorage + Supabase only (legacy behaviour).
                  - "Save as new…" — prompt for a name and write the
                    current editor contents as a new disk file.
                The 🟢 dot and small filename badge make the active
                binding visible at a glance. */}
            <div className="flex items-center gap-1.5">
              {activeScriptName && (
                <span
                  className="text-[10px] font-mono text-accent-green"
                  title={`Edits are mirrored to backtests/scripts/${activeScriptName}`}
                  aria-hidden
                >
                  ●
                </span>
              )}
              <select
                value={activeScriptName ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__none__") {
                    setActiveScriptName(null);
                    lastPutMtimeRef.current = 0;
                    return;
                  }
                  if (v === "__new__") {
                    void handleSaveAsNewScript();
                    return;
                  }
                  void handleLoadScript(v);
                }}
                className="px-2 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors border-0 outline-none cursor-pointer max-w-[160px]"
                title="Pick a disk-backed script to bind the editor to. Edits flow to backtests/scripts/<name>.dsl and external edits flow back via SSE — Claude Code in a terminal can edit the same file live."
              >
                <option value="__none__">
                  {activeScriptName ? "Local only" : "On disk: (none)"}
                </option>
                {availableScripts.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
                <option value="__new__">+ Save as new…</option>
              </select>
            </div>
            <button
              onClick={loadDefaultScript}
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              title="Replace the editor contents with the canonical default script — every schema field at its default value. Discards your edits and ignores the dashboard's current state."
            >
              Load Defaults
            </button>
            <button
              onClick={syncScriptFromState}
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              title="Replace the editor contents with a fresh script derived from the dashboard's current state. Discards your edits."
            >
              Sync from UI
            </button>
            {/* Run / Cancel toggle. While the async optimizer is in
                flight (`scriptRunProgress` non-null) the button flips
                to a red Cancel — clicking it flags the optimizer's
                cancelRef so its loop breaks at the next signal
                boundary. The early-running pre-optimizer phase
                (parse + memo settle) shows the disabled "Running…"
                spinner — there's nothing yieldable to cancel yet, so
                the button stays inert until progress kicks in. */}
            {scriptRunProgress ? (
              <button
                onClick={handleCancelRun}
                className="px-3 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1.5 bg-accent-red/20 text-accent-red hover:bg-accent-red/30"
                title="Stop the in-flight optimizer run. The optimizer breaks at the next signal boundary; the chart keeps showing the previously committed result."
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden
                >
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
                Cancel
              </button>
            ) : (
              <button
                onClick={handleRun}
                disabled={isRunning}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  isRunning
                    ? "bg-accent-green/10 text-accent-green/70 cursor-wait"
                    : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                }`}
                title="Parse the editor and run the script as a backtest. Runs online TPE optimization when Optimize.X.Y(...) directives are present."
              >
                {isRunning && (
                  <svg
                    className="animate-spin h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      opacity="0.25"
                    />
                    <path
                      d="M4 12a8 8 0 018-8"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
                {isRunning ? "Running…" : "Run"}
              </button>
            )}
          </div>
          {/* Progress bar — visible whenever the async optimizer is
              running. Sits inside the same sticky scroll container as
              the Run button so it's always reachable while a long run
              ticks through the signal walk. The async optimizer
              effect updates `scriptRunProgress` per signal; the bar
              width is `current / total`. We show a count too so the
              user can eyeball ETA on huge runs. */}
          {scriptRunProgress && (
            <div className="bg-card/95 backdrop-blur border border-card-border rounded-md px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {scriptRunProgress.stage === "optimizing"
                    ? "Optimizing"
                    : "Simulating"}
                  …
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {scriptRunProgress.total > 0
                    ? `${scriptRunProgress.current} / ${scriptRunProgress.total}`
                    : ""}
                </span>
              </div>
              <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-green transition-[width] duration-150 ease-out"
                  style={{
                    width: `${
                      scriptRunProgress.total > 0
                        ? Math.min(
                            100,
                            (scriptRunProgress.current /
                              scriptRunProgress.total) *
                              100
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}
          {scriptApplied && (
            <div className="text-xs text-accent-green bg-accent-green/10 border border-accent-green/30 rounded-md px-3 py-1.5">
              Applied {scriptApplied.lines} line
              {scriptApplied.lines === 1 ? "" : "s"}
              {scriptApplied.warnings > 0
                ? ` · ${scriptApplied.warnings} warning${scriptApplied.warnings === 1 ? "" : "s"}`
                : ""}
            </div>
          )}
          <BacktestScriptEditor
            value={scriptText}
            onChange={handleScriptChange}
            errors={scriptErrors}
            placeholder="Type strategy = ... then params, rules, and filters. Use ⌃space for suggestions."
          />
          <ScriptOutputPanel
            summaryPrints={summaryPrintsResult}
            trades={trades}
            tradePrintLabels={tradePrintsLabels}
            optimizationHistory={tradesAndOptimization.optimizationHistory}
            warnings={tradesAndOptimization.optimizationWarnings}
          />
        </aside>
        </>
      )}

      {/* Toast — fixed bottom-right, auto-dismisses after 3.5s. Used for
          context-optimizer feedback when no candidate clears the
          20-trade floor. */}
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 max-w-sm bg-card border border-card-border rounded-lg px-4 py-3 shadow-xl text-sm text-foreground"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <span className="text-accent-red mt-0.5">!</span>
            <span className="flex-1">{toast}</span>
            <button
              onClick={() => setToast(null)}
              className="text-muted-foreground hover:text-foreground text-lg leading-none -mt-0.5"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Embedded terminal drawer — collapsed tab in the bottom-right by
          default. Lazy-mounts an xterm.js shell pane (rooted at the
          project directory) when opened, so the user can run `claude`,
          `git`, etc. without leaving the dashboard. Backed by
          `scripts/term-server.mjs` over a localhost-only WebSocket. */}
      <TerminalDrawer />
    </div>
  );
}
