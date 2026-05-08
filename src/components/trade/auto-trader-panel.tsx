"use client";

/**
 * AutoTraderPanel
 *
 * Sidebar UI for the live auto-trader. Lets the user pick a backtest preset
 * and "Deploy" it to drive automated entries + rule-based exits against the
 * live bar feed.
 *
 * Disarmed state:
 *   - Preset dropdown (alphabetical, sourced from the same localStorage
 *     bucket as the Backtesting tab's BacktestPresetsPanel — they share
 *     "backtest.presets.v1" so any preset saved over there is immediately
 *     deployable here).
 *   - "Deploy" button arms the engine. A confirmation modal explains what
 *     the engine will do, given live trading places real orders.
 *
 * Armed state:
 *   - Summary card: preset name, strategy, active filters, key exit rules
 *     (SL/TP/trail/BE/timer/daily/scaling) so the user can see at a glance
 *     what's about to fire.
 *   - Today counters: realized points, daily halt status, next entry size.
 *   - Active position summary when one is being managed by the engine.
 *   - DISARM button (large, red) — stops the engine immediately. The user's
 *     existing position (if any) is left alone for manual management.
 *   - Activity log — scrollable, capped at 50 entries by the engine.
 */
import { useEffect, useMemo, useState } from "react";
import {
  loadPresets,
  normalizePresetForLoad,
  syncPresetsFromSupabase,
  PRESETS_CHANGED_EVENT,
  type BacktestPreset,
} from "@/lib/utils/backtest-presets";
import type { AutoTraderState } from "@/lib/utils/auto-trader-engine";

interface AutoTraderPanelProps {
  state: AutoTraderState;
  onArm: (preset: BacktestPreset) => void;
  onDisarm: () => void;
}

export default function AutoTraderPanel({
  state,
  onArm,
  onDisarm,
}: AutoTraderPanelProps) {
  // Snapshot the saved presets list once on mount + whenever the user re-opens
  // the panel by toggling the dropdown — keeps the list fresh after they
  // create/edit one in the Backtesting tab.
  const [presets, setPresets] = useState<BacktestPreset[]>(() => loadPresets());
  const [selectedId, setSelectedId] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-pull presets on focus so a preset created in another tab shows up
  // here without a hard reload. Cheap (one localStorage read) so no harm.
  // Also subscribe to the cross-component `presets-changed` event so a
  // Supabase pull or an in-tab create/update/delete refreshes us live.
  useEffect(() => {
    const refresh = () => setPresets(loadPresets());
    window.addEventListener("focus", refresh);
    window.addEventListener(PRESETS_CHANGED_EVENT, refresh);
    // Kick off a Supabase sync on mount. The result lands in localStorage +
    // fires `presets-changed`, so we don't need to do anything with the
    // resolved value here — the listener above picks it up.
    syncPresetsFromSupabase().catch(() => {});
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PRESETS_CHANGED_EVENT, refresh);
    };
  }, []);

  const sortedPresets = useMemo(
    () => [...presets].sort((a, b) => a.name.localeCompare(b.name)),
    [presets]
  );

  const selectedPreset =
    sortedPresets.find((p) => p.id === selectedId) ?? null;

  const handleDeployClick = () => {
    if (!selectedPreset) return;
    setConfirmOpen(true);
  };

  const handleConfirmDeploy = () => {
    if (!selectedPreset) return;
    // Normalize so any older saved presets get backfilled with current
    // SimRules defaults — same forward-compat shim the Backtesting tab uses.
    onArm(normalizePresetForLoad(selectedPreset));
    setConfirmOpen(false);
  };

  return (
    <div className="bg-card border border-card-border rounded-lg p-3 flex flex-col gap-3 h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
          Auto Trader
        </h3>
        <span
          className={`text-xs px-2 py-0.5 rounded font-bold ${
            state.armed
              ? "bg-accent-green/20 text-accent-green animate-pulse"
              : "bg-white/5 text-muted-foreground"
          }`}
        >
          {state.armed ? "ARMED" : "DISARMED"}
        </span>
      </div>

      {/* Disarmed: preset picker + deploy */}
      {!state.armed && (
        <div className="flex flex-col gap-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="bg-card border border-card-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          >
            <option value="">
              {sortedPresets.length === 0
                ? "— No presets saved (create one in Backtesting) —"
                : "— Select a preset —"}
            </option>
            {sortedPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {selectedPreset && (
            <PresetSummary preset={normalizePresetForLoad(selectedPreset)} />
          )}

          <button
            onClick={handleDeployClick}
            disabled={!selectedPreset}
            className={`w-full py-2 rounded text-sm font-bold transition-colors ${
              selectedPreset
                ? "bg-accent-green text-black hover:bg-accent-green/90"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            DEPLOY
          </button>
        </div>
      )}

      {/* Armed: status + disarm */}
      {state.armed && state.preset && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            Running:{" "}
            <span className="text-foreground font-semibold">
              {state.preset.name}
            </span>
          </div>

          <PresetSummary preset={state.preset} />

          {/* Today counters */}
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            <Stat
              label="Day P&L"
              value={`${state.dailyRealizedPoints >= 0 ? "+" : ""}${state.dailyRealizedPoints.toFixed(2)} pts`}
              tone={
                state.dailyRealizedPoints > 0
                  ? "good"
                  : state.dailyRealizedPoints < 0
                    ? "bad"
                    : "neutral"
              }
            />
            <Stat label="Next Qty" value={String(state.nextEntrySize)} />
            <Stat
              label="Status"
              value={state.dailyHalted ? "HALTED" : "ACTIVE"}
              tone={state.dailyHalted ? "bad" : "good"}
            />
          </div>

          {/* Active managed entry */}
          {state.activeEntry && (
            <div className="bg-white/5 rounded p-2 text-[11px] text-muted-foreground">
              <div className="flex justify-between">
                <span>
                  Entry:{" "}
                  <span
                    className={
                      state.activeEntry.direction === "Long"
                        ? "text-accent-green font-bold"
                        : "text-accent-red font-bold"
                    }
                  >
                    {state.activeEntry.direction}
                  </span>{" "}
                  × {state.activeEntry.qty} @ {state.activeEntry.entryPrice.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between mt-1">
                <span>Peak: {state.activeEntry.peakPnl.toFixed(2)} pts</span>
                {state.activeEntry.beTriggered && (
                  <span className="text-accent-green">BE on</span>
                )}
              </div>
            </div>
          )}

          <button
            onClick={() => {
              if (
                confirm(
                  "Disarm the auto trader? Your existing position (if any) will be left untouched."
                )
              ) {
                onDisarm();
              }
            }}
            className="w-full py-2 rounded text-sm font-bold bg-accent-red text-white hover:bg-accent-red/90 transition-colors"
          >
            DISARM
          </button>
        </div>
      )}

      {/* Activity log */}
      <div className="flex-1 min-h-0 flex flex-col gap-1">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Activity
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto bg-black/20 rounded p-2 text-[11px] font-mono space-y-0.5">
          {state.log.length === 0 ? (
            <div className="text-muted-foreground/60 italic">No activity</div>
          ) : (
            // Newest first for easier scanning while live.
            [...state.log].reverse().map((entry) => (
              <div
                key={entry.ts + entry.message}
                className={
                  entry.level === "trade"
                    ? "text-accent-green"
                    : entry.level === "signal"
                      ? "text-foreground/80"
                      : entry.level === "warn"
                        ? "text-accent-yellow"
                        : entry.level === "error"
                          ? "text-accent-red"
                          : "text-muted-foreground"
                }
              >
                <span className="text-muted-foreground/60">
                  {formatLogTime(entry.ts)}
                </span>{" "}
                {entry.message}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Deploy confirmation modal */}
      {confirmOpen && selectedPreset && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-card border border-card-border rounded-lg p-4 max-w-md w-full mx-4">
            <h4 className="text-foreground font-bold mb-2">
              Deploy &ldquo;{selectedPreset.name}&rdquo;?
            </h4>
            <p className="text-xs text-muted-foreground mb-3">
              The auto trader will place real orders on the active instrument
              and account using this preset&apos;s strategy, filters, and exit
              rules. Make sure the right instrument and account are selected
              before deploying.
            </p>
            <PresetSummary preset={normalizePresetForLoad(selectedPreset)} />
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleConfirmDeploy}
                className="flex-1 py-2 rounded text-sm font-bold bg-accent-green text-black hover:bg-accent-green/90"
              >
                CONFIRM DEPLOY
              </button>
              <button
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2 rounded text-sm font-bold bg-white/5 text-foreground hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

/** Compact summary of what a preset will do — strategy, active filters,
 *  and the key exit rules. Used both in the dropdown picker (preview)
 *  and in the armed-state status (live readout). */
function PresetSummary({ preset }: { preset: BacktestPreset }) {
  const r = preset.rules;
  const filters = [
    preset.filters.time.enabled &&
      `Time ${(preset.filters.time.windows ?? [{ from: preset.filters.time.from, to: preset.filters.time.to }])
        .map((w) => `${w.from}–${w.to}`)
        .join(", ")}`,
    preset.filters.adx.enabled &&
      `ADX ${preset.filters.adx.min}-${preset.filters.adx.max}`,
    preset.filters.atr.enabled &&
      `ATR ${preset.filters.atr.min}-${preset.filters.atr.max}`,
    preset.filters.trend.enabled &&
      `Trend ${preset.filters.trend.ema20Mode}/${preset.filters.trend.ema200Mode}`,
    preset.filters.bollinger.enabled &&
      `BB ${preset.filters.bollinger.allowed.join(",")}`,
  ].filter(Boolean);
  const exits = [
    r.stopLossEnabled && `SL ${r.stopLossPoints}${r.slAtrAdjust ? `+${r.slAtrAdjust}×ATR` : ""}`,
    r.takeProfitEnabled && `TP ${r.takeProfitPoints}${r.tpAtrAdjust ? `+${r.tpAtrAdjust}×ATR` : ""}`,
    r.trailingStopEnabled && `Trail ${r.trailingStopPoints}`,
    r.breakEvenEnabled && `BE @${r.breakEvenTrigger}`,
    r.timedExitEnabled && `Timer ${r.timedExitBars}b`,
  ].filter(Boolean);
  const dailyParts = [
    r.dailyStopLossEnabled && `SL -${r.dailyStopLossPoints}`,
    r.dailyTakeProfitEnabled && `TP +${r.dailyTakeProfitPoints}`,
  ].filter(Boolean);
  const scaling = r.scalingEnabled
    ? `${r.scalingStartSize}→±${r.scalingWinStep}/${r.scalingLossStep} [${r.scalingMinSize}-${r.scalingMaxSize}]${r.scalingResetDaily ? " daily" : ""}`
    : null;

  return (
    <div className="bg-white/5 rounded p-2 text-[11px] text-muted-foreground space-y-0.5">
      <div>
        <span className="text-muted-foreground/60">Strategy:</span>{" "}
        <span className="text-foreground font-mono">{preset.strategyId}</span>
      </div>
      <div>
        <span className="text-muted-foreground/60">Filters:</span>{" "}
        {filters.length > 0 ? filters.join(" · ") : "none"}
      </div>
      <div>
        <span className="text-muted-foreground/60">Exits:</span>{" "}
        {exits.length > 0 ? exits.join(" · ") : "manual"}
      </div>
      {dailyParts.length > 0 && (
        <div>
          <span className="text-muted-foreground/60">Daily:</span>{" "}
          {dailyParts.join(" · ")}
          {r.dailyLimitExactMode && " (exact)"}
        </div>
      )}
      {scaling && (
        <div>
          <span className="text-muted-foreground/60">Scaling:</span> {scaling}
        </div>
      )}
      {r.positionMode !== "default" && (
        <div>
          <span className="text-muted-foreground/60">Position mode:</span>{" "}
          {r.positionMode}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "good"
      ? "text-accent-green"
      : tone === "bad"
        ? "text-accent-red"
        : "text-foreground";
  return (
    <div className="bg-white/5 rounded p-1.5">
      <div className="text-muted-foreground/60 text-[10px] uppercase">
        {label}
      </div>
      <div className={`font-mono font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
