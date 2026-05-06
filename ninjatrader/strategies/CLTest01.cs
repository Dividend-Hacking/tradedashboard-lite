// CLTest01.cs
//
// Thin wrapper around PresetStrategy that loads the "Test01 CL" preset from
// the dashboard — the Crude Light futures variant of the test03 family.
// Despite the name suggesting otherwise, this preset is structurally distinct
// from test03: scaling off, timed exit off, slightly different ATR-adjust on
// SL/TP, tighter ATR floor (0.03), and a 06:00–09:00 time window.
//
// Pure C# wrapper — all decision logic in PresetStrategy + AddOns/Preset*.

#region Using declarations
using System;
using System.IO;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class CLTest01 : PresetStrategy
    {
        protected override string DefaultConfigPath()
            => Path.Combine(NinjaTrader.Core.Globals.UserDataDir,
                            "bin", "Custom", "presets", "test01_cl.json");

        protected override void OnStateChange()
        {
            base.OnStateChange();
            if (State == State.SetDefaults)
            {
                Name        = "CLTest01";
                Description = "Dashboard preset \"Test01 CL\" — signal_v2 tuned for Crude Light, scaling off, time window 06:00–09:00, ATR floor 0.03, daily SL halt.";
            }
        }
    }
}
