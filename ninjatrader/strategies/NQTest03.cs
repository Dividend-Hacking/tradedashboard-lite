// NQTest03.cs
//
// Thin wrapper around PresetStrategy that loads the "test03" preset from
// the dashboard. Every line of trading logic lives in PresetStrategy +
// the AddOns/Preset* engine — this file exists only to register a
// distinct selectable Strategy in NT8's Strategy Analyzer dropdown and
// to hardcode the ConfigPath default to the variant's JSON file.
//
// Future presets follow the same pattern: copy this file, change the
// class name, change DefaultConfigPath(), and tweak Name/Description.

#region Using declarations
using System;
using System.IO;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class NQTest03 : PresetStrategy
    {
        // Resolves to {UserDataDir}/bin/Custom/presets/test03.json on the VM,
        // which is where deploy-nt8.sh mirrors the local presets/ folder.
        protected override string DefaultConfigPath()
            => Path.Combine(NinjaTrader.Core.Globals.UserDataDir,
                            "bin", "Custom", "presets", "test03.json");

        protected override void OnStateChange()
        {
            base.OnStateChange();
            if (State == State.SetDefaults)
            {
                Name        = "NQTest03";
                Description = "Dashboard preset \"test03\" — signal_v2 with scaling, timed exit, daily SL halt, NQ time window 07:30–10:00.";
            }
        }
    }
}
