// DslIndicators.cs
//
// Per-strategy indicator library for transpiled DSL strategies.
//
// PARITY: every formula here MUST match src/lib/indicators/calculations.ts
// on the dashboard side. Where in doubt, the dashboard is authoritative —
// copy the math line-for-line. The parity harness compares per-bar values
// across both implementations and fails on any drift, so a regression here
// will surface.
//
// API shape:
//   - Caller is the generated strategy. It maintains a rolling
//     `List<DslBar> _bars` (oldest-first, current bar at the end).
//   - Each indicator method takes (IList<DslBar> bars, int barsAgo, ...args)
//     and returns the indicator value at bar `bars.Count - 1 - barsAgo`.
//     barsAgo=0 → current bar.
//   - Internally we compute the FULL series each call and read back
//     the requested index. With NT8's per-bar callback this is O(N²)
//     for a session, but for typical 1-1500 bar sessions this is
//     fine. If profiling shows it's a bottleneck, the next iteration
//     adds an internal cache keyed by (method, args, count) — the
//     transpiler-emitted call sites don't change.
//
// Static methods so the transpiler can emit DslIndicators.X(_bars, off, ...)
// without a per-strategy instance reference. Bar-buffer maintenance
// stays in DslStrategyBase.

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class DslIndicators
    {
        // ───────────────────── HELPERS ──────────────────────────────────────

        /// <summary>Read the indicator value at the requested bar offset
        /// (0 = current, 1 = one bar back, …) from a precomputed series.
        /// Returns NaN when out of range or the series itself emitted NaN
        /// (warmup window).</summary>
        private static double At(double[] series, int barsAgo)
        {
            if (series == null) return double.NaN;
            int idx = series.Length - 1 - barsAgo;
            if (idx < 0 || idx >= series.Length) return double.NaN;
            double v = series[idx];
            return Dsl.IsFinite(v) ? v : double.NaN;
        }

        private static double[] FilledNaN(int n)
        {
            var a = new double[n];
            for (int i = 0; i < n; i++) a[i] = double.NaN;
            return a;
        }

        private static int RoundI(double d)
        {
            return (int)Math.Round(d, MidpointRounding.AwayFromZero);
        }

        // ───────────────────── ROLLING EXTREMUM (excl. current) ─────────────
        // strategy-evaluator.ts:rollingExtremumSeries — high(N) / low(N).

        public static double RollingHigh(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            int idx = bars.Count - 1 - barsAgo;
            if (idx < period) return double.NaN;
            double m = double.NegativeInfinity;
            for (int j = idx - period; j < idx; j++)
            {
                if (bars[j].High > m) m = bars[j].High;
            }
            return Dsl.IsFinite(m) ? m : double.NaN;
        }

        public static double RollingLow(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            int idx = bars.Count - 1 - barsAgo;
            if (idx < period) return double.NaN;
            double m = double.PositiveInfinity;
            for (int j = idx - period; j < idx; j++)
            {
                if (bars[j].Low < m) m = bars[j].Low;
            }
            return Dsl.IsFinite(m) ? m : double.NaN;
        }

        public static double BarsSinceHigh(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            int idx = bars.Count - 1 - barsAgo;
            if (idx < period) return double.NaN;
            int argIdx = idx - period;
            double m = bars[argIdx].High;
            for (int j = idx - period + 1; j < idx; j++)
            {
                if (bars[j].High > m) { m = bars[j].High; argIdx = j; }
            }
            return idx - argIdx;
        }

        public static double BarsSinceLow(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            int idx = bars.Count - 1 - barsAgo;
            if (idx < period) return double.NaN;
            int argIdx = idx - period;
            double m = bars[argIdx].Low;
            for (int j = idx - period + 1; j < idx; j++)
            {
                if (bars[j].Low < m) { m = bars[j].Low; argIdx = j; }
            }
            return idx - argIdx;
        }

        // ───────────────────── ATR / TR / NATR / HV ─────────────────────────

        public static double[] AtrSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (n < period + 1 || period < 1) return outArr;
            var trs = new double[n - 1];
            for (int i = 1; i < n; i++)
            {
                double h = bars[i].High;
                double l = bars[i].Low;
                double pc = bars[i - 1].Close;
                trs[i - 1] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }
            double seed = 0;
            for (int i = 0; i < period; i++) seed += trs[i];
            double prev = seed / period;
            outArr[period] = prev;
            for (int i = period; i < trs.Length; i++)
            {
                prev = (prev * (period - 1) + trs[i]) / period;
                outArr[i + 1] = prev;
            }
            return outArr;
        }

        public static double Atr(IList<DslBar> bars, int barsAgo, double periodD)
            => At(AtrSeries(bars, RoundI(periodD)), barsAgo);

        public static double[] TrSeries(IList<DslBar> bars)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            for (int i = 1; i < n; i++)
            {
                double h = bars[i].High; double l = bars[i].Low; double pc = bars[i - 1].Close;
                outArr[i] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }
            return outArr;
        }

        public static double Tr(IList<DslBar> bars, int barsAgo)
            => At(TrSeries(bars), barsAgo);

        public static double[] NatrSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period + 1) return outArr;
            var atr = AtrSeries(bars, period);
            for (int i = 0; i < n; i++)
            {
                double c = bars[i].Close;
                if (Dsl.IsFinite(atr[i]) && c > 0) outArr[i] = (100 * atr[i]) / c;
            }
            return outArr;
        }

        public static double Natr(IList<DslBar> bars, int barsAgo, double periodD)
            => At(NatrSeries(bars, RoundI(periodD)), barsAgo);

        /// <summary>HV = un-annualized sample stdev of log returns. Same as
        /// stdevReturnsSeries on the dashboard. </summary>
        public static double[] HvSeries(IList<DslBar> bars, int period)
        {
            return StdevReturnsSeries(bars, period);
        }

        public static double Hv(IList<DslBar> bars, int barsAgo, double periodD)
            => At(HvSeries(bars, RoundI(periodD)), barsAgo);

        public static double[] StdevReturnsSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period + 1) return outArr;
            var rets = new double[n];
            for (int i = 1; i < n; i++)
            {
                double pc = bars[i - 1].Close;
                rets[i] = pc > 0 ? Math.Log(bars[i].Close / pc) : 0;
            }
            for (int i = period; i < n; i++)
            {
                double sum = 0;
                for (int k = 0; k < period; k++) sum += rets[i - k];
                double mean = sum / period;
                double v = 0;
                for (int k = 0; k < period; k++)
                {
                    double d = rets[i - k] - mean; v += d * d;
                }
                outArr[i] = Math.Sqrt(v / (period - 1));
            }
            return outArr;
        }

        public static double Stdev(IList<DslBar> bars, int barsAgo, double periodD)
            => At(StdevReturnsSeries(bars, RoundI(periodD)), barsAgo);

        // ───────────────────── SMA / EMA / WMA / HMA / DEMA / TEMA / VWMA ───

        public static double[] SmaSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
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

        public static double Sma(IList<DslBar> bars, int barsAgo, double periodD)
            => At(SmaSeries(bars, RoundI(periodD)), barsAgo);

        public static double[] EmaSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            double seed = 0;
            for (int i = 0; i < period; i++) seed += bars[i].Close;
            double prev = seed / period;
            outArr[period - 1] = prev;
            double k = 2.0 / (period + 1);
            for (int i = period; i < n; i++)
            {
                prev = (bars[i].Close - prev) * k + prev;
                outArr[i] = prev;
            }
            return outArr;
        }

        public static double Ema(IList<DslBar> bars, int barsAgo, double periodD)
            => At(EmaSeries(bars, RoundI(periodD)), barsAgo);

        public static double[] WmaSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            double denom = (period * (period + 1)) / 2.0;
            for (int i = period - 1; i < n; i++)
            {
                double weighted = 0;
                for (int k = 0; k < period; k++)
                {
                    double w = period - k;
                    weighted += bars[i - k].Close * w;
                }
                outArr[i] = weighted / denom;
            }
            return outArr;
        }

        public static double Wma(IList<DslBar> bars, int barsAgo, double periodD)
            => At(WmaSeries(bars, RoundI(periodD)), barsAgo);

        public static double[] HmaSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            int half = Math.Max(1, period / 2);
            int sqrtP = Math.Max(1, (int)Math.Round(Math.Sqrt(period)));
            var wmaHalf = WmaSeries(bars, half);
            var wmaFull = WmaSeries(bars, period);
            double denom = (sqrtP * (sqrtP + 1)) / 2.0;
            for (int i = sqrtP - 1; i < n; i++)
            {
                double weighted = 0;
                bool valid = true;
                for (int k = 0; k < sqrtP; k++)
                {
                    int idx = i - k;
                    double a = wmaHalf[idx];
                    double b = wmaFull[idx];
                    if (!Dsl.IsFinite(a) || !Dsl.IsFinite(b)) { valid = false; break; }
                    double synth = 2 * a - b;
                    weighted += synth * (sqrtP - k);
                }
                if (valid) outArr[i] = weighted / denom;
            }
            return outArr;
        }

        public static double Hma(IList<DslBar> bars, int barsAgo, double periodD)
            => At(HmaSeries(bars, RoundI(periodD)), barsAgo);

        /// <summary>EMA over an arbitrary input series. Mirrors emaOfSeries
        /// in calculations.ts: seed at the first index where `period`
        /// consecutive finite values end, then alpha=2/(p+1) decay. Holds
        /// last EMA on intermediate NaN inputs (matches pandas-ta TRIX
        /// chained-EMA convention).</summary>
        private static double[] EmaOfSeries(double[] values, int period)
        {
            int n = values.Length;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            int seedAt = -1;
            for (int i = period - 1; i < n; i++)
            {
                bool ok = true;
                for (int k = 0; k < period; k++)
                {
                    if (!Dsl.IsFinite(values[i - k])) { ok = false; break; }
                }
                if (ok) { seedAt = i; break; }
            }
            if (seedAt < 0) return outArr;
            double sum = 0;
            for (int k = 0; k < period; k++) sum += values[seedAt - k];
            double prev = sum / period;
            outArr[seedAt] = prev;
            double alpha = 2.0 / (period + 1);
            for (int i = seedAt + 1; i < n; i++)
            {
                double v = values[i];
                if (!Dsl.IsFinite(v)) { outArr[i] = prev; continue; }
                prev = v * alpha + prev * (1 - alpha);
                outArr[i] = prev;
            }
            return outArr;
        }

        private static double[] SmaOfSeries(double[] values, int period)
        {
            int n = values.Length;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            for (int i = period - 1; i < n; i++)
            {
                double sum = 0; bool ok = true;
                for (int k = 0; k < period; k++)
                {
                    if (!Dsl.IsFinite(values[i - k])) { ok = false; break; }
                    sum += values[i - k];
                }
                if (ok) outArr[i] = sum / period;
            }
            return outArr;
        }

        public static double Dema(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            var e1 = EmaSeries(bars, period);
            var e2 = EmaOfSeries(e1, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            double a = e1[idx], b = e2[idx];
            if (!Dsl.IsFinite(a) || !Dsl.IsFinite(b)) return double.NaN;
            return 2 * a - b;
        }

        public static double Tema(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            var e1 = EmaSeries(bars, period);
            var e2 = EmaOfSeries(e1, period);
            var e3 = EmaOfSeries(e2, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            double a = e1[idx], b = e2[idx], c = e3[idx];
            if (!Dsl.IsFinite(a) || !Dsl.IsFinite(b) || !Dsl.IsFinite(c)) return double.NaN;
            return 3 * a - 3 * b + c;
        }

        public static double[] VwmaSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            double pvSum = 0, vSum = 0;
            for (int i = 0; i < n; i++)
            {
                pvSum += bars[i].Close * bars[i].Volume;
                vSum += bars[i].Volume;
                if (i >= period)
                {
                    pvSum -= bars[i - period].Close * bars[i - period].Volume;
                    vSum -= bars[i - period].Volume;
                }
                if (i >= period - 1 && vSum > 0) outArr[i] = pvSum / vSum;
            }
            return outArr;
        }

        public static double Vwma(IList<DslBar> bars, int barsAgo, double periodD)
            => At(VwmaSeries(bars, RoundI(periodD)), barsAgo);

        // ───────────────────── ADX (Wilder double-smoothed) ─────────────────

        public static double[] AdxSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period < 1 || n < 2 * period + 1) return outArr;
            var pdm = new double[n]; var ndm = new double[n]; var tr = new double[n];
            for (int i = 1; i < n; i++)
            {
                double up = bars[i].High - bars[i - 1].High;
                double dn = bars[i - 1].Low - bars[i].Low;
                pdm[i] = (up > dn && up > 0) ? up : 0;
                ndm[i] = (dn > up && dn > 0) ? dn : 0;
                double h = bars[i].High; double l = bars[i].Low; double pc = bars[i - 1].Close;
                tr[i] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }
            double sumPdm = 0, sumNdm = 0, sumTr = 0;
            for (int i = 1; i <= period; i++)
            {
                sumPdm += pdm[i]; sumNdm += ndm[i]; sumTr += tr[i];
            }
            var dx = new double[n]; for (int i = 0; i < n; i++) dx[i] = double.NaN;
            if (sumTr > 0)
            {
                double dip = 100 * (sumPdm / sumTr);
                double dim = 100 * (sumNdm / sumTr);
                dx[period] = (dip + dim) == 0 ? 0 : 100 * Math.Abs(dip - dim) / (dip + dim);
            }
            for (int i = period + 1; i < n; i++)
            {
                sumPdm = sumPdm - sumPdm / period + pdm[i];
                sumNdm = sumNdm - sumNdm / period + ndm[i];
                sumTr = sumTr - sumTr / period + tr[i];
                if (sumTr > 0)
                {
                    double dip = 100 * (sumPdm / sumTr);
                    double dim = 100 * (sumNdm / sumTr);
                    dx[i] = (dip + dim) == 0 ? 0 : 100 * Math.Abs(dip - dim) / (dip + dim);
                }
            }
            double adxSeed = 0;
            for (int i = period; i < 2 * period; i++) adxSeed += dx[i];
            adxSeed /= period;
            outArr[2 * period - 1] = adxSeed;
            double prevAdx = adxSeed;
            for (int i = 2 * period; i < n; i++)
            {
                prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
                outArr[i] = prevAdx;
            }
            return outArr;
        }

        public static double Adx(IList<DslBar> bars, int barsAgo, double periodD)
            => At(AdxSeries(bars, RoundI(periodD)), barsAgo);

        // DI+ / DI- (mirror calculations.ts:dxLegs)
        private static (double[] plusDI, double[] minusDI)? DxLegs(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            if (period <= 0 || n < period + 1) return null;
            int len = n - 1;
            var plusDM = new double[len]; var minusDM = new double[len]; var trs = new double[len];
            for (int i = 1; i < n; i++)
            {
                double upMove = bars[i].High - bars[i - 1].High;
                double downMove = bars[i - 1].Low - bars[i].Low;
                plusDM[i - 1] = (upMove > downMove && upMove > 0) ? upMove : 0;
                minusDM[i - 1] = (downMove > upMove && downMove > 0) ? downMove : 0;
                double h = bars[i].High; double l = bars[i].Low; double pc = bars[i - 1].Close;
                trs[i - 1] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }
            double[] Wilder(double[] s)
            {
                if (s.Length < period) return new double[0];
                int outLen = s.Length - period + 1;
                var res = new double[outLen];
                double sum = 0;
                for (int i = 0; i < period; i++) sum += s[i];
                res[0] = sum;
                for (int i = period; i < s.Length; i++)
                {
                    sum = sum - sum / period + s[i];
                    res[i - period + 1] = sum;
                }
                return res;
            }
            var ps = Wilder(plusDM); var ms = Wilder(minusDM); var ts = Wilder(trs);
            var plusDI = FilledNaN(n); var minusDI = FilledNaN(n);
            for (int i = 0; i < ts.Length; i++)
            {
                double tr = ts[i];
                if (tr <= 0) continue;
                plusDI[i + period] = (100 * ps[i]) / tr;
                minusDI[i + period] = (100 * ms[i]) / tr;
            }
            return (plusDI, minusDI);
        }

        public static double DiPlus(IList<DslBar> bars, int barsAgo, double periodD)
        {
            var r = DxLegs(bars, RoundI(periodD));
            return r.HasValue ? At(r.Value.plusDI, barsAgo) : double.NaN;
        }

        public static double DiMinus(IList<DslBar> bars, int barsAgo, double periodD)
        {
            var r = DxLegs(bars, RoundI(periodD));
            return r.HasValue ? At(r.Value.minusDI, barsAgo) : double.NaN;
        }

        // ───────────────────── RSI ──────────────────────────────────────────

        public static double[] RsiSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period < 1 || n < period + 1) return outArr;
            double seedGain = 0, seedLoss = 0;
            for (int i = 1; i <= period; i++)
            {
                double diff = bars[i].Close - bars[i - 1].Close;
                if (diff >= 0) seedGain += diff; else seedLoss -= diff;
            }
            double avgGain = seedGain / period;
            double avgLoss = seedLoss / period;
            outArr[period] = avgLoss == 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
            for (int i = period + 1; i < n; i++)
            {
                double diff = bars[i].Close - bars[i - 1].Close;
                double g = diff > 0 ? diff : 0;
                double l = diff < 0 ? -diff : 0;
                avgGain = (avgGain * (period - 1) + g) / period;
                avgLoss = (avgLoss * (period - 1) + l) / period;
                outArr[i] = avgLoss == 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
            }
            return outArr;
        }

        public static double Rsi(IList<DslBar> bars, int barsAgo, double periodD)
            => At(RsiSeries(bars, RoundI(periodD)), barsAgo);

        // ───────────────────── ROC / MOM / CCI / WilliamsR ──────────────────

        public static double Roc(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period) return double.NaN;
            double prev = bars[idx - period].Close;
            return prev == 0 ? double.NaN : 100 * (bars[idx].Close - prev) / prev;
        }

        public static double Mom(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period) return double.NaN;
            return bars[idx].Close - bars[idx - period].Close;
        }

        public static double Cci(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            int idx = n - 1 - barsAgo;
            if (period <= 0 || idx < period - 1) return double.NaN;
            // Build TP, then mean + MAD over window.
            double mean = 0;
            for (int k = 0; k < period; k++)
            {
                var b = bars[idx - k];
                mean += (b.High + b.Low + b.Close) / 3.0;
            }
            mean /= period;
            double mad = 0;
            for (int k = 0; k < period; k++)
            {
                var b = bars[idx - k];
                double tp = (b.High + b.Low + b.Close) / 3.0;
                mad += Math.Abs(tp - mean);
            }
            mad /= period;
            if (mad == 0) return 0;
            double tpNow = (bars[idx].High + bars[idx].Low + bars[idx].Close) / 3.0;
            return (tpNow - mean) / (0.015 * mad);
        }

        public static double WilliamsR(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period - 1) return double.NaN;
            double hi = double.NegativeInfinity, lo = double.PositiveInfinity;
            for (int j = idx - period + 1; j <= idx; j++)
            {
                if (bars[j].High > hi) hi = bars[j].High;
                if (bars[j].Low < lo) lo = bars[j].Low;
            }
            if (hi == lo) return -50;
            return -100 * (hi - bars[idx].Close) / (hi - lo);
        }

        // ───────────────────── TRIX (triple-EMA of log close) ───────────────

        public static double Trix(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period) return double.NaN;
            var logClose = new double[n];
            for (int i = 0; i < n; i++)
            {
                double c = bars[i].Close;
                logClose[i] = c > 0 ? Math.Log(c) : double.NaN;
            }
            var e1 = EmaOfSeries(logClose, period);
            var e2 = EmaOfSeries(e1, period);
            var e3 = EmaOfSeries(e2, period);
            var trix = FilledNaN(n);
            for (int i = 1; i < n; i++)
            {
                double cur = e3[i]; double prev = e3[i - 1];
                if (Dsl.IsFinite(cur) && Dsl.IsFinite(prev) && prev != 0)
                {
                    trix[i] = 100 * (cur - prev) / Math.Abs(prev);
                }
            }
            return At(trix, barsAgo);
        }

        // ───────────────────── MFI (Money Flow Index) ───────────────────────

        public static double Mfi(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period + 1) return double.NaN;
            var tp = new double[n];
            for (int i = 0; i < n; i++) tp[i] = (bars[i].High + bars[i].Low + bars[i].Close) / 3.0;
            var posMF = new double[n]; var negMF = new double[n];
            for (int i = 1; i < n; i++)
            {
                double flow = tp[i] * bars[i].Volume;
                if (tp[i] > tp[i - 1]) posMF[i] = flow;
                else if (tp[i] < tp[i - 1]) negMF[i] = flow;
            }
            var outArr = FilledNaN(n);
            double pos = 0, neg = 0;
            for (int i = 1; i <= period; i++) { pos += posMF[i]; neg += negMF[i]; }
            outArr[period] = neg == 0 ? 100 : 100 - 100 / (1 + pos / neg);
            for (int i = period + 1; i < n; i++)
            {
                pos += posMF[i] - posMF[i - period];
                neg += negMF[i] - negMF[i - period];
                outArr[i] = neg == 0 ? 100 : 100 - 100 / (1 + pos / neg);
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── BOLLINGER (population stdev) ─────────────────

        private static double[] RollingClosePopStdev(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            for (int i = period - 1; i < n; i++)
            {
                double mean = 0;
                for (int k = 0; k < period; k++) mean += bars[i - k].Close;
                mean /= period;
                double variance = 0;
                for (int k = 0; k < period; k++)
                {
                    double d = bars[i - k].Close - mean;
                    variance += d * d;
                }
                outArr[i] = Math.Sqrt(variance / period);
            }
            return outArr;
        }

        public static double BbMid(IList<DslBar> bars, int barsAgo, double periodD)
            => Sma(bars, barsAgo, periodD);

        public static double BbUpper(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            int period = RoundI(periodD);
            var mid = SmaSeries(bars, period);
            var sd = RollingClosePopStdev(bars, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            if (!Dsl.IsFinite(mid[idx]) || !Dsl.IsFinite(sd[idx])) return double.NaN;
            return mid[idx] + mult * sd[idx];
        }

        public static double BbLower(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            int period = RoundI(periodD);
            var mid = SmaSeries(bars, period);
            var sd = RollingClosePopStdev(bars, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            if (!Dsl.IsFinite(mid[idx]) || !Dsl.IsFinite(sd[idx])) return double.NaN;
            return mid[idx] - mult * sd[idx];
        }

        public static double BbWidth(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            int period = RoundI(periodD);
            var mid = SmaSeries(bars, period);
            var sd = RollingClosePopStdev(bars, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            if (!Dsl.IsFinite(mid[idx]) || !Dsl.IsFinite(sd[idx]) || mid[idx] == 0) return double.NaN;
            return (2 * mult * sd[idx]) / mid[idx];
        }

        public static double BbPercent(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            int period = RoundI(periodD);
            var mid = SmaSeries(bars, period);
            var sd = RollingClosePopStdev(bars, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            if (!Dsl.IsFinite(mid[idx]) || !Dsl.IsFinite(sd[idx])) return double.NaN;
            double span = 2 * mult * sd[idx];
            if (span <= 0) return double.NaN;
            double lower = mid[idx] - mult * sd[idx];
            return (bars[idx].Close - lower) / span;
        }

        // ───────────────────── DONCHIAN / KELTNER ───────────────────────────

        public static double DonchianUpper(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period - 1) return double.NaN;
            double m = double.NegativeInfinity;
            for (int j = idx - period + 1; j <= idx; j++) if (bars[j].High > m) m = bars[j].High;
            return Dsl.IsFinite(m) ? m : double.NaN;
        }

        public static double DonchianLower(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period - 1) return double.NaN;
            double m = double.PositiveInfinity;
            for (int j = idx - period + 1; j <= idx; j++) if (bars[j].Low < m) m = bars[j].Low;
            return Dsl.IsFinite(m) ? m : double.NaN;
        }

        public static double DonchianMid(IList<DslBar> bars, int barsAgo, double periodD)
            => (DonchianUpper(bars, barsAgo, periodD) + DonchianLower(bars, barsAgo, periodD)) / 2;

        public static double KeltnerMid(IList<DslBar> bars, int barsAgo, double periodD)
            => Ema(bars, barsAgo, periodD);

        public static double KeltnerUpper(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            double mid = Ema(bars, barsAgo, periodD);
            double atr = Atr(bars, barsAgo, periodD);
            if (!Dsl.IsFinite(mid) || !Dsl.IsFinite(atr)) return double.NaN;
            return mid + mult * atr;
        }

        public static double KeltnerLower(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            double mid = Ema(bars, barsAgo, periodD);
            double atr = Atr(bars, barsAgo, periodD);
            if (!Dsl.IsFinite(mid) || !Dsl.IsFinite(atr)) return double.NaN;
            return mid - mult * atr;
        }

        // ───────────────────── STOCHASTIC ───────────────────────────────────

        public static double[] StochKSeries(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            for (int i = period - 1; i < n; i++)
            {
                double hh = double.NegativeInfinity, ll = double.PositiveInfinity;
                for (int k = 0; k < period; k++)
                {
                    if (bars[i - k].High > hh) hh = bars[i - k].High;
                    if (bars[i - k].Low < ll) ll = bars[i - k].Low;
                }
                double span = hh - ll;
                outArr[i] = span == 0 ? 50 : (100 * (bars[i].Close - ll)) / span;
            }
            return outArr;
        }

        public static double StochK(IList<DslBar> bars, int barsAgo, double periodD)
            => At(StochKSeries(bars, RoundI(periodD)), barsAgo);

        public static double StochD(IList<DslBar> bars, int barsAgo, double periodD, double smoothKD, double smoothDD)
        {
            int period = RoundI(periodD); int sK = RoundI(smoothKD); int sD = RoundI(smoothDD);
            var k = StochKSeries(bars, period);
            var slowK = SmaOfSeries(k, sK);
            return At(SmaOfSeries(slowK, sD), barsAgo);
        }

        // ───────────────────── MACD ─────────────────────────────────────────

        public static double[] MacdLineSeries(IList<DslBar> bars, int fast, int slow)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (fast <= 0 || slow <= 0 || n < Math.Max(fast, slow)) return outArr;
            var eFast = EmaSeries(bars, fast);
            var eSlow = EmaSeries(bars, slow);
            for (int i = 0; i < n; i++)
            {
                if (Dsl.IsFinite(eFast[i]) && Dsl.IsFinite(eSlow[i])) outArr[i] = eFast[i] - eSlow[i];
            }
            return outArr;
        }

        public static double MacdLine(IList<DslBar> bars, int barsAgo, double fastD, double slowD)
            => At(MacdLineSeries(bars, RoundI(fastD), RoundI(slowD)), barsAgo);

        public static double MacdSignal(IList<DslBar> bars, int barsAgo, double fastD, double slowD, double signalD)
        {
            var line = MacdLineSeries(bars, RoundI(fastD), RoundI(slowD));
            return At(EmaOfSeries(line, RoundI(signalD)), barsAgo);
        }

        public static double MacdHist(IList<DslBar> bars, int barsAgo, double fastD, double slowD, double signalD)
        {
            int fast = RoundI(fastD); int slow = RoundI(slowD); int signal = RoundI(signalD);
            var line = MacdLineSeries(bars, fast, slow);
            var sig = EmaOfSeries(line, signal);
            int n = bars.Count;
            var outArr = FilledNaN(n);
            for (int i = 0; i < n; i++)
            {
                if (Dsl.IsFinite(line[i]) && Dsl.IsFinite(sig[i])) outArr[i] = line[i] - sig[i];
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── HHV / LLV / *_n ──────────────────────────────

        public static double Hhv(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period - 1) return double.NaN;
            double m = double.NegativeInfinity;
            for (int j = idx - period + 1; j <= idx; j++) if (bars[j].High > m) m = bars[j].High;
            return Dsl.IsFinite(m) ? m : double.NaN;
        }

        public static double Llv(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo;
            if (period <= 0 || idx < period - 1) return double.NaN;
            double m = double.PositiveInfinity;
            for (int j = idx - period + 1; j <= idx; j++) if (bars[j].Low < m) m = bars[j].Low;
            return Dsl.IsFinite(m) ? m : double.NaN;
        }

        public static double CloseN(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo - period;
            if (idx < 0) return double.NaN;
            return bars[idx].Close;
        }

        public static double HighN(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo - period;
            if (idx < 0) return double.NaN;
            return bars[idx].High;
        }

        public static double LowN(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo - period;
            if (idx < 0) return double.NaN;
            return bars[idx].Low;
        }

        public static double OpenN(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo - period;
            if (idx < 0) return double.NaN;
            return bars[idx].Open;
        }

        public static double VolumeN(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int idx = bars.Count - 1 - barsAgo - period;
            if (idx < 0) return double.NaN;
            return bars[idx].Volume;
        }

        public static double VolumeMa(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period) return double.NaN;
            int idx = n - 1 - barsAgo;
            if (idx < period - 1) return double.NaN;
            double sum = 0;
            for (int j = idx - period + 1; j <= idx; j++) sum += bars[j].Volume;
            return sum / period;
        }

        // ───────────────────── VOLUME / CUMULATIVE ──────────────────────────

        public static double Obv(IList<DslBar> bars, int barsAgo)
        {
            int n = bars.Count;
            var outArr = new double[n];
            for (int i = 1; i < n; i++)
            {
                if (bars[i].Close > bars[i - 1].Close) outArr[i] = outArr[i - 1] + bars[i].Volume;
                else if (bars[i].Close < bars[i - 1].Close) outArr[i] = outArr[i - 1] - bars[i].Volume;
                else outArr[i] = outArr[i - 1];
            }
            return At(outArr, barsAgo);
        }

        public static double Ad(IList<DslBar> bars, int barsAgo)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            double cum = 0;
            for (int i = 0; i < n; i++)
            {
                double h = bars[i].High; double l = bars[i].Low; double c = bars[i].Close;
                double span = h - l;
                double mfm = span == 0 ? 0 : ((c - l) - (h - c)) / span;
                cum += mfm * bars[i].Volume;
                outArr[i] = cum;
            }
            return At(outArr, barsAgo);
        }

        public static double Cmf(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period) return double.NaN;
            var mfv = new double[n];
            for (int i = 0; i < n; i++)
            {
                double h = bars[i].High; double l = bars[i].Low; double c = bars[i].Close;
                double span = h - l;
                double mfm = span == 0 ? 0 : ((c - l) - (h - c)) / span;
                mfv[i] = mfm * bars[i].Volume;
            }
            var outArr = FilledNaN(n);
            double mfvSum = 0, vSum = 0;
            for (int i = 0; i < n; i++)
            {
                mfvSum += mfv[i]; vSum += bars[i].Volume;
                if (i >= period) { mfvSum -= mfv[i - period]; vSum -= bars[i - period].Volume; }
                if (i >= period - 1 && vSum > 0) outArr[i] = mfvSum / vSum;
            }
            return At(outArr, barsAgo);
        }

        public static double Cvd(IList<DslBar> bars, int barsAgo)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            double running = 0;
            bool started = false;
            for (int i = 0; i < n; i++)
            {
                double bid = bars[i].VolumeBid;
                double ask = bars[i].VolumeAsk;
                if (Dsl.IsFinite(bid) && Dsl.IsFinite(ask))
                {
                    running += ask - bid;
                    started = true;
                }
                if (started) outArr[i] = running;
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── AWESOME OSCILLATOR ──────────────────────────

        public static double Ao(IList<DslBar> bars, int barsAgo)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (n < 34) return At(outArr, barsAgo);
            var med = new double[n];
            for (int i = 0; i < n; i++) med[i] = (bars[i].High + bars[i].Low) / 2.0;
            double sum5 = 0, sum34 = 0;
            for (int i = 0; i < n; i++)
            {
                sum5 += med[i]; sum34 += med[i];
                if (i >= 5) sum5 -= med[i - 5];
                if (i >= 34) sum34 -= med[i - 34];
                if (i >= 33) outArr[i] = sum5 / 5 - sum34 / 34;
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── ULTIMATE OSCILLATOR ─────────────────────────

        public static double Uo(IList<DslBar> bars, int barsAgo, double s1D, double s2D, double s3D)
        {
            int sShort = RoundI(s1D); int sMid = RoundI(s2D); int sLong = RoundI(s3D);
            int n = bars.Count;
            if (sShort <= 0 || sMid <= 0 || sLong <= 0 || n < sLong + 1) return double.NaN;
            var bp = new double[n]; var tr = new double[n];
            for (int i = 1; i < n; i++)
            {
                double pc = bars[i - 1].Close;
                double trueLow = Math.Min(bars[i].Low, pc);
                double trueHigh = Math.Max(bars[i].High, pc);
                bp[i] = bars[i].Close - trueLow;
                tr[i] = trueHigh - trueLow;
            }
            int idx = n - 1 - barsAgo;
            if (idx < sLong) return double.NaN;
            double bpS = 0, trS = 0, bpM = 0, trM = 0, bpL = 0, trL = 0;
            for (int k = 0; k < sLong; k++)
            {
                int j = idx - k;
                if (k < sShort) { bpS += bp[j]; trS += tr[j]; }
                if (k < sMid)   { bpM += bp[j]; trM += tr[j]; }
                bpL += bp[j]; trL += tr[j];
            }
            if (trS <= 0 || trM <= 0 || trL <= 0) return double.NaN;
            double avgS = bpS / trS;
            double avgM = bpM / trM;
            double avgL = bpL / trL;
            return (100 * (4 * avgS + 2 * avgM + avgL)) / 7;
        }

        // ───────────────────── FISHER TRANSFORM ─────────────────────────────

        public static double Fisher(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return At(outArr, barsAgo);
            double prevValue = 0, prevFisher = 0;
            for (int i = period - 1; i < n; i++)
            {
                double hh = double.NegativeInfinity, ll = double.PositiveInfinity;
                for (int k = 0; k < period; k++)
                {
                    double v = (bars[i - k].High + bars[i - k].Low) / 2.0;
                    if (v > hh) hh = v;
                    if (v < ll) ll = v;
                }
                double median = (bars[i].High + bars[i].Low) / 2.0;
                double span = hh - ll;
                double raw = span > 0 ? 2 * ((median - ll) / span - 0.5) : 0;
                double value = 0.33 * raw + 0.67 * prevValue;
                double clamped = Math.Max(-0.999, Math.Min(0.999, value));
                double fisher = 0.5 * Math.Log((1 + clamped) / (1 - clamped)) + 0.5 * prevFisher;
                outArr[i] = fisher;
                prevValue = clamped;
                prevFisher = fisher;
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── CHOPPINESS / ULCER ───────────────────────────

        public static double Choppiness(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period + 1) return double.NaN;
            var tr = TrSeries(bars);
            int idx = n - 1 - barsAgo;
            if (idx < period) return double.NaN;
            double sumTr = 0; double hh = double.NegativeInfinity, ll = double.PositiveInfinity;
            for (int k = 0; k < period; k++)
            {
                double t = tr[idx - k];
                if (!Dsl.IsFinite(t)) return double.NaN;
                sumTr += t;
                if (bars[idx - k].High > hh) hh = bars[idx - k].High;
                if (bars[idx - k].Low < ll) ll = bars[idx - k].Low;
            }
            double span = hh - ll;
            if (span <= 0 || sumTr <= 0) return double.NaN;
            return (100 * Math.Log10(sumTr / span)) / Math.Log10(period);
        }

        public static double Ulcer(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period) return double.NaN;
            int idx = n - 1 - barsAgo;
            if (idx < period - 1) return double.NaN;
            double sumSq = 0;
            for (int k = 0; k < period; k++)
            {
                double maxToDate = double.NegativeInfinity;
                for (int m = k; m < period; m++)
                {
                    if (bars[idx - m].Close > maxToDate) maxToDate = bars[idx - m].Close;
                }
                double dd = maxToDate > 0 ? (100 * (bars[idx - k].Close - maxToDate)) / maxToDate : 0;
                sumSq += dd * dd;
            }
            return Math.Sqrt(sumSq / period);
        }

        // ───────────────────── Z-SCORE / LR / R² ────────────────────────────

        public static double Zscore(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period) return double.NaN;
            int idx = n - 1 - barsAgo;
            if (idx < period - 1) return double.NaN;
            double sum = 0;
            for (int k = 0; k < period; k++) sum += bars[idx - k].Close;
            double mean = sum / period;
            double varSum = 0;
            for (int k = 0; k < period; k++)
            {
                double d = bars[idx - k].Close - mean; varSum += d * d;
            }
            double sd = Math.Sqrt(varSum / period);
            if (sd <= 0) return double.NaN;
            return (bars[idx].Close - mean) / sd;
        }

        private struct LinRegFit { public double[] Slope; public double[] Intercept; public double[] Rsq; }

        private static LinRegFit ComputeLinReg(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var fit = new LinRegFit
            {
                Slope = FilledNaN(n),
                Intercept = FilledNaN(n),
                Rsq = FilledNaN(n)
            };
            if (period <= 0 || n < period) return fit;
            double sumX = 0, sumXX = 0;
            for (int k = 0; k < period; k++) { sumX += k; sumXX += k * k; }
            double denomX = period * sumXX - sumX * sumX;
            for (int i = period - 1; i < n; i++)
            {
                double sumY = 0, sumXY = 0;
                for (int k = 0; k < period; k++)
                {
                    double y = bars[i - (period - 1 - k)].Close;
                    sumY += y;
                    sumXY += k * y;
                }
                if (denomX == 0) continue;
                double m = (period * sumXY - sumX * sumY) / denomX;
                double b = (sumY - m * sumX) / period;
                fit.Slope[i] = m;
                fit.Intercept[i] = b;
                double meanY = sumY / period;
                double sse = 0, sst = 0;
                for (int k = 0; k < period; k++)
                {
                    double y = bars[i - (period - 1 - k)].Close;
                    double yhat = m * k + b;
                    sse += (y - yhat) * (y - yhat);
                    sst += (y - meanY) * (y - meanY);
                }
                fit.Rsq[i] = sst > 0 ? 1 - sse / sst : double.NaN;
            }
            return fit;
        }

        public static double LrSlope(IList<DslBar> bars, int barsAgo, double periodD)
            => At(ComputeLinReg(bars, RoundI(periodD)).Slope, barsAgo);

        public static double LrIntercept(IList<DslBar> bars, int barsAgo, double periodD)
            => At(ComputeLinReg(bars, RoundI(periodD)).Intercept, barsAgo);

        public static double LrValue(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            var fit = ComputeLinReg(bars, period);
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            double m = fit.Slope[idx], b = fit.Intercept[idx];
            if (!Dsl.IsFinite(m) || !Dsl.IsFinite(b)) return double.NaN;
            return m * (period - 1) + b;
        }

        public static double R2(IList<DslBar> bars, int barsAgo, double periodD)
            => At(ComputeLinReg(bars, RoundI(periodD)).Rsq, barsAgo);

        // ───────────────────── ROLLING VWAP ─────────────────────────────────

        public static double Vwap(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period) return double.NaN;
            int idx = n - 1 - barsAgo;
            if (idx < period - 1) return double.NaN;
            double sumPV = 0, sumV = 0;
            for (int j = idx - period + 1; j <= idx; j++)
            {
                double tp = (bars[j].High + bars[j].Low + bars[j].Close) / 3.0;
                sumPV += tp * bars[j].Volume;
                sumV  += bars[j].Volume;
            }
            return sumV > 0 ? sumPV / sumV : double.NaN;
        }

        // ───────────────────── KVO / FORCE INDEX / EMV ──────────────────────

        public static double Kvo(IList<DslBar> bars, int barsAgo, double fastD, double slowD)
        {
            int fast = RoundI(fastD); int slow = RoundI(slowD);
            int n = bars.Count;
            if (fast <= 0 || slow <= 0 || n < slow + 1) return double.NaN;
            var vf = FilledNaN(n);
            for (int i = 1; i < n; i++)
            {
                double tp = bars[i].High + bars[i].Low + bars[i].Close;
                double tpPrev = bars[i - 1].High + bars[i - 1].Low + bars[i - 1].Close;
                int sign = tp > tpPrev ? 1 : tp < tpPrev ? -1 : 0;
                vf[i] = sign * bars[i].Volume;
            }
            // Custom EMA-of-vf with seed at first p finite values from index 1.
            double[] EmaOfVf(double[] xs, int p)
            {
                var o = FilledNaN(xs.Length);
                if (p <= 0 || xs.Length < p + 1) return o;
                double seedSum = 0; int seedCount = 0; int seedAt = -1;
                for (int i = 1; i < xs.Length; i++)
                {
                    if (Dsl.IsFinite(xs[i]))
                    {
                        seedSum += xs[i]; seedCount++;
                        if (seedCount == p) { seedAt = i; break; }
                    }
                }
                if (seedAt < 0) return o;
                double prev = seedSum / p;
                o[seedAt] = prev;
                double alpha = 2.0 / (p + 1);
                for (int i = seedAt + 1; i < xs.Length; i++)
                {
                    if (!Dsl.IsFinite(xs[i])) { o[i] = prev; continue; }
                    prev = xs[i] * alpha + prev * (1 - alpha);
                    o[i] = prev;
                }
                return o;
            }
            var eFast = EmaOfVf(vf, fast);
            var eSlow = EmaOfVf(vf, slow);
            int idx = n - 1 - barsAgo;
            if (idx < 0 || idx >= n) return double.NaN;
            double a = eFast[idx], b = eSlow[idx];
            if (!Dsl.IsFinite(a) || !Dsl.IsFinite(b)) return double.NaN;
            return a - b;
        }

        public static double ForceIndex(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period + 1) return double.NaN;
            var raw = FilledNaN(n);
            for (int i = 1; i < n; i++) raw[i] = (bars[i].Close - bars[i - 1].Close) * bars[i].Volume;
            var outArr = FilledNaN(n);
            double seed = 0;
            for (int k = 1; k <= period; k++) seed += raw[k];
            double prev = seed / period;
            outArr[period] = prev;
            double alpha = 2.0 / (period + 1);
            for (int i = period + 1; i < n; i++)
            {
                prev = raw[i] * alpha + prev * (1 - alpha);
                outArr[i] = prev;
            }
            return At(outArr, barsAgo);
        }

        public static double Emv(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            if (period <= 0 || n < period + 1) return double.NaN;
            var raw = FilledNaN(n);
            for (int i = 1; i < n; i++)
            {
                double med = (bars[i].High + bars[i].Low) / 2.0;
                double medPrev = (bars[i - 1].High + bars[i - 1].Low) / 2.0;
                double span = bars[i].High - bars[i].Low;
                double vol = bars[i].Volume;
                if (span > 0 && vol > 0) raw[i] = (med - medPrev) / (vol / span);
            }
            var outArr = FilledNaN(n);
            for (int i = period; i < n; i++)
            {
                double sum = 0; bool valid = true;
                for (int k = 0; k < period; k++)
                {
                    double r = raw[i - k];
                    if (!Dsl.IsFinite(r)) { valid = false; break; }
                    sum += r;
                }
                if (valid) outArr[i] = sum / period;
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── NVI / PVI ────────────────────────────────────

        public static double Nvi(IList<DslBar> bars, int barsAgo)
        {
            int n = bars.Count;
            if (n == 0) return double.NaN;
            var outArr = new double[n];
            double nvi = 1000;
            outArr[0] = nvi;
            for (int i = 1; i < n; i++)
            {
                if (bars[i].Volume < bars[i - 1].Volume && bars[i - 1].Close > 0)
                {
                    nvi *= 1 + (bars[i].Close - bars[i - 1].Close) / bars[i - 1].Close;
                }
                outArr[i] = nvi;
            }
            return At(outArr, barsAgo);
        }

        public static double Pvi(IList<DslBar> bars, int barsAgo)
        {
            int n = bars.Count;
            if (n == 0) return double.NaN;
            var outArr = new double[n];
            double pvi = 1000;
            outArr[0] = pvi;
            for (int i = 1; i < n; i++)
            {
                if (bars[i].Volume > bars[i - 1].Volume && bars[i - 1].Close > 0)
                {
                    pvi *= 1 + (bars[i].Close - bars[i - 1].Close) / bars[i - 1].Close;
                }
                outArr[i] = pvi;
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── SUPERTREND ──────────────────────────────────

        public static double Supertrend(IList<DslBar> bars, int barsAgo, double periodD, double mult)
        {
            int period = RoundI(periodD);
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || !Dsl.IsFinite(mult) || mult <= 0 || n < period + 1)
                return At(outArr, barsAgo);
            var atr = AtrSeries(bars, period);
            var up = FilledNaN(n); var dn = FilledNaN(n);
            for (int i = 0; i < n; i++)
            {
                if (!Dsl.IsFinite(atr[i])) continue;
                double hl2 = (bars[i].High + bars[i].Low) / 2.0;
                up[i] = hl2 + mult * atr[i];
                dn[i] = hl2 - mult * atr[i];
            }
            var trailUp = FilledNaN(n); var trailDn = FilledNaN(n);
            int dir = 1;
            bool started = false;
            for (int i = 0; i < n; i++)
            {
                if (!Dsl.IsFinite(up[i]) || !Dsl.IsFinite(dn[i])) continue;
                if (!started)
                {
                    trailUp[i] = up[i]; trailDn[i] = dn[i];
                    started = true;
                    outArr[i] = dn[i];
                    continue;
                }
                double prevClose = bars[i - 1].Close;
                trailUp[i] = prevClose <= (Dsl.IsFinite(trailUp[i - 1]) ? trailUp[i - 1] : double.PositiveInfinity)
                    ? Math.Min(up[i], trailUp[i - 1])
                    : up[i];
                trailDn[i] = prevClose >= (Dsl.IsFinite(trailDn[i - 1]) ? trailDn[i - 1] : double.NegativeInfinity)
                    ? Math.Max(dn[i], trailDn[i - 1])
                    : dn[i];
                if (dir == -1 && bars[i].Close > trailUp[i]) dir = 1;
                else if (dir == 1 && bars[i].Close < trailDn[i]) dir = -1;
                outArr[i] = dir == 1 ? trailDn[i] : -trailUp[i];
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── PSAR ────────────────────────────────────────

        public static double Psar(IList<DslBar> bars, int barsAgo, double step, double max)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (n < 2 || !Dsl.IsFinite(step) || step <= 0
                || !Dsl.IsFinite(max) || max <= 0 || step > max)
                return At(outArr, barsAgo);
            int trend = bars[1].Close > bars[0].Close ? 1 : -1;
            double ep = trend == 1 ? bars[1].High : bars[1].Low;
            double af = step;
            double sar = trend == 1 ? bars[0].Low : bars[0].High;
            outArr[1] = sar;
            for (int i = 2; i < n; i++)
            {
                sar = sar + af * (ep - sar);
                if (trend == 1)
                {
                    sar = Math.Min(sar, Math.Min(bars[i - 1].Low, bars[i - 2].Low));
                    if (bars[i].Low < sar)
                    {
                        trend = -1; sar = ep; ep = bars[i].Low; af = step;
                    }
                    else
                    {
                        if (bars[i].High > ep) { ep = bars[i].High; af = Math.Min(af + step, max); }
                    }
                }
                else
                {
                    sar = Math.Max(sar, Math.Max(bars[i - 1].High, bars[i - 2].High));
                    if (bars[i].High > sar)
                    {
                        trend = 1; sar = ep; ep = bars[i].High; af = step;
                    }
                    else
                    {
                        if (bars[i].Low < ep) { ep = bars[i].Low; af = Math.Min(af + step, max); }
                    }
                }
                outArr[i] = sar;
            }
            return At(outArr, barsAgo);
        }

        // ───────────────────── ICHIMOKU ────────────────────────────────────

        private static double[] MidOfHHVLLV(IList<DslBar> bars, int period)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period) return outArr;
            for (int i = period - 1; i < n; i++)
            {
                double hh = double.NegativeInfinity, ll = double.PositiveInfinity;
                for (int k = 0; k < period; k++)
                {
                    if (bars[i - k].High > hh) hh = bars[i - k].High;
                    if (bars[i - k].Low < ll) ll = bars[i - k].Low;
                }
                outArr[i] = (hh + ll) / 2.0;
            }
            return outArr;
        }

        public static double IchimokuTenkan(IList<DslBar> bars, int barsAgo, double periodD)
            => At(MidOfHHVLLV(bars, RoundI(periodD)), barsAgo);

        public static double IchimokuKijun(IList<DslBar> bars, int barsAgo, double periodD)
            => At(MidOfHHVLLV(bars, RoundI(periodD)), barsAgo);

        public static double IchimokuSenkouA(IList<DslBar> bars, int barsAgo, double fastD, double slowD)
        {
            int fast = RoundI(fastD); int slow = RoundI(slowD);
            if (fast <= 0 || slow <= 0) return double.NaN;
            var ten = MidOfHHVLLV(bars, fast);
            var kij = MidOfHHVLLV(bars, slow);
            int n = bars.Count;
            var outArr = FilledNaN(n);
            for (int i = 0; i < n; i++)
            {
                if (Dsl.IsFinite(ten[i]) && Dsl.IsFinite(kij[i])) outArr[i] = (ten[i] + kij[i]) / 2.0;
            }
            return At(outArr, barsAgo);
        }

        public static double IchimokuSenkouB(IList<DslBar> bars, int barsAgo, double periodD)
            => At(MidOfHHVLLV(bars, RoundI(periodD)), barsAgo);

        public static double IchimokuChikou(IList<DslBar> bars, int barsAgo, double periodD)
        {
            // calculations.ts emits close[i] aligned 1:1 (no lookahead).
            int idx = bars.Count - 1 - barsAgo;
            if (idx < 0 || idx >= bars.Count) return double.NaN;
            return bars[idx].Close;
        }

        // ───────────────────── AROON ────────────────────────────────────────

        private static double[] BarsSinceExtreme(IList<DslBar> bars, int period, bool pickHigh)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period + 1) return outArr;
            for (int i = period; i < n; i++)
            {
                int bestK = 0;
                double best = pickHigh ? double.NegativeInfinity : double.PositiveInfinity;
                for (int k = 0; k <= period; k++)
                {
                    double v = pickHigh ? bars[i - k].High : bars[i - k].Low;
                    if (pickHigh ? v > best : v < best) { best = v; bestK = k; }
                }
                outArr[i] = bestK;
            }
            return outArr;
        }

        public static double AroonUp(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            var sinceHigh = BarsSinceExtreme(bars, period, true);
            int n = bars.Count;
            var outArr = FilledNaN(n);
            for (int i = 0; i < n; i++)
            {
                if (Dsl.IsFinite(sinceHigh[i])) outArr[i] = (100.0 * (period - sinceHigh[i])) / period;
            }
            return At(outArr, barsAgo);
        }

        public static double AroonDown(IList<DslBar> bars, int barsAgo, double periodD)
        {
            int period = RoundI(periodD);
            if (period <= 0) return double.NaN;
            var sinceLow = BarsSinceExtreme(bars, period, false);
            int n = bars.Count;
            var outArr = FilledNaN(n);
            for (int i = 0; i < n; i++)
            {
                if (Dsl.IsFinite(sinceLow[i])) outArr[i] = (100.0 * (period - sinceLow[i])) / period;
            }
            return At(outArr, barsAgo);
        }

        public static double AroonOsc(IList<DslBar> bars, int barsAgo, double periodD)
        {
            double up = AroonUp(bars, barsAgo, periodD);
            double dn = AroonDown(bars, barsAgo, periodD);
            if (!Dsl.IsFinite(up) || !Dsl.IsFinite(dn)) return double.NaN;
            return up - dn;
        }

        // ───────────────────── VORTEX ──────────────────────────────────────

        private static double[] VortexLeg(IList<DslBar> bars, int period, bool pickPlus)
        {
            int n = bars.Count;
            var outArr = FilledNaN(n);
            if (period <= 0 || n < period + 1) return outArr;
            var vmPlus = new double[n]; var vmMinus = new double[n]; var trs = new double[n];
            for (int i = 0; i < n; i++) { vmPlus[i] = double.NaN; vmMinus[i] = double.NaN; trs[i] = double.NaN; }
            for (int i = 1; i < n; i++)
            {
                vmPlus[i] = Math.Abs(bars[i].High - bars[i - 1].Low);
                vmMinus[i] = Math.Abs(bars[i].Low - bars[i - 1].High);
                double h = bars[i].High; double l = bars[i].Low; double pc = bars[i - 1].Close;
                trs[i] = Math.Max(h - l, Math.Max(Math.Abs(h - pc), Math.Abs(l - pc)));
            }
            for (int i = period; i < n; i++)
            {
                double sumVm = 0, sumTr = 0;
                for (int k = 0; k < period; k++)
                {
                    sumVm += pickPlus ? vmPlus[i - k] : vmMinus[i - k];
                    sumTr += trs[i - k];
                }
                if (sumTr > 0) outArr[i] = sumVm / sumTr;
            }
            return outArr;
        }

        public static double VortexPlus(IList<DslBar> bars, int barsAgo, double periodD)
            => At(VortexLeg(bars, RoundI(periodD), true), barsAgo);

        public static double VortexMinus(IList<DslBar> bars, int barsAgo, double periodD)
            => At(VortexLeg(bars, RoundI(periodD), false), barsAgo);

        // ───────────────────── KALMAN_OU ────────────────────────────────────
        // Kalman-filtered Ornstein–Uhlenbeck mean-reversion estimator.
        // Mirrors src/lib/indicators/kalman-ou.ts line-for-line — that file
        // is the math source of truth, do NOT diverge. The DSL surface is
        // six sibling indicator names (KALMAN_OU_x, _mu, _sigma, _phi, _P,
        // _x_pred) all keyed on the same (source, calib, trust) tuple; we
        // run the filter once per tuple per bar count and hand back the
        // requested field so reading all six fields costs one filter pass.
        //
        // Source codes (mirror kalman-ou.ts:43-51 exactly — drift here
        // silently produces a different filter):
        //   1=close, 2=open, 3=high, 4=low,
        //   5=typical (H+L+C)/3, 6=median (H+L)/2, 7=weighted_close (H+L+2C)/4
        //
        // The `x` vs `x_pred` distinction is load-bearing for honest
        // backtests:
        //   - `x[i]`      = POST-fit Kalman posterior — already absorbed
        //                   close[i]. Comparing close to `x` measures the
        //                   post-fit residual, NOT the OU innovation, so
        //                   z-scores built on it are biased toward easier
        //                   triggers and flatter backtests vs live.
        //   - `x_pred[i]` = PRE-fit prediction `mu + phi*(x[i-1] - mu)`,
        //                   the OU forecast for bar i given everything
        //                   known BEFORE bar i opens. The right baseline
        //                   for innovation z-scores in entry rules.
        // Do NOT collapse them into one field "for simplicity" — that
        // distinction was added after a "too good to be true" backtest
        // audit and is preserved deliberately.

        /// <summary>Bundle of all six Kalman-OU output series, time-aligned
        /// to the bar buffer. NaN slots fill the warmup window
        /// (bars 0..calib-1) and any bar whose calibration window was
        /// degenerate (constant prices, etc.).</summary>
        private sealed class KalmanOuResult
        {
            public double[] X;
            public double[] Mu;
            public double[] Sigma;
            public double[] Phi;
            public double[] P;
            public double[] XPred;
        }

        /// <summary>Per-bars-list Kalman-OU bundle cache. Keyed first
        /// on the bars list reference (so two strategies running
        /// concurrently never share each other's bundles even when
        /// their (source, calib, trust, count) tuples collide), then
        /// on (sourceCode, calib, trust, barCount) so the six sibling
        /// indicator methods within a single bar update share one
        /// filter pass. ConditionalWeakTable's weak-key semantics let
        /// the inner dict get GC'd automatically when the strategy's
        /// _bars list is collected — no manual cleanup needed.</summary>
        private static readonly ConditionalWeakTable<IList<DslBar>, Dictionary<string, KalmanOuResult>> _kalmanCache
            = new ConditionalWeakTable<IList<DslBar>, Dictionary<string, KalmanOuResult>>();

        /// <summary>Read the configured price source from a bar.
        /// Mirrors readSource() in kalman-ou.ts:58-69. Drift here
        /// (e.g. swapping any pair of codes) silently produces a
        /// different filter — keep this in lockstep with the TS side.</summary>
        private static double ReadKalmanSource(DslBar bar, int code)
        {
            switch (code)
            {
                case 1: return bar.Close;
                case 2: return bar.Open;
                case 3: return bar.High;
                case 4: return bar.Low;
                case 5: return (bar.High + bar.Low + bar.Close) / 3.0;
                case 6: return (bar.High + bar.Low) / 2.0;
                case 7: return (bar.High + bar.Low + 2.0 * bar.Close) / 4.0;
                default: return double.NaN;
            }
        }

        /// <summary>Allocate an all-NaN bundle of length n — the standard
        /// failure return so callers degrade cleanly via the
        /// NaN-rejection paths every other indicator uses.</summary>
        private static KalmanOuResult NanKalmanBundle(int n)
        {
            return new KalmanOuResult
            {
                X = FilledNaN(n),
                Mu = FilledNaN(n),
                Sigma = FilledNaN(n),
                Phi = FilledNaN(n),
                P = FilledNaN(n),
                XPred = FilledNaN(n),
            };
        }

        /// <summary>Compute the full Kalman-OU bundle for the bar series
        /// with ROLLING calibration. At every bar i >= calib, the OU
        /// parameters (mu, phi, sigma_long, Q, R) are refit via OLS over
        /// the immediately preceding `calib` bars, then a single Kalman
        /// step incorporates bar i. Path-independent and out-of-sample
        /// throughout — see kalman-ou.ts:112-139 for the full rationale.
        ///
        /// Sufficient stats are maintained as O(1) rolling updates so
        /// the per-bar cost is flat regardless of `calib`. Any failure
        /// of preconditions returns an all-NaN bundle.</summary>
        private static KalmanOuResult ComputeKalmanOu(
            IList<DslBar> bars, int sourceCode, int calibN, double trust)
        {
            int n = bars.Count;
            if (n == 0) return NanKalmanBundle(0);
            if (sourceCode < 1 || sourceCode > 7) return NanKalmanBundle(n);
            if (calibN < 3) return NanKalmanBundle(n);
            if (!Dsl.IsFinite(trust) || trust <= 0.0 || trust >= 1.0) return NanKalmanBundle(n);
            if (n < calibN + 1) return NanKalmanBundle(n);

            // Pre-extract the source series so the rolling loop reads
            // cheap array slots, not bar fields.
            var y = new double[n];
            for (int i = 0; i < n; i++) y[i] = ReadKalmanSource(bars[i], sourceCode);

            var outB = NanKalmanBundle(n);

            // Filter state — seeded from the last observation BEFORE the
            // first emit bar so the very first Kalman step at i=calibN
            // has a sensible prior. P is set after the first successful
            // calibration to the long-run variance.
            double x = y[calibN - 1];
            double P = 0.0;
            double mu = double.NaN, phi = double.NaN, Q = double.NaN;
            double sigmaLong = double.NaN, R = double.NaN;

            int pairs = calibN - 1;
            int dof = pairs > 2 ? pairs - 2 : Math.Max(1, pairs - 1);

            // O(1) rolling OLS sufficient stats over the y_t side of pairs.
            // See kalman-ou.ts:189-213 for the algebra.
            double sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
            for (int t = 0; t < pairs; t++)
            {
                double yt = y[t];
                double yt1 = y[t + 1];
                sumX += yt;
                sumY += yt1;
                sumXX += yt * yt;
                sumXY += yt * yt1;
                sumYY += yt1 * yt1;
            }

            for (int i = calibN; i < n; i++)
            {
                // Step 1: rolling OLS fit. Window covers bars [i-calibN .. i-1].
                double meanX = sumX / pairs;
                double meanY = sumY / pairs;
                double sxx = sumXX - sumX * meanX;
                double sxy = sumXY - sumX * meanY;
                bool stepOk = sxx > 0;
                double xPred = double.NaN;

                if (stepOk)
                {
                    double phiNew = sxy / sxx;
                    if (!Dsl.IsFinite(phiNew))
                    {
                        stepOk = false;
                    }
                    else
                    {
                        // Stationarity guard — keep phi strictly inside
                        // the unit circle so phi^2 in the sigma denominator
                        // stays away from zero. MUST clamp at 0.999 to
                        // match TS — 0.99 would drift mean-reversion
                        // behavior near unit-root.
                        if (phiNew >= 0.999) phiNew = 0.999;
                        else if (phiNew <= -0.999) phiNew = -0.999;

                        double aLin = meanY - phiNew * meanX;
                        // SSE via the algebraic identity (cheaper than a
                        // residual loop, same value):
                        //   SSE = sumYY - 2*a*sumY - 2*b*sumXY
                        //         + 2*a*b*sumX + a^2*pairs + b^2*sumXX
                        double sse =
                            sumYY
                            - 2.0 * aLin * sumY
                            - 2.0 * phiNew * sumXY
                            + 2.0 * aLin * phiNew * sumX
                            + aLin * aLin * pairs
                            + phiNew * phiNew * sumXX;
                        double Qnew = sse / dof;
                        if (!(Qnew > 0))
                        {
                            stepOk = false;
                        }
                        else
                        {
                            phi = phiNew;
                            Q = Qnew;
                            mu = aLin / (1.0 - phi);
                            sigmaLong = Math.Sqrt(Q / (1.0 - phi * phi));
                            // R = Q * (1 - trust) / trust. Steady-state
                            // Kalman gain converges to `trust`, so trust
                            // is a friendly knob: small=heavy smoothing
                            // toward the OU prediction, large=closer to
                            // raw price.
                            R = Q * (1.0 - trust) / trust;
                            if (!Dsl.IsFinite(P) || P == 0.0)
                            {
                                P = sigmaLong * sigmaLong;
                            }
                        }
                    }
                }

                if (!stepOk)
                {
                    // Degenerate calibration window. Emit NaN for this
                    // bar and roll forward without updating filter state
                    // — the next bar's window may recover.
                    // (Bundle slots are already NaN from NanKalmanBundle.)
                }
                else
                {
                    // Step 2: predict — capture x_pred BEFORE the update
                    // so it reflects the OU model's forecast given only
                    // bars < i.
                    xPred = mu + phi * (x - mu);
                    double pPred = phi * phi * P + Q;

                    // Step 3: update with observation y[i].
                    double z = y[i];
                    if (!Dsl.IsFinite(z))
                    {
                        // Missing observation — propagate without updating.
                        x = xPred;
                        P = pPred;
                    }
                    else
                    {
                        double innovVar = pPred + R;
                        double K = innovVar > 0 ? pPred / innovVar : 0.0;
                        x = xPred + K * (z - xPred);
                        P = (1.0 - K) * pPred;
                    }

                    outB.X[i] = x;
                    outB.Mu[i] = mu;
                    outB.Sigma[i] = sigmaLong;
                    outB.Phi[i] = phi;
                    outB.P[i] = P;
                    outB.XPred[i] = xPred;
                }

                // Step 4: slide the window forward by one bar.
                if (i + 1 < n)
                {
                    int dropT = i - calibN;
                    double yDrop = y[dropT];
                    double yDropNext = y[dropT + 1];
                    sumX -= yDrop;
                    sumY -= yDropNext;
                    sumXX -= yDrop * yDrop;
                    sumXY -= yDrop * yDropNext;
                    sumYY -= yDropNext * yDropNext;

                    double yAdd = y[i - 1];
                    double yAddNext = y[i];
                    sumX += yAdd;
                    sumY += yAddNext;
                    sumXX += yAdd * yAdd;
                    sumXY += yAdd * yAddNext;
                    sumYY += yAddNext * yAddNext;
                }
            }

            return outB;
        }

        /// <summary>Cache lookup: compute (or fetch) the bundle for this
        /// (source, calib, trust, barCount) tuple. Sharing a bundle
        /// across the six sibling methods saves 5 redundant filter
        /// passes per bar update.</summary>
        private static KalmanOuResult GetKalmanBundle(
            IList<DslBar> bars, double sourceD, double calibD, double trustD)
        {
            int sourceCode = RoundI(sourceD);
            int calibN = RoundI(calibD);
            int n = bars.Count;
            // "R" round-trip format keeps the trust key bit-precise
            // across calls so 0.5 always hashes the same as 0.5.
            string key = sourceCode.ToString() + "|" + calibN.ToString()
                       + "|" + trustD.ToString("R") + "|" + n.ToString();
            Dictionary<string, KalmanOuResult> perBars;
            if (!_kalmanCache.TryGetValue(bars, out perBars))
            {
                perBars = new Dictionary<string, KalmanOuResult>();
                _kalmanCache.Add(bars, perBars);
            }
            KalmanOuResult cached;
            if (perBars.TryGetValue(key, out cached)) return cached;
            cached = ComputeKalmanOu(bars, sourceCode, calibN, trustD);
            perBars[key] = cached;
            return cached;
        }

        public static double KalmanOuX(IList<DslBar> bars, int barsAgo, double sourceD, double calibD, double trustD)
            => At(GetKalmanBundle(bars, sourceD, calibD, trustD).X, barsAgo);

        public static double KalmanOuMu(IList<DslBar> bars, int barsAgo, double sourceD, double calibD, double trustD)
            => At(GetKalmanBundle(bars, sourceD, calibD, trustD).Mu, barsAgo);

        public static double KalmanOuSigma(IList<DslBar> bars, int barsAgo, double sourceD, double calibD, double trustD)
            => At(GetKalmanBundle(bars, sourceD, calibD, trustD).Sigma, barsAgo);

        public static double KalmanOuPhi(IList<DslBar> bars, int barsAgo, double sourceD, double calibD, double trustD)
            => At(GetKalmanBundle(bars, sourceD, calibD, trustD).Phi, barsAgo);

        public static double KalmanOuP(IList<DslBar> bars, int barsAgo, double sourceD, double calibD, double trustD)
            => At(GetKalmanBundle(bars, sourceD, calibD, trustD).P, barsAgo);

        public static double KalmanOuXPred(IList<DslBar> bars, int barsAgo, double sourceD, double calibD, double trustD)
            => At(GetKalmanBundle(bars, sourceD, calibD, trustD).XPred, barsAgo);
    }
}
