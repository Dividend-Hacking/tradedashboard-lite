"use client";

/**
 * AutoActivityLog
 *
 * Full-height feed of every event the engine emits — signals, filters,
 * fills, exits, BE moves, daily-halt warnings, errors. The /trade page
 * had this stuffed in a 200-pixel sidebar; here we give it the full
 * remaining vertical space because for an auto trader the log IS the
 * UI — it's how you know what's happening when you're not staring at
 * the chart.
 *
 * Filtering: the engine tags each entry with one of five levels
 * (info, signal, trade, warn, error). The user can hide any level via
 * the toggle row at the top — useful when the chart's chatter (per-bar
 * "filtered out" entries) drowns out the trade events you care about.
 */

import { useMemo, useState } from "react";
import type { LogEntry } from "@/lib/utils/auto-trader-engine";

interface AutoActivityLogProps {
  log: LogEntry[];
}

type LevelKey = "info" | "signal" | "trade" | "warn" | "error";

const LEVELS: { key: LevelKey; label: string; tone: string }[] = [
  { key: "trade", label: "Trade", tone: "text-accent-green" },
  { key: "signal", label: "Signal", tone: "text-foreground/80" },
  { key: "warn", label: "Warn", tone: "text-accent-yellow" },
  { key: "error", label: "Error", tone: "text-accent-red" },
  { key: "info", label: "Info", tone: "text-muted-foreground" },
];

export default function AutoActivityLog({ log }: AutoActivityLogProps) {
  // Filters are stored as a Set for O(1) inclusion checks. All levels are
  // on by default — the user has to opt out of noisy ones.
  const [hidden, setHidden] = useState<Set<LevelKey>>(new Set());

  const toggle = (key: LevelKey) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Newest first for easier scanning while live. We also slice down to
  // the last 200 entries even though the engine only keeps 50 — this
  // bound is a defense-in-depth measure in case the engine cap is ever
  // raised.
  const visible = useMemo(() => {
    return [...log].reverse().filter((e) => !hidden.has(e.level as LevelKey)).slice(0, 200);
  }, [log, hidden]);

  return (
    <div className="bg-card border border-card-border rounded-lg p-3 flex flex-col gap-2 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
          Activity
        </h3>
        <span className="text-[10px] text-muted-foreground">
          {visible.length} {visible.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Level toggles — click to hide that level. */}
      <div className="flex flex-wrap gap-1">
        {LEVELS.map((lvl) => {
          const isHidden = hidden.has(lvl.key);
          return (
            <button
              key={lvl.key}
              onClick={() => toggle(lvl.key)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                isHidden
                  ? "bg-white/5 text-muted-foreground/40 line-through"
                  : `bg-white/5 ${lvl.tone} hover:bg-white/10`
              }`}
            >
              {lvl.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-black/20 rounded p-2 text-[11px] font-mono space-y-0.5">
        {visible.length === 0 ? (
          <div className="text-muted-foreground/60 italic">
            {log.length === 0 ? "No activity" : "All levels filtered out"}
          </div>
        ) : (
          visible.map((entry, idx) => (
            <div
              key={`${entry.ts}-${idx}`}
              className={
                entry.level === "trade" ? "text-accent-green"
                  : entry.level === "signal" ? "text-foreground/80"
                  : entry.level === "warn" ? "text-accent-yellow"
                  : entry.level === "error" ? "text-accent-red"
                  : "text-muted-foreground"
              }
            >
              <span className="text-muted-foreground/60">{formatLogTime(entry.ts)}</span>{" "}
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
