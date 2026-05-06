/**
 * Script Reference Export
 * ───────────────────────
 * Produces a single self-contained Markdown document that captures
 * EVERYTHING an AI model would need to author or modify a backtest
 * script: the DSL grammar, every assignable variable (with type, range,
 * default, allowed options, and which strategy it applies to), every
 * expression-context symbol (indicators, bar fields, math passthroughs),
 * every summary-context identifier, the Optimize directive surface, and
 * a canonical default script example so the model has a concrete shape
 * to mimic.
 *
 * Design intent:
 *   - One file, no embedded code dependencies — the user pastes the
 *     whole thing into ChatGPT / Claude / Gemini and asks "write me a
 *     script that does X". The model then has the full schema in its
 *     context window without needing tool access.
 *   - Markdown (not JSON) because every chat AI handles markdown natively
 *     and the prose descriptions matter as much as the field types.
 *   - Sourced 100% from SCRIPT_SCHEMA + EXPR_SYMBOLS + SUMMARY_SYMBOLS,
 *     so adding a new field anywhere automatically lands in the export.
 *     No drift between the in-app reference and what gets downloaded.
 *
 * Surface:
 *   - buildScriptReferenceMarkdown() — pure function returning the doc text.
 *   - downloadScriptReferenceMarkdown() — browser-only helper that wires
 *     the doc to a click-to-download <a download> trigger. Imports the
 *     pure builder so SSR / unit tests can call the builder directly.
 */

import {
  SCRIPT_SCHEMA,
  defaultBacktestConfig,
  serializeBacktestScript,
  type ScriptSchemaEntry,
} from "./backtest-script";
import { EXPR_SYMBOLS, EXPR_OPERATORS, SUMMARY_SYMBOLS } from "./script-expr";

// ─── Formatters ─────────────────────────────────────────────────────────────

/** Render a schema entry's default value back into the same syntax the
 *  parser accepts on the right-hand side, so an AI reading this doc can
 *  copy the default verbatim into a script. Mirrors the in-app docs
 *  panel's formatDefault() so the two views never disagree. */
function formatDefault(entry: ScriptSchemaEntry): string {
  const v = entry.default;
  if (Array.isArray(v)) return `[${v.map((x) => `"${x}"`).join(", ")}]`;
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Compact range string for numeric entries — empty for non-numeric. */
function formatRange(entry: ScriptSchemaEntry): string {
  if (entry.type !== "int" && entry.type !== "float") return "";
  const parts: string[] = [];
  if (entry.min !== undefined) parts.push(`min=${entry.min}`);
  if (entry.max !== undefined) parts.push(`max=${entry.max}`);
  if (entry.step !== undefined) parts.push(`step=${entry.step}`);
  return parts.join(", ");
}

/** Markdown table cell escaper — pipes/newlines inside descriptions
 *  would otherwise break the table layout. */
function md(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─── Section blocks ─────────────────────────────────────────────────────────

/** Preamble — explains the DSL to the AI model in plain prose plus a
 *  grammar fragment. The "How to use this" subsection is targeted
 *  specifically at the model: it says "you are an AI being asked to
 *  generate a script — here are the rules". */
function buildPreamble(): string {
  return `# Backtest Script DSL — AI Reference

This document is the complete reference for the **Backtest Script DSL** used by the trading dashboard. It is designed to be pasted into an AI chat (Claude, ChatGPT, Gemini, etc.) so the model has the full schema in its context window and can author or modify scripts on request.

## How to use this with an AI

You are likely an AI reading this because a user has asked you to write or edit a backtest script. Follow these rules:

1. **One assignment per line.** The grammar is line-based: \`path = value\`. No multi-line statements, no JSON, no nested braces.
2. **Only emit paths listed in the Schema section below.** Unknown paths are reported as warnings and ignored.
3. **Match the value type exactly.** Each path declares a type (\`int\`, \`float\`, \`boolean\`, \`string\`, \`enum\`, \`stringArray\`). Numeric ranges and enum option lists are authoritative — do not invent values outside them.
4. **Partial scripts are valid.** You only need to emit the lines the user actually wants to change. Anything you omit stays at the dashboard's current value.
5. **Use comments freely.** Lines starting with \`#\` or \`//\` are ignored. Comments after a value (\`rules.stopLossPoints = 10  // tight stop\`) are also fine.
6. **Group sections with comment headers** (\`// ── Risk rules: Exits ──\`) — matches the canonical style produced by the dashboard's serializer.
7. **Never emit \`loadstrategy\` AFTER \`params.*\` lines you want to keep** — \`loadstrategy\` is hoisted to the top of execution and resets every \`params.*\` field to that strategy's defaults. Use it ONLY as the first non-comment line when switching strategies.
8. **Numeric \`rules.*\` fields accept full expressions**, not just literals. Examples: \`rules.stopLossPoints = ATR * 1.5\`, \`rules.trailingStopPoints = max(ticks(4), ATR * 0.5)\`.
9. **Use \`Optimize.X.Y(...)\` on \`rules.*\` numeric fields** when the user wants tuning rather than a fixed value. See the Optimize Directive section.

## Grammar

\`\`\`
<line>       ::= <comment> | <blank> | <assignment>
<comment>    ::= ('#' | '//') <text>
<assignment> ::= <path> '=' <value> [<inline-comment>]
<path>       ::= identifier ('.' identifier)*
<value>      ::= <number> | <string> | <boolean> | <array> | <expression> | <optimize>
<string>     ::= '"' <chars> '"'
<boolean>    ::= 'true' | 'false'
<array>      ::= '[' <value> (',' <value>)* ']'
<expression> ::= numeric arithmetic over indicators / bar fields / math fns
                 (allowed only on rules.* numeric fields)
<optimize>   ::= 'Optimize' '.' <objective> '.' <unit> '(' <args> ')'
\`\`\`

Top-level paths the parser recognises:

| Prefix | Purpose |
|---|---|
| \`strategy\` | Which signal generator to run. Soft-set — does NOT touch params. |
| \`loadstrategy\` | Hoisted directive: switch strategy AND reset every \`params.*\` to that strategy's defaults. One-shot, not persisted. |
| \`params.*\` | Strategy-specific parameters. Available params depend on the active strategy. |
| \`rules.*\` | Risk rules: exits, ATR adjustments, position mode, scaling, daily limits, fills/costs. Numeric values can be full expressions. |
| \`filters.*\` | Pre-trade filters: time, ADX, ATR, trend, Bollinger, BB width, MA distance, volume, RSI, ADX trend. |
| \`print = <expr>[, "<label>"]\` | Post-run summary print directive. |
| \`ontrade.print = <expr>[, "<label>"]\` | Per-trade print directive (evaluated at each trade's entry bar). |
| \`filter.if = <bool-expr>\` | Conditional filter — single-arg gate. Trade passes when the expression is finite & non-zero. |
| \`filter.if = (cond, if_true, if_false)\` | Conditional filter — 3-arg form with action statements per branch. Branches are \`;\`-separated lists of: \`rules.X = expr\`, \`print(expr [, "label"])\`, \`pass\`, \`reject\`, nested \`filter.if = (...)\`. Empty slot keeps the default verdict; defining a slot REPLACES it (write \`reject\` explicitly to keep default-false reject). |
| \`OptimizeAll = true\|false\` | Joint vs independent TPE search across all \`Optimize.*\` directives. |

`;
}

/** The variable schema, grouped by section, rendered as a series of
 *  markdown tables. One section header per group; one row per entry.
 *  Strategy-applicable params show their owning strategies in a column
 *  so the AI knows when a param is irrelevant to the active strategy. */
function buildSchemaSection(): string {
  const lines: string[] = [];
  lines.push("## Schema — assignable paths");
  lines.push("");
  lines.push(
    "Every variable the script can set, grouped by section. The order matches what the dashboard emits when serializing a config to script form. Defaults shown are the values used when the user has never touched the field."
  );
  lines.push("");

  let lastSection = "";
  let buffer: string[] = [];

  const flushSection = () => {
    if (buffer.length === 0) return;
    lines.push(`### ${lastSection}`);
    lines.push("");
    lines.push("| Path | Type | Default | Range / Options | Strategies | Description |");
    lines.push("|---|---|---|---|---|---|");
    for (const row of buffer) lines.push(row);
    lines.push("");
    buffer = [];
  };

  for (const entry of SCRIPT_SCHEMA) {
    if (entry.section !== lastSection) {
      flushSection();
      lastSection = entry.section;
    }

    const range = formatRange(entry);
    const options = entry.options
      ? entry.options.map((o) => `\`${o}\``).join(" \\| ")
      : "";
    // Combine numeric range + enum options into one cell — they never
    // both appear (numeric entries don't have options and vice versa).
    const rangeOrOptions = range || options || "—";
    const strategies =
      entry.strategies && entry.strategies.length > 0
        ? entry.strategies.join(", ")
        : "—";

    buffer.push(
      `| \`${entry.path}\` | ${entry.type} | \`${formatDefault(entry)}\` | ${rangeOrOptions} | ${strategies} | ${md(entry.description)} |`
    );
  }
  flushSection();

  return lines.join("\n");
}

/** Indicator / bar-field / math-passthrough symbols available inside
 *  expressions on \`rules.*\` numeric fields and inside ontrade.print
 *  directives. Grouped by ExprSymbol.kind for clarity. */
function buildExpressionSection(): string {
  const lines: string[] = [];
  lines.push("## Expressions — symbols available on `rules.*` numeric fields");
  lines.push("");
  lines.push(
    "Numeric `rules.*` fields accept full arithmetic expressions over the symbols below. Evaluated at each trade's entry bar. Examples:"
  );
  lines.push("");
  lines.push("```");
  lines.push("rules.stopLossPoints = ATR * 1.5");
  lines.push("rules.trailingStopPoints = max(ticks(4), ATR * 0.5)");
  lines.push("rules.takeProfitPoints = (high - low) * 2");
  lines.push("```");
  lines.push("");

  // Group by kind so similar-flavored symbols cluster together.
  const idents = EXPR_SYMBOLS.filter((s) => s.kind === "ident");
  const calls = EXPR_SYMBOLS.filter((s) => s.kind === "call");
  const maths = EXPR_SYMBOLS.filter((s) => s.kind === "math");

  const renderTable = (
    title: string,
    rows: typeof EXPR_SYMBOLS,
    intro: string
  ) => {
    lines.push(`### ${title}`);
    lines.push("");
    lines.push(intro);
    lines.push("");
    lines.push("| Symbol | Description |");
    lines.push("|---|---|");
    for (const s of rows) {
      lines.push(`| \`${s.signature ?? s.name}\` | ${md(s.description)} |`);
    }
    lines.push("");
  };

  renderTable(
    "Identifiers (bare names)",
    idents,
    "Used without parentheses. Resolve to either a fixed-period indicator (e.g. ATR14, EMA200) or a field on the current entry bar (open, high, low, close, volume, bar_index, direction)."
  );
  renderTable(
    "Function calls",
    calls,
    "Parametric forms. The bare-suffix shortcuts (EMA20, EMA50, EMA200, ATR14, ADX14) are equivalent to calling these with the corresponding period."
  );
  renderTable(
    "Math passthroughs",
    maths,
    "Available in BOTH expression contexts (entry-bar `rules.*` AND post-run `print = …` summaries)."
  );
  renderTable(
    "Comparison & logical operators",
    EXPR_OPERATORS,
    "All operators return 1.0 (true) / 0.0 (false). Comparisons propagate NaN when either side is NaN, so missing-data conditions register as 'unknown' — the filter.if runtime treats unknown as fail. Logical && / || short-circuit and treat NaN as false. Use these to build conditions for `filter.if = ...`."
  );

  return lines.join("\n");
}

/** Summary identifiers — what `print = …` directives can reference. */
function buildSummarySection(): string {
  const lines: string[] = [];
  lines.push("## Summary identifiers — used inside `print = ...` directives");
  lines.push("");
  lines.push(
    "Summary prints are evaluated ONCE after the backtest completes, against the aggregate stats. Use them to surface custom metrics in the Output panel."
  );
  lines.push("");
  lines.push("Example:");
  lines.push("");
  lines.push("```");
  lines.push('print = winRate * 100, "Win %"');
  lines.push('print = expectancy / max(avgLossPoints, 0.01), "Edge ratio"');
  lines.push("```");
  lines.push("");
  lines.push("| Identifier | Description |");
  lines.push("|---|---|");
  for (const s of SUMMARY_SYMBOLS) {
    lines.push(`| \`${s.name}\` | ${md(s.description)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** The Optimize directive — hand-written narrative because the syntax
 *  is recursive enough that a flat symbol table doesn't capture it. */
function buildOptimizeSection(): string {
  return `## Optimize directive — online TPE tuning on \`rules.*\` numeric fields

Replace a literal value with \`Optimize.<Objective>.<LookbackUnit>(lookback, min, max[, step])\` to have the dashboard search for the best value as the backtest runs. Uses a Tree-structured Parzen Estimator over the lookback window.

### Numeric form

\`\`\`
rules.stopLossPoints = Optimize.DailyEV.trades(30, 10, 40)
rules.timedExitBars  = Optimize.Sharpe.bars(500, 5, 50, 1)
rules.trailingStopPoints = Optimize.MinDrawdown.trades(50, ticks(4), ATR * 2)
\`\`\`

- \`lookback\` is the rolling window the optimizer scores candidates over.
- \`min\` / \`max\` define the search range. Both can be expressions (\`ATR\`, \`ticks(4)\`, \`EMA20 * 0.1\`) — they are re-evaluated per trade.
- \`step\` (optional) snaps the search grid for integer-like fields.

### Categorical form (parsed but NOT yet executed in this build)

\`\`\`
filters.trend.ema20 = Optimize.WinRate.trades(30, (with, against))
\`\`\`

### Objectives

\`DailyEV\`, \`EV\`, \`Sharpe\`, \`MinDrawdown\`, \`WinRate\`, \`ProfitFactor\`. \`MinDrawdown\` is internally maximized as \`-maxDrawdown\` so smaller drawdowns score higher. \`ProfitFactor\` with no losers is capped at a large finite value to keep the math stable.

### Lookback units

\`trades\` (count-based — last N completed trades), or one of \`bars\` / \`minutes\` / \`seconds\` / \`hours\` (time-based). Until the lookback fills, the field uses its literal default (warmup phase).

### \`OptimizeAll\`

\`\`\`
OptimizeAll = false   # default — each Optimize directive runs independently
OptimizeAll = true    # joint TPE search over all directives' multi-dim space
\`\`\`

When \`true\`, every \`Optimize.*\` directive in the script must agree on the same objective.

`;
}

/** filter.if directive — narrative section. The action statement
 *  language inside branch slots is its own mini-DSL distinct from the
 *  outer line-based script, so a hand-written explanation gives the
 *  AI a much clearer picture than a raw schema row. */
function buildFilterIfSection(): string {
  return `## \`filter.if\` directive — conditional gating with action statements

Per-trade conditional filter. Multiple \`filter.if\` lines AND together — every directive must produce a "pass" verdict for the trade to fire. Evaluated at the entry bar against the same context as \`ontrade.print\` (bar fields, indicators, tick helpers).

### Single-arg form (gate only)

\`\`\`
filter.if = ATR(14) > 0.5
filter.if = ADX > 25 && close > EMA20
\`\`\`

The expression must be a boolean (use comparisons \`> < >= <= == !=\` and logicals \`&& || !\`). Trade passes when the result is finite & non-zero. NaN (missing data, divide-by-zero) → fail.

### 3-arg form (with action statements)

\`\`\`
filter.if = (cond, if_true_actions, if_false_actions)
filter.if = (cond, if_true_actions)              # if_false omitted = default reject
filter.if = (cond, , if_false_actions)           # if_true omitted = default pass
\`\`\`

**Verdict semantics — important:**
- Slot omitted/empty → default verdict (true → pass, false → reject).
- Slot defined → defining a slot REPLACES the default. Implicit verdict becomes PASS unless the slot contains an explicit \`reject\`. To preserve "reject and print on failure", you MUST write \`reject\` in the slot:

\`\`\`
filter.if = (volume(14) > 100, , print("weak vol"); reject)
\`\`\`

\`pass\` and \`reject\` are halt-and-set markers — anything after them in the same slot is dead code.

### Action statements (semicolon-separated within a slot)

| Statement | Effect |
|---|---|
| \`rules.<key> = <expr>\` | Per-trade rule override. Stacks on top of any baseline \`numericOverrides\` for the same path. Allowed keys: any numeric \`rules.*\` field (stopLossPoints, takeProfitPoints, trailingStopPoints, timedExitBars, breakEvenTrigger, etc.). |
| \`print(<expr>)\` or \`print(<expr>, "label")\` | Conditional per-trade print — fires only when the branch is taken. Merges into the \`script_prints\` column set; collisions with top-level \`ontrade.print\` labels prefer the filter print. |
| \`pass\` | Explicit pass verdict. Halts the slot. |
| \`reject\` | Explicit reject verdict. Halts the slot and drops the trade. |
| \`filter.if = (...)\` | Nested directive — fully recursive. Its verdict + side effects bubble up into the outer slot but do not halt it (only \`pass\`/\`reject\` halt). |
| \`sticky(N) <statement>\` | Apply for N future trades. PARSED but the v1 runtime treats this as a no-op with a warning — cross-trade state isn't yet implemented. Safe to write today; the script will run as if N=0. |

### Examples

\`\`\`
# Tighten stop on strong trend, loosen on weak — both branches let the trade through.
filter.if = (ADX > 25, rules.stopLossPoints = 8, rules.stopLossPoints = 15)

# Reject and log diagnostic on weakness; otherwise pass silently.
filter.if = (volume(14) > 100, , print("weak vol"); reject)

# Nested: only allow longs above EMA20 when ADX > 25.
filter.if = (ADX > 25, filter.if = (close > EMA20, , reject), reject)

# Multiple statements in a single slot.
filter.if = (ATR > 1.0, rules.stopLossPoints = ATR * 1.5; rules.takeProfitPoints = ATR * 3; print(ATR, "entry ATR"))
\`\`\`

`;
}

/** A real, runnable default script. Helpful as a "shape" reference —
 *  the AI sees what canonical output looks like and can pattern-match.
 *  Sourced from defaultBacktestConfig() so it never drifts. */
function buildExampleSection(): string {
  // Mirror the Load Defaults output exactly — includeFilterIfTemplates
  // surfaces the modern `filter.if = ...` examples in place of the
  // hidden legacy filters.* scaffolding so the AI consuming this doc
  // sees the same canonical script the user does.
  const example = serializeBacktestScript(defaultBacktestConfig(), {
    includeFilterIfTemplates: true,
  });
  return `## Canonical default script

What the dashboard emits when "Load Defaults" is clicked. This is a complete, valid script — every section header, every field at its default. Use this as a template: copy the sections you want to modify, leave everything else out (omitted fields keep the dashboard's current value).

\`\`\`
${example.trimEnd()}
\`\`\`

`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Build the full markdown reference. Pure function — no DOM access,
 *  safe to call in any environment (SSR, tests, Node scripts). */
export function buildScriptReferenceMarkdown(): string {
  return [
    buildPreamble(),
    buildSchemaSection(),
    buildExpressionSection(),
    buildSummarySection(),
    buildOptimizeSection(),
    buildFilterIfSection(),
    buildExampleSection(),
  ].join("\n");
}

/** Browser-only: trigger a download of the markdown reference. Builds a
 *  Blob URL, programmatically clicks an <a download>, then revokes the
 *  URL on the next tick so the browser actually starts the download
 *  before the URL becomes invalid. Date-stamped filename so a user
 *  iterating with multiple downloads can tell versions apart. */
export function downloadScriptReferenceMarkdown(): void {
  if (typeof window === "undefined") return;
  const text = buildScriptReferenceMarkdown();
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backtest-script-reference-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to actually start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
