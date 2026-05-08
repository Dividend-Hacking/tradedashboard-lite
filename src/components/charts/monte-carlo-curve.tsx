/**
 * MonteCarloCurve — Projected equity-curve chart from a Monte Carlo run.
 *
 * Renders three layers stacked over the same X-axis (trade index):
 *  - Outer band (5th..95th percentile) drawn as a translucent fill, so
 *    the user can see the wide cone of plausible outcomes.
 *  - Inner band (25th..75th percentile) drawn as a darker translucent
 *    fill — the interquartile cone, where half the simulations live.
 *  - Median path drawn as a solid line — the "most likely" trajectory.
 *
 * Recharts renders bands by passing an [low, high] tuple as the dataKey
 * value of an Area; the Area fills between the two y-values rather than
 * down to zero. We precompute these tuples here so the chart can be a
 * pure-render component.
 *
 * The stat tiles below the chart surface the cross-simulation
 * distribution of FINAL equity values: % profitable, median final P&L,
 * worst/best case at the 5th/95th percentiles, and a path-dependent
 * drawdown stat (the median worst peak-to-trough loss observed within
 * a single simulation).
 */

"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from "recharts";
import type { MonteCarloResult, MonteCarloHorizon } from "@/lib/utils/monte-carlo";
import { formatCurrency, formatPercent } from "@/lib/utils/format";

interface MonteCarloCurveProps {
  result: MonteCarloResult;
  /** Called when the user clicks the dismiss button. Hides the chart. */
  onDismiss: () => void;
}

const HORIZON_LABEL: Record<MonteCarloHorizon, string> = {
  "1W": "1 Week",
  "1M": "1 Month",
  "1Y": "1 Year",
};

/**
 * Format a P&L value in the active mode. Mirrors the rendering in
 * SimulatorStatCards / ZoneEquityCurve so the user sees consistent
 * units across the dashboard.
 */
function formatPnL(value: number, mode: "points" | "dollars"): string {
  if (mode === "dollars") return formatCurrency(value);
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} pts`;
}

/**
 * Color of a P&L magnitude — green for profit, red for loss, neutral
 * for zero. Used on the stat tiles so the user can grep the panel
 * visually for "is this strategy profitable in this horizon?".
 */
function pnlColor(value: number): string {
  if (value > 0) return "text-accent-green";
  if (value < 0) return "text-accent-red";
  return "text-foreground";
}

export function MonteCarloCurve({ result, onDismiss }: MonteCarloCurveProps) {
  const { curve, stats, mode, horizon } = result;

  // Recharts wants the tuple [low, high] sitting on a single field per
  // datum. We pre-build both bands here so the chart's Area components
  // can read straight off the row without further computation. Round
  // to two decimals to keep the SVG path tidy and the tooltip readable.
  const chartData = curve.map((p) => ({
    tradeIndex: p.tradeIndex,
    median: Math.round(p.median * 100) / 100,
    outerBand: [
      Math.round(p.p5 * 100) / 100,
      Math.round(p.p95 * 100) / 100,
    ] as [number, number],
    innerBand: [
      Math.round(p.p25 * 100) / 100,
      Math.round(p.p75 * 100) / 100,
    ] as [number, number],
  }));

  const isDollars = mode === "dollars";

  // Y-axis formatter — we deliberately keep it short ("$1.2k", "120 pts")
  // because the band can stretch the axis range over a wide span,
  // especially on the 1Y horizon. Long axis labels would crowd out the
  // chart area.
  const yTickFormatter = (v: number) => {
    if (isDollars) {
      const abs = Math.abs(v);
      if (abs >= 1000) return `$${(v / 1000).toFixed(1)}k`;
      return `$${v.toFixed(0)}`;
    }
    return `${v.toFixed(0)}`;
  };

  return (
    <div className="bg-card border border-card-border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
            Monte Carlo Projection · {HORIZON_LABEL[horizon]}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {stats.numSimulations.toLocaleString()} simulations ·{" "}
            {stats.numTrades.toLocaleString()} trades per run · resampled from
            historical results
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-card-border hover:border-foreground transition-colors"
        >
          Dismiss
        </button>
      </div>

      {/* ── Equity curve with confidence bands ───────────────────────── */}
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={chartData}>
          <defs>
            {/* Outer (5–95) band — wide light cyan cone. */}
            <linearGradient id="mcOuterGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.18} />
            </linearGradient>
            {/* Inner (25–75) band — darker cyan, more saturated so the
                interquartile range pops against the outer cone. */}
            <linearGradient id="mcInnerGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.35} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="tradeIndex"
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            interval="preserveStartEnd"
            label={{
              value: "Trade #",
              position: "insideBottom",
              offset: -5,
              fill: "#71717a",
              fontSize: 11,
            }}
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            tickFormatter={yTickFormatter}
          />
          {/* Zero line — anchors the chart so the user can see at a glance
              when bands cross from profit to loss territory. */}
          <ReferenceLine y={0} stroke="#52525b" strokeDasharray="2 2" />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111118",
              border: "1px solid #1e1e2a",
              borderRadius: "8px",
              color: "#e4e4e7",
            }}
            labelStyle={{ color: "#e4e4e7" }}
            formatter={(value, name) => {
              if (Array.isArray(value)) {
                const [lo, hi] = value as [number, number];
                return [
                  `${formatPnL(lo, mode)} → ${formatPnL(hi, mode)}`,
                  name === "outerBand" ? "5–95% range" : "25–75% range",
                ];
              }
              return [formatPnL(Number(value), mode), "Median"];
            }}
            labelFormatter={(label) => `Trade #${label}`}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "#71717a" }}
            formatter={(value) => {
              if (value === "outerBand") return "5–95% range";
              if (value === "innerBand") return "25–75% range";
              return "Median (most likely)";
            }}
          />

          {/* Outer band (5–95). Drawn first so the inner band paints on top. */}
          <Area
            type="monotone"
            dataKey="outerBand"
            stroke="none"
            fill="url(#mcOuterGrad)"
            isAnimationActive={false}
          />
          {/* Inner band (25–75). */}
          <Area
            type="monotone"
            dataKey="innerBand"
            stroke="none"
            fill="url(#mcInnerGrad)"
            isAnimationActive={false}
          />
          {/* Median path — the "most likely scenario" line. Drawn last
              so it always renders on top of both bands. */}
          <Line
            type="monotone"
            dataKey="median"
            stroke="#38bdf8"
            strokeWidth={2.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* ── Stat tiles ───────────────────────────────────────────────
          Six metrics that complete the picture the chart can't show:
          probability of profit, median outcome, worst-case (p5), best-case
          (p95), and a path-dependent drawdown stat. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatTile
          label="Profitable Runs"
          value={formatPercent(stats.pctProfitable)}
          color={
            stats.pctProfitable >= 0.5
              ? "text-accent-green"
              : stats.pctProfitable >= 0.4
                ? "text-foreground"
                : "text-accent-red"
          }
          tooltip={`${Math.round(stats.pctProfitable * stats.numSimulations).toLocaleString()} of ${stats.numSimulations.toLocaleString()} simulations ended above zero P&L.`}
        />
        <StatTile
          label="Median Final"
          value={formatPnL(stats.medianFinal, mode)}
          color={pnlColor(stats.medianFinal)}
          tooltip="Middle simulation's ending P&L — the most-likely outcome."
        />
        <StatTile
          label="Mean Final"
          value={formatPnL(stats.meanFinal, mode)}
          color={pnlColor(stats.meanFinal)}
          tooltip="Average ending P&L across all simulations. When this differs noticeably from the median, the outcome distribution is skewed."
        />
        <StatTile
          label="Worst 5%"
          value={formatPnL(stats.p5Final, mode)}
          color={pnlColor(stats.p5Final)}
          tooltip="5th-percentile final P&L. 1 in 20 outcomes ends at or below this value."
        />
        <StatTile
          label="Best 5%"
          value={formatPnL(stats.p95Final, mode)}
          color={pnlColor(stats.p95Final)}
          tooltip="95th-percentile final P&L. 1 in 20 outcomes ends at or above this value."
        />
        <StatTile
          label="Median Drawdown"
          value={formatPnL(-stats.medianMaxDrawdown, mode)}
          color="text-accent-red"
          tooltip={`Path-dependent risk: the median worst peak-to-trough loss observed within a single simulation. 1-in-20 worst drawdown: ${formatPnL(-stats.p95MaxDrawdown, mode)}.`}
        />
      </div>
    </div>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  color: string;
  tooltip: string;
}

/**
 * Small stat-card primitive used only by the Monte Carlo panel. We don't
 * reuse SimulatorStatCards' tile because its shape is hard-wired to the
 * SimSummary props — the MC stats are different metrics.
 */
function StatTile({ label, value, color, tooltip }: StatTileProps) {
  return (
    <div
      className="bg-background border border-card-border rounded-md p-3"
      title={tooltip}
    >
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}
