/**
 * ZoneEquityCurve — Cumulative points/dollars curve for trade zones.
 *
 * Renders up to two Area series:
 *  - Original: the unmodified zone outcomes (green). Controlled by
 *    `showOriginal` (default true).
 *  - Simulated: the rule-applied outcomes (cyan/blue). Controlled by
 *    `showSimulated`. When the backtesting dashboard wants ONLY the
 *    simulated curve, callers pass `showOriginal={false}` and
 *    `showSimulated={true}`.
 *
 * The `mode` prop switches the Y axis & tooltip between cumulative
 * points and cumulative dollars. Dollar mode reads `originalDollars`
 * and `simulatedDollars` and falls back to the points field when the
 * caller doesn't supply dollar data.
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
  Legend,
} from "recharts";

export interface ZoneEquityPoint {
  label: string;
  originalCumulative: number;
  simulatedCumulative?: number;
  // Optional dollar-denominated cumulatives — populated by callers that
  // know the instrument's point value. When absent the chart falls back
  // to the points field even in dollar mode.
  originalDollars?: number;
  simulatedDollars?: number;
}

interface ZoneEquityCurveProps {
  data: ZoneEquityPoint[];
  showSimulated?: boolean;
  // When false, hides the original (green) line. Default true preserves
  // the previous behavior for every caller other than the backtesting
  // dashboard, which now opts out of the original overlay.
  showOriginal?: boolean;
  // Display unit for the Y axis and tooltip.
  mode?: "points" | "dollars";
}

export function ZoneEquityCurve({
  data,
  showSimulated = false,
  showOriginal = true,
  mode = "points",
}: ZoneEquityCurveProps) {
  if (data.length === 0) return null;

  const isDollars = mode === "dollars";
  const origKey = isDollars ? "originalDollars" : "originalCumulative";
  const simKey = isDollars ? "simulatedDollars" : "simulatedCumulative";

  const formatValue = (n: number) => {
    if (isDollars) {
      return `${n >= 0 ? "" : "-"}$${Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    return `${n > 0 ? "+" : ""}${n.toFixed(2)} pts`;
  };

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-4">
        Equity Curve ({isDollars ? "Cumulative $" : "Cumulative Points"})
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <defs>
            {/* Original — green gradient */}
            <linearGradient id="zoneOriginalGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
            {/* Simulated — blue gradient */}
            <linearGradient id="zoneSimGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
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
            tickFormatter={(v) =>
              isDollars
                ? `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                : `${v} pts`
            }
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111118",
              border: "1px solid #1e1e2a",
              borderRadius: "8px",
              color: "#e4e4e7",
            }}
            labelStyle={{ color: "#e4e4e7" }}
            formatter={(value, name) => [
              formatValue(Number(value)),
              name === origKey ? "Original" : "Simulated",
            ]}
          />
          {showSimulated && showOriginal && (
            <Legend
              wrapperStyle={{ fontSize: 11, color: "#71717a" }}
              formatter={(value) => (value === origKey ? "Original" : "Simulated")}
            />
          )}
          {/* Original equity line — green (only when explicitly enabled) */}
          {showOriginal && (
            <Area
              type="monotone"
              dataKey={origKey}
              stroke="#22c55e"
              strokeWidth={2}
              fill="url(#zoneOriginalGrad)"
              isAnimationActive={false}
            />
          )}
          {/* Simulated equity line — blue (only when simulator is active) */}
          {showSimulated && (
            <Area
              type="monotone"
              dataKey={simKey}
              stroke="#38bdf8"
              strokeWidth={2}
              fill="url(#zoneSimGrad)"
              isAnimationActive={false}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
