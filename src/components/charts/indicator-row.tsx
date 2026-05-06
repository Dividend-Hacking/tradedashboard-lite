"use client";

/**
 * IndicatorRow — One configured indicator inside the IndicatorPanel list.
 *
 * Presentational: renders the toggle, kind label, period input, color
 * swatch with a popover picker, and a remove (×) button. All edits are
 * funneled back to the parent panel via small callbacks so the parent
 * owns the full configs array.
 *
 * Kept as its own file so the panel component stays focused on layout +
 * add/remove orchestration.
 */

import { useState } from "react";
import type { IndicatorConfig } from "@/types/indicators";
import { INDICATOR_DEFAULTS } from "@/types/indicators";
import { DRAWING_COLOR_PRESETS } from "@/types/chart-drawings";

interface IndicatorRowProps {
  config: IndicatorConfig;
  /** Patch a subset of fields on this indicator. The parent merges and
   *  emits the new array via its own onChange. */
  onPatch: (patch: Partial<IndicatorConfig>) => void;
  /** Remove this indicator entirely. */
  onRemove: () => void;
}

export default function IndicatorRow({ config, onPatch, onRemove }: IndicatorRowProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const defaults = INDICATOR_DEFAULTS[config.kind];
  const periodSupported = defaults.period !== undefined;

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-800
                 bg-zinc-900/60"
    >
      {/* ─── Enable/disable toggle ──────────────────────────────────── */}
      {/* Soft toggle: unchecks remove the series but preserve the config
          so period/color are still there when re-enabled. */}
      <button
        type="button"
        onClick={() => onPatch({ enabled: !config.enabled })}
        title={config.enabled ? "Disable" : "Enable"}
        className={
          "w-8 h-4 relative rounded-full transition-colors shrink-0 " +
          (config.enabled ? "bg-cyan-500/80" : "bg-zinc-700")
        }
      >
        <span
          className={
            "absolute top-0.5 w-3 h-3 rounded-full bg-zinc-100 transition-transform " +
            (config.enabled ? "translate-x-4" : "translate-x-0.5")
          }
        />
      </button>

      {/* ─── Kind label ─────────────────────────────────────────────── */}
      <div className="text-xs font-medium text-zinc-200 w-12 shrink-0">
        {defaults.label}
      </div>

      {/* ─── Period input ───────────────────────────────────────────── */}
      {/* Hidden entirely for indicators without a period (volume) so the
          row doesn't render an empty field. */}
      {periodSupported ? (
        <input
          type="number"
          min={1}
          max={500}
          value={config.period ?? defaults.period ?? 14}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) onPatch({ period: n });
          }}
          className="w-14 px-1.5 py-0.5 text-xs bg-zinc-800 border border-zinc-700
                     rounded text-zinc-100 focus:outline-none focus:border-cyan-500"
        />
      ) : (
        <div className="w-14 shrink-0" />
      )}

      {/* ─── Color swatch + picker ──────────────────────────────────── */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setColorOpen((v) => !v)}
          title="Change color"
          className="w-5 h-5 rounded-sm border border-zinc-700 bg-zinc-800
                     flex items-center justify-center"
        >
          <span
            className="w-3.5 h-3.5 rounded-sm border border-zinc-900"
            style={{ backgroundColor: config.color }}
          />
        </button>
        {colorOpen && (
          // Reuses the same palette as the drawing tool color picker so
          // indicator + drawing color vocabularies stay aligned.
          <div
            className="absolute right-0 top-6 z-50 p-1.5 rounded border border-zinc-700
                       bg-zinc-900 shadow-xl grid grid-cols-4 gap-1"
          >
            {DRAWING_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  onPatch({ color: c });
                  setColorOpen(false);
                }}
                title={c}
                className="w-5 h-5 rounded-sm border border-zinc-700 hover:scale-110 transition-transform"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ─── Spacer + remove button ─────────────────────────────────── */}
      <div className="flex-1" />
      <button
        type="button"
        onClick={onRemove}
        title="Remove indicator"
        className="w-5 h-5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800
                   flex items-center justify-center text-base leading-none"
      >
        ×
      </button>
    </div>
  );
}
