"use client";

/**
 * DrawingToolbar — Floating vertical tool strip for chart drawings.
 *
 * Rendered inside the chart container (absolutely positioned). Exposes the
 * four basic tools (horizontal line, vertical line, trend line, rectangle)
 * plus "clear all", a "delete selected" button, and an inline color-picker
 * that only appears when a drawing is selected.
 *
 * Kept purely presentational — all state lives in the useChartDrawings hook
 * so the same toolbar works on both the live chart and the replay chart.
 */
import { useEffect, useState } from "react";
import type { DrawingTool, Drawing } from "@/types/chart-drawings";
import { DRAWING_COLOR_PRESETS } from "@/types/chart-drawings";

interface DrawingToolbarProps {
  activeTool: DrawingTool;
  selectedDrawing: Drawing | null;
  onSelectTool: (tool: DrawingTool) => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  onChangeSelectedColor: (color: string) => void;
  /** Re-arm a previously-fired alert. Only rendered when the selected
   *  drawing is an alert in the fired (armed === false) state. */
  onArmSelected?: () => void;
  /** Show the price-alert tool button. Only the live chart watches for
   *  price crosses, so replay / practice charts should leave this off
   *  — the line would never fire there. Defaults to false. */
  alertsEnabled?: boolean;
}

/** Inline SVG icons — kept as small components to avoid a runtime icon
 *  library dependency. Each uses currentColor so the parent button can
 *  tint them via className. */
const Icons = {
  hline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  ),
  vline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  ),
  trend: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="4" y1="20" x2="20" y2="4" />
    </svg>
  ),
  rect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="6" width="16" height="12" rx="1" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  ),
  clearAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 10l1 10h10l1-10" />
    </svg>
  ),
  alert: (
    // Bell icon — signals "notify me when crossed". Uses the same
    // stroke-based line-icon style as the other tools for visual unity.
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  ),
  rearm: (
    // Circular arrow — "re-arm / reload" affordance for fired alerts.
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  ),
};

interface ToolButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}

function ToolButton({ active, onClick, title, children, disabled }: ToolButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={
        "w-7 h-7 flex items-center justify-center rounded border text-zinc-200 " +
        "transition-colors " +
        (disabled
          ? "bg-zinc-900/60 border-zinc-800 text-zinc-600 cursor-not-allowed"
          : active
            ? "bg-cyan-500/20 border-cyan-400 text-cyan-200"
            : "bg-zinc-800/80 hover:bg-zinc-700 border-zinc-700")
      }
    >
      <span className="w-3.5 h-3.5 block">{children}</span>
    </button>
  );
}

export default function DrawingToolbar({
  activeTool,
  selectedDrawing,
  onSelectTool,
  onDeleteSelected,
  onClearAll,
  onChangeSelectedColor,
  onArmSelected,
  alertsEnabled = false,
}: DrawingToolbarProps) {
  const [colorOpen, setColorOpen] = useState(false);

  // Collapse the picker whenever selection goes away so it doesn't
  // linger over nothing. Running this in an effect (not during render)
  // avoids the "update during render" React warning.
  useEffect(() => {
    if (!selectedDrawing && colorOpen) setColorOpen(false);
  }, [selectedDrawing, colorOpen]);

  const toggle = (tool: DrawingTool) => {
    onSelectTool(activeTool === tool ? null : tool);
  };

  return (
    <div
      className="absolute top-12 left-2 z-40 flex flex-col gap-1 p-1 rounded
                 bg-zinc-900/80 border border-zinc-800 shadow-lg backdrop-blur-sm
                 pointer-events-auto select-none"
      // Stop clicks inside the toolbar from falling through to the chart's
      // click handler (otherwise opening the color picker would also
      // deselect the drawing).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ToolButton active={activeTool === "hline"} onClick={() => toggle("hline")} title="Horizontal line">
        {Icons.hline}
      </ToolButton>
      <ToolButton active={activeTool === "vline"} onClick={() => toggle("vline")} title="Vertical line">
        {Icons.vline}
      </ToolButton>
      <ToolButton active={activeTool === "trend"} onClick={() => toggle("trend")} title="Trend line (2 clicks)">
        {Icons.trend}
      </ToolButton>
      <ToolButton active={activeTool === "rect"} onClick={() => toggle("rect")} title="Rectangle (2 clicks)">
        {Icons.rect}
      </ToolButton>
      {alertsEnabled && (
        <ToolButton
          active={activeTool === "alert"}
          onClick={() => toggle("alert")}
          title="Price alert (notify on cross)"
        >
          {Icons.alert}
        </ToolButton>
      )}

      <div className="h-px bg-zinc-700 my-0.5" />

      <ToolButton
        active={false}
        onClick={onDeleteSelected}
        title="Delete selected (Delete)"
        disabled={!selectedDrawing}
      >
        {Icons.trash}
      </ToolButton>
      <ToolButton active={false} onClick={onClearAll} title="Clear all">
        {Icons.clearAll}
      </ToolButton>

      {/* Re-arm — only shown when a fired alert is selected, so the user
          can put it back in the armed state without redrawing the line. */}
      {selectedDrawing?.kind === "alert" && !selectedDrawing.armed && onArmSelected && (
        <ToolButton
          active={false}
          onClick={onArmSelected}
          title="Re-arm alert"
        >
          {Icons.rearm}
        </ToolButton>
      )}

      {/* Color swatch — only visible when something is selected. */}
      {selectedDrawing && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setColorOpen((v) => !v)}
            title="Change color"
            className="w-7 h-7 rounded border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700
                       flex items-center justify-center"
          >
            <span
              className="w-4 h-4 rounded-sm border border-zinc-900"
              style={{ backgroundColor: selectedDrawing.color }}
            />
          </button>
          {colorOpen && (
            <div
              className="absolute left-9 top-0 z-50 p-1.5 rounded border border-zinc-700
                         bg-zinc-900 shadow-xl grid grid-cols-4 gap-1"
            >
              {DRAWING_COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onChangeSelectedColor(c);
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
      )}
    </div>
  );
}
