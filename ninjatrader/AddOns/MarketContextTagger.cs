#region Using declarations
using System;
using System.Collections.Generic;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// MarketContextTagger — Self-contained indicator engine for market context snapshots.
    ///
    /// One instance per actively-traded instrument. Uses BarsRequest for historical/real-time
    /// bar data and computes all indicators manually (no chart dependency, no NinjaScript
    /// indicator objects). This makes it work on sim, playback, and live accounts without
    /// requiring any chart to be open.
    ///
    /// Why manual indicator math instead of companion Indicator objects?
    /// - Self-contained: no user action needed, no chart must be open
    /// - Works identically on sim + playback with no external dependencies
    /// - Project already does manual VWAP/POC calculations in strategies — same pattern
    /// - Avoids NinjaTrader's indicator hosting complexity outside of chart/strategy context
    ///
    /// Indicators calculated on 5-minute bars:
    /// - EMA(20):  Exponential Moving Average with k = 2/21
    /// - EMA(200): Exponential Moving Average with k = 2/201
    /// - ATR(14):  Average True Range with Wilder smoothing
    /// - Bollinger(2,20): SMA(20) +/- 2 * stddev(20 closes)
    /// - ADX(14):  Average Directional Index via +DM/-DM → DI → DX → Wilder smooth
    ///
    /// Also subscribes to MarketDataUpdate for tick-by-tick LastPrice tracking
    /// (used by TradeTracker to update MFE/MAE on open trades).
    /// </summary>
    public class MarketContextTagger : IDisposable
    {
        // ─── Constants ─────────────────────────────────────────────────────────
        private const int EMA_SHORT_PERIOD = 20;
        private const int EMA_LONG_PERIOD = 200;
        private const int ATR_PERIOD = 14;
        private const int BB_PERIOD = 20;
        private const double BB_STD_DEV_MULT = 2.0;
        private const int ADX_PERIOD = 14;
        private const int BARS_REQUESTED = 300; // Enough for EMA-200 warmup + buffer
        private const int BARS_REQUESTED_15S = 100; // ~25 min of 15s bars, ATR(14) only needs 15

        // ─── Instrument Reference ──────────────────────────────────────────────
        private readonly NinjaTrader.Cbi.Instrument _instrument;

        // ─── BarsRequest for historical + real-time bar data (5-min) ─────────────
        private BarsRequest _barsRequest;
        private bool _isWarmedUp;           // True once we have enough bars for all indicators
        private bool _isDisposed;
        private bool _historicalBarsProcessed;  // True after Request callback processes historical bars
        private int _lastHistoricalBarIndex;    // Last bar index processed during historical load

        // ─── BarsRequest for 15-second bars (micro-timeframe ATR) ────────────────
        private BarsRequest _barsRequest15s;
        private bool _historicalBarsProcessed15s;  // True after 15s Request callback processes historical bars
        private int _lastHistoricalBarIndex15s;    // Last 15s bar index processed during historical load

        // ─── Indicator State ───────────────────────────────────────────────────
        // These are updated on each bar close (via BarsRequest.Update event)

        // EMA(20) — short-term trend
        private double _ema20;
        private bool _ema20Initialized;
        private double _ema20Sum;       // Running sum for initial SMA seed
        private int _ema20Count;

        // EMA(200) — long-term trend
        private double _ema200;
        private bool _ema200Initialized;
        private double _ema200Sum;
        private int _ema200Count;

        // ATR(14) on 5-min — volatility (Wilder smoothing)
        private double _atr14;
        private bool _atr14Initialized;
        private double _atrSum;
        private int _atrCount;
        private double _prevClose;      // Previous bar's close for true range calculation
        private bool _hasPrevClose;

        // ATR(14) on 15-second bars — micro-timeframe volatility
        // Separate state from 5-min ATR — never shares or touches 5-min state
        private double _atr14_15s;
        private bool _atr14_15sInitialized;
        private double _atr15sSum;
        private int _atr15sCount;
        private double _prevClose15s;   // Previous 15s bar's close for true range
        private bool _hasPrevClose15s;

        // Bollinger Bands(2, 20) — volatility bands
        // We need the last 20 closes to compute SMA and stddev
        private Queue<double> _bbCloses;
        private double _bbUpper;
        private double _bbMiddle;
        private double _bbLower;
        private bool _bbInitialized;

        // ADX(14) — trend strength
        // Requires multi-step Wilder smoothing: +DM/-DM → smooth → +DI/-DI → DX → smooth ADX
        private double _smoothedPlusDM;
        private double _smoothedMinusDM;
        private double _smoothedTR;     // Smoothed True Range for DI normalization
        private double _adx;
        private double _adxDxSum;       // Sum for initial ADX seed
        private int _adxDxCount;
        private bool _adxDmInitialized; // +DM/-DM Wilder smoothing seeded
        private bool _adxInitialized;   // Final ADX value available
        private double _prevHigh;
        private double _prevLow;
        private bool _hasPrevBar;       // True after first bar processed (need prev high/low)

        // ─── Tick Price Tracking ───────────────────────────────────────────────
        /// <summary>
        /// Last traded price, updated on every tick via MarketDataUpdate.
        /// Used by TradeTracker to update MFE/MAE on open trades.
        /// </summary>
        public double LastPrice { get; private set; }

        /// <summary>
        /// Callback invoked on every price update (ticks + bar closes).
        /// TradeTracker wires this to drive MFE/MAE updates and post-exit tracking.
        /// Parameters: instrumentName, price, barTime (DateTime.MinValue for ticks, actual bar time for bar closes)
        /// </summary>
        public Action<string, double, DateTime> OnPriceUpdate { get; set; }

        /// <summary>Whether the tagger has enough data for reliable indicator values</summary>
        public bool IsWarmedUp { get { return _isWarmedUp; } }

        /// <summary>
        /// Exposes the instrument reference for bridge event handlers.
        /// TradeTracker uses this to resolve instrumentFullName → Instrument object
        /// when processing RiskManagerBridge entry/exit events.
        /// </summary>
        public NinjaTrader.Cbi.Instrument Instrument { get { return _instrument; } }

        /// <summary>
        /// Creates a MarketContextTagger for the specified instrument.
        /// Immediately starts a BarsRequest for 300 bars of 5-minute data
        /// and subscribes to real-time tick updates.
        /// </summary>
        /// <param name="instrument">The NinjaTrader instrument to track</param>
        public MarketContextTagger(NinjaTrader.Cbi.Instrument instrument)
        {
            _instrument = instrument;
            _bbCloses = new Queue<double>();
            _isWarmedUp = false;
            _isDisposed = false;

            // Start the BarsRequest for historical data + real-time updates (5-min bars)
            StartBarsRequest();

            // Start a second BarsRequest for 15-second bars (micro-timeframe ATR)
            StartBarsRequest15s();

            // Subscribe to tick-by-tick market data for LastPrice tracking
            SubscribeToMarketData();
        }

        /// <summary>
        /// Requests 300 bars of 5-minute data for the instrument.
        /// The Update event fires once for each historical bar (warmup) and then
        /// on each new real-time bar close.
        /// </summary>
        private void StartBarsRequest()
        {
            try
            {
                // Create the bars request: 5-minute bars, 300 bars lookback
                _barsRequest = new BarsRequest(_instrument, BARS_REQUESTED);
                _barsRequest.BarsPeriod = new BarsPeriod
                {
                    BarsPeriodType = BarsPeriodType.Minute,
                    Value = 5
                };
                // NOTE: Do NOT set TradingHours — let BarsRequest use the instrument's default.
                // Hardcoding a template name (e.g., "CME US Index Futures ETH") causes silent
                // failure if the template doesn't exist on the user's NT8 install.

                // Subscribe to bar updates (historical + real-time)
                _barsRequest.Update += OnBarsUpdate;

                // Request the data — the callback fires once when the historical batch loads.
                // IMPORTANT: OnBarsUpdate does NOT reliably fire once per historical bar.
                // It may only fire once with the last bar index. So we process ALL historical
                // bars here in the callback where req.Bars contains the full set.
                _barsRequest.Request(new Action<BarsRequest, ErrorCode, string>((req, errorCode, errorMessage) =>
                {
                    if (errorCode != ErrorCode.NoError)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: BarsRequest error for {0} — {1}: {2}",
                                _instrument.FullName, errorCode, errorMessage),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        int barCount = req.Bars != null ? req.Bars.Count : 0;

                        // Process every historical bar through the indicator engine
                        if (req.Bars != null && barCount > 0)
                        {
                            for (int i = 0; i < barCount; i++)
                            {
                                double close = req.Bars.GetClose(i);
                                double high  = req.Bars.GetHigh(i);
                                double low   = req.Bars.GetLow(i);
                                ProcessBar(close, high, low);
                            }
                            // Record the last historical index so OnBarsUpdate skips these bars
                            _lastHistoricalBarIndex = barCount - 1;
                        }

                        // Mark historical processing complete — OnBarsUpdate now handles real-time only
                        _historicalBarsProcessed = true;

                        // Check warmup after processing all historical bars
                        CheckWarmupStatus();

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: BarsRequest completed for {0} — {1} bars received, warmed up: {2}",
                                _instrument.FullName, barCount, _isWarmedUp),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }));
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Failed to start BarsRequest for {0} — {1}",
                        _instrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── 15-Second BarsRequest ───────────────────────────────────────────────
        // Mirrors the 5-min BarsRequest pattern but for 15-second bars.
        // Only computes ATR(14) — no EMA, Bollinger, or ADX on this timeframe.

        /// <summary>
        /// Requests 100 bars of 15-second data for the instrument.
        /// Same pattern as StartBarsRequest() — processes historical bars in the
        /// Request callback, then OnBarsUpdate15s handles real-time bar closes.
        /// </summary>
        private void StartBarsRequest15s()
        {
            try
            {
                // Create the bars request: 15-second bars, 100 bars lookback
                _barsRequest15s = new BarsRequest(_instrument, BARS_REQUESTED_15S);
                _barsRequest15s.BarsPeriod = new BarsPeriod
                {
                    BarsPeriodType = BarsPeriodType.Second,
                    Value = 15
                };

                // Subscribe to bar updates (historical + real-time)
                _barsRequest15s.Update += OnBarsUpdate15s;

                // Request the data — process all historical bars in the callback
                _barsRequest15s.Request(new Action<BarsRequest, ErrorCode, string>((req, errorCode, errorMessage) =>
                {
                    if (errorCode != ErrorCode.NoError)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: BarsRequest15s error for {0} — {1}: {2}",
                                _instrument.FullName, errorCode, errorMessage),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        int barCount = req.Bars != null ? req.Bars.Count : 0;

                        // Process every historical 15s bar through the ATR engine
                        if (req.Bars != null && barCount > 0)
                        {
                            for (int i = 0; i < barCount; i++)
                            {
                                double close = req.Bars.GetClose(i);
                                double high  = req.Bars.GetHigh(i);
                                double low   = req.Bars.GetLow(i);
                                ProcessBar15s(close, high, low);
                            }
                            // Record the last historical index so OnBarsUpdate15s skips these bars
                            _lastHistoricalBarIndex15s = barCount - 1;
                        }

                        // Mark historical processing complete
                        _historicalBarsProcessed15s = true;

                        // Check warmup — 15s ATR is now part of the warmup gate
                        CheckWarmupStatus();

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: BarsRequest15s completed for {0} — {1} bars received, ATR15s initialized: {2}",
                                _instrument.FullName, barCount, _atr14_15sInitialized),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }));
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Failed to start BarsRequest15s for {0} — {1}",
                        _instrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Handles real-time 15-second bar updates ONLY. Historical bars are processed
        /// in the Request callback. Same guard pattern as OnBarsUpdate for 5-min bars.
        /// </summary>
        private void OnBarsUpdate15s(object sender, BarsUpdateEventArgs e)
        {
            if (_isDisposed) return;

            // Skip if historical bars haven't been processed yet
            if (!_historicalBarsProcessed15s) return;

            try
            {
                // Only process bars beyond the last historical index (real-time bars)
                for (int i = e.MinIndex; i <= e.MaxIndex; i++)
                {
                    // Skip bars that were already processed during the historical load
                    if (i <= _lastHistoricalBarIndex15s) continue;

                    double close = _barsRequest15s.Bars.GetClose(i);
                    double high  = _barsRequest15s.Bars.GetHigh(i);
                    double low   = _barsRequest15s.Bars.GetLow(i);

                    ProcessBar15s(close, high, low);
                }

                // Check warmup (may transition on real-time bars)
                CheckWarmupStatus();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error processing 15s bar update for {0} — {1}",
                        _instrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Processes a single 15-second bar. Only computes ATR(14) — no other indicators
        /// run on this timeframe. Does NOT update LastPrice or fire OnPriceUpdate
        /// (5-min bars + ticks already handle price tracking).
        /// </summary>
        /// <param name="close">15s bar close price</param>
        /// <param name="high">15s bar high price</param>
        /// <param name="low">15s bar low price</param>
        private void ProcessBar15s(double close, double high, double low)
        {
            UpdateATR15s(high, low, close);

            // Store current bar's close as "previous" for next iteration's true range
            _prevClose15s = close;
            _hasPrevClose15s = true;
        }

        // ─── ATR(14) on 15-Second Bars ──────────────────────────────────────────
        // Same Wilder smoothing as the 5-min ATR but using entirely separate state.
        // True Range = max(high - low, |high - prevClose|, |low - prevClose|)
        // Wilder smoothing: atr = (atr_prev * 13 + trueRange) / 14

        /// <summary>
        /// Updates the 15-second ATR(14) with a new bar's data.
        /// Identical math to UpdateATR() but operates on _atr14_15s state variables.
        /// </summary>
        private void UpdateATR15s(double high, double low, double close)
        {
            if (!_hasPrevClose15s)
                return; // Need at least one prior close for true range

            // Calculate True Range
            double tr = high - low;
            double tr2 = Math.Abs(high - _prevClose15s);
            double tr3 = Math.Abs(low - _prevClose15s);
            if (tr2 > tr) tr = tr2;
            if (tr3 > tr) tr = tr3;

            if (!_atr14_15sInitialized)
            {
                // Seed phase: accumulate TRs for initial SMA
                _atr15sSum += tr;
                _atr15sCount++;
                if (_atr15sCount >= ATR_PERIOD)
                {
                    _atr14_15s = _atr15sSum / ATR_PERIOD;
                    _atr14_15sInitialized = true;
                }
            }
            else
            {
                // Wilder smoothing
                _atr14_15s = (_atr14_15s * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
            }
        }

        /// <summary>
        /// Subscribes to tick-by-tick market data for LastPrice tracking.
        /// Only listens for MarketDataType.Last (actual trades, not bid/ask).
        /// </summary>
        private void SubscribeToMarketData()
        {
            try
            {
                // Subscribe at the instrument level for all last-trade ticks
                _instrument.MarketDataUpdate += OnMarketDataUpdate;
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Failed to subscribe to market data for {0} — {1}",
                        _instrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Handles real-time tick data. Updates LastPrice for MFE/MAE tracking.
        /// Only processes MarketDataType.Last (actual trade ticks).
        /// </summary>
        private void OnMarketDataUpdate(object sender, MarketDataEventArgs e)
        {
            if (_isDisposed) return;
            if (e.MarketDataType == MarketDataType.Last)
            {
                LastPrice = e.Price;

                // Notify TradeTracker of tick price update for MFE/MAE + post-exit tracking.
                // DateTime.MinValue signals "this is a tick, not a bar close" so the handler
                // knows not to advance _lastKnownTime from this event.
                if (OnPriceUpdate != null)
                    OnPriceUpdate(_instrument.FullName, e.Price, DateTime.MinValue);
            }
        }

        /// <summary>
        /// Handles real-time bar updates ONLY. Historical bars are processed in the
        /// Request callback. This event may also re-fire for historical bars (with
        /// unpredictable MinIndex/MaxIndex), so we skip any bar index that was already
        /// processed during the historical load.
        /// </summary>
        private void OnBarsUpdate(object sender, BarsUpdateEventArgs e)
        {
            if (_isDisposed) return;

            // Skip if historical bars haven't been processed yet — the Request callback
            // handles all historical bars. OnBarsUpdate during the historical load phase
            // would double-count bars.
            if (!_historicalBarsProcessed) return;

            try
            {
                // Only process bars beyond the last historical index (real-time bars)
                for (int i = e.MinIndex; i <= e.MaxIndex; i++)
                {
                    // Skip bars that were already processed during the historical load
                    if (i <= _lastHistoricalBarIndex) continue;

                    double close = _barsRequest.Bars.GetClose(i);
                    double high  = _barsRequest.Bars.GetHigh(i);
                    double low   = _barsRequest.Bars.GetLow(i);

                    ProcessBar(close, high, low);

                    // Notify TradeTracker with the bar's timestamp so it can advance
                    // _lastKnownTime — critical for Playback mode where execution fills
                    // may stop arriving but bars keep coming, allowing post-exit expiry
                    // checks to fire correctly.
                    DateTime barTime = _barsRequest.Bars.GetTime(i);
                    if (OnPriceUpdate != null)
                        OnPriceUpdate(_instrument.FullName, close, barTime);
                }

                // Check warmup (may transition on real-time bars if historical wasn't enough)
                CheckWarmupStatus();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error processing bar update for {0} — {1}",
                        _instrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Processes a single bar through all indicator engines.
        /// Shared by both the Request callback (historical bars) and OnBarsUpdate (real-time bars).
        /// Updates LastPrice, all indicators, and previous bar tracking state.
        /// </summary>
        /// <param name="close">Bar close price</param>
        /// <param name="high">Bar high price</param>
        /// <param name="low">Bar low price</param>
        private void ProcessBar(double close, double high, double low)
        {
            // Update LastPrice from bar data (fallback for playback where ticks may not fire)
            LastPrice = close;

            // Update each indicator with the new bar's data
            UpdateEMA20(close);
            UpdateEMA200(close);
            UpdateATR(high, low, close);
            UpdateBollinger(close);
            UpdateADX(high, low, close);

            // Store current bar as "previous" for next iteration's True Range and +DM/-DM
            _prevHigh = high;
            _prevLow = low;
            _prevClose = close;
            _hasPrevBar = true;
            _hasPrevClose = true;
        }

        /// <summary>
        /// Checks if all indicators have received enough data to be initialized.
        /// Logs the warmup event with current indicator values once all are ready.
        /// </summary>
        private void CheckWarmupStatus()
        {
            if (!_isWarmedUp && _ema20Initialized && _ema200Initialized
                && _atr14Initialized && _bbInitialized && _adxInitialized
                && _atr14_15sInitialized)
            {
                _isWarmedUp = true;
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Indicators warmed up for {0} — EMA20={1:F2}, EMA200={2:F2}, ATR={3:F2}, ATR15s={4:F4}, ADX={5:F2}",
                        _instrument.FullName, _ema20, _ema200, _atr14, _atr14_15s, _adx),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── EMA(20) Calculation ───────────────────────────────────────────────
        // Seed with SMA of first 20 bars, then apply EMA formula:
        //   ema = close * k + ema_prev * (1 - k)  where k = 2 / (period + 1)

        private void UpdateEMA20(double close)
        {
            if (!_ema20Initialized)
            {
                _ema20Sum += close;
                _ema20Count++;
                if (_ema20Count >= EMA_SHORT_PERIOD)
                {
                    // Seed EMA with SMA of first 20 bars
                    _ema20 = _ema20Sum / EMA_SHORT_PERIOD;
                    _ema20Initialized = true;
                }
            }
            else
            {
                double k = 2.0 / (EMA_SHORT_PERIOD + 1);
                _ema20 = close * k + _ema20 * (1 - k);
            }
        }

        // ─── EMA(200) Calculation ──────────────────────────────────────────────

        private void UpdateEMA200(double close)
        {
            if (!_ema200Initialized)
            {
                _ema200Sum += close;
                _ema200Count++;
                if (_ema200Count >= EMA_LONG_PERIOD)
                {
                    _ema200 = _ema200Sum / EMA_LONG_PERIOD;
                    _ema200Initialized = true;
                }
            }
            else
            {
                double k = 2.0 / (EMA_LONG_PERIOD + 1);
                _ema200 = close * k + _ema200 * (1 - k);
            }
        }

        // ─── ATR(14) Calculation ───────────────────────────────────────────────
        // True Range = max(high - low, |high - prevClose|, |low - prevClose|)
        // Wilder smoothing: atr = (atr_prev * 13 + trueRange) / 14

        private void UpdateATR(double high, double low, double close)
        {
            if (!_hasPrevClose)
                return; // Need at least one prior close for true range

            // Calculate True Range
            double tr = high - low;
            double tr2 = Math.Abs(high - _prevClose);
            double tr3 = Math.Abs(low - _prevClose);
            if (tr2 > tr) tr = tr2;
            if (tr3 > tr) tr = tr3;

            if (!_atr14Initialized)
            {
                // Seed phase: accumulate TRs for initial SMA
                _atrSum += tr;
                _atrCount++;
                if (_atrCount >= ATR_PERIOD)
                {
                    _atr14 = _atrSum / ATR_PERIOD;
                    _atr14Initialized = true;
                }
            }
            else
            {
                // Wilder smoothing
                _atr14 = (_atr14 * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
            }
        }

        // ─── Bollinger Bands(2, 20) Calculation ────────────────────────────────
        // Middle = SMA(20), Upper/Lower = Middle +/- 2 * stddev(20 closes)

        private void UpdateBollinger(double close)
        {
            _bbCloses.Enqueue(close);

            // Keep only the most recent 20 closes
            while (_bbCloses.Count > BB_PERIOD)
                _bbCloses.Dequeue();

            if (_bbCloses.Count >= BB_PERIOD)
            {
                // Calculate SMA (middle band)
                double sum = 0;
                foreach (double c in _bbCloses)
                    sum += c;
                _bbMiddle = sum / BB_PERIOD;

                // Calculate standard deviation
                double sumSqDiff = 0;
                foreach (double c in _bbCloses)
                {
                    double diff = c - _bbMiddle;
                    sumSqDiff += diff * diff;
                }
                double stddev = Math.Sqrt(sumSqDiff / BB_PERIOD);

                // Upper and lower bands
                _bbUpper = _bbMiddle + BB_STD_DEV_MULT * stddev;
                _bbLower = _bbMiddle - BB_STD_DEV_MULT * stddev;
                _bbInitialized = true;
            }
        }

        // ─── ADX(14) Calculation ───────────────────────────────────────────────
        // Multi-step process:
        // 1. Calculate +DM and -DM from consecutive highs/lows
        // 2. Wilder-smooth +DM, -DM, and TR over 14 periods
        // 3. +DI = 100 * smoothed(+DM) / smoothed(TR), same for -DI
        // 4. DX = 100 * |+DI - -DI| / (+DI + -DI)
        // 5. ADX = Wilder smooth of DX over 14 periods

        private void UpdateADX(double high, double low, double close)
        {
            if (!_hasPrevBar)
                return; // Need previous bar for +DM/-DM

            // Step 1: Calculate +DM and -DM
            double upMove = high - _prevHigh;
            double downMove = _prevLow - low;

            double plusDM = 0;
            double minusDM = 0;

            if (upMove > downMove && upMove > 0)
                plusDM = upMove;
            if (downMove > upMove && downMove > 0)
                minusDM = downMove;

            // Calculate True Range for DI normalization
            double tr = high - low;
            double tr2 = Math.Abs(high - _prevClose);
            double tr3 = Math.Abs(low - _prevClose);
            if (tr2 > tr) tr = tr2;
            if (tr3 > tr) tr = tr3;

            if (!_adxDmInitialized)
            {
                // Accumulate first 14 bars for Wilder smoothing seed
                _smoothedPlusDM += plusDM;
                _smoothedMinusDM += minusDM;
                _smoothedTR += tr;
                _adxDxCount++;

                if (_adxDxCount >= ADX_PERIOD)
                {
                    _adxDmInitialized = true;
                    _adxDxCount = 0;
                    _adxDxSum = 0;
                }
            }
            else if (!_adxInitialized)
            {
                // Wilder smooth +DM, -DM, TR
                _smoothedPlusDM = _smoothedPlusDM - (_smoothedPlusDM / ADX_PERIOD) + plusDM;
                _smoothedMinusDM = _smoothedMinusDM - (_smoothedMinusDM / ADX_PERIOD) + minusDM;
                _smoothedTR = _smoothedTR - (_smoothedTR / ADX_PERIOD) + tr;

                // Calculate DI values
                double plusDI = (_smoothedTR > 0) ? 100.0 * _smoothedPlusDM / _smoothedTR : 0;
                double minusDI = (_smoothedTR > 0) ? 100.0 * _smoothedMinusDM / _smoothedTR : 0;

                // Calculate DX
                double diSum = plusDI + minusDI;
                double dx = (diSum > 0) ? 100.0 * Math.Abs(plusDI - minusDI) / diSum : 0;

                // Accumulate DX values for ADX seed
                _adxDxSum += dx;
                _adxDxCount++;

                if (_adxDxCount >= ADX_PERIOD)
                {
                    // Seed ADX with average of first 14 DX values
                    _adx = _adxDxSum / ADX_PERIOD;
                    _adxInitialized = true;
                }
            }
            else
            {
                // Wilder smooth +DM, -DM, TR
                _smoothedPlusDM = _smoothedPlusDM - (_smoothedPlusDM / ADX_PERIOD) + plusDM;
                _smoothedMinusDM = _smoothedMinusDM - (_smoothedMinusDM / ADX_PERIOD) + minusDM;
                _smoothedTR = _smoothedTR - (_smoothedTR / ADX_PERIOD) + tr;

                // DI and DX
                double plusDI = (_smoothedTR > 0) ? 100.0 * _smoothedPlusDM / _smoothedTR : 0;
                double minusDI = (_smoothedTR > 0) ? 100.0 * _smoothedMinusDM / _smoothedTR : 0;
                double diSum = plusDI + minusDI;
                double dx = (diSum > 0) ? 100.0 * Math.Abs(plusDI - minusDI) / diSum : 0;

                // Wilder smooth ADX
                _adx = (_adx * (ADX_PERIOD - 1) + dx) / ADX_PERIOD;
            }
        }

        /// <summary>
        /// Captures a snapshot of the current market context.
        /// Called by TradeTracker at trade entry time to freeze indicator state.
        ///
        /// Returns a MarketContext with all indicator values and derived classifications:
        /// - Price position vs EMAs (above/below + ATR-normalized distance)
        /// - Bollinger position (inside/above_upper/below_lower)
        /// - Market regime (trending if ADX >= 25, consolidating otherwise)
        /// - Raw indicator values (ATR, ADX, Bollinger bandwidth)
        ///
        /// If indicators haven't warmed up yet, returns a context with zero/empty values
        /// and logs a warning.
        /// </summary>
        /// <returns>MarketContext snapshot frozen at the current moment</returns>
        public MarketContext GetContextSnapshot()
        {
            var ctx = new MarketContext();

            if (!_isWarmedUp)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Context snapshot requested but indicators not warmed up for {0}",
                        _instrument.FullName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return ctx;
            }

            double price = LastPrice;

            // ATR — 5-min and 15-second timeframes
            ctx.Atr14 = _atr14;
            ctx.Atr14_15s = _atr14_15s;

            // Price vs EMA(20) — short-term trend bias
            ctx.PriceVsEMA20 = price >= _ema20 ? "above" : "below";
            ctx.DistanceFromEMA20_ATR = _atr14 > 0 ? Math.Abs(price - _ema20) / _atr14 : 0;

            // Price vs EMA(200) — long-term trend bias
            ctx.PriceVsEMA200 = price >= _ema200 ? "above" : "below";
            ctx.DistanceFromEMA200_ATR = _atr14 > 0 ? Math.Abs(price - _ema200) / _atr14 : 0;

            // Bollinger Band position — where price sits relative to the bands
            if (price > _bbUpper)
                ctx.BollingerPosition = "above_upper";
            else if (price < _bbLower)
                ctx.BollingerPosition = "below_lower";
            else
                ctx.BollingerPosition = "inside";

            // Bollinger Bandwidth — normalized volatility spread
            ctx.BollingerBandwidth = _bbMiddle > 0 ? (_bbUpper - _bbLower) / _bbMiddle : 0;

            // ADX and market regime classification
            ctx.Adx14 = _adx;
            ctx.MarketRegime = _adx >= 25.0 ? "trending" : "consolidating";

            return ctx;
        }

        /// <summary>
        /// Cleans up BarsRequest and market data subscriptions.
        /// Called when the AddOn terminates or the instrument is no longer actively traded.
        ///
        /// Each unsubscription is wrapped in its own try/catch because ANY of these can
        /// throw NullReferenceException if the underlying object's internal state is null
        /// (e.g., after a failed BarsRequest, or during Strategy Analyzer teardown).
        /// Previous bug: only _barsRequest.Dispose() was protected, but the NullRef was
        /// actually coming from the event unsubscriptions above it.
        /// </summary>
        public void Dispose()
        {
            if (_isDisposed) return;
            _isDisposed = true;

            // Unsubscribe from tick data — can throw if _instrument internals are null
            try { if (_instrument != null) _instrument.MarketDataUpdate -= OnMarketDataUpdate; }
            catch { /* Safe to ignore — tagger is being disposed anyway */ }

            // Unsubscribe from bar updates — can throw if _barsRequest internals are null
            try { if (_barsRequest != null) _barsRequest.Update -= OnBarsUpdate; }
            catch { /* Safe to ignore — tagger is being disposed anyway */ }

            // Dispose the 5-min BarsRequest (stops real-time bar updates)
            // Can throw NullReferenceException if internal bars reference is null
            try { if (_barsRequest != null) _barsRequest.Dispose(); }
            catch { /* Safe to ignore — BarsRequest internal state was null */ }

            // Unsubscribe and dispose 15s BarsRequest — same pattern as 5-min
            try { if (_barsRequest15s != null) _barsRequest15s.Update -= OnBarsUpdate15s; }
            catch { /* Safe to ignore — tagger is being disposed anyway */ }

            try { if (_barsRequest15s != null) _barsRequest15s.Dispose(); }
            catch { /* Safe to ignore — BarsRequest internal state was null */ }

            _barsRequest = null;
            _barsRequest15s = null;
        }
    }
}
