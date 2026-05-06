/**
 * ZoneCandlestickChart — Per-trade candlestick chart for the risk simulator.
 *
 * Renders the bar-by-bar progression of a single simulated trade using
 * TradingView's lightweight-charts (same library as the replay tool and live
 * trader, so styling stays consistent across the app). Includes:
 *   - Pre-entry context bars (~30) so the user can see the SETUP that led
 *     into the entry, not just what happened after
 *   - Zone bars (bar_index 0..N) — the actual trade window
 *   - Extension bars (when the rule is on) — what came AFTER the zone
 *   - Entry arrow + exit circle markers
 *   - Entry / SL / TP price lines on the right axis
 *   - Trailing stop step line (when enabled)
 *
 * Architecture mirrors replay-chart.tsx and live-chart.tsx:
 *   - One useEffect on mount creates the chart instance + candlestick series
 *   - A second useEffect imperatively updates data, markers, and price lines
 *     whenever the underlying props change (full setData on each run since
 *     this chart is only re-rendered for distinct trades, not in real time)
 *   - ResizeObserver keeps width in sync with the table cell.
 */

"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type LineData,
  type SeriesMarker,
  type IPriceLine,
  type Time,
} from "lightweight-charts";
import { TradeZoneBar } from "@/types/trade-zone";
import { SimZoneResult, SimRules, TrailPathData } from "@/lib/utils/zone-simulator";
import { rawTimestampToUnix } from "@/lib/utils/format";

interface ZoneCandlestickChartProps {
  /** Zone bars (bar_index >= 0). May include extension bars when the rule is
   *  on — those carry monotonically increasing bar_index past the last zone
   *  bar and are treated identically here (just more candles to draw). */
  bars: TradeZoneBar[];
  /** Optional pre-entry context bars (bar_index < 0). Pulled from replay_bars
   *  by zone-pre-entry-fetcher; empty when no replay session matched the zone. */
  preEntryBars?: TradeZoneBar[];
  /** Optional post-exit context bars. Pulled from replay_bars by
   *  zone-extension-fetcher (always pre-fetched, independent of the simulator's
   *  "Extend Bars" rule). Used purely for chart context — never fed back into
   *  the simulator. The chart caps the displayed window at POST_EXIT_BARS. */
  postExitBars?: TradeZoneBar[];
  entryPrice: number;
  direction: string;
  rules: SimRules;
  simResult: SimZoneResult;
  trailPath: TrailPathData;
}

/** How many bars after the simulated exit to render as chart context.
 *  Mirrors the 30-bar pre-entry window so the user sees a symmetric
 *  setup-and-aftermath view of every trade. */
const POST_EXIT_BARS = 30;

/** Convert a TradeZoneBar to lightweight-charts CandlestickData. */
function barToCandle(bar: TradeZoneBar): CandlestickData<Time> {
  return {
    time: rawTimestampToUnix(bar.bar_time) as Time,
    open: bar.bar_open,
    high: bar.bar_high,
    low: bar.bar_low,
    close: bar.bar_close,
  };
}

export function ZoneCandlestickChart({
  bars,
  preEntryBars = [],
  postExitBars = [],
  entryPrice,
  direction,
  rules,
  simResult,
  trailPath,
}: ZoneCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const trailSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const beSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Price line refs — recreated on every data update so we can clear them
  // first without touching lines we still want.
  const entryLineRef = useRef<IPriceLine | null>(null);
  const slLineRef = useRef<IPriceLine | null>(null);
  const tpLineRef = useRef<IPriceLine | null>(null);

  // ─── Chart Creation (once on mount) ─────────────────────────────────────
  // Mirrors replay-chart.tsx exactly so the visual style matches the rest of
  // the app — dark background, white candles, subtle grid, right-side price
  // axis with timestamp axis on the bottom.
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
      crosshair: { mode: 0 }, // Normal — full crosshair tracks cursor
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
    });

    // v5 markers plugin — replaces the deprecated series.setMarkers API.
    const markers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      trailSeriesRef.current = null;
      beSeriesRef.current = null;
      entryLineRef.current = null;
      slLineRef.current = null;
      tpLineRef.current = null;
    };
  }, []);

  // ─── Data + Markers + Lines update ──────────────────────────────────────
  // One effect that rebuilds everything from props. We use full setData (not
  // incremental update) because this chart isn't streaming — it re-renders
  // when the user expands a different row or tweaks rules, and the bar list
  // can shrink (e.g. exit moved earlier) so incremental append wouldn't work.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const markersPlugin = markersRef.current;
    if (!chart || !series || !markersPlugin) return;

    const isLong = direction === "Long";

    // ── Build the candle data ──
    // 1) Pre-entry bars (negative bar_index) come first — ~30 bars of setup
    // 2) Zone + extension bars up to the simulated exit bar (the trade itself)
    // 3) Post-exit context bars — up to POST_EXIT_BARS bars AFTER the exit so
    //    the user can see what happened next (was the exit premature? did the
    //    trade have more room?). Drawn from any zone bars past the exit plus
    //    the always-pre-fetched extension bars; deduped by time and capped.
    // Sorted by bar_index, then deduped by unix time since lightweight-charts
    // requires strictly-increasing unique times.
    const preEntrySorted = [...preEntryBars].sort((a, b) => a.bar_index - b.bar_index);
    const zoneSorted = [...bars]
      .filter((b) => b.bar_index <= simResult.exitBarIndex)
      .sort((a, b) => a.bar_index - b.bar_index);

    // Post-exit window: union of (a) any zone bars past the exit (when the
    // simulator exited mid-zone or the "Extend Bars" rule merged extension
    // bars into `bars`) and (b) the standalone `postExitBars` prop (the raw
    // pre-fetched extension bars, available regardless of the rule). Sorted
    // by bar_time, deduped, capped at POST_EXIT_BARS.
    const postExitMerged = [
      ...bars.filter((b) => b.bar_index > simResult.exitBarIndex),
      ...postExitBars,
    ].sort((a, b) => rawTimestampToUnix(a.bar_time) - rawTimestampToUnix(b.bar_time));
    const seenPostExitTimes = new Set<number>();
    const postExitSorted: TradeZoneBar[] = [];
    for (const bar of postExitMerged) {
      const t = rawTimestampToUnix(bar.bar_time);
      if (seenPostExitTimes.has(t)) continue;
      seenPostExitTimes.add(t);
      postExitSorted.push(bar);
      if (postExitSorted.length >= POST_EXIT_BARS) break;
    }

    const allBars = [...preEntrySorted, ...zoneSorted, ...postExitSorted];

    const seenTimes = new Set<number>();
    const candles: CandlestickData<Time>[] = [];
    for (const bar of allBars) {
      const t = rawTimestampToUnix(bar.bar_time);
      if (seenTimes.has(t)) continue;
      seenTimes.add(t);
      candles.push(barToCandle(bar));
    }
    series.setData(candles);

    // ── Markers: entry arrow + exit circle ──
    // Entry sits at the bar_index === 0 bar (first zone bar — by definition
    // the entry candle). Exit sits at simResult.exitBarIndex.
    const markerList: SeriesMarker<Time>[] = [];
    const entryBar = zoneSorted.find((b) => b.bar_index === 0);
    if (entryBar) {
      markerList.push({
        time: rawTimestampToUnix(entryBar.bar_time) as Time,
        position: isLong ? "belowBar" : "aboveBar",
        color: "#f59e0b",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: isLong ? "BUY" : "SELL",
      });
    }
    const exitBar = zoneSorted.find((b) => b.bar_index === simResult.exitBarIndex);
    if (exitBar) {
      const pnl = simResult.exitPoints;
      markerList.push({
        time: rawTimestampToUnix(exitBar.bar_time) as Time,
        position: isLong ? "aboveBar" : "belowBar",
        color: pnl >= 0 ? "#22c55e" : "#ef4444",
        shape: "circle",
        text: `${simResult.exitReason.toUpperCase()} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
      });
    }
    // lightweight-charts requires markers sorted ascending by time.
    markerList.sort((a, b) => (a.time as number) - (b.time as number));
    markersPlugin.setMarkers(markerList);

    // ── Price lines: Entry, SL, TP ──
    // Tear down old lines first so we don't leak them on prop changes.
    if (entryLineRef.current) { series.removePriceLine(entryLineRef.current); entryLineRef.current = null; }
    if (slLineRef.current) { series.removePriceLine(slLineRef.current); slLineRef.current = null; }
    if (tpLineRef.current) { series.removePriceLine(tpLineRef.current); tpLineRef.current = null; }

    entryLineRef.current = series.createPriceLine({
      price: entryPrice,
      color: "#f59e0b",
      lineWidth: 1,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: "Entry",
    });

    if (trailPath.slPrice != null) {
      slLineRef.current = series.createPriceLine({
        price: trailPath.slPrice,
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "SL",
      });
    }
    if (trailPath.tpPrice != null) {
      tpLineRef.current = series.createPriceLine({
        price: trailPath.tpPrice,
        color: "#22c55e",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "TP",
      });
    }

    // ── Trailing stop step line ──
    // computeTrailPath produces one trail price per zone bar (bar_index 0..exit),
    // skipping pre-entry bars entirely, so we map by zoneSorted index — NOT
    // by allBars index. WithSteps line type matches the original recharts
    // stepAfter behavior visually.
    if (trailSeriesRef.current) {
      chart.removeSeries(trailSeriesRef.current);
      trailSeriesRef.current = null;
    }
    if (rules.trailingStopEnabled) {
      const trailLine = chart.addSeries(LineSeries, {
        color: "#f97316",
        lineWidth: 2,
        lineType: LineType.WithSteps,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const trailData: LineData<Time>[] = [];
      const seenTrailTimes = new Set<number>();
      for (let i = 0; i < zoneSorted.length && i < trailPath.trailPrices.length; i++) {
        const price = trailPath.trailPrices[i];
        if (price == null) continue;
        const t = rawTimestampToUnix(zoneSorted[i].bar_time);
        if (seenTrailTimes.has(t)) continue;
        seenTrailTimes.add(t);
        trailData.push({ time: t as Time, value: price });
      }
      trailLine.setData(trailData);
      trailSeriesRef.current = trailLine;
    }

    // ── Break-even line ──
    // Drawn as a separate step series (purple) for the bars where BE was
    // active. Same alignment trick as the trail line — bePrices is per
    // zone bar, not per merged bar.
    if (beSeriesRef.current) {
      chart.removeSeries(beSeriesRef.current);
      beSeriesRef.current = null;
    }
    if (rules.breakEvenEnabled) {
      const beLine = chart.addSeries(LineSeries, {
        color: "#8b5cf6",
        lineWidth: 1,
        lineType: LineType.WithSteps,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const beData: LineData<Time>[] = [];
      const seenBeTimes = new Set<number>();
      for (let i = 0; i < zoneSorted.length && i < trailPath.bePrices.length; i++) {
        const price = trailPath.bePrices[i];
        if (price == null) continue;
        const t = rawTimestampToUnix(zoneSorted[i].bar_time);
        if (seenBeTimes.has(t)) continue;
        seenBeTimes.add(t);
        beData.push({ time: t as Time, value: price });
      }
      if (beData.length > 0) {
        beLine.setData(beData);
        beSeriesRef.current = beLine;
      } else {
        chart.removeSeries(beLine);
      }
    }

    // ── Final fit ──
    // Pull the time scale to fit everything (pre-entry + trade + extension)
    // so the user sees the full context without needing to pan/zoom.
    chart.timeScale().fitContent();
  }, [bars, preEntryBars, postExitBars, entryPrice, direction, rules, simResult, trailPath]);

  // ─── Header strip (matches the previous chart's labels) ─────────────────
  const exitLabel = `Exit: ${simResult.exitReason.toUpperCase()} (${
    simResult.exitPoints > 0 ? "+" : ""
  }${simResult.exitPoints.toFixed(2)} pts)`;
  const preCount = Math.min(preEntryBars.length, 30);
  // Post-exit count for the header. Estimated as min(POST_EXIT_BARS, available)
  // — the actual rendered count is computed inside the data effect, but for
  // the header label this matches what the user will see in the vast majority
  // of cases (zones nearly always have at least 30 bars of post-exit context
  // available between zone-after-exit + extension fetch).
  const postCount = Math.min(
    POST_EXIT_BARS,
    bars.filter((b) => b.bar_index > simResult.exitBarIndex).length + postExitBars.length
  );

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">
          {direction} — {simResult.barsHeld} bars — Entry: {entryPrice.toFixed(2)}
          {preCount > 0 && (
            <span className="ml-2 text-muted-foreground/60">
              +{preCount} pre-entry bars
            </span>
          )}
          {postCount > 0 && (
            <span className="ml-2 text-muted-foreground/60">
              +{postCount} post-exit bars
            </span>
          )}
        </span>
        <span
          className={`text-xs font-medium ${
            simResult.exitPoints >= 0 ? "text-accent-green" : "text-accent-red"
          }`}
        >
          {exitLabel}
        </span>
      </div>
      {/* Fixed height — table-cell context means the chart can't size itself
          off its parent; setting it explicitly here keeps every expanded row
          a uniform size. */}
      <div
        ref={containerRef}
        className="w-full rounded-lg overflow-hidden"
        style={{ height: 380 }}
      />
    </div>
  );
}
