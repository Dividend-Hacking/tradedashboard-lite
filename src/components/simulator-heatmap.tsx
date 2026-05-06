/**
 * SimulatorHeatmap — bivariate P&L heatmap.
 *
 * User picks two dimensions (X and Y) from dropdowns built off the
 * DIMENSIONS registry in sim-heatmap.ts. The component computes the joint
 * distribution of scaledPoints across the buckets of both dimensions and
 * renders a colored grid: green = positive cell, red = negative, intensity
 * scaled by absolute value relative to the worst/best cell in the matrix.
 *
 * Continuous dimensions get a per-axis bucket-count input. Categorical
 * dimensions ignore it (their buckets are fixed by the data). A shared
 * Total / Avg toggle picks which metric drives both the cell color scale
 * and the on-cell number, so users can flip "where do I make the most
 * money" against "where is my edge per trade strongest".
 */

"use client";

import { useMemo, useState } from "react";
import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimZoneResult } from "@/lib/utils/zone-simulator";
import {
  DIMENSIONS,
  DimensionId,
  build2DHistogram,
  buildHeatmapCtx,
  getDimension,
} from "@/lib/utils/sim-heatmap";

interface SimulatorHeatmapProps {
  results: SimZoneResult[];
  zones: TradeZone[];
  barsByZoneId?: Map<number, TradeZoneBar[]>;
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  atrByZoneId?: Map<number, number> | null;
  scalingEnabled?: boolean;
}

export function SimulatorHeatmap({
  results,
  zones,
  barsByZoneId,
  preEntryBarsByZoneId,
  atrByZoneId,
  scalingEnabled,
}: SimulatorHeatmapProps) {
  // Default axes: ADX × ATR — a common "trend strength × volatility" view.
  const [xDimId, setXDimId] = useState<DimensionId>("adx");
  const [yDimId, setYDimId] = useState<DimensionId>("atr");
  const [xBuckets, setXBuckets] = useState<number>(5);
  const [yBuckets, setYBuckets] = useState<number>(5);
  const [metric, setMetric] = useState<"total" | "avg">("avg");
  // Collapsed by default to keep the dashboard scannable. The user can open
  // it when they want to drill in. Header still shows the trade count so
  // there's always something to anchor on.
  const [collapsed, setCollapsed] = useState(false);

  // Available dimensions — filter out ones whose prerequisites aren't met
  // (e.g. position_size when scaling is off → its values would all collapse
  // to "×1" and the chart degenerates to a single column/row).
  const availableDims = useMemo(
    () =>
      DIMENSIONS.filter(
        (d) => !d.isAvailable || d.isAvailable({} as never, { scalingEnabled })
      ),
    [scalingEnabled]
  );

  // Pre-compute context (zone lookup, streak map, trade index) once per
  // results / zones change. Both axis extractors read from the same blob.
  const ctx = useMemo(
    () =>
      buildHeatmapCtx(results, zones, {
        barsByZoneId,
        preEntryBarsByZoneId,
        atrByZoneId,
      }),
    [results, zones, barsByZoneId, preEntryBarsByZoneId, atrByZoneId]
  );

  const xDim = getDimension(xDimId);
  const yDim = getDimension(yDimId);

  const data = useMemo(
    () => build2DHistogram(results, ctx, xDim, yDim, xBuckets, yBuckets),
    [results, ctx, xDim, yDim, xBuckets, yBuckets]
  );

  if (results.length === 0) return null;

  const maxAbs = metric === "total" ? data.maxAbsTotal : data.maxAbsAvg;

  // Color a cell by its value relative to the matrix-wide max-abs. Empty
  // cells render as a faint dashed background so the grid still reads
  // through gaps. Intensity floored at 0.05 so cells with non-zero counts
  // never look completely empty even when their magnitude is tiny.
  const cellBg = (v: number | null, count: number): string => {
    if (v === null || count === 0) return "rgba(255,255,255,0.02)";
    if (maxAbs === 0) return "rgba(255,255,255,0.05)";
    const ratio = Math.max(0.05, Math.min(1, Math.abs(v) / maxAbs));
    if (v >= 0) return `rgba(34, 197, 94, ${ratio.toFixed(3)})`; // accent-green
    return `rgba(239, 68, 68, ${ratio.toFixed(3)})`; // accent-red
  };

  // Continuous dims expose a per-axis bucket count input. Disabled for
  // categorical so users can't accidentally type a value that gets ignored.
  const bucketInput = (
    value: number,
    setValue: (n: number) => void,
    disabled: boolean
  ) => (
    <label className="flex items-center gap-1.5" title="Number of histogram bins on this axis">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Bins</span>
      <input
        type="number"
        min={2}
        max={20}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = Math.max(2, Math.min(20, parseInt(e.target.value) || 5));
          setValue(v);
        }}
        className={`w-12 bg-card border border-card-border rounded-md px-2 py-0.5 text-xs text-right transition-opacity ${
          disabled ? "text-muted-foreground/40 opacity-40" : "text-foreground"
        } focus:outline-none focus:ring-1 focus:ring-accent-green`}
      />
    </label>
  );

  const dimSelect = (
    value: DimensionId,
    setValue: (id: DimensionId) => void,
    label: string
  ) => (
    <label className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wider min-w-[12px]">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as DimensionId)}
        className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
      >
        {availableDims.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      {/* Collapsible header — clicking it toggles the body. */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className={`w-full flex items-center justify-between px-4 py-3 ${
          collapsed ? "" : "border-b border-card-border"
        } hover:bg-white/5 transition-colors`}
        aria-expanded={!collapsed}
      >
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          Bivariate Heatmap{" "}
          <span className="text-xs text-muted-foreground/70 normal-case tracking-normal">
            — {xDim.label} × {yDim.label} ({data.contributing} trades)
          </span>
        </h3>
        <svg
          className={`w-4 h-4 text-muted-foreground transition-transform ${
            collapsed ? "" : "rotate-90"
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="p-4 space-y-4">
          {/* Controls row — axis pickers + bucket counts + metric toggle */}
          <div className="flex items-center gap-4 flex-wrap">
            {dimSelect(xDimId, setXDimId, "X")}
            {bucketInput(xBuckets, setXBuckets, xDim.kind !== "continuous")}

            <div className="w-px h-6 bg-card-border/50" />

            {dimSelect(yDimId, setYDimId, "Y")}
            {bucketInput(yBuckets, setYBuckets, yDim.kind !== "continuous")}

            <div className="w-px h-6 bg-card-border/50" />

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Metric:</span>
              <button
                onClick={() => setMetric("total")}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  metric === "total"
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground"
                }`}
              >
                Total
              </button>
              <button
                onClick={() => setMetric("avg")}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  metric === "avg"
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground"
                }`}
              >
                Avg
              </button>
            </div>
          </div>

          {/* Heatmap body — degenerate empty/single-axis cases handled above
              the grid render so the table itself stays simple. */}
          {data.cells.length === 0 || data.xLabels.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              Not enough trades have values for both selected dimensions.
              {xDim.id === "rsi" || yDim.id === "rsi" ? (
                <div className="text-xs mt-2">
                  RSI requires at least 14 pre-entry bars per zone.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="border-separate border-spacing-0">
                <thead>
                  <tr>
                    {/* Empty corner cell so X labels sit above the data
                        columns, not above the Y axis label column. */}
                    <th className="sticky left-0 bg-card z-10" />
                    {data.xLabels.map((lbl, i) => (
                      <th
                        key={i}
                        className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                        style={{ minWidth: "70px" }}
                        title={lbl}
                      >
                        {lbl}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.cells.map((row, yi) => (
                    <tr key={yi}>
                      <td
                        className="sticky left-0 bg-card px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap text-right z-10"
                        title={data.yLabels[yi]}
                      >
                        {data.yLabels[yi]}
                      </td>
                      {row.map((cell, xi) => {
                        const val =
                          cell === null
                            ? null
                            : metric === "total"
                            ? cell.total
                            : cell.avg;
                        return (
                          <td
                            key={xi}
                            className="border border-card-border/30 text-center align-middle"
                            style={{
                              backgroundColor: cellBg(val, cell?.count ?? 0),
                              minWidth: "70px",
                              height: "44px",
                            }}
                            title={
                              cell
                                ? `${data.yLabels[yi]} × ${data.xLabels[xi]}\nTotal: ${cell.total} pts\nAvg: ${cell.avg} pts/trade\nTrades: ${cell.count}`
                                : `${data.yLabels[yi]} × ${data.xLabels[xi]}\nNo trades`
                            }
                          >
                            {cell ? (
                              <div className="flex flex-col items-center justify-center leading-tight">
                                <span
                                  className={`text-xs font-semibold ${
                                    val! >= 0 ? "text-foreground" : "text-foreground"
                                  }`}
                                >
                                  {val! > 0 ? "+" : ""}
                                  {val!.toFixed(1)}
                                </span>
                                <span className="text-[9px] text-muted-foreground/80">
                                  n={cell.count}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[10px] text-muted-foreground/30">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Color legend — small gradient strip showing how cell color
              maps to the chosen metric's range. Anchored at the matrix's
              max-abs value so the user knows what saturation means. */}
          {data.cells.length > 0 && data.xLabels.length > 0 && maxAbs > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>−{maxAbs.toFixed(1)}</span>
              <div
                className="flex-1 h-2 rounded"
                style={{
                  background:
                    "linear-gradient(to right, rgb(239,68,68), rgba(255,255,255,0.05), rgb(34,197,94))",
                  maxWidth: "240px",
                }}
              />
              <span>+{maxAbs.toFixed(1)}</span>
              <span className="ml-2 uppercase tracking-wider">
                {metric === "total" ? "Total Pts / Cell" : "Avg Pts / Trade"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
