// PresetSchema.cs
//
// POCO mirror of the dashboard's BacktestPreset / SimRules / PresetFilters
// shape so a JSON file exported from the dashboard's preset list deserializes
// 1:1 into native C# objects that the NinjaScript Strategy can execute.
//
// Why these aren't [DataContract]/[XmlSerializable]:
//   We deserialize via System.Web.Script.Serialization.JavaScriptSerializer
//   (loader logic in PresetLoader.cs). It maps JSON to a Dictionary<string,object>
//   first, then we hand-walk the dict into these POCOs in the loader so we can
//   apply forward-compat defaults for any missing fields — same shim the
//   dashboard's normalizePresetForLoad() applies on load.
//
// Field naming follows the JSON keys (camelCase / snake_case mix as exported by
// the dashboard) so the loader's dict-walk reads naturally. The runtime engine
// (PresetExecutor) is the only consumer of these types; everything else uses
// NT8's native types (Cbi.MarketPosition, Data.MinMax, etc.).

using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns
{
    // ─── Preset (top-level) ─────────────────────────────────────────────────
    //
    // Mirrors src/lib/utils/backtest-presets.ts BacktestPreset. createdAt /
    // updatedAt are kept as strings (ISO timestamps) — we never compare them
    // here; they exist purely so an exported JSON round-trips byte-for-byte
    // back into the dashboard if a user wants to re-import.
    public class Preset
    {
        public int    Version    { get; set; } = 1;
        public string Id         { get; set; } = "";
        public string Name       { get; set; } = "";
        public string CreatedAt  { get; set; } = "";
        public string UpdatedAt  { get; set; } = "";
        public string StrategyId { get; set; } = "";

        // Strategy-specific numeric knobs. Keys must match the dashboard's
        // SIGNAL_V1_FIELDS / SIGNAL_V2_FIELDS / SIGNAL_V3_FIELDS ids (lookback, atrPeriod,
        // atEdgeThreshold, …). Stored as a string-keyed dict so adding a new
        // strategy parameter doesn't require a schema change here.
        public Dictionary<string, double> Params { get; set; } = new Dictionary<string, double>();

        public SimRules       Rules   { get; set; } = new SimRules();
        public PresetFilters  Filters { get; set; } = new PresetFilters();
    }

    // ─── SimRules (exit rules) ──────────────────────────────────────────────
    //
    // Mirrors src/lib/utils/zone-simulator.ts SimRules. Defaults match
    // DEFAULT_SIM_RULES so a preset with missing fields (older export, fresh
    // template) inherits the same fallback the dashboard applies.
    public class SimRules
    {
        // SL/TP/Trail entry-side
        public bool   StopLossEnabled     { get; set; } = true;
        public double StopLossPoints      { get; set; } = 10;
        public bool   TakeProfitEnabled   { get; set; } = true;
        public double TakeProfitPoints    { get; set; } = 20;
        public bool   TrailingStopEnabled { get; set; } = false;
        public double TrailingStopPoints  { get; set; } = 8;

        // Post-fill exits
        public bool   TimedExitEnabled  { get; set; } = false;
        public int    TimedExitBars     { get; set; } = 20;
        public bool   BreakEvenEnabled  { get; set; } = false;
        public double BreakEvenTrigger  { get; set; } = 5;

        // Simulator-only knobs (exitAtBarClose, extension bars) — kept for
        // round-trip fidelity but unused by live execution. NT8 always exits
        // at trigger price, not bar close.
        public bool   ExitAtBarClose       { get; set; } = true;
        public bool   ExtensionBarsEnabled { get; set; } = false;
        public int    ExtensionBars        { get; set; } = 20;

        // Per-rule additive ATR adjustments. effective = base + adjust × zoneAtr.
        public double SlAtrAdjust    { get; set; } = 0;
        public double TpAtrAdjust    { get; set; } = 0;
        public double TrailAtrAdjust { get; set; } = 0;
        public double BeAtrAdjust    { get; set; } = 0;

        // Cross-zone overlap — see PositionMode enum below.
        public string PositionMode { get; set; } = "default";

        // Scaling walk — additive per-trade size adjustment.
        public bool   ScalingEnabled    { get; set; } = false;
        public int    ScalingStartSize  { get; set; } = 1;
        public int    ScalingWinStep    { get; set; } = 1;
        public int    ScalingLossStep   { get; set; } = 1;
        public int    ScalingMinSize    { get; set; } = 1;
        public int    ScalingMaxSize    { get; set; } = 5;
        public bool   ScalingResetDaily { get; set; } = false;

        // Daily kill switches.
        public bool   DailyStopLossEnabled    { get; set; } = false;
        public double DailyStopLossPoints     { get; set; } = 50;
        public bool   DailyTakeProfitEnabled  { get; set; } = false;
        public double DailyTakeProfitPoints   { get; set; } = 50;
        // When true, in-flight trades get force-closed at the moment a daily
        // limit is crossed. Requires per-tick monitoring (PresetStrategy adds
        // a 1-tick BarsPeriod so OnMarketData can drive the watchdog).
        public bool   DailyLimitExactMode     { get; set; } = false;

        // Per-day TRADE COUNT and LOSS COUNT caps + per-trade cooldown.
        // Mirrors the dashboard's applyTradeCountCaps post-pass: drop any
        // would-be entry once the day's count threshold has been hit, OR
        // when the previous trade closed within `cooldownBetweenTradesBars`
        // minutes of the current bar. Independent of the P&L-based daily
        // kill switches above.
        public bool   MaxTradesPerDayEnabled        { get; set; } = false;
        public int    MaxTradesPerDay               { get; set; } = 5;
        public bool   MaxLossesPerDayEnabled        { get; set; } = false;
        public int    MaxLossesPerDay               { get; set; } = 3;
        public bool   CooldownBetweenTradesEnabled  { get; set; } = false;
        public int    CooldownBetweenTradesBars     { get; set; } = 5;

        // ── Backtest-only fields (carried for round-trip JSON parity) ─────
        // These are dashboard-simulator inputs that don't drive live NT8
        // behavior — NT8 has its own per-strategy Slippage property and the
        // broker handles commissions natively. We accept them in the schema
        // so a re-exported preset hashes the same and the loader doesn't
        // drop unknown keys, but the executor does NOT read them.
        //
        //   FillMode               — "close" | "next_open" (sim-only)
        //   SlippagePoints         — per-side points slip in the sim
        //   CommissionPerRoundTrip — per-trade $ cost in the sim
        //   PointValue             — $/point for converting sim points → $
        //   TickConfigMode         — "auto" or "manual" (sim-only)
        //   TicksPerPoint          — script ticks(n) helper (sim-only)
        //   TickValue              — $/tick reporting field (sim-only)
        public string FillMode               { get; set; } = "next_open";
        public double SlippagePoints         { get; set; } = 0;
        public double CommissionPerRoundTrip { get; set; } = 0;
        public double PointValue             { get; set; } = 20;
        public string TickConfigMode         { get; set; } = "auto";
        public double TicksPerPoint          { get; set; } = 4;
        public double TickValue              { get; set; } = 5;
    }

    // ─── PresetFilters (entry-side gates) ───────────────────────────────────
    //
    // Mirrors src/lib/utils/backtest-presets.ts PresetFilters. Each filter has
    // an `enabled` flag — when false it's a no-op regardless of the bound
    // values. When enabled, a missing/null indicator value is treated as a
    // failure (drop the entry) — same null-as-fail behavior as the dashboard.
    public class PresetFilters
    {
        public TimeFilter        Time       { get; set; } = new TimeFilter();
        public NumericFilter     Adx        { get; set; } = new NumericFilter { Period = 14 };
        public NumericFilter     Atr        { get; set; } = new NumericFilter { Period = 14 };
        public TrendFilter       Trend      { get; set; } = new TrendFilter();
        public BollingerFilter   Bollinger  { get; set; } = new BollingerFilter();
        // Post-customization filter additions. Each defaults disabled so a
        // pre-customization preset (no bbWidth/maDistance/volume keys in
        // the JSON) loads as a no-op.
        public BbWidthFilter     BbWidth    { get; set; } = new BbWidthFilter();
        public MaDistanceFilter  MaDistance { get; set; } = new MaDistanceFilter();
        public VolumeFilter      Volume     { get; set; } = new VolumeFilter();
        public RsiFilter         Rsi        { get; set; } = new RsiFilter();
        public AdxTrendFilter    AdxTrend   { get; set; } = new AdxTrendFilter();
    }

    /// <summary>
    /// HH:MM time-of-day window. When From &lt;= To the window is the obvious
    /// inclusive range; when From &gt; To it wraps midnight (e.g. 22:00→06:00
    /// means "after 22:00 OR before 06:00"). Same convention as the dashboard.
    ///
    /// Supports multi-window: `Windows` is the canonical multi-window source
    /// (a bar passes when its time falls in ANY window). `From`/`To` are
    /// kept as the FIRST window for backwards compat with older preset
    /// JSONs and any consumer that expects a single window — the loader
    /// keeps both representations in sync after parse.
    /// </summary>
    public class TimeFilter
    {
        public bool   Enabled { get; set; } = false;
        public string From    { get; set; } = "09:30";
        public string To      { get; set; } = "16:00";
        public List<TimeWindow> Windows { get; set; } = new List<TimeWindow>
        {
            new TimeWindow { From = "09:30", To = "16:00" },
        };
    }

    /// <summary>One time-of-day window inside TimeFilter.Windows.</summary>
    public class TimeWindow
    {
        public string From { get; set; } = "09:30";
        public string To   { get; set; } = "16:00";
    }

    /// <summary>
    /// Inclusive numeric range filter — used for ADX and ATR. A value passes
    /// when Min ≤ value ≤ Max; null/NaN values fail when Enabled.
    /// `Period` is the indicator's lookback (Wilder ADX / Wilder ATR). Both
    /// default to 14 (legacy hardcoded). For ATR specifically, this also
    /// drives the per-rule ± ATR adjust math on SL/TP/Trail/BE — change
    /// once, applied everywhere.
    /// </summary>
    public class NumericFilter
    {
        public bool   Enabled { get; set; } = false;
        public double Min     { get; set; } = 0;
        public double Max     { get; set; } = 100;
        public int    Period  { get; set; } = 14;
    }

    /// <summary>
    /// Direction-relative trend filter. ema20Mode / ema200Mode are one of:
    ///   "any"     — no constraint on this EMA leg
    ///   "with"    — price on the same side as the trade direction
    ///                  (Long needs price &gt; EMA, Short needs price &lt; EMA)
    ///   "against" — price on the opposite side
    /// </summary>
    public class TrendFilter
    {
        public bool   Enabled     { get; set; } = false;
        public string Ema20Mode   { get; set; } = "with";
        public string Ema200Mode  { get; set; } = "any";
        // Configurable trend MAs. The mode field-names stay "Ema20Mode" /
        // "Ema200Mode" for JSON wire compat, but their VALUES respect the
        // FastPeriod/Type and SlowPeriod/Type below — so a preset with
        // SlowPeriod=50, SlowType="sma" interprets Ema200Mode="with" as
        // "price on the same side as the SMA(50)".
        public int    FastPeriod  { get; set; } = 20;
        public string FastType    { get; set; } = "ema";  // "ema" | "sma"
        public int    SlowPeriod  { get; set; } = 200;
        public string SlowType    { get; set; } = "ema";
    }

    /// <summary>
    /// Bollinger position filter. Allowed is a list of zone strings:
    /// "above_upper" / "inside" / "below_lower". When Enabled, the close's
    /// current zone must be in Allowed; warmup-window null fails.
    /// </summary>
    public class BollingerFilter
    {
        public bool         Enabled { get; set; } = false;
        public List<string> Allowed { get; set; } = new List<string>
        {
            "above_upper", "inside", "below_lower"
        };
        // Configurable centerline period + stddev multiplier. Defaults
        // (20, 2) reproduce the legacy hardcoded values. Shared with the
        // BbWidth filter — one tuning, two filters.
        public int    Period { get; set; } = 20;
        public double StdDev { get; set; } = 2;
    }

    /// <summary>
    /// Bollinger band-WIDTH range filter. Passes when (upper − lower) at
    /// entry is in [Min, Max] (in price points). Reuses Bollinger.Period
    /// and Bollinger.StdDev from the BollingerFilter above so users tune
    /// one set of band parameters and both filters apply consistently.
    /// </summary>
    public class BbWidthFilter
    {
        public bool   Enabled { get; set; } = false;
        public double Min     { get; set; } = 0;
        public double Max     { get; set; } = 1000;
    }

    /// <summary>
    /// Distance-from-MA filter. The reference MA is fully independent of
    /// the trend filter's MAs (so users can filter trend with EMA(20) AND
    /// distance from EMA(50) at the same time). `Mode` is one of:
    ///   "absolute" — |distance| in [Min, Max]; sign-agnostic
    ///   "above"    — price must be ABOVE the MA, distance in [Min, Max]
    ///   "below"    — price must be BELOW, |distance| in [Min, Max]
    /// `Min`/`Max` are in ATR units (uses Atr.Period for normalization).
    /// </summary>
    public class MaDistanceFilter
    {
        public bool   Enabled { get; set; } = false;
        public int    Period  { get; set; } = 50;
        public string Type    { get; set; } = "ema";        // "ema" | "sma"
        public string Mode    { get; set; } = "absolute";   // "absolute" | "above" | "below"
        public double Min     { get; set; } = 0;
        public double Max     { get; set; } = 5;
    }

    /// <summary>
    /// Volume-ratio filter. Passes when (current bar volume) / (N-bar
    /// average volume) is in [MinRatio, MaxRatio]. 1.0 = at average.
    /// MinRatio=1.5 keeps only above-average-volume entries.
    /// </summary>
    public class VolumeFilter
    {
        public bool   Enabled  { get; set; } = false;
        public int    Period   { get; set; } = 20;
        public double MinRatio { get; set; } = 0;
        public double MaxRatio { get; set; } = 100;
    }

    /// <summary>
    /// Wilder RSI range filter. Passes when RSI(Period) at entry is in
    /// [Min, Max]. RSI is 0–100; classic oversold/overbought are < 30 / > 70.
    /// </summary>
    public class RsiFilter
    {
        public bool   Enabled { get; set; } = false;
        public int    Period  { get; set; } = 14;
        public double Min     { get; set; } = 0;
        public double Max     { get; set; } = 100;
    }

    /// <summary>
    /// ADX direction filter. Gates on the SIGN of the ADX slope (= ADX[i]
    /// − ADX[i − Lookback]).
    ///   Mode = "any"     → no gate (filter is effectively off)
    ///   Mode = "rising"  → slope > FlatThreshold
    ///   Mode = "falling" → slope < -FlatThreshold
    ///   Mode = "flat"    → |slope| ≤ FlatThreshold
    /// Lookback is the bars-back used when computing the slope. Slope is
    /// stamped onto each synthetic zone at signal time, so changing
    /// Lookback in the dashboard re-runs the backtest.
    /// </summary>
    public class AdxTrendFilter
    {
        public bool   Enabled       { get; set; } = false;
        public string Mode          { get; set; } = "rising";
        public int    Lookback      { get; set; } = 5;
        public double FlatThreshold { get; set; } = 1;
    }

    // ─── FilterContext ──────────────────────────────────────────────────────
    //
    // Per-bar indicator snapshot built by PresetExecutor and passed into
    // FilterEvaluator.Pass(). Mirrors src/lib/utils/preset-filters.ts
    // FilterContext. All fields are nullable (double? / string?) so warmup
    // windows propagate correctly — null = fail-when-enabled, no-op otherwise.
    public class PresetFilterContext
    {
        public double? Atr14           { get; set; }
        public double? Adx14           { get; set; }
        public string  PriceVsEma20    { get; set; } // "above" | "below" | null
        public string  PriceVsEma200   { get; set; } // "above" | "below" | null
        public string  BollingerPos    { get; set; } // "above_upper" | "inside" | "below_lower" | null
        // Post-customization fields — null when their underlying indicator
        // hasn't warmed up yet, same null-as-fail discipline as the legacy
        // fields above.
        public double? BollingerBw     { get; set; } // upper − lower in price points
        public double? MaDistanceAtr   { get; set; } // signed distance to MaDistance MA in ATR units
        public double? VolumeRatio     { get; set; } // bar_volume / N-bar avg volume
        public double? Rsi             { get; set; } // Wilder RSI 0–100
        public double? AdxSlope        { get; set; } // ADX[i] − ADX[i − lookback]
    }

    // ─── Bar (input shape for indicators / signal generators) ───────────────
    //
    // Plain OHLCV bar. NT8 strategies will project Time[]/Open[]/High[]/Low[]/
    // Close[]/Volume[] into a List<Bar> rolling buffer on each OnBarUpdate so
    // the pure indicator/signal code can consume an instrument-agnostic input.
    public class PresetBar
    {
        public System.DateTime Time   { get; set; }
        public double          Open   { get; set; }
        public double          High   { get; set; }
        public double          Low    { get; set; }
        public double          Close  { get; set; }
        public double          Volume { get; set; }
    }

    // ─── Signal (signal generator output) ───────────────────────────────────
    //
    // Mirrors BacktestSignal in src/lib/utils/backtest-engine.ts. BarIndex is
    // the index into the bars array passed to Generate(); Direction is "Long"
    // or "Short". The executor only ever cares about the signal at the most
    // recent bar — older signals are evaluated lazily as bars roll forward.
    public class PresetSignal
    {
        public int    BarIndex  { get; set; }
        public string Direction { get; set; } = "Long";
    }
}
