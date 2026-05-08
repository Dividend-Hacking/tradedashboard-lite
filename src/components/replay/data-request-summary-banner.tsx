"use client";

/**
 * DataRequestSummaryBanner — top-of-page queue overview.
 *
 * Two reasons this exists:
 *
 *   1. It's server-rendered on first paint. After a refresh, the user sees
 *      real counts immediately instead of waiting for the 2s polling
 *      subscription in DataRequestStatus to reseed state. That kills the
 *      "page refresh stops the download" perception — the download was
 *      never stopped, the UI just hadn't caught up.
 *
 *   2. It surfaces terminal-error rows (auto-retry exhausted) and gives
 *      the user one click to re-queue them all. Errored rows used to be
 *      invisible unless they happened to be in the active request list,
 *      so the only fix was deleting the DB or re-requesting one date at
 *      a time.
 *
 * The banner is a client component to support the "Retry errored" button's
 * pending state, but it accepts the initial counts as props so the server
 * render is self-sufficient. After mount, counts re-fetch on retry so the
 * UI updates without a full page refresh.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DataRequestQueueSummary } from "@/types/replay";
import {
  retryAllErroredDataRequests,
  clearNoDataDataRequests,
} from "@/app/replay/actions";

interface Props {
  initial: DataRequestQueueSummary;
}

export default function DataRequestSummaryBanner({ initial }: Props) {
  const [summary, setSummary] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const total =
    summary.completed +
    summary.pending +
    summary.processing +
    summary.errored +
    summary.noData;
  // Skip rendering when the table is empty — the form alone is enough UI.
  if (total === 0) return null;

  const handleRetry = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await retryAllErroredDataRequests();
      if ("error" in result) {
        setMessage(`Retry failed: ${result.error}`);
        return;
      }
      // Optimistic update: move errored → pending in the local count, then
      // refresh from the server so we pick up any concurrent NT8 progress.
      setSummary((prev) => ({
        ...prev,
        errored: 0,
        pending: prev.pending + result.retried,
      }));
      setMessage(
        result.retried === 0
          ? "Nothing to retry"
          : `Re-queued ${result.retried} day${result.retried === 1 ? "" : "s"}`
      );
      router.refresh();
    });
  };

  const handleClearNoData = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await clearNoDataDataRequests();
      if ("error" in result) {
        setMessage(`Clear failed: ${result.error}`);
        return;
      }
      setSummary((prev) => ({ ...prev, noData: 0 }));
      setMessage(
        result.cleared === 0
          ? "Nothing to clear"
          : `Cleared ${result.cleared} no-data day${result.cleared === 1 ? "" : "s"} — re-submit a range to retry them`
      );
      router.refresh();
    });
  };

  return (
    <div className="bg-card border border-card-border rounded-lg px-4 py-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-sm flex-wrap">
          <Stat label="downloaded" value={summary.completed} tone="muted" />
          {summary.pending > 0 && (
            <Stat label="pending" value={summary.pending} tone="yellow" />
          )}
          {summary.processing > 0 && (
            <Stat label="processing" value={summary.processing} tone="blue" />
          )}
          {summary.errored > 0 && (
            <Stat label="errored" value={summary.errored} tone="red" />
          )}
          {summary.noData > 0 && (
            <Stat label="no-data" value={summary.noData} tone="muted-dim" />
          )}
          {summary.lastActivityAt && (
            <span className="text-xs text-muted-foreground">
              last activity {formatRelative(summary.lastActivityAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {summary.errored > 0 && (
            <button
              onClick={handleRetry}
              disabled={pending}
              className="px-2.5 py-1 rounded text-xs bg-accent-red/15 text-accent-red
                         border border-accent-red/40 hover:bg-accent-red/25
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? "Retrying…" : `Retry ${summary.errored} errored`}
            </button>
          )}
          {summary.noData > 0 && (
            <button
              onClick={handleClearNoData}
              disabled={pending}
              title="Drop no-data markers so a re-submitted range will reattempt those dates"
              className="px-2.5 py-1 rounded text-xs text-muted-foreground border border-card-border
                         hover:text-foreground hover:border-muted
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Clear {summary.noData} no-data
            </button>
          )}
        </div>
      </div>
      {message && (
        <p className="mt-1.5 text-xs text-muted-foreground">{message}</p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "muted" | "muted-dim" | "yellow" | "blue" | "red";
}) {
  const toneClass = {
    muted: "text-foreground",
    "muted-dim": "text-muted-foreground",
    yellow: "text-yellow-400",
    blue: "text-blue-400",
    red: "text-accent-red",
  }[tone];
  return (
    <span className="text-xs text-muted-foreground">
      <span className={`font-medium ${toneClass}`}>{value.toLocaleString()}</span>{" "}
      {label}
    </span>
  );
}

/** "2 minutes ago" / "3 hours ago" / falls back to absolute date. The
 *  banner is server-rendered with the snapshot at request time, then
 *  re-rendered after retries — close-enough relative time is fine. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
