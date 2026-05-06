/**
 * R-Multiple Histogram Chart
 *
 * Recharts BarChart showing the distribution of trade outcomes measured
 * in R-multiples (risk units). Green bars for positive R bins, red for
 * negative. Includes controls for outlier removal (IQR method) and
 * adjustable bin width.
 */

"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { buildRMultipleHistogram } from "@/lib/utils/trade-stats";
import { Trade } from "@/types/trade";

interface RMultipleHistogramProps {
  trades: Trade[];
}

export function RMultipleHistogram({ trades }: RMultipleHistogramProps) {
  // Local state for chart controls
  const [removeOutliers, setRemoveOutliers] = useState(false);
  const [binWidth, setBinWidth] = useState(0.5);

  // Recompute histogram data whenever trades, bin width, or outlier toggle changes
  const data = useMemo(
    () => buildRMultipleHistogram(trades, binWidth, removeOutliers),
    [trades, binWidth, removeOutliers]
  );

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      {/* Header row with title and controls */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          R-Multiple Distribution
        </h3>
        <div className="flex items-center gap-3">
          {/* Bin size input — allows adjusting histogram bucket width */}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Bin
            <input
              type="number"
              min={0.1}
              max={5.0}
              step={0.1}
              value={binWidth}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v >= 0.1 && v <= 5.0) setBinWidth(v);
              }}
              className="w-14 bg-background border border-card-border rounded px-1.5 py-0.5 text-xs text-foreground text-center focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>

          {/* Outlier toggle button — uses eye icon pattern matching other chart toggles */}
          <button
            onClick={() => setRemoveOutliers((prev) => !prev)}
            title={removeOutliers ? "Show outliers" : "Hide outliers"}
            className={`px-2 py-0.5 rounded text-xs border transition-colors ${
              removeOutliers
                ? "bg-accent/20 border-accent text-accent"
                : "bg-background border-card-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {removeOutliers ? "Outliers hidden" : "Outliers shown"}
          </button>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="bucket"
            tick={{ fill: "#71717a", fontSize: 10 }}
            tickLine={false}
            interval={0}
            angle={-45}
            textAnchor="end"
            height={60}
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111118",
              border: "1px solid #1e1e2a",
              borderRadius: "8px",
              color: "#e4e4e7",
            }}
            labelStyle={{ color: "#e4e4e7" }}
            itemStyle={{ color: "#e4e4e7" }}
            formatter={(value) => {
              const n = Number(value);
              return [`${n} trade${n !== 1 ? "s" : ""}`, "Count"];
            }}
            labelFormatter={(label) => `R: ${label}`}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {/* Color each bar green for positive R bins, red for negative */}
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={entry.isPositive ? "#22c55e" : "#ef4444"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
