/**
 * Time Window Optimizer — Sweeps all timeFrom × timeTo combos (30-min steps)
 * to find the optimal trading time window that maximizes avg points per trade.
 *
 * Uses the same generator + rAF-chunked pattern as zone-optimizer.ts so the
 * UI stays responsive with a progress indicator.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import {
  SimRules,
  simulateAllZones,
  computeSimSummary,
  SimSummary,
} from "./zone-simulator";

// Note: no dependency on the worker runner here on purpose. See the note in
// zone-optimizer.ts — keeping this file runner-free breaks the import cycle
// that was causing Webpack's worker bundler to hang.

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of the time optimization run */
export interface TimeOptimizeResult {
  /** Best time window start ("HH:MM" format) */
  bestTimeFrom: string;
  /** Best time window end ("HH:MM" format) */
  bestTimeTo: string;
  /** Avg points per trade at the best window */
  bestAvgPoints: number;
  /** Full summary stats at the best window */
  bestSummary: SimSummary;
  /** Number of zones in the best window */
  bestZoneCount: number;
  /** How many time combos were evaluated */
  combinationsTested: number;
  /** Wall-clock time in ms */
  elapsedMs: number;
}

/** Yielded by the generator on each progress checkpoint */
export interface TimeOptimizeProgress {
  /** 0–1 fraction of combos completed */
  progress: number;
  /** Running best result so far */
  current: TimeOptimizeResult | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** 30-minute step in minutes */
const STEP_MINUTES = 30;
/** Minimum number of trades in a window to be considered valid */
const MIN_TRADES = 5;
/** Yield progress every N combos */
const YIELD_INTERVAL = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert minutes since midnight to "HH:MM" string */
function minutesToTimeStr(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Extract minutes-since-midnight from a zone's start_time.
 * Parses ISO-ish timestamps like "2024-03-15T10:30:00" or raw DB formats.
 */
function zoneToMinutes(zone: TradeZone): number {
  const t = zone.start_time;
  // Try to extract HH:MM from the timestamp string
  const match = t.match(/(\d{2}):(\d{2})/);
  if (match) {
    return parseInt(match[1]) * 60 + parseInt(match[2]);
  }
  // Fallback: parse as Date
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Filter zones by a time window (supports wrapping, e.g. 22:00 to 02:00).
 * Same logic as simulator-panel.tsx's timeFilteredZones memo.
 */
function filterZonesByTime(
  zones: TradeZone[],
  fromMin: number,
  toMin: number,
  zoneMinutes: Map<number, number>
): TradeZone[] {
  return zones.filter((z) => {
    const zoneMin = zoneMinutes.get(z.id) ?? 0;
    if (fromMin <= toMin) {
      return zoneMin >= fromMin && zoneMin <= toMin;
    } else {
      // Wrapping (e.g., 22:00 to 02:00)
      return zoneMin >= fromMin || zoneMin <= toMin;
    }
  });
}

// ─── Generator ──────────────────────────────────────────────────────────────

/**
 * Build contiguous blocks of active 30-min slots from the zone data.
 * Each block is a sorted array of consecutive slot times with no gaps.
 * E.g., if trades exist at 8:00, 8:30, 9:00, 9:30, 14:00, 14:30, 15:00
 * → two blocks: [480, 510, 540, 570] and [840, 870, 900]
 */
function buildContiguousBlocks(zones: TradeZone[], zoneMinutes: Map<number, number>): number[][] {
  // Collect all active slots
  const activeSlots = new Set<number>();
  for (const mins of zoneMinutes.values()) {
    const slot = Math.floor(mins / STEP_MINUTES) * STEP_MINUTES;
    activeSlots.add(slot);
  }

  // Sort them chronologically
  const sorted = [...activeSlots].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  // Group into contiguous runs (each slot is STEP_MINUTES apart from the next)
  const blocks: number[][] = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === STEP_MINUTES) {
      current.push(sorted[i]);
    } else {
      blocks.push(current);
      current = [sorted[i]];
    }
  }
  blocks.push(current);
  return blocks;
}

export function* timeOptimizeGenerator(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  minWindowMinutes: number = 60,
  atrByZoneId?: Map<number, number> | null
): Generator<TimeOptimizeProgress, TimeOptimizeResult, void> {
  const startMs = performance.now();

  // Pre-compute zone minutes for fast filtering
  const zoneMinutes = new Map<number, number>();
  for (const z of zones) {
    zoneMinutes.set(z.id, zoneToMinutes(z));
  }

  // Build contiguous blocks of active trading slots. Windows are only
  // generated within a single block, so the result is always one unbroken
  // session — no wrapping around midnight or spanning dead hours.
  const blocks = buildContiguousBlocks(zones, zoneMinutes);
  const minSlots = Math.max(1, Math.ceil(minWindowMinutes / STEP_MINUTES));

  // Generate all valid sub-windows within each contiguous block.
  // A window spans slots[i] through slots[j], producing timeFrom = slots[i]
  // and timeTo = slots[j] + STEP_MINUTES (end of the last slot).
  const combos: [number, number][] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) {
      // j is the index of the last slot in the window (inclusive)
      for (let j = i + minSlots - 1; j < block.length; j++) {
        const from = block[i];
        const to = block[j] + STEP_MINUTES; // End of last slot
        combos.push([from, to]);
      }
    }
  }

  const totalCombos = combos.length;
  let tested = 0;
  let bestAvgPoints = -Infinity;
  let bestSummary: SimSummary | null = null;
  let bestFrom = 0;
  let bestTo = 0;
  let bestZoneCount = 0;

  for (const [fromMin, toMin] of combos) {
    // Filter zones to this time window
    const windowZones = filterZonesByTime(zones, fromMin, toMin, zoneMinutes);

    // Skip windows with too few trades to avoid overfitting
    if (windowZones.length >= MIN_TRADES) {
      const results = simulateAllZones(windowZones, barsByZoneId, rules, atrByZoneId);
      const summary = computeSimSummary(results);

      // Maximize average points per trade (per-trade EV).
      // Tie-break on total points if avgPoints is equal.
      if (
        summary.avgPoints > bestAvgPoints ||
        (summary.avgPoints === bestAvgPoints &&
          bestSummary !== null &&
          summary.totalPoints > bestSummary.totalPoints)
      ) {
        bestAvgPoints = summary.avgPoints;
        bestSummary = summary;
        bestFrom = fromMin;
        bestTo = toMin;
        bestZoneCount = windowZones.length;
      }
    }

    tested++;

    // Yield progress at regular intervals
    if (tested % YIELD_INTERVAL === 0) {
      yield {
        progress: tested / totalCombos,
        current: bestSummary
          ? {
              bestTimeFrom: minutesToTimeStr(bestFrom),
              bestTimeTo: minutesToTimeStr(bestTo),
              bestAvgPoints,
              bestSummary,
              bestZoneCount,
              combinationsTested: tested,
              elapsedMs: Math.round(performance.now() - startMs),
            }
          : null,
      };
    }
  }

  // Final result — if no valid window found, return the full-day window
  return {
    bestTimeFrom: minutesToTimeStr(bestFrom),
    bestTimeTo: minutesToTimeStr(bestTo),
    bestAvgPoints: bestSummary?.avgPoints ?? 0,
    bestSummary: bestSummary ?? computeSimSummary([]),
    bestZoneCount,
    combinationsTested: tested,
    elapsedMs: Math.round(performance.now() - startMs),
  };
}

// `runTimeOptimizeChunked` (the worker-backed runner) lives in
// `optimizer-worker-runner.ts`. Import it from there.
