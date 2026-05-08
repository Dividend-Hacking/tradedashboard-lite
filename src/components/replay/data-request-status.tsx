"use client";

/**
 * DataRequestStatus — Shows active data requests with live status updates
 * and a per-row Cancel button.
 *
 * Subscribes through the Store layer so the same component works against
 * Supabase Realtime in cloud mode and the polling /api/local/realtime/
 * data-requests endpoint in local mode. When a request transitions to
 * "completed", we trigger a router refresh so the new session appears
 * in the session browser.
 *
 * Cancel deletes the data_requests row through a server action. Pending
 * rows leave the queue immediately. Processing rows can also be cancelled
 * — NT8 will fail to PATCH the missing row and silently abort. Errored
 * rows can be cleared too so the banner doesn't stay stuck on a dead
 * request.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import { DataRequest } from "@/types/replay";
import { cancelDataRequest } from "@/app/replay/actions";

interface DataRequestStatusProps {
  /** Initial active requests loaded server-side */
  initialRequests: DataRequest[];
}

export default function DataRequestStatus({ initialRequests }: DataRequestStatusProps) {
  const mode = useMode();
  const [requests, setRequests] = useState<DataRequest[]>(initialRequests);
  const router = useRouter();

  useEffect(() => {
    const store = getClientStore(mode);
    return store.replay.subscribeDataRequests((row, kind) => {
      if (kind === "delete") {
        setRequests((prev) => prev.filter((r) => r.id !== row.id));
        return;
      }
      // Both insert and update funnel here. If status is now "completed",
      // drop the row from the active list and trigger a refresh so the
      // new replay session shows up in the browser.
      if (row.status === "completed") {
        setRequests((prev) => prev.filter((r) => r.id !== row.id));
        router.refresh();
        return;
      }
      setRequests((prev) => {
        const idx = prev.findIndex((r) => r.id === row.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = row;
          return next;
        }
        return [...prev, row];
      });
    });
  }, [mode, router]);

  /** Optimistically remove the row, fire the server action, restore on
   *  failure. The row may also disappear via the realtime subscription
   *  when the cloud DELETE fans out — that's idempotent because the
   *  filter below is by id. */
  function handleCancel(id: number) {
    const previous = requests;
    setRequests((prev) => prev.filter((r) => r.id !== id));
    void (async () => {
      const result = await cancelDataRequest(id);
      if ("error" in result) {
        // Restore on failure so the user knows the request is still live.
        setRequests(previous);
        // eslint-disable-next-line no-alert
        alert(`Failed to cancel: ${result.error}`);
      }
    })();
  }

  // Only show if there are active requests
  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {requests.map((req) => (
        <RequestCard key={req.id} request={req} onCancel={handleCancel} />
      ))}
    </div>
  );
}

/** Individual request status card */
function RequestCard({
  request,
  onCancel,
}: {
  request: DataRequest;
  onCancel: (id: number) => void;
}) {
  const [pending, startTransition] = useTransition();

  const statusConfig = {
    pending: {
      label: "Waiting for NinjaTrader...",
      dotClass: "bg-yellow-400 animate-pulse",
      textClass: "text-yellow-400",
    },
    processing: {
      label: "NinjaTrader is fetching bars...",
      dotClass: "bg-blue-400 animate-pulse",
      textClass: "text-blue-400",
    },
    error: {
      label: request.error_message || "Export failed",
      dotClass: "bg-red-400",
      textClass: "text-accent-red",
    },
    completed: {
      label: "Done",
      dotClass: "bg-green-400",
      textClass: "text-accent-green",
    },
    no_data: {
      label: "No data for this date",
      dotClass: "bg-zinc-500",
      textClass: "text-muted-foreground",
    },
  };

  const config = statusConfig[request.status];

  // The cancel button label adapts so the action verb fits each state.
  // Terminal rows (error, no_data) get "Dismiss" since there's nothing
  // in flight to stop; active rows get "Cancel".
  const cancelLabel =
    request.status === "error" || request.status === "no_data"
      ? "Dismiss"
      : "Cancel";

  return (
    <div className="bg-card border border-card-border rounded-lg px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${config.dotClass}`} />
        <span className="text-sm text-foreground truncate">
          {request.instrument} — {request.timeframe} — {request.session_date}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-xs ${config.textClass}`}>{config.label}</span>
        <button
          onClick={() => startTransition(() => onCancel(request.id))}
          disabled={pending}
          title={cancelLabel}
          className="px-2 py-0.5 rounded text-xs text-muted-foreground border border-card-border
                     hover:text-accent-red hover:border-accent-red/40 disabled:opacity-40
                     disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "…" : cancelLabel}
        </button>
      </div>
    </div>
  );
}
