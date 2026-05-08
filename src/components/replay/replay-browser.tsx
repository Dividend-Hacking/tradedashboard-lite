"use client";

/**
 * ReplayBrowser — Session selection screen for the replay tool.
 *
 * Displays all available replay sessions from Supabase as cards,
 * with filters for instrument and date. Click a session to launch
 * the replay viewer. Each card has a delete button that removes the
 * session and all associated bars/practice data (cascade).
 */

import { useState, useMemo, useTransition, useCallback, useRef } from "react";
import Link from "next/link";
import { ReplaySession, DataRequest } from "@/types/replay";
import { formatDate, formatTime } from "@/lib/utils/format";
import { deleteReplaySession, deleteReplaySessions } from "@/app/replay/actions";
import DataRequestForm from "./data-request-form";
import DataRequestStatus from "./data-request-status";
import DataRequestSummaryBanner from "./data-request-summary-banner";
import type { DataRequestQueueSummary } from "@/types/replay";

interface ReplayBrowserProps {
  sessions: ReplaySession[];
  activeRequests: DataRequest[];
  queueSummary: DataRequestQueueSummary;
}

export default function ReplayBrowser({
  sessions: initialSessions,
  activeRequests,
  queueSummary,
}: ReplayBrowserProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [instrumentFilter, setInstrumentFilter] = useState<string>("all");

  // Multi-select state. Stored as a Set for O(1) toggle/has lookups across
  // potentially hundreds of sessions. Only ids that are *currently* in the
  // sessions list count — we filter the set after deletes so stale ids
  // don't linger.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, startBulkTransition] = useTransition();

  // Anchor id for shift-click range selection. Set on every plain click and
  // every successful shift-click target. Held in a ref because it's pure UI
  // state that doesn't drive rendering — re-rendering on every click just
  // to update the anchor would be wasteful.
  const lastClickedIdRef = useRef<number | null>(null);

  // Get unique instruments for the filter dropdown
  const instruments = useMemo(() => {
    const set = new Set(sessions.map((s) => s.instrument));
    return Array.from(set).sort();
  }, [sessions]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = sessions;
    if (instrumentFilter !== "all") {
      result = result.filter((s) => s.instrument === instrumentFilter);
    }
    return result;
  }, [sessions, instrumentFilter]);

  /** Remove a session from local state after successful single delete. Also
   *  drops the id from the selection set in case it was selected. */
  const handleDelete = useCallback((sessionId: number) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setSelectedIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  /**
   * Selection click handler. Two behaviors based on the shift modifier:
   *
   * - **Plain click**: toggle this id in/out of the selection and become the
   *   new anchor for future range selections.
   * - **Shift-click**: select every session between the anchor and this id
   *   (inclusive) in the *filtered* display order. Mirrors file-manager UX
   *   where shift-click extends a selection rather than replacing it.
   *   The anchor stays put so further shift-clicks continue extending from
   *   the same origin.
   *
   * If there's no anchor yet (first click ever) or the anchor isn't in the
   * current filtered set, shift-click falls back to plain-click behavior.
   */
  const handleSelectClick = useCallback(
    (sessionId: number, withShift: boolean) => {
      if (withShift && lastClickedIdRef.current !== null) {
        const anchorId = lastClickedIdRef.current;
        const idxA = filtered.findIndex((s) => s.id === anchorId);
        const idxB = filtered.findIndex((s) => s.id === sessionId);
        if (idxA !== -1 && idxB !== -1) {
          const [from, to] = idxA <= idxB ? [idxA, idxB] : [idxB, idxA];
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (let i = from; i <= to; i++) {
              next.add(filtered[i].id);
            }
            return next;
          });
          return;
        }
        // Anchor not in filtered list (e.g. instrument filter changed since
        // anchor was set) → fall through to plain-click behavior.
      }

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      lastClickedIdRef.current = sessionId;
    },
    [filtered]
  );

  /** Are *all* currently-filtered sessions selected? Used to drive the
   *  Select-All checkbox state. */
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.has(s.id));

  /** Toggle: select all visible (filtered) sessions, or clear them all if
   *  they're already selected. */
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filtered.every((s) => next.has(s.id))) {
        // All filtered are selected → unselect just the filtered ones (keep
        // any selections that are outside the current filter alone).
        for (const s of filtered) next.delete(s.id);
      } else {
        for (const s of filtered) next.add(s.id);
      }
      return next;
    });
  }, [filtered]);

  /** Drop everything from the selection. */
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  /** Bulk-delete all selected sessions. Confirms first because there's no
   *  undo. After success we drop the deleted ids from local state and
   *  clear the selection. */
  const handleBulkDelete = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const confirmed = window.confirm(
      `Delete ${ids.length} session${ids.length === 1 ? "" : "s"}?\n\n` +
        `This will also remove all bars, practice sessions, and tick blobs ` +
        `associated with them. This cannot be undone.`
    );
    if (!confirmed) return;

    startBulkTransition(async () => {
      const result = await deleteReplaySessions(ids);
      if ("error" in result) {
        alert(`Bulk delete failed: ${result.error}`);
        return;
      }
      setSessions((prev) => prev.filter((s) => !selectedIds.has(s.id)));
      setSelectedIds(new Set());
    });
  }, [selectedIds]);

  const selectedCount = selectedIds.size;

  return (
    <div className="flex flex-col gap-4">
      {/* Top-of-page queue summary — server-rendered counts so a refresh
          doesn't look like the download stopped. */}
      <DataRequestSummaryBanner initial={queueSummary} />

      {/* Data request form + per-row active status (live-polling client). */}
      <DataRequestForm />
      <DataRequestStatus initialRequests={activeRequests} />

      {/* Filters + Select-All control. The select-all checkbox toggles the
          *filtered* set so users can scope their selection to one instrument
          and select-all without nuking off-screen sessions. */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            disabled={filtered.length === 0}
            className="accent-accent-green"
          />
          Select all visible
        </label>

        <span className="text-card-border">|</span>

        <label className="text-sm text-muted-foreground">Instrument:</label>
        <select
          value={instrumentFilter}
          onChange={(e) => setInstrumentFilter(e.target.value)}
          className="bg-card border border-card-border rounded px-2 py-1.5 text-sm
                     text-foreground focus:outline-none focus:border-muted"
        >
          <option value="all">All</option>
          {instruments.map((inst) => (
            <option key={inst} value={inst}>
              {inst}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted/60 ml-auto">
          {filtered.length} session{filtered.length !== 1 ? "s" : ""} available
        </span>
      </div>

      {/* Bulk-action toolbar. Renders only when at least one session is
          selected so it doesn't take up vertical space otherwise. Sticky-ish:
          stays at the top of the grid as the user scrolls. */}
      {selectedCount > 0 && (
        <div
          className="sticky top-2 z-10 flex items-center gap-3 bg-card border border-accent-green/40
                     rounded-lg px-3 py-2 shadow-md"
        >
          <span className="text-sm font-medium text-foreground">
            {selectedCount} selected
          </span>
          <button
            onClick={handleBulkDelete}
            disabled={isBulkDeleting}
            className="px-3 py-1 rounded text-sm bg-accent-red/20 text-accent-red
                       border border-accent-red/40 hover:bg-accent-red/30 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isBulkDeleting ? "Deleting..." : `Delete ${selectedCount}`}
          </button>
          <button
            onClick={clearSelection}
            disabled={isBulkDeleting}
            className="px-3 py-1 rounded text-sm bg-background border border-card-border
                       text-muted-foreground hover:text-foreground transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
          >
            Clear
          </button>
        </div>
      )}

      {/* Session cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-2">No replay sessions found</p>
          <p className="text-xs text-muted/60">
            Export data from NinjaTrader using the Data Exporter AddOn
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onDelete={handleDelete}
              isSelected={selectedIds.has(session.id)}
              onSelectClick={handleSelectClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Granularity badge styling. Each variant gets its own color so users can
 * tell at a glance whether a session is plain OHLCV, OHLCV+BidAsk delta,
 * raw ticks, or ticks with side attribution.
 */
const GRANULARITY_BADGE: Record<
  ReplaySession["granularity"],
  { label: string; className: string }
> = {
  ohlcv:        { label: "OHLCV",       className: "bg-background text-muted-foreground" },
  ohlcv_bidask: { label: "+Bid/Ask",    className: "bg-accent-blue/15 text-accent-blue" },
  tick:         { label: "Tick",        className: "bg-accent-green/15 text-accent-green" },
  tick_bidask:  { label: "Tick+Side",   className: "bg-accent-green/20 text-accent-green" },
};

/** Individual session card — links to the replay viewer with a delete button.
 *  When `isSelected` is true the card gets an outline accent so it's obvious
 *  which cards are part of the active multi-select. The checkbox in the
 *  top-left corner stops Link navigation on click so toggling selection
 *  doesn't accidentally open the session.
 *
 *  Shift-click on the checkbox is forwarded to the parent (`onSelectClick`
 *  receives the modifier) so the parent can implement range selection
 *  using the filtered display order it owns. */
function SessionCard({
  session,
  onDelete,
  isSelected,
  onSelectClick,
}: {
  session: ReplaySession;
  onDelete: (id: number) => void;
  isSelected: boolean;
  onSelectClick: (id: number, withShift: boolean) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const dateStr = formatDate(session.session_date + "T00:00:00");
  const startTime = formatTime(session.start_time);
  const endTime = formatTime(session.end_time);

  // Tick sessions store data as a blob in Storage rather than rows in
  // replay_bars, so bar_count is 0 and the progress bar (which divides by
  // bar_count) would render NaN%. Branch on granularity to show the right
  // count and skip the progress bar — there's no per-bar playback for ticks
  // yet (tick chart viewer is a downstream task).
  const isTickSession = session.granularity === "tick" || session.granularity === "tick_bidask";
  const countLabel = isTickSession
    ? `${(session.tick_count ?? 0).toLocaleString()} ticks`
    : `${session.bar_count.toLocaleString()} bars`;
  const badge = GRANULARITY_BADGE[session.granularity] ?? GRANULARITY_BADGE.ohlcv;

  /** Confirm and delete the session, preventing the Link navigation */
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const confirmed = window.confirm(
      `Delete "${session.instrument} — ${dateStr}"?\n\nThis will also remove all bars and practice sessions associated with it.`
    );
    if (!confirmed) return;

    startTransition(async () => {
      const result = await deleteReplaySession(session.id);
      if (result.success) {
        onDelete(session.id);
      } else {
        alert(`Failed to delete session: ${result.error}`);
      }
    });
  };

  /** Click on the checkbox: forward the shiftKey modifier up so the parent
   *  can do range selection. We stop propagation so the surrounding Link
   *  doesn't navigate, and preventDefault to suppress the browser's native
   *  checkbox toggle (we drive the checked state from props via the parent's
   *  selectedIds Set instead). */
  const handleCheckboxClick = (e: React.MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
    e.preventDefault();
    onSelectClick(session.id, e.shiftKey);
  };
  /** No-op onChange — required to silence React's controlled-checkbox
   *  warning. The actual selection logic lives in onClick because that's
   *  where we have access to the shiftKey modifier. */
  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
  };

  return (
    <Link
      href={`/replay/${session.id}`}
      className={`bg-card border rounded-lg p-4 transition-colors group relative ${
        isSelected
          ? "border-accent-green/60 ring-1 ring-accent-green/30"
          : "border-card-border hover:border-muted"
      }`}
    >
      {/* Selection checkbox — top-left corner. Always visible (small) so the
          multi-select affordance is discoverable. Clicking it toggles
          selection without opening the session. */}
      <input
        type="checkbox"
        checked={isSelected}
        onClick={handleCheckboxClick}
        onChange={handleCheckboxChange}
        className="absolute top-2 left-2 w-4 h-4 accent-accent-green cursor-pointer z-10"
        title="Select for bulk actions"
      />

      {/* Delete button — top-right corner */}
      <button
        onClick={handleDeleteClick}
        disabled={isPending}
        className="absolute top-2 right-2 p-1.5 rounded text-muted/40 hover:text-accent-red
                   hover:bg-accent-red/10 transition-colors opacity-0 group-hover:opacity-100
                   disabled:opacity-50 disabled:cursor-not-allowed z-10"
        title="Delete session"
      >
        {isPending ? (
          /* Simple spinning indicator */
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
          </svg>
        ) : (
          /* Trash icon */
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        )}
      </button>

      <div className="flex items-center justify-between mb-2">
        {/* pl-6 leaves room for the absolute-positioned selection checkbox */}
        <span className="font-medium text-foreground group-hover:text-accent-green transition-colors pl-6">
          {session.instrument}
        </span>
        {/* Timeframe + granularity badges. Granularity is omitted for plain
            'ohlcv' to keep existing cards looking unchanged. */}
        <div className="flex items-center gap-1 mr-6">
          <span className="text-xs bg-background px-2 py-0.5 rounded text-muted-foreground">
            {session.timeframe}
          </span>
          {session.granularity !== "ohlcv" && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.className}`}>
              {badge.label}
            </span>
          )}
        </div>
      </div>
      <div className="text-sm text-muted-foreground mb-1">{dateStr}</div>
      <div className="flex items-center justify-between text-xs text-muted/60">
        <span>
          {startTime} — {endTime}
        </span>
        <span>{countLabel}</span>
      </div>
      {session.notes && (
        <p className="text-xs text-muted/60 mt-2 truncate">{session.notes}</p>
      )}
      {/* Progress bar — only meaningful for bar sessions where the user has a
          last_bar_index to track. Tick sessions have no per-bar playback yet,
          so we hide the bar entirely instead of rendering NaN%. */}
      {!isTickSession && session.bar_count > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1 h-1 bg-background rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-green/60 rounded-full transition-all"
              style={{ width: `${Math.min((session.last_bar_index / session.bar_count) * 100, 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-muted/60 tabular-nums">
            {Math.round((session.last_bar_index / session.bar_count) * 100)}%
          </span>
        </div>
      )}
    </Link>
  );
}
