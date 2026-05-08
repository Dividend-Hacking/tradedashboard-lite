/**
 * Run Summary Builder
 * ───────────────────
 * Produces the lean JSON snapshot the dashboard writes to
 * `backtests/dashboard-results/<base>__<ISO>.summary.json` after every
 * Run press while bound to a disk-backed script. The full DetailedExport
 * lives in the `.json` file beside it (~38 MB for typical runs); this
 * summary is ~20–80 KB so Claude Code (or any other terminal-side
 * analysis tool) can read the entire artifact without choking.
 *
 * The builder is pure — no React, no DOM. It takes already-resolved
 * dashboard state (trades, summary stats, metrics, optimization history,
 * sessions) and emits a flat JSON-serializable struct. The dashboard
 * caller assembles the inputs in its post-run effect; this file is
 * pure plumbing.
 *
 * Schema versioning: bumped whenever the shape changes in a non-additive
 * way. Additive fields don't bump the version — Claude Code's analysis
 * just won't see them on older runs.
 */

import type { TradeZone } from "@/types/trade-zone";
import type { ReplaySession } from "@/types/replay";
import type { SimZoneResult, SimSummary } from "./zone-simulator";
import type { OptimizationRecord } from "./script-online-optimizer";
import type { FilterIfDirective } from "./backtest-script";

// ─── Public types ──────────────────────────────────────────────────────────

export interface RunSummary {
  schemaVersion: 1;
  /** ISO timestamp at the moment the summary was built (≈ run completion). */
  runCompletedAt: string;
  /** The .dsl file the editor was bound to when this run fired. */
  scriptName: string;
  /** Snapshot of the script source AT APPLY TIME — not the live editor
   *  text, which the user may have edited between Run-click and Run-
   *  finish on a long optimize run. */
  scriptSource: string;

  /** Sessions selected for the run, in dashboard pick order.
   *  `zonesCount` is the number of synthetic zones the strategy emitted
   *  for this session — a proxy for "how much did this session
   *  contribute?" since synthetic zones don't carry a session_id we
   *  could group on directly. */
  sessions: Array<{
    id: number;
    instrument: string;
    date: string;
    zonesCount: number;
  }>;

  /** Funnel: how the strategy's raw signals turned into trades.
   *  `signalsGenerated` should equal `finalTrades + sum(rejections.rejected)`
   *  for any healthy run. */
  funnel: {
    signalsGenerated: number;
    rejections: Array<{
      directiveIndex: number;
      directiveSource: string;
      rejected: number;
    }>;
    finalTrades: number;
  };

  /** Verbatim SimSummary — already compact (~30 numeric fields, < 1 KB). */
  stats: SimSummary;

  /** Optional optimization context — present only when the script has at
   *  least one Optimize.X.Y(...) directive that produced records. */
  optimization?: {
    perDirective: Array<{
      path: string;
      pickCount: number;
      lastValue: number;
      objectiveRange: { min: number; max: number };
      /** Full per-signal trace, included only when pickCount ≤ 200 to keep
       *  the summary file compact. For longer runs the trace is omitted —
       *  Claude Code can fall back to the full DetailedExport JSON if it
       *  needs the per-signal detail. */
      picks?: Array<{ tradeIndex: number; value: number; objective: number }>;
    }>;
    warnings: string[];
  };

  /** Per-trade compact rows — same data the NT8-comparable CSV has, in
   *  JSON form so analysis tools can `jq` it without parsing CSV. Always
   *  included; small (~10 KB even for 1000 trades). */
  trades: Array<{
    entryTime: string;
    exitTime: string;
    direction: "long" | "short";
    entryPrice: number;
    exitPrice: number;
    exitReason: string;
    points: number;
    dollars: number;
    barsHeld: number;
  }>;
}

// ─── Builder ───────────────────────────────────────────────────────────────

/** Threshold above which per-directive pick traces are dropped to keep
 *  the summary file under ~100 KB even for long runs. */
const PICK_TRACE_LIMIT = 200;

export interface BuildRunSummaryArgs {
  scriptName: string;
  scriptSource: string;
  trades: SimZoneResult[];
  zones: TradeZone[];
  /** Source-of-truth for entry/exit times + barsHeld. Same map the
   *  detailed-export builder uses. */
  barsByZoneId: Map<number, import("@/types/trade-zone").TradeZoneBar[]>;
  stats: SimSummary;
  selectedSessionIds: Set<number>;
  sessions: ReplaySession[];
  /** zonesConsidered + filterRejections from the simulator/optimizer
   *  metricsOut. Optional — when absent (defensive), the funnel is
   *  built from `trades.length` only and rejection counts are empty. */
  metrics?: {
    zonesConsidered: number;
    filterRejections: Map<number, number>;
  };
  /** Live filter.if list at apply time — used to label each rejection
   *  entry with its directive's source line. */
  filterIfs: FilterIfDirective[];
  /** From the optimizer's output, when present. */
  optimizationHistory?: Record<string, OptimizationRecord[]>;
  optimizationWarnings?: string[];
}

/** Return the directive's source line. FilterIfDirective carries the
 *  raw source text on `.source` (set by the parser); fall back to a
 *  synthetic label only when that's somehow missing — defensive, since
 *  the parser populates it on every directive. The script-source param
 *  is unused in v1 but kept on the signature so we can switch to a
 *  line-number lookup later without touching callers. */
function directiveSourceLine(
  _scriptSource: string,
  directive: FilterIfDirective,
  fallbackIndex: number
): string {
  // Prefix scoped directives so the user can tell at a glance whether
  // the rejection came from the global `filter.if` or one of its
  // per-direction variants. Without the prefix two directives with
  // the same RHS but different scope would render identically.
  const lhs =
    directive.scope === "long"
      ? "filter.long.if"
      : directive.scope === "short"
        ? "filter.short.if"
        : "filter.if";
  if (typeof directive.source === "string" && directive.source.trim().length > 0) {
    return `${lhs} = ${directive.source.trim()}`;
  }
  return `${lhs} #${fallbackIndex}`;
}

/** Compact one OptimizationRecord array into the summary's per-directive
 *  shape. Trims long traces per PICK_TRACE_LIMIT. */
function compactOptimization(
  path: string,
  records: OptimizationRecord[]
): RunSummary["optimization"] extends (infer T)
  ? T extends { perDirective: Array<infer E> }
    ? E
    : never
  : never {
  let minObj = Infinity;
  let maxObj = -Infinity;
  for (const r of records) {
    if (Number.isFinite(r.objective)) {
      if (r.objective < minObj) minObj = r.objective;
      if (r.objective > maxObj) maxObj = r.objective;
    }
  }
  // Last-applied (smoothed) value is the natural "current best." When
  // the trace is empty (defensive), surface NaN so the consumer sees
  // explicit absence rather than a misleading zero.
  const lastValue = records.length > 0 ? records[records.length - 1].value : NaN;
  const out: {
    path: string;
    pickCount: number;
    lastValue: number;
    objectiveRange: { min: number; max: number };
    picks?: Array<{ tradeIndex: number; value: number; objective: number }>;
  } = {
    path,
    pickCount: records.length,
    lastValue,
    objectiveRange: {
      min: Number.isFinite(minObj) ? minObj : NaN,
      max: Number.isFinite(maxObj) ? maxObj : NaN,
    },
  };
  if (records.length > 0 && records.length <= PICK_TRACE_LIMIT) {
    out.picks = records.map((r) => ({
      tradeIndex: r.tradeIndex,
      value: r.value,
      objective: r.objective,
    }));
  }
  return out;
}

/** Map a SimZoneResult into the lean per-trade row. Pulls entry/exit
 *  times from the bars map (results carry indices, not timestamps).
 *  Field names follow the snake_case convention TradeZoneBar uses
 *  (bar_time / bar_open / bar_close), not the camelCase aliases —
 *  several places in the codebase made that mistake originally. */
function buildTradeRow(
  r: SimZoneResult,
  zone: TradeZone,
  bars: import("@/types/trade-zone").TradeZoneBar[]
): RunSummary["trades"][number] {
  const sorted = bars.length > 0 ? [...bars].sort((a, b) => a.bar_index - b.bar_index) : [];
  const entryBar = sorted.find((b) => b.bar_index === 0) ?? sorted[0];
  const exitBar = sorted.find((b) => b.bar_index === r.exitBarIndex);
  const entryPrice = entryBar?.bar_open ?? entryBar?.bar_close ?? NaN;
  const exitPrice = exitBar?.bar_close ?? NaN;
  // TradeZone.direction is "Long" / "Short" (capitalised strings, not
  // ±1 ints). Lowercase to match the lean schema's `"long" | "short"`
  // discriminator.
  const direction: "long" | "short" =
    zone.direction.toLowerCase() === "long" ? "long" : "short";
  return {
    entryTime: entryBar?.bar_time ?? "",
    exitTime: exitBar?.bar_time ?? "",
    direction,
    entryPrice,
    exitPrice,
    exitReason: r.exitReason,
    points: r.scaledPoints,
    dollars: r.netDollars ?? NaN,
    barsHeld: r.barsHeld,
  };
}

/** Build the lean summary. Pure; safe to call from anywhere with
 *  resolved dashboard state. */
export function buildRunSummary(args: BuildRunSummaryArgs): RunSummary {
  const {
    scriptName,
    scriptSource,
    trades,
    zones,
    barsByZoneId,
    stats,
    selectedSessionIds,
    sessions,
    metrics,
    filterIfs,
    optimizationHistory,
    optimizationWarnings,
  } = args;

  // Sessions: instrument + date + zone count. We can't derive bars-per-
  // session because synthetic zones don't carry session_id; the dashboard's
  // bar cache lives in a separate Map. So we surface zone count per
  // (instrument, date) instead — the user can correlate with the session
  // by those two fields, and it's enough to gauge "did this session
  // contribute many signals?" Fallback 0 when no zone matched.
  const zonesPerKey = new Map<string, number>();
  for (const z of zones) {
    // Synthetic zones use start_time as the only date proxy. Take the
    // YYYY-MM-DD prefix to align with ReplaySession.date format.
    const dateKey = z.start_time?.slice(0, 10) ?? "";
    const key = `${z.instrument}|${dateKey}`;
    zonesPerKey.set(key, (zonesPerKey.get(key) ?? 0) + 1);
  }
  const sessionList: RunSummary["sessions"] = [];
  for (const s of sessions) {
    if (!selectedSessionIds.has(s.id)) continue;
    sessionList.push({
      id: s.id,
      instrument: s.instrument,
      date: s.session_date,
      zonesCount: zonesPerKey.get(`${s.instrument}|${s.session_date}`) ?? 0,
    });
  }

  // Funnel. `signalsGenerated` comes from the metrics (= input zone
  // count for the current sim path). When metrics are absent we fall
  // back to "trades.length only," producing a degenerate funnel that
  // still serializes cleanly.
  const signalsGenerated = metrics?.zonesConsidered ?? trades.length;
  const rejections: RunSummary["funnel"]["rejections"] = [];
  if (metrics) {
    // Walk filterIfs in source order so rejection entries align with
    // the user's mental model. Skip directives with zero rejections —
    // surfacing them adds noise without adding signal.
    for (let i = 0; i < filterIfs.length; i++) {
      const count = metrics.filterRejections.get(i) ?? 0;
      if (count === 0) continue;
      rejections.push({
        directiveIndex: i,
        directiveSource: directiveSourceLine(scriptSource, filterIfs[i], i),
        rejected: count,
      });
    }
  }

  // Optimization compaction.
  let optimization: RunSummary["optimization"] | undefined;
  if (optimizationHistory && Object.keys(optimizationHistory).length > 0) {
    const perDirective = Object.entries(optimizationHistory).map(
      ([path, records]) => compactOptimization(path, records)
    );
    optimization = {
      perDirective,
      warnings: optimizationWarnings ?? [],
    };
  }

  // Per-trade compact rows. Index zones once for O(1) lookup inside the
  // hot loop — same pattern as buildDetailedExport.
  const zonesById = new Map<number, TradeZone>();
  for (const z of zones) zonesById.set(z.id, z);
  const tradeRows: RunSummary["trades"] = [];
  for (const r of trades) {
    const zone = zonesById.get(r.zoneId);
    if (!zone) continue;
    const bars = barsByZoneId.get(r.zoneId) ?? [];
    tradeRows.push(buildTradeRow(r, zone, bars));
  }

  return {
    schemaVersion: 1,
    runCompletedAt: new Date().toISOString(),
    scriptName,
    scriptSource,
    sessions: sessionList,
    funnel: {
      signalsGenerated,
      rejections,
      finalTrades: trades.length,
    },
    stats,
    ...(optimization ? { optimization } : {}),
    trades: tradeRows,
  };
}
