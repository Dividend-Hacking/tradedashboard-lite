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
import { getClientStore, type Mode } from "@/lib/store";

function activeMode(): Mode {
  if (typeof window === "undefined") return "cloud";
  const w = window as unknown as { __tradeDashMode?: Mode };
  return w.__tradeDashMode ?? "cloud";
}
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
  const store = getClientStore(activeMode());

  // ─── Step 1: zones in this section that overlap the session ──────────
  // Full containment (zone start AND end inside session window) — partial
  // overlap zones would have bars that fall outside the chart.
  const zones = await store.zones.listZonesInWindow(
    sectionId,
    session.instrument,
    session.start_time,
    session.end_time
  );

  if (zones.length === 0) {
    return { zones: [], barsByZoneId: new Map(), atrByZoneId: new Map() };
  }

  // ─── Step 2: trade_zone_bars for those zones — store hides pagination ──
  const barsByZoneId = await store.zones.listBarsForZones(zones.map((z) => z.id));

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
  const store = getClientStore(activeMode());
  return store.zones.countZonesPerSectionInWindow(
    session.instrument,
    session.start_time,
    session.end_time
  );
}
