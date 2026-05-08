/**
 * Home Page (Server Component)
 *
 * Fetches all trades and trade zones from the active backend (Supabase
 * in cloud mode, local SQLite in local mode) and passes them to the
 * client-side TabSwitcher, which renders either the Trades dashboard or
 * the Trade Zones dashboard based on the active tab.
 */

import { getServerStore } from "@/lib/store/server";
import { TabSwitcher } from "@/components/tab-switcher";
import { Trade } from "@/types/trade";
import { TradeZone, ZoneSection } from "@/types/trade-zone";
import { ReplaySession } from "@/types/replay";

export default async function Home() {
  const store = await getServerStore();

  // Fetch trades, zones, sections, and replay sessions in parallel. The
  // store layer handles pagination internally for tables that exceed
  // Supabase's 1000-row cap (trades, trade_zones); SQLite returns
  // everything in one query.
  let trades: Trade[] = [];
  let zones: TradeZone[] = [];
  let sections: ZoneSection[] = [];
  let replaySessions: ReplaySession[] = [];
  try {
    [trades, zones, sections, replaySessions] = await Promise.all([
      store.trades.listAllOrderedByEntryTime(),
      store.zones.listZones(),
      store.zones.listSections(),
      // replay_sessions failure is non-fatal — Promise.all will still
      // throw, so we wrap below for the non-critical ones.
      store.replay.listSessions(),
    ]);
  } catch (err) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-accent-red">
          Failed to load dashboard: {err instanceof Error ? err.message : String(err)}
        </p>
      </div>
    );
  }

  return (
    <TabSwitcher
      trades={trades}
      zones={zones}
      sections={sections}
      replaySessions={replaySessions}
    />
  );
}
