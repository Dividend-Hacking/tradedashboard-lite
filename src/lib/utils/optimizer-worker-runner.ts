/**
 * Optimizer Worker Runner
 *
 * Main-thread façade for the optimizer worker. Each runner here spawns a
 * fresh dedicated worker, posts a typed `start` message, forwards progress
 * to the caller's callback, and resolves with the final result. The chunked
 * runners also poll an optional `cancelRef` and forward a `cancel` message
 * to the worker if it flips — same cancel API the previous rAF-based
 * runners exposed, so call sites don't have to change shape.
 *
 * Why per-call workers (vs. a shared singleton):
 *   - Ergonomics: each call is a self-contained Promise. No "is the worker
 *     busy?" bookkeeping on the main thread.
 *   - Cleanup: terminate on completion so memory + bar-map references get
 *     released immediately. Long-lived shared workers hold onto the most
 *     recent payload.
 *   - The UI already disables every other optimizer button while one is
 *     running, so we never spawn two concurrently in practice.
 *
 * Worker init overhead is small (~10-30ms) compared to even the fastest
 * optimizer runs, so the per-call cost is acceptable. The big win is that
 * runs continue at full speed when the tab is backgrounded — rAF-throttled
 * loops would crawl or stall instead.
 */

"use client";

import type { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import type { SimRules } from "./zone-simulator";
import type {
  OptimizeConfig,
  AtrAdjustOptimizeConfig,
  OptimizeResult,
} from "./zone-optimizer";
import type { TimeOptimizeResult } from "./time-optimizer";
import type {
  AdxOptResult,
  AtrOptResult,
  TrendOptResult,
  BollingerOptResult,
  RsiOptResult,
  BbWidthOptResult,
  MaDistanceOptResult,
  VolumeOptResult,
  AdxTrendOptResult,
} from "./context-optimizer";
import type {
  StrategyParamOptimizeResult,
  IndicatorConfig,
} from "./backtest-engine";
import type { ReplayBar } from "@/types/replay";

// ─── Message shapes ─────────────────────────────────────────────────────────
// Mirror the worker's `IncomingMsg` / outgoing format. Kept in this file
// (not shared) so the worker can stay free of main-thread imports.

type StartMsg =
  | {
      kind: "start";
      type: "sl-tp-tsl";
      zones: TradeZone[];
      bars: Map<number, TradeZoneBar[]>;
      rules: SimRules;
      config: OptimizeConfig;
      atr?: Map<number, number> | null;
    }
  | {
      kind: "start";
      type: "atr-adjust";
      zones: TradeZone[];
      bars: Map<number, TradeZoneBar[]>;
      rules: SimRules;
      config: AtrAdjustOptimizeConfig;
      atr?: Map<number, number> | null;
    }
  | {
      kind: "start";
      type: "time";
      zones: TradeZone[];
      bars: Map<number, TradeZoneBar[]>;
      rules: SimRules;
      minWindowMinutes: number;
      atr?: Map<number, number> | null;
    }
  | {
      kind: "start";
      type:
        | "context-adx"
        | "context-atr"
        | "context-trend"
        | "context-bollinger"
        | "context-rsi"
        | "context-bbwidth"
        | "context-madistance"
        | "context-volume"
        | "context-adxtrend";
      basePool: TradeZone[];
      bars: Map<number, TradeZoneBar[]>;
      rules: SimRules;
      atr?: Map<number, number> | null;
    }
  | {
      kind: "start";
      type: "strategy-param";
      sessions: { instrument: string; bars: ReplayBar[] }[];
      strategyId: string;
      baseParams: Record<string, number>;
      paramKey: string;
      range: { min: number; max: number; step: number };
      rules: SimRules;
      // Optional — older callers omit. Plumbs the dashboard's indicator
      // periods into the worker's per-candidate backtest so optimizer
      // results respect the user's ATR/ADX/EMA/BB customization.
      indicatorConfig?: IndicatorConfig;
    };

type ResponseMsg =
  | { kind: "progress"; value: number }
  | { kind: "done"; result: unknown };

// ─── Worker spawn helper ────────────────────────────────────────────────────
// One worker per call. Wires up message handling, optional progress
// forwarding, and optional cancel polling. Resolves when the worker posts
// `done` (whether from natural completion or from a cancel-induced
// generator-return).
function spawn<R>(
  start: StartMsg,
  onProgress: ((p: number) => void) | null,
  cancelRef: { current: boolean } | undefined
): Promise<R> {
  return new Promise<R>((resolve) => {
    // The `new URL(..., import.meta.url)` syntax is the Webpack 5 / Next.js
    // pattern for code-splitting a worker entry point. Webpack picks this up
    // at build time and emits a separate worker bundle.
    //
    // No `{ type: "module" }` here on purpose: Webpack handles the worker
    // bundle itself (single classic-script chunk, no runtime ESM imports).
    // Passing module triggers a different code path in Next.js that has
    // historically caused dev-server bundling hangs.
    const worker = new Worker(
      new URL("../workers/optimizer.worker.ts", import.meta.url)
    );

    // We can't pass a refobject across postMessage, so instead we poll the
    // ref on a short interval and forward a `cancel` message when it flips.
    // 100ms cadence: fast enough to feel responsive, slow enough that the
    // polling itself is invisible.
    let cancelInterval: ReturnType<typeof setInterval> | null = null;
    let cancelSent = false;

    function cleanup() {
      if (cancelInterval !== null) {
        clearInterval(cancelInterval);
        cancelInterval = null;
      }
      worker.terminate();
    }

    worker.onmessage = (e: MessageEvent<ResponseMsg>) => {
      const msg = e.data;
      if (msg.kind === "progress") {
        if (onProgress) onProgress(msg.value);
      } else if (msg.kind === "done") {
        cleanup();
        resolve(msg.result as R);
      }
    };

    // Errors inside the worker would otherwise leave the promise pending.
    // Treat them as a graceful "no result" — surface via console so we
    // notice in dev, then resolve with null to unblock the caller. Callers
    // already handle null returns (context optimizers can legitimately
    // return null; the chunked optimizers' callers tolerate undefined).
    worker.onerror = (err) => {
      console.error("[optimizer-worker] worker error:", err.message ?? err);
      cleanup();
      resolve(null as unknown as R);
    };

    if (cancelRef) {
      cancelInterval = setInterval(() => {
        if (cancelRef.current && !cancelSent) {
          cancelSent = true;
          worker.postMessage({ kind: "cancel" });
        }
      }, 100);
    }

    worker.postMessage(start);
  });
}

// ─── Public runners — one per optimizer type ────────────────────────────────
// Signatures intentionally match the previous rAF-based runners so the
// existing call sites in zone-optimizer.ts / time-optimizer.ts can delegate
// without changing their public APIs.

export function runOptimizeInWorker(
  zones: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  config: OptimizeConfig,
  onProgress: (p: number) => void,
  cancelRef?: { current: boolean },
  atr?: Map<number, number> | null
): Promise<OptimizeResult> {
  return spawn<OptimizeResult>(
    { kind: "start", type: "sl-tp-tsl", zones, bars, rules, config, atr },
    onProgress,
    cancelRef
  );
}

export function runAtrAdjustOptimizeInWorker(
  zones: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  config: AtrAdjustOptimizeConfig,
  onProgress: (p: number) => void,
  cancelRef?: { current: boolean },
  atr?: Map<number, number> | null
): Promise<OptimizeResult> {
  return spawn<OptimizeResult>(
    { kind: "start", type: "atr-adjust", zones, bars, rules, config, atr },
    onProgress,
    cancelRef
  );
}

export function runTimeOptimizeInWorker(
  zones: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  minWindowMinutes: number,
  onProgress: (p: number) => void,
  cancelRef?: { current: boolean },
  atr?: Map<number, number> | null
): Promise<TimeOptimizeResult> {
  return spawn<TimeOptimizeResult>(
    {
      kind: "start",
      type: "time",
      zones,
      bars,
      rules,
      minWindowMinutes,
      atr,
    },
    onProgress,
    cancelRef
  );
}

// ─── Context-optimizer async wrappers ───────────────────────────────────────
// These were synchronous on the main thread before. Keeping them on a worker
// means a small async hop, but in exchange they (a) don't freeze the UI for
// their ~100ms run and (b) run at full speed when the tab is backgrounded —
// same motivation as the chunked optimizers above.

export function optimizeAdxInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<AdxOptResult | null> {
  return spawn<AdxOptResult | null>(
    { kind: "start", type: "context-adx", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeAtrInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<AtrOptResult | null> {
  return spawn<AtrOptResult | null>(
    { kind: "start", type: "context-atr", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeTrendInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<TrendOptResult | null> {
  return spawn<TrendOptResult | null>(
    { kind: "start", type: "context-trend", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeBollingerInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<BollingerOptResult | null> {
  return spawn<BollingerOptResult | null>(
    { kind: "start", type: "context-bollinger", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeRsiInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<RsiOptResult | null> {
  return spawn<RsiOptResult | null>(
    { kind: "start", type: "context-rsi", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeBbWidthInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<BbWidthOptResult | null> {
  return spawn<BbWidthOptResult | null>(
    { kind: "start", type: "context-bbwidth", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeMaDistanceInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<MaDistanceOptResult | null> {
  return spawn<MaDistanceOptResult | null>(
    { kind: "start", type: "context-madistance", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeVolumeInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<VolumeOptResult | null> {
  return spawn<VolumeOptResult | null>(
    { kind: "start", type: "context-volume", basePool, bars, rules, atr },
    null,
    undefined
  );
}

export function optimizeAdxTrendInWorker(
  basePool: TradeZone[],
  bars: Map<number, TradeZoneBar[]>,
  rules: SimRules,
  atr: Map<number, number> | null
): Promise<AdxTrendOptResult | null> {
  return spawn<AdxTrendOptResult | null>(
    { kind: "start", type: "context-adxtrend", basePool, bars, rules, atr },
    null,
    undefined
  );
}

// ─── Per-strategy-param optimizer runner ────────────────────────────────────
// Sweeps a single strategy parameter across its UI-defined range and picks
// the value that maximizes total scaledPoints across the selected sessions.
// Used by the OPT buttons next to each numeric input on the backtesting tab.
// Heavier than the SL/TP/TSL optimizer (each candidate re-runs the full
// signal-generation + simulator pipeline), so it's worth running in the
// worker even when the range is small — keeps the UI responsive.

export function runStrategyParamOptimizeInWorker(
  sessions: { instrument: string; bars: ReplayBar[] }[],
  strategyId: string,
  baseParams: Record<string, number>,
  paramKey: string,
  range: { min: number; max: number; step: number },
  rules: SimRules,
  onProgress: (p: number) => void,
  cancelRef?: { current: boolean },
  /** Optional — pass the dashboard's current indicator config so the
   *  optimizer's per-candidate backtests use the same ATR/ADX/EMA/BB
   *  periods the user is configured with. Omitted callers get the
   *  legacy hardcoded defaults. */
  indicatorConfig?: IndicatorConfig
): Promise<StrategyParamOptimizeResult> {
  return spawn<StrategyParamOptimizeResult>(
    {
      kind: "start",
      type: "strategy-param",
      sessions,
      strategyId,
      baseParams,
      paramKey,
      range,
      rules,
      indicatorConfig,
    },
    onProgress,
    cancelRef
  );
}

// ─── Backward-compatible aliases ────────────────────────────────────────────
// The chunked-runner names (`runOptimizeChunked`, `runAtrAdjustOptimizeChunked`,
// `runTimeOptimizeChunked`) used to live in zone-optimizer.ts / time-optimizer.ts
// and called rAF-based loops. They're now thin aliases for the worker-backed
// runners above so existing call sites keep working without hunting through
// imports. Re-exporting from here (rather than re-exporting INSIDE the
// optimizer files) avoids the import cycle that confused Webpack's worker
// bundler — the optimizer modules now have zero dependency on this file, so
// the worker chunk doesn't recursively try to re-bundle the spawn helper.

export const runOptimizeChunked = runOptimizeInWorker;
export const runAtrAdjustOptimizeChunked = runAtrAdjustOptimizeInWorker;
export const runTimeOptimizeChunked = runTimeOptimizeInWorker;
