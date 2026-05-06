/**
 * SimulatorResultsChart — Per-zone bar chart comparing original vs simulated P&L.
 * Two bar series: original (semi-transparent) and simulated (solid green/red).
 */

"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  Legend,
} from "recharts";
import { SimZoneResult } from "@/lib/utils/zone-simulator";
import { formatDate } from "@/lib/utils/format";

interface SimulatorResultsChartProps {
  results: SimZoneResult[];
}

export function SimulatorResultsChart({ results }: SimulatorResultsChartProps) {
  if (results.length === 0) return null;

  // Build chart data with both original and simulated points per zone.
  // simPoints uses scaledPoints so the bars reflect the scaling modifier when
  // it's on — same convention as the summary cards and equity curve. When
  // scaling is off scaledPoints === exitPoints so behavior is unchanged.
  const data = results.map((r, i) => {
    const label = `${formatDate(r.startTime)} ${r.direction[0]}`;
    return {
      label,
      index: i,
      originalPoints: r.originalPoints,
      simPoints: r.scaledPoints,
      exitReason: r.exitReason,
    };
  });

  return (
    <div className="bg-card border border-card-border rounded-lg p-4 mb-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        Original vs Simulated P&L per Zone
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#71717a", fontSize: 10 }}
            tickLine={false}
            interval={0}
            angle={data.length > 10 ? -45 : 0}
            textAnchor={data.length > 10 ? "end" : "middle"}
            height={data.length > 10 ? 60 : 30}
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            tickFormatter={(v) => `${v} pts`}
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
            formatter={(value, name) => {
              const n = Number(value);
              return [
                `${n > 0 ? "+" : ""}${n.toFixed(2)} pts`,
                name === "originalPoints" ? "Original" : "Simulated",
              ];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "#71717a" }}
            formatter={(value) => (value === "originalPoints" ? "Original" : "Simulated")}
          />
          {/* Original points — semi-transparent */}
          <Bar dataKey="originalPoints" radius={[4, 4, 0, 0]} isAnimationActive={false} opacity={0.3}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.originalPoints >= 0 ? "#22c55e" : "#ef4444"} />
            ))}
          </Bar>
          {/* Simulated points — solid */}
          <Bar dataKey="simPoints" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.simPoints >= 0 ? "#22c55e" : "#ef4444"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
