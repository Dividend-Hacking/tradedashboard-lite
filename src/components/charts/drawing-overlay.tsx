"use client";

/**
 * DrawingOverlay — Absolutely-positioned SVG that renders the chart
 * drawings that lightweight-charts cannot render natively:
 *   - Vertical lines
 *   - Rectangles
 *   - Ghost preview (dashed) shown between the first and second click
 *     of a 2-click shape (trend line / rectangle)
 *
 * Horizontal price lines and trend lines are rendered via lightweight-charts
 * native APIs (price lines and LineSeries respectively) — handled inside
 * use-chart-drawings.ts. This overlay only augments those.
 *
 * The overlay is `pointer-events: none` so clicks fall through to the
 * chart canvas and fire the chart's `subscribeClick` handler. Selection
 * hit-testing happens inside the hook using pixel coordinates — no DOM
 * event handlers needed here.
 */
import type { Drawing, DrawingPoint, DrawingTool } from "@/types/chart-drawings";
import type { Projection } from "@/lib/utils/chart-drawings";

interface DrawingOverlayProps {
  drawings: Drawing[];
  selectedId: string | null;
  hoverPoint: DrawingPoint | null;
  pendingDraw: { tool: DrawingTool; points: DrawingPoint[] } | null;
  projection: Projection;
  /** Bumps whenever the chart viewport changes (pan/zoom/resize/crosshair)
   *  — the key prop on the SVG uses it to force a re-render with fresh
   *  coordinates. Kept as an explicit prop so consumers can re-use the
   *  value for their own memoization if needed. */
  projectionVersion: number;
  width: number;
  height: number;
}

/** Lighten a hex color for selection highlight. Accepts `#RRGGBB` or
 *  `#RGB` and returns an `rgba()` string with the given alpha. Falls
 *  back to the input if parsing fails. */
function withAlpha(color: string, alpha: number): string {
  const m = color.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function DrawingOverlay({
  drawings,
  selectedId,
  hoverPoint,
  pendingDraw,
  projection,
  projectionVersion,
  width,
  height,
}: DrawingOverlayProps) {
  if (width === 0 || height === 0) return null;

  return (
    <svg
      key={projectionVersion}
      className="absolute inset-0 z-30 pointer-events-none"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {drawings.map((d) => {
        const isSelected = d.id === selectedId;
        if (d.kind === "vline") {
          const p = projection({ time: d.time, price: 0 });
          if (!p) return null;
          return (
            <g key={d.id}>
              {isSelected && (
                <line
                  x1={p.x} y1={0} x2={p.x} y2={height}
                  stroke={withAlpha(d.color, 0.35)}
                  strokeWidth={6}
                />
              )}
              <line
                x1={p.x} y1={0} x2={p.x} y2={height}
                stroke={d.color}
                strokeWidth={isSelected ? 2 : 1}
              />
            </g>
          );
        }
        if (d.kind === "rect") {
          const a = projection(d.p1);
          const b = projection(d.p2);
          if (!a || !b) return null;
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          const w = Math.abs(b.x - a.x);
          const h = Math.abs(b.y - a.y);
          return (
            <rect
              key={d.id}
              x={x} y={y} width={w} height={h}
              fill={withAlpha(d.color, 0.15)}
              stroke={d.color}
              strokeWidth={isSelected ? 2 : 1}
            />
          );
        }
        // hline + trend are rendered natively by lightweight-charts.
        // The overlay only needs to show their selection highlight —
        // but since they're on the canvas layer we can't outline them
        // from SVG. Selection feedback for those is given via the
        // toolbar (color swatch + trash button enables).
        return null;
      })}

      {/* Ghost preview for in-progress 2-click tools */}
      {pendingDraw && pendingDraw.points.length === 1 && hoverPoint && (
        (() => {
          const a = projection(pendingDraw.points[0]);
          const b = projection(hoverPoint);
          if (!a || !b) return null;
          if (pendingDraw.tool === "trend") {
            return (
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="#22d3ee"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            );
          }
          if (pendingDraw.tool === "rect") {
            const x = Math.min(a.x, b.x);
            const y = Math.min(a.y, b.y);
            const w = Math.abs(b.x - a.x);
            const h = Math.abs(b.y - a.y);
            return (
              <rect
                x={x} y={y} width={w} height={h}
                fill="rgba(34, 211, 238, 0.1)"
                stroke="#22d3ee"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            );
          }
          return null;
        })()
      )}
    </svg>
  );
}
