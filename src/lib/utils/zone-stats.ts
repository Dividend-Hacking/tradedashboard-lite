/**
 * Zone Stats Utilities
 *
 * Pure functions for computing summary statistics and chart data from trade zones.
 * Mirrors the pattern in trade-stats.ts — all functions are pure, take zones as input,
 * and return structured data for StatCards and Recharts components.
 */

import { TradeZone } from "@/types/trade-zone";
import { PnlByCategoryPoint } from "./trade-stats";
import { rawHour, rawDayOfWeek, formatDate } from "@/lib/utils/format";

// ─── Summary Stats ───────────────────────────────────────────────────────────

/** Summary statistics for a set of trade zones */
export interface ZoneSummaryStats {
  totalZones: number;
  longZones: number;
  shortZones: number;
  avgPointsMove: number;
  avgDurationSeconds: number;
  avgBarCount: number;
  bestZonePoints: number;
  worstZonePoints: number;
  totalDurationMinutes: number;
  winRate: number; // Fraction of zones with positive points_move
  avgAtr: number; // Average ATR(14) at entry across zones
  avgAdx: number; // Average ADX(14) at entry across zones
}

/**
 * Computes summary statistics from an array of trade zones.
 * Returns zeros for all fields if the input is empty.
 */
export function computeZoneSummaryStats(zones: TradeZone[]): ZoneSummaryStats {
  if (zones.length === 0) {
    return {
      totalZones: 0, longZones: 0, shortZones: 0, avgPointsMove: 0,
      avgDurationSeconds: 0, avgBarCount: 0, bestZonePoints: 0,
      worstZonePoints: 0, totalDurationMinutes: 0, winRate: 0, avgAtr: 0, avgAdx: 0,
    };
  }

  const longZones = zones.filter((z) => z.direction === "Long");
  const shortZones = zones.filter((z) => z.direction === "Short");

  const totalPoints = zones.reduce((sum, z) => sum + z.points_move, 0);
  const totalDuration = zones.reduce((sum, z) => sum + z.duration_seconds, 0);
  const totalBars = zones.reduce((sum, z) => sum + z.bar_count, 0);

  const pointsMoves = zones.map((z) => z.points_move);

  const winners = zones.filter((z) => z.points_move > 0).length;
  const atrVals = zones.map((z) => z.ctx_atr14).filter((v): v is number => v != null && v > 0);
  const adxVals = zones.map((z) => z.ctx_adx14).filter((v): v is number => v != null && v > 0);

  return {
    totalZones: zones.length,
    longZones: longZones.length,
    shortZones: shortZones.length,
    avgPointsMove: totalPoints / zones.length,
    avgDurationSeconds: totalDuration / zones.length,
    avgBarCount: totalBars / zones.length,
    bestZonePoints: Math.max(...pointsMoves),
    worstZonePoints: Math.min(...pointsMoves),
    totalDurationMinutes: totalDuration / 60,
    winRate: winners / zones.length,
    avgAtr: atrVals.length > 0 ? atrVals.reduce((a, b) => a + b, 0) / atrVals.length : 0,
    avgAdx: adxVals.length > 0 ? adxVals.reduce((a, b) => a + b, 0) / adxVals.length : 0,
  };
}

// ─── Equity Curve ────────────────────────────────────────────────────────────

import { ZoneEquityPoint } from "@/components/charts/zone-equity-curve";

/**
 * Builds cumulative points data for the equity curve.
 * Each point represents one zone in chronological order.
 */
export function buildZoneEquityCurve(zones: TradeZone[]): ZoneEquityPoint[] {
  let cumulative = 0;
  return zones.map((z) => {
    cumulative += z.points_move;
    return {
      label: formatDate(z.start_time),
      originalCumulative: Math.round(cumulative * 100) / 100,
    };
  });
}

// ─── Chart Data Builders ─────────────────────────────────────────────────────

/**
 * Builds per-zone bar chart data showing points_move for each zone.
 * Each bar is labeled with the zone's date + direction.
 */
export interface ZonePointsChartPoint {
  label: string;
  pointsMove: number;
  zoneId: number;
}

export function buildZonePointsChart(zones: TradeZone[]): ZonePointsChartPoint[] {
  return zones.map((z) => {
    const label = `${formatDate(z.start_time)} ${z.direction}`;
    return {
      label,
      pointsMove: z.points_move,
      zoneId: z.id,
    };
  });
}

/**
 * Groups zones by direction (Long vs Short) and computes avg points move.
 * Reuses PnlByCategoryPoint so we can plug directly into PnlByCategory chart.
 */
export function buildZonesByDirection(zones: TradeZone[]): PnlByCategoryPoint[] {
  const groups: Record<string, { total: number; count: number }> = {};

  for (const z of zones) {
    if (!groups[z.direction]) groups[z.direction] = { total: 0, count: 0 };
    groups[z.direction].total += z.points_move;
    groups[z.direction].count++;
  }

  return Object.entries(groups).map(([dir, data]) => ({
    category: dir,
    totalPnl: data.total,
    avgPnl: data.count > 0 ? data.total / data.count : 0,
    tradeCount: data.count,
  }));
}

/**
 * Groups zones by hour of start_time and computes avg points move.
 * Reuses PnlByCategoryPoint for PnlByCategory chart compatibility.
 */
export function buildZonesByTimeOfDay(zones: TradeZone[]): PnlByCategoryPoint[] {
  const groups: Record<string, { total: number; count: number }> = {};

  for (const z of zones) {
    const hour = rawHour(z.start_time);
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 || 12;
    const label = `${h12} ${ampm}`;

    if (!groups[label]) groups[label] = { total: 0, count: 0 };
    groups[label].total += z.points_move;
    groups[label].count++;
  }

  // Sort by hour (parse back from label)
  return Object.entries(groups)
    .sort(([a], [b]) => {
      const parseHour = (s: string) => {
        const [h, p] = s.split(" ");
        let hour = parseInt(h);
        if (p === "PM" && hour !== 12) hour += 12;
        if (p === "AM" && hour === 12) hour = 0;
        return hour;
      };
      return parseHour(a) - parseHour(b);
    })
    .map(([label, data]) => ({
      category: label,
      totalPnl: data.total,
      avgPnl: data.count > 0 ? data.total / data.count : 0,
      tradeCount: data.count,
    }));
}

/**
 * Groups zones by duration bucket and computes avg points move.
 * Buckets: 0-1m, 1-3m, 3-5m, 5-10m, 10m+
 */
export function buildZonesByDuration(zones: TradeZone[]): PnlByCategoryPoint[] {
  const buckets = [
    { label: "0-1m", min: 0, max: 60 },
    { label: "1-3m", min: 60, max: 180 },
    { label: "3-5m", min: 180, max: 300 },
    { label: "5-10m", min: 300, max: 600 },
    { label: "10m+", min: 600, max: Infinity },
  ];

  const groups: Record<string, { total: number; count: number }> = {};
  for (const b of buckets) groups[b.label] = { total: 0, count: 0 };

  for (const z of zones) {
    const bucket = buckets.find(
      (b) => z.duration_seconds >= b.min && z.duration_seconds < b.max
    );
    if (bucket) {
      groups[bucket.label].total += z.points_move;
      groups[bucket.label].count++;
    }
  }

  return buckets
    .filter((b) => groups[b.label].count > 0)
    .map((b) => ({
      category: b.label,
      totalPnl: groups[b.label].total,
      avgPnl:
        groups[b.label].count > 0
          ? groups[b.label].total / groups[b.label].count
          : 0,
      tradeCount: groups[b.label].count,
    }));
}

/**
 * Groups zones by ADX range (trend strength at entry).
 * Buckets: 0-15 (weak), 15-25 (developing), 25-40 (strong), 40+ (extreme)
 */
export function buildZonesByAdx(zones: TradeZone[]): PnlByCategoryPoint[] {
  const buckets = [
    { label: "0-15 Weak", min: 0, max: 15 },
    { label: "15-25 Developing", min: 15, max: 25 },
    { label: "25-40 Strong", min: 25, max: 40 },
    { label: "40+ Extreme", min: 40, max: Infinity },
  ];

  const groups: Record<string, { total: number; count: number }> = {};
  for (const b of buckets) groups[b.label] = { total: 0, count: 0 };

  for (const z of zones) {
    if (z.ctx_adx14 == null) continue;
    const bucket = buckets.find((b) => z.ctx_adx14! >= b.min && z.ctx_adx14! < b.max);
    if (bucket) {
      groups[bucket.label].total += z.points_move;
      groups[bucket.label].count++;
    }
  }

  return buckets
    .filter((b) => groups[b.label].count > 0)
    .map((b) => ({
      category: b.label,
      totalPnl: groups[b.label].total,
      avgPnl: groups[b.label].count > 0 ? groups[b.label].total / groups[b.label].count : 0,
      tradeCount: groups[b.label].count,
    }));
}

/**
 * Groups zones by ATR quartile (volatility at entry).
 */
export function buildZonesByAtr(zones: TradeZone[]): PnlByCategoryPoint[] {
  const withAtr = zones.filter((z) => z.ctx_atr14 != null && z.ctx_atr14 > 0);
  if (withAtr.length < 4) return [];

  const sorted = [...withAtr].sort((a, b) => a.ctx_atr14! - b.ctx_atr14!);
  const q1 = sorted[Math.floor(sorted.length * 0.25)].ctx_atr14!;
  const q2 = sorted[Math.floor(sorted.length * 0.5)].ctx_atr14!;
  const q3 = sorted[Math.floor(sorted.length * 0.75)].ctx_atr14!;

  const buckets = [
    { label: `Low (<${q1.toFixed(2)})`, min: 0, max: q1 },
    { label: `Med-Low`, min: q1, max: q2 },
    { label: `Med-High`, min: q2, max: q3 },
    { label: `High (>${q3.toFixed(2)})`, min: q3, max: Infinity },
  ];

  const groups: Record<string, { total: number; count: number }> = {};
  for (const b of buckets) groups[b.label] = { total: 0, count: 0 };

  for (const z of withAtr) {
    const bucket = buckets.find((b) => z.ctx_atr14! >= b.min && z.ctx_atr14! < b.max);
    if (bucket) {
      groups[bucket.label].total += z.points_move;
      groups[bucket.label].count++;
    }
  }

  return buckets
    .filter((b) => groups[b.label].count > 0)
    .map((b) => ({
      category: b.label,
      totalPnl: groups[b.label].total,
      avgPnl: groups[b.label].count > 0 ? groups[b.label].total / groups[b.label].count : 0,
      tradeCount: groups[b.label].count,
    }));
}

/**
 * Groups zones by EMA20 position (above/below short-term trend).
 */
export function buildZonesByEma20(zones: TradeZone[]): PnlByCategoryPoint[] {
  const groups: Record<string, { total: number; count: number }> = {};

  for (const z of zones) {
    const key = z.ctx_price_vs_ema20 || "N/A";
    if (key === "N/A" || key === "") continue;
    if (!groups[key]) groups[key] = { total: 0, count: 0 };
    groups[key].total += z.points_move;
    groups[key].count++;
  }

  return Object.entries(groups).map(([label, data]) => ({
    category: label.charAt(0).toUpperCase() + label.slice(1),
    totalPnl: data.total,
    avgPnl: data.count > 0 ? data.total / data.count : 0,
    tradeCount: data.count,
  }));
}

/**
 * Groups zones by Bollinger Band position at entry.
 */
export function buildZonesByBollinger(zones: TradeZone[]): PnlByCategoryPoint[] {
  const labelMap: Record<string, string> = {
    above_upper: "Above Upper",
    inside: "Inside Bands",
    below_lower: "Below Lower",
  };

  const groups: Record<string, { total: number; count: number }> = {};

  for (const z of zones) {
    const raw = z.ctx_bollinger_pos;
    if (!raw || raw === "") continue;
    const label = labelMap[raw] || raw;
    if (!groups[label]) groups[label] = { total: 0, count: 0 };
    groups[label].total += z.points_move;
    groups[label].count++;
  }

  return Object.entries(groups).map(([label, data]) => ({
    category: label,
    totalPnl: data.total,
    avgPnl: data.count > 0 ? data.total / data.count : 0,
    tradeCount: data.count,
  }));
}

/**
 * Groups zones by day of week.
 */
export function buildZonesByDayOfWeek(zones: TradeZone[]): PnlByCategoryPoint[] {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const groups: Record<number, { total: number; count: number }> = {};

  for (const z of zones) {
    const dow = z.entry_day_of_week ?? rawDayOfWeek(z.start_time);
    if (!groups[dow]) groups[dow] = { total: 0, count: 0 };
    groups[dow].total += z.points_move;
    groups[dow].count++;
  }

  // Sort Mon-Fri (skip weekends if empty)
  return [1, 2, 3, 4, 5, 0, 6]
    .filter((d) => groups[d] && groups[d].count > 0)
    .map((d) => ({
      category: dayNames[d],
      totalPnl: groups[d].total,
      avgPnl: groups[d].count > 0 ? groups[d].total / groups[d].count : 0,
      tradeCount: groups[d].count,
    }));
}

/**
 * Groups zones by instrument and computes total + avg points move.
 */
export function buildZonesByInstrument(zones: TradeZone[]): PnlByCategoryPoint[] {
  const groups: Record<string, { total: number; count: number }> = {};

  for (const z of zones) {
    const key = z.instrument || "Unknown";
    if (!groups[key]) groups[key] = { total: 0, count: 0 };
    groups[key].total += z.points_move;
    groups[key].count++;
  }

  return Object.entries(groups)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([instrument, data]) => ({
      category: instrument,
      totalPnl: data.total,
      avgPnl: data.count > 0 ? data.total / data.count : 0,
      tradeCount: data.count,
    }));
}
