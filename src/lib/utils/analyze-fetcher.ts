/**
 * Analyze Fetcher
 *
 * Loads the data the practice-mode "Analyze" feature needs to render zones
 * from a chosen section onto the currently-loaded replay session's chart.
 *
 * For a given (sectionId, replay session) it returns:
 *   - zones      — every trade_zone whose section, instrument, and time range
 *                  fall inside the session's window.
 *   - barsByZoneId — paginated trade_zone_bars for those zones, grouped by id.
 *   - atrByZoneId — ATR(14) at entry per zone (re-using the simulator's
 *                   client-side computation), so the simulator's optional
 *                   ± ATR adjustments behave the same way as in the dashboard.
 *
 * Counterpart of the SimulatorPanel's mount-time fetch, but scoped to a single
 * section AND a single replay session window so we don't pull every zone in
 * the project just to plot the few that overlap the user's chart.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { ReplaySession } from "@/types/replay";
import { createClient } from "@/lib/supabase/client";
import { fetchZoneAtr } from "./zone-atr-fetcher";

export interface AnalyzeData {
  zones: TradeZone[];
  barsByZoneId: Map<number, TradeZoneBar[]>;
  atrByZoneId: Map<number, number>;
}

/**
 * Fetch zones in `sectionId` whose start/end fall fully inside the loaded
 * replay session's window, plus every bar and the ATR(14) needed to feed the
 * shared zone-simulator engine.
 *
 * @param sectionId - Which section the user picked in the section picker.
 * @param session   - The currently-loaded replay session — its instrument and
 *                    [start_time, end_time] form the filter window.
 */
export async function fetchAnalyzeData(
  sectionId: number,
  session: ReplaySession
): Promise<AnalyzeData> {
  const supabase = createClient();

  // ─── Step 1: zones in this section that overlap the session ──────────
  // Use full containment (zone start AND end inside session window) — partial
  // overlap zones would have bars that fall outside the chart, which would
  // look broken to the user. Sort by start_time so the equity curve / table
  // (if we ever add one) has a deterministic chronological order.
  const { data: zoneRows, error: zoneErr } = await supabase
    .from("trade_zones")
    .select("*")
    .eq("section_id", sectionId)
    .eq("instrument", session.instrument)
    .gte("start_time", session.start_time)
    .lte("end_time", session.end_time)
    .order("start_time", { ascending: true });

  if (zoneErr) throw zoneErr;
  const zones = (zoneRows as TradeZone[]) ?? [];

  if (zones.length === 0) {
    return { zones: [], barsByZoneId: new Map(), atrByZoneId: new Map() };
  }

  // ─── Step 2: trade_zone_bars for those zones (paginated) ─────────────
  // Same 1000-row PostgREST cap pattern as SimulatorPanel — paginate so we
  // don't silently truncate when a section has many bar-heavy zones.
  const zoneIds = zones.map((z) => z.id);
  const PAGE_SIZE = 1000;
  let allBars: TradeZoneBar[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("trade_zone_bars")
      .select("*")
      .in("zone_id", zoneIds)
      .order("bar_index", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data as TradeZoneBar[]) ?? [];
    allBars = allBars.concat(rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const barsByZoneId = new Map<number, TradeZoneBar[]>();
  for (const bar of allBars) {
    const arr = barsByZoneId.get(bar.zone_id);
    if (arr) arr.push(bar);
    else barsByZoneId.set(bar.zone_id, [bar]);
  }

  // ─── Step 3: per-zone ATR(14) at entry ───────────────────────────────
  // Non-fatal — if the ATR fetcher errors (e.g. the matching replay session
  // can't be located), we hand back an empty map and the simulator falls back
  // to raw point values. Same behavior as the dashboard's SimulatorPanel.
  const atrByZoneId = await fetchZoneAtr(zones).catch((err) => {
    console.warn("[analyze-fetcher] ATR fetch failed:", err);
    return new Map<number, number>();
  });

  return { zones, barsByZoneId, atrByZoneId };
}

/**
 * Lightweight count helper for the section picker. Returns the number of zones
 * in each section that fall inside the session window — used to render
 * "N zones" next to each chip and to disable empty sections.
 */
export async function fetchAnalyzeZoneCounts(
  session: ReplaySession
): Promise<Map<number, number>> {
  const supabase = createClient();
  const counts = new Map<number, number>();

  // Pull only section_id (one column) for every zone in window. Paginated to
  // bypass the 1000-row cap; we intentionally don't filter by section here so
  // a single round-trip serves the whole picker.
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("trade_zones")
      .select("section_id")
      .eq("instrument", session.instrument)
      .gte("start_time", session.start_time)
      .lte("end_time", session.end_time)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data as { section_id: number | null }[]) ?? [];
    for (const r of rows) {
      if (r.section_id == null) continue;
      counts.set(r.section_id, (counts.get(r.section_id) ?? 0) + 1);
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return counts;
}
