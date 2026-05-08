// PresetStrategy.cs
//
// Generic NinjaScript Strategy that loads a dashboard preset JSON in
// State.DataLoaded and executes it via PresetExecutor. The three test
// strategies (NQTest03, CLTest01, NQTest03NoTimeNoDL) inherit from this
// and only set the ConfigPath default — every line of decision logic lives
// in the executor + supporting AddOns.
//
// Runtime split:
//   - PresetExecutor.cs (AddOns) holds all decision-making + state.
//   - This file does NT8 plumbing: bar buffer maintenance, order dispatch,
//     position-fill detection, optional tick subscription for daily-exact.
//
// Ordering: we use Calculate.OnBarClose so the executor sees CLOSED bars
// only — same convention the dashboard's auto-trader uses (it ignores the
// in-progress live bar). Daily-exact mode adds AddDataSeries for ticks so
// the executor's OnTick watchdog gets called each price update without
// waiting for the next bar close.

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.AddOns;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    /// <summary>
    /// Preset-driven strategy. Loads a JSON config from disk and executes it.
    /// Subclass to hardcode a ConfigPath default (so each variant shows up
    /// as its own selectable Strategy in the SA dropdown without the user
    /// having to type a path).
    /// </summary>
    public class PresetStrategy : Strategy
    {
        // ─── Loaded preset + executor ──────────────────────────────────────
        // Set in State.DataLoaded; both null on disarm/load failure.
        protected Preset _preset;
        protected PresetExecutor _executor;

        // ─── Supabase status reporter ─────────────────────────────────────
        // Heartbeats live status, position, daily stats, and errors up to the
        // live_strategies / strategy_logs Supabase tables so the dashboard can
        // see what's deployed and how each instance is doing without polling NT.
        // Created in State.DataLoaded after the preset loads; null when the
        // preset failed to load (we still report the failure via a transient
        // reporter spun up just for the error log entry).
        protected StrategyReporter _reporter;

        // Brackets for the most recent leg — lets the reporter ship a SL/TP
        // price alongside the open-position snapshot. Per-leg in NT8, but for
        // the snapshot we just publish whichever was most recently set; the
        // dashboard will treat these as approximate when stacked entries diverge.
        private double? _lastEntrySlPrice;
        private double? _lastEntryTpPrice;

        // ─── Warning-state tracking ───────────────────────────────────────
        // Per-session flags so warn-level events fire once instead of every
        // bar. _dailyLossWarnedDay is the yyyy-MM-dd we last warned for so
        // a fresh day reopens the warning channel. _hadRecentError feeds the
        // auto-disable heuristic on State.Terminated. _expectedEntryPrice
        // caches the bar-close at order placement so OnExecutionUpdate can
        // compute slippage against the actual fill.
        private bool _warmupWarnedThisSession = false;
        private string _dailyLossWarnedDay = "";
        private bool _hadRecentError = false;
        private DateTime? _lastErrorTimeUtc = null;
        private NinjaTrader.Cbi.ConnectionStatus _lastPriceStatus = NinjaTrader.Cbi.ConnectionStatus.Connected;
        private readonly Dictionary<string, double> _expectedEntryPrice =
            new Dictionary<string, double>();

        // ─── Bar-series cache (thread-safe access from PingReporter) ──────
        // NT8's bar accessors (Time, Close, Open, etc.) are NOT thread-safe.
        // When PingReporter runs on the StrategyMonitor's ThreadPool thread,
        // reading Time[0] / Close[0] directly can throw, return DateTime.MinValue,
        // or return stale data. For test02CL specifically, a MinValue read
        // (01/01/0001 00:00) lands INSIDE the 00:00–08:00 window and flips
        // in_window=true, then the next OnBarUpdate flips it back — pure
        // background-thread flapping.
        //
        // Fix: snapshot the latest bar time/close into volatile fields on
        // every OnBarUpdate (strategy thread only). PingReporter reads from
        // these caches and derives current chart-time as
        //   _lastBarTime + (DateTime.UtcNow - _lastBarTimeRealUtc)
        // which advances correctly across timezones because bar time and UTC
        // tick at the same rate.
        //
        // DateTime is a value type but writes aren't atomic on 32-bit; on the
        // 64-bit NT8 install they are. Using `volatile` only on the reference
        // would do nothing for a value type — the existing-snapshot pattern
        // (one writer thread, multiple readers) is safe in practice for our use.
        private DateTime _lastBarTime;
        private DateTime _lastBarTimeRealUtc;
        private double _lastBarClose;
        private bool _hasBarCache;

        // ─── Static instance registry ─────────────────────────────────────
        // Every PresetStrategy registers itself here once it has a live
        // reporter so a global StrategyMonitor AddOn can iterate them and
        // force a heartbeat every minute — this is the safety net for cases
        // where OnBarUpdate isn't firing (overnight session, no ticks) and
        // for fast detection of crashed/disconnected instances.
        //
        // WeakReference so a strategy that's GC'd before Terminated fires
        // (extremely rare, but possible during NT shutdown) doesn't pin
        // memory or cause use-after-terminate from the monitor thread.
        private static readonly List<WeakReference<PresetStrategy>> _liveInstances =
            new List<WeakReference<PresetStrategy>>();
        private static readonly object _liveLock = new object();

        /// <summary>
        /// Snapshot of all currently-registered live PresetStrategy instances.
        /// Compacts dead WeakReferences as a side effect so the registry
        /// doesn't grow unbounded after a long session of stops/starts.
        /// </summary>
        public static List<PresetStrategy> GetLiveInstances()
        {
            var result = new List<PresetStrategy>();
            lock (_liveLock)
            {
                for (int i = _liveInstances.Count - 1; i >= 0; i--)
                {
                    PresetStrategy s;
                    if (_liveInstances[i].TryGetTarget(out s) && s != null)
                        result.Add(s);
                    else
                        _liveInstances.RemoveAt(i);
                }
            }
            return result;
        }

        private static void RegisterInstance(PresetStrategy s)
        {
            if (s == null) return;
            lock (_liveLock)
            {
                _liveInstances.Add(new WeakReference<PresetStrategy>(s));
            }
        }

        private static void UnregisterInstance(PresetStrategy s)
        {
            if (s == null) return;
            lock (_liveLock)
            {
                for (int i = _liveInstances.Count - 1; i >= 0; i--)
                {
                    PresetStrategy other;
                    if (!_liveInstances[i].TryGetTarget(out other) || ReferenceEquals(other, s))
                        _liveInstances.RemoveAt(i);
                }
            }
        }

        /// <summary>
        /// Force a heartbeat upsert to Supabase from outside the strategy
        /// thread. Called by StrategyMonitor every 60s for every registered
        /// instance — guarantees `last_heartbeat_at` keeps moving even when
        /// no bars are arriving (overnight, weekend, paused chart).
        ///
        /// CRITICAL: this method runs on the ThreadPool, NOT the strategy
        /// thread. Touching bar-series accessors (Time[], Close[], etc.)
        /// would be a data race — they're not thread-safe in NT8 and can
        /// throw, return DateTime.MinValue, or return stale values. We
        /// only read Position (safe enough — Cbi.Position fields are atomic
        /// for read access) and the bar-series cache fields populated by
        /// OnBarUpdate on the strategy thread.
        /// </summary>
        public void PingReporter()
        {
            if (_reporter == null) return;
            try
            {
                // ── In-window evaluation ───────────────────────────────────
                // Derive current chart-session time from the cached bar time
                // plus elapsed wall-clock — bar time and UTC tick at the same
                // rate so this stays accurate across timezones without any
                // explicit conversion. If we have no bar yet (warmup hasn't
                // completed), leave in_window untouched so the reporter keeps
                // the previously-published value rather than guessing.
                if (_hasBarCache)
                {
                    DateTime nowChartTime = _lastBarTime + (DateTime.UtcNow - _lastBarTimeRealUtc);
                    _reporter.SetInWindow(EvaluateInWindow(nowChartTime));
                }

                // ── Position snapshot ──────────────────────────────────────
                // Position.MarketPosition / AveragePrice / Quantity are
                // thread-safe-ish for read access (NT8's Cbi types are
                // designed to be polled from the GUI thread too). Unrealized
                // P&L uses GetUnrealizedProfitLoss which CAN call into the
                // bar series — feed it the cached close so we never touch
                // Close[0] directly off-thread.
                bool inPos = false;
                string posDir = null;
                try
                {
                    if (Position != null)
                    {
                        inPos = Position.MarketPosition != MarketPosition.Flat;
                        if (inPos)
                            posDir = Position.MarketPosition == MarketPosition.Long ? "Long" : "Short";
                    }
                }
                catch { /* ignore — defensive */ }

                if (inPos && Position != null)
                {
                    double avgPx = 0;
                    int qty = 1;
                    double unrealized = 0;
                    try { avgPx = Position.AveragePrice; } catch { /* ignore */ }
                    try { qty = Math.Max(1, Position.Quantity); } catch { /* ignore */ }
                    if (_hasBarCache)
                    {
                        try { unrealized = Position.GetUnrealizedProfitLoss(PerformanceUnit.Currency, _lastBarClose); }
                        catch { /* ignore */ }
                    }
                    _reporter.SetPosition(posDir, qty, avgPx, _lastEntrySlPrice, _lastEntryTpPrice, unrealized);
                }
                else
                {
                    _reporter.SetPosition(null, 0, null, null, null, 0);
                }
            }
            catch { /* swallow — we still want to push the timestamp */ }

            // Force the upsert. Even if everything above failed, this updates
            // last_heartbeat_at so the dashboard knows the instance is alive.
            try { _reporter.PushNow(); } catch { /* ignore */ }
        }

        // ─── Rolling bar buffer ────────────────────────────────────────────
        // The executor needs full history every call. Cap at MaxBars so
        // long backtest sessions don't grow unbounded; 1500 covers EMA200
        // warmup + lookback + a generous safety margin.
        private const int MaxBars = 1500;
        private readonly List<PresetBar> _bars = new List<PresetBar>();

        // ─── Position fill tracking ────────────────────────────────────────
        // OnExecutionUpdate is the canonical "fill happened" hook in NT8 —
        // it fires synchronously with the actual fill price + qty for every
        // entry and exit. We use OrderAction (Buy/SellShort = entry,
        // Sell/BuyToCover = exit) to detect entry vs exit per-execution,
        // which works correctly when stacked positions fill (the previous
        // _lastPosition flat-state approach missed all but the first/last
        // legs of a stacked sequence — see Fix B in the parity plan).
        //
        // Each entry has a UNIQUE signal name (PresetLong_N / PresetShort_N)
        // so SetStopLoss / SetProfitTarget / SetTrailStop attach per-leg
        // brackets and don't overwrite each other. We track the entry price
        // per signal name so the exit-side execution can compute that leg's
        // exitPoints without touching SystemPerformance.
        private int _legCounter = 0;
        private readonly Dictionary<string, double> _entryPricePerLeg =
            new Dictionary<string, double>();
        private readonly Dictionary<string, int> _entryQtyPerLeg =
            new Dictionary<string, int>();
        private readonly Dictionary<string, string> _entryDirPerLeg =
            new Dictionary<string, string>();
        // First time per day at which a close_all action was dispatched —
        // used by ExportTradesCsv to label a "Sell"/"Buy to cover" exit as
        // "daily" (post-halt force-close) vs "timer" (pre-halt timed exit).
        // Keyed by yyyy-MM-dd of the bar that triggered the halt.
        private readonly Dictionary<string, DateTime> _dailyHaltTimeByDay =
            new Dictionary<string, DateTime>();

        #region Parameters

        /// <summary>
        /// Absolute filesystem path to the preset JSON file. Subclasses
        /// override DefaultConfigPath() to set the default; users can
        /// override at SA configure time if they want to point at a
        /// different preset.
        /// </summary>
        [NinjaScriptProperty]
        [Display(Name = "Config Path",
                 Description = "Absolute path to the preset JSON file (defaults set per-strategy).",
                 Order = 1, GroupName = "1. Preset")]
        public string ConfigPath { get; set; }

        /// <summary>
        /// Run ID for backtest auto-export. BacktestRunner sets this when
        /// firing a headless run; manual runs leave it empty.
        /// </summary>
        [NinjaScriptProperty]
        [Display(Name = "Run ID",
                 Description = "Backtest run ID — set by BacktestRunner. Leave empty for manual runs.",
                 Order = 2, GroupName = "2. Auto Export")]
        public string RunId { get; set; }

        /// <summary>
        /// When true, write SystemPerformance JSON to outgoing/ at termination.
        /// </summary>
        [NinjaScriptProperty]
        [Display(Name = "Auto Export",
                 Description = "Write backtest results JSON at State.Terminated.",
                 Order = 3, GroupName = "2. Auto Export")]
        public bool AutoExport { get; set; }

        /// <summary>
        /// Threshold for the daily-loss warning written to strategy_logs.
        /// One warn-level row per session day when realized P&amp;L crosses
        /// -threshold. Set to 0 to disable.
        /// </summary>
        [NinjaScriptProperty]
        [Display(Name = "Daily Loss Warn Threshold ($)",
                 Description = "Emit a warning to strategy_logs when realized daily loss exceeds this many dollars (0 disables).",
                 Order = 1, GroupName = "3. Warnings")]
        public double DailyLossWarnThreshold { get; set; }

        /// <summary>
        /// Threshold for the entry-slippage warning. Compares the bar-close
        /// price at signal time against the actual fill price; warns when
        /// the absolute difference exceeds this many points. Set to 0 to disable.
        /// Default 3 points covers NQ/ES; tighten for low-tick instruments
        /// like CL (suggested 0.5–1.0).
        /// </summary>
        [NinjaScriptProperty]
        [Display(Name = "Slippage Warn (points)",
                 Description = "Emit a warning when entry fill differs from signal-bar close by more than this many points (0 disables).",
                 Order = 2, GroupName = "3. Warnings")]
        public double SlippageWarnPoints { get; set; }

        #endregion

        /// <summary>
        /// Subclass hook — return the default config path for this variant.
        /// PresetStrategy itself returns "" so SetDefaults leaves the
        /// property blank for the generic selectable.
        /// </summary>
        protected virtual string DefaultConfigPath() => "";

        #region State Management

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description = "Loads a dashboard preset JSON and trades it natively in NinjaTrader.";
                Name        = "PresetStrategy";

                // Settings copied from NQBuyAndHold.cs — the proven baseline
                // for our other strategies. Any deviation here breaks parity
                // with the simulator, so don't change without thinking.
                Calculate                  = Calculate.OnBarClose;
                // High enough that the dashboard's `add-null` and `add-close`
                // position modes can fire multiple stacked same-direction
                // entries without NT8 dropping them. With EntriesPerDirection=1
                // the second add gets silently rejected — breaks parity with
                // the simulator which tracks each entry independently. Cap of
                // 10 covers ScalingMaxSize=5 plus headroom; NT8 still respects
                // any per-fill SL/TP brackets via StopTargetHandling below.
                EntriesPerDirection        = 10;
                EntryHandling              = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = false;
                ExitOnSessionCloseSeconds  = 30;
                IsFillLimitOnTouch         = false;
                MaximumBarsLookBack        = MaximumBarsLookBack.TwoHundredFiftySix;
                OrderFillResolution        = OrderFillResolution.Standard;
                Slippage                   = 2;
                StartBehavior              = StartBehavior.WaitUntilFlat;
                TimeInForce                = TimeInForce.Gtc;
                TraceOrders                = false;
                RealtimeErrorHandling      = RealtimeErrorHandling.StopCancelClose;
                StopTargetHandling         = StopTargetHandling.PerEntryExecution;

                // EMA(200) needs ~300 bars to stabilize.
                BarsRequiredToTrade = 300;

                ConfigPath = DefaultConfigPath();
                RunId      = "";
                AutoExport = false;
                // Conservative defaults — $2k daily loss matches the user's
                // ask; 3pts slippage is loose enough not to spam during normal
                // CME futures sessions but catches off-hours bad fills.
                DailyLossWarnThreshold = 2000.0;
                SlippageWarnPoints     = 3.0;
            }
            else if (State == State.Configure)
            {
                // We MUST add the tick series here (before DataLoaded) so
                // OnMarketData receives ticks. Only add if the chosen
                // preset uses daily-exact mode — costs cycles otherwise.
                // We have to peek at the preset to know, but the file
                // load happens in DataLoaded. Resolution: try-load here
                // too; if it works, add the series; if not, defer logging
                // to DataLoaded.
                Preset peek = TryLoadPreset();
                if (peek != null && peek.Rules != null && peek.Rules.DailyLimitExactMode)
                {
                    // 1-tick series so OnMarketData fires per price update.
                    AddDataSeries(BarsPeriodType.Tick, 1);
                }
            }
            else if (State == State.DataLoaded)
            {
                _preset = TryLoadPreset();
                if (_preset == null)
                {
                    Print("[PresetStrategy] FAILED to load preset from " + ConfigPath + " — disabling.");
                    // Still report the failure to Supabase so the dashboard's
                    // strategy_logs table surfaces "preset load failed" rows.
                    // We spin up a one-shot reporter just long enough to log
                    // and immediately Stop — no heartbeat row stays alive.
                    TryReportPresetLoadFailure();
                    return;
                }
                _executor = new PresetExecutor(_preset);
                Print(string.Format("[PresetStrategy] Loaded preset \"{0}\" (strategy={1}) from {2}",
                                    _preset.Name, _preset.StrategyId, ConfigPath));

                // Skip Supabase reporting during backtests / Strategy Analyzer
                // runs — those produce massive churn on the live_strategies
                // table and aren't real deployments. Only report when the
                // strategy is being initialized for live (non-historical) use.
                // SystemPerformance backtests instantiate the strategy with
                // SystemPerformance != null; live charts have it null until
                // a real-time tick arrives. Use Account.Name presence as a
                // proxy: SA runs use the synthetic "Backtest" account, real
                // accounts have a different name. Defensive: never throw.
                if (ShouldReportLiveStatus())
                {
                    _reporter = new StrategyReporter();
                    string tf = "";
                    try { tf = BarsPeriod != null ? BarsPeriod.ToString() : ""; } catch { /* ignore */ }
                    string instr = "";
                    try { instr = Instrument != null ? Instrument.FullName : ""; } catch { /* ignore */ }
                    string acct = "";
                    try { acct = Account != null ? Account.Name : ""; } catch { /* ignore */ }
                    // NT8 doesn't expose a public Version constant on Globals;
                    // skip the version field (column allows null). The host
                    // machine name from StrategyReporter.SafeMachineName is
                    // sufficient to identify which VM/environment is running.
                    string ntVer = "";

                    _reporter.Start(
                        strategyName:   Name ?? "PresetStrategy",
                        presetName:     _preset.Name ?? "",
                        presetPath:     ConfigPath ?? "",
                        instrument:     instr,
                        accountName:    acct,
                        chartTimeframe: tf,
                        ntVersion:      ntVer);

                    var meta = new System.Collections.Generic.Dictionary<string, object>();
                    meta["strategy_id"] = _preset.StrategyId ?? "";
                    meta["config_path"] = ConfigPath ?? "";
                    _reporter.Log("info", "lifecycle",
                        "Preset loaded: " + (_preset.Name ?? ""),
                        meta);

                    // Register with the global registry so StrategyMonitor
                    // can ping us every 60s. Done AFTER reporter.Start so the
                    // monitor doesn't see a half-initialized instance.
                    RegisterInstance(this);
                }
            }
            else if (State == State.Realtime)
            {
                if (_reporter != null) _reporter.SetNtState("Realtime");
            }
            else if (State == State.Historical)
            {
                if (_reporter != null) _reporter.SetNtState("Historical");
            }
            else if (State == State.Terminated)
            {
                if (AutoExport && !string.IsNullOrEmpty(RunId))
                    ExportResults();
                // Always emit the per-trade CSV — used by the dashboard parity
                // diff tool. Cheap (just iterates SystemPerformance.AllTrades),
                // no dependency on AutoExport. Falls back to a timestamp-based
                // filename when RunId is empty so manual SA runs still land
                // somewhere predictable.
                ExportTradesCsv();

                // Final heartbeat: mark the row terminated so the dashboard
                // knows this instance is no longer running.
                if (_reporter != null)
                {
                    // Auto-disable heuristic: NT8's RealtimeErrorHandling.
                    // StopCancelClose halts the strategy on errors. We don't
                    // get an explicit "you were auto-stopped" callback, but
                    // a Terminated transition within 30s of a logged error
                    // is almost always NT pulling the plug. Tag the
                    // termination with a louder log so the dashboard's
                    // error feed catches it.
                    string stopReason = "State.Terminated";
                    if (_hadRecentError && _lastErrorTimeUtc.HasValue)
                    {
                        double secsSinceError = (DateTime.UtcNow - _lastErrorTimeUtc.Value).TotalSeconds;
                        if (secsSinceError <= 30)
                        {
                            var meta = new Dictionary<string, object>();
                            meta["seconds_since_error"] = secsSinceError;
                            _reporter.Log("warn", "lifecycle",
                                "Strategy terminated within " + secsSinceError.ToString("F1") +
                                "s of last error — likely auto-disabled by NT8 RealtimeErrorHandling",
                                meta);
                            stopReason = "AutoDisabled";
                        }
                    }
                    _reporter.Stop(stopReason);
                    _reporter = null;
                }

                // Always remove from the registry, even if reporter was never
                // created (preset-load-failure path). Idempotent — safe to call
                // when this instance was never registered.
                UnregisterInstance(this);
            }
        }

        /// <summary>
        /// Heuristic: report status to Supabase only for live deployments, not
        /// for Strategy Analyzer / Playback / multi-pass loads. Strategy Analyzer
        /// backtests run with HistoricalDataPath set or with a non-live account
        /// like "Backtest"/"Optimizer"; we filter those out. False here also
        /// disables the post-trade RecordTradeClosed flush so backtests don't
        /// pollute the live counters.
        ///
        /// Conservative default: when in doubt, report. The user explicitly
        /// asked for "any and all deployed strategies" — false-positive reports
        /// (a backtest creating a transient row) are benign and easy to filter
        /// dashboard-side, while false-negatives (a real deployment going
        /// untracked) defeat the whole feature.
        /// </summary>
        private bool ShouldReportLiveStatus()
        {
            try
            {
                // BacktestRunner sets RunId — those are headless SA passes that
                // explicitly opt out of live reporting.
                if (!string.IsNullOrEmpty(RunId)) return false;
                // SA's synthetic accounts use names containing "backtest" or
                // "playback" or "optim" by NT8 convention. Cheap substring check.
                string a = "";
                try { a = Account != null ? (Account.Name ?? "") : ""; } catch { /* ignore */ }
                string al = a.ToLowerInvariant();
                if (al.Contains("backtest") || al.Contains("playback") || al.Contains("optim"))
                    return false;
                return true;
            }
            catch
            {
                return true;
            }
        }

        /// <summary>
        /// One-shot error log when the preset JSON fails to parse. Spins up a
        /// reporter, posts a single error row, then stops — no heartbeat stays
        /// alive because the strategy itself is disabled.
        /// </summary>
        private void TryReportPresetLoadFailure()
        {
            if (!ShouldReportLiveStatus()) return;
            try
            {
                var oneShot = new StrategyReporter();
                string instr = "";
                try { instr = Instrument != null ? Instrument.FullName : ""; } catch { /* ignore */ }
                string acct = "";
                try { acct = Account != null ? Account.Name : ""; } catch { /* ignore */ }
                oneShot.Start(
                    strategyName:   Name ?? "PresetStrategy",
                    presetName:     "",
                    presetPath:     ConfigPath ?? "",
                    instrument:     instr,
                    accountName:    acct,
                    chartTimeframe: "",
                    ntVersion:      "");
                var meta = new System.Collections.Generic.Dictionary<string, object>();
                meta["config_path"] = ConfigPath ?? "";
                oneShot.Log("error", "lifecycle",
                    "Preset load failed — strategy disabled",
                    meta);
                // Mark terminated immediately so the row reflects the broken
                // state instead of staying "active" forever.
                oneShot.Stop("PresetLoadFailed");
            }
            catch { /* ignore — best effort */ }
        }

        /// <summary>
        /// Attempt to load the preset JSON. Returns null on any failure
        /// (file missing, parse error) — caller logs and disarms.
        /// Wrapped in try/catch so a malformed preset never crashes NT8.
        /// </summary>
        private Preset TryLoadPreset()
        {
            try
            {
                if (string.IsNullOrEmpty(ConfigPath)) return null;
                return PresetLoader.LoadFromFile(ConfigPath);
            }
            catch (Exception ex)
            {
                Print("[PresetStrategy] Preset load error: " + ex.Message);
                return null;
            }
        }

        #endregion

        #region Core Bar Processing Loop

        protected override void OnBarUpdate()
        {
            // Strategy disabled — no preset loaded.
            if (_executor == null) return;

            // Only act on the primary series (BarsInProgress 0). The optional
            // tick series fires OnBarUpdate too, but we ignore it; tick logic
            // lives in OnMarketData.
            if (BarsInProgress != 0) return;

            if (CurrentBar < BarsRequiredToTrade)
            {
                // Warmup not satisfied — warn ONCE per session, but only if
                // the strategy is currently inside its trading window. Out-
                // of-window warmup is silent because the strategy isn't
                // supposed to be trading anyway.
                if (!_warmupWarnedThisSession && _reporter != null)
                {
                    try
                    {
                        bool? inWin = EvaluateInWindow(Time[0]);
                        if (inWin == true)
                        {
                            _warmupWarnedThisSession = true;
                            int barsRemaining = BarsRequiredToTrade - CurrentBar;
                            var meta = new Dictionary<string, object>();
                            meta["current_bar"] = CurrentBar;
                            meta["bars_required"] = BarsRequiredToTrade;
                            meta["bars_remaining"] = barsRemaining;
                            _reporter.Log("warn", "warmup",
                                "Warmup incomplete inside trading window — " +
                                    barsRemaining + " bars remaining before strategy will trade",
                                meta);
                        }
                    }
                    catch (Exception ex)
                    {
                        Print("[PresetStrategy] warmup warn error: " + ex.Message);
                    }
                }
                return;
            }

            // Append latest closed bar to rolling buffer.
            _bars.Add(new PresetBar
            {
                Time   = Time[0],
                Open   = Open[0],
                High   = High[0],
                Low    = Low[0],
                Close  = Close[0],
                Volume = Volume[0],
            });
            if (_bars.Count > MaxBars) _bars.RemoveAt(0);

            // Snapshot bar-series values for the StrategyMonitor's PingReporter
            // path. Background threads MUST NOT touch Time[]/Close[] directly
            // — they're not thread-safe in NT8. The cache lets the monitor
            // ping with thread-safe reads (DateTime / double value-type fields).
            _lastBarTime = Time[0];
            _lastBarTimeRealUtc = DateTime.UtcNow;
            _lastBarClose = Close[0];
            _hasBarCache = true;

            // Pull current position state from NT8.
            bool inPosition = Position.MarketPosition != MarketPosition.Flat;
            string posDir = Position.MarketPosition == MarketPosition.Long  ? "Long"
                          : Position.MarketPosition == MarketPosition.Short ? "Short"
                          : null;

            var actions = _executor.OnBar(_bars, inPosition, posDir);
            foreach (var a in actions) Dispatch(a);

            // Report current position + in-window status to Supabase. Cheap —
            // SetPosition / SetInWindow only mutate in-memory snapshot fields;
            // the actual HTTP push runs on the heartbeat timer (or PushNow()
            // fires ad-hoc on entry/exit/error). Wrapped in try/catch so any
            // HTTP / serialization issue can never break the trading loop.
            try { ReportBarSnapshot(inPosition, posDir); }
            catch (Exception ex)
            {
                Print("[PresetStrategy] ReportBarSnapshot error: " + ex.Message);
            }
        }

        /// <summary>
        /// Update the StrategyReporter snapshot with the latest open-position
        /// state and a fresh evaluation of the preset's time-of-day window.
        /// Called from OnBarUpdate — runs once per closed bar on the strategy
        /// thread; the actual HTTP push to Supabase is debounced behind the
        /// reporter's heartbeat timer.
        /// </summary>
        private void ReportBarSnapshot(bool inPosition, string posDir)
        {
            if (_reporter == null) return;

            // Time-of-day window — null when no time filter is configured so
            // the dashboard can distinguish "always trading" from "currently
            // outside window". The eval mirrors PresetFilterEvaluator's
            // multi-window OR-semantics + wrap-around handling.
            _reporter.SetInWindow(EvaluateInWindow(Time[0]));

            // Open position snapshot. Use NT8's authoritative Position values
            // rather than the executor's leg map so the dashboard always sees
            // the actual broker-confirmed state. Unrealized P&L pulled via
            // GetUnrealizedProfitLoss(Currency) so the dashboard sees account
            // currency directly without re-deriving from points.
            if (inPosition)
            {
                double avgPx = Position.AveragePrice;
                int qty = Math.Max(1, Position.Quantity);
                double unrealized = 0;
                try { unrealized = Position.GetUnrealizedProfitLoss(PerformanceUnit.Currency, Close[0]); }
                catch { /* ignore — defensive */ }
                _reporter.SetPosition(
                    direction:        posDir,
                    quantity:         qty,
                    entryPrice:       avgPx,
                    stopPrice:        _lastEntrySlPrice,
                    takeProfitPrice:  _lastEntryTpPrice,
                    unrealizedPnl:    unrealized);
            }
            else
            {
                // Flat — clear the position fields and reset bracket cache so
                // a stale SL/TP from the previous trade doesn't leak into the
                // next one's first heartbeat.
                _reporter.SetPosition(null, 0, null, null, null, 0);
                _lastEntrySlPrice = null;
                _lastEntryTpPrice = null;
            }
        }

        /// <summary>
        /// Evaluate the preset's TimeFilter against a bar timestamp. Returns
        /// null when no time filter is configured so the dashboard can render
        /// "always-on". Mirrors PresetFilterEvaluator's multi-window OR
        /// semantics and wrap-around handling — kept inline here so we don't
        /// have to expose evaluator internals just for status reporting.
        /// </summary>
        private bool? EvaluateInWindow(DateTime barTime)
        {
            if (_preset == null || _preset.Filters == null || _preset.Filters.Time == null)
                return null;
            var tf = _preset.Filters.Time;
            if (!tf.Enabled) return null;

            int barMin = barTime.Hour * 60 + barTime.Minute;
            var windows = (tf.Windows != null && tf.Windows.Count > 0)
                ? tf.Windows
                : new List<TimeWindow> { new TimeWindow { From = tf.From, To = tf.To } };

            foreach (var w in windows)
            {
                int from = ParseHM(w.From);
                int to   = ParseHM(w.To);
                if (from <= to)
                {
                    if (barMin >= from && barMin <= to) return true;
                }
                else
                {
                    // Wrap-around midnight (e.g. 22:00–06:00).
                    if (barMin >= from || barMin <= to) return true;
                }
            }
            return false;
        }

        /// <summary>HH:MM → minutes-since-midnight. Defaults to 0 on a bad input
        /// (matches PresetFilterEvaluator's lenient parse).</summary>
        private static int ParseHM(string t)
        {
            if (string.IsNullOrEmpty(t)) return 0;
            var parts = t.Split(':');
            int h = 0, m = 0;
            if (parts.Length > 0) int.TryParse(parts[0], out h);
            if (parts.Length > 1) int.TryParse(parts[1], out m);
            return h * 60 + m;
        }

        #endregion

        #region Order Dispatch

        /// <summary>
        /// Translate a PresetAction into NT8 order calls. Each entry gets a
        /// UNIQUE signal name (PresetLong_N / PresetShort_N) so stacked legs
        /// from positionMode="add-null" attach independent SL/TP/Trail
        /// brackets — shared signal names overwrite each other.
        /// Per-leg exit / modify actions carry their target signal name on
        /// the action itself.
        /// </summary>
        private void Dispatch(PresetAction a)
        {
            if (a == null) return;

            switch (a.Kind)
            {
                case "buy_long":
                {
                    int qty = Math.Max(1, a.Qty);
                    string sigName = "PresetLong_" + (++_legCounter);
                    // Cache signal-bar close as the expected fill reference;
                    // OnExecutionUpdate compares the actual fill against this
                    // to flag large slippage (off-hours bad fills, low-liquidity).
                    _expectedEntryPrice[sigName] = Close[0];
                    EnterLong(qty, sigName);
                    if (a.SlPoints.HasValue && a.SlPoints.Value > 0)
                        SetStopLoss(sigName, CalculationMode.Ticks, a.SlPoints.Value / TickSize, false);
                    if (a.TpPoints.HasValue && a.TpPoints.Value > 0)
                        SetProfitTarget(sigName, CalculationMode.Ticks, a.TpPoints.Value / TickSize);
                    // Trail and SL are mutually exclusive in NT8 — SetTrailStop
                    // overrides any SetStopLoss for the same signal. Call it
                    // last so the trailing distance wins over a fixed SL.
                    if (a.TrailEnabled && a.TrailPoints.HasValue && a.TrailPoints.Value > 0)
                        SetTrailStop(sigName, CalculationMode.Ticks, a.TrailPoints.Value / TickSize, false);
                    Print("[Preset] LONG " + sigName + " x" + qty + " — " + a.Reason);

                    // Stash bracket prices (absolute, derived from Close[0])
                    // so the reporter snapshot can publish SL/TP alongside the
                    // open position. Approximations are fine — they'll be
                    // refined to the exact fill price by OnExecutionUpdate.
                    _lastEntrySlPrice = a.SlPoints.HasValue && a.SlPoints.Value > 0
                        ? (double?)(Close[0] - a.SlPoints.Value) : null;
                    _lastEntryTpPrice = a.TpPoints.HasValue && a.TpPoints.Value > 0
                        ? (double?)(Close[0] + a.TpPoints.Value) : null;

                    if (_reporter != null)
                    {
                        var meta = new Dictionary<string, object>();
                        meta["signal"] = sigName;
                        meta["qty"] = qty;
                        meta["sl_pts"] = a.SlPoints.HasValue ? (object)a.SlPoints.Value : null;
                        meta["tp_pts"] = a.TpPoints.HasValue ? (object)a.TpPoints.Value : null;
                        _reporter.Log("info", "order",
                            "ENTER LONG " + sigName + " x" + qty + " — " + (a.Reason ?? ""),
                            meta);
                    }
                    break;
                }

                case "sell_short":
                {
                    int qty = Math.Max(1, a.Qty);
                    string sigName = "PresetShort_" + (++_legCounter);
                    _expectedEntryPrice[sigName] = Close[0];
                    EnterShort(qty, sigName);
                    if (a.SlPoints.HasValue && a.SlPoints.Value > 0)
                        SetStopLoss(sigName, CalculationMode.Ticks, a.SlPoints.Value / TickSize, false);
                    if (a.TpPoints.HasValue && a.TpPoints.Value > 0)
                        SetProfitTarget(sigName, CalculationMode.Ticks, a.TpPoints.Value / TickSize);
                    if (a.TrailEnabled && a.TrailPoints.HasValue && a.TrailPoints.Value > 0)
                        SetTrailStop(sigName, CalculationMode.Ticks, a.TrailPoints.Value / TickSize, false);
                    Print("[Preset] SHORT " + sigName + " x" + qty + " — " + a.Reason);

                    // Bracket prices are inverted for shorts — stop sits ABOVE
                    // entry, target sits BELOW. Mirror of the long branch above.
                    _lastEntrySlPrice = a.SlPoints.HasValue && a.SlPoints.Value > 0
                        ? (double?)(Close[0] + a.SlPoints.Value) : null;
                    _lastEntryTpPrice = a.TpPoints.HasValue && a.TpPoints.Value > 0
                        ? (double?)(Close[0] - a.TpPoints.Value) : null;

                    if (_reporter != null)
                    {
                        var meta = new Dictionary<string, object>();
                        meta["signal"] = sigName;
                        meta["qty"] = qty;
                        meta["sl_pts"] = a.SlPoints.HasValue ? (object)a.SlPoints.Value : null;
                        meta["tp_pts"] = a.TpPoints.HasValue ? (object)a.TpPoints.Value : null;
                        _reporter.Log("info", "order",
                            "ENTER SHORT " + sigName + " x" + qty + " — " + (a.Reason ?? ""),
                            meta);
                    }
                    break;
                }

                case "close":
                {
                    // Per-leg close — exits only the entry tied to the
                    // signal name on the action. Used by timed-exit on
                    // stacked legs so trade-1's timer doesn't kill trade-2.
                    if (string.IsNullOrEmpty(a.SignalName)) break;
                    if (a.SignalName.StartsWith("PresetLong"))
                        ExitLong(a.SignalName);
                    else if (a.SignalName.StartsWith("PresetShort"))
                        ExitShort(a.SignalName);
                    Print("[Preset] CLOSE " + a.SignalName + " — " + a.Reason);
                    break;
                }

                case "close_all":
                {
                    // Whole-position flatten — used by the daily-exact
                    // watchdog when day P&L crosses the kill threshold.
                    //
                    // CRITICAL: must close per-leg by signal name. Bare
                    // ExitLong()/ExitShort() generate exit orders with an
                    // empty FromEntrySignal, so OnExecutionUpdate can't
                    // match the fill back to the registered ActiveEntry,
                    // and _activeEntries keeps stale legs forever. Stale
                    // legs persist across day rollover and re-trigger
                    // daily-exact halts on later days even though NT8's
                    // actual position is flat — that's why 03-18+ trades
                    // were silently blocked after 03-16's halt fired.
                    if (_executor != null)
                    {
                        // Snapshot first — calling Exit*(...) doesn't
                        // remove from _activeEntries synchronously; that
                        // happens via OnExecutionUpdate when the fill
                        // confirms. Iterating Values directly while
                        // dispatching is safe but defensive copying is
                        // safer in case of any reentrancy.
                        var legs = new List<ActiveEntry>(_executor.ActiveEntries.Values);
                        foreach (var leg in legs)
                        {
                            if (leg.Direction == "Long")
                                ExitLong(leg.SignalName);
                            else if (leg.Direction == "Short")
                                ExitShort(leg.SignalName);
                        }
                    }
                    // Record the halt boundary so ExportTradesCsv can
                    // label post-halt exits as "daily" instead of "timer".
                    string haltDayKey = Time[0].ToString("yyyy-MM-dd");
                    if (!_dailyHaltTimeByDay.ContainsKey(haltDayKey))
                        _dailyHaltTimeByDay[haltDayKey] = Time[0];
                    Print("[Preset] CLOSE_ALL — " + a.Reason);
                    break;
                }

                case "modify_sl":
                {
                    if (!a.Price.HasValue) break;
                    // Per-leg SL move — BE adjust targets a specific stacked
                    // entry, not the aggregate position. SignalName is set
                    // by the executor when emitting the action.
                    if (string.IsNullOrEmpty(a.SignalName)) break;
                    SetStopLoss(a.SignalName, CalculationMode.Price, a.Price.Value, false);
                    Print("[Preset] MODIFY_SL " + a.SignalName + " " +
                          a.Price.Value.ToString("F2") + " — " + a.Reason);
                    break;
                }
            }
        }

        #endregion

        #region Position Fill Detection

        /// <summary>
        /// NT8's per-fill callback. Fires for every execution with the
        /// actual fill price + quantity. We classify each execution by
        /// OrderAction (Buy/SellShort = entry, Sell/BuyToCover = exit) and
        /// route it to the executor PER LEG (per signal name) so stacked
        /// add-null entries each get their own ActiveEntry / OnPositionClosed
        /// callback. The previous flat-state-transition approach only
        /// observed the FIRST stacked entry and the LAST stacked exit, so
        /// scaling and timed-exit broke for trades 2..N.
        /// </summary>
        protected override void OnExecutionUpdate(Execution execution, string executionId,
                                                   double price, int quantity,
                                                   MarketPosition marketPosition,
                                                   string orderId, DateTime time)
        {
            if (_executor == null) return;
            if (execution == null || execution.Order == null) return;

            OrderAction action = execution.Order.OrderAction;

            // Entry execution — Buy (long entry) or SellShort. Order.Name
            // is the per-leg signal name we passed to EnterLong/EnterShort.
            if (action == OrderAction.Buy || action == OrderAction.SellShort)
            {
                string entrySig = execution.Order.Name ?? "";
                if (string.IsNullOrEmpty(entrySig)) return;
                string dir = action == OrderAction.Buy ? "Long" : "Short";
                int qty = Math.Max(1, quantity);
                _executor.OnPositionFilled(entrySig, dir, price, qty);
                _entryPricePerLeg[entrySig] = price;
                _entryQtyPerLeg[entrySig]   = qty;
                _entryDirPerLeg[entrySig]   = dir;

                // Slippage warning: compare actual fill against the bar-close
                // we cached when we placed the order. Only fires for legs we
                // actually originated; bracket auto-cancels and external
                // orders won't have a cached expected price.
                if (_reporter != null && SlippageWarnPoints > 0
                    && _expectedEntryPrice.TryGetValue(entrySig, out double expected))
                {
                    double slippage = Math.Abs(price - expected);
                    if (slippage > SlippageWarnPoints)
                    {
                        var meta = new Dictionary<string, object>();
                        meta["signal"] = entrySig;
                        meta["direction"] = dir;
                        meta["expected_price"] = expected;
                        meta["actual_fill"] = price;
                        meta["slippage_points"] = slippage;
                        _reporter.Log("warn", "order",
                            string.Format("Large slippage on {0} {1}: {2:F2} pts (expected {3:F2}, filled {4:F2})",
                                dir, entrySig, slippage, expected, price),
                            meta);
                    }
                    _expectedEntryPrice.Remove(entrySig);
                }
                return;
            }

            // Exit execution — Sell (long exit) or BuyToCover (short exit).
            // FromEntrySignal is NT8's canonical link from an exit order to
            // the entry it's closing. SetStopLoss / SetProfitTarget /
            // ExitLong(signalName) all populate it. Fall back to Order.Name
            // if FromEntrySignal is empty (defensive).
            if (action == OrderAction.Sell || action == OrderAction.BuyToCover)
            {
                string entrySig = execution.Order.FromEntrySignal;
                if (string.IsNullOrEmpty(entrySig)) entrySig = execution.Order.Name ?? "";
                if (string.IsNullOrEmpty(entrySig)) return;
                if (!_entryPricePerLeg.TryGetValue(entrySig, out double entryPx)) return;
                _entryQtyPerLeg.TryGetValue(entrySig, out int entryQty);
                _entryDirPerLeg.TryGetValue(entrySig, out string entryDir);
                bool wasLong = entryDir == "Long";
                double exitPoints = wasLong ? price - entryPx : entryPx - price;
                int legQty = Math.Max(1, entryQty);
                _executor.OnPositionClosed(entrySig, exitPoints, legQty);
                _entryPricePerLeg.Remove(entrySig);
                _entryQtyPerLeg.Remove(entrySig);
                _entryDirPerLeg.Remove(entrySig);

                // Report realized P&L for this leg to the dashboard. Convert
                // points → dollars via the instrument's PointValue (e.g. 20
                // for NQ). NT8 also has SystemPerformance.AllTrades which
                // could be used for authoritative dollars, but that's an
                // aggregate snapshot — pulling per-fill from it would race
                // with the trade settling. Per-leg math is consistent with
                // how we build TradeRecord elsewhere in the AddOns layer.
                if (_reporter != null)
                {
                    double pointVal = 1.0;
                    try
                    {
                        if (Instrument != null && Instrument.MasterInstrument != null)
                            pointVal = Instrument.MasterInstrument.PointValue;
                    }
                    catch { /* ignore — defensive */ }
                    double dollars = exitPoints * pointVal * legQty;
                    _reporter.RecordTradeClosed(dollars, time);

                    var meta = new Dictionary<string, object>();
                    meta["signal"] = entrySig;
                    meta["direction"] = entryDir ?? "";
                    meta["qty"] = legQty;
                    meta["entry_price"] = entryPx;
                    meta["exit_price"] = price;
                    meta["points"] = exitPoints;
                    meta["dollars"] = dollars;
                    string lvl = dollars >= 0 ? "info" : "info";
                    _reporter.Log(lvl, "order",
                        string.Format("EXIT {0} {1} pts={2:F2} ${3:F2}",
                            entryDir ?? "?", entrySig, exitPoints, dollars),
                        meta);

                    // Daily-loss threshold check — fires once per session day.
                    // Compares cumulative realized P&L (read from reporter,
                    // which already maintains the running daily total) against
                    // the configured negative threshold.
                    if (DailyLossWarnThreshold > 0)
                    {
                        double pnlToday = _reporter.RealizedPnlToday;
                        if (pnlToday <= -DailyLossWarnThreshold)
                        {
                            string today = time.ToString("yyyy-MM-dd");
                            if (!string.Equals(_dailyLossWarnedDay, today, StringComparison.Ordinal))
                            {
                                _dailyLossWarnedDay = today;
                                var lossMeta = new Dictionary<string, object>();
                                lossMeta["realized_pnl_today"] = pnlToday;
                                lossMeta["threshold"] = -DailyLossWarnThreshold;
                                _reporter.Log("warn", "risk",
                                    string.Format("Daily loss threshold breached: ${0:F2} (threshold ${1:F2})",
                                        pnlToday, -DailyLossWarnThreshold),
                                    lossMeta);
                            }
                        }
                    }
                }
                return;
            }
        }

        /// <summary>
        /// NT8 fires OnOrderUpdate for every state transition on a tracked order
        /// (Working → Filled / Rejected / Cancelled / etc.). We watch for the
        /// terminal "Rejected" state and surface it as an error log so the
        /// dashboard's strategy_logs feed shows broker rejections immediately.
        /// All other transitions are ignored (no log spam).
        /// </summary>
        protected override void OnOrderUpdate(NinjaTrader.Cbi.Order order, double limitPrice,
            double stopPrice, int quantity, int filled, double averageFillPrice,
            NinjaTrader.Cbi.OrderState orderState, DateTime time, NinjaTrader.Cbi.ErrorCode error,
            string nativeError)
        {
            if (_reporter == null) return;
            try
            {
                string oname = order != null ? (order.Name ?? "") : "";
                bool isOurEntry = oname.StartsWith("PresetLong_") || oname.StartsWith("PresetShort_");

                // ── Rejected ──────────────────────────────────────────────
                // Always error-level. Tracks _hadRecentError so the Terminated
                // handler can flag likely auto-disable.
                if (orderState == NinjaTrader.Cbi.OrderState.Rejected)
                {
                    _hadRecentError = true;
                    _lastErrorTimeUtc = DateTime.UtcNow;
                    var meta = new Dictionary<string, object>();
                    meta["order_name"] = oname;
                    meta["error_code"] = error.ToString();
                    meta["native_error"] = nativeError ?? "";
                    meta["limit_price"] = limitPrice;
                    meta["stop_price"] = stopPrice;
                    meta["quantity"] = quantity;
                    _reporter.Log("error", "order",
                        "Order rejected: " + (oname.Length > 0 ? oname : "?") +
                        " — " + (nativeError ?? error.ToString()),
                        meta);
                    return;
                }

                // ── Cancelled ─────────────────────────────────────────────
                // NT8 routinely cancels the OTHER bracket order when one fills
                // (StopTargetHandling.PerEntryExecution). Filtering by our
                // entry-signal naming pattern restricts the warn to "an entry
                // I dispatched got cancelled before fully filling" — actual
                // operational issues, not normal bracket cleanup.
                if (orderState == NinjaTrader.Cbi.OrderState.Cancelled)
                {
                    if (isOurEntry && filled < quantity)
                    {
                        var meta = new Dictionary<string, object>();
                        meta["order_name"] = oname;
                        meta["filled"] = filled;
                        meta["quantity"] = quantity;
                        meta["fill_price"] = averageFillPrice;
                        _reporter.Log("warn", "order",
                            "Entry order cancelled before full fill: " + oname +
                            " (filled " + filled + "/" + quantity + ")",
                            meta);
                    }
                    return;
                }

                // ── Partial fill ──────────────────────────────────────────
                // Always warn. PartFilled can fire multiple times as fills
                // trickle in; we accept a few duplicate rows in exchange for
                // catching every partial-fill event.
                if (orderState == NinjaTrader.Cbi.OrderState.PartFilled)
                {
                    var meta = new Dictionary<string, object>();
                    meta["order_name"] = oname;
                    meta["filled"] = filled;
                    meta["quantity"] = quantity;
                    meta["fill_price"] = averageFillPrice;
                    _reporter.Log("warn", "order",
                        "Order partial fill: " + filled + "/" + quantity + " — " +
                        (oname.Length > 0 ? oname : "?"),
                        meta);
                    return;
                }
            }
            catch (Exception ex)
            {
                Print("[PresetStrategy] OnOrderUpdate report error: " + ex.Message);
            }
        }

        /// <summary>
        /// NT8 fires this when the strategy's price/data feed connection
        /// state changes. We watch for transitions AWAY from Connected and
        /// surface a warn-level row. Transitions back TO Connected are silent
        /// (no point spamming logs with "all good now").
        ///
        /// Note: this callback only covers the price/data connection.
        /// The order/account connection lives on Account.ConnectionStatus —
        /// we'd need to subscribe to Account.ConnectionStatusUpdate separately
        /// to track that one. For now the price feed is the most common drop
        /// (the order connection is more stable), so we ship just this and
        /// can layer the account-level check later if it turns out to matter.
        /// </summary>
        protected override void OnConnectionStatusUpdate(NinjaTrader.Cbi.ConnectionStatusEventArgs connectionStatusUpdate)
        {
            if (_reporter == null || connectionStatusUpdate == null) return;
            try
            {
                NinjaTrader.Cbi.ConnectionStatus priceStatus = connectionStatusUpdate.PriceStatus;

                if (priceStatus != _lastPriceStatus)
                {
                    if (priceStatus != NinjaTrader.Cbi.ConnectionStatus.Connected)
                    {
                        _hadRecentError = true;
                        _lastErrorTimeUtc = DateTime.UtcNow;
                        var meta = new Dictionary<string, object>();
                        meta["channel"] = "price";
                        meta["status"] = priceStatus.ToString();
                        _reporter.Log("warn", "connection",
                            "Price feed connection status: " + priceStatus,
                            meta);
                    }
                    _lastPriceStatus = priceStatus;
                }
            }
            catch (Exception ex)
            {
                Print("[PresetStrategy] OnConnectionStatusUpdate report error: " + ex.Message);
            }
        }

        #endregion

        #region Daily Exact Mode Tick Watchdog

        protected override void OnMarketData(MarketDataEventArgs marketDataUpdate)
        {
            if (_executor == null) return;
            if (_preset == null || _preset.Rules == null || !_preset.Rules.DailyLimitExactMode) return;
            if (Position.MarketPosition == MarketPosition.Flat) return;

            // Use Last price; NT8 also publishes Bid/Ask — Last is what the
            // simulator's daily-exact mode used, so stay consistent.
            if (marketDataUpdate.MarketDataType != MarketDataType.Last) return;

            string dir = Position.MarketPosition == MarketPosition.Long ? "Long" : "Short";
            var action = _executor.OnTick(
                dir,
                Position.AveragePrice,
                Math.Max(1, Position.Quantity),
                marketDataUpdate.Price);
            if (action != null) Dispatch(action);
        }

        #endregion

        #region Auto Export (mirrors NQBuyAndHold)

        /// <summary>
        /// Write SystemPerformance JSON to outgoing/ at termination so
        /// BacktestRunner can pick it up. Schema matches NQBuyAndHold's
        /// ExportResults — keep them in sync if either is changed.
        /// </summary>
        private void ExportResults()
        {
            try
            {
                Print("[PresetStrategy] AutoExport for RunId=" + RunId);
                string outgoingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "outgoing");
                Directory.CreateDirectory(outgoingDir);
                string outputPath = Path.Combine(outgoingDir, "backtest_result_" + RunId + ".json");

                var all     = SystemPerformance.AllTrades;
                var wins    = SystemPerformance.AllTrades.WinningTrades;
                var loss    = SystemPerformance.AllTrades.LosingTrades;
                var allPerf = all.TradesPerformance;

                int totalTrades   = all.TradesCount;
                int winningTrades = wins.TradesCount;
                int losingTrades  = loss.TradesCount;

                double grossProfit  = allPerf.GrossProfit;
                double grossLoss    = allPerf.GrossLoss;
                double netProfit    = grossProfit + grossLoss;
                double profitFactor = allPerf.ProfitFactor;
                double sharpe       = allPerf.SharpeRatio;
                double sortino      = allPerf.SortinoRatio;
                double drawdownPct  = Math.Abs(allPerf.Percent.Drawdown);
                double avgProfit    = allPerf.Percent.AverageProfit;

                double winRate = totalTrades > 0
                    ? (double)winningTrades / totalTrades * 100.0
                    : 0.0;
                double avgWinner = winningTrades > 0 ? wins.TradesPerformance.Percent.AverageProfit : 0.0;
                double avgLoser  = losingTrades  > 0 ? loss.TradesPerformance.Percent.AverageProfit : 0.0;

                var sb = new StringBuilder();
                sb.Append("{");
                sb.AppendFormat("\"run_id\":\"{0}\",",            EscapeJson(RunId));
                sb.AppendFormat("\"strategy\":\"{0}\",",          EscapeJson(Name));
                sb.AppendFormat("\"preset\":\"{0}\",",            EscapeJson(_preset != null ? _preset.Name : ""));
                sb.AppendFormat("\"instrument\":\"{0}\",",        EscapeJson(Instrument.FullName));
                sb.AppendFormat("\"timeframe_minutes\":{0},",     BarsPeriod.Value);
                sb.Append("\"from_date\":\"\",");
                sb.Append("\"to_date\":\"\",");
                sb.AppendFormat("\"account\":\"{0}\",",           EscapeJson(Account.Name));
                sb.AppendFormat("\"completed_at\":\"{0}\",",      EscapeJson(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")));
                sb.Append("\"status\":\"completed\",");
                sb.AppendFormat("\"net_profit_dollars\":{0},",    F2(netProfit));
                sb.Append("\"net_profit_points\":0.00,");
                sb.AppendFormat("\"total_trades\":{0},",          totalTrades);
                sb.AppendFormat("\"winning_trades\":{0},",        winningTrades);
                sb.AppendFormat("\"losing_trades\":{0},",         losingTrades);
                sb.AppendFormat("\"win_rate_pct\":{0},",          F2(winRate));
                sb.AppendFormat("\"profit_factor\":{0},",         F4(profitFactor));
                sb.AppendFormat("\"max_drawdown_dollars\":{0},",  F2(drawdownPct));
                sb.AppendFormat("\"max_drawdown_pct\":{0},",      F4(drawdownPct));
                sb.AppendFormat("\"sharpe_ratio\":{0},",          F4(sharpe));
                sb.AppendFormat("\"sortino_ratio\":{0},",         F4(sortino));
                sb.AppendFormat("\"avg_trade_dollars\":{0},",     F2(avgProfit));
                sb.AppendFormat("\"avg_winner_dollars\":{0},",    F2(avgWinner));
                sb.AppendFormat("\"avg_loser_dollars\":{0},",     F2(avgLoser));
                sb.Append("\"largest_winner_dollars\":0.00,");
                sb.Append("\"largest_loser_dollars\":0.00,");
                sb.Append("\"avg_bars_in_trade\":0.00,");
                sb.Append("\"error\":null");
                sb.Append("}");

                File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(false));
                Print("[PresetStrategy] AutoExport: result written to " + outputPath);
            }
            catch (Exception ex)
            {
                Print("[PresetStrategy] AutoExport ERROR: " + ex.Message);
            }
        }

        /// <summary>
        /// Emit a per-trade CSV alongside the aggregates JSON. This is the
        /// canonical artifact for diffing against the dashboard's TS
        /// simulator — same column schema, same time-zone handling
        /// (session-local AND UTC) so the diff script can categorize any
        /// divergence by signature.
        ///
        /// Writes to {UserDataDir}/outgoing/backtest_trades_{id}.csv where
        /// `id` is RunId when provided (so BacktestRunner picks it up
        /// alongside the JSON), otherwise a timestamp-derived fallback
        /// (so manual SA runs still produce a predictable file).
        /// </summary>
        private void ExportTradesCsv()
        {
            try
            {
                // Skip empty runs entirely. NT8 instantiates every Strategy
                // subclass (NQTest03, CLTest01, etc.) at compile/load time for
                // metadata, and each one hits State.Terminated with no trades.
                // Writing those out clobbers real SA runs because the
                // millisecond-precision filename collides on tight loops.
                // No trades = no diagnostic value, so don't emit a file at all.
                var trades = SystemPerformance.AllTrades;
                int n = trades != null ? trades.Count : 0;
                if (n == 0) return;

                string outgoingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "outgoing");
                Directory.CreateDirectory(outgoingDir);

                // Naming: stick with RunId when BacktestRunner set one; else
                // synthesize one with millisecond + trade-count granularity so
                // back-to-back SA runs (or NT8's multi-pass instantiation
                // pattern) never clobber each other.
                string fileId = !string.IsNullOrEmpty(RunId)
                    ? RunId
                    : DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture)
                          + "_" + (Name ?? "preset")
                          + "_" + n + "trades";
                string outputPath = Path.Combine(outgoingDir, "backtest_trades_" + fileId + ".csv");

                var sb = new StringBuilder();
                // Header row — must match dashboard's downloadDetailedExportCsv
                // column order so the diff script can index by name.
                sb.Append("entry_time_session,entry_time_utc,exit_time_session,exit_time_utc,");
                sb.Append("direction,qty,entry_price,exit_price,exit_reason,points,dollars\n");

                for (int i = 0; i < n; i++)
                {
                    var t = trades[i];
                    if (t == null || t.Entry == null || t.Exit == null) continue;

                    // NT8's Trade type doesn't expose direction directly;
                    // it lives on the entry execution. IExecution.MarketPosition
                    // is the position state CREATED by the execution, so for
                    // an entry that's Long for "buy to open" and Short for
                    // "sell to open short" — exactly the direction we want.
                    bool isLong = t.Entry.MarketPosition == MarketPosition.Long;
                    string direction = isLong ? "Long" : "Short";

                    // NT8 hands times in the strategy's session timezone via
                    // .Time. Emit BOTH session and UTC so the diff script can
                    // catch timezone-driven divergence (suspect #2 / #4 in the
                    // plan) without any guessing.
                    DateTime entryT = t.Entry.Time;
                    DateTime exitT  = t.Exit.Time;
                    string entrySess = entryT.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
                    string exitSess  = exitT.ToString ("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
                    string entryUtc  = entryT.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
                    string exitUtc   = exitT.ToUniversalTime().ToString ("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

                    double entryPrice = t.Entry.Price;
                    double exitPrice  = t.Exit.Price;

                    // Sign-aware points = (exit - entry) for longs, inverted
                    // for shorts. Matches the dashboard's exitPoints definition.
                    double points = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
                    // Dollar P&L: NT8 already accounts for point value in
                    // ProfitCurrency, so use it directly rather than re-deriving.
                    double dollars = t.ProfitCurrency;
                    int qty = t.Quantity;

                    // Exit reason normalization — map NT8's defaults to the
                    // dashboard's labels so the diff script can compare apples
                    // to apples:
                    //   "Stop loss"     → "sl"
                    //   "Profit target" → "tp"
                    //   "Sell"/"Buy to cover" (manual close) → "timer" if the
                    //     exit time is BEFORE the day's daily-halt boundary,
                    //     else "daily". The boundary is captured in
                    //     _dailyHaltTimeByDay (populated when the executor
                    //     emits a close_all). When no halt was recorded for
                    //     the trade's day, treat manual closes as "timer".
                    string rawReason = t.Exit.Name ?? "";
                    string exitReason;
                    if (rawReason == "Stop loss") exitReason = "sl";
                    else if (rawReason == "Profit target") exitReason = "tp";
                    else if (rawReason == "Sell" || rawReason == "Buy to cover")
                    {
                        string dayKey = exitT.ToString("yyyy-MM-dd");
                        DateTime haltTime;
                        if (_dailyHaltTimeByDay.TryGetValue(dayKey, out haltTime) && exitT >= haltTime)
                            exitReason = "daily";
                        else
                            exitReason = "timer";
                    }
                    else exitReason = rawReason;

                    sb.Append(entrySess); sb.Append(',');
                    sb.Append(entryUtc);  sb.Append(',');
                    sb.Append(exitSess);  sb.Append(',');
                    sb.Append(exitUtc);   sb.Append(',');
                    sb.Append(direction); sb.Append(',');
                    sb.Append(qty.ToString(CultureInfo.InvariantCulture)); sb.Append(',');
                    sb.Append(F2(entryPrice)); sb.Append(',');
                    sb.Append(F2(exitPrice));  sb.Append(',');
                    sb.Append(EscapeCsv(exitReason)); sb.Append(',');
                    sb.Append(F2(points));  sb.Append(',');
                    sb.Append(F2(dollars));
                    sb.Append('\n');
                }

                File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(false));
                Print("[PresetStrategy] Per-trade CSV written: " + outputPath + " (" + n + " trades)");
            }
            catch (Exception ex)
            {
                Print("[PresetStrategy] ExportTradesCsv ERROR: " + ex.Message);
            }
        }

        /// <summary>
        /// Wrap a CSV field in quotes if it contains a comma, quote, or
        /// newline; double any embedded quotes per RFC 4180. Used for the
        /// exit_reason field which can include arbitrary signal-name strings.
        /// </summary>
        private static string EscapeCsv(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            bool needsQuote = s.IndexOf(',') >= 0 || s.IndexOf('"') >= 0
                              || s.IndexOf('\n') >= 0 || s.IndexOf('\r') >= 0;
            if (!needsQuote) return s;
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        }

        private static string F2(double v) => v.ToString("F2", CultureInfo.InvariantCulture);
        private static string F4(double v) => v.ToString("F4", CultureInfo.InvariantCulture);

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return s ?? "";
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }

        #endregion
    }
}
