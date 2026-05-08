/**
 * Replay Viewer Page (Server Component)
 *
 * Fetches a specific replay session and all its bars from the active
 * backend, then renders the full replay viewer with chart, controls,
 * and trade panel.
 */

import { getServerStore } from "@/lib/store/server";
import ReplayViewer from "@/components/replay/replay-viewer";
import TickViewer from "@/components/replay/tick-viewer";
import Link from "next/link";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function ReplayViewerPage({ params }: PageProps) {
  const { sessionId } = await params;
  const store = await getServerStore();

  const session = await store.replay.getSession(parseInt(sessionId));

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">Session not found</p>
        <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
          Back to sessions
        </Link>
      </div>
    );
  }

  // Tick sessions store their data as a gzipped CSV blob (one file per
  // session) rather than rows in `replay_bars`, because a busy NQ day is
  // 3-8M trades. We mint a 1-hour signed URL here on the server (Supabase
  // Storage signed URL in cloud mode, an HMAC-stamped /api/local URL in
  // local mode) and hand it to the client-side TickViewer, which downloads,
  // decompresses, parses, and aggregates the ticks into bars at whatever
  // timeframe the user picks.
  if (session.granularity === "tick" || session.granularity === "tick_bidask") {
    const blobPath = session.tick_blob_path;
    if (!blobPath) {
      return (
        <div className="flex min-h-screen items-center justify-center flex-col gap-4">
          <p className="text-accent-red">
            Blob path missing — the tick session may not have finished uploading.
          </p>
          <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
            Back to sessions
          </Link>
        </div>
      );
    }

    let signedUrl: string;
    try {
      signedUrl = await store.replay.getTickBlobUrl(blobPath, 3600);
    } catch (err) {
      return (
        <div className="flex min-h-screen items-center justify-center flex-col gap-4">
          <p className="text-accent-red">
            Could not generate download URL for {blobPath}: {err instanceof Error ? err.message : String(err)}
          </p>
          <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
            Back to sessions
          </Link>
        </div>
      );
    }

    return (
      <div className="px-2 py-2 h-[calc(100vh-52px)]">
        <TickViewer session={session} signedUrl={signedUrl} />
      </div>
    );
  }

  // Fetch ALL bars. The store layer handles pagination internally.
  let bars;
  try {
    bars = await store.replay.listBarsForSession(parseInt(sessionId));
  } catch (err) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-accent-red">
          Failed to load bar data: {err instanceof Error ? err.message : String(err)}
        </p>
        <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
          Back to sessions
        </Link>
      </div>
    );
  }

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
  // Non-fatal: if it fails we pass an empty list and the picker still
  // renders with just a "+ New section" option.
  const sections = await store.zones.listSections().catch(() => []);

  return (
    <div className="px-2 py-2 h-[calc(100vh-52px)]">
      <ReplayViewer session={session} bars={bars} sections={sections} />
    </div>
  );
}
