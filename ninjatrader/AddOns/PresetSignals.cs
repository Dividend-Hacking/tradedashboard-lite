// PresetSignals.cs
//
// Direct port of signalV1Events / signalV2Events from
// src/lib/utils/backtest-engine.ts:341-575. Both generators take the closed-
// bar history + the preset's params dict and emit a list of {barIndex,
// direction} signals — same as the dashboard.
//
// The runtime engine (PresetExecutor) only acts on the signal at the LATEST
// bar each call, but we run the full generator on every new bar because:
//   - Signal V2 has per-direction state (lockout, prevPos for cross-detection)
//     that requires walking the full series — there's no "online" shortcut.
//   - It keeps the math byte-for-byte identical to the backtest, which is
//     the whole point of the port.
//
// Performance: with a rolling buffer of 1000 bars, each generator is ~O(n×
// lookback). Even at 1-second bars that's microseconds per OnBarUpdate call.

using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class PresetSignals
    {
        /// <summary>
        /// Look up a numeric param by key. Returns the fallback when the key
        /// isn't present in the preset (forward-compat: a future preset
        /// without `staleBarsBack` still loads cleanly with the hard default).
        /// </summary>
        private static double Get(IDictionary<string, double> p, string key, double fallback)
        {
            double v;
            return p != null && p.TryGetValue(key, out v) ? v : fallback;
        }

        // ─── Signal V1 (range-break + pullback) ─────────────────────────────
        //
        // Mirrors signalV1Events() in backtest-engine.ts:341-423.
        //
        // For each bar past the warmup window:
        //   1. Compute pre-entry range over [i-lookback, i-1].
        //   2. longPos / shortPos = close-relative position in that range.
        //   3. Reject when 5-bar AND 10-bar momentum are both within ± flatBound (F2 flat filter).
        //   4. Long fires when (longPos >= atEdge) OR (longPos >= nearEdge AND
        //      pullback within tolerance), AND not stale, AND close > open.
        //   5. Short branch mirrors with shortPos / close < open / pullback +.
        // A bar can fire long OR short, never both — long branch wins by
        // returning continue.
        public static List<PresetSignal> GenerateV1(IList<PresetBar> bars, IDictionary<string, double> p)
        {
            var events = new List<PresetSignal>();

            int lookback     = Math.Max(1, (int)Math.Floor(Get(p, "lookback",       20)));
            int atrPeriod    = Math.Max(2, (int)Math.Floor(Get(p, "atrPeriod",      14)));
            double atEdge    = Get(p, "atEdgeThreshold",     0.85);
            double nearEdge  = Get(p, "nearEdgeThreshold",   0.5);
            double pullFrac  = Get(p, "pullbackAtrFraction", 0.4);
            double flatFrac  = Get(p, "flatAtrFraction",     0.2);
            double staleThr  = Get(p, "staleBreakThreshold", 1.05);
            int staleBack    = (int)Math.Floor(Get(p, "staleBarsBack", 15));

            // Need: lookback historical bars + ATR warmup + 5-bar momentum window.
            int minIndex = Math.Max(Math.Max(lookback, atrPeriod + 1), 5);
            if (bars.Count <= minIndex) return events;

            double[] atrVals = PresetIndicators.Atr(bars, atrPeriod);

            for (int i = minIndex; i < bars.Count; i++)
            {
                double atrV = atrVals[i];
                if (double.IsNaN(atrV) || atrV <= 0) continue;

                // Pre-entry range over bars[i-lookback..i-1].
                double rangeHigh = double.NegativeInfinity;
                double rangeLow  = double.PositiveInfinity;
                int highIdx = i - 1;
                int lowIdx  = i - 1;
                for (int j = i - lookback; j < i; j++)
                {
                    double h = bars[j].High;
                    double l = bars[j].Low;
                    if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
                    if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
                }
                double range = rangeHigh - rangeLow;
                if (range <= 0) continue;

                double close = bars[i].Close;
                double open  = bars[i].Open;
                double longPos  = (close - rangeLow) / range;
                double shortPos = (rangeHigh - close) / range;

                // Momentum windows (5-bar and 10-bar). Math.Max(0, i-10)
                // mirrors the TS bounds-clamp on the 10-bar window.
                double move5  = bars[i - 1].Close - bars[i - 5].Close;
                double move10 = bars[i - 1].Close - bars[Math.Max(0, i - 10)].Close;

                // F2 flat momentum — both windows must show movement.
                double flatBound = flatFrac * atrV;
                if (Math.Abs(move5) < flatBound && Math.Abs(move10) < flatBound) continue;

                // ── Long branch ────────────────────────────────────────────
                int longBarsSinceLevel = i - highIdx;
                bool longStale = longPos > staleThr && longBarsSinceLevel > staleBack;

                bool longSetup = false;
                if (longPos >= atEdge)
                {
                    longSetup = true;
                }
                else if (longPos >= nearEdge)
                {
                    double pullbackMin = -pullFrac * atrV;
                    longSetup = move5 >= pullbackMin && move5 <= 0;
                }
                bool longTrigger = close > open;

                if (longSetup && !longStale && longTrigger)
                {
                    events.Add(new PresetSignal { BarIndex = i, Direction = "Long" });
                    continue; // bar can't fire both directions
                }

                // ── Short branch (mirror) ──────────────────────────────────
                int shortBarsSinceLevel = i - lowIdx;
                bool shortStale = shortPos > staleThr && shortBarsSinceLevel > staleBack;

                bool shortSetup = false;
                if (shortPos >= atEdge)
                {
                    shortSetup = true;
                }
                else if (shortPos >= nearEdge)
                {
                    double pullbackMax = pullFrac * atrV;
                    shortSetup = move5 >= 0 && move5 <= pullbackMax;
                }
                bool shortTrigger = close < open;

                if (shortSetup && !shortStale && shortTrigger)
                {
                    events.Add(new PresetSignal { BarIndex = i, Direction = "Short" });
                }
            }
            return events;
        }

        // ─── Signal V2 (V1 + cross-into-zone + lockout + base filter) ───────
        //
        // Mirrors signalV2Events() in backtest-engine.ts:447-575.
        //
        // Adds three gates on top of V1:
        //   - Base quality: rangeInAtr ∈ [baseRangeAtrMin, baseRangeAtrMax]
        //     AND drift / range < baseDriftFraction.
        //   - Cross-into-zone: position must rise from < zoneEnterV2 to
        //     ≥ zoneEnterV2 on a single bar.
        //   - Per-direction lockout: once a direction fires, it's locked.
        //     Released when position drops below zoneExitV2 OR when
        //     cooldownBarsV2 bars have elapsed.
        //
        // Per-direction state (prevLongPos / prevShortPos / lockedSinceBar)
        // is walked across the full bar series within each call, so the
        // generator stays pure — same input ⇒ same output.
        public static List<PresetSignal> GenerateV2(IList<PresetBar> bars, IDictionary<string, double> p)
        {
            var events = new List<PresetSignal>();

            int lookback     = Math.Max(1, (int)Math.Floor(Get(p, "lookback",       20)));
            int atrPeriod    = Math.Max(2, (int)Math.Floor(Get(p, "atrPeriod",      14)));
            double atEdge    = Get(p, "atEdgeThreshold",     0.85);
            double nearEdge  = Get(p, "nearEdgeThreshold",   0.5);
            double pullFrac  = Get(p, "pullbackAtrFraction", 0.4);
            double flatFrac  = Get(p, "flatAtrFraction",     0.2);
            double staleThr  = Get(p, "staleBreakThreshold", 1.05);
            int staleBack    = (int)Math.Floor(Get(p, "staleBarsBack", 15));
            double enterV2   = Get(p, "zoneEnterV2",         0.5);
            double exitV2    = Get(p, "zoneExitV2",          0.3);
            int cooldown     = Math.Max(0, (int)Math.Floor(Get(p, "cooldownBarsV2", 30)));
            double baseMin   = Get(p, "baseRangeAtrMin",     1.5);
            double baseMax   = Get(p, "baseRangeAtrMax",     4.0);
            double driftFrac = Get(p, "baseDriftFraction",   0.5);

            int minIndex = Math.Max(Math.Max(lookback, atrPeriod + 1), 5);
            if (bars.Count <= minIndex) return events;

            double[] atrVals = PresetIndicators.Atr(bars, atrPeriod);

            // Per-direction state across the bar walk. Sentinel -1 = unlocked.
            // null prevPos means "no valid prior position" (NaN ATR or zero
            // range last bar) — cross-detection is suppressed until we have
            // two consecutive valid positions.
            double? prevLongPos  = null;
            double? prevShortPos = null;
            int longLockedSinceBar  = -1;
            int shortLockedSinceBar = -1;

            for (int i = minIndex; i < bars.Count; i++)
            {
                double atrV = atrVals[i];
                if (double.IsNaN(atrV) || atrV <= 0)
                {
                    prevLongPos = null;
                    prevShortPos = null;
                    continue;
                }

                double rangeHigh = double.NegativeInfinity;
                double rangeLow  = double.PositiveInfinity;
                int highIdx = i - 1;
                int lowIdx  = i - 1;
                for (int j = i - lookback; j < i; j++)
                {
                    double h = bars[j].High;
                    double l = bars[j].Low;
                    if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
                    if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
                }
                double range = rangeHigh - rangeLow;
                if (range <= 0)
                {
                    prevLongPos = null;
                    prevShortPos = null;
                    continue;
                }

                // Base filter: range/ATR within bounds AND drift < threshold.
                double rangeInAtr = range / atrV;
                bool isReasonableSize = rangeInAtr >= baseMin && rangeInAtr <= baseMax;
                double drift = Math.Abs(bars[i - 1].Close - bars[i - lookback].Close);
                bool isLowDrift = drift / range < driftFrac;
                bool isBase = isReasonableSize && isLowDrift;

                double close = bars[i].Close;
                double open  = bars[i].Open;
                double longPos  = (close - rangeLow) / range;
                double shortPos = (rangeHigh - close) / range;

                double move5  = bars[i - 1].Close - bars[i - 5].Close;
                double move10 = bars[i - 1].Close - bars[Math.Max(0, i - 10)].Close;
                double flatBound = flatFrac * atrV;
                bool isFlat = Math.Abs(move5) < flatBound && Math.Abs(move10) < flatBound;

                // Lockout release: position-based OR time-based.
                if (longLockedSinceBar >= 0)
                {
                    int elapsed = i - longLockedSinceBar;
                    if (longPos < exitV2 || elapsed >= cooldown) longLockedSinceBar = -1;
                }
                if (shortLockedSinceBar >= 0)
                {
                    int elapsed = i - shortLockedSinceBar;
                    if (shortPos < exitV2 || elapsed >= cooldown) shortLockedSinceBar = -1;
                }

                // Cross-into-zone detection — strict inequality on prev.
                bool longCrossedIn =
                    prevLongPos != null && prevLongPos.Value < enterV2 && longPos >= enterV2;
                bool shortCrossedIn =
                    prevShortPos != null && prevShortPos.Value < enterV2 && shortPos >= enterV2;

                bool firedLong = false;

                if (longLockedSinceBar < 0 && longCrossedIn && isBase && !isFlat)
                {
                    bool longSetup = false;
                    if (longPos >= atEdge)
                    {
                        longSetup = true;
                    }
                    else if (longPos >= nearEdge)
                    {
                        double pullbackMin = -pullFrac * atrV;
                        longSetup = move5 >= pullbackMin && move5 <= 0;
                    }
                    int longBarsSinceLevel = i - highIdx;
                    bool longStale = longPos > staleThr && longBarsSinceLevel > staleBack;
                    bool longTrigger = close > open;
                    if (longSetup && !longStale && longTrigger)
                    {
                        events.Add(new PresetSignal { BarIndex = i, Direction = "Long" });
                        longLockedSinceBar = i;
                        firedLong = true;
                    }
                }

                if (!firedLong && shortLockedSinceBar < 0 && shortCrossedIn && isBase && !isFlat)
                {
                    bool shortSetup = false;
                    if (shortPos >= atEdge)
                    {
                        shortSetup = true;
                    }
                    else if (shortPos >= nearEdge)
                    {
                        double pullbackMax = pullFrac * atrV;
                        shortSetup = move5 >= 0 && move5 <= pullbackMax;
                    }
                    int shortBarsSinceLevel = i - lowIdx;
                    bool shortStale = shortPos > staleThr && shortBarsSinceLevel > staleBack;
                    bool shortTrigger = close < open;
                    if (shortSetup && !shortStale && shortTrigger)
                    {
                        events.Add(new PresetSignal { BarIndex = i, Direction = "Short" });
                        shortLockedSinceBar = i;
                    }
                }

                prevLongPos = longPos;
                prevShortPos = shortPos;
            }
            return events;
        }

        // ─── Signal V3 (V2 + multi-bar acceptance + body/range trigger) ────
        //
        // Mirrors signalV3Events() in backtest-engine.ts.
        //
        // V3 keeps every V2 gate (base filter, near/at-edge, pullback, flat,
        // stale, lockout, cooldown) and tightens two parts most prone to
        // noise on small (15s/30s) timeframes:
        //
        //   1. Multi-bar acceptance: replaces V2's prevPos cross-detection
        //      with a per-direction in-zone STREAK counter. Increments while
        //      pos >= zoneEnterV2, resets to 0 otherwise. Fires on the bar
        //      that brings the streak to acceptanceBarsV3. The lockout
        //      suppresses re-fires once the streak climbs past the threshold.
        //
        //   2. Body/range trigger: replaces V2's bare close>open / close<open
        //      with |close - open| / (high - low) >= bodyRatioMinV3. Bar
        //      direction is still required; wicky / doji / zero-range bars
        //      are rejected even when their close direction agrees.
        public static List<PresetSignal> GenerateV3(IList<PresetBar> bars, IDictionary<string, double> p)
        {
            var events = new List<PresetSignal>();

            int lookback     = Math.Max(1, (int)Math.Floor(Get(p, "lookback",       20)));
            int atrPeriod    = Math.Max(2, (int)Math.Floor(Get(p, "atrPeriod",      14)));
            double atEdge    = Get(p, "atEdgeThreshold",     0.85);
            double nearEdge  = Get(p, "nearEdgeThreshold",   0.5);
            double pullFrac  = Get(p, "pullbackAtrFraction", 0.4);
            double flatFrac  = Get(p, "flatAtrFraction",     0.2);
            double staleThr  = Get(p, "staleBreakThreshold", 1.05);
            int staleBack    = (int)Math.Floor(Get(p, "staleBarsBack", 15));
            double enterV2   = Get(p, "zoneEnterV2",         0.5);
            double exitV2    = Get(p, "zoneExitV2",          0.3);
            int cooldown     = Math.Max(0, (int)Math.Floor(Get(p, "cooldownBarsV2", 30)));
            double baseMin   = Get(p, "baseRangeAtrMin",     1.5);
            double baseMax   = Get(p, "baseRangeAtrMax",     4.0);
            double driftFrac = Get(p, "baseDriftFraction",   0.5);
            int acceptanceBars = Math.Max(1, (int)Math.Floor(Get(p, "acceptanceBarsV3", 2)));
            double bodyRatioMin = Get(p, "bodyRatioMinV3",   0.5);

            int minIndex = Math.Max(Math.Max(lookback, atrPeriod + 1), 5);
            if (bars.Count <= minIndex) return events;

            double[] atrVals = PresetIndicators.Atr(bars, atrPeriod);

            // V3 streak counters replace V2's prevPos tracking; sentinel -1
            // means "not currently locked out".
            int longStreak = 0;
            int shortStreak = 0;
            int longLockedSinceBar  = -1;
            int shortLockedSinceBar = -1;

            for (int i = minIndex; i < bars.Count; i++)
            {
                double atrV = atrVals[i];
                if (double.IsNaN(atrV) || atrV <= 0)
                {
                    longStreak = 0;
                    shortStreak = 0;
                    continue;
                }

                double rangeHigh = double.NegativeInfinity;
                double rangeLow  = double.PositiveInfinity;
                int highIdx = i - 1;
                int lowIdx  = i - 1;
                for (int j = i - lookback; j < i; j++)
                {
                    double h = bars[j].High;
                    double l = bars[j].Low;
                    if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
                    if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
                }
                double range = rangeHigh - rangeLow;
                if (range <= 0)
                {
                    longStreak = 0;
                    shortStreak = 0;
                    continue;
                }

                // Base filter (same as V2).
                double rangeInAtr = range / atrV;
                bool isReasonableSize = rangeInAtr >= baseMin && rangeInAtr <= baseMax;
                double drift = Math.Abs(bars[i - 1].Close - bars[i - lookback].Close);
                bool isLowDrift = drift / range < driftFrac;
                bool isBase = isReasonableSize && isLowDrift;

                double close = bars[i].Close;
                double open  = bars[i].Open;
                double high  = bars[i].High;
                double low   = bars[i].Low;
                double longPos  = (close - rangeLow) / range;
                double shortPos = (rangeHigh - close) / range;

                double move5  = bars[i - 1].Close - bars[i - 5].Close;
                double move10 = bars[i - 1].Close - bars[Math.Max(0, i - 10)].Close;
                double flatBound = flatFrac * atrV;
                bool isFlat = Math.Abs(move5) < flatBound && Math.Abs(move10) < flatBound;

                // Lockout release (same as V2).
                if (longLockedSinceBar >= 0)
                {
                    int elapsed = i - longLockedSinceBar;
                    if (longPos < exitV2 || elapsed >= cooldown) longLockedSinceBar = -1;
                }
                if (shortLockedSinceBar >= 0)
                {
                    int elapsed = i - shortLockedSinceBar;
                    if (shortPos < exitV2 || elapsed >= cooldown) shortLockedSinceBar = -1;
                }

                // Streak update — increment while in zone, reset otherwise.
                longStreak  = longPos  >= enterV2 ? longStreak  + 1 : 0;
                shortStreak = shortPos >= enterV2 ? shortStreak + 1 : 0;

                bool longAccepted  = longStreak  == acceptanceBars;
                bool shortAccepted = shortStreak == acceptanceBars;

                // Body/range trigger gate. Zero-range bars score 0 → rejected.
                double barRange = high - low;
                double bodyRatio = barRange > 0 ? Math.Abs(close - open) / barRange : 0;

                bool firedLong = false;

                if (longLockedSinceBar < 0 && longAccepted && isBase && !isFlat)
                {
                    bool longSetup = false;
                    if (longPos >= atEdge)
                    {
                        longSetup = true;
                    }
                    else if (longPos >= nearEdge)
                    {
                        double pullbackMin = -pullFrac * atrV;
                        longSetup = move5 >= pullbackMin && move5 <= 0;
                    }
                    int longBarsSinceLevel = i - highIdx;
                    bool longStale = longPos > staleThr && longBarsSinceLevel > staleBack;
                    bool longTrigger = close > open && bodyRatio >= bodyRatioMin;
                    if (longSetup && !longStale && longTrigger)
                    {
                        events.Add(new PresetSignal { BarIndex = i, Direction = "Long" });
                        longLockedSinceBar = i;
                        firedLong = true;
                    }
                }

                if (!firedLong && shortLockedSinceBar < 0 && shortAccepted && isBase && !isFlat)
                {
                    bool shortSetup = false;
                    if (shortPos >= atEdge)
                    {
                        shortSetup = true;
                    }
                    else if (shortPos >= nearEdge)
                    {
                        double pullbackMax = pullFrac * atrV;
                        shortSetup = move5 >= 0 && move5 <= pullbackMax;
                    }
                    int shortBarsSinceLevel = i - lowIdx;
                    bool shortStale = shortPos > staleThr && shortBarsSinceLevel > staleBack;
                    bool shortTrigger = close < open && bodyRatio >= bodyRatioMin;
                    if (shortSetup && !shortStale && shortTrigger)
                    {
                        events.Add(new PresetSignal { BarIndex = i, Direction = "Short" });
                        shortLockedSinceBar = i;
                    }
                }
            }
            return events;
        }

        // ─── Signal V2 Failed (inverse of V2 — failed-breakout fade) ────────
        //
        // Mirrors signalV2FailedEvents() in backtest-engine.ts.
        //
        // Same gating as V2 (same params, same setup/filter/lockout logic);
        // the only difference is each emitted signal's direction is flipped.
        // Where V2 fires Long (upside breakout) this fires Short, betting the
        // breakout fails. Implemented as a wrapper over GenerateV2 so the
        // criteria stay in lockstep — any tweak to V2's gates is inherited
        // here automatically, keeping dashboard/NT8 parity trivial to verify.
        public static List<PresetSignal> GenerateV2Failed(IList<PresetBar> bars, IDictionary<string, double> p)
        {
            var baseEvents = GenerateV2(bars, p);
            var flipped = new List<PresetSignal>(baseEvents.Count);
            for (int i = 0; i < baseEvents.Count; i++)
            {
                var e = baseEvents[i];
                flipped.Add(new PresetSignal
                {
                    BarIndex = e.BarIndex,
                    Direction = e.Direction == "Long" ? "Short" : "Long",
                });
            }
            return flipped;
        }

        // ─── Failed Break V1 (fade-native, fixes V2-failed mis-signs) ───────
        //
        // Mirrors failedBreakV1Events() in backtest-engine.ts. V2-failed was
        // just signalV2 with directions flipped, which mis-signs three of V2's
        // gates for fade setups. This generator fixes those three and ONLY
        // those three; everything else (cross-into-zone, lockout, flat,
        // stale, candle-direction trigger) is identical to V2.
        //
        //   FIX 1 — Pullback → Thrust: V1/V2 near-edge fires only on a small
        //           counter-trend pullback into the level. Fades want the
        //           opposite: an aggressive same-direction thrust. We require
        //           |move5| >= thrustFrac × atr in the breakout direction.
        //
        //   FIX 2 — Add poke / sweep gate: V2 ignores the wick. Fade-able
        //           breakouts pierce the level on the wick (stop-run) and
        //           close back inside. Require bar.High >= rangeHigh +
        //           sweepFrac × atr (and the symmetric bar.Low gate).
        //
        //   FIX 3 — Flip base filter: V2's base filter selects tight coils
        //           (low drift, bounded range/ATR) — the regime breakouts
        //           SUCCEED in. Drop the upper bound on rangeInAtr, and
        //           REQUIRE drift / range >= fadeDriftMin (trending into
        //           the level), opposite of V2's <.
        //
        // Direction is emitted PRE-FLIPPED — the long-side detection branch
        // emits Short (fading the upside breakout), short-side emits Long.
        public static List<PresetSignal> GenerateFailedBreakV1(IList<PresetBar> bars, IDictionary<string, double> p)
        {
            var events = new List<PresetSignal>();

            int lookback     = Math.Max(1, (int)Math.Floor(Get(p, "lookback",       20)));
            int atrPeriod    = Math.Max(2, (int)Math.Floor(Get(p, "atrPeriod",      14)));
            double atEdge    = Get(p, "atEdgeThreshold",      0.85);
            double nearEdge  = Get(p, "nearEdgeThreshold",    0.5);
            double thrustFrac = Get(p, "thrustAtrFraction",   0.5);
            double sweepFrac = Get(p, "sweepAtrFraction",     0.1);
            double flatFrac  = Get(p, "flatAtrFraction",      0.2);
            double staleThr  = Get(p, "staleBreakThreshold",  1.05);
            int staleBack    = (int)Math.Floor(Get(p, "staleBarsBack", 15));
            double enterV2   = Get(p, "zoneEnterV2",          0.5);
            double exitV2    = Get(p, "zoneExitV2",           0.3);
            int cooldown     = Math.Max(0, (int)Math.Floor(Get(p, "cooldownBarsV2", 30)));
            double fadeRangeMin = Get(p, "fadeRangeAtrMin",   1.0);
            double fadeDriftMin = Get(p, "fadeDriftFractionMin", 0.4);

            int minIndex = Math.Max(Math.Max(lookback, atrPeriod + 1), 5);
            if (bars.Count <= minIndex) return events;

            double[] atrVals = PresetIndicators.Atr(bars, atrPeriod);

            double? prevLongPos  = null;
            double? prevShortPos = null;
            int longLockedSinceBar  = -1;
            int shortLockedSinceBar = -1;

            for (int i = minIndex; i < bars.Count; i++)
            {
                double atrV = atrVals[i];
                if (double.IsNaN(atrV) || atrV <= 0)
                {
                    prevLongPos = null;
                    prevShortPos = null;
                    continue;
                }

                double rangeHigh = double.NegativeInfinity;
                double rangeLow  = double.PositiveInfinity;
                int highIdx = i - 1;
                int lowIdx  = i - 1;
                for (int j = i - lookback; j < i; j++)
                {
                    double h = bars[j].High;
                    double l = bars[j].Low;
                    if (h > rangeHigh) { rangeHigh = h; highIdx = j; }
                    if (l < rangeLow)  { rangeLow  = l; lowIdx  = j; }
                }
                double range = rangeHigh - rangeLow;
                if (range <= 0)
                {
                    prevLongPos = null;
                    prevShortPos = null;
                    continue;
                }

                // FIX 3 — fade-tuned base filter: lower-bound only on
                // rangeInAtr, drift sign FLIPPED (must be high, not low).
                double rangeInAtr = range / atrV;
                double drift = Math.Abs(bars[i - 1].Close - bars[i - lookback].Close);
                bool isFadeBase = rangeInAtr >= fadeRangeMin && drift / range >= fadeDriftMin;

                double close = bars[i].Close;
                double open  = bars[i].Open;
                double high  = bars[i].High;
                double low   = bars[i].Low;
                double longPos  = (close - rangeLow) / range;
                double shortPos = (rangeHigh - close) / range;

                double move5  = bars[i - 1].Close - bars[i - 5].Close;
                double move10 = bars[i - 1].Close - bars[Math.Max(0, i - 10)].Close;
                double flatBound = flatFrac * atrV;
                bool isFlat = Math.Abs(move5) < flatBound && Math.Abs(move10) < flatBound;

                if (longLockedSinceBar >= 0)
                {
                    int elapsed = i - longLockedSinceBar;
                    if (longPos < exitV2 || elapsed >= cooldown) longLockedSinceBar = -1;
                }
                if (shortLockedSinceBar >= 0)
                {
                    int elapsed = i - shortLockedSinceBar;
                    if (shortPos < exitV2 || elapsed >= cooldown) shortLockedSinceBar = -1;
                }

                bool longCrossedIn =
                    prevLongPos != null && prevLongPos.Value < enterV2 && longPos >= enterV2;
                bool shortCrossedIn =
                    prevShortPos != null && prevShortPos.Value < enterV2 && shortPos >= enterV2;

                bool firedLong = false;

                // Long-side breakout poke → fade SHORT.
                if (longLockedSinceBar < 0 && longCrossedIn && isFadeBase && !isFlat)
                {
                    bool longBreakoutSetup = false;
                    if (longPos >= atEdge)
                    {
                        longBreakoutSetup = true;
                    }
                    else if (longPos >= nearEdge)
                    {
                        // FIX 1 — thrust into the level (same-direction), not a pullback away.
                        double thrustMin = thrustFrac * atrV;
                        longBreakoutSetup = move5 >= thrustMin;
                    }
                    // FIX 2 — wick must pierce the level by sweepFrac × ATR.
                    double sweepMin = sweepFrac * atrV;
                    bool longSweep = high >= rangeHigh + sweepMin;

                    int longBarsSinceLevel = i - highIdx;
                    bool longStale = longPos > staleThr && longBarsSinceLevel > staleBack;
                    bool longTrigger = close > open;
                    if (longBreakoutSetup && longSweep && !longStale && longTrigger)
                    {
                        events.Add(new PresetSignal { BarIndex = i, Direction = "Short" });
                        longLockedSinceBar = i;
                        firedLong = true;
                    }
                }

                // Short-side breakout poke → fade LONG.
                if (!firedLong && shortLockedSinceBar < 0 && shortCrossedIn && isFadeBase && !isFlat)
                {
                    bool shortBreakoutSetup = false;
                    if (shortPos >= atEdge)
                    {
                        shortBreakoutSetup = true;
                    }
                    else if (shortPos >= nearEdge)
                    {
                        // FIX 1 mirror — thrust DOWN into the level.
                        double thrustMin = thrustFrac * atrV;
                        shortBreakoutSetup = move5 <= -thrustMin;
                    }
                    // FIX 2 mirror — wick must pierce the level downward.
                    double sweepMin = sweepFrac * atrV;
                    bool shortSweep = low <= rangeLow - sweepMin;

                    int shortBarsSinceLevel = i - lowIdx;
                    bool shortStale = shortPos > staleThr && shortBarsSinceLevel > staleBack;
                    bool shortTrigger = close < open;
                    if (shortBreakoutSetup && shortSweep && !shortStale && shortTrigger)
                    {
                        events.Add(new PresetSignal { BarIndex = i, Direction = "Long" });
                        shortLockedSinceBar = i;
                    }
                }

                prevLongPos = longPos;
                prevShortPos = shortPos;
            }
            return events;
        }

        /// <summary>
        /// Dispatch by strategyId — the executor calls this so adding a new
        /// signal generator in the future is a single-line addition here
        /// rather than a switch in every call site.
        /// </summary>
        public static List<PresetSignal> Generate(string strategyId, IList<PresetBar> bars, IDictionary<string, double> p)
        {
            switch (strategyId)
            {
                case "signal_v1":         return GenerateV1(bars, p);
                case "signal_v2":         return GenerateV2(bars, p);
                case "signal_v3":         return GenerateV3(bars, p);
                case "signal_v2_failed":  return GenerateV2Failed(bars, p);
                case "failed_break_v1":   return GenerateFailedBreakV1(bars, p);
                default:
                    // Unknown strategy → empty signal list; the executor
                    // logs the unknown id and disarms.
                    return new List<PresetSignal>();
            }
        }
    }
}
