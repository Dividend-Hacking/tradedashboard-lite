/**
 * script-expr.ts — Expression engine for the Backtest Script DSL.
 *
 * This is "Script v2": numeric fields like `rules.timedExitBars` may now
 * receive an EXPRESSION on the right-hand side instead of just a literal,
 * and two new directive paths (`print` and `ontrade.print`) collect
 * expressions whose values are surfaced as printed output.
 *
 * Pipeline:
 *   1. compile(text)    → Expr (Pratt parser, AST as discriminated union)
 *   2. referencedSymbols(expr) → which indicators / functions / idents the
 *      expression touches. Lets the simulator precompute exactly the bar
 *      series it needs, once per zone.
 *   3. evaluate(expr, ctx) → number. Runs against a per-trade context
 *      (entry bar + precomputed indicator series) or a strategy-level
 *      summary context (post-run aggregate stats).
 *
 * Design choices:
 *   - **Pratt parser** — small operator table (`+ -` 10, `* / %` 20,
 *     `^` 30 right-assoc, unary `-` 40). Pratt makes precedence + right-
 *     associativity declarative without a recursive-descent ladder, and
 *     makes adding comparisons / conditionals later (v2.1) a one-line
 *     change instead of a refactor.
 *   - **No throws on runtime issues.** Evaluation returns NaN for missing
 *     idents, divide-by-zero, missing indicator data, etc. The caller
 *     decides whether to surface a warning or fall back to a default —
 *     keeps the evaluator pure & testable.
 *   - **No assignment / no side effects** in the language. Expressions
 *     are pure value computations against an immutable EvalCtx. Print
 *     directives wrap an expression and a label, evaluated and stored
 *     by the caller — the engine itself never mutates state.
 *   - **Backwards-compatible.** A bare numeric literal compiles to
 *     `{ kind: "num" }` and evaluates to the same number as
 *     `parseValueLiteral` would have produced before, so existing scripts
 *     don't observe any behavior change.
 */

import type { TradeZone, TradeZoneBar } from "@/types/trade-zone";
import {
  atrSeries,
  emaSeries,
  smaSeries,
  adxSeries,
  volumeMaSeries,
  stdevReturnsSeries,
  // Extended indicator library — see "Extended indicator library"
  // section in calculations.ts.
  wmaSeries,
  hmaSeries,
  demaSeries,
  temaSeries,
  vwmaSeries,
  rsiSeries,
  rocSeries,
  momSeries,
  cciSeries,
  williamsRSeries,
  trixSeries,
  mfiSeries,
  macdLineSeries,
  macdSignalSeries,
  macdHistSeries,
  bbMidSeries,
  bbUpperSeries,
  bbLowerSeries,
  bbWidthSeries,
  bbPercentSeries,
  stochKSeries,
  stochDSeries,
  donchianUpperSeries,
  donchianLowerSeries,
  donchianMidSeries,
  trSeries,
  natrSeries,
  hvSeries,
  obvSeries,
  adSeries,
  cmfSeries,
  hhvSeries,
  llvSeries,
  closeNSeries,
  highNSeries,
  lowNSeries,
  openNSeries,
  volumeNSeries,
  type IndicatorBar,
} from "@/lib/indicators/calculations";

// ─── AST ────────────────────────────────────────────────────────────────────

/** Expression AST. Discriminated union — pattern-match in the evaluator.
 *
 *  Comparison ops (>, <, >=, <=, ==, !=) and logical ops (&&, ||) return
 *  1.0 for true / 0.0 for false so the engine stays numeric end-to-end —
 *  no separate Boolean type. NaN inputs propagate as NaN through
 *  comparisons (so `NaN > 0` is NaN, not 0); logical ops treat NaN as
 *  false. The unary `!` flips a number: 0 → 1, anything-nonzero → 0,
 *  NaN → NaN. This keeps null-safety and tri-state semantics consistent
 *  with the rest of the evaluator. */
export type Expr =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "unary"; op: "-" | "+" | "!"; arg: Expr }
  | {
      kind: "binop";
      op:
        | "+" | "-" | "*" | "/" | "%" | "^"
        | ">" | "<" | ">=" | "<=" | "==" | "!="
        | "&&" | "||";
      lhs: Expr;
      rhs: Expr;
    }
  // Conditional expression: `if cond then a else b`. Lowest precedence —
  // only legal as a prefix-position element (start of an expression / inside
  // parens / inside arg list / on the RHS of a `var` declaration). NaN cond
  // propagates as NaN result; finite-non-zero takes the `then` branch, finite-
  // zero (and explicit zero) takes the `else` branch — matches `evaluateBool`.
  | { kind: "if"; cond: Expr; then: Expr; else: Expr };

/** Result of compiling a single expression source string. */
export type CompileResult =
  | { ok: true; expr: Expr; source: string }
  | { ok: false; error: string };

// ─── Tokenizer ──────────────────────────────────────────────────────────────
//
// Single-pass regex scan. We deliberately mirror the number-literal regex
// from `parseValueLiteral` in backtest-script.ts so a bare number tokenizes
// byte-identically here — that's what guarantees back-compat for existing
// scripts.

type Tok =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "punct"; value: string };

const NUM_RE = /^(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
// Single-character punct fallback. Multi-char operators (>=, <=, ==, !=,
// &&, ||) are matched explicitly below so we don't have to backtrack.
const PUNCT_RE = /^[+\-*/%^(),<>=!&|]/;

// Two-character operators that must be checked BEFORE the single-char
// fallback. Order matters within this list only insofar as the first
// match wins — all entries here are 2 chars so there's no ambiguity.
const TWO_CHAR_OPS = ["==", "!=", ">=", "<=", "&&", "||"] as const;

function tokenize(text: string): { ok: true; toks: Tok[] } | { ok: false; error: string } {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const rest = text.slice(i);
    let m = rest.match(NUM_RE);
    if (m) {
      toks.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    m = rest.match(IDENT_RE);
    if (m) {
      toks.push({ kind: "ident", name: m[0] });
      i += m[0].length;
      continue;
    }
    // Two-char punct first — `>=` must beat `>` to avoid splitting into
    // two tokens. Cheap O(N) over the small TWO_CHAR_OPS list.
    let two: string | null = null;
    for (const op of TWO_CHAR_OPS) {
      if (rest.startsWith(op)) {
        two = op;
        break;
      }
    }
    if (two) {
      toks.push({ kind: "punct", value: two });
      i += 2;
      continue;
    }
    m = rest.match(PUNCT_RE);
    if (m) {
      // Bare `&` or `|` is almost certainly a user typo for `&&` / `||`
      // — surface a pointed error instead of letting the parser fail
      // with a generic "unexpected token" later.
      if (m[0] === "&" || m[0] === "|") {
        return {
          ok: false,
          error: `bare "${m[0]}" at position ${i} — did you mean "${m[0]}${m[0]}"?`,
        };
      }
      // Bare `=` is a typo for `==` in expression context (the script's
      // outer `path = value` `=` is consumed by the line parser BEFORE
      // the expression engine sees the RHS).
      if (m[0] === "=") {
        return {
          ok: false,
          error: `bare "=" at position ${i} — use "==" for equality`,
        };
      }
      toks.push({ kind: "punct", value: m[0] });
      i += m[0].length;
      continue;
    }
    return { ok: false, error: `unexpected character "${c}" at position ${i}` };
  }
  return { ok: true, toks };
}

// ─── Parser (Pratt) ─────────────────────────────────────────────────────────

// Precedence table — lowest-to-highest. The script DSL's expression
// grammar is roughly C-like:
//   ||                     (logical or)            — 2
//   &&                     (logical and)           — 4
//   == != < > <= >=        (comparisons)           — 6
//   + -                    (additive)              — 10
//   * / %                  (multiplicative)        — 20
//   ^                      (exponent, right-assoc) — 30
//   - + !                  (unary prefix)          — 40
// Logical ops sit BELOW comparisons so `a > 0 && b < 10` parses as
// `(a > 0) && (b < 10)` — same precedence rules every C-family language
// uses, so users porting filter expressions from elsewhere don't get
// surprises. Comparisons are NON-associative in spirit (`a < b < c` is
// nonsensical here) but we keep them left-associative to avoid a
// special-case parser rule; users who write that get `(a<b) < c` which
// evaluates to a meaningful number even if it's not what they meant.
const INFIX_PRECEDENCE: Record<string, number> = {
  "||": 2,
  "&&": 4,
  "==": 6,
  "!=": 6,
  "<": 6,
  ">": 6,
  "<=": 6,
  ">=": 6,
  "+": 10,
  "-": 10,
  "*": 20,
  "/": 20,
  "%": 20,
  "^": 30,
};
const RIGHT_ASSOC: Record<string, boolean> = { "^": true };
const UNARY_PRECEDENCE = 40;

class ParserState {
  pos = 0;
  constructor(public toks: Tok[]) {}
  peek(): Tok | null {
    return this.pos < this.toks.length ? this.toks[this.pos] : null;
  }
  next(): Tok | null {
    return this.pos < this.toks.length ? this.toks[this.pos++] : null;
  }
  eatPunct(s: string): boolean {
    const t = this.peek();
    if (t && t.kind === "punct" && t.value === s) {
      this.pos++;
      return true;
    }
    return false;
  }
}

type BinOp = (Expr & { kind: "binop" })["op"];

function parseExpr(p: ParserState, minBp: number): Expr {
  // Prefix.
  let left = parsePrefix(p);

  // Infix loop.
  while (true) {
    const t = p.peek();
    if (!t || t.kind !== "punct") break;
    const op = t.value;
    const bp = INFIX_PRECEDENCE[op];
    if (bp === undefined || bp < minBp) break;
    p.next();
    const nextMinBp = RIGHT_ASSOC[op] ? bp : bp + 1;
    const rhs = parseExpr(p, nextMinBp);
    left = { kind: "binop", op: op as BinOp, lhs: left, rhs };
  }
  return left;
}

function parsePrefix(p: ParserState): Expr {
  const t = p.next();
  if (!t) throw new Error("unexpected end of expression");
  if (t.kind === "num") return { kind: "num", value: t.value };
  if (t.kind === "ident") {
    // `if cond then a else b` — a conditional expression. `if` is a soft
    // keyword recognized only when it appears in prefix position; bare
    // ident `if` (no `then`/`else`) would still be valid as a regular
    // identifier, but in practice `then`/`else` are never used as bare
    // identifiers in this DSL so we always treat `if` as the keyword.
    if (t.name === "if") {
      const cond = parseExpr(p, 0);
      const thenTok = p.next();
      if (!thenTok || thenTok.kind !== "ident" || thenTok.name !== "then") {
        throw new Error('expected "then" after if-condition');
      }
      const thenExpr = parseExpr(p, 0);
      const elseTok = p.next();
      if (!elseTok || elseTok.kind !== "ident" || elseTok.name !== "else") {
        throw new Error('expected "else" after then-branch');
      }
      const elseExpr = parseExpr(p, 0);
      return { kind: "if", cond, then: thenExpr, else: elseExpr };
    }
    // Function call: identifier followed by `(`.
    const next = p.peek();
    if (next && next.kind === "punct" && next.value === "(") {
      p.next(); // consume "("
      const args: Expr[] = [];
      // Empty arg list: ident()
      if (!p.eatPunct(")")) {
        args.push(parseExpr(p, 0));
        while (p.eatPunct(",")) args.push(parseExpr(p, 0));
        if (!p.eatPunct(")")) throw new Error('expected ")" after function arguments');
      }
      return { kind: "call", name: t.name, args };
    }
    return { kind: "ident", name: t.name };
  }
  if (t.kind === "punct") {
    if (t.value === "(") {
      const inner = parseExpr(p, 0);
      if (!p.eatPunct(")")) throw new Error('expected ")"');
      return inner;
    }
    // Unary: `-`, `+`, and `!` (logical NOT). All bind tighter than any
    // infix op so `!a > 0` parses as `(!a) > 0` — same as C.
    if (t.value === "-" || t.value === "+" || t.value === "!") {
      const arg = parseExpr(p, UNARY_PRECEDENCE);
      return { kind: "unary", op: t.value, arg };
    }
  }
  throw new Error(`unexpected token "${tokDisplay(t)}"`);
}

function tokDisplay(t: Tok): string {
  if (t.kind === "num") return String(t.value);
  if (t.kind === "ident") return t.name;
  return t.value;
}

// ─── Public compile ─────────────────────────────────────────────────────────

/** Compile a single expression source. Returns the AST or an error message
 *  suitable for the script editor's error gutter. */
export function compile(text: string): CompileResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "empty expression" };
  const tk = tokenize(trimmed);
  if (!tk.ok) return { ok: false, error: tk.error };
  if (tk.toks.length === 0) return { ok: false, error: "empty expression" };
  try {
    const p = new ParserState(tk.toks);
    const expr = parseExpr(p, 0);
    if (p.pos < tk.toks.length) {
      return { ok: false, error: `unexpected trailing tokens after expression` };
    }
    return { ok: true, expr, source: trimmed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Referenced symbols ─────────────────────────────────────────────────────

/** Walks the AST once and collects every identifier and function call —
 *  used to precompute exactly the indicator series the run will need,
 *  rather than computing per trade. Args on calls are collected as
 *  literal numbers when EVERY argument is a `num` node; dynamic args
 *  (e.g. `ATR(myParam)`) leave `args` undefined so precompute skips that
 *  call and the evaluator falls back to per-trade resolution. */
export interface ReferencedSymbols {
  idents: Set<string>;
  calls: Array<{ name: string; args?: number[] }>;
}

export function referencedSymbols(expr: Expr): ReferencedSymbols {
  const idents = new Set<string>();
  const calls: Array<{ name: string; args?: number[] }> = [];
  function walk(e: Expr): void {
    switch (e.kind) {
      case "num":
        return;
      case "ident":
        idents.add(e.name);
        return;
      case "call": {
        // Collect args only when every arg is a literal number — any
        // dynamic arg (`MACD_line(myFast, 26)`) means we can't precompute
        // a stable key, so we leave args undefined and let the evaluator
        // resolve per-trade.
        let args: number[] | undefined;
        if (e.args.every((a) => a.kind === "num")) {
          args = e.args.map((a) => (a as { kind: "num"; value: number }).value);
        }
        calls.push({ name: e.name, args });
        for (const a of e.args) walk(a);
        return;
      }
      case "unary":
        walk(e.arg);
        return;
      case "binop":
        walk(e.lhs);
        walk(e.rhs);
        return;
      case "if":
        walk(e.cond);
        walk(e.then);
        walk(e.else);
        return;
    }
  }
  walk(expr);
  return { idents, calls };
}

// ─── Binding substitution ───────────────────────────────────────────────────

/** Walk an Expr AST and substitute every bare-ident node whose name is
 *  in the binding table with the bound Expr. Used by the script parser
 *  to implement positional `var <name> = <expr>` shadowing: at parse
 *  time, the parser maintains a bindings map that evolves as it walks
 *  lines top-to-bottom; every expression on a downstream line gets its
 *  references rewritten via this helper before being stored, so the
 *  binding active at the line of reference is baked into the AST.
 *
 *  Substitution is a single-pass walk — bound Exprs are inserted as-is.
 *  The parser is responsible for ensuring the bound Expr has ALREADY
 *  had earlier bindings applied to it (apply-then-store), so a binding
 *  never references another live binding by name; this avoids any need
 *  for cycle detection at substitution time. Function-call NAMES are
 *  not rewritten — only bare identifiers — so `myVar(x)` keeps its
 *  call structure even if `myVar` happens to be in the binding table
 *  (in practice users don't shadow function names, but the rule keeps
 *  the substitution mechanically simple). */
export function applyBindings(expr: Expr, bindings: Map<string, Expr>): Expr {
  if (bindings.size === 0) return expr;
  switch (expr.kind) {
    case "num":
      return expr;
    case "ident": {
      const bound = bindings.get(expr.name);
      return bound ?? expr;
    }
    case "call":
      return { ...expr, args: expr.args.map((a) => applyBindings(a, bindings)) };
    case "unary":
      return { ...expr, arg: applyBindings(expr.arg, bindings) };
    case "binop":
      return {
        ...expr,
        lhs: applyBindings(expr.lhs, bindings),
        rhs: applyBindings(expr.rhs, bindings),
      };
    case "if":
      return {
        ...expr,
        cond: applyBindings(expr.cond, bindings),
        then: applyBindings(expr.then, bindings),
        else: applyBindings(expr.else, bindings),
      };
  }
}

// ─── Evaluation context ─────────────────────────────────────────────────────

/** Per-trade EvalCtx — the context for `ontrade.print` and per-trade rule
 *  expressions. The simulator builds one of these at each entry bar.
 *
 *  `indicatorByKey` is the precomputed map: keys like "ATR:14", "EMA:20",
 *  "VOL:14". Each value is a number[] aligned with the zone's bars (NaN
 *  during warmup). At evaluate time we look up the value at `barIndex`.
 */
export interface EntryEvalCtx {
  bar: TradeZoneBar;
  barIndex: number;
  indicatorByKey: Map<string, number[]>;
  zone: TradeZone;
  /** Global tick/point config — populated by the simulator from the
   *  active SimRules. Powers the `ticks(n)` and `point(n)` script
   *  helpers and exposes `tickValue` / `pointValue` / `ticksPerPoint`
   *  as bare identifiers in any expression. Optional so unit tests +
   *  legacy callers that don't care can pass undefined; the helpers
   *  return NaN when missing, which the optimizer treats as "skip
   *  this signal" (same NaN-fallback as other warmup misses). */
  tickConfig?: {
    ticksPerPoint: number;
    pointValue: number;
    tickValue: number;
  };
  /** Resolved values for `var <name> = Optimize.X.Y(...)` declarations.
   *  Populated by the online optimizer per signal — bare-name lookup
   *  for `<name>` returns the optimizer's current best value. NaN
   *  (or undefined) before the optimizer warms up, which propagates
   *  through any expression that references the var (NaN-as-fail in
   *  filter.if conditions). Empty / undefined when the run isn't
   *  driven by the optimizer. */
  varValues?: Map<string, number>;
}

/** Summary EvalCtx — the context for top-level `print = ...` expressions,
 *  evaluated once after the run. The symbol table is just a flat record
 *  of aggregate metrics (SimSummary + SummaryStats merged). No function
 *  calls supported in summary context — pure identifier lookup. */
export interface SummaryEvalCtx {
  symbols: Record<string, number>;
}

export type EvalCtx =
  | ({ kind: "entry" } & EntryEvalCtx)
  | ({ kind: "summary" } & SummaryEvalCtx);

// ─── Bare-name resolution ───────────────────────────────────────────────────
//
// When the user writes a bare identifier like `ATR`, `EMA20`, or `volume`,
// we resolve it to either a precomputed indicator value (from the entry
// EvalCtx) or a current-bar field. Function-call form (e.g. `ATR(14)`) is
// handled separately by `evalCall` — see below.

// Bare-name shortcut indicators — e.g. RSI14 → RSI(14), WMA20 → WMA(20).
// We extend the original (ATR|EMA|SMA|ADX|VOL) set with the new
// single-period families. WilliamsR is omitted because its mixed case
// doesn't compose cleanly with a numeric suffix.
const BARE_INDICATOR_REGEX =
  /^(ATR|EMA|SMA|ADX|VOL|RSI|WMA|HMA|DEMA|TEMA|VWMA|ROC|MOM|CCI|TRIX|MFI|NATR|HV|CMF|HHV|LLV)(\d+)$/;

/** "ATR" → ATR(14), "ADX14" → ADX(14), "EMA20" → EMA(20), etc. Returns
 *  the matching indicatorByKey lookup key, or null if the name isn't a
 *  recognized bare-indicator alias. Zero-arg cumulative indicators
 *  (OBV/AD/TR) use the same key without a period suffix. */
function bareIndicatorKey(name: string): string | null {
  if (name === "ATR") return "ATR:14";
  if (name === "ADX" || name === "ADX14") return "ADX:14";
  if (name === "ATR14") return "ATR:14";
  if (name === "RSI") return "RSI:14"; // bare RSI defaults to period 14
  // Zero-arg cumulative indicators — keys with no colon, populated by
  // gatherRequiredSeries / computeIndicatorSeries.
  if (name === "OBV") return "OBV";
  if (name === "AD") return "AD";
  if (name === "TR") return "TR";
  const m = name.match(BARE_INDICATOR_REGEX);
  if (m) return `${m[1]}:${m[2]}`;
  return null;
}

/** Bar-shape scalars derived from the current bar. These are zero-arg
 *  identifiers with no precompute step — resolveIdent inlines the math
 *  using bar OHLC. Listed here so other dispatch tables (e.g. the
 *  reference page) can treat them as a uniform group. */
const BAR_SHAPE_IDENTS = new Set<string>([
  "range",
  "body",
  "upper_wick",
  "lower_wick",
  "typical",
  "median_price",
  "weighted_close",
]);

// ─── Evaluation ─────────────────────────────────────────────────────────────

/** Evaluate an AST against an EvalCtx. Always returns a number — NaN on
 *  any missing-symbol / divide-by-zero / out-of-range condition. The
 *  caller decides how to handle NaN (typical: fall back to a default and
 *  surface a warning). */
export function evaluate(expr: Expr, ctx: EvalCtx): number {
  switch (expr.kind) {
    case "num":
      return expr.value;
    case "unary": {
      const v = evaluate(expr.arg, ctx);
      if (expr.op === "-") return -v;
      if (expr.op === "+") return v;
      // Logical NOT: NaN propagates, 0 → 1, anything-nonzero → 0. The
      // NaN passthrough preserves the "missing data is missing data"
      // discipline the rest of the engine uses.
      if (Number.isNaN(v)) return NaN;
      return v === 0 ? 1 : 0;
    }
    case "binop": {
      // Short-circuit logicals — don't eval the RHS if the LHS already
      // decides the result. Treats NaN as "unknown/false" for &&/|| so
      // `null indicator && rest` cleanly fails the gate without NaN-
      // poisoning the entire expression tree. Comparisons keep stricter
      // NaN semantics (NaN propagates) so users notice missing data.
      if (expr.op === "&&") {
        const a = evaluate(expr.lhs, ctx);
        if (!Number.isFinite(a) || a === 0) return 0;
        const b = evaluate(expr.rhs, ctx);
        return Number.isFinite(b) && b !== 0 ? 1 : 0;
      }
      if (expr.op === "||") {
        const a = evaluate(expr.lhs, ctx);
        if (Number.isFinite(a) && a !== 0) return 1;
        const b = evaluate(expr.rhs, ctx);
        return Number.isFinite(b) && b !== 0 ? 1 : 0;
      }
      const a = evaluate(expr.lhs, ctx);
      const b = evaluate(expr.rhs, ctx);
      switch (expr.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return b === 0 ? NaN : a / b;
        case "%":
          return b === 0 ? NaN : a % b;
        case "^":
          return Math.pow(a, b);
        // Comparisons return 1.0 / 0.0; NaN inputs propagate as NaN so
        // an undefined-value comparison registers as "missing" rather
        // than silently false. Callers (filter.if verdict, &&/||) treat
        // NaN as not-passing.
        case ">":
          return Number.isNaN(a) || Number.isNaN(b) ? NaN : a > b ? 1 : 0;
        case "<":
          return Number.isNaN(a) || Number.isNaN(b) ? NaN : a < b ? 1 : 0;
        case ">=":
          return Number.isNaN(a) || Number.isNaN(b) ? NaN : a >= b ? 1 : 0;
        case "<=":
          return Number.isNaN(a) || Number.isNaN(b) ? NaN : a <= b ? 1 : 0;
        case "==":
          return Number.isNaN(a) || Number.isNaN(b) ? NaN : a === b ? 1 : 0;
        case "!=":
          return Number.isNaN(a) || Number.isNaN(b) ? NaN : a !== b ? 1 : 0;
      }
      return NaN;
    }
    case "ident":
      return resolveIdent(expr.name, ctx);
    case "call":
      return ctx.kind === "entry"
        ? evalCallEntry(expr.name, expr.args, ctx)
        : NaN; // No function calls in summary context.
    case "if": {
      // Conditional: NaN cond → NaN result (preserves the missing-data
      // discipline used by comparisons and unary !). Finite-non-zero →
      // then-branch; finite-zero → else-branch. Same truthiness rule as
      // `evaluateBool`, kept consistent so users don't get surprised by
      // a conditional that disagrees with a filter.if verdict on the
      // same expression.
      const c = evaluate(expr.cond, ctx);
      if (Number.isNaN(c)) return NaN;
      return c !== 0 ? evaluate(expr.then, ctx) : evaluate(expr.else, ctx);
    }
  }
}

/** Evaluate an expression as a boolean verdict: true iff the result is
 *  finite AND non-zero. NaN (missing data, divide-by-zero, etc.) is
 *  treated as false — same null-as-fail discipline that
 *  `evaluatePresetFilters` uses for indicator warmup. Used by the
 *  filter.if runtime to decide which branch to take. */
export function evaluateBool(expr: Expr, ctx: EvalCtx): boolean {
  const v = evaluate(expr, ctx);
  return Number.isFinite(v) && v !== 0;
}

function resolveIdent(name: string, ctx: EvalCtx): number {
  if (ctx.kind === "summary") {
    const v = ctx.symbols[name];
    return typeof v === "number" ? v : NaN;
  }
  // Entry context — current bar fields first, then indicator aliases.
  const bar = ctx.bar;
  switch (name) {
    case "open":
      return bar.bar_open;
    case "high":
      return bar.bar_high;
    case "low":
      return bar.bar_low;
    case "close":
      return bar.bar_close;
    case "volume":
      return bar.bar_volume;
    case "bar_index":
      return ctx.barIndex;
    case "direction":
      return ctx.zone.direction === "Long" ? 1 : -1;
    // Bar-shape scalars — derived from the current bar's OHLC. No
    // precompute needed; same NaN-on-missing convention as the OHLC
    // fields above (always finite when the bar is well-formed).
    case "range":
      return bar.bar_high - bar.bar_low;
    case "body":
      return bar.bar_close - bar.bar_open;
    case "upper_wick":
      return bar.bar_high - Math.max(bar.bar_open, bar.bar_close);
    case "lower_wick":
      return Math.min(bar.bar_open, bar.bar_close) - bar.bar_low;
    case "typical":
      return (bar.bar_high + bar.bar_low + bar.bar_close) / 3;
    case "median_price":
      return (bar.bar_high + bar.bar_low) / 2;
    case "weighted_close":
      return (bar.bar_high + bar.bar_low + 2 * bar.bar_close) / 4;
    // Tick config — bare-name access. Returns NaN when the simulator
    // didn't populate tickConfig (legacy callers / unit tests).
    case "ticksPerPoint":
      return ctx.tickConfig?.ticksPerPoint ?? NaN;
    case "pointValue":
      return ctx.tickConfig?.pointValue ?? NaN;
    case "tickValue":
      return ctx.tickConfig?.tickValue ?? NaN;
  }
  // Optimize var lookup — `var <name> = Optimize.X.Y(...)` declarations
  // expose `<name>` as a bare identifier whose value is whatever the
  // online optimizer chose for THIS signal. NaN before warmup or when
  // the run isn't driven by the optimizer (in which case the user's
  // condition will fail-closed via the rest of the NaN-propagation
  // discipline). Checked before bareIndicatorKey so a var named `RSI`
  // would shadow the bare ATR-style indicator alias — but we recommend
  // distinct names anyway.
  if (ctx.varValues) {
    const v = ctx.varValues.get(name);
    if (v !== undefined) return v;
  }
  const key = bareIndicatorKey(name);
  if (key) {
    const series = ctx.indicatorByKey.get(key);
    if (series && ctx.barIndex >= 0 && ctx.barIndex < series.length) {
      const v = series[ctx.barIndex];
      return typeof v === "number" ? v : NaN;
    }
    return NaN;
  }
  return NaN;
}

const MATH_FNS: Record<string, (...xs: number[]) => number> = {
  abs: (x) => Math.abs(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x) => Math.round(x),
  sqrt: (x) => Math.sqrt(x),
  log: (x) => Math.log(x),
  exp: (x) => Math.exp(x),
};

/** Zero-arg indicator names — OBV/AD/TR are cumulative or per-bar
 *  values with no parameters. They map to a precomputed key with no
 *  colon. Tracked separately so evalCallEntry / gatherRequiredSeries
 *  can short-circuit period extraction. */
const ZERO_ARG_INDICATORS = new Set<string>(["OBV", "AD", "TR"]);

/** Apply standard defaults for indicators where the user may omit
 *  trailing args. e.g. `BB_upper(20)` should resolve like
 *  `BB_upper(20, 2)`. Returns a new args array (never mutates input).
 *  Defaults match standard TA conventions:
 *    - BB families: mult = 2
 *    - MACD signal/hist: signal = 9
 *    - Stoch_D: smoothK = 3, smoothD = 3
 *  Names not listed return args unchanged. */
function applyArgDefaults(name: string, args: number[]): number[] {
  switch (name) {
    case "BB_upper":
    case "BB_lower":
    case "BB_width":
    case "BB_percent":
      return args.length >= 2 ? args : [args[0], 2];
    case "MACD_signal":
    case "MACD_hist":
      return args.length >= 3 ? args : [args[0], args[1], 9];
    case "Stoch_D":
      if (args.length >= 3) return args;
      if (args.length === 2) return [args[0], args[1], 3];
      return [args[0], 3, 3];
    default:
      return args;
  }
}

function evalCallEntry(name: string, args: Expr[], ctx: EntryEvalCtx & { kind: "entry" }): number {
  // Tick helpers — special-cased before MATH_FNS because they need
  // ctx.tickConfig. ticks(n) returns the price-point distance covered
  // by n ticks (= n / ticksPerPoint). point(n) is the inverse — how
  // many ticks fit in n points (= n * ticksPerPoint). Both return NaN
  // when tickConfig is missing or ticksPerPoint <= 0; the optimizer
  // catches NaN bounds and skips that signal with a warning.
  if (name === "ticks" && args.length === 1) {
    const n = evaluate(args[0], ctx);
    const tpp = ctx.tickConfig?.ticksPerPoint;
    if (!tpp || tpp <= 0 || !Number.isFinite(n)) return NaN;
    return n / tpp;
  }
  if (name === "point" && args.length === 1) {
    const n = evaluate(args[0], ctx);
    const tpp = ctx.tickConfig?.ticksPerPoint;
    if (!tpp || tpp <= 0 || !Number.isFinite(n)) return NaN;
    return n * tpp;
  }
  // Math passthroughs.
  const mfn = MATH_FNS[name];
  if (mfn) {
    const xs = args.map((a) => evaluate(a, ctx));
    return mfn(...xs);
  }
  // Zero-arg cumulative indicators — call form `OBV()`, `AD()`, `TR()`.
  // The bare-ident form is handled by resolveIdent. Both look up the
  // same indicator key (no colon).
  if (ZERO_ARG_INDICATORS.has(name)) {
    const series = ctx.indicatorByKey.get(name);
    if (!series || ctx.barIndex < 0 || ctx.barIndex >= series.length) return NaN;
    const v = series[ctx.barIndex];
    return typeof v === "number" ? v : NaN;
  }
  // Indicator calls — evaluate every arg, then build the cache key.
  // We round every arg to int because periods/lookbacks are integer-
  // typed in the underlying calculators. mults (e.g. BB_upper's 2.0)
  // are also rounded; users who want fractional bands should pass an
  // integer multiplier.
  const evaluated: number[] = [];
  for (const a of args) {
    const v = evaluate(a, ctx);
    if (!Number.isFinite(v) || v <= 0) return NaN;
    evaluated.push(Math.round(v));
  }
  const withDefaults = applyArgDefaults(name, evaluated);
  const key = indicatorKeyForCall(name, withDefaults);
  if (!key) return NaN;
  const series = ctx.indicatorByKey.get(key);
  if (!series || ctx.barIndex < 0 || ctx.barIndex >= series.length) return NaN;
  const v = series[ctx.barIndex];
  return typeof v === "number" ? v : NaN;
}

/** Map a function-call name + args to the precomputed indicator series
 *  key. Single-period families produce keys like `RSI:14`. Multi-arg
 *  families compose all args into the key (e.g. `MACDL:12:26`). Zero-
 *  arg cumulative indicators (OBV/AD/TR) get their bare name as key.
 *  `trailVol` is an alias for `volume`. */
export function indicatorKeyForCall(name: string, args: number[]): string | null {
  // Zero-arg families — keys with no period suffix.
  if (ZERO_ARG_INDICATORS.has(name)) return name;
  // Single-period helpers expect args[0]; missing → fail.
  const p = args[0];
  switch (name) {
    case "ATR":
      return `ATR:${p}`;
    case "EMA":
      return `EMA:${p}`;
    case "SMA":
      return `SMA:${p}`;
    case "ADX":
      return `ADX:${p}`;
    case "volume":
    case "trailVol":
      return `VOL:${p}`;
    case "stdev":
      return `STDEV:${p}`;
    case "WMA":
      return `WMA:${p}`;
    case "HMA":
      return `HMA:${p}`;
    case "DEMA":
      return `DEMA:${p}`;
    case "TEMA":
      return `TEMA:${p}`;
    case "VWMA":
      return `VWMA:${p}`;
    case "RSI":
      return `RSI:${p}`;
    case "ROC":
      return `ROC:${p}`;
    case "MOM":
      return `MOM:${p}`;
    case "CCI":
      return `CCI:${p}`;
    case "WilliamsR":
      return `WILLR:${p}`;
    case "TRIX":
      return `TRIX:${p}`;
    case "MFI":
      return `MFI:${p}`;
    case "NATR":
      return `NATR:${p}`;
    case "HV":
      return `HV:${p}`;
    case "CMF":
      return `CMF:${p}`;
    case "HHV":
      return `HHV:${p}`;
    case "LLV":
      return `LLV:${p}`;
    case "Stoch_K":
      return `STOCHK:${p}`;
    case "Donchian_upper":
      return `DONCHU:${p}`;
    case "Donchian_lower":
      return `DONCHL:${p}`;
    case "Donchian_mid":
      return `DONCHM:${p}`;
    case "BB_mid":
      return `BBMID:${p}`;
    case "close_n":
      return `CLOSEN:${p}`;
    case "high_n":
      return `HIGHN:${p}`;
    case "low_n":
      return `LOWN:${p}`;
    case "open_n":
      return `OPENN:${p}`;
    case "volume_n":
      return `VOLN:${p}`;
    // Multi-arg families — every literal arg participates in the key.
    case "MACD_line":
      return `MACDL:${args[0]}:${args[1]}`;
    case "MACD_signal":
      return `MACDS:${args[0]}:${args[1]}:${args[2]}`;
    case "MACD_hist":
      return `MACDH:${args[0]}:${args[1]}:${args[2]}`;
    case "BB_upper":
      return `BBU:${args[0]}:${args[1]}`;
    case "BB_lower":
      return `BBL:${args[0]}:${args[1]}`;
    case "BB_width":
      return `BBW:${args[0]}:${args[1]}`;
    case "BB_percent":
      return `BBP:${args[0]}:${args[1]}`;
    case "Stoch_D":
      return `STOCHD:${args[0]}:${args[1]}:${args[2]}`;
    default:
      return null;
  }
}

// ─── Symbol catalogue (for editor autocomplete + docs) ──────────────────────

/** Public catalogue of every symbol the entry-context evaluator
 *  recognizes. The editor consumes this for autocomplete and hover
 *  tooltips when the caret is in the RHS of a numeric-typed line. */
export interface ExprSymbol {
  name: string;
  kind: "ident" | "call" | "math" | "operator";
  signature?: string; // e.g. "ATR(period)"
  description: string;
  context: "entry" | "summary" | "both";
}

/** Comparison + logical operators surfaced by the expression engine.
 *  Distinct from EXPR_SYMBOLS so the editor can group them in their own
 *  panel and the AI script reference can document them as a unit. All
 *  operators return 1.0 (true) / 0.0 (false); see `evaluate()` for the
 *  exact NaN propagation rules. */
export const EXPR_OPERATORS: ExprSymbol[] = [
  { name: ">", kind: "operator", signature: "a > b", description: "Greater-than. Returns 1 if a > b, 0 if not, NaN if either side is NaN.", context: "both" },
  { name: "<", kind: "operator", signature: "a < b", description: "Less-than. Returns 1 if a < b, 0 if not, NaN if either side is NaN.", context: "both" },
  { name: ">=", kind: "operator", signature: "a >= b", description: "Greater-than-or-equal. Returns 1/0/NaN.", context: "both" },
  { name: "<=", kind: "operator", signature: "a <= b", description: "Less-than-or-equal. Returns 1/0/NaN.", context: "both" },
  { name: "==", kind: "operator", signature: "a == b", description: "Equality. Returns 1/0/NaN. Use ATR-based tolerances if comparing computed values, since equality on floats rarely holds exactly.", context: "both" },
  { name: "!=", kind: "operator", signature: "a != b", description: "Inequality. Returns 1/0/NaN.", context: "both" },
  { name: "&&", kind: "operator", signature: "a && b", description: "Logical AND. Short-circuits: if a is 0/NaN, b is not evaluated. Result is 1 only when both sides are finite and non-zero.", context: "both" },
  { name: "||", kind: "operator", signature: "a || b", description: "Logical OR. Short-circuits: if a is finite and non-zero, b is not evaluated. Result is 1 when either side is finite and non-zero.", context: "both" },
  { name: "!", kind: "operator", signature: "!a", description: "Logical NOT. 0 → 1, any non-zero finite number → 0, NaN → NaN.", context: "both" },
];

export const EXPR_SYMBOLS: ExprSymbol[] = [
  // Bare indicator aliases.
  { name: "ATR", kind: "ident", description: "Average True Range with period 14, evaluated at the trade's entry bar.", context: "entry" },
  { name: "ATR14", kind: "ident", description: "Alias for ATR — explicit period.", context: "entry" },
  { name: "EMA20", kind: "ident", description: "Exponential moving average (period 20) at entry bar.", context: "entry" },
  { name: "EMA50", kind: "ident", description: "Exponential moving average (period 50) at entry bar.", context: "entry" },
  { name: "EMA200", kind: "ident", description: "Exponential moving average (period 200) at entry bar.", context: "entry" },
  { name: "SMA20", kind: "ident", description: "Simple moving average (period 20) at entry bar.", context: "entry" },
  { name: "SMA50", kind: "ident", description: "Simple moving average (period 50) at entry bar.", context: "entry" },
  { name: "SMA200", kind: "ident", description: "Simple moving average (period 200) at entry bar.", context: "entry" },
  { name: "ADX", kind: "ident", description: "Average Directional Index with period 14 at entry bar.", context: "entry" },
  { name: "ADX14", kind: "ident", description: "Alias for ADX — explicit period.", context: "entry" },
  // Current-bar fields.
  { name: "open", kind: "ident", description: "Current entry bar's open price.", context: "entry" },
  { name: "high", kind: "ident", description: "Current entry bar's high price.", context: "entry" },
  { name: "low", kind: "ident", description: "Current entry bar's low price.", context: "entry" },
  { name: "close", kind: "ident", description: "Current entry bar's close price (= entry price under fillMode=close).", context: "entry" },
  { name: "volume", kind: "ident", description: "Current entry bar's traded volume.", context: "entry" },
  { name: "bar_index", kind: "ident", description: "Index of the entry bar within the zone (0 = entry).", context: "entry" },
  { name: "direction", kind: "ident", description: "+1 for long trades, -1 for short trades.", context: "entry" },
  // Indicator calls.
  { name: "ATR", kind: "call", signature: "ATR(period)", description: "Wilder ATR over the last `period` bars at entry.", context: "entry" },
  { name: "EMA", kind: "call", signature: "EMA(period)", description: "Exponential moving average of close over `period` bars.", context: "entry" },
  { name: "SMA", kind: "call", signature: "SMA(period)", description: "Simple moving average of close over `period` bars.", context: "entry" },
  { name: "ADX", kind: "call", signature: "ADX(period)", description: "Wilder ADX over `period` bars at entry.", context: "entry" },
  { name: "volume", kind: "call", signature: "volume(period)", description: "Trailing average volume over the last `period` bars.", context: "entry" },
  { name: "trailVol", kind: "call", signature: "trailVol(period)", description: "Alias for volume(period) — trailing average volume.", context: "entry" },
  { name: "stdev", kind: "call", signature: "stdev(period)", description: "Sample stdev of close-to-close returns over `period` bars.", context: "entry" },
  // Math passthroughs.
  { name: "abs", kind: "math", signature: "abs(x)", description: "Absolute value.", context: "both" },
  { name: "min", kind: "math", signature: "min(a, b, ...)", description: "Minimum of N arguments.", context: "both" },
  { name: "max", kind: "math", signature: "max(a, b, ...)", description: "Maximum of N arguments.", context: "both" },
  { name: "floor", kind: "math", signature: "floor(x)", description: "Round down to integer.", context: "both" },
  { name: "ceil", kind: "math", signature: "ceil(x)", description: "Round up to integer.", context: "both" },
  { name: "round", kind: "math", signature: "round(x)", description: "Round to nearest integer.", context: "both" },
  { name: "sqrt", kind: "math", signature: "sqrt(x)", description: "Square root.", context: "both" },
  { name: "log", kind: "math", signature: "log(x)", description: "Natural logarithm.", context: "both" },
  { name: "exp", kind: "math", signature: "exp(x)", description: "e^x.", context: "both" },
  // Tick / point helpers — backed by rules.ticksPerPoint, etc.
  { name: "ticks", kind: "call", signature: "ticks(n)", description: "Convert n ticks to price points using rules.ticksPerPoint. e.g. on NQ (4 ticks/pt), ticks(4) = 1 price point. Use inside Optimize bounds for tick-based floors.", context: "entry" },
  { name: "point", kind: "call", signature: "point(n)", description: "Convert n price points to ticks (= n * ticksPerPoint). Inverse of ticks().", context: "entry" },
  { name: "ticksPerPoint", kind: "ident", description: "Bare-name access to rules.ticksPerPoint.", context: "entry" },
  { name: "pointValue", kind: "ident", description: "Bare-name access to rules.pointValue ($/point).", context: "entry" },
  { name: "tickValue", kind: "ident", description: "Bare-name access to rules.tickValue ($/tick).", context: "entry" },

  // ─── Extended indicator library ─────────────────────────────────────────

  // Moving averages — single-output, period arg.
  { name: "WMA", kind: "call", signature: "WMA(period)", description: "Weighted moving average — linear weights 1..N over the trailing `period` closes. Heavier weight on recent bars than SMA.", context: "entry" },
  { name: "HMA", kind: "call", signature: "HMA(period)", description: "Hull MA — WMA(2*WMA(p/2) − WMA(p), sqrt(p)). Faster, less laggy than EMA.", context: "entry" },
  { name: "DEMA", kind: "call", signature: "DEMA(period)", description: "Double Exponential MA = 2*EMA − EMA(EMA). Reduces lag vs a plain EMA of the same period.", context: "entry" },
  { name: "TEMA", kind: "call", signature: "TEMA(period)", description: "Triple Exponential MA = 3*EMA − 3*EMA(EMA) + EMA(EMA(EMA)).", context: "entry" },
  { name: "VWMA", kind: "call", signature: "VWMA(period)", description: "Volume-weighted moving average — sum(close*volume) / sum(volume) over `period` bars.", context: "entry" },

  // Momentum / oscillators.
  { name: "RSI", kind: "call", signature: "RSI(period)", description: "Wilder Relative Strength Index over `period` bars. Range [0, 100]. Standard period 14.", context: "entry" },
  { name: "RSI", kind: "ident", description: "RSI with default period 14, evaluated at the entry bar.", context: "entry" },
  { name: "ROC", kind: "call", signature: "ROC(period)", description: "Rate of Change as a percentage: 100 * (close - close[period bars ago]) / close[period bars ago].", context: "entry" },
  { name: "MOM", kind: "call", signature: "MOM(period)", description: "Raw momentum — close[i] − close[i − period]. Direction matches price; magnitude is in raw points.", context: "entry" },
  { name: "CCI", kind: "call", signature: "CCI(period)", description: "Commodity Channel Index over `period` bars. Standard period 20. Range typically ±100; values beyond ±100 signal extended moves.", context: "entry" },
  { name: "WilliamsR", kind: "call", signature: "WilliamsR(period)", description: "Williams %R — −100 * (HHV − close) / (HHV − LLV) over `period` bars. Range [−100, 0].", context: "entry" },
  { name: "TRIX", kind: "call", signature: "TRIX(period)", description: "1-bar percent ROC of the triple-EMA-smoothed log close. Signed momentum oscillator filtered through three EMAs.", context: "entry" },
  { name: "MFI", kind: "call", signature: "MFI(period)", description: "Money Flow Index — RSI applied to typical-price × volume, signed by direction of TP. Range [0, 100]. Standard period 14.", context: "entry" },

  // MACD family — split into separate single-scalar functions.
  { name: "MACD_line", kind: "call", signature: "MACD_line(fast, slow)", description: "MACD line: EMA(fast) − EMA(slow). Standard (12, 26).", context: "entry" },
  { name: "MACD_signal", kind: "call", signature: "MACD_signal(fast, slow, signal=9)", description: "EMA of the MACD line over `signal` bars. signal defaults to 9 if omitted.", context: "entry" },
  { name: "MACD_hist", kind: "call", signature: "MACD_hist(fast, slow, signal=9)", description: "MACD histogram — line minus signal. signal defaults to 9 if omitted.", context: "entry" },

  // Bollinger Bands — split per-band.
  { name: "BB_mid", kind: "call", signature: "BB_mid(period)", description: "Bollinger middle band — SMA(close, period). Standard period 20.", context: "entry" },
  { name: "BB_upper", kind: "call", signature: "BB_upper(period, mult=2)", description: "Bollinger upper band: mid + mult * popStdev(close, period). mult defaults to 2 if omitted.", context: "entry" },
  { name: "BB_lower", kind: "call", signature: "BB_lower(period, mult=2)", description: "Bollinger lower band: mid − mult * popStdev(close, period). mult defaults to 2 if omitted.", context: "entry" },
  { name: "BB_width", kind: "call", signature: "BB_width(period, mult=2)", description: "Bollinger bandwidth — (upper − lower) / mid. Useful as a volatility-regime gauge (low = squeeze).", context: "entry" },
  { name: "BB_percent", kind: "call", signature: "BB_percent(period, mult=2)", description: "Bollinger %B — (close − lower) / (upper − lower). 0 = at lower band, 1 = at upper, > 1 = above, < 0 = below.", context: "entry" },

  // Stochastic.
  { name: "Stoch_K", kind: "call", signature: "Stoch_K(period)", description: "Fast Stochastic %K — 100 * (close − LLV) / (HHV − LLV) over `period` bars. Range [0, 100]. Standard period 14.", context: "entry" },
  { name: "Stoch_D", kind: "call", signature: "Stoch_D(period, smoothK=3, smoothD=3)", description: "Slow Stochastic %D — SMA(SMA(K, smoothK), smoothD). Defaults: smoothK=3, smoothD=3.", context: "entry" },

  // Donchian channels.
  { name: "Donchian_upper", kind: "call", signature: "Donchian_upper(period)", description: "Highest high over the last `period` bars. Same math as HHV — alias for the Donchian-channel name.", context: "entry" },
  { name: "Donchian_lower", kind: "call", signature: "Donchian_lower(period)", description: "Lowest low over the last `period` bars. Same math as LLV — alias for the Donchian-channel name.", context: "entry" },
  { name: "Donchian_mid", kind: "call", signature: "Donchian_mid(period)", description: "Donchian midline — (upper + lower) / 2 over `period` bars.", context: "entry" },

  // Volatility.
  { name: "TR", kind: "ident", description: "True Range of the current bar — max(h−l, |h−prevClose|, |l−prevClose|). NaN at the first bar (no prev close).", context: "entry" },
  { name: "TR", kind: "call", signature: "TR()", description: "Function form of TR — same as the bare ident.", context: "entry" },
  { name: "NATR", kind: "call", signature: "NATR(period)", description: "Normalized ATR — 100 * ATR / close. Volatility expressed as a percent of price; comparable across instruments.", context: "entry" },
  { name: "HV", kind: "call", signature: "HV(period)", description: "Historical volatility — un-annualized sample stdev of log returns over `period` bars (matches stdev). Multiply by sqrt(252) etc. to annualize.", context: "entry" },

  // Volume / cumulative.
  { name: "OBV", kind: "ident", description: "On-Balance Volume — running cumulative volume signed by close-vs-prev-close. Index 0 seeds at 0.", context: "entry" },
  { name: "OBV", kind: "call", signature: "OBV()", description: "Function form of OBV — same as the bare ident.", context: "entry" },
  { name: "AD", kind: "ident", description: "Accumulation/Distribution line — running cumulative of money-flow-multiplier × volume.", context: "entry" },
  { name: "AD", kind: "call", signature: "AD()", description: "Function form of AD — same as the bare ident.", context: "entry" },
  { name: "CMF", kind: "call", signature: "CMF(period)", description: "Chaikin Money Flow — sum(MFM*vol)/sum(vol) over `period` bars. Range [−1, 1]; positive = buying pressure. Standard period 20.", context: "entry" },

  // Bar-shape scalars (current-bar derivatives).
  { name: "range", kind: "ident", description: "Current bar's high − low.", context: "entry" },
  { name: "body", kind: "ident", description: "Current bar's close − open. Sign indicates direction.", context: "entry" },
  { name: "upper_wick", kind: "ident", description: "Current bar's upper wick — high − max(open, close).", context: "entry" },
  { name: "lower_wick", kind: "ident", description: "Current bar's lower wick — min(open, close) − low.", context: "entry" },
  { name: "typical", kind: "ident", description: "Typical price of the current bar — (high + low + close) / 3.", context: "entry" },
  { name: "median_price", kind: "ident", description: "Median price of the current bar — (high + low) / 2.", context: "entry" },
  { name: "weighted_close", kind: "ident", description: "Weighted close of the current bar — (high + low + 2*close) / 4.", context: "entry" },

  // Lookback scalars.
  { name: "HHV", kind: "call", signature: "HHV(period)", description: "Highest high over the last `period` bars (current bar inclusive).", context: "entry" },
  { name: "LLV", kind: "call", signature: "LLV(period)", description: "Lowest low over the last `period` bars (current bar inclusive).", context: "entry" },
  { name: "close_n", kind: "call", signature: "close_n(n)", description: "Close price `n` bars before the current bar. close_n(1) is the previous bar's close.", context: "entry" },
  { name: "high_n", kind: "call", signature: "high_n(n)", description: "High price `n` bars before the current bar.", context: "entry" },
  { name: "low_n", kind: "call", signature: "low_n(n)", description: "Low price `n` bars before the current bar.", context: "entry" },
  { name: "open_n", kind: "call", signature: "open_n(n)", description: "Open price `n` bars before the current bar.", context: "entry" },
  { name: "volume_n", kind: "call", signature: "volume_n(n)", description: "Volume `n` bars before the current bar.", context: "entry" },
];

/** Identifiers available in summary (`print = ...`) context. */
export const SUMMARY_SYMBOLS: ExprSymbol[] = [
  { name: "winRate", kind: "ident", description: "Fraction of trades that were winners (0..1).", context: "summary" },
  { name: "profitFactor", kind: "ident", description: "Gross winning points / gross losing points.", context: "summary" },
  { name: "avgRR", kind: "ident", description: "Average realized risk-to-reward ratio across trades.", context: "summary" },
  { name: "totalPnl", kind: "ident", description: "Sum of P&L across all closed trades (points).", context: "summary" },
  { name: "totalPoints", kind: "ident", description: "Total points captured across all trades.", context: "summary" },
  { name: "expectancy", kind: "ident", description: "(winRate * avgWin) - (lossRate * avgLoss), size-scaled.", context: "summary" },
  { name: "expectancyPerSize", kind: "ident", description: "Expectancy on per-contract raw points (independent of scaling).", context: "summary" },
  { name: "avgPoints", kind: "ident", description: "Average points per trade (size-scaled).", context: "summary" },
  { name: "avgWinPoints", kind: "ident", description: "Average points on winning trades.", context: "summary" },
  { name: "avgLossPoints", kind: "ident", description: "Average points on losing trades (negative).", context: "summary" },
  { name: "avgBarsHeld", kind: "ident", description: "Average bars held per trade.", context: "summary" },
  { name: "avgtradetime", kind: "ident", description: "Alias for avgBarsHeld — average bars held per trade.", context: "summary" },
  { name: "dailyEv", kind: "ident", description: "Total points / number of unique trading days.", context: "summary" },
  { name: "tradingDays", kind: "ident", description: "Number of unique calendar days that produced at least one trade.", context: "summary" },
  { name: "avgTradesPerHour", kind: "ident", description: "Trades per hour during active sessions.", context: "summary" },
  { name: "sharpeOriginal", kind: "ident", description: "Per-trade Sharpe on the unmodified zone outcomes.", context: "summary" },
  { name: "sharpeSimulated", kind: "ident", description: "Per-trade Sharpe on the simulated (rule-applied) outcomes.", context: "summary" },
  { name: "totalTrades", kind: "ident", description: "Total number of trades produced by the run.", context: "summary" },
  { name: "winners", kind: "ident", description: "Number of winning trades.", context: "summary" },
  { name: "losers", kind: "ident", description: "Number of losing trades.", context: "summary" },
];

// ─── NumericValue tagged union ──────────────────────────────────────────────
//
// Numeric fields in the partial config shape now hold either a literal
// (back-compat fast path) or a compiled expression. The simulator
// resolves these per trade — see `resolveRulesForTrade` in the simulator
// integration.

export type NumericValue =
  | { kind: "literal"; value: number }
  | { kind: "expr"; source: string; expr: Expr }
  | { kind: "optimize"; source: string; spec: OptimizeSpec };

/** Enum-typed RHS value (for fields like `filters.trend.ema20` whose
 *  schema declares `options: ["any", "with", "against"]`). Either a
 *  literal string or an Optimize directive that returns a string from a
 *  finite option list. */
export type EnumValue =
  | { kind: "literal"; value: string }
  | { kind: "optimize"; source: string; spec: OptimizeSpec };

// ─── Optimize directive ─────────────────────────────────────────────────────
//
// The `Optimize.<Objective>.<LookbackUnit>(<lookback>, <min>, <max>[, <step>])`
// form is recognized at parse time and lowered to an OptimizeSpec. The
// online optimizer (in zone-simulator + a worker) drives a TPE search at
// each new signal/bar and resolves the spec to a concrete value for the
// trade about to fire. The script DSL never executes the spec itself —
// it's a declarative search description.

/** Objectives the optimizer can maximize. `MinDrawdown` is internally
 *  maximized as `-maxDrawdown` so larger drawdowns score worse. */
export type OptimizeObjective =
  | "DailyEV"
  | "EV"
  | "Sharpe"
  | "MinDrawdown"
  | "WinRate"
  | "ProfitFactor";

/** Lookback unit. `trades` is count-based (slice last N completed
 *  trades); the others are time-based (slice trades whose entry_time
 *  falls within the last N units). */
export type OptimizeLookbackUnit = "trades" | "bars" | "minutes" | "seconds" | "hours";

/** A bound expression — stored as both source text (for round-tripping
 *  and the Output panel) and a compiled Expr (for runtime evaluation
 *  against the entry-bar EvalCtx). Plain numeric bounds also flow
 *  through this shape — they compile to a `{ kind: "num" }` Expr. */
export interface OptimizeBoundExpr {
  source: string;
  expr: Expr;
}

export type OptimizeSpec =
  | {
      kind: "optimize-numeric";
      objective: OptimizeObjective;
      lookbackUnit: OptimizeLookbackUnit;
      /** Lookback is constant-folded at parse time. Bar/indicator
       *  refs in lookback are rejected — varying the rolling window
       *  per-signal would break the "last N trades" concept. */
      lookback: number;
      min: OptimizeBoundExpr;
      max: OptimizeBoundExpr;
      step?: OptimizeBoundExpr;
      /** Optional pre-warmup default value, written as
       *  `Optimize.X.Y(...) default <num>`. Pre-warmup, var/rule lookups
       *  resolve to this literal so filter.if conditions and rules.* RHS
       *  expressions referencing the directive can still produce useful
       *  values before the optimizer fills its lookback window. Numeric
       *  literal only (no expressions) so the value is unambiguous and
       *  doesn't need an entry-context to evaluate. Omitted →
       *  pre-warmup behavior is unchanged: NaN propagates and the
       *  caller falls back to its baseline. */
      defaultValue?: number;
      /** Optional smoothing window for the optimizer's per-signal pick.
       *  Written as a trailing `smooth <N>` clause on the directive
       *  (e.g. `Optimize.Sharpe.Trades(30, 5, 50) smooth 8`). The
       *  optimizer applies an SMA of width N to the time series of
       *  raw best-trial values across signals — so the value the live
       *  trade ACTUALLY uses is the average of the last N raw picks,
       *  damping noise from small-lookback objective variance. Omitted
       *  ⇒ the optimizer uses its default window (5). `0` or `1`
       *  disables smoothing for this directive (raw value passes
       *  through unchanged). */
      smoothWindow?: number;
    }
  | {
      kind: "optimize-categorical";
      objective: OptimizeObjective;
      lookbackUnit: OptimizeLookbackUnit;
      lookback: number;
      options: Array<string | number>;
    };

const OBJECTIVES: ReadonlySet<OptimizeObjective> = new Set([
  "DailyEV",
  "EV",
  "Sharpe",
  "MinDrawdown",
  "WinRate",
  "ProfitFactor",
]);
const LOOKBACK_UNITS: ReadonlySet<OptimizeLookbackUnit> = new Set([
  "trades",
  "bars",
  "minutes",
  "seconds",
  "hours",
]);

/** Parse an `Optimize.X.Y(args)` invocation. Case-insensitive on the
 *  keyword AND the objective + lookback-unit segments so users can write
 *  `optimize.ev.trades(...)`, `Optimize.DailyEV.trades(...)`, or even
 *  `OPTIMIZE.SHARPE.BARS(...)`. Returns the canonicalized OptimizeSpec
 *  or a specific error tied to the malformed shape. */
export function parseOptimizeSpec(
  text: string
): { ok: true; spec: OptimizeSpec; source: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  // Strip optional trailing `default <num>` and `smooth <N>` clauses
  // BEFORE matching the main Optimize.X.Y(...) shape. Both keywords are
  // reserved at this trailing position. Either order is accepted
  // (`...) default 10 smooth 5` or `...) smooth 5 default 10`) — we
  // peel one clause per pass and re-match, stopping when neither
  // pattern hits. Numeric literals only (no expressions) so the
  // values are portable and don't need an entry-context to evaluate.
  // Negative defaults are accepted (signed momentum thresholds);
  // smooth is required to be a non-negative integer (window size).
  let defaultValue: number | undefined;
  let smoothWindow: number | undefined;
  let workingText = trimmed;
  for (let pass = 0; pass < 2; pass++) {
    // Accept both `smooth 20` and `smooth(20)` forms — the bare-word
    // form mirrors `default <num>`, the call form is what users tend
    // to type when the rest of the script DSL is function-call shaped.
    // The greedy `[\s\S]*\)` capture relies on regex backtracking to
    // resolve which closing paren belongs to which level: with input
    // `Optimize.X.Y(...) smooth(20)`, the engine first grabs through
    // the smooth(20) `)`, fails to match the trailing `smooth\s*\(`,
    // backtracks to grab through the Optimize.X.Y(...) `)`, then
    // matches `smooth(20)` cleanly.
    const smoothMatch =
      workingText.match(/^([\s\S]*\))\s*smooth\s*\(\s*(\d+)\s*\)\s*$/i) ||
      workingText.match(/^([\s\S]*\))\s*smooth\s+(\d+)\s*$/i);
    if (smoothMatch && smoothWindow === undefined) {
      const parsed = Number(smoothMatch[2]);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return {
          ok: false,
          error: `Optimize: smooth must be a non-negative integer — got "${smoothMatch[2]}"`,
        };
      }
      workingText = smoothMatch[1].trim();
      smoothWindow = parsed;
      continue;
    }
    // `default <num>` and `default(<num>)` — same accept-both pattern
    // as smooth so users get a consistent feel across the trailing
    // clauses. Negative defaults remain accepted (signed momentum
    // thresholds), and exponential notation still works in either form.
    const defaultMatch =
      workingText.match(/^([\s\S]*\))\s*default\s*\(\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*\)\s*$/i) ||
      workingText.match(/^([\s\S]*\))\s*default\s+(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*$/i);
    if (defaultMatch && defaultValue === undefined) {
      const parsed = Number(defaultMatch[2]);
      if (!Number.isFinite(parsed)) {
        return {
          ok: false,
          error: `Optimize: malformed default value "${defaultMatch[2]}" — must be a finite numeric literal`,
        };
      }
      workingText = defaultMatch[1].trim();
      defaultValue = parsed;
      continue;
    }
    break;
  }
  // Path prefix: `Optimize.<Objective>.<LookbackUnit>` followed by `(`.
  // `i` flag makes the keyword + segments case-insensitive; the inner
  // canonicalize() pass below normalizes them to the canonical casing.
  const m = workingText.match(/^Optimize\.([A-Za-z]+)\.([A-Za-z]+)\s*\(([\s\S]*)\)\s*$/i);
  if (!m) {
    // Diagnose the most common malformed shapes so the user gets a
    // pointed message instead of generic "expected X". Each branch
    // echoes the input so they can spot the issue at a glance.
    if (!/^Optimize\./i.test(trimmed)) {
      return {
        ok: false,
        error: `expected the line to start with "Optimize." — got "${trimmed}"`,
      };
    }
    if (!/\(/.test(trimmed)) {
      return {
        ok: false,
        error: `Optimize is a function call — wrap args in parens, e.g. "Optimize.DailyEV.trades(30, 10, 40)". Got "${trimmed}"`,
      };
    }
    if (!/\)\s*$/.test(trimmed)) {
      return {
        ok: false,
        error: `Optimize: missing closing ")" — got "${trimmed}"`,
      };
    }
    if (!/^Optimize\.[A-Za-z]+\.[A-Za-z]+/i.test(trimmed)) {
      return {
        ok: false,
        error: `Optimize: expected exactly two segments after the keyword — Optimize.<Objective>.<LookbackUnit>(...) — got "${trimmed}"`,
      };
    }
    // Stale-syntax check: `Optimize.X.Y = (args)` is the form we
    // discussed during planning but discarded in favor of the cleaner
    // function-call shape. Detect the leftover `=` so users porting
    // an older script see exactly what to delete.
    if (/^Optimize\.[A-Za-z]+\.[A-Za-z]+\s*=/i.test(trimmed)) {
      return {
        ok: false,
        error: `Optimize uses function-call form — drop the "=" between the path and the args. Try \`${trimmed.replace(/\s*=\s*/, "")}\` instead.`,
      };
    }
    return {
      ok: false,
      error: `expected \`Optimize.<Objective>.<LookbackUnit>(args)\` — e.g. \`Optimize.DailyEV.trades(30, 10, 40)\`. Got "${trimmed}"`,
    };
  }
  const [, objRaw, unitRaw, argsRaw] = m;
  // Canonicalize objective with case-insensitive match against the
  // allowed set. This lets the user type `optimize.ev` or `OPTIMIZE.EV`
  // and still get the canonical "EV" stored on the spec.
  const objective = canonicalize(objRaw, OBJECTIVES);
  if (!objective) {
    return {
      ok: false,
      error: `unknown objective "${objRaw}" — must be one of ${[...OBJECTIVES].join(", ")}`,
    };
  }
  const lookbackUnit = canonicalize(unitRaw, LOOKBACK_UNITS);
  if (!lookbackUnit) {
    return {
      ok: false,
      error: `unknown lookback unit "${unitRaw}" — must be one of ${[...LOOKBACK_UNITS].join(", ")}`,
    };
  }
  // Argument list: comma-separated, but commas inside parens (the
  // categorical option list) don't split. We do a single-level paren-
  // aware split — sufficient since options can't contain nested parens.
  const args = splitArgs(argsRaw);
  if (args.length < 2) {
    return {
      ok: false,
      error: "Optimize requires at least 2 args: lookback, then either (min, max[, step]) or (option, option, …)",
    };
  }
  // Lookback — compile then constant-fold. Bar/indicator references
  // are rejected because varying the rolling window per-signal breaks
  // the "last N trades" concept. Plain numeric literals (the common
  // case) parse + fold in microseconds.
  const lookbackArg = args[0].trim();
  const lookbackComp = compile(lookbackArg);
  if (!lookbackComp.ok) {
    return { ok: false, error: `lookback: ${lookbackComp.error}` };
  }
  const folded = evaluate(lookbackComp.expr, { kind: "summary", symbols: {} });
  if (!Number.isFinite(folded) || folded <= 0) {
    return {
      ok: false,
      error: `lookback must be a constant positive number — bar/indicator references not allowed in lookback. Got "${lookbackArg}".`,
    };
  }
  const lookback = folded;
  // If args[1] starts with "(" it's a categorical option list. Otherwise
  // it's the start of (min, max[, step]).
  const second = args[1].trim();
  if (second.startsWith("(") && second.endsWith(")")) {
    if (defaultValue !== undefined) {
      return {
        ok: false,
        error: `Optimize: \`default <num>\` is only meaningful for numeric Optimize directives — categorical option lists already enumerate every possible value.`,
      };
    }
    if (smoothWindow !== undefined) {
      return {
        ok: false,
        error: `Optimize: \`smooth <N>\` only applies to numeric Optimize directives — averaging categorical picks doesn't make sense.`,
      };
    }
    const inner = second.slice(1, -1);
    const optionTokens = splitArgs(inner).map((s) => s.trim()).filter((s) => s.length > 0);
    if (optionTokens.length < 2) {
      return { ok: false, error: "categorical Optimize needs at least 2 options" };
    }
    // Each option token is either a numeric literal or a bare-word
    // identifier. Quoted strings are allowed but the user's example
    // shows bare words ("with", "against") so we accept either.
    const options: Array<string | number> = [];
    for (const tok of optionTokens) {
      const n = Number(tok);
      if (Number.isFinite(n) && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(tok)) {
        options.push(n);
      } else if (tok.startsWith('"') && tok.endsWith('"')) {
        options.push(tok.slice(1, -1));
      } else {
        // Bare identifier — store verbatim so the caller can match it
        // against the schema's `options` list.
        options.push(tok);
      }
    }
    return {
      ok: true,
      source: trimmed,
      spec: {
        kind: "optimize-categorical",
        objective,
        lookbackUnit,
        lookback,
        options,
      },
    };
  }
  // Numeric branch: args[1]=min, args[2]=max, args[3]=step (optional).
  // Each is compiled as a full expression (not just Number()), so users
  // can write `Optimize.X.Y(30, ticks(4), max(ATR * 0.5, 5))` — the
  // bound is evaluated at each entry bar before TPE builds its space.
  // Plain literals compile to a `{kind:"num"}` Expr with no overhead.
  // We do NOT validate min < max at parse time because both can be
  // runtime expressions; the optimizer rejects + warns at evaluation.
  if (args.length < 3) {
    return { ok: false, error: "numeric Optimize requires (lookback, min, max[, step])" };
  }
  const minArg = args[1].trim();
  const maxArg = args[2].trim();
  const minComp = compile(minArg);
  if (!minComp.ok) return { ok: false, error: `min: ${minComp.error}` };
  const maxComp = compile(maxArg);
  if (!maxComp.ok) return { ok: false, error: `max: ${maxComp.error}` };
  let step: OptimizeBoundExpr | undefined;
  if (args.length >= 4) {
    const stepArg = args[3].trim();
    const stepComp = compile(stepArg);
    if (!stepComp.ok) return { ok: false, error: `step: ${stepComp.error}` };
    step = { source: stepArg, expr: stepComp.expr };
  }
  return {
    ok: true,
    source: trimmed,
    spec: {
      kind: "optimize-numeric",
      objective,
      lookbackUnit,
      lookback,
      min: { source: minArg, expr: minComp.expr },
      max: { source: maxArg, expr: maxComp.expr },
      step,
      defaultValue,
      smoothWindow,
    },
  };
}

function canonicalize<T extends string>(raw: string, set: ReadonlySet<T>): T | null {
  const lower = raw.toLowerCase();
  for (const v of set) {
    if (v.toLowerCase() === lower) return v;
  }
  return null;
}

/** One-level paren-aware comma split. Doesn't handle escaped commas or
 *  quoted commas — the Optimize syntax doesn't need either. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") {
      depth++;
      buf += c;
    } else if (c === ")") {
      depth--;
      buf += c;
    } else if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

/** Parse a NumericValue from RHS text — literal-first, then Optimize,
 *  then expression. Public so the script parser can call it. */
export function parseNumericValue(text: string): { ok: true; value: NumericValue } | { ok: false; error: string } {
  const t = text.trim();
  // Literal fast path — must match exactly the regex used by
  // parseValueLiteral so existing scripts tokenize byte-identically.
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return { ok: true, value: { kind: "literal", value: n } };
  }
  // Optimize directive — recognize the prefix without compiling, so an
  // Optimize on a numeric field is captured even if it has weird inner
  // syntax that the expression engine would otherwise reject.
  if (/^Optimize\./i.test(t)) {
    const r = parseOptimizeSpec(t);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.spec.kind !== "optimize-numeric") {
      return {
        ok: false,
        error: "this field expects a numeric Optimize, got categorical (use parentheses around (min, max))",
      };
    }
    return { ok: true, value: { kind: "optimize", source: r.source, spec: r.spec } };
  }
  // Expression fallback.
  const c = compile(t);
  if (!c.ok) return { ok: false, error: c.error };
  return { ok: true, value: { kind: "expr", source: c.source, expr: c.expr } };
}

/** Parse an EnumValue from RHS text. Caller passes the schema's allowed
 *  options so categorical Optimize args can be validated against them.
 *  Quoted strings ("with") and bare identifiers (with) both parse. */
export function parseEnumValue(
  text: string,
  allowedOptions: string[]
): { ok: true; value: EnumValue } | { ok: false; error: string } {
  const t = text.trim();
  // Literal: quoted string.
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    const body = t.slice(1, -1).replace(/\\(["\\])/g, "$1");
    if (!allowedOptions.includes(body)) {
      return { ok: false, error: `"${body}" not in {${allowedOptions.join("|")}}` };
    }
    return { ok: true, value: { kind: "literal", value: body } };
  }
  // Optimize directive.
  if (/^Optimize\./i.test(t)) {
    const r = parseOptimizeSpec(t);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.spec.kind !== "optimize-categorical") {
      return {
        ok: false,
        error: "enum field expects a categorical Optimize — use (option1, option2, …)",
      };
    }
    // Validate every option against the schema's allowed list. Unknown
    // options here mean a typo — fail at parse time so the user doesn't
    // wait for a silent runtime mismatch.
    for (const opt of r.spec.options) {
      if (typeof opt !== "string") {
        return { ok: false, error: `enum field accepts string options only; got numeric option ${opt}` };
      }
      if (!allowedOptions.includes(opt)) {
        return {
          ok: false,
          error: `option "${opt}" not in {${allowedOptions.join("|")}}`,
        };
      }
    }
    return { ok: true, value: { kind: "optimize", source: r.source, spec: r.spec } };
  }
  // Bare identifier as a literal — matches the user's writing style of
  // `with` instead of `"with"`. Same options-list check.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    if (!allowedOptions.includes(t)) {
      return { ok: false, error: `"${t}" not in {${allowedOptions.join("|")}}` };
    }
    return { ok: true, value: { kind: "literal", value: t } };
  }
  return {
    ok: false,
    error: `expected one of {${allowedOptions.join("|")}}, a "quoted" form, or Optimize.X.Y(...)`,
  };
}

/** Resolve a NumericValue against an entry context — returns NaN if the
 *  expression evaluates to non-finite, leaving fallback to the caller.
 *  When the value is an Optimize directive, the resolver delegates to
 *  the caller's resolver map (the online optimizer hands resolved
 *  values per-trade, not via this function). */
export function resolveNumericValue(nv: NumericValue, ctx: EntryEvalCtx): number {
  if (nv.kind === "literal") return nv.value;
  if (nv.kind === "expr") {
    const v = evaluate(nv.expr, { kind: "entry", ...ctx });
    return Number.isFinite(v) ? v : NaN;
  }
  // For "optimize" — the simulator's online optimizer is responsible
  // for resolving these to concrete numbers BEFORE calling
  // resolveRulesForTrade. If we land here, the caller forgot to apply
  // an optimizer overlay; return NaN so the standard fallback kicks in.
  return NaN;
}

// ─── Indicator precompute ───────────────────────────────────────────────────

// Reverse-map from the prefix used in the bare-indicator key back to the
// function name `computeIndicatorSeries` dispatches on. Centralized so the
// reverse lookup stays in sync with `bareIndicatorKey`'s regex prefixes.
const BARE_PREFIX_TO_CALL: Record<string, string> = {
  ATR: "ATR",
  EMA: "EMA",
  SMA: "SMA",
  ADX: "ADX",
  VOL: "volume",
  RSI: "RSI",
  WMA: "WMA",
  HMA: "HMA",
  DEMA: "DEMA",
  TEMA: "TEMA",
  VWMA: "VWMA",
  ROC: "ROC",
  MOM: "MOM",
  CCI: "CCI",
  TRIX: "TRIX",
  MFI: "MFI",
  NATR: "NATR",
  HV: "HV",
  CMF: "CMF",
  HHV: "HHV",
  LLV: "LLV",
};

/** Walk every expression in the overlay and return a deduplicated list of
 *  (indicator-name, args, key) tuples that need to be precomputed per
 *  zone. Bare-name idents like ATR, EMA20, ADX14, OBV are expanded to
 *  their canonical (call-form) representation so the precompute covers
 *  them too. */
export function gatherRequiredSeries(
  exprs: Iterable<Expr>
): Array<{ name: string; args: number[]; key: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; args: number[]; key: string }> = [];

  function add(name: string, args: number[]): void {
    const withDefaults = applyArgDefaults(name, args);
    const key = indicatorKeyForCall(name, withDefaults);
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, args: withDefaults, key });
  }

  for (const expr of exprs) {
    const refs = referencedSymbols(expr);
    // Function calls — args[] is on the call directly. Skip calls with
    // dynamic args (any non-literal arg → c.args undefined).
    for (const c of refs.calls) {
      if (ZERO_ARG_INDICATORS.has(c.name)) {
        // Zero-arg indicators always get precomputed regardless of how
        // they were invoked (`OBV`, `OBV()`).
        add(c.name, []);
        continue;
      }
      if (!c.args) continue; // dynamic args — skip precompute
      add(c.name, c.args);
    }
    // Bare-name idents that resolve to indicator series.
    for (const id of refs.idents) {
      // Zero-arg cumulative indicators — no period; key matches name.
      if (ZERO_ARG_INDICATORS.has(id)) {
        add(id, []);
        continue;
      }
      const k = bareIndicatorKey(id);
      if (!k) continue;
      // Period-suffixed forms (RSI14, EMA20, ATR14, etc.) → ${prefix}:${period}.
      if (!k.includes(":")) continue; // already-handled zero-arg case above
      const [n, pStr] = k.split(":");
      const p = Number(pStr);
      if (!Number.isFinite(p) || p <= 0) continue;
      const callName = BARE_PREFIX_TO_CALL[n];
      if (!callName) continue;
      add(callName, [p]);
    }
  }
  return out;
}

/** Indicators whose Wilder smoothing requires `2*period + 1` bars to
 *  produce a non-NaN value at the entry bar. ADX is the canonical case
 *  (`adxSeries` rejects when `bars.length < 2 * period + 1` —
 *  calculations.ts:900). ATR and the RSI-family use a single Wilder
 *  pass (`period + 1` bars), which `period * 2` already covers. Listed
 *  explicitly so a caller sizing the warmup window doesn't have to
 *  guess per-indicator. */
const WILDER_FAMILY = new Set<string>([
  "ATR",
  "ADX",
  "RSI",
  "MFI",
  "WilliamsR",
  "TRIX",
  "NATR",
  "CMF",
]);

/** Walk every expression and return the largest pre-entry bar window
 *  any indicator call needs to warm up by `bar_index 0`. Reuses
 *  `gatherRequiredSeries` so the same dedup + bare-ident expansion
 *  logic that drives `precomputeIndicators` drives the sizing here.
 *  Wilder-family indicators get `2 * period` (covers ADX's `2*p+1`
 *  worst case); others get `period`. Returns 0 when no indicator calls
 *  are referenced — caller can keep its existing default window. */
export function maxIndicatorPeriod(exprs: Iterable<Expr>): number {
  let max = 0;
  for (const r of gatherRequiredSeries(exprs)) {
    const period = r.args[0];
    if (!Number.isFinite(period) || period <= 0) continue;
    const needed = WILDER_FAMILY.has(r.name) ? period * 2 : period;
    if (needed > max) max = needed;
  }
  return max;
}

/** Compute a single indicator series by name. Centralized so the
 *  simulator and any future caller share the same dispatch. Returns
 *  null for unrecognized names (indicator key not in the catalog). */
export function computeIndicatorSeries(
  name: string,
  args: number[],
  bars: IndicatorBar[]
): number[] | null {
  switch (name) {
    // Existing (single-period).
    case "ATR":
      return atrSeries(bars, args[0]);
    case "EMA":
      return emaSeries(bars, args[0]);
    case "SMA":
      return smaSeries(bars, args[0]);
    case "ADX":
      return adxSeries(bars, args[0]);
    case "volume":
    case "trailVol":
      return volumeMaSeries(bars, args[0]);
    case "stdev":
      return stdevReturnsSeries(bars, args[0]);
    // Moving averages.
    case "WMA":
      return wmaSeries(bars, args[0]);
    case "HMA":
      return hmaSeries(bars, args[0]);
    case "DEMA":
      return demaSeries(bars, args[0]);
    case "TEMA":
      return temaSeries(bars, args[0]);
    case "VWMA":
      return vwmaSeries(bars, args[0]);
    // Momentum / oscillators.
    case "RSI":
      return rsiSeries(bars, args[0]);
    case "ROC":
      return rocSeries(bars, args[0]);
    case "MOM":
      return momSeries(bars, args[0]);
    case "CCI":
      return cciSeries(bars, args[0]);
    case "WilliamsR":
      return williamsRSeries(bars, args[0]);
    case "TRIX":
      return trixSeries(bars, args[0]);
    case "MFI":
      return mfiSeries(bars, args[0]);
    // MACD family.
    case "MACD_line":
      return macdLineSeries(bars, args[0], args[1]);
    case "MACD_signal":
      return macdSignalSeries(bars, args[0], args[1], args[2]);
    case "MACD_hist":
      return macdHistSeries(bars, args[0], args[1], args[2]);
    // Bollinger Bands.
    case "BB_mid":
      return bbMidSeries(bars, args[0]);
    case "BB_upper":
      return bbUpperSeries(bars, args[0], args[1]);
    case "BB_lower":
      return bbLowerSeries(bars, args[0], args[1]);
    case "BB_width":
      return bbWidthSeries(bars, args[0], args[1]);
    case "BB_percent":
      return bbPercentSeries(bars, args[0], args[1]);
    // Stochastic.
    case "Stoch_K":
      return stochKSeries(bars, args[0]);
    case "Stoch_D":
      return stochDSeries(bars, args[0], args[1], args[2]);
    // Donchian.
    case "Donchian_upper":
      return donchianUpperSeries(bars, args[0]);
    case "Donchian_lower":
      return donchianLowerSeries(bars, args[0]);
    case "Donchian_mid":
      return donchianMidSeries(bars, args[0]);
    // Volatility.
    case "TR":
      return trSeries(bars);
    case "NATR":
      return natrSeries(bars, args[0]);
    case "HV":
      return hvSeries(bars, args[0]);
    // Volume / cumulative.
    case "OBV":
      return obvSeries(bars);
    case "AD":
      return adSeries(bars);
    case "CMF":
      return cmfSeries(bars, args[0]);
    // Lookback scalars.
    case "HHV":
      return hhvSeries(bars, args[0]);
    case "LLV":
      return llvSeries(bars, args[0]);
    case "close_n":
      return closeNSeries(bars, args[0]);
    case "high_n":
      return highNSeries(bars, args[0]);
    case "low_n":
      return lowNSeries(bars, args[0]);
    case "open_n":
      return openNSeries(bars, args[0]);
    case "volume_n":
      return volumeNSeries(bars, args[0]);
    default:
      return null;
  }
}

/** Build a per-zone indicator cache covering every series referenced by
 *  the overlay's expressions. Runs each series helper exactly once per
 *  (zone, indicator-key) pair — O(zones × indicators × bars), but each
 *  series is itself O(bars), so total work scales linearly with the
 *  total bar count summed over all zones, multiplied by the small set of
 *  unique indicators in use.
 *
 *  When `preEntryBarsByZoneId` is provided, the pre-entry bars are
 *  prepended before computing each series, then the leading `preBars`
 *  values are sliced off so the returned series stays 1-to-1 with the
 *  post-entry bars (index 0 = entry bar). This is what gives ATR(14),
 *  EMA(20), ADX(14), etc. enough history to actually warm up at entry —
 *  without it, looking up an indicator at bar_index 0 always lands inside
 *  the warmup window and returns NaN (which the per-trade prints table
 *  renders as "–"). */
export function precomputeIndicators(
  zones: TradeZone[],
  barsByZoneId: Map<number, TradeZoneBar[]>,
  exprs: Iterable<Expr>,
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]>
): Map<number, Map<string, number[]>> {
  const required = gatherRequiredSeries(exprs);
  const out = new Map<number, Map<string, number[]>>();
  for (const zone of zones) {
    const bars = barsByZoneId.get(zone.id);
    if (!bars || bars.length === 0) continue;
    const sortedPost = [...bars].sort((a, b) => a.bar_index - b.bar_index);
    const preBars = preEntryBarsByZoneId?.get(zone.id);
    const sortedPre = preBars
      ? [...preBars].sort((a, b) => a.bar_index - b.bar_index)
      : [];
    const combined = sortedPre.length > 0 ? [...sortedPre, ...sortedPost] : sortedPost;
    const offset = sortedPre.length;
    const perZone = new Map<string, number[]>();
    for (const r of required) {
      const series = computeIndicatorSeries(r.name, r.args, combined);
      if (series) perZone.set(r.key, offset > 0 ? series.slice(offset) : series);
    }
    out.set(zone.id, perZone);
  }
  return out;
}

// ─── Per-trade rule resolution ──────────────────────────────────────────────

/** Numeric keys on SimRules — the only fields whose values can be
 *  expressions. Booleans / enums / strings remain literal. The list is
 *  stable; if a new numeric field is added to SimRules and the user
 *  should be able to drive it from the script, add the path here.
 *  Off-list paths fall back to the rules object's literal value
 *  unconditionally — same behavior as before script v2. */
export const NUMERIC_RULE_KEYS = new Set<keyof import("./zone-simulator").SimRules>([
  "stopLossPoints",
  "takeProfitPoints",
  "trailingStopPoints",
  "timedExitBars",
  "breakEvenTrigger",
  "extensionBars",
  "slAtrAdjust",
  "tpAtrAdjust",
  "trailAtrAdjust",
  "beAtrAdjust",
  "scalingStartSize",
  "scalingWinStep",
  "scalingLossStep",
  "scalingMinSize",
  "scalingMaxSize",
  "dailyStopLossPoints",
  "dailyTakeProfitPoints",
  "maxTradesPerDay",
  "maxLossesPerDay",
  "cooldownBetweenTradesBars",
  "slippagePoints",
  "commissionPerRoundTrip",
  "pointValue",
]);

/** Build the SUMMARY-context symbol table from a SimSummary. The
 *  resulting record is consumed by evaluateSummaryPrints below — and by
 *  any future caller that wants to evaluate `print = ...` expressions
 *  outside of the dashboard run-memo. Keeping it as a plain Record
 *  matches the `SummaryEvalCtx` shape exactly. */
export function buildSummarySymbolTable(
  summary: import("./zone-simulator").SimSummary
): Record<string, number> {
  return {
    winRate: summary.winRate,
    profitFactor: summary.profitFactor,
    totalPnl: summary.totalPoints,
    totalPoints: summary.totalPoints,
    expectancy: summary.expectancy,
    expectancyPerSize: summary.expectancyPerSize,
    avgPoints: summary.avgPoints,
    avgWinPoints: summary.avgWinPoints,
    avgLossPoints: summary.avgLossPoints,
    avgBarsHeld: summary.avgBarsHeld,
    avgtradetime: summary.avgBarsHeld, // user-facing alias
    dailyEv: summary.dailyEv,
    tradingDays: summary.tradingDays,
    avgTradesPerHour: summary.avgTradesPerHour,
    sharpeOriginal: summary.sharpeOriginal,
    sharpeSimulated: summary.sharpeSimulated,
    totalTrades: summary.totalTrades,
    winners: summary.winners,
    losers: summary.losers,
    bestTrade: summary.bestTrade,
    worstTrade: summary.worstTrade,
    // Note: avgRR is not on SimSummary directly — derived in trade-stats
    // for the legacy Trade[] flow. Surface it as NaN so users at least
    // get a clear "missing" rather than a random 0.
    avgRR: NaN,
  };
}

/** Evaluate the run's `print = ...` directives against a SimSummary-based
 *  context. Returns one entry per directive; NaN values are kept so the
 *  output panel can render "—" rather than dropping the row. */
export function evaluateSummaryPrints(
  prints: Array<{ source: string; expr: Expr; label: string }>,
  symbols: Record<string, number>
): Array<{ label: string; source: string; value: number }> {
  const ctx: EvalCtx = { kind: "summary", symbols };
  return prints.map((p) => ({
    label: p.label,
    source: p.source,
    value: evaluate(p.expr, ctx),
  }));
}

/** Per-trade bar fields the entry context exposes as bare identifiers.
 *  Mirrors the switch in resolveIdent's entry branch. */
const ENTRY_BAR_FIELDS = new Set<string>([
  "open",
  "high",
  "low",
  "close",
  "volume",
  "bar_index",
  "direction",
]);

/** Indicator function-call names recognized by the entry-context
 *  evaluator. Mirrors the dispatch in computeIndicatorSeries — must
 *  stay in sync when new indicators are added. Used by
 *  expressionReferencesEntryContext to decide whether a print=...
 *  expression must aggregate over per-trade ctxs. */
const INDICATOR_CALL_NAMES = new Set<string>([
  // Existing.
  "ATR", "EMA", "SMA", "ADX", "volume", "trailVol", "stdev",
  // Moving averages.
  "WMA", "HMA", "DEMA", "TEMA", "VWMA",
  // Momentum / oscillators.
  "RSI", "ROC", "MOM", "CCI", "WilliamsR", "TRIX", "MFI",
  // MACD / Bollinger / Stoch / Donchian.
  "MACD_line", "MACD_signal", "MACD_hist",
  "BB_mid", "BB_upper", "BB_lower", "BB_width", "BB_percent",
  "Stoch_K", "Stoch_D",
  "Donchian_upper", "Donchian_lower", "Donchian_mid",
  // Volatility / volume / cumulative.
  "TR", "NATR", "HV", "OBV", "AD", "CMF",
  // Lookback.
  "HHV", "LLV", "close_n", "high_n", "low_n", "open_n", "volume_n",
]);

/** True when the expression references any symbol that only resolves in
 *  per-trade ENTRY context — bar fields, bare-name indicator aliases
 *  (ATR, EMA20, ADX14, VOL14, ...), or indicator function calls. Used to
 *  decide whether a `print = ...` directive should fall back to
 *  per-trade aggregation when the summary symbol table can't resolve
 *  it. */
export function expressionReferencesEntryContext(expr: Expr): boolean {
  const refs = referencedSymbols(expr);
  for (const id of refs.idents) {
    if (ENTRY_BAR_FIELDS.has(id)) return true;
    if (BAR_SHAPE_IDENTS.has(id)) return true;
    if (bareIndicatorKey(id)) return true;
  }
  for (const c of refs.calls) {
    if (INDICATOR_CALL_NAMES.has(c.name)) return true;
  }
  return false;
}

/** Evaluate `print = ...` directives with per-trade aggregation
 *  fallback. When an expression references entry-context symbols
 *  (e.g. `print = ATR14`), evaluate it once per trade entry and average
 *  the finite results — this makes the most common useful default for
 *  per-bar values at summary level. When the expression only references
 *  summary symbols (winRate, profitFactor, ...), behavior matches the
 *  legacy evaluator. The aggregation is intentionally simple (mean over
 *  finite values) so users get a meaningful number without needing to
 *  learn explicit aggregator functions; users who want sum/min/max can
 *  still use ontrade.print and aggregate downstream. */
export function evaluateSummaryPrintsWithEntries(
  prints: Array<{ source: string; expr: Expr; label: string }>,
  summarySymbols: Record<string, number>,
  entryCtxs: EntryEvalCtx[]
): Array<{ label: string; source: string; value: number }> {
  const summaryCtx: EvalCtx = { kind: "summary", symbols: summarySymbols };
  return prints.map((p) => {
    if (expressionReferencesEntryContext(p.expr) && entryCtxs.length > 0) {
      let sum = 0;
      let n = 0;
      for (const ec of entryCtxs) {
        const v = evaluate(p.expr, { kind: "entry", ...ec });
        if (Number.isFinite(v)) {
          sum += v;
          n += 1;
        }
      }
      return {
        label: p.label,
        source: p.source,
        value: n > 0 ? sum / n : NaN,
      };
    }
    return {
      label: p.label,
      source: p.source,
      value: evaluate(p.expr, summaryCtx),
    };
  });
}

/** Build a concrete SimRules for a single trade by evaluating any
 *  expression overrides at the entry bar's context. Falls back to the
 *  baseline `rules` literal whenever:
 *    - the path isn't expression-overridden (most fields), or
 *    - the expression evaluates to NaN / non-finite (warmup, divide-by-zero).
 *  Pushes a one-line warning per fallback into `warnings` so the dashboard
 *  can surface a "N rules fell back to defaults" banner. */
export function resolveRulesForTrade<R extends Record<string, unknown>>(
  rules: R,
  numericOverrides: Record<string, NumericValue> | undefined,
  ctx: EntryEvalCtx,
  warnings: string[]
): R {
  if (!numericOverrides) return rules;
  let copy: Record<string, unknown> | null = null;
  for (const path of Object.keys(numericOverrides)) {
    if (!path.startsWith("rules.")) continue;
    const key = path.slice("rules.".length);
    if (!NUMERIC_RULE_KEYS.has(key as keyof import("./zone-simulator").SimRules)) continue;
    const nv = numericOverrides[path];
    const v = resolveNumericValue(nv, ctx);
    if (Number.isFinite(v)) {
      if (!copy) copy = { ...rules };
      copy[key] = v;
    } else {
      warnings.push(
        `${path}: expression "${nv.kind === "expr" ? nv.source : "(literal)"}" evaluated to NaN at zone ${ctx.zone.id} bar ${ctx.barIndex} — falling back to literal default.`
      );
    }
  }
  return (copy as R) ?? rules;
}
