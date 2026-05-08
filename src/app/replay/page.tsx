/**
 * Replay Session Browser Page (Server Component)
 *
 * Fetches all replay sessions from the active backend and renders the
 * session browser where users can pick a session to practice on.
 */

import { getServerStore } from "@/lib/store/server";
import ReplayBrowser from "@/components/replay/replay-browser";
import Link from "next/link";

export default async function ReplayPage() {
  const store = await getServerStore();

  try {
    // Fetch sessions, the active-requests list (for the per-row status cards),
    // AND the queue summary (for the top-of-page banner). The summary is
    // server-rendered so a refresh shows correct counts on first paint —
    // no flash of empty state, which is what made it look like the
    // download had stopped.
    const [sessions, activeRequests, queueSummary] = await Promise.all([
      store.replay.listSessions(),
      store.replay.listPendingDataRequests(),
      store.replay.getQueueSummary(),
    ]);

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
          sessions={sessions}
          activeRequests={activeRequests}
          queueSummary={queueSummary}
        />
      </div>
    );
  } catch (err) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-accent-red">
          Failed to load replay sessions: {err instanceof Error ? err.message : String(err)}
        </p>
      </div>
    );
  }
}
