"use client";

/**
 * LiveChart — Real-time candlestick chart for live trading.
 *
 * Same lightweight-charts v5 setup as replay-chart.tsx but driven by
 * Supabase Realtime bar INSERTs instead of replay engine steps.
 * Shows SL/TP price lines from live_state and a last-price line.
 */

import { useEffect, useRef, useCallback, useState, type MutableRefObject } from "react";
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
import { LiveBar, LiveState } from "@/types/live";
import { Trade } from "@/types/trade";
import { rawTimestampToUnix } from "@/lib/utils/format";
import { useChartDrawings } from "@/hooks/use-chart-drawings";
import { useChartIndicators } from "@/hooks/use-chart-indicators";
import DrawingToolbar from "@/components/charts/drawing-toolbar";
import DrawingOverlay from "@/components/charts/drawing-overlay";
import IndicatorPanel from "@/components/charts/indicator-panel";
import { triggerAlert } from "@/hooks/use-alert-notifications";
import type { IndicatorConfig } from "@/types/indicators";

interface LiveChartProps {
  /** All bars (initial + streamed) */
  bars: LiveBar[];
  /** Current position + working orders */
  liveState: LiveState | null;
  /** Latest tick price (used for initial render / Supabase mode) */
  lastPrice: number | null;
  /** Shared ref holding the latest tick price — written by WS handler,
   *  read by the chart's own RAF loop for zero-latency updates.
   *  When null (Supabase mode), falls back to lastPrice prop. */
  priceRef?: MutableRefObject<number | null>;
  /** Today's completed trades to display as markers */
  trades?: Trade[];
  /** Active timeframe string — used for forming bar time offset and countdown */
  timeframe: string;
  /** Active instrument label (e.g. "NQ MAR25") — used together with timeframe
   *  as the drawings reset key so user-drawn annotations clear on switch. */
  instrument?: string;
  /** Callbacks for dragging SL/TP to new prices */
  onModifySl?: (newPrice: number) => void;
  onModifyTp?: (newPrice: number) => void;
  /** When true, render dashed preview SL/TP lines (Long + Short) at
   *  ±previewSlPoints / ±previewTpPoints from the current price while no
   *  position is open. Lets the trader see where their stop and target
   *  would land before clicking Buy/Sell. */
  showPreviewSlTp?: boolean;
  /** Stop-loss distance in points used by the preview lines. Must mirror
   *  the value in LiveTradePanel's SL input — LiveTrader lifts the input
   *  state so this prop reacts immediately to user edits. */
  previewSlPoints?: number | null;
  /** Take-profit distance in points used by the preview lines. Mirror of
   *  LiveTradePanel's TP input, lifted through LiveTrader. */
  previewTpPoints?: number | null;
  /** Indicator configs for this chart. The useChartIndicators hook
   *  reconciles series on every change (add/remove/toggle/recolor/
   *  period). Persisted by the parent via trader_preferences. */
  indicatorConfigs?: IndicatorConfig[];
  /** Emits a new indicator configs array whenever the panel makes an
   *  edit. Parent merges + debounce-saves to Supabase. */
  onIndicatorsChange?: (next: IndicatorConfig[]) => void;
}

/** Convert a timeframe display string to its duration in seconds */
function timeframeToSeconds(tf: string): number {
  switch (tf) {
    case "15 Second": return 15;
    case "1 Minute":  return 60;
    case "5 Minute":  return 300;
    case "15 Minute": return 900;
    default:          return 15;
  }
}

/** Format a remaining-seconds count as MM:SS for the bar countdown pill. */
function formatCountdown(secs: number): string {
  const safe = Math.max(0, secs);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Convert a LiveBar to lightweight-charts CandlestickData */
function barToCandle(bar: LiveBar): CandlestickData<Time> {
  return {
    time: rawTimestampToUnix(bar.bar_time) as Time,
    open: bar.bar_open,
    high: bar.bar_high,
    low: bar.bar_low,
    close: bar.bar_close,
  };
}

export default function LiveChart({ bars, liveState, lastPrice, priceRef, trades, timeframe, instrument, onModifySl, onModifyTp, showPreviewSlTp, previewSlPoints, previewTpPoints, indicatorConfigs, onIndicatorsChange }: LiveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Bar countdown pill — positioned imperatively to follow the current price label
   *  on the right price scale (TradingView-style). The text content is bound to
   *  React state (updated ~4×/sec); the Y position is updated every animation
   *  frame to ride along with the amber price line without forcing re-renders. */
  const countdownOverlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  /** Track the forming bar OHLC built from tick prices */
  const formingBarRef = useRef<{ open: number; high: number; low: number; close: number; time: number } | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** Number of bars currently rendered in the candlestick series. Used to detect
   *  when the incoming bars array has shrunk (e.g. data clean / reseed) so we can
   *  fall back to setData() instead of an incremental update(). */
  const renderedCountRef = useRef(0);
  /** Unix time of the first bar currently in the chart series. */
  const firstRenderedTimeRef = useRef<number>(0);
  /** Unix time of the most recent bar pushed to the series via setData()/update().
   *  We only call series.update() for bars whose time is strictly greater than this,
   *  which makes the chart tolerant of duplicates, out-of-order arrivals, and races
   *  between the realtime subscription and the post-clean refetch in live-trader.tsx. */
  const lastRenderedTimeRef = useRef<number>(0);
  /** Track whether initial bar data has been loaded (to avoid resetting viewport on subsequent bars) */
  const initialLoadDoneRef = useRef(false);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /** Line series for trade entry→exit lines (one per closed trade) */
  const tradeLineSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  /** Drag state: which line is being dragged ("sl" | "tp" | null) */
  const draggingRef = useRef<"sl" | "tp" | null>(null);
  const dragPriceRef = useRef<number>(0);
  /** Refs for callback + price access from chart event handlers (avoids stale closures) */
  const modifySlRef = useRef(onModifySl);
  modifySlRef.current = onModifySl;
  const modifyTpRef = useRef(onModifyTp);
  modifyTpRef.current = onModifyTp;
  /** Instrument label mirrored into a ref so the RAF tick loop (which
   *  only re-binds when priceRef changes) reads the current value when
   *  firing an alert, not the value captured at mount. */
  const instrumentRef = useRef(instrument);
  instrumentRef.current = instrument;
  const currentSlPriceRef = useRef<number>(0);
  const currentTpPriceRef = useRef<number>(0);
  // Primary SL/TP line refs — used by drag interaction (first bracket only)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slLineRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tpLineRef = useRef<any>(null);
  // All bracket price lines (entry + SL + TP for each bracket)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bracketLinesRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLineRef = useRef<any>(null);
  // Dashed preview SL/TP lines (Long + Short). Rendered when no position
  // is open and the "Show preview SL/TP lines" setting is on. Stored as a
  // plain array so teardown iterates uniformly regardless of count.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const previewLinesRef = useRef<any[]>([]);
  /** Cached forming time derived from bars — updated when bars change */
  const formingTimeRef = useRef<number>(0);

  // ─── Drawing tools (shared hook with replay chart) ───────────────────
  // Exposes state for the floating toolbar + SVG overlay and returns
  // `activeToolRef` so the SL/TP drag handler below can skip itself
  // while a drawing tool is active. `resetKey` wipes drawings whenever
  // the user switches instrument or timeframe — stale annotations on a
  // different price scale would be misleading.
  const drawings = useChartDrawings({
    chartRef,
    seriesRef,
    containerRef,
    resetKey: `${instrument ?? "?"}|${timeframe}`,
  });

  // ─── Indicators (shared hook with replay chart) ─────────────────────
  // Reconciles SMA/EMA/Volume/ATR/ADX series against `indicatorConfigs`.
  // Sub-pane indicators (Volume, ATR, ADX) get their own panes stacked
  // below the price pane; overlays (SMA, EMA) render on pane 0.
  // Pane indices are recomputed on every enable/disable so the layout
  // stays tight with no orphan panes. resetKey mirrors the drawings
  // reset so switching instrument/timeframe wipes series cleanly.
  useChartIndicators({
    chartRef,
    seriesRef,
    bars,
    configs: indicatorConfigs ?? [],
    resetKey: `${instrument ?? "?"}|${timeframe}`,
  });

  // ─── Internal RAF loop — reads priceRef directly for zero-latency updates ──
  // When priceRef is provided (WebSocket mode), this loop runs every frame
  // and pushes the latest tick price to the chart canvas + price line
  // without any React re-renders.
  const lastTickPriceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!priceRef) return; // Supabase mode — no RAF loop needed

    let running = true;

    const tick = () => {
      if (!running) return;

      const price = priceRef.current;
      const series = seriesRef.current;
      const ft = formingTimeRef.current;

      if (price !== null && series && ft !== 0 && price !== lastTickPriceRef.current) {
        // Capture the previous tick before overwriting so the alert
        // cross-check below knows where we came from. First frame the
        // previous is null → no alert fires (can't cross from nothing).
        const prev = lastTickPriceRef.current;
        lastTickPriceRef.current = price;

        // ─── Alert cross-check ───────────────────────────────────────
        // Runs before the chart update so the alert feels synchronous
        // with the price tick. Iterates only armed alerts; a two-sided
        // cross check (prev < level ≤ curr OR prev > level ≥ curr)
        // catches gaps that step over the level without an exact match.
        if (prev !== null) {
          const allDrawings = drawings.drawingsRef.current;
          for (const d of allDrawings) {
            if (d.kind !== "alert" || !d.armed) continue;
            const level = d.price;
            const crossedUp = prev < level && price >= level;
            const crossedDown = prev > level && price <= level;
            if (!crossedUp && !crossedDown) continue;
            // Disarm first so concurrent firings on the same tick can't
            // re-enter this branch for the same alert.
            drawings.fireAlert(d.id);
            triggerAlert({
              id: d.id,
              instrument: instrumentRef.current ?? "?",
              price: level,
              direction: crossedUp ? "up" : "down",
              triggeredAt: Date.now(),
            });
          }
        }

        // Update forming bar OHLC
        const forming = formingBarRef.current;
        if (!forming || forming.time !== ft) {
          formingBarRef.current = {
            open: price, high: price, low: price, close: price,
            time: ft,
          };
        } else {
          if (price > forming.high) forming.high = price;
          if (price < forming.low) forming.low = price;
          forming.close = price;
        }

        // Push to chart canvas directly (no React render)
        const fb = formingBarRef.current!;
        try {
          series.update({
            time: fb.time as Time,
            open: fb.open, high: fb.high, low: fb.low, close: fb.close,
          });
        } catch { /* time ordering — skip */ }

        // Update price line in place (avoid remove+recreate)
        if (priceLineRef.current) {
          try {
            priceLineRef.current.applyOptions({ price });
          } catch {
            // Price line ref is stale — explicitly remove from series and clear ref
            try { series.removePriceLine(priceLineRef.current!); } catch { /* already gone */ }
            priceLineRef.current = null;
          }
        }
        if (!priceLineRef.current) {
          priceLineRef.current = series.createPriceLine({
            price,
            color: "#f59e0b",
            lineWidth: 1,
            lineStyle: 1,
            axisLabelVisible: true,
            title: "",
          });
        }

        // Slide the bar-countdown pill to sit just under the amber price label.
        // priceToCoordinate returns the Y pixel of `price` inside the chart pane.
        const overlay = countdownOverlayRef.current;
        if (overlay) {
          const y = series.priceToCoordinate(price);
          if (y !== null) {
            overlay.style.transform = `translateY(${y + 14}px)`;
            overlay.style.visibility = "visible";
          } else {
            overlay.style.visibility = "hidden";
          }
        }
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    return () => {
      running = false;
      // Remove the price line from the series on cleanup so it doesn't
      // persist as an orphan if this effect re-runs.
      if (priceLineRef.current && seriesRef.current) {
        try { seriesRef.current.removePriceLine(priceLineRef.current); } catch { /* noop */ }
        priceLineRef.current = null;
      }
    };
  }, [priceRef]);

  // ─── Chart Creation ─────────────────────────────────────────────────

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
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#1e1e2a" },
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
      // Hide the series' own last-value label on the price axis —
      // we only want the amber current-price line label visible
      lastValueVisible: false,
    });

    const markers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;
    renderedCountRef.current = 0;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    // ─── Drag SL/TP interaction ─────────────────────────────────────
    // Click near SL or TP line → start dragging
    // Crosshair move while dragging → update line price
    // Click again → finalize and submit new price

    const DRAG_THRESHOLD = 5; // points proximity to start drag

    chart.subscribeClick((param) => {
      // Skip SL/TP drag logic entirely when a drawing tool is active
      // (and when a drawing is already being dragged mid-2-click).
      // The drawings hook owns the click for draw/select in that case.
      if (drawings.activeToolRef.current !== null) return;
      if (!param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;

      if (draggingRef.current) {
        // Second click — finalize drag
        const which = draggingRef.current;
        const newPrice = dragPriceRef.current;
        draggingRef.current = null;

        // Round to nearest 0.25 (NQ tick size)
        const rounded = Math.round(newPrice * 4) / 4;

        // Update the price ref immediately so the next click can find
        // the line at its new position (before liveState round-trips back)
        if (which === "sl") currentSlPriceRef.current = rounded;
        if (which === "tp") currentTpPriceRef.current = rounded;

        if (which === "sl" && modifySlRef.current) modifySlRef.current(rounded);
        if (which === "tp" && modifyTpRef.current) modifyTpRef.current(rounded);
      } else {
        // First click — check if near SL or TP using tracked prices
        const slPrice = currentSlPriceRef.current;
        const tpPrice = currentTpPriceRef.current;

        if (slPrice > 0 && Math.abs(price - slPrice) < DRAG_THRESHOLD) {
          draggingRef.current = "sl";
          dragPriceRef.current = slPrice;
        } else if (tpPrice > 0 && Math.abs(price - tpPrice) < DRAG_THRESHOLD) {
          draggingRef.current = "tp";
          dragPriceRef.current = tpPrice;
        }
      }
    });

    chart.subscribeCrosshairMove((param) => {
      // Suspend SL/TP drag updates while a drawing tool is active so the
      // user's crosshair motion only drives the drawing preview.
      if (drawings.activeToolRef.current !== null) return;
      if (!draggingRef.current || !param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;

      dragPriceRef.current = price;

      // Update the line visually during drag
      const line = draggingRef.current === "sl" ? slLineRef.current : tpLineRef.current;
      if (line) {
        line.applyOptions({ price: price });
      }
    });

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      renderedCountRef.current = 0;
      firstRenderedTimeRef.current = 0;
      lastRenderedTimeRef.current = 0;
      initialLoadDoneRef.current = false;
      tradeLineSeriesRef.current = [];
    };
  }, []);

  // ─── Escape key cancels drag ──────────────────────────────────────────
  // The drawings hook installs its own Escape handler; if a drawing is
  // active it will consume the event. This handler only cares about an
  // in-progress SL/TP drag, so checking draggingRef before acting keeps
  // the two paths independent.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && draggingRef.current) {
        // Reset the line to its original position by triggering a liveState re-render
        draggingRef.current = null;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ─── Bar + Forming Bar Updates (single effect to avoid race conditions) ──

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // If bars were cleared (e.g., data clean), reset all chart state so the
    // next batch goes through the full setData() path. We also reset
    // formingTimeRef so the RAF tick loop above does not push forming-bar
    // updates with a stale (pre-clean) time slot into the empty series.
    if (bars.length === 0) {
      // Remove price line from series before clearing — setData() does NOT
      // remove price lines, so orphaned lines accumulate on instrument switch.
      if (priceLineRef.current) {
        try { series.removePriceLine(priceLineRef.current); } catch { /* noop */ }
        priceLineRef.current = null;
      }
      series.setData([]);
      renderedCountRef.current = 0;
      firstRenderedTimeRef.current = 0;
      lastRenderedTimeRef.current = 0;
      initialLoadDoneRef.current = false;
      formingBarRef.current = null;
      formingTimeRef.current = 0;
      return;
    }

    // Build a sorted, deduped view of the incoming bars keyed by unix time.
    const seen = new Set<number>();
    const sorted = bars
      .map((b) => ({ bar: b, time: rawTimestampToUnix(b.bar_time) }))
      .sort((a, b) => a.time - b.time)
      .filter(({ time }) => {
        if (seen.has(time)) return false;
        seen.add(time);
        return true;
      });

    if (sorted.length === 0) return;

    const firstSortedTime = sorted[0].time;
    const lastSortedTime = sorted[sorted.length - 1].time;

    // Decide whether this update is a true append or a full reset. We use
    // timestamps (not array indices) so a stray realtime bar that landed in
    // bars[] before a refetch completes cannot poison series.update() with an
    // older timestamp. Any of these conditions force a full setData():
    //   - First load after the chart was created or cleared.
    //   - The first bar's time changed (e.g. reseed brought in older history).
    //   - The newest sorted time is older than what we already rendered
    //     (out-of-order arrival or shrinking dataset).
    //   - The bars array shrunk vs. what we previously rendered.
    const needsFullReset =
      !initialLoadDoneRef.current ||
      firstSortedTime !== firstRenderedTimeRef.current ||
      lastSortedTime < lastRenderedTimeRef.current ||
      sorted.length < renderedCountRef.current;

    if (needsFullReset) {
      series.setData(sorted.map(({ bar }) => barToCandle(bar)));
      initialLoadDoneRef.current = true;
      firstRenderedTimeRef.current = firstSortedTime;
      lastRenderedTimeRef.current = lastSortedTime;
      renderedCountRef.current = sorted.length;
      // setData() does NOT remove price lines — explicitly remove before clearing
      // the ref so stale lines don't accumulate on instrument switch / reseed.
      if (priceLineRef.current) {
        try { series.removePriceLine(priceLineRef.current); } catch { /* noop */ }
        priceLineRef.current = null;
      }
      formingBarRef.current = null;
    } else {
      // True append — only push bars strictly newer than what is already in
      // the series. This skips the duplicate/stale bar that produced the
      // "Cannot update oldest data" error before.
      for (const { bar, time } of sorted) {
        if (time > lastRenderedTimeRef.current) {
          series.update(barToCandle(bar));
          lastRenderedTimeRef.current = time;
          renderedCountRef.current += 1;
        }
      }
      // A new completed bar means the forming bar slot has rolled forward.
      formingBarRef.current = null;
    }

    // Keep formingTimeRef in sync so the imperative RAF tick loop knows the
    // correct time slot for the forming bar.
    formingTimeRef.current = lastSortedTime + timeframeToSeconds(timeframe);
  }, [bars, timeframe]);

  // ─── SL/TP Price Lines ──────────────────────────────────────────────
  // Supports multiple bracket pairs from "Add to Position".
  // Each bracket renders its own entry, SL, and TP lines on the chart.

  const slPrice = liveState?.sl_price ?? null;
  const tpPrice = liveState?.tp_price ?? null;
  const entryPrice = liveState?.position_entry_price ?? null;
  const direction = liveState?.position_direction ?? null;
  const brackets = liveState?.brackets;

  // Keep drag refs up to date on every render (no effect needed)
  currentSlPriceRef.current = slPrice ?? 0;
  currentTpPriceRef.current = tpPrice ?? 0;

  // Stable serialization of brackets so the effect only fires when values change
  const bracketsKey = brackets ? JSON.stringify(brackets) : "none";

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Remove all existing bracket lines
    for (const line of bracketLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* already removed */ }
    }
    bracketLinesRef.current = [];
    slLineRef.current = null;
    tpLineRef.current = null;

    if (!direction) return;

    // If we have bracket data, render each bracket's entry/SL/TP
    if (brackets && brackets.length > 0) {
      brackets.forEach((b, i) => {
        const isFirst = i === 0;
        // Entry line
        if (b.entry_price) {
          const entryLine = series.createPriceLine({
            price: b.entry_price,
            color: direction === "Long" ? "#22c55e" : "#ef4444",
            lineWidth: isFirst ? 2 : 1,
            lineStyle: isFirst ? 0 : 1,
            axisLabelVisible: true,
            title: isFirst ? "Entry" : `Add #${i + 1}`,
          });
          bracketLinesRef.current.push(entryLine);
        }
        // SL line
        if (b.sl_price != null) {
          const slLine = series.createPriceLine({
            price: b.sl_price,
            color: "#ef4444",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: brackets.length > 1 ? `SL #${i + 1}` : "SL",
          });
          bracketLinesRef.current.push(slLine);
          // First bracket's SL is draggable
          if (isFirst) slLineRef.current = slLine;
        }
        // TP line
        if (b.tp_price != null) {
          const tpLine = series.createPriceLine({
            price: b.tp_price,
            color: "#22c55e",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: brackets.length > 1 ? `TP #${i + 1}` : "TP",
          });
          bracketLinesRef.current.push(tpLine);
          if (isFirst) tpLineRef.current = tpLine;
        }
      });
    } else {
      // Fallback: single bracket from primary sl_price/tp_price
      if (entryPrice) {
        bracketLinesRef.current.push(series.createPriceLine({
          price: entryPrice,
          color: direction === "Long" ? "#22c55e" : "#ef4444",
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: "Entry",
        }));
      }
      if (slPrice) {
        const slLine = series.createPriceLine({
          price: slPrice,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "SL",
        });
        bracketLinesRef.current.push(slLine);
        slLineRef.current = slLine;
      }
      if (tpPrice) {
        const tpLine = series.createPriceLine({
          price: tpPrice,
          color: "#22c55e",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "TP",
        });
        bracketLinesRef.current.push(tpLine);
        tpLineRef.current = tpLine;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slPrice, tpPrice, entryPrice, direction, bracketsKey]);

  // ─── Preview SL/TP Lines (no open position) ─────────────────────────
  // Renders 4 dashed horizontal lines anchored to the latest price so the
  // trader can see where their stop and target would land for either a
  // Long or a Short entry at their configured point distances.
  //
  //   Long:  entry ≈ current, SL = current − slPoints, TP = current + tpPoints
  //   Short: entry ≈ current, SL = current + slPoints, TP = current − tpPoints
  //
  // The preview is intentionally suppressed when a position is open — the
  // real Entry/SL/TP lines from liveState take over and the preview would
  // only add visual clutter.
  //
  // Re-runs when: toggle flips, point distances change, current price
  // changes, or a position opens/closes (direction goes null ↔ Long/Short).
  // The RAF tick loop that updates the amber last-price line does NOT
  // update these — pinning them to the price on each render trade-off is
  // acceptable for a "preview" whose precision only matters up to ~1 tick.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Always tear down whatever was rendered previously, so a toggle-off
    // (or a position opening) leaves no orphan lines behind.
    for (const line of previewLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* already removed */ }
    }
    previewLinesRef.current = [];

    // Gate: feature off, position open, or insufficient inputs → nothing to draw.
    if (!showPreviewSlTp) return;
    if (direction) return; // real SL/TP lines own the chart during a trade
    // Prefer the live tick price when available; fall back to the last
    // completed-bar close for Supabase-mode or pre-tick initial render.
    const currentPrice = priceRef?.current ?? lastPrice;
    if (currentPrice == null) return;

    // Build the preview set. If a points value is missing, skip that line
    // rather than rendering it at the current price (which would visually
    // overlap the amber last-price line and look like a bug).
    const longSl  = previewSlPoints != null ? currentPrice - previewSlPoints : null;
    const longTp  = previewTpPoints != null ? currentPrice + previewTpPoints : null;
    const shortSl = previewSlPoints != null ? currentPrice + previewSlPoints : null;
    const shortTp = previewTpPoints != null ? currentPrice - previewTpPoints : null;

    const specs: Array<{ price: number; color: string; title: string }> = [];
    if (longSl  != null) specs.push({ price: longSl,  color: "#ef4444", title: "Long SL"  });
    if (longTp  != null) specs.push({ price: longTp,  color: "#22c55e", title: "Long TP"  });
    if (shortSl != null) specs.push({ price: shortSl, color: "#ef4444", title: "Short SL" });
    if (shortTp != null) specs.push({ price: shortTp, color: "#22c55e", title: "Short TP" });

    for (const { price, color, title } of specs) {
      const line = series.createPriceLine({
        price,
        color,
        // lineStyle 2 = dashed; matches the style of real SL/TP lines
        // so the preview reads as "same kind of thing, just hypothetical".
        lineStyle: 2,
        lineWidth: 1,
        axisLabelVisible: true,
        title,
      });
      previewLinesRef.current.push(line);
    }
  }, [showPreviewSlTp, previewSlPoints, previewTpPoints, lastPrice, direction, priceRef]);

  // ─── Last Price Line ────────────────────────────────────────────────
  // Price line is now managed imperatively by updateTick() for zero latency.
  // Create initial price line from lastPrice prop (SSR / first render only).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || lastPrice === null || priceLineRef.current) return;
    priceLineRef.current = series.createPriceLine({
      price: lastPrice,
      color: "#f59e0b",
      lineWidth: 1,
      lineStyle: 1,
      axisLabelVisible: true,
      title: "",
    });
  }, [lastPrice]);

  // ─── Trade Markers (entry/exit arrows from today's trades) ─────────
  // Matches trade entry/exit times to the nearest 15-second bar and
  // renders markers using the same pattern as replay-chart.tsx.

  useEffect(() => {
    const markersPlugin = markersRef.current;
    if (!markersPlugin || bars.length === 0 || !trades || trades.length === 0) {
      if (markersPlugin) markersPlugin.setMarkers([]);
      return;
    }

    // Build a sorted array of bar unix times for binary-search snapping
    const barTimes = bars
      .map((b) => Math.floor(rawTimestampToUnix(b.bar_time)))
      .sort((a, b) => a - b);

    // Snap a trade timestamp to the closest bar time
    const snapToBar = (timestamp: string): number | null => {
      const t = Math.floor(rawTimestampToUnix(timestamp));
      // Find the first bar whose close time is >= trade time
      // (bar_time is the bar's close time, so the bar covers [bar_time-15, bar_time])
      let lo = 0, hi = barTimes.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (barTimes[mid] >= t) { best = mid; hi = mid - 1; }
        else lo = mid + 1;
      }
      // If no bar >= trade time, use the last bar; otherwise use the found bar
      if (best === -1) return barTimes[barTimes.length - 1];
      return barTimes[best];
    };

    const markerList: SeriesMarker<Time>[] = [];

    for (const trade of trades) {
      // Entry marker
      const entryBarTime = snapToBar(trade.entry_time);
      if (entryBarTime !== null) {
        const isLong = trade.direction === "Long";
        markerList.push({
          time: entryBarTime as Time,
          position: isLong ? "belowBar" : "aboveBar",
          color: "#f59e0b",
          shape: isLong ? "arrowUp" : "arrowDown",
          text: isLong ? "BUY" : "SELL",
        });
      }

      // Exit marker (only for closed trades)
      if (trade.exit_time) {
        const exitBarTime = snapToBar(trade.exit_time);
        if (exitBarTime !== null) {
          const pnl = trade.pnl_points ?? 0;
          const isLong = trade.direction === "Long";
          markerList.push({
            time: exitBarTime as Time,
            position: isLong ? "aboveBar" : "belowBar",
            color: pnl >= 0 ? "#22c55e" : "#ef4444",
            shape: "circle",
            text: `${pnl >= 0 ? "+" : ""}${Number(pnl).toFixed(2)}`,
          });
        }
      }
    }

    // Sort by time (required by lightweight-charts)
    markerList.sort((a, b) => (a.time as number) - (b.time as number));
    markersPlugin.setMarkers(markerList);
  }, [bars, trades]);

  // ─── Trade Lines (entry → exit) ───────────────────────────────────
  // Draws a line from entry price to exit price for each closed trade,
  // matching the zone line pattern from replay-chart.tsx.

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old trade line series
    for (const ls of tradeLineSeriesRef.current) {
      chart.removeSeries(ls);
    }
    tradeLineSeriesRef.current = [];

    if (bars.length === 0 || !trades || trades.length === 0) return;

    // Build sorted bar times for snapping (same logic as markers)
    const barTimes = bars
      .map((b) => Math.floor(rawTimestampToUnix(b.bar_time)))
      .sort((a, b) => a - b);

    const snapToBar = (timestamp: string): number | null => {
      const t = Math.floor(rawTimestampToUnix(timestamp));
      let lo = 0, hi = barTimes.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (barTimes[mid] >= t) { best = mid; hi = mid - 1; }
        else lo = mid + 1;
      }
      if (best === -1) return barTimes[barTimes.length - 1];
      return barTimes[best];
    };

    for (const trade of trades) {
      // Only draw lines for closed trades with both entry and exit
      if (!trade.exit_time || !trade.exit_price) continue;

      const entryBarTime = snapToBar(trade.entry_time);
      const exitBarTime = snapToBar(trade.exit_time);
      if (entryBarTime === null || exitBarTime === null) continue;
      // Skip if entry and exit snap to the same bar (line would be invisible)
      if (entryBarTime === exitBarTime) continue;
      // Skip if the points are not in ascending order. lightweight-charts
      // asserts data is sorted; this can happen when trade rows have
      // entry_time after exit_time due to bad data or snap edge cases.
      if (exitBarTime < entryBarTime) continue;

      const pnl = trade.pnl_points ?? 0;
      const color = pnl >= 0 ? "#22c55e" : "#ef4444";

      const lineSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: 0, // Solid
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      lineSeries.setData([
        { time: entryBarTime as Time, value: trade.entry_price },
        { time: exitBarTime as Time, value: Number(trade.exit_price) },
      ]);

      tradeLineSeriesRef.current.push(lineSeries);
    }
  }, [bars, trades]);

  // ─── Bar Countdown Timer ────────────────────────────────────────────
  // Shows seconds remaining until the current bar closes.
  // Uses the last completed bar's time as reference: next bar closes
  // at lastBarTime + barSeconds (bar_time = bar close time in NT8).

  const [countdown, setCountdown] = useState<number | null>(null);
  const barSeconds = timeframeToSeconds(timeframe);

  // Anchor the countdown to the *local* arrival time of the most recent bar.
  // NT8 bar timestamps can drift relative to wall clock (network latency,
  // server time skew, late deliveries), which made the previous unix-time
  // math show stale or negative values. Resetting from "now" each time the
  // last bar's bar_time changes guarantees the pill restarts cleanly at the
  // full interval the moment a new bar prints.
  const lastBarKeyRef = useRef<number>(0);
  const barArrivedAtRef = useRef<number>(0);

  useEffect(() => {
    if (bars.length === 0) {
      setCountdown(null);
      lastBarKeyRef.current = 0;
      barArrivedAtRef.current = 0;
      return;
    }

    const lastBar = bars[bars.length - 1];
    const lastBarKey = rawTimestampToUnix(lastBar.bar_time);

    // Detect a brand-new bar (different close time than what we last saw)
    // and stamp the local arrival moment so the countdown restarts from full.
    if (lastBarKey !== lastBarKeyRef.current) {
      lastBarKeyRef.current = lastBarKey;
      barArrivedAtRef.current = Date.now();
    }

    const tick = () => {
      const elapsedMs = Date.now() - barArrivedAtRef.current;
      const remaining = Math.max(0, barSeconds - Math.floor(elapsedMs / 1000));
      setCountdown(remaining);
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [bars, barSeconds]);

  // ─── Countdown pill positioner (Supabase / non-WS fallback) ────────
  // The RAF loop above only runs when priceRef is provided (WS mode).
  // In Supabase mode — and after price-scale shifts caused by new bars
  // or window resizes — we still need to keep the pill aligned with
  // the current price label. This effect re-pins the pill imperatively
  // whenever the relevant inputs change.
  useEffect(() => {
    const series = seriesRef.current;
    const overlay = countdownOverlayRef.current;
    if (!series || !overlay) return;
    const price = lastTickPriceRef.current ?? lastPrice;
    if (price === null) {
      overlay.style.visibility = "hidden";
      return;
    }
    const y = series.priceToCoordinate(price);
    if (y !== null) {
      overlay.style.transform = `translateY(${y + 14}px)`;
      overlay.style.visibility = "visible";
    } else {
      overlay.style.visibility = "hidden";
    }
  }, [lastPrice, bars, countdown]);

  // ─── Reset chart view ───────────────────────────────────────────────
  // Restores the chart to its default size and positioning by fitting
  // all bars horizontally and re-enabling auto-scale on the price axis.
  // Triggered by the small overlay button in the top-left of the chart.
  const handleResetView = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.timeScale().fitContent();
      chart.timeScale().scrollToRealTime();
      chart.priceScale("right").applyOptions({ autoScale: true });
    } catch {
      // No-op — chart may have been disposed mid-click
    }
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────

  // Resolve the selected drawing object once so both toolbar + overlay can
  // read its color/kind for highlighting and the color picker.
  const selectedDrawing = drawings.drawings.find((d) => d.id === drawings.selectedId) ?? null;

  return (
    <div className="relative w-full h-full min-h-[400px] rounded-lg overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
      {/* Reset chart view button — top-left overlay. Click to refit all bars
          horizontally and re-enable price axis auto-scale, undoing any manual
          pan/zoom the user has done. */}
      <button
        type="button"
        onClick={handleResetView}
        title="Reset chart view"
        className="absolute top-2 left-2 z-50 bg-zinc-800/80 hover:bg-zinc-700
                   text-zinc-200 border border-zinc-700 rounded px-2 py-1
                   text-[11px] font-medium leading-none shadow-sm
                   flex items-center gap-1"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </svg>
        Reset
      </button>
      {/* Drawing tools — floating toolbar + SVG overlay. The overlay sits
          above the chart canvas with pointer-events: none so clicks fall
          through to lightweight-charts. The toolbar captures its own
          clicks so selecting a tool doesn't deselect the active drawing. */}
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
        onArmSelected={() => {
          if (drawings.selectedId) drawings.armAlert(drawings.selectedId);
        }}
        alertsEnabled
      />
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
      {/* Indicator panel — floating "fx" button top-right. Only
          rendered when the parent wires up onIndicatorsChange, which
          it does on the live trader but not on e.g. the post-trade
          review chart. */}
      {onIndicatorsChange && (
        <IndicatorPanel
          configs={indicatorConfigs ?? []}
          onChange={onIndicatorsChange}
        />
      )}
      {/* Bar countdown pill — pinned to the right price scale, vertically
          aligned just under the amber current-price label (TradingView style).
          Position is updated imperatively from the RAF loop / positioner effect. */}
      {countdown !== null && bars.length > 0 && (
        <div
          ref={countdownOverlayRef}
          className="absolute top-0 right-0 z-50 bg-emerald-500 text-white text-[11px]
                     font-mono px-1.5 py-0.5 rounded-sm leading-tight pointer-events-none
                     select-none shadow-sm whitespace-nowrap"
          style={{ visibility: "hidden" }}
        >
          {formatCountdown(countdown)}
        </div>
      )}
    </div>
  );
}
