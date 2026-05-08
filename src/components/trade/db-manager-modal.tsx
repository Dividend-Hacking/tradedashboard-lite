"use client";

/**
 * DbManagerModal — Popup for managing live trading database state.
 *
 * Provides a "Clean Data" action that wipes all live_bars and tells NT8
 * to reseed 100 warmup bars via the live_commands table. Useful when data
 * gets corrupted through refreshes, NT8 restarts, or connection issues.
 */

import { useState } from "react";
import { cleanLiveData } from "@/app/trade/actions";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import { TradeTimerSettings } from "@/types/live";

/**
 * Race a list of ws:// URLs — return the first one whose handshake completes
 * within timeoutMs, or null if none do. All sockets (including the winner) are
 * closed before returning so the live-trader's WS effect is the only thing
 * that re-opens the winner under the persisted wsUrl. Used by the Discover
 * button to find a reachable LiveBridge endpoint when the Parallels VM IP
 * has shifted (e.g. after the host laptop changed networks).
 */
function raceWsCandidates(urls: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (urls.length === 0) {
      resolve(null);
      return;
    }
    const sockets = urls.map((u) => {
      try {
        return { url: u, ws: new WebSocket(u) };
      } catch {
        return { url: u, ws: null as WebSocket | null };
      }
    });
    let settled = false;
    const finish = (winner: string | null) => {
      if (settled) return;
      settled = true;
      sockets.forEach(({ ws }) => {
        try { ws?.close(); } catch { /* ignore */ }
      });
      resolve(winner);
    };
    sockets.forEach(({ url, ws }) => {
      if (!ws) return;
      ws.onopen = () => finish(url);
      // Swallow errors — wait for another candidate or the overall timeout.
      ws.onerror = () => { /* noop */ };
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

interface DbManagerModalProps {
  /** Whether the modal is visible */
  open: boolean;
  /** Close the modal */
  onClose: () => void;
  /** Instrument name to clean data for */
  instrument: string;
  /** Callback to clear client-side bar state after successful clean */
  onDataCleaned: () => void;
  /** Whether trade markers/lines are shown on the chart */
  showTrades: boolean;
  /** Toggle trade markers/lines visibility */
  onToggleShowTrades: (value: boolean) => void;
  /** Connection mode: supabase (default) or websocket (low-latency) */
  connectionMode: "supabase" | "websocket";
  /** Change connection mode */
  onConnectionModeChange: (mode: "supabase" | "websocket") => void;
  /** WebSocket URL for direct NT8 connection */
  wsUrl: string;
  /** Change WebSocket URL */
  onWsUrlChange: (url: string) => void;
  /** Whether WebSocket is currently connected */
  wsConnected: boolean;
  /** Force a fresh WebSocket connection — used to recover from stuck/stale
   *  sockets without having to toggle connection mode or refresh the page. */
  onReconnect: () => void;
  /** Trade timer config — enforces post-entry discipline window */
  tradeTimerSettings: TradeTimerSettings;
  /** Update trade timer config (persisted to localStorage by parent) */
  onTradeTimerSettingsChange: (next: TradeTimerSettings) => void;
  /** Whether dashed SL/TP preview lines render on the chart while no
   *  position is open (persisted in trader_preferences by parent). */
  showPreviewSlTp: boolean;
  /** Toggle the preview SL/TP lines on/off. */
  onTogglePreviewSlTp: (value: boolean) => void;
}

export default function DbManagerModal({
  open,
  onClose,
  instrument,
  onDataCleaned,
  showTrades,
  onToggleShowTrades,
  connectionMode,
  onConnectionModeChange,
  wsUrl,
  onWsUrlChange,
  wsConnected,
  onReconnect,
  tradeTimerSettings,
  onTradeTimerSettingsChange,
  showPreviewSlTp,
  onTogglePreviewSlTp,
}: DbManagerModalProps) {
  const mode = useMode();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Discover state — drives the "Discover" button next to the WS URL input.
  // NT8's LiveBridge publishes its bound IPv4 candidates to the
  // livebridge_endpoint Supabase row on startup; clicking Discover fetches
  // that row and probes each candidate to find a reachable URL.
  const [discoverState, setDiscoverState] = useState<"idle" | "scanning" | "error">("idle");
  const [discoverMsg, setDiscoverMsg] = useState("");

  /** Fetch published candidates from the active backend, race WS probes,
   *  set winner. NT8's LiveBridge publishes its bound IPv4 candidates to
   *  the livebridge_endpoint singleton row on startup; we read that row
   *  through the Store layer so the same flow works in cloud and local
   *  modes. The local-mode shape is identical because LiveBridge POSTs
   *  to /api/nt8/livebridge_endpoint with the same JSON it sends Supabase. */
  async function handleDiscover() {
    setDiscoverState("scanning");
    setDiscoverMsg("");
    try {
      const store = getClientStore(mode);
      const row = await store.livebridgeEndpoint.fetch();
      const supaCandidates: string[] = Array.isArray(row?.candidates)
        ? (row?.candidates as unknown as string[])
        : [];
      // When loaded from localhost (dev), prepend the local ws-proxy URL
      // (scripts/ws-proxy.mjs, started via `npm run ws-proxy`). The proxy
      // sidesteps browser private-network / extension blocks that prevent
      // direct ws://10.x.x.x connections — verified TCP+WS reachable from
      // the terminal but blocked from Chrome. If the proxy isn't running
      // the race falls through to the published Supabase candidates.
      const isLocalDev = typeof window !== "undefined" && window.location.hostname === "localhost";
      const candidates = isLocalDev ? ["ws://localhost:8766", ...supaCandidates] : supaCandidates;
      if (candidates.length === 0) {
        setDiscoverState("error");
        setDiscoverMsg("No endpoint published — is NT8's LiveBridge running?");
        return;
      }
      const winner = await raceWsCandidates(candidates, 3000);
      if (!winner) {
        setDiscoverState("error");
        setDiscoverMsg("Published candidates not reachable from this browser.");
        return;
      }
      // Hand off to the parent — live-trader's effect will reopen the WS
      // under the new URL via its [wsUrl] dependency, and the localStorage
      // persistence added earlier will keep it across reloads.
      onWsUrlChange(winner);
      setDiscoverState("idle");
    } catch (e) {
      setDiscoverState("error");
      setDiscoverMsg("Discover failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!open) return null;

  /** Wipe all live bars and request NT8 to reseed historical data */
  async function handleCleanData() {
    setLoading(true);
    setStatus("idle");
    setErrorMsg("");

    // Live trader currently only consumes 15-second bars; pin the
    // timeframe so the new repo signature is satisfied and behavior
    // matches the legacy "delete all bars for this instrument" call.
    const result = await cleanLiveData(instrument, "15 Second");

    if (result.error) {
      setStatus("error");
      setErrorMsg(result.error);
    } else {
      setStatus("success");
      // Clear client-side bars so chart resets
      onDataCleaned();
    }

    setLoading(false);
  }

  /** Reset status and close */
  function handleClose() {
    setStatus("idle");
    setErrorMsg("");
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleClose}
    >
      <div
        className="bg-card border border-card-border rounded-lg p-6 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-foreground">DB Manager</h3>
          <button
            onClick={handleClose}
            className="text-muted hover:text-foreground text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Connection Mode */}
        <div className="border border-card-border rounded-lg p-4 mb-4">
          <h4 className="text-sm font-semibold text-foreground mb-3">
            Connection
          </h4>
          {/* Mode toggle */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => onConnectionModeChange("supabase")}
              className={`flex-1 py-1.5 px-3 rounded text-xs font-medium transition-colors ${
                connectionMode === "supabase"
                  ? "bg-foreground/10 text-foreground border border-foreground/20"
                  : "text-muted-foreground border border-card-border hover:border-foreground/20"
              }`}
            >
              Supabase
            </button>
            <button
              onClick={() => onConnectionModeChange("websocket")}
              className={`flex-1 py-1.5 px-3 rounded text-xs font-medium transition-colors ${
                connectionMode === "websocket"
                  ? "bg-foreground/10 text-foreground border border-foreground/20"
                  : "text-muted-foreground border border-card-border hover:border-foreground/20"
              }`}
            >
              WebSocket
            </button>
          </div>
          {/* WebSocket URL input + Discover button + status (only when WS mode) */}
          {connectionMode === "websocket" && (
            <div>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={wsUrl}
                  onChange={(e) => onWsUrlChange(e.target.value)}
                  placeholder="ws://10.211.55.3:8765"
                  className="flex-1 bg-background border border-card-border rounded px-2 py-1.5
                             text-xs text-foreground font-mono focus:outline-none focus:border-muted"
                />
                {/* Discover: fetches candidates from Supabase (published by NT8's
                    LiveBridge on startup) and races WS probes to pick a reachable URL.
                    Use this when the Parallels VM IP changes (host network switch). */}
                <button
                  onClick={handleDiscover}
                  disabled={discoverState === "scanning"}
                  className="px-3 py-1.5 rounded text-xs font-medium border border-card-border
                             text-foreground hover:border-foreground/30 disabled:opacity-50
                             disabled:cursor-not-allowed transition-colors"
                >
                  {discoverState === "scanning" ? "Scanning…" : "Discover"}
                </button>
                {/* Manual reconnect: bumps a nonce in the parent that forces
                    the WS effect to tear down the current socket (cancelling
                    any pending backoff retry) and reconnect fresh. Helpful
                    when the socket has silently gone stale. */}
                <button
                  onClick={onReconnect}
                  className="px-3 py-1.5 rounded text-xs font-medium border border-card-border
                             text-foreground hover:border-foreground/30 transition-colors"
                >
                  Reconnect
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-accent-green" : "bg-accent-red"}`} />
                <span className="text-xs text-muted-foreground">
                  {wsConnected ? "Connected" : "Disconnected"}
                </span>
              </div>
              {discoverState === "error" && discoverMsg && (
                <p className="text-xs text-accent-red mt-2">{discoverMsg}</p>
              )}
            </div>
          )}
          {connectionMode === "supabase" && (
            <p className="text-xs text-muted-foreground">
              Using Supabase Realtime for data streaming and order polling.
            </p>
          )}
        </div>

        {/* Chart Settings */}
        <div className="border border-card-border rounded-lg p-4 mb-4">
          <h4 className="text-sm font-semibold text-foreground mb-3">
            Chart Settings
          </h4>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs text-muted-foreground">Show trades on chart</span>
            <button
              onClick={() => onToggleShowTrades(!showTrades)}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                showTrades ? "bg-accent-green" : "bg-card-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-foreground transition-transform ${
                  showTrades ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>
          {/* Preview SL/TP lines toggle — when on, the chart renders dashed
              red/green lines at ±slPoints / ±tpPoints from the current price
              for both a hypothetical Long and Short entry. They only render
              while no position is open, so they don't compete with the real
              SL/TP lines of an active trade. */}
          <label className="flex items-center justify-between cursor-pointer mt-3">
            <span className="text-xs text-muted-foreground">Show preview SL/TP lines</span>
            <button
              onClick={() => onTogglePreviewSlTp(!showPreviewSlTp)}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                showPreviewSlTp ? "bg-accent-green" : "bg-card-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-foreground transition-transform ${
                  showPreviewSlTp ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>
        </div>

        {/* Trade Timer Settings */}
        <div className="border border-card-border rounded-lg p-4 mb-4">
          <h4 className="text-sm font-semibold text-foreground mb-1">
            Trade Timer
          </h4>
          <p className="text-xs text-muted-foreground mb-4">
            Starts a countdown when you place a trade. Optionally force-closes
            the position at zero and locks new entries until the timer expires
            — even if the trade was closed early.
          </p>

          {/* Master enable toggle */}
          <label className="flex items-center justify-between cursor-pointer mb-3">
            <span className="text-xs text-muted-foreground">Enable trade timer</span>
            <button
              onClick={() =>
                onTradeTimerSettingsChange({
                  ...tradeTimerSettings,
                  enabled: !tradeTimerSettings.enabled,
                })
              }
              className={`relative w-9 h-5 rounded-full transition-colors ${
                tradeTimerSettings.enabled ? "bg-accent-green" : "bg-card-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-foreground transition-transform ${
                  tradeTimerSettings.enabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>

          {/* Duration input — accepts seconds as a positive integer */}
          <label className="block mb-3">
            <span className="text-xs text-muted-foreground block mb-1">
              Duration (seconds)
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={tradeTimerSettings.durationSec}
              disabled={!tradeTimerSettings.enabled}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                // Reject NaN and non-positive values — leave settings unchanged.
                if (!Number.isFinite(parsed) || parsed < 1) return;
                onTradeTimerSettingsChange({
                  ...tradeTimerSettings,
                  durationSec: parsed,
                });
              }}
              className="w-full bg-background border border-card-border rounded px-2 py-1.5
                         text-sm font-mono text-foreground disabled:opacity-40
                         focus:outline-none focus:border-muted"
            />
          </label>

          {/* Auto-close at 0 toggle */}
          <label className="flex items-center justify-between cursor-pointer mb-3">
            <span className="text-xs text-muted-foreground">Auto-close at 0</span>
            <button
              disabled={!tradeTimerSettings.enabled}
              onClick={() =>
                onTradeTimerSettingsChange({
                  ...tradeTimerSettings,
                  autoCloseOnZero: !tradeTimerSettings.autoCloseOnZero,
                })
              }
              className={`relative w-9 h-5 rounded-full transition-colors disabled:opacity-40 ${
                tradeTimerSettings.autoCloseOnZero ? "bg-accent-green" : "bg-card-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-foreground transition-transform ${
                  tradeTimerSettings.autoCloseOnZero ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>

          {/* Lockout toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs text-muted-foreground">Lock new trades until 0</span>
            <button
              disabled={!tradeTimerSettings.enabled}
              onClick={() =>
                onTradeTimerSettingsChange({
                  ...tradeTimerSettings,
                  lockoutUntilZero: !tradeTimerSettings.lockoutUntilZero,
                })
              }
              className={`relative w-9 h-5 rounded-full transition-colors disabled:opacity-40 ${
                tradeTimerSettings.lockoutUntilZero ? "bg-accent-green" : "bg-card-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-foreground transition-transform ${
                  tradeTimerSettings.lockoutUntilZero ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>
        </div>

        {/* Clean Data Section */}
        <div className="border border-card-border rounded-lg p-4">
          <h4 className="text-sm font-semibold text-foreground mb-1">
            Clean Bar Data
          </h4>
          <p className="text-xs text-muted-foreground mb-4">
            Deletes all live bars from the database and requests NinjaTrader
            to resend the last 200 historical bars. Use this when chart data
            looks corrupted or out of sync.
          </p>

          <button
            onClick={handleCleanData}
            disabled={loading}
            className="w-full py-2 px-4 rounded text-sm font-medium
                       bg-accent-red/20 text-accent-red border border-accent-red/30
                       hover:bg-accent-red/30 disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {loading ? "Cleaning..." : "Clean Data"}
          </button>

          {/* Status feedback */}
          {status === "success" && (
            <p className="text-xs text-accent-green mt-3">
              Data cleared — NT8 will reseed bars shortly.
            </p>
          )}
          {status === "error" && (
            <p className="text-xs text-accent-red mt-3">{errorMsg}</p>
          )}
        </div>
      </div>
    </div>
  );
}
