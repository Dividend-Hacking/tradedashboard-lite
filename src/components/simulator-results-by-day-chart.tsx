/**
 * SimulatorResultsByDayChart — Per-day bar chart comparing original vs
 * simulated P&L.
 *
 * Same idea as SimulatorResultsChart but aggregates across all trades within
 * the same calendar day (using rawDateString so the local-calendar grouping
 * matches how zones are timestamped — no timezone conversion). Two bar
 * series per day: original (semi-transparent) and simulated (solid
 * green/red). Bar color reflects the sign of that day's net points, so a
 * losing day shows red even if a few individual trades were winners.
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
import { formatDate, rawDateString } from "@/lib/utils/format";

interface SimulatorResultsByDayChartProps {
  results: SimZoneResult[];
}

export function SimulatorResultsByDayChart({ results }: SimulatorResultsByDayChartProps) {
  if (results.length === 0) return null;

  // Aggregate results by calendar day. Keys are YYYY-MM-DD so sorting them
  // lexicographically also sorts chronologically. Using scaledPoints for the
  // simulated side keeps this consistent with SimulatorResultsChart and the
  // equity curve — when scaling is off, scaledPoints === exitPoints.
  const byDay = new Map<
    string,
    { originalPoints: number; simPoints: number; tradeCount: number; firstStartTime: string }
  >();
  for (const r of results) {
    const key = rawDateString(r.startTime);
    const existing = byDay.get(key);
    if (existing) {
      existing.originalPoints += r.originalPoints;
      existing.simPoints += r.scaledPoints;
      existing.tradeCount += 1;
    } else {
      byDay.set(key, {
        originalPoints: r.originalPoints,
        simPoints: r.scaledPoints,
        tradeCount: 1,
        firstStartTime: r.startTime,
      });
    }
  }

  const data = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => ({
      label: formatDate(v.firstStartTime),
      originalPoints: Math.round(v.originalPoints * 100) / 100,
      simPoints: Math.round(v.simPoints * 100) / 100,
      tradeCount: v.tradeCount,
    }));

  return (
    <div className="bg-card border border-card-border rounded-lg p-4 mb-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        Original vs Simulated P&L per Day
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
            formatter={(value, name, entry) => {
              const n = Number(value);
              // Surface the trade count on the first row only so the tooltip
              // shows "3 trades" once per day instead of duplicating it.
              const label = name === "originalPoints" ? "Original" : "Simulated";
              const count = entry?.payload?.tradeCount;
              const suffix =
                name === "originalPoints" && count !== undefined
                  ? `  (${count} trade${count === 1 ? "" : "s"})`
                  : "";
              return [`${n > 0 ? "+" : ""}${n.toFixed(2)} pts${suffix}`, label];
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
