"use client";

/**
 * AutoStatusBar
 *
 * Thin horizontal bar between the page header and the chart showing
 * everything the operator needs to monitor the engine at a glance:
 *
 *   - NT8 connection mode + live/stale status
 *   - Last bar age (with a yellow warning when bars stop arriving)
 *   - Last engine decision time
 *   - Engine-tracked open P&L on the active managed position
 *   - Bar count in the rolling buffer (reassures that the warmup is
 *     deep enough for the strategy's longest indicator window)
 *
 * Auto trading depends on the operator noticing problems FAST — the
 * status bar exists because waiting to see the activity log update or
 * the chart fall behind is too slow when something has broken.
 */

import { useEffect, useState, type MutableRefObject } from "react";
import type { AutoTraderState } from "@/lib/utils/auto-trader-engine";
import type { LiveState } from "@/types/live";

interface AutoStatusBarProps {
  engineState: AutoTraderState;
  livePosition: LiveState | null;
  lastPrice: number | null;
  /** Tick price ref — preferred over lastPrice for open-PnL display so the
   *  number updates at WS-tick rate, not the throttled 250ms React sync. */
  tickPriceRef?: MutableRefObject<number | null>;
  /** Epoch ms of the most recent bar arrival. Null until the first bar. */
  lastBarAt: number | null;
  wsConnected: boolean;
  connectionMode: "supabase" | "websocket";
  timeframe: string;
}

export default function AutoStatusBar({
  engineState,
  livePosition,
  lastPrice,
  tickPriceRef,
  lastBarAt,
  wsConnected,
  connectionMode,
  timeframe,
}: AutoStatusBarProps) {
  // Tick the bar-age counter every second so the displayed delta stays
  // current even when no new bars are arriving (the stalling case is
  // exactly when this is most useful).
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const barAgeSec = lastBarAt ? Math.floor((now - lastBarAt) / 1000) : null;
  // Bar age is "stale" when it exceeds 2× the timeframe duration — gives
  // a normal in-progress bar plenty of room before flagging.
  const expectedBarSec = timeframeToSeconds(timeframe);
  const barIsStale = barAgeSec != null && barAgeSec > expectedBarSec * 2;

  // Active managed entry's open P&L — same calc the command center does,
  // duplicated here so the status bar stays self-contained. Reads tick ref
  // when available for sub-frame freshness.
  const ae = engineState.activeEntry;
  let openPnl: number | null = null;
  const price = tickPriceRef?.current ?? lastPrice;
  if (ae && livePosition?.position_direction && price != null) {
    const isLong = ae.direction === "Long";
    openPnl = isLong ? price - ae.entryPrice : ae.entryPrice - price;
  }

  // Last decision time = ts of the most recent log entry. The engine logs
  // on every signal/filter/trade event, so this number ticks even when
  // signals are being filtered out (proves the engine is still alive).
  const lastLogTs = engineState.log.at(-1)?.ts ?? null;
  const decisionAgeSec = lastLogTs ? Math.floor((now - lastLogTs) / 1000) : null;

  return (
    <div className="bg-card border border-card-border rounded-lg px-3 py-2 flex items-center gap-4 text-[11px]">
      <Cell
        label="Conn"
        value={connectionMode === "websocket" ? (wsConnected ? "WS" : "WS off") : "SB"}
        tone={connectionMode === "websocket" && !wsConnected ? "bad" : "good"}
      />
      <Cell
        label="Bar age"
        value={barAgeSec == null ? "—" : `${barAgeSec}s`}
        tone={barIsStale ? "bad" : barAgeSec != null && barAgeSec > expectedBarSec ? "warn" : "good"}
      />
      <Cell
        label="Last decision"
        value={decisionAgeSec == null ? "—" : `${decisionAgeSec}s ago`}
      />
      {ae ? (
        <Cell
          label="Open P&L"
          value={openPnl == null ? "—" : `${openPnl >= 0 ? "+" : ""}${openPnl.toFixed(2)} pts`}
          tone={openPnl == null ? "neutral" : openPnl > 0 ? "good" : openPnl < 0 ? "bad" : "neutral"}
        />
      ) : (
        <Cell label="Open P&L" value="flat" />
      )}
      <Cell label="Day P&L" value={`${engineState.dailyRealizedPoints >= 0 ? "+" : ""}${engineState.dailyRealizedPoints.toFixed(2)}`}
        tone={engineState.dailyRealizedPoints > 0 ? "good" : engineState.dailyRealizedPoints < 0 ? "bad" : "neutral"} />
      <Cell label="Next qty" value={String(engineState.nextEntrySize)} />
      <Cell label="Halted" value={engineState.dailyHalted ? "YES" : "no"}
        tone={engineState.dailyHalted ? "bad" : "good"} />
      {engineState.preset && (
        <div className="ml-auto text-muted-foreground/60 text-[10px] truncate max-w-[280px]">
          {engineState.preset.name} · {engineState.preset.strategyId}
        </div>
      )}
    </div>
  );
}

function timeframeToSeconds(tf: string): number {
  switch (tf) {
    case "15 Second": return 15;
    case "1 Minute":  return 60;
    case "5 Minute":  return 300;
    case "15 Minute": return 900;
    default:          return 60;
  }
}

function Cell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "warn" | "neutral";
}) {
  const toneClass =
    tone === "good" ? "text-accent-green"
      : tone === "bad" ? "text-accent-red"
      : tone === "warn" ? "text-accent-yellow"
      : "text-foreground";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground/60 uppercase text-[10px]">{label}</span>
      <span className={`font-mono font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}
