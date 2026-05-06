/**
 * WinLossDistribution Chart
 *
 * Recharts PieChart (donut style) showing the ratio of wins to losses.
 * Green slice for wins, red for losses, with labels showing
 * the count for each category.
 */

"use client";

import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from "recharts";
import { WinLossSlice } from "@/lib/utils/trade-stats";

interface WinLossDistributionProps {
  data: WinLossSlice[];
}

/** Color mapping: Wins = green, Losses = red */
const COLORS = ["#22c55e", "#ef4444"];

export function WinLossDistribution({ data }: WinLossDistributionProps) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4 mb-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        Win / Loss Distribution
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={70}
            outerRadius={110}
            paddingAngle={3}
            dataKey="value"
            label={({ name, value }) => `${name}: ${value}`}
          >
            {data.map((_, index) => (
              <Cell key={index} fill={COLORS[index]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "#111118",
              border: "1px solid #1e1e2a",
              borderRadius: "8px",
              color: "#e4e4e7",
            }}
            labelStyle={{ color: "#e4e4e7" }}
            itemStyle={{ color: "#e4e4e7" }}
          />
          <Legend
            wrapperStyle={{ color: "#a1a1aa", fontSize: "13px" }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
