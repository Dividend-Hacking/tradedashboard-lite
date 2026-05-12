/**
 * Tick aggregation utilities — pure JS, no React, no server-side imports.
 *
 * Pipeline:
 *   1. `decompressGzip(ArrayBuffer)` — turn a gzipped CSV blob into text.
 *   2. `parseTickCsv(text)` — turn text into typed arrays of ticks. Typed
 *      arrays cut memory ~5x vs. an Array<{...}> of plain objects (an 8M-tick
 *      day fits in ~100 MB instead of ~1 GB) and make the aggregation loop
 *      ~3-5x faster because there's no per-element property dispatch.
 *   3. `aggregateTicks(ticks, mode, sessionId)` — collapse ticks into the
 *      `ReplayBar[]` shape the existing `ReplayChart` already renders. Two
 *      bucket strategies are supported:
 *        - time-based   (e.g. 24-second bars)
 *        - tick-count   (e.g. 100-tick bars)
 *
 * The output bars match the `ReplayBar` interface exactly, including
 * `id`/`session_id`/`bar_index` (synthetic — chart only uses `bar_index` for
 * keying so any unique values work) and the `bar_volume_bid`/`bar_volume_ask`
 * delta columns introduced for `ohlcv_bidask` mode (so the chart's volume
 * indicator and any future delta overlays can read them uniformly).
 */

import type { ReplayBar } from "@/types/replay";

/** Tick stream stored as parallel typed arrays for memory + speed. */
export type ParsedTicks = {
  count: number;
  /** Tick timestamps in milliseconds since epoch (Unix UTC). */
  times: Float64Array;
  /** Trade prices. */
  prices: Float64Array;
  /** Trade sizes (contracts). */
  sizes: Int32Array;
  /**
   * Aggressor side encoded compactly:
   *   0 = unattributed/null
   *   1 = bid (sell-aggressor — trade hit the bid)
   *   2 = ask (buy-aggressor — trade lifted the ask)
   */
  sides: Uint8Array;
  /**
   * Best-bid price at the moment of the trade (NaN if unknown — either the
   * blob predates the v2 quote columns, or the trade fired before any
   * bid quote event was observed in the day).
   */
  bestBids: Float64Array;
  /** Best-ask price at the moment of the trade (NaN if unknown). */
  bestAsks: Float64Array;
  /** Best-bid size at the moment of the trade (0 if unknown). */
  bestBidSizes: Int32Array;
  /** Best-ask size at the moment of the trade (0 if unknown). */
  bestAskSizes: Int32Array;
  /**
   * True when the source CSV included the top-of-book quote columns
   * (best_bid, best_ask, best_bid_size, best_ask_size). False for legacy
   * 5-column blobs — in that case the four quote typed arrays are still
   * allocated, but they are filled with NaN/0 and indicators that depend
   * on them will yield NaN.
   */
  hasQuotes: boolean;
};

/** How to bucket ticks into bars. */
export type AggregationMode =
  | { kind: "time"; seconds: number }
  | { kind: "ticks"; count: number };

// ─── Decompression ─────────────────────────────────────────────────────────

/**
 * Decompress a gzipped buffer to text using the browser's native
 * `DecompressionStream`. Available in Chrome 80+, Firefox 113+, Safari 16.4+,
 * Edge 80+. No JS-side gzip dependency required.
 */
export async function decompressGzip(gz: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([gz]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

// ─── CSV Parsing ───────────────────────────────────────────────────────────

/** Side string → Uint8 encoding used in `ParsedTicks.sides`. */
function encodeSide(s: string): number {
  // Cheap branch — the side field is always one of {"", "bid", "ask"} from
  // our NT8 writer. We don't bother lowercasing because we control both
  // ends of the wire format.
  if (s.length === 0) return 0;
  if (s === "bid") return 1;
  if (s === "ask") return 2;
  return 0;
}

/**
 * Parse the tick CSV produced by `DataExporter.cs ProcessTickRequest`.
 *
 * Two schema versions are supported and detected automatically by sniffing
 * the header row:
 *   v1 (legacy, 5 cols):
 *     `tick_index,tick_time,price,size,side\n`
 *     `0,2026-04-15T13:30:00.123,18234.5000,3,ask\n`
 *   v2 (with top-of-book quotes, 9 cols):
 *     `tick_index,tick_time,price,size,side,best_bid,best_ask,best_bid_size,best_ask_size\n`
 *     `0,2026-04-15T13:30:00.123,18234.5000,3,ask,18234.2500,18234.5000,40,12\n`
 *
 * For v1 blobs the `bestBids`/`bestAsks` arrays are still allocated (same
 * length as everything else) and filled with `NaN`; the size arrays are
 * filled with `0`. The `hasQuotes` flag on the result tells callers/
 * indicators whether the quote columns are meaningful.
 *
 * We deliberately avoid `String.split('\n')` and `String.split(',')` because
 * for a 5M-tick day those would allocate ~25M intermediate strings. Instead
 * we walk the input once with `indexOf` to find line and field boundaries,
 * and slice + parse only what we need.
 *
 * The schema is fixed (no quoting / escaping), so we can hard-code field
 * positions instead of running a generic CSV state machine.
 */
export function parseTickCsv(text: string): ParsedTicks {
  // First pass: count newlines so we can pre-allocate exactly the right
  // typed-array length. One alloc per array beats growing them.
  // The header line gets counted here too; we subtract one below.
  let lineCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineCount++;
  }
  // If the file doesn't end with \n, the final line still counts.
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) {
    lineCount++;
  }
  // Subtract the header row.
  const dataRowEstimate = Math.max(0, lineCount - 1);

  // Sniff the header to decide whether the new quote columns are present.
  // v1 = 5 fields → 4 commas. v2 = 9 fields → 8 commas. Counting commas in
  // the first line is cheaper than a split.
  const firstNl = text.indexOf("\n");
  const headerEnd = firstNl === -1 ? text.length : firstNl;
  let headerCommas = 0;
  for (let i = 0; i < headerEnd; i++) {
    if (text.charCodeAt(i) === 44 /* ',' */) headerCommas++;
  }
  const hasQuotes = headerCommas >= 8;

  const times = new Float64Array(dataRowEstimate);
  const prices = new Float64Array(dataRowEstimate);
  const sizes = new Int32Array(dataRowEstimate);
  const sides = new Uint8Array(dataRowEstimate);
  const bestBids = new Float64Array(dataRowEstimate);
  const bestAsks = new Float64Array(dataRowEstimate);
  const bestBidSizes = new Int32Array(dataRowEstimate);
  const bestAskSizes = new Int32Array(dataRowEstimate);
  // For v1 blobs we want the price arrays to read as "unknown" (NaN), not 0.
  // Int32Array default of 0 is already correct for the size arrays.
  if (!hasQuotes) {
    bestBids.fill(NaN);
    bestAsks.fill(NaN);
  }

  let pos = 0;
  let isHeader = true;
  let written = 0;

  while (pos < text.length) {
    // Find end of current line.
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;

    if (isHeader) {
      isHeader = false;
      pos = nl + 1;
      continue;
    }

    // Skip blank lines (e.g. trailing newline produces an empty final line).
    if (nl === pos) {
      pos = nl + 1;
      continue;
    }

    // Locate the first 5 commas (shared by both v1 and v2).
    const c1 = text.indexOf(",", pos);
    if (c1 === -1 || c1 >= nl) { pos = nl + 1; continue; } // malformed → skip
    const c2 = text.indexOf(",", c1 + 1);
    if (c2 === -1 || c2 >= nl) { pos = nl + 1; continue; }
    const c3 = text.indexOf(",", c2 + 1);
    if (c3 === -1 || c3 >= nl) { pos = nl + 1; continue; }
    const c4 = text.indexOf(",", c3 + 1);
    if (c4 === -1 || c4 >= nl) { pos = nl + 1; continue; }

    // tick_index (c0..c1) — we don't store it explicitly; the array index IS
    // the tick index. Skip.
    const timeStr = text.substring(c1 + 1, c2);
    const priceStr = text.substring(c2 + 1, c3);
    const sizeStr = text.substring(c3 + 1, c4);

    // `side` ends at the next comma (v2) or the end of the line (v1).
    let sideEnd: number;
    let c5 = -1, c6 = -1, c7 = -1, c8 = -1;
    if (hasQuotes) {
      c5 = text.indexOf(",", c4 + 1);
      if (c5 === -1 || c5 >= nl) { pos = nl + 1; continue; }
      c6 = text.indexOf(",", c5 + 1);
      if (c6 === -1 || c6 >= nl) { pos = nl + 1; continue; }
      c7 = text.indexOf(",", c6 + 1);
      if (c7 === -1 || c7 >= nl) { pos = nl + 1; continue; }
      c8 = text.indexOf(",", c7 + 1);
      if (c8 === -1 || c8 >= nl) { pos = nl + 1; continue; }
      sideEnd = c5;
    } else {
      sideEnd = nl;
    }
    const sideStr = text.substring(c4 + 1, sideEnd);

    // Parse timestamp. Format from NT8: yyyy-MM-ddTHH:mm:ss.fff
    // We need ms epoch. `Date.parse` understands ISO; treat the string as
    // UTC because we wrote it locally without a TZ suffix and want the chart
    // to mirror the wall-clock timestamp the user saw on NT8 — same trick
    // `parseRawTimestamp` uses for stored bar timestamps.
    const t = parseIsoLocalToMs(timeStr);
    const p = +priceStr;
    const sz = +sizeStr;

    // Defensive: if any numeric parse fails, skip the row rather than
    // poisoning the typed arrays with NaN.
    if (!isFinite(t) || !isFinite(p) || !isFinite(sz)) {
      pos = nl + 1;
      continue;
    }

    times[written] = t;
    prices[written] = p;
    sizes[written] = sz | 0;
    sides[written] = encodeSide(sideStr);

    if (hasQuotes) {
      // Empty quote field means "no quote event observed yet on this day"
      // (writer leaves them blank rather than emitting 0 or NaN). Map empty
      // → NaN for prices, 0 for sizes.
      const bbStr = text.substring(c5 + 1, c6);
      const baStr = text.substring(c6 + 1, c7);
      const bbszStr = text.substring(c7 + 1, c8);
      const baszStr = text.substring(c8 + 1, nl);
      bestBids[written]     = bbStr.length === 0 ? NaN : +bbStr;
      bestAsks[written]     = baStr.length === 0 ? NaN : +baStr;
      bestBidSizes[written] = bbszStr.length === 0 ? 0  : (+bbszStr) | 0;
      bestAskSizes[written] = baszStr.length === 0 ? 0  : (+baszStr) | 0;
    }

    written++;
    pos = nl + 1;
  }

  // If we skipped any malformed rows, the typed arrays have unused tail
  // slots. Slice down to the actual count so callers see clean data.
  if (written === dataRowEstimate) {
    return {
      count: written, times, prices, sizes, sides,
      bestBids, bestAsks, bestBidSizes, bestAskSizes, hasQuotes,
    };
  }
  return {
    count: written,
    times: times.slice(0, written),
    prices: prices.slice(0, written),
    sizes: sizes.slice(0, written),
    sides: sides.slice(0, written),
    bestBids: bestBids.slice(0, written),
    bestAsks: bestAsks.slice(0, written),
    bestBidSizes: bestBidSizes.slice(0, written),
    bestAskSizes: bestAskSizes.slice(0, written),
    hasQuotes,
  };
}

/**
 * Parse an ISO-style timestamp string (yyyy-MM-ddTHH:mm:ss[.fff]) into ms
 * epoch, treating the input as if it were UTC. We don't go via `new Date()`
 * because:
 *   1. Browser `Date.parse` is allowed to interpret no-TZ strings as either
 *      local or UTC depending on format — too lazy and inconsistent for
 *      typed-array hot-path code.
 *   2. The NT8 writer doesn't include a timezone, and the chart expects
 *      timestamps that mirror the wall clock on the user's NT8 instance.
 *
 * Format is fixed and we control both ends; a hand-rolled parse is the
 * fastest option (called once per tick, 5M+ times for a busy day).
 */
function parseIsoLocalToMs(s: string): number {
  // Expected: "YYYY-MM-DDTHH:MM:SS.fff" (23 chars) or "YYYY-MM-DDTHH:MM:SS" (19).
  // Hand-parse via charCodeAt to skip allocation.
  if (s.length < 19) return NaN;
  const year   = +s.substring(0, 4);
  const month  = +s.substring(5, 7);
  const day    = +s.substring(8, 10);
  const hour   = +s.substring(11, 13);
  const minute = +s.substring(14, 16);
  const second = +s.substring(17, 19);
  let ms = 0;
  if (s.length >= 23 && s.charCodeAt(19) === 46 /* '.' */) {
    ms = +s.substring(20, 23);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

// ─── Aggregation ───────────────────────────────────────────────────────────

/** Format a ms-epoch timestamp as `YYYY-MM-DDTHH:MM:SS` (matches what
 *  `parseRawTimestamp` in src/lib/utils/format.ts expects). The chart's
 *  `barToCandle` runs `rawTimestampToUnix(bar.bar_time)` so the produced
 *  string MUST round-trip cleanly through that helper. We use the UTC
 *  components because that's how `parseIsoLocalToMs` packed them. */
function msToIso(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm   = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd   = d.getUTCDate().toString().padStart(2, "0");
  const hh   = d.getUTCHours().toString().padStart(2, "0");
  const mi   = d.getUTCMinutes().toString().padStart(2, "0");
  const ss   = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

/**
 * Aggregate a tick stream into ReplayBar-shaped candles.
 *
 * Both modes use a single forward pass with no nested allocations — the
 * entire input is walked once, emitting a new bar whenever the bucket key
 * changes. Time mode keys by floor(time / periodMs); tick-count mode keys
 * by floor(i / N).
 *
 * Volume math:
 *   bar_volume     = Σ sizes
 *   bar_volume_bid = Σ sizes where side == 1 (sell-aggressor)
 *   bar_volume_ask = Σ sizes where side == 2 (buy-aggressor)
 *
 * For tick sessions where the data feed didn't classify side (the Kinetick
 * quote-stream gotcha — most ticks come back with side=0), bid/ask volumes
 * stay at 0. The chart still renders fine; delta indicators just won't
 * show meaningful values.
 */
export function aggregateTicks(
  ticks: ParsedTicks,
  mode: AggregationMode,
  sessionId: number,
): ReplayBar[] {
  return aggregateTicksWithRanges(ticks, mode, sessionId).bars;
}

/** Result of {@link aggregateTicksWithRanges}. `tickRanges` is a packed
 *  Int32Array of length `2 * bars.length` — `[startN, endN)` half-open
 *  index pairs into the source `ParsedTicks` for each emitted bar.
 *
 *  Why packed instead of `{ start, end }[]`: tick-driven indicators
 *  (volume profile POC/VAH/VAL, vwap_tick, large-trade counts) walk
 *  this on every bar of every zone — keeping the data in a single
 *  contiguous typed array avoids per-bar object allocation and lets
 *  the JIT keep the loop tight. Memory is trivial: 8 bytes per bar
 *  (~80 KB for 10k bars). */
export interface AggregatedTicksResult {
  bars: ReplayBar[];
  /** Packed `[start0, end0, start1, end1, ...]` with `endN` exclusive.
   *  Length = `2 * bars.length`. */
  tickRanges: Int32Array;
}

/**
 * Same aggregation as {@link aggregateTicks} but also returns a packed
 * Int32Array mapping each emitted bar to its half-open tick range
 * `[start, end)` in the source `ParsedTicks`. Tick-driven indicators
 * (rolling volume-profile POC/VAH/VAL, true VWAP from ticks, large-trade
 * detection) need to know which raw ticks fed each bar to compute values
 * over a multi-bar window without walking the entire tick stream every
 * time.
 */
export function aggregateTicksWithRanges(
  ticks: ParsedTicks,
  mode: AggregationMode,
  sessionId: number,
): AggregatedTicksResult {
  const N = ticks.count;
  if (N === 0) return { bars: [], tickRanges: new Int32Array(0) };

  // Validate mode params defensively — UI does the same but the utility
  // shouldn't blow up if a caller passes garbage.
  if (mode.kind === "time" && (!isFinite(mode.seconds) || mode.seconds <= 0)) {
    return { bars: [], tickRanges: new Int32Array(0) };
  }
  if (mode.kind === "ticks" && (!Number.isInteger(mode.count) || mode.count <= 0)) {
    return { bars: [], tickRanges: new Int32Array(0) };
  }

  const out: ReplayBar[] = [];
  // Worst case is one bar per tick (e.g. tick-mode with count=1). Pre-
  // allocate to that ceiling and slice down at the end — cheaper than
  // growing the array via push(). Two slots per bar, so 2*N max.
  const ranges = new Int32Array(2 * N);
  const { times, prices, sizes, sides } = ticks;

  // State of the bar currently being accumulated. We use plain locals
  // instead of an object to avoid per-tick allocation.
  let curKey = -Infinity;       // bucket key for the current bar
  let curOpen = 0;
  let curHigh = 0;
  let curLow = 0;
  let curClose = 0;
  let curVol = 0;
  let curBidVol = 0;
  let curAskVol = 0;
  let curStartMs = 0;           // bar start time in ms (used for bar_time)
  let curStartTickIdx = 0;      // first tick contributing to current bar
  let barIndex = 0;

  // Lightweight-charts requires strictly ascending integer-second timestamps.
  // In tick-count mode, many trades can fall inside the same second during
  // fast bursts, which means consecutive buckets can have *identical*
  // first-tick timestamps (e.g. ticks 0..99 and 100..199 both happen in one
  // second of the open). We track the last emitted second here and bump
  // duplicates forward by 1s to preserve order. This slightly distorts the
  // time axis during bursts but keeps the chart from throwing
  // "data must be asc ordered by time".
  let lastEmittedSec = -Infinity;

  /** Emit the in-progress bar to `out`. Called when the bucket key changes
   *  or when we finish the loop. `endTickIdx` is exclusive — the index
   *  of the first tick that does NOT belong to this bar. */
  const flush = (endTickIdx: number) => {
    let startMs = curStartMs;
    let startSec = Math.floor(startMs / 1000);
    if (startSec <= lastEmittedSec) {
      startSec = lastEmittedSec + 1;
      startMs = startSec * 1000;
    }
    lastEmittedSec = startSec;

    out.push({
      id: barIndex,             // synthetic; chart doesn't use this for keying
      session_id: sessionId,
      bar_index: barIndex,
      bar_time: msToIso(startMs),
      bar_open: curOpen,
      bar_high: curHigh,
      bar_low: curLow,
      bar_close: curClose,
      bar_volume: curVol,
      bar_volume_bid: curBidVol,
      bar_volume_ask: curAskVol,
    });
    ranges[barIndex * 2] = curStartTickIdx;
    ranges[barIndex * 2 + 1] = endTickIdx;
    barIndex++;
  };

  if (mode.kind === "time") {
    const periodMs = mode.seconds * 1000;
    for (let i = 0; i < N; i++) {
      const t = times[i];
      const bucket = Math.floor(t / periodMs);
      if (bucket !== curKey) {
        if (curKey !== -Infinity) flush(i);
        curKey = bucket;
        curStartMs = bucket * periodMs;
        curStartTickIdx = i;
        curOpen = prices[i];
        curHigh = prices[i];
        curLow = prices[i];
        curClose = prices[i];
        curVol = sizes[i];
        curBidVol = sides[i] === 1 ? sizes[i] : 0;
        curAskVol = sides[i] === 2 ? sizes[i] : 0;
      } else {
        const p = prices[i];
        if (p > curHigh) curHigh = p;
        if (p < curLow) curLow = p;
        curClose = p;
        curVol += sizes[i];
        if (sides[i] === 1) curBidVol += sizes[i];
        else if (sides[i] === 2) curAskVol += sizes[i];
      }
    }
  } else {
    const M = mode.count;
    for (let i = 0; i < N; i++) {
      const bucket = Math.floor(i / M);
      if (bucket !== curKey) {
        if (curKey !== -Infinity) flush(i);
        curKey = bucket;
        curStartMs = times[i];
        curStartTickIdx = i;
        curOpen = prices[i];
        curHigh = prices[i];
        curLow = prices[i];
        curClose = prices[i];
        curVol = sizes[i];
        curBidVol = sides[i] === 1 ? sizes[i] : 0;
        curAskVol = sides[i] === 2 ? sizes[i] : 0;
      } else {
        const p = prices[i];
        if (p > curHigh) curHigh = p;
        if (p < curLow) curLow = p;
        curClose = p;
        curVol += sizes[i];
        if (sides[i] === 1) curBidVol += sizes[i];
        else if (sides[i] === 2) curAskVol += sizes[i];
      }
    }
  }

  // Final bar — `N` is the exclusive end (last tick + 1).
  if (curKey !== -Infinity) flush(N);

  // Slice the ranges down to the actual bar count emitted.
  const tickRanges = ranges.slice(0, barIndex * 2);
  return { bars: out, tickRanges };
}
