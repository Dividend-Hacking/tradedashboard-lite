/**
 * Practice History Page (Server Component)
 *
 * Lists all practice sessions with summary stats. Links to individual
 * session reviews and shows aggregate performance metrics.
 */

import { getServerStore } from "@/lib/store/server";
import Link from "next/link";

export default async function PracticeHistoryPage() {
  const store = await getServerStore();

  let sessions;
  try {
    sessions = await store.practice.listSessions();
  } catch (err) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-accent-red">Failed to load history: {err instanceof Error ? err.message : String(err)}</p>
      </div>
    );
  }

  // Fetch all replay sessions to join by ID.
  const replaySessions = await store.replay.listSessions().catch(() => []);
  const replayMap = new Map(replaySessions.map((rs) => [rs.id, rs]));

  // Aggregate stats
  const totalSessions = sessions.length;
  const totalTrades = sessions.reduce((s, p) => s + p.total_trades, 0);
  const totalPnl = sessions.reduce((s, p) => s + Number(p.total_pnl_points), 0);
  const totalWins = sessions.reduce((s, p) => s + p.win_count, 0);
  const overallWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : "--";

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Practice History</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review your past practice sessions and track improvement
          </p>
        </div>
        <Link
          href="/replay"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; Back to Sessions
        </Link>
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <StatCard label="Sessions" value={totalSessions.toString()} />
        <StatCard label="Total Trades" value={totalTrades.toString()} />
        <StatCard
          label="Total P&L"
          value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`}
          color={totalPnl >= 0 ? "green" : "red"}
        />
        <StatCard label="Win Rate" value={`${overallWinRate}%`} />
      </div>

      {/* Session list */}
      {sessions.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No practice sessions yet</p>
          <p className="text-xs text-muted/60 mt-1">
            Complete a practice session in the replay tool and save it
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((ps) => {
            const replay = replayMap.get(ps.replay_session_id);
            return (
              <Link
                key={ps.id}
                href={`/replay/history/${ps.id}`}
                className="bg-card border border-card-border rounded-lg p-4 hover:border-muted
                           transition-colors flex items-center justify-between"
              >
                <div>
                  <span className="font-medium text-foreground">
                    {replay ? `${replay.instrument} — ${replay.timeframe}` : "Unknown Session"}
                  </span>
                  <span className="text-sm text-muted-foreground ml-3">
                    {replay?.session_date
                      ? new Date(replay.session_date + "T00:00:00").toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <span className="text-muted-foreground">
                    {ps.total_trades} trade{ps.total_trades !== 1 ? "s" : ""}
                  </span>
                  <span className="text-muted-foreground">
                    {ps.total_trades > 0
                      ? `${((ps.win_count / ps.total_trades) * 100).toFixed(0)}% WR`
                      : "--"}
                  </span>
                  <span
                    className={`font-mono font-medium ${
                      Number(ps.total_pnl_points) >= 0 ? "text-accent-green" : "text-accent-red"
                    }`}
                  >
                    {Number(ps.total_pnl_points) >= 0 ? "+" : ""}
                    {Number(ps.total_pnl_points).toFixed(2)} pts
                  </span>
                  <span className="text-xs text-muted/60">
                    {new Date(ps.created_at).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Simple stat card component */
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
      <div className={`text-xl font-bold font-mono ${valueColor}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
