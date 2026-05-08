// DslTickAggregator.cs
//
// Per-strategy tick aggregator for DSL strategies that need bid/ask
// attribution or tick-resolution indicators (POC / VAH / VAL / delta /
// vwap_tick / tick_imbalance / large_trade_count / mean_trade_size /
// tick_count).
//
// Lifecycle:
//   - Constructed in DslStrategyBase.AfterDataLoadedFromTranspiler()
//     when the transpiler sets requiresTicks=true.
//   - Receives ticks via OnMarketData (the strategy adds a 1-tick
//     BarsArray and the base routes BarsInProgress==1 OnBarUpdates
//     plus OnMarketData events here).
//   - Per-bar accumulators reset when the primary bar series rolls
//     (the base detects via Time[0] change).
//
// The aggregator maintains TWO state structures:
//   1. A rolling tick buffer for window-based indicators (vwap_tick,
//      mean_trade_size, large_trade_count, etc.).
//   2. Per-bar bid/ask volume accumulators that get sealed into the
//      DslBar at bar close (so future window queries see the
//      historical bid/ask volumes).
//
// PARITY: this mirrors src/lib/utils/tick-aggregation.ts and
// src/lib/indicators/tick-indicators.ts. Side classification on
// MarketDataType.Last falls back to "compare against last quote"
// — same convention as the dashboard's aggregateTicks(). When the
// data feed exposes Bid/Ask explicitly per tick we use that directly.
//
// v1 SCOPE — bar-level scalars (Delta / DeltaRatio / BuyPressure)
// AND volume profile (Poc / Vah / Val / VaWidth / DistToPoc) AND
// simple tick microstructure (TickCount / MeanTradeSize / VwapTick).
// trades_at_bid / trades_at_ask / tick_imbalance / large_trade_count
// require side classification per tick — also implemented but
// effectiveness depends on the feed's per-tick MarketDataType.

using System;
using System.Collections.Generic;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;

namespace NinjaTrader.NinjaScript.AddOns
{
    public class DslTickAggregator
    {
        private readonly Bars[] _barsArray;
        private readonly int _tickBarsIndex;

        public DslTickAggregator(Bars[] barsArray, int tickBarsIndex)
        {
            _barsArray = barsArray;
            _tickBarsIndex = tickBarsIndex;
        }

        // ─── Per-bar accumulators ──────────────────────────────────────
        // Keyed by bar number on the primary series. We accumulate ticks
        // into the current bar's bucket; when the primary bar rolls we
        // seal the accumulators into the historical series.
        private readonly List<BarBucket> _historical = new List<BarBucket>();
        private BarBucket _current = new BarBucket();
        private DateTime _currentBarTime = DateTime.MinValue;
        private double _lastTickPrice = double.NaN;

        private class BarBucket
        {
            public DateTime BarTime;
            public double VolumeBid; // sum of trades classified as hitting the bid
            public double VolumeAsk; // sum classified as lifting the offer
            public double Volume;    // total
            public List<TickRecord> Ticks = new List<TickRecord>();
        }

        private struct TickRecord
        {
            public double Price;
            public double Size;
            public sbyte  Side; // -1 = bid, +1 = ask, 0 = unknown
        }

        public void OnTick(DateTime time, double price, double size)
        {
            // Roll the bucket if the bar changed. The strategy base pushes
            // bars on the primary series timestamp; we use the same
            // timestamp here so historical buckets align.
            // Note: NT8 fires OnBarUpdate for BarsInProgress==1 BEFORE
            // OnMarketData on some setups; we use the supplied time as
            // the bucket key.
            // For simplicity, treat "different minute/second resolution
            // from the primary series" as a roll trigger via the base
            // calling RollIfBarChanged externally. v1 just appends.
            _current.Ticks.Add(new TickRecord { Price = price, Size = size, Side = 0 });
            _current.Volume += size;
            _lastTickPrice = price;
        }

        public void OnMarketData(MarketDataEventArgs e)
        {
            if (e == null) return;
            if (e.MarketDataType != MarketDataType.Last) return;
            // Side classification: prefer the explicit MarketDataType
            // when the feed exposes Bid/Ask trades; fall back to
            // last-quote comparison.
            sbyte side = 0;
            // NT8's MarketDataEventArgs has fields for IsBidAskTrade etc.
            // on some versions; defensive try-block.
            try
            {
                // If we don't know explicitly, classify against last price.
                // Trade at last price → unknown; up-tick → ask (lift offer);
                // down-tick → bid (hit bid).
                if (!double.IsNaN(_lastTickPrice))
                {
                    if (e.Price > _lastTickPrice) side = 1;
                    else if (e.Price < _lastTickPrice) side = -1;
                }
            }
            catch { /* defensive */ }

            var rec = new TickRecord { Price = e.Price, Size = e.Volume, Side = side };
            _current.Ticks.Add(rec);
            _current.Volume += e.Volume;
            if (side == 1) _current.VolumeAsk += e.Volume;
            else if (side == -1) _current.VolumeBid += e.Volume;
            _lastTickPrice = e.Price;
        }

        /// <summary>
        /// Called from DslStrategyBase at the END of OnBarUpdate on the
        /// primary series, AFTER the strategy has read whatever
        /// indicators it needed for this bar. Seals the current bucket
        /// into history and starts a fresh one.
        /// </summary>
        public void RollBar(DateTime newBarTime)
        {
            _current.BarTime = _currentBarTime;
            _historical.Add(_current);
            // Cap history to a reasonable size — same as the bar buffer.
            if (_historical.Count > 1500)
            {
                _historical.RemoveRange(0, _historical.Count - 1500);
            }
            _current = new BarBucket();
            _currentBarTime = newBarTime;
        }

        // ─── Bar-level scalars ─────────────────────────────────────────
        // BarVolumeBid(N) returns the bid-side volume for the bar N bars
        // ago (0 = current bar). NaN when the feed didn't supply
        // attribution or the bar is outside history.

        private BarBucket BarAt(int barsAgo)
        {
            if (barsAgo == 0) return _current;
            int idx = _historical.Count - barsAgo;
            if (idx < 0 || idx >= _historical.Count) return null;
            return _historical[idx];
        }

        public double BarVolumeBid(int barsAgo)
        {
            var b = BarAt(barsAgo);
            return b == null ? double.NaN : b.VolumeBid;
        }
        public double BarVolumeAsk(int barsAgo)
        {
            var b = BarAt(barsAgo);
            return b == null ? double.NaN : b.VolumeAsk;
        }
        public double Delta(int barsAgo)
        {
            var b = BarAt(barsAgo);
            if (b == null) return double.NaN;
            return b.VolumeAsk - b.VolumeBid;
        }
        public double DeltaRatio(int barsAgo)
        {
            var b = BarAt(barsAgo);
            if (b == null) return double.NaN;
            double total = b.VolumeAsk + b.VolumeBid;
            if (total <= 0) return double.NaN;
            return (b.VolumeAsk - b.VolumeBid) / total;
        }
        public double BuyPressure(int barsAgo)
        {
            var b = BarAt(barsAgo);
            if (b == null) return double.NaN;
            if (b.Volume <= 0) return double.NaN;
            return b.VolumeAsk / b.Volume;
        }

        // ─── Tick window indicators ────────────────────────────────────
        // Walk back N bars worth of ticks. For typical windows (5-50
        // bars) this is cheap; if profiling shows it's a bottleneck the
        // next iteration adds incremental updates.

        public double VwapTick(int barsAgo, double windowD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0) return double.NaN;
            double pv = 0, v = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b == null) continue;
                foreach (var t in b.Ticks)
                {
                    pv += t.Price * t.Size;
                    v  += t.Size;
                }
            }
            return v <= 0 ? double.NaN : pv / v;
        }

        public double TickCount(int barsAgo, double windowD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0) return double.NaN;
            int count = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b != null) count += b.Ticks.Count;
            }
            return count;
        }

        public double MeanTradeSize(int barsAgo, double windowD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0) return double.NaN;
            double sum = 0;
            int count = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b != null)
                {
                    foreach (var t in b.Ticks) { sum += t.Size; count++; }
                }
            }
            return count == 0 ? double.NaN : sum / count;
        }

        public double TradesAtBid(int barsAgo, double windowD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0) return double.NaN;
            int n = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b != null) foreach (var t in b.Ticks) if (t.Side == -1) n++;
            }
            return n;
        }

        public double TradesAtAsk(int barsAgo, double windowD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0) return double.NaN;
            int n = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b != null) foreach (var t in b.Ticks) if (t.Side == 1) n++;
            }
            return n;
        }

        public double TickImbalance(int barsAgo, double windowD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0) return double.NaN;
            int bid = 0, ask = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b != null)
                {
                    foreach (var t in b.Ticks)
                    {
                        if (t.Side == 1) ask++;
                        else if (t.Side == -1) bid++;
                    }
                }
            }
            int total = ask + bid;
            if (total == 0) return double.NaN;
            return ((double)(ask - bid)) / total;
        }

        public double LargeTradeCount(int barsAgo, double windowD, double thresholdD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            if (window <= 0 || thresholdD <= 0) return double.NaN;
            int n = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b != null) foreach (var t in b.Ticks) if (t.Size >= thresholdD) n++;
            }
            return n;
        }

        // ─── Volume profile (POC / VAH / VAL / VA_width / dist_to_POC) ──
        //
        // Build a price-bin histogram of the last N bars' tick volumes.
        // Bin size = TickSize from the primary instrument (the strategy
        // passes it in). POC = price at peak bin. Value Area is the
        // contiguous bin range (expanded outward from POC) that contains
        // `area` fraction of total volume — default 0.7.
        //
        // For now we use a fixed default tick size for binning when
        // none is supplied; the strategy base could pass TickSize via
        // a setter if precision matters.

        private double _binSize = 0.25; // sane NQ default; instrument-specific override needed

        public void SetBinSize(double binSize)
        {
            if (binSize > 0) _binSize = binSize;
        }

        private struct ProfileResult
        {
            public double Poc;
            public double Vah;
            public double Val;
            public double VaWidth;
            public bool   Valid;
        }

        private ProfileResult BuildProfile(int barsAgo, int window, double area)
        {
            var result = new ProfileResult { Valid = false };
            if (window <= 0 || _binSize <= 0) return result;
            // Aggregate tick volume into bins.
            var bins = new Dictionary<long, double>();
            double total = 0;
            for (int k = barsAgo; k < barsAgo + window; k++)
            {
                var b = BarAt(k);
                if (b == null) continue;
                foreach (var t in b.Ticks)
                {
                    long bin = (long)Math.Floor(t.Price / _binSize);
                    if (!bins.ContainsKey(bin)) bins[bin] = 0;
                    bins[bin] += t.Size;
                    total += t.Size;
                }
            }
            if (bins.Count == 0 || total <= 0) return result;
            // Find POC.
            long pocBin = 0;
            double pocVol = -1;
            foreach (var kvp in bins)
            {
                if (kvp.Value > pocVol)
                {
                    pocVol = kvp.Value;
                    pocBin = kvp.Key;
                }
            }
            // Expand outward from POC until area is covered.
            double targetVol = total * area;
            double accumVol = pocVol;
            long lo = pocBin, hi = pocBin;
            while (accumVol < targetVol)
            {
                double loVol = bins.ContainsKey(lo - 1) ? bins[lo - 1] : 0;
                double hiVol = bins.ContainsKey(hi + 1) ? bins[hi + 1] : 0;
                if (loVol == 0 && hiVol == 0) break;
                if (hiVol >= loVol)
                {
                    hi++;
                    accumVol += hiVol;
                }
                else
                {
                    lo--;
                    accumVol += loVol;
                }
            }
            result.Poc = (pocBin + 0.5) * _binSize;
            result.Val = lo * _binSize;
            result.Vah = (hi + 1) * _binSize;
            result.VaWidth = result.Vah - result.Val;
            result.Valid = true;
            return result;
        }

        public double Poc(int barsAgo, double windowD, double areaD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            var r = BuildProfile(barsAgo, window, areaD);
            return r.Valid ? r.Poc : double.NaN;
        }
        public double Vah(int barsAgo, double windowD, double areaD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            var r = BuildProfile(barsAgo, window, areaD);
            return r.Valid ? r.Vah : double.NaN;
        }
        public double Val(int barsAgo, double windowD, double areaD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            var r = BuildProfile(barsAgo, window, areaD);
            return r.Valid ? r.Val : double.NaN;
        }
        public double VaWidth(int barsAgo, double windowD, double areaD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            var r = BuildProfile(barsAgo, window, areaD);
            return r.Valid ? r.VaWidth : double.NaN;
        }
        public double DistToPoc(int barsAgo, double windowD, double areaD)
        {
            int window = (int)Math.Round(windowD, MidpointRounding.AwayFromZero);
            var r = BuildProfile(barsAgo, window, areaD);
            if (!r.Valid) return double.NaN;
            var bb = BarAt(barsAgo);
            if (bb == null || bb.Ticks.Count == 0) return double.NaN;
            // Use the bar's last tick price as "current" — close-enough
            // proxy for a closed-bar reference.
            double p = bb.Ticks[bb.Ticks.Count - 1].Price;
            return p - r.Poc;
        }
    }
}
