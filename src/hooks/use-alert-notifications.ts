"use client";

/**
 * use-alert-notifications — Module-level pub/sub for price-cross alerts.
 *
 * The live-chart's RAF loop calls `triggerAlert(payload)` imperatively on a
 * price cross. The <AlertBanner /> mounted in the root layout subscribes via
 * `useAlertSubscription()` and renders the banner + plays the sound.
 *
 * Why a module-level bus (not React context):
 *  - The RAF loop runs outside React's render cycle and needs zero-latency
 *    fire-and-forget dispatch without crossing a context boundary.
 *  - The banner is a singleton at the root layout — there's never more
 *    than one subscriber in practice, so a context provider would add
 *    ceremony without benefit.
 *  - Keeps the alert pipeline usable from any component (e.g. future
 *    non-chart triggers) without requiring a provider wrap.
 */

import { useEffect } from "react";

/** Payload delivered to subscribers when an alert fires. */
export interface AlertEvent {
  /** Stable id — used by subscribers to dedupe if needed. */
  id: string;
  /** Instrument label (e.g. "NQ MAR25"). Falls back to "?" if unknown. */
  instrument: string;
  /** The alert-line price level that was crossed. */
  price: number;
  /** Direction of the cross: "up" = price moved from below → at/above level,
   *  "down" = price moved from above → at/below level. */
  direction: "up" | "down";
  /** Wall-clock ms when the cross was detected. */
  triggeredAt: number;
}

type Subscriber = (event: AlertEvent) => void;

// Module-scoped subscriber set. Lives for the lifetime of the tab.
const subscribers = new Set<Subscriber>();

/** Fire an alert. All active subscribers are notified synchronously.
 *  Call sites (RAF loop) expect this to be cheap — it is. */
export function triggerAlert(event: AlertEvent): void {
  for (const cb of subscribers) {
    try { cb(event); } catch { /* isolate one bad subscriber */ }
  }
}

/** React hook that subscribes the caller's callback for the duration of
 *  the component's lifetime. The callback is kept in a ref internally so
 *  consumers don't need to memoize it. */
export function useAlertSubscription(onAlert: Subscriber): void {
  useEffect(() => {
    subscribers.add(onAlert);
    return () => {
      subscribers.delete(onAlert);
    };
  }, [onAlert]);
}
