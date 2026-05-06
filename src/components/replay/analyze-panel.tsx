"use client";

/**
 * AnalyzePanel — Sidebar shown in practice mode when the user is analyzing a
 * loaded section instead of placing trades / zones.
 *
 * Owns nothing — every piece of state (rules, results, loading, etc.) lives in
 * ReplayViewer, which composes this panel alongside the chart so a single
 * SimRules object drives both the on-chart overlay and the summary numbers
 * shown here. Keeps the panel a pure render of the parent's state.
 *
 * Three sections:
 *   1. Header with the section name + close button.
 *   2. Compact summary stats (trades / win rate / total / etc.).
 *   3. SL / TP / TSL toggles + numeric inputs that fire onRulesChange so the
 *      simulator re-runs in the parent. Mirrors the live SimulatorControls
 *      pattern (debounced numeric inputs, immediate toggles) but stripped to
 *      just the three rules the user asked for so the narrow w-72 sidebar
 *      stays readable.
 */

import { useCallback, useEffect, useRef } from "react";
import { SimRules, computeSimSummary, SimZoneResult } from "@/lib/utils/zone-simulator";

interface AnalyzePanelProps {
  sectionName: string;
  rules: SimRules;
  onRulesChange: (rules: SimRules) => void;
  results: SimZoneResult[];
  zoneCount: number;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

// The three rule rows the analyze view exposes. Same shape as the simulator's
// RULE_ROWS but slimmed down — break-even, timed exit, extension, scaling, and
// position-mode aren't part of the practice-view ask, so they stay hidden
// (their defaults in DEFAULT_SIM_RULES are off / no-op anyway).
interface RuleRow {
  label: string;
  enabledKey: keyof SimRules;
  valueKey: keyof SimRules;
  unit: string;
  min: number;
  max: number;
  step: number;
}

const ANALYZE_RULE_ROWS: RuleRow[] = [
  { label: "Stop Loss", enabledKey: "stopLossEnabled", valueKey: "stopLossPoints", unit: "pts", min: 0, max: 200, step: 1 },
  { label: "Take Profit", enabledKey: "takeProfitEnabled", valueKey: "takeProfitPoints", unit: "pts", min: 0, max: 200, step: 1 },
  { label: "Trailing Stop", enabledKey: "trailingStopEnabled", valueKey: "trailingStopPoints", unit: "pts", min: 0, max: 100, step: 1 },
];

export function AnalyzePanel({
  sectionName,
  rules,
  onRulesChange,
  results,
  zoneCount,
  loading,
  error,
  onClose,
}: AnalyzePanelProps) {
  // Debounce timer for numeric inputs — mirror SimulatorControls' 150ms
  // debounce so dragging the spinner doesn't fire a re-simulation per
  // keystroke. Toggle clicks fire immediately.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep latest rules in a ref so the debounced closure never reads stale
  // state. Same pattern as simulator-controls.tsx — without this, rapid
  // toggle + value changes could silently revert each other.
  const rulesRef = useRef(rules);
  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  const handleToggle = useCallback(
    (key: keyof SimRules) => {
      onRulesChange({ ...rulesRef.current, [key]: !rulesRef.current[key] });
    },
    [onRulesChange]
  );

  const handleValueChange = useCallback(
    (key: keyof SimRules, value: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onRulesChange({ ...rulesRef.current, [key]: value });
      }, 150);
    },
    [onRulesChange]
  );

  const summary = computeSimSummary(results);
  const hasResults = !loading && results.length > 0;

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto bg-card border border-card-border rounded-lg p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wider">
            Analyze
          </div>
          <h3 className="text-sm font-bold text-foreground truncate" title={sectionName}>
            {sectionName}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-xl leading-none"
          aria-label="Close analyze view"
        >
          &times;
        </button>
      </div>

      {/* Loading / error / empty states. Each replaces the controls + summary
          so the user always sees ONE clear thing at a time. */}
      {loading && (
        <div className="text-sm text-muted-foreground italic py-2">
          Loading zones...
        </div>
      )}
      {!loading && error && (
        <div className="text-sm text-accent-red">{error}</div>
      )}
      {!loading && !error && zoneCount === 0 && (
        <div className="text-sm text-muted-foreground italic py-2">
          No zones from this section fall inside the loaded session.
        </div>
      )}

      {/* Summary + controls — only when we actually have zones to show */}
      {!loading && !error && zoneCount > 0 && (
        <>
          {/* Compact summary grid. Two columns of label + value pairs so the
              w-72 sidebar isn't crowded. */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <SummaryRow label="Trades" value={`${summary.totalTrades}`} />
            <SummaryRow
              label="Win Rate"
              value={`${(summary.winRate * 100).toFixed(0)}%`}
            />
            <SummaryRow
              label="Total Pts"
              value={summary.totalPoints.toFixed(1)}
              positive={summary.totalPoints > 0}
              negative={summary.totalPoints < 0}
            />
            <SummaryRow
              label="Avg / Trade"
              value={summary.avgPoints.toFixed(2)}
              positive={summary.avgPoints > 0}
              negative={summary.avgPoints < 0}
            />
            <SummaryRow
              label="Profit Factor"
              value={
                Number.isFinite(summary.profitFactor)
                  ? summary.profitFactor.toFixed(2)
                  : "∞"
              }
            />
            <SummaryRow
              label="Avg Bars"
              value={summary.avgBarsHeld.toFixed(1)}
            />
            <SummaryRow
              label="Best"
              value={summary.bestTrade.toFixed(1)}
              positive={summary.bestTrade > 0}
            />
            <SummaryRow
              label="Worst"
              value={summary.worstTrade.toFixed(1)}
              negative={summary.worstTrade < 0}
            />
          </div>

          {/* Exit reason mini-breakdown — only shown when there's variety. */}
          {Object.keys(summary.byExitReason).length > 0 && (
            <div className="space-y-1 pt-1 border-t border-card-border/50">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Exit Reasons
              </div>
              {Object.entries(summary.byExitReason).map(([reason, count]) => (
                <div
                  key={reason}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="uppercase text-muted-foreground">
                    {reason}
                  </span>
                  <span className="text-foreground">{count}</span>
                </div>
              ))}
            </div>
          )}

          {/* Rule controls — toggle + base + unit per row. "Exit at Bar Close"
              toggle sits above so the user can flip between exit conventions
              without scrolling. */}
          <div className="pt-2 border-t border-card-border/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-foreground">Exit Mode</span>
              <button
                onClick={() =>
                  onRulesChange({
                    ...rules,
                    exitAtBarClose: !rules.exitAtBarClose,
                  })
                }
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  rules.exitAtBarClose
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground"
                }`}
              >
                {rules.exitAtBarClose ? "BAR CLOSE" : "EXACT"}
              </button>
            </div>

            {ANALYZE_RULE_ROWS.map((row) => {
              const enabled = rules[row.enabledKey] as boolean;
              return (
                <div key={row.label} className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(row.enabledKey)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium min-w-[36px] transition-colors ${
                      enabled
                        ? "bg-accent-green/20 text-accent-green"
                        : "bg-white/5 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {enabled ? "ON" : "OFF"}
                  </button>
                  <span
                    className={`text-xs flex-1 ${
                      enabled ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {row.label}
                  </span>
                  <input
                    type="number"
                    defaultValue={rules[row.valueKey] as number}
                    min={row.min}
                    max={row.max}
                    step={row.step}
                    onChange={(e) => {
                      // Parse to a real number so typing "0" isn't coerced to
                      // row.min via a falsy `||` fallback (matches the live
                      // simulator's NaN-guarded handling).
                      const n = parseFloat(e.target.value);
                      handleValueChange(
                        row.valueKey,
                        Number.isFinite(n) ? n : row.min
                      );
                    }}
                    disabled={!enabled}
                    className={`w-16 bg-card border border-card-border rounded-md px-2 py-1 text-xs text-right transition-opacity ${
                      enabled
                        ? "text-foreground opacity-100"
                        : "text-muted-foreground opacity-40"
                    } focus:outline-none focus:ring-1 focus:ring-accent-green`}
                  />
                  <span className="text-[10px] text-muted-foreground w-6">
                    {row.unit}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Tiny helper for the 2-column summary grid — keeps the markup readable. */
function SummaryRow({
  label,
  value,
  positive,
  negative,
}: {
  label: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`font-medium ${
          positive
            ? "text-accent-green"
            : negative
              ? "text-accent-red"
              : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
