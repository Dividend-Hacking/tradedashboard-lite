"use client";

/**
 * AlertBanner — Global, full-width banner that appears at the top of the
 * viewport whenever a price-cross alert fires. Mounted once at the root
 * layout so it shows regardless of which page the user is on.
 *
 * Architecture:
 *   - Subscribes to the module-level alert bus via `useAlertSubscription`.
 *   - Last-one-wins: a fresh alert replaces whatever is on screen.
 *   - Auto-dismisses after AUTO_DISMISS_MS; user can also click the × to
 *     dismiss immediately.
 *   - Plays a clear beep via the Web Audio API — no bundled audio file
 *     needed, works offline, and sidesteps browser autoplay policies
 *     because the user has necessarily interacted with the page
 *     (clicked to place the alert) before any audio is triggered.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAlertSubscription, type AlertEvent } from "@/hooks/use-alert-notifications";

const AUTO_DISMISS_MS = 8000;

/** Generate a short two-tone beep with the Web Audio API. Deliberately
 *  loud-ish and a little pulsed so it cuts through ambient sound without
 *  being grating. Silently no-ops if Web Audio is unavailable. */
function playAlertSound(): void {
  try {
    // Use a shared AudioContext across calls — creating a new one per
    // beep is cheap but not free, and some browsers limit concurrent
    // contexts.
    const w = window as unknown as {
      __alertAudioCtx?: AudioContext;
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    if (!w.__alertAudioCtx) w.__alertAudioCtx = new Ctor();
    const ctx = w.__alertAudioCtx;
    // Resume if the context was suspended (autoplay policy). The user's
    // click to place the alert is a valid user gesture, but the context
    // may have been created earlier in a suspended state.
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* noop */ });
    }

    const now = ctx.currentTime;
    // Three-tone chirp sequence — louder peak gain and longer sustain
    // than a simple ding so it cuts through background music. Each tone
    // layers a square-wave harmonic under the sine for extra brightness
    // without crossing into "alarm clock" territory.
    const schedule = (freq: number, start: number, duration: number) => {
      // Primary sine tone
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.85, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.05);
      // Harmonic triangle layer — adds bite so the beep carries over
      // music without just raising amplitude (which clips).
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "triangle";
      osc2.frequency.value = freq * 2;
      gain2.gain.setValueAtTime(0.0001, now + start);
      gain2.gain.exponentialRampToValueAtTime(0.25, now + start + 0.01);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(now + start);
      osc2.stop(now + start + duration + 0.05);
    };
    schedule(880, 0.00, 0.40);   // A5
    schedule(1175, 0.35, 0.40);  // D6
    schedule(1568, 0.70, 0.55);  // G6 — longer tail
  } catch { /* noop — sound is best-effort */ }
}

export default function AlertBanner() {
  const [event, setEvent] = useState<AlertEvent | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setEvent(null);
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  // Stable subscriber — replaces whatever is on screen, plays sound,
  // and schedules auto-dismiss.
  const onAlert = useCallback((ev: AlertEvent) => {
    setEvent(ev);
    playAlertSound();
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      setEvent(null);
      dismissTimerRef.current = null;
    }, AUTO_DISMISS_MS);
  }, []);

  useAlertSubscription(onAlert);

  // Clean up the pending auto-dismiss timer on unmount.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  if (!event) return null;

  const arrow = event.direction === "up" ? "\u2191" : "\u2193";
  const directionLabel = event.direction === "up" ? "crossed UP" : "crossed DOWN";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] w-[min(92vw,720px)]
                 bg-amber-500 text-zinc-950 border-2 border-amber-300
                 rounded-lg shadow-2xl px-5 py-4 flex items-center gap-4
                 animate-pulse"
    >
      <span className="text-3xl font-black leading-none">{arrow}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold uppercase tracking-wider opacity-80">
          Price Alert
        </div>
        <div className="text-lg font-bold truncate">
          {event.instrument} {directionLabel} {event.price.toFixed(2)}
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss alert"
        className="flex-none w-8 h-8 rounded-full bg-zinc-950/10 hover:bg-zinc-950/20
                   flex items-center justify-center text-xl font-bold leading-none"
      >
        &times;
      </button>
    </div>
  );
}
