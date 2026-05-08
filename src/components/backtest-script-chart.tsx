"use client";

/**
 * BacktestScriptChart — TradingView lightweight-charts candlestick chart used
 * by the backtest dashboard's *script-mode → Chart view*. Shows the
 * stitched bars from every session the user has selected, with two
 * independent overlay layers:
 *
 *   1. Signal markers — one dot per `signalZone` (i.e. every entry signal
 *      the script emitted, INCLUDING ones later filtered out). Blue dot
 *      below the bar for Long, purple dot above for Short. Lets the user
 *      see exactly where the strategy condition fired and whether the
 *      filters are eating signals they didn't expect.
 *
 *   2. Trade markers — entry arrow (orange) + exit circle (green / red on
 *      P&L sign) for every trade that survived all filters. The text on
 *      the exit circle is the per-contract net-of-slippage P&L. These mirror
 *      the conventions used in /replay's chart so the visual language is
 *      consistent across the app.
 *
 * Each layer is independently toggleable — checkboxes above the chart let
 * the user hide either to focus on the other (e.g. hide trades to see how
 * many raw signals the strategy fires before filters trim them down).
 *
 * Implementation details that matter:
 *
 * - The component is intentionally NOT a refactor of replay-chart.tsx.
 *   That component is ~795 lines and tangled with practice-position state,
 *   chart drawings, indicators, volume profile, and analyze overlays —
 *   none of which apply here. Sharing the ~50 lines of init boilerplate
 *   isn't worth the abstraction cost with one consumer.
 *
 * - Bars are passed in already stitched/sorted/deduped by the parent
 *   (see scriptChartInputs in backtest-dashboard.tsx). We do nothing
 *   smart with continuation detection — every props change triggers a
 *   full `series.setData(...)` because the script mode workflow is
 *   "click Apply → see whole result," not "incrementally reveal bars."
 *
 * - lightweight-charts requires marker times to be ascending and unique
 *   per slot — we sort the assembled marker list by time before handing
 *   it to setMarkers(), and rely on the parent's bar dedupe to keep the
 *   underlying time axis clean.
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
import { TradeZone } from "@/types/trade-zone";
import { SimZoneResult } from "@/lib/utils/zone-simulator";
import { rawTimestampToUnix } from "@/lib/utils/format";

// ─── Props ────────────────────────────────────────────────────────────────

interface BacktestScriptChartProps {
  /** Stitched bars from every selected session, sorted by bar_time and
   *  deduped by bar_time. Empty array renders an empty chart frame plus the
   *  warning banner above it. */
  bars: ReplayBar[];
  /** Every signal the script fired, before any filter rejection. Sourced
   *  from `runResult.syntheticZones` — one synthetic zone is built per
   *  emitted signal with `start_time`, `start_price`, `direction` already
   *  resolved. */
  signalZones: TradeZone[];
  /** Trades that survived all filters (downstream of `tradesAndOptimization`
   *  so time-filter / day-of-week / session-cap selections are reflected). */
  trades: SimZoneResult[];
  /** Whether to render the signal-dot layer. */
  showSignals: boolean;
  /** Whether to render the trade entry/exit markers. */
  showTrades: boolean;
  /** Layer-toggle callbacks. */
  onToggleSignals: (v: boolean) => void;
  onToggleTrades: (v: boolean) => void;
  /** When non-null, displayed as a banner above the chart and the chart
   *  itself is left blank. Used for "no sessions selected" / "mixed
   *  instruments" / etc. — see scriptChartInputs in backtest-dashboard.tsx. */
  warning?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Convert a ReplayBar to lightweight-charts CandlestickData. Identical to
 *  the helper in replay-chart.tsx — duplicated here to keep the file
 *  self-contained. */
function barToCandle(bar: ReplayBar): CandlestickData<Time> {
  return {
    time: rawTimestampToUnix(bar.bar_time) as Time,
    open: bar.bar_open,
    high: bar.bar_high,
    low: bar.bar_low,
    close: bar.bar_close,
  };
}

// ─── Component ────────────────────────────────────────────────────────────

export default function BacktestScriptChart({
  bars,
  signalZones,
  trades,
  showSignals,
  showTrades,
  onToggleSignals,
  onToggleTrades,
  warning,
}: BacktestScriptChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /** One LineSeries per trade — used to draw the slanted entry→exit
   *  segment that connects each trade's entry candle to its exit candle.
   *  Tracked so we can remove every line on each rerender (cheap with
   *  typical trade counts) and avoid stale segments piling up after
   *  the user toggles layers or applies a new script. */
  const tradeLineSeriesRef = useRef<ISeriesApi<"Line">[]>([]);

  // ─── Chart creation (once on mount) ────────────────────────────────────
  // Mirrors replay-chart.tsx:178-244 — same dark theme + grid colors so the
  // visual language is identical across the app. The candlestick styling
  // matches /replay (white bullish / transparent bearish on a dark
  // background, white wicks).
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
        mode: 0, // Normal crosshair — full vertical/horizontal lines on hover.
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

    // v5 markers API — series.setMarkers() was removed; everything goes
    // through the plugin returned by createSeriesMarkers.
    const markers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;

    // Resize observer — keep the chart filling its container as the user
    // drags the script split divider or the window resizes.
    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
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
      // Wipe the trade-line tracking ref too — `chart.remove()` already
      // destroyed every attached LineSeries, so the references in
      // `tradeLineSeriesRef.current` now point to disposed objects.
      // Without this reset, React strict-mode's double-mount in dev
      // (mount → cleanup → mount) leaves the trade-lines effect with
      // stale series objects that throw "Value is undefined" when
      // `chart.removeSeries(ls)` runs against the freshly recreated chart.
      tradeLineSeriesRef.current = [];
    };
  }, []);

  // ─── Bar updates ────────────────────────────────────────────────────────
  // Unlike /replay (which reveals bars one at a time) script mode is
  // batch-oriented — the user clicks Apply and expects the whole result to
  // appear at once. So every bars-change is a wholesale setData rather than
  // an incremental update. Cheap enough at typical session sizes (a day of
  // 1-minute bars is ~400 candles, and lightweight-charts sets that in
  // under a millisecond).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (bars.length === 0) {
      series.setData([]);
      // Also wipe markers — empty bar set should never carry over stale ones.
      markersRef.current?.setMarkers([]);
      return;
    }
    series.setData(bars.map(barToCandle));
    // Auto-fit time scale so every selected session is visible. fitContent
    // uses the data's actual time range, so the natural gaps between
    // stitched session days appear with no manual scrolling needed.
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // ─── Marker rendering ──────────────────────────────────────────────────
  // Two layers — signals (raw, pre-filter) and trades (post-filter).
  // Recomputed any time the underlying data OR a layer toggle changes.
  // Each marker's time MUST round to an integer second because
  // lightweight-charts uses the value as a slot key — fractional seconds
  // round-trip differently than whole-number seconds and the marker silently
  // disappears.
  const updateMarkers = useCallback(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    if (bars.length === 0) {
      plugin.setMarkers([]);
      return;
    }

    const list: SeriesMarker<Time>[] = [];

    // Signal layer — one dot per script-emitted signal. Blue/Long below
    // bar, purple/Short above bar. Distinct from trade markers (which use
    // arrows + circles) so the eye can pre-attentively split "what the
    // condition saw" from "what actually traded."
    if (showSignals) {
      for (const z of signalZones) {
        list.push({
          time: Math.floor(rawTimestampToUnix(z.start_time)) as Time,
          position: z.direction === "Long" ? "belowBar" : "aboveBar",
          color: z.direction === "Long" ? "#3b82f6" : "#a855f7",
          shape: "circle",
          // No text — keeps the dot tight so a dense day stays legible.
          // The user already knows the direction from the position, and
          // the bar's time is shown in the crosshair tooltip.
          text: "",
        });
      }
    }

    // Trade layer — orange entry arrow + green/red exit circle. Mirrors
    // the convention in replay-chart.tsx so the user transitioning between
    // /replay and the backtest dashboard sees identical glyphs.
    if (showTrades) {
      for (const t of trades) {
        // Entry arrow — orange #f59e0b. Position below bar (Long) or above
        // bar (Short) so the arrow points TOWARD the candle, indicating
        // direction.
        list.push({
          time: Math.floor(rawTimestampToUnix(t.startTime)) as Time,
          position: t.direction === "Long" ? "belowBar" : "aboveBar",
          color: "#f59e0b",
          shape: t.direction === "Long" ? "arrowUp" : "arrowDown",
          text: t.direction === "Long" ? "L" : "S",
        });
        // Exit circle — green on win, red on loss. Text is per-contract
        // net-of-slippage P&L (`exitPoints`), matching the SimulatorTable
        // "Pts" column. Sign-aware so the user can correlate marker color
        // with the number.
        const pnl = t.exitPoints;
        list.push({
          time: Math.floor(rawTimestampToUnix(t.exitTime)) as Time,
          position: t.direction === "Long" ? "aboveBar" : "belowBar",
          color: pnl >= 0 ? "#22c55e" : "#ef4444",
          shape: "circle",
          text: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
        });
      }
    }

    // lightweight-charts requires markers in ascending time order — out-of-
    // order entries are silently dropped, which would manifest as "some
    // signals don't show up." Sorting unconditionally is cheap and defensive.
    list.sort((a, b) => (a.time as number) - (b.time as number));
    plugin.setMarkers(list);
  }, [bars, signalZones, trades, showSignals, showTrades]);

  useEffect(() => {
    updateMarkers();
  }, [updateMarkers]);

  // ─── Trade entry→exit lines ────────────────────────────────────────────
  // For every taken trade we draw a thin slanted LineSeries connecting
  // its entry candle to its exit candle. Color encodes outcome — green
  // (#22c55e) for winners, red (#ef4444) for losers — so the user can
  // pre-attentively scan a busy day and tell good vs bad trades apart
  // without reading the exit-circle text.
  //
  // Entry price comes from the matching synthetic zone's `start_price`
  // (built into a zoneId→zone map up front). The exit price is walked
  // back from `trade.exitPoints` using the simulator's sign convention:
  // for Long trades exit = entry + exitPoints; for Short trades
  // exit = entry − exitPoints. Mirrors how replay-chart.tsx renders
  // analyze-overlay segments.
  //
  // Implementation note: every render path recreates ALL line series
  // from scratch. lightweight-charts has no efficient "update one line
  // out of N" API, and trade counts in a typical backtest are <1000,
  // so the brute-force "remove all + recreate" pattern is plenty fast
  // and keeps the code path obvious.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Wipe prior segments unconditionally so toggling Trades off (or
    // applying a script that produces fewer trades than last time)
    // leaves no orphan lines behind. Wrapped in try/catch because
    // lightweight-charts throws "Value is undefined" when asked to
    // remove a series that's already detached (e.g. after a stale
    // ref survives a chart recreation). Defensive — the mount-effect
    // cleanup also nils this ref on chart disposal, but if the timing
    // ever desyncs we'd rather skip the orphan than crash the page.
    for (const ls of tradeLineSeriesRef.current) {
      try {
        chart.removeSeries(ls);
      } catch {
        // Series already detached — nothing to clean up.
      }
    }
    tradeLineSeriesRef.current = [];

    if (!showTrades || trades.length === 0 || bars.length === 0) return;

    // Build a zoneId → zone lookup once per render. O(N) build, O(1)
    // lookup per trade — much cheaper than calling .find() inside
    // the per-trade loop, especially when the user iterates a script
    // that emits hundreds of signals.
    const zonesById = new Map<number, TradeZone>();
    for (const z of signalZones) zonesById.set(z.id, z);

    for (const t of trades) {
      const zone = zonesById.get(t.zoneId);
      if (!zone) continue; // Defensive — every trade should match a zone.

      const isLong = t.direction === "Long";
      const entryPrice = zone.start_price;
      // exitPoints is sign-aware (positive = profitable round-trip,
      // already net of slippage). Walk it back to an absolute price
      // using the same direction math the simulator used internally.
      const exitPrice = isLong
        ? entryPrice + t.exitPoints
        : entryPrice - t.exitPoints;

      const isWin = t.exitPoints >= 0;
      const color = isWin ? "#22c55e" : "#ef4444";

      // priceLineVisible / lastValueVisible / crosshairMarkerVisible
      // are all turned off so each segment stays a clean thin line —
      // no horizontal price-line tag on the right axis, no value
      // bubble at the last point, no extra crosshair dot. Same
      // settings replay-chart.tsx uses for its zone segments.
      const lineSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        lineStyle: 0, // Solid — these are completed trades.
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      lineSeries.setData([
        {
          time: Math.floor(rawTimestampToUnix(t.startTime)) as Time,
          value: entryPrice,
        },
        {
          time: Math.floor(rawTimestampToUnix(t.exitTime)) as Time,
          value: exitPrice,
        },
      ]);
      tradeLineSeriesRef.current.push(lineSeries);
    }
  }, [trades, signalZones, showTrades, bars]);

  // ─── Render ─────────────────────────────────────────────────────────────
  // Layout: a sticky panel that mirrors the right-rail's sticky behavior so
  // the chart stays visible while the user scrolls the page (e.g. to read
  // the SimulatorTable below the fold). The toolbar / banner / chart
  // container are stacked vertically; the chart itself takes whatever
  // remaining height the viewport has.

  const signalCount = signalZones.length;
  const tradeCount = trades.length;

  return (
    <div
      className="flex flex-col gap-2"
      style={{
        position: "sticky",
        top: "1rem",
        alignSelf: "flex-start",
        // Match the right-rail's max-height so when the user scrolls the
        // page the chart stays anchored and the column doesn't overflow.
        maxHeight: "calc(100vh - 2rem)",
        // Reserve at least a usable chart height even on short viewports
        // — TradingView candle bodies become unreadable below ~360px.
        minHeight: "480px",
        height: "calc(100vh - 2rem)",
      }}
    >
      {/* Toolbar — layer-toggle checkboxes. Counts come from the prop
          arrays so the user can see at a glance how many signals vs trades
          the current run produced. */}
      <div className="flex items-center gap-4 px-3 py-2 rounded-md bg-card/95 backdrop-blur border border-card-border shadow-sm">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">
          Layers
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={showSignals}
            onChange={(e) => onToggleSignals(e.target.checked)}
            className="cursor-pointer"
          />
          {/* Color swatch echoes the actual marker color so the user can
              map the legend entry to the chart glyph without guessing. */}
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: "#3b82f6" }}
            aria-hidden
          />
          <span className="text-foreground">Signals</span>
          <span className="text-muted-foreground">({signalCount})</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={showTrades}
            onChange={(e) => onToggleTrades(e.target.checked)}
            className="cursor-pointer"
          />
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: "#f59e0b" }}
            aria-hidden
          />
          <span className="text-foreground">Trades</span>
          <span className="text-muted-foreground">({tradeCount})</span>
        </label>
      </div>

      {/* Warning banner — non-null when the chart can't render meaningfully
          (no sessions selected, mixed-instrument selection, etc.). The chart
          frame is still rendered behind it so the layout doesn't jump as
          the warning appears/disappears. */}
      {warning && (
        <div className="px-3 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-200">
          {warning}
        </div>
      )}

      {/* Chart container — flex-1 so it absorbs the remaining vertical
          space inside the sticky panel. ResizeObserver in the mount effect
          watches this element and pushes width/height into the chart on
          every change, so split-divider drags re-fit the chart smoothly. */}
      <div
        ref={containerRef}
        className="flex-1 rounded-md overflow-hidden border border-card-border"
        style={{ minHeight: "360px" }}
      />
    </div>
  );
}
