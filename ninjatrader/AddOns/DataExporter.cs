#region Using declarations
using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Xml.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ═══════════════════════════════════════════════════════════════════════════
    // DataExporter — Bootstrap AddOn that:
    //   1. Injects "Data Exporter" into Control Center > New menu (manual UI)
    //   2. Polls Supabase data_requests table every 15s for web-initiated exports
    //
    // The polling timer runs at the AddOn level (independent of any window),
    // calling static methods on DataExportHelper to fetch bars and upload them.
    // ═══════════════════════════════════════════════════════════════════════════

    public class DataExporter : AddOnBase
    {
        private NTMenuItem _menuItem;
        private static Timer _pollTimer;

        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    Name = "DataExporter";
                    Description = "Export historical bar data to Supabase for the web practice trading tool";
                    break;

                case State.Active:
                    // Start polling for web-initiated data requests every 15 seconds
                    // Initial delay of 10s to let NinjaTrader finish loading
                    if (_pollTimer == null)
                    {
                        _pollTimer = new Timer(
                            callback: _ => DataExportHelper.PollForDataRequests(),
                            state: null,
                            dueTime: TimeSpan.FromSeconds(10),
                            period: TimeSpan.FromSeconds(15));

                        DataExportHelper.Log("DataExporter: Polling for web data requests every 15s");
                    }
                    break;

                case State.Terminated:
                    if (_pollTimer != null)
                    {
                        _pollTimer.Dispose();
                        _pollTimer = null;
                    }
                    break;
            }
        }

        /// <summary>
        /// Inject "Data Exporter" into Control Center > New menu.
        /// </summary>
        protected override void OnWindowCreated(Window window)
        {
            if (window is DataExporterWindow deWindow)
                deWindow.WorkspaceOptions = new WorkspaceOptions("DataExporter-" + Guid.NewGuid().ToString("N"), deWindow);

            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null) return;
            if (_menuItem != null) return;

            NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null) return;

            _menuItem = new NTMenuItem()
            {
                Header = "Data Exporter",
                Style = Application.Current.TryFindResource("SubItemStyle") as Style
            };
            _menuItem.Click += OnMenuItemClick;
            newMenu.Items.Add(_menuItem);
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (_menuItem != null && window is ControlCenter)
            {
                ControlCenter controlCenter = window as ControlCenter;
                NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
                if (newMenu != null)
                    newMenu.Items.Remove(_menuItem);

                _menuItem.Click -= OnMenuItemClick;
                _menuItem = null;
            }
        }

        private void OnMenuItemClick(object sender, RoutedEventArgs e)
        {
            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                new DataExporterWindow().Show();
            }));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DataExportHelper — Static utility class containing all Supabase HTTP methods
    // and BarsRequest → upload logic. Used by both:
    //   1. The polling timer (web-initiated requests)
    //   2. The manual DataExporterWindow UI
    //
    // All methods are static and thread-safe. No UI dependencies.
    // ═══════════════════════════════════════════════════════════════════════════

    public static class DataExportHelper
    {
        // ─── Supabase ──────────────────────────────────────────────────────────
        // URL + key loaded from livebridge.config.json at runtime — see LiveBridgeConfig.cs.
        private static string SUPABASE_URL { get { return LiveBridgeConfig.Url; } }
        private static string SUPABASE_ANON_KEY { get { return LiveBridgeConfig.AnonKey; } }
        private static string SESSIONS_ENDPOINT { get { return SUPABASE_URL + "/rest/v1/replay_sessions"; } }
        private static string BARS_ENDPOINT { get { return SUPABASE_URL + "/rest/v1/replay_bars"; } }
        private static string DATA_REQUESTS_ENDPOINT { get { return SUPABASE_URL + "/rest/v1/data_requests"; } }

        // ─── Polling State ─────────────────────────────────────────────────────
        private static readonly object _pollLock = new object();
        private static bool _isProcessingRequest;

        // ═══════════════════════════════════════════════════════════════════════
        // POLLING: Web-Initiated Data Requests
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// Timer callback — polls data_requests table for the oldest pending request.
        /// If found, marks it processing, fetches bars via BarsRequest, uploads to
        /// Supabase, and marks it completed (or error).
        ///
        /// Thread-safe: uses _pollLock + _isProcessingRequest flag, same pattern
        /// as BacktestRunner's ProcessRequestIfPresent.
        /// </summary>
        public static void PollForDataRequests()
        {
            lock (_pollLock)
            {
                if (_isProcessingRequest) return;
                _isProcessingRequest = true;
            }

            try
            {
                // GET the oldest pending request
                string json = SupabaseGet(DATA_REQUESTS_ENDPOINT,
                    "status=eq.pending&order=created_at.asc&limit=1&select=id,instrument,timeframe,session_date");

                if (string.IsNullOrEmpty(json) || json.Trim() == "[]") return;

                // Parse request fields
                long requestId = ParseLongField(json, "id");
                string instrument = ParseStringField(json, "instrument");
                string timeframe = ParseStringField(json, "timeframe");
                string sessionDate = ParseStringField(json, "session_date");

                if (requestId <= 0 || instrument == null || timeframe == null || sessionDate == null) return;

                // Mark as processing
                bool updated = SupabasePatch(DATA_REQUESTS_ENDPOINT,
                    "id=eq." + requestId,
                    "{\"status\":\"processing\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
                if (!updated) return;

                Log(string.Format("DataExporter: Processing request #{0} — {1} {2} {3}",
                    requestId, instrument, timeframe, sessionDate));

                // Process the request (BarsRequest → upload)
                ProcessDataRequest(requestId, instrument, timeframe, sessionDate);
            }
            catch (Exception ex)
            {
                Log("DataExporter: Poll error — " + ex.Message);
            }
            finally
            {
                lock (_pollLock) _isProcessingRequest = false;
            }
        }

        /// <summary>
        /// Fetches bars via BarsRequest and uploads to Supabase for a data request.
        ///
        /// Two-step approach to work around BarsRequest limitations from AddOn context:
        ///   Step 1: Small count-based request (10 bars) to "warm up" the data connection
        ///   Step 2: Time-range request for the actual target date (inside step 1's callback)
        ///
        /// The time-range constructor returns 0 bars when called cold from an AddOn,
        /// but may work after the data connection has been activated by a count-based request.
        /// If step 2 still fails, falls back to count-based with enough bars to reach the date.
        /// </summary>
        private static void ProcessDataRequest(long requestId, string instrumentName,
            string timeframe, string sessionDate)
        {
            // Resolve instrument
            Instrument instrument = Instrument.GetInstrument(instrumentName, false);
            if (instrument == null)
            {
                PatchRequestError(requestId, "Instrument not found: " + instrumentName);
                return;
            }

            // Parse timeframe
            BarsPeriodType periodType;
            int periodValue;
            ParseTimeframe(timeframe, out periodType, out periodValue);

            // Parse target date
            DateTime targetDate;
            if (!DateTime.TryParseExact(sessionDate, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out targetDate))
            {
                PatchRequestError(requestId, "Invalid session_date: " + sessionDate);
                return;
            }

            // Time range covering the full session day (previous day 4pm to next day)
            DateTime requestFrom = targetDate.AddDays(-1).AddHours(16);
            DateTime requestTo = targetDate.AddDays(1);

            var completionSignal = new ManualResetEventSlim(false);
            string errorMsg = null;

            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    Log("DataExporter: Step 1 — warming up data connection with count-based request...");

                    // Step 1: Small count-based request to activate the data connection
                    var warmupRequest = new BarsRequest(instrument, 10);
                    warmupRequest.BarsPeriod = new BarsPeriod { BarsPeriodType = periodType, Value = periodValue };

                    warmupRequest.Request(new Action<BarsRequest, ErrorCode, string>((warmupReq, warmupError, warmupMsg) =>
                    {
                        try
                        {
                            Log(string.Format("DataExporter: Warmup returned {0} bars (error: {1})",
                                warmupError == ErrorCode.NoError ? warmupReq.Bars.Count.ToString() : "N/A",
                                warmupError));

                            // Step 2: Now try time-range request for the actual target date
                            Log(string.Format("DataExporter: Step 2 — requesting bars for {0} ({1:MM/dd HH:mm} to {2:MM/dd HH:mm})",
                                sessionDate, requestFrom, requestTo));

                            var targetRequest = new BarsRequest(instrument, requestFrom, requestTo);
                            targetRequest.BarsPeriod = new BarsPeriod { BarsPeriodType = periodType, Value = periodValue };

                            targetRequest.Request(new Action<BarsRequest, ErrorCode, string>((req, errorCode, errMessage) =>
                            {
                                try
                                {
                                    if (errorCode != ErrorCode.NoError)
                                    {
                                        errorMsg = string.Format("BarsRequest error: {0} — {1}", errorCode, errMessage);
                                        return;
                                    }

                                    int totalBars = req.Bars.Count;
                                    Log(string.Format("DataExporter: Time-range request returned {0} bars", totalBars));

                                    if (totalBars == 0)
                                    {
                                        errorMsg = "No bars returned for " + instrumentName + " " + timeframe +
                                            " " + sessionDate + " — even after warmup. Data may not be available " +
                                            "from your data provider for this date.";
                                        return;
                                    }

                                    // Filter bars to target date only (the request window is wider)
                                    var matchTimes = new System.Collections.Generic.List<DateTime>();
                                    var matchOpens = new System.Collections.Generic.List<double>();
                                    var matchHighs = new System.Collections.Generic.List<double>();
                                    var matchLows = new System.Collections.Generic.List<double>();
                                    var matchCloses = new System.Collections.Generic.List<double>();
                                    var matchVolumes = new System.Collections.Generic.List<long>();

                                    for (int i = 0; i < totalBars; i++)
                                    {
                                        DateTime barTime = req.Bars.GetTime(i);
                                        if (barTime.Date == targetDate)
                                        {
                                            matchTimes.Add(barTime);
                                            matchOpens.Add(req.Bars.GetOpen(i));
                                            matchHighs.Add(req.Bars.GetHigh(i));
                                            matchLows.Add(req.Bars.GetLow(i));
                                            matchCloses.Add(req.Bars.GetClose(i));
                                            matchVolumes.Add(req.Bars.GetVolume(i));
                                        }
                                    }

                                    int matchCount = matchTimes.Count;
                                    if (matchCount == 0)
                                    {
                                        // Use all bars if none match target date exactly
                                        // (session boundaries may put bars on adjacent dates)
                                        for (int i = 0; i < totalBars; i++)
                                        {
                                            matchTimes.Add(req.Bars.GetTime(i));
                                            matchOpens.Add(req.Bars.GetOpen(i));
                                            matchHighs.Add(req.Bars.GetHigh(i));
                                            matchLows.Add(req.Bars.GetLow(i));
                                            matchCloses.Add(req.Bars.GetClose(i));
                                            matchVolumes.Add(req.Bars.GetVolume(i));
                                        }
                                        matchCount = totalBars;
                                    }

                                    Log(string.Format("DataExporter: {0} bars to upload for {1}", matchCount, sessionDate));

                                    DateTime firstBarTime = matchTimes[0];
                                    DateTime lastBarTime = matchTimes[matchCount - 1];

                                    // Phase 1: POST session metadata
                                    long sessionId = PostSession(instrumentName, timeframe,
                                        sessionDate, firstBarTime, lastBarTime, matchCount);

                                    if (sessionId <= 0)
                                    {
                                        errorMsg = "Failed to create replay_session (may already exist)";
                                        return;
                                    }

                                    // Phase 2: POST filtered bars in chunks
                                    int chunkSize = 500;
                                    int chunks = (matchCount + chunkSize - 1) / chunkSize;
                                    for (int chunk = 0; chunk < chunks; chunk++)
                                    {
                                        int start = chunk * chunkSize;
                                        int end = Math.Min(start + chunkSize, matchCount);
                                        PostFilteredBarChunk(sessionId, matchTimes, matchOpens, matchHighs,
                                            matchLows, matchCloses, matchVolumes, start, end);
                                    }

                                    // Mark request as completed
                                    SupabasePatch(DATA_REQUESTS_ENDPOINT,
                                        "id=eq." + requestId,
                                        string.Format("{{\"status\":\"completed\",\"replay_session_id\":{0},\"updated_at\":\"{1}\"}}",
                                            sessionId, DateTime.UtcNow.ToString("o")));

                                    Log(string.Format("DataExporter: Request #{0} completed — session {1} ({2} bars)",
                                        requestId, sessionId, matchCount));
                                }
                                catch (Exception ex)
                                {
                                    errorMsg = ex.Message;
                                }
                                finally
                                {
                                    completionSignal.Set();
                                }
                            }));
                        }
                        catch (Exception ex)
                        {
                            errorMsg = "Step 2 error: " + ex.Message;
                            completionSignal.Set();
                        }
                    }));
                }
                catch (Exception ex)
                {
                    errorMsg = "Step 1 error: " + ex.Message;
                    completionSignal.Set();
                }
            }));

            // Wait up to 5 minutes
            bool completed = completionSignal.Wait(TimeSpan.FromMinutes(5));

            if (!completed)
                PatchRequestError(requestId, "BarsRequest timed out after 5 minutes");
            else if (errorMsg != null)
                PatchRequestError(requestId, errorMsg);
        }

        /// <summary>
        /// POSTs a chunk of pre-filtered bar data as a JSON array to replay_bars.
        /// Used by the polling path where bars have been filtered from a count-based BarsRequest.
        /// </summary>
        private static void PostFilteredBarChunk(long sessionId,
            System.Collections.Generic.List<DateTime> times,
            System.Collections.Generic.List<double> opens,
            System.Collections.Generic.List<double> highs,
            System.Collections.Generic.List<double> lows,
            System.Collections.Generic.List<double> closes,
            System.Collections.Generic.List<long> volumes,
            int startIdx, int endIdx)
        {
            var sb = new StringBuilder();
            sb.Append("[");
            for (int i = startIdx; i < endIdx; i++)
            {
                if (i > startIdx) sb.Append(",");
                sb.Append("{");
                sb.AppendFormat("\"session_id\":{0},", sessionId);
                sb.AppendFormat("\"bar_index\":{0},", i);
                sb.AppendFormat("\"bar_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", times[i]);
                sb.AppendFormat("\"bar_open\":{0},", opens[i].ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_high\":{0},", highs[i].ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_low\":{0},", lows[i].ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_close\":{0},", closes[i].ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_volume\":{0}", volumes[i]);
                sb.Append("}");
            }
            sb.Append("]");

            string json = sb.ToString();

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(BARS_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 30000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode < 200 || statusCode >= 300)
                    {
                        Log(string.Format("DataExporter: Bars POST status {0} for session {1}", statusCode, sessionId));
                    }
                }
            }
            catch (WebException wex)
            {
                LogWebException("Filtered Bars POST", wex);
                throw;
            }
        }

        /// <summary>Mark a data request as error with an error message.</summary>
        private static void PatchRequestError(long requestId, string error)
        {
            SupabasePatch(DATA_REQUESTS_ENDPOINT,
                "id=eq." + requestId,
                string.Format("{{\"status\":\"error\",\"error_message\":\"{0}\",\"updated_at\":\"{1}\"}}",
                    EscapeJson(error), DateTime.UtcNow.ToString("o")));
            Log("DataExporter: Request #" + requestId + " failed — " + error);
        }

        // ═══════════════════════════════════════════════════════════════════════
        // SUPABASE HTTP: POST, GET, PATCH
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// POSTs session metadata to replay_sessions with Prefer: return=representation.
        /// Returns the auto-generated session ID, or -1 on failure.
        /// </summary>
        public static long PostSession(string instrument, string timeframe,
            string sessionDate, DateTime startTime, DateTime endTime, int barCount)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"instrument\":\"{0}\",", EscapeJson(instrument));
            sb.AppendFormat("\"timeframe\":\"{0}\",", EscapeJson(timeframe));
            sb.AppendFormat("\"session_date\":\"{0}\",", sessionDate);
            sb.AppendFormat("\"start_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", startTime);
            sb.AppendFormat("\"end_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", endTime);
            sb.AppendFormat("\"bar_count\":{0}", barCount);
            sb.Append("}");

            string json = sb.ToString();

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(SESSIONS_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 10000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=representation");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode >= 200 && statusCode < 300)
                    {
                        using (var reader = new StreamReader(response.GetResponseStream()))
                        {
                            string responseBody = reader.ReadToEnd();
                            return ParseId(responseBody);
                        }
                    }
                    else
                    {
                        Log(string.Format("DataExporter: Session POST status {0}", statusCode));
                        return -1;
                    }
                }
            }
            catch (WebException wex)
            {
                LogWebException("Session POST", wex);
                return -1;
            }
        }

        /// <summary>
        /// POSTs a chunk of bars as a JSON array to replay_bars.
        /// </summary>
        public static void PostBarChunk(long sessionId, Bars bars, int startIdx, int endIdx)
        {
            var sb = new StringBuilder();
            sb.Append("[");
            for (int i = startIdx; i < endIdx; i++)
            {
                if (i > startIdx) sb.Append(",");
                sb.Append("{");
                sb.AppendFormat("\"session_id\":{0},", sessionId);
                sb.AppendFormat("\"bar_index\":{0},", i);
                sb.AppendFormat("\"bar_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", bars.GetTime(i));
                sb.AppendFormat("\"bar_open\":{0},", bars.GetOpen(i).ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_high\":{0},", bars.GetHigh(i).ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_low\":{0},", bars.GetLow(i).ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_close\":{0},", bars.GetClose(i).ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_volume\":{0}", bars.GetVolume(i));
                sb.Append("}");
            }
            sb.Append("]");

            string json = sb.ToString();

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(BARS_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 30000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode < 200 || statusCode >= 300)
                    {
                        Log(string.Format("DataExporter: Bars POST status {0} for session {1} (chunk {2}-{3})",
                            statusCode, sessionId, startIdx, endIdx));
                    }
                }
            }
            catch (WebException wex)
            {
                LogWebException("Bars POST", wex);
                throw;
            }
        }

        /// <summary>
        /// GETs rows from a Supabase REST endpoint with query parameters.
        /// Returns the raw JSON response body, or null on failure.
        /// </summary>
        public static string SupabaseGet(string endpoint, string queryParams)
        {
            string url = endpoint + "?" + queryParams;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.ContentType = "application/json";
            request.Timeout = 10000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (WebException wex)
            {
                LogWebException("GET " + endpoint, wex);
                return null;
            }
        }

        /// <summary>
        /// PATCHes rows in Supabase using PostgREST query-string filtering.
        /// Returns true on success.
        /// </summary>
        public static bool SupabasePatch(string endpoint, string queryParams, string jsonBody)
        {
            string url = endpoint + "?" + queryParams;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "PATCH";
            request.ContentType = "application/json";
            request.Timeout = 10000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(jsonBody);
            request.ContentLength = bodyBytes.Length;

            using (Stream s = request.GetRequestStream())
                s.Write(bodyBytes, 0, bodyBytes.Length);

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    return (int)response.StatusCode >= 200 && (int)response.StatusCode < 300;
            }
            catch (WebException wex)
            {
                LogWebException("PATCH " + endpoint, wex);
                return false;
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // JSON PARSING (manual, no external libraries)
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>Parse the auto-generated ID from PostgREST's return=representation response.</summary>
        public static long ParseId(string responseBody)
        {
            try
            {
                int idKeyIndex = responseBody.IndexOf("\"id\":");
                if (idKeyIndex < 0) return -1;

                int valueStart = idKeyIndex + 5;
                while (valueStart < responseBody.Length && responseBody[valueStart] == ' ')
                    valueStart++;

                int valueEnd = valueStart;
                while (valueEnd < responseBody.Length && char.IsDigit(responseBody[valueEnd]))
                    valueEnd++;

                if (valueEnd == valueStart) return -1;
                return long.Parse(responseBody.Substring(valueStart, valueEnd - valueStart));
            }
            catch
            {
                Log("DataExporter: Failed to parse ID from response");
                return -1;
            }
        }

        /// <summary>Extract a string value from JSON: "fieldName":"value"</summary>
        public static string ParseStringField(string json, string fieldName)
        {
            string key = "\"" + fieldName + "\":\"";
            int idx = json.IndexOf(key);
            if (idx < 0) return null;
            int start = idx + key.Length;
            int end = json.IndexOf("\"", start);
            if (end < 0) return null;
            return json.Substring(start, end - start);
        }

        /// <summary>Extract a numeric value from JSON: "fieldName":42</summary>
        public static long ParseLongField(string json, string fieldName)
        {
            string key = "\"" + fieldName + "\":";
            int idx = json.IndexOf(key);
            if (idx < 0) return -1;
            int start = idx + key.Length;
            while (start < json.Length && json[start] == ' ') start++;
            int end = start;
            while (end < json.Length && char.IsDigit(json[end])) end++;
            if (end == start) return -1;
            return long.Parse(json.Substring(start, end - start));
        }

        // ═══════════════════════════════════════════════════════════════════════
        // HELPERS
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>Parse a display string like "5 Minute" into BarsPeriodType + Value.</summary>
        public static void ParseTimeframe(string tf, out BarsPeriodType periodType, out int value)
        {
            periodType = BarsPeriodType.Minute;
            value = 1;

            if (tf == "15 Second") { periodType = BarsPeriodType.Second; value = 15; }
            else if (tf == "1 Minute") { periodType = BarsPeriodType.Minute; value = 1; }
            else if (tf == "5 Minute") { periodType = BarsPeriodType.Minute; value = 5; }
            else if (tf == "15 Minute") { periodType = BarsPeriodType.Minute; value = 15; }
        }

        /// <summary>Minimal JSON string escaping (same as TradeZoneWriter).</summary>
        public static string EscapeJson(string input)
        {
            if (string.IsNullOrEmpty(input)) return "";
            return input
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
        }

        /// <summary>Log to NinjaTrader Output tab.</summary>
        public static void Log(string message)
        {
            NinjaTrader.Code.Output.Process(message, PrintTo.OutputTab1);
        }

        /// <summary>Log a WebException with response body details.</summary>
        public static void LogWebException(string context, WebException wex)
        {
            if (wex.Response is HttpWebResponse errResponse)
            {
                using (var reader = new StreamReader(errResponse.GetResponseStream()))
                {
                    string errorBody = reader.ReadToEnd();
                    Log(string.Format("DataExporter: {0} HTTP {1} — {2}",
                        context, (int)errResponse.StatusCode, errorBody));
                }
            }
            else
            {
                Log(string.Format("DataExporter: {0} error — {1}", context, wex.Message));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DataExporterWindow — Manual UI for exporting bars to Supabase.
    // Now calls static DataExportHelper methods for the actual upload logic.
    // ═══════════════════════════════════════════════════════════════════════════

    public class DataExporterWindow : NTWindow, IWorkspacePersistence
    {
        public WorkspaceOptions WorkspaceOptions { get; set; }

        // ─── UI Elements ───────────────────────────────────────────────────────
        private TextBox _instrumentInput;
        private ComboBox _timeframeCombo;
        private DatePicker _fromDate;
        private DatePicker _toDate;
        private Button _exportButton;
        private TextBlock _statusLabel;

        // ─── State ─────────────────────────────────────────────────────────────
        private BarsRequest _barsRequest;
        private bool _isExporting;
        private bool _isDisposed;

        public DataExporterWindow()
        {
            Caption = "Data Exporter";
            Width = 420;
            Height = 380;
            BuildUI();
        }

        // ─── UI Construction ───────────────────────────────────────────────────

        private void BuildUI()
        {
            var grid = new Grid { Margin = new Thickness(16) };

            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            for (int i = 0; i < 7; i++)
                grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            Brush fontBrush = Application.Current.TryFindResource("FontControlBrush") as Brush ?? Brushes.White;

            // Row 0: Title
            var title = new TextBlock
            {
                Text = "Export Bars to Supabase",
                FontSize = 16,
                FontWeight = FontWeights.Bold,
                Foreground = fontBrush,
                Margin = new Thickness(0, 0, 0, 16)
            };
            Grid.SetRow(title, 0);
            Grid.SetColumnSpan(title, 2);
            grid.Children.Add(title);

            // Row 1: Instrument
            AddLabel(grid, "Instrument:", 1, fontBrush);
            _instrumentInput = new TextBox { Text = "NQ 03-26", Margin = new Thickness(4, 4, 0, 4) };
            Grid.SetRow(_instrumentInput, 1);
            Grid.SetColumn(_instrumentInput, 1);
            grid.Children.Add(_instrumentInput);

            // Row 2: Timeframe
            AddLabel(grid, "Timeframe:", 2, fontBrush);
            _timeframeCombo = new ComboBox { Margin = new Thickness(4, 4, 0, 4) };
            _timeframeCombo.Items.Add("15 Second");
            _timeframeCombo.Items.Add("1 Minute");
            _timeframeCombo.Items.Add("5 Minute");
            _timeframeCombo.Items.Add("15 Minute");
            _timeframeCombo.SelectedIndex = 1;
            Grid.SetRow(_timeframeCombo, 2);
            Grid.SetColumn(_timeframeCombo, 1);
            grid.Children.Add(_timeframeCombo);

            // Row 3: From Date
            AddLabel(grid, "From:", 3, fontBrush);
            _fromDate = new DatePicker { SelectedDate = DateTime.Today.AddDays(-1), Margin = new Thickness(4, 4, 0, 4) };
            Grid.SetRow(_fromDate, 3);
            Grid.SetColumn(_fromDate, 1);
            grid.Children.Add(_fromDate);

            // Row 4: To Date
            AddLabel(grid, "To:", 4, fontBrush);
            _toDate = new DatePicker { SelectedDate = DateTime.Today, Margin = new Thickness(4, 4, 0, 4) };
            Grid.SetRow(_toDate, 4);
            Grid.SetColumn(_toDate, 1);
            grid.Children.Add(_toDate);

            // Row 5: Export Button
            _exportButton = new Button
            {
                Content = "Export",
                Height = 36,
                Margin = new Thickness(0, 16, 0, 8),
                FontWeight = FontWeights.Bold
            };
            _exportButton.Click += OnExportClick;
            Grid.SetRow(_exportButton, 5);
            Grid.SetColumnSpan(_exportButton, 2);
            grid.Children.Add(_exportButton);

            // Row 6: Status
            _statusLabel = new TextBlock
            {
                Text = "Ready — select parameters and click Export",
                Foreground = fontBrush,
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 0)
            };
            Grid.SetRow(_statusLabel, 6);
            Grid.SetColumnSpan(_statusLabel, 2);
            grid.Children.Add(_statusLabel);

            Content = grid;
        }

        private void AddLabel(Grid grid, string text, int row, Brush brush)
        {
            var label = new TextBlock
            {
                Text = text,
                Foreground = brush,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 4, 8, 4)
            };
            Grid.SetRow(label, row);
            Grid.SetColumn(label, 0);
            grid.Children.Add(label);
        }

        // ─── Manual Export (UI-driven) ─────────────────────────────────────────

        private void OnExportClick(object sender, RoutedEventArgs e)
        {
            if (_isExporting) return;

            string instrumentName = _instrumentInput.Text.Trim();
            if (string.IsNullOrEmpty(instrumentName))
            {
                SetStatus("Error: Enter an instrument name");
                return;
            }

            if (!_fromDate.SelectedDate.HasValue || !_toDate.SelectedDate.HasValue)
            {
                SetStatus("Error: Select both From and To dates");
                return;
            }

            DateTime from = _fromDate.SelectedDate.Value;
            DateTime to = _toDate.SelectedDate.Value.AddDays(1);
            if (from >= to)
            {
                SetStatus("Error: From date must be before To date");
                return;
            }

            string tfStr = _timeframeCombo.SelectedItem.ToString();
            BarsPeriodType periodType;
            int periodValue;
            DataExportHelper.ParseTimeframe(tfStr, out periodType, out periodValue);

            Instrument instrument = Instrument.GetInstrument(instrumentName, false);
            if (instrument == null)
            {
                SetStatus("Error: Instrument not found — " + instrumentName);
                return;
            }

            _isExporting = true;
            _exportButton.IsEnabled = false;
            SetStatus("Requesting bars from NinjaTrader...");

            _barsRequest = new BarsRequest(instrument, from, to);
            _barsRequest.BarsPeriod = new BarsPeriod { BarsPeriodType = periodType, Value = periodValue };

            string capturedInstrument = instrumentName;
            string capturedTimeframe = tfStr;

            _barsRequest.Request(new Action<BarsRequest, ErrorCode, string>((req, errorCode, errorMessage) =>
            {
                if (_isDisposed) return;

                if (errorCode != ErrorCode.NoError)
                {
                    Dispatcher.InvokeAsync(() =>
                    {
                        SetStatus(string.Format("BarsRequest error: {0} — {1}", errorCode, errorMessage));
                        _isExporting = false;
                        _exportButton.IsEnabled = true;
                    });
                    return;
                }

                int barCount = req.Bars.Count;
                if (barCount == 0)
                {
                    Dispatcher.InvokeAsync(() =>
                    {
                        SetStatus("No bars returned for the selected range");
                        _isExporting = false;
                        _exportButton.IsEnabled = true;
                    });
                    return;
                }

                Dispatcher.InvokeAsync(() =>
                    SetStatus(string.Format("Got {0} bars — uploading to Supabase...", barCount)));

                // Upload on background thread using static helper methods
                Task.Run(() =>
                {
                    try
                    {
                        DateTime firstBarTime = req.Bars.GetTime(0);
                        DateTime lastBarTime = req.Bars.GetTime(barCount - 1);
                        string sessionDate = firstBarTime.ToString("yyyy-MM-dd");

                        long sessionId = DataExportHelper.PostSession(capturedInstrument, capturedTimeframe,
                            sessionDate, firstBarTime, lastBarTime, barCount);

                        if (sessionId <= 0)
                        {
                            Dispatcher.InvokeAsync(() =>
                            {
                                SetStatus("Failed to create session (may already exist for this date)");
                                _isExporting = false;
                                _exportButton.IsEnabled = true;
                            });
                            return;
                        }

                        int chunkSize = 500;
                        int chunks = (barCount + chunkSize - 1) / chunkSize;
                        for (int chunk = 0; chunk < chunks; chunk++)
                        {
                            int start = chunk * chunkSize;
                            int end = Math.Min(start + chunkSize, barCount);
                            DataExportHelper.PostBarChunk(sessionId, req.Bars, start, end);

                            int uploaded = end;
                            Dispatcher.InvokeAsync(() =>
                                SetStatus(string.Format("Uploaded {0} / {1} bars...", uploaded, barCount)));
                        }

                        Dispatcher.InvokeAsync(() =>
                        {
                            SetStatus(string.Format("Done! Exported {0} bars ({1} {2} {3})",
                                barCount, capturedInstrument, capturedTimeframe, sessionDate));
                            _isExporting = false;
                            _exportButton.IsEnabled = true;
                        });
                    }
                    catch (Exception ex)
                    {
                        Dispatcher.InvokeAsync(() =>
                        {
                            SetStatus(string.Format("Upload error: {0}", ex.Message));
                            _isExporting = false;
                            _exportButton.IsEnabled = true;
                        });
                        DataExportHelper.Log("DataExporter UI: " + ex);
                    }
                });
            }));
        }

        private void SetStatus(string text)
        {
            if (_isDisposed) return;
            _statusLabel.Text = text;
        }

        // ─── Cleanup ───────────────────────────────────────────────────────────

        protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
        {
            _isDisposed = true;
            _barsRequest = null;
            base.OnClosing(e);
        }

        // ─── Workspace Persistence ─────────────────────────────────────────────

        public void Restore(XDocument document, XElement element) { }
        public void Save(XDocument document, XElement element) { }
    }
}
