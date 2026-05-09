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
  type ExampleEntry,
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
    delta: {
      enabled: boolean;
      min: number;
      max: number;
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
  /** Worked examples shown on the /script-reference page, the
   *  script-editor hover tooltips, and the AI markdown export. Each
   *  example pairs a parseable snippet (`rules.stopLossPoints = 10`)
   *  with a plain-English scenario describing what happens. Optional —
   *  legacy/auto-generated rows may not have any. */
  examples?: ExampleEntry[];
}

// ─── Schema construction ────────────────────────────────────────────────────
//
// A handful of schema rows are computed from the strategy registry so
// strategies that get added later show up automatically in autocomplete.
// We DON'T duplicate the strategy-param descriptions here — those live in
// each strategy's `paramFields` and we pull them through.

/** Union of all params across all strategies, deduplicated. Each row notes
 *  which strategies own the param so users get a hint when a param doesn't
 *  apply to their current strategy choice.
 *
 *  Note on `examples`: when two strategies define the same param key,
 *  this fn keeps the FIRST occurrence and just appends subsequent
 *  strategies to the owner list. Examples on the second / later
 *  strategies are silently dropped — to keep things simple, define
 *  worked examples on the strategy where the param appears first in
 *  iteration order. */
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
        examples: f.examples,
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
      "Picks which strategy generates the trade signals. Each strategy has its own knobs (see the Strategy params section). Note: this just switches the strategy — it does NOT reset your params. Use `loadstrategy` instead if you want a fresh start.",
    default: STRATEGIES[0].id,
    options: STRATEGIES.map((s) => s.id),
    enumerable: true,
    examples: [
      {
        snippet: "strategy = signal_v2",
        scenario: "Switch to the signal_v2 strategy, keeping any params you've already set.",
      },
    ],
  },
  {
    path: "loadstrategy",
    type: "enum",
    section: "Strategy",
    description:
      "Switch strategy AND wipe all params.* back to that strategy's defaults. Use this when you want a clean slate. Any params.* lines you write AFTER it still take effect (they override the freshly-loaded defaults).",
    default: STRATEGIES[0].id,
    options: STRATEGIES.map((s) => s.id),
    enumerable: true,
    examples: [
      {
        snippet: "loadstrategy = signal_v2",
        scenario: "Switch to signal_v2 and reset every param to that strategy's defaults.",
      },
    ],
  },

  // ── Strategy params (auto-built) ────────────────────────────────────────
  ...buildParamSchemaEntries(),

  // ── Risk rules: exits ──────────────────────────────────────────────────
  {
    path: "rules.stopLossEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Turn the fixed stop loss on or off.",
    default: true,
    enumerable: true,
    examples: [
      { snippet: "rules.stopLossEnabled = true", scenario: "Use a stop loss on every trade." },
    ],
  },
  {
    path: "rules.stopLossPoints",
    type: "float",
    section: "Risk rules — Exits",
    description: "How many points price has to move against you before the stop kicks in and exits the trade.",
    default: 10,
    min: 0,
    max: 200,
    step: 0.25,
    examples: [
      { snippet: "rules.stopLossPoints = 10", scenario: "Exit if price moves 10 points against your entry." },
      { snippet: "rules.stopLossPoints = ATR * 1.5", scenario: "Use a volatility-based stop — wider on busy days, tighter on quiet ones." },
    ],
  },
  {
    path: "rules.takeProfitEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Turn the fixed take profit on or off.",
    default: true,
    enumerable: true,
    examples: [
      { snippet: "rules.takeProfitEnabled = false", scenario: "Don't auto-exit on profit — let trailing stops or the timed exit close it." },
    ],
  },
  {
    path: "rules.takeProfitPoints",
    type: "float",
    section: "Risk rules — Exits",
    description: "How many points of profit you want before automatically banking the trade.",
    default: 20,
    min: 0,
    max: 200,
    step: 0.25,
    examples: [
      { snippet: "rules.takeProfitPoints = 20", scenario: "Bank the trade once you're up 20 points." },
      { snippet: "rules.takeProfitPoints = ATR * 3", scenario: "Aim for 3× the typical bar swing as profit." },
    ],
  },
  {
    path: "rules.trailingStopEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Turn on a trailing stop — a stop that follows price up, locking in profit as the trade goes your way.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.trailingStopEnabled = true", scenario: "Let winners run — exit only when price pulls back from the peak." },
    ],
  },
  {
    path: "rules.trailingStopPoints",
    type: "float",
    section: "Risk rules — Exits",
    description: "How far the trailing stop sits behind the best price the trade has reached. Smaller = locks in profit sooner; bigger = lets the trade breathe.",
    default: 8,
    min: 0,
    max: 100,
    step: 0.25,
    examples: [
      { snippet: "rules.trailingStopPoints = 8", scenario: "Exit if price pulls back 8 points from the high it has reached so far." },
    ],
  },
  {
    path: "rules.timedExitEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Force the trade to close after a set number of bars, no matter what.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.timedExitEnabled = true", scenario: "Don't hold trades forever — close them after a fixed bar count." },
    ],
  },
  {
    path: "rules.timedExitBars",
    type: "int",
    section: "Risk rules — Exits",
    description: "How many bars to wait before force-closing the trade.",
    default: 20,
    min: 1,
    max: 200,
    step: 1,
    examples: [
      { snippet: "rules.timedExitBars = 20", scenario: "Close the trade after 20 bars, win or lose." },
    ],
  },
  {
    path: "rules.breakEvenEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Once the trade is up by a certain amount, move the stop to your entry price so you can't lose anymore.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.breakEvenEnabled = true", scenario: "Lock in a free trade once profit reaches the trigger." },
    ],
  },
  {
    path: "rules.breakEvenTrigger",
    type: "float",
    section: "Risk rules — Exits",
    description: "How many points of profit you need before the stop gets pulled up to break-even.",
    default: 5,
    min: 0,
    max: 100,
    step: 0.25,
    examples: [
      { snippet: "rules.breakEvenTrigger = 5", scenario: "Once you're up 5 points, move the stop to entry — no more losses possible." },
    ],
  },
  {
    path: "rules.exitAtBarClose",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "If true, the trade exits at the close of the bar that triggered the stop or target. If false, it exits at the exact price level the moment it hit (mid-bar).",
    default: true,
    enumerable: true,
    examples: [
      { snippet: "rules.exitAtBarClose = false", scenario: "Be more realistic — exit the moment the stop/target price prints, not at the candle close." },
    ],
  },
  {
    path: "rules.extensionBarsEnabled",
    type: "boolean",
    section: "Risk rules — Exits",
    description: "Lets the simulator hold a trade past the end of the original zone by adding extra bars to play out.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.extensionBarsEnabled = true", scenario: "Don't auto-close at zone end — give the trade more bars to find its target." },
    ],
  },
  {
    path: "rules.extensionBars",
    type: "int",
    section: "Risk rules — Exits",
    description: "How many extra bars to append after a zone ends, when extension bars are turned on.",
    default: 20,
    min: 1,
    max: 100,
    step: 1,
    examples: [
      { snippet: "rules.extensionBars = 20", scenario: "Give every trade 20 extra bars to play out beyond its zone." },
    ],
  },

  // ── Risk rules: ATR adjust ──────────────────────────────────────────────
  {
    path: "rules.slAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description:
      "Adds a volatility-based bonus to your stop. Stop = stopLossPoints + this × ATR(14). 0 = fixed stop. Positive = wider stop on volatile days. Negative = tighter on volatile days.",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
    examples: [
      { snippet: "rules.slAtrAdjust = 1", scenario: "Add 1× ATR to your fixed stop — stops widen automatically when the market is busy." },
    ],
  },
  {
    path: "rules.tpAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description: "Adds an ATR-based bonus to your take-profit target. Same idea as the stop adjust, but for profit.",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
    examples: [
      { snippet: "rules.tpAtrAdjust = 2", scenario: "Make the target stretch by 2× ATR on busy days." },
    ],
  },
  {
    path: "rules.trailAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description: "Adds an ATR bonus to the trailing stop distance.",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
    examples: [
      { snippet: "rules.trailAtrAdjust = 1", scenario: "Widen the trail by 1× ATR on volatile days so the stop doesn't get clipped." },
    ],
  },
  {
    path: "rules.beAtrAdjust",
    type: "float",
    section: "Risk rules — ATR adjust",
    description: "Adds an ATR bonus to the break-even trigger amount.",
    default: 0,
    min: -2,
    max: 2,
    step: 0.05,
    examples: [
      { snippet: "rules.beAtrAdjust = 0.5", scenario: "Push the break-even trigger out by half an ATR on busy days — wait for more confirmation before locking in." },
    ],
  },

  // ── Risk rules: Position overlap ───────────────────────────────────────
  {
    path: "rules.positionMode",
    type: "enum",
    section: "Risk rules — Position overlap",
    description:
      'What to do when a new signal happens while another trade is still open. "default" runs each trade in its own world. "close-previous" closes everything open. "add-close" closes only trades going the opposite way. "null" ignores new signals while anything is open. "reverse-null" / "reverse-add" handle flips.',
    default: "default",
    options: POSITION_MODES,
    enumerable: true,
    examples: [
      { snippet: 'rules.positionMode = "close-previous"', scenario: "When a new signal fires, close any open trades first, then take the new one." },
      { snippet: 'rules.positionMode = "null"', scenario: "Skip any new signal while a trade is open — one at a time only." },
    ],
  },

  // ── Risk rules: Scaling ────────────────────────────────────────────────
  {
    path: "rules.scalingEnabled",
    type: "boolean",
    section: "Risk rules — Scaling",
    description: "Lets your trade size grow after winners and shrink after losers, instead of being a fixed amount every time.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.scalingEnabled = true", scenario: "Press your edge — risk more after wins, less after losses." },
    ],
  },
  {
    path: "rules.scalingStartSize",
    type: "int",
    section: "Risk rules — Scaling",
    description: "How many contracts the scaling system starts with.",
    default: 1,
    min: 1,
    max: 100,
    step: 1,
    examples: [
      { snippet: "rules.scalingStartSize = 1", scenario: "Begin scaling from 1 contract." },
    ],
  },
  {
    path: "rules.scalingWinStep",
    type: "int",
    section: "Risk rules — Scaling",
    description: "How many contracts to ADD after a winning trade.",
    default: 1,
    min: 0,
    max: 20,
    step: 1,
    examples: [
      { snippet: "rules.scalingWinStep = 1", scenario: "Add 1 contract after each win." },
    ],
  },
  {
    path: "rules.scalingLossStep",
    type: "int",
    section: "Risk rules — Scaling",
    description: "How many contracts to REMOVE after a losing trade.",
    default: 1,
    min: 0,
    max: 20,
    step: 1,
    examples: [
      { snippet: "rules.scalingLossStep = 1", scenario: "Drop 1 contract after each loss." },
    ],
  },
  {
    path: "rules.scalingMinSize",
    type: "int",
    section: "Risk rules — Scaling",
    description: "The smallest size your scaling will ever shrink down to.",
    default: 1,
    min: 1,
    max: 100,
    step: 1,
    examples: [
      { snippet: "rules.scalingMinSize = 1", scenario: "Never go below 1 contract — even after a string of losses, keep at least one in play." },
    ],
  },
  {
    path: "rules.scalingMaxSize",
    type: "int",
    section: "Risk rules — Scaling",
    description: "The biggest size your scaling will grow to.",
    default: 5,
    min: 1,
    max: 100,
    step: 1,
    examples: [
      { snippet: "rules.scalingMaxSize = 5", scenario: "Cap scaling at 5 contracts no matter how many wins in a row." },
    ],
  },
  {
    path: "rules.scalingResetDaily",
    type: "boolean",
    section: "Risk rules — Scaling",
    description: "If true, scaling size resets to the start size at the beginning of each day. Stops a hot streak from carrying into a fresh session.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.scalingResetDaily = true", scenario: "Each new trading day starts back at scalingStartSize." },
    ],
  },

  // ── Risk rules: Daily kill switches ────────────────────────────────────
  {
    path: "rules.dailyStopLossEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "Stop trading for the day if total losses get too big. A safety net so a bad day doesn't snowball.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.dailyStopLossEnabled = true", scenario: "Walk away once you've lost too much in one day." },
    ],
  },
  {
    path: "rules.dailyStopLossPoints",
    type: "float",
    section: "Risk rules — Daily limits",
    description: "How many points in the red before the daily stop kicks in (use a positive number — it's treated as a loss).",
    default: 50,
    min: 0,
    max: 1000,
    step: 1,
    examples: [
      { snippet: "rules.dailyStopLossPoints = 50", scenario: "Stop trading for the day once you're down 50 points." },
    ],
  },
  {
    path: "rules.dailyTakeProfitEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "Stop trading for the day after you've made enough profit. Locks in a green day.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.dailyTakeProfitEnabled = true", scenario: "Quit while you're ahead — stop trading after hitting a daily profit goal." },
    ],
  },
  {
    path: "rules.dailyTakeProfitPoints",
    type: "float",
    section: "Risk rules — Daily limits",
    description: "How many points of profit to make before quitting for the day.",
    default: 50,
    min: 0,
    max: 1000,
    step: 1,
    examples: [
      { snippet: "rules.dailyTakeProfitPoints = 50", scenario: "Stop trading once you've banked 50 points for the day." },
    ],
  },
  {
    path: "rules.dailyLimitExactMode",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "If true, the daily limit force-closes any open trades the moment it triggers. If false, open trades are allowed to finish naturally — only NEW entries get blocked.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.dailyLimitExactMode = true", scenario: "Hit your daily limit? Close everything immediately." },
    ],
  },
  {
    path: "rules.maxTradesPerDayEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "Set a hard cap on how many trades you can take in one day.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.maxTradesPerDayEnabled = true", scenario: "Limit how many trades fire each day to prevent over-trading." },
    ],
  },
  {
    path: "rules.maxTradesPerDay",
    type: "int",
    section: "Risk rules — Daily limits",
    description: "How many trades you're allowed in a single day before further entries get blocked.",
    default: 5,
    min: 1,
    max: 200,
    step: 1,
    examples: [
      { snippet: "rules.maxTradesPerDay = 5", scenario: "Allow at most 5 trades per day; ignore anything beyond that." },
    ],
  },
  {
    path: "rules.maxLossesPerDayEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "Stop trading for the day after a certain number of LOSING trades. Useful if you tilt easily after losses.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.maxLossesPerDayEnabled = true", scenario: "Walk away after a streak of losers — fight tilt." },
    ],
  },
  {
    path: "rules.maxLossesPerDay",
    type: "int",
    section: "Risk rules — Daily limits",
    description: "How many losing trades are allowed per day before the day ends.",
    default: 3,
    min: 1,
    max: 50,
    step: 1,
    examples: [
      { snippet: "rules.maxLossesPerDay = 3", scenario: "After 3 losers in one day, stop taking new trades." },
    ],
  },
  {
    path: "rules.cooldownBetweenTradesEnabled",
    type: "boolean",
    section: "Risk rules — Daily limits",
    description: "Forces a wait between trades. Stops you from rapid-firing entries on top of each other.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "rules.cooldownBetweenTradesEnabled = true", scenario: "Wait a few minutes after each trade before allowing the next entry." },
    ],
  },
  {
    path: "rules.cooldownBetweenTradesBars",
    type: "int",
    section: "Risk rules — Daily limits",
    description: "How many minutes to wait after a trade closes before another entry is allowed.",
    default: 5,
    min: 1,
    max: 240,
    step: 1,
    examples: [
      { snippet: "rules.cooldownBetweenTradesBars = 5", scenario: "Wait 5 minutes after each closed trade before the next entry." },
    ],
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
      'Where the trade actually fills. "next_open" (default) fills at the open of the bar AFTER the signal — matches how live trading really works. "close" fills at the exact closing price of the signal bar (less realistic, but useful to replicate older backtests).',
    default: "next_open",
    options: ["close", "next_open"],
    enumerable: true,
    examples: [
      { snippet: 'rules.fillMode = "next_open"', scenario: "Realistic — fills at the next bar's open like real live trading." },
    ],
  },
  {
    path: "rules.tickConfigMode",
    type: "enum",
    section: "Risk rules — Fills & Costs",
    description:
      'Whether tick sizes are figured out automatically from the instrument symbol (auto), or set by hand (manual). "auto" works for all standard futures like NQ, ES, GC, CL, BTC. Use "manual" only for custom instruments.',
    default: "auto",
    options: ["auto", "manual"],
    enumerable: true,
    examples: [
      { snippet: 'rules.tickConfigMode = "auto"', scenario: "Let the dashboard figure out the right tick size for each instrument." },
    ],
  },
  {
    path: "rules.pointValue",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Dollars per 1 full price point per contract. Only used when tickConfigMode is \"manual\". Reference: NQ=20, ES=50, CL=1000, GC=100.",
    default: 20,
    min: 0,
    max: 100000,
    step: 0.01,
    examples: [
      { snippet: "rules.pointValue = 50", scenario: "Manually set the point value to $50 (e.g. for ES)." },
    ],
  },
  {
    path: "rules.ticksPerPoint",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "How many ticks make up one full price point. Only used when tickConfigMode is \"manual\". Reference: NQ/ES=4, CL=100, GC=10, BTC=0.2.",
    default: 4,
    min: 0.01,
    max: 10000,
    step: 0.01,
    examples: [
      { snippet: "rules.ticksPerPoint = 4", scenario: "Manually set 4 ticks per point (NQ/ES style)." },
    ],
  },
  {
    path: "rules.tickValue",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Dollar value of one tick. Only used in manual mode. Should equal pointValue ÷ ticksPerPoint.",
    default: 5,
    min: 0,
    max: 100000,
    step: 0.01,
    examples: [
      { snippet: "rules.tickValue = 5", scenario: "Set 1 tick to $5 (NQ-style: $20 point ÷ 4 ticks)." },
    ],
  },
  {
    path: "rules.slippagePoints",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Extra cost (in points) you pay each time you enter or exit. Models real-world fill quality — your stop or target rarely fills exactly at the price you wanted.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.01,
    examples: [
      { snippet: "rules.slippagePoints = 0.25", scenario: "Pay 0.25 points slippage on entry AND exit (so 0.5 round-trip)." },
    ],
  },
  {
    path: "rules.commissionPerRoundTrip",
    type: "float",
    section: "Risk rules — Fills & Costs",
    description:
      "Flat dollar fee per completed trade (entry + exit combined). Affects dollar totals, not points totals.",
    default: 0,
    min: 0,
    max: 1000,
    step: 0.01,
    examples: [
      { snippet: "rules.commissionPerRoundTrip = 4", scenario: "Charge $4 per closed trade as broker commission." },
    ],
  },

  // ── Filters: time of day ───────────────────────────────────────────────
  {
    path: "filters.time.enabled",
    type: "boolean",
    section: "Filters — Time of day",
    description: "Only allow trades during certain hours of the day. Skip the rest.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "filters.time.enabled = true", scenario: "Restrict trading to a specific time-of-day window." },
    ],
  },
  {
    path: "filters.time.from",
    type: "string",
    section: "Filters — Time of day",
    description: 'When the trading window starts — written as "HH:MM" in 24-hour format.',
    default: "09:30",
    examples: [
      { snippet: 'filters.time.from = "09:30"', scenario: "Start trading at 9:30 AM." },
    ],
  },
  {
    path: "filters.time.to",
    type: "string",
    section: "Filters — Time of day",
    description: 'When the trading window ends — "HH:MM" in 24-hour format.',
    default: "16:00",
    examples: [
      { snippet: 'filters.time.to = "16:00"', scenario: "Stop allowing new entries after 4:00 PM." },
    ],
  },
  {
    path: "filters.time.windows",
    type: "stringArray",
    section: "Filters — Time of day",
    description: 'Multiple trading windows in one list. Each one is "HH:MM-HH:MM". A bar passes if it falls in ANY of these windows. Useful for things like "morning OR power hour".',
    default: ["09:30-16:00"],
    examples: [
      { snippet: 'filters.time.windows = ["09:30-11:00", "14:00-16:00"]', scenario: "Only trade during the open and the last 2 hours — skip lunch chop." },
    ],
  },

  // ── Filters: ADX ───────────────────────────────────────────────────────
  // All ADX gating can be expressed via `filter.if = ADX(period) >= min &&
  // ADX(period) <= max` — the legacy section is kept on the schema for
  // UI back-compat but hidden from the default-script emission.
  {
    path: "filters.adx.enabled",
    type: "boolean",
    section: "Filters — ADX",
    description: "Only allow trades when the trend strength score (ADX) is between your chosen min and max. Tip: the same effect can be done with `filter.if = ADX(14) >= min && ADX(14) <= max`, which is more flexible.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.adx.enabled = true", scenario: "Turn on the legacy ADX filter — trades only fire when ADX is in your band." },
    ],
  },
  {
    path: "filters.adx.min",
    type: "float",
    section: "Filters — ADX",
    description: "Smallest ADX value allowed for a trade. ADX below this gets blocked.",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.adx.min = 25", scenario: "Skip weak/choppy markets — only trade when ADX is at least 25." },
    ],
  },
  {
    path: "filters.adx.max",
    type: "float",
    section: "Filters — ADX",
    description: "Biggest ADX value allowed. ADX above this gets blocked.",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.adx.max = 50", scenario: "Skip already-overheated trends — block trades when ADX is above 50." },
    ],
  },
  {
    path: "filters.adx.period",
    type: "int",
    section: "Filters — ADX",
    description: "How many bars the ADX is calculated over. Standard is 14.",
    default: 14,
    min: 2,
    max: 200,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.adx.period = 14", scenario: "Use the standard 14-bar ADX. Bump higher (e.g. 28) for a slower, smoother trend reading." },
    ],
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
    description: "Only allow trades when the volatility (ATR) is in your chosen band. Skip dead-quiet markets or super-wild ones.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.atr.enabled = true", scenario: "Turn on the legacy ATR filter so volatility has to be in range." },
    ],
  },
  {
    path: "filters.atr.min",
    type: "float",
    section: "Filters — ATR",
    description: "Smallest allowed ATR (points). Below this = market too quiet to trade.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.25,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.atr.min = 0.5", scenario: "Skip dead-quiet markets where ATR is below 0.5." },
    ],
  },
  {
    path: "filters.atr.max",
    type: "float",
    section: "Filters — ATR",
    description: "Largest allowed ATR (points). Above this = market too wild.",
    default: 100,
    min: 0,
    max: 100,
    step: 0.25,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.atr.max = 5", scenario: "Skip extra-volatile sessions where ATR is over 5 points — risk gets too unpredictable." },
    ],
  },
  {
    path: "filters.atr.period",
    type: "int",
    section: "Filters — ATR",
    description: "How many bars the ATR is averaged over. Standard is 14. Also used by the ATR-adjust math on stops/targets.",
    default: 14,
    min: 2,
    max: 200,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.atr.period = 14", scenario: "Use the standard 14-bar ATR for both gating and any ATR-adjust math on stops/targets." },
    ],
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
    description: "Turn on a trend filter that uses two moving averages (a fast one and a slow one). Forces trades to go with or against the trend.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.trend.enabled = true", scenario: "Turn on legacy trend filtering." },
    ],
  },
  {
    path: "filters.trend.ema20",
    type: "enum",
    section: "Filters — Trend",
    description:
      'How the fast trend (EMA20) gates trades. "with" = only trade in the direction of the trend. "against" = only trade against it. "any" = ignore this leg.',
    default: "with",
    options: TREND_MODES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: 'filters.trend.ema20 = "with"', scenario: "Only take trades that go in the direction of the EMA20 trend." },
    ],
  },
  {
    path: "filters.trend.ema200",
    type: "enum",
    section: "Filters — Trend",
    description: 'Same as ema20 but for the long-term trend (EMA200). Useful for big-picture bias.',
    default: "any",
    options: TREND_MODES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: 'filters.trend.ema200 = "with"', scenario: "Only trade in the direction of the long-term trend." },
    ],
  },
  {
    path: "filters.trend.fastPeriod",
    type: "int",
    section: "Filters — Trend",
    description: "How many bars the FAST trend line is calculated over. Default 20.",
    default: 20,
    min: 2,
    max: 500,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.trend.fastPeriod = 20", scenario: "Use a 20-bar EMA as the fast trend line — the standard short-term reading." },
    ],
  },
  {
    path: "filters.trend.fastType",
    type: "enum",
    section: "Filters — Trend",
    description: 'What flavor of average to use for the fast trend — "ema" (faster) or "sma" (smoother).',
    default: "ema",
    options: MA_TYPES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: 'filters.trend.fastType = "sma"', scenario: "Use a plain SMA instead of EMA for the fast line — smoother reading, slower to react." },
    ],
  },
  {
    path: "filters.trend.slowPeriod",
    type: "int",
    section: "Filters — Trend",
    description: "How many bars the SLOW trend line is calculated over. Default 200.",
    default: 200,
    min: 2,
    max: 1000,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.trend.slowPeriod = 50", scenario: "Use a 50-bar slow line for medium-term bias instead of the long 200-bar default." },
    ],
  },
  {
    path: "filters.trend.slowType",
    type: "enum",
    section: "Filters — Trend",
    description: 'What flavor of average to use for the slow trend — "ema" or "sma".',
    default: "ema",
    options: MA_TYPES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: 'filters.trend.slowType = "sma"', scenario: "Use the classic 200-bar SMA for long-term bias — closer to what most traders watch." },
    ],
  },

  // ── Filters: Bollinger position ────────────────────────────────────────
  {
    path: "filters.bollinger.enabled",
    type: "boolean",
    section: "Filters — Bollinger",
    description: "Only allow trades when price is in a chosen position relative to Bollinger Bands (above the upper, inside the bands, or below the lower).",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "filters.bollinger.enabled = true", scenario: "Turn on the Bollinger position filter." },
    ],
  },
  {
    path: "filters.bollinger.allowed",
    type: "stringArray",
    section: "Filters — Bollinger",
    description: 'Which positions are allowed. Pick any combination of "above_upper", "inside", "below_lower". Empty list = no trades.',
    default: BOLLINGER_POSITIONS,
    options: BOLLINGER_POSITIONS,
    enumerable: true,
    examples: [
      { snippet: 'filters.bollinger.allowed = ["below_lower"]', scenario: "Only trade when price has dropped below the lower band — mean-reversion buys." },
    ],
  },
  {
    path: "filters.bollinger.period",
    type: "int",
    section: "Filters — Bollinger",
    description: "How many bars the Bollinger Bands center line is calculated over. Default 20. Also used by the BB-width filter.",
    default: 20,
    min: 2,
    max: 500,
    step: 1,
    examples: [
      { snippet: "filters.bollinger.period = 20", scenario: "Use the classic 20-bar Bollinger center line — the standard setting." },
    ],
  },
  {
    path: "filters.bollinger.stdDev",
    type: "float",
    section: "Filters — Bollinger",
    description: "How many standard deviations the bands sit out from the middle line. Default 2 (the classic Bollinger setting).",
    default: 2,
    min: 0.5,
    max: 5,
    step: 0.1,
    examples: [
      { snippet: "filters.bollinger.stdDev = 2.5", scenario: "Push the bands further out (2.5 stdev) so only more extreme excursions count as above/below." },
    ],
  },

  // ── Filters: Bollinger band width ──────────────────────────────────────
  {
    path: "filters.bbWidth.enabled",
    type: "boolean",
    section: "Filters — BB width",
    description: "Only allow trades when the Bollinger Bands are at a chosen width. Narrow bands = squeezed market (often before big moves). Wide bands = high volatility.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "filters.bbWidth.enabled = true", scenario: "Turn on the BB width filter to gate by volatility regime." },
    ],
  },
  {
    path: "filters.bbWidth.min",
    type: "float",
    section: "Filters — BB width",
    description: "Smallest allowed band width (in points). Below this = market too tight.",
    default: 0,
    min: 0,
    max: 1000,
    step: 0.25,
    examples: [
      { snippet: "filters.bbWidth.min = 5", scenario: "Skip ultra-squeezed conditions; only trade when bands are at least 5 points wide." },
    ],
  },
  {
    path: "filters.bbWidth.max",
    type: "float",
    section: "Filters — BB width",
    description: "Largest allowed band width (in points). Above this = market too wide.",
    default: 1000,
    min: 0,
    max: 10000,
    step: 0.25,
    examples: [
      { snippet: "filters.bbWidth.max = 50", scenario: "Skip extra-wide volatility regimes — only trade when bands are 50 points or narrower." },
    ],
  },

  // ── Filters: Distance from a configurable MA ───────────────────────────
  // MA-distance gating: filter.if = abs(close - EMA(period)) / ATR(14)
  // >= min && abs(close - EMA(period)) / ATR(14) <= max
  // (with sign checks for "above"/"below" modes).
  {
    path: "filters.maDistance.enabled",
    type: "boolean",
    section: "Filters — MA distance",
    description: "Only allow trades when price is a chosen distance away from a moving average. Useful for catching pullbacks (close to the MA) or breakouts (far from it).",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.maDistance.enabled = true", scenario: "Turn on the MA-distance filter." },
    ],
  },
  {
    path: "filters.maDistance.period",
    type: "int",
    section: "Filters — MA distance",
    description: "How many bars the reference moving average covers. Default 50.",
    default: 50,
    min: 2,
    max: 1000,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.maDistance.period = 50", scenario: "Measure pullback distance from a 50-bar moving average — a balanced medium-term reference." },
    ],
  },
  {
    path: "filters.maDistance.type",
    type: "enum",
    section: "Filters — MA distance",
    description: 'What flavor of average to use — "ema" (faster) or "sma" (smoother).',
    default: "ema",
    options: MA_TYPES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: 'filters.maDistance.type = "sma"', scenario: "Use a plain SMA as the reference line for distance calculations — smoother, less twitchy." },
    ],
  },
  {
    path: "filters.maDistance.mode",
    type: "enum",
    section: "Filters — MA distance",
    description:
      '"absolute" = just measure how far without caring which side. "above" = price must be ABOVE the MA. "below" = price must be BELOW.',
    default: "absolute",
    options: MA_DISTANCE_MODES,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: 'filters.maDistance.mode = "above"', scenario: "Only take trades where price is above the moving average." },
    ],
  },
  {
    path: "filters.maDistance.min",
    type: "float",
    section: "Filters — MA distance",
    description: "Smallest allowed distance from the MA, measured in ATR units (so it scales with volatility).",
    default: 0,
    min: 0,
    max: 50,
    step: 0.05,
    examples: [
      { snippet: "filters.maDistance.min = 0.5", scenario: "Only trade when price is at least half an ATR away from the reference MA." },
    ],
    legacyHiddenWhenDefault: true,
  },
  {
    path: "filters.maDistance.max",
    type: "float",
    section: "Filters — MA distance",
    description: "Largest allowed distance from the MA, in ATR units.",
    default: 5,
    min: 0,
    max: 50,
    step: 0.05,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.maDistance.max = 2", scenario: "Skip overstretched moves — block trades when price is more than 2 ATRs away from the reference MA." },
    ],
  },

  // ── Filters: Volume ────────────────────────────────────────────────────
  // Volume-ratio gating: filter.if = volume / volume(period) >= minRatio &&
  //                                  volume / volume(period) <= maxRatio
  {
    path: "filters.volume.enabled",
    type: "boolean",
    section: "Filters — Volume",
    description: "Only allow trades when the current bar's volume is in a chosen ratio compared to its recent average. Skip dead bars or trade only on volume bursts.",
    default: false,
    enumerable: true,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.volume.enabled = true", scenario: "Turn on the volume filter — gate trades by activity." },
    ],
  },
  {
    path: "filters.volume.period",
    type: "int",
    section: "Filters — Volume",
    description: "How many bars to average volume over. Default 20.",
    default: 20,
    min: 2,
    max: 500,
    step: 1,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.volume.period = 20", scenario: "Compare current bar volume against the rolling 20-bar average — the standard reference window." },
    ],
  },
  {
    path: "filters.volume.minRatio",
    type: "float",
    section: "Filters — Volume",
    description: "Smallest allowed volume-to-average ratio. 1.0 = at average; 1.5 = at least 50% above average.",
    default: 0,
    min: 0,
    max: 100,
    step: 0.05,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.volume.minRatio = 1.5", scenario: "Only trade when this bar has 1.5× the average volume." },
    ],
  },
  {
    path: "filters.volume.maxRatio",
    type: "float",
    section: "Filters — Volume",
    description: "Largest allowed volume-to-average ratio. Use to skip bars with crazy spikes if you don't trust them.",
    default: 100,
    min: 0,
    max: 1000,
    step: 0.05,
    legacyHiddenWhenDefault: true,
    examples: [
      { snippet: "filters.volume.maxRatio = 5", scenario: "Skip news-driven volume blowouts — block bars where volume is more than 5× the average." },
    ],
  },

  // ── Filters: RSI ───────────────────────────────────────────────────────
  {
    path: "filters.rsi.enabled",
    type: "boolean",
    section: "Filters — RSI",
    description: "Only allow trades when RSI is in your chosen band. Classic oversold = below 30; overbought = above 70.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "filters.rsi.enabled = true", scenario: "Turn on the RSI filter so trades only fire in your RSI window." },
    ],
  },
  {
    path: "filters.rsi.period",
    type: "int",
    section: "Filters — RSI",
    description: "How many bars the RSI is calculated over. Default 14.",
    default: 14,
    min: 2,
    max: 200,
    step: 1,
    examples: [
      { snippet: "filters.rsi.period = 14", scenario: "Use the standard 14-bar RSI. Lower it (e.g. 7) for a faster, twitchier oscillator." },
    ],
  },
  {
    path: "filters.rsi.min",
    type: "float",
    section: "Filters — RSI",
    description: "Smallest allowed RSI (0–100).",
    default: 0,
    min: 0,
    max: 100,
    step: 1,
    examples: [
      { snippet: "filters.rsi.min = 30", scenario: "Skip oversold conditions — only trade when RSI is 30 or higher." },
    ],
  },
  {
    path: "filters.rsi.max",
    type: "float",
    section: "Filters — RSI",
    description: "Largest allowed RSI (0–100).",
    default: 100,
    min: 0,
    max: 100,
    step: 1,
    examples: [
      { snippet: "filters.rsi.max = 70", scenario: "Skip overbought conditions — block trades when RSI is above 70." },
    ],
  },

  // ── Filters: ADX direction (rising / falling / flat) ───────────────────
  {
    path: "filters.adxTrend.enabled",
    type: "boolean",
    section: "Filters — ADX direction",
    description: "Only allow trades when ADX is moving the way you want — rising (trend getting stronger), falling (weakening), or flat (steady).",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "filters.adxTrend.enabled = true", scenario: "Turn on the ADX-direction filter." },
    ],
  },
  {
    path: "filters.adxTrend.mode",
    type: "enum",
    section: "Filters — ADX direction",
    description: '"rising" = trend strength building. "falling" = losing strength. "flat" = stable. "any" = ignore.',
    default: "rising",
    options: ADX_TREND_MODES,
    enumerable: true,
    examples: [
      { snippet: 'filters.adxTrend.mode = "rising"', scenario: "Only take trades when trend strength is GROWING — fresh momentum." },
    ],
  },
  {
    path: "filters.adxTrend.lookback",
    type: "int",
    section: "Filters — ADX direction",
    description: "How many bars back to compare ADX against to figure out direction. Default 5.",
    default: 5,
    min: 1,
    max: 100,
    step: 1,
    examples: [
      { snippet: "filters.adxTrend.lookback = 10", scenario: "Compare ADX against its value 10 bars ago — slower, less twitchy direction reading." },
    ],
  },
  {
    path: "filters.adxTrend.flatThreshold",
    type: "float",
    section: "Filters — ADX direction",
    description: "How small the change in ADX needs to be before we call it \"flat\". Bigger value = wider flat zone.",
    default: 1,
    min: 0,
    max: 50,
    step: 0.1,
    examples: [
      { snippet: "filters.adxTrend.flatThreshold = 2", scenario: "Treat ADX changes of 2 or less as \"flat\" — a more forgiving definition of stable." },
    ],
  },

  // ── Filters: Bid/ask delta imbalance ──────────────────────────────────
  // Imbalance ratio at the entry bar = (ask − bid) / (ask + bid). Range
  // [−1, +1]. Requires a session with bid/ask volumes (tick / tick_bidask
  // / ohlcv_bidask). On plain `ohlcv` sessions ctx_delta_ratio is null and
  // every trade is rejected when this filter is enabled — a deliberate
  // fail-closed default so a stale filter setting can't silently widen
  // the trade set on a session it can't reason about.
  {
    path: "filters.delta.enabled",
    type: "boolean",
    section: "Filters — Bid/ask delta",
    description: "Only allow trades when buy/sell aggression is at a chosen level. NEEDS bid/ask data — on plain OHLCV sessions every trade gets rejected.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "filters.delta.enabled = true", scenario: "Turn on the buy/sell aggression filter (needs tick or ohlcv_bidask data)." },
    ],
  },
  {
    path: "filters.delta.min",
    type: "float",
    section: "Filters — Bid/ask delta",
    description: "Smallest allowed buyer-vs-seller score (−1 to +1). −1 = pure sellers, 0 = balanced, +1 = pure buyers.",
    default: -1,
    min: -1,
    max: 1,
    step: 0.05,
    examples: [
      { snippet: "filters.delta.min = 0.2", scenario: "Only take longs when buyers are clearly winning the bar." },
    ],
  },
  {
    path: "filters.delta.max",
    type: "float",
    section: "Filters — Bid/ask delta",
    description: "Largest allowed buyer-vs-seller score (−1 to +1). Combine with min to make a band.",
    default: 1,
    min: -1,
    max: 1,
    step: 0.05,
    examples: [
      { snippet: "filters.delta.max = -0.2", scenario: "Only take shorts when sellers are clearly winning — block when buyers dominate." },
    ],
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
      'Show a custom number in the Output panel after the backtest finishes. Use any summary identifier (winRate, profitFactor, etc.). Add `, "label"` for a friendly name.',
    default: "",
    examples: [
      { snippet: 'print = winRate * 100, "Win %"', scenario: 'Show the win rate as a percentage labeled "Win %".' },
      { snippet: 'print = profitFactor, "PF"', scenario: 'Show the profit factor in a card labeled "PF".' },
    ],
  },
  {
    path: "ontrade.print",
    type: "directive",
    section: "Output — Per-trade prints",
    description:
      'Add a column to the trade table showing a value calculated at each trade. Evaluated AFTER each trade exits, so expressions can use entry-side identifiers (close, ATR, RSI, EMA20, ...) AND exit-side bindings: exit_points, scaled_points, net_dollars, bars_held, peak_mfe, max_drawdown, position_size, commission_dollars, slippage_applied, is_winner, is_loser, exit_reason (compare against EXIT_TP/EXIT_SL/EXIT_TRAIL/EXIT_BE/EXIT_TIMER/EXIT_END/EXIT_NEXT/EXIT_DAILY/EXIT_SIGNAL), eff_sl/eff_tp/eff_trail/eff_be, entry_price.',
    default: "",
    examples: [
      { snippet: 'ontrade.print = ATR(14), "Entry ATR"', scenario: "Add a column showing the ATR at the moment each trade entered." },
      { snippet: 'ontrade.print = close - EMA50, "Dist from EMA50"', scenario: "Show how far each entry was from the 50-bar trend line." },
      { snippet: 'ontrade.print = exit_points, "Trade R"', scenario: "Show each trade's realized P&L in points (negative for losers)." },
      { snippet: 'ontrade.print = exit_reason, "Exit Code"', scenario: "Show the numeric exit-reason code (1=tp, 2=sl, 3=trail, 4=be, 5=timer, 6=end, 7=next, 8=daily, 9=signal)." },
      { snippet: 'ontrade.print = (exit_reason == EXIT_STOP, 1, 0), "Was Stop"', scenario: "Add a 1/0 column flagging trades that exited via the stop-loss — comparable in CSV pivots." },
      { snippet: 'ontrade.print = peak_mfe / max(1, -max_drawdown), "MFE / DD"', scenario: "Show the run-up vs run-down ratio per trade — higher = ran in your favor before resolving." },
      { snippet: 'ontrade.print = net_dollars, "$ P/L"', scenario: "Show realized dollar P&L per trade — already net of commissions and reflects positionSize." },
    ],
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
      "The most flexible filter. Simple form: write a yes/no expression and trades only fire when the answer is yes. 3-part form: `filter.if = (condition, do_when_true, do_when_false)` lets you run different rule overrides or prints depending on which branch is taken. Use `pass` and `reject` to force the verdict. Multiple `filter.if` lines all have to pass for a trade to fire.",
    default: "",
    examples: [
      { snippet: "filter.if = ADX > 25 && close > EMA20", scenario: "Only trade in a strong uptrend." },
      { snippet: "filter.if = (ADX > 25, rules.stopLossPoints = 8, rules.stopLossPoints = 15)", scenario: "Use a tight stop in strong trends, a wider one in weak conditions." },
      { snippet: 'filter.if = (volume(14) > 100, , print("weak vol"); reject)', scenario: 'Reject trades on weak volume and print a diagnostic.' },
    ],
  },
  {
    path: "filter.long.if",
    type: "directive",
    section: "Filters — Conditional",
    description: "Same as `filter.if` but ONLY applies to long trades. Short trades skip this filter entirely. Saves you from having to write `direction > 0 && ...` everywhere.",
    default: "",
    examples: [
      { snippet: "filter.long.if = close > EMA(200)", scenario: "Only allow longs when price is above the long-term trend line." },
    ],
  },
  {
    path: "filter.short.if",
    type: "directive",
    section: "Filters — Conditional",
    description: "Same as `filter.if` but ONLY applies to short trades.",
    default: "",
    examples: [
      { snippet: "filter.short.if = close < EMA(200)", scenario: "Only allow shorts when price is below the long-term trend line." },
    ],
  },

  // ── Signal-based exits (Script v2.2) ──────────────────────────────────
  // `exit.if = <bool-expr>` closes the open trade at the END of any bar
  // (after the entry bar) where the expression is truthy. Mirrors the
  // filter.if family in shape — three path variants control direction,
  // multiple lines OR together. Independent of and complementary to
  // SL/TP/trail/timer; whichever exit triggers first wins. The bar's
  // close is the exit price; the trade reports exitReason "signal".
  {
    path: "exit.if",
    type: "directive",
    section: "Risk rules — Exits",
    description:
      "Close the trade at the end of any bar (after entry) where this expression is truthy. The most flexible exit — write any boolean expression you'd put in a filter and the simulator will check it bar-by-bar. Multiple `exit.if` lines all OR together — any one firing closes the trade. NaN values fall through (the bar walk continues), same as filter.if. Independent of SL/TP/trail; whichever fires first wins.",
    default: "",
    examples: [
      { snippet: "exit.if = ADX(14) < 18", scenario: "Bail out when the trend dies — exit as soon as ADX falls below 18." },
      { snippet: "exit.if = close < EMA(20)", scenario: "Trend-follow exit: close the moment price loses the 20-bar trend line." },
      { snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nexit.if = abs((close - kf.x) / kf.sigma) < 0.25", scenario: "Mean-reversion exit — close once price has reverted within 0.25σ of the Kalman fair-value estimate." },
    ],
  },
  {
    path: "exit.long.if",
    type: "directive",
    section: "Risk rules — Exits",
    description:
      "Same as `exit.if` but ONLY applies to long trades. Saves you from writing `direction > 0 && ...` everywhere when the exit logic is direction-specific. Short trades skip this directive entirely.",
    default: "",
    examples: [
      { snippet: "exit.long.if = close < EMA(50)", scenario: "Close longs the moment price drops back below the 50-bar EMA." },
      { snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nexit.long.if = cross_up(close, kf.x)", scenario: "Mean-reversion long exit — close when price crosses back up through the Kalman fair value." },
    ],
  },
  {
    path: "exit.short.if",
    type: "directive",
    section: "Risk rules — Exits",
    description:
      "Same as `exit.if` but ONLY applies to short trades. Long trades skip this directive entirely.",
    default: "",
    examples: [
      { snippet: "exit.short.if = close > EMA(50)", scenario: "Close shorts the moment price reclaims the 50-bar EMA." },
      { snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nexit.short.if = cross_down(close, kf.x)", scenario: "Mean-reversion short exit — close when price crosses back down through the Kalman fair value." },
    ],
  },

  // ── Optimization (Script v3) ─────────────────────────────────────────
  {
    path: "OptimizeAll",
    type: "boolean",
    section: "Optimization",
    description:
      "When `true`, all `Optimize.X.Y(...)` lines tune together as a team (and must measure the same thing). When `false` (default), each one tunes its own number on its own.",
    default: false,
    enumerable: true,
    examples: [
      { snippet: "OptimizeAll = true", scenario: "Tune all your Optimize-driven values together — useful when stops and targets need to balance each other." },
    ],
  },
  {
    path: "Warmup",
    type: "boolean",
    section: "Optimization",
    description:
      "Controls whether warmup trades (early ones used to fill Optimize's window) show up in your final stats. `true` (default) keeps them. `false` hides them so stats reflect only the optimized phase.",
    default: true,
    enumerable: true,
    examples: [
      { snippet: "Warmup = false", scenario: "Cleaner stats — only count trades that ran with optimized values." },
    ],
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
    delta?: {
      enabled?: boolean;
      min?: number;
      max?: number;
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
  // Conditional exits — multiple `exit.if[.long|.short] = ...` lines
  // accumulate. ANY of them firing at any bar (after entry) closes the
  // trade with reason "signal" (OR semantics). See ExitIfDirective for
  // the per-direction scope semantics. Empty/absent → no signal-based
  // exits and the simulator's traditional SL/TP/trail/timer rules are
  // the only exit paths.
  exitIfs?: ExitIfDirective[];
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
  /** Direction this filter applies to. Set by the parser based on the
   *  LHS path: `filter.if` → undefined (both), `filter.long.if` →
   *  "long" (skipped on short trades — auto-pass), `filter.short.if` →
   *  "short" (skipped on long trades — auto-pass). The runtime checks
   *  this against `zone.direction` before evaluating the cond. */
  scope?: "long" | "short";
}

// ─── exit.if directive types ───────────────────────────────────────────
//
// `exit.if = <bool-expression>` closes the current trade at the END of any
// bar (after the entry bar) where the expression is truthy. Same NaN-as-
// fail discipline as filter.if — NaN means "no decision, keep walking."
// Three path variants control which trades the directive applies to:
//
//   exit.if         → both long and short trades
//   exit.long.if    → long-only (skipped on short trades)
//   exit.short.if   → short-only
//
// Multiple lines of the same path accumulate and OR together: ANY truthy
// expression triggers the exit. The exit price is the bar's CLOSE (same
// convention as the timed exit) and the exit reason is "signal".
//
// The shape is deliberately a stripped-down FilterIfDirective — same
// `cond + scope + source + referencedVarNames` core, but no actions, no
// nested directives, no verdict markers. An exit signal has only one
// effect (close the trade), so the action sub-DSL would be dead weight.

/** A parsed `exit.if[.long|.short] = <bool-expr>` directive. The runtime
 *  evaluates `cond` at every bar after entry; on a finite-truthy result
 *  the trade closes at that bar's close. NaN/0/missing-data falls
 *  through and the bar walk continues. */
export interface ExitIfDirective {
  source: string;
  cond: Expr;
  /** Direction this exit applies to. undefined → both. Mirrors the
   *  filter.if scope semantics so users learn one rule, not two. */
  scope?: "long" | "short";
  /** Bare-ident names in `cond` resolved by the optimizer's var system
   *  (paths under `var.*` in `optimizeOverrides`). The runtime skips
   *  the directive when any referenced var is unresolved — same
   *  discipline as filter.if. Empty/undefined → no var dependencies. */
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
  // exit.if conds — included so the indicator pre-compute covers per-bar
  // exit checks. Without this, indicator references inside exit.if would
  // miss the precompute and resolve to NaN at every bar.
  if (overlay.exitIfs) {
    for (const d of overlay.exitIfs) out.push(d.cond);
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

  // Track whether we're inside a multi-line strategy DSL statement
  // (`let X = …` or `signal.long.if = …`) that wraps across newlines.
  // The strategy parser handles those; the line-based parser must not
  // emit warnings/errors for the continuation lines.
  //
  // A line continues the previous strategy DSL line when EITHER:
  //   - the previous line ended with a binary operator / comma / open
  //     paren-bracket / `=` (so it's incomplete on its own), OR
  //   - the current line starts with `&& || , + - * / %` or any other
  //     binop, which only makes sense as a continuation.
  let inStrategyContinuation = false;
  let prevEndsWithOp = false;

  function endsWithContinuationOp(line: string): boolean {
    const tail = line.replace(/\s+$/, "");
    if (tail.length < 1) return false;
    const last2 = tail.slice(-2);
    const last1 = tail.slice(-1);
    if (
      last2 === "&&" || last2 === "||" || last2 === "==" ||
      last2 === "!=" || last2 === ">=" || last2 === "<="
    ) return true;
    return "+-*/%^,<>=!([".includes(last1);
  }

  function startsWithContinuationOp(line: string): boolean {
    const lead2 = line.slice(0, 2);
    const lead1 = line[0];
    if (
      lead2 === "&&" || lead2 === "||" || lead2 === "==" ||
      lead2 === "!=" || lead2 === ">=" || lead2 === "<="
    ) return true;
    return "+-*/%^,<>)]".includes(lead1);
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const stripped = stripInlineComment(lines[i]).trim();
    if (stripped === "") {
      inStrategyContinuation = false;
      prevEndsWithOp = false;
      continue;
    }
    if (stripped.startsWith("//") || stripped.startsWith("#")) continue;

    // Strategy DSL — `let <name> = …`, `signal.long.if = …`,
    // `signal.short.if = …`. These are parsed and evaluated by the
    // strategy-evaluator module. Skip them here so the line-based DSL
    // parser doesn't try to coerce them into the config schema and
    // emit phantom "unknown path" warnings.
    if (
      /^let\s+/.test(stripped) ||
      /^signal\.(long|short)\.if\s*=/.test(stripped)
    ) {
      inStrategyContinuation = true;
      prevEndsWithOp = endsWithContinuationOp(stripped);
      continue;
    }

    // Continuation of a strategy-DSL statement (multi-line `&&` / `||`
    // / `,` / arithmetic continuation). Treat as continuation when the
    // previous line ended with an operator OR the current line starts
    // with one — covers both styles users write (trailing-op or
    // leading-op).
    if (inStrategyContinuation && (prevEndsWithOp || startsWithContinuationOp(stripped))) {
      prevEndsWithOp = endsWithContinuationOp(stripped);
      continue;
    }
    // Not a continuation — fresh statement. Reset the flag and fall
    // through to the regular path-based parser.
    inStrategyContinuation = false;
    prevEndsWithOp = false;

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
      if (path === "filter.if" || path === "filter.long.if" || path === "filter.short.if") {
        // Per-direction variants share the same parser / runtime as
        // `filter.if` — only the `scope` field on the resulting
        // directive changes. The runtime auto-passes a scoped
        // directive on the wrong-direction signal.
        const scope: "long" | "short" | undefined =
          path === "filter.long.if" ? "long" : path === "filter.short.if" ? "short" : undefined;
        // Lift any inline `Optimize.X.Y(...)` calls in the RHS to
        // synthetic var idents so the expression tokenizer (which
        // can't handle `.` inside identifiers) sees clean names.
        // Each lifted spec is registered in optimizeOverrides under
        // a `var.__opt_<n>__` path; the online optimizer drives it
        // like any explicit var declaration. Lifting is paren-aware
        // and string-aware — see liftInlineOptimize for details.
        const lifted = liftInlineOptimize(rhs, config, inlineOptimizeCounter);
        if (!lifted.ok) {
          errors.push({ line: lineNo, message: `${path}: ${lifted.error}`, severity: "error" });
          continue;
        }
        const r = parseFilterIfRhs(lifted.text);
        if (!r.ok) {
          errors.push({ line: lineNo, message: `${path}: ${r.error}`, severity: "error" });
          continue;
        }
        // Sticky modifier is parsed but the v1 runtime only honors
        // `sticky(0)` (the default — this trade only). Surface a
        // warning for any non-zero sticky so users know the directive
        // is accepted but the cross-trade behavior is deferred.
        const stickyWarn = collectStickyWarnings(r.directive);
        for (const w of stickyWarn) {
          errors.push({ line: lineNo, message: `${path}: ${w}`, severity: "warning" });
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
        if (scope) bound.scope = scope;
        config.filterIfs.push(bound);
        continue;
      }
      if (path === "exit.if" || path === "exit.long.if" || path === "exit.short.if") {
        // Per-direction variants share the same simulator hook — only the
        // `scope` field differs. The runtime auto-skips a scoped directive
        // on the wrong-direction trade. RHS is a single boolean expression
        // (no 3-arg form, no actions); same compile path the entry-context
        // evaluator uses elsewhere, so KALMAN_OU/EMA/etc. all work.
        const scope: "long" | "short" | undefined =
          path === "exit.long.if" ? "long" : path === "exit.short.if" ? "short" : undefined;
        // Lift inline Optimize() calls to synthetic vars first, same as
        // filter.if, so users can write `exit.if = close < EMA(Optimize.X.Y(...))`.
        const lifted = liftInlineOptimize(rhs, config, inlineOptimizeCounter);
        if (!lifted.ok) {
          errors.push({ line: lineNo, message: `${path}: ${lifted.error}`, severity: "error" });
          continue;
        }
        const c = compileExpr(lifted.text);
        if (!c.ok) {
          errors.push({ line: lineNo, message: `${path}: ${c.error}`, severity: "error" });
          continue;
        }
        // Inline active var bindings so the per-bar evaluator sees a
        // fully resolved tree (mirrors the filter.if treatment).
        const boundCond = applyBindings(c.expr, bindings);
        const directive: ExitIfDirective = {
          source: lifted.text.trim(),
          cond: boundCond,
        };
        if (scope) directive.scope = scope;
        // Same optimizer-warmup gate as filter.if — when the cond
        // references a var that hasn't warmed up, the runtime skips
        // this directive instead of NaN-rejecting every bar.
        const referencedVarNames = collectReferencedVarNames(
          boundCond,
          config.optimizeOverrides
        );
        if (referencedVarNames.size > 0) {
          directive.referencedVarNames = referencedVarNames;
        }
        config.exitIfs ??= [];
        config.exitIfs.push(directive);
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
      // Emit at the path matching the directive's scope so a
      // round-trip preserves long/short selectivity. Undefined scope
      // emits as the original `filter.if` (both directions).
      const lhs =
        d.scope === "long" ? "filter.long.if" : d.scope === "short" ? "filter.short.if" : "filter.if";
      out.push(`${lhs} = ${d.source}`);
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
    out.push("// Or, equivalently, the per-side variants — auto-pass on the wrong side:");
    out.push("// filter.long.if  = close > EMA(20)");
    out.push("// filter.short.if = close < EMA(20)");
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
      delta: { ...base.filters.delta, ...(patch.filters?.delta ?? {}) },
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
      delta: { enabled: false, min: -1, max: 1 },
    },
  };
}
