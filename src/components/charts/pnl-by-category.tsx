/**
 * PnlByCategory Chart (Reusable)
 *
 * Generic Recharts BarChart that displays P&L grouped by any category.
 * Used by all 8 breakdown charts (time of day, direction, ATR, ADX, etc.).
 * Accepts a title, data array, and optional metric selector (totalPnl or avgPnl).
 *
 * - Bars are green (positive) or red (negative)
 * - Tooltip shows dollar amount + trade count
 * - Returns null if data is empty so charts with all-null fields simply hide
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
import { PnlByCategoryPoint } from "@/lib/utils/trade-stats";

interface PnlByCategoryProps {
  /** Chart heading shown above the bars */
  title: string;
  /** Array of category data points to render */
  data: PnlByCategoryPoint[];
  /** Which dollar metric to plot — defaults to totalPnl */
  metric?: "totalPnl" | "avgPnl";
  /** Optional element rendered on the right side of the title bar (e.g. toggle buttons) */
  headerRight?: React.ReactNode;
}

export function PnlByCategory({ title, data, metric = "totalPnl", headerRight }: PnlByCategoryProps) {
  // Don't render anything if there's no data (e.g. all nulls for a field)
  if (data.length === 0) return null;

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          {title}
        </h3>
        {headerRight && <div className="flex items-center gap-1">{headerRight}</div>}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
          <XAxis
            dataKey="category"
            tick={{ fill: "#71717a", fontSize: 11 }}
            tickLine={false}
            interval={0}
            angle={data.length > 6 ? -45 : 0}
            textAnchor={data.length > 6 ? "end" : "middle"}
            height={data.length > 6 ? 60 : 30}
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
            formatter={(value, _name, props) => {
              const count = (props.payload as PnlByCategoryPoint).tradeCount;
              const label = metric === "totalPnl" ? "Total P&L" : "Avg P&L";
              return [`$${Number(value).toFixed(2)} (${count} trade${count !== 1 ? "s" : ""})`, label];
            }}
          />
          <Bar dataKey={metric} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {/* Color each bar green or red based on the sign of the metric */}
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={entry[metric] >= 0 ? "#22c55e" : "#ef4444"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
