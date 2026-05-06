"use client";

/**
 * ReplayBrowser — Session selection screen for the replay tool.
 *
 * Displays all available replay sessions from Supabase as cards,
 * with filters for instrument and date. Click a session to launch
 * the replay viewer. Each card has a delete button that removes the
 * session and all associated bars/practice data (cascade).
 */

import { useState, useMemo, useTransition } from "react";
import Link from "next/link";
import { ReplaySession, DataRequest } from "@/types/replay";
import { formatDate, formatTime } from "@/lib/utils/format";
import { deleteReplaySession } from "@/app/replay/actions";
import DataRequestForm from "./data-request-form";
import DataRequestStatus from "./data-request-status";

interface ReplayBrowserProps {
  sessions: ReplaySession[];
  activeRequests: DataRequest[];
}

export default function ReplayBrowser({ sessions: initialSessions, activeRequests }: ReplayBrowserProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [instrumentFilter, setInstrumentFilter] = useState<string>("all");

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

  /** Remove a session from local state after successful delete */
  const handleDelete = (sessionId: number) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Data request form + active request status */}
      <DataRequestForm />
      <DataRequestStatus initialRequests={activeRequests} />

      {/* Filters */}
      <div className="flex items-center gap-3">
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
            <SessionCard key={session.id} session={session} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Individual session card — links to the replay viewer with a delete button */
function SessionCard({
  session,
  onDelete,
}: {
  session: ReplaySession;
  onDelete: (id: number) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const dateStr = formatDate(session.session_date + "T00:00:00");
  const startTime = formatTime(session.start_time);
  const endTime = formatTime(session.end_time);

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

  return (
    <Link
      href={`/replay/${session.id}`}
      className="bg-card border border-card-border rounded-lg p-4 hover:border-muted
                 transition-colors group relative"
    >
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
        <span className="font-medium text-foreground group-hover:text-accent-green transition-colors">
          {session.instrument}
        </span>
        <span className="text-xs bg-background px-2 py-0.5 rounded text-muted-foreground mr-6">
          {session.timeframe}
        </span>
      </div>
      <div className="text-sm text-muted-foreground mb-1">{dateStr}</div>
      <div className="flex items-center justify-between text-xs text-muted/60">
        <span>
          {startTime} — {endTime}
        </span>
        <span>{session.bar_count.toLocaleString()} bars</span>
      </div>
      {session.notes && (
        <p className="text-xs text-muted/60 mt-2 truncate">{session.notes}</p>
      )}
      {/* Progress bar — shows completion percentage for every session */}
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
    </Link>
  );
}
