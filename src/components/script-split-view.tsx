"use client";

/**
 * script-split-view.tsx — Resizable two-column layout for Script mode.
 *
 * When the user toggles into Script mode the dashboard renders the
 * existing UI (filters, results, charts, controls) on the LEFT and the
 * script editor + output panel on the RIGHT. The pane split is dragable
 * via a 6px gutter; the chosen ratio persists in localStorage so the
 * user's preferred layout sticks across reloads.
 *
 * Why no library: we need exactly one feature (a draggable divider with
 * persisted state) and Tailwind makes it a 50-line component. Adding
 * react-resizable-panels would mean ~15KB of bundle for a one-off use.
 *
 * Why pointer events (not mouse): pointer events handle touch + pen
 * naturally, and they fire on the gutter even after the pointer leaves
 * the gutter rect (because we capture on the window) — the legacy
 * mouse-event fallback isn't needed in any browser this app runs in.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "tradedashboard.scriptSplit";
const DEFAULT_LEFT_PCT = 60;
const MIN_LEFT_PCT = 30;
const MAX_LEFT_PCT = 80;

export interface ScriptSplitViewProps {
  left: React.ReactNode;
  right: React.ReactNode;
}

export function ScriptSplitView({ left, right }: ScriptSplitViewProps) {
  // Initialize from localStorage on mount. SSR can't read localStorage,
  // so we hydrate via useEffect to avoid a hydration mismatch warning.
  const [leftPct, setLeftPct] = useState<number>(DEFAULT_LEFT_PCT);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_LEFT_PCT && n <= MAX_LEFT_PCT) {
        setLeftPct(n);
      }
    }
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, pct));
    setLeftPct(clamped);
  }, []);

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // Persist the final ratio. We persist on release (not on every move)
    // to avoid hammering localStorage during a drag.
    if (typeof window !== "undefined") {
      // setLeftPct's last value is captured by closure on the next paint;
      // we just re-read the slot — cheaper than chaining a useEffect.
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          String(currentLeftPctRef.current)
        );
      } catch {
        // Quota / disabled storage — silent ignore.
      }
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [onPointerMove]);

  // Mirror the latest leftPct into a ref so `onPointerUp` can persist
  // the ACTUAL final value without depending on a stale closure.
  const currentLeftPctRef = useRef(leftPct);
  useEffect(() => {
    currentLeftPctRef.current = leftPct;
  }, [leftPct]);

  const onGutterPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      // Lock the cursor + suppress text-selection while dragging across
      // the rest of the UI (otherwise the user's drag selects every
      // char their cursor passes over).
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onPointerMove, onPointerUp]
  );

  return (
    <div
      ref={containerRef}
      className="flex flex-row min-h-0 flex-1 w-full gap-0"
      // Explicit height so each pane can scroll independently. The
      // parent caller is expected to pass a fixed-height (or
      // flex-bound) container.
      style={{ height: "100%" }}
    >
      <div
        className="overflow-y-auto pr-3"
        style={{ width: `${leftPct}%`, minWidth: 0 }}
      >
        {left}
      </div>
      <div
        // Gutter: 6px draggable strip. Hover gets a subtle accent so the
        // user discovers it; the col-resize cursor is the affordance.
        onPointerDown={onGutterPointerDown}
        className="w-1.5 cursor-col-resize bg-[#1e1e2a] hover:bg-[#2a2a3a] transition-colors flex-shrink-0"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(leftPct)}
        aria-valuemin={MIN_LEFT_PCT}
        aria-valuemax={MAX_LEFT_PCT}
        title="Drag to resize"
      />
      <div
        className="overflow-y-auto pl-3"
        style={{ width: `${100 - leftPct}%`, minWidth: 0 }}
      >
        {right}
      </div>
    </div>
  );
}
