/**
 * Replay Session Browser Page (Server Component)
 *
 * Fetches all replay sessions from Supabase and renders the
 * session browser where users can pick a session to practice on.
 */

import { createClient } from "@/lib/supabase/server";
import { ReplaySession, DataRequest } from "@/types/replay";
import ReplayBrowser from "@/components/replay/replay-browser";
import Link from "next/link";

export default async function ReplayPage() {
  const supabase = await createClient();

  // Fetch sessions and active data requests in parallel
  const [sessionsResult, requestsResult] = await Promise.all([
    supabase
      .from("replay_sessions")
      .select("*")
      .order("session_date", { ascending: false }),
    supabase
      .from("data_requests")
      .select("*")
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false }),
  ]);

  if (sessionsResult.error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-accent-red">
          Failed to load replay sessions: {sessionsResult.error.message}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Practice Trading</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Select a session to replay and practice your entries and exits
          </p>
        </div>
        <Link
          href="/replay/history"
          className="px-3 py-1.5 rounded text-sm bg-card border border-card-border
                     text-muted-foreground hover:text-foreground hover:border-muted transition-colors"
        >
          Practice History
        </Link>
      </div>
      <ReplayBrowser
        sessions={(sessionsResult.data as ReplaySession[]) ?? []}
        activeRequests={(requestsResult.data as DataRequest[]) ?? []}
      />
    </div>
  );
}
