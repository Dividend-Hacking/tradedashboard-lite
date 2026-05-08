#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ═══════════════════════════════════════════════════════════════════════════
    // BarStreamer — Instance-based helper that owns a BarsRequest and its
    // Update event handler. Disposable so LiveBridge can clean it up on
    // recompile (F5) without orphaned event handlers.
    //
    // Follows the exact pattern used by MarketContextTagger (which works
    // reliably): subscribe Update BEFORE Request(), process historical in
    // callback, guard real-time with _lastHistoricalIdx check, dispose safely.
    // ═══════════════════════════════════════════════════════════════════════════

    internal class BarStreamer : IDisposable
    {
        private BarsRequest _request;
        private bool _historicalProcessed;
        private int _lastHistoricalIdx;
        private DateTime _lastPostedBarTime = DateTime.MinValue;
        private bool _isDisposed;

        // Track the forming bar by time — when time changes, the previous bar is complete
        private DateTime _trackingBarTime = DateTime.MinValue;

        private readonly string _instrument;
        private readonly string _timeframe;
        private readonly Action<DateTime, double, double, double, double, long> _onBarComplete;
        private readonly Action<double> _onTick;

        /// <summary>
        /// Creates a BarStreamer that immediately starts fetching historical bars
        /// and subscribes to real-time updates.
        /// </summary>
        /// <param name="instrument">NinjaTrader Instrument object</param>
        /// <param name="instrumentName">Display name for Supabase (e.g., "MNQ 06-26")</param>
        /// <param name="timeframe">Timeframe label (e.g., "15 Second")</param>
        /// <param name="onBarComplete">Callback fired when a completed bar should be posted</param>
        /// <param name="onTick">Callback fired on every tick with the current price</param>
        public BarStreamer(Instrument instrument, string instrumentName, string timeframe,
            Action<DateTime, double, double, double, double, long> onBarComplete,
            Action<double> onTick = null)
        {
            _instrument = instrumentName;
            _timeframe = timeframe;
            _onBarComplete = onBarComplete;
            _onTick = onTick;

            // Parse timeframe string into BarsPeriodType + value dynamically
            // so switching timeframes works without recompiling
            BarsPeriodType periodType;
            int periodValue;
            DataExportHelper.ParseTimeframe(timeframe, out periodType, out periodValue);

            _request = new BarsRequest(instrument, 1000);
            _request.BarsPeriod = new BarsPeriod
            {
                BarsPeriodType = periodType,
                Value = periodValue
            };

            // Subscribe to Update BEFORE calling Request() (same as MarketContextTagger)
            _request.Update += OnBarsUpdate;

            _request.Request(new Action<BarsRequest, ErrorCode, string>((req, error, msg) =>
            {
                if (_isDisposed) return;

                if (error != ErrorCode.NoError)
                {
                    NinjaTrader.Code.Output.Process(
                        "BarStreamer: BarsRequest error — " + error + ": " + msg,
                        PrintTo.OutputTab1);
                    return;
                }

                int count = req.Bars.Count;
                if (count == 0)
                {
                    _historicalProcessed = true;
                    return;
                }

                // Set boundary BEFORE processing — OnBarsUpdate checks this
                _lastHistoricalIdx = count - 1;

                // Post last 1000 bars as warmup
                int start = Math.Max(0, count - 1000);
                for (int i = start; i < count; i++)
                {
                    _onBarComplete(
                        req.Bars.GetTime(i),
                        req.Bars.GetOpen(i),
                        req.Bars.GetHigh(i),
                        req.Bars.GetLow(i),
                        req.Bars.GetClose(i),
                        req.Bars.GetVolume(i));
                }

                // Track the last warmup bar time so OnBarsUpdate doesn't re-post it
                _lastPostedBarTime = req.Bars.GetTime(count - 1);

                _historicalProcessed = true;
                NinjaTrader.Code.Output.Process(
                    "BarStreamer: Sent " + (count - start) + " warmup bars",
                    PrintTo.OutputTab1);
            }));
        }

        /// <summary>
        /// BarsRequest Update handler — fires on each tick for real-time bars.
        ///
        /// Uses time-tracking: reads the time of the bar at e.MaxIndex (the
        /// forming bar). When that time CHANGES from the previous call, the
        /// previous bar just completed — read its final OHLCV and post it.
        ///
        /// This avoids the i &lt; e.MaxIndex problem (where MinIndex==MaxIndex
        /// on tick updates means completed bars never get posted).
        /// </summary>
        private void OnBarsUpdate(object sender, BarsUpdateEventArgs e)
        {
            if (_isDisposed) return;
            if (!_historicalProcessed) return;

            try
            {
                DateTime currentBarTime = _request.Bars.GetTime(e.MaxIndex);

                // If the bar time changed, the previous bar is now confirmed complete
                if (_trackingBarTime != DateTime.MinValue && currentBarTime != _trackingBarTime)
                {
                    // Find the index of the just-completed bar (one before MaxIndex)
                    int completedIdx = e.MaxIndex - 1;
                    if (completedIdx >= 0 && completedIdx > _lastHistoricalIdx)
                    {
                        DateTime completedTime = _request.Bars.GetTime(completedIdx);

                        // Only post if we haven't already posted this bar
                        if (completedTime > _lastPostedBarTime)
                        {
                            _onBarComplete(
                                completedTime,
                                _request.Bars.GetOpen(completedIdx),
                                _request.Bars.GetHigh(completedIdx),
                                _request.Bars.GetLow(completedIdx),
                                _request.Bars.GetClose(completedIdx),
                                _request.Bars.GetVolume(completedIdx));

                            _lastPostedBarTime = completedTime;
                        }
                    }
                }

                // Track the current forming bar's time
                _trackingBarTime = currentBarTime;

                // Fire tick callback with the forming bar's current close (= last trade price)
                if (_onTick != null)
                    _onTick(_request.Bars.GetClose(e.MaxIndex));
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    "BarStreamer: OnBarsUpdate error — " + ex.Message,
                    PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Dispose pattern from MarketContextTagger — each operation in its own
        /// try/catch because any can throw NullReferenceException on corrupted state.
        /// </summary>
        public void Dispose()
        {
            if (_isDisposed) return;
            _isDisposed = true;

            try { if (_request != null) _request.Update -= OnBarsUpdate; }
            catch { }

            try { if (_request != null) _request.Dispose(); }
            catch { }

            _request = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LiveBridge — Bridges NinjaTrader to the web trading UI via Supabase.
    //
    // Three responsibilities:
    //   1. Stream real-time bars and tick prices to Supabase
    //   2. Poll for order requests from the web and execute them
    //   3. Report position/order state back to Supabase
    //
    // Bar streaming uses an instance-based BarStreamer (disposed on recompile)
    // instead of static BarsRequest state (which orphans across F5 recompiles).
    // ═══════════════════════════════════════════════════════════════════════════

    public class LiveBridge : AddOnBase
    {
        // ─── Endpoint resolution ──────────────────────────────────────────────
        // Switch between cloud Supabase REST and the dashboard's local
        // /api/nt8/* routes via ModeConfig. Header lines that add apikey/
        // Authorization remain unchanged — local routes accept and ignore
        // those headers, so no further edits in this file.
        private static string SUPABASE_URL => ModeConfig.Endpoint;
        private static string SUPABASE_ANON_KEY => ModeConfig.ApiKey;
        private static string LIVE_BARS_EP => ModeConfig.TableUrl("live_bars");
        private static string LIVE_TICKER_EP => ModeConfig.TableUrl("live_ticker");
        private static string ORDER_REQUESTS_EP => ModeConfig.TableUrl("order_requests");
        private static string LIVE_STATE_EP => ModeConfig.TableUrl("live_state");
        private static string LIVE_ACCOUNTS_EP => ModeConfig.TableUrl("live_accounts");
        private static string LIVE_COMMANDS_EP => ModeConfig.TableUrl("live_commands");
        private static string LIVEBRIDGE_ENDPOINT_EP => ModeConfig.TableUrl("livebridge_endpoint");

        // ─── Configuration ─────────────────────────────────────────────────────
        // Active instrument and timeframe — updated dynamically via switch_instrument command
        private static string _instrumentName = "MNQ 06-26";
        private static string _timeframeName = "15 Second";

        // ─── Instance-based bar streamer (properly disposed on recompile) ──────
        private static BarStreamer _streamer;

        // Fires whenever a bar completes (warmup or real-time). TradeTracker subscribes
        // to this so it can maintain a per-instrument ring buffer of recent bars and
        // slice out the window around each live trade without owning a second BarsRequest.
        // Signature: (instrument, timeframe, barTime, open, high, low, close, volume).
        public static event Action<string, string, DateTime, double, double, double, double, long> BarCompletedEvent;

        // ─── Timers ────────────────────────────────────────────────────────────
        private static Timer _orderPollTimer;
        private static Timer _cleanupTimer;
        private static Timer _commandPollTimer;

        // ─── Market Data State ─────────────────────────────────────────────────
        private static Instrument _instrument;
        private static double _lastPrice;
        // Active account — set per order, used for position reporting
        private static Account _activeAccount;
        private static DateTime _lastTickUpload = DateTime.MinValue;

        // ─── Order Execution State ─────────────────────────────────────────────
        private static readonly object _pollLock = new object();
        private static bool _isProcessingOrder;
        // Bracket pairs — each entry fill creates one pair (SL + TP OCO).
        // Multiple pairs exist when the user "adds" to an existing position.
        private class BracketPair
        {
            public Order StopOrder;
            public Order TargetOrder;
            public double SlPrice;
            public double TpPrice;
            public double EntryPrice;
            public int Qty;
        }
        private static readonly List<BracketPair> _activeBrackets = new List<BracketPair>();
        private static bool _activeIsLong;
        private static double _activeSlDistance;
        private static double _activeTpDistance;
        private static bool _activeTrailEnabled;
        // Quantity of the first entry — used when "Add to Position" replicates
        // the same lot size for each add-on.
        private static int _originalEntryQty;
        private static Account _subscribedOrderUpdateAccount;
        private static bool _subscribedToPositionUpdate;
        private static long _pendingRequestId;
        private static Order _pendingEntryOrder;
        private static DateTime _pendingEntryTime;

        // ─── WebSocket Server State ───────────────────────────────────────
        private static HttpListener _wsListener;
        private static readonly List<WebSocket> _wsClients = new List<WebSocket>();
        private static readonly object _wsLock = new object();
        private static CancellationTokenSource _wsCts;
        private const int WS_PORT = 8765;
        // Serialized send queue — all outbound messages go through here to
        // prevent concurrent SendAsync calls which corrupt the WebSocket.
        private static readonly ConcurrentQueue<string> _wsSendQueue = new ConcurrentQueue<string>();

        // ─── Lifecycle ─────────────────────────────────────────────────────────

        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    Name = "LiveBridge";
                    Description = "Bridges NinjaTrader to web trading UI via Supabase";
                    break;

                case State.Active:
                    Log("LiveBridge: Starting...");

                    // ─── Dispose old streamer from previous F5 recompile ─────
                    if (_streamer != null) { _streamer.Dispose(); _streamer = null; }
                    _lastPrice = 0;
                    _lastTickUpload = DateTime.MinValue;
                    _orderPollTimer?.Dispose();
                    _cleanupTimer?.Dispose();
                    _commandPollTimer?.Dispose();
                    StopWebSocketServer();

                    // Resolve instrument
                    _instrument = Instrument.GetInstrument(_instrumentName, false);
                    if (_instrument == null)
                    {
                        Log("LiveBridge: ERROR — Instrument not found: " + _instrumentName);
                        return;
                    }
                    // Canonicalize: NT8 may normalize the requested name
                    // (e.g. "NQ 06-26" → "NQ JUN26" depending on how the
                    // contract is cataloged in the user's workspace).
                    // TradeTracker writes Instrument.FullName directly into
                    // the trades table, so for live_state/live_bars/live_ticker
                    // to be joinable with trades we must use the same canonical
                    // string everywhere. See plan: instrument-name mismatch fix.
                    if (!string.Equals(_instrumentName, _instrument.FullName, StringComparison.Ordinal))
                    {
                        Log("LiveBridge: Canonicalized instrument '" + _instrumentName + "' → '" + _instrument.FullName + "'");
                        _instrumentName = _instrument.FullName;
                    }

                    // Publish all available accounts to Supabase
                    PublishAccounts();

                    // Start instance-based bar streamer with tick callback
                    // (Instrument.MarketDataUpdate doesn't fire in AddOn context,
                    //  so we get tick prices from BarsRequest.Update instead)
                    _streamer = new BarStreamer(_instrument, _instrumentName, _timeframeName,
                        OnBarCompleted, OnTickFromBars);

                    // Start order polling (150ms for low-latency order execution)
                    _orderPollTimer = new Timer(_ => PollForOrderRequests(),
                        null, TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(150));

                    // Cleanup old bars every hour
                    _cleanupTimer = new Timer(_ => CleanupOldBars(),
                        null, TimeSpan.FromMinutes(5), TimeSpan.FromHours(1));

                    // Poll for web commands (reseed_bars, etc.) every 2 seconds
                    _commandPollTimer = new Timer(_ => PollForCommands(),
                        null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(2));

                    // Start WebSocket server for low-latency direct connection
                    StartWebSocketServer();

                    Log("LiveBridge: Started — streaming " + _instrumentName);
                    break;

                case State.Terminated:
                    if (_streamer != null) { _streamer.Dispose(); _streamer = null; }
                    _orderPollTimer?.Dispose();
                    _cleanupTimer?.Dispose();
                    _commandPollTimer?.Dispose();
                    StopWebSocketServer();
                    if (_activeAccount != null && _subscribedToPositionUpdate)
                    {
                        _activeAccount.PositionUpdate -= OnPositionUpdate;
                        _subscribedToPositionUpdate = false;
                    }
                    // Unsubscribe OrderUpdate on the tracked account
                    if (_subscribedOrderUpdateAccount != null)
                    {
                        _subscribedOrderUpdateAccount.OrderUpdate -= OnOrderUpdate;
                        _subscribedOrderUpdateAccount = null;
                    }
                    break;
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // BAR STREAMING CALLBACK
        // ═══════════════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════════════
        // ACCOUNT MANAGEMENT
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>Publish all available NT8 accounts to Supabase for the web dropdown.</summary>
        private static void PublishAccounts()
        {
            Task.Run(() =>
            {
                try
                {
                    foreach (Account acct in Account.All)
                    {
                        var sb = new StringBuilder();
                        sb.Append("{");
                        sb.AppendFormat("\"account_name\":\"{0}\",", Esc(acct.Name));
                        sb.AppendFormat("\"updated_at\":\"{0:yyyy-MM-ddTHH:mm:ss}\"", DateTime.Now);
                        sb.Append("}");
                        try
                        {
                            HttpPost(LIVE_ACCOUNTS_EP, sb.ToString(), "return=minimal,resolution=merge-duplicates");
                        }
                        catch { } // Ignore conflicts for existing accounts
                    }
                    Log("LiveBridge: Published " + Account.All.Count + " accounts to Supabase");
                }
                catch (Exception ex)
                {
                    Log("LiveBridge: PublishAccounts error — " + ex.Message);
                }
            });
        }

        /// <summary>Resolve an Account object by name from Account.All.</summary>
        private static Account ResolveAccount(string accountName)
        {
            if (string.IsNullOrEmpty(accountName)) return null;
            foreach (Account acct in Account.All)
            {
                if (acct.Name == accountName) return acct;
            }
            return null;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // BAR STREAMING CALLBACK
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// Called by BarStreamer when a completed bar should be posted to Supabase.
        /// Fires for warmup bars and real-time completed bars.
        /// </summary>
        private static void OnBarCompleted(DateTime barTime, double open, double high,
            double low, double close, long volume)
        {
            // Notify in-process subscribers synchronously so TradeTracker's ring buffer
            // is updated before any trade exit that might fire on the same tick.
            // Any subscriber exception is isolated so Supabase posting still runs.
            try
            {
                var handler = BarCompletedEvent;
                if (handler != null)
                    handler(_instrumentName, _timeframeName, barTime, open, high, low, close, volume);
            }
            catch (Exception ex)
            {
                Log("LiveBridge: BarCompletedEvent subscriber error — " + ex.Message);
            }

            Task.Run(() =>
            {
                try
                {
                    var sb = new StringBuilder();
                    sb.Append("{");
                    sb.AppendFormat("\"instrument\":\"{0}\",", Esc(_instrumentName));
                    sb.AppendFormat("\"timeframe\":\"{0}\",", Esc(_timeframeName));
                    sb.AppendFormat("\"bar_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", barTime);
                    sb.AppendFormat("\"bar_open\":{0},", open.ToString("F2", CultureInfo.InvariantCulture));
                    sb.AppendFormat("\"bar_high\":{0},", high.ToString("F2", CultureInfo.InvariantCulture));
                    sb.AppendFormat("\"bar_low\":{0},", low.ToString("F2", CultureInfo.InvariantCulture));
                    sb.AppendFormat("\"bar_close\":{0},", close.ToString("F2", CultureInfo.InvariantCulture));
                    sb.AppendFormat("\"bar_volume\":{0}", volume);
                    sb.Append("}");
                    HttpPost(LIVE_BARS_EP, sb.ToString());

                    // Also broadcast via WebSocket for low-latency clients
                    WsBroadcast(string.Format(
                        "{{\"type\":\"bar\",\"instrument\":\"{0}\",\"timeframe\":\"{1}\"," +
                        "\"bar_time\":\"{2:yyyy-MM-ddTHH:mm:ss}\",\"bar_open\":{3},\"bar_high\":{4}," +
                        "\"bar_low\":{5},\"bar_close\":{6},\"bar_volume\":{7}}}",
                        Esc(_instrumentName), Esc(_timeframeName), barTime,
                        open.ToString("F2", CultureInfo.InvariantCulture),
                        high.ToString("F2", CultureInfo.InvariantCulture),
                        low.ToString("F2", CultureInfo.InvariantCulture),
                        close.ToString("F2", CultureInfo.InvariantCulture), volume));
                }
                catch (Exception ex)
                {
                    // Silently ignore 409 conflicts (warmup bar already exists)
                    if (!ex.Message.Contains("409"))
                        Log("LiveBridge: PostBar error — " + ex.Message);
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════════════
        // TICK STREAMING
        // ═══════════════════════════════════════════════════════════════════════

        private static int _tickEventCount;
        private static DateTime _lastTickLogTime = DateTime.MinValue;

        /// <summary>
        /// Tick handler called by BarStreamer on every BarsRequest.Update event.
        /// Replaces Instrument.MarketDataUpdate which doesn't fire in AddOn context.
        /// Handles: WS tick broadcast, trailing stop, throttled Supabase upload.
        /// </summary>
        private static void OnTickFromBars(double price)
        {
            _lastPrice = price;

            // Log tick rate every 5 seconds — only when a WS client is attached
            // so the Output window stays quiet while a strategy is being tested.
            _tickEventCount++;
            if ((DateTime.Now - _lastTickLogTime).TotalSeconds >= 5)
            {
                _lastTickLogTime = DateTime.Now;
                int wsClientCount;
                lock (_wsLock) { wsClientCount = _wsClients.Count; }
                if (wsClientCount > 0)
                {
                    Log("LiveBridge: OnTickFromBars — " + _tickEventCount + " ticks in last 5s, price=" +
                        price.ToString("F2", CultureInfo.InvariantCulture));
                }
                _tickEventCount = 0;
            }

            // Trailing stop logic is handled by the web frontend.
            // The app computes trailing SL on each tick and sends modify_sl
            // commands back to NT8 via WebSocket — avoids Account.Change()
            // issues with stale order references in AddOn context.

            // Broadcast every tick via WebSocket — send queue coalesces for us
            WsBroadcast(string.Format(
                "{{\"type\":\"tick\",\"last_price\":{0}}}",
                price.ToString("F2", CultureInfo.InvariantCulture)));

            // Throttle Supabase ticker updates to ~13/sec
            if ((DateTime.Now - _lastTickUpload).TotalMilliseconds < 75) return;
            _lastTickUpload = DateTime.Now;

            Task.Run(() =>
            {
                try
                {
                    var sb = new StringBuilder();
                    sb.Append("{");
                    sb.AppendFormat("\"instrument\":\"{0}\",", Esc(_instrumentName));
                    sb.AppendFormat("\"last_price\":{0},", price.ToString("F2", CultureInfo.InvariantCulture));
                    sb.AppendFormat("\"updated_at\":\"{0:yyyy-MM-ddTHH:mm:ss}\"", DateTime.Now);
                    sb.Append("}");
                    HttpPost(LIVE_TICKER_EP, sb.ToString(), "return=minimal,resolution=merge-duplicates");

                    // Also update live_state with fresh P&L if we have an active position
                    if (_activeAccount != null)
                        UpsertLiveState();
                }
                catch { }
            });
        }

        // ═══════════════════════════════════════════════════════════════════════
        // ORDER POLLING & EXECUTION (unchanged from previous version)
        // ═══════════════════════════════════════════════════════════════════════

        private static void PollForOrderRequests()
        {
            lock (_pollLock)
            {
                if (_isProcessingOrder) return;
                _isProcessingOrder = true;
            }
            try
            {
                string json = HttpGet(ORDER_REQUESTS_EP,
                    "status=eq.pending&order=created_at.asc&limit=1" +
                    "&select=id,instrument,action,sl_points,tp_points,trail_enabled,new_sl_price,new_tp_price,account,quantity");
                if (string.IsNullOrEmpty(json) || json.Trim() == "[]") return;

                long reqId = ParseLong(json, "id");
                string action = ParseStr(json, "action");
                string accountName = ParseStr(json, "account");
                if (reqId <= 0 || action == null) return;

                // Resolve the account from the order request
                Account account = ResolveAccount(accountName);
                if (account == null && action != "cancel_all")
                {
                    PatchOrderError(reqId, "Account not found: " + (accountName ?? "null"));
                    return;
                }

                // Set active account for position reporting
                _activeAccount = account;

                HttpPatch(ORDER_REQUESTS_EP, "id=eq." + reqId,
                    "{\"status\":\"processing\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");

                double slPts = ParseDouble(json, "sl_points");
                double tpPts = ParseDouble(json, "tp_points");
                bool trail = json.Contains("\"trail_enabled\":true");
                double newSlPrice = ParseDouble(json, "new_sl_price");
                double newTpPrice = ParseDouble(json, "new_tp_price");
                // Quantity column was added late — fall back to 1 contract when
                // missing/zero so older clients (or rows with NULL) keep working.
                long parsedQty = ParseLong(json, "quantity");
                int qty = parsedQty > 0 ? (int)parsedQty : 1;

                Log("LiveBridge: Processing order #" + reqId + " — " + action + " on " + accountName + " qty=" + qty);

                switch (action)
                {
                    case "buy_long": ExecuteEntry(reqId, true, slPts, tpPts, trail, qty); break;
                    case "sell_short": ExecuteEntry(reqId, false, slPts, tpPts, trail, qty); break;
                    case "close": ExecuteClose(reqId); break;
                    case "modify_sl": ExecuteModifySl(reqId, newSlPrice); break;
                    case "modify_tp": ExecuteModifyTp(reqId, newTpPrice); break;
                    default: PatchOrderError(reqId, "Unknown action: " + action); break;
                }
            }
            catch (Exception ex) { Log("LiveBridge: Poll error — " + ex.Message); }
            finally { lock (_pollLock) _isProcessingOrder = false; }
        }

        private static void ExecuteEntry(long reqId, bool isLong, double slPts, double tpPts, bool trail, int qty)
        {
            if (_pendingEntryOrder != null)
            {
                // Auto-clear stale pending entries (e.g., OnOrderUpdate callback missed
                // or order went to an unhandled terminal state)
                if ((DateTime.Now - _pendingEntryTime).TotalSeconds > 10)
                {
                    Log("LiveBridge: Stale pending entry cleared (state=" + _pendingEntryOrder.OrderState +
                        ", age=" + (DateTime.Now - _pendingEntryTime).TotalSeconds.ToString("F1") + "s)");
                    _pendingEntryOrder = null;
                }
                else
                {
                    PatchOrderError(reqId, "Entry already pending");
                    return;
                }
            }
            // Defensive clamp — caller should already pass a positive int, but
            // this prevents a zero-contract submission if a future code path
            // forgets the guard.
            if (qty < 1) qty = 1;
            try
            {
                Order entryOrder = _activeAccount.CreateOrder(_instrument,
                    isLong ? OrderAction.Buy : OrderAction.SellShort,
                    OrderType.Market, TimeInForce.Day, qty, 0, 0,
                    string.Empty, "LiveBridge Entry", null);

                _pendingRequestId = reqId;
                _pendingEntryOrder = entryOrder;
                _pendingEntryTime = DateTime.Now;
                _activeIsLong = isLong;
                _activeSlDistance = slPts;
                _activeTpDistance = tpPts;
                _activeTrailEnabled = trail;

                // Re-subscribe when switching accounts so the fill callback
                // fires on the correct account (e.g., Sim101 → Demo).
                if (_subscribedOrderUpdateAccount != _activeAccount)
                {
                    if (_subscribedOrderUpdateAccount != null)
                        _subscribedOrderUpdateAccount.OrderUpdate -= OnOrderUpdate;
                    _activeAccount.OrderUpdate += OnOrderUpdate;
                    _subscribedOrderUpdateAccount = _activeAccount;
                }
                _activeAccount.Submit(new[] { entryOrder });
                Log("LiveBridge: " + (isLong ? "LONG" : "SHORT") + " entry submitted @ MKT");
            }
            catch (Exception ex)
            {
                _pendingEntryOrder = null;
                PatchOrderError(reqId, "Entry error: " + ex.Message);
            }
        }

        private static void OnOrderUpdate(object sender, OrderEventArgs e)
        {
            if (e.Order == null) return;

            // Entry fill → place bracket
            if (_pendingEntryOrder != null && e.Order == _pendingEntryOrder)
            {
                if (e.OrderState == OrderState.Filled)
                {
                    double fillPrice = e.AverageFillPrice;
                    double tickSize = _instrument.MasterInstrument.TickSize;
                    Log("LiveBridge: Entry filled @ " + fillPrice.ToString("F2"));

                    double slPrice = 0, tpPrice = 0;
                    if (_activeIsLong)
                    {
                        slPrice = _activeSlDistance > 0 ? Math.Round((fillPrice - _activeSlDistance) / tickSize) * tickSize : 0;
                        tpPrice = _activeTpDistance > 0 ? Math.Round((fillPrice + _activeTpDistance) / tickSize) * tickSize : 0;
                    }
                    else
                    {
                        slPrice = _activeSlDistance > 0 ? Math.Round((fillPrice + _activeSlDistance) / tickSize) * tickSize : 0;
                        tpPrice = _activeTpDistance > 0 ? Math.Round((fillPrice - _activeTpDistance) / tickSize) * tickSize : 0;
                    }

                    try
                    {
                        string ocoId = Guid.NewGuid().ToString("N").Substring(0, 18);
                        OrderAction exitAction = _activeIsLong ? OrderAction.Sell : OrderAction.BuyToCover;
                        int bracketQty = _pendingEntryOrder.Quantity;

                        Order stopOrd = _activeSlDistance > 0 ? _activeAccount.CreateOrder(
                            _instrument, exitAction, OrderType.StopMarket, TimeInForce.Gtc,
                            bracketQty, 0, slPrice, ocoId, "LiveBridge Stop", null) : null;

                        Order tgtOrd = _activeTpDistance > 0 ? _activeAccount.CreateOrder(
                            _instrument, exitAction, OrderType.Limit, TimeInForce.Gtc,
                            bracketQty, tpPrice, 0, ocoId, "LiveBridge Target", null) : null;

                        if (stopOrd != null && tgtOrd != null)
                            _activeAccount.Submit(new[] { stopOrd, tgtOrd });
                        else if (stopOrd != null)
                            _activeAccount.Submit(new[] { stopOrd });
                        else if (tgtOrd != null)
                            _activeAccount.Submit(new[] { tgtOrd });

                        // Track this bracket pair (supports multiple adds to a position)
                        var bracket = new BracketPair {
                            StopOrder = stopOrd, TargetOrder = tgtOrd,
                            SlPrice = slPrice, TpPrice = tpPrice,
                            EntryPrice = fillPrice, Qty = bracketQty
                        };
                        _activeBrackets.Add(bracket);

                        // Remember the first entry's qty so "Add" can replicate it
                        if (_activeBrackets.Count == 1) _originalEntryQty = bracketQty;

                        Log(string.Format("LiveBridge: OCO bracket #{0} — SL={1:F2} TP={2:F2} qty={3}",
                            _activeBrackets.Count, slPrice, tpPrice, bracketQty));
                    }
                    catch (Exception ex) { Log("LiveBridge: Bracket error — " + ex.Message); }

                    // Skip Supabase patch for WebSocket-sourced orders (negative IDs)
                    if (_pendingRequestId > 0)
                    {
                        Task.Run(() => HttpPatch(ORDER_REQUESTS_EP, "id=eq." + _pendingRequestId,
                            string.Format("{{\"status\":\"filled\",\"fill_price\":{0},\"updated_at\":\"{1}\"}}",
                                fillPrice.ToString("F2", CultureInfo.InvariantCulture), DateTime.UtcNow.ToString("o"))));
                    }

                    // Direct PATCH to set SL/TP — use first bracket's prices for Supabase compat
                    double primarySl = _activeBrackets.Count > 0 ? _activeBrackets[0].SlPrice : slPrice;
                    double primaryTp = _activeBrackets.Count > 0 ? _activeBrackets[0].TpPrice : tpPrice;
                    PatchSlTp(primarySl, primaryTp);

                    // ── Synchronous live_state push using locally known fill data ──
                    string entryDir = _activeIsLong ? "\"Long\"" : "\"Short\"";
                    // Total position qty = sum of all bracket quantities
                    int totalQty = 0;
                    foreach (var b in _activeBrackets) totalQty += b.Qty;
                    string entryAcctName = _activeAccount != null ? _activeAccount.Name : "unknown";

                    // WebSocket broadcast — includes full brackets array for multi-add support
                    WsBroadcast(BuildStateJson(entryDir, totalQty, fillPrice, 0, entryAcctName));

                    // Supabase PATCH — sl_price/tp_price managed by PatchSlTp above
                    var entryStateBody = new StringBuilder();
                    entryStateBody.Append("{");
                    entryStateBody.AppendFormat(CultureInfo.InvariantCulture, "\"position_direction\":{0},", entryDir);
                    entryStateBody.AppendFormat(CultureInfo.InvariantCulture, "\"position_quantity\":{0},", totalQty);
                    entryStateBody.AppendFormat(CultureInfo.InvariantCulture, "\"position_entry_price\":{0:F2},", fillPrice);
                    entryStateBody.AppendFormat(CultureInfo.InvariantCulture, "\"unrealized_pnl\":0,");
                    entryStateBody.AppendFormat(CultureInfo.InvariantCulture, "\"trail_enabled\":{0},", _activeTrailEnabled ? "true" : "false");
                    entryStateBody.AppendFormat(CultureInfo.InvariantCulture, "\"updated_at\":\"{0:yyyy-MM-ddTHH:mm:ss}\"", DateTime.Now);
                    entryStateBody.Append("}");
                    Task.Run(() => HttpPatch(LIVE_STATE_EP,
                        "instrument=eq." + Uri.EscapeDataString(_instrumentName) +
                        "&account=eq." + Uri.EscapeDataString(entryAcctName),
                        entryStateBody.ToString()));

                    Log(string.Format(CultureInfo.InvariantCulture,
                        "LiveBridge: Live state set — {0} {1} @ {2:F2} qty={3} brackets={4}",
                        _activeIsLong ? "Long" : "Short", _instrumentName, fillPrice, totalQty, _activeBrackets.Count));

                    // Safety-net follow-up
                    Task.Run(() => UpsertLiveState());
                    _pendingEntryOrder = null;
                }
                else if (e.OrderState == OrderState.Rejected || e.OrderState == OrderState.Cancelled)
                {
                    PatchOrderError(_pendingRequestId, "Order " + e.OrderState);
                    _pendingEntryOrder = null;
                }
            }

            // Exit fill → remove the filled bracket pair. If no brackets remain, position is flat.
            if (e.OrderState == OrderState.Filled)
            {
                BracketPair filledBracket = null;
                foreach (var b in _activeBrackets)
                {
                    if (e.Order == b.StopOrder || e.Order == b.TargetOrder)
                    { filledBracket = b; break; }
                }
                if (filledBracket != null)
                {
                    bool wasSl = e.Order == filledBracket.StopOrder;
                    Log(string.Format("LiveBridge: Exit — {0} @ {1:F2} (bracket qty={2})",
                        wasSl ? "SL" : "TP", e.AverageFillPrice, filledBracket.Qty));
                    _activeBrackets.Remove(filledBracket);

                    string acctName = _activeAccount != null ? _activeAccount.Name : "unknown";

                    if (_activeBrackets.Count == 0)
                    {
                        // All brackets filled — position is flat
                        _activeTrailEnabled = false;
                        _originalEntryQty = 0;
                        WsBroadcast(BuildStateJson("null", 0, 0, 0, acctName));
                        PatchSlTp(0, 0);
                    }
                    else
                    {
                        // Remaining brackets still active — update qty and SL/TP to first bracket
                        int remainQty = 0;
                        foreach (var b in _activeBrackets) remainQty += b.Qty;
                        PatchSlTp(_activeBrackets[0].SlPrice, _activeBrackets[0].TpPrice);
                        // Use first bracket's entry price as representative
                        WsBroadcast(BuildStateJson(
                            _activeIsLong ? "\"Long\"" : "\"Short\"",
                            remainQty, _activeBrackets[0].EntryPrice, 0, acctName));
                    }
                    Task.Run(() => UpsertLiveState());
                }
            }
        }

        private static void ExecuteClose(long reqId)
        {
            try
            {
                // Cancel all working bracket orders (all SL/TP pairs from original + adds)
                foreach (var bracket in _activeBrackets)
                {
                    if (bracket.StopOrder?.OrderState == OrderState.Working)
                        _activeAccount.Cancel(new[] { bracket.StopOrder });
                    if (bracket.TargetOrder?.OrderState == OrderState.Working)
                        _activeAccount.Cancel(new[] { bracket.TargetOrder });
                }
                // Also search for any orphaned working orders as fallback
                var allStops = FindAllWorkingOrders(_activeAccount, OrderType.StopMarket);
                var allTargets = FindAllWorkingOrders(_activeAccount, OrderType.Limit);
                foreach (var o in allStops)
                    if (o.OrderState == OrderState.Working) _activeAccount.Cancel(new[] { o });
                foreach (var o in allTargets)
                    if (o.OrderState == OrderState.Working) _activeAccount.Cancel(new[] { o });
                _activeAccount.Flatten(new[] { _instrument });
                _activeBrackets.Clear();
                _activeTrailEnabled = false;
                _originalEntryQty = 0;
                _pendingEntryOrder = null; // Clear any stuck pending entry on close
                PatchSlTp(0, 0); // Clear SL/TP in DB
                HttpPatch(ORDER_REQUESTS_EP, "id=eq." + reqId,
                    "{\"status\":\"filled\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
                Log("LiveBridge: Position closed");
                Task.Run(() => UpsertLiveState());
            }
            catch (Exception ex) { PatchOrderError(reqId, "Close error: " + ex.Message); }
        }

        /// <summary>Search account orders for a working order of the given type for our instrument.</summary>
        /// <summary>Direct PATCH to set or clear SL/TP in live_state. Thread-safe (fire-and-forget).</summary>
        private static void PatchSlTp(double slPrice, double tpPrice)
        {
            string accountName = _activeAccount != null ? _activeAccount.Name : "unknown";
            Task.Run(() =>
            {
                try
                {
                    string json = string.Format(
                        "{{\"sl_price\":{0},\"tp_price\":{1},\"updated_at\":\"{2}\"}}",
                        slPrice > 0 ? slPrice.ToString("F2", CultureInfo.InvariantCulture) : "null",
                        tpPrice > 0 ? tpPrice.ToString("F2", CultureInfo.InvariantCulture) : "null",
                        DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss"));
                    HttpPatch(LIVE_STATE_EP,
                        "instrument=eq." + System.Uri.EscapeDataString(_instrumentName) +
                        "&account=eq." + System.Uri.EscapeDataString(accountName),
                        json);
                }
                catch (Exception ex) { Log("LiveBridge: PatchSlTp error — " + ex.Message); }
            });
        }

        private static Order FindWorkingOrder(Account account, OrderType orderType)
        {
            if (account == null || _instrument == null) return null;
            string instrumentName = _instrument.FullName;
            foreach (Order order in account.Orders)
            {
                if (order.Instrument.FullName == instrumentName &&
                    order.OrderType == orderType &&
                    order.OrderState != OrderState.Cancelled &&
                    order.OrderState != OrderState.Rejected &&
                    order.OrderState != OrderState.Filled)
                    return order;
            }
            return null;
        }

        /// <summary>Find ALL working orders of a given type for our instrument.</summary>
        private static List<Order> FindAllWorkingOrders(Account account, OrderType orderType)
        {
            var result = new List<Order>();
            if (account == null || _instrument == null) return result;
            string instrumentName = _instrument.FullName;
            foreach (Order order in account.Orders)
            {
                if (order.Instrument.FullName == instrumentName &&
                    order.OrderType == orderType &&
                    order.OrderState != OrderState.Cancelled &&
                    order.OrderState != OrderState.Rejected &&
                    order.OrderState != OrderState.Filled)
                    result.Add(order);
            }
            return result;
        }

        /// <summary>One-time diagnostic: log all orders for our instrument.</summary>
        private static DateTime _lastOrderDump = DateTime.MinValue;
        private static void DumpOrders()
        {
            if (_activeAccount == null || _instrument == null) return;
            // Only dump once every 10 seconds to avoid spam
            if ((DateTime.Now - _lastOrderDump).TotalSeconds < 10) return;
            _lastOrderDump = DateTime.Now;

            int count = 0;
            string instrumentName = _instrument.FullName;
            foreach (Order order in _activeAccount.Orders)
            {
                count++;
                if (order.Instrument.FullName == instrumentName)
                {
                    Log(string.Format("LiveBridge ORDER DUMP: {0} type={1} state={2} stop={3:F2} limit={4:F2}",
                        order.Name, order.OrderType, order.OrderState, order.StopPrice, order.LimitPrice));
                }
            }
            Log("LiveBridge ORDER DUMP: Total orders in account=" + count +
                " instrument=" + instrumentName);
        }

        private static void ExecuteModifySl(long reqId, double newSlPrice)
        {
            // Modify the first bracket's stop order (trailing stop uses this).
            // With multiple brackets only the first is modified — the others
            // retain their original SL levels.
            Order stopOrder = null;
            if (_activeBrackets.Count > 0 && _activeBrackets[0].StopOrder != null)
                stopOrder = _activeBrackets[0].StopOrder;
            else
                stopOrder = FindWorkingOrder(_activeAccount, OrderType.StopMarket);
            if (stopOrder == null)
            { PatchOrderError(reqId, "No working stop order found"); return; }
            try
            {
                stopOrder.StopPriceChanged = newSlPrice;
                _activeAccount.Change(new[] { stopOrder });
                if (_activeBrackets.Count > 0) _activeBrackets[0].SlPrice = newSlPrice;
                HttpPatch(ORDER_REQUESTS_EP, "id=eq." + reqId,
                    "{\"status\":\"filled\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
                Log("LiveBridge: SL → " + newSlPrice.ToString("F2"));
                PatchSlTp(_activeBrackets.Count > 0 ? _activeBrackets[0].SlPrice : newSlPrice,
                          _activeBrackets.Count > 0 ? _activeBrackets[0].TpPrice : 0);
                Task.Run(() => UpsertLiveState());
            }
            catch (Exception ex) { PatchOrderError(reqId, "Modify SL error: " + ex.Message); }
        }

        private static void ExecuteModifyTp(long reqId, double newTpPrice)
        {
            Order targetOrder = null;
            if (_activeBrackets.Count > 0 && _activeBrackets[0].TargetOrder != null)
                targetOrder = _activeBrackets[0].TargetOrder;
            else
                targetOrder = FindWorkingOrder(_activeAccount, OrderType.Limit);
            if (targetOrder == null)
            { PatchOrderError(reqId, "No working target order found"); return; }
            try
            {
                targetOrder.LimitPriceChanged = newTpPrice;
                _activeAccount.Change(new[] { targetOrder });
                if (_activeBrackets.Count > 0) _activeBrackets[0].TpPrice = newTpPrice;
                HttpPatch(ORDER_REQUESTS_EP, "id=eq." + reqId,
                    "{\"status\":\"filled\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
                Log("LiveBridge: TP → " + newTpPrice.ToString("F2"));
                PatchSlTp(_activeBrackets.Count > 0 ? _activeBrackets[0].SlPrice : 0,
                          _activeBrackets.Count > 0 ? _activeBrackets[0].TpPrice : newTpPrice);
                Task.Run(() => UpsertLiveState());
            }
            catch (Exception ex) { PatchOrderError(reqId, "Modify TP error: " + ex.Message); }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // STATE JSON BUILDER (shared by fill handler + UpsertLiveState)
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// Build the full WS state JSON including the brackets array.
        /// sl_price/tp_price are set from the first bracket for backward compat.
        /// </summary>
        private static string BuildStateJson(string dir, int qty, double entryPrice, double pnl, string accountName)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"type\":\"state\",\"instrument\":\"{0}\",\"account\":\"{1}\",", Esc(_instrumentName), Esc(accountName));
            sb.AppendFormat("\"position_direction\":{0},\"position_quantity\":{1},", dir, qty);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"position_entry_price\":{0:F2},", entryPrice);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"unrealized_pnl\":{0:F2},", pnl);
            // Primary SL/TP from first bracket (backward compat)
            string slStr = "null", tpStr = "null";
            if (_activeBrackets.Count > 0)
            {
                if (_activeBrackets[0].SlPrice > 0) slStr = _activeBrackets[0].SlPrice.ToString("F2", CultureInfo.InvariantCulture);
                if (_activeBrackets[0].TpPrice > 0) tpStr = _activeBrackets[0].TpPrice.ToString("F2", CultureInfo.InvariantCulture);
            }
            sb.AppendFormat("\"sl_price\":{0},\"tp_price\":{1},", slStr, tpStr);
            sb.AppendFormat("\"trail_enabled\":{0},", _activeTrailEnabled ? "true" : "false");
            sb.AppendFormat("\"original_entry_qty\":{0},", _originalEntryQty);
            // Brackets array — each element has entry_price, sl_price, tp_price, qty
            sb.Append("\"brackets\":[");
            for (int i = 0; i < _activeBrackets.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var b = _activeBrackets[i];
                sb.AppendFormat(CultureInfo.InvariantCulture,
                    "{{\"entry_price\":{0:F2},\"sl_price\":{1},\"tp_price\":{2},\"qty\":{3}}}",
                    b.EntryPrice,
                    b.SlPrice > 0 ? b.SlPrice.ToString("F2", CultureInfo.InvariantCulture) : "null",
                    b.TpPrice > 0 ? b.TpPrice.ToString("F2", CultureInfo.InvariantCulture) : "null",
                    b.Qty);
            }
            sb.Append("]}");
            return sb.ToString();
        }

        // ═══════════════════════════════════════════════════════════════════════
        // POSITION STATE REPORTING
        // ═══════════════════════════════════════════════════════════════════════

        private static void OnPositionUpdate(object sender, PositionEventArgs e)
        {
            if (e.Position.Instrument != _instrument) return;
            Task.Run(() => UpsertLiveState());
        }

        private static void UpsertLiveState()
        {
            try
            {
                string dir = "null"; int qty = 0; double entryPrice = 0; double pnl = 0;
                if (_activeAccount != null && _instrument != null)
                {
                    Position pos = null;
                    foreach (Position p in _activeAccount.Positions)
                        if (p.Instrument == _instrument) { pos = p; break; }
                    if (pos != null && pos.MarketPosition != MarketPosition.Flat)
                    {
                        dir = "\"" + (pos.MarketPosition == MarketPosition.Long ? "Long" : "Short") + "\"";
                        qty = pos.Quantity; entryPrice = pos.AveragePrice;
                        pnl = pos.MarketPosition == MarketPosition.Long
                            ? _lastPrice - entryPrice : entryPrice - _lastPrice;
                    }
                }
                string accountName = _activeAccount != null ? _activeAccount.Name : "unknown";

                // UpsertLiveState NEVER writes sl_price/tp_price.
                // SL/TP are managed exclusively by:
                //   - Direct PATCH after bracket placement (OnOrderUpdate)
                //   - ExecuteModifySl / ExecuteModifyTp / trailing stop handlers
                // This avoids threading/timing issues where FindWorkingOrder returns null
                // and overwrites the correct values with null.
                // Only exception: clear them when position is flat.
                var sb = new StringBuilder();
                sb.Append("{");
                sb.AppendFormat("\"position_direction\":{0},", dir);
                sb.AppendFormat("\"position_quantity\":{0},", qty);
                sb.AppendFormat("\"position_entry_price\":{0},", entryPrice.ToString("F2", CultureInfo.InvariantCulture));
                sb.AppendFormat("\"unrealized_pnl\":{0},", pnl.ToString("F2", CultureInfo.InvariantCulture));
                // NOTE: sl_price/tp_price are NEVER written here.
                // They are managed exclusively by direct PATCHes in:
                //   OnOrderUpdate (set), ExecuteModifySl/Tp (update),
                //   ExecuteClose/exit fill (clear).
                // Writing them here causes async race conditions.
                sb.AppendFormat("\"trail_enabled\":{0},", _activeTrailEnabled ? "true" : "false");
                sb.AppendFormat("\"updated_at\":\"{0:yyyy-MM-ddTHH:mm:ss}\"", DateTime.Now);
                sb.Append("}");

                // Use PATCH to update the existing row (POST upsert was unreliable)
                HttpPatch(LIVE_STATE_EP,
                    "instrument=eq." + System.Uri.EscapeDataString(_instrumentName) +
                    "&account=eq." + System.Uri.EscapeDataString(accountName),
                    sb.ToString());

                // Also broadcast via WebSocket with full state including brackets
                WsBroadcast(BuildStateJson(dir, qty, entryPrice,
                    double.TryParse(pnl.ToString("F2", CultureInfo.InvariantCulture), out double pnlVal) ? pnlVal : 0,
                    accountName));
            }
            catch (Exception ex) { Log("LiveBridge: UpsertLiveState error — " + ex.Message); }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // CLEANUP
        // ═══════════════════════════════════════════════════════════════════════

        private static void CleanupOldBars()
        {
            try
            {
                string cutoff = DateTime.Now.AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ss");
                HttpDelete(LIVE_BARS_EP, "bar_time=lt." + cutoff);
            }
            catch { }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // WEBSOCKET SERVER — Low-latency direct connection from browser.
        // Runs an HttpListener on port 8765, accepts WebSocket upgrades,
        // broadcasts ticks/bars/state, receives orders/commands.
        // Runs alongside Supabase HTTP (which remains for persistence).
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>Start the WebSocket server on WS_PORT.</summary>
        private static void StartWebSocketServer()
        {
            StopWebSocketServer();
            _wsCts = new CancellationTokenSource();
            try
            {
                _wsListener = new HttpListener();
                _wsListener.Prefixes.Add("http://+:" + WS_PORT + "/");
                _wsListener.Start();
                Log("LiveBridge: WebSocket server started on port " + WS_PORT);
                // Publish bound IPv4 candidates so the dashboard's "Discover"
                // button can find this VM regardless of host network changes.
                PublishLivebridgeEndpoint();
                Task.Run(() => WsAcceptLoop(_wsCts.Token));
                Task.Run(() => WsSendLoop(_wsCts.Token));
            }
            catch (Exception ex)
            {
                Log("LiveBridge: WebSocket server failed to start — " + ex.Message +
                    " (try: netsh http add urlacl url=http://+:" + WS_PORT + "/ user=Everyone)");
            }
        }

        /// <summary>
        /// Enumerate non-loopback IPv4 addresses on every UP interface and publish
        /// them as a candidate list to Supabase. The frontend "Discover" button reads
        /// this row and races a WS probe against each entry to pick a reachable URL.
        /// We publish ALL candidates instead of guessing the "right" adapter because
        /// Parallels guests typically have 2-3 interfaces (Shared / Host-Only / Bridged)
        /// and only the host can actually tell which one routes back to itself.
        /// </summary>
        private static void PublishLivebridgeEndpoint()
        {
            try
            {
                var ips = new List<string>();
                foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (nic.OperationalStatus != OperationalStatus.Up) continue;
                    if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (var addr in nic.GetIPProperties().UnicastAddresses)
                    {
                        if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        var ip = addr.Address.ToString();
                        // Skip APIPA / link-local — never routable from the host
                        if (ip.StartsWith("169.254.")) continue;
                        ips.Add("ws://" + ip + ":" + WS_PORT);
                    }
                }
                if (ips.Count == 0)
                {
                    Log("LiveBridge: PublishLivebridgeEndpoint — no IPv4 addresses found");
                    return;
                }

                // Build candidate JSON array. Single quotes inside escaped strings —
                // simple manual serialization since the rest of this file does the same.
                var sb = new StringBuilder();
                sb.Append("{\"id\":\"default\",\"candidates\":[");
                for (int i = 0; i < ips.Count; i++)
                {
                    if (i > 0) sb.Append(",");
                    sb.Append("\"").Append(ips[i]).Append("\"");
                }
                sb.Append("],\"port\":").Append(WS_PORT)
                  .Append(",\"updated_at\":\"").Append(DateTime.UtcNow.ToString("o")).Append("\"}");

                // Supabase upsert: merge-duplicates makes POST act as INSERT-or-UPDATE
                // on the primary key. Reuses existing HttpPost helper (custom prefer arg).
                HttpPost(LIVEBRIDGE_ENDPOINT_EP, sb.ToString(),
                    "resolution=merge-duplicates,return=minimal");
                Log("LiveBridge: Published endpoint candidates — " + string.Join(", ", ips.ToArray()));
            }
            catch (Exception ex)
            {
                Log("LiveBridge: PublishLivebridgeEndpoint error — " + ex.Message);
            }
        }

        /// <summary>Stop the WebSocket server and disconnect all clients.</summary>
        private static void StopWebSocketServer()
        {
            if (_wsCts != null) { _wsCts.Cancel(); _wsCts = null; }
            // Drain stale messages from queue so next startup is clean
            while (_wsSendQueue.TryDequeue(out _)) { }
            lock (_wsLock)
            {
                foreach (var ws in _wsClients)
                {
                    try { ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "shutdown", CancellationToken.None).Wait(1000); } catch { }
                    try { ws.Dispose(); } catch { }
                }
                _wsClients.Clear();
            }
            if (_wsListener != null)
            {
                try { _wsListener.Stop(); } catch { }
                try { _wsListener.Close(); } catch { }
                _wsListener = null;
            }
        }

        /// <summary>Accept loop — waits for HTTP connections and upgrades to WebSocket.</summary>
        private static async Task WsAcceptLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && _wsListener != null && _wsListener.IsListening)
            {
                try
                {
                    var context = await _wsListener.GetContextAsync();
                    if (context.Request.IsWebSocketRequest)
                    {
                        var wsContext = await context.AcceptWebSocketAsync(null);
                        var ws = wsContext.WebSocket;
                        lock (_wsLock) { _wsClients.Add(ws); }
                        Log("LiveBridge: WebSocket client connected (" + _wsClients.Count + " total)");
                        WsSendAccounts(ws);
                        // Send current instrument/timeframe config so frontend can sync its selectors
                        WsSend(ws, "{\"type\":\"config\",\"instrument\":\"" + Esc(_instrumentName) +
                            "\",\"timeframe\":\"" + Esc(_timeframeName) + "\"}");
                        _ = Task.Run(() => WsReceiveLoop(ws, ct));
                    }
                    else
                    {
                        context.Response.StatusCode = 400;
                        context.Response.Close();
                    }
                }
                catch (ObjectDisposedException) { break; }
                catch (HttpListenerException) { break; }
                catch (Exception ex)
                {
                    if (!ct.IsCancellationRequested)
                        Log("LiveBridge: WsAcceptLoop error — " + ex.Message);
                }
            }
        }

        /// <summary>
        /// Receive loop for a single WebSocket client. Parses incoming JSON
        /// for orders and commands, executes them directly (bypassing Supabase
        /// polling for minimum latency).
        /// </summary>
        private static async Task WsReceiveLoop(WebSocket ws, CancellationToken ct)
        {
            var buffer = new byte[4096];
            try
            {
                while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        string msg = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        WsHandleMessage(ws, msg);
                    }
                }
            }
            catch (WebSocketException) { }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log("LiveBridge: WsReceiveLoop error — " + ex.Message); }
            finally
            {
                lock (_wsLock) { _wsClients.Remove(ws); }
                try { ws.Dispose(); } catch { }
                Log("LiveBridge: WebSocket client disconnected (" + _wsClients.Count + " remaining)");
            }
        }

        /// <summary>
        /// Handle an inbound WebSocket message. Supports:
        ///   { "type": "order", "action": "buy_long", "account": "Sim101", ... }
        ///   { "type": "command", "command": "reseed_bars" }
        /// </summary>
        private static void WsHandleMessage(WebSocket ws, string json)
        {
            try
            {
                string msgType = ParseStr(json, "type");
                if (msgType == null) return;

                if (msgType == "order")
                {
                    string action = ParseStr(json, "action");
                    string accountName = ParseStr(json, "account");
                    if (action == null) return;

                    Account account = ResolveAccount(accountName);
                    if (account == null)
                    {
                        WsSend(ws, "{\"type\":\"order_update\",\"status\":\"error\",\"error\":\"Account not found\"}");
                        return;
                    }

                    _activeAccount = account;
                    double slPts = ParseDouble(json, "sl_points");
                    double tpPts = ParseDouble(json, "tp_points");
                    bool trail = json.Contains("\"trail_enabled\":true");
                    double newSlPrice = ParseDouble(json, "new_sl_price");
                    double newTpPrice = ParseDouble(json, "new_tp_price");
                    // Same fallback as the Supabase path — older WS clients
                    // that don't include quantity get the legacy 1-contract default.
                    long parsedWsQty = ParseLong(json, "quantity");
                    int wsQty = parsedWsQty > 0 ? (int)parsedWsQty : 1;

                    Log("LiveBridge: WS order — " + action + " on " + accountName + " qty=" + wsQty);

                    // Use negative ID to distinguish from Supabase-sourced orders
                    long wsId = -DateTime.Now.Ticks;

                    switch (action)
                    {
                        case "buy_long": ExecuteEntry(wsId, true, slPts, tpPts, trail, wsQty); break;
                        case "sell_short": ExecuteEntry(wsId, false, slPts, tpPts, trail, wsQty); break;
                        case "close": ExecuteClose(wsId); break;
                        case "modify_sl": ExecuteModifySl(wsId, newSlPrice); break;
                        case "modify_tp": ExecuteModifyTp(wsId, newTpPrice); break;
                        default:
                            WsSend(ws, "{\"type\":\"order_update\",\"status\":\"error\",\"error\":\"Unknown action\"}");
                            return;
                    }
                    WsSend(ws, "{\"type\":\"order_update\",\"status\":\"processing\",\"action\":\"" + Esc(action) + "\"}");
                }
                else if (msgType == "command")
                {
                    string command = ParseStr(json, "command");
                    if (command == "reseed_bars")
                    {
                        if (_streamer != null) { _streamer.Dispose(); _streamer = null; }
                        _streamer = new BarStreamer(_instrument, _instrumentName, _timeframeName, OnBarCompleted, OnTickFromBars);
                        WsSend(ws, "{\"type\":\"command_update\",\"command\":\"reseed_bars\",\"status\":\"completed\"}");
                        Log("LiveBridge: WS command — reseeded bars");
                    }
                    else if (command == "switch_instrument")
                    {
                        // Switch the active instrument and/or timeframe, then recreate the bar streamer
                        string newInstrument = ParseStr(json, "instrument");
                        string newTimeframe = ParseStr(json, "timeframe");

                        if (string.IsNullOrEmpty(newInstrument) || string.IsNullOrEmpty(newTimeframe))
                        {
                            WsSend(ws, "{\"type\":\"command_update\",\"command\":\"switch_instrument\",\"status\":\"error\",\"error\":\"Missing instrument or timeframe\"}");
                            return;
                        }

                        // Resolve the new instrument in NinjaTrader
                        var newInst = Instrument.GetInstrument(newInstrument, false);
                        if (newInst == null)
                        {
                            WsSend(ws, "{\"type\":\"command_update\",\"command\":\"switch_instrument\",\"status\":\"error\",\"error\":\"Instrument not found: " + Esc(newInstrument) + "\"}");
                            return;
                        }

                        // Update mutable statics to new config.
                        // Use NT8's canonical FullName as source of truth — see comment
                        // in the cold-start activation path. TradeTracker writes
                        // Instrument.FullName into the trades table, and live_state /
                        // live_bars / live_ticker must use the same key for the dashboard
                        // to find them. The frontend will pick up the canonical name from
                        // the command_update broadcast below and re-subscribe its filters.
                        if (!string.Equals(newInstrument, newInst.FullName, StringComparison.Ordinal))
                        {
                            Log("LiveBridge: Resolved switch_instrument '" + newInstrument + "' → canonical '" + newInst.FullName + "'");
                        }
                        _instrumentName = newInst.FullName;
                        _timeframeName = newTimeframe;
                        _instrument = newInst;

                        // Dispose old streamer and create new one with updated config
                        if (_streamer != null) { _streamer.Dispose(); _streamer = null; }
                        _streamer = new BarStreamer(_instrument, _instrumentName, _timeframeName, OnBarCompleted, OnTickFromBars);

                        // Broadcast the new config to all connected clients
                        WsBroadcast("{\"type\":\"command_update\",\"command\":\"switch_instrument\",\"status\":\"completed\"," +
                            "\"instrument\":\"" + Esc(_instrumentName) + "\",\"timeframe\":\"" + Esc(_timeframeName) + "\"}");
                        Log("LiveBridge: Switched to " + _instrumentName + " / " + _timeframeName);
                    }
                }
            }
            catch (Exception ex) { Log("LiveBridge: WsHandleMessage error — " + ex.Message); }
        }

        /// <summary>
        /// Enqueue a message for broadcast to all connected clients.
        /// Non-blocking, safe to call from any thread (market data, order events, etc.).
        /// The dedicated WsSendLoop drains this queue and sends sequentially to
        /// prevent concurrent SendAsync calls which corrupt WebSocket state.
        /// </summary>
        private static void WsBroadcast(string json)
        {
            _wsSendQueue.Enqueue(json);
        }

        /// <summary>
        /// Send a message to a single client. Routes through the broadcast queue
        /// to maintain send serialization (concurrent SendAsync is not safe).
        /// </summary>
        private static void WsSend(WebSocket ws, string json)
        {
            _wsSendQueue.Enqueue(json);
        }

        // ─── Debug counters for WS send loop (logged every 5 seconds) ───
        private static int _wsSendTickCount;
        private static int _wsSendReliableCount;
        private static int _wsSendDroppedTicks;
        private static DateTime _wsLastLogTime = DateTime.MinValue;

        /// <summary>
        /// Dedicated send loop — drains the queue and sends to all clients
        /// sequentially with await. Coalesces tick messages (only the latest
        /// tick matters) while never dropping bars, state, or order updates.
        /// </summary>
        private static async Task WsSendLoop(CancellationToken ct)
        {
            Log("LiveBridge: WsSendLoop started");
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    // Drain all pending messages, coalescing ticks
                    string latestTick = null;
                    List<string> reliable = null;
                    int ticksThisDrain = 0;

                    while (_wsSendQueue.TryDequeue(out string msg))
                    {
                        // Tick messages: {"type":"tick",... — char at index 9 is 't'
                        if (msg.Length > 10 && msg[9] == 't')
                        {
                            if (latestTick != null) ticksThisDrain++;
                            latestTick = msg;
                        }
                        else
                        {
                            if (reliable == null) reliable = new List<string>();
                            reliable.Add(msg);
                        }
                    }

                    // Nothing to send — sleep 1ms and retry
                    if (latestTick == null && reliable == null)
                    {
                        try { await Task.Delay(1, ct); } catch { break; }
                        continue;
                    }

                    List<WebSocket> snapshot;
                    lock (_wsLock) { snapshot = new List<WebSocket>(_wsClients); }

                    // No clients connected — skip stats accumulation/logging entirely
                    // so the Output window stays quiet while a strategy is being tested.
                    // Counters are reset so they don't carry stale values into the next session.
                    if (snapshot.Count == 0)
                    {
                        _wsSendTickCount = 0;
                        _wsSendReliableCount = 0;
                        _wsSendDroppedTicks = 0;
                        _wsLastLogTime = DateTime.Now;
                        continue;
                    }

                    _wsSendDroppedTicks += ticksThisDrain;
                    if (latestTick != null) _wsSendTickCount++;
                    if (reliable != null) _wsSendReliableCount += reliable.Count;

                    // Log stats every 5 seconds — only fires while clients are attached
                    if ((DateTime.Now - _wsLastLogTime).TotalSeconds >= 5)
                    {
                        _wsLastLogTime = DateTime.Now;
                        Log(string.Format(
                            "LiveBridge WS: {0} clients, sent {1} ticks + {2} reliable, coalesced {3} stale ticks",
                            snapshot.Count, _wsSendTickCount, _wsSendReliableCount, _wsSendDroppedTicks));
                        _wsSendTickCount = 0;
                        _wsSendReliableCount = 0;
                        _wsSendDroppedTicks = 0;
                    }

                    // Send reliable messages first (bars, state, order updates — never drop)
                    if (reliable != null)
                        foreach (var msg in reliable)
                            await WsSendToAll(snapshot, msg, ct);

                    // Send only the latest tick (coalesced — earlier ticks are stale)
                    if (latestTick != null)
                        await WsSendToAll(snapshot, latestTick, ct);
                }
            }
            catch (Exception ex)
            {
                Log("LiveBridge: WsSendLoop CRASHED — " + ex.GetType().Name + ": " + ex.Message);
            }
            Log("LiveBridge: WsSendLoop exited");
        }

        /// <summary>
        /// Send a single message to all connected clients, awaiting each send
        /// to prevent concurrent SendAsync. Removes dead clients.
        /// </summary>
        private static async Task WsSendToAll(List<WebSocket> clients, string json, CancellationToken ct)
        {
            byte[] data = Encoding.UTF8.GetBytes(json);
            var segment = new ArraySegment<byte>(data);
            for (int i = clients.Count - 1; i >= 0; i--)
            {
                var ws = clients[i];
                if (ws.State != WebSocketState.Open)
                {
                    Log("LiveBridge: WsSendToAll — removing dead client (state=" + ws.State + ")");
                    clients.RemoveAt(i);
                    continue;
                }
                try { await ws.SendAsync(segment, WebSocketMessageType.Text, true, ct); }
                catch (Exception ex)
                {
                    Log("LiveBridge: WsSendToAll — send failed: " + ex.GetType().Name + ": " + ex.Message + " (state=" + ws.State + ")");
                    clients.RemoveAt(i);
                    lock (_wsLock) { _wsClients.Remove(ws); }
                    try { ws.Dispose(); } catch { }
                }
            }
        }

        /// <summary>Send the account list to a newly connected client.</summary>
        private static void WsSendAccounts(WebSocket ws)
        {
            try
            {
                var sb = new StringBuilder();
                sb.Append("{\"type\":\"accounts\",\"accounts\":[");
                bool first = true;
                foreach (Account acct in Account.All)
                {
                    if (!first) sb.Append(",");
                    sb.AppendFormat("\"{0}\"", Esc(acct.Name));
                    first = false;
                }
                sb.Append("]}");
                WsSend(ws, sb.ToString());
            }
            catch (Exception ex) { Log("LiveBridge: WsSendAccounts error — " + ex.Message); }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // COMMAND POLLING — web inserts commands into live_commands table,
        // LiveBridge polls and executes them (e.g., reseed_bars to repopulate
        // historical bar data after a data cleanup).
        // ═══════════════════════════════════════════════════════════════════════

        /// <summary>
        /// Poll live_commands for pending commands from the web UI.
        /// Currently supports "reseed_bars" which disposes the current BarStreamer
        /// and creates a new one — the new streamer automatically posts 100 warmup bars.
        /// </summary>
        private static void PollForCommands()
        {
            try
            {
                string json = HttpGet(LIVE_COMMANDS_EP,
                    "status=eq.pending&order=created_at.asc&limit=1&select=id,command");
                if (string.IsNullOrEmpty(json) || json.Trim() == "[]") return;

                long cmdId = ParseLong(json, "id");
                string command = ParseStr(json, "command");
                if (cmdId <= 0 || command == null) return;

                Log("LiveBridge: Processing command #" + cmdId + " — " + command);

                // Mark as processing
                HttpPatch(LIVE_COMMANDS_EP, "id=eq." + cmdId,
                    "{\"status\":\"processing\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");

                switch (command)
                {
                    case "reseed_bars":
                        // Dispose current streamer and create a fresh one — the new
                        // BarStreamer constructor automatically fetches 1000 bars and
                        // posts the last 1000 as warmup to Supabase.
                        if (_streamer != null) { _streamer.Dispose(); _streamer = null; }
                        _streamer = new BarStreamer(_instrument, _instrumentName, _timeframeName, OnBarCompleted, OnTickFromBars);
                        Log("LiveBridge: Reseeded bars — new BarStreamer created");
                        break;

                    default:
                        Log("LiveBridge: Unknown command — " + command);
                        break;
                }

                // Mark as completed
                HttpPatch(LIVE_COMMANDS_EP, "id=eq." + cmdId,
                    "{\"status\":\"completed\",\"updated_at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
            }
            catch (Exception ex)
            {
                Log("LiveBridge: PollForCommands error — " + ex.Message);
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // HTTP HELPERS
        // ═══════════════════════════════════════════════════════════════════════

        private static void HttpPost(string endpoint, string json, string prefer = "return=minimal")
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint);
            req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 5000;
            req.Headers.Add("apikey", SUPABASE_ANON_KEY);
            req.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            req.Headers.Add("Prefer", prefer);
            byte[] body = Encoding.UTF8.GetBytes(json);
            req.ContentLength = body.Length;
            using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
            using (var resp = (HttpWebResponse)req.GetResponse()) { }
        }

        private static string HttpGet(string endpoint, string query)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint + "?" + query);
            req.Method = "GET"; req.ContentType = "application/json"; req.Timeout = 5000;
            req.Headers.Add("apikey", SUPABASE_ANON_KEY);
            req.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            try
            {
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream()))
                    return reader.ReadToEnd();
            }
            catch { return null; }
        }

        private static void HttpPatch(string endpoint, string query, string json)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint + "?" + query);
            req.Method = "PATCH"; req.ContentType = "application/json"; req.Timeout = 5000;
            req.Headers.Add("apikey", SUPABASE_ANON_KEY);
            req.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            req.Headers.Add("Prefer", "return=minimal");
            byte[] body = Encoding.UTF8.GetBytes(json);
            req.ContentLength = body.Length;
            using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
            try { using (var resp = (HttpWebResponse)req.GetResponse()) { } } catch { }
        }

        private static void HttpDelete(string endpoint, string query)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint + "?" + query);
            req.Method = "DELETE"; req.Timeout = 5000;
            req.Headers.Add("apikey", SUPABASE_ANON_KEY);
            req.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            try { using (var resp = (HttpWebResponse)req.GetResponse()) { } } catch { }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // JSON PARSING + HELPERS
        // ═══════════════════════════════════════════════════════════════════════

        private static string ParseStr(string json, string field)
        {
            string key = "\"" + field + "\":\"";
            int idx = json.IndexOf(key); if (idx < 0) return null;
            int start = idx + key.Length;
            int end = json.IndexOf("\"", start); if (end < 0) return null;
            return json.Substring(start, end - start);
        }

        private static long ParseLong(string json, string field)
        {
            string key = "\"" + field + "\":";
            int idx = json.IndexOf(key); if (idx < 0) return -1;
            int start = idx + key.Length;
            while (start < json.Length && json[start] == ' ') start++;
            int end = start;
            while (end < json.Length && char.IsDigit(json[end])) end++;
            if (end == start) return -1;
            return long.Parse(json.Substring(start, end - start));
        }

        private static double ParseDouble(string json, string field)
        {
            string key = "\"" + field + "\":";
            int idx = json.IndexOf(key); if (idx < 0) return 0;
            int start = idx + key.Length;
            while (start < json.Length && json[start] == ' ') start++;
            if (start < json.Length && json[start] == 'n') return 0;
            int end = start;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '.' || json[end] == '-')) end++;
            if (end == start) return 0;
            double.TryParse(json.Substring(start, end - start), NumberStyles.Float, CultureInfo.InvariantCulture, out double val);
            return val;
        }

        private static void PatchOrderError(long reqId, string error)
        {
            Log("LiveBridge: Order #" + reqId + " error — " + error);
            // Skip Supabase patch for WebSocket-sourced orders (negative IDs)
            if (reqId < 0) return;
            HttpPatch(ORDER_REQUESTS_EP, "id=eq." + reqId,
                string.Format("{{\"status\":\"error\",\"error_message\":\"{0}\",\"updated_at\":\"{1}\"}}",
                    Esc(error), DateTime.UtcNow.ToString("o")));
        }

        private static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\n", "\\n").Replace("\r", "\\r");
        }

        private static void Log(string msg)
        {
            NinjaTrader.Code.Output.Process(msg, PrintTo.OutputTab1);
        }
    }
}
