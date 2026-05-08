"use client";

/**
 * ReplayViewer — Main orchestrator for the market replay experience.
 *
 * Combines the replay engine (bar-by-bar playback), replay chart
 * (lightweight-charts candlesticks), playback controls, and practice
 * trading panel into a single coordinated view.
 *
 * Manages two independent state machines:
 *   1. Replay engine — controls which bars are visible (useReducer)
 *   2. Practice trading — manages open/closed positions (useState)
 *
 * The replay engine drives bar reveals; on each new bar, the practice
 * trading engine checks for SL/TP hits. User trade actions flow through
 * the practice engine and update chart overlays.
 */

import { useReducer, useState, useEffect, useCallback, useRef, useMemo, useTransition } from "react";
import Link from "next/link";
import { ReplayBar, ReplaySession } from "@/types/replay";
import { ZoneSection } from "@/types/trade-zone";
import { savePracticeSession, saveZone, saveReplayProgress } from "@/app/replay/actions";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import {
  createReplayState,
  replayReducer,
  getVisibleBars,
  getCurrentBar,
  isAtEnd,
} from "@/lib/utils/replay-engine";
import {
  createPracticeTradingState,
  enterLong,
  enterShort,
  exitPosition,
  closeAtSessionEnd,
  updateStopLoss,
  updateTakeProfit,
  processBar,
  PracticeTradingState,
} from "@/lib/utils/practice-trading";
import {
  createZonePracticeState,
  placeZone,
  processZoneBar,
  computeBarAnalytics,
  ZonePracticeState,
  PracticeZone,
} from "@/lib/utils/zone-practice";
import {
  SimRules,
  DEFAULT_SIM_RULES,
  simulateAllZones,
} from "@/lib/utils/zone-simulator";
import { fetchAnalyzeData, AnalyzeData } from "@/lib/utils/analyze-fetcher";
import ReplayChart, { AnalyzeOverlay } from "./replay-chart";
import PlaybackControls from "./playback-controls";
import TradePanel, { PanelMode } from "./trade-panel";
import { AnalyzeSectionPicker } from "./analyze-section-picker";
import { AnalyzePanel } from "./analyze-panel";
import {
  fetchTraderPreferences,
  saveTraderPreferencesDebounced,
} from "@/lib/trader-preferences";
import type { IndicatorConfig } from "@/types/indicators";

interface ReplayViewerProps {
  session: ReplaySession;
  bars: ReplayBar[];
  /** Available zone sections for the practice session's section picker.
   *  The user picks one section at the start of the session; every zone
   *  saved (including auto-saves on completion) is tagged with it. */
  sections: ZoneSection[];
}

export default function ReplayViewer({
  session,
  bars,
  sections: initialSections,
}: ReplayViewerProps) {
  const mode = useMode();

  // ─── Replay Engine State ────────────────────────────────────────────────
  const [replayState, dispatch] = useReducer(replayReducer, bars, createReplayState);

  // ─── Practice Trading State ─────────────────────────────────────────────
  const [tradingState, setTradingState] = useState<PracticeTradingState>(
    createPracticeTradingState
  );

  // ─── Zone Practice State ────────────────────────────────────────────────
  const [zoneState, setZoneState] = useState<ZonePracticeState>(
    createZonePracticeState
  );
  const [panelMode, setPanelMode] = useState<PanelMode>("zone");

  // ─── Zone Bars State (lifted from ZoneMode for keyboard shortcut access) ──
  const [zoneBars, setZoneBars] = useState<string>("20");
  const targetBars = parseInt(zoneBars) || 20;

  // ─── Zone SL/TP State (lifted for keyboard-shortcut parity) ─────────────
  // Visual-only levels attached to a placed zone. Points-based so they can be
  // applied symmetrically to Long/Short at placement time by converting to an
  // absolute price off currentBar.bar_close (same math as handleEnterLong/Short).
  // Checkbox toggles treat the "enabled" flag as the source of truth — if off,
  // null is passed into placeZone and no line is drawn on the chart.
  const [zoneSlPoints, setZoneSlPoints] = useState<string>("10");
  const [zoneTpPoints, setZoneTpPoints] = useState<string>("20");
  const [zoneSlEnabled, setZoneSlEnabled] = useState<boolean>(true);
  const [zoneTpEnabled, setZoneTpEnabled] = useState<boolean>(true);

  // ─── Section state ──────────────────────────────────────────────────
  // Sections are sourced from the server on first render; a realtime
  // subscription keeps the picker list in sync if the user creates a new
  // section via the manage panel in another tab.
  const [sections, setSections] = useState<ZoneSection[]>(initialSections);

  // activeSectionId drives which section new zones are tagged with. Default
  // to the 'default' row's id; fall back to the first section if 'default'
  // somehow isn't present (should never happen — the migration seeds it).
  const [activeSectionId, setActiveSectionId] = useState<number | null>(() => {
    const def = initialSections.find((s) => s.name === "default");
    return def?.id ?? initialSections[0]?.id ?? null;
  });

  // ─── Practice chart indicators ────────────────────────────────────
  // Loaded client-side from trader_preferences.practice_indicators so
  // the user's EMA / ATR / etc. selections persist across replay
  // sessions. Starts empty; the mount-effect fills it from Supabase.
  // A "hydrated" flag gates the save-effect so the initial load from
  // the DB doesn't immediately round-trip back to the DB.
  const [practiceIndicators, setPracticeIndicators] = useState<IndicatorConfig[]>([]);
  const [indicatorsHydrated, setIndicatorsHydrated] = useState(false);

  // ─── Chart overlay visibility ─────────────────────────────────────
  // Three toggles that let the user declutter the chart. "Active" keeps the
  // zone currently playing out visible while "Completed" can be switched off
  // to hide the pile of historical zones from prior plays. Trades is a
  // separate group for practice-trade chrome. Hydrated from
  // trader_preferences.chart_overlays on mount.
  const [chartOverlays, setChartOverlays] = useState<{
    activeZones: boolean;
    completedZones: boolean;
    trades: boolean;
  }>({ activeZones: true, completedZones: true, trades: true });

  // ─── Analyze view state ──────────────────────────────────────────
  // The "Analyze" button in the header opens a section picker; once a
  // section is confirmed, we fetch every zone in that section that fits
  // the current session's window and feed them through the shared
  // simulator under user-tweakable SL/TP/TSL rules. The chart's right
  // sidebar swaps from the trade/zone panel to the AnalyzePanel for the
  // duration. State is intentionally local — closing the panel resets
  // everything so re-entering analyze starts from a clean slate.
  const [analyzePickerOpen, setAnalyzePickerOpen] = useState(false);
  const [analyzeSection, setAnalyzeSection] = useState<ZoneSection | null>(null);
  const [analyzeData, setAnalyzeData] = useState<AnalyzeData | null>(null);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // Independent rules state so tweaks here don't bleed into any other
  // simulator instance the user might have open elsewhere in the app.
  const [analyzeRules, setAnalyzeRules] = useState<SimRules>(DEFAULT_SIM_RULES);

  useEffect(() => {
    let cancelled = false;
    fetchTraderPreferences().then((prefs) => {
      if (cancelled) return;
      if (prefs?.practice_indicators) {
        setPracticeIndicators(prefs.practice_indicators);
      }
      if (prefs?.chart_overlays) {
        // Backward-compat: older rows stored { zones, trades } before the
        // zone toggle was split. Map zones → both activeZones and
        // completedZones so existing users don't lose their preference.
        const co = prefs.chart_overlays as Record<string, boolean | undefined>;
        const legacyZones = co.zones;
        setChartOverlays({
          activeZones: co.activeZones ?? legacyZones ?? true,
          completedZones: co.completedZones ?? legacyZones ?? true,
          trades: co.trades ?? true,
        });
      }
      setIndicatorsHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Debounced persistence — only runs after the initial hydration so
  // the first write is a genuine user edit, not an echo of the load.
  useEffect(() => {
    if (!indicatorsHydrated) return;
    saveTraderPreferencesDebounced({ practice_indicators: practiceIndicators });
  }, [practiceIndicators, indicatorsHydrated]);

  // Same hydrate-guard pattern for the overlay toggles — avoids the mount
  // effect's setState from immediately round-tripping back to Supabase.
  useEffect(() => {
    if (!indicatorsHydrated) return;
    saveTraderPreferencesDebounced({ chart_overlays: chartOverlays });
  }, [chartOverlays, indicatorsHydrated]);

  const handleOverlayChange = useCallback(
    (key: "activeZones" | "completedZones" | "trades", value: boolean) => {
      setChartOverlays((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // Keep activeSectionId valid when sections list changes (deletion, etc.).
  // If the active section was deleted, fall back to 'default'.
  useEffect(() => {
    if (activeSectionId === null) {
      const def = sections.find((s) => s.name === "default");
      if (def) setActiveSectionId(def.id);
      return;
    }
    if (!sections.some((s) => s.id === activeSectionId)) {
      const def = sections.find((s) => s.name === "default");
      setActiveSectionId(def?.id ?? sections[0]?.id ?? null);
    }
  }, [sections, activeSectionId]);

  // Keep the latest section id in a ref so the save callback (which closes
  // over its dependencies) always picks up the current value when a zone
  // auto-saves mid-session after the user switches sections.
  const activeSectionIdRef = useRef(activeSectionId);
  activeSectionIdRef.current = activeSectionId;

  // Realtime: mirror zone_sections changes into local state so the picker
  // reflects sections created/renamed/deleted elsewhere. Cloud taps Supabase
  // Realtime; local polls every ~2s.
  useEffect(() => {
    const store = getClientStore(mode);
    return store.zones.subscribeSections((row, kind) => {
      if (kind === "delete") {
        setSections((prev) => prev.filter((s) => s.id !== row.id));
        return;
      }
      setSections((prev) => {
        const idx = prev.findIndex((s) => s.id === row.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = row;
          return next.sort((a, b) => a.name.localeCompare(b.name));
        }
        return [...prev, row].sort((a, b) => a.name.localeCompare(b.name));
      });
    });
  }, [mode]);

  // Refs to avoid stale closures in the interval/keyboard callbacks
  const replayStateRef = useRef(replayState);
  replayStateRef.current = replayState;
  const panelModeRef = useRef(panelMode);
  panelModeRef.current = panelMode;
  const targetBarsRef = useRef(targetBars);
  targetBarsRef.current = targetBars;

  const visibleBars = getVisibleBars(replayState);
  const currentBar = getCurrentBar(replayState);

  // ─── Restore Progress on Mount ───────────────────────────────────────────
  // If this session was previously viewed, jump to the saved position
  useEffect(() => {
    if (session.last_bar_index > 0) {
      dispatch({ type: "JUMP_TO", index: session.last_bar_index });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Analyze: load zones when a section is picked ────────────────────
  // Triggered by the picker's onConfirm. We auto-jump the replay engine to
  // the end of the session as soon as the data load kicks off so the entry
  // and exit bars for every analyzed zone are guaranteed to be on-chart —
  // otherwise the user would have to scrub forward themselves to see the
  // overlay. Errors are captured into local state and surfaced in the panel.
  useEffect(() => {
    if (!analyzeSection) return;
    let cancelled = false;
    setAnalyzeLoading(true);
    setAnalyzeError(null);
    setAnalyzeData(null);
    // Reveal the entire session so all analyzed zones land on visible bars.
    dispatch({ type: "JUMP_TO", index: bars.length });
    fetchAnalyzeData(analyzeSection.id, session)
      .then((data) => {
        if (cancelled) return;
        setAnalyzeData(data);
        setAnalyzeLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[replay-viewer] analyze fetch failed:", err);
        setAnalyzeError("Failed to load analyze data.");
        setAnalyzeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analyzeSection, session, bars.length]);

  // ─── Analyze: simulate zones under current rules ─────────────────────
  // Pure derivation — re-runs whenever the user tweaks any rule or fresh
  // data lands. Each overlay also carries its resolved SL / TP price so
  // the chart can render flat segments without re-running rule math.
  const analyzeOverlays = useMemo<AnalyzeOverlay[]>(() => {
    if (!analyzeData || analyzeData.zones.length === 0) return [];

    const results = simulateAllZones(
      analyzeData.zones,
      analyzeData.barsByZoneId,
      analyzeRules,
      analyzeData.atrByZoneId
    );

    // Index results by zoneId so we can pair them back to the source zone
    // (simulator may drop zones with no bars, hence the nullable lookup).
    const resultByZoneId = new Map<number, typeof results[number]>();
    for (const r of results) resultByZoneId.set(r.zoneId, r);

    const overlays: AnalyzeOverlay[] = [];
    for (const zone of analyzeData.zones) {
      const result = resultByZoneId.get(zone.id);
      if (!result) continue;

      // Resolve effective SL / TP price using the same base+ATR-adjust math
      // as zone-simulator.ts. Kept inline (rather than re-using
      // computeTrailPath) because we only need the static levels and don't
      // want to walk every bar for each zone on every rule change.
      const atr = analyzeData.atrByZoneId.get(zone.id) ?? 0;
      const effSl = Math.max(
        0,
        analyzeRules.stopLossPoints + analyzeRules.slAtrAdjust * atr
      );
      const effTp = Math.max(
        0,
        analyzeRules.takeProfitPoints + analyzeRules.tpAtrAdjust * atr
      );
      const isLong = zone.direction === "Long";
      const slPrice = analyzeRules.stopLossEnabled
        ? isLong
          ? zone.start_price - effSl
          : zone.start_price + effSl
        : null;
      const tpPrice = analyzeRules.takeProfitEnabled
        ? isLong
          ? zone.start_price + effTp
          : zone.start_price - effTp
        : null;

      overlays.push({ zone, result, slPrice, tpPrice });
    }
    return overlays;
  }, [analyzeData, analyzeRules]);

  const analyzeResults = useMemo(
    () => analyzeOverlays.map((o) => o.result),
    [analyzeOverlays]
  );

  /** Tear down the analyze view back to normal practice mode. Resets all
   *  analyze state and rule values so re-entering starts clean. */
  const handleCloseAnalyze = useCallback(() => {
    setAnalyzeSection(null);
    setAnalyzeData(null);
    setAnalyzeLoading(false);
    setAnalyzeError(null);
    setAnalyzeRules(DEFAULT_SIM_RULES);
  }, []);

  // ─── Playback Timer ─────────────────────────────────────────────────────
  // setInterval drives the playback at the configured speed
  useEffect(() => {
    if (!replayState.isPlaying) return;

    const intervalMs = 1000 / replayState.speed;
    const timer = setInterval(() => {
      dispatch({ type: "STEP_FORWARD" });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [replayState.isPlaying, replayState.speed]);

  // ─── Save Progress on Pause ────────────────────────────────────────────
  // When playback transitions from playing → paused, persist the position
  const prevPlayingRef = useRef(false);
  useEffect(() => {
    if (prevPlayingRef.current && !replayState.isPlaying) {
      saveReplayProgress(session.id, replayState.currentIndex);
    }
    prevPlayingRef.current = replayState.isPlaying;
  }, [replayState.isPlaying, replayState.currentIndex, session.id]);

  // ─── Save Progress on Unmount / Tab Close ──────────────────────────────
  // beforeunload uses sendBeacon (can't call server actions synchronously),
  // unmount cleanup uses the server action directly
  useEffect(() => {
    const handleBeforeUnload = () => {
      const index = replayStateRef.current.currentIndex;
      navigator.sendBeacon(
        "/api/replay-progress",
        new Blob(
          [JSON.stringify({ sessionId: session.id, lastBarIndex: index })],
          { type: "application/json" }
        )
      );
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      // Save on component unmount (e.g. navigating back)
      saveReplayProgress(session.id, replayStateRef.current.currentIndex);
    };
  }, [session.id]);

  // ─── Process New Bars Through Practice Engine ───────────────────────────
  // When currentIndex increases, check if the new bar triggers SL/TP
  const prevIndexRef = useRef(0);
  useEffect(() => {
    const curIdx = replayState.currentIndex;
    if (curIdx > prevIndexRef.current && curIdx > 0) {
      const newBar = replayState.bars[curIdx - 1];
      if (newBar) {
        setTradingState((prev) => processBar(prev, newBar));
        setZoneState((prev) => processZoneBar(prev, newBar));
      }
    }
    // If user jumped backward, no bar processing needed
    prevIndexRef.current = curIdx;
  }, [replayState.currentIndex, replayState.bars]);

  // ─── Auto-close position at session end ─────────────────────────────────
  useEffect(() => {
    if (isAtEnd(replayState) && tradingState.openPosition && currentBar) {
      setTradingState((prev) =>
        closeAtSessionEnd(prev, currentBar.bar_close, currentBar.bar_index, currentBar.bar_time)
      );
    }
  }, [replayState.currentIndex, replayState.bars.length, tradingState.openPosition, currentBar]);

  // ─── Keyboard Shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.code) {
        case "Space":
          e.preventDefault();
          dispatch({ type: "TOGGLE_PLAY" });
          break;
        case "ArrowRight":
          e.preventDefault();
          dispatch({ type: "STEP_FORWARD" });
          break;
        case "ArrowLeft":
          e.preventDefault();
          dispatch({ type: "STEP_BACKWARD" });
          break;
        case "Equal": // + key
        case "NumpadAdd":
          e.preventDefault();
          dispatch({ type: "SET_SPEED", speed: Math.min(replayStateRef.current.speed * 2, 32) });
          break;
        case "Minus":
        case "NumpadSubtract":
          e.preventDefault();
          dispatch({ type: "SET_SPEED", speed: Math.max(replayStateRef.current.speed / 2, 1) });
          break;
        case "Home":
          e.preventDefault();
          dispatch({ type: "RESET" });
          saveReplayProgress(session.id, 0);
          break;
        // Shift+B → Place Long Zone, Shift+S → Place Short Zone
        case "KeyB":
          if (e.shiftKey && panelModeRef.current === "zone") {
            e.preventDefault();
            handlePlaceZoneRef.current("Long", targetBarsRef.current);
          }
          break;
        case "KeyS":
          if (e.shiftKey && panelModeRef.current === "zone") {
            e.preventDefault();
            handlePlaceZoneRef.current("Short", targetBarsRef.current);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ─── Trade Action Handlers ──────────────────────────────────────────────

  const handleEnterLong = useCallback(
    (slPts: number | null, tpPts: number | null) => {
      if (!currentBar) return;
      const price = currentBar.bar_close;
      const sl = slPts !== null ? price - slPts : undefined;
      const tp = tpPts !== null ? price + tpPts : undefined;
      setTradingState((prev) =>
        enterLong(prev, price, currentBar.bar_index, currentBar.bar_time, sl, tp)
      );
    },
    [currentBar]
  );

  const handleEnterShort = useCallback(
    (slPts: number | null, tpPts: number | null) => {
      if (!currentBar) return;
      const price = currentBar.bar_close;
      const sl = slPts !== null ? price + slPts : undefined;
      const tp = tpPts !== null ? price - tpPts : undefined;
      setTradingState((prev) =>
        enterShort(prev, price, currentBar.bar_index, currentBar.bar_time, sl, tp)
      );
    },
    [currentBar]
  );

  const handleExit = useCallback(() => {
    if (!currentBar) return;
    setTradingState((prev) =>
      exitPosition(prev, currentBar.bar_close, currentBar.bar_index, currentBar.bar_time)
    );
  }, [currentBar]);

  const handleUpdateSl = useCallback((price: number | null) => {
    setTradingState((prev) => updateStopLoss(prev, price));
  }, []);

  const handleUpdateTp = useCallback((price: number | null) => {
    setTradingState((prev) => updateTakeProfit(prev, price));
  }, []);

  // ─── Zone Action Handlers ───────────────────────────────────────────────

  const handlePlaceZone = useCallback(
    (direction: "Long" | "Short", targetBars: number) => {
      if (!currentBar) return;
      // Convert points inputs → absolute prices off the entry close. Long:
      // SL below / TP above; Short: SL above / TP below. When the checkbox is
      // off OR the input is empty, pass null so the chart draws no line.
      const price = currentBar.bar_close;
      const slPts = zoneSlEnabled && zoneSlPoints ? parseFloat(zoneSlPoints) : null;
      const tpPts = zoneTpEnabled && zoneTpPoints ? parseFloat(zoneTpPoints) : null;
      const slPrice =
        slPts !== null && !Number.isNaN(slPts)
          ? direction === "Long"
            ? price - slPts
            : price + slPts
          : null;
      const tpPrice =
        tpPts !== null && !Number.isNaN(tpPts)
          ? direction === "Long"
            ? price + tpPts
            : price - tpPts
          : null;
      setZoneState((prev) =>
        placeZone(prev, direction, currentBar, targetBars, slPrice, tpPrice)
      );
    },
    [currentBar, zoneSlEnabled, zoneTpEnabled, zoneSlPoints, zoneTpPoints]
  );
  const handlePlaceZoneRef = useRef(handlePlaceZone);
  handlePlaceZoneRef.current = handlePlaceZone;

  /** Save a completed zone to the trade_zones / trade_zone_bars Supabase tables */
  const handleSaveZone = useCallback(
    (zone: PracticeZone) => {
      if (zone.status !== "completed" || !zone.endPrice || !zone.endTime) return;

      // Compute per-bar analytics (MFE, MAE, drawdown, runup, etc.)
      const analytics = computeBarAnalytics(zone);

      // Build bar data matching the trade_zone_bars schema
      const barData = zone.bars.map((b, i) => ({
        bar_time: b.time,
        bar_open: b.open,
        bar_high: b.high,
        bar_low: b.low,
        bar_close: b.close,
        bar_volume: b.volume,
        bar_index: b.index,
        ...analytics[i],
      }));

      // Capture the active section id at save time via the ref so auto-saves
      // triggered after the user switches sections still use the latest value.
      const sectionIdAtSave = activeSectionIdRef.current;
      startTransition(async () => {
        const result = await saveZone(
          session.instrument,
          zone.direction,
          zone.entryTime,
          zone.endTime!,
          zone.entryPrice,
          zone.endPrice!,
          zone.pointsMove!,
          zone.durationSeconds!,
          session.timeframe,
          barData,
          sectionIdAtSave,
          zone.stopLossPrice ?? null,
          zone.takeProfitPrice ?? null,
          // hitOutcome may still be undefined on a zone saved manually before
          // processZoneBar ran its settle pass; coerce to null for the DB.
          zone.hitOutcome ?? null
        );
        if (result.success) {
          // Mark zone as saved by updating its id to include the DB id
          setZoneState((prev) => ({
            ...prev,
            zones: prev.zones.map((z) =>
              z.id === zone.id ? { ...z, id: "saved-" + z.id } : z
            ),
          }));
        }
      });
    },
    [session.instrument, session.timeframe]
  );

  // ─── Auto-save zones when they complete ─────────────────────────────────
  // With multiple concurrent zones allowed, we track the *set* of previously-
  // active ids and diff against the current set on each state update. Any id
  // that left the active set AND is now "completed" is a zone that just
  // finished this tick — fire a save for each.
  const prevActiveZoneIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prevIds = prevActiveZoneIdsRef.current;
    const currentIds = new Set(zoneState.activeZones.map((z) => z.id));

    for (const prevId of prevIds) {
      if (currentIds.has(prevId)) continue;
      const completedZone = zoneState.zones.find(
        (z) => z.id === prevId && z.status === "completed"
      );
      if (completedZone && !completedZone.id.startsWith("saved-")) {
        handleSaveZone(completedZone);
      }
    }

    prevActiveZoneIdsRef.current = currentIds;
  }, [zoneState.activeZones, zoneState.zones, handleSaveZone]);

  // ─── Save Practice Session ──────────────────────────────────────────────
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const handleSave = useCallback(() => {
    const closedTrades = tradingState.positions
      .filter((p) => p.status === "closed")
      .map((p) => ({
        direction: p.direction,
        entry_bar_index: p.entryBarIndex,
        entry_price: p.entryPrice,
        exit_bar_index: p.exitBarIndex ?? null,
        exit_price: p.exitPrice ?? null,
        stop_loss_price: p.stopLossPrice,
        take_profit_price: p.takeProfitPrice,
        pnl_points: p.pnlPoints ?? null,
        exit_reason: p.exitReason ?? null,
        entry_time: p.entryTime,
        exit_time: p.exitTime ?? null,
      }));

    if (closedTrades.length === 0) return;

    startTransition(async () => {
      const result = await savePracticeSession(
        session.id,
        closedTrades,
        tradingState.totalPnl,
        tradingState.winCount,
        tradingState.lossCount
      );
      if (result.success) {
        setSaved(true);
      }
    });
  }, [tradingState, session.id]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Session header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/replay"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back
          </Link>
          <div>
            <h2 className="text-lg font-bold text-foreground">
              {session.instrument} — {session.timeframe}
            </h2>
            <p className="text-sm text-muted-foreground">
              {new Date(session.session_date + "T00:00:00").toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted/60">
            Space = Play/Pause &nbsp;|&nbsp; &larr; &rarr; = Step &nbsp;|&nbsp; +/- = Speed
          </span>
          {/* Analyze toggle — opens the section picker modal. When the
              analyze view is already active, the button doubles as the
              close affordance so users always have one button governing
              the analyze layer. */}
          <button
            onClick={() =>
              analyzeSection ? handleCloseAnalyze() : setAnalyzePickerOpen(true)
            }
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              analyzeSection
                ? "bg-accent-green/20 text-accent-green border border-accent-green/40"
                : "bg-card border border-card-border text-foreground hover:border-muted"
            }`}
          >
            {analyzeSection ? "Close Analyze" : "Analyze"}
          </button>
          <button
            onClick={handleSave}
            disabled={isPending || saved || tradingState.positions.filter((p) => p.status === "closed").length === 0}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              saved
                ? "bg-accent-green/20 text-accent-green border border-accent-green/40"
                : "bg-card border border-card-border text-foreground hover:border-muted disabled:opacity-30 disabled:cursor-not-allowed"
            }`}
          >
            {saved ? "Saved" : isPending ? "Saving..." : "Save Session"}
          </button>
        </div>
      </div>

      {/* Main content: chart + trade panel side by side */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Chart area */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <div className="flex-1 min-h-[400px]">
            <ReplayChart
              visibleBars={visibleBars}
              positions={tradingState.positions}
              openPosition={tradingState.openPosition}
              zones={zoneState.zones}
              sessionId={session.id}
              indicatorConfigs={practiceIndicators}
              onIndicatorsChange={setPracticeIndicators}
              showActiveZoneOverlays={chartOverlays.activeZones}
              showCompletedZoneOverlays={chartOverlays.completedZones}
              showTradeOverlays={chartOverlays.trades}
              onOverlayChange={handleOverlayChange}
              analyzeOverlays={analyzeOverlays}
            />
          </div>
          <PlaybackControls
            state={replayState}
            onTogglePlay={() => dispatch({ type: "TOGGLE_PLAY" })}
            onStepForward={() => dispatch({ type: "STEP_FORWARD" })}
            onStepBackward={() => dispatch({ type: "STEP_BACKWARD" })}
            onJumpTo={(index) => dispatch({ type: "JUMP_TO", index })}
            onSetSpeed={(speed) => dispatch({ type: "SET_SPEED", speed })}
            onReset={() => {
              dispatch({ type: "RESET" });
              saveReplayProgress(session.id, 0);
            }}
          />
        </div>

        {/* Right sidebar — flips between the live trade/zone panel and the
            Analyze panel based on whether the user has confirmed a section
            in the picker. Single sidebar slot keeps the layout stable so
            the chart never resizes when the user toggles into analyze mode. */}
        <div className="w-72 shrink-0">
          {analyzeSection ? (
            <AnalyzePanel
              sectionName={analyzeSection.name}
              rules={analyzeRules}
              onRulesChange={setAnalyzeRules}
              results={analyzeResults}
              zoneCount={analyzeData?.zones.length ?? 0}
              loading={analyzeLoading}
              error={analyzeError}
              onClose={handleCloseAnalyze}
            />
          ) : (
            <TradePanel
              mode={panelMode}
              onModeChange={setPanelMode}
              tradingState={tradingState}
              zoneState={zoneState}
              currentBar={currentBar}
              onEnterLong={handleEnterLong}
              onEnterShort={handleEnterShort}
              onExit={handleExit}
              onUpdateSl={handleUpdateSl}
              onUpdateTp={handleUpdateTp}
              onPlaceZone={handlePlaceZone}
              onSaveZone={handleSaveZone}
              zoneBars={zoneBars}
              onZoneBarsChange={setZoneBars}
              targetBars={targetBars}
              zoneSlPoints={zoneSlPoints}
              zoneTpPoints={zoneTpPoints}
              zoneSlEnabled={zoneSlEnabled}
              zoneTpEnabled={zoneTpEnabled}
              onZoneSlPointsChange={setZoneSlPoints}
              onZoneTpPointsChange={setZoneTpPoints}
              onZoneSlEnabledChange={setZoneSlEnabled}
              onZoneTpEnabledChange={setZoneTpEnabled}
              sections={sections}
              activeSectionId={activeSectionId}
              onActiveSectionChange={setActiveSectionId}
            />
          )}
        </div>
      </div>

      {/* Analyze section picker — opens off the header button. Confirmation
          flips analyzeSection, which kicks off the data load effect above. */}
      {analyzePickerOpen && (
        <AnalyzeSectionPicker
          sections={sections}
          session={session}
          onCancel={() => setAnalyzePickerOpen(false)}
          onConfirm={(sectionId) => {
            const sec = sections.find((s) => s.id === sectionId) ?? null;
            setAnalyzeSection(sec);
            setAnalyzePickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
