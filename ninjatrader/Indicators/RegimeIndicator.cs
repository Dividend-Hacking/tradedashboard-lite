#region Using declarations
using System;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript.Indicators;
#endregion

namespace NinjaTrader.NinjaScript.Indicators
{
    /// <summary>
    /// RegimeIndicator — Trade-or-stand-aside regime classifier built from
    /// post-hoc analysis of the trader's actual fills (Dataset A / B).
    ///
    /// Decision logic (executed every bar):
    ///   1. Compute ADX(14), EMA(20), ATR(14), range over last N bars (default 5).
    ///   2. If ADX is in the "death zone" (22–30 by default)         → STAND ASIDE
    ///   3. If wide × wide chop
    ///        (current bar range  > ChopRangeMult × ATR AND
    ///         last-N-bars range  > ChopRecentMult × ATR)            → STAND ASIDE
    ///   4. If close > EMA20 by more than EmaBufferAtr × ATR         → LONG BIAS
    ///      elif close < EMA20 by more than EmaBufferAtr × ATR       → SHORT BIAS
    ///      else (price hovering at EMA20)                            → STAND ASIDE
    ///
    /// Findings that drive the rule set:
    ///   • ADX < 15           → mean-reverting, takeable (+1.89 pts/trade)
    ///   • ADX 15–22          → best general regime    (+2.98 pts/trade)
    ///   • ADX 22–30          → "death zone"           (−1.59 pts/trade)
    ///   • ADX > 30           → strong trend, takeable (+4.70 pts/trade)
    ///   • Wide × wide chop hit a 38% SL rate; tight/transitioning ranges all worked.
    ///   • EMA20 directional filter: 69% of long winners were above EMA20,
    ///     60% of short winners below it — the ATR buffer prevents flapping
    ///     when price hovers right on the moving average.
    ///
    /// Outputs:
    ///   • Plot 0: EMA20 line (overlay) — visualises the directional pivot.
    ///   • Plot 1: RegimeState — numeric encoding readable by other indicators
    ///             /strategies via ((RegimeIndicator)x).Values[1][0]:
    ///                +1  = LONG BIAS
    ///                −1  = SHORT BIAS
    ///                 0  = STAND ASIDE — no clear direction (price near EMA20)
    ///                −2  = STAND ASIDE — ADX death zone
    ///                −3  = STAND ASIDE — wide × wide chop
    ///   • Optional chart background tint for fast visual identification.
    ///   • Optional top-left HUD text with regime label + reason + ADX/ATR.
    /// </summary>
    public class RegimeIndicator : Indicator
    {
        // ─── Regime state constants ──────────────────────────────────────────
        // Encoded as integers so the regime can be exposed via a numeric Plot
        // and consumed by strategies/other indicators without string parsing.
        public const int REGIME_LONG          =  1;
        public const int REGIME_SHORT         = -1;
        public const int REGIME_ASIDE_NEUTRAL =  0;   // price hugging EMA20
        public const int REGIME_ASIDE_DEATH   = -2;   // ADX 22–30
        public const int REGIME_ASIDE_CHOP    = -3;   // wide × wide chop

        // ─── Cached indicator references ─────────────────────────────────────
        // Created in DataLoaded so they're available for OnBarUpdate. Holding
        // them as fields avoids re-resolving each bar (NinjaScript caches under
        // the hood, but explicit fields make the dependencies obvious).
        private ADX adx;
        private EMA ema20;
        private ATR atr;

        // Tracks the last classified regime so we only print state-change logs
        // when the regime actually flips, not on every bar.
        private int lastRegime = int.MinValue;

        #region OnStateChange
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                // ─── Indicator metadata ──────────────────────────────────────
                Description = "Trade-or-stand-aside regime classifier (ADX death zone + chop filter + EMA20 bias).";
                Name = "RegimeIndicator";
                IsOverlay = true;                   // Draw EMA20 + tint on the price panel
                IsSuspendedWhileInactive = true;    // Pause when chart is hidden
                Calculate = Calculate.OnBarClose;   // Decide regime once per closed bar

                // ─── Tunable parameters ──────────────────────────────────────
                // Defaults match the values established in the analysis. Users
                // can override per chart if they want a stricter/looser filter.
                AdxPeriod        = 14;
                EmaPeriod        = 20;
                AtrPeriod        = 14;
                DeathZoneMin     = 22;
                DeathZoneMax     = 30;
                ChopRangeMult    = 0.85;   // current-bar range  > 0.85 × ATR
                ChopLookback     = 5;      // window for "last 5 bars" range
                ChopRecentMult   = 0.40;   // last-5-bars range  > 0.40 × ATR
                EmaBufferAtr     = 0.25;   // |close − EMA20|    > 0.25 × ATR

                // ─── Visual options ──────────────────────────────────────────
                ShowHud          = true;
                TintBackground   = true;
                LongTint         = Brushes.LightGreen;
                ShortTint        = Brushes.LightPink;
                AsideTint        = Brushes.LightGray;
                EmaColor         = Brushes.Goldenrod;

                // ─── Output plots ────────────────────────────────────────────
                // Plot 0: EMA20 line — drawn on the price panel as a thin overlay.
                AddPlot(new Stroke(Brushes.Goldenrod, 2), PlotStyle.Line, "EMA20");

                // Plot 1: RegimeState — exposed numerically so strategies can
                // read it via (indicator).Values[1][0]. Drawn as a hidden plot
                // (Dot + transparent brush) because users normally don't want
                // a "−3 to +1" line cluttering the chart.
                AddPlot(new Stroke(Brushes.Transparent, 0), PlotStyle.Dot, "RegimeState");
            }
            else if (State == State.Configure)
            {
                // Nothing to add here — we use only the primary series and
                // rely on built-in ADX/EMA/ATR which create their own internal
                // dependencies.
            }
            else if (State == State.DataLoaded)
            {
                // Resolve indicator instances once the primary bars are ready.
                // These calls cache by parameter inside NinjaTrader, so two
                // RegimeIndicators on the same chart share the same ADX object.
                adx   = ADX(AdxPeriod);
                ema20 = EMA(EmaPeriod);
                atr   = ATR(AtrPeriod);
            }
        }
        #endregion

        #region OnBarUpdate
        protected override void OnBarUpdate()
        {
            // We need enough bars for ADX, EMA, ATR, AND the chop lookback
            // window. The largest of the three drives the warm-up requirement.
            int warmup = Math.Max(Math.Max(AdxPeriod, EmaPeriod), Math.Max(AtrPeriod, ChopLookback));
            if (CurrentBar < warmup)
                return;

            // ─── Read primitives for this bar ────────────────────────────────
            // Pull each value once into a local — keeps the rule code readable
            // and avoids re-querying the underlying series multiple times.
            double adxValue = adx[0];
            double emaValue = ema20[0];
            double atrValue = atr[0];
            double close    = Close[0];

            // Defensive: if ATR is 0 (zero-range bars at session open, etc.)
            // we can't normalise anything, so default to STAND ASIDE neutral.
            if (atrValue <= 0)
            {
                EmitRegime(REGIME_ASIDE_NEUTRAL, emaValue, adxValue, atrValue);
                return;
            }

            // ─── Rule 2: ADX death zone (highest-priority stand-aside) ───────
            // ADX magnitude was the strongest single filter in the analysis;
            // the 22–30 band was the clearest "don't trade" signal in the data.
            if (adxValue >= DeathZoneMin && adxValue < DeathZoneMax)
            {
                EmitRegime(REGIME_ASIDE_DEATH, emaValue, adxValue, atrValue);
                return;
            }

            // ─── Rule 3: wide × wide chop ────────────────────────────────────
            // "Chop" = current bar is wide AND recent bars have also been wide.
            // We compare current bar range and the cumulative range over the
            // last ChopLookback bars (default 5) against ATR-scaled thresholds.
            double currentRange = High[0] - Low[0];

            // Aggregate range over the last N bars: max(High) − min(Low).
            // Using the envelope (not summed bar ranges) matches the analysis
            // definition of "the last 5 bars covered > 0.4×ATR of price space."
            double recentHigh = High[0];
            double recentLow  = Low[0];
            for (int i = 1; i < ChopLookback; i++)
            {
                if (High[i] > recentHigh) recentHigh = High[i];
                if (Low[i]  < recentLow)  recentLow  = Low[i];
            }
            double recentRange = recentHigh - recentLow;

            bool isWideCurrent = currentRange > ChopRangeMult  * atrValue;
            bool isWideRecent  = recentRange  > ChopRecentMult * atrValue;
            if (isWideCurrent && isWideRecent)
            {
                EmitRegime(REGIME_ASIDE_CHOP, emaValue, adxValue, atrValue);
                return;
            }

            // ─── Rule 4: EMA20 directional bias with ATR buffer ──────────────
            // The buffer (default 0.25 × ATR) prevents the regime from flipping
            // every time price brushes against EMA20 — a hover near the moving
            // average is treated as "no direction yet."
            double buffer = EmaBufferAtr * atrValue;
            if (close - emaValue > buffer)
            {
                EmitRegime(REGIME_LONG, emaValue, adxValue, atrValue);
            }
            else if (emaValue - close > buffer)
            {
                EmitRegime(REGIME_SHORT, emaValue, adxValue, atrValue);
            }
            else
            {
                EmitRegime(REGIME_ASIDE_NEUTRAL, emaValue, adxValue, atrValue);
            }
        }
        #endregion

        #region Regime emission helpers

        /// <summary>
        /// Writes the EMA20 + regime state to the indicator plots and applies
        /// optional background tint for the current bar. Centralised so every
        /// rule branch in OnBarUpdate has identical side effects.
        /// </summary>
        /// <param name="regime">One of the REGIME_* constants</param>
        /// <param name="emaValue">Current EMA20 value (plotted on series 0)</param>
        /// <param name="adxValue">Current ADX value (used only for HUD/logging)</param>
        /// <param name="atrValue">Current ATR value (used only for HUD/logging)</param>
        private void EmitRegime(int regime, double emaValue, double adxValue, double atrValue)
        {
            // Plot 0 = EMA20 line — Values[0] in NinjaScript is the first AddPlot.
            Values[0][0] = emaValue;

            // Plot 1 = numeric regime state — strategies can read this via
            // ((RegimeIndicator)reg).Values[1][0] without parsing strings.
            Values[1][0] = regime;

            // Optional chart background tint — visualises the regime at a glance.
            // BackBrushes[0] paints just this bar's column so changes are visible
            // bar-by-bar instead of staining the entire chart.
            if (TintBackground)
            {
                Brush tint;
                switch (regime)
                {
                    case REGIME_LONG:  tint = LongTint;  break;
                    case REGIME_SHORT: tint = ShortTint; break;
                    default:           tint = AsideTint; break;   // any STAND ASIDE flavor
                }

                // Use a semi-transparent clone of the chosen brush so the price
                // bars remain readable. Cloning + freezing avoids WPF dispatcher
                // affinity issues when NinjaTrader caches the brush across bars.
                if (tint != null)
                {
                    Brush translucent = tint.Clone();
                    translucent.Opacity = 0.18;
                    if (translucent.CanFreeze) translucent.Freeze();
                    BackBrushes[0] = translucent;
                }
            }

            // Log only on regime flips — keeps the output window readable instead
            // of dumping a line for every bar in long replays.
            if (regime != lastRegime)
            {
                Print(string.Format(
                    "RegimeIndicator @ {0:HH:mm}: {1}  | ADX={2:F1}  ATR={3:F2}  EMA20={4:F2}  Close={5:F2}",
                    Time[0], RegimeLabel(regime), adxValue, atrValue, emaValue, Close[0]));
                lastRegime = regime;
            }
        }

        /// <summary>
        /// Converts a regime constant to a human-readable label.
        /// Used both by the Print() log line and the on-chart HUD overlay.
        /// </summary>
        private static string RegimeLabel(int regime)
        {
            switch (regime)
            {
                case REGIME_LONG:          return "LONG BIAS";
                case REGIME_SHORT:         return "SHORT BIAS";
                case REGIME_ASIDE_DEATH:   return "STAND ASIDE — DEATH ZONE";
                case REGIME_ASIDE_CHOP:    return "STAND ASIDE — CHOP";
                case REGIME_ASIDE_NEUTRAL: return "STAND ASIDE — NO DIRECTION";
                default:                   return "UNKNOWN";
            }
        }

        #endregion

        #region OnRender — top-left HUD overlay

        /// <summary>
        /// Draws a top-left HUD with the current regime label, reason, and the
        /// underlying numbers (ADX / ATR / |close − EMA20|). Uses SharpDX
        /// (Direct2D / DirectWrite) because NT8 chart rendering is GPU-based —
        /// WPF brushes won't draw inside OnRender.
        /// </summary>
        protected override void OnRender(ChartControl chartControl, ChartScale chartScale)
        {
            base.OnRender(chartControl, chartScale);

            if (!ShowHud) return;

            // Need at least one classified bar before we can show a HUD.
            // CurrentBar is the *seed* index, so check via Values[1].Count.
            if (CurrentBar < 1) return;

            // Read the most recent plot values — these are populated even on
            // historical bars because OnBarUpdate ran during the warm-up pass.
            int regime = (int)Math.Round(Values[1][0]);
            double emaValue = Values[0][0];
            double adxValue = adx != null && adx.Count > 0 ? adx[0] : 0;
            double atrValue = atr != null && atr.Count > 0 ? atr[0] : 0;
            double distance = Close[0] - emaValue;

            // Pick a HUD color matching the regime so the user can read state
            // without parsing the text.
            SharpDX.Color hudColor;
            switch (regime)
            {
                case REGIME_LONG:  hudColor = new SharpDX.Color( 60, 180,  75, 220); break; // green
                case REGIME_SHORT: hudColor = new SharpDX.Color(220,  50,  50, 220); break; // red
                default:           hudColor = new SharpDX.Color(180, 180, 180, 220); break; // gray (any STAND ASIDE)
            }

            // Build the two-line HUD. Line 1 = label, line 2 = supporting numbers.
            string hudText = string.Format(
                "REGIME: {0}\nADX={1:F1}   ATR={2:F2}   close−EMA20={3:+0.00;-0.00;0.00}",
                RegimeLabel(regime), adxValue, atrValue, distance);

            // SharpDX resources are unmanaged — must be disposed in `finally`
            // or the GPU will leak handles every render frame.
            SharpDX.Direct2D1.SolidColorBrush dxBrush = null;
            SharpDX.DirectWrite.TextFormat textFormat = null;
            SharpDX.DirectWrite.TextLayout textLayout = null;
            try
            {
                dxBrush = new SharpDX.Direct2D1.SolidColorBrush(RenderTarget, hudColor);

                textFormat = new SharpDX.DirectWrite.TextFormat(
                    Core.Globals.DirectWriteFactory,
                    "Segoe UI", SharpDX.DirectWrite.FontWeight.Bold,
                    SharpDX.DirectWrite.FontStyle.Normal, 14);

                // Wrap to the panel width as a safety net; the text is short
                // enough that it almost always fits on a single line.
                textLayout = new SharpDX.DirectWrite.TextLayout(
                    Core.Globals.DirectWriteFactory,
                    hudText, textFormat, ChartPanel.W, ChartPanel.H);

                // Anchor at top-left of the price panel with a small margin.
                float padX = 8f;
                float padY = 6f;
                RenderTarget.DrawTextLayout(
                    new SharpDX.Vector2(padX, padY),
                    textLayout, dxBrush);
            }
            finally
            {
                if (textLayout != null) textLayout.Dispose();
                if (textFormat != null) textFormat.Dispose();
                if (dxBrush != null)    dxBrush.Dispose();
            }
        }

        #endregion

        #region Properties

        // ─── Calculation parameters ──────────────────────────────────────────

        [NinjaScriptProperty]
        [Range(2, 100)]
        [Display(Name = "ADX Period", Description = "Lookback period for ADX (trend strength).",
            Order = 1, GroupName = "Parameters")]
        public int AdxPeriod { get; set; }

        [NinjaScriptProperty]
        [Range(2, 200)]
        [Display(Name = "EMA Period", Description = "Lookback period for the directional EMA (default 20).",
            Order = 2, GroupName = "Parameters")]
        public int EmaPeriod { get; set; }

        [NinjaScriptProperty]
        [Range(2, 100)]
        [Display(Name = "ATR Period", Description = "Lookback period for ATR (used to normalise ranges and the EMA buffer).",
            Order = 3, GroupName = "Parameters")]
        public int AtrPeriod { get; set; }

        // ─── Regime thresholds ───────────────────────────────────────────────

        [NinjaScriptProperty]
        [Range(0, 100)]
        [Display(Name = "Death Zone Min ADX", Description = "Lower bound of the ADX 'death zone' — stand aside (default 22).",
            Order = 1, GroupName = "Regime Thresholds")]
        public double DeathZoneMin { get; set; }

        [NinjaScriptProperty]
        [Range(0, 100)]
        [Display(Name = "Death Zone Max ADX", Description = "Upper bound of the ADX 'death zone' — stand aside (default 30).",
            Order = 2, GroupName = "Regime Thresholds")]
        public double DeathZoneMax { get; set; }

        [NinjaScriptProperty]
        [Range(0.1, 5.0)]
        [Display(Name = "Chop Range × ATR", Description = "Current bar range must exceed this × ATR to count as 'wide' (default 0.85).",
            Order = 3, GroupName = "Regime Thresholds")]
        public double ChopRangeMult { get; set; }

        [NinjaScriptProperty]
        [Range(2, 50)]
        [Display(Name = "Chop Lookback Bars", Description = "Number of recent bars used to measure the chop envelope (default 5).",
            Order = 4, GroupName = "Regime Thresholds")]
        public int ChopLookback { get; set; }

        [NinjaScriptProperty]
        [Range(0.05, 5.0)]
        [Display(Name = "Chop Recent × ATR", Description = "Last-N-bars envelope must exceed this × ATR to count as 'wide' (default 0.40).",
            Order = 5, GroupName = "Regime Thresholds")]
        public double ChopRecentMult { get; set; }

        [NinjaScriptProperty]
        [Range(0.0, 5.0)]
        [Display(Name = "EMA Buffer × ATR", Description = "|close − EMA20| must exceed this × ATR to commit to a directional bias (default 0.25).",
            Order = 6, GroupName = "Regime Thresholds")]
        public double EmaBufferAtr { get; set; }

        // ─── Visual options ──────────────────────────────────────────────────

        [NinjaScriptProperty]
        [Display(Name = "Show HUD", Description = "Show the top-left regime label / ADX / ATR overlay.",
            Order = 1, GroupName = "Visuals")]
        public bool ShowHud { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Tint Background", Description = "Apply a translucent column tint per bar based on the regime.",
            Order = 2, GroupName = "Visuals")]
        public bool TintBackground { get; set; }

        [XmlIgnore]
        [Display(Name = "Long Tint", Description = "Background color for LONG BIAS bars.",
            Order = 3, GroupName = "Visuals")]
        public Brush LongTint { get; set; }

        [Browsable(false)]
        public string LongTintSerializable
        {
            get { return Serialize.BrushToString(LongTint); }
            set { LongTint = Serialize.StringToBrush(value); }
        }

        [XmlIgnore]
        [Display(Name = "Short Tint", Description = "Background color for SHORT BIAS bars.",
            Order = 4, GroupName = "Visuals")]
        public Brush ShortTint { get; set; }

        [Browsable(false)]
        public string ShortTintSerializable
        {
            get { return Serialize.BrushToString(ShortTint); }
            set { ShortTint = Serialize.StringToBrush(value); }
        }

        [XmlIgnore]
        [Display(Name = "Stand-Aside Tint", Description = "Background color for any STAND ASIDE bars.",
            Order = 5, GroupName = "Visuals")]
        public Brush AsideTint { get; set; }

        [Browsable(false)]
        public string AsideTintSerializable
        {
            get { return Serialize.BrushToString(AsideTint); }
            set { AsideTint = Serialize.StringToBrush(value); }
        }

        [XmlIgnore]
        [Display(Name = "EMA Color", Description = "Color of the EMA20 plot line.",
            Order = 6, GroupName = "Visuals")]
        public Brush EmaColor { get; set; }

        [Browsable(false)]
        public string EmaColorSerializable
        {
            get { return Serialize.BrushToString(EmaColor); }
            set { EmaColor = Serialize.StringToBrush(value); }
        }

        // ─── Output series accessors ─────────────────────────────────────────
        // Provide named accessors so strategies can write
        //   RegimeIndicator(...).RegimeState[0]
        // instead of guessing plot indices.

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> Ema { get { return Values[0]; } }

        [Browsable(false)]
        [XmlIgnore]
        public Series<double> RegimeState { get { return Values[1]; } }

        #endregion
    }
}

// NOTE: NinjaTrader auto-generates the wrapper boilerplate (Indicator /
// MarketAnalyzerColumn / Strategy partial-class methods + cacheRegimeIndicator)
// at compile time. Hand-writing those blocks here causes CS0111/CS0102/CS0229
// "already defines a member" duplicate-definition errors when NT8 appends its
// own version. Leave this section blank — the editor adds its own region the
// first time the file compiles cleanly.
