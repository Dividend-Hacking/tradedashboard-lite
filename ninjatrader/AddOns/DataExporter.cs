#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
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
                    // Poll every 5s. The polling tick is cheap (single GET + group
                    // dispatch) and concurrent group processing is gated by a
                    // semaphore inside DataExportHelper, so faster polling just
                    // drains the queue more responsively without thrashing NT8.
                    if (_pollTimer == null)
                    {
                        _pollTimer = new Timer(
                            callback: _ => DataExportHelper.PollForDataRequests(),
                            state: null,
                            dueTime: TimeSpan.FromSeconds(10),
                            period: TimeSpan.FromSeconds(5));

                        DataExportHelper.Log("DataExporter: Polling for web data requests every 5s");
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
        // ─── Endpoint resolution ──────────────────────────────────────────────
        // These were hardcoded Supabase URLs; they now resolve through
        // ModeConfig so flipping Cloud/Local in the web UI re-points the
        // AddOn on the next 15s polling tick. SUPABASE_ANON_KEY still
        // returns the cloud anon key in both modes — local /api/nt8/*
        // routes accept (and ignore) the apikey/Authorization headers,
        // so the existing header-add lines below need no changes.
        private static string SUPABASE_URL => ModeConfig.Endpoint;
        private static string SUPABASE_ANON_KEY => ModeConfig.ApiKey;
        private static string SESSIONS_ENDPOINT => ModeConfig.TableUrl("replay_sessions");
        private static string BARS_ENDPOINT => ModeConfig.TableUrl("replay_bars");
        private static string DATA_REQUESTS_ENDPOINT => ModeConfig.TableUrl("data_requests");
        // Storage endpoint base. The bucket + path get appended at upload time
        // so we keep STORAGE_OBJECT_ENDPOINT as the bucket-less prefix in cloud
        // mode and let StorageObjectUrl emit the full URL in local mode.
        private static string STORAGE_OBJECT_ENDPOINT => ModeConfig.CurrentMode == ModeConfig.Mode.Local
            ? ModeConfig.Endpoint.TrimEnd('/') + "/api/nt8"
            : ModeConfig.Endpoint.TrimEnd('/') + "/storage/v1/object";
        private const string TICK_BUCKET = "replay-ticks";

        // ─── Polling State ─────────────────────────────────────────────────────
        // Concurrency model:
        //   • _instrumentSlots caps total concurrent group fetches at 3 — each
        //     slot represents one instrument's BarsRequest pipeline (Last + Bid +
        //     Ask streams). NT8 handles ~10 parallel BarsRequests cleanly; 3 is a
        //     deliberately conservative ceiling that leaves headroom for the UI.
        //   • _inFlightInstruments tracks which instruments currently have a
        //     dispatched group, so successive 5s poll ticks don't double-dispatch
        //     the same pending rows before they get marked "processing".
        // The previous global lock + single-flight bool is removed entirely.
        private static readonly SemaphoreSlim _instrumentSlots = new SemaphoreSlim(3, 3);
        private static readonly ConcurrentDictionary<string, byte> _inFlightInstruments
            = new ConcurrentDictionary<string, byte>();

        // ═══════════════════════════════════════════════════════════════════════
        // POLLING: Web-Initiated Data Requests
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// One pending data_requests row, parsed from a multi-row PostgREST GET.
        /// </summary>
        private class DataRequestRow
        {
            public long Id;
            public string Instrument;
            public string Timeframe;
            public string SessionDate;
            public string Granularity;
        }

        /// <summary>
        /// Timer callback — pulls up to 50 oldest pending rows in one GET, groups
        /// them by (instrument, timeframe, granularity), and dispatches each
        /// group to a background Task. Different instruments run in parallel up
        /// to _instrumentSlots; the same instrument is serialized via
        /// _inFlightInstruments so consecutive polls don't fight over its rows
        /// before they get marked processing.
        /// </summary>
        public static void PollForDataRequests()
        {
            string json;
            try
            {
                json = SupabaseGet(DATA_REQUESTS_ENDPOINT,
                    "status=eq.pending&order=instrument.asc,session_date.asc&limit=50" +
                    "&select=id,instrument,timeframe,session_date,granularity");
            }
            catch (Exception ex)
            {
                Log("DataExporter: Poll error — " + ex.Message);
                return;
            }

            if (string.IsNullOrEmpty(json) || json.Trim() == "[]") return;

            // Parse all rows (top-level objects in the JSON array).
            var rows = new List<DataRequestRow>();
            foreach (string rowJson in SplitJsonArray(json))
            {
                long id = ParseLongField(rowJson, "id");
                string instrument = ParseStringField(rowJson, "instrument");
                string timeframe = ParseStringField(rowJson, "timeframe");
                string sessionDate = ParseStringField(rowJson, "session_date");
                // Defensive default — pre-granularity rows fall back to ohlcv.
                string granularity = ParseStringField(rowJson, "granularity") ?? "ohlcv";
                if (id <= 0 || instrument == null || timeframe == null || sessionDate == null)
                    continue;
                rows.Add(new DataRequestRow
                {
                    Id = id, Instrument = instrument, Timeframe = timeframe,
                    SessionDate = sessionDate, Granularity = granularity,
                });
            }
            if (rows.Count == 0) return;

            // Group by (instrument, timeframe, granularity). Each group runs in
            // ONE BarsRequest pipeline; mixing timeframes/granularities would
            // require separate BarsRequest configs so we keep them separate.
            var groups = new Dictionary<string, List<DataRequestRow>>();
            foreach (var r in rows)
            {
                string gkey = r.Instrument + "|" + r.Timeframe + "|" + r.Granularity;
                List<DataRequestRow> bucket;
                if (!groups.TryGetValue(gkey, out bucket))
                {
                    bucket = new List<DataRequestRow>();
                    groups[gkey] = bucket;
                }
                bucket.Add(r);
            }

            // Dispatch each group on its own Task. We key the in-flight dedupe
            // by instrument NAME so two groups for the same instrument with
            // different timeframes still serialize on the data subscription.
            foreach (var kv in groups)
            {
                var group = kv.Value;
                string instrumentKey = group[0].Instrument;
                if (!_inFlightInstruments.TryAdd(instrumentKey, 0))
                {
                    // Already dispatched on a prior poll tick — skip until it finishes.
                    continue;
                }

                var capturedGroup = group;
                var capturedKey = instrumentKey;
                Task.Run(() =>
                {
                    bool slotAcquired = false;
                    try
                    {
                        _instrumentSlots.Wait();
                        slotAcquired = true;
                        ProcessDataRequestGroup(capturedGroup);
                    }
                    catch (Exception ex)
                    {
                        Log(string.Format("DataExporter: group dispatch error ({0}) — {1}",
                            capturedKey, ex.Message));
                    }
                    finally
                    {
                        if (slotAcquired) _instrumentSlots.Release();
                        byte _ignored;
                        _inFlightInstruments.TryRemove(capturedKey, out _ignored);
                        // Hint the GC after each group — multi-day tick batches
                        // can leave 1-3 GB of transient working set in dicts/lists.
                        GC.Collect();
                    }
                });
            }
        }

        /// <summary>
        /// Process all rows for one (instrument, timeframe, granularity) group.
        /// For tick paths, consecutive trading dates are coalesced into batched
        /// BarsRequests covering up to 5 days (tick) or 3 days (tick_bidask).
        /// For OHLCV paths, each row is processed individually — bar volume is
        /// small so per-day overhead is not the bottleneck there.
        /// </summary>
        private static void ProcessDataRequestGroup(List<DataRequestRow> group)
        {
            if (group.Count == 0) return;
            var first = group[0];
            string instrumentName = first.Instrument;
            string timeframe = first.Timeframe;
            string granularity = first.Granularity;

            // Resolve the instrument once for the whole group.
            Instrument instrument = Instrument.GetInstrument(instrumentName, false);
            if (instrument == null)
            {
                foreach (var r in group)
                    PatchRequestError(r.Id, "Instrument not found: " + instrumentName);
                return;
            }

            if (granularity == "tick" || granularity == "tick_bidask")
            {
                bool withBidAsk = granularity == "tick_bidask";
                // Memory budget: NT8's Bar struct is ~50-60 bytes, peak NQ day
                // can be ~8M ticks. 3 streams × 3 days ≈ 4-5 GB working set;
                // single stream × 5 days ≈ 2.5 GB. Stay under the ceiling.
                int batchCap = withBidAsk ? 3 : 5;
                List<List<DataRequestRow>> chunks = ChunkConsecutiveDates(group, batchCap);
                foreach (var chunk in chunks)
                {
                    if (!ClaimRows(chunk))
                    {
                        Log(string.Format("DataExporter: failed to claim {0} tick rows for {1} — skipping batch",
                            chunk.Count, instrumentName));
                        continue;
                    }
                    Log(string.Format("DataExporter[batch]: Claimed {0} rows for {1} ({2}..{3}) [{4}]",
                        chunk.Count, instrumentName, chunk[0].SessionDate,
                        chunk[chunk.Count - 1].SessionDate, granularity));
                    // Heartbeat covers the whole tick batch — multi-day pulls
                    // can run several minutes and we don't want the sweeper
                    // to confuse "still working" with "crashed".
                    var ids = new List<long>();
                    foreach (var r in chunk) ids.Add(r.Id);
                    var hb = StartHeartbeat(ids);
                    try
                    {
                        ProcessTickBatch(chunk, instrumentName, instrument, timeframe, withBidAsk);
                    }
                    finally
                    {
                        if (hb != null) hb.Dispose();
                    }
                }
                return;
            }

            // OHLCV / OHLCV+bidask: per-day. Reuse the existing single-row
            // dispatcher unchanged — claiming the row first, then keeping a
            // 60s heartbeat alive while it runs so the server-side sweeper
            // can distinguish a slow BarsRequest from a dead NT8 process.
            foreach (var r in group)
            {
                var single = new List<DataRequestRow> { r };
                if (!ClaimRows(single)) continue;
                Log(string.Format("DataExporter: Processing request #{0} — {1} {2} {3} [{4}]",
                    r.Id, r.Instrument, r.Timeframe, r.SessionDate, r.Granularity));
                var hb = StartHeartbeat(new[] { r.Id });
                try
                {
                    ProcessDataRequest(r.Id, r.Instrument, r.Timeframe, r.SessionDate, r.Granularity);
                }
                finally
                {
                    if (hb != null) hb.Dispose();
                }
            }
        }

        /// <summary>
        /// PATCH a set of pending rows to status="processing" in a single
        /// PostgREST round-trip using id=in.(...). Returns true on 2xx.
        ///
        /// Sets `claimed_at` alongside the status flip so the server's stuck-
        /// row sweeper can tell "this row was picked up <N> minutes ago" from
        /// just `updated_at` (which moves on every heartbeat). If NT8 dies
        /// mid-batch, claimed_at stays fixed at the start time and the
        /// sweeper resets the row to pending after the staleness window.
        /// </summary>
        private static bool ClaimRows(List<DataRequestRow> rows)
        {
            if (rows.Count == 0) return false;
            var sb = new StringBuilder();
            sb.Append("(");
            for (int i = 0; i < rows.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(rows[i].Id);
            }
            sb.Append(")");
            string nowIso = DateTime.UtcNow.ToString("o");
            return SupabasePatch(DATA_REQUESTS_ENDPOINT,
                "id=in." + sb.ToString(),
                "{\"status\":\"processing\",\"updated_at\":\"" + nowIso +
                    "\",\"claimed_at\":\"" + nowIso + "\"}");
        }

        /// <summary>
        /// Start a per-batch heartbeat that PATCHes `updated_at` for the
        /// claimed row(s) every 60s. While `claimed_at` stays pinned (so the
        /// sweeper's staleness clock is anchored at claim time), the
        /// heartbeat advances `updated_at` so the realtime UI subscription
        /// keeps the rows visible AND a future "live but slow" check has a
        /// signal to read. Returns an IDisposable; cancel it in a finally
        /// block so the timer dies even on exception paths.
        ///
        /// Empty input → no-op (returns null) so callers can unconditionally
        /// `using` the result without an extra null check on the create side.
        /// </summary>
        private static IDisposable StartHeartbeat(IEnumerable<long> requestIds)
        {
            var ids = new List<long>(requestIds);
            if (ids.Count == 0) return null;
            var sb = new StringBuilder();
            sb.Append("(");
            for (int i = 0; i < ids.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(ids[i]);
            }
            sb.Append(")");
            string filter = "id=in." + sb.ToString();

            // First tick at 60s — no point pinging immediately after ClaimRows
            // already set updated_at. Subsequent ticks every 60s thereafter.
            var timer = new Timer(_ =>
            {
                try
                {
                    SupabasePatch(DATA_REQUESTS_ENDPOINT, filter,
                        "{\"updated_at\":\"" +
                            DateTime.UtcNow.ToString("o") + "\"}");
                }
                catch (Exception ex)
                {
                    Log("DataExporter: heartbeat error — " + ex.Message);
                }
            }, null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));
            return timer;
        }

        /// <summary>
        /// Group date-sorted rows into runs of at most <paramref name="maxBatch"/>
        /// rows. Also splits a chunk if there's a gap of more than 7 calendar days
        /// between consecutive rows (avoids fetching 30 days of data when only
        /// the bookends are queued).
        /// </summary>
        private static List<List<DataRequestRow>> ChunkConsecutiveDates(
            List<DataRequestRow> rows, int maxBatch)
        {
            rows.Sort((a, b) =>
                string.Compare(a.SessionDate, b.SessionDate, StringComparison.Ordinal));
            var chunks = new List<List<DataRequestRow>>();
            if (rows.Count == 0) return chunks;
            var cur = new List<DataRequestRow> { rows[0] };
            DateTime prev = DateTime.ParseExact(rows[0].SessionDate, "yyyy-MM-dd",
                CultureInfo.InvariantCulture);
            for (int i = 1; i < rows.Count; i++)
            {
                DateTime d = DateTime.ParseExact(rows[i].SessionDate, "yyyy-MM-dd",
                    CultureInfo.InvariantCulture);
                bool tooBig = cur.Count >= maxBatch;
                bool tooFar = (d - prev).TotalDays > 7;
                if (tooBig || tooFar)
                {
                    chunks.Add(cur);
                    cur = new List<DataRequestRow>();
                }
                cur.Add(rows[i]);
                prev = d;
            }
            if (cur.Count > 0) chunks.Add(cur);
            return chunks;
        }

        /// <summary>
        /// Split a top-level JSON array into substrings, one per object. Returns
        /// each row as a self-contained `{...}` slice that the existing
        /// ParseStringField/ParseLongField helpers can consume directly.
        /// </summary>
        private static List<string> SplitJsonArray(string arrayJson)
        {
            var rows = new List<string>();
            if (string.IsNullOrEmpty(arrayJson)) return rows;
            int depth = 0;
            int rowStart = -1;
            bool inString = false;
            bool escape = false;
            for (int i = 0; i < arrayJson.Length; i++)
            {
                char c = arrayJson[i];
                if (escape) { escape = false; continue; }
                if (c == '\\' && inString) { escape = true; continue; }
                if (c == '"') { inString = !inString; continue; }
                if (inString) continue;
                if (c == '{')
                {
                    if (depth == 0) rowStart = i;
                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0 && rowStart >= 0)
                    {
                        rows.Add(arrayJson.Substring(rowStart, i - rowStart + 1));
                        rowStart = -1;
                    }
                }
            }
            return rows;
        }

        /// <summary>
        /// Per-day dispatcher for OHLCV granularities. Tick paths are handled
        /// upstream by ProcessTickBatch (which coalesces consecutive dates into
        /// a single multi-day BarsRequest), so this method only needs to route
        /// ohlcv and ohlcv_bidask.
        /// </summary>
        private static void ProcessDataRequest(long requestId, string instrumentName,
            string timeframe, string sessionDate, string granularity)
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

            // Time range covering the full session day (previous day 4pm to next day).
            // The wider-than-target window lets us catch ETH bars; we filter to the
            // target date afterward.
            DateTime requestFrom = targetDate.AddDays(-1).AddHours(16);
            DateTime requestTo = targetDate.AddDays(1);

            // Defensive: ohlcv_bidask is only meaningful at 1-second granularity. Bigger
            // bars would still merge but the bid/ask split loses delta resolution; we
            // gate at the form, but reject here too in case a manual insert slips through.
            if (granularity == "ohlcv_bidask" &&
                !(periodType == BarsPeriodType.Second && periodValue == 1))
            {
                PatchRequestError(requestId,
                    "ohlcv_bidask requires '1 Second' timeframe; got " + timeframe);
                return;
            }

            switch (granularity)
            {
                case "ohlcv":
                    ProcessOhlcvRequest(requestId, instrumentName, instrument, timeframe,
                        sessionDate, targetDate, requestFrom, requestTo, periodType, periodValue);
                    return;
                case "ohlcv_bidask":
                    ProcessOhlcvBidaskRequest(requestId, instrumentName, instrument, timeframe,
                        sessionDate, targetDate, requestFrom, requestTo);
                    return;
                default:
                    PatchRequestError(requestId, "Unknown granularity: " + granularity);
                    return;
            }
        }

        /// <summary>
        /// Original OHLCV path (no bid/ask split). Single Last BarsRequest, posts to
        /// replay_bars row-by-row. Renamed from the old monolithic ProcessDataRequest
        /// so the dispatcher stays tidy.
        ///
        /// Two-step approach to work around BarsRequest limitations from AddOn context:
        ///   Step 1: Small count-based request (10 bars) to "warm up" the data connection
        ///   Step 2: Time-range request for the actual target date (inside step 1's callback)
        ///
        /// The time-range constructor returns 0 bars when called cold from an AddOn,
        /// but may work after the data connection has been activated by a count-based request.
        /// </summary>
        private static void ProcessOhlcvRequest(long requestId, string instrumentName,
            Instrument instrument, string timeframe, string sessionDate, DateTime targetDate,
            DateTime requestFrom, DateTime requestTo, BarsPeriodType periodType, int periodValue)
        {

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
                                        // Warmup succeeded but the time-range request returned
                                        // 0 bars — broker confirmed no data for this date. Use
                                        // the no_data prefix so the dispatch point at the bottom
                                        // marks this row terminal-no_data instead of error.
                                        errorMsg = NO_DATA_PREFIX + "No bars for " + instrumentName +
                                            " " + timeframe + " " + sessionDate +
                                            " (broker has no data for this date)";
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

                                    // Mark request as completed. Null claimed_at so the row
                                    // is no longer in the in-flight set and the sweeper has
                                    // nothing to scan for it.
                                    SupabasePatch(DATA_REQUESTS_ENDPOINT,
                                        "id=eq." + requestId,
                                        string.Format("{{\"status\":\"completed\",\"replay_session_id\":{0},\"updated_at\":\"{1}\",\"claimed_at\":null}}",
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
                // Routes to either error or no_data based on the
                // NO_DATA_PREFIX sentinel; transient timeouts are real
                // errors and stay above this branch.
                PatchRequestTerminal(requestId, errorMsg);
        }

        // ═══════════════════════════════════════════════════════════════════════
        // OHLCV + BID/ASK SPLIT PATH
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// 1-second OHLCV with bid-volume / ask-volume split. Runs three parallel
        /// BarsRequests at the same time range:
        ///   - MarketDataType.Last → OHLC + total volume (the "spine" stream)
        ///   - MarketDataType.Bid  → sell-aggressor volume (trades that hit the bid)
        ///   - MarketDataType.Ask  → buy-aggressor volume  (trades that lifted the ask)
        ///
        /// Bid/Ask streams' OHLC are quote prices, not trade prices, so we ONLY
        /// consume their per-bar volume + timestamp. Each callback dumps its
        /// (truncated-second → volume) pairs into a Dictionary; once all three
        /// streams complete (CountdownEvent) we walk the Last stream and emit
        /// one row per bar, looking up bid/ask volumes by truncated-second key.
        ///
        /// Why CountdownEvent instead of nested callbacks: with three streams
        /// fanned out in parallel the callback-hell tree gets unreadable, and
        /// CountdownEvent gives us a clean "merge when all done" join point.
        /// </summary>
        private static void ProcessOhlcvBidaskRequest(long requestId, string instrumentName,
            Instrument instrument, string timeframe, string sessionDate, DateTime targetDate,
            DateTime requestFrom, DateTime requestTo)
        {
            var completionSignal = new ManualResetEventSlim(false);
            string errorMsg = null;
            var errLock = new object();

            // Per-second volume dictionaries populated by each callback. Keyed by
            // a DateTime truncated to whole seconds so Bid/Ask align with Last
            // even if NT8's internal millisecond bookkeeping drifts.
            var bidVolBySec = new Dictionary<DateTime, long>();
            var askVolBySec = new Dictionary<DateTime, long>();

            // The Last stream's per-bar data — OHLC + total volume + time.
            var lastTimes = new List<DateTime>();
            var lastOpens = new List<double>();
            var lastHighs = new List<double>();
            var lastLows = new List<double>();
            var lastCloses = new List<double>();
            var lastVolumes = new List<long>();

            void SetError(string msg)
            {
                lock (errLock)
                {
                    if (errorMsg == null) errorMsg = msg;
                }
            }

            // Each parallel stream signals when its callback writes are done.
            var streamsDone = new CountdownEvent(3);

            // Issue one BarsRequest with the given MarketDataType. The collector
            // delegate copies what we care about out of the result before we
            // signal — keeps the per-stream state localized.
            Action<MarketDataType, Action<BarsRequest>> issue = (mdt, collect) =>
            {
                Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
                {
                    try
                    {
                        var br = new BarsRequest(instrument, requestFrom, requestTo);
                        // MarketDataType lives on BarsPeriod, not BarsRequest. Setting it
                        // here filters the returned bars: Last = trade prints, Bid =
                        // sell-aggressor volume, Ask = buy-aggressor volume.
                        br.BarsPeriod = new BarsPeriod
                        {
                            BarsPeriodType = BarsPeriodType.Second,
                            Value = 1,
                            MarketDataType = mdt,
                        };
                        br.Request(new Action<BarsRequest, ErrorCode, string>((req, code, msg) =>
                        {
                            try
                            {
                                if (code != ErrorCode.NoError)
                                {
                                    SetError(string.Format("{0} stream error: {1} — {2}", mdt, code, msg));
                                    return;
                                }
                                collect(req);
                            }
                            catch (Exception ex)
                            {
                                SetError(string.Format("{0} collect error: {1}", mdt, ex.Message));
                            }
                            finally
                            {
                                streamsDone.Signal();
                            }
                        }));
                    }
                    catch (Exception ex)
                    {
                        SetError(string.Format("{0} dispatch error: {1}", mdt, ex.Message));
                        streamsDone.Signal();
                    }
                }));
            };

            // Warm up the data connection first (same trick as ohlcv path) — a
            // small count-based Last request at 1s before fanning out the three
            // streams. Without this, the first time-range request from a cold
            // AddOn often comes back empty.
            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    Log("DataExporter[bidask]: Warmup — count-based 1s Last request...");
                    var warmup = new BarsRequest(instrument, 10);
                    warmup.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Second, Value = 1 };
                    warmup.Request(new Action<BarsRequest, ErrorCode, string>((wreq, wcode, wmsg) =>
                    {
                        Log(string.Format("DataExporter[bidask]: Warmup → {0} bars (err {1})",
                            wcode == ErrorCode.NoError ? wreq.Bars.Count.ToString() : "N/A", wcode));

                        // Fan out three parallel target requests.
                        issue(MarketDataType.Last, req =>
                        {
                            int n = req.Bars.Count;
                            for (int i = 0; i < n; i++)
                            {
                                lastTimes.Add(req.Bars.GetTime(i));
                                lastOpens.Add(req.Bars.GetOpen(i));
                                lastHighs.Add(req.Bars.GetHigh(i));
                                lastLows.Add(req.Bars.GetLow(i));
                                lastCloses.Add(req.Bars.GetClose(i));
                                lastVolumes.Add(req.Bars.GetVolume(i));
                            }
                            Log(string.Format("DataExporter[bidask]: Last → {0} bars", n));
                        });
                        issue(MarketDataType.Bid, req =>
                        {
                            int n = req.Bars.Count;
                            for (int i = 0; i < n; i++)
                            {
                                long v = req.Bars.GetVolume(i);
                                if (v <= 0) continue; // skip pure quote updates with no trade volume
                                bidVolBySec[TruncSecond(req.Bars.GetTime(i))] = v;
                            }
                            Log(string.Format("DataExporter[bidask]: Bid → {0} non-empty seconds", bidVolBySec.Count));
                        });
                        issue(MarketDataType.Ask, req =>
                        {
                            int n = req.Bars.Count;
                            for (int i = 0; i < n; i++)
                            {
                                long v = req.Bars.GetVolume(i);
                                if (v <= 0) continue;
                                askVolBySec[TruncSecond(req.Bars.GetTime(i))] = v;
                            }
                            Log(string.Format("DataExporter[bidask]: Ask → {0} non-empty seconds", askVolBySec.Count));
                        });
                    }));
                }
                catch (Exception ex)
                {
                    SetError("Warmup error: " + ex.Message);
                    // Drain the countdown so we don't hang the wait below.
                    while (!streamsDone.IsSet) streamsDone.Signal();
                }
            }));

            // Wait for all 3 streams or up to 5 minutes total (warmup + 3 fetches).
            bool allDone = streamsDone.Wait(TimeSpan.FromMinutes(5));
            if (!allDone)
            {
                PatchRequestError(requestId, "ohlcv_bidask: timed out waiting for parallel streams");
                return;
            }
            if (errorMsg != null)
            {
                PatchRequestError(requestId, errorMsg);
                return;
            }

            // Merge: walk the Last stream, emit one row per bar with bid/ask vols
            // looked up by truncated-second key. Filter to the target date (the
            // request window is wider so we can capture session-boundary bars).
            int total = lastTimes.Count;
            if (total == 0)
            {
                // No data on Last stream — broker has nothing for this date.
                // Mark terminal-no_data so it's not retried and not re-queued
                // by future range requests.
                PatchRequestNoData(requestId, "ohlcv_bidask: Last stream returned 0 bars for " +
                    instrumentName + " " + sessionDate);
                return;
            }

            var mTimes = new List<DateTime>();
            var mOpens = new List<double>();
            var mHighs = new List<double>();
            var mLows  = new List<double>();
            var mCloses = new List<double>();
            var mVolumes = new List<long>();
            var mBidVols = new List<long>();
            var mAskVols = new List<long>();

            for (int i = 0; i < total; i++)
            {
                DateTime t = lastTimes[i];
                if (t.Date != targetDate) continue;
                DateTime key = TruncSecond(t);
                long bv; long av;
                bidVolBySec.TryGetValue(key, out bv);
                askVolBySec.TryGetValue(key, out av);
                mTimes.Add(t);
                mOpens.Add(lastOpens[i]);
                mHighs.Add(lastHighs[i]);
                mLows.Add(lastLows[i]);
                mCloses.Add(lastCloses[i]);
                mVolumes.Add(lastVolumes[i]);
                mBidVols.Add(bv);
                mAskVols.Add(av);
            }

            // If the date filter ate everything (session-boundary edge case),
            // fall back to the full Last stream — same fallback as ohlcv path.
            if (mTimes.Count == 0)
            {
                for (int i = 0; i < total; i++)
                {
                    DateTime key = TruncSecond(lastTimes[i]);
                    long bv; long av;
                    bidVolBySec.TryGetValue(key, out bv);
                    askVolBySec.TryGetValue(key, out av);
                    mTimes.Add(lastTimes[i]);
                    mOpens.Add(lastOpens[i]);
                    mHighs.Add(lastHighs[i]);
                    mLows.Add(lastLows[i]);
                    mCloses.Add(lastCloses[i]);
                    mVolumes.Add(lastVolumes[i]);
                    mBidVols.Add(bv);
                    mAskVols.Add(av);
                }
            }

            int rowCount = mTimes.Count;
            Log(string.Format("DataExporter[bidask]: merged {0} bars (bid keys: {1}, ask keys: {2})",
                rowCount, bidVolBySec.Count, askVolBySec.Count));

            // Phase 1: create the session row (with granularity tag).
            long sessionId = PostSession(instrumentName, timeframe, sessionDate,
                mTimes[0], mTimes[rowCount - 1], rowCount, "ohlcv_bidask");
            if (sessionId <= 0)
            {
                PatchRequestError(requestId, "ohlcv_bidask: failed to create replay_session");
                return;
            }

            // Phase 2: POST bars in chunks. Same chunk size (500) as ohlcv path.
            int chunkSize = 500;
            int chunks = (rowCount + chunkSize - 1) / chunkSize;
            for (int c = 0; c < chunks; c++)
            {
                int s = c * chunkSize;
                int e = Math.Min(s + chunkSize, rowCount);
                PostBidaskBarChunk(sessionId, mTimes, mOpens, mHighs, mLows, mCloses,
                    mVolumes, mBidVols, mAskVols, s, e);
            }

            // Mark request completed. Null claimed_at so the sweeper drops it
            // from the in-flight set immediately rather than waiting on the
            // staleness window.
            SupabasePatch(DATA_REQUESTS_ENDPOINT,
                "id=eq." + requestId,
                string.Format("{{\"status\":\"completed\",\"replay_session_id\":{0},\"updated_at\":\"{1}\",\"claimed_at\":null}}",
                    sessionId, DateTime.UtcNow.ToString("o")));

            Log(string.Format("DataExporter[bidask]: Request #{0} completed — session {1} ({2} bars)",
                requestId, sessionId, rowCount));
        }

        // ═══════════════════════════════════════════════════════════════════════
        // TICK PATH (with optional bid/ask side attribution)
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// Multi-day tick export — one warmup, one (or three, with bid/ask) parallel
        /// BarsRequest pipeline covering the full date range, then per-day
        /// CSV/gzip/upload/session/PATCH inside a single forward pass over the
        /// merged Last stream.
        ///
        /// Each "bar" in a Tick BarsRequest IS a single trade —
        /// GetTime/GetClose/GetVolume give us (time, price, size). For plain `tick`
        /// mode we dump the Last stream to a CSV with side=null. For
        /// `tick_bidask` we run three parallel streams (Last, Bid, Ask) and tag
        /// each Last tick with side=bid|ask|null based on a (time.Ticks, price)
        /// match against the Bid/Ask streams. Side-attribution dict keys are
        /// absolute (DateTime.Ticks XOR price-bits) so cross-day collisions are
        /// astronomically unlikely — one dict pair safely spans the whole batch.
        ///
        /// Output remains a gzipped CSV per session_date (no merged-multi-day
        /// blob) so the web/storage layer needs no changes.
        ///
        /// Caveat (unchanged): NT8's MarketDataType.Bid/Ask streams may return
        /// quote updates (size=0 events) rather than per-trade aggressor flags
        /// depending on the data feed. We filter size>0 before adding to the
        /// side-attribution dict, but if the feed is purely quote-based then
        /// most Last ticks fall through with side=null. That's a documented
        /// value, not a bug — downstream consumers should treat null as
        /// "unattributed".
        /// </summary>
        private static void ProcessTickBatch(List<DataRequestRow> rows,
            string instrumentName, Instrument instrument, string timeframe, bool withBidAskSide)
        {
            if (rows.Count == 0) return;

            // Sort rows by session_date and resolve the request window.
            rows.Sort((a, b) =>
                string.Compare(a.SessionDate, b.SessionDate, StringComparison.Ordinal));
            DateTime firstDate = DateTime.ParseExact(rows[0].SessionDate, "yyyy-MM-dd",
                CultureInfo.InvariantCulture);
            DateTime lastDate = DateTime.ParseExact(rows[rows.Count - 1].SessionDate,
                "yyyy-MM-dd", CultureInfo.InvariantCulture);

            // Tick retention safeguard. Kinetick's tick window is ~6 months; if
            // the batch's oldest date is older than 5 months we degrade to
            // per-day mode so a partial fetch only burns one row's worth of
            // re-tries instead of the whole chunk.
            if ((DateTime.UtcNow.Date - firstDate).TotalDays > 150)
            {
                Log(string.Format(
                    "DataExporter[batch]: range [{0}..{1}] is older than 5 months — falling back to per-day",
                    firstDate.ToString("yyyy-MM-dd"), lastDate.ToString("yyyy-MM-dd")));
                foreach (var r in rows)
                {
                    var single = new List<DataRequestRow> { r };
                    ProcessTickBatch(single, instrumentName, instrument, timeframe, withBidAskSide);
                }
                return;
            }

            DateTime requestFrom = firstDate.AddDays(-1).AddHours(16);
            DateTime requestTo = lastDate.AddDays(1);
            DateTime batchStart = DateTime.UtcNow;
            string errorMsg = null;
            var errLock = new object();

            // Last stream — every trade in the full window. Capacity is set
            // inside the collector once req.Bars.Count is known, avoiding the
            // List<>.Add reallocation churn at 8M+ ticks per stream.
            var trTimes = new List<DateTime>();
            var trPrices = new List<double>();
            var trSizes = new List<long>();

            // Side-attribution dicts (only populated when withBidAskSide=true).
            // Key = (time.Ticks XOR price-bits) packed; value = remaining
            // unmatched size. We decrement on match so two trades at the same
            // (time, price) get attributed to two different sides if possible.
            // One dict pair safely spans the whole multi-day batch — DateTime.Ticks
            // is absolute (100ns since year 1) so cross-day key collisions are
            // astronomically unlikely.
            var bidRemain = new Dictionary<long, long>();
            var askRemain = new Dictionary<long, long>();

            // Time-ordered bid/ask quote event timelines (also only populated
            // when withBidAskSide=true). NT8 delivers BarsRequest results in
            // chronological order, so these lists are naturally sorted by time
            // — no explicit sort needed. We snapshot from them later to record
            // the best_bid/best_ask that was current at each trade tick.
            var bidEvtTimes  = new List<DateTime>();
            var bidEvtPrices = new List<double>();
            var bidEvtSizes  = new List<long>();
            var askEvtTimes  = new List<DateTime>();
            var askEvtPrices = new List<double>();
            var askEvtSizes  = new List<long>();

            Action<string> setError = msg =>
            {
                lock (errLock)
                {
                    if (errorMsg == null) errorMsg = msg;
                }
            };

            int streamCount = withBidAskSide ? 3 : 1;
            var streamsDone = new CountdownEvent(streamCount);

            // Pack (DateTime ticks, price) into a single long. Plain XOR is
            // sufficient: a (t1,p1) collision with (t2,p2) requires t1^t2 == p1^p2,
            // which is astronomically unlikely for real trade timestamps + prices.
            Func<DateTime, double, long> packKey = (t, p) =>
            {
                long pbits = BitConverter.DoubleToInt64Bits(p);
                return t.Ticks ^ pbits;
            };

            Action<MarketDataType, Action<BarsRequest>> issueTick = (mdt, collect) =>
            {
                Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
                {
                    try
                    {
                        var br = new BarsRequest(instrument, requestFrom, requestTo);
                        br.BarsPeriod = new BarsPeriod
                        {
                            BarsPeriodType = BarsPeriodType.Tick,
                            Value = 1,
                            MarketDataType = mdt,
                        };
                        br.Request(new Action<BarsRequest, ErrorCode, string>((req, code, msg) =>
                        {
                            try
                            {
                                if (code != ErrorCode.NoError)
                                {
                                    setError(string.Format("{0} tick stream error: {1} — {2}", mdt, code, msg));
                                    return;
                                }
                                collect(req);
                            }
                            catch (Exception ex)
                            {
                                setError(string.Format("{0} tick collect error: {1}", mdt, ex.Message));
                            }
                            finally
                            {
                                // Dispose the BarsRequest as soon as we've copied
                                // its data out — multi-day tick streams can hold
                                // hundreds of MB in NT8's internal buffers and
                                // GC won't reclaim them until Dispose runs.
                                try { req.Dispose(); } catch { }
                                streamsDone.Signal();
                            }
                        }));
                    }
                    catch (Exception ex)
                    {
                        setError(string.Format("{0} tick dispatch error: {1}", mdt, ex.Message));
                        streamsDone.Signal();
                    }
                }));
            };

            // Adaptive warmup: a small count-based Tick request first, otherwise the
            // historical stream stays cold and the time-range request returns 0
            // ticks. 100 ticks is enough to activate without delay.
            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    Log(string.Format("DataExporter[batch]: Warmup — count-based 100-tick Last request ({0}..{1}, {2} day{3})",
                        firstDate.ToString("yyyy-MM-dd"), lastDate.ToString("yyyy-MM-dd"),
                        rows.Count, rows.Count == 1 ? "" : "s"));
                    var warmup = new BarsRequest(instrument, 100);
                    warmup.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
                    warmup.Request(new Action<BarsRequest, ErrorCode, string>((wreq, wcode, wmsg) =>
                    {
                        Log(string.Format("DataExporter[batch]: Warmup → {0} ticks (err {1})",
                            wcode == ErrorCode.NoError ? wreq.Bars.Count.ToString() : "N/A", wcode));
                        // Dispose the warmup buffer immediately — its only purpose
                        // was to prime NT8's data connection, the bars are unused.
                        try { wreq.Dispose(); } catch { }

                        issueTick(MarketDataType.Last, req =>
                        {
                            int n = req.Bars.Count;
                            // Pre-size to avoid 20+ List<> reallocations at 8M+ ticks.
                            if (trTimes.Capacity < n) trTimes.Capacity = n;
                            if (trPrices.Capacity < n) trPrices.Capacity = n;
                            if (trSizes.Capacity < n) trSizes.Capacity = n;
                            for (int i = 0; i < n; i++)
                            {
                                trTimes.Add(req.Bars.GetTime(i));
                                trPrices.Add(req.Bars.GetClose(i));
                                trSizes.Add(req.Bars.GetVolume(i));
                            }
                            Log(string.Format("DataExporter[batch]: Last → {0} ticks", n));
                        });

                        if (withBidAskSide)
                        {
                            issueTick(MarketDataType.Bid, req =>
                            {
                                int n = req.Bars.Count;
                                int kept = 0;
                                // Pre-size the event timeline lists; one append per
                                // sized event matches the dict's "kept" path 1:1.
                                if (bidEvtTimes.Capacity < bidEvtTimes.Count + n) bidEvtTimes.Capacity = bidEvtTimes.Count + n;
                                if (bidEvtPrices.Capacity < bidEvtPrices.Count + n) bidEvtPrices.Capacity = bidEvtPrices.Count + n;
                                if (bidEvtSizes.Capacity < bidEvtSizes.Count + n) bidEvtSizes.Capacity = bidEvtSizes.Count + n;
                                for (int i = 0; i < n; i++)
                                {
                                    long sz = req.Bars.GetVolume(i);
                                    if (sz <= 0) continue;
                                    DateTime et = req.Bars.GetTime(i);
                                    double ep = req.Bars.GetClose(i);
                                    // Side-attribution dict (unchanged behavior).
                                    long key = packKey(et, ep);
                                    long cur;
                                    bidRemain.TryGetValue(key, out cur);
                                    bidRemain[key] = cur + sz;
                                    // Time-ordered event timeline — used later to
                                    // snapshot the best bid current at each trade.
                                    bidEvtTimes.Add(et);
                                    bidEvtPrices.Add(ep);
                                    bidEvtSizes.Add(sz);
                                    kept++;
                                }
                                Log(string.Format("DataExporter[batch]: Bid → {0} sized events", kept));
                            });
                            issueTick(MarketDataType.Ask, req =>
                            {
                                int n = req.Bars.Count;
                                int kept = 0;
                                if (askEvtTimes.Capacity < askEvtTimes.Count + n) askEvtTimes.Capacity = askEvtTimes.Count + n;
                                if (askEvtPrices.Capacity < askEvtPrices.Count + n) askEvtPrices.Capacity = askEvtPrices.Count + n;
                                if (askEvtSizes.Capacity < askEvtSizes.Count + n) askEvtSizes.Capacity = askEvtSizes.Count + n;
                                for (int i = 0; i < n; i++)
                                {
                                    long sz = req.Bars.GetVolume(i);
                                    if (sz <= 0) continue;
                                    DateTime et = req.Bars.GetTime(i);
                                    double ep = req.Bars.GetClose(i);
                                    long key = packKey(et, ep);
                                    long cur;
                                    askRemain.TryGetValue(key, out cur);
                                    askRemain[key] = cur + sz;
                                    askEvtTimes.Add(et);
                                    askEvtPrices.Add(ep);
                                    askEvtSizes.Add(sz);
                                    kept++;
                                }
                                Log(string.Format("DataExporter[batch]: Ask → {0} sized events", kept));
                            });
                        }
                    }));
                }
                catch (Exception ex)
                {
                    setError("Tick warmup error: " + ex.Message);
                    while (!streamsDone.IsSet) streamsDone.Signal();
                }
            }));

            // Wait up to 30 minutes — multi-day tick streams over 3 days × 3 streams
            // can be huge and parallel-fan-in can delay completion. Per-day path
            // used 20 min; we scale up for the larger window.
            bool allDone = streamsDone.Wait(TimeSpan.FromMinutes(30));
            if (!allDone)
            {
                foreach (var r in rows)
                    PatchRequestError(r.Id, "tick batch: timed out waiting for streams");
                return;
            }
            if (errorMsg != null)
            {
                foreach (var r in rows)
                    PatchRequestError(r.Id, errorMsg);
                return;
            }

            int total = trTimes.Count;
            if (total == 0)
            {
                // Whole batch came back empty — broker has no tick data for
                // any of these dates (typically: outside the provider's tick
                // retention window). Mark each row terminal-no_data so the
                // sweeper doesn't retry and gap detection skips them.
                foreach (var r in rows)
                    PatchRequestNoData(r.Id,
                        "tick: 0 ticks returned for " + instrumentName + " " + r.SessionDate +
                        " — data may be outside provider's tick retention window (~6 months for Kinetick)");
                return;
            }

            // Bucket tick indices by trading date in a single pass over the Last
            // stream. The dict's keys are DateTime.Date, so day boundaries split
            // cleanly without needing a sort.
            var idxByDate = new Dictionary<DateTime, List<int>>();
            for (int i = 0; i < total; i++)
            {
                DateTime d = trTimes[i].Date;
                List<int> bucket;
                if (!idxByDate.TryGetValue(d, out bucket))
                {
                    bucket = new List<int>();
                    idxByDate[d] = bucket;
                }
                bucket.Add(i);
            }

            // Build CSV → upload → session → PATCH for each requested row.
            // Process in chronological order so side-attribution dict drains
            // monotonically (less random access overhead).
            int completedCount = 0;
            int totalUploadedTicks = 0;

            // Quote-snapshot cursors. Days are processed chronologically and
            // trades within a day are also chronological, so a single pair of
            // cursors advances monotonically across the entire batch. Reset
            // would only be needed if we processed days out of order.
            int biCur = 0, aiCur = 0;
            double curBid = double.NaN, curAsk = double.NaN;
            long   curBidSz = 0,        curAskSz = 0;

            foreach (var r in rows)
            {
                DateTime targetDate = DateTime.ParseExact(r.SessionDate, "yyyy-MM-dd",
                    CultureInfo.InvariantCulture);
                List<int> keepIdx;
                if (!idxByDate.TryGetValue(targetDate, out keepIdx) || keepIdx.Count == 0)
                {
                    // Other days in this batch had data but THIS day didn't —
                    // a single missing day inside an otherwise-good batch.
                    // Same semantics as a 0-bar OHLCV: mark terminal-no_data
                    // so we don't waste retries on a day the broker doesn't
                    // have.
                    PatchRequestNoData(r.Id,
                        "tick: 0 ticks for " + instrumentName + " " + r.SessionDate +
                        " inside batch window — data may be missing for this day");
                    continue;
                }
                int finalCount = keepIdx.Count;

                // Build the gzipped CSV for this day. For an 8M tick day the raw
                // CSV is ~250MB → ~30-50MB gzipped; only the gzipped form is
                // retained on the heap.
                byte[] gzippedCsv;
                int bidMatches = 0, askMatches = 0, unattributed = 0;
                using (var msOut = new MemoryStream())
                {
                    using (var gz = new GZipStream(msOut, CompressionLevel.Optimal, leaveOpen: true))
                    using (var sw = new StreamWriter(gz, new UTF8Encoding(false)))
                    {
                        sw.Write("tick_index,tick_time,price,size,side,best_bid,best_ask,best_bid_size,best_ask_size\n");
                        for (int j = 0; j < finalCount; j++)
                        {
                            int i = keepIdx[j];
                            DateTime t = trTimes[i];
                            double price = trPrices[i];
                            long size = trSizes[i];
                            string side = "";
                            if (withBidAskSide && size > 0)
                            {
                                long key = packKey(t, price);
                                long ar; long bv;
                                askRemain.TryGetValue(key, out ar);
                                bidRemain.TryGetValue(key, out bv);
                                if (ar >= size)
                                {
                                    side = "ask";
                                    askRemain[key] = ar - size;
                                    askMatches++;
                                }
                                else if (bv >= size)
                                {
                                    side = "bid";
                                    bidRemain[key] = bv - size;
                                    bidMatches++;
                                }
                                else
                                {
                                    unattributed++;
                                }
                            }
                            // Advance the quote cursors up to this trade time so
                            // curBid/curAsk reflect the most recent bid/ask quote
                            // event at or before t. Strictly <= so a bid event with
                            // an identical timestamp to the trade is "already in
                            // effect" by the moment that trade printed.
                            if (withBidAskSide)
                            {
                                while (biCur < bidEvtTimes.Count && bidEvtTimes[biCur] <= t)
                                {
                                    curBid   = bidEvtPrices[biCur];
                                    curBidSz = bidEvtSizes[biCur];
                                    biCur++;
                                }
                                while (aiCur < askEvtTimes.Count && askEvtTimes[aiCur] <= t)
                                {
                                    curAsk   = askEvtPrices[aiCur];
                                    curAskSz = askEvtSizes[aiCur];
                                    aiCur++;
                                }
                            }
                            sw.Write(j);
                            sw.Write(',');
                            sw.Write(t.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture));
                            sw.Write(',');
                            sw.Write(price.ToString("F4", CultureInfo.InvariantCulture));
                            sw.Write(',');
                            sw.Write(size);
                            sw.Write(',');
                            sw.Write(side);
                            sw.Write(',');
                            // Quote snapshot — empty (not zero/NaN) for early
                            // trades that arrive before any quote event. Empty
                            // strings parse to NaN/0 on the frontend.
                            if (!double.IsNaN(curBid))
                                sw.Write(curBid.ToString("F4", CultureInfo.InvariantCulture));
                            sw.Write(',');
                            if (!double.IsNaN(curAsk))
                                sw.Write(curAsk.ToString("F4", CultureInfo.InvariantCulture));
                            sw.Write(',');
                            if (curBidSz > 0) sw.Write(curBidSz);
                            sw.Write(',');
                            if (curAskSz > 0) sw.Write(curAskSz);
                            sw.Write('\n');
                        }
                    }
                    gzippedCsv = msOut.ToArray();
                }

                if (withBidAskSide)
                {
                    Log(string.Format(
                        "DataExporter[batch]: Day {0} — {1:N0} ticks, side ask={2} bid={3} unattributed={4}",
                        r.SessionDate, finalCount, askMatches, bidMatches, unattributed));
                }
                else
                {
                    Log(string.Format("DataExporter[batch]: Day {0} — {1:N0} ticks (no side)",
                        r.SessionDate, finalCount));
                }

                // Phase 1: create session row.
                long sessionId = PostSession(instrumentName, timeframe, r.SessionDate,
                    trTimes[keepIdx[0]], trTimes[keepIdx[finalCount - 1]],
                    0, // bar_count = 0 for tick sessions; tick_count is patched below
                    withBidAskSide ? "tick_bidask" : "tick");
                if (sessionId <= 0)
                {
                    PatchRequestError(r.Id, "tick: failed to create replay_session for " + r.SessionDate);
                    continue;
                }

                // Phase 2: upload blob to Storage.
                string blobPath = "session-" + sessionId + ".csv.gz";
                bool uploaded = UploadTickBlob(blobPath, gzippedCsv);
                if (!uploaded)
                {
                    PatchRequestError(r.Id, "tick: failed to upload blob to Storage for " + r.SessionDate);
                    continue;
                }

                // Phase 3: patch session with blob path + tick count.
                SupabasePatch(SESSIONS_ENDPOINT,
                    "id=eq." + sessionId,
                    string.Format("{{\"tick_blob_path\":\"{0}\",\"tick_count\":{1}}}",
                        EscapeJson(blobPath), finalCount));

                // Phase 4: mark this request completed. Null claimed_at so
                // the row exits the in-flight set immediately.
                SupabasePatch(DATA_REQUESTS_ENDPOINT,
                    "id=eq." + r.Id,
                    string.Format("{{\"status\":\"completed\",\"replay_session_id\":{0},\"updated_at\":\"{1}\",\"claimed_at\":null}}",
                        sessionId, DateTime.UtcNow.ToString("o")));

                Log(string.Format("DataExporter[batch]: Day {0} OK — session {1}, blob {2} ({3:N0} bytes)",
                    r.SessionDate, sessionId, blobPath, gzippedCsv.Length));

                completedCount++;
                totalUploadedTicks += finalCount;
            }

            double elapsed = (DateTime.UtcNow - batchStart).TotalSeconds;
            Log(string.Format(
                "DataExporter[batch]: Completed {0}/{1} rows for {2} in {3:F1}s ({4:N0} ticks total)",
                completedCount, rows.Count, instrumentName, elapsed, totalUploadedTicks));
        }

        /// <summary>Truncate a DateTime to second precision (drop ms/ticks below).</summary>
        private static DateTime TruncSecond(DateTime t)
        {
            return new DateTime(t.Year, t.Month, t.Day, t.Hour, t.Minute, t.Second, t.Kind);
        }

        /// <summary>
        /// Upload a gzipped CSV blob to Supabase Storage at
        /// `replay-ticks/{path}`. Uses a single multipart-free POST with the raw
        /// gzip bytes as the body (Supabase Storage accepts this when
        /// Content-Type matches the file). Returns true on 2xx.
        /// </summary>
        private static bool UploadTickBlob(string path, byte[] gzippedBody)
        {
            string url = STORAGE_OBJECT_ENDPOINT + "/" + TICK_BUCKET + "/" + path;
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/gzip";
            req.Timeout = 120000;
            req.ReadWriteTimeout = 120000;
            req.AllowWriteStreamBuffering = false;
            req.Headers.Add("apikey", SUPABASE_ANON_KEY);
            req.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            // x-upsert lets a retry overwrite a prior partial upload at the same path.
            req.Headers.Add("x-upsert", "true");
            req.ContentLength = gzippedBody.Length;

            try
            {
                using (Stream s = req.GetRequestStream())
                    s.Write(gzippedBody, 0, gzippedBody.Length);

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    int status = (int)resp.StatusCode;
                    if (status >= 200 && status < 300)
                    {
                        Log(string.Format("DataExporter[tick]: Storage upload OK ({0} bytes → {1})",
                            gzippedBody.Length, path));
                        return true;
                    }
                    Log(string.Format("DataExporter[tick]: Storage upload status {0}", status));
                    return false;
                }
            }
            catch (WebException wex)
            {
                LogWebException("Storage upload " + path, wex);
                return false;
            }
        }

        /// <summary>
        /// POSTs a chunk of OHLCV-bidask bars (one row per second) to replay_bars.
        /// Identical wire format to PostFilteredBarChunk but adds bar_volume_bid /
        /// bar_volume_ask fields. Kept as a separate helper rather than overloading
        /// the existing one because the JSON is hot-path code and a branch per row
        /// would add measurable overhead at 23k+ rows per session.
        /// </summary>
        private static void PostBidaskBarChunk(long sessionId,
            List<DateTime> times, List<double> opens, List<double> highs,
            List<double> lows, List<double> closes, List<long> volumes,
            List<long> bidVols, List<long> askVols, int startIdx, int endIdx)
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
                sb.AppendFormat("\"bar_volume\":{0},", volumes[i]);
                sb.AppendFormat("\"bar_volume_bid\":{0},", bidVols[i]);
                sb.AppendFormat("\"bar_volume_ask\":{0}", askVols[i]);
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

            using (Stream s = request.GetRequestStream())
                s.Write(bodyBytes, 0, bodyBytes.Length);

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode < 200 || statusCode >= 300)
                    {
                        Log(string.Format("DataExporter[bidask]: Bars POST status {0} for session {1}",
                            statusCode, sessionId));
                    }
                }
            }
            catch (WebException wex)
            {
                LogWebException("Bidask Bars POST", wex);
                throw;
            }
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

        /// <summary>
        /// Sentinel prefix for error messages that should be routed to the
        /// `no_data` terminal status instead of `error`. Used when the
        /// broker has confirmed no bars exist for a date (off-calendar
        /// holiday, pre-contract date, etc.) — auto-retry would never
        /// succeed, so we mark the row terminal and skip it on future
        /// range requests.
        /// </summary>
        private const string NO_DATA_PREFIX = "[no-data] ";

        /// <summary>
        /// Route an error message to either `error` or `no_data` depending
        /// on the NO_DATA_PREFIX sentinel. Call sites set the prefix when
        /// they detect "broker has no bars" rather than a transient failure
        /// (e.g. 0 bars after warmup), and a single dispatch point picks
        /// the right terminal status.
        /// </summary>
        private static void PatchRequestTerminal(long requestId, string msg)
        {
            if (msg != null && msg.StartsWith(NO_DATA_PREFIX))
            {
                PatchRequestNoData(requestId, msg.Substring(NO_DATA_PREFIX.Length));
                return;
            }
            PatchRequestError(requestId, msg);
        }

        /// <summary>
        /// Mark a data request as error with an error message.
        ///
        /// Nulls `claimed_at` alongside the error transition so the row
        /// exits the "in flight" set immediately. Without this, an errored
        /// row would still look like it had been claimed within the last
        /// 10 minutes and the sweeper would treat it as live until the
        /// staleness window expired.
        /// </summary>
        private static void PatchRequestError(long requestId, string error)
        {
            SupabasePatch(DATA_REQUESTS_ENDPOINT,
                "id=eq." + requestId,
                string.Format("{{\"status\":\"error\",\"error_message\":\"{0}\",\"updated_at\":\"{1}\",\"claimed_at\":null}}",
                    EscapeJson(error), DateTime.UtcNow.ToString("o")));
            Log("DataExporter: Request #" + requestId + " failed — " + error);
        }

        /// <summary>
        /// Mark a data request as `no_data` — broker confirmed no bars
        /// exist for this date. Terminal status, ignored by the sweeper,
        /// added to `taken` set in gap detection so re-requesting a range
        /// won't reattempt these dates. User can clear via the banner if
        /// they want to retry (e.g. after switching data providers).
        /// </summary>
        private static void PatchRequestNoData(long requestId, string detail)
        {
            SupabasePatch(DATA_REQUESTS_ENDPOINT,
                "id=eq." + requestId,
                string.Format("{{\"status\":\"no_data\",\"error_message\":\"{0}\",\"updated_at\":\"{1}\",\"claimed_at\":null}}",
                    EscapeJson(detail), DateTime.UtcNow.ToString("o")));
            Log("DataExporter: Request #" + requestId + " marked no_data — " + detail);
        }

        // ═══════════════════════════════════════════════════════════════════════
        // SUPABASE HTTP: POST, GET, PATCH
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// POSTs session metadata to replay_sessions with Prefer: return=representation.
        /// Returns the auto-generated session ID, or -1 on failure.
        ///
        /// `granularity` defaults to "ohlcv" so the manual DataExporterWindow UI
        /// (which doesn't expose granularity yet) keeps working unchanged.
        /// </summary>
        public static long PostSession(string instrument, string timeframe,
            string sessionDate, DateTime startTime, DateTime endTime, int barCount,
            string granularity = "ohlcv")
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"instrument\":\"{0}\",", EscapeJson(instrument));
            sb.AppendFormat("\"timeframe\":\"{0}\",", EscapeJson(timeframe));
            sb.AppendFormat("\"session_date\":\"{0}\",", sessionDate);
            sb.AppendFormat("\"start_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", startTime);
            sb.AppendFormat("\"end_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", endTime);
            sb.AppendFormat("\"bar_count\":{0},", barCount);
            sb.AppendFormat("\"granularity\":\"{0}\"", EscapeJson(granularity));
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

            if (tf == "1 Second") { periodType = BarsPeriodType.Second; value = 1; }
            else if (tf == "15 Second") { periodType = BarsPeriodType.Second; value = 15; }
            else if (tf == "1 Minute") { periodType = BarsPeriodType.Minute; value = 1; }
            else if (tf == "5 Minute") { periodType = BarsPeriodType.Minute; value = 5; }
            else if (tf == "15 Minute") { periodType = BarsPeriodType.Minute; value = 15; }
            else if (tf == "Tick") { periodType = BarsPeriodType.Tick; value = 1; }
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
