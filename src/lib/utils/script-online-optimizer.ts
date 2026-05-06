/**
 * script-online-optimizer.ts — Online TPE optimizer driven by the
 * `Optimize.X.Y(...)` directives in a script.
 *
 * "Online" because the optimizer runs INSIDE the backtest, not as a
 * one-shot batch step. After a warmup of `<lookback>` completed trades,
 * every new signal triggers a fresh TPE search over the directive's
 * recent-N-trade window; the resulting parameter values are used for
 * the trade about to fire. This is fundamentally a walk-forward
 * adaptive optimization — the system tunes itself as data accumulates.
 *
 * v1 scope:
 *   - Numeric Optimize directives on `rules.*` ONLY.
 *   - Categorical Optimize and Optimize on `filters.*` / `params.*`
 *     are explicitly rejected at parse time; they require simulator
 *     and strategy-generator refactors that are tracked as follow-ups.
 *
 * Algorithm per signal (when a directive's lookback has filled):
 *   1. Slice the last `lookback` trades' SOURCE ZONES (not just
 *      results — we need to re-simulate them under candidate rules).
 *   2. Spin up a fresh TpeState per directive (independent mode) OR a
 *      single shared TpeState (joint mode, gated by `OptimizeAll`).
 *   3. For nTrials cycles:
 *        params  = suggest(tpeState, rng)
 *        re-sim  = simulateZone for each of the lookback zones with
 *                  rules patched by params
 *        summary = computeSimSummary(re-sim)
 *        obs     = observe(tpeState, { params, objective: pickObj })
 *   4. Apply best.params to baseRules → use for THIS signal's trade.
 *
 * History is recorded per directive so the Output panel can show "the
 * value used at trade N" without re-running anything.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import {
  type SimRules,
  type SimZoneResult,
  type SimSummary,
  type SimulateMetrics,
  simulateZone,
  computeSimSummary,
  resolveTickConfig,
  evaluateFilterIfDirective,
} from "./zone-simulator";
import {
  type OptimizeSpec,
  type OptimizeObjective,
  type Expr as ScriptExpr,
  type EntryEvalCtx,
  NUMERIC_RULE_KEYS,
  evaluate as evaluateExpr,
} from "./script-expr";
import type { FilterIfDirective } from "./backtest-script";
import {
  type ParamSpec,
  type TpeState,
  createTpe,
  suggest,
  observe,
  bestTrial,
  hashStringToSeed,
  mulberry32,
} from "./tpe";

// ─── Public types ───────────────────────────────────────────────────────────

export interface OnlineOptimizerInput {
  /** Zones in any order — we sort chronologically internally. */
  zones: TradeZone[];
  barsByZoneId: Map<number, TradeZoneBar[]>;
  baseRules: SimRules;
  atrByZoneId: Map<number, number> | null;
  /** Path → Optimize spec. Only rules.* numeric paths are honored in v1. */
  optimizeOverrides: Record<string, OptimizeSpec>;
  /** True = single TPE over the joint search space (must agree on
   *  objective). False = one independent TPE per directive. */
  joint: boolean;
  /** TPE trials per re-optimization. Default 30 — high enough for
   *  reasonable convergence in 1-3 dims, low enough to keep total
   *  runtime in the seconds even for 100+ signals. */
  nTrialsPerSignal?: number;
  /** TPE warmup trials (uniform random) before the acquisition step
   *  kicks in. Default 8 — leaves 22 of the 30 default trial budget
   *  for actual TPE proposals. */
  warmupTrials?: number;
  /** Stable seed for the RNG. Same seed + same script + same data ⇒
   *  bit-identical optimization trace. The dashboard derives this from
   *  a hash of the script text + selected sessions. */
  seed: number;
  /** Optional cancel flag — checked between signals so a long run can
   *  be aborted by the user. The worker runner sets this from a
   *  postMessage("cancel"). */
  cancelRef?: { current: boolean };
  /** Optional progress callback. Called per signal completion. */
  onProgress?: (done: number, total: number) => void;
  /** Optional async hook awaited between every signal. The dashboard
   *  uses this to `await yieldToMain()` so the browser can paint the
   *  progress bar and stay responsive instead of triggering the
   *  "page unresponsive" dialog on long optimizer runs. Sync callers
   *  (tests, etc.) omit this and the function still resolves quickly. */
  onSignalDone?: () => Promise<void> | void;
  /** `ontrade.print` directives. When present, the optimizer evaluates
   *  each at the entry bar of every emitted trade and attaches the
   *  result to `SimZoneResult.script_prints` — same shape that
   *  `simulateAllZones` produces in the non-optimizer path, so the
   *  Output panel renders prints whether or not Optimize is active. */
  tradePrints?: Array<{ label: string; expr: ScriptExpr }>;
  /** Pre-computed indicator series, keyed by (zone.id, indicator-key).
   *  Required when tradePrints reference indicators (ATR, EMA, etc.) —
   *  without it those lookups return NaN. Built by the caller via
   *  precomputeIndicators on the same zone set passed in `zones`. */
  indicatorByZone?: Map<number, Map<string, number[]>>;
  /** `filter.if = (...)` directives. Evaluated per-signal AFTER the
   *  optimizer has resolved this signal's params (so any `var <name> =
   *  Optimize.X.Y(...)` references in the conditions see the current
   *  optimized value). A "reject" verdict skips the trade; a "pass"
   *  layers the directive's rule overrides on top of the optimizer-
   *  resolved rules. Empty/undefined means no filter.if logic — the
   *  optimizer behaves byte-identically to its pre-filter.if path. */
  filterIfs?: FilterIfDirective[];
  /** `Warmup` flag from the script — controls whether trades fired
   *  before the optimizer's lookback fills are included in the final
   *  returned trades array. Default true (include them, current
   *  behavior). False excludes them so stats reflect only the
   *  optimized phase. The optimizer ALWAYS uses warmup trades
   *  internally for its lookback math regardless of this flag —
   *  filtering happens only at the end of the run. */
  warmup?: boolean;
  /** Optional metrics out-param for the dashboard's per-run summary
   *  export. Mirrors `simulateAllZones`'s `metricsOut` so the funnel
   *  ("signals generated → after each filter.if → final trades") is
   *  available regardless of which simulator path produced the run.
   *  Populated as the optimizer walks; the caller reads after
   *  the returned promise resolves. See `SimulateMetrics` for fields. */
  metricsOut?: SimulateMetrics;
}

/** One row in the per-directive optimization history. The Output panel
 *  renders these as a sparkline + "current best" view. */
export interface OptimizationRecord {
  tradeIndex: number;
  /** Resolved value the optimizer ACTUALLY APPLIED for this signal —
   *  i.e., the smoothed value when `smooth <N>` is in effect, otherwise
   *  identical to `rawValue`. This is what the live trade saw, so the
   *  sparkline's primary trace and the "last X" badge always reflect
   *  what the strategy was running with. Numeric in v1 (categorical
   *  lands when the filter/enum path opens up). */
  value: number;
  /** Pre-smoothing best-trial value from THIS signal's TPE search.
   *  Equals `value` when smoothing is disabled. The Output panel uses
   *  this as a faint background trace so the user can see the raw
   *  optimizer output alongside the smoothed series the trade
   *  actually used. Omitted on records emitted before smoothing
   *  existed (back-compat with persisted runs). */
  rawValue?: number;
  /** Smoothing window applied to this directive (resolved default
   *  when the script omitted `smooth <N>`). 0 or 1 = smoothing off.
   *  Stored per-record so the panel can label "Smooth: N" without
   *  needing a side-channel through the dashboard. Omitted on legacy
   *  records emitted before this field existed. */
  smoothWindow?: number;
  /** Best objective achieved during the per-signal TPE search. NaN if
   *  the search couldn't find any finite-objective trial (shouldn't
   *  happen post-warmup but defensive). */
  objective: number;
  /** TPE trials run for this signal. Useful for debugging warm/cold
   *  starts in a future warm-start mode. */
  trialsRun: number;
}

export interface OnlineOptimizerOutput {
  trades: SimZoneResult[];
  /** Per-path history, in trade-emission order. Empty arrays for
   *  directives that never warmed up (insufficient trades). */
  optimizationHistory: Record<string, OptimizationRecord[]>;
  /** Warnings collected during the run (e.g. "directive X never warmed
   *  up — only Y trades available, lookback Z"). Surfaced as a yellow
   *  banner in the dashboard. */
  warnings: string[];
}

// ─── Implementation ─────────────────────────────────────────────────────────

const DEFAULT_TRIALS = 30;
const DEFAULT_WARMUP = 8;
/** Default SMA window applied to per-signal optimized values when the
 *  directive doesn't specify `smooth <N>`. Chosen at 5 because it's
 *  short enough to track regime change within ~10-15 signals while
 *  long enough to kill the single-signal jitter that comes from a
 *  small (~30-trade) lookback window. Override per-directive in the
 *  script with `Optimize.X.Y(...) smooth <N>`; `smooth 0` or `smooth 1`
 *  disables smoothing for that directive. */
const DEFAULT_SMOOTH_WINDOW = 5;

export async function runOnlineOptimizedBacktest(
  input: OnlineOptimizerInput
): Promise<OnlineOptimizerOutput> {
  const {
    zones,
    barsByZoneId,
    baseRules,
    atrByZoneId,
    optimizeOverrides,
    joint,
    nTrialsPerSignal = DEFAULT_TRIALS,
    warmupTrials = DEFAULT_WARMUP,
    seed,
    cancelRef,
    onProgress,
    onSignalDone,
  } = input;
  const rng = mulberry32(seed);
  const warnings: string[] = [];
  const tradePrints = input.tradePrints;
  const indicatorByZone = input.indicatorByZone;
  const filterIfs = input.filterIfs;
  const includeWarmupTrades = input.warmup !== false; // default true
  const metricsOut = input.metricsOut;
  // Seed `zonesConsidered` once with the input zone count so the funnel
  // numerator is correct regardless of how many trades survive. Mirrors
  // simulateAllZones's analogous seeding so both code paths fill the
  // same field.
  if (metricsOut) metricsOut.zonesConsidered = zones.length;

  // Pre-compute the static defaults map — every var with a `default <num>`
  // clause on its Optimize spec. Pre-warmup, these values seed `varValues`
  // so filter.if conds and rules.* RHS expressions referencing the var
  // resolve to a finite number instead of NaN. Post-warmup, the
  // optimizer's resolved values supersede the defaults via Map.set().
  // Empty map when no var has a default — varValuesFrom returns null and
  // pre-warmup expressions NaN as before.
  const staticDefaults = new Map<string, number>();
  for (const path of Object.keys(optimizeOverrides)) {
    if (!path.startsWith("var.")) continue;
    const spec = optimizeOverrides[path];
    if (spec.kind !== "optimize-numeric") continue;
    if (spec.defaultValue === undefined) continue;
    staticDefaults.set(path.slice("var.".length), spec.defaultValue);
  }

  // Build the `varValues` map from the optimizer's resolved params. Walks
  // every entry whose path starts with `var.` and stores `<name> →
  // value`. Resolved optimizer values OVERLAY any static defaults so the
  // post-warmup optimizer choice wins; vars without optimizer values yet
  // (skipped this signal due to invalid bounds, etc.) keep their
  // default. Returns null only when there are NO var entries AND no
  // static defaults.
  const varValuesFrom = (params: Record<string, unknown>): Map<string, number> | null => {
    let map: Map<string, number> | null = null;
    if (staticDefaults.size > 0) {
      map = new Map(staticDefaults);
    }
    for (const path of Object.keys(optimizeOverrides)) {
      if (!path.startsWith("var.")) continue;
      const v = params[path];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (!map) map = new Map();
      map.set(path.slice("var.".length), v);
    }
    return map;
  };

  // Pre-warmup snapshot — only the static defaults. Used during the
  // warmup phase (before the optimizer fires) so vars that DO have
  // a default still resolve. Returns null when no defaults exist so
  // pre-warmup behavior is byte-identical to today.
  const preWarmupVarValues = (): Map<string, number> | null => {
    return staticDefaults.size > 0 ? new Map(staticDefaults) : null;
  };

  // Build a per-zone EntryEvalCtx — used by both filter.if evaluation and
  // the per-trade print pass. Centralizing the build means new fields on
  // EntryEvalCtx (varValues, etc.) only land in one place.
  const buildEntryCtx = (
    zone: TradeZone,
    bars: TradeZoneBar[],
    varValues: Map<string, number> | null
  ): EntryEvalCtx => {
    const sorted = [...bars].sort((a, b) => a.bar_index - b.bar_index);
    const entryBar = sorted.find((b) => b.bar_index === 0) ?? sorted[0];
    const indicatorByKey =
      indicatorByZone?.get(zone.id) ?? new Map<string, number[]>();
    const tickCfg = resolveTickConfig(zone.instrument, baseRules);
    return {
      bar: entryBar,
      barIndex: entryBar.bar_index,
      indicatorByKey,
      zone,
      tickConfig: {
        ticksPerPoint: tickCfg.ticksPerPoint,
        tickValue: tickCfg.tickValue,
        pointValue: tickCfg.pointValue,
      },
      varValues: varValues ?? undefined,
    };
  };

  // Evaluate `ontrade.print` directives at a zone's entry bar and
  // attach the resulting label→value map to the SimZoneResult. Mirrors
  // the per-trade print pass in simulateAllZones (zone-simulator.ts) so
  // optimizer-emitted trades surface prints in the Output panel just
  // like the non-optimizer path. No-op when no directives are present.
  // `extraPrints` is the bag accumulated by filter.if `print(...)`
  // statements during this signal's evaluation — those rows merge in
  // with ontrade.print results so users see both surfaces in one table.
  const attachPrints = (
    ctx: EntryEvalCtx,
    result: SimZoneResult,
    extraPrints: Map<string, number> | null
  ): void => {
    if ((!tradePrints || tradePrints.length === 0) && (!extraPrints || extraPrints.size === 0)) return;
    const prints: Record<string, number> = {};
    if (tradePrints) {
      for (const p of tradePrints) {
        prints[p.label] = evaluateExpr(p.expr, { kind: "entry", ...ctx });
      }
    }
    if (extraPrints) {
      // filter.if prints win on label collisions — they're the more
      // specific signal (matching simulateAllZones' merge order).
      for (const [k, v] of extraPrints) prints[k] = v;
    }
    result.script_prints = prints;
  };

  // Sort zones chronologically by startTime so "last N trades" is a
  // monotonic concept. We work with a sorted copy so the caller's
  // array stays untouched.
  const sortedZones = [...zones].sort((a, b) =>
    a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0
  );

  const directivePaths = Object.keys(optimizeOverrides);
  const trades: SimZoneResult[] = [];
  const history: Record<string, OptimizationRecord[]> = {};
  for (const p of directivePaths) history[p] = [];

  // SMA state per directive — a rolling buffer of the LAST K raw
  // best-trial values that the TPE search produced for this path.
  // Each signal's applied value is mean(buffer); the trade then runs
  // with the smoothed value rather than the noisy single-signal pick.
  // Buffer trimmed to the directive's resolved window every push so
  // memory stays bounded. Defaults to DEFAULT_SMOOTH_WINDOW (5) when
  // the script omits `smooth <N>`; user-specified `smooth 0` or
  // `smooth 1` collapses to a no-op (the raw value passes through).
  const smoothBuffers = new Map<string, number[]>();
  const smoothWindowByPath: Record<string, number> = {};
  for (const p of directivePaths) {
    const spec = optimizeOverrides[p];
    if (spec.kind !== "optimize-numeric") {
      smoothWindowByPath[p] = 1;
      continue;
    }
    const w = spec.smoothWindow;
    smoothWindowByPath[p] = w === undefined ? DEFAULT_SMOOTH_WINDOW : Math.max(0, Math.floor(w));
    smoothBuffers.set(p, []);
  }

  // No directives → defensive fast path; behaves byte-identically to a
  // straight simulator walk over zones in chronological order. Should
  // not normally be called this way (caller checks first), but cheap
  // to guard so unit tests don't have to set up overlay state.
  if (directivePaths.length === 0) {
    for (let i = 0; i < sortedZones.length; i++) {
      const z = sortedZones[i];
      const bars = barsByZoneId.get(z.id);
      if (!bars || bars.length === 0) continue;
      const r = simulateZone(z, bars, baseRules, atrByZoneId?.get(z.id) ?? null);
      if (r) {
        const ctx = buildEntryCtx(z, bars, null);
        attachPrints(ctx, r, null);
        trades.push(r);
      }
      onProgress?.(i + 1, sortedZones.length);
      if (onSignalDone) await onSignalDone();
      if (cancelRef?.current) break;
    }
    return { trades, optimizationHistory: history, warnings };
  }

  // Validate joint mode — all directives must share an objective. The
  // parser doesn't enforce this (it doesn't know about OptimizeAll),
  // so we check at run time and downgrade to independent mode with a
  // warning rather than failing outright. Fail-soft matches the rest
  // of the script DSL's tolerant parser approach.
  let effectiveJoint = joint;
  if (joint) {
    const objs = new Set(directivePaths.map((p) => optimizeOverrides[p].objective));
    if (objs.size > 1) {
      effectiveJoint = false;
      warnings.push(
        `OptimizeAll = true requires all directives to share an objective; got ${[...objs].join(", ")}. Falling back to independent mode.`
      );
    }
  }

  // Bound expressions are evaluated PER SIGNAL inside the loop below
  // (they may reference bar/indicator state via ATR, ticks(n), etc.).
  // No static ParamSpec build here.

  const sharedObjective: OptimizeObjective | null = effectiveJoint
    ? optimizeOverrides[directivePaths[0]].objective
    : null;

  // Tick config is resolved PER ZONE (inside the loop below) so each
  // zone gets the right values for its instrument symbol. Auto mode
  // (the default) reads from INSTRUMENT_TICK_SPECS in futures.ts;
  // manual mode falls back to rules.*. Selected sessions can mix
  // instruments, so a per-zone resolution is the only correct option.

  // Build the lookback budget per directive. Each directive may have
  // its own lookback amount; for joint mode we use the MAXIMUM so the
  // shared TPE has enough data for every dimension to be informed.
  const maxLookback = directivePaths.reduce(
    (m, p) => Math.max(m, optimizeOverrides[p].lookback),
    0
  );

  // Walk zones chronologically, optimizing-then-simulating each.
  for (let i = 0; i < sortedZones.length; i++) {
    if (cancelRef?.current) break;
    const z = sortedZones[i];
    const bars = barsByZoneId.get(z.id);
    if (!bars || bars.length === 0) {
      onProgress?.(i + 1, sortedZones.length);
      if (onSignalDone) await onSignalDone();
      continue;
    }

    // Resolve the rules to use for THIS signal. Default = baseRules,
    // patched per directive once each directive has filled its
    // lookback window. Until then the trade fires with literals
    // (warmup phase). Pre-warmup, varValues is seeded with any static
    // `default <num>` values from var declarations so filter.if
    // expressions referencing those vars resolve to the user's
    // declared default instead of NaN.
    let rulesForSignal: SimRules = baseRules;
    let varValues: Map<string, number> | null = preWarmupVarValues();

    if (trades.length >= maxLookback) {
      // Build the entry-bar EvalCtx for THIS signal — used to evaluate
      // bound expressions (`min: ticks(4)`, `max: ATR * 3`) before
      // building the per-signal ParamSpec. Same shape used by the
      // attachPrints path so behavior is consistent. Pre-resolution
      // varValues is null — the bounds expressions can't reference
      // a var that hasn't been resolved yet (would be a circular
      // dependency anyway).
      const entryCtx: EntryEvalCtx = buildEntryCtx(z, bars, null);

      // Evaluate every directive's bounds. Skip directives whose bounds
      // are invalid this signal (NaN, min >= max, step <= 0); fall back
      // to baseRules for those AND warn. The optimizer still runs on
      // any directives that DID resolve cleanly.
      const dynamicSpace: ParamSpec[] = [];
      const skippedThisSignal: string[] = [];
      for (const path of directivePaths) {
        const spec = optimizeOverrides[path];
        if (spec.kind !== "optimize-numeric") continue;
        const minV = evaluateExpr(spec.min.expr, { kind: "entry", ...entryCtx });
        const maxV = evaluateExpr(spec.max.expr, { kind: "entry", ...entryCtx });
        const stepV = spec.step
          ? evaluateExpr(spec.step.expr, { kind: "entry", ...entryCtx })
          : undefined;
        if (
          !Number.isFinite(minV) ||
          !Number.isFinite(maxV) ||
          minV >= maxV ||
          (stepV !== undefined && (!Number.isFinite(stepV) || stepV <= 0))
        ) {
          skippedThisSignal.push(path);
          warnings.push(
            `${path}: invalid bounds at signal ${i} (min=${minV}, max=${maxV}${stepV !== undefined ? `, step=${stepV}` : ""}); using literal default for this trade.`
          );
          continue;
        }
        dynamicSpace.push({
          kind: "numeric",
          name: path,
          min: minV,
          max: maxV,
          step: stepV,
        });
      }

      // No directive resolved cleanly → skip optimization, use literals.
      if (dynamicSpace.length > 0) {
        const activePaths = dynamicSpace.map((p) => p.name);
        const result = effectiveJoint
          ? optimizeJoint(
              dynamicSpace,
              sharedObjective!,
              trades,
              sortedZones,
              barsByZoneId,
              atrByZoneId,
              baseRules,
              optimizeOverrides,
              nTrialsPerSignal,
              warmupTrials,
              rng,
              i
            )
          : optimizeIndependent(
              activePaths,
              dynamicSpace,
              optimizeOverrides,
              trades,
              sortedZones,
              barsByZoneId,
              atrByZoneId,
              baseRules,
              nTrialsPerSignal,
              warmupTrials,
              rng,
              i
            );
        // SMA pass — replace each path's raw best-trial value with the
        // mean of the last K raws (K = directive's smooth window). The
        // smoothed value is what flows into applyParamsToRules below
        // AND what gets recorded as the row's `value`, so live trades
        // and the sparkline both see a consistent series. The raw
        // value is preserved on each history row as `rawValue` for
        // the panel's secondary trace. Integer params (those whose
        // bounds are all whole numbers this signal) are rounded after
        // averaging — keeps `stopLoss` ticks etc. as clean integers
        // even when the running mean is fractional.
        const rawByPath: Record<string, number> = {};
        for (const ps of dynamicSpace) {
          // dynamicSpace is built exclusively from optimize-numeric
          // directives (categorical Optimize is rejected at parse time
          // in v1), but ParamSpec is a union so we narrow defensively
          // before accessing min/max/step. Anything else is a no-op.
          if (ps.kind !== "numeric") continue;
          const path = ps.name;
          const raw = result.params[path];
          if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
          rawByPath[path] = raw;
          const window = smoothWindowByPath[path] ?? DEFAULT_SMOOTH_WINDOW;
          if (window <= 1) continue; // smoothing disabled — raw passes through
          const buf = smoothBuffers.get(path) ?? [];
          buf.push(raw);
          if (buf.length > window) buf.splice(0, buf.length - window);
          smoothBuffers.set(path, buf);
          let mean = 0;
          for (const v of buf) mean += v;
          mean /= buf.length;
          // Integer detection — bounds came in as numbers from the
          // dynamicSpace eval, so we just check whole-ness. Step
          // undefined ⇒ continuous range; honor int rounding only
          // when min/max are both whole AND step is also whole (or
          // omitted, since the user wrote a discrete-looking range).
          const minIsInt = Number.isInteger(ps.min);
          const maxIsInt = Number.isInteger(ps.max);
          const stepIsInt = ps.step === undefined || Number.isInteger(ps.step);
          if (minIsInt && maxIsInt && stepIsInt) {
            mean = Math.round(mean);
          }
          result.params[path] = mean;
        }
        rulesForSignal = applyParamsToRules(baseRules, result.params, optimizeOverrides);
        // Extract var.* paths from the resolved (post-smoothing) params
        // into a flat varValues map — filter.if conditions and
        // expressions referencing the var see the SMOOTHED value, so
        // they evaluate against the same number the trade actually used.
        varValues = varValuesFrom(result.params);
        // Record per-directive history (only for directives that
        // actually optimized this signal). `value` is the smoothed
        // (applied) value; `rawValue` is the pre-smoothing TPE pick.
        // When smoothing is off (window ≤ 1), they're equal — the
        // panel collapses to a single trace in that case.
        for (const path of activePaths) {
          const v = result.params[path];
          if (typeof v === "number") {
            const raw = rawByPath[path];
            history[path].push({
              tradeIndex: trades.length,
              value: v,
              rawValue: raw === undefined ? v : raw,
              smoothWindow: smoothWindowByPath[path] ?? DEFAULT_SMOOTH_WINDOW,
              objective: result.objectivePerPath[path] ?? NaN,
              trialsRun: nTrialsPerSignal,
            });
          }
        }
      }
    }

    // Build the post-optimization EntryEvalCtx — varValues now reflects
    // this signal's resolved values, so filter.if conditions can compare
    // against them. Also reused for attachPrints below.
    const ctxForSignal = buildEntryCtx(z, bars, varValues);

    // filter.if evaluation. AND-together every directive's verdict;
    // a "reject" anywhere drops the trade. Side effects (rule
    // overrides + filter prints) accumulate across all directives so
    // the user's mental model — "every filter.if line is independent"
    // — holds. NaN-as-fail discipline matches the simulator's
    // pre-optimizer path: if the cond can't be evaluated (warmup,
    // missing var), the trade routes to if_false → reject.
    //
    // Auto-disable: a directive whose cond references at least one
    // optimizer-driven var that hasn't been resolved yet (no value in
    // varValues, no `default <num>` clause) is SKIPPED — the filter is
    // off until its vars warm up. Without this, every filter that
    // gates on a var would reject every trade pre-warmup, and the
    // optimizer's lookback would never fill (deadlock).
    let filterPrints: Map<string, number> | null = null;
    if (filterIfs && filterIfs.length > 0) {
      let verdict: "pass" | "reject" = "pass";
      const ruleOverrides = new Map<string, number>();
      const accumulatedPrints = new Map<string, number>();
      // Track which directive index voted reject FIRST. Used to bump
      // metricsOut.filterRejections so the dashboard's per-run summary
      // can show "filter at index N rejected K signals." First-reject
      // semantics match the simulator path's evaluateAllFilterIfs —
      // see SimulateMetrics docstring for why we attribute to first
      // rather than all rejecting directives.
      let firstRejectIdx = -1;
      for (let dIdx = 0; dIdx < filterIfs.length; dIdx++) {
        const d = filterIfs[dIdx];
        // Per-directive auto-disable: if any var the cond references
        // is currently unresolved, skip THIS directive without
        // touching the running verdict. Only filters touching
        // unresolved vars get disabled — sibling filters that gate on
        // regular indicators still apply.
        if (d.referencedVarNames && d.referencedVarNames.size > 0) {
          let allResolved = true;
          for (const name of d.referencedVarNames) {
            if (!varValues || !varValues.has(name)) {
              allResolved = false;
              break;
            }
          }
          if (!allResolved) continue;
        }
        const fr = evaluateFilterIfDirective(d, ctxForSignal, warnings);
        if (fr.verdict === "reject") {
          verdict = "reject";
          if (firstRejectIdx === -1) firstRejectIdx = dIdx;
        }
        for (const [k, v] of fr.ruleOverrides) ruleOverrides.set(k, v);
        for (const [k, v] of fr.prints) accumulatedPrints.set(k, v);
      }
      if (verdict === "reject") {
        if (metricsOut && firstRejectIdx >= 0) {
          metricsOut.filterRejections.set(
            firstRejectIdx,
            (metricsOut.filterRejections.get(firstRejectIdx) ?? 0) + 1
          );
        }
        onProgress?.(i + 1, sortedZones.length);
        if (onSignalDone) await onSignalDone();
        continue;
      }
      // Stamp filter.if rule overrides onto rulesForSignal — they
      // win over the optimizer's rules (the user wrote them as a
      // per-trade conditional override).
      if (ruleOverrides.size > 0) {
        const stamped: Record<string, unknown> = {
          ...(rulesForSignal as unknown as Record<string, unknown>),
        };
        for (const [path, val] of ruleOverrides) {
          if (!path.startsWith("rules.")) continue;
          const key = path.slice("rules.".length);
          if (!NUMERIC_RULE_KEYS.has(key as keyof SimRules)) continue;
          stamped[key] = val;
        }
        rulesForSignal = stamped as unknown as SimRules;
      }
      if (accumulatedPrints.size > 0) filterPrints = accumulatedPrints;
    }

    const r = simulateZone(z, bars, rulesForSignal, atrByZoneId?.get(z.id) ?? null);
    if (r) {
      // Tag this trade as warmup vs post-warmup BEFORE the push — the
      // length check uses the array AS IT WAS just before this trade
      // was emitted, which matches the warmup gate at the top of the
      // loop. Used downstream by the dashboard (label warmup trades)
      // and by the Warmup=false filter at the end of this function.
      r.isWarmup = trades.length < maxLookback;
      attachPrints(ctxForSignal, r, filterPrints);
      trades.push(r);
    }
    onProgress?.(i + 1, sortedZones.length);
    if (onSignalDone) await onSignalDone();
  }

  // Warmup never happened? Surface a friendly warning so the user
  // doesn't see "no optimization history" silently.
  if (trades.length < maxLookback) {
    warnings.push(
      `Optimization never warmed up: only ${trades.length} trades emitted, lookback ${maxLookback}. Increase the data window or reduce the lookback.`
    );
  }

  // Warmup=false → exclude the pre-warmup trades from the FINAL return
  // so stats reflect only the optimized phase. The optimizer's internal
  // lookback math already used those trades during the loop above —
  // only the returned array is filtered. isWarmup tags stay on each
  // trade so the dashboard can independently show or hide them.
  const finalTrades = includeWarmupTrades
    ? trades
    : trades.filter((t) => !t.isWarmup);
  return { trades: finalTrades, optimizationHistory: history, warnings };
}

// ─── Joint mode — single TPE over the union of all dims ─────────────────────

interface OptimizeStepResult {
  params: Record<string, number>;
  /** Best objective per directive (in joint mode the single shared
   *  objective is broadcast to every directive). */
  objectivePerPath: Record<string, number>;
}

function optimizeJoint(
  space: ParamSpec[],
  objective: OptimizeObjective,
  trades: SimZoneResult[],
  sortedZones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  atrByZoneId: Map<number, number> | null,
  baseRules: SimRules,
  overrides: Record<string, OptimizeSpec>,
  nTrials: number,
  warmupTrials: number,
  rng: () => number,
  /** Index in sortedZones of the signal we're about to fire — used to
   *  identify which past zones to re-simulate (the lookback window's
   *  source zones). */
  signalIdx: number
): OptimizeStepResult {
  const tpe = createTpe(space, { warmupTrials });
  // Lookback for joint mode = max across all directives — needs enough
  // trades for every dim to be informed.
  const maxLookback = space.reduce((m, p) => {
    const spec = overrides[p.name];
    return Math.max(m, spec.lookback);
  }, 0);
  const lookbackZones = sliceLookbackZones(sortedZones, signalIdx, maxLookback, trades);

  for (let t = 0; t < nTrials; t++) {
    const params = suggest(tpe, rng) as Record<string, number>;
    const trialRules = applyParamsToRules(baseRules, params, overrides);
    const reSimmed = reSimulateZones(lookbackZones, barsByZoneId, atrByZoneId, trialRules);
    const summary = computeSimSummary(reSimmed);
    const obj = pickObjective(summary, objective);
    if (Number.isFinite(obj)) {
      observe(tpe, { params, objective: obj });
    }
  }
  const best = bestTrial(tpe);
  const params = (best?.params as Record<string, number>) ?? {};
  const objectivePerPath: Record<string, number> = {};
  for (const p of space) objectivePerPath[p.name] = best?.objective ?? NaN;
  return { params, objectivePerPath };
}

// ─── Independent mode — one TPE per directive, others held at literals ──────

function optimizeIndependent(
  /** Paths that resolved cleanly this signal — same length + order as
   *  `dynamicSpace`. The caller built both together so each path's
   *  ParamSpec is at the matching index. */
  activePaths: string[],
  /** Pre-evaluated ParamSpec[], one per active path. Bounds come from
   *  evaluating each spec's min/max/step against the entry-bar
   *  EvalCtx in the main loop, so they may vary per signal. */
  dynamicSpace: ParamSpec[],
  overrides: Record<string, OptimizeSpec>,
  trades: SimZoneResult[],
  sortedZones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  atrByZoneId: Map<number, number> | null,
  baseRules: SimRules,
  nTrials: number,
  warmupTrials: number,
  rng: () => number,
  signalIdx: number
): OptimizeStepResult {
  const params: Record<string, number> = {};
  const objectivePerPath: Record<string, number> = {};
  for (let idx = 0; idx < activePaths.length; idx++) {
    const path = activePaths[idx];
    const spec = overrides[path];
    if (spec.kind !== "optimize-numeric") continue;
    // Single-dim space — lift just THIS path's ParamSpec out of the
    // shared dynamicSpace array so each TPE runs against the right
    // bounds for this signal.
    const space: ParamSpec[] = [dynamicSpace[idx]];
    const tpe = createTpe(space, { warmupTrials });
    const lookbackZones = sliceLookbackZones(sortedZones, signalIdx, spec.lookback, trades);
    for (let t = 0; t < nTrials; t++) {
      const candidate = suggest(tpe, rng) as Record<string, number>;
      // Other directives held at their literal default — patch only
      // THIS path. baseRules already holds the literal for the
      // dashboard's current state.
      const trialRules = applyParamsToRules(baseRules, candidate, overrides);
      const reSimmed = reSimulateZones(lookbackZones, barsByZoneId, atrByZoneId, trialRules);
      const summary = computeSimSummary(reSimmed);
      const obj = pickObjective(summary, spec.objective);
      if (Number.isFinite(obj)) {
        observe(tpe, { params: candidate, objective: obj });
      }
    }
    const best = bestTrial(tpe);
    const v = (best?.params[path] as number) ?? baseRules[ruleKey(path)] ?? NaN;
    params[path] = v;
    objectivePerPath[path] = best?.objective ?? NaN;
  }
  return { params, objectivePerPath };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Re-simulate a slice of past zones under candidate rules. Returns the
 *  simulated trade results — the caller summarizes them and feeds the
 *  objective back to TPE. Skips zones missing bars (defensive — the
 *  lookback slice may include zones without cached bars). */
function reSimulateZones(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  atrByZoneId: Map<number, number> | null,
  rules: SimRules
): SimZoneResult[] {
  const out: SimZoneResult[] = [];
  for (const z of zones) {
    const bars = barsByZoneId.get(z.id);
    if (!bars || bars.length === 0) continue;
    const r = simulateZone(z, bars, rules, atrByZoneId?.get(z.id) ?? null);
    if (r) out.push(r);
  }
  return out;
}

/** Slice the source zones for the last N completed trades, where N is
 *  the directive's lookback amount. We use TRADES (not zones) for the
 *  count — many zones don't produce a trade (filtered, dropped, etc.)
 *  so a trade-count slice is what the user means by "last N trades".
 *  Maps each lookback trade back to its source zone. */
function sliceLookbackZones(
  sortedZones: TradeZone[],
  signalIdx: number,
  lookback: number,
  trades: SimZoneResult[]
): TradeZone[] {
  // All zones BEFORE the current signalIdx; we don't peek at the
  // future. The trades array is already populated for prior signals
  // only (the loop appends after simulating).
  const eligibleZones = sortedZones.slice(0, signalIdx);
  // Map zoneId → zone for fast lookup.
  const byId = new Map<number, TradeZone>();
  for (const z of eligibleZones) byId.set(z.id, z);
  // Take the last N trades; map back to their zones.
  const recentTrades = trades.slice(-lookback);
  const out: TradeZone[] = [];
  for (const t of recentTrades) {
    const z = byId.get(t.zoneId);
    if (z) out.push(z);
  }
  return out;
}

/** Patch baseRules with optimizer-resolved values. Only paths matching
 *  `rules.<key>` are recognized in v1. Returns a NEW object so
 *  baseRules stays untouched (the simulator depends on rules not
 *  mutating between calls). */
function applyParamsToRules(
  baseRules: SimRules,
  params: Record<string, unknown>,
  overrides: Record<string, OptimizeSpec>
): SimRules {
  let copy: Record<string, unknown> | null = null;
  for (const path of Object.keys(overrides)) {
    if (!path.startsWith("rules.")) continue;
    const v = params[path];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!copy) copy = { ...baseRules };
    copy[ruleKey(path)] = v;
  }
  return ((copy as unknown) as SimRules) ?? baseRules;
}

function ruleKey(path: string): keyof SimRules {
  return path.slice("rules.".length) as keyof SimRules;
}

/** Map an objective name to its numeric extraction from SimSummary.
 *  MinDrawdown is negated so the optimizer (which always MAXIMIZES)
 *  minimizes drawdown. */
function pickObjective(summary: SimSummary, obj: OptimizeObjective): number {
  switch (obj) {
    case "DailyEV":
      return summary.dailyEv;
    case "EV":
      return summary.expectancy;
    case "Sharpe":
      return summary.sharpeSimulated;
    case "MinDrawdown":
      return -summary.maxDrawdown;
    case "WinRate":
      return summary.winRate;
    case "ProfitFactor":
      // ProfitFactor returns Infinity when there are no losing trades —
      // this is mathematically correct but breaks TPE's KDE math.
      // Cap at a large finite value so the optimizer can still rank.
      return Number.isFinite(summary.profitFactor)
        ? summary.profitFactor
        : summary.totalPoints > 0
          ? 1e6
          : 0;
  }
}

// ─── Stable seed from script + sessions ─────────────────────────────────────

/** Build a deterministic seed for the run from the script source +
 *  selected session ids. Re-running the same script on the same data
 *  should produce the SAME optimization trace. Different scripts or
 *  different days produce different seeds. */
export function deriveSeed(scriptText: string, sessionIds: number[]): number {
  return hashStringToSeed(scriptText + "|" + [...sessionIds].sort((a, b) => a - b).join(","));
}
