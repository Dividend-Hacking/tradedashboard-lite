/**
 * Trade Statistics Utilities
 *
 * Pure functions that operate on a Trade[] array to compute
 * summary statistics and chart-ready data structures.
 * No side effects — all functions return new objects/arrays.
 */

import { Trade } from "@/types/trade";
import { rawHour } from "@/lib/utils/format";

/** Check if a value is missing — either null/undefined or empty string */
function isMissing(v: unknown): boolean {
  return v == null || v === "";
}

// --- Types for computed data ---

/** Summary statistics derived from a set of trades */
export interface SummaryStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgRR: number;
  avgWinRR: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  avgWin: number;
  avgLoss: number;
}

/** Single data point for the equity curve chart — keyed by trade index (#1, #2, etc.) */
export interface EquityPoint {
  label: string;
  cumulativePnl: number;
}

/** Single data point for the per-trade P&L bar chart */
export interface TradePnlPoint {
  label: string;
  pnl: number;
}

/** Win/loss count for the pie/donut chart */
export interface WinLossSlice {
  name: string;
  value: number;
}

/** Single data point for the R-multiple distribution histogram */
export interface RMultipleHistogramPoint {
  bucket: string;    // e.g. "-1.0 to -0.5", "0.0 to 0.5"
  count: number;     // number of trades in this bin
  isPositive: boolean; // true if bin midpoint >= 0 (for green/red coloring)
}

/** Single data point for P&L-by-category charts (grouped bar charts) */
export interface PnlByCategoryPoint {
  category: string;   // x-axis label (e.g. "9 AM", "Long", "A")
  totalPnl: number;   // sum of pnl_dollars for all trades in this group
  avgPnl: number;     // average pnl_dollars per trade in this group
  tradeCount: number;  // number of trades — shown in tooltip
}

/**
 * Compute aggregate summary statistics from a filtered set of trades.
 * Handles edge cases like empty arrays and all-null P&L values.
 */
export function computeSummaryStats(trades: Trade[]): SummaryStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      totalPnl: 0,
      avgRR: 0,
      avgWinRR: 0,
      profitFactor: 0,
      bestTrade: 0,
      worstTrade: 0,
      avgWin: 0,
      avgLoss: 0,
    };
  }

  const totalTrades = trades.length;

  // Classify wins/losses by pnl_dollars sign (DB stores "closed"/"open", not "Win"/"Loss")
  const wins = trades.filter((t) => t.pnl_dollars != null && t.pnl_dollars > 0);
  const losses = trades.filter((t) => t.pnl_dollars != null && t.pnl_dollars < 0);
  const winRate = wins.length / totalTrades;

  // Sum up P&L dollars, treating nulls as 0
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl_dollars ?? 0), 0);

  // Average realized R:R across trades that have a value
  const rrValues = trades
    .map((t) => t.actual_rr)
    .filter((v): v is number => v != null);
  const avgRR = rrValues.length > 0
    ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length
    : 0;

  // Average R:R for winning trades only — shows quality of wins
  const winRRValues = wins
    .map((t) => t.actual_rr)
    .filter((v): v is number => v != null);
  const avgWinRR = winRRValues.length > 0
    ? winRRValues.reduce((a, b) => a + b, 0) / winRRValues.length
    : 0;

  // Profit factor = gross wins / gross losses (absolute value)
  const grossWins = wins.reduce((sum, t) => sum + (t.pnl_dollars ?? 0), 0);
  const grossLosses = Math.abs(
    losses.reduce((sum, t) => sum + (t.pnl_dollars ?? 0), 0)
  );
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  // Best and worst single-trade P&L
  const pnls = trades.map((t) => t.pnl_dollars ?? 0);
  const bestTrade = Math.max(...pnls);
  const worstTrade = Math.min(...pnls);

  // Average win and average loss dollar amounts
  const avgWin =
    wins.length > 0
      ? wins.reduce((sum, t) => sum + (t.pnl_dollars ?? 0), 0) / wins.length
      : 0;
  const avgLoss =
    losses.length > 0
      ? losses.reduce((sum, t) => sum + (t.pnl_dollars ?? 0), 0) / losses.length
      : 0;

  return {
    totalTrades,
    winRate,
    totalPnl,
    avgRR,
    avgWinRR,
    profitFactor,
    bestTrade,
    worstTrade,
    avgWin,
    avgLoss,
  };
}

/**
 * Build cumulative equity curve data sorted by entry_time (or real_entry_time).
 * Each point represents the running total P&L after that trade.
 *
 * @param timeMode - "trade" uses playback bar timestamps; "real" uses wall-clock timestamps,
 *                   falling back to entry_time if real_entry_time is null.
 */
export function buildEquityCurve(trades: Trade[], timeMode: "trade" | "real" = "trade"): EquityPoint[] {
  // Helper: resolve the timestamp to sort by based on timeMode
  const t_time = (t: Trade) => timeMode === "real" ? (t.real_entry_time ?? t.entry_time) : t.entry_time;

  // Sort trades chronologically by the selected time source
  const sorted = [...trades].sort(
    (a, b) => new Date(t_time(a)).getTime() - new Date(t_time(b)).getTime()
  );

  // Use trade index (#1, #2, …) as the x-axis label so each trade gets
  // its own hover target — date strings caused same-day trades to collapse.
  let cumulative = 0;
  return sorted.map((t, i) => {
    cumulative += t.pnl_dollars ?? 0;
    return {
      label: `#${i + 1}`,
      cumulativePnl: Math.round(cumulative * 100) / 100,
    };
  });
}

/**
 * Build per-trade P&L data sorted by entry_time (or real_entry_time).
 * Returns one bar per individual trade, labeled by trade index (#1, #2, etc.).
 *
 * @param timeMode - "trade" uses playback bar timestamps; "real" uses wall-clock timestamps,
 *                   falling back to entry_time if real_entry_time is null.
 */
export function buildTradePnl(trades: Trade[], timeMode: "trade" | "real" = "trade"): TradePnlPoint[] {
  // Helper: resolve the timestamp to sort by based on timeMode
  const t_time = (t: Trade) => timeMode === "real" ? (t.real_entry_time ?? t.entry_time) : t.entry_time;

  // Sort trades chronologically by the selected time source
  const sorted = [...trades].sort(
    (a, b) => new Date(t_time(a)).getTime() - new Date(t_time(b)).getTime()
  );

  // Return one data point per trade with its P&L value
  return sorted.map((t, i) => ({
    label: `#${i + 1}`,
    pnl: Math.round((t.pnl_dollars ?? 0) * 100) / 100,
  }));
}

/**
 * Build win/loss count data for a pie/donut chart.
 * Returns two slices: Wins and Losses.
 */
export function buildWinLossData(trades: Trade[]): WinLossSlice[] {
  // Classify wins/losses by pnl_dollars sign instead of trade_status text
  const wins = trades.filter((t) => t.pnl_dollars != null && t.pnl_dollars > 0).length;
  const losses = trades.filter((t) => t.pnl_dollars != null && t.pnl_dollars < 0).length;
  return [
    { name: "Wins", value: wins },
    { name: "Losses", value: losses },
  ];
}

/**
 * Build histogram data for R-multiple distribution.
 * Buckets trades by actual_rr into fixed-width bins, dynamically
 * determining the range from the min/max values. Bins with midpoint >= 0
 * are marked positive (green), < 0 negative (red).
 *
 * @param trades - Array of trades to histogram
 * @param binWidth - Width of each bucket in R units (default 0.5)
 * @param removeOutliers - When true, filters out values outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
 */
export function buildRMultipleHistogram(
  trades: Trade[],
  binWidth = 0.5,
  removeOutliers = false
): RMultipleHistogramPoint[] {
  // Filter to trades that have an actual_rr value
  const withRR = trades.filter((t) => t.actual_rr != null);
  if (withRR.length === 0) return [];

  let rrValues = withRR.map((t) => t.actual_rr!);

  // Optionally remove statistical outliers using the IQR method
  if (removeOutliers && rrValues.length >= 4) {
    const sorted = [...rrValues].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lower = q1 - 15.0 * iqr;
    const upper = q3 + 15.0 * iqr;
    rrValues = rrValues.filter((v) => v >= lower && v <= upper);
    if (rrValues.length === 0) return [];
  }

  // Round min down and max up to nearest bin edge for clean boundaries
  const minVal = Math.floor(Math.min(...rrValues) / binWidth) * binWidth;
  const maxVal = Math.ceil(Math.max(...rrValues) / binWidth) * binWidth;

  // Build empty bins across the full range
  const bins: RMultipleHistogramPoint[] = [];
  for (let edge = minVal; edge < maxVal; edge += binWidth) {
    const lo = Math.round(edge * 10) / 10;   // avoid floating point drift
    const hi = Math.round((edge + binWidth) * 10) / 10;
    const midpoint = (lo + hi) / 2;
    bins.push({
      bucket: `${lo.toFixed(1)} to ${hi.toFixed(1)}`,
      count: 0,
      isPositive: midpoint >= 0,
    });
  }

  // Edge case: all values are identical so minVal === maxVal and the loop above
  // produced zero bins. Create a single bin containing all trades.
  if (bins.length === 0) {
    const lo = Math.round(minVal * 10) / 10;
    const hi = Math.round((minVal + binWidth) * 10) / 10;
    bins.push({ bucket: `${lo.toFixed(1)} to ${hi.toFixed(1)}`, count: rrValues.length, isPositive: lo >= 0 });
    return bins;
  }

  // Assign each trade's actual_rr to the correct bin
  for (const rr of rrValues) {
    // Determine bin index: floor((rr - minVal) / binWidth), clamped to valid range
    let idx = Math.floor((rr - minVal) / binWidth);
    // Clamp both ends — floating point drift can push idx slightly out of range
    if (idx < 0) idx = 0;
    if (idx >= bins.length) idx = bins.length - 1;
    bins[idx].count++;
  }

  return bins;
}

// ---------------------------------------------------------------------------
// P&L-by-category builder functions
// Each groups trades by a different dimension and returns PnlByCategoryPoint[]
// ---------------------------------------------------------------------------

/**
 * Helper: convert a Map<string, Trade[]> into sorted PnlByCategoryPoint[].
 * Shared by all category builders to avoid duplicating the reduce logic.
 */
function groupToPnlPoints(
  groups: Map<string, Trade[]>,
  sortFn?: (a: PnlByCategoryPoint, b: PnlByCategoryPoint) => number
): PnlByCategoryPoint[] {
  const points: PnlByCategoryPoint[] = [];

  groups.forEach((trades, category) => {
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl_dollars ?? 0), 0);
    points.push({
      category,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgPnl: trades.length > 0 ? Math.round((totalPnl / trades.length) * 100) / 100 : 0,
      tradeCount: trades.length,
    });
  });

  // Apply custom sort or default alphabetical by category
  if (sortFn) {
    points.sort(sortFn);
  } else {
    points.sort((a, b) => a.category.localeCompare(b.category));
  }

  return points;
}

/**
 * P&L grouped by hour of entry (e.g. "9 AM", "10 AM").
 * Helps identify which times of day are most profitable.
 *
 * @param timeMode - "trade" uses playback bar timestamps; "real" uses wall-clock timestamps,
 *                   falling back to entry_time if real_entry_time is null.
 */
export function buildPnlByTimeOfDay(trades: Trade[], timeMode: "trade" | "real" = "trade"): PnlByCategoryPoint[] {
  const groups = new Map<string, Trade[]>();

  for (const t of trades) {
    // Resolve timestamp based on timeMode — real_entry_time falls back to entry_time if null
    const ts = timeMode === "real" ? (t.real_entry_time ?? t.entry_time) : t.entry_time;
    const hour = rawHour(ts);
    // Format hour as 12-hour label with AM/PM
    const label = hour === 0 ? "12 AM"
      : hour < 12 ? `${hour} AM`
      : hour === 12 ? "12 PM"
      : `${hour - 12} PM`;

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(t);
  }

  // Sort by actual hour value so "9 AM" comes before "10 AM"
  return groupToPnlPoints(groups, (a, b) => {
    const parseHour = (s: string) => {
      const [num, period] = s.split(" ");
      let h = parseInt(num);
      if (period === "AM" && h === 12) h = 0;
      if (period === "PM" && h !== 12) h += 12;
      return h;
    };
    return parseHour(a.category) - parseHour(b.category);
  });
}

/**
 * P&L grouped by trade direction ("Long" vs "Short").
 * Quick view of directional bias in profitability.
 */
export function buildPnlByDirection(trades: Trade[]): PnlByCategoryPoint[] {
  const groups = new Map<string, Trade[]>();

  for (const t of trades) {
    const dir = t.direction ?? "Unknown";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(t);
  }

  return groupToPnlPoints(groups);
}

/**
 * Helper: bucket numeric values into quartile ranges.
 * Returns a Map of range labels (e.g. "0.0–5.2") to the trades in each bucket.
 */
function bucketByQuartiles(
  trades: Trade[],
  accessor: (t: Trade) => number | null,
  includeNulls = false
): Map<string, Trade[]> {
  // Separate trades with null values for optional N/A grouping
  const withValue = trades.filter((t) => accessor(t) != null);
  const nullTrades = includeNulls ? trades.filter((t) => accessor(t) == null) : [];

  if (withValue.length === 0 && nullTrades.length === 0) return new Map();

  const groups = new Map<string, Trade[]>();

  // Only compute quartiles if there are non-null trades
  if (withValue.length > 0) {
    const sorted = [...withValue].sort((a, b) => accessor(a)! - accessor(b)!);
    const values = sorted.map((t) => accessor(t)!);

    // Compute quartile boundaries
    const p25 = values[Math.floor(values.length * 0.25)];
    const p50 = values[Math.floor(values.length * 0.5)];
    const p75 = values[Math.floor(values.length * 0.75)];
    const min = values[0];
    const max = values[values.length - 1];

    // Build labeled buckets
    const ranges: [string, number, number][] = [
      [`${min.toFixed(1)}–${p25.toFixed(1)}`, min, p25],
      [`${p25.toFixed(1)}–${p50.toFixed(1)}`, p25, p50],
      [`${p50.toFixed(1)}–${p75.toFixed(1)}`, p50, p75],
      [`${p75.toFixed(1)}–${max.toFixed(1)}`, p75, max],
    ];

    for (const [label] of ranges) {
      groups.set(label, []);
    }

    // Assign each trade to its quartile bucket
    for (const t of withValue) {
      const v = accessor(t)!;
      let idx = v < p25 ? 0 : v < p50 ? 1 : v < p75 ? 2 : 3;
      groups.get(ranges[idx][0])!.push(t);
    }
  }

  // Append N/A group at the end when includeNulls is enabled and there are null trades
  if (includeNulls && nullTrades.length > 0) {
    groups.set("N/A", nullTrades);
  }

  return groups;
}

/**
 * P&L grouped by ATR(14) quartile ranges.
 * Shows how volatility at entry affects trade outcomes.
 */
export function buildPnlByAtr(trades: Trade[], includeNulls = false): PnlByCategoryPoint[] {
  const groups = bucketByQuartiles(trades, (t) => t.ctx_atr14, includeNulls);
  if (groups.size === 0) return [];

  // Preserve the quartile order (already insertion-ordered from bucketByQuartiles)
  return groupToPnlPoints(groups, () => 0);
}

/**
 * P&L grouped by ADX(14) quartile ranges.
 * Shows how trend strength at entry affects trade outcomes.
 */
export function buildPnlByAdx(trades: Trade[], includeNulls = false): PnlByCategoryPoint[] {
  const groups = bucketByQuartiles(trades, (t) => t.ctx_adx14, includeNulls);
  if (groups.size === 0) return [];

  return groupToPnlPoints(groups, () => 0);
}

/**
 * P&L grouped by Bollinger Band position (e.g. "Upper", "Middle", "Lower").
 * Reveals which Bollinger zones produce better trades.
 */
export function buildPnlByBollingerPos(trades: Trade[], includeNulls = false): PnlByCategoryPoint[] {
  const groups = new Map<string, Trade[]>();
  const nullTrades: Trade[] = [];

  for (const t of trades) {
    if (isMissing(t.ctx_bollinger_pos)) {
      if (includeNulls) nullTrades.push(t);
      continue;
    }
    const key = t.ctx_bollinger_pos!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  // Append N/A group for trades with missing Bollinger data
  if (includeNulls && nullTrades.length > 0) {
    groups.set("N/A", nullTrades);
  }

  return groupToPnlPoints(groups);
}

/**
 * P&L grouped by price position vs an EMA period ("Above EMAx" / "Below EMAx").
 * Supports both EMA20 (short-term) and EMA200 (long-term) via the emaField parameter.
 * Shows if trading with or against the trend is more profitable.
 */
export function buildPnlByEma(
  trades: Trade[],
  includeNulls = false,
  emaField: "ema20" | "ema200" = "ema20"
): PnlByCategoryPoint[] {
  // Determine which database field to read and what label suffix to use
  const field = emaField === "ema20" ? "ctx_price_vs_ema20" : "ctx_price_vs_ema200";
  const suffix = emaField === "ema20" ? "EMA20" : "EMA200";

  const groups = new Map<string, Trade[]>();
  const nullTrades: Trade[] = [];

  for (const t of trades) {
    if (isMissing(t[field])) {
      if (includeNulls) nullTrades.push(t);
      continue;
    }
    // Compare lowercase to handle case variations from the database (e.g. "above" vs "Above")
    const raw = (t[field] as string).toLowerCase();
    const label = raw === "above" ? `Above ${suffix}` : `Below ${suffix}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(t);
  }

  // Append N/A group for trades with missing EMA data
  if (includeNulls && nullTrades.length > 0) {
    groups.set("N/A", nullTrades);
  }

  return groupToPnlPoints(groups);
}

/**
 * P&L grouped by trade regime (e.g. "Trending", "Ranging").
 * Helps identify which market regimes suit the strategy best.
 */
export function buildPnlByTradeRegime(trades: Trade[], includeNulls = false): PnlByCategoryPoint[] {
  const groups = new Map<string, Trade[]>();
  const nullTrades: Trade[] = [];

  for (const t of trades) {
    if (isMissing(t.trade_regime)) {
      if (includeNulls) nullTrades.push(t);
      continue;
    }
    const key = t.trade_regime!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  // Append N/A group for trades with missing regime data
  if (includeNulls && nullTrades.length > 0) {
    groups.set("N/A", nullTrades);
  }

  return groupToPnlPoints(groups);
}

/**
 * P&L grouped by auto-detected market regime (ctx_market_regime).
 * Uses the regime detected at trade entry, as opposed to the manually
 * tagged trade_regime. Useful for comparing manual vs algorithmic labels.
 */
export function buildPnlByMarketRegime(trades: Trade[], includeNulls = false): PnlByCategoryPoint[] {
  const groups = new Map<string, Trade[]>();
  const nullTrades: Trade[] = [];

  for (const t of trades) {
    if (isMissing(t.ctx_market_regime)) {
      if (includeNulls) nullTrades.push(t);
      continue;
    }
    const key = t.ctx_market_regime!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  // Append N/A group for trades with missing market regime data
  if (includeNulls && nullTrades.length > 0) {
    groups.set("N/A", nullTrades);
  }

  return groupToPnlPoints(groups);
}

/**
 * P&L grouped by trade grade (e.g. "A", "B", "C").
 * Shows the correlation between self-grading and actual P&L.
 */
export function buildPnlByTradeGrade(trades: Trade[], includeNulls = false): PnlByCategoryPoint[] {
  const groups = new Map<string, Trade[]>();
  const nullTrades: Trade[] = [];

  for (const t of trades) {
    if (isMissing(t.trade_grade)) {
      if (includeNulls) nullTrades.push(t);
      continue;
    }
    const key = t.trade_grade!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  // Append N/A group for trades with missing grade data
  if (includeNulls && nullTrades.length > 0) {
    groups.set("N/A", nullTrades);
  }

  // Sort alphabetically so grades appear in order (A, B, C, …)
  return groupToPnlPoints(groups);
}
