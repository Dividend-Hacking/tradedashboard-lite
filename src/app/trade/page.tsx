/**
 * Live Trading Page (Server Component)
 *
 * Fetches initial bars, position state, last price, and available accounts
 * from Supabase, then renders the LiveTrader client component.
 */

import { createClient } from "@/lib/supabase/server";
import { LiveBar, LiveState, LiveTicker, LiveAccount } from "@/types/live";
import { Trade } from "@/types/trade";
import { getDefaultInstrument } from "@/lib/utils/futures";
import LiveTrader from "@/components/trade/live-trader";
import type { TraderPreferences } from "@/lib/trader-preferences";

export default async function TradePage() {
  const supabase = await createClient();

  // Default instrument — auto-selects the current front-month contract
  const instrument = getDefaultInstrument();

  // Today at midnight UTC for filtering trades
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Fetch initial data in parallel
  const [barsResult, stateResult, tickerResult, accountsResult, tradesResult, prefsResult] = await Promise.all([
    // DESC + client-side reverse so we always return the MOST RECENT 1000 bars.
    // ASC + limit(1000) used to truncate new live bars out once the table grew
    // past 1000 rows, making refreshes "lose" any bar streamed after warmup.
    supabase
      .from("live_bars")
      .select("*")
      .eq("instrument", instrument)
      .order("bar_time", { ascending: false })
      .limit(1000),
    // live_state has composite PK (instrument, account) — fetch all for this instrument
    // The client will filter by selected account
    supabase
      .from("live_state")
      .select("*")
      .eq("instrument", instrument),
    supabase
      .from("live_ticker")
      .select("*")
      .eq("instrument", instrument)
      .maybeSingle(),
    supabase
      .from("live_accounts")
      .select("*")
      .order("account_name", { ascending: true }),
    // Fetch today's completed trades for chart markers (filtered to active instrument)
    supabase
      .from("trades")
      .select("*")
      .eq("instrument", instrument)
      .gte("entry_time", todayStart.toISOString())
      .order("entry_time", { ascending: true }),
    // Single-row preferences table — TP/SL/asset/timeframe/account choices
    // persisted across reloads. Falls back to hardcoded defaults in the
    // client when this row doesn't exist (fresh DB).
    supabase
      .from("trader_preferences")
      .select(
        "sl_points, tp_points, sl_enabled, tp_enabled, trail_enabled, instrument_label, timeframe, selected_account, quantity"
      )
      .eq("id", 1)
      .maybeSingle(),
  ]);

  const accounts = (accountsResult.data as LiveAccount[]) ?? [];
  const initialPreferences = (prefsResult.data as TraderPreferences | null) ?? null;

  return (
    <div className="px-2 py-2 h-[calc(100vh-52px)]">
      <LiveTrader
        initialBars={((barsResult.data as LiveBar[]) ?? []).slice().reverse()}
        initialStates={(stateResult.data as LiveState[]) ?? []}
        initialPrice={(tickerResult.data as LiveTicker)?.last_price ?? null}
        instrument={instrument}
        accounts={accounts.map((a) => a.account_name)}
        initialTrades={(tradesResult.data as Trade[]) ?? []}
        initialPreferences={initialPreferences}
      />
    </div>
  );
}
