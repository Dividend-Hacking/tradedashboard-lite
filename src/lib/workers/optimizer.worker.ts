/**
 * Optimizer Web Worker
 *
 * Runs every optimizer the dashboard exposes (SL/TP/TSL, ATR-Adjust, Time
 * window, and the four context optimizers — ADX/ATR/Trend/Bollinger) on a
 * background thread. The motivation: requestAnimationFrame is heavily
 * throttled when the browser tab is backgrounded, so the previous rAF-chunked
 * runners would crawl (or stall entirely) while the user worked in another
 * tab. Workers don't share that throttling — they keep running at full speed
 * regardless of tab visibility.
 *
 * Protocol (discriminated by `kind`):
 *   in:  { kind: "start", type, ...payload }   — begin an optimizer run
 *   in:  { kind: "cancel" }                     — abort the current run
 *   out: { kind: "progress", value: 0..1 }      — generator yield checkpoint
 *   out: { kind: "done", result }               — final result (or null for
 *                                                 context optimizers with no
 *                                                 valid candidate)
 *
 * The chunked optimizers use generators that already yield progress every
 * ~200 combos. Inside the worker we just pump the generator: between each
 * yield we hand control back to the worker's event loop via setTimeout(0)
 * so an inbound `cancel` message can be processed promptly. The `cancel`
 * path calls `gen.return(...)` which lets the generator emit its
 * "best-so-far" result — same semantics as the old rAF runner.
 *
 * The context optimizers are synchronous (they iterate small fixed grids)
 * and just resolve once finished. No progress messages are sent for those —
 * they typically complete in well under a second.
 */

import { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import { SimRules } from "@/lib/utils/zone-simulator";
import {
  optimizeGenerator,
  atrAdjustOptimizeGenerator,
  type OptimizeConfig,
  type AtrAdjustOptimizeConfig,
  type OptimizeResult,
} from "@/lib/utils/zone-optimizer";
import {
  timeOptimizeGenerator,
  type TimeOptimizeResult,
} from "@/lib/utils/time-optimizer";
import {
  optimizeAdx,
  optimizeAtr,
  optimizeTrend,
  optimizeBollinger,
  optimizeRsi,
  optimizeBbWidth,
  optimizeMaDistance,
  optimizeVolume,
  optimizeAdxTrend,
} from "@/lib/utils/context-optimizer";
import {
  strategyParamOptimizeGenerator,
  type StrategyParamOptimizeResult,
} from "@/lib/utils/backtest-engine";
import type { ReplayBar } from "@/types/replay";

// Minimal local typing for the worker global scope. The project's tsconfig
// uses lib: ["dom", ...] so the standard DedicatedWorkerGlobalScope type
// isn't in scope here — declaring it locally avoids pulling in the
// "webworker" lib which would conflict with DOM types elsewhere.
const ctx = self as unknown as {
  onmessage: ((this: unknown, e: MessageEvent) => void) | null;
  postMessage: (msg: unknown) => void;
};

// ─── Message shape ───────────────────────────────────────────────────────────

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
      // Indicator config is optional on the wire — older callers omit it
      // and the generator falls back to DEFAULT_INDICATOR_CONFIG. Newer
      // dashboard callers include it so the optimizer's per-candidate
      // backtests use the same indicator periods the user is currently
      // configured with.
      indicatorConfig?: import("@/lib/utils/backtest-engine").IndicatorConfig;
    };

type IncomingMsg = StartMsg | { kind: "cancel" };

// ─── Cancellation flag ───────────────────────────────────────────────────────
// Flipped when a `cancel` message arrives. Checked between generator yields.
// Per-call: reset to false at the start of each new run.
let cancelled = false;

// ─── Generator pump ──────────────────────────────────────────────────────────
// Drives a generator to completion by stepping it one yield at a time and
// posting progress messages. Yields control back to the event loop after each
// step via setTimeout(0) so the worker can receive cancel messages between
// chunks. The generator itself yields every ~200 combos, so chunk granularity
// is set by the generator, not the runner.
function pumpGenerator<R>(
  gen: Generator<{ progress: number; current?: unknown }, R, void>
): void {
  function step() {
    if (cancelled) {
      // Drain the generator's "return" path — yields its best-so-far value.
      const final = gen.return(undefined as unknown as R);
      done(final.value);
      return;
    }
    const next = gen.next();
    if (next.done) {
      done(next.value);
      return;
    }
    ctx.postMessage({ kind: "progress", value: next.value.progress });
    // Hand control back to the event loop so a `cancel` message can be
    // processed before the next chunk. setTimeout(0) is enough — workers
    // don't have a 4ms minimum delay the way main-thread setTimeout does.
    setTimeout(step, 0);
  }
  step();
}

function done(result: unknown): void {
  ctx.postMessage({ kind: "done", result });
}

// ─── Message dispatch ────────────────────────────────────────────────────────

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data as IncomingMsg;

  if (msg.kind === "cancel") {
    cancelled = true;
    return;
  }

  if (msg.kind !== "start") return;

  // Reset cancel state for the new run. `done` always fires once per start
  // so the pair stays balanced.
  cancelled = false;

  switch (msg.type) {
    case "sl-tp-tsl": {
      const gen = optimizeGenerator(
        msg.zones,
        msg.bars,
        msg.rules,
        msg.config,
        msg.atr ?? null
      );
      pumpGenerator<OptimizeResult>(gen);
      return;
    }
    case "atr-adjust": {
      const gen = atrAdjustOptimizeGenerator(
        msg.zones,
        msg.bars,
        msg.rules,
        msg.config,
        msg.atr ?? null
      );
      pumpGenerator<OptimizeResult>(gen);
      return;
    }
    case "time": {
      const gen = timeOptimizeGenerator(
        msg.zones,
        msg.bars,
        msg.rules,
        msg.minWindowMinutes,
        msg.atr ?? null
      );
      pumpGenerator<TimeOptimizeResult>(gen);
      return;
    }
    case "context-adx": {
      const r = optimizeAdx(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "context-atr": {
      const r = optimizeAtr(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "context-trend": {
      const r = optimizeTrend(
        msg.basePool,
        msg.bars,
        msg.rules,
        msg.atr ?? null
      );
      done(r);
      return;
    }
    case "context-bollinger": {
      const r = optimizeBollinger(
        msg.basePool,
        msg.bars,
        msg.rules,
        msg.atr ?? null
      );
      done(r);
      return;
    }
    case "context-rsi": {
      const r = optimizeRsi(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "context-bbwidth": {
      const r = optimizeBbWidth(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "context-madistance": {
      const r = optimizeMaDistance(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "context-volume": {
      const r = optimizeVolume(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "context-adxtrend": {
      const r = optimizeAdxTrend(msg.basePool, msg.bars, msg.rules, msg.atr ?? null);
      done(r);
      return;
    }
    case "strategy-param": {
      // Per-strategy-param sweep. Each candidate re-runs the full
      // backtest pipeline (signal generation + simulator + post-passes),
      // so this is heavier than the SL/TP/TSL grid. The generator yields
      // after every candidate to let cancels through.
      const gen = strategyParamOptimizeGenerator({
        sessions: msg.sessions,
        strategyId: msg.strategyId,
        baseParams: msg.baseParams,
        paramKey: msg.paramKey,
        range: msg.range,
        rules: msg.rules,
        indicatorConfig: msg.indicatorConfig,
      });
      pumpGenerator<StrategyParamOptimizeResult>(gen);
      return;
    }
  }
};

// Empty export keeps this module-mode for TypeScript/Webpack despite no
// public exports. Without this, the file is treated as a script and the
// path-aliased imports above don't resolve correctly.
export {};
