"use client";

/**
 * DataRequestForm — Inline form for requesting data exports from NinjaTrader.
 *
 * User enters instrument, timeframe, and date, then clicks "Request Data".
 * This inserts a row into data_requests table, which NT8's DataExporter
 * AddOn polls every 15 seconds.
 */

import { useState, useTransition, useCallback } from "react";
import {
  requestDataExport,
  pickRandomDataDay,
  requestDateRangeExport,
} from "@/app/replay/actions";
import type { Granularity } from "@/types/replay";

/**
 * Available data fetch modes. Each option encodes both granularity (what kind
 * of data NT8 will fetch) AND timeframe (the bar size for OHLCV modes; for
 * tick modes timeframe is just a descriptive string used in the UI / session
 * label). Encoding both into a single dropdown value keeps the UI from
 * representing invalid combos like "5m + bid/ask split".
 *
 * Format: `${granularity}:${timeframe}`. Parsed at change-time via split(":").
 */
const MODE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  group: string;
  granularity: Granularity;
  timeframe: string;
}> = [
  { value: "ohlcv:15 Second", label: "15s OHLCV", group: "OHLCV", granularity: "ohlcv", timeframe: "15 Second" },
  { value: "ohlcv:1 Minute",  label: "1m OHLCV",  group: "OHLCV", granularity: "ohlcv", timeframe: "1 Minute" },
  { value: "ohlcv:5 Minute",  label: "5m OHLCV",  group: "OHLCV", granularity: "ohlcv", timeframe: "5 Minute" },
  { value: "ohlcv:15 Minute", label: "15m OHLCV", group: "OHLCV", granularity: "ohlcv", timeframe: "15 Minute" },
  { value: "ohlcv_bidask:1 Second", label: "1s OHLCV + Bid/Ask Volume", group: "Bid/Ask split", granularity: "ohlcv_bidask", timeframe: "1 Second" },
  { value: "tick:Tick",         label: "Tick (every trade)",     group: "Tick", granularity: "tick",         timeframe: "Tick" },
  { value: "tick_bidask:Tick",  label: "Tick + Bid/Ask Side",    group: "Tick", granularity: "tick_bidask",  timeframe: "Tick" },
];

/** Default mode = the original behavior so existing users see no change. */
const DEFAULT_MODE_VALUE = "ohlcv:15 Second";

/** Resolve a mode value back to its (granularity, timeframe) parts. */
function parseMode(value: string): { granularity: Granularity; timeframe: string } {
  const found = MODE_OPTIONS.find((m) => m.value === value);
  if (found) return { granularity: found.granularity, timeframe: found.timeframe };
  // Fallback for any malformed value — shouldn't happen, but be safe.
  return { granularity: "ohlcv", timeframe: "15 Second" };
}

/**
 * Get the correct futures contract suffix (MM-YY) for a given date.
 * CME equity index futures (NQ, ES, etc.) have quarterly expirations:
 *   March (03), June (06), September (09), December (12)
 *
 * The active contract rolls ~2 weeks before expiration (3rd Friday of
 * contract month). We use the 15th as the cutoff for simplicity:
 *   - Before Mar 15 → 03 contract
 *   - Mar 15 to Jun 14 → 06 contract
 *   - Jun 15 to Sep 14 → 09 contract
 *   - Sep 15 to Dec 14 → 12 contract
 *   - Dec 15 onward → 03 contract of next year
 */
function getContractSuffix(dateStr: string): string {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const day = parseInt(dayStr);

  // Quarterly months and their cutoff: if past the 14th, roll to next contract
  const quarters = [
    { month: 3, label: "03" },
    { month: 6, label: "06" },
    { month: 9, label: "09" },
    { month: 12, label: "12" },
  ];

  let contractMonth = "";
  let contractYear = year;

  for (const q of quarters) {
    if (month < q.month || (month === q.month && day <= 14)) {
      contractMonth = q.label;
      break;
    }
  }

  // If no match, we're past Dec 14 → next year's March contract
  if (!contractMonth) {
    contractMonth = "03";
    contractYear = year + 1;
  }

  // Format year as 2-digit
  const yy = (contractYear % 100).toString().padStart(2, "0");
  return `${contractMonth}-${yy}`;
}

/**
 * Extract the base symbol from an instrument string.
 * "NQ 03-26" → "NQ", "NQ" → "NQ", "ES 12-25" → "ES"
 */
function getBaseSymbol(instrument: string): string {
  return instrument.split(" ")[0].trim();
}

/** UI mode: request a single day vs. a range of market days. */
type RequestMode = "single" | "range";

export default function DataRequestForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<RequestMode>("single");
  const [instrument, setInstrument] = useState("NQ 03-26");
  // `modeValue` encodes both granularity and timeframe — see MODE_OPTIONS.
  // We split it on submit rather than tracking two pieces of state so
  // invalid combinations (e.g. "5m + bid/ask") can't be represented.
  const [modeValue, setModeValue] = useState<string>(DEFAULT_MODE_VALUE);
  const { granularity, timeframe } = parseMode(modeValue);
  const [sessionDate, setSessionDate] = useState("");
  // Range-mode date inputs. Server recomputes the contract suffix per date,
  // so a range spanning a contract roll produces correct symbols per day.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  /** When date changes, auto-update the instrument contract suffix */
  const handleDateChange = useCallback((newDate: string) => {
    setSessionDate(newDate);
    if (newDate && instrument) {
      const base = getBaseSymbol(instrument);
      const suffix = getContractSuffix(newDate);
      setInstrument(`${base} ${suffix}`);
    }
  }, [instrument]);

  const handleSubmit = () => {
    if (!instrument.trim() || !sessionDate) {
      setMessage({ type: "error", text: "Fill in all fields" });
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await requestDataExport(instrument.trim(), timeframe, sessionDate, granularity);
      if (result.error) {
        setMessage({ type: "error", text: result.error });
      } else {
        setMessage({ type: "success", text: "Request submitted — NinjaTrader will process it shortly" });
        // Reset date so they can request another
        setSessionDate("");
      }
    });
  };

  /**
   * Range-mode submit: queue a data_requests row for every market day in
   * [startDate, endDate] that isn't already downloaded or in-flight. The
   * server computes the correct contract suffix per date, so a range that
   * straddles a contract roll still produces the right symbol each day.
   */
  const handleSubmitRange = () => {
    if (!instrument.trim() || !startDate || !endDate) {
      setMessage({ type: "error", text: "Fill in instrument, start date, and end date" });
      return;
    }
    if (startDate > endDate) {
      setMessage({ type: "error", text: "Start date must be on or before end date" });
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await requestDateRangeExport(
        instrument.trim(),
        timeframe,
        startDate,
        endDate,
        granularity
      );
      if ("error" in result) {
        setMessage({ type: "error", text: result.error });
        return;
      }
      const requeued = result.requeued ?? 0;
      const noDataSkipped = result.noData ?? 0;
      if (result.queued === 0 && requeued === 0) {
        setMessage({
          type: "success",
          text: `Nothing to do — ${result.alreadyHave} already downloaded, ${result.inFlight} in flight, ${noDataSkipped} no-data, rest are weekends/holidays`,
        });
      } else {
        const skipParts: string[] = [];
        if (result.alreadyHave > 0) skipParts.push(`${result.alreadyHave} already downloaded`);
        if (result.inFlight > 0) skipParts.push(`${result.inFlight} in flight`);
        if (noDataSkipped > 0) skipParts.push(`${noDataSkipped} known no-data`);
        const skipText = skipParts.length > 0 ? ` (skipped ${skipParts.join(", ")})` : "";
        // Distinguish brand-new pending rows from previously-failed rows
        // we just unstuck — gives the user confidence the gap-refill ran.
        const requeuedText = requeued > 0
          ? ` · ${requeued} previously-failed day${requeued === 1 ? "" : "s"} re-queued`
          : "";
        setMessage({
          type: "success",
          text: `Queued ${result.queued} day${result.queued === 1 ? "" : "s"}${requeuedText}${skipText} — NinjaTrader will process them in turn`,
        });
      }
    });
  };

  /**
   * Pick a random weekday from the last 11 months that we don't already have
   * for this asset + timeframe and pre-fill the form so the user can confirm
   * before submitting. The server action handles contract-suffix computation
   * for the chosen historical date.
   */
  const handleRandomDay = () => {
    const base = getBaseSymbol(instrument);
    if (!base) {
      setMessage({ type: "error", text: "Enter an instrument first" });
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await pickRandomDataDay(base, timeframe, granularity);
      if ("error" in result) {
        setMessage({ type: "error", text: result.error });
      } else {
        setInstrument(result.instrument);
        setSessionDate(result.sessionDate);
        setMessage({
          type: "success",
          text: `Picked ${result.instrument} on ${result.sessionDate} — review and click Request Data to confirm`,
        });
      }
    });
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="px-3 py-1.5 rounded text-sm bg-accent-green/20 text-accent-green
                   border border-accent-green/40 hover:bg-accent-green/30 transition-colors"
      >
        + Request New Data
      </button>
    );
  }

  // Range mode uses a 5-column grid (instrument + timeframe + start + end + submit).
  // Single mode keeps the original 4-column layout.
  const gridCols = mode === "range" ? "grid-cols-5" : "grid-cols-4";

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-foreground">Request Data from NinjaTrader</h3>
          {/* Mode toggle: single date vs. date range */}
          <div className="flex rounded border border-card-border overflow-hidden text-xs">
            <button
              onClick={() => { setMode("single"); setMessage(null); }}
              className={`px-2 py-1 transition-colors ${
                mode === "single"
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              Single Date
            </button>
            <button
              onClick={() => { setMode("range"); setMessage(null); }}
              className={`px-2 py-1 transition-colors ${
                mode === "range"
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              Date Range
            </button>
          </div>
        </div>
        <button
          onClick={() => { setIsOpen(false); setMessage(null); }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className={`grid ${gridCols} gap-3`}>
        {/* Instrument */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Instrument</label>
          <input
            type="text"
            value={instrument}
            onChange={(e) => setInstrument(e.target.value)}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm text-foreground focus:outline-none focus:border-muted"
          />
        </div>

        {/* Mode = granularity + timeframe in one selector. Grouped by category so
            it's clear which options are bid/ask-aware vs tick-level. The value
            stored is `granularity:timeframe`; see parseMode() above. */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Mode</label>
          <select
            value={modeValue}
            onChange={(e) => setModeValue(e.target.value)}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm text-foreground focus:outline-none focus:border-muted"
          >
            <optgroup label="OHLCV (existing)">
              {MODE_OPTIONS.filter((m) => m.group === "OHLCV").map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </optgroup>
            <optgroup label="Bid/Ask volume split">
              {MODE_OPTIONS.filter((m) => m.group === "Bid/Ask split").map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </optgroup>
            <optgroup label="Tick (last ~6 months only)">
              {MODE_OPTIONS.filter((m) => m.group === "Tick").map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </optgroup>
          </select>
        </div>

        {mode === "single" ? (
          // Single-date input — auto-updates instrument contract suffix on change.
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Date</label>
            <input
              type="date"
              value={sessionDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full bg-background border border-card-border rounded px-2 py-1.5
                         text-sm text-foreground focus:outline-none focus:border-muted"
            />
          </div>
        ) : (
          // Range inputs — server computes per-date contract suffix.
          <>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-background border border-card-border rounded px-2 py-1.5
                           text-sm text-foreground focus:outline-none focus:border-muted"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-background border border-card-border rounded px-2 py-1.5
                           text-sm text-foreground focus:outline-none focus:border-muted"
              />
            </div>
          </>
        )}

        {/* Submit column — buttons differ by mode */}
        <div className="flex items-end flex-col gap-1.5">
          {mode === "single" ? (
            <>
              <button
                onClick={handleSubmit}
                disabled={isPending}
                className="w-full py-1.5 rounded text-sm font-medium bg-accent-green/20 text-accent-green
                           border border-accent-green/40 hover:bg-accent-green/30
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isPending ? "Requesting..." : "Request Data"}
              </button>
              <button
                onClick={handleRandomDay}
                disabled={isPending}
                title="Pick a random un-downloaded weekday from the last 11 months"
                className="w-full py-1.5 rounded text-sm font-medium bg-accent-blue/20 text-accent-blue
                           border border-accent-blue/40 hover:bg-accent-blue/30
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                🎲 Random Day
              </button>
            </>
          ) : (
            <button
              onClick={handleSubmitRange}
              disabled={isPending}
              title="Queue every market day in the range that isn't already downloaded"
              className="w-full py-1.5 rounded text-sm font-medium bg-accent-green/20 text-accent-green
                         border border-accent-green/40 hover:bg-accent-green/30
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? "Queueing..." : "Request Range"}
            </button>
          )}
        </div>
      </div>

      {/* Status message */}
      {message && (
        <p className={`mt-2 text-xs ${
          message.type === "success" ? "text-accent-green" : "text-accent-red"
        }`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
