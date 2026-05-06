"use client";

/**
 * TradeBarsChart — Mini candlestick chart of the OHLC window captured around a
 * completed live trade. Renders data from the `trade_bars` Supabase table.
 *
 * Rows are written on the NinjaTrader side by TradeTracker → SupabaseWriter at
 * trade exit: 25 pre-entry bars through the exit bar, with is_entry_bar and
 * is_exit_bar flags on the two key rows. This component shows that slice with
 * entry/exit markers and horizontal price lines for entry, exit, SL, and TP.
 *
 * Kept intentionally light: uses the same lightweight-charts v5 primitives as
 * live-chart.tsx but without drawings, preview lines, tick streaming, or
 * realtime subscriptions — this is a static post-hoc view.
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type SeriesMarker,
  type Time,
  ColorType,
} from "lightweight-charts";
import { Trade, TradeBar } from "@/types/trade";
import { rawTimestampToUnix } from "@/lib/utils/format";

interface TradeBarsChartProps {
  bars: TradeBar[];
  trade: Trade;
}

export default function TradeBarsChart({ bars, trade }: TradeBarsChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // One-time chart construction. Resize observer keeps the chart sized to its
  // container so the panel can be responsive without us fighting it.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: true,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push data whenever the bars/trade change. Every change triggers a full
  // setData (the slice is tiny — ~30–40 bars), then markers + price lines are
  // rebuilt so we never leak lines across trade navigations.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    // Defensive: ensure ordered, unique bars even if the response came back mis-sorted.
    const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);

    const candles: CandlestickData<Time>[] = sorted
      .filter(
        (b) =>
          b.bar_open != null &&
          b.bar_high != null &&
          b.bar_low != null &&
          b.bar_close != null,
      )
      .map((b) => ({
        time: rawTimestampToUnix(b.bar_time) as Time,
        open: b.bar_open as number,
        high: b.bar_high as number,
        low: b.bar_low as number,
        close: b.bar_close as number,
      }));

    series.setData(candles);

    // Clear prior price lines on the series — createPriceLine stacks otherwise.
    const priceLines: ReturnType<typeof series.createPriceLine>[] = [];
    const addLine = (price: number | null, color: string, title: string) => {
      if (price == null || !Number.isFinite(price)) return;
      priceLines.push(
        series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title,
        }),
      );
    };
    addLine(trade.entry_price, "#3b82f6", "Entry");
    addLine(trade.exit_price, "#f59e0b", "Exit");
    addLine(trade.stop_loss_price, "#ef4444", "SL");
    addLine(trade.take_profit_price, "#22c55e", "TP");

    // Markers on the entry and exit bars.
    const markers: SeriesMarker<Time>[] = [];
    const entryBar = sorted.find((b) => b.is_entry_bar);
    const exitBar = sorted.find((b) => b.is_exit_bar);
    if (entryBar) {
      markers.push({
        time: rawTimestampToUnix(entryBar.bar_time) as Time,
        position: trade.direction === "Long" ? "belowBar" : "aboveBar",
        color: "#3b82f6",
        shape: trade.direction === "Long" ? "arrowUp" : "arrowDown",
        text: "Entry",
      });
    }
    if (exitBar) {
      markers.push({
        time: rawTimestampToUnix(exitBar.bar_time) as Time,
        position: trade.direction === "Long" ? "aboveBar" : "belowBar",
        color: "#f59e0b",
        shape: trade.direction === "Long" ? "arrowDown" : "arrowUp",
        text: "Exit",
      });
    }
    const markersPlugin = createSeriesMarkers(series, markers);

    chart.timeScale().fitContent();

    return () => {
      for (const pl of priceLines) {
        try {
          series.removePriceLine(pl);
        } catch {
          /* chart may already be disposed if the parent unmounts between effects */
        }
      }
      try {
        markersPlugin.detach();
      } catch {
        /* same — detach is a no-op once the series is gone */
      }
    };
  }, [
    bars,
    trade.entry_price,
    trade.exit_price,
    trade.stop_loss_price,
    trade.take_profit_price,
    trade.direction,
  ]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[220px] rounded-md overflow-hidden"
    />
  );
}
