// PresetFilterEvaluator.cs
//
// Direct port of evaluatePresetFilters() from src/lib/utils/preset-filters.ts.
// Pure: takes a per-bar context snapshot + the preset's filters block + the
// signal direction + the bar's timestamp, and returns true iff every enabled
// sub-filter passes.
//
// Null-as-fail: when a filter is enabled but its corresponding context value
// is null (warmup window, indicator not yet stable), the entry is dropped —
// same behavior as the dashboard. This keeps live behavior conservative
// during the first ~200 bars of any session (until EMA200 stabilizes).

using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class PresetFilterEvaluator
    {
        /// <summary>
        /// Evaluate every enabled sub-filter against a snapshot. Returns true
        /// iff ALL enabled filters pass. Disabled filters are no-ops. The
        /// trend filter needs `direction` since "with"/"against" are
        /// direction-relative; the time filter needs the bar's timestamp to
        /// extract HH:MM.
        ///
        /// Order of checks: ADX → ATR → Trend → Bollinger → Time. Same order
        /// as the TS implementation; doesn't affect the AND result but keeps
        /// log/debug output predictable.
        /// </summary>
        public static bool Pass(
            PresetFilterContext ctx,
            PresetFilters filters,
            string direction,
            DateTime barTime)
        {
            // ── ADX ────────────────────────────────────────────────────────
            if (filters.Adx != null && filters.Adx.Enabled)
            {
                if (ctx.Adx14 == null) return false;
                if (ctx.Adx14.Value < filters.Adx.Min || ctx.Adx14.Value > filters.Adx.Max)
                    return false;
            }

            // ── ATR ────────────────────────────────────────────────────────
            if (filters.Atr != null && filters.Atr.Enabled)
            {
                if (ctx.Atr14 == null) return false;
                if (ctx.Atr14.Value < filters.Atr.Min || ctx.Atr14.Value > filters.Atr.Max)
                    return false;
            }

            // ── Trend (EMA20 + EMA200) ────────────────────────────────────
            // Direction-relative: "with"/"against" check the price-vs-EMA
            // string against the trade side. "any" disables that EMA leg.
            if (filters.Trend != null && filters.Trend.Enabled)
            {
                bool isLong = direction == "Long";

                if (!string.Equals(filters.Trend.Ema20Mode, "any", StringComparison.Ordinal))
                {
                    if (ctx.PriceVsEma20 == null) return false;
                    bool isWith =
                        (isLong  && ctx.PriceVsEma20 == "above") ||
                        (!isLong && ctx.PriceVsEma20 == "below");
                    if (filters.Trend.Ema20Mode == "with"    && !isWith) return false;
                    if (filters.Trend.Ema20Mode == "against" && isWith)  return false;
                }
                if (!string.Equals(filters.Trend.Ema200Mode, "any", StringComparison.Ordinal))
                {
                    if (ctx.PriceVsEma200 == null) return false;
                    bool isWith =
                        (isLong  && ctx.PriceVsEma200 == "above") ||
                        (!isLong && ctx.PriceVsEma200 == "below");
                    if (filters.Trend.Ema200Mode == "with"    && !isWith) return false;
                    if (filters.Trend.Ema200Mode == "against" && isWith)  return false;
                }
            }

            // ── Bollinger position ────────────────────────────────────────
            if (filters.Bollinger != null && filters.Bollinger.Enabled)
            {
                if (ctx.BollingerPos == null) return false;
                if (filters.Bollinger.Allowed == null ||
                    !filters.Bollinger.Allowed.Contains(ctx.BollingerPos))
                {
                    return false;
                }
            }

            // ── Bollinger band-width range ────────────────────────────────
            // Drops entries whose (upper − lower) is outside [Min, Max].
            // Null bw (warmup window) drops, same null-as-fail discipline.
            if (filters.BbWidth != null && filters.BbWidth.Enabled)
            {
                if (ctx.BollingerBw == null) return false;
                if (ctx.BollingerBw.Value < filters.BbWidth.Min ||
                    ctx.BollingerBw.Value > filters.BbWidth.Max)
                    return false;
            }

            // ── MA distance ───────────────────────────────────────────────
            // Three modes — see MaDistanceFilter docs in PresetSchema.cs:
            //   "absolute" — |distance| in [Min, Max]
            //   "above"    — distance ≥ 0 AND in [Min, Max]
            //   "below"    — distance ≤ 0 AND |distance| in [Min, Max]
            if (filters.MaDistance != null && filters.MaDistance.Enabled)
            {
                if (ctx.MaDistanceAtr == null) return false;
                double d = ctx.MaDistanceAtr.Value;
                double min = filters.MaDistance.Min;
                double max = filters.MaDistance.Max;
                string mode = filters.MaDistance.Mode ?? "absolute";

                if (mode == "above")
                {
                    if (d < 0) return false;
                    if (d < min || d > max) return false;
                }
                else if (mode == "below")
                {
                    if (d > 0) return false;
                    double ad = Math.Abs(d);
                    if (ad < min || ad > max) return false;
                }
                else // "absolute" (default)
                {
                    double ad = Math.Abs(d);
                    if (ad < min || ad > max) return false;
                }
            }

            // ── Volume ratio ──────────────────────────────────────────────
            // current bar volume / N-bar avg volume in [MinRatio, MaxRatio].
            // Null ratio (warmup or zero-volume MA) drops.
            if (filters.Volume != null && filters.Volume.Enabled)
            {
                if (ctx.VolumeRatio == null) return false;
                if (ctx.VolumeRatio.Value < filters.Volume.MinRatio ||
                    ctx.VolumeRatio.Value > filters.Volume.MaxRatio)
                    return false;
            }

            // ── RSI ───────────────────────────────────────────────────────
            // Wilder RSI in [Min, Max]. 0–100 scale; null drops.
            if (filters.Rsi != null && filters.Rsi.Enabled)
            {
                if (ctx.Rsi == null) return false;
                if (ctx.Rsi.Value < filters.Rsi.Min ||
                    ctx.Rsi.Value > filters.Rsi.Max)
                    return false;
            }

            // ── ADX direction ─────────────────────────────────────────────
            // Gates on the SIGN of the ADX slope (ADX[i] − ADX[i − lookback]).
            //   "rising"  → slope > FlatThreshold
            //   "falling" → slope < -FlatThreshold
            //   "flat"    → |slope| ≤ FlatThreshold
            //   "any"     → no-op (treat as filter off)
            if (filters.AdxTrend != null
                && filters.AdxTrend.Enabled
                && !string.Equals(filters.AdxTrend.Mode, "any", StringComparison.Ordinal))
            {
                if (ctx.AdxSlope == null) return false;
                double slope = ctx.AdxSlope.Value;
                double thresh = Math.Abs(filters.AdxTrend.FlatThreshold);
                string mode = filters.AdxTrend.Mode ?? "rising";
                if (mode == "rising")
                {
                    if (slope <= thresh) return false;
                }
                else if (mode == "falling")
                {
                    if (slope >= -thresh) return false;
                }
                else // "flat"
                {
                    if (Math.Abs(slope) > thresh) return false;
                }
            }

            // ── Time-of-day ───────────────────────────────────────────────
            // Multi-window: a bar passes when its time falls in ANY window
            // (OR semantics). Each window has the same wrap-around handling
            // as the legacy single-window check — from <= to → inclusive
            // [from, to]; from > to → wraps midnight.
            //
            // Falls back to the legacy [From, To] pair when Windows is
            // missing or empty so a partially-loaded preset still gates
            // correctly. The loader ensures Windows is non-empty after
            // load, so this fallback is just defensive.
            if (filters.Time != null && filters.Time.Enabled)
            {
                int barMin = barTime.Hour * 60 + barTime.Minute;
                var windows = (filters.Time.Windows != null && filters.Time.Windows.Count > 0)
                    ? filters.Time.Windows
                    : new List<TimeWindow> { new TimeWindow { From = filters.Time.From, To = filters.Time.To } };

                bool matched = false;
                foreach (var w in windows)
                {
                    int fromMin = ParseHM(w.From);
                    int toMin   = ParseHM(w.To);
                    if (fromMin <= toMin)
                    {
                        if (barMin >= fromMin && barMin <= toMin) { matched = true; break; }
                    }
                    else
                    {
                        // Wrap-around — inside when at/after fromMin OR
                        // at/before toMin.
                        if (barMin >= fromMin || barMin <= toMin) { matched = true; break; }
                    }
                }
                if (!matched) return false;
            }

            return true;
        }

        /// <summary>
        /// Parse "HH:MM" into minutes-since-midnight. Defaults to 0 on a
        /// malformed input — matches the TS `Number()` coercion semantics
        /// (NaN → 0 in the dashboard's parseHM helper).
        /// </summary>
        private static int ParseHM(string t)
        {
            if (string.IsNullOrEmpty(t)) return 0;
            var parts = t.Split(':');
            int h = 0, m = 0;
            if (parts.Length > 0) int.TryParse(parts[0], out h);
            if (parts.Length > 1) int.TryParse(parts[1], out m);
            return h * 60 + m;
        }
    }
}
