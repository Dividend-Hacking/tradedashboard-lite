"use client";

/**
 * TradePanel — Sidebar UI for practice trading and zone placement
 * during market replay.
 *
 * Two modes:
 *   - Trade: Enter/exit positions with SL/TP (existing)
 *   - Zone: Place trade zones that extend N bars forward (new)
 */

import { useState, useTransition } from "react";
import { ReplayBar } from "@/types/replay";
import { ZoneSection } from "@/types/trade-zone";
import { PracticeTradingState, PracticePosition } from "@/lib/utils/practice-trading";
import { ZonePracticeState, PracticeZone, getActiveZonePnl, getZoneEffectivePoints, isZoneVisuallyCompleted } from "@/lib/utils/zone-practice";
import { createSection } from "@/lib/sections-actions";

// ─── Mode type ──────────────────────────────────────────────────────────────

export type PanelMode = "trade" | "zone";

// ─── Props ──────────────────────────────────────────────────────────────────

interface TradePanelProps {
  /** Current panel mode */
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
  /** Practice trading state (trade mode) */
  tradingState: PracticeTradingState;
  /** Zone practice state (zone mode) */
  zoneState: ZonePracticeState;
  /** Most recently revealed bar */
  currentBar: ReplayBar | null;
  /** Trade mode callbacks */
  onEnterLong: (slPoints: number | null, tpPoints: number | null) => void;
  onEnterShort: (slPoints: number | null, tpPoints: number | null) => void;
  onExit: () => void;
  onUpdateSl: (price: number | null) => void;
  onUpdateTp: (price: number | null) => void;
  /** Zone mode callbacks */
  onPlaceZone: (direction: "Long" | "Short", targetBars: number) => void;
  onSaveZone: (zone: PracticeZone) => void;
  /** Zone bars state (lifted for keyboard shortcut access) */
  zoneBars: string;
  onZoneBarsChange: (value: string) => void;
  targetBars: number;
  /** Zone SL/TP state (lifted so Shift+B / Shift+S keyboard placements read
   *  the same inputs as the buttons). Stored as strings to let the user edit
   *  freely; parsed to numbers at placement time. */
  zoneSlPoints: string;
  zoneTpPoints: string;
  zoneSlEnabled: boolean;
  zoneTpEnabled: boolean;
  onZoneSlPointsChange: (value: string) => void;
  onZoneTpPointsChange: (value: string) => void;
  onZoneSlEnabledChange: (value: boolean) => void;
  onZoneTpEnabledChange: (value: boolean) => void;
  /** All available zone sections for the Zone-mode section picker. */
  sections: ZoneSection[];
  /** Currently selected section id — zones saved in this session are tagged
   *  with it. May be null if no sections exist yet. */
  activeSectionId: number | null;
  onActiveSectionChange: (id: number | null) => void;
}

export default function TradePanel({
  mode,
  onModeChange,
  tradingState,
  zoneState,
  currentBar,
  onEnterLong,
  onEnterShort,
  onExit,
  onUpdateSl,
  onUpdateTp,
  onPlaceZone,
  onSaveZone,
  zoneBars,
  onZoneBarsChange,
  targetBars,
  zoneSlPoints,
  zoneTpPoints,
  zoneSlEnabled,
  zoneTpEnabled,
  onZoneSlPointsChange,
  onZoneTpPointsChange,
  onZoneSlEnabledChange,
  onZoneTpEnabledChange,
  sections,
  activeSectionId,
  onActiveSectionChange,
}: TradePanelProps) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4 flex flex-col gap-4 h-full">
      {/* ─── Mode Toggle ──────────────────────────────────── */}
      <div className="flex gap-1 bg-background rounded p-0.5">
        <button
          onClick={() => onModeChange("trade")}
          className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
            mode === "trade"
              ? "bg-card text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Trade
        </button>
        <button
          onClick={() => onModeChange("zone")}
          className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
            mode === "zone"
              ? "bg-card text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Zone
        </button>
      </div>

      {mode === "trade" ? (
        <TradeMode
          tradingState={tradingState}
          currentBar={currentBar}
          onEnterLong={onEnterLong}
          onEnterShort={onEnterShort}
          onExit={onExit}
          onUpdateSl={onUpdateSl}
          onUpdateTp={onUpdateTp}
        />
      ) : (
        <ZoneMode
          zoneState={zoneState}
          currentBar={currentBar}
          onPlaceZone={onPlaceZone}
          onSaveZone={onSaveZone}
          zoneBars={zoneBars}
          onZoneBarsChange={onZoneBarsChange}
          targetBars={targetBars}
          zoneSlPoints={zoneSlPoints}
          zoneTpPoints={zoneTpPoints}
          zoneSlEnabled={zoneSlEnabled}
          zoneTpEnabled={zoneTpEnabled}
          onZoneSlPointsChange={onZoneSlPointsChange}
          onZoneTpPointsChange={onZoneTpPointsChange}
          onZoneSlEnabledChange={onZoneSlEnabledChange}
          onZoneTpEnabledChange={onZoneTpEnabledChange}
          sections={sections}
          activeSectionId={activeSectionId}
          onActiveSectionChange={onActiveSectionChange}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE MODE (existing functionality, extracted into sub-component)
// ═══════════════════════════════════════════════════════════════════════════

function TradeMode({
  tradingState,
  currentBar,
  onEnterLong,
  onEnterShort,
  onExit,
}: {
  tradingState: PracticeTradingState;
  currentBar: ReplayBar | null;
  onEnterLong: (slPoints: number | null, tpPoints: number | null) => void;
  onEnterShort: (slPoints: number | null, tpPoints: number | null) => void;
  onExit: () => void;
  onUpdateSl: (price: number | null) => void;
  onUpdateTp: (price: number | null) => void;
}) {
  const [slPoints, setSlPoints] = useState<string>("10");
  const [tpPoints, setTpPoints] = useState<string>("20");
  const [slEnabled, setSlEnabled] = useState(true);
  const [tpEnabled, setTpEnabled] = useState(true);

  const { openPosition, totalPnl, winCount, lossCount, positions } = tradingState;
  const closedPositions = positions.filter((p) => p.status === "closed");
  const totalTrades = closedPositions.length;
  const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(0) : "--";
  const hasPosition = openPosition !== null;
  const canTrade = currentBar !== null && !hasPosition;

  let livePnl: number | null = null;
  if (openPosition && currentBar) {
    livePnl = openPosition.direction === "Long"
      ? currentBar.bar_close - openPosition.entryPrice
      : openPosition.entryPrice - currentBar.bar_close;
    livePnl = Math.round(livePnl * 100) / 100;
  }

  const handleEnter = (direction: "Long" | "Short") => {
    const sl = slEnabled && slPoints ? parseFloat(slPoints) : null;
    const tp = tpEnabled && tpPoints ? parseFloat(tpPoints) : null;
    direction === "Long" ? onEnterLong(sl, tp) : onEnterShort(sl, tp);
  };

  return (
    <>
      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className={`text-lg font-bold font-mono ${totalPnl >= 0 ? "text-accent-green" : "text-accent-red"}`}>
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
          </div>
          <div className="text-xs text-muted-foreground">P&L pts</div>
        </div>
        <div>
          <div className="text-lg font-bold font-mono text-foreground">{totalTrades}</div>
          <div className="text-xs text-muted-foreground">Trades</div>
        </div>
        <div>
          <div className="text-lg font-bold font-mono text-foreground">{winRate}%</div>
          <div className="text-xs text-muted-foreground">Win Rate</div>
        </div>
      </div>

      <div className="border-t border-card-border" />

      {/* SL/TP Inputs */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <input type="checkbox" checked={slEnabled} onChange={(e) => setSlEnabled(e.target.checked)} className="accent-accent-red" />
            Stop Loss (pts)
          </label>
          <input type="number" value={slPoints} onChange={(e) => setSlPoints(e.target.value)} disabled={!slEnabled}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5 text-sm font-mono text-foreground disabled:opacity-40 focus:outline-none focus:border-muted" />
        </div>
        <div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <input type="checkbox" checked={tpEnabled} onChange={(e) => setTpEnabled(e.target.checked)} className="accent-accent-green" />
            Take Profit (pts)
          </label>
          <input type="number" value={tpPoints} onChange={(e) => setTpPoints(e.target.value)} disabled={!tpEnabled}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5 text-sm font-mono text-foreground disabled:opacity-40 focus:outline-none focus:border-muted" />
        </div>
      </div>

      {/* Entry Buttons */}
      {!hasPosition && (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => handleEnter("Long")} disabled={!canTrade}
            className="py-2.5 rounded font-medium text-sm bg-accent-green/20 text-accent-green border border-accent-green/40 hover:bg-accent-green/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            Buy Long
          </button>
          <button onClick={() => handleEnter("Short")} disabled={!canTrade}
            className="py-2.5 rounded font-medium text-sm bg-accent-red/20 text-accent-red border border-accent-red/40 hover:bg-accent-red/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            Sell Short
          </button>
        </div>
      )}

      {/* Open Position */}
      {openPosition && (
        <div className={`p-3 rounded border ${openPosition.direction === "Long" ? "border-accent-green/30 bg-accent-green/5" : "border-accent-red/30 bg-accent-red/5"}`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-sm font-medium ${openPosition.direction === "Long" ? "text-accent-green" : "text-accent-red"}`}>
              {openPosition.direction} @ {openPosition.entryPrice.toFixed(2)}
            </span>
            {livePnl !== null && (
              <span className={`text-sm font-bold font-mono ${livePnl >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                {livePnl >= 0 ? "+" : ""}{livePnl.toFixed(2)}
              </span>
            )}
          </div>
          <div className="flex gap-2 text-xs text-muted-foreground mb-2">
            {openPosition.stopLossPrice && <span>SL: {openPosition.stopLossPrice.toFixed(2)}</span>}
            {openPosition.takeProfitPrice && <span>TP: {openPosition.takeProfitPrice.toFixed(2)}</span>}
          </div>
          <button onClick={onExit}
            className="w-full py-1.5 rounded text-sm font-medium bg-muted/20 text-foreground border border-card-border hover:border-muted transition-colors">
            Close Position
          </button>
        </div>
      )}

      <div className="border-t border-card-border" />

      {/* Trade History */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <h3 className="text-xs text-muted-foreground font-medium mb-2">Trade History</h3>
        {closedPositions.length === 0 ? (
          <p className="text-xs text-muted/60 italic">No trades yet</p>
        ) : (
          <div className="flex flex-col gap-1">
            {closedPositions.slice().reverse().map((pos) => (
              <TradeRow key={pos.id} position={pos} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONE MODE
// ═══════════════════════════════════════════════════════════════════════════

function ZoneMode({
  zoneState,
  currentBar,
  onPlaceZone,
  onSaveZone,
  zoneBars,
  onZoneBarsChange,
  targetBars,
  zoneSlPoints,
  zoneTpPoints,
  zoneSlEnabled,
  zoneTpEnabled,
  onZoneSlPointsChange,
  onZoneTpPointsChange,
  onZoneSlEnabledChange,
  onZoneTpEnabledChange,
  sections,
  activeSectionId,
  onActiveSectionChange,
}: {
  zoneState: ZonePracticeState;
  currentBar: ReplayBar | null;
  onPlaceZone: (direction: "Long" | "Short", targetBars: number) => void;
  onSaveZone: (zone: PracticeZone) => void;
  zoneBars: string;
  onZoneBarsChange: (value: string) => void;
  targetBars: number;
  zoneSlPoints: string;
  zoneTpPoints: string;
  zoneSlEnabled: boolean;
  zoneTpEnabled: boolean;
  onZoneSlPointsChange: (value: string) => void;
  onZoneTpPointsChange: (value: string) => void;
  onZoneSlEnabledChange: (value: boolean) => void;
  onZoneTpEnabledChange: (value: boolean) => void;
  sections: ZoneSection[];
  activeSectionId: number | null;
  onActiveSectionChange: (id: number | null) => void;
}) {
  const { activeZones, zones } = zoneState;
  const completedZones = zones.filter((z) => z.status === "completed");
  // Multiple zones can run in parallel now — only gate on a bar being loaded.
  const canPlace = currentBar !== null;

  // Section create-on-the-fly: sentinel value "__new__" in the <select>
  // prompts for a name, calls the server action, and selects the new row.
  // Wrapped in useTransition so the picker disables while the insert is in
  // flight — avoids the user picking twice before the realtime row arrives.
  const [creatingSection, startSectionCreate] = useTransition();
  const handleSectionChange = (value: string) => {
    if (value === "__new__") {
      const name = window.prompt("New section name:");
      if (!name || !name.trim()) return;
      startSectionCreate(async () => {
        const result = await createSection(name);
        if (result.error) {
          window.alert(`Failed to create section: ${result.error}`);
          return;
        }
        if (result.section) onActiveSectionChange(result.section.id);
      });
      return;
    }
    const id = parseInt(value);
    if (!Number.isNaN(id)) onActiveSectionChange(id);
  };

  // Aggregate stats from "settled" zones — those that are either fully
  // completed OR have already locked in a TP/SL hit. Including hit-but-still-
  // playing zones lets the summary update the moment a level is touched
  // (matches the trader's mental model: the trade is decided at the hit).
  // Uses the SL/TP-aware effective PnL so TP hits score at the TP distance,
  // SL hits at the SL distance, and natural-completion zones fall back to
  // raw end-of-window pointsMove.
  const settledZones = zones.filter(isZoneVisuallyCompleted);
  const totalZones = settledZones.length;
  const effectivePoints = settledZones.map((z) => getZoneEffectivePoints(z));
  const totalPoints = effectivePoints.reduce((s, p) => s + p, 0);
  const wins = effectivePoints.filter((p) => p > 0).length;
  const winRate = totalZones > 0 ? ((wins / totalZones) * 100).toFixed(0) : "--";


  return (
    <>
      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className={`text-lg font-bold font-mono ${totalPoints >= 0 ? "text-accent-green" : "text-accent-red"}`}>
            {totalPoints >= 0 ? "+" : ""}{totalPoints.toFixed(2)}
          </div>
          <div className="text-xs text-muted-foreground">P&L pts</div>
        </div>
        <div>
          <div className="text-lg font-bold font-mono text-foreground">{totalZones}</div>
          <div className="text-xs text-muted-foreground">Zones</div>
        </div>
        <div>
          <div className="text-lg font-bold font-mono text-foreground">{winRate}%</div>
          <div className="text-xs text-muted-foreground">Win Rate</div>
        </div>
      </div>

      <div className="border-t border-card-border" />

      {/* Section Picker — every zone saved this session gets tagged with this
          section. "+ New section…" sentinel creates one on-the-fly. Disabled
          while a section is being created to avoid picker races. */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Section</label>
        <select
          value={activeSectionId ?? ""}
          onChange={(e) => handleSectionChange(e.target.value)}
          disabled={creatingSection}
          className="w-full bg-background border border-card-border rounded px-2 py-1.5
                     text-sm text-foreground focus:outline-none focus:border-muted disabled:opacity-50"
        >
          {sections.length === 0 && <option value="">(no sections)</option>}
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="__new__">+ New section…</option>
        </select>
      </div>

      {/* Zone Length Input */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Zone Length (bars)</label>
        <input
          type="number"
          value={zoneBars}
          onChange={(e) => onZoneBarsChange(e.target.value)}
          min={2}
          max={500}
          className="w-full bg-background border border-card-border rounded px-2 py-1.5
                     text-sm font-mono text-foreground focus:outline-none focus:border-muted"
        />
      </div>

      {/* SL/TP Inputs — visual-only reference lines for the placed zone. The
          zone does NOT close on hit; these just let the user eyeball risk.
          Mirrors the TradeMode SL/TP input pattern (checkbox + points). */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <input
              type="checkbox"
              checked={zoneSlEnabled}
              onChange={(e) => onZoneSlEnabledChange(e.target.checked)}
              className="accent-accent-red"
            />
            Stop Loss (pts)
          </label>
          <input
            type="number"
            value={zoneSlPoints}
            onChange={(e) => onZoneSlPointsChange(e.target.value)}
            disabled={!zoneSlEnabled}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm font-mono text-foreground disabled:opacity-40
                       focus:outline-none focus:border-muted"
          />
        </div>
        <div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <input
              type="checkbox"
              checked={zoneTpEnabled}
              onChange={(e) => onZoneTpEnabledChange(e.target.checked)}
              className="accent-accent-green"
            />
            Take Profit (pts)
          </label>
          <input
            type="number"
            value={zoneTpPoints}
            onChange={(e) => onZoneTpPointsChange(e.target.value)}
            disabled={!zoneTpEnabled}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm font-mono text-foreground disabled:opacity-40
                       focus:outline-none focus:border-muted"
          />
        </div>
      </div>

      {/* Place Zone Buttons — always visible, even while other zones are
          active. Multiple concurrent zones are allowed; each plays out
          independently. */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onPlaceZone("Long", targetBars)}
          disabled={!canPlace}
          className="py-2.5 rounded font-medium text-sm bg-accent-green/20 text-accent-green
                     border border-accent-green/40 hover:bg-accent-green/30
                     disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Long Zone
        </button>
        <button
          onClick={() => onPlaceZone("Short", targetBars)}
          disabled={!canPlace}
          className="py-2.5 rounded font-medium text-sm bg-accent-red/20 text-accent-red
                     border border-accent-red/40 hover:bg-accent-red/30
                     disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Short Zone
        </button>
      </div>

      {/* Active Zones — one card per in-flight zone. Renders the live PnL,
          SL/TP levels, and per-zone progress bar. */}
      {activeZones.length > 0 && (
        <div className="flex flex-col gap-2">
          {activeZones.map((zone) => (
            <ActiveZoneCard key={zone.id} zone={zone} />
          ))}
        </div>
      )}

      <div className="border-t border-card-border" />

      {/* Zone History */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <h3 className="text-xs text-muted-foreground font-medium mb-2">Zone History</h3>
        {completedZones.length === 0 ? (
          <p className="text-xs text-muted/60 italic">No zones yet</p>
        ) : (
          <div className="flex flex-col gap-1">
            {completedZones.slice().reverse().map((zone) => (
              <ZoneRow key={zone.id} zone={zone} onSave={onSaveZone} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ROW COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function TradeRow({ position }: { position: PracticePosition }) {
  const pnl = position.pnlPoints ?? 0;
  return (
    <div className="flex items-center justify-between text-xs py-1.5 px-2 rounded bg-background/50">
      <div className="flex items-center gap-2">
        <span className={position.direction === "Long" ? "text-accent-green" : "text-accent-red"}>
          {position.direction === "Long" ? "▲" : "▼"}
        </span>
        <span className="text-muted-foreground font-mono">
          {position.entryPrice.toFixed(2)} → {position.exitPrice?.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted/60 capitalize">{position.exitReason}</span>
        <span className={`font-mono font-medium ${pnl > 0 ? "text-accent-green" : "text-accent-red"}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

/** Card for an in-flight zone — PnL, SL/TP, progress. Extracted so multiple
 *  concurrent active zones can each render their own card. */
function ActiveZoneCard({ zone }: { zone: PracticeZone }) {
  const pnl = getActiveZonePnl(zone);
  return (
    <div
      className={`p-3 rounded border ${
        zone.direction === "Long"
          ? "border-accent-green/30 bg-accent-green/5"
          : "border-accent-red/30 bg-accent-red/5"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={`text-sm font-medium ${
            zone.direction === "Long" ? "text-accent-green" : "text-accent-red"
          }`}
        >
          {zone.direction} Zone @ {zone.entryPrice.toFixed(2)}
        </span>
        {pnl !== null && (
          <span
            className={`text-sm font-bold font-mono ${
              pnl >= 0 ? "text-accent-green" : "text-accent-red"
            }`}
          >
            {pnl >= 0 ? "+" : ""}
            {pnl.toFixed(2)}
          </span>
        )}
      </div>
      {(zone.stopLossPrice != null || zone.takeProfitPrice != null) && (
        <div className="flex gap-2 text-xs text-muted-foreground">
          {zone.stopLossPrice != null && <span>SL: {zone.stopLossPrice.toFixed(2)}</span>}
          {zone.takeProfitPrice != null && <span>TP: {zone.takeProfitPrice.toFixed(2)}</span>}
        </div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              zone.direction === "Long" ? "bg-accent-green" : "bg-accent-red"
            }`}
            style={{ width: `${(zone.bars.length / zone.targetBars) * 100}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground font-mono">
          {zone.bars.length}/{zone.targetBars}
        </span>
      </div>
    </div>
  );
}

function ZoneRow({ zone, onSave }: { zone: PracticeZone; onSave: (zone: PracticeZone) => void }) {
  // Display the hit-outcome-aware PnL so the row number matches the summary
  // (TP distance on TP hit / SL distance on SL hit / end-of-window otherwise).
  // This is display only — the raw endPrice / pointsMove persisted to
  // trade_zones is unchanged.
  const pnl = getZoneEffectivePoints(zone);
  const isSaved = zone.id.startsWith("saved-");
  // Only draw a hit pill if the zone actually had an SL or TP configured.
  // null hitOutcome + a configured level = "neither touched"; no level = no pill.
  const hadLevels =
    zone.stopLossPrice != null || zone.takeProfitPrice != null;

  return (
    <div className="flex items-center justify-between text-xs py-1.5 px-2 rounded bg-background/50">
      <div className="flex items-center gap-2">
        <span className={zone.direction === "Long" ? "text-accent-green" : "text-accent-red"}>
          {zone.direction === "Long" ? "▲" : "▼"}
        </span>
        <span className="text-muted-foreground font-mono">
          {zone.entryPrice.toFixed(2)} → {zone.endPrice?.toFixed(2)}
        </span>
        <span className="text-muted/60">{zone.bars.length}b</span>
        {hadLevels && <HitPill outcome={zone.hitOutcome ?? null} />}
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-mono font-medium ${pnl > 0 ? "text-accent-green" : "text-accent-red"}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
        </span>
        {isSaved ? (
          <span className="text-accent-green text-[10px]">saved</span>
        ) : (
          <button
            onClick={() => onSave(zone)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-card border border-card-border
                       text-muted-foreground hover:text-foreground hover:border-muted transition-colors"
          >
            save
          </button>
        )}
      </div>
    </div>
  );
}

/** Small colored pill that labels which level price touched first.
 *  tp  → green "TP"    sl  → red "SL"    null → muted "—" (neither hit) */
function HitPill({ outcome }: { outcome: "sl" | "tp" | null }) {
  if (outcome === "tp") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green border border-accent-green/30">
        TP
      </span>
    );
  }
  if (outcome === "sl") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-red/15 text-accent-red border border-accent-red/30">
        SL
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/10 text-muted-foreground border border-card-border">
      —
    </span>
  );
}
