/**
 * SimulatorSegmentCharts — analytics histograms below the trade table.
 *
 * Renders a grid of per-dimension P&L histograms over the simulator's
 * SimZoneResult[]. The default set covers trade-outcome dimensions (MAE,
 * MFE, time in trade, trade #) and categorical dimensions (direction,
 * exit reason, hour, day of week, streak before, position size).
 *
 * Entry-time indicator histograms (ATR/ADX/EMA/Bollinger/Volume/RSI/Trend
 * Correlation) are NOT rendered by default any more — users opt into the
 * specific indicator buckets they care about by writing
 * `graph = <expr>` (or `graph["Title"] = <expr>`) in the strategy DSL.
 * Each directive arrives here in `graphData` already evaluated at every
 * surviving trade's entry bar; this component just buckets and renders.
 *
 * All builders use `r.scaledPoints` so the histograms reflect actual
 * size-aware realized P&L when the scaling modifier is on, matching the
 * equity curve and stat cards above. Toggle between Total and Avg P&L is
 * shared across every chart so one click flips the whole panel.
 */

"use client";

import { useMemo, useState } from "react";
import { TradeZone } from "@/types/trade-zone";
import { SimZoneResult } from "@/lib/utils/zone-simulator";
import { PnlByCategory } from "./charts/pnl-by-category";
import {
  computeContextMaps,
  buildByTimeInTrade,
  buildByMae,
  buildByMfe,
  buildByTradeNumber,
  buildByDirection,
  buildByHourOfDay,
  buildByDayOfWeek,
  buildByExitReason,
  buildByPositionSize,
  buildByStreakBefore,
  bucketEqualWidth,
} from "@/lib/utils/sim-segment-stats";

/** One per-trade row produced by evaluating a `graph = <expr>` directive
 *  at every surviving trade's entry bar. The dashboard pairs the
 *  expression's numeric result with `t.scaledPoints` so this component
 *  only needs to bucket — same shape `bucketEqualWidth` already takes. */
export interface GraphDirectiveData {
  /** Display title for the histogram (RHS source text or explicit
   *  `graph["Title"]` label). */
  title: string;
  /** One row per surviving trade. NaNs are pre-filtered upstream. */
  rows: Array<{ value: number; pnl: number }>;
}

interface SimulatorSegmentChartsProps {
  results: SimZoneResult[];
  zones: TradeZone[];
  /** Whether the scaling modifier is currently on — used to decide if the
   *  per-position-size chart should render (otherwise every trade is ×1
   *  and the chart degenerates to a single bar). */
  scalingEnabled?: boolean;
  /** User-declared `graph = <expr>` histograms, one per directive. Each
   *  is rendered at the bottom of the segment-charts grid using the same
   *  `<PnlByCategory>` component as the built-in dimensions. */
  graphData?: GraphDirectiveData[];
}

// Default bucket counts per chart. Picked to give "useful out of the box"
// granularity — users can tune per-chart with the inline input.
const DEFAULT_BUCKETS: Record<string, number> = {
  timeInTrade: 6,
  mae: 6,
  mfe: 6,
  tradeNumber: 5,
};

export function SimulatorSegmentCharts({
  results,
  zones,
  scalingEnabled,
  graphData,
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
  //
  // `graphPoints` buckets each user-declared `graph = <expr>` directive
  // with equal-width 10-bin binning — chosen over quantile so outliers the
  // user explicitly asked to plot stay visible at the tails. Empty bins
  // are dropped by `bucketEqualWidth` so an arbitrary expression's natural
  // range still renders cleanly.
  const data = useMemo(() => {
    const z = { zonesById: ctxMaps.zonesById };
    return {
      timeInTrade: buildByTimeInTrade(results, buckets.timeInTrade),
      mae: buildByMae(results, buckets.mae),
      mfe: buildByMfe(results, buckets.mfe),
      tradeNumber: buildByTradeNumber(results, buckets.tradeNumber),
      direction: buildByDirection(results, z),
      hourOfDay: buildByHourOfDay(results),
      dayOfWeek: buildByDayOfWeek(results),
      exitReason: buildByExitReason(results),
      positionSize: scalingEnabled ? buildByPositionSize(results) : [],
      streakBefore: buildByStreakBefore(results, ctxMaps.streakBefore),
      graphPoints: (graphData ?? []).map((g) => ({
        title: g.title,
        points: bucketEqualWidth(
          g.rows,
          10,
          (lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}`
        ),
      })),
    };
  }, [results, ctxMaps, buckets, scalingEnabled, graphData]);

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
          with its own optional bucket input on the right of its title.
          Entry-time indicator histograms have moved to user-declared
          `graph = <expr>` directives, rendered in the trailing block. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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

        {/* ── User-declared `graph = <expr>` histograms ──
            One panel per directive, rendered after the built-ins so the
            ad-hoc plots stay together at the bottom of the section. The
            shared `metric` prop flows in unchanged so the section's
            Total/Avg toggle flips these along with everything else. */}
        {data.graphPoints.map((g, i) => (
          <PnlByCategory
            key={`graph-${i}-${g.title}`}
            title={g.title}
            data={g.points}
            metric={metric}
          />
        ))}
      </div>
    </div>
  );
}
