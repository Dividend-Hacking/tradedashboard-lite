/**
 * TradeTable Component
 *
 * Sortable, expandable data table displaying trade records.
 * Features:
 * - View switcher: toggle between Default, Risk/Reward, Market Context, and Execution column presets
 * - Expandable rows: click any trade row to reveal a full detail panel with all 45 fields
 * - Column sorting: click headers to sort ascending/descending
 * - Multi-select: checkbox selection with bulk delete capability
 * - Horizontally scrollable on mobile
 */

"use client";

import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import { Trade } from "@/types/trade";
import { ALL_COLUMNS, TABLE_VIEWS, Column } from "@/lib/table-views";
import { TradeDetailPanel } from "@/components/trade-detail-panel";

interface TradeTableProps {
  trades: Trade[];
  /** Set of currently selected trade IDs */
  selectedIds: Set<number>;
  /** Toggle selection for a single trade by ID */
  onToggleSelect: (id: number) => void;
  /** Toggle select/deselect all visible trades */
  onToggleAll: () => void;
  /** Trigger deletion of all selected trades */
  onDelete: () => void;
  /**
   * Time mode from the global dashboard toggle.
   * "trade" = playback bar timestamps (entry_time/exit_time)
   * "real"  = wall-clock timestamps (real_entry_time/real_exit_time), falls back to trade time if null
   */
  timeMode: "trade" | "real";
}

export function TradeTable({
  trades,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onDelete,
  timeMode,
}: TradeTableProps) {
  // ---- View switcher state ----
  // Tracks which column preset is active (default, risk, context, execution)
  const [activeViewId, setActiveViewId] = useState<string>("default");

  // ---- Sort state ----
  const [sortKey, setSortKey] = useState<string>("date");
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  // ---- Expansion state ----
  // Which trade row is currently expanded (null = none)
  const [expandedId, setExpandedId] = useState<number | null>(null);

  /**
   * Derive the visible columns for the active view.
   * Maps view's columnKeys to full Column objects from ALL_COLUMNS.
   * When timeMode is "real", substitutes time columns with their real-time equivalents
   * so the user sees wall-clock timestamps instead of playback bar timestamps.
   */
  const visibleColumns: Column[] = useMemo(() => {
    const view = TABLE_VIEWS.find((v) => v.id === activeViewId) ?? TABLE_VIEWS[0];
    return view.columnKeys
      .map((key) => {
        // Substitute time columns based on timeMode
        if (timeMode === "real") {
          if (key === "date") return ALL_COLUMNS["real_date"];
          if (key === "exit_time") return ALL_COLUMNS["real_exit_time"];
        }
        return ALL_COLUMNS[key];
      })
      .filter(Boolean);
  }, [activeViewId, timeMode]);

  /**
   * Handle view switch — reset sort if current sort key isn't in the new view,
   * and collapse any expanded row.
   */
  function handleViewChange(viewId: string) {
    setActiveViewId(viewId);
    setExpandedId(null);
    const view = TABLE_VIEWS.find((v) => v.id === viewId);
    if (view && !view.columnKeys.includes(sortKey)) {
      // Fall back to "date" which exists in all views
      setSortKey("date");
      setSortAsc(false);
    }
  }

  /**
   * Handle column header click: toggle direction if same column,
   * or switch to new column with ascending default.
   */
  function handleSort(key: string) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  // Sort trades based on current sort state using the active column's getValue
  const sortedTrades = useMemo(() => {
    const col = visibleColumns.find((c) => c.key === sortKey);
    if (!col) return trades;

    return [...trades].sort((a, b) => {
      const aVal = col.getValue(a);
      const bVal = col.getValue(b);

      // Nulls always sort last regardless of direction
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let cmp: number;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }

      return sortAsc ? cmp : -cmp;
    });
  }, [trades, sortKey, sortAsc, visibleColumns]);

  // ---- Select-all checkbox state ----
  const allSelected =
    trades.length > 0 && trades.every((t) => selectedIds.has(t.id));
  const someSelected =
    !allSelected && trades.some((t) => selectedIds.has(t.id));

  // Ref for the select-all checkbox to set the indeterminate property (not controllable via JSX)
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  /**
   * Handle row click to toggle expansion.
   * Clicking the same row collapses it; clicking a different row switches to that one.
   */
  function handleRowClick(tradeId: number) {
    setExpandedId((prev) => (prev === tradeId ? null : tradeId));
  }

  // Dynamic colspan for expansion rows: checkbox column + all visible columns
  const totalColSpan = visibleColumns.length + 1;

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-x-auto">
      {/* ---- View switcher tabs ---- */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-card-border overflow-x-auto">
        {TABLE_VIEWS.map((view) => (
          <button
            key={view.id}
            onClick={() => handleViewChange(view.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
              activeViewId === view.id
                ? "bg-white/10 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            }`}
          >
            {view.label}
          </button>
        ))}
      </div>

      {/* ---- Delete bar — appears when trades are selected ---- */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2 bg-accent-red/10 border-b border-card-border">
          <span className="text-sm text-accent-red font-medium">
            {selectedIds.size} trade{selectedIds.size > 1 ? "s" : ""} selected
          </span>
          <button
            onClick={onDelete}
            className="px-3 py-1 text-sm font-medium text-white bg-accent-red rounded hover:bg-accent-red/80 transition-colors"
          >
            Delete
          </button>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border">
            {/* Select-all checkbox header */}
            <th className="px-4 py-3 w-10">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                className="accent-accent-red cursor-pointer"
                aria-label="Select all trades"
              />
            </th>
            {visibleColumns.map((col) => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors select-none whitespace-nowrap"
              >
                {col.label}
                {/* Sort indicator arrow */}
                {sortKey === col.key && (
                  <span className="ml-1">{sortAsc ? "↑" : "↓"}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedTrades.map((trade) => (
            <Fragment key={trade.id}>
              {/* ---- Main trade row ---- */}
              <tr
                onClick={() => handleRowClick(trade.id)}
                className={`border-b border-card-border/50 hover:bg-white/[0.02] transition-colors cursor-pointer ${
                  selectedIds.has(trade.id) ? "bg-white/[0.04]" : ""
                } ${expandedId === trade.id ? "bg-white/[0.03]" : ""}`}
              >
                {/* Per-row selection checkbox — stopPropagation prevents row expansion */}
                <td
                  className="px-4 py-3 w-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(trade.id)}
                      onChange={() => onToggleSelect(trade.id)}
                      className="accent-accent-red cursor-pointer"
                      aria-label={`Select trade ${trade.id}`}
                    />
                    {/* Chevron indicator for expand/collapse */}
                    <span className="text-muted-foreground text-xs select-none">
                      {expandedId === trade.id ? "▾" : "▸"}
                    </span>
                  </div>
                </td>
                {visibleColumns.map((col) => (
                  <td key={col.key} className="px-4 py-3 whitespace-nowrap">
                    {col.render(trade)}
                  </td>
                ))}
              </tr>

              {/* ---- Expanded detail panel row ---- */}
              {expandedId === trade.id && (
                <tr className="border-b border-card-border/50 bg-white/[0.01]">
                  <td colSpan={totalColSpan}>
                    <TradeDetailPanel trade={trade} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* ---- Empty state ---- */}
      {sortedTrades.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No trades match the current filters.
        </div>
      )}
    </div>
  );
}
