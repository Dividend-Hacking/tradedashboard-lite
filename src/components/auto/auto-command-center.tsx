"use client";

/**
 * AutoCommandCenter
 *
 * The primary control + status surface on the auto-trading page. Combines
 * preset selection, deploy/disarm controls, daily-limit progress bars,
 * active position visibility, and an emergency kill switch in one panel.
 *
 * This is the auto-trading-optimized replacement for the old
 * AutoTraderPanel sidebar that lived inside /trade. The discretionary
 * panel was constrained by the live-trader's narrow right-rail; here we
 * have the whole right column, so we can prioritize:
 *
 *   1. Big DEPLOY button when disarmed.
 *   2. Daily P&L progress bars vs the preset's stopLoss / takeProfit
 *      thresholds — tells the user at a glance how close they are to a
 *      day-end auto-halt.
 *   3. Active position card with peak P&L, BE-armed status, time held.
 *   4. EMERGENCY STOP — closes any open position AND disarms in one
 *      click, separate from the soft "Disarm" (which leaves the position
 *      alone for manual management).
 *   5. Today's auto-trade snapshot (count, win rate, realized).
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
import type { LiveState } from "@/types/live";
import type { Trade } from "@/types/trade";

interface AutoCommandCenterProps {
  engineState: AutoTraderState;
  onArm: (preset: BacktestPreset) => void;
  onDisarm: () => void;
  /** Hard kill — closes any open position then disarms. Wired up by parent
   *  so the close goes through the same NT8 dispatcher the engine uses. */
  onEmergencyStop: () => void;
  livePosition: LiveState | null;
  lastPrice: number | null;
  /** Closed trades for the selected account today — used for the running
   *  win-rate / total-realized stats card. Filtered upstream by the
   *  parent so this panel doesn't have to care about the account selector. */
  todaysTrades: Trade[];
}

export default function AutoCommandCenter({
  engineState,
  onArm,
  onDisarm,
  onEmergencyStop,
  livePosition,
  lastPrice,
  todaysTrades,
}: AutoCommandCenterProps) {
  // Refresh saved presets on focus — same pattern as the old AutoTraderPanel,
  // so creating a preset in another tab shows up here without a hard reload.
  const [presets, setPresets] = useState<BacktestPreset[]>(() => loadPresets());
  const [selectedId, setSelectedId] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    const refresh = () => setPresets(loadPresets());
    window.addEventListener("focus", refresh);
    window.addEventListener(PRESETS_CHANGED_EVENT, refresh);
    // Sync from Supabase on mount; the merged list lands in localStorage and
    // the listener above re-renders us when it changes.
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
  const selectedPreset = sortedPresets.find((p) => p.id === selectedId) ?? null;

  const handleDeployClick = () => {
    if (!selectedPreset) return;
    setConfirmOpen(true);
  };
  const handleConfirmDeploy = () => {
    if (!selectedPreset) return;
    onArm(normalizePresetForLoad(selectedPreset));
    setConfirmOpen(false);
  };

  // ─── Today's stats ───────────────────────────────────────────────
  // Realized P&L (points × qty) for the selected account today, plus
  // win rate. Surfaces independently of the engine's own dailyRealized
  // counter because the engine only tracks trades it dispatched —
  // todaysTrades includes every fill on the account regardless of
  // whether the engine or a manual entry created it. That's useful
  // when the user toggled between manual and auto during the day.
  const stats = useMemo(() => {
    const closed = todaysTrades;
    const wins = closed.filter((t) => (t.pnl_points ?? 0) > 0).length;
    const realized = closed.reduce(
      (sum, t) => sum + (t.pnl_points ?? 0) * (t.quantity ?? 1),
      0
    );
    return {
      total: closed.length,
      wins,
      winRate: closed.length > 0 ? wins / closed.length : 0,
      realized,
    };
  }, [todaysTrades]);

  // ─── Active position summary ─────────────────────────────────────
  // Computed every render — cheap and keeps the displayed peak / current /
  // age in lockstep with the live tick stream.
  const activeEntry = engineState.activeEntry;
  const activePosOpenPnl = useMemo(() => {
    if (!livePosition?.position_direction || lastPrice == null) return null;
    const isLong = livePosition.position_direction === "Long";
    return isLong
      ? lastPrice - livePosition.position_entry_price
      : livePosition.position_entry_price - lastPrice;
  }, [livePosition, lastPrice]);

  return (
    <div className="bg-card border border-card-border rounded-lg p-3 flex flex-col gap-3">
      {/* Title row */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
          Command Center
        </h3>
        <span className={`text-[11px] px-2 py-0.5 rounded font-bold ${
          engineState.armed
            ? "bg-accent-green/20 text-accent-green"
            : "bg-white/5 text-muted-foreground"
        }`}>
          {engineState.armed ? "ARMED" : "DISARMED"}
        </span>
      </div>

      {/* DISARMED: preset picker + DEPLOY */}
      {!engineState.armed && (
        <div className="flex flex-col gap-2">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Preset
          </label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="bg-background border border-card-border rounded-md px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          >
            <option value="">
              {sortedPresets.length === 0
                ? "— No presets saved (create one in Backtesting) —"
                : "— Select a preset —"}
            </option>
            {sortedPresets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          {selectedPreset && (
            <PresetSummary preset={normalizePresetForLoad(selectedPreset)} />
          )}

          <button
            onClick={handleDeployClick}
            disabled={!selectedPreset}
            className={`w-full py-3 rounded text-sm font-bold transition-colors ${
              selectedPreset
                ? "bg-accent-green text-black hover:bg-accent-green/90"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            DEPLOY
          </button>
        </div>
      )}

      {/* ARMED: deployed preset summary + daily progress + position + kill switch */}
      {engineState.armed && engineState.preset && (
        <div className="flex flex-col gap-3">
          <div className="text-xs text-muted-foreground">
            Running:{" "}
            <span className="text-foreground font-semibold">
              {engineState.preset.name}
            </span>
          </div>

          <PresetSummary preset={engineState.preset} />

          {/* Daily progress vs preset's daily SL/TP limits. Renders nothing
              when the preset has no daily limits configured — the section
              would just be empty bars. */}
          <DailyProgress engineState={engineState} />

          {/* Counters — engine-tracked state */}
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <Stat
              label="Engine Day"
              value={`${engineState.dailyRealizedPoints >= 0 ? "+" : ""}${engineState.dailyRealizedPoints.toFixed(2)} pts`}
              tone={
                engineState.dailyRealizedPoints > 0 ? "good"
                  : engineState.dailyRealizedPoints < 0 ? "bad"
                  : "neutral"
              }
            />
            <Stat label="Next Qty" value={String(engineState.nextEntrySize)} />
            <Stat
              label="Status"
              value={engineState.dailyHalted ? "HALTED" : "ACTIVE"}
              tone={engineState.dailyHalted ? "bad" : "good"}
            />
          </div>

          {/* Active managed position card — only renders when both the
              engine has tagged an entry AND NT8 reports a live position
              (so a stale activeEntry from a missed close event doesn't
              flash here forever). */}
          {activeEntry && livePosition?.position_direction && (
            <ActivePositionCard
              activeEntry={activeEntry}
              livePosition={livePosition}
              currentPnl={activePosOpenPnl}
            />
          )}

          <button
            onClick={() => {
              if (confirm("Disarm the engine? Existing position (if any) will be left for manual management.")) {
                onDisarm();
              }
            }}
            className="w-full py-2 rounded text-sm font-bold bg-white/5 text-foreground border border-white/10 hover:bg-white/10 transition-colors"
          >
            Disarm (keep position)
          </button>
          <button
            onClick={() => {
              const msg = livePosition?.position_direction
                ? "EMERGENCY STOP\n\nThis will CLOSE the open position and DISARM the engine. Continue?"
                : "Disarm and confirm flat?";
              if (confirm(msg)) onEmergencyStop();
            }}
            className="w-full py-3 rounded text-sm font-bold bg-accent-red text-white hover:bg-accent-red/90 transition-colors"
          >
            🛑 EMERGENCY STOP (close + disarm)
          </button>
        </div>
      )}

      {/* Today's account-wide stats — visible whether armed or not so the
          user can audit performance after disarming. */}
      <div className="border-t border-white/10 pt-2 mt-1">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
          Today (Selected Account)
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="Trades" value={String(stats.total)} />
          <Stat
            label="Win Rate"
            value={stats.total > 0 ? `${(stats.winRate * 100).toFixed(0)}%` : "—"}
          />
          <Stat
            label="Realized"
            value={`${stats.realized >= 0 ? "+" : ""}${stats.realized.toFixed(2)}`}
            tone={
              stats.realized > 0 ? "good"
                : stats.realized < 0 ? "bad"
                : "neutral"
            }
          />
        </div>
      </div>

      {/* Deploy confirmation modal — explicit "real orders" warning */}
      {confirmOpen && selectedPreset && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-card border border-card-border rounded-lg p-4 max-w-md w-full mx-4">
            <h4 className="text-foreground font-bold mb-2">
              Deploy &ldquo;{selectedPreset.name}&rdquo;?
            </h4>
            <p className="text-xs text-muted-foreground mb-3">
              The engine will place REAL orders on the active instrument and
              account using this preset&apos;s strategy, filters, and exit rules.
              Confirm the right instrument and account are selected before deploying.
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

/** Compact summary line for what a preset will do — strategy + filters +
 *  exits + daily limits + scaling. Used both in the dropdown picker and
 *  the armed-state status block. Mirrors the old AutoTraderPanel layout
 *  for muscle-memory consistency. */
function PresetSummary({ preset }: { preset: BacktestPreset }) {
  const r = preset.rules;
  const filters = [
    preset.filters.time.enabled &&
      // Show every configured window; older single-window presets
      // normalize to a 1-element array so the join still produces the
      // legacy "Time HH:MM–HH:MM" string.
      `Time ${(preset.filters.time.windows ?? [{ from: preset.filters.time.from, to: preset.filters.time.to }])
        .map((w) => `${w.from}–${w.to}`)
        .join(", ")}`,
    preset.filters.adx.enabled && `ADX ${preset.filters.adx.min}-${preset.filters.adx.max}`,
    preset.filters.atr.enabled && `ATR ${preset.filters.atr.min}-${preset.filters.atr.max}`,
    preset.filters.trend.enabled && `Trend ${preset.filters.trend.ema20Mode}/${preset.filters.trend.ema200Mode}`,
    preset.filters.bollinger.enabled && `BB ${preset.filters.bollinger.allowed.join(",")}`,
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
          <span className="text-muted-foreground/60">Position mode:</span> {r.positionMode}
        </div>
      )}
    </div>
  );
}

/** Visual progress bars for daily realized P&L vs the preset's stop / take.
 *  Two bars: a red one filling rightward as realized loss approaches the
 *  daily SL threshold, and a green one filling rightward as realized gain
 *  approaches the daily TP threshold. Only renders the bars whose limits
 *  are enabled in the preset — silent on a preset with no daily limits. */
function DailyProgress({ engineState }: { engineState: AutoTraderState }) {
  const rules = engineState.preset?.rules;
  if (!rules) return null;
  const day = engineState.dailyRealizedPoints;
  const slEnabled = rules.dailyStopLossEnabled;
  const tpEnabled = rules.dailyTakeProfitEnabled;
  if (!slEnabled && !tpEnabled) return null;

  const slLimit = rules.dailyStopLossPoints;
  const tpLimit = rules.dailyTakeProfitPoints;
  // Loss progress: 0 when day≥0, 100 when day≤-slLimit. Clamp at 100.
  const lossPct = slEnabled
    ? Math.min(100, Math.max(0, (-day / slLimit) * 100))
    : 0;
  const gainPct = tpEnabled
    ? Math.min(100, Math.max(0, (day / tpLimit) * 100))
    : 0;

  return (
    <div className="bg-white/5 rounded p-2 space-y-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
        Daily Limits
      </div>
      {slEnabled && (
        <div>
          <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
            <span>Loss limit</span>
            <span className="font-mono">
              {day < 0 ? day.toFixed(1) : "0.0"} / -{slLimit.toFixed(1)}
            </span>
          </div>
          <div className="h-2 bg-black/30 rounded overflow-hidden">
            <div
              className="h-full bg-accent-red transition-all"
              style={{ width: `${lossPct}%` }}
            />
          </div>
        </div>
      )}
      {tpEnabled && (
        <div>
          <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
            <span>Profit target</span>
            <span className="font-mono">
              {day > 0 ? `+${day.toFixed(1)}` : "0.0"} / +{tpLimit.toFixed(1)}
            </span>
          </div>
          <div className="h-2 bg-black/30 rounded overflow-hidden">
            <div
              className="h-full bg-accent-green transition-all"
              style={{ width: `${gainPct}%` }}
            />
          </div>
        </div>
      )}
      {engineState.dailyHalted && (
        <div className="text-[11px] text-accent-yellow font-bold">
          ⚠ Daily limit hit — engine halted until tomorrow
        </div>
      )}
    </div>
  );
}

/** Active managed position card — entry direction, qty, peak P&L, current
 *  P&L, BE status, and held-bars count if the timed exit is configured. */
function ActivePositionCard({
  activeEntry,
  livePosition,
  currentPnl,
}: {
  activeEntry: NonNullable<AutoTraderState["activeEntry"]>;
  livePosition: LiveState;
  currentPnl: number | null;
}) {
  const isLong = activeEntry.direction === "Long";
  return (
    <div className="bg-white/5 rounded p-2 text-[11px] space-y-1">
      <div className="flex justify-between">
        <span>
          <span className={isLong ? "text-accent-green font-bold" : "text-accent-red font-bold"}>
            {activeEntry.direction.toUpperCase()}
          </span>{" "}
          × {activeEntry.qty} @ {activeEntry.entryPrice.toFixed(2)}
        </span>
        {activeEntry.beTriggered && (
          <span className="text-accent-green text-[10px] px-1.5 py-0.5 bg-accent-green/10 rounded">
            BE armed
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-muted-foreground">
        <div>
          <span className="text-muted-foreground/60">Current:</span>{" "}
          <span className={
            currentPnl == null ? "text-muted-foreground"
              : currentPnl > 0 ? "text-accent-green font-mono"
              : currentPnl < 0 ? "text-accent-red font-mono"
              : "text-foreground font-mono"
          }>
            {currentPnl == null ? "—" : `${currentPnl >= 0 ? "+" : ""}${currentPnl.toFixed(2)} pts`}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground/60">Peak:</span>{" "}
          <span className="font-mono text-foreground">
            +{activeEntry.peakPnl.toFixed(2)} pts
          </span>
        </div>
      </div>
      {livePosition.sl_price != null && (
        <div className="text-muted-foreground">
          <span className="text-muted-foreground/60">SL:</span>{" "}
          <span className="font-mono text-accent-red">{livePosition.sl_price.toFixed(2)}</span>
          {livePosition.tp_price != null && (
            <>
              {"  "}
              <span className="text-muted-foreground/60">TP:</span>{" "}
              <span className="font-mono text-accent-green">{livePosition.tp_price.toFixed(2)}</span>
            </>
          )}
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
    tone === "good" ? "text-accent-green"
      : tone === "bad" ? "text-accent-red"
      : "text-foreground";
  return (
    <div className="bg-white/5 rounded p-1.5">
      <div className="text-muted-foreground/60 text-[10px] uppercase">{label}</div>
      <div className={`font-mono font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}
