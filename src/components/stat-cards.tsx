/**
 * StatCards Component
 *
 * Displays 8 key trading metrics in a responsive 2x4 grid.
 * Values are conditionally colored green (positive) or red (negative)
 * to provide instant visual feedback on performance.
 */

"use client";

import { SummaryStats } from "@/lib/utils/trade-stats";
import { formatCurrency, formatPercent } from "@/lib/utils/format";

interface StatCardsProps {
  stats: SummaryStats;
}

/** Helper to pick green/red/neutral color based on value sign */
function pnlColor(value: number): string {
  if (value > 0) return "text-accent-green";
  if (value < 0) return "text-accent-red";
  return "text-foreground";
}

export function StatCards({ stats }: StatCardsProps) {
  // Define the 8 stat cards with their labels and formatted values
  const cards = [
    {
      label: "Total P&L",
      value: formatCurrency(stats.totalPnl),
      color: pnlColor(stats.totalPnl),
    },
    {
      label: "Win Rate",
      value: formatPercent(stats.winRate),
      color: stats.winRate >= 0.5 ? "text-accent-green" : "text-accent-red",
    },
    {
      label: "Total Trades",
      value: stats.totalTrades.toString(),
      color: "text-foreground",
    },
    {
      label: "Avg Win R:R",
      value: stats.avgWinRR.toFixed(2),
      color: pnlColor(stats.avgWinRR),
    },
    {
      label: "Profit Factor",
      value: stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2),
      color: stats.profitFactor >= 1 ? "text-accent-green" : "text-accent-red",
    },
    {
      label: "Best Trade",
      value: formatCurrency(stats.bestTrade),
      color: "text-accent-green",
    },
    {
      label: "Worst Trade",
      value: formatCurrency(stats.worstTrade),
      color: "text-accent-red",
    },
    {
      label: "Avg Win / Loss",
      value: `${formatCurrency(stats.avgWin)} / ${formatCurrency(stats.avgLoss)}`,
      color: "text-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-card border border-card-border rounded-lg p-4"
        >
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            {card.label}
          </p>
          <p className={`text-lg font-semibold ${card.color}`}>{card.value}</p>
        </div>
      ))}
    </div>
  );
}
