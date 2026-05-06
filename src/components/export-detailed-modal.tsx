"use client";

/**
 * ExportDetailedModal — Configures the AI-friendly trade export.
 *
 * Mirrors the visual language of OptimizeConfigModal (dark backdrop,
 * click-outside-to-close, accent-green active states). The user picks how
 * many bars of pre-entry context they want bundled with each trade — capped
 * at the maximum we pre-fetched in SimulatorPanel — then hits "Export". All
 * the actual file-building work lives in zone-detailed-export.ts; this
 * component is purely UI + a click handler.
 */

import { useState } from "react";

interface ExportDetailedModalProps {
  /** How many trades will be included — surfaced in the modal so the user
   *  can sanity-check before downloading. */
  tradeCount: number;
  /** Hard ceiling for the slider — should match what the panel pre-fetched
   *  via fetchZonePreEntryBars (currently 30). */
  maxPreEntryBars: number;
  /** Default value for the slider (a reasonable starting point). */
  defaultPreEntryBars?: number;
  /** Dismiss the modal (Cancel button or backdrop click). */
  onClose: () => void;
  /** Trigger the export with the chosen pre-entry bar count. The parent owns
   *  the actual download wiring. */
  onExport: (preEntryBarsCount: number) => void;
  /** Optional CSV export — emits a per-trade row table with the same column
   *  schema as the NinjaScript backtest_trades CSV so the diff tool
   *  (scripts/diff-backtests.mjs) can align them. Doesn't take a
   *  pre-entry bar count because the CSV is per-trade only. When
   *  undefined, the CSV button is hidden. */
  onExportNt8Csv?: () => void;
}

export function ExportDetailedModal({
  tradeCount,
  maxPreEntryBars,
  defaultPreEntryBars = 20,
  onClose,
  onExport,
  onExportNt8Csv,
}: ExportDetailedModalProps) {
  // Clamp the default to the available range so we never start with an
  // unreachable value (e.g. if the parent ever lowers maxPreEntryBars).
  const initial = Math.max(0, Math.min(defaultPreEntryBars, maxPreEntryBars));
  const [preEntryBars, setPreEntryBars] = useState(initial);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-card border border-card-border rounded-lg p-6 w-full max-w-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-foreground">Export For AI Analysis</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Description */}
        <p className="text-sm text-muted-foreground mb-5">
          Downloads a JSON file containing every simulated trade with full bar
          data — entry / exit, SL / TP / TSL levels, per-bar trailing stop and
          break-even state, ATR, and market context. Drop the file into ChatGPT
          / Claude to ask for pattern analysis.
        </p>

        {/* Pre-entry bar slider */}
        <section className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wide">
              Pre-Entry Bars
            </label>
            <span className="text-sm font-medium text-foreground tabular-nums">
              {preEntryBars}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxPreEntryBars}
            step={1}
            value={preEntryBars}
            onChange={(e) => setPreEntryBars(Number(e.target.value))}
            className="w-full accent-accent-green"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>0</span>
            <span>{maxPreEntryBars}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            How many bars BEFORE each entry to include. Lets the AI see the
            setup that led into the trade. Pulled from the matching replay
            session — trades without a replay match will include fewer bars
            (or none) regardless of this value.
          </p>
        </section>

        {/* Trade count summary */}
        <div className="bg-white/5 rounded-md px-3 py-2 mb-5 text-sm">
          <span className="text-muted-foreground">Trades to export: </span>
          <span className="font-medium text-foreground tabular-nums">{tradeCount}</span>
        </div>

        {/* Footer buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          {onExportNt8Csv && (
            <button
              onClick={onExportNt8Csv}
              disabled={tradeCount === 0}
              title="Per-trade CSV using the same column schema as NinjaScript's backtest_trades export — pair with scripts/diff-backtests.mjs to find parity bugs."
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-white/5 text-foreground hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Export CSV (NT8 diff)
            </button>
          )}
          <button
            onClick={() => onExport(preEntryBars)}
            disabled={tradeCount === 0}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Export JSON
          </button>
        </div>
      </div>
    </div>
  );
}
