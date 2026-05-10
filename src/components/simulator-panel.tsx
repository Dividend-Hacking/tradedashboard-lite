/**
 * SimulatorPanel — Orchestrator for the risk management simulator.
 *
 * Fetches trade_zone_bars on mount, owns the SimRules state, and runs the
 * simulation via useMemo whenever rules or data change. Composes the controls,
 * stat cards, results chart, and results table.
 */

"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { TradeZone, TradeZoneBar, ZoneSection } from "@/types/trade-zone";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import { parseRawTimestamp, formatDate } from "@/lib/utils/format";
import {
  SimRules,
  DEFAULT_SIM_RULES,
  simulateAllZones,
  computeSimSummary,
} from "@/lib/utils/zone-simulator";
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
} from "@/lib/utils/optimizer-worker-runner";
import { fetchZoneExtensionBars } from "@/lib/utils/zone-extension-fetcher";
import { fetchZoneAtr } from "@/lib/utils/zone-atr-fetcher";
import { fetchZonePreEntryBars } from "@/lib/utils/zone-pre-entry-fetcher";

// Hard ceiling on extension bars per zone — also the max value of the
// "Extend Bars" rule slider in SimulatorControls. Pre-fetched once on mount;
// the slider then slices in-memory for instant feedback.
const MAX_EXTENSION_BARS = 100;

// How many pre-entry bars we fetch per zone. Used by the per-trade chart
// (which shows up to 30 bars of setup context) and as the upper bound of
// the "Pre-Entry Bars" slider in the Export-For-AI modal.
const MAX_PRE_ENTRY_BARS = 30;
import { OptimizeConfigModal } from "./optimize-config-modal";
import { OptimizeAtrConfigModal } from "./optimize-atr-config-modal";
import { ExportDetailedModal } from "./export-detailed-modal";
import {
  buildDetailedExport,
  downloadDetailedExport,
} from "@/lib/utils/zone-detailed-export";
import { SimulatorControls } from "./simulator-controls";
import { SimulatorStatCards } from "./simulator-stat-cards";
import { SimulatorResultsChart } from "./simulator-results-chart";
import { SimulatorResultsByDayChart } from "./simulator-results-by-day-chart";
import { SimulatorTable } from "./simulator-table";
import { SimulatorSegmentCharts } from "./simulator-segment-charts";
import { SimulatorHeatmap } from "./simulator-heatmap";
import { ZoneEquityCurve, ZoneEquityPoint } from "./charts/zone-equity-curve";

interface SimulatorPanelProps {
  zones: TradeZone[];
  /** All available sections. Used to render the section multi-select filter
   *  that narrows which zones get fed into the simulation pipeline. */
  sections: ZoneSection[];
}

export function SimulatorPanel({ zones, sections }: SimulatorPanelProps) {
  const mode = useMode();

  // ─── Bar data (fetched on mount) ───────────────────────────────────
  const [barsByZoneId, setBarsByZoneId] = useState<Map<number, TradeZoneBar[]> | null>(null);
  // Post-zone extension bars pulled from replay_bars (one fetch on mount, then
  // sliced in-memory by the rules.extensionBars value). Null until loaded;
  // empty map after load if no zones matched a replay session.
  const [extensionBarsByZoneId, setExtensionBarsByZoneId] = useState<Map<number, TradeZoneBar[]> | null>(null);
  // Pre-entry context bars pulled from replay_bars (one fetch on mount). Used
  // ONLY by the per-trade candlestick chart in SimulatorTable to render the
  // setup leading into each entry — never fed to the simulator walk. Null
  // until loaded; empty map after load if no zones matched a replay session.
  const [preEntryBarsByZoneId, setPreEntryBarsByZoneId] = useState<Map<number, TradeZoneBar[]> | null>(null);
  // Per-zone ATR(14) at entry, computed from replay_bars history. Null until
  // loaded; absent zones (no replay match / not enough history) fall back to
  // raw point values when ATR mode is on.
  const [atrByZoneId, setAtrByZoneId] = useState<Map<number, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ─── Simulation rules state ────────────────────────────────────────
  const [rules, setRules] = useState<SimRules>(DEFAULT_SIM_RULES);

  // ─── Time-of-day filter ──────────────────────────────────────────
  // Filter zones by entry hour (e.g., "09:30" to "11:00" for regular session morning)
  const [timeFilterEnabled, setTimeFilterEnabled] = useState(false);
  const [timeFrom, setTimeFrom] = useState("09:30");
  const [timeTo, setTimeTo] = useState("16:00");

  // ─── Context filters (ADX / ATR / trend / Bollinger) ─────────────
  // These read the backfilled ctx_* fields on trade_zones (ADX(14), ATR(14),
  // EMA20/200 alignment, Bollinger position). Each filter is independent and
  // starts OFF; defaults on enable are the widest possible range so toggling
  // the filter on doesn't immediately hide zones — the user narrows from there.
  // Zones with a NULL value for the filtered field are dropped (strict: if you
  // ask to filter by X, you can't keep rows without X).
  const [adxFilterEnabled, setAdxFilterEnabled] = useState(false);
  const [adxMin, setAdxMin] = useState(0);
  const [adxMax, setAdxMax] = useState(100);

  const [atrFilterEnabled, setAtrFilterEnabled] = useState(false);
  const [atrMin, setAtrMin] = useState(0);
  const [atrMax, setAtrMax] = useState(100);

  // Trend mode per EMA. "any" = this EMA ignored. "with" = long needs price
  // above EMA / short needs price below. "against" = the opposite. Combines
  // across EMA20 + EMA200 as AND.
  type TrendMode = "any" | "with" | "against";
  const [trendFilterEnabled, setTrendFilterEnabled] = useState(false);
  const [ema20Mode, setEma20Mode] = useState<TrendMode>("with");
  const [ema200Mode, setEma200Mode] = useState<TrendMode>("any");

  // Bollinger position multi-select. When enabled, only zones whose
  // ctx_bollinger_pos is in this set pass. Default on enable: all three
  // selected (no-op). User removes chips to narrow.
  const [bollingerFilterEnabled, setBollingerFilterEnabled] = useState(false);
  const [bollingerAllowed, setBollingerAllowed] = useState<Set<string>>(
    () => new Set(["above_upper", "inside", "below_lower"])
  );

  // ─── Toast (optimizer feedback) ──────────────────────────────────
  // Lightweight inline toast used when a context-filter optimizer can't
  // find a valid candidate (e.g. all parameter choices fall below the
  // 20-trade floor). Nullable string; auto-clears on a timer so we don't
  // need a dismiss button. No shared library — only place in the app
  // that surfaces transient feedback, so overhead wouldn't pay for itself.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => {
    // Clean up the timer on unmount so we don't setState on a gone component
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // ─── Section filter ──────────────────────────────────────────────
  // Multi-select of section ids. Zones whose section_id is NOT in the set are
  // dropped before simulation. Default: every known section selected (= same
  // behaviour as pre-feature, since "all on" matches the full zone pool).
  const [selectedSectionIds, setSelectedSectionIds] = useState<Set<number>>(
    () => new Set(sections.map((s) => s.id))
  );

  // Track which section ids we've already reconciled. A brand-new id (created
  // since mount via realtime) gets auto-added so a fresh section doesn't
  // silently drop its zones. Ids the user deselected stay deselected.
  const seenSectionIdsRef = useRef<Set<number>>(
    new Set(sections.map((s) => s.id))
  );
  useEffect(() => {
    const knownIds = new Set(sections.map((s) => s.id));
    setSelectedSectionIds((prev) => {
      const next = new Set<number>();
      // Drop ids that no longer exist (section was deleted).
      for (const id of prev) if (knownIds.has(id)) next.add(id);
      // Add ids we've never seen before (freshly created section).
      for (const id of knownIds) {
        if (!seenSectionIdsRef.current.has(id)) next.add(id);
      }
      return next;
    });
    seenSectionIdsRef.current = knownIds;
  }, [sections]);

  const defaultSectionId = useMemo(
    () => sections.find((s) => s.name === "default")?.id ?? null,
    [sections]
  );

  // ─── Optimization state (SL/TP/TSL) ────────────────────────────────
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState<number | null>(null);
  const [rulesVersion, setRulesVersion] = useState(0);
  const cancelRef = useRef(false);

  // ─── ATR-multiplier optimization state ─────────────────────────────
  // Separate from the points optimizer because the grid units differ. Both
  // can't run concurrently (each button disables the other while running).
  const [optimizingAtr, setOptimizingAtr] = useState(false);
  const [optimizeAtrProgress, setOptimizeAtrProgress] = useState<number | null>(null);
  const atrCancelRef = useRef(false);

  // ─── Time optimization state ──────────────────────────────────────
  const [optimizingTime, setOptimizingTime] = useState(false);
  const [optimizeTimeProgress, setOptimizeTimeProgress] = useState<number | null>(null);
  const [showTimeOptModal, setShowTimeOptModal] = useState(false);
  const timeCancelRef = useRef(false);

  // ─── Context optimizer busy state ─────────────────────────────────
  // The four context optimizers (ADX/ATR/Trend/Bollinger) used to run
  // synchronously on the main thread; they now hop through the shared
  // worker so they survive a backgrounded tab. They typically complete
  // in well under a second, but we still gate the buttons during the
  // async hop to prevent overlapping spawns.
  const [contextOptimizing, setContextOptimizing] = useState(false);

  // ─── SL/TP/TSL optimizer config modal ─────────────────────────────
  // The Optimize button now opens a modal where the user picks ranges, the
  // SL:TP ratio lock, and whether to disable hard SL. The chosen config is
  // session-lived (not persisted) so reopening the modal preserves the last
  // values without surviving a page reload.
  const [showOptimizeConfigModal, setShowOptimizeConfigModal] = useState(false);
  const [optimizeConfig, setOptimizeConfig] = useState<OptimizeConfig>(DEFAULT_OPTIMIZE_CONFIG);

  // ─── ATR-Adjust optimizer config modal ────────────────────────────
  // Mirrors the SL/TP/TSL config modal: clicking "Optimize ATR Adjust" opens
  // this popup so users can constrain the search ranges (e.g. min=0 to rule
  // out negative adjustments). Session-lived, not persisted.
  const [showOptimizeAtrConfigModal, setShowOptimizeAtrConfigModal] = useState(false);
  const [optimizeAtrConfig, setOptimizeAtrConfig] = useState<AtrAdjustOptimizeConfig>(
    DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG
  );

  // ─── Detailed JSON export modal ───────────────────────────────────
  // Opens when the user clicks "Export For AI". Lets them choose how many
  // pre-entry bars to bundle with each trade before triggering the download.
  const [showExportDetailedModal, setShowExportDetailedModal] = useState(false);

  // ─── Fetch trade_zone_bars for current zones ───────────────────────
  // Filters by zone IDs and raises the limit to avoid Supabase's default
  // 1000-row cap, which was silently truncating bars and causing wrong
  // simulator results.
  useEffect(() => {
    async function fetchBars() {
      if (zones.length === 0) {
        setBarsByZoneId(new Map());
        setLoading(false);
        return;
      }

      try {
        const store = getClientStore(mode);
        const zoneIds = zones.map((z) => z.id);

        // The store layer hides backend pagination — Supabase pages internally
        // through PostgREST's 1000-row cap, SQLite returns everything in
        // one query. Returns Map<zoneId, bars> so we don't need a second pass.
        const map = await store.zones.listBarsForZones(zoneIds);

        setBarsByZoneId(map);
        setLoading(false);

        // Kick off the replay-bar extension fetch in the background. We don't
        // block the simulator on this — if it fails or is slow, the simulator
        // still works, just without the "Extend Bars" rule. The fetch needs
        // the zone bars map (for the lastZoneBarIndex offset) so it runs after
        // setBarsByZoneId above.
        fetchZoneExtensionBars(zones, map, MAX_EXTENSION_BARS)
          .then((extMap) => setExtensionBarsByZoneId(extMap))
          .catch((err) => {
            console.warn("[SimulatorPanel] extension bar fetch failed:", err);
            setExtensionBarsByZoneId(new Map());
          });

        // Kick off the pre-entry-bar fetch in the background. Used only by
        // the per-trade chart in SimulatorTable to show setup context — the
        // simulator walk is unaffected. 30 bars is a comfortable window above
        // the user's 20-bar minimum ask.
        fetchZonePreEntryBars(zones, MAX_PRE_ENTRY_BARS)
          .then((preMap) => setPreEntryBarsByZoneId(preMap))
          .catch((err) => {
            console.warn("[SimulatorPanel] pre-entry bar fetch failed:", err);
            setPreEntryBarsByZoneId(new Map());
          });

        // Kick off per-zone ATR(14) computation in the background too. Same
        // idea: non-blocking, the simulator still works without it (ATR mode
        // just falls back to raw point values for any zone missing an ATR).
        fetchZoneAtr(zones)
          .then((atrMap) => setAtrByZoneId(atrMap))
          .catch((err) => {
            console.warn("[SimulatorPanel] zone ATR fetch failed:", err);
            setAtrByZoneId(new Map());
          });
      } catch (err) {
        setError("Failed to fetch bar data");
        setLoading(false);
      }
    }

    fetchBars();
  }, [zones, mode]);

  // ─── Effective bars: zone bars + optional post-zone extension bars ──
  // When the "Extend Bars" rule is on, we append the first N pre-fetched
  // extension bars onto each zone's bar list. The simulator's existing walk
  // doesn't care that they came from replay_bars — it just sees more bars
  // with monotonically increasing bar_index. When the rule is off, we hand
  // back the original map unchanged so behavior is byte-identical to before.
  const effectiveBarsByZoneId = useMemo(() => {
    if (!barsByZoneId) return null;
    if (!rules.extensionBarsEnabled || !extensionBarsByZoneId || rules.extensionBars <= 0) {
      return barsByZoneId;
    }
    const merged = new Map<number, TradeZoneBar[]>();
    for (const [zoneId, bars] of barsByZoneId) {
      const ext = extensionBarsByZoneId.get(zoneId);
      if (ext && ext.length > 0) {
        merged.set(zoneId, [...bars, ...ext.slice(0, rules.extensionBars)]);
      } else {
        merged.set(zoneId, bars);
      }
    }
    return merged;
  }, [barsByZoneId, extensionBarsByZoneId, rules.extensionBarsEnabled, rules.extensionBars]);

  // ─── Apply section filter to zones ───────────────────────────────
  // Runs BEFORE the time-of-day filter so both compose. Zones with a NULL
  // section_id are treated as belonging to the default section — this keeps
  // legacy rows (if any slipped through the migration) visible whenever the
  // default chip is on. If every section is selected the result is
  // reference-equal to `zones` so downstream useMemos don't invalidate.
  const sectionFilteredZones = useMemo(() => {
    if (sections.length === 0) return zones;
    if (selectedSectionIds.size === sections.length) return zones;
    return zones.filter((z) => {
      const effectiveSectionId = z.section_id ?? defaultSectionId;
      return (
        effectiveSectionId !== null &&
        selectedSectionIds.has(effectiveSectionId)
      );
    });
  }, [zones, sections.length, selectedSectionIds, defaultSectionId]);

  // ─── Apply context filters (ADX / ATR / trend / Bollinger) ────────
  // Runs BETWEEN section and time filters so the chain is:
  //   zones → section → context → time → simulator/optimizers
  // All four sub-filters AND together; any zone missing the relevant ctx_*
  // field is dropped when that filter is on. Returns the input reference
  // when no filter is active so downstream useMemos stay stable.
  const contextFilteredZones = useMemo(() => {
    const noneActive =
      !adxFilterEnabled &&
      !atrFilterEnabled &&
      !trendFilterEnabled &&
      !bollingerFilterEnabled;
    if (noneActive) return sectionFilteredZones;

    return sectionFilteredZones.filter((z) => {
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
        // "With trend" = long above EMA / short below. "Against" = opposite.
        // For each EMA that isn't set to "any", zone must match that alignment.
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
      return true;
    });
  }, [
    sectionFilteredZones,
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
  ]);

  // ─── Apply time-of-day filter to context-filtered zones ────────────
  const timeFilteredZones = useMemo(() => {
    if (!timeFilterEnabled) return contextFilteredZones;

    // Parse "HH:MM" to minutes since midnight for comparison
    const parseTime = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const fromMin = parseTime(timeFrom);
    const toMin = parseTime(timeTo);

    return contextFilteredZones.filter((z) => {
      const { hour, minute } = parseRawTimestamp(z.start_time);
      const zoneMin = hour * 60 + minute;
      // Support wrapping (e.g., 22:00 to 02:00)
      if (fromMin <= toMin) {
        return zoneMin >= fromMin && zoneMin <= toMin;
      } else {
        return zoneMin >= fromMin || zoneMin <= toMin;
      }
    });
  }, [contextFilteredZones, timeFilterEnabled, timeFrom, timeTo]);

  /** Opens the optimizer config modal so the user can tune ranges, the
   *  SL:TP ratio lock, and the disable-hard-SL toggle before running. */
  const openOptimizeModal = useCallback(() => {
    if (!effectiveBarsByZoneId || optimizing) return;
    setShowOptimizeConfigModal(true);
  }, [effectiveBarsByZoneId, optimizing]);

  /** Runs the grid search with the user-supplied config. Closes the modal
   *  first so progress shows on the main button as before. */
  const runOptimizeNow = useCallback((config: OptimizeConfig) => {
    if (!effectiveBarsByZoneId || optimizing) return;

    setShowOptimizeConfigModal(false);
    cancelRef.current = false;
    setOptimizing(true);
    setOptimizeProgress(0);

    runOptimizeChunked(
      timeFilteredZones,
      effectiveBarsByZoneId,
      rules,
      config,
      (progress) => setOptimizeProgress(progress),
      cancelRef,
      atrByZoneId
    ).then((result) => {
      setRules((prev) => ({ ...prev, ...result.bestRules }));
      setRulesVersion((v) => v + 1);
      setOptimizing(false);
      setOptimizeProgress(null);
    });
  }, [timeFilteredZones, effectiveBarsByZoneId, rules, optimizing, atrByZoneId]);

  /** Opens the ATR-Adjust optimizer config modal so the user can tune the
   *  search ranges (including constraining min≥0 to exclude negative
   *  adjustments) before running. */
  const openOptimizeAtrModal = useCallback(() => {
    if (!effectiveBarsByZoneId || optimizingAtr || optimizing) return;
    setShowOptimizeAtrConfigModal(true);
  }, [effectiveBarsByZoneId, optimizingAtr, optimizing]);

  /** Runs the ATR-Adjust optimizer with the user-chosen config. Keeps the
   *  user's base SL/TP/Trail point values FROZEN and grids over the per-rule
   *  ATR adjustments only. Answers: "given my proven base, can I improve EV
   *  by stretching/tightening per-zone based on volatility?". Result is
   *  merged into rules so the new adjustment values appear live in controls. */
  const runOptimizeAtrNow = useCallback((config: AtrAdjustOptimizeConfig) => {
    if (!effectiveBarsByZoneId || optimizingAtr || optimizing) return;

    setShowOptimizeAtrConfigModal(false);
    atrCancelRef.current = false;
    setOptimizingAtr(true);
    setOptimizeAtrProgress(0);

    runAtrAdjustOptimizeChunked(
      timeFilteredZones,
      effectiveBarsByZoneId,
      rules,
      config,
      (progress) => setOptimizeAtrProgress(progress),
      atrCancelRef,
      atrByZoneId
    ).then((result) => {
      // result.bestRules carries only the adjustment fields — base values
      // stay untouched in `prev`.
      setRules((prev) => ({ ...prev, ...result.bestRules }));
      setRulesVersion((v) => v + 1);
      setOptimizingAtr(false);
      setOptimizeAtrProgress(null);
    });
  }, [timeFilteredZones, effectiveBarsByZoneId, rules, optimizing, optimizingAtr, atrByZoneId]);

  /** Kicks off the time window optimizer with the selected minimum window size.
   *  Sweeps all 30-min time windows using current rules and finds the one
   *  with the best avg points per trade. */
  const handleOptimizeTime = useCallback((minWindowMinutes: number) => {
    if (!effectiveBarsByZoneId || optimizingTime) return;

    setShowTimeOptModal(false);
    timeCancelRef.current = false;
    setOptimizingTime(true);
    setOptimizeTimeProgress(0);

    // Pass context-filtered zones (not time-filtered) so the optimizer can
    // search over time windows while still respecting section + ADX/ATR/
    // trend/Bollinger constraints the user has set.
    runTimeOptimizeChunked(
      contextFilteredZones,
      effectiveBarsByZoneId,
      rules,
      minWindowMinutes,
      (progress) => setOptimizeTimeProgress(progress),
      timeCancelRef,
      atrByZoneId
    ).then((result) => {
      // Apply the best time window — enable the filter and set from/to
      setTimeFilterEnabled(true);
      setTimeFrom(result.bestTimeFrom);
      setTimeTo(result.bestTimeTo);
      setOptimizingTime(false);
      setOptimizeTimeProgress(null);
    });
  }, [contextFilteredZones, effectiveBarsByZoneId, rules, optimizingTime, atrByZoneId]);

  // Cancel optimizations if component unmounts
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      timeCancelRef.current = true;
      atrCancelRef.current = true;
    };
  }, []);

  // ─── Run simulation (recomputes when rules or data change) ─────────
  const results = useMemo(() => {
    if (!effectiveBarsByZoneId) return [];
    return simulateAllZones(timeFilteredZones, effectiveBarsByZoneId, rules, atrByZoneId);
  }, [timeFilteredZones, effectiveBarsByZoneId, rules, atrByZoneId]);

  const summary = useMemo(() => computeSimSummary(results), [results]);

  // ─── Equity curve with both original + simulated lines ──────────────
  const equityCurveData = useMemo((): ZoneEquityPoint[] => {
    if (results.length === 0) return [];

    // Build a map of zoneId → scaled simulated P&L for quick lookup.
    // Using scaledPoints (not exitPoints) so the equity curve reflects the
    // scaling modifier when it's on. When scaling is off scaledPoints ===
    // exitPoints, so the curve is unchanged from previous behavior.
    const simByZone = new Map<number, number>();
    for (const r of results) simByZone.set(r.zoneId, r.scaledPoints);

    let origCum = 0;
    let simCum = 0;

    return timeFilteredZones
      .filter((z) => simByZone.has(z.id)) // Only zones that were simulated
      .map((z) => {
        origCum += z.points_move;
        simCum += simByZone.get(z.id) ?? 0;
        return {
          label: formatDate(z.start_time),
          originalCumulative: Math.round(origCum * 100) / 100,
          simulatedCumulative: Math.round(simCum * 100) / 100,
        };
      });
  }, [zones, results]);

  // ─── Exit reason breakdown for display ─────────────────────────────
  const exitBreakdown = useMemo(() => {
    if (!summary.byExitReason || Object.keys(summary.byExitReason).length === 0) return null;
    return summary.byExitReason;
  }, [summary]);

  /** Export simulated trades as a CSV file for external analysis */
  const handleExportCsv = useCallback(() => {
    if (results.length === 0) return;

    // Export both per-contract (Simulated Points) and size-scaled (Scaled Points)
    // so the CSV is self-explanatory whether or not the scaling modifier was
    // enabled. When scaling is off, Position Size is always 1 and Scaled
    // Points === Simulated Points.
    const headers = ["Date", "Time", "Instrument", "Direction", "Original Points", "Simulated Points", "Position Size", "Scaled Points", "Exit Reason", "Bars Held", "Peak MFE", "Max Drawdown"];
    const rows = results.map((r) => {
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

    // Build filename with today's date
    const now = new Date();
    const filename = `simulated-trades-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.csv`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  /**
   * Builds the AI-friendly JSON export and triggers download. Called from
   * ExportDetailedModal once the user picks a pre-entry bar count.
   *
   * Uses `effectiveBarsByZoneId` (zone bars + extension bars when the rule is
   * on) so the export honors whatever the user is currently looking at in
   * the table — no surprise mismatch between what they see and what they
   * download.
   */
  const handleExportDetailed = useCallback((preEntryBarsCount: number) => {
    if (results.length === 0) return;

    const payload = buildDetailedExport({
      results,
      zones: timeFilteredZones,
      barsByZoneId: effectiveBarsByZoneId ?? new Map(),
      preEntryBarsByZoneId,
      atrByZoneId,
      rules,
      summary,
      sections,
      preEntryBarsCount,
    });

    const now = new Date();
    const filename = `simulated-trades-detailed-${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.json`;

    downloadDetailedExport(payload, filename);
    setShowExportDetailedModal(false);
  }, [
    results,
    timeFilteredZones,
    effectiveBarsByZoneId,
    preEntryBarsByZoneId,
    atrByZoneId,
    rules,
    summary,
    sections,
  ]);

  // ─── Loading / error states ────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-8 text-center text-muted-foreground">
        Loading bar data for simulation...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-8 text-center text-accent-red">
        Error loading bar data: {error}
      </div>
    );
  }

  const toggleSection = (id: number) => {
    setSelectedSectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSectionsSelected =
    sections.length > 0 && selectedSectionIds.size === sections.length;

  // ─── Context-filter optimizers ────────────────────────────────────
  // Each "Optimize X" button builds a base pool that includes every OTHER
  // currently-active filter (so narrowing is additive), then hands the
  // pool to the corresponding optimizer. Synchronous — grids are small
  // enough that running on the main thread is invisible to the user.
  //
  // The time-of-day filter is ALWAYS respected by these optimizers when
  // it's on, mirroring how the other filters work. This matches the
  // approved "respect other active filters" scope.
  const parseTimeMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  /** Builds a pool with every enabled filter applied EXCEPT the one named. */
  const buildBasePool = (exclude: "adx" | "atr" | "trend" | "bollinger") => {
    let pool = sectionFilteredZones;
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
        (z) => z.ctx_bollinger_pos != null && bollingerAllowed.has(z.ctx_bollinger_pos)
      );
    }
    if (timeFilterEnabled) {
      const fromMin = parseTimeMinutes(timeFrom);
      const toMin = parseTimeMinutes(timeTo);
      pool = pool.filter((z) => {
        const { hour, minute } = parseRawTimestamp(z.start_time);
        const zm = hour * 60 + minute;
        if (fromMin <= toMin) return zm >= fromMin && zm <= toMin;
        return zm >= fromMin || zm <= toMin;
      });
    }
    return pool;
  };

  const runOptimizeAdx = async () => {
    if (!effectiveBarsByZoneId || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeAdxInWorker(
        buildBasePool("adx"),
        effectiveBarsByZoneId,
        rules,
        atrByZoneId
      );
      if (!result) {
        showToast("ADX optimizer: no range produced at least 20 trades. Try relaxing other filters.");
        return;
      }
      console.log(
        `[ctx-optimizer] ADX best: [${result.min}, ${result.max}] → ${result.count} trades, ${result.avg.toFixed(3)} pts/trade`
      );
      setAdxFilterEnabled(true);
      setAdxMin(result.min);
      setAdxMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  };

  const runOptimizeAtr = async () => {
    if (!effectiveBarsByZoneId || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeAtrInWorker(
        buildBasePool("atr"),
        effectiveBarsByZoneId,
        rules,
        atrByZoneId
      );
      if (!result) {
        showToast("ATR optimizer: no range produced at least 20 trades. Try relaxing other filters.");
        return;
      }
      console.log(
        `[ctx-optimizer] ATR best: [${result.min}, ${result.max}] → ${result.count} trades, ${result.avg.toFixed(3)} pts/trade`
      );
      setAtrFilterEnabled(true);
      setAtrMin(result.min);
      setAtrMax(result.max);
    } finally {
      setContextOptimizing(false);
    }
  };

  const runOptimizeTrend = async () => {
    if (!effectiveBarsByZoneId || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeTrendInWorker(
        buildBasePool("trend"),
        effectiveBarsByZoneId,
        rules,
        atrByZoneId
      );
      if (!result) {
        showToast("Trend optimizer: no combination produced at least 20 trades. Try relaxing other filters.");
        return;
      }
      console.log(
        `[ctx-optimizer] Trend best: EMA20=${result.ema20Mode} EMA200=${result.ema200Mode} → ${result.count} trades, ${result.avg.toFixed(3)} pts/trade`
      );
      setTrendFilterEnabled(true);
      setEma20Mode(result.ema20Mode);
      setEma200Mode(result.ema200Mode);
    } finally {
      setContextOptimizing(false);
    }
  };

  const runOptimizeBollinger = async () => {
    if (!effectiveBarsByZoneId || contextOptimizing) return;
    setContextOptimizing(true);
    try {
      const result = await optimizeBollingerInWorker(
        buildBasePool("bollinger"),
        effectiveBarsByZoneId,
        rules,
        atrByZoneId
      );
      if (!result) {
        showToast("Bollinger optimizer: no subset produced at least 20 trades. Try relaxing other filters.");
        return;
      }
      console.log(
        `[ctx-optimizer] Bollinger best: {${result.allowed.join(", ")}} → ${result.count} trades, ${result.avg.toFixed(3)} pts/trade`
      );
      setBollingerFilterEnabled(true);
      setBollingerAllowed(new Set(result.allowed));
    } finally {
      setContextOptimizing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Section filter bar — multi-select chips.
          Clicking a chip toggles inclusion. "All" resets to every section so
          the user can get back to the full pool in one click. Zone count shown
          reflects the intersection of section + (optional) time filters. */}
      {sections.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Sections
          </span>
          <button
            onClick={() =>
              setSelectedSectionIds(new Set(sections.map((s) => s.id)))
            }
            disabled={allSectionsSelected}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              allSectionsSelected
                ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
            }`}
          >
            All
          </button>
          {sections.map((s) => {
            const active = selectedSectionIds.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleSection(s.id)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  active
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.name}
              </button>
            );
          })}
          <span className="text-xs text-muted-foreground">
            {sectionFilteredZones.length} of {zones.length} zones
          </span>
        </div>
      )}

      {/* Time-of-day filter bar */}
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

        {/* Optimize Time button — opens modal to select min window, then runs optimizer */}
        <button
          onClick={optimizingTime ? () => { timeCancelRef.current = true; } : () => setShowTimeOptModal(true)}
          disabled={!barsByZoneId}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            optimizingTime
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
          }`}
        >
          {optimizingTime
            ? `OPTIMIZING TIME ${optimizeTimeProgress !== null ? `${Math.round(optimizeTimeProgress * 100)}%` : "..."}`
            : "OPTIMIZE TIME"}
        </button>

        {/* Export CSV button — downloads all simulated trade results */}
        <button
          onClick={handleExportCsv}
          disabled={results.length === 0}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            results.length > 0
              ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
          }`}
        >
          EXPORT CSV
        </button>

        {/* Export For AI — opens a modal where the user picks pre-entry bar
            count, then downloads a JSON bundle (per-trade levels + bar OHLCV
            + per-bar trail/BE state) tailored for LLM analysis. */}
        <button
          onClick={() => setShowExportDetailedModal(true)}
          disabled={results.length === 0}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            results.length > 0
              ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
              : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
          }`}
          title="Download a detailed JSON bundle (trades + bars + levels) for AI pattern analysis"
        >
          EXPORT FOR AI
        </button>

        {timeFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">From</label>
              <input
                type="time"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
                className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">To</label>
              <input
                type="time"
                value={timeTo}
                onChange={(e) => setTimeTo(e.target.value)}
                className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {timeFilteredZones.length} of {contextFilteredZones.length} zones
            </span>
          </>
        )}
      </div>

      {/* Context filters — read backfilled ctx_* fields on trade_zones.
          Each is an independent toggle-bar; all four AND together and apply
          BEFORE the time filter, so grid-search and ATR-adjust optimizers
          (which consume timeFilteredZones) respect them automatically. */}

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
          disabled={!effectiveBarsByZoneId || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep ADX min/max ranges, keep the one with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          OPTIMIZE
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
            <span className="text-xs text-muted-foreground">
              ADX(14) at entry — higher = trending, lower = choppy
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
          disabled={!effectiveBarsByZoneId || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Sweep ATR min/max ranges, keep the one with the best avg points/trade (min 20 trades). Respects other active filters."
        >
          OPTIMIZE
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
            <span className="text-xs text-muted-foreground">
              ATR(14) at entry, in points (5-min bars)
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
          disabled={!effectiveBarsByZoneId || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Try all 9 combinations of EMA20 × EMA200 modes, keep the best avg points/trade (min 20 trades). Respects other active filters."
        >
          OPTIMIZE
        </button>
        {trendFilterEnabled && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">EMA20</label>
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
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">EMA200</label>
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
              With = long above EMA / short below
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
          disabled={!effectiveBarsByZoneId || contextOptimizing}
          className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Try all 7 non-empty subsets of Bollinger positions, keep the best avg points/trade (min 20 trades). Respects other active filters."
        >
          OPTIMIZE
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
            <span className="text-xs text-muted-foreground">
              price vs 20-SMA ± 2σ at entry
            </span>
          </>
        )}
      </div>

      {/* Total context-filtered count — only visible when any context filter
          is active, so users see exactly how many zones survived. */}
      {(adxFilterEnabled || atrFilterEnabled || trendFilterEnabled || bollingerFilterEnabled) && (
        <div className="text-xs text-muted-foreground">
          {contextFilteredZones.length} of {sectionFilteredZones.length} zones pass context filters
        </div>
      )}

      {/* Controls + Exit Reason Summary side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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

        {/* Exit reason breakdown */}
        {exitBreakdown && (
          <div className="bg-card border border-card-border rounded-lg p-4">
            <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-3">
              Exit Reasons
            </h3>
            <div className="space-y-2">
              {Object.entries(exitBreakdown).map(([reason, count]) => {
                const pct = summary.totalTrades > 0 ? (count / summary.totalTrades) * 100 : 0;
                return (
                  <div key={reason} className="flex items-center gap-2">
                    <span className="text-sm font-medium min-w-[50px] uppercase">{reason}</span>
                    <div className="flex-1 bg-white/5 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent-green/60"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground min-w-[60px] text-right">
                      {count} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Equity curve — original (green) vs simulated (blue) */}
      <ZoneEquityCurve data={equityCurveData} showSimulated={true} />

      {/* Summary stat cards */}
      <SimulatorStatCards summary={summary} />

      {/* Original vs Simulated chart — per trade */}
      <SimulatorResultsChart results={results} />

      {/* Original vs Simulated chart — aggregated per day */}
      <SimulatorResultsByDayChart results={results} />

      {/* Per-zone results table — click a row to see candlestick chart */}
      <SimulatorTable
        results={results}
        zones={timeFilteredZones}
        barsByZoneId={effectiveBarsByZoneId ?? new Map()}
        preEntryBarsByZoneId={preEntryBarsByZoneId}
        // Post-exit context bars for the inline candlestick chart. We pass
        // the RAW pre-fetched extension bars (not the rule-gated merged set)
        // so the per-trade chart always shows ~30 bars of aftermath past the
        // simulated exit, regardless of whether the simulator's "Extend Bars"
        // rule is on. Independent of simulation behavior — chart context only.
        postExitBarsByZoneId={extensionBarsByZoneId}
        rules={rules}
        atrByZoneId={atrByZoneId}
      />

      {/* Bivariate heatmap — pick any two of the segment-analysis dimensions
          and see joint P&L distribution across their buckets. */}
      <SimulatorHeatmap
        results={results}
        zones={timeFilteredZones}
        barsByZoneId={effectiveBarsByZoneId ?? undefined}
        preEntryBarsByZoneId={preEntryBarsByZoneId}
        atrByZoneId={atrByZoneId}
        scalingEnabled={rules.scalingEnabled}
      />

      {/* Segment-analysis histograms — outcome dimensions (MAE/MFE/time
          in trade/trade #) and categorical dimensions (direction, exit
          reason, hour, day, streak before, position size). Entry-time
          indicator buckets used to render here unconditionally; they're
          now opt-in via `graph = <expr>` in the strategy DSL on the
          backtesting tab. The risk simulator has no DSL editor of its
          own, so it just passes the built-ins. */}
      <SimulatorSegmentCharts
        results={results}
        zones={timeFilteredZones}
        scalingEnabled={rules.scalingEnabled}
      />

      {/* ── Time Optimize Modal — select minimum window size before running ── */}
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

      {/* ── Optimize SL/TP/TSL Config Modal ──────────────────────────────
          Lets the user configure ranges, lock the SL:TP risk-reward ratio,
          and disable hard SL (force TSL-only) before running the optimizer.
          Inline (matches Time Optimize Modal pattern). All inputs preload
          from `optimizeConfig` which is session-lived in the parent. */}
      {showOptimizeConfigModal && (
        <OptimizeConfigModal
          config={optimizeConfig}
          onChange={setOptimizeConfig}
          onClose={() => setShowOptimizeConfigModal(false)}
          onRun={runOptimizeNow}
        />
      )}

      {/* ── Optimize ATR Adjust Config Modal ─────────────────────────────
          Siblings to the SL/TP/TSL modal above. Lets the user constrain
          the per-axis adjustment search ranges (min/max/step) before
          running — e.g. setting min=0 to exclude negative adjustments. */}
      {showOptimizeAtrConfigModal && (
        <OptimizeAtrConfigModal
          config={optimizeAtrConfig}
          onChange={setOptimizeAtrConfig}
          onClose={() => setShowOptimizeAtrConfigModal(false)}
          onRun={runOptimizeAtrNow}
        />
      )}

      {/* ── Export For AI Modal ──────────────────────────────────────────
          Lets the user pick how many pre-entry bars to bundle with each
          trade, then triggers the JSON download. The slider's max comes
          from MAX_PRE_ENTRY_BARS (whatever we pre-fetched on mount), so
          the user can never request more context than we have on hand. */}
      {showExportDetailedModal && (
        <ExportDetailedModal
          tradeCount={results.length}
          maxPreEntryBars={MAX_PRE_ENTRY_BARS}
          defaultPreEntryBars={20}
          onClose={() => setShowExportDetailedModal(false)}
          onExport={handleExportDetailed}
        />
      )}

      {/* Toast — fixed bottom-right, auto-dismisses after 3.5s. Rendered
          here (rather than a portal) because the outer div has no transform
          and nothing else sets z-index > 50, so fixed positioning escapes
          the panel naturally. */}
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
    </div>
  );
}
