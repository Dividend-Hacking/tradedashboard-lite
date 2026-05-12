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
import { EXPR_SYMBOLS, SUMMARY_SYMBOLS, type ExampleEntry } from "@/lib/utils/script-expr";
import { downloadScriptReferenceMarkdown } from "@/lib/utils/script-reference-export";

// ─── Curated documentation groups ───────────────────────────────────────────
//
// The raw EXPR_SYMBOLS / SUMMARY_SYMBOLS arrays are exhaustive — they list
// every variant the parser accepts (ATR, ATR14, EMA20, EMA50, EMA200, …)
// because the editor's autocomplete needs the full inventory. For the docs
// page we collapse the PERIOD VARIANTS of a single indicator into one card
// (EMA20/EMA50/EMA200 share an EMA[period] card) — but each conceptually
// distinct indicator gets its OWN card with a tailored description and
// example. The only multi-name cards are mathematically-inseparable
// component bundles (BB upper/mid/lower/width/%B, MACD line/signal/hist,
// Ichimoku tenkan/kijun/senkouA/senkouB/chikou, Heiken Ashi open/high/
// low/close, Stoch K/D, Keltner upper/mid/lower, Donchian upper/lower/
// mid) where five near-duplicate cards would just be noise.
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
  /** Worked examples — code snippet + plain-English scenario. */
  examples?: ExampleEntry[];
  /** Group bucket for the docs page (e.g. "Moving averages",
   *  "Volatility & range"). The renderer inserts a visible group
   *  heading whenever consecutive cards transition to a new group, so
   *  long lists scan-read like a reference book instead of a flat
   *  dump. Required field — keep families ordered by group below. */
  group: string;
}

// Group labels — kept as constants so a typo doesn't silently fragment a
// group. Any string passed to IndicatorFamily.group must match one of these.
const G_TREND_MA = "Moving averages (smoothed trend lines)";
const G_TREND_DIR = "Trend direction & strength";
const G_MOMENTUM = "Momentum & oscillators";
const G_VOLATILITY = "Volatility & range";
const G_BANDS = "Bands & channels";
const G_VOLUME = "Volume & money flow";
const G_STATS = "Statistical";
const G_BAR_SHAPE = "Bar shape & reference prices";
const G_ORDER_FLOW = "Order flow (requires bid/ask data)";
const G_VOLUME_PROFILE = "Volume profile (requires tick data)";
// Subgroups inside the former G_TICK_MICRO section. Each maps to a
// natural sub-family that already existed as a comment block in the old
// flat list; promoting them to first-class groups gives the renderer a
// visible divider between them so the ~20+ tick-related cards stay
// scannable instead of running together as one wall of cards.
const G_TICK_AGGRESSOR = "Tick aggressor flow (requires tick data)";
const G_TICK_QUOTE = "Top-of-book quote (requires v2 tick data)";
const G_TICK_NODES = "Volume-profile nodes — HVN / LVN (requires tick data)";
const G_TICK_FOOTPRINT = "Footprint imbalance (requires tick bid/ask)";
const G_TICK_SWEEP = "Sweeps & icebergs (requires v2 tick data)";
const G_BAR_SMOOTHING = "Bar smoothing & compression";
// Subgroups inside the former G_LOOKBACK section. Time-series lookback
// (HHV, close_n, …) is conceptually different from tick/point unit
// conversion helpers — keep them separated visually.
const G_LOOKBACK_TS = "Lookback helpers — time series";
const G_TICK_CONV = "Lookback helpers — tick / point conversion";
const G_ADVANCED = "Advanced — strategy DSL only";

const INDICATOR_FAMILIES: IndicatorFamily[] = [
  // ─── Moving averages ──────────────────────────────────────────────────
  {
    group: G_TREND_MA,
    headline: "EMA[period]",
    forms: ["EMA(period)", "EMA20", "EMA50", "EMA200"],
    description:
      "A line that follows price but smooths out the noise. Newer prices count more than older ones, so it reacts faster than a plain average. Common periods: 20 (short), 50 (mid), 200 (long).",
    examples: [
      {
        snippet: "filter.if = close > EMA20",
        scenario:
          "Only take trades when price is above the fast trend line — keeps you on the bullish side.",
      },
      {
        snippet: "rules.takeProfitPoints = abs(close - EMA50)",
        scenario: "Aim for the medium trend line as your profit target.",
      },
    ],
  },
  {
    group: G_TREND_MA,
    headline: "SMA[period]",
    forms: ["SMA(period)", "SMA20", "SMA50", "SMA200"],
    description:
      "A line that's just the plain average of the last N closes. Treats every bar equally, so it's slower to react than EMA. Use when you want a steadier, less twitchy trend reading.",
    examples: [
      {
        snippet: "filter.if = close > SMA200",
        scenario:
          "Only trade in long-term uptrends — skip everything when price is below the 200-bar average.",
      },
    ],
  },
  {
    group: G_TREND_MA,
    headline: "WMA[period]",
    forms: ["WMA(period)", "WMA20"],
    description:
      "A moving average that gives more weight to recent bars and less to older ones. Reacts faster than SMA but smoother than EMA. Technical: linear weights 1..N over the last N closes.",
    examples: [
      {
        snippet: "filter.if = close > WMA(20)",
        scenario: "Take trades only when price is above a recency-weighted trend line.",
      },
    ],
  },
  {
    group: G_TREND_MA,
    headline: "HMA[period]",
    forms: ["HMA(period)", "HMA20"],
    description:
      "Hull Moving Average — designed to follow price quickly without lagging behind much. Looks smoother than EMA but reacts faster. Good for trend lines you want to feel \"current\".",
    examples: [
      {
        snippet: "filter.if = close > HMA(20)",
        scenario: "Trade with trend using a fast, smooth trend line.",
      },
    ],
  },
  {
    group: G_TREND_MA,
    headline: "DEMA[period]",
    forms: ["DEMA(period)", "DEMA20"],
    description:
      "Double Exponential Moving Average — runs an EMA on top of another EMA, then subtracts the second-order lag away. Net effect: tracks price more tightly than a plain EMA of the same period, with less lag during turns. Reach for it when EMA feels a step behind.",
    examples: [
      {
        snippet: "filter.if = close > DEMA(20)",
        scenario: "Trade with trend using a low-lag EMA variant that turns faster than EMA20.",
      },
    ],
  },
  {
    group: G_TREND_MA,
    headline: "TEMA[period]",
    forms: ["TEMA(period)", "TEMA20"],
    description:
      "Triple Exponential Moving Average — applies DEMA's lag-cancellation one more layer deep. Even more responsive than DEMA at the same period; great as the \"fast\" line in a crossover where you still want some smoothing.",
    examples: [
      {
        snippet: "filter.if = close > TEMA(20) && TEMA(20) > TEMA(50)",
        scenario: "Take longs only when price is above the fast TEMA AND the fast TEMA is above the slow TEMA.",
      },
    ],
  },
  {
    group: G_TREND_MA,
    headline: "VWMA[period]",
    forms: ["VWMA(period)", "VWMA20"],
    description:
      "A moving average where high-volume bars count more than low-volume ones. Tracks where the real money is being put to work, not just where price has been. Technical: sum(close × volume) / sum(volume).",
    examples: [
      {
        snippet: "filter.if = close > VWMA(20)",
        scenario: "Trade when price is above the volume-heavy average — confirms trend with real activity.",
      },
    ],
  },

  // ─── Trend direction & strength ──────────────────────────────────────
  {
    group: G_TREND_DIR,
    headline: "ADX[period]",
    forms: ["ADX(period)", "ADX (= ADX(14))", "ADX14"],
    description:
      "Measures how strong the trend is, from 0 to 100. Doesn't care about direction — just whether price is going somewhere or chopping around. Above 25 usually means a real trend; below 20 means it's drifting.",
    examples: [
      {
        snippet: "filter.if = ADX > 25",
        scenario: "Only trade when there's a clear trend — skip choppy sideways markets.",
      },
      {
        snippet: "filter.if = ADX(14) < 20",
        scenario:
          "Only trade in calm, range-bound conditions — useful for mean-reversion strategies.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "DIplus[period]",
    forms: ["DIplus(period=14)"],
    description:
      "The upside half of the directional movement system. Measures how much the recent highs have been pushing up vs the prior bars. Bigger DI+ = stronger upside push. Pair with ADX (overall strength) and DIminus (the downside half) for a complete read.",
    examples: [
      {
        snippet: "filter.if = DIplus(14) > DIminus(14) && ADX > 25",
        scenario: "Only take longs when bullish push beats bearish push AND there's real trend strength behind it.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "DIminus[period]",
    forms: ["DIminus(period=14)"],
    description:
      "The downside half of the directional movement system. Measures how much the recent lows have been dragging down. Bigger DI- = stronger downside push. When DI- crosses above DI+, it usually marks a switch into a downtrend.",
    examples: [
      {
        snippet: "filter.if = DIminus(14) > DIplus(14) && ADX > 25",
        scenario: "Only take shorts when bearish push beats bullish push AND the trend is strong.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "Supertrend(period=10, mult=3)",
    forms: ["Supertrend(period, mult)", "Supertrend (= Supertrend(10, 3))"],
    description:
      "A single line that flips above and below price as the trend changes. Positive value = uptrend (line is below price). Negative value = downtrend (line is above). Easy way to know whether to be long or short.",
    examples: [
      {
        snippet: "filter.if = Supertrend > 0",
        scenario: "Only take long trades when Supertrend says we're in an uptrend.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "PSAR(step=0.02, max=0.2)",
    forms: ["PSAR(step, max)", "PSAR (= PSAR(0.02, 0.2))"],
    description:
      "Parabolic SAR — those little dots that appear above or below price on a chart. When dots are below price, we're in an uptrend. When dots flip above, the trend may have changed. Often used as a trailing stop.",
    examples: [
      {
        snippet: "filter.if = close > PSAR()",
        scenario: "Only trade longs when price is above the PSAR dots (uptrend confirmed).",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "Aroon_up[period]",
    forms: ["Aroon_up(period=14)"],
    description:
      "How fresh the recent N-bar high is, scored 0 to 100. 100 means \"a new high just printed this bar\". 0 means \"the high was N bars ago and we haven't beaten it since\". High values flag active upside momentum.",
    examples: [
      {
        snippet: "filter.if = Aroon_up(14) > 80",
        scenario: "Only trade longs when a new 14-bar high happened very recently.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "Aroon_down[period]",
    forms: ["Aroon_down(period=14)"],
    description:
      "How fresh the recent N-bar low is, scored 0 to 100. 100 means \"a new low just printed this bar\". 0 means the low was made N bars ago and hasn't been retested. High values flag active downside momentum.",
    examples: [
      {
        snippet: "filter.if = Aroon_down(14) > 80",
        scenario: "Only take shorts when a new 14-bar low just printed — fresh downside momentum.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "Aroon_osc[period]",
    forms: ["Aroon_osc(period=14)"],
    description:
      "Aroon_up minus Aroon_down on a single −100 to +100 scale. Positive = the recent high is fresher than the recent low (uptrend bias). Negative = the recent low is fresher (downtrend bias). One-shot trend-direction filter.",
    examples: [
      {
        snippet: "filter.if = Aroon_osc(14) > 0",
        scenario: "Only trade in the direction of the current Aroon trend bias.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "VortexPlus[period]",
    forms: ["VortexPlus(period=14)"],
    description:
      "The bullish half of the Vortex indicator — measures upward price movement between today and the prior bar, normalized by true range. Rising VI+ that crosses above VI- typically marks a fresh bullish turn.",
    examples: [
      {
        snippet: "filter.if = VortexPlus(14) > VortexMinus(14)",
        scenario: "Only take longs when the bullish vortex line is dominant.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "VortexMinus[period]",
    forms: ["VortexMinus(period=14)"],
    description:
      "The bearish half of the Vortex indicator — measures downward price movement between today and the prior bar, normalized by true range. Rising VI- that crosses above VI+ typically marks a fresh bearish turn.",
    examples: [
      {
        snippet: "filter.if = VortexMinus(14) > VortexPlus(14)",
        scenario: "Only take shorts when the bearish vortex line is dominant.",
      },
    ],
  },
  {
    group: G_TREND_DIR,
    headline: "Ichimoku_tenkan / kijun / senkouA / senkouB / chikou",
    forms: [
      "Ichimoku_tenkan(period=9)",
      "Ichimoku_kijun(period=26)",
      "Ichimoku_senkouA(fast=9, slow=26)",
      "Ichimoku_senkouB(period=52)",
      "Ichimoku_chikou(period=26)",
    ],
    description:
      "Ichimoku is a multi-line system that paints a \"cloud\" around price. Tenkan = fast trend midpoint. Kijun = slow trend midpoint. Senkou A/B = the cloud edges. Chikou = a comparison line. Price above the cloud = bullish, below = bearish.",
    examples: [
      {
        snippet: "filter.if = close > Ichimoku_kijun(26)",
        scenario: "Only take longs when price is above the slow Ichimoku midline.",
      },
    ],
  },

  // ─── Momentum & oscillators ──────────────────────────────────────────
  {
    group: G_MOMENTUM,
    headline: "RSI[period]",
    forms: ["RSI(period)", "RSI (= RSI(14))", "RSI14"],
    description:
      "A 0–100 score that says how \"overbought\" or \"oversold\" the market looks. Above 70 = recently a lot of buying (might be too high). Below 30 = recently a lot of selling (might be too low). Standard period 14.",
    examples: [
      {
        snippet: "filter.if = RSI(14) < 30",
        scenario:
          "Only trade when the market looks oversold — classic mean-reversion setup.",
      },
      {
        snippet: "filter.if = RSI > 50 && close > EMA20",
        scenario:
          "Confirm bullish bias with both momentum and trend before taking a long.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "ROC[period]",
    forms: ["ROC(period)", "ROC10"],
    description:
      "Rate of Change — how far price has moved over the last N bars, expressed as a percent. Positive = price is higher than N bars ago, negative = lower. Scale-independent, so the same threshold works across instruments at different price levels.",
    examples: [
      {
        snippet: "filter.if = ROC(10) > 0",
        scenario: "Only trade when price is higher than it was 10 bars ago.",
      },
      {
        snippet: "filter.if = ROC(20) > 1.0",
        scenario: "Only take longs when price has gained more than 1% over the last 20 bars — momentum threshold.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "MOM[period]",
    forms: ["MOM(period)", "MOM10"],
    description:
      "Momentum — the raw price change in POINTS from N bars ago to now (close minus close_n(N)). Positive means up, negative means down. Useful when you want to size a stop or target against actual price travel.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = abs(MOM(20)) * 1.5",
        scenario: "Size your target relative to how much price has moved over the last 20 bars.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "CCI[period]",
    forms: ["CCI(period)", "CCI20"],
    description:
      "Commodity Channel Index — measures how far price has wandered from its average. Above +100 = unusually high; below −100 = unusually low. Useful for spotting extended moves.",
    examples: [
      {
        snippet: "filter.if = CCI(20) > 100",
        scenario: "Only take longs when price has stretched well above its recent average.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "WilliamsR[period]",
    forms: ["WilliamsR(period)"],
    description:
      "A −100 to 0 score showing where price sits inside its recent high–low range. −20 = near the top (overbought), −80 = near the bottom (oversold). Like RSI but on a different scale.",
    examples: [
      {
        snippet: "filter.if = WilliamsR(14) < -80",
        scenario: "Only trade when price is sitting near the bottom of its recent range.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "TRIX[period]",
    forms: ["TRIX(period)", "TRIX14"],
    description:
      "A momentum reading run through three layers of EMA smoothing — the rate of change of a triple-smoothed price. Crosses zero from below = bullish momentum building; from above = bearish. Lags more than ROC but is far less twitchy.",
    examples: [
      {
        snippet: "filter.if = TRIX(14) > 0",
        scenario: "Only trade when smoothed momentum is positive (uptrend).",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "MFI[period]",
    forms: ["MFI(period)", "MFI14"],
    description:
      "Money Flow Index — like RSI, but each bar's typical-price move is weighted by its volume before the up/down comparison. 0–100 scale; above 80 = heavy buying pressure, below 20 = heavy selling. Catches divergences RSI misses because price moved without volume.",
    examples: [
      {
        snippet: "filter.if = MFI(14) < 20",
        scenario: "Trade oversold conditions confirmed by volume.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "Stoch_K / Stoch_D",
    forms: [
      "Stoch_K(period)",
      "Stoch_D(period, smoothK=3, smoothD=3)",
    ],
    description:
      "Stochastic — a 0–100 reading of where price closed within its recent high–low range. %K is the fast version, %D is a smoothed slower line. Above 80 = top of the range (overbought); below 20 = bottom (oversold).",
    examples: [
      {
        snippet: "filter.if = Stoch_K(14) < 20",
        scenario: "Trade only when the fast stochastic shows oversold conditions.",
      },
      {
        snippet: "filter.if = Stoch_K(14) > Stoch_D(14)",
        scenario: "Take longs when the fast line crosses above the slow line.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "MACD_line / MACD_signal / MACD_hist",
    forms: [
      "MACD_line(fast, slow)",
      "MACD_signal(fast, slow, signal=9)",
      "MACD_hist(fast, slow, signal=9)",
    ],
    description:
      "MACD = Moving Average Convergence/Divergence. The line shows momentum (fast trend minus slow trend). The signal is a smoothed version of the line. The histogram is the gap between them — positive and growing = bulls in control. Classic settings are (12, 26, 9).",
    examples: [
      {
        snippet: "filter.if = MACD_hist(12, 26) > 0",
        scenario: "Only trade when the MACD histogram is positive — bullish momentum building.",
      },
      {
        snippet: "filter.if = MACD_line(12, 26) > MACD_signal(12, 26)",
        scenario: "Take longs only when the fast MACD line is above its signal line.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "AO",
    forms: ["AO", "AO()"],
    description:
      "Awesome Oscillator — the simple difference between a 5-bar and 34-bar SMA of the bar's median price. Above zero = short-term average is above long-term (bullish bias). Below zero = bearish. Useful as a quick \"which side am I on\" filter.",
    examples: [
      {
        snippet: "filter.if = AO > 0",
        scenario: "Only trade longs when the Awesome Oscillator is positive.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "UO[short, mid, long]",
    forms: ["UO(short=7, mid=14, long=28)"],
    description:
      "Ultimate Oscillator — a 0–100 score that blends buying pressure across three lookback windows so a single timeframe can't dominate the reading. Above 70 = consistently strong buying across all three; below 30 = consistently weak.",
    examples: [
      {
        snippet: "filter.if = UO(7, 14, 28) > 70",
        scenario: "Only trade longs in clearly-buying conditions across multiple time windows.",
      },
    ],
  },
  {
    group: G_MOMENTUM,
    headline: "Fisher[period]",
    forms: ["Fisher(period=10)"],
    description:
      "Fisher Transform — runs price's position-in-range through an inverse-hyperbolic-tangent transform that turns a bounded 0–1 input into a sharply-peaked output. Net effect: turning points stick out as clear spikes instead of slow rolls. Especially useful for spotting tops/bottoms.",
    examples: [
      {
        snippet: "filter.if = Fisher(10) > 2",
        scenario: "Only consider mean-reversion shorts when the Fisher transform spikes into extreme overbought.",
      },
    ],
  },

  // ─── Volatility & range ──────────────────────────────────────────────
  {
    group: G_VOLATILITY,
    headline: "ATR[period]",
    forms: ["ATR(period)", "ATR (= ATR(14))", "ATR14"],
    description:
      "How much the price normally swings around in one bar. Bigger ATR = wild day, small ATR = quiet day. Great for sizing stops based on today's actual volatility instead of guessing a fixed point value.",
    examples: [
      {
        snippet: "rules.stopLossPoints = ATR * 1.5",
        scenario:
          "Set the stop to one and a half times today's typical price swing — wider on volatile days, tighter on quiet ones.",
      },
      {
        snippet: "filter.if = ATR(14) > 0.5",
        scenario:
          "Only trade when the market is moving enough — skip flat, dead sessions.",
      },
    ],
  },
  {
    group: G_VOLATILITY,
    headline: "TR",
    forms: ["TR", "TR()"],
    description:
      "True Range — how big THIS single bar was, in points. Takes the larger of: today's high-low range, the gap up from yesterday's close, or the gap down from yesterday's close. Captures opening gaps that a plain high-low range would miss.",
    examples: [
      {
        snippet: "rules.stopLossPoints = TR * 1.5",
        scenario: "Size your stop based on how big the entry bar itself was — wider after a wide entry bar.",
      },
    ],
  },
  {
    group: G_VOLATILITY,
    headline: "NATR[period]",
    forms: ["NATR(period)", "NATR14"],
    description:
      "Normalized ATR — the regular ATR(N) divided by price and expressed as a percent. Great for comparing volatility across instruments at very different price levels (a 5-point ATR is huge on ES but nothing on BTC). Also useful when a strategy needs to work across both quiet and busy regimes.",
    examples: [
      {
        snippet: "filter.if = NATR(14) > 0.5",
        scenario: "Skip days when price wiggle is less than 0.5% of price — too quiet to bother.",
      },
    ],
  },
  {
    group: G_VOLATILITY,
    headline: "HV[period]",
    forms: ["HV(period)", "HV20"],
    description:
      "Historical Volatility — the rolling standard deviation of log-returns over the last N bars, annualized to a percent. The same volatility number options traders use to price contracts. Higher HV = recent returns have been more spread out (wilder market).",
    examples: [
      {
        snippet: "filter.if = HV(20) > 30",
        scenario: "Only trade in high-vol regimes (annualized HV above 30%) — skip dead, low-vol periods.",
      },
    ],
  },
  {
    group: G_VOLATILITY,
    headline: "stdev[period]",
    forms: ["stdev(period)"],
    description:
      "How spread out price returns have been over the last N bars. Higher = wilder market, lower = calmer market. Used as a volatility gauge by Bollinger Bands and Z-score filters.",
    examples: [
      {
        snippet: "rules.stopLossPoints = stdev(20) * 100",
        scenario: "Scale your stop to recent return volatility instead of price points.",
      },
    ],
  },
  {
    group: G_VOLATILITY,
    headline: "Choppiness[period]",
    forms: ["Choppiness(period=14)"],
    description:
      "A 0–100 score answering \"is the market trending or just going sideways?\". High values (above ~62) mean lots of overlapping bars in a tight zone — sideways chop. Low values (below ~38) mean directional travel — a real trend. Great as a regime filter.",
    examples: [
      {
        snippet: "filter.if = Choppiness(14) < 38",
        scenario: "Only trade in trending conditions; skip sideways chop.",
      },
    ],
  },
  {
    group: G_VOLATILITY,
    headline: "Ulcer[period]",
    forms: ["Ulcer(period=14)"],
    description:
      "Ulcer Index — a downside-only volatility gauge. Measures the depth and duration of drawdowns over the last N bars. Unlike stdev or ATR, it ignores upside swings entirely — only painful pullbacks count. Useful for sizing risk to actual downside experience.",
    examples: [
      {
        snippet: "rules.stopLossPoints = Ulcer(14) * 2",
        scenario: "Size your stop relative to recent downside pain — wider when the asset has been bleeding, tighter when drawdowns have been shallow.",
      },
    ],
  },

  // ─── Bands & channels ────────────────────────────────────────────────
  {
    group: G_BANDS,
    headline: "BB_upper / BB_mid / BB_lower / BB_width / BB_percent",
    forms: [
      "BB_mid(period)",
      "BB_upper(period, mult=2)",
      "BB_lower(period, mult=2)",
      "BB_width(period, mult=2)",
      "BB_percent(period, mult=2)",
    ],
    description:
      "Bollinger Bands draw an upper and lower band around price based on how volatile the market is. mid = the middle line (an average). upper/lower = how far price normally strays. width = how stretched the bands are. %B = where price sits inside the bands (0 = bottom, 1 = top).",
    examples: [
      {
        snippet: "filter.if = close < BB_lower(20)",
        scenario:
          "Trade longs only when price has dropped below the lower band — possible mean-reversion bounce.",
      },
      {
        snippet: "filter.if = BB_width(20) < 0.05",
        scenario:
          "Only trade when the bands are squeezed tight — often happens before big moves.",
      },
      {
        snippet: "filter.if = BB_percent(20) > 0.95",
        scenario: "Only take entries when price is hugging the top of its band.",
      },
    ],
  },
  {
    group: G_BANDS,
    headline: "Keltner_upper / Keltner_mid / Keltner_lower",
    forms: [
      "Keltner_mid(period)",
      "Keltner_upper(period, mult=2)",
      "Keltner_lower(period, mult=2)",
    ],
    description:
      "Keltner Channels draw an upper and lower band around price using ATR (typical wiggle) instead of standard deviation. Compared to Bollinger Bands they hold their shape better in strong trends, so they're nice for trend-following entries.",
    examples: [
      {
        snippet: "filter.if = close > Keltner_upper(20)",
        scenario:
          "Only take longs when price has broken above the upper Keltner band — strong-trend breakout.",
      },
    ],
  },
  {
    group: G_BANDS,
    headline: "Donchian_upper / Donchian_lower / Donchian_mid",
    forms: [
      "Donchian_upper(period)",
      "Donchian_lower(period)",
      "Donchian_mid(period)",
    ],
    description:
      "Donchian draws a channel from the highest high and lowest low of the last N bars. Breakouts above the upper edge or below the lower edge often mark new trends. The mid is just the average of those two.",
    examples: [
      {
        snippet: "filter.if = close > Donchian_upper(20)",
        scenario: "Only take longs on a 20-bar high breakout.",
      },
      {
        snippet: "rules.stopLossPoints = close - Donchian_lower(10)",
        scenario: "Set stop at the recent 10-bar low — let the channel define your risk.",
      },
    ],
  },

  // ─── Volume & money flow ─────────────────────────────────────────────
  {
    group: G_VOLUME,
    headline: "volume[period]",
    forms: ["volume(period)", "trailVol(period)", "volume (current bar)"],
    description:
      "How many contracts/shares traded. Without parentheses, `volume` is just THIS bar's volume. With `(period)` it's the average volume over the last N bars — useful for spotting bursts.",
    examples: [
      {
        snippet: "filter.if = volume > volume(20) * 1.5",
        scenario:
          "Only trade when this bar's volume is at least 50% above the recent average — a sign of real interest.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "OBV",
    forms: ["OBV", "OBV()"],
    description:
      "On-Balance Volume — a running tally that adds the bar's volume on up-closes and subtracts it on down-closes. Cumulative, so absolute values aren't meaningful — what matters is the slope and whether it's confirming or diverging from price.",
    examples: [
      {
        snippet: "filter.if = OBV > EMA(20)",
        scenario: "Take longs only when OBV is above its 20-bar trend — volume flow confirms price strength.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "AD",
    forms: ["AD", "AD()"],
    description:
      "Accumulation/Distribution line — like OBV but instead of all-or-nothing on up/down close, each bar contributes a fraction of its volume based on where it closed inside the bar's range. A bar that closed at the top contributes +volume; mid-range contributes near zero. Cumulative.",
    examples: [
      {
        snippet: "filter.if = AD > AD - 1",
        scenario: "Take longs only when accumulation pressure is rising — a finer read than OBV's binary up/down rule.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "CMF[period]",
    forms: ["CMF(period)", "CMF20"],
    description:
      "Chaikin Money Flow — the rolling N-bar normalized version of AD. Outputs a −1 to +1 score: positive = N-bar buying pressure, negative = selling. Standard thresholds: above +0.1 = strong buying, below −0.1 = strong selling. Bounded so the same threshold works across instruments and timeframes.",
    examples: [
      {
        snippet: "filter.if = CMF(20) > 0.1",
        scenario: "Only trade longs when the last 20 bars show clear buying pressure.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "VWAP[period]",
    forms: ["VWAP(period)"],
    description:
      "Volume-Weighted Average Price (rolling N-bar). Sums price×volume across the last N bars and divides by total volume — gives you the \"fair value\" price level where the most contracts have traded. Acts as a magnet: price often reverts toward it intraday.",
    examples: [
      {
        snippet: "filter.if = close > VWAP(50)",
        scenario: "Only take longs when price is above the 50-bar volume-weighted fair-value line.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "KVO[fast, slow]",
    forms: ["KVO(fast=34, slow=55)"],
    description:
      "Klinger Volume Oscillator — a MACD-style indicator computed on volume force (volume signed by accumulation/distribution) instead of price. Crosses zero from below = bullish volume momentum turn; from above = bearish. Useful for catching divergences between price and volume thrust.",
    examples: [
      {
        snippet: "filter.if = KVO(34, 55) > 0",
        scenario: "Only take longs when the volume-momentum oscillator is positive — buying force dominates.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "ForceIndex[period]",
    forms: ["ForceIndex(period=13)"],
    description:
      "Force Index — combines price change and volume into a single number. (close − close[1]) × volume, smoothed over N bars. Positive and rising = buyers driving the move with size; negative and falling = sellers. Slopes matter more than levels.",
    examples: [
      {
        snippet: "filter.if = ForceIndex(13) > 0",
        scenario: "Only take longs when buyers are driving recent moves with real volume.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "EMV[period]",
    forms: ["EMV(period=14)"],
    description:
      "Ease of Movement — measures how much price moved per unit of volume. High positive = price marched up on light volume (low resistance to upside). Negative = price fell easily. A way to detect when little volume is producing big moves (low liquidity).",
    examples: [
      {
        snippet: "filter.if = EMV(14) > 0",
        scenario: "Only take longs when recent up-moves have come with low resistance (light volume needed to move price).",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "NVI",
    forms: ["NVI", "NVI()"],
    description:
      "Negative Volume Index — a cumulative index that ONLY updates on bars where volume FELL vs the prior bar. The theory: smart money trades on quiet days, so NVI's trend reflects informed positioning. Compare its slope to a long-term MA of itself.",
    examples: [
      {
        snippet: "filter.if = NVI > NVI - 1",
        scenario: "Only take longs when the smart-money index is rising — implied informed buying on quiet days.",
      },
    ],
  },
  {
    group: G_VOLUME,
    headline: "PVI",
    forms: ["PVI", "PVI()"],
    description:
      "Positive Volume Index — the complement of NVI. Only updates on bars where volume ROSE vs the prior bar. Reflects what the crowd does on busy/news days. Pairs naturally with NVI as a smart-money-vs-crowd diagnostic.",
    examples: [
      {
        snippet: "filter.if = PVI > NVI",
        scenario: "Take longs only when the crowd-activity index outpaces the smart-money index — strong consensus buying.",
      },
    ],
  },

  // ─── Statistical ─────────────────────────────────────────────────────
  {
    group: G_STATS,
    headline: "Zscore[period]",
    forms: ["Zscore(period)"],
    description:
      "How many standard deviations the current close is above or below its N-bar mean. ±1 is normal noise, ±2 is unusual, ±3 is extreme. Classic mean-reversion entry trigger and the natural scale for the KALMAN_OU innovation.",
    examples: [
      {
        snippet: "filter.if = abs(Zscore(20)) > 2",
        scenario: "Only trade when price is unusually far from its 20-bar average — mean-reversion setup.",
      },
    ],
  },
  {
    group: G_STATS,
    headline: "LRSlope[period]",
    forms: ["LRSlope(period)"],
    description:
      "Slope of the linear-regression best-fit line through the last N closes. Positive = uptrend, negative = downtrend. Magnitude tells you how steep the trend is in points-per-bar. Less noisy than \"close > close N bars ago\" because every bar in the window influences the answer.",
    examples: [
      {
        snippet: "filter.if = LRSlope(50) > 0",
        scenario: "Take longs only when the 50-bar best-fit line is sloping up — clean trend filter.",
      },
    ],
  },
  {
    group: G_STATS,
    headline: "LRIntercept[period]",
    forms: ["LRIntercept(period)"],
    description:
      "The y-intercept of the linear-regression line over the last N closes — i.e. what the best-fit line predicts at bar 0 of the window. Useful when you want to project where the line started vs where it ends; mostly used as input to derived calcs rather than a direct filter.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = abs(close - LRIntercept(20))",
        scenario: "Target the regression line's starting value — uncommon but useful in regression-residual strategies.",
      },
    ],
  },
  {
    group: G_STATS,
    headline: "LRValue[period]",
    forms: ["LRValue(period)"],
    description:
      "The CURRENT-bar value of the linear-regression line — basically LRSlope×N + LRIntercept. Acts as a smooth \"fair value\" line that lags less than an SMA because it's the best-fit forecast rather than a centered average. Great mean-reversion target.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = abs(close - LRValue(20))",
        scenario: "Target the linear-regression \"fair value\" line for mean-reversion exits.",
      },
    ],
  },
  {
    group: G_STATS,
    headline: "R2[period]",
    forms: ["R2(period)"],
    description:
      "Coefficient of determination — how cleanly the linear-regression line ACTUALLY fits the last N closes. 1.0 = price is essentially a straight line, 0 = no fit. Pair with LRSlope to demand both \"there's a trend\" AND \"the trend is clean\".",
    examples: [
      {
        snippet: "filter.if = LRSlope(50) > 0 && R2(50) > 0.7",
        scenario: "Only trade in clean, well-defined uptrends — slope positive AND fit quality above 70%.",
      },
    ],
  },
  {
    group: G_STATS,
    headline: "znorm[expr, period]",
    forms: ["znorm(expr, period)"],
    description:
      "Rolling z-score of ANY expression over the last N bars. Where Zscore is hard-wired to price, znorm normalizes whatever you put inside — `znorm(spread(20), 200)`, `znorm(RSI(14) - 50, 100)`, `znorm(quote_imbalance(20) - tick_imbalance(20), 200)`. Output is unbounded but typically lives in [-3, +3]; 0 means \"average\", ±2 means \"unusually far from its N-bar baseline\". The period MUST be a literal positive integer (the engine bakes it into the precompute cache key). Returns NaN inside the warmup window; returns 0 on a perfectly flat window.",
    examples: [
      {
        snippet: "let qz = znorm(quote_imbalance(20), 200)\nlet sz = znorm(spread(20), 200)\nfilter.if = qz - sz > 1.5",
        scenario: "Bring two differently-scaled microstructure metrics onto the same z-score scale, then combine them — buyer-side imbalance with a tight book.",
      },
    ],
  },
  {
    group: G_STATS,
    headline: "mmnorm[expr, period]",
    forms: ["mmnorm(expr, period)"],
    description:
      "Rolling min-max normalization of ANY expression over the last N bars — maps the current value to [0, 1] using the window's min and max. 0 = lowest the inner expression has been in N bars, 1 = highest. Bounded sibling to znorm — pair them when you want one metric on a fixed scale and another as a free-floating signed deviation. Period MUST be a literal positive integer. Returns NaN inside warmup; returns 0.5 when min == max.",
    examples: [
      {
        snippet: "filter.if = mmnorm(spread(20), 200) < 0.3",
        scenario: "Only enter when the current spread sits in the tightest 30% of the last 200 bars — a liquidity-aware gate that adapts to the session's own regime.",
      },
    ],
  },

  // ─── Bar shape & reference prices ────────────────────────────────────
  {
    group: G_BAR_SHAPE,
    headline: "range",
    forms: ["range"],
    description:
      "The total height of the current candle — high minus low, in points. The full span of price movement during this bar. Great for sizing stops/targets to the actual volatility of the entry bar.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = range * 2",
        scenario: "Set the target at twice the entry candle's full range.",
      },
    ],
  },
  {
    group: G_BAR_SHAPE,
    headline: "body",
    forms: ["body"],
    description:
      "Signed open-to-close size of the current candle. Positive = green/bullish (close above open), negative = red/bearish (close below open). Magnitude = how decisive the bar was. A bar with a tiny body is indecision; a big body is conviction.",
    examples: [
      {
        snippet: "filter.if = body > 0",
        scenario: "Take longs only when the entry candle is green (close above open).",
      },
    ],
  },
  {
    group: G_BAR_SHAPE,
    headline: "upper_wick",
    forms: ["upper_wick"],
    description:
      "Length of the upper tail of the current candle — the part above the body. Long upper wick = sellers rejected higher prices and pushed back down. Bearish footprint regardless of the candle's color.",
    examples: [
      {
        snippet: "filter.if = body < 0 && upper_wick > abs(body) * 2",
        scenario: "Take shorts only on red candles with a long upper tail — a clear rejection signature.",
      },
    ],
  },
  {
    group: G_BAR_SHAPE,
    headline: "lower_wick",
    forms: ["lower_wick"],
    description:
      "Length of the lower tail of the current candle — the part below the body. Long lower wick = buyers rejected lower prices and pushed back up. Bullish footprint regardless of color.",
    examples: [
      {
        snippet: "filter.if = body > 0 && lower_wick > body",
        scenario: "Take longs only on green candles with a long lower tail — buyers rejected lower prices.",
      },
    ],
  },
  {
    group: G_BAR_SHAPE,
    headline: "typical",
    forms: ["typical"],
    description:
      "Average of the current bar's high, low, and close — (H + L + C) / 3. The standard \"summary price\" used by VWAP, CCI, Money Flow, etc. Treats the close as one of three equally-weighted readings rather than the only thing that matters.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = abs(typical - EMA20)",
        scenario: "Aim profit at the EMA, measured from the bar's typical price.",
      },
    ],
  },
  {
    group: G_BAR_SHAPE,
    headline: "median_price",
    forms: ["median_price"],
    description:
      "Midpoint of the current bar — (H + L) / 2. Ignores the close entirely. Useful when you want a \"pure range center\" reference that isn't biased by where the bar happened to end. Used internally by Awesome Oscillator and Heiken Ashi.",
    examples: [
      {
        snippet: "filter.if = close > median_price",
        scenario: "Take longs only when the close is in the upper half of the bar's range — bullish bias within the bar.",
      },
    ],
  },
  {
    group: G_BAR_SHAPE,
    headline: "weighted_close",
    forms: ["weighted_close"],
    description:
      "A summary price that weights the close more heavily — (H + L + 2C) / 4. Halfway between `typical` and just using `close`. Smooths out wild high/low spikes while still letting the close dominate.",
    examples: [
      {
        snippet: "filter.if = weighted_close > EMA20",
        scenario: "Use a close-weighted summary as the reference for the trend filter — slightly more stable than raw close.",
      },
    ],
  },

  // ─── Lookback helpers ────────────────────────────────────────────────
  {
    group: G_LOOKBACK_TS,
    headline: "HHV[period]",
    forms: ["HHV(period)", "HHV20"],
    description:
      "Highest High Value — the highest high seen in the last N bars (including the current bar). The classic Donchian/breakout upper edge. Use for new-high breakout entries or as a resistance reference.",
    examples: [
      {
        snippet: "filter.if = close > HHV(20)",
        scenario: "Only take longs that break above the 20-bar high — a fresh new-high entry.",
      },
    ],
  },
  {
    group: G_LOOKBACK_TS,
    headline: "LLV[period]",
    forms: ["LLV(period)", "LLV20"],
    description:
      "Lowest Low Value — the lowest low seen in the last N bars (including the current bar). The mirror of HHV. Use for new-low breakdown entries, or to anchor a channel stop at recent support.",
    examples: [
      {
        snippet: "rules.stopLossPoints = close - LLV(10)",
        scenario: "Set the stop at the lowest low of the last 10 bars.",
      },
    ],
  },
  {
    group: G_LOOKBACK_TS,
    headline: "close_n(n)",
    forms: ["close_n(n)"],
    description:
      "The close of the bar N bars ago. `close_n(1)` is the previous bar's close, `close_n(5)` is 5 bars back. The standard \"yesterday's close\" lookup used for momentum comparisons, gap detection, and pattern matching.",
    examples: [
      {
        snippet: "filter.if = close > close_n(1)",
        scenario: "Only trade when this bar closed higher than the previous bar.",
      },
    ],
  },
  {
    group: G_LOOKBACK_TS,
    headline: "high_n(n)",
    forms: ["high_n(n)"],
    description:
      "The HIGH of the bar N bars ago. `high_n(1)` = previous bar's high. Use to detect breakouts of a prior bar's high or to anchor pattern-based stops.",
    examples: [
      {
        snippet: "filter.if = high > high_n(1)",
        scenario: "Only trade when this bar's high exceeded the prior bar's high — higher-high pattern.",
      },
    ],
  },
  {
    group: G_LOOKBACK_TS,
    headline: "low_n(n)",
    forms: ["low_n(n)"],
    description:
      "The LOW of the bar N bars ago. `low_n(1)` = previous bar's low. Mirror of high_n — useful for higher-low / lower-low pattern recognition.",
    examples: [
      {
        snippet: "filter.if = low > low_n(1)",
        scenario: "Only trade longs when this bar's low is above the prior bar's low — higher-low confirmation.",
      },
    ],
  },
  {
    group: G_LOOKBACK_TS,
    headline: "open_n(n)",
    forms: ["open_n(n)"],
    description:
      "The OPEN of the bar N bars ago. Less common than close_n but useful for inside-bar / outside-bar pattern logic and for measuring gaps between sessions.",
    examples: [
      {
        snippet: "filter.if = open > open_n(1) && close > close_n(1)",
        scenario: "Take longs only when both open AND close are above the prior bar — strong continuation pattern.",
      },
    ],
  },
  {
    group: G_LOOKBACK_TS,
    headline: "volume_n(n)",
    forms: ["volume_n(n)"],
    description:
      "Volume of the bar N bars ago. `volume_n(1)` = previous bar's volume. Use to compare current-bar activity against a specific prior bar (often the entry bar).",
    examples: [
      {
        snippet: "filter.if = volume > volume_n(1) * 2",
        scenario: "Only trade when this bar's volume was double the previous bar's.",
      },
    ],
  },
  {
    group: G_TICK_CONV,
    headline: "ticks(n)",
    forms: ["ticks(n)"],
    description:
      "Convert N ticks into POINTS for the current instrument. NQ has 4 ticks/point, gold has 10, oil has 100, ES has 4. So `ticks(8)` = 2 points on NQ, 0.8 on gold, 0.08 on oil. The most useful instrument-portable way to specify stop / target distances.",
    examples: [
      {
        snippet: "rules.stopLossPoints = ticks(8)",
        scenario: "Set the stop at 8 ticks — automatically scales: 2 points on NQ, 0.8 on gold, 0.08 on oil.",
      },
      {
        snippet: "rules.stopLossPoints = Optimize.DailyEV.trades(30, ticks(4), 40)",
        scenario: "Optimize the stop, but never let it shrink below 4 ticks — instrument-aware floor.",
      },
    ],
  },
  {
    group: G_TICK_CONV,
    headline: "point(n)",
    forms: ["point(n)"],
    description:
      "Convert N points into TICKS for the current instrument — the inverse of `ticks()`. Rarely needed in stop/target rules (those use points), but useful when you need an integer tick count for tick-level math.",
    examples: [
      {
        snippet: "filter.if = point(1) > 10",
        scenario: "Gate the strategy to high-tick-density instruments (e.g. crude oil, where 1 point = 100 ticks).",
      },
    ],
  },
  {
    group: G_TICK_CONV,
    headline: "ticksPerPoint",
    forms: ["ticksPerPoint"],
    description:
      "Raw count of how many ticks make up one point for the current instrument. NQ = 4, ES = 4, gold = 10, crude = 100. Same number `ticks(n)` and `point(n)` use internally — exposed when you need the value directly for sizing math.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = stdev(20) * ticksPerPoint",
        scenario: "Scale a stdev-based target by the instrument's tick density.",
      },
    ],
  },
  {
    group: G_TICK_CONV,
    headline: "tickValue",
    forms: ["tickValue"],
    description:
      "Dollar value of one tick for the current instrument — what each tick is worth in P&L. NQ = $5/tick, ES = $12.50/tick, gold = $10/tick. Use when you want to express stops/targets in dollars rather than points.",
    examples: [
      {
        snippet: "rules.stopLossPoints = 100 / tickValue * ticksPerPoint",
        scenario: "Build a roughly-$100-risk stop that auto-adjusts to whichever instrument is loaded.",
      },
    ],
  },
  {
    group: G_TICK_CONV,
    headline: "pointValue",
    forms: ["pointValue"],
    description:
      "Dollar value of one point for the current instrument. NQ = $20/point, ES = $50/point, gold = $100/point. The point-level counterpart to `tickValue`. Most useful when sizing risk in dollars across multiple instruments.",
    examples: [
      {
        snippet: "rules.stopLossPoints = 200 / pointValue",
        scenario: "Build a roughly-$200-risk stop in points — auto-scales across instruments by dollar value.",
      },
    ],
  },

  // ─── Order flow / cumulative delta ───────────────────────────────────
  {
    group: G_ORDER_FLOW,
    headline: "CVD",
    forms: ["CVD", "CVD()"],
    description:
      "Cumulative Volume Delta — running tally of \"who's hitting whom\". Adds buy-aggressor volume and subtracts sell-aggressor volume. Going up = buyers leaning in, going down = sellers leaning in. Needs bid/ask data — won't work on plain OHLCV sessions.",
    examples: [
      {
        snippet: "filter.if = CVD > 0",
        scenario:
          "Only trade longs when the session has more buy-aggression than sell-aggression so far.",
      },
    ],
  },

  // ─── Volume profile (rolling N-bar window — REQUIRES tick session) ──
  {
    group: G_VOLUME_PROFILE,
    headline: "POC[N, area]",
    forms: ["POC(N, area=0.7)"],
    description:
      "Point of Control — the single price level that traded the most volume over the rolling N-bar window. Where buyers and sellers found the most agreement. Acts as a magnet: when price strays, it often reverts toward POC. Needs a tick session.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = abs(close - POC(20))",
        scenario: "Aim profit at the most-traded price level — a magnet for mean reversion.",
      },
    ],
  },
  {
    group: G_VOLUME_PROFILE,
    headline: "VAH[N, area]",
    forms: ["VAH(N, area=0.7)"],
    description:
      "Value Area High — the TOP edge of the price range that holds `area` (default 70%) of the rolling N-bar volume. Acts as soft resistance: when price pushes above VAH, it's outside the recent fair-value zone. Needs a tick session.",
    examples: [
      {
        snippet: "filter.if = close > VAH(20)",
        scenario: "Only take longs when price has broken above the upper edge of the value zone — accepted into higher prices.",
      },
    ],
  },
  {
    group: G_VOLUME_PROFILE,
    headline: "VAL[N, area]",
    forms: ["VAL(N, area=0.7)"],
    description:
      "Value Area Low — the BOTTOM edge of the price range that holds `area` (default 70%) of the rolling N-bar volume. Mirror of VAH. Below VAL = price has rejected the recent fair-value zone to the downside. Needs a tick session.",
    examples: [
      {
        snippet: "filter.if = close > VAL(20) && close < VAH(20)",
        scenario: "Only trade when price is inside the recent value zone — fair-value mean reversion.",
      },
    ],
  },
  {
    group: G_VOLUME_PROFILE,
    headline: "VA_width[N, area]",
    forms: ["VA_width(N, area=0.7)"],
    description:
      "Width of the value area in points — `VAH - VAL`. A narrow value area means recent trading has clustered tightly (consolidation); a wide one means activity has been spread out. Useful regime filter for compression/expansion trades.",
    examples: [
      {
        snippet: "filter.if = VA_width(20, 0.7) < ATR(14)",
        scenario: "Only trade when the value area is narrower than a typical bar's range — compressed activity, often before a breakout.",
      },
    ],
  },
  {
    group: G_VOLUME_PROFILE,
    headline: "dist_to_POC[N, area]",
    forms: ["dist_to_POC(N, area=0.7)"],
    description:
      "Signed distance from the current close to the rolling POC, in points. Positive = price is above POC, negative = below. The natural \"how stretched are we vs fair value\" reading for mean-reversion entries.",
    examples: [
      {
        snippet: "filter.if = dist_to_POC(20) < -ATR(14)",
        scenario: "Only take longs when price has stretched more than an ATR below POC — strong mean-reversion setup.",
      },
    ],
  },

  // ─── Tick microstructure (REQUIRES tick session) ────────────────────
  {
    group: G_TICK_AGGRESSOR,
    headline: "trades_at_bid[N]",
    forms: ["trades_at_bid(N)"],
    description:
      "Count of trades over the last N bars that printed at the BID — sell-aggressor flow. High count = sellers were hitting bids aggressively (bearish flow). Compare to `trades_at_ask` to see which side is winning. Needs a tick session.",
    examples: [
      {
        snippet: "filter.if = trades_at_bid(5) > trades_at_ask(5) * 1.5",
        scenario: "Only take shorts when sell-aggression has been 50%+ heavier than buy-aggression over the last 5 bars.",
      },
    ],
  },
  {
    group: G_TICK_AGGRESSOR,
    headline: "trades_at_ask[N]",
    forms: ["trades_at_ask(N)"],
    description:
      "Count of trades over the last N bars that printed at the ASK — buy-aggressor flow. High count = buyers were lifting offers aggressively (bullish flow). The complement of `trades_at_bid`. Needs a tick session.",
    examples: [
      {
        snippet: "filter.if = trades_at_ask(5) > trades_at_bid(5) * 1.5",
        scenario: "Only take longs when buy-aggression has been 50%+ heavier than sell-aggression over the last 5 bars.",
      },
    ],
  },
  {
    group: G_TICK_AGGRESSOR,
    headline: "tick_imbalance[N]",
    forms: ["tick_imbalance(N)"],
    description:
      "A bounded −1 to +1 score over the last N bars: (ask_trades − bid_trades) / total_trades. +1 = every trade was a buy-aggressor lift; −1 = every trade hit the bid. The natural one-number summary of recent aggressor flow.",
    examples: [
      {
        snippet: "filter.if = tick_imbalance(5) > 0.3",
        scenario: "Only take longs when buyers have been clearly aggressive over the last 5 bars.",
      },
    ],
  },
  {
    group: G_TICK_AGGRESSOR,
    headline: "tick_count[N]",
    forms: ["tick_count(N)"],
    description:
      "Total number of trades over the last N bars (regardless of side). A pure activity meter — high tick_count = busy / active market, low = quiet. Useful for filtering out dead patches when a strategy depends on participation.",
    examples: [
      {
        snippet: "filter.if = tick_count(5) > 100",
        scenario: "Only trade when at least 100 prints hit in the last 5 bars — skip illiquid lulls.",
      },
    ],
  },
  {
    group: G_TICK_AGGRESSOR,
    headline: "mean_trade_size[N]",
    forms: ["mean_trade_size(N)"],
    description:
      "Average contracts-per-trade over the last N bars. Rising = bigger players are stepping in (institutional flow). Falling = mostly small-lot retail. A regime gauge for who's actually pushing price.",
    examples: [
      {
        snippet: "filter.if = mean_trade_size(10) > 5",
        scenario: "Only trade when the average lot size is above 5 contracts — implies institutional participation.",
      },
    ],
  },
  {
    group: G_TICK_AGGRESSOR,
    headline: "large_trade_count[N, threshold]",
    forms: ["large_trade_count(N, threshold)"],
    description:
      "Number of trades over the last N bars whose size was ≥ `threshold` contracts. Finds block prints / institutional clips. Pair with directional logic (close direction, aggressor side) to see whether the big traders were buying or selling.",
    examples: [
      {
        snippet: "filter.if = large_trade_count(5, 50) >= 3",
        scenario: "Only trade after at least 3 big-size prints (50+ contracts) hit in the last 5 bars.",
      },
    ],
  },
  {
    group: G_TICK_AGGRESSOR,
    headline: "vwap_tick[N]",
    forms: ["vwap_tick(N)"],
    description:
      "Volume-Weighted Average Price computed from the raw tick stream over the last N bars — finer-grained than the bar-level VWAP. Each individual print contributes; intrabar moves are reflected. Use when the bar-level VWAP feels too coarse.",
    examples: [
      {
        snippet: "filter.if = close > vwap_tick(20)",
        scenario: "Only take longs when price is above the tick-level VWAP — confirmation at the highest resolution.",
      },
    ],
  },

  // ─── Top-of-book quote (RESTING liquidity, v2 tick session) ─────────
  {
    group: G_TICK_QUOTE,
    headline: "spread[N]",
    forms: ["spread(N)"],
    description:
      "Average best_ask − best_bid over the last N bars, in points. Tight spread = liquid, easy fills. Wide spread = thin book, fast moves, slippage risk. Use as a regime filter to avoid trading during illiquid windows. Requires a v2 tick session (best_bid/best_ask columns); legacy tick CSVs return NaN.",
    examples: [
      {
        snippet: "filter.if = spread(20) < 0.5",
        scenario: "Avoid trading during fast / illiquid moments — only act when the book is tight.",
      },
    ],
  },
  {
    group: G_TICK_QUOTE,
    headline: "bid_size[N]",
    forms: ["bid_size(N)"],
    description:
      "Average size resting at the best bid over the last N bars. Large bid_size = stacked support below price (buyers willing to absorb). Thin bid_size = vulnerable to a flush. Distinct from `trades_at_bid` (executed flow vs displayed depth).",
    examples: [
      {
        snippet: "filter.if = bid_size(10) > 50 && breakout_down",
        scenario: "Skip short breakouts when bids below are stacked — likely absorption rather than a real flush.",
      },
    ],
  },
  {
    group: G_TICK_QUOTE,
    headline: "ask_size[N]",
    forms: ["ask_size(N)"],
    description:
      "Average size resting at the best ask over the last N bars. Thin ask_size = clear runway for upside (less liquidity for sellers to fade into). Thick ask_size = supply pressing on price. Pair with breakout direction.",
    examples: [
      {
        snippet: "filter.if = breakout_up and ask_size(10) < 20",
        scenario: "Only take breakouts when offers above are thin — less liquidity for sellers to fade into.",
      },
    ],
  },
  {
    group: G_TICK_QUOTE,
    headline: "quote_imbalance[N]",
    forms: ["quote_imbalance(N)"],
    description:
      "Resting-liquidity imbalance over the last N bars on a −1 to +1 scale: (ask_size − bid_size) / total. Positive = more size waiting on the offer (sellers stacked, possible push down). Negative = more size on the bid (buyers stacked, possible push up). The complement to executed `tick_imbalance`.",
    examples: [
      {
        snippet: "filter.if = quote_imbalance(10) < -0.3",
        scenario: "Take longs when the book is heavily lopsided with resting bids — implied buyer support.",
      },
    ],
  },
  {
    group: G_TICK_QUOTE,
    headline: "microprice[N]",
    forms: ["microprice(N)"],
    description:
      "Size-weighted fair-value mid over the last N bars: tilts TOWARD the side with LESS resting size (since that side has to move next when contracts hit it). More predictive of next-tick direction than the plain midpoint when the book is lopsided.",
    examples: [
      {
        snippet: "filter.if = close > microprice(20)",
        scenario: "Take longs when price has pushed above the size-weighted fair-value mid — book pressure favors upside.",
      },
    ],
  },

  // ─── Volume-profile nodes (HVN / LVN) ───────────────────────────────
  {
    group: G_TICK_NODES,
    headline: "dist_to_hvn[N, area]",
    forms: ["dist_to_hvn(N, area=0.7)"],
    description:
      "Signed normalized distance from the current close to the nearest HIGH-volume node (HVN) in the rolling N-bar profile. Positive = HVN sits above price, negative = below. HVNs are strong magnets / pivots — price tends to react to them. Like `dist_to_POC` but resolves SECONDARY nodes too (useful for multi-modal distributions).",
    examples: [
      {
        snippet: "filter.if = abs(dist_to_hvn(100, 0.7)) < 0.001",
        scenario: "Only enter when price is within 0.1% of a major high-volume node — likely reaction zone.",
      },
    ],
  },
  {
    group: G_TICK_NODES,
    headline: "dist_to_lvn[N, area]",
    forms: ["dist_to_lvn(N, area=0.7)"],
    description:
      "Signed normalized distance from the current close to the nearest LOW-volume node (LVN) in the rolling N-bar profile. Positive = LVN above price, negative = below. LVNs are liquidity gaps — price tends to traverse them quickly because there's little resting interest to slow it down. The complement of `dist_to_hvn`.",
    examples: [
      {
        snippet: "signal.long.if = breakout_up and dist_to_lvn(60, 0.7) > 0",
        scenario: "Breakout entries only when a low-volume gap sits above price — thin air above = faster move.",
      },
    ],
  },

  // ─── Footprint imbalance ────────────────────────────────────────────
  {
    group: G_TICK_FOOTPRINT,
    headline: "stacked_imbalance_up[ratio]",
    forms: ["stacked_imbalance_up(ratio=3)"],
    description:
      "Inside the CURRENT bar's footprint, finds the maximum-length consecutive run of ASCENDING price buckets where ask volume swamps bid volume by `ratio` or more. Returns 0 if no stack qualifies. The classic \"3-stacked-ask-imbalance\" footprint signal — concentrated buying aggression at multiple stacked price levels. Standard trigger: `>= 3`. Needs `tick_bidask` granularity.",
    examples: [
      {
        snippet: "signal.long.if = stacked_imbalance_up(3) >= 3",
        scenario: "Long entries only when the current bar's footprint shows at least 3 consecutive ascending price levels with ask volume ≥ 3× bid volume — strong buyers absorbing.",
      },
    ],
  },
  {
    group: G_TICK_FOOTPRINT,
    headline: "stacked_imbalance_down[ratio]",
    forms: ["stacked_imbalance_down(ratio=3)"],
    description:
      "Mirror of `stacked_imbalance_up` — looks for a consecutive run of DESCENDING price buckets where bid volume swamps ask volume by `ratio` or more. Concentrated selling aggression at multiple stacked levels. Standard trigger: `>= 3`. Needs `tick_bidask` granularity.",
    examples: [
      {
        snippet: "signal.short.if = stacked_imbalance_down(3) >= 3",
        scenario: "Short entries only when the current bar's footprint shows at least 3 consecutive descending price levels with bid volume ≥ 3× ask volume — strong sellers hammering.",
      },
    ],
  },

  // ─── Sweep + Iceberg (v2 quote data) ────────────────────────────────
  {
    group: G_TICK_SWEEP,
    headline: "sweep_up[N, sizeMin]",
    forms: ["sweep_up(N, sizeMin=0)"],
    description:
      "Count of aggressive BUY prints over the last N bars that ate the ENTIRE visible best-ask size at the moment of trade — level-clearing aggression. `sizeMin` filters out small clears. Sweeps are continuation signals: when a buyer is willing to chew through all visible supply, more demand usually follows. Requires a v2 tick session.",
    examples: [
      {
        snippet: "signal.long.if = sweep_up(5, 50) >= 2 and close > EMA20",
        scenario: "Two big buy sweeps (50+ contracts each) in the last 5 bars while price is above the trend EMA — momentum continuation.",
      },
    ],
  },
  {
    group: G_TICK_SWEEP,
    headline: "sweep_down[N, sizeMin]",
    forms: ["sweep_down(N, sizeMin=0)"],
    description:
      "Mirror of `sweep_up` — counts aggressive SELL prints over the last N bars that ate the entire visible best-bid size. Indicates sellers willing to chew through resting demand. Continuation signal for shorts. Requires a v2 tick session.",
    examples: [
      {
        snippet: "signal.short.if = sweep_down(5, 50) >= 2 and close < EMA20",
        scenario: "Two big sell sweeps (50+ contracts each) in the last 5 bars below the trend EMA — momentum continuation for shorts.",
      },
    ],
  },
  {
    group: G_TICK_SWEEP,
    headline: "iceberg_at_ask[N, minRefills]",
    forms: ["iceberg_at_ask(N, minRefills=3)"],
    description:
      "Count of bars over the last N where the SAME inside-quote price kept getting hit at the ask but resting size kept refilling (≥70% recovery within the bar). Implies a hidden supply order behind the displayed quote. Reversal / absorption signal — supply is defending a price level.",
    examples: [
      {
        snippet: "signal.short.if = iceberg_at_ask(10, 3) > 0 and ha_close() < ha_open()",
        scenario: "Heavy iceberg defending the ask AND Heiken Ashi turning red → fade the rally into hidden supply.",
      },
    ],
  },
  {
    group: G_TICK_SWEEP,
    headline: "iceberg_at_bid[N, minRefills]",
    forms: ["iceberg_at_bid(N, minRefills=3)"],
    description:
      "Mirror of `iceberg_at_ask` — counts bars where hidden DEMAND kept refilling at the bid after being hit. A hidden buyer absorbing supply at a level. Reversal signal for an uptrend setup.",
    examples: [
      {
        snippet: "signal.long.if = iceberg_at_bid(10, 3) > 0 and ha_close() > ha_open()",
        scenario: "Hidden buyer absorbing at the bid AND Heiken Ashi turning green → fade the dip into hidden demand.",
      },
    ],
  },

  // ─── Bar-level smoothing & compression ──────────────────────────────
  {
    group: G_BAR_SMOOTHING,
    headline: "Heiken Ashi candle",
    forms: ["ha_open()", "ha_high()", "ha_low()", "ha_close()"],
    description:
      "Heiken Ashi candles smooth raw OHLC by referencing the PRIOR HA candle's open/close (not the prior raw bar) — long unbroken runs of same-color HA bars signal sustained trend. `ha_close > ha_open` = green/bullish HA bar; reverse = red/bearish. Pure OHLC math, works on any granularity. The four functions return the smoothed open, high, low, and close of the current HA candle.",
    examples: [
      {
        snippet: "filter.if = ha_close() > ha_open()",
        scenario: "Trend filter — only take longs on green Heiken Ashi bars, no whipsaws from single noisy candles.",
      },
      {
        snippet: "filter.if = ha_close() > ha_open() && ha_low() > ha_open()",
        scenario: "Strict trend filter — green HA bar AND no lower wick (textbook strong-trend HA pattern).",
      },
    ],
  },
  {
    group: G_BAR_SMOOTHING,
    headline: "squeeze_on[N, multBB, multKC]",
    forms: ["squeeze_on(N=20, multBB=2, multKC=1.5)"],
    description:
      "Returns 1 when the Bollinger Bands sit ENTIRELY INSIDE the Keltner Channel — i.e. volatility has compressed to a level below the Keltner band width. The classic \"coiled spring\" state. Stays 1 for as long as the compression lasts. Pair with directional logic to bias which way the eventual expansion will go.",
    examples: [
      {
        snippet: "filter.if = squeeze_on(20) == 1",
        scenario: "Only consider trades while volatility is compressed — pre-positioning for the eventual breakout.",
      },
    ],
  },
  {
    group: G_BAR_SMOOTHING,
    headline: "squeeze_fire[N, multBB, multKC]",
    forms: ["squeeze_fire(N=20, multBB=2, multKC=1.5)"],
    description:
      "Returns 1 ONLY on the exact bar where `squeeze_on` flips from 1 to 0 — i.e. the bar where compression releases and volatility expands. Single-bar event signal. Best used to trigger entries timed to the expansion, with a separate filter picking the side.",
    examples: [
      {
        snippet: "signal.long.if = squeeze_fire(20) == 1 and close > EMA20",
        scenario: "Take longs only on the squeeze-release bar when price is above the trend EMA — directional bias for the compression release.",
      },
    ],
  },

  // ─── Kalman-filtered Ornstein-Uhlenbeck (strategy DSL only) ─────────
  // Member access (`kf.x_pred`, `kf.x`, `kf.sigma`, …) only works
  // inside a strategy script via a `let X = KALMAN_OU(...)` binding —
  // the parser rewrites dotted ident references into direct calls
  // against six hidden sibling indicators. All six share one filter
  // pass per parameter tuple via a per-zone bundle cache. Calibration
  // is rolling (refits every bar from the previous `calib` bars) so
  // it's fully out-of-sample and adapts to regime shifts.
  {
    group: G_ADVANCED,
    headline: "KALMAN_OU (mean-reversion estimator)",
    forms: [
      "let kf = KALMAN_OU(source, calib, trust)",
      "kf.x_pred  (PRE-fit OU prediction — honest z-score divisor)",
      "kf.x       (POST-fit posterior — has THIS bar baked in)",
      "kf.mu      (rolling long-run mean)",
      "kf.sigma   (rolling long-run unconditional std)",
      "kf.phi     (rolling AR(1) persistence)",
      "kf.P       (current posterior variance)",
    ],
    description:
      "Kalman-filtered Ornstein-Uhlenbeck mean-reversion estimator — gives you a smoothed \"fair value\" line that price reverts toward, plus the standard-deviation scale to size mean-reversion entries. STRATEGY DSL ONLY: must be assigned to a `let` and then accessed via `kf.x_pred`-style member syntax. `source` is one of close/open/high/low/typical/median_price/weighted_close. `calib` is the rolling calibration window in bars (60 is a sensible default). `trust` ∈ (0,1) controls how much weight the filter puts on each new bar's price vs its own prediction — small (0.1–0.3) = very smooth slow line, large (0.7–0.9) = follows price closely. " +
      "**`kf.x_pred` vs `kf.x` matters for honest backtests.** `kf.x_pred` is the OU model's prediction for THIS bar given everything known BEFORE it opens — comparing `close` to `x_pred` measures the true OU innovation. `kf.x` is the post-fit posterior (it absorbed THIS bar's close into the smoothing) — comparing `close` to `kf.x` measures the post-fit residual, which is mathematically smaller than the innovation and biases entry/exit thresholds toward easier triggers. Use `kf.x_pred` as your z-score divisor baseline; reach for `kf.x` only when you genuinely want \"fair value RIGHT NOW given everything I know.\" " +
      "Calibration is fully ROLLING: every bar refits (mu, phi, sigma) from the immediately preceding `calib` bars, so the filter is always out-of-sample and adapts to regime shifts as the session progresses.",
    examples: [
      {
        snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nlet z = (close - kf.x_pred) / kf.sigma\nsignal.long.if = cross_down(z, -params.entryZ)\nexit.long.if = cross_up(close, kf.x_pred)",
        scenario: "Honest mean-reversion: enter long when price is more than entryZ stds below the OU PREDICTION (using x_pred makes the z-score the real innovation, not a half-bar-baked-in residual). Exit when price reclaims the prediction.",
      },
      {
        snippet: "let kf = KALMAN_OU(typical, 90, 0.3)\nontrade.print = kf.x, \"x_post\"\nontrade.print = kf.x_pred, \"x_pre\"",
        scenario: "Side-by-side check: x_post tracks the bar's close more closely (it absorbed it); x_pred is what the OU model predicted before seeing the bar. The gap (close - x_pred) is the real innovation.",
      },
      {
        snippet: "let kf = KALMAN_OU(close, 60, 0.5)\nrules.takeProfitPoints = abs(close - kf.x_pred)",
        scenario: "Use the Kalman PREDICTION as the mean-reversion target — TP is the distance from current price back to the OU model's forecast.",
      },
    ],
  },
];

const BAR_FIELDS = EXPR_SYMBOLS.filter(
  (s) =>
    s.kind === "ident" &&
    [
      "open", "high", "low", "close", "volume", "bar_index", "direction",
      // Order-flow bar fields — populated when the source granularity
      // is `ohlcv_bidask` or `tick_bidask`; NaN otherwise.
      "bar_volume_bid", "bar_volume_ask", "buy_volume", "sell_volume",
      "delta", "delta_ratio", "buy_pressure",
    ].includes(s.name)
);

const MATH_FUNCTIONS = EXPR_SYMBOLS.filter((s) => s.kind === "math");

// Summary identifiers — group aliases together so the docs say
// "avgBarsHeld (also avgtradetime)" instead of listing both as separate
// rows. The first name in the array is the canonical one.
interface SummaryGroup {
  names: string[];
  description: string;
  examples?: ExampleEntry[];
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
      // Worked examples live on the canonical entry only — aliases just
      // share the same explanation, no duplicate code blocks needed.
      group.examples = s.examples;
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
/** Visible group divider rendered between indicator cards when the
 *  family's `group` changes. Not a real "card" — just a heading row that
 *  reuses the same flex flow so spacing stays consistent. Inserted by
 *  buildSections() so all the card-shape logic stays in one place. */
type IndicatorGroupCard = { kind: "indicatorgroup"; label: string };
type BarFieldCard = {
  kind: "barfield";
  name: string;
  description: string;
  examples?: ExampleEntry[];
};
type MathCard = {
  kind: "math";
  signature: string;
  description: string;
  examples?: ExampleEntry[];
};
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
  examples?: ExampleEntry[];
};

type Card =
  | SchemaCard
  | IndicatorCard
  | IndicatorGroupCard
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

// Per-schema-section blurbs. The auto-built "Strategy params" section
// (every `params.*` row) gets a loud LEGACY warning so users authoring
// new scripts don't reach for it. Add more entries here as needed —
// keys must exactly match the `section` field on a SCRIPT_SCHEMA entry.
const SCHEMA_SECTION_BLURBS: Record<string, string> = {
  "Strategy params":
    "⚠️ LEGACY — these `params.*` paths exist purely for backward compatibility with old presets. DO NOT use them when authoring a new strategy. Express the same logic with the modern DSL instead: `var <name> = ...` for tunable knobs, `signal.long.if` / `signal.short.if` for entries, `exit.if` / `exit.long.if` / `exit.short.if` for exits, `filter.if` for gating, and `let <name> = ...` for shared bindings (e.g. `let kf = KALMAN_OU(...)`). Only touch `params.*` when explicitly editing a legacy preset that already uses it.",
  "Strategy":
    "Picks the baseline signal generator. Most modern scripts override entries entirely with `signal.long.if = ...` / `signal.short.if = ...`, in which case the choice here just determines warmup/seeding. `loadstrategy` is LEGACY — it resets all `params.*` and is only useful when restoring an old preset's defaults; new scripts should not emit it.",
};

// Curated content for the Optimize section — covers the syntax,
// objectives, lookback units, and OptimizeAll. Hand-written so the
// reader gets a coherent narrative instead of a flat list of regex
// fragments. The literal entries omit the discriminator `kind` field
// (it's added by the buildSections() mapper below) — OptimizeCardData
// captures the no-kind shape so TypeScript validates the array.
type OptimizeCardData = Omit<OptimizeCard, "kind">;
const OPTIMIZE_CARDS: OptimizeCardData[] = [
  {
    headline: "Numeric form — let it pick a number",
    forms: [
      "rules.stopLossPoints = Optimize.DailyEV.trades(30, 10, 40)",
      "rules.timedExitBars = Optimize.Sharpe.bars(500, 5, 50, 1)",
    ],
    description:
      "Instead of writing a fixed number for a rule, write `Optimize.<what-you-want>.<window>(window-size, smallest, biggest)`. The dashboard tries different numbers between the smallest and biggest, watches what works best in your chosen window, and uses the winner. You can add a step at the end (like `, 1`) to only try whole-number jumps.",
    examples: [
      {
        snippet: "rules.stopLossPoints = Optimize.DailyEV.trades(30, 10, 40)",
        scenario:
          "Try stop sizes between 10 and 40 points. Pick whichever made the most money per day looking back at the last 30 trades.",
      },
      {
        snippet: "rules.takeProfitPoints = Optimize.WinRate.trades(50, 5, 30, 5)",
        scenario:
          "Try take-profit sizes 5, 10, 15, 20, 25, 30. Pick whichever produced the most winners in the last 50 trades.",
      },
    ],
  },
  {
    headline: "Categorical form (coming soon)",
    forms: ["filters.trend.ema20 = Optimize.WinRate.trades(30, (with, against))"],
    description:
      "For settings that aren't a number (like \"with the trend\" vs \"against the trend\"), you can list the choices in parentheses. The dashboard reads this today but doesn't actually pick yet — the on/off switching is still being built. For now, only number-Optimize on `rules.*` fields really runs.",
    examples: [
      {
        snippet:
          "filters.trend.ema20 = Optimize.WinRate.trades(30, (with, against))",
        scenario:
          "Asks the dashboard to choose between trading with the trend or against it. Parsed today, but the chosen value isn't applied yet.",
      },
    ],
  },
  {
    headline: "Objectives — what \"best\" means",
    forms: ["DailyEV", "EV", "Sharpe", "MinDrawdown", "WinRate", "ProfitFactor"],
    description:
      "Tells Optimize what to chase. `DailyEV` = most points per day. `EV` = most points per trade. `Sharpe` = smoothest results (steady wins beat lucky ones). `MinDrawdown` = smallest worst-day pain. `WinRate` = highest percentage of winners. `ProfitFactor` = total wins divided by total losses.",
    examples: [
      {
        snippet: "rules.stopLossPoints = Optimize.MinDrawdown.trades(50, 5, 30)",
        scenario:
          "Pick the stop size that has the smallest losing streak — best for users who hate big drawdowns.",
      },
      {
        snippet: "rules.takeProfitPoints = Optimize.Sharpe.trades(100, 10, 40)",
        scenario:
          "Pick the take-profit that gives the steadiest, most consistent returns.",
      },
    ],
  },
  {
    headline: "Lookback units — what \"window\" means",
    forms: ["trades", "bars", "minutes", "seconds", "hours"],
    description:
      "How far back Optimize looks when judging which number is winning. `trades` counts completed trades (e.g. last 30 trades). The others are time-based — last N minutes, hours, etc. While the window is still filling up, the field uses your starting default value.",
    examples: [
      {
        snippet: "rules.stopLossPoints = Optimize.DailyEV.trades(30, 10, 40)",
        scenario: "Score candidates by looking at the last 30 completed trades.",
      },
      {
        snippet: "rules.timedExitBars = Optimize.Sharpe.hours(8, 5, 50, 1)",
        scenario:
          "Score candidates using only trades from the last 8 hours of session time.",
      },
    ],
  },
  {
    headline: "OptimizeAll — tune everything together",
    forms: ["OptimizeAll = true", "OptimizeAll = false (default)"],
    description:
      "When `false` (the normal mode), each `Optimize` line tunes its own number on its own. When `true`, all your Optimize lines work together as a team, hunting for the best combination — but they all have to be measuring the same thing (same objective, like all `DailyEV`).",
    examples: [
      {
        snippet: "OptimizeAll = false",
        scenario:
          "Default. Each Optimize line tunes its own value, holding the others at their starting defaults.",
      },
      {
        snippet: "OptimizeAll = true",
        scenario:
          "All Optimize lines tune as a team — useful when stop and take-profit need to balance each other.",
      },
    ],
  },
  {
    headline: "Run button — when does it actually optimize?",
    forms: ["Run button"],
    description:
      "Pressing Run kicks off the backtest. Optimize works DURING the backtest, not before — once enough trades have happened to fill your window, every new trade triggers a quick search and uses the winning number. You'll see each chosen value plotted as a tiny sparkline in the Output panel so you can see what was used for each trade.",
    examples: [
      {
        snippet: "rules.stopLossPoints = Optimize.DailyEV.trades(30, 10, 40)",
        scenario:
          "Hit Run. The first 30 trades use 10 (the starting default). Trade 31 onward uses whatever stop size has been winning lately.",
      },
    ],
  },
  {
    headline: "var — name a tunable number",
    forms: [
      "var rsiLow = Optimize.DailyEV.trades(10, 1, 100)",
      "var rsiHigh = Optimize.DailyEV.trades(10, 50, 99)",
      "filter.if = (RSI(14) >= rsiLow && RSI(14) <= rsiHigh, , reject)",
    ],
    description:
      "Lets you give a tunable number a NAME, then use that name anywhere — inside a filter, a rule, or a print. Same Optimize machinery as on `rules.*`, just reusable. You can also write Optimize directly inside a filter and the parser auto-creates a hidden var for you. Names just have to be plain words (letters, digits, underscores) and can't be names already used by bars or indicators.",
    examples: [
      {
        snippet: "var rsiLow = Optimize.DailyEV.trades(10, 1, 100)",
        scenario:
          "Define a number called `rsiLow`. The dashboard tunes it between 1 and 100 looking at the last 10 trades.",
      },
      {
        snippet:
          "filter.if = (RSI(14) >= rsiLow && RSI(14) <= rsiHigh, , reject)",
        scenario:
          "Only take a trade when RSI is in the tuned band — both edges of the band are being optimized live.",
      },
    ],
  },
  {
    headline: "Default values — work even before warmup",
    forms: [
      "var x = Optimize.DailyEV.trades(10, 1, 100)",
      "filter.if = (RSI(14) >= x, , reject)  // skipped during warmup",
      "var y = Optimize.DailyEV.trades(10, 1, 100) default 50",
      "filter.if = (RSI(14) >= y, , reject)  // works from trade 1 using y=50",
    ],
    description:
      "An Optimize var has no value before its window fills (the warmup phase). To avoid filters blocking every trade during warmup, the dashboard auto-skips filters that depend on an un-warmed-up var. If you'd rather your filter actually works from the very first trade, add `default <number>` so the var has a value to use until the optimizer takes over.",
    examples: [
      {
        snippet: "var x = Optimize.DailyEV.trades(10, 1, 100) default 30",
        scenario:
          "Use 30 as the value for trades 1–10 (warmup). After 10 trades, switch to whatever the optimizer picks.",
      },
      {
        snippet: "filter.if = (RSI(14) >= x, , reject)",
        scenario:
          "Reject trades where RSI is below `x`. Works from the very first trade because `x` has a default.",
      },
    ],
  },
  {
    headline: "Warmup = true / false",
    forms: [
      "Warmup = true  // (default) keep warmup trades in your stats",
      "Warmup = false  // hide warmup trades from your final stats",
    ],
    description:
      "While Optimize is filling its window, those early trades use the starting default — they're called \"warmup\" trades. `Warmup = true` (default) keeps them in your final stats and trade list. `Warmup = false` hides them, so you only see the trades that ran with optimized values. Optimize itself always uses warmup trades internally — this just affects what shows up at the end.",
    examples: [
      {
        snippet: "Warmup = true",
        scenario:
          "Default. The trade table shows every trade, with warmup ones tagged so the UI can color them differently.",
      },
      {
        snippet: "Warmup = false",
        scenario:
          "Cleaner stats. Hide the early default-value trades; only the optimized ones count toward the win-rate, etc.",
      },
    ],
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
  // page reads in the same sequence as a serialized script. Per-section
  // blurbs (e.g. the LEGACY warning on `params.*`) are pulled from
  // SCHEMA_SECTION_BLURBS so the page can flag whole sections without
  // every individual schema row needing its own callout.
  const schemaSections: Section[] = [];
  for (const e of SCRIPT_SCHEMA) {
    if (!matchSchema(e)) continue;
    const last = schemaSections[schemaSections.length - 1];
    if (last && last.name === e.section) {
      last.cards.push({ kind: "schema", entry: e });
    } else {
      schemaSections.push({
        name: e.section,
        blurb: SCHEMA_SECTION_BLURBS[e.section],
        cards: [{ kind: "schema", entry: e }],
      });
    }
  }

  // Curated expression-engine sections — collapse the EXPR_SYMBOLS
  // duplicates (ATR / ATR14, EMA20 / EMA50 / EMA200, …) into one card
  // per indicator family with a `[period]` headline and the available
  // forms listed underneath. Bar fields and Math functions are listed
  // verbatim — they don't have alias clutter to collapse.
  // Build the indicator section card list, injecting visible group
  // dividers whenever consecutive families transition to a new group.
  // The dividers are emitted from the SAME ordered list used in the
  // declaration above, so reordering INDICATOR_FAMILIES is the single
  // source of truth for both order and grouping. Filtering happens
  // first so an empty group doesn't get a stranded header card.
  const matchedFamilies = INDICATOR_FAMILIES.filter(
    (f) =>
      !q ||
      has(f.headline) ||
      has(f.description) ||
      has(f.group) ||
      f.forms.some((form) => has(form))
  );
  const indicatorCards: Card[] = [];
  let lastGroup = "";
  for (const family of matchedFamilies) {
    if (family.group !== lastGroup) {
      indicatorCards.push({ kind: "indicatorgroup", label: family.group });
      lastGroup = family.group;
    }
    indicatorCards.push({ kind: "indicator", family });
  }
  const indicators: Section = {
    name: SECTION_INDICATORS,
    blurb:
      "These are calculations you can use inside any rule's number, or inside a filter to gate trades. They get computed at the moment of each trade's entry. Names with `[period]` mean you choose the lookback length (like `EMA(20)` or use the shortcut `EMA20`). Grouped below by what the indicator does (trends, momentum, volatility, etc.) — most work on any data, BUT a few groups need extra-detailed data: order flow (CVD) needs bid-ask data; volume profile (POC, VAH, VAL) and tick microstructure (trades_at_bid, vwap_tick) need full tick data — without it those return blanks and your filters will reject everything.",
    cards: indicatorCards,
  };
  const barFields: Section = {
    name: SECTION_BAR_FIELDS,
    blurb:
      "Simple values from the bar where the trade enters — like its open, high, low, close, and volume. Just type the name, no parentheses needed. The order-flow fields (delta, buy_pressure, buy_volume, etc.) need bid-ask data; without it they come back blank.",
    cards: BAR_FIELDS.filter((s) => !q || has(s.name) || has(s.description)).map(
      (s) => ({
        kind: "barfield",
        name: s.name,
        description: s.description,
        examples: s.examples,
      })
    ),
  };
  const math: Section = {
    name: SECTION_MATH,
    blurb:
      "Plain math helpers like absolute value, min, max, square root, and rounding. Use these to clean up calculations or pick the smaller/larger of two numbers. Work both in trade rules and in summary prints.",
    cards: MATH_FUNCTIONS.filter(
      (s) => !q || has(s.name) || has(s.signature ?? "") || has(s.description)
    ).map((s) => ({
      kind: "math",
      signature: s.signature ?? s.name,
      description: s.description,
      examples: s.examples,
    })),
  };
  const summary: Section = {
    name: SECTION_SUMMARY,
    blurb:
      "Numbers about the WHOLE backtest result — your win rate, total points, average trade time, and so on. Use them in `print = ...` lines to show custom stats in the Output panel after a run finishes. Names in parentheses are aliases (different name, same number).",
    cards: SUMMARY_GROUPS.filter(
      (g) => !q || g.names.some(has) || has(g.description)
    ).map((group) => ({ kind: "summary", group })),
  };
  const optimize: Section = {
    name: SECTION_OPTIMIZE,
    blurb:
      "Lets the dashboard pick a number for you instead of guessing. You give it a range (a smallest and biggest number to try) and what you care about — like making the most money, or having the smoothest results. As the backtest runs, it tries different numbers and learns which ones worked best, then uses the winner for the next trade. Press Run to start; you'll see the chosen value plotted as a tiny line under each trade in the Output panel.",
    cards: OPTIMIZE_CARDS.filter(
      (c) =>
        !q || has(c.headline) || has(c.description) || c.forms.some(has)
    ).map((c) => ({
      kind: "optimize",
      headline: c.headline,
      forms: c.forms,
      description: c.description,
      examples: c.examples,
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

/** Worked-examples block — appears as the bottom row of every card that
 *  carries `examples`. Pairs each parseable snippet (amber code chip)
 *  with its plain-English scenario (italic gray, prefixed `→`). The
 *  thin top-border separates the examples visually from whatever
 *  description / forms / metadata strip the card already shows. */
function ExamplesBlock({ examples }: { examples?: ExampleEntry[] }) {
  if (!examples || examples.length === 0) return null;
  return (
    <div className="mt-2.5 pt-2 border-t border-card-border/40">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">
        Examples
      </div>
      <div className="space-y-1.5">
        {examples.map((ex, i) => (
          <div key={i}>
            <code className="block font-mono text-[11px] text-amber-300/90 bg-background/60 border border-card-border/60 rounded px-1.5 py-0.5 break-all">
              {ex.snippet}
            </code>
            <p className="text-[11px] text-muted-foreground/80 italic mt-0.5 ml-1">
              → {ex.scenario}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

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
      <ExamplesBlock examples={entry.examples} />
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
      <ExamplesBlock examples={family.examples} />
    </div>
  );
}

function BarFieldCardView({
  name,
  description,
  examples,
}: {
  name: string;
  description: string;
  examples?: ExampleEntry[];
}) {
  return (
    <div className="bg-card border border-card-border rounded-md p-3">
      <code className="text-sm text-sky-300 font-mono">{name}</code>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
        {description}
      </p>
      <ExamplesBlock examples={examples} />
    </div>
  );
}

function MathCardView({
  signature,
  description,
  examples,
}: {
  signature: string;
  description: string;
  examples?: ExampleEntry[];
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
      <ExamplesBlock examples={examples} />
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
      <ExamplesBlock examples={group.examples} />
    </div>
  );
}

function OptimizeCardView({
  headline,
  forms,
  description,
  examples,
}: {
  headline: string;
  forms: string[];
  description: string;
  examples?: ExampleEntry[];
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
      <ExamplesBlock examples={examples} />
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
                        // Warning-flavored blurbs (LEGACY notices, etc.)
                        // get an amber-bordered card so they stand out
                        // from the regular informational blurbs. The
                        // ⚠️ prefix is the trigger — keeps the styling
                        // logic in one place without an extra flag.
                        sec.blurb.startsWith("⚠️") ? (
                          <div className="text-xs px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-100 leading-relaxed">
                            {sec.blurb}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground px-1 leading-relaxed">{sec.blurb}</p>
                        )
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
                          case "indicatorgroup":
                            // Visual divider between indicator groups.
                            // Slightly larger top margin on non-first
                            // dividers so the eye registers a real
                            // section break, not just another card.
                            return (
                              <h3
                                key={"grp-" + card.label + i}
                                className={`text-[11px] uppercase tracking-wider text-accent-green/80 font-semibold px-1 ${
                                  i === 0 ? "mt-0" : "mt-4"
                                }`}
                              >
                                {card.label}
                              </h3>
                            );
                          case "barfield":
                            return (
                              <BarFieldCardView
                                key={card.name + i}
                                name={card.name}
                                description={card.description}
                                examples={card.examples}
                              />
                            );
                          case "math":
                            return (
                              <MathCardView
                                key={card.signature + i}
                                signature={card.signature}
                                description={card.description}
                                examples={card.examples}
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
                                examples={card.examples}
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
