/**
 * Practice Session Detail Page (Server Component)
 *
 * Shows a read-only review of a completed practice session:
 * the replay chart with all trade markers, stats, and trade list.
 */

import { getServerStore } from "@/lib/store/server";
import Link from "next/link";
import PracticeSessionDetail from "@/components/replay/practice-session-detail";

interface PageProps {
  params: Promise<{ practiceSessionId: string }>;
}

export default async function PracticeSessionDetailPage({ params }: PageProps) {
  const { practiceSessionId } = await params;
  const store = await getServerStore();

  const practiceSession = await store.practice.getSession(parseInt(practiceSessionId));
  if (!practiceSession) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">Practice session not found</p>
        <Link href="/replay/history" className="text-sm text-muted-foreground hover:text-foreground">
          Back to history
        </Link>
      </div>
    );
  }

  // Fetch replay session, bars, and practice trades in parallel.
  const [replaySession, bars, trades] = await Promise.all([
    store.replay.getSession(practiceSession.replay_session_id),
    store.replay.listBarsForSession(practiceSession.replay_session_id),
    store.practice.listTradesForSession(parseInt(practiceSessionId)),
  ]);

  if (!replaySession) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">Replay session data not found</p>
        <Link href="/replay/history" className="text-sm text-muted-foreground hover:text-foreground">
          Back to history
        </Link>
      </div>
    );
  }

  return (
    <div className="px-2 py-2">
      <PracticeSessionDetail
        practiceSession={practiceSession}
        replaySession={replaySession}
        bars={bars}
        trades={trades}
      />
    </div>
  );
}
