/**
 * EquityCurve Chart
 *
 * Recharts AreaChart showing cumulative P&L over time.
 * Uses a green line with a gradient fill below to visualize
 * the overall equity growth/decline across trades.
 */

"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { EquityPoint } from "@/lib/utils/trade-stats";

interface EquityCurveProps {
  data: EquityPoint[];
}

export function EquityCurve({ data }: EquityCurveProps) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        Equity Curve
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          {/* Gradient fill definition for the area under the line */}
          <defs>
            <linearGradient id="greenGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            tickFormatter={(v) => `$${v}`}
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
            formatter={(value) => [`$${Number(value).toFixed(2)}`, "Cumulative P&L"]}
          />
          <Area
            type="monotone"
            dataKey="cumulativePnl"
            stroke="#22c55e"
            strokeWidth={2}
            fill="url(#greenGradient)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
