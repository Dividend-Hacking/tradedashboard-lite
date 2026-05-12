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
import {
  EXPR_SYMBOLS,
  EXPR_OPERATORS,
  SUMMARY_SYMBOLS,
  type ExampleEntry,
} from "./script-expr";

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

/** Collect every worked example from a list of entries (schema rows or
 *  expression symbols), tagging each with the entry's headline so an AI
 *  reading the markdown still knows which example belongs to which
 *  symbol/path. Skips entries without examples — returns an empty list
 *  if nobody has any, so the caller can omit the whole "Examples for
 *  this section" block when there's nothing to show.
 *
 *  Stays as a separate Markdown block (NOT crammed into a table cell)
 *  because Markdown tables can't hold multi-line content — pipes get
 *  escaped fine, but newlines collapse and the layout breaks. */
function collectExamples(
  entries: { headline: string; examples?: ExampleEntry[] }[]
): { headline: string; ex: ExampleEntry }[] {
  const out: { headline: string; ex: ExampleEntry }[] = [];
  for (const e of entries) {
    if (!e.examples) continue;
    for (const ex of e.examples) out.push({ headline: e.headline, ex });
  }
  return out;
}

/** Render a section's worked examples as a markdown sub-block. Empty
 *  string when there are no examples — caller can append unconditionally. */
function formatExamplesBlock(
  entries: { headline: string; examples?: ExampleEntry[] }[]
): string {
  const all = collectExamples(entries);
  if (all.length === 0) return "";
  const lines: string[] = [];
  lines.push("**Examples for this section:**");
  lines.push("");
  for (const { headline, ex } of all) {
    // Escape pipes so this still renders cleanly even if the snippet
    // contains literal `|` characters (rare in the DSL but possible).
    const snip = ex.snippet.replace(/\|/g, "\\|");
    const scen = ex.scenario.replace(/\|/g, "\\|");
    lines.push(`- \`${snip}\` — *${scen}*  _(${headline})_`);
  }
  lines.push("");
  return lines.join("\n");
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
7. **🚫 DO NOT use \`params.*\` or \`loadstrategy\` when authoring a NEW strategy.** These are **LEGACY** — they were the old way of bolting tunables onto a hard-coded strategy preset. The modern approach is to express the entire entry/exit logic directly in the script using \`let\`, \`var\`, \`signal.long.if\` / \`signal.short.if\`, \`exit.if\` / \`exit.long.if\` / \`exit.short.if\`, and \`filter.if\`. A modern script never needs a single \`params.*\` line. Only touch \`params.*\` when the user is explicitly tweaking an EXISTING legacy preset they already loaded — and even then, prefer rewriting the logic in the modern DSL.
8. **Numeric \`rules.*\` fields accept full expressions**, not just literals. Examples: \`rules.stopLossPoints = ATR * 1.5\`, \`rules.trailingStopPoints = max(ticks(4), ATR * 0.5)\`.
9. **Use \`Optimize.X.Y(...)\` on \`rules.*\` numeric fields and inside \`var <name> = ...\`** when the user wants tuning rather than a fixed value. See the Optimize Directive section.
10. **Match indicators to the available data granularity** — see the next section. Order-flow and tick-resolution indicators silently return NaN on plain OHLCV sessions, which makes filter.if conditions reject every trade. If the user asks for a strategy using POC / CVD / delta etc., remind them the session must be tick or tick_bidask granularity.

## ⚠️ \`params.*\` and \`loadstrategy\` are LEGACY — do not use in new scripts

\`params.*\` and \`loadstrategy\` exist purely for backward compatibility with old presets that were authored against hard-coded strategy generators. **Treat them as read-only history.**

A modern script writes its entry and exit logic DIRECTLY using the strategy DSL:

| Legacy approach | Modern approach |
|---|---|
| \`params.entryZ = 2.0\` (tunes a hidden filter inside the strategy) | \`var entryZ = 2.0\` + \`signal.long.if = (close - kf.x_pred) / kf.sigma < -entryZ\` |
| \`params.minADX = 25\` (hidden inside strategy code) | \`filter.if = ADX(14) > 25\` |
| \`loadstrategy = signal_v2\` then a wall of \`params.*\` knobs | Pick \`strategy = ...\` if you need a baseline generator, then express the actual rules inline with \`signal.*.if\`, \`exit.*.if\`, \`filter.if\`, \`let\`, and \`var\` |

When in doubt: **never write a \`params.*\` line in a brand-new script.** If the user pastes one and asks you to extend it, suggest converting it to the modern DSL.

\`\`\`
# ❌ Legacy — opaque, requires knowing strategy internals.
loadstrategy = signal_v2
params.entryZ = 2.0
params.exitZ  = 0.5

# ✅ Modern — every condition is right there in the script.
let kf = KALMAN_OU(close, 60, 0.5)
let z  = (close - kf.x_pred) / kf.sigma
var entryZ = 2.0
var exitZ  = 0.5
signal.long.if  = cross_down(z,  -entryZ)
signal.short.if = cross_up(z,    entryZ)
exit.long.if    = cross_up(z,   -exitZ)
exit.short.if   = cross_down(z,  exitZ)
\`\`\`

## Session granularity & data dependencies

Replay sessions can be sourced at four data resolutions. The session's \`granularity\` field determines which DSL identifiers and indicators return real values:

| Granularity | OHLCV | bar_volume_bid / bar_volume_ask | Tick stream |
|---|:-:|:-:|:-:|
| \`ohlcv\` | yes | NO | NO |
| \`ohlcv_bidask\` | yes | yes | NO |
| \`tick\` | yes (re-aggregated) | NO (no side attribution) | yes (no side info) |
| \`tick_bidask\` | yes (re-aggregated) | yes | yes (with side info) |

Symbol families and their data requirements:

- **Standard indicators** (ATR, EMA, RSI, MACD, Keltner, PSAR, Ichimoku, Aroon, Vortex, Choppiness, Zscore, LRSlope, VWAP(N), KVO, ForceIndex, etc.) — work on ANY granularity. Pure OHLCV math.
- **Order-flow bar fields** (\`bar_volume_bid\`, \`bar_volume_ask\`, \`buy_volume\`, \`sell_volume\`, \`delta\`, \`delta_ratio\`, \`buy_pressure\`) and **cumulative delta** (\`CVD()\`) — require \`ohlcv_bidask\` or \`tick_bidask\`. Return NaN on plain \`ohlcv\` / \`tick\`.
- **Volume profile** (\`POC(N)\`, \`VAH(N)\`, \`VAL(N)\`, \`VA_width(N)\`, \`dist_to_POC(N)\`) — require \`tick\` or \`tick_bidask\` (the profile is built from raw trade prices). Computed over a rolling N-bar window. NaN otherwise.
- **Tick microstructure** (\`trades_at_bid(N)\`, \`trades_at_ask(N)\`, \`tick_imbalance(N)\`, \`tick_count(N)\`, \`mean_trade_size(N)\`, \`large_trade_count(N, threshold)\`, \`vwap_tick(N)\`) — require \`tick\` or \`tick_bidask\`. The bid/ask-attribution variants need \`tick_bidask\` specifically; without side info, \`trades_at_bid\` / \`trades_at_ask\` / \`tick_imbalance\` return all-zero counts.
- **Top-of-book quote** (\`spread(N)\`, \`bid_size(N)\`, \`ask_size(N)\`, \`quote_imbalance(N)\`, \`microprice(N)\`) — see RESTING liquidity at the inside bid/ask rather than executed flow. Require a v2 tick session (CSV header includes \`best_bid\` / \`best_ask\` columns); legacy 5-column tick blobs return NaN. Currently backtest-only — not supported by the NT8 transpiler.
- **Volume-profile node distances** (\`dist_to_hvn(N, area)\`, \`dist_to_lvn(N, area)\`) — signed normalized distance from current close to the nearest high/low-volume node in the rolling N-bar profile. Share the same ProfileCache as POC/VAH/VAL. Need \`tick\` or \`tick_bidask\`.
- **Footprint imbalance** (\`stacked_imbalance_up(ratio)\`, \`stacked_imbalance_down(ratio)\`) — max run length of consecutive price buckets in the current bar's footprint where one side's volume swamps the other by \`ratio\`. Classic 3-stacked footprint signal. Need \`tick_bidask\` for side attribution.
- **Sweep + Iceberg** (\`sweep_up(N, sizeMin)\`, \`sweep_down(N, sizeMin)\`, \`iceberg_at_ask(N, minRefills)\`, \`iceberg_at_bid(N, minRefills)\`) — sweeps detect aggressive prints that ate the entire visible quote; icebergs detect repeated refills at the same price level. Need a v2 tick session (quote columns).
- **Bar-level smoothing & compression** (\`ha_open()\`, \`ha_high()\`, \`ha_low()\`, \`ha_close()\`, \`squeeze_on(N, multBB, multKC)\`, \`squeeze_fire(N, multBB, multKC)\`) — Heiken Ashi smoothed candles and BB-inside-Keltner volatility-compression detection. Pure OHLC math; work on any granularity.

The dashboard exposes the active granularity in the session picker; assume the user's selected sessions support the indicators you reference unless they explicitly mention OHLCV-only data.

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
| \`strategy\` | Which baseline signal generator to run. Most modern scripts override entries entirely with \`signal.*.if\` and don't depend on this. |
| \`loadstrategy\` | ⚠️ **LEGACY** — hoisted directive that switches strategy AND resets every \`params.*\`. Avoid in new scripts; only use when intentionally restoring an old preset's defaults. |
| \`params.*\` | ⚠️ **LEGACY** — strategy-specific knobs from the hard-coded preset registry. **Do not use in new scripts.** Express the same tuning with \`var\` + the modern signal/filter DSL. Only emit \`params.*\` when explicitly editing an existing legacy preset the user already has. |
| \`rules.*\` | Risk rules: exits, ATR adjustments, position mode, scaling, daily limits, fills/costs. Numeric values can be full expressions. |
| \`filters.*\` | Pre-trade filters: time, ADX, ATR, trend, Bollinger, BB width, MA distance, volume, RSI, ADX trend. |
| \`let <name> = <expr>\` | Strategy DSL — bind a value (often a multi-output indicator like \`KALMAN_OU(...)\`) to a name reusable across \`signal.*\`, \`exit.*\`, \`filter.if\`, and prints. |
| \`var <name> = <expr>\` | Declare a tunable named number — the right-hand side may be a literal, an expression, or an \`Optimize.*(...)\` call. Use these names in \`signal.*.if\`, \`exit.*.if\`, \`filter.if\`, and \`rules.*\`. |
| \`signal.long.if = <bool-expr>\` / \`signal.short.if = <bool-expr>\` | Modern entry directives — fire a long/short signal when the expression is true. Multiple lines OR together. Replaces hard-coded entry logic from \`params.*\`-driven strategies. |
| \`exit.if = <bool-expr>\` / \`exit.long.if\` / \`exit.short.if\` | Conditional bar-by-bar exits. Independent of SL/TP/trail; whichever fires first wins. |
| \`print = <expr>[, "<label>"]\` | Post-run summary print directive. |
| \`graph = <expr>\` / \`graph["Title"] = <expr>\` | Add a P&L histogram to Trade Segment Analysis. The expression is evaluated at every surviving trade's entry bar; per-trade values are bucketed equal-width (10 bins) and plotted with the same chart shape as the built-in dimensions. Title defaults to the trimmed RHS source; the bracketed form supplies an explicit title. |
| \`ontrade.print = <expr>[, "<label>"]\` | Per-trade print directive. Evaluated AFTER each trade exits, so expressions can reference both entry-bar fields (\`close\`, \`ATR\`, ...) and exit-side bindings: \`exit_points\`, \`scaled_points\`, \`net_dollars\`, \`bars_held\`, \`peak_mfe\`, \`max_drawdown\`, \`position_size\`, \`commission_dollars\`, \`slippage_applied\`, \`is_winner\`, \`is_loser\`, \`exit_reason\`, \`eff_sl\`/\`eff_tp\`/\`eff_trail\`/\`eff_be\`, \`entry_price\`. \`exit_reason\` is a numeric code — compare against \`EXIT_TP\` / \`EXIT_SL\` / \`EXIT_TRAIL\` / \`EXIT_BE\` / \`EXIT_TIMER\` / \`EXIT_END\` / \`EXIT_NEXT\` / \`EXIT_DAILY\` / \`EXIT_SIGNAL\` (aliases: \`EXIT_TARGET\`=\`EXIT_TP\`, \`EXIT_STOP\`=\`EXIT_SL\`). |
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
  // Collect entries per-section so we can emit a "Examples for this
  // section" block right after each table — keeps each example
  // adjacent to the schema rows it belongs to without breaking the
  // table layout.
  let sectionEntries: ScriptSchemaEntry[] = [];

  const flushSection = () => {
    if (buffer.length === 0) return;
    lines.push(`### ${lastSection}`);
    lines.push("");
    // Per-section legacy callout: every path in the "Strategy params"
    // section is `params.*`, so flag the whole table as legacy and point
    // the AI reader at the modern DSL surface.
    if (lastSection === "Strategy params") {
      lines.push(
        "> ⚠️ **LEGACY SECTION.** These `params.*` paths exist for backward compatibility with old presets only. **Do not emit `params.*` lines in a new script** — express the same logic using `var`, `signal.*.if`, `exit.*.if`, `filter.if`, and `let` instead (see the preamble's modern-vs-legacy table). Only touch these paths when the user explicitly asks to edit an existing legacy preset."
      );
      lines.push("");
    }
    lines.push("| Path | Type | Default | Range / Options | Strategies | Description |");
    lines.push("|---|---|---|---|---|---|");
    for (const row of buffer) lines.push(row);
    lines.push("");
    const exBlock = formatExamplesBlock(
      sectionEntries.map((e) => ({ headline: e.path, examples: e.examples }))
    );
    if (exBlock) {
      lines.push(exBlock);
    }
    buffer = [];
    sectionEntries = [];
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
    sectionEntries.push(entry);
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
  lines.push("");
  lines.push("# Order-flow gating (requires ohlcv_bidask / tick_bidask):");
  lines.push("filter.if = delta_ratio > 0.2 && CVD > 0   // longs only on buy-aggression");
  lines.push("");
  lines.push("# Volume-profile context (requires tick / tick_bidask):");
  lines.push("filter.if = close > VAL(20) && close < VAH(20)  // trade only inside value");
  lines.push("rules.takeProfitPoints = abs(close - POC(20))   // target is the POC");
  lines.push("");
  lines.push("# Tick microstructure (requires tick / tick_bidask):");
  lines.push("filter.if = large_trade_count(5, 50) >= 3       // saw recent block prints");
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
    const exBlock = formatExamplesBlock(
      rows.map((s) => ({
        headline: s.signature ?? s.name,
        examples: s.examples,
      }))
    );
    if (exBlock) {
      lines.push(exBlock);
    }
  };

  renderTable(
    "Identifiers (bare names)",
    idents,
    "Used without parentheses. Three flavors: (a) fixed-period indicator aliases (e.g. ATR14, EMA200, RSI), (b) fields on the current entry bar (open, high, low, close, volume, bar_index, direction, plus bar-shape scalars range/body/typical/median_price/weighted_close), (c) order-flow bar fields and cumulative oscillators (bar_volume_bid, bar_volume_ask, buy_volume, sell_volume, delta, delta_ratio, buy_pressure, CVD, OBV, AD, AO, NVI, PVI, TR). Order-flow fields and CVD require ohlcv_bidask / tick_bidask granularity; otherwise NaN."
  );
  renderTable(
    "Function calls",
    calls,
    "Parametric forms. The bare-suffix shortcuts (EMA20, EMA50, EMA200, ATR14, ADX14) are equivalent to calling these with the corresponding period. Volume-profile and tick-microstructure calls (POC, VAH, VAL, VA_width, dist_to_POC, trades_at_bid/ask, tick_imbalance, tick_count, mean_trade_size, large_trade_count, vwap_tick) compute over a rolling N-bar window and REQUIRE a tick / tick_bidask session — they return NaN on plain OHLCV. Top-of-book quote calls (spread, bid_size, ask_size, quote_imbalance, microprice) additionally require a v2 tick session (one whose CSV includes best_bid/best_ask columns)."
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
  const exBlock = formatExamplesBlock(
    SUMMARY_SYMBOLS.map((s) => ({ headline: s.name, examples: s.examples }))
  );
  if (exBlock) {
    lines.push(exBlock);
  }
  return lines.join("\n");
}

/** The Optimize directive — hand-written narrative because the syntax
 *  is recursive enough that a flat symbol table doesn't capture it. */
function buildOptimizeSection(): string {
  return `## Optimize directive — let the dashboard pick numbers for you

Instead of writing a fixed value for a \`rules.*\` number, write \`Optimize.<Objective>.<LookbackUnit>(lookback, min, max[, step])\` and the dashboard will search for the best value WHILE the backtest runs. After enough trades happen to fill the window, every new trade triggers a quick search and uses the winner.

### Numeric form

\`\`\`
rules.stopLossPoints     = Optimize.DailyEV.trades(30, 10, 40)
rules.timedExitBars      = Optimize.Sharpe.bars(500, 5, 50, 1)
rules.trailingStopPoints = Optimize.MinDrawdown.trades(50, ticks(4), ATR * 2)
\`\`\`

- \`lookback\` — how far back the dashboard looks when judging which value is winning.
- \`min\` / \`max\` — the smallest and biggest values to try. Can be expressions (\`ATR\`, \`ticks(4)\`, \`EMA20 * 0.1\`) — re-checked at each trade.
- \`step\` (optional) — only try values in this jump size (good for integer-like fields).

### Categorical form (coming soon)

\`\`\`
filters.trend.ema20 = Optimize.WinRate.trades(30, (with, against))
\`\`\`

For non-numeric settings, list the choices in parentheses. The parser reads this today, but actually picking the choice at runtime isn't wired up yet — only number-Optimize on \`rules.*\` runs in this build.

### Objectives — what \"best\" means

| Objective | Meaning |
|---|---|
| \`DailyEV\` | Most points per trading day. |
| \`EV\` | Most points per trade. |
| \`Sharpe\` | Smoothest, most consistent returns. |
| \`MinDrawdown\` | Smallest worst-day pain. |
| \`WinRate\` | Highest percentage of winners. |
| \`ProfitFactor\` | Total wins ÷ total losses. |

### Lookback units — what \"window\" means

\`trades\` counts completed trades (e.g. last 30 trades). \`bars\`, \`minutes\`, \`seconds\`, \`hours\` are time-based. While the window is still filling, the field uses its starting default (warmup phase).

### \`OptimizeAll\`

\`\`\`
OptimizeAll = false   # default — each Optimize line tunes on its own
OptimizeAll = true    # all Optimize lines tune together as a team
\`\`\`

When \`true\`, every \`Optimize.*\` line in the script must measure the same thing (same objective).

### \`Warmup\`

\`\`\`
Warmup = true    # default — keep the early warmup trades in your final stats
Warmup = false   # hide warmup trades; final stats only count optimized ones
\`\`\`

`;
}

/** filter.if directive — narrative section. The action statement
 *  language inside branch slots is its own mini-DSL distinct from the
 *  outer line-based script, so a hand-written explanation gives the
 *  AI a much clearer picture than a raw schema row. */
function buildFilterIfSection(): string {
  return `## \`filter.if\` directive — conditional gating with action statements

Decides whether each trade should fire. If you have multiple \`filter.if\` lines, they ALL have to agree before the trade goes through. Each one is checked at the moment of entry, against indicators, bar fields, and tick helpers.

### Single-arg form — just a yes/no gate

\`\`\`
filter.if = ATR(14) > 0.5
filter.if = ADX > 25 && close > EMA20
\`\`\`

Write a yes/no expression using comparisons (\`> < >= <= == !=\`) and logicals (\`&& || !\`). The trade passes when the answer is yes. If the answer is "unknown" (because of missing data), the trade is rejected — fail-safe by default.

### 3-arg form — different actions for each branch

\`\`\`
filter.if = (cond, if_true_actions, if_false_actions)
filter.if = (cond, if_true_actions)              # if_false omitted = default reject
filter.if = (cond, , if_false_actions)           # if_true omitted = default pass
\`\`\`

**Important rule about empty slots:**
- Empty slot → default verdict applies (true → pass, false → reject).
- Filled slot → REPLACES the default. The implicit verdict becomes PASS unless the slot contains an explicit \`reject\`. So if you want to "reject AND print a message on failure", you MUST write \`reject\` in the slot:

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
