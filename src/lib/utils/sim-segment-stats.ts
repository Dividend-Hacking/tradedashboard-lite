/**
 * Simulator Segment Stats
 *
 * Builders that group simulator results (SimZoneResult[]) by various market
 * context / trade characteristic dimensions and return PnlByCategoryPoint[]
 * shaped data so the existing PnlByCategory chart can render them as
 * histograms underneath the simulator's trade table.
 *
 * Mirrors the pattern in zone-stats.ts but keyed off SimZoneResult instead
 * of TradeZone — every builder uses `r.scaledPoints` so when scaling is on
 * the histograms reflect actual (size-aware) realized P&L, matching the
 * equity curve and stat cards. To get raw per-contract numbers, callers can
 * pass results that have positionSize == 1 (i.e. scaling disabled).
 *
 * "Dynamic" histograms: every numeric dimension takes a bucketCount param so
 * the UI can re-bin in real time. Equal-width bins are used for bounded /
 * symmetric metrics (RSI, ADX, time-of-day); quantile bins for skewed
 * cross-instrument metrics (ATR, volume) so a single instrument with very
 * different scale doesn't collapse all other zones into one bin.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimZoneResult } from "./zone-simulator";
import { PnlByCategoryPoint } from "./trade-stats";
import { parseRawTimestamp } from "./format";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Context blob each extractor receives so builders can pull from per-zone
 *  Maps without forcing every builder to take 4+ positional args. Anything
 *  the chart panel might be able to provide is optional — extractors return
 *  null when their inputs aren't loaded yet. */
export interface ExtractorCtx {
  zonesById: Map<number, TradeZone>;
  /** In-zone bars (zone start → zone end). Volume / bar analytics. */
  barsByZoneId?: Map<number, TradeZoneBar[]>;
  /** Per-zone ATR(14) at entry, computed from replay history. Falls back
   *  to zone.ctx_atr14 when absent. */
  atrByZoneId?: Map<number, number> | null;
  /** Bars BEFORE entry — used by the RSI extractor. Up to ~30 bars per zone. */
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  /** Chronological index of this result within the result list (0-based). */
  tradeIndex: number;
  /** Running streak counter BEFORE this trade is realized. Positive = N wins
   *  in a row; negative = N losses. Zero on the very first trade and after
   *  any flat (exitPoints == 0) trade. */
  streakBefore: number;
}

/** Builds a histogram bucketing numeric values into equal-width bins between
 *  the min and max present in the data. Returns one point per non-empty bin
 *  (empty bins are dropped so x-axis labels don't get noisy on sparse data). */
function bucketEqualWidth(
  rows: { value: number; pnl: number }[],
  bucketCount: number,
  formatLabel: (lo: number, hi: number) => string
): PnlByCategoryPoint[] {
  if (rows.length === 0 || bucketCount < 1) return [];
  const min = Math.min(...rows.map((r) => r.value));
  const max = Math.max(...rows.map((r) => r.value));
  if (!isFinite(min) || !isFinite(max)) return [];
  // Degenerate: all values identical → single bucket
  if (max === min) {
    const total = rows.reduce((s, r) => s + r.pnl, 0);
    return [
      {
        category: formatLabel(min, max),
        totalPnl: round2(total),
        avgPnl: round2(total / rows.length),
        tradeCount: rows.length,
      },
    ];
  }
  const width = (max - min) / bucketCount;
  // Index per row, last bucket includes the max edge
  const groups: { total: number; count: number; lo: number; hi: number }[] = [];
  for (let i = 0; i < bucketCount; i++) {
    groups.push({ total: 0, count: 0, lo: min + i * width, hi: min + (i + 1) * width });
  }
  for (const r of rows) {
    let idx = Math.floor((r.value - min) / width);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    groups[idx].total += r.pnl;
    groups[idx].count++;
  }
  return groups
    .filter((g) => g.count > 0)
    .map((g) => ({
      category: formatLabel(g.lo, g.hi),
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

/** Quantile-bin variant — better for skewed cross-instrument metrics where a
 *  single tail observation would cram everything else into one bucket under
 *  equal-width binning. Each bucket holds ~equal counts. */
function bucketQuantile(
  rows: { value: number; pnl: number }[],
  bucketCount: number,
  formatLabel: (lo: number, hi: number) => string
): PnlByCategoryPoint[] {
  if (rows.length === 0 || bucketCount < 1) return [];
  if (rows.length < bucketCount) bucketCount = rows.length; // can't have more bins than rows
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const groups: { total: number; count: number; lo: number; hi: number }[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = sorted[Math.floor((i * sorted.length) / bucketCount)].value;
    const hiIdx = Math.floor(((i + 1) * sorted.length) / bucketCount) - 1;
    const hi = sorted[Math.max(hiIdx, 0)].value;
    groups.push({ total: 0, count: 0, lo, hi });
  }
  // Walk sorted rows and fill groups in order so each bucket gets ~N/k rows.
  let idx = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (
      idx < bucketCount - 1 &&
      i >= Math.floor(((idx + 1) * sorted.length) / bucketCount)
    ) {
      idx++;
    }
    groups[idx].total += sorted[i].pnl;
    groups[idx].count++;
  }
  return groups
    .filter((g) => g.count > 0)
    .map((g) => ({
      category: formatLabel(g.lo, g.hi),
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

/** Categorical grouping — values are pre-bucketed strings. Optional sort key
 *  preserves logical order (e.g. "0 AM"..."11 PM") rather than Object.entries
 *  insertion order. */
function groupCategorical(
  rows: { key: string; pnl: number }[],
  sortKey?: (key: string) => number | string
): PnlByCategoryPoint[] {
  const groups = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const g = groups.get(r.key);
    if (g) {
      g.total += r.pnl;
      g.count++;
    } else {
      groups.set(r.key, { total: r.pnl, count: 1 });
    }
  }
  let entries = Array.from(groups.entries());
  if (sortKey) {
    entries.sort(([a], [b]) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (typeof ka === "number" && typeof kb === "number") return ka - kb;
      return String(ka).localeCompare(String(kb));
    });
  }
  return entries.map(([key, g]) => ({
    category: key,
    totalPnl: round2(g.total),
    avgPnl: round2(g.total / g.count),
    tradeCount: g.count,
  }));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Builds the streak-before lookup so each call to a builder can read the
 *  running streak prior to the trade in O(1). Re-computed once per render
 *  in the chart panel. */
export function computeContextMaps(
  results: SimZoneResult[],
  zones: TradeZone[]
): { zonesById: Map<number, TradeZone>; streakBefore: Map<number, number>; tradeIndex: Map<number, number> } {
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
    else streak = 0; // flat trade resets
  }
  return { zonesById, streakBefore, tradeIndex };
}

// ─── Numeric extractors → equal-width bin builders ───────────────────────────

/** ADX(14) at entry — fixed 0..~80 trend strength. Equal-width bins. */
export function buildByAdx(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> },
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows: { value: number; pnl: number }[] = [];
  for (const r of results) {
    const adx = ctx.zonesById.get(r.zoneId)?.ctx_adx14;
    if (adx == null) continue;
    rows.push({ value: adx, pnl: r.scaledPoints });
  }
  return bucketEqualWidth(rows, bucketCount, (lo, hi) => `${lo.toFixed(0)}–${hi.toFixed(0)}`);
}

/** ATR(14) at entry — prefers the simulator's per-zone atrByZoneId fetch
 *  (computed from raw replay bars) and falls back to the zone-table
 *  pre-computed ctx_atr14. Quantile-binned because ATR varies wildly across
 *  instruments. */
export function buildByAtr(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone>; atrByZoneId?: Map<number, number> | null },
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows: { value: number; pnl: number }[] = [];
  for (const r of results) {
    const live = ctx.atrByZoneId?.get(r.zoneId);
    const ctxAtr = ctx.zonesById.get(r.zoneId)?.ctx_atr14;
    const atr = live ?? ctxAtr ?? null;
    if (atr == null || atr <= 0) continue;
    rows.push({ value: atr, pnl: r.scaledPoints });
  }
  return bucketQuantile(rows, bucketCount, (lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)}`);
}

/** Bollinger bandwidth at entry — measures volatility regime. Equal-width
 *  bins; bandwidth is already a normalized ratio so quantile isn't necessary. */
export function buildByBollingerBw(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> },
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows: { value: number; pnl: number }[] = [];
  for (const r of results) {
    const bw = ctx.zonesById.get(r.zoneId)?.ctx_bollinger_bw;
    if (bw == null) continue;
    rows.push({ value: bw, pnl: r.scaledPoints });
  }
  return bucketEqualWidth(rows, bucketCount, (lo, hi) => `${lo.toFixed(3)}–${hi.toFixed(3)}`);
}

/** Distance from EMA20 in ATR units — proxy for trend extension at entry.
 *  Negative when below EMA20, positive when above. Equal-width bins span
 *  the negative→positive range so the "right-around-the-mean" zone shows
 *  as a single mid bucket. */
export function buildByDistEma20(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> },
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows: { value: number; pnl: number }[] = [];
  for (const r of results) {
    const dist = ctx.zonesById.get(r.zoneId)?.ctx_dist_ema20_atr;
    if (dist == null) continue;
    rows.push({ value: dist, pnl: r.scaledPoints });
  }
  return bucketEqualWidth(rows, bucketCount, (lo, hi) => `${lo.toFixed(2)}σ–${hi.toFixed(2)}σ`);
}

/** Volume at entry — uses the FIRST in-zone bar's volume as the entry-bar
 *  volume. Skipped silently if barsByZoneId isn't loaded. Quantile-binned
 *  because absolute volume scale differs across instruments. */
export function buildByVolume(
  results: SimZoneResult[],
  ctx: { barsByZoneId?: Map<number, TradeZoneBar[]> },
  bucketCount: number
): PnlByCategoryPoint[] {
  if (!ctx.barsByZoneId) return [];
  const rows: { value: number; pnl: number }[] = [];
  for (const r of results) {
    const bars = ctx.barsByZoneId.get(r.zoneId);
    if (!bars || bars.length === 0) continue;
    const vol = bars[0].bar_volume;
    if (vol == null || vol <= 0) continue;
    rows.push({ value: vol, pnl: r.scaledPoints });
  }
  return bucketQuantile(rows, bucketCount, (lo, hi) =>
    `${formatVolume(lo)}–${formatVolume(hi)}`
  );
}

/** Wilder RSI(14) at entry, computed from up to 30 pre-entry bars + the zone
 *  start_price as the "current" close. Skipped silently if the pre-entry
 *  fetch hasn't populated. Bins span the canonical 0–100 range with equal
 *  width so 30 / 50 / 70 lines stay roughly aligned across bucket counts. */
export function buildByRsi(
  results: SimZoneResult[],
  ctx: {
    zonesById: Map<number, TradeZone>;
    preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  },
  bucketCount: number
): PnlByCategoryPoint[] {
  if (!ctx.preEntryBarsByZoneId) return [];
  const rows: { value: number; pnl: number }[] = [];
  for (const r of results) {
    const zone = ctx.zonesById.get(r.zoneId);
    if (!zone) continue;
    const pre = ctx.preEntryBarsByZoneId.get(r.zoneId);
    if (!pre || pre.length < 14) continue;
    // Build a closing-price series: pre-entry bar closes (chronological) +
    // the zone's start_price as the most recent close at entry.
    const closes = pre
      .slice()
      .sort((a, b) => a.bar_index - b.bar_index)
      .map((b) => b.bar_close)
      .concat(zone.start_price);
    const rsi = wilderRsi(closes, 14);
    if (rsi == null) continue;
    rows.push({ value: rsi, pnl: r.scaledPoints });
  }
  // Force range to 0..100 instead of bucketEqualWidth's data-driven min/max.
  if (rows.length === 0 || bucketCount < 1) return [];
  const groups: { total: number; count: number; lo: number; hi: number }[] = [];
  const width = 100 / bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    groups.push({ total: 0, count: 0, lo: i * width, hi: (i + 1) * width });
  }
  for (const r of rows) {
    let idx = Math.floor(r.value / width);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    groups[idx].total += r.pnl;
    groups[idx].count++;
  }
  return groups
    .filter((g) => g.count > 0)
    .map((g) => ({
      category: `${g.lo.toFixed(0)}–${g.hi.toFixed(0)}`,
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

/** Time in trade — barsHeld converted to seconds (bars are 15s). Equal-width
 *  bins so users can see "how long does my edge last". */
export function buildByTimeInTrade(
  results: SimZoneResult[],
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows = results.map((r) => ({ value: r.barsHeld * 15, pnl: r.scaledPoints }));
  return bucketEqualWidth(rows, bucketCount, (lo, hi) => `${formatSeconds(lo)}–${formatSeconds(hi)}`);
}

/** Maximum Adverse Excursion — absolute value of maxDrawdown. */
export function buildByMae(
  results: SimZoneResult[],
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows = results.map((r) => ({ value: Math.abs(r.maxDrawdown), pnl: r.scaledPoints }));
  return bucketEqualWidth(rows, bucketCount, (lo, hi) => `${lo.toFixed(1)}–${hi.toFixed(1)} pts`);
}

/** Maximum Favorable Excursion — peak P&L reached before exit. */
export function buildByMfe(
  results: SimZoneResult[],
  bucketCount: number
): PnlByCategoryPoint[] {
  const rows = results.map((r) => ({ value: r.peakMfe, pnl: r.scaledPoints }));
  return bucketEqualWidth(rows, bucketCount, (lo, hi) => `${lo.toFixed(1)}–${hi.toFixed(1)} pts`);
}

/** Trade number in chronological sequence — bins map to "first quintile of
 *  trades vs last", useful for confirming session-fatigue or drift effects. */
export function buildByTradeNumber(
  results: SimZoneResult[],
  bucketCount: number
): PnlByCategoryPoint[] {
  if (results.length === 0) return [];
  const sorted = [...results].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  );
  const rows = sorted.map((r, i) => ({ value: i + 1, pnl: r.scaledPoints }));
  return bucketEqualWidth(rows, bucketCount, (lo, hi) =>
    `#${Math.round(lo)}–${Math.round(hi)}`
  );
}

// ─── Categorical / fixed-bucket builders ─────────────────────────────────────

/** Long vs Short. */
export function buildByDirection(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> }
): PnlByCategoryPoint[] {
  const rows = results.map((r) => ({
    key: ctx.zonesById.get(r.zoneId)?.direction ?? r.direction ?? "N/A",
    pnl: r.scaledPoints,
  }));
  return groupCategorical(rows);
}

/** Entry price above vs below EMA20. */
export function buildByEma20(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> }
): PnlByCategoryPoint[] {
  const rows: { key: string; pnl: number }[] = [];
  for (const r of results) {
    const v = ctx.zonesById.get(r.zoneId)?.ctx_price_vs_ema20;
    if (!v) continue;
    rows.push({ key: cap(v), pnl: r.scaledPoints });
  }
  return groupCategorical(rows);
}

/** Entry price above vs below EMA200 (longer-term trend regime). */
export function buildByEma200(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> }
): PnlByCategoryPoint[] {
  const rows: { key: string; pnl: number }[] = [];
  for (const r of results) {
    const v = ctx.zonesById.get(r.zoneId)?.ctx_price_vs_ema200;
    if (!v) continue;
    rows.push({ key: cap(v), pnl: r.scaledPoints });
  }
  return groupCategorical(rows);
}

/** Bollinger band position at entry. */
export function buildByBollinger(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> }
): PnlByCategoryPoint[] {
  const labels: Record<string, string> = {
    above_upper: "Above Upper",
    inside: "Inside Bands",
    below_lower: "Below Lower",
  };
  const rows: { key: string; pnl: number }[] = [];
  for (const r of results) {
    const v = ctx.zonesById.get(r.zoneId)?.ctx_bollinger_pos;
    if (!v) continue;
    rows.push({ key: labels[v] ?? v, pnl: r.scaledPoints });
  }
  // Stable order matching upper → inside → lower
  return groupCategorical(rows, (k) =>
    k === "Above Upper" ? 0 : k === "Inside Bands" ? 1 : k === "Below Lower" ? 2 : 3
  );
}

/** Trend correlation — does the trade direction align with the EMA200 regime?
 *   Long  + Above EMA200 → "With Trend"
 *   Short + Below EMA200 → "With Trend"
 *   Otherwise            → "Counter Trend"
 *  Zones missing EMA200 context are bucketed as "Unknown" and dropped if empty.
 */
export function buildByTrendCorrelation(
  results: SimZoneResult[],
  ctx: { zonesById: Map<number, TradeZone> }
): PnlByCategoryPoint[] {
  const rows: { key: string; pnl: number }[] = [];
  for (const r of results) {
    const z = ctx.zonesById.get(r.zoneId);
    const dir = (z?.direction ?? r.direction ?? "").toLowerCase();
    const trend = z?.ctx_price_vs_ema200;
    if (!trend) continue;
    const aligned =
      (dir === "long" && trend === "above") || (dir === "short" && trend === "below");
    rows.push({ key: aligned ? "With Trend" : "Counter Trend", pnl: r.scaledPoints });
  }
  return groupCategorical(rows, (k) => (k === "With Trend" ? 0 : 1));
}

/** Hour of day (0–23). Uses startTime so matches what the user clicks in the
 *  table. parseRawTimestamp is timezone-naive — same convention as the rest
 *  of the dashboard. */
export function buildByHourOfDay(results: SimZoneResult[]): PnlByCategoryPoint[] {
  const rows = results.map((r) => {
    const { hour } = parseRawTimestamp(r.startTime);
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 || 12;
    return { key: `${h12} ${ampm}`, pnl: r.scaledPoints, hourNum: hour };
  });
  // Group manually so we can sort by the underlying hour number.
  const groups = new Map<string, { total: number; count: number; hour: number }>();
  for (const r of rows) {
    const g = groups.get(r.key);
    if (g) {
      g.total += r.pnl;
      g.count++;
    } else {
      groups.set(r.key, { total: r.pnl, count: 1, hour: r.hourNum });
    }
  }
  return Array.from(groups.entries())
    .sort(([, a], [, b]) => a.hour - b.hour)
    .map(([key, g]) => ({
      category: key,
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

/** Day of week (Sun..Sat). */
export function buildByDayOfWeek(results: SimZoneResult[]): PnlByCategoryPoint[] {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows: { key: string; pnl: number; dow: number }[] = [];
  for (const r of results) {
    const { year, month, day } = parseRawTimestamp(r.startTime);
    if (!year && !month && !day) continue;
    const dow = new Date(year, month - 1, day).getDay();
    rows.push({ key: dayNames[dow], pnl: r.scaledPoints, dow });
  }
  const groups = new Map<string, { total: number; count: number; dow: number }>();
  for (const r of rows) {
    const g = groups.get(r.key);
    if (g) {
      g.total += r.pnl;
      g.count++;
    } else {
      groups.set(r.key, { total: r.pnl, count: 1, dow: r.dow });
    }
  }
  return Array.from(groups.entries())
    .sort(([, a], [, b]) => a.dow - b.dow)
    .map(([key, g]) => ({
      category: key,
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

/** Exit reason — why each trade closed. Useful for spotting a rule that
 *  fires too often (e.g. "timer" dominating means timed-exit is too tight). */
export function buildByExitReason(results: SimZoneResult[]): PnlByCategoryPoint[] {
  const rows = results.map((r) => ({ key: r.exitReason, pnl: r.scaledPoints }));
  return groupCategorical(rows, (k) => k);
}

/** Position size — only meaningful when scaling is on. Each integer size
 *  becomes its own bucket so users can see if their up-sized trades earn or
 *  bleed relative to baseline-sized ones. */
export function buildByPositionSize(results: SimZoneResult[]): PnlByCategoryPoint[] {
  const rows = results.map((r) => ({ key: `×${r.positionSize}`, pnl: r.scaledPoints, sz: r.positionSize }));
  const groups = new Map<string, { total: number; count: number; sz: number }>();
  for (const r of rows) {
    const g = groups.get(r.key);
    if (g) {
      g.total += r.pnl;
      g.count++;
    } else {
      groups.set(r.key, { total: r.pnl, count: 1, sz: r.sz });
    }
  }
  return Array.from(groups.entries())
    .sort(([, a], [, b]) => a.sz - b.sz)
    .map(([key, g]) => ({
      category: key,
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

/** Streak before the trade — how many consecutive wins/losses had occurred
 *  immediately before this trade was entered. Negative buckets = entered
 *  during a losing streak; positive = entered during a winning streak; 0 =
 *  entered after a flat trade or at the start of the result list. */
export function buildByStreakBefore(
  results: SimZoneResult[],
  streakBefore: Map<number, number>
): PnlByCategoryPoint[] {
  const rows: { key: string; pnl: number; bucket: number }[] = [];
  for (const r of results) {
    const s = streakBefore.get(r.zoneId) ?? 0;
    // Cap absolute streak at 5+ so the chart doesn't fan out endlessly on
    // long streaks. Anything ≥5 wins or ≤−5 losses lumps together.
    let bucket: number;
    let key: string;
    if (s >= 5) {
      bucket = 5;
      key = "5+ Wins";
    } else if (s <= -5) {
      bucket = -5;
      key = "5+ Losses";
    } else if (s > 0) {
      bucket = s;
      key = `${s}W`;
    } else if (s < 0) {
      bucket = s;
      key = `${Math.abs(s)}L`;
    } else {
      bucket = 0;
      key = "Flat / First";
    }
    rows.push({ key, pnl: r.scaledPoints, bucket });
  }
  const groups = new Map<string, { total: number; count: number; bucket: number }>();
  for (const r of rows) {
    const g = groups.get(r.key);
    if (g) {
      g.total += r.pnl;
      g.count++;
    } else {
      groups.set(r.key, { total: r.pnl, count: 1, bucket: r.bucket });
    }
  }
  return Array.from(groups.entries())
    .sort(([, a], [, b]) => a.bucket - b.bucket)
    .map(([key, g]) => ({
      category: key,
      totalPnl: round2(g.total),
      avgPnl: round2(g.total / g.count),
      tradeCount: g.count,
    }));
}

// ─── Local helpers ───────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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

/** Wilder RSI(14) — returns the most recent RSI given a closes series, or
 *  null if the series is too short. Standard convention: first avg gain /
 *  loss = simple mean over `period` deltas; subsequent values use Wilder
 *  smoothing ((prev * (period-1) + current) / period). */
function wilderRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  // Seed: simple average of the first `period` deltas
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss += -delta;
  }
  avgGain /= period;
  avgLoss /= period;
  // Smooth through the remaining bars
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
