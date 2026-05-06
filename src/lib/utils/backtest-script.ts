/**
 * Backtest Script DSL
 * ────────────────────
 * Defines the script language used by the "Script" mode of the backtest
 * dashboard. The DSL is a deliberately tiny line-based config format so the
 * editor and parser are simple and dependency-free, while still feeling
 * "scripty" enough that users can edit strategy + rules + filters as plain
 * text without clicking through dozens of inputs.
 *
 * Surface area:
 *   - SCRIPT_SCHEMA           — the single source of truth for every editable
 *                               variable: path, value type, range/options,
 *                               default, human description, section. Drives
 *                               BOTH parser validation AND editor
 *                               autocomplete AND the docs panel — keep them in
 *                               sync by editing one place.
 *   - parseBacktestScript()   — line-by-line parser. Emits a partial config
 *                               object (only the keys the user actually wrote)
 *                               plus per-line errors. Tolerant: bad lines are
 *                               reported but don't abort the whole parse.
 *   - serializeBacktestScript()
 *                            — turns a full BacktestConfig into a canonical,
 *                              section-grouped script — used to populate the
 *                              editor with the dashboard's CURRENT state when
 *                              the user toggles into Script mode for the first
 *                              time.
 *   - DSL grammar:
 *       <line>     ::= <comment> | <blank> | <assignment>
 *       <comment>  ::= ('#' | '//') <any>
 *       <assignment> ::= <path> '=' <value> [<comment>]
 *       <path>     ::= identifier ('.' identifier)*
 *       <value>    ::= number | "string" | true | false | [array]
 *
 * Why a custom DSL instead of JSON?
 *   - One assignment per line plays nicely with line-by-line error reporting
 *     and lets the editor tokenize and autocomplete trivially.
 *   - Partial scripts work — the user can write only the rules they care
 *     about and everything else stays at the dashboard's current value.
 *   - It feels like a script, not a config blob, which is what the user
 *     actually asked for.
 */

import { SimRules, PositionMode } from "./zone-simulator";
import { STRATEGIES, defaultParamsFor } from "./backtest-engine";
import { BollingerPos, MaType, MaDistanceMode, AdxTrendMode } from "./backtest-presets";
import {
  compile as compileExpr,
  parseNumericValue,
  parseEnumValue,
  parseOptimizeSpec,
  evaluate as evaluateExpr,
  applyBindings,
  referencedSymbols,
  NUMERIC_RULE_KEYS,
  type NumericValue,
  type EnumValue,
  type Expr,
  type OptimizeSpec,
} from "./script-expr";

// ─── Public types ───────────────────────────────────────────────────────────

/** All trend-mode values accepted in `filters.trend.ema20` / `ema200`. */
export type TrendMode = "any" | "with" | "against";

/** The full configuration the dashboard exposes as scriptable. Mirrors the
 *  pieces of dashboard state that already form a "preset" (strategy + params
 *  + rules + filters), but flattened for script-friendly assignment. Day
 *  selection is intentionally NOT part of this — same reasoning as presets:
 *  a script describes a CONFIGURATION, not a data window.
 *
 *  Filter sub-objects extend the legacy shape with configurable indicator
 *  periods + new filter types (BB width, MA distance, volume) — see
 *  PresetFilters in backtest-presets.ts for the field documentation. The
 *  shape mirrors PresetFilters exactly so a script-mode edit round-trips
 *  through preset save/load with no translation. */
export interface BacktestConfig {
  strategy: string;
  params: Record<string, number>;
  rules: SimRules;
  filters: {
    time: { enabled: boolean; from: string; to: string; windows: string[] };
    adx: { enabled: boolean; min: number; max: number; period: number };
    atr: { enabled: boolean; min: number; max: number; period: number };
    trend: {
      enabled: boolean;
      ema20: TrendMode;
      ema200: TrendMode;
      fastPeriod: number;
      fastType: MaType;
      slowPeriod: number;
      slowType: MaType;
    };
    bollinger: {
      enabled: boolean;
      allowed: BollingerPos[];
      period: number;
      stdDev: number;
    };
    bbWidth: { enabled: boolean; min: number; max: number };
    maDistance: {
      enabled: boolean;
      period: number;
      type: MaType;
      mode: MaDistanceMode;
      min: number;
      max: number;
    };
    volume: {
      enabled: boolean;
      period: number;
      minRatio: number;
      maxRatio: number;
    };
    rsi: {
      enabled: boolean;
      period: number;
      min: number;
      max: number;
    };
    adxTrend: {
      enabled: boolean;
      mode: AdxTrendMode;
      lookback: number;
      flatThreshold: number;
    };
  };
}

/** A schema entry describes ONE assignable path. The editor's autocomplete
 *  consumes these directly; the parser uses them to validate types/ranges;
 *  the docs panel renders them grouped by `section`. Adding a new editable
 *  variable means adding a row to SCRIPT_SCHEMA and wiring its setter in
 *  backtest-dashboard.tsx — nothing else. */
export interface ScriptSchemaEntry {
  /** Full dotted path, e.g. "rules.stopLossEnabled" — what users type. */
  path: string;
  /** Where the value comes to live in the parsed BacktestConfig. */
  type: "int" | "float" | "boolean" | "string" | "enum" | "stringArray" | "directive";
  /** Human-readable section label for grouping in the docs panel. */
  section: string;
  /** What the value means / when to use it. Shown in autocomplete tooltips
   *  and in the docs panel. */
  description: string;
  /** Default value the dashboard would have if untouched. Used by
   *  serializeBacktestScript() when emitting a canonical script for a
   *  fresh config and shown in the docs panel. */
  default: number | string | boolean | string[];
  /** For numeric types: clamp / suggestion bounds. */
  min?: number;
  max?: number;
  step?: number;
  /** For "enum" / "stringArray" values: the allowed string options. The
   *  autocomplete inserts these wholesale when the user is editing the
   *  right-hand side of one of these. */
  options?: string[];
  /** True when this path's full value type is fixed-cardinality and the
   *  editor should also offer value autocomplete (booleans, enums,
   *  stringArray of an enum). */
  enumerable?: boolean;
  /** For strategy-scoped params: which strategies use this param. Lets the
   *  docs panel and validator note when a param applies only to one
   *  strategy. */
  strategies?: string[];
  /** When true AND the field's current value equals `default`, the
   *  serializer omits this entry from the emitted script. Used to hide
   *  legacy `filters.X.*` scaffolding that has a cleaner `filter.if`
   *  equivalent — when the legacy filter is OFF (its default state),
   *  there's no point emitting `filters.adx.enabled = false` plus
   *  `filters.adx.min = 0` etc. just to show that nothing is gating.
   *  When the user enables the legacy filter through the UI, the value
   *  diverges from default and the entry emits normally — so Sync
   *  from UI still produces a faithful round-trip. The flag does NOT
   *  affect parser behavior; the path remains assignable. */
  legacyHiddenWhenDefault?: boolean;
}

// ─── Schema construction ────────────────────────────────────────────────────
//
// A handful of schema rows are computed from the strategy registry so
// strategies that get added later show up automatically in autocomplete.
// We DON'T duplicate the strategy-param descriptions here — those live in
// each strategy's `paramFields` and we pull them through.

/** Union of all params across all strategies, deduplicated. Each row notes
 *  which strategies own the param so users get a hint when a param doesn't
 *  apply to their current strategy choice. */
function buildParamSchemaEntries(): ScriptSchemaEntry[] {
  const rows = new Map<string, ScriptSchemaEntry>();
  for (const strat of STRATEGIES) {
    for (const f of strat.paramFields) {
      const path = `params.${f.key}`;
      const existing = rows.get(path);
      if (existing) {
        // Append this strategy to the existing entry's owner list so docs
        // surface "used by signal_v1, signal_v2" when a param is shared.
        existing.strategies = [...(existing.strategies ?? []), strat.id];
        continue;
      }
      rows.set(path, {
        path,
        type: f.type,
        section: "Strategy params",
        description: f.description ?? f.label,
        default: f.default,
        min: f.min,
        max: f.max,
        step: f.step,
        strategies: [strat.id],
      });
    }
  }
  return Array.from(rows.values());
}

/** Allowed bollinger-position string values. Mirrors BollingerPos; the
 *  literal list is duplicated here so editor autocomplete doesn't need to
 *  reach into the runtime types. */
const BOLLINGER_POSITIONS: BollingerPos[] = [
  "above_upper",
  "inside",
  "below_lower",
];

/** All position-mode values, in the same order the UI dropdown shows them. */
const POSITION_MODES: PositionMode[] = [
  "default",
  "close-previous",
  "add-close",
  "null",
  "add-null",
  "reverse-null",
  "reverse-add",
];

/** All trend modes. */
const TREND_MODES: TrendMode[] = ["any", "with", "against"];

/** All MA flavors usable by the configurable trend / MA-distance
 *  filters. EMA reacts faster, SMA gives equal weight. */
const MA_TYPES: MaType[] = ["ema", "sma"];

/** Direction modes for the MA-distance filter. See PresetFilters.MaDistanceMode. */
const MA_DISTANCE_MODES: MaDistanceMode[] = ["absolute", "above", "below"];

/** ADX direction modes for the adxTrend filter. */
const ADX_TREND_MODES: AdxTrendMode[] = ["any", "rising", "falling", "flat"];

// ─── The schema ─────────────────────────────────────────────────────────────
//
// Order MATTERS — this is the order the docs panel renders, and the order
// serializeBacktestScript() emits assignments in. Group related fields
// together; keep section labels stable so users can ctrl-F past versions.
//
// Each row's `default` is what a fresh config would have. Numeric defaults
// for params are pulled from the StrategyParamField rows; rules defaults
// come from DEFAULT_SIM_RULES (kept here as inlined literals to avoid a
// circular pull-from-dashboard).

export const SCRIPT_SCHEMA: ScriptSchemaEntry[] = [
  // ── Strategy ────────────────────────────────────────────────────────────
  {
    path: "strategy",
    type: "enum",
    section: "Strategy",
    description:
      "Which signal generator to run. Each strategy exposes its own params.* — see the Strategy params section. Soft-set: doesn't touch params.* — to also reset every param to that strategy's defaults, use `loadstrategy = ...` instead.",
    default: STRATEGIES[0].id,
    options: STRATEGIES.map((s) => s.id),
    enumerable: true,
  },
  {
    // loadstrategy is a HOISTED directive: regardless of where the line
    // appears in the script, the parser pre-pass applies it before any
    // other line is processed. The effect is "switch strategy AND reset
    // every params.* field to that strategy's default value." Subsequent
    // params.* assignments in the same script then override individual
    // defaults. This lets users swap strategies without manually
    // rewriting every params.* line. NOT round-tripped by the
    // serializer (it's a one-shot operation, not a stored value), so
    // Sync from UI / Load Defaults never re-emit it.
    path: "loadstrategy",
    type: "enum",
    section: "Strategy",
    description:
      'Switch strategy AND replace every params.* field with the new strategy\'s default values. Hoisted: applied BEFORE the rest of the script, so any `params.X = Y` lines you keep below will override the loaded defaults. Use this to switch strategies without manually rewriting every params.* line. Example: `loadstrategy = signal_v2`. NOT round-tripped — it\'s a one-shot operation, not a stored field.',
    default: STRATEGIES[0].id,
    options: STRATEGIES.map((s) => s.id),
    enumerable: true,
  },

  // ── Strategy params (auto-built) ────────────────────────────────────────
  ...buildParamSchemaEntries(),

  // ── Risk rules: exits ──────────────────────────────────────────────────
  {
    path: "rules.stopLossEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Master toggle for the fixed stop loss.",
    default: true,
    enumerable: true,
  },
  {
    path: "rules.stopLossPoints",
    type: "float",
    section: "Risk rules — Exits",
    description: "Stop loss distance in points from entry.",
    default: 10,
    min: 0,
    max: 200,
    step: 0.25,
  },
  {
    path: "rules.takeProfitEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Master toggle for the fixed take profit.",
    default: true,
    enumerable: true,
  },
  {
    path: "rules.takeProfitPoints",
    type: "float",
    section: "Risk rules — Exits",
    description: "Take profit distance in points from entry.",
    default: 20,
    min: 0,
    max: 200,
    step: 0.25,
  },
  {
    path: "rules.trailingStopEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Trailing stop, locked in points behind the running peak.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.trailingStopPoints",
    type: "float",
    section: "Risk rules — Exits",
    description: "Trailing stop distance behind peak in points.",
    default: 8,
    min: 0,
    max: 100,
    step: 0.25,
  },
  {
    path: "rules.timedExitEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Force-exit after a fixed number of bars held.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.timedExitBars",
    type: "int",
    section: "Risk rules — Exits",
    description: "Bars to hold before forced timed exit.",
    default: 20,
    min: 1,
    max: 200,
    step: 1,
  },
  {
    path: "rules.breakEvenEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Move stop to entry once profit clears the trigger.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.breakEvenTrigger",
    type: "float",
    section: "Risk rules — Exits",
    description: "Profit (in points) at which break-even snaps in.",
    default: 5,
    min: 0,
    max: 100,
    step: 0.25,
  },
  {
    path: "rules.exitAtBarClose",
    type: "boolean",
    section: "Risk rules — Exits",
    description:
      "true = exit at candle close after the trigger; false = exit at the exact trigger price intra-bar.",
    default: true,
    enumerable: true,
  },
  {
    path: "rules.extensionBarsEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description:
      "Append N replay bars after the zone end so the simulator can simulate holding longer.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.extensionBars",
    type: "int",
    section: "Risk rules — Exits",
    description: "How many extra bars to append when extensionBarsEnabled is true.",
    default: 20,
    min: 1,
    max: 100,
    step: 1,
  },

  // ── Risk rules: ATR adjust ──────────────────────────────────────────────
  {
    path: "rules.slAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description:
      "Stop loss = stopLossPoints + slAtrAdjust × ATR(14). 0 = fixed-points behavior.",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    path: "rules.tpAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description: "Take profit = takeProfitPoints + tpAtrAdjust × ATR(14).",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    path: "rules.trailAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description: "Trailing distance = trailingStopPoints + trailAtrAdjust × ATR(14).",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    path: "rules.beAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description: "Break-even trigger = breakEvenTrigger + beAtrAdjust × ATR(14).",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
  },

  // ── Risk rules: Position overlap ───────────────────────────────────────
  {
    path: "rules.positionMode",
    type: "enum",
    section: "Risk rules — Position overlap",
    description:
      "How to handle a new signal while a previous trade is still open. " +
      `"default" simulates each zone in isolation; "close-previous" closes ALL open trades on a new signal; "add-close" closes only OPPOSING open trades; "null" drops new signals while anything is open; "add-null" drops new signals only while an opposing trade is open; "reverse-null" flips the side on an opposing signal (drops same-direction signals) and resets size; "reverse-add" flips on opposing (size reset) and stacks on same-direction.`,
    default: "default",
    options: POSITION_MODES,
    enumerable: true,
  },

  // ── Risk rules: Scaling ────────────────────────────────────────────────
  {
    path: "rules.scalingEnabled",
    type: "boolean",
    section: "Risk rules — Scaling",
    description:
      "Walks position size across trades: + winStep on win, − lossStep on loss, clamped to [minSize, maxSize].",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.scalingStartSize",
    type: "int",
    section: "Risk rules — Scaling",
    description: "Initial position size for the scaling walk.",
    default: 1,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    path: "rules.scalingWinStep",
    type: "int",
    section: "Risk rules — Scaling",
    description: "Contracts added after a winning trade.",
    default: 1,
    min: 0,
    max: 20,
    step: 1,
  },
  {
    path: "rules.scalingLossStep",
    type: "int",
    section: "Risk rules — Scaling",
    description: "Contracts removed after a losing trade.",
    default: 1,
    min: 0,
    max: 20,
    step: 1,
  },
  {
    path: "rules.scalingMinSize",
    type: "int",
    section: "Risk rules — Scaling",
    description: "Floor for the running scaled size.",
    default: 1,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    path: "rules.scalingMaxSize",
    type: "int",
    section: "Risk rules — Scaling",
    description: "Ceiling for the running scaled size.",
    default: 5,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    path: "rules.scalingResetDaily",
    type: "boolean",
    section: "Risk rules — Scaling",
    description:
      "Reset running size back to scalingStartSize at every day boundary so each session starts fresh.",
    default: false,
    enumerable: true,
  },

  // ── Risk rules: Daily kill switches ────────────────────────────────────
  {
    path: "rules.dailyStopLossEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description:
      "Stop trading for the day after cumulative scaled P&L crosses below −dailyStopLossPoints.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.dailyStopLossPoints",
    type: "float",
    section: "Risk rules — Daily limits",
    description: "Daily loss threshold (positive number, treated as −X internally).",
    default: 50,
    min: 0,
    max: 1000,
    step: 1,
  },
  {
    path: "rules.dailyTakeProfitEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "Stop trading for the day after cumulative scaled P&L crosses +dailyTakeProfitPoints.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.dailyTakeProfitPoints",
    type: "float",
    section: "Risk rules — Daily limits",
    description: "Daily profit threshold.",
    default: 50,
    min: 0,
    max: 1000,
    step: 1,
  },
  {
    path: "rules.dailyLimitExactMode",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description:
      "When true, in-flight trades are force-closed at the bar the daily limit fires; when false, they finish naturally and the day-stop only blocks new entries.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.maxTradesPerDayEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description:
      "Hard cap on entries per calendar day. Once N trades have started today, every later entry is dropped — independent of P&L.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.maxTradesPerDay",
    type: "int",
    section: "Risk rules — Daily limits",
    description: "Max number of trades allowed per day when enabled.",
    default: 5,
    min: 1,
    max: 200,
    step: 1,
  },
  {
    path: "rules.maxLossesPerDayEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description:
      "Hard cap on LOSING trades per day. Once N losers (per-contract exitPoints < 0) have closed today, every later entry is dropped.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.maxLossesPerDay",
    type: "int",
    section: "Risk rules — Daily limits",
    description: "Max number of losing trades allowed per day when enabled.",
    default: 3,
    min: 1,
    max: 50,
    step: 1,
  },
  {
    path: "rules.cooldownBetweenTradesEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description:
      "Drop new entries that fire within `cooldownBetweenTradesBars` minutes of the previous KEPT trade's exit. Caps over-trading.",
    default: false,
    enumerable: true,
  },
  {
    path: "rules.cooldownBetweenTradesBars",
    type: "int",
    section: "Risk rules — Daily limits",
    description:
      "Cooldown window after each kept trade's exit, in minutes. Approximate match for sub-minute timeframes.",
    default: 5,
    min: 1,
    max: 240,
    step: 1,
  },

  // ── Fills & Costs ──────────────────────────────────────────────────────
  // fillMode controls WHERE the entry actually fills (trigger-bar close vs
  // next-bar open). tickConfigMode controls whether ticksPerPoint /
  // tickValue / pointValue are auto-resolved from the zone's instrument
  // symbol (default) or taken from the explicit rules.* fields below
  // (manual override).
  {
    path: "rules.fillMode",
    type: "enum",
    section: "Risk rules — Fills & Costs",
    description:
      '"next_open" (default) fills at the FOLLOWING bar\'s open — matches NinjaTrader\'s Calculate.OnBarClose live behavior and is the realistic default. "close" fills at the trigger bar\'s close (legacy; assumes a market order that gets the closing print). Switch to "close" only to reproduce historical results from before this field existed.',
    default: "next_open",
    options: ["close", "next_open"],
    enumerable: true,
  },
  {
    path: "rules.tickConfigMode",
    type: "enum",
    section: "Risk rules — Fills & Costs",
    description:
      'Auto-resolve tick / point values from the instrument symbol (NQ, ES, GC, CL, BTC, etc. — see futures.ts for the full table) OR use the explicit rules.* values below. "auto" is correct for any standard CME contract; switch to "manual" only for custom or unrecognized instruments.',
    default: "auto",
    options: ["auto", "manual"],
    enumerable: true,
  },
  {
    path: "rules.pointValue",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Dollar value per 1.0 price point per contract. ONLY used when tickConfigMode is \"manual\" (or as fallback when an instrument symbol isn't in the auto-detect table). NQ=20, ES=50, CL=1000, GC=100.",
    default: 20,
    min: 0,
    max: 100000,
    step: 0.01,
  },
  {
    path: "rules.ticksPerPoint",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Ticks per price point. ONLY used when tickConfigMode is \"manual\" (or as fallback for unrecognized instruments). NQ/ES=4 (0.25-pt ticks), CL=100, GC=10, RTY=10, BTC=0.2, ZB=32.",
    default: 4,
    min: 0.01,
    max: 10000,
    step: 0.01,
  },
  {
    path: "rules.tickValue",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Dollar value per tick. ONLY used when tickConfigMode is \"manual\". Should equal pointValue / ticksPerPoint. NQ=5, ES=12.5, CL=10, GC=10, BTC=25.",
    default: 5,
    min: 0,
    max: 100000,
    step: 0.01,
  },
  {
    path: "rules.slippagePoints",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Per-side slippage in price points. Subtracted twice (round trip) from each trade's exitPoints. 0 = perfect fills.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.01,
  },
  {
    path: "rules.commissionPerRoundTrip",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Flat $ commission per closed trade (round trip). Reported in $ totals; doesn't affect points-based metrics.",
    default: 0,
    min: 0,
    max: 1000,
    step: 0.01,
  },

  // ── Filters: time of day ───────────────────────────────────────────────
  {
    path: "filters.time.enabled",
    type: "boolean",
    section: "Filters — Time of day",
    description: "Restrict trades to entries whose start time falls in [from, to]. Wraps midnight if from > to.",
    default: false,
    enumerable: true,
  },
  {
    path: "filters.time.from",
    type: "string",
    section: "Filters — Time of day",
    description: 'Window start — "HH:MM" (24-hour).',
    default: "09:30",
  },
  {
    path: "filters.time.to",
    type: "string",
    section: "Filters — Time of day",
    description:
      'Window end — "HH:MM" (24-hour). Mirrors `windows[0].to` when multiple windows are configured. Use `filters.time.windows` for multi-window setups.',
    default: "16:00",
  },
  {
    path: "filters.time.windows",
    type: "stringArray",
    section: "Filters — Time of day",
    description:
      'Multi-window list. Each element is "HH:MM-HH:MM" (24-hour, wraps midnight when the start is later than the end). A bar passes when its time falls in ANY window. Empty array falls back to the single [from, to] pair above.',
    default: ["09:30-16:00"],
  },

  // ── Filters: ADX ───────────────────────────────────────────────────────
  // All ADX gating can be expressed via `filter.if = ADX(period) >= min &&
  // ADX(period) <= max` — the legacy section is kept on the schema for
  // UI back-compat but hidden from the default-script emission.
  {
    path: "filters.adx.enabled",
    type: "boolean",
    section: "Filters — ADX",
    description: "Keep only trades whose entry-bar ADX(14) is in [min, max]. Drops zones with no ADX value.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.adx.min",
    type: "float",
    section: "Filters — ADX",
    description: "Inclusive lower bound on ADX(14).",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.adx.max",
    type: "float",
    section: "Filters — ADX",
    description: "Inclusive upper bound on ADX(14).",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.adx.period",
    type: "int",
    section: "Filters — ADX",
    description:
      "Wilder ADX period. Default 14. Drives the ctx_adx14 value used by this filter.",
    default: 14,
    min: 2,
    max: 200,
    step: 1,
    legacyHiddenWhenDefault: true,
  },

  // ── Filters: ATR ───────────────────────────────────────────────────────
  // ATR gating is `filter.if = ATR(period) >= min && ATR(period) <= max`.
  // Note: filters.atr.period ALSO drives per-rule ATR-adjust math
  // (SL/TP/Trail/BE) — it's still hidden when at default, and any
  // diverging value emits as usual.
  {
    path: "filters.atr.enabled",
    type: "boolean",
    section: "Filters — ATR",
    description: "Keep only trades whose entry-bar ATR(14) is in [min, max]. Drops zones with no ATR value.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.atr.min",
    type: "float",
    section: "Filters — ATR",
    description: "Inclusive lower bound on ATR(14) (points).",
    default: 0,
    min: 0,
    max: 100,
    step: 0.25,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.atr.max",
    type: "float",
    section: "Filters — ATR",
    description: "Inclusive upper bound on ATR(14) (points).",
    default: 100,
    min: 0,
    max: 100,
    step: 0.25,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.atr.period",
    type: "int",
    section: "Filters — ATR",
    description:
      "Wilder ATR period. Default 14. Drives BOTH this filter AND the per-rule ATR-adjust math on SL/TP/Trail/BE.",
    default: 14,
    min: 2,
    max: 200,
    step: 1,
    legacyHiddenWhenDefault: true,
  },

  // ── Filters: Trend (EMA20 / EMA200) ────────────────────────────────────
  // Trend gating expressed via filter.if:
  //   "with" longs:  filter.if = direction > 0 && close > EMA(period)
  //   "with" shorts: filter.if = direction < 0 && close < EMA(period)
  //   combined:      filter.if = (direction > 0 && close > EMA(20))
  //                            || (direction < 0 && close < EMA(20))
  // The legacy fields stay on the schema for the UI but are hidden from
  // default-script emission.
  {
    path: "filters.trend.enabled",
    type: "boolean",
    section: "Filters — Trend",
    description: "Master toggle for EMA20 / EMA200 trend-mode filtering.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.trend.ema20",
    type: "enum",
    section: "Filters — Trend",
    description:
      `EMA20 mode: "with" keeps trades where price is on the side of EMA20 matching the trade direction; "against" the opposite; "any" disables this leg.`,
    default: "with",
    options: TREND_MODES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.trend.ema200",
    type: "enum",
    section: "Filters — Trend",
    description: `Same as ema20 but for the long-term EMA200 trend.`,
    default: "any",
    options: TREND_MODES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.trend.fastPeriod",
    type: "int",
    section: "Filters — Trend",
    description:
      "Period of the FAST trend MA (the leg whose mode lives at filters.trend.ema20). Default 20. Lets users replace the legacy hardcoded EMA(20) with anything (9, 50, 100, …).",
    default: 20,
    min: 2,
    max: 500,
    step: 1,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.trend.fastType",
    type: "enum",
    section: "Filters — Trend",
    description: 'Smoothing flavor of the fast MA — "ema" or "sma".',
    default: "ema",
    options: MA_TYPES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.trend.slowPeriod",
    type: "int",
    section: "Filters — Trend",
    description:
      "Period of the SLOW trend MA (the leg whose mode lives at filters.trend.ema200). Default 200.",
    default: 200,
    min: 2,
    max: 1000,
    step: 1,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.trend.slowType",
    type: "enum",
    section: "Filters — Trend",
    description: 'Smoothing flavor of the slow MA — "ema" or "sma".',
    default: "ema",
    options: MA_TYPES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },

  // ── Filters: Bollinger position ────────────────────────────────────────
  {
    path: "filters.bollinger.enabled",
    type: "boolean",
    section: "Filters — Bollinger",
    description: "Keep only trades whose entry-bar bollinger position is in `allowed`.",
    default: false,
    enumerable: true,
  },
  {
    path: "filters.bollinger.allowed",
    type: "stringArray",
    section: "Filters — Bollinger",
    description:
      "Allowed bollinger positions. Any subset of [\"above_upper\", \"inside\", \"below_lower\"]. Empty array drops everything.",
    default: BOLLINGER_POSITIONS,
    options: BOLLINGER_POSITIONS,
    enumerable: true,
  },
  {
    path: "filters.bollinger.period",
    type: "int",
    section: "Filters — Bollinger",
    description:
      "BB centerline (SMA) period. Default 20. Shared with the BB-width filter.",
    default: 20,
    min: 2,
    max: 500,
    step: 1,
  },
  {
    path: "filters.bollinger.stdDev",
    type: "float",
    section: "Filters — Bollinger",
    description:
      "Stddev multiplier for the bands — band = mean ± multiplier × σ. Default 2.0.",
    default: 2,
    min: 0.5,
    max: 5,
    step: 0.1,
  },

  // ── Filters: Bollinger band width ──────────────────────────────────────
  {
    path: "filters.bbWidth.enabled",
    type: "boolean",
    section: "Filters — BB width",
    description:
      "Range gate on Bollinger band width (upper − lower) in price points at entry. Useful for filtering compressed-volatility ranges or wide chop. Period and stddev come from filters.bollinger.*",
    default: false,
    enumerable: true,
  },
  {
    path: "filters.bbWidth.min",
    type: "float",
    section: "Filters — BB width",
    description: "Minimum band width in price points (inclusive).",
    default: 0,
    min: 0,
    max: 1000,
    step: 0.25,
  },
  {
    path: "filters.bbWidth.max",
    type: "float",
    section: "Filters — BB width",
    description: "Maximum band width in price points (inclusive).",
    default: 1000,
    min: 0,
    max: 10000,
    step: 0.25,
  },

  // ── Filters: Distance from a configurable MA ───────────────────────────
  // MA-distance gating: filter.if = abs(close - EMA(period)) / ATR(14)
  // >= min && abs(close - EMA(period)) / ATR(14) <= max
  // (with sign checks for "above"/"below" modes).
  {
    path: "filters.maDistance.enabled",
    type: "boolean",
    section: "Filters — MA distance",
    description:
      "Range gate on the entry-bar distance from a configurable MA, measured in ATR units (using filters.atr.period). Independent of the trend filter — pick any reference MA.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.maDistance.period",
    type: "int",
    section: "Filters — MA distance",
    description: "Period of the reference MA. Default 50.",
    default: 50,
    min: 2,
    max: 1000,
    step: 1,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.maDistance.type",
    type: "enum",
    section: "Filters — MA distance",
    description: 'MA flavor — "ema" or "sma".',
    default: "ema",
    options: MA_TYPES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.maDistance.mode",
    type: "enum",
    section: "Filters — MA distance",
    description:
      '"absolute" → |distance| in [min, max]; "above" → price must be ABOVE the MA and the (positive) distance in [min, max]; "below" → price must be BELOW and |distance| in [min, max].',
    default: "absolute",
    options: MA_DISTANCE_MODES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.maDistance.min",
    type: "float",
    section: "Filters — MA distance",
    description: "Lower bound on distance (in ATR units).",
    default: 0,
    min: 0,
    max: 50,
    step: 0.05,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.maDistance.max",
    type: "float",
    section: "Filters — MA distance",
    description: "Upper bound on distance (in ATR units).",
    default: 5,
    min: 0,
    max: 50,
    step: 0.05,
    legacyHiddenWhenDefault: true,
  },

  // ── Filters: Volume ────────────────────────────────────────────────────
  // Volume-ratio gating: filter.if = volume / volume(period) >= minRatio &&
  //                                  volume / volume(period) <= maxRatio
  {
    path: "filters.volume.enabled",
    type: "boolean",
    section: "Filters — Volume",
    description:
      "Range gate on the ratio of the entry bar's volume to its N-bar average. 1.0 = at average. minRatio=1.5 keeps only above-average-volume entries.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.volume.period",
    type: "int",
    section: "Filters — Volume",
    description: "N-bar lookback for the volume average. Default 20.",
    default: 20,
    min: 2,
    max: 500,
    step: 1,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.volume.minRatio",
    type: "float",
    section: "Filters — Volume",
    description: "Minimum volume / N-bar avg ratio (inclusive).",
    default: 0,
    min: 0,
    max: 100,
    step: 0.05,
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.volume.maxRatio",
    type: "float",
    section: "Filters — Volume",
    description: "Maximum volume / N-bar avg ratio (inclusive).",
    default: 100,
    min: 0,
    max: 1000,
    step: 0.05,
    legacyHiddenWhenDefault: true,
  },

  // ── Filters: RSI ───────────────────────────────────────────────────────
  {
    path: "filters.rsi.enabled",
    type: "boolean",
    section: "Filters — RSI",
    description:
      "Keep only entries whose Wilder RSI(period) at entry is in [min, max]. Classic oversold/overbought zones are < 30 / > 70.",
    default: false,
    enumerable: true,
  },
  {
    path: "filters.rsi.period",
    type: "int",
    section: "Filters — RSI",
    description: "Wilder RSI period. Default 14.",
    default: 14,
    min: 2,
    max: 200,
    step: 1,
  },
  {
    path: "filters.rsi.min",
    type: "float",
    section: "Filters — RSI",
    description: "Inclusive lower bound on RSI (0–100).",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
  },
  {
    path: "filters.rsi.max",
    type: "float",
    section: "Filters — RSI",
    description: "Inclusive upper bound on RSI (0–100).",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
  },

  // ── Filters: ADX direction (rising / falling / flat) ───────────────────
  {
    path: "filters.adxTrend.enabled",
    type: "boolean",
    section: "Filters — ADX direction",
    description:
      "Gate on the DIRECTION of ADX at entry — rising (trend strength building), falling (losing strength), or flat (range / regime stable). Slope = ADX[i] − ADX[i − lookback].",
    default: false,
    enumerable: true,
  },
  {
    path: "filters.adxTrend.mode",
    type: "enum",
    section: "Filters — ADX direction",
    description:
      '"rising" → slope > flatThreshold; "falling" → slope < -flatThreshold; "flat" → |slope| ≤ flatThreshold; "any" disables the gate.',
    default: "rising",
    options: ADX_TREND_MODES,
    enumerable: true,
  },
  {
    path: "filters.adxTrend.lookback",
    type: "int",
    section: "Filters — ADX direction",
    description:
      "Bars looked back when computing the slope. Default 5. Changing this re-runs the backtest because the slope value is stamped at signal time.",
    default: 5,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    path: "filters.adxTrend.flatThreshold",
    type: "float",
    section: "Filters — ADX direction",
    description:
      "|slope| ≤ this is considered flat. Larger values widen the flat band and narrow the rising/falling bands.",
    default: 1,
    min: 0,
    max: 50,
    step: 0.1,
  },

  // ── Print directives (Script v2) ──────────────────────────────────────
  // Two new paths that ACCUMULATE — the schema lookup map allows multiple
  // assignments to the same path and the parser collects each one as a
  // separate entry. RHS = `<expression> [, "label"]`. Evaluator runs each
  // expression at the appropriate time; values land in the script-output
  // panel + inline as stat cards / trade-table columns.
  {
    path: "print",
    type: "directive",
    section: "Output — Strategy prints",
    description:
      'Strategy-level print: evaluated ONCE after the run against aggregate stats. RHS is an expression with optional `, "label"`. Available identifiers: winRate, profitFactor, totalPnl, expectancy, avgBarsHeld (alias avgtradetime), dailyEv, sharpeOriginal, sharpeSimulated, totalTrades, winners, losers — see the docs panel for the full list.',
    default: "",
  },
  {
    path: "ontrade.print",
    type: "directive",
    section: "Output — Per-trade prints",
    description:
      'Per-trade print: evaluated at each trade\'s entry bar. RHS is an expression with optional `, "label"`. Available identifiers: ATR, EMA20, ADX, volume, close, etc. Function-call form supported: ATR(14), volume(14), trailVol(14), stdev(14). One column per unique label appears on the trades table.',
    default: "",
  },

  // ── Conditional filter (Script v2.1) ──────────────────────────────────
  // `filter.if = (<bool-expression>)` gates each trade by an arbitrary
  // boolean expression (NaN = fail, 0 = fail, anything else = pass). The
  // 3-arg form `filter.if = (cond, if_true, if_false)` lets each branch
  // run a sequence of action statements (rule overrides, prints, nested
  // filter.if, sticky modifier). Empty/omitted slots fall through to the
  // default verdict (true → pass, false → reject); a non-empty slot
  // REPLACES that default — to preserve "reject and print", you must
  // include an explicit `reject` in the slot. Multiple filter.if lines
  // are AND'd together — every directive must produce a "pass" verdict
  // for the trade to fire. See parseFilterIfRhs / FilterIfDirective for
  // the exact statement grammar.
  {
    path: "filter.if",
    type: "directive",
    section: "Filters — Conditional",
    description:
      'Conditional filter. Single-arg form `filter.if = ATR > 0.5` gates each trade by a boolean expression (true = pass, false = reject). 3-arg form `filter.if = (cond, if_true_actions, if_false_actions)` runs action statements per branch — `rules.X = expr`, `print(expr [, "label"])`, `pass`, `reject`, nested `filter.if = (...)`, all separated by `;`. Empty slot keeps the default verdict; defining a slot REPLACES it (write `reject` explicitly to keep the default-false reject). Multiple `filter.if` lines AND together.',
    default: "",
  },

  // ── Optimization (Script v3) ─────────────────────────────────────────
  // OptimizeAll controls how multiple `Optimize.X.Y(...)` directives
  // co-evolve. When false (default) each directive runs its own
  // independent TPE search; when true they share a single joint search
  // and must agree on the objective.
  {
    path: "OptimizeAll",
    type: "boolean",
    section: "Optimization",
    description:
      "When true, all Optimize.X.Y(...) directives in this script share one TPE search over the joint multi-dim space (must agree on objective). When false (default), each directive optimizes independently.",
    default: false,
    enumerable: true,
  },
  {
    path: "Warmup",
    type: "boolean",
    section: "Optimization",
    description:
      "When true (default), trades fired before the optimizer's lookback fills are included in the final stats — useful for understanding how the strategy performs without optimization. When false, those warmup trades are excluded so the final stats reflect only the optimized phase. Either way, the optimizer still uses warmup trades internally to build its lookback window.",
    default: true,
    enumerable: true,
  },
];

// Lookup index for O(1) path validation.
const SCHEMA_BY_PATH = new Map<string, ScriptSchemaEntry>(
  SCRIPT_SCHEMA.map((e) => [e.path, e])
);

export function getSchemaEntry(path: string): ScriptSchemaEntry | undefined {
  return SCHEMA_BY_PATH.get(path);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** A non-fatal complaint about one line in the script. The parser keeps
 *  going past these so users see EVERY problem at once, not just the first. */
export interface ScriptError {
  /** 1-indexed line number where the problem was found. */
  line: number;
  /** What went wrong. */
  message: string;
  /** "warning" = unknown path, ignored value, etc. — script still applies.
   *  "error"   = malformed line — could not parse. Script will still apply
   *              everything that DID parse successfully. */
  severity: "error" | "warning";
}

export interface ParseResult {
  /** Partial config: ONLY the fields the script actually assigned. The
   *  caller merges this onto the dashboard's current state. */
  config: PartialBacktestConfig;
  /** All warnings + errors. Empty array = clean parse. */
  errors: ScriptError[];
}

/** A partial config with the same shape as BacktestConfig, but every
 *  branch is optional so the dashboard knows which keys to actually
 *  overwrite. */
export type PartialBacktestConfig = {
  strategy?: string;
  params?: Record<string, number>;
  rules?: Partial<SimRules>;
  filters?: {
    time?: { enabled?: boolean; from?: string; to?: string; windows?: string[] };
    adx?: { enabled?: boolean; min?: number; max?: number; period?: number };
    atr?: { enabled?: boolean; min?: number; max?: number; period?: number };
    trend?: {
      enabled?: boolean;
      ema20?: TrendMode;
      ema200?: TrendMode;
      fastPeriod?: number;
      fastType?: MaType;
      slowPeriod?: number;
      slowType?: MaType;
    };
    bollinger?: {
      enabled?: boolean;
      allowed?: BollingerPos[];
      period?: number;
      stdDev?: number;
    };
    bbWidth?: { enabled?: boolean; min?: number; max?: number };
    maDistance?: {
      enabled?: boolean;
      period?: number;
      type?: MaType;
      mode?: MaDistanceMode;
      min?: number;
      max?: number;
    };
    volume?: {
      enabled?: boolean;
      period?: number;
      minRatio?: number;
      maxRatio?: number;
    };
    rsi?: {
      enabled?: boolean;
      period?: number;
      min?: number;
      max?: number;
    };
    adxTrend?: {
      enabled?: boolean;
      mode?: AdxTrendMode;
      lookback?: number;
      flatThreshold?: number;
    };
  };
  // ── Script v2 additions ────────────────────────────────────────────────
  // Numeric overrides — when a rules.* numeric field's RHS is an
  // EXPRESSION (not a literal), the literal value in `rules` is left
  // untouched (so the dashboard's UI value remains the fallback) and the
  // compiled expression lands here, keyed by full path. The simulator's
  // resolveRulesForTrade reads this map at trade entry; on NaN it falls
  // back to the literal in rules.
  numericOverrides?: Record<string, NumericValue>;
  // Print directives — accumulated arrays so multiple `print = ...` /
  // `ontrade.print = ...` lines all surface in the output panel.
  summaryPrints?: PrintDirective[];
  tradePrints?: PrintDirective[];
  // Conditional filters — multiple `filter.if = ...` lines accumulate.
  // ALL of them must produce a "pass" verdict at trade entry for the
  // trade to fire (AND semantics), and any rule overrides emitted by
  // the taken branch stack on top of numericOverrides for the resolved
  // trade. See FilterIfDirective for the action statement shape.
  filterIfs?: FilterIfDirective[];
  // ── Script Optimize directives ────────────────────────────────────
  // When a field's RHS is `Optimize.<Obj>.<Unit>(...)`, the spec lands
  // here keyed by full path (e.g. `rules.stopLossPoints`). The online
  // optimizer (in the worker) walks this map at each new signal, runs
  // TPE over the lookback window, and resolves each spec to a concrete
  // value for the trade about to fire. Empty/absent → no optimization.
  optimizeOverrides?: Record<string, OptimizeSpec>;
  // OptimizeAll directive (top-level boolean). When true, all
  // optimizeOverrides share one TPE search over the joint multi-dim
  // space. When false (default), each spec runs an independent TPE.
  optimizeAll?: boolean;
  // Warmup directive (top-level boolean). When true (default),
  // pre-warmup trades are included in the final stats; when false they
  // are excluded so users see only the post-warmup optimized run.
  // Honored by `runOnlineOptimizedBacktest` — the optimizer still uses
  // warmup trades internally for lookback math regardless of this flag.
  warmup?: boolean;
  // ── loadstrategy directive ────────────────────────────────────────
  // Set by the parser's hoisted pre-pass when the script contains
  // `loadstrategy = X`. Signals to the caller that `cfg.params` should
  // REPLACE the dashboard's current params dict (not merge into it),
  // so stale params from the previously selected strategy don't leak
  // through. When false/absent, the dashboard merges as usual.
  replaceParams?: boolean;
};

/** A single `print = expr [, "label"]` directive. The label defaults to
 *  the original expression source when the user omits it; that way a
 *  bare `print = winRate` produces a column titled "winRate" without
 *  forcing the user to label everything. */
export interface PrintDirective {
  source: string;
  expr: Expr;
  label: string;
}

// ─── filter.if directive types ─────────────────────────────────────────
//
// The action language inside `filter.if = (cond, if_true, if_false)` is a
// tiny statement-oriented sub-DSL — different shape from the line-based
// outer script. Statements are semicolon-separated within each slot.
// Verdict semantics (pass/reject) are encoded as halt-and-set markers;
// the runtime walks the statement list in order, applies side-effects,
// and stops the moment it hits an explicit terminator. When the slot
// finishes without a terminator AND was non-empty, the implicit verdict
// is PASS (the slot is treated as a "do these things and let the trade
// through" sequence). When the slot is empty/omitted, the default
// verdict for that branch applies (true → pass, false → reject).
//
// Why a separate AST instead of reusing PartialBacktestConfig pieces:
//   - assignments live PER-TRADE (resolved at entry bar), not per-run,
//     so they share the NumericValue lifecycle but need their own slot.
//   - prints inside filter.if branches are CONDITIONAL — they only
//     fire when the branch is taken — so they don't go through the
//     top-level summary/trade-prints buckets.
//   - nested filter.if needs to resolve recursively at runtime, which
//     requires keeping the cond + branches as a tree, not flattened.

/** Toggle keyword. `pass` and `reject` are halt-and-set verdict markers;
 *  any statement after one of them in the same slot is dead code (the
 *  parser warns but keeps them so re-serialization is lossless). */
export type FilterIfVerdict = "pass" | "reject";

/** A single statement inside a filter.if branch slot. */
export type FilterIfStatement =
  /** `rules.<key> = <expr>` — per-trade rule override applied to the
   *  current trade only, on top of any baseline numericOverrides. The
   *  path must be in NUMERIC_RULE_KEYS (validated at parse time). */
  | {
      kind: "assignment";
      path: string;
      value: NumericValue;
      sticky?: number;
    }
  /** `print(<expr>)` or `print(<expr>, "label")` — emits a per-trade
   *  print column, but only when the branch is taken. Sharing column
   *  names with top-level `ontrade.print = ...` lines is fine; the
   *  output panel merges columns by label. */
  | {
      kind: "print";
      directive: PrintDirective;
      sticky?: number;
    }
  /** `pass` / `reject` — halts the slot and sets the verdict. */
  | { kind: "verdict"; verdict: FilterIfVerdict; sticky?: number }
  /** Nested `filter.if = (...)` — fully recursive. The nested directive
   *  is evaluated when the outer branch is taken; its verdict becomes
   *  the verdict of the outer slot (unless an explicit pass/reject
   *  comes after it in the same slot, which would shadow it). */
  | { kind: "nested"; directive: FilterIfDirective; sticky?: number };

/** A parsed filter.if directive. `cond` is the gating expression;
 *  branches hold their parsed action statement lists. An empty branch
 *  list means "use the default verdict for this branch" — distinct from
 *  a non-empty list with no explicit terminator (which means "pass after
 *  side effects"). The `source` text is the verbatim RHS, kept for
 *  round-tripping back through serializeBacktestScript. */
export interface FilterIfDirective {
  source: string;
  cond: Expr;
  /** Empty array = slot omitted/empty (use default-pass on true branch). */
  ifTrue: FilterIfStatement[];
  /** Empty array = slot omitted/empty (use default-reject on false branch). */
  ifFalse: FilterIfStatement[];
  /** True iff the slot was explicitly defined (even if empty inside
   *  the parens, e.g. `filter.if = (cond, , )` — distinguishes "slot
   *  was given but contained nothing" from "slot was omitted entirely"
   *  for serializer round-tripping. The runtime treats both the same. */
  ifTrueDefined: boolean;
  ifFalseDefined: boolean;
  /** Bare-ident names in `cond` that resolve to optimizer-driven vars
   *  (paths under `var.*` in `optimizeOverrides`). Computed at parse
   *  time so the optimizer's per-signal loop can detect "this filter
   *  depends on a var that hasn't warmed up yet" and skip the directive
   *  entirely instead of rejecting every trade via NaN-as-fail. Empty
   *  set or undefined = no var dependencies, filter always applies. */
  referencedVarNames?: Set<string>;
}

/** Strip a trailing inline comment from `s`, respecting double-quoted
 *  strings so e.g. `from = "09:30" // start time` doesn't lose the value. */
function stripInlineComment(s: string): string {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (c === "#") return s.slice(0, i);
      if (c === "/" && s[i + 1] === "/") return s.slice(0, i);
    }
  }
  return s;
}

/** Parse a single value literal: number | "string" | true | false |
 *  [array of strings or numbers]. Returns null if it doesn't recognize the
 *  shape; caller turns that into a parse error. */
function parseValueLiteral(raw: string): {
  ok: true;
  value: number | string | boolean | string[] | number[];
} | { ok: false; error: string } {
  const t = raw.trim();
  if (t === "") return { ok: false, error: "empty value" };

  // Booleans
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };

  // Strings: must be wrapped in double quotes.
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    // Tiny unescape pass for the only escape we emit (\\ and \").
    const body = t.slice(1, -1);
    const out = body.replace(/\\(["\\])/g, "$1");
    return { ok: true, value: out };
  }

  // Arrays: [a, b, c] — elements are recursively parsed via parseValueLiteral.
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return { ok: true, value: [] };
    // Split on commas that are NOT inside a string literal. Cheap split — we
    // don't support nested arrays in the DSL so a one-level split is fine.
    const parts: string[] = [];
    let buf = "";
    let inStr = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"' && inner[i - 1] !== "\\") inStr = !inStr;
      if (c === "," && !inStr) {
        parts.push(buf);
        buf = "";
      } else {
        buf += c;
      }
    }
    if (buf.trim() !== "") parts.push(buf);

    const parsed: (string | number)[] = [];
    for (const p of parts) {
      const r = parseValueLiteral(p);
      if (!r.ok) return r;
      const v = r.value;
      if (typeof v === "string" || typeof v === "number") {
        parsed.push(v);
      } else {
        return {
          ok: false,
          error: "array elements must be strings or numbers",
        };
      }
    }
    // Disambiguate between string[] and number[] for the caller.
    if (parsed.every((x) => typeof x === "string")) {
      return { ok: true, value: parsed as string[] };
    }
    if (parsed.every((x) => typeof x === "number")) {
      return { ok: true, value: parsed as number[] };
    }
    return { ok: false, error: "array elements must all be the same type" };
  }

  // Numbers: parseFloat handles ints, floats, scientific notation. Reject
  // NaN / partial parses — `Number(t)` would coerce "" to 0 which we don't
  // want, so we use a regex gate first.
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return { ok: true, value: n };
  }

  return { ok: false, error: "value must be number, \"string\", true, false, or [array]" };
}

/** Coerce a raw parsed value into the type the schema demands. Returns
 *  the coerced value or null + reason if the value is incompatible. */
function coerceForEntry(
  raw: number | string | boolean | string[] | number[],
  entry: ScriptSchemaEntry
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (entry.type) {
    case "int":
    case "float": {
      if (typeof raw !== "number") return { ok: false, error: `expected ${entry.type}, got ${typeof raw}` };
      const v = entry.type === "int" ? Math.round(raw) : raw;
      // Soft clamp warning is handled by caller via min/max — we coerce
      // silently so a typo near a boundary doesn't fail the whole parse.
      return { ok: true, value: v };
    }
    case "boolean": {
      if (typeof raw !== "boolean") return { ok: false, error: `expected boolean (true/false), got ${typeof raw}` };
      return { ok: true, value: raw };
    }
    case "string": {
      if (typeof raw !== "string") return { ok: false, error: `expected string, got ${typeof raw}` };
      return { ok: true, value: raw };
    }
    case "enum": {
      if (typeof raw !== "string") return { ok: false, error: `expected string from {${entry.options?.join("|")}}, got ${typeof raw}` };
      if (!entry.options?.includes(raw)) {
        return { ok: false, error: `value must be one of {${entry.options?.join("|")}}` };
      }
      return { ok: true, value: raw };
    }
    case "stringArray": {
      if (!Array.isArray(raw)) return { ok: false, error: "expected array of strings" };
      if (!raw.every((x) => typeof x === "string")) return { ok: false, error: "every element must be a string" };
      const allowed = entry.options;
      if (allowed) {
        const bad = (raw as string[]).find((x) => !allowed.includes(x));
        if (bad !== undefined) {
          return { ok: false, error: `"${bad}" not in {${allowed.join("|")}}` };
        }
      }
      return { ok: true, value: raw };
    }
    case "directive": {
      // Directives don't go through coerceForEntry — the parser handles
      // them on a separate code path because their RHS is `<expr>[, "label"]`,
      // not a value literal. Reaching here means a programming error.
      return { ok: false, error: "directive paths must be parsed on the directive path" };
    }
  }
}

/** Parse the RHS of a `print = ...` / `ontrade.print = ...` line:
 *      <expression> ("," <quoted-string>)?
 *  Returns the compiled expression + label (defaults to expression source
 *  when the comma/label is omitted). */
function parseDirectiveRhs(
  rhs: string
): { ok: true; directive: PrintDirective } | { ok: false; error: string } {
  // Find a TOP-LEVEL comma (not inside a string literal AND not inside a
  // nested function call). Tracking paren depth is required because
  // multi-arg indicator calls — `MACD_line(12, 26)`, `BB_upper(20, 2)` —
  // contain commas that aren't the label separator.
  let inStr = false;
  let depth = 0;
  let commaIdx = -1;
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i];
    if (c === '"' && rhs[i - 1] !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      commaIdx = i;
      break;
    }
  }

  let exprPart: string;
  let label: string;
  if (commaIdx < 0) {
    exprPart = rhs.trim();
    label = exprPart; // default = expression source
  } else {
    exprPart = rhs.slice(0, commaIdx).trim();
    const labelPart = rhs.slice(commaIdx + 1).trim();
    if (!(labelPart.startsWith('"') && labelPart.endsWith('"') && labelPart.length >= 2)) {
      return { ok: false, error: 'label must be a "quoted string"' };
    }
    label = labelPart.slice(1, -1).replace(/\\(["\\])/g, "$1");
    if (label === "") label = exprPart;
  }
  if (exprPart === "") return { ok: false, error: "empty expression in print directive" };
  const c = compileExpr(exprPart);
  if (!c.ok) return { ok: false, error: c.error };
  return { ok: true, directive: { source: c.source, expr: c.expr, label } };
}

// ─── filter.if parser ──────────────────────────────────────────────────────
//
// Two layers:
//   1. parseFilterIfRhs(rhs) splits the outer `(cond, if_true, if_false)`
//      with paren+quote awareness, then dispatches each piece.
//   2. parseFilterIfStatementList(slot) splits a slot on top-level
//      semicolons (also paren/quote-aware) and parses each statement.
//
// The outer split is comma-aware but tolerates the single-arg form: when
// the trimmed RHS doesn't start with `(`, it's treated as a bare
// boolean expression (`filter.if = ATR > 0.5`).

/** Top-level paren/quote-aware split on a single delimiter character.
 *  Tracks `()` depth and double-quote state so commas/semicolons inside
 *  nested calls or string labels don't split. Used by both the outer
 *  filter.if (`,`) split and the per-slot statement (`;`) split. */
function splitTopLevel(text: string, delim: ","|";"): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === delim && depth === 0) {
        out.push(buf);
        buf = "";
        continue;
      }
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/** Strip a leading `sticky(N)` modifier if present. Returns the parsed N
 *  + the remaining statement text, or null if no modifier. The runtime
 *  v1 honors `sticky(0)` (this trade only — the default) and parses
 *  `sticky(N>0)` but emits a warning saying it isn't implemented yet
 *  (deferred along with other cross-trade state). */
function stripStickyPrefix(
  text: string
): { sticky?: number; rest: string; error?: string } {
  const trimmed = text.trim();
  const m = trimmed.match(/^sticky\s*\(\s*([0-9]+)\s*\)\s+([\s\S]*)$/);
  if (!m) return { rest: trimmed };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) {
    return { rest: trimmed, error: `sticky(N): N must be a non-negative integer (got "${m[1]}")` };
  }
  return { sticky: n, rest: m[2].trim() };
}

/** Parse a single statement inside a filter.if branch slot. Statement
 *  forms recognized:
 *    - `pass`                        → verdict: pass
 *    - `reject`                      → verdict: reject
 *    - `print(<expr> [, "label"])`   → conditional print
 *    - `rules.<key> = <expr>`        → per-trade rule override
 *    - `filter.if = (...)`           → nested directive
 *  Each may be prefixed with `sticky(N)`. */
function parseFilterIfStatement(
  raw: string
): { ok: true; statement: FilterIfStatement } | { ok: false; error: string } {
  const sticky = stripStickyPrefix(raw);
  if (sticky.error) return { ok: false, error: sticky.error };
  const text = sticky.rest;
  if (text === "") return { ok: false, error: "empty statement" };

  // Bare verdict keywords. Match the whole statement so `passing` doesn't
  // fire — anchor with regex.
  if (/^pass\s*$/.test(text)) {
    return {
      ok: true,
      statement: { kind: "verdict", verdict: "pass", sticky: sticky.sticky },
    };
  }
  if (/^reject\s*$/.test(text)) {
    return {
      ok: true,
      statement: { kind: "verdict", verdict: "reject", sticky: sticky.sticky },
    };
  }

  // print(expr) / print(expr, "label") — function-call form rather than
  // the top-level `print = expr` form so the statement parser doesn't
  // confuse it with an assignment.
  const printMatch = text.match(/^print\s*\(([\s\S]*)\)\s*$/);
  if (printMatch) {
    const inner = printMatch[1];
    const d = parseDirectiveRhs(inner);
    if (!d.ok) return { ok: false, error: `print(...): ${d.error}` };
    return {
      ok: true,
      statement: { kind: "print", directive: d.directive, sticky: sticky.sticky },
    };
  }

  // Nested filter.if = (...). Recognize the prefix before the `=` so
  // we route correctly.
  if (/^filter\.if\s*=/.test(text)) {
    const eqIdx = text.indexOf("=");
    const rhs = text.slice(eqIdx + 1).trim();
    const r = parseFilterIfRhs(rhs);
    if (!r.ok) return { ok: false, error: `nested filter.if: ${r.error}` };
    return {
      ok: true,
      statement: { kind: "nested", directive: r.directive, sticky: sticky.sticky },
    };
  }

  // rules.<key> = <expr> assignment. The `=` MUST be the top-level one
  // (not buried inside a comparison `==` in the RHS) so we walk the
  // string once with paren/quote awareness — same shape as the outer
  // line parser. We stop at the first standalone `=` that isn't part
  // of a `==`, `!=`, `<=`, `>=`.
  const eqIdx = findTopLevelAssignmentEq(text);
  if (eqIdx < 0) {
    return {
      ok: false,
      error: `expected one of: pass, reject, print(...), rules.X = expr, filter.if = (...) — got "${text}"`,
    };
  }
  const path = text.slice(0, eqIdx).trim();
  const rhs = text.slice(eqIdx + 1).trim();
  if (!path.startsWith("rules.")) {
    return {
      ok: false,
      error: `assignments inside filter.if must target rules.* (got "${path}"). Use top-level filters.* / params.* lines for run-wide config; filter.if rule overrides apply per-trade only.`,
    };
  }
  const key = path.slice("rules.".length);
  if (!NUMERIC_RULE_KEYS.has(key as keyof import("./zone-simulator").SimRules)) {
    return {
      ok: false,
      error: `rules.${key}: not a numeric rule field (or not yet supported as a per-trade override). Allowed: ${[...NUMERIC_RULE_KEYS].join(", ")}`,
    };
  }
  const nv = parseNumericValue(rhs);
  if (!nv.ok) return { ok: false, error: `${path}: ${nv.error}` };
  if (nv.value.kind === "optimize") {
    return {
      ok: false,
      error: `${path}: Optimize.X.Y(...) inside filter.if isn't supported. Use Optimize at the top level (e.g. \`rules.${key} = Optimize.EV.trades(...)\`) and let filter.if select among already-resolved values.`,
    };
  }
  return {
    ok: true,
    statement: { kind: "assignment", path, value: nv.value, sticky: sticky.sticky },
  };
}

/** Walk `text` once and return the index of the FIRST `=` that's not
 *  part of a multi-char operator (==, !=, <=, >=). Skips characters
 *  inside `()` and inside double-quoted strings. Returns -1 if none. */
function findTopLevelAssignmentEq(text: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (c === '"' && prev !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (c === "=") {
      // Skip `==` (next char is also `=`), `!=`, `<=`, `>=` (prev is op).
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (next === "=") {
        i++; // skip both
        continue;
      }
      if (prev === "!" || prev === "<" || prev === ">") continue;
      return i;
    }
  }
  return -1;
}

/** Parse a slot's worth of statements (the if_true or if_false section).
 *  Empty slot → empty array (caller treats as "use default verdict").
 *  Returns the parsed list plus any errors encountered (caller maps
 *  these onto the script line via the line-number wrapper). */
function parseFilterIfStatementList(
  slot: string
): { ok: true; statements: FilterIfStatement[] } | { ok: false; error: string } {
  const trimmed = slot.trim();
  if (trimmed === "") return { ok: true, statements: [] };
  const pieces = splitTopLevel(trimmed, ";");
  const out: FilterIfStatement[] = [];
  for (const piece of pieces) {
    const t = piece.trim();
    if (t === "") continue; // tolerate trailing `;` or `;;`
    const r = parseFilterIfStatement(t);
    if (!r.ok) return { ok: false, error: r.error };
    out.push(r.statement);
  }
  return { ok: true, statements: out };
}

/** Walk a parsed filter.if directive (recursively into nested ones) and
 *  collect a warning string for every `sticky(N>0)` modifier. The v1
 *  runtime treats sticky as a no-op but accepts the syntax so users
 *  can write the script the way they'll eventually run it. */
function collectStickyWarnings(d: FilterIfDirective): string[] {
  const out: string[] = [];
  function walkStatements(stmts: FilterIfStatement[], path: string): void {
    for (const s of stmts) {
      if (s.sticky !== undefined && s.sticky > 0) {
        out.push(
          `sticky(${s.sticky}) modifier in ${path} is parsed but not yet implemented at runtime — the statement applies to this trade only for now.`
        );
      }
      if (s.kind === "nested") {
        walkStatements(s.directive.ifTrue, `${path} → nested if_true`);
        walkStatements(s.directive.ifFalse, `${path} → nested if_false`);
      }
    }
  }
  walkStatements(d.ifTrue, "if_true");
  walkStatements(d.ifFalse, "if_false");
  return out;
}

/** Returns true iff the leading `(` and trailing `)` of `text` are a
 *  matched pair that wraps the ENTIRE string (i.e. the depth-0 close
 *  lands exactly at the last char). Catches the trap where a string
 *  like `(a) || (b)` starts with `(` and ends with `)` but those
 *  aren't an outer pair — the first `(` closes mid-string and the
 *  final `)` is the close of a different group. Without this check,
 *  the filter.if parser would strip those non-matching outer chars and
 *  hand a corrupted expression to compileExpr. Quote-aware so a
 *  `print(x, "label)")` style label doesn't confuse depth tracking. */
function parensWrapEntireString(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (c === '"' && prev !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      // The leading `(` closes BEFORE the last char → the outer parens
      // we'd strip aren't a balanced wrap. Bail.
      if (depth === 0 && i < text.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Find the closing `"` of a double-quoted string starting at index
 *  `start`. Honors `\"` and `\\` escape sequences (the only ones the
 *  rest of the parser handles). Returns -1 if no terminator. */
function findStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== "\\") return i;
  }
  return -1;
}

/** Scan `text` for inline `Optimize.<Obj>.<Unit>(...)` calls and rewrite
 *  each into a synthetic var ident (`__opt_<n>__`). Each lifted spec
 *  lands in `config.optimizeOverrides["var.<name>"]` so the online
 *  optimizer drives it like any explicit `var <name> = ...` declaration.
 *
 *  Why lift at parse time: the expression tokenizer's identifier regex
 *  doesn't allow `.`, so `Optimize.DailyEV.trades(...)` is a tokenization
 *  error inside any expression. By rewriting it to a clean ident BEFORE
 *  reaching compileExpr, the user gets to write inline Optimize in
 *  filter.if conditions without first declaring a var on its own line.
 *
 *  Lifting is paren-aware (commas inside Optimize args don't terminate
 *  the call) and string-aware (an `Optimize.` substring inside a quoted
 *  print label is left alone). Only fires on `Optimize.` preceded by a
 *  non-identifier char so `MyOptimize.X` won't false-match. */
function liftInlineOptimize(
  text: string,
  config: PartialBacktestConfig,
  counter: { n: number }
): { ok: true; text: string } | { ok: false; error: string } {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // Skip over string literals so quoted text doesn't get scanned.
    if (text[i] === '"') {
      const end = findStringEnd(text, i);
      if (end < 0) {
        // Unterminated string — let the downstream parser flag it. Pass
        // through verbatim.
        out += text.slice(i);
        break;
      }
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    // Match `Optimize.` only at an identifier boundary (preceding char
    // is NOT an ident char). Case-insensitive — the user might type
    // `optimize.dailyev.trades` and parseOptimizeSpec already tolerates
    // lowercase.
    const atIdentStart = i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]);
    if (
      atIdentStart &&
      i + 9 <= text.length &&
      text.slice(i, i + 9).toLowerCase() === "optimize."
    ) {
      // Walk to the opening paren.
      let j = i;
      while (j < text.length && text[j] !== "(") j++;
      if (j === text.length) {
        return {
          ok: false,
          error: `inline Optimize at position ${i}: expected "(" after "Optimize.<Obj>.<Unit>"`,
        };
      }
      // Balance parens (ignoring `(` `)` inside string literals).
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
        return {
          ok: false,
          error: `inline Optimize at position ${i}: unbalanced parens`,
        };
      }
      // Extend the captured slice over any trailing `smooth <N>` /
      // `smooth(<N>)` / `default <num>` / `default(<num>)` clauses so the
      // whole Optimize directive — including its modifiers — is replaced
      // by the synthetic ident. Otherwise modifiers are left dangling in
      // the expression text and the downstream tokenizer chokes on them
      // ("unexpected trailing tokens after expression"). Either order is
      // accepted, up to two passes — matches parseOptimizeSpec's own
      // trailing-clause handling. The numeric-literal patterns mirror
      // parseOptimizeSpec exactly so anything that parser would accept
      // here gets swallowed up cleanly.
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
          if (m) {
            k += m[0].length;
            sawSmooth = true;
            continue;
          }
        }
        if (!sawDefault) {
          const m = tail.match(DEFAULT_PAREN) || tail.match(DEFAULT_BARE);
          if (m) {
            k += m[0].length;
            sawDefault = true;
            continue;
          }
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
      const name = `__opt_${counter.n++}__`;
      config.optimizeOverrides ??= {};
      config.optimizeOverrides[`var.${name}`] = r.spec;
      out += name;
      i = k;
    } else {
      out += text[i];
      i++;
    }
  }
  return { ok: true, text: out };
}

/** Parse the RHS of a `filter.if = ...` line. Two shapes:
 *    - Single-arg: `<bool-expression>`         → cond only, default branches
 *    - 3-arg:      `(<cond>, <if_true>, <if_false>)` (slots may be empty)
 *  The 2-arg form `(<cond>, <if_true>)` is also accepted; if_false is
 *  treated as omitted. */
export function parseFilterIfRhs(
  rhs: string
): { ok: true; directive: FilterIfDirective } | { ok: false; error: string } {
  const trimmed = rhs.trim();
  if (trimmed === "") return { ok: false, error: "empty filter.if RHS" };

  // 3-arg form requires the WHOLE expression to be wrapped in a single
  // matched pair of parens. Anything else — bare expression, or an
  // expression like `(a) || (b)` whose outer chars happen to be parens
  // that DON'T form a balanced wrap — falls through to the single-arg
  // path. parensWrapEntireString handles the depth-0-mid-string trap.
  if (!parensWrapEntireString(trimmed)) {
    const c = compileExpr(trimmed);
    if (!c.ok) return { ok: false, error: c.error };
    return {
      ok: true,
      directive: {
        source: trimmed,
        cond: c.expr,
        ifTrue: [],
        ifFalse: [],
        ifTrueDefined: false,
        ifFalseDefined: false,
      },
    };
  }

  // Outer parens are a balanced wrap — strip them and split on
  // top-level commas. If the result is a single piece, the parens were
  // just grouping — treat as single-arg.
  const inner = trimmed.slice(1, -1);
  const pieces = splitTopLevel(inner, ",");
  if (pieces.length === 1) {
    // Just a parenthesized single-arg expression — strip the parens
    // and recurse on the inner text.
    return parseFilterIfRhs(pieces[0]);
  }
  if (pieces.length > 3) {
    return {
      ok: false,
      error: `filter.if: expected (cond, if_true, if_false) — got ${pieces.length} args`,
    };
  }
  const condPart = pieces[0].trim();
  if (condPart === "") return { ok: false, error: "filter.if: missing condition" };
  const c = compileExpr(condPart);
  if (!c.ok) return { ok: false, error: `filter.if cond: ${c.error}` };

  const ifTruePart = pieces.length >= 2 ? pieces[1] : "";
  const ifFalsePart = pieces.length >= 3 ? pieces[2] : "";
  const ifTrueDefined = pieces.length >= 2;
  const ifFalseDefined = pieces.length >= 3;

  const tList = parseFilterIfStatementList(ifTruePart);
  if (!tList.ok) return { ok: false, error: `filter.if if_true: ${tList.error}` };
  const fList = parseFilterIfStatementList(ifFalsePart);
  if (!fList.ok) return { ok: false, error: `filter.if if_false: ${fList.error}` };

  return {
    ok: true,
    directive: {
      source: trimmed,
      cond: c.expr,
      ifTrue: tList.statements,
      ifFalse: fList.statements,
      ifTrueDefined,
      ifFalseDefined,
    },
  };
}

/** Walk every Expr referenced by a ScriptOverlay, recursing through
 *  nested filter.if directives. Covers numericOverrides (rules.* RHS),
 *  tradePrints (ontrade.print RHS), Optimize bound expressions
 *  (min/max/step), and filter.if cond + per-branch assignment / print
 *  RHS + nested filter.if. Centralized so the engine's indicator
 *  precompute, the dashboard's filter-sim precompute, and the warmup-
 *  window sizer all walk the same set without drifting. */
export function collectOverlayExprs(
  overlay: import("./zone-simulator").ScriptOverlay
): Expr[] {
  const out: Expr[] = [];
  if (overlay.numericOverrides) {
    for (const path of Object.keys(overlay.numericOverrides)) {
      const nv = overlay.numericOverrides[path];
      if (nv.kind === "expr") out.push(nv.expr);
    }
  }
  if (overlay.tradePrints) {
    for (const p of overlay.tradePrints) out.push(p.expr);
  }
  if (overlay.optimizeOverrides) {
    for (const path of Object.keys(overlay.optimizeOverrides)) {
      const spec = overlay.optimizeOverrides[path];
      if (spec.kind === "optimize-numeric") {
        out.push(spec.min.expr);
        out.push(spec.max.expr);
        if (spec.step) out.push(spec.step.expr);
      }
    }
  }
  if (overlay.filterIfs) {
    const walkStmts = (stmts: FilterIfStatement[]): void => {
      for (const s of stmts) {
        if (s.kind === "assignment" && s.value.kind === "expr") {
          out.push(s.value.expr);
        } else if (s.kind === "print") {
          out.push(s.directive.expr);
        } else if (s.kind === "nested") {
          walkDirective(s.directive);
        }
      }
    };
    const walkDirective = (d: FilterIfDirective): void => {
      out.push(d.cond);
      walkStmts(d.ifTrue);
      walkStmts(d.ifFalse);
    };
    for (const d of overlay.filterIfs) walkDirective(d);
  }
  return out;
}

/** Walk the dotted path on `cfg` and stamp `value`. Creates the intermediate
 *  branches lazily. Tightly coupled to BacktestConfig's known top-level
 *  branches so the type narrowing stays sound. */
function setConfigPath(
  cfg: PartialBacktestConfig,
  path: string,
  value: unknown
): void {
  const segs = path.split(".");
  // Top-level OptimizeAll directive — boolean-valued, lands directly on
  // the partial config so the worker can read it without rummaging
  // through filters/rules.
  if (path === "OptimizeAll") {
    cfg.optimizeAll = value as boolean;
    return;
  }
  if (path === "Warmup") {
    cfg.warmup = value as boolean;
    return;
  }
  if (segs[0] === "strategy" && segs.length === 1) {
    cfg.strategy = value as string;
    return;
  }
  if (segs[0] === "params" && segs.length === 2) {
    cfg.params ??= {};
    cfg.params[segs[1]] = value as number;
    return;
  }
  if (segs[0] === "rules" && segs.length === 2) {
    cfg.rules ??= {};
    (cfg.rules as Record<string, unknown>)[segs[1]] = value;
    return;
  }
  if (segs[0] === "filters" && segs.length >= 3) {
    cfg.filters ??= {};
    const group = segs[1] as keyof NonNullable<PartialBacktestConfig["filters"]>;
    const leaf = segs.slice(2).join(".");
    const filters = cfg.filters as Record<string, Record<string, unknown>>;
    filters[group] ??= {};
    filters[group][leaf] = value;
    return;
  }
}

/** Rewrite the script source so a `loadstrategy = X` line materializes
 *  as a real `strategy = "X"` line plus the new strategy's full default
 *  params.* block, replacing whatever strategy/loadstrategy/params.*
 *  lines were there before. Caller (the dashboard's Run handler) writes
 *  the new text back to the editor so the user SEES the swap, not just
 *  the runtime effect.
 *
 *  Behavior:
 *   - The loadstrategy line is removed; an existing `strategy = ...`
 *     line is removed too. The new `strategy = "X"` plus params block
 *     lands at the position of whichever line came first (preferring
 *     `strategy = ...` so a sectioned script's structure survives).
 *   - All `params.*` lines are removed and replaced with the new
 *     strategy's full paramFields list, in the order the strategy
 *     declares them (matches Sync from UI's serializer).
 *   - rules.*, filters.*, comments, blank lines, print/Optimize
 *     directives — all preserved verbatim.
 *   - When multiple loadstrategy lines exist, the LAST one's strategy
 *     id wins (consistent with the parser's hoisted pre-pass).
 *
 *  Return shape:
 *   - null when no loadstrategy line is present (no rewrite needed).
 *   - { ok: true, text, strategyId, paramCount } on success.
 *   - { ok: false, error, line } when every loadstrategy line is
 *     malformed — caller surfaces the message + line number to the
 *     editor's error gutter and skips the rewrite. */
export function applyLoadStrategyRewrite(
  text: string
):
  | { ok: true; text: string; strategyId: string; paramCount: number }
  | { ok: false; error: string; line: number }
  | null {
  const lines = text.split(/\r?\n/);

  // Pass 1: scan for loadstrategy + existing strategy lines. The last
  // valid loadstrategy id wins. If every loadstrategy line is
  // malformed, capture the most recent parse error to return.
  const loadStrategyIndices: number[] = [];
  const strategyLineIndices: number[] = [];
  let strategyId: string | null = null;
  let parseError: { error: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripInlineComment(lines[i]).trim();
    if (stripped === "") continue;
    if (stripped.startsWith("//") || stripped.startsWith("#")) continue;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx < 0) continue;
    const path = stripped.slice(0, eqIdx).trim();

    if (path === "loadstrategy") {
      loadStrategyIndices.push(i);
      const rhs = stripped.slice(eqIdx + 1).trim();
      const allowed = STRATEGIES.map((s) => s.id);
      const r = parseEnumValue(rhs, allowed);
      if (!r.ok) {
        parseError = { error: `loadstrategy: ${r.error}`, line: i + 1 };
        continue;
      }
      if (r.value.kind !== "literal") {
        parseError = {
          error: `loadstrategy: Optimize.X.Y(...) is not allowed — strategy id must be a literal`,
          line: i + 1,
        };
        continue;
      }
      strategyId = r.value.value;
      parseError = null; // a valid id wipes prior error
    } else if (path === "strategy") {
      strategyLineIndices.push(i);
    }
  }

  if (loadStrategyIndices.length === 0) return null;
  if (strategyId === null) {
    return {
      ok: false,
      error: parseError?.error ?? "loadstrategy: invalid",
      line: parseError?.line ?? loadStrategyIndices[0] + 1,
    };
  }

  const found = STRATEGIES.find((s) => s.id === strategyId);
  if (!found) {
    // parseEnumValue should have caught this, but be defensive in case
    // the strategy registry diverges from the schema's options list.
    return {
      ok: false,
      error: `loadstrategy: unknown strategy "${strategyId}"`,
      line: (loadStrategyIndices.at(-1) ?? 0) + 1,
    };
  }

  // Anchor: where the new strategy + params block lands. Prefer an
  // existing `strategy = ...` line so the script's section ordering
  // (e.g. "// ── Strategy ──" header right above) is preserved. Fall
  // back to the first loadstrategy line when there's no strategy line.
  const anchorIdx =
    strategyLineIndices.length > 0
      ? strategyLineIndices[0]
      : loadStrategyIndices[0];

  // Lines to drop: every strategy / loadstrategy line (anchor included
  // — we replace it with the new block via the explicit branch below).
  const dropSet = new Set<number>();
  for (const i of loadStrategyIndices) dropSet.add(i);
  for (const i of strategyLineIndices) dropSet.add(i);

  // Build the new block: `strategy = "X"` followed by every paramField
  // in the strategy's declared order. Params are always int/float, so
  // String() formats them correctly without the schema-aware
  // formatValue overhead.
  const defaults = defaultParamsFor(found);
  const newBlock: string[] = [`strategy = "${strategyId}"`];
  for (const f of found.paramFields) {
    newBlock.push(`params.${f.key} = ${String(defaults[f.key])}`);
  }

  // Pass 2: emit lines. Replace the anchor with newBlock; drop every
  // other strategy / loadstrategy line; drop every params.* line
  // (covered by newBlock).
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === anchorIdx) {
      for (const b of newBlock) out.push(b);
      continue;
    }
    if (dropSet.has(i)) continue;

    const stripped = stripInlineComment(lines[i]).trim();
    if (stripped !== "" && !stripped.startsWith("//") && !stripped.startsWith("#")) {
      const eqIdx = stripped.indexOf("=");
      if (eqIdx >= 0) {
        const path = stripped.slice(0, eqIdx).trim();
        if (path.startsWith("params.")) continue;
      }
    }

    out.push(lines[i]);
  }

  return {
    ok: true,
    text: out.join("\n"),
    strategyId,
    paramCount: found.paramFields.length,
  };
}

// ─── Var-binding substitution helpers ─────────────────────────────────────
//
// `var <name> = <RHS>` declarations are positionally scoped: a reference
// to `<name>` on a later line uses the most recent definition above it.
// We implement that by maintaining a `bindings: Map<string, Expr>` that
// evolves as the parse loop walks lines top-to-bottom. After each
// expression-bearing construct is parsed (numeric value, optimize spec,
// filter.if directive, print directive), we walk the result and apply
// the *current* bindings — baking the active definition into the AST so
// later redefinitions can't retroactively change earlier references.
//
// All four helpers below are pure and bottom-up: each calls applyBindings
// on the leaf Exprs and rebuilds the wrapping struct. No-op (returns the
// input) when bindings is empty, so this layer adds no overhead to scripts
// that don't use vars.

/** Apply bindings to every Expr inside a NumericValue. Literals pass
 *  through; expr/optimize values get their inner Exprs rewritten. */
function applyBindingsToNumericValue(nv: NumericValue, bindings: Map<string, Expr>): NumericValue {
  if (bindings.size === 0) return nv;
  switch (nv.kind) {
    case "literal":
      return nv;
    case "expr":
      return { ...nv, expr: applyBindings(nv.expr, bindings) };
    case "optimize":
      return { ...nv, spec: applyBindingsToOptimizeSpec(nv.spec, bindings) };
  }
}

/** Apply bindings to OptimizeSpec's bound exprs (min/max/step). Categorical
 *  options are static literals — nothing to rewrite there. */
function applyBindingsToOptimizeSpec(spec: OptimizeSpec, bindings: Map<string, Expr>): OptimizeSpec {
  if (bindings.size === 0) return spec;
  if (spec.kind === "optimize-categorical") return spec;
  return {
    ...spec,
    min: { source: spec.min.source, expr: applyBindings(spec.min.expr, bindings) },
    max: { source: spec.max.source, expr: applyBindings(spec.max.expr, bindings) },
    step:
      spec.step === undefined
        ? undefined
        : { source: spec.step.source, expr: applyBindings(spec.step.expr, bindings) },
  };
}

/** Apply bindings to a PrintDirective's expression. */
function applyBindingsToPrintDirective(d: PrintDirective, bindings: Map<string, Expr>): PrintDirective {
  if (bindings.size === 0) return d;
  return { ...d, expr: applyBindings(d.expr, bindings) };
}

/** Apply bindings to every Expr inside a FilterIfDirective — the cond,
 *  every assignment/print/nested statement in either branch. Recursion
 *  handles arbitrarily nested filter.if. */
function applyBindingsToFilterIf(d: FilterIfDirective, bindings: Map<string, Expr>): FilterIfDirective {
  if (bindings.size === 0) return d;
  const rewriteList = (list: FilterIfStatement[]): FilterIfStatement[] =>
    list.map((s) => {
      switch (s.kind) {
        case "assignment":
          return { ...s, value: applyBindingsToNumericValue(s.value, bindings) };
        case "print":
          return { ...s, directive: applyBindingsToPrintDirective(s.directive, bindings) };
        case "verdict":
          return s;
        case "nested":
          return { ...s, directive: applyBindingsToFilterIf(s.directive, bindings) };
      }
    });
  return {
    ...d,
    cond: applyBindings(d.cond, bindings),
    ifTrue: rewriteList(d.ifTrue),
    ifFalse: rewriteList(d.ifFalse),
  };
}

/** Walk an Expr AST and return the subset of bare-ident names that map
 *  to entries in `optimizeOverrides` under the `var.<name>` prefix.
 *  Used to compute the var-name dependencies of a filter.if cond so
 *  the runtime can skip the directive while any of those vars is
 *  unresolved (pre-warmup, no default clause). Names like `__opt_0__`
 *  (inline-lifted Optimize calls) and `rsiLow__r0` (var declaration
 *  with revision suffix) are both keys in `optimizeOverrides` after
 *  the binding pass, so this lookup catches both forms uniformly. */
function collectReferencedVarNames(
  expr: Expr,
  optimizeOverrides: Record<string, OptimizeSpec> | undefined
): Set<string> {
  if (!optimizeOverrides) return new Set();
  const out = new Set<string>();
  const refs = referencedSymbols(expr);
  for (const ident of refs.idents) {
    if (optimizeOverrides[`var.${ident}`]) out.add(ident);
  }
  return out;
}

/** Reserved bare identifiers that cannot be shadowed by a `var`. Bar
 *  fields, bar-shape scalars, tick-config, and zero-arg cumulative
 *  indicators. Indicator-period aliases (ATR, EMA20, …) ARE allowed to
 *  be shadowed — picking those names is taken as intentional. */
const VAR_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "open", "high", "low", "close", "volume", "bar_index", "direction",
  "range", "body", "upper_wick", "lower_wick", "typical", "median_price", "weighted_close",
  "ticksPerPoint", "pointValue", "tickValue",
  "OBV", "AD", "TR",
  // Reserve the if-expression keywords so the parser never mis-tokenizes
  // a `var if = ...` line into something surprising.
  "if", "then", "else",
]);

/** Top-level parse. Splits on \n, walks each line, returns the partial
 *  config + error list. Designed so that even a totally wrong line doesn't
 *  block everything else from applying — debugger-friendly. */
export function parseBacktestScript(text: string): ParseResult {
  const config: PartialBacktestConfig = {};
  const errors: ScriptError[] = [];

  // Active variable bindings — evolves as we walk lines top-to-bottom.
  // For Expr-RHS vars, the value is the (already-substituted) Expr to
  // inline at reference sites. For Optimize-RHS vars, the value is a
  // synthetic ident node whose name is the runtime varValues key — so
  // the existing online-optimizer plumbing resolves it without changes.
  const bindings = new Map<string, Expr>();
  // Monotonic counter for Optimize-RHS var revisions. Each `var <name> =
  // Optimize.X.Y(...)` declaration gets a fresh revision so multiple
  // definitions of the same name become INDEPENDENT optimizer parameters
  // (different bounds → different search ranges → different best values).
  let optVarRev = 0;
  // Counter for inline-lifted Optimize calls. Each `Optimize.X.Y(...)`
  // appearing inside a filter.if expression (or other expression
  // contexts that lift) is rewritten to a synthetic `__opt_<n>__`
  // ident and registered in optimizeOverrides so users can write the
  // optimization spec inline without a separate var declaration.
  const inlineOptimizeCounter = { n: 0 };

  const lines = text.split(/\r?\n/);

  // ── Hoisted pre-pass: loadstrategy ─────────────────────────────────
  // Scan the whole script for `loadstrategy = X` lines BEFORE the main
  // pass so the strategy + its default params land in the partial
  // config first. This makes the directive position-independent — a
  // user can put it at the top, bottom, or middle and any params.*
  // lines elsewhere will override the loaded defaults. Multiple
  // loadstrategy lines: last one wins (consistent with how repeated
  // assignments behave in the main pass). Errors here surface on the
  // line where the bad value lives.
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const stripped = stripInlineComment(lines[i]).trim();
    if (stripped === "") continue;
    if (stripped.startsWith("//") || stripped.startsWith("#")) continue;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx < 0) continue;
    const path = stripped.slice(0, eqIdx).trim();
    if (path !== "loadstrategy") continue;
    const rhs = stripped.slice(eqIdx + 1).trim();
    // Reuse parseEnumValue so users can write either `loadstrategy =
    // signal_v2` (bare identifier) or `loadstrategy = "signal_v2"`
    // (quoted) — both forms work for the regular `strategy = ...` enum
    // path, and we want loadstrategy to feel identical.
    const allowed = STRATEGIES.map((s) => s.id);
    const r = parseEnumValue(rhs, allowed);
    if (!r.ok) {
      errors.push({ line: lineNo, message: `loadstrategy: ${r.error}`, severity: "error" });
      continue;
    }
    if (r.value.kind !== "literal") {
      errors.push({
        line: lineNo,
        message: `loadstrategy: Optimize.X.Y(...) is not allowed — strategy id must be a literal because it controls which params dict gets seeded.`,
        severity: "error",
      });
      continue;
    }
    const strategyId = r.value.value;
    const found = STRATEGIES.find((s) => s.id === strategyId);
    // parseEnumValue already validated against `allowed`, so `found`
    // should always be defined here. The check is defensive — keeps
    // the type narrow and guards against a future refactor that
    // skews the two lists.
    if (!found) {
      errors.push({
        line: lineNo,
        message: `loadstrategy: unknown strategy "${strategyId}" — must be one of {${allowed.join("|")}}`,
        severity: "error",
      });
      continue;
    }
    config.strategy = strategyId;
    config.params = defaultParamsFor(found);
    config.replaceParams = true;
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const stripped = stripInlineComment(lines[i]).trim();
    if (stripped === "") continue;
    if (stripped.startsWith("//") || stripped.startsWith("#")) continue;

    const eqIdx = stripped.indexOf("=");
    if (eqIdx < 0) {
      errors.push({
        line: lineNo,
        message: `expected "path = value" (no '=' found)`,
        severity: "error",
      });
      continue;
    }
    const path = stripped.slice(0, eqIdx).trim();
    const rhs = stripped.slice(eqIdx + 1).trim();
    if (path === "") {
      errors.push({ line: lineNo, message: "missing path before '='", severity: "error" });
      continue;
    }

    // loadstrategy was already applied in the hoisted pre-pass above.
    // Drop the line silently here so it doesn't go through the regular
    // enum coercion path (which would set cfg.strategy a SECOND time
    // via setConfigPath, racing the pre-pass and re-merging stale
    // params if the strategy field appears later in the script).
    if (path === "loadstrategy") continue;

    // If loadstrategy ran in the pre-pass, an additional `strategy = X`
    // line in the main pass would silently desync strategy from params
    // (params reset to loadstrategy's defaults but strategy points at a
    // different one). Honor loadstrategy as the authoritative pick and
    // surface a warning so the user notices the conflict.
    if (path === "strategy" && config.replaceParams) {
      errors.push({
        line: lineNo,
        message: `strategy = ... ignored: loadstrategy elsewhere in this script already set the strategy. Remove one of the two lines to clear this warning.`,
        severity: "warning",
      });
      continue;
    }

    // ── `var <name> = <RHS>` — declare a positionally-scoped variable
    // usable as a bare ident anywhere a number is accepted: filter.if
    // condition, rules.* RHS, params.*/filters.* numerics (when the
    // resolved value is constant-foldable), Optimize bounds, prints,
    // function args (`RSI(myVar)`), and other vars' RHS.
    //
    // RHS forms:
    //   - **literal** (`var x = 14`): bound to a num node, inlined
    //     wherever `x` appears below this line.
    //   - **expression** (`var x = ATR + 5`, `var x = if close > open
    //     then 30 else 50`): RHS is parsed, *current bindings applied*
    //     (so it captures earlier vars / earlier defs of itself), then
    //     the resulting Expr is bound. Inlined at reference sites.
    //   - **Optimize.X.Y(...)**: each declaration gets a fresh revision
    //     suffix (`var.<name>__r<rev>`) and is registered in
    //     optimizeOverrides as an independent optimizer parameter.
    //     References below get rewritten to the synthetic ident
    //     `<name>__r<rev>`, which the runtime resolves via the existing
    //     `varValues` map populated by varValuesFrom() in the online
    //     optimizer. Two `var x = Optimize…` lines with different
    //     bounds become two distinct parameters — exactly what the
    //     user wants for "redefine to give later code a different
    //     range."
    //
    // Redefinition is silent: no warning, no error. Each `var <name>
    // = …` line replaces the binding from that point forward — earlier
    // references already have the previous definition baked in.
    if (/^var\s+/.test(path)) {
      const name = path.replace(/^var\s+/, "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push({
          line: lineNo,
          message: `var: name "${name}" must be a valid identifier (letters/digits/underscore, can't start with a digit)`,
          severity: "error",
        });
        continue;
      }
      if (VAR_RESERVED_NAMES.has(name)) {
        errors.push({
          line: lineNo,
          message: `var: name "${name}" collides with a reserved identifier (bar fields / bar-shape scalars / tick config / cumulative indicators / if-expression keywords). Pick a different name.`,
          severity: "error",
        });
        continue;
      }
      const parsed = parseNumericValue(rhs);
      if (!parsed.ok) {
        errors.push({
          line: lineNo,
          message: `var ${name}: ${parsed.error}`,
          severity: "error",
        });
        continue;
      }
      if (parsed.value.kind === "literal") {
        // Literal RHS — bind directly to a num node so reference sites
        // inline the constant (and constant-folding in non-rules paths
        // works without any runtime machinery).
        bindings.set(name, { kind: "num", value: parsed.value.value });
        continue;
      }
      if (parsed.value.kind === "expr") {
        // Expression RHS — apply CURRENT bindings before storing, so
        // the bound Expr captures whatever the active definitions
        // were at this line. Future references to other vars in this
        // expression will already be resolved. A self-reference
        // (`var x = x + 1` after an earlier `var x = 5`) picks up the
        // PREVIOUS x — natural increment-style semantics.
        let bound = applyBindings(parsed.value.expr, bindings);
        // Opportunistic constant-fold: if the substituted expression
        // evaluates finitely against an empty summary context, it has
        // no bar/indicator/optimizer dependencies — collapse it to a
        // num node so downstream uses in params.*/filters.* (which
        // require constants) work transparently. `var x = 10 + 5` →
        // 15; `var x = if 1 then 30 else 50` → 30.
        const folded = evaluateExpr(bound, { kind: "summary", symbols: {} });
        if (Number.isFinite(folded)) {
          bound = { kind: "num", value: folded };
        }
        bindings.set(name, bound);
        continue;
      }
      // Optimize RHS.
      if (parsed.value.spec.kind === "optimize-categorical") {
        errors.push({
          line: lineNo,
          message: `var ${name}: categorical Optimize on a var declaration isn't supported (no enum to coerce against). Use Optimize.X.Y(lookback, min, max[, step]).`,
          severity: "error",
        });
        continue;
      }
      // Each Optimize-RHS declaration gets a fresh revision suffix so
      // redefinitions become independent optimizer parameters. Apply
      // bindings to the bound exprs (min/max/step) so they too can
      // reference earlier vars (`var hi = 100; var x =
      // Optimize.DailyEV.trades(30, 10, hi)` works).
      const rev = optVarRev++;
      const synthName = `${name}__r${rev}`;
      const synthPath = `var.${synthName}`;
      const reboundSpec = applyBindingsToOptimizeSpec(parsed.value.spec, bindings);
      config.optimizeOverrides ??= {};
      config.optimizeOverrides[synthPath] = reboundSpec;
      // Bind <name> → ident(<synthName>) so references rewrite to the
      // runtime varValues key, which varValuesFrom strips from the
      // synthetic path (var.<synthName> → key <synthName>).
      bindings.set(name, { kind: "ident", name: synthName });
      continue;
    }

    const entry = SCHEMA_BY_PATH.get(path);
    if (!entry) {
      errors.push({
        line: lineNo,
        message: `unknown path "${path}" — no such variable`,
        severity: "warning",
      });
      continue;
    }

    // ── Directive paths (print / ontrade.print / filter.if) — separate
    // path because their RHS isn't a value literal. Multiple lines per
    // path accumulate into an array. filter.if has its own RHS shape
    // (cond + branches) so it dispatches to a different parser.
    if (entry.type === "directive") {
      if (path === "filter.if") {
        // Lift any inline `Optimize.X.Y(...)` calls in the RHS to
        // synthetic var idents so the expression tokenizer (which
        // can't handle `.` inside identifiers) sees clean names.
        // Each lifted spec is registered in optimizeOverrides under
        // a `var.__opt_<n>__` path; the online optimizer drives it
        // like any explicit var declaration. Lifting is paren-aware
        // and string-aware — see liftInlineOptimize for details.
        const lifted = liftInlineOptimize(rhs, config, inlineOptimizeCounter);
        if (!lifted.ok) {
          errors.push({ line: lineNo, message: `filter.if: ${lifted.error}`, severity: "error" });
          continue;
        }
        const r = parseFilterIfRhs(lifted.text);
        if (!r.ok) {
          errors.push({ line: lineNo, message: `filter.if: ${r.error}`, severity: "error" });
          continue;
        }
        // Sticky modifier is parsed but the v1 runtime only honors
        // `sticky(0)` (the default — this trade only). Surface a
        // warning for any non-zero sticky so users know the directive
        // is accepted but the cross-trade behavior is deferred.
        const stickyWarn = collectStickyWarnings(r.directive);
        for (const w of stickyWarn) {
          errors.push({ line: lineNo, message: `filter.if: ${w}`, severity: "warning" });
        }
        config.filterIfs ??= [];
        // Inline any active var bindings into the cond + every
        // expression inside the action statements (recursively for
        // nested filter.if). Done here, after parseFilterIfRhs, so
        // the runtime sees a fully-resolved tree.
        const bound = applyBindingsToFilterIf(r.directive, bindings);
        // Collect bare-ident names in the cond that resolve to
        // optimizer-driven vars. Used by the online optimizer to skip
        // this directive when any referenced var is unresolved
        // (pre-warmup without a `default <value>` clause). Without
        // this, the directive would NaN-as-fail every signal during
        // warmup and the optimizer would never collect enough trades.
        const referencedVarNames = collectReferencedVarNames(
          bound.cond,
          config.optimizeOverrides
        );
        if (referencedVarNames.size > 0) {
          bound.referencedVarNames = referencedVarNames;
        }
        config.filterIfs.push(bound);
        continue;
      }
      const d = parseDirectiveRhs(rhs);
      if (!d.ok) {
        errors.push({ line: lineNo, message: `${path}: ${d.error}`, severity: "error" });
        continue;
      }
      const bound = applyBindingsToPrintDirective(d.directive, bindings);
      if (path === "print") {
        config.summaryPrints ??= [];
        config.summaryPrints.push(bound);
      } else if (path === "ontrade.print") {
        config.tradePrints ??= [];
        config.tradePrints.push(bound);
      }
      continue;
    }

    // ── Numeric paths get the literal-first / expression-fallback
    // treatment. If the RHS compiles to an expression, behavior depends
    // on the path:
    //   - `rules.*`     : stored in numericOverrides for per-trade
    //                     resolution (can reference bar/indicator data).
    //   - everything else (params.*, filters.*): evaluated ONCE at
    //                     parse time with no per-trade context. This
    //                     supports constant arithmetic like `8-2` or
    //                     `60*5` so users can do quick math in the
    //                     script without flipping back to the UI. Any
    //                     reference to bar fields or indicators in a
    //                     non-rules path returns NaN at parse-time,
    //                     which surfaces as an error.
    if (entry.type === "int" || entry.type === "float") {
      const parsed = parseNumericValue(rhs);
      if (!parsed.ok) {
        errors.push({ line: lineNo, message: parsed.error, severity: "error" });
        continue;
      }
      // Apply any active var bindings before downstream classification —
      // an Expr-RHS var that resolves to a literal lets the constant-
      // fold path below succeed; an Optimize-RHS var leaves a synthetic
      // ident that flows through the per-trade resolution path.
      let resolved: NumericValue = applyBindingsToNumericValue(parsed.value, bindings);
      // Optimize directive — capture the spec keyed by full path. The
      // online optimizer (worker) walks this map at run time. v1 scope:
      // rules.* numeric only. params.* needs a streaming-strategy
      // refactor; filters.* needs the simulator to apply filters
      // per-zone (currently filters live in the dashboard memo). Both
      // are tracked as follow-ups; surface a clear error for now.
      if (resolved.kind === "optimize") {
        if (path.startsWith("params.")) {
          errors.push({
            line: lineNo,
            message: `${path}: Optimize on params.* is not yet supported (would require per-bar strategy regeneration)`,
            severity: "error",
          });
          continue;
        }
        if (path.startsWith("filters.")) {
          errors.push({
            line: lineNo,
            message: `${path}: Optimize on filters.* is not yet supported in this build (rules.* only). Coming in a follow-up.`,
            severity: "error",
          });
          continue;
        }
        config.optimizeOverrides ??= {};
        config.optimizeOverrides[path] = resolved.spec;
        continue;
      }
      if (resolved.kind === "expr") {
        if (path.startsWith("rules.")) {
          config.numericOverrides ??= {};
          config.numericOverrides[path] = resolved;
          continue;
        }
        // Non-rules path: fold the expression to a constant by
        // evaluating with an empty summary symbol table. Constant
        // arithmetic (e.g. `8-2`, `60*5`) collapses to a finite number
        // and we treat it as a literal from here on. Anything that
        // references an identifier or function call hits NaN since the
        // summary context has no symbols and rejects calls — surface
        // that as an error so users know bar/indicator references are
        // a rules.* feature.
        const folded = evaluateExpr(resolved.expr, { kind: "summary", symbols: {} });
        if (!Number.isFinite(folded)) {
          errors.push({
            line: lineNo,
            message: `${path}: expression "${resolved.source}" must be a constant — bar/indicator references are only allowed on rules.* fields`,
            severity: "error",
          });
          continue;
        }
        resolved = { kind: "literal", value: folded };
      }
      // Literal — fall through to the legacy clamp/store path below by
      // re-running coerceForEntry on a synthetic raw value. This keeps
      // existing behavior byte-identical for literal-only scripts. By
      // this point `resolved` is always a literal: either the parser
      // returned a literal directly, or the non-rules expression branch
      // above folded its result and reassigned. TypeScript loses the
      // narrowing across the if-block, so guard explicitly.
      if (resolved.kind !== "literal") continue;
      const literal = resolved.value;
      const coerced = coerceForEntry(literal, entry);
      if (!coerced.ok) {
        errors.push({
          line: lineNo,
          message: `${path}: ${coerced.error}`,
          severity: "error",
        });
        continue;
      }
      const v = coerced.value as number;
      if (entry.min !== undefined && v < entry.min) {
        errors.push({
          line: lineNo,
          message: `${path} = ${v} is below suggested min ${entry.min}`,
          severity: "warning",
        });
      }
      if (entry.max !== undefined && v > entry.max) {
        errors.push({
          line: lineNo,
          message: `${path} = ${v} is above suggested max ${entry.max}`,
          severity: "warning",
        });
      }
      setConfigPath(config, path, v);
      continue;
    }

    // ── Enum paths: literal-or-Optimize handler. Reuses parseEnumValue
    //    which validates options against the schema's allowed list at
    //    parse time, so a categorical Optimize that names an unknown
    //    option fails fast instead of silently misbehaving at run time.
    if (entry.type === "enum") {
      const allowed = entry.options ?? [];
      const r = parseEnumValue(rhs, allowed);
      if (!r.ok) {
        errors.push({ line: lineNo, message: `${path}: ${r.error}`, severity: "error" });
        continue;
      }
      if (r.value.kind === "optimize") {
        // Categorical Optimize on enum fields would require the
        // simulator to apply filters per-zone (currently filters are
        // applied in the dashboard memo before zones reach the
        // simulator). v1 ships with rules.* only — surface a clear
        // error so users know it's deliberate, not a typo.
        errors.push({
          line: lineNo,
          message: `${path}: Optimize on enum fields is not yet supported in this build (rules.* only). Coming in a follow-up.`,
          severity: "error",
        });
        continue;
      }
      // Literal — fall through to the normal setter via setConfigPath.
      setConfigPath(config, path, r.value.value);
      continue;
    }

    // ── Non-numeric, non-directive, non-enum paths: legacy literal pipeline.
    const parsedValue = parseValueLiteral(rhs);
    if (!parsedValue.ok) {
      errors.push({ line: lineNo, message: parsedValue.error, severity: "error" });
      continue;
    }

    const coerced = coerceForEntry(parsedValue.value, entry);
    if (!coerced.ok) {
      errors.push({
        line: lineNo,
        message: `${path}: ${coerced.error}`,
        severity: "error",
      });
      continue;
    }

    setConfigPath(config, path, coerced.value);
  }

  return { config, errors };
}

// ─── Serialization ──────────────────────────────────────────────────────────

/** Emit a string literal using only the escapes parseValueLiteral handles
 *  (\\ and \"). Keeps round-tripping a script through parse → serialize
 *  byte-clean for the common cases. */
function quoteString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatValue(value: unknown, entry: ScriptSchemaEntry): string {
  if (entry.type === "stringArray" && Array.isArray(value)) {
    return `[${value.map((v) => quoteString(String(v))).join(", ")}]`;
  }
  if (entry.type === "boolean") return value ? "true" : "false";
  if (entry.type === "string" || entry.type === "enum") {
    return quoteString(String(value));
  }
  if (entry.type === "int" || entry.type === "float") {
    return String(value);
  }
  return String(value);
}

/** Read the value at `entry.path` from a full config. Returns undefined if
 *  the path isn't populated (e.g. params not for the active strategy). */
function readConfigPath(cfg: BacktestConfig, path: string): unknown {
  const segs = path.split(".");
  let cur: unknown = cfg;
  for (const s of segs) {
    if (cur && typeof cur === "object" && s in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[s];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Loose equality that handles primitives, strings, booleans, and shallow
 *  string-array comparison (the only collection type the schema's
 *  `default` field carries). Used by the serializer to decide whether a
 *  legacyHiddenWhenDefault entry is at its default and thus skippable.
 *  Numeric comparison is exact: schema defaults are integer / round
 *  values written as literals so we don't need a tolerance. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

/** Render a full config as a section-grouped, comment-headed script. Used
 *  to seed the editor with the dashboard's current state on first toggle
 *  into Script mode, and to give the user a "reset to current UI state"
 *  button.
 *
 *  Optional `extras` — when round-tripping a script-mode edit, the caller
 *  passes back the user's previously-parsed `numericOverrides` /
 *  `summaryPrints` / `tradePrints` so they get re-emitted as their
 *  original expression source instead of the resolved literal. Without
 *  extras, only the literal config is serialized (the legacy "Sync from
 *  UI" use case). */
export function serializeBacktestScript(
  cfg: BacktestConfig,
  extras?: {
    numericOverrides?: Record<string, NumericValue>;
    summaryPrints?: PrintDirective[];
    tradePrints?: PrintDirective[];
    /** Optimize directive specs keyed by path — round-tripped as their
     *  original source text so the user's `Optimize.X.Y(...)` line
     *  comes back unchanged after Sync from UI. */
    optimizeOverrides?: Record<string, OptimizeSpec>;
    /** OptimizeAll boolean. Emitted after the last regular line when
     *  any optimize overrides exist (always emitted explicitly so the
     *  user can see what mode they're in even at the default value). */
    optimizeAll?: boolean;
    /** Warmup boolean. Emitted alongside OptimizeAll when any Optimize
     *  overrides exist. Default true (include warmup trades in stats);
     *  emit explicitly only when the user has set false so the script
     *  doesn't acquire spurious lines from the round-trip. */
    warmup?: boolean;
    /** filter.if directives. Round-tripped verbatim via the captured
     *  `source` text — the parser is deterministic on a given source
     *  string so the AST re-builds identically on the next parse. */
    filterIfs?: FilterIfDirective[];
    /** When true AND no `filterIfs` are provided, emit a commented
     *  block of `filter.if = ...` example templates in place of the
     *  legacy filters.* scaffolding that used to dominate the default
     *  script. Used by Load Defaults so users discover the modern
     *  syntax. NOT used by Sync from UI — that path stays a faithful
     *  serialisation of dashboard state with no template injection. */
    includeFilterIfTemplates?: boolean;
  }
): string {
  const out: string[] = [];
  // Section header is held back until we KNOW we're about to push a row
  // for that section. Without this, sections whose every row is hidden
  // (e.g. all `Filters — ADX` entries are at default and marked
  // legacyHiddenWhenDefault) would leave a stray header in the output.
  let lastSection = "";
  let pendingSectionHeader: string | null = null;
  const overrides = extras?.numericOverrides ?? {};
  const optOverrides = extras?.optimizeOverrides ?? {};

  /** Push a value-row, emitting the deferred section header first if we
   *  haven't yet for this section. Centralises the lazy-header dance so
   *  every row-emission code path goes through the same gate. */
  const emit = (line: string): void => {
    if (pendingSectionHeader) {
      if (out.length > 0) out.push("");
      out.push(pendingSectionHeader);
      pendingSectionHeader = null;
    }
    out.push(line);
  };

  for (const entry of SCRIPT_SCHEMA) {
    // Directive paths emit their accumulator at the end of the section
    // pass — handled below the loop. Skip them here.
    if (entry.type === "directive") continue;
    // loadstrategy is a one-shot hoisted directive, not a stored field.
    // The serializer must NEVER emit it: Sync from UI / Load Defaults
    // would otherwise re-emit `loadstrategy = X` and every subsequent
    // Run would silently wipe params back to that strategy's defaults.
    if (entry.path === "loadstrategy") continue;

    if (entry.section !== lastSection) {
      // Cache the header for lazy emission; the next non-skipped row
      // pushes it before its own content.
      pendingSectionHeader = `// ── ${entry.section} ──`;
      lastSection = entry.section;
    }

    // Optimize overlay wins first — its source carries the full
    // Optimize.X.Y(...) text the user typed, which is what we want
    // round-tripped verbatim.
    const optSpec = optOverrides[entry.path];
    if (optSpec) {
      emit(`${entry.path} = ${formatOptimizeSpec(optSpec)}`);
      continue;
    }

    // Expression overlay wins over the literal — preserves the user's
    // original source text when round-tripping.
    const ov = overrides[entry.path];
    if (ov && ov.kind === "expr") {
      emit(`${entry.path} = ${ov.source}`);
      continue;
    }

    const v = readConfigPath(cfg, entry.path);
    if (v === undefined) continue;
    // legacyHiddenWhenDefault entries (replaceable by filter.if) hide
    // when their value matches the schema default. The whole-section
    // commented filter.if examples block at the bottom shows how to
    // express the same gate; we don't want both to clutter Load Defaults
    // output. Any user-changed value diverges from default → emits as
    // usual, so Sync from UI keeps round-tripping faithfully.
    if (entry.legacyHiddenWhenDefault && valuesEqual(v, entry.default)) {
      continue;
    }
    emit(`${entry.path} = ${formatValue(v, entry)}`);
  }
  // Drop any unused trailing pending header so a section whose rows
  // were all suppressed doesn't leak into the output.
  pendingSectionHeader = null;

  // `var <name> = Optimize.X.Y(...)` declarations — stored under the
  // synthetic `var.<name>__r<rev>` path inside optimizeOverrides (each
  // declaration gets a fresh revision so positional shadowing works),
  // never surface in SCRIPT_SCHEMA so the loop above skipped them.
  // Emit them ordered by revision so a parse → serialize round-trip
  // preserves the user's redefinition sequence. The `__r<n>` suffix is
  // stripped on emit so the user sees `var <name> = …` lines, not the
  // internal synthetic name.
  const varPaths = Object.keys(optOverrides)
    .filter((p) => p.startsWith("var."))
    .sort((a, b) => {
      const ra = Number(a.match(/__r(\d+)$/)?.[1] ?? 0);
      const rb = Number(b.match(/__r(\d+)$/)?.[1] ?? 0);
      return ra - rb;
    });
  if (varPaths.length > 0) {
    out.push("");
    out.push(`// ── Variables — Optimize-driven ──`);
    for (const p of varPaths) {
      const name = p.slice("var.".length).replace(/__r\d+$/, "");
      out.push(`var ${name} = ${formatOptimizeSpec(optOverrides[p])}`);
    }
  }

  // Print directives — emit each one on its own line under a single
  // section header so the user sees them grouped.
  const summaryPrints = extras?.summaryPrints ?? [];
  const tradePrints = extras?.tradePrints ?? [];
  if (summaryPrints.length > 0) {
    out.push("");
    out.push(`// ── Output — Strategy prints ──`);
    for (const d of summaryPrints) {
      const labelOmitted = d.label === d.source;
      out.push(labelOmitted ? `print = ${d.source}` : `print = ${d.source}, ${quoteString(d.label)}`);
    }
  }
  if (tradePrints.length > 0) {
    out.push("");
    out.push(`// ── Output — Per-trade prints ──`);
    for (const d of tradePrints) {
      const labelOmitted = d.label === d.source;
      out.push(
        labelOmitted
          ? `ontrade.print = ${d.source}`
          : `ontrade.print = ${d.source}, ${quoteString(d.label)}`
      );
    }
  }
  // filter.if directives — emit each one verbatim from the captured
  // source text. Single section header for grouping; the source already
  // contains the cond + branch text so we don't recurse into the AST.
  const filterIfs = extras?.filterIfs ?? [];
  if (filterIfs.length > 0) {
    out.push("");
    out.push(`// ── Filters — Conditional ──`);
    for (const d of filterIfs) {
      out.push(`filter.if = ${d.source}`);
    }
  } else if (extras?.includeFilterIfTemplates) {
    // Active filter.if templates wired as no-ops so they evaluate the
    // condition without rejecting any trades. Pattern:
    //   filter.if = (<cond>, , pass)
    //                       ^   ^
    //                       |   if_false: explicit `pass` overrides the
    //                       |              default-reject so cond=false
    //                       |              still lets the trade through.
    //                       if_true empty → default pass.
    // Both branches resolve to "pass" → the directive is a true no-op
    // regardless of cond's value (including NaN warmup). This lets the
    // default script ship with the modern syntax visible AND tune-able
    // without breaking existing trade counts.
    //
    // To make a line actually filter, drop the `, , pass` tail:
    //   filter.if = ADX(14) >= 25
    // To reject + side-effect on the false branch, replace `pass` with
    // statements (the explicit `reject` keyword preserves the default
    // reject if you want it):
    //   filter.if = (ADX(14) >= 25, , print("low adx"); reject)
    //
    // Multiple ACTIVE filter.if lines AND together — every one must
    // produce "pass" for the trade to fire.
    out.push("");
    out.push(`// ── Filters — Conditional (filter.if templates) ──`);
    out.push("");
    out.push("// ADX range gate — drop the `, , pass` tail to enable.");
    out.push("filter.if = (ADX(14) >= 20 && ADX(14) <= 60, , pass)");
    out.push("");
    out.push("// ATR range gate — restrict to a volatility band (in points).");
    out.push("filter.if = (ATR(14) >= 0.5 && ATR(14) <= 5, , pass)");
    out.push("");
    out.push("// Trend alignment — trade ONLY in the direction of the fast MA.");
    out.push("// (When activated, rejects every counter-trend signal.)");
    out.push(
      "filter.if = ((direction > 0 && close > EMA(20)) || (direction < 0 && close < EMA(20)), , pass)"
    );
    out.push("");
    out.push("// Volume surge — require entry volume above its 20-bar average.");
    out.push("filter.if = (volume / volume(20) >= 1.5, , pass)");
    out.push("");
    out.push("// MA distance — entry must be within N ATRs of the reference MA.");
    out.push("filter.if = (abs(close - EMA(50)) / ATR(14) <= 2, , pass)");
    out.push("");
    out.push("// ── Advanced examples (commented) ────────────────────────────");
    out.push(
      "// Adaptive stop — tighten SL on strong trend, widen on weak. 3-arg form:"
    );
    out.push(
      "// filter.if = (ADX(14) > 25, rules.stopLossPoints = 8, rules.stopLossPoints = 15)"
    );
    out.push("");
    out.push("// Reject + log on weak volume. NOTE: defining if_false REPLACES the");
    out.push("// default-reject — you must write `reject` explicitly to keep it.");
    out.push(`// filter.if = (volume / volume(20) >= 1.0, , print(volume / volume(20), "vol ratio"); reject)`);
    out.push("");
    out.push("// Nested — only allow longs above EMA20 when ADX > 25:");
    out.push("// filter.if = (ADX(14) > 25, filter.if = (close > EMA(20), , reject), reject)");
    out.push("");
    out.push(
      "// See the script reference (download button) for full grammar, all action statements,"
    );
    out.push("// and the verdict-replacement rule for if_true / if_false slots.");
  }
  // OptimizeAll + Warmup — emitted only when at least one Optimize
  // directive exists (no other directives means the flags are
  // meaningless). OptimizeAll is always explicit so toggling between
  // joint/independent is visible. Warmup emits only when set to false
  // (the non-default) — keeps round-trips clean for users who don't
  // care about the flag.
  if (Object.keys(optOverrides).length > 0) {
    out.push("");
    out.push(`// ── Optimization ──`);
    out.push(`OptimizeAll = ${extras?.optimizeAll ? "true" : "false"}`);
    if (extras?.warmup === false) {
      out.push(`Warmup = false`);
    }
  }
  return out.join("\n") + "\n";
}

/** Render an OptimizeSpec back to its DSL source. Mirrors the parser's
 *  accepted forms: numeric → `Optimize.Obj.Unit(lookback, min, max[, step])`;
 *  categorical → `Optimize.Obj.Unit(lookback, (opt1, opt2, ...))`. We
 *  emit bare-word options (no quotes) when an option has no whitespace
 *  or special chars — matches the canonical user style. */
function formatOptimizeSpec(spec: OptimizeSpec): string {
  if (spec.kind === "optimize-numeric") {
    // Round-trip the user's original source text per arg so an Optimize
    // line typed as `Optimize.X.Y(30, ticks(4), ATR * 3)` re-emits
    // verbatim instead of as `Optimize.X.Y(30, 1, 47.2)` (which would
    // be the resolved bound at one specific signal — meaningless).
    const args: string[] = [String(spec.lookback), spec.min.source, spec.max.source];
    if (spec.step) args.push(spec.step.source);
    const base = `Optimize.${spec.objective}.${spec.lookbackUnit}(${args.join(", ")})`;
    // Trailing `default <num>` clause — only emitted when the user
    // declared one. Negative defaults are kept as-is.
    return spec.defaultValue !== undefined
      ? `${base} default ${spec.defaultValue}`
      : base;
  }
  // Categorical.
  const inner = spec.options
    .map((o) => {
      if (typeof o === "number") return String(o);
      // Bare word if the option is a simple identifier; otherwise quote.
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(o) ? o : quoteString(o);
    })
    .join(", ");
  return `Optimize.${spec.objective}.${spec.lookbackUnit}(${spec.lookback}, (${inner}))`;
}

/** Builds a full BacktestConfig from a partial one + a fallback. Merging
 *  is shallow per top-level branch but deep for params/rules/filters since
 *  those are the keys the script can write into. */
export function mergeConfig(
  base: BacktestConfig,
  patch: PartialBacktestConfig
): BacktestConfig {
  const next: BacktestConfig = {
    strategy: patch.strategy ?? base.strategy,
    params: { ...base.params, ...(patch.params ?? {}) },
    rules: { ...base.rules, ...(patch.rules ?? {}) } as SimRules,
    filters: {
      time: { ...base.filters.time, ...(patch.filters?.time ?? {}) },
      adx: { ...base.filters.adx, ...(patch.filters?.adx ?? {}) },
      atr: { ...base.filters.atr, ...(patch.filters?.atr ?? {}) },
      trend: { ...base.filters.trend, ...(patch.filters?.trend ?? {}) },
      bollinger: {
        ...base.filters.bollinger,
        ...(patch.filters?.bollinger ?? {}),
      },
      bbWidth: { ...base.filters.bbWidth, ...(patch.filters?.bbWidth ?? {}) },
      maDistance: {
        ...base.filters.maDistance,
        ...(patch.filters?.maDistance ?? {}),
      },
      volume: { ...base.filters.volume, ...(patch.filters?.volume ?? {}) },
      rsi: { ...base.filters.rsi, ...(patch.filters?.rsi ?? {}) },
      adxTrend: {
        ...base.filters.adxTrend,
        ...(patch.filters?.adxTrend ?? {}),
      },
    },
  };
  return next;
}

/** Convenience: produce a "fresh" config off the registry defaults. Used
 *  when the user clicks "Reset to defaults" inside Script mode. Defaults
 *  to signal_v2 (preferred over v1 for new scripts); falls back to
 *  STRATEGIES[0] only if the registry doesn't expose v2 for some reason. */
export function defaultBacktestConfig(): BacktestConfig {
  const strategy =
    STRATEGIES.find((s) => s.id === "signal_v2") ?? STRATEGIES[0];
  return {
    strategy: strategy.id,
    params: defaultParamsFor(strategy),
    rules: {
      stopLossEnabled: true,
      stopLossPoints: 10,
      takeProfitEnabled: true,
      takeProfitPoints: 20,
      trailingStopEnabled: false,
      trailingStopPoints: 8,
      timedExitEnabled: false,
      timedExitBars: 20,
      breakEvenEnabled: false,
      breakEvenTrigger: 5,
      exitAtBarClose: true,
      extensionBarsEnabled: false,
      extensionBars: 20,
      slAtrAdjust: 0,
      tpAtrAdjust: 0,
      trailAtrAdjust: 0,
      beAtrAdjust: 0,
      positionMode: "default",
      scalingEnabled: false,
      scalingStartSize: 1,
      scalingWinStep: 1,
      scalingLossStep: 1,
      scalingMinSize: 1,
      scalingMaxSize: 5,
      scalingResetDaily: false,
      dailyStopLossEnabled: false,
      dailyStopLossPoints: 50,
      dailyTakeProfitEnabled: false,
      dailyTakeProfitPoints: 50,
      dailyLimitExactMode: false,
      maxTradesPerDayEnabled: false,
      maxTradesPerDay: 5,
      maxLossesPerDayEnabled: false,
      maxLossesPerDay: 3,
      cooldownBetweenTradesEnabled: false,
      cooldownBetweenTradesBars: 5,
      // Default to NinjaTrader-realistic next-bar-open fills with no
      // slippage/commission applied. Users can dial costs up per preset
      // via the "Fills & Costs" section in the dashboard.
      fillMode: "next_open",
      slippagePoints: 0,
      commissionPerRoundTrip: 0,
      pointValue: 20,
      tickConfigMode: "auto",
      ticksPerPoint: 4,
      tickValue: 5,
    },
    filters: {
      time: {
        enabled: false,
        from: "09:30",
        to: "16:00",
        windows: ["09:30-16:00"],
      },
      adx: { enabled: false, min: 0, max: 100, period: 14 },
      atr: { enabled: false, min: 0, max: 100, period: 14 },
      trend: {
        enabled: false,
        ema20: "with",
        ema200: "any",
        fastPeriod: 20,
        fastType: "ema",
        slowPeriod: 200,
        slowType: "ema",
      },
      bollinger: {
        enabled: false,
        allowed: [...BOLLINGER_POSITIONS],
        period: 20,
        stdDev: 2,
      },
      bbWidth: { enabled: false, min: 0, max: 1000 },
      maDistance: {
        enabled: false,
        period: 50,
        type: "ema",
        mode: "absolute",
        min: 0,
        max: 5,
      },
      volume: { enabled: false, period: 20, minRatio: 0, maxRatio: 100 },
      rsi: { enabled: false, period: 14, min: 0, max: 100 },
      adxTrend: {
        enabled: false,
        mode: "rising",
        lookback: 5,
        flatThreshold: 1,
      },
    },
  };
}
