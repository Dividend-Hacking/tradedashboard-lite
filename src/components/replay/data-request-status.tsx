"use client";

/**
 * DataRequestStatus — Shows active data requests with live status updates.
 *
 * Uses Supabase Realtime to subscribe to changes on the data_requests table.
 * When a request transitions to "completed", triggers a page refresh so the
 * new session appears in the session browser.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataRequest } from "@/types/replay";

interface DataRequestStatusProps {
  /** Initial active requests loaded server-side */
  initialRequests: DataRequest[];
}

export default function DataRequestStatus({ initialRequests }: DataRequestStatusProps) {
  const [requests, setRequests] = useState<DataRequest[]>(initialRequests);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    // Subscribe to all changes on data_requests table
    const channel = supabase
      .channel("data-requests-status")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "data_requests" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            // New request added — show it
            const newReq = payload.new as DataRequest;
            setRequests((prev) => {
              // Avoid duplicates
              if (prev.some((r) => r.id === newReq.id)) return prev;
              return [...prev, newReq];
            });
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as DataRequest;

            if (updated.status === "completed") {
              // Remove from active list and refresh page to load new session
              setRequests((prev) => prev.filter((r) => r.id !== updated.id));
              router.refresh();
            } else if (updated.status === "error") {
              // Update in place to show error
              setRequests((prev) =>
                prev.map((r) => (r.id === updated.id ? updated : r))
              );
            } else {
              // Status changed (e.g. pending → processing)
              setRequests((prev) =>
                prev.map((r) => (r.id === updated.id ? updated : r))
              );
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);

  // Only show if there are active requests
  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {requests.map((req) => (
        <RequestCard key={req.id} request={req} />
      ))}
    </div>
  );
}

/** Individual request status card */
function RequestCard({ request }: { request: DataRequest }) {
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
  };

  const config = statusConfig[request.status];

  return (
    <div className="bg-card border border-card-border rounded-lg px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${config.dotClass}`} />
        <span className="text-sm text-foreground">
          {request.instrument} — {request.timeframe} — {request.session_date}
        </span>
      </div>
      <span className={`text-xs ${config.textClass}`}>{config.label}</span>
    </div>
  );
}
