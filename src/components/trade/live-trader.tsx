"use client";

/**
 * LiveTrader — Main orchestrator for the live trading experience.
 *
 * Subscribes to Supabase Realtime for live bars, ticks, position state,
 * and order updates. Renders the chart + trade panel, handles keyboard
 * shortcuts for fast entry/exit.
 *
 * Modeled after replay-viewer.tsx but driven by real-time data instead
 * of a replay engine.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import { LiveBar, LiveState, TradeTimerSettings } from "@/types/live";
import { Trade } from "@/types/trade";
import { submitOrder } from "@/app/trade/actions";
import { getInstrumentNames } from "@/lib/utils/futures";
import {
  saveTraderPreferencesDebounced,
  type TraderPreferences,
} from "@/lib/trader-preferences";
import LiveChart from "./live-chart";
import LiveTradePanel from "./live-trade-panel";
import LiveTaggerPanel from "./live-tagger-panel";
import AutoTraderPanel from "./auto-trader-panel";
import DbManagerModal from "./db-manager-modal";
import type { IndicatorConfig } from "@/types/indicators";
import { useAutoTrader } from "@/hooks/use-auto-trader";

interface LiveTraderProps {
  initialBars: LiveBar[];
  initialStates: LiveState[];
  initialPrice: number | null;
  instrument: string;
  accounts: string[];
  initialTrades: Trade[];
  /** Persisted user preferences (TP/SL/asset/timeframe/account) loaded
   *  server-side from the trader_preferences table. Null when the row
   *  doesn't exist yet — callers fall back to hardcoded defaults. */
  initialPreferences: TraderPreferences | null;
}

export default function LiveTrader({
  initialBars,
  initialStates,
  initialPrice,
  instrument,
  accounts,
  initialTrades,
  initialPreferences,
}: LiveTraderProps) {
  const mode = useMode();
  const [bars, setBars] = useState<LiveBar[]>(initialBars);
  const [allStates, setAllStates] = useState<LiveState[]>(initialStates);
  const [lastPrice, setLastPrice] = useState<number | null>(initialPrice);
  const [connected, setConnected] = useState(false);
  // Prefer the persisted account when it's still valid (still appears in
  // the accounts list); otherwise fall back to the first available account.
  const [selectedAccount, setSelectedAccount] = useState<string>(() => {
    const persisted = initialPreferences?.selected_account;
    if (persisted && accounts.includes(persisted)) return persisted;
    return accounts[0] ?? "";
  });
  const [dbModalOpen, setDbModalOpen] = useState(false);
  const [trades, setTrades] = useState<Trade[]>(initialTrades);
  const [showTrades, setShowTrades] = useState(true);
  // Right sidebar tab: "trade" = order-entry panel, "tagger" = grade/notes
  // panel for the currently selected trade, "auto" = auto-trader panel
  // (deploy a backtest preset to drive automated entries). Kept in session
  // memory — defaults to "trade" each page load since order entry is the
  // primary workflow.
  const [rightPanelTab, setRightPanelTab] = useState<"trade" | "tagger" | "auto">("trade");
  // ─── Preview SL/TP lines toggle ───────────────────────────────────
  // When true, LiveChart renders dashed SL/TP preview lines (one pair for
  // Long entry, one pair for Short) while no position is open, so the
  // trader can see where their stop/target will land before clicking.
  // Seeded from persisted preferences; null/undefined → disabled by default.
  const [showPreviewSlTp, setShowPreviewSlTp] = useState<boolean>(
    initialPreferences?.show_preview_sl_tp ?? false
  );
  // Mid-session slPoints / tpPoints as entered in LiveTradePanel. We lift
  // them here so the chart's preview lines update immediately when the
  // trader edits the inputs, without waiting for the debounced DB round-trip.
  // Seeded from persisted preferences so the first render of the preview
  // reflects the user's saved distances.
  const [previewSlPoints, setPreviewSlPoints] = useState<number | null>(
    initialPreferences?.sl_points != null ? initialPreferences.sl_points : 10
  );
  const [previewTpPoints, setPreviewTpPoints] = useState<number | null>(
    initialPreferences?.tp_points != null ? initialPreferences.tp_points : 20
  );

  // Persist the preview-lines toggle to trader_preferences. First run is
  // the mount where state was seeded from initialPreferences, so skip it
  // to avoid immediately re-writing the value we just loaded.
  const isFirstShowPreviewSlTp = useRef(true);
  useEffect(() => {
    if (isFirstShowPreviewSlTp.current) { isFirstShowPreviewSlTp.current = false; return; }
    saveTraderPreferencesDebounced({ show_preview_sl_tp: showPreviewSlTp });
  }, [showPreviewSlTp]);

  // ─── Live chart indicators ────────────────────────────────────────
  // Seeded from the persisted JSONB array; empty when none saved.
  // Mirrors the show_preview_sl_tp pattern above — first effect run is
  // the mount hydration, skip it; subsequent runs debounce-save the
  // full array under the live_indicators column.
  const [liveIndicators, setLiveIndicators] = useState<IndicatorConfig[]>(
    initialPreferences?.live_indicators ?? []
  );
  const isFirstLiveIndicators = useRef(true);
  useEffect(() => {
    if (isFirstLiveIndicators.current) { isFirstLiveIndicators.current = false; return; }
    saveTraderPreferencesDebounced({ live_indicators: liveIndicators });
  }, [liveIndicators]);
  const [connectionMode, setConnectionMode] = useState<"supabase" | "websocket">("websocket");
  // wsUrl resolution order (lazy init runs once on mount):
  //   1. localStorage "liveTrader.wsUrl" — last value the user set via DbManagerModal,
  //      so a working URL survives page reloads (matters when Parallels VM IPs shift
  //      after a host network change).
  //   2. NEXT_PUBLIC_LIVEBRIDGE_WS_URL — per-machine default pinned in .env.local.
  //   3. "ws://10.211.55.3:8765" — Parallels-default fallback so SSR + first-ever
  //      load on a fresh browser still produce a sensible value.
  // window guard is required because LiveTrader is reached from a server component
  // path and would otherwise crash during SSR with "localStorage is not defined".
  const [wsUrl, setWsUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem("liveTrader.wsUrl");
      if (stored) return stored;
    }
    return process.env.NEXT_PUBLIC_LIVEBRIDGE_WS_URL ?? "ws://10.211.55.3:8765";
  });

  // Persist wsUrl edits (made via DbManagerModal) so the next page load reuses
  // the user's working URL instead of snapping back to the hardcoded fallback.
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("liveTrader.wsUrl", wsUrl);
    }
  }, [wsUrl]);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Bumping this nonce re-runs the WS effect: cleanup closes the existing
  // socket and cancels any pending retry timer, then connect() runs fresh
  // with reset backoff. Used by the manual "Reconnect" button in settings
  // to recover from stuck/stale WS connections without toggling mode.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const handleReconnect = () => setReconnectNonce((n) => n + 1);

  // ─── Trade Timer ──────────────────────────────────────────────────
  // Post-entry countdown that enforces a minimum time-in-trade discipline
  // window. Settings persist in localStorage; the running deadline (timerEndsAt)
  // is intentionally NOT persisted — a page reload clears any active lockout.
  // Defaults: enabled, 5 minutes, auto-close at 0, lock new entries until 0.
  const DEFAULT_TIMER_SETTINGS: TradeTimerSettings = {
    enabled: true,
    durationSec: 300,
    autoCloseOnZero: true,
    lockoutUntilZero: true,
  };
  const [tradeTimerSettings, setTradeTimerSettings] = useState<TradeTimerSettings>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem("liveTrader.tradeTimer");
      if (stored) {
        try {
          // Spread defaults under the parsed object so newly added fields fall back safely.
          return { ...DEFAULT_TIMER_SETTINGS, ...JSON.parse(stored) };
        } catch {
          // Corrupt JSON — fall through to defaults.
        }
      }
    }
    return DEFAULT_TIMER_SETTINGS;
  });
  // Persist settings on every change
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("liveTrader.tradeTimer", JSON.stringify(tradeTimerSettings));
    }
  }, [tradeTimerSettings]);
  // Active countdown deadline (epoch ms). null = no timer running.
  const [timerEndsAt, setTimerEndsAt] = useState<number | null>(null);
  // Ref mirror so the keyboard handler / interval can read the current value
  // without re-binding (avoids stale-closure bugs in long-lived listeners).
  const timerEndsAtRef = useRef<number | null>(null);
  timerEndsAtRef.current = timerEndsAt;
  const tradeTimerSettingsRef = useRef(tradeTimerSettings);
  tradeTimerSettingsRef.current = tradeTimerSettings;

  // ─── Dynamic instrument/timeframe switching ─────────────────────
  // activeInstrument/activeTimeframe are the live values used for queries,
  // orders, and subscriptions. They sync from NT8's config on WS connect
  // and update optimistically when the user switches via the dropdowns.
  //
  // IMPORTANT: activeInstrument holds NT8's CANONICAL Instrument.FullName
  // (e.g. "NQ JUN26") so that all supabase filters/queries are joinable
  // with trades / live_state / live_bars rows that NT8 keys under that
  // exact string. The DROPDOWN, however, displays user-friendly contract
  // labels (e.g. "NQ 06-26") generated by getInstrumentNames(). Since the
  // canonical name does not match any <option value>, we track the dropdown
  // selection separately in selectedLabel — otherwise the <select> would
  // visually fall back to its first option whenever NT8 reports a canonical
  // name, making it look like the asset reverted on the user.
  const [activeInstrument, setActiveInstrument] = useState(instrument);
  // Allowed timeframe values — kept in sync with the TIMEFRAMES dropdown below.
  // We validate persisted timeframe against this set so a stale value can't
  // poison the dropdown if we ever rename a timeframe.
  const VALID_TIMEFRAMES = ["15 Second", "1 Minute", "5 Minute", "15 Minute"];
  const [activeTimeframe, setActiveTimeframe] = useState<string>(() => {
    const persisted = initialPreferences?.timeframe;
    if (persisted && VALID_TIMEFRAMES.includes(persisted)) return persisted;
    return "15 Second";
  });
  const [isSwitching, setIsSwitching] = useState(false);

  // Available instruments — contract months are computed from the current date
  const INSTRUMENTS = getInstrumentNames();

  // The dropdown label currently selected by the user. Prefer the persisted
  // label (when it still matches an available contract month); otherwise fall
  // back to the SSR prop. On switch we set this from the user's click; when
  // NT8 sends a canonical name we map it back to a matching label by symbol root.
  const [selectedLabel, setSelectedLabel] = useState<string>(() => {
    // 1. Use persisted label if it's still a valid dropdown option.
    const persisted = initialPreferences?.instrument_label;
    if (persisted && INSTRUMENTS.includes(persisted)) return persisted;
    // 2. If the SSR prop already matches a dropdown option, use it directly.
    if (INSTRUMENTS.includes(instrument)) return instrument;
    // 3. Otherwise try to map canonical → label by symbol root (e.g. "NQ JUN26" → "NQ 06-26").
    const root = instrument.split(" ")[0];
    return INSTRUMENTS.find((inst) => inst.startsWith(root + " ")) ?? INSTRUMENTS[0];
  });

  // Map a canonical NT8 FullName (e.g. "NQ JUN26") back to the dropdown label
  // (e.g. "NQ 06-26") by matching the root symbol prefix. Returns null if no
  // option matches — caller should leave the dropdown selection alone in that
  // case rather than visually snapping it to a different instrument.
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

  // ─── Shared tick price ref for zero-latency updates ──────────────
  // WS onmessage writes the latest price here; child RAF loops read it
  // every frame to update chart canvas + panel DOM without React renders.
  const tickPriceRef = useRef<number | null>(null);
  const headerPriceRef = useRef<HTMLSpanElement>(null);
  const lastStateSyncRef = useRef<number>(0);

  // Derive liveState for the currently selected account
  const liveState = allStates.find((s) => s.account === selectedAccount) ?? null;

  // Ref for keyboard shortcut access to current state
  const liveStateRef = useRef(liveState);
  liveStateRef.current = liveState;

  // ─── Trailing Stop refs ────────────────────────────────────────────
  // Trail distance is captured once when a trailed position first appears,
  // so the distance stays fixed even as the SL moves with price.
  const trailDistanceRef = useRef<number | null>(null);
  const lastTrailSendRef = useRef<number>(0);

  // ─── Fetch historical bars from Supabase ──────────────────────────
  // Used after data cleans and instrument switches to backfill the chart
  // with proper OHLCV history. NT8 reseeds bars to the live_bars table
  // via the reseed_bars command, so we poll until bars appear.
  const fetchBarsFromSupabase = useCallback(async (inst: string) => {
    const store = getClientStore(mode);
    // Poll a few times with a delay — NT8 needs time to reseed after a clean.
    // The store's listBarsForInstrument returns the latest N bars in
    // ascending order, matching the original DESC + slice().reverse() pattern.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      const data = await store.live.listBarsForInstrument(inst, "15 Second", 1000);
      if (data && data.length > 0) {
        setBars(data);
        return;
      }
    }
  }, [mode]);

  // ─── Refs for WS message validation ──────────────────────────────
  // WS onmessage closures capture stale state — refs always have the
  // latest values so we can filter out bars/ticks from the wrong instrument.
  const activeInstrumentRef = useRef(activeInstrument);
  activeInstrumentRef.current = activeInstrument;
  const isSwitchingRef = useRef(false);

  // ─── Refetch initial data when activeInstrument changes ───────────
  // SSR (page.tsx) queries bars/states/trades using the dropdown label
  // (e.g. "NQ 06-26"), but NT8 may report back a canonical FullName
  // ("NQ JUN26") via the WS command_update handler. When that happens
  // we need to pull fresh bars / live_state / today's trades under the
  // canonical key, since the SSR-fetched arrays were keyed under the
  // wrong string and would be empty for that instrument.
  useEffect(() => {
    // Skip the first run when activeInstrument still equals the SSR prop —
    // the SSR data is already loaded for that key.
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

  // ─── Realtime subscriptions (active when mode === "supabase") ──
  //
  // Cloud mode uses Supabase Realtime postgres_changes; local mode polls
  // /api/local/realtime/{live-bars,live-ticker,live-state} every ~1.5s.
  // The Store layer hides the difference behind subscribeBars / subscribeTicker
  // / subscribeStates. Each returns an unsubscribe fn for useEffect cleanup.
  //
  // Connected indicator: cloud realtime fires a status callback on the
  // underlying channel, but the Store interface doesn't expose that — we
  // optimistically set true after subscribing. In WebSocket mode this
  // effect is bypassed entirely (the WS effect drives `connected`).
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

  // ─── Trades realtime — runs in BOTH connection modes ───────────────
  // NT8's WebSocket protocol has no "trade" message type, so the frontend
  // would otherwise never learn about new trades in WS mode until the page
  // is refreshed. Subscribe to trades regardless of connection mode.
  // Filter by activeInstrument so switching instruments doesn't leak
  // markers from the previous contract onto the chart.
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

  // ─── WebSocket Connection (active when mode === "websocket") ────────

  useEffect(() => {
    if (connectionMode !== "websocket") {
      // Clean up any existing WS connection when switching away
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        setWsConnected(false);
      }
      return;
    }

    let alive = true;          // Set false on cleanup to stop reconnect loop
    let retryDelay = 1000;     // Exponential backoff: 1s → 2s → 4s → max 10s
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!alive) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WS] Connected to", wsUrl);
        retryDelay = 1000;
        // Reset the tick freshness clock so the stale-detection interval
        // doesn't immediately flag a just-reconnected socket as stale
        // based on the old pre-disconnect timestamp.
        lastTickTime.current = Date.now();
        setWsConnected(true);
        setConnected(true);
      };

      ws.onclose = (e) => {
        console.log("[WS] Closed — code:", e.code, "reason:", e.reason || "(none)", "— reconnecting in", retryDelay + "ms");
        if (wsLogTimer) { clearInterval(wsLogTimer); wsLogTimer = null; }
        setWsConnected(false);
        setConnected(false);
        wsRef.current = null;
        tickPriceRef.current = null;
        if (alive) {
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        }
      };

      ws.onerror = (e) => {
        console.error("[WS] Error:", e);
        setWsConnected(false);
        setConnected(false);
      };

      // Debug counters — log WS message stats every 5s
      let wsTickCount = 0;
      let wsOtherCount = 0;
      let wsLogTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (wsTickCount > 0 || wsOtherCount > 0) {
          console.log(`[WS] Last 5s: ${wsTickCount} ticks, ${wsOtherCount} other messages, tickPriceRef=${tickPriceRef.current}`);
          wsTickCount = 0;
          wsOtherCount = 0;
        }
      }, 5000);

      // Log the first 5 raw messages to verify format
      let rawLogCount = 0;

      ws.onmessage = (event) => {
        const data = event.data as string;

        // Log first 5 raw messages so we can verify the exact format
        if (rawLogCount < 5) {
          rawLogCount++;
          console.log(`[WS] Raw msg #${rawLogCount} (len=${data.length}): "${data.slice(0, 80)}" charCodeAt(9)=${data.charCodeAt(9)}`);
        }

        // Any inbound message proves the socket is alive — bump the
        // staleness clock here so the 30s reconnect-on-silence detector
        // (further down) doesn't tear down a healthy connection during
        // tick-quiet windows (overnight, between sessions, illiquid
        // futures hours). Without this, after-hours sessions that stream
        // bars but no ticks get force-reconnected every 30s.
        lastTickTime.current = Date.now();

        // ── Fast path for ticks — skip JSON.parse entirely ──────────
        // Tick format: {"type":"tick","last_price":XXXXX.XX}
        // Price starts at index 28. charCodeAt(9) checks for 't' in "tick".
        if (data.charCodeAt(9) === 116 /* 't' in tick */) {
          wsTickCount++;
          // Gate ticks during instrument switch — old instrument prices would corrupt the display
          if (isSwitchingRef.current) return;
          const price = parseFloat(data.slice(28, -1));
          // Write price to shared ref — child RAF loops pick it up every frame
          tickPriceRef.current = price;
          if (headerPriceRef.current) headerPriceRef.current.textContent = price.toFixed(2);
          lastTickTime.current = Date.now();
          // Sync to React state every ~250ms for slow consumers (canTrade, etc.)
          const now = Date.now();
          if (now - lastStateSyncRef.current > 250) {
            lastStateSyncRef.current = now;
            setLastPrice(price);
          }
          return;
        }

        // ── Slow path for bar/state/accounts — full JSON.parse ──────
        wsOtherCount++;
        console.log("[WS] Non-tick msg:", data.slice(0, 120));
        try {
          const msg = JSON.parse(data);

          switch (msg.type) {

            case "bar":
              // During an instrument switch, drop ALL bars regardless of name —
              // the old streamer may still emit a few bars under the old canonical
              // (which still equals activeInstrumentRef.current at this point) before
              // NT8 spins up the new BarStreamer. Without this gate they would
              // re-populate the just-cleared bars[] and corrupt the chart.
              if (isSwitchingRef.current) break;
              // Skip bars from a different instrument (e.g. during switch transition)
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
              // Same gating as bars — drop everything during a switch transition.
              if (isSwitchingRef.current) break;
              // Skip state updates from a different instrument (e.g. during switch transition)
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
              break;

            case "accounts":
              // Accounts received on connect — ignored here since we already have them
              break;

            case "config":
              // NT8 sends current instrument/timeframe on connect — sync our selectors.
              // msg.instrument is the canonical FullName (e.g. "NQ JUN26"), which we
              // store in activeInstrument for data queries. Separately, map it back
              // to a dropdown label (e.g. "NQ 06-26") so the <select> can render it.
              if (msg.instrument) {
                setActiveInstrument(msg.instrument);
                const label = labelForCanonical(msg.instrument);
                if (label) setSelectedLabel(label);
              }
              if (msg.timeframe) setActiveTimeframe(msg.timeframe);
              break;

            case "command_update":
              // Handle switch_instrument completion — ungate tick/bar data
              if (msg.command === "switch_instrument") {
                setIsSwitching(false);
                isSwitchingRef.current = false;
                if (msg.status === "error") {
                  console.error("[WS] switch_instrument error:", msg.error);
                } else if (msg.status === "completed" && msg.instrument) {
                  // NT8 reports back the CANONICAL Instrument.FullName, which may
                  // differ from the dropdown label we sent (e.g. dropdown sends
                  // "NQ 06-26" but NT8 normalizes to "NQ JUN26"). Adopt the canonical
                  // name as activeInstrument so all our supabase filters/queries and
                  // WS message gating use the same string the trades/live_state rows
                  // are actually keyed under. The supabase realtime useEffect (deps
                  // include activeInstrument) will tear down + re-subscribe under the
                  // new key automatically. We do NOT update selectedLabel here — that
                  // stays as whatever the user picked from the dropdown.
                  if (msg.instrument !== activeInstrumentRef.current) {
                    console.log(`[WS] Adopting canonical instrument: '${activeInstrumentRef.current}' → '${msg.instrument}'`);
                    activeInstrumentRef.current = msg.instrument;
                    setActiveInstrument(msg.instrument);
                  }
                }
              }
              break;
          }
        } catch { /* ignore malformed messages */ }
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
  }, [connectionMode, wsUrl, reconnectNonce]);

  // ─── Stale Connection Detection ───────────────────────────────────
  // Watchdog for silent TCP drops (WiFi switch, VM pause, NAT idle timeout)
  // that don't fire onclose, leaving both connected flags stuck `true`.
  // `lastTickTime` is bumped by both the WS onmessage handler (any message —
  // see top of onmessage) and a useEffect on lastPrice (covers Supabase mode).
  //
  // Threshold rationale: at 30s this fires constantly on slow markets and
  // higher-timeframe bars (e.g. a 15s timeframe with 20+ second tick gaps
  // overnight). Bumped to 3 minutes — long enough to span any reasonable
  // quiet period without holding a truly dead socket open. The dev-side ws-
  // proxy mirrors the browser close to NT8, so an over-eager force-reconnect
  // here also tears down NT8's BarStreamer subscription path, which is what
  // was producing the perpetual reconnect loop with no bars ever flowing.
  const STALE_MS = 180000;
  const lastTickTime = useRef(Date.now());
  useEffect(() => {
    lastTickTime.current = Date.now();
  }, [lastPrice]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - lastTickTime.current > STALE_MS) {
        if (connectionMode === "websocket" && wsRef.current) {
          const ws = wsRef.current;
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            console.warn(`[WS] Stale connection detected (no messages for ${Math.floor(STALE_MS / 1000)}s) — forcing reconnect`);
            ws.close();
            // Reset so the next interval doesn't immediately re-fire on a
            // freshly-opening socket whose lastTickTime hasn't been bumped yet.
            lastTickTime.current = Date.now();
          }
        } else if (connectionMode === "supabase") {
          setConnected(false);
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [connectionMode]);

  // No RAF loop needed — tick updates are pushed synchronously from
  // the WS onmessage handler to chart, panel, and header DOM elements.

  // ─── Trade Handlers ───────────────────────────────────────────────
  // In WebSocket mode, send orders directly to NT8 via WS for lowest latency.
  // In Supabase mode, use the server action which inserts into order_requests.

  /** Send an order via WebSocket (bypasses Supabase for minimum latency) */
  const sendWsOrder = useCallback((order: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "order", ...order }));
    }
  }, []);

  /** Switch instrument and/or timeframe — sends command to NT8 and clears local state.
   *  newInstrumentLabel is the dropdown label (e.g. "NQ 06-26"), NOT the canonical
   *  NT8 FullName. NT8 will resolve it and broadcast the canonical name back via
   *  command_update, which is what we then store in activeInstrument for queries. */
  const handleSwitchConfig = useCallback((newInstrumentLabel: string, newTimeframe: string) => {
    // Warn if there's an open position (trailing stops won't track the old instrument)
    if (liveStateRef.current?.position_direction != null) {
      if (!confirm("You have an open position. Switching will stop trailing stops for the current instrument. Continue?")) {
        return;
      }
    }

    // Clear stale data for clean transition — bars, price, trades, and states
    // must all be reset so nothing from the old instrument leaks into the chart
    setBars([]);
    setLastPrice(null);
    tickPriceRef.current = null;
    setTrades([]);
    setIsSwitching(true);
    isSwitchingRef.current = true;

    // Update the dropdown selection optimistically so the UI reflects the click
    // immediately. activeInstrument is intentionally NOT updated here — it gets
    // overwritten with NT8's canonical FullName when command_update arrives.
    setSelectedLabel(newInstrumentLabel);
    setActiveTimeframe(newTimeframe);

    // Persist the new asset/timeframe so the next page load restores it.
    saveTraderPreferencesDebounced({
      instrument_label: newInstrumentLabel,
      timeframe: newTimeframe,
    });

    // Send switch command to NT8 via WebSocket
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "command",
        command: "switch_instrument",
        instrument: newInstrumentLabel,
        timeframe: newTimeframe,
      }));
    }

    // Note: we deliberately do NOT call fetchBarsFromSupabase here. The bars
    // table is keyed under NT8's canonical FullName, which we won't know until
    // command_update arrives. The refetch useEffect (deps: [activeInstrument])
    // will fire under the canonical name once we adopt it and pull the right
    // history. The post-switch chart hydration is also handled by the WS bar
    // stream from the new BarStreamer NT8 spins up.
  }, []);

  /**
   * Gatekeeper for new entries.
   * Returns true when the trade timer lockout is active and entries should be blocked.
   * Reads from refs so this can be safely called from any callback without re-binding.
   */
  const isLockedByTradeTimer = useCallback((): boolean => {
    const s = tradeTimerSettingsRef.current;
    if (!s.enabled || !s.lockoutUntilZero) return false;
    const endsAt = timerEndsAtRef.current;
    return endsAt != null && Date.now() < endsAt;
  }, []);

  /**
   * Starts the post-entry countdown when settings.enabled is true.
   * Called from inside handleBuyLong / handleSellShort right after the order is dispatched.
   */
  const startTradeTimer = useCallback(() => {
    const s = tradeTimerSettingsRef.current;
    if (!s.enabled) return;
    setTimerEndsAt(Date.now() + s.durationSec * 1000);
  }, []);

  const handleBuyLong = useCallback(
    async (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => {
      // Block re-entry while trade timer lockout is active
      if (isLockedByTradeTimer()) return;
      if (connectionMode === "websocket") {
        sendWsOrder({ action: "buy_long", account: selectedAccount, sl_points: slPts, tp_points: tpPts, trail_enabled: trail, quantity: qty });
      } else {
        await submitOrder(activeInstrument, selectedAccount, "buy_long", slPts, tpPts, trail, null, null, qty);
      }
      startTradeTimer();
    },
    [activeInstrument, selectedAccount, connectionMode, sendWsOrder, isLockedByTradeTimer, startTradeTimer]
  );

  const handleSellShort = useCallback(
    async (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => {
      // Block re-entry while trade timer lockout is active
      if (isLockedByTradeTimer()) return;
      if (connectionMode === "websocket") {
        sendWsOrder({ action: "sell_short", account: selectedAccount, sl_points: slPts, tp_points: tpPts, trail_enabled: trail, quantity: qty });
      } else {
        await submitOrder(activeInstrument, selectedAccount, "sell_short", slPts, tpPts, trail, null, null, qty);
      }
      startTradeTimer();
    },
    [activeInstrument, selectedAccount, connectionMode, sendWsOrder, isLockedByTradeTimer, startTradeTimer]
  );

  const handleClose = useCallback(async () => {
    if (connectionMode === "websocket") {
      sendWsOrder({ action: "close", account: selectedAccount });
    } else {
      await submitOrder(activeInstrument, selectedAccount, "close");
    }
  }, [activeInstrument, selectedAccount, connectionMode, sendWsOrder]);

  // Add to position — sends same direction entry with the original SL/TP
  // distance and the same lot size as the first entry.
  const handleAdd = useCallback(async (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => {
    const state = liveStateRef.current;
    if (!state?.position_direction) return;
    const action = state.position_direction === "Long" ? "buy_long" : "sell_short";
    if (connectionMode === "websocket") {
      sendWsOrder({ action, account: selectedAccount, sl_points: slPts, tp_points: tpPts, trail_enabled: trail, quantity: qty });
    } else {
      await submitOrder(activeInstrument, selectedAccount, action as "buy_long" | "sell_short", slPts, tpPts, trail, null, null, qty);
    }
  }, [activeInstrument, selectedAccount, connectionMode, sendWsOrder]);

  const handleModifySl = useCallback(async (newPrice: number) => {
    if (connectionMode === "websocket") {
      sendWsOrder({ action: "modify_sl", account: selectedAccount, new_sl_price: newPrice });
    } else {
      await submitOrder(activeInstrument, selectedAccount, "modify_sl", null, null, false, newPrice);
    }
  }, [activeInstrument, selectedAccount, connectionMode, sendWsOrder]);

  const handleModifyTp = useCallback(async (newPrice: number) => {
    if (connectionMode === "websocket") {
      sendWsOrder({ action: "modify_tp", account: selectedAccount, new_tp_price: newPrice });
    } else {
      await submitOrder(activeInstrument, selectedAccount, "modify_tp", null, null, false, null, newPrice);
    }
  }, [activeInstrument, selectedAccount, connectionMode, sendWsOrder]);

  // ─── Auto-Trader hook ─────────────────────────────────────────────
  // Deploys a backtest preset against the live bar feed: signals + filters
  // + SimRules exits all reuse the backtest pipeline. The hook owns its
  // own state (armed/disarmed, daily counters, active entry, log) and
  // dispatches orders through the same handlers the manual UI uses, so
  // automated and manual trading share one execution path.
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

  // ─── Trade Timer expiration loop ──────────────────────────────────
  // While a countdown is active, polls every 250ms. When the deadline is hit:
  //   - if autoCloseOnZero is on AND a position is still open → close it
  //   - clear timerEndsAt either way so the lockout lifts
  // The timer intentionally does NOT stop or reset if the trade was closed
  // early — that would defeat the anti-revenge-trade discipline window.
  useEffect(() => {
    if (timerEndsAt == null) return;

    const id = window.setInterval(() => {
      if (Date.now() >= timerEndsAt) {
        const settings = tradeTimerSettingsRef.current;
        const stillOpen = liveStateRef.current?.position_direction != null;
        if (settings.autoCloseOnZero && stillOpen) {
          handleClose();
        }
        setTimerEndsAt(null);
      }
    }, 250);

    return () => window.clearInterval(id);
  }, [timerEndsAt, handleClose]);

  // If the user disables the timer (or the lockout) mid-countdown, lift the
  // lockout immediately so they're not stuck waiting for a deadline that no
  // longer applies. We keep the timer running if only autoCloseOnZero changes.
  useEffect(() => {
    if (!tradeTimerSettings.enabled) {
      setTimerEndsAt(null);
    }
  }, [tradeTimerSettings.enabled]);

  // ─── Keyboard Shortcuts ───────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const state = liveStateRef.current;
      const hasPosition = state?.position_direction != null;
      // Lockout is enforced inside handleBuyLong/handleSellShort too, but we
      // also check here so the keypress is fully consumed (no flicker / accidental
      // dispatch) when the user is locked out.
      const locked = isLockedByTradeTimer();

      switch (e.code) {
        case "KeyB":
          // Buy Long — only if flat AND not locked by trade timer
          if (!hasPosition && !locked) {
            e.preventDefault();
            // Hardcoded SL/TP/qty fallback for keyboard shortcut — the panel
            // buttons use the user's actual configured values.
            handleBuyLong(10, 20, false, 1);
          }
          break;
        case "KeyS":
          // Sell Short — only if flat AND not locked by trade timer
          if (!hasPosition && !locked) {
            e.preventDefault();
            handleSellShort(10, 20, false, 1);
          }
          break;
        case "KeyA":
          // Add to position — only if already in a position
          if (hasPosition) {
            e.preventDefault();
            const addQty = state?.original_entry_qty ?? 1;
            handleAdd(10, 20, false, addQty);
          }
          break;
        case "KeyX":
          // Close position
          if (hasPosition) {
            e.preventDefault();
            handleClose();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleBuyLong, handleSellShort, handleClose, handleAdd, isLockedByTradeTimer]);

  // ─── Trailing Stop Loop ──────────────────────────────────────────
  // Runs a RAF loop that checks the latest tick price against the current
  // SL. When trail_enabled is active, computes a new SL at a fixed distance
  // from price and sends modify_sl to NT8 when the stop should move.
  // All trailing logic lives here in the frontend — NT8 just executes
  // the modify_sl commands to update the actual stop order.
  useEffect(() => {
    let running = true;

    const tick = () => {
      if (!running) return;

      const state = liveStateRef.current;
      const price = tickPriceRef.current;

      if (
        state?.trail_enabled &&
        state.sl_price &&
        state.position_direction &&
        state.position_entry_price &&
        price
      ) {
        // Capture the SL distance once when trailing first activates.
        // This stays fixed so the stop always trails at the original distance.
        if (trailDistanceRef.current === null) {
          trailDistanceRef.current = Math.abs(
            state.position_entry_price - state.sl_price
          );
        }

        const distance = trailDistanceRef.current;
        if (distance > 0) {
          const isLong = state.position_direction === "Long";
          // Round to 2 decimals — NT8 handles tick-level rounding on its side
          const newSl = parseFloat(
            (isLong ? price - distance : price + distance).toFixed(2)
          );

          // Only move in the favorable direction
          const shouldMove = isLong
            ? newSl > state.sl_price
            : newSl < state.sl_price;

          if (shouldMove) {
            const now = Date.now();
            // Throttle to max 1 modify_sl per 500ms to avoid flooding NT8
            if (now - lastTrailSendRef.current >= 500) {
              lastTrailSendRef.current = now;
              handleModifySl(newSl);

              // Optimistically update the ref so the chart line moves immediately
              // (the next WS state message from NT8 will confirm the actual value)
              if (liveStateRef.current) {
                liveStateRef.current = {
                  ...liveStateRef.current,
                  sl_price: newSl,
                };
                // Also push into React state so the chart rerenders with new SL line
                setAllStates((prev) => {
                  const idx = prev.findIndex(
                    (s) => s.account === state.account && s.instrument === state.instrument
                  );
                  if (idx >= 0) {
                    const copy = [...prev];
                    copy[idx] = { ...copy[idx], sl_price: newSl };
                    return copy;
                  }
                  return prev;
                });
              }
            }
          }
        }
      } else {
        // No active trailing position — reset distance so it recalculates
        // when a new trailed position appears
        trailDistanceRef.current = null;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    return () => { running = false; };
  }, [handleModifySl]);

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Instrument selector — value is the dropdown label, not the canonical
              NT8 FullName held in activeInstrument. Otherwise the <select> would
              snap to its first option whenever NT8 reports a canonical name. */}
          <select
            value={selectedLabel}
            onChange={(e) => handleSwitchConfig(e.target.value, activeTimeframe)}
            disabled={isSwitching}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-sm font-bold
                       text-foreground focus:outline-none focus:border-muted disabled:opacity-50"
          >
            {INSTRUMENTS.map((inst) => (
              <option key={inst} value={inst}>{inst}</option>
            ))}
          </select>
          {/* Timeframe selector — pass the dropdown label (selectedLabel),
              not the canonical activeInstrument, so handleSwitchConfig keeps
              the user's selection intact. */}
          <select
            value={activeTimeframe}
            onChange={(e) => handleSwitchConfig(selectedLabel, e.target.value)}
            disabled={isSwitching}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-sm font-bold
                       text-foreground focus:outline-none focus:border-muted disabled:opacity-50"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf.value} value={tf.value}>{tf.label}</option>
            ))}
          </select>
          {isSwitching && (
            <span className="text-xs text-muted animate-pulse">Switching...</span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded ${
            connected
              ? "bg-accent-green/20 text-accent-green"
              : "bg-accent-red/20 text-accent-red"
          }`}>
            {connected ? "LIVE" : "DISCONNECTED"}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {/* Account selector */}
          <select
            value={selectedAccount}
            onChange={(e) => {
              setSelectedAccount(e.target.value);
              // Persist account choice across reloads.
              saveTraderPreferencesDebounced({ selected_account: e.target.value });
            }}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-sm
                       text-foreground focus:outline-none focus:border-muted"
          >
            {accounts.length === 0 && (
              <option value="">No accounts</option>
            )}
            {accounts.map((acct) => (
              <option key={acct} value={acct}>{acct}</option>
            ))}
          </select>
          <span ref={headerPriceRef} className="text-2xl font-bold font-mono text-foreground">
            {lastPrice?.toFixed(2) ?? "—"}
          </span>
          <span className="text-xs text-muted/60">
            B = Buy &nbsp;|&nbsp; S = Sell &nbsp;|&nbsp; X = Close
          </span>
          {/* DB Manager gear button */}
          <button
            onClick={() => setDbModalOpen(true)}
            className="text-muted hover:text-foreground transition-colors"
            title="DB Manager"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Main content: chart + trade panel */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Chart area */}
        <div className="flex-1 min-h-[400px]">
          <LiveChart
            bars={bars}
            liveState={liveState}
            lastPrice={lastPrice}
            priceRef={connectionMode === "websocket" ? tickPriceRef : undefined}
            trades={showTrades ? trades : []}
            timeframe={activeTimeframe}
            instrument={activeInstrument}
            onModifySl={handleModifySl}
            onModifyTp={handleModifyTp}
            showPreviewSlTp={showPreviewSlTp}
            previewSlPoints={previewSlPoints}
            previewTpPoints={previewTpPoints}
            indicatorConfigs={liveIndicators}
            onIndicatorsChange={setLiveIndicators}
          />
        </div>

        {/* Right sidebar — Trade (order entry) / Tagger (grade + notes) */}
        <div className="w-72 shrink-0 flex flex-col gap-2 min-h-0">
          {/* Tab strip */}
          <div className="flex gap-1 p-1 bg-card border border-card-border rounded-lg">
            <button
              onClick={() => setRightPanelTab("trade")}
              className={`flex-1 px-2 py-1 text-xs rounded-md transition-colors ${
                rightPanelTab === "trade"
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:bg-white/5"
              }`}
            >
              Trade
            </button>
            <button
              onClick={() => setRightPanelTab("auto")}
              className={`flex-1 px-2 py-1 text-xs rounded-md transition-colors ${
                rightPanelTab === "auto"
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:bg-white/5"
              } ${autoTrader.state.armed ? "ring-1 ring-accent-green/50" : ""}`}
            >
              Auto
              {autoTrader.state.armed && (
                <span className="ml-1 text-accent-green">●</span>
              )}
            </button>
            <button
              onClick={() => setRightPanelTab("tagger")}
              className={`flex-1 px-2 py-1 text-xs rounded-md transition-colors ${
                rightPanelTab === "tagger"
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:bg-white/5"
              }`}
            >
              Tagger
            </button>
          </div>

          {/* Active panel */}
          <div className="flex-1 min-h-0">
            {rightPanelTab === "trade" ? (
              <LiveTradePanel
                liveState={liveState}
                lastPrice={lastPrice}
                priceRef={connectionMode === "websocket" ? tickPriceRef : undefined}
                onBuyLong={handleBuyLong}
                onSellShort={handleSellShort}
                onClose={handleClose}
                onAdd={handleAdd}
                tradeTimerSettings={tradeTimerSettings}
                timerEndsAt={timerEndsAt}
                initialPreferences={initialPreferences}
                onSlPointsChange={setPreviewSlPoints}
                onTpPointsChange={setPreviewTpPoints}
              />
            ) : rightPanelTab === "auto" ? (
              <AutoTraderPanel
                state={autoTrader.state}
                onArm={autoTrader.arm}
                onDisarm={autoTrader.disarm}
              />
            ) : (
              <LiveTaggerPanel trades={trades} />
            )}
          </div>
        </div>
      </div>

      {/* DB Manager Modal */}
      <DbManagerModal
        open={dbModalOpen}
        onClose={() => setDbModalOpen(false)}
        instrument={activeInstrument}
        onDataCleaned={() => {
          // Clear client-side state so chart resets cleanly
          setBars([]);
          setLastPrice(null);
          tickPriceRef.current = null;
          setTrades([]);
          // In WS mode, also send reseed command via WebSocket so NT8 knows
          if (connectionMode === "websocket" && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "command",
              command: "reseed_bars",
              instrument: activeInstrument,
              timeframe: activeTimeframe,
            }));
          }
          // Re-fetch historical bars from Supabase once NT8 reseeds them.
          // The Supabase cleanLiveData action already inserted a reseed_bars
          // command — NT8 will post ~100 warmup bars to live_bars shortly.
          fetchBarsFromSupabase(activeInstrument);
        }}
        showTrades={showTrades}
        onToggleShowTrades={setShowTrades}
        connectionMode={connectionMode}
        onConnectionModeChange={setConnectionMode}
        wsUrl={wsUrl}
        onWsUrlChange={setWsUrl}
        wsConnected={wsConnected}
        onReconnect={handleReconnect}
        tradeTimerSettings={tradeTimerSettings}
        onTradeTimerSettingsChange={setTradeTimerSettings}
        showPreviewSlTp={showPreviewSlTp}
        onTogglePreviewSlTp={setShowPreviewSlTp}
      />
    </div>
  );
}
