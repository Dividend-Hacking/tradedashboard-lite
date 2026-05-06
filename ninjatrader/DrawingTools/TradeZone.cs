#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript.AddOns;
using SharpDX;
using SharpDX.Direct2D1;
#endregion

namespace NinjaTrader.NinjaScript.DrawingTools
{
    /// <summary>
    /// TradeZone — A custom drawing tool for marking hypothetical trade entry-to-exit zones
    /// on a chart. The user draws a rectangle from where they would enter to where they would
    /// exit a trade. On completion (second click), the tool:
    ///   1. Captures all 15-second bar data (OHLCV) within the zone's time range via BarsRequest
    ///   2. Computes per-bar MFE/MAE from the entry price
    ///   3. POSTs the zone metadata + bar data to Supabase for later analysis
    ///
    /// Visual:
    /// - Long zones (entry below exit): semi-transparent green fill, green border
    /// - Short zones (entry above exit): semi-transparent red fill, red border
    /// - Text label at top-left shows direction and point delta
    ///
    /// Drawing interaction: click-click style (same as NT8's built-in Rectangle tool)
    ///   - First click sets the entry anchor (start time/price)
    ///   - Mouse move stretches the rectangle live
    ///   - Second click sets the exit anchor (end time/price) and triggers save
    /// </summary>
    public abstract class TradeZone : DrawingTool
    {
        // ─── Direction (set by subclass) ─────────────────────────────────────────
        // Subclasses (TradeZoneLong / TradeZoneShort) hardcode this so the user
        // explicitly declares intent. Points are calculated relative to direction:
        //   Long:  profit = lastClose - firstOpen  (price going up is good)
        //   Short: profit = firstOpen - lastClose  (price going down is good)
        protected abstract string ZoneDirection { get; }
        // ─── Anchors ─────────────────────────────────────────────────────────────
        // Two corners of the rectangle: where the user clicks first (entry) and second (exit).

        [Display(Order = 1)]
        public ChartAnchor StartAnchor { get; set; }

        [Display(Order = 2)]
        public ChartAnchor EndAnchor { get; set; }

        // ─── User Properties ─────────────────────────────────────────────────────
        // Exposed in the drawing tool's properties panel for post-placement editing.

        /// <summary>
        /// Free-text notes for the zone. Editable in properties panel after placement.
        /// Saved to Supabase for annotation/filtering during analysis.
        /// </summary>
        [Display(Name = "Notes", Description = "Free-text notes for this trade zone", Order = 3, GroupName = "TradeZone")]
        public string Notes { get; set; }

        /// <summary>
        /// Fill opacity percentage (0-100). Controls how transparent the zone rectangle is.
        /// Default 15 provides subtle visual without obscuring price action.
        /// </summary>
        [Display(Name = "Opacity", Description = "Fill opacity (0-100)", Order = 4, GroupName = "TradeZone")]
        [Range(0, 100)]
        public int FillOpacity { get; set; }

        /// <summary>
        /// When > 0, a single click places the zone and the exit is automatically set
        /// this many bars forward from the entry click. When 0, the tool uses the normal
        /// two-click mode (click entry, click exit). Configurable in the properties panel.
        /// </summary>
        [Display(Name = "Bar Duration", Description = "Auto-set zone width in bars (0 = two-click mode)", Order = 5, GroupName = "TradeZone")]
        [Range(0, 1000)]
        public int BarDuration { get; set; }

        // ─── SharpDX Render Resources ────────────────────────────────────────────
        // Created in OnRenderTargetChanged, disposed there too. Must not be created per-frame.

        private SharpDX.Direct2D1.Brush _longFillBrush;
        private SharpDX.Direct2D1.Brush _shortFillBrush;
        private SharpDX.Direct2D1.Brush _longBorderBrush;
        private SharpDX.Direct2D1.Brush _shortBorderBrush;
        private SharpDX.Direct2D1.Brush _textBrush;
        private SharpDX.DirectWrite.TextFormat _textFormat;

        // ─── Save State ──────────────────────────────────────────────────────────
        // Prevents duplicate saves if the user edits anchors after initial placement.

        private bool _hasSaved;

        // ─── Static computed data store ──────────────────────────────────────────
        // NT8 may clone/recreate DrawingTool instances after placement, so instance
        // fields set in the BarsRequest callback would be lost on the render instance.
        // A static dictionary keyed by time range survives across all instances.

        private struct ZoneComputedData
        {
            public double StartPrice;
            public double EndPrice;
            public string Direction;
            public double PointsMove;
        }

        private static readonly ConcurrentDictionary<string, ZoneComputedData> _zoneData
            = new ConcurrentDictionary<string, ZoneComputedData>();

        /// <summary>
        /// Builds a consistent lookup key from the two anchor times.
        /// Uses the chronologically-sorted times so drawing direction doesn't matter.
        /// </summary>
        private string GetZoneKey()
        {
            var t1 = StartAnchor.Time < EndAnchor.Time ? StartAnchor.Time : EndAnchor.Time;
            var t2 = StartAnchor.Time > EndAnchor.Time ? StartAnchor.Time : EndAnchor.Time;
            return string.Format("{0:yyyyMMddHHmmss}_{1:yyyyMMddHHmmss}", t1, t2);
        }

        // ─── Overrides ───────────────────────────────────────────────────────────

        /// <summary>
        /// Returns both anchors so NT8 can manage their lifecycle, serialization,
        /// and coordinate transforms (time/price ↔ pixel).
        /// </summary>
        public override IEnumerable<ChartAnchor> Anchors
        {
            get { return new[] { StartAnchor, EndAnchor }; }
        }

        /// <summary>
        /// Display name shown in the Drawing Tools menu and properties panel.
        /// </summary>
        public override string DisplayName
        {
            get { return "TradeZone"; }
        }

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                // Basic drawing tool metadata
                Name            = "TradeZone";
                Description     = "Draw entry-to-exit trade zones for analysis";

                // Initialize anchors — IsEditing = true means "waiting to be placed"
                // This is the standard NT8 Rectangle pattern for two-anchor drawing tools
                StartAnchor     = new ChartAnchor();
                StartAnchor.IsEditing = true;
                EndAnchor       = new ChartAnchor();
                EndAnchor.IsEditing   = true;

                // Default property values
                Notes           = "";
                FillOpacity     = 15;
                BarDuration     = 0;  // 0 = two-click mode, >0 = single-click auto-width
                _hasSaved       = false;
            }
            else if (State == State.Terminated)
            {
                // Clean up SharpDX resources if they exist
                DisposeRenderResources();
            }
        }

        // ─── Mouse Interaction ───────────────────────────────────────────────────
        // Mirrors NT8's built-in Rectangle tool: click to set first corner, move to
        // stretch the rectangle, click again to set second corner and finalize.
        // Uses the IsEditing flag on each anchor to track which corner is being placed.

        public override Cursor GetCursor(ChartControl chartControl, ChartPanel chartPanel, ChartScale chartScale, System.Windows.Point point)
        {
            if (DrawingState == DrawingState.Building)
                return System.Windows.Input.Cursors.Cross;

            if (DrawingState == DrawingState.Normal && IsPointInsideZone(chartControl, chartPanel, chartScale, point))
                return System.Windows.Input.Cursors.SizeAll;

            return null;
        }

        public override void OnMouseDown(ChartControl chartControl, ChartPanel chartPanel, ChartScale chartScale, ChartAnchor dataPoint)
        {
            if (DrawingState == DrawingState.Building)
            {
                if (dataPoint == null) return;

                if (StartAnchor.IsEditing)
                {
                    // First click — place the entry corner
                    dataPoint.CopyDataValues(StartAnchor);
                    StartAnchor.IsEditing = false;

                    if (BarDuration > 0)
                    {
                        // Single-click mode: auto-set EndAnchor N bars forward from the click
                        // Use GetSlotIndexByTime to find the bar slot, add BarDuration, convert back to time
                        dataPoint.CopyDataValues(EndAnchor);
                        try
                        {
                            int startSlot = (int)chartControl.GetSlotIndexByTime(dataPoint.Time);
                            int endSlot = startSlot + BarDuration;
                            DateTime endTime = chartControl.GetTimeBySlotIndex(endSlot);
                            EndAnchor.Time = endTime;
                        }
                        catch
                        {
                            // Fallback: estimate end time from bar duration (15s per bar)
                            EndAnchor.Time = dataPoint.Time.AddSeconds(BarDuration * 15);
                        }

                        // Finalize immediately — no second click needed
                        EndAnchor.IsEditing = false;
                        DrawingState = DrawingState.Normal;
                        IsSelected = false;
                        TriggerSave(chartControl);
                    }
                    else
                    {
                        // Two-click mode: seed EndAnchor, wait for second click
                        dataPoint.CopyDataValues(EndAnchor);
                        EndAnchor.IsEditing = true;
                    }
                }
                else if (EndAnchor.IsEditing)
                {
                    // Second click (two-click mode only) — place the exit corner
                    dataPoint.CopyDataValues(EndAnchor);
                    EndAnchor.IsEditing = false;
                    DrawingState = DrawingState.Normal;
                    IsSelected = false;

                    // Trigger data capture and Supabase save
                    TriggerSave(chartControl);
                }
            }
        }

        public override void OnMouseMove(ChartControl chartControl, ChartPanel chartPanel, ChartScale chartScale, ChartAnchor dataPoint)
        {
            // While placing the second anchor, only update the TIME (horizontal stretch).
            // The price is set only on the actual click — since the box is full-height,
            // we don't want cursor Y position changing the recorded entry/exit prices.
            if (DrawingState == DrawingState.Building && EndAnchor.IsEditing)
            {
                if (dataPoint != null)
                    EndAnchor.Time = dataPoint.Time;
            }
        }

        public override void OnMouseUp(ChartControl chartControl, ChartPanel chartPanel, ChartScale chartScale, ChartAnchor dataPoint)
        {
            // Not used — click-click style, both corners set in OnMouseDown
        }

        // ─── Hit Testing ─────────────────────────────────────────────────────────

        public override bool IsVisibleOnChart(ChartControl chartControl, ChartScale chartScale, DateTime firstTimeOnChart, DateTime lastTimeOnChart)
        {
            // Visible if either anchor's time falls within the visible chart range
            if (StartAnchor.Time >= firstTimeOnChart && StartAnchor.Time <= lastTimeOnChart)
                return true;
            if (EndAnchor.Time >= firstTimeOnChart && EndAnchor.Time <= lastTimeOnChart)
                return true;
            // Also visible if the zone spans the entire visible range
            DateTime earlyTime = StartAnchor.Time < EndAnchor.Time ? StartAnchor.Time : EndAnchor.Time;
            DateTime lateTime  = StartAnchor.Time > EndAnchor.Time ? StartAnchor.Time : EndAnchor.Time;
            if (earlyTime <= firstTimeOnChart && lateTime >= lastTimeOnChart)
                return true;
            return false;
        }

        public override void OnCalculateMinMax()
        {
            // Tell the chart the price range this drawing occupies so auto-scale works
            double minPrice = Math.Min(StartAnchor.Price, EndAnchor.Price);
            double maxPrice = Math.Max(StartAnchor.Price, EndAnchor.Price);
            MinValue = minPrice;
            MaxValue = maxPrice;
        }

        /// <summary>
        /// Checks if a screen-space point is inside the zone rectangle.
        /// Used for hit testing (cursor changes, selection, dragging).
        /// </summary>
        private bool IsPointInsideZone(ChartControl chartControl, ChartPanel chartPanel, ChartScale chartScale, System.Windows.Point point)
        {
            if (chartControl == null || chartScale == null) return false;

            // Hit test uses full panel height (same as OnRender)
            float x1 = (float)chartControl.GetXByTime(StartAnchor.Time);
            float x2 = (float)chartControl.GetXByTime(EndAnchor.Time);

            float left   = Math.Min(x1, x2);
            float right  = Math.Max(x1, x2);

            return point.X >= left && point.X <= right;
        }

        // ─── Rendering (SharpDX / Direct2D) ─────────────────────────────────────

        public override void OnRenderTargetChanged()
        {
            // Dispose old resources before creating new ones (target may have changed)
            DisposeRenderResources();

            if (RenderTarget == null) return;

            // Compute opacity byte from percentage (0-100 → 0-255)
            byte alpha = (byte)(FillOpacity * 255 / 100);

            // Long zone: green fill + green border
            _longFillBrush   = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget, new SharpDX.Color((byte)0, (byte)180, (byte)80, alpha));
            _longBorderBrush = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget, new SharpDX.Color((byte)0, (byte)180, (byte)80, (byte)200));

            // Short zone: red fill + red border
            _shortFillBrush   = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget, new SharpDX.Color((byte)220, (byte)50, (byte)50, alpha));
            _shortBorderBrush = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget, new SharpDX.Color((byte)220, (byte)50, (byte)50, (byte)200));

            // White text for the direction label
            _textBrush = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget, new SharpDX.Color((byte)255, (byte)255, (byte)255, (byte)220));

            // Text format for the label — small, readable
            _textFormat = new SharpDX.DirectWrite.TextFormat(
                NinjaTrader.Core.Globals.DirectWriteFactory,
                "Arial", 12f);
        }

        public override void OnRender(ChartControl chartControl, ChartScale chartScale)
        {
            if (chartControl == null || chartScale == null || RenderTarget == null) return;

            // Convert anchor times to pixel X coordinates
            float x1 = (float)chartControl.GetXByTime(StartAnchor.Time);
            float x2 = (float)chartControl.GetXByTime(EndAnchor.Time);

            // Stretch the box to the full height of the chart panel (top to bottom of price scale)
            // This makes it behave like the volume profile box — a time-range highlight
            // that spans the entire visible price range.
            float left   = Math.Min(x1, x2);
            float right  = Math.Max(x1, x2);
            float top    = 0;
            float bottom = ChartPanel.H;

            var rect = new SharpDX.RectangleF(left, top, right - left, bottom - top);

            // Look up computed bar data from the static dictionary (survives instance recreation)
            ZoneComputedData computed;
            bool hasData = _zoneData.TryGetValue(GetZoneKey(), out computed);

            // Direction comes from the subclass (Long or Short), not from price movement
            bool isLong = ZoneDirection == "Long";

            var fillBrush   = isLong ? _longFillBrush : _shortFillBrush;
            var borderBrush = isLong ? _longBorderBrush : _shortBorderBrush;

            if (fillBrush == null || borderBrush == null) return;

            // Draw filled rectangle
            RenderTarget.FillRectangle(rect, fillBrush);

            // Draw border (2px)
            RenderTarget.DrawRectangle(rect, borderBrush, 2f);

            // Draw label — shows direction + points from actual bar data
            if (_textBrush != null && _textFormat != null)
            {
                string label;
                if (hasData)
                {
                    label = string.Format("{0}  {1:+0.00;-0.00} pts  ({2:F2} → {3:F2})",
                        computed.Direction, computed.PointsMove,
                        computed.StartPrice, computed.EndPrice);
                }
                else
                {
                    label = "Loading...";
                }

                var textRect = new SharpDX.RectangleF(left + 4, top + 2, right - left - 8, 20);
                RenderTarget.DrawText(label, _textFormat, textRect, _textBrush);
            }
        }

        /// <summary>
        /// Safely disposes all SharpDX render resources.
        /// Called from OnRenderTargetChanged (before re-creation) and OnStateChange(Terminated).
        /// </summary>
        private void DisposeRenderResources()
        {
            if (_longFillBrush != null)   { _longFillBrush.Dispose();   _longFillBrush = null; }
            if (_shortFillBrush != null)  { _shortFillBrush.Dispose();  _shortFillBrush = null; }
            if (_longBorderBrush != null) { _longBorderBrush.Dispose(); _longBorderBrush = null; }
            if (_shortBorderBrush != null){ _shortBorderBrush.Dispose(); _shortBorderBrush = null; }
            if (_textBrush != null)       { _textBrush.Dispose();       _textBrush = null; }
            if (_textFormat != null)      { _textFormat.Dispose();      _textFormat = null; }
        }

        // ─── Data Capture & Supabase Save ────────────────────────────────────────

        /// <summary>
        /// Triggers bar data capture and Supabase upload when the zone drawing is completed.
        /// Called from OnMouseDown when the second anchor is placed.
        ///
        /// Thread safety: all ChartControl/WPF values are cached into local variables
        /// on the UI thread before the async BarsRequest fires its callback on a background
        /// thread. This follows the same pattern as RiskManagerLink.cs for cross-thread safety.
        /// </summary>
        private void TriggerSave(ChartControl chartControl)
        {
            if (_hasSaved) return;
            _hasSaved = true;

            // ── Cache all WPF/chart values on the UI thread before going async ──
            // ChartControl.Instrument is a WPF DependencyObject — can't access from background threads
            Instrument instrument = chartControl.Instrument;
            string instrumentName = instrument.FullName;

            // Normalize time order (user might draw right-to-left)
            DateTime startTime = StartAnchor.Time < EndAnchor.Time ? StartAnchor.Time : EndAnchor.Time;
            DateTime endTime   = StartAnchor.Time > EndAnchor.Time ? StartAnchor.Time : EndAnchor.Time;

            // Capture chart timeframe string for metadata
            string chartTimeframe = "15 Second";

            string notes = Notes;

            NinjaTrader.Code.Output.Process(
                string.Format("TradeZone: Capturing 15s bars for {0} zone on {1} ({2:yyyy-MM-dd HH:mm:ss} → {3:yyyy-MM-dd HH:mm:ss})",
                    ZoneDirection, instrumentName, startTime, endTime),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            // ── Issue BarsRequest for 15-second bars ──────────────────────────────
            // Request extra bars BEFORE the zone for indicator warmup:
            //   EMA(200) needs 200 bars, ADX(14) needs ~42 bars, ATR(14) needs 14 bars.
            //   At 15s bars, 300 bars = 75 minutes of lookback — plenty for warmup.
            // Request from (startTime - 90 min) to (endTime + 5 min).
            //
            // NOTE: Do NOT set TradingHours on the BarsRequest. DrawingTools can't access
            // the chart's Bars.TradingHours (CS0120), and MasterInstrument.TradingHours
            // may return a template with a different session range. The default works for
            // the vast majority of zones. If the 90-minute lookback crosses a session break
            // and lands in the wrong session, the fallback retry (requestFrom = startTime)
            // handles it by anchoring to the zone's own session.

            // Cache direction and zone key on UI thread before going async
            string zoneDirection = ZoneDirection;
            string zoneKey = GetZoneKey();

            DateTime requestFrom = startTime.AddMinutes(-90); // 300+ bars of lookback for indicator warmup
            DateTime requestTo   = endTime.AddMinutes(5);

            try
            {
                var barsRequest = new BarsRequest(instrument, requestFrom, requestTo);
                barsRequest.BarsPeriod = new BarsPeriod
                {
                    BarsPeriodType = BarsPeriodType.Second,
                    Value = 15
                };

                barsRequest.Request(new Action<BarsRequest, ErrorCode, string>((req, errorCode, errorMessage) =>
                {
                    try
                    {
                        if (errorCode != ErrorCode.NoError)
                        {
                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeZone: BarsRequest error — {0}: {1}", errorCode, errorMessage),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                            req.Dispose();
                            return;
                        }

                        int totalBars = req.Bars.Count;

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: BarsRequest returned {0} bars for {1:MM/dd HH:mm}–{2:MM/dd HH:mm}",
                                totalBars, startTime, endTime),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                        // Log first/last bar times vs zone range to diagnose timezone mismatches
                        if (totalBars > 0)
                        {
                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeZone: Bar range {0:MM/dd HH:mm:ss}→{1:MM/dd HH:mm:ss} vs zone {2:MM/dd HH:mm:ss}→{3:MM/dd HH:mm:ss}",
                                    req.Bars.GetTime(0), req.Bars.GetTime(totalBars - 1), startTime, endTime),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }

                        if (totalBars == 0)
                        {
                            NinjaTrader.Code.Output.Process("TradeZone: No bars returned — zone not saved",
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                            req.Dispose();
                            return;
                        }

                        // ═══════════════════════════════════════════════════════════════
                        // PHASE A: Process ALL bars (warmup + zone) to compute indicators.
                        // Bars before startTime are used for indicator warmup only.
                        // Bars within [startTime, endTime] are the zone bars we'll save.
                        // ═══════════════════════════════════════════════════════════════

                        // ── Indicator state (same math as MarketContextTagger.cs) ──
                        // EMA(20)
                        double ema20 = 0; bool ema20Init = false; double ema20Sum = 0; int ema20Count = 0;
                        double ema20K = 2.0 / (20 + 1);
                        // EMA(200)
                        double ema200 = 0; bool ema200Init = false; double ema200Sum = 0; int ema200Count = 0;
                        double ema200K = 2.0 / (200 + 1);
                        // ATR(14) Wilder
                        double atr14 = 0; bool atr14Init = false; double atrSum = 0; int atrCount = 0;
                        double prevClose2 = 0; bool hasPrevClose = false;
                        // ADX(14) — three-phase
                        double smoothPlusDM = 0, smoothMinusDM = 0, smoothTR = 0;
                        double adx = 0, adxDxSum = 0; int adxDxCount = 0;
                        bool adxDmInit = false, adxInit = false;
                        double prevHigh2 = 0, prevLow2 = 0; bool hasPrevBar = false;
                        double plusDmSum = 0, minusDmSum = 0, trSumAdx = 0; int dmCount = 0;
                        // Bollinger(20, 2)
                        var bbCloses = new System.Collections.Generic.Queue<double>();
                        double bbUpper = 0, bbMiddle = 0, bbLower = 0; bool bbInit = false;

                        // ── Zone bar collection ──
                        var bars = new List<TradeZoneWriter.ZoneBarData>();
                        double firstClose = 0;
                        double lastClose = 0;
                        int barIndex = 0;

                        // ── Context snapshot (captured at the entry bar) ──
                        var ctx = new TradeZoneWriter.ZoneContext();
                        bool ctxCaptured = false;

                        for (int i = 0; i < totalBars; i++)
                        {
                            DateTime barTime = req.Bars.GetTime(i);
                            double open  = req.Bars.GetOpen(i);
                            double high  = req.Bars.GetHigh(i);
                            double low   = req.Bars.GetLow(i);
                            double close = req.Bars.GetClose(i);
                            long volume  = req.Bars.GetVolume(i);

                            // ── Update EMA(20) ──
                            if (!ema20Init) { ema20Sum += close; ema20Count++; if (ema20Count >= 20) { ema20 = ema20Sum / 20; ema20Init = true; } }
                            else { ema20 = close * ema20K + ema20 * (1 - ema20K); }

                            // ── Update EMA(200) ──
                            if (!ema200Init) { ema200Sum += close; ema200Count++; if (ema200Count >= 200) { ema200 = ema200Sum / 200; ema200Init = true; } }
                            else { ema200 = close * ema200K + ema200 * (1 - ema200K); }

                            // ── Update ATR(14) ──
                            if (hasPrevClose)
                            {
                                double tr = Math.Max(high - low, Math.Max(Math.Abs(high - prevClose2), Math.Abs(low - prevClose2)));
                                if (!atr14Init) { atrSum += tr; atrCount++; if (atrCount >= 14) { atr14 = atrSum / 14; atr14Init = true; } }
                                else { atr14 = (atr14 * 13 + tr) / 14; }
                            }

                            // ── Update ADX(14) ──
                            if (hasPrevBar)
                            {
                                double upMove = high - prevHigh2;
                                double downMove = prevLow2 - low;
                                double plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
                                double minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
                                double tr2 = Math.Max(high - low, Math.Max(Math.Abs(high - prevClose2), Math.Abs(low - prevClose2)));

                                if (!adxDmInit)
                                {
                                    plusDmSum += plusDM; minusDmSum += minusDM; trSumAdx += tr2; dmCount++;
                                    if (dmCount >= 14) { smoothPlusDM = plusDmSum; smoothMinusDM = minusDmSum; smoothTR = trSumAdx; adxDmInit = true; }
                                }
                                else
                                {
                                    smoothPlusDM = smoothPlusDM - (smoothPlusDM / 14) + plusDM;
                                    smoothMinusDM = smoothMinusDM - (smoothMinusDM / 14) + minusDM;
                                    smoothTR = smoothTR - (smoothTR / 14) + tr2;

                                    double plusDI = smoothTR > 0 ? 100 * smoothPlusDM / smoothTR : 0;
                                    double minusDI = smoothTR > 0 ? 100 * smoothMinusDM / smoothTR : 0;
                                    double diSum = plusDI + minusDI;
                                    double dx = diSum > 0 ? 100 * Math.Abs(plusDI - minusDI) / diSum : 0;

                                    if (!adxInit) { adxDxSum += dx; adxDxCount++; if (adxDxCount >= 14) { adx = adxDxSum / 14; adxInit = true; } }
                                    else { adx = (adx * 13 + dx) / 14; }
                                }
                            }

                            // ── Update Bollinger(20, 2) ──
                            bbCloses.Enqueue(close);
                            if (bbCloses.Count > 20) bbCloses.Dequeue();
                            if (bbCloses.Count >= 20)
                            {
                                double sum = 0, sum2 = 0;
                                foreach (double c in bbCloses) { sum += c; }
                                bbMiddle = sum / 20;
                                foreach (double c in bbCloses) { double diff = c - bbMiddle; sum2 += diff * diff; }
                                double stddev = Math.Sqrt(sum2 / 20);
                                bbUpper = bbMiddle + 2.0 * stddev;
                                bbLower = bbMiddle - 2.0 * stddev;
                                bbInit = true;
                            }

                            // ── Save prev bar state for next iteration ──
                            prevClose2 = close; hasPrevClose = true;
                            prevHigh2 = high; prevLow2 = low; hasPrevBar = true;

                            // ── Skip bars before the zone (warmup only) ──
                            if (barTime < startTime) continue;
                            // Stop after the zone ends
                            if (barTime > endTime) break;

                            // ── Capture context snapshot at the first zone bar ──
                            if (!ctxCaptured)
                            {
                                ctxCaptured = true;
                                ctx.Atr14 = atr14Init ? atr14 : 0;
                                ctx.Adx14 = adxInit ? adx : 0;
                                ctx.Ema20 = ema20Init ? ema20 : 0;
                                ctx.Ema200 = ema200Init ? ema200 : 0;
                                ctx.PriceVsEma20 = ema20Init ? (close >= ema20 ? "above" : "below") : "";
                                ctx.PriceVsEma200 = ema200Init ? (close >= ema200 ? "above" : "below") : "";
                                ctx.DistEma20Atr = (ema20Init && atr14Init && atr14 > 0) ? Math.Abs(close - ema20) / atr14 : 0;
                                ctx.BollingerPos = bbInit ? (close > bbUpper ? "above_upper" : close < bbLower ? "below_lower" : "inside") : "";
                                ctx.BollingerBw = (bbInit && bbMiddle > 0) ? (bbUpper - bbLower) / bbMiddle : 0;
                                ctx.EntryHour = barTime.Hour;
                                ctx.EntryDayOfWeek = (int)barTime.DayOfWeek;
                            }

                            // Track first bar's close and last bar's close for price derivation
                            if (barIndex == 0) firstClose = close;
                            lastClose = close;

                            bars.Add(new TradeZoneWriter.ZoneBarData
                            {
                                Time         = barTime,
                                Open         = open,
                                High         = high,
                                Low          = low,
                                Close        = close,
                                Volume       = volume,
                                BarIndex     = barIndex,
                                MfeFromStart = 0,
                                MaeFromStart = 0,
                                DrawdownFromEntry = 0,
                                RunupFromEntry    = 0,
                                CloseVsEntry      = 0,
                                HighSinceEntry    = 0,
                                RetraceFromPeak   = 0
                            });

                            barIndex++;
                        }

                        if (bars.Count == 0)
                        {
                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeZone: No bars matched zone time range {0:MM/dd HH:mm:ss}–{1:MM/dd HH:mm:ss} — retrying without lookback",
                                    startTime, endTime),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                            req.Dispose();

                            // ── Fallback: retry with requestFrom = startTime ──────────────
                            // The 90-minute warmup lookback may have crossed a session break,
                            // causing the BarsRequest to anchor to the previous session.
                            // Retrying with requestFrom = startTime ensures we're in the
                            // same session as the zone. No indicator warmup, but bars are captured.
                            try
                            {
                                var retryRequest = new BarsRequest(instrument, startTime, endTime.AddMinutes(5));
                                retryRequest.BarsPeriod = new BarsPeriod
                                {
                                    BarsPeriodType = BarsPeriodType.Second,
                                    Value = 15
                                };

                                retryRequest.Request(new Action<BarsRequest, ErrorCode, string>((req2, errorCode2, errorMessage2) =>
                                {
                                    try
                                    {
                                        if (errorCode2 != ErrorCode.NoError)
                                        {
                                            NinjaTrader.Code.Output.Process(
                                                string.Format("TradeZone: Retry BarsRequest error — {0}: {1}", errorCode2, errorMessage2),
                                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                                            req2.Dispose();
                                            return;
                                        }

                                        int retryTotalBars = req2.Bars.Count;

                                        NinjaTrader.Code.Output.Process(
                                            string.Format("TradeZone: Retry returned {0} bars", retryTotalBars),
                                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                                        if (retryTotalBars > 0)
                                        {
                                            NinjaTrader.Code.Output.Process(
                                                string.Format("TradeZone: Retry bar range {0:MM/dd HH:mm:ss}→{1:MM/dd HH:mm:ss}",
                                                    req2.Bars.GetTime(0), req2.Bars.GetTime(retryTotalBars - 1)),
                                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                                        }

                                        // Collect zone bars (no warmup / no indicator context)
                                        var retryBars = new List<TradeZoneWriter.ZoneBarData>();
                                        double retryFirstClose = 0, retryLastClose = 0;
                                        int retryBarIndex = 0;
                                        var retryCtx = new TradeZoneWriter.ZoneContext();

                                        for (int i = 0; i < retryTotalBars; i++)
                                        {
                                            DateTime bt = req2.Bars.GetTime(i);
                                            if (bt < startTime) continue;
                                            if (bt > endTime) break;

                                            double o = req2.Bars.GetOpen(i);
                                            double h = req2.Bars.GetHigh(i);
                                            double l = req2.Bars.GetLow(i);
                                            double c = req2.Bars.GetClose(i);
                                            long v   = req2.Bars.GetVolume(i);

                                            if (retryBarIndex == 0)
                                            {
                                                retryFirstClose = c;
                                                retryCtx.EntryHour = bt.Hour;
                                                retryCtx.EntryDayOfWeek = (int)bt.DayOfWeek;
                                            }
                                            retryLastClose = c;

                                            retryBars.Add(new TradeZoneWriter.ZoneBarData
                                            {
                                                Time = bt, Open = o, High = h, Low = l, Close = c,
                                                Volume = v, BarIndex = retryBarIndex,
                                                MfeFromStart = 0, MaeFromStart = 0,
                                                DrawdownFromEntry = 0, RunupFromEntry = 0,
                                                CloseVsEntry = 0, HighSinceEntry = 0, RetraceFromPeak = 0
                                            });
                                            retryBarIndex++;
                                        }

                                        if (retryBars.Count == 0)
                                        {
                                            NinjaTrader.Code.Output.Process(
                                                string.Format("TradeZone: Retry also found no bars — zone not saved"),
                                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                                            req2.Dispose();
                                            return;
                                        }

                                        // Compute basic price data and excursion (same as primary path)
                                        double retryStartPrice = retryFirstClose;
                                        double retryEndPrice = retryLastClose;
                                        bool retryIsLong = zoneDirection == "Long";
                                        double retryPointsMove = retryIsLong
                                            ? (retryEndPrice - retryStartPrice)
                                            : (retryStartPrice - retryEndPrice);

                                        _zoneData[zoneKey] = new ZoneComputedData
                                        {
                                            StartPrice = retryStartPrice,
                                            EndPrice = retryEndPrice,
                                            Direction = zoneDirection,
                                            PointsMove = retryPointsMove
                                        };

                                        // Per-bar MFE/MAE
                                        double rMfe = 0, rMae = 0, rHighSince = 0;
                                        for (int i = 0; i < retryBars.Count; i++)
                                        {
                                            var b = retryBars[i];
                                            double bMfe = retryIsLong ? b.High - retryStartPrice : retryStartPrice - b.Low;
                                            double bMae = retryIsLong ? retryStartPrice - b.Low : b.High - retryStartPrice;
                                            if (bMfe > rMfe) rMfe = bMfe;
                                            if (bMae > rMae) rMae = bMae;
                                            double favorable = retryIsLong ? b.High - retryStartPrice : retryStartPrice - b.Low;
                                            if (favorable > rHighSince) rHighSince = favorable;
                                            double closeExc = retryIsLong ? b.Close - retryStartPrice : retryStartPrice - b.Close;

                                            retryBars[i] = new TradeZoneWriter.ZoneBarData
                                            {
                                                Time = b.Time, Open = b.Open, High = b.High, Low = b.Low,
                                                Close = b.Close, Volume = b.Volume, BarIndex = b.BarIndex,
                                                MfeFromStart = rMfe, MaeFromStart = rMae,
                                                DrawdownFromEntry = rMae, RunupFromEntry = rMfe,
                                                CloseVsEntry = closeExc, HighSinceEntry = rHighSince,
                                                RetraceFromPeak = rHighSince > 0 ? rHighSince - favorable : 0
                                            };
                                        }

                                        NinjaTrader.Code.Output.Process(
                                            string.Format("TradeZone: Retry {0} zone — {1:F2} → {2:F2} ({3:+0.00;-0.00} pts, {4} bars, no indicator context)",
                                                zoneDirection, retryStartPrice, retryEndPrice, retryPointsMove, retryBars.Count),
                                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                                        TradeZoneWriter.WriteZoneWithBarsAsync(
                                            instrumentName, zoneDirection,
                                            startTime, endTime,
                                            retryStartPrice, retryEndPrice,
                                            chartTimeframe, notes,
                                            retryBars, retryCtx);

                                        req2.Dispose();
                                    }
                                    catch (Exception ex2)
                                    {
                                        NinjaTrader.Code.Output.Process(
                                            string.Format("TradeZone: Retry callback error — {0}", ex2.Message),
                                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                                        try { req2.Dispose(); } catch { }
                                    }
                                }));
                            }
                            catch (Exception retryEx)
                            {
                                NinjaTrader.Code.Output.Process(
                                    string.Format("TradeZone: Failed to start retry BarsRequest — {0}", retryEx.Message),
                                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                            }
                            return;
                        }

                        // ═══════════════════════════════════════════════════════════════
                        // PHASE B: Compute direction-aware excursion + risk analytics
                        // ═══════════════════════════════════════════════════════════════

                        double startPrice = firstClose;
                        double endPrice   = lastClose;
                        string direction  = zoneDirection;
                        bool isLong       = direction == "Long";
                        double pointsMove = isLong
                            ? (endPrice - startPrice)
                            : (startPrice - endPrice);

                        _zoneData[zoneKey] = new ZoneComputedData
                        {
                            StartPrice = startPrice,
                            EndPrice   = endPrice,
                            Direction  = direction,
                            PointsMove = pointsMove
                        };

                        // Per-bar MFE/MAE and risk analytics
                        double runningMfe = 0, runningMae = 0;
                        double highSinceEntry = 0; // Best favorable price reached (in points from entry)

                        for (int i = 0; i < bars.Count; i++)
                        {
                            var b = bars[i];

                            // MFE/MAE (running max favorable/adverse excursion)
                            double barMfe, barMae;
                            if (isLong)
                            {
                                barMfe = b.High - startPrice;
                                barMae = startPrice - b.Low;
                            }
                            else
                            {
                                barMfe = startPrice - b.Low;
                                barMae = b.High - startPrice;
                            }
                            if (barMfe > runningMfe) runningMfe = barMfe;
                            if (barMae > runningMae) runningMae = barMae;

                            // Close vs entry (direction-aware P&L at this bar)
                            double closeVsEntry = isLong
                                ? (b.Close - startPrice)
                                : (startPrice - b.Close);

                            // High since entry (running best favorable close, for trailing SL)
                            if (closeVsEntry > highSinceEntry) highSinceEntry = closeVsEntry;

                            // Retrace from peak (how much given back from the best point)
                            double retraceFromPeak = highSinceEntry - closeVsEntry;

                            bars[i] = new TradeZoneWriter.ZoneBarData
                            {
                                Time              = b.Time,
                                Open              = b.Open,
                                High              = b.High,
                                Low               = b.Low,
                                Close             = b.Close,
                                Volume            = b.Volume,
                                BarIndex          = b.BarIndex,
                                MfeFromStart      = runningMfe,
                                MaeFromStart      = runningMae,
                                DrawdownFromEntry = runningMae,
                                RunupFromEntry    = runningMfe,
                                CloseVsEntry      = closeVsEntry,
                                HighSinceEntry    = highSinceEntry,
                                RetraceFromPeak   = retraceFromPeak
                            };
                        }

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: {0} zone — {1:F2} → {2:F2} ({3:+0.00;-0.00} pts, {4} bars, ATR={5:F2}, ADX={6:F1})",
                                direction, startPrice, endPrice, pointsMove, bars.Count, ctx.Atr14, ctx.Adx14),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                        // POST zone + bars to Supabase
                        TradeZoneWriter.WriteZoneWithBarsAsync(
                            instrumentName, direction,
                            startTime, endTime,
                            startPrice, endPrice,
                            chartTimeframe, notes,
                            bars, ctx);

                        req.Dispose();
                    }
                    catch (Exception ex)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: Error in BarsRequest callback — {0}", ex.Message),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        try { req.Dispose(); } catch { }
                    }
                }));
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeZone: Failed to start BarsRequest — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }
    }
}
