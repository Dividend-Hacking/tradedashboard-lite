"use client";

/**
 * IndicatorPanel — Floating button + slide-out panel for managing chart
 * indicators (SMA / EMA / Volume / ATR / ADX).
 *
 * Rendered inside the chart container (absolutely positioned, top-right
 * so it doesn't collide with the DrawingToolbar on the left). Exposes:
 *   - An "fx" button that toggles the panel open/closed
 *   - A list of currently-configured indicators (one IndicatorRow each)
 *   - A row of "Add …" buttons for each kind in the starter library
 *
 * Pure presentation — the full configs array is owned by the parent
 * chart/trader component so it can debounce-save to Supabase. This
 * component just emits a new array via onChange on every edit.
 */

import { useEffect, useRef, useState } from "react";
import type { IndicatorConfig, IndicatorKind } from "@/types/indicators";
import { INDICATOR_DEFAULTS, INDICATOR_KINDS, makeDefaultIndicator } from "@/types/indicators";
import IndicatorRow from "./indicator-row";

interface IndicatorPanelProps {
  /** Full indicator configs array for this chart. Order matters — it
   *  defines pane order for sub-indicators. */
  configs: IndicatorConfig[];
  /** Emits a new configs array on any add / remove / toggle / patch. */
  onChange: (next: IndicatorConfig[]) => void;
}

/** Fallback uuid generator — crypto.randomUUID is available in modern
 *  browsers but we keep a timestamp+random fallback for very old
 *  engines so the panel never crashes on an add click. */
function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function IndicatorPanel({ configs, onChange }: IndicatorPanelProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the panel when clicking outside of it (but not when clicking
  // the toggle button itself). Keeps the chart click-through behavior
  // from interfering — we just check document-level clicks.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // ─── Config mutation helpers ─────────────────────────────────────
  // All mutations go through onChange with a fresh array — the parent
  // owns state and persistence.

  const addIndicator = (kind: IndicatorKind) => {
    onChange([...configs, makeDefaultIndicator(kind, makeId())]);
  };

  const patchIndicator = (id: string, patch: Partial<IndicatorConfig>) => {
    onChange(configs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeIndicator = (id: string) => {
    onChange(configs.filter((c) => c.id !== id));
  };

  return (
    <div
      ref={panelRef}
      className="absolute top-12 right-2 z-40 pointer-events-auto select-none"
      // Stop propagation so opening the picker / interacting with inputs
      // doesn't fall through to the chart's click handler (which would
      // treat the click as a "place drawing" or "deselect" gesture).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* ─── Toggle button ──────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Indicators"
        className={
          "w-8 h-8 flex items-center justify-center rounded border " +
          "transition-colors shadow-lg backdrop-blur-sm " +
          (open
            ? "bg-cyan-500/20 border-cyan-400 text-cyan-200"
            : "bg-zinc-900/80 hover:bg-zinc-800 border-zinc-700 text-zinc-200")
        }
      >
        {/* "fx" — compact universal label for studies / indicators */}
        <span className="text-xs font-semibold italic">fx</span>
      </button>

      {/* ─── Expanded panel ─────────────────────────────────────────── */}
      {open && (
        <div
          className="absolute top-10 right-0 w-80 max-h-[70vh] overflow-y-auto
                     p-2 rounded-md border border-zinc-800 bg-zinc-900/95
                     backdrop-blur-sm shadow-2xl"
        >
          {/* Active indicators section — only rendered when there's at
              least one config, to avoid an empty-section heading. */}
          {configs.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1 mb-1">
                Active
              </div>
              <div className="flex flex-col gap-1">
                {configs.map((cfg) => (
                  <IndicatorRow
                    key={cfg.id}
                    config={cfg}
                    onPatch={(patch) => patchIndicator(cfg.id, patch)}
                    onRemove={() => removeIndicator(cfg.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Add section — five buttons, one per kind. Clicking appends
              a new config with the kind's default period + color. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1 mb-1">
              Add
            </div>
            <div className="grid grid-cols-3 gap-1">
              {INDICATOR_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addIndicator(kind)}
                  className="px-2 py-1.5 text-xs font-medium rounded border border-zinc-700
                             bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 transition-colors"
                >
                  {INDICATOR_DEFAULTS[kind].label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
