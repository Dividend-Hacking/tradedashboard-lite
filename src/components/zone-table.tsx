/**
 * ZoneTable Component
 *
 * Sortable, selectable table displaying all trade zones.
 * Supports multi-select deletion and column sorting.
 * Mirrors the trade-table.tsx patterns but with a simpler column set.
 */

"use client";

import { useState, useMemo } from "react";
import { TradeZone } from "@/types/trade-zone";
import { formatDate, formatTime, formatNumber } from "@/lib/utils/format";

interface ZoneTableProps {
  zones: TradeZone[];
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onToggleAll: () => void;
  onDelete: () => void;
}

/** Column definition for sortable headers */
interface ColumnDef {
  key: string;
  label: string;
  sortKey: (z: TradeZone) => string | number;
  render: (z: TradeZone) => React.ReactNode;
  align?: "left" | "right";
}

/** Format seconds to a short duration (e.g., "2m 30s") */
function fmtDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

/** Column definitions for the zone table */
const COLUMNS: ColumnDef[] = [
  {
    key: "date",
    label: "Date",
    sortKey: (z) => z.start_time,
    render: (z) => (
      <span>
        {formatDate(z.start_time)}{" "}
        <span className="text-muted-foreground">{formatTime(z.start_time)}</span>
      </span>
    ),
  },
  {
    key: "instrument",
    label: "Instrument",
    sortKey: (z) => z.instrument,
    render: (z) => z.instrument,
  },
  {
    key: "direction",
    label: "Dir",
    sortKey: (z) => z.direction,
    render: (z) => (
      <span
        className={
          z.direction === "Long" ? "text-accent-green" : "text-accent-red"
        }
      >
        {z.direction}
      </span>
    ),
  },
  {
    key: "start_price",
    label: "Entry",
    sortKey: (z) => z.start_price,
    render: (z) => formatNumber(z.start_price),
    align: "right",
  },
  {
    key: "end_price",
    label: "Exit",
    sortKey: (z) => z.end_price,
    render: (z) => formatNumber(z.end_price),
    align: "right",
  },
  {
    key: "points_move",
    label: "Points",
    sortKey: (z) => z.points_move,
    render: (z) => (
      <span
        className={
          z.points_move > 0
            ? "text-accent-green"
            : z.points_move < 0
            ? "text-accent-red"
            : "text-foreground"
        }
      >
        {z.points_move > 0 ? "+" : ""}
        {formatNumber(z.points_move)}
      </span>
    ),
    align: "right",
  },
  {
    key: "duration",
    label: "Duration",
    sortKey: (z) => z.duration_seconds,
    render: (z) => fmtDuration(z.duration_seconds),
    align: "right",
  },
  {
    key: "atr",
    label: "ATR",
    sortKey: (z) => z.ctx_atr14 ?? 0,
    render: (z) => formatNumber(z.ctx_atr14, 2),
    align: "right",
  },
  {
    key: "adx",
    label: "ADX",
    sortKey: (z) => z.ctx_adx14 ?? 0,
    render: (z) => formatNumber(z.ctx_adx14, 1),
    align: "right",
  },
  {
    key: "ema20",
    label: "vs EMA20",
    sortKey: (z) => z.ctx_price_vs_ema20 ?? "",
    render: (z) => (
      <span className={z.ctx_price_vs_ema20 === "above" ? "text-accent-green" : z.ctx_price_vs_ema20 === "below" ? "text-accent-red" : "text-muted-foreground"}>
        {z.ctx_price_vs_ema20 || "—"}
      </span>
    ),
  },
  {
    key: "bollinger",
    label: "Bollinger",
    sortKey: (z) => z.ctx_bollinger_pos ?? "",
    render: (z) => z.ctx_bollinger_pos || "—",
  },
  {
    key: "notes",
    label: "Notes",
    sortKey: (z) => z.notes ?? "",
    render: (z) => (
      <span className="text-muted-foreground truncate max-w-[200px] inline-block">
        {z.notes || "—"}
      </span>
    ),
  },
];

export function ZoneTable({
  zones,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onDelete,
}: ZoneTableProps) {
  // ─── Sort State ──────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<string>("date");
  const [sortAsc, setSortAsc] = useState<boolean>(false); // Default: newest first

  /** Toggle sort direction or switch to a new column */
  function handleSort(key: string) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  /** Sort zones based on current sort state */
  const sortedZones = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey);
    if (!col) return zones;

    return [...zones].sort((a, b) => {
      const aVal = col.sortKey(a);
      const bVal = col.sortKey(b);
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
  }, [zones, sortKey, sortAsc]);

  const allSelected =
    zones.length > 0 && zones.every((z) => selectedIds.has(z.id));

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      {/* Header bar with title and delete button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-card-border">
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          Trade Zones ({zones.length})
        </h3>
        {selectedIds.size > 0 && (
          <button
            onClick={onDelete}
            className="px-3 py-1 text-xs font-medium rounded-md bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors"
          >
            Delete {selectedIds.size} zone{selectedIds.size > 1 ? "s" : ""}
          </button>
        )}
      </div>

      {/* Scrollable table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-card-border">
              {/* Select-all checkbox */}
              <th className="px-4 py-2 text-left w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  className="rounded border-card-border"
                />
              </th>
              {/* Sortable column headers */}
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors whitespace-nowrap ${
                    col.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1">{sortAsc ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedZones.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length + 1}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No trade zones found
                </td>
              </tr>
            ) : (
              sortedZones.map((zone) => (
                <tr
                  key={zone.id}
                  className="border-b border-card-border/50 hover:bg-white/[0.02] transition-colors"
                >
                  {/* Row checkbox */}
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(zone.id)}
                      onChange={() => onToggleSelect(zone.id)}
                      className="rounded border-card-border"
                    />
                  </td>
                  {/* Data cells */}
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2 whitespace-nowrap ${
                        col.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      {col.render(zone)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
