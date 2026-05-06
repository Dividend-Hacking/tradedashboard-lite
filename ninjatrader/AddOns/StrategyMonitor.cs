#region Using declarations
using System;
using System.Collections.Generic;
using System.Threading;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// StrategyMonitor — global heartbeat ticker for every running PresetStrategy.
    ///
    /// Each PresetStrategy already has its own StrategyReporter that heartbeats
    /// every 20s on a background timer. This AddOn is the redundant safety net:
    /// it iterates the static registry of live strategies on a 60s interval and
    /// forces a heartbeat for every instance, regardless of whether any bars
    /// are arriving on those charts.
    ///
    /// Why this is necessary:
    ///   - Per-strategy timers can stall if NT8 puts the strategy thread to
    ///     sleep (rare but observed during NT updates / disconnect storms).
    ///   - It keeps the dashboard's "last heartbeat" timestamps moving during
    ///     overnight or weekend lulls when bars are sparse.
    ///   - Catches state changes (in/out of trading window) faster — strategies
    ///     with no live position only update on bar close, which can be far
    ///     apart on slow markets.
    ///
    /// Lifecycle: AddOnBase auto-runs in NT8 — instantiated at process start,
    /// transitioned to State.Active after compile, and Terminated on NT close.
    /// We start the timer in Active, dispose it in Terminated. No per-account
    /// subscriptions; the registry is populated by PresetStrategy itself.
    /// </summary>
    public class StrategyMonitor : AddOnBase
    {
        // ─── Cadence ──────────────────────────────────────────────────────────
        // 60s matches the user's request and gives the dashboard ~1-minute
        // resolution on stale-detection. Combined with the per-strategy 20s
        // heartbeat, a healthy instance updates ~every 20s; a strategy whose
        // own timer has stalled still updates every 60s via this monitor.
        private const int TICK_SECONDS = 60;

        private Timer _timer;
        private bool _started;

        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    Name        = "StrategyMonitor";
                    Description = "Periodic heartbeat ticker for live PresetStrategy instances — keeps Supabase status fresh.";
                    break;

                case State.Active:
                    if (_started) break;
                    _started = true;

                    // First tick fires after the full interval — no need to
                    // race with strategy startup. NT8 spins up AddOns and
                    // strategies on different threads; waiting 60s gives every
                    // chart-strategy time to finish its own DataLoaded path
                    // and register itself before our first ping.
                    _timer = new Timer(_ => SafeTick(),
                                       null,
                                       TimeSpan.FromSeconds(TICK_SECONDS),
                                       TimeSpan.FromSeconds(TICK_SECONDS));

                    NinjaTrader.Code.Output.Process(
                        string.Format("StrategyMonitor: Active — pinging registered strategies every {0}s", TICK_SECONDS),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    break;

                case State.Terminated:
                    if (_timer != null)
                    {
                        try { _timer.Dispose(); } catch { /* ignore */ }
                        _timer = null;
                    }
                    _started = false;
                    break;
            }
        }

        /// <summary>
        /// Timer callback wrapper — BCL Timer crashes on unhandled exceptions
        /// from the ThreadPool, which would take NT down. Catch everything,
        /// log to Output, never throw.
        /// </summary>
        private void SafeTick()
        {
            try
            {
                var instances = PresetStrategy.GetLiveInstances();
                if (instances == null || instances.Count == 0) return;

                int pinged = 0;
                int failed = 0;
                foreach (var s in instances)
                {
                    try
                    {
                        s.PingReporter();
                        pinged++;
                    }
                    catch (Exception ex)
                    {
                        // One bad instance shouldn't poison the whole tick —
                        // count it and move on. The strategy's own reporter
                        // will surface the actual error to strategy_logs if
                        // it's still alive enough to log.
                        failed++;
                        NinjaTrader.Code.Output.Process(
                            string.Format("StrategyMonitor: ping failed for one instance — {0}", ex.Message),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }

                // Periodic confirmation log — useful when verifying the monitor
                // is alive without scrolling Supabase. Quiet enough at 60s
                // (1440 lines/day) that it doesn't drown out other output.
                NinjaTrader.Code.Output.Process(
                    string.Format("StrategyMonitor: tick — pinged {0} strategy instance(s){1}",
                        pinged, failed > 0 ? string.Format(" ({0} failed)", failed) : ""),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("StrategyMonitor: tick exception — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }
    }
}
