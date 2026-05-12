/**
 * strategy-evaluator.ts — Per-bar evaluator for the user-authored strategy DSL.
 *
 * The legacy backtester ran a hardcoded `generateSignals(bars, params)` per
 * strategy id. This module replaces that with a DSL: users write scripts
 * that declare `let` bindings and `signal.long.if = …` / `signal.short.if = …`
 * statements, and the evaluator walks bars producing the same
 * `BacktestSignal[]` shape so the rest of the engine (synthetic-zone
 * construction, `simulateAllZones`, summary stats) is unchanged.
 *
 * Pipeline:
 *   1. parseStrategyScript(text) → { stmts, errors, paramRefs }
 *      — Multi-line aware. Statements are `let`/`var`, `signal.{long,short}.if`,
 *        or generic `path = expr` assignments (which the engine routes to
 *        rules/filters overlays). `params.X = …` on the LHS is a parse error
 *        because params are inferred and edited in the sidebar, not the script.
 *   2. evaluateStrategyScript({ stmts, paramOverrides, bars }) → { signals, assigns }
 *      — Walks bars 0..N-1. At each bar evaluates `signal.long.if` and
 *        `signal.short.if`; on truthy emits a BacktestSignal AND records the
 *        firing in firingsLong/firingsShort so `bars_since(signal.long)`
 *        on a later bar can resolve correctly.
 *
 * Series & indexing:
 *   - `high(N)` / `low(N)` return SeriesHandles — closures over the bar
 *     array. Bare use coerces to the value at the current bar (`.at(0)`),
 *     so `let x = high(20)` works. `high(20)[5]` = the rolling 20-bar
 *     high evaluated 5 bars before the current bar.
 *   - Bare OHLCV idents (`high`, `low`, `close`, `open`, `volume`) likewise
 *     accept `[k]` indexing — `close[5]` is the close 5 bars ago.
 *
 * Stateful self-reference:
 *   - `bars_since(signal.long)` resolves against the firings array — the
 *     bar-distance to the most recent prior `signal.long.if` firing, or
 *     +Infinity if none yet. This is what makes per-strategy cooldowns
 *     expressible in the DSL.
 *   - `any_bar_in(N, condition)` is a SPECIAL FORM (no eager arg eval):
 *     for k in 0..N-1, build a fresh BarEvalCtx with bar shifted by k,
 *     CLEAR the let cache (full re-eval per inner bar — confirmed user
 *     decision), evaluate condition, OR-reduce.
 *
 * Why a separate evaluator instead of extending evaluate() in script-expr.ts:
 *   - script-expr.ts evaluates against a static EntryEvalCtx (the entry bar
 *     of a single trade). Strategy evaluation needs a per-bar walk with
 *     mutable per-bar state (letCache, firings) and value types beyond
 *     `number` (SeriesHandle). Keeping the two evaluators separate avoids
 *     bloating the per-trade evaluator with strategy-only concerns.
 *   - We REUSE the AST and parser from script-expr.ts; only the evaluation
 *     layer is new.
 */

import type { ReplayBar } from "@/types/replay";
import {
  type Expr,
  compile,
  applyBindings,
  EXPR_SYMBOLS,
  // Indicator dispatch — single source of truth shared with the
  // entry-context evaluator. Routing through these prevents the strategy
  // DSL from drifting behind script-expr.ts again as new indicators are
  // added (it has done so historically — bid/ask + tick indicators were
  // invisible here until this delegation was wired in).
  computeIndicatorSeries,
  indicatorKeyForCall,
  applyArgDefaults,
  isKnownIndicator,
  ZERO_ARG_INDICATORS,
  FRACTIONAL_ARG_INDICATORS,
  type TickContext,
  parseOptimizeSpec,
  scanInlineOptimize,
  type OptimizeSpec,
  normalizerKey,
  rollingNormalize,
} from "./script-expr";
import { ProfileCache } from "@/lib/indicators/tick-indicators";
import type { IndicatorBar } from "@/lib/indicators/calculations";
import { KalmanOuCache, KALMAN_SOURCE_CODES } from "@/lib/indicators/kalman-ou";

// ─── BacktestSignal — output shape preserved from the legacy engine ────────

export interface BacktestSignal {
  barIndex: number;
  direction: "Long" | "Short";
}

// ─── Statement layer ──────────────────────────────────────────────────────

export type Stmt =
  | { kind: "let"; name: string; expr: Expr; line: number; source: string }
  | { kind: "signal"; side: "long" | "short"; expr: Expr; line: number; source: string }
  | { kind: "assign"; path: string; expr: Expr; line: number; source: string }
  // `graph = <expr>` or `graph["Title"] = <expr>` — declares a P&L
  // histogram that the dashboard renders at the bottom of the segment-
  // analysis grid. The expr is evaluated at every surviving trade's
  // entry bar; per-trade values are bucketed equal-width and plotted
  // via the same <PnlByCategory> component the built-in dimensions
  // already use. `title` defaults to a trimmed slice of the RHS source
  // when no explicit `["..."]` label is supplied.
  | { kind: "graph"; title: string; expr: Expr; line: number; source: string }
  // `chart = <expr>` or `chart["Title"[, "#hexcolor"]] = <expr>` —
  // declares a per-bar overlay line that BacktestScriptChart draws on
  // the candlestick view. The expr is evaluated at EVERY bar in the
  // stitched session (not just at trade-entry bars, the way `graph`
  // is) and rendered as a TradingView LineSeries. Series whose value
  // range fits inside the price envelope render on the price pane;
  // out-of-range series (RSI, ATR, ...) get their own sub-pane below.
  // `color` is `null` when the user omitted the explicit hex string —
  // the renderer then picks from an auto-cycle palette by directive
  // index. `title` defaults to a trimmed slice of the RHS source when
  // no explicit `["..."]` label is supplied.
  | { kind: "chart"; title: string; color: string | null; expr: Expr; line: number; source: string };

export interface ParseError {
  line: number;
  message: string;
  severity: "error" | "warning";
}

export interface ParsedStrategyScript {
  stmts: Stmt[];
  errors: ParseError[];
  /** Every `params.X` referenced anywhere in the script. The dashboard
   *  uses this list to drive the inferred-param sidebar. Stable across
   *  re-parses (ordered by first appearance). */
  paramRefs: string[];
  /** Per-`let` encoded args for any `let X = KALMAN_OU(source, calib, trust)`
   *  bindings the script declared. Empty when the script uses no Kalman
   *  bindings. The strategy parser already applies the dotted-ident
   *  rewrite (`kf.x` → `KALMAN_OU_x(…)`) to its own stmts, but downstream
   *  consumers — notably `applyBindingsToOverlay` in backtest-engine.ts —
   *  need the same map so they can rewrite `kf.x` references that appear
   *  in entry-context exprs (`exit.if`, `filter.if`, `ontrade.print`,
   *  `rules.X`). Without bridging this map, those exprs see a bare
   *  dotted ident `"kf.x"` that resolves to NaN at runtime and silently
   *  kills every exit/filter/print that depends on it. */
  kalmanArgsByLet: Map<string, Expr[]>;
  /** `Optimize.X.Y(...)` directives lifted from the strategy DSL.
   *  Two flavors:
   *    - Bare RHS (`let X = Optimize.…`): synthetic name `<X>__r<rev>`,
   *      bindings.set(X, ident(synthName)) so later references rewrite
   *      cleanly. Mirrors `var X = Optimize.…` in the line-based DSL.
   *    - Inline (anywhere else inside a `let`/`signal.*.if`/`path = expr`
   *      RHS): synthetic name `__sopt_<n>__`, splice-replaces the call.
   *  Keys are full overlay paths (`var.<synthName>`) so the engine can
   *  merge this map directly into `overlay.optimizeOverrides` — the
   *  online optimizer then drives each spec like any line-based
   *  `var <name> = Optimize.…` declaration. The runtime ident resolver
   *  in `evaluateStrategyScript` (`ctx.varValues`) translates the synthName
   *  back into the optimizer's per-signal numeric pick. */
  optimizeSpecs: Record<string, OptimizeSpec>;
}

// Reserved binding names that conflict with built-in idents — refuse `let`
// declarations using these names. Mirrors the script-expr.ts conventions.
const RESERVED_LET_NAMES = new Set<string>([
  "open", "high", "low", "close", "volume",
  "bar_index", "direction",
  "range", "body", "upper_wick", "lower_wick", "typical", "median_price", "weighted_close",
  "ticksPerPoint", "pointValue", "tickValue",
  // Bid/ask order-flow scalars — reserved so a `let delta = …` doesn't
  // shadow the bar-field resolver and silently change semantics.
  "bar_volume_bid", "bar_volume_ask", "buy_volume", "sell_volume",
  "delta", "delta_ratio", "buy_pressure",
  "if", "then", "else",
  "let", "var", "signal",
  "params", // root namespace — declaring `let params = …` would be confusing
]);

/** Parse the strategy DSL. Multi-line continuation is supported: a logical
 *  line continues across `\n` when (a) paren/bracket depth > 0, OR (b) the
 *  previous non-comment, non-whitespace token on the line ends with a
 *  binary operator / open-paren / open-bracket / `=` / unary-eligible
 *  prefix. Comments use `//` or `#`. */
export function parseStrategyScript(text: string): ParsedStrategyScript {
  const errors: ParseError[] = [];
  const stmts: Stmt[] = [];

  // Optimize directive accumulator. Two synthName flavors share this map:
  //   - `<name>__r<rev>` for bare `let <name> = Optimize.…` (so two
  //     redeclarations of the same name become independent optimizer
  //     params, matching `var X = Optimize.…` in the line-based DSL).
  //   - `__sopt_<n>__` for inline `Optimize.…` calls anywhere in an
  //     expression RHS. The `__sopt_` prefix is distinct from the
  //     line-based parser's `__opt_` prefix so the two pipelines never
  //     clash on a script that uses both DSLs.
  // The full overlay path (`var.<synthName>`) is the map key so the
  // engine can merge directly into `overlay.optimizeOverrides`.
  const optimizeSpecs: Record<string, OptimizeSpec> = {};
  const inlineOptCounter = { n: 0 };
  let optVarRev = 0;

  // Shared lift helper — runs the inline `Optimize.X.Y(…)` scanner over an
  // RHS string and registers each lifted numeric spec under a fresh
  // `__sopt_<n>__` synth name. Returns the rewritten text or a parse
  // error message tied to the line. Used by every line type below.
  function liftRhs(
    rhs: string,
    line: number,
    label: string
  ): { ok: true; text: string } | { ok: false } {
    const r = scanInlineOptimize(rhs, (spec) => {
      const synth = `__sopt_${inlineOptCounter.n++}__`;
      optimizeSpecs[`var.${synth}`] = spec;
      return synth;
    });
    if (!r.ok) {
      errors.push({ line, message: `${label}: ${r.error}`, severity: "error" });
      return { ok: false };
    }
    return { ok: true, text: r.text };
  }

  // 1. Pre-pass: combine continuation lines into logical statements.
  const logicalLines = combineContinuationLines(text);

  // 2. Parse each logical line.
  for (const ll of logicalLines) {
    const trimmed = ll.text.trim();
    if (trimmed === "") continue;

    // `let <name> = <expr>` — also accept legacy `var` for back-compat.
    const letMatch = trimmed.match(/^(let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (letMatch) {
      const [, , name, rhs] = letMatch;
      if (RESERVED_LET_NAMES.has(name)) {
        errors.push({
          line: ll.line,
          message: `let: name "${name}" collides with a reserved identifier — pick a different name`,
          severity: "error",
        });
        continue;
      }
      // Bare `let X = Optimize.…` — register the spec as an optimizer-
      // driven var and bind the let to the synthName. Mirrors the
      // `var X = Optimize.…` path in backtest-script.ts. Detected by an
      // exact `Optimize.` prefix on the trimmed RHS so `let X = ATR(…) +
      // Optimize.…` falls through to the inline-lift branch instead.
      const trimmedRhs = rhs.trim();
      if (/^Optimize\./i.test(trimmedRhs)) {
        const r = parseOptimizeSpec(trimmedRhs);
        if (!r.ok) {
          errors.push({ line: ll.line, message: `let ${name}: ${r.error}`, severity: "error" });
          continue;
        }
        if (r.spec.kind === "optimize-categorical") {
          errors.push({
            line: ll.line,
            message: `let ${name}: categorical Optimize on a let RHS isn't supported. Use Optimize.X.Y(lookback, min, max[, step]).`,
            severity: "error",
          });
          continue;
        }
        const synthName = `${name}__r${optVarRev++}`;
        optimizeSpecs[`var.${synthName}`] = r.spec;
        // Push a plain `let` stmt whose body is just the synthName ident.
        // The downstream let-inline pass at step 3 then propagates the
        // substitution into every subsequent reference, exactly the way
        // a literal-bound let works.
        stmts.push({
          kind: "let",
          name,
          expr: { kind: "ident", name: synthName },
          line: ll.line,
          source: trimmedRhs,
        });
        continue;
      }
      // Otherwise: lift any inline Optimize calls in the RHS first, then
      // compile the rewritten text.
      const lifted = liftRhs(rhs, ll.line, `let ${name}`);
      if (!lifted.ok) continue;
      const c = compile(lifted.text);
      if (!c.ok) {
        errors.push({ line: ll.line, message: `let ${name}: ${c.error}`, severity: "error" });
        continue;
      }
      stmts.push({ kind: "let", name, expr: c.expr, line: ll.line, source: rhs.trim() });
      continue;
    }

    // `signal.long.if = …` / `signal.short.if = …`
    const sigMatch = trimmed.match(/^signal\.(long|short)\.if\s*=\s*([\s\S]+)$/);
    if (sigMatch) {
      const [, sideRaw, rhs] = sigMatch;
      const side = sideRaw as "long" | "short";
      const lifted = liftRhs(rhs, ll.line, `signal.${side}.if`);
      if (!lifted.ok) continue;
      const c = compile(lifted.text);
      if (!c.ok) {
        errors.push({
          line: ll.line,
          message: `signal.${side}.if: ${c.error}`,
          severity: "error",
        });
        continue;
      }
      stmts.push({ kind: "signal", side, expr: c.expr, line: ll.line, source: rhs.trim() });
      continue;
    }

    // `graph = <expr>` or `graph["Title"] = <expr>` — declares an
    // ad-hoc P&L histogram. Two forms:
    //   graph = atr(14)                        → title = "atr(14)"
    //   graph["My Title"] = atr(14) / close    → title = "My Title"
    // Both compile through the same expression compiler used by `let`
    // and `signal.*.if`, so let-bound idents, arithmetic, indicator
    // calls, etc. all work. The match must run BEFORE the generic
    // `path = expr` fallback, otherwise `graph = …` would be routed to
    // the line-based DSL machinery and silently dropped.
    const graphTitledMatch = trimmed.match(
      /^graph\s*\[\s*"([^"]+)"\s*\]\s*=\s*([\s\S]+)$/
    );
    const graphPlainMatch = graphTitledMatch
      ? null
      : trimmed.match(/^graph\s*=\s*([\s\S]+)$/);
    if (graphTitledMatch || graphPlainMatch) {
      const explicitTitle = graphTitledMatch ? graphTitledMatch[1] : null;
      const rhs = (graphTitledMatch ? graphTitledMatch[2] : graphPlainMatch![1]).trim();
      if (rhs === "") {
        errors.push({
          line: ll.line,
          message: `graph: missing expression on the right of '='`,
          severity: "error",
        });
        continue;
      }
      const lifted = liftRhs(rhs, ll.line, "graph");
      if (!lifted.ok) continue;
      const c = compile(lifted.text);
      if (!c.ok) {
        errors.push({ line: ll.line, message: `graph: ${c.error}`, severity: "error" });
        continue;
      }
      // Default title is the trimmed RHS source, capped so the chart
      // header doesn't wrap or truncate awkwardly. Explicit title via
      // `graph["..."]` always wins.
      const title = explicitTitle ?? (rhs.length > 40 ? `${rhs.slice(0, 39)}…` : rhs);
      stmts.push({
        kind: "graph",
        title,
        expr: c.expr,
        line: ll.line,
        source: rhs,
      });
      continue;
    }

    // `chart = <expr>` or `chart["Title"[, "#hexcolor"]] = <expr>` —
    // declares a per-bar overlay line on the price chart. Mirrors the
    // `graph` block above (same liftRhs + compile pipeline, so let-
    // bound idents / inline Optimize / indicator calls all work) but
    // captures an optional explicit color alongside the title. Must
    // match BEFORE the generic `path = expr` fallback for the same
    // reason `graph` does — otherwise `chart = …` would be routed to
    // the line-based DSL machinery and silently dropped.
    //
    // Color syntax: `chart["Title", "#3b82f6"] = …`. The hex string is
    // accepted in 3/4/6/8 hex-digit forms (`#rgb`, `#rgba`, `#rrggbb`,
    // `#rrggbbaa`) so the user can drop in a Tailwind palette code or
    // a fully-specified rgba. When color is omitted the renderer
    // auto-cycles from a built-in palette by directive index.
    const chartTitledMatch = trimmed.match(
      /^chart\s*\[\s*"([^"]+)"(?:\s*,\s*"(#[0-9a-fA-F]{3,8})")?\s*\]\s*=\s*([\s\S]+)$/
    );
    const chartPlainMatch = chartTitledMatch
      ? null
      : trimmed.match(/^chart\s*=\s*([\s\S]+)$/);
    if (chartTitledMatch || chartPlainMatch) {
      const explicitTitle = chartTitledMatch ? chartTitledMatch[1] : null;
      const explicitColor = chartTitledMatch ? (chartTitledMatch[2] ?? null) : null;
      const rhs = (chartTitledMatch ? chartTitledMatch[3] : chartPlainMatch![1]).trim();
      if (rhs === "") {
        errors.push({
          line: ll.line,
          message: `chart: missing expression on the right of '='`,
          severity: "error",
        });
        continue;
      }
      const lifted = liftRhs(rhs, ll.line, "chart");
      if (!lifted.ok) continue;
      const c = compile(lifted.text);
      if (!c.ok) {
        errors.push({ line: ll.line, message: `chart: ${c.error}`, severity: "error" });
        continue;
      }
      // Default title is the trimmed RHS source, capped so the legend
      // doesn't wrap. Explicit title via `chart["..."]` always wins.
      const title = explicitTitle ?? (rhs.length > 40 ? `${rhs.slice(0, 39)}…` : rhs);
      stmts.push({
        kind: "chart",
        title,
        color: explicitColor,
        expr: c.expr,
        line: ll.line,
        source: rhs,
      });
      continue;
    }

    // Generic `path = expr` (e.g. `rules.stopLossPoints = 8`,
    // `filters.atr.min = 1.2`, `loadstrategy = …`). Caller (the engine)
    // routes these into the existing line-based DSL machinery.
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) {
      errors.push({
        line: ll.line,
        message: `expected "let X = …", "signal.long.if = …", "signal.short.if = …", or "path = …"`,
        severity: "error",
      });
      continue;
    }
    const path = trimmed.slice(0, eqIdx).trim();
    const rhs = trimmed.slice(eqIdx + 1).trim();
    if (path === "") {
      errors.push({ line: ll.line, message: "missing path before '='", severity: "error" });
      continue;
    }
    // params.X on LHS is a parse error — params are inferred from RHS
    // usage and edited in the sidebar.
    if (path.startsWith("params.") || path === "params") {
      errors.push({
        line: ll.line,
        message: `params are inferred from script usage and edited in the sidebar — remove this assignment`,
        severity: "error",
      });
      continue;
    }
    // Lift inline Optimize before compiling. If the lift fails we still
    // skip silently below (the line-based DSL parser may handle a
    // 3-arg `filter.if = (cond, , )` shape that isn't a single Expr),
    // BUT we surface the lift error because it's a real Optimize syntax
    // problem the user needs to see.
    const lifted = scanInlineOptimize(rhs, (spec) => {
      const synth = `__sopt_${inlineOptCounter.n++}__`;
      optimizeSpecs[`var.${synth}`] = spec;
      return synth;
    });
    if (!lifted.ok) {
      // Optimize syntax error — surface as a real error rather than
      // silently dropping the line.
      errors.push({ line: ll.line, message: `${path}: ${lifted.error}`, severity: "error" });
      continue;
    }
    const c = compile(lifted.text);
    if (!c.ok) {
      // Generic `path = expr` lines that don't compile as strategy
      // expressions — e.g. `filter.if = (cond, , )` whose 3-arg form is
      // valid line-based-DSL syntax but invalid as a single Expr. The
      // line-based parser (`parseBacktestScript`) handles these. We
      // skip silently here so the strategy override doesn't get
      // disabled by line-based-DSL syntax we can't handle.
      continue;
    }
    stmts.push({ kind: "assign", path, expr: c.expr, line: ll.line, source: rhs.trim() });
  }

  // 3. Inline `let` bindings — substitute earlier let-bindings into later
  //    expressions so the evaluator sees a flat AST per stmt. Mirrors how
  //    `parseBacktestScript` handles `var` bindings.
  const bindings = new Map<string, Expr>();
  const flat: Stmt[] = [];
  for (const s of stmts) {
    const substituted = applyBindings(s.expr, bindings);
    if (s.kind === "let") {
      bindings.set(s.name, substituted);
      flat.push({ ...s, expr: substituted });
    } else {
      flat.push({ ...s, expr: substituted });
    }
  }

  // 3b. Kalman-OU member-access rewrite. The DSL has no native `obj.field`
  //     access, but the tokenizer captures `kf.x` as a single dotted
  //     ident. We exploit that: when `let kf = KALMAN_OU(source, calib,
  //     trust)` is bound, walk every subsequent expression and replace
  //     ident `kf.<field>` with a direct call to `KALMAN_OU_<field>`
  //     against the encoded args. The five sibling indicators share a
  //     per-zone `KalmanOuCache` so this stays a single Kalman pass per
  //     parameter tuple even when the strategy reads several fields.
  //
  //     The substitution runs AFTER the let-inline loop so any args that
  //     reference earlier lets (e.g. `KALMAN_OU(close, calib_param, ...)`)
  //     have already been resolved to literals; that means the source
  //     ident and numeric args we encode here are stable.
  const kalmanArgsByLet = new Map<string, Expr[]>();
  for (const s of flat) {
    if (
      s.kind === "let" &&
      s.expr.kind === "call" &&
      s.expr.name === "KALMAN_OU"
    ) {
      const encoded = encodeKalmanArgs(s.expr.args);
      if (!encoded) {
        errors.push({
          line: s.line,
          message: `let ${s.name}: KALMAN_OU expects (source, calib?, trust?) — source must be one of close/open/high/low/typical/median_price/weighted_close, calib > 0, trust in (0,1)`,
          severity: "error",
        });
        continue;
      }
      kalmanArgsByLet.set(s.name, encoded);
    }
  }
  const rewritten: Stmt[] = [];
  for (const s of flat) {
    // Strip the `let kf = KALMAN_OU(…)` stmts themselves — `kf` only ever
    // appears in field-access form (`kf.x`), and the rewrite below
    // synthesizes calls directly. Leaving the original would make `kf`
    // resolve to a bare `KALMAN_OU(…)` call which has no series and just
    // returns NaN; cleaner to drop it.
    if (s.kind === "let" && kalmanArgsByLet.has(s.name)) continue;
    rewritten.push({ ...s, expr: rewriteKalmanRefs(s.expr, kalmanArgsByLet) });
  }

  // 4. Walk every stmt's AST collecting params.X references (deduped,
  //    ordered by first appearance).
  const paramRefs: string[] = [];
  const seen = new Set<string>();
  for (const s of rewritten) {
    walkParamsRefs(s.expr, (name) => {
      if (!seen.has(name)) {
        seen.add(name);
        paramRefs.push(name);
      }
    });
  }

  return { stmts: rewritten, errors, paramRefs, kalmanArgsByLet, optimizeSpecs };
}

/** Encode KALMAN_OU's argument list — `(source, calib, trust)` — into the
 *  numeric tuple the indicator dispatch expects. The first arg is a bare
 *  ident naming a price source; we map it to the small int defined in
 *  `KALMAN_SOURCE_CODES`. The calibration window and trust factor are
 *  ordinary numeric expressions, but at this point in parsing they're
 *  always already-substituted literal `num` nodes (see step 3 above) so
 *  we just unwrap the value. Returns null on any malformed input — the
 *  caller surfaces a parse error in that case so the user sees a clear
 *  message instead of NaN at run time. Defaults: source=close, calib=60,
 *  trust=0.5 (matches the indicator's `applyArgDefaults`). */
function encodeKalmanArgs(args: Expr[]): Expr[] | null {
  // Source — defaults to `close` if omitted.
  let sourceCode = KALMAN_SOURCE_CODES.close;
  if (args.length >= 1) {
    const a0 = args[0];
    if (a0.kind === "ident" && KALMAN_SOURCE_CODES[a0.name] != null) {
      sourceCode = KALMAN_SOURCE_CODES[a0.name];
    } else if (a0.kind === "num" && KALMAN_SOURCE_CODES_REVERSE[Math.round(a0.value)]) {
      // Already-encoded numeric source code — pass through verbatim. Lets
      // a power user write `KALMAN_OU(1, 60, 0.5)` directly if they want.
      sourceCode = Math.round(a0.value);
    } else {
      return null;
    }
  }
  // Calib — must be a positive integer literal.
  let calib = 60;
  if (args.length >= 2) {
    const a1 = args[1];
    if (a1.kind !== "num" || !(a1.value > 0)) return null;
    calib = Math.round(a1.value);
  }
  // Trust — must be a literal in (0, 1).
  let trust = 0.5;
  if (args.length >= 3) {
    const a2 = args[2];
    if (a2.kind !== "num" || !(a2.value > 0) || !(a2.value < 1)) return null;
    trust = a2.value;
  }
  if (args.length > 3) return null;
  return [
    { kind: "num", value: sourceCode },
    { kind: "num", value: calib },
    { kind: "num", value: trust },
  ];
}

/** Reverse map for `encodeKalmanArgs`'s "already a numeric source code"
 *  pass-through path. Built once at module load. */
const KALMAN_SOURCE_CODES_REVERSE: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(KALMAN_SOURCE_CODES)) out[v] = k;
  return out;
})();

/** Recognized member-access fields on a Kalman binding. Six fields
 *  one-to-one match the `KalmanOuBundle` shape. `x_pred` is the
 *  pre-fit OU prediction at each bar (forecast given everything known
 *  BEFORE the bar opens) — the right divisor baseline for unbiased
 *  innovation z-scores; `x` is the post-fit posterior (already
 *  absorbed the bar). See kalman-ou.ts for the full distinction. */
const KALMAN_FIELDS = new Set(["x", "mu", "sigma", "phi", "P", "x_pred"]);

/** Walk an Expr AST and replace every dotted ident matching
 *  `<kalmanLet>.<field>` with a synthetic `call("KALMAN_OU_<field>",
 *  encodedArgs)`. Idents that don't match a known Kalman binding are
 *  left alone (they may be `params.X`, `signal.long`, or just unrelated
 *  dotted names). Pure: returns a new tree, never mutates input.
 *
 *  Exported so the backtest engine's `applyBindingsToOverlay` can run
 *  the same transform on entry-context exprs (`exit.if`, `filter.if`,
 *  `ontrade.print`, `rules.X`). The strategy parser already runs it on
 *  signal/let stmts; the overlay path needs it too because the
 *  line-based DSL parser (`parseBacktestScript`) doesn't know about
 *  KALMAN_OU and would otherwise leave `kf.x` as an unresolvable
 *  bare dotted ident. Idempotent: a second pass walks past already-
 *  rewritten nodes harmlessly (the rewrite produces `call` nodes,
 *  not idents, so the dotted-ident match misses on a re-walk). */
export function rewriteKalmanRefs(expr: Expr, kalmanArgsByLet: Map<string, Expr[]>): Expr {
  if (kalmanArgsByLet.size === 0) return expr;
  switch (expr.kind) {
    case "num":
      return expr;
    case "ident": {
      const dot = expr.name.indexOf(".");
      if (dot < 0) return expr;
      const root = expr.name.slice(0, dot);
      const field = expr.name.slice(dot + 1);
      const args = kalmanArgsByLet.get(root);
      if (!args || !KALMAN_FIELDS.has(field)) return expr;
      return { kind: "call", name: `KALMAN_OU_${field}`, args };
    }
    case "call":
      return {
        ...expr,
        args: expr.args.map((a) => rewriteKalmanRefs(a, kalmanArgsByLet)),
      };
    case "unary":
      return { ...expr, arg: rewriteKalmanRefs(expr.arg, kalmanArgsByLet) };
    case "binop":
      return {
        ...expr,
        lhs: rewriteKalmanRefs(expr.lhs, kalmanArgsByLet),
        rhs: rewriteKalmanRefs(expr.rhs, kalmanArgsByLet),
      };
    case "if":
      return {
        ...expr,
        cond: rewriteKalmanRefs(expr.cond, kalmanArgsByLet),
        then: rewriteKalmanRefs(expr.then, kalmanArgsByLet),
        else: rewriteKalmanRefs(expr.else, kalmanArgsByLet),
      };
    case "index":
      return {
        ...expr,
        base: rewriteKalmanRefs(expr.base, kalmanArgsByLet),
        offset: rewriteKalmanRefs(expr.offset, kalmanArgsByLet),
      };
  }
}

/** Combine continuation lines into single logical statements. Returns
 *  one entry per logical line, with `line` pointing at the FIRST physical
 *  line (used for error reporting). Comments are stripped at the
 *  physical-line level so the continuation logic only sees code.
 *
 *  Continuation rules: a logical line continues across `\n` when ANY of
 *    (a) paren/bracket depth > 0,
 *    (b) the last non-whitespace token of the buffer ends with a binary
 *        operator / comma / open bracket / `=`, OR
 *    (c) the NEXT non-empty physical line begins with a binary operator
 *        / comma / closing bracket. This is what lets users write
 *
 *            let is_base = range_in_atr >= min
 *                       && range_in_atr <= max
 *
 *        without trailing operators on the previous line. */
function combineContinuationLines(text: string): Array<{ line: number; text: string }> {
  const physical = text.split(/\r?\n/).map((s, i) => ({
    line: i + 1,
    code: stripInlineComment(s),
  }));

  function nextNonEmpty(idx: number): string | null {
    for (let j = idx + 1; j < physical.length; j++) {
      const t = physical[j].code.trim();
      if (t !== "") return t;
    }
    return null;
  }

  function startsWithContinuationOp(line: string): boolean {
    const c = line[0];
    const c2 = line.slice(0, 2);
    if (c2 === "&&" || c2 === "||" || c2 === "==" || c2 === "!=" || c2 === ">=" || c2 === "<=") {
      return true;
    }
    return "+-*/%^,<>)]".includes(c);
  }

  const out: Array<{ line: number; text: string }> = [];
  let buf = "";
  let bufLine = -1;
  let depth = 0;

  for (let i = 0; i < physical.length; i++) {
    const lineNo = physical[i].line;
    const stripped = physical[i].code;
    if (stripped.trim() === "" && depth === 0 && buf === "") continue;

    for (const c of stripped) {
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    }

    if (buf === "") {
      bufLine = lineNo;
      buf = stripped;
    } else {
      buf += " " + stripped.trim();
    }

    const tail = buf.replace(/\s+$/, "");
    const lastChar = tail.slice(-1);
    const lastTwo = tail.slice(-2);
    const continuesByOperator =
      lastTwo === "&&" ||
      lastTwo === "||" ||
      lastTwo === "==" ||
      lastTwo === "!=" ||
      lastTwo === ">=" ||
      lastTwo === "<=" ||
      "+-*/%^,<>=!([".includes(lastChar);

    const next = nextNonEmpty(i);
    const continuesByLookahead = next !== null && startsWithContinuationOp(next);

    if (depth > 0 || continuesByOperator || continuesByLookahead) {
      continue;
    }

    out.push({ line: bufLine, text: buf });
    buf = "";
    bufLine = -1;
  }
  if (buf.trim() !== "") {
    out.push({ line: bufLine, text: buf });
  }
  return out;
}

/** Strip `//` and `#` line comments — but keep them inside string literals.
 *  This DSL doesn't currently support strings; if we add them later the
 *  scanner here needs to grow a quote-state. For now, naive split works. */
function stripInlineComment(line: string): string {
  // Find the first `//` or `#` not preceded by another non-space.
  // We don't need to handle quoted strings yet.
  const slashIdx = line.indexOf("//");
  const hashIdx = line.indexOf("#");
  let cutIdx = -1;
  if (slashIdx >= 0 && hashIdx >= 0) cutIdx = Math.min(slashIdx, hashIdx);
  else if (slashIdx >= 0) cutIdx = slashIdx;
  else if (hashIdx >= 0) cutIdx = hashIdx;
  return cutIdx >= 0 ? line.slice(0, cutIdx) : line;
}

function walkParamsRefs(expr: Expr, visit: (name: string) => void): void {
  switch (expr.kind) {
    case "ident":
      if (expr.name.startsWith("params.")) visit(expr.name);
      return;
    case "num":
      return;
    case "call":
      for (const a of expr.args) walkParamsRefs(a, visit);
      return;
    case "unary":
      walkParamsRefs(expr.arg, visit);
      return;
    case "binop":
      walkParamsRefs(expr.lhs, visit);
      walkParamsRefs(expr.rhs, visit);
      return;
    case "if":
      walkParamsRefs(expr.cond, visit);
      walkParamsRefs(expr.then, visit);
      walkParamsRefs(expr.else, visit);
      return;
    case "index":
      walkParamsRefs(expr.base, visit);
      walkParamsRefs(expr.offset, visit);
      return;
  }
}

// ─── SeriesHandle — closure-based series-returning value ──────────────────

const SERIES_SENTINEL = Symbol("strategy-evaluator-series");

/** Module-level empty `varValues` map for ctx construction when the caller
 *  doesn't supply one. Sharing one frozen instance avoids allocating a
 *  fresh `new Map()` per evaluateStrategyScript call (the engine spins
 *  this up once per backtest, so the saving is negligible — but the type
 *  signature stays uniform: `ctx.varValues` is always `ReadonlyMap`). */
const EMPTY_VAR_VALUES: ReadonlyMap<string, number> = new Map();

interface SeriesHandle {
  __series: typeof SERIES_SENTINEL;
  /** Value at (current bar - k). For k=0 returns the series at the
   *  current evaluation bar. NaN when the offset is out of range. */
  at: (k: number) => number;
}

function makeSeries(at: (k: number) => number): SeriesHandle {
  return { __series: SERIES_SENTINEL, at };
}

function isSeries(v: unknown): v is SeriesHandle {
  return (
    typeof v === "object" &&
    v !== null &&
    "__series" in v &&
    (v as { __series: unknown }).__series === SERIES_SENTINEL
  );
}

// ─── Per-bar evaluation context ────────────────────────────────────────────

interface BarEvalCtx {
  bars: ReplayBar[];
  barIndex: number;
  params: Record<string, number>;
  /** Optimizer-driven synthetic vars (`__sopt_<n>__`, `<name>__r<rev>`).
   *  Populated by the engine via `varValuesFrom()` from the online
   *  optimizer's chosen point; pre-warmup it falls back to each spec's
   *  `default <num>` literal (also via the same machinery). Empty Map
   *  when the script declares no `Optimize.X.Y(...)` directives. The
   *  resolver looks here BEFORE bar fields / params / let bindings so a
   *  synthName never collides with a real ident — synthNames have a
   *  `__r` or `__sopt_` infix that no real script identifier uses. */
  varValues: ReadonlyMap<string, number>;
  firingsLong: number[];
  firingsShort: number[];
  /** Lazy-evaluated `let` bindings — keyed by name. Cleared at the start
   *  of each top-level bar AND at each inner iteration of `any_bar_in`. */
  letCache: Map<string, number | SeriesHandle>;
  letDefs: Map<string, Expr>;
  /** Indicator series cache — keyed by `${name}:${period}` (or just
   *  `name` for zero-arg families). Lazily populated on first reference;
   *  shared across all bars in the run since the underlying values don't
   *  depend on the current bar index. */
  indicatorCache: Map<string, number[]>;
  /** Indicator-bar view of ReplayBar — built once per run, reused. */
  indicatorBars: IndicatorBar[];
  /** Rolling extremum series cache — keyed by `${fn}:${period}`. */
  rollingCache: Map<string, number[]>;
  /** Session-level tick context for tick-resolution indicators. Undefined
   *  when the session has no ticks attached — tick indicators then emit
   *  all-NaN via `computeIndicatorSeries` and predicates fail-closed. */
  tickCtx?: TickContext;
  /** Lazy volume-profile cache shared across POC/VAH/VAL/VA_width/
   *  dist_to_POC calls on the same window. Built once per run when
   *  `tickCtx` is present; null otherwise. */
  profileCache?: ProfileCache | null;
  /** Per-run Kalman bundle cache so KALMAN_OU_x/mu/sigma/phi/P at the
   *  same (source, calib, trust) share one Kalman pass. Always present;
   *  the underlying math has no tick dependency. */
  kalmanCache: KalmanOuCache;
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface EvaluateOptions {
  stmts: Stmt[];
  paramOverrides: Record<string, number>;
  bars: ReplayBar[];
  /** Optional minimum bar index. The evaluator skips bars before this
   *  index — useful when the engine wants to ensure indicator warmup
   *  has completed before signal evaluation begins. Default: 0. */
  minBarIndex?: number;
  /** Optional session-level tick context. When present, tick-resolution
   *  indicators (POC, VAH, VAL, trades_at_bid, vwap_tick, …) compute
   *  against ticks; absent, those indicators emit all-NaN gracefully
   *  (matching the entry-context evaluator's null-as-fail discipline so
   *  scripts still parse and evaluate cleanly without ticks). The pair
   *  `(sessionTicks, sessionTickRanges)` from `runBacktestForSession`
   *  satisfies this directly when `sessionTickRanges.length === bars.length * 2`. */
  tickCtx?: TickContext;
  /** Optimizer-driven synthetic vars (`__sopt_<n>__`, `<name>__r<rev>`)
   *  resolved to numeric values per signal. Empty/omitted when the
   *  script has no `Optimize.X.Y(...)` directives, when the optimizer
   *  is disabled, or when this evaluator is being used outside the
   *  online-optimizer loop (e.g. built-in strategy templates). The
   *  online optimizer in `script-online-optimizer.ts` produces this map
   *  via `varValuesFrom(result.params)` (post-warmup) or
   *  `preWarmupVarValues()` (pre-warmup, returns each spec's
   *  `defaultValue` so signals can still fire before the optimizer's
   *  lookback window has filled). */
  varValues?: ReadonlyMap<string, number>;
}

export interface AssignOverlay {
  path: string;
  /** AST and source text — the engine routes these into the existing
   *  numericOverrides / filter overlay machinery. Evaluated once at
   *  the first bar; rules-level expressions that vary per-trade are
   *  handled by the existing per-trade resolver. */
  expr: Expr;
  source: string;
}

export interface EvaluateResult {
  signals: BacktestSignal[];
  /** Non-signal `assign` statements (rules.X, filters.X) — passed back
   *  to the engine for routing into the line-based DSL machinery. */
  assigns: AssignOverlay[];
  /** Pre-resolved `let` bindings — each entry's body has had every
   *  earlier let already substituted in (apply-then-store discipline,
   *  see `applyBindings` doc in script-expr.ts). The engine inlines
   *  these into filter.if / ontrade.print / rules.X / Optimize exprs
   *  via `applyBindings` so a `filter.if = (let_var > 0, , )` resolves
   *  correctly even though the entry-context evaluator has no native
   *  let-binding lookup. Empty when the script has no lets or no
   *  strategy-DSL signal block. */
  letBindings: Map<string, Expr>;
  /** `graph = <expr>` (and `graph["Title"] = <expr>`) directives
   *  declared in the strategy script. The dashboard evaluates each
   *  expression at every surviving trade's entry bar and renders a
   *  histogram in Trade Segment Analysis. Each entry's `expr` has had
   *  its `let` dependencies inlined and Kalman dotted-idents rewritten
   *  by the parser, so the dashboard's entry-context evaluator can run
   *  it without further preprocessing. Empty when the script has no
   *  graph directives. */
  graphs: Array<{ title: string; expr: Expr; source: string }>;
  /** `chart = <expr>` (and `chart["Title"[, "#hexcolor"]] = <expr>`)
   *  directives declared in the strategy script. The dashboard
   *  evaluates each expression at EVERY bar in the stitched session
   *  (vs `graphs`, which evaluates only at trade-entry bars) and
   *  passes the resulting time/value series to BacktestScriptChart as
   *  a LineSeries overlay. Each entry's `expr` has had let/Kalman
   *  rewrites applied upstream — same as `graphs`. `color` is the
   *  user-specified hex string (`#3b82f6`) or `null` to auto-cycle
   *  from the renderer's palette. Empty when the script has no chart
   *  directives. */
  charts: Array<{ title: string; color: string | null; expr: Expr; source: string }>;
}

/** Build the resolved-let-bindings map for a parsed strategy script.
 *  Walks `let` statements in declaration order; for each one, applies
 *  the bindings collected so far to the body before storing — so the
 *  resulting map is independent (no entry references another by name)
 *  and can be consumed by `applyBindings(targetExpr, bindings)` at any
 *  later point with no cycle risk. Mirrors how the line-based DSL
 *  parser handles `var X = expr` shadowing. */
export function buildLetBindings(stmts: Stmt[]): Map<string, Expr> {
  const bindings = new Map<string, Expr>();
  for (const s of stmts) {
    if (s.kind !== "let") continue;
    bindings.set(s.name, applyBindings(s.expr, bindings));
  }
  return bindings;
}

/** Run the parsed strategy script over the bar array, producing signals.
 *  Pure: no global state, no I/O. */
export function evaluateStrategyScript(opts: EvaluateOptions): EvaluateResult {
  const { stmts, paramOverrides, bars } = opts;
  const minBarIndex = opts.minBarIndex ?? 0;

  // Partition statements. `letDefs` keeps the raw Expr per name (used
  // by the lazy per-bar resolver in `resolveIdent`) while `letBindings`
  // is the pre-resolved cycle-free map exported back to the engine for
  // AST substitution into filter.if / ontrade.print / rules.X exprs.
  const letDefs = new Map<string, Expr>();
  let signalLong: Expr | null = null;
  let signalShort: Expr | null = null;
  const assigns: AssignOverlay[] = [];
  // `graph = <expr>` directives — collected here and returned so the
  // dashboard can evaluate each expression at every surviving trade's
  // entry bar. By the time we hit this loop the let-inline + Kalman-
  // rewrite passes upstream have already mutated `s.expr` in place, so
  // these exprs are ready for the entry-context evaluator without any
  // additional preprocessing.
  const graphs: Array<{ title: string; expr: Expr; source: string }> = [];
  // `chart = <expr>` directives — collected alongside graphs. The
  // dashboard hands these to BacktestScriptChart for per-bar overlay
  // rendering on the price-chart pane (with auto sub-pane fallback for
  // out-of-range value ranges).
  const charts: Array<{ title: string; color: string | null; expr: Expr; source: string }> = [];

  for (const s of stmts) {
    if (s.kind === "let") {
      letDefs.set(s.name, s.expr);
    } else if (s.kind === "signal") {
      if (s.side === "long") signalLong = s.expr;
      else signalShort = s.expr;
    } else if (s.kind === "graph") {
      graphs.push({ title: s.title, expr: s.expr, source: s.source });
    } else if (s.kind === "chart") {
      charts.push({ title: s.title, color: s.color, expr: s.expr, source: s.source });
    } else {
      assigns.push({ path: s.path, expr: s.expr, source: s.source });
    }
  }

  const letBindings = buildLetBindings(stmts);

  if (!signalLong && !signalShort) {
    return { signals: [], assigns, letBindings, graphs, charts };
  }

  // Build the per-run shared state. Preserve bid/ask volumes so any
  // bid/ask-aware indicator routed through `computeIndicatorSeries`
  // sees the same fields the entry-context evaluator does.
  const indicatorBars: IndicatorBar[] = bars.map((b) => ({
    bar_time: b.bar_time,
    bar_open: b.bar_open,
    bar_high: b.bar_high,
    bar_low: b.bar_low,
    bar_close: b.bar_close,
    bar_volume: b.bar_volume ?? 0,
    bar_volume_bid: b.bar_volume_bid,
    bar_volume_ask: b.bar_volume_ask,
  }));

  // Tick context threading. Build a single ProfileCache up front when
  // ticks are attached — POC(20)/VAH(20)/VAL(20) share the underlying
  // profile build via this cache. Null when there are no ticks; tick
  // indicators then degrade to all-NaN inside `computeIndicatorSeries`.
  const tickCtx = opts.tickCtx;
  const profileCache = tickCtx ? new ProfileCache(bars.length, tickCtx) : null;
  const kalmanCache = new KalmanOuCache(indicatorBars);

  const ctx: BarEvalCtx = {
    bars,
    barIndex: 0,
    params: paramOverrides,
    varValues: opts.varValues ?? EMPTY_VAR_VALUES,
    firingsLong: [],
    firingsShort: [],
    letCache: new Map(),
    letDefs,
    indicatorCache: new Map(),
    indicatorBars,
    rollingCache: new Map(),
    tickCtx,
    profileCache,
    kalmanCache,
  };

  const signals: BacktestSignal[] = [];

  // Round-8 diagnostic — per-bar let-dump for parity drilling. Reads
  // `localStorage.debugDiagDump` once at entry. When set to a JSON
  // object `{fromTime: "HH:mm", toTime: "HH:mm", onDate?: "yyyy-MM-dd"}`
  // and the bar's timestamp falls in the window, after both signal
  // expressions evaluate we dump every let binding's value to the
  // browser console with a structured `DUMP[dashboard] ...` line.
  // Diff this against NT8's matching output (DslStrategyBase's
  // ShouldDumpThisBar / DumpSignalSubConditions) to find the first
  // diverging let. No-op in non-browser contexts (parity-prep, tests).
  const diagDump = readDiagDumpConfig();
  // Letnames in declaration order — Map preserves insertion order.
  // Used for the dump only; the per-bar resolver still uses letDefs.
  const letNames = Array.from(letDefs.keys());

  // Loop starts at 0 (not minBarIndex) so signal expressions evaluate on
  // every bar including the prepended warmup window. That's required for
  // `bars_since(signal.X)` to return the right count at session start —
  // NT8's continuous Calculate.OnBarClose evaluates LongCondition() across
  // session boundaries, and we must mirror that or the cooldown/lock
  // gates (long_in_window, long_locked, …) diverge. Output emission
  // (`signals.push` and the per-bar diag dump) stays gated by
  // `minBarIndex` so the caller's session-local view is unchanged.
  for (let i = 0; i < bars.length; i++) {
    ctx.barIndex = i;
    ctx.letCache.clear();
    const inOutputRange = i >= minBarIndex;
    let firedLong = false;
    if (signalLong) {
      const v = evalNumber(signalLong, ctx);
      if (Number.isFinite(v) && v !== 0) {
        // Track in ALL ranges (incl. warmup) so bars_since(signal.long)
        // at bar `minBarIndex` counts back into the prepended history.
        ctx.firingsLong.push(i);
        firedLong = true;
        if (inOutputRange) signals.push({ barIndex: i, direction: "Long" });
      }
    }
    // A bar can't fire both directions — matches the legacy strategies'
    // explicit `continue` after a long firing.
    if (!firedLong && signalShort) {
      ctx.letCache.clear();
      const v = evalNumber(signalShort, ctx);
      if (Number.isFinite(v) && v !== 0) {
        ctx.firingsShort.push(i);
        if (inOutputRange) signals.push({ barIndex: i, direction: "Short" });
      }
    }

    // Per-bar diag dump — fires after the signal eval so the lets are
    // already cached. We force-evaluate every let in declaration order
    // (signal eval may short-circuit before resolving every let) so the
    // dashboard's dump is directly comparable to NT8's, which evaluates
    // all lets unconditionally on every bar. Gated by `inOutputRange` so
    // warmup-prefixed bars (which also belong to a prior session and get
    // dumped when THAT session runs) don't emit duplicates that would
    // corrupt diff-let-dumps' bar-pair join.
    if (inOutputRange && diagDump && barInDiagWindow(bars[i].bar_time, diagDump)) {
      // Clear letCache and resolve each let fresh — gives us the live
      // value at offset 0 with all dependencies primed.
      ctx.letCache.clear();
      const dump: Record<string, number> = {};
      for (const n of letNames) {
        const def = letDefs.get(n);
        if (!def) continue;
        const val = evalValue(def, ctx);
        const num = typeof val === "number" ? val : val.at(0);
        dump[n] = num;
        ctx.letCache.set(n, val);
      }
      const bar = bars[i];
      // Normalize the timestamp to "yyyy-MM-ddTHH:mm:ss" — the first
      // 19 chars of an ISO string. Drops fractional seconds and TZ
      // offset so the diff tool can join exactly against NT8's
      // ToString("yyyy-MM-ddTHH:mm:ss") output.
      const tNorm = bar.bar_time.slice(0, 19);
      const parts: string[] = [`bar=${i}`, `t=${tNorm}`, `close=${bar.bar_close}`];
      for (const n of letNames) parts.push(`let.${n}=${dump[n]}`);
      // eslint-disable-next-line no-console
      console.log(`DUMP[dashboard] ${parts.join(" ")}`);
    }
  }

  return { signals, assigns, letBindings, graphs, charts };
}

/** Read the per-bar diag-dump config from localStorage. Used by the
 *  round-8 parity drill — diff dashboard vs NT8 let-by-let on selected
 *  bars to find the first diverging sub-component of a signal AND-chain.
 *
 *  The config shape is `{fromTime: "HH:mm", toTime: "HH:mm", onDate?: "yyyy-MM-dd"}`.
 *  Set via devtools: `localStorage.setItem('debugDiagDump', JSON.stringify({fromTime: '07:55', toTime: '08:35', onDate: '2026-01-02'}))`.
 *
 *  Returns null when localStorage is unavailable (Node / SSR / tests),
 *  the key is missing, or the JSON is malformed. The caller treats null
 *  as "dump disabled" — zero overhead beyond a `=== null` check per bar. */
function readDiagDumpConfig(): { fromMin: number; toMin: number; onDate: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem("debugDiagDump");
    if (!raw) return null;
    const cfg = JSON.parse(raw) as { fromTime?: string; toTime?: string; onDate?: string };
    if (!cfg.fromTime || !cfg.toTime) return null;
    const fromMin = parseHmm(cfg.fromTime);
    const toMin = parseHmm(cfg.toTime);
    if (fromMin < 0 || toMin < 0) return null;
    return { fromMin, toMin, onDate: cfg.onDate ?? null };
  } catch {
    return null;
  }
}

/** Parse "HH:mm" into minutes since midnight, or -1 on malformed input. */
function parseHmm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return -1;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return -1;
  return h * 60 + mi;
}

/** Does the given bar_time fall in the configured diag window?
 *  Wrap-around (fromMin > toMin) is supported and matches the time-
 *  filter semantics in DslStrategyBase.TimeFilterPasses.
 *
 *  We parse `bar_time` as a STRING (not a Date) — pulling yyyy-MM-dd
 *  from the first 10 chars and HH:mm from chars 11..16. This matches
 *  exactly what the user sees in the dashboard's CSV (where bar_time
 *  is rendered verbatim) and avoids TZ ambiguity that would otherwise
 *  shift HH:mm depending on whether bar_time has a Z suffix or naive
 *  local TZ. NT8's matching dump uses the same yyyy-MM-dd / HH:mm
 *  format from `Time[0].ToString("...")`, so the two windows align. */
function barInDiagWindow(
  barTime: string,
  cfg: { fromMin: number; toMin: number; onDate: string | null }
): boolean {
  if (cfg.onDate) {
    if (barTime.slice(0, 10) !== cfg.onDate) return false;
  }
  // bar_time format: "yyyy-MM-ddTHH:mm:ss..." — chars 11..13 are HH,
  // 14..16 are mm. Defensive parseInt accepts leading zeros.
  const hh = parseInt(barTime.slice(11, 13), 10);
  const mm = parseInt(barTime.slice(14, 16), 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  const min = hh * 60 + mm;
  if (cfg.fromMin <= cfg.toMin) return min >= cfg.fromMin && min <= cfg.toMin;
  return min >= cfg.fromMin || min <= cfg.toMin;
}

// ─── Evaluation core ───────────────────────────────────────────────────────

/** Evaluate an Expr to a number, coercing SeriesHandle to .at(0). */
function evalNumber(expr: Expr, ctx: BarEvalCtx): number {
  const v = evalValue(expr, ctx);
  if (typeof v === "number") return v;
  // SeriesHandle implicit-at-0 — `let x = high(20)` reads the rolling
  // high at the current bar.
  return v.at(0);
}

/** Evaluate to either number or SeriesHandle. Most callers want
 *  `evalNumber`; `evalValue` is used by the index-node path which
 *  needs to recognize series. */
function evalValue(expr: Expr, ctx: BarEvalCtx): number | SeriesHandle {
  switch (expr.kind) {
    case "num":
      return expr.value;
    case "ident":
      return resolveIdent(expr.name, ctx);
    case "unary": {
      const v = evalNumber(expr.arg, ctx);
      if (expr.op === "-") return -v;
      if (expr.op === "+") return v;
      // Logical NOT
      if (Number.isNaN(v)) return NaN;
      return v === 0 ? 1 : 0;
    }
    case "binop": {
      // Short-circuit logicals — same NaN-as-false discipline as
      // script-expr.ts's evaluator.
      if (expr.op === "&&") {
        const a = evalNumber(expr.lhs, ctx);
        if (!Number.isFinite(a) || a === 0) return 0;
        const b = evalNumber(expr.rhs, ctx);
        return Number.isFinite(b) && b !== 0 ? 1 : 0;
      }
      if (expr.op === "||") {
        const a = evalNumber(expr.lhs, ctx);
        if (Number.isFinite(a) && a !== 0) return 1;
        const b = evalNumber(expr.rhs, ctx);
        return Number.isFinite(b) && b !== 0 ? 1 : 0;
      }
      const a = evalNumber(expr.lhs, ctx);
      const b = evalNumber(expr.rhs, ctx);
      switch (expr.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? NaN : a / b;
        case "%": return b === 0 ? NaN : a % b;
        case "^": return Math.pow(a, b);
        case ">": return Number.isNaN(a) || Number.isNaN(b) ? NaN : a > b ? 1 : 0;
        case "<": return Number.isNaN(a) || Number.isNaN(b) ? NaN : a < b ? 1 : 0;
        case ">=": return Number.isNaN(a) || Number.isNaN(b) ? NaN : a >= b ? 1 : 0;
        case "<=": return Number.isNaN(a) || Number.isNaN(b) ? NaN : a <= b ? 1 : 0;
        case "==": return Number.isNaN(a) || Number.isNaN(b) ? NaN : a === b ? 1 : 0;
        case "!=": return Number.isNaN(a) || Number.isNaN(b) ? NaN : a !== b ? 1 : 0;
      }
      return NaN;
    }
    case "if": {
      const c = evalNumber(expr.cond, ctx);
      if (Number.isNaN(c)) return NaN;
      return c !== 0 ? evalNumber(expr.then, ctx) : evalNumber(expr.else, ctx);
    }
    case "call":
      return evalCall(expr.name, expr.args, ctx);
    case "index":
      return evalIndex(expr.base, expr.offset, ctx);
  }
}

function resolveIdent(name: string, ctx: BarEvalCtx): number | SeriesHandle {
  // 0. Optimizer-driven synthetic vars (`__sopt_<n>__`, `<name>__r<rev>`).
  //    These are minted by `parseStrategyScript` whenever a script uses
  //    `Optimize.X.Y(...)` and resolved per-signal by the online optimizer
  //    via `varValuesFrom()` (post-warmup) or `preWarmupVarValues()`
  //    (pre-warmup → each spec's `default <num>` literal). Missing → NaN
  //    propagates through `cross_up`/`cross_down` and the signal silently
  //    fails to fire — same fail-closed discipline the entry-context
  //    evaluator uses for the same kinds of synthName.
  //    Checked FIRST so the cheap Map lookup short-circuits before more
  //    expensive branches; safe because synthName infixes (`__r`,
  //    `__sopt_`) don't collide with any legal user identifier.
  const synthV = ctx.varValues.get(name);
  if (synthV !== undefined) return synthV;
  // 1. params.X
  if (name.startsWith("params.")) {
    const key = name.slice("params.".length);
    const v = ctx.params[key];
    return typeof v === "number" ? v : NaN;
  }
  // 2. signal.long / signal.short — sentinel idents only meaningful inside
  //    bars_since(...). Bare references return NaN (caller's NaN-as-fail
  //    discipline kicks in).
  if (name === "signal.long" || name === "signal.short") {
    return NaN;
  }
  // 3. `let` bindings — lazily evaluate and cache per bar.
  if (ctx.letDefs.has(name)) {
    const cached = ctx.letCache.get(name);
    if (cached !== undefined) return cached;
    const def = ctx.letDefs.get(name)!;
    const v = evalValue(def, ctx);
    ctx.letCache.set(name, v);
    return v;
  }
  // 4. Current-bar OHLCV scalars.
  const bar = ctx.bars[ctx.barIndex];
  if (!bar) return NaN;
  switch (name) {
    case "open": return bar.bar_open;
    case "high": return bar.bar_high;
    case "low": return bar.bar_low;
    case "close": return bar.bar_close;
    case "volume": return bar.bar_volume ?? NaN;
    case "bar_index": return ctx.barIndex;
    case "range": return bar.bar_high - bar.bar_low;
    case "body": return bar.bar_close - bar.bar_open;
    case "upper_wick": return bar.bar_high - Math.max(bar.bar_open, bar.bar_close);
    case "lower_wick": return Math.min(bar.bar_open, bar.bar_close) - bar.bar_low;
    case "typical": return (bar.bar_high + bar.bar_low + bar.bar_close) / 3;
    case "median_price": return (bar.bar_high + bar.bar_low) / 2;
    case "weighted_close": return (bar.bar_high + bar.bar_low + 2 * bar.bar_close) / 4;
    // Bid/ask order-flow scalars. NaN when the source granularity
    // didn't supply them (plain `ohlcv`), so predicates fail-closed —
    // matches the entry-context evaluator at script-expr.ts:856-877.
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
      if (
        bar.bar_volume_ask == null ||
        bar.bar_volume == null ||
        !Number.isFinite(bar.bar_volume) ||
        bar.bar_volume <= 0
      ) {
        return NaN;
      }
      return bar.bar_volume_ask / bar.bar_volume;
    }
  }
  // 5. Bare-name indicator aliases (ATR, EMA20, ADX14, RSI14, etc.).
  const aliasResolved = resolveBareIndicator(name, ctx);
  if (aliasResolved !== null) return aliasResolved;
  return NaN;
}

function resolveBareIndicator(name: string, ctx: BarEvalCtx): number | null {
  // ATR / ATR14 → ATR(14). Period-suffixed forms recognized via regex.
  if (name === "ATR" || name === "ATR14") return getIndicator("ATR", 14, ctx);
  if (name === "ADX" || name === "ADX14") return getIndicator("ADX", 14, ctx);
  if (name === "RSI" || name === "RSI14") return getIndicator("RSI", 14, ctx);
  const m = name.match(/^(ATR|EMA|SMA|ADX|RSI)(\d+)$/);
  if (m) {
    const period = parseInt(m[2], 10);
    if (Number.isFinite(period) && period > 0) {
      return getIndicator(m[1], period, ctx);
    }
  }
  return null;
}

function evalCall(name: string, args: Expr[], ctx: BarEvalCtx): number | SeriesHandle {
  // ── Special forms (no eager arg eval) ───────────────────────────────
  if (name === "any_bar_in") return evalAnyBarIn(args, ctx);
  if (name === "bars_since") return evalBarsSince(args, ctx);

  // ── Series-returning helpers ─────────────────────────────────────────
  if (name === "high") return rollingExtremumSeries("high", args, ctx);
  if (name === "low") return rollingExtremumSeries("low", args, ctx);

  // ── Bar-distance helpers ────────────────────────────────────────────
  // bars_since_high(N): bars elapsed since the highest bar.high in the
  // last N bars (current bar EXCLUDED). Match the legacy v1 strategies'
  // `i - highIdx` computation, where highIdx is the argmax of the
  // forward-iterated window — first occurrence wins on ties.
  if (name === "bars_since_high" || name === "bars_since_low") {
    if (args.length !== 1) return NaN;
    const period = Math.round(evalNumber(args[0], ctx));
    if (!Number.isFinite(period) || period <= 0) return NaN;
    const fn = name === "bars_since_high" ? "high" : "low";
    const key = `bs_${fn}:${period}`;
    let series = ctx.rollingCache.get(key);
    if (!series) {
      series = computeBarsSinceExtremum(ctx.bars, period, fn);
      ctx.rollingCache.set(key, series);
    }
    if (ctx.barIndex < 0 || ctx.barIndex >= series.length) return NaN;
    const v = series[ctx.barIndex];
    return Number.isFinite(v) ? v : NaN;
  }

  // cross_up(a, b): true if the value of `a` was less than `b` on the
  // PREVIOUS bar AND is greater than or equal to `b` on the CURRENT bar.
  // Matches the conventional TradingView/PineScript semantics.
  if (name === "cross_up" || name === "cross_down") {
    if (args.length !== 2) return NaN;
    // Evaluate at current bar.
    const aNow = evalNumber(args[0], ctx);
    const bNow = evalNumber(args[1], ctx);
    // Evaluate at previous bar — shift the ctx and re-eval. Clear letCache
    // because lets at bar i-1 may differ from bar i.
    if (ctx.barIndex < 1) return 0;
    const prevCtx: BarEvalCtx = {
      ...ctx,
      barIndex: ctx.barIndex - 1,
      letCache: new Map(),
    };
    const aPrev = evalNumber(args[0], prevCtx);
    const bPrev = evalNumber(args[1], prevCtx);
    if (
      !Number.isFinite(aNow) || !Number.isFinite(bNow) ||
      !Number.isFinite(aPrev) || !Number.isFinite(bPrev)
    ) {
      return NaN;
    }
    if (name === "cross_up") {
      return aPrev < bPrev && aNow >= bNow ? 1 : 0;
    }
    return aPrev > bPrev && aNow <= bNow ? 1 : 0;
  }

  // ── Math passthroughs (evaluate args, apply Math.X) ──────────────────
  switch (name) {
    case "abs": return Math.abs(evalNumber(args[0], ctx));
    case "min": return Math.min(...args.map((a) => evalNumber(a, ctx)));
    case "max": return Math.max(...args.map((a) => evalNumber(a, ctx)));
    case "floor": return Math.floor(evalNumber(args[0], ctx));
    case "ceil": return Math.ceil(evalNumber(args[0], ctx));
    case "round": return Math.round(evalNumber(args[0], ctx));
    case "sqrt": return Math.sqrt(evalNumber(args[0], ctx));
    case "log": return Math.log(evalNumber(args[0], ctx));
    case "exp": return Math.exp(evalNumber(args[0], ctx));
    case "pow": return Math.pow(evalNumber(args[0], ctx), evalNumber(args[1], ctx));
  }

  // ── Indicator function calls — delegate to the canonical dispatch
  //    shared with the entry-context evaluator. Covers ATR/EMA/SMA/ADX/
  //    RSI plus the entire extended library (BB_*, MACD_*, Stoch_*,
  //    Keltner_*, Supertrend, PSAR, Ichimoku_*, Aroon_*, Vortex*, DI*,
  //    UO, Fisher, Choppiness, Ulcer, KVO, ForceIndex, EMV, Zscore,
  //    LR*, R2, VWAP, OBV, AD, TR, NVI, PVI, AO, CVD) AND the new
  //    tick-resolution indicators (POC/VAH/VAL/VA_width/dist_to_POC,
  //    trades_at_bid, trades_at_ask, tick_imbalance, tick_count,
  //    mean_trade_size, large_trade_count, vwap_tick).
  //
  // Zero-arg families (OBV, AD, TR, CVD, AO, NVI, PVI) take no period;
  // route them with an empty args array. All others go through the
  // standard "evaluate args, reject non-finite/non-positive, round
  // unless fractional" pipeline that mirrors evalCallEntry in
  // script-expr.ts (lines 1100-1118).
  if (ZERO_ARG_INDICATORS.has(name)) {
    return getIndicatorAt(name, [], ctx);
  }
  // znorm(expr, N) / mmnorm(expr, N) — rolling normalizer over an
  // arbitrary inner expression. The inner expr is NOT eagerly evaluated
  // here; we build a lazy series the first time the call is referenced,
  // evaluating the inner expr at every bar with a cleared letCache so
  // any bindings inside the expr re-evaluate per bar. Subsequent
  // references at later bars just index into the cached series.
  // Special-cased BEFORE the isKnownIndicator branch so we don't fall
  // into the eager-arg-eval indicator path (which would treat args[0] as
  // a number and reject it as non-positive).
  if ((name === "znorm" || name === "mmnorm") && args.length === 2) {
    if (args[1].kind !== "num") return NaN;
    const period = Math.round(args[1].value);
    if (!Number.isFinite(period) || period <= 0) return NaN;
    const innerExpr = args[0];
    const key = normalizerKey(name, period, innerExpr);
    let series = ctx.indicatorCache.get(key);
    if (!series) {
      const inner = new Array<number>(ctx.bars.length).fill(NaN);
      for (let i = 0; i < ctx.bars.length; i++) {
        const innerCtx: BarEvalCtx = {
          ...ctx,
          barIndex: i,
          letCache: new Map(),
        };
        const v = evalNumber(innerExpr, innerCtx);
        inner[i] = Number.isFinite(v) ? v : NaN;
      }
      series = rollingNormalize(name, inner, period);
      ctx.indicatorCache.set(key, series);
    }
    if (ctx.barIndex < 0 || ctx.barIndex >= series.length) return NaN;
    const v = series[ctx.barIndex];
    return Number.isFinite(v) ? v : NaN;
  }
  if (isKnownIndicator(name)) {
    const allowFractional = FRACTIONAL_ARG_INDICATORS.has(name);
    const evaluated: number[] = [];
    for (const a of args) {
      const v = evalNumber(a, ctx);
      if (!Number.isFinite(v) || v <= 0) return NaN;
      evaluated.push(allowFractional ? v : Math.round(v));
    }
    return getIndicatorAt(name, evaluated, ctx);
  }

  return NaN;
}

function evalIndex(base: Expr, offset: Expr, ctx: BarEvalCtx): number {
  const k = Math.round(evalNumber(offset, ctx));
  if (!Number.isFinite(k) || k < 0) return NaN;
  // If base evaluates to a SeriesHandle, just call .at(k).
  // Otherwise re-evaluate base in a context shifted by k bars (with a
  // cleared letCache, since lets are per-bar). This handles bare OHLCV
  // idents (`close[5]`), shifted indicator calls (`ATR(14)[5]`), and
  // arbitrary expressions.
  // Try the SeriesHandle path first by evaluating base in the current ctx.
  const baseValue = evalValue(base, ctx);
  if (isSeries(baseValue)) return baseValue.at(k);
  // Scalar — re-evaluate at shifted bar.
  if (ctx.barIndex - k < 0) return NaN;
  const shiftedCtx: BarEvalCtx = {
    ...ctx,
    barIndex: ctx.barIndex - k,
    letCache: new Map(),
  };
  return evalNumber(base, shiftedCtx);
}

// ─── Special forms ────────────────────────────────────────────────────────

function evalAnyBarIn(args: Expr[], ctx: BarEvalCtx): number {
  if (args.length !== 2) return NaN;
  const N = Math.round(evalNumber(args[0], ctx));
  if (!Number.isFinite(N) || N <= 0) return 0;
  // For each k in 0..N-1, evaluate the condition at bar (barIndex - k)
  // with a cleared letCache (full re-eval per inner bar — confirmed
  // user decision). OR-reduce.
  for (let k = 0; k < N; k++) {
    const innerBar = ctx.barIndex - k;
    if (innerBar < 0) break;
    const innerCtx: BarEvalCtx = {
      ...ctx,
      barIndex: innerBar,
      letCache: new Map(),
    };
    const v = evalNumber(args[1], innerCtx);
    if (Number.isFinite(v) && v !== 0) return 1;
  }
  return 0;
}

function evalBarsSince(args: Expr[], ctx: BarEvalCtx): number {
  if (args.length !== 1) return NaN;
  const arg = args[0];
  // Fast path — `bars_since(signal.long)` / `bars_since(signal.short)`.
  if (arg.kind === "ident" && (arg.name === "signal.long" || arg.name === "signal.short")) {
    const firings = arg.name === "signal.long" ? ctx.firingsLong : ctx.firingsShort;
    if (firings.length === 0) return Number.POSITIVE_INFINITY;
    const last = firings[firings.length - 1];
    return ctx.barIndex - last;
  }
  // Generic: walk back from current bar until the condition was true.
  // Cap at the array length to avoid pathological loops on never-true
  // conditions.
  for (let k = 0; k < ctx.bars.length; k++) {
    const innerBar = ctx.barIndex - k;
    if (innerBar < 0) break;
    const innerCtx: BarEvalCtx = {
      ...ctx,
      barIndex: innerBar,
      letCache: new Map(),
    };
    const v = evalNumber(arg, innerCtx);
    if (Number.isFinite(v) && v !== 0) return k;
  }
  return Number.POSITIVE_INFINITY;
}

// ─── Series-returning helpers ─────────────────────────────────────────────

/** Build a SeriesHandle for the rolling `period`-bar high or low,
 *  EXCLUDING the current bar. Matches the legacy strategies' inner-loop
 *  convention: `for j in (i-period..i-1): max(bars[j].high)`. The
 *  precomputed array is cached on ctx.rollingCache. */
function rollingExtremumSeries(
  fn: "high" | "low",
  args: Expr[],
  ctx: BarEvalCtx
): SeriesHandle {
  if (args.length !== 1) {
    return makeSeries(() => NaN);
  }
  // Period must be constant — evaluate at current bar (a let-binding-
  // expressed period is fine because lets are resolved with current
  // values). If the period is dynamic across bars, we'd need a different
  // approach; that's a documented limitation.
  const period = Math.round(evalNumber(args[0], ctx));
  if (!Number.isFinite(period) || period <= 0) {
    return makeSeries(() => NaN);
  }
  const key = `${fn}:${period}`;
  let series = ctx.rollingCache.get(key);
  if (!series) {
    series = computeRollingExtremum(ctx.bars, period, fn);
    ctx.rollingCache.set(key, series);
  }
  const seriesRef = series;
  return makeSeries((k) => {
    const idx = ctx.barIndex - k;
    if (idx < 0 || idx >= seriesRef.length) return NaN;
    const v = seriesRef[idx];
    return Number.isFinite(v) ? v : NaN;
  });
}

function computeRollingExtremum(
  bars: ReplayBar[],
  period: number,
  fn: "high" | "low"
): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  // out[i] = max/min of bars[i-period..i-1]. Naive O(N*P) — fine for
  // typical lookbacks (5-200 bars) over moderate session sizes. Could
  // be O(N) with a monotonic deque if profiling demands.
  for (let i = period; i < bars.length; i++) {
    if (fn === "high") {
      let m = -Infinity;
      for (let j = i - period; j < i; j++) {
        const h = bars[j].bar_high;
        if (h > m) m = h;
      }
      out[i] = m === -Infinity ? NaN : m;
    } else {
      let m = Infinity;
      for (let j = i - period; j < i; j++) {
        const l = bars[j].bar_low;
        if (l < m) m = l;
      }
      out[i] = m === Infinity ? NaN : m;
    }
  }
  return out;
}

/** Compute, for each bar i, the bar-distance back to the argmax/argmin
 *  of bars[i-period..i-1]. Mirrors the legacy v1 strategies' inner-loop
 *  convention: forward iteration with strict `>` / `<` comparison, so
 *  ties go to the FIRST occurrence (= the LARGEST distance). NaN for
 *  i < period (warmup). */
function computeBarsSinceExtremum(
  bars: ReplayBar[],
  period: number,
  fn: "high" | "low"
): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  for (let i = period; i < bars.length; i++) {
    let argIdx = i - period;
    let m = fn === "high" ? bars[argIdx].bar_high : bars[argIdx].bar_low;
    for (let j = i - period + 1; j < i; j++) {
      const v = fn === "high" ? bars[j].bar_high : bars[j].bar_low;
      if (fn === "high" ? v > m : v < m) {
        m = v;
        argIdx = j;
      }
    }
    out[i] = i - argIdx;
  }
  return out;
}

// ─── Indicator dispatch ────────────────────────────────────────────────────

/** Single-period entry point used by `resolveBareIndicator` for the
 *  legacy bare aliases (`ATR`, `ATR14`, `EMA20`, `RSI14`, …). Forwards
 *  to `getIndicatorAt` which handles all argument shapes. */
function getIndicator(name: string, period: number, ctx: BarEvalCtx): number {
  return getIndicatorAt(name, [period], ctx);
}

/** Resolve any indicator call against the per-run cache, computing the
 *  full series on first request and indexing into it at the current bar.
 *  The dispatch goes through `computeIndicatorSeries` from script-expr.ts
 *  so the strategy DSL stays in lock-step with the entry-context DSL —
 *  every named indicator there works here, including the tick-resolution
 *  ones when `ctx.tickCtx` is populated. Cache key matches what the
 *  entry-context evaluator builds via `indicatorKeyForCall`, so a future
 *  shared cache (or precompute reuse) is straightforward. */
function getIndicatorAt(
  name: string,
  rawArgs: number[],
  ctx: BarEvalCtx,
): number {
  const args = applyArgDefaults(name, rawArgs);
  const key = indicatorKeyForCall(name, args);
  if (!key) return NaN;
  let series = ctx.indicatorCache.get(key);
  if (!series) {
    const computed = computeIndicatorSeries(
      name,
      args,
      ctx.indicatorBars,
      ctx.tickCtx,
      ctx.profileCache,
      ctx.kalmanCache,
    );
    if (!computed) return NaN;
    series = computed;
    ctx.indicatorCache.set(key, series);
  }
  if (ctx.barIndex < 0 || ctx.barIndex >= series.length) return NaN;
  const v = series[ctx.barIndex];
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

// ─── Symbol catalog (for the editor) ──────────────────────────────────────

/** Strategy-DSL-only symbols added on top of EXPR_SYMBOLS. The editor
 *  merges these with EXPR_SYMBOLS for hover/autocomplete in strategy
 *  scripts. */
export const STRATEGY_SYMBOLS = [
  ...EXPR_SYMBOLS,
  {
    name: "high",
    kind: "call" as const,
    signature: "high(N)",
    description: "Rolling N-bar HIGH (max of bar.high over the last N bars, EXCLUDING the current bar). Returns a series — use `[k]` to look back, e.g. `high(20)[5]` is the 20-bar high evaluated 5 bars ago. Bare use coerces to the current-bar value.",
    context: "entry" as const,
  },
  {
    name: "low",
    kind: "call" as const,
    signature: "low(N)",
    description: "Rolling N-bar LOW (min of bar.low over the last N bars, EXCLUDING the current bar). Returns a series — use `[k]` to look back. Bare use coerces to the current-bar value.",
    context: "entry" as const,
  },
  {
    name: "any_bar_in",
    kind: "call" as const,
    signature: "any_bar_in(N, condition)",
    description: "True (1) if `condition` was true on ANY of the last N bars (current bar inclusive). The condition is evaluated with a fresh context per inner bar — `let` bindings, OHLCV, and indicator calls all rebind to the inner bar.",
    context: "entry" as const,
  },
  {
    name: "bars_since",
    kind: "call" as const,
    signature: "bars_since(condition)",
    description: "Bars elapsed since `condition` was last true. Special case: `bars_since(signal.long)` / `bars_since(signal.short)` returns the distance to the most recent prior firing of THIS strategy's long/short signal. Returns +Infinity if the condition has never been true.",
    context: "entry" as const,
  },
  {
    name: "cross_up",
    kind: "call" as const,
    signature: "cross_up(a, b)",
    description: "True (1) if `a` crossed up through `b` on the current bar — i.e. `a < b` on the previous bar AND `a >= b` on the current bar. Returns 0/1 or NaN if any input is missing.",
    context: "entry" as const,
  },
  {
    name: "cross_down",
    kind: "call" as const,
    signature: "cross_down(a, b)",
    description: "True (1) if `a` crossed down through `b` on the current bar.",
    context: "entry" as const,
  },
  {
    name: "KALMAN_OU",
    kind: "call" as const,
    signature: "KALMAN_OU(source, calib=60, trust=0.5)",
    description: "Kalman-filtered Ornstein-Uhlenbeck mean-reversion estimator. ONLY usable as a let-binding; the binding exposes five fields via member access — `kf.x` (filtered state estimate), `kf.mu` (long-run mean from calibration), `kf.sigma` (long-run unconditional std, the natural z-score divisor), `kf.phi` (AR(1) persistence), `kf.P` (current posterior state variance). `source` must be one of close/open/high/low/typical/median_price/weighted_close. `calib` is the calibration window in bars. `trust` ∈ (0,1) controls the steady-state Kalman gain (small = heavy smoothing, large = closer to raw price). Recalibration is currently 'once' (frozen after the calib window).",
    context: "entry" as const,
    examples: [
      {
        snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nlet z = (close - kf.x) / kf.sigma\nsignal.long.if = cross_down(z, -params.entryZ)",
        scenario: "Mean-reversion long when price dives more than entryZ standard deviations below the Kalman estimate.",
      },
    ],
  },
  {
    name: "signal.long",
    kind: "ident" as const,
    description: "Sentinel identifier referring to the firings of this strategy's long signal. Only meaningful inside `bars_since(signal.long)`.",
    context: "entry" as const,
  },
  {
    name: "signal.short",
    kind: "ident" as const,
    description: "Sentinel identifier referring to the firings of this strategy's short signal. Only meaningful inside `bars_since(signal.short)`.",
    context: "entry" as const,
  },
  {
    name: "let",
    kind: "operator" as const,
    signature: "let name = expr",
    description: "Bind a value to a name for use later in the script. Bindings are inlined at parse time AND lazily evaluated per bar — references rebind at each bar, so `let atr = ATR(14)` reads the current-bar ATR. Inside `any_bar_in`, lets re-evaluate at the inner bar.",
    context: "entry" as const,
  },
  {
    name: "signal.long.if",
    kind: "operator" as const,
    signature: "signal.long.if = <bool expression>",
    description: "Defines when the strategy fires a LONG signal. Evaluated at every bar; truthy result fires (and records the firing for `bars_since(signal.long)`).",
    context: "entry" as const,
  },
  {
    name: "signal.short.if",
    kind: "operator" as const,
    signature: "signal.short.if = <bool expression>",
    description: "Defines when the strategy fires a SHORT signal. A bar that fires LONG cannot also fire SHORT (long takes precedence — same convention as the legacy hardcoded strategies).",
    context: "entry" as const,
  },
  {
    name: ",",
    kind: "operator" as const,
    signature: "a, b, c",
    description: "Sugar for `&&` at the same precedence — useful for vertical-stacking many gates. `a, b, c || d, e, f` parses as `(a && b && c) || (d && e && f)`. Inside function-call arg lists (`min(a, b)`), `,` keeps separator meaning.",
    context: "entry" as const,
  },
  {
    name: "[",
    kind: "operator" as const,
    signature: "expr[N]",
    description: "Postfix index — look back N bars on a series-producing expression. `high(20)[5]` is the 20-bar high evaluated 5 bars ago. Bare OHLCV idents support indexing too: `close[5]` is the close 5 bars ago.",
    context: "entry" as const,
  },
];
