/**
 * Detailed Zone Export
 *
 * Builds a JSON-serializable structure describing each simulated trade with
 * enough surrounding bar context for an LLM (or another analyst) to reason
 * about the setup, the trade management, and the outcome. Output is pure
 * JSON — easy to drop into ChatGPT/Claude/etc. without any extra parsing.
 *
 * Per-trade payload:
 *   - Identity: zone id, instrument, direction, section
 *   - Entry / exit timestamps + prices + bar indices
 *   - Risk levels at entry: SL, TP, TSL distance, BE trigger
 *   - Stats: bars held, peak MFE, max drawdown, ATR at entry
 *   - Market context (ADX/ATR/EMA/Bollinger) from the trade_zones row
 *   - Bars array with three phases:
 *       phase = "pre_entry" → user-chosen N bars BEFORE the entry candle
 *       phase = "entry"     → bar_index 0 (the entry candle)
 *       phase = "in_trade"  → bar_index 1..exitBarIndex-1
 *       phase = "exit"      → bar_index === exitBarIndex
 *     Each in-trade/exit bar carries the active trailing-stop price and
 *     break-even status at that point in the walk so the AI can see exactly
 *     why a given bar was/wasn't an exit candidate.
 *
 * The whole-file payload also includes the active SimRules and an aggregate
 * summary so the AI has the parameter set the simulation was run under.
 */

import { TradeZone, TradeZoneBar, ZoneSection } from "@/types/trade-zone";
import {
  SimRules,
  SimZoneResult,
  SimSummary,
  TrailPathData,
  computeTrailPath,
} from "./zone-simulator";

// ─── Public payload shapes ───────────────────────────────────────────────────

export type BarPhase = "pre_entry" | "entry" | "in_trade" | "exit";

export interface ExportBar {
  bar_index: number;
  phase: BarPhase;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** The trailing-stop price as of this bar's close, or null when the trail
   *  isn't enabled or hasn't activated. Pre-entry bars are always null. */
  trail_stop_price: number | null;
  /** Whether break-even has been triggered as of this bar (i.e. price moved
   *  far enough in our favor to lock in the entry as a stop). Always false
   *  when BE is disabled or for pre-entry bars. */
  break_even_active: boolean;
}

export interface ExportTrade {
  zone_id: number;
  instrument: string;
  direction: string;
  section: string | null;
  entry: {
    time: string;
    price: number;
    bar_index: number;
  };
  exit: {
    time: string;
    price: number;
    bar_index: number;
    reason: string;
    /** Trade outcome in points, per contract. Negative = loss. */
    points: number;
  };
  levels: {
    /** Static SL price used by the simulator for this zone (factors in ATR
     *  adjust when ATR mode is on). null when SL is disabled. */
    stop_loss_price: number | null;
    /** Static TP price. null when TP is disabled. */
    take_profit_price: number | null;
    /** True when the trailing stop is enabled in the rule set. */
    trailing_stop_enabled: boolean;
    /** Trailing-stop distance in points (post-ATR-adjust if applicable). */
    trailing_stop_distance: number | null;
    /** True when break-even is enabled. */
    break_even_enabled: boolean;
    /** Profit threshold (in points) at which BE activates. */
    break_even_trigger: number | null;
  };
  stats: {
    bars_held: number;
    peak_mfe: number;
    max_drawdown: number;
    /** ATR(14) at entry, in points. Null when no replay match was available. */
    atr_at_entry: number | null;
    /** Position size assigned by the scaling modifier. 1 when scaling is off. */
    position_size: number;
    /** Outcome × position_size (matches the simulator's scaledPoints). */
    scaled_points: number;
    /** Original points_move on the underlying zone — what the user's drawn
     *  rectangle actually delivered before any rule was applied. Useful to
     *  compare "raw zone" vs "rule-applied" outcomes. */
    original_zone_points: number;
  };
  context: {
    adx14: number | null;
    atr14: number | null;
    price_vs_ema20: string | null;
    price_vs_ema200: string | null;
    bollinger_position: string | null;
    entry_hour: number | null;
    entry_day_of_week: number | null;
  };
  bars: ExportBar[];
}

export interface DetailedExport {
  exported_at: string;
  /** Number of pre-entry bars actually included per trade (capped at what
   *  was pre-fetched). Each trade may have fewer if the matching replay
   *  session didn't have enough history before the zone started. */
  pre_entry_bars_requested: number;
  rules: SimRules;
  summary: SimSummary;
  trades: ExportTrade[];
}

// ─── Implementation ─────────────────────────────────────────────────────────

interface BuildArgs {
  results: SimZoneResult[];
  zones: TradeZone[];
  /** Zone bars (zone + extension if enabled) keyed by zone id. */
  barsByZoneId: Map<number, TradeZoneBar[]>;
  /** Pre-entry context bars keyed by zone id. May be missing/empty per zone. */
  preEntryBarsByZoneId: Map<number, TradeZoneBar[]> | null;
  /** Per-zone ATR(14) at entry. Used by the simulator's effective-rule resolution
   *  so we replay the exact same SL/TP/Trail levels here. */
  atrByZoneId: Map<number, number> | null;
  rules: SimRules;
  summary: SimSummary;
  /** Sections lookup so we can attach section names to each trade. */
  sections: ZoneSection[];
  /** How many pre-entry bars to include per trade (clamped per-zone to whatever
   *  was actually fetched). */
  preEntryBarsCount: number;
}

/**
 * Builds a single per-trade ExportTrade record. Inlined so it can pull from
 * the per-zone trail path without re-allocating the full closure for each
 * trade — the trail path is computed once per trade here and consumed
 * immediately when annotating bars.
 */
function buildTrade(
  result: SimZoneResult,
  zone: TradeZone,
  zoneBars: TradeZoneBar[],
  preEntryBars: TradeZoneBar[],
  trailPath: TrailPathData,
  rules: SimRules,
  zoneAtr: number | null,
  sectionName: string | null,
  preEntryBarsCount: number
): ExportTrade {
  const isLong = zone.direction === "Long";

  // Sort defensively in case the caller hands us bars in a non-canonical order.
  const zoneSorted = [...zoneBars]
    .filter((b) => b.bar_index <= result.exitBarIndex)
    .sort((a, b) => a.bar_index - b.bar_index);

  // Slice the pre-entry tail to the requested count (most-recent N before entry).
  const preSorted = [...preEntryBars].sort((a, b) => a.bar_index - b.bar_index);
  const preTrimmed =
    preEntryBarsCount > 0
      ? preSorted.slice(-preEntryBarsCount)
      : [];

  // Mirror computeTrailPath's effective-rule math so the emitted trail/BE
  // distances match what the simulator actually used. SL/TP price levels come
  // straight from trailPath (which already includes ATR adjustments), so we
  // only need the trail/BE distances explicitly here.
  const atr = zoneAtr != null && zoneAtr > 0 ? zoneAtr : 0;
  const effTrail = Math.max(0, rules.trailingStopPoints + rules.trailAtrAdjust * atr);
  const effBe = Math.max(0, rules.breakEvenTrigger + rules.beAtrAdjust * atr);

  // Build the bars array. Pre-entry bars carry no risk-management state
  // (we hadn't entered the trade yet). Zone bars carry the per-bar trail
  // price and BE status from the trail path.
  const exportBars: ExportBar[] = [];

  for (const bar of preTrimmed) {
    exportBars.push({
      bar_index: bar.bar_index,
      phase: "pre_entry",
      time: bar.bar_time,
      open: bar.bar_open,
      high: bar.bar_high,
      low: bar.bar_low,
      close: bar.bar_close,
      volume: bar.bar_volume,
      trail_stop_price: null,
      break_even_active: false,
    });
  }

  for (let i = 0; i < zoneSorted.length; i++) {
    const bar = zoneSorted[i];
    const isEntry = bar.bar_index === 0;
    const isExit = bar.bar_index === result.exitBarIndex;
    const phase: BarPhase = isEntry ? "entry" : isExit ? "exit" : "in_trade";

    // trailPrices/bePrices are 1:1 aligned with the sorted zone bars from 0
    // to exit (computeTrailPath iterates the same range). i is therefore the
    // correct index into both arrays.
    const trailPrice = i < trailPath.trailPrices.length ? trailPath.trailPrices[i] : null;
    const bePrice = i < trailPath.bePrices.length ? trailPath.bePrices[i] : null;

    exportBars.push({
      bar_index: bar.bar_index,
      phase,
      time: bar.bar_time,
      open: bar.bar_open,
      high: bar.bar_high,
      low: bar.bar_low,
      close: bar.bar_close,
      volume: bar.bar_volume,
      trail_stop_price: trailPrice,
      // bePrice is non-null once BE has activated — we report it as a boolean
      // since the active level is always exactly entryPrice (no info is lost).
      break_even_active: bePrice != null,
    });
  }

  // Exit price: derive from entry + signed exitPoints so the JSON has an
  // explicit "I closed at this price" field rather than asking the AI to
  // recompute it. Direction sign is baked into exitPoints already.
  const exitPrice = isLong
    ? zone.start_price + result.exitPoints
    : zone.start_price - result.exitPoints;

  return {
    zone_id: zone.id,
    instrument: zone.instrument,
    direction: zone.direction,
    section: sectionName,
    entry: {
      time: result.startTime,
      price: zone.start_price,
      bar_index: 0,
    },
    exit: {
      time: result.exitTime,
      price: Math.round(exitPrice * 100) / 100,
      bar_index: result.exitBarIndex,
      reason: result.exitReason,
      points: result.exitPoints,
    },
    levels: {
      stop_loss_price: trailPath.slPrice,
      take_profit_price: trailPath.tpPrice,
      trailing_stop_enabled: rules.trailingStopEnabled,
      trailing_stop_distance: rules.trailingStopEnabled ? effTrail : null,
      break_even_enabled: rules.breakEvenEnabled,
      break_even_trigger: rules.breakEvenEnabled ? effBe : null,
    },
    stats: {
      bars_held: result.barsHeld,
      peak_mfe: result.peakMfe,
      max_drawdown: result.maxDrawdown,
      atr_at_entry: zoneAtr ?? null,
      position_size: result.positionSize,
      scaled_points: result.scaledPoints,
      original_zone_points: result.originalPoints,
    },
    context: {
      adx14: zone.ctx_adx14,
      atr14: zone.ctx_atr14,
      price_vs_ema20: zone.ctx_price_vs_ema20,
      price_vs_ema200: zone.ctx_price_vs_ema200,
      bollinger_position: zone.ctx_bollinger_pos,
      entry_hour: zone.entry_hour,
      entry_day_of_week: zone.entry_day_of_week,
    },
    bars: exportBars,
  };
}

/**
 * Builds the full DetailedExport payload — one entry per simulated trade.
 *
 * @returns A JSON-serializable object. Stringify with `JSON.stringify(..., null, 2)`
 *   for human-readable output; the LLM consumers we target work fine with either
 *   pretty or minified.
 */
export function buildDetailedExport({
  results,
  zones,
  barsByZoneId,
  preEntryBarsByZoneId,
  atrByZoneId,
  rules,
  summary,
  sections,
  preEntryBarsCount,
}: BuildArgs): DetailedExport {
  // Index zones + sections for O(1) lookup during the per-trade loop.
  const zonesById = new Map<number, TradeZone>();
  for (const z of zones) zonesById.set(z.id, z);

  const sectionNamesById = new Map<number, string>();
  for (const s of sections) sectionNamesById.set(s.id, s.name);

  const trades: ExportTrade[] = [];
  for (const r of results) {
    const zone = zonesById.get(r.zoneId);
    if (!zone) continue; // Defensive — should never happen since results come from these zones
    const zoneBars = barsByZoneId.get(r.zoneId) ?? [];
    if (zoneBars.length === 0) continue;

    const preEntryBars = preEntryBarsByZoneId?.get(r.zoneId) ?? [];
    const zoneAtr = atrByZoneId?.get(r.zoneId) ?? null;
    const sectionName =
      zone.section_id != null ? sectionNamesById.get(zone.section_id) ?? null : null;

    // Re-run computeTrailPath here so the export is self-contained — it'd be
    // tempting to thread the existing trailPath through from SimulatorTable,
    // but the table only computes it on-demand for expanded rows. Recomputing
    // is cheap (microseconds per trade) and keeps the export decoupled from
    // any UI state.
    const trailPath = computeTrailPath(zone, zoneBars, rules, r, zoneAtr);

    trades.push(
      buildTrade(
        r,
        zone,
        zoneBars,
        preEntryBars,
        trailPath,
        rules,
        zoneAtr,
        sectionName,
        preEntryBarsCount
      )
    );
  }

  return {
    exported_at: new Date().toISOString(),
    pre_entry_bars_requested: preEntryBarsCount,
    rules,
    summary,
    trades,
  };
}

/**
 * Triggers a JSON file download in the browser. Pulled out as its own helper
 * so the modal/handler doesn't have to know about Blob/anchor mechanics.
 *
 * @param payload - The export object to serialize.
 * @param filename - Base name for the download (`.json` is appended).
 */
export function downloadDetailedExport(
  payload: DetailedExport,
  filename: string
): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── NT8-comparable per-trade CSV ─────────────────────────────────────────────
//
// The CSV's column schema and order MUST match
// ninjatrader/strategies/PresetStrategy.cs's ExportTradesCsv() so the diff
// script (scripts/diff-backtests.mjs) can index by name and align the two
// systems' outputs row-by-row. Any change here needs a matching change there.
//
// We derive entry/exit prices from the simulator's perspective rather than
// from `ExportTrade.entry.price` (which carries `zone.start_price` — the
// trigger bar's close — and is wrong under fillMode="next_open" because the
// actual fill is bar 1's open). NT8 reports the actual fill price, so to
// diff fairly we need the same.

// Schema version 2: adds points_raw + slippage_total so the diff against NT8
// (which reports raw broker fills) is apples-to-apples. The legacy
// `points`/`exit_price` columns now also carry the RAW values; the prior
// emit was slippage-deducted and made every matched trade in the diff look
// divergent even when the underlying logic was identical. The NinjaScript
// PresetStrategy.ExportTradesCsv uses the same header, so both sides match
// column-for-column.
const NT8_CSV_HEADER =
  "entry_time_session,entry_time_utc,exit_time_session,exit_time_utc," +
  "direction,qty,entry_price,exit_price,exit_reason,points,dollars," +
  "points_raw,slippage_total,zone_id\n";

interface BuildCsvArgs {
  /** Final SimZoneResult[] AFTER applyScalingModifier + applyDailyLimits.
   *  scaledPoints reflects the per-trade size; netDollars reflects $ net. */
  results: SimZoneResult[];
  zones: TradeZone[];
  /** Same map the simulator was fed. Used to find bar 1's open under
   *  fillMode="next_open" so the emitted entry_price is the ACTUAL fill,
   *  not the trigger-bar close. */
  barsByZoneId: Map<number, TradeZoneBar[]>;
  rules: SimRules;
}

/**
 * Build a CSV string of per-trade rows in the NT8-comparable schema. Returns
 * the full CSV including header. Handles fillMode-aware entry pricing,
 * direction-aware exit pricing, and emits both session-local and UTC times
 * so the diff tool can detect timezone divergence without guessing.
 */
export function buildNt8ComparableTradesCsv(args: BuildCsvArgs): string {
  const { results, zones, barsByZoneId, rules } = args;

  const zonesById = new Map<number, TradeZone>();
  for (const z of zones) zonesById.set(z.id, z);

  // Mirror simulator's fill convention. Defaults to next_open so an old
  // preset without fillMode set behaves like the current default.
  const fillMode = rules.fillMode || "next_open";

  const lines: string[] = [NT8_CSV_HEADER];

  for (const r of results) {
    const zone = zonesById.get(r.zoneId);
    if (!zone) continue;
    const zoneBars = barsByZoneId.get(r.zoneId) ?? [];
    const sortedBars = [...zoneBars].sort((a, b) => a.bar_index - b.bar_index);
    const bar0 = sortedBars.find((b) => b.bar_index === 0);
    const bar1 = sortedBars.find((b) => b.bar_index === 1);
    const exitBar = sortedBars.find((b) => b.bar_index === r.exitBarIndex);

    // Entry fill price — bar 1 open under next_open, else the trigger bar
    // close (which is what zone.start_price already records). Falling back
    // to start_price guarantees a value when the data is incomplete.
    const entryPrice =
      fillMode === "next_open" && bar1 ? bar1.bar_open : zone.start_price;
    const isLong = zone.direction === "Long";

    // Exit fill price: NT8 reports the actual broker fill (no slippage
    // subtraction, since slippage is applied at fill time inside NT8's
    // engine). For parity, we add slippageApplied BACK to r.exitPoints
    // to recover the raw OHLC-derived exit, then translate to a price.
    // r.slippageApplied is the round-trip total (2 × slippagePoints),
    // assigned in result(); subtracting it from exitPoints gave the
    // simulator's net P&L, so adding it back gives the gross.
    const rawExitPoints = r.exitPoints + (r.slippageApplied || 0);
    const exitPrice = isLong
      ? entryPrice + rawExitPoints
      : entryPrice - rawExitPoints;

    // Times: session-local strips TZ literally (matches dashboard's
    // parseRawTimestamp behavior); UTC parses-and-converts. Emitting
    // both lets the diff tool catch timezone-driven divergence.
    const entryT = bar0?.bar_time ?? r.startTime;
    const exitT = exitBar?.bar_time ?? r.exitTime;
    const entrySess = stripTz(entryT);
    const exitSess = stripTz(exitT);
    const entryUtc = toUtcIso(entryT);
    const exitUtc = toUtcIso(exitT);

    // qty = position size assigned by applyScalingModifier (1 when scaling
    // is off). dollars = netDollars (which already factors qty + commission).
    const qty = r.positionSize;
    const dollars = r.netDollars;

    lines.push(
      [
        entrySess,
        entryUtc,
        exitSess,
        exitUtc,
        zone.direction,
        qty.toString(),
        entryPrice.toFixed(2),
        // exit_price now matches NT8 — raw broker-style fill, slippage NOT
        // pre-subtracted. The simulator's "did we still beat slippage" math
        // is preserved separately in points + slippage_total below.
        exitPrice.toFixed(2),
        escapeCsv(r.exitReason),
        // points = raw P&L per contract (= rawExitPoints), so it agrees
        // with NT8's points = exit_price - entry_price (direction-aware).
        // The diff script compares this column.
        rawExitPoints.toFixed(2),
        dollars.toFixed(2),
        // Two new columns for transparency / debugging — NT8 ignores them
        // (NT8's CSV doesn't emit these because slippage is applied at fill
        // time and not separately tracked in SystemPerformance). They're
        // here so the dashboard report shows the slippage cost the user
        // configured even when raw points are used in the diff.
        r.exitPoints.toFixed(2),
        (r.slippageApplied || 0).toFixed(2),
        // zone_id is a temporary diagnostic column so we can tell whether
        // duplicate-row pairs in the export share the same zoneId (single
        // SimZoneResult emitted twice → simulator double-push) or have
        // different zoneIds (two zones generated for the same logical
        // signal → upstream zone-emission bug). Drop after debugging.
        r.zoneId.toString(),
      ].join(",") + "\n"
    );
  }

  return lines.join("");
}

/**
 * Trigger a CSV file download in the browser.
 */
export function downloadNt8ComparableTradesCsv(
  csv: string,
  filename: string
): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Strip the timezone suffix from an ISO timestamp and return the literal
 * Y-M-D-T-H:M:S — matches what `parseRawTimestamp` reads from a bar_time
 * string. Critical for diffing against NT8's session-local `Time[0]`,
 * which carries no TZ either.
 */
function stripTz(iso: string): string {
  if (!iso) return "";
  // Date-only inputs ("YYYY-MM-DD") pass through unchanged.
  if (iso.length === 10 && iso.indexOf("T") < 0 && iso.indexOf(" ") < 0)
    return iso + "T00:00:00";
  return iso.replace(/([+-]\d{2}(:\d{2})?|Z)$/, "").replace(" ", "T");
}

/**
 * Best-effort UTC ISO conversion. When the input has a TZ suffix, the
 * Date constructor handles the offset properly and we get the true UTC
 * representation. When it doesn't, we treat the literal H:M as UTC
 * (same convention the dashboard uses internally for chart timestamps).
 */
function toUtcIso(iso: string): string {
  if (!iso) return "";
  // If the string has no TZ marker, treat it as UTC literal.
  const hasTz = /([+-]\d{2}(:\d{2})?|Z)$/.test(iso);
  const normalized = hasTz ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return iso; // unparseable — just echo back
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * RFC 4180 quoting: wrap in double quotes if the field has a comma, quote,
 * or newline; double any embedded quotes.
 */
function escapeCsv(s: string): string {
  if (!s) return "";
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
