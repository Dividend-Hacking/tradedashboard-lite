/**
 * DashboardStateRepo — singleton backtest_dashboard_state row.
 *
 * Cross-tab realtime sync for the BacktestDashboard's full input state.
 * One row keyed by id='singleton', holding a jsonb snapshot. Each tab
 * stamps its writes with a clientId; subscribe filters out our own
 * echoes so a write doesn't bounce back into the writer's state.
 */

import type { DashboardSyncState } from "@/lib/utils/backtest-dashboard-sync";

export interface DashboardStateRepo {
  load(): Promise<DashboardSyncState | null>;
  push(state: DashboardSyncState, clientId: string): Promise<void>;
  /** Realtime subscription: invokes onUpdate when ANOTHER client writes.
   *  Returns an unsubscribe function for useEffect cleanup. */
  subscribe(
    clientId: string,
    onUpdate: (state: DashboardSyncState) => void
  ): () => void;
}
