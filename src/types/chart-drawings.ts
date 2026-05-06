/**
 * chart-drawings.ts — Shared type definitions for user-drawn chart annotations
 * (horizontal lines, vertical lines, trend lines, rectangles).
 *
 * Used by both the live trader chart and the replay (practice) chart through
 * the shared useChartDrawings hook and DrawingToolbar / DrawingOverlay
 * components. Drawings are kept in React state only — they do not persist to
 * Supabase. Each chart instance owns its own drawing list.
 */
import type { Time } from "lightweight-charts";

/** The currently-selected drawing tool, or null when no tool is active.
 *  "alert" places a horizontal line that fires a banner + sound notification
 *  the first time price crosses it (see AlertDrawing). */
export type DrawingTool = null | "hline" | "vline" | "trend" | "rect" | "alert";

/** A single point on the chart — captured from a user click. */
export interface DrawingPoint {
  /** Bar time (unix seconds) where the click landed, as returned by
   *  lightweight-charts `MouseEventParams.time`. */
  time: Time;
  /** Price derived from the click's Y coordinate via
   *  `series.coordinateToPrice()`. */
  price: number;
}

/** Handle types for native lightweight-charts objects we hold references to
 *  so we can update/remove them without a full re-render.
 *  Typed as unknown because lightweight-charts does not export IPriceLine
 *  uniformly across versions and we only call .applyOptions / removeX on them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PriceLineHandle = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LineSeriesHandle = any;

/** A horizontal line at a fixed price. Rendered via
 *  `series.createPriceLine()` — no SVG overlay needed. */
export interface HLineDrawing {
  id: string;
  kind: "hline";
  price: number;
  color: string;
  priceLineHandle?: PriceLineHandle;
}

/** A vertical line anchored to a specific bar time. Rendered via the SVG
 *  overlay because lightweight-charts has no native vertical marker. */
export interface VLineDrawing {
  id: string;
  kind: "vline";
  time: Time;
  color: string;
}

/** A diagonal trend line between two (time, price) points. Rendered as a
 *  2-point LineSeries, matching the existing zone-line pattern in
 *  replay-chart.tsx. Points are kept in ascending time order. */
export interface TrendDrawing {
  id: string;
  kind: "trend";
  p1: DrawingPoint;
  p2: DrawingPoint;
  color: string;
  lineSeriesHandle?: LineSeriesHandle;
}

/** A rectangle defined by two opposite corners. Points are normalized so
 *  that p1 is the earlier/lower corner and p2 is the later/higher corner.
 *  Rendered via the SVG overlay. */
export interface RectDrawing {
  id: string;
  kind: "rect";
  p1: DrawingPoint;
  p2: DrawingPoint;
  color: string;
}

/** A horizontal price-alert line. Visually identical to HLineDrawing but
 *  carries an `armed` flag — while armed, the live-chart's RAF tick loop
 *  watches for price crossing `price` and fires a banner + sound on the
 *  first cross, then flips `armed` to false. User can re-arm via the
 *  drawing toolbar. Rendered as a dashed native price line with a title
 *  of "ALERT" (armed) or "FIRED" (disarmed) so it's distinct from plain
 *  hlines on the axis label. */
export interface AlertDrawing {
  id: string;
  kind: "alert";
  price: number;
  color: string;
  armed: boolean;
  /** Wall-clock ms of the most recent fire — used only for display /
   *  debugging; not referenced in the cross-check loop. */
  triggeredAt?: number;
  priceLineHandle?: PriceLineHandle;
}

/** Discriminated union of every drawing kind. Consumers should switch on
 *  `kind` to branch on behavior. */
export type Drawing = HLineDrawing | VLineDrawing | TrendDrawing | RectDrawing | AlertDrawing;

/** Default color palette offered by the per-drawing color picker. */
export const DRAWING_COLOR_PRESETS: string[] = [
  "#22d3ee", // cyan
  "#f59e0b", // amber
  "#ef4444", // red
  "#22c55e", // green
  "#a78bfa", // violet
  "#f472b6", // pink
  "#e5e7eb", // light gray
  "#737373", // mid gray
];

/** Default color applied to a freshly-created drawing before the user
 *  customizes it via the color picker. */
export const DRAWING_DEFAULT_COLOR = "#22d3ee";
