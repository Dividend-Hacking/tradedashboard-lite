"use client";

/**
 * OptimizeAtrConfigModal — Settings popup for the ATR-Adjust grid optimizer.
 *
 * Opens when the user clicks the "Optimize ATR Adjust" button in the
 * simulator. Lets them tune per-axis min/max/step for the three ATR adjustment
 * fields (SL, TP, Trailing Stop). The user's base SL/TP/Trail point values
 * stay FROZEN — only the adjustment terms vary.
 *
 * Why a modal now: the default range was -2..+2 which can pick negative
 * adjustments. Some users want to constrain the search to positive-only
 * (wider stops in high-vol regimes) or tighter bounds, and were surprised
 * when the optimizer returned negative values. This surface exposes the
 * ranges so the user owns the search space.
 *
 * The component is purely controlled — config + onChange come from the parent
 * so values persist across modal opens for the session.
 *
 * Visual language matches optimize-config-modal.tsx so the two popups feel
 * like siblings in the simulator toolbar.
 */

import { useMemo } from "react";
import {
  DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG,
  type AtrAdjustOptimizeConfig,
  type ParamRange,
} from "@/lib/utils/zone-optimizer";

interface OptimizeAtrConfigModalProps {
  /** Current ATR-adjust optimizer config — preloaded into the inputs. */
  config: AtrAdjustOptimizeConfig;
  /** Called on every input change so parent state stays in sync. */
  onChange: (next: AtrAdjustOptimizeConfig) => void;
  /** Dismiss the modal (Cancel button or backdrop click). */
  onClose: () => void;
  /** Kick off the optimizer with the chosen config (also closes the modal). */
  onRun: (config: AtrAdjustOptimizeConfig) => void;
}

/** Inclusive count of values along a range for combo math. */
function rangeCount(r: ParamRange): number {
  if (r.step <= 0 || r.min > r.max) return 0;
  return Math.floor((r.max - r.min) / r.step + 1e-9) + 1;
}

export function OptimizeAtrConfigModal({
  config,
  onChange,
  onClose,
  onRun,
}: OptimizeAtrConfigModalProps) {
  // Total combos = product of axis counts. Shown live so the user sees when
  // a small step blows up the search space (0.1 step on -2..+2 = ~68k combos).
  const combos = useMemo(
    () =>
      rangeCount(config.slAdjustRange) *
      rangeCount(config.tpAdjustRange) *
      rangeCount(config.trailAdjustRange),
    [config]
  );

  // Same color escalation the SL/TP modal uses so the visual warning is consistent.
  const comboColorClass =
    combos > 500_000
      ? "text-accent-red"
      : combos > 100_000
      ? "text-accent-amber"
      : "text-muted-foreground";

  const updateRange = (
    key: "slAdjustRange" | "tpAdjustRange" | "trailAdjustRange",
    patch: Partial<ParamRange>
  ) => onChange({ ...config, [key]: { ...config[key], ...patch } });

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
          <h3 className="text-lg font-bold text-foreground">Optimize ATR Adjust</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Explainer — users need to know what these numbers mean, since ATR
            multipliers are less familiar than points. */}
        <p className="text-xs text-muted-foreground mb-4">
          Each axis is an additive multiplier on top of your base points:
          <span className="text-foreground"> effective = basePoints + adjust × zoneATR(14)</span>.
          Set min ≥ 0 to restrict the search to positive adjustments only
          (wider stops in high-vol regimes). Negative adjustments tighten
          stops in high-vol regimes.
        </p>

        {/* ── Range inputs ───────────────────────────────────────────── */}
        <section className="space-y-3 mb-5">
          <RangeRow
            label="Stop Loss ± ATR"
            range={config.slAdjustRange}
            onChange={(patch) => updateRange("slAdjustRange", patch)}
          />
          <RangeRow
            label="Take Profit ± ATR"
            range={config.tpAdjustRange}
            onChange={(patch) => updateRange("tpAdjustRange", patch)}
          />
          <RangeRow
            label="Trailing Stop ± ATR"
            range={config.trailAdjustRange}
            onChange={(patch) => updateRange("trailAdjustRange", patch)}
          />
        </section>

        {/* ── Combo count + actions ─────────────────────────────────── */}
        <div className="flex items-center justify-between pt-3 border-t border-card-border/50">
          <div className={`text-sm font-medium ${comboColorClass}`}>
            {combos.toLocaleString()} combinations
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onChange(DEFAULT_ATR_ADJUST_OPTIMIZE_CONFIG)}
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
}

/** A labeled three-input row (Min / Max / Step) for a ParamRange. ATR
 *  adjustments are unitless multipliers so min can be negative — the input's
 *  native min attribute is left open. */
function RangeRow({ label, range, onChange }: RangeRowProps) {
  const baseInput =
    "w-20 bg-card border border-card-border rounded-md px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent-green";

  return (
    <div className="flex items-center gap-3">
      <div className="w-40 text-sm text-foreground font-medium">{label}</div>
      <div className="flex items-center gap-2 flex-1">
        <NumberField
          label="Min"
          value={range.min}
          onChange={(v) => onChange({ min: v })}
          className={baseInput}
          step={0.25}
        />
        <NumberField
          label="Max"
          value={range.max}
          onChange={(v) => onChange({ max: v })}
          className={baseInput}
          step={0.25}
        />
        <NumberField
          label="Step"
          value={range.step}
          onChange={(v) => onChange({ step: v })}
          className={baseInput}
          step={0.05}
          min={0.05}
        />
      </div>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  className?: string;
  step?: number;
  min?: number;
}

/** Single labeled number input. Uses defaultValue + keyed remount so Reset
 *  Defaults correctly rehydrates the UI (same pattern as optimize-config-modal). */
function NumberField({
  label,
  value,
  onChange,
  className = "",
  step = 1,
  min,
}: NumberFieldProps) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="number"
        key={`${label}-${value}`}
        defaultValue={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        step={step}
        min={min}
        className={className}
      />
    </label>
  );
}
