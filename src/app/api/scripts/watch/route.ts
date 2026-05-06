/**
 * API route: GET /api/scripts/watch
 *
 * Server-Sent Events stream that pushes script-file changes to the
 * dashboard editor. The dashboard opens an EventSource on this endpoint
 * with `?name=<scriptName>` and receives a `data: {...}` line every time
 * the named file changes on disk.
 *
 * Why SSE (not WebSocket):
 *   - One-way, server-to-client — no need for bidirectional framing.
 *   - Trivially survives Next.js's dev-mode route reloads (a fresh GET
 *     re-arms the listener; the editor's EventSource auto-reconnects).
 *   - No extra deps; the Web Streams API + Node EventEmitter is enough.
 *
 * Lifecycle:
 *   - Subscribe to the singleton watcher (`script-watcher.ts`) on stream
 *     start.
 *   - Forward every event whose `name` matches the query (or all events
 *     when no name was supplied — useful for the picker if we ever want
 *     a "list refreshed" toast).
 *   - Send heartbeat comments every 25s so intermediate proxies don't
 *     close the idle connection. The SSE spec defines `:` as a comment
 *     line — clients ignore it.
 *   - Unsubscribe on `req.signal.aborted` (browser tab closed / navigated
 *     away). Without this we'd accumulate dead listeners over a long dev
 *     session and slow event delivery to a crawl.
 */
import { NextRequest } from "next/server";
import { subscribeToScriptChanges } from "@/lib/utils/script-watcher";

/** SSE message format: `data: <json>\n\n`. The double-newline is the
 *  end-of-event marker that flushes the message to the client. */
function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const filterName = url.searchParams.get("name");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();

      // Initial comment so the client's `onopen` fires immediately rather
      // than waiting for the first real event. Helps the dashboard show a
      // "live" indicator without ambiguity about connection state.
      controller.enqueue(enc.encode(": connected\n\n"));

      // Heartbeat to keep the connection alive across proxies / browser
      // idle timeouts. 25s comfortably under the typical 30s-60s gateways.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          // Controller closed — the abort handler below will clean up.
        }
      }, 25_000);

      const unsubscribe = subscribeToScriptChanges((evt) => {
        // Filter by name when the client asked for one specific file. The
        // dashboard always passes `?name=` because the editor is showing
        // exactly one file at a time; the unfiltered case is reserved for
        // future picker-level refreshes.
        if (filterName && evt.name !== filterName) return;
        try {
          controller.enqueue(enc.encode(sseLine(evt)));
        } catch {
          // Stream already closed — ignore. Cleanup runs from abort.
        }
      });

      // Single source of truth for cleanup. Triggered by either:
      //   1. The browser closing the EventSource (`req.signal.aborted`).
      //   2. The stream `cancel()` being called (rare — usually the abort
      //      fires first).
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Next.js / Vercel buffering so each event is flushed
      // promptly. Harmless in dev where there's no buffering layer; the
      // header is documented for future production deployments.
      "X-Accel-Buffering": "no",
    },
  });
}
