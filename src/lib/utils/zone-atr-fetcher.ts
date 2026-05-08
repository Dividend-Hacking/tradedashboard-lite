/**
 * Zone ATR Fetcher
 *
 * Computes ATR(14) (Wilder smoothing) at each zone's entry, sourcing the
 * required pre-zone bars from the matching replay_session in replay_bars.
 *
 * Why this exists: trade_zones.ctx_atr14 is null on every existing row (the
 * NinjaTrader-side context capture wasn't populating it), so the simulator's
 * "ATR mode" needs to compute ATR client-side from the OHLC history we already
 * have in replay_bars. Every current zone has a matching replay_session, so
 * coverage is 100%.
 *
 * How it works:
 *   1. For each zone, find the containing replay_session by
 *      (instrument, chart_timeframe, session.start_time <= zone.start_time
 *      AND session.end_time >= zone.end_time).
 *   2. Per session group, fetch the last ~30 bars before the EARLIEST zone
 *      start in that group from replay_bars (one query per session).
 *   3. For each zone in the group, slice the bars whose bar_time < zone.start_time,
 *      take the most recent ~30, and run Wilder ATR(14).
 *
 * Output: Map<zoneId, atrValue>. Zones we couldn't compute ATR for are
 * absent — the simulator falls back to the raw point values for them.
 *
 * Performance: ~1 SELECT per matched session (typically a small handful).
 * The session-matching logic is intentionally a small duplicate of
 * zone-extension-fetcher.ts — the two could be unified later, but keeping
 * them separate keeps each file focused and easy to reason about.
 */

import { TradeZone } from "@/types/trade-zone";
import { getClientStore, type Mode } from "@/lib/store";

/** Read the active mode from the window-level global the ModeProvider
 *  publishes on mount. Same pattern as backtest-presets / trader-prefs
 *  so this plain util module stays free of React hooks. */
function activeMode(): Mode {
  if (typeof window === "undefined") return "cloud";
  const w = window as unknown as { __tradeDashMode?: Mode };
  return w.__tradeDashMode ?? "cloud";
}

interface ReplaySessionRow {
  id: number;
  instrument: string;
  timeframe: string;
  start_time: string;
  end_time: string;
}

interface ReplayBarRow {
  bar_time: string;
  bar_high: number;
  bar_low: number;
  bar_close: number;
}

// We need 14 prior bars + 1 to seed Wilder ATR(14). Fetching a few extra gives
// the smoothing a chance to settle and acts as a safety margin against gaps.
const ATR_PERIOD = 14;
const ATR_LOOKBACK_BARS = 30;

/**
 * Wilder ATR(14). Returns null if there aren't enough bars (need at least
 * ATR_PERIOD + 1 to compute even one TR + the seed).
 *
 * Bars must be in ASCENDING time order.
 */
export function computeAtr14Wilder(bars: ReplayBarRow[]): number | null {
  if (bars.length < ATR_PERIOD + 1) return null;

  // True Range per bar (skips index 0 because TR needs prevClose)
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      cur.bar_high - cur.bar_low,
      Math.abs(cur.bar_high - prev.bar_close),
      Math.abs(cur.bar_low - prev.bar_close)
    );
    trs.push(tr);
  }
  if (trs.length < ATR_PERIOD) return null;

  // Seed: simple average of the first ATR_PERIOD TRs
  let atr = 0;
  for (let i = 0; i < ATR_PERIOD; i++) atr += trs[i];
  atr /= ATR_PERIOD;

  // Wilder smoothing for the rest: ATR_t = (ATR_{t-1} * (n-1) + TR_t) / n
  for (let i = ATR_PERIOD; i < trs.length; i++) {
    atr = (atr * (ATR_PERIOD - 1) + trs[i]) / ATR_PERIOD;
  }

  return atr;
}

/** Parse a NinjaTrader timeframe label ("15 Second", "1 Minute"...) to seconds. */
function timeframeToSeconds(tf: string): number {
  const m = tf.match(/(\d+)\s*(Second|Minute|Hour|Day)/i);
  if (!m) return 60;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "second") return n;
  if (unit === "minute") return n * 60;
  if (unit === "hour") return n * 3600;
  return n * 86400;
}

/**
 * Fetches and computes ATR(14) at entry for each zone using replay_bars.
 *
 * @param zones - The zones to compute ATR for.
 * @returns Map keyed by zone id. Zones without enough history (or no matching
 *   replay session) are absent — caller treats absence as "no ATR available"
 *   and the simulator falls back to raw point values for those zones.
 */
export async function fetchZoneAtr(
  zones: TradeZone[]
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (zones.length === 0) return result;

  const store = getClientStore(activeMode());

  // ─── Step 1: pull candidate replay sessions ─────────────────────────
  const instruments = new Set<string>();
  const timeframes = new Set<string>();
  for (const z of zones) {
    if (z.chart_timeframe) {
      instruments.add(z.instrument);
      timeframes.add(z.chart_timeframe);
    }
  }
  if (instruments.size === 0) return result;

  let sessions: ReplaySessionRow[];
  try {
    sessions = (await store.replay.listSessionsByInstrumentsAndTimeframes(
      Array.from(instruments),
      Array.from(timeframes)
    )) as ReplaySessionRow[];
  } catch (err) {
    console.warn("[zone-atr-fetcher] failed to load replay_sessions:", err);
    return result;
  }

  // ─── Step 2: match each zone to its containing session ──────────────
  interface ZoneMatch {
    zone: TradeZone;
    session: ReplaySessionRow;
  }
  const matches: ZoneMatch[] = [];
  for (const zone of zones) {
    if (!zone.chart_timeframe) continue;
    const session = sessions.find(
      (s) =>
        s.instrument === zone.instrument &&
        s.timeframe === zone.chart_timeframe &&
        s.start_time <= zone.start_time &&
        s.end_time >= zone.end_time
    );
    if (session) matches.push({ zone, session });
  }
  if (matches.length === 0) return result;

  // ─── Step 3: per-session, fetch pre-zone history bars in one query ──
  // We pull bars in [earliest_zone_start - ATR_LOOKBACK_BARS*tfSec, latest_zone_start]
  // for each session — that's a single bounded range query that gives us enough
  // history to compute ATR for every zone in the session. We then slice per-zone
  // in JS to find each zone's specific 30-bar window.
  const matchesBySession = new Map<number, ZoneMatch[]>();
  for (const m of matches) {
    const arr = matchesBySession.get(m.session.id);
    if (arr) arr.push(m);
    else matchesBySession.set(m.session.id, [m]);
  }

  for (const [sessionId, sessionMatches] of matchesBySession) {
    const session = sessionMatches[0].session;
    const tfSec = timeframeToSeconds(session.timeframe);

    // Find earliest zone start in this group
    let earliestStart = sessionMatches[0].zone.start_time;
    let latestStart = sessionMatches[0].zone.start_time;
    for (const m of sessionMatches) {
      if (m.zone.start_time < earliestStart) earliestStart = m.zone.start_time;
      if (m.zone.start_time > latestStart) latestStart = m.zone.start_time;
    }

    // Compute lookback start time. ATR_LOOKBACK_BARS * tfSec gives us enough
    // bars before the earliest zone in the group. Add a generous safety pad
    // (2x) to absorb any session gaps or non-trading time.
    const lookbackSec = ATR_LOOKBACK_BARS * tfSec * 2;
    const earliestStartMs = Date.parse(earliestStart);
    const lookbackStartIso = new Date(earliestStartMs - lookbackSec * 1000).toISOString();

    // One query: all bars in [lookbackStart, latestStart] for this session.
    // The store layer handles pagination internally — Supabase pages
    // through PostgREST's 1000-row cap, SQLite returns everything in
    // one go.
    let allBars: ReplayBarRow[] = [];
    try {
      const rows = await store.replay.listBarsForSessionInTimeRange(
        sessionId,
        lookbackStartIso,
        latestStart
      );
      // Project to the columns the ATR helper needs.
      allBars = rows.map((r) => ({
        bar_time: r.bar_time,
        bar_high: r.bar_high,
        bar_low: r.bar_low,
        bar_close: r.bar_close,
      }));
    } catch (err) {
      console.warn("[zone-atr-fetcher] failed to load replay_bars:", err);
    }

    // ─── Step 4: per zone, slice the last 30 bars before zone.start_time ──
    // and compute ATR(14). allBars is already time-sorted ascending.
    for (const m of sessionMatches) {
      const zoneStart = m.zone.start_time;
      // Take bars strictly before the zone's entry. Since the array is sorted,
      // we can binary-search but a linear scan is plenty fast for ~30 bars.
      const priorBars: ReplayBarRow[] = [];
      for (const b of allBars) {
        if (b.bar_time < zoneStart) priorBars.push(b);
        else break; // sorted — no point continuing
      }
      // Keep only the most recent ATR_LOOKBACK_BARS to keep the smoothing
      // localized to recent volatility (not stale data from hours earlier)
      const window = priorBars.slice(-ATR_LOOKBACK_BARS);
      const atr = computeAtr14Wilder(window);
      if (atr != null && atr > 0) {
        result.set(m.zone.id, atr);
      }
    }
  }

  return result;
}
