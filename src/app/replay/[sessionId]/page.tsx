/**
 * Replay Viewer Page (Server Component)
 *
 * Fetches a specific replay session and all its bars from Supabase,
 * then renders the full replay viewer with chart, controls, and trade panel.
 */

import { createClient } from "@/lib/supabase/server";
import { ReplaySession, ReplayBar } from "@/types/replay";
import { ZoneSection } from "@/types/trade-zone";
import ReplayViewer from "@/components/replay/replay-viewer";
import Link from "next/link";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function ReplayViewerPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createClient();

  // Fetch session metadata
  const sessionResult = await supabase
    .from("replay_sessions")
    .select("*")
    .eq("id", parseInt(sessionId))
    .single();

  if (sessionResult.error || !sessionResult.data) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">Session not found</p>
        <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
          Back to sessions
        </Link>
      </div>
    );
  }

  const session = sessionResult.data as ReplaySession;

  // Fetch ALL bars with pagination (Supabase caps at 1000 rows per request)
  const allBars: ReplayBar[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("replay_bars")
      .select("*")
      .eq("session_id", parseInt(sessionId))
      .order("bar_index", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      return (
        <div className="flex min-h-screen items-center justify-center flex-col gap-4">
          <p className="text-accent-red">
            Failed to load bar data: {error.message}
          </p>
          <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
            Back to sessions
          </Link>
        </div>
      );
    }

    const rows = (data as ReplayBar[]) ?? [];
    allBars.push(...rows);
    hasMore = rows.length === pageSize;
    offset += pageSize;
  }

  const bars = allBars;

  if (bars.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-muted-foreground">No bar data available for this session</p>
        <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
          Back to sessions
        </Link>
      </div>
    );
  }

  // Fetch zone sections for the practice session's section picker.
  // A non-fatal fetch — if it fails we pass an empty list and the picker
  // still renders with just a "+ New section" option.
  const sectionsResult = await supabase
    .from("zone_sections")
    .select("*")
    .order("name", { ascending: true });

  const sections = (sectionsResult.data as ZoneSection[]) ?? [];

  return (
    <div className="px-2 py-2 h-[calc(100vh-52px)]">
      <ReplayViewer session={session} bars={bars} sections={sections} />
    </div>
  );
}
