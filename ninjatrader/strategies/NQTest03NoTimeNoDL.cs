// NQTest03NoTimeNoDL.cs
//
// Thin wrapper around PresetStrategy that loads the "test03 (no time or DL)"
// preset from the dashboard. Same signal/exit logic as test03 but with the
// time-of-day filter and the daily stop-loss kill switch both turned off —
// useful for measuring how much of test03's edge comes from those gates vs
// the underlying signal_v2 setup.

#region Using declarations
using System;
using System.IO;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class NQTest03NoTimeNoDL : PresetStrategy
    {
        protected override string DefaultConfigPath()
            => Path.Combine(NinjaTrader.Core.Globals.UserDataDir,
                            "bin", "Custom", "presets", "test03_no_time_or_dl.json");

        protected override void OnStateChange()
        {
            base.OnStateChange();
            if (State == State.SetDefaults)
            {
                Name        = "NQTest03NoTimeNoDL";
                Description = "Dashboard preset \"test03 (no time or DL)\" — same as NQTest03 but with the time-of-day filter and daily stop-loss disabled.";
            }
        }
    }
}
