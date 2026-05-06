/**
 * Simulator Heatmap — bivariate P&L analysis
 *
 * Dimensions registry + 2D bucketing utility. Each Dimension knows how to
 * pull its value out of a SimZoneResult (with optional zone / bar / atr /
 * pre-entry context) and how to bucket it. The heatmap component lets the
 * user pick any two dimensions for the X and Y axes, computes the joint
 * distribution of scaledPoints across the buckets of both, and renders a
 * matrix cell per (X bucket, Y bucket).
 *
 * Continuous dimensions support a per-axis bucket count and either equal-
 * width or quantile binning. Categorical dimensions are pre-bucketed and
 * use a stable sort key. RSI is special-cased with a forced 0–100 range so
 * its bands stay anchored regardless of bucket count.
 *
 * scaledPoints (not exitPoints) is always the value being summed so the
 * heatmap reflects the same realized P&L the equity curve and stat cards
 * show. With scaling off, scaledPoints === exitPoints, so behavior matches.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimZoneResult } from "./zone-simulator";
import { parseRawTimestamp } from "./format";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DimensionId =
  | "adx"
  | "atr"
  | "bollinger_bw"
  | "dist_ema20"
  | "volume"
  | "rsi"
  | "time_in_trade"
  | "mae"
  | "mfe"
  | "trade_number"
  | "direction"
  | "ema20"
  | "ema200"
  | "bollinger_pos"
  | "trend_corr"
  | "hour"
  | "day_of_week"
  | "exit_reason"
  | "position_size"
  | "streak_before";

export type DimensionKind = "continuous" | "categorical";

export interface HeatmapCtx {
  zonesById: Map<number, TradeZone>;
  barsByZoneId?: Map<number, TradeZoneBar[]>;
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  atrByZoneId?: Map<number, number> | null;
  /** Streak length BEFORE each trade (positive = wins, negative = losses). */
  streakBefore: Map<number, number>;
  /** Chronological index per trade (0-based). */
  tradeIndex: Map<number, number>;
}

export interface Dimension {
  id: DimensionId;
  label: string;
  kind: DimensionKind;
  /** Default bucket count for continuous dims (ignored for categorical). */
  defaultBuckets: number;
  /** equal-width respects min/max of observed data; quantile bins by rank
   *  count (better for skewed cross-instrument metrics like ATR / volume). */
  binMode?: "equal-width" | "quantile";
  /** When set, equal-width binning ignores observed min/max and uses this
   *  fixed range. RSI uses [0, 100] so bands don't drift across runs. */
  forcedRange?: [number, number];
  /** Returns a numeric value (continuous) or string key (categorical) per
   *  result. Returning null skips that result for this dimension. */
  extract: (r: SimZoneResult, ctx: HeatmapCtx) => number | string | null;
  /** Formats the [lo, hi] of a continuous bin into the axis tick label. */
  formatNumeric?: (lo: number, hi: number) => string;
  /** Stable order key for categorical bins. Default: alphabetical. */
  sortKey?: (key: string) => number | string;
  /** Hide this dimension when its prerequisite isn't met (e.g. position_size
   *  is only meaningful when the scaling modifier is on). */
  isAvailable?: (ctx: HeatmapCtx, opts: { scalingEnabled?: boolean }) => boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Wilder RSI(14) — most-recent value given a closes series, or null if too
 *  short. Same implementation as sim-segment-stats; duplicated here to keep
 *  this module self-contained (heatmap is the only consumer). */
function wilderRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss += -delta;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Dimension Registry ──────────────────────────────────────────────────────

export const DIMENSIONS: Dimension[] = [
  // ─── Continuous ────────────────────────────────────────────────────
  {
    id: "adx",
    label: "ADX(14) at Entry",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    extract: (r, ctx) => ctx.zonesById.get(r.zoneId)?.ctx_adx14 ?? null,
    formatNumeric: (lo, hi) => `${lo.toFixed(0)}–${hi.toFixed(0)}`,
  },
  {
    id: "atr",
    label: "ATR(14) at Entry",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "quantile",
    extract: (r, ctx) => {
      const live = ctx.atrByZoneId?.get(r.zoneId);
      const ctxAtr = ctx.zonesById.get(r.zoneId)?.ctx_atr14;
      const atr = live ?? ctxAtr ?? null;
      return atr != null && atr > 0 ? atr : null;
    },
    formatNumeric: (lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}`,
  },
  {
    id: "bollinger_bw",
    label: "Bollinger Bandwidth",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    extract: (r, ctx) => ctx.zonesById.get(r.zoneId)?.ctx_bollinger_bw ?? null,
    formatNumeric: (lo, hi) => `${lo.toFixed(3)}–${hi.toFixed(3)}`,
  },
  {
    id: "dist_ema20",
    label: "Distance from EMA20 (ATR)",
    kind: "continuous",
    defaultBuckets: 6,
    binMode: "equal-width",
    extract: (r, ctx) => ctx.zonesById.get(r.zoneId)?.ctx_dist_ema20_atr ?? null,
    formatNumeric: (lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}σ`,
  },
  {
    id: "volume",
    label: "Volume at Entry",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "quantile",
    extract: (r, ctx) => {
      const bars = ctx.barsByZoneId?.get(r.zoneId);
      if (!bars || bars.length === 0) return null;
      const v = bars[0].bar_volume;
      return v != null && v > 0 ? v : null;
    },
    formatNumeric: (lo, hi) => `${formatVolume(lo)}–${formatVolume(hi)}`,
  },
  {
    id: "rsi",
    label: "RSI(14) at Entry",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    forcedRange: [0, 100],
    extract: (r, ctx) => {
      const zone = ctx.zonesById.get(r.zoneId);
      const pre = ctx.preEntryBarsByZoneId?.get(r.zoneId);
      if (!zone || !pre || pre.length < 14) return null;
      const closes = pre
        .slice()
        .sort((a, b) => a.bar_index - b.bar_index)
        .map((b) => b.bar_close)
        .concat(zone.start_price);
      return wilderRsi(closes, 14);
    },
    formatNumeric: (lo, hi) => `${lo.toFixed(0)}–${hi.toFixed(0)}`,
  },
  {
    id: "time_in_trade",
    label: "Time in Trade",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    extract: (r) => r.barsHeld * 15,
    formatNumeric: (lo, hi) => `${formatSeconds(lo)}–${formatSeconds(hi)}`,
  },
  {
    id: "mae",
    label: "MAE (Adverse Excursion)",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    extract: (r) => Math.abs(r.maxDrawdown),
    formatNumeric: (lo, hi) => `${lo.toFixed(1)}–${hi.toFixed(1)} pts`,
  },
  {
    id: "mfe",
    label: "MFE (Favorable Excursion)",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    extract: (r) => r.peakMfe,
    formatNumeric: (lo, hi) => `${lo.toFixed(1)}–${hi.toFixed(1)} pts`,
  },
  {
    id: "trade_number",
    label: "Trade # in Sequence",
    kind: "continuous",
    defaultBuckets: 5,
    binMode: "equal-width",
    extract: (r, ctx) => (ctx.tradeIndex.get(r.zoneId) ?? 0) + 1,
    formatNumeric: (lo, hi) => `#${Math.round(lo)}–${Math.round(hi)}`,
  },

  // ─── Categorical ───────────────────────────────────────────────────
  {
    id: "direction",
    label: "Direction",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r, ctx) => ctx.zonesById.get(r.zoneId)?.direction ?? r.direction ?? null,
    sortKey: (k) => (k === "Long" ? 0 : k === "Short" ? 1 : 2),
  },
  {
    id: "ema20",
    label: "EMA20 Position",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r, ctx) => {
      const v = ctx.zonesById.get(r.zoneId)?.ctx_price_vs_ema20;
      return v ? cap(v) : null;
    },
    sortKey: (k) => (k === "Above" ? 0 : 1),
  },
  {
    id: "ema200",
    label: "EMA200 Position",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r, ctx) => {
      const v = ctx.zonesById.get(r.zoneId)?.ctx_price_vs_ema200;
      return v ? cap(v) : null;
    },
    sortKey: (k) => (k === "Above" ? 0 : 1),
  },
  {
    id: "bollinger_pos",
    label: "Bollinger Position",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r, ctx) => {
      const v = ctx.zonesById.get(r.zoneId)?.ctx_bollinger_pos;
      if (!v) return null;
      const labels: Record<string, string> = {
        above_upper: "Above Upper",
        inside: "Inside Bands",
        below_lower: "Below Lower",
      };
      return labels[v] ?? v;
    },
    sortKey: (k) =>
      k === "Above Upper" ? 0 : k === "Inside Bands" ? 1 : k === "Below Lower" ? 2 : 3,
  },
  {
    id: "trend_corr",
    label: "Trend Correlation",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r, ctx) => {
      const z = ctx.zonesById.get(r.zoneId);
      const dir = (z?.direction ?? r.direction ?? "").toLowerCase();
      const trend = z?.ctx_price_vs_ema200;
      if (!trend) return null;
      const aligned =
        (dir === "long" && trend === "above") || (dir === "short" && trend === "below");
      return aligned ? "With Trend" : "Counter Trend";
    },
    sortKey: (k) => (k === "With Trend" ? 0 : 1),
  },
  {
    id: "hour",
    label: "Hour of Day",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r) => {
      const { hour } = parseRawTimestamp(r.startTime);
      const ampm = hour >= 12 ? "PM" : "AM";
      const h12 = hour % 12 || 12;
      return `${h12} ${ampm}`;
    },
    sortKey: (k) => {
      const [h, p] = k.split(" ");
      let hour = parseInt(h);
      if (p === "PM" && hour !== 12) hour += 12;
      if (p === "AM" && hour === 12) hour = 0;
      return hour;
    },
  },
  {
    id: "day_of_week",
    label: "Day of Week",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r) => {
      const { year, month, day } = parseRawTimestamp(r.startTime);
      if (!year && !month && !day) return null;
      return DAY_NAMES[new Date(year, month - 1, day).getDay()];
    },
    sortKey: (k) => DAY_NAMES.indexOf(k),
  },
  {
    id: "exit_reason",
    label: "Exit Reason",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r) => r.exitReason,
    sortKey: (k) => k,
  },
  {
    id: "position_size",
    label: "Position Size",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r) => `×${r.positionSize}`,
    sortKey: (k) => parseFloat(k.slice(1)) || 0,
    isAvailable: (_ctx, opts) => !!opts.scalingEnabled,
  },
  {
    id: "streak_before",
    label: "Streak Before Trade",
    kind: "categorical",
    defaultBuckets: 0,
    extract: (r, ctx) => {
      const s = ctx.streakBefore.get(r.zoneId) ?? 0;
      if (s >= 5) return "5+ Wins";
      if (s <= -5) return "5+ Losses";
      if (s > 0) return `${s}W`;
      if (s < 0) return `${Math.abs(s)}L`;
      return "Flat / First";
    },
    sortKey: (k) => {
      // Negative bucket → losses, 0 → flat, positive → wins. Keep the order
      // 5+L, 4L, ..., 1L, Flat, 1W, ..., 4W, 5+W.
      if (k === "5+ Losses") return -5;
      if (k === "5+ Wins") return 5;
      if (k === "Flat / First") return 0;
      if (k.endsWith("W")) return parseInt(k);
      if (k.endsWith("L")) return -parseInt(k);
      return 99;
    },
  },
];

/** Resolve a dimension by id. Throws if unknown so calling code fails fast. */
export function getDimension(id: DimensionId): Dimension {
  const dim = DIMENSIONS.find((d) => d.id === id);
  if (!dim) throw new Error(`Unknown dimension: ${id}`);
  return dim;
}

// ─── 2D Histogram Builder ────────────────────────────────────────────────────

export interface HeatmapCell {
  total: number;
  avg: number;
  count: number;
}

export interface HeatmapData {
  xLabels: string[];
  yLabels: string[];
  /** cells[yIdx][xIdx] — null when no trades fell in that bucket pair. */
  cells: (HeatmapCell | null)[][];
  /** Maximum absolute total across cells — used by the renderer to scale
   *  color intensity. Computed for both metrics so the component can switch
   *  between them without recomputing. */
  maxAbsTotal: number;
  maxAbsAvg: number;
  /** Total trades that contributed (after dropping nulls from extractors). */
  contributing: number;
}

/** Bucket numeric values into N bins. Returns the per-row bucket index plus
 *  the human-readable label per bin. Empty bins are dropped from the label
 *  list AFTER rows are assigned, so cells that fall in dropped bins are
 *  rebucketed to the nearest surviving one — which we avoid by tracking
 *  which bins had ≥1 row and remapping the indices once at the end. */
function bucketContinuous(
  rows: { value: number; pnl: number; rowIdx: number }[],
  count: number,
  binMode: "equal-width" | "quantile",
  forcedRange: [number, number] | undefined,
  formatLabel: (lo: number, hi: number) => string
): { binIdx: number[]; labels: string[] } {
  if (rows.length === 0 || count < 1) return { binIdx: [], labels: [] };

  // Compute per-bin lo/hi
  type Bin = { lo: number; hi: number; idx: number };
  let bins: Bin[] = [];

  if (binMode === "quantile") {
    const sorted = [...rows].sort((a, b) => a.value - b.value);
    const k = Math.min(count, sorted.length);
    for (let i = 0; i < k; i++) {
      const lo = sorted[Math.floor((i * sorted.length) / k)].value;
      const hiIdx = Math.floor(((i + 1) * sorted.length) / k) - 1;
      const hi = sorted[Math.max(hiIdx, 0)].value;
      bins.push({ lo, hi, idx: i });
    }
  } else {
    const min = forcedRange?.[0] ?? Math.min(...rows.map((r) => r.value));
    const max = forcedRange?.[1] ?? Math.max(...rows.map((r) => r.value));
    if (!isFinite(min) || !isFinite(max) || max === min) {
      return { binIdx: rows.map(() => 0), labels: [formatLabel(min, max)] };
    }
    const width = (max - min) / count;
    for (let i = 0; i < count; i++) {
      bins.push({ lo: min + i * width, hi: min + (i + 1) * width, idx: i });
    }
  }

  // Assign each row to a bin index
  const binIdx: number[] = new Array(rows.length);
  if (binMode === "quantile") {
    // Walk sorted values in order; assign each to the next bin position
    const sortedIdxs = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.value - b.r.value);
    let cursor = 0;
    for (let i = 0; i < sortedIdxs.length; i++) {
      while (
        cursor < bins.length - 1 &&
        i >= Math.floor(((cursor + 1) * sortedIdxs.length) / bins.length)
      ) {
        cursor++;
      }
      binIdx[sortedIdxs[i].i] = cursor;
    }
  } else {
    const min = bins[0].lo;
    const max = bins[bins.length - 1].hi;
    const width = max === min ? 1 : (max - min) / bins.length;
    for (let i = 0; i < rows.length; i++) {
      let idx = Math.floor((rows[i].value - min) / width);
      if (idx < 0) idx = 0;
      if (idx >= bins.length) idx = bins.length - 1;
      binIdx[i] = idx;
    }
  }

  // Drop empty bins, remap indices
  const used = new Set(binIdx);
  const survivingBins = bins.filter((b) => used.has(b.idx));
  const remap = new Map<number, number>();
  survivingBins.forEach((b, newIdx) => remap.set(b.idx, newIdx));
  const finalIdx = binIdx.map((i) => remap.get(i)!);
  const labels = survivingBins.map((b) => formatLabel(b.lo, b.hi));
  return { binIdx: finalIdx, labels };
}

/** Bucket categorical keys, preserving the dimension's sort order. */
function bucketCategorical(
  rows: { key: string; pnl: number; rowIdx: number }[],
  sortKey?: (key: string) => number | string
): { binIdx: number[]; labels: string[] } {
  const uniq = Array.from(new Set(rows.map((r) => r.key)));
  if (sortKey) {
    uniq.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (typeof ka === "number" && typeof kb === "number") return ka - kb;
      return String(ka).localeCompare(String(kb));
    });
  }
  const idxByKey = new Map<string, number>();
  uniq.forEach((k, i) => idxByKey.set(k, i));
  const binIdx = rows.map((r) => idxByKey.get(r.key)!);
  return { binIdx, labels: uniq };
}

/** Builds the 2D matrix. Drops results whose extractor returned null for
 *  EITHER dimension so partial-coverage zones don't pollute one axis. */
export function build2DHistogram(
  results: SimZoneResult[],
  ctx: HeatmapCtx,
  xDim: Dimension,
  yDim: Dimension,
  xBuckets: number,
  yBuckets: number
): HeatmapData {
  // First pass: extract (x, y, pnl) for every result, dropping nulls.
  const rows: { x: number | string; y: number | string; pnl: number }[] = [];
  for (const r of results) {
    const xv = xDim.extract(r, ctx);
    const yv = yDim.extract(r, ctx);
    if (xv == null || yv == null) continue;
    rows.push({ x: xv, y: yv, pnl: r.scaledPoints });
  }
  if (rows.length === 0) {
    return { xLabels: [], yLabels: [], cells: [], maxAbsTotal: 0, maxAbsAvg: 0, contributing: 0 };
  }

  // Bucket each axis independently. The continuous path takes numeric values;
  // categorical takes strings. Both return { binIdx, labels }.
  const xBucket =
    xDim.kind === "continuous"
      ? bucketContinuous(
          rows.map((r, i) => ({ value: r.x as number, pnl: r.pnl, rowIdx: i })),
          xBuckets,
          xDim.binMode ?? "equal-width",
          xDim.forcedRange,
          xDim.formatNumeric ?? ((lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}`)
        )
      : bucketCategorical(
          rows.map((r, i) => ({ key: r.x as string, pnl: r.pnl, rowIdx: i })),
          xDim.sortKey
        );

  const yBucket =
    yDim.kind === "continuous"
      ? bucketContinuous(
          rows.map((r, i) => ({ value: r.y as number, pnl: r.pnl, rowIdx: i })),
          yBuckets,
          yDim.binMode ?? "equal-width",
          yDim.forcedRange,
          yDim.formatNumeric ?? ((lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}`)
        )
      : bucketCategorical(
          rows.map((r, i) => ({ key: r.y as string, pnl: r.pnl, rowIdx: i })),
          yDim.sortKey
        );

  // Allocate the 2D matrix and accumulate
  const xCount = xBucket.labels.length;
  const yCount = yBucket.labels.length;
  const cells: (HeatmapCell | null)[][] = [];
  const accum: { total: number; count: number }[][] = [];
  for (let y = 0; y < yCount; y++) {
    cells.push(new Array(xCount).fill(null));
    accum.push(
      Array.from({ length: xCount }, () => ({ total: 0, count: 0 }))
    );
  }
  for (let i = 0; i < rows.length; i++) {
    const xi = xBucket.binIdx[i];
    const yi = yBucket.binIdx[i];
    accum[yi][xi].total += rows[i].pnl;
    accum[yi][xi].count++;
  }

  let maxAbsTotal = 0;
  let maxAbsAvg = 0;
  for (let y = 0; y < yCount; y++) {
    for (let x = 0; x < xCount; x++) {
      const a = accum[y][x];
      if (a.count === 0) {
        cells[y][x] = null;
        continue;
      }
      const avg = a.total / a.count;
      cells[y][x] = {
        total: Math.round(a.total * 100) / 100,
        avg: Math.round(avg * 100) / 100,
        count: a.count,
      };
      if (Math.abs(a.total) > maxAbsTotal) maxAbsTotal = Math.abs(a.total);
      if (Math.abs(avg) > maxAbsAvg) maxAbsAvg = Math.abs(avg);
    }
  }

  return {
    xLabels: xBucket.labels,
    yLabels: yBucket.labels,
    cells,
    maxAbsTotal,
    maxAbsAvg,
    contributing: rows.length,
  };
}

/** Pre-compute the per-result context maps (zone lookup, streak-before,
 *  trade index). Done once per render, shared by both axis extractors. */
export function buildHeatmapCtx(
  results: SimZoneResult[],
  zones: TradeZone[],
  options: {
    barsByZoneId?: Map<number, TradeZoneBar[]>;
    preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
    atrByZoneId?: Map<number, number> | null;
  }
): HeatmapCtx {
  const zonesById = new Map<number, TradeZone>();
  for (const z of zones) zonesById.set(z.id, z);

  const sorted = [...results].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );
  const streakBefore = new Map<number, number>();
  const tradeIndex = new Map<number, number>();
  let streak = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    streakBefore.set(r.zoneId, streak);
    tradeIndex.set(r.zoneId, i);
    if (r.exitPoints > 0) streak = streak >= 0 ? streak + 1 : 1;
    else if (r.exitPoints < 0) streak = streak <= 0 ? streak - 1 : -1;
    else streak = 0;
  }
  return {
    zonesById,
    barsByZoneId: options.barsByZoneId,
    preEntryBarsByZoneId: options.preEntryBarsByZoneId,
    atrByZoneId: options.atrByZoneId,
    streakBefore,
    tradeIndex,
  };
}
