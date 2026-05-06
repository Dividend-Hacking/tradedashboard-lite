#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.Gui.SuperDom;
using NinjaTrader.Gui.Tools;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.Core.FloatingPoint;
using NinjaTrader.NinjaScript.Indicators;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    /// <summary>
    /// NQ Buy-and-Hold — Passive Benchmark Strategy
    ///
    /// Provides a baseline for comparing active strategy performance against
    /// simple passive holding. Run this side-by-side with any active strategy
    /// in the Strategy Analyzer to determine if the active strategy actually
    /// outperforms a naive long-only approach.
    ///
    /// Two modes:
    ///   1. Daily mode (HoldForever = false, default):
    ///      - Enters long at SessionStart each day, flattens at EODTime.
    ///      - Fair comparison against other strategies that also flatten EOD.
    ///
    ///   2. Hold forever mode (HoldForever = true):
    ///      - Enters long on the very first bar and never exits.
    ///      - Measures pure buy-and-hold across the entire backtest period.
    ///
    /// No stops, trailing, partial TP, cooldown, or indicators — this is
    /// a pure benchmark. Self-contained (inherits directly from Strategy).
    /// </summary>
    public class NQBuyAndHold : Strategy
    {
        // ─── Day tracking state ───
        // Tracks the current trading day so we only enter once per session.
        // Compared against Time[0].Date to detect new days.
        private DateTime lastTradeDate;

        // Flag to prevent double-entry within a single trading day.
        // Reset to false each new day; set to true after entering long.
        private bool enteredToday;

        #region Parameters

        [NinjaScriptProperty]
        [Range(1, 100)]
        [Display(Name = "Contracts", Description = "Number of contracts to hold (start with 1 MNQ for testing)", Order = 1, GroupName = "1. Position Sizing")]
        public int Contracts { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Hold Forever", Description = "True = enter once and never exit (pure buy-and-hold). False = daily enter/flatten cycle.", Order = 2, GroupName = "2. Hold Mode")]
        public bool HoldForever { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Close EOD", Description = "Flatten position before market close (only applies when HoldForever = false)", Order = 3, GroupName = "3. Session Management")]
        public bool CloseEOD { get; set; }

        [NinjaScriptProperty]
        [Range(0, 2359)]
        [Display(Name = "EOD Time", Description = "Time to flatten positions (HHMM format, e.g. 1610 = 4:10 PM)", Order = 4, GroupName = "3. Session Management")]
        public int EODTime { get; set; }

        [NinjaScriptProperty]
        [Range(0, 2359)]
        [Display(Name = "Session Start", Description = "Earliest time to enter long each day (HHMM format, e.g. 930 = 9:30 AM)", Order = 5, GroupName = "3. Session Management")]
        public int SessionStart { get; set; }

        // ─── Auto Export parameters ───
        // Used by BacktestRunner to have the strategy self-report its results.
        // BacktestRunner sets these on the SA template before firing the run ICommand.
        // At State.Terminated, if AutoExport=true and RunId is set, the strategy writes
        // its own SystemPerformance to a JSON file in the outgoing/ directory.
        // This avoids the VM-polling deadlock that killed all previous AddOn approaches.

        [NinjaScriptProperty]
        [Display(Name = "Run ID", Description = "Unique ID for this backtest run — set by BacktestRunner for result file naming. Leave empty for manual runs.", Order = 6, GroupName = "4. Auto Export")]
        public string RunId { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Auto Export", Description = "When true, strategy writes its own results to outgoing/backtest_result_{RunId}.json at termination. Set by BacktestRunner.", Order = 7, GroupName = "4. Auto Export")]
        public bool AutoExport { get; set; }

        #endregion

        #region State Management

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                // ─── Strategy identity ───
                Description = "Passive long-only benchmark — enter at open, hold until EOD or forever. Use to compare active strategies against buy-and-hold.";
                Name = "NQBuyAndHold";

                // ─── Standard NinjaTrader settings (match other NQ strategies) ───
                Calculate = Calculate.OnBarClose;
                EntriesPerDirection = 1;
                EntryHandling = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = false;
                ExitOnSessionCloseSeconds = 30;
                IsFillLimitOnTouch = false;
                MaximumBarsLookBack = MaximumBarsLookBack.TwoHundredFiftySix;
                OrderFillResolution = OrderFillResolution.Standard;
                Slippage = 2;
                StartBehavior = StartBehavior.WaitUntilFlat;
                TimeInForce = TimeInForce.Gtc;
                TraceOrders = false;
                RealtimeErrorHandling = RealtimeErrorHandling.StopCancelClose;
                StopTargetHandling = StopTargetHandling.PerEntryExecution;

                // No indicator warmup needed — enter on the very first bar
                BarsRequiredToTrade = 1;

                // ─── Parameter defaults ───
                Contracts = 1;
                HoldForever = false;
                CloseEOD = true;
                EODTime = 1610;
                SessionStart = 930;

                // Auto Export defaults — off by default, set by BacktestRunner per-run
                RunId      = "";
                AutoExport = false;
            }
            else if (State == State.DataLoaded)
            {
                // ─── Initialize day tracking ───
                lastTradeDate = DateTime.MinValue;
                enteredToday = false;
            }
            else if (State == State.Terminated)
            {
                // ─── Auto Export at termination ───
                // SystemPerformance is fully populated by the time State.Terminated fires.
                // This is the safest place to read it — the engine has already stopped,
                // so there are no threading concerns.
                if (AutoExport && !string.IsNullOrEmpty(RunId))
                    ExportResults();
            }
        }

        #endregion

        #region Auto Export

        /// <summary>
        /// Reads SystemPerformance at State.Terminated and writes a JSON result file to
        /// {UserDataDir}\outgoing\backtest_result_{RunId}.json.
        ///
        /// Called only when AutoExport=true and RunId is non-empty — both are set by
        /// BacktestRunner before triggering the SA run ICommand.
        ///
        /// This eliminates the VM-polling deadlock: instead of BacktestRunner trying to
        /// read SystemPerformance from the SA ViewModel (wrong thread, freezes NT8), the
        /// strategy itself reads its own perf and writes the file. BacktestRunner just
        /// polls for the file's existence — zero WPF involvement.
        ///
        /// JSON schema matches BacktestRunner.BuildResultJson so the Mac CLI can parse it
        /// identically regardless of which component wrote the file.
        /// </summary>
        private void ExportResults()
        {
            try
            {
                Print("NQBuyAndHold AutoExport: writing result for RunId=" + RunId);

                // Ensure outgoing directory exists (BacktestRunner also creates it, but be safe)
                string outgoingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "outgoing");
                Directory.CreateDirectory(outgoingDir);

                string outputPath = Path.Combine(outgoingDir, "backtest_result_" + RunId + ".json");

                // ─── Read SystemPerformance metrics ───
                // All fields confirmed from NT8 OptimizationFitnesses samples and BacktestRunner.ExtractResults.
                var all     = SystemPerformance.AllTrades;
                var wins    = SystemPerformance.AllTrades.WinningTrades;
                var loss    = SystemPerformance.AllTrades.LosingTrades;
                var allPerf = all.TradesPerformance;

                int totalTrades   = all.TradesCount;
                int winningTrades = wins.TradesCount;
                int losingTrades  = loss.TradesCount;

                double grossProfit  = allPerf.GrossProfit;
                double grossLoss    = allPerf.GrossLoss;
                double netProfit    = grossProfit + grossLoss; // GrossLoss is negative
                double profitFactor = allPerf.ProfitFactor;
                double sharpe       = allPerf.SharpeRatio;
                double sortino      = allPerf.SortinoRatio;
                double drawdownPct  = Math.Abs(allPerf.Percent.Drawdown);
                double avgProfit    = allPerf.Percent.AverageProfit;

                double winRate = totalTrades > 0
                    ? (double)winningTrades / totalTrades * 100.0
                    : 0.0;

                double avgWinner = winningTrades > 0 ? wins.TradesPerformance.Percent.AverageProfit  : 0.0;
                double avgLoser  = losingTrades  > 0 ? loss.TradesPerformance.Percent.AverageProfit  : 0.0;

                // ─── Build JSON manually (no JSON library in NT8) ───
                var sb = new StringBuilder();
                sb.Append("{");
                sb.AppendFormat("\"run_id\":\"{0}\",",            EscapeJson(RunId));
                sb.AppendFormat("\"strategy\":\"NQBuyAndHold\",");
                // Instrument.FullName, BarsPeriod.Value, Account.Name are all standard
                // NinjaTrader.NinjaScript.StrategyBase properties available at Terminated
                sb.AppendFormat("\"instrument\":\"{0}\",",        EscapeJson(Instrument.FullName));
                sb.AppendFormat("\"timeframe_minutes\":{0},",     BarsPeriod.Value);
                // BacktestRunner.ParseResultJson() fills from_date/to_date from the request object,
                // so the strategy just emits empty strings — no Strategy property needed.
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

                // Write with no BOM — Python json.loads rejects BOM-prefixed files
                File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(false));

                Print("NQBuyAndHold AutoExport: result written to " + outputPath);
            }
            catch (Exception ex)
            {
                Print("NQBuyAndHold AutoExport: ERROR — " + ex.Message + "\n" + ex.StackTrace);
            }
        }

        /// <summary>Formats double to 2 decimal places with InvariantCulture (period separator).</summary>
        private static string F2(double v) => v.ToString("F2", CultureInfo.InvariantCulture);

        /// <summary>Formats double to 4 decimal places with InvariantCulture (period separator).</summary>
        private static string F4(double v) => v.ToString("F4", CultureInfo.InvariantCulture);

        /// <summary>Escapes special characters for safe embedding in a JSON string value.</summary>
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

        #region Core Bar Processing Loop

        protected override void OnBarUpdate()
        {
            if (CurrentBar < BarsRequiredToTrade)
                return;

            // ─── Detect new trading day ───
            // Compare today's date to the last bar's tracked date.
            // When the date changes, reset the enteredToday flag so we can
            // enter a fresh position for this session.
            if (Time[0].Date != lastTradeDate)
            {
                lastTradeDate = Time[0].Date;
                enteredToday = false;
            }

            // ToTime() returns HHmmss (6-digit integer, e.g. 143025 = 2:30:25 PM).
            // Divide by 100 to get HHMM (e.g. 1430). Same pattern as other NQ strategies.
            int currentTime = ToTime(Time[0]) / 100;

            // ─── Hold Forever mode ───
            // Enter long on the very first opportunity and never exit.
            // Once in position, there's nothing else to do.
            if (HoldForever)
            {
                if (Position.MarketPosition == MarketPosition.Flat && !enteredToday)
                {
                    EnterLong(Contracts, "BuyAndHold");
                    enteredToday = true;
                }
                return;
            }

            // ─── Daily mode ───
            // Enter long once per day at/after SessionStart, flatten at EODTime.
            if (Position.MarketPosition == MarketPosition.Flat)
            {
                // Only enter if we haven't already entered today and
                // the current time is at or after the session start
                if (!enteredToday && currentTime >= SessionStart)
                {
                    EnterLong(Contracts, "DailyLong");
                    enteredToday = true;
                }
            }
            else
            {
                // ─── EOD Flatten ───
                // Close the position at EODTime, same as all other strategies
                // for fair side-by-side comparison in Strategy Analyzer
                if (CloseEOD && currentTime >= EODTime)
                {
                    ExitLong("EOD Flatten");
                }
            }
        }

        #endregion
    }
}
