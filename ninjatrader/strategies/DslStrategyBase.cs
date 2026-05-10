// DslStrategyBase.cs
//
// Base class for transpiled DSL strategies. Owns all the SL/TP/trailing/
// break-even/timed-exit/scaling/daily-limit/position-mode boilerplate so
// each generated subclass can stay small and just implement the DSL-side
// hooks (LongCondition / ShortCondition / LongFilterPasses /
// ShortFilterPasses / GetSimRulesData / GetPresetFiltersData).
//
// PARITY DESIGN:
//   This base mirrors the dashboard's zone-simulator.ts execution semantics
//   (per-bar close, fill at next bar open via NT8's Calculate.OnBarClose,
//   ATR-adjusted brackets per leg, BE move on profit-trigger, timed exit
//   on bars-held). Position modes mirror zone-simulator.ts:380-387. The
//   parity harness (scripts/parity-harness.ts) is the source of truth for
//   "is the C# behavior identical to the dashboard?" — when in doubt, the
//   dashboard wins.
//
// SCOPE (v1):
//   Implemented:
//     - SL / TP / Trailing / BE / Timed exit (with ATR adjustments)
//     - Position modes: default / null / add-null / add-close / close-previous / reverse-null / reverse-add
//     - Daily P&L kill switches (post-bar realized check)
//     - Per-day max trades / losses caps
//     - Cooldown between trades (minutes between exit and next entry)
//     - Multi-window time-of-day filter
//     - Per-leg unique signal name + per-leg bracket attachment
//   NOT YET IMPLEMENTED — surfaced as warnings or no-op:
//     - Scaling walk (size adjusts after wins/losses)
//     - dailyLimitExactMode tick watchdog
//     - Extension bars (zone-simulator-only feature, doesn't apply live)
//
// Per-leg tracking uses NT8's StopTargetHandling.PerEntryExecution + a
// unique signal name per entry (PresetLong_N / PresetShort_N). NT8
// attaches SL/TP/Trail to the specific execution that fills the named
// order, so stacked positions get independent brackets the dashboard
// has always assumed.

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.IO;
using System.Text;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.AddOns;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    /// <summary>
    /// SimRulesData — POCO mirror of SimRules from PresetSchema.cs but
    /// produced inline in the generated strategy (no JSON load). The
    /// generated subclass returns this from GetSimRulesData().
    /// </summary>
    public class SimRulesData
    {
        public bool   StopLossEnabled     = true;
        public double StopLossPoints      = 10;
        public bool   TakeProfitEnabled   = true;
        public double TakeProfitPoints    = 20;
        public bool   TrailingStopEnabled = false;
        public double TrailingStopPoints  = 8;
        public bool   TimedExitEnabled    = false;
        public int    TimedExitBars       = 20;
        public bool   BreakEvenEnabled    = false;
        public double BreakEvenTrigger    = 5;
        public bool   ExitAtBarClose      = true;
        public bool   ExtensionBarsEnabled = false;
        public int    ExtensionBars       = 20;
        public double SlAtrAdjust         = 0;
        public double TpAtrAdjust         = 0;
        public double TrailAtrAdjust      = 0;
        public double BeAtrAdjust         = 0;
        public string PositionMode        = "default";
        public bool   ScalingEnabled      = false;
        public int    ScalingStartSize    = 1;
        public int    ScalingWinStep      = 1;
        public int    ScalingLossStep     = 1;
        public int    ScalingMinSize      = 1;
        public int    ScalingMaxSize      = 5;
        public bool   ScalingResetDaily   = false;
        public bool   DailyStopLossEnabled    = false;
        public double DailyStopLossPoints     = 50;
        public bool   DailyTakeProfitEnabled  = false;
        public double DailyTakeProfitPoints   = 50;
        public bool   DailyLimitExactMode     = false;
        public bool   MaxTradesPerDayEnabled  = false;
        public int    MaxTradesPerDay         = 5;
        public bool   MaxLossesPerDayEnabled  = false;
        public int    MaxLossesPerDay         = 3;
        public bool   CooldownBetweenTradesEnabled = false;
        public int    CooldownBetweenTradesBars    = 5;
        public string FillMode               = "next_open";
        public double SlippagePoints         = 0;
        public double CommissionPerRoundTrip = 0;
        public double PointValue             = 20;
        public string TickConfigMode         = "auto";
        public double TicksPerPoint          = 4;
        public double TickValue              = 5;

        /// <summary>
        /// Shallow clone — used by DispatchEntry to produce a per-entry
        /// mutable rules instance that filter.if 3-arg `rules.X = Y`
        /// assignments can stamp on top of without affecting the
        /// strategy's baseline. SimRulesData is value-style (only doubles,
        /// ints, bools, strings — no nested refs), so a field-by-field
        /// copy is sufficient.
        /// </summary>
        public SimRulesData Clone()
        {
            return new SimRulesData
            {
                StopLossEnabled     = this.StopLossEnabled,
                StopLossPoints      = this.StopLossPoints,
                TakeProfitEnabled   = this.TakeProfitEnabled,
                TakeProfitPoints    = this.TakeProfitPoints,
                TrailingStopEnabled = this.TrailingStopEnabled,
                TrailingStopPoints  = this.TrailingStopPoints,
                TimedExitEnabled    = this.TimedExitEnabled,
                TimedExitBars       = this.TimedExitBars,
                BreakEvenEnabled    = this.BreakEvenEnabled,
                BreakEvenTrigger    = this.BreakEvenTrigger,
                ExitAtBarClose      = this.ExitAtBarClose,
                ExtensionBarsEnabled = this.ExtensionBarsEnabled,
                ExtensionBars       = this.ExtensionBars,
                SlAtrAdjust         = this.SlAtrAdjust,
                TpAtrAdjust         = this.TpAtrAdjust,
                TrailAtrAdjust      = this.TrailAtrAdjust,
                BeAtrAdjust         = this.BeAtrAdjust,
                PositionMode        = this.PositionMode,
                ScalingEnabled      = this.ScalingEnabled,
                ScalingStartSize    = this.ScalingStartSize,
                ScalingWinStep      = this.ScalingWinStep,
                ScalingLossStep     = this.ScalingLossStep,
                ScalingMinSize      = this.ScalingMinSize,
                ScalingMaxSize      = this.ScalingMaxSize,
                ScalingResetDaily   = this.ScalingResetDaily,
                DailyStopLossEnabled    = this.DailyStopLossEnabled,
                DailyStopLossPoints     = this.DailyStopLossPoints,
                DailyTakeProfitEnabled  = this.DailyTakeProfitEnabled,
                DailyTakeProfitPoints   = this.DailyTakeProfitPoints,
                DailyLimitExactMode     = this.DailyLimitExactMode,
                MaxTradesPerDayEnabled  = this.MaxTradesPerDayEnabled,
                MaxTradesPerDay         = this.MaxTradesPerDay,
                MaxLossesPerDayEnabled  = this.MaxLossesPerDayEnabled,
                MaxLossesPerDay         = this.MaxLossesPerDay,
                CooldownBetweenTradesEnabled = this.CooldownBetweenTradesEnabled,
                CooldownBetweenTradesBars    = this.CooldownBetweenTradesBars,
                FillMode               = this.FillMode,
                SlippagePoints         = this.SlippagePoints,
                CommissionPerRoundTrip = this.CommissionPerRoundTrip,
                PointValue             = this.PointValue,
                TickConfigMode         = this.TickConfigMode,
                TicksPerPoint          = this.TicksPerPoint,
                TickValue              = this.TickValue,
            };
        }
    }

    /// <summary>
    /// PresetFiltersData — POCO for the legacy filter set. Most filters
    /// have moved into the DSL via filter.if; these structs hold the
    /// non-DSL gates the dashboard's `filters.X.*` directives still
    /// produce: time-of-day window + trend (price-vs-MA gate).
    ///
    /// The transpiler folds `parseBacktestScript.config.filters.time`
    /// and `.trend` into the emitted GetPresetFiltersData() body —
    /// previously it returned a default-only POCO so legacy filter
    /// directives were silently dropped, which made NT8 fire ~8x more
    /// trades than the dashboard.
    /// </summary>
    public class PresetFiltersData
    {
        public TimeFilterData  Time  = new TimeFilterData();
        public TrendFilterData Trend = new TrendFilterData();
    }

    public class TimeFilterData
    {
        public bool Enabled = false;
        // Multi-window list. Each window is "HH:MM-HH:MM"; wrap-around
        // (From > To, e.g. "22:00-06:00") is supported.
        public List<TimeWindowData> Windows = new List<TimeWindowData>();
    }

    public class TimeWindowData
    {
        public string From; // "HH:MM"
        public string To;   // "HH:MM"
    }

    /// <summary>
    /// Trend filter — gates trades on close vs a fast / slow moving
    /// average. Mirrors the legacy `TrendFilter` POCO in PresetSchema.cs
    /// and the dashboard's `filters.trend` block. Each leg has a mode:
    ///   "any"     — no constraint
    ///   "with"    — longs need close > MA, shorts need close < MA
    ///   "against" — longs need close < MA, shorts need close > MA
    /// `FastType` / `SlowType` are "ema" or "sma".
    /// </summary>
    public class TrendFilterData
    {
        public bool   Enabled    = false;
        public string Ema20Mode  = "any";
        public string Ema200Mode = "any";
        public int    FastPeriod = 20;
        public string FastType   = "ema";
        public int    SlowPeriod = 200;
        public string SlowType   = "ema";
    }

    /// <summary>
    /// Per-leg state captured at entry. Tracked in a Dictionary keyed by
    /// the unique signal name we issue for each entry order so per-leg
    /// brackets and post-fill checks (BE move, timed exit) can find their
    /// state. Removed when NT8 reports the leg's exit fill.
    /// </summary>
    internal class DslLeg
    {
        public string   SignalName;
        public string   Direction;       // "Long" / "Short"
        public double   EntryPrice;
        public DateTime EntryBarTime;
        public int      EntryBarIndex;   // CurrentBar at entry — drives timed exit
        public int      Qty;
        public double   ZoneAtr;         // ATR(14) at entry — drives ATR-adjusted brackets
        public bool     BeTriggered;     // SL has been moved to entry
        public double   PeakPnlPoints;   // best favorable excursion since entry
        public bool     CloseDispatched; // gate to prevent duplicate exit dispatch
        public bool     IsReverseEntry;  // tagged when entry came via reverse-null/reverse-add (zone-simulator parity)

        // ── Per-leg exit levels (used when ExitAtBarClose=true) ──────
        // Mirror the dashboard's exit-trigger semantics. We track the
        // levels manually and fire ExitLong/Short at bar CLOSE on the
        // first bar whose High/Low touches them — so the recorded fill
        // price is the close of the trigger bar (the dashboard convention)
        // rather than the trigger price itself (NT8's native behavior).
        // Levels are in absolute price units, computed once at entry.
        public double  StopLossLevel;     // 0 if SL disabled
        public double  TakeProfitLevel;   // 0 if TP disabled
        public double  TrailStopLevel;    // running trail level (long: highest_close - trailPts; short: inverse)
        public double  TrailDistancePts;  // trail distance in price points
        public bool    HasTrail;          // true if trailing is on
    }

    public abstract class DslStrategyBase : Strategy
    {
        // ─── Subclass hooks ─────────────────────────────────────────────
        // Implemented by the transpiler's generated subclass. The base
        // doesn't try to provide defaults; if a subclass forgets to
        // implement one of these the strategy won't compile, which is
        // the point — the transpiler must always emit all four.

        protected abstract bool LongCondition();
        protected abstract bool ShortCondition();
        /// <summary>
        /// Apply the DSL's filter.if / filter.long.if directives for a
        /// candidate long entry. Returns false to reject the trade.
        /// May mutate the passed-in `rules` (per-trade rule overrides
        /// from the 3-arg `filter.if = (cond, rules.X = Y, …)` form
        /// land here — they affect the brackets attached to THIS entry
        /// without changing the strategy's baseline rules).
        ///
        /// Default: pass-through (no filter directives → always allow).
        /// </summary>
        protected virtual bool LongApplyFilters(SimRulesData rules) => true;

        /// <summary>Mirror of LongApplyFilters for short candidates.</summary>
        protected virtual bool ShortApplyFilters(SimRulesData rules) => true;

        protected abstract SimRulesData GetSimRulesData();
        protected abstract PresetFiltersData GetPresetFiltersData();

        /// <summary>
        /// Hook called from State.DataLoaded after the bar series + tick
        /// channel are wired. Subclasses use this for transpiler-emitted
        /// init (e.g. constructing the tick aggregator).
        /// </summary>
        protected virtual void AfterDataLoadedFromTranspiler() { }

        /// <summary>
        /// Did the transpiler default every params.X to 1.0? The transpiler
        /// emits an override returning true when no params.json was supplied
        /// at export time. Drives the loud "ALL PARAMS DEFAULTED" warning at
        /// State.DataLoaded so users don't silently run a misconfigured
        /// strategy. Default implementation returns false (real params).
        /// </summary>
        protected virtual bool ParamsWereDefaulted() => false;

        /// <summary>
        /// Per-bar let-dump diagnostic hook (round-8). The transpiler's
        /// generated subclass overrides this and Prints one line per
        /// configured bar with every `let` binding's evaluated value, so
        /// we can diff dashboard vs NT8 evaluation order and find the
        /// first diverging sub-component of a signal AND-chain. Default
        /// implementation is a no-op — dump only fires when the subclass
        /// has a body to emit AND ShouldDumpThisBar returns true.
        /// </summary>
        protected virtual void DumpSignalSubConditions() { }

        // ─── User-visible properties ───────────────────────────────────

        /// <summary>
        /// Toggle for the diagnostic logging the base class prints to NT8's
        /// output window — startup state, warmup ticks, signal evaluations,
        /// entry dispatches, executions. Defaults ON so users can see the
        /// strategy is alive on first run; flip off when running production
        /// (Strategy Analyzer over many sessions or live mode).
        /// </summary>
        [NinjaScriptProperty]
        [Display(Name = "Verbose Logging",
                 Description = "Print diagnostic logs at startup, signal evaluation, and per-trade events. Disable for production runs.",
                 Order = 1, GroupName = "9. Diagnostics")]
        public bool VerboseLogging { get; set; }

        // ─── Round-8 — per-bar let-dump diagnostic ──────────────────────
        // Three opt-in HH:mm / yyyy-MM-dd properties that, when populated,
        // cause OnBarUpdate to call DumpSignalSubConditions() on every bar
        // whose timestamp falls in the configured window. The transpiled
        // subclass overrides DumpSignalSubConditions() to print one line
        // per bar with every `let` binding's evaluated value. Diff this
        // against the dashboard's parallel dump (console.log via
        // localStorage.debugDiagDump) to find the first sub-component of
        // the signal AND-chain that diverges between the two engines.
        // Empty strings (the defaults) disable the dump entirely — the
        // override is a no-op when none of these are set.

        [NinjaScriptProperty]
        [Display(Name = "Dump From (HH:mm)",
                 Description = "Start of the per-bar let-dump window. Empty = disabled. Pair with DumpToTime to bound the dump.",
                 Order = 20, GroupName = "9. Diagnostics")]
        public string DumpFromTime { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Dump To (HH:mm)",
                 Description = "End of the per-bar let-dump window (inclusive). Empty = disabled.",
                 Order = 21, GroupName = "9. Diagnostics")]
        public string DumpToTime { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Dump On Date (yyyy-MM-dd)",
                 Description = "Optional date filter for the let-dump. Empty = match every day in the window. Use for one-day deep-dives.",
                 Order = 22, GroupName = "9. Diagnostics")]
        public string DumpOnDate { get; set; }

        // ─── Internal state ─────────────────────────────────────────────
        // Bar buffer fed to DslIndicators. Capped at MaxBars so long
        // sessions don't grow unbounded. Trim from the front (oldest) so
        // current-bar offsets are stable.
        protected readonly List<DslBar> _bars = new List<DslBar>();
        private const int MaxBars = 1500;

        // DSL runtime helper — owns signal-firing tracker + AnyBarIn /
        // BarsSinceCondition implementations. Constructed in
        // State.DataLoaded.
        protected DslRuntime _dsl;

        // Cached SimRules + PresetFilters from the generated subclass.
        // Snapshotted once at State.DataLoaded so the per-bar hot path
        // doesn't re-allocate.
        private SimRulesData _rules;
        private PresetFiltersData _filters;

        // Per-leg state. Keyed by the unique signal name we generate
        // for each entry order. Lifecycle: created on entry fill,
        // removed on exit fill.
        private readonly Dictionary<string, DslLeg> _legs = new Dictionary<string, DslLeg>();
        private int _legCounter = 0;

        // Daily tracking. Resets at calendar-day boundary.
        private string  _currentDay = "";
        private int     _dailyTradesEntered = 0;
        private int     _dailyLosses        = 0;
        private double  _dailyRealizedPoints = 0;
        private bool    _dailyHalted        = false;
        private DateTime? _lastKeptExitTime;

        // ── Logging "fire once" gates ──────────────────────────────────
        // Diagnostic prints are gated on VerboseLogging plus a one-shot
        // flag per event so we don't spam NT8's output on every bar.
        private bool _loggedFirstBar;
        private bool _loggedFirstEval;
        private bool _loggedFirstDumpDiag;  // round-8c — first post-warmup bar's DUMP-CONFIG line
        private int  _warmupLogStride = 100; // print every Nth bar during warmup

        // ── Session-summary counters (round-5 diagnostic) ───────────────
        // Increment in the relevant branches of OnBarUpdate. Printed at
        // State.Terminated as a single block so the user can spot which
        // gate is rejecting all signals when no trades fire. Cheap (just
        // ints), zero per-bar cost.
        private long _ssTotalPostWarmup;
        private long _ssTimePassed;
        private long _ssDailyHaltSkipped;
        private long _ssMaxTradesSkipped;
        private long _ssMaxLossesSkipped;
        private long _ssCooldownSkipped;
        private long _ssLongCondTrue;
        private long _ssShortCondTrue;
        private long _ssLongTrendRejected;
        private long _ssShortTrendRejected;
        private long _ssLongFilterIfRejected;
        private long _ssShortFilterIfRejected;
        private long _ssLongModeRejected;
        private long _ssShortModeRejected;
        private long _ssLongDispatched;
        private long _ssShortDispatched;
        private int  _evalLogCount; // bumped per Eval-line emission
        private int  _evalLogLimit = 50; // first N in-window bars logged verbosely

        // ── Per-bar signal audit (phantom-trade diagnostic) ─────────────
        // One row per bar where LongCondition() OR ShortCondition() was
        // true, capturing whether the candidate dispatched and — if not —
        // which gate rejected it. Written to signal_audit_<id>.csv at
        // strategy end, alongside the per-trade CSV. Used to pin down the
        // ~170 dashboard-only "phantom trades" against NT8's rejections
        // when diff-backtests.mjs flags them.
        private readonly List<string> _signalAuditRows = new List<string>();

        /// <summary>Print only when VerboseLogging is enabled. Cuts the
        /// caller's "if (VerboseLogging) Print(...)" boilerplate.</summary>
        private void Log(string msg)
        {
            if (VerboseLogging) Print(msg);
        }

        // ─── State management ──────────────────────────────────────────

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Calculate                   = Calculate.OnBarClose;
                EntriesPerDirection         = 10;
                EntryHandling               = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = false;
                IsFillLimitOnTouch          = false;
                MaximumBarsLookBack         = MaximumBarsLookBack.TwoHundredFiftySix;
                OrderFillResolution         = OrderFillResolution.Standard;
                StartBehavior               = StartBehavior.WaitUntilFlat;
                TimeInForce                 = TimeInForce.Gtc;
                TraceOrders                 = false;
                RealtimeErrorHandling       = RealtimeErrorHandling.StopCancelClose;
                StopTargetHandling          = StopTargetHandling.PerEntryExecution;
                BarsRequiredToTrade         = 250;
                VerboseLogging              = true; // default on; flip off for production
                // Round-8 — let-dump props default to empty (disabled).
                // User explicitly populates them when drilling a parity gap.
                DumpFromTime                = "";
                DumpToTime                  = "";
                DumpOnDate                  = "";
            }
            else if (State == State.DataLoaded)
            {
                _rules   = GetSimRulesData() ?? new SimRulesData();
                _filters = GetPresetFiltersData() ?? new PresetFiltersData();
                _dsl     = new DslRuntime();
                AfterDataLoadedFromTranspiler();

                // Loud one-shot warning when the transpiler couldn't fill
                // in real params and defaulted everything to 1.0. Silent
                // strategies are confusing; this banner makes the cause
                // visible up front.
                if (ParamsWereDefaulted())
                {
                    Print("");
                    Print("************************************************************************");
                    Print("[" + (Name ?? "DslStrategyBase") + "] WARNING: ALL PARAMS DEFAULTED TO 1.0");
                    Print("  This strategy was transpiled WITHOUT a params.json — every params.X");
                    Print("  reference was inlined as 1.0, which makes most signal conditions");
                    Print("  mathematically impossible (e.g. body_ratio >= 1.0, cross_up at 1.0).");
                    Print("  → Re-export from the dashboard's TO NT8 button (uses real params),");
                    Print("    or re-run scripts/parity-prep.ts <name> <params.json>.");
                    Print("************************************************************************");
                    Print("");
                }

                // Compact rules summary so the user can confirm the script's
                // rules.* assigns came through correctly.
                Log("[" + (Name ?? "DslStrategyBase") + "] Loaded."
                    + " SL="          + _rules.StopLossEnabled    + " (" + _rules.StopLossPoints.ToString("F2", CultureInfo.InvariantCulture)    + "pts +" + _rules.SlAtrAdjust.ToString("F2", CultureInfo.InvariantCulture)    + "*ATR)"
                    + " TP="          + _rules.TakeProfitEnabled  + " (" + _rules.TakeProfitPoints.ToString("F2", CultureInfo.InvariantCulture)  + "pts +" + _rules.TpAtrAdjust.ToString("F2", CultureInfo.InvariantCulture)    + "*ATR)"
                    + " Trail="       + _rules.TrailingStopEnabled+ " (" + _rules.TrailingStopPoints.ToString("F2", CultureInfo.InvariantCulture)+ "pts +" + _rules.TrailAtrAdjust.ToString("F2", CultureInfo.InvariantCulture) + "*ATR)"
                    + " BE="          + _rules.BreakEvenEnabled   + " (" + _rules.BreakEvenTrigger.ToString("F2", CultureInfo.InvariantCulture)  + "pts)"
                    + " TimedExit="   + _rules.TimedExitEnabled   + " (" + _rules.TimedExitBars + "bars)"
                    + " PositionMode="+ (_rules.PositionMode ?? "default")
                    + " DailySL="     + _rules.DailyStopLossEnabled    + " ("+ _rules.DailyStopLossPoints.ToString("F2", CultureInfo.InvariantCulture)   +"pts)"
                    + " DailyTP="     + _rules.DailyTakeProfitEnabled  + " ("+ _rules.DailyTakeProfitPoints.ToString("F2", CultureInfo.InvariantCulture) +"pts)"
                    + " MaxTrades/d=" + _rules.MaxTradesPerDayEnabled  + " ("+ _rules.MaxTradesPerDay  +")"
                    + " Cooldown="    + _rules.CooldownBetweenTradesEnabled + " ("+ _rules.CooldownBetweenTradesBars +"min)");
            }
            else if (State == State.Terminated)
            {
                // Round-5 diagnostic: print the session-summary counters
                // BEFORE the trade-CSV export so the user sees the gate
                // breakdown in NT8's output regardless of whether trades
                // fired. Helps narrow down "no trades" issues quickly.
                LogSessionSummary();
                // Always emit the per-trade CSV — used by the dashboard
                // parity diff (scripts/diff-backtests.mjs). Same schema
                // as PresetStrategy.ExportTradesCsv() so a single tool
                // can compare both legacy presets and DSL transpiles.
                ExportTradesCsv();
                // Phantom-trade diagnostic — one row per fired-signal bar
                // including the gate that rejected it (if any). Pairs with
                // the per-trade CSV: same backtest, same outgoing/ folder.
                ExportSignalAuditCsv();
            }
        }

        /// <summary>
        /// Print a multi-line session summary breaking down where the
        /// strategy's signals went. The user reads this to diagnose "no
        /// trades fired": if `LongCondition true: 0` over many bars,
        /// the script signal expression is structurally wrong; if
        /// `Trend-filter rejected` is most of the time, the trend
        /// filter is over-restrictive; etc.
        /// </summary>
        private void LogSessionSummary()
        {
            // Always emit, regardless of VerboseLogging — this is the
            // post-mortem and the user expects it. Skip if no bars
            // were processed (NT8 metadata-instantiation pass).
            if (_ssTotalPostWarmup == 0) return;

            string name = Name ?? "DslStrategyBase";
            double pctTime = _ssTotalPostWarmup > 0
                ? 100.0 * _ssTimePassed / _ssTotalPostWarmup : 0.0;
            Print("");
            Print("================================================================");
            Print("[" + name + "] SESSION SUMMARY (post-warmup gate breakdown)");
            Print("================================================================");
            Print("  Total bars (post-warmup):       " + _ssTotalPostWarmup);
            Print("  Daily-halt skipped:             " + _ssDailyHaltSkipped);
            Print("  Max-trades-per-day skipped:     " + _ssMaxTradesSkipped);
            Print("  Max-losses-per-day skipped:     " + _ssMaxLossesSkipped);
            Print("  Cooldown skipped:               " + _ssCooldownSkipped);
            Print("  Time-filter passed:             " + _ssTimePassed
                + " (" + pctTime.ToString("F1", CultureInfo.InvariantCulture) + "%)");
            Print("  ----- LONG side -----");
            Print("    LongCondition true:           " + _ssLongCondTrue);
            Print("    Trend-filter rejected long:   " + _ssLongTrendRejected);
            Print("    filter.if rejected long:      " + _ssLongFilterIfRejected);
            Print("    PositionMode rejected long:   " + _ssLongModeRejected);
            Print("    Long entries dispatched:      " + _ssLongDispatched);
            Print("  ----- SHORT side -----");
            Print("    ShortCondition true:          " + _ssShortCondTrue);
            Print("    Trend-filter rejected short:  " + _ssShortTrendRejected);
            Print("    filter.if rejected short:     " + _ssShortFilterIfRejected);
            Print("    PositionMode rejected short:  " + _ssShortModeRejected);
            Print("    Short entries dispatched:     " + _ssShortDispatched);
            Print("================================================================");
            // Hint if the obvious failure mode has happened.
            if (_ssTimePassed > 0 && _ssLongCondTrue == 0 && _ssShortCondTrue == 0)
            {
                Print("  NOTE: time filter passed " + _ssTimePassed + " bars but neither");
                Print("  Long nor Short signal ever evaluated true. The script's");
                Print("  signal expression is the next thing to inspect — likely");
                Print("  cross_up / bars_since / any_bar_in semantics in NT8.");
                Print("================================================================");
            }
            Print("");
        }

        /// <summary>
        /// Per-trade CSV export — schema matches dashboard's
        /// buildNt8ComparableTradesCsv() column-for-column. Writes to
        /// {UserDataDir}/outgoing/backtest_trades_{id}.csv. Skipped when
        /// no trades fired (avoids littering the outgoing/ folder with
        /// empty CSVs from NT8's metadata-instantiation passes).
        /// </summary>
        private void ExportTradesCsv()
        {
            try
            {
                var trades = SystemPerformance.AllTrades;
                int n = trades != null ? trades.Count : 0;
                if (n == 0) return;

                string outgoingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "outgoing");
                Directory.CreateDirectory(outgoingDir);

                // Filename: timestamp + class name + trade count, so
                // back-to-back SA runs don't clobber each other.
                string fileId =
                    DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture)
                    + "_" + (Name ?? "dsl") + "_" + n + "trades";
                string outputPath = Path.Combine(outgoingDir, "backtest_trades_" + fileId + ".csv");

                var sb = new StringBuilder();
                // Schema must match dashboard CSV (zone-detailed-export.ts:404).
                sb.Append("entry_time_session,entry_time_utc,exit_time_session,exit_time_utc,");
                sb.Append("direction,qty,entry_price,exit_price,exit_reason,points,dollars\n");

                for (int i = 0; i < n; i++)
                {
                    var t = trades[i];
                    if (t == null || t.Entry == null || t.Exit == null) continue;
                    bool isLong = t.Entry.MarketPosition == MarketPosition.Long;
                    string direction = isLong ? "Long" : "Short";

                    DateTime entryT = t.Entry.Time;
                    DateTime exitT  = t.Exit.Time;
                    string entrySess = entryT.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
                    string exitSess  = exitT.ToString ("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
                    string entryUtc  = entryT.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
                    string exitUtc   = exitT.ToUniversalTime().ToString ("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

                    double entryPrice = t.Entry.Price;
                    double exitPrice  = t.Exit.Price;
                    double points = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
                    double dollars = t.ProfitCurrency;
                    int qty = t.Quantity;

                    // Exit-reason normalization to match the dashboard's
                    // labels. NT8 generates "Stop loss"/"Profit target"
                    // for SL/TP fills; manual closes (timed exit, daily
                    // halt) come through as "Sell"/"Buy to cover" with a
                    // signal name we can introspect.
                    string rawReason = t.Exit.Name ?? "";
                    string exitReason;
                    if (rawReason == "Stop loss") exitReason = "sl";
                    else if (rawReason == "Profit target") exitReason = "tp";
                    else if (rawReason.StartsWith("TimedExit_")) exitReason = "timer";
                    else if (rawReason.StartsWith("Daily ")) exitReason = "daily";
                    else if (rawReason.StartsWith("PositionMode")) exitReason = "reverse";
                    else if (rawReason == "Sell" || rawReason == "Buy to cover") exitReason = "timer";
                    else exitReason = rawReason;

                    sb.Append(entrySess); sb.Append(',');
                    sb.Append(entryUtc);  sb.Append(',');
                    sb.Append(exitSess);  sb.Append(',');
                    sb.Append(exitUtc);   sb.Append(',');
                    sb.Append(direction); sb.Append(',');
                    sb.Append(qty.ToString(CultureInfo.InvariantCulture)); sb.Append(',');
                    sb.Append(entryPrice.ToString("F2", CultureInfo.InvariantCulture)); sb.Append(',');
                    sb.Append(exitPrice.ToString ("F2", CultureInfo.InvariantCulture)); sb.Append(',');
                    sb.Append(EscapeCsv(exitReason)); sb.Append(',');
                    sb.Append(points.ToString ("F2", CultureInfo.InvariantCulture)); sb.Append(',');
                    sb.Append(dollars.ToString("F2", CultureInfo.InvariantCulture));
                    sb.Append('\n');
                }

                File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(false));
                Print("[DslStrategyBase] Per-trade CSV written: " + outputPath + " (" + n + " trades)");
            }
            catch (Exception ex)
            {
                Print("[DslStrategyBase] ExportTradesCsv ERROR: " + ex.Message);
            }
        }

        /// <summary>
        /// Append one row to the signal-audit buffer. Called at every
        /// gate that rejects a fired candidate, plus at successful
        /// dispatch. Only invoke when `direction` actually fired this
        /// bar — otherwise the file balloons with no-signal noise.
        ///
        /// Columns capture the bar timestamp, which side fired, the
        /// verdict ("dispatched" / "rejected"), the gate that produced
        /// the verdict, and a handful of state fields useful when
        /// diffing against the dashboard's phantom trades:
        ///   - close, atr14: bar identity + indicator value parity
        ///   - bars_since_last_long_fire / _short_fire: cooldown state
        ///     for the DSL's release-on-dip lockout
        ///   - cooldown_min_remaining: minutes left on the SimRules-level
        ///     CooldownBetweenTradesBars gate (-1 if not in cooldown)
        /// </summary>
        private void RecordSignalAudit(string direction, string verdict, string reason)
        {
            try
            {
                double atr14 = DslIndicators.Atr(_bars, 0, 14);
                double bsLong  = _dsl != null ? _dsl.BarsSinceLastFiringLong(CurrentBar)  : double.NaN;
                double bsShort = _dsl != null ? _dsl.BarsSinceLastFiringShort(CurrentBar) : double.NaN;
                double cooldownMin = -1;
                if (_rules.CooldownBetweenTradesEnabled
                    && _rules.CooldownBetweenTradesBars > 0
                    && _lastKeptExitTime.HasValue)
                {
                    double elapsed = (Time[0] - _lastKeptExitTime.Value).TotalMinutes;
                    double remaining = _rules.CooldownBetweenTradesBars - elapsed;
                    cooldownMin = remaining > 0 ? remaining : 0;
                }

                var sb = new StringBuilder();
                sb.Append(Time[0].ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture)); sb.Append(',');
                sb.Append(Time[0].ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture)); sb.Append(',');
                sb.Append(CurrentBar.ToString(CultureInfo.InvariantCulture)); sb.Append(',');
                sb.Append(direction); sb.Append(',');
                sb.Append(verdict); sb.Append(',');
                sb.Append(reason); sb.Append(',');
                sb.Append(Close[0].ToString("F2", CultureInfo.InvariantCulture)); sb.Append(',');
                sb.Append(Dsl.IsFinite(atr14) ? atr14.ToString("F4", CultureInfo.InvariantCulture) : "NaN"); sb.Append(',');
                sb.Append(Dsl.IsFinite(bsLong)  ? bsLong.ToString ("F0", CultureInfo.InvariantCulture) : "Inf"); sb.Append(',');
                sb.Append(Dsl.IsFinite(bsShort) ? bsShort.ToString("F0", CultureInfo.InvariantCulture) : "Inf"); sb.Append(',');
                sb.Append(cooldownMin.ToString("F2", CultureInfo.InvariantCulture));
                _signalAuditRows.Add(sb.ToString());
            }
            catch
            {
                // Audit must never break the strategy. Swallow silently —
                // missing rows are easier to debug than a crashed run.
            }
        }

        /// <summary>
        /// Write the buffered signal-audit rows to
        /// {UserDataDir}/outgoing/signal_audit_{id}.csv. Mirrors the file-
        /// id format of ExportTradesCsv so corresponding pairs land
        /// adjacent in the outgoing/ folder. Skipped when no rows were
        /// recorded (e.g. the script never had a signal evaluate true).
        /// </summary>
        private void ExportSignalAuditCsv()
        {
            try
            {
                int n = _signalAuditRows.Count;
                if (n == 0) return;

                string outgoingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "outgoing");
                Directory.CreateDirectory(outgoingDir);

                string fileId =
                    DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture)
                    + "_" + (Name ?? "dsl") + "_" + n + "rows";
                string outputPath = Path.Combine(outgoingDir, "signal_audit_" + fileId + ".csv");

                var sb = new StringBuilder();
                sb.Append("bar_time_session,bar_time_utc,bar_index,direction,verdict,reason,");
                sb.Append("close,atr14,bars_since_last_long_fire,bars_since_last_short_fire,cooldown_min_remaining\n");
                for (int i = 0; i < n; i++)
                {
                    sb.Append(_signalAuditRows[i]);
                    sb.Append('\n');
                }
                File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(false));
                Print("[DslStrategyBase] Signal audit CSV written: " + outputPath + " (" + n + " rows)");
            }
            catch (Exception ex)
            {
                Print("[DslStrategyBase] ExportSignalAuditCsv ERROR: " + ex.Message);
            }
        }

        private static string EscapeCsv(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            bool needsQuote = false;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == ',' || c == '"' || c == '\n' || c == '\r') { needsQuote = true; break; }
            }
            if (!needsQuote) return s;
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        }

        // ─── OnBarUpdate ───────────────────────────────────────────────
        // Per-bar entry logic + per-leg post-fill checks. NT8 handles
        // the SL/TP/Trail brackets natively (we set them at entry); we
        // only need to dispatch close orders for BE and timed exit.

        protected override void OnBarUpdate()
        {
            // BarsInProgress > 0 means a tick channel update — subclass
            // override should have routed it before chaining. Defensive
            // guard so the base doesn't blow up if the subclass forgets.
            if (BarsInProgress != 0) return;

            // ── Push current bar to the rolling buffer ───────────────
            // CRITICAL: this MUST happen before the warmup gate. _bars
            // feeds DslIndicators (EMA, ATR, RollingHigh, etc.) — if we
            // only start populating after warmup, indicators see an
            // empty buffer at first signal eval and NaN-reject every
            // candidate for an additional ~200 bars (EMA(200) seeding).
            // Pushing every bar means _bars is fully warmed by the time
            // BarsRequiredToTrade clears.
            PushCurrentBar();

            // Warmup logs: print the very first bar (so users see the
            // strategy is alive even during long warmup), then every
            // _warmupLogStride bars until BarsRequiredToTrade is reached.
            if (CurrentBar < BarsRequiredToTrade)
            {
                if (!_loggedFirstBar)
                {
                    Log("[" + (Name ?? "DslStrategyBase") + "] First bar at "
                        + Time[0].ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                        + ". CurrentBar=" + CurrentBar
                        + ", BarsRequiredToTrade=" + BarsRequiredToTrade
                        + " — warming up.");
                    _loggedFirstBar = true;
                }
                else if (_warmupLogStride > 0 && CurrentBar % _warmupLogStride == 0)
                {
                    Log("[" + (Name ?? "DslStrategyBase") + "] Warmup: bar " + CurrentBar
                        + " / " + BarsRequiredToTrade);
                }
                return;
            }

            // ── Round-8 — per-bar let-dump diagnostic (one-shot) ─────
            // Print the dump config on the first post-warmup bar so the
            // user can confirm their HH:mm / date inputs were captured.
            // The actual dump dispatch was MOVED to after signal eval +
            // firings push (round-12) so bars_since(signal.X) reflects
            // the post-firing state — same convention as the dashboard's
            // strategy-evaluator dump.
            if (!_loggedFirstDumpDiag)
            {
                _loggedFirstDumpDiag = true;
                bool wouldDump = ShouldDumpThisBar();
                Print("[" + (Name ?? "DslStrategyBase") + "] DUMP-CONFIG"
                    + " DumpFromTime='" + (DumpFromTime ?? "(null)") + "'"
                    + " DumpToTime='"   + (DumpToTime   ?? "(null)") + "'"
                    + " DumpOnDate='"   + (DumpOnDate   ?? "(null)") + "'"
                    + " | first post-warmup bar: " + Time[0].ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture)
                    + " (date=" + Time[0].ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ")"
                    + " ShouldDumpThisBar()=" + wouldDump);
            }

            // ── Daily rollover ───────────────────────────────────────
            string today = Time[0].ToString("yyyy-MM-dd");
            if (today != _currentDay)
            {
                _currentDay = today;
                _dailyTradesEntered = 0;
                _dailyLosses = 0;
                _dailyRealizedPoints = 0;
                _dailyHalted = false;
            }

            // ── Per-leg post-fill checks (BE + timed exit) ──────────
            ProcessOpenLegs();

            // ── ROUND-9: Signal eval + firings push (UNCONDITIONAL) ──
            // Mirrors strategy-evaluator.ts behavior. Signals are pure
            // computation that ALWAYS runs so bars_since(signal.X) sees
            // the correct firing history. The dispatch gates below
            // (daily-halt, max-trades, cooldown, time-filter, trend,
            // filter.if, position-mode) gate ENTRY DISPATCH only.
            //
            // Long takes precedence — a bar fires long OR short, not
            // both. _ssLongCondTrue / _ssShortCondTrue now count EVERY
            // bar where the signal expr was true (not just in-window),
            // matching the dashboard's `signals` array semantics.
            bool longFired = LongCondition();
            bool shortFired = !longFired && ShortCondition();
            if (longFired)  { _dsl.OnLongFired(CurrentBar);  _ssLongCondTrue++;  }
            if (shortFired) { _dsl.OnShortFired(CurrentBar); _ssShortCondTrue++; }

            // ── Round-12 — let-dump dispatch (post signal eval) ──────
            // Fires AFTER signal eval + firings push so bars_since(signal.X)
            // reflects the just-pushed firing for THIS bar (matches the
            // dashboard's strategy-evaluator dump ordering at line 631 of
            // strategy-evaluator.ts). Without this ordering, NT8's dump
            // shows "short_elapsed=220" on bars where dashboard shows "0",
            // creating spurious diff-tool divergences.
            if (ShouldDumpThisBar()) DumpSignalSubConditions();

            // ── Daily P&L kill (post-bar realized check) ────────────
            // The dashboard's dailyLimitExactMode runs per-tick; v1 only
            // implements the post-bar variant. Surface a warning at
            // export time when ExactMode is requested but unsupported.
            if (_rules.DailyStopLossEnabled
                && _dailyRealizedPoints <= -_rules.DailyStopLossPoints)
            {
                if (!_dailyHalted)
                {
                    Log("[" + (Name ?? "DslStrategyBase") + "] DAILY SL HIT — closing all legs. realized=" + _dailyRealizedPoints.ToString("F2", CultureInfo.InvariantCulture) + "pts");
                    CloseAllOpenLegs("Daily SL");
                }
                _dailyHalted = true;
            }
            if (_rules.DailyTakeProfitEnabled
                && _dailyRealizedPoints >= _rules.DailyTakeProfitPoints)
            {
                if (!_dailyHalted)
                {
                    Log("[" + (Name ?? "DslStrategyBase") + "] DAILY TP HIT — closing all legs. realized=" + _dailyRealizedPoints.ToString("F2", CultureInfo.InvariantCulture) + "pts");
                    CloseAllOpenLegs("Daily TP");
                }
                _dailyHalted = true;
            }
            // Round-5: count bars that reach signal-eval as "post-warmup".
            _ssTotalPostWarmup++;

            if (_dailyHalted)
            {
                _ssDailyHaltSkipped++;
                if (longFired)  RecordSignalAudit("Long",  "rejected", "daily_halt");
                if (shortFired) RecordSignalAudit("Short", "rejected", "daily_halt");
                return;
            }

            // ── Per-day caps + cooldown gate ────────────────────────
            if (_rules.MaxTradesPerDayEnabled
                && _rules.MaxTradesPerDay > 0
                && _dailyTradesEntered >= _rules.MaxTradesPerDay)
            {
                _ssMaxTradesSkipped++;
                if (longFired)  RecordSignalAudit("Long",  "rejected", "max_trades_per_day");
                if (shortFired) RecordSignalAudit("Short", "rejected", "max_trades_per_day");
                return;
            }
            if (_rules.MaxLossesPerDayEnabled
                && _rules.MaxLossesPerDay > 0
                && _dailyLosses >= _rules.MaxLossesPerDay)
            {
                _ssMaxLossesSkipped++;
                if (longFired)  RecordSignalAudit("Long",  "rejected", "max_losses_per_day");
                if (shortFired) RecordSignalAudit("Short", "rejected", "max_losses_per_day");
                return;
            }
            if (_rules.CooldownBetweenTradesEnabled
                && _rules.CooldownBetweenTradesBars > 0
                && _lastKeptExitTime.HasValue)
            {
                double minutes = (Time[0] - _lastKeptExitTime.Value).TotalMinutes;
                if (minutes < _rules.CooldownBetweenTradesBars)
                {
                    _ssCooldownSkipped++;
                    if (longFired)  RecordSignalAudit("Long",  "rejected", "cooldown_between_trades");
                    if (shortFired) RecordSignalAudit("Short", "rejected", "cooldown_between_trades");
                    return;
                }
            }

            // ── Time-of-day filter ───────────────────────────────────
            if (!TimeFilterPasses(Time[0]))
            {
                if (longFired)  RecordSignalAudit("Long",  "rejected", "time_filter");
                if (shortFired) RecordSignalAudit("Short", "rejected", "time_filter");
                return;
            }
            _ssTimePassed++;

            // longFired / shortFired were computed above (round-9).
            // Filter.if directives get a clone of the baseline SimRules
            // so the 3-arg form `filter.if = (cond, rules.X = Y, …)`
            // can set per-trade overrides without mutating shared state.

            // Pre-trend-filter snapshot for verbose logging — capture
            // whether the trend filter PASSES on the candidate side.
            // Avoids double-evaluation when we then run the actual
            // gate below.
            bool trendLongOk = !longFired || TrendFilterPasses("Long");
            bool trendShortOk = !shortFired || TrendFilterPasses("Short");

            // Round-5 verbose-eval log: print the first N in-window
            // bars regardless of whether a signal fires, so the user
            // can see what conditions look like during normal operation.
            if (_evalLogCount < _evalLogLimit)
            {
                _evalLogCount++;
                Log("[" + (Name ?? "DslStrategyBase") + "] Eval @ bar " + CurrentBar
                    + " " + Time[0].ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                    + " close=" + Close[0].ToString("F2", CultureInfo.InvariantCulture)
                    + " long=" + longFired
                    + " short=" + shortFired
                    + " trendLongOk=" + trendLongOk
                    + " trendShortOk=" + trendShortOk);
            }

            // Legacy trend filter: if the DSL declared `filters.trend.*`,
            // gate the candidate side here. Without this gate NT8 fires
            // 8x more trades than the dashboard because the legacy
            // filter-block was silently dropped by the transpiler.
            if (longFired && !trendLongOk)
            {
                Log("[" + (Name ?? "DslStrategyBase") + "] Long rejected by trend filter at bar " + CurrentBar);
                _ssLongTrendRejected++;
                RecordSignalAudit("Long", "rejected", "trend_filter");
                longFired = false;
            }
            if (shortFired && !trendShortOk)
            {
                Log("[" + (Name ?? "DslStrategyBase") + "] Short rejected by trend filter at bar " + CurrentBar);
                _ssShortTrendRejected++;
                RecordSignalAudit("Short", "rejected", "trend_filter");
                shortFired = false;
            }
            if (!_loggedFirstEval)
            {
                // Dump indicator state so the user can sanity-check that
                // the bar buffer warmed correctly (bars.Count should be at
                // least BarsRequiredToTrade) and indicators returning
                // finite values. If EMA(200) is NaN here, the trend filter
                // will NaN-reject every candidate until enough bars
                // accumulate.
                double ema20 = DslIndicators.Ema(_bars, 0, 20);
                double ema200 = DslIndicators.Ema(_bars, 0, 200);
                double atr14 = DslIndicators.Atr(_bars, 0, 14);
                Log("[" + (Name ?? "DslStrategyBase") + "] First signal evaluation at bar " + CurrentBar
                    + ". _bars.Count=" + _bars.Count
                    + ", EMA(20)=" + (Dsl.IsFinite(ema20) ? ema20.ToString("F2", CultureInfo.InvariantCulture) : "NaN")
                    + ", EMA(200)=" + (Dsl.IsFinite(ema200) ? ema200.ToString("F2", CultureInfo.InvariantCulture) : "NaN")
                    + ", ATR(14)=" + (Dsl.IsFinite(atr14) ? atr14.ToString("F2", CultureInfo.InvariantCulture) : "NaN")
                    + ", LongCondition=" + longFired
                    + ", ShortCondition=" + shortFired
                    + ". Subsequent evals only logged when a signal fires.");
                _loggedFirstEval = true;
            }
            bool firedLong = false;
            if (longFired)
            {
                // Firing-tracker push moved up above (round-9) so it
                // happens regardless of dispatch-gate outcome.
                var entryRules = _rules.Clone();
                bool filterPass = LongApplyFilters(entryRules);
                if (!filterPass) { _ssLongFilterIfRejected++; RecordSignalAudit("Long", "rejected", "filter_if"); }
                bool modeAllowed = filterPass && PositionModeAllows("Long");
                if (filterPass && !modeAllowed) { _ssLongModeRejected++; RecordSignalAudit("Long", "rejected", "position_mode"); }
                Log("[" + (Name ?? "DslStrategyBase") + "] LONG signal at bar " + CurrentBar
                    + " " + Time[0].ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                    + " close=" + Close[0].ToString("F2", CultureInfo.InvariantCulture)
                    + " filterPass=" + filterPass
                    + " modeAllows=" + modeAllowed);
                if (modeAllowed)
                {
                    DispatchEntry("Long", entryRules);
                    // Round-13: anchor cooldown at entry time so subsequent
                    // signals fired BEFORE this trade exits are still gated.
                    // Mirrors the dashboard's applyTradeCountCaps behavior
                    // (zone-simulator.ts:1629) where overlapping trades are
                    // dropped because cooldown is measured against each
                    // KEPT trade's exit time — and a still-open trade has
                    // already been "kept", so it gates the next entry.
                    // The actual exit later overwrites _lastKeptExitTime
                    // with the true exit timestamp; cooldown uses whichever
                    // is most recent (entry-now or exit-later).
                    _lastKeptExitTime = Time[0];
                    firedLong = true;
                    _ssLongDispatched++;
                    RecordSignalAudit("Long", "dispatched", "");
                }
            }
            if (!firedLong && shortFired)
            {
                // Firing-tracker push moved up above (round-9).
                var entryRules = _rules.Clone();
                bool filterPass = ShortApplyFilters(entryRules);
                if (!filterPass) { _ssShortFilterIfRejected++; RecordSignalAudit("Short", "rejected", "filter_if"); }
                bool modeAllowed = filterPass && PositionModeAllows("Short");
                if (filterPass && !modeAllowed) { _ssShortModeRejected++; RecordSignalAudit("Short", "rejected", "position_mode"); }
                Log("[" + (Name ?? "DslStrategyBase") + "] SHORT signal at bar " + CurrentBar
                    + " " + Time[0].ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                    + " close=" + Close[0].ToString("F2", CultureInfo.InvariantCulture)
                    + " filterPass=" + filterPass
                    + " modeAllows=" + modeAllowed);
                if (modeAllowed)
                {
                    DispatchEntry("Short", entryRules);
                    // Round-13: see Long branch comment above.
                    _lastKeptExitTime = Time[0];
                    _ssShortDispatched++;
                    RecordSignalAudit("Short", "dispatched", "");
                }
            }
        }

        // ─── Helpers ───────────────────────────────────────────────────

        private void PushCurrentBar()
        {
            var bar = new DslBar
            {
                Time   = Time[0],
                Open   = Open[0],
                High   = High[0],
                Low    = Low[0],
                Close  = Close[0],
                Volume = (double)Volume[0],
                VolumeBid = double.NaN,
                VolumeAsk = double.NaN,
            };
            _bars.Add(bar);
            // Trim the front when over the cap. Indicators read by index
            // so we only trim if the buffer is much larger than needed
            // (saves the GC churn of copying every push).
            if (_bars.Count > MaxBars + 200)
            {
                _bars.RemoveRange(0, _bars.Count - MaxBars);
            }
        }

        /// <summary>
        /// Evaluate the time-window filter. Each window is HH:MM-HH:MM;
        /// wrap-around (From > To) is supported and treated as
        /// "after From OR before To" by the simulator — same here.
        /// </summary>
        private bool TimeFilterPasses(DateTime nowChartTime)
        {
            if (_filters == null || _filters.Time == null || !_filters.Time.Enabled) return true;
            if (_filters.Time.Windows == null || _filters.Time.Windows.Count == 0) return true;
            int curMin = nowChartTime.Hour * 60 + nowChartTime.Minute;
            foreach (var w in _filters.Time.Windows)
            {
                if (string.IsNullOrEmpty(w.From) || string.IsNullOrEmpty(w.To)) continue;
                int from = ParseHm(w.From);
                int to   = ParseHm(w.To);
                if (from < 0 || to < 0) continue;
                if (from <= to)
                {
                    if (curMin >= from && curMin < to) return true;
                }
                else
                {
                    // Wrap-around window
                    if (curMin >= from || curMin < to) return true;
                }
            }
            return false;
        }

        private static int ParseHm(string hm)
        {
            if (string.IsNullOrEmpty(hm)) return -1;
            int colon = hm.IndexOf(':');
            if (colon < 0) return -1;
            int h, m;
            if (!int.TryParse(hm.Substring(0, colon), out h)) return -1;
            if (!int.TryParse(hm.Substring(colon + 1), out m)) return -1;
            return h * 60 + m;
        }

        /// <summary>
        /// Round-8 — should the per-bar let-dump fire on this bar? Reads
        /// the three diagnostic NinjaScriptProperties (DumpFromTime,
        /// DumpToTime, DumpOnDate). Dump is fully disabled when either
        /// time bound is empty (the default) — keeps the hot path fast
        /// for production runs. When a date is set, the bar must fall on
        /// that date AND in the [From, To] window. When date is empty,
        /// every bar in the [From, To] window across all sessions fires.
        /// Wrap-around (From > To) is supported and matches the time-
        /// filter semantics.
        /// </summary>
        protected bool ShouldDumpThisBar()
        {
            if (string.IsNullOrEmpty(DumpFromTime) || string.IsNullOrEmpty(DumpToTime)) return false;
            int from = ParseHm(DumpFromTime);
            int to   = ParseHm(DumpToTime);
            if (from < 0 || to < 0) return false;
            DateTime t = Time[0];
            if (!string.IsNullOrEmpty(DumpOnDate))
            {
                // String compare yyyy-MM-dd == yyyy-MM-dd (the format the
                // user specifies). Avoids TZ ambiguity vs DateTime parsing.
                string today = t.ToString("yyyy-MM-dd");
                if (today != DumpOnDate) return false;
            }
            int curMin = t.Hour * 60 + t.Minute;
            if (from <= to) return curMin >= from && curMin <= to;
            return curMin >= from || curMin <= to;
        }

        /// <summary>
        /// Trend filter — gates the candidate by price vs the fast (default
        /// EMA(20)) and slow (default EMA(200)) moving averages. Each leg
        /// can independently require "with" / "against" / "any". When
        /// disabled or both legs are "any", returns true unconditionally.
        ///
        /// NaN-as-fail: if either MA hasn't warmed up, reject. Mirrors the
        /// dashboard's PresetFilterEvaluator behavior.
        /// </summary>
        private bool TrendFilterPasses(string direction)
        {
            if (_filters == null || _filters.Trend == null || !_filters.Trend.Enabled) return true;
            bool isLong = direction == "Long";
            double close = Close[0];
            double fast  = MaByType(_filters.Trend.FastType, _filters.Trend.FastPeriod);
            double slow  = MaByType(_filters.Trend.SlowType, _filters.Trend.SlowPeriod);
            if (!CheckTrend(close, fast, _filters.Trend.Ema20Mode,  isLong)) return false;
            if (!CheckTrend(close, slow, _filters.Trend.Ema200Mode, isLong)) return false;
            return true;
        }

        private double MaByType(string type, int period)
        {
            // Type-dispatched MA helper. Mirrors PresetIndicators.MaByType
            // — defaults to EMA when an unrecognized type slips in (matches
            // the dashboard's MA fallback path).
            if (type == "sma") return DslIndicators.Sma(_bars, 0, period);
            return DslIndicators.Ema(_bars, 0, period);
        }

        private static bool CheckTrend(double close, double ma, string mode, bool isLong)
        {
            // "any" — no constraint. Skip the NaN guard since we don't read ma.
            if (string.IsNullOrEmpty(mode) || mode == "any") return true;
            if (!Dsl.IsFinite(ma) || !Dsl.IsFinite(close)) return false;
            if (mode == "with")    return isLong ? close > ma : close < ma;
            if (mode == "against") return isLong ? close < ma : close > ma;
            return true;
        }

        /// <summary>
        /// Position-mode gate. Mirrors zone-simulator.ts:380-387 +
        /// applyPositionMode at zone-simulator.ts:1980-2030.
        ///   default        — each entry is independent (always fire)
        ///   null           — skip if anything is open
        ///   add-null       — add same direction; skip if opposite is open
        ///   add-close      — close opposite-direction; same-direction stacks
        ///   close-previous — close any open entries before opening a new one
        ///   reverse-null   — flat → open normally (no reverse tag);
        ///                    opposing open → close opposing + open new
        ///                    (tagged as reverse-entry so scaling walk resets);
        ///                    same-direction open → drop the candidate.
        ///   reverse-add    — opposing open → flip (close opposing + open new
        ///                    with reverse tag); same-direction open → stack
        ///                    normally (no reverse tag).
        ///
        /// IsReverseEntry: returned via _pendingReverseEntry for the next
        /// dispatch — drives ScalingResetOnReverse behavior in DispatchEntry.
        /// </summary>
        private bool PositionModeAllows(string newDirection)
        {
            int activeLongs = 0, activeShorts = 0;
            foreach (var leg in _legs.Values)
            {
                if (leg.Direction == "Long") activeLongs++;
                else activeShorts++;
            }
            bool anyOpposing = (newDirection == "Long" && activeShorts > 0)
                            || (newDirection == "Short" && activeLongs > 0);
            bool anySameDir  = (newDirection == "Long" && activeLongs > 0)
                            || (newDirection == "Short" && activeShorts > 0);
            string mode = (_rules.PositionMode ?? "default").ToLowerInvariant();
            _pendingReverseEntry = false;
            switch (mode)
            {
                case "default":
                    return true;
                case "null":
                    return activeLongs == 0 && activeShorts == 0;
                case "add-null":
                    if (anyOpposing) return false;
                    return true;
                case "add-close":
                    if (anyOpposing)
                        CloseSideOpenLegs(newDirection == "Long" ? "Short" : "Long",
                                          "PositionMode add-close");
                    return true;
                case "close-previous":
                    CloseAllOpenLegs("PositionMode close-previous");
                    return true;
                case "reverse-null":
                    // Flat → fire normally (no reverse tag). Mirrors
                    // zone-simulator.ts:1947 where the no-conflict
                    // short-circuit pushes the candidate before the mode
                    // switch runs.
                    // Same-direction-only → drop. Mirrors zone-simulator.ts:1998
                    // (`if (!anyOpposing) break;` inside the switch — only
                    // reachable when something is open, so !anyOpposing
                    // implies same-direction-only).
                    // Any opposing open → flip: close the opposing side, tag
                    // this entry as a reverse so the scaling walk resets, and
                    // fire. Same-direction legs (if any co-exist alongside
                    // opposing) keep running, mirroring the dashboard's
                    // per-leg loop that skips `direction === candDir`.
                    if (!anyOpposing) return !anySameDir;
                    CloseSideOpenLegs(newDirection == "Long" ? "Short" : "Long",
                                      "PositionMode reverse-null");
                    _pendingReverseEntry = true;
                    return true;
                case "reverse-add":
                    if (anyOpposing)
                    {
                        CloseSideOpenLegs(newDirection == "Long" ? "Short" : "Long",
                                          "PositionMode reverse-add");
                        _pendingReverseEntry = true;
                    }
                    // same-direction or flat: stack normally (no reverse tag)
                    return true;
                default:
                    return true;
            }
        }

        // Set by PositionModeAllows when the upcoming entry should be
        // tagged as a reverse-entry. Read by DispatchEntry to seed the
        // leg's IsReverseEntry flag (drives ScalingResetOnReverse in the
        // dashboard simulator; v1 ignores it for sizing since scaling
        // is not yet implemented, but we keep the flag for forward
        // compatibility).
        private bool _pendingReverseEntry;

        private void DispatchEntry(string direction, SimRulesData entryRules)
        {
            _legCounter++;
            string signalName = (direction == "Long")
                ? "DslLong_" + _legCounter
                : "DslShort_" + _legCounter;
            int qty = 1; // Scaling not yet implemented — fixed size for v1.

            // Snapshot ATR(14) at entry to drive any ATR-adjusted brackets.
            // Same period the dashboard uses for ATR-based adjustments.
            double atr = DslIndicators.Atr(_bars, 0, 14);
            // Set per-leg brackets BEFORE submitting the order. NT8's
            // PerEntryExecution mode binds them to the named signal on
            // its first execution. The rules object passed here may
            // already include per-trade overrides from filter.if 3-arg
            // assignments — that's intentional; this entry's brackets
            // reflect the filter outcome.
            ApplyBrackets(signalName, direction, atr, entryRules);

            // Carry the reverse-entry tag from PositionModeAllows so
            // OnExecutionUpdate can stamp it on the leg when it fills.
            // Cleared back to false after the fill is consumed.
            _pendingReverseEntryForFill = _pendingReverseEntry;
            _pendingReverseEntry = false;

            Log("[" + (Name ?? "DslStrategyBase") + "] Dispatching " + direction
                + " entry signal=" + signalName
                + " qty=" + qty
                + " ATR=" + (Dsl.IsFinite(atr) ? atr.ToString("F2", CultureInfo.InvariantCulture) : "NaN")
                + " SLpts=" + (entryRules.StopLossEnabled ? (entryRules.StopLossPoints + entryRules.SlAtrAdjust * (Dsl.IsFinite(atr) ? atr : 0)).ToString("F2", CultureInfo.InvariantCulture) : "off")
                + " TPpts=" + (entryRules.TakeProfitEnabled ? (entryRules.TakeProfitPoints + entryRules.TpAtrAdjust * (Dsl.IsFinite(atr) ? atr : 0)).ToString("F2", CultureInfo.InvariantCulture) : "off")
                + " reverseEntry=" + _pendingReverseEntryForFill);

            if (direction == "Long")
                EnterLong(qty, signalName);
            else
                EnterShort(qty, signalName);
        }

        // Drained by OnExecutionUpdate when the corresponding entry order
        // fills, so the leg's IsReverseEntry flag is stamped at the actual
        // fill (not at signal time, since fills can be deferred / rejected).
        private bool _pendingReverseEntryForFill;

        /// <summary>
        /// Set SL / TP / Trailing brackets on the named signal.
        ///
        /// Two paths:
        ///
        /// - `_rules.ExitAtBarClose=false` (legacy / NT8-native semantics):
        ///   call NT8's SetStopLoss / SetProfitTarget / SetTrailStop so
        ///   the broker fills exits at the trigger price intra-bar.
        ///
        /// - `_rules.ExitAtBarClose=true` (DASHBOARD DEFAULT):
        ///   stash the bracket points on the pending entry. After the
        ///   entry fills, OnExecutionUpdate converts them to absolute
        ///   price levels. ProcessOpenLegs then watches each bar's
        ///   High/Low and fires ExitLong/Short on bar CLOSE when the
        ///   trigger is touched — so the recorded fill price is at the
        ///   trigger-bar's close (matches the dashboard's
        ///   exitAtBarClose=true semantics).
        ///
        ///   We also keep a wide native SL (2× the user's SL distance)
        ///   as a catastrophic-gap safety net so a flash crash doesn't
        ///   blow through our manual stop while we wait for next bar.
        ///
        /// `entryRules` is the per-trade rules instance (clone of
        /// baseline + any filter.if overrides). Always use it, never
        /// `_rules`, so per-trade rule mutations take effect.
        /// </summary>
        private void ApplyBrackets(string signalName, string direction, double atr, SimRulesData entryRules)
        {
            double slPoints = entryRules.StopLossEnabled
                ? Math.Max(TickSize, entryRules.StopLossPoints + (Dsl.IsFinite(atr) ? entryRules.SlAtrAdjust * atr : 0))
                : 0;
            double tpPoints = entryRules.TakeProfitEnabled
                ? Math.Max(TickSize, entryRules.TakeProfitPoints + (Dsl.IsFinite(atr) ? entryRules.TpAtrAdjust * atr : 0))
                : 0;
            double trailPoints = entryRules.TrailingStopEnabled
                ? Math.Max(TickSize, entryRules.TrailingStopPoints + (Dsl.IsFinite(atr) ? entryRules.TrailAtrAdjust * atr : 0))
                : 0;

            // Stash the points so OnExecutionUpdate can convert to absolute
            // levels and stamp them on the leg. Indexed by signal name so
            // multiple stacked entries each get the right values.
            _pendingBrackets[signalName] = new PendingBrackets
            {
                SlPoints    = slPoints,
                TpPoints    = tpPoints,
                TrailPoints = trailPoints,
            };

            if (entryRules.ExitAtBarClose)
            {
                // Catastrophic-gap safety net only — wide enough that the
                // bar-close handler normally fires first. Skip TP / trail
                // entirely; we manage those manually.
                if (slPoints > 0)
                    SetStopLoss(signalName, CalculationMode.Ticks, PointsToTicks(slPoints * 2), false);
            }
            else
            {
                // Legacy NT8-native behavior — fill exits at trigger price.
                if (slPoints > 0)
                    SetStopLoss(signalName, CalculationMode.Ticks, PointsToTicks(slPoints), false);
                if (tpPoints > 0)
                    SetProfitTarget(signalName, CalculationMode.Ticks, PointsToTicks(tpPoints));
                if (trailPoints > 0)
                    SetTrailStop(signalName, CalculationMode.Ticks, PointsToTicks(trailPoints), false);
            }
        }

        // Pending bracket points keyed by signal name. Drained when
        // OnExecutionUpdate converts them to absolute levels on the leg.
        private struct PendingBrackets
        {
            public double SlPoints;
            public double TpPoints;
            public double TrailPoints;
        }
        private readonly Dictionary<string, PendingBrackets> _pendingBrackets =
            new Dictionary<string, PendingBrackets>();

        private int PointsToTicks(double points)
        {
            if (TickSize <= 0) return 1;
            return Math.Max(1, (int)Math.Round(points / TickSize, MidpointRounding.AwayFromZero));
        }

        /// <summary>
        /// Per-bar BE-move / timed-exit check on each open leg. Modifying
        /// SL via SetStopLoss with the same signal name updates the
        /// existing per-leg bracket; NT8 cancels the old stop and emits
        /// a new one at the new price. Timed-exit uses ExitLong/ExitShort
        /// to close the named signal entirely.
        /// </summary>
        private void ProcessOpenLegs()
        {
            if (_legs.Count == 0) return;
            // Snapshot keys before iterating — we may mutate _legs via
            // ExitLong/ExitShort dispatching that triggers OnExecutionUpdate
            // on the next tick.
            var keys = new List<string>(_legs.Keys);
            bool exitAtBarClose = _rules.ExitAtBarClose;
            foreach (var k in keys)
            {
                DslLeg leg;
                if (!_legs.TryGetValue(k, out leg)) continue;
                if (leg.CloseDispatched) continue;

                // Update peak P&L (favorable excursion).
                bool isLong = leg.Direction == "Long";
                double curPts = isLong
                    ? Close[0] - leg.EntryPrice
                    : leg.EntryPrice - Close[0];
                if (curPts > leg.PeakPnlPoints) leg.PeakPnlPoints = curPts;

                // ── exitAtBarClose=true: SL / TP / Trail handled here ───
                // We watch each bar's High / Low to detect a trigger
                // touch, but record the exit at this bar's close (the
                // dashboard's exitAtBarClose=true convention). ExitLong/
                // ExitShort fires a market order that fills at next bar's
                // open in NT8, which is a small residual drift but much
                // smaller than the wick-size error we'd accumulate by
                // letting NT8's native intra-bar SL/TP fill at the
                // trigger price.
                if (exitAtBarClose && !leg.CloseDispatched)
                {
                    double hi = High[0];
                    double lo = Low[0];
                    string exitReason = null;

                    // Trail level update — long ratchets up, short ratchets down.
                    if (leg.HasTrail)
                    {
                        if (isLong)
                        {
                            double newTrail = Close[0] - leg.TrailDistancePts;
                            if (newTrail > leg.TrailStopLevel) leg.TrailStopLevel = newTrail;
                        }
                        else
                        {
                            double newTrail = Close[0] + leg.TrailDistancePts;
                            if (newTrail < leg.TrailStopLevel) leg.TrailStopLevel = newTrail;
                        }
                    }

                    if (leg.TakeProfitLevel > 0)
                    {
                        bool tpHit = isLong ? hi >= leg.TakeProfitLevel : lo <= leg.TakeProfitLevel;
                        if (tpHit) exitReason = "Profit target";
                    }
                    if (exitReason == null && leg.StopLossLevel > 0)
                    {
                        bool slHit = isLong ? lo <= leg.StopLossLevel : hi >= leg.StopLossLevel;
                        if (slHit) exitReason = "Stop loss";
                    }
                    if (exitReason == null && leg.HasTrail && leg.TrailStopLevel > 0)
                    {
                        bool trailHit = isLong ? lo <= leg.TrailStopLevel : hi >= leg.TrailStopLevel;
                        if (trailHit) exitReason = "Stop loss"; // trail also uses Stop loss reason for parity
                    }

                    if (exitReason != null)
                    {
                        Log("[" + (Name ?? "DslStrategyBase") + "] Manual exit (" + exitReason
                            + ") at bar " + CurrentBar + " " + Time[0].ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                            + " close=" + Close[0].ToString("F2", CultureInfo.InvariantCulture)
                            + " for " + leg.SignalName);
                        if (isLong) ExitLong(leg.Qty, exitReason, leg.SignalName);
                        else ExitShort(leg.Qty, exitReason, leg.SignalName);
                        leg.CloseDispatched = true;
                        continue;
                    }
                }

                // Break-even move: when peak crosses the trigger threshold
                // (BreakEvenTrigger + BeAtrAdjust*atr), move SL to entry.
                if (_rules.BreakEvenEnabled && !leg.BeTriggered)
                {
                    double trigger = _rules.BreakEvenTrigger
                        + (Dsl.IsFinite(leg.ZoneAtr) ? _rules.BeAtrAdjust * leg.ZoneAtr : 0);
                    if (leg.PeakPnlPoints >= trigger)
                    {
                        // Move our manual SL level to entry too (so the
                        // bar-close-exit path on the next bar uses the
                        // BE-shifted level), and update NT8's safety net.
                        leg.StopLossLevel = leg.EntryPrice;
                        SetStopLoss(leg.SignalName, CalculationMode.Price, leg.EntryPrice, false);
                        leg.BeTriggered = true;
                    }
                }

                // Timed exit: close after N CLOSED bars held.
                if (_rules.TimedExitEnabled
                    && _rules.TimedExitBars > 0
                    && CurrentBar - leg.EntryBarIndex >= _rules.TimedExitBars)
                {
                    if (isLong) ExitLong(leg.Qty, "TimedExit_" + leg.SignalName, leg.SignalName);
                    else ExitShort(leg.Qty, "TimedExit_" + leg.SignalName, leg.SignalName);
                    leg.CloseDispatched = true;
                }
            }
        }

        private void CloseAllOpenLegs(string reason)
        {
            foreach (var leg in _legs.Values)
            {
                if (leg.CloseDispatched) continue;
                if (leg.Direction == "Long")
                    ExitLong(leg.Qty, reason + "_" + leg.SignalName, leg.SignalName);
                else
                    ExitShort(leg.Qty, reason + "_" + leg.SignalName, leg.SignalName);
                leg.CloseDispatched = true;
            }
        }

        private void CloseSideOpenLegs(string side, string reason)
        {
            foreach (var leg in _legs.Values)
            {
                if (leg.CloseDispatched) continue;
                if (leg.Direction != side) continue;
                if (side == "Long")
                    ExitLong(leg.Qty, reason + "_" + leg.SignalName, leg.SignalName);
                else
                    ExitShort(leg.Qty, reason + "_" + leg.SignalName, leg.SignalName);
                leg.CloseDispatched = true;
            }
        }

        // ─── Execution callbacks ───────────────────────────────────────

        protected override void OnExecutionUpdate(
            Execution execution, string executionId, double price, int quantity,
            MarketPosition marketPosition, string orderId, DateTime time)
        {
            if (execution == null || execution.Order == null) return;
            string signalName = execution.Order.Name ?? "";
            // OrderAction tells us entry vs exit.
            var action = execution.Order.OrderAction;
            bool isEntry = action == OrderAction.Buy || action == OrderAction.SellShort;
            bool isExit  = action == OrderAction.Sell || action == OrderAction.BuyToCover;

            if (isEntry)
            {
                // Find the entry signal name — NT8 strips trailing indices
                // off in some cases, but our names are unique anyway.
                string legKey = signalName;
                if (string.IsNullOrEmpty(legKey)) return;
                double atrAtEntry = DslIndicators.Atr(_bars, 0, 14);
                // _pendingReverseEntryForFill was set by DispatchEntry when
                // PositionModeAllows decided the entry was a reverse. We
                // consume it here so the next entry doesn't carry the flag
                // accidentally.
                bool reverseEntry = _pendingReverseEntryForFill;
                _pendingReverseEntryForFill = false;

                // Convert the stashed bracket points to absolute price
                // levels using the actual fill price. ProcessOpenLegs
                // watches each bar's High/Low and fires ExitLong/Short on
                // bar CLOSE when triggered (exitAtBarClose=true semantics).
                PendingBrackets bp;
                _pendingBrackets.TryGetValue(legKey, out bp);
                _pendingBrackets.Remove(legKey);
                bool isLong = action == OrderAction.Buy;
                double slLevel = bp.SlPoints > 0
                    ? (isLong ? price - bp.SlPoints : price + bp.SlPoints)
                    : 0;
                double tpLevel = bp.TpPoints > 0
                    ? (isLong ? price + bp.TpPoints : price - bp.TpPoints)
                    : 0;
                // Initial trail level — for a long, the trail starts at
                // entry - trailPoints and ratchets UP as price moves favorably.
                // For a short, starts at entry + trailPoints and ratchets DOWN.
                double trailLevel = bp.TrailPoints > 0
                    ? (isLong ? price - bp.TrailPoints : price + bp.TrailPoints)
                    : 0;
                _legs[legKey] = new DslLeg
                {
                    SignalName    = legKey,
                    Direction     = isLong ? "Long" : "Short",
                    EntryPrice    = price,
                    EntryBarTime  = time,
                    EntryBarIndex = CurrentBar,
                    Qty           = quantity,
                    ZoneAtr       = atrAtEntry,
                    BeTriggered   = false,
                    PeakPnlPoints = 0,
                    CloseDispatched = false,
                    IsReverseEntry  = reverseEntry,
                    StopLossLevel    = slLevel,
                    TakeProfitLevel  = tpLevel,
                    TrailStopLevel   = trailLevel,
                    TrailDistancePts = bp.TrailPoints,
                    HasTrail         = bp.TrailPoints > 0,
                };
                _dailyTradesEntered++;

                Log("[" + (Name ?? "DslStrategyBase") + "] ENTRY filled: " + legKey
                    + " " + ((action == OrderAction.Buy) ? "Long" : "Short")
                    + " " + quantity + " @ " + price.ToString("F2", CultureInfo.InvariantCulture)
                    + " at " + time.ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                    + " ATR=" + (Dsl.IsFinite(atrAtEntry) ? atrAtEntry.ToString("F2", CultureInfo.InvariantCulture) : "NaN")
                    + " dailyTrades=" + _dailyTradesEntered);
            }
            else if (isExit)
            {
                // The exit's "FromEntrySignal" carries the entry's signal
                // name. Use that to look up our leg state.
                string entryName = execution.Order.FromEntrySignal ?? signalName;
                DslLeg leg;
                if (_legs.TryGetValue(entryName, out leg))
                {
                    bool isLong = leg.Direction == "Long";
                    double pts = isLong ? price - leg.EntryPrice : leg.EntryPrice - price;
                    pts -= _rules.SlippagePoints * 2; // round-trip slippage cost
                    _dailyRealizedPoints += pts * Math.Max(1, leg.Qty);
                    if (pts < 0) _dailyLosses++;
                    _lastKeptExitTime = time;
                    _legs.Remove(entryName);

                    Log("[" + (Name ?? "DslStrategyBase") + "] EXIT filled: " + entryName
                        + " @ " + price.ToString("F2", CultureInfo.InvariantCulture)
                        + " (entry=" + leg.EntryPrice.ToString("F2", CultureInfo.InvariantCulture) + ")"
                        + " pts=" + pts.ToString("F2", CultureInfo.InvariantCulture)
                        + " reason='" + (execution.Order.Name ?? "?") + "'"
                        + " dailyRealized=" + _dailyRealizedPoints.ToString("F2", CultureInfo.InvariantCulture)
                        + " dailyLosses=" + _dailyLosses);
                }
            }
        }
    }
}
