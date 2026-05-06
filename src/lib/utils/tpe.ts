/**
 * tpe.ts — Tree-structured Parzen Estimator (TPE).
 *
 * TPE is a Bayesian-style hyperparameter search that beats random search by
 * fitting two density models — one over "good" trials (top γ-quantile by
 * objective), one over the rest — and proposing new candidates that
 * maximize the ratio g(x) / b(x). It works equally well for numeric and
 * categorical search spaces, which is exactly what the script DSL's
 * `Optimize.Obj.Unit(lookback, min, max[, step])` and
 * `Optimize.Obj.Unit(lookback, (opt1, opt2, ...))` forms need.
 *
 * Design choices:
 *   - Pure functions, no I/O. The caller owns the trial loop. Suggest →
 *     evaluate → observe is the same shape `optuna` uses.
 *   - Independent dimensions: numeric and categorical params are searched
 *     dimension-by-dimension. We DON'T model joint structure — keeps the
 *     code small and is fine for the small (1-5) param spaces this
 *     dashboard's Optimize directives produce.
 *   - Injected RNG (`() => number` returning [0, 1)). Deterministic when
 *     the caller passes a seeded PRNG; nondeterministic when they pass
 *     `Math.random`. The script-run worker will seed from a hash of the
 *     script text + selected sessions so re-running a script yields the
 *     same trace.
 *   - Warm-startable: `observe` mutates `state.history` in place; the
 *     online-optimizer feeds prior trades' trials back so a per-signal
 *     re-optimization picks up where the previous one left off, rather
 *     than restarting from scratch each trade.
 *
 * Maximization is the convention: we always MAXIMIZE objective. Callers
 * doing minimization should pass negated values (e.g. -drawdown).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ParamSpec =
  | {
      kind: "numeric";
      name: string;
      min: number;
      max: number;
      /** Optional discretization step. When set, all suggestions are
       *  snapped to `min + k * step` for integer k, clamped to [min, max].
       *  Useful for int-valued params where the user wants whole-number
       *  candidates. */
      step?: number;
    }
  | {
      kind: "categorical";
      name: string;
      options: Array<string | number>;
    };

/** A single observation: which params we tried and the resulting
 *  objective value. NaN-objective trials should be FILTERED OUT before
 *  observe — TPE assumes the history is well-defined. */
export interface Trial {
  params: Record<string, number | string>;
  objective: number;
}

export interface TpeConfig {
  /** Number of uniform-random trials before TPE switches on. Default 10.
   *  Below this count the suggest function returns plain random samples. */
  warmupTrials: number;
  /** Quantile defining "good" vs "bad" split. Default 0.25 (top-quartile
   *  goes into the good set). */
  gamma: number;
  /** How many candidates to evaluate via the g/b density ratio when
   *  proposing the next trial. Default 24. Higher = better candidate
   *  quality at proposal time, but more KDE evaluations. */
  nCandidates: number;
}

export interface TpeState {
  space: ParamSpec[];
  history: Trial[];
  config: TpeConfig;
}

const DEFAULT_CONFIG: TpeConfig = {
  warmupTrials: 10,
  gamma: 0.25,
  nCandidates: 24,
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function createTpe(space: ParamSpec[], opts: Partial<TpeConfig> = {}): TpeState {
  return {
    space,
    history: [],
    config: { ...DEFAULT_CONFIG, ...opts },
  };
}

/** Suggest the next trial's params. Pre-warmup: uniform random. Post-
 *  warmup: TPE acquisition (sample candidates, score by g/b ratio). */
export function suggest(state: TpeState, rng: () => number): Record<string, number | string> {
  if (state.history.length < state.config.warmupTrials) {
    return uniformSample(state.space, rng);
  }
  return tpeAcquire(state, rng);
}

/** Append a trial to the state's history. NaN/Infinity objectives are
 *  rejected — they corrupt the KDE math. The caller decides whether
 *  failed evaluations get a synthetic worst-case score or just dropped. */
export function observe(state: TpeState, trial: Trial): void {
  if (!Number.isFinite(trial.objective)) return;
  state.history.push(trial);
}

/** Convenience: returns the best trial seen so far (highest objective).
 *  Returns undefined if no observations yet. */
export function bestTrial(state: TpeState): Trial | undefined {
  if (state.history.length === 0) return undefined;
  let best = state.history[0];
  for (const t of state.history) {
    if (t.objective > best.objective) best = t;
  }
  return best;
}

// ─── Random sampling (warmup phase) ─────────────────────────────────────────

function uniformSample(space: ParamSpec[], rng: () => number): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const param of space) {
    if (param.kind === "numeric") {
      out[param.name] = sampleUniformNumeric(param, rng);
    } else {
      const idx = Math.floor(rng() * param.options.length);
      out[param.name] = param.options[Math.min(idx, param.options.length - 1)];
    }
  }
  return out;
}

function sampleUniformNumeric(
  param: Extract<ParamSpec, { kind: "numeric" }>,
  rng: () => number
): number {
  const raw = param.min + rng() * (param.max - param.min);
  return snapToStep(raw, param);
}

function snapToStep(
  value: number,
  param: Extract<ParamSpec, { kind: "numeric" }>
): number {
  let v = value;
  if (param.step !== undefined && param.step > 0) {
    const k = Math.round((v - param.min) / param.step);
    v = param.min + k * param.step;
  }
  // Clamp at the end so a step that doesn't evenly divide the range
  // doesn't push us out of bounds.
  if (v < param.min) v = param.min;
  if (v > param.max) v = param.max;
  return v;
}

// ─── TPE acquisition (post-warmup) ──────────────────────────────────────────

function tpeAcquire(state: TpeState, rng: () => number): Record<string, number | string> {
  const { space, history, config } = state;
  const sorted = [...history].sort((a, b) => b.objective - a.objective);
  const gammaCount = Math.max(1, Math.ceil(sorted.length * config.gamma));
  const good = sorted.slice(0, gammaCount);
  const bad = sorted.slice(gammaCount);
  // Defensive: we need at least one "bad" example for the density
  // ratio. With only a single trial post-warmup that won't be true,
  // but we already gate on history.length >= warmupTrials (default
  // 10) so in practice good ≥ 2 and bad ≥ 8.
  if (bad.length === 0) return uniformSample(space, rng);

  const out: Record<string, number | string> = {};
  for (const param of space) {
    out[param.name] =
      param.kind === "numeric"
        ? acquireNumeric(param, good, bad, config.nCandidates, rng)
        : acquireCategorical(param, good, bad, rng);
  }
  return out;
}

/** Numeric dimension: sample `nCandidates` from a Gaussian KDE fit to the
 *  good set, score each candidate by `g(x) / (b(x) + ε)`, return the
 *  argmax. Bandwidth uses Scott's rule (stdev × n^{-1/5}) with a small
 *  floor so a very-tight good set doesn't degenerate to a delta function.
 *  An EI-style "expected improvement" criterion would be marginally
 *  better but the ratio criterion is the standard TPE proposal and is
 *  cheaper. */
function acquireNumeric(
  param: Extract<ParamSpec, { kind: "numeric" }>,
  good: Trial[],
  bad: Trial[],
  nCandidates: number,
  rng: () => number
): number {
  const goodValues = good.map((t) => t.params[param.name] as number);
  const badValues = bad.map((t) => t.params[param.name] as number);
  const goodBw = bandwidth(goodValues, param);
  const badBw = bandwidth(badValues, param);

  let bestX = sampleUniformNumeric(param, rng);
  let bestScore = -Infinity;
  for (let i = 0; i < nCandidates; i++) {
    // Sample candidate from a Gaussian centered on a randomly-chosen
    // good observation. This is the standard TPE proposal mechanism —
    // mixture model: pick a kernel, jitter, snap.
    const center = goodValues[Math.floor(rng() * goodValues.length)];
    const raw = center + gaussianSample(rng) * goodBw;
    const candidate = snapToStep(raw, param);
    const g = kdeDensity(candidate, goodValues, goodBw);
    const b = kdeDensity(candidate, badValues, badBw);
    const score = g / (b + 1e-12);
    if (score > bestScore) {
      bestScore = score;
      bestX = candidate;
    }
  }
  return bestX;
}

/** Categorical dimension: count occurrences in good vs bad, pick the
 *  option with the highest Laplace-smoothed ratio. With small good/bad
 *  sets the Laplace prior matters — without it, a single occurrence
 *  carries infinite weight relative to an unobserved option. */
function acquireCategorical(
  param: Extract<ParamSpec, { kind: "categorical" }>,
  good: Trial[],
  bad: Trial[],
  rng: () => number
): string | number {
  const counts = new Map<string | number, { g: number; b: number }>();
  for (const opt of param.options) counts.set(opt, { g: 0, b: 0 });
  for (const t of good) {
    const v = t.params[param.name];
    const slot = counts.get(v);
    if (slot) slot.g++;
  }
  for (const t of bad) {
    const v = t.params[param.name];
    const slot = counts.get(v);
    if (slot) slot.b++;
  }
  let bestOpt: string | number = param.options[0];
  let bestScore = -Infinity;
  // Laplace smoothing: add 1 to numerator, |options| to denominator
  // baseline. Equivalent to a uniform prior with strength = options
  // count.
  for (const opt of param.options) {
    const c = counts.get(opt)!;
    const score = (c.g + 1) / (c.b + param.options.length);
    if (score > bestScore) {
      bestScore = score;
      bestOpt = opt;
    }
  }
  // Tiny exploration probability — even if one option dominates the
  // observed history, occasionally pick a less-explored option so a
  // truly-better region eventually gets seen. Threshold 5% matches
  // the ε in classic ε-greedy bandits.
  if (rng() < 0.05) {
    return param.options[Math.floor(rng() * param.options.length)];
  }
  return bestOpt;
}

// ─── KDE math ───────────────────────────────────────────────────────────────

/** Scott's rule with a small floor. The floor prevents the KDE from
 *  collapsing to a delta when all good observations land at the same
 *  value (common in our use case — categorical-feeling numerics that
 *  snap to a step). The floor is 1% of the parameter's range so it
 *  scales naturally with the search space. */
function bandwidth(
  values: number[],
  param: Extract<ParamSpec, { kind: "numeric" }>
): number {
  const range = Math.max(0, param.max - param.min);
  const floor = Math.max(1e-9, range * 0.01);
  if (values.length < 2) return Math.max(floor, range * 0.1);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  let variance = 0;
  for (const v of values) variance += (v - mean) * (v - mean);
  variance /= values.length - 1;
  const sigma = Math.sqrt(Math.max(variance, 0));
  const scotts = sigma * Math.pow(values.length, -1 / 5);
  return Math.max(scotts, floor);
}

/** Sum-of-Gaussians density at point `x`. We don't normalize the kernel
 *  count — both g and b use the same N-divisor implicitly via the same
 *  formula, so the ratio g/b cancels it out. */
function kdeDensity(x: number, values: number[], bw: number): number {
  if (values.length === 0) return 0;
  let sum = 0;
  const denom = 2 * bw * bw;
  for (const v of values) {
    const d = x - v;
    sum += Math.exp(-(d * d) / denom);
  }
  return sum / (values.length * bw * Math.sqrt(2 * Math.PI));
}

/** Standard-normal sample via Box-Muller. We discard the second draw —
 *  Box-Muller produces pairs but caching the leftover across calls would
 *  break determinism when the caller resets the RNG mid-run. */
function gaussianSample(rng: () => number): number {
  // Avoid log(0) by clamping u away from exactly 0.
  let u = rng();
  if (u < 1e-12) u = 1e-12;
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Seeded RNG (for deterministic runs) ────────────────────────────────────
//
// Mulberry32 — small, fast, decent statistical quality. Used by the
// script-run worker to seed from a hash of (script text + sessions) so
// re-running the same script produces an identical optimization trace.

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash from a string. cyrb53-derived; collisions don't
 *  matter for our use case — we just need different scripts to produce
 *  different seeds. */
export function hashStringToSeed(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}
