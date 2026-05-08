/**
 * ZoneStatCards Component
 *
 * Displays 8 key trade zone metrics in a responsive 2x4 grid.
 * Mirrors the layout and styling of StatCards for trades.
 */

"use client";

import { ZoneSummaryStats } from "@/lib/utils/zone-stats";
import { formatNumber, formatPercent } from "@/lib/utils/format";

interface ZoneStatCardsProps {
  stats: ZoneSummaryStats;
}

/** Format seconds into a readable duration string (e.g. "2m 30s" or "45s") */
function formatDuration(seconds: number): string {
  if (seconds === 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

/** Pick green/red/neutral color based on value sign */
function pointsColor(value: number): string {
  if (value > 0) return "text-accent-green";
  if (value < 0) return "text-accent-red";
  return "text-foreground";
}

export function ZoneStatCards({ stats }: ZoneStatCardsProps) {
  const cards = [
    {
      label: "Total Zones",
      value: stats.totalZones.toString(),
      color: "text-foreground",
    },
    {
      label: "Win Rate",
      value: formatPercent(stats.winRate),
      color: stats.winRate >= 0.5 ? "text-accent-green" : "text-accent-red",
    },
    {
      label: "Avg Points",
      value: formatNumber(stats.avgPointsMove),
      color: pointsColor(stats.avgPointsMove),
    },
    {
      label: "Long / Short",
      value: `${stats.longZones} / ${stats.shortZones}`,
      color: "text-foreground",
    },
    {
      label: "Best Zone",
      value: `${formatNumber(stats.bestZonePoints)} pts`,
      color: "text-accent-green",
    },
    {
      label: "Worst Zone",
      value: `${formatNumber(stats.worstZonePoints)} pts`,
      color: "text-accent-red",
    },
    {
      label: "Avg ATR / ADX",
      value: `${formatNumber(stats.avgAtr)} / ${formatNumber(stats.avgAdx, 1)}`,
      color: "text-foreground",
    },
    {
      label: "Avg Duration",
      value: formatDuration(stats.avgDurationSeconds),
      color: "text-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
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
