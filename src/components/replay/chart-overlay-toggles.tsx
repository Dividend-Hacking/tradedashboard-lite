"use client";

/**
 * ChartOverlayToggles — Small floating chip toolbar anchored to the replay
 * chart that lets the user hide/show three groups of overlays on top of the
 * candlesticks:
 *
 *   - "Active Zones": entry arrow, slanted line, and SL/TP price lines for
 *     zones that are still playing out.
 *   - "Completed Zones": entry arrow, PnL completion circle, and slanted
 *     entry→exit line for zones that have finished (hit TP/SL or run out
 *     their bar window).
 *   - "Trades": practice position entry/exit markers and SL/TP price lines.
 *
 * Splitting active vs completed lets the user keep the currently-playing zone
 * visible while hiding the dense clutter of historical ones.
 *
 * Candlesticks, indicators, and user-drawn annotations are never affected by
 * these toggles — only the zone/trade overlays managed by ReplayChart.
 *
 * State is owned by ReplayViewer and persisted via trader_preferences.chart_overlays.
 */

export type OverlayKey = "activeZones" | "completedZones" | "trades";

interface ChartOverlayTogglesProps {
  showActiveZones: boolean;
  showCompletedZones: boolean;
  showTrades: boolean;
  onChange: (key: OverlayKey, value: boolean) => void;
}

export default function ChartOverlayToggles({
  showActiveZones,
  showCompletedZones,
  showTrades,
  onChange,
}: ChartOverlayTogglesProps) {
  return (
    <div className="absolute right-2 top-2 z-10 flex gap-1">
      <Chip
        label="Active Zones"
        active={showActiveZones}
        onClick={() => onChange("activeZones", !showActiveZones)}
      />
      <Chip
        label="Completed Zones"
        active={showCompletedZones}
        onClick={() => onChange("completedZones", !showCompletedZones)}
      />
      <Chip
        label="Trades"
        active={showTrades}
        onClick={() => onChange("trades", !showTrades)}
      />
    </div>
  );
}

/** Filled when active, outlined/muted when inactive. Matches the visual
 *  vocabulary of the existing sidebar chips in trade-panel.tsx. */
function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-[11px] px-2 py-1 rounded border transition-colors font-medium " +
        (active
          ? "bg-card border-card-border text-foreground hover:border-muted"
          : "bg-background/70 border-card-border text-muted-foreground hover:text-foreground")
      }
      aria-pressed={active}
    >
      <span
        className={
          "inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle " +
          (active ? "bg-accent-green" : "bg-muted/40")
        }
      />
      {label}
    </button>
  );
}
