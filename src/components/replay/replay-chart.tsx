"use client";

/**
 * ReplayChart — Lightweight-charts v5 wrapper for candlestick replay.
 *
 * Uses TradingView's lightweight-charts library for native financial chart
 * rendering with zoom, pan, crosshair, and O(1) bar append performance.
 *
 * The chart instance and series are created on mount and updated imperatively
 * as new bars are revealed by the replay engine. Entry/exit markers and
 * SL/TP price lines are managed via lightweight-charts' native APIs.
 */

import { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type SeriesMarker,
  type Time,
  ColorType,
} from "lightweight-charts";
import { ReplayBar } from "@/types/replay";
import { PracticePosition } from "@/lib/utils/practice-trading";
import { PracticeZone, isZoneVisuallyCompleted } from "@/lib/utils/zone-practice";
import { TradeZone } from "@/types/trade-zone";
import { SimZoneResult } from "@/lib/utils/zone-simulator";
import { rawTimestampToUnix } from "@/lib/utils/format";
import { useChartDrawings } from "@/hooks/use-chart-drawings";
import { useChartIndicators } from "@/hooks/use-chart-indicators";
import DrawingToolbar from "@/components/charts/drawing-toolbar";
import DrawingOverlay from "@/components/charts/drawing-overlay";
import IndicatorPanel from "@/components/charts/indicator-panel";
import ChartOverlayToggles from "./chart-overlay-toggles";
import VolumeProfileOverlay from "./volume-profile-overlay";
import type { VolumeProfile } from "@/lib/utils/volume-profile";
import type { IndicatorConfig } from "@/types/indicators";

/**
 * One analyzed zone overlay sourced from the practice-mode "Analyze" view.
 * Bundles the TradeZone (entry context), the simulator's exit decision under
 * the user's current SL/TP/TSL rules, and the resolved SL/TP price levels so
 * the chart can render a per-zone segment without re-running the simulator.
 */
export interface AnalyzeOverlay {
  zone: TradeZone;
  result: SimZoneResult;
  /** Resolved SL price (entry-relative + ATR), or null when the rule is off. */
  slPrice: number | null;
  /** Resolved TP price (entry-relative + ATR), or null when the rule is off. */
  tpPrice: number | null;
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface ReplayChartProps {
  /** Bars to display (grows as replay advances) */
  visibleBars: ReplayBar[];
  /** All positions (open + closed) for overlay markers */
  positions: PracticePosition[];
  /** Currently open position for SL/TP lines */
  openPosition: PracticePosition | null;
  /** Practice zones to render as rectangles */
  zones?: PracticeZone[];
  /** Replay session id — used as the drawings resetKey so swapping
   *  sessions wipes user-drawn annotations. */
  sessionId?: string;
  /** Indicator configs for the practice chart. Persisted by the parent
   *  in `trader_preferences.practice_indicators`. When omitted (e.g.
   *  the post-session review chart) no indicator panel renders and no
   *  series are added. */
  indicatorConfigs?: IndicatorConfig[];
  /** Emits a new configs array whenever the panel makes an edit.
   *  Parent debounce-saves to Supabase. When omitted, the panel UI is
   *  hidden (read-only or historical contexts). */
  onIndicatorsChange?: (next: IndicatorConfig[]) => void;
  /** Whether to render overlays (entry arrow, slanted line, SL/TP price
   *  lines) for zones still playing out. Defaults to true. */
  showActiveZoneOverlays?: boolean;
  /** Whether to render overlays (entry arrow, PnL completion circle, and
   *  slanted entry→exit line) for zones that have finished. Defaults to true. */
  showCompletedZoneOverlays?: boolean;
  /** Whether to render trade overlays (position entry/exit markers and
   *  open-position SL/TP price lines). Defaults to true when omitted. */
  showTradeOverlays?: boolean;
  /** Handler for the floating overlay toggle chips. When omitted, the
   *  floating toolbar is not rendered (e.g. historical review screens
   *  that don't own preferences persistence). */
  onOverlayChange?: (
    key: "activeZones" | "completedZones" | "trades",
    value: boolean
  ) => void;
  /** Analyzed zones from the practice-mode "Analyze" view. When non-empty
   *  the chart layers an entry→exit segment, SL/TP price segments, and
   *  entry/exit markers onto each zone — independent of the
   *  active/completed practice-zone overlays above. Empty / undefined →
   *  the analyze layer is skipped entirely. */
  analyzeOverlays?: AnalyzeOverlay[];
  /** Optional volume profile to render as a left-edge histogram. The
   *  overlay polls `series.priceToCoordinate()` on every animation
   *  frame so the bars stay glued to the price scale across pan/zoom.
   *  Pass `null` (or omit) to hide the layer entirely. Computation
   *  happens upstream — typically the tick viewer reduces parsed
   *  ticks via `computeVolumeProfile` and feeds the result here. */
  volumeProfile?: VolumeProfile | null;
  /** Render bid/ask side as stacked sub-bars within each level. Has
   *  no effect when the underlying ticks lack side attribution
   *  (Kinetick quote-stream gotcha — most ticks are unattributed and
   *  the level falls back to a single neutral bar). Defaults to true. */
  volumeProfileSplitBidAsk?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert a ReplayBar to lightweight-charts CandlestickData */
function barToCandle(bar: ReplayBar): CandlestickData<Time> {
  return {
    time: rawTimestampToUnix(bar.bar_time) as Time,
    open: bar.bar_open,
    high: bar.bar_high,
    low: bar.bar_low,
    close: bar.bar_close,
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ReplayChart({
  visibleBars,
  positions,
  openPosition,
  zones = [],
  sessionId,
  indicatorConfigs,
  onIndicatorsChange,
  showActiveZoneOverlays = true,
  showCompletedZoneOverlays = true,
  showTradeOverlays = true,
  onOverlayChange,
  analyzeOverlays,
  volumeProfile,
  volumeProfileSplitBidAsk = true,
}: ReplayChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** Track how many bars have been set to only append new ones */
  const renderedCountRef = useRef(0);
  /** Markers plugin ref for v5 API */
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /** Track SL/TP price lines to remove on update */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slLineRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tpLineRef = useRef<any>(null);
  /** Zone SL/TP price lines — one pair per *active* zone. Cleared as each
   *  zone completes; completed zones already have their own entry→exit line
   *  telling the outcome story. Arrays so multiple concurrent zones can each
   *  show their own SL / TP lines on the price axis. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zoneSlLinesRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zoneTpLinesRef = useRef<any[]>([]);
  /** Zone line series — one per zone, removed and recreated on update */
  const zoneLineSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  /** Analyze-overlay line series — one entry/SL/TP per analyzed zone. Cleared
   *  and recreated on every analyzeOverlays change so SL/TP/TSL adjustments
   *  in the AnalyzePanel produce a clean re-render with no stale lines. */
  const analyzeLineSeriesRef = useRef<ISeriesApi<"Line">[]>([]);

  // ─── Chart Creation (once on mount) ─────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#111118" },
        textColor: "#a1a1aa",
        fontFamily: "Arial, Helvetica, sans-serif",
      },
      grid: {
        vertLines: { color: "#1e1e2a" },
        horzLines: { color: "#1e1e2a" },
      },
      crosshair: {
        mode: 0, // Normal crosshair
      },
      rightPriceScale: {
        borderColor: "#1e1e2a",
      },
      timeScale: {
        borderColor: "#1e1e2a",
        timeVisible: true,
        secondsVisible: true,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#ffffff",
      downColor: "transparent",
      borderUpColor: "#ffffff",
      borderDownColor: "#ffffff",
      wickUpColor: "#ffffff",
      wickDownColor: "#ffffff",
    });

    // Create markers plugin (v5 API — replaces series.setMarkers)
    const markers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;
    renderedCountRef.current = 0;

    // Handle resize
    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      renderedCountRef.current = 0;
    };
  }, []);

  // ─── Bar Updates (append new bars incrementally) ────────────────────────

  /** Last rendered bar's `bar_time` — used to detect when the incoming bars
   *  are a continuation of what's already on the chart (practice mode
   *  revealing one more bar) vs. a wholesale different set (tick viewer
   *  switching timeframe → completely new bucket boundaries). Without this
   *  signal, calling `series.update()` with timestamps that don't extend
   *  the existing oldest bar throws "Cannot update oldest data". */
  const lastBarTimeRef = useRef<string | null>(null);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const prevCount = renderedCountRef.current;
    const newCount = visibleBars.length;

    // Continuation check: do the incoming bars start where the previous set
    // left off? Yes if we haven't rendered anything yet (prevCount===0), or
    // if the bar at the seam (prevCount-1) has the same timestamp as the
    // last bar we rendered. Mismatch means we're looking at a different
    // data set (e.g. timeframe swap) and must reset wholesale.
    const isContinuation =
      prevCount === 0 ||
      (newCount >= prevCount &&
        visibleBars[prevCount - 1]?.bar_time === lastBarTimeRef.current);

    if (!isContinuation || newCount < prevCount) {
      // Wholesale-different bars OR a backward step — replace everything.
      const candles = visibleBars.map(barToCandle);
      series.setData(candles);
    } else if (newCount > prevCount) {
      // Same data set, more bars revealed — incremental append (O(1) per bar).
      for (let i = prevCount; i < newCount; i++) {
        series.update(barToCandle(visibleBars[i]));
      }
      // Auto-scroll to latest bar so users see the newly revealed candle.
      if (chartRef.current) {
        chartRef.current.timeScale().scrollToRealTime();
      }
    }
    // newCount === prevCount && isContinuation → identical data, no-op.

    renderedCountRef.current = newCount;
    lastBarTimeRef.current = newCount > 0 ? visibleBars[newCount - 1].bar_time : null;
  }, [visibleBars]);

  // ─── Trade Markers (entry/exit arrows and circles) ─────────────────────

  const updateMarkers = useCallback(() => {
    const markersPlugin = markersRef.current;
    if (!markersPlugin || visibleBars.length === 0) return;

    const markerList: SeriesMarker<Time>[] = [];

    // Trade (position) markers — hidden when the "Trades" overlay toggle is off.
    if (showTradeOverlays) {
      for (const pos of positions) {
        // Entry marker — only show if the entry bar is visible
        const entryBar = visibleBars.find((b) => b.bar_index === pos.entryBarIndex);
        if (entryBar) {
          markerList.push({
            time: (Math.floor(rawTimestampToUnix(entryBar.bar_time))) as Time,
            position: pos.direction === "Long" ? "belowBar" : "aboveBar",
            color: "#f59e0b",
            shape: pos.direction === "Long" ? "arrowUp" : "arrowDown",
            text: pos.direction === "Long" ? "BUY" : "SELL",
          });
        }

        // Exit marker — only show if closed and exit bar is visible
        if (pos.status === "closed" && pos.exitBarIndex !== undefined) {
          const exitBar = visibleBars.find((b) => b.bar_index === pos.exitBarIndex);
          if (exitBar) {
            const pnl = pos.pnlPoints ?? 0;
            markerList.push({
              time: (Math.floor(rawTimestampToUnix(exitBar.bar_time))) as Time,
              position: pos.direction === "Long" ? "aboveBar" : "belowBar",
              color: pnl >= 0 ? "#22c55e" : "#ef4444",
              shape: "circle",
              text: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
            });
          }
        }
      }
    }

    // Zone markers — gated on the zone's "visual" completion state rather
    // than raw engine status, so a still-playing zone that's already hit
    // TP/SL follows the Completed Zones toggle (matches the trader's mental
    // model: trade is decided once a level is touched).
    for (const zone of zones) {
      const zoneVisible = isZoneVisuallyCompleted(zone)
        ? showCompletedZoneOverlays
        : showActiveZoneOverlays;
      if (!zoneVisible) continue;

      const entryBar = visibleBars.find((b) => b.bar_index === zone.entryBarIndex);
      if (entryBar) {
        markerList.push({
          time: (Math.floor(rawTimestampToUnix(entryBar.bar_time))) as Time,
          position: zone.direction === "Long" ? "belowBar" : "aboveBar",
          color: "#8b5cf6", // Purple for zones
          shape: zone.direction === "Long" ? "arrowUp" : "arrowDown",
          text: `${zone.direction} Zone`,
        });
      }

      if (zone.status === "completed" && zone.endTime) {
        const endBar = visibleBars.find((b) => b.bar_time === zone.endTime);
        if (endBar) {
          const pnl = zone.pointsMove ?? 0;
          markerList.push({
            time: (Math.floor(rawTimestampToUnix(endBar.bar_time))) as Time,
            position: zone.direction === "Long" ? "aboveBar" : "belowBar",
            color: pnl >= 0 ? "#22c55e" : "#ef4444",
            shape: "circle",
            text: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
          });
        }
      }
    }

    // Analyze-overlay markers — entry arrow + simulated-exit circle per zone.
    // Mirrors the practice-zone marker shape (arrowUp/Down + circle) but uses
    // a distinct cyan accent so the user can tell at a glance which markers
    // came from the analyze view vs zones drawn live during practice. The
    // exit circle's text is the simulator's per-contract exit P&L plus its
    // exit reason (TP / SL / TRAIL / etc.) so each trade's outcome is legible.
    if (analyzeOverlays && analyzeOverlays.length > 0) {
      for (const ov of analyzeOverlays) {
        const { zone, result } = ov;

        const entryBar = visibleBars.find((b) => b.bar_time === zone.start_time);
        if (entryBar) {
          markerList.push({
            time: Math.floor(rawTimestampToUnix(entryBar.bar_time)) as Time,
            position: zone.direction === "Long" ? "belowBar" : "aboveBar",
            color: "#06b6d4",
            shape: zone.direction === "Long" ? "arrowUp" : "arrowDown",
            text: zone.direction === "Long" ? "L" : "S",
          });
        }

        // Exit marker — `result.exitTime` is the bar_time of whichever bar the
        // simulator decided was the exit (TP/SL/Trail/end). It may not be in
        // visibleBars if the user has stepped backward past the exit bar; in
        // that case we just skip rendering the exit marker for that zone.
        const exitBar = visibleBars.find((b) => b.bar_time === result.exitTime);
        if (exitBar) {
          const pnl = result.exitPoints;
          markerList.push({
            time: Math.floor(rawTimestampToUnix(exitBar.bar_time)) as Time,
            position: zone.direction === "Long" ? "aboveBar" : "belowBar",
            color: pnl >= 0 ? "#22c55e" : "#ef4444",
            shape: "circle",
            text: `${result.exitReason.toUpperCase()} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}`,
          });
        }
      }
    }

    // Sort by time (required by lightweight-charts)
    markerList.sort((a, b) => (a.time as number) - (b.time as number));
    markersPlugin.setMarkers(markerList);
  }, [
    positions,
    visibleBars,
    zones,
    showActiveZoneOverlays,
    showCompletedZoneOverlays,
    showTradeOverlays,
    analyzeOverlays,
  ]);

  useEffect(() => {
    updateMarkers();
  }, [updateMarkers]);

  // ─── SL/TP Price Lines ────────────────────────────────────────────────

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Remove existing lines
    if (slLineRef.current) {
      series.removePriceLine(slLineRef.current);
      slLineRef.current = null;
    }
    if (tpLineRef.current) {
      series.removePriceLine(tpLineRef.current);
      tpLineRef.current = null;
    }

    // Add lines for open position — skipped entirely when the "Trades"
    // overlay toggle is off so the user can hide all trade chrome at once.
    if (showTradeOverlays && openPosition) {
      if (openPosition.stopLossPrice !== null) {
        slLineRef.current = series.createPriceLine({
          price: openPosition.stopLossPrice,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "SL",
        });
      }
      if (openPosition.takeProfitPrice !== null) {
        tpLineRef.current = series.createPriceLine({
          price: openPosition.takeProfitPrice,
          color: "#22c55e",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "TP",
        });
      }
    }
  }, [openPosition, showTradeOverlays]);

  // ─── Zone SL/TP Price Lines (visual only, all active zones) ──────────
  //
  // Mirrors the open-position SL/TP block above but sources levels from every
  // zone currently in "active" status. These are purely informational — the
  // zone engine never consults them for exit logic. Lines disappear as each
  // zone completes so the completed zone's own entry→exit line (drawn below)
  // is the only thing on-chart for finished zones.
  //
  // Depend on a signature string so the effect re-runs when any active zone's
  // SL or TP changes, or when zones enter/leave the active set.

  // Zone SL/TP price lines — drawn for every zone (active and completed) so
  // the user can see where each zone's planned risk levels sit on the price
  // axis. Gated per-zone by visual completion (status OR hitOutcome) so a
  // zone that just hit SL/TP follows the Completed Zones toggle immediately.
  // Key includes hitOutcome so the transition from "no hit" → "hit" re-runs
  // the effect and re-buckets the lines.
  const activeZoneSlTpKey =
    (showActiveZoneOverlays ? "a" : "_") +
    (showCompletedZoneOverlays ? "c" : "_") +
    "|" +
    zones
      .map(
        (z) =>
          `${z.id}:${z.status}:${z.hitOutcome ?? ""}:${z.stopLossPrice ?? ""}:${z.takeProfitPrice ?? ""}`
      )
      .join("|");

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of zoneSlLinesRef.current) series.removePriceLine(line);
    for (const line of zoneTpLinesRef.current) series.removePriceLine(line);
    zoneSlLinesRef.current = [];
    zoneTpLinesRef.current = [];

    if (!showActiveZoneOverlays && !showCompletedZoneOverlays) return;

    for (const zone of zones) {
      const zoneVisible = isZoneVisuallyCompleted(zone)
        ? showCompletedZoneOverlays
        : showActiveZoneOverlays;
      if (!zoneVisible) continue;
      if (zone.stopLossPrice != null) {
        zoneSlLinesRef.current.push(
          series.createPriceLine({
            price: zone.stopLossPrice,
            color: "#ef4444",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "Zone SL",
          })
        );
      }
      if (zone.takeProfitPrice != null) {
        zoneTpLinesRef.current.push(
          series.createPriceLine({
            price: zone.takeProfitPrice,
            color: "#22c55e",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "Zone TP",
          })
        );
      }
    }
    // zones is the source of truth; activeZoneSlTpKey only exists to trigger
    // a re-run when SL/TP values mutate on an already-active zone or when
    // the visibility toggle flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeZoneSlTpKey]);

  // ─── Zone Lines (entry → exit) ──────────────────────────────────────

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old zone line series — always, so flipping either toggle off
    // clears anything already drawn.
    for (const ls of zoneLineSeriesRef.current) {
      chart.removeSeries(ls);
    }
    zoneLineSeriesRef.current = [];

    // Fast-out when both flags are off; skipping the loop is a minor perf win.
    if (!showActiveZoneOverlays && !showCompletedZoneOverlays) return;

    // Draw a line for each zone that has at least 2 bars visible, gated by
    // visual completion so an SL/TP-hit zone follows the Completed Zones
    // toggle immediately even if it's still collecting bars.
    for (const zone of zones) {
      const zoneVisible = isZoneVisuallyCompleted(zone)
        ? showCompletedZoneOverlays
        : showActiveZoneOverlays;
      if (!zoneVisible) continue;
      if (zone.bars.length < 2) continue;

      const entryBar = visibleBars.find((b) => b.bar_index === zone.entryBarIndex);
      if (!entryBar) continue;

      // Determine the last visible bar of the zone
      const lastZoneBar = zone.bars[zone.bars.length - 1];
      const exitBarVisible = visibleBars.find((b) => b.bar_time === lastZoneBar.time);
      if (!exitBarVisible) continue;

      const color = zone.direction === "Long" ? "#22c55e" : "#ef4444";

      const lineSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: zone.status === "active" ? 1 : 0, // Dashed if active, solid if completed
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      // Line data: entry price at entry time → last bar close at last bar time
      lineSeries.setData([
        {
          time: rawTimestampToUnix(entryBar.bar_time) as Time,
          value: zone.entryPrice,
        },
        {
          time: rawTimestampToUnix(exitBarVisible.bar_time) as Time,
          value: lastZoneBar.close,
        },
      ]);

      zoneLineSeriesRef.current.push(lineSeries);
    }
  }, [zones, visibleBars, showActiveZoneOverlays, showCompletedZoneOverlays]);

  // ─── Analyze Overlays (entry→exit + SL + TP per zone) ──────────────
  //
  // Each AnalyzeOverlay paints up to three short LineSeries on the chart,
  // bounded to the trade's actual entry→exit window:
  //   1. Direction line  — entry price → simulated exit price (green/red).
  //   2. SL line         — flat segment at slPrice, dashed red.
  //   3. TP line         — flat segment at tpPrice, dashed green.
  // Using LineSeries (not createPriceLine) keeps each level constrained to
  // the zone's time range so a chart full of analyzed trades doesn't become
  // a wall of full-width horizontal lines. Lines are removed and recreated
  // on every overlay change — re-running the simulator (e.g. when the user
  // tweaks SL/TP) yields a clean redraw with no stale segments left behind.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Clear prior lines unconditionally so toggling analyze off (overlays
    // becomes empty / undefined) wipes the layer.
    for (const ls of analyzeLineSeriesRef.current) {
      chart.removeSeries(ls);
    }
    analyzeLineSeriesRef.current = [];

    if (!analyzeOverlays || analyzeOverlays.length === 0) return;

    for (const ov of analyzeOverlays) {
      const { zone, result, slPrice, tpPrice } = ov;

      // Both endpoints must be visible to draw a meaningful segment. If the
      // user has stepped back past the entry bar OR the exit bar, just skip
      // this zone's overlay this render — markers will reappear when bars do.
      const entryBar = visibleBars.find((b) => b.bar_time === zone.start_time);
      const exitBar = visibleBars.find((b) => b.bar_time === result.exitTime);
      if (!entryBar || !exitBar) continue;

      const entryT = rawTimestampToUnix(entryBar.bar_time) as Time;
      const exitT = rawTimestampToUnix(exitBar.bar_time) as Time;

      // Walk back the absolute exit price from the simulator's per-contract
      // points. exitPoints is direction-aware (positive = profitable trade)
      // so for a Long the exit price is entry+exitPoints, for a Short it's
      // entry−exitPoints. Matches how zone-simulator.ts derives exitPnl.
      const isLong = zone.direction === "Long";
      const exitPrice = isLong
        ? zone.start_price + result.exitPoints
        : zone.start_price - result.exitPoints;

      // Direction (entry → exit) line — green when the trade made money,
      // red when it lost. Solid 2px so it stands out against the dashed
      // SL/TP lines below.
      const dirLine = chart.addSeries(LineSeries, {
        color: result.exitPoints >= 0 ? "#22c55e" : "#ef4444",
        lineWidth: 2,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      dirLine.setData([
        { time: entryT, value: zone.start_price },
        { time: exitT, value: exitPrice },
      ]);
      analyzeLineSeriesRef.current.push(dirLine);

      // SL segment — only when the rule is on for the current sim. Same
      // dashed style as the live trading SL price line so the visual
      // language is consistent across the two views.
      if (slPrice != null) {
        const slLine = chart.addSeries(LineSeries, {
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        slLine.setData([
          { time: entryT, value: slPrice },
          { time: exitT, value: slPrice },
        ]);
        analyzeLineSeriesRef.current.push(slLine);
      }

      // TP segment — same treatment, in green.
      if (tpPrice != null) {
        const tpLine = chart.addSeries(LineSeries, {
          color: "#22c55e",
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        tpLine.setData([
          { time: entryT, value: tpPrice },
          { time: exitT, value: tpPrice },
        ]);
        analyzeLineSeriesRef.current.push(tpLine);
      }
    }
  }, [analyzeOverlays, visibleBars]);

  // ─── Drawing tools (shared hook with live chart) ────────────────────
  // Renders a floating toolbar + SVG overlay for user-drawn annotations.
  // Drawings are wiped whenever the session changes so the replay page's
  // session swapper doesn't leak stale lines across sessions.
  const drawings = useChartDrawings({
    chartRef,
    seriesRef,
    containerRef,
    resetKey: sessionId ?? "no-session",
  });

  // ─── Indicators (shared hook with live chart) ───────────────────────
  // Scoped per session via resetKey so swapping replay sessions wipes
  // the series cleanly. Uses the same computation + pane layout as
  // the live chart (SMA/EMA overlay on pane 0; Volume/ATR/ADX in
  // stacked sub-panes below).
  useChartIndicators({
    chartRef,
    seriesRef,
    bars: visibleBars,
    configs: indicatorConfigs ?? [],
    resetKey: sessionId ?? "no-session",
  });

  const selectedDrawing = drawings.drawings.find((d) => d.id === drawings.selectedId) ?? null;

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="relative w-full h-full min-h-[400px] rounded-lg overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
      <DrawingToolbar
        activeTool={drawings.activeTool}
        selectedDrawing={selectedDrawing}
        onSelectTool={drawings.setActiveTool}
        onDeleteSelected={() => {
          if (drawings.selectedId) drawings.deleteDrawing(drawings.selectedId);
        }}
        onClearAll={drawings.clearAll}
        onChangeSelectedColor={(color) => {
          if (drawings.selectedId) drawings.setDrawingColor(drawings.selectedId, color);
        }}
      />
      {/* Overlay visibility toggles — only shown in the live replay context
          (where the parent wires the onOverlayChange handler). Historical
          review screens that mount ReplayChart for read-only inspection
          don't pass a handler and don't get the chips. */}
      {onOverlayChange && (
        <ChartOverlayToggles
          showActiveZones={showActiveZoneOverlays}
          showCompletedZones={showCompletedZoneOverlays}
          showTrades={showTradeOverlays}
          onChange={onOverlayChange}
        />
      )}
      <DrawingOverlay
        drawings={drawings.drawings}
        selectedId={drawings.selectedId}
        hoverPoint={drawings.hoverPoint}
        pendingDraw={drawings.pendingDraw}
        projection={drawings.projection}
        projectionVersion={drawings.projectionVersion}
        width={drawings.containerSize.width}
        height={drawings.containerSize.height}
      />
      {/* Volume profile — rendered after the drawing overlay so the
          drawing tools' click targets sit on top, but before the
          indicator/toggle chrome so the floating UI buttons remain on
          top of the histogram. Skipped entirely when the parent isn't
          providing profile data. */}
      {volumeProfile && (
        <VolumeProfileOverlay
          profile={volumeProfile}
          seriesRef={seriesRef}
          width={drawings.containerSize.width}
          height={drawings.containerSize.height}
          splitBidAsk={volumeProfileSplitBidAsk}
        />
      )}
      {/* Indicator panel — only rendered when the parent wires a
          change handler (i.e. on the live practice trader, not on the
          historical session-detail view). */}
      {onIndicatorsChange && (
        <IndicatorPanel
          configs={indicatorConfigs ?? []}
          onChange={onIndicatorsChange}
        />
      )}
    </div>
  );
}
