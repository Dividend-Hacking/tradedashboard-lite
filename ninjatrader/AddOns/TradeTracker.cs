#region Using declarations
using System;
using System.Collections.Generic;
using System.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// TradeTracker — NinjaTrader 8 AddOn for automatic trade tagging and analysis.
    ///
    /// Runs in the background with no UI. Listens to ALL account executions (sim, playback,
    /// live) and logs every completed trade with full market context to daily JSON files.
    ///
    /// Architecture:
    /// - Subscribes to Account.ExecutionUpdate + Account.PositionUpdate for all accounts
    /// - ExecutionUpdate is the PRIMARY lifecycle driver — classifies entry vs exit by
    ///   comparing execution direction to open trade direction (immune to interleaving)
    /// - PositionUpdate is a SAFETY NET — only acts if ExecutionUpdate missed the transition
    ///   (guarded by _openTrades.ContainsKey checks to prevent double-processing)
    /// - MarketContextTagger provides indicator snapshots at entry time
    /// - TradeJsonWriter persists completed trades to daily JSON files
    ///
    /// Trade lifecycle:
    /// 1. ExecutionUpdate: no open trade + fill → HandleTradeEntry (snapshot context, create state)
    /// 2. MarketDataUpdate: tick-by-tick MFE/MAE tracking while trade is open
    /// 3. ExecutionUpdate: open trade + opposite direction fill → HandleTradeExit (log + cleanup)
    ///
    /// Stop loss detection:
    /// - Listens to Account.OrderUpdate for stop orders on the instrument
    /// - Falls back to ATR(14) * 1.2 estimate if no stop order detected
    ///
    /// Output: {UserDataDir}/TradeTracker/trades_YYYY-MM-DD.json
    ///
    /// Known limitation: if two strategies trade the same instrument on the same account
    /// simultaneously, they log as one combined trade. Use separate sim accounts per strategy.
    /// </summary>
    public class TradeTracker : AddOnBase
    {
        // ─── Configurable Defaults ─────────────────────────────────────────────

        /// <summary>
        /// Multiplier for ATR-based stop estimate when no actual stop order is detected.
        /// Default 1.2 means estimated stop = entry +/- ATR(14) * 1.2
        /// </summary>
        private const double STOP_ESTIMATE_ATR_MULT = 1.2;

        /// <summary>
        /// NQ point value in dollars (each point = $20 for full NQ, $2 for MNQ).
        /// Used for PnlDollars calculation. Defaults to MNQ ($2/point).
        /// For full NQ, this should be $20 — but PnlPoints is always accurate
        /// regardless, and the JSON consumer can recalculate dollars.
        /// </summary>
        private const double DEFAULT_POINT_VALUE = 20.0;

        // ─── State ─────────────────────────────────────────────────────────────

        /// <summary>JSON file writer (thread-safe, one instance for the AddOn lifetime)</summary>
        private TradeJsonWriter _writer;

        /// <summary>Supabase REST writer — POSTs trades to cloud DB in the background (fire-and-forget)</summary>
        private SupabaseWriter _supabaseWriter;

        /// <summary>
        /// Market context taggers keyed by instrument full name.
        /// One tagger per instrument, created on first trade for that instrument.
        /// </summary>
        private Dictionary<string, MarketContextTagger> _taggers;

        /// <summary>
        /// Open trades keyed by "AccountName|InstrumentFullName".
        /// A trade is "open" from position entry to position flat.
        /// Using account+instrument as key (not direction) because an account can only
        /// hold one position direction per instrument at a time.
        /// </summary>
        private Dictionary<string, OpenTradeState> _openTrades;

        /// <summary>
        /// Post-exit trades being monitored for 20 minutes after close.
        /// Keyed by "AccountName|InstrumentFullName|EntryTime" to allow multiple
        /// sequential trades on the same instrument to be tracked independently.
        /// After 20 minutes, post-exit MFE/MAE is PATCHed to Supabase and the entry is removed.
        /// </summary>
        private Dictionary<string, PostExitTrackingState> _postExitTrades;

        /// <summary>
        /// List of accounts we've subscribed to, for cleanup on termination.
        /// </summary>
        private List<Account> _subscribedAccounts;

        /// <summary>
        /// Tracks the last known position state per account+instrument.
        /// Used to detect entry/exit transitions in PositionUpdate.
        /// Key: "AccountName|InstrumentFullName", Value: MarketPosition enum
        /// </summary>
        private Dictionary<string, MarketPosition> _lastPositionState;

        /// <summary>
        /// Execution queue per account+instrument. All execution fills are enqueued here
        /// regardless of entry/exit — PositionUpdate-driven handlers dequeue the correct
        /// fill when processing trade entries and exits.
        ///
        /// This solves the event interleaving problem in Strategy Analyzer where back-to-back
        /// trades fire multiple ExecutionUpdates before PositionUpdates, making state-based
        /// entry/exit classification impossible.
        ///
        /// Key: "AccountName|InstrumentFullName", Value: FIFO queue of execution fills
        /// </summary>
        private Dictionary<string, Queue<ExecutionInfo>> _executionQueues;

        /// <summary>
        /// Safety cap on execution queue size per key.
        /// Prevents unbounded memory growth if PositionUpdates stop arriving.
        /// </summary>
        private const int MAX_QUEUE_SIZE = 20;

        /// <summary>
        /// Tracks the most recent execution timestamp per instrument.
        /// Used as a playback-safe alternative to DateTime.Now — in Playback mode,
        /// DateTime.Now returns real wall-clock time while execution fills carry
        /// historical timestamps, causing corrupted trade records. This dictionary
        /// always reflects the most recent fill time, which is correct in both
        /// live trading and Playback mode.
        /// </summary>
        private Dictionary<string, DateTime> _lastKnownTime;

        /// <summary>
        /// Tracks when a trade was most recently closed for each key.
        /// Used as a cooldown in OnPositionUpdate to suppress stale shell creation
        /// when a close + reentry happens on the same tick. If OnPositionUpdate fires
        /// within 2 seconds of an exit, entry creation is suppressed because the
        /// position data may be stale (reflecting the old direction).
        /// </summary>
        private Dictionary<string, DateTime> _recentExitTime;

        /// <summary>
        /// Buffers stop prices that arrive via OnOrderUpdate BEFORE the entry fill
        /// creates the OpenTradeState in _openTrades. Without this buffer, winners
        /// lose their actual stop price because the stop order goes Accepted/Working
        /// before HandleTradeEntry runs, and winners' stops just get cancelled (TP hit
        /// first) — no second chance to capture the price. Losers are unaffected because
        /// their stop order transitions again on fill.
        /// Keyed by "accountName|instrumentFullName".
        /// </summary>
        private Dictionary<string, double> _pendingStopPrices;

        /// <summary>
        /// Buffers take-profit limit prices that arrive via OnOrderUpdate BEFORE the
        /// entry fill creates the OpenTradeState. Same race condition as stops — the
        /// OCO bracket's Limit order can go Accepted/Working before HandleTradeEntry runs.
        /// Keyed by "accountName|instrumentFullName".
        /// </summary>
        private Dictionary<string, double> _pendingTpPrices;

        /// <summary>
        /// Buffers RiskManager entry args from the bridge event (fires during OrderUpdate)
        /// until OnPositionUpdate provides a resolved Instrument reference.
        /// Null value = placeholder from ExecutionUpdate; non-null = real bridge args.
        /// Keyed by "accountName|instrumentFullName".
        /// </summary>
        private Dictionary<string, RiskMgrEntryFillArgs> _pendingRiskMgrEntry;

        // ─── Bar Ring Buffer ────────────────────────────────────────────────────
        // Per-instrument buffer of recently completed bars, fed by LiveBridge.BarCompletedEvent.
        // On trade exit we slice out a window (25 pre-entry bars through exit bar) and POST to
        // trade_bars so the frontend can show a mini-chart of what the trade looked like.

        private const int BAR_BUFFER_CAPACITY = 300;
        private const int BARS_BEFORE_ENTRY = 25;

        private class BufferedBar
        {
            public DateTime Time;
            public double Open;
            public double High;
            public double Low;
            public double Close;
            public long Volume;
        }

        /// <summary>
        /// Ring buffer of completed bars keyed by instrument full name. Populated on every
        /// LiveBridge.BarCompletedEvent (warmup + real-time). Trimmed to BAR_BUFFER_CAPACITY.
        /// Access is protected by _barBufferLock because the event fires on whichever thread
        /// NT8's BarsRequest.Update runs on, which may differ from the trade-processing thread.
        /// </summary>
        private Dictionary<string, List<BufferedBar>> _barBuffers;
        private readonly object _barBufferLock = new object();


        //─── AddOnBase Lifecycle ───────────────────────────────────────────────

        /// <summary>
        /// NinjaTrader calls OnStateChange as the AddOn moves through its lifecycle.
        /// We hook into SetDefaults (metadata), Active (start), and Terminated (cleanup).
        /// </summary>
        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    // Metadata shown in the NinjaTrader AddOn manager
                    Name = "TradeTracker";
                    Description = "Automatic trade tagging and analysis — logs all trades with market context to JSON";
                    break;

                case State.Active:
                    // Initialize all state
                    _writer = new TradeJsonWriter();
                    _supabaseWriter = new SupabaseWriter();
                    _taggers = new Dictionary<string, MarketContextTagger>();
                    _openTrades = new Dictionary<string, OpenTradeState>();
                    _postExitTrades = new Dictionary<string, PostExitTrackingState>();
                    _subscribedAccounts = new List<Account>();
                    _lastPositionState = new Dictionary<string, MarketPosition>();
                    _executionQueues = new Dictionary<string, Queue<ExecutionInfo>>();
                    _lastKnownTime = new Dictionary<string, DateTime>();
                    _recentExitTime = new Dictionary<string, DateTime>();
                    _pendingStopPrices = new Dictionary<string, double>();
                    _pendingTpPrices = new Dictionary<string, double>();
                    _pendingRiskMgrEntry = new Dictionary<string, RiskMgrEntryFillArgs>();
                    _barBuffers = new Dictionary<string, List<BufferedBar>>();

                    // Subscribe to LiveBridge's completed-bar event so we can build a
                    // per-instrument buffer and capture the window around each trade.
                    LiveBridge.BarCompletedEvent += OnLiveBridgeBarCompleted;

                    // Subscribe to all existing accounts
                    foreach (Account account in Account.All)
                    {
                        SubscribeToAccount(account);
                    }

                    // Listen for new accounts (e.g., sim accounts created during session)
                    Account.AccountStatusUpdate += OnAccountStatusUpdate;

                    // Subscribe to RiskManager bridge events for direct trade reporting.
                    // This prevents double-counting: RiskManager reports trades with exact
                    // SL/TP/RU data, and the signal filter in OnExecutionUpdate skips
                    // "RiskMgr" executions so they don't create phantom entries.
                    RiskManagerBridge.OnTradeEntry += OnRiskManagerEntry;
                    RiskManagerBridge.OnTradeExit += OnRiskManagerExit;

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Active — monitoring {0} account(s)", _subscribedAccounts.Count),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    break;

                case State.Terminated:
                    // Clean up all subscriptions and resources
                    Cleanup();
                    break;
            }
        }

        // ─── Account Subscription ──────────────────────────────────────────────

        /// <summary>
        /// Subscribes to execution, position, and order updates for an account.
        /// Called for each existing account on startup and for new accounts that appear.
        /// </summary>
        /// <param name="account">The account to monitor</param>
        private void SubscribeToAccount(Account account)
        {
            if (account == null || _subscribedAccounts.Contains(account))
                return;

            account.ExecutionUpdate += OnExecutionUpdate;
            account.PositionUpdate += OnPositionUpdate;
            account.OrderUpdate += OnOrderUpdate;
            _subscribedAccounts.Add(account);
        }

        /// <summary>
        /// Handles new accounts appearing (e.g., sim account created mid-session).
        /// Subscribes to the new account if we haven't already.
        /// </summary>
        private void OnAccountStatusUpdate(object sender, AccountStatusEventArgs e)
        {
            if (e.Status == ConnectionStatus.Connected)
            {
                Account account = e.Account;
                if (!_subscribedAccounts.Contains(account))
                {
                    SubscribeToAccount(account);
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Subscribed to new account {0}", account.Name),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
        }

        // ─── Position Update — Trade Entry/Exit Detection ──────────────────────

        /// <summary>
        /// SAFETY NET — only acts if OnExecutionUpdate hasn't already handled the transition.
        ///
        /// OnExecutionUpdate is now the primary lifecycle driver. It syncs _lastPositionState
        /// after each entry/exit, so when OnPositionUpdate fires afterward, _lastPositionState
        /// already matches currentPosition and no transition is detected.
        ///
        /// If OnExecutionUpdate didn't fire (rare edge case), this still catches the transition.
        /// Guards on _openTrades.ContainsKey prevent double-processing even if both handlers
        /// detect the same transition.
        ///
        /// State machine:
        /// - Flat → Long/Short: new trade entry (only if no open trade already exists)
        /// - Long/Short → Flat: trade exit (only if an open trade exists)
        /// - Long → Short (or vice versa): exit + entry with the same guards
        /// </summary>
        private void OnPositionUpdate(object sender, PositionEventArgs e)
        {
            try
            {
                Account account = e.Position.Account;
                string instrumentName = e.Position.Instrument.FullName;
                string key = string.Format("{0}|{1}", account.Name, instrumentName);

                MarketPosition currentPosition = e.Position.MarketPosition;
                MarketPosition previousPosition;

                // Get the previous position state (default to Flat if first observation)
                if (!_lastPositionState.TryGetValue(key, out previousPosition))
                    previousPosition = MarketPosition.Flat;

                // Update tracked state
                _lastPositionState[key] = currentPosition;

                // ── Layer 3: Recent-exit cooldown ──────────────────────────────────
                // When OnExecutionUpdate closes a trade and a new entry arrives on the
                // same tick, OnPositionUpdate can fire with STALE position data (showing
                // the old direction). Suppress entry creation for 2 seconds after an exit
                // to let OnExecutionUpdate handle the new entry with correct fill data.
                bool recentExitCooldown = false;
                DateTime lastExit;
                if (_recentExitTime.TryGetValue(key, out lastExit))
                {
                    DateTime currentTime = GetCurrentTime(instrumentName);
                    if ((currentTime - lastExit).TotalSeconds < 2.0)
                        recentExitCooldown = true;
                }

                // ── Handle transitions (with guards to prevent double-processing) ──

                // Case 1: Exit detected (was in a position, now flat)
                // Guard: only process if OnExecutionUpdate hasn't already removed the trade
                if (previousPosition != MarketPosition.Flat && currentPosition == MarketPosition.Flat)
                {
                    if (_openTrades.ContainsKey(key))
                        HandleTradeExit(account, e.Position.Instrument, key);
                }

                // Case 2: Reversal detected (long→short or short→long)
                // Guard exit: only if open trade still exists
                // Guard entry: check for buffered RiskManager entry, then fall back to HandleTradeEntry
                // Cooldown guard: suppress entry if a recent exit happened (stale position data)
                if (previousPosition != MarketPosition.Flat && currentPosition != MarketPosition.Flat
                    && previousPosition != currentPosition)
                {
                    if (_openTrades.ContainsKey(key))
                        HandleTradeExit(account, e.Position.Instrument, key);

                    RiskMgrEntryFillArgs rmArgsRev;
                    if (_pendingRiskMgrEntry.TryGetValue(key, out rmArgsRev) && rmArgsRev != null)
                    {
                        // Bridge args buffered — process with the real Instrument from PositionUpdate
                        _pendingRiskMgrEntry.Remove(key);
                        ProcessRiskManagerEntry(rmArgsRev, e.Position.Instrument);
                    }
                    else if (!_openTrades.ContainsKey(key) && !recentExitCooldown)
                        HandleTradeEntry(account, e.Position.Instrument, currentPosition, key);
                    else if (recentExitCooldown && !_openTrades.ContainsKey(key))
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: Suppressed PositionUpdate entry for {0} — within 2s of exit cooldown", key),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }

                // Case 3: New entry from flat
                // Guard: check for buffered RiskManager entry first, then fall back to HandleTradeEntry
                // Cooldown guard: suppress if a recent exit happened (stale position data)
                if (previousPosition == MarketPosition.Flat && currentPosition != MarketPosition.Flat)
                {
                    RiskMgrEntryFillArgs rmArgs;
                    if (_pendingRiskMgrEntry.TryGetValue(key, out rmArgs) && rmArgs != null)
                    {
                        // Bridge args buffered — process with the real Instrument from PositionUpdate
                        _pendingRiskMgrEntry.Remove(key);
                        ProcessRiskManagerEntry(rmArgs, e.Position.Instrument);
                    }
                    else if (!_openTrades.ContainsKey(key) && !recentExitCooldown)
                    {
                        // Clean up null placeholder if present (bridge never fired)
                        _pendingRiskMgrEntry.Remove(key);
                        HandleTradeEntry(account, e.Position.Instrument, currentPosition, key);
                    }
                    else if (recentExitCooldown && !_openTrades.ContainsKey(key))
                    {
                        _pendingRiskMgrEntry.Remove(key);
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: Suppressed PositionUpdate entry for {0} — within 2s of exit cooldown", key),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error in PositionUpdate — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Creates a new OpenTradeState when a position is entered (Flat → Long/Short).
        /// Called primarily by OnExecutionUpdate (direction-based classification) and
        /// as a safety net by OnPositionUpdate (only if ExecutionUpdate didn't fire).
        ///
        /// After creating the state, dequeues the entry fill from the execution queue
        /// to populate entry price, quantity, and signal name. If the queue is empty
        /// (rare timing edge case), falls back to Position.AveragePrice.
        /// </summary>
        private void HandleTradeEntry(Account account, NinjaTrader.Cbi.Instrument instrument,
            MarketPosition direction, string key)
        {
            // Get or create the context tagger for this instrument
            MarketContextTagger tagger = GetOrCreateTagger(instrument);

            // Snapshot market context at entry time
            MarketContext context = tagger.GetContextSnapshot();

            string directionStr = direction == MarketPosition.Long ? "Long" : "Short";

            // Create the open trade state.
            // RealEntryTime captures the actual wall-clock moment the entry event was processed.
            // This differs from EntryTime in playback mode where EntryTime reflects the simulated bar time.
            var state = new OpenTradeState
            {
                EntryTime = GetCurrentTime(instrument.FullName),
                RealEntryTime = DateTime.Now,
                Instrument = instrument.FullName,
                Direction = directionStr,
                AccountName = account.Name,
                EntryContext = context,
            };

            // DIAG [direction-flip]: what HandleTradeEntry just persisted to state.Direction,
            // alongside the MarketPosition param it was derived from. Compare to the [1/exec]
            // log above to prove the entry-side mapping.
            NinjaTrader.Code.Output.Process(
                string.Format("DIAG DIR [2/entry]: key={0} direction_param={1} state.Direction={2}",
                    key, direction, state.Direction),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            // Try to dequeue the entry fill from the execution queue
            // In normal flow, ExecutionUpdate fires before PositionUpdate, so the fill is already queued
            ExecutionInfo entryFill = DequeueExecution(key);
            if (entryFill != null)
            {
                // Guard: don't use RiskMgr exit fills as entry data — these are exit fills
                // that leaked into the queue during a Long→Short→Flat position transition glitch.
                // Only "RiskMgr Entry" is a valid entry signal; Target/Stop/Flatten are exits.
                string signal = entryFill.SignalName ?? "";
                if (signal.StartsWith("RiskMgr") && !signal.Equals("RiskMgr Entry"))
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Discarded leaked RiskMgr exit fill for {0} — signal: {1}",
                            instrument.FullName, signal),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    entryFill = null; // Fall through to position-based fallback
                }
            }

            if (entryFill != null)
            {
                state.EntryPrice = entryFill.Price;
                state.Quantity = entryFill.Quantity;
                state.EntryTime = entryFill.Time;
                state.SignalName = entryFill.SignalName;
                state.HighestPriceSinceEntry = entryFill.Price;
                state.LowestPriceSinceEntry = entryFill.Price;

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Entry detected for {0} — {1} @ {2:F2}, signal: {3}",
                        instrument.FullName, directionStr, entryFill.Price, entryFill.SignalName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            else
            {
                // Fallback: execution queue was empty — this is a shell entry created
                // by OnPositionUpdate. Mark it so Branch A/C can upgrade or discard it
                // when the real execution fill arrives.
                state.WasCreatedFromPositionUpdate = true;

                // Try Position.AveragePrice as a temporary entry price
                try
                {
                    foreach (Position pos in account.Positions)
                    {
                        if (pos.Instrument.FullName == instrument.FullName && pos.AveragePrice > 0)
                        {
                            state.EntryPrice = pos.AveragePrice;
                            state.HighestPriceSinceEntry = pos.AveragePrice;
                            state.LowestPriceSinceEntry = pos.AveragePrice;
                            break;
                        }
                    }
                }
                catch { /* Position enumeration can throw if account is mid-update */ }

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Entry detected for {0} — {1}, entry price: {2:F2} (queue empty, used fallback)",
                        instrument.FullName, directionStr, state.EntryPrice),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            _openTrades[key] = state;

            // Check if a stop price arrived before the entry fill (race condition fix).
            // OnOrderUpdate may fire before HandleTradeEntry, so the stop price gets
            // buffered in _pendingStopPrices. Apply it now and remove the buffer entry.
            double pendingStop;
            if (_pendingStopPrices.TryGetValue(key, out pendingStop))
            {
                state.InitialStopPrice = pendingStop;
                state.StopWasEstimated = false;
                _pendingStopPrices.Remove(key);

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Applied buffered stop for {0} — price {1:F2}",
                        instrument.FullName, pendingStop),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            // Check if a TP limit price arrived before the entry fill (same race condition).
            // OCO bracket's Limit order may go Accepted before the entry fill arrives.
            double pendingTp;
            if (_pendingTpPrices.TryGetValue(key, out pendingTp))
            {
                state.InitialTpPrice = pendingTp;
                state.TpWasDetected = true;
                _pendingTpPrices.Remove(key);

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Applied buffered TP for {0} — price {1:F2}",
                        instrument.FullName, pendingTp),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            // POST entry to Supabase on every trade so the web live-trader's Trade
            // Tagger can display and tag the position while it's still open. On close,
            // the exit path PATCHes the existing row (preserving any tags the user
            // added during the trade) via EntryWrittenToSupabase.
            _supabaseWriter.WriteEntryAsync(state);

            // Notify TradeTagger that a trade opened so it can display the in-play trade.
            // Works for both RM and non-RM trades. If the bridge enriches later, TradeTagger
            // gets a second FireTradeOpened with RM-specific SL/TP data.
            TradeTrackerBridge.FireTradeOpened(new TradeOpenedArgs
            {
                EntryTime = state.EntryTime,
                Instrument = instrument.FullName,
                Direction = directionStr,
                AccountName = account.Name,
                EntryPrice = state.EntryPrice,
                StopPrice = state.InitialStopPrice,
                TargetPrice = state.InitialTpPrice
            });
        }

        /// <summary>
        /// Completes a trade when the position goes flat (Long/Short → Flat).
        /// Dequeues the exit fill from the execution queue to get the actual exit price.
        /// Builds a TradeRecord from the OpenTradeState and writes it to JSON.
        ///
        /// Exit price priority:
        /// 1. Dequeued exit fill from execution queue (most accurate)
        /// 2. tagger.LastPrice (fallback for tick/bar-based tracking)
        /// 3. EntryPrice (worst case — results in 0 P&L, better than crashing)
        /// </summary>
        private void HandleTradeExit(Account account, NinjaTrader.Cbi.Instrument instrument, string key)
        {
            OpenTradeState state;
            if (!_openTrades.TryGetValue(key, out state))
                return; // No tracked open trade for this key

            // Get the tagger for fallback price
            MarketContextTagger tagger;
            _taggers.TryGetValue(instrument.FullName, out tagger);

            // ── Resolve exit price by dequeuing from the execution queue ──
            double exitPrice = 0;
            DateTime exitTime = GetCurrentTime(instrument.FullName);

            ExecutionInfo exitFill = DequeueExecution(key);
            if (exitFill != null && exitFill.Price > 0)
            {
                // Best source: actual exit fill from the execution queue
                exitPrice = exitFill.Price;
                exitTime = exitFill.Time;
            }
            else if (tagger != null && tagger.LastPrice > 0)
            {
                // Fallback: tagger's last tracked price (from ticks or bar closes)
                exitPrice = tagger.LastPrice;
            }

            // Update final MFE/MAE with the exit price
            if (exitPrice > 0)
                state.UpdateExcursion(exitPrice);

            // If entry price is zero, skip — we have no meaningful data
            if (state.EntryPrice == 0)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Skipping trade for {0} — entry price never captured",
                        instrument.FullName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                _openTrades.Remove(key);
                return;
            }

            // If exit price is still 0, fall back to entry price (0 P&L is better than NaN)
            if (exitPrice == 0)
            {
                exitPrice = state.EntryPrice;
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Warning — no exit price available for {0}, using entry price (P&L will be 0)",
                        instrument.FullName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            // Estimate stop if we never captured one from OrderUpdate
            if (state.StopWasEstimated && state.InitialStopPrice == 0)
            {
                MarketContext ctx = state.EntryContext;
                double atr = ctx.Atr14 > 0 ? ctx.Atr14 : 10.0; // Fallback to 10 points
                if (state.Direction == "Long")
                    state.InitialStopPrice = state.EntryPrice - (atr * STOP_ESTIMATE_ATR_MULT);
                else
                    state.InitialStopPrice = state.EntryPrice + (atr * STOP_ESTIMATE_ATR_MULT);
            }

            // Calculate trade metrics
            double initialStopDist = state.GetInitialStopDistance();
            double mfePoints = state.GetMfePoints();
            double maePoints = state.GetMaePoints();

            // P&L calculated from actual entry and exit prices
            double pnlPoints;
            if (state.Direction == "Long")
                pnlPoints = exitPrice - state.EntryPrice;
            else
                pnlPoints = state.EntryPrice - exitPrice;

            // Determine point value from instrument
            double pointValue = instrument.MasterInstrument.PointValue;
            if (pointValue == 0) pointValue = DEFAULT_POINT_VALUE;

            // Diagnostic logging to identify P/L discrepancies vs NT8's Account Performance
            double diagPnlDollars = pnlPoints * pointValue * (state.Quantity > 0 ? state.Quantity : 1);
            NinjaTrader.Code.Output.Process(
                string.Format("TradeTracker P/L DIAG: {0} {1} | entry={2:F2} exit={3:F2} | pnlPts={4:F4} pointVal={5} qty={6} | pnl${7:F2}",
                    state.Direction, instrument.FullName,
                    state.EntryPrice, exitPrice,
                    pnlPoints, pointValue, state.Quantity > 0 ? state.Quantity : 1,
                    diagPnlDollars),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            // Compute setup_rr from TP and SL distances if a TP limit order was detected.
            // setup_rr = TP distance / SL distance — the intended R:R of the bracket,
            // identical for winners and losers using the same OCO bracket size.
            double takeProfitPrice = state.TpWasDetected ? state.InitialTpPrice : 0;
            double setupRR = 0;
            if (state.TpWasDetected && initialStopDist > 0)
            {
                double tpDist;
                if (state.Direction == "Long")
                    tpDist = state.InitialTpPrice - state.EntryPrice;
                else
                    tpDist = state.EntryPrice - state.InitialTpPrice;

                // Only compute if TP distance is positive (sanity check)
                if (tpDist > 0)
                    setupRR = tpDist / initialStopDist;
            }

            // Build the TradeRecord.
            // RealEntryTime/RealExitTime capture actual wall-clock timestamps, which differ from
            // EntryTime/ExitTime during playback where those reflect simulated bar timestamps.
            var record = new TradeRecord
            {
                EntryTime = state.EntryTime,
                ExitTime = exitTime,
                RealEntryTime = state.RealEntryTime,
                RealExitTime = DateTime.Now,
                Instrument = state.Instrument,
                Direction = state.Direction,
                EntryPrice = state.EntryPrice,
                ExitPrice = exitPrice,
                StopLossPrice = state.InitialStopPrice,
                Quantity = state.Quantity > 0 ? state.Quantity : 1,
                PnlPoints = pnlPoints,
                PnlDollars = pnlPoints * pointValue * (state.Quantity > 0 ? state.Quantity : 1),
                StrategySignalName = state.SignalName ?? "",
                AccountName = state.AccountName,
                InitialStopDistance = initialStopDist,
                ActualRR = initialStopDist > 0 ? pnlPoints / initialStopDist : 0,
                TakeProfitPrice = takeProfitPrice,
                SetupRR = setupRR,
                MfePoints = mfePoints,
                MaePoints = maePoints,
                MfeRMultiple = initialStopDist > 0 ? mfePoints / initialStopDist : 0,
                MaeRMultiple = initialStopDist > 0 ? maePoints / initialStopDist : 0,
                Context = state.EntryContext,
                // RiskManager metadata — defaults to 0/"" for non-RiskManager trades
                RiskUnits = state.RiskUnits,
                AtrMultiplier = state.AtrMultiplier,
                RRMultiplier = state.RRMultiplier,
                SlMode = state.SlMode ?? ""
            };

            // Write to daily JSON file (local backup)
            _writer.WriteTrade(record);

            // Race condition guard: signal the ThreadPool entry POST to abort if it hasn't
            // fired yet. Must be set BEFORE checking EntryWrittenToSupabase so the volatile
            // write is visible to WriteEntryAsync's check on the ThreadPool thread.
            state.TradeAlreadyClosed = true;

            // DIAG [direction-flip]: last chance to catch a flip on the NT8 side before the HTTP POST.
            // If record.Direction still matches state.Direction here, any inversion in the DB row must
            // come from the JSON build, the POST itself, or a downstream writer — not in-memory state.
            NinjaTrader.Code.Output.Process(
                string.Format("DIAG DIR [3/exit]: key={0} state.Direction={1} record.Direction={2} pnlPts={3:F2} entryWritten={4}",
                    string.Format("{0}|{1}", state.AccountName, state.Instrument),
                    state.Direction, record.Direction, record.PnlPoints, state.EntryWrittenToSupabase),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            // Dual-write to Supabase: trades that were POSTed at entry time (HandleTradeEntry)
            // get PATCHed with exit data. If the entry POST failed (EntryWrittenToSupabase=false),
            // fall back to a full POST — identical to the original behavior.
            if (state.EntryWrittenToSupabase)
            {
                _supabaseWriter.UpdateTradeExitAsync(record);
            }
            else
            {
                _supabaseWriter.WriteTradeAsync(record);
                // Safety net: if the entry POST was still in-flight and completes after our
                // full POST, it would create an orphaned "open" row. Fire a delayed DELETE
                // to clean it up. The trade_status=eq.open filter ensures this can never
                // delete the correct "closed" row we just POSTed.
                _supabaseWriter.DeleteOpenEntryAsync(state);
            }

            // Persist the OHLC window around this trade to trade_bars. WriteTradeBarsAsync
            // polls the trades table to resolve the trade_id FK so we don't have to change
            // the POST/PATCH return types above. If the instrument wasn't being streamed by
            // LiveBridge the window is empty and the call is a no-op.
            var tradeBars = BuildTradeBarWindow(state.Instrument, state.EntryTime, record.ExitTime);
            if (tradeBars.Count > 0)
            {
                _supabaseWriter.WriteTradeBarsAsync(record, tradeBars);
            }

            // Notify TradeTagger (if open) that a new trade completed — auto-navigates to it
            TradeTrackerBridge.FireTradeCompleted(new TradeCompletedArgs
            {
                EntryTime = record.EntryTime,
                ExitTime = record.ExitTime,
                Instrument = record.Instrument,
                Direction = record.Direction,
                EntryPrice = record.EntryPrice,
                ExitPrice = record.ExitPrice,
                PnlPoints = record.PnlPoints,
                PnlDollars = record.PnlDollars,
                AccountName = record.AccountName,
                ActualRR = record.ActualRR
            });

            NinjaTrader.Code.Output.Process(
                string.Format("TradeTracker: Logged {0} {1} on {2} — Entry: {3:F2}, Exit: {4:F2}, P&L: {5:F2} pts ({6:F2}R)",
                    state.Direction, state.Instrument, state.AccountName,
                    state.EntryPrice, exitPrice, pnlPoints, record.ActualRR),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            // ── Start post-exit monitoring ──
            // Track price for 20 minutes after exit to answer "what if I held longer"
            if (initialStopDist > 0)
            {
                // Include milliseconds (fff) to prevent key collisions when two trades share
                // the same entry second (e.g., rapid back-to-back trades in Playback)
                var postExitKey = string.Format("{0}|{1}", key, state.EntryTime.ToString("HHmmssfff"));
                var postExit = new PostExitTrackingState
                {
                    ExitPrice = exitPrice,
                    ExitTime = exitTime,
                    Direction = state.Direction,
                    Instrument = state.Instrument,
                    InitialStopDistance = initialStopDist,
                    HighestPriceSinceExit = exitPrice,
                    LowestPriceSinceExit = exitPrice,
                    ExpiryTime = exitTime.AddMinutes(20),
                    EntryTime = state.EntryTime,
                    AccountName = state.AccountName
                };
                _postExitTrades[postExitKey] = postExit;

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Post-exit monitoring started for {0} {1} — expires {2:HH:mm:ss}",
                        state.Direction, state.Instrument, postExit.ExpiryTime),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            // Clean up the open trade state (execution queue entries are already dequeued)
            _openTrades.Remove(key);
            _pendingStopPrices.Remove(key); // Clean stale buffer if entry never consumed it
            _pendingTpPrices.Remove(key); // Clean stale TP buffer if entry never consumed it
            _pendingRiskMgrEntry.Remove(key); // Prevent stale bridge args from creating phantom entries
        }

        // ─── Execution Update — Fill Details ───────────────────────────────────

        /// <summary>
        /// PRIMARY LIFECYCLE DRIVER — enqueues execution fills and immediately classifies
        /// them as entry or exit using direction-based logic.
        ///
        /// Classification rules:
        /// - No open trade + any execution = new entry (HandleTradeEntry)
        /// - Open trade + opposite direction execution = exit (HandleTradeExit)
        /// - Open trade + same direction execution = add-on (MFE/MAE update only)
        ///
        /// This replaces the previous PositionUpdate-driven approach because PositionUpdate
        /// does NOT fire reliably in Strategy Analyzer for back-to-back trades. ExecutionUpdate
        /// fires for every fill, making it the only reliable lifecycle event.
        ///
        /// After processing, _lastPositionState is synced so OnPositionUpdate (safety net)
        /// won't double-process the same transition.
        /// </summary>
        private void OnExecutionUpdate(object sender, ExecutionEventArgs e)
        {
            try
            {
                if (e.Execution == null || e.Execution.Instrument == null)
                    return;

                Account account = e.Execution.Account;
                NinjaTrader.Cbi.Instrument instrument = e.Execution.Instrument;
                string instrumentName = instrument.FullName;
                string key = string.Format("{0}|{1}", account.Name, instrumentName);

                // Build execution info from the fill
                var execInfo = new ExecutionInfo
                {
                    Price = e.Execution.Price,
                    Time = e.Execution.Time,
                    Quantity = e.Execution.Quantity,
                    SignalName = e.Execution.Name ?? "",
                    Direction = e.Execution.MarketPosition
                };

                // DIAG [direction-flip]: raw NT8 execution metadata at the earliest capture point.
                // Compare MarketPosition (what this code trusts) against OrderAction (unambiguous
                // order side) to detect any mismatch introduced by NT8 for LiveBridge-submitted orders.
                string diagOrderAction = (e.Execution.Order != null)
                    ? e.Execution.Order.OrderAction.ToString()
                    : "<null>";
                NinjaTrader.Code.Output.Process(
                    string.Format("DIAG DIR [1/exec]: key={0} MarketPosition={1} OrderAction={2} signal={3} price={4:F2}",
                        key, e.Execution.MarketPosition, diagOrderAction, execInfo.SignalName, execInfo.Price),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                // All fills (including "RiskMgr Entry") are enqueued and flow through the normal
                // OnExecutionUpdate lifecycle. Entry fills create the trade via HandleTradeEntry;
                // when the bridge also fires, OnRiskManagerEntry sees the trade already exists
                // and enriches it with RM metadata (idempotent). This avoids the timing gap where
                // skipping entry fills left no open trade for exit fills to close, causing phantoms.

                // Enqueue the fill — HandleTradeEntry/HandleTradeExit will dequeue it
                EnqueueExecution(key, execInfo);

                // Update the last known execution time for this instrument.
                // This keeps time in sync with whatever mode NinjaTrader is running:
                // live = real wall-clock time, playback = simulated historical time.
                _lastKnownTime[instrumentName] = execInfo.Time;

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Execution fill queued for {0} — {1} @ {2:F2}, signal: {3}",
                        instrumentName, e.Execution.MarketPosition, e.Execution.Price, execInfo.SignalName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                // ── Direction-based lifecycle classification ──
                // This is the core fix: classify entry vs exit immediately based on
                // the execution's MarketPosition vs the open trade's direction.
                OpenTradeState state;
                bool hasOpenTrade = _openTrades.TryGetValue(key, out state);
                MarketPosition execDirection = e.Execution.MarketPosition;

                if (hasOpenTrade && state.EntryPrice > 0)
                {
                    // We have an open trade with a valid entry price
                    // Determine if this execution is an exit (opposite direction) or same-direction update
                    bool isExit = (state.Direction == "Long" && execDirection == MarketPosition.Short)
                               || (state.Direction == "Short" && execDirection == MarketPosition.Long);

                    if (isExit)
                    {
                        // Opposite direction = closing the trade
                        HandleTradeExit(account, instrument, key);
                        // Sync position state so OnPositionUpdate doesn't re-process
                        _lastPositionState[key] = MarketPosition.Flat;
                        // Record exit time for Layer 3 cooldown — prevents OnPositionUpdate
                        // from creating a stale shell when close+reentry happen on same tick
                        _recentExitTime[key] = execInfo.Time;
                    }
                    else
                    {
                        // Same direction execution. If this is a shell from OnPositionUpdate,
                        // upgrade it with the real fill data (price, signal, quantity, time)
                        // instead of just tracking excursion. This covers cases where the
                        // shell got EntryPrice > 0 from Position.AveragePrice (bypassing Branch C).
                        if (state.WasCreatedFromPositionUpdate)
                        {
                            ExecutionInfo upgradeFill = DequeueExecution(key);
                            if (upgradeFill != null)
                            {
                                state.EntryPrice = upgradeFill.Price;
                                state.Quantity = upgradeFill.Quantity;
                                state.EntryTime = upgradeFill.Time;
                                state.SignalName = upgradeFill.SignalName;
                                state.HighestPriceSinceEntry = upgradeFill.Price;
                                state.LowestPriceSinceEntry = upgradeFill.Price;
                                state.WasCreatedFromPositionUpdate = false;

                                NinjaTrader.Code.Output.Process(
                                    string.Format("TradeTracker: Upgraded shell entry for {0} — {1} @ {2:F2}, signal: {3}",
                                        instrumentName, state.Direction, upgradeFill.Price, upgradeFill.SignalName),
                                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                            }
                        }
                        else
                        {
                            // Same-direction fill for a bridge-created or execution-created trade.
                            // Dequeue immediately — if left in the queue it becomes the exit price in
                            // HandleTradeExit, producing wrong P&L (especially in playback where
                            // ExecutionUpdate fires before OrderUpdate).
                            //
                            // Also accumulate quantity and recalculate the weighted-average entry price.
                            // NinjaTrader may deliver a multi-contract order as multiple smaller execution
                            // events (partial fills) at slightly different prices. Without this, state.Quantity
                            // reflects only the first partial fill, causing PnlDollars to be wrong by the
                            // ratio of the first fill to the full order (e.g. 1/10 = 10x error).
                            ExecutionInfo partialFill = DequeueExecution(key);
                            if (partialFill != null && partialFill.Quantity > 0 && state.Quantity > 0)
                            {
                                int newQty = state.Quantity + partialFill.Quantity;
                                // Weighted average: blend old entry price with new partial fill price
                                state.EntryPrice = (state.EntryPrice * state.Quantity + partialFill.Price * partialFill.Quantity) / newQty;
                                state.Quantity = newQty;

                                NinjaTrader.Code.Output.Process(
                                    string.Format("TradeTracker: Partial fill accumulated for {0} — +{1} @ {2:F2}, total qty={3}, avg entry={4:F2}",
                                        instrumentName, partialFill.Quantity, partialFill.Price, state.Quantity, state.EntryPrice),
                                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                            }
                            state.UpdateExcursion(e.Execution.Price);
                        }
                    }
                }
                else if (!hasOpenTrade)
                {
                    // Check cooldown — suppress phantom entries from stale flatten fills
                    // that arrive after the bridge already processed the exit.
                    // Without this, a manual flatten via RiskManager causes a duplicate:
                    // 1) Bridge exit removes the trade, 2) NinjaTrader delivers a "Close" fill,
                    // 3) No open trade exists so HandleTradeEntry creates a phantom entry.
                    bool recentExitCooldown = false;
                    DateTime lastExit;
                    if (_recentExitTime.TryGetValue(key, out lastExit))
                    {
                        DateTime currentTime = GetCurrentTime(instrumentName);
                        if ((currentTime - lastExit).TotalSeconds < 2.0)
                            recentExitCooldown = true;
                    }

                    // RiskMgr Entry signals are genuine new trades — never suppress them,
                    // even during the cooldown window. Only phantom NinjaTrader flatten fills
                    // (signal != "RiskMgr Entry") should be suppressed.
                    bool isRealRiskMgrEntry = string.Equals(execInfo.SignalName, "RiskMgr Entry", StringComparison.Ordinal);

                    if (recentExitCooldown && !isRealRiskMgrEntry)
                    {
                        // Drain the stale flatten fill so it doesn't contaminate the next real entry
                        DequeueExecution(key);

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: Suppressed phantom entry for {0} — execution within 2s of bridge exit (signal: {1})",
                                key, execInfo.SignalName),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        // Guard: orphaned RiskMgr exit fills (Stop/Target/Flatten) arriving
                        // when no open trade exists should NOT create phantom entries.
                        // This happens when the entry fill already created+closed the trade
                        // or when events arrive out of order. Only "RiskMgr Entry" is a valid
                        // signal for creating a new trade in the !hasOpenTrade path.
                        if (execInfo.SignalName.StartsWith("RiskMgr", StringComparison.Ordinal)
                            && !string.Equals(execInfo.SignalName, "RiskMgr Entry", StringComparison.Ordinal))
                        {
                            DequeueExecution(key);

                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeTracker: Discarded orphaned RiskMgr exit fill for {0} — signal: {1} (no open trade to close)",
                                    key, execInfo.SignalName),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                        else
                        {
                            // No open trade and no recent exit — this is a genuine new entry
                            MarketPosition direction = execDirection;
                            HandleTradeEntry(account, instrument, direction, key);
                            // Sync position state so OnPositionUpdate doesn't re-process
                            _lastPositionState[key] = direction;
                            // Clear the exit cooldown now that the real entry is established
                            _recentExitTime.Remove(key);
                        }
                    }
                }
                else if (hasOpenTrade && state.EntryPrice == 0)
                {
                    // Edge case: PositionUpdate created a shell state before ExecutionUpdate arrived.
                    // LAYER 1: Check if the execution direction matches the shell's direction.
                    // On same-tick close+reentry with direction change (Short→Long), OnPositionUpdate
                    // may create a shell with the WRONG direction (stale data). If mismatch,
                    // discard the shell and let HandleTradeEntry create a proper entry.
                    string execDirStr = execDirection == MarketPosition.Long ? "Long" : "Short";

                    if (execDirStr == state.Direction)
                    {
                        // Direction matches — safe to backfill the shell with real fill data
                        ExecutionInfo pendingFill = DequeueExecution(key);
                        if (pendingFill != null)
                        {
                            state.EntryPrice = pendingFill.Price;
                            state.Quantity = pendingFill.Quantity;
                            state.EntryTime = pendingFill.Time;
                            state.SignalName = pendingFill.SignalName;
                            state.HighestPriceSinceEntry = pendingFill.Price;
                            state.LowestPriceSinceEntry = pendingFill.Price;
                            state.WasCreatedFromPositionUpdate = false;

                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeTracker: Backfilled entry for {0} — {1} @ {2:F2}",
                                    instrumentName, state.Direction, pendingFill.Price),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                    }
                    else
                    {
                        // Direction MISMATCH — the shell has the wrong direction (stale position data).
                        // Discard it and create a proper entry with the correct direction from the fill.
                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: Direction mismatch — shell is {0} but fill is {1}, discarding shell for {2}",
                                state.Direction, execDirStr, key),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                        _openTrades.Remove(key);
                        HandleTradeEntry(account, instrument, execDirection, key);
                        _lastPositionState[key] = execDirection;
                        // Clear the exit cooldown now that the real entry is established
                        _recentExitTime.Remove(key);
                    }
                }

                // Belt-and-suspenders: also update post-exit excursions on every execution fill.
                // This catches cases where tagger callbacks haven't fired yet but a new fill
                // has arrived (e.g., rapid back-to-back trades on the same instrument).
                if (_postExitTrades.Count > 0)
                    UpdateOpenTradeExcursions();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error in ExecutionUpdate — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── Execution Queue Helpers ────────────────────────────────────────────

        /// <summary>
        /// Enqueues an execution fill into the per-key FIFO queue.
        /// Caps the queue at MAX_QUEUE_SIZE to prevent unbounded memory growth
        /// (drops oldest entries if the cap is reached).
        /// </summary>
        private void EnqueueExecution(string key, ExecutionInfo exec)
        {
            Queue<ExecutionInfo> queue;
            if (!_executionQueues.TryGetValue(key, out queue))
            {
                queue = new Queue<ExecutionInfo>();
                _executionQueues[key] = queue;
            }

            // Safety cap: drop oldest if queue grows too large (shouldn't happen normally)
            while (queue.Count >= MAX_QUEUE_SIZE)
            {
                queue.Dequeue();
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Warning — execution queue overflow for {0}, dropping oldest fill", key),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            queue.Enqueue(exec);
        }

        /// <summary>
        /// Dequeues the next execution fill from the per-key FIFO queue.
        /// Returns null if the queue is empty or doesn't exist for this key.
        /// </summary>
        private ExecutionInfo DequeueExecution(string key)
        {
            Queue<ExecutionInfo> queue;
            if (_executionQueues.TryGetValue(key, out queue) && queue.Count > 0)
            {
                return queue.Dequeue();
            }
            return null;
        }

        // ─── Playback-Safe Time Helper ──────────────────────────────────────────

        /// <summary>
        /// Returns the most recent execution timestamp for the given instrument.
        /// In live trading, this closely tracks wall-clock time. In Playback mode,
        /// this returns historical simulated time instead of real wall-clock time,
        /// preventing corrupted timestamps in trade records.
        /// Falls back to DateTime.Now only for the very first execution on an instrument
        /// (before any fills have been recorded).
        /// </summary>
        /// <param name="instrumentName">The instrument's FullName (e.g., "NQ 03-26")</param>
        /// <returns>The last known execution time, or DateTime.Now as a first-use fallback</returns>
        private DateTime GetCurrentTime(string instrumentName)
        {
            DateTime time;
            if (_lastKnownTime.TryGetValue(instrumentName, out time))
                return time;
            return DateTime.Now;
        }

        // ─── Order Update — Stop Loss Detection ────────────────────────────────

        /// <summary>
        /// Monitors order updates to capture initial stop loss prices.
        /// Looks for stop-market or stop-limit orders on instruments with open trades.
        /// If found, updates the OpenTradeState with the actual stop price.
        /// </summary>
        private void OnOrderUpdate(object sender, OrderEventArgs e)
        {
            try
            {
                if (e.Order == null || e.Order.Instrument == null)
                    return;

                // Only capture prices when the order is first accepted/working
                if (e.OrderState != OrderState.Accepted && e.OrderState != OrderState.Working)
                    return;

                bool isStop = (e.Order.OrderType == OrderType.StopMarket || e.Order.OrderType == OrderType.StopLimit);
                bool isLimit = (e.Order.OrderType == OrderType.Limit);

                // Only care about stop orders (SL) and limit orders (TP from OCO brackets)
                if (!isStop && !isLimit)
                    return;

                Account account = e.Order.Account;
                string instrumentName = e.Order.Instrument.FullName;
                string key = string.Format("{0}|{1}", account.Name, instrumentName);

                if (isStop)
                {
                    // ── Stop loss capture (existing logic, unchanged) ──
                    OpenTradeState state;
                    if (_openTrades.TryGetValue(key, out state))
                    {
                        // Only capture the first stop (initial stop, not a trailed stop)
                        if (state.StopWasEstimated)
                        {
                            state.InitialStopPrice = e.Order.StopPrice;
                            state.StopWasEstimated = false;

                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeTracker: Stop captured for {0} — price {1:F2} (trade already open)",
                                    instrumentName, e.Order.StopPrice),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                    }
                    else
                    {
                        // Trade not yet in _openTrades — entry fill hasn't arrived yet.
                        // Buffer the stop price so HandleTradeEntry can apply it when it runs.
                        _pendingStopPrices[key] = e.Order.StopPrice;

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: Stop buffered for {0} — price {1:F2} (trade not yet open)",
                                instrumentName, e.Order.StopPrice),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                else if (isLimit)
                {
                    // ── Take profit capture (mirrors stop capture pattern) ──
                    // OCO brackets place a Limit order as the TP target.
                    // Capture the LimitPrice for setup_rr calculation.
                    OpenTradeState state;
                    if (_openTrades.TryGetValue(key, out state))
                    {
                        // Only capture the first TP (initial target, not a modified one)
                        if (!state.TpWasDetected)
                        {
                            state.InitialTpPrice = e.Order.LimitPrice;
                            state.TpWasDetected = true;

                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeTracker: TP captured for {0} — price {1:F2} (trade already open)",
                                    instrumentName, e.Order.LimitPrice),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                    }
                    else
                    {
                        // Trade not yet in _openTrades — buffer TP price for HandleTradeEntry.
                        _pendingTpPrices[key] = e.Order.LimitPrice;

                        NinjaTrader.Code.Output.Process(
                            string.Format("TradeTracker: TP buffered for {0} — price {1:F2} (trade not yet open)",
                                instrumentName, e.Order.LimitPrice),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error in OrderUpdate — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── MFE/MAE + Post-Exit Tracking (Callback-Driven) ─────────────────────
        //
        // Excursion tracking is driven by a callback from MarketContextTagger:
        //   tagger.OnPriceUpdate → OnTaggerPriceUpdate → UpdateOpenTradeExcursions
        //
        // The callback fires on every tick (OnMarketDataUpdate) and every bar close
        // (OnBarsUpdate), giving near-real-time MFE/MAE updates for both open trades
        // and post-exit monitoring.
        //
        // Bar closes also carry a timestamp, which advances _lastKnownTime. This is
        // critical for Playback mode where execution fills stop arriving after a trade
        // exits, but bars keep closing — without advancing time, the 20-minute post-exit
        // expiry check would freeze and never trigger the Supabase PATCH.
        //
        // Additionally, UpdateOpenTradeExcursions is called at the end of OnExecutionUpdate
        // as a belt-and-suspenders safety net for the post-exit tracking path.

        /// <summary>
        /// Callback wired to MarketContextTagger.OnPriceUpdate.
        /// Receives every tick and bar close from the tagger, advances _lastKnownTime
        /// from bar timestamps (fixing frozen expiry in Playback), and drives excursion
        /// updates for both open trades and post-exit monitoring.
        /// </summary>
        /// <param name="instrumentName">Instrument full name (e.g., "NQ 03-26")</param>
        /// <param name="price">Current price (tick price or bar close)</param>
        /// <param name="barTime">Bar close timestamp, or DateTime.MinValue for tick updates</param>
        private void OnTaggerPriceUpdate(string instrumentName, double price, DateTime barTime)
        {
            // Advance _lastKnownTime from bar closes. Ticks pass DateTime.MinValue
            // so they're ignored here. This ensures Playback mode's simulated clock
            // advances even when no new execution fills arrive after a trade exits,
            // allowing the 20-minute post-exit expiry to trigger correctly.
            if (barTime > DateTime.MinValue)
            {
                DateTime existing;
                if (!_lastKnownTime.TryGetValue(instrumentName, out existing) || barTime > existing)
                    _lastKnownTime[instrumentName] = barTime;
            }

            // Only call the full excursion update if there are trades to update
            if (_openTrades.Count > 0 || _postExitTrades.Count > 0)
                UpdateOpenTradeExcursions();
        }

        /// <summary>
        /// Updates MFE/MAE for all open trades and post-exit monitored trades
        /// by reading each tagger's LastPrice. Also checks post-exit expiry and
        /// finalizes (PATCHes to Supabase) any that have exceeded the 20-minute window.
        /// </summary>
        private void UpdateOpenTradeExcursions()
        {
            // Update MFE/MAE for all open (active) trades
            foreach (var kvp in _openTrades.ToList())
            {
                string instrumentName = kvp.Value.Instrument;
                MarketContextTagger tagger;
                if (_taggers.TryGetValue(instrumentName, out tagger) && tagger.LastPrice > 0)
                {
                    kvp.Value.UpdateExcursion(tagger.LastPrice);
                }
            }

            // Update post-exit trades and finalize expired ones
            foreach (var kvp in _postExitTrades.ToList())
            {
                PostExitTrackingState postExit = kvp.Value;
                MarketContextTagger tagger;

                if (_taggers.TryGetValue(postExit.Instrument, out tagger) && tagger.LastPrice > 0)
                {
                    postExit.UpdateExcursion(tagger.LastPrice);
                }

                // Check if the 20-minute monitoring window has expired.
                // Uses GetCurrentTime (last execution timestamp) instead of DateTime.Now
                // to avoid premature expiry in Playback mode where wall-clock time is
                // far ahead of the simulated historical time.
                DateTime currentTime = GetCurrentTime(postExit.Instrument);
                if (currentTime >= postExit.ExpiryTime)
                {
                    // Finalize: PATCH the post-exit data to Supabase
                    _supabaseWriter.UpdatePostExitAsync(postExit);

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Post-exit finalized for {0} {1} — MFE: {2:F2} pts ({3:F2}R), MAE: {4:F2} pts",
                            postExit.Direction, postExit.Instrument,
                            postExit.GetPostExitMfePoints(), postExit.GetPostExitMfeR(),
                            postExit.GetPostExitMaePoints()),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                    // Remove from monitoring
                    _postExitTrades.Remove(kvp.Key);
                }
            }
        }

        // ─── Tagger Management ─────────────────────────────────────────────────

        /// <summary>
        /// Gets or creates a MarketContextTagger for the specified instrument.
        /// Taggers are cached and reused for the AddOn's lifetime.
        /// Each tagger runs its own BarsRequest and market data subscription.
        /// </summary>
        private MarketContextTagger GetOrCreateTagger(NinjaTrader.Cbi.Instrument instrument)
        {
            string instrumentName = instrument.FullName;
            MarketContextTagger tagger;

            if (!_taggers.TryGetValue(instrumentName, out tagger))
            {
                tagger = new MarketContextTagger(instrument);

                // Wire the price callback so every tick and bar close drives
                // MFE/MAE updates and post-exit monitoring expiry checks
                tagger.OnPriceUpdate = OnTaggerPriceUpdate;

                _taggers[instrumentName] = tagger;

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Created context tagger for {0}", instrumentName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }

            return tagger;
        }

        // ─── RiskManager Bridge Handlers ─────────────────────────────────────
        // These handlers receive trade lifecycle events directly from RiskManager
        // via the static RiskManagerBridge. This bypasses the execution-based
        // inference in OnExecutionUpdate, preventing phantom double-counting.

        /// <summary>
        /// Resolves an instrument full name to a NinjaTrader Instrument object.
        /// Searches existing taggers first (fastest), then subscribed account positions.
        /// Used by bridge handlers to get the Instrument reference for HandleTradeExit.
        /// </summary>
        /// <param name="instrumentFullName">Full instrument name (e.g., "MNQ 03-26")</param>
        /// <returns>Instrument object, or null if not found</returns>
        private NinjaTrader.Cbi.Instrument ResolveInstrument(string instrumentFullName)
        {
            // First check taggers — they store the Instrument reference
            MarketContextTagger tagger;
            if (_taggers.TryGetValue(instrumentFullName, out tagger))
                return tagger.Instrument;

            // Fallback: search subscribed account positions
            foreach (Account acct in _subscribedAccounts)
            {
                try
                {
                    foreach (Position pos in acct.Positions)
                    {
                        if (pos.Instrument != null && pos.Instrument.FullName == instrumentFullName)
                            return pos.Instrument;
                    }
                }
                catch { /* Position enumeration can throw if account is mid-update */ }
            }

            return null;
        }

        /// <summary>
        /// Called by the RiskManagerBridge when an entry fill is detected.
        /// Uses enrich-or-buffer pattern to handle bridge firing before OR after PositionUpdate:
        ///
        /// Case A (bridge fires AFTER PositionUpdate — observed behavior):
        ///   _openTrades[key] already exists from HandleTradeEntry → enrich with exact RM data,
        ///   POST to Supabase, and fire TradeOpened. No duplicate trade created.
        ///
        /// Case B (bridge fires BEFORE PositionUpdate — theoretical):
        ///   No trade exists yet → buffer args for PositionUpdate to consume via ProcessRiskManagerEntry.
        /// </summary>
        private void OnRiskManagerEntry(RiskMgrEntryFillArgs args)
        {
            try
            {
                string key = string.Format("{0}|{1}", args.AccountName, args.InstrumentFullName);

                OpenTradeState existingState;
                if (_openTrades.TryGetValue(key, out existingState))
                {
                    // PositionUpdate already ran HandleTradeEntry (bridge fired late).
                    // Enrich the existing state with exact RiskManager data instead of estimates.
                    existingState.EntryPrice = args.EntryPrice;
                    existingState.Quantity = args.Quantity;
                    existingState.SignalName = "RiskMgr Entry";
                    existingState.InitialStopPrice = args.StopPrice;
                    existingState.StopWasEstimated = false;
                    existingState.InitialTpPrice = args.TargetPrice;
                    existingState.TpWasDetected = true;
                    existingState.HighestPriceSinceEntry = args.EntryPrice;
                    existingState.LowestPriceSinceEntry = args.EntryPrice;
                    existingState.IsRiskManagerTrade = true;
                    existingState.RiskUnits = args.RiskUnits;
                    existingState.RuValue = args.RuValue;
                    existingState.AtrMultiplier = args.AtrMultiplier;
                    existingState.RRMultiplier = args.RRMultiplier;
                    existingState.SlMode = args.SlMode ?? "";

                    // No Supabase call here — HandleTradeEntry already POSTed the entry.
                    // The enriched RM metadata (SL/TP/RU) will be included when HandleTradeExit
                    // builds the final TradeRecord and POSTs/PATCHes the completed trade.

                    // Notify TradeTagger so it can display the open trade
                    string directionStr = args.IsLong ? "Long" : "Short";
                    TradeTrackerBridge.FireTradeOpened(new TradeOpenedArgs
                    {
                        EntryTime = existingState.EntryTime,
                        Instrument = args.InstrumentFullName,
                        Direction = directionStr,
                        AccountName = args.AccountName,
                        EntryPrice = args.EntryPrice,
                        StopPrice = args.StopPrice,
                        TargetPrice = args.TargetPrice
                    });

                    // Clean up pending buffers — bridge provided exact values
                    _pendingStopPrices.Remove(key);
                    _pendingTpPrices.Remove(key);

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Bridge enriched existing trade — {0} {1} @ {2:F2}",
                            existingState.Direction, args.InstrumentFullName, args.EntryPrice),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                else
                {
                    // Bridge fired before PositionUpdate — buffer for later processing
                    _pendingRiskMgrEntry[key] = args;

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: Bridge received RiskMgr entry for {0} — buffering for PositionUpdate",
                            args.InstrumentFullName),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error in OnRiskManagerEntry — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Processes a buffered RiskManager entry with a resolved Instrument reference.
        /// Called from OnPositionUpdate after the bridge args have been buffered.
        /// Creates the OpenTradeState with exact RiskManager metadata, POSTs to Supabase,
        /// and fires TradeOpened so TradeTagger can display the in-play trade.
        /// </summary>
        /// <param name="args">Buffered entry args from RiskManagerBridge</param>
        /// <param name="instrument">Resolved Instrument from the PositionUpdate event</param>
        private void ProcessRiskManagerEntry(RiskMgrEntryFillArgs args, NinjaTrader.Cbi.Instrument instrument)
        {
            try
            {
                string key = string.Format("{0}|{1}", args.AccountName, args.InstrumentFullName);

                // If OnExecutionUpdate already created the trade from the entry fill,
                // enrich it with exact RiskManager metadata (SL/TP/RU) instead of skipping.
                // This mirrors the OnRiskManagerEntry Case A enrich path so RM data isn't lost
                // when the bridge fires before PositionUpdate but after OnExecutionUpdate.
                OpenTradeState existingState;
                if (_openTrades.TryGetValue(key, out existingState))
                {
                    existingState.EntryPrice = args.EntryPrice;
                    existingState.Quantity = args.Quantity;
                    existingState.SignalName = "RiskMgr Entry";
                    existingState.InitialStopPrice = args.StopPrice;
                    existingState.StopWasEstimated = false;
                    existingState.InitialTpPrice = args.TargetPrice;
                    existingState.TpWasDetected = true;
                    existingState.HighestPriceSinceEntry = args.EntryPrice;
                    existingState.LowestPriceSinceEntry = args.EntryPrice;
                    existingState.IsRiskManagerTrade = true;
                    existingState.RiskUnits = args.RiskUnits;
                    existingState.RuValue = args.RuValue;
                    existingState.AtrMultiplier = args.AtrMultiplier;
                    existingState.RRMultiplier = args.RRMultiplier;
                    existingState.SlMode = args.SlMode ?? "";

                    // Clean up pending buffers — bridge provided exact values
                    _pendingStopPrices.Remove(key);
                    _pendingTpPrices.Remove(key);

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: ProcessRiskManagerEntry enriched existing trade — {0} {1} @ {2:F2}",
                            existingState.Direction, args.InstrumentFullName, args.EntryPrice),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    return;
                }

                // Get/create tagger for market context using the resolved instrument
                MarketContextTagger tagger = GetOrCreateTagger(instrument);
                MarketContext context = tagger.GetContextSnapshot();

                string directionStr = args.IsLong ? "Long" : "Short";

                // Create OpenTradeState with exact data from RiskManager — no guessing.
                // RealEntryTime captures actual wall-clock time; EntryTime is from the RM fill args
                // and may be a playback bar timestamp in simulation mode.
                var state = new OpenTradeState
                {
                    EntryTime = args.EntryTime,
                    RealEntryTime = DateTime.Now,
                    Instrument = args.InstrumentFullName,
                    Direction = directionStr,
                    EntryPrice = args.EntryPrice,
                    Quantity = args.Quantity,
                    SignalName = "RiskMgr Entry",
                    AccountName = args.AccountName,
                    InitialStopPrice = args.StopPrice,
                    StopWasEstimated = false,        // Exact SL from RiskManager bracket
                    InitialTpPrice = args.TargetPrice,
                    TpWasDetected = true,            // Exact TP from RiskManager bracket
                    HighestPriceSinceEntry = args.EntryPrice,
                    LowestPriceSinceEntry = args.EntryPrice,
                    EntryContext = context,
                    // RiskManager-specific metadata
                    IsRiskManagerTrade = true,
                    RiskUnits = args.RiskUnits,
                    RuValue = args.RuValue,
                    AtrMultiplier = args.AtrMultiplier,
                    RRMultiplier = args.RRMultiplier,
                    SlMode = args.SlMode ?? ""
                };

                _openTrades[key] = state;

                // POST partial row to Supabase immediately at entry time.
                // If exit event chain fails, the trade still exists with entry data.
                // On success, state.EntryWrittenToSupabase = true → exit uses PATCH.
                // On failure, flag stays false → exit falls back to full POST.
                _supabaseWriter.WriteEntryAsync(state);

                // Fire bridge event so TradeTagger can display the open trade immediately
                TradeTrackerBridge.FireTradeOpened(new TradeOpenedArgs
                {
                    EntryTime = args.EntryTime,
                    Instrument = args.InstrumentFullName,
                    Direction = directionStr,
                    AccountName = args.AccountName,
                    EntryPrice = args.EntryPrice,
                    StopPrice = args.StopPrice,
                    TargetPrice = args.TargetPrice
                });

                // Sync position state so OnPositionUpdate doesn't re-process
                _lastPositionState[key] = args.IsLong ? MarketPosition.Long : MarketPosition.Short;

                // Clear any stale buffered stop/TP prices — bridge provides exact values
                _pendingStopPrices.Remove(key);
                _pendingTpPrices.Remove(key);

                // Update last known time for playback-safe timestamps
                _lastKnownTime[args.InstrumentFullName] = args.EntryTime;

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: RiskManager entry processed — {0} {1} @ {2:F2}, SL={3:F2}, TP={4:F2}, RU={5:F2}",
                        directionStr, args.InstrumentFullName, args.EntryPrice,
                        args.StopPrice, args.TargetPrice, args.RiskUnits),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error processing RiskManager entry — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Handles RiskManager exit events. Enqueues a synthetic exit fill and calls
        /// the existing HandleTradeExit to reuse all P&L/RR/MFE/MAE/JSON/Supabase logic.
        /// Sets _recentExitTime to suppress any subsequent NinjaTrader flatten executions.
        /// </summary>
        private void OnRiskManagerExit(RiskMgrExitFillArgs args)
        {
            try
            {
                string key = string.Format("{0}|{1}", args.AccountName, args.InstrumentFullName);

                // Check if we have an open trade for this key
                OpenTradeState state;
                if (!_openTrades.TryGetValue(key, out state))
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: RiskManager exit — no open trade for {0}, ignoring", key),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    return;
                }

                // Resolve instrument for HandleTradeExit
                NinjaTrader.Cbi.Instrument instrument = ResolveInstrument(args.InstrumentFullName);
                if (instrument == null)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: RiskManager exit — could not resolve instrument {0}", args.InstrumentFullName),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    return;
                }

                // Resolve account for HandleTradeExit
                Account account = null;
                foreach (Account acct in _subscribedAccounts)
                {
                    if (acct.Name == args.AccountName)
                    {
                        account = acct;
                        break;
                    }
                }
                if (account == null)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTracker: RiskManager exit — could not resolve account {0}", args.AccountName),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    return;
                }

                // Enqueue a synthetic exit fill so HandleTradeExit can dequeue it
                // (reuses the existing exit price resolution logic)
                var syntheticExit = new ExecutionInfo
                {
                    Price = args.ExitPrice,
                    Time = args.ExitTime,
                    Quantity = state.Quantity,
                    SignalName = "RiskMgr " + args.ExitReason,
                    Direction = state.Direction == "Long" ? MarketPosition.Short : MarketPosition.Long
                };
                EnqueueExecution(key, syntheticExit);

                // Update last known time before exit processing
                _lastKnownTime[args.InstrumentFullName] = args.ExitTime;

                // Reuse existing HandleTradeExit — all P&L, RR, MFE/MAE, JSON, Supabase logic
                HandleTradeExit(account, instrument, key);

                // Sync position state to flat
                _lastPositionState[key] = MarketPosition.Flat;

                // Set recent exit time — prevents subsequent NinjaTrader flatten executions
                // (which don't use "RiskMgr" signal names) from creating phantom entries
                _recentExitTime[key] = args.ExitTime;

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: RiskManager exit — {0} {1} @ {2:F2}, reason: {3}",
                        state.Direction, args.InstrumentFullName, args.ExitPrice, args.ExitReason),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error in RiskManager exit handler — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── Bar Buffer (fed by LiveBridge.BarCompletedEvent) ──────────────────

        /// <summary>
        /// Appends a completed bar to the per-instrument ring buffer. Fires on both the
        /// warmup sweep (≤1000 historical bars when LiveBridge starts) and on every
        /// real-time bar close. Deduplicates by bar_time so warmup + real-time overlap
        /// doesn't pollute the buffer.
        /// </summary>
        private void OnLiveBridgeBarCompleted(string instrument, string timeframe,
            DateTime barTime, double open, double high, double low, double close, long volume)
        {
            if (string.IsNullOrEmpty(instrument)) return;

            lock (_barBufferLock)
            {
                List<BufferedBar> buf;
                if (!_barBuffers.TryGetValue(instrument, out buf))
                {
                    buf = new List<BufferedBar>(BAR_BUFFER_CAPACITY);
                    _barBuffers[instrument] = buf;
                }

                // Skip if we already have a bar at this exact time (warmup can replay bars
                // we already saw during a prior LiveBridge lifecycle).
                if (buf.Count > 0 && buf[buf.Count - 1].Time >= barTime)
                {
                    if (buf[buf.Count - 1].Time == barTime) return;
                    // Out-of-order arrival — rare; skip rather than sort on hot path.
                    return;
                }

                buf.Add(new BufferedBar
                {
                    Time = barTime,
                    Open = open,
                    High = high,
                    Low = low,
                    Close = close,
                    Volume = volume,
                });

                // Trim to capacity from the front (oldest).
                if (buf.Count > BAR_BUFFER_CAPACITY)
                {
                    int remove = buf.Count - BAR_BUFFER_CAPACITY;
                    buf.RemoveRange(0, remove);
                }
            }
        }

        /// <summary>
        /// Slices the ring buffer into the TradeBarData list that wraps around this trade
        /// (25 bars before the entry bar through the most recent completed bar), assigns
        /// trade-local bar_index, and marks the entry/exit bar flags.
        ///
        /// Returns an empty list if the instrument isn't being streamed (LiveBridge only
        /// streams one instrument at a time) or the buffer is empty.
        /// </summary>
        private List<SupabaseWriter.TradeBarData> BuildTradeBarWindow(string instrument,
            DateTime entryTime, DateTime exitTime)
        {
            var result = new List<SupabaseWriter.TradeBarData>();

            lock (_barBufferLock)
            {
                List<BufferedBar> buf;
                if (!_barBuffers.TryGetValue(instrument, out buf) || buf.Count == 0)
                    return result;

                // Find the entry bar: the latest bar whose Time is <= entryTime.
                // (Bar time is typically the bar's open; the forming bar at entry time
                //  will become the "entry bar" once it closes and enters the buffer.)
                int entryIdx = -1;
                for (int i = buf.Count - 1; i >= 0; i--)
                {
                    if (buf[i].Time <= entryTime) { entryIdx = i; break; }
                }
                if (entryIdx < 0) return result; // no bars at or before entry — nothing useful to save

                // Find the exit bar: the latest bar whose Time is <= exitTime.
                int exitIdx = entryIdx;
                for (int i = buf.Count - 1; i >= entryIdx; i--)
                {
                    if (buf[i].Time <= exitTime) { exitIdx = i; break; }
                }

                int startIdx = Math.Max(0, entryIdx - BARS_BEFORE_ENTRY);
                int localIndex = 0;
                for (int i = startIdx; i <= exitIdx; i++)
                {
                    var b = buf[i];
                    result.Add(new SupabaseWriter.TradeBarData
                    {
                        BarIndex = localIndex,
                        BarTime = b.Time,
                        Open = b.Open,
                        High = b.High,
                        Low = b.Low,
                        Close = b.Close,
                        Volume = b.Volume,
                        IsEntryBar = (i == entryIdx),
                        IsExitBar = (i == exitIdx),
                    });
                    localIndex++;
                }
            }

            return result;
        }

        // ─── Cleanup ───────────────────────────────────────────────────────────

        /// <summary>
        /// Unsubscribes from all accounts, disposes taggers, and releases resources.
        /// Called when the AddOn is terminated (NinjaTrader shutdown or AddOn removed).
        /// </summary>
        private void Cleanup()
        {
            try
            {
                // Unsubscribe from account status updates
                Account.AccountStatusUpdate -= OnAccountStatusUpdate;

                // Unsubscribe from RiskManager bridge events
                RiskManagerBridge.OnTradeEntry -= OnRiskManagerEntry;
                RiskManagerBridge.OnTradeExit -= OnRiskManagerExit;

                // Unsubscribe from LiveBridge bar stream
                LiveBridge.BarCompletedEvent -= OnLiveBridgeBarCompleted;

                // Unsubscribe from all monitored accounts
                foreach (Account account in _subscribedAccounts)
                {
                    account.ExecutionUpdate -= OnExecutionUpdate;
                    account.PositionUpdate -= OnPositionUpdate;
                    account.OrderUpdate -= OnOrderUpdate;
                }
                _subscribedAccounts.Clear();

                // Dispose all market context taggers
                foreach (var tagger in _taggers.Values)
                {
                    tagger.Dispose();
                }
                _taggers.Clear();

                // Clear open trade state and post-exit monitoring
                _openTrades.Clear();
                _postExitTrades.Clear();
                _lastPositionState.Clear();
                _executionQueues.Clear();
                _lastKnownTime.Clear();
                _recentExitTime.Clear();
                _pendingStopPrices.Clear();
                _pendingTpPrices.Clear();
                _pendingRiskMgrEntry.Clear();

                lock (_barBufferLock)
                {
                    if (_barBuffers != null) _barBuffers.Clear();
                }

                NinjaTrader.Code.Output.Process(
                    "TradeTracker: Terminated — all subscriptions removed",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTracker: Error during cleanup — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }
    }

    /// <summary>
    /// Unified container for any execution fill data (entry or exit).
    /// Stored in a FIFO queue per account+instrument. PositionUpdate handlers
    /// dequeue fills in order to correctly pair entries with exits, even when
    /// Strategy Analyzer fires multiple ExecutionUpdates before PositionUpdates.
    /// </summary>
    public class ExecutionInfo
    {
        /// <summary>The fill price of the execution</summary>
        public double Price { get; set; }

        /// <summary>The timestamp of the fill</summary>
        public DateTime Time { get; set; }

        /// <summary>The quantity filled</summary>
        public int Quantity { get; set; }

        /// <summary>Strategy signal name (e.g., "Entry", "Exit", custom name)</summary>
        public string SignalName { get; set; }

        /// <summary>The market position direction of this execution (Long/Short)</summary>
        public MarketPosition Direction { get; set; }
    }
}
