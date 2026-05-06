"use client";

/**
 * PracticeSessionDetail — Read-only review of a completed practice session.
 *
 * Shows the full replay chart with all trade entry/exit markers,
 * session stats, and a trade-by-trade breakdown.
 */

import { useMemo } from "react";
import Link from "next/link";
import { ReplaySession, ReplayBar, PracticeSession, PracticeTrade } from "@/types/replay";
import { PracticePosition } from "@/lib/utils/practice-trading";
import ReplayChart from "./replay-chart";

interface PracticeSessionDetailProps {
  practiceSession: PracticeSession;
  replaySession: ReplaySession;
  bars: ReplayBar[];
  trades: PracticeTrade[];
}

export default function PracticeSessionDetail({
  practiceSession,
  replaySession,
  bars,
  trades,
}: PracticeSessionDetailProps) {
  const ps = practiceSession;

  // Convert PracticeTrade DB records to PracticePosition format for the chart
  const positions: PracticePosition[] = useMemo(
    () =>
      trades.map((t) => ({
        id: t.id.toString(),
        direction: t.direction,
        entryPrice: t.entry_price,
        entryBarIndex: t.entry_bar_index,
        entryTime: t.entry_time,
        stopLossPrice: t.stop_loss_price,
        takeProfitPrice: t.take_profit_price,
        status: "closed" as const,
        exitPrice: t.exit_price ?? undefined,
        exitBarIndex: t.exit_bar_index ?? undefined,
        exitTime: t.exit_time ?? undefined,
        exitReason: t.exit_reason ?? undefined,
        pnlPoints: t.pnl_points ?? undefined,
      })),
    [trades]
  );

  const winRate =
    ps.total_trades > 0 ? ((ps.win_count / ps.total_trades) * 100).toFixed(0) : "--";

  // Calculate average win and average loss
  const wins = trades.filter((t) => (t.pnl_points ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl_points ?? 0) < 0);
  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + (t.pnl_points ?? 0), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + (t.pnl_points ?? 0), 0) / losses.length)
    : 0;
  const profitFactor = avgLoss > 0 && wins.length > 0
    ? ((wins.reduce((s, t) => s + (t.pnl_points ?? 0), 0)) /
       Math.abs(losses.reduce((s, t) => s + (t.pnl_points ?? 0), 0))).toFixed(2)
    : "--";

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/replay/history"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back
          </Link>
          <div>
            <h2 className="text-lg font-bold text-foreground">
              {replaySession.instrument} — {replaySession.timeframe}
            </h2>
            <p className="text-sm text-muted-foreground">
              {new Date(replaySession.session_date + "T00:00:00").toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
              {" — practiced "}
              {new Date(ps.created_at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-6 gap-3">
        <StatCard
          label="P&L"
          value={`${Number(ps.total_pnl_points) >= 0 ? "+" : ""}${Number(ps.total_pnl_points).toFixed(2)}`}
          color={Number(ps.total_pnl_points) >= 0 ? "green" : "red"}
        />
        <StatCard label="Trades" value={ps.total_trades.toString()} />
        <StatCard label="Win Rate" value={`${winRate}%`} />
        <StatCard label="Avg Win" value={`+${avgWin.toFixed(2)}`} color="green" />
        <StatCard label="Avg Loss" value={`-${avgLoss.toFixed(2)}`} color="red" />
        <StatCard label="Profit Factor" value={profitFactor.toString()} />
      </div>

      {/* Chart — full session with all trade markers */}
      <div className="h-[500px]">
        <ReplayChart
          visibleBars={bars}
          positions={positions}
          openPosition={null}
        />
      </div>

      {/* Trade list */}
      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border">
          <h3 className="text-sm font-medium text-foreground">Trades</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-card-border">
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Direction</th>
              <th className="px-4 py-2 text-right">Entry</th>
              <th className="px-4 py-2 text-right">Exit</th>
              <th className="px-4 py-2 text-right">SL</th>
              <th className="px-4 py-2 text-right">TP</th>
              <th className="px-4 py-2 text-center">Exit Reason</th>
              <th className="px-4 py-2 text-right">P&L</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const pnl = t.pnl_points ?? 0;
              return (
                <tr key={t.id} className="border-b border-card-border/50 hover:bg-background/50">
                  <td className="px-4 py-2 text-muted/60">{i + 1}</td>
                  <td className={`px-4 py-2 ${t.direction === "Long" ? "text-accent-green" : "text-accent-red"}`}>
                    {t.direction}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{t.entry_price.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {t.exit_price?.toFixed(2) ?? "--"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-muted/60">
                    {t.stop_loss_price?.toFixed(2) ?? "--"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-muted/60">
                    {t.take_profit_price?.toFixed(2) ?? "--"}
                  </td>
                  <td className="px-4 py-2 text-center text-muted-foreground capitalize">
                    {t.exit_reason ?? "--"}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono font-medium ${
                    pnl >= 0 ? "text-accent-green" : "text-accent-red"
                  }`}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: "green" | "red";
}) {
  const valueColor =
    color === "green"
      ? "text-accent-green"
      : color === "red"
        ? "text-accent-red"
        : "text-foreground";

  return (
    <div className="bg-card border border-card-border rounded-lg p-3 text-center">
      <div className={`text-lg font-bold font-mono ${valueColor}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
