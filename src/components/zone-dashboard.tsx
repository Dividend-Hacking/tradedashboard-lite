/**
 * ZoneDashboard Component (Client)
 *
 * Main orchestrator for the trade zones analysis tab. Owns zone data state,
 * filter state, and derives all stats/charts via useMemo. Mirrors the
 * architecture of Dashboard but focused on trade zone analysis.
 *
 * Subscribes to Supabase Realtime for live updates when new zones are drawn.
 */

"use client";

import { useState, useMemo, useEffect } from "react";
import { TradeZone, ZoneSection } from "@/types/trade-zone";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import { rawDateString } from "@/lib/utils/format";
import {
  computeZoneSummaryStats,
  buildZonePointsChart,
  buildZoneEquityCurve,
  buildZonesByDirection,
  buildZonesByTimeOfDay,
  buildZonesByDuration,
  buildZonesByInstrument,
  buildZonesByAdx,
  buildZonesByAtr,
  buildZonesByEma20,
  buildZonesByBollinger,
  buildZonesByDayOfWeek,
} from "@/lib/utils/zone-stats";
import { ZoneStatCards } from "./zone-stat-cards";
import { ZoneTable } from "./zone-table";
import { PnlByCategory } from "./charts/pnl-by-category";
import { ZonePointsChart } from "./charts/zone-points-chart";
import { ZoneEquityCurve } from "./charts/zone-equity-curve";
import { deleteZones } from "@/app/actions";
import { SimulatorPanel } from "./simulator-panel";
import { ManageSectionsPanel } from "./sections/manage-sections-panel";

interface ZoneDashboardProps {
  zones: TradeZone[];
  sections: ZoneSection[];
}

export function ZoneDashboard({
  zones: initialZones,
  sections: initialSections,
}: ZoneDashboardProps) {
  const mode = useMode();

  // ─── Local zones state for optimistic updates ──────────────────────
  const [zones, setZones] = useState<TradeZone[]>(initialZones);

  // ─── Local sections state kept in sync via realtime subscription ───
  const [sections, setSections] = useState<ZoneSection[]>(initialSections);

  // ─── Selection state for multi-select deletion ─────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ─── Filter State ──────────────────────────────────────────────────
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  // ─── Simulator toggle + section picker ────────────────────────────
  // Because the simulator fetches every bar for every zone it receives, and
  // the zone count has grown past several thousand, opening the simulator
  // with ALL sections loaded was becoming slow. Flow now is:
  //   1. Click "Risk Simulator" → picker modal opens.
  //   2. User selects which sections to load (defaults to just "default").
  //   3. Confirm → simulator mounts with ONLY those sections' zones.
  // simulatorSectionIds is empty until the user has confirmed the picker
  // at least once; while empty we treat the simulator as closed.
  const [simulatorOpen, setSimulatorOpen] = useState(false);
  const [simulatorPickerOpen, setSimulatorPickerOpen] = useState(false);
  const [simulatorSectionIds, setSimulatorSectionIds] = useState<Set<number>>(
    new Set()
  );

  // ─── Manage sections modal toggle ─────────────────────────────────
  const [manageSectionsOpen, setManageSectionsOpen] = useState(false);

  // ─── Realtime subscription: keep zones state live ──────────────────
  // Cloud mode taps Supabase Realtime; local mode polls every ~2s. The
  // upsert-by-id pattern handles both insert and update without us
  // needing separate handlers; deletes only fire in cloud mode (local
  // deletes flow through handleDelete's optimistic state update).
  useEffect(() => {
    const store = getClientStore(mode);
    return store.zones.subscribeZones((row, kind) => {
      if (kind === "delete") {
        setZones((prev) => prev.filter((z) => z.id !== row.id));
        return;
      }
      setZones((prev) => {
        const idx = prev.findIndex((z) => z.id === row.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = row;
          return next;
        }
        return [...prev, row].sort(
          (a, b) =>
            new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
        );
      });
    });
  }, [mode]);

  // ─── Realtime subscription: keep zone_sections state live ─────────
  // Mirrors the trade_zones subscription above. Keeps dropdowns in the
  // replay panel and simulator in sync when a section is created/renamed/
  // deleted in the manage panel (including from another tab).
  useEffect(() => {
    const store = getClientStore(mode);
    return store.zones.subscribeSections((row, kind) => {
      if (kind === "delete") {
        setSections((prev) => prev.filter((s) => s.id !== row.id));
        return;
      }
      setSections((prev) => {
        const idx = prev.findIndex((s) => s.id === row.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = row;
          return next.sort((a, b) => a.name.localeCompare(b.name));
        }
        return [...prev, row].sort((a, b) => a.name.localeCompare(b.name));
      });
    });
  }, [mode]);

  // ─── Apply date filters ────────────────────────────────────────────
  const filteredZones = useMemo(() => {
    return zones.filter((z) => {
      const zoneDate = rawDateString(z.start_time);
      if (startDate && zoneDate < startDate) return false;
      if (endDate && zoneDate > endDate) return false;
      return true;
    });
  }, [zones, startDate, endDate]);

  // ─── Zones passed to the simulator ─────────────────────────────────
  // Only zones whose section_id is in the picker's confirmed set are handed
  // to SimulatorPanel. Zones with NULL section_id fall back to the "default"
  // section (same rule the simulator's own chip filter uses), so legacy rows
  // still load when default is selected.
  const defaultSectionId = useMemo(
    () => sections.find((s) => s.name === "default")?.id ?? null,
    [sections]
  );
  const simulatorZones = useMemo(() => {
    if (simulatorSectionIds.size === 0) return [];
    return filteredZones.filter((z) => {
      const effective = z.section_id ?? defaultSectionId;
      return effective !== null && simulatorSectionIds.has(effective);
    });
  }, [filteredZones, simulatorSectionIds, defaultSectionId]);

  // Only hand the chosen sections into SimulatorPanel so its internal chip
  // filter reflects what was actually loaded (avoids showing chips for
  // sections whose bars aren't present).
  const simulatorSections = useMemo(
    () => sections.filter((s) => simulatorSectionIds.has(s.id)),
    [sections, simulatorSectionIds]
  );

  // Zone count per section for the picker modal — helps the user gauge how
  // much data each section adds before loading.
  const zoneCountBySection = useMemo(() => {
    const counts = new Map<number, number>();
    for (const z of filteredZones) {
      const effective = z.section_id ?? defaultSectionId;
      if (effective == null) continue;
      counts.set(effective, (counts.get(effective) ?? 0) + 1);
    }
    return counts;
  }, [filteredZones, defaultSectionId]);

  /** Toggle simulator open/closed. Opening routes through the picker so the
   *  user always confirms which sections to load before the fetch kicks off. */
  function handleSimulatorButtonClick() {
    if (simulatorOpen) {
      setSimulatorOpen(false);
      return;
    }
    setSimulatorPickerOpen(true);
  }

  /** User confirmed section selection — close picker, mount simulator. */
  function handleConfirmSimulatorSections(ids: Set<number>) {
    setSimulatorSectionIds(ids);
    setSimulatorPickerOpen(false);
    setSimulatorOpen(true);
  }

  // ─── Compute all derived data from filtered zones ──────────────────
  const stats = useMemo(
    () => computeZoneSummaryStats(filteredZones),
    [filteredZones]
  );
  const pointsChart = useMemo(
    () => buildZonePointsChart(filteredZones),
    [filteredZones]
  );
  const equityCurve = useMemo(
    () => buildZoneEquityCurve(filteredZones),
    [filteredZones]
  );
  const byDirection = useMemo(
    () => buildZonesByDirection(filteredZones),
    [filteredZones]
  );
  const byTimeOfDay = useMemo(
    () => buildZonesByTimeOfDay(filteredZones),
    [filteredZones]
  );
  const byDuration = useMemo(
    () => buildZonesByDuration(filteredZones),
    [filteredZones]
  );
  const byInstrument = useMemo(
    () => buildZonesByInstrument(filteredZones),
    [filteredZones]
  );
  const byAdx = useMemo(
    () => buildZonesByAdx(filteredZones),
    [filteredZones]
  );
  const byAtr = useMemo(
    () => buildZonesByAtr(filteredZones),
    [filteredZones]
  );
  const byEma20 = useMemo(
    () => buildZonesByEma20(filteredZones),
    [filteredZones]
  );
  const byBollinger = useMemo(
    () => buildZonesByBollinger(filteredZones),
    [filteredZones]
  );
  const byDayOfWeek = useMemo(
    () => buildZonesByDayOfWeek(filteredZones),
    [filteredZones]
  );

  // ─── Selection handlers ────────────────────────────────────────────
  function handleToggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleToggleAll() {
    const allFilteredIds = filteredZones.map((z) => z.id);
    const allSelected = allFilteredIds.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allFilteredIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allFilteredIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }

  async function handleDelete() {
    const count = selectedIds.size;
    if (count === 0) return;
    const confirmed = confirm(
      `Delete ${count} zone${count > 1 ? "s" : ""}? This cannot be undone.`
    );
    if (!confirmed) return;

    const idsToDelete = Array.from(selectedIds);
    const result = await deleteZones(idsToDelete);

    if (result.success) {
      setZones((prev) => prev.filter((z) => !selectedIds.has(z.id)));
      setSelectedIds(new Set());
    } else {
      alert(`Failed to delete zones: ${result.error}`);
    }
  }

  return (
    <div>
      {/* Date filter bar + simulator toggle */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">From</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">To</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
        </div>
        {(startDate || endDate) && (
          <button
            onClick={() => {
              setStartDate("");
              setEndDate("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        )}

        {/* Manage sections button — opens modal for create/rename/delete.
            Sits to the left of the simulator toggle so both section-related
            controls stay grouped on the right side of the filter bar. */}
        <button
          onClick={() => setManageSectionsOpen(true)}
          className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium transition-colors bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
        >
          Manage Sections
        </button>

        {/* Simulator toggle — routes through the section picker modal on
            open so the user explicitly chooses how much data to load. */}
        <button
          onClick={handleSimulatorButtonClick}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            simulatorOpen
              ? "bg-accent-green/20 text-accent-green"
              : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
          }`}
        >
          Risk Simulator
        </button>
      </div>

      {/* Risk Management Simulator (collapsible).
          Remount on section-id-set change so bar fetching re-runs cleanly
          with the newly-chosen scope (instead of SimulatorPanel trying to
          reconcile mid-flight). */}
      {simulatorOpen && (
        <div className="mb-6 space-y-2">
          <div className="flex items-center justify-end">
            <button
              onClick={() => setSimulatorPickerOpen(true)}
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            >
              Change Loaded Sections
            </button>
          </div>
          <SimulatorPanel
            key={Array.from(simulatorSectionIds).sort((a, b) => a - b).join(",")}
            zones={simulatorZones}
            sections={simulatorSections}
          />
        </div>
      )}

      {/* Section picker modal — opens on every "Risk Simulator" click so the
          user chooses which sections to load before bars get fetched. */}
      {simulatorPickerOpen && (
        <SimulatorSectionPicker
          sections={sections}
          defaultSectionId={defaultSectionId}
          zoneCountBySection={zoneCountBySection}
          initialSelected={
            simulatorSectionIds.size > 0
              ? simulatorSectionIds
              : defaultSectionId != null
                ? new Set([defaultSectionId])
                : new Set()
          }
          onCancel={() => setSimulatorPickerOpen(false)}
          onConfirm={handleConfirmSimulatorSections}
        />
      )}

      {/* Manage Sections modal — rendered conditionally to avoid mounting
          the section list when not visible. */}
      {manageSectionsOpen && (
        <ManageSectionsPanel
          sections={sections}
          zones={zones}
          onClose={() => setManageSectionsOpen(false)}
        />
      )}

      {/* Summary Stat Cards */}
      <ZoneStatCards stats={stats} />

      {/* Equity Curve + Points Move per Zone */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <ZoneEquityCurve data={equityCurve} />
        <ZonePointsChart data={pointsChart} />
      </div>

      {/* Category breakdown charts — 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <PnlByCategory title="Points by Direction" data={byDirection} />
        <PnlByCategory title="Points by Time of Day" data={byTimeOfDay} />
        <PnlByCategory title="Points by Day of Week" data={byDayOfWeek} />
        <PnlByCategory title="Points by Duration" data={byDuration} />
      </div>

      {/* Market context charts — when to trade / when not to */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <PnlByCategory title="Points by ADX (Trend Strength)" data={byAdx} />
        <PnlByCategory title="Points by ATR (Volatility)" data={byAtr} />
        <PnlByCategory title="Points by EMA20 Position" data={byEma20} />
        <PnlByCategory title="Points by Bollinger Position" data={byBollinger} />
      </div>

      {/* Zone Table */}
      <ZoneTable
        zones={filteredZones}
        selectedIds={selectedIds}
        onToggleSelect={handleToggleSelect}
        onToggleAll={handleToggleAll}
        onDelete={handleDelete}
      />
    </div>
  );
}

/**
 * SimulatorSectionPicker
 *
 * Modal shown before the risk simulator mounts. Lets the user multi-select
 * which sections to load bars for — loading ALL sections at once pulls every
 * trade_zone_bars row across thousands of zones, which is what the parent
 * component is trying to avoid. Per-section zone counts are shown so the
 * user has a sense of load size before confirming. Zero selection is blocked
 * because the simulator has nothing to simulate without at least one section.
 */
interface SimulatorSectionPickerProps {
  sections: ZoneSection[];
  /** ID of the "default" section, so NULL-section zones can be attributed
   *  to it in the counts (matching the simulator's own fallback logic). */
  defaultSectionId: number | null;
  /** Pre-computed count of filteredZones per section id. Used to render
   *  "N zones" next to each chip so the user sees the load cost. */
  zoneCountBySection: Map<number, number>;
  /** What should be preselected when the modal opens — either the last
   *  confirmed set or a sensible default from the parent. */
  initialSelected: Set<number>;
  onCancel: () => void;
  onConfirm: (ids: Set<number>) => void;
}

function SimulatorSectionPicker({
  sections,
  defaultSectionId,
  zoneCountBySection,
  initialSelected,
  onCancel,
  onConfirm,
}: SimulatorSectionPickerProps) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialSelected));

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Running total — what the simulator will ingest if user confirms now.
  // Driven off zoneCountBySection so we don't re-scan zones inside the modal.
  let totalZones = 0;
  for (const id of selected) totalZones += zoneCountBySection.get(id) ?? 0;

  const canConfirm = selected.size > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-card-border rounded-lg p-6 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-foreground">Load Risk Simulator</h3>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Pick which sections to load. Each section pulls every bar for its
          zones, so loading fewer sections is much faster.
        </p>

        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => setSelected(new Set(sections.map((s) => s.id)))}
            className="px-2 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            Select All
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="px-2 py-1 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            Clear
          </button>
        </div>

        {/* Section rows. Scroll caps out around ~12 rows so long lists don't
            blow past the viewport; the chosen max-h keeps the modal compact. */}
        <div className="space-y-1 max-h-80 overflow-y-auto pr-1 mb-4">
          {sections.length === 0 && (
            <div className="text-sm text-muted-foreground italic py-2">
              No sections exist yet.
            </div>
          )}
          {sections.map((s) => {
            const active = selected.has(s.id);
            const count = zoneCountBySection.get(s.id) ?? 0;
            const isDefault = s.id === defaultSectionId;
            return (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
                  active
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                }`}
              >
                <span className="font-medium">
                  {s.name}
                  {isDefault && (
                    <span className="ml-2 text-xs opacity-60">(default)</span>
                  )}
                </span>
                <span className="text-xs opacity-80">{count} zones</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {selected.size} section{selected.size === 1 ? "" : "s"} · {totalZones} zones
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(selected)}
              disabled={!canConfirm}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                canConfirm
                  ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                  : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
              }`}
            >
              Load Simulator
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
