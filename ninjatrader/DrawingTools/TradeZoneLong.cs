#region Using declarations
using System;
#endregion

namespace NinjaTrader.NinjaScript.DrawingTools
{
    /// <summary>
    /// TradeZoneLong — Marks a hypothetical LONG trade zone on the chart.
    /// User draws a time range; profit is calculated as lastClose - firstOpen
    /// (price going UP is profitable). Renders with green fill/border.
    /// </summary>
    public class TradeZoneLong : TradeZone
    {
        protected override string ZoneDirection { get { return "Long"; } }

        protected override void OnStateChange()
        {
            base.OnStateChange();

            if (State == State.SetDefaults)
            {
                Name        = "TradeZone Long";
                Description = "Mark a hypothetical long trade zone for analysis";
            }
        }
    }
}
