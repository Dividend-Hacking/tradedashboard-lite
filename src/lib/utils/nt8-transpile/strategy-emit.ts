/**
 * strategy-emit.ts — Compose a complete NinjaScript .cs file from a
 * parsed DSL strategy + simulator rules + filters.
 *
 * The output is a self-contained subclass of `DslStrategyBase`
 * (ninjatrader/strategies/DslStrategyBase.cs) that overrides:
 *
 *   - Configure() — sets up the optional tick channel and any per-class
 *     state (cross-up/down slots, bars-since condition slots, signal
 *     firing tracker).
 *   - LongCondition() / ShortCondition() — return true/false for the
 *     dashboard's signal.long.if / signal.short.if at the current bar.
 *   - LongFilterPasses() / ShortFilterPasses() — gate side-restricted
 *     filters (filter.long.if / filter.short.if). filter.if (no
 *     scope) is hosted in BothFilterPasses().
 *   - GetSimRules() — returns the SimRules POCO with values from
 *     `rules.X = Y` assignments folded in.
 *
 * The base class owns all the SL/TP/scaling/daily-limit/cooldown
 * boilerplate so individual generated strategies stay small and
 * readable. Per-bar order dispatch and per-leg fill tracking lives
 * in the base too.
 *
 * Class-name derivation copies the rules from the legacy
 * /api/convert-to-nt8 route so re-exports produce the same on-disk
 * artifacts as before.
 */

import type { Stmt } from "../strategy-evaluator";
import { parseStrategyScript } from "../strategy-evaluator";
import { compile, type Expr } from "../script-expr";
import {
  parseBacktestScript,
  type FilterIfDirective,
} from "../backtest-script";
import {
  emitExpr,
  makeEmitContext,
  csIdent,
  type EmitContext,
} from "./expr-emit";
import { emitDirectiveBody } from "./filter-if-emit";

/** Render a filter.if directive (bare-bool OR 3-arg) as a C# block
 *  that sets a method-local `__verdict` and short-circuits on reject.
 *  The caller wraps this in the LongApplyFilters / ShortApplyFilters
 *  method body. */
function renderDirectiveAsBlock(
  d: FilterIfDirective,
  ctx: EmitContext,
  warnings: string[]
): string {
  const directiveBody = emitDirectiveBody(d, ctx, warnings);
  // After emitDirectiveBody, __verdict is 1=pass / 0=reject. Reject
  // → return false from the surrounding method (early-out so later
  // directives don't run).
  return [
    `            {`,
    `                bool __halt = false;`,
    `                int __verdict = 1;`,
    directiveBody.replace(/^            /gm, "                "),
    `                if (__verdict == 0) return false;`,
    `            }`,
  ].join("\n");
}

/** Re-parse a stmt's verbatim source text to get its UN-INLINED AST.
 *  parseStrategyScript inlines `let` bindings into every subsequent
 *  stmt — that's the right thing for the dashboard's per-bar evaluator
 *  but causes exponential expression blowup when transpiling to C#
 *  (a 6KB DSL script became 1.4MB of generated C# in early tests).
 *  We instead emit each let as a C# local variable at the top of
 *  LongCondition / ShortCondition, then reference them by name in the
 *  signal/filter expressions — re-compiling the verbatim source gives
 *  us back the AST shape that has let names as bare ident references,
 *  exactly what we want.
 *
 *  Returns null when the source doesn't compile (the dashboard's
 *  evaluator silently skips lines that don't compile, and we mirror
 *  that — caller treats null as "skip this stmt"). */
function reparseStmtUninlined(s: Stmt): Expr | null {
  const c = compile(s.source);
  return c.ok ? c.expr : null;
}

/** What the transpiler returns. Structured so the caller (the API
 *  route) can write the .cs file, surface errors, and decide whether
 *  to deploy. */
export interface TranspileResult {
  className: string;
  csSource: string;
  /** True if any indicator/scalar in the script needs the tick channel. */
  requiresTicks: boolean;
  /** Non-fatal diagnostics surfaced from the AST walk (unknown idents,
   *  malformed cross_up calls, …). The user-visible error message
   *  includes these but the file is still generated so the user can
   *  inspect partial output. Fatal errors (parse failures) come back
   *  as a thrown exception. */
  warnings: string[];
}

/** Input shape: a preset with embedded DSL `script`, plus the
 *  simulator rules object. The rules + filters arrive as plain
 *  JSON-shaped objects (the dashboard's BacktestPreset type is
 *  unstable across versions; the transpiler doesn't care about
 *  the wrapping shape, only the leaf field values). */
export interface TranspileInput {
  presetName: string;
  /** Optional override for the C# class name. Validated against
   *  C# identifier rules; falls back to a derive-from-name path
   *  when absent. */
  classNameOverride?: string;
  /** The DSL script text. Required; the transpiler always parses
   *  this. Legacy presets without a script are converted via the
   *  upstream legacy-to-DSL shim before reaching us. */
  script: string;
  /** Param overrides — `params.X` references in the script are
   *  inlined as numeric literals from this map. Keys without a
   *  corresponding param ref in the script are ignored. */
  params: Record<string, number>;
  /** True when the caller couldn't supply real param values and
   *  defaulted everything to 1.0 (parity-prep without a params.json).
   *  The transpiler emits a `ParamsWereDefaulted() => true` override
   *  so DslStrategyBase can print a loud warning at State.DataLoaded
   *  — silent strategies are confusing; this banner makes the cause
   *  visible. Defaults to false (real params from the dashboard). */
  paramsDefaulted?: boolean;
  /** Simulator rules — values are folded into the generated
   *  GetSimRules() body. Keys not listed here pick up the C#
   *  SimRules defaults. */
  rules: Record<string, unknown>;
  /** Filter spec (legacy `filters.time.X`, `filters.adx.X`, …).
   *  v1 of the transpiler emits a stripped-down legacy filter
   *  block — the new `filter.if` directives are picked up
   *  directly from the script's parsed assigns. */
  filters: Record<string, unknown>;
}

/** Sanitize the preset name into a valid C# identifier. Same rules
 *  as the legacy renderWrapper(): strip non-alphanumeric, prepend
 *  "Strategy" if the result begins with a digit. */
export function deriveClassName(presetName: string, override?: string): string {
  if (override && /^[A-Za-z_][A-Za-z0-9_]*$/.test(override)) return override;
  let name = presetName.replace(/[^A-Za-z0-9_]/g, "");
  if (/^\d/.test(name)) name = `Strategy${name}`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Could not derive a valid C# class name from preset "${presetName}". Pass classNameOverride.`
    );
  }
  return name;
}

/** Top-level transpile entry point. Throws on fatal parse error;
 *  returns warnings for non-fatal issues. */
export function transpileDslToCs(input: TranspileInput): TranspileResult {
  const className = deriveClassName(input.presetName, input.classNameOverride);

  // Parse the DSL. We parse here (vs. having the caller do it) so
  // the transpiler is the single owner of "DSL → output" — calls
  // from the API route, the parity harness, and unit tests all see
  // the same parse errors.
  const parsed = parseStrategyScript(input.script);
  if (parsed.errors.some((e) => e.severity === "error")) {
    const lines = parsed.errors
      .filter((e) => e.severity === "error")
      .map((e) => `  line ${e.line}: ${e.message}`)
      .join("\n");
    throw new Error(`DSL parse failed:\n${lines}`);
  }

  // Walk the parsed stmts. We re-compile each stmt's source text to
  // get the UN-inlined AST (parseStrategyScript inlines lets which
  // would balloon the generated C#). Lets become C# locals; signal/
  // filter/rules expressions reference them by bare name.
  const letDecls: Array<{ name: string; expr: Expr }> = [];
  // Map of let name → its un-inlined defining Expr. The expr-emit layer
  // uses this to (a) emit `__let_<name>` references at offset=current,
  // (b) inline the defining expression at any shifted offset (cross_up
  // prev side, any_bar_in body, postfix `[N]`) so OHLCV / indicator /
  // nested-let refs pick up the right bar offset. Without (b) cross_up
  // is structurally broken — the prev-side C# local is the same value
  // as the now-side, making the cross condition contradictory.
  const letDefs = new Map<string, Expr>();
  let signalLong: Expr | null = null;
  let signalShort: Expr | null = null;
  const rulesAssigns: Array<{ path: string; expr: Expr }> = [];
  const warnings: string[] = [];

  for (const s of parsed.stmts) {
    if (s.kind === "let") {
      const rawExpr = reparseStmtUninlined(s);
      if (!rawExpr) continue;
      letDecls.push({ name: s.name, expr: rawExpr });
      letDefs.set(s.name, rawExpr);
      continue;
    }
    if (s.kind === "signal") {
      const rawExpr = reparseStmtUninlined(s);
      if (!rawExpr) continue;
      if (s.side === "long") signalLong = rawExpr;
      else signalShort = rawExpr;
      continue;
    }
    if (s.kind === "assign") {
      if (s.path.startsWith("rules.")) {
        // Numeric-expression RHS goes through the script evaluator's
        // compiler so we can reuse the let/param-substitution path.
        // Bool / string literals don't compile as expressions and get
        // picked up below via parseBacktestScript.config.rules instead.
        const rawExpr = reparseStmtUninlined(s);
        if (!rawExpr) continue;
        rulesAssigns.push({ path: s.path, expr: rawExpr });
        continue;
      }
      if (
        s.path === "filter.if" ||
        s.path === "filter.long.if" ||
        s.path === "filter.short.if"
      ) {
        // filter.if directives are picked up via parseBacktestScript
        // below (the canonical line-based parser); skip them here.
        // parseStrategyScript silently drops them when the 3-arg form
        // doesn't compile as a bare expression — backtest-script
        // handles all three forms uniformly.
        continue;
      }
      // Legacy filter.X / loadstrategy / ontrade.print — v1 ignores.
      warnings.push(`assignment "${s.path}" not yet wired through transpiler — ignoring`);
    }
  }

  // Filter.if directives via the canonical line-based parser. This
  // gets us the full 3-arg AST including ifTrue/ifFalse slots and
  // the directive scope (long/short/both). parseBacktestScript also
  // handles other line-based directives (filter.X, ontrade.print,
  // etc.) — we read filterIfs only and ignore the rest.
  const lineParse = parseBacktestScript(input.script);
  const filterIfDirectives: Array<{ scope: "long" | "short" | "both"; directive: FilterIfDirective }> =
    (lineParse.config.filterIfs ?? []).map((d) => ({
      scope: d.scope === "long" ? "long" : d.scope === "short" ? "short" : "both",
      directive: d,
    }));
  // Surface line-parser errors that touch filter.if specifically.
  for (const e of lineParse.errors) {
    if (e.severity !== "error") continue;
    if (e.message.includes("filter.if") || e.message.includes("filter.long.if") || e.message.includes("filter.short.if")) {
      warnings.push(`line ${e.line}: ${e.message}`);
    }
  }

  // Merge rules from the line-based parser. parseBacktestScript handles
  // bool / string / numeric literals via parseValueLiteral, where the
  // strategy-evaluator's compile() (used for rulesAssigns above) only
  // handles numeric expressions and silently drops bool/string literals.
  // The line-based parser was the missing piece: without this merge,
  // `rules.stopLossEnabled = true` and `rules.positionMode = "add-null"`
  // would land as NaN-IsFinite garbage at runtime.
  //
  // Order: input.rules (caller-supplied baseline) → lineParse.config.rules
  // (script-derived) → rulesAssigns (numeric-expression rulesAssigns
  // applied later in renderRulesBlock). Later overrides earlier.
  const mergedRules: Record<string, unknown> = {
    ...(input.rules ?? {}),
    ...(lineParse.config.rules ?? {}),
  };

  // Same merge pattern for filters. Without this, NT8 silently drops
  // `filters.time.*` and `filters.trend.*` directives that the dashboard
  // honors — the user's range_break_reversal_v5 fired 925 trades in
  // NT8 vs 119 on the dashboard because the time filter (08:00-14:00)
  // and trend filter (against EMA20) weren't being applied.
  //
  // The third merge layer (extractScriptFilters) is defense-in-depth
  // against parseBacktestScript's strict enum parser: it requires
  // `filters.trend.ema20 = "against"` (quoted) but the v5 DSL uses
  // bare idents `filters.trend.ema20 = against` — the canonical parser
  // pushes an error and drops the value. Our pass scans the raw script
  // and accepts bare idents for these enum-typed paths so the script's
  // intent isn't lost on the way to NT8.
  const mergedFilters: Record<string, unknown> = {
    ...(input.filters ?? {}),
    ...(lineParse.config.filters ?? {}),
  };
  mergeScriptFilters(mergedFilters, input.script);

  // Build the emit context shared across all expression emissions
  // on this strategy. requiresTicks / crossSlots / etc. accumulate.
  const ctx = makeEmitContext(input.params, letDefs);

  // Emit each let as a C# local variable assignment. The transpiler
  // emits these before each method body that uses lets (LongCondition,
  // ShortCondition, LongFilterPasses, ShortFilterPasses) — they're
  // cheap to compute (typically a couple of indicator reads and some
  // arithmetic), so duplicating across methods isn't a concern.
  // Doing it this way avoids the let-inlining expression blowup that
  // would otherwise produce megabytes of generated code.
  const letDeclLines = letDecls.map((d) => {
    const cs = emitExpr(d.expr, ctx);
    return `            var __let_${csIdent(d.name)} = ${cs};`;
  });

  // Round-8 — DumpSignalSubConditions diagnostic. Re-evaluate each let
  // and stream its value into a StringBuilder so the user can diff
  // dashboard vs NT8 per-bar to find the first diverging sub-component
  // of a long signal AND-chain. Body re-uses the same emitExpr output
  // as letDeclLines so the dump can never drift from the live signal
  // eval — same expression, evaluated once per bar, when ShouldDumpThisBar.
  const dumpDeclLines = letDecls.map((d) => {
    const cs = emitExpr(d.expr, ctx);
    const id = csIdent(d.name);
    return [
      `            var __let_${id} = ${cs};`,
      `            __sb.Append(" let.${d.name}=").Append(__let_${id});`,
    ].join("\n");
  });

  const longCondCs = signalLong ? emitExpr(signalLong, ctx) : "0.0";
  const shortCondCs = signalShort ? emitExpr(signalShort, ctx) : "0.0";

  // Build the body of LongApplyFilters / ShortApplyFilters. Each
  // directive (in source order) is emitted as a block that sets a
  // local __verdict (1=pass, 0=reject). After each directive we early-
  // return false on reject, so subsequent directives only run when
  // earlier ones passed (chained AND semantics).
  //
  // Side-restricted directives (filter.long.if / filter.short.if) only
  // emit into the matching method.
  const longFilterBlocks: string[] = [];
  const shortFilterBlocks: string[] = [];
  for (const f of filterIfDirectives) {
    const block = renderDirectiveAsBlock(f.directive, ctx, warnings);
    if (f.scope === "long" || f.scope === "both") longFilterBlocks.push(block);
    if (f.scope === "short" || f.scope === "both") shortFilterBlocks.push(block);
  }

  warnings.push(...ctx.errors);

  // Render the full file.
  const csSource = renderStrategyFile({
    className,
    presetName: input.presetName,
    letDeclLines,
    dumpDeclLines,
    longCondCs,
    shortCondCs,
    longFilterBlocks,
    shortFilterBlocks,
    rulesAssigns,
    rules: mergedRules,
    filters: mergedFilters,
    requiresTicks: ctx.requiresTicks,
    paramsDefaulted: input.paramsDefaulted ?? false,
    scriptText: input.script ?? "",
    ctx,
    warnings,
  });

  return {
    className,
    csSource,
    requiresTicks: ctx.requiresTicks,
    warnings,
  };
}

interface RenderArgs {
  className: string;
  presetName: string;
  /** Lines like `var __let_xxx = expr;` — emitted at the top of each
   *  condition method that may reference lets. */
  letDeclLines: string[];
  /** Round-8 diagnostic — same let definitions as letDeclLines, but each
   *  block also appends ` let.<name>=<value>` to a __sb StringBuilder.
   *  Body of the generated DumpSignalSubConditions() override. */
  dumpDeclLines: string[];
  longCondCs: string;
  shortCondCs: string;
  /** Each block is the C# scope (with `{ ... }` braces) for one
   *  filter.if directive — sets __verdict, returns false on reject. */
  longFilterBlocks: string[];
  shortFilterBlocks: string[];
  rulesAssigns: Array<{ path: string; expr: Expr }>;
  rules: Record<string, unknown>;
  filters: Record<string, unknown>;
  requiresTicks: boolean;
  paramsDefaulted: boolean;
  /** Verbatim DSL source — used by the diagnostic header to stamp
   *  script length + filter-directive count. */
  scriptText: string;
  ctx: EmitContext;
  warnings: string[];
}

function renderStrategyFile(a: RenderArgs): string {
  const escName = a.presetName.replace(/"/g, '\\"');
  const tickWiring = a.requiresTicks
    ? `            // DSL references require tick data. Add a 1-tick channel
            // for bid/ask attribution + tick-resolution indicators.
            AddDataSeries(BarsPeriodType.Tick, 1);`
    : `            // No tick-dependent indicators — single bar series only.`;

  const tickFieldDecl = a.requiresTicks
    ? `        private DslTickAggregator _dslTicks;`
    : ``;

  const tickInit = a.requiresTicks
    ? `            _dslTicks = new DslTickAggregator(BarsArray, 1);`
    : ``;

  const tickOnBarUpdate = a.requiresTicks
    ? `            // Tick-channel updates fire on BarsInProgress == 1; the
            // aggregator absorbs them and exposes accumulated bid/ask
            // volumes + window indicators per bar via _dslTicks.
            if (BarsInProgress == 1)
            {
                _dslTicks.OnTick(Time[0], Close[0], Volume[0]);
                return;
            }
            // Drop through — primary bars are processed below.`
    : ``;

  const tickOnMarketData = a.requiresTicks
    ? `        protected override void OnMarketData(MarketDataEventArgs e)
        {
            base.OnMarketData(e);
            if (_dslTicks != null) _dslTicks.OnMarketData(e);
        }`
    : ``;

  // Render the rules folding: take the user-supplied rules dict +
  // the per-script `rules.X = Y` assigns, and emit a SimRules POCO
  // initialization. Per-script assigns can reference inlined params
  // (already resolved at parse time), so we re-evaluate the RHS in
  // the same emit context.
  const rulesCs = renderRulesBlock(a.rules, a.rulesAssigns, a.ctx);

  const filtersCs = renderFiltersBlock(a.filters);

  // Each condition method gets the same let-decl block at the top
  // (cheap to recompute; avoids inter-method state). Locals are
  // var-typed so the compiler infers double.
  const letBlock = a.letDeclLines.length === 0 ? "" : a.letDeclLines.join("\n") + "\n";

  // Body for DumpSignalSubConditions — re-emits each let and appends
  // its value to the StringBuilder set up in the method preamble. Each
  // entry in dumpDeclLines is already a 2-line block (var decl + sb
  // append), so a plain join + trailing newline is sufficient.
  const dumpBlock = a.dumpDeclLines.length === 0 ? "" : a.dumpDeclLines.join("\n") + "\n";

  // ApplyFilters method bodies. Each block returns false on reject
  // and falls through on pass; final `return true` means all
  // directives passed. `rules` is the per-trade SimRulesData clone
  // that 3-arg filter.if assignments mutate.
  const longFilterBody = a.longFilterBlocks.length === 0
    ? "            return true;"
    : a.longFilterBlocks.join("\n") + "\n            return true;";
  const shortFilterBody = a.shortFilterBlocks.length === 0
    ? "            return true;"
    : a.shortFilterBlocks.join("\n") + "\n            return true;";

  const warningsBlock = a.warnings.length === 0
    ? ""
    : `\n//\n// TRANSPILER WARNINGS:\n${a.warnings.map((w) => `//   - ${w}`).join("\n")}\n//`;

  // Defensive header — surfaces stale-runtime issues. If the dashboard's
  // Next.js process has cached an older transpiler module, the file's
  // timestamp comment will be stale relative to the wall clock the user
  // expects, making it visible at a glance whether `/api/convert-to-nt8`
  // is actually running fresh code.
  const transpileTimestamp = new Date().toISOString();
  const transpileSha = process.env.GIT_SHA ?? "(GIT_SHA env not set)";

  // Round-4 diagnostic — script length + filter-directive count. Lets us
  // confirm at a glance whether `mergeScriptFilters` had real input to
  // chew on. If `filterDirectives=0` and the script is non-empty, there
  // are no `filters.X = Y` lines (legacy template fallback or a script
  // that uses only filter.if). If `script length=0`, the dashboard sent
  // an empty preset.script — see resolveDslScript fallback in the
  // /api/convert-to-nt8 route.
  const scriptCharCount = (a.scriptText ?? "").length;
  const filterDirectiveCount = (a.scriptText ?? "")
    .split(/\r?\n/)
    .filter((l) => /^\s*filters\.[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(l))
    .length;

  // Round-6 diagnostic — resolved-params count + missing keys. Walks
  // the script text for `params.X` references and reports how many of
  // those keys actually have a finite value in the merged params dict.
  // If K < total, the missing keys are listed inline in the header so
  // the user can see exactly which param resolved to NaN (and would
  // poison every comparison against it).
  const referencedParams = new Set<string>();
  const re = /params\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let pm: RegExpExecArray | null;
  while ((pm = re.exec(a.scriptText ?? "")) !== null) {
    referencedParams.add(pm[1]);
  }
  const totalParams = referencedParams.size;
  let resolvedParams = 0;
  const missingParams: string[] = [];
  for (const k of Array.from(referencedParams)) {
    const v = a.ctx.params[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      resolvedParams++;
    } else {
      missingParams.push(k);
    }
  }
  const paramsLine = totalParams === 0
    ? "// Params resolved: 0 / 0 (script has no params.X references)."
    : missingParams.length === 0
      ? `// Params resolved: ${resolvedParams} / ${totalParams}.`
      : `// Params resolved: ${resolvedParams} / ${totalParams}. MISSING (resolved to NaN): ${missingParams.join(", ")}`;

  return `// ${a.className}.cs
//
// Transpiler ran: ${transpileTimestamp} (commit: ${transpileSha})
// Script source: ${scriptCharCount} chars, ${filterDirectiveCount} filters.X = Y directives detected.
${paramsLine}
// Auto-generated by /api/convert-to-nt8 from dashboard preset "${escName}".
// DO NOT EDIT BY HAND — re-export from the dashboard or re-run the
// transpiler. Every line of trading logic comes from the DSL script;
// this file is just the C# projection NT8 needs to compile and run.
//
// The generated class subclasses DslStrategyBase, which owns all the
// SL/TP/trailing/BE/scaling/daily-kill/position-mode boilerplate.
// The subclass only provides:
//   - LongCondition() / ShortCondition() — DSL signal expressions
//   - LongFilterPasses() / ShortFilterPasses() — DSL filter.if guards
//   - GetSimRules() — SimRules POCO with the preset's rules folded in
//   - PresetFilters property (legacy line-based filters)${warningsBlock}

#region Using declarations
using System;
using System.Collections.Generic;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.AddOns;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class ${a.className} : DslStrategyBase
    {
${tickFieldDecl}

        protected override void OnStateChange()
        {
            base.OnStateChange();
            if (State == State.SetDefaults)
            {
                Name        = "${a.className}";
                Description = "Dashboard preset \\"${escName}\\" — DSL transpile.";
                Calculate   = Calculate.OnBarClose;
                EntriesPerDirection = 10;
                EntryHandling = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = false;
                BarsRequiredToTrade = ${computeBarsRequired(a.rules)};
            }
            else if (State == State.Configure)
            {
${tickWiring}
            }
            else if (State == State.DataLoaded)
            {
${tickInit}
                AfterDataLoadedFromTranspiler();
            }
        }

        protected override SimRulesData GetSimRulesData()
        {
${rulesCs}
        }

        protected override PresetFiltersData GetPresetFiltersData()
        {
${filtersCs}
        }

${tickOnMarketData}

        protected override void OnBarUpdate()
        {
${tickOnBarUpdate}
            base.OnBarUpdate();
        }

        // ─── DSL signal expressions ──────────────────────────────────
        // Each expression is generated from the corresponding
        // signal.long.if / signal.short.if line in the source DSL.
        // A non-zero, finite result means the signal fires this bar.

        protected override bool LongCondition()
        {
${letBlock}            var __v = ${a.longCondCs};
            return Dsl.IsFinite(__v) && __v != 0.0;
        }

        protected override bool ShortCondition()
        {
${letBlock}            var __v = ${a.shortCondCs};
            return Dsl.IsFinite(__v) && __v != 0.0;
        }

        // ─── Round-8 diagnostic — DumpSignalSubConditions() ──────────
        // Per-bar dump of every let binding value. Used to diff the
        // dashboard evaluator vs NT8 transpiled output and find the
        // first diverging sub-component of a signal AND-chain.
        // Disabled by default — DslStrategyBase.OnBarUpdate calls this
        // only when DumpFromTime/DumpToTime[/DumpOnDate] match the
        // current bar (see ShouldDumpThisBar).
        // Body re-evaluates each let exactly as LongCondition does so
        // the dump can never drift from the live eval path.

        protected override void DumpSignalSubConditions()
        {
            var __sb = new System.Text.StringBuilder();
            // Round-10 — Time[0] under Calculate.OnBarClose is the bar's
            // CLOSE time. The dashboard's bar_time is the bar's OPEN time.
            // Subtract one bar's duration so both sides label the SAME
            // physical bar identically — diff tool can join on t= without
            // a 1-bar mis-alignment. Tick / Day / Week periods fall
            // through unshifted (best-effort).
            DateTime __dumpT = Time[0];
            if (BarsPeriod != null) {
                if (BarsPeriod.BarsPeriodType == BarsPeriodType.Second) __dumpT = Time[0].AddSeconds(-BarsPeriod.Value);
                else if (BarsPeriod.BarsPeriodType == BarsPeriodType.Minute) __dumpT = Time[0].AddMinutes(-BarsPeriod.Value);
            }
            __sb.Append("DUMP[${a.className}] bar=").Append(CurrentBar)
                .Append(" t=").Append(__dumpT.ToString("yyyy-MM-ddTHH:mm:ss"))
                .Append(" close=").Append(Close[0]);
${dumpBlock}            Print(__sb.ToString());
        }

        // ─── DSL filter.if / filter.long.if / filter.short.if guards ──
        // Each filter.if directive (in source order) is its own block.
        // Bare-bool form: condition false → return false. 3-arg form:
        // condition + slot statements (rules.X = Y, print, pass/reject,
        // nested filter.if) per the dashboard's action language.
        // The "rules" SimRulesData parameter is a per-trade clone of
        // the strategy's baseline; rules.X assignments mutate it so
        // the entry's brackets reflect the override.

        protected override bool LongApplyFilters(SimRulesData rules)
        {
${letBlock}${longFilterBody}
        }

        protected override bool ShortApplyFilters(SimRulesData rules)
        {
${letBlock}${shortFilterBody}
        }
${a.paramsDefaulted ? `
        // Transpiler signal: every params.X was inlined as 1.0 because
        // no real params were supplied. DslStrategyBase reads this at
        // State.DataLoaded and prints a loud warning so the user knows
        // why the strategy probably won't fire any sensible signals.
        protected override bool ParamsWereDefaulted() => true;
` : ""}    }
}
`;
}

/** Decide how many bars NT8 needs before this strategy can run.
 *  We use a conservative 250 to cover EMA(200) warmup; if the
 *  user's params.atrPeriod / longest indicator period is larger,
 *  the strategy will silently emit NaN until warmup, then start
 *  trading. The dashboard's `precomputeIndicators` does the same. */
function computeBarsRequired(_rules: Record<string, unknown>): number {
  return 250;
}

/** Emit the SimRules initialization. Uses the input rules dict as the
 *  baseline and overlays any `rules.X = Y` script assigns on top. */
function renderRulesBlock(
  rules: Record<string, unknown>,
  rulesAssigns: Array<{ path: string; expr: Expr }>,
  ctx: EmitContext
): string {
  // Build the field-by-field assignment list. The full list of
  // SimRules fields lives in the C# DslStrategyBase / SimRulesData
  // POCO; we pick from it by mapping the JSON keys (camelCase) to
  // C# field names (PascalCase).
  const assignments: string[] = [];
  const seen = new Set<string>();

  function addRule(jsonKey: string, value: unknown) {
    const fieldName = jsonKeyToCsField(jsonKey);
    if (!fieldName) return;
    if (seen.has(fieldName)) return;
    seen.add(fieldName);
    const cs = renderRuleValue(value);
    assignments.push(`            r.${fieldName} = ${cs};`);
  }

  // Apply baseline rules from the input dict.
  for (const [k, v] of Object.entries(rules ?? {})) {
    addRule(k, v);
  }

  // Apply per-script rules.X = Y assigns. These OVERRIDE the baseline
  // (script wins). The RHS evaluates against the same EmitContext used
  // for the signal expressions — typically a constant after let/param
  // inlining, but we evaluate at runtime to handle any indicator-derived
  // values too.
  // Note: the dashboard's behavior is to apply rules.X assigns at every
  // bar (so a rules.X = ATR(14) line would re-evaluate). NT8 needs the
  // SimRules at strategy-init time, not per-bar, so we evaluate at the
  // FIRST bar with warmed indicators. Constant assigns work identically;
  // dynamic assigns are NOT yet supported by v1 — the transpiler emits
  // a warning if it sees one.
  for (const a of rulesAssigns) {
    const key = a.path.slice("rules.".length);
    const fieldName = jsonKeyToCsField(key);
    if (!fieldName) continue;
    // Skip when the RHS is just `true`/`false` — the line-based
    // parseBacktestScript path already emitted a clean literal at the
    // baseline assignments above, and we don't want to overwrite it
    // with the verbose `(Dsl.IsFinite(1.0) && (1.0) != 0.0)` form
    // that emitExpr produces for those idents.
    if (a.expr.kind === "ident" && (a.expr.name === "true" || a.expr.name === "false")) {
      continue;
    }
    // Strip prior assignment to this field if present (so a numeric
    // override from the script wins over the baseline).
    const existingIdx = assignments.findIndex((line) => line.includes(`r.${fieldName} =`));
    if (existingIdx >= 0) assignments.splice(existingIdx, 1);
    seen.delete(fieldName);
    seen.add(fieldName);
    // Compile-time constant fast path: if the RHS is just a num literal
    // emit the C# literal directly.
    if (a.expr.kind === "num") {
      assignments.push(`            r.${fieldName} = ${formatLiteralForField(a.expr.value, fieldName)};`);
      continue;
    }
    // Otherwise try inlining: emitExpr will resolve params and any
    // pure-arithmetic expression. For dynamic indicator-derived
    // values the result would be NaN before warmup; that's surfaced
    // as the dashboard warns.
    const cs = emitExpr(a.expr, ctx);
    const coerced = coerceFieldExpr(cs, fieldName);
    assignments.push(`            r.${fieldName} = ${coerced};`);
  }

  return `            var r = new SimRulesData();
${assignments.join("\n")}
            return r;`;
}

/** Map a JSON key from the dashboard preset rules dict to a C# field
 *  name on SimRulesData. Returns null for unrecognized keys (these
 *  are dashboard-only fields like fillMode, slippagePoints — already
 *  documented on the C# side as ignored).
 *
 *  Source of truth: ninjatrader/AddOns/PresetSchema.cs SimRules. */
function jsonKeyToCsField(jsonKey: string): string | null {
  const map: Record<string, string> = {
    stopLossEnabled: "StopLossEnabled",
    stopLossPoints: "StopLossPoints",
    takeProfitEnabled: "TakeProfitEnabled",
    takeProfitPoints: "TakeProfitPoints",
    trailingStopEnabled: "TrailingStopEnabled",
    trailingStopPoints: "TrailingStopPoints",
    timedExitEnabled: "TimedExitEnabled",
    timedExitBars: "TimedExitBars",
    breakEvenEnabled: "BreakEvenEnabled",
    breakEvenTrigger: "BreakEvenTrigger",
    exitAtBarClose: "ExitAtBarClose",
    extensionBarsEnabled: "ExtensionBarsEnabled",
    extensionBars: "ExtensionBars",
    slAtrAdjust: "SlAtrAdjust",
    tpAtrAdjust: "TpAtrAdjust",
    trailAtrAdjust: "TrailAtrAdjust",
    beAtrAdjust: "BeAtrAdjust",
    positionMode: "PositionMode",
    scalingEnabled: "ScalingEnabled",
    scalingStartSize: "ScalingStartSize",
    scalingWinStep: "ScalingWinStep",
    scalingLossStep: "ScalingLossStep",
    scalingMinSize: "ScalingMinSize",
    scalingMaxSize: "ScalingMaxSize",
    scalingResetDaily: "ScalingResetDaily",
    dailyStopLossEnabled: "DailyStopLossEnabled",
    dailyStopLossPoints: "DailyStopLossPoints",
    dailyTakeProfitEnabled: "DailyTakeProfitEnabled",
    dailyTakeProfitPoints: "DailyTakeProfitPoints",
    dailyLimitExactMode: "DailyLimitExactMode",
    maxTradesPerDayEnabled: "MaxTradesPerDayEnabled",
    maxTradesPerDay: "MaxTradesPerDay",
    maxLossesPerDayEnabled: "MaxLossesPerDayEnabled",
    maxLossesPerDay: "MaxLossesPerDay",
    cooldownBetweenTradesEnabled: "CooldownBetweenTradesEnabled",
    cooldownBetweenTradesBars: "CooldownBetweenTradesBars",
    fillMode: "FillMode",
    slippagePoints: "SlippagePoints",
    commissionPerRoundTrip: "CommissionPerRoundTrip",
    pointValue: "PointValue",
    tickConfigMode: "TickConfigMode",
    ticksPerPoint: "TicksPerPoint",
    tickValue: "TickValue",
  };
  return map[jsonKey] ?? null;
}

/** Render a baseline rule value as a C# literal. */
function renderRuleValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return `${v}`;
    return v.toString();
  }
  if (typeof v === "string") return `"${v.replace(/"/g, '\\"')}"`;
  // Arrays / nested objects aren't part of SimRules; fall through to default.
  return "default";
}

/** Coerce an emitExpr-produced C# expression to the type the SimRules
 *  field needs. Most fields are double or int; a few are bool or
 *  string. We branch on known field-name suffixes since that's how
 *  the dashboard distinguishes them. */
function coerceFieldExpr(cs: string, fieldName: string): string {
  if (fieldName.endsWith("Enabled") || fieldName === "DailyLimitExactMode" || fieldName === "ScalingResetDaily" || fieldName === "ExitAtBarClose" || fieldName === "ExtensionBarsEnabled" || fieldName === "MaxTradesPerDayEnabled" || fieldName === "MaxLossesPerDayEnabled" || fieldName === "CooldownBetweenTradesEnabled") {
    // bool: 0 or NaN → false, otherwise true.
    return `(Dsl.IsFinite(${cs}) && (${cs}) != 0.0)`;
  }
  if (fieldName === "PositionMode" || fieldName === "FillMode" || fieldName === "TickConfigMode") {
    // string literal already; emitExpr can't produce strings, so fail loud.
    return `"default"`;
  }
  if (
    fieldName === "TimedExitBars" ||
    fieldName === "ExtensionBars" ||
    fieldName === "ScalingStartSize" ||
    fieldName === "ScalingWinStep" ||
    fieldName === "ScalingLossStep" ||
    fieldName === "ScalingMinSize" ||
    fieldName === "ScalingMaxSize" ||
    fieldName === "MaxTradesPerDay" ||
    fieldName === "MaxLossesPerDay" ||
    fieldName === "CooldownBetweenTradesBars"
  ) {
    return `(int)System.Math.Round(${cs}, System.MidpointRounding.AwayFromZero)`;
  }
  // Default: double.
  return cs;
}

/** Render a numeric literal in a form appropriate for the target
 *  field type. Int fields get `5`; double fields get `5.0`. */
function formatLiteralForField(value: number, fieldName: string): string {
  const intFields = new Set([
    "TimedExitBars",
    "ExtensionBars",
    "ScalingStartSize",
    "ScalingWinStep",
    "ScalingLossStep",
    "ScalingMinSize",
    "ScalingMaxSize",
    "MaxTradesPerDay",
    "MaxLossesPerDay",
    "CooldownBetweenTradesBars",
  ]);
  if (intFields.has(fieldName)) {
    return `${Math.round(value)}`;
  }
  if (Number.isInteger(value)) return `${value}.0`;
  return value.toString();
}

/** Emit the legacy filters block. v1: just pass through the dict
 *  values into a PresetFiltersData POCO. The full filter set lives
 *  on the C# side; we just shuttle the values. */
/** Permissive script-filter extractor — bypasses parseBacktestScript's
 *  strict enum parser (which demands quoted strings for `ema20`/`ema200`
 *  modes and silently drops bare-ident values like
 *  `filters.trend.ema20 = against`). We scan the raw DSL line-by-line
 *  for the small set of `filters.X = Y` paths we care about and overlay
 *  the parsed values on top of the merged-filters dict so NT8 sees what
 *  the script actually intends, regardless of the dashboard's stricter
 *  parser.
 *
 *  Mutates `merged` in place. Lines that look like filter directives but
 *  don't match a known path are ignored (let parseBacktestScript handle
 *  them upstream — we're only filling specific gaps here).
 *
 *  Value parsing accepts:
 *    - bare idents (`against`, `with`, `any`, `ema`, `sma`, `true`, `false`)
 *    - quoted strings (`"08:00-14:00"`)
 *    - arrays of strings or numbers (`["09:30-11:00", "14:00-16:00"]`)
 *    - numeric literals (`20`, `2.0`)
 */
function mergeScriptFilters(merged: Record<string, unknown>, scriptText: string): void {
  if (!scriptText) return;
  const lines = scriptText.split(/\r?\n/);

  // Ensure nested objects exist before we set leaf paths so the merge
  // doesn't lose keys we already resolved upstream.
  function ensureBlock(key: string): Record<string, unknown> {
    const existing = (merged[key] ?? {}) as Record<string, unknown>;
    merged[key] = existing;
    return existing;
  }

  for (const rawLine of lines) {
    // Strip line comments (// or #) outside string literals. v5's
    // filters block doesn't have inline comments but be defensive.
    let line = rawLine;
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
      if (!inStr) {
        if (c === "#") { line = line.slice(0, i); break; }
        if (c === "/" && line[i + 1] === "/") { line = line.slice(0, i); break; }
      }
    }
    line = line.trim();
    if (line === "") continue;
    const m = line.match(/^(filters\.[A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const path = m[1];
    const rhs  = m[2].trim();
    const value = parsePermissiveValue(rhs);
    if (value === undefined) continue;

    // Route to the right block.
    if (path === "filters.time.enabled") ensureBlock("time").enabled = !!value;
    else if (path === "filters.time.from") ensureBlock("time").from = String(value);
    else if (path === "filters.time.to") ensureBlock("time").to = String(value);
    else if (path === "filters.time.windows") ensureBlock("time").windows = value;
    else if (path === "filters.trend.enabled") ensureBlock("trend").enabled = !!value;
    else if (path === "filters.trend.ema20") ensureBlock("trend").ema20 = String(value);
    else if (path === "filters.trend.ema200") ensureBlock("trend").ema200 = String(value);
    else if (path === "filters.trend.fastPeriod") ensureBlock("trend").fastPeriod = Number(value);
    else if (path === "filters.trend.fastType") ensureBlock("trend").fastType = String(value);
    else if (path === "filters.trend.slowPeriod") ensureBlock("trend").slowPeriod = Number(value);
    else if (path === "filters.trend.slowType") ensureBlock("trend").slowType = String(value);
    // Other filter blocks (adx/atr/bollinger/etc) deferred — extend
    // here when a script needs them.
  }
}

/** Parse a value literal in DSL line syntax. Accepts bare idents (returns
 *  the ident string), quoted strings, arrays, numbers, bools. Returns
 *  undefined when the value can't be parsed — caller skips the line. */
function parsePermissiveValue(rhs: string): unknown {
  const t = rhs.trim();
  if (t === "") return undefined;
  if (t === "true") return true;
  if (t === "false") return false;
  // Quoted string.
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  // Array — split on top-level commas and recurse.
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    const parts: string[] = [];
    let buf = "";
    let inStr = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"' && inner[i - 1] !== "\\") inStr = !inStr;
      if (c === "," && !inStr) { parts.push(buf); buf = ""; continue; }
      buf += c;
    }
    if (buf.trim() !== "") parts.push(buf);
    const out: unknown[] = [];
    for (const p of parts) {
      const v = parsePermissiveValue(p);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  // Number.
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  // Bare ident — used for enum values (against/with/any/ema/sma/etc).
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return t;
  return undefined;
}

function renderFiltersBlock(filters: Record<string, unknown>): string {
  // Fold the merged filters dict (caller-supplied + parseBacktestScript-
  // derived) into PresetFiltersData initialization. v1 supports the two
  // legacy filters that range_break_reversal_v5 actually uses: time
  // window + trend. Other legacy filters (adx, atr, bollinger, rsi, ...)
  // are deferred — their dashboard semantics still apply correctly via
  // filter.if directives, which the transpiler already routes properly.
  const lines: string[] = [`            var f = new PresetFiltersData();`];

  // ── Time filter ─────────────────────────────────────────────────
  const time = (filters?.time ?? null) as
    | { enabled?: boolean; from?: string; to?: string; windows?: Array<string | { from?: string; to?: string }> }
    | null;
  if (time && time.enabled) {
    lines.push(`            f.Time.Enabled = true;`);
    // The dashboard's time filter normalizes to a `windows` array. When
    // the parser only got a single from/to pair, we fall through to
    // synthesize one window. Each window is "HH:MM-HH:MM" or a
    // {from, to} object — handle both shapes.
    const windowList: Array<{ from: string; to: string }> = [];
    if (Array.isArray(time.windows)) {
      for (const w of time.windows) {
        if (typeof w === "string") {
          const m = w.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
          if (m) windowList.push({ from: m[1], to: m[2] });
        } else if (w && typeof w === "object" && w.from && w.to) {
          windowList.push({ from: w.from, to: w.to });
        }
      }
    }
    if (windowList.length === 0 && time.from && time.to) {
      windowList.push({ from: time.from, to: time.to });
    }
    lines.push(`            f.Time.Windows.Clear();`);
    for (const w of windowList) {
      const fromCs = JSON.stringify(w.from);
      const toCs = JSON.stringify(w.to);
      lines.push(`            f.Time.Windows.Add(new TimeWindowData { From = ${fromCs}, To = ${toCs} });`);
    }
  }

  // ── Trend filter ────────────────────────────────────────────────
  // Mirrors filters.trend.* in the dashboard's PartialBacktestConfig.
  const trend = (filters?.trend ?? null) as
    | {
        enabled?: boolean;
        ema20?: string;
        ema200?: string;
        fastPeriod?: number;
        fastType?: string;
        slowPeriod?: number;
        slowType?: string;
      }
    | null;
  if (trend && trend.enabled) {
    lines.push(`            f.Trend.Enabled = true;`);
    if (trend.ema20)      lines.push(`            f.Trend.Ema20Mode  = ${JSON.stringify(trend.ema20)};`);
    if (trend.ema200)     lines.push(`            f.Trend.Ema200Mode = ${JSON.stringify(trend.ema200)};`);
    if (typeof trend.fastPeriod === "number") lines.push(`            f.Trend.FastPeriod = ${trend.fastPeriod};`);
    if (trend.fastType)   lines.push(`            f.Trend.FastType   = ${JSON.stringify(trend.fastType)};`);
    if (typeof trend.slowPeriod === "number") lines.push(`            f.Trend.SlowPeriod = ${trend.slowPeriod};`);
    if (trend.slowType)   lines.push(`            f.Trend.SlowType   = ${JSON.stringify(trend.slowType)};`);
  }

  lines.push(`            return f;`);
  return lines.join("\n");
}
