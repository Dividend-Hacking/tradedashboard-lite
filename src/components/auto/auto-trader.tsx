"use client";

/**
 * AutoTrader — Page-level orchestrator for the automated trading workflow.
 *
 * This is the auto-trading-optimized sibling of LiveTrader. It shares the
 * same NinjaTrader integration (Supabase Realtime + WS + order_requests
 * fallback) but strips every discretionary affordance:
 *
 *   ✗ Manual buy/sell/close buttons
 *   ✗ B / S / X / A keyboard shortcuts
 *   ✗ Trade timer lockout (engine has its own daily-halt logic)
 *   ✗ Preview SL/TP lines
 *   ✗ Tagger panel (manual grade/notes)
 *   ✗ Drawing tools / chart annotations
 *   ✗ Indicator panel (the strategy's filters do the analysis)
 *   ✓ Big preset deploy/disarm command center
 *   ✓ Daily P&L visualization with progress vs preset's daily SL/TP limits
 *   ✓ Active position panel — peak P&L, BE status, qty, age
 *   ✓ Today's auto-trade history with running stats
 *   ✓ Full-height activity log
 *   ✓ EMERGENCY STOP — closes any open position AND disarms in one click
 *   ✓ Engine health (last bar age, last decision time, NT8 connection)
 *
 * The chart is reused from LiveChart for parity with the discretionary
 * page (NT8 candle stream + bracket lines + trade markers). Manual SL/TP
 * dragging is intentionally disabled — the engine owns risk management.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import { LiveBar, LiveState } from "@/types/live";
import { Trade } from "@/types/trade";
import { submitOrder } from "@/app/trade/actions";
import { getInstrumentNames } from "@/lib/utils/futures";
import { saveTraderPreferencesDebounced, type TraderPreferences } from "@/lib/trader-preferences";
import LiveChart from "@/components/trade/live-chart";
import { useAutoTrader } from "@/hooks/use-auto-trader";
import AutoCommandCenter from "./auto-command-center";
import AutoStatusBar from "./auto-status-bar";
import AutoActivityLog from "./auto-activity-log";
import AutoSettingsModal from "./auto-settings-modal";

interface AutoTraderProps {
  initialBars: LiveBar[];
  initialStates: LiveState[];
  initialPrice: number | null;
  instrument: string;
  accounts: string[];
  initialTrades: Trade[];
  initialPreferences: TraderPreferences | null;
}

export default function AutoTrader({
  initialBars,
  initialStates,
  initialPrice,
  instrument,
  accounts,
  initialTrades,
  initialPreferences,
}: AutoTraderProps) {
  const mode = useMode();

  // ─── Market data state ─────────────────────────────────────────────
  const [bars, setBars] = useState<LiveBar[]>(initialBars);
  const [allStates, setAllStates] = useState<LiveState[]>(initialStates);
  const [lastPrice, setLastPrice] = useState<number | null>(initialPrice);
  const [trades, setTrades] = useState<Trade[]>(initialTrades);
  const [connected, setConnected] = useState(false);
  const [showTrades, setShowTrades] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Account selection — same persistence shape /trade uses, but no quantity /
  // SL / TP fields since the engine sources those from the deployed preset.
  const [selectedAccount, setSelectedAccount] = useState<string>(() => {
    const persisted = initialPreferences?.selected_account;
    if (persisted && accounts.includes(persisted)) return persisted;
    return accounts[0] ?? "";
  });

  // ─── Connection setup (mirrors live-trader.tsx) ────────────────────
  // We deliberately reuse the same WS + Supabase Realtime patterns so any
  // NT8 LiveBridge tweaks (heartbeat, auth, reconnect) only have to ship
  // once. Differences: no keyboard handler, no preview lines, no manual
  // order shortcut path.
  const [connectionMode, setConnectionMode] = useState<"supabase" | "websocket">("websocket");
  const [wsUrl, setWsUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem("liveTrader.wsUrl");
      if (stored) return stored;
    }
    return process.env.NEXT_PUBLIC_LIVEBRIDGE_WS_URL ?? "ws://10.211.55.3:8765";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("liveTrader.wsUrl", wsUrl);
    }
  }, [wsUrl]);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const handleReconnect = () => setReconnectNonce((n) => n + 1);

  // ─── Instrument / timeframe (canonical vs label split, like live-trader) ──
  const [activeInstrument, setActiveInstrument] = useState(instrument);
  const VALID_TIMEFRAMES = ["15 Second", "1 Minute", "5 Minute", "15 Minute"];
  const [activeTimeframe, setActiveTimeframe] = useState<string>(() => {
    const persisted = initialPreferences?.timeframe;
    if (persisted && VALID_TIMEFRAMES.includes(persisted)) return persisted;
    return "15 Second";
  });
  const [isSwitching, setIsSwitching] = useState(false);
  const INSTRUMENTS = getInstrumentNames();
  const [selectedLabel, setSelectedLabel] = useState<string>(() => {
    const persisted = initialPreferences?.instrument_label;
    if (persisted && INSTRUMENTS.includes(persisted)) return persisted;
    if (INSTRUMENTS.includes(instrument)) return instrument;
    const root = instrument.split(" ")[0];
    return INSTRUMENTS.find((inst) => inst.startsWith(root + " ")) ?? INSTRUMENTS[0];
  });

  const labelForCanonical = useCallback(
    (canonical: string): string | null => {
      if (INSTRUMENTS.includes(canonical)) return canonical;
      const root = canonical.split(" ")[0];
      return INSTRUMENTS.find((inst) => inst.startsWith(root + " ")) ?? null;
    },
    [INSTRUMENTS]
  );

  const TIMEFRAMES = [
    { value: "15 Second", label: "15s" },
    { value: "1 Minute", label: "1m" },
    { value: "5 Minute", label: "5m" },
    { value: "15 Minute", label: "15m" },
  ];

  // ─── Shared price refs for zero-latency chart updates ──────────────
  const tickPriceRef = useRef<number | null>(null);
  const headerPriceRef = useRef<HTMLSpanElement>(null);
  const lastStateSyncRef = useRef<number>(0);

  // Live state for the selected account (for the engine + position panel).
  const liveState = allStates.find((s) => s.account === selectedAccount) ?? null;
  const liveStateRef = useRef(liveState);
  liveStateRef.current = liveState;

  // ─── Refs for WS message validation ──────────────────────────────
  const activeInstrumentRef = useRef(activeInstrument);
  activeInstrumentRef.current = activeInstrument;
  const isSwitchingRef = useRef(false);

  // ─── Engine health metrics ─────────────────────────────────────────
  // Last bar arrival time and last decision time, surfaced in AutoStatusBar
  // so the user can see at a glance whether the bar feed has stalled
  // (e.g. NT8 froze) or whether the engine has actually been evaluating.
  const [lastBarAt, setLastBarAt] = useState<number | null>(null);
  useEffect(() => {
    if (bars.length === 0) return;
    setLastBarAt(Date.now());
  }, [bars.length, bars.at(-1)?.bar_time]);

  // ─── Refetch bars/state/trades when activeInstrument changes ──────
  // Same flow as /trade — uses the active backend's Store, so cloud
  // pulls Supabase rows and local pulls the SQLite rows.
  useEffect(() => {
    if (activeInstrument === instrument) return;
    const store = getClientStore(mode);
    let cancelled = false;
    (async () => {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const [bars, states, trades] = await Promise.all([
        store.live.listBarsForInstrument(activeInstrument, "15 Second", 1000),
        store.live.listStatesForInstrument(activeInstrument),
        store.trades.listForInstrumentSinceUtc(activeInstrument, todayStart.toISOString()),
      ]);
      if (cancelled) return;
      setBars(bars);
      setAllStates(states);
      setTrades(trades);
    })();
    return () => { cancelled = true; };
  }, [activeInstrument, instrument, mode]);

  // ─── Realtime (when in supabase mode) ─────────────────────────────
  // Cloud → Supabase Realtime postgres_changes, local → 1.5s polling.
  useEffect(() => {
    if (connectionMode === "websocket") return;
    const store = getClientStore(mode);
    const unsubBars = store.live.subscribeBars(activeInstrument, "15 Second", (bar) => {
      setBars((prev) => {
        const idx = prev.findIndex((b) => b.bar_time === bar.bar_time);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = bar;
          return updated;
        }
        return [...prev, bar];
      });
    });
    const unsubTicker = store.live.subscribeTicker(activeInstrument, (ticker) => {
      setLastPrice(ticker.last_price);
    });
    const unsubStates = store.live.subscribeStates(activeInstrument, (updated) => {
      setAllStates((prev) => {
        const idx = prev.findIndex(
          (s) => s.instrument === updated.instrument && s.account === updated.account
        );
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = updated;
          return copy;
        }
        return [...prev, updated];
      });
    });
    setConnected(true);
    return () => {
      unsubBars();
      unsubTicker();
      unsubStates();
      setConnected(false);
    };
  }, [activeInstrument, connectionMode, mode]);

  // Trades realtime (runs in both connection modes, same as live-trader.tsx)
  useEffect(() => {
    const store = getClientStore(mode);
    return store.trades.subscribeForInstrument(activeInstrument, (trade) => {
      setTrades((prev) => {
        const idx = prev.findIndex((t) => t.id === trade.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = trade;
          return updated;
        }
        return [...prev, trade];
      });
    });
  }, [activeInstrument, mode]);

  // ─── WebSocket connection (when in websocket mode) ────────────────
  useEffect(() => {
    if (connectionMode !== "websocket") {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        setWsConnected(false);
      }
      return;
    }
    let alive = true;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!alive) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelay = 1000;
        lastTickTime.current = Date.now();
        setWsConnected(true);
        setConnected(true);
      };
      ws.onclose = () => {
        setWsConnected(false);
        setConnected(false);
        wsRef.current = null;
        tickPriceRef.current = null;
        if (alive) {
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        }
      };
      ws.onerror = () => {
        setWsConnected(false);
        setConnected(false);
      };

      ws.onmessage = (event) => {
        const data = event.data as string;
        lastTickTime.current = Date.now();

        // Fast tick path — same shortcut /trade uses, parses just the price
        // out of "{"type":"tick","last_price":XXXXX.XX}".
        if (data.charCodeAt(9) === 116 /* 't' in tick */) {
          if (isSwitchingRef.current) return;
          const price = parseFloat(data.slice(28, -1));
          tickPriceRef.current = price;
          if (headerPriceRef.current) headerPriceRef.current.textContent = price.toFixed(2);
          const now = Date.now();
          if (now - lastStateSyncRef.current > 250) {
            lastStateSyncRef.current = now;
            setLastPrice(price);
          }
          return;
        }

        try {
          const msg = JSON.parse(data);
          switch (msg.type) {
            case "bar":
              if (isSwitchingRef.current) break;
              if (msg.instrument && msg.instrument !== activeInstrumentRef.current) break;
              setBars((prev) => {
                const idx = prev.findIndex((b) => b.bar_time === msg.bar_time);
                if (idx >= 0) {
                  const updated = [...prev];
                  updated[idx] = { ...updated[idx], ...msg };
                  return updated;
                }
                return [...prev, {
                  id: 0,
                  instrument: msg.instrument,
                  timeframe: msg.timeframe,
                  bar_time: msg.bar_time,
                  bar_open: msg.bar_open,
                  bar_high: msg.bar_high,
                  bar_low: msg.bar_low,
                  bar_close: msg.bar_close,
                  bar_volume: msg.bar_volume,
                  created_at: new Date().toISOString(),
                } as LiveBar];
              });
              break;
            case "state":
              if (isSwitchingRef.current) break;
              if (msg.instrument && msg.instrument !== activeInstrumentRef.current) break;
              setAllStates((prev) => {
                const updated: LiveState = {
                  instrument: msg.instrument,
                  account: msg.account,
                  position_direction: msg.position_direction,
                  position_quantity: msg.position_quantity,
                  position_entry_price: msg.position_entry_price,
                  unrealized_pnl: msg.unrealized_pnl,
                  sl_price: msg.sl_price,
                  tp_price: msg.tp_price,
                  trail_enabled: msg.trail_enabled,
                  original_entry_qty: msg.original_entry_qty ?? undefined,
                  brackets: msg.brackets ?? undefined,
                  updated_at: new Date().toISOString(),
                };
                const idx = prev.findIndex((s) => s.instrument === updated.instrument && s.account === updated.account);
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = updated;
                  return copy;
                }
                return [...prev, updated];
              });
              break;
            case "config":
              if (msg.instrument) {
                setActiveInstrument(msg.instrument);
                const label = labelForCanonical(msg.instrument);
                if (label) setSelectedLabel(label);
              }
              if (msg.timeframe) setActiveTimeframe(msg.timeframe);
              break;
            case "command_update":
              if (msg.command === "switch_instrument") {
                setIsSwitching(false);
                isSwitchingRef.current = false;
                if (msg.status === "completed" && msg.instrument && msg.instrument !== activeInstrumentRef.current) {
                  activeInstrumentRef.current = msg.instrument;
                  setActiveInstrument(msg.instrument);
                }
              }
              break;
          }
        } catch { /* ignore malformed */ }
      };
    };

    connect();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (wsRef.current) wsRef.current.close();
      wsRef.current = null;
      setWsConnected(false);
      setConnected(false);
    };
  }, [connectionMode, wsUrl, reconnectNonce, labelForCanonical]);

  // Stale-connection watchdog — same 3-minute threshold as /trade.
  const STALE_MS = 180000;
  const lastTickTime = useRef(Date.now());
  useEffect(() => { lastTickTime.current = Date.now(); }, [lastPrice]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - lastTickTime.current > STALE_MS) {
        if (connectionMode === "websocket" && wsRef.current) {
          const ws = wsRef.current;
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
            lastTickTime.current = Date.now();
          }
        } else if (connectionMode === "supabase") {
          setConnected(false);
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [connectionMode]);

  // ─── Order dispatch (engine-driven only) ──────────────────────────
  const sendWsOrder = useCallback((order: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "order", ...order }));
    }
  }, []);

  const handleBuyLong = useCallback(
    async (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => {
      if (connectionMode === "websocket") {
        sendWsOrder({ action: "buy_long", account: selectedAccount, sl_points: slPts, tp_points: tpPts, trail_enabled: trail, quantity: qty });
      } else {
        await submitOrder(activeInstrument, selectedAccount, "buy_long", slPts, tpPts, trail, null, null, qty);
      }
    },
    [activeInstrument, selectedAccount, connectionMode, sendWsOrder]
  );
  const handleSellShort = useCallback(
    async (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => {
      if (connectionMode === "websocket") {
        sendWsOrder({ action: "sell_short", account: selectedAccount, sl_points: slPts, tp_points: tpPts, trail_enabled: trail, quantity: qty });
      } else {
        await submitOrder(activeInstrument, selectedAccount, "sell_short", slPts, tpPts, trail, null, null, qty);
      }
    },
    [activeInstrument, selectedAccount, connectionMode, sendWsOrder]
  );
  const handleClose = useCallback(async () => {
    if (connectionMode === "websocket") {
      sendWsOrder({ action: "close", account: selectedAccount });
    } else {
      await submitOrder(activeInstrument, selectedAccount, "close");
    }
  }, [activeInstrument, selectedAccount, connectionMode, sendWsOrder]);
  const handleModifySl = useCallback(async (newPrice: number) => {
    if (connectionMode === "websocket") {
      sendWsOrder({ action: "modify_sl", account: selectedAccount, new_sl_price: newPrice });
    } else {
      await submitOrder(activeInstrument, selectedAccount, "modify_sl", null, null, false, newPrice);
    }
  }, [activeInstrument, selectedAccount, connectionMode, sendWsOrder]);

  // ─── Auto-trader engine hook ──────────────────────────────────────
  const autoTrader = useAutoTrader({
    bars,
    position: liveState,
    lastPrice,
    tickPriceRef: connectionMode === "websocket" ? tickPriceRef : undefined,
    onBuyLong: handleBuyLong,
    onSellShort: handleSellShort,
    onClose: handleClose,
    onModifySl: handleModifySl,
  });

  // EMERGENCY STOP — close any open position THEN disarm. Used as the
  // big red kill switch on the panel. Order matters: close first so the
  // engine still treats the close as observed and updates its counters,
  // then disarm so no new entries fire on the next bar.
  const handleEmergencyStop = useCallback(async () => {
    if (liveStateRef.current?.position_direction != null) {
      await handleClose();
    }
    autoTrader.disarm();
  }, [handleClose, autoTrader]);

  // ─── Instrument / timeframe switch ────────────────────────────────
  const handleSwitchConfig = useCallback((newInstrumentLabel: string, newTimeframe: string) => {
    // Refuse switching while armed — auto trading on a different instrument
    // mid-session is a foot-gun. Force a deliberate disarm first.
    if (autoTrader.state.armed) {
      alert("Disarm the auto trader before switching instruments or timeframes.");
      return;
    }
    if (liveStateRef.current?.position_direction != null) {
      if (!confirm("You have an open position. Switching will leave it on the old instrument. Continue?")) {
        return;
      }
    }
    setBars([]);
    setLastPrice(null);
    tickPriceRef.current = null;
    setTrades([]);
    setIsSwitching(true);
    isSwitchingRef.current = true;
    setSelectedLabel(newInstrumentLabel);
    setActiveTimeframe(newTimeframe);
    saveTraderPreferencesDebounced({ instrument_label: newInstrumentLabel, timeframe: newTimeframe });
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "command",
        command: "switch_instrument",
        instrument: newInstrumentLabel,
        timeframe: newTimeframe,
      }));
    }
  }, [autoTrader.state.armed]);

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Header — instrument / tf / account / connection / settings */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select
            value={selectedLabel}
            onChange={(e) => handleSwitchConfig(e.target.value, activeTimeframe)}
            disabled={isSwitching || autoTrader.state.armed}
            title={autoTrader.state.armed ? "Disarm to change instrument" : undefined}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-sm font-bold text-foreground focus:outline-none focus:border-muted disabled:opacity-50"
          >
            {INSTRUMENTS.map((inst) => <option key={inst} value={inst}>{inst}</option>)}
          </select>
          <select
            value={activeTimeframe}
            onChange={(e) => handleSwitchConfig(selectedLabel, e.target.value)}
            disabled={isSwitching || autoTrader.state.armed}
            title={autoTrader.state.armed ? "Disarm to change timeframe" : undefined}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-sm font-bold text-foreground focus:outline-none focus:border-muted disabled:opacity-50"
          >
            {TIMEFRAMES.map((tf) => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
          </select>
          {isSwitching && <span className="text-xs text-muted animate-pulse">Switching...</span>}
          <span className={`text-xs px-2 py-0.5 rounded ${connected ? "bg-accent-green/20 text-accent-green" : "bg-accent-red/20 text-accent-red"}`}>
            {connected ? "LIVE" : "DISCONNECTED"}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded font-bold ${autoTrader.state.armed ? "bg-accent-green/20 text-accent-green animate-pulse" : "bg-white/5 text-muted-foreground"}`}>
            {autoTrader.state.armed ? "ENGINE ARMED" : "ENGINE DISARMED"}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <select
            value={selectedAccount}
            onChange={(e) => {
              if (autoTrader.state.armed) {
                alert("Disarm before switching account.");
                return;
              }
              setSelectedAccount(e.target.value);
              saveTraderPreferencesDebounced({ selected_account: e.target.value });
            }}
            disabled={autoTrader.state.armed}
            title={autoTrader.state.armed ? "Disarm to change account" : undefined}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-muted disabled:opacity-50"
          >
            {accounts.length === 0 && <option value="">No accounts</option>}
            {accounts.map((acct) => <option key={acct} value={acct}>{acct}</option>)}
          </select>
          <span ref={headerPriceRef} className="text-2xl font-bold font-mono text-foreground">
            {lastPrice?.toFixed(2) ?? "—"}
          </span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-muted hover:text-foreground transition-colors"
            title="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Status bar — engine health + bar age + active position pulse */}
      <AutoStatusBar
        engineState={autoTrader.state}
        livePosition={liveState}
        lastPrice={lastPrice}
        tickPriceRef={connectionMode === "websocket" ? tickPriceRef : undefined}
        lastBarAt={lastBarAt}
        wsConnected={wsConnected}
        connectionMode={connectionMode}
        timeframe={activeTimeframe}
      />

      {/* Main grid: chart on the left, command center + activity log on the right */}
      <div className="flex gap-3 flex-1 min-h-0">
        <div className="flex-1 min-h-[400px]">
          <LiveChart
            bars={bars}
            liveState={liveState}
            lastPrice={lastPrice}
            priceRef={connectionMode === "websocket" ? tickPriceRef : undefined}
            trades={showTrades ? trades : []}
            timeframe={activeTimeframe}
            instrument={activeInstrument}
            // Manual SL/TP drag intentionally disabled for auto trading —
            // the engine owns risk management. Omitting the callbacks tells
            // LiveChart to keep the lines static.
            // No preview SL/TP, no indicator panel — auto-trading doesn't
            // need the chart to do extra discretionary analysis.
            indicatorConfigs={[]}
          />
        </div>

        <div className="w-[380px] shrink-0 flex flex-col gap-3 min-h-0">
          <AutoCommandCenter
            engineState={autoTrader.state}
            onArm={autoTrader.arm}
            onDisarm={autoTrader.disarm}
            onEmergencyStop={handleEmergencyStop}
            livePosition={liveState}
            lastPrice={lastPrice}
            todaysTrades={trades.filter(
              (t) => t.account_name === selectedAccount && t.exit_time != null
            )}
          />
          <AutoActivityLog log={autoTrader.state.log} />
        </div>
      </div>

      {/* Settings (connection mode / WS URL / clean data / show trades) */}
      <AutoSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        instrument={activeInstrument}
        onDataCleaned={() => {
          setBars([]);
          setLastPrice(null);
          tickPriceRef.current = null;
          setTrades([]);
          if (connectionMode === "websocket" && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "command",
              command: "reseed_bars",
              instrument: activeInstrument,
              timeframe: activeTimeframe,
            }));
          }
        }}
        showTrades={showTrades}
        onToggleShowTrades={setShowTrades}
        connectionMode={connectionMode}
        onConnectionModeChange={setConnectionMode}
        wsUrl={wsUrl}
        onWsUrlChange={setWsUrl}
        wsConnected={wsConnected}
        onReconnect={handleReconnect}
      />
    </div>
  );
}
