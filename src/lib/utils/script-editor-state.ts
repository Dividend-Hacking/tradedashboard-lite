/**
 * ScriptEditorState
 *
 * Two-tier persistence for the Backtesting tab's Script-mode editor draft.
 * Mirrors the strategy used by `backtest-presets.ts` so behavior is
 * predictable across the dashboard:
 *
 *   - **Supabase `script_editor_state` table** is the durable source of truth.
 *     Survives reinstalls, syncs across devices, recoverable if a browser
 *     wipes localStorage. Single-user, RLS off.
 *   - **localStorage** is a fast cache so the editor can hydrate synchronously
 *     on mount without waiting on the network — and so the user's draft is
 *     still there if Supabase is unreachable.
 *
 * Why a separate file (instead of just inlining inside the dashboard):
 *   - Keeps the dashboard component focused on UI; storage is well-tested
 *     plumbing that benefits from being isolated.
 *   - Lets the helpers be reused if we later want to expose script drafts
 *     to other pages (e.g. a dedicated /scripts route or a list of saved
 *     drafts keyed by name).
 *
 * Read path:
 *   - `loadScriptDraft()` is synchronous — returns the localStorage cache
 *     (empty string if nothing is saved). The dashboard calls this on mount
 *     to seed `scriptText` so there is no flash of empty editor while the
 *     server round-trip resolves.
 *   - `syncScriptDraftFromSupabase()` pulls the server row in the background,
 *     reconciles with local cache by `updated_at` (last-write-wins), writes
 *     the merged result back to localStorage, and returns it so the caller
 *     can update React state with whatever turned out to be newest.
 *
 * Write path:
 *   - `saveScriptDraft(content)` writes to localStorage synchronously and
 *     fires a background Supabase upsert. Both writes use the SAME
 *     `updated_at` timestamp so the sync reconciliation can compare apples
 *     to apples. Failures on the Supabase side log but do not surface — the
 *     local copy is intact, and the next sync will retry by pushing the
 *     locally-newer row up.
 *
 * Single-draft model:
 *   - Today we only persist ONE draft (the one currently in the editor),
 *     keyed by the literal id `'default'`. The `id` column is a text PK so
 *     we can extend to multiple named drafts later without a migration.
 */
import { createClient } from "@/lib/supabase/client";

/** Fixed primary-key value for the single active draft row. Centralized so
 *  every call site agrees on which row to read/write. */
const DRAFT_ID = "default";

/** localStorage key for the cached draft. Versioned (`.v1`) so we can change
 *  the cache shape later without colliding with old saved data. The current
 *  value stored at this key is a JSON object: { content, updatedAt }. */
const STORAGE_KEY = "tradedashboard.scriptDraft.v1";

/** Shape of the cached draft in localStorage. Storing the timestamp alongside
 *  the content lets `syncScriptDraftFromSupabase` apply last-write-wins
 *  reconciliation without re-fetching the local copy. */
export interface ScriptDraft {
  /** The full editor text. Empty string is a valid value (= cleared draft). */
  content: string;
  /** ISO-8601 string. Set to `new Date().toISOString()` on every write. */
  updatedAt: string;
}

/** Safe guard for SSR — server-side renders have no window.localStorage. */
function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

/** Synchronously read the cached draft from localStorage. Returns an empty
 *  draft on first run, parse errors, or SSR — never throws. */
export function loadScriptDraft(): ScriptDraft {
  if (!hasStorage()) return { content: "", updatedAt: "" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { content: "", updatedAt: "" };
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.content === "string" &&
      typeof parsed.updatedAt === "string"
    ) {
      return parsed as ScriptDraft;
    }
    return { content: "", updatedAt: "" };
  } catch {
    return { content: "", updatedAt: "" };
  }
}

/** Overwrite the cached draft. Writes the same `{ content, updatedAt }`
 *  object that `loadScriptDraft` reads. */
function writeScriptDraft(draft: ScriptDraft): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Quota errors etc. — non-fatal. The Supabase copy is the durable one.
  }
}

/** Fire-and-forget Supabase upsert. Mirrors the pattern in
 *  `backtest-presets.ts` — failures log but don't surface, since the local
 *  cache succeeded and the next sync will retry. */
async function pushScriptDraftToSupabase(draft: ScriptDraft): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const supabase = createClient();
    const { error } = await supabase
      .from("script_editor_state")
      .upsert(
        {
          id: DRAFT_ID,
          content: draft.content,
          updated_at: draft.updatedAt,
        },
        { onConflict: "id" }
      );
    if (error) {
      console.warn(
        "[script-editor-state] Supabase upsert failed:",
        error.message
      );
    }
  } catch (err) {
    console.warn("[script-editor-state] Supabase upsert threw:", err);
  }
}

/** Public write entrypoint. Writes localStorage synchronously (so the next
 *  reload reads the new value even if the Supabase round-trip is in flight)
 *  and fires the Supabase upsert in the background. Returns the timestamp
 *  used so callers can keep their in-memory copy aligned. */
export function saveScriptDraft(content: string): ScriptDraft {
  const draft: ScriptDraft = {
    content,
    updatedAt: new Date().toISOString(),
  };
  writeScriptDraft(draft);
  // Don't await — saves should never block the typing path.
  pushScriptDraftToSupabase(draft).catch(() => {});
  return draft;
}

/**
 * Pull the canonical draft from Supabase, reconcile with the localStorage
 * cache by `updated_at` (last-write-wins), write the merged result back to
 * localStorage, and return it.
 *
 * Reconciliation rules (single-user, no auth, last-write-wins):
 *   - Server has row, local doesn't → take server (fresh device).
 *   - Local newer than server → push local up (offline edit caught up).
 *   - Server newer than local → adopt server locally.
 *   - Equal timestamps → keep server (deterministic convergence).
 *
 * Safe to call concurrently (idempotent upserts). Returns the merged draft
 * so the caller can decide whether to update React state.
 */
export async function syncScriptDraftFromSupabase(): Promise<ScriptDraft> {
  if (typeof window === "undefined") return { content: "", updatedAt: "" };

  const local = loadScriptDraft();

  let serverDraft: ScriptDraft | null = null;
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("script_editor_state")
      .select("content, updated_at")
      .eq("id", DRAFT_ID)
      .maybeSingle();
    if (error) {
      console.warn(
        "[script-editor-state] Supabase fetch failed:",
        error.message
      );
      return local;
    }
    if (data && typeof data.content === "string") {
      serverDraft = {
        content: data.content,
        updatedAt:
          typeof data.updated_at === "string"
            ? data.updated_at
            : new Date(0).toISOString(),
      };
    }
  } catch (err) {
    console.warn("[script-editor-state] Supabase fetch threw:", err);
    return local;
  }

  // No server row yet — push local up if we have any cached content so the
  // server catches up to our state. Otherwise nothing to do.
  if (!serverDraft) {
    if (local.content && local.updatedAt) {
      pushScriptDraftToSupabase(local).catch(() => {});
    }
    return local;
  }

  const localTs = local.updatedAt ? Date.parse(local.updatedAt) : 0;
  const serverTs = serverDraft.updatedAt
    ? Date.parse(serverDraft.updatedAt)
    : 0;

  if (Number.isFinite(localTs) && localTs > serverTs) {
    // Local is newer — push it up; server will catch up.
    pushScriptDraftToSupabase(local).catch(() => {});
    return local;
  }

  // Server wins (newer, or tied). Update the local cache so the next
  // synchronous load matches and return the server copy to the caller.
  if (
    serverDraft.content !== local.content ||
    serverDraft.updatedAt !== local.updatedAt
  ) {
    writeScriptDraft(serverDraft);
  }
  return serverDraft;
}
