/**
 * TabSwitcher Component (Client)
 *
 * Top-level navigation that switches between the Trades dashboard and the
 * Backtesting dashboard. Both dashboards are rendered but only the active
 * one is visible — this preserves each tab's internal state (filters, sort,
 * selections, fetched bars) when switching.
 */

"use client";

import { useState } from "react";
import { Trade } from "@/types/trade";
import { ReplaySession } from "@/types/replay";
import { Dashboard } from "./dashboard";
import { BacktestDashboard } from "./backtest-dashboard";

interface TabSwitcherProps {
  trades: Trade[];
  /** All replay_sessions (downloaded days), passed straight to the
   *  BacktestDashboard's day picker. */
  replaySessions: ReplaySession[];
}

const TABS = [
  { id: "trades", label: "Trades" },
  { id: "backtest", label: "Backtesting" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function TabSwitcher({ trades, replaySessions }: TabSwitcherProps) {
  const [activeTab, setActiveTab] = useState<TabId>("trades");

  return (
    <div className="min-h-screen p-4 md:p-8">
      {/* Tab header — title + tab buttons */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Trade Dashboard</h1>
        <div className="flex items-center gap-1 bg-card border border-card-border rounded-lg p-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.id
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content — use display:none to preserve state when switching */}
      <div style={{ display: activeTab === "trades" ? "block" : "none" }}>
        <Dashboard trades={trades} />
      </div>
      <div style={{ display: activeTab === "backtest" ? "block" : "none" }}>
        <BacktestDashboard sessions={replaySessions} />
      </div>
    </div>
  );
}
