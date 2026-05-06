#region Using declarations
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// TradeJsonWriter — Thread-safe daily JSON file writer for completed trades.
    ///
    /// Writes TradeRecords to daily files at:
    ///   {NinjaTrader.Core.Globals.UserDataDir}\TradeTracker\trades_YYYY-MM-DD.json
    ///
    /// Design choices:
    /// - Read-modify-write pattern: trade frequency is low (tens per day max), so we read
    ///   the existing file, append the new trade, and rewrite. This keeps the file as valid
    ///   JSON at all times (a JSON array of TradeRecord objects).
    /// - Manual JSON via StringBuilder: NT8 ships no JSON library (no Newtonsoft.Json),
    ///   and we avoid external DLL dependencies to keep deployment simple.
    /// - Thread-safe via lock: ExecutionUpdate fires on a non-UI thread, so concurrent
    ///   writes to the same file must be serialized.
    /// </summary>
    public class TradeJsonWriter
    {
        // Lock object for thread safety — all file operations are serialized through this
        private readonly object _writeLock = new object();

        // Base directory for all TradeTracker output files
        private readonly string _baseDirectory;

        /// <summary>
        /// Creates a new TradeJsonWriter that stores files under the NinjaTrader user data directory.
        /// Creates the TradeTracker subdirectory if it doesn't exist.
        /// </summary>
        public TradeJsonWriter()
        {
            // NinjaTrader.Core.Globals.UserDataDir is typically:
            // C:\Users\{user}\Documents\NinjaTrader 8\
            _baseDirectory = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "TradeTracker");

            // Ensure output directory exists on construction
            if (!Directory.Exists(_baseDirectory))
                Directory.CreateDirectory(_baseDirectory);
        }

        /// <summary>
        /// Appends a completed trade to the daily JSON file.
        ///
        /// Thread-safe: uses a lock to serialize concurrent writes.
        /// The file is always a valid JSON array after this call completes.
        ///
        /// File naming: trades_YYYY-MM-DD.json (based on the trade's exit time).
        /// </summary>
        /// <param name="trade">The completed TradeRecord to persist</param>
        public void WriteTrade(TradeRecord trade)
        {
            lock (_writeLock)
            {
                try
                {
                    // Use exit time for the daily file — trade "belongs" to the day it closed
                    string fileName = string.Format("trades_{0:yyyy-MM-dd}.json", trade.ExitTime);
                    string filePath = Path.Combine(_baseDirectory, fileName);

                    // Read existing trades from the file (if any)
                    List<string> existingTradeJsons = new List<string>();
                    if (File.Exists(filePath))
                    {
                        string existingContent = File.ReadAllText(filePath).Trim();
                        existingTradeJsons = ParseExistingTrades(existingContent);
                    }

                    // Add the new trade's JSON
                    existingTradeJsons.Add(trade.ToJson());

                    // Rebuild the complete JSON array and write it back
                    StringBuilder sb = new StringBuilder();
                    sb.Append("[\n");
                    for (int i = 0; i < existingTradeJsons.Count; i++)
                    {
                        sb.Append(existingTradeJsons[i]);
                        if (i < existingTradeJsons.Count - 1)
                            sb.Append(",");
                        sb.Append("\n");
                    }
                    sb.Append("]");

                    File.WriteAllText(filePath, sb.ToString());
                }
                catch (Exception ex)
                {
                    // Log the error but don't crash — trade logging is non-critical
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Error writing trade — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
        }

        /// <summary>
        /// Parses existing trade JSON objects from a daily file.
        ///
        /// Uses brace-depth counting to extract individual trade objects from the array.
        /// This is simpler and more robust than trying to parse full JSON — we only need
        /// to split the array into its top-level objects so we can append a new one.
        ///
        /// Example input:  [\n  { ... },\n  { ... }\n]
        /// Example output: List of "  { ... }" strings
        /// </summary>
        /// <param name="jsonContent">Raw file content (should be a JSON array)</param>
        /// <returns>List of individual trade JSON strings</returns>
        private List<string> ParseExistingTrades(string jsonContent)
        {
            var trades = new List<string>();

            if (string.IsNullOrEmpty(jsonContent) || jsonContent.Length < 2)
                return trades;

            // Track brace depth to find top-level object boundaries
            // depth 0 = outside any object, depth 1 = inside a top-level object
            int depth = 0;
            int objectStart = -1;
            bool inString = false;
            bool escaped = false;

            for (int i = 0; i < jsonContent.Length; i++)
            {
                char c = jsonContent[i];

                // Handle string literals (skip everything inside quotes)
                if (escaped)
                {
                    escaped = false;
                    continue;
                }
                if (c == '\\' && inString)
                {
                    escaped = true;
                    continue;
                }
                if (c == '"')
                {
                    inString = !inString;
                    continue;
                }
                if (inString) continue;

                // Track brace depth for object boundaries
                if (c == '{')
                {
                    depth++;
                    if (depth == 1)
                        objectStart = i;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0 && objectStart >= 0)
                    {
                        // Extract the complete object including leading whitespace
                        // Look back from objectStart to find leading whitespace
                        int start = objectStart;
                        while (start > 0 && (jsonContent[start - 1] == ' ' || jsonContent[start - 1] == '\t'))
                            start--;

                        trades.Add(jsonContent.Substring(start, i - start + 1));
                        objectStart = -1;
                    }
                }
            }

            return trades;
        }
    }
}
