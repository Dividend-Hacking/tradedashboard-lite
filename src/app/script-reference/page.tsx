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
  /** Worked examples — code snippet + plain-English scenario. */
  examples?: ExampleEntry[];
}

const INDICATOR_FAMILIES: IndicatorFamily[] = [
  {
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

  // ─── Extended moving averages ──────────────────────────────────────────
  {
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
    headline: "DEMA[period] / TEMA[period]",
    forms: ["DEMA(period)", "TEMA(period)", "DEMA20", "TEMA20"],
    description:
      "Sped-up versions of EMA. DEMA = double exponential, TEMA = triple. Both react quicker to price changes than a plain EMA at the same period — useful when EMA feels too slow.",
    examples: [
      {
        snippet: "filter.if = close > TEMA(20)",
        scenario: "Trade with trend using an EMA that responds extra-quickly.",
      },
    ],
  },
  {
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

  // ─── Momentum / oscillators ────────────────────────────────────────────
  {
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
    headline: "ROC[period] / MOM[period]",
    forms: ["ROC(period)", "MOM(period)", "ROC10", "MOM10"],
    description:
      "How much price has changed compared to N bars ago. ROC = the percent change. MOM = the raw point change (positive means up, negative means down). Both tell you momentum direction.",
    examples: [
      {
        snippet: "filter.if = ROC(10) > 0",
        scenario: "Only trade when price is higher than it was 10 bars ago.",
      },
      {
        snippet: "rules.takeProfitPoints = abs(MOM(20)) * 1.5",
        scenario: "Size your target relative to how much price has moved over the last 20 bars.",
      },
    ],
  },
  {
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
    headline: "TRIX[period] / MFI[period]",
    forms: ["TRIX(period)", "MFI(period)", "TRIX14", "MFI14"],
    description:
      "TRIX = a smoothed-out momentum reading (filtered through three averages so noise gets cut). MFI = like RSI but uses volume too — a 0–100 \"money flow\" score. Above 80 = heavy buying pressure; below 20 = heavy selling.",
    examples: [
      {
        snippet: "filter.if = TRIX(14) > 0",
        scenario: "Only trade when smoothed momentum is positive (uptrend).",
      },
      {
        snippet: "filter.if = MFI(14) < 20",
        scenario: "Trade oversold conditions confirmed by volume.",
      },
    ],
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

  // ─── Volatility ────────────────────────────────────────────────────────
  {
    headline: "TR / NATR[period] / HV[period]",
    forms: ["TR", "TR()", "NATR(period)", "HV(period)", "NATR14", "HV20"],
    description:
      "Three ways to measure price wiggle. TR = how big this single bar was (its range, including any gap from the last close). NATR = ATR shown as a percent of price (great for comparing volatility across different instruments). HV = how spread out returns have been recently.",
    examples: [
      {
        snippet: "filter.if = NATR(14) > 0.5",
        scenario: "Skip days when price wiggle is less than 0.5% of price — too quiet to bother.",
      },
      {
        snippet: "rules.stopLossPoints = TR * 1.5",
        scenario: "Size your stop based on how big the entry bar itself was.",
      },
    ],
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
      "Volume-flow indicators that try to read whether buyers or sellers are in charge. OBV = running tally of volume, plus on up-days, minus on down-days. AD = similar but factors in where price closed within the bar. CMF = a −1 to 1 score over N bars; positive = buying pressure.",
    examples: [
      {
        snippet: "filter.if = CMF(20) > 0.1",
        scenario: "Only trade longs when the last 20 bars show clear buying pressure.",
      },
      {
        snippet: "filter.if = OBV > OBV()",
        scenario:
          "Just illustrative — pair OBV with a moving average for trend confirmation in a real strategy.",
      },
    ],
  },

  // ─── Bar-shape scalars ─────────────────────────────────────────────────
  {
    headline: "range / body / upper_wick / lower_wick",
    forms: ["range", "body", "upper_wick", "lower_wick"],
    description:
      "The shape of the current candle. range = how tall it is (high minus low). body = open-to-close size and direction (positive = green, negative = red). upper_wick / lower_wick = how long each tail is.",
    examples: [
      {
        snippet: "filter.if = body > 0 && lower_wick > body",
        scenario: "Take longs only on green candles with a long lower tail — buyers rejected lower prices.",
      },
      {
        snippet: "rules.takeProfitPoints = range * 2",
        scenario: "Set the target at twice the entry candle's full range.",
      },
    ],
  },
  {
    headline: "typical / median_price / weighted_close",
    forms: ["typical", "median_price", "weighted_close"],
    description:
      "Three different ways to summarize a bar with one number. typical = average of high, low, close. median_price = midpoint of high and low. weighted_close = like typical but counts close more. Used as inputs to other indicators.",
    examples: [
      {
        snippet: "rules.takeProfitPoints = abs(typical - EMA20)",
        scenario: "Aim profit at the EMA, measured from the bar's typical price.",
      },
    ],
  },

  // ─── Lookback scalars ──────────────────────────────────────────────────
  {
    headline: "HHV[period] / LLV[period]",
    forms: ["HHV(period)", "LLV(period)", "HHV20", "LLV20"],
    description:
      "HHV = the highest high of the last N bars. LLV = the lowest low. Use these for breakout setups (trade when price clears the recent high) or channel stops (set your stop at the recent low).",
    examples: [
      {
        snippet: "filter.if = close > HHV(20)",
        scenario: "Only take longs that break above the 20-bar high — a fresh new-high entry.",
      },
      {
        snippet: "rules.stopLossPoints = close - LLV(10)",
        scenario: "Set the stop at the lowest low of the last 10 bars.",
      },
    ],
  },
  {
    headline: "close_n(n) / high_n(n) / low_n(n) / open_n(n) / volume_n(n)",
    forms: [
      "close_n(n)", "high_n(n)", "low_n(n)", "open_n(n)", "volume_n(n)",
    ],
    description:
      "Look back at price/volume from N bars ago. `close_n(1)` is the previous bar's close, `close_n(5)` is 5 bars back, etc. Use these to compare \"now vs then\" — like \"is this bar higher than the previous one\".",
    examples: [
      {
        snippet: "filter.if = close > close_n(1)",
        scenario: "Only trade when this bar closed higher than the previous bar.",
      },
      {
        snippet: "filter.if = volume > volume_n(1) * 2",
        scenario: "Only trade when this bar's volume was double the previous bar's.",
      },
    ],
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
      "Helpers that convert between ticks (the smallest price increment for an instrument) and price points. Different futures have different tick sizes — NQ has 4 ticks per point, gold has 10, oil has 100. Using `ticks(n)` keeps your script working across instruments without rewriting numbers.",
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

  // ─── Order flow / cumulative delta ───────────────────────────────────
  {
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

  // ─── Trend / channels ────────────────────────────────────────────────
  {
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

  // ─── Ichimoku family ─────────────────────────────────────────────────
  {
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

  // ─── Momentum (extended) ─────────────────────────────────────────────
  {
    headline: "Aroon_up / Aroon_down / Aroon_osc",
    forms: [
      "Aroon_up(period=14)",
      "Aroon_down(period=14)",
      "Aroon_osc(period=14)",
    ],
    description:
      "Aroon shows how fresh the recent high or low is, on a 0–100 scale. Up = 100 means \"brand new high just happened\". Down = 100 means \"brand new low just happened\". The oscillator is Up minus Down — positive means uptrend, negative means downtrend.",
    examples: [
      {
        snippet: "filter.if = Aroon_up(14) > 80",
        scenario: "Only trade longs when a new 14-bar high happened very recently.",
      },
      {
        snippet: "filter.if = Aroon_osc(14) > 0",
        scenario: "Only trade in the direction of the current trend per Aroon.",
      },
    ],
  },
  {
    headline: "VortexPlus / VortexMinus",
    forms: ["VortexPlus(period=14)", "VortexMinus(period=14)"],
    description:
      "Two lines that try to spot trend changes. VI+ rising and crossing above VI- = bullish turn. VI- rising and crossing above VI+ = bearish turn. Use whichever line is bigger as the trend direction.",
    examples: [
      {
        snippet: "filter.if = VortexPlus(14) > VortexMinus(14)",
        scenario: "Only take longs when the bullish vortex line is dominant.",
      },
    ],
  },
  {
    headline: "DIplus / DIminus",
    forms: ["DIplus(period=14)", "DIminus(period=14)"],
    description:
      "The two halves of ADX, separated. DI+ measures upside push, DI- measures downside push. DI+ above DI- = uptrend. Pair with ADX itself for a \"trend AND strength\" filter.",
    examples: [
      {
        snippet: "filter.if = DIplus(14) > DIminus(14) && ADX > 25",
        scenario: "Only take longs in a strong uptrend (direction + strength both confirmed).",
      },
    ],
  },
  {
    headline: "AO / UO / Fisher",
    forms: [
      "AO", "AO()",
      "UO(short=7, mid=14, long=28)",
      "Fisher(period=10)",
    ],
    description:
      "Three momentum gauges. AO (Awesome Oscillator) = a simple difference of two median-price averages. UO (Ultimate Oscillator) = a 0–100 score blending buying pressure across three time windows. Fisher = a transform that makes momentum extremes stick out more clearly.",
    examples: [
      {
        snippet: "filter.if = AO > 0",
        scenario: "Only trade longs when the Awesome Oscillator is positive.",
      },
      {
        snippet: "filter.if = UO(7, 14, 28) > 70",
        scenario: "Only trade longs in clearly-buying conditions across multiple time windows.",
      },
    ],
  },

  // ─── Volatility / regime ────────────────────────────────────────────
  {
    headline: "Choppiness / Ulcer",
    forms: ["Choppiness(period=14)", "Ulcer(period=14)"],
    description:
      "Choppiness Index = a 0–100 score where high (above ~62) means \"market is going sideways\" and low (below ~38) means \"there's a real trend\". Ulcer Index = a downside-only volatility gauge — measures how deep the recent drawdowns have been.",
    examples: [
      {
        snippet: "filter.if = Choppiness(14) < 38",
        scenario: "Only trade in trending conditions; skip sideways chop.",
      },
    ],
  },

  // ─── Statistical ────────────────────────────────────────────────────
  {
    headline: "Zscore / LRSlope / LRIntercept / LRValue / R2",
    forms: [
      "Zscore(period)",
      "LRSlope(period)", "LRIntercept(period)",
      "LRValue(period)", "R2(period)",
    ],
    description:
      "Statistical readings of the last N closes. Zscore = how many standard deviations price is above/below its average (extreme readings = mean-reversion candidates). LRSlope = the slope of a best-fit line through the closes (positive = uptrend). R2 = how cleanly that line actually fits — closer to 1 means a strong, smooth trend.",
    examples: [
      {
        snippet: "filter.if = abs(Zscore(20)) > 2",
        scenario: "Only trade when price is unusually far from its 20-bar average — mean-reversion setup.",
      },
      {
        snippet: "filter.if = LRSlope(50) > 0 && R2(50) > 0.7",
        scenario: "Only trade in clean, well-defined uptrends.",
      },
    ],
  },

  // ─── Volume (extended) ──────────────────────────────────────────────
  {
    headline: "VWAP / KVO / ForceIndex / EMV / NVI / PVI",
    forms: [
      "VWAP(period)",
      "KVO(fast=34, slow=55)",
      "ForceIndex(period=13)",
      "EMV(period=14)",
      "NVI", "NVI()",
      "PVI", "PVI()",
    ],
    description:
      "More volume-based readings. VWAP = a fair-value price that accounts for how much volume happened at each price. KVO and ForceIndex = momentum readings that include volume. EMV = Ease of Movement (how easily price moves with low volume). NVI/PVI = running indices that only update on quiet days vs busy days respectively.",
    examples: [
      {
        snippet: "filter.if = close > VWAP(50)",
        scenario: "Only take longs when price is above the 50-bar volume-weighted fair-value line.",
      },
    ],
  },

  // ─── Volume profile (rolling N-bar window — REQUIRES tick session) ──
  {
    headline: "POC / VAH / VAL / VA_width / dist_to_POC (rolling)",
    forms: [
      "POC(N, area=0.7)",
      "VAH(N, area=0.7)",
      "VAL(N, area=0.7)",
      "VA_width(N, area=0.7)",
      "dist_to_POC(N, area=0.7)",
    ],
    description:
      "Volume profile shows where, by price level, the most trading happened over the last N bars. POC = the most-traded price (where buyers and sellers found agreement). VAH/VAL = the top and bottom of the price range that holds 70% of trading. Useful for finding fair value zones. NEEDS a tick session — returns nothing on plain OHLCV.",
    examples: [
      {
        snippet: "filter.if = close > VAL(20) && close < VAH(20)",
        scenario: "Only trade when price is inside the recent value zone (fair-value mean reversion).",
      },
      {
        snippet: "rules.takeProfitPoints = abs(close - POC(20))",
        scenario: "Aim profit at the most-traded price level — a magnet for mean reversion.",
      },
    ],
  },

  // ─── Tick microstructure (REQUIRES tick session) ────────────────────
  {
    headline: "Tick microstructure",
    forms: [
      "trades_at_bid(N)", "trades_at_ask(N)",
      "tick_imbalance(N)",
      "tick_count(N)", "mean_trade_size(N)",
      "large_trade_count(N, threshold)",
      "vwap_tick(N)",
    ],
    description:
      "Trade-by-trade metrics over the last N bars. `trades_at_ask` / `trades_at_bid` count how many trades hit each side (buy-aggressor vs sell-aggressor). `tick_imbalance` is a −1 to +1 score of which side is winning. `large_trade_count` finds big block prints. NEEDS a tick session.",
    examples: [
      {
        snippet: "filter.if = tick_imbalance(5) > 0.3",
        scenario: "Only take longs when buyers have been clearly aggressive over the last 5 bars.",
      },
      {
        snippet: "filter.if = large_trade_count(5, 50) >= 3",
        scenario: "Only trade after at least 3 big-size prints (50+ contracts) hit in the last 5 bars.",
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
      "These are calculations you can use inside any rule's number, or inside a filter to gate trades. They get computed at the moment of each trade's entry. Names with `[period]` mean you choose the lookback length (like `EMA(20)` or use the shortcut `EMA20`). Most work on any data, BUT a few special families need extra-detailed data: CVD/delta need bid-ask data, and volume-profile (POC, VAH, VAL) and tick-microstructure (trades_at_bid, vwap_tick) need full tick data — without it those return blanks and your filters will reject everything.",
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
