/**
 * SimulatorStatCards — Summary metrics for the risk simulator results.
 *
 * Renders a grid of stat cards for the active SimSummary. The `mode` prop
 * switches every value between points and dollars; the underlying summary
 * carries both unit families (e.g. `expectancy` + `expectancyDollars`) so
 * the toggle is a render-time field swap with no recomputation.
 */

"use client";

import { SimSummary } from "@/lib/utils/zone-simulator";
import { formatNumber, formatPercent, formatCurrency } from "@/lib/utils/format";

interface SimulatorStatCardsProps {
  summary: SimSummary;
  // Display unit. Defaults to "points" so callers that don't care about
  // the toggle (e.g. the risk simulator panel) keep their current view.
  mode?: "points" | "dollars";
}

function pnlColor(value: number): string {
  if (value > 0) return "text-accent-green";
  if (value < 0) return "text-accent-red";
  return "text-foreground";
}

// Render a raw, unrounded number for the hover tooltip. Uses JS's native
// shortest-repr `Number.toString()` so we show every digit the value
// actually carries — important for low-tick instruments like CL where a
// rounded "0.01" might really be 0.0123 and the user wants to see that
// without permanently cluttering the card face. Returns "—" for null and
// "∞" for Infinity (matches the displayed face). No unit conversion.
function rawNum(value: number | null | undefined): string {
  if (value == null) return "—";
  if (!isFinite(value)) return value > 0 ? "∞" : "-∞";
  return value.toString();
}

export function SimulatorStatCards({ summary, mode = "points" }: SimulatorStatCardsProps) {
  const isDollars = mode === "dollars";

  // Pick the right magnitude per metric based on the active unit. Win
  // rate, profit factor, trade counts, durations, sharpe, and per-size
  // EV stay in their native units regardless of the toggle (none of
  // them have a "dollar version").
  const totalVal = isDollars ? summary.totalDollars : summary.totalPoints;
  const avgVal = isDollars ? summary.avgDollars : summary.avgPoints;
  const evVal = isDollars ? summary.expectancyDollars : summary.expectancy;
  const avgWinVal = isDollars ? summary.avgWinDollars : summary.avgWinPoints;
  const avgLossVal = isDollars ? summary.avgLossDollars : summary.avgLossPoints;
  const bestVal = isDollars ? summary.bestTradeDollars : summary.bestTrade;
  const worstVal = isDollars ? summary.worstTradeDollars : summary.worstTrade;
  const grossProfitVal = isDollars ? summary.grossProfitDollars : summary.grossProfit;
  const grossLossVal = isDollars ? summary.grossLossDollars : summary.grossLoss;
  const dailyEvVal = isDollars ? summary.dailyEvDollars : summary.dailyEv;
  const monthlyEvVal = isDollars ? summary.monthlyEvDollars : summary.monthlyEv;
  const maxDdVal = isDollars ? summary.maxDrawdownDollars : summary.maxDrawdown;
  const profitFactorVal = isDollars ? summary.profitFactorDollars : summary.profitFactor;

  // Single formatter chosen by mode — currency for dollars (Intl.
  // NumberFormat already sign-prefixes negatives), 3-decimal fixed for
  // points.
  const fmt = (v: number) => (isDollars ? formatCurrency(v) : formatNumber(v, 3));
  const fmtPair = (a: number, b: number) => `${fmt(a)} / ${fmt(b)}`;
  const unitLabel = isDollars ? "$" : "Points";

  // Display the dominant-instrument root only (e.g. "NQ") on the card
  // face — the full "NQ 06-26" goes in the tooltip so the contract month
  // is still discoverable on hover without crowding the small card.
  const tickerRoot = summary.primaryInstrument
    ? summary.primaryInstrument.split(" ")[0]
    : "—";
  // Use the same shortest-repr `Number.toString()` strategy as `rawNum`
  // for the displayed card face — point values and ticks/pt are integers
  // for most CME instruments (NQ → 20, ES → 50, ZN → 64) but fractional
  // for crypto and a few others (BTC → 5, MBT → 0.10, BTC ticks/pt → 0.2).
  // Plain toString avoids forcing trailing zeros on the integer cases
  // while still rendering the fractional ones at full precision.
  const fmtMeta = (v: number | undefined): string =>
    v == null ? "—" : v.toString();

  const cards = [
    {
      label: "Ticker",
      value: tickerRoot,
      color: "text-foreground",
      // Tooltip shows the full instrument string the simulator saw —
      // useful when the displayed root strips the contract suffix.
      tooltip: summary.primaryInstrument ?? "—",
    },
    {
      // Dollar value of a 1.0 price move at 1 contract (e.g. NQ → 20).
      // Always rendered as a raw number rather than `formatCurrency` —
      // this is metadata about the contract spec, not a P&L value, so
      // the leading "$" / negative styling don't apply.
      label: "Point Value",
      value: fmtMeta(summary.pointValue),
      color: "text-foreground",
      tooltip: rawNum(summary.pointValue),
    },
    {
      // Number of minimum-increment ticks in 1.0 of price (e.g. ES → 4,
      // ZN → 64). Reflects what the simulator actually used for this run,
      // including any manual override from the Fills & Costs panel.
      label: "Ticks / Point",
      value: fmtMeta(summary.ticksPerPoint),
      color: "text-foreground",
      tooltip: rawNum(summary.ticksPerPoint),
    },
    {
      label: "Win Rate",
      value: formatPercent(summary.winRate, false, 2),
      color: summary.winRate >= 0.5 ? "text-accent-green" : "text-accent-red",
      // Win rate is stored as a 0..1 decimal; show the raw percent on hover
      // so users can see e.g. 65.43219% rather than the rounded 65.4%.
      tooltip:
        summary.winRate == null ? "—" : `${(summary.winRate * 100).toString()}%`,
    },
    {
      label: `Avg ${unitLabel}`,
      value: fmt(avgVal),
      color: pnlColor(avgVal),
      tooltip: rawNum(avgVal),
    },
    {
      label: "Expectancy (EV)",
      value: fmt(evVal),
      color: pnlColor(evVal),
      tooltip: rawNum(evVal),
    },
    {
      // Expectancy normalized to 1 contract — each trade's contribution is
      // divided by its position size. When scaling is off this equals the
      // regular EV; when on, it reveals the strategy's underlying per-contract
      // EV so you can tell whether scaling is amplifying a good edge or just
      // levering up a mediocre one. Always shown in points (per-size dollar
      // EV would need per-trade pointValue accounting we don't track yet).
      label: "EV per Size",
      value: formatNumber(summary.expectancyPerSize, 3),
      color: pnlColor(summary.expectancyPerSize),
      tooltip: rawNum(summary.expectancyPerSize),
    },
    {
      label: `Total ${unitLabel}`,
      value: fmt(totalVal),
      color: pnlColor(totalVal),
      tooltip: rawNum(totalVal),
    },
    {
      // Sum of every winning trade's outcome.
      label: "Gross Profit",
      value: fmt(grossProfitVal),
      color: "text-accent-green",
      tooltip: rawNum(grossProfitVal),
    },
    {
      // Sum of every losing trade's outcome, expressed as a positive
      // magnitude (the amount given back).
      label: "Gross Loss",
      value: fmt(grossLossVal),
      color: "text-accent-red",
      tooltip: rawNum(grossLossVal),
    },
    {
      // Total commissions paid in dollars across all trades. Always
      // displayed in dollars regardless of the mode toggle since
      // commissions are a dollar-denominated cost.
      label: "Total Commissions",
      value: formatCurrency(summary.totalCommissions),
      color: summary.totalCommissions > 0 ? "text-accent-red" : "text-foreground",
      tooltip: rawNum(summary.totalCommissions),
    },
    {
      // Worst peak-to-trough drawdown on the cumulative equity curve.
      // Shown as a negative number in red so it reads as a loss at a
      // glance; the underlying SimSummary stores it as a positive
      // magnitude.
      label: "Max Drawdown",
      value: maxDdVal > 0 ? `-${fmt(maxDdVal)}` : fmt(0),
      color: maxDdVal > 0 ? "text-accent-red" : "text-foreground",
      tooltip: rawNum(-maxDdVal),
    },
    {
      // Daily EV — average per trading day (denominator = unique days
      // that produced at least one trade).
      label: "Daily EV",
      value: fmt(dailyEvVal),
      color: pnlColor(dailyEvVal),
      tooltip: rawNum(dailyEvVal),
    },
    {
      // Monthly EV — dailyEv extrapolated across a typical 21-trading-day
      // month. Useful for sizing expectations against monthly P&L goals
      // when the backtest spans only a partial month.
      label: "Monthly EV",
      value: fmt(monthlyEvVal),
      color: pnlColor(monthlyEvVal),
      tooltip: rawNum(monthlyEvVal),
    },
    {
      label: "Max Cons. Wins",
      value: formatNumber(summary.maxConsecutiveWinners, 0),
      color:
        summary.maxConsecutiveWinners > 0 ? "text-accent-green" : "text-foreground",
      tooltip: rawNum(summary.maxConsecutiveWinners),
    },
    {
      label: "Max Cons. Losses",
      value: formatNumber(summary.maxConsecutiveLosers, 0),
      color:
        summary.maxConsecutiveLosers > 0 ? "text-accent-red" : "text-foreground",
      tooltip: rawNum(summary.maxConsecutiveLosers),
    },
    {
      // Avg Trades / Hr — strategy frequency during active sessions. Total
      // trades divided by the sum of per-day windows (first start to last
      // exit each day). Tells the user how busy a given rule set keeps them
      // while they're trading, independent of how many days they ran it.
      label: "Trades / Hr",
      value: formatNumber(summary.avgTradesPerHour, 3),
      color: "text-foreground",
      tooltip: rawNum(summary.avgTradesPerHour),
    },
    {
      label: "Avg Win / Loss",
      value: fmtPair(avgWinVal, avgLossVal),
      color: "text-foreground",
      tooltip: `${rawNum(avgWinVal)} / ${rawNum(avgLossVal)}`,
    },
    {
      label: "Profit Factor",
      value:
        profitFactorVal === Infinity ? "∞" : formatNumber(profitFactorVal, 3),
      color: profitFactorVal >= 1 ? "text-accent-green" : "text-accent-red",
      tooltip: rawNum(profitFactorVal),
    },
    {
      label: "Avg Duration",
      value: `${formatNumber(summary.avgBarsHeld, 2)} bars`,
      color: "text-foreground",
      tooltip: `${rawNum(summary.avgBarsHeld)} bars`,
    },
    {
      label: "Best / Worst",
      value: fmtPair(bestVal, worstVal),
      color: "text-foreground",
      tooltip: `${rawNum(bestVal)} / ${rawNum(worstVal)}`,
    },
    {
      // Sharpe Ratio — per-trade risk-adjusted return (mean ÷ sample stdev)
      // for the original zone outcomes vs the sim-rule exits. Colored green
      // when the sim lifts the ratio vs the original, red when it drops it,
      // neutral on a tie. Lets the user tell whether a rule set is genuinely
      // improving the strategy's quality or just reshaping raw P&L without
      // improving the return/volatility tradeoff. Sharpe is unitless so it
      // doesn't change with the points/dollars toggle.
      label: "Sharpe (Orig / Sim)",
      value: `${formatNumber(summary.sharpeOriginal, 3)} / ${formatNumber(summary.sharpeSimulated, 3)}`,
      color:
        summary.sharpeSimulated > summary.sharpeOriginal
          ? "text-accent-green"
          : summary.sharpeSimulated < summary.sharpeOriginal
            ? "text-accent-red"
            : "text-foreground",
      tooltip: `${rawNum(summary.sharpeOriginal)} / ${rawNum(summary.sharpeSimulated)}`,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
      {cards.map((card) => (
        // Native `title` attribute drives the hover tooltip — shows the raw,
        // unrounded number(s) underlying the rounded card face. Cheap, keyboard-
        // and screen-reader-friendly, and works without any tooltip lib.
        <div
          key={card.label}
          title={`${card.label}: ${card.tooltip}`}
          className="bg-card border border-card-border rounded-lg p-4 cursor-help"
        >
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{card.label}</p>
          <p className={`text-lg font-semibold ${card.color}`}>{card.value}</p>
        </div>
      ))}
    </div>
  );
}
