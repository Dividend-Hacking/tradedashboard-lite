/**
 * Practice Session Detail Page (Server Component)
 *
 * Shows a read-only review of a completed practice session:
 * the replay chart with all trade markers, stats, and trade list.
 */

import { createClient } from "@/lib/supabase/server";
import { ReplaySession, ReplayBar, PracticeSession, PracticeTrade } from "@/types/replay";
import Link from "next/link";
import PracticeSessionDetail from "@/components/replay/practice-session-detail";

interface PageProps {
  params: Promise<{ practiceSessionId: string }>;
}

export default async function PracticeSessionDetailPage({ params }: PageProps) {
  const { practiceSessionId } = await params;
  const supabase = await createClient();

  // Fetch practice session
  const { data: ps, error: psError } = await supabase
    .from("practice_sessions")
    .select("*")
    .eq("id", parseInt(practiceSessionId))
    .single();

  if (psError || !ps) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">Practice session not found</p>
        <Link href="/replay/history" className="text-sm text-muted-foreground hover:text-foreground">
          Back to history
        </Link>
      </div>
    );
  }

  const practiceSession = ps as PracticeSession;

  // Fetch replay session, bars, and practice trades in parallel
  const [replayResult, barsResult, tradesResult] = await Promise.all([
    supabase
      .from("replay_sessions")
      .select("*")
      .eq("id", practiceSession.replay_session_id)
      .single(),
    supabase
      .from("replay_bars")
      .select("*")
      .eq("session_id", practiceSession.replay_session_id)
      .order("bar_index", { ascending: true }),
    supabase
      .from("practice_trades")
      .select("*")
      .eq("practice_session_id", parseInt(practiceSessionId))
      .order("entry_bar_index", { ascending: true }),
  ]);

  if (replayResult.error || !replayResult.data) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">Replay session data not found</p>
        <Link href="/replay/history" className="text-sm text-muted-foreground hover:text-foreground">
          Back to history
        </Link>
      </div>
    );
  }

  const replaySession = replayResult.data as ReplaySession;
  const bars = (barsResult.data as ReplayBar[]) ?? [];
  const trades = (tradesResult.data as PracticeTrade[]) ?? [];

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
