/**
 * /script-reference — Standalone reference page for the Script DSL.
 *
 * Opened in a new tab from the "Reference ↗" button on the script-mode
 * sticky control bar. Replaces the old slide-out panel because users
 * found a docked panel disruptive when iterating.
 *
 * Layout:
 *   - LEFT: sticky TOC sidebar listing every section. Clicking a row
 *     smooth-scrolls the right pane to that section AND highlights
 *     the active row (driven by IntersectionObserver on the section
 *     headers). Sections that are collapsed are still scrollable to
 *     so the click-to-jump always works.
 *   - RIGHT: collapsible sections. Each section has a header you can
 *     click to expand/collapse; the chevron rotates to indicate state.
 *     A search filter narrows entries within every open section AND
 *     auto-expands sections whose entries match — so a search reveals
 *     hits regardless of prior collapsed state.
 *
 * Source of truth: SCRIPT_SCHEMA (config paths) + EXPR_SYMBOLS
 * (per-trade expression symbols) + SUMMARY_SYMBOLS (post-run summary
 * identifiers). Adding a row anywhere in those arrays auto-surfaces in
 * the matching section here.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SCRIPT_SCHEMA, ScriptSchemaEntry } from "@/lib/utils/backtest-script";
import { EXPR_SYMBOLS, SUMMARY_SYMBOLS } from "@/lib/utils/script-expr";
import { downloadScriptReferenceMarkdown } from "@/lib/utils/script-reference-export";

// ─── Curated documentation groups ───────────────────────────────────────────
//
// The raw EXPR_SYMBOLS / SUMMARY_SYMBOLS arrays are exhaustive — they list
// every variant the parser accepts (ATR, ATR14, EMA20, EMA50, EMA200, …)
// because the editor's autocomplete needs the full inventory. For the docs
// page we collapse those into ONE entry per indicator family, with a
// `[period]` placeholder in the headline and the shortcut forms listed
// underneath. Far less scrolling, much clearer mental model.
//
// Adding a new indicator: extend INDICATOR_FAMILIES below AND keep
// EXPR_SYMBOLS in sync (so autocomplete still surfaces every variant).

interface IndicatorFamily {
  /** Headline label. Use `[period]` to indicate the parametric arg —
   *  matches the user-facing docs convention even though the actual
   *  syntax uses parentheses. */
  headline: string;
  /** Concrete syntactic forms the parser accepts. Listed in order of
   *  recommendation: function-call form first, then bare shortcuts. */
  forms: string[];
  description: string;
}

const INDICATOR_FAMILIES: IndicatorFamily[] = [
  {
    headline: "ATR[period]",
    forms: ["ATR(period)", "ATR (= ATR(14))", "ATR14"],
    description:
      "Wilder Average True Range over the last `period` bars at entry. Bare ATR defaults to period 14.",
  },
  {
    headline: "EMA[period]",
    forms: ["EMA(period)", "EMA20", "EMA50", "EMA200"],
    description:
      "Exponential moving average of close over `period` bars. Bare-suffix forms (EMA20, EMA50, EMA200) are common shortcuts; any EMA<n> with a numeric suffix resolves automatically.",
  },
  {
    headline: "SMA[period]",
    forms: ["SMA(period)", "SMA20", "SMA50", "SMA200"],
    description:
      "Simple moving average of close over `period` bars. Same shortcut convention as EMA — SMA<n> resolves to SMA(n).",
  },
  {
    headline: "ADX[period]",
    forms: ["ADX(period)", "ADX (= ADX(14))", "ADX14"],
    description:
      "Wilder Average Directional Index over `period` bars at entry. Bare ADX defaults to period 14.",
  },
  {
    headline: "volume[period]",
    forms: ["volume(period)", "trailVol(period)", "volume (current bar)"],
    description:
      "Trailing average volume over the last `period` bars. `trailVol(n)` is an alias. Bare `volume` (no parens) is the CURRENT bar's volume — not a trailing average.",
  },
  {
    headline: "stdev[period]",
    forms: ["stdev(period)"],
    description:
      "Sample standard deviation of close-to-close log returns over the trailing `period` bars.",
  },

  // ─── Extended moving averages ──────────────────────────────────────────
  {
    headline: "WMA[period]",
    forms: ["WMA(period)", "WMA20"],
    description:
      "Weighted moving average — linear weights 1..N over the trailing `period` closes (heavier on recent bars). Denominator N*(N+1)/2.",
  },
  {
    headline: "HMA[period]",
    forms: ["HMA(period)", "HMA20"],
    description:
      "Hull Moving Average — WMA(2*WMA(period/2) − WMA(period), sqrt(period)). Faster-reacting and less laggy than EMA.",
  },
  {
    headline: "DEMA[period] / TEMA[period]",
    forms: ["DEMA(period)", "TEMA(period)", "DEMA20", "TEMA20"],
    description:
      "Double / Triple Exponential MA. DEMA = 2·EMA − EMA(EMA). TEMA = 3·EMA − 3·EMA(EMA) + EMA(EMA(EMA)). Both reduce lag versus a plain EMA.",
  },
  {
    headline: "VWMA[period]",
    forms: ["VWMA(period)", "VWMA20"],
    description:
      "Volume-weighted moving average — sum(close × volume) / sum(volume) over the trailing `period` bars.",
  },

  // ─── Momentum / oscillators ────────────────────────────────────────────
  {
    headline: "RSI[period]",
    forms: ["RSI(period)", "RSI (= RSI(14))", "RSI14"],
    description:
      "Wilder Relative Strength Index — RSI = 100 − 100/(1+RS), RS = avgGain/avgLoss. Range [0, 100]. Standard period 14.",
  },
  {
    headline: "ROC[period] / MOM[period]",
    forms: ["ROC(period)", "MOM(period)", "ROC10", "MOM10"],
    description:
      "Rate of Change as a percentage (ROC) and raw momentum (MOM = close − close[period bars ago]). MOM is in raw price points; ROC is dimensionless.",
  },
  {
    headline: "CCI[period]",
    forms: ["CCI(period)", "CCI20"],
    description:
      "Commodity Channel Index — (TP − SMA(TP)) / (0.015 × mean_dev(TP)) over `period` bars. TP = (h+l+c)/3. Standard period 20; values beyond ±100 indicate extended moves.",
  },
  {
    headline: "WilliamsR[period]",
    forms: ["WilliamsR(period)"],
    description:
      "Williams %R — −100 × (HHV − close) / (HHV − LLV) over `period` bars. Range [−100, 0]. Mixed-case name does not have a numeric-suffix shortcut.",
  },
  {
    headline: "TRIX[period] / MFI[period]",
    forms: ["TRIX(period)", "MFI(period)", "TRIX14", "MFI14"],
    description:
      "TRIX — 1-bar % ROC of the triple-EMA-smoothed log close (signed momentum filtered through three EMAs). MFI — RSI applied to typical-price × volume signed by direction; range [0, 100].",
  },

  // ─── Multi-output families ─────────────────────────────────────────────
  {
    headline: "MACD_line / MACD_signal / MACD_hist",
    forms: [
      "MACD_line(fast, slow)",
      "MACD_signal(fast, slow, signal=9)",
      "MACD_hist(fast, slow, signal=9)",
    ],
    description:
      "Moving Average Convergence/Divergence — split into separate single-scalar functions. Line = EMA(fast) − EMA(slow). Signal = EMA(line, signal). Hist = line − signal. Standard (12, 26, 9). signal defaults to 9 if omitted.",
  },
  {
    headline: "BB_upper / BB_mid / BB_lower / BB_width / BB_percent",
    forms: [
      "BB_mid(period)",
      "BB_upper(period, mult=2)",
      "BB_lower(period, mult=2)",
      "BB_width(period, mult=2)",
      "BB_percent(period, mult=2)",
    ],
    description:
      "Bollinger Bands. mid = SMA(close, period). upper/lower = mid ± mult × popStdev(close, period). width = (upper − lower)/mid. %B = (close − lower)/(upper − lower) — 0 at lower band, 1 at upper. mult defaults to 2 if omitted.",
  },
  {
    headline: "Stoch_K / Stoch_D",
    forms: [
      "Stoch_K(period)",
      "Stoch_D(period, smoothK=3, smoothD=3)",
    ],
    description:
      "Fast Stochastic %K = 100 × (close − LLV) / (HHV − LLV). Slow %D = SMA(SMA(K, smoothK), smoothD). Range [0, 100]. Defaults: smoothK=3, smoothD=3.",
  },
  {
    headline: "Donchian_upper / Donchian_lower / Donchian_mid",
    forms: [
      "Donchian_upper(period)",
      "Donchian_lower(period)",
      "Donchian_mid(period)",
    ],
    description:
      "Donchian channel — upper = HHV(high, period), lower = LLV(low, period), mid = (upper + lower)/2. Useful for breakout filters and channel mean-reversion strategies.",
  },

  // ─── Volatility ────────────────────────────────────────────────────────
  {
    headline: "TR / NATR[period] / HV[period]",
    forms: ["TR", "TR()", "NATR(period)", "HV(period)", "NATR14", "HV20"],
    description:
      "TR — true range of the current bar (max(h−l, |h−prevClose|, |l−prevClose|)). NATR — 100 × ATR / close (volatility as a percent of price). HV — un-annualized sample stdev of log returns; multiply by sqrt(252) to annualize.",
  },

  // ─── Volume / cumulative ───────────────────────────────────────────────
  {
    headline: "OBV / AD / CMF[period]",
    forms: [
      "OBV", "OBV()",
      "AD", "AD()",
      "CMF(period)", "CMF20",
    ],
    description:
      "OBV — running cumulative volume signed by close-vs-prev-close. AD — running A/D line (money-flow multiplier × volume). CMF — Chaikin Money Flow over `period` bars; range [−1, 1], positive = buying pressure.",
  },

  // ─── Bar-shape scalars ─────────────────────────────────────────────────
  {
    headline: "range / body / upper_wick / lower_wick",
    forms: ["range", "body", "upper_wick", "lower_wick"],
    description:
      "Current-bar shape scalars: range = high − low, body = close − open (signed), upper_wick = high − max(open, close), lower_wick = min(open, close) − low. No precompute — read directly from the entry bar.",
  },
  {
    headline: "typical / median_price / weighted_close",
    forms: ["typical", "median_price", "weighted_close"],
    description:
      "Composite prices on the current bar: typical = (h+l+c)/3, median_price = (h+l)/2, weighted_close = (h+l+2c)/4. Used as inputs to several indicators (CCI uses typical; MFI uses typical × volume).",
  },

  // ─── Lookback scalars ──────────────────────────────────────────────────
  {
    headline: "HHV[period] / LLV[period]",
    forms: ["HHV(period)", "LLV(period)", "HHV20", "LLV20"],
    description:
      "Highest high / lowest low over the last `period` bars (current bar inclusive). Common in breakout, channel-stop, and Donchian filters.",
  },
  {
    headline: "close_n(n) / high_n(n) / low_n(n) / open_n(n) / volume_n(n)",
    forms: [
      "close_n(n)", "high_n(n)", "low_n(n)", "open_n(n)", "volume_n(n)",
    ],
    description:
      "OHLCV value `n` bars before the current bar. close_n(1) is the previous bar's close. NaN at indices i < n. Useful for explicit cross-bar comparisons (e.g. close > close_n(1)).",
  },

  {
    headline: "ticks(n) / point(n)",
    forms: [
      "ticks(n)",
      "point(n)",
      "ticksPerPoint",
      "tickValue",
      "pointValue",
    ],
    description:
      "Tick / point conversion helpers. By default (rules.tickConfigMode = \"auto\"), values resolve from each zone's instrument symbol: NQ/ES = 4 ticks/pt, GC/RTY = 10, CL = 100, BTC = 0.2, ZB = 32, ZN = 64, etc. (full table in src/lib/utils/futures.ts). When tickConfigMode = \"manual\", rules.ticksPerPoint / tickValue / pointValue take effect instead. ticks(n) = n / ticksPerPoint (n ticks expressed as price points). point(n) = n × ticksPerPoint. Useful inside Optimize bounds: `Optimize.X.Y(30, ticks(4), 40)` searches a min stop of 1 point on NQ, 0.4 points on GC, 0.04 on CL, etc.",
  },
];

const BAR_FIELDS = EXPR_SYMBOLS.filter(
  (s) =>
    s.kind === "ident" &&
    ["open", "high", "low", "close", "volume", "bar_index", "direction"].includes(s.name)
);

const MATH_FUNCTIONS = EXPR_SYMBOLS.filter((s) => s.kind === "math");

// Summary identifiers — group aliases together so the docs say
// "avgBarsHeld (also avgtradetime)" instead of listing both as separate
// rows. The first name in the array is the canonical one.
interface SummaryGroup {
  names: string[];
  description: string;
}

const SUMMARY_GROUPS: SummaryGroup[] = (() => {
  // Build from SUMMARY_SYMBOLS, then merge known aliases. Keeping this
  // derivation here (not in script-expr.ts) so the engine's symbol
  // catalogue stays a flat lookup table.
  const aliasOf: Record<string, string> = {
    avgtradetime: "avgBarsHeld",
    totalPnl: "totalPoints",
  };
  const byCanonical = new Map<string, SummaryGroup>();
  for (const s of SUMMARY_SYMBOLS) {
    const canonical = aliasOf[s.name] ?? s.name;
    let group = byCanonical.get(canonical);
    if (!group) {
      group = { names: [canonical], description: "" };
      byCanonical.set(canonical, group);
    }
    if (s.name === canonical) {
      group.description = s.description;
    } else if (!group.names.includes(s.name)) {
      group.names.push(s.name);
    }
  }
  return Array.from(byCanonical.values());
})();

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDefault(entry: ScriptSchemaEntry): string {
  const v = entry.default;
  if (Array.isArray(v)) return `[${v.map((x) => `"${x}"`).join(", ")}]`;
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function formatRange(entry: ScriptSchemaEntry): string {
  if (entry.type !== "int" && entry.type !== "float") return "";
  const parts: string[] = [];
  if (entry.min !== undefined) parts.push(`min ${entry.min}`);
  if (entry.max !== undefined) parts.push(`max ${entry.max}`);
  if (entry.step !== undefined) parts.push(`step ${entry.step}`);
  return parts.join(" · ");
}

/** Stable, URL-safe id derived from a section name. Used both as the
 *  scroll-target id on each section header and as the key the TOC's
 *  IntersectionObserver compares against. */
function sectionId(name: string): string {
  return "sec-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Section model ──────────────────────────────────────────────────────────
//
// Both schema entries and expression symbols are flattened into the same
// "Section" shape so the TOC + collapsible-list rendering can walk a
// uniform structure. A discriminator (`kind`) on each entry tells the
// renderer which card layout to use.

type SchemaCard = { kind: "schema"; entry: ScriptSchemaEntry };
type IndicatorCard = { kind: "indicator"; family: IndicatorFamily };
type BarFieldCard = { kind: "barfield"; name: string; description: string };
type MathCard = { kind: "math"; signature: string; description: string };
type SummaryCard = { kind: "summary"; group: SummaryGroup };
type OptimizeCard = {
  kind: "optimize";
  /** Headline shown at the top of the card — typically the syntax
   *  pattern the user types. */
  headline: string;
  /** Concrete forms / examples the parser accepts. Renders as the
   *  "code chip" strip below the description. */
  forms: string[];
  description: string;
};

type Card =
  | SchemaCard
  | IndicatorCard
  | BarFieldCard
  | MathCard
  | SummaryCard
  | OptimizeCard;

interface Section {
  name: string;
  /** Optional preamble shown above the cards. Keeps the
   *  section list self-explanatory without forcing every card to
   *  re-explain the context (entry vs summary, etc.). */
  blurb?: string;
  cards: Card[];
}

// Section names for the curated expression / summary groups. Stable
// strings so the TOC's section ids stay sticky across renders.
const SECTION_INDICATORS = "Indicators (entry context)";
const SECTION_BAR_FIELDS = "Bar fields (entry context)";
const SECTION_MATH = "Math functions";
const SECTION_SUMMARY = "Summary identifiers (post-run context)";
const SECTION_OPTIMIZE = "Optimize directive (Script v3)";

// Curated content for the Optimize section — covers the syntax,
// objectives, lookback units, and OptimizeAll. Hand-written so the
// reader gets a coherent narrative instead of a flat list of regex
// fragments.
const OPTIMIZE_CARDS: OptimizeCard[] = [
  {
    headline: "Numeric form",
    forms: [
      "rules.stopLossPoints = Optimize.DailyEV.trades(30, 10, 40)",
      "rules.timedExitBars = Optimize.Sharpe.bars(500, 5, 50, 1)",
    ],
    description:
      "RHS is a function-call: Optimize.<Objective>.<LookbackUnit>(lookback, min, max[, step]). The optimizer searches the [min, max] range — snapped to step when provided — for the value that maximizes the objective over the last `lookback` units. Numeric Optimize is supported on rules.* fields in v1.",
  },
  {
    headline: "Categorical form (preview)",
    forms: ["filters.trend.ema20 = Optimize.WinRate.trades(30, (with, against))"],
    description:
      "Replace (min, max) with parentheses-wrapped option list to optimize an enum field. Bare-word options match the schema's allowed values verbatim. Categorical Optimize on enum/filter fields is parsed but NOT yet applied at run time in this build — coming in a follow-up. For now, only rules.* numeric Optimize executes.",
  },
  {
    headline: "Objectives",
    forms: ["DailyEV", "EV", "Sharpe", "MinDrawdown", "WinRate", "ProfitFactor"],
    description:
      "What the optimizer tries to maximize. MinDrawdown is internally maximized as -maxDrawdown so smaller drawdowns score higher. ProfitFactor with no losing trades is capped at a large finite value to keep the TPE math stable.",
  },
  {
    headline: "Lookback units",
    forms: ["trades", "bars", "minutes", "seconds", "hours"],
    description:
      "The window over which the optimizer scores candidates. `trades` is count-based (last N completed trades). The others are time-based — slice trades whose entry_time falls within the last N units. Until the lookback fills, the field uses its literal default (warmup phase).",
  },
  {
    headline: "OptimizeAll",
    forms: ["OptimizeAll = true", "OptimizeAll = false (default)"],
    description:
      "When true, all Optimize.X.Y(...) directives in this script share one TPE search over the joint multi-dim space — they must agree on the objective. When false (default), each directive optimizes independently, holding the others at their literal defaults.",
  },
  {
    headline: "Trigger semantics",
    forms: ["Run button"],
    description:
      "Pressing Run executes the script as a backtest, including online TPE optimization when directives are present. Optimization happens INSIDE the backtest — after a warmup of `lookback` completed trades, every new signal triggers a fresh TPE search over its window, and the resulting values are used for that trade. The Output panel surfaces the chosen value at each trade as a sparkline.",
  },
  {
    headline: "var <name> = Optimize.X.Y(...)",
    forms: [
      "var rsiLow = Optimize.DailyEV.trades(10, 1, 100)",
      "var rsiHigh = Optimize.DailyEV.trades(10, 50, 99)",
      "filter.if = (RSI(14) >= rsiLow && RSI(14) <= rsiHigh, , reject)",
    ],
    description:
      "Declare an Optimize-driven variable usable as a bare identifier in any expression — filter.if conditions, rules.* RHS, prints, etc. The optimizer searches each var's [min, max] range using the same TPE machinery that drives rules.* directives; the resolved value is stamped into the entry-context EvalCtx per signal. Inline Optimize.X.Y(...) inside a filter.if condition is also supported — it's auto-lifted to a synthetic var at parse time. Names must be valid identifiers (letters/digits/underscore, can't start with a digit) and can't collide with bar fields (open/high/low/close), bar-shape scalars (range/body/typical/...), tick-config aliases (ticksPerPoint/...), or the cumulative indicators (OBV/AD/TR).",
  },
  {
    headline: "Pre-warmup behavior + auto-disable",
    forms: [
      "var x = Optimize.DailyEV.trades(10, 1, 100)",
      "filter.if = (RSI(14) >= x, , reject)  // auto-disabled during warmup",
      "var y = Optimize.DailyEV.trades(10, 1, 100) default 50",
      "filter.if = (RSI(14) >= y, , reject)  // applies from trade 1 with y=50",
    ],
    description:
      "Filter.if directives whose cond references an UNRESOLVED Optimize-driven var (no value yet, no `default` clause) are SKIPPED during the optimizer's warmup phase — equivalent to the filter not being there for that signal. This breaks the chicken-and-egg deadlock where pre-warmup the var is NaN, the cond is false, and every trade gets rejected, preventing the optimizer from ever filling its lookback. Other filters (gating on RSI, ATR, etc.) still apply during warmup. Add `default <numeric-literal>` to a var's Optimize spec to force pre-warmup resolution to that literal — the filter then applies from trade 1 using the default value, and transitions to the optimizer's choice once the lookback fills. Defaults work for inline Optimize too — `Optimize.X.Y(...) default 30` inside a cond.",
  },
  {
    headline: "Warmup = boolean",
    forms: [
      "Warmup = true  // (default) include warmup trades in final stats",
      "Warmup = false  // exclude warmup trades — final stats reflect only the optimized phase",
    ],
    description:
      "Top-level boolean flag controlling whether trades fired during the optimizer's warmup phase are included in the final returned trade list. Default true — matches the original behavior where warmup trades are visible alongside post-warmup trades. Set false when you want stats and the trade table to reflect ONLY the optimized run (cleaner output for evaluating the optimizer's effect). The optimizer ALWAYS uses warmup trades internally for its lookback math; this flag only affects the FINAL filtering before stats. Each emitted trade carries an `isWarmup` flag so even with Warmup=true, downstream UI code can distinguish warmup vs post-warmup trades.",
  },
];

/** Build the full section list, applying the search filter consistently
 *  across schema rows + curated expression groups. Returns BOTH the
 *  filtered list (for rendering) and the full list of section names
 *  (for the TOC, which always shows every section name even when empty
 *  so the user understands what exists in the reference). */
function buildSections(query: string): {
  sections: Section[];
  allNames: string[];
} {
  const q = query.trim().toLowerCase();
  const has = (s: string) => s.toLowerCase().includes(q);
  const matchSchema = (e: ScriptSchemaEntry) =>
    !q || has(e.path) || has(e.description) || has(e.section);

  // Schema sections — preserve the schema's declaration order so the
  // page reads in the same sequence as a serialized script.
  const schemaSections: Section[] = [];
  for (const e of SCRIPT_SCHEMA) {
    if (!matchSchema(e)) continue;
    const last = schemaSections[schemaSections.length - 1];
    if (last && last.name === e.section) {
      last.cards.push({ kind: "schema", entry: e });
    } else {
      schemaSections.push({ name: e.section, cards: [{ kind: "schema", entry: e }] });
    }
  }

  // Curated expression-engine sections — collapse the EXPR_SYMBOLS
  // duplicates (ATR / ATR14, EMA20 / EMA50 / EMA200, …) into one card
  // per indicator family with a `[period]` headline and the available
  // forms listed underneath. Bar fields and Math functions are listed
  // verbatim — they don't have alias clutter to collapse.
  const indicators: Section = {
    name: SECTION_INDICATORS,
    blurb:
      "Available inside expressions on rules.* numeric fields and inside ontrade.print directives. Evaluated at each trade's entry bar. The `[period]` placeholder maps to the parser's actual `(period)` syntax — both function-call form and bare shortcuts work.",
    cards: INDICATOR_FAMILIES.filter(
      (f) =>
        !q ||
        has(f.headline) ||
        has(f.description) ||
        f.forms.some((form) => has(form))
    ).map((family) => ({ kind: "indicator", family })),
  };
  const barFields: Section = {
    name: SECTION_BAR_FIELDS,
    blurb:
      "Bare identifiers that resolve to fields on the trade's entry bar. No parentheses; no parameters.",
    cards: BAR_FIELDS.filter((s) => !q || has(s.name) || has(s.description)).map(
      (s) => ({ kind: "barfield", name: s.name, description: s.description })
    ),
  };
  const math: Section = {
    name: SECTION_MATH,
    blurb:
      "Standard math passthroughs. Available in BOTH expression contexts (entry-bar and post-run summary).",
    cards: MATH_FUNCTIONS.filter(
      (s) => !q || has(s.name) || has(s.signature ?? "") || has(s.description)
    ).map((s) => ({
      kind: "math",
      signature: s.signature ?? s.name,
      description: s.description,
    })),
  };
  const summary: Section = {
    name: SECTION_SUMMARY,
    blurb:
      "Available inside print = … directives. Evaluated once after each backtest run against aggregate stats. Aliases shown in parentheses (e.g. avgBarsHeld doubles as avgtradetime).",
    cards: SUMMARY_GROUPS.filter(
      (g) => !q || g.names.some(has) || has(g.description)
    ).map((group) => ({ kind: "summary", group })),
  };
  const optimize: Section = {
    name: SECTION_OPTIMIZE,
    blurb:
      "Online TPE optimization for rules.* fields. Press Run to execute — every new signal triggers a fresh search over the lookback window using a Tree-structured Parzen Estimator. Optimized values land on the dashboard live and are surfaced as sparklines in the Output panel.",
    cards: OPTIMIZE_CARDS.filter(
      (c) =>
        !q || has(c.headline) || has(c.description) || c.forms.some(has)
    ).map((c) => ({
      kind: "optimize",
      headline: c.headline,
      forms: c.forms,
      description: c.description,
    })),
  };

  const filtered: Section[] = [...schemaSections];
  if (indicators.cards.length > 0) filtered.push(indicators);
  if (barFields.cards.length > 0) filtered.push(barFields);
  if (math.cards.length > 0) filtered.push(math);
  if (summary.cards.length > 0) filtered.push(summary);
  if (optimize.cards.length > 0) filtered.push(optimize);

  // Always-present full list for the TOC so the user can see the
  // available sections even when a search hides them all.
  const fullSchemaNames = Array.from(new Set(SCRIPT_SCHEMA.map((e) => e.section)));
  const allNames = [
    ...fullSchemaNames,
    SECTION_INDICATORS,
    SECTION_BAR_FIELDS,
    SECTION_MATH,
    SECTION_SUMMARY,
    SECTION_OPTIMIZE,
  ];

  return { sections: filtered, allNames };
}

// ─── Card renderers ─────────────────────────────────────────────────────────

function SchemaCardView({ entry }: { entry: ScriptSchemaEntry }) {
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <code className="text-sm text-sky-300 font-mono">{entry.path}</code>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {entry.type}
          {entry.options && entry.type !== "stringArray"
            ? ` · ${entry.options.length} options`
            : ""}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {entry.description}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2 text-[11px] font-mono text-muted-foreground/80">
        {entry.type !== "directive" && (
          <span>
            default <span className="text-foreground/80">{formatDefault(entry)}</span>
          </span>
        )}
        {formatRange(entry) && <span>{formatRange(entry)}</span>}
        {entry.options && (
          <span>
            options{" "}
            <span className="text-foreground/80">
              {entry.options.map((o) => `"${o}"`).join(" | ")}
            </span>
          </span>
        )}
        {entry.strategies && entry.strategies.length > 0 && (
          <span>
            strategies{" "}
            <span className="text-foreground/80">{entry.strategies.join(", ")}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function IndicatorCardView({ family }: { family: IndicatorFamily }) {
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <code className="text-sm text-sky-300 font-mono">{family.headline}</code>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
          indicator
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {family.description}
      </p>
      {/* Forms strip — the actual syntactic shapes the parser accepts.
          Putting these BELOW the description means readers grok the
          concept first ("EMA over a period") and then see the concrete
          syntax ("EMA(20), EMA20, …"). */}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {family.forms.map((form) => (
          <code
            key={form}
            className="text-[11px] font-mono bg-background/60 border border-card-border/60 rounded px-1.5 py-0.5 text-foreground/80"
          >
            {form}
          </code>
        ))}
      </div>
    </div>
  );
}

function BarFieldCardView({ name, description }: { name: string; description: string }) {
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <code className="text-sm text-sky-300 font-mono">{name}</code>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function MathCardView({
  signature,
  description,
}: {
  signature: string;
  description: string;
}) {
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <code className="text-sm text-sky-300 font-mono">{signature}</code>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
          math
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function SummaryCardView({ group }: { group: SummaryGroup }) {
  const [primary, ...aliases] = group.names;
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <code className="text-sm text-sky-300 font-mono">
        {primary}
        {aliases.length > 0 && (
          <span className="text-muted-foreground/80 font-normal text-xs">
            {" "}(also {aliases.join(", ")})
          </span>
        )}
      </code>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {group.description}
      </p>
    </div>
  );
}

function OptimizeCardView({
  headline,
  forms,
  description,
}: {
  headline: string;
  forms: string[];
  description: string;
}) {
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-foreground">{headline}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
          optimize
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {description}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {forms.map((form) => (
          <code
            key={form}
            className="text-[11px] font-mono bg-background/60 border border-card-border/60 rounded px-1.5 py-0.5 text-foreground/80"
          >
            {form}
          </code>
        ))}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ScriptReferencePage() {
  const [query, setQuery] = useState("");
  const { sections, allNames } = useMemo(() => buildSections(query), [query]);

  // Per-section collapsed state. Default: all expanded so the user
  // sees content immediately. We store this as a Set of EXPANDED section
  // names (rather than collapsed) so a fresh visit to the page with no
  // entry in the set means "default-expanded".
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(allNames));

  // When the search query changes, auto-expand any section that has
  // matches so users don't have to manually open them. Empty query
  // restores user's last expanded set (we treat empty as "show all").
  useEffect(() => {
    if (query.trim() === "") return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const sec of sections) next.add(sec.name);
      return next;
    });
  }, [query, sections]);

  const toggleSection = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const expandAll = () => setExpanded(new Set(allNames));
  const collapseAll = () => setExpanded(new Set());

  // ── Active-section tracking for TOC highlight ─────────────────────
  // IntersectionObserver fires when a section's header crosses the
  // designated rootMargin band; we keep a ref to the most-recent
  // intersecting id so the TOC can render a highlight without
  // re-observing on every scroll. The 0px/-70%/0px/0px rootMargin
  // means "the section is considered active when its header is in
  // the top 30% of the viewport" — a conventional pattern for
  // table-of-contents highlighting.
  const [activeId, setActiveId] = useState<string | null>(null);
  const headerRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry closest to the top of the viewport that's
        // currently intersecting — gives the cleanest visual cue when
        // multiple short sections are visible at once.
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort(
          (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
        );
        setActiveId(visible[0].target.id);
      },
      {
        // Top-30% band: a header counts as "active" when it sits
        // within the upper third of the viewport. Tweak if the page's
        // sticky search bar height changes meaningfully.
        rootMargin: "0px 0px -70% 0px",
        threshold: 0,
      }
    );
    for (const el of headerRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
    // We intentionally re-observe whenever the section list changes
    // (search-filter add/remove). `sections` is a derived array; its
    // identity changes on each filtered build, which is the trigger.
  }, [sections]);

  const scrollToSection = (name: string) => {
    const id = sectionId(name);
    const el = document.getElementById(id);
    if (!el) return;
    // If the section is collapsed, expand it so the click-to-jump
    // also reveals the content. Otherwise users would land on a
    // collapsed header and wonder where the entries went.
    setExpanded((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Script Reference</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {SCRIPT_SCHEMA.length} schema entries · {EXPR_SYMBOLS.length} expression
            symbols · {SUMMARY_SYMBOLS.length} summary identifiers
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Mirror of the script-editor's "Download for AI" button —
              available here so a user reading the reference page in a
              new tab can grab the markdown without bouncing back to
              the dashboard. Same builder, identical filename / content. */}
          <button
            onClick={downloadScriptReferenceMarkdown}
            className="px-3 py-1.5 rounded text-sm font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            title="Download the full reference as a Markdown file you can paste into an AI chat (Claude / ChatGPT / Gemini) so it can write custom scripts for you."
          >
            Download for AI ↓
          </button>
          <Link
            href="/"
            className="px-3 py-1.5 rounded text-sm font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            ← Back to dashboard
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-6">
        {/* ── Sidebar TOC ──────────────────────────────────────────── */}
        <aside
          className="lg:sticky lg:self-start"
          style={{ top: "1rem", maxHeight: "calc(100vh - 2rem)" }}
        >
          <nav
            className="bg-card border border-card-border rounded-md p-3 overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 2rem)" }}
          >
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
              Sections
            </div>
            <ul className="space-y-0.5">
              {allNames.map((name) => {
                const id = sectionId(name);
                const isActive = activeId === id;
                const isExpanded = expanded.has(name);
                return (
                  <li key={name}>
                    <button
                      onClick={() => scrollToSection(name)}
                      className={`w-full text-left text-xs rounded px-2 py-1.5 transition-colors flex items-center gap-1.5 ${
                        isActive
                          ? "bg-accent-green/15 text-accent-green"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                      }`}
                      aria-current={isActive ? "true" : undefined}
                    >
                      <span
                        className={`text-[9px] transition-transform inline-block ${
                          isExpanded ? "rotate-90" : ""
                        }`}
                        aria-hidden
                      >
                        ▶
                      </span>
                      <span className="truncate">{name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-card-border mt-3 pt-2 flex gap-1">
              <button
                onClick={expandAll}
                className="flex-1 px-2 py-1 rounded text-[11px] font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              >
                Expand all
              </button>
              <button
                onClick={collapseAll}
                className="flex-1 px-2 py-1 rounded text-[11px] font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              >
                Collapse all
              </button>
            </div>
          </nav>
        </aside>

        {/* ── Main content ─────────────────────────────────────────── */}
        <main className="min-w-0">
          {/* Sticky search bar — pinned to top of the right column so it's
              always reachable while scrolling through long sections. */}
          <div
            className="sticky z-10 bg-card/95 backdrop-blur border border-card-border rounded-md p-3 mb-4"
            style={{ top: "0.5rem" }}
          >
            <input
              type="text"
              placeholder="Search by path, section, description, or expression symbol…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-background border border-card-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-accent-green"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground mt-2">
              Tip: numeric fields under{" "}
              <code className="font-mono">rules.*</code> accept full expressions like{" "}
              <code className="font-mono text-sky-300">ATR / trailVol(14) * 5</code>.
              Print directives:{" "}
              <code className="font-mono text-sky-300">
                print = winRate, &quot;Win %&quot;
              </code>{" "}
              and{" "}
              <code className="font-mono text-sky-300">ontrade.print = ATR</code>.
            </p>
          </div>

          {sections.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-12 border border-card-border rounded-md">
              No entries match &ldquo;{query}&rdquo;.
            </div>
          )}

          <div className="space-y-3">
            {sections.map((sec) => {
              const id = sectionId(sec.name);
              const isExpanded = expanded.has(sec.name);
              return (
                <section key={sec.name} id={id} className="scroll-mt-24">
                  <header
                    ref={(el) => {
                      if (el) headerRefs.current.set(id, el);
                      else headerRefs.current.delete(id);
                    }}
                    className="border border-card-border rounded-md bg-card"
                  >
                    <button
                      onClick={() => toggleSection(sec.name)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-white/5 transition-colors rounded-md"
                      aria-expanded={isExpanded}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`text-xs transition-transform inline-block ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                          aria-hidden
                        >
                          ▶
                        </span>
                        <h2 className="text-sm font-semibold text-foreground truncate">
                          {sec.name}
                        </h2>
                        <span className="text-[10px] text-muted-foreground/70 ml-1">
                          {sec.cards.length} {sec.cards.length === 1 ? "entry" : "entries"}
                        </span>
                      </div>
                    </button>
                  </header>
                  {isExpanded && (
                    <div className="mt-2 space-y-2">
                      {sec.blurb && (
                        <p className="text-xs text-muted-foreground px-1">{sec.blurb}</p>
                      )}
                      {sec.cards.map((card, i) => {
                        switch (card.kind) {
                          case "schema":
                            return (
                              <SchemaCardView
                                key={card.entry.path + i}
                                entry={card.entry}
                              />
                            );
                          case "indicator":
                            return (
                              <IndicatorCardView
                                key={card.family.headline + i}
                                family={card.family}
                              />
                            );
                          case "barfield":
                            return (
                              <BarFieldCardView
                                key={card.name + i}
                                name={card.name}
                                description={card.description}
                              />
                            );
                          case "math":
                            return (
                              <MathCardView
                                key={card.signature + i}
                                signature={card.signature}
                                description={card.description}
                              />
                            );
                          case "summary":
                            return (
                              <SummaryCardView
                                key={card.group.names[0] + i}
                                group={card.group}
                              />
                            );
                          case "optimize":
                            return (
                              <OptimizeCardView
                                key={card.headline + i}
                                headline={card.headline}
                                forms={card.forms}
                                description={card.description}
                              />
                            );
                        }
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </main>
      </div>
    </div>
  );
}
