#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// TradeZoneWriter — Supabase HTTP client for the TradeZone drawing tool.
    ///
    /// Handles a two-phase POST workflow:
    ///   Phase 1: POST zone metadata to /rest/v1/trade_zones with Prefer: return=representation
    ///            to get the auto-generated zone ID back from PostgREST.
    ///   Phase 2: POST all 15s bar data as a JSON array to /rest/v1/trade_zone_bars using
    ///            the zone ID as the foreign key.
    ///
    /// Follows the same patterns as SupabaseWriter.cs:
    /// - HttpWebRequest (.NET Framework 4.8, no HttpClient)
    /// - Manual JSON via StringBuilder (no Newtonsoft available in NT8)
    /// - Fire-and-forget async via Task.Run
    /// - Error logging to NinjaTrader Output tab, never crashes the caller
    /// </summary>
    public static class TradeZoneWriter
    {
        // ─── Endpoint resolution ─────────────────────────────────────────────────
        // Switch between cloud Supabase REST and the dashboard's local
        // /api/nt8/* routes via ModeConfig. The apikey/Authorization header
        // adds elsewhere in this file remain unchanged — local routes accept
        // (and ignore) those headers.
        private static string SUPABASE_URL => ModeConfig.Endpoint;
        private static string SUPABASE_ANON_KEY => ModeConfig.ApiKey;

        /// <summary>Endpoint for the trade_zones table.
        /// Resolves to `<endpoint>/rest/v1/trade_zones` in cloud mode and
        /// `<endpoint>/api/nt8/trade_zones` in local mode.</summary>
        private static string ZONES_ENDPOINT => ModeConfig.TableUrl("trade_zones");

        /// <summary>Endpoint for the trade_zone_bars table.</summary>
        private static string BARS_ENDPOINT => ModeConfig.TableUrl("trade_zone_bars");

        // ─── Internal Data Struct ────────────────────────────────────────────────

        /// <summary>
        /// Lightweight struct holding one bar's OHLCV data plus computed excursion values.
        /// Populated by the TradeZone drawing tool's BarsRequest callback, then passed
        /// to WriteZoneWithBarsAsync for Supabase upload.
        /// </summary>
        public struct ZoneBarData
        {
            public DateTime Time;
            public double Open;
            public double High;
            public double Low;
            public double Close;
            public long Volume;
            public int BarIndex;
            public double MfeFromStart;
            public double MaeFromStart;
            // Per-bar risk analytics
            public double DrawdownFromEntry;  // Running max adverse move from entry
            public double RunupFromEntry;     // Running max favorable move from entry
            public double CloseVsEntry;       // This bar's close vs entry (direction-aware, signed)
            public double HighSinceEntry;     // Running best favorable price reached
            public double RetraceFromPeak;    // How much given back from the peak
        }

        /// <summary>
        /// Market context snapshot at zone entry — computed from bars before the zone.
        /// Passed alongside bar data so the zone POST includes indicator values.
        /// </summary>
        public struct ZoneContext
        {
            public double Atr14;
            public double Adx14;
            public double Ema20;
            public double Ema200;
            public string PriceVsEma20;    // "above" or "below"
            public string PriceVsEma200;   // "above" or "below"
            public double DistEma20Atr;    // abs(price - ema20) / atr
            public string BollingerPos;    // "above_upper", "inside", "below_lower"
            public double BollingerBw;     // (upper - lower) / middle
            public int EntryHour;          // 0-23
            public int EntryDayOfWeek;     // 0=Sun..6=Sat
        }

        // ─── Public API ──────────────────────────────────────────────────────────

        /// <summary>
        /// Asynchronously POSTs a trade zone and its bar data to Supabase.
        /// Fire-and-forget: runs on a background thread so the DrawingTool's render
        /// thread is never blocked. If the POST fails, the error is logged but not thrown.
        ///
        /// Two-phase workflow:
        ///   1. POST zone metadata → get back the auto-generated zone ID
        ///   2. POST bars array with zone_id FK → batch insert all bars in one request
        /// </summary>
        /// <param name="instrument">Instrument full name (e.g., "NQ 03-26")</param>
        /// <param name="direction">"Long" or "Short"</param>
        /// <param name="startTime">Chronologically earlier anchor time</param>
        /// <param name="endTime">Chronologically later anchor time</param>
        /// <param name="startPrice">Entry price (first anchor placed by user)</param>
        /// <param name="endPrice">Exit price (second anchor placed by user)</param>
        /// <param name="chartTimeframe">Chart timeframe string (e.g., "15 Second")</param>
        /// <param name="notes">User-entered notes from properties panel (nullable)</param>
        /// <param name="bars">List of 15s bar data captured within the zone's time range</param>
        public static void WriteZoneWithBarsAsync(
            string instrument, string direction,
            DateTime startTime, DateTime endTime,
            double startPrice, double endPrice,
            string chartTimeframe, string notes,
            List<ZoneBarData> bars, ZoneContext ctx)
        {
            // Fire-and-forget on a ThreadPool thread
            Task.Run(() =>
            {
                try
                {
                    // Phase 1: POST zone metadata and get back the auto-generated ID
                    long zoneId = PostZone(instrument, direction, startTime, endTime,
                        startPrice, endPrice, chartTimeframe, notes, bars.Count, ctx);

                    if (zoneId <= 0)
                    {
                        NinjaTrader.Code.Output.Process(
                            "TradeZone: Failed to get zone ID from Supabase — skipping bars upload",
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        return;
                    }

                    // Phase 2: POST all bars as a batch insert with the zone_id FK
                    PostBars(zoneId, bars);

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeZone: Saved zone — {0} {1} (id: {2}, {3} bars, {4:F2} pts)",
                            direction, instrument, zoneId, bars.Count,
                            endPrice - startPrice),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                catch (Exception ex)
                {
                    // Catch-all safety net — log and swallow so the DrawingTool never crashes
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeZone: Unexpected error — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        // ─── Phase 1: POST Zone Metadata ─────────────────────────────────────────

        /// <summary>
        /// POSTs zone metadata to /rest/v1/trade_zones with Prefer: return=representation
        /// so PostgREST returns the inserted row as JSON. Parses the response to extract
        /// the auto-generated bigint ID for use as the foreign key in trade_zone_bars.
        ///
        /// Returns the zone ID on success, or -1 on failure.
        /// </summary>
        private static long PostZone(
            string instrument, string direction,
            DateTime startTime, DateTime endTime,
            double startPrice, double endPrice,
            string chartTimeframe, string notes,
            int barCount, ZoneContext ctx)
        {
            // Compute derived fields
            double pointsMove = direction == "Long"
                ? endPrice - startPrice
                : startPrice - endPrice;
            int durationSeconds = (int)(endTime - startTime).TotalSeconds;

            // Build JSON body manually (no Newtonsoft in NT8)
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"instrument\":\"{0}\",", EscapeJson(instrument));
            sb.AppendFormat("\"direction\":\"{0}\",", direction);
            sb.AppendFormat("\"start_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", startTime);
            sb.AppendFormat("\"end_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", endTime);
            sb.AppendFormat("\"start_price\":{0},", startPrice.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"end_price\":{0},", endPrice.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"bar_count\":{0},", barCount);
            sb.AppendFormat("\"points_move\":{0},", pointsMove.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"duration_seconds\":{0},", durationSeconds);
            sb.AppendFormat("\"notes\":{0},", notes != null ? "\"" + EscapeJson(notes) + "\"" : "null");
            sb.AppendFormat("\"chart_timeframe\":\"{0}\",", EscapeJson(chartTimeframe ?? ""));
            // Market context at entry
            sb.AppendFormat("\"ctx_atr14\":{0},", ctx.Atr14.ToString("F4", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_adx14\":{0},", ctx.Adx14.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_ema20\":{0},", ctx.Ema20.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_ema200\":{0},", ctx.Ema200.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_price_vs_ema20\":\"{0}\",", ctx.PriceVsEma20 ?? "");
            sb.AppendFormat("\"ctx_price_vs_ema200\":\"{0}\",", ctx.PriceVsEma200 ?? "");
            sb.AppendFormat("\"ctx_dist_ema20_atr\":{0},", ctx.DistEma20Atr.ToString("F4", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_bollinger_pos\":\"{0}\",", ctx.BollingerPos ?? "");
            sb.AppendFormat("\"ctx_bollinger_bw\":{0},", ctx.BollingerBw.ToString("F4", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"entry_hour\":{0},", ctx.EntryHour);
            sb.AppendFormat("\"entry_day_of_week\":{0}", ctx.EntryDayOfWeek);
            sb.Append("}");

            string json = sb.ToString();

            // Create the HTTP request — same pattern as SupabaseWriter.PostTrade
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(ZONES_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 10000;

            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            // return=representation makes PostgREST return the inserted row as JSON
            // so we can extract the auto-generated ID for the bars FK
            request.Headers.Add("Prefer", "return=representation");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
            {
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            // Send request and parse the response to extract the zone ID
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;

                    if (statusCode >= 200 && statusCode < 300)
                    {
                        // Read the response body to extract the auto-generated ID
                        // PostgREST returns: [{"id":42,"instrument":"NQ 03-26",...}]
                        using (var reader = new StreamReader(response.GetResponseStream()))
                        {
                            string responseBody = reader.ReadToEnd();
                            return ParseZoneId(responseBody);
                        }
                    }
                    else
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: Zone POST unexpected status {0}", statusCode),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        return -1;
                    }
                }
            }
            catch (WebException wex)
            {
                // Read the PostgREST error for diagnostics
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: Zone POST HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw for the outer catch-all
            }
        }

        // ─── Phase 2: POST Bars Batch ────────────────────────────────────────────

        /// <summary>
        /// POSTs all bar data as a JSON array to /rest/v1/trade_zone_bars in a single
        /// batch insert. PostgREST supports array bodies for multi-row INSERT.
        /// For a typical 5-minute zone on 15s bars, this is ~20 rows / ~3KB payload.
        /// </summary>
        private static void PostBars(long zoneId, List<ZoneBarData> bars)
        {
            if (bars.Count == 0) return;

            // Build JSON array of bar objects
            var sb = new StringBuilder();
            sb.Append("[");
            for (int i = 0; i < bars.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append("{");
                sb.AppendFormat("\"zone_id\":{0},", zoneId);
                sb.AppendFormat("\"bar_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", bars[i].Time);
                sb.AppendFormat("\"bar_open\":{0},", bars[i].Open.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_high\":{0},", bars[i].High.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_low\":{0},", bars[i].Low.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_close\":{0},", bars[i].Close.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_volume\":{0},", bars[i].Volume);
                sb.AppendFormat("\"bar_index\":{0},", bars[i].BarIndex);
                sb.AppendFormat("\"mfe_from_start\":{0},", bars[i].MfeFromStart.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"mae_from_start\":{0},", bars[i].MaeFromStart.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"drawdown_from_entry\":{0},", bars[i].DrawdownFromEntry.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"runup_from_entry\":{0},", bars[i].RunupFromEntry.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"close_vs_entry\":{0},", bars[i].CloseVsEntry.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"high_since_entry\":{0},", bars[i].HighSinceEntry.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"retrace_from_peak\":{0}", bars[i].RetraceFromPeak.ToString("F2", CultureInfo.InvariantCulture));
                sb.Append("}");
            }
            sb.Append("]");

            string json = sb.ToString();

            // Create the HTTP request
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(BARS_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 15000; // Slightly longer timeout for batch inserts

            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
            {
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode < 200 || statusCode >= 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: Bars POST unexpected status {0} for zone {1}",
                                statusCode, zoneId),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (WebException wex)
            {
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeZone: Bars POST HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw for the outer catch-all
            }
        }

        // ─── Helpers ─────────────────────────────────────────────────────────────

        /// <summary>
        /// Parses the auto-generated zone ID from PostgREST's return=representation response.
        /// Response format: [{"id":42,"instrument":"NQ 03-26",...}]
        /// Since we have no JSON parser in NT8, we do simple string extraction.
        /// Returns -1 if parsing fails.
        /// </summary>
        private static long ParseZoneId(string responseBody)
        {
            try
            {
                // Find "id": in the response and extract the number after it
                int idKeyIndex = responseBody.IndexOf("\"id\":");
                if (idKeyIndex < 0) return -1;

                int valueStart = idKeyIndex + 5; // length of "id":

                // Skip any whitespace after the colon
                while (valueStart < responseBody.Length && responseBody[valueStart] == ' ')
                    valueStart++;

                // Extract digits until we hit a non-digit character (comma, }, etc.)
                int valueEnd = valueStart;
                while (valueEnd < responseBody.Length && char.IsDigit(responseBody[valueEnd]))
                    valueEnd++;

                if (valueEnd == valueStart) return -1;

                string idStr = responseBody.Substring(valueStart, valueEnd - valueStart);
                return long.Parse(idStr);
            }
            catch
            {
                // If parsing fails for any reason, log and return failure
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeZone: Failed to parse zone ID from response: {0}",
                        responseBody.Length > 200 ? responseBody.Substring(0, 200) : responseBody),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return -1;
            }
        }

        /// <summary>
        /// Minimal JSON string escaping — handles backslash, double-quote, and newlines.
        /// Sufficient for instrument names, notes, and timeframe strings.
        /// </summary>
        private static string EscapeJson(string input)
        {
            if (string.IsNullOrEmpty(input)) return "";
            return input
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
        }
    }
}
