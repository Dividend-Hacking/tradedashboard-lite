/**
 * Live Trading Page (Server Component)
 *
 * Fetches initial bars, position state, last price, available accounts,
 * trades-for-today, and persisted preferences from the active backend
 * (Supabase in cloud mode, local SQLite in local mode), then renders
 * the LiveTrader client component.
 */

import { getServerStore } from "@/lib/store/server";
import { getDefaultInstrument } from "@/lib/utils/futures";
import LiveTrader from "@/components/trade/live-trader";

/** The live trader currently only consumes 15-second bars. The original
 *  server fetch didn't filter by timeframe (the table effectively had one).
 *  We pin the new repo call to "15 Second" so behavior is unchanged. */
const LIVE_TIMEFRAME = "15 Second";

export default async function TradePage() {
  const store = await getServerStore();

  // Default instrument — auto-selects the current front-month contract
  const instrument = getDefaultInstrument();

  // Today at midnight UTC for filtering trades
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [bars, states, ticker, accounts, trades, preferences] = await Promise.all([
    // listBarsForInstrument returns the most recent N bars, ordered ascending,
    // matching the original DESC + slice().reverse() pattern.
    store.live.listBarsForInstrument(instrument, LIVE_TIMEFRAME, 1000),
    store.live.listStatesForInstrument(instrument),
    store.live.getTicker(instrument),
    store.live.listAccounts(),
    store.trades.listForInstrumentSinceUtc(instrument, todayStart.toISOString()),
    store.traderPrefs.fetch(),
  ]);

  return (
    <div className="px-2 py-2 h-[calc(100vh-52px)]">
      <LiveTrader
        initialBars={bars}
        initialStates={states}
        initialPrice={ticker?.last_price ?? null}
        instrument={instrument}
        accounts={accounts.map((a) => a.account_name)}
        initialTrades={trades}
        initialPreferences={preferences}
      />
    </div>
  );
}
