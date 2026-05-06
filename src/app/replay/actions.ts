/**
 * Server Actions for the Practice Trading tool.
 *
 * Handles saving practice sessions and trades to Supabase after
 * a practice session is completed or the user clicks "Save Session".
 */

"use server";

import { createClient } from "@/lib/supabase/server";
import { INSTRUMENT_CONFIGS, getFrontMonth } from "@/lib/utils/futures";

/** Data for a single practice trade (matches the practice_trades table schema) */
interface PracticeTradeInput {
  direction: string;
  entry_bar_index: number;
  entry_price: number;
  exit_bar_index: number | null;
  exit_price: number | null;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  pnl_points: number | null;
  exit_reason: string | null;
  entry_time: string;
  exit_time: string | null;
}

/**
 * Save a completed practice session and all its trades to Supabase.
 * Two-phase insert: session first (to get ID), then trades with FK.
 */
export async function savePracticeSession(
  replaySessionId: number,
  trades: PracticeTradeInput[],
  totalPnl: number,
  winCount: number,
  lossCount: number,
  notes?: string
) {
  const supabase = await createClient();

  // Phase 1: Insert practice session
  const { data: sessionData, error: sessionError } = await supabase
    .from("practice_sessions")
    .insert({
      replay_session_id: replaySessionId,
      ended_at: new Date().toISOString(),
      total_pnl_points: totalPnl,
      total_trades: trades.length,
      win_count: winCount,
      loss_count: lossCount,
      notes: notes || null,
    })
    .select("id")
    .single();

  if (sessionError || !sessionData) {
    return { error: sessionError?.message || "Failed to create practice session" };
  }

  const practiceSessionId = sessionData.id;

  // Phase 2: Insert all trades with the practice_session_id FK
  if (trades.length > 0) {
    const tradeRows = trades.map((t) => ({
      practice_session_id: practiceSessionId,
      ...t,
    }));

    const { error: tradesError } = await supabase
      .from("practice_trades")
      .insert(tradeRows);

    if (tradesError) {
      return { error: tradesError.message };
    }
  }

  return { success: true, practiceSessionId };
}

/**
 * Request a data export from NinjaTrader by inserting into data_requests.
 * NT8's DataExporter AddOn polls this table every 15s and processes pending requests.
 * Checks for existing sessions and in-flight requests to prevent duplicates.
 */
export async function requestDataExport(
  instrument: string,
  timeframe: string,
  sessionDate: string
) {
  const supabase = await createClient();

  // Check if a session already exists for this combination
  const { data: existing } = await supabase
    .from("replay_sessions")
    .select("id")
    .eq("instrument", instrument)
    .eq("timeframe", timeframe)
    .eq("session_date", sessionDate)
    .maybeSingle();

  if (existing) {
    return { error: "A session already exists for this instrument/timeframe/date" };
  }

  // Check for in-flight request
  const { data: pendingReq } = await supabase
    .from("data_requests")
    .select("id, status")
    .eq("instrument", instrument)
    .eq("timeframe", timeframe)
    .eq("session_date", sessionDate)
    .in("status", ["pending", "processing"])
    .maybeSingle();

  if (pendingReq) {
    return { error: `A request is already ${pendingReq.status} for this combination` };
  }

  const { data, error } = await supabase
    .from("data_requests")
    .insert({ instrument, timeframe, session_date: sessionDate })
    .select("id")
    .single();

  if (error) {
    return { error: error.message };
  }

  return { success: true, requestId: data.id };
}

/**
 * CME equity-index futures full-day market holidays for 2024–2027.
 * Covers both fixed holidays (Jan 1, Jul 4, Dec 25 — observed Fri/Mon on weekend)
 * and floating holidays (MLK, Presidents, Good Friday, Memorial, Labor, Thanksgiving).
 * Used to skip holidays when picking a random historical trading day.
 */
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2024
  "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
  "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
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

/**
 * Extract the root symbol from an instrument string.
 * "NQ 03-26" → "NQ"; "NQ" → "NQ".
 */
function getBaseSymbol(instrument: string): string {
  return instrument.split(" ")[0].trim();
}

/**
 * Pick a random un-downloaded weekday in the last 11 months for the given asset
 * and return it along with the correct contract suffix for that historical date.
 * This does NOT submit a request — the client pre-fills the form with the result
 * so the user can confirm before clicking "Request Data".
 *
 * Dedupe is done by root symbol (e.g. "NQ") across all contract suffixes, so
 * days already downloaded under a prior front-month contract aren't repicked.
 */
export async function pickRandomDataDay(
  instrument: string,
  timeframe: string
) {
  const base = getBaseSymbol(instrument);
  if (!base) {
    return { error: "Instrument is required" };
  }

  // Build the 11-month window: [today - 11 months, yesterday].
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowEnd = new Date(today);
  windowEnd.setDate(windowEnd.getDate() - 1);
  const windowStart = new Date(today);
  windowStart.setMonth(windowStart.getMonth() - 11);

  const windowStartStr = formatIsoDate(windowStart);
  const windowEndStr = formatIsoDate(windowEnd);

  const supabase = await createClient();

  // Fetch already-downloaded dates (any contract suffix for this root symbol).
  const { data: sessionRows, error: sessionsErr } = await supabase
    .from("replay_sessions")
    .select("session_date")
    .ilike("instrument", `${base} %`)
    .eq("timeframe", timeframe)
    .gte("session_date", windowStartStr)
    .lte("session_date", windowEndStr);

  if (sessionsErr) {
    return { error: sessionsErr.message };
  }

  // Also exclude any in-flight requests so rapid clicks don't double-queue.
  const { data: pendingRows, error: pendingErr } = await supabase
    .from("data_requests")
    .select("session_date")
    .ilike("instrument", `${base} %`)
    .eq("timeframe", timeframe)
    .in("status", ["pending", "processing"])
    .gte("session_date", windowStartStr)
    .lte("session_date", windowEndStr);

  if (pendingErr) {
    return { error: pendingErr.message };
  }

  const taken = new Set<string>([
    ...(sessionRows ?? []).map((r) => r.session_date as string),
    ...(pendingRows ?? []).map((r) => r.session_date as string),
  ]);

  // Enumerate weekdays in the window that aren't holidays and aren't taken.
  const candidates: string[] = [];
  const cursor = new Date(windowStart);
  while (cursor <= windowEnd) {
    const day = cursor.getDay(); // 0 = Sun, 6 = Sat
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
      error: `No un-downloaded weekdays remain in the last 11 months for ${base} ${timeframe}`,
    };
  }

  const sessionDate = candidates[Math.floor(Math.random() * candidates.length)];

  // Compute the correct contract suffix for the chosen date. For listed
  // instruments we know the cycle; for anything else we fall back to the
  // instrument string as-provided.
  const config = INSTRUMENT_CONFIGS.find((c) => c.symbol === base);
  const fullInstrument = config
    ? `${base} ${getFrontMonth(config.cycle, new Date(`${sessionDate}T12:00:00`))}`
    : instrument;

  return { success: true as const, instrument: fullInstrument, sessionDate };
}

/**
 * Bulk-request data exports for every market day in [startDate, endDate]
 * that we don't already have (or have queued) for this asset + timeframe.
 *
 * Skips weekends and US_MARKET_HOLIDAYS. Dedupes against existing
 * replay_sessions and in-flight data_requests by root symbol (so prior
 * front-month contract days for the same date aren't re-requested).
 *
 * For each remaining date, computes the correct front-month contract
 * suffix using INSTRUMENT_CONFIGS / getFrontMonth so a range that spans
 * a contract roll produces the right symbol per day.
 *
 * Returns counts so the UI can show "Queued N, skipped M".
 */
export async function requestDateRangeExport(
  instrument: string,
  timeframe: string,
  startDate: string,
  endDate: string
) {
  const base = getBaseSymbol(instrument);
  if (!base) {
    return { error: "Instrument is required" };
  }
  if (!startDate || !endDate) {
    return { error: "Both start and end dates are required" };
  }
  if (startDate > endDate) {
    return { error: "Start date must be on or before end date" };
  }

  const supabase = await createClient();

  // Already-downloaded dates within the range (any contract suffix for root).
  const { data: sessionRows, error: sessionsErr } = await supabase
    .from("replay_sessions")
    .select("session_date")
    .ilike("instrument", `${base} %`)
    .eq("timeframe", timeframe)
    .gte("session_date", startDate)
    .lte("session_date", endDate);

  if (sessionsErr) {
    return { error: sessionsErr.message };
  }

  // In-flight requests so we don't double-queue.
  const { data: pendingRows, error: pendingErr } = await supabase
    .from("data_requests")
    .select("session_date")
    .ilike("instrument", `${base} %`)
    .eq("timeframe", timeframe)
    .in("status", ["pending", "processing"])
    .gte("session_date", startDate)
    .lte("session_date", endDate);

  if (pendingErr) {
    return { error: pendingErr.message };
  }

  const alreadyHave = new Set<string>(
    (sessionRows ?? []).map((r) => r.session_date as string)
  );
  const inFlight = new Set<string>(
    (pendingRows ?? []).map((r) => r.session_date as string)
  );
  const taken = new Set<string>([...alreadyHave, ...inFlight]);

  // Enumerate weekdays in [start, end] that aren't holidays and aren't taken.
  // Use noon to avoid any DST-edge midnight issues when stepping by day.
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  const targets: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) {
      const iso = formatIsoDate(cursor);
      if (!US_MARKET_HOLIDAYS.has(iso) && !taken.has(iso)) {
        targets.push(iso);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (targets.length === 0) {
    return {
      success: true as const,
      queued: 0,
      alreadyHave: alreadyHave.size,
      inFlight: inFlight.size,
      dates: [] as string[],
    };
  }

  // Compute the correct contract suffix for each target date. For listed
  // instruments we know the cycle; for unknown roots we use the instrument
  // string as-provided (caller's responsibility to pick a sensible value).
  const config = INSTRUMENT_CONFIGS.find((c) => c.symbol === base);
  const rows = targets.map((sessionDate) => {
    const fullInstrument = config
      ? `${base} ${getFrontMonth(config.cycle, new Date(`${sessionDate}T12:00:00`))}`
      : instrument;
    return {
      instrument: fullInstrument,
      timeframe,
      session_date: sessionDate,
    };
  });

  const { error: insertErr } = await supabase
    .from("data_requests")
    .insert(rows);

  if (insertErr) {
    return { error: insertErr.message };
  }

  return {
    success: true as const,
    queued: targets.length,
    alreadyHave: alreadyHave.size,
    inFlight: inFlight.size,
    dates: targets,
  };
}

/** Data for a zone bar to save to trade_zone_bars */
interface ZoneBarInput {
  bar_time: string;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_volume: number;
  bar_index: number;
  mfe_from_start: number;
  mae_from_start: number;
  drawdown_from_entry: number;
  runup_from_entry: number;
  close_vs_entry: number;
  high_since_entry: number;
  retrace_from_peak: number;
}

/**
 * Save a practice zone to the trade_zones / trade_zone_bars tables.
 * This makes web-created zones appear in the existing Trade Zones dashboard.
 * Uses the same two-phase insert as NT8's TradeZoneWriter.
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
  const supabase = await createClient();

  // Phase 1: Insert zone metadata. section_id is nullable; UI treats NULL as
  // "default" but the practice UI always supplies the selected section id.
  // sl_price / tp_price / hit_outcome are all nullable — NT8-written zones
  // that predate the feature pass null for all three.
  const { data: zoneData, error: zoneError } = await supabase
    .from("trade_zones")
    .insert({
      instrument,
      direction,
      start_time: startTime,
      end_time: endTime,
      start_price: startPrice,
      end_price: endPrice,
      points_move: pointsMove,
      duration_seconds: durationSeconds,
      bar_count: bars.length,
      chart_timeframe: chartTimeframe,
      section_id: sectionId,
      sl_price: slPrice,
      tp_price: tpPrice,
      hit_outcome: hitOutcome,
    })
    .select("id")
    .single();

  if (zoneError || !zoneData) {
    return { error: zoneError?.message || "Failed to create zone" };
  }

  const zoneId = zoneData.id;

  // Phase 2: Insert all bars with the zone_id FK
  if (bars.length > 0) {
    const barRows = bars.map((b) => ({
      zone_id: zoneId,
      ...b,
    }));

    const { error: barsError } = await supabase
      .from("trade_zone_bars")
      .insert(barRows);

    if (barsError) {
      return { error: barsError.message };
    }
  }

  return { success: true, zoneId };
}

/**
 * Save the user's current playback position in a replay session.
 * Called on pause, unmount, and tab close so they can resume later.
 */
export async function saveReplayProgress(sessionId: number, lastBarIndex: number) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("replay_sessions")
    .update({ last_bar_index: lastBarIndex })
    .eq("id", sessionId);

  if (error) {
    return { error: error.message };
  }
  return { success: true };
}

/**
 * Delete a replay session and all associated data (bars, practice sessions, trades).
 * CASCADE FKs handle cleanup of replay_bars, practice_sessions, and practice_trades.
 */
export async function deleteReplaySession(sessionId: number) {
  const supabase = await createClient();

  // Detach any data_requests that reference this session (FK is NO ACTION, not CASCADE)
  const { error: detachError } = await supabase
    .from("data_requests")
    .update({ replay_session_id: null })
    .eq("replay_session_id", sessionId);

  if (detachError) {
    return { error: detachError.message };
  }

  // Now safe to delete — replay_bars and practice_sessions cascade automatically
  const { error } = await supabase
    .from("replay_sessions")
    .delete()
    .eq("id", sessionId);

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}

/**
 * Delete a practice session and all its trades (cascade).
 */
export async function deletePracticeSession(practiceSessionId: number) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("practice_sessions")
    .delete()
    .eq("id", practiceSessionId);

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}
