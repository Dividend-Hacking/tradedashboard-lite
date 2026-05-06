/**
 * CompositeBarsChart
 *
 * Side-by-side candlestick rendering of the "super trade" — average OHLC
 * bars across every winning long, and every winning short, plotted bar-by-bar
 * relative to entry. Powered by TradingView's lightweight-charts (same
 * library as the rest of the trading UI: replay viewer, live chart, per-trade
 * candlestick) so the styling matches.
 *
 * The chart is in "price-delta space": each candle's open/high/low/close
 * is the raw average (bar_price − entry_price), no sign flip for shorts.
 * That keeps the chart honest to actual price action — a winning long
 * climbs above the entry line, a winning short descends below it — so
 * users see real candle shapes (mostly red on a winning short, mostly
 * green on a winning long) instead of a flipped/abstracted "P&L" view.
 * Bar 0 is the entry; every series starts exactly at zero by construction.
 *
 * Two charts are rendered: one for long winners, one for short winners.
 * They share the same X-axis convention (bar_index → synthetic seconds)
 * but each gets its own price axis since their averages live in different
 * point ranges.
 */

"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type IPriceLine,
} from "lightweight-charts";
import { CompositeBar, CompositeBarsResult } from "@/lib/utils/composite-trade";

/** Shift applied to bar_index when converting to lightweight-charts'
 *  UTCTimestamp. Has to be larger than the maximum negative bar_index
 *  we expect (pre-entry bars cap at -30, plus a generous safety margin)
 *  so every candle lands on a strictly-positive time value. */
const TIME_OFFSET_BARS = 1000;

interface CompositeBarsChartProps {
  composite: CompositeBarsResult;
  onClose?: () => void;
}

export function CompositeBarsChart({ composite, onClose }: CompositeBarsChartProps) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
            Composite Bars — Super Trade Candles
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Average OHLC bar-by-bar around entry, split into winners (top
            row) and losers (bottom row) for each direction. Includes up to
            30 bars BEFORE entry so you can compare typical SETUPS — what
            does a setup that worked look like, vs one that didn&apos;t? Y-axis
            is points relative to entry. Trades that exited earlier drop
            out as the bar index grows.
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
            aria-label="Close composite bars panel"
          >
            &times;
          </button>
        )}
      </div>

      {/* 2×2 grid: rows are outcome (winners on top, losers below),
          columns are direction (longs on left, shorts on right). The
          layout makes side-by-side comparison natural — your eye goes
          vertical to ask "what's different about a winning long vs a
          losing long?" or horizontal to ask "do my long winners look
          like my short winners flipped?". On small screens the grid
          collapses to a single column. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CompositeBarsSingleChart
          title="Long winners"
          bars={composite.longBars}
          tradeCount={composite.longWinnerCount}
          accent="#22c55e"
        />
        <CompositeBarsSingleChart
          title="Short winners"
          bars={composite.shortBars}
          tradeCount={composite.shortWinnerCount}
          accent="#22c55e"
        />
        <CompositeBarsSingleChart
          title="Long losers"
          bars={composite.longLoserBars}
          tradeCount={composite.longLoserCount}
          accent="#ef4444"
        />
        <CompositeBarsSingleChart
          title="Short losers"
          bars={composite.shortLoserBars}
          tradeCount={composite.shortLoserCount}
          accent="#ef4444"
        />
      </div>
    </div>
  );
}

/**
 * Renders a single direction's composite candlestick series. Encapsulates
 * the lightweight-charts wiring — chart creation, candle series, the entry
 * reference line, the resize observer, and the disposal cleanup — so the
 * parent component just hands in two CompositeBar arrays and lets the
 * effects do the rest.
 */
function CompositeBarsSingleChart({
  title,
  bars,
  tradeCount,
  accent,
}: {
  title: string;
  bars: CompositeBar[];
  /** Number of trades that contributed to this composite (winners or losers,
   *  whichever the parent passed). Renamed from winnerCount because losing
   *  buckets share the same component. */
  tradeCount: number;
  accent: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);

  // ── Chart creation (once per mount) ──────────────────────────
  // Same color/grid settings as ZoneCandlestickChart so the visual style
  // matches the rest of the simulator. Up = white-bordered, down = filled —
  // standard for the project's TradingView-style charts.
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
        // X axis is "bar index from entry". lightweight-charts requires
        // strictly-positive UTC timestamps, so we shift by TIME_OFFSET
        // (large enough to keep all values positive even for the
        // furthest-back pre-entry bars). The formatter subtracts the
        // offset back to recover the bar index, and labels negatives
        // with "-N" so pre-entry bars read as "N bars before entry".
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => {
          const idx = Math.round(time / 60) - TIME_OFFSET_BARS;
          if (idx === 0) return "Entry";
          return idx > 0 ? `+${idx}` : `${idx}`;
        },
      },
      width: containerRef.current.clientWidth,
      height: 320,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      // Add a "+N pts" suffix so the price axis reads as P&L points,
      // not as a price level — this is delta-from-entry space.
      priceFormat: {
        type: "custom",
        formatter: (price: number) => {
          const sign = price > 0 ? "+" : "";
          return `${sign}${price.toFixed(2)}`;
        },
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      entryLineRef.current = null;
    };
  }, []);

  // ── Data update ──────────────────────────────────────────────
  // setData on every prop change. Bars list can grow or shrink (rules tweak)
  // so a full replace is the only safe path. The bar_index → time mapping
  // is just `barIndex * 60` so every candle lands on a clean minute and
  // they stay strictly increasing as lightweight-charts requires.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const candles: CandlestickData<Time>[] = bars.map((b) => ({
      // Shift by TIME_OFFSET_BARS so negative pre-entry indices land
      // on positive timestamps (lightweight-charts requirement). The
      // tickMarkFormatter undoes the shift when it draws the axis.
      time: ((b.barIndex + TIME_OFFSET_BARS) * 60) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    series.setData(candles);

    // Re-create the entry reference line at zero on every data update so
    // it's always present (even if a previous run had it removed).
    if (entryLineRef.current) {
      series.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }
    entryLineRef.current = series.createPriceLine({
      price: 0,
      color: "#f59e0b",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Entry",
    });

    // Auto-fit the X axis to the data so users see the whole composite
    // without having to scroll.
    if (candles.length > 0) chart.timeScale().fitContent();
  }, [bars]);

  // ── Empty state ─────────────────────────────────────────────
  // No winners in this direction → render a placeholder so the layout
  // stays balanced (the other direction's chart probably has data).
  if (bars.length === 0) {
    return (
      <div className="bg-background border border-card-border rounded-md p-4 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium" style={{ color: accent }}>
            {title}
          </span>
          <span className="text-xs text-muted-foreground">
            {tradeCount} trade{tradeCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center min-h-[200px] text-xs text-muted-foreground">
          {tradeCount === 0
            ? `No ${title.toLowerCase()} in the current backtest.`
            : "Not enough overlapping bars to build a composite — try a longer-running strategy or lower the sample-size floor."}
        </div>
      </div>
    );
  }

  // Use the deepest bar's sample to label "starting depth"; the headline
  // count is the per-bucket trade total (every contributing trade is at
  // bar 0 by definition, but tail bars taper off as shorter trades exit).
  const tailSample = bars[bars.length - 1].sampleSize;

  return (
    <div className="bg-background border border-card-border rounded-md p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: accent }}>
          {title}
        </span>
        <span className="text-xs text-muted-foreground">
          {tradeCount} trade{tradeCount === 1 ? "" : "s"} · last bar avgs
          {" "}
          {tailSample} trade{tailSample === 1 ? "" : "s"}
        </span>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 320 }} />
    </div>
  );
}
