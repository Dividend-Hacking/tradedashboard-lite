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
  const [timeframe, setTimeframe] = useState("15 Second");
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
      const result = await requestDataExport(instrument.trim(), timeframe, sessionDate);
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
        endDate
      );
      if ("error" in result) {
        setMessage({ type: "error", text: result.error });
        return;
      }
      if (result.queued === 0) {
        setMessage({
          type: "success",
          text: `Nothing to do — ${result.alreadyHave} already downloaded, ${result.inFlight} in flight, rest are weekends/holidays`,
        });
      } else {
        const skipParts: string[] = [];
        if (result.alreadyHave > 0) skipParts.push(`${result.alreadyHave} already downloaded`);
        if (result.inFlight > 0) skipParts.push(`${result.inFlight} in flight`);
        const skipText = skipParts.length > 0 ? ` (skipped ${skipParts.join(", ")})` : "";
        setMessage({
          type: "success",
          text: `Queued ${result.queued} day${result.queued === 1 ? "" : "s"}${skipText} — NinjaTrader will process them in turn`,
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
      const result = await pickRandomDataDay(base, timeframe);
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

        {/* Timeframe */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Timeframe</label>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="w-full bg-background border border-card-border rounded px-2 py-1.5
                       text-sm text-foreground focus:outline-none focus:border-muted"
          >
            <option value="15 Second">15 Second</option>
            <option value="1 Minute">1 Minute</option>
            <option value="5 Minute">5 Minute</option>
            <option value="15 Minute">15 Minute</option>
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
