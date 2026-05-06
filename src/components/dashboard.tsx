/**
 * Dashboard Component (Client)
 *
 * Main orchestrator for the trade dashboard. Owns all filter state
 * (account, date range) and derives filtered trades, summary stats,
 * and chart data via useMemo for efficient re-renders.
 *
 * Composes: FilterBar, StatCards, EquityCurve, PnlByDay,
 * WinLossDistribution, and TradeTable.
 */

"use client";

import { useState, useMemo, useEffect } from "react";
import { Trade } from "@/types/trade";
import { rawDateString } from "@/lib/utils/format";
import { createClient } from "@/lib/supabase/client";
import {
  computeSummaryStats,
  buildEquityCurve,
  buildTradePnl,
  buildWinLossData,
  buildPnlByTimeOfDay,
  buildPnlByDirection,
  buildPnlByAtr,
  buildPnlByAdx,
  buildPnlByBollingerPos,
  buildPnlByEma,
  buildPnlByTradeRegime,
  buildPnlByMarketRegime,
  buildPnlByTradeGrade,
} from "@/lib/utils/trade-stats";
import { FilterBar } from "./filter-bar";
import { StatCards } from "./stat-cards";
import { EquityCurve } from "./charts/equity-curve";
import { PnlByDay } from "./charts/pnl-by-day";
import { WinLossDistribution } from "./charts/win-loss-distribution";
import { TradeTable } from "./trade-table";
import { PnlByCategory } from "./charts/pnl-by-category";
import { RMultipleHistogram } from "./charts/r-multiple-histogram";
import { deleteTrades } from "@/app/actions";

interface DashboardProps {
  trades: Trade[];
}

export function Dashboard({ trades: initialTrades }: DashboardProps) {
  // --- Local trades state for optimistic deletion ---
  const [trades, setTrades] = useState<Trade[]>(initialTrades);

  // --- Selection state for multi-select deletion ---
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // --- Global time mode toggle ---
  // "trade" = playback bar timestamps (entry_time/exit_time) — default
  // "real"  = wall-clock timestamps (real_entry_time/real_exit_time), with graceful fallback
  // Affects date filtering, chart ordering, time-of-day grouping, and table date columns.
  const [timeMode, setTimeMode] = useState<"trade" | "real">("trade");

  // --- Regime chart toggle: "manual" uses trade_regime, "auto" uses ctx_market_regime ---
  const [regimeSource, setRegimeSource] = useState<"manual" | "auto">("manual");

  // --- EMA chart toggle: switch between EMA20 (short-term) and EMA200 (long-term) ---
  const [emaSource, setEmaSource] = useState<"ema20" | "ema200">("ema20");

  // --- Per-chart toggle for including trades with null context data as "N/A" ---
  const [showNulls, setShowNulls] = useState<Record<string, boolean>>({});

  // --- Filter State ---
  const [account, setAccount] = useState<string>("All");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  // --- Realtime subscription: keep trades state live via Supabase Realtime ---
  // Subscribes once on mount, handles INSERT/UPDATE/DELETE, and cleans up on unmount.
  // Supabase Realtime must be enabled for the `trades` table in the Supabase dashboard.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("trades-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            // Append new trade and keep sorted by entry_time ascending
            setTrades((prev) =>
              [...prev, payload.new as Trade].sort(
                (a, b) =>
                  new Date(a.entry_time).getTime() -
                  new Date(b.entry_time).getTime()
              )
            );
          } else if (payload.eventType === "UPDATE") {
            // Replace the matching trade in state (matched by id)
            setTrades((prev) =>
              prev.map((t) =>
                t.id === (payload.new as Trade).id
                  ? (payload.new as Trade)
                  : t
              )
            );
          } else if (payload.eventType === "DELETE") {
            // Remove the deleted trade from state (matched by id)
            setTrades((prev) =>
              prev.filter((t) => t.id !== (payload.old as Trade).id)
            );
          }
        }
      )
      .subscribe((status, err) => {
        // Log subscription status for debugging realtime connectivity
        if (err) console.error("Realtime subscription error:", err);
        else console.log("Realtime status:", status);
      });

    // Cleanup: unsubscribe channel when component unmounts
    return () => {
      supabase.removeChannel(channel);
    };
  }, []); // empty dep array — subscribe once on mount

  // --- Derive unique account names from the full dataset ---
  const accounts = useMemo(() => {
    const names = new Set(
      trades.map((t) => t.account_name).filter(Boolean) as string[]
    );
    return ["All", ...Array.from(names).sort()];
  }, [trades]);

  /**
   * Creates a toggle button (eye icon) for showing/hiding trades with null data.
   * Eye open = nulls visible, eye with slash = nulls hidden (default).
   */
  function nullToggleButton(chartKey: string) {
    const active = showNulls[chartKey] ?? false;
    return (
      <button
        onClick={() =>
          setShowNulls((prev) => ({ ...prev, [chartKey]: !prev[chartKey] }))
        }
        title="Show/hide trades with missing data"
        className={`p-1 rounded transition-colors ${
          active
            ? "text-white bg-white/10"
            : "text-muted-foreground hover:text-white"
        }`}
      >
        {/* Inline eye SVG — slash line added when inactive */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
          {!active && <line x1="1" y1="1" x2="23" y2="23" />}
        </svg>
      </button>
    );
  }

  /**
   * Resolve the entry timestamp for a trade based on the current timeMode.
   * Falls back to entry_time when real_entry_time is null (e.g. non-playback trades).
   */
  const entryTime = (t: Trade) =>
    timeMode === "real" ? (t.real_entry_time ?? t.entry_time) : t.entry_time;

  // --- Apply filters to get the working dataset ---
  // Date comparison uses entryTime() so the filter respects the global time mode toggle.
  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      // Account filter
      if (account !== "All" && t.account_name !== account) return false;

      // Date range filter (compare date portion only, using the active time source)
      const tradeDate = rawDateString(entryTime(t));
      if (startDate && tradeDate < startDate) return false;
      if (endDate && tradeDate > endDate) return false;

      return true;
    });
  }, [trades, account, startDate, endDate, timeMode]);

  // --- Compute all derived data from filtered trades ---
  const stats = useMemo(() => computeSummaryStats(filteredTrades), [filteredTrades]);
  // Pass timeMode so charts sort/group by the active time source
  const equityCurve = useMemo(() => buildEquityCurve(filteredTrades, timeMode), [filteredTrades, timeMode]);
  const tradePnl = useMemo(() => buildTradePnl(filteredTrades, timeMode), [filteredTrades, timeMode]);
  const winLossData = useMemo(() => buildWinLossData(filteredTrades), [filteredTrades]);

  // --- P&L breakdown by category charts (showNulls toggles N/A group per chart) ---
  const pnlByTimeOfDay = useMemo(() => buildPnlByTimeOfDay(filteredTrades, timeMode), [filteredTrades, timeMode]);
  const pnlByDirection = useMemo(() => buildPnlByDirection(filteredTrades), [filteredTrades]);
  const pnlByAtr = useMemo(() => buildPnlByAtr(filteredTrades), [filteredTrades]);
  const pnlByAdx = useMemo(() => buildPnlByAdx(filteredTrades), [filteredTrades]);
  const pnlByBollinger = useMemo(() => buildPnlByBollingerPos(filteredTrades, showNulls["bollinger"]), [filteredTrades, showNulls]);
  const pnlByEma = useMemo(() => buildPnlByEma(filteredTrades, showNulls["ema"], emaSource), [filteredTrades, showNulls, emaSource]);
  const pnlByRegime = useMemo(() => buildPnlByTradeRegime(filteredTrades, showNulls["regime"]), [filteredTrades, showNulls]);
  const pnlByMarketRegime = useMemo(() => buildPnlByMarketRegime(filteredTrades, showNulls["regime"]), [filteredTrades, showNulls]);
  const pnlByGrade = useMemo(() => buildPnlByTradeGrade(filteredTrades, showNulls["grade"]), [filteredTrades, showNulls]);

  /**
   * Toggle a single trade's selection state.
   * Adds the ID if not selected, removes it if already selected.
   */
  function handleToggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  /**
   * Toggle all visible (filtered) trades on or off.
   * If all filtered trades are selected, deselects all. Otherwise selects all.
   */
  function handleToggleAll() {
    const allFilteredIds = filteredTrades.map((t) => t.id);
    const allSelected = allFilteredIds.every((id) => selectedIds.has(id));

    if (allSelected) {
      // Deselect all filtered trades
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allFilteredIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      // Select all filtered trades
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allFilteredIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }

  /**
   * Delete all selected trades after user confirmation.
   * Calls the server action, then optimistically removes deleted rows
   * from local state so stats/charts recompute immediately.
   */
  async function handleDelete() {
    const count = selectedIds.size;
    if (count === 0) return;

    // Confirmation dialog showing how many trades will be deleted
    const confirmed = confirm(
      `Are you sure you want to delete ${count} trade${count > 1 ? "s" : ""}? This cannot be undone.`
    );
    if (!confirmed) return;

    const idsToDelete = Array.from(selectedIds);
    const result = await deleteTrades(idsToDelete);

    if (result.success) {
      // Remove deleted trades from local state — stats/charts auto-update via useMemo
      setTrades((prev) => prev.filter((t) => !selectedIds.has(t.id)));
      setSelectedIds(new Set());
    } else {
      alert(`Failed to delete trades: ${result.error}`);
    }
  }

  return (
    <div>
      {/* Time mode toggle */}
      <div className="flex items-center justify-end mb-4">
        <div className="flex items-center gap-1 text-xs">
          {(["trade", "real"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setTimeMode(mode)}
              className={`px-2 py-1 rounded font-medium transition-colors ${
                timeMode === mode
                  ? "text-white bg-white/10"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              {mode === "trade" ? "Trade Time" : "Real Time"}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <FilterBar
        accounts={accounts}
        account={account}
        onAccountChange={setAccount}
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
      />

      {/* Summary Stat Cards */}
      <StatCards stats={stats} />

      {/* Charts Row — equity curve and per-trade P&L side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <EquityCurve data={equityCurve} />
        <PnlByDay data={tradePnl} />
      </div>

      {/* R-Multiple histogram and Win/Loss pie chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <RMultipleHistogram trades={filteredTrades} />
        <WinLossDistribution data={winLossData} />
      </div>

      {/* P&L Breakdown Charts — 2-column grid of category bar charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <PnlByCategory title="P&L by Time of Day" data={pnlByTimeOfDay} />
        <PnlByCategory title="P&L by Direction" data={pnlByDirection} />
        <PnlByCategory title="P&L by ATR Range" data={pnlByAtr} />
        <PnlByCategory title="P&L by ADX Range" data={pnlByAdx} />
        <PnlByCategory title="P&L by Bollinger Position" data={pnlByBollinger} headerRight={nullToggleButton("bollinger")} />
        <PnlByCategory
          title={emaSource === "ema20" ? "P&L by EMA20 Position" : "P&L by EMA200 Position"}
          data={pnlByEma}
          headerRight={
            <>
              {/* EMA20 toggle button — short-term trend */}
              <button
                onClick={() => setEmaSource("ema20")}
                title="EMA20 (short-term)"
                className={`px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
                  emaSource === "ema20"
                    ? "text-white bg-white/10"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                20
              </button>
              {/* EMA200 toggle button — long-term trend */}
              <button
                onClick={() => setEmaSource("ema200")}
                title="EMA200 (long-term)"
                className={`px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
                  emaSource === "ema200"
                    ? "text-white bg-white/10"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                200
              </button>
              {/* Eye icon — show/hide null data trades */}
              {nullToggleButton("ema")}
            </>
          }
        />
        <PnlByCategory
          title={regimeSource === "manual" ? "P&L by Trade Regime" : "P&L by Market Regime (Auto)"}
          data={regimeSource === "manual" ? pnlByRegime : pnlByMarketRegime}
          headerRight={
            <>
              {/* Pencil icon — manual regime toggle */}
              <button
                onClick={() => setRegimeSource("manual")}
                title="Manual regime (trade_regime)"
                className={`p-1 rounded transition-colors ${
                  regimeSource === "manual"
                    ? "text-white bg-white/10"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
              {/* Robot icon — auto-detected regime toggle */}
              <button
                onClick={() => setRegimeSource("auto")}
                title="Auto regime (ctx_market_regime)"
                className={`p-1 rounded transition-colors ${
                  regimeSource === "auto"
                    ? "text-white bg-white/10"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2" />
                  <circle cx="12" cy="5" r="2" />
                  <path d="M12 7v4" />
                  <line x1="8" y1="16" x2="8" y2="16" />
                  <line x1="16" y1="16" x2="16" y2="16" />
                </svg>
              </button>
              {/* Eye icon — show/hide null data trades */}
              {nullToggleButton("regime")}
            </>
          }
        />
        <PnlByCategory title="P&L by Trade Grade" data={pnlByGrade} headerRight={nullToggleButton("grade")} />
      </div>

      {/* Full trade table with sorting, multi-select, and delete */}
      <TradeTable
        trades={filteredTrades}
        selectedIds={selectedIds}
        onToggleSelect={handleToggleSelect}
        onToggleAll={handleToggleAll}
        onDelete={handleDelete}
        timeMode={timeMode}
      />
    </div>
  );
}
