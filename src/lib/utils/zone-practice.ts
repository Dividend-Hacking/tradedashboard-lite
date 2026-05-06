/**
 * Zone Practice Engine — Pure TypeScript state machine for placing
 * trade zones during market replay.
 *
 * In zone mode, the user clicks Long/Short to place a zone starting
 * at the current bar. The zone extends N bars forward, collecting
 * OHLCV data for each bar. When complete, stats are computed.
 *
 * Zones can be saved to the existing trade_zones / trade_zone_bars
 * Supabase tables, making them appear in the Trade Zones dashboard.
 */

import { ReplayBar } from "@/types/replay";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single bar collected within a zone */
export interface ZoneBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  index: number; // 0-based within zone
}

/** A practice zone placed during replay */
export interface PracticeZone {
  id: string;
  direction: "Long" | "Short";
  entryPrice: number;       // bar close at placement
  entryBarIndex: number;    // bar_index in the replay session
  entryTime: string;
  targetBars: number;       // how many bars the zone spans
  status: "active" | "completed";
  /** Bars collected so far (grows as replay advances) */
  bars: ZoneBar[];
  /** Visual-only SL/TP levels set at placement. The zone does NOT close when
   *  price touches these — they exist so the user can eyeball how price plays
   *  out relative to their planned risk levels. Persisted to
   *  trade_zones.sl_price / trade_zones.tp_price. */
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
  /** Which level was touched *first* within the zone window. Once set, never
   *  overwritten — a "TP hit then SL hit" sequence locks in "tp". Persisted to
   *  trade_zones.hit_outcome. Undefined until the first hit detection runs;
   *  null explicitly means "neither level was hit". */
  hitOutcome?: "sl" | "tp" | null;
  /** Set on completion */
  endPrice?: number;
  endTime?: string;
  pointsMove?: number;
  durationSeconds?: number;
}

/** Full zone practice state */
export interface ZonePracticeState {
  zones: PracticeZone[];
  /** All zones currently collecting bars. Multiple zones can be active at once
   *  — the user can stack a new Long/Short zone on top of existing ones and
   *  each one independently plays out its own targetBars window. */
  activeZones: PracticeZone[];
}

// ─── State Factory ──────────────────────────────────────────────────────────

export function createZonePracticeState(): ZonePracticeState {
  return {
    zones: [],
    activeZones: [],
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Check whether a single bar would trigger SL, TP, both, or neither for a
 * given zone. Returns the hit type that happened first. When both SL and TP
 * would hit on the same bar, uses an OHLC path heuristic: if the bar closed
 * above its open, price is assumed to have moved open→low→high→close (so the
 * low was touched before the high); otherwise open→high→low→close.
 *
 * Long zone: SL is below entry, TP is above entry → bullish bar reaches low
 * first, so SL hits before TP. Bearish bar reaches high first, so TP first.
 *
 * Short zone: SL is above entry, TP is below entry → bullish bar reaches low
 * first (TP), bearish bar reaches high first (SL).
 *
 * Returns null when the bar triggers neither level.
 */
function detectHitOnBar(
  zone: PracticeZone,
  bar: ZoneBar
): "sl" | "tp" | null {
  const sl = zone.stopLossPrice ?? null;
  const tp = zone.takeProfitPrice ?? null;
  if (sl == null && tp == null) return null;

  const isLong = zone.direction === "Long";
  const slHit = sl != null && (isLong ? bar.low <= sl : bar.high >= sl);
  const tpHit = tp != null && (isLong ? bar.high >= tp : bar.low <= tp);

  if (!slHit && !tpHit) return null;
  if (slHit && !tpHit) return "sl";
  if (tpHit && !slHit) return "tp";

  // Both would hit this bar — use the OHLC path heuristic.
  const bullishBar = bar.close >= bar.open;
  if (isLong) return bullishBar ? "sl" : "tp";
  return bullishBar ? "tp" : "sl";
}

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Place a new zone at the current bar. The entry price is the bar's close.
 * The zone will collect the next targetBars bars (including the entry bar).
 * slPrice / tpPrice are optional absolute price levels for visual overlay only —
 * they do not cause the zone to close early when touched.
 */
export function placeZone(
  state: ZonePracticeState,
  direction: "Long" | "Short",
  currentBar: ReplayBar,
  targetBars: number,
  slPrice: number | null = null,
  tpPrice: number | null = null
): ZonePracticeState {
  const zone: PracticeZone = {
    id: generateId(),
    direction,
    entryPrice: currentBar.bar_close,
    entryBarIndex: currentBar.bar_index,
    entryTime: currentBar.bar_time,
    targetBars,
    status: "active",
    stopLossPrice: slPrice,
    takeProfitPrice: tpPrice,
    // Include the entry bar as bar 0
    bars: [{
      time: currentBar.bar_time,
      open: currentBar.bar_open,
      high: currentBar.bar_high,
      low: currentBar.bar_low,
      close: currentBar.bar_close,
      volume: currentBar.bar_volume,
      index: 0,
    }],
  };

  return {
    zones: [...state.zones, zone],
    activeZones: [...state.activeZones, zone],
  };
}

/**
 * Process a newly revealed bar. Every active zone advances independently —
 * each appends the bar to its own buffer and transitions to "completed" once
 * it has collected targetBars bars. Zones that complete on this bar are
 * removed from activeZones but remain in `zones` for history/auto-save.
 */
export function processZoneBar(
  state: ZonePracticeState,
  bar: ReplayBar
): ZonePracticeState {
  if (state.activeZones.length === 0) return state;

  const zonesById = new Map(state.zones.map((z) => [z.id, z] as const));
  const nextActive: PracticeZone[] = [];

  for (const zone of state.activeZones) {
    // Skip bars at/before the entry bar (the entry bar is seeded at placement)
    if (bar.bar_index <= zone.entryBarIndex) {
      nextActive.push(zone);
      continue;
    }

    // Defensive: zone shouldn't still be "active" if already full, but if it
    // is, just drop it from the active list without mutating.
    if (zone.bars.length >= zone.targetBars) continue;

    const newBar: ZoneBar = {
      time: bar.bar_time,
      open: bar.bar_open,
      high: bar.bar_high,
      low: bar.bar_low,
      close: bar.bar_close,
      volume: bar.bar_volume,
      index: zone.bars.length,
    };

    const updatedBars = [...zone.bars, newBar];
    const isComplete = updatedBars.length >= zone.targetBars;

    const lastBar = updatedBars[updatedBars.length - 1];
    const endPrice = lastBar.close;
    const pointsMove =
      zone.direction === "Long"
        ? endPrice - zone.entryPrice
        : zone.entryPrice - endPrice;
    const pointsRounded = Math.round(pointsMove * 100) / 100;

    const durationSeconds = Math.round(
      (new Date(lastBar.time).getTime() - new Date(zone.entryTime).getTime()) /
        1000
    );

    // Hit outcome is sticky — once SL or TP is touched, it locks in. We only
    // check the newly-added bar (not previously-seen bars) and only if the
    // zone hasn't already locked in a hit. Completed zones that never hit
    // either level settle to hitOutcome = null (explicit "neither").
    let nextHitOutcome: "sl" | "tp" | null | undefined = zone.hitOutcome;
    if (nextHitOutcome == null) {
      const hit = detectHitOnBar(zone, newBar);
      if (hit) nextHitOutcome = hit;
    }
    if (isComplete && nextHitOutcome === undefined) {
      nextHitOutcome = null;
    }

    const updatedZone: PracticeZone = {
      ...zone,
      bars: updatedBars,
      status: isComplete ? "completed" : "active",
      hitOutcome: nextHitOutcome,
      endPrice: isComplete ? endPrice : undefined,
      endTime: isComplete ? lastBar.time : undefined,
      pointsMove: isComplete ? pointsRounded : undefined,
      durationSeconds: isComplete ? durationSeconds : undefined,
    };

    zonesById.set(zone.id, updatedZone);
    if (!isComplete) nextActive.push(updatedZone);
  }

  return {
    // Preserve original zone order — rebuild from the state.zones order, not
    // the map's iteration order, so UI lists don't reshuffle when one zone
    // among several completes mid-bar.
    zones: state.zones.map((z) => zonesById.get(z.id) ?? z),
    activeZones: nextActive,
  };
}

/**
 * Whether a zone should be treated as "completed" for visual grouping — i.e.
 * for the Completed Zones toggle on the replay chart. A zone is visually
 * completed the moment its engine status flips to "completed" OR as soon as
 * price touches SL/TP (hitOutcome set), even if the bar window hasn't
 * finished yet. The zone keeps collecting bars until targetBars, but from
 * the trader's perspective the trade is already decided.
 */
export function isZoneVisuallyCompleted(zone: PracticeZone): boolean {
  return zone.status === "completed" || zone.hitOutcome != null;
}

/**
 * Compute the realized/effective points for a zone based on SL/TP hit outcome.
 *
 * Priority:
 *   1. hitOutcome === "tp" and takeProfitPrice set → distance from entry → TP
 *      (always positive — TP is in the favorable direction).
 *   2. hitOutcome === "sl" and stopLossPrice set → distance from entry → SL
 *      (always negative — SL is in the adverse direction).
 *   3. Fallback to pointsMove (end-of-window close vs entry) — used when no
 *      level was configured or neither was touched.
 *
 * Active zones may still return 0 here if they haven't hit a level and
 * pointsMove isn't yet set. Callers that want live unrealized PnL should
 * use getActiveZonePnl instead.
 */
export function getZoneEffectivePoints(zone: PracticeZone): number {
  const isLong = zone.direction === "Long";
  if (zone.hitOutcome === "tp" && zone.takeProfitPrice != null) {
    const pts = isLong
      ? zone.takeProfitPrice - zone.entryPrice
      : zone.entryPrice - zone.takeProfitPrice;
    return Math.round(pts * 100) / 100;
  }
  if (zone.hitOutcome === "sl" && zone.stopLossPrice != null) {
    const pts = isLong
      ? zone.stopLossPrice - zone.entryPrice
      : zone.entryPrice - zone.stopLossPrice;
    return Math.round(pts * 100) / 100;
  }
  return zone.pointsMove ?? 0;
}

/**
 * Get the current unrealized points move for an active zone.
 * Used for live display while the zone is still filling.
 */
export function getActiveZonePnl(zone: PracticeZone): number | null {
  if (zone.bars.length === 0) return null;
  const lastBar = zone.bars[zone.bars.length - 1];
  const pnl = zone.direction === "Long"
    ? lastBar.close - zone.entryPrice
    : zone.entryPrice - lastBar.close;
  return Math.round(pnl * 100) / 100;
}

/**
 * Compute per-bar analytics for saving to trade_zone_bars.
 * Mirrors the analytics computed by NT8's TradeZone drawing tool:
 * mfe_from_start, mae_from_start, drawdown_from_entry, runup_from_entry,
 * close_vs_entry, high_since_entry, retrace_from_peak.
 */
export function computeBarAnalytics(zone: PracticeZone) {
  const entry = zone.entryPrice;
  const isLong = zone.direction === "Long";

  let maxFavorable = 0;
  let maxAdverse = 0;
  let highSinceEntry = 0;

  return zone.bars.map((bar) => {
    // Direction-aware excursions
    const favorableHigh = isLong ? bar.high - entry : entry - bar.low;
    const adverseLow = isLong ? entry - bar.low : bar.high - entry;
    const closeVsEntry = isLong ? bar.close - entry : entry - bar.close;

    // Running peaks
    maxFavorable = Math.max(maxFavorable, favorableHigh);
    maxAdverse = Math.max(maxAdverse, adverseLow);

    // Running high since entry (favorable direction)
    const favorableClose = isLong ? bar.close - entry : entry - bar.close;
    highSinceEntry = Math.max(highSinceEntry, favorableClose);
    const retraceFromPeak = highSinceEntry - favorableClose;

    return {
      mfe_from_start: Math.round(maxFavorable * 100) / 100,
      mae_from_start: Math.round(maxAdverse * 100) / 100,
      drawdown_from_entry: Math.round(maxAdverse * 100) / 100,
      runup_from_entry: Math.round(maxFavorable * 100) / 100,
      close_vs_entry: Math.round(closeVsEntry * 100) / 100,
      high_since_entry: Math.round(highSinceEntry * 100) / 100,
      retrace_from_peak: Math.round(retraceFromPeak * 100) / 100,
    };
  });
}
