"use client";

/**
 * OptimizeConfigModal — Settings popup for the SL/TP/TSL grid optimizer.
 *
 * Opens when the user clicks the "Optimize SL / TP / TSL" button in the
 * simulator. Lets them tune:
 *   - Min/Max/Step for each of the three search axes (SL, TP, TSL)
 *   - SL:TP risk-reward ratio lock (Free | 1:1 | 1:1.5 | 1:2 | 1:3 | 1:4).
 *     When locked, TP is *derived* from the active stop instead of grid-searched.
 *   - Disable Hard Stop Loss (force TSL-only). When on, SL axis collapses
 *     and the TSL "disabled" sentinel is excluded.
 *   - Whether to also test combos with TSL disabled (existing behavior).
 *
 * The component is purely controlled — config + onChange come from the parent
 * (SimulatorPanel) so values persist across modal opens for the session.
 *
 * Visual language matches the existing modal pattern in simulator-panel.tsx:
 * fixed dark overlay, click-outside-to-close, accent-green for active states,
 * white/5 for neutral surfaces.
 */

import { useMemo } from "react";
import {
  countCombos,
  DEFAULT_OPTIMIZE_CONFIG,
  type OptimizeConfig,
  type OptimizeObjective,
  type ParamRange,
  type SlTpRatio,
} from "@/lib/utils/zone-optimizer";

interface OptimizeConfigModalProps {
  /** Current optimizer config — preloaded into the inputs. */
  config: OptimizeConfig;
  /** Called on every input change so parent state stays in sync. */
  onChange: (next: OptimizeConfig) => void;
  /** Dismiss the modal (Cancel button or backdrop click). */
  onClose: () => void;
  /** Kick off the optimizer with the chosen config (also closes the modal). */
  onRun: (config: OptimizeConfig) => void;
}

/** Ratio options shown in the segmented control. label → ratio value. */
const RATIO_OPTIONS: { label: string; value: SlTpRatio }[] = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "1:1.5", value: 1.5 },
  { label: "1:2", value: 2 },
  { label: "1:3", value: 3 },
  { label: "1:4", value: 4 },
];

/** Objective options shown in the segmented control above the ratio picker.
 *  Total Points = highest aggregate P&L. Sharpe = highest per-trade Sharpe,
 *  i.e. smoothest equity curve, with totalPoints as the tie-breaker.
 *  Balanced = weighted blend (slider exposes the weight). */
const OBJECTIVE_OPTIONS: { label: string; value: OptimizeObjective; helper: string }[] = [
  {
    label: "Total Points",
    value: "total-points",
    helper: "Maximize aggregate P&L (default). Tie-break on profit factor.",
  },
  {
    label: "Balanced",
    value: "balanced",
    helper:
      "Blend both objectives with a tunable weight. The optimizer normalizes each metric across the full search and picks the combo with the best weighted score.",
  },
  {
    label: "Sharpe Ratio",
    value: "sharpe",
    helper:
      "Maximize per-trade Sharpe (mean ÷ stdev of points). Picks smoother equity curves over fat-tailed home runs. Tie-break on total points.",
  },
];

export function OptimizeConfigModal({
  config,
  onChange,
  onClose,
  onRun,
}: OptimizeConfigModalProps) {
  const disableSL = !!config.disableStopLoss;
  const disableTSL = !!config.disableTrailingStop;
  const ratioLocked = (config.slTpRatio ?? null) !== null;

  // Live combo count — recomputed on every config change so the user can see
  // when their settings are about to spawn a 500k-combo run before they hit Go.
  const combos = useMemo(() => countCombos(config), [config]);

  // Color escalation: amber over 100k, red over 500k. Helps users notice they
  // picked a step=1 across wide ranges before kicking off a multi-minute run.
  const comboColorClass =
    combos > 500_000
      ? "text-accent-red"
      : combos > 100_000
      ? "text-accent-amber"
      : "text-muted-foreground";

  /** Patch a single field on the config and propagate to parent. */
  const update = (patch: Partial<OptimizeConfig>) => onChange({ ...config, ...patch });

  /** Patch a single range field (min/max/step) on one of the three axes. */
  const updateRange = (key: "slRange" | "tpRange" | "tslRange", patch: Partial<ParamRange>) =>
    onChange({ ...config, [key]: { ...config[key], ...patch } });

  /** Toggle the disable-SL flag. When turning it ON we also force
   *  includeTslDisabled OFF (TSL must be the sole stop) and clear
   *  disableTrailingStop (mutually exclusive — would leave no stops at all). */
  const toggleDisableSL = () => {
    const next = !disableSL;
    onChange({
      ...config,
      disableStopLoss: next,
      includeTslDisabled: next ? false : config.includeTslDisabled,
      disableTrailingStop: next ? false : config.disableTrailingStop,
    });
  };

  /** Toggle the disable-TSL flag. Mutually exclusive with disableSL. When
   *  turning ON we also clear includeTslDisabled (it's meaningless once TSL
   *  is forced off for every combo). */
  const toggleDisableTSL = () => {
    const next = !disableTSL;
    onChange({
      ...config,
      disableTrailingStop: next,
      disableStopLoss: next ? false : config.disableStopLoss,
      includeTslDisabled: next ? false : config.includeTslDisabled,
    });
  };

  // Helper text under the ratio selector — explains the derivation base when
  // a non-Free ratio is selected so users know whether TP comes from SL or TSL.
  const ratioHelper = ratioLocked
    ? `TP is derived: TP = ${disableSL ? "TSL" : "SL"} × ratio (kept exact, clamped to TP min/max).`
    : "Free mode searches the full TP range.";

  // Active objective + matching helper text under the objective selector.
  const objective: OptimizeObjective = config.objective ?? "total-points";
  const objectiveHelper =
    OBJECTIVE_OPTIONS.find((o) => o.value === objective)?.helper ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-card border border-card-border rounded-lg p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-foreground">Optimize SL / TP / TSL</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* ── Objective selector ─────────────────────────────────────
            Picks the function the optimizer maximizes. "Total Points" is
            the historical default (raw aggregate P&L). "Sharpe Ratio"
            favors smoother equity curves — useful when total P&L looks
            good but the path was rough (lots of variance per trade). */}
        <section className="mb-5">
          <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">
            Objective
          </div>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Optimization objective">
            {OBJECTIVE_OPTIONS.map((opt) => {
              const active = objective === opt.value;
              return (
                <button
                  key={opt.value}
                  role="radio"
                  aria-checked={active}
                  onClick={() => update({ objective: opt.value })}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent-green/20 text-accent-green"
                      : "bg-white/5 text-muted-foreground hover:bg-white/10"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-2">{objectiveHelper}</p>

          {/* Balanced-mode weight slider — only visible when "Balanced"
              is the active objective. Single 0..100% slider where the
              displayed value is the points weight (i.e. 70% points means
              the score is 0.7·np + 0.3·ns). End labels reinforce which
              direction emphasizes which metric. */}
          {objective === "balanced" && (
            <div className="mt-3 bg-white/5 border border-card-border rounded-md px-3 py-3">
              <div className="flex items-center justify-between mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                <span>Sharpe priority</span>
                <span>Points priority</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round((config.balancedPointsWeight ?? 0.5) * 100)}
                onChange={(e) =>
                  update({ balancedPointsWeight: Number(e.target.value) / 100 })
                }
                className="w-full accent-accent-green"
                aria-label="Points weight (vs. Sharpe)"
              />
              <div className="flex items-center justify-center mt-2 text-xs text-muted-foreground">
                {(() => {
                  const pw = Math.round((config.balancedPointsWeight ?? 0.5) * 100);
                  const sw = 100 - pw;
                  return (
                    <span>
                      {pw}% points · {sw}% Sharpe
                      {pw === 100 && " (= Total Points only)"}
                      {pw === 0 && " (= Sharpe only)"}
                      {pw === 50 && " (equal blend)"}
                    </span>
                  );
                })()}
              </div>
            </div>
          )}
        </section>

        {/* ── Ratio selector ─────────────────────────────────────────── */}
        <section className="mb-5">
          <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">
            SL : TP Ratio Lock
          </div>
          <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Risk-reward ratio">
            {RATIO_OPTIONS.map((opt) => {
              const active = (config.slTpRatio ?? null) === opt.value;
              return (
                <button
                  key={opt.label}
                  role="radio"
                  aria-checked={active}
                  onClick={() => update({ slTpRatio: opt.value })}
                  className={`px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent-green/20 text-accent-green"
                      : "bg-white/5 text-muted-foreground hover:bg-white/10"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-2">{ratioHelper}</p>
        </section>

        {/* ── Range inputs ───────────────────────────────────────────── */}
        <section className="space-y-3 mb-5">
          {/* Stop Loss row — dimmed when disable-SL is on. */}
          <RangeRow
            label="Stop Loss"
            range={config.slRange}
            onChange={(patch) => updateRange("slRange", patch)}
            disabled={disableSL}
            helper={disableSL ? "Hard SL disabled — SL axis skipped." : undefined}
          />

          {/* Take Profit — dimmed when ratio locked (TP becomes derived).
              We keep min/max editable even when dimmed so users can still
              clamp the derived values within bounds; the step input is
              irrelevant in ratio mode and gets disabled. */}
          <RangeRow
            label="Take Profit"
            range={config.tpRange}
            onChange={(patch) => updateRange("tpRange", patch)}
            // Visual dim only — keep min/max usable for clamping.
            dimmed={ratioLocked}
            stepDisabled={ratioLocked}
            helper={
              ratioLocked
                ? `Derived from ${disableSL ? "TSL" : "SL"} × ratio; min/max still clamp.`
                : undefined
            }
          />

          {/* Trailing Stop — dimmed when TSL is fully disabled for the run. */}
          <RangeRow
            label="Trailing Stop"
            range={config.tslRange}
            onChange={(patch) => updateRange("tslRange", patch)}
            disabled={disableTSL}
            helper={disableTSL ? "TSL disabled — trailing stop axis skipped." : undefined}
          />
        </section>

        {/* ── Toggle row ─────────────────────────────────────────────── */}
        <section className="grid grid-cols-3 gap-2 mb-5">
          <ToggleButton
            label="Disable Hard SL (TSL only)"
            active={disableSL}
            onClick={toggleDisableSL}
            disabled={disableTSL}
            title={
              disableTSL
                ? "Can't disable both stops — turn off 'Disable TSL' first."
                : "Forces stopLossEnabled off and requires TSL on every combo."
            }
          />
          <ToggleButton
            label="Disable TSL (SL only)"
            active={disableTSL}
            onClick={toggleDisableTSL}
            disabled={disableSL}
            title={
              disableSL
                ? "Can't disable both stops — turn off 'Disable Hard SL' first."
                : "Forces trailingStopEnabled off; the optimizer searches SL × TP only."
            }
          />
          <ToggleButton
            label="Also test without TSL"
            active={!!config.includeTslDisabled}
            onClick={() => update({ includeTslDisabled: !config.includeTslDisabled })}
            disabled={disableSL || disableTSL}
            title={
              disableSL
                ? "Required off when hard SL is disabled — TSL is the only stop."
                : disableTSL
                ? "Already disabled for every combo — toggle has no effect."
                : "Adds combos where the trailing stop is disabled."
            }
          />
        </section>

        {/* ── Combo count + actions ─────────────────────────────────── */}
        <div className="flex items-center justify-between pt-3 border-t border-card-border/50">
          <div className={`text-sm font-medium ${comboColorClass}`}>
            {combos.toLocaleString()} combinations
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onChange(DEFAULT_OPTIMIZE_CONFIG)}
              className="px-3 py-2 rounded-md text-sm font-medium bg-white/5 text-foreground hover:bg-white/10 transition-colors"
            >
              Reset Defaults
            </button>
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-md text-sm font-medium bg-white/5 text-foreground hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onRun(config)}
              disabled={combos === 0}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                combos === 0
                  ? "bg-white/5 text-muted-foreground cursor-not-allowed"
                  : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
              }`}
            >
              Run Optimizer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

interface RangeRowProps {
  label: string;
  range: ParamRange;
  onChange: (patch: Partial<ParamRange>) => void;
  /** Fully disable all three inputs (used when SL axis is collapsed). */
  disabled?: boolean;
  /** Visually dim but keep editable (used for TP min/max in ratio mode). */
  dimmed?: boolean;
  /** Specifically disable the step input (TP step is meaningless in ratio mode). */
  stepDisabled?: boolean;
  /** Optional caption below the row. */
  helper?: string;
}

/** A labeled three-input row (Min / Max / Step) for a ParamRange. */
function RangeRow({
  label,
  range,
  onChange,
  disabled = false,
  dimmed = false,
  stepDisabled = false,
  helper,
}: RangeRowProps) {
  const baseInput =
    "w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent-green disabled:opacity-40 disabled:cursor-not-allowed";

  const fieldOpacity = disabled || dimmed ? "opacity-60" : "opacity-100";

  return (
    <div className={`transition-opacity ${fieldOpacity}`}>
      <div className="flex items-center gap-3">
        <div className="w-28 text-sm text-foreground font-medium">{label}</div>
        <div className="flex items-center gap-2 flex-1">
          <NumberField
            label="Min"
            value={range.min}
            onChange={(v) => onChange({ min: v })}
            disabled={disabled}
            className={baseInput}
          />
          <NumberField
            label="Max"
            value={range.max}
            onChange={(v) => onChange({ max: v })}
            disabled={disabled}
            className={baseInput}
          />
          <NumberField
            label="Step"
            value={range.step}
            onChange={(v) => onChange({ step: v })}
            disabled={disabled || stepDisabled}
            className={baseInput}
            step={0.25}
            min={0.25}
          />
        </div>
      </div>
      {helper && <div className="text-xs text-muted-foreground mt-1 ml-[7.25rem]">{helper}</div>}
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  className?: string;
  step?: number;
  min?: number;
}

/**
 * Single labeled number input. Uses defaultValue + onChange (uncontrolled)
 * so typing doesn't lose focus on parent re-renders. Coerces NaN to 0 to
 * avoid breaking the optimizer's range arithmetic.
 */
function NumberField({
  label,
  value,
  onChange,
  disabled = false,
  className = "",
  step = 1,
  min = 0,
}: NumberFieldProps) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="number"
        // Keying on `value` resets the input when the parent (e.g., Reset
        // Defaults) replaces the whole config — without this, defaultValue
        // stays stale because React keeps the old DOM node.
        key={`${label}-${value}`}
        defaultValue={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        disabled={disabled}
        step={step}
        min={min}
        className={className}
      />
    </label>
  );
}

interface ToggleButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

/** Two-state styled button — same visual language as the rules toggles
 *  in simulator-controls.tsx. Active = accent-green; inactive = white/5. */
function ToggleButton({ label, active, onClick, disabled = false, title }: ToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`px-3 py-2 rounded-md text-sm font-medium transition-colors text-left ${
        disabled
          ? "bg-white/5 text-muted-foreground/50 cursor-not-allowed"
          : active
          ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
          : "bg-white/5 text-muted-foreground hover:bg-white/10"
      }`}
    >
      {label}
    </button>
  );
}
