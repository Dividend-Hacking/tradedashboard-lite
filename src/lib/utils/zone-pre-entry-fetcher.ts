/**
 * Zone Pre-Entry Bar Fetcher
 *
 * Pulls "what came before" bars for each zone from the replay_bars table so the
 * risk simulator's per-trade chart can show the setup leading up to the entry,
 * not just the trade itself. The user wanted at least 20 bars of pre-entry
 * context — this fetcher pulls 30 by default to give a little headroom.
 *
 * Why this exists (mirrors zone-extension-fetcher rationale): trade_zone_bars
 * only stores bars captured at draw time, starting at the zone's first bar
 * (bar_index = 0). To render the lead-up bars on the chart we need OHLCV
 * before zone.start_time, which lives in replay_bars keyed by replay_sessions.
 *
 * Linkage: zones have NO foreign key to replay_sessions. We match on-the-fly
 * by (instrument, chart_timeframe) plus a time-range containment check
 * (session.start_time <= zone.start_time AND session.end_time >= zone.end_time).
 *
 * Output shape: Map<zoneId, TradeZoneBar[]>. Each pre-entry bar is constructed
 * to look like a normal TradeZoneBar so the chart can interleave them with
 * the zone bars — bar_index is negative (running -N..-1) so they sort BEFORE
 * the zone's bar_index=0. Analytics columns (mfe_from_start, etc.) are left
 * null because the chart only reads OHLC.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { createClient } from "@/lib/supabase/client";

/** A row from replay_sessions — only the columns we use */
interface ReplaySessionRow {
  id: number;
  instrument: string;
  timeframe: string;
  start_time: string;
  end_time: string;
}

/** A row from replay_bars — only the columns we use */
interface ReplayBarRow {
  session_id: number;
  bar_time: string;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
}

/**
 * Fetches up to `barsPerZone` bars BEFORE each zone's start_time from the
 * matching replay session.
 *
 * @param zones - The zones to fetch pre-entry bars for.
 * @param barsPerZone - How many bars of pre-entry context to pull per zone
 *   (default 30 — gives the user a comfortable view of the setup that led
 *   into the entry).
 * @returns Map keyed by zone id. Zones with no matching session are simply
 *   absent from the map (caller treats this as "0 pre-entry bars available").
 */
export async function fetchZonePreEntryBars(
  zones: TradeZone[],
  barsPerZone: number = 30
): Promise<Map<number, TradeZoneBar[]>> {
  const result = new Map<number, TradeZoneBar[]>();
  if (zones.length === 0) return result;

  const supabase = createClient();

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

  const { data: sessionRows, error: sessionErr } = await supabase
    .from("replay_sessions")
    .select("id, instrument, timeframe, start_time, end_time")
    .in("instrument", Array.from(instruments))
    .in("timeframe", Array.from(timeframes));

  if (sessionErr || !sessionRows) {
    // Soft-fail: chart should still render without pre-entry context
    console.warn("[zone-pre-entry-fetcher] failed to load replay_sessions:", sessionErr);
    return result;
  }

  const sessions = sessionRows as ReplaySessionRow[];

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
    if (!session) continue;
    matches.push({ zone, session });
  }
  if (matches.length === 0) return result;

  // ─── Step 3: fetch replay_bars per session ──────────────────────────
  // Group matches by session_id and pull all bars before the LATEST zone
  // start_time in the group. We then slice per-zone in JS — one round-trip
  // per session, not per zone.
  const matchesBySession = new Map<number, ZoneMatch[]>();
  for (const m of matches) {
    const arr = matchesBySession.get(m.session.id);
    if (arr) arr.push(m);
    else matchesBySession.set(m.session.id, [m]);
  }

  for (const [sessionId, sessionMatches] of matchesBySession) {
    // Latest zone start in this group — anything after this is wasted bandwidth
    let latestStart = sessionMatches[0].zone.start_time;
    for (const m of sessionMatches) {
      if (m.zone.start_time > latestStart) latestStart = m.zone.start_time;
    }

    // Paginate to bypass Postgrest's 1000-row default (same pattern used by
    // SimulatorPanel and zone-extension-fetcher).
    const PAGE_SIZE = 1000;
    let allBars: ReplayBarRow[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error: barsErr } = await supabase
        .from("replay_bars")
        .select("session_id, bar_time, bar_open, bar_high, bar_low, bar_close, bar_volume")
        .eq("session_id", sessionId)
        .lt("bar_time", latestStart)
        .order("bar_time", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (barsErr) {
        console.warn("[zone-pre-entry-fetcher] failed to load replay_bars:", barsErr);
        break;
      }
      const rows = (data as ReplayBarRow[]) ?? [];
      allBars = allBars.concat(rows);
      hasMore = rows.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }

    // ─── Step 4: per-zone slice ───────────────────────────────────────
    // For each zone, keep only bars strictly before its own start_time
    // (since the session-wide pull was anchored on the GROUP's latest start),
    // then take the LAST `barsPerZone` of those — i.e. the most-recent N bars
    // leading up to the entry.
    for (const m of sessionMatches) {
      const zoneStart = m.zone.start_time;
      const eligible = allBars.filter((row) => row.bar_time < zoneStart);
      // Slice the tail so we get the bars closest in time to the entry, in
      // chronological order.
      const tail = eligible.slice(-barsPerZone);
      if (tail.length === 0) continue;

      const preBars: TradeZoneBar[] = tail.map((row, idx) => ({
        // Synthetic id — never written to the DB; negative so it can never
        // collide with a real trade_zone_bars.id (always positive).
        id: -1,
        zone_id: m.zone.id,
        bar_time: row.bar_time,
        bar_open: row.bar_open,
        bar_high: row.bar_high,
        bar_low: row.bar_low,
        bar_close: row.bar_close,
        bar_volume: row.bar_volume,
        // Negative bar_index counting up to -1, so these sort BEFORE the
        // zone's bar_index=0 (the entry bar). Example with 30 bars:
        //   tail[0]  → bar_index = -30
        //   tail[29] → bar_index = -1
        bar_index: -(tail.length - idx),
        mfe_from_start: null,
        mae_from_start: null,
        drawdown_from_entry: null,
        runup_from_entry: null,
        close_vs_entry: null,
        high_since_entry: null,
        retrace_from_peak: null,
        created_at: row.bar_time,
      }));

      result.set(m.zone.id, preBars);
    }
  }

  return result;
}
