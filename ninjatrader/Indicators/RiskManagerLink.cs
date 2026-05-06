#region Using declarations
using System;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Windows;
using System.Windows.Input;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript.AddOns;
#endregion

namespace NinjaTrader.NinjaScript.Indicators
{
    /// <summary>
    /// RiskManagerLink — Lightweight overlay indicator that bridges the RiskManager AddOn
    /// to a chart. AddOns can't discover tabbed charts via the NinjaTrader API, but indicators
    /// have direct access to ChartPanel and ChartControl. This indicator registers itself with
    /// the static RiskManagerBridge so the AddOn can request chart-click SL placement.
    ///
    /// Usage: Add this indicator to any chart. The RiskManager AddOn will show "Linked" status.
    /// When the user clicks Buy/Sell in Manual SL mode, this indicator captures the next
    /// left-click on the chart, converts Y pixel → price, and fires the bridge event.
    /// </summary>
    public class RiskManagerLink : Indicator
    {
        // ─── State ────────────────────────────────────────────────────────────
        // Unique ID for this indicator instance — used by the bridge to track
        // which instances are linked. Prevents a temp preview instance's Terminated
        // state from clearing the link for the real instance on the chart.
        private string _instanceId;

        // Whether we've attached mouse/key event handlers to the chart panel
        private bool _handlersAttached;

        // Flag to prevent the async AttachHandlers lambda from running after
        // the instance has been terminated. Volatile because it's set in Terminated
        // (UI thread) and read in the async Dispatcher callback.
        private volatile bool _isTerminated = false;

        // Cached scalar values from ChartScale, captured in OnRender. We cache the raw
        // doubles/float instead of the ChartScale object because ChartScale is owned by
        // the render thread — accessing it from the UI thread (mouse handlers) throws a
        // cross-thread exception. Plain value types have no thread affinity.
        private double _scaleMax;
        private double _scaleMin;
        private double _scaleHeight;

        // Cached tick size and panel Y offset — same cross-thread rationale as above.
        // Instrument.MasterInstrument is a DependencyObject and ChartPanel is a WPF Visual,
        // both potentially owned by the render thread. Cache plain doubles in OnRender.
        private double _tickSize;
        private double _panelY;

        // Cached instrument full name — Instrument is a DependencyObject owned by the render
        // thread, so accessing it from UI-thread event handlers throws cross-thread exceptions.
        private string _instrumentName = "";

        /// <summary>
        /// Sets indicator metadata in SetDefaults. No user-configurable properties.
        /// </summary>
        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    Description = "Bridges the RiskManager AddOn to this chart for manual SL click placement.";
                    Name = "RiskManagerLink";
                    // Overlay on the price panel — no separate sub-panel
                    IsOverlay = true;
                    // Don't display on the chart's data box or in the indicator list
                    DisplayInDataBox = false;
                    IsSuspendedWhileInactive = false;
                    // Generate unique ID so the bridge can track this specific instance.
                    // Each instance (including temp preview instances from the Indicators dialog)
                    // gets its own ID, preventing cross-instance interference.
                    _instanceId = Guid.NewGuid().ToString();
                    break;

                case State.DataLoaded:
                    // DataLoaded fires after the chart and bars are ready.
                    // Register with the bridge so the AddOn knows a chart is linked.
                    RegisterWithBridge();
                    break;

                case State.Terminated:
                    // Indicator removed or chart closed — unregister and detach handlers
                    DetachHandlers();
                    UnregisterFromBridge();
                    break;
            }
        }

        /// <summary>
        /// No computation needed — this indicator doesn't plot anything via OnBarUpdate.
        /// Must exist because NinjaTrader requires it, but it's a no-op.
        /// </summary>
        protected override void OnBarUpdate() { }

        // ─── Bridge Registration ──────────────────────────────────────────────

        /// <summary>
        /// Registers this indicator's chart with the RiskManagerBridge.
        /// Fires the OnLinked event with the instrument name and timeframe string
        /// so the AddOn can update its UI and auto-sync the instrument.
        /// Also attaches mouse/key handlers to the chart panel for click capture.
        /// </summary>
        private void RegisterWithBridge()
        {
            try
            {
                // Build timeframe string from the bars period (e.g., "5 Min", "1 Hour", "Daily")
                string timeframe = BarsPeriod != null
                    ? string.Format("{0} {1}", BarsPeriod.Value, BarsPeriod.BarsPeriodType)
                    : "Unknown";

                // Get the full instrument name (e.g., "MNQ 03-26")
                string instrumentName = Instrument != null ? Instrument.FullName : "Unknown";

                // Fire the bridge event to notify the AddOn that a chart is linked.
                // Pass our unique instance ID so the bridge can track this specific instance.
                RiskManagerBridge.FireLinked(_instanceId, instrumentName, timeframe);

                // Attach mouse/key handlers for chart-click SL capture
                AttachHandlers();

                Print(string.Format("RiskManagerLink: Registered — {0} ({1})", instrumentName, timeframe));
            }
            catch (Exception ex)
            {
                Print(string.Format("RiskManagerLink: Error registering — {0}", ex.Message));
            }
        }

        /// <summary>
        /// Unregisters this indicator from the bridge when removed or chart closes.
        /// Fires OnUnlinked so the AddOn clears its link status display.
        /// </summary>
        private void UnregisterFromBridge()
        {
            try
            {
                string instrumentName = Instrument != null ? Instrument.FullName : "Unknown";
                // Pass our unique instance ID so the bridge only fires OnUnlinked
                // if no other instances remain for this instrument
                RiskManagerBridge.FireUnlinked(_instanceId, instrumentName);
            }
            catch { } // Swallow — may be called during shutdown
        }

        // ─── Chart Event Handlers ─────────────────────────────────────────────

        /// <summary>
        /// Attaches mouse and keyboard event handlers to the chart panel via Dispatcher.
        /// Uses PreviewMouseLeftButtonDown so we can intercept clicks before the chart processes them.
        /// Also attaches Escape and right-click handlers for cancellation.
        /// Must run on the UI thread — ChartControl.Dispatcher ensures this.
        /// </summary>
        private void AttachHandlers()
        {
            if (_handlersAttached) return;
            if (ChartControl == null) return;

            ChartControl.Dispatcher.InvokeAsync(new Action(() =>
            {
                // If the instance was terminated before this async callback ran,
                // bail out — attaching handlers to a dead instance leaks them
                if (_isTerminated) return;

                try
                {
                    // Attach left-click handler to ChartControl (not ChartPanel) because
                    // ChartPanel may be null when this async lambda executes during DataLoaded.
                    // ChartControl is always available. The Y→price conversion in OnChartMouseDown
                    // still works — WPF computes coordinates relative to any visual element.
                    ChartControl.PreviewMouseLeftButtonDown += OnChartMouseDown;

                    // Keyboard and right-click cancel handlers go on ChartControl
                    // since it receives input focus for the entire chart
                    ChartControl.PreviewKeyDown += OnChartKeyDown;
                    ChartControl.PreviewMouseRightButtonDown += OnChartRightClick;

                    _handlersAttached = true;
                }
                catch (Exception ex)
                {
                    Print(string.Format("RiskManagerLink: Error attaching handlers — {0}", ex.Message));
                }
            }));
        }

        /// <summary>
        /// Detaches all event handlers from the chart panel and chart control.
        /// Safe to call multiple times — checks _handlersAttached guard.
        /// </summary>
        private void DetachHandlers()
        {
            // Mark terminated BEFORE checking _handlersAttached — this prevents
            // a queued async AttachHandlers lambda from attaching after we return
            _isTerminated = true;

            if (!_handlersAttached) return;

            try
            {
                if (ChartControl != null)
                {
                    ChartControl.PreviewMouseLeftButtonDown -= OnChartMouseDown;
                    ChartControl.PreviewKeyDown -= OnChartKeyDown;
                    ChartControl.PreviewMouseRightButtonDown -= OnChartRightClick;
                }
            }
            catch { } // Swallow — chart may already be disposed during shutdown

            _handlersAttached = false;
        }

        /// <summary>
        /// Handles left-click on the chart panel. Only processes clicks when the bridge
        /// signals WaitingForSlClick and the instrument matches WaitingInstrument.
        /// Converts Y pixel → price using ChartPanel's scale, fires the bridge event,
        /// and marks the click as handled to prevent the chart from processing it.
        /// </summary>
        private void OnChartMouseDown(object sender, MouseButtonEventArgs e)
        {
            // Only intercept clicks when the AddOn is waiting for an SL click
            if (!RiskManagerBridge.WaitingForSlClick) return;

            Print("RiskManagerLink: OnChartMouseDown fired — WaitingForSlClick=true");

            // Only respond if this chart's instrument matches the one the AddOn is waiting for
            // Use cached _instrumentName — Instrument is a DependencyObject owned by render thread
            string myInstrument = _instrumentName;
            if (!string.Equals(myInstrument, RiskManagerBridge.WaitingInstrument, StringComparison.OrdinalIgnoreCase))
                return;

            try
            {
                // Get the Y coordinate relative to ChartControl, then subtract the cached
                // panel Y offset. We avoid e.GetPosition(ChartPanel) because ChartPanel
                // is a WPF Visual that may be owned by the render thread.
                Point clickPoint = e.GetPosition(ChartControl);
                double yPixel = clickPoint.Y - _panelY;

                // Convert Y pixel → price using cached scalar values from OnRender.
                // We use manual linear interpolation instead of ChartScale.GetValueByY()
                // because the ChartScale object is owned by the render thread and can't
                // be accessed from the UI thread (mouse handlers). The cached scalars
                // (plain doubles/float) have no thread affinity.
                if (_scaleHeight <= 0 || _tickSize <= 0) return;
                double clickedPrice = _scaleMax - (yPixel / _scaleHeight) * (_scaleMax - _scaleMin);

                // Round to the instrument's tick size for clean order prices
                // Use cached _tickSize — Instrument.MasterInstrument is a DependencyObject
                // with potential render-thread affinity
                double tickSize = _tickSize;
                clickedPrice = Math.Round(clickedPrice / tickSize) * tickSize;

                // Mark event handled BEFORE firing bridge — prevents chart from
                // processing the click as a drawing tool or selection action
                e.Handled = true;

                // Fire the bridge event — the AddOn's SlPriceSelected handler takes over
                RiskManagerBridge.FireSlSelected(clickedPrice);

                Print(string.Format("RiskManagerLink: SL click captured at Y={0:F0} → price={1:F2}", yPixel, clickedPrice));
            }
            catch (Exception ex)
            {
                Print(string.Format("RiskManagerLink: Error processing click — {0}", ex.Message));
                // Cancel on error so the user isn't stuck in wait mode
                RiskManagerBridge.FireSlCancelled();
            }
        }

        /// <summary>
        /// Handles Escape key press — cancels the manual SL wait if active.
        /// </summary>
        private void OnChartKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Escape) return;
            if (!RiskManagerBridge.WaitingForSlClick) return;

            // Only cancel if this chart's instrument matches
            // Use cached _instrumentName — Instrument is a DependencyObject owned by render thread
            string myInstrument = _instrumentName;
            if (!string.Equals(myInstrument, RiskManagerBridge.WaitingInstrument, StringComparison.OrdinalIgnoreCase))
                return;

            e.Handled = true;
            RiskManagerBridge.FireSlCancelled();
            Print("RiskManagerLink: SL wait cancelled via Escape");
        }

        /// <summary>
        /// Handles right-click — cancels the manual SL wait if active.
        /// </summary>
        private void OnChartRightClick(object sender, MouseButtonEventArgs e)
        {
            if (!RiskManagerBridge.WaitingForSlClick) return;

            // Only cancel if this chart's instrument matches
            // Use cached _instrumentName — Instrument is a DependencyObject owned by render thread
            string myInstrument = _instrumentName;
            if (!string.Equals(myInstrument, RiskManagerBridge.WaitingInstrument, StringComparison.OrdinalIgnoreCase))
                return;

            e.Handled = true;
            RiskManagerBridge.FireSlCancelled();
            Print("RiskManagerLink: SL wait cancelled via right-click");
        }

        // ─── OnRender — Visual feedback when waiting for SL click ─────────────

        /// <summary>
        /// Draws a subtle "Click to set SL" overlay text when the bridge is waiting
        /// for a chart click on this instrument. Gives the user visual confirmation
        /// that the chart is ready to receive their SL placement click.
        /// </summary>
        protected override void OnRender(ChartControl chartControl, ChartScale chartScale)
        {
            // Cache scalar values from the chart scale for use in mouse click handlers.
            // OnRender receives a guaranteed-valid scale from the engine. We extract
            // plain doubles/float here to avoid cross-thread access on the ChartScale object.
            _scaleMax = chartScale.MaxValue;
            _scaleMin = chartScale.MinValue;
            _scaleHeight = chartScale.Height;
            _tickSize = Instrument.MasterInstrument.TickSize;
            _panelY = ChartPanel.Y;
            _instrumentName = Instrument != null ? Instrument.FullName : "";

            base.OnRender(chartControl, chartScale);

            // Only show overlay when waiting for SL click on this instrument
            if (!RiskManagerBridge.WaitingForSlClick) return;

            string myInstrument = Instrument != null ? Instrument.FullName : "";
            if (!string.Equals(myInstrument, RiskManagerBridge.WaitingInstrument, StringComparison.OrdinalIgnoreCase))
                return;

            // Draw "Click to set SL" text centered in the chart panel using SharpDX
            // NT8 uses SharpDX (Direct2D/DirectWrite) for all chart rendering — WPF brushes are not supported here
            SharpDX.Direct2D1.SolidColorBrush dxBrush = null;
            SharpDX.DirectWrite.TextFormat textFormat = null;
            SharpDX.DirectWrite.TextLayout textLayout = null;
            try
            {
                // Semi-transparent orange brush for the overlay text
                dxBrush = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget,
                    new SharpDX.Color(255, 165, 0, 180));

                // Bold Segoe UI at 24pt for visibility
                textFormat = new SharpDX.DirectWrite.TextFormat(
                    Core.Globals.DirectWriteFactory,
                    "Segoe UI", SharpDX.DirectWrite.FontWeight.Bold,
                    SharpDX.DirectWrite.FontStyle.Normal, 24);

                textLayout = new SharpDX.DirectWrite.TextLayout(
                    Core.Globals.DirectWriteFactory,
                    "CLICK TO SET SL", textFormat, ChartPanel.W, ChartPanel.H);

                // Center horizontally, position 15% from top
                float textX = (float)((ChartPanel.W - textLayout.Metrics.Width) / 2);
                float textY = (float)(ChartPanel.H * 0.15);

                RenderTarget.DrawTextLayout(
                    new SharpDX.Vector2(textX, textY),
                    textLayout, dxBrush);
            }
            finally
            {
                // SharpDX objects implement IDisposable — must clean up to avoid GPU resource leaks
                if (textLayout != null) textLayout.Dispose();
                if (textFormat != null) textFormat.Dispose();
                if (dxBrush != null) dxBrush.Dispose();
            }

            // Force continuous re-render while waiting so the text shows/hides responsively
            if (ChartControl != null)
                ChartControl.InvalidateVisual();
        }
    }
}
