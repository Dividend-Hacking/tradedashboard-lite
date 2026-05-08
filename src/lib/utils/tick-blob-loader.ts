/**
 * tick-blob-loader — fetch a gzipped tick CSV and parse it into typed arrays.
 *
 * The /replay/[sessionId] page already does this inline inside TickViewer
 * (download → DecompressionStream → parseTickCsv) but it's tangled with
 * React loading-state. The Backtest dashboard needs the same pipeline as a
 * pure async function so it can fetch ticks for one of N selected sessions
 * without dragging React state through.
 *
 * Why a separate module instead of importing TickViewer's pipeline:
 *   - TickViewer is a "use client" component file (heavy import surface).
 *   - The dashboard caches `ParsedTicks` per session so the timeframe
 *     selector can re-aggregate cheaply without re-downloading. Caching at
 *     the loader-call layer keeps that bookkeeping simple.
 *
 * Performance note: the parse step is the longest CPU phase (~2-3s for an
 * 8M-tick day). We yield to the event loop ONCE before parsing so the
 * caller's loading UI has a chance to paint the "Aggregating ticks…" state.
 */

import {
  decompressGzip,
  parseTickCsv,
  type ParsedTicks,
} from "./tick-aggregation";

/** Phases the caller can observe while a blob is being fetched + parsed. */
export type TickLoadPhase =
  | { kind: "downloading"; loaded: number; total: number | null }
  | { kind: "decompressing" }
  | { kind: "parsing" };

/**
 * Download the gzipped tick CSV at `signedUrl`, decompress, and parse to
 * typed arrays.
 *
 * `onProgress` is optional — pass it from a UI that wants to show download
 * progress. The callback fires on every chunk received, then once for
 * decompressing, then once for parsing. It is NOT called from inside the
 * parse loop; that step runs to completion synchronously after the yield.
 */
export async function fetchAndParseTicks(
  signedUrl: string,
  onProgress?: (phase: TickLoadPhase) => void,
): Promise<ParsedTicks> {
  // 1. Stream the body so we can report progress. Uses the same chunked
  // accumulation pattern TickViewer uses; concatenates into one buffer at
  // the end because DecompressionStream wants a single ArrayBuffer.
  const resp = await fetch(signedUrl);
  if (!resp.ok) throw new Error(`Tick blob download failed: HTTP ${resp.status}`);

  const totalHeader = resp.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : null;
  if (!resp.body) throw new Error("Tick blob response had no body");

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress?.({ kind: "downloading", loaded, total });
    }
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  // 2. Decompress.
  onProgress?.({ kind: "decompressing" });
  const text = await decompressGzip(merged.buffer);

  // 3. Parse. Yield once before the (synchronous) hot loop so a "parsing…"
  // UI label has a chance to paint — same trick TickViewer uses at line 196.
  onProgress?.({ kind: "parsing" });
  await new Promise((r) => setTimeout(r, 0));

  return parseTickCsv(text);
}
