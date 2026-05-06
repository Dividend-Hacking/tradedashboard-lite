/**
 * Supabase Browser Client
 *
 * Creates a Supabase client for use in browser/client components.
 * Uses createBrowserClient from @supabase/ssr which automatically
 * handles cookie-based auth session management in the browser.
 *
 * Usage: import { createClient } from '@/lib/supabase/client' in any
 * client component ('use client'), then call createClient() to get
 * a ready-to-use Supabase instance.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
