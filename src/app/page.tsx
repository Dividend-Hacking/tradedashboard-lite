/**
 * Home Page (Server Component)
 *
 * Fetches trades and replay session metadata on the server and passes them
 * to the client-side TabSwitcher, which renders either the Trades dashboard
 * or the Backtesting dashboard based on the active tab.
 */

import { createClient } from "@/lib/supabase/server";
import { TabSwitcher } from "@/components/tab-switcher";
import { Trade } from "@/types/trade";
import { ReplaySession } from "@/types/replay";

// Supabase caps a single PostgREST response at 1000 rows by default. Once the
// dataset grows past that ceiling a single select() silently truncates, so we
// page through with .range() in fixed-size chunks until we've seen every row.
const PAGE_SIZE = 1000;

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function fetchAllRows<T>(
  supabase: SupabaseClient,
  table: string,
  orderColumn: string,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  const rows: T[] = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderColumn, { ascending: true })
      .range(from, to);

    if (error) {
      return { data: null, error };
    }

    const batch = (data as T[]) ?? [];
    rows.push(...batch);

    if (batch.length < PAGE_SIZE) {
      return { data: rows, error: null };
    }

    from += PAGE_SIZE;
  }
}

export default async function Home() {
  const supabase = await createClient();

  const [tradesResult, replaySessionsResult] = await Promise.all([
    fetchAllRows<Trade>(supabase, "trades", "entry_time"),
    supabase
      .from("replay_sessions")
      .select("*")
      .order("session_date", { ascending: false }),
  ]);

  if (tradesResult.error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-accent-red">
          Failed to load trades: {tradesResult.error.message}
        </p>
      </div>
    );
  }

  // replay_sessions failure is non-fatal — the Backtesting tab just shows an
  // empty day picker if the fetch errored.
  return (
    <TabSwitcher
      trades={(tradesResult.data as Trade[]) ?? []}
      replaySessions={(replaySessionsResult.data as ReplaySession[]) ?? []}
    />
  );
}
