// PresetIndicators.cs
//
// Pure indicator math — direct port of src/lib/utils/backtest-engine.ts
// (atrSeries / emaSeries / adxSeries / bollingerSeries). The dashboard
// re-implements these separately from the chart-rendering versions in
// src/lib/indicators/calculations.ts so that backtests + live auto-trader
// see identical math. We mirror the BACKTEST-ENGINE versions specifically
// so a preset that works in the simulator behaves the same in NT8.
//
// All methods take an IList<PresetBar> (oldest-first) and return a double[]
// aligned 1-to-1 with the input — NaN before warmup. No NT8 dependencies
// so this can be unit-tested in a plain console harness if we ever want
// to verify parity bar-by-bar against the TS implementation.

using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class PresetIndicators
    {
        // ─── ATR (Wilder smoothing) ─────────────────────────────────────────
        //
        // Mirrors atrSeries() in backtest-engine.ts:84-106.
        //   1. TR series starts at index 1 (needs prev close).
        //   2. Seed = simple average of the first `period` TRs → out[period].
        //   3. Wilder smooth: prev = (prev*(period-1) + tr) / period.
        //
        // out[i] = NaN for i < period. Returned array length == bars.Count.
        public static double[] Atr(IList<PresetBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 0; i < n; i++) outArr[i] = double.NaN;
            if (n < period + 1 || period < 1) return outArr;

            // True-range series indexed 0..n-2 (TR at i corresponds to bars[i+1]).
            var trs = new double[n - 1];
            for (int i = 1; i < n; i++)
            {
                double h = bars[i].High;
                double l = bars[i].Low;
                double pc = bars[i - 1].Close;
                trs[i - 1] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }

            // Seed: simple mean of first `period` TRs.
            double seed = 0;
            for (int i = 0; i < period; i++) seed += trs[i];
            double prev = seed / period;
            outArr[period] = prev;

            // Wilder recursion. trs[i] aligns with bars[i+1], so the output
            // for trs[i] lands at outArr[i+1]. The TS version writes to
            // out[i+1] inside the loop too — keep this alignment to match.
            for (int i = period; i < trs.Length; i++)
            {
                prev = (prev * (period - 1) + trs[i]) / period;
                outArr[i + 1] = prev;
            }
            return outArr;
        }

        // ─── SMA ────────────────────────────────────────────────────────────
        //
        // Mirrors smaSeries() in backtest-engine.ts. Simple rolling mean of
        // the last `period` closes. NaN before warmup. Used by the
        // configurable trend / MA-distance filters when type="sma".
        public static double[] Sma(IList<PresetBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 0; i < n; i++) outArr[i] = double.NaN;
            if (period <= 0 || n < period) return outArr;

            double sum = 0;
            for (int i = 0; i < period; i++) sum += bars[i].Close;
            outArr[period - 1] = sum / period;
            for (int i = period; i < n; i++)
            {
                sum += bars[i].Close - bars[i - period].Close;
                outArr[i] = sum / period;
            }
            return outArr;
        }

        // ─── Volume MA (rolling mean of bar_volume) ─────────────────────────
        //
        // Mirrors volumeMaSeries() in backtest-engine.ts. Drives the volume
        // ratio filter — current bar volume / N-bar avg volume.
        public static double[] VolumeMa(IList<PresetBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 0; i < n; i++) outArr[i] = double.NaN;
            if (period <= 0 || n < period) return outArr;

            double sum = 0;
            for (int i = 0; i < period; i++) sum += bars[i].Volume;
            outArr[period - 1] = sum / period;
            for (int i = period; i < n; i++)
            {
                sum += bars[i].Volume - bars[i - period].Volume;
                outArr[i] = sum / period;
            }
            return outArr;
        }

        // ─── Dispatch by string type ────────────────────────────────────────
        //
        // Mirrors maSeriesByType() in backtest-engine.ts. Lets every
        // MA-based filter pick its smoothing flavor without duplicating
        // the dispatch.
        public static double[] MaByType(IList<PresetBar> bars, int period, string type)
        {
            return string.Equals(type, "sma", StringComparison.OrdinalIgnoreCase)
                ? Sma(bars, period)
                : Ema(bars, period);
        }

        // ─── EMA (SMA-seeded) ───────────────────────────────────────────────
        //
        // Mirrors emaSeries() in backtest-engine.ts:112-125.
        //   1. Seed = SMA of first `period` closes → out[period - 1].
        //   2. alpha = 2 / (period + 1).
        //   3. Recursion: ema = close * alpha + ema_prev * (1 - alpha).
        //
        // out[i] = NaN for i < period - 1.
        public static double[] Ema(IList<PresetBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 0; i < n; i++) outArr[i] = double.NaN;
            if (period <= 0 || n < period) return outArr;

            double seed = 0;
            for (int i = 0; i < period; i++) seed += bars[i].Close;
            double prev = seed / period;
            outArr[period - 1] = prev;

            double alpha = 2.0 / (period + 1.0);
            for (int i = period; i < n; i++)
            {
                prev = bars[i].Close * alpha + prev * (1.0 - alpha);
                outArr[i] = prev;
            }
            return outArr;
        }

        // ─── ADX (Wilder, double-smoothed) ──────────────────────────────────
        //
        // Mirrors adxSeries() in backtest-engine.ts:131-188. Per-step alignment
        // is fiddly: the +DM / -DM / TR series start at index 1 (need previous
        // bar), the Wilder-smoothed sums have length (rawLen - period + 1),
        // and the final ADX is Wilder-smoothed AGAIN over DX. Final-array
        // index for the FIRST valid ADX is (2 * period - 1) — the warmup
        // accounts for both smoothing passes.
        //
        // Returns NaN before warmup.
        public static double[] Adx(IList<PresetBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 0; i < n; i++) outArr[i] = double.NaN;
            if (period <= 0 || n < 2 * period + 1) return outArr;

            // Build raw +DM / -DM / TR series indexed 0..n-2 (each entry
            // corresponds to bars[i+1] vs bars[i]).
            var plusDM  = new double[n - 1];
            var minusDM = new double[n - 1];
            var trs     = new double[n - 1];
            for (int i = 1; i < n; i++)
            {
                double upMove   = bars[i].High - bars[i - 1].High;
                double downMove = bars[i - 1].Low - bars[i].Low;
                plusDM[i - 1]  = (upMove > downMove && upMove > 0) ? upMove : 0;
                minusDM[i - 1] = (downMove > upMove && downMove > 0) ? downMove : 0;
                double h = bars[i].High;
                double l = bars[i].Low;
                double pc = bars[i - 1].Close;
                trs[i - 1] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }

            // Wilder-smooth a series. Output length == series.Length - period + 1.
            // First entry = sum of first `period` raw values; subsequent =
            // sum - sum/period + next_raw.
            double[] Wilder(double[] series)
            {
                if (series.Length < period) return new double[0];
                int outLen = series.Length - period + 1;
                var smoothed = new double[outLen];
                double sum = 0;
                for (int i = 0; i < period; i++) sum += series[i];
                smoothed[0] = sum;
                for (int i = period; i < series.Length; i++)
                {
                    sum = sum - sum / period + series[i];
                    smoothed[i - period + 1] = sum;
                }
                return smoothed;
            }

            var plusSmooth  = Wilder(plusDM);
            var minusSmooth = Wilder(minusDM);
            var trSmooth    = Wilder(trs);

            // DX series, same length as the smoothed inputs. When TR-smooth
            // is zero, DX is zero (avoid div-by-zero).
            int dxLen = trSmooth.Length;
            var dx = new double[dxLen];
            for (int i = 0; i < dxLen; i++)
            {
                if (trSmooth[i] == 0) { dx[i] = 0; continue; }
                double plusDI  = (100.0 * plusSmooth[i]) / trSmooth[i];
                double minusDI = (100.0 * minusSmooth[i]) / trSmooth[i];
                double sumDi   = plusDI + minusDI;
                dx[i] = sumDi == 0 ? 0 : (100.0 * Math.Abs(plusDI - minusDI)) / sumDi;
            }
            if (dx.Length < period) return outArr;

            // Wilder-smooth DX itself to get ADX. Seed = mean of first
            // `period` DX values; lands at out[2*period - 1] (the TS source
            // sets out[2 * period - 1] = prev as the first valid ADX).
            double adxSum = 0;
            for (int i = 0; i < period; i++) adxSum += dx[i];
            double prev = adxSum / period;
            outArr[2 * period - 1] = prev;
            for (int i = period; i < dx.Length; i++)
            {
                prev = (prev * (period - 1) + dx[i]) / period;
                // dx[i] aligns with bars[i + period] (period-1 lag for the
                // first wilder pass + 1 for the +DM/TR series). The TS
                // source uses out[i + period]; we mirror exactly.
                outArr[i + period] = prev;
            }
            return outArr;
        }

        // ─── RSI (Wilder smoothing) ─────────────────────────────────────────
        //
        // Mirrors rsiSeries() in backtest-engine.ts. Standard Wilder RSI:
        //   1. gains/losses per bar (close diff, clamped to non-negative).
        //   2. Seed avg gain/loss = simple mean over the first `period`
        //      diffs (indices 1..period). First valid RSI lands at out[period].
        //   3. Wilder smooth: avg = (avg*(period-1) + new) / period.
        // RSI = 100 when avgLoss is zero; otherwise 100 − 100 / (1 + RS),
        // RS = avgGain / avgLoss.
        public static double[] Rsi(IList<PresetBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 0; i < n; i++) outArr[i] = double.NaN;
            if (period <= 0 || n < period + 1) return outArr;

            var gains  = new double[n];
            var losses = new double[n];
            for (int i = 1; i < n; i++)
            {
                double change = bars[i].Close - bars[i - 1].Close;
                gains[i]  = change > 0 ?  change : 0;
                losses[i] = change < 0 ? -change : 0;
            }

            double avgGain = 0;
            double avgLoss = 0;
            for (int i = 1; i <= period; i++)
            {
                avgGain += gains[i];
                avgLoss += losses[i];
            }
            avgGain /= period;
            avgLoss /= period;

            outArr[period] = avgLoss == 0
                ? 100
                : 100 - 100 / (1 + avgGain / avgLoss);

            for (int i = period + 1; i < n; i++)
            {
                avgGain = (avgGain * (period - 1) + gains[i]) / period;
                avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
                outArr[i] = avgLoss == 0
                    ? 100
                    : 100 - 100 / (1 + avgGain / avgLoss);
            }
            return outArr;
        }

        // ─── Bollinger (SMA + sample-stddev bands) ──────────────────────────
        //
        // Mirrors bollingerSeries() in backtest-engine.ts:200-237. Returns one
        // PresetBollingerPoint per bar; pos is null and bw is NaN before warmup.
        // Sample stddev (n-1 divisor) matches the convention most charting
        // libraries use — switching to population would shift bands tighter.
        public static PresetBollingerPoint[] Bollinger(IList<PresetBar> bars, int period, double multiplier)
        {
            int n = bars.Count;
            var outArr = new PresetBollingerPoint[n];
            for (int i = 0; i < n; i++) outArr[i] = new PresetBollingerPoint { Pos = null, Bw = double.NaN };
            if (period <= 0 || n < period) return outArr;

            for (int i = period - 1; i < n; i++)
            {
                double sum = 0;
                for (int j = i - period + 1; j <= i; j++) sum += bars[j].Close;
                double mean = sum / period;

                double varSum = 0;
                for (int j = i - period + 1; j <= i; j++)
                {
                    double d = bars[j].Close - mean;
                    varSum += d * d;
                }
                double stdev = Math.Sqrt(varSum / Math.Max(1, period - 1));
                double upper = mean + multiplier * stdev;
                double lower = mean - multiplier * stdev;
                double close = bars[i].Close;

                string pos;
                if (close > upper)      pos = "above_upper";
                else if (close < lower) pos = "below_lower";
                else                    pos = "inside";

                outArr[i] = new PresetBollingerPoint { Pos = pos, Bw = upper - lower };
            }
            return outArr;
        }

        // ─── Convenience: build a complete FilterContext at one bar ─────────
        //
        // Mirrors snapshotContext() in backtest-engine.ts:282-314. Used by
        // PresetExecutor to build the per-bar snapshot the FilterEvaluator
        // consumes. atr14 / adx14 / ema20 / ema200 / bollinger inputs are
        // pre-computed series aligned 1-to-1 with the bar buffer.
        //
        // Each ctx_* field falls back to null when its underlying indicator
        // hasn't warmed up, matching the TS null-as-fail behavior.
        public static PresetFilterContext Snapshot(
            double[] atr14,
            double[] adx14,
            double[] ema20,
            double[] ema200,
            PresetBollingerPoint[] bollinger,
            double[] maDistance,
            double[] volumeMa,
            double[] rsi,
            double barVolume,
            double closeAtBar,
            int index,
            int adxSlopeLookback)
        {
            double atr  = atr14[index];
            double adx  = adx14[index];
            double e20  = ema20[index];
            double e200 = ema200[index];
            PresetBollingerPoint bb = bollinger[index] ?? new PresetBollingerPoint { Pos = null, Bw = double.NaN };
            double maRef = maDistance != null ? maDistance[index] : double.NaN;
            double volMa = volumeMa != null ? volumeMa[index] : double.NaN;
            double rsiVal = rsi != null ? rsi[index] : double.NaN;

            // ADX slope — ADX[i] − ADX[i − lookback]. Both indices need
            // a finite ADX (post-warmup) for the slope to be meaningful;
            // null otherwise so the evaluator drops the entry.
            int lookback = Math.Max(1, adxSlopeLookback);
            int prevIdx = index - lookback;
            double adxSlope = double.NaN;
            if (prevIdx >= 0 && IsFiniteNumber(adx) && IsFiniteNumber(adx14[prevIdx]))
            {
                adxSlope = adx - adx14[prevIdx];
            }

            string PriceVs(double ema) =>
                IsFiniteNumber(ema)
                    ? (closeAtBar > ema ? "above" : "below")
                    : null;

            // Distance from the configurable maDistance MA, in ATR units.
            // Sign-preserved: positive = price above, negative = below.
            // Null when either the MA or ATR hasn't warmed up — that's the
            // null-as-fail convention the evaluator relies on.
            double? maDistAtr = null;
            if (IsFiniteNumber(maRef) && IsFiniteNumber(atr) && atr > 0)
            {
                maDistAtr = (closeAtBar - maRef) / atr;
            }

            // Volume ratio. Defensive against a zero or non-finite volume MA
            // (some datasets report 0 volume on quiet bars).
            double? volRatio = null;
            if (IsFiniteNumber(volMa) && volMa > 0 && IsFiniteNumber(barVolume))
            {
                volRatio = barVolume / volMa;
            }

            return new PresetFilterContext
            {
                Atr14         = IsFiniteNumber(atr)  ? (double?)atr  : null,
                Adx14         = IsFiniteNumber(adx)  ? (double?)adx  : null,
                PriceVsEma20  = PriceVs(e20),
                PriceVsEma200 = PriceVs(e200),
                BollingerPos  = bb.Pos,
                BollingerBw   = IsFiniteNumber(bb.Bw) ? (double?)bb.Bw : null,
                MaDistanceAtr = maDistAtr,
                VolumeRatio   = volRatio,
                Rsi           = IsFiniteNumber(rsiVal) ? (double?)rsiVal : null,
                AdxSlope      = IsFiniteNumber(adxSlope) ? (double?)adxSlope : null,
            };
        }

        // .NET Framework 4.8 (NT8's runtime) doesn't have double.IsFinite.
        // Roll our own — NaN ≠ NaN, so this rejects NaN/+Inf/-Inf cleanly.
        private static bool IsFiniteNumber(double v) =>
            !double.IsNaN(v) && !double.IsInfinity(v);
    }

    /// <summary>
    /// Bollinger band metadata at one bar. Pos is "above_upper" / "inside" /
    /// "below_lower" / null. Bw is band width in price units (upper − lower);
    /// not currently consumed by the filter but useful if a future strategy
    /// wants to gate on band width.
    /// </summary>
    public class PresetBollingerPoint
    {
        public string Pos { get; set; }
        public double Bw  { get; set; }
    }
}
