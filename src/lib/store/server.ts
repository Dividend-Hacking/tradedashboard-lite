/**
 * Server-only Store factory.
 *
 * Lives in a separate module from `@/lib/store` so client bundles never
 * pull `next/headers` (used by the Supabase server client) or
 * better-sqlite3 (used by the local-server store). Importing this file
 * from a client component will fail at build time thanks to the
 * `server-only` guard below.
 *
 * Server components, server actions, and route handlers should call
 * `await getServerStore()` here. Client components keep using
 * `getClientStore(mode)` from `@/lib/store`.
 */

import "server-only";
import { readMode } from "@/lib/mode";
import type { Store } from "./index";

export type { Store };

/**
 * Build a Store for the current server-side request. Reads the mode
 * config from disk (cached per request via React's cache()) and
 * dispatches to the Supabase or local-server implementations.
 *
 * Server components should `const store = await getServerStore()` once
 * at the top of their render function.
 */
export async function getServerStore(): Promise<Store> {
  const { mode } = await readMode();
  if (mode === "local") {
    const { buildLocalServerStore } = await import("./local-server");
    return buildLocalServerStore();
  }
  const { buildSupabaseServerStore } = await import("./supabase-server");
  return buildSupabaseServerStore();
}
