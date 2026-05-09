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
  // Order flow / extended indicator library v2.
  deltaSeries,
  cvdSeries,
  deltaRatioBarSeries,
  buyPressureSeries,
  keltnerUpperSeries,
  keltnerMidSeries,
  keltnerLowerSeries,
  supertrendSeries,
  psarSeries,
  ichimokuTenkanSeries,
  ichimokuKijunSeries,
  ichimokuSenkouASeries,
  ichimokuSenkouBSeries,
  ichimokuChikouSeries,
  aroonUpSeries,
  aroonDownSeries,
  aroonOscSeries,
  vortexPlusSeries,
  vortexMinusSeries,
  diPlusSeries,
  diMinusSeries,
  aoSeries,
  uoSeries,
  fisherSeries,
  choppinessSeries,
  ulcerSeries,
  zscoreSeries,
  lrSlopeSeries,
  lrInterceptSeries,
  lrValueSeries,
  r2Series,
  vwapRollingSeries,
  kvoSeries,
  forceIndexSeries,
  emvSeries,
  nviSeries,
  pviSeries,
  type IndicatorBar,
} from "@/lib/indicators/calculations";
import {
  ProfileCache,
  pocSeries,
  vahSeries,
  valSeries,
  vaWidthSeries,
  distToPocSeries,
  tradesAtBidSeries,
  tradesAtAskSeries,
  tickImbalanceSeries,
  tickCountSeries,
  meanTradeSizeSeries,
  largeTradeCountSeries,
  vwapTickSeries,
  type TickContext,
} from "@/lib/indicators/tick-indicators";
import {
  KalmanOuCache,
  KALMAN_SOURCE_CODES,
} from "@/lib/indicators/kalman-ou";

export { KALMAN_SOURCE_CODES } from "@/lib/indicators/kalman-ou";

export type { TickContext } from "@/lib/indicators/tick-indicators";

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
  | { kind: "if"; cond: Expr; then: Expr; else: Expr }
  // Postfix index: `expr[offset]`. Used by the strategy DSL to look back N
  // bars on a series-producing expression (e.g. `high(20)[5]` = the rolling
  // 20-bar high evaluated 5 bars ago). The script-expr.ts evaluator itself
  // doesn't know how to evaluate this against a static EvalCtx — it returns
  // NaN. The strategy evaluator (strategy-evaluator.ts) handles `index`
  // against per-bar SeriesHandle values.
  | { kind: "index"; base: Expr; offset: Expr };

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
// Identifiers may include dotted segments like `params.lookback` or
// `signal.long.if` — used by the strategy DSL for namespaced names.
// Single-segment idents (the legacy case) still tokenize identically.
// NUM_RE is matched FIRST so `.5` stays a number, not a dotted continuation.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
// Single-character punct fallback. Multi-char operators (>=, <=, ==, !=,
// &&, ||) are matched explicitly below so we don't have to backtrack.
// `[` and `]` were added for the postfix index operator (`expr[N]`).
const PUNCT_RE = /^[+\-*/%^(),<>=!&|[\]]/;

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
//   ,                      (logical and, sugar)    — 4 (only at top level)
//   &&                     (logical and)           — 4
//   == != < > <= >=        (comparisons)           — 6
//   + -                    (additive)              — 10
//   * / %                  (multiplicative)        — 20
//   ^                      (exponent, right-assoc) — 30
//   - + !                  (unary prefix)          — 40
//   [ ]                    (postfix index, tightest)
// Logical ops sit BELOW comparisons so `a > 0 && b < 10` parses as
// `(a > 0) && (b < 10)` — same precedence rules every C-family language
// uses, so users porting filter expressions from elsewhere don't get
// surprises. Comparisons are NON-associative in spirit (`a < b < c` is
// nonsensical here) but we keep them left-associative to avoid a
// special-case parser rule; users who write that get `(a<b) < c` which
// evaluates to a meaningful number even if it's not what they meant.
//
// Comma-as-and: at the top level (NOT inside function-call arg lists), `,`
// is sugar for `&&`, useful for vertical-stacking many gates. `a, b, c`
// parses identically to `a && b && c`. Inside `f(a, b)` the parser passes
// `allowComma=false` so `,` falls through to the arg-list separator path.
// If the user writes `min(a, b)` intending AND, the result is a 2-arg call
// to `min`, not an AND — same as before. Eventually we may surface a
// warning in lint mode; not done here.
const INFIX_PRECEDENCE: Record<string, number> = {
  "||": 2,
  ",": 4,
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

/** Parse an expression. `allowComma` controls whether top-level `,` is
 *  consumed as a binary operator (sugar for `&&`). Pass `false` from the
 *  arg-list parser inside `parsePrefix` so `f(a, b)` keeps `,` as an arg
 *  separator instead of folding into `f(a && b)`. Outer expressions and
 *  parenthesized groups (`(a, b, c)`) default to `true`. */
function parseExpr(p: ParserState, minBp: number, allowComma = true): Expr {
  // Prefix.
  let left = parsePrefix(p, allowComma);

  // Postfix `[offset]` — applies as tightly as a function call would, so
  // `high(20)[5]` parses as `index(call("high", [20]), 5)`. Looped to
  // support chained indexing (`series[a][b]` — degenerate but harmless).
  // The offset is parsed with `allowComma=true` because it's enclosed in
  // brackets, so a trailing `,` would be ambiguous and we just don't
  // support it (single-expression offsets only).
  while (true) {
    const t = p.peek();
    if (!t || t.kind !== "punct" || t.value !== "[") break;
    p.next(); // consume "["
    const offset = parseExpr(p, 0, true);
    if (!p.eatPunct("]")) throw new Error('expected "]" after index expression');
    left = { kind: "index", base: left, offset };
  }

  // Infix loop.
  while (true) {
    const t = p.peek();
    if (!t || t.kind !== "punct") break;
    const op = t.value;
    // Comma at top level is `&&`; inside arg lists it falls through to
    // `parsePrefix`'s arg-separator handling.
    if (op === "," && !allowComma) break;
    const bp = INFIX_PRECEDENCE[op];
    if (bp === undefined || bp < minBp) break;
    p.next();
    const nextMinBp = RIGHT_ASSOC[op] ? bp : bp + 1;
    const rhs = parseExpr(p, nextMinBp, allowComma);
    if (op === ",") {
      // Sugar: rewrite `a, b` to a `&&` AST node so every downstream
      // walker (referencedSymbols, applyBindings, evaluate) keeps working
      // without learning a new node kind.
      left = { kind: "binop", op: "&&", lhs: left, rhs };
    } else {
      left = { kind: "binop", op: op as BinOp, lhs: left, rhs };
    }
  }
  return left;
}

function parsePrefix(p: ParserState, allowComma: boolean): Expr {
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
      const cond = parseExpr(p, 0, allowComma);
      const thenTok = p.next();
      if (!thenTok || thenTok.kind !== "ident" || thenTok.name !== "then") {
        throw new Error('expected "then" after if-condition');
      }
      const thenExpr = parseExpr(p, 0, allowComma);
      const elseTok = p.next();
      if (!elseTok || elseTok.kind !== "ident" || elseTok.name !== "else") {
        throw new Error('expected "else" after then-branch');
      }
      const elseExpr = parseExpr(p, 0, allowComma);
      return { kind: "if", cond, then: thenExpr, else: elseExpr };
    }
    // Function call: identifier followed by `(`.
    const next = p.peek();
    if (next && next.kind === "punct" && next.value === "(") {
      p.next(); // consume "("
      const args: Expr[] = [];
      // Empty arg list: ident()
      if (!p.eatPunct(")")) {
        // Inside arg lists, `,` is the separator — pass allowComma=false
        // so the inner expression parser doesn't fold `f(a, b)` into
        // `f(a && b)`. The outer eatPunct(",") loop below picks up the
        // separator.
        args.push(parseExpr(p, 0, false));
        while (p.eatPunct(",")) args.push(parseExpr(p, 0, false));
        if (!p.eatPunct(")")) throw new Error('expected ")" after function arguments');
      }
      return { kind: "call", name: t.name, args };
    }
    return { kind: "ident", name: t.name };
  }
  if (t.kind === "punct") {
    if (t.value === "(") {
      // Grouping parens — comma at this level is still `&&` sugar (e.g.
      // `(a, b)` inside a larger expression). Only function-call `(` (the
      // arg-list path above) disables comma-as-and.
      const inner = parseExpr(p, 0, true);
      if (!p.eatPunct(")")) throw new Error('expected ")"');
      return inner;
    }
    // Unary: `-`, `+`, and `!` (logical NOT). All bind tighter than any
    // infix op so `!a > 0` parses as `(!a) > 0` — same as C.
    if (t.value === "-" || t.value === "+" || t.value === "!") {
      const arg = parseExpr(p, UNARY_PRECEDENCE, allowComma);
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
      case "index":
        // The index node is meaningful only to the strategy evaluator.
        // For the standard symbol walker, recurse into both base and
        // offset so any indicators / idents referenced inside are still
        // counted (e.g. `high(p)[k]` should still count `high` as a
        // referenced call when the call has constant args).
        walk(e.base);
        walk(e.offset);
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
    case "index":
      return {
        ...expr,
        base: applyBindings(expr.base, bindings),
        offset: applyBindings(expr.offset, bindings),
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
  /** The trade's bar array — used by `cross_up` / `cross_down` (and any
   *  future helper that needs to re-evaluate args at a previous bar) to
   *  look up the prior bar's OHLCV. The cross helpers clone the ctx
   *  with `bar: bars[barIndex - 1]` and `barIndex - 1` so bare-name
   *  bar fields (close/open/high/low/volume) resolve at the prior bar
   *  while indicator series — already barIndex-indexed in
   *  `indicatorByKey` — also shift back transparently.
   *
   *  Optional because non-walker callers (entry-time `filter.if`,
   *  single-bar `ontrade.print`) have no meaningful previous bar at
   *  the entry point of evaluation. The cross helpers return 0 when
   *  this is absent — same outcome as strategy-evaluator's
   *  `barIndex < 1` short-circuit.
   *
   *  Convention: `bars[i].bar_index === i` (matches the zone
   *  simulator's `sorted` array). Callers that pass a bars array with
   *  a different index alignment will mis-index the prev bar. */
  bars?: TradeZoneBar[];
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
  /** Per-trade outcome bindings — populated by the simulator AFTER
   *  `simulateZone` returns and AFTER scaling/daily-limit post-passes
   *  have settled, so `ontrade.print` expressions can reference
   *  `exit_points`, `exit_reason`, `bars_held`, `peak_mfe`,
   *  `max_drawdown`, `net_dollars`, `position_size`, `eff_sl`/`eff_tp`,
   *  etc. Absent during entry-time evaluation (filter.if conditions,
   *  numericOverrides resolution) — every exit-side bare name returns
   *  NaN in that phase, matching the rest of the engine's NaN-as-fail
   *  discipline. `exit_reason` is exposed as a numeric code (see
   *  EXIT_REASON_CODE below) so it round-trips through the numeric
   *  `script_prints` map; named constants `EXIT_TP`, `EXIT_SL`, etc.
   *  let users compare without remembering the integers. */
  tradeResult?: TradeResultBindings;
}

/** Numeric codes for ExitReason values — exposed as bare-name
 *  constants in the entry evaluator (`EXIT_TP`, `EXIT_SL`, ...) and
 *  used as the value of `exit_reason` when a trade's outcome is
 *  bound. Codes are stable so users can persist comparisons in
 *  scripts; new ExitReason values must extend this map without
 *  renumbering the existing entries. */
export const EXIT_REASON_CODE: Record<string, number> = {
  tp: 1,
  sl: 2,
  trail: 3,
  be: 4,
  timer: 5,
  end: 6,
  next: 7,
  daily: 8,
  signal: 9,
};

/** Per-trade outcome bindings surfaced to `ontrade.print` expressions
 *  via `EntryEvalCtx.tradeResult`. Every field is a finite number when
 *  populated; absent fields (e.g. `eff_sl` on a legacy SimZoneResult)
 *  resolve to NaN. */
export interface TradeResultBindings {
  exit_points: number;
  scaled_points: number;
  bars_held: number;
  peak_mfe: number;
  max_drawdown: number;
  net_dollars: number;
  position_size: number;
  commission_dollars: number;
  slippage_applied: number;
  /** Numeric code from EXIT_REASON_CODE — 1=tp, 2=sl, 3=trail,
   *  4=be, 5=timer, 6=end, 7=next, 8=daily, 9=signal. */
  exit_reason: number;
  /** 1 when exit_points > 0, else 0. Convenience for filter-style
   *  prints (`ontrade.print = is_winner, "win"`). */
  is_winner: number;
  /** 1 when exit_points < 0, else 0. */
  is_loser: number;
  /** Effective SL/TP/Trail/BE thresholds the simulator actually used
   *  for this trade — already resolved (base + atrAdjust × ATR) and
   *  reflecting any per-trade rule overrides. NaN when undefined on
   *  the source SimZoneResult. */
  eff_sl: number;
  eff_tp: number;
  eff_trail: number;
  eff_be: number;
  /** Entry price the simulator used (zone.start_price or bar1.open
   *  under fillMode="next_open"). */
  entry_price: number;
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
    case "index":
      // The single-shot expression evaluator has no concept of "series"
      // or per-bar lookback — that's the strategy evaluator's job. From
      // this evaluator's perspective `expr[N]` is a not-applicable node;
      // returning NaN is the same null-as-fail discipline used elsewhere.
      // Callers using this evaluator (rules/filters) shouldn't write
      // `[N]` — if they do, they get a clean NaN that propagates.
      return NaN;
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
    // ─── Order flow / bid-ask ────────────────────────────────────────
    // Read from bar fields when the source granularity supports
    // bid/ask attribution; NaN-safe when unavailable. `delta_ratio` and
    // `buy_pressure` are derived inline (no precompute needed) — same
    // shape as the OHLC-derived bar-shape scalars above.
    case "bar_volume_bid":
      return bar.bar_volume_bid == null ? NaN : bar.bar_volume_bid;
    case "bar_volume_ask":
      return bar.bar_volume_ask == null ? NaN : bar.bar_volume_ask;
    case "buy_volume":
      return bar.bar_volume_ask == null ? NaN : bar.bar_volume_ask;
    case "sell_volume":
      return bar.bar_volume_bid == null ? NaN : bar.bar_volume_bid;
    case "delta": {
      if (bar.bar_volume_bid == null || bar.bar_volume_ask == null) return NaN;
      return bar.bar_volume_ask - bar.bar_volume_bid;
    }
    case "delta_ratio": {
      if (bar.bar_volume_bid == null || bar.bar_volume_ask == null) return NaN;
      const total = bar.bar_volume_bid + bar.bar_volume_ask;
      if (total <= 0) return NaN;
      return (bar.bar_volume_ask - bar.bar_volume_bid) / total;
    }
    case "buy_pressure": {
      if (bar.bar_volume_ask == null || !Number.isFinite(bar.bar_volume) || bar.bar_volume <= 0) return NaN;
      return bar.bar_volume_ask / bar.bar_volume;
    }
    // Tick config — bare-name access. Returns NaN when the simulator
    // didn't populate tickConfig (legacy callers / unit tests).
    case "ticksPerPoint":
      return ctx.tickConfig?.ticksPerPoint ?? NaN;
    case "pointValue":
      return ctx.tickConfig?.pointValue ?? NaN;
    case "tickValue":
      return ctx.tickConfig?.tickValue ?? NaN;
    // ── Per-trade outcome bindings ──────────────────────────────────
    // Resolve to NaN when `tradeResult` is absent (entry-time path:
    // filter.if conditions, numericOverrides resolution, optimizer
    // bounds expressions). The simulator populates `tradeResult`
    // ONLY for the post-exit re-evaluation pass that produces
    // `script_prints`, so referencing these names in a filter.if
    // condition fails-closed via standard NaN propagation.
    case "exit_points":
      return ctx.tradeResult?.exit_points ?? NaN;
    case "scaled_points":
      return ctx.tradeResult?.scaled_points ?? NaN;
    case "bars_held":
      return ctx.tradeResult?.bars_held ?? NaN;
    case "peak_mfe":
      return ctx.tradeResult?.peak_mfe ?? NaN;
    case "max_drawdown":
      return ctx.tradeResult?.max_drawdown ?? NaN;
    case "net_dollars":
      return ctx.tradeResult?.net_dollars ?? NaN;
    case "position_size":
      return ctx.tradeResult?.position_size ?? NaN;
    case "commission_dollars":
      return ctx.tradeResult?.commission_dollars ?? NaN;
    case "slippage_applied":
      return ctx.tradeResult?.slippage_applied ?? NaN;
    case "exit_reason":
      return ctx.tradeResult?.exit_reason ?? NaN;
    case "is_winner":
      return ctx.tradeResult?.is_winner ?? NaN;
    case "is_loser":
      return ctx.tradeResult?.is_loser ?? NaN;
    case "eff_sl":
      return ctx.tradeResult?.eff_sl ?? NaN;
    case "eff_tp":
      return ctx.tradeResult?.eff_tp ?? NaN;
    case "eff_trail":
      return ctx.tradeResult?.eff_trail ?? NaN;
    case "eff_be":
      return ctx.tradeResult?.eff_be ?? NaN;
    case "entry_price":
      return ctx.tradeResult?.entry_price ?? NaN;
    // Exit-reason named constants — let users compare against
    // `exit_reason` without remembering the numeric codes.
    // `EXIT_TARGET` / `EXIT_STOP` are friendly aliases for the
    // canonical `EXIT_TP` / `EXIT_SL`. Not gated on `tradeResult`
    // because they're literal constants.
    case "EXIT_TP":
    case "EXIT_TARGET":
      return EXIT_REASON_CODE.tp;
    case "EXIT_SL":
    case "EXIT_STOP":
      return EXIT_REASON_CODE.sl;
    case "EXIT_TRAIL":
      return EXIT_REASON_CODE.trail;
    case "EXIT_BE":
      return EXIT_REASON_CODE.be;
    case "EXIT_TIMER":
      return EXIT_REASON_CODE.timer;
    case "EXIT_END":
      return EXIT_REASON_CODE.end;
    case "EXIT_NEXT":
      return EXIT_REASON_CODE.next;
    case "EXIT_DAILY":
      return EXIT_REASON_CODE.daily;
    case "EXIT_SIGNAL":
      return EXIT_REASON_CODE.signal;
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
export const ZERO_ARG_INDICATORS = new Set<string>([
  "OBV", "AD", "TR",
  // Extended indicator library v2 — cumulative or no-period oscillators.
  "CVD", "AO", "NVI", "PVI",
]);

/** Indicators whose args may legitimately be fractional (and may need
 *  small positive values that would round to 0). The eval layer skips
 *  the integer-rounding step for these. */
export const FRACTIONAL_ARG_INDICATORS = new Set<string>([
  // PSAR step/max are 0.02 / 0.2 by convention.
  "PSAR",
  // Volume-profile area defaults to 0.7 (70% of total volume).
  "POC", "VAH", "VAL", "VA_width", "dist_to_POC",
  // KALMAN_OU's `trust` arg is a fraction in (0,1); rounding would
  // collapse it to 0 or 1 and break the filter. The integer-rounding
  // bypass keeps source / calib / trust all unmodified — source codes
  // are tiny ints that survive verbatim, calib is rounded inside
  // `kalmanOuBundle` itself (defense-in-depth).
  "KALMAN_OU_x", "KALMAN_OU_mu", "KALMAN_OU_sigma", "KALMAN_OU_phi", "KALMAN_OU_P",
  "KALMAN_OU_x_pred",
]);

/** Indicators that require the per-zone TickContext to compute. When
 *  ticks are unavailable for the session (granularity 'ohlcv' /
 *  'ohlcv_bidask'), `computeIndicatorSeries` returns all-NaN — the
 *  evaluator surfaces NaN at the entry bar, matching the rest-of-
 *  engine null-as-fail discipline so scripts still parse and evaluate
 *  cleanly. Exported so the dashboard / docs panel can flag tick
 *  dependence in the autocomplete UI. */
export const TICK_REQUIRED_INDICATORS = new Set<string>([
  "POC", "VAH", "VAL", "VA_width", "dist_to_POC",
  "trades_at_bid", "trades_at_ask", "tick_imbalance",
  "tick_count", "mean_trade_size", "large_trade_count", "vwap_tick",
]);

/** Apply standard defaults for indicators where the user may omit
 *  trailing args. e.g. `BB_upper(20)` should resolve like
 *  `BB_upper(20, 2)`. Returns a new args array (never mutates input).
 *  Defaults match standard TA conventions:
 *    - BB families: mult = 2
 *    - MACD signal/hist: signal = 9
 *    - Stoch_D: smoothK = 3, smoothD = 3
 *  Names not listed return args unchanged. */
export function applyArgDefaults(name: string, args: number[]): number[] {
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
    // Keltner Channel multiplier defaults to 2.
    case "Keltner_upper":
    case "Keltner_lower":
      return args.length >= 2 ? args : [args[0], 2];
    // Supertrend defaults — period 10, mult 3 (canonical).
    case "Supertrend":
      if (args.length >= 2) return args;
      if (args.length === 1) return [args[0], 3];
      return [10, 3];
    // PSAR defaults — step 0.02, max 0.2 (Wilder's originals).
    // Args are scaled ints (×100) on the way in because the eval layer
    // rounds floats. We multiply both to keep them in fractional form
    // when the user passes integer-like values; users wanting custom
    // step/max should pass `0.02 * 100 = 2` and `0.2 * 100 = 20`.
    // For the default case we just substitute the raw fractions.
    case "PSAR":
      if (args.length === 0) return [0.02, 0.2];
      if (args.length === 1) return [args[0], 0.2];
      return args;
    // Ichimoku defaults follow the canonical Tenkan(9), Kijun(26),
    // SenkouB(52), Chikou(26).
    case "Ichimoku_tenkan":
      return args.length >= 1 ? args : [9];
    case "Ichimoku_kijun":
      return args.length >= 1 ? args : [26];
    case "Ichimoku_senkouA":
      if (args.length >= 2) return args;
      if (args.length === 1) return [args[0], 26];
      return [9, 26];
    case "Ichimoku_senkouB":
      return args.length >= 1 ? args : [52];
    case "Ichimoku_chikou":
      return args.length >= 1 ? args : [26];
    // Aroon / Vortex / DI default period 14.
    case "Aroon_up":
    case "Aroon_down":
    case "Aroon_osc":
    case "VortexPlus":
    case "VortexMinus":
    case "DIplus":
    case "DIminus":
      return args.length >= 1 ? args : [14];
    // Ultimate Oscillator default windows (7, 14, 28).
    case "UO":
      if (args.length >= 3) return args;
      if (args.length === 2) return [args[0], args[1], 28];
      if (args.length === 1) return [args[0], 14, 28];
      return [7, 14, 28];
    // Fisher transform default period 10.
    case "Fisher":
      return args.length >= 1 ? args : [10];
    // Choppiness / Ulcer default period 14.
    case "Choppiness":
    case "Ulcer":
      return args.length >= 1 ? args : [14];
    // Klinger default fast/slow.
    case "KVO":
      if (args.length >= 2) return args;
      if (args.length === 1) return [args[0], 55];
      return [34, 55];
    // Force Index default period 13, EMV default 14.
    case "ForceIndex":
      return args.length >= 1 ? args : [13];
    case "EMV":
      return args.length >= 1 ? args : [14];
    // Volume profile family — area arg defaults to 0.7 (industry-std).
    case "POC":
    case "VAH":
    case "VAL":
    case "VA_width":
    case "dist_to_POC":
      return args.length >= 2 ? args : [args[0], 0.7];
    // Tick microstructure — single-arg windows.
    case "trades_at_bid":
    case "trades_at_ask":
    case "tick_imbalance":
    case "tick_count":
    case "mean_trade_size":
    case "vwap_tick":
      return args;
    case "large_trade_count":
      return args;
    // KALMAN_OU sub-indicators — args are [source, calib, trust] with
    // sensible defaults. `source` defaults to 1 (close); `calib` defaults
    // to 60 bars; `trust` defaults to 0.5. The strategy parser usually
    // fills the source slot before this gets called (so users typically
    // see all three present), but the defaults make the bare-call form
    // `KALMAN_OU_x()` a meaningful sanity check.
    case "KALMAN_OU_x":
    case "KALMAN_OU_mu":
    case "KALMAN_OU_sigma":
    case "KALMAN_OU_phi":
    case "KALMAN_OU_P":
    case "KALMAN_OU_x_pred": {
      const source = args.length >= 1 ? args[0] : 1;
      const calib = args.length >= 2 ? args[1] : 60;
      const trust = args.length >= 3 ? args[2] : 0.5;
      return [source, calib, trust];
    }
    default:
      return args;
  }
}

function evalCallEntry(name: string, args: Expr[], ctx: EntryEvalCtx & { kind: "entry" }): number {
  // cross_up(a, b) / cross_down(a, b) — bar-over-bar comparison. True
  // (returns 1) when a crossed above/below b between the prior bar and
  // the current bar; 0 otherwise. Mirrors the strategy-evaluator
  // implementation at strategy-evaluator.ts:1097-1122 so signal-side
  // and exit-side semantics match.
  //
  // Needs prior-bar context, which only the per-bar exit walker
  // provides (via `ctx.bars`). When called from entry-time evaluation
  // (filter.if, single-bar ontrade.print) `ctx.bars` is absent — we
  // return 0, matching the strategy walker's `barIndex < 1` short-
  // circuit. Caller can detect "no decision" by adding an explicit
  // bar-index guard if needed.
  //
  // Spread on prevCtx preserves `kind: "entry"` so the recursive
  // `evaluate` call routes back through this function for nested
  // helper references (e.g. cross_up of an EMA call).
  if (name === "cross_up" || name === "cross_down") {
    if (args.length !== 2) return NaN;
    if (ctx.barIndex < 1 || !ctx.bars) return 0;
    const prevBar = ctx.bars[ctx.barIndex - 1];
    if (!prevBar) return 0;
    const aNow = evaluate(args[0], ctx);
    const bNow = evaluate(args[1], ctx);
    const prevCtx = { ...ctx, bar: prevBar, barIndex: ctx.barIndex - 1 };
    const aPrev = evaluate(args[0], prevCtx);
    const bPrev = evaluate(args[1], prevCtx);
    if (
      !Number.isFinite(aNow) || !Number.isFinite(bNow) ||
      !Number.isFinite(aPrev) || !Number.isFinite(bPrev)
    ) {
      return NaN;
    }
    if (name === "cross_up") return aPrev < bPrev && aNow >= bNow ? 1 : 0;
    return aPrev > bPrev && aNow <= bNow ? 1 : 0;
  }
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
  // Most periods/lookbacks are integers and we round to int; a small
  // set of indicators take fractional args (PSAR's step/max, value-
  // area pct) and bypass rounding. Rejection of non-positive values
  // also relaxes for those — PSAR step=0.02 is non-integer but very
  // small, and we don't want to drop it.
  const evaluated: number[] = [];
  const allowFractional = FRACTIONAL_ARG_INDICATORS.has(name);
  for (const a of args) {
    const v = evaluate(a, ctx);
    if (!Number.isFinite(v) || v <= 0) return NaN;
    evaluated.push(allowFractional ? v : Math.round(v));
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
    // ─── Extended indicator library v2 ────────────────────────────────
    // Keltner Channels.
    case "Keltner_mid":
      return `KELTM:${p}`;
    case "Keltner_upper":
      return `KELTU:${args[0]}:${args[1]}`;
    case "Keltner_lower":
      return `KELTL:${args[0]}:${args[1]}`;
    // Trailing systems.
    case "Supertrend":
      return `SUPER:${args[0]}:${args[1]}`;
    case "PSAR":
      return `PSAR:${args[0]}:${args[1]}`;
    // Ichimoku family.
    case "Ichimoku_tenkan":
      return `ICHTEN:${p}`;
    case "Ichimoku_kijun":
      return `ICHKIJ:${p}`;
    case "Ichimoku_senkouA":
      return `ICHSPA:${args[0]}:${args[1]}`;
    case "Ichimoku_senkouB":
      return `ICHSPB:${p}`;
    case "Ichimoku_chikou":
      return `ICHCHK:${p}`;
    // Aroon, Vortex, DI legs.
    case "Aroon_up":
      return `AROONU:${p}`;
    case "Aroon_down":
      return `AROOND:${p}`;
    case "Aroon_osc":
      return `AROONO:${p}`;
    case "VortexPlus":
      return `VIP:${p}`;
    case "VortexMinus":
      return `VIM:${p}`;
    case "DIplus":
      return `DIP:${p}`;
    case "DIminus":
      return `DIM:${p}`;
    // Oscillators.
    case "UO":
      return `UO:${args[0]}:${args[1]}:${args[2]}`;
    case "Fisher":
      return `FISHER:${p}`;
    case "Choppiness":
      return `CHOP:${p}`;
    case "Ulcer":
      return `ULCER:${p}`;
    case "Zscore":
      return `ZSCORE:${p}`;
    case "LRSlope":
      return `LRS:${p}`;
    case "LRIntercept":
      return `LRINT:${p}`;
    case "LRValue":
      return `LRVAL:${p}`;
    case "R2":
      return `R2:${p}`;
    case "VWAP":
      return `VWAP:${p}`;
    case "KVO":
      return `KVO:${args[0]}:${args[1]}`;
    case "ForceIndex":
      return `FORCE:${p}`;
    case "EMV":
      return `EMV:${p}`;
    // Volume profile (rolling window).
    case "POC":
      return `POC:${args[0]}:${args[1]}`;
    case "VAH":
      return `VAH:${args[0]}:${args[1]}`;
    case "VAL":
      return `VAL:${args[0]}:${args[1]}`;
    case "VA_width":
      return `VAWIDTH:${args[0]}:${args[1]}`;
    case "dist_to_POC":
      return `DISTPOC:${args[0]}:${args[1]}`;
    // Tick microstructure.
    case "trades_at_bid":
      return `TRBID:${p}`;
    case "trades_at_ask":
      return `TRASK:${p}`;
    case "tick_imbalance":
      return `TICKIMB:${p}`;
    case "tick_count":
      return `TICKCNT:${p}`;
    case "mean_trade_size":
      return `MEANSZ:${p}`;
    case "large_trade_count":
      return `LARGECNT:${args[0]}:${args[1]}`;
    case "vwap_tick":
      return `VWAPTICK:${p}`;
    // Kalman-OU sub-indicators — keyed by (field, source, calib, trust)
    // so all five fields against the same parameter tuple stay distinct
    // in the per-zone series cache, while sharing the underlying bundle
    // build via `KalmanOuCache`.
    case "KALMAN_OU_x":
      return `KOU_X:${args[0]}:${args[1]}:${args[2]}`;
    case "KALMAN_OU_mu":
      return `KOU_MU:${args[0]}:${args[1]}:${args[2]}`;
    case "KALMAN_OU_sigma":
      return `KOU_SIG:${args[0]}:${args[1]}:${args[2]}`;
    case "KALMAN_OU_phi":
      return `KOU_PHI:${args[0]}:${args[1]}:${args[2]}`;
    case "KALMAN_OU_P":
      return `KOU_P:${args[0]}:${args[1]}:${args[2]}`;
    case "KALMAN_OU_x_pred":
      return `KOU_XPRED:${args[0]}:${args[1]}:${args[2]}`;
    default:
      return null;
  }
}

/** Every indicator name recognized by `indicatorKeyForCall` plus the
 *  zero-arg families. Used by the strategy evaluator to gate dispatch
 *  in evalCall (so an unrecognized call name falls through to NaN
 *  rather than emitting a spurious cache key). Build once at module
 *  load — the set is closed and indicator names don't change at
 *  runtime. */
const KNOWN_INDICATOR_NAMES = new Set<string>([
  // Single-period families.
  "ATR", "EMA", "SMA", "ADX", "volume", "trailVol", "stdev",
  "WMA", "HMA", "DEMA", "TEMA", "VWMA",
  "RSI", "ROC", "MOM", "CCI", "WilliamsR", "TRIX", "MFI", "NATR",
  "HV", "CMF", "HHV", "LLV",
  "Stoch_K", "Donchian_upper", "Donchian_lower", "Donchian_mid", "BB_mid",
  "close_n", "high_n", "low_n", "open_n", "volume_n",
  // Multi-arg families.
  "MACD_line", "MACD_signal", "MACD_hist",
  "BB_upper", "BB_lower", "BB_width", "BB_percent",
  "Stoch_D",
  // Extended indicator library.
  "Keltner_mid", "Keltner_upper", "Keltner_lower",
  "Supertrend", "PSAR",
  "Ichimoku_tenkan", "Ichimoku_kijun", "Ichimoku_senkouA", "Ichimoku_senkouB", "Ichimoku_chikou",
  "Aroon_up", "Aroon_down", "Aroon_osc",
  "VortexPlus", "VortexMinus", "DIplus", "DIminus",
  "UO", "Fisher", "Choppiness", "Ulcer",
  "Zscore", "LRSlope", "LRIntercept", "LRValue", "R2",
  "VWAP", "KVO", "ForceIndex", "EMV",
  // Volume profile (rolling window).
  "POC", "VAH", "VAL", "VA_width", "dist_to_POC",
  // Tick microstructure.
  "trades_at_bid", "trades_at_ask", "tick_imbalance", "tick_count",
  "mean_trade_size", "large_trade_count", "vwap_tick",
  // Kalman-filtered Ornstein-Uhlenbeck — exposed as six sibling names,
  // one per output field. The strategy parser rewrites `let kf =
  // KALMAN_OU(close, calib, trust)` + `kf.<field>` references into
  // direct calls to these names so member-access syntax just works
  // without the AST learning a new node kind. `KALMAN_OU_x_pred` is
  // the pre-fit OU prediction (forecast for bar i given everything
  // known BEFORE bar i opens) — use it as the divisor baseline for
  // unbiased innovation z-scores. The post-fit `KALMAN_OU_x` already
  // incorporates the bar-i observation; great for "fair value right
  // now," misleading as a divisor. See kalman-ou.ts for details.
  "KALMAN_OU_x", "KALMAN_OU_mu", "KALMAN_OU_sigma", "KALMAN_OU_phi", "KALMAN_OU_P",
  "KALMAN_OU_x_pred",
]);

/** True when `name` is a recognized indicator that `computeIndicatorSeries`
 *  knows how to compute (covers single-period, multi-arg, and zero-arg
 *  families). The strategy-evaluator uses this to decide whether to
 *  route a function call into the indicator dispatch vs. fall through
 *  to NaN. */
export function isKnownIndicator(name: string): boolean {
  return ZERO_ARG_INDICATORS.has(name) || KNOWN_INDICATOR_NAMES.has(name);
}

// ─── Symbol catalogue (for editor autocomplete + docs) ──────────────────────

/** A single worked example shown in the docs alongside an entry's
 *  description. Pairs a parseable DSL snippet with a one-line
 *  plain-English scenario — the snippet shows what to type, the
 *  scenario explains what happens, so a beginner can read either
 *  one and still get the idea. Shared across the docs page, the
 *  editor's hover tooltips, and the AI markdown export. */
export interface ExampleEntry {
  /** A working DSL snippet — one line, parseable by the script engine. */
  snippet: string;
  /** Plain-English one-liner explaining what the snippet does. */
  scenario: string;
}

/** Public catalogue of every symbol the entry-context evaluator
 *  recognizes. The editor consumes this for autocomplete and hover
 *  tooltips when the caret is in the RHS of a numeric-typed line. */
export interface ExprSymbol {
  name: string;
  kind: "ident" | "call" | "math" | "operator";
  signature?: string; // e.g. "ATR(period)"
  description: string;
  context: "entry" | "summary" | "both";
  /** Optional worked examples. Bare-name shortcut aliases (EMA20,
   *  ATR14, etc.) deliberately leave this empty and defer to the
   *  canonical family entry to avoid duplication. */
  examples?: ExampleEntry[];
}

/** Comparison + logical operators surfaced by the expression engine.
 *  Distinct from EXPR_SYMBOLS so the editor can group them in their own
 *  panel and the AI script reference can document them as a unit. All
 *  operators return 1.0 (true) / 0.0 (false); see `evaluate()` for the
 *  exact NaN propagation rules. */
export const EXPR_OPERATORS: ExprSymbol[] = [
  {
    name: ">",
    kind: "operator",
    signature: "a > b",
    description: 'Is the left number bigger than the right one? Returns "yes" (1) or "no" (0). If either side is missing data, the answer is "unknown" and a filter using it will reject.',
    context: "both",
    examples: [
      {
        snippet: "filter.if = close > EMA20",
        scenario: "Only trade when price is above the 20-bar EMA.",
      },
    ],
  },
  {
    name: "<",
    kind: "operator",
    signature: "a < b",
    description: "Is the left number smaller than the right one? Returns yes/no.",
    context: "both",
    examples: [
      {
        snippet: "filter.if = RSI(14) < 30",
        scenario: "Only trade when RSI is below 30 (oversold).",
      },
    ],
  },
  {
    name: ">=",
    kind: "operator",
    signature: "a >= b",
    description: "Is the left number bigger than OR equal to the right one?",
    context: "both",
    examples: [
      {
        snippet: "filter.if = volume >= volume(20)",
        scenario: "Only trade when this bar has at least average volume.",
      },
    ],
  },
  {
    name: "<=",
    kind: "operator",
    signature: "a <= b",
    description: "Is the left number smaller than OR equal to the right one?",
    context: "both",
    examples: [
      {
        snippet: "filter.if = ADX <= 20",
        scenario: "Only trade in calm, range-bound conditions (ADX of 20 or less).",
      },
    ],
  },
  {
    name: "==",
    kind: "operator",
    signature: "a == b",
    description:
      "Are the two numbers exactly equal? Mostly useful for comparing whole numbers (like bar_index == 0). Avoid using it on indicators because tiny rounding differences can make values that look equal not actually match.",
    context: "both",
    examples: [
      {
        snippet: "filter.if = bar_index == 0",
        scenario: "Only fire on the very first bar of the trade zone.",
      },
    ],
  },
  {
    name: "!=",
    kind: "operator",
    signature: "a != b",
    description: "Are the two numbers different?",
    context: "both",
    examples: [
      {
        snippet: "filter.if = direction != 0",
        scenario: "Trade always (direction is always +1 or -1, never 0) — same effect as no filter.",
      },
    ],
  },
  {
    name: "&&",
    kind: "operator",
    signature: "a && b",
    description: 'AND — both conditions must be true at the same time. Lets you stack multiple filters into one line.',
    context: "both",
    examples: [
      {
        snippet: "filter.if = ADX > 25 && close > EMA20",
        scenario: "Only trade when there's both a strong trend AND price is above the trend line.",
      },
    ],
  },
  {
    name: "||",
    kind: "operator",
    signature: "a || b",
    description: "OR — at least ONE of the two conditions must be true.",
    context: "both",
    examples: [
      {
        snippet: "filter.if = RSI(14) < 30 || RSI(14) > 70",
        scenario: "Only trade in extreme conditions — either oversold or overbought.",
      },
    ],
  },
  {
    name: "!",
    kind: "operator",
    signature: "!a",
    description: 'NOT — flips a yes into a no. "!something" means "the opposite of something".',
    context: "both",
    examples: [
      {
        snippet: "filter.if = !(ADX > 25)",
        scenario: "Only trade when ADX is NOT above 25 — same as `ADX <= 25`.",
      },
    ],
  },
];

export const EXPR_SYMBOLS: ExprSymbol[] = [
  // ─── Bare indicator aliases (shortcuts to the canonical call form). ──
  // Examples live on the call form; aliases just point to it so the docs
  // don't repeat themselves.
  { name: "ATR", kind: "ident", description: "Shortcut for ATR(14) — typical price wiggle over the last 14 bars. See ATR(period) for examples.", context: "entry" },
  { name: "ATR14", kind: "ident", description: "Same as ATR — both mean ATR(14). See ATR(period) for examples.", context: "entry" },
  { name: "EMA20", kind: "ident", description: "Shortcut for EMA(20) — fast trend line. See EMA(period) for examples.", context: "entry" },
  { name: "EMA50", kind: "ident", description: "Shortcut for EMA(50) — medium trend line. See EMA(period) for examples.", context: "entry" },
  { name: "EMA200", kind: "ident", description: "Shortcut for EMA(200) — long-term trend line. See EMA(period) for examples.", context: "entry" },
  { name: "SMA20", kind: "ident", description: "Shortcut for SMA(20) — fast plain average. See SMA(period) for examples.", context: "entry" },
  { name: "SMA50", kind: "ident", description: "Shortcut for SMA(50) — medium plain average. See SMA(period) for examples.", context: "entry" },
  { name: "SMA200", kind: "ident", description: "Shortcut for SMA(200) — long plain average. See SMA(period) for examples.", context: "entry" },
  { name: "ADX", kind: "ident", description: "Shortcut for ADX(14) — trend-strength score. See ADX(period) for examples.", context: "entry" },
  { name: "ADX14", kind: "ident", description: "Same as ADX — both mean ADX(14). See ADX(period) for examples.", context: "entry" },

  // ─── Current-bar fields ─────────────────────────────────────────────
  {
    name: "open",
    kind: "ident",
    description: "The opening price of the bar where this trade is entering.",
    context: "entry",
    examples: [
      { snippet: "rules.takeProfitPoints = abs(close - open) * 2", scenario: "Set the target at twice the size of the entry candle's body." },
    ],
  },
  {
    name: "high",
    kind: "ident",
    description: "The highest price the bar reached.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = high - close + 1", scenario: "Set stop a point above the entry candle's high." },
    ],
  },
  {
    name: "low",
    kind: "ident",
    description: "The lowest price the bar reached.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = close - low + 1", scenario: "Set stop a point below the entry candle's low." },
    ],
  },
  {
    name: "close",
    kind: "ident",
    description: "The closing price of the bar — this is also the entry price for new trades.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > EMA200", scenario: "Only take trades when price closed above the long-term trend line." },
    ],
  },
  {
    name: "volume",
    kind: "ident",
    description: "How many contracts/shares traded on the entry bar.",
    context: "entry",
    examples: [
      { snippet: "filter.if = volume > volume(20) * 1.5", scenario: "Only trade when this bar's volume is 50% above the recent average." },
    ],
  },
  {
    name: "bar_index",
    kind: "ident",
    description: "Where this bar sits inside the trade zone — 0 means it's the very first bar (the actual entry bar).",
    context: "entry",
    examples: [
      { snippet: "filter.if = bar_index == 0", scenario: "Only fire on the very first bar of each zone — no late entries." },
    ],
  },
  {
    name: "direction",
    kind: "ident",
    description: "+1 if this is a long trade, -1 if it's a short. Useful for direction-aware rules.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = direction == 1 ? 10 : 12", scenario: "(Illustrative) Use a different stop size for longs vs shorts. Note: ternary syntax shown isn't real DSL — use filter.if branches in actual scripts." },
    ],
  },

  // ─── Indicator calls (canonical, parametric forms) ──────────────────
  {
    name: "ATR",
    kind: "call",
    signature: "ATR(period)",
    description: "How much price normally swings around in one bar, averaged over the last `period` bars. Higher = wilder market.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = ATR(14) * 1.5", scenario: "Make the stop 1.5× the typical bar swing — wider on volatile days." },
      { snippet: "filter.if = ATR(14) > 0.5", scenario: "Skip very quiet markets where price barely moves." },
    ],
  },
  {
    name: "EMA",
    kind: "call",
    signature: "EMA(period)",
    description: "A trend line that follows price but smooths out the noise — newer prices count more than older ones.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > EMA(50)", scenario: "Only trade when price is above the 50-bar trend line." },
    ],
  },
  {
    name: "SMA",
    kind: "call",
    signature: "SMA(period)",
    description: "Plain average of the last N closes. Treats every bar equally, so it's slower than EMA.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > SMA(200)", scenario: "Only trade in long-term uptrends." },
    ],
  },
  {
    name: "ADX",
    kind: "call",
    signature: "ADX(period)",
    description: "Trend strength score from 0 to 100. Above 25 usually means a real trend; below 20 = drifting/choppy.",
    context: "entry",
    examples: [
      { snippet: "filter.if = ADX(14) > 25", scenario: "Only trade when a real trend is in place." },
    ],
  },
  {
    name: "volume",
    kind: "call",
    signature: "volume(period)",
    description: "Average volume across the last `period` bars. Compare against current `volume` to spot bursts.",
    context: "entry",
    examples: [
      { snippet: "filter.if = volume > volume(20) * 2", scenario: "Only trade when volume is twice the 20-bar average." },
    ],
  },
  {
    name: "trailVol",
    kind: "call",
    signature: "trailVol(period)",
    description: "Same as volume(period) — a different name for trailing-average volume.",
    context: "entry",
  },
  {
    name: "stdev",
    kind: "call",
    signature: "stdev(period)",
    description: "How spread out price returns have been over the last N bars. A volatility gauge.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = stdev(20) * 100", scenario: "Scale your stop to recent return volatility." },
    ],
  },

  // ─── Math passthroughs (work in both contexts) ──────────────────────
  {
    name: "abs",
    kind: "math",
    signature: "abs(x)",
    description: "Makes a negative number positive (and leaves a positive number alone). Useful for distances.",
    context: "both",
    examples: [
      { snippet: "rules.takeProfitPoints = abs(close - EMA50)", scenario: "Distance from price to the 50-bar trend, no matter which side." },
    ],
  },
  {
    name: "min",
    kind: "math",
    signature: "min(a, b, ...)",
    description: "Picks the SMALLEST of the values you give it.",
    context: "both",
    examples: [
      { snippet: "rules.stopLossPoints = min(ATR * 2, 20)", scenario: "Use 2× ATR as the stop, but never bigger than 20 points." },
    ],
  },
  {
    name: "max",
    kind: "math",
    signature: "max(a, b, ...)",
    description: "Picks the LARGEST of the values you give it.",
    context: "both",
    examples: [
      { snippet: "rules.stopLossPoints = max(ticks(4), ATR * 0.5)", scenario: "Stop is at least 4 ticks, or half ATR if that's bigger." },
    ],
  },
  {
    name: "floor",
    kind: "math",
    signature: "floor(x)",
    description: "Rounds down to a whole number (e.g. 2.7 → 2).",
    context: "both",
    examples: [
      { snippet: "rules.timedExitBars = floor(ATR * 5)", scenario: "Convert a volatility-scaled bar count to a whole number for the timed exit." },
    ],
  },
  {
    name: "ceil",
    kind: "math",
    signature: "ceil(x)",
    description: "Rounds up to a whole number (e.g. 2.1 → 3).",
    context: "both",
    examples: [
      { snippet: "rules.timedExitBars = ceil(ATR / 2)", scenario: "Convert a volatility-scaled bar count to a whole number, rounding UP so the exit always covers at least the calculated time." },
    ],
  },
  {
    name: "round",
    kind: "math",
    signature: "round(x)",
    description: "Rounds to the nearest whole number.",
    context: "both",
    examples: [
      { snippet: "rules.stopLossPoints = round(ATR * 1.5)", scenario: "Use 1.5× ATR for the stop, rounded to a whole number of points for cleaner display." },
    ],
  },
  {
    name: "sqrt",
    kind: "math",
    signature: "sqrt(x)",
    description: "Square root.",
    context: "both",
    examples: [
      { snippet: 'print = sqrt(totalPoints), "RMS"', scenario: "Show the square root of total points in the output panel." },
    ],
  },
  {
    name: "log",
    kind: "math",
    signature: "log(x)",
    description: "Natural logarithm. Useful for log-scaling values.",
    context: "both",
    examples: [
      { snippet: 'print = log(totalPoints + 1), "log points"', scenario: "Compress a wide-ranging stat into a log scale for easier reading in the output panel." },
    ],
  },
  {
    name: "exp",
    kind: "math",
    signature: "exp(x)",
    description: "Exponential — e raised to the power x. The inverse of `log`.",
    context: "both",
    examples: [
      { snippet: "rules.takeProfitPoints = exp(ATR * 0.5)", scenario: "Make the target grow exponentially with volatility — small bumps when ATR rises." },
    ],
  },

  // ─── Tick / point helpers — backed by rules.ticksPerPoint, etc. ─────
  {
    name: "ticks",
    kind: "call",
    signature: "ticks(n)",
    description: "Converts a number of ticks into price points. Different futures have different tick sizes — `ticks(4)` = 1 point on NQ, 0.4 on gold, 0.04 on oil. Use this to write instrument-aware scripts.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = ticks(8)", scenario: "An 8-tick stop, automatically scaled to whatever instrument you're on." },
    ],
  },
  {
    name: "point",
    kind: "call",
    signature: "point(n)",
    description: "The reverse of ticks() — turns price points into a count of ticks.",
    context: "entry",
  },
  {
    name: "ticksPerPoint",
    kind: "ident",
    description: "How many ticks make up one full price point on the current instrument (e.g. 4 on NQ).",
    context: "entry",
  },
  {
    name: "pointValue",
    kind: "ident",
    description: "Dollar value of one price point on this instrument.",
    context: "entry",
  },
  {
    name: "tickValue",
    kind: "ident",
    description: "Dollar value of one tick on this instrument.",
    context: "entry",
  },

  // ─── Extended indicator library ─────────────────────────────────────────

  // Moving averages — single-output, period arg.
  {
    name: "WMA",
    kind: "call",
    signature: "WMA(period)",
    description: "Weighted moving average — like SMA but recent bars count more. Faster than SMA, smoother than EMA.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > WMA(20)", scenario: "Trade above a recency-weighted trend line." },
    ],
  },
  {
    name: "HMA",
    kind: "call",
    signature: "HMA(period)",
    description: "Hull Moving Average — designed to follow price quickly without lagging much. Smoother than EMA, faster than SMA.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > HMA(20)", scenario: "Trade with trend using a fast, smooth trend line." },
    ],
  },
  {
    name: "DEMA",
    kind: "call",
    signature: "DEMA(period)",
    description: "Double Exponential MA — a sped-up EMA. Reacts to price changes faster than a plain EMA of the same period.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > DEMA(20)", scenario: "Trade with an EMA that responds extra-quickly." },
    ],
  },
  {
    name: "TEMA",
    kind: "call",
    signature: "TEMA(period)",
    description: "Triple Exponential MA — even faster than DEMA. Use when you want a trend line with very little lag.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > TEMA(20)", scenario: "Trade with a very fast, low-lag trend line." },
    ],
  },
  {
    name: "VWMA",
    kind: "call",
    signature: "VWMA(period)",
    description: "Volume-weighted moving average — bars with more volume count more. Tracks where the real activity has happened.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > VWMA(20)", scenario: "Trade above a volume-weighted trend line." },
    ],
  },

  // Momentum / oscillators.
  {
    name: "RSI",
    kind: "call",
    signature: "RSI(period)",
    description: "Relative Strength Index — a 0–100 score showing how overbought or oversold the market looks. Above 70 = recently a lot of buying. Below 30 = recently a lot of selling. Standard period 14.",
    context: "entry",
    examples: [
      { snippet: "filter.if = RSI(14) < 30", scenario: "Only trade when RSI shows oversold conditions." },
      { snippet: "filter.if = RSI(14) > 50", scenario: "Confirm bullish bias before going long." },
    ],
  },
  {
    name: "RSI",
    kind: "ident",
    description: "Shortcut for RSI(14). See RSI(period) for examples.",
    context: "entry",
  },
  {
    name: "ROC",
    kind: "call",
    signature: "ROC(period)",
    description: "Rate of Change — how much price has changed compared to N bars ago, as a percentage.",
    context: "entry",
    examples: [
      { snippet: "filter.if = ROC(10) > 0", scenario: "Only trade when price is higher than it was 10 bars ago." },
    ],
  },
  {
    name: "MOM",
    kind: "call",
    signature: "MOM(period)",
    description: "Momentum — the raw price change from N bars ago. Positive = price is up; negative = price is down.",
    context: "entry",
    examples: [
      { snippet: "rules.takeProfitPoints = abs(MOM(20)) * 1.5", scenario: "Size your target relative to recent price movement." },
    ],
  },
  {
    name: "CCI",
    kind: "call",
    signature: "CCI(period)",
    description: "Commodity Channel Index — measures how far price has wandered from its average. Above +100 = unusually high; below −100 = unusually low.",
    context: "entry",
    examples: [
      { snippet: "filter.if = CCI(20) > 100", scenario: "Only take longs when price has stretched well above its recent average." },
    ],
  },
  {
    name: "WilliamsR",
    kind: "call",
    signature: "WilliamsR(period)",
    description: "Williams %R — a −100 to 0 score showing where price sits inside its recent range. −20 = near top (overbought), −80 = near bottom (oversold).",
    context: "entry",
    examples: [
      { snippet: "filter.if = WilliamsR(14) < -80", scenario: "Only trade when price is sitting at the bottom of its recent range." },
    ],
  },
  {
    name: "TRIX",
    kind: "call",
    signature: "TRIX(period)",
    description: "Smoothed-out momentum reading — filtered through three averages so noise gets cut. Positive = bullish momentum.",
    context: "entry",
    examples: [
      { snippet: "filter.if = TRIX(14) > 0", scenario: "Only trade when smoothed momentum is positive." },
    ],
  },
  {
    name: "MFI",
    kind: "call",
    signature: "MFI(period)",
    description: "Money Flow Index — like RSI but factors in volume too. A 0–100 score of buying vs selling pressure. Above 80 = strong buying; below 20 = strong selling.",
    context: "entry",
    examples: [
      { snippet: "filter.if = MFI(14) < 20", scenario: "Trade oversold conditions confirmed by volume." },
    ],
  },

  // MACD family — split into separate single-scalar functions.
  {
    name: "MACD_line",
    kind: "call",
    signature: "MACD_line(fast, slow)",
    description: "The MACD line itself — fast trend minus slow trend. Positive and rising = bullish momentum. Standard (12, 26).",
    context: "entry",
    examples: [
      { snippet: "filter.if = MACD_line(12, 26) > 0", scenario: "Only trade when MACD says momentum is bullish." },
    ],
  },
  {
    name: "MACD_signal",
    kind: "call",
    signature: "MACD_signal(fast, slow, signal=9)",
    description: "A smoothed version of the MACD line. When the MACD line crosses above this signal line, that's a classic bullish trigger.",
    context: "entry",
    examples: [
      { snippet: "filter.if = MACD_line(12, 26) > MACD_signal(12, 26)", scenario: "Only take longs after MACD line crosses above its signal." },
    ],
  },
  {
    name: "MACD_hist",
    kind: "call",
    signature: "MACD_hist(fast, slow, signal=9)",
    description: "The gap between the MACD line and its signal — positive and growing = bulls in control.",
    context: "entry",
    examples: [
      { snippet: "filter.if = MACD_hist(12, 26) > 0", scenario: "Trade only when bullish momentum is building." },
    ],
  },

  // Bollinger Bands — split per-band.
  {
    name: "BB_mid",
    kind: "call",
    signature: "BB_mid(period)",
    description: "The middle line of Bollinger Bands — just the simple average over N bars. Default period 20.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > BB_mid(20)", scenario: "Trade only when price is above the middle band." },
    ],
  },
  {
    name: "BB_upper",
    kind: "call",
    signature: "BB_upper(period, mult=2)",
    description: "The upper Bollinger Band — typically 2 standard deviations above the middle. Touching this band suggests price has stretched higher than usual.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > BB_upper(20)", scenario: "Trade breakout setups when price clears the upper band." },
    ],
  },
  {
    name: "BB_lower",
    kind: "call",
    signature: "BB_lower(period, mult=2)",
    description: "The lower Bollinger Band — typically 2 standard deviations below the middle. Touching this band suggests price has stretched lower than usual.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close < BB_lower(20)", scenario: "Mean-reversion: only buy when price has dropped to the lower band." },
    ],
  },
  {
    name: "BB_width",
    kind: "call",
    signature: "BB_width(period, mult=2)",
    description: "How wide the bands are right now. Narrow bands = squeezed, low volatility (often before big moves). Wide bands = noisy, high volatility.",
    context: "entry",
    examples: [
      { snippet: "filter.if = BB_width(20) < 0.05", scenario: "Only trade after a volatility squeeze — bands are tight." },
    ],
  },
  {
    name: "BB_percent",
    kind: "call",
    signature: "BB_percent(period, mult=2)",
    description: "Where price sits inside the bands as a 0–1 score. 0 = bottom, 1 = top, above 1 = busted out the top.",
    context: "entry",
    examples: [
      { snippet: "filter.if = BB_percent(20) > 0.95", scenario: "Take entries only when price is hugging the very top of its band." },
    ],
  },

  // Stochastic.
  {
    name: "Stoch_K",
    kind: "call",
    signature: "Stoch_K(period)",
    description: "Fast stochastic — a 0–100 reading of where price closed within its recent range. Above 80 = overbought, below 20 = oversold.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Stoch_K(14) < 20", scenario: "Trade only when stochastic shows oversold conditions." },
    ],
  },
  {
    name: "Stoch_D",
    kind: "call",
    signature: "Stoch_D(period, smoothK=3, smoothD=3)",
    description: "Slow stochastic — a smoothed version of %K. Used as a signal line; %K crossing above %D is a classic bullish cue.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Stoch_K(14) > Stoch_D(14)", scenario: "Take longs when fast stochastic crosses above slow." },
    ],
  },

  // Donchian channels.
  {
    name: "Donchian_upper",
    kind: "call",
    signature: "Donchian_upper(period)",
    description: "Highest high of the last N bars — the upper edge of the Donchian channel. Same number as HHV(period).",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > Donchian_upper(20)", scenario: "Take longs only on a 20-bar high breakout." },
    ],
  },
  {
    name: "Donchian_lower",
    kind: "call",
    signature: "Donchian_lower(period)",
    description: "Lowest low of the last N bars — the lower edge of the Donchian channel. Same number as LLV(period).",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = close - Donchian_lower(10)", scenario: "Set stop at the 10-bar low." },
    ],
  },
  {
    name: "Donchian_mid",
    kind: "call",
    signature: "Donchian_mid(period)",
    description: "Midpoint of the Donchian channel — the average of the highest high and lowest low over N bars.",
    context: "entry",
  },

  // Volatility.
  {
    name: "TR",
    kind: "ident",
    description: "True Range of the current bar — how big this single bar was, including any gap from yesterday's close. The thing ATR averages.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = TR * 1.5", scenario: "Size your stop based on how big the entry candle was." },
    ],
  },
  {
    name: "TR",
    kind: "call",
    signature: "TR()",
    description: "Same as the bare TR — just the function-call form.",
    context: "entry",
  },
  {
    name: "NATR",
    kind: "call",
    signature: "NATR(period)",
    description: "Normalized ATR — volatility shown as a percent of price. Comparable across different instruments (a 1% wiggle on NQ vs gold means the same thing).",
    context: "entry",
    examples: [
      { snippet: "filter.if = NATR(14) > 0.5", scenario: "Skip days when price wiggle is less than 0.5% — too quiet." },
    ],
  },
  {
    name: "HV",
    kind: "call",
    signature: "HV(period)",
    description: "Historical volatility — how spread out returns have been over the last N bars. Pretty much the same as `stdev(period)`.",
    context: "entry",
  },

  // Volume / cumulative.
  {
    name: "OBV",
    kind: "ident",
    description: "On-Balance Volume — a running tally of volume that adds on up-days and subtracts on down-days. Going up = buyers winning.",
    context: "entry",
    examples: [
      { snippet: "filter.if = OBV > 0", scenario: "(Illustrative) Confirm bullish bias when cumulative OBV is positive." },
    ],
  },
  {
    name: "OBV",
    kind: "call",
    signature: "OBV()",
    description: "Same as the bare OBV — just the function-call form.",
    context: "entry",
  },
  {
    name: "AD",
    kind: "ident",
    description: "Accumulation/Distribution line — like OBV but factors in WHERE in the bar price closed. Used to spot \"smart money\" buying or selling.",
    context: "entry",
  },
  {
    name: "AD",
    kind: "call",
    signature: "AD()",
    description: "Same as the bare AD — just the function-call form.",
    context: "entry",
  },
  {
    name: "CMF",
    kind: "call",
    signature: "CMF(period)",
    description: "Chaikin Money Flow — a −1 to +1 score over N bars. Positive = buying pressure, negative = selling pressure.",
    context: "entry",
    examples: [
      { snippet: "filter.if = CMF(20) > 0.1", scenario: "Only trade when the last 20 bars show clear buying pressure." },
    ],
  },

  // Bar-shape scalars (current-bar derivatives).
  {
    name: "range",
    kind: "ident",
    description: "How tall the current candle is — high minus low.",
    context: "entry",
    examples: [
      { snippet: "rules.takeProfitPoints = range * 2", scenario: "Set the target at twice the entry candle's full range." },
    ],
  },
  {
    name: "body",
    kind: "ident",
    description: "Open-to-close size and direction. Positive = green/up candle; negative = red/down candle.",
    context: "entry",
    examples: [
      { snippet: "filter.if = body > 0", scenario: "Only take longs on green (up) candles." },
    ],
  },
  {
    name: "upper_wick",
    kind: "ident",
    description: "Length of the candle's upper tail — the part above the body.",
    context: "entry",
    examples: [
      { snippet: "filter.if = upper_wick > body", scenario: "Sellers rejected higher prices — long upper wick relative to body." },
    ],
  },
  {
    name: "lower_wick",
    kind: "ident",
    description: "Length of the candle's lower tail — the part below the body.",
    context: "entry",
    examples: [
      { snippet: "filter.if = lower_wick > body", scenario: "Buyers rejected lower prices — long lower wick relative to body." },
    ],
  },
  {
    name: "typical",
    kind: "ident",
    description: "Typical price = average of the high, low, and close. A simple \"summary price\" for the bar.",
    context: "entry",
  },
  {
    name: "median_price",
    kind: "ident",
    description: "The middle of the bar — average of the high and the low.",
    context: "entry",
  },
  {
    name: "weighted_close",
    kind: "ident",
    description: "Like typical price but counts the close more — (high + low + 2×close) / 4.",
    context: "entry",
  },

  // Lookback scalars.
  {
    name: "HHV",
    kind: "call",
    signature: "HHV(period)",
    description: "Highest high of the last N bars (this bar included). Used for breakouts or recent-extreme references.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > HHV(20)", scenario: "Only trade longs that break a 20-bar high." },
    ],
  },
  {
    name: "LLV",
    kind: "call",
    signature: "LLV(period)",
    description: "Lowest low of the last N bars (this bar included). Used for stop placement or breakdown setups.",
    context: "entry",
    examples: [
      { snippet: "rules.stopLossPoints = close - LLV(10)", scenario: "Set the stop at the 10-bar low." },
    ],
  },
  {
    name: "close_n",
    kind: "call",
    signature: "close_n(n)",
    description: "The closing price from N bars ago. close_n(1) is the previous bar's close.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > close_n(1)", scenario: "Only trade when this bar closed higher than the previous bar." },
    ],
  },
  {
    name: "high_n",
    kind: "call",
    signature: "high_n(n)",
    description: "The high from N bars ago.",
    context: "entry",
  },
  {
    name: "low_n",
    kind: "call",
    signature: "low_n(n)",
    description: "The low from N bars ago.",
    context: "entry",
  },
  {
    name: "open_n",
    kind: "call",
    signature: "open_n(n)",
    description: "The open from N bars ago.",
    context: "entry",
  },
  {
    name: "volume_n",
    kind: "call",
    signature: "volume_n(n)",
    description: "The volume from N bars ago.",
    context: "entry",
    examples: [
      { snippet: "filter.if = volume > volume_n(1) * 2", scenario: "Only trade when this bar's volume was double the previous bar's." },
    ],
  },

  // ─── Order flow / bid-ask (require tick or ohlcv_bidask granularity) ─
  {
    name: "bar_volume_bid",
    kind: "ident",
    description: "Sell-aggressor volume — how much of this bar's volume came from traders selling at the bid (hitting bids). Needs bid/ask data; blank without it.",
    context: "entry",
    examples: [
      { snippet: "filter.if = bar_volume_ask > bar_volume_bid", scenario: "Only take longs when buyers (lifting offers) outpaced sellers (hitting bids) on this bar." },
    ],
  },
  {
    name: "bar_volume_ask",
    kind: "ident",
    description: "Buy-aggressor volume — how much of this bar's volume came from traders buying at the ask (lifting offers). Needs bid/ask data; blank without it.",
    context: "entry",
    examples: [
      { snippet: "filter.if = bar_volume_ask > volume * 0.6", scenario: "Trade longs only when at least 60% of this bar's volume hit the ask — clear buy pressure." },
    ],
  },
  {
    name: "buy_volume",
    kind: "ident",
    description: "Same as bar_volume_ask — the friendlier name for buy-aggressor volume on this bar.",
    context: "entry",
    examples: [
      { snippet: "filter.if = buy_volume > sell_volume * 1.5", scenario: "Take longs when buy-aggressor volume is at least 50% larger than sell-aggressor volume." },
    ],
  },
  {
    name: "sell_volume",
    kind: "ident",
    description: "Same as bar_volume_bid — the friendlier name for sell-aggressor volume on this bar.",
    context: "entry",
    examples: [
      { snippet: "filter.if = sell_volume < buy_volume", scenario: "Only trade longs when sellers were the smaller side on the entry bar." },
    ],
  },
  {
    name: "delta",
    kind: "ident",
    description: "Net order-flow on this bar — buy-aggressor minus sell-aggressor volume. Positive = buyers leaning in; negative = sellers leaning in.",
    context: "entry",
    examples: [
      { snippet: "filter.if = delta > 0", scenario: "Only take longs when this bar had more aggressive buying than selling." },
    ],
  },
  {
    name: "delta_ratio",
    kind: "ident",
    description: "Delta as a −1 to +1 score, normalized by total volume. +1 = pure buy aggression, −1 = pure sell aggression.",
    context: "entry",
    examples: [
      { snippet: "filter.if = delta_ratio > 0.3", scenario: "Only take longs when buy-aggression dominated this bar." },
    ],
  },
  {
    name: "buy_pressure",
    kind: "ident",
    description: "What fraction of this bar's volume was buy-aggressor — a 0 to 1 score. 0.5 = balanced; above 0.7 = mostly buyers.",
    context: "entry",
    examples: [
      { snippet: "filter.if = buy_pressure > 0.7", scenario: "Take longs only when at least 70% of the bar's volume was buyers." },
    ],
  },
  {
    name: "CVD",
    kind: "ident",
    description: "Cumulative Volume Delta — a running tally of bar deltas across the session. Going up = buyers leaning in over time; going down = sellers leaning in. Needs bid/ask data.",
    context: "entry",
    examples: [
      { snippet: "filter.if = CVD > 0", scenario: "Trade longs only when the session's running buy/sell tally is positive." },
    ],
  },
  {
    name: "CVD",
    kind: "call",
    signature: "CVD()",
    description: "Same as the bare CVD — just the function-call form.",
    context: "entry",
  },

  // ─── Trend / channels ────────────────────────────────────────────────
  {
    name: "Keltner_mid",
    kind: "call",
    signature: "Keltner_mid(period)",
    description: "The middle line of the Keltner Channel — an EMA over N bars. Default period 20.",
    context: "entry",
  },
  {
    name: "Keltner_upper",
    kind: "call",
    signature: "Keltner_upper(period, mult=2)",
    description: "Upper Keltner band — middle line plus a multiple of ATR. Tracks trends well because it doesn't shrink during one-sided moves.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > Keltner_upper(20)", scenario: "Take longs only when price has broken the upper Keltner band — strong trend." },
    ],
  },
  {
    name: "Keltner_lower",
    kind: "call",
    signature: "Keltner_lower(period, mult=2)",
    description: "Lower Keltner band — middle line minus a multiple of ATR.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close < Keltner_lower(20)", scenario: "Mean-reversion buys when price is below the lower Keltner band." },
    ],
  },
  {
    name: "Supertrend",
    kind: "call",
    signature: "Supertrend(period=10, mult=3)",
    description: "A single line that flips above and below price as the trend changes. Positive value = uptrend, negative = downtrend. Easy way to gate long vs short.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Supertrend > 0", scenario: "Only take longs when Supertrend says we're in an uptrend." },
    ],
  },
  {
    name: "PSAR",
    kind: "call",
    signature: "PSAR(step=0.02, max=0.2)",
    description: "Parabolic SAR — those little dots on a chart. When dots are below price = uptrend, above = downtrend. Often used as a trailing stop.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > PSAR()", scenario: "Only trade longs when price is above the PSAR dots." },
    ],
  },

  // ─── Ichimoku family ─────────────────────────────────────────────────
  {
    name: "Ichimoku_tenkan",
    kind: "call",
    signature: "Ichimoku_tenkan(period=9)",
    description: "Tenkan (conversion) line — fast trend midpoint of the last 9 bars by default.",
    context: "entry",
  },
  {
    name: "Ichimoku_kijun",
    kind: "call",
    signature: "Ichimoku_kijun(period=26)",
    description: "Kijun (base) line — slow trend midpoint of the last 26 bars by default. Often used like an EMA for trend bias.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > Ichimoku_kijun(26)", scenario: "Only take longs when price is above the Ichimoku base line." },
    ],
  },
  {
    name: "Ichimoku_senkouA",
    kind: "call",
    signature: "Ichimoku_senkouA(fast=9, slow=26)",
    description: "Top edge of the Ichimoku cloud — the average of Tenkan and Kijun. (Backtest-safe: no peeking into the future.)",
    context: "entry",
  },
  {
    name: "Ichimoku_senkouB",
    kind: "call",
    signature: "Ichimoku_senkouB(period=52)",
    description: "Bottom edge of the Ichimoku cloud — slow trend midpoint over 52 bars.",
    context: "entry",
  },
  {
    name: "Ichimoku_chikou",
    kind: "call",
    signature: "Ichimoku_chikou(period=26)",
    description: "Lagging Chikou line. Returns the current close in this build — for past-comparisons use `close_n(period)`.",
    context: "entry",
  },

  // ─── Momentum (extended) ─────────────────────────────────────────────
  {
    name: "Aroon_up",
    kind: "call",
    signature: "Aroon_up(period=14)",
    description: "How fresh the recent high is, on a 0–100 scale. 100 = a new high JUST happened. 0 = the high is old news.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Aroon_up(14) > 80", scenario: "Only take longs right after a fresh new 14-bar high." },
    ],
  },
  {
    name: "Aroon_down",
    kind: "call",
    signature: "Aroon_down(period=14)",
    description: "How fresh the recent low is, 0–100. 100 = brand-new low; 0 = old news.",
    context: "entry",
  },
  {
    name: "Aroon_osc",
    kind: "call",
    signature: "Aroon_osc(period=14)",
    description: "Aroon Up minus Aroon Down — a −100 to +100 trend score. Positive = uptrend, negative = downtrend.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Aroon_osc(14) > 0", scenario: "Only trade in the direction of the Aroon-defined trend." },
    ],
  },
  {
    name: "VortexPlus",
    kind: "call",
    signature: "VortexPlus(period=14)",
    description: "Bullish Vortex line — when this crosses above VortexMinus, momentum has flipped bullish.",
    context: "entry",
    examples: [
      { snippet: "filter.if = VortexPlus(14) > VortexMinus(14)", scenario: "Only take longs when bullish Vortex is dominant." },
    ],
  },
  {
    name: "VortexMinus",
    kind: "call",
    signature: "VortexMinus(period=14)",
    description: "Bearish Vortex line — when this crosses above VortexPlus, momentum has flipped bearish.",
    context: "entry",
  },
  {
    name: "DIplus",
    kind: "call",
    signature: "DIplus(period=14)",
    description: "The bullish half of ADX. Above DIminus = uptrend.",
    context: "entry",
    examples: [
      { snippet: "filter.if = DIplus(14) > DIminus(14) && ADX > 25", scenario: "Take longs only in a strong uptrend (direction + strength both confirmed)." },
    ],
  },
  {
    name: "DIminus",
    kind: "call",
    signature: "DIminus(period=14)",
    description: "The bearish half of ADX. Above DIplus = downtrend.",
    context: "entry",
  },
  {
    name: "AO",
    kind: "ident",
    description: "Awesome Oscillator — Bill Williams' momentum indicator built on median-price averages. Positive = bullish momentum.",
    context: "entry",
    examples: [
      { snippet: "filter.if = AO > 0", scenario: "Only trade longs when AO is positive." },
    ],
  },
  {
    name: "AO",
    kind: "call",
    signature: "AO()",
    description: "Same as the bare AO — just the function-call form.",
    context: "entry",
  },
  {
    name: "UO",
    kind: "call",
    signature: "UO(short=7, mid=14, long=28)",
    description: "Ultimate Oscillator — a 0–100 score that blends buying-pressure across three time windows. Above 70 = strongly bullish across all windows.",
    context: "entry",
    examples: [
      { snippet: "filter.if = UO(7, 14, 28) > 70", scenario: "Only trade in clearly-buying conditions across multiple time scales." },
    ],
  },
  {
    name: "Fisher",
    kind: "call",
    signature: "Fisher(period=10)",
    description: "Fisher Transform — reshapes price action so extreme moves stand out clearly. Readings beyond ±2 are very rare and often mark turning points.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Fisher(10) < -2", scenario: "Take longs only at statistically rare oversold extremes." },
    ],
  },

  // ─── Volatility / regime ────────────────────────────────────────────
  {
    name: "Choppiness",
    kind: "call",
    signature: "Choppiness(period=14)",
    description: "0–100 score saying whether the market is trending or chopping. Above 62 = sideways chop; below 38 = real trend.",
    context: "entry",
    examples: [
      { snippet: "filter.if = Choppiness(14) < 38", scenario: "Only trade when the market is trending; skip the chop." },
    ],
  },
  {
    name: "Ulcer",
    kind: "call",
    signature: "Ulcer(period=14)",
    description: "Downside-only volatility gauge — measures how deep recent drawdowns have been. Higher = more painful pullbacks.",
    context: "entry",
  },

  // ─── Statistical ────────────────────────────────────────────────────
  {
    name: "Zscore",
    kind: "call",
    signature: "Zscore(period)",
    description: "How many standard deviations price is above or below its average. Big positive = extremely high; big negative = extremely low. Mean-reversion gold.",
    context: "entry",
    examples: [
      { snippet: "filter.if = abs(Zscore(20)) > 2", scenario: "Only trade when price is unusually far from its 20-bar average." },
    ],
  },
  {
    name: "LRSlope",
    kind: "call",
    signature: "LRSlope(period)",
    description: "The slope of a best-fit straight line through the last N closes. Positive = trending up; negative = trending down.",
    context: "entry",
    examples: [
      { snippet: "filter.if = LRSlope(50) > 0", scenario: "Only take longs when the 50-bar trend line is sloping up." },
    ],
  },
  {
    name: "LRIntercept",
    kind: "call",
    signature: "LRIntercept(period)",
    description: "Where the best-fit trend line would cross at the start of the window. Mostly used internally by other regression-based math.",
    context: "entry",
  },
  {
    name: "LRValue",
    kind: "call",
    signature: "LRValue(period)",
    description: "What the best-fit trend line says price \"should\" be right now. Compare against actual price for over/undershooting setups.",
    context: "entry",
  },
  {
    name: "R2",
    kind: "call",
    signature: "R2(period)",
    description: "How clean the trend is, on a 0–1 scale. Close to 1 = a tight, smooth trend; close to 0 = noisy, no clear direction.",
    context: "entry",
    examples: [
      { snippet: "filter.if = LRSlope(50) > 0 && R2(50) > 0.7", scenario: "Only trade in clean, well-defined uptrends." },
    ],
  },

  // ─── Volume (extended) ──────────────────────────────────────────────
  {
    name: "VWAP",
    kind: "call",
    signature: "VWAP(period)",
    description: "Rolling N-bar Volume-Weighted Average Price — a \"fair value\" line where high-volume bars count more.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > VWAP(50)", scenario: "Only take longs when price is above the 50-bar fair-value line." },
    ],
  },
  {
    name: "KVO",
    kind: "call",
    signature: "KVO(fast=34, slow=55)",
    description: "Klinger Volume Oscillator — a momentum reading that includes volume. Positive = bullish flow.",
    context: "entry",
  },
  {
    name: "ForceIndex",
    kind: "call",
    signature: "ForceIndex(period=13)",
    description: "Elder's Force Index — combines price change and volume into one momentum reading. Positive and rising = strong buying.",
    context: "entry",
  },
  {
    name: "EMV",
    kind: "call",
    signature: "EMV(period=14)",
    description: "Ease of Movement — measures how easily price moved with the volume it had. High = price moved a lot on low volume (easy moves).",
    context: "entry",
  },
  {
    name: "NVI",
    kind: "ident",
    description: "Negative Volume Index — only updates on quieter days (volume down). Used to track \"smart money\" footprints. Seeded at 1000.",
    context: "entry",
  },
  {
    name: "NVI",
    kind: "call",
    signature: "NVI()",
    description: "Same as bare NVI — just the function-call form.",
    context: "entry",
  },
  {
    name: "PVI",
    kind: "ident",
    description: "Positive Volume Index — only updates on busier days (volume up). Used to track \"crowd\" behavior. Seeded at 1000.",
    context: "entry",
  },
  {
    name: "PVI",
    kind: "call",
    signature: "PVI()",
    description: "Same as bare PVI — just the function-call form.",
    context: "entry",
  },

  // ─── Volume profile (rolling N-bar window — REQUIRES tick session) ──
  {
    name: "POC",
    kind: "call",
    signature: "POC(N, area=0.7)",
    description: "Point of Control — the price level where the most trading happened over the last N bars. Often acts like a magnet for price. NEEDS a tick session.",
    context: "entry",
    examples: [
      { snippet: "rules.takeProfitPoints = abs(close - POC(20))", scenario: "Aim profit at the most-traded price level — a natural mean-reversion target." },
    ],
  },
  {
    name: "VAH",
    kind: "call",
    signature: "VAH(N, area=0.7)",
    description: "Value Area High — top of the price range that contains 70% of trading. Above VAH = price has stretched above fair value. Needs ticks.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close < VAH(20)", scenario: "Only trade when price is still inside the value area (under the top edge)." },
    ],
  },
  {
    name: "VAL",
    kind: "call",
    signature: "VAL(N, area=0.7)",
    description: "Value Area Low — bottom of the price range that contains 70% of trading. Below VAL = price has stretched below fair value. Needs ticks.",
    context: "entry",
    examples: [
      { snippet: "filter.if = close > VAL(20)", scenario: "Only trade above the lower edge of the recent value zone." },
    ],
  },
  {
    name: "VA_width",
    kind: "call",
    signature: "VA_width(N, area=0.7)",
    description: "How wide the value area is. Narrow = balanced/compressed market (often before big moves). Wide = active, transitioning. Needs ticks.",
    context: "entry",
  },
  {
    name: "dist_to_POC",
    kind: "call",
    signature: "dist_to_POC(N, area=0.7)",
    description: "How far current price is from the POC, as a fraction. Negative = below POC, positive = above. Needs ticks.",
    context: "entry",
  },

  // ─── Tick microstructure (REQUIRES tick session) ────────────────────
  {
    name: "trades_at_bid",
    kind: "call",
    signature: "trades_at_bid(N)",
    description: "How many trades hit the bid (sell-aggressor) over the last N bars. Counts trades, not contracts. Needs ticks.",
    context: "entry",
  },
  {
    name: "trades_at_ask",
    kind: "call",
    signature: "trades_at_ask(N)",
    description: "How many trades lifted the ask (buy-aggressor) over the last N bars. Needs ticks.",
    context: "entry",
  },
  {
    name: "tick_imbalance",
    kind: "call",
    signature: "tick_imbalance(N)",
    description: "Buyer-vs-seller score over the last N bars, from −1 (all sellers) to +1 (all buyers).",
    context: "entry",
    examples: [
      { snippet: "filter.if = tick_imbalance(5) > 0.3", scenario: "Only take longs when buyers have been clearly aggressive over the last 5 bars." },
    ],
  },
  {
    name: "tick_count",
    kind: "call",
    signature: "tick_count(N)",
    description: "Total number of trades over the last N bars. High = busy/chaotic market. Needs ticks.",
    context: "entry",
  },
  {
    name: "mean_trade_size",
    kind: "call",
    signature: "mean_trade_size(N)",
    description: "Average size of each trade (in contracts) over the last N bars. Useful for spotting whether activity is retail or institutional. Needs ticks.",
    context: "entry",
  },
  {
    name: "large_trade_count",
    kind: "call",
    signature: "large_trade_count(N, threshold)",
    description: "How many trades over the last N bars were at least `threshold` contracts in size. Spots big-block prints. Needs ticks.",
    context: "entry",
    examples: [
      { snippet: "filter.if = large_trade_count(5, 50) >= 3", scenario: "Only trade after at least 3 big-size prints (50+ contracts) hit in the last 5 bars." },
    ],
  },
  {
    name: "vwap_tick",
    kind: "call",
    signature: "vwap_tick(N)",
    description: "True VWAP built from raw individual trades — finer than VWAP(N) which uses bar averages. Needs ticks.",
    context: "entry",
  },

  // ─── Kalman-filtered Ornstein-Uhlenbeck (strategy-DSL only) ─────────
  // Member access (`kf.x`, `kf.sigma`, …) is implemented by a parse-time
  // rewrite in parseStrategyScript — it only fires for `let X = KALMAN_OU(...)`
  // bindings inside a strategy script. Standalone use in a filter.if is
  // not supported (the rewrite needs the let context to identify the
  // binding name).
  {
    name: "KALMAN_OU",
    kind: "call",
    signature: "KALMAN_OU(source, calib=60, trust=0.5)",
    description: "Kalman-filtered Ornstein-Uhlenbeck mean-reversion estimator. STRATEGY DSL ONLY — must be assigned to a `let` and accessed via member syntax. SIX fields: `kf.x_pred` (PRE-fit OU prediction — the model's forecast for THIS bar given everything known before it opens; use this as the divisor baseline for honest innovation z-scores), `kf.x` (POST-fit posterior — already absorbed THIS bar's close into its smoothing; great for `where is fair value RIGHT NOW`, biased as a divisor because `(close - kf.x)` has the bar baked into both terms), `kf.mu` (rolling long-run mean), `kf.sigma` (rolling long-run unconditional std), `kf.phi` (rolling AR(1) persistence), `kf.P` (current posterior variance). `source` is one of close/open/high/low/typical/median_price/weighted_close. `calib` is the rolling calibration window in bars (must be a literal). `trust` ∈ (0,1) sets the steady-state Kalman gain — small = heavy smoothing toward the OU prediction, large = closer to raw price. Calibration is ROLLING — every bar refits (mu, phi, sigma) from the immediately preceding `calib` bars, so the filter is fully out-of-sample and adapts to regime shifts. All six fields share one filter pass per (source, calib, trust) tuple via a shared bundle cache.",
    context: "entry",
    examples: [
      {
        snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nlet z = (close - kf.x_pred) / kf.sigma\nsignal.long.if = cross_down(z, -params.entryZ)\nexit.long.if = cross_up(close, kf.x_pred)",
        scenario: "Honest mean-reversion: enter when price is more than entryZ stds below the OU PREDICTION (using x_pred makes the z-score the real innovation, not a half-bar-baked-in residual). Exit when price reclaims the prediction.",
      },
      {
        snippet: "let kf = KALMAN_OU(typical, 90, 0.3)\nontrade.print = kf.x, \"x_post\"\nontrade.print = kf.x_pred, \"x_pre\"",
        scenario: "Side-by-side check: x_post tracks the bar's close more closely (it absorbed it); x_pred is what the OU model predicted before seeing the bar. The gap (close - x_pred) is the real innovation.",
      },
    ],
  },
];

/** Identifiers available in summary (`print = ...`) context. */
export const SUMMARY_SYMBOLS: ExprSymbol[] = [
  {
    name: "winRate",
    kind: "ident",
    description:
      "How often you won, as a fraction between 0 and 1. So 0.55 means you won 55% of the time. Multiply by 100 for a percent.",
    context: "summary",
    examples: [
      {
        snippet: 'print = winRate * 100, "Win %"',
        scenario: 'Show "Win %: 55" in the Output panel after the backtest.',
      },
    ],
  },
  {
    name: "profitFactor",
    kind: "ident",
    description:
      "Total points won divided by total points lost. Above 1 means you made more than you lost. Above 2 is generally considered very strong.",
    context: "summary",
    examples: [
      {
        snippet: 'print = profitFactor, "PF"',
        scenario: 'Show "PF: 1.85" — strategy made $1.85 for every $1 lost.',
      },
    ],
  },
  {
    name: "avgRR",
    kind: "ident",
    description:
      "Average risk-to-reward ratio you actually got across all trades. 2 means your average win was twice as big as your average loss.",
    context: "summary",
    examples: [
      {
        snippet: 'print = avgRR, "Avg R:R"',
        scenario: 'Show the realized risk-to-reward ratio in the Output panel.',
      },
    ],
  },
  {
    name: "totalPnl",
    kind: "ident",
    description:
      "Total profit or loss for the whole backtest, in points. Same as `totalPoints` — they're aliases.",
    context: "summary",
    examples: [
      {
        snippet: 'print = totalPnl, "Total points"',
        scenario: 'Show the total points captured by the strategy.',
      },
    ],
  },
  {
    name: "totalPoints",
    kind: "ident",
    description:
      "Total points captured across every trade. Alias for `totalPnl`.",
    context: "summary",
    examples: [
      {
        snippet: 'print = totalPoints, "Total points"',
        scenario: 'Show the total points captured by the strategy across the whole run.',
      },
    ],
  },
  {
    name: "expectancy",
    kind: "ident",
    description:
      "Average expected points per trade, factoring in your win rate and average win/loss size. Positive = profitable on average.",
    context: "summary",
    examples: [
      {
        snippet: 'print = expectancy, "Expected $/trade"',
        scenario: 'Show what you make on average per trade, accounting for both wins and losses.',
      },
    ],
  },
  {
    name: "expectancyPerSize",
    kind: "ident",
    description:
      "Same as expectancy but per single contract (ignores any position sizing). Useful for comparing strategies that trade different sizes.",
    context: "summary",
    examples: [
      {
        snippet: 'print = expectancyPerSize, "Pts/trade (1 contract)"',
        scenario: "Show expected points per trade as if every trade were a single contract — the apples-to-apples comparison number.",
      },
    ],
  },
  {
    name: "avgPoints",
    kind: "ident",
    description: "Average points per trade across the whole run, with sizing applied.",
    context: "summary",
    examples: [
      {
        snippet: 'print = avgPoints, "Avg pts/trade"',
        scenario: 'Show your average points-per-trade after sizing.',
      },
    ],
  },
  {
    name: "avgWinPoints",
    kind: "ident",
    description: "Average points on the trades you won (the typical winner size).",
    context: "summary",
    examples: [
      {
        snippet: 'print = avgWinPoints, "Avg winner"',
        scenario: 'Show the typical size of a winning trade.',
      },
    ],
  },
  {
    name: "avgLossPoints",
    kind: "ident",
    description:
      "Average points on the trades you lost — comes out as a negative number.",
    context: "summary",
    examples: [
      {
        snippet: 'print = avgLossPoints, "Avg loser"',
        scenario: 'Show the typical size of a losing trade (will be negative).',
      },
    ],
  },
  {
    name: "avgBarsHeld",
    kind: "ident",
    description:
      "How many bars (candles) the average trade was held for, from entry to exit. Tells you if you're a quick scalper or a long holder.",
    context: "summary",
    examples: [
      {
        snippet: 'print = avgBarsHeld, "Avg bars held"',
        scenario: 'Show the typical trade duration in bars.',
      },
    ],
  },
  {
    name: "avgtradetime",
    kind: "ident",
    description: "Alias for `avgBarsHeld` — same number, different name.",
    context: "summary",
  },
  {
    name: "dailyEv",
    kind: "ident",
    description: "Average points made per trading day across the run.",
    context: "summary",
    examples: [
      {
        snippet: 'print = dailyEv, "Avg pts/day"',
        scenario: 'Show how many points the strategy makes on a typical day.',
      },
    ],
  },
  {
    name: "tradingDays",
    kind: "ident",
    description: "How many separate days produced at least one trade.",
    context: "summary",
    examples: [
      {
        snippet: 'print = tradingDays, "Days"',
        scenario: 'Show how many trading days the backtest covered.',
      },
    ],
  },
  {
    name: "avgTradesPerHour",
    kind: "ident",
    description: "How many trades fired per hour while sessions were active.",
    context: "summary",
    examples: [
      {
        snippet: 'print = avgTradesPerHour, "Trades/hr"',
        scenario: 'See how busy your strategy is — high numbers mean lots of activity.',
      },
    ],
  },
  {
    name: "sharpeOriginal",
    kind: "ident",
    description:
      "Sharpe ratio (a smoothness score) on the original zone results, BEFORE any rules-based adjustments. Higher = steadier results.",
    context: "summary",
    examples: [
      {
        snippet: 'print = sharpeSimulated - sharpeOriginal, "Sharpe lift"',
        scenario: 'Show how much your rules.* (stops, targets, etc.) improved or hurt the smoothness compared to the raw zone signal.',
      },
    ],
  },
  {
    name: "sharpeSimulated",
    kind: "ident",
    description:
      "Sharpe ratio AFTER your rules.* (stops, take-profits, etc.) have been applied. Compare against `sharpeOriginal` to see whether your rules helped or hurt the smoothness.",
    context: "summary",
    examples: [
      {
        snippet: 'print = sharpeSimulated, "Sharpe"',
        scenario: 'Show the smoothness/consistency score with your rules applied.',
      },
    ],
  },
  {
    name: "totalTrades",
    kind: "ident",
    description: "Total number of trades the strategy fired.",
    context: "summary",
    examples: [
      {
        snippet: 'print = totalTrades, "Total trades"',
        scenario: 'Show how many trades happened in the run.',
      },
    ],
  },
  {
    name: "winners",
    kind: "ident",
    description: "Number of trades that were winners.",
    context: "summary",
    examples: [
      {
        snippet: 'print = winners, "Wins"',
        scenario: 'Show the count of winning trades.',
      },
    ],
  },
  {
    name: "losers",
    kind: "ident",
    description: "Number of trades that were losers.",
    context: "summary",
    examples: [
      {
        snippet: 'print = losers, "Losses"',
        scenario: 'Show the count of losing trades.',
      },
    ],
  },
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

/** Scan `text` for inline `Optimize.<Obj>.<Unit>(...)` directives and
 *  rewrite each into a synthetic ident chosen by the caller. The caller's
 *  `registerSpec` callback receives the parsed numeric OptimizeSpec and
 *  returns the synthetic ident string to splice in — so the caller owns
 *  naming and storage (line-based DSL uses `__opt_<n>__` + the partial
 *  config; strategy DSL uses `__sopt_<n>__` + a parser-local map). The
 *  two prefixes never collide because each scan uses an independent
 *  counter.
 *
 *  Lifting is paren-aware (commas inside Optimize args don't terminate
 *  the call) and string-aware (an `Optimize.` substring inside a quoted
 *  print label is left alone). Only fires on `Optimize.` preceded by a
 *  non-identifier char so `MyOptimize.X` won't false-match. Trailing
 *  `default <num>` and `smooth <N>` clauses are consumed as part of the
 *  lifted slice — anything `parseOptimizeSpec` would accept is captured. */
export function scanInlineOptimize(
  text: string,
  registerSpec: (spec: OptimizeSpec) => string
): { ok: true; text: string } | { ok: false; error: string } {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      // Skip over string literals so quoted text doesn't get scanned.
      // Honors `\"` escapes (the only ones the rest of the parser handles).
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '"' && text[j - 1] !== "\\") { end = j; break; }
      }
      if (end < 0) {
        // Unterminated — let the downstream parser flag it. Pass through.
        out += text.slice(i);
        break;
      }
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const atIdentStart = i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]);
    if (
      atIdentStart &&
      i + 9 <= text.length &&
      text.slice(i, i + 9).toLowerCase() === "optimize."
    ) {
      let j = i;
      while (j < text.length && text[j] !== "(") j++;
      if (j === text.length) {
        return {
          ok: false,
          error: `inline Optimize at position ${i}: expected "(" after "Optimize.<Obj>.<Unit>"`,
        };
      }
      let depth = 1;
      let inStr = false;
      let k = j + 1;
      while (k < text.length && depth > 0) {
        const c = text[k];
        if (c === '"' && text[k - 1] !== "\\") inStr = !inStr;
        if (!inStr) {
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        k++;
      }
      if (depth !== 0) {
        return { ok: false, error: `inline Optimize at position ${i}: unbalanced parens` };
      }
      const SMOOTH_PAREN = /^\s*smooth\s*\(\s*\d+\s*\)/i;
      const SMOOTH_BARE = /^\s*smooth\s+\d+/i;
      const DEFAULT_PAREN = /^\s*default\s*\(\s*-?\d+\.?\d*(?:[eE][+-]?\d+)?\s*\)/i;
      const DEFAULT_BARE = /^\s*default\s+-?\d+\.?\d*(?:[eE][+-]?\d+)?/i;
      let sawSmooth = false;
      let sawDefault = false;
      for (let pass = 0; pass < 2; pass++) {
        const tail = text.slice(k);
        if (!sawSmooth) {
          const m = tail.match(SMOOTH_PAREN) || tail.match(SMOOTH_BARE);
          if (m) { k += m[0].length; sawSmooth = true; continue; }
        }
        if (!sawDefault) {
          const m = tail.match(DEFAULT_PAREN) || tail.match(DEFAULT_BARE);
          if (m) { k += m[0].length; sawDefault = true; continue; }
        }
        break;
      }
      const slice = text.slice(i, k);
      const r = parseOptimizeSpec(slice);
      if (!r.ok) {
        return { ok: false, error: `inline Optimize: ${r.error}` };
      }
      if (r.spec.kind === "optimize-categorical") {
        return {
          ok: false,
          error: `inline Optimize: categorical form (option list) isn't supported inside expressions — only numeric Optimize.X.Y(lookback, min, max[, step])`,
        };
      }
      out += registerSpec(r.spec);
      i = k;
    } else {
      out += text[i];
      i++;
    }
  }
  return { ok: true, text: out };
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
  // Extended indicators that internally rely on Wilder smoothing or
  // chained smoothing — sized at 2*period to cover the worst case.
  "DIplus",
  "DIminus",
  "Keltner_upper",
  "Keltner_lower",
  "Supertrend",
  "ForceIndex",
  "Choppiness",
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
    // PSAR's first arg is the acceleration step (0.02), not a period —
    // it doesn't need a meaningful warmup window. Skip its sizing here
    // so a script using PSAR doesn't pull a 1-bar pre-entry window.
    if (r.name === "PSAR") continue;
    // For Ichimoku, the SLOW window is the warmup driver — Senkou A
    // uses both fast and slow but is dominated by `slow`. Take the
    // larger of the two when both are present.
    let effPeriod = period;
    if (r.name === "Ichimoku_senkouA" && Number.isFinite(r.args[1])) {
      effPeriod = Math.max(period, r.args[1]);
    }
    // KVO's SLOW EMA is the warmup driver, not the FAST.
    if (r.name === "KVO" && Number.isFinite(r.args[1])) {
      effPeriod = r.args[1];
    }
    // UO's LONG window dominates.
    if (r.name === "UO" && Number.isFinite(r.args[2])) {
      effPeriod = r.args[2];
    }
    // KALMAN_OU's args are [source, calib, trust] — args[0] is the
    // source code (1..7), not a period. The calibration window
    // (args[1]) is the warmup driver: the filter emits NaN until bar
    // `calib - 1`, so we need at least that many pre-entry bars.
    if (
      r.name === "KALMAN_OU_x" || r.name === "KALMAN_OU_mu" ||
      r.name === "KALMAN_OU_sigma" || r.name === "KALMAN_OU_phi" ||
      r.name === "KALMAN_OU_P" || r.name === "KALMAN_OU_x_pred"
    ) {
      effPeriod = Number.isFinite(r.args[1]) ? r.args[1] : 60;
    }
    const needed = WILDER_FAMILY.has(r.name) ? effPeriod * 2 : effPeriod;
    if (needed > max) max = needed;
  }
  return max;
}

/** Compute a single indicator series by name. Centralized so the
 *  simulator and any future caller share the same dispatch. Returns
 *  null for unrecognized names (indicator key not in the catalog).
 *
 *  `tickCtx` is required by the tick-resolution indicators
 *  (volume-profile family, trades_at_bid/ask, vwap_tick, etc.).
 *  When the session has no tick data, callers pass `undefined` and
 *  `tickCtx`-required indicators return all-NaN gracefully — scripts
 *  still compile, but those values evaluate to NaN at the entry bar.
 *
 *  `profileCache` is an optional shared cache for the volume-profile
 *  family — POC(20), VAH(20), VAL(20) over the same window all reuse
 *  one profile build. The caller (precomputeIndicators) creates one
 *  cache per zone and passes it through; pass `null` if you don't want
 *  caching (each call builds its own).
 */
export function computeIndicatorSeries(
  name: string,
  args: number[],
  bars: IndicatorBar[],
  tickCtx?: TickContext,
  profileCache?: ProfileCache | null,
  kalmanCache?: KalmanOuCache | null,
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

    // ─── Order flow / bid-ask ────────────────────────────────────────
    // CVD is cumulative — zero-arg from gatherRequiredSeries' point
    // of view. The `delta`, `delta_ratio`, `buy_pressure` series helpers
    // are not currently exposed as zero-arg call forms because the
    // bare-ident path (resolveIdent) already serves them; if a script
    // wants the postfix `[N]` index form, it can use `delta_n(N)`-style
    // future additions.
    case "CVD":
      return cvdSeries(bars);

    // ─── Trend / channels ────────────────────────────────────────────
    case "Keltner_mid":
      return keltnerMidSeries(bars, args[0]);
    case "Keltner_upper":
      return keltnerUpperSeries(bars, args[0], args[1]);
    case "Keltner_lower":
      return keltnerLowerSeries(bars, args[0], args[1]);
    case "Supertrend":
      return supertrendSeries(bars, args[0], args[1]);
    case "PSAR":
      return psarSeries(bars, args[0], args[1]);

    // ─── Ichimoku family ─────────────────────────────────────────────
    case "Ichimoku_tenkan":
      return ichimokuTenkanSeries(bars, args[0]);
    case "Ichimoku_kijun":
      return ichimokuKijunSeries(bars, args[0]);
    case "Ichimoku_senkouA":
      return ichimokuSenkouASeries(bars, args[0], args[1]);
    case "Ichimoku_senkouB":
      return ichimokuSenkouBSeries(bars, args[0]);
    case "Ichimoku_chikou":
      return ichimokuChikouSeries(bars, args[0]);

    // ─── Momentum (extended) ─────────────────────────────────────────
    case "Aroon_up":
      return aroonUpSeries(bars, args[0]);
    case "Aroon_down":
      return aroonDownSeries(bars, args[0]);
    case "Aroon_osc":
      return aroonOscSeries(bars, args[0]);
    case "VortexPlus":
      return vortexPlusSeries(bars, args[0]);
    case "VortexMinus":
      return vortexMinusSeries(bars, args[0]);
    case "DIplus":
      return diPlusSeries(bars, args[0]);
    case "DIminus":
      return diMinusSeries(bars, args[0]);
    case "AO":
      return aoSeries(bars);
    case "UO":
      return uoSeries(bars, args[0], args[1], args[2]);
    case "Fisher":
      return fisherSeries(bars, args[0]);

    // ─── Volatility / regime ────────────────────────────────────────
    case "Choppiness":
      return choppinessSeries(bars, args[0]);
    case "Ulcer":
      return ulcerSeries(bars, args[0]);

    // ─── Statistical ────────────────────────────────────────────────
    case "Zscore":
      return zscoreSeries(bars, args[0]);
    case "LRSlope":
      return lrSlopeSeries(bars, args[0]);
    case "LRIntercept":
      return lrInterceptSeries(bars, args[0]);
    case "LRValue":
      return lrValueSeries(bars, args[0]);
    case "R2":
      return r2Series(bars, args[0]);

    // ─── Volume (extended) ──────────────────────────────────────────
    case "VWAP":
      return vwapRollingSeries(bars, args[0]);
    case "KVO":
      return kvoSeries(bars, args[0], args[1]);
    case "ForceIndex":
      return forceIndexSeries(bars, args[0]);
    case "EMV":
      return emvSeries(bars, args[0]);
    case "NVI":
      return nviSeries(bars);
    case "PVI":
      return pviSeries(bars);

    // ─── Tick-resolution indicators ─────────────────────────────────
    // All require a TickContext. We early-return all-NaN when the
    // session has no ticks attached so DSL evaluation degrades to NaN
    // gracefully — same null-as-fail discipline used elsewhere.
    case "POC": {
      if (!tickCtx) return new Array(bars.length).fill(NaN);
      const cache = profileCache ?? new ProfileCache(bars.length, tickCtx);
      return pocSeries(bars.length, cache, args[0], args[1]);
    }
    case "VAH": {
      if (!tickCtx) return new Array(bars.length).fill(NaN);
      const cache = profileCache ?? new ProfileCache(bars.length, tickCtx);
      return vahSeries(bars.length, cache, args[0], args[1]);
    }
    case "VAL": {
      if (!tickCtx) return new Array(bars.length).fill(NaN);
      const cache = profileCache ?? new ProfileCache(bars.length, tickCtx);
      return valSeries(bars.length, cache, args[0], args[1]);
    }
    case "VA_width": {
      if (!tickCtx) return new Array(bars.length).fill(NaN);
      const cache = profileCache ?? new ProfileCache(bars.length, tickCtx);
      return vaWidthSeries(bars.length, cache, args[0], args[1]);
    }
    case "dist_to_POC": {
      if (!tickCtx) return new Array(bars.length).fill(NaN);
      const cache = profileCache ?? new ProfileCache(bars.length, tickCtx);
      return distToPocSeries(bars, cache, args[0], args[1]);
    }
    case "trades_at_bid":
      return tickCtx
        ? tradesAtBidSeries(bars.length, tickCtx, args[0])
        : new Array(bars.length).fill(NaN);
    case "trades_at_ask":
      return tickCtx
        ? tradesAtAskSeries(bars.length, tickCtx, args[0])
        : new Array(bars.length).fill(NaN);
    case "tick_imbalance":
      return tickCtx
        ? tickImbalanceSeries(bars.length, tickCtx, args[0])
        : new Array(bars.length).fill(NaN);
    case "tick_count":
      return tickCtx
        ? tickCountSeries(bars.length, tickCtx, args[0])
        : new Array(bars.length).fill(NaN);
    case "mean_trade_size":
      return tickCtx
        ? meanTradeSizeSeries(bars.length, tickCtx, args[0])
        : new Array(bars.length).fill(NaN);
    case "large_trade_count":
      return tickCtx
        ? largeTradeCountSeries(bars.length, tickCtx, args[0], args[1])
        : new Array(bars.length).fill(NaN);
    case "vwap_tick":
      return tickCtx
        ? vwapTickSeries(bars.length, tickCtx, args[0])
        : new Array(bars.length).fill(NaN);

    // ─── Kalman-filtered Ornstein-Uhlenbeck (5 sibling fields) ──────
    // The cache is shared per-zone so all 5 field accesses on the same
    // (source, calib, trust) tuple run the filter exactly once. Falls
    // back to a one-off cache when called outside a precompute (e.g.
    // strategy-evaluator's lazy per-bar dispatch) so single-field
    // strategies still work.
    case "KALMAN_OU_x":
    case "KALMAN_OU_mu":
    case "KALMAN_OU_sigma":
    case "KALMAN_OU_phi":
    case "KALMAN_OU_P":
    case "KALMAN_OU_x_pred": {
      const cache = kalmanCache ?? new KalmanOuCache(bars);
      const bundle = cache.get(args[0], args[1], args[2]);
      switch (name) {
        case "KALMAN_OU_x":      return bundle.x;
        case "KALMAN_OU_mu":     return bundle.mu;
        case "KALMAN_OU_sigma":  return bundle.sigma;
        case "KALMAN_OU_phi":    return bundle.phi;
        case "KALMAN_OU_P":      return bundle.P;
        case "KALMAN_OU_x_pred": return bundle.x_pred;
      }
      return null;
    }

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
  preEntryBarsByZoneId?: Map<number, TradeZoneBar[]>,
  tickCtxByZoneId?: Map<number, TickContext>,
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
    // Per-zone tick context — when ticks aren't available for the
    // session, this is undefined and tick-required indicators emit
    // all-NaN. The cache lets POC(20)/VAH(20)/VAL(20) over the same
    // window share one VolumeProfile build.
    const tickCtx = tickCtxByZoneId?.get(zone.id);
    const profileCache = tickCtx
      ? new ProfileCache(combined.length, tickCtx)
      : null;
    // Per-zone Kalman bundle cache — KALMAN_OU_x/mu/sigma/phi/P over the
    // same (source, calib, trust) reuse one filter pass via this cache.
    // Always created (no tick dependency); the bundle math runs on plain
    // OHLCV bars.
    const kalmanCache = new KalmanOuCache(combined);
    for (const r of required) {
      const series = computeIndicatorSeries(
        r.name,
        r.args,
        combined,
        tickCtx,
        profileCache,
        kalmanCache,
      );
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
  // ─── Extended indicator library v2 ────────────────────────────────
  // Order flow.
  "CVD",
  // Trend / channels.
  "Keltner_upper", "Keltner_mid", "Keltner_lower",
  "Supertrend", "PSAR",
  // Ichimoku.
  "Ichimoku_tenkan", "Ichimoku_kijun",
  "Ichimoku_senkouA", "Ichimoku_senkouB", "Ichimoku_chikou",
  // Momentum.
  "Aroon_up", "Aroon_down", "Aroon_osc",
  "VortexPlus", "VortexMinus",
  "DIplus", "DIminus",
  "AO", "UO", "Fisher",
  // Volatility / regime.
  "Choppiness", "Ulcer",
  // Statistical.
  "Zscore", "LRSlope", "LRIntercept", "LRValue", "R2",
  // Volume (extended).
  "VWAP", "KVO", "ForceIndex", "EMV", "NVI", "PVI",
  // Tick-resolution.
  "POC", "VAH", "VAL", "VA_width", "dist_to_POC",
  "trades_at_bid", "trades_at_ask", "tick_imbalance",
  "tick_count", "mean_trade_size", "large_trade_count", "vwap_tick",
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
