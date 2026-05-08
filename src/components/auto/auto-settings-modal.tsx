"use client";

/**
 * AutoSettingsModal
 *
 * Connection + chart-display settings for the auto-trading page. This is
 * the slimmed-down sibling of /trade's DbManagerModal — same WS / Supabase
 * mode toggle and Discover / Reconnect plumbing, but stripped of the
 * discretionary-only sections (Trade Timer, Show Preview SL/TP) that
 * have no meaning when an engine is doing the trading.
 *
 * Sections:
 *   - Connection (mode toggle, WS URL with Discover + Reconnect, status pill)
 *   - Chart Settings (just the show-trades-on-chart toggle)
 *   - Clean Bar Data (kept — useful when the bar feed gets corrupted)
 */

import { useState } from "react";
import { cleanLiveData } from "@/app/trade/actions";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";

/** Race a list of ws:// URLs — return the first one whose handshake completes
 *  within timeoutMs, or null if none do. Same impl as DbManagerModal — kept
 *  inline so /auto isn't dependent on /trade's modal file. */
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
      ws.onerror = () => { /* noop */ };
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

interface AutoSettingsModalProps {
  open: boolean;
  onClose: () => void;
  instrument: string;
  onDataCleaned: () => void;
  showTrades: boolean;
  onToggleShowTrades: (value: boolean) => void;
  connectionMode: "supabase" | "websocket";
  onConnectionModeChange: (mode: "supabase" | "websocket") => void;
  wsUrl: string;
  onWsUrlChange: (url: string) => void;
  wsConnected: boolean;
  onReconnect: () => void;
}

export default function AutoSettingsModal({
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
}: AutoSettingsModalProps) {
  const mode = useMode();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [discoverState, setDiscoverState] = useState<"idle" | "scanning" | "error">("idle");
  const [discoverMsg, setDiscoverMsg] = useState("");

  async function handleDiscover() {
    setDiscoverState("scanning");
    setDiscoverMsg("");
    try {
      // Same pattern as DbManagerModal — read the published candidates
      // through the Store layer so cloud and local modes share the flow.
      const store = getClientStore(mode);
      const row = await store.livebridgeEndpoint.fetch();
      const supaCandidates: string[] = Array.isArray(row?.candidates)
        ? (row?.candidates as unknown as string[])
        : [];
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
      onWsUrlChange(winner);
      setDiscoverState("idle");
    } catch (e) {
      setDiscoverState("error");
      setDiscoverMsg("Discover failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!open) return null;

  async function handleCleanData() {
    setLoading(true);
    setStatus("idle");
    setErrorMsg("");
    const result = await cleanLiveData(instrument, "15 Second");
    if (result.error) {
      setStatus("error");
      setErrorMsg(result.error);
    } else {
      setStatus("success");
      onDataCleaned();
    }
    setLoading(false);
  }

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
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-foreground">Auto Settings</h3>
          <button
            onClick={handleClose}
            className="text-muted hover:text-foreground text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Connection */}
        <div className="border border-card-border rounded-lg p-4 mb-4">
          <h4 className="text-sm font-semibold text-foreground mb-3">Connection</h4>
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
          {connectionMode === "websocket" && (
            <div>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={wsUrl}
                  onChange={(e) => onWsUrlChange(e.target.value)}
                  placeholder="ws://10.211.55.3:8765"
                  className="flex-1 bg-background border border-card-border rounded px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:border-muted"
                />
                <button
                  onClick={handleDiscover}
                  disabled={discoverState === "scanning"}
                  className="px-3 py-1.5 rounded text-xs font-medium border border-card-border text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {discoverState === "scanning" ? "Scanning…" : "Discover"}
                </button>
                <button
                  onClick={onReconnect}
                  className="px-3 py-1.5 rounded text-xs font-medium border border-card-border text-foreground hover:border-foreground/30 transition-colors"
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
          <h4 className="text-sm font-semibold text-foreground mb-3">Chart</h4>
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
        </div>

        {/* Clean Bar Data */}
        <div className="border border-card-border rounded-lg p-4">
          <h4 className="text-sm font-semibold text-foreground mb-1">Clean Bar Data</h4>
          <p className="text-xs text-muted-foreground mb-4">
            Deletes all live bars from the database and requests NinjaTrader to
            resend the last 200 historical bars. Use when chart data looks
            corrupted or out of sync.
          </p>
          <button
            onClick={handleCleanData}
            disabled={loading}
            className="w-full py-2 px-4 rounded text-sm font-medium bg-accent-red/20 text-accent-red border border-accent-red/30 hover:bg-accent-red/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Cleaning..." : "Clean Data"}
          </button>
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
