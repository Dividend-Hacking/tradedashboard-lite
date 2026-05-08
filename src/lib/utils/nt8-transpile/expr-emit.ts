/**
 * expr-emit.ts — DSL Expr AST → C# expression string.
 *
 * Recursive walker that mirrors the evalValue/evalNumber semantics in
 * src/lib/utils/strategy-evaluator.ts and src/lib/utils/script-expr.ts.
 * The output is a C# expression that, when evaluated against the
 * generated strategy's runtime (rolling bar buffer + DslRuntime
 * instance + DslIndicators static helpers), produces the same number
 * the dashboard's evaluator would.
 *
 * Why "expression-string" output instead of an intermediate IR:
 *   - C# is the final target. Going through an IR adds a layer that
 *     would only make sense if we transpiled to multiple targets.
 *   - Most DSL expressions are small (a few operators + idents); a
 *     direct AST → string walk is shorter and easier to debug than
 *     emitting and reading back IR.
 *
 * Stateful operators (cross_up / cross_down / bars_since / any_bar_in)
 * delegate to the EmitContext which assigns each call site a stable
 * private-field id and registers a runtime-helper invocation. The
 * stmt-emit layer collects those registrations and emits the matching
 * field declarations on the generated strategy class.
 *
 * NaN-as-false discipline: every binop/cmp/ident emits a value that
 * matches the dashboard's NaN-as-fail semantics. Logical short-circuit
 * (&&, ||) preserves order — important when the RHS has side effects
 * via stateful operators (the dashboard evaluates left-to-right; we
 * must too, otherwise crossUp state could be advanced when it shouldn't
 * be).
 *
 * IMPORTANT: this layer assumes `let` bindings have already been
 * inlined by `applyBindings` upstream (the strategy evaluator does this
 * during parse). If a `let X = …` appears in the AST as an `ident`
 * reference at this layer, that's a bug — fail loudly.
 */

import type { Expr } from "../script-expr";
import {
  csIndicatorMethod,
  isTickRouted,
  callRequiresTicks,
  BIDASK_SCALARS,
  TICK_REQUIRED_INDICATORS,
} from "./indicator-table";

/** Mutable per-transpile context. Owned by the strategy emitter; the
 *  expr emitter only reads/writes through it.
 *
 *  - `params`: fully-resolved param map. References to `params.X` get
 *    inlined as numeric literals at emit time (params are fixed for the
 *    export).
 *  - `letDefs`: map of `let <name> = <expr>` definitions. The strategy
 *    emitter populates this with the un-inlined RHS expressions. We
 *    use them for two things: (1) at the common offset=current case,
 *    detect that an ident IS a let so we emit the C# local
 *    `__let_<name>` (cheap reference). (2) at a SHIFTED offset (cross_up
 *    prev side, any_bar_in body, postfix `[N]`), inline the let's
 *    expression so OHLCV / indicator / nested-let refs inside it pick
 *    up the shifted bar offset naturally — the static C# local was
 *    computed at offset 0 and would silently break stateful operators.
 *  - `requiresTicks`: OR'd across every emit; true if any indicator or
 *    bidask scalar in the AST needs the tick channel.
 *  - `crossSlots / barsSinceCondSlots`: registered stateful slots.
 *    The strategy emitter walks these to declare private fields and
 *    update them inside OnBarUpdate.
 *  - `errors`: parse/transpile diagnostics — non-fatal at the AST
 *    walking layer (NaN at runtime mirrors the dashboard) but the
 *    strategy emitter surfaces them. */
export interface EmitContext {
  params: Record<string, number>;
  letDefs: Map<string, Expr>;
  requiresTicks: boolean;
  /** Each entry corresponds to one `cross_up`/`cross_down` call site.
   *  The slot id is appended to a private-field name on the generated
   *  strategy class (`_xup_<id>_aPrev`, `_xup_<id>_bPrev`, `_xup_<id>_warm`).
   *  The strategy emitter declares these fields and updates them at the
   *  end of OnBarUpdate so the next bar sees the correct previous
   *  values. */
  crossSlots: CrossSlot[];
  /** `bars_since(<custom condition>)` slots. signal.long/signal.short
   *  fast paths don't need a slot — they read the firings list directly. */
  barsSinceCondSlots: BarsSinceCondSlot[];
  /** Source-text snippets for any DSL feature we couldn't transpile —
   *  surfaced so the transpiler can emit a clear error to the user
   *  instead of silently dropping logic. */
  errors: string[];
  /** Whether the expression we're emitting will be evaluated at the
   *  current bar (offset 0) or a shifted bar (any_bar_in / cross_up
   *  prev / index lookback). Drives OHLCV emission: at offset 0 we
   *  read Close[0], otherwise we read Close[<offset>]. */
  barOffset: BarOffsetSource;
  /** Counter for generating unique slot ids. Bump and use. */
  nextSlotId: number;
  /** Whether the emitted expression is INSIDE an `any_bar_in` body —
   *  used to disable certain optimizations and to restrict use of
   *  `signal.long` / `signal.short` references (which require the
   *  outer bar context). */
  insideAnyBarIn: boolean;
  /** Per-param dedupe set so the "params.X resolves to NaN" warning
   *  fires once per unique key, not once per reference. Strategies
   *  often reference `params.minBodyRatio` 5+ times; without this
   *  the warnings array would explode. */
  warnedParams: Set<string>;
}

/** Where the bar offset comes from at this point in the AST walk.
 *  - "current" — the current bar (Close[0], etc.).
 *  - "literal:<N>" — fixed offset N (used when emitting an `[N]` lookback
 *    on a bare OHLCV ident; the offset is known at emit time so we just
 *    splat it into the C# series accessor).
 *  - "expr:<C# expr>" — a runtime expression that yields the current
 *    bar's offset, e.g. inside an any_bar_in body. */
export type BarOffsetSource = "current" | { kind: "literal"; n: number } | { kind: "expr"; cs: string };

export interface CrossSlot {
  id: number;
  direction: "up" | "down";
}

export interface BarsSinceCondSlot {
  id: number;
}

/** Render the bar-offset state as the C# integer expression that
 *  selects which historical bar to read from a series. */
function renderOffset(off: BarOffsetSource): string {
  if (off === "current") return "0";
  if (off.kind === "literal") return String(off.n);
  return off.cs;
}

/** Emit the C# expression for an Expr AST node. Recursive. */
export function emitExpr(expr: Expr, ctx: EmitContext): string {
  switch (expr.kind) {
    case "num":
      return formatNumberLiteral(expr.value);

    case "ident":
      return emitIdent(expr.name, ctx);

    case "unary": {
      const inner = emitExpr(expr.arg, ctx);
      switch (expr.op) {
        case "-":
          return `(-(${inner}))`;
        case "+":
          return `(+(${inner}))`;
        case "!":
          // DSL "!" treats NaN as NaN, otherwise inverts truthiness.
          // emit: (double.IsNaN(x) ? double.NaN : (x != 0 ? 0.0 : 1.0))
          return `(double.IsNaN(${inner}) ? double.NaN : ((${inner}) != 0.0 ? 0.0 : 1.0))`;
      }
      return "double.NaN";
    }

    case "binop":
      return emitBinop(expr, ctx);

    case "if": {
      // DSL: if cond then a else b — NaN cond → NaN.
      const c = emitExpr(expr.cond, ctx);
      const a = emitExpr(expr.then, ctx);
      const b = emitExpr(expr.else, ctx);
      return `(double.IsNaN(${c}) ? double.NaN : ((${c}) != 0.0 ? (${a}) : (${b})))`;
    }

    case "call":
      return emitCall(expr.name, expr.args, ctx);

    case "index":
      return emitIndex(expr.base, expr.offset, ctx);
  }
}

/** Emit a number literal in a C# double-friendly form. Integers stay
 *  integers (5 → "5.0"); floats get the "d" suffix-free form C# accepts
 *  in double context. NaN/Infinity routed to constants. */
function formatNumberLiteral(v: number): string {
  if (Number.isNaN(v)) return "double.NaN";
  if (v === Number.POSITIVE_INFINITY) return "double.PositiveInfinity";
  if (v === Number.NEGATIVE_INFINITY) return "double.NegativeInfinity";
  if (Number.isInteger(v)) return `${v}.0`;
  // Use a precision that round-trips most values; Number.prototype.toString
  // gives the shortest round-trip representation in JS, which is what we want.
  return v.toString();
}

/** Resolve a bare identifier to its C# expression. */
function emitIdent(name: string, ctx: EmitContext): string {
  // Boolean keywords. The DSL grammar has no dedicated boolean token,
  // so `compile()` parses `true` / `false` as plain idents. Coerce to
  // 1.0 / 0.0 here so any expression-context use (e.g. `let x = true`,
  // `filter.if = false`) round-trips correctly. The rules-block path
  // also handles `rules.X = true/false` via parseBacktestScript, but
  // catching it here is defense-in-depth for arbitrary expressions.
  if (name === "true") return "1.0";
  if (name === "false") return "0.0";
  // params.X — inline the numeric value at transpile time.
  if (name.startsWith("params.")) {
    const key = name.slice("params.".length);
    const v = ctx.params[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return formatNumberLiteral(v);
    }
    // Missing params evaluate to NaN at runtime. The dashboard's
    // resolveIdent in strategy-evaluator.ts does the same, BUT the
    // dashboard runtime falls back to paramMeta.default for any
    // params.X the user didn't explicitly tune. The transpiler's
    // caller (API route) is supposed to pre-merge those defaults
    // into ctx.params before we get here. If we still see a missing
    // key it's a real bug — surface the specific name so the user
    // can see exactly which param fell through. Round-6 burned
    // hours on `body_ok = body_ratio >= NaN` because the warning
    // didn't say which param was missing.
    if (!ctx.warnedParams.has(key)) {
      ctx.warnedParams.add(key);
      ctx.errors.push(`params.${key}: not in preset.params and no paramMeta default — emitting NaN. Every comparison against this value will be NaN/false.`);
    }
    return "double.NaN";
  }

  // Sentinels — only meaningful inside bars_since.
  if (name === "signal.long" || name === "signal.short") {
    ctx.errors.push(`bare ${name} reference outside bars_since() — emits NaN`);
    return "double.NaN";
  }

  // Let bindings: branch on bar offset.
  //
  // - At offset=current the let was already computed as a C# local
  //   `__let_<name>` at the top of the method body — return that
  //   reference (cheap, avoids the megabyte-scale code blowup we
  //   previously hit when lets were always inlined).
  //
  // - At a SHIFTED offset (cross_up's prev side, any_bar_in's lambda
  //   body, postfix `expr[N]`), the C# local has the WRONG value —
  //   it was computed against bar 0, not the shifted bar. Inline the
  //   let's defining expression here so OHLCV / indicator / nested-let
  //   references inside the definition pick up the shifted offset
  //   naturally via emitExpr's recursive walk.
  //
  // This mirrors strategy-evaluator.ts's behavior: prevCtx / inner
  // any_bar_in iteration both clear the letCache so lets re-evaluate
  // against the shifted bar.
  const letExpr = ctx.letDefs.get(name);
  if (letExpr) {
    if (ctx.barOffset === "current") {
      return `__let_${csIdent(name)}`;
    }
    return emitExpr(letExpr, ctx);
  }

  const off = renderOffset(ctx.barOffset);

  // OHLCV scalars + bar-shape derivations. NT8 series are accessed via
  // `Close[barsAgo]` etc. on the strategy class.
  switch (name) {
    case "open":
      return `Open[${off}]`;
    case "high":
      return `High[${off}]`;
    case "low":
      return `Low[${off}]`;
    case "close":
      return `Close[${off}]`;
    case "volume":
      return `((double)Volume[${off}])`;
    case "bar_index":
      // CurrentBar in NT8 is the index of the current bar (0-based, growing).
      return `((double)(CurrentBar - ${off}))`;
    case "range":
      return `(High[${off}] - Low[${off}])`;
    case "body":
      return `(Close[${off}] - Open[${off}])`;
    case "upper_wick":
      return `(High[${off}] - System.Math.Max(Open[${off}], Close[${off}]))`;
    case "lower_wick":
      return `(System.Math.Min(Open[${off}], Close[${off}]) - Low[${off}])`;
    case "typical":
      return `((High[${off}] + Low[${off}] + Close[${off}]) / 3.0)`;
    case "median_price":
      return `((High[${off}] + Low[${off}]) / 2.0)`;
    case "weighted_close":
      return `((High[${off}] + Low[${off}] + 2.0 * Close[${off}]) / 4.0)`;
  }

  // Bid/ask scalars route via DslRuntime — needs the tick channel
  // wired so we can attribute volume to bid/ask sides.
  if (BIDASK_SCALARS.has(name)) {
    ctx.requiresTicks = true;
    switch (name) {
      case "bar_volume_bid":
        return `_dslTicks.BarVolumeBid(${off})`;
      case "bar_volume_ask":
        return `_dslTicks.BarVolumeAsk(${off})`;
      case "buy_volume":
        return `_dslTicks.BarVolumeAsk(${off})`;
      case "sell_volume":
        return `_dslTicks.BarVolumeBid(${off})`;
      case "delta":
        return `_dslTicks.Delta(${off})`;
      case "delta_ratio":
        return `_dslTicks.DeltaRatio(${off})`;
      case "buy_pressure":
        return `_dslTicks.BuyPressure(${off})`;
    }
  }

  // Bare bare-named indicators (ATR, ATR14, EMA20, RSI14, SMA50, ADX14, etc.)
  // mirror resolveBareIndicator in strategy-evaluator.ts:745.
  const bare = bareIndicatorMethod(name);
  if (bare) {
    return emitIndicatorCall(bare.method, [bare.period], ctx);
  }

  ctx.errors.push(`unrecognized identifier "${name}" — emits NaN`);
  return "double.NaN";
}

/** Decode bare-name aliases like `ATR14`, `EMA20`, etc. into method+period. */
function bareIndicatorMethod(name: string): { method: string; period: number } | null {
  if (name === "ATR" || name === "ATR14") return { method: "Atr", period: 14 };
  if (name === "ADX" || name === "ADX14") return { method: "Adx", period: 14 };
  if (name === "RSI" || name === "RSI14") return { method: "Rsi", period: 14 };
  const m = name.match(/^(ATR|EMA|SMA|ADX|RSI)(\d+)$/);
  if (m) {
    const period = parseInt(m[2], 10);
    if (Number.isFinite(period) && period > 0) {
      const family = m[1];
      const methodMap: Record<string, string> = {
        ATR: "Atr",
        EMA: "Ema",
        SMA: "Sma",
        ADX: "Adx",
        RSI: "Rsi",
      };
      return { method: methodMap[family], period };
    }
  }
  return null;
}

function emitBinop(
  expr: Expr & { kind: "binop" },
  ctx: EmitContext
): string {
  // Logical short-circuit operators preserve eval order so stateful
  // operators in the RHS only fire when reached.
  if (expr.op === "&&") {
    const a = emitExpr(expr.lhs, ctx);
    const b = emitExpr(expr.rhs, ctx);
    // a && b : if a is NaN or 0 → 0. Else: if b is finite and nonzero → 1, else 0.
    return `((!Dsl.IsFinite(${a}) || (${a}) == 0.0) ? 0.0 : ((Dsl.IsFinite(${b}) && (${b}) != 0.0) ? 1.0 : 0.0))`;
  }
  if (expr.op === "||") {
    const a = emitExpr(expr.lhs, ctx);
    const b = emitExpr(expr.rhs, ctx);
    // a || b : if a finite and nonzero → 1. Else: if b finite and nonzero → 1, else 0.
    return `((Dsl.IsFinite(${a}) && (${a}) != 0.0) ? 1.0 : ((Dsl.IsFinite(${b}) && (${b}) != 0.0) ? 1.0 : 0.0))`;
  }

  const a = emitExpr(expr.lhs, ctx);
  const b = emitExpr(expr.rhs, ctx);

  switch (expr.op) {
    case "+":
      return `((${a}) + (${b}))`;
    case "-":
      return `((${a}) - (${b}))`;
    case "*":
      return `((${a}) * (${b}))`;
    case "/":
      // Match dashboard: divide-by-zero → NaN, not Infinity.
      return `((${b}) == 0.0 ? double.NaN : ((${a}) / (${b})))`;
    case "%":
      return `((${b}) == 0.0 ? double.NaN : ((${a}) % (${b})))`;
    case "^":
      return `System.Math.Pow(${a}, ${b})`;
    case ">":
    case "<":
    case ">=":
    case "<=":
    case "==":
    case "!=": {
      // NaN-as-fail comparisons: any NaN → NaN (which downstream
      // treats as false). Otherwise emit a 0/1 value.
      const csOp =
        expr.op === "==" ? "==" : expr.op === "!=" ? "!=" : expr.op;
      return `((double.IsNaN(${a}) || double.IsNaN(${b})) ? double.NaN : (((${a}) ${csOp} (${b})) ? 1.0 : 0.0))`;
    }
  }
  return "double.NaN";
}

function emitCall(name: string, args: Expr[], ctx: EmitContext): string {
  // ── Special forms ───────────────────────────────────────────────────
  if (name === "any_bar_in") return emitAnyBarIn(args, ctx);
  if (name === "bars_since") return emitBarsSince(args, ctx);
  if (name === "cross_up" || name === "cross_down") {
    return emitCross(name, args, ctx);
  }
  if (name === "high" || name === "low") {
    return emitRollingExtremum(name, args, ctx);
  }
  if (name === "bars_since_high" || name === "bars_since_low") {
    return emitBarsSinceExtremum(name, args, ctx);
  }

  // ── Math passthroughs ───────────────────────────────────────────────
  switch (name) {
    case "abs":
      return `System.Math.Abs(${emitExpr(args[0], ctx)})`;
    case "min":
      return emitVariadicMath("Min", args, ctx);
    case "max":
      return emitVariadicMath("Max", args, ctx);
    case "floor":
      return `System.Math.Floor(${emitExpr(args[0], ctx)})`;
    case "ceil":
      return `System.Math.Ceiling(${emitExpr(args[0], ctx)})`;
    case "round":
      // C# Math.Round defaults to banker's rounding; JS Math.round is
      // half-away-from-zero for positives, half-to-positive-infinity in
      // general. Use MidpointRounding.AwayFromZero to match JS for the
      // positive case (DSL values are typically prices, all positive).
      return `System.Math.Round(${emitExpr(args[0], ctx)}, System.MidpointRounding.AwayFromZero)`;
    case "sqrt":
      return `System.Math.Sqrt(${emitExpr(args[0], ctx)})`;
    case "log":
      return `System.Math.Log(${emitExpr(args[0], ctx)})`;
    case "exp":
      return `System.Math.Exp(${emitExpr(args[0], ctx)})`;
    case "pow":
      return `System.Math.Pow(${emitExpr(args[0], ctx)}, ${emitExpr(args[1], ctx)})`;
    case "ticks":
      // ticks(n) → n / ticksPerPoint. Inline the value: the strategy's
      // TickSize is `1 / ticksPerPoint` in points, so n * TickSize.
      return `((${emitExpr(args[0], ctx)}) * TickSize)`;
    case "point":
      // point(n) → n * ticksPerPoint = n / TickSize.
      return `((${emitExpr(args[0], ctx)}) / TickSize)`;
  }

  // ── Indicator dispatch ──────────────────────────────────────────────
  const method = csIndicatorMethod(name);
  if (method) {
    if (callRequiresTicks(name)) ctx.requiresTicks = true;
    // Evaluate args at the current bar context (indicators read the
    // underlying series themselves; arg expressions should evaluate
    // to constants from inlined params).
    const argExprs = args.map((a) => emitExpr(a, ctx));
    if (isTickRouted(name)) {
      // _dslTicks.<Method>(barIdx, ...args)
      return `_dslTicks.${method}(${[renderOffset(ctx.barOffset), ...argExprs].join(", ")})`;
    }
    return emitIndicatorCallWithExprs(method, argExprs, ctx);
  }

  ctx.errors.push(`unknown function "${name}" — emits NaN`);
  return "double.NaN";
}

function emitVariadicMath(fn: "Min" | "Max", args: Expr[], ctx: EmitContext): string {
  if (args.length === 0) return "double.NaN";
  if (args.length === 1) return emitExpr(args[0], ctx);
  // Reduce left-to-right: Math.Min(a, Math.Min(b, c))
  let acc = emitExpr(args[0], ctx);
  for (let i = 1; i < args.length; i++) {
    acc = `System.Math.${fn}(${acc}, ${emitExpr(args[i], ctx)})`;
  }
  return acc;
}

/** Emit a DslIndicators.<method>(barIdx, ...args) call. Args here are
 *  numeric constants that will be inlined as C# numeric literals. */
function emitIndicatorCall(
  method: string,
  numericArgs: number[],
  ctx: EmitContext
): string {
  const off = renderOffset(ctx.barOffset);
  const argList = [off, ...numericArgs.map((a) => formatNumberLiteral(a))].join(", ");
  return `DslIndicators.${method}(_bars, ${argList})`;
}

function emitIndicatorCallWithExprs(
  method: string,
  argExprs: string[],
  ctx: EmitContext
): string {
  const off = renderOffset(ctx.barOffset);
  return `DslIndicators.${method}(_bars, ${[off, ...argExprs].join(", ")})`;
}

/** Postfix `expr[N]` — look back N bars on a series-producing expression
 *  or a bare scalar. We re-emit `base` with a shifted bar offset.
 *
 *  Two paths:
 *    1) `base` is a series-returning call (high(20), low(20), or bare
 *       OHLCV idents). We re-emit base with the offset added.
 *    2) `base` is anything else (an indicator call, an arbitrary expr).
 *       We compute the offset and re-emit base with bar context shifted.
 *
 *  Important: the OFFSET expression itself evaluates in the OUTER bar
 *  context, even when the base is shifted (mirrors evalIndex in
 *  strategy-evaluator.ts:866). */
function emitIndex(base: Expr, offset: Expr, ctx: EmitContext): string {
  // Evaluate offset against the OUTER bar context.
  const offCs = emitExpr(offset, ctx);
  // Round + non-negative guard mirrors evalIndex: Math.round(offset),
  // negatives → NaN.
  const newOffCs = `(int)System.Math.Round(${offCs}, System.MidpointRounding.AwayFromZero)`;
  // Compute the final offset relative to the strategy's "current" bar
  // position. If the outer ctx is already at a non-current offset (we're
  // inside an any_bar_in body etc.), we add to that.
  let combinedOffCs: string;
  if (ctx.barOffset === "current") {
    combinedOffCs = newOffCs;
  } else if (ctx.barOffset.kind === "literal") {
    combinedOffCs = `(${ctx.barOffset.n} + ${newOffCs})`;
  } else {
    combinedOffCs = `(${ctx.barOffset.cs} + ${newOffCs})`;
  }
  // Re-emit base in a shifted context. NaN-guard on negative final
  // offset is handled by the underlying series accessors (NT8 throws
  // on negative indices, but our DslIndicators helpers return NaN).
  const innerCtx: EmitContext = { ...ctx, barOffset: { kind: "expr", cs: combinedOffCs } };
  return emitExpr(base, innerCtx);
}

/** Emit `cross_up` / `cross_down`. Both require the previous-bar values
 *  of the two args. We register a slot id and emit a runtime call that
 *  reads the cached previous values. The strategy emitter declares the
 *  slot fields and runs an end-of-bar update step. */
function emitCross(
  name: "cross_up" | "cross_down",
  args: Expr[],
  ctx: EmitContext
): string {
  if (args.length !== 2) {
    ctx.errors.push(`${name} requires 2 args`);
    return "double.NaN";
  }
  const id = ctx.nextSlotId++;
  ctx.crossSlots.push({ id, direction: name === "cross_up" ? "up" : "down" });
  const aNow = emitExpr(args[0], ctx);
  const bNow = emitExpr(args[1], ctx);
  // Previous-bar values: re-emit args at offset+1.
  const shiftedOffset: BarOffsetSource =
    ctx.barOffset === "current"
      ? { kind: "literal", n: 1 }
      : ctx.barOffset.kind === "literal"
        ? { kind: "literal", n: ctx.barOffset.n + 1 }
        : { kind: "expr", cs: `(${ctx.barOffset.cs} + 1)` };
  const prevCtx: EmitContext = { ...ctx, barOffset: shiftedOffset };
  const aPrev = emitExpr(args[0], prevCtx);
  const bPrev = emitExpr(args[1], prevCtx);
  // Inline the cross logic so we don't need a separate runtime call.
  // CurrentBar < 1 → 0 (no prior bar to compare).
  const cmpA = name === "cross_up" ? "<" : ">";
  const cmpB = name === "cross_up" ? ">=" : "<=";
  return `(CurrentBar < 1 ? 0.0 : ((Dsl.IsFinite(${aNow}) && Dsl.IsFinite(${bNow}) && Dsl.IsFinite(${aPrev}) && Dsl.IsFinite(${bPrev})) ? (((${aPrev}) ${cmpA} (${bPrev}) && (${aNow}) ${cmpB} (${bNow})) ? 1.0 : 0.0) : double.NaN))`;
}

function emitBarsSince(args: Expr[], ctx: EmitContext): string {
  if (args.length !== 1) {
    ctx.errors.push("bars_since requires 1 arg");
    return "double.NaN";
  }
  const arg = args[0];
  // Fast path — bars_since(signal.long/short) reads the firings tracker.
  if (arg.kind === "ident" && (arg.name === "signal.long" || arg.name === "signal.short")) {
    const side = arg.name === "signal.long" ? "Long" : "Short";
    return `_dsl.BarsSinceLastFiring${side}(CurrentBar)`;
  }
  // Generic path — register a slot and walk back. We emit a lambda the
  // runtime invokes at offsets 0..N walking back to find the most
  // recent bar where the condition was true.
  const id = ctx.nextSlotId++;
  ctx.barsSinceCondSlots.push({ id });
  // The runtime helper takes a per-bar-offset evaluator. We emit a
  // local lambda `(int __o) => <expr at offset __o>`.
  const innerCtx: EmitContext = {
    ...ctx,
    barOffset: { kind: "expr", cs: "__o" },
  };
  const innerCs = emitExpr(arg, innerCtx);
  // Cap the search at the available bar history (CurrentBar+1).
  return `_dsl.BarsSinceCondition(CurrentBar, (int __o) => { var __v = ${innerCs}; return Dsl.IsFinite(__v) && __v != 0.0; })`;
}

function emitAnyBarIn(args: Expr[], ctx: EmitContext): string {
  if (args.length !== 2) {
    ctx.errors.push("any_bar_in requires 2 args");
    return "double.NaN";
  }
  const N = emitExpr(args[0], ctx);
  // Inner condition evaluates at offset 0..N-1 from the OUTER bar.
  // We compose the offset relative to ctx.barOffset.
  const innerCtx: EmitContext = {
    ...ctx,
    barOffset: { kind: "expr", cs: "__k" },
    insideAnyBarIn: true,
  };
  const innerCs = emitExpr(args[1], innerCtx);
  // Note: the dashboard's any_bar_in handles +Infinity (from
  // bars_since(signal.long)) by clamping to the bar count. We mirror
  // by treating non-finite N as 0 (no iterations → 0).
  return `_dsl.AnyBarIn(CurrentBar, ${N}, (int __k) => { var __v = ${innerCs}; return Dsl.IsFinite(__v) && __v != 0.0; })`;
}

/** Rolling N-bar high/low EXCLUDING current bar. Mirrors
 *  rollingExtremumSeries in strategy-evaluator.ts:943. */
function emitRollingExtremum(
  fn: "high" | "low",
  args: Expr[],
  ctx: EmitContext
): string {
  if (args.length !== 1) {
    ctx.errors.push(`${fn}(N) requires 1 arg`);
    return "double.NaN";
  }
  const off = renderOffset(ctx.barOffset);
  const period = emitExpr(args[0], ctx);
  const method = fn === "high" ? "RollingHigh" : "RollingLow";
  return `DslIndicators.${method}(_bars, ${off}, ${period})`;
}

function emitBarsSinceExtremum(
  fn: "bars_since_high" | "bars_since_low",
  args: Expr[],
  ctx: EmitContext
): string {
  if (args.length !== 1) {
    ctx.errors.push(`${fn}(N) requires 1 arg`);
    return "double.NaN";
  }
  const off = renderOffset(ctx.barOffset);
  const period = emitExpr(args[0], ctx);
  const method = fn === "bars_since_high" ? "BarsSinceHigh" : "BarsSinceLow";
  return `DslIndicators.${method}(_bars, ${off}, ${period})`;
}

/** Sanitize a let name into a C# identifier suffix. The DSL allows
 *  underscores + alphanumerics, which is already valid C#, so this
 *  is mostly a passthrough — but it gives us a single place to
 *  apply additional munging if we ever need it. */
export function csIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Build a fresh EmitContext with empty mutable state. The caller
 *  owns the context across multiple expression emissions on the
 *  same strategy so requiresTicks / crossSlots / etc. accumulate. */
export function makeEmitContext(
  params: Record<string, number>,
  letDefs: Map<string, Expr>
): EmitContext {
  return {
    params,
    letDefs,
    requiresTicks: false,
    crossSlots: [],
    barsSinceCondSlots: [],
    errors: [],
    barOffset: "current",
    nextSlotId: 0,
    insideAnyBarIn: false,
    warnedParams: new Set<string>(),
  };
}
