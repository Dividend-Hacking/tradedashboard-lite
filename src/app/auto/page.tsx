/**
 * Auto-Trader Page (Server Component)
 *
 * Sibling of /trade but stripped down to what an automated strategy needs:
 * a chart, a deployed-preset control center, daily-limit visibility, and
 * an activity log. No manual order entry, tagger, trade timer, or
 * preview SL/TP — those exist on /trade for discretionary trading.
 *
 * SSR fetches the same initial bar / state / ticker / accounts data the
 * live trader uses (via the active backend's Store), then hands off to
 * the AutoTrader client component.
 */

import { getServerStore } from "@/lib/store/server";
import { getDefaultInstrument } from "@/lib/utils/futures";
import AutoTrader from "@/components/auto/auto-trader";

const LIVE_TIMEFRAME = "15 Second";

export default async function AutoPage() {
  const store = await getServerStore();

  const instrument = getDefaultInstrument();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [bars, states, ticker, accounts, trades, preferences] = await Promise.all([
    store.live.listBarsForInstrument(instrument, LIVE_TIMEFRAME, 1000),
    store.live.listStatesForInstrument(instrument),
    store.live.getTicker(instrument),
    store.live.listAccounts(),
    store.trades.listForInstrumentSinceUtc(instrument, todayStart.toISOString()),
    store.traderPrefs.fetch(),
  ]);

  return (
    <div className="px-2 py-2 h-[calc(100vh-52px)]">
      <AutoTrader
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
