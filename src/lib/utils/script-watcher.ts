/**
 * Script Watcher
 * ──────────────
 * Process-singleton that watches `backtests/scripts/` for changes and fans
 * the events out to every connected SSE client (one per editor session).
 *
 * Why a singleton:
 *   `fs.watch()` is a finite OS-level resource on macOS. If every SSE
 *   request opened its own watcher we'd rapidly burn through file
 *   descriptors and blow up the dev process during `next dev`'s frequent
 *   route-handler reloads. One watcher per process, with a Node EventEmitter
 *   broadcasting to N subscribers, is the standard pattern for this. Since
 *   Next.js route handlers share the same Node module cache during a dev
 *   session, the singleton pattern works reliably.
 *
 * Why fs.watch (not chokidar):
 *   The watch target is exactly one directory with O(10) files at most. We
 *   don't need cross-platform reliability, .gitignore awareness, or
 *   recursive watching — `fs.watch` is built into Node and does the job.
 *   Adding chokidar would mean another dep for one watcher.
 *
 * Why debounce:
 *   `fs.watch` on macOS often fires `change` AND `rename` for a single
 *   atomic write (the temp file is renamed over the target — both events
 *   reference the new file). We coalesce events on the same name within
 *   a 50ms window so subscribers don't see duplicate broadcasts. The
 *   debounce is per-name so two different files saved at once still
 *   produce two events.
 *
 * Lifetime:
 *   The watcher starts on first import and never stops — Next.js dev
 *   hot-reloads will reload the module (and re-init the watcher) but
 *   never garbage-collect the old one's listeners cleanly. That's fine
 *   in dev; the worst case is a stale listener that no longer has a
 *   client, which never fires because clients disconnect when the route
 *   reloads.
 */
import { watch, FSWatcher } from "fs";
import { EventEmitter } from "events";
import path from "path";
import { ensureDir, scriptsDir, readFileWithMtime } from "./script-file-bridge";

/** Public event payload broadcast to every subscriber. The route handler
 *  serialises this directly into the SSE `data:` line so the dashboard's
 *  EventSource handler can JSON.parse it without further translation. */
export interface ScriptChangeEvent {
  type: "changed" | "deleted";
  name: string;
  /** Epoch ms — set on `changed` events, omitted on `deleted`. The dashboard
   *  uses this to suppress echoes of its own PUT writes (compares with the
   *  mtime returned in the PUT response). */
  mtimeMs?: number;
  /** Full file content on `changed`. Omitted on `deleted`. Sent inline so
   *  the editor doesn't need a follow-up GET to reflect the change. */
  content?: string;
}

/** Module-singleton emitter. `setMaxListeners(0)` disables Node's default
 *  warning at 11 — we genuinely expect one listener per open browser tab,
 *  and the warning would obscure real bugs in the dev console. */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Per-name debounce timers. Map<name, NodeJS.Timeout>. We hold a SINGLE
 *  pending timer per file so a burst of N events within the debounce
 *  window collapses to one broadcast carrying the latest content. */
const pendingTimers = new Map<string, NodeJS.Timeout>();

/** Set when the singleton has finished one-time setup. We guard the init
 *  with this so concurrent first-imports (race during dev hot-reload)
 *  don't double-arm the FSWatcher. */
let initialized = false;
/** Held in module scope so the watcher isn't garbage-collected. */
let watcher: FSWatcher | null = null;

/** Read the file (best-effort) and broadcast a `changed` event. Called
 *  AFTER the per-name debounce window expires so we read the post-write
 *  content, not the half-written intermediate. ENOENT here means the file
 *  was deleted between the watch event firing and our read — we surface
 *  that as a `deleted` event so subscribers can react accordingly. */
async function broadcastChange(name: string): Promise<void> {
  const abs = path.join(scriptsDir(), name);
  try {
    const result = await readFileWithMtime(abs);
    if (!result) {
      const evt: ScriptChangeEvent = { type: "deleted", name };
      emitter.emit("script", evt);
      return;
    }
    const evt: ScriptChangeEvent = {
      type: "changed",
      name,
      mtimeMs: result.mtimeMs,
      content: result.content,
    };
    emitter.emit("script", evt);
  } catch (err) {
    // Read failures other than ENOENT are unusual (permissions, EBUSY).
    // Log and skip — the next event for this file will retry.
    console.warn(
      `[script-watcher] read failed for ${name}:`,
      (err as Error).message
    );
  }
}

/** First-import setup. Creates the scripts directory if missing (so the
 *  watch call doesn't fail on a fresh checkout) and arms the FSWatcher. */
async function initWatcher(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const dir = scriptsDir();
  await ensureDir(dir);
  try {
    watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
      // `filename` can be null on some platforms / under heavy churn. We
      // don't have a way to recover the changed name in that case; skip
      // and let the next event (with a name) deliver the update.
      if (!filename) return;
      // Ignore our own atomic-write temp files. `script-file-bridge.ts`'s
      // atomicWrite() stages writes through `.<name>.<pid>.<ts>.tmp` so
      // we filter on that prefix to avoid burning a debounce timer on
      // every staging write.
      if (filename.startsWith(".")) return;
      // Reset (or arm) the debounce timer for this name.
      const existing = pendingTimers.get(filename);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pendingTimers.delete(filename);
        void broadcastChange(filename);
      }, 50);
      pendingTimers.set(filename, timer);
    });
    watcher.on("error", (err) => {
      console.warn("[script-watcher] FSWatcher error:", err.message);
    });
  } catch (err) {
    console.warn(
      "[script-watcher] failed to start watcher:",
      (err as Error).message
    );
    initialized = false; // Allow a future import to retry init.
  }
}

/** Subscribe to script change events. Returns an `unsubscribe` function the
 *  SSE route handler MUST call when the client disconnects. The handler
 *  registers `unsubscribe` on `req.signal.aborted` so a closed tab releases
 *  the listener immediately. */
export function subscribeToScriptChanges(
  listener: (evt: ScriptChangeEvent) => void
): () => void {
  // Lazy-init so importing this module from a non-route context doesn't
  // start the watcher unnecessarily.
  void initWatcher();
  emitter.on("script", listener);
  return () => {
    emitter.off("script", listener);
  };
}
