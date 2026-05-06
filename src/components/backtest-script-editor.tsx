/**
 * BacktestScriptEditor
 * ─────────────────────
 * CodeMirror 6 wrapper tuned for the backtest DSL defined in
 * `src/lib/utils/backtest-script.ts`. Replaces an earlier from-scratch
 * textarea+overlay implementation that suffered cursor-jumping and
 * stuttering under fast typing because of a React-state-mirror vs.
 * uncontrolled-DOM race.
 *
 * Why CodeMirror? CM6 owns its DOM and viewport-virtualizes the document.
 * The editor's `state.doc` is the single source of truth — there is no
 * separate React mirror to lag behind, so the race that produced the
 * "characters get replaced as I type" symptom is structurally impossible.
 * External writes flow through `view.dispatch({ changes })`, which CM6
 * sequences correctly relative to user input and which we additionally
 * gate behind a `doc.toString() === externalValue` no-op check so that
 * a debounced echo of our own emit can never disturb the caret.
 *
 * Public API is unchanged from the previous editor — props (`value`,
 * `onChange`, `errors`, `placeholder`, `minHeight`) and behavior visible
 * to the parent dashboard match exactly.
 *
 * Features:
 *   - Custom StreamLanguage covering the DSL's tokens (comments,
 *     strings, numbers, booleans, root keywords, paths, operators,
 *     punctuation). Pairs with a HighlightStyle that reuses the same
 *     Tailwind palette colors as the previous editor for visual parity.
 *   - Line numbers gutter with error/warning markers via `lintGutter`.
 *     Errors are pushed in via the `errors` prop; we map them to CM6
 *     `Diagnostic` records and dispatch via `setDiagnostics`. No built-in
 *     linting — the parent owns when to (re)parse.
 *   - Hover tooltip that resolves the line under the cursor to a
 *     `path = value` assignment and surfaces the schema description,
 *     type, default, range, and enum options. Uses CM6's default
 *     line-anchored, ~750ms-delayed tooltip behavior.
 *   - Tab inserts two spaces (parity with previous editor).
 *   - Undo/redo via CM6's `history()` extension (free upgrade — the
 *     previous editor only had browser-default textarea undo).
 *   - Debounced onChange to the parent at 150ms, wrapped in
 *     `startTransition` so the parent's resulting render is interruptible
 *     and never blocks the next keystroke from painting.
 */

"use client";

import { memo, startTransition, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  placeholder as cmPlaceholder,
  Tooltip,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  indentUnit,
  StringStream,
} from "@codemirror/language";
import {
  Diagnostic,
  lintGutter,
  lintKeymap,
  linter,
  setDiagnostics,
} from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import {
  ScriptError,
  ScriptSchemaEntry,
  getSchemaEntry,
} from "@/lib/utils/backtest-script";
import {
  EXPR_SYMBOLS,
  EXPR_OPERATORS,
  SUMMARY_SYMBOLS,
  ExprSymbol,
} from "@/lib/utils/script-expr";

// ─── DSL language definition ────────────────────────────────────────────────
//
// The DSL is line-oriented (`path.to.field = value`, `# comment`,
// `filter.if = ...`). StreamLanguage is the right CM6 abstraction here:
// per-line tokenizer, no full AST, no incremental parser machinery to
// configure. The token rules below are transcribed from the previous
// editor's hand-rolled tokenizer so users see the same colors.

/** Top-level keywords whose first appearance on a line gets a distinct
 *  color (cyan) — matches the previous editor's `rootPath` styling.
 *  Other identifiers are styled as "variableName". `var` joins this set
 *  so a `var <name> = <RHS>` line reads as a binding declaration at a
 *  glance. */
const ROOT_NAMES = new Set(["strategy", "params", "rules", "filters", "filter", "var"]);

/** Inline keywords for the if-then-else expression. These can appear
 *  anywhere on the value side of a line (`= if cond then a else b`),
 *  not just first-token, so they're checked independently of position. */
const INLINE_KEYWORDS = new Set(["if", "then", "else"]);

interface DslState {
  /** Whether we've already emitted a non-whitespace token on this line.
   *  Used to color the FIRST identifier specially when it's a root name. */
  sawNonWs: boolean;
}

/** Decide whether `-` should start a number. Mirrors the previous
 *  tokenizer's `isNumericContext`: only treat the minus as numeric when
 *  it follows `=`, `,`, `[`, or start-of-line (modulo whitespace). */
function isMinusNumeric(stream: StringStream): boolean {
  const before = stream.string.slice(0, stream.pos);
  for (let k = before.length - 1; k >= 0; k--) {
    const c = before[k];
    if (c === " " || c === "\t") continue;
    return c === "=" || c === "," || c === "[";
  }
  return true;
}

const dslLanguage = StreamLanguage.define<DslState>({
  startState: () => ({ sawNonWs: false }),
  token(stream, state) {
    // Eat whitespace runs but DON'T emit a token — CM6 stylesheet handles
    // background. Returning null tells CM6 "this region is unstyled."
    if (stream.eatSpace()) return null;

    // Comments: `//...` or `#...` to end-of-line.
    if (stream.match("//") || stream.match("#")) {
      stream.skipToEnd();
      return "lineComment";
    }

    // Strings: until matching unescaped quote, or EOL if unterminated.
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.sawNonWs = true;
      return "string";
    }

    // Numbers: optional minus (in value-position only), digits, decimal,
    // scientific. Order matters — match BEFORE identifier rule so a
    // leading minus on a value isn't swallowed by an identifier match.
    const peek = stream.peek();
    if (
      (peek && peek >= "0" && peek <= "9") ||
      (peek === "-" && isMinusNumeric(stream))
    ) {
      if (stream.match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) {
        state.sawNonWs = true;
        return "number";
      }
    }

    // Identifiers: paths and booleans. The first identifier on the line
    // gets `keyword` color when it's in ROOT_NAMES so `strategy`,
    // `params`, `rules`, `filters`, `filter`, `var` stand out. The
    // if-expression keywords (`if`, `then`, `else`) get keyword color
    // wherever they appear, including mid-line on the value side.
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      const isFirst = !state.sawNonWs;
      state.sawNonWs = true;
      if (word === "true" || word === "false") return "atom";
      if (isFirst && ROOT_NAMES.has(word)) return "keyword";
      if (INLINE_KEYWORDS.has(word)) return "keyword";
      return "variableName";
    }

    // Single-char operators / punctuation.
    if (stream.eat("=")) {
      state.sawNonWs = true;
      return "operator";
    }
    if (stream.eat(".")) {
      state.sawNonWs = true;
      return "separator";
    }
    if (stream.eat("[") || stream.eat("]") || stream.eat(",")) {
      state.sawNonWs = true;
      return "punctuation";
    }

    // Anything else: consume one char without styling so the tokenizer
    // never gets stuck.
    stream.next();
    return null;
  },
  blankLine(state) {
    // Reset per-line tracking when we enter a fresh line.
    state.sawNonWs = false;
  },
  copyState: (s) => ({ sawNonWs: s.sawNonWs }),
  // CM6 calls `indent` only when auto-indent fires. The DSL doesn't
  // benefit from auto-indent — return null to let user input pass
  // through untouched.
  indent: () => null,
});

/** Per-token colors. Same hex values the previous editor used so the
 *  visual feel is unchanged. Comments are italicized. */
const dslHighlight = HighlightStyle.define([
  { tag: t.lineComment, color: "#6b7280", fontStyle: "italic" },
  { tag: t.string, color: "#86efac" },
  { tag: t.number, color: "#fbbf24" },
  { tag: t.atom, color: "#c4b5fd" }, // booleans
  { tag: t.operator, color: "#f3f4f6" },
  { tag: t.punctuation, color: "#9ca3af" },
  { tag: t.separator, color: "#9ca3af" }, // the dot separator in paths
  { tag: t.keyword, color: "#67e8f9" }, // strategy / params / rules / filters
  { tag: t.variableName, color: "#7dd3fc" }, // sub-path segments
]);

// ─── Theme ──────────────────────────────────────────────────────────────────
//
// Targets the same dark palette and font metrics as the previous editor
// so the overall feel of the dashboard is unchanged. CM6 themes are just
// CSS — `&` selects the editor root, `.cm-foo` selects the given subpart.

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Code", "Liberation Mono", Consolas, monospace';

/** Build the CM6 theme for a given fixed editor height. Pinning the
 *  height (and giving the scroller `overflow: auto`) makes CM6 own its
 *  own internal scrolling — the same way the previous editor's textarea
 *  was `absolute inset-0` inside a 480-tall box. Without this, CM6's
 *  natural height grows with the document (e.g. 130 lines × 20px =
 *  2600px), which causes the surrounding `aside` (overflowY: auto) to
 *  scroll instead. CM6 then calls `scrollIntoView` on every keystroke
 *  to keep the cursor visible, fighting the aside's scroll position
 *  and "jumping the page to the top." Owning our own scroll fixes both
 *  problems. */
function buildTheme(heightPx: number) {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "#0b1020",
        color: "#e5e7eb",
        height: `${heightPx}px`,
      },
      ".cm-scroller": {
        overflow: "auto",
      },
      ".cm-content": {
        fontFamily: FONT_FAMILY,
        fontSize: "13px",
        padding: "12px 14px",
        caretColor: "#f1f5f9",
      },
      ".cm-line": {
        lineHeight: "20px",
        padding: "0",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#f1f5f9",
        borderLeftWidth: "2px",
      },
      "&.cm-focused": {
        outline: "none",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "rgba(125, 211, 252, 0.18)",
      },
      ".cm-gutters": {
        backgroundColor: "#0b1020",
        color: "#475569",
        border: "0",
        fontFamily: FONT_FAMILY,
        fontSize: "13px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 6px 0 8px",
        minWidth: "24px",
        textAlign: "right",
        lineHeight: "20px",
      },
      ".cm-activeLine": {
        backgroundColor: "rgba(255, 255, 255, 0.02)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgba(255, 255, 255, 0.03)",
        color: "#94a3b8",
      },
      // Lint gutter markers: error red / warning amber to match the rest
      // of the dashboard's accent palette.
      ".cm-lint-marker-error": { color: "#f87171" },
      ".cm-lint-marker-warning": { color: "#fbbf24" },
      // Diagnostic underline in the document body.
      ".cm-diagnostic-error": {
        borderLeft: "3px solid #f87171",
        paddingLeft: "6px",
      },
      ".cm-diagnostic-warning": {
        borderLeft: "3px solid #fbbf24",
        paddingLeft: "6px",
      },
      // Hover tooltip wrapper. The DOM we build inside (see
      // `buildTooltipDom`) supplies the styled body; this just gives
      // the wrapper a transparent / no-default-border treatment so the
      // inner node fully owns its appearance.
      ".cm-tooltip": {
        backgroundColor: "transparent",
        border: "0",
      },
      ".cm-tooltip.cm-tooltip-hover": {
        backgroundColor: "transparent",
      },
    },
    { dark: true }
  );
}

// ─── Hover tooltip ──────────────────────────────────────────────────────────
//
// Tooltip lookup is token-aware. The hover position decides which of
// FOUR resolvers fires:
//
//   1. SCHEMA — the token (or the whole LHS of `=`) names a path in
//      SCRIPT_SCHEMA. Used for `rules.X = ...`, `filters.Y.Z = ...`,
//      directives like `print` / `filter.if` / `OptimizeAll`, etc.
//   2. EXPR / SUMMARY SYMBOL — the token matches a name in EXPR_SYMBOLS
//      (entry-context idents, indicator calls, math passthroughs, tick
//      helpers) or SUMMARY_SYMBOLS (post-run aggregate identifiers).
//   3. OPERATOR — the chars at the hover position form one of the
//      comparison/logical operators in EXPR_OPERATORS (>=, <=, ==, !=,
//      &&, ||, plus the single-char >, <, !).
//   4. KEYWORD — soft keywords the parser treats specially: `if/then/
//      else`, `var`, `Optimize`, `default`, `sticky`, `pass`, `reject`.
//      These don't live in the symbol catalog because they're statement-
//      level forms, not values, so we maintain an in-file table here.
//
// Resolution order is keyword → schema (LHS-biased) → symbol → operator,
// because keywords like `if` could otherwise be misread as identifiers
// by the symbol pass.

/** Strip `//` and `#` comments from a line, respecting strings — same
 *  rules the parser uses. Mirrors the parser's stripping logic so the
 *  path before `=` is interpreted the same way. */
function stripInlineComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (c === "#") return line.slice(0, i);
      if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
    }
  }
  return line;
}

/** Soft-keyword documentation. These tokens are syntactic (statement /
 *  prefix-position) and don't fit the value-shaped ExprSymbol catalog.
 *  Adding a new soft keyword: extend this map and the language-level
 *  highlighter's INLINE_KEYWORDS / ROOT_NAMES if you also want a color. */
const KEYWORD_DOCS: Record<string, { kind: string; signature?: string; description: string }> = {
  if: {
    kind: "keyword",
    signature: "if cond then a else b",
    description:
      "Conditional expression. Evaluates `cond`; finite-non-zero takes the `then` branch, finite-zero takes the `else` branch, NaN propagates as NaN. Lowest precedence — only legal in prefix position (start of an expression, inside parens, in an arg list, or on the RHS of a `var` declaration).",
  },
  then: {
    kind: "keyword",
    description:
      "Marks the true branch of an `if cond then a else b` expression. See `if` for evaluation rules.",
  },
  else: {
    kind: "keyword",
    description:
      "Marks the false branch of an `if cond then a else b` expression. See `if` for evaluation rules.",
  },
  var: {
    kind: "keyword",
    signature: "var <name> = <expr>",
    description:
      "Declare a positional binding. After this line, any `<name>` reference in subsequent expressions is replaced by the bound expression. Bindings shadow each other in declaration order; declaring twice rebinds. Common idiom: `var risk = ATR * 1.5` then reuse `risk` in stop / TP rules.",
  },
  Optimize: {
    kind: "keyword",
    signature: "Optimize.<Objective>.<LookbackUnit>(lookback, min, max[, step]) [default <num>]",
    description:
      "Online optimization directive. Drives a TPE search at each new signal over the trailing `lookback` window of trades/bars/minutes/etc. Objectives: DailyEV, EV, Sharpe, MinDrawdown, WinRate, ProfitFactor. Categorical form: `Optimize.X.Y(lookback, (option1, option2, ...))`. Optional `default <num>` provides a pre-warmup fallback so filter.if conditions and rules.* RHS expressions keep producing useful values before the lookback fills.",
  },
  default: {
    kind: "keyword",
    signature: "Optimize.X.Y(...) default <num>",
    description:
      "Pre-warmup fallback for a numeric Optimize directive. Until the optimizer's lookback fills, var/rule lookups referencing this directive resolve to this literal instead of NaN. Numeric literal only — must be unambiguous without an entry-context to evaluate. Not meaningful for categorical Optimize (those already enumerate every possible value).",
  },
  sticky: {
    kind: "keyword",
    signature: "sticky(N) <action>",
    description:
      "Modifier on a `filter.if` action statement (verdict / print / rule override). v1 honors `sticky(0)` (this trade only — the default) and parses `sticky(N>0)` with a warning. Reserved for a future feature where the action persists across the next N trades.",
  },
  pass: {
    kind: "keyword",
    description:
      "Verdict statement inside a `filter.if = (cond, if_true, if_false)` slot — explicitly let the trade through. Use it to override the default-false reject in the false slot when you also want to print or set rules first.",
  },
  reject: {
    kind: "keyword",
    description:
      "Verdict statement inside a `filter.if = (cond, if_true, if_false)` slot — explicitly drop the trade. Use it to override the default-true pass in the true slot when you decide a sub-condition disqualifies the trade.",
  },
};

/** Bare-name shortcut indicators, e.g. `WMA20` / `RSI14` — the same regex
 *  the expression engine uses to resolve indicator-with-period suffixes
 *  to a precomputed series. We re-declare it here (rather than importing)
 *  so the editor doesn't pull in the evaluator. Keep in sync with the
 *  expression engine's BARE_INDICATOR_REGEX. */
const BARE_INDICATOR_REGEX =
  /^(ATR|EMA|SMA|ADX|VOL|RSI|WMA|HMA|DEMA|TEMA|VWMA|ROC|MOM|CCI|TRIX|MFI|NATR|HV|CMF|HHV|LLV)(\d+)$/;

/** Word at `offset` in `text`, where word chars are [A-Za-z0-9_]. Returns
 *  null when the cursor is on whitespace / punctuation with no adjacent
 *  word char. Cursor positioned exactly at the right edge of a word
 *  (offset === word-end) still resolves to that word, because that's the
 *  natural CM6 hover landing spot and we don't want a one-pixel dead zone. */
function wordAt(text: string, offset: number): { word: string; from: number; to: number } | null {
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
  const here = text[offset];
  const prev = offset > 0 ? text[offset - 1] : undefined;
  if (!isWord(here) && !isWord(prev)) return null;
  let start = offset;
  while (start > 0 && isWord(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && isWord(text[end])) end++;
  if (start === end) return null;
  return { word: text.slice(start, end), from: start, to: end };
}

/** Operator at `offset`. Returns the longest match (so `>=` wins over
 *  `>`). Returns null if `offset` doesn't sit on / next to an operator
 *  character. */
function operatorAt(text: string, offset: number): { op: string; from: number; to: number } | null {
  // Two-char operators take priority. Try every starting offset that
  // could overlap `offset` (offset-1 and offset).
  const TWO = ["==", "!=", ">=", "<=", "&&", "||"] as const;
  for (const start of [offset - 1, offset]) {
    if (start < 0 || start + 2 > text.length) continue;
    const slice = text.slice(start, start + 2);
    if ((TWO as readonly string[]).includes(slice)) {
      return { op: slice, from: start, to: start + 2 };
    }
  }
  // Single-char operators we document.
  const ONE = new Set([">", "<", "!"]);
  if (ONE.has(text[offset])) return { op: text[offset], from: offset, to: offset + 1 };
  if (offset > 0 && ONE.has(text[offset - 1])) {
    return { op: text[offset - 1], from: offset - 1, to: offset };
  }
  return null;
}

/** Try to extract a dotted path containing `offset`. Path chars are
 *  word chars plus `.`. Used when the user hovers somewhere inside a
 *  multi-segment LHS like `filters.adxTrend.flatThreshold` — we want
 *  the whole path, not just the segment under the cursor, because
 *  schema entries are keyed by the full path. */
function dottedPathAt(text: string, offset: number): string | null {
  const isPath = (c: string | undefined) => !!c && /[A-Za-z0-9_.]/.test(c);
  if (!isPath(text[offset]) && !isPath(text[offset - 1])) return null;
  let start = offset;
  while (start > 0 && isPath(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && isPath(text[end])) end++;
  const path = text.slice(start, end).replace(/^\.+|\.+$/g, "");
  return path.length > 0 ? path : null;
}

/** Resolve a hover position to a documented entity. Returns null when
 *  nothing under the cursor maps to anything we know how to describe. */
type HoverInfo =
  | { kind: "schema"; entry: ScriptSchemaEntry; from: number; to: number }
  | { kind: "symbol"; symbol: ExprSymbol; from: number; to: number }
  | { kind: "operator"; symbol: ExprSymbol; from: number; to: number }
  | {
      kind: "keyword";
      name: string;
      doc: { kind: string; signature?: string; description: string };
      from: number;
      to: number;
    }
  | {
      kind: "bare-indicator";
      name: string;
      family: string;
      period: string;
      from: number;
      to: number;
    };

function resolveHover(text: string, offset: number, lineFrom: number): HoverInfo | null {
  const code = stripInlineComment(text);
  // Don't fire tooltips on chars that fall inside a stripped comment —
  // the offset is into the original line, and once we're past `code.length`
  // we know we're hovering on the comment itself.
  if (offset > code.length) return null;
  const eqIdx = code.indexOf("=");

  const w = wordAt(code, offset);

  // 1. Soft keywords win first — they'd otherwise be misread by the
  //    symbol pass (e.g. `if` is also tokenized as an identifier).
  if (w && KEYWORD_DOCS[w.word]) {
    return {
      kind: "keyword",
      name: w.word,
      doc: KEYWORD_DOCS[w.word],
      from: lineFrom + w.from,
      to: lineFrom + w.to,
    };
  }

  // 2. Schema-entry lookup. Try the dotted path under the cursor first
  //    (so `filters.atr.min` resolves even when the user hovers on the
  //    `atr` segment), then fall back to the whole LHS of `=` for
  //    cursor-anywhere-on-line behavior the previous editor had.
  const dotted = dottedPathAt(code, offset);
  if (dotted) {
    const entry = getSchemaEntry(dotted);
    if (entry) {
      // Find the bounds of the dotted path for the highlight range.
      let s = offset;
      while (s > 0 && /[A-Za-z0-9_.]/.test(code[s - 1])) s--;
      let e = offset;
      while (e < code.length && /[A-Za-z0-9_.]/.test(code[e])) e++;
      return {
        kind: "schema",
        entry,
        from: lineFrom + s,
        to: lineFrom + e,
      };
    }
  }
  if (eqIdx >= 0 && offset <= eqIdx) {
    const lhs = code.slice(0, eqIdx).trim();
    const entry = getSchemaEntry(lhs);
    if (entry) {
      return {
        kind: "schema",
        entry,
        from: lineFrom,
        to: lineFrom + eqIdx,
      };
    }
  }

  // 3. Symbol catalog — entry-context first (the common case; RHS of
  //    rules.* / filter.if / ontrade.print), then summary context for
  //    `print = ...` lines.
  if (w) {
    // Prefer the call-form entry over the bare-ident entry when both
    // exist (e.g. ATR has both kinds). Calls have a signature line that
    // documents the args, which is more useful when the user is about
    // to type one. `Array#findLast` would express this directly but we
    // keep widely-compatible iteration.
    let sym: ExprSymbol | undefined;
    for (const s of EXPR_SYMBOLS) {
      if (s.name === w.word) {
        sym = s;
        if (s.kind === "call") break;
      }
    }
    if (!sym) {
      for (const s of SUMMARY_SYMBOLS) {
        if (s.name === w.word) {
          sym = s;
          break;
        }
      }
    }
    if (sym) {
      return {
        kind: "symbol",
        symbol: sym,
        from: lineFrom + w.from,
        to: lineFrom + w.to,
      };
    }

    // Bare-name shortcut indicator (e.g. `WMA20`, `RSI14`). Synthesize
    // a tooltip from the regex match — these aren't enumerated in
    // EXPR_SYMBOLS for every possible period because the period space
    // is open-ended.
    const m = w.word.match(BARE_INDICATOR_REGEX);
    if (m) {
      return {
        kind: "bare-indicator",
        name: w.word,
        family: m[1],
        period: m[2],
        from: lineFrom + w.from,
        to: lineFrom + w.to,
      };
    }
  }

  // 4. Operators. Checked AFTER words so `!a` (where the cursor is on
  //    `a`) still resolves to the identifier rather than the leading `!`.
  const op = operatorAt(code, offset);
  if (op) {
    const sym = EXPR_OPERATORS.find((s) => s.name === op.op);
    if (sym) {
      return {
        kind: "operator",
        symbol: sym,
        from: lineFrom + op.from,
        to: lineFrom + op.to,
      };
    }
  }

  return null;
}

/** Shared tooltip card shell. Same border / background / spacing rules
 *  as the schema tooltip so all hover surfaces feel uniform. */
function buildCard(): HTMLElement {
  const root = document.createElement("div");
  root.className =
    "max-w-sm bg-[#0f172a] border border-card-border rounded-md shadow-xl px-3 py-2 text-xs pointer-events-none";
  root.setAttribute("role", "tooltip");
  return root;
}

/** Build a tooltip for an EXPR_SYMBOLS / SUMMARY_SYMBOLS / EXPR_OPERATORS
 *  entry. Layout mirrors the schema tooltip's header strip so users see
 *  the same shape everywhere — name (mono cyan), kind tag, context tag,
 *  optional signature line, then the description body. */
function buildSymbolDom(symbol: ExprSymbol): HTMLElement {
  const root = buildCard();

  const header = document.createElement("div");
  header.className = "flex items-baseline gap-2 flex-wrap mb-1";
  const nameEl = document.createElement("code");
  nameEl.className = "text-sky-300 font-mono text-[12px]";
  nameEl.textContent = symbol.name;
  header.appendChild(nameEl);
  const kindEl = document.createElement("span");
  kindEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/80";
  kindEl.textContent = symbol.kind;
  header.appendChild(kindEl);
  const ctxEl = document.createElement("span");
  ctxEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/60";
  ctxEl.textContent = symbol.context;
  header.appendChild(ctxEl);
  root.appendChild(header);

  if (symbol.signature) {
    const sig = document.createElement("code");
    sig.className =
      "block font-mono text-[11px] text-amber-300/90 mb-1 break-all";
    sig.textContent = symbol.signature;
    root.appendChild(sig);
  }

  const desc = document.createElement("p");
  desc.className = "text-[11px] text-foreground/90 leading-relaxed";
  desc.textContent = symbol.description;
  root.appendChild(desc);

  return root;
}

/** Build a tooltip for a soft keyword from KEYWORD_DOCS. */
function buildKeywordDom(
  name: string,
  doc: { kind: string; signature?: string; description: string }
): HTMLElement {
  const root = buildCard();

  const header = document.createElement("div");
  header.className = "flex items-baseline gap-2 flex-wrap mb-1";
  const nameEl = document.createElement("code");
  nameEl.className = "text-cyan-300 font-mono text-[12px]";
  nameEl.textContent = name;
  header.appendChild(nameEl);
  const kindEl = document.createElement("span");
  kindEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/80";
  kindEl.textContent = doc.kind;
  header.appendChild(kindEl);
  root.appendChild(header);

  if (doc.signature) {
    const sig = document.createElement("code");
    sig.className =
      "block font-mono text-[11px] text-amber-300/90 mb-1 break-all";
    sig.textContent = doc.signature;
    root.appendChild(sig);
  }

  const desc = document.createElement("p");
  desc.className = "text-[11px] text-foreground/90 leading-relaxed";
  desc.textContent = doc.description;
  root.appendChild(desc);

  return root;
}

/** Build a tooltip for a bare-name shortcut indicator (e.g. `WMA20`).
 *  We don't enumerate every period in EXPR_SYMBOLS, so this card is
 *  synthesized from the regex match — explains the equivalent
 *  function-call form so the user can mentally expand the shortcut. */
function buildBareIndicatorDom(name: string, family: string, period: string): HTMLElement {
  const root = buildCard();

  const header = document.createElement("div");
  header.className = "flex items-baseline gap-2 flex-wrap mb-1";
  const nameEl = document.createElement("code");
  nameEl.className = "text-sky-300 font-mono text-[12px]";
  nameEl.textContent = name;
  header.appendChild(nameEl);
  const kindEl = document.createElement("span");
  kindEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/80";
  kindEl.textContent = "indicator alias";
  header.appendChild(kindEl);
  const ctxEl = document.createElement("span");
  ctxEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/60";
  ctxEl.textContent = "entry";
  header.appendChild(ctxEl);
  root.appendChild(header);

  const sig = document.createElement("code");
  sig.className = "block font-mono text-[11px] text-amber-300/90 mb-1 break-all";
  sig.textContent = `${family}(${period})`;
  root.appendChild(sig);

  const desc = document.createElement("p");
  desc.className = "text-[11px] text-foreground/90 leading-relaxed";
  desc.textContent = `Bare-name shortcut for ${family}(${period}) at the trade's entry bar. Equivalent to writing the function-call form. See ${family}(period) for the full description.`;
  root.appendChild(desc);

  return root;
}

/** Build the tooltip DOM from a schema entry. Mirrors the JSX layout
 *  of the previous editor's hover tooltip — same Tailwind classes so
 *  the tooltip looks identical to what users had before. */
function buildTooltipDom(entry: ScriptSchemaEntry): HTMLElement {
  const root = document.createElement("div");
  root.className =
    "max-w-sm bg-[#0f172a] border border-card-border rounded-md shadow-xl px-3 py-2 text-xs pointer-events-none";
  root.setAttribute("role", "tooltip");

  const header = document.createElement("div");
  header.className = "flex items-baseline gap-2 flex-wrap mb-1";
  const pathEl = document.createElement("code");
  pathEl.className = "text-sky-300 font-mono text-[12px]";
  pathEl.textContent = entry.path;
  header.appendChild(pathEl);
  const typeEl = document.createElement("span");
  typeEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/80";
  typeEl.textContent = entry.type;
  header.appendChild(typeEl);
  const sectionEl = document.createElement("span");
  sectionEl.className =
    "text-[10px] uppercase tracking-wider text-muted-foreground/60";
  sectionEl.textContent = entry.section;
  header.appendChild(sectionEl);
  root.appendChild(header);

  const desc = document.createElement("p");
  desc.className = "text-[11px] text-foreground/90 leading-relaxed";
  desc.textContent = entry.description;
  root.appendChild(desc);

  // Default / range / options strip — matches the previous editor's
  // bottom row of mono-font metadata. Hidden when nothing meaningful
  // would be shown.
  const meta = document.createElement("div");
  meta.className =
    "flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] font-mono text-muted-foreground/80";

  const defaultSpan = document.createElement("span");
  defaultSpan.appendChild(document.createTextNode("default "));
  const defaultVal = document.createElement("span");
  defaultVal.className = "text-foreground/80";
  defaultVal.textContent = Array.isArray(entry.default)
    ? `[${entry.default.map((x) => `"${x}"`).join(", ")}]`
    : typeof entry.default === "string"
      ? `"${entry.default}"`
      : String(entry.default);
  defaultSpan.appendChild(defaultVal);
  meta.appendChild(defaultSpan);

  if (
    (entry.type === "int" || entry.type === "float") &&
    (entry.min !== undefined ||
      entry.max !== undefined ||
      entry.step !== undefined)
  ) {
    const range = document.createElement("span");
    const parts: string[] = [];
    if (entry.min !== undefined) parts.push(`min ${entry.min}`);
    if (entry.max !== undefined) parts.push(`max ${entry.max}`);
    if (entry.step !== undefined) parts.push(`step ${entry.step}`);
    range.textContent = parts.join(" · ");
    meta.appendChild(range);
  }

  if (entry.options) {
    const opts = document.createElement("span");
    opts.appendChild(document.createTextNode("options "));
    const optsVal = document.createElement("span");
    optsVal.className = "text-foreground/80";
    optsVal.textContent = entry.options.map((o) => `"${o}"`).join(" | ");
    opts.appendChild(optsVal);
    meta.appendChild(opts);
  }

  root.appendChild(meta);
  return root;
}

const dslHover = hoverTooltip((view, pos): Tooltip | null => {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  const info = resolveHover(line.text, offset, line.from);
  if (!info) return null;
  return {
    pos: info.from,
    end: info.to,
    above: false,
    create() {
      switch (info.kind) {
        case "schema":
          return { dom: buildTooltipDom(info.entry) };
        case "symbol":
        case "operator":
          return { dom: buildSymbolDom(info.symbol) };
        case "keyword":
          return { dom: buildKeywordDom(info.name, info.doc) };
        case "bare-indicator":
          return {
            dom: buildBareIndicatorDom(info.name, info.family, info.period),
          };
      }
    },
  };
});

// ─── Editor component ───────────────────────────────────────────────────────

interface BacktestScriptEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Pre-parsed errors to underline / list under the editor. The parent
   *  controls when to re-parse (typically on Apply / Run). */
  errors: ScriptError[];
  /** Optional placeholder shown when the editor is empty. */
  placeholder?: string;
  /** Render-stable height. Defaults to a tall fixed value so the editor
   *  doesn't jump around as the script grows. */
  minHeight?: number;
}

/** Map our `ScriptError` shape onto CM6 `Diagnostic`s. Each diagnostic
 *  spans the entire line so the gutter marker and the body underline
 *  both line up with the offending source. Out-of-range line numbers
 *  (defensive — shouldn't happen with our parser) are clamped. */
function errorsToDiagnostics(
  state: EditorState,
  errors: ScriptError[]
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const totalLines = state.doc.lines;
  for (const err of errors) {
    const ln = Math.max(1, Math.min(totalLines, err.line));
    const lineInfo = state.doc.line(ln);
    out.push({
      from: lineInfo.from,
      to: lineInfo.to,
      severity: err.severity,
      message: err.message,
    });
  }
  return out;
}

function BacktestScriptEditorImpl({
  value: externalValue,
  onChange,
  errors,
  placeholder,
  minHeight = 480,
}: BacktestScriptEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Stable refs that the CM6 update listener captures. We deliberately
  // avoid putting `onChange` directly into the listener closure — that
  // would force us to rebuild the EditorView (and lose user state)
  // whenever the parent's onChange identity changed. Instead the
  // listener reads through the ref, and a small useEffect keeps the
  // ref pointed at the latest callback.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Debounce timer for emits to the parent. Mirrors the previous editor's
  // 150ms cadence so the parent dashboard's render frequency during
  // sustained typing is unchanged.
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // History of EVERY value we've emitted to the parent. The prop-sync
  // effect uses this to distinguish "stale echo of our own onChange"
  // from "genuine external change."
  //
  // Why a SET, not just `lastEmitted`? React 19's concurrent transitions
  // can deliver our emits to the parent out of order:
  //
  //   1. User types fast. CM6 doc = "abc12".
  //   2. Debounce fires at t=150 with text "abc1" (one keystroke older
  //      than the live doc). lastEmitted = "abc1". startTransition
  //      queues setScriptText("abc1").
  //   3. Before that transition commits, the user types one more char,
  //      doc = "abc12". Another emit fires, lastEmitted = "abc12".
  //   4. The FIRST transition commits. parent.scriptText = "abc1".
  //      Editor receives externalValue = "abc1".
  //   5. With only `lastEmitted`, our bail logic would conclude
  //      "abc1" !== docText("abc12") AND "abc1" !== lastEmitted("abc12"),
  //      treat it as a genuine external change, and dispatch — replacing
  //      the user's "abc12" with the stale "abc1". CM6 then clamps the
  //      caret and (because the contentEditable scrolls to keep its
  //      selection in view) fires a browser scroll that pulls the page
  //      to the top. THIS is the "page jumps to top" symptom.
  //
  // Tracking every past emit closes the race: ANY value we've ever sent
  // upstream, no matter how stale, gets recognized as an echo and
  // ignored. Capped at HISTORY_MAX entries to bound memory; values
  // older than ~1s have no chance of still being in flight, so trimming
  // is safe.
  const lastEmittedRef = useRef<string>(externalValue);
  const emittedHistoryRef = useRef<Set<string>>(new Set([externalValue]));

  // Total line count, surfaced to the hint footer below the editor. We
  // update it from the CM6 update listener whenever the doc changes,
  // and from the mount effect once the view exists. Initialized to 0
  // (deliberately NOT from `externalValue`) so the SSR render and the
  // first client render always agree — the parent's `scriptText` is
  // hydrated from localStorage on the client only, so deriving line
  // count from it during render would cause a hydration mismatch and
  // tear down the just-mounted editor.
  const [totalLines, setTotalLines] = useState<number>(0);

  // ─── Mount: build the EditorState + EditorView ──────────────────────
  useEffect(() => {
    if (!hostRef.current) return;

    /** Tab inserts two literal spaces (parity with previous editor).
     *  Returning `true` from `run` swallows the keypress so the browser
     *  doesn't move focus to the next tab stop. Bound BEFORE the default
     *  keymap so it wins over any default Tab binding. */
    const tabKeymap = keymap.of([
      {
        key: "Tab",
        run: (view) => {
          view.dispatch(view.state.replaceSelection("  "));
          return true;
        },
      },
    ]);

    /** Update listener: fires synchronously on every transaction. We
     *  use it for two things: track total line count for the footer,
     *  and debounce-emit doc changes upstream. The actual onChange
     *  call is wrapped in `startTransition` so the parent dashboard's
     *  resulting render is interruptible by the next keystroke. */
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const view = viewRef.current;
        if (!view) return;
        // Update the line counter for the footer. This is a cheap
        // setState that React batches with subsequent updates.
        setTotalLines(view.state.doc.lines);
        // Debounced emit upstream. We read from the live view ref
        // inside the timer callback so the emitted value is whatever
        // the user had typed by the time the debounce expires — even
        // if more keystrokes arrived after this listener fired.
        if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
        emitTimerRef.current = setTimeout(() => {
          emitTimerRef.current = null;
          const v = viewRef.current;
          if (!v) return;
          const text = v.state.doc.toString();
          if (lastEmittedRef.current === text) return;
          lastEmittedRef.current = text;
          // Record this emit so a late echo of an OLDER emit is still
          // recognized when it arrives. See `emittedHistoryRef`'s
          // declaration for the race scenario this guards against.
          emittedHistoryRef.current.add(text);
          if (emittedHistoryRef.current.size > 64) {
            const arr = Array.from(emittedHistoryRef.current);
            emittedHistoryRef.current = new Set(arr.slice(-32));
          }
          startTransition(() => onChangeRef.current(text));
        }, 150);
      }
    });

    /** Linter extension. We don't actually use the linter callback —
     *  parsing happens upstream in the dashboard on Apply. The linter
     *  call is only here to register the lint state field so we can
     *  push diagnostics in via `setDiagnostics` from the errors-prop
     *  effect below. delay: 0 means CM6 won't run our (no-op) callback
     *  on a debounce. */
    const noopLinter = linter(() => [], { delay: 0 });

    const state = EditorState.create({
      doc: externalValue,
      extensions: [
        lineNumbers(),
        lintGutter(),
        noopLinter,
        history(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        indentUnit.of("  "),
        EditorState.tabSize.of(2),
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        dslLanguage,
        syntaxHighlighting(dslHighlight),
        dslHover,
        buildTheme(minHeight),
        cmPlaceholder(placeholder ?? ""),
        // tabKeymap MUST come before defaultKeymap so our Tab binding
        // wins over the default (which would indent / trigger
        // autocomplete).
        tabKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap, ...lintKeymap]),
        updateListener,
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;
    lastEmittedRef.current = externalValue;
    // Seed the footer's line count now that we have a real view. Doing
    // this AFTER mount (not via the useState initializer) keeps SSR and
    // CSR initial renders in agreement, avoiding the hydration mismatch
    // that would otherwise tear down the just-mounted CM6 view.
    setTotalLines(view.state.doc.lines);

    return () => {
      if (emitTimerRef.current) {
        clearTimeout(emitTimerRef.current);
        emitTimerRef.current = null;
      }
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only effect — we deliberately don't depend on `placeholder`
    // / `externalValue` here. The placeholder is captured at mount; if
    // the parent ever changes it (currently it doesn't), users would
    // see the old placeholder until remount, which is fine. The
    // external value is synced through the dedicated prop-sync effect
    // below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── External value sync ────────────────────────────────────────────
  //
  // Decides whether the incoming `value` prop should be written back
  // into the editor. Three classes of incoming prop:
  //
  //   (A) Identical to current doc — parent caught up to us. Bail.
  //   (B) Echo of an emit we previously sent — possibly stale because
  //       startTransition'd commits can land out of order during fast
  //       typing. Bail. The emit-history Set covers ALL past emits, not
  //       just the latest, which is what closes the race the previous
  //       implementation had.
  //   (C) Anything else — a genuine external change (Sync from UI,
  //       Load Default, preset load, applyLoadStrategyRewrite). Replace
  //       the doc.
  //
  // A misclassification of (B) as (C) was the cause of the "page jumps
  // to top" symptom: the dispatch replaced the user's freshest typing
  // with a stale value, CM6 clamped the caret onto the shorter doc, and
  // the browser scrolled the contentEditable's new selection into view
  // — pulling the page along with it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const docText = view.state.doc.toString();
    // (A) Already in sync. Trim history to the current value so it
    // doesn't grow unbounded across long sessions.
    if (docText === externalValue) {
      emittedHistoryRef.current = new Set([externalValue]);
      lastEmittedRef.current = externalValue;
      return;
    }
    // (B) Echo of a value we previously emitted. The doc has fresher
    // content; do nothing.
    if (emittedHistoryRef.current.has(externalValue)) return;
    // (C) Genuine external change. Cancel any pending debounced emit so
    // a stale buffer can't immediately overwrite the new content when
    // the timer fires next.
    if (emitTimerRef.current) {
      clearTimeout(emitTimerRef.current);
      emitTimerRef.current = null;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: externalValue },
    });
    emittedHistoryRef.current = new Set([externalValue]);
    lastEmittedRef.current = externalValue;
  }, [externalValue]);

  // ─── Errors → diagnostics sync ─────────────────────────────────────
  //
  // Re-dispatched whenever the `errors` prop changes (typically after
  // Apply). Diagnostic state is independent of doc state, so this never
  // triggers re-tokenization or otherwise interferes with typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const diagnostics = errorsToDiagnostics(view.state, errors);
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [errors]);

  return (
    <div
      className="relative bg-[#0b1020] border border-card-border rounded-lg overflow-hidden"
      style={{ minHeight }}
    >
      {/* CM6 host. The view is mounted into this div in the mount
          effect above. minHeight keeps the editor from collapsing
          before CM6 has rendered its first viewport on mount. */}
      <div
        ref={hostRef}
        className="relative"
        style={{ minHeight, fontFamily: FONT_FAMILY }}
      />

      {/* Errors strip — collapsed when clean. Renders BOTH errors and
          warnings; warnings are amber, errors red, so users can ignore
          warnings without losing their place. Same JSX as the previous
          editor — preserved verbatim. */}
      {errors.length > 0 && (
        <div
          className="border-t border-card-border bg-[#0b1020] px-3 py-2 text-xs space-y-1 max-h-32 overflow-y-auto"
          aria-live="polite"
        >
          {errors.map((e, i) => (
            <div
              key={i}
              className={
                e.severity === "error" ? "text-accent-red" : "text-amber-400"
              }
            >
              <span className="font-mono opacity-60">L{e.line}</span>{" "}
              <span className="font-mono opacity-60 mr-2">
                {e.severity === "error" ? "error" : "warn"}
              </span>
              {e.message}
            </div>
          ))}
        </div>
      )}

      {/* Hint footer — always visible, low contrast. The line count
          is omitted until the CM6 view has mounted so the SSR render
          (where `totalLines` is 0) doesn't disagree with the first
          post-mount render. */}
      <div className="border-t border-card-border bg-[#0a0f1c] px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 flex items-center justify-between">
        <span>↹ tab inserts 2 spaces · hover a path, function, operator, or keyword for docs</span>
        <span>{totalLines > 0 ? `${totalLines} lines` : ""}</span>
      </div>
    </div>
  );
}

/**
 * `React.memo` wrapper. CM6 owns its DOM and is independent of React's
 * render cycle, so a parent re-render with the same props is a true
 * no-op for the editor. Default shallow-prop comparison catches all
 * three meaningful props (`value`, `onChange`, `errors`).
 *
 * `placeholder` and `minHeight` are mount-only — changing them requires
 * a remount, which the parent dashboard never does in practice.
 */
export const BacktestScriptEditor = memo(BacktestScriptEditorImpl);
