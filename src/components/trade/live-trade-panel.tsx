"use client";

/**
 * LiveTradePanel — Sidebar UI for live trading.
 *
 * Shows Buy/Sell buttons, SL/TP/trailing inputs, live position with P&L,
 * and a close button. When priceRef is provided (WebSocket mode), runs its
 * own RAF loop to update price + P&L directly in the DOM without React re-renders.
 */

import { useState, useEffect, useRef, type MutableRefObject } from "react";
import { LiveState, TradeTimerSettings } from "@/types/live";
import {
  saveTraderPreferencesDebounced,
  type TraderPreferences,
} from "@/lib/trader-preferences";

interface LiveTradePanelProps {
  liveState: LiveState | null;
  /** Latest tick price (used for initial render / Supabase mode) */
  lastPrice: number | null;
  /** Shared ref holding the latest tick price — written by WS handler,
   *  read by this component's own RAF loop for zero-latency updates. */
  priceRef?: MutableRefObject<number | null>;
  onBuyLong: (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => void;
  onSellShort: (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => void;
  onClose: () => void;
  onAdd: (slPts: number | null, tpPts: number | null, trail: boolean, qty: number) => void;
  /** Trade timer config (used to decide whether the lockout applies). */
  tradeTimerSettings: TradeTimerSettings;
  /** Active countdown deadline as epoch ms, or null if no timer is running. */
  timerEndsAt: number | null;
  /** Persisted user preferences from trader_preferences. Used to seed
   *  TP/SL/toggle initial state so values survive page reloads. */
  initialPreferences?: TraderPreferences | null;
  /** Optional callback — fires whenever the SL points input changes (parsed).
   *  Passed through to LiveTrader so the chart's preview SL/TP lines can
   *  update immediately on edit, without waiting for the debounced DB write. */
  onSlPointsChange?: (points: number | null) => void;
  /** See onSlPointsChange — same purpose for the TP points input. */
  onTpPointsChange?: (points: number | null) => void;
}

export default function LiveTradePanel({
  liveState,
  lastPrice,
  priceRef,
  onBuyLong,
  onSellShort,
  onClose,
  onAdd,
  tradeTimerSettings,
  timerEndsAt,
  initialPreferences,
  onSlPointsChange,
  onTpPointsChange,
}: LiveTradePanelProps) {
  // SL/TP/TSL inputs — seeded from persisted preferences when present,
  // otherwise fall back to the original hardcoded defaults.
  const [slPoints, setSlPoints] = useState<string>(() =>
    initialPreferences?.sl_points != null ? String(initialPreferences.sl_points) : "10"
  );
  const [tpPoints, setTpPoints] = useState<string>(() =>
    initialPreferences?.tp_points != null ? String(initialPreferences.tp_points) : "20"
  );
  const [slEnabled, setSlEnabled] = useState<boolean>(
    initialPreferences?.sl_enabled ?? true
  );
  const [tpEnabled, setTpEnabled] = useState<boolean>(
    initialPreferences?.tp_enabled ?? true
  );
  const [trailEnabled, setTrailEnabled] = useState<boolean>(
    initialPreferences?.trail_enabled ?? false
  );
  // Number of contracts per trade — string-backed so the input can be cleared
  // mid-edit without snapping back to a number. parseInt at submission time.
  const [quantity, setQuantity] = useState<string>(() =>
    initialPreferences?.quantity != null ? String(initialPreferences.quantity) : "1"
  );

  // ─── Persist TP/SL/toggle changes to Supabase ──────────────────────
  // Each effect skips its first run (mount) so we don't immediately
  // overwrite freshly-loaded values with the same data we just rendered.
  // The debounced helper merges rapid input changes into a single upsert.
  const isFirstSlPoints = useRef(true);
  useEffect(() => {
    if (isFirstSlPoints.current) { isFirstSlPoints.current = false; return; }
    // Empty input → null in DB. parseFloat("") is NaN, so guard explicitly.
    const parsed = slPoints === "" ? null : parseFloat(slPoints);
    const clean = parsed != null && !Number.isNaN(parsed) ? parsed : null;
    saveTraderPreferencesDebounced({ sl_points: clean });
    // Push the clean value up so the chart's preview lines can react
    // immediately, without waiting for the 500ms debounce to flush.
    onSlPointsChange?.(clean);
  }, [slPoints, onSlPointsChange]);

  const isFirstTpPoints = useRef(true);
  useEffect(() => {
    if (isFirstTpPoints.current) { isFirstTpPoints.current = false; return; }
    const parsed = tpPoints === "" ? null : parseFloat(tpPoints);
    const clean = parsed != null && !Number.isNaN(parsed) ? parsed : null;
    saveTraderPreferencesDebounced({ tp_points: clean });
    onTpPointsChange?.(clean);
  }, [tpPoints, onTpPointsChange]);

  const isFirstSlEnabled = useRef(true);
  useEffect(() => {
    if (isFirstSlEnabled.current) { isFirstSlEnabled.current = false; return; }
    saveTraderPreferencesDebounced({ sl_enabled: slEnabled });
  }, [slEnabled]);

  const isFirstTpEnabled = useRef(true);
  useEffect(() => {
    if (isFirstTpEnabled.current) { isFirstTpEnabled.current = false; return; }
    saveTraderPreferencesDebounced({ tp_enabled: tpEnabled });
  }, [tpEnabled]);

  const isFirstTrailEnabled = useRef(true);
  useEffect(() => {
    if (isFirstTrailEnabled.current) { isFirstTrailEnabled.current = false; return; }
    saveTraderPreferencesDebounced({ trail_enabled: trailEnabled });
  }, [trailEnabled]);

  const isFirstQuantity = useRef(true);
  useEffect(() => {
    if (isFirstQuantity.current) { isFirstQuantity.current = false; return; }
    // Empty/invalid input → null in DB. We never persist 0 — that would
    // mean "no contracts", which isn't a meaningful default.
    const parsed = quantity === "" ? null : parseInt(quantity, 10);
    saveTraderPreferencesDebounced({
      quantity: parsed != null && !Number.isNaN(parsed) && parsed > 0 ? parsed : null,
    });
  }, [quantity]);

  // DOM refs for imperative price/P&L updates (bypass React render)
  const priceDisplayRef = useRef<HTMLDivElement>(null);
  const pnlDisplayRef = useRef<HTMLSpanElement>(null);
  // Keep liveState accessible from the RAF loop via ref
  const liveStateRef = useRef(liveState);
  liveStateRef.current = liveState;

  // ─── Internal RAF loop — reads priceRef for zero-latency DOM updates ──
  const lastTickPriceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!priceRef) return; // Supabase mode — no RAF loop needed

    let running = true;

    const tick = () => {
      if (!running) return;

      const price = priceRef.current;
      if (price !== null && price !== lastTickPriceRef.current) {
        lastTickPriceRef.current = price;

        // Update price display directly in DOM (guard: node must still be mounted)
        if (priceDisplayRef.current?.isConnected) {
          priceDisplayRef.current.textContent = price.toFixed(2);
        }

        // Calculate and update P&L directly in DOM (guard: node must still be mounted)
        const state = liveStateRef.current;
        if (pnlDisplayRef.current?.isConnected && state?.position_direction && state.position_entry_price) {
          const pnl = state.position_direction === "Long"
            ? price - state.position_entry_price
            : state.position_entry_price - price;
          const rounded = Math.round(pnl * 100) / 100;
          pnlDisplayRef.current.textContent = `${rounded >= 0 ? "+" : ""}${rounded.toFixed(2)}`;
          // Use style.color instead of className to avoid conflicting with React's DOM diffing
          pnlDisplayRef.current.style.color = rounded >= 0 ? "var(--color-accent-green)" : "var(--color-accent-red)";
        }
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    return () => { running = false; };
  }, [priceRef]);

  // ─── Trade Timer countdown ─────────────────────────────────────────
  // Tick state — only used to drive the visible MM:SS display. We bump it
  // every 250ms while the timer is active so the countdown re-renders.
  // The actual lockout logic is enforced in LiveTrader; this is just UI.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timerEndsAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [timerEndsAt]);

  const remainingMs =
    timerEndsAt != null ? Math.max(0, timerEndsAt - now) : 0;
  const lockedByTimer =
    tradeTimerSettings.enabled &&
    tradeTimerSettings.lockoutUntilZero &&
    timerEndsAt != null &&
    remainingMs > 0;

  // Format remaining ms as MM:SS for the countdown display.
  const formatRemaining = (ms: number) => {
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const hasPosition = liveState?.position_direction !== null && liveState?.position_direction !== undefined;
  const canTrade = lastPrice !== null && !hasPosition && !lockedByTimer;

  // Calculate initial P&L from lastPrice prop (first render / Supabase mode)
  let pnl = 0;
  if (hasPosition && liveState && lastPrice !== null && liveState.position_entry_price) {
    pnl = liveState.position_direction === "Long"
      ? lastPrice - liveState.position_entry_price
      : liveState.position_entry_price - lastPrice;
    pnl = Math.round(pnl * 100) / 100;
  }

  const handleEntry = (direction: "Long" | "Short") => {
    const sl = slEnabled && slPoints ? parseFloat(slPoints) : null;
    const tp = tpEnabled && tpPoints ? parseFloat(tpPoints) : null;
    // Clamp invalid/empty quantity to 1 so the user can never accidentally
    // dispatch a zero-contract order. parseInt("") is NaN, hence the guard.
    const parsedQty = parseInt(quantity, 10);
    const qty = Number.isNaN(parsedQty) || parsedQty < 1 ? 1 : parsedQty;
    if (direction === "Long") {
      onBuyLong(sl, tp, trailEnabled, qty);
    } else {
      onSellShort(sl, tp, trailEnabled, qty);
    }
  };

  // Add to position — uses the panel's current SL/TP distances and the
  // original entry qty (from live state) so each add is the same lot size.
  const handleAddToPosition = () => {
    const sl = slEnabled && slPoints ? parseFloat(slPoints) : null;
    const tp = tpEnabled && tpPoints ? parseFloat(tpPoints) : null;
    const addQty = liveState?.original_entry_qty ?? 1;
    onAdd(sl, tp, trailEnabled, addQty);
  };

  return (
    <div className="bg-card border border-card-border rounded-lg p-4 flex flex-col gap-4 h-full">
      {/* ─── Live Price ─────────────────────────────────────── */}
      <div className="text-center">
        <div ref={priceDisplayRef} className="text-2xl font-bold font-mono text-foreground">
          {lastPrice?.toFixed(2) ?? "—"}
        </div>
        <div className="text-xs text-muted-foreground">Last Price</div>
      </div>

      <div className="border-t border-card-border" />

      {/* ─── Quantity (contracts per trade) ───────────────────── */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Quantity (contracts)
        </label>
        <input
          type="number"
          min="1"
          step="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="w-full bg-background border border-card-border rounded px-2 py-1.5
                     text-sm font-mono text-foreground
                     focus:outline-none focus:border-muted"
        />
      </div>

      {/* ─── SL/TP/Trail Inputs ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <input
              type="checkbox"
              checked={slEnabled}
              onChange={(e) => setSlEnabled(e.target.checked)}
              className="accent-accent-red"
            />
            Stop Loss (pts)
          </label>
          <input
            type="number"
            value={slPoints}
            onChange={(e) => setSlPoints(e.target.value)}
            disabled={!slEnabled}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm font-mono text-foreground disabled:opacity-40
                       focus:outline-none focus:border-muted"
          />
        </div>
        <div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <input
              type="checkbox"
              checked={tpEnabled}
              onChange={(e) => setTpEnabled(e.target.checked)}
              className="accent-accent-green"
            />
            Take Profit (pts)
          </label>
          <input
            type="number"
            value={tpPoints}
            onChange={(e) => setTpPoints(e.target.value)}
            disabled={!tpEnabled}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm font-mono text-foreground disabled:opacity-40
                       focus:outline-none focus:border-muted"
          />
        </div>
      </div>

      {/* Trailing Stop Toggle */}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={trailEnabled}
          onChange={(e) => setTrailEnabled(e.target.checked)}
          className="accent-amber-400"
        />
        Trailing Stop (uses SL distance)
      </label>

      {/* ─── Entry Buttons ──────────────────────────────────── */}
      {!hasPosition && (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleEntry("Long")}
            disabled={!canTrade}
            className="py-3 rounded font-medium text-sm bg-accent-green/20 text-accent-green
                       border border-accent-green/40 hover:bg-accent-green/30
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Buy Long
          </button>
          <button
            onClick={() => handleEntry("Short")}
            disabled={!canTrade}
            className="py-3 rounded font-medium text-sm bg-accent-red/20 text-accent-red
                       border border-accent-red/40 hover:bg-accent-red/30
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Sell Short
          </button>
        </div>
      )}

      {/* ─── Open Position ──────────────────────────────────── */}
      {hasPosition && liveState && (
        <div className={`p-3 rounded border ${
          liveState.position_direction === "Long"
            ? "border-accent-green/30 bg-accent-green/5"
            : "border-accent-red/30 bg-accent-red/5"
        }`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-sm font-medium ${
              liveState.position_direction === "Long" ? "text-accent-green" : "text-accent-red"
            }`}>
              {liveState.position_direction} {liveState.position_quantity}x @ {liveState.position_entry_price?.toFixed(2)}
            </span>
            <span
              ref={(el) => {
                pnlDisplayRef.current = el;
                // Set initial content imperatively so React has no text children to reconcile
                if (el) {
                  el.textContent = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
                  el.style.color = pnl >= 0 ? "var(--color-accent-green)" : "var(--color-accent-red)";
                }
              }}
              className="text-sm font-bold font-mono"
            />
          </div>

          <div className="flex flex-col gap-1 text-xs text-muted-foreground mb-3">
            {(liveState.brackets && liveState.brackets.length > 1) ? (
              // Multiple brackets — show each with its own SL/TP
              liveState.brackets.map((b, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-muted-foreground/60">#{i + 1}</span>
                  {b.sl_price != null && <span>SL: {b.sl_price.toFixed(2)}</span>}
                  {b.tp_price != null && <span>TP: {b.tp_price.toFixed(2)}</span>}
                  <span className="text-muted-foreground/40">{b.qty}x</span>
                </div>
              ))
            ) : (
              // Single bracket — simple display
              <div className="flex gap-3">
                {liveState.sl_price && <span>SL: {liveState.sl_price.toFixed(2)}</span>}
                {liveState.tp_price && <span>TP: {liveState.tp_price.toFixed(2)}</span>}
              </div>
            )}
            {liveState.trail_enabled && <span className="text-amber-400">TSL</span>}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleAddToPosition}
              className="flex-1 py-2 rounded text-sm font-medium bg-muted/20
                         text-foreground border border-card-border hover:border-amber-400
                         hover:text-amber-400 transition-colors"
            >
              Add
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-2 rounded text-sm font-medium bg-muted/20
                         text-foreground border border-card-border hover:border-accent-red
                         hover:text-accent-red transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* ─── Trade Timer Countdown ──────────────────────────── */}
      {/* Renders a circular progress ring around the MM:SS readout. The ring
          drains clockwise from full → empty as the deadline approaches.
          Implementation: a single SVG <circle> whose strokeDasharray equals
          its circumference and whose strokeDashoffset = circumference *
          elapsedFraction. Stroke is rotated -90° so the ring starts at 12 o'clock. */}
      {timerEndsAt != null && (() => {
        // Geometry — keep size + radius as constants so the math is obvious.
        const SIZE = 96;
        const STROKE = 6;
        const RADIUS = (SIZE - STROKE) / 2;
        const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
        // Total duration of THIS countdown — derived from the deadline + the
        // current `now` tick. We can't read durationSec directly because the
        // user might change it mid-countdown; the running timer must reflect
        // the duration it was started with, which is timerEndsAt - startedAt.
        // Instead we approximate using settings.durationSec; if the user
        // changed duration mid-flight the ring would be wrong, but the next
        // entry will use the new duration and the ring will be correct again.
        const totalMs = tradeTimerSettings.durationSec * 1000;
        const elapsedFraction = Math.min(1, Math.max(0, 1 - remainingMs / totalMs));
        const dashOffset = CIRCUMFERENCE * elapsedFraction;

        return (
          <div className="p-3 rounded border border-amber-400/30 bg-amber-400/5 flex flex-col items-center">
            <div className="text-xs text-muted-foreground mb-2">
              Trade Timer
            </div>
            <div className="relative" style={{ width: SIZE, height: SIZE }}>
              <svg
                width={SIZE}
                height={SIZE}
                className="-rotate-90"
                style={{ display: "block" }}
              >
                {/* Background track */}
                <circle
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke="rgb(251 191 36 / 0.2)"
                  strokeWidth={STROKE}
                />
                {/* Progress arc — drains as elapsedFraction grows */}
                <circle
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke="rgb(251 191 36)"
                  strokeWidth={STROKE}
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={dashOffset}
                  style={{ transition: "stroke-dashoffset 250ms linear" }}
                />
              </svg>
              {/* Centered MM:SS readout overlaying the ring */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-lg font-bold font-mono text-amber-400">
                  {formatRemaining(remainingMs)}
                </span>
              </div>
            </div>
            {lockedByTimer && (
              <div className="text-[10px] text-muted-foreground mt-2">
                New entries locked until 0
              </div>
            )}
            {!tradeTimerSettings.lockoutUntilZero && tradeTimerSettings.autoCloseOnZero && (
              <div className="text-[10px] text-muted-foreground mt-2">
                Auto-close at 0
              </div>
            )}
          </div>
        );
      })()}

      <div className="border-t border-card-border" />

      {/* ─── Keyboard Shortcuts Reference ───────────────────── */}
      <div className="text-xs text-muted/40 space-y-0.5">
        <div>B = Buy Long &nbsp;|&nbsp; S = Sell Short</div>
        <div>X = Close Position</div>
      </div>
    </div>
  );
}
