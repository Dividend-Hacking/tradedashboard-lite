/**
 * legacy-filter-synth.ts — Convert legacy preset filters into synthesized
 * `filter.if` directives at transpile time.
 *
 * Background: the dashboard backtester recognizes ~10 legacy preset-filter
 * families (`filters.adx.*`, `filters.atr.*`, `filters.rsi.*`,
 * `filters.bollinger.*`, `filters.bbWidth.*`, `filters.maDistance.*`,
 * `filters.volume.*`, `filters.adxTrend.*`, `filters.delta.*`,
 * `filters.time.*`, `filters.trend.*`) plus the modern conditional family
 * (`filter.if`, `filter.long.if`, `filter.short.if`). The conditional
 * family transpiles cleanly to NT8 and works there. The legacy preset
 * families — except `filters.time.*` and `filters.trend.*` — were
 * silently dropped by the dashboard→NT8 transpiler before this module
 * existed, producing trade-count divergence in parity checks.
 *
 * This module reproduces `preset-filters.ts` semantics by building Expr
 * AST trees that, when fed through the proven `filter-if-emit.ts`
 * pipeline, generate identical-semantics C# to a hand-written
 * `filter.if`. Single source of truth in TS; near-zero new C# code on
 * the NT8 side (every indicator we need — Adx/Atr/Rsi/BbUpper/BbLower/
 * BbWidth/Ema/Sma/VolumeMa — is already in DslIndicators.cs).
 *
 * `filters.time.*` and `filters.trend.*` are intentionally NOT
 * synthesized here — they stay on the native PresetFiltersData path in
 * `strategy-emit.ts:renderFiltersBlock` because (a) `time` has multi-
 * window wrap-around that's clearer in C#, and (b) `trend` is direction-
 * aware and the native `TrendFilterPasses("Long"/"Short")` dispatch is
 * cleanest. If parity testing reveals either is broken in NT8, extend
 * this module to cover them.
 *
 * NaN-as-fail discipline: each synthesized `filter.if` cond uses
 * comparison binops which `expr-emit.ts:emitBinop` emits with the
 * `(double.IsNaN(a) || double.IsNaN(b)) ? double.NaN : ...` guard.
 * `filter-if-emit.ts:emitDirectiveBody` then wraps the cond in
 * `if (Dsl.IsFinite(__cond) && __cond != 0.0)`, so a NaN indicator at
 * warmup falls through to the empty `ifFalse` slot which emits
 * `__verdict = 0` (reject). Bit-for-bit equivalent to
 * `preset-filters.ts:58` `if (ctx.ctx_adx14 == null) return false`.
 */

import type { Expr } from "../script-expr";
import type { FilterIfDirective } from "../backtest-script";

// ─── Expr constructors ────────────────────────────────────────────────────
//
// script-expr.ts exports the Expr type but no constructor helpers, so we
// build object literals directly. Keeping these as tiny named helpers
// makes the per-filter conversion readable as conjunctions of comparisons
// rather than a wall of `{ kind: "binop", op: ..., lhs: ..., rhs: ... }`.

function num(value: number): Expr {
  return { kind: "num", value };
}

function ident(name: string): Expr {
  return { kind: "ident", name };
}

function call(name: string, args: Expr[]): Expr {
  return { kind: "call", name, args };
}

type CmpOp = ">" | "<" | ">=" | "<=" | "==" | "!=";
type ArithOp = "+" | "-" | "*" | "/" | "%" | "^";
type LogicOp = "&&" | "||";

function cmp(op: CmpOp, lhs: Expr, rhs: Expr): Expr {
  return { kind: "binop", op, lhs, rhs };
}

function arith(op: ArithOp, lhs: Expr, rhs: Expr): Expr {
  return { kind: "binop", op, lhs, rhs };
}

function and(lhs: Expr, rhs: Expr): Expr {
  return { kind: "binop", op: "&&", lhs, rhs };
}

function or(lhs: Expr, rhs: Expr): Expr {
  return { kind: "binop", op: "||", lhs, rhs };
}

/** AND-fold a list of expressions into `a && b && c && ...`. Empty list
 *  returns the literal `1` (always-true) so callers can build conditional
 *  conjunctions without special-casing the empty case. */
function andAll(parts: Expr[]): Expr {
  if (parts.length === 0) return num(1);
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) acc = and(acc, parts[i]);
  return acc;
}

/** OR-fold a list of expressions into `a || b || c || ...`. Empty list
 *  returns the literal `0` (always-false) which preserves the dashboard's
 *  reject-all behavior when `bollinger.allowed[]` is empty. */
function orAll(parts: Expr[]): Expr {
  if (parts.length === 0) return num(0);
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) acc = or(acc, parts[i]);
  return acc;
}

/** Postfix indexing: `expr[offset]`. Used by `filters.adxTrend` to look
 *  back N bars on an indicator series for slope calculation. */
function index(base: Expr, offset: Expr): Expr {
  return { kind: "index", base, offset };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Permissive boolean read on an `enabled` flag. The transpiler's
 *  `parsePermissiveValue` returns `true`/`false`/strings-like-"true"/the
 *  bare ident "true"/etc. We accept anything truthy as "enabled". */
function isEnabled(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const enabled = (block as Record<string, unknown>).enabled;
  if (enabled === true) return true;
  if (typeof enabled === "string") return enabled.toLowerCase() === "true";
  return false;
}

/** Read a numeric field with a default. NaN/non-finite/non-numeric all
 *  fall through to `defaultValue` so the synthesizer never emits NaN
 *  literals into the AST (which would propagate through the binop NaN
 *  guard and reject every trade). */
function numField(
  block: Record<string, unknown> | undefined | null,
  key: string,
  defaultValue: number
): number {
  if (!block) return defaultValue;
  const v = block[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return defaultValue;
}

/** Read a string enum field with a default. Returns the lowercased value. */
function strField(
  block: Record<string, unknown> | undefined | null,
  key: string,
  defaultValue: string
): string {
  if (!block) return defaultValue;
  const v = block[key];
  if (typeof v === "string") return v.toLowerCase();
  return defaultValue;
}

/** Wrap a synthesized cond into a FilterIfDirective with empty branches.
 *  Empty `ifTrue` => default-pass on true; empty `ifFalse` =>
 *  default-reject on false (see filter-if-emit.ts:280-281).
 *  `source` is a human-readable label for the .cs comment / serializer
 *  round-trip; pretty-prints the conversion for debuggability. */
function wrapDirective(source: string, cond: Expr): FilterIfDirective {
  return {
    source,
    cond,
    ifTrue: [],
    ifFalse: [],
    ifTrueDefined: false,
    ifFalseDefined: false,
  };
}

// ─── Per-filter synthesis ─────────────────────────────────────────────────

/** ADX in [min, max]. Mirrors preset-filters.ts:57-60. */
function synthAdx(block: Record<string, unknown>): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const period = numField(block, "period", 14);
  const min = numField(block, "min", 0);
  const max = numField(block, "max", 100);
  const adx = call("ADX", [num(period)]);
  const cond = and(cmp(">=", adx, num(min)), cmp("<=", adx, num(max)));
  return wrapDirective(
    `filters.adx synth: ADX(${period}) in [${min}, ${max}]`,
    cond
  );
}

/** ATR in [min, max]. Mirrors preset-filters.ts:63-66. */
function synthAtr(block: Record<string, unknown>): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const period = numField(block, "period", 14);
  const min = numField(block, "min", 0);
  const max = numField(block, "max", Number.MAX_SAFE_INTEGER);
  const atr = call("ATR", [num(period)]);
  const cond = and(cmp(">=", atr, num(min)), cmp("<=", atr, num(max)));
  return wrapDirective(
    `filters.atr synth: ATR(${period}) in [${min}, ${max}]`,
    cond
  );
}

/** RSI in [min, max]. Mirrors preset-filters.ts:151-155. */
function synthRsi(block: Record<string, unknown>): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const period = numField(block, "period", 14);
  const min = numField(block, "min", 0);
  const max = numField(block, "max", 100);
  const rsi = call("RSI", [num(period)]);
  const cond = and(cmp(">=", rsi, num(min)), cmp("<=", rsi, num(max)));
  return wrapDirective(
    `filters.rsi synth: RSI(${period}) in [${min}, ${max}]`,
    cond
  );
}

/** Bollinger position. close-position relative to BB bands; reject when
 *  not in any of the `allowed[]` regions. Mirrors preset-filters.ts:94-99.
 *  Empty allowed list → reject-all (preset-filters.ts:96 fail-closed). */
function synthBollinger(block: Record<string, unknown>): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const period = numField(block, "period", 20);
  const stdDev = numField(block, "stdDev", 2);
  const allowedRaw = block.allowed;
  const allowed: string[] = Array.isArray(allowedRaw)
    ? allowedRaw.filter((x): x is string => typeof x === "string")
    : [];
  const upper = call("BB_upper", [num(period), num(stdDev)]);
  const lower = call("BB_lower", [num(period), num(stdDev)]);
  const close = ident("close");
  // Build one disjunct per allowed region. The dashboard treats positions
  // exactly at the band as "inside" (preset-filters.ts uses string equality
  // on a precomputed enum, where boundary cases land in "inside"); the
  // synthesized inequalities mirror that — strict > / < for above/below,
  // inclusive >= / <= for inside.
  const disjuncts: Expr[] = [];
  for (const region of allowed) {
    if (region === "above_upper") {
      disjuncts.push(cmp(">", close, upper));
    } else if (region === "below_lower") {
      disjuncts.push(cmp("<", close, lower));
    } else if (region === "inside") {
      disjuncts.push(and(cmp(">=", close, lower), cmp("<=", close, upper)));
    }
  }
  // Empty allowed (or only-unrecognized regions) → reject-all. orAll([])
  // already produces the literal 0, but we wrap the cond in an explicit
  // sentinel so the .cs comment makes the intent obvious.
  const cond = orAll(disjuncts);
  return wrapDirective(
    `filters.bollinger synth: close in BB(${period},${stdDev}) regions [${allowed.join(",")}]`,
    cond
  );
}

/** Bollinger band-width range. Mirrors preset-filters.ts:105-112. Shares
 *  period+stdDev with the bollinger position block so a script using both
 *  filters gets matching BB params. */
function synthBbWidth(
  block: Record<string, unknown>,
  bollinger: Record<string, unknown> | undefined
): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  // Fall back to bollinger block's period/stdDev if bbWidth doesn't
  // override them — matches the dashboard's snapshotContext where
  // `ctx_bollinger_bw` is computed once per bar from a single BB
  // configuration.
  const period =
    numField(block, "period", numField(bollinger ?? null, "period", 20));
  const stdDev =
    numField(block, "stdDev", numField(bollinger ?? null, "stdDev", 2));
  const min = numField(block, "min", 0);
  const max = numField(block, "max", Number.MAX_SAFE_INTEGER);
  const width = call("BB_width", [num(period), num(stdDev)]);
  const cond = and(cmp(">=", width, num(min)), cmp("<=", width, num(max)));
  return wrapDirective(
    `filters.bbWidth synth: BB_width(${period},${stdDev}) in [${min}, ${max}]`,
    cond
  );
}

/** MA distance. Distance is `close - MA(period)` in price points; the
 *  dashboard expresses min/max in ATR units, so we multiply through by
 *  ATR(14) on the right-hand side. Three modes (preset-filters.ts:121-137):
 *    - "absolute": |distance| in [min, max] ATR
 *    - "above":    distance >= 0 AND distance in [min, max] ATR
 *    - "below":    distance <= 0 AND |distance| in [min, max] ATR
 *
 *  The expr language has no abs(); for the `absolute` and `below` modes
 *  we use a squared-form inequality which is equivalent on positive
 *  bounds. Negative `min`/`max` would change semantics — the dashboard's
 *  PresetFilters schema disallows negative bounds in these modes. */
function synthMaDistance(
  block: Record<string, unknown>
): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const period = numField(block, "period", 50);
  const type = strField(block, "type", "ema");
  const mode = strField(block, "mode", "absolute");
  const min = numField(block, "min", 0);
  const max = numField(block, "max", Number.MAX_SAFE_INTEGER);
  const ma = type === "sma" ? call("SMA", [num(period)]) : call("EMA", [num(period)]);
  const close = ident("close");
  const dist = arith("-", close, ma); // close - MA, in price points
  const atr = call("ATR", [num(14)]);
  let cond: Expr;
  if (mode === "above") {
    // close-MA >= min*ATR && close-MA <= max*ATR. The >= 0 implication
    // is captured by min >= 0 in dashboard schema, but we still gate on
    // the lower bound which forces dist >= 0 when min == 0 (since ATR > 0).
    cond = and(
      cmp(">=", dist, arith("*", num(min), atr)),
      cmp("<=", dist, arith("*", num(max), atr))
    );
  } else if (mode === "below") {
    // dist <= -min*ATR && dist >= -max*ATR (negative side, |dist| in [min,max]).
    cond = and(
      cmp("<=", dist, arith("*", num(-min), atr)),
      cmp(">=", dist, arith("*", num(-max), atr))
    );
  } else {
    // "absolute": dist^2 in [min^2 * ATR^2, max^2 * ATR^2]. Squared form
    // avoids needing abs(). On non-negative min/max this is exactly
    // equivalent to |dist| in [min, max] * ATR.
    const distSq = arith("*", dist, dist);
    const atrSq = arith("*", atr, atr);
    cond = and(
      cmp(">=", distSq, arith("*", num(min * min), atrSq)),
      cmp("<=", distSq, arith("*", num(max * max), atrSq))
    );
  }
  return wrapDirective(
    `filters.maDistance synth: |close - ${type.toUpperCase()}(${period})|/ATR(14) ${mode} in [${min}, ${max}]`,
    cond
  );
}

/** Volume ratio = current bar volume / VolumeMa(period) in [minRatio, maxRatio].
 *  Mirrors preset-filters.ts:142-146. Reuses the existing `volume(N)`
 *  call which routes to `DslIndicators.VolumeMa(_bars, off, N)` — a true
 *  SMA over `bar.Volume` matching the dashboard's `volumeMaSeries`. */
function synthVolume(block: Record<string, unknown>): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const period = numField(block, "period", 20);
  const minRatio = numField(block, "minRatio", 0);
  const maxRatio = numField(block, "maxRatio", Number.MAX_SAFE_INTEGER);
  const ratio = arith("/", ident("volume"), call("volume", [num(period)]));
  const cond = and(
    cmp(">=", ratio, num(minRatio)),
    cmp("<=", ratio, num(maxRatio))
  );
  return wrapDirective(
    `filters.volume synth: volume / VolumeMa(${period}) in [${minRatio}, ${maxRatio}]`,
    cond
  );
}

/** ADX trend (rising/falling/flat). slope = ADX(p) - ADX(p)[lookback].
 *  Mirrors preset-filters.ts:164-176.
 *    - "rising":  slope >  flatThreshold
 *    - "falling": slope < -flatThreshold
 *    - "flat":    |slope| <= flatThreshold (squared form)
 *    - "any":     no-op (return null)
 *  Note: the postfix [N] on ADX(p) re-evaluates ADX at offset+N, which
 *  the expr-emit `emitIndex` path handles correctly. */
function synthAdxTrend(
  block: Record<string, unknown>,
  adxBlock: Record<string, unknown> | undefined
): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const mode = strField(block, "mode", "any");
  if (mode === "any") return null;
  const period = numField(adxBlock ?? null, "period", 14);
  const lookback = numField(block, "lookback", 5);
  const flatThreshold = Math.abs(numField(block, "flatThreshold", 0.5));
  const adxNow = call("ADX", [num(period)]);
  const adxPrev = index(call("ADX", [num(period)]), num(lookback));
  const slope = arith("-", adxNow, adxPrev);
  let cond: Expr;
  if (mode === "rising") {
    cond = cmp(">", slope, num(flatThreshold));
  } else if (mode === "falling") {
    cond = cmp("<", slope, num(-flatThreshold));
  } else {
    // flat: slope^2 <= flatThreshold^2 (squared form; flatThreshold ≥ 0).
    const slopeSq = arith("*", slope, slope);
    cond = cmp("<=", slopeSq, num(flatThreshold * flatThreshold));
  }
  return wrapDirective(
    `filters.adxTrend synth: slope(ADX(${period}), ${lookback}) ${mode} (thresh ${flatThreshold})`,
    cond
  );
}

/** Bid/ask delta ratio in [min, max]. Mirrors preset-filters.ts:183-187.
 *  Uses `delta_ratio` ident which expr-emit.ts:302-303 routes to
 *  `_dslTicks.DeltaRatio(off)` and flips `requiresTicks=true`. Sessions
 *  without bid/ask data emit NaN, which propagates through the binop
 *  guards and rejects the trade — matches dashboard fail-closed
 *  semantics. */
function synthDelta(block: Record<string, unknown>): FilterIfDirective | null {
  if (!isEnabled(block)) return null;
  const min = numField(block, "min", -1);
  const max = numField(block, "max", 1);
  const dr = ident("delta_ratio");
  const cond = and(cmp(">=", dr, num(min)), cmp("<=", dr, num(max)));
  return wrapDirective(
    `filters.delta synth: delta_ratio in [${min}, ${max}]`,
    cond
  );
}

// ─── Public entry ─────────────────────────────────────────────────────────

/** Walk the merged filters dict and synthesize FilterIfDirective[] for
 *  each enabled legacy filter family. Time and trend are intentionally
 *  excluded — they stay on the native PresetFiltersData path.
 *
 *  Order matters only insofar as the synthesized directives are AND-gated
 *  in the same order they appear in the returned list. Choosing a stable
 *  emit order makes the generated .cs file and per-bar diagnostic output
 *  predictable for parity diffing. */
export function synthesizeLegacyFilters(
  filters: Record<string, unknown>
): FilterIfDirective[] {
  const out: FilterIfDirective[] = [];

  const get = (k: string): Record<string, unknown> | undefined => {
    const v = filters[k];
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  };

  const adx = get("adx");
  const atr = get("atr");
  const rsi = get("rsi");
  const bollinger = get("bollinger");
  const bbWidth = get("bbWidth");
  const maDistance = get("maDistance");
  const volume = get("volume");
  const adxTrend = get("adxTrend");
  const delta = get("delta");

  const push = (d: FilterIfDirective | null): void => {
    if (d) out.push(d);
  };

  // Stable order: indicator-strength filters first (most likely to reject
  // early at low cost), then range filters, then microstructure filters.
  if (adx) push(synthAdx(adx));
  if (atr) push(synthAtr(atr));
  if (rsi) push(synthRsi(rsi));
  if (bollinger) push(synthBollinger(bollinger));
  if (bbWidth) push(synthBbWidth(bbWidth, bollinger));
  if (maDistance) push(synthMaDistance(maDistance));
  if (volume) push(synthVolume(volume));
  if (adxTrend) push(synthAdxTrend(adxTrend, adx));
  if (delta) push(synthDelta(delta));

  return out;
}
