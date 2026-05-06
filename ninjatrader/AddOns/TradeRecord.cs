#region Using declarations
using System;
using System.Collections.Generic;
using System.Text;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// TradeRecord — Immutable data model representing a completed trade with full market context.
    ///
    /// Each TradeRecord captures:
    /// - Core trade data (entry/exit times, prices, P&L)
    /// - RR analysis (MFE/MAE in points and R-multiples for post-hoc TP scenario testing)
    /// - Market context snapshot at entry time (EMA/ATR/BB/ADX state)
    /// - Extensible CustomTags dictionary for future tagging
    ///
    /// Serialized to JSON via manual StringBuilder (NT8 has no Newtonsoft.Json).
    /// One TradeRecord per completed trade, stored in daily JSON files.
    /// </summary>
    public class TradeRecord
    {
        // ─── Core Trade Data ───────────────────────────────────────────────────
        // These fields capture the basic who/what/when/where of the trade

        /// <summary>Timestamp when the entry fill occurred</summary>
        public DateTime EntryTime { get; set; }

        /// <summary>Timestamp when the exit fill occurred</summary>
        public DateTime ExitTime { get; set; }

        /// <summary>Wall-clock time when the entry event was processed (DateTime.Now at entry)</summary>
        public DateTime RealEntryTime { get; set; }

        /// <summary>Wall-clock time when the exit event was processed (DateTime.Now at exit)</summary>
        public DateTime RealExitTime { get; set; }

        /// <summary>Full instrument name (e.g., "NQ 03-26")</summary>
        public string Instrument { get; set; }

        /// <summary>Trade direction: "Long" or "Short"</summary>
        public string Direction { get; set; }

        /// <summary>Entry fill price</summary>
        public double EntryPrice { get; set; }

        /// <summary>Exit fill price</summary>
        public double ExitPrice { get; set; }

        /// <summary>Stop loss price (from OrderUpdate or ATR estimate)</summary>
        public double StopLossPrice { get; set; }

        /// <summary>Number of contracts traded</summary>
        public int Quantity { get; set; }

        /// <summary>Profit/loss in instrument points</summary>
        public double PnlPoints { get; set; }

        /// <summary>Profit/loss in dollars (points * point value * quantity)</summary>
        public double PnlDollars { get; set; }

        /// <summary>Signal name from the strategy (e.g., "Long", "FadeShort")</summary>
        public string StrategySignalName { get; set; }

        /// <summary>Account name (e.g., "Sim101", "Playback101")</summary>
        public string AccountName { get; set; }

        // ─── RR Analysis ───────────────────────────────────────────────────────
        // These fields enable post-hoc risk/reward scenario testing.
        // With MFE and initial stop distance, you can compute whether any
        // target (1R, 1.5R, 2R, 3R) would have been hit.

        /// <summary>Distance in points from entry to initial stop loss</summary>
        public double InitialStopDistance { get; set; }

        /// <summary>Actual R-multiple achieved: PnlPoints / InitialStopDistance</summary>
        public double ActualRR { get; set; }

        /// <summary>Take profit limit order price captured from OCO bracket (0 if not detected)</summary>
        public double TakeProfitPrice { get; set; }

        /// <summary>
        /// Intended risk-reward ratio: TP distance / SL distance.
        /// Unlike ActualRR (which reflects realized P&L), SetupRR shows the trade's
        /// planned R:R from the bracket — identical for winners and losers using the same bracket.
        /// 0 if no TP limit order was detected.
        /// </summary>
        public double SetupRR { get; set; }

        /// <summary>Maximum Favorable Excursion in points (best unrealized profit)</summary>
        public double MfePoints { get; set; }

        /// <summary>Maximum Adverse Excursion in points (worst unrealized loss)</summary>
        public double MaePoints { get; set; }

        /// <summary>MFE as R-multiple: MfePoints / InitialStopDistance</summary>
        public double MfeRMultiple { get; set; }

        /// <summary>MAE as R-multiple: MaePoints / InitialStopDistance</summary>
        public double MaeRMultiple { get; set; }

        // ─── Post-Exit Excursion Data ────────────────────────────────────────────
        // Tracks price movement for 20 minutes after trade exit.
        // Enables "what if I held longer" analysis — e.g., a 1:1 trade that
        // could have been 2:1 will show post_exit_mfe_r >= 1.0.

        /// <summary>Max favorable price movement after exit, in points</summary>
        public double PostExitMfePoints { get; set; }

        /// <summary>Post-exit MFE as R-multiple of initial stop distance</summary>
        public double PostExitMfeR { get; set; }

        /// <summary>Max adverse price movement after exit, in points (validates exit timing)</summary>
        public double PostExitMaePoints { get; set; }

        // ─── Market Context at Entry ───────────────────────────────────────────
        // Snapshot of indicator state when the trade was entered.
        // Enables filtering/grouping trades by market regime after the fact.

        /// <summary>Market context snapshot captured at trade entry</summary>
        public MarketContext Context { get; set; }

        // ─── Extensibility ─────────────────────────────────────────────────────

        // ─── RiskManager Metadata ─────────────────────────────────────────────
        // These fields are populated when the trade originates from RiskManager.
        // For non-RiskManager trades, they default to 0/"".

        /// <summary>Number of Risk Units risked on this trade (from RiskManager UI)</summary>
        public double RiskUnits { get; set; }

        /// <summary>ATR multiplier used for SL distance (0 if manual SL mode)</summary>
        public double AtrMultiplier { get; set; }

        /// <summary>Reward:risk multiplier used for TP distance</summary>
        public double RRMultiplier { get; set; }

        /// <summary>SL placement mode: "ATR" or "Manual" (empty for non-RiskManager trades)</summary>
        public string SlMode { get; set; }

        // ─── Extensibility ─────────────────────────────────────────────────────

        /// <summary>
        /// Free-form key/value tags for future expansion.
        /// Strategies can write custom data here (e.g., pattern type, confluence score).
        /// </summary>
        public Dictionary<string, object> CustomTags { get; set; }

        /// <summary>
        /// Creates a new TradeRecord with empty defaults.
        /// </summary>
        public TradeRecord()
        {
            CustomTags = new Dictionary<string, object>();
            Context = new MarketContext();
            Instrument = string.Empty;
            Direction = string.Empty;
            StrategySignalName = string.Empty;
            AccountName = string.Empty;
            SlMode = string.Empty;
        }

        /// <summary>
        /// Serializes this TradeRecord to a JSON string using manual StringBuilder.
        /// NT8 does not include Newtonsoft.Json, so we build JSON by hand.
        /// Uses invariant formatting for all numeric values to avoid locale issues.
        /// </summary>
        public string ToJson()
        {
            var sb = new StringBuilder();
            sb.Append("  {\n");

            // Core trade data
            sb.AppendFormat("    \"entryTime\": \"{0:yyyy-MM-ddTHH:mm:ss}\",\n", EntryTime);
            sb.AppendFormat("    \"exitTime\": \"{0:yyyy-MM-ddTHH:mm:ss}\",\n", ExitTime);
            sb.AppendFormat("    \"realEntryTime\": \"{0:yyyy-MM-ddTHH:mm:ss}\",\n", RealEntryTime);
            sb.AppendFormat("    \"realExitTime\": \"{0:yyyy-MM-ddTHH:mm:ss}\",\n", RealExitTime);
            sb.AppendFormat("    \"instrument\": \"{0}\",\n", EscapeJson(Instrument));
            sb.AppendFormat("    \"direction\": \"{0}\",\n", EscapeJson(Direction));
            sb.AppendFormat("    \"entryPrice\": {0},\n", EntryPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"exitPrice\": {0},\n", ExitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"stopLossPrice\": {0},\n", StopLossPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"quantity\": {0},\n", Quantity);
            sb.AppendFormat("    \"pnlPoints\": {0},\n", PnlPoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"pnlDollars\": {0},\n", PnlDollars.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"strategySignalName\": \"{0}\",\n", EscapeJson(StrategySignalName));
            sb.AppendFormat("    \"accountName\": \"{0}\",\n", EscapeJson(AccountName));

            // RR analysis
            sb.AppendFormat("    \"initialStopDistance\": {0},\n", InitialStopDistance.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"actualRR\": {0},\n", ActualRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"takeProfitPrice\": {0},\n", TakeProfitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"setupRR\": {0},\n", SetupRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"mfePoints\": {0},\n", MfePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"maePoints\": {0},\n", MaePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"mfeRMultiple\": {0},\n", MfeRMultiple.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"maeRMultiple\": {0},\n", MaeRMultiple.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

            // Post-exit excursion data
            sb.AppendFormat("    \"postExitMfePoints\": {0},\n", PostExitMfePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"postExitMfeR\": {0},\n", PostExitMfeR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"postExitMaePoints\": {0},\n", PostExitMaePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

            // Market context block
            sb.Append("    \"context\": ");
            sb.Append(Context != null ? Context.ToJson() : "{}");
            sb.Append(",\n");

            // RiskManager metadata (defaults to 0/"" for non-RiskManager trades)
            sb.AppendFormat("    \"riskUnits\": {0},\n", RiskUnits.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"atrMultiplier\": {0},\n", AtrMultiplier.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"rrMultiplier\": {0},\n", RRMultiplier.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("    \"slMode\": \"{0}\",\n", EscapeJson(SlMode ?? ""));

            // Custom tags
            sb.Append("    \"customTags\": {");
            if (CustomTags != null && CustomTags.Count > 0)
            {
                int i = 0;
                foreach (var kvp in CustomTags)
                {
                    if (i > 0) sb.Append(", ");
                    sb.AppendFormat("\"{0}\": ", EscapeJson(kvp.Key));

                    // Handle different value types for JSON serialization
                    if (kvp.Value == null)
                        sb.Append("null");
                    else if (kvp.Value is string)
                        sb.AppendFormat("\"{0}\"", EscapeJson(kvp.Value.ToString()));
                    else if (kvp.Value is bool)
                        sb.Append((bool)kvp.Value ? "true" : "false");
                    else if (kvp.Value is double || kvp.Value is float)
                        sb.Append(Convert.ToDouble(kvp.Value).ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                    else
                        sb.Append(kvp.Value.ToString());

                    i++;
                }
            }
            sb.Append("}\n");

            sb.Append("  }");
            return sb.ToString();
        }

        /// <summary>
        /// Escapes special characters for safe JSON string embedding.
        /// Handles backslash, double-quote, newline, carriage return, and tab.
        /// </summary>
        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }
    }

    /// <summary>
    /// MarketContext — Snapshot of indicator state captured at trade entry time.
    ///
    /// Enables post-hoc analysis of trade performance by market regime:
    /// - Trending vs consolidating (ADX threshold)
    /// - Price position relative to EMAs (trend bias)
    /// - Bollinger Band position (volatility context)
    /// - ATR value (volatility magnitude)
    ///
    /// All distances are normalized by ATR to make them comparable across time periods.
    /// </summary>
    public class MarketContext
    {
        /// <summary>14-period ATR value at entry (volatility baseline)</summary>
        public double Atr14 { get; set; }

        /// <summary>"above" or "below" — price vs EMA(20) at entry</summary>
        public string PriceVsEMA20 { get; set; }

        /// <summary>Absolute distance from EMA(20) normalized by ATR — how far from short-term mean</summary>
        public double DistanceFromEMA20_ATR { get; set; }

        /// <summary>"above" or "below" — price vs EMA(200) at entry</summary>
        public string PriceVsEMA200 { get; set; }

        /// <summary>Absolute distance from EMA(200) normalized by ATR — how far from long-term mean</summary>
        public double DistanceFromEMA200_ATR { get; set; }

        /// <summary>"inside", "above_upper", or "below_lower" — Bollinger Band position</summary>
        public string BollingerPosition { get; set; }

        /// <summary>"trending" (ADX >= 25) or "consolidating" (ADX &lt; 25)</summary>
        public string MarketRegime { get; set; }

        /// <summary>14-period ADX value — trend strength (0-100 scale)</summary>
        public double Adx14 { get; set; }

        /// <summary>Bollinger Bandwidth: (upper - lower) / middle — volatility spread</summary>
        public double BollingerBandwidth { get; set; }

        /// <summary>14-period ATR on 15-second bars — micro-timeframe volatility measure</summary>
        public double Atr14_15s { get; set; }

        public MarketContext()
        {
            PriceVsEMA20 = string.Empty;
            PriceVsEMA200 = string.Empty;
            BollingerPosition = string.Empty;
            MarketRegime = string.Empty;
        }

        /// <summary>
        /// Serializes the context object to a JSON block.
        /// </summary>
        public string ToJson()
        {
            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.AppendFormat("      \"atr14\": {0},\n", Atr14.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("      \"priceVsEMA20\": \"{0}\",\n", PriceVsEMA20);
            sb.AppendFormat("      \"distanceFromEMA20_ATR\": {0},\n", DistanceFromEMA20_ATR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("      \"priceVsEMA200\": \"{0}\",\n", PriceVsEMA200);
            sb.AppendFormat("      \"distanceFromEMA200_ATR\": {0},\n", DistanceFromEMA200_ATR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("      \"bollingerPosition\": \"{0}\",\n", BollingerPosition);
            sb.AppendFormat("      \"marketRegime\": \"{0}\",\n", MarketRegime);
            sb.AppendFormat("      \"adx14\": {0},\n", Adx14.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("      \"bollingerBandwidth\": {0},\n", BollingerBandwidth.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("      \"atr14_15s\": {0}\n", Atr14_15s.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
            sb.Append("    }");
            return sb.ToString();
        }
    }

    /// <summary>
    /// OpenTradeState — Internal mutable state tracking a live trade from entry to exit.
    ///
    /// Created when a position goes from Flat to Long/Short, destroyed when it returns to Flat.
    /// Tracks high/low price excursions tick-by-tick for MFE/MAE calculation.
    /// Holds the entry-time context snapshot until the trade completes and becomes a TradeRecord.
    ///
    /// Keyed in TradeTracker by "AccountName|Instrument|Direction".
    /// </summary>
    public class OpenTradeState
    {
        // ─── Entry Data ────────────────────────────────────────────────────────

        /// <summary>Timestamp of the entry execution</summary>
        public DateTime EntryTime { get; set; }

        /// <summary>Wall-clock time when the entry event was processed (DateTime.Now at entry)</summary>
        public DateTime RealEntryTime { get; set; }

        /// <summary>Full instrument name</summary>
        public string Instrument { get; set; }

        /// <summary>"Long" or "Short"</summary>
        public string Direction { get; set; }

        /// <summary>Entry fill price</summary>
        public double EntryPrice { get; set; }

        /// <summary>Number of contracts</summary>
        public int Quantity { get; set; }

        /// <summary>Signal name from the execution</summary>
        public string SignalName { get; set; }

        /// <summary>Account name for this trade</summary>
        public string AccountName { get; set; }

        // ─── Stop Price Tracking ───────────────────────────────────────────────

        /// <summary>
        /// Initial stop loss price, captured from OrderUpdate if a stop order is detected.
        /// If no stop order found, estimated from ATR(14) * StopEstimateMultiplier.
        /// </summary>
        public double InitialStopPrice { get; set; }

        /// <summary>Whether we found the actual stop via OrderUpdate vs estimated it</summary>
        public bool StopWasEstimated { get; set; }

        /// <summary>
        /// Take profit price captured from a Limit order in the OCO bracket.
        /// Used to compute SetupRR (intended risk-reward ratio) at trade exit.
        /// </summary>
        public double InitialTpPrice { get; set; }

        /// <summary>Whether a TP limit order was detected via OnOrderUpdate (false = no TP found)</summary>
        public bool TpWasDetected { get; set; }

        /// <summary>
        /// Whether this state was created by OnPositionUpdate as a "shell" entry.
        /// When true, the shell may have wrong direction (stale position data) or
        /// missing entry details. Branch A and Branch C use this flag to upgrade
        /// or discard the shell when the real execution fill arrives.
        /// </summary>
        public bool WasCreatedFromPositionUpdate { get; set; }

        // ─── RiskManager Bridge Data ────────────────────────────────────────────
        // Populated when the trade is created from a RiskManagerBridge entry event.
        // Defaults to false/0/"" for trades from regular execution flow.

        /// <summary>True if this trade was created from a RiskManagerBridge entry event</summary>
        public bool IsRiskManagerTrade { get; set; }

        /// <summary>Number of Risk Units risked (from RiskManager UI)</summary>
        public double RiskUnits { get; set; }

        /// <summary>Dollar value of 1 RU (from RiskManager UI)</summary>
        public double RuValue { get; set; }

        /// <summary>ATR multiplier used for SL distance (0 if manual SL)</summary>
        public double AtrMultiplier { get; set; }

        /// <summary>Reward:risk multiplier used for TP distance</summary>
        public double RRMultiplier { get; set; }

        /// <summary>SL placement mode: "ATR" or "Manual"</summary>
        public string SlMode { get; set; }

        // ─── MFE/MAE Tracking ──────────────────────────────────────────────────
        // Updated on every tick (MarketDataUpdate) or bar close (BarsRequest.Update)

        /// <summary>Highest price seen since entry — used for MFE on longs, MAE on shorts</summary>
        public double HighestPriceSinceEntry { get; set; }

        /// <summary>Lowest price seen since entry — used for MAE on longs, MFE on shorts</summary>
        public double LowestPriceSinceEntry { get; set; }

        // ─── Context Snapshot ──────────────────────────────────────────────────

        /// <summary>
        /// Market context captured at the moment of entry.
        /// Stored here until the trade completes and is written to TradeRecord.
        /// </summary>
        public MarketContext EntryContext { get; set; }

        /// <summary>
        /// Whether the entry POST to Supabase succeeded. If true, exit uses PATCH.
        /// If false (entry POST failed), exit falls back to full POST (INSERT).
        /// </summary>
        public bool EntryWrittenToSupabase { get; set; }

        /// <summary>
        /// Race condition guard: set true by HandleTradeExit on the NT event thread
        /// before the Supabase write decision. Read by WriteEntryAsync on the ThreadPool
        /// thread to abort the entry POST if the trade already closed before it fired.
        /// Must be volatile because it's written on one thread and read on another.
        /// </summary>
        public volatile bool TradeAlreadyClosed;

        public OpenTradeState()
        {
            Instrument = string.Empty;
            Direction = string.Empty;
            SignalName = string.Empty;
            AccountName = string.Empty;
            EntryContext = new MarketContext();
            StopWasEstimated = true;
            SlMode = string.Empty;
        }

        /// <summary>
        /// Updates MFE/MAE tracking with a new price observation.
        /// Called on every tick or bar update while the trade is open.
        /// </summary>
        /// <param name="price">Current market price</param>
        public void UpdateExcursion(double price)
        {
            if (price > HighestPriceSinceEntry)
                HighestPriceSinceEntry = price;
            if (price < LowestPriceSinceEntry)
                LowestPriceSinceEntry = price;
        }

        /// <summary>
        /// Calculates MFE in points based on direction.
        /// For longs: how far price went above entry (best unrealized profit).
        /// For shorts: how far price went below entry (best unrealized profit).
        /// </summary>
        public double GetMfePoints()
        {
            if (Direction == "Long")
                return HighestPriceSinceEntry - EntryPrice;
            else
                return EntryPrice - LowestPriceSinceEntry;
        }

        /// <summary>
        /// Calculates MAE in points based on direction.
        /// For longs: how far price went below entry (worst unrealized loss).
        /// For shorts: how far price went above entry (worst unrealized loss).
        /// </summary>
        public double GetMaePoints()
        {
            if (Direction == "Long")
                return EntryPrice - LowestPriceSinceEntry;
            else
                return HighestPriceSinceEntry - EntryPrice;
        }

        /// <summary>
        /// Calculates the initial stop distance in points (always positive).
        /// </summary>
        public double GetInitialStopDistance()
        {
            return Math.Abs(EntryPrice - InitialStopPrice);
        }
    }

    /// <summary>
    /// PostExitTrackingState — Tracks price movement for 20 minutes after a trade exits.
    ///
    /// After a trade closes, this state object monitors the market to answer:
    /// "What if I held longer?" — capturing the max favorable and adverse moves
    /// post-exit as both raw points and R-multiples of the initial stop distance.
    ///
    /// Lifecycle:
    /// 1. Created in HandleTradeExit after the trade is written to JSON + Supabase
    /// 2. Updated on every tick via UpdateExcursion(price) — same pattern as OpenTradeState
    /// 3. After 20 minutes (ExpiryTime), finalized and PATCHed to Supabase, then removed
    ///
    /// The composite key (EntryTime + Instrument + AccountName) uniquely identifies the
    /// Supabase row to PATCH when the monitoring window expires.
    /// </summary>
    public class PostExitTrackingState
    {
        // ─── Exit Snapshot ──────────────────────────────────────────────────────

        /// <summary>Price at which the trade was closed</summary>
        public double ExitPrice { get; set; }

        /// <summary>Timestamp when the trade exited</summary>
        public DateTime ExitTime { get; set; }

        /// <summary>"Long" or "Short" — direction of the original trade</summary>
        public string Direction { get; set; }

        /// <summary>Full instrument name (e.g., "NQ 03-26")</summary>
        public string Instrument { get; set; }

        /// <summary>Distance in points from entry to initial stop (used for R-multiple calc)</summary>
        public double InitialStopDistance { get; set; }

        // ─── Post-Exit Watermarks ───────────────────────────────────────────────
        // Updated every tick for 20 minutes after exit, same pattern as OpenTradeState

        /// <summary>Highest price observed since exit</summary>
        public double HighestPriceSinceExit { get; set; }

        /// <summary>Lowest price observed since exit</summary>
        public double LowestPriceSinceExit { get; set; }

        // ─── Expiry ─────────────────────────────────────────────────────────────

        /// <summary>When to stop monitoring: ExitTime + 20 minutes</summary>
        public DateTime ExpiryTime { get; set; }

        // ─── Composite Key for Supabase UPDATE ──────────────────────────────────
        // These fields uniquely identify the trade row in Supabase for the PATCH

        /// <summary>Original trade entry time — part of the Supabase row filter</summary>
        public DateTime EntryTime { get; set; }

        /// <summary>Account name — part of the Supabase row filter</summary>
        public string AccountName { get; set; }

        public PostExitTrackingState()
        {
            Direction = string.Empty;
            Instrument = string.Empty;
            AccountName = string.Empty;
        }

        /// <summary>
        /// Updates post-exit high/low watermarks with a new price observation.
        /// Called on every tick while the monitoring window is active.
        /// </summary>
        /// <param name="price">Current market price</param>
        public void UpdateExcursion(double price)
        {
            if (price > HighestPriceSinceExit)
                HighestPriceSinceExit = price;
            if (price < LowestPriceSinceExit)
                LowestPriceSinceExit = price;
        }

        /// <summary>
        /// Calculates post-exit MFE in points (direction-aware).
        /// For a closed Long: how much further price went UP after exit (missed profit).
        /// For a closed Short: how much further price went DOWN after exit (missed profit).
        /// </summary>
        public double GetPostExitMfePoints()
        {
            if (Direction == "Long")
                return HighestPriceSinceExit - ExitPrice;
            else
                return ExitPrice - LowestPriceSinceExit;
        }

        /// <summary>
        /// Calculates post-exit MAE in points (direction-aware).
        /// For a closed Long: how much price went DOWN after exit (validates exit was right).
        /// For a closed Short: how much price went UP after exit (validates exit was right).
        /// </summary>
        public double GetPostExitMaePoints()
        {
            if (Direction == "Long")
                return ExitPrice - LowestPriceSinceExit;
            else
                return HighestPriceSinceExit - ExitPrice;
        }

        /// <summary>
        /// Post-exit MFE as an R-multiple of the initial stop distance.
        /// Example: if initial stop was 10 points and price moved 20 points favorably
        /// after exit, this returns 2.0 — meaning "you left 2R on the table."
        /// </summary>
        public double GetPostExitMfeR()
        {
            if (InitialStopDistance <= 0) return 0;
            return GetPostExitMfePoints() / InitialStopDistance;
        }
    }
}
