"use client";

/**
 * ModeProvider — broadcasts the active Cloud/Local mode through React
 * context so client components don't have to thread it manually.
 *
 * Server-injected: the root layout reads the mode from
 * ~/.tradedashboard/config.json and passes it as a prop. Mode changes
 * mid-session are picked up via revalidatePath on the next navigation
 * and don't hot-flip the running tabs (we'd otherwise need to detach
 * every realtime subscription, etc.).
 *
 * Hook: `const mode = useMode()` returns the current mode literal
 * ("cloud" | "local"). Use this to call `getClientStore(mode)` from
 * the store factory, or to render mode-conditional UI.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { Mode } from "@/lib/store";

const ModeContext = createContext<Mode>("cloud");

export function ModeProvider({
  mode,
  children,
}: {
  mode: Mode;
  children: ReactNode;
}) {
  // Mirror onto a window-level global so non-React utility modules
  // (backtest-presets, backtest-dashboard-sync, trader-preferences)
  // can read the active mode without converting to hooks. Updates if
  // the layout re-renders with a different mode (rare — usually
  // requires a navigation, which re-mounts the provider).
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __tradeDashMode?: Mode }).__tradeDashMode = mode;
  }, [mode]);

  return <ModeContext.Provider value={mode}>{children}</ModeContext.Provider>;
}

/** Returns the active mode from the closest ModeProvider. Defaults to
 *  "cloud" if no provider is mounted (preserves legacy behavior in
 *  isolated component trees). */
export function useMode(): Mode {
  return useContext(ModeContext);
}
