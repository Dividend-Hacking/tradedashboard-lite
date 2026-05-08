"use client";

/**
 * LiveTaggerPanel — Sidebar panel for grading, tagging, and noting trades
 * from inside the live trader.
 *
 * Web counterpart to ninjatrader/AddOns/TradeTagger.cs. Shares the same
 * dropdown options so values are consistent whether the user tags a trade
 * from NinjaTrader or from the web app (both write to the same `trades` row).
 *
 * Behavior:
 *  - Consumes the parent's `trades` array (already driving chart markers).
 *  - Starts on the newest trade and auto-jumps to new trades as they arrive —
 *    but only when the user was already watching the tail of the list, so
 *    notes-in-progress for an older trade aren't yanked away.
 *  - Edits autosave with a 500ms debounce via updateTradeTags. Prev/Next and
 *    unmount flush any pending save so edits are never lost.
 *  - Empty dropdown values clear the tag (null in the DB) — same semantics as
 *    TradeTagger.cs FormatJsonStringOrNull.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Trade, TradeBar } from "@/types/trade";
import { updateTradeTags } from "@/app/trade/actions";
import { getClientStore } from "@/lib/store";
import { useMode } from "@/components/mode-provider";
import TradeBarsChart from "./trade-bars-chart";

// Dropdown options — kept in sync with TradeTagger.cs:175–179 so web and
// NinjaTrader tagging produce identical values.
const GRADE_OPTIONS = ["", "A+", "A", "B", "C", "F"] as const;
const MISTAKE_OPTIONS = [
  "",
  "None",
  "Early Entry",
  "Late Entry",
  "Early Exit",
  "Late Exit",
  "Moved Stop",
  "Revenge Trade",
  "FOMO",
  "Oversized",
] as const;
const REGIME_OPTIONS = [
  "",
  "Trending",
  "Rangebound",
  "Consolidation",
  "Chop",
  "Breakout",
] as const;

// Matches SAVE_DEBOUNCE_MS in journal-panel.tsx.
const SAVE_DEBOUNCE_MS = 500;

interface LiveTaggerPanelProps {
  trades: Trade[];
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export default function LiveTaggerPanel({ trades }: LiveTaggerPanelProps) {
  const mode = useMode();

  // Which trade in `trades` is currently displayed. -1 when the list is empty.
  const [currentIndex, setCurrentIndex] = useState<number>(() =>
    trades.length > 0 ? trades.length - 1 : -1,
  );

  // Editable field state — controlled inputs, seeded from the trade row.
  const [grade, setGrade] = useState<string>("");
  const [mistake, setMistake] = useState<string>("");
  const [regime, setRegime] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [status, setStatus] = useState<SaveStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Trade bars viewer state — collapsed by default so the panel stays compact.
  // When expanded for a trade, we fetch that trade's rows from `trade_bars` once
  // and cache them keyed by trade_id so Prev/Next navigation doesn't re-fetch.
  const [showBars, setShowBars] = useState<boolean>(false);
  const [barsByTradeId, setBarsByTradeId] = useState<Record<number, TradeBar[]>>({});
  const [barsLoadingId, setBarsLoadingId] = useState<number | null>(null);
  const [barsError, setBarsError] = useState<string | null>(null);

  // Debounce state — kept in refs so changing them doesn't re-render.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<{
    trade_grade?: string | null;
    trade_mistake?: string | null;
    trade_regime?: string | null;
    notes?: string | null;
  }>({});
  const pendingTradeId = useRef<number | null>(null);

  // Guard that suppresses autosave triggers while we programmatically populate
  // fields during trade navigation. Mirrors _isLoadingTrade in TradeTagger.cs.
  const isLoadingTrade = useRef<boolean>(false);

  // Track the last length + last id so we can detect "a new trade arrived"
  // vs "an existing trade updated in place" without re-saving on every
  // realtime refresh.
  const prevTradesLen = useRef<number>(trades.length);
  const prevLastId = useRef<number | null>(
    trades.length > 0 ? trades[trades.length - 1].id : null,
  );

  const currentTrade: Trade | null =
    currentIndex >= 0 && currentIndex < trades.length
      ? trades[currentIndex]
      : null;

  // ─── Autosave helpers ────────────────────────────────────────────────

  /**
   * Fire the PATCH immediately if one is pending. Called before navigation
   * and on unmount so edits aren't dropped mid-debounce. Mirrors
   * FlushPendingSave in TradeTagger.cs:839.
   */
  const flushPendingSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const tradeId = pendingTradeId.current;
    const patch = pendingPatch.current;
    if (tradeId == null || Object.keys(patch).length === 0) return;
    pendingPatch.current = {};
    pendingTradeId.current = null;

    setStatus("saving");
    const result = await updateTradeTags(tradeId, patch);
    if (result.error) {
      setStatus("error");
      setErrorMsg(result.error);
    } else {
      setStatus("saved");
    }
  }, []);

  /** Queue a field change for autosave. Merges into the pending patch so
   *  editing Grade and Notes in quick succession results in one round-trip. */
  const scheduleSave = useCallback(
    (patch: {
      trade_grade?: string | null;
      trade_mistake?: string | null;
      trade_regime?: string | null;
      notes?: string | null;
    }) => {
      if (currentTrade == null) return;
      pendingTradeId.current = currentTrade.id;
      pendingPatch.current = { ...pendingPatch.current, ...patch };

      if (saveTimer.current) clearTimeout(saveTimer.current);
      setStatus("saving");
      saveTimer.current = setTimeout(async () => {
        saveTimer.current = null;
        const tradeId = pendingTradeId.current;
        const body = pendingPatch.current;
        if (tradeId == null || Object.keys(body).length === 0) return;
        pendingPatch.current = {};
        pendingTradeId.current = null;

        const result = await updateTradeTags(tradeId, body);
        if (result.error) {
          setStatus("error");
          setErrorMsg(result.error);
        } else {
          setStatus("saved");
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [currentTrade],
  );

  // ─── Populate fields when the displayed trade changes ────────────────

  useEffect(() => {
    // Guard so the setGrade/setNotes calls below don't trigger scheduleSave
    // — those handlers gate on isLoadingTrade.current.
    isLoadingTrade.current = true;
    if (currentTrade) {
      setGrade(currentTrade.trade_grade ?? "");
      setMistake(currentTrade.trade_mistake ?? "");
      setRegime(currentTrade.trade_regime ?? "");
      setNotes(currentTrade.notes ?? "");
      setStatus("idle");
      setErrorMsg(null);
    } else {
      setGrade("");
      setMistake("");
      setRegime("");
      setNotes("");
    }
    // Clear the guard on next microtask so user edits after this effect
    // proceed normally.
    queueMicrotask(() => {
      isLoadingTrade.current = false;
    });
  }, [currentTrade?.id]);

  // ─── Auto-nav when a new trade arrives ───────────────────────────────

  useEffect(() => {
    const newLen = trades.length;
    const newLastId = newLen > 0 ? trades[newLen - 1].id : null;
    const prevLen = prevTradesLen.current;
    const prevId = prevLastId.current;

    // Case 1: the array grew AND the tail id changed — a new trade was
    // appended. If the user was watching the previous tail (or nothing),
    // jump to the new trade. Otherwise leave them where they are.
    if (newLen > prevLen && newLastId !== prevId) {
      const wasOnTail = currentIndex === prevLen - 1 || currentIndex === -1;
      if (wasOnTail) {
        void flushPendingSave();
        setCurrentIndex(newLen - 1);
      }
    } else if (newLen > 0 && currentIndex === -1) {
      // Case 2: we had no trades, now we do — land on the newest.
      setCurrentIndex(newLen - 1);
    } else if (currentIndex >= newLen) {
      // Case 3: list shrank (e.g. DB Manager clear) — snap back in-bounds.
      setCurrentIndex(newLen > 0 ? newLen - 1 : -1);
    }

    prevTradesLen.current = newLen;
    prevLastId.current = newLastId;
  }, [trades, currentIndex, flushPendingSave]);

  // Flush any pending edit on unmount (e.g. tab switch, navigate away).
  useEffect(() => {
    return () => {
      void flushPendingSave();
    };
  }, [flushPendingSave]);

  // Lazy-fetch trade_bars when the viewer is expanded for a trade we haven't
  // loaded yet. Cancellation flag handles rapid Prev/Next while a fetch is in
  // flight — late arrivals just get dropped.
  useEffect(() => {
    if (!showBars || !currentTrade) return;
    const tradeId = currentTrade.id;
    if (barsByTradeId[tradeId] !== undefined) return;

    let cancelled = false;
    setBarsLoadingId(tradeId);
    setBarsError(null);

    (async () => {
      try {
        const store = getClientStore(mode);
        const data = await store.trades.listBarsForTrade(tradeId);
        if (cancelled) return;
        setBarsByTradeId((prev) => ({ ...prev, [tradeId]: data }));
      } catch (err) {
        if (cancelled) return;
        setBarsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setBarsLoadingId((id) => (id === tradeId ? null : id));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showBars, currentTrade, barsByTradeId, mode]);

  // ─── Navigation handlers ─────────────────────────────────────────────

  const goPrev = useCallback(async () => {
    if (currentIndex <= 0) return;
    await flushPendingSave();
    setCurrentIndex(currentIndex - 1);
  }, [currentIndex, flushPendingSave]);

  const goNext = useCallback(async () => {
    if (currentIndex >= trades.length - 1) return;
    await flushPendingSave();
    setCurrentIndex(currentIndex + 1);
  }, [currentIndex, trades.length, flushPendingSave]);

  // ─── Field change handlers ───────────────────────────────────────────

  const onGradeChange = (v: string) => {
    setGrade(v);
    if (isLoadingTrade.current) return;
    scheduleSave({ trade_grade: v });
  };
  const onMistakeChange = (v: string) => {
    setMistake(v);
    if (isLoadingTrade.current) return;
    scheduleSave({ trade_mistake: v });
  };
  const onRegimeChange = (v: string) => {
    setRegime(v);
    if (isLoadingTrade.current) return;
    scheduleSave({ trade_regime: v });
  };
  const onNotesChange = (v: string) => {
    setNotes(v);
    if (isLoadingTrade.current) return;
    scheduleSave({ notes: v });
  };

  // ─── Render ──────────────────────────────────────────────────────────

  const isOpen = currentTrade != null && currentTrade.exit_time == null;
  const pnl = currentTrade?.pnl_dollars ?? 0;
  const pnlPoints = currentTrade?.pnl_points ?? 0;
  const pnlColor =
    pnl > 0 ? "text-accent-green" : pnl < 0 ? "text-accent-red" : "text-muted";

  return (
    <div className="flex flex-col h-full bg-card border border-card-border rounded-lg p-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Trade Tagger
        </span>
        <span className="text-[11px] text-muted-foreground">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && (
            <span className="text-accent-red">Err: {errorMsg}</span>
          )}
          {status === "idle" && " "}
        </span>
      </div>

      {currentTrade == null ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
          No trades today
        </div>
      ) : (
        <>
          {/* Read-only trade summary */}
          <div className="space-y-1 mb-3 pb-3 border-b border-card-border">
            <div className="text-center font-semibold">
              {currentTrade.instrument} · {currentTrade.direction}
            </div>
            <div className="text-center text-xs text-muted-foreground">
              Entry {currentTrade.entry_price.toFixed(2)}
              {" · "}
              Exit{" "}
              {currentTrade.exit_price != null
                ? currentTrade.exit_price.toFixed(2)
                : "…"}
            </div>
            {isOpen ? (
              <div className="text-center text-xs font-semibold text-accent-blue">
                (OPEN)
              </div>
            ) : (
              <div
                className={`text-center text-xs font-semibold ${pnlColor}`}
              >
                {pnlPoints >= 0 ? "+" : ""}
                {pnlPoints.toFixed(2)} pts
                {" · "}
                {pnl >= 0 ? "+$" : "-$"}
                {Math.abs(pnl).toFixed(2)}
                {currentTrade.actual_rr != null && (
                  <> · {currentTrade.actual_rr.toFixed(2)}R</>
                )}
              </div>
            )}
            <div className="text-center text-[11px] text-muted-foreground">
              {new Date(currentTrade.entry_time).toLocaleTimeString()}
              {currentTrade.exit_time && (
                <>
                  {" — "}
                  {new Date(currentTrade.exit_time).toLocaleTimeString()}
                </>
              )}
            </div>
          </div>

          {/* Editable tag fields */}
          <div className="space-y-2">
            <Field label="Grade">
              <select
                value={grade}
                onChange={(e) => onGradeChange(e.target.value)}
                className="w-full bg-background border border-card-border rounded-md px-2 py-1 text-sm"
              >
                {GRADE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === "" ? "—" : opt}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Mistake">
              <select
                value={mistake}
                onChange={(e) => onMistakeChange(e.target.value)}
                className="w-full bg-background border border-card-border rounded-md px-2 py-1 text-sm"
              >
                {MISTAKE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === "" ? "—" : opt}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Regime">
              <select
                value={regime}
                onChange={(e) => onRegimeChange(e.target.value)}
                className="w-full bg-background border border-card-border rounded-md px-2 py-1 text-sm"
              >
                {REGIME_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === "" ? "—" : opt}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Notes">
              <textarea
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                rows={6}
                placeholder="What happened? What's the lesson?"
                className="w-full resize-y bg-background border border-card-border rounded-md px-2 py-1 text-sm focus:outline-none focus:border-white/30"
              />
            </Field>
          </div>

          {/* Trade bars viewer — lazy-fetches trade_bars when toggled open and
              renders a mini candlestick chart of the entry→exit window. */}
          <div className="mt-3 pt-3 border-t border-card-border">
            <button
              onClick={() => setShowBars((v) => !v)}
              className="w-full px-2 py-1 text-xs bg-background border border-card-border rounded-md hover:bg-white/5 text-left"
            >
              {showBars ? "▾ Hide Bars" : "▸ Show Bars"}
            </button>
            {showBars && (
              <div className="mt-2 h-[240px]">
                {(() => {
                  const cached = barsByTradeId[currentTrade.id];
                  if (barsError) {
                    return (
                      <div className="h-full flex items-center justify-center text-xs text-accent-red">
                        {barsError}
                      </div>
                    );
                  }
                  if (barsLoadingId === currentTrade.id && cached === undefined) {
                    return (
                      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                        Loading bars…
                      </div>
                    );
                  }
                  if (cached && cached.length === 0) {
                    return (
                      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                        No bars captured for this trade
                      </div>
                    );
                  }
                  if (cached && cached.length > 0) {
                    return <TradeBarsChart bars={cached} trade={currentTrade} />;
                  }
                  return null;
                })()}
              </div>
            )}
          </div>
        </>
      )}

      {/* Navigation footer */}
      <div className="mt-auto pt-3 border-t border-card-border flex items-center gap-2">
        <button
          onClick={() => void goPrev()}
          disabled={currentIndex <= 0}
          className="flex-1 px-2 py-1 text-xs bg-background border border-card-border rounded-md hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ‹ Prev
        </button>
        <span className="text-[11px] text-muted-foreground">
          {trades.length > 0
            ? `${currentIndex + 1} / ${trades.length}`
            : "0 / 0"}
        </span>
        <button
          onClick={() => void goNext()}
          disabled={currentIndex >= trades.length - 1}
          className="flex-1 px-2 py-1 text-xs bg-background border border-card-border rounded-md hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next ›
        </button>
      </div>
    </div>
  );
}

/** Labelled form field — uppercase caption + child input. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
