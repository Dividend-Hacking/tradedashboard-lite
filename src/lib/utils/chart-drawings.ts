/**
 * chart-drawings.ts — Pure helpers for chart drawings.
 *
 * Intentionally framework-free: no React, no DOM, no lightweight-charts
 * side effects. All imperative chart work (creating price lines, adding
 * LineSeries, wiring click subscriptions) lives in use-chart-drawings.ts.
 *
 * Callers:
 *   - use-chart-drawings.ts — for state machine normalization + id generation
 *   - drawing-overlay.tsx   — for projecting drawings to pixel coordinates
 */
import type {
  IChartApi,
  ISeriesApi,
  Time,
} from "lightweight-charts";
import type {
  Drawing,
  DrawingPoint,
  RectDrawing,
  TrendDrawing,
} from "@/types/chart-drawings";

/** Generate a short unique id for a new drawing. Uses crypto.randomUUID
 *  when available (all modern browsers) and falls back to a Math.random
 *  string so unit tests / older environments don't blow up. */
export function makeDrawingId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `draw-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Normalize two user-clicked corners into a canonical rectangle where
 *  p1 has the earlier time and lower price, and p2 has the later time
 *  and higher price. This lets the overlay render the rectangle without
 *  worrying about the click order. */
export function normalizeRect(a: DrawingPoint, b: DrawingPoint): Pick<RectDrawing, "p1" | "p2"> {
  const aTime = Number(a.time);
  const bTime = Number(b.time);
  const minTime = Math.min(aTime, bTime) as Time;
  const maxTime = Math.max(aTime, bTime) as Time;
  const minPrice = Math.min(a.price, b.price);
  const maxPrice = Math.max(a.price, b.price);
  return {
    p1: { time: minTime, price: minPrice },
    p2: { time: maxTime, price: maxPrice },
  };
}

/** Normalize trend-line points into ascending time order so
 *  `LineSeries.setData([p1, p2])` doesn't throw. lightweight-charts
 *  requires strictly-ascending timestamps in setData. */
export function normalizeTrendPoints(a: DrawingPoint, b: DrawingPoint): Pick<TrendDrawing, "p1" | "p2"> {
  const aTime = Number(a.time);
  const bTime = Number(b.time);
  if (aTime <= bTime) return { p1: a, p2: b };
  return { p1: b, p2: a };
}

/** A projection function that converts a (time, price) point into pixel
 *  coordinates inside the chart container. Returns null when the point is
 *  outside the visible range. Created by the overlay on each render so the
 *  chart + series refs captured are current. */
export type Projection = (point: DrawingPoint) => { x: number; y: number } | null;

/** Build a projection function bound to the current chart + series refs.
 *  Kept separate from React so the overlay and hit-test helpers can reuse
 *  the same logic. */
export function makeProjection(
  chart: IChartApi | null,
  series: ISeriesApi<"Candlestick"> | null,
): Projection {
  if (!chart || !series) return () => null;
  const timeScale = chart.timeScale();
  return (point: DrawingPoint) => {
    const x = timeScale.timeToCoordinate(point.time);
    const y = series.priceToCoordinate(point.price);
    if (x === null || y === null) return null;
    return { x, y };
  };
}

/** Squared distance from a point to a line segment — avoids a sqrt per test.
 *  Used for trend-line hit detection (pixel space). */
function distanceToSegmentSq(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ddx = px - x1;
    const ddy = py - y1;
    return ddx * ddx + ddy * ddy;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return ddx * ddx + ddy * ddy;
}

/** Click hit-test in pixel space for the drawings rendered via the SVG
 *  overlay (vertical lines, rectangles) and trend lines. Returns the id of
 *  the topmost drawing hit, or null.
 *
 *  Horizontal lines are intentionally NOT handled here — they are native
 *  price lines and handled by proximity-to-price in the hook, matching the
 *  pattern used by the existing SL/TP drag handler (live-chart.tsx:283).
 */
export function hitTestOverlayDrawings(
  drawings: Drawing[],
  px: number, py: number,
  project: Projection,
  tolerance: number = 6,
): string | null {
  const tolSq = tolerance * tolerance;
  // Iterate newest → oldest so the top drawing wins on overlap.
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    if (d.kind === "vline") {
      const proj = project({ time: d.time, price: 0 });
      if (!proj) continue;
      const dx = px - proj.x;
      if (dx * dx <= tolSq) return d.id;
    } else if (d.kind === "rect") {
      const a = project(d.p1);
      const b = project(d.p2);
      if (!a || !b) continue;
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      // Inside the rectangle OR within tolerance of its border.
      if (px >= minX - tolerance && px <= maxX + tolerance &&
          py >= minY - tolerance && py <= maxY + tolerance) {
        return d.id;
      }
    } else if (d.kind === "trend") {
      const a = project(d.p1);
      const b = project(d.p2);
      if (!a || !b) continue;
      if (distanceToSegmentSq(px, py, a.x, a.y, b.x, b.y) <= tolSq) return d.id;
    }
  }
  return null;
}

/** Proximity-to-price hit test for horizontal lines. Mirrors the 5-point
 *  threshold used by the existing SL/TP drag handler in live-chart.tsx.
 *  Returns the id of the closest hline or alert within threshold, or null.
 *  Alerts are included because they render as price lines and the user
 *  must be able to click-select them to delete or re-arm. */
export function hitTestHorizontal(
  drawings: Drawing[],
  price: number,
  threshold: number = 5,
): string | null {
  let bestId: string | null = null;
  let bestDiff = threshold;
  for (const d of drawings) {
    if (d.kind !== "hline" && d.kind !== "alert") continue;
    const diff = Math.abs(price - d.price);
    if (diff <= bestDiff) {
      bestDiff = diff;
      bestId = d.id;
    }
  }
  return bestId;
}
