#region Using declarations
using System;
#endregion

namespace NinjaTrader.NinjaScript.DrawingTools
{
    /// <summary>
    /// TradeZoneShort — Marks a hypothetical SHORT trade zone on the chart.
    /// User draws a time range; profit is calculated as firstOpen - lastClose
    /// (price going DOWN is profitable). Renders with red fill/border.
    /// </summary>
    public class TradeZoneShort : TradeZone
    {
        protected override string ZoneDirection { get { return "Short"; } }

        protected override void OnStateChange()
        {
            base.OnStateChange();

            if (State == State.SetDefaults)
            {
                Name        = "TradeZone Short";
                Description = "Mark a hypothetical short trade zone for analysis";
            }
        }
    }
}
