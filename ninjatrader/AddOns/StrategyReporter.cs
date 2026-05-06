#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// StrategyReporter — pushes per-instance status, position, daily stats,
    /// and log/error events from a running NinjaTrader strategy up to Supabase.
    ///
    /// One instance per live PresetStrategy (or any strategy that opts in).
    /// The reporter holds an in-memory snapshot of the strategy's current state
    /// (position, daily P&L, in-window flag, error counts, etc.) and ships it
    /// to two tables:
    ///   - live_strategies  (UPSERT-on-instance_id) — current snapshot row
    ///   - strategy_logs    (INSERT-only)          — append-only event stream
    ///
    /// Design mirrors SupabaseWriter:
    ///   - .NET Framework 4.8 / NT8-compatible (HttpWebRequest, no HttpClient).
    ///   - Manual JSON building via StringBuilder (no JSON serializer on path).
    ///   - All HTTP runs on the ThreadPool — strategy thread is never blocked.
    ///   - Errors are caught and logged to NT's Output tab, never thrown.
    ///
    /// Heartbeats: a System.Threading.Timer fires every HEARTBEAT_SECONDS and
    /// upserts the latest snapshot. Strategy code can also call PushNow() to
    /// flush immediately after a state-changing event (entry, exit, error).
    /// All snapshot reads/writes go through a single lock so the timer can run
    /// on a ThreadPool thread without racing with the strategy thread.
    /// </summary>
    public class StrategyReporter
    {
        // ─── Supabase connection ──────────────────────────────────────────────
        // URL + key loaded from livebridge.config.json at runtime — see LiveBridgeConfig.cs.
        private static string SUPABASE_URL { get { return LiveBridgeConfig.Url; } }
        private static string SUPABASE_ANON_KEY { get { return LiveBridgeConfig.AnonKey; } }

        private static string LIVE_STRATEGIES_ENDPOINT { get { return SUPABASE_URL + "/rest/v1/live_strategies"; } }
        private static string STRATEGY_LOGS_ENDPOINT   { get { return SUPABASE_URL + "/rest/v1/strategy_logs"; } }

        // ─── Heartbeat cadence ────────────────────────────────────────────────
        // 20s is a balance: dashboard sees timely status without us hammering
        // PostgREST. Stale-detection threshold should be ≥ 2× this (~45s).
        private const int HEARTBEAT_SECONDS = 20;

        // ─── Identity (immutable after Start) ─────────────────────────────────
        // instance_id is the PRIMARY KEY of live_strategies — unique per running
        // strategy session. Generated once at Start; remains stable until the
        // strategy is terminated.
        private string _instanceId;
        private string _strategyName;
        private string _presetName;
        private string _presetPath;
        private string _instrument;
        private string _accountName;
        private string _chartTimeframe;
        private string _hostMachine;
        private string _ntVersion;
        private DateTime _startedAtUtc;

        // ─── Mutable snapshot (guarded by _lock) ──────────────────────────────
        // Updated by strategy thread, read by heartbeat thread. The lock keeps
        // the read consistent so we never ship a half-updated row.
        private readonly object _lock = new object();
        private string _ntState = "Unknown";
        private bool _enabled = false;
        private bool? _inWindow = null;
        private bool _hasOpenPosition = false;
        private string _positionDirection = null;
        private int _positionQuantity = 0;
        private double? _positionEntryPrice = null;
        private double? _positionStopPrice = null;
        private double? _positionTakeProfitPrice = null;
        private double _unrealizedPnl = 0;

        // Daily counters — reset on day rollover (RollDayIfNeeded).
        private string _currentDayKey = "";
        private double _realizedPnlToday = 0;
        private int _tradesToday = 0;
        private int _winsToday = 0;
        private int _lossesToday = 0;

        // Lifetime counters — never reset.
        private int _totalTrades = 0;
        private double _totalPnl = 0;
        private DateTime? _lastTradeAt = null;

        // Error/warning summary — most recent error surfaces on the snapshot row;
        // full history lives in strategy_logs.
        private string _lastError = null;
        private DateTime? _lastErrorAt = null;
        private int _errorCount = 0;
        private int _warningCount = 0;

        // ─── Heartbeat timer ──────────────────────────────────────────────────
        private Timer _heartbeatTimer;
        private bool _started = false;
        private bool _stopped = false;

        // ─── Public API: lifecycle ────────────────────────────────────────────

        /// <summary>
        /// Begin reporting for this strategy instance. Generates an instance_id,
        /// captures immutable identity fields, kicks an initial upsert, and
        /// starts the periodic heartbeat timer.
        /// Must be called once during strategy init (e.g. State.DataLoaded).
        /// Subsequent calls are no-ops.
        /// </summary>
        public void Start(
            string strategyName,
            string presetName,
            string presetPath,
            string instrument,
            string accountName,
            string chartTimeframe,
            string ntVersion)
        {
            if (_started) return;
            _started = true;

            // Deterministic instance_id keyed on (strategy_name, account,
            // instrument, timeframe) — re-enabling the same strategy on the
            // same chart resolves to the same id, so the upsert merges onto
            // the existing live_strategies row instead of creating a new one.
            //
            // Different chart timeframes are intentionally treated as
            // separate instances: the same preset on a 1-min vs 5-min chart
            // is functionally a different deployment (different bar cadence,
            // different trades).
            //
            // The "det:" prefix distinguishes new deterministic IDs from
            // legacy random GUIDs (32 hex chars) so cleanup queries can
            // target either set unambiguously.
            _instanceId = "det:" + ComputeDeterministicId(strategyName, accountName, instrument, chartTimeframe);
            _strategyName = strategyName ?? "Unknown";
            _presetName = presetName ?? "";
            _presetPath = presetPath ?? "";
            _instrument = instrument ?? "";
            _accountName = accountName ?? "";
            _chartTimeframe = chartTimeframe ?? "";
            _ntVersion = ntVersion ?? "";
            _hostMachine = SafeMachineName();
            _startedAtUtc = DateTime.UtcNow;
            _enabled = true;
            _ntState = "Initializing";

            NinjaTrader.Code.Output.Process(
                string.Format("StrategyReporter: Started — {0} on {1} ({2}) instance_id={3}",
                    _strategyName, _instrument, _accountName, _instanceId),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            // Kick an initial upsert so the row exists in Supabase before the
            // first heartbeat fires. Failures are logged but never thrown.
            PushNow();

            // Periodic heartbeat — uses ThreadPool, can fire while strategy is
            // mid-bar. Snapshot lock guards data races.
            _heartbeatTimer = new Timer(_ => SafeHeartbeat(),
                                        null,
                                        TimeSpan.FromSeconds(HEARTBEAT_SECONDS),
                                        TimeSpan.FromSeconds(HEARTBEAT_SECONDS));
        }

        /// <summary>
        /// Mark the instance as terminated and flush a final snapshot.
        /// Stops the heartbeat timer. Safe to call multiple times.
        /// </summary>
        public void Stop(string reason)
        {
            if (!_started || _stopped) return;
            _stopped = true;

            try
            {
                if (_heartbeatTimer != null)
                {
                    _heartbeatTimer.Dispose();
                    _heartbeatTimer = null;
                }
            }
            catch { /* ignore */ }

            lock (_lock)
            {
                _ntState = "Terminated";
                _enabled = false;
                _hasOpenPosition = false;
                _positionDirection = null;
                _positionQuantity = 0;
                _positionEntryPrice = null;
                _positionStopPrice = null;
                _positionTakeProfitPrice = null;
                _unrealizedPnl = 0;
            }

            // Final upsert — best-effort, don't block strategy termination.
            try { PushNow(); } catch { /* ignore */ }

            // Log the termination reason for the dashboard's audit feed.
            try { Log("info", "lifecycle", "Strategy terminated: " + (reason ?? ""), null); }
            catch { /* ignore */ }
        }

        // ─── Public API: state mutators ───────────────────────────────────────

        /// <summary>
        /// Set the strategy's NT8 lifecycle state (Realtime, Historical, etc.).
        /// Cheap to call repeatedly — only kicks a network push if the value
        /// actually changed, to avoid flooding Supabase on every bar.
        /// </summary>
        public void SetNtState(string ntState)
        {
            if (!_started) return;
            bool changed;
            lock (_lock)
            {
                changed = !string.Equals(_ntState, ntState, StringComparison.Ordinal);
                _ntState = ntState ?? "Unknown";
                _enabled = !_stopped && _ntState != "Terminated" && _ntState != "Finalized";
            }
            if (changed) PushNow();
        }

        /// <summary>
        /// Update the in-window flag. The strategy evaluates the preset's time
        /// filter on each bar and forwards the boolean result here. Null means
        /// "no time filter configured" (treat as always-in-window).
        /// </summary>
        public void SetInWindow(bool? inWindow)
        {
            if (!_started) return;
            lock (_lock)
            {
                _inWindow = inWindow;
            }
        }

        /// <summary>
        /// Update open-position fields. Pass quantity=0 to clear (flat).
        /// Strategy calls this from OnExecutionUpdate / OnBarUpdate so the
        /// dashboard always sees the live position size + bracket prices.
        /// </summary>
        public void SetPosition(
            string direction,
            int quantity,
            double? entryPrice,
            double? stopPrice,
            double? takeProfitPrice,
            double unrealizedPnl)
        {
            if (!_started) return;
            lock (_lock)
            {
                _hasOpenPosition = quantity != 0;
                _positionDirection = _hasOpenPosition ? direction : null;
                _positionQuantity = _hasOpenPosition ? quantity : 0;
                _positionEntryPrice = _hasOpenPosition ? entryPrice : null;
                _positionStopPrice = _hasOpenPosition ? stopPrice : null;
                _positionTakeProfitPrice = _hasOpenPosition ? takeProfitPrice : null;
                _unrealizedPnl = _hasOpenPosition ? unrealizedPnl : 0;
            }
        }

        /// <summary>
        /// Record a closed trade — increments lifetime + daily counters and
        /// updates realized P&L. Pass `pnlDollars` so the dashboard sees account
        /// currency directly (rather than us re-deriving from points).
        /// `barTime` is used for day-rollover bookkeeping; pass the strategy's
        /// session-local time so the rollover lines up with NT's session.
        /// </summary>
        public void RecordTradeClosed(double pnlDollars, DateTime barTime)
        {
            if (!_started) return;
            lock (_lock)
            {
                RollDayIfNeededLocked(barTime);
                _tradesToday += 1;
                _totalTrades += 1;
                _realizedPnlToday += pnlDollars;
                _totalPnl += pnlDollars;
                if (pnlDollars > 0) _winsToday += 1;
                else if (pnlDollars < 0) _lossesToday += 1;
                _lastTradeAt = DateTime.UtcNow;
            }
            // Trade-close is a notable state change — flush the heartbeat now
            // so the dashboard's stats refresh without waiting up to 20s.
            PushNow();
        }

        /// <summary>
        /// Append an event to strategy_logs. Fire-and-forget — never blocks.
        /// `level` should be one of "debug" / "info" / "warn" / "error".
        /// `meta` is serialized as JSONB (numbers, strings, bools, nulls only).
        /// Errors and warnings also bump the snapshot's error_count / last_error
        /// so the dashboard can surface them without scanning the logs table.
        /// </summary>
        public void Log(string level, string category, string message, Dictionary<string, object> meta)
        {
            if (!_started) return;
            string lvl = (level ?? "info").ToLowerInvariant();
            string cat = category ?? "";
            string msg = message ?? "";

            // Update snapshot error/warning summary so the dashboard has a fast
            // "is anything wrong?" indicator without joining the logs table.
            if (lvl == "error")
            {
                lock (_lock)
                {
                    _errorCount += 1;
                    _lastError = TrimToLength(msg, 1000);
                    _lastErrorAt = DateTime.UtcNow;
                }
            }
            else if (lvl == "warn" || lvl == "warning")
            {
                lock (_lock)
                {
                    _warningCount += 1;
                }
            }

            string instanceId = _instanceId;
            string strategyName = _strategyName;
            string accountName = _accountName;
            string instrument = _instrument;

            Task.Run(() =>
            {
                try { PostLog(instanceId, strategyName, accountName, instrument, lvl, cat, msg, meta); }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("StrategyReporter: Log POST failed — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });

            // Errors warrant an immediate heartbeat upsert so error_count/last_error
            // hit Supabase without waiting for the timer.
            if (lvl == "error") PushNow();
        }

        /// <summary>
        /// Convenience getter — lets PresetStrategy embed instance_id on
        /// future trades / bars / etc. Empty string until Start() runs.
        /// </summary>
        public string InstanceId
        {
            get { return _instanceId ?? ""; }
        }

        /// <summary>
        /// Today's realized P&amp;L (account currency). Read-locked so callers
        /// see a consistent value mid-update. Used by PresetStrategy to fire
        /// a daily-loss warning once the loss crosses a configured threshold.
        /// </summary>
        public double RealizedPnlToday
        {
            get { lock (_lock) { return _realizedPnlToday; } }
        }

        // ─── Heartbeat scheduling ─────────────────────────────────────────────

        /// <summary>
        /// Force an immediate snapshot upsert. Always non-blocking — the actual
        /// HTTP call runs on the ThreadPool. Strategy code can call this after
        /// any meaningful state change to avoid waiting for the next periodic
        /// tick. The periodic timer also calls into PushNow().
        /// </summary>
        public void PushNow()
        {
            if (!_started) return;
            Task.Run(() =>
            {
                try { PostSnapshot(); }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("StrategyReporter: snapshot upsert failed — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// Timer callback wrapper — the BCL Timer crashes on unhandled exceptions
        /// from a background thread, which would take down NT. Catch everything.
        /// </summary>
        private void SafeHeartbeat()
        {
            if (_stopped) return;
            try { PostSnapshot(); }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("StrategyReporter: heartbeat failed — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── HTTP: snapshot upsert ────────────────────────────────────────────

        /// <summary>
        /// POSTs the current snapshot with PostgREST upsert semantics
        /// (`Prefer: resolution=merge-duplicates`, `on_conflict=instance_id`).
        /// PostgREST will INSERT a new row on first call and UPDATE existing
        /// rows on subsequent calls — same instance_id, same primary key.
        /// </summary>
        private void PostSnapshot()
        {
            if (string.IsNullOrEmpty(_instanceId)) return;

            string json;
            lock (_lock)
            {
                json = BuildSnapshotJson();
            }

            string url = LIVE_STRATEGIES_ENDPOINT + "?on_conflict=instance_id";

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 10000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            // resolution=merge-duplicates turns a POST into an UPSERT for rows
            // matching on_conflict=instance_id. return=minimal saves bandwidth.
            request.Headers.Add("Prefer", "resolution=merge-duplicates,return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;
            using (Stream s = request.GetRequestStream())
            {
                s.Write(bodyBytes, 0, bodyBytes.Length);
            }

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int status = (int)response.StatusCode;
                    if (status < 200 || status >= 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("StrategyReporter: snapshot upsert unexpected status {0}", status),
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
                        string body = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("StrategyReporter: snapshot upsert HTTP {0} — {1}",
                                (int)errResponse.StatusCode, body),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw;
            }
        }

        /// <summary>
        /// Builds the JSON body for the live_strategies upsert. Caller MUST
        /// hold _lock — we read mutable snapshot fields directly.
        /// All numeric values use invariant culture so locale-comma machines
        /// don't ship "12,34" to Postgres.
        /// </summary>
        private string BuildSnapshotJson()
        {
            var sb = new StringBuilder();
            sb.Append("{");

            sb.AppendFormat("\"instance_id\":\"{0}\",", EscapeJson(_instanceId));
            sb.AppendFormat("\"strategy_name\":\"{0}\",", EscapeJson(_strategyName));
            AppendStringField(sb, "preset_name", _presetName);
            AppendStringField(sb, "preset_path", _presetPath);
            AppendStringField(sb, "instrument", _instrument);
            AppendStringField(sb, "account_name", _accountName);
            AppendStringField(sb, "chart_timeframe", _chartTimeframe);
            sb.AppendFormat("\"nt_state\":\"{0}\",", EscapeJson(_ntState));
            sb.AppendFormat("\"enabled\":{0},", _enabled ? "true" : "false");

            // in_window is nullable — Postgres NULL when no time filter is configured.
            if (_inWindow.HasValue)
                sb.AppendFormat("\"in_window\":{0},", _inWindow.Value ? "true" : "false");
            else
                sb.Append("\"in_window\":null,");

            sb.AppendFormat("\"has_open_position\":{0},", _hasOpenPosition ? "true" : "false");
            AppendNullableStringField(sb, "position_direction", _positionDirection);
            sb.AppendFormat("\"position_quantity\":{0},", _positionQuantity);
            AppendNullableNumberField(sb, "position_entry_price", _positionEntryPrice, "F4");
            AppendNullableNumberField(sb, "position_stop_price", _positionStopPrice, "F4");
            AppendNullableNumberField(sb, "position_take_profit_price", _positionTakeProfitPrice, "F4");
            sb.AppendFormat("\"unrealized_pnl\":{0},", _unrealizedPnl.ToString("F2", CultureInfo.InvariantCulture));

            sb.AppendFormat("\"realized_pnl_today\":{0},", _realizedPnlToday.ToString("F2", CultureInfo.InvariantCulture));
            sb.AppendFormat("\"trades_today\":{0},", _tradesToday);
            sb.AppendFormat("\"wins_today\":{0},", _winsToday);
            sb.AppendFormat("\"losses_today\":{0},", _lossesToday);
            sb.AppendFormat("\"total_trades\":{0},", _totalTrades);
            sb.AppendFormat("\"total_pnl\":{0},", _totalPnl.ToString("F2", CultureInfo.InvariantCulture));

            if (_lastTradeAt.HasValue)
                sb.AppendFormat("\"last_trade_at\":\"{0:yyyy-MM-ddTHH:mm:ssZ}\",", _lastTradeAt.Value);
            else
                sb.Append("\"last_trade_at\":null,");

            AppendNullableStringField(sb, "last_error", _lastError);
            if (_lastErrorAt.HasValue)
                sb.AppendFormat("\"last_error_at\":\"{0:yyyy-MM-ddTHH:mm:ssZ}\",", _lastErrorAt.Value);
            else
                sb.Append("\"last_error_at\":null,");

            sb.AppendFormat("\"error_count\":{0},", _errorCount);
            sb.AppendFormat("\"warning_count\":{0},", _warningCount);

            sb.AppendFormat("\"started_at\":\"{0:yyyy-MM-ddTHH:mm:ssZ}\",", _startedAtUtc);
            sb.AppendFormat("\"last_heartbeat_at\":\"{0:yyyy-MM-ddTHH:mm:ssZ}\",", DateTime.UtcNow);
            AppendStringField(sb, "host_machine", _hostMachine);
            // Trailing field — no comma. Order matters in the helpers above
            // (each appends a trailing comma); the FINAL field must not.
            sb.AppendFormat("\"nt_version\":\"{0}\"", EscapeJson(_ntVersion));

            sb.Append("}");
            return sb.ToString();
        }

        // ─── HTTP: log POST ───────────────────────────────────────────────────

        /// <summary>
        /// Fire-and-forget INSERT to strategy_logs. Each call is a single row.
        /// We don't batch because log volume is low (entries, exits, errors —
        /// not per-tick) and we want each event visible immediately.
        /// </summary>
        private void PostLog(
            string instanceId,
            string strategyName,
            string accountName,
            string instrument,
            string level,
            string category,
            string message,
            Dictionary<string, object> meta)
        {
            string json = BuildLogJson(instanceId, strategyName, accountName, instrument,
                                       level, category, message, meta);

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(STRATEGY_LOGS_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 10000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;
            using (Stream s = request.GetRequestStream())
            {
                s.Write(bodyBytes, 0, bodyBytes.Length);
            }

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int status = (int)response.StatusCode;
                    if (status < 200 || status >= 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("StrategyReporter: log POST unexpected status {0}", status),
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
                        string body = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("StrategyReporter: log POST HTTP {0} — {1}",
                                (int)errResponse.StatusCode, body),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw;
            }
        }

        /// <summary>
        /// Build the JSON body for one strategy_logs row. `meta` becomes JSONB;
        /// we hand-serialize a small set of value types (string/bool/numeric/null)
        /// because NT8 has no JSON serializer on the classpath.
        /// </summary>
        private static string BuildLogJson(
            string instanceId,
            string strategyName,
            string accountName,
            string instrument,
            string level,
            string category,
            string message,
            Dictionary<string, object> meta)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"instance_id\":\"{0}\",", EscapeJson(instanceId));
            sb.AppendFormat("\"strategy_name\":\"{0}\",", EscapeJson(strategyName));
            sb.AppendFormat("\"account_name\":\"{0}\",", EscapeJson(accountName));
            sb.AppendFormat("\"instrument\":\"{0}\",", EscapeJson(instrument));
            sb.AppendFormat("\"level\":\"{0}\",", EscapeJson(level));
            sb.AppendFormat("\"category\":\"{0}\",", EscapeJson(category));
            sb.AppendFormat("\"message\":\"{0}\",", EscapeJson(TrimToLength(message, 4000)));
            sb.Append("\"meta\":");
            sb.Append(SerializeMeta(meta));
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// Hand-serialize the meta dictionary as a JSON object. Supports
        /// null/string/bool/numeric values; falls back to ToString()+escape for
        /// anything else. Returns "{}" if meta is null/empty.
        /// </summary>
        private static string SerializeMeta(Dictionary<string, object> meta)
        {
            if (meta == null || meta.Count == 0) return "{}";
            var sb = new StringBuilder();
            sb.Append("{");
            int i = 0;
            foreach (var kvp in meta)
            {
                if (i > 0) sb.Append(",");
                sb.AppendFormat("\"{0}\":", EscapeJson(kvp.Key ?? ""));
                object v = kvp.Value;
                if (v == null) sb.Append("null");
                else if (v is bool) sb.Append((bool)v ? "true" : "false");
                else if (v is string) sb.AppendFormat("\"{0}\"", EscapeJson((string)v));
                else if (v is double || v is float || v is decimal)
                    sb.Append(Convert.ToDouble(v).ToString("F4", CultureInfo.InvariantCulture));
                else if (v is int || v is long || v is short || v is byte)
                    sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
                else
                    sb.AppendFormat("\"{0}\"", EscapeJson(v.ToString()));
                i++;
            }
            sb.Append("}");
            return sb.ToString();
        }

        // ─── Day rollover ─────────────────────────────────────────────────────

        /// <summary>
        /// Reset daily counters when the bar's date crosses midnight (in
        /// session-local time). Called from RecordTradeClosed under _lock.
        /// </summary>
        private void RollDayIfNeededLocked(DateTime barTime)
        {
            string dayKey = barTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (!string.Equals(dayKey, _currentDayKey, StringComparison.Ordinal))
            {
                _currentDayKey = dayKey;
                _realizedPnlToday = 0;
                _tradesToday = 0;
                _winsToday = 0;
                _lossesToday = 0;
            }
        }

        // ─── Helpers ──────────────────────────────────────────────────────────

        private static void AppendStringField(StringBuilder sb, string col, string val)
        {
            sb.AppendFormat("\"{0}\":\"{1}\",", col, EscapeJson(val ?? ""));
        }

        private static void AppendNullableStringField(StringBuilder sb, string col, string val)
        {
            if (val == null) sb.AppendFormat("\"{0}\":null,", col);
            else sb.AppendFormat("\"{0}\":\"{1}\",", col, EscapeJson(val));
        }

        private static void AppendNullableNumberField(StringBuilder sb, string col, double? val, string fmt)
        {
            if (!val.HasValue) sb.AppendFormat("\"{0}\":null,", col);
            else sb.AppendFormat("\"{0}\":{1},", col, val.Value.ToString(fmt, CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// Standard JSON string escaper — same set of replacements as
        /// SupabaseWriter.EscapeJson so behavior is identical across writers.
        /// </summary>
        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return s ?? "";
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }

        /// <summary>
        /// Truncate strings before they hit Supabase. Cheaper than letting
        /// PostgREST reject a runaway error message and easier to read in the UI.
        /// </summary>
        private static string TrimToLength(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return s ?? "";
            return s.Length <= max ? s : s.Substring(0, max);
        }

        /// <summary>
        /// Hostname is useful for "which VM ran this" debugging on the dashboard.
        /// Wrapped in a try because Environment.MachineName can throw under
        /// restricted permissions on some Windows configs.
        /// </summary>
        private static string SafeMachineName()
        {
            try { return Environment.MachineName ?? ""; }
            catch { return ""; }
        }

        /// <summary>
        /// Stable hash of the strategy's identity tuple. SHA-256 truncated to
        /// 32 hex chars (16 bytes) — collision-resistant for any practical
        /// number of running strategies and matches the GUID width of the old
        /// random instance_ids so the column doesn't need a migration.
        ///
        /// Inputs are normalized to empty-string for null safety; the
        /// pipe separator ensures `("ab", "c")` and `("a", "bc")` produce
        /// different hashes.
        /// </summary>
        private static string ComputeDeterministicId(
            string strategyName, string accountName, string instrument, string chartTimeframe)
        {
            string key = (strategyName ?? "") + "|" +
                         (accountName ?? "") + "|" +
                         (instrument ?? "") + "|" +
                         (chartTimeframe ?? "");
            using (var sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(key));
                var sb = new StringBuilder(32);
                for (int i = 0; i < 16; i++) sb.AppendFormat("{0:x2}", hash[i]);
                return sb.ToString();
            }
        }
    }
}
