/**
 * Volume profile computation — pure JS, runs against the parallel typed
 * arrays produced by `parseTickCsv`. The viewer feeds the result into
 * `ReplayChart`'s SVG overlay where each price level is rendered as a
 * horizontal histogram bar.
 *
 * Why operate on ParsedTicks (not ReplayBars):
 *   A volume profile is a per-trade-price histogram. Aggregated bars
 *   collapse hundreds of trades into a single OHLC row, so projecting a
 *   profile from bars would have to spread a bar's volume across the
 *   high-low range — strictly worse than walking the raw ticks. Tick+
 *   sessions already keep the parsed typed arrays in memory, so the
 *   forward pass here is fast (~10-50 ms even for 5M+ ticks).
 *
 * Bucket math:
 *   Each trade's price is quantized down to the nearest `tickSize *
 *   bucketTicks` increment so the histogram has finite resolution and
 *   identical-price trades land in the same bin. We bucket-by-key in a
 *   Map and convert to a sorted array at the end.
 *
 * Bid / ask split:
 *   When the NT8 writer emits side data (`tick_bidask` granularity),
 *   `sides[i] === 1` means the trade hit the bid (sell-aggressor) and
 *   `sides[i] === 2` means it lifted the ask (buy-aggressor). We track
 *   both totals per bucket so the chart can render a stacked bid/ask
 *   bar. Side=0 ticks contribute only to the total volume.
 *
 * Value area (VA):
 *   POC = bucket with the most volume.
 *   VA  = the contiguous price range around the POC that contains
 *         `valueAreaPct` (default 70%) of total volume. We grow outward
 *         from the POC, always stepping toward the heavier of the two
 *         immediate neighbors, until the running sum crosses the
 *         threshold. This is the standard "TPO-style" expansion used by
 *         most charting platforms.
 */

import type { ParsedTicks } from "./tick-aggregation";

/** One price level in the profile. `priceLow` is the lower edge of the
 *  bucket; `priceHigh` is `priceLow + bucketSize`. The chart renders the
 *  bar centered between the two (both are pre-computed so the overlay
 *  doesn't need to know `bucketSize`). */
export interface VolumeLevel {
  priceLow: number;
  priceHigh: number;
  totalVolume: number;
  /** Volume of trades that hit the bid (sell-aggressor). */
  bidVolume: number;
  /** Volume of trades that lifted the ask (buy-aggressor). */
  askVolume: number;
}

export interface VolumeProfile {
  /** Price levels sorted ascending by `priceLow`. */
  levels: VolumeLevel[];
  /** Highest-volume level's midpoint price. Null when no ticks. */
  poc: number | null;
  /** Upper edge of the value-area range. Null when no ticks. */
  vah: number | null;
  /** Lower edge of the value-area range. Null when no ticks. */
  val: number | null;
  /** Σ totalVolume across all levels — used to scale histogram bars. */
  totalVolume: number;
  /** max(level.totalVolume). Pre-computed so the overlay doesn't have
   *  to walk the levels every render to find the longest bar. */
  maxLevelVolume: number;
  /** Bucket size in price points (e.g. 0.25 for ES). Mirrors the
   *  `bucketSize` arg so callers can render axis labels off the result
   *  alone. */
  bucketSize: number;
}

export interface VolumeProfileOptions {
  /** Width of one histogram bucket in price points. Typically the
   *  instrument tick size (e.g. 0.25 for NQ) or a small multiple of it
   *  for less granular but cleaner-looking profiles. Must be > 0. */
  bucketSize: number;
  /** Fraction of total volume that defines the value area (0-1).
   *  Default 0.70 — the industry-standard 70% number. */
  valueAreaPct?: number;
  /** Optional time-range filter in ms epoch. When set, only ticks with
   *  `times[i] >= startMs && times[i] < endMs` contribute. Inclusive
   *  start, exclusive end. Use this for visible-range or session-window
   *  profiles. */
  startMs?: number;
  endMs?: number;
}

/**
 * Compute a volume profile over a tick stream.
 *
 * Returns an empty-but-shaped result when `ticks.count === 0` or when
 * the time-range filter excludes everything, so callers can render
 * "no data" UI without null-checking every level field.
 */
export function computeVolumeProfile(
  ticks: ParsedTicks,
  opts: VolumeProfileOptions
): VolumeProfile {
  const bucketSize = opts.bucketSize;
  const valueAreaPct = opts.valueAreaPct ?? 0.70;

  // Defensive — bad inputs would otherwise produce Infinity bucket keys
  // or an infinite VA expansion loop.
  if (!isFinite(bucketSize) || bucketSize <= 0) {
    return emptyProfile(bucketSize > 0 ? bucketSize : 1);
  }
  if (valueAreaPct <= 0 || valueAreaPct > 1) {
    return emptyProfile(bucketSize);
  }

  const { count, times, prices, sizes, sides } = ticks;
  if (count === 0) return emptyProfile(bucketSize);

  const startMs = opts.startMs ?? -Infinity;
  const endMs = opts.endMs ?? Infinity;

  // Bucket key → running totals. Map keyed by integer bucket index so
  // floating-point price comparisons can't drift and put neighbouring
  // ticks in different bins. Index = floor(price / bucketSize).
  const totals = new Map<number, { total: number; bid: number; ask: number }>();
  let totalVolume = 0;

  for (let i = 0; i < count; i++) {
    const t = times[i];
    if (t < startMs || t >= endMs) continue;

    const sz = sizes[i];
    if (sz <= 0) continue;

    const key = Math.floor(prices[i] / bucketSize);
    let bin = totals.get(key);
    if (!bin) {
      bin = { total: 0, bid: 0, ask: 0 };
      totals.set(key, bin);
    }
    bin.total += sz;
    if (sides[i] === 1) bin.bid += sz;
    else if (sides[i] === 2) bin.ask += sz;
    totalVolume += sz;
  }

  if (totals.size === 0) return emptyProfile(bucketSize);

  // Materialize and sort ascending by price. Sorted order is needed for
  // the value-area expansion (we walk neighbour indices) and for the
  // chart overlay (which renders top-down).
  const sortedKeys = Array.from(totals.keys()).sort((a, b) => a - b);
  const levels: VolumeLevel[] = sortedKeys.map((key) => {
    const bin = totals.get(key)!;
    const priceLow = key * bucketSize;
    return {
      priceLow,
      priceHigh: priceLow + bucketSize,
      totalVolume: bin.total,
      bidVolume: bin.bid,
      askVolume: bin.ask,
    };
  });

  // POC = single highest-volume bucket. Ties broken by the lower price
  // (first one found wins) — arbitrary but deterministic.
  let pocIdx = 0;
  let maxLevelVolume = levels[0].totalVolume;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].totalVolume > maxLevelVolume) {
      maxLevelVolume = levels[i].totalVolume;
      pocIdx = i;
    }
  }

  // Value-area expansion. Start at POC and grow outward; at each step,
  // extend toward whichever neighbour pair has more volume (sum of the
  // next 1-2 buckets on that side — see comment below). Stop when the
  // running volume covers `valueAreaPct` of total.
  const targetVol = totalVolume * valueAreaPct;
  let runningVol = levels[pocIdx].totalVolume;
  let lo = pocIdx;
  let hi = pocIdx;

  // The TPO-style canonical algorithm: peek 2 buckets on each side and
  // take the heavier pair. We use 2 instead of 1 because traders'
  // platforms (Sierra, Bookmap, NinjaTrader) all do this — it produces
  // smoother VA boundaries and matches what users expect to see.
  while (runningVol < targetVol && (lo > 0 || hi < levels.length - 1)) {
    const upPair =
      hi < levels.length - 1
        ? (levels[hi + 1].totalVolume + (hi + 2 < levels.length ? levels[hi + 2].totalVolume : 0))
        : -1;
    const downPair =
      lo > 0
        ? (levels[lo - 1].totalVolume + (lo - 2 >= 0 ? levels[lo - 2].totalVolume : 0))
        : -1;

    if (upPair < 0 && downPair < 0) break; // shouldn't happen given the loop guard

    if (upPair >= downPair) {
      // Step up by 1-2 buckets.
      hi++;
      runningVol += levels[hi].totalVolume;
      if (runningVol < targetVol && hi < levels.length - 1) {
        hi++;
        runningVol += levels[hi].totalVolume;
      }
    } else {
      lo--;
      runningVol += levels[lo].totalVolume;
      if (runningVol < targetVol && lo > 0) {
        lo--;
        runningVol += levels[lo].totalVolume;
      }
    }
  }

  // POC is reported as the bucket midpoint so it lines up with where the
  // bar actually centers visually (rather than the lower edge).
  const pocLevel = levels[pocIdx];
  const poc = (pocLevel.priceLow + pocLevel.priceHigh) / 2;
  const val = levels[lo].priceLow;
  const vah = levels[hi].priceHigh;

  return {
    levels,
    poc,
    vah,
    val,
    totalVolume,
    maxLevelVolume,
    bucketSize,
  };
}

function emptyProfile(bucketSize: number): VolumeProfile {
  return {
    levels: [],
    poc: null,
    vah: null,
    val: null,
    totalVolume: 0,
    maxLevelVolume: 0,
    bucketSize,
  };
}
