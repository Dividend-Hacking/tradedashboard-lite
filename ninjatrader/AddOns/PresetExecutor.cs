// PresetExecutor.cs
//
// Direct port of src/lib/utils/auto-trader-engine.ts. The "brain" of the
// auto-trader: pure decision logic that consumes a rolling bar buffer +
// current position state and emits a list of orders/modifications for the
// NT8 wrapper to execute.
//
// Pure design: the executor holds mutable state (active entry, daily
// counters, scaling walk) but never touches NT8 APIs. PresetStrategy.cs
// is the only place that calls Account/Cbi methods. This keeps the math
// testable in isolation if we ever want to wire a unit-test harness.
//
// Lifecycle (as called by PresetStrategy):
//   1. Constructor: takes the loaded Preset, resets all per-session state.
//   2. OnBar(bars, position): called once per closed bar. Returns Actions.
//   3. OnPositionFilled(position, entryBarTime, zoneAtr): called when NT8
//      reports a flat→long/short transition for an order we sent.
//   4. OnPositionClosed(exitPoints, qty): called on long/short→flat.
//      Updates dailyRealizedPoints + scaling walk + dailyHalted.
//   5. OnTick(position, lastPrice): called on every market data tick when
//      dailyLimitExactMode is on. Returns a Close action if cumulative
//      day P&L (realized + unrealized × qty) crosses the kill threshold.

using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns
{
    // ─── Action types ───────────────────────────────────────────────────────
    //
    // Mirror AutoTraderAction in auto-trader-engine.ts. We use a single
    // PresetAction class with a Kind discriminator instead of a discriminated
    // union — C# 9 has records but NT8's compiler is conservative; a flat
    // class with nullable fields is the safest cross-version shape.
    public class PresetAction
    {
        public string Kind         { get; set; } // "buy_long" | "sell_short" | "close" | "close_all" | "modify_sl"
        public double? SlPoints    { get; set; } // entry-side: null = SL disabled
        public double? TpPoints    { get; set; } // entry-side: null = TP disabled
        public bool   TrailEnabled { get; set; }
        // Effective trail distance in price points (base + atrAdjust × atr, same
        // formula as SL/TP). Null when TrailEnabled is false or computed value
        // is zero. The wrapper translates to ticks via TickSize.
        public double? TrailPoints { get; set; }
        public int    Qty          { get; set; }
        public double? Price       { get; set; } // modify_sl target price
        public string Reason       { get; set; }
        public string EntryBarTime { get; set; } // buy_long/sell_short: snap-time of signal bar
        public double? ZoneAtr     { get; set; } // captured at entry; feeds BE adjust math
        // Per-leg signal name. Set by the executor for "close" actions
        // targeting a specific stacked entry (timed-exit / BE / per-leg
        // modify_sl). Null on whole-position actions like "close_all" or on
        // entry actions (the wrapper assigns those names itself).
        public string SignalName  { get; set; }
    }

    // ─── ActiveEntry ────────────────────────────────────────────────────────
    //
    // Mirrors ActiveEntry in auto-trader-engine.ts. Captured when NT8 reports
    // a fill on an order we sent. Kept until the position closes (long/short
    // → flat) so the BE / timed-exit checks have everything they need.
    public class ActiveEntry
    {
        public string   SignalName   { get; set; }  // unique per-leg name issued by the wrapper
        public string   Direction    { get; set; }  // "Long" | "Short"
        public double   EntryPrice   { get; set; }
        public DateTime EntryBarTime { get; set; }  // bar timestamp the order was sent on
        public int      Qty          { get; set; }
        public double?  ZoneAtr      { get; set; }  // ATR at entry — null when ATR hadn't warmed up
        public bool     BeTriggered  { get; set; }  // idempotent flag for break-even SL move
        public double   PeakPnl      { get; set; }  // rolling peak favorable P&L
        // True once a "close" action has been dispatched for this leg —
        // prevents OnBar from firing the same timed-exit twice while we
        // wait for OnExecutionUpdate to confirm the fill.
        public bool     CloseDispatched { get; set; }
    }

    // ─── Executor (mutable per-session state) ───────────────────────────────
    public class PresetExecutor
    {
        private readonly Preset _preset;

        // Day rollover key — YYYY-MM-DD of the most recently processed bar.
        // When this changes, daily counters reset.
        private string _dayKey = null;

        // Cumulative scaledPoints realized today across closed trades.
        // Compared against dailyStopLoss/TakeProfit thresholds.
        private double _dailyRealizedPoints = 0;

        // True once a daily threshold has been crossed today — blocks new
        // entries until the day rolls over.
        private bool _dailyHalted = false;

        // Current size for the next entry order (scaling walk output).
        private int _nextEntrySize = 1;

        // Outcome of last closed trade — drives scaling step direction.
        private bool? _lastTradeWasWin = null;

        // Per-day TRADE COUNT and LOSS COUNT counters. Reset on day rollover
        // alongside the existing _dailyRealizedPoints / _dailyHalted state.
        // Drive maxTradesPerDay / maxLossesPerDay gates — same drop-after-cap
        // semantics as applyTradeCountCaps in zone-simulator.ts.
        private int _dailyTradesEntered = 0;
        private int _dailyLosses        = 0;

        // Bar time of the last KEPT trade's exit. Used by the
        // cooldownBetweenTrades gate to drop new entries that fire within
        // `cooldownBetweenTradesBars` minutes of a previous exit.
        // Persists across day boundaries (a 17:00 exit + 09:30 next-day
        // entry has hours of cooldown elapsed naturally — fine to gate on).
        // Bar time (not wall-clock) so historical backtests via NT8 use
        // the same time axis the dashboard's applyTradeCountCaps does.
        private DateTime? _lastKeptExitTime = null;
        // Latest closed bar time observed by OnBar — used as the "exit
        // time" approximation when OnPositionClosed fires (the wrapper
        // doesn't pass a bar time through, so we read this snapshot).
        private DateTime? _latestBarTime = null;

        // Currently-managed entries, keyed by per-leg signal name. Each
        // EnterLong / EnterShort the wrapper sends gets a unique name; the
        // executor tracks per-leg lifecycle independently so timed-exit /
        // BE checks fire for ALL stacked legs, not just the first one.
        // Old behavior (single _activeEntry) only saw the first stacked
        // leg, so trades 2..N rode past their timed-exit and held to SL.
        private readonly Dictionary<string, ActiveEntry> _activeEntries =
            new Dictionary<string, ActiveEntry>();

        // Debounce: skip duplicate OnBar calls for the same bar timestamp.
        private DateTime? _lastProcessedBarTime = null;

        // Buffered bookkeeping the NT8 wrapper reads to drive OnPositionFilled
        // ATR + entryBarTime. Set when an entry action is emitted; consumed
        // by OnPositionFilled then cleared. Decoupled from ActiveEntry so a
        // lost-fill or broker-rejected order doesn't pollute live state.
        public DateTime? PendingEntryBarTime { get; private set; }
        public double?   PendingEntryZoneAtr { get; private set; }

        // Public read-only accessors — used by the wrapper for status logging
        // and (in future) UI surfaces.
        public bool       DailyHalted        => _dailyHalted;
        public double     DailyRealizedPts   => _dailyRealizedPoints;
        public IReadOnlyDictionary<string, ActiveEntry> ActiveEntries => _activeEntries;

        public PresetExecutor(Preset preset)
        {
            _preset = preset ?? throw new ArgumentNullException(nameof(preset));
            _nextEntrySize = preset.Rules.ScalingEnabled
                ? Math.Max(1, preset.Rules.ScalingStartSize)
                : 1;
        }

        // ─── OnBar ──────────────────────────────────────────────────────────
        //
        // Called by PresetStrategy.OnBarUpdate after appending the latest
        // CLOSED bar to the rolling buffer. Returns zero or more Actions for
        // the wrapper to dispatch in order.
        //
        // Convention (mirrors the dashboard): the LAST bar in `bars` is the
        // just-closed bar that's actionable. There's no in-progress bar in
        // NT8's OnBarUpdate(Calculate.OnBarClose) — every bar handed to us
        // is fully closed — so we can treat the whole buffer as closed bars.
        public List<PresetAction> OnBar(IList<PresetBar> bars, bool inPosition, string positionDirection)
        {
            var actions = new List<PresetAction>();
            if (bars == null || bars.Count == 0) return actions;

            var latest = bars[bars.Count - 1];

            // Debounce — skip if we already processed this exact bar timestamp.
            // OnBarUpdate gets called for every IsFirstTickOfBar regardless of
            // whether anything new closed; this guard prevents double-fires.
            if (_lastProcessedBarTime.HasValue && _lastProcessedBarTime.Value == latest.Time)
                return actions;
            _lastProcessedBarTime = latest.Time;
            // Snapshot the latest bar time for OnPositionClosed to read when
            // it stamps _lastKeptExitTime — the cooldown gate uses this as
            // the exit-time anchor so historical backtests use bar time
            // rather than wall-clock.
            _latestBarTime = latest.Time;

            // Day rollover — reset daily counters on first bar of a new date.
            string newDayKey = latest.Time.ToString("yyyy-MM-dd");
            if (_dayKey != newDayKey)
            {
                _dayKey = newDayKey;
                _dailyRealizedPoints = 0;
                _dailyHalted = false;
                _dailyTradesEntered = 0;
                _dailyLosses = 0;
                if (_preset.Rules.ScalingEnabled && _preset.Rules.ScalingResetDaily)
                {
                    _nextEntrySize = Math.Max(1, _preset.Rules.ScalingStartSize);
                    _lastTradeWasWin = null;
                }
            }

            // Defensive sync — if NT8 reports flat but _activeEntries still
            // has stale legs (e.g., from a close_all whose fill didn't hit
            // OnPositionClosed because FromEntrySignal was empty), clear
            // them. Without this, stale unrealized accumulates across days
            // and the daily-exact watchdog mis-triggers, blocking new
            // entries indefinitely.
            if (!inPosition && _activeEntries.Count > 0)
            {
                _activeEntries.Clear();
            }

            // ── Per-leg exit checks (BE / timed) ───────────────────────────
            // Walk EVERY active leg. With positionMode="add-null" + scaling,
            // multiple stacked entries can be in-flight at once; each gets
            // its own timed-exit / BE check. Snapshot the values into a
            // local list so dispatching close actions doesn't disturb the
            // dictionary during enumeration (the actual removal happens
            // when OnPositionClosed fires for the leg).
            bool anyTimedExitDispatched = false;
            if (_activeEntries.Count > 0)
            {
                var legsSnapshot = new List<ActiveEntry>(_activeEntries.Values);
                foreach (var leg in legsSnapshot)
                {
                    bool isLong = leg.Direction == "Long";
                    double highPnl = isLong
                        ? latest.High - leg.EntryPrice
                        : leg.EntryPrice - latest.Low;
                    if (highPnl > leg.PeakPnl) leg.PeakPnl = highPnl;

                    // Skip further checks if a close has already been
                    // dispatched for this leg — we're waiting on the fill.
                    if (leg.CloseDispatched) continue;

                    // Break-even SL move — idempotent via BeTriggered flag.
                    if (_preset.Rules.BreakEvenEnabled && !leg.BeTriggered)
                    {
                        double atr = leg.ZoneAtr.HasValue && leg.ZoneAtr.Value > 0
                            ? leg.ZoneAtr.Value
                            : 0;
                        double effBe = Math.Max(0,
                            _preset.Rules.BreakEvenTrigger + _preset.Rules.BeAtrAdjust * atr);
                        if (leg.PeakPnl >= effBe)
                        {
                            actions.Add(new PresetAction
                            {
                                Kind       = "modify_sl",
                                Price      = Math.Round(leg.EntryPrice, 2),
                                SignalName = leg.SignalName,
                                Reason     = $"BE triggered ({leg.SignalName} peak {leg.PeakPnl:F2} ≥ {effBe:F2})",
                            });
                            leg.BeTriggered = true;
                        }
                    }

                    // Timed exit — count CLOSED bars after this leg's entry bar.
                    if (_preset.Rules.TimedExitEnabled)
                    {
                        int entryIdx = -1;
                        for (int i = bars.Count - 1; i >= 0; i--)
                        {
                            if (bars[i].Time == leg.EntryBarTime) { entryIdx = i; break; }
                        }
                        if (entryIdx >= 0)
                        {
                            int barsHeld = (bars.Count - 1) - entryIdx;
                            // Mirror TS: barsHeld >= timedExitBars - 1 (held count
                            // is the count of CLOSED bars after the entry bar;
                            // entry bar itself is barsHeld=0).
                            if (barsHeld >= _preset.Rules.TimedExitBars - 1)
                            {
                                actions.Add(new PresetAction
                                {
                                    Kind       = "close",
                                    SignalName = leg.SignalName,
                                    Reason     = $"Timed exit ({leg.SignalName}, held {barsHeld + 1} bars, max {_preset.Rules.TimedExitBars})",
                                });
                                leg.CloseDispatched = true;
                                anyTimedExitDispatched = true;
                            }
                        }
                    }
                }
            }
            // If we dispatched any timed-exits this bar, don't ALSO fire a
            // new entry on the same bar — mirror the old single-leg behavior.
            if (anyTimedExitDispatched) return actions;

            // ── Daily-exact watchdog (bar-resolution) ─────────────────────
            // Exact mode: close as soon as REALIZED + UNREALIZED hits the
            // daily loss/profit limit. Walk all in-flight legs at THIS bar's
            // close, sum their bar-close unrealized × qty (sign-aware), add
            // realized cum so far. If past threshold, fire close_all.
            //
            // OnTick covers tick-resolution in live trading; this bar-close
            // check covers backtests where OnMarketData isn't fed tick data.
            if (_preset.Rules.DailyLimitExactMode
                && _activeEntries.Count > 0
                && (_preset.Rules.DailyStopLossEnabled || _preset.Rules.DailyTakeProfitEnabled))
            {
                double aggUnrealized = 0;
                foreach (var leg in _activeEntries.Values)
                {
                    bool isLong = leg.Direction == "Long";
                    double pts = isLong
                        ? latest.Close - leg.EntryPrice
                        : leg.EntryPrice - latest.Close;
                    aggUnrealized += pts * Math.Max(1, leg.Qty);
                }
                double dayPnl = _dailyRealizedPoints + aggUnrealized;

                bool hitTp = _preset.Rules.DailyTakeProfitEnabled
                    && dayPnl >= _preset.Rules.DailyTakeProfitPoints;
                bool hitSl = _preset.Rules.DailyStopLossEnabled
                    && dayPnl <= -_preset.Rules.DailyStopLossPoints;
                if (hitTp || hitSl)
                {
                    actions.Add(new PresetAction
                    {
                        Kind   = "close_all",
                        Reason = (hitTp ? "Daily TP exact" : "Daily SL exact") +
                                 $" (day={dayPnl:F2}, realized={_dailyRealizedPoints:F2}, unreal={aggUnrealized:F2})",
                    });
                    foreach (var leg in _activeEntries.Values) leg.CloseDispatched = true;
                    _dailyHalted = true;
                    return actions;
                }
            }

            // ── Daily halt (block new entries) ────────────────────────────
            if (_dailyHalted) return actions;

            // ── Strategy signal generation ────────────────────────────────
            var signals = PresetSignals.Generate(_preset.StrategyId, bars, _preset.Params);
            if (signals.Count == 0) return actions;

            // Only the signal at the latest bar is actionable.
            int latestIdx = bars.Count - 1;
            PresetSignal signalNow = null;
            for (int i = signals.Count - 1; i >= 0; i--)
            {
                if (signals[i].BarIndex == latestIdx) { signalNow = signals[i]; break; }
                if (signals[i].BarIndex < latestIdx) break;
            }
            if (signalNow == null) return actions;

            // ── Build per-bar context snapshot for filters ────────────────
            // Periods + types come from the filter config, mirroring the
            // dashboard's indicatorConfig bundle. Defaults reproduce the
            // legacy hardcoded behavior, so older presets that don't set
            // these fields still compute ATR(14)/ADX(14)/EMA(20)/EMA(200)/
            // BB(20, 2). The filter evaluator then reads ctx_atr14 / etc.
            // — field names are kept for wire compat with stored zones.
            int atrPeriod = Math.Max(2, _preset.Filters.Atr.Period > 0 ? _preset.Filters.Atr.Period : 14);
            int adxPeriod = Math.Max(2, _preset.Filters.Adx.Period > 0 ? _preset.Filters.Adx.Period : 14);
            int bbPeriod  = Math.Max(2, _preset.Filters.Bollinger.Period > 0 ? _preset.Filters.Bollinger.Period : 20);
            double bbStdDev = _preset.Filters.Bollinger.StdDev > 0 ? _preset.Filters.Bollinger.StdDev : 2;
            int trendFastPeriod = Math.Max(2, _preset.Filters.Trend.FastPeriod > 0 ? _preset.Filters.Trend.FastPeriod : 20);
            string trendFastType = _preset.Filters.Trend.FastType ?? "ema";
            int trendSlowPeriod = Math.Max(2, _preset.Filters.Trend.SlowPeriod > 0 ? _preset.Filters.Trend.SlowPeriod : 200);
            string trendSlowType = _preset.Filters.Trend.SlowType ?? "ema";
            int maDistPeriod  = Math.Max(2, _preset.Filters.MaDistance.Period > 0 ? _preset.Filters.MaDistance.Period : 50);
            string maDistType = _preset.Filters.MaDistance.Type ?? "ema";
            int volMaPeriod   = Math.Max(2, _preset.Filters.Volume.Period > 0 ? _preset.Filters.Volume.Period : 20);
            int rsiPeriod     = Math.Max(2, _preset.Filters.Rsi.Period > 0 ? _preset.Filters.Rsi.Period : 14);
            // ADX-slope lookback drives the rising/falling/flat filter and
            // is stamped at signal time. Falls back to 5 when the preset
            // predates this field. Clamped to ≥ 1 to avoid degenerate
            // behavior.
            int adxSlopeLookback = Math.Max(1,
                _preset.Filters.AdxTrend.Lookback > 0 ? _preset.Filters.AdxTrend.Lookback : 5);

            var atrSeries  = PresetIndicators.Atr(bars, atrPeriod);
            var adxSeries  = PresetIndicators.Adx(bars, adxPeriod);
            var fastMa     = PresetIndicators.MaByType(bars, trendFastPeriod, trendFastType);
            var slowMa     = PresetIndicators.MaByType(bars, trendSlowPeriod, trendSlowType);
            var bb         = PresetIndicators.Bollinger(bars, bbPeriod, bbStdDev);
            var maDistSer  = PresetIndicators.MaByType(bars, maDistPeriod, maDistType);
            var volMaSer   = PresetIndicators.VolumeMa(bars, volMaPeriod);
            var rsiSer     = PresetIndicators.Rsi(bars, rsiPeriod);
            var snapshot   = PresetIndicators.Snapshot(
                atrSeries, adxSeries, fastMa, slowMa, bb,
                maDistSer, volMaSer, rsiSer,
                bars[latestIdx].Volume,
                bars[latestIdx].Close, latestIdx,
                adxSlopeLookback);

            // ── Filter evaluation ─────────────────────────────────────────
            if (!PresetFilterEvaluator.Pass(snapshot, _preset.Filters, signalNow.Direction, latest.Time))
            {
                return actions;
            }

            // ── Per-day count caps + cooldown gate ────────────────────────
            // Mirrors applyTradeCountCaps in zone-simulator.ts. Drops NEW
            // entries once the day has booked the configured number of
            // trades / losses, OR when the previous kept exit was within
            // the cooldown window. Fires AFTER filter eval so we don't
            // count filter-rejected signals against the day's cap.
            if (_preset.Rules.MaxTradesPerDayEnabled
                && _preset.Rules.MaxTradesPerDay > 0
                && _dailyTradesEntered >= _preset.Rules.MaxTradesPerDay)
            {
                return actions;
            }
            if (_preset.Rules.MaxLossesPerDayEnabled
                && _preset.Rules.MaxLossesPerDay > 0
                && _dailyLosses >= _preset.Rules.MaxLossesPerDay)
            {
                return actions;
            }
            if (_preset.Rules.CooldownBetweenTradesEnabled
                && _preset.Rules.CooldownBetweenTradesBars > 0
                && _lastKeptExitTime.HasValue)
            {
                double minutesSinceExit = (latest.Time - _lastKeptExitTime.Value).TotalMinutes;
                if (minutesSinceExit < _preset.Rules.CooldownBetweenTradesBars)
                    return actions;
            }

            // ── Position-mode gating ──────────────────────────────────────
            // Maps to NT8's order semantics — the executor only decides
            // whether the signal is allowed to fire; NT8 handles reversals
            // natively when an opposite-direction order arrives in position.
            bool sameDir = inPosition && positionDirection == signalNow.Direction;
            bool canFire;
            switch (_preset.Rules.PositionMode)
            {
                case "default":
                case "null":
                    canFire = !inPosition;
                    break;
                case "add-null":
                    canFire = !inPosition || sameDir;
                    break;
                case "close-previous":
                case "add-close":
                    canFire = true;
                    break;
                default:
                    canFire = !inPosition;
                    break;
            }
            if (!canFire) return actions;

            // ── Build the entry order ─────────────────────────────────────
            // SL/TP/Trail come from SimRules with the same ATR-adjust as the
            // simulator: effective = base + atrAdjust × zoneAtr.
            double? zoneAtr = snapshot.Atr14;
            double atrForCalc = zoneAtr.HasValue && zoneAtr.Value > 0 ? zoneAtr.Value : 0;
            double? effSl = _preset.Rules.StopLossEnabled
                ? (double?)Math.Max(0, _preset.Rules.StopLossPoints + _preset.Rules.SlAtrAdjust * atrForCalc)
                : null;
            double? effTp = _preset.Rules.TakeProfitEnabled
                ? (double?)Math.Max(0, _preset.Rules.TakeProfitPoints + _preset.Rules.TpAtrAdjust * atrForCalc)
                : null;
            bool trail = _preset.Rules.TrailingStopEnabled;
            // Same ATR-adjust pattern as SL/TP. Null when disabled or non-positive
            // — wrapper skips the SetTrailStop call entirely in that case.
            double? effTrail = trail
                ? (double?)Math.Max(0, _preset.Rules.TrailingStopPoints + _preset.Rules.TrailAtrAdjust * atrForCalc)
                : null;
            int qty = Math.Max(1, _nextEntrySize);

            // Stash the entry-side metadata for OnPositionFilled to consume.
            PendingEntryBarTime = latest.Time;
            PendingEntryZoneAtr = zoneAtr;

            string reason = $"{_preset.StrategyId} {signalNow.Direction} (ATR={atrForCalc:F2})";
            actions.Add(new PresetAction
            {
                Kind         = signalNow.Direction == "Long" ? "buy_long" : "sell_short",
                SlPoints     = effSl,
                TpPoints     = effTp,
                TrailEnabled = trail,
                TrailPoints  = effTrail,
                Qty          = qty,
                Reason       = reason,
                EntryBarTime = latest.Time.ToString("o"),
                ZoneAtr      = zoneAtr,
            });
            // Bump the day's trade-count cap counter at DISPATCH (not at
            // fill) — same point in the lifecycle as the dashboard's
            // applyTradeCountCaps, which counts a trade as soon as it
            // would have started. A subsequent broker rejection is rare
            // enough that we don't refund the slot here.
            _dailyTradesEntered++;
            return actions;
        }

        // ─── OnPositionFilled ───────────────────────────────────────────────
        //
        // The wrapper calls this once per entry execution (per signal name).
        // Each call registers a new ActiveEntry keyed by the per-leg signal
        // name so timed-exit / BE checks can fire for every stacked leg
        // independently. Old behavior: single _activeEntry only saw the
        // first leg.
        public void OnPositionFilled(string signalName, string direction, double entryPrice, int qty)
        {
            if (PendingEntryBarTime == null)
            {
                // Fill observed but no pending entry — could be a manual
                // order the engine didn't initiate. Don't track it.
                return;
            }
            if (string.IsNullOrEmpty(signalName)) return;
            _activeEntries[signalName] = new ActiveEntry
            {
                SignalName     = signalName,
                Direction      = direction,
                EntryPrice     = entryPrice,
                EntryBarTime   = PendingEntryBarTime.Value,
                Qty            = Math.Max(1, qty),
                ZoneAtr        = PendingEntryZoneAtr,
                BeTriggered    = false,
                PeakPnl        = 0,
                CloseDispatched = false,
            };
            PendingEntryBarTime = null;
            PendingEntryZoneAtr = null;
        }

        // ─── OnPositionClosed ───────────────────────────────────────────────
        //
        // The wrapper calls this once per leg-exit (per signal name). Each
        // close advances the scaling walk + daily realized counters
        // independently, mirroring the dashboard's add-null behavior where
        // every stacked entry's outcome is credited as it lands.
        // exitPoints is per-contract realized P&L in price points.
        public void OnPositionClosed(string signalName, double exitPoints, int qty)
        {
            double scaledPoints = exitPoints * Math.Max(1, qty);
            bool isWin = exitPoints > 0;

            // Scaling walk — additive +winStep / -lossStep, clamped [min, max].
            if (_preset.Rules.ScalingEnabled)
            {
                int step = isWin
                    ? Math.Max(0, _preset.Rules.ScalingWinStep)
                    : -Math.Max(0, _preset.Rules.ScalingLossStep);
                int desired = _nextEntrySize + step;
                int min = Math.Max(1, _preset.Rules.ScalingMinSize);
                int max = Math.Max(min, _preset.Rules.ScalingMaxSize);
                _nextEntrySize = Math.Min(max, Math.Max(min, desired));
            }

            // Daily realized + halt check.
            _dailyRealizedPoints += scaledPoints;
            if (_preset.Rules.DailyTakeProfitEnabled
                && _dailyRealizedPoints >= _preset.Rules.DailyTakeProfitPoints)
            {
                _dailyHalted = true;
            }
            if (_preset.Rules.DailyStopLossEnabled
                && _dailyRealizedPoints <= -_preset.Rules.DailyStopLossPoints)
            {
                _dailyHalted = true;
            }

            // Per-day LOSS counter — bumped on per-contract loss (sign
            // matches applyTradeCountCaps in zone-simulator.ts where size
            // doesn't matter for the loser-count).
            if (exitPoints < 0)
            {
                _dailyLosses++;
            }

            // Cooldown reference — bar time of the latest kept exit (uses
            // the most recently processed bar's timestamp as the anchor).
            // The next OnBar's cooldown gate compares (latest.Time -
            // _lastKeptExitTime).TotalMinutes against the configured
            // cooldown. Persists across days intentionally (a 17:00 exit
            // followed by a 09:30 next-day entry has plenty of cooldown
            // elapsed).
            _lastKeptExitTime = _latestBarTime ?? DateTime.Now;

            _lastTradeWasWin = isWin;
            if (!string.IsNullOrEmpty(signalName))
                _activeEntries.Remove(signalName);
        }

        // ─── OnTick (daily-exact mode watchdog) ─────────────────────────────
        //
        // Called by the wrapper on every market-data tick when
        // dailyLimitExactMode is on. Returns a Close action if cumulative
        // day P&L (realized + unrealized × aggregate qty) crosses the
        // threshold. Returns null in all other cases.
        //
        // Aggregate qty here is Position.Quantity (sum of all stacked legs);
        // entryPrice is Position.AveragePrice — both passed by the wrapper
        // so we don't have to reach into NT8 APIs from the executor.
        public PresetAction OnTick(string positionDirection, double entryPrice, int qty, double lastPrice)
        {
            if (!_preset.Rules.DailyLimitExactMode) return null;
            if (!_preset.Rules.DailyStopLossEnabled && !_preset.Rules.DailyTakeProfitEnabled) return null;
            if (string.IsNullOrEmpty(positionDirection) || _activeEntries.Count == 0) return null;

            bool isLong = positionDirection == "Long";
            double unrealizedPts = isLong ? lastPrice - entryPrice : entryPrice - lastPrice;
            double dayPnl = _dailyRealizedPoints + unrealizedPts * Math.Max(1, qty);

            if (_preset.Rules.DailyTakeProfitEnabled && dayPnl >= _preset.Rules.DailyTakeProfitPoints)
            {
                return new PresetAction
                {
                    Kind   = "close_all",
                    Reason = $"Daily TP exact (day={dayPnl:F2})",
                };
            }
            if (_preset.Rules.DailyStopLossEnabled && dayPnl <= -_preset.Rules.DailyStopLossPoints)
            {
                return new PresetAction
                {
                    Kind   = "close_all",
                    Reason = $"Daily SL exact (day={dayPnl:F2})",
                };
            }
            return null;
        }
    }
}
