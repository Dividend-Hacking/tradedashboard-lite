/**
 * SimulatorTable — Per-zone detail table showing simulation results.
 * Shows exit reason, points comparison, bars held, and peak MFE.
 * Click a row to expand an inline candlestick chart showing the trade bar-by-bar.
 */

"use client";

import React, { useState, useMemo } from "react";
import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimZoneResult, SimRules, ExitReason, computeTrailPath } from "@/lib/utils/zone-simulator";
import { formatDate, formatTime, formatNumber } from "@/lib/utils/format";
import { ZoneCandlestickChart } from "./charts/zone-candlestick-chart";

interface SimulatorTableProps {
  results: SimZoneResult[];
  zones: TradeZone[];
  barsByZoneId: Map<number, TradeZoneBar[]>;
  // Pre-entry context bars pulled from replay_bars by SimulatorPanel. These
  // are bars BEFORE zone.start_time, used purely to give the per-trade chart
  // a setup window leading into the entry. Never fed to the simulator walk.
  // Optional / nullable — when absent the chart falls back to zone-only bars.
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  // Post-exit context bars pulled from replay_bars by SimulatorPanel. These
  // are bars AFTER zone.end_time (the always-pre-fetched extension bars,
  // independent of the simulator's "Extend Bars" rule). Used purely to give
  // the per-trade chart a 30-bar aftermath window past the simulated exit.
  // Optional / nullable — when absent the chart simply omits the post-exit
  // window for any zone with no replay match.
  postExitBarsByZoneId?: Map<number, TradeZoneBar[]> | null;
  rules: SimRules;
  // Per-zone ATR(14) at entry. Optional — when present and rules.atrModeEnabled
  // is on, computeTrailPath uses each zone's ATR to draw the correct SL/TP/trail
  // overlay levels on the inline candlestick chart.
  atrByZoneId?: Map<number, number> | null;
}

/** Color-coded exit reason badge */
const REASON_LABELS: Record<ExitReason, { label: string; color: string }> = {
  tp: { label: "TP", color: "bg-accent-green/20 text-accent-green" },
  sl: { label: "SL", color: "bg-accent-red/20 text-accent-red" },
  trail: { label: "Trail", color: "bg-yellow-500/20 text-yellow-400" },
  be: { label: "BE", color: "bg-blue-500/20 text-blue-400" },
  timer: { label: "Timer", color: "bg-purple-500/20 text-purple-400" },
  end: { label: "End", color: "bg-white/10 text-muted-foreground" },
  // Closed early because the next position opened (position-mode override)
  next: { label: "Next", color: "bg-orange-500/20 text-orange-400" },
  // Force-closed by the daily-limit exact-mode kill switch
  daily: { label: "Daily", color: "bg-pink-500/20 text-pink-400" },
  // Closed by an `exit.if[.long|.short]` boolean expression — user-
  // written signal exit. Cyan distinguishes it from the OHLC-driven
  // exits (SL/TP/trail/BE) and from the time/regime exits.
  signal: { label: "Signal", color: "bg-cyan-500/20 text-cyan-400" },
};

export function SimulatorTable({
  results,
  zones,
  barsByZoneId,
  preEntryBarsByZoneId,
  postExitBarsByZoneId,
  rules,
  atrByZoneId,
}: SimulatorTableProps) {
  const [expandedZoneId, setExpandedZoneId] = useState<number | null>(null);
  // Collapse state for the entire table — defaults to expanded to preserve
  // the existing behavior. When collapsed, the header bar stays visible so
  // the user can re-expand and the trade count is still legible at a glance.
  const [collapsed, setCollapsed] = useState(false);

  // Build a lookup map for zones by id
  const zonesById = useMemo(() => {
    const map = new Map<number, TradeZone>();
    for (const z of zones) map.set(z.id, z);
    return map;
  }, [zones]);

  if (results.length === 0) return null;

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className={`w-full flex items-center justify-between px-4 py-3 ${
          collapsed ? "" : "border-b border-card-border"
        } hover:bg-white/5 transition-colors`}
        aria-expanded={!collapsed}
      >
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          Simulation Results ({results.length} trades)
        </h3>
        {/* Chevron rotates 90° when expanded so the affordance reads as
            "click to fold/unfold". Pure CSS — no extra deps. */}
        <svg
          className={`w-4 h-4 text-muted-foreground transition-transform ${
            collapsed ? "" : "rotate-90"
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {!collapsed && (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-card-border">
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Date</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Dir</th>
              {/* ATR(14) at entry — computed from replay_bars by fetchZoneAtr.
                  "—" when a zone has no replay match and ATR couldn't be computed. */}
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase" title="ATR(14) computed at zone entry from replay_bars history">ATR</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Original</th>
              {/* Size column only when scaling is on — keeps the default view
                  unchanged when every trade is 1 contract. */}
              {rules.scalingEnabled && (
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Size</th>
              )}
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Simulated</th>
              <th className="px-4 py-2 text-center text-xs font-medium text-muted-foreground uppercase">Exit</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Bars</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Peak MFE</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Max DD</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const badge = REASON_LABELS[r.exitReason];
              const flipped =
                (r.originalPoints > 0 && r.exitPoints <= 0) ||
                (r.originalPoints <= 0 && r.exitPoints > 0);
              const isExpanded = expandedZoneId === r.zoneId;
              const zone = zonesById.get(r.zoneId);
              const zoneBars = barsByZoneId.get(r.zoneId);

              return (
                <React.Fragment key={r.zoneId}>
                  {/* Data row */}
                  <tr
                    onClick={() => setExpandedZoneId(isExpanded ? null : r.zoneId)}
                    className={`border-b border-card-border/50 transition-colors cursor-pointer ${
                      isExpanded ? "bg-white/[0.04]" : flipped ? "bg-yellow-500/5" : "hover:bg-white/[0.02]"
                    }`}
                  >
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDate(r.startTime)}{" "}
                      <span className="text-muted-foreground">{formatTime(r.startTime)}</span>
                    </td>
                    <td className={`px-4 py-2 ${r.direction === "Long" ? "text-accent-green" : "text-accent-red"}`}>
                      {r.direction}
                    </td>
                    {/* ATR(14) at entry for this zone. Absent from the map =
                        couldn't compute (no replay match) → render a dash. */}
                    <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                      {(() => {
                        const atr = atrByZoneId?.get(r.zoneId);
                        return atr != null ? formatNumber(atr) : "—";
                      })()}
                    </td>
                    <td className={`px-4 py-2 text-right ${r.originalPoints > 0 ? "text-accent-green" : r.originalPoints < 0 ? "text-accent-red" : "text-foreground"}`}>
                      {r.originalPoints > 0 ? "+" : ""}{formatNumber(r.originalPoints)}
                    </td>
                    {/* Position size from the scaling modifier — only rendered
                        when scaling is enabled (column header is gated too). */}
                    {rules.scalingEnabled && (
                      <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                        ×{formatNumber(r.positionSize)}
                      </td>
                    )}
                    {/* Simulated column shows the scaled result — matches the
                        summary/equity curve totals. When scaling is off,
                        scaledPoints === exitPoints so this is unchanged from
                        before. Hover shows per-contract points for reference. */}
                    <td
                      className={`px-4 py-2 text-right font-medium ${r.scaledPoints > 0 ? "text-accent-green" : r.scaledPoints < 0 ? "text-accent-red" : "text-foreground"}`}
                      title={rules.scalingEnabled ? `Per-contract: ${r.exitPoints > 0 ? "+" : ""}${formatNumber(r.exitPoints)} pts × ${formatNumber(r.positionSize)} size` : undefined}
                    >
                      {r.scaledPoints > 0 ? "+" : ""}{formatNumber(r.scaledPoints)}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.color}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{r.barsHeld}</td>
                    <td className="px-4 py-2 text-right text-accent-green">+{formatNumber(r.peakMfe)}</td>
                    <td className="px-4 py-2 text-right text-accent-red">{formatNumber(r.maxDrawdown)}</td>
                  </tr>
                  {/* Expanded candlestick chart row */}
                  {isExpanded && zone && zoneBars && zoneBars.length > 0 && (
                    <tr className="border-b border-card-border/50 bg-white/[0.02]">
                      <td colSpan={rules.scalingEnabled ? 10 : 9}>
                        <ZoneCandlestickChart
                          bars={zoneBars}
                          // Pre-entry context bars from replay_bars (may be
                          // empty if no replay session matched this zone).
                          // The chart prepends them so the user sees ~30 bars
                          // of setup before the entry arrow.
                          preEntryBars={preEntryBarsByZoneId?.get(r.zoneId) ?? []}
                          // Post-exit context bars from replay_bars (the
                          // pre-fetched extension bars — independent of the
                          // "Extend Bars" simulator rule). The chart appends
                          // them so the user sees ~30 bars AFTER the exit
                          // marker, mirroring the pre-entry window.
                          postExitBars={postExitBarsByZoneId?.get(r.zoneId) ?? []}
                          entryPrice={zone.start_price}
                          direction={zone.direction}
                          rules={rules}
                          simResult={r}
                          trailPath={computeTrailPath(zone, zoneBars, rules, r, atrByZoneId?.get(zone.id) ?? null)}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
