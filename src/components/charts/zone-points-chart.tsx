/**
 * ZonePointsChart
 *
 * Bar chart showing points_move for each trade zone, color-coded green/red.
 * Similar to PnlByDay for trades but displays zone point deltas instead.
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
} from "recharts";
import { ZonePointsChartPoint } from "@/lib/utils/zone-stats";

interface ZonePointsChartProps {
  data: ZonePointsChartPoint[];
}

export function ZonePointsChart({ data }: ZonePointsChartProps) {
  if (data.length === 0) return null;

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        Points Move per Zone
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#71717a", fontSize: 10 }}
            tickLine={false}
            interval={0}
            angle={data.length > 8 ? -45 : 0}
            textAnchor={data.length > 8 ? "end" : "middle"}
            height={data.length > 8 ? 60 : 30}
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
            formatter={(value) => {
              const n = Number(value);
              return [
                `${n > 0 ? "+" : ""}${n.toFixed(2)} pts`,
                "Points Move",
              ];
            }}
          />
          <Bar
            dataKey="pointsMove"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          >
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={entry.pointsMove >= 0 ? "#22c55e" : "#ef4444"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
