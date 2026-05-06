/**
 * CompositeTradeChart
 *
 * Renders the "perfect winning trade" — every winner from the current
 * backtest stacked, normalized, and merged into a single shape. The point
 * isn't to find a literal trade to copy; it's to reveal the SHAPE of how
 * winners typically unfold so a user can spot whether their winners pop
 * fast and grind, drift up linearly, or claw back from drawdowns.
 *
 * Two view modes (toggle in the header):
 *   - "% of exit" — every winner ends at 100%, so the chart shows pure
 *     shape. This is the default, and the one closest to the "composite
 *     face" analogy.
 *   - "Points" — same shape, raw points. Useful when the user wants to
 *     read magnitude (e.g. "median peak excursion is +6 pts before exit").
 *
 * Layers (from back to front):
 *   1. Each winner's individual normalized path, drawn as a faint line —
 *      together they form the "spaghetti" the median is averaging.
 *   2. p10/p90 envelope (lightest band) — the range the bulk of winners
 *      live inside.
 *   3. p25/p75 envelope (darker band) — the interquartile range.
 *   4. Median curve (bold cyan) — the prototype "perfect trade".
 *   5. Mean curve (dashed) — included as a sanity check; usually tracks
 *      the median but diverges when a few outliers skew the average.
 */

"use client";

import { useMemo, useState } from "react";
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
} from "recharts";
import { CompositeTradeResult } from "@/lib/utils/composite-trade";

interface CompositeTradeChartProps {
  composite: CompositeTradeResult;
  /** Called when the user clicks the close button in the header. */
  onClose?: () => void;
}

type ViewMode = "pct" | "points";

export function CompositeTradeChart({
  composite,
  onClose,
}: CompositeTradeChartProps) {
  const [view, setView] = useState<ViewMode>("pct");
  // Toggle for the spaghetti background. Off by default with > 50 winners
  // because the chart turns into noise — but power users can flip it on.
  const [showSpaghetti, setShowSpaghetti] = useState<boolean>(
    composite.winnerCount <= 50
  );

  // ── Build chart data ──────────────────────────────────────────
  // Recharts wants a flat array of objects; each object is one X-axis
  // tick with every series as a key. We assemble both the composite
  // stats and (optionally) every individual trade's value at this grid
  // point — so the spaghetti is rendered through Recharts' own line
  // pipeline rather than as separate SVG primitives.
  const chartData = useMemo(() => {
    return composite.points.map((pt, gi) => {
      const base: Record<string, number | string> = {
        tPct: pt.tPct,
        // Pre-pick the keys we'll actually plot so the tooltip's natural
        // keys-in-data behavior shows the right ones for the active view.
        median: view === "pct" ? pt.medianPct * 100 : pt.medianPoints,
        mean: view === "pct" ? pt.meanPct * 100 : pt.meanPoints,
        p10: view === "pct" ? pt.p10Pct * 100 : pt.p10Points,
        p25: view === "pct" ? pt.p25Pct * 100 : pt.p25Points,
        p75: view === "pct" ? pt.p75Pct * 100 : pt.p75Points,
        p90: view === "pct" ? pt.p90Pct * 100 : pt.p90Points,
        // Recharts stacks Areas additively. To draw a band between p25
        // and p75, the bottom must be p25 and the band's "height" is
        // (p75 - p25). Same trick for p10/p90 with the band being
        // p25 - p10 above and p90 - p75 above. We split into two
        // upper-band segments so the IQR sits visually inside the wider
        // 80% band.
        // To keep this simple though, we instead render two stacked
        // Areas representing the LOWER bound (transparent) and the
        // BAND height (visible). One stack for the 80% range.
        bandLow: view === "pct" ? pt.p10Pct * 100 : pt.p10Points,
        bandHigh: view === "pct" ? pt.p90Pct * 100 : pt.p90Points,
        iqrLow: view === "pct" ? pt.p25Pct * 100 : pt.p25Points,
        iqrHigh: view === "pct" ? pt.p75Pct * 100 : pt.p75Points,
      };
      // Append every individual normalized trade as a separate series key.
      // We name them "t0", "t1", ... — the Line components below render
      // them all with the same low-opacity stroke so they read as a
      // single faint cloud.
      if (showSpaghetti) {
        for (let ti = 0; ti < composite.trades.length; ti++) {
          const path = composite.trades[ti];
          const v =
            view === "pct"
              ? path.valuesPct[gi] * 100
              : path.valuesPoints[gi];
          base[`t${ti}`] = v;
        }
      }
      return base;
    });
  }, [composite, view, showSpaghetti]);

  // ── Empty state ───────────────────────────────────────────────
  // No winners → show a friendly message instead of an empty chart.
  if (composite.winnerCount === 0) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-6">
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
            Composite Winning Trade
          </h3>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-lg leading-none"
              aria-label="Close composite trade panel"
            >
              &times;
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          No winning trades in the current backtest yet. Run a backtest that
          produces at least one winner, then re-open this panel.
        </p>
      </div>
    );
  }

  const yAxisFormatter =
    view === "pct"
      ? (v: number) => `${Math.round(v)}%`
      : (v: number) => `${v.toFixed(1)} pts`;

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      {/* Header — title, view-mode toggle, spaghetti toggle, close. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
            Composite Winning Trade
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {composite.winnerCount} winner
            {composite.winnerCount === 1 ? "" : "s"} stacked, normalized to
            entry → exit. Median is the &quot;perfect trade&quot; shape;
            shaded bands are the 25–75 and 10–90 percentile envelopes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="inline-flex rounded-md border border-card-border overflow-hidden text-xs">
            <button
              onClick={() => setView("pct")}
              className={`px-2.5 py-1 transition-colors ${
                view === "pct"
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
              title="Normalize each trade so it ends at 100%"
            >
              % of exit
            </button>
            <button
              onClick={() => setView("points")}
              className={`px-2.5 py-1 transition-colors border-l border-card-border ${
                view === "points"
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
              title="Show raw points so magnitudes are comparable"
            >
              Points
            </button>
          </div>
          {/* Spaghetti toggle — off by default when there are many winners
              so the chart stays readable. */}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showSpaghetti}
              onChange={(e) => setShowSpaghetti(e.target.checked)}
              className="cursor-pointer"
            />
            Individual trades
          </label>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-lg leading-none ml-1"
              aria-label="Close composite trade panel"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Manual legend — Recharts 3.x narrowed the Legend payload prop, so
          a plain HTML row is the cleanest way to label the four meaningful
          series (median, mean, IQR band, 80% band) without leaking the
          helper "stack-floor" Areas or every spaghetti line into the
          legend. */}
      <div className="flex flex-wrap items-center gap-4 mb-2 text-xs text-muted-foreground">
        <LegendSwatch color="#38bdf8" type="line" thick label="Median (typical winner)" />
        <LegendSwatch color="#a78bfa" type="line" dashed label="Mean" />
        <LegendSwatch color="#38bdf8" type="rect" opacity={0.18} label="25–75% range" />
        <LegendSwatch color="#38bdf8" type="rect" opacity={0.08} label="10–90% range" />
      </div>

      <ResponsiveContainer width="100%" height={380}>
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="tPct"
            type="number"
            domain={[0, 100]}
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            tickFormatter={(v) => `${v}%`}
            label={{
              value: "Trade lifetime (entry → exit)",
              position: "insideBottom",
              offset: -2,
              fill: "#71717a",
              fontSize: 11,
            }}
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            tickFormatter={yAxisFormatter}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111118",
              border: "1px solid #1e1e2a",
              borderRadius: "8px",
              color: "#e4e4e7",
              fontSize: 11,
            }}
            labelStyle={{ color: "#e4e4e7" }}
            labelFormatter={(v) => `${v}% of trade`}
            formatter={(value, name) => {
              const n = Number(value);
              const formatted =
                view === "pct" ? `${n.toFixed(1)}%` : `${n.toFixed(2)} pts`;
              const labelMap: Record<string, string> = {
                median: "Median (typical)",
                mean: "Mean",
                p10: "p10",
                p25: "p25",
                p75: "p75",
                p90: "p90",
              };
              const label = labelMap[String(name)];
              // Hide individual trade lines and the helper band-low keys
              // from the tooltip — there can be hundreds of them and they
              // would drown the actual stats.
              if (!label) return null as unknown as [string, string];
              return [formatted, label];
            }}
          />
          {/* Zero line — entry-equivalent P&L. Visible reference for
              "is the typical winner ever underwater?". */}
          <ReferenceLine y={0} stroke="#52525b" strokeDasharray="2 2" />

          {/* ── 10–90 envelope ──
              Two stacked Areas: an invisible "floor" at p10 and a visible
              band on top going up by (p90 - p10). Recharts stacks Areas by
              series order within the same stackId, so we render the floor
              first and the band second. */}
          <Area
            type="monotone"
            dataKey="bandLow"
            stackId="band80"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
            legendType="none"
          />
          <Area
            type="monotone"
            dataKey={(d: Record<string, number>) =>
              (d.bandHigh as number) - (d.bandLow as number)
            }
            stackId="band80"
            stroke="none"
            fill="#38bdf8"
            fillOpacity={0.08}
            isAnimationActive={false}
            legendType="none"
            name="band80Top"
          />

          {/* ── 25–75 envelope ── (interquartile, darker so it reads as
              "more concentrated"). Same stacking trick on a separate
              stackId so it can sit on top of the wider envelope. */}
          <Area
            type="monotone"
            dataKey="iqrLow"
            stackId="iqr"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
            legendType="none"
          />
          <Area
            type="monotone"
            dataKey={(d: Record<string, number>) =>
              (d.iqrHigh as number) - (d.iqrLow as number)
            }
            stackId="iqr"
            stroke="none"
            fill="#38bdf8"
            fillOpacity={0.18}
            isAnimationActive={false}
            legendType="none"
            name="iqrTop"
          />

          {/* ── Spaghetti: every individual normalized trade ──
              Rendered as low-opacity Lines so they collectively read as a
              translucent cloud. We dodge dot rendering for performance —
              hundreds of dots per series gets very expensive. */}
          {showSpaghetti &&
            composite.trades.map((path, ti) => (
              <Line
                key={path.zoneId}
                type="monotone"
                dataKey={`t${ti}`}
                stroke="#94a3b8"
                strokeWidth={1}
                strokeOpacity={Math.max(0.05, 0.4 / Math.sqrt(composite.trades.length))}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                legendType="none"
              />
            ))}

          {/* ── Mean curve (dashed purple) ── */}
          <Line
            type="monotone"
            dataKey="mean"
            stroke="#a78bfa"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />

          {/* ── Median curve (bold cyan) ── This is the "perfect trade". */}
          <Line
            type="monotone"
            dataKey="median"
            stroke="#38bdf8"
            strokeWidth={3}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Footer — quick takeaway stats so the chart isn't the only place
          to read the result. Picks the median's value at a few obvious
          checkpoints (10%, 50%, peak). */}
      <CompositeFooterStats composite={composite} view={view} />
    </div>
  );
}

/**
 * Renders a row of summary stats describing the median winner's path.
 * Computed inline because they're cheap (a few lookups + one max scan)
 * and inlining keeps the chart component self-contained.
 */
function CompositeFooterStats({
  composite,
  view,
}: {
  composite: CompositeTradeResult;
  view: ViewMode;
}) {
  const stats = useMemo(() => {
    const pts = composite.points;
    if (pts.length === 0) return null;

    // Find checkpoint indices in the grid. We care about the median's
    // value at fixed time fractions of the trade.
    const findClosest = (target: number) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i].t - target);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return pts[bestIdx];
    };

    const at10 = findClosest(0.1);
    const at50 = findClosest(0.5);

    // Find the median's peak across the trade, and its worst drawdown.
    // Use the point fields directly so we report magnitudes the user can
    // act on rather than normalized fractions when the view is "Points".
    let peakV = -Infinity;
    let peakT = 0;
    let troughV = Infinity;
    for (const p of pts) {
      const v = view === "pct" ? p.medianPct * 100 : p.medianPoints;
      if (v > peakV) {
        peakV = v;
        peakT = p.tPct;
      }
      if (v < troughV) troughV = v;
    }

    const fmt = (v: number) =>
      view === "pct" ? `${v.toFixed(1)}%` : `${v.toFixed(2)} pts`;

    return {
      at10: view === "pct" ? at10.medianPct * 100 : at10.medianPoints,
      at50: view === "pct" ? at50.medianPct * 100 : at50.medianPoints,
      peakV,
      peakT,
      troughV,
      fmt,
    };
  }, [composite, view]);

  if (!stats) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-card-border">
      <Stat label="Median @ 10% in" value={stats.fmt(stats.at10)} />
      <Stat label="Median @ halfway" value={stats.fmt(stats.at50)} />
      <Stat
        label={`Median peak (~${stats.peakT.toFixed(0)}% in)`}
        value={stats.fmt(stats.peakV)}
      />
      <Stat
        label="Median worst point"
        value={stats.fmt(stats.troughV)}
        negative={stats.troughV < 0}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  negative = false,
}: {
  label: string;
  value: string;
  negative?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-sm font-semibold ${
          negative ? "text-accent-red" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** Tiny swatch + label pairing for the manual chart legend. Lives in this
 *  file because it's an implementation detail of CompositeTradeChart only. */
function LegendSwatch({
  color,
  type,
  label,
  dashed = false,
  thick = false,
  opacity = 1,
}: {
  color: string;
  type: "line" | "rect";
  label: string;
  dashed?: boolean;
  thick?: boolean;
  opacity?: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {type === "line" ? (
        <span
          className="inline-block"
          style={{
            width: 18,
            height: thick ? 3 : 2,
            backgroundColor: color,
            opacity,
            borderTop: dashed ? `2px dashed ${color}` : undefined,
            backgroundImage: dashed ? "none" : undefined,
          }}
        />
      ) : (
        <span
          className="inline-block rounded-sm"
          style={{
            width: 14,
            height: 10,
            backgroundColor: color,
            opacity,
          }}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
