/**
 * Supabase Server Client
 *
 * Creates a Supabase client for use in server components, server actions,
 * and route handlers within the Next.js App Router. Uses createServerClient
 * from @supabase/ssr with cookie handling via next/headers.
 *
 * The cookie configuration bridges Supabase's auth session management
 * with Next.js server-side cookie access, allowing authenticated
 * requests from server contexts.
 *
 * Usage: import { createClient } from '@/lib/supabase/server' in any
 * server component or route handler, then `const supabase = await createClient()`.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  // Await the cookies() call — required in Next.js 15+ App Router
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // Retrieve all cookies for Supabase session hydration
        getAll() {
          return cookieStore.getAll();
        },
        // Set cookies returned by Supabase (e.g. refreshed auth tokens).
        // Wrapped in try/catch because setCookie can throw in Server Components
        // (read-only context) — it only works in Server Actions / Route Handlers.
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Safe to ignore in Server Components where cookies are read-only.
            // Auth session refresh will be handled by middleware or the next
            // mutable server context (Server Action / Route Handler).
          }
        },
      },
    }
  );
}
