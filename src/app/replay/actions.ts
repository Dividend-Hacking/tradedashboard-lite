/**
 * Server Actions for the Practice Trading tool.
 *
 * Handles saving practice sessions and trades, requesting NT8 data
 * exports, saving zones, and managing session lifecycle. Backend-
 * agnostic via the Store layer — works against Supabase in cloud mode
 * and local SQLite in local mode.
 */

"use server";

import { getServerStore } from "@/lib/store/server";
import { INSTRUMENT_CONFIGS, getFrontMonth } from "@/lib/utils/futures";
import type { Granularity } from "@/types/replay";
import type {
  PracticeTradeInput,
  ZoneBarInput,
  NewDataRequest,
} from "@/lib/store/types";

/**
 * Save a completed practice session and all its trades. Two-phase insert:
 * session first (to get an id), then trades referencing it.
 */
export async function savePracticeSession(
  replaySessionId: number,
  trades: PracticeTradeInput[],
  totalPnl: number,
  winCount: number,
  lossCount: number,
  notes?: string
) {
  try {
    const store = await getServerStore();
    const { practiceSessionId } = await store.practice.saveSession(
      {
        replay_session_id: replaySessionId,
        total_pnl_points: totalPnl,
        win_count: winCount,
        loss_count: lossCount,
        notes: notes ?? null,
      },
      trades
    );
    return { success: true as const, practiceSessionId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Request a data export from NinjaTrader by inserting into the
 * data_requests queue. NT8's DataExporter polls every 15s and
 * processes pending rows. Dedupe is keyed on (instrument, timeframe,
 * session_date, granularity).
 */
export async function requestDataExport(
  instrument: string,
  timeframe: string,
  sessionDate: string,
  granularity: Granularity = "ohlcv"
) {
  try {
    const store = await getServerStore();

    const existing = await store.replay.findExistingSession(
      instrument,
      timeframe,
      sessionDate,
      granularity
    );
    if (existing) {
      return {
        error:
          "A session already exists for this instrument/timeframe/date/granularity",
      };
    }

    const pendingReq = await store.replay.findInFlightRequest(
      instrument,
      timeframe,
      sessionDate,
      granularity
    );
    if (pendingReq) {
      return {
        error: `A request is already ${pendingReq.status} for this combination`,
      };
    }

    const { id } = await store.replay.insertDataRequest({
      instrument,
      timeframe,
      session_date: sessionDate,
      granularity,
    });
    return { success: true as const, requestId: id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * CME equity-index futures full-day market holidays for 2024–2027.
 * Covers both fixed holidays (Jan 1, Jul 4, Dec 25 — observed Fri/Mon on weekend)
 * and floating holidays (MLK, Presidents, Good Friday, Memorial, Labor, Thanksgiving).
 */
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
  "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** Format a Date as a local-time YYYY-MM-DD string (no timezone drift). */
function formatIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Extract the root symbol from an instrument string. */
function getBaseSymbol(instrument: string): string {
  return instrument.split(" ")[0].trim();
}

/**
 * Pick a random un-downloaded weekday in the last 11 months and return
 * it along with the correct contract suffix for that historical date.
 */
export async function pickRandomDataDay(
  instrument: string,
  timeframe: string,
  granularity: Granularity = "ohlcv"
) {
  const base = getBaseSymbol(instrument);
  if (!base) return { error: "Instrument is required" };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowEnd = new Date(today);
  windowEnd.setDate(windowEnd.getDate() - 1);
  const windowStart = new Date(today);
  windowStart.setMonth(windowStart.getMonth() - 11);

  const windowStartStr = formatIsoDate(windowStart);
  const windowEndStr = formatIsoDate(windowEnd);

  try {
    const store = await getServerStore();
    const [sessionRows, pendingRows] = await Promise.all([
      store.replay.listSessionsForBaseInWindow(
        base,
        timeframe,
        granularity,
        windowStartStr,
        windowEndStr
      ),
      store.replay.listInFlightForBaseInWindow(
        base,
        timeframe,
        granularity,
        windowStartStr,
        windowEndStr
      ),
    ]);

    const taken = new Set<string>([
      ...sessionRows.map((r) => r.session_date),
      ...pendingRows.map((r) => r.session_date),
    ]);

    const candidates: string[] = [];
    const cursor = new Date(windowStart);
    while (cursor <= windowEnd) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) {
        const iso = formatIsoDate(cursor);
        if (!US_MARKET_HOLIDAYS.has(iso) && !taken.has(iso)) {
          candidates.push(iso);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    if (candidates.length === 0) {
      return {
        error: `No un-downloaded weekdays remain in the last 11 months for ${base} ${timeframe} (${granularity})`,
      };
    }

    const sessionDate = candidates[Math.floor(Math.random() * candidates.length)];
    const config = INSTRUMENT_CONFIGS.find((c) => c.symbol === base);
    const fullInstrument = config
      ? `${base} ${getFrontMonth(config.cycle, new Date(`${sessionDate}T12:00:00`))}`
      : instrument;

    return { success: true as const, instrument: fullInstrument, sessionDate };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bulk-request data exports for every market day in [startDate, endDate]
 * that we don't already have (or have queued) for this asset + timeframe.
 */
export async function requestDateRangeExport(
  instrument: string,
  timeframe: string,
  startDate: string,
  endDate: string,
  granularity: Granularity = "ohlcv"
) {
  const base = getBaseSymbol(instrument);
  if (!base) return { error: "Instrument is required" };
  if (!startDate || !endDate) return { error: "Both start and end dates are required" };
  if (startDate > endDate) return { error: "Start date must be on or before end date" };

  try {
    const store = await getServerStore();

    // Sweep first so any stuck `processing` rows from a prior NT8 crash
    // get reset to `pending` BEFORE we compute the gap set. Otherwise we'd
    // see them as "in flight" and skip those dates — which is exactly the
    // "entire months missing" symptom.
    await store.replay.recoverStaleRequests();

    const [sessionRows, pendingRows, failedRows, noDataRows] = await Promise.all([
      store.replay.listSessionsForBaseInWindow(
        base,
        timeframe,
        granularity,
        startDate,
        endDate
      ),
      store.replay.listInFlightForBaseInWindow(
        base,
        timeframe,
        granularity,
        startDate,
        endDate
      ),
      store.replay.listFailedForBaseInWindow(
        base,
        timeframe,
        granularity,
        startDate,
        endDate
      ),
      store.replay.listNoDataForBaseInWindow(
        base,
        timeframe,
        granularity,
        startDate,
        endDate
      ),
    ]);

    const alreadyHave = new Set<string>(sessionRows.map((r) => r.session_date));
    const inFlight = new Set<string>(pendingRows.map((r) => r.session_date));
    const noData = new Set<string>(noDataRows.map((r) => r.session_date));
    // Failed-terminal dates are NOT in `taken` — re-requesting a range
    // should refill them (transient failures may now succeed). We delete
    // them just before insert so the new rows land cleanly without
    // colliding with the unique partial index.
    //
    // `no_data` IS in `taken` — the broker confirmed those dates have no
    // bars. Re-requesting them is wasted work and adds noise to the
    // errored bucket again. User can clear them via the banner if they
    // want to retry.
    const taken = new Set<string>([...alreadyHave, ...inFlight, ...noData]);

    const start = new Date(`${startDate}T12:00:00`);
    const end = new Date(`${endDate}T12:00:00`);
    const targets: string[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) {
        const iso = formatIsoDate(cursor);
        if (!US_MARKET_HOLIDAYS.has(iso) && !taken.has(iso)) {
          targets.push(iso);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    // Re-queue failed-terminal rows whose dates fall in our target set.
    // (A row could be `error,retry_count=3` for a date that's also a holiday
    // or weekend in our calendar — leave those alone, drop the failed row
    // so it stops cluttering the banner. We re-queue only target dates.)
    const targetSet = new Set(targets);
    const failedToRequeue = failedRows.filter((r) => targetSet.has(r.session_date));
    let requeuedCount = 0;
    if (failedToRequeue.length > 0) {
      const { deleted } = await store.replay.deleteDataRequests(
        failedToRequeue.map((r) => r.id)
      );
      requeuedCount = deleted;
    }

    if (targets.length === 0) {
      return {
        success: true as const,
        queued: 0,
        requeued: 0,
        alreadyHave: alreadyHave.size,
        inFlight: inFlight.size,
        noData: noData.size,
        dates: [] as string[],
      };
    }

    const config = INSTRUMENT_CONFIGS.find((c) => c.symbol === base);
    const rows: NewDataRequest[] = targets.map((sessionDate) => {
      const fullInstrument = config
        ? `${base} ${getFrontMonth(config.cycle, new Date(`${sessionDate}T12:00:00`))}`
        : instrument;
      return {
        instrument: fullInstrument,
        timeframe,
        session_date: sessionDate,
        granularity,
      };
    });

    const { inserted } = await store.replay.insertDataRequestsBulk(rows);

    return {
      success: true as const,
      queued: inserted,
      requeued: requeuedCount,
      alreadyHave: alreadyHave.size,
      inFlight: inFlight.size,
      noData: noData.size,
      dates: targets,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Drop every `no_data` row so the next range request can re-attempt those
 * dates. Powers the "Clear no-data" banner button.
 */
export async function clearNoDataDataRequests() {
  try {
    const store = await getServerStore();
    const { cleared } = await store.replay.clearNoDataRequests();
    return { success: true as const, cleared };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reset every terminal-error row to pending. Powers the "Retry errored"
 * button in the queue banner. Returns count for the toast.
 */
export async function retryAllErroredDataRequests() {
  try {
    const store = await getServerStore();
    const { retried } = await store.replay.retryAllErrored();
    return { success: true as const, retried };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Save a practice zone to trade_zones / trade_zone_bars. Two-phase
 * insert: zone first (to get an id), then bars referencing it.
 */
export async function saveZone(
  instrument: string,
  direction: string,
  startTime: string,
  endTime: string,
  startPrice: number,
  endPrice: number,
  pointsMove: number,
  durationSeconds: number,
  chartTimeframe: string,
  bars: ZoneBarInput[],
  sectionId: number | null,
  slPrice: number | null = null,
  tpPrice: number | null = null,
  hitOutcome: "sl" | "tp" | null = null
) {
  try {
    const store = await getServerStore();
    const { zoneId } = await store.zones.saveZone(
      {
        instrument,
        direction,
        start_time: startTime,
        end_time: endTime,
        start_price: startPrice,
        end_price: endPrice,
        points_move: pointsMove,
        duration_seconds: durationSeconds,
        chart_timeframe: chartTimeframe,
        section_id: sectionId,
        sl_price: slPrice,
        tp_price: tpPrice,
        hit_outcome: hitOutcome,
      },
      bars
    );
    return { success: true as const, zoneId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Save the user's current playback position in a replay session. */
export async function saveReplayProgress(sessionId: number, lastBarIndex: number) {
  try {
    const store = await getServerStore();
    await store.replay.updateLastBarIndex(sessionId, lastBarIndex);
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete a replay session and all associated data (bars, practice
 * sessions, trades, tick blob). The Store layer handles the cascade
 * (single transaction in local mode, batched in cloud mode to fit
 * Supabase's 8s statement timeout).
 */
export async function deleteReplaySession(sessionId: number) {
  try {
    const store = await getServerStore();
    const result = await store.replay.deleteSessions([sessionId]);
    if (result.error) return { error: result.error };
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bulk-delete replay sessions. Returns the number actually removed so
 * the UI can confirm. The Store layer does the heavy lifting.
 */
export async function deleteReplaySessions(sessionIds: number[]) {
  if (sessionIds.length === 0) return { success: true as const, deleted: 0 };
  try {
    const store = await getServerStore();
    const result = await store.replay.deleteSessions(sessionIds);
    if (result.error) {
      return {
        error: `${result.error} (${result.deleted} session${result.deleted === 1 ? "" : "s"} already removed)`,
      };
    }
    return { success: true as const, deleted: result.deleted };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cancel a pending or processing data request. The row is hard-deleted
 * because NT8's DataExporter only ever looks for `status=eq.pending`
 * rows — removing it instantly takes the request off the queue. If NT8
 * is mid-fetch on a `processing` row, its eventual PATCH will hit a
 * missing row and silently fail (matches the existing catch-all in
 * DataExporter); the partial bars it may have already uploaded are not
 * cleaned up here, but no replay_session row is created on the cancel
 * path so they stay invisible.
 */
export async function cancelDataRequest(requestId: number) {
  try {
    const store = await getServerStore();
    await store.replay.deleteDataRequests([requestId]);
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Bulk-cancel — same semantics as cancelDataRequest, applied to a set
 *  of ids. Used when the user wants to clear a queued range in one go. */
export async function cancelDataRequests(requestIds: number[]) {
  if (requestIds.length === 0) return { success: true as const, deleted: 0 };
  try {
    const store = await getServerStore();
    const result = await store.replay.deleteDataRequests(requestIds);
    return { success: true as const, deleted: result.deleted };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a practice session and all its trades (cascade). */
export async function deletePracticeSession(practiceSessionId: number) {
  try {
    const store = await getServerStore();
    await store.practice.deleteSession(practiceSessionId);
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
