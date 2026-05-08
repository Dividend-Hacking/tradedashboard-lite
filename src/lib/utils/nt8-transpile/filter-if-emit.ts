/**
 * filter-if-emit.ts — Emit C# for the filter.if action language.
 *
 * The bare form `filter.if = <bool expr>` is handled directly by the
 * strategy emitter (just an AND-ed guard). This module handles the
 * 3-arg form `filter.if = (cond, ifTrue, ifFalse)` whose action
 * language has 4 statement kinds:
 *
 *   - assignment   `rules.X = expr`     — per-trade rule override
 *   - print        `print(expr, "lbl")` — conditional print
 *   - verdict      `pass` / `reject`    — halt + set the slot's verdict
 *   - nested       `filter.if = (...)`  — fully recursive
 *
 * Verdict semantics (mirrors backtest-script.ts:1717-1721):
 *   - Empty slot → use the default verdict (true → pass, false → reject)
 *   - Non-empty slot without an explicit verdict → implicit PASS (the
 *     side-effects ran, let the trade through)
 *   - Explicit `pass` / `reject` halts the slot and sets the verdict;
 *     anything after is dead code (the parser warns; we just stop emitting)
 *
 * Per-trade rule overrides are applied by mutating the C# `rules`
 * SimRulesData parameter that DslStrategyBase passes to the filter
 * method. Each `rules.X = Y` becomes one assignment to the corresponding
 * field; the brackets attached to THIS entry pick up the override
 * automatically.
 *
 * Sticky modifier (`sticky(N) <statement>`): backtest-script.ts:1722
 * defers it to "future cross-trade state" and the dashboard runtime
 * v1 only honors `sticky(0)` (this trade only — the default). We
 * mirror: emit the statement at face value and surface a warning if
 * `sticky(N>0)` shows up. Cross-trade state would need a side-table
 * indexed by sticky-slot id, which is a v2 task.
 */

import type {
  FilterIfDirective,
  FilterIfStatement,
  PrintDirective,
} from "../backtest-script";
import type { NumericValue } from "../script-expr";
import { emitExpr, type EmitContext } from "./expr-emit";

/** Map a `rules.<key>` JSON path to the corresponding C# field on
 *  SimRulesData. Returns null when the key isn't a recognized rule
 *  (the dashboard's filter.if parser already validates this against
 *  NUMERIC_RULE_KEYS, so a null here means a parser bug or schema
 *  drift — caller surfaces a warning). Mirrors jsonKeyToCsField in
 *  strategy-emit.ts but kept separate so future divergence (e.g.
 *  filter.if-only fields) doesn't ripple back into the rules-block
 *  emitter. */
function rulesPathToCsField(path: string): string | null {
  if (!path.startsWith("rules.")) return null;
  const key = path.slice("rules.".length);
  const map: Record<string, string> = {
    stopLossPoints: "StopLossPoints",
    takeProfitPoints: "TakeProfitPoints",
    trailingStopPoints: "TrailingStopPoints",
    timedExitBars: "TimedExitBars",
    breakEvenTrigger: "BreakEvenTrigger",
    slAtrAdjust: "SlAtrAdjust",
    tpAtrAdjust: "TpAtrAdjust",
    trailAtrAdjust: "TrailAtrAdjust",
    beAtrAdjust: "BeAtrAdjust",
    extensionBars: "ExtensionBars",
    dailyStopLossPoints: "DailyStopLossPoints",
    dailyTakeProfitPoints: "DailyTakeProfitPoints",
    maxTradesPerDay: "MaxTradesPerDay",
    maxLossesPerDay: "MaxLossesPerDay",
    cooldownBetweenTradesBars: "CooldownBetweenTradesBars",
    scalingStartSize: "ScalingStartSize",
    scalingWinStep: "ScalingWinStep",
    scalingLossStep: "ScalingLossStep",
    scalingMinSize: "ScalingMinSize",
    scalingMaxSize: "ScalingMaxSize",
    slippagePoints: "SlippagePoints",
    commissionPerRoundTrip: "CommissionPerRoundTrip",
  };
  return map[key] ?? null;
}

/** Whether the C# field needs an int cast on assignment. Mirrors the
 *  same set strategy-emit's coerceFieldExpr branches on. */
const INT_RULE_FIELDS = new Set([
  "TimedExitBars",
  "ExtensionBars",
  "MaxTradesPerDay",
  "MaxLossesPerDay",
  "CooldownBetweenTradesBars",
  "ScalingStartSize",
  "ScalingWinStep",
  "ScalingLossStep",
  "ScalingMinSize",
  "ScalingMaxSize",
]);

/** Render a NumericValue (literal | expr) as a C# expression. The
 *  `optimize` form is rejected upstream by the parser inside
 *  filter.if branches, so we never see it here.
 *
 *  Returns the C# expression string. */
function renderNumericValue(nv: NumericValue, ctx: EmitContext): string {
  switch (nv.kind) {
    case "literal":
      if (Number.isInteger(nv.value)) return `${nv.value}.0`;
      return nv.value.toString();
    case "expr":
      return emitExpr(nv.expr, ctx);
    case "optimize":
      // Parser rejects this; defensive return.
      return "double.NaN";
  }
}

/** Render a print directive's RHS as a C# `Print("label: value")`
 *  call. The dashboard's print emits a per-trade column; we emit a
 *  Print() call so the user can see the value in NT8's output window
 *  / log. The label and value get concatenated with a `:` separator
 *  for readability. */
function renderPrintCall(d: PrintDirective, ctx: EmitContext): string {
  const valueCs = emitExpr(d.expr, ctx);
  const labelCs = JSON.stringify(d.label);
  return `Print(${labelCs} + ": " + (${valueCs}).ToString("G"))`;
}

/** Indent every line of a multi-line block by `n` spaces. */
function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l.length === 0 ? l : pad + l))
    .join("\n");
}

/** Emit one filter.if statement to a list of C# lines.
 *
 *  Output convention: the caller maintains a verdict variable
 *  named `__verdict` (1 = pass, 0 = reject, -1 = "no verdict yet,
 *  use default") inside the slot's block scope, plus a `__halt`
 *  flag that explicit verdicts set so subsequent statements are
 *  no-ops at runtime.
 *
 *  Sticky-modifier handling: emit a leading `// sticky(N) ` comment
 *  + warning when N > 0; otherwise quiet. */
function emitStatement(
  stmt: FilterIfStatement,
  ctx: EmitContext,
  warnings: string[]
): string[] {
  const lines: string[] = [];
  if (stmt.sticky !== undefined && stmt.sticky > 0) {
    warnings.push(`sticky(${stmt.sticky}) cross-trade state not yet supported in NT8 — applied as sticky(0)`);
    lines.push(`            // sticky(${stmt.sticky}) — applied as single-trade-only (cross-trade state TBD)`);
  }
  switch (stmt.kind) {
    case "verdict":
      // Halt: set the verdict, mark the block done. Subsequent
      // statements in the same slot are dead code (parser warns;
      // we'd skip but the caller's loop already includes them).
      // We use early-return semantics by jumping to the method's
      // end via a `goto`-equivalent: just set both flags and let
      // the surrounding `if (!__halt)` short-circuit further work.
      if (stmt.verdict === "pass") {
        lines.push(`            __halt = true; __verdict = 1;`);
      } else {
        lines.push(`            __halt = true; __verdict = 0;`);
      }
      break;

    case "assignment": {
      const csField = rulesPathToCsField(stmt.path);
      if (!csField) {
        warnings.push(`filter.if assignment "${stmt.path}" — not a known SimRules field`);
        break;
      }
      const valueCs = renderNumericValue(stmt.value, ctx);
      if (INT_RULE_FIELDS.has(csField)) {
        lines.push(`            rules.${csField} = (int)System.Math.Round((${valueCs}), System.MidpointRounding.AwayFromZero);`);
      } else {
        lines.push(`            rules.${csField} = (${valueCs});`);
      }
      // Some rule fields have an associated *Enabled flag — flipping
      // the value also implicitly enables the feature. Mirror the
      // dashboard's resolveRulesForTrade behavior where setting e.g.
      // rules.stopLossPoints implicitly enables stop loss for that
      // trade.
      const enabledForField: Record<string, string> = {
        StopLossPoints: "StopLossEnabled",
        TakeProfitPoints: "TakeProfitEnabled",
        TrailingStopPoints: "TrailingStopEnabled",
        TimedExitBars: "TimedExitEnabled",
        BreakEvenTrigger: "BreakEvenEnabled",
        ExtensionBars: "ExtensionBarsEnabled",
        DailyStopLossPoints: "DailyStopLossEnabled",
        DailyTakeProfitPoints: "DailyTakeProfitEnabled",
        MaxTradesPerDay: "MaxTradesPerDayEnabled",
        MaxLossesPerDay: "MaxLossesPerDayEnabled",
        CooldownBetweenTradesBars: "CooldownBetweenTradesEnabled",
      };
      if (enabledForField[csField]) {
        lines.push(`            rules.${enabledForField[csField]} = true;`);
      }
      break;
    }

    case "print": {
      const callCs = renderPrintCall(stmt.directive, ctx);
      lines.push(`            ${callCs};`);
      break;
    }

    case "nested": {
      // Recursively emit the nested directive. Its verdict, if
      // explicit, propagates to the OUTER __verdict / __halt. If
      // the nested slot finishes with its OWN __halt clear, the
      // outer block continues.
      const nested = emitDirectiveBody(stmt.directive, ctx, warnings);
      lines.push(`            // nested filter.if`);
      lines.push(`            {`);
      lines.push(indent(nested, 4));
      lines.push(`            }`);
      break;
    }
  }
  return lines;
}

/** Emit a slot (a list of statements) with the implicit-pass logic.
 *
 *  Slot semantics (matches backtest-script.ts:1700-1707):
 *    - Empty slot → use the slot's default verdict.
 *    - Non-empty slot without an explicit verdict → implicit PASS after
 *      side effects.
 *    - Explicit verdict halts immediately.
 *
 *  We emit each statement guarded on `!__halt` so dead-code statements
 *  after a verdict are no-ops at runtime. After all statements, if
 *  __halt is still false AND the slot was non-empty, set verdict=1
 *  (implicit pass). When the slot was empty the caller emits the
 *  default-verdict line directly. */
function emitSlot(
  statements: FilterIfStatement[],
  defaultVerdict: 0 | 1,
  ctx: EmitContext,
  warnings: string[]
): string {
  if (statements.length === 0) {
    return `            __verdict = ${defaultVerdict};`;
  }
  const lines: string[] = [];
  for (const s of statements) {
    const stLines = emitStatement(s, ctx, warnings);
    // Wrap each statement in `if (!__halt)` so a verdict halt early
    // in the list short-circuits the rest. The verdict line itself
    // sets __halt so subsequent statements no-op.
    lines.push(`            if (!__halt)`);
    lines.push(`            {`);
    lines.push(indent(stLines.join("\n"), 4));
    lines.push(`            }`);
  }
  // Implicit pass after side effects.
  lines.push(`            if (!__halt) __verdict = 1;`);
  return lines.join("\n");
}

/** Emit the body of a filter.if directive (the cond + branches). The
 *  caller wraps this in a method or a nested block. The body sets
 *  `__verdict` (1 = pass, 0 = reject) based on the cond and the
 *  selected slot's outcome.
 *
 *  Cond NaN → default false branch (NaN-as-fail). */
export function emitDirectiveBody(
  d: FilterIfDirective,
  ctx: EmitContext,
  warnings: string[]
): string {
  const condCs = emitExpr(d.cond, ctx);
  // Default verdicts match the dashboard:
  //   - True branch: implicit PASS when slot is empty/omitted.
  //   - False branch: implicit REJECT when slot is empty/omitted.
  const trueDefault: 0 | 1 = 1;
  const falseDefault: 0 | 1 = 0;
  const ifTrueBlock = emitSlot(d.ifTrue, trueDefault, ctx, warnings);
  const ifFalseBlock = emitSlot(d.ifFalse, falseDefault, ctx, warnings);
  return [
    `            __halt = false;`,
    `            var __cond = ${condCs};`,
    `            if (Dsl.IsFinite(__cond) && __cond != 0.0)`,
    `            {`,
    indent(ifTrueBlock, 4),
    `            }`,
    `            else`,
    `            {`,
    indent(ifFalseBlock, 4),
    `            }`,
  ].join("\n");
}
