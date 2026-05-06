/**
 * Zone Extension Bar Fetcher
 *
 * Pulls "what comes next" bars for each zone from the replay_bars table so the
 * risk simulator can run "what if I held the trade N bars longer?" scenarios.
 *
 * Why this exists: trade_zone_bars only stores the bars captured at draw time
 * (the duration of the user's drawn rectangle). To simulate a longer hold we
 * need OHLCV beyond zone.end_time, which lives in replay_bars keyed by
 * replay_sessions.
 *
 * Linkage strategy: zones have NO foreign key to replay_sessions. We match
 * on-the-fly by (instrument, chart_timeframe) plus a time-range containment
 * check (session.start_time <= zone.start_time AND session.end_time >= zone.end_time).
 * This avoids a schema migration; the cost is a one-time fetch on simulator mount.
 *
 * Output shape: Map<zoneId, TradeZoneBar[]>. Each extension bar is constructed to
 * look like a normal TradeZoneBar so the existing simulateZone walk can consume
 * it without changes — bar_index continues monotonically from the last real
 * zone bar, and the analytics columns (mfe_from_start, drawdown_from_entry,
 * etc.) are left null because the walk only reads OHLC.
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
 * Fetches up to `maxBarsPerZone` bars after each zone's end_time from the
 * matching replay session.
 *
 * @param zones - The zones to fetch extension bars for.
 * @param barsByZoneId - The already-fetched zone bars (used to compute the
 *   continuing bar_index for synthetic extension bars).
 * @param maxBarsPerZone - Hard ceiling on bars per zone (default 100). Sets
 *   the maximum the user can slide the "Extend Bars" control to.
 * @returns Map keyed by zone id. Zones with no matching session are simply
 *   absent from the map (caller treats this as "0 extension bars available").
 */
export async function fetchZoneExtensionBars(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  maxBarsPerZone: number = 100
): Promise<Map<number, TradeZoneBar[]>> {
  const result = new Map<number, TradeZoneBar[]>();
  if (zones.length === 0) return result;

  const supabase = createClient();

  // ─── Step 1: pull candidate replay sessions ─────────────────────────
  // Collect unique (instrument, timeframe) pairs so we can fetch all relevant
  // sessions in one round-trip. Postgrest doesn't support tuple-IN, so we
  // OR-filter by instrument set and timeframe set and post-filter in JS.
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
    // Soft-fail: simulator should still work without extension data
    console.warn("[zone-extension-fetcher] failed to load replay_sessions:", sessionErr);
    return result;
  }

  const sessions = sessionRows as ReplaySessionRow[];

  // ─── Step 2: match each zone to its containing session ──────────────
  // A zone matches a session when instrument + timeframe match AND the zone's
  // [start_time, end_time] falls within the session's [start_time, end_time].
  // We compare ISO strings directly — they're lexicographically sortable when
  // they share the same format and timezone (Postgrest returns UTC ISO).
  interface ZoneMatch {
    zone: TradeZone;
    session: ReplaySessionRow;
    lastZoneBarIndex: number; // Where to continue bar_index from
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

    // Find the highest bar_index in the zone's existing bars so the synthetic
    // extension bars can continue past it monotonically.
    const zoneBars = barsByZoneId.get(zone.id) ?? [];
    let lastIdx = -1;
    for (const b of zoneBars) {
      if (b.bar_index > lastIdx) lastIdx = b.bar_index;
    }
    matches.push({ zone, session, lastZoneBarIndex: lastIdx });
  }

  if (matches.length === 0) return result;

  // ─── Step 3: fetch replay_bars per session ──────────────────────────
  // Group matches by session_id. For each session, find the earliest zone
  // end_time in the group, then pull all bars after that point. We then slice
  // per-zone in JS. This minimizes round-trips (one per session, not per zone).
  const matchesBySession = new Map<number, ZoneMatch[]>();
  for (const m of matches) {
    const arr = matchesBySession.get(m.session.id);
    if (arr) arr.push(m);
    else matchesBySession.set(m.session.id, [m]);
  }

  for (const [sessionId, sessionMatches] of matchesBySession) {
    // Earliest zone end in this group — anything before this is wasted bandwidth
    let earliestEnd = sessionMatches[0].zone.end_time;
    for (const m of sessionMatches) {
      if (m.zone.end_time < earliestEnd) earliestEnd = m.zone.end_time;
    }

    // Paginate through replay_bars to bypass Postgrest's default 1000-row cap
    // (same pattern used by SimulatorPanel for trade_zone_bars).
    const PAGE_SIZE = 1000;
    let allBars: ReplayBarRow[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error: barsErr } = await supabase
        .from("replay_bars")
        .select("session_id, bar_time, bar_open, bar_high, bar_low, bar_close, bar_volume")
        .eq("session_id", sessionId)
        .gt("bar_time", earliestEnd)
        .order("bar_time", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (barsErr) {
        console.warn("[zone-extension-fetcher] failed to load replay_bars:", barsErr);
        break;
      }
      const rows = (data as ReplayBarRow[]) ?? [];
      allBars = allBars.concat(rows);
      hasMore = rows.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }

    // ─── Step 4: slice per-zone and synthesize TradeZoneBar shapes ────
    // For each zone in this session, take the first maxBarsPerZone bars whose
    // bar_time is strictly greater than the zone's own end_time. We then
    // convert each ReplayBarRow into a TradeZoneBar-shaped object so the
    // simulator's existing walk can consume it transparently.
    for (const m of sessionMatches) {
      const zoneEnd = m.zone.end_time;
      const extension: TradeZoneBar[] = [];
      let extOffset = 0;

      for (const row of allBars) {
        if (row.bar_time <= zoneEnd) continue;
        if (extension.length >= maxBarsPerZone) break;

        extension.push({
          // Synthetic id — never written to the DB; negative so it can never
          // collide with a real trade_zone_bars.id (bigint identity, always positive).
          id: -1,
          zone_id: m.zone.id,
          bar_time: row.bar_time,
          bar_open: row.bar_open,
          bar_high: row.bar_high,
          bar_low: row.bar_low,
          bar_close: row.bar_close,
          bar_volume: row.bar_volume,
          // Continue bar_index monotonically past the zone's last real bar so
          // sorting in simulateZone keeps the appended bars after the originals.
          bar_index: m.lastZoneBarIndex + 1 + extOffset,
          // Analytics columns are unused by the simulator's bar walk (which
          // only reads OHLC). Leave null — they're for display, not logic.
          mfe_from_start: null,
          mae_from_start: null,
          drawdown_from_entry: null,
          runup_from_entry: null,
          close_vs_entry: null,
          high_since_entry: null,
          retrace_from_peak: null,
          created_at: row.bar_time,
        });
        extOffset += 1;
      }

      if (extension.length > 0) {
        result.set(m.zone.id, extension);
      }
    }
  }

  return result;
}
