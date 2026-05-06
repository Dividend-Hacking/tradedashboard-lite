/**
 * PnlByTrade Chart
 *
 * Recharts BarChart showing per-trade P&L as green (positive) or
 * red (negative) bars. Each bar represents a single trade's P&L,
 * sorted chronologically by entry time.
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
import { TradePnlPoint } from "@/lib/utils/trade-stats";

interface PnlByTradeProps {
  data: TradePnlPoint[];
}

export function PnlByDay({ data }: PnlByTradeProps) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        P&L by Trade
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
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
            formatter={(value) => [`$${Number(value).toFixed(2)}`, "P&L"]}
          />
          <Bar dataKey="pnl" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {/* Color each bar green or red based on positive/negative P&L */}
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={entry.pnl >= 0 ? "#22c55e" : "#ef4444"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
