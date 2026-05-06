/**
 * Script File Bridge
 * ──────────────────
 * Server-side helpers shared by the `/api/scripts` route family. Centralises
 * the three things every route needs: where the on-disk scripts live, how to
 * validate a user-supplied file name, and how to write a file atomically so
 * an editor that's mid-edit never observes a half-written script.
 *
 * Why this file exists in `src/lib/utils/` rather than colocated with the
 * routes: the SSE watcher (`script-watcher.ts`) and at least three routes
 * (`/api/scripts`, `/api/scripts/[name]`, `/api/scripts/results`) all need
 * the same `scriptsDir()` + `safeJoin()` semantics. Putting them in one
 * module guarantees they agree on the security boundary.
 *
 * Security note — directory traversal:
 *   `safeJoin()` is the chokepoint. Every API route MUST resolve its target
 *   path through this function and treat a `null` return as a 400. The
 *   regex check (`^[A-Za-z0-9._-]+\.dsl$`) catches the obvious cases; the
 *   `path.resolve(...).startsWith(rootDir)` check after that is defence
 *   in depth against odd inputs (`./..`, embedded NUL, symlinks). Both
 *   layers must hold for a name to pass.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";

/** Allowed file-name shape for a DSL script. Matches the same character
 *  class our preset-name sanitizer uses (`new-strategy.sh` /
 *  `convert-to-nt8/route.ts`) so users see consistent rules across the app.
 *  The `.dsl` suffix is required so a stray non-DSL file in the directory
 *  can never be loaded by mistake. */
const NAME_REGEX = /^[A-Za-z0-9._-]+\.dsl$/;

/** Absolute path to the directory that holds DSL scripts. Resolved from
 *  `process.cwd()` — the same convention `convert-to-nt8/route.ts:26-28`
 *  uses, which works because `next dev` and the supervisor both run with
 *  the project root as cwd. */
export function scriptsDir(): string {
  return path.resolve(process.cwd(), "backtests", "scripts");
}

/** Absolute path to the directory that holds dashboard-run results. Same
 *  cwd convention as `scriptsDir()`. */
export function resultsDir(): string {
  return path.resolve(process.cwd(), "backtests", "dashboard-results");
}

/** Validate a user-supplied script name and return its absolute path inside
 *  `scriptsDir()`. Returns `null` if the name fails the regex OR if the
 *  resolved path escapes the scripts directory (defence in depth against
 *  `..` segments, symlinks, embedded NULs). Callers should treat `null`
 *  as a 400 Bad Request — never as "file missing." */
export function safeScriptPath(name: string): string | null {
  if (typeof name !== "string" || !NAME_REGEX.test(name)) return null;
  const root = scriptsDir();
  const abs = path.resolve(root, name);
  // The `+ path.sep` guard catches the case where a name happens to share
  // a prefix with the root dir's parent (e.g. root = `/a/scripts`, abs =
  // `/a/scripts-other/foo.dsl` — `startsWith(root)` is true but the file
  // is outside the directory). Appending the separator forces the match
  // to land on a directory boundary.
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Same shape as `safeScriptPath` but for the results directory. Filenames
 *  here are server-generated, but routes still use this so the validation
 *  posture is uniform. */
export function safeResultPath(name: string): string | null {
  if (typeof name !== "string" || !NAME_REGEX.test(name.replace(/\.(json|csv)$/, ".dsl"))) {
    // Allow .json / .csv extensions on top of the same character class.
    if (!/^[A-Za-z0-9._-]+\.(json|csv)$/.test(name)) return null;
  }
  const root = resultsDir();
  const abs = path.resolve(root, name);
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Ensure a directory exists. Idempotent — no-op if already there. Mirrors
 *  the `fs.mkdir(..., { recursive: true })` pattern in the convert-to-nt8
 *  route. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Atomic write: stage to a sibling temp file, fsync it, then rename over
 *  the target. The rename is the atomic step on POSIX — observers either
 *  see the OLD file or the NEW file, never a partial write. This matters
 *  here because:
 *
 *    - The SSE watcher (`script-watcher.ts`) fires on every `fs.watch`
 *      event. Without atomic writes, it would broadcast the half-written
 *      state, the dashboard editor would replace its content with the
 *      partial text, and the user would see corruption.
 *    - Claude Code (or any external editor) writes files atomically by
 *      default. Matching that behaviour from our PUT route means the two
 *      sides of the bridge use the same write discipline and the watcher
 *      never has to special-case "our" writes vs. "theirs."
 *
 *  Returns the post-write mtime in epoch-ms so the caller can include it
 *  in the API response (used by the dashboard to suppress its own SSE echo). */
export async function atomicWrite(
  abs: string,
  content: string
): Promise<number> {
  await ensureDir(path.dirname(abs));
  // Use the OS tmp dir suffix so a crashed write leaves orphan files in a
  // place the OS will eventually clean up, rather than littering the
  // scripts dir with `.tmp` files the user can see.
  // On the same volume, rename is atomic. Cross-volume rename falls back
  // to copy+unlink — also fine for our purposes (rare in practice because
  // both temp and target are typically on the user's home volume).
  const tmpName = `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`;
  const tmpPath = path.join(path.dirname(abs), tmpName);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, abs);
  const stat = await fs.stat(abs);
  return stat.mtimeMs;
}

/** Read a file as utf8 with its mtime. Returns null if missing — callers
 *  decide whether that's a 404 or a default. Other errors propagate so the
 *  route handler can surface them as a 500. */
export async function readFileWithMtime(
  abs: string
): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(abs, "utf8"),
      fs.stat(abs),
    ]);
    return { content, mtimeMs: stat.mtimeMs };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

/** Tiny convenience: list `.dsl` files in `scriptsDir()` with their size +
 *  mtime. Hidden / non-matching entries are filtered out so the listing
 *  matches what the safeScriptPath validator would accept. */
export async function listScripts(): Promise<
  Array<{ name: string; sizeBytes: number; mtimeMs: number }>
> {
  const dir = scriptsDir();
  await ensureDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Array<{ name: string; sizeBytes: number; mtimeMs: number }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!NAME_REGEX.test(e.name)) continue;
    try {
      const stat = await fs.stat(path.join(dir, e.name));
      out.push({ name: e.name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // File vanished between readdir + stat — skip silently. Next list
      // call will reflect reality.
    }
  }
  // Most-recent first so the dashboard's picker surfaces the file the
  // user is most likely to want.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Quiet helper for routes that want to log without leaking absolute paths
 *  in production-style stack traces. We only use this in dev (no auth on
 *  these routes anyway), so it's purely a tidiness concern. */
export function relForLog(abs: string): string {
  return path.relative(os.homedir(), abs) || abs;
}
