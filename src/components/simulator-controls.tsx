/**
 * SimulatorControls — Rule toggles and numeric inputs for the risk simulator.
 *
 * Each rule row has an on/off toggle, a base point input, and (for the
 * volatility-aware rules SL/TP/Trail/BE) a second optional "± ATR" input.
 * The simulator computes the effective threshold per zone as:
 *   effective = basePoints + atrAdjust × zoneATR(14)
 * So an adjust of 0 is a no-op (identical to fixed-points behavior), positive
 * widens in high-vol regimes, and negative tightens.
 *
 * Changes fire via onRulesChange — toggles immediately, numbers with 150ms debounce.
 *
 * ⚠️  NT8 PRESET SYNC ⚠️
 *
 * Every input here corresponds to a `SimRules` field that gets serialized
 * into the preset JSON the dashboard exports. The same JSON is loaded by
 * NinjaTrader 8 via PresetLoader.cs. When you add a new control here, the
 * underlying SimRules field must already exist; if you're adding a field at
 * the same time, also wire it through the C# side. See the sync checklist
 * at the top of `src/lib/utils/zone-simulator.ts` (SimRules definition) —
 * TL;DR: PresetSchema.cs + PresetLoader.cs + (if behavior) PresetExecutor.cs.
 */

"use client";

import { useRef, useCallback, useEffect } from "react";
import { SimRules, PositionMode } from "@/lib/utils/zone-simulator";

// Labels and tooltips for the cross-zone position-mode selector. Order matches
// the dropdown rendering. Keep in sync with the PositionMode union in zone-simulator.ts.
const POSITION_MODE_OPTIONS: { value: PositionMode; label: string; title: string }[] = [
  { value: "default", label: "Default", title: "Each zone simulated independently — current behavior, allows full overlap" },
  { value: "close-previous", label: "Close Previous", title: "Any new zone closes ALL currently-open positions at the new zone's start" },
  { value: "add-close", label: "Add / Close", title: "Opposing-direction open positions get closed; same-direction ones keep running alongside the new one" },
  { value: "null", label: "Null", title: "If any position is open, drop the new zone entirely" },
  { value: "add-null", label: "Add / Null", title: "Opposing-direction open → drop the new zone; same-direction → stack normally" },
  { value: "reverse-null", label: "Reverse / Null", title: "Opposing-direction open → flip the side (close opposing, open new with size reset); same-direction → drop the new zone" },
  { value: "reverse-add", label: "Reverse / Add", title: "Opposing-direction open → flip the side (close opposing, open new with size reset); same-direction → stack normally" },
];

interface SimulatorControlsProps {
  rules: SimRules;
  onRulesChange: (rules: SimRules) => void;
  onOptimize: () => void;
  optimizing: boolean;
  optimizeProgress: number | null;
  // ATR-Adjust optimizer — grids over the ± ATR adjustment fields while
  // keeping the user's base SL/TP/Trail point values frozen.
  onOptimizeAtr: () => void;
  optimizingAtr: boolean;
  optimizeAtrProgress: number | null;
}

interface RuleRowConfig {
  label: string;
  enabledKey: keyof SimRules;
  valueKey: keyof SimRules;
  unit: string;
  min: number;
  max: number;
  step: number;
  // When set, the row also renders a second numeric input for the ATR adjust.
  // Rows that don't have a sensible ATR meaning (Timed Exit, Extend Bars —
  // both are bar counts, not price thresholds) leave this undefined.
  adjustKey?: keyof SimRules;
}

const RULE_ROWS: RuleRowConfig[] = [
  // Point-based rules allow a base of 0 so users can build pure ATR-scaled
  // thresholds (e.g. base=0, ±ATR=1 → effective = 1×zoneATR). Bar-count rules
  // (Timed Exit, Extend Bars) keep min=1 since 0 bars is meaningless.
  { label: "Stop Loss", enabledKey: "stopLossEnabled", valueKey: "stopLossPoints", unit: "pts", min: 0, max: 200, step: 1, adjustKey: "slAtrAdjust" },
  { label: "Take Profit", enabledKey: "takeProfitEnabled", valueKey: "takeProfitPoints", unit: "pts", min: 0, max: 200, step: 1, adjustKey: "tpAtrAdjust" },
  { label: "Trailing Stop", enabledKey: "trailingStopEnabled", valueKey: "trailingStopPoints", unit: "pts", min: 0, max: 100, step: 1, adjustKey: "trailAtrAdjust" },
  { label: "Timed Exit", enabledKey: "timedExitEnabled", valueKey: "timedExitBars", unit: "bars", min: 1, max: 200, step: 1 },
  { label: "Break Even", enabledKey: "breakEvenEnabled", valueKey: "breakEvenTrigger", unit: "pts trigger", min: 0, max: 100, step: 1, adjustKey: "beAtrAdjust" },
  // Post-zone bar extension — appends N bars from the matching replay session
  // after each zone's end_time. Bar count, not a price threshold, so no ATR adj.
  { label: "Extend Bars", enabledKey: "extensionBarsEnabled", valueKey: "extensionBars", unit: "bars after zone", min: 1, max: 100, step: 1 },
  // Daily kill switches — once a day's cumulative P&L crosses, no more
  // trades enter for the rest of that day. Different scope from the
  // per-trade SL/TP above; ATR adj doesn't apply (these are absolute
  // points-per-day caps, not zone-volatility-relative thresholds).
  { label: "Daily SL", enabledKey: "dailyStopLossEnabled", valueKey: "dailyStopLossPoints", unit: "pts/day", min: 0, max: 1000, step: 1 },
  { label: "Daily TP", enabledKey: "dailyTakeProfitEnabled", valueKey: "dailyTakeProfitPoints", unit: "pts/day", min: 0, max: 1000, step: 1 },
  // Per-day count caps + cooldown — same row layout as the P&L caps
  // above, but the threshold is COUNT-based (trades / losers / minutes
  // since last exit). Drops new entries once the cap is hit.
  { label: "Max trades/day", enabledKey: "maxTradesPerDayEnabled", valueKey: "maxTradesPerDay", unit: "trades/day", min: 1, max: 200, step: 1 },
  { label: "Max losses/day", enabledKey: "maxLossesPerDayEnabled", valueKey: "maxLossesPerDay", unit: "losers/day", min: 1, max: 50, step: 1 },
  { label: "Cooldown", enabledKey: "cooldownBetweenTradesEnabled", valueKey: "cooldownBetweenTradesBars", unit: "min after exit", min: 1, max: 240, step: 1 },
];

export function SimulatorControls({
  rules,
  onRulesChange,
  onOptimize,
  optimizing,
  optimizeProgress,
  onOptimizeAtr,
  optimizingAtr,
  optimizeAtrProgress,
}: SimulatorControlsProps) {
  // Debounce timer ref for numeric inputs
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to the latest rules so debounced callbacks never use stale state.
  // Without this, rapid toggle + value changes can silently revert each other
  // because the debounce closure captures rules from the render it was created in.
  const rulesRef = useRef(rules);
  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  // Toggle fires immediately — reads from ref to avoid stale closure
  const handleToggle = useCallback(
    (key: keyof SimRules) => {
      onRulesChange({ ...rulesRef.current, [key]: !rulesRef.current[key] });
    },
    [onRulesChange]
  );

  // Number input fires after 150ms debounce — reads from ref so the
  // callback always merges into the latest rules, not a stale snapshot
  const handleValueChange = useCallback(
    (key: keyof SimRules, value: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onRulesChange({ ...rulesRef.current, [key]: value });
      }, 150);
    },
    [onRulesChange]
  );

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <h3 className="text-sm text-muted-foreground uppercase tracking-wider mb-3">
        Risk Management Rules
      </h3>
      <div className="space-y-2">
        {/* Exit mode toggle — bar close vs exact level */}
        <div className="flex items-center gap-3 pb-2 mb-1 border-b border-card-border/50">
          <button
            onClick={() => onRulesChange({ ...rules, exitAtBarClose: !rules.exitAtBarClose })}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              rules.exitAtBarClose
                ? "bg-accent-green/20 text-accent-green"
                : "bg-white/5 text-muted-foreground hover:text-foreground"
            }`}
          >
            {rules.exitAtBarClose ? "BAR CLOSE" : "EXACT"}
          </button>
          <span className="text-sm text-foreground">Exit Mode</span>
          <span className="text-xs text-muted-foreground">
            {rules.exitAtBarClose ? "Exit at candle close" : "Exit at exact trigger level"}
          </span>
        </div>

        {/* Column header for the ATR-adjust column so users understand the
            second input is "additive ATR scaling on top of the base points". */}
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground/70">
          <span className="min-w-[44px]" />
          <span className="min-w-[100px]" />
          <span className="w-20 text-right">Base</span>
          <span className="min-w-[60px]" />
          <span className="w-16 text-right">± ATR</span>
        </div>

        {RULE_ROWS.map((row) => {
          const enabled = rules[row.enabledKey] as boolean;
          const adjustValue = row.adjustKey ? (rules[row.adjustKey] as number) : 0;
          return (
            <div key={row.label} className="flex items-center gap-3">
              {/* Toggle button */}
              <button
                onClick={() => handleToggle(row.enabledKey)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors min-w-[44px] ${
                  enabled
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground"
                }`}
              >
                {enabled ? "ON" : "OFF"}
              </button>

              {/* Label */}
              <span className={`text-sm min-w-[100px] ${enabled ? "text-foreground" : "text-muted-foreground"}`}>
                {row.label}
              </span>

              {/* Base point input. NaN check (not `|| row.min`) so that
                  typing "0" is preserved — `parseFloat("0") || row.min`
                  used to silently coerce 0 → row.min because 0 is falsy,
                  which broke "base 0 + ATR adjust 1" configs. */}
              <input
                type="number"
                defaultValue={rules[row.valueKey] as number}
                min={row.min}
                max={row.max}
                step={row.step}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  handleValueChange(row.valueKey, Number.isFinite(n) ? n : row.min);
                }}
                disabled={!enabled}
                className={`w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right transition-opacity ${
                  enabled ? "text-foreground opacity-100" : "text-muted-foreground opacity-40"
                } focus:outline-none focus:ring-1 focus:ring-accent-green`}
              />

              {/* Unit label for the base — fixed width so the ATR adjust column lines up */}
              <span className="text-xs text-muted-foreground min-w-[60px]">{row.unit}</span>

              {/* Per-rule ATR adjustment input — only on rows that have an
                  adjustKey (price-threshold rules). Bar-count rows leave this
                  cell empty so the column still aligns. The simulator uses
                  effective = basePoints + adjust × zoneATR(14). */}
              {row.adjustKey ? (
                <>
                  <input
                    type="number"
                    defaultValue={adjustValue}
                    min={-5}
                    max={5}
                    step={0.1}
                    onChange={(e) => handleValueChange(row.adjustKey!, parseFloat(e.target.value) || 0)}
                    disabled={!enabled}
                    title="Additive ATR(14) adjustment per zone — set to 0 for fixed-points behavior"
                    className={`w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right transition-opacity ${
                      enabled ? "text-foreground opacity-100" : "text-muted-foreground opacity-40"
                    } focus:outline-none focus:ring-1 focus:ring-accent-green`}
                  />
                  <span className="text-xs text-muted-foreground">× ATR</span>
                </>
              ) : row.label === "Extend Bars" ? (
                /* Position-mode selector lives in the ATR cell of the Extend
                   Bars row. It's not strictly tied to extension, but extension
                   makes overlapping zones common, so this is where the user
                   asked for it. The mode applies to ALL zones, regardless of
                   whether extension is on. */
                <select
                  value={rules.positionMode}
                  onChange={(e) => onRulesChange({ ...rulesRef.current, positionMode: e.target.value as PositionMode })}
                  title="How to handle a new zone that opens while a previous zone is still in its trade"
                  className="bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                >
                  {POSITION_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} title={opt.title}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="w-16" />
              )}
            </div>
          );
        })}

        {/* Daily Limit Exact Mode toggle — only meaningful when at
            least one daily switch is on, but always rendered so the
            user can flip it without re-finding it later. When OFF
            (default), trades in flight at the moment a daily TP/SL
            triggers keep running to their natural exit. When ON, those
            trades get force-closed at the trigger bar with exit reason
            "daily" — same mechanism the "Close Previous" position-mode
            uses to truncate prior trades. Sits between the rule rows
            and the scaling section so it visually groups with the
            "Daily SL" / "Daily TP" rows above. */}
        {(rules.dailyStopLossEnabled || rules.dailyTakeProfitEnabled) && (
          <div className="flex items-center gap-3 pt-2 mt-1 border-t border-card-border/50">
            <button
              onClick={() =>
                onRulesChange({
                  ...rulesRef.current,
                  dailyLimitExactMode: !rulesRef.current.dailyLimitExactMode,
                })
              }
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                rules.dailyLimitExactMode
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-white/5 text-muted-foreground hover:text-foreground"
              }`}
            >
              {rules.dailyLimitExactMode ? "EXACT" : "LAZY"}
            </button>
            <span className="text-sm text-foreground">Daily Limit Mode</span>
            <span className="text-xs text-muted-foreground">
              {rules.dailyLimitExactMode
                ? "Close in-flight trades the instant the daily SL/TP hits"
                : "Stop entering new trades once daily SL/TP hits; let in-flight ones run"}
            </span>
          </div>
        )}

        {/* Fills & Costs — make the simulator's fill convention and cost
            assumptions visible/tweakable. Defaults to NinjaTrader-realistic
            (next-bar-open fill, no slippage/commission); flip fillMode back
            to CLOSE to reproduce historical results from before this section
            existed. Slippage subtracts 2 × slippagePoints from each round-
            trip's exitPoints; commission is a flat $ per round-trip; point
            value converts the points × size P&L into dollars in
            SimZoneResult.netDollars. */}
        <div className="pt-2 mt-2 border-t border-card-border/50">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Fill-mode toggle — three-state visually but two-state behind:
                close = legacy "fill at trigger bar's close"
                next_open = match NinjaTrader's Calculate.OnBarClose behavior */}
            <button
              onClick={() =>
                onRulesChange({
                  ...rulesRef.current,
                  fillMode: rulesRef.current.fillMode === "close" ? "next_open" : "close",
                })
              }
              title={
                rules.fillMode === "next_open"
                  ? "Fill at the next bar's open (NinjaTrader-realistic; default)"
                  : "Fill at the trigger bar's close (legacy; less realistic)"
              }
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors min-w-[88px] ${
                rules.fillMode === "next_open"
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-white/5 text-muted-foreground hover:text-foreground"
              }`}
            >
              {rules.fillMode === "next_open" ? "NEXT OPEN" : "CLOSE"}
            </button>
            <span className="text-sm text-foreground min-w-[100px]">Fill Mode</span>

            {/* Tick-config mode toggle — auto resolves $/pt, ticks/pt,
                $/tick from the per-instrument table in futures.ts;
                manual uses the explicit fields below. Default auto so
                most users never need to touch the tick fields. */}
            <button
              onClick={() =>
                onRulesChange({
                  ...rulesRef.current,
                  tickConfigMode:
                    rulesRef.current.tickConfigMode === "auto" ? "manual" : "auto",
                })
              }
              title={
                rules.tickConfigMode === "auto"
                  ? "Auto-resolve tick / point values from each zone's instrument symbol (NQ, ES, GC, CL, BTC, etc.). The fields below are ignored in auto mode."
                  : "Use the explicit ticks/pt, $/tick, $/pt fields below. For non-standard contracts."
              }
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors min-w-[88px] ${
                rules.tickConfigMode === "auto"
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-amber-500/20 text-amber-400 hover:text-amber-300"
              }`}
            >
              {rules.tickConfigMode === "auto" ? "AUTO TICKS" : "MANUAL TICKS"}
            </button>

            {/* Slippage per side, in price points. The simulator subtracts
                2× this from exitPoints to model the realistic round-trip cost. */}
            <label className="flex items-center gap-1.5" title="Slippage per side, in price points. Round-trip = 2 × this. NQ is typically 0.25–0.5 pts.">
              <span className="text-xs text-muted-foreground">Slip ±</span>
              <input
                type="number"
                defaultValue={rules.slippagePoints}
                min={0}
                step={0.05}
                onChange={(e) =>
                  handleValueChange("slippagePoints", parseFloat(e.target.value) || 0)
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">pts/side</span>
            </label>

            {/* Commission per round-trip, in dollars. Flat cost per closed
                trade; multiplied by positionSize when scaling is on. */}
            <label className="flex items-center gap-1.5" title="Commission per round-trip per contract, in $. Multiplied by positionSize when scaling is on.">
              <span className="text-xs text-muted-foreground">Comm $</span>
              <input
                type="number"
                defaultValue={rules.commissionPerRoundTrip}
                min={0}
                step={0.5}
                onChange={(e) =>
                  handleValueChange("commissionPerRoundTrip", parseFloat(e.target.value) || 0)
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">$/RT</span>
            </label>

            {/* Tick / point inputs — disabled when tickConfigMode is
                "auto" because the simulator pulls values from the
                instrument's spec in futures.ts INSTRUMENT_TICK_SPECS
                (NQ, ES, GC, CL, BTC, ZB, RTY, …). The fields keep
                their stored values (so the user's override survives a
                toggle round-trip) but are visually muted to make it
                obvious they're inactive in auto mode. */}
            <label
              className={`flex items-center gap-1.5 ${rules.tickConfigMode === "auto" ? "opacity-50" : ""}`}
              title={
                rules.tickConfigMode === "auto"
                  ? "Auto-resolved per instrument (NQ=20, ES=50, GC=100, …). Toggle to MANUAL TICKS to edit."
                  : "Dollars per 1.0 price point per contract. NQ=20, MNQ=2, ES=50, MES=5, CL=1000, GC=100."
              }
            >
              <span className="text-xs text-muted-foreground">$/pt</span>
              <input
                type="number"
                key={`pointValue-${rules.tickConfigMode}-${rules.pointValue}`}
                defaultValue={rules.pointValue}
                min={0}
                step={1}
                disabled={rules.tickConfigMode === "auto"}
                onChange={(e) =>
                  handleValueChange("pointValue", parseFloat(e.target.value) || 0)
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green disabled:cursor-not-allowed"
              />
            </label>

            <label
              className={`flex items-center gap-1.5 ${rules.tickConfigMode === "auto" ? "opacity-50" : ""}`}
              title={
                rules.tickConfigMode === "auto"
                  ? "Auto-resolved per instrument (NQ/ES=4, GC/RTY=10, CL=100, BTC=0.2, ZB=32). Toggle to MANUAL TICKS to edit."
                  : "Ticks per price point. Used by the ticks(n) helper inside script Optimize bounds."
              }
            >
              <span className="text-xs text-muted-foreground">ticks/pt</span>
              <input
                type="number"
                key={`ticksPerPoint-${rules.tickConfigMode}-${rules.ticksPerPoint}`}
                defaultValue={rules.ticksPerPoint}
                min={0.01}
                step={0.01}
                disabled={rules.tickConfigMode === "auto"}
                onChange={(e) =>
                  handleValueChange(
                    "ticksPerPoint",
                    parseFloat(e.target.value) || 1
                  )
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green disabled:cursor-not-allowed"
              />
            </label>

            <label
              className={`flex items-center gap-1.5 ${rules.tickConfigMode === "auto" ? "opacity-50" : ""}`}
              title={
                rules.tickConfigMode === "auto"
                  ? "Auto-resolved per instrument (NQ=5, ES=12.50, GC=10, CL=10, BTC=25). Toggle to MANUAL TICKS to edit."
                  : "Dollar value per tick. Should equal $/pt ÷ ticks/pt."
              }
            >
              <span className="text-xs text-muted-foreground">$/tick</span>
              <input
                type="number"
                key={`tickValue-${rules.tickConfigMode}-${rules.tickValue}`}
                defaultValue={rules.tickValue}
                min={0}
                step={0.01}
                disabled={rules.tickConfigMode === "auto"}
                onChange={(e) =>
                  handleValueChange("tickValue", parseFloat(e.target.value) || 0)
                }
                className="w-16 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green disabled:cursor-not-allowed"
              />
            </label>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground/70">
            Round-trip cost: {(rules.slippagePoints * 2).toFixed(2)} pts slip
            {rules.commissionPerRoundTrip > 0 && ` + $${rules.commissionPerRoundTrip.toFixed(2)} comm`}
            {rules.fillMode === "next_open" && " · fills at next bar's open"}
            {rules.tickConfigMode === "auto" && (
              <span> · ticks resolved per-instrument (NQ, ES, GC, CL, BTC, …)</span>
            )}
            {rules.tickConfigMode === "manual" &&
              Math.abs(rules.pointValue - rules.ticksPerPoint * rules.tickValue) > 0.001 && (
                <span className="text-amber-400/80">
                  {" "}· $/pt ≠ ticks/pt × $/tick ({(rules.ticksPerPoint * rules.tickValue).toFixed(2)})
                </span>
              )}
          </div>
        </div>

        {/* Scaling Modifier — additive position-size walk across trades.
            After a winner the next trade's size goes up by scalingWinStep;
            after a loser it goes down by scalingLossStep. Running size is
            clamped to [Min, Max] and never resets, so a long winning streak
            compounds up to the cap and a losing streak drifts down to the
            floor. Applied as a post-pass in simulateAllZones — all summary
            numbers, the table's points column, and the equity curve reflect
            exitPoints × positionSize once this is enabled. */}
        <div className="pt-2 mt-2 border-t border-card-border/50">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => handleToggle("scalingEnabled")}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors min-w-[44px] ${
                rules.scalingEnabled
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-white/5 text-muted-foreground hover:text-foreground"
              }`}
            >
              {rules.scalingEnabled ? "ON" : "OFF"}
            </button>
            <span className={`text-sm min-w-[100px] ${rules.scalingEnabled ? "text-foreground" : "text-muted-foreground"}`}>
              Scaling Modifier
            </span>

            {/* Compact inline group — label + input pairs. All five share the
                same disabled-styling so they fade together when scaling is off. */}
            {([
              { key: "scalingStartSize" as const, label: "Start", title: "Starting position size for the first trade" },
              { key: "scalingWinStep" as const, label: "Win +", title: "Size to ADD after a winning trade" },
              { key: "scalingLossStep" as const, label: "Loss −", title: "Size to SUBTRACT after a losing trade" },
              { key: "scalingMinSize" as const, label: "Min", title: "Running size is clamped to at least this value" },
              { key: "scalingMaxSize" as const, label: "Max", title: "Running size is clamped to at most this value" },
            ]).map(({ key, label, title }) => (
              <label key={key} className="flex items-center gap-1.5" title={title}>
                <span className={`text-xs ${rules.scalingEnabled ? "text-muted-foreground" : "text-muted-foreground/60"}`}>
                  {label}
                </span>
                <input
                  type="number"
                  defaultValue={rules[key] as number}
                  min={0}
                  step={1}
                  onChange={(e) => handleValueChange(key, parseFloat(e.target.value) || 0)}
                  disabled={!rules.scalingEnabled}
                  className={`w-14 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right transition-opacity ${
                    rules.scalingEnabled ? "text-foreground opacity-100" : "text-muted-foreground opacity-40"
                  } focus:outline-none focus:ring-1 focus:ring-accent-green`}
                />
              </label>
            ))}

            {/* Daily-reset checkbox — when on, the running size snaps back
                to Start at the boundary between calendar days. Lets users
                model "every session starts fresh" instead of the default
                continuous walk that compounds streaks across days. */}
            <label
              className="flex items-center gap-1.5 cursor-pointer"
              title="Reset running size back to Start at the beginning of every new calendar day"
            >
              <input
                type="checkbox"
                checked={rules.scalingResetDaily}
                onChange={() => handleToggle("scalingResetDaily")}
                disabled={!rules.scalingEnabled}
                className="accent-accent-green disabled:opacity-40"
              />
              <span
                className={`text-xs ${
                  rules.scalingEnabled ? "text-muted-foreground" : "text-muted-foreground/60"
                }`}
              >
                Reset Daily
              </span>
            </label>
          </div>
        </div>

        {/* Optimize button — runs grid search over SL/TP/TSL to maximize EV */}
        <div className="pt-3 mt-2 border-t border-card-border/50">
          <button
            onClick={onOptimize}
            disabled={optimizing || optimizingAtr}
            className={`w-full py-2 rounded-md text-sm font-medium transition-colors ${
              optimizing || optimizingAtr
                ? "bg-white/5 text-muted-foreground cursor-not-allowed"
                : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
            }`}
          >
            {optimizing ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Optimizing... {optimizeProgress !== null ? `${Math.round(optimizeProgress * 100)}%` : ""}
              </span>
            ) : (
              "Optimize SL / TP / TSL"
            )}
          </button>
          {optimizing && optimizeProgress !== null && (
            <div className="mt-2 bg-white/5 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent-green/60 transition-all duration-150"
                style={{ width: `${Math.round(optimizeProgress * 100)}%` }}
              />
            </div>
          )}

          {/* ATR-Adjust optimizer — keeps the user's base SL/TP/Trail point
              values frozen and grids over the ± ATR adjustment fields only.
              Answers "given my proven base, can I improve EV by stretching/
              tightening per-zone based on volatility?". */}
          <button
            onClick={onOptimizeAtr}
            disabled={optimizingAtr || optimizing}
            title="Grid-searches the ± ATR adjustment fields while keeping your base SL/TP/Trail points frozen"
            className={`mt-2 w-full py-2 rounded-md text-sm font-medium transition-colors ${
              optimizingAtr || optimizing
                ? "bg-white/5 text-muted-foreground cursor-not-allowed"
                : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
            }`}
          >
            {optimizingAtr ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Optimizing ATR Adjust... {optimizeAtrProgress !== null ? `${Math.round(optimizeAtrProgress * 100)}%` : ""}
              </span>
            ) : (
              "Optimize ATR Adjust (keeps base frozen)"
            )}
          </button>
          {optimizingAtr && optimizeAtrProgress !== null && (
            <div className="mt-2 bg-white/5 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent-green/60 transition-all duration-150"
                style={{ width: `${Math.round(optimizeAtrProgress * 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
