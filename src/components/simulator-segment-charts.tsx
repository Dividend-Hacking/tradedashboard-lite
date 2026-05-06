/**
 * SimulatorSegmentCharts — analytics histograms below the trade table.
 *
 * Renders a grid of per-dimension P&L histograms over the simulator's
 * SimZoneResult[]. For continuous metrics (ADX, ATR, RSI, MAE, MFE, time in
 * trade, trade #, distance from EMA20, Bollinger BW, volume) a bucket-count
 * input on the chart header re-bins the data live; for categorical
 * dimensions (direction, EMA20 / EMA200 position, Bollinger position,
 * trend correlation, hour, day of week, exit reason, position size, streak
 * before) the buckets are fixed.
 *
 * All builders use `r.scaledPoints` so the histograms reflect actual
 * size-aware realized P&L when the scaling modifier is on, matching the
 * equity curve and stat cards above. Toggle between Total and Avg P&L is
 * shared across every chart so one click flips the whole panel.
 */

"use client";

import { useMemo, useState } from "react";
import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimZoneResult } from "@/lib/utils/zone-simulator";
import { PnlByCategory } from "./charts/pnl-by-category";
import {
  computeContextMaps,
  buildByAdx,
  buildByAtr,
  buildByBollingerBw,
  buildByDistEma20,
  buildByVolume,
  buildByRsi,
  buildByTimeInTrade,
  buildByMae,
  buildByMfe,
  buildByTradeNumber,
  buildByDirection,
  buildByEma20,
  buildByEma200,
  buildByBollinger,
  buildByTrendCorrelation,
  buildByHourOfDay,
  buildByDayOfWeek,
  buildByExitReason,
  buildByPositionSize,
  buildByStreakBefore,
} from "@/lib/utils/sim-segment-stats";

interface SimulatorSegmentChartsProps {
  results: SimZoneResult[];
  zones: TradeZone[];
  /** In-zone bars — used for the volume-at-entry chart. */
  barsByZoneId?: Map<number, TradeZoneBar[]>;
  /** Pre-entry context bars — used for RSI(14) computation. Optional;
   *  the RSI chart simply hides when this isn't loaded. */
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  /** Per-zone ATR(14) computed from replay bars; falls back to ctx_atr14. */
  atrByZoneId?: Map<number, number> | null;
  /** Whether the scaling modifier is currently on — used to decide if the
   *  per-position-size chart should render (otherwise every trade is ×1
   *  and the chart degenerates to a single bar). */
  scalingEnabled?: boolean;
}

// Default bucket counts per chart. Picked to give "useful out of the box"
// granularity — users can tune per-chart with the inline input.
const DEFAULT_BUCKETS: Record<string, number> = {
  adx: 6,
  atr: 5,
  bollingerBw: 6,
  distEma20: 7,
  volume: 5,
  rsi: 10, // 10 bins → 10pt RSI bands (0–10, 10–20, ...)
  timeInTrade: 6,
  mae: 6,
  mfe: 6,
  tradeNumber: 5,
};

export function SimulatorSegmentCharts({
  results,
  zones,
  barsByZoneId,
  preEntryBarsByZoneId,
  atrByZoneId,
  scalingEnabled,
}: SimulatorSegmentChartsProps) {
  // One bucket-count value per continuous chart. State keyed by chart id.
  const [buckets, setBuckets] = useState<Record<string, number>>(DEFAULT_BUCKETS);
  // Total vs Avg toggle is shared across every chart — one button flips
  // them all so users can compare the two views consistently.
  const [metric, setMetric] = useState<"totalPnl" | "avgPnl">("totalPnl");

  // Pre-compute zone lookup + streak map once per render. Cheap (O(N)) and
  // every builder needs at least one of these.
  const ctxMaps = useMemo(() => computeContextMaps(results, zones), [results, zones]);

  // Build all chart data sets together so the useMemo deps are explicit and
  // a single results / zones change triggers one re-bin sweep.
  const data = useMemo(() => {
    const z = { zonesById: ctxMaps.zonesById };
    const zAtr = { zonesById: ctxMaps.zonesById, atrByZoneId };
    const zPre = { zonesById: ctxMaps.zonesById, preEntryBarsByZoneId };
    return {
      adx: buildByAdx(results, z, buckets.adx),
      atr: buildByAtr(results, zAtr, buckets.atr),
      bollingerBw: buildByBollingerBw(results, z, buckets.bollingerBw),
      distEma20: buildByDistEma20(results, z, buckets.distEma20),
      volume: buildByVolume(results, { barsByZoneId }, buckets.volume),
      rsi: buildByRsi(results, zPre, buckets.rsi),
      timeInTrade: buildByTimeInTrade(results, buckets.timeInTrade),
      mae: buildByMae(results, buckets.mae),
      mfe: buildByMfe(results, buckets.mfe),
      tradeNumber: buildByTradeNumber(results, buckets.tradeNumber),
      direction: buildByDirection(results, z),
      ema20: buildByEma20(results, z),
      ema200: buildByEma200(results, z),
      bollinger: buildByBollinger(results, z),
      trendCorr: buildByTrendCorrelation(results, z),
      hourOfDay: buildByHourOfDay(results),
      dayOfWeek: buildByDayOfWeek(results),
      exitReason: buildByExitReason(results),
      positionSize: scalingEnabled ? buildByPositionSize(results) : [],
      streakBefore: buildByStreakBefore(results, ctxMaps.streakBefore),
    };
  }, [results, ctxMaps, buckets, barsByZoneId, preEntryBarsByZoneId, atrByZoneId, scalingEnabled]);

  // Don't render anything when there are no results yet — keeps the
  // dashboard clean during the initial loading state.
  if (results.length === 0) return null;

  // Reusable input rendered in the chart header for continuous dimensions.
  // Min 2 / max 30 — below 2 there's no histogram, above 30 the x-axis
  // labels get unreadable in the available width.
  const bucketInput = (key: string) => (
    <label className="flex items-center gap-1.5" title="Number of histogram bins">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Bins</span>
      <input
        type="number"
        min={2}
        max={30}
        step={1}
        value={buckets[key]}
        onChange={(e) => {
          const v = Math.max(2, Math.min(30, parseInt(e.target.value) || DEFAULT_BUCKETS[key]));
          setBuckets((prev) => ({ ...prev, [key]: v }));
        }}
        className="w-12 bg-card border border-card-border rounded-md px-2 py-0.5 text-xs text-right text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
      />
    </label>
  );

  // Metric toggle rendered in the section header so it flips ALL charts at once.
  const metricToggle = (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Metric:</span>
      <button
        onClick={() => setMetric("totalPnl")}
        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
          metric === "totalPnl"
            ? "bg-accent-green/20 text-accent-green"
            : "bg-white/5 text-muted-foreground hover:text-foreground"
        }`}
      >
        Total
      </button>
      <button
        onClick={() => setMetric("avgPnl")}
        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
          metric === "avgPnl"
            ? "bg-accent-green/20 text-accent-green"
            : "bg-white/5 text-muted-foreground hover:text-foreground"
        }`}
      >
        Avg
      </button>
    </div>
  );

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm text-muted-foreground uppercase tracking-wider">
          Trade Segment Analysis
        </h2>
        {metricToggle}
      </div>

      {/* Two-column responsive grid — each chart is a self-contained panel
          with its own optional bucket input on the right of its title. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Market context (entry-time analytics) ── */}
        <PnlByCategory title="ADX (Trend Strength)" data={data.adx} metric={metric} headerRight={bucketInput("adx")} />
        <PnlByCategory title="ATR (Volatility)" data={data.atr} metric={metric} headerRight={bucketInput("atr")} />
        <PnlByCategory title="EMA20 Position" data={data.ema20} metric={metric} />
        <PnlByCategory title="EMA200 Position" data={data.ema200} metric={metric} />
        <PnlByCategory title="Bollinger Position" data={data.bollinger} metric={metric} />
        <PnlByCategory title="Bollinger Bandwidth" data={data.bollingerBw} metric={metric} headerRight={bucketInput("bollingerBw")} />
        <PnlByCategory title="Distance from EMA20 (ATR)" data={data.distEma20} metric={metric} headerRight={bucketInput("distEma20")} />
        <PnlByCategory title="Volume at Entry" data={data.volume} metric={metric} headerRight={bucketInput("volume")} />
        <PnlByCategory title="RSI(14) at Entry" data={data.rsi} metric={metric} headerRight={bucketInput("rsi")} />
        <PnlByCategory title="Trend Correlation" data={data.trendCorr} metric={metric} />

        {/* ── Trade characteristics (outcome-time analytics) ── */}
        <PnlByCategory title="Time in Trade" data={data.timeInTrade} metric={metric} headerRight={bucketInput("timeInTrade")} />
        <PnlByCategory title="MAE (Adverse Excursion)" data={data.mae} metric={metric} headerRight={bucketInput("mae")} />
        <PnlByCategory title="MFE (Favorable Excursion)" data={data.mfe} metric={metric} headerRight={bucketInput("mfe")} />
        <PnlByCategory title="Exit Reason" data={data.exitReason} metric={metric} />

        {/* ── Sequence / time of day ── */}
        <PnlByCategory title="Trade # in Sequence" data={data.tradeNumber} metric={metric} headerRight={bucketInput("tradeNumber")} />
        <PnlByCategory title="Streak Before Trade" data={data.streakBefore} metric={metric} />
        <PnlByCategory title="Hour of Day" data={data.hourOfDay} metric={metric} />
        <PnlByCategory title="Day of Week" data={data.dayOfWeek} metric={metric} />
        <PnlByCategory title="Direction" data={data.direction} metric={metric} />

        {/* Position-size chart is only meaningful when scaling is on; the
            builder returns [] otherwise and PnlByCategory renders nothing. */}
        {scalingEnabled && (
          <PnlByCategory title="Position Size" data={data.positionSize} metric={metric} />
        )}
      </div>
    </div>
  );
}
