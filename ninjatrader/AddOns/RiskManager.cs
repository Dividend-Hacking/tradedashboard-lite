#region Using declarations
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using System.Xml.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// Static bridge class for communication between the RiskManager AddOn and the
    /// RiskManagerLink indicator. The indicator has direct chart access (ChartPanel,
    /// ChartControl) that AddOns lack — especially for tabbed charts. This bridge
    /// uses static events and flags to coordinate SL click capture between the two.
    ///
    /// Flow:
    /// 1. Indicator loads on chart → fires OnLinked (instrument, timeframe)
    /// 2. User clicks Buy in Manual SL mode → AddOn sets WaitingForSlClick = true
    /// 3. Indicator sees flag, captures next left-click → fires SlPriceSelected(price)
    /// 4. AddOn receives price, submits bracket order
    /// </summary>
    public static class RiskManagerBridge
    {
        // ─── Instance tracking ───────────────────────────────────────────────
        // Tracks which indicator instances are currently linked, keyed by unique instance ID.
        // This prevents a temporary preview instance's Terminated state from clearing
        // the link when a real instance is still alive on the chart.
        private static readonly Dictionary<string, LinkInfo> _linkedInstances = new Dictionary<string, LinkInfo>();
        private static readonly object _lock = new object();

        /// <summary>
        /// Stores instrument and timeframe info for a linked indicator instance.
        /// </summary>
        public class LinkInfo
        {
            public string Instrument { get; set; }
            public string Timeframe { get; set; }
        }

        // Indicator → AddOn: chart linked/unlinked notifications
        public static event Action<string, string> OnLinked;    // (instrumentFullName, timeframe)
        public static event Action<string> OnUnlinked;          // (instrumentFullName)

        // AddOn → Indicator: signal that we're waiting for a chart click
        public static volatile bool WaitingForSlClick;
        public static string WaitingInstrument;                  // which instrument to listen for

        // Indicator → AddOn: SL price selected or cancelled
        public static event Action<double> SlPriceSelected;
        public static event Action SlCancelled;

        /// <summary>
        /// Called by indicator instances to register as linked. Adds to the instance
        /// dictionary and fires OnLinked. Multiple instances can be linked simultaneously;
        /// a temp preview instance won't break things because we track by unique ID.
        /// </summary>
        public static void FireLinked(string instanceId, string instrument, string tf)
        {
            lock (_lock)
            {
                _linkedInstances[instanceId] = new LinkInfo { Instrument = instrument, Timeframe = tf };
            }
            OnLinked?.Invoke(instrument, tf);
        }

        /// <summary>
        /// Called by indicator instances when they terminate. Removes from the dictionary
        /// and only fires OnUnlinked if NO other instances remain for that instrument.
        /// This is the key fix — a temp preview instance terminating won't nuke the real link.
        /// </summary>
        public static void FireUnlinked(string instanceId, string instrument)
        {
            lock (_lock)
            {
                _linkedInstances.Remove(instanceId);
            }

            // Debounce: NinjaTrader destroys the preview instance BEFORE creating
            // the real instance when closing the Indicators dialog. Wait briefly
            // then re-check — if a real instance registered during the delay, skip the event.
            System.Threading.Tasks.Task.Delay(1500).ContinueWith(_ =>
            {
                bool shouldFireEvent = false;
                lock (_lock)
                {
                    shouldFireEvent = !_linkedInstances.Values.Any(li =>
                        string.Equals(li.Instrument, instrument, StringComparison.OrdinalIgnoreCase));
                }
                if (shouldFireEvent)
                    OnUnlinked?.Invoke(instrument);
            });
        }

        /// <summary>
        /// Query method for the AddOn to check if any instance is currently linked.
        /// Useful on startup when the indicator may have loaded before the AddOn window opened.
        /// Returns true if at least one instance is linked, with the instrument/timeframe of the first found.
        /// </summary>
        public static bool HasLinkedInstance(out string instrument, out string timeframe)
        {
            lock (_lock)
            {
                if (_linkedInstances.Count > 0)
                {
                    var first = _linkedInstances.Values.First();
                    instrument = first.Instrument;
                    timeframe = first.Timeframe;
                    return true;
                }
            }
            instrument = null;
            timeframe = null;
            return false;
        }

        public static void FireSlSelected(double price) { WaitingForSlClick = false; SlPriceSelected?.Invoke(price); }
        public static void FireSlCancelled() { WaitingForSlClick = false; SlCancelled?.Invoke(); }

        // ─── Trade Lifecycle Events (RiskManager → TradeTracker) ────────────────
        // These events allow RiskManager to report trades directly to TradeTracker,
        // bypassing the execution-based inference that causes phantom double-counting.
        // RiskManager has exact knowledge of entry/exit/SL/TP/RU — no guessing needed.

        /// <summary>Fired when a RiskManager entry order fills, carrying all bracket metadata</summary>
        public static event Action<RiskMgrEntryFillArgs> OnTradeEntry;

        /// <summary>Fired when a RiskManager exit order fills (stop, target, or flatten)</summary>
        public static event Action<RiskMgrExitFillArgs> OnTradeExit;

        /// <summary>Fires the trade entry event to all subscribers (TradeTracker)</summary>
        public static void FireTradeEntry(RiskMgrEntryFillArgs args)
        {
            // Diagnostic logging to confirm the bridge fires and has subscribers
            NinjaTrader.Code.Output.Process(
                string.Format("RiskManagerBridge: Firing TradeEntry for {0}, subscribers={1}",
                    args.InstrumentFullName, OnTradeEntry != null ? "yes" : "NONE"),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            OnTradeEntry?.Invoke(args);
        }

        /// <summary>Fires the trade exit event to all subscribers (TradeTracker)</summary>
        public static void FireTradeExit(RiskMgrExitFillArgs args) { OnTradeExit?.Invoke(args); }
    }

    /// <summary>
    /// Event args for a RiskManager entry fill. Contains all bracket metadata
    /// so TradeTracker can create an OpenTradeState with exact values (no estimation).
    /// </summary>
    public class RiskMgrEntryFillArgs
    {
        public string AccountName { get; set; }
        public string InstrumentFullName { get; set; }
        public bool IsLong { get; set; }
        public int Quantity { get; set; }
        public double EntryPrice { get; set; }
        public DateTime EntryTime { get; set; }
        public double StopPrice { get; set; }
        public double TargetPrice { get; set; }
        public double Atr { get; set; }
        public double AtrMultiplier { get; set; }
        public double RRMultiplier { get; set; }
        public double RiskUnits { get; set; }
        public double RuValue { get; set; }
        public string SlMode { get; set; }  // "ATR" or "Manual"
    }

    /// <summary>
    /// Event args for a RiskManager exit fill. Carries exit price/time and reason
    /// so TradeTracker can close the trade without inferring from raw executions.
    /// </summary>
    public class RiskMgrExitFillArgs
    {
        public string AccountName { get; set; }
        public string InstrumentFullName { get; set; }
        public double ExitPrice { get; set; }
        public DateTime ExitTime { get; set; }
        public string ExitReason { get; set; }  // "Stop", "Target", or "Flatten"
    }

    // ─── TradeTracker → TradeTagger Bridge ────────────────────────────────────
    // Separate from RiskManagerBridge — different data flow direction.
    // RiskManagerBridge: RiskManager → TradeTracker (bracket metadata at entry/exit)
    // TradeTrackerBridge: TradeTracker → TradeTagger (completed trade summary for tagging UI)

    /// <summary>
    /// Static bridge for TradeTracker to notify TradeTagger when a trade completes.
    /// TradeTagger subscribes to OnTradeCompleted to auto-navigate to the latest trade.
    /// </summary>
    public static class TradeTrackerBridge
    {
        /// <summary>Fired after TradeTracker finishes logging a completed trade to Supabase</summary>
        public static event Action<TradeCompletedArgs> OnTradeCompleted;

        /// <summary>Fires the trade completed event to all subscribers (TradeTagger)</summary>
        public static void FireTradeCompleted(TradeCompletedArgs args) { OnTradeCompleted?.Invoke(args); }

        /// <summary>Fired when a new trade is opened — TradeTagger shows it as in-play</summary>
        public static event Action<TradeOpenedArgs> OnTradeOpened;

        /// <summary>Fires the trade opened event to all subscribers (TradeTagger)</summary>
        public static void FireTradeOpened(TradeOpenedArgs args) { OnTradeOpened?.Invoke(args); }
    }

    /// <summary>
    /// Lightweight summary of an opened trade — entry-only fields for TradeTagger
    /// to display while the trade is still in play (before exit data is available).
    /// </summary>
    public class TradeOpenedArgs
    {
        public DateTime EntryTime { get; set; }
        public string Instrument { get; set; }
        public string Direction { get; set; }
        public string AccountName { get; set; }
        public double EntryPrice { get; set; }
        public double StopPrice { get; set; }
        public double TargetPrice { get; set; }
    }

    /// <summary>
    /// Lightweight summary of a completed trade — just what TradeTagger needs to display.
    /// Populated by TradeTracker in HandleTradeExit after the Supabase write.
    /// </summary>
    public class TradeCompletedArgs
    {
        public DateTime EntryTime { get; set; }
        public DateTime ExitTime { get; set; }
        public string Instrument { get; set; }
        public string Direction { get; set; }
        public string AccountName { get; set; }
        public double EntryPrice { get; set; }
        public double ExitPrice { get; set; }
        public double PnlPoints { get; set; }
        public double PnlDollars { get; set; }
        public double ActualRR { get; set; }
    }

    /// <summary>
    /// RiskManager — Bootstrap AddOn that injects a "Risk Manager" menu item
    /// into the Control Center's "New" menu. When clicked, opens RiskManagerWindow.
    /// This class is intentionally minimal — all logic lives in RiskManagerWindow.
    /// </summary>
    public class RiskManager : AddOnBase
    {
        // Reference to the menu item so we can remove it on cleanup
        private NTMenuItem _menuItem;

        /// <summary>
        /// AddOn lifecycle — set metadata in SetDefaults.
        /// </summary>
        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    Name = "RiskManager";
                    Description = "Manual trading risk manager with ATR-based SL/TP and one-click bracket orders";
                    break;
            }
        }

        /// <summary>
        /// Called when any NinjaTrader window is created. We look for the Control Center
        /// window and inject our menu item into its "New" menu.
        /// </summary>
        protected override void OnWindowCreated(Window window)
        {
            // Set WorkspaceOptions on RiskManagerWindow instances so NinjaTrader
            // can save/restore this window type when saving/restoring workspaces.
            if (window is RiskManagerWindow rmWindow)
                rmWindow.WorkspaceOptions = new WorkspaceOptions("RiskManager-" + Guid.NewGuid().ToString("N"), rmWindow);

            // The Control Center is the main NinjaTrader window
            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null)
                return;

            // Guard against duplicate insertion — if we already have a menu item
            // (e.g., after F5 recompile triggers OnWindowCreated again), skip adding another
            if (_menuItem != null)
                return;

            // Find the "New" menu in the Control Center's menu bar
            NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null)
                return;

            // Create our custom menu item with NinjaTrader's standard styling
            _menuItem = new NTMenuItem()
            {
                Header = "Risk Manager",
                Style = Application.Current.TryFindResource("SubItemStyle") as Style
            };
            _menuItem.Click += OnMenuItemClick;

            // Insert into the "New" menu
            newMenu.Items.Add(_menuItem);
        }

        /// <summary>
        /// Called when any NinjaTrader window is destroyed. Remove our menu item
        /// from the Control Center if it's closing.
        /// </summary>
        protected override void OnWindowDestroyed(Window window)
        {
            if (_menuItem != null && window is ControlCenter)
            {
                // Actually remove the menu item from the "New" menu to prevent stale entries
                ControlCenter controlCenter = window as ControlCenter;
                NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
                if (newMenu != null)
                    newMenu.Items.Remove(_menuItem);

                // Remove event handler and null the reference
                _menuItem.Click -= OnMenuItemClick;
                _menuItem = null;
            }
        }

        /// <summary>
        /// Menu click handler — opens a new RiskManagerWindow instance.
        /// </summary>
        private void OnMenuItemClick(object sender, RoutedEventArgs e)
        {
            // Create and show the Risk Manager window on the UI thread
            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                new RiskManagerWindow().Show();
            }));
        }
    }

    /// <summary>
    /// RiskManagerWindow — Floating NTWindow for manual trade risk management.
    ///
    /// Features:
    /// - ATR(14) calculation via BarsRequest (5-minute bars, Wilder smoothing)
    /// - Adjustable ATR multiplier for SL distance (free-text input, any value)
    /// - Optional trailing stop that moves SL to track price at ATR*mult distance
    /// - Auto position sizing based on risk dollars and ATR
    /// - SL/TP calculation using ATR with configurable reward:risk ratio
    /// - One-click bracket order submission (market entry + OCO stop/target)
    /// - Close Orders / Flatten buttons for quick exit management
    /// - Live Open P&L tracking from account positions
    /// - Session stats from local TradeTracker JSON files: P&L, win rate, avg RR, EV, streak, drawdown
    ///
    /// Supports ES, NQ, MNQ, MES and any other NinjaTrader instrument.
    ///
    /// Thread safety: BarsRequest callbacks and MarketDataUpdate fire on non-UI threads.
    /// All UI updates go through Dispatcher.InvokeAsync(). A _isDisposed guard prevents
    /// callbacks from touching disposed resources.
    /// </summary>
    public class RiskManagerWindow : NTWindow, IWorkspacePersistence
    {
        // ─── Constants ─────────────────────────────────────────────────────────
        private const int ATR_PERIOD = 14;
        private const int BARS_REQUESTED = 20; // Enough for ATR(14) + warmup with prev close

        // Stats refresh interval in seconds
        private const int STATS_REFRESH_INTERVAL_SECONDS = 60;

        // ─── Workspace Persistence ────────────────────────────────────────────
        // IWorkspacePersistence lets NinjaTrader save/restore this window with workspace files.
        public WorkspaceOptions WorkspaceOptions { get; set; }

        // ─── Template System ──────────────────────────────────────────────────
        // Templates persist user-configured RiskManager settings to JSON files on disk.
        // _lastUsed.txt stores the name of the most recently loaded template for auto-restore.
        private static readonly object _templateLock = new object();
        private ComboBox _templateCombo;        // Dropdown listing saved template names
        private bool _isLoadingTemplate = false; // Guard flag to prevent double-triggers during template load

        // ─── UI Controls ───────────────────────────────────────────────────────
        private AccountSelector _accountSelector;
        private InstrumentSelector _instrumentSelector;
        private TextBox _ruValueInput;  // Dollar value of 1 Risk Unit — the only place real dollars exist in the UI
        private TextBox _riskRuInput;   // How many RUs to risk per trade (default 1)
        private ComboBox _rrCombo;
        private TextBox _atrMultInput; // ATR multiplier free-text input for SL distance adjustment
        private CheckBox _trailStopCheckbox; // When checked, continuously trail the SL at ATR*mult distance
        private ComboBox _slModeCombo; // ATR vs Manual SL mode toggle
        private StackPanel _atrMultPanel; // Panel containing ATR mult controls, hidden in Manual mode
        private Button _buyButton; // Buy Long button — stored for text/color changes during manual SL wait
        private Button _sellButton; // Sell Short button — stored for text/color changes during manual SL wait

        // Display labels for calculated values
        private TextBlock _atrLabel;
        private TextBlock _lastPriceLabel;
        private TextBlock _qtyLabel;
        private TextBox _maxQtyInput; // Max contracts cap — 0 means no cap
        private TextBlock _longSlLabel;
        private TextBlock _shortSlLabel;
        private TextBlock _longTpLabel;
        private TextBlock _shortTpLabel;

        // Stats display labels — populated from local TradeTracker JSON files
        private TextBlock _dailyPnlLabel;
        private TextBlock _openPnlLabel;
        private TextBlock _winRateLabel;
        private TextBlock _avgRrLabel;
        private TextBlock _evLabel;
        private TextBlock _streakLabel;
        private TextBlock _sessionDdLabel;
        private TextBlock _trailingDdLabel;
        private TextBlock _currentRrLabel; // Live current RR ratio during active trade

        // ─── ATR Calculation State ─────────────────────────────────────────────
        // Wilder smoothing for ATR(14), same algorithm as MarketContextTagger
        private BarsRequest _barsRequest;
        private double _atr;
        private bool _atrInitialized;
        private double _atrSum;
        private int _atrCount;
        private double _prevClose;
        private bool _hasPrevClose;
        private bool _historicalBarsProcessed;
        private int _lastHistoricalBarIndex;

        // ─── Market Data ───────────────────────────────────────────────────────
        private double _lastPrice;
        private NinjaTrader.Cbi.Instrument _currentInstrument;
        private bool _isDisposed;

        // ─── Pending Bracket State ────────────────────────────────────────────
        // Tracks a pending bracket order between entry submission and fill.
        // When the entry fills, we use the actual fill price to place SL/TP.
        private PendingBracketState _pendingBracket;
        private bool _isSubscribedToOrderUpdate;

        // ─── Active Trade State (for trailing stop) ──────────────────────────
        // Tracks a live position after entry fills so trailing stop can modify the SL.
        // Set when entry fills with trail enabled, cleared when SL/TP fills or position closes.
        private ActiveTradeState _activeTrade;
        // Cached from UI checkbox — bool read/write is atomic, safe for cross-thread access
        private bool _trailEnabled;

        // ─── Manual SL Placement State (via RiskManagerBridge) ──────────────
        // When in Manual SL mode, the RiskManagerLink indicator captures chart clicks.
        // Direction stored when Buy/Sell clicked, bridge handles the chart interaction.
        private bool _manualSlIsLong; // Direction stored when Buy/Sell clicked in manual mode

        // ─── Chart Link Status ────────────────────────────────────────────────
        // Shows whether a RiskManagerLink indicator is active on a chart
        private TextBlock _linkStatusLabel; // Shows "Linked: MNQ 03-26 (5 Min)" or "No chart linked"
        private bool _isLinked; // Whether a chart is currently linked via the bridge

        // ─── Stats State ──────────────────────────────────────────────────────
        // Guard to prevent overlapping stats refreshes
        private bool _isRefreshing;
        // Timer for periodic stats refresh
        private DispatcherTimer _statsTimer;
        // When set, ReadLocalTrades skips trades with exitTime before this cutoff.
        // Allows user to "clear" stats mid-session and track from a clean slate.
        private DateTime? _statsClearTime;

        /// <summary>
        /// Holds bracket order parameters between entry submission and fill callback.
        /// Stored when the market entry is submitted, consumed when the fill arrives.
        /// </summary>
        private class PendingBracketState
        {
            public bool IsLong { get; set; }          // Direction: true=long, false=short
            public int Quantity { get; set; }          // Number of contracts
            public double Atr { get; set; }            // ATR value at time of submission
            public double AtrMultiplier { get; set; }  // ATR multiplier for SL distance
            public double RRMultiplier { get; set; }   // Reward:risk multiplier (e.g., 2.0)
            public Account Account { get; set; }       // Account for submitting exit orders
            public Order EntryOrder { get; set; }      // Reference to the entry order for matching
            public double ManualSlPrice { get; set; }  // >0 when manual SL mode used; 0 = ATR mode
            public double RiskUnits { get; set; }      // Number of RUs risked (from UI input)
            public double RuValue { get; set; }        // Dollar value of 1 RU (from UI input)
        }

        /// <summary>
        /// Tracks a live position for trailing stop functionality.
        /// Stored after entry fills, cleared when SL/TP fills or position closes.
        /// </summary>
        private class ActiveTradeState
        {
            public bool IsLong { get; set; }          // Direction: true=long, false=short
            public double SlDistance { get; set; }     // ATR * atrMult at entry time (in points)
            public Account Account { get; set; }       // Account for modifying orders
            public Order StopOrder { get; set; }       // Live reference to the working SL order
            public Order TargetOrder { get; set; }     // Live reference to the working TP order (for current RR display)
            public double EntryPrice { get; set; }     // Fill price at entry (for current RR calculation)
        }

        /// <summary>
        /// Creates and displays the Risk Manager window with all UI elements.
        /// Sets up the WPF layout programmatically (no XAML).
        /// </summary>
        public RiskManagerWindow()
        {
            // Window configuration — expanded height for stats section
            Caption = "Risk Manager";
            Width = 370;
            Height = 700;

            // Build the entire UI programmatically
            BuildUI();

            // Wire up events after UI is built
            _instrumentSelector.InstrumentChanged += OnInstrumentChanged;
            _ruValueInput.TextChanged += OnParameterChanged;
            _riskRuInput.TextChanged += OnParameterChanged;
            _rrCombo.SelectionChanged += OnParameterChanged;
            _atrMultInput.TextChanged += OnParameterChanged;
            _maxQtyInput.TextChanged += OnParameterChanged;

            // Subscribe to RiskManagerBridge events for chart link status and SL click capture
            RiskManagerBridge.OnLinked += OnBridgeLinked;
            RiskManagerBridge.OnUnlinked += OnBridgeUnlinked;
            RiskManagerBridge.SlPriceSelected += OnBridgeSlPriceSelected;
            RiskManagerBridge.SlCancelled += OnBridgeSlCancelled;

            // Check if an indicator instance is already linked (handles case where
            // the indicator loaded before this AddOn window was opened)
            string existingInstrument, existingTimeframe;
            if (RiskManagerBridge.HasLinkedInstance(out existingInstrument, out existingTimeframe))
            {
                OnBridgeLinked(existingInstrument, existingTimeframe);
            }

            // Start the periodic stats refresh timer (60-second interval)
            _statsTimer = new DispatcherTimer();
            _statsTimer.Interval = TimeSpan.FromSeconds(STATS_REFRESH_INTERVAL_SECONDS);
            _statsTimer.Tick += (s, e) => RefreshStatsAsync();
            _statsTimer.Start();

            // ── Template auto-load ──
            // Populate the template combo with saved templates, then restore
            // the last-used template if one exists. Guard with _isLoadingTemplate
            // to prevent the combo's SelectionChanged from double-firing.
            RefreshTemplateCombo();
            string lastUsed = GetLastUsedTemplateName();
            if (!string.IsNullOrEmpty(lastUsed))
            {
                _isLoadingTemplate = true;
                for (int i = 0; i < _templateCombo.Items.Count; i++)
                {
                    if ((string)_templateCombo.Items[i] == lastUsed)
                    {
                        _templateCombo.SelectedIndex = i;
                        break;
                    }
                }
                LoadTemplate(lastUsed);
                _isLoadingTemplate = false;
            }
        }

        // ─── UI Construction ───────────────────────────────────────────────────

        /// <summary>
        /// Builds the entire window layout using a WPF Grid.
        /// Row layout (23 rows total):
        ///   0:  Account, Instrument + Link Status
        ///   1:  Separator
        ///   2:  RU Value input (dollar value of 1 Risk Unit)
        ///   3:  Risk RU and RR inputs
        ///   4:  ATR Mult text input and Trail Stop checkbox
        ///   5:  Template save/load row
        ///   6:  Separator
        ///   7:  ATR and Last price display
        ///   8:  Qty and Point value display
        ///   9:  Long SL / Short SL
        ///   10: Long TP / Short TP
        ///   11: Separator
        ///   12: Buy Long / Sell Short buttons
        ///   13: Separator
        ///   14: Close Orders / Flatten buttons
        ///   15: Separator
        ///   16: "Session Stats" header + Refresh button
        ///   17: Daily P&L / Open P&L (live)
        ///   18: Win Rate / Avg RR
        ///   19: EV per Trade / Streak
        ///   20: Session DD / Trailing DD
        ///   21: Current RR
        ///   22: Chart link status display
        /// </summary>
        private void BuildUI()
        {
            // Main grid with 23 rows (includes template row)
            var grid = new Grid();
            grid.Margin = new Thickness(10);

            // Separator rows get fixed 10px height, all others auto-size
            // Rows 6, 11, 13, 15 are separators (shifted +1 from original due to template row at 5)
            var separatorRows = new HashSet<int> { 1, 6, 11, 13, 15 };
            for (int i = 0; i < 23; i++)
            {
                grid.RowDefinitions.Add(new RowDefinition
                {
                    Height = separatorRows.Contains(i)
                        ? new GridLength(10) // Separator rows
                        : new GridLength(1, GridUnitType.Auto)
                });
            }
            // Two columns for layout
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            // ── Row 0: Account, Instrument ──
            _accountSelector = new AccountSelector();
            _accountSelector.Margin = new Thickness(0, 0, 5, 5);
            Grid.SetRow(_accountSelector, 0);
            Grid.SetColumn(_accountSelector, 0);
            grid.Children.Add(_accountSelector);

            _instrumentSelector = new InstrumentSelector();
            _instrumentSelector.Margin = new Thickness(0, 0, 5, 5);
            Grid.SetRow(_instrumentSelector, 0);
            Grid.SetColumn(_instrumentSelector, 1);
            grid.Children.Add(_instrumentSelector);

            // ── Row 1: Separator ──
            AddSeparator(grid, 1);

            // ── Row 2: RU Value — dollar value of 1 Risk Unit (the only place dollars appear) ──
            var ruValuePanel = new StackPanel { Orientation = Orientation.Horizontal };
            ruValuePanel.Children.Add(new TextBlock
            {
                Text = "RU Value:",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0),
                Foreground = FindBrush("FontControlBrush")
            });
            _ruValueInput = new TextBox
            {
                Width = 70,
                Text = "100",
                VerticalAlignment = VerticalAlignment.Center
            };
            ruValuePanel.Children.Add(_ruValueInput);
            Grid.SetRow(ruValuePanel, 2);
            Grid.SetColumn(ruValuePanel, 0);
            grid.Children.Add(ruValuePanel);

            // ── Row 3: Risk RU and RR ──
            var riskPanel = new StackPanel { Orientation = Orientation.Horizontal };
            riskPanel.Children.Add(new TextBlock
            {
                Text = "Risk RU:",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0),
                Foreground = FindBrush("FontControlBrush")
            });
            _riskRuInput = new TextBox
            {
                Width = 70,
                Text = "1",
                VerticalAlignment = VerticalAlignment.Center
            };
            riskPanel.Children.Add(_riskRuInput);
            Grid.SetRow(riskPanel, 3);
            Grid.SetColumn(riskPanel, 0);
            grid.Children.Add(riskPanel);

            var rrPanel = new StackPanel { Orientation = Orientation.Horizontal };
            rrPanel.Children.Add(new TextBlock
            {
                Text = "RR:",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0),
                Foreground = FindBrush("FontControlBrush")
            });
            _rrCombo = new ComboBox
            {
                Width = 70,
                VerticalAlignment = VerticalAlignment.Center
            };
            // Common reward:risk ratios
            _rrCombo.Items.Add("1:1");
            _rrCombo.Items.Add("1:1.5");
            _rrCombo.Items.Add("1:2");
            _rrCombo.Items.Add("1:2.5");
            _rrCombo.Items.Add("1:3");
            _rrCombo.SelectedIndex = 0; // Default to 1:1
            rrPanel.Children.Add(_rrCombo);
            Grid.SetRow(rrPanel, 3);
            Grid.SetColumn(rrPanel, 1);
            grid.Children.Add(rrPanel);

            // ── Row 4: SL Mode combo + ATR Mult input (Col 0), Trail Stop checkbox (Col 1) ──
            // Col 0: SL Mode dropdown and ATR mult input side by side in a StackPanel.
            // When "Manual" is selected, ATR Mult controls collapse since SL is user-defined.
            var slModeRow = new StackPanel { Orientation = Orientation.Horizontal };

            // SL Mode label and combo
            slModeRow.Children.Add(new TextBlock
            {
                Text = "SL:",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 3, 0),
                Foreground = FindBrush("FontControlBrush")
            });
            _slModeCombo = new ComboBox
            {
                Width = 62,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0)
            };
            _slModeCombo.Items.Add("ATR");
            _slModeCombo.Items.Add("Manual");
            _slModeCombo.SelectedIndex = 1; // Default to Manual
            _slModeCombo.SelectionChanged += OnSlModeChanged;
            slModeRow.Children.Add(_slModeCombo);

            // ATR Mult controls in a collapsible panel — hidden when Manual mode is selected
            _atrMultPanel = new StackPanel { Orientation = Orientation.Horizontal };
            _atrMultPanel.Children.Add(new TextBlock
            {
                Text = "ATR Mult:",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0),
                Foreground = FindBrush("FontControlBrush")
            });
            _atrMultInput = new TextBox
            {
                Width = 50,
                Text = "1",
                VerticalAlignment = VerticalAlignment.Center
            };
            _atrMultPanel.Children.Add(_atrMultInput);
            // Collapse ATR mult panel by default since Manual SL mode is the default
            _atrMultPanel.Visibility = Visibility.Collapsed;
            slModeRow.Children.Add(_atrMultPanel);

            Grid.SetRow(slModeRow, 4);
            Grid.SetColumn(slModeRow, 0);
            grid.Children.Add(slModeRow);

            // Col 1: Trail Stop checkbox — when enabled, SL continuously trails price at ATR*mult distance
            _trailStopCheckbox = new CheckBox
            {
                Content = "Trail Stop",
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = FindBrush("FontControlBrush"),
                Margin = new Thickness(5, 0, 0, 0)
            };
            // Cache checkbox state to _trailEnabled for thread-safe reads in OnMarketDataUpdate
            _trailStopCheckbox.Checked += (s, ev) => _trailEnabled = true;
            _trailStopCheckbox.Unchecked += (s, ev) => _trailEnabled = false;
            Grid.SetRow(_trailStopCheckbox, 4);
            Grid.SetColumn(_trailStopCheckbox, 1);
            grid.Children.Add(_trailStopCheckbox);

            // ── Row 5: Template Save/Load ──
            // Allows users to save, load, and delete named preset configurations.
            // Templates persist RU value, risk RU, RR, SL mode, ATR mult, trail stop, and max qty.
            var templatePanel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin = new Thickness(0, 2, 0, 2)
            };

            // Template name dropdown — populated from saved JSON files on disk
            _templateCombo = new ComboBox
            {
                Width = 120,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0)
            };
            templatePanel.Children.Add(_templateCombo);

            // Save button — prompts for a name and writes current settings to a JSON template file
            var saveTemplateBtn = new Button
            {
                Content = "Save",
                Width = 50,
                Height = 24,
                Margin = new Thickness(0, 0, 3, 0)
            };
            saveTemplateBtn.Click += (s, ev) =>
            {
                string name = PromptTemplateName();
                if (!string.IsNullOrEmpty(name))
                {
                    SaveTemplate(name);
                    RefreshTemplateCombo();
                    // Select the just-saved template in the dropdown
                    for (int idx = 0; idx < _templateCombo.Items.Count; idx++)
                    {
                        if ((string)_templateCombo.Items[idx] == name)
                        {
                            _templateCombo.SelectedIndex = idx;
                            break;
                        }
                    }
                }
            };
            templatePanel.Children.Add(saveTemplateBtn);

            // Delete button — removes the currently selected template from disk and dropdown
            var deleteTemplateBtn = new Button
            {
                Content = "Delete",
                Width = 50,
                Height = 24
            };
            deleteTemplateBtn.Click += (s, ev) =>
            {
                string selected = _templateCombo.SelectedItem as string;
                if (!string.IsNullOrEmpty(selected))
                {
                    DeleteTemplate(selected);
                    RefreshTemplateCombo();
                }
            };
            templatePanel.Children.Add(deleteTemplateBtn);

            Grid.SetRow(templatePanel, 5);
            Grid.SetColumn(templatePanel, 0);
            Grid.SetColumnSpan(templatePanel, 2);
            grid.Children.Add(templatePanel);

            // Wire template combo selection — load the selected template when user picks one
            _templateCombo.SelectionChanged += (s, ev) =>
            {
                if (_isLoadingTemplate) return;
                string selected = _templateCombo.SelectedItem as string;
                if (!string.IsNullOrEmpty(selected))
                    LoadTemplate(selected);
            };

            // ── Row 6: Separator ──
            AddSeparator(grid, 6);

            // ── Row 7: ATR and Last Price ──
            _atrLabel = CreateInfoRow(grid, 7, 0, "ATR(14):", "—");
            _lastPriceLabel = CreateInfoRow(grid, 7, 1, "Last:", "—");

            // ── Row 8: Qty and Point Value ──
            _qtyLabel = CreateInfoRow(grid, 8, 0, "Qty:", "—");
            // Max Qty input — caps calculated quantity to prevent runaway sizing
            var maxQtyPanel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin = new Thickness(0, 2, 0, 2)
            };
            maxQtyPanel.Children.Add(new TextBlock
            {
                Text = "Max:",
                Width = 65,
                Foreground = FindBrush("FontControlBrush")
            });
            _maxQtyInput = new TextBox
            {
                Text = "0",
                Width = 50,
                Background = FindBrush("EditControlBackgroundBrush"),
                Foreground = FindBrush("FontControlBrush"),
                BorderBrush = FindBrush("BorderThinBrush")
            };
            maxQtyPanel.Children.Add(_maxQtyInput);
            Grid.SetRow(maxQtyPanel, 8);
            Grid.SetColumn(maxQtyPanel, 1);
            grid.Children.Add(maxQtyPanel);

            // ── Row 9: Long SL / Short SL ──
            _longSlLabel = CreateInfoRow(grid, 9, 0, "Long SL:", "—");
            _shortSlLabel = CreateInfoRow(grid, 9, 1, "Short SL:", "—");

            // ── Row 10: Long TP / Short TP ──
            _longTpLabel = CreateInfoRow(grid, 10, 0, "Long TP:", "—");
            _shortTpLabel = CreateInfoRow(grid, 10, 1, "Short TP:", "—");

            // ── Row 11: Separator ──
            AddSeparator(grid, 11);

            // ── Row 12: Buy Long / Sell Short buttons ──
            // Stored as class fields so text/color can be changed during manual SL wait mode
            _buyButton = new Button
            {
                Content = "BUY LONG",
                Background = Brushes.DarkGreen,
                Foreground = Brushes.White,
                FontWeight = FontWeights.Bold,
                Height = 35,
                Margin = new Thickness(0, 5, 5, 0)
            };
            _buyButton.Click += OnBuyLongClick;
            Grid.SetRow(_buyButton, 12);
            Grid.SetColumn(_buyButton, 0);
            grid.Children.Add(_buyButton);

            _sellButton = new Button
            {
                Content = "SELL SHORT",
                Background = Brushes.DarkRed,
                Foreground = Brushes.White,
                FontWeight = FontWeights.Bold,
                Height = 35,
                Margin = new Thickness(0, 5, 0, 0)
            };
            _sellButton.Click += OnSellShortClick;
            Grid.SetRow(_sellButton, 12);
            Grid.SetColumn(_sellButton, 1);
            grid.Children.Add(_sellButton);

            // ── Row 13: Separator ──
            AddSeparator(grid, 13);

            // ── Row 14: Close Orders / Flatten buttons ──
            var closeOrdersButton = new Button
            {
                Content = "CLOSE ORDERS",
                Background = Brushes.DarkOrange,
                Foreground = Brushes.White,
                FontWeight = FontWeights.Bold,
                Height = 35,
                Margin = new Thickness(0, 5, 5, 0)
            };
            closeOrdersButton.Click += OnCloseOrdersClick;
            Grid.SetRow(closeOrdersButton, 14);
            Grid.SetColumn(closeOrdersButton, 0);
            grid.Children.Add(closeOrdersButton);

            var flattenButton = new Button
            {
                Content = "FLATTEN",
                Background = new SolidColorBrush(Color.FromRgb(139, 0, 0)), // Dark red
                Foreground = Brushes.White,
                FontWeight = FontWeights.Bold,
                Height = 35,
                Margin = new Thickness(0, 5, 0, 0)
            };
            flattenButton.Click += OnFlattenClick;
            Grid.SetRow(flattenButton, 14);
            Grid.SetColumn(flattenButton, 1);
            grid.Children.Add(flattenButton);

            // ── Row 15: Separator ──
            AddSeparator(grid, 15);

            // ── Row 16: Session Stats header + Refresh button ──
            var statsHeader = new TextBlock
            {
                Text = "Session Stats",
                FontWeight = FontWeights.Bold,
                FontSize = 13,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = FindBrush("FontControlBrush")
            };
            Grid.SetRow(statsHeader, 16);
            Grid.SetColumn(statsHeader, 0);
            grid.Children.Add(statsHeader);

            // Clear + Refresh buttons side by side, right-aligned in col 1
            var statsButtonPanel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };

            // Clear button — resets stats cutoff time so only post-clear trades are shown
            var clearButton = new Button
            {
                Content = "Clear",
                Width = 70,
                Height = 24,
                Margin = new Thickness(0, 2, 4, 2)
            };
            clearButton.Click += (s, e) =>
            {
                _statsClearTime = DateTime.Now;
                RefreshStatsAsync();
            };
            statsButtonPanel.Children.Add(clearButton);

            var refreshButton = new Button
            {
                Content = "Refresh",
                Width = 70,
                Height = 24,
                Margin = new Thickness(0, 2, 0, 2)
            };
            refreshButton.Click += (s, e) => RefreshStatsAsync();
            statsButtonPanel.Children.Add(refreshButton);

            Grid.SetRow(statsButtonPanel, 16);
            Grid.SetColumn(statsButtonPanel, 1);
            grid.Children.Add(statsButtonPanel);

            // ── Row 17: Daily P&L / Open P&L ──
            _dailyPnlLabel = CreateInfoRow(grid, 17, 0, "Day P&L:", "—");
            _openPnlLabel = CreateInfoRow(grid, 17, 1, "Open:", "Flat");

            // ── Row 18: Win Rate / Avg RR ──
            _winRateLabel = CreateInfoRow(grid, 18, 0, "WR(30):", "—");
            _avgRrLabel = CreateInfoRow(grid, 18, 1, "Avg RR:", "—");

            // ── Row 19: EV per Trade / Streak ──
            _evLabel = CreateInfoRow(grid, 19, 0, "EV:", "—");
            _streakLabel = CreateInfoRow(grid, 19, 1, "Streak:", "—");

            // ── Row 20: Session DD / Trailing DD ──
            _sessionDdLabel = CreateInfoRow(grid, 20, 0, "Sess DD:", "—");
            _trailingDdLabel = CreateInfoRow(grid, 20, 1, "Trail DD:", "—");

            // ── Row 21: Current RR (live reward:risk ratio during active trade) ──
            _currentRrLabel = CreateInfoRow(grid, 21, 0, "Cur RR:", "—");

            // ── Row 22: Chart Link Status ──
            _linkStatusLabel = new TextBlock
            {
                Text = "No chart linked",
                FontSize = 11,
                Foreground = Brushes.Gray,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 4, 0, 0)
            };
            Grid.SetRow(_linkStatusLabel, 22);
            Grid.SetColumnSpan(_linkStatusLabel, 2);
            grid.Children.Add(_linkStatusLabel);

            // Set the grid as the window content
            Content = grid;
        }

        /// <summary>
        /// Adds a horizontal separator line to the specified grid row.
        /// Spans all columns for full-width separation.
        /// </summary>
        private void AddSeparator(Grid grid, int row)
        {
            var sep = new Separator { Margin = new Thickness(0, 3, 0, 3) };
            Grid.SetRow(sep, row);
            Grid.SetColumnSpan(sep, 2);
            grid.Children.Add(sep);
        }

        /// <summary>
        /// Creates a label + value display pair in the grid at the specified row/column.
        /// Returns the value TextBlock so it can be updated with calculated data.
        /// </summary>
        /// <param name="grid">Parent grid</param>
        /// <param name="row">Grid row index</param>
        /// <param name="col">Grid column index</param>
        /// <param name="label">Static label text (e.g., "ATR(14):")</param>
        /// <param name="defaultValue">Initial value text (typically "—")</param>
        /// <returns>The value TextBlock for dynamic updates</returns>
        private TextBlock CreateInfoRow(Grid grid, int row, int col, string label, string defaultValue)
        {
            var panel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin = new Thickness(0, 2, 0, 2)
            };
            panel.Children.Add(new TextBlock
            {
                Text = label,
                Width = 65,
                Foreground = FindBrush("FontControlBrush")
            });
            var valueBlock = new TextBlock
            {
                Text = defaultValue,
                FontWeight = FontWeights.SemiBold,
                Foreground = FindBrush("FontControlBrush")
            };
            panel.Children.Add(valueBlock);
            Grid.SetRow(panel, row);
            Grid.SetColumn(panel, col);
            grid.Children.Add(panel);
            return valueBlock;
        }

        /// <summary>
        /// Safely finds a named brush resource from the application resources.
        /// Falls back to white if the resource is not found (e.g., during design time).
        /// </summary>
        private Brush FindBrush(string resourceKey)
        {
            var brush = Application.Current.TryFindResource(resourceKey) as Brush;
            return brush ?? Brushes.White;
        }

        // ─── Instrument Change Handling ────────────────────────────────────────

        /// <summary>
        /// Called when the user selects a new instrument via the InstrumentSelector
        /// or when a linked chart changes instrument. Tears down the old BarsRequest
        /// and market data subscription, then sets up new ones for the selected instrument.
        /// Also triggers a stats refresh for the new instrument context.
        /// </summary>
        private void OnInstrumentChanged(object sender, EventArgs e)
        {
            // Resolve the new instrument from the selector
            var newInstrument = NinjaTrader.Cbi.Instrument.GetInstrument(
                _instrumentSelector.Instrument?.FullName);

            if (newInstrument == null)
                return;

            // Cancel any pending manual SL wait via the bridge
            if (RiskManagerBridge.WaitingForSlClick)
            {
                RiskManagerBridge.WaitingForSlClick = false;
                RestoreButtons();
            }

            // Tear down existing data connections for the old instrument
            DisposeBarsRequest();
            UnsubscribeMarketData();

            // Reset ATR calculation state for the new instrument
            _atr = 0;
            _atrInitialized = false;
            _atrSum = 0;
            _atrCount = 0;
            _prevClose = 0;
            _hasPrevClose = false;
            _historicalBarsProcessed = false;
            _lastHistoricalBarIndex = 0;
            _lastPrice = 0;

            // Store reference and start new data connections
            _currentInstrument = newInstrument;
            StartBarsRequest();
            SubscribeToMarketData();

            // Reset display to show we're loading
            UpdateDisplayValues();

            // Refresh stats for the new context
            RefreshStatsAsync();
        }

        // ─── BarsRequest for ATR Calculation ───────────────────────────────────

        /// <summary>
        /// Requests 20 bars of 5-minute data for the current instrument.
        /// The Request callback processes all historical bars through the ATR engine.
        /// After historical processing, the Update event handles real-time bar closes.
        /// Pattern copied from MarketContextTagger.StartBarsRequest().
        /// </summary>
        private void StartBarsRequest()
        {
            if (_currentInstrument == null) return;

            try
            {
                // Create bars request: 5-minute bars, 20 bars lookback (ATR(14) + warmup)
                _barsRequest = new BarsRequest(_currentInstrument, BARS_REQUESTED);
                _barsRequest.BarsPeriod = new BarsPeriod
                {
                    BarsPeriodType = BarsPeriodType.Minute,
                    Value = 5
                };
                // NOTE: Do NOT set TradingHours — let BarsRequest use the instrument's default.

                // Subscribe to real-time bar close updates
                _barsRequest.Update += OnBarsUpdate;

                // Request historical data — callback fires once with the full bar set
                _barsRequest.Request(new Action<BarsRequest, ErrorCode, string>((req, errorCode, errorMessage) =>
                {
                    if (_isDisposed) return;

                    if (errorCode != ErrorCode.NoError)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("RiskManager: BarsRequest error for {0} — {1}: {2}",
                                _currentInstrument.FullName, errorCode, errorMessage),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        int barCount = req.Bars != null ? req.Bars.Count : 0;

                        // Process every historical bar through the ATR engine
                        if (req.Bars != null && barCount > 0)
                        {
                            for (int i = 0; i < barCount; i++)
                            {
                                double close = req.Bars.GetClose(i);
                                double high = req.Bars.GetHigh(i);
                                double low = req.Bars.GetLow(i);
                                UpdateATR(high, low, close);
                                // Track previous close for next bar's true range calculation
                                _prevClose = close;
                                _hasPrevClose = true;
                            }
                            _lastHistoricalBarIndex = barCount - 1;
                        }

                        _historicalBarsProcessed = true;

                        NinjaTrader.Code.Output.Process(
                            string.Format("RiskManager: BarsRequest completed for {0} — {1} bars, ATR ready: {2}, ATR: {3:F2}",
                                _currentInstrument.FullName, barCount, _atrInitialized, _atr),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                        // Update UI on dispatcher thread
                        Dispatcher.InvokeAsync(new Action(UpdateDisplayValues));
                    }
                }));
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Failed to start BarsRequest for {0} — {1}",
                        _currentInstrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Handles real-time bar close updates. Skips bars already processed during
        /// historical load. Updates ATR and refreshes the display.
        /// </summary>
        private void OnBarsUpdate(object sender, BarsUpdateEventArgs e)
        {
            if (_isDisposed) return;
            if (!_historicalBarsProcessed) return;

            try
            {
                for (int i = e.MinIndex; i <= e.MaxIndex; i++)
                {
                    // Skip bars already processed during historical load
                    if (i <= _lastHistoricalBarIndex) continue;

                    double close = _barsRequest.Bars.GetClose(i);
                    double high = _barsRequest.Bars.GetHigh(i);
                    double low = _barsRequest.Bars.GetLow(i);
                    UpdateATR(high, low, close);
                    _prevClose = close;
                    _hasPrevClose = true;
                }

                // Refresh display on UI thread
                Dispatcher.InvokeAsync(new Action(UpdateDisplayValues));
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: OnBarsUpdate error — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Disposes the current BarsRequest and unsubscribes from its Update event.
        /// Called when switching instruments or closing the window.
        /// </summary>
        private void DisposeBarsRequest()
        {
            if (_barsRequest != null)
            {
                _barsRequest.Update -= OnBarsUpdate;
                try { _barsRequest.Dispose(); }
                catch { } // Swallow — may already be disposed
                _barsRequest = null;
            }
        }

        // ─── Market Data Subscription ──────────────────────────────────────────

        /// <summary>
        /// Subscribes to tick-by-tick market data for the current instrument.
        /// Only listens for MarketDataType.Last (actual trades) to update the last price.
        /// </summary>
        private void SubscribeToMarketData()
        {
            if (_currentInstrument == null) return;

            try
            {
                _currentInstrument.MarketDataUpdate += OnMarketDataUpdate;
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Failed to subscribe to market data for {0} — {1}",
                        _currentInstrument.FullName, ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Unsubscribes from the current instrument's market data updates.
        /// Called when switching instruments or closing the window.
        /// </summary>
        private void UnsubscribeMarketData()
        {
            if (_currentInstrument != null)
            {
                try { _currentInstrument.MarketDataUpdate -= OnMarketDataUpdate; }
                catch { } // Swallow — instrument may already be cleaned up
            }
        }

        /// <summary>
        /// Handles real-time tick data. Updates the last price and refreshes
        /// all calculated values (SL/TP/Qty depend on current price).
        /// Fires on a non-UI thread, so UI updates go through Dispatcher.
        /// </summary>
        private void OnMarketDataUpdate(object sender, MarketDataEventArgs e)
        {
            if (_isDisposed) return;
            if (e.MarketDataType != MarketDataType.Last) return;

            _lastPrice = e.Price;

            // ── Trailing stop logic ──
            // On each tick, if we have an active trade and trailing is enabled,
            // move the SL order to track price at ATR*mult distance (only in favorable direction)
            if (_activeTrade != null && _trailEnabled)
            {
                try
                {
                    var at = _activeTrade;
                    if (at.StopOrder != null && at.StopOrder.OrderState == OrderState.Working)
                    {
                        double tickSize = GetTickSize();
                        double newSl;

                        if (at.IsLong)
                        {
                            // Long: trail SL below price, only move up
                            newSl = RoundToTick(_lastPrice - at.SlDistance);
                            if (newSl <= at.StopOrder.StopPrice) newSl = 0; // No change needed
                        }
                        else
                        {
                            // Short: trail SL above price, only move down
                            newSl = RoundToTick(_lastPrice + at.SlDistance);
                            if (newSl >= at.StopOrder.StopPrice) newSl = 0; // No change needed
                        }

                        // Only modify if the new SL differs by at least 1 tick (avoid flooding)
                        if (newSl > 0 && Math.Abs(newSl - at.StopOrder.StopPrice) >= tickSize)
                        {
                            double oldSl = at.StopOrder.StopPrice;
                            at.StopOrder.StopPriceChanged = newSl;
                            at.Account.Change(new[] { at.StopOrder });

                            // Diagnostic: log each trailing stop adjustment for verification
                            NinjaTrader.Code.Output.Process(
                                string.Format("RiskManager: Trail stop moved {0} → {1} ({2})",
                                    oldSl, newSl, at.IsLong ? "Long" : "Short"),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                    }
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Trail stop error — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }

            // Throttle UI updates — only update on price changes
            Dispatcher.InvokeAsync(new Action(UpdateDisplayValues));
        }

        // ─── ATR Wilder Smoothing ──────────────────────────────────────────────

        /// <summary>
        /// Updates the ATR(14) using Wilder smoothing. Identical algorithm to
        /// MarketContextTagger.UpdateATR() — seed with SMA of first 14 true ranges,
        /// then apply Wilder smoothing: ATR = (prev_ATR * 13 + TR) / 14.
        /// </summary>
        /// <param name="high">Current bar's high price</param>
        /// <param name="low">Current bar's low price</param>
        /// <param name="close">Current bar's close price</param>
        private void UpdateATR(double high, double low, double close)
        {
            if (!_hasPrevClose)
                return; // Need at least one prior close for true range

            // True Range = max of: (H-L), |H-prevClose|, |L-prevClose|
            double tr = high - low;
            double tr2 = Math.Abs(high - _prevClose);
            double tr3 = Math.Abs(low - _prevClose);
            if (tr2 > tr) tr = tr2;
            if (tr3 > tr) tr = tr3;

            if (!_atrInitialized)
            {
                // Seed phase: accumulate true ranges for initial SMA
                _atrSum += tr;
                _atrCount++;
                if (_atrCount >= ATR_PERIOD)
                {
                    _atr = _atrSum / ATR_PERIOD;
                    _atrInitialized = true;
                }
            }
            else
            {
                // Wilder smoothing: gives more weight to recent values
                _atr = (_atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
            }
        }

        // ─── Calculations ──────────────────────────────────────────────────────

        /// <summary>
        /// Parses the selected reward:risk ratio from the combo box.
        /// Format is "1:X" where X is the reward multiplier.
        /// Returns the reward side (e.g., 2.0 for "1:2").
        /// </summary>
        private double GetRRMultiplier()
        {
            string selected = _rrCombo.SelectedItem as string;
            if (string.IsNullOrEmpty(selected)) return 1.0;

            // Parse "1:X" format — take the part after the colon
            string[] parts = selected.Split(':');
            if (parts.Length == 2 && double.TryParse(parts[1], out double rr))
                return rr;

            return 1.0; // Fallback default
        }

        /// <summary>
        /// Parses the ATR multiplier from the free-text input box.
        /// Accepts any numeric value (e.g., "0.65", "1.25", "2").
        /// Falls back to 1.0 on invalid input.
        /// </summary>
        private double GetAtrMultiplier()
        {
            if (double.TryParse(_atrMultInput.Text, out double mult) && mult > 0)
                return mult;

            return 1.0; // Fallback default for invalid/empty input
        }

        /// <summary>
        /// Computes actual risk in dollars from the RU count and RU value inputs.
        /// Formula: riskDollars = ruCount * ruValue
        /// This is the only place the conversion from RUs to dollars happens.
        /// All position sizing still works in dollars internally.
        /// </summary>
        private double GetRiskDollars()
        {
            double ruCount = 1.0;
            double ruValue = 100.0;
            if (double.TryParse(_riskRuInput.Text, out double r)) ruCount = r;
            if (double.TryParse(_ruValueInput.Text, out double v)) ruValue = v;
            return ruCount * ruValue;
        }

        /// <summary>
        /// Returns the dollar value of 1 Risk Unit from the RU Value input.
        /// Used to convert dollar amounts to RU for display purposes.
        /// Falls back to 200 if the input is invalid or zero.
        /// </summary>
        private double GetRuValue()
        {
            if (double.TryParse(_ruValueInput.Text, out double v) && v > 0) return v;
            return 100.0;
        }

        /// <summary>
        /// Formats a dollar amount as Risk Units for display.
        /// Divides the dollar value by the RU value to get the RU equivalent.
        /// Example: $450 with RU value of 200 → "2.25 RU"
        /// </summary>
        /// <param name="dollars">Dollar amount to convert</param>
        /// <returns>Formatted string like "2.25 RU"</returns>
        private string FormatRu(double dollars)
        {
            double ru = dollars / GetRuValue();
            return string.Format("{0:F2} RU", ru);
        }

        /// <summary>
        /// Parses the max quantity cap from the text box.
        /// Returns 0 if input is invalid or empty (meaning no cap).
        /// When non-zero, CalculateQuantity() and CalculateQuantityFromSlDistance()
        /// will cap their result to this value.
        /// </summary>
        private int GetMaxQty()
        {
            if (int.TryParse(_maxQtyInput.Text, out int max) && max >= 0)
                return max;
            return 0;
        }

        /// <summary>
        /// Gets the point value (dollar value per point) for the current instrument.
        /// Uses NinjaTrader's built-in MasterInstrument.PointValue property.
        /// Examples: NQ=$20, MNQ=$2, ES=$50, MES=$5
        /// </summary>
        private double GetPointValue()
        {
            if (_currentInstrument == null) return 0;
            return _currentInstrument.MasterInstrument.PointValue;
        }

        /// <summary>
        /// Gets the tick size for the current instrument.
        /// Used to round SL/TP prices to valid price levels.
        /// Examples: NQ/MNQ=0.25, ES/MES=0.25
        /// </summary>
        private double GetTickSize()
        {
            if (_currentInstrument == null) return 0.25;
            return _currentInstrument.MasterInstrument.TickSize;
        }

        /// <summary>
        /// Rounds a price to the nearest valid tick increment.
        /// Required because SL/TP prices must align to the instrument's tick size.
        /// </summary>
        /// <param name="price">Raw price to round</param>
        /// <returns>Price rounded to nearest tick</returns>
        private double RoundToTick(double price)
        {
            double tickSize = GetTickSize();
            return Math.Round(price / tickSize) * tickSize;
        }

        /// <summary>
        /// Calculates position size based on risk dollars, ATR, and ATR multiplier.
        /// Formula: qty = Floor(riskDollars / (ATR * atrMult * pointValue))
        /// The ATR multiplier scales the SL distance, so a smaller mult = tighter SL = more contracts.
        /// Always returns at least 1 contract.
        /// </summary>
        private int CalculateQuantity()
        {
            double riskDollars = GetRiskDollars();
            double pointValue = GetPointValue();
            double atrMult = GetAtrMultiplier();

            if (_atr <= 0 || pointValue <= 0 || riskDollars <= 0 || atrMult <= 0)
                return 0;

            // Risk per contract = ATR * atrMult (points of risk) * point value ($/point)
            double riskPerContract = _atr * atrMult * pointValue;
            int qty = (int)Math.Floor(riskDollars / riskPerContract);

            // Always trade at least 1 contract
            qty = Math.Max(qty, 1);

            // Apply max quantity cap if set (0 = no cap)
            int maxQty = GetMaxQty();
            if (maxQty > 0)
                qty = Math.Min(qty, maxQty);

            return qty;
        }

        // ─── Display Update ────────────────────────────────────────────────────

        /// <summary>
        /// Refreshes all calculated display values: ATR, Last, Qty, PtVal, SL/TP levels,
        /// and live Open P&L from the account position.
        /// Called whenever price updates, instrument changes, or parameters change.
        /// Must be called on the UI thread.
        /// </summary>
        private void UpdateDisplayValues()
        {
            if (_isDisposed) return;

            double rrMult = GetRRMultiplier();
            double atrMult = GetAtrMultiplier();
            int qty = CalculateQuantity();
            double tickSize = GetTickSize();

            // ATR display
            _atrLabel.Text = _atrInitialized ? _atr.ToString("F2") : "—";

            // Last price display
            _lastPriceLabel.Text = _lastPrice > 0 ? _lastPrice.ToString("F2") : "—";

            // Quantity display
            _qtyLabel.Text = qty > 0 ? qty.ToString() : "—";

            // SL/TP calculations — ATR mode shows calculated values, Manual mode shows placeholders
            if (IsManualSlMode())
            {
                // In Manual mode, SL/TP depend on where the user clicks — show placeholders
                _qtyLabel.Text = "Manual";
                _longSlLabel.Text = "---";
                _longTpLabel.Text = "---";
                _shortSlLabel.Text = "---";
                _shortTpLabel.Text = "---";
            }
            else if (_atrInitialized && _lastPrice > 0)
            {
                double slDistance = _atr * atrMult;

                // Long: SL below entry, TP above entry
                double longSl = RoundToTick(_lastPrice - slDistance);
                double longTp = RoundToTick(_lastPrice + (slDistance * rrMult));
                _longSlLabel.Text = longSl.ToString("F2");
                _longTpLabel.Text = longTp.ToString("F2");

                // Short: SL above entry, TP below entry
                double shortSl = RoundToTick(_lastPrice + slDistance);
                double shortTp = RoundToTick(_lastPrice - (slDistance * rrMult));
                _shortSlLabel.Text = shortSl.ToString("F2");
                _shortTpLabel.Text = shortTp.ToString("F2");
            }
            else
            {
                _longSlLabel.Text = "—";
                _longTpLabel.Text = "—";
                _shortSlLabel.Text = "—";
                _shortTpLabel.Text = "—";
            }

            // ── Live Open P&L from account position ──
            UpdateOpenPnl();
        }

        /// <summary>
        /// Updates the Open P&L label with the current unrealized P&L from the account position.
        /// Shows "Flat" when no position exists, green for profit, red for loss.
        /// Called on every tick via UpdateDisplayValues().
        /// </summary>
        private void UpdateOpenPnl()
        {
            if (_currentInstrument == null || _lastPrice <= 0)
            {
                _openPnlLabel.Text = "Flat";
                _openPnlLabel.Foreground = FindBrush("FontControlBrush");
                UpdateCurrentRr();
                return;
            }

            Account account = _accountSelector.SelectedAccount;
            if (account == null)
            {
                _openPnlLabel.Text = "Flat";
                _openPnlLabel.Foreground = FindBrush("FontControlBrush");
                UpdateCurrentRr();
                return;
            }

            try
            {
                // Search account positions for a position on the current instrument
                Position position = null;
                lock (account.Positions)
                {
                    foreach (Position pos in account.Positions)
                    {
                        if (pos.Instrument == _currentInstrument)
                        {
                            position = pos;
                            break;
                        }
                    }
                }

                if (position == null || position.MarketPosition == MarketPosition.Flat)
                {
                    _openPnlLabel.Text = "Flat";
                    _openPnlLabel.Foreground = FindBrush("FontControlBrush");
                }
                else
                {
                    // Get unrealized P&L in currency (dollars), then display as RU
                    double unrealizedPnl = position.GetUnrealizedProfitLoss(PerformanceUnit.Currency, _lastPrice);
                    _openPnlLabel.Text = FormatRu(unrealizedPnl);
                    _openPnlLabel.Foreground = unrealizedPnl >= 0 ? Brushes.LimeGreen : Brushes.Red;
                }
            }
            catch
            {
                // Position query can fail during transitions — show flat
                _openPnlLabel.Text = "Flat";
                _openPnlLabel.Foreground = FindBrush("FontControlBrush");
            }

            // Update the live Current RR display
            UpdateCurrentRr();
        }

        /// <summary>
        /// Updates the Current RR label with the live reward:risk ratio from the active trade.
        /// Reads the current SL (StopPrice) and TP (LimitPrice) from the working orders,
        /// which update in real-time as the user drags SL/TP levels on the chart.
        /// Formula: Current RR = |TP - entry| / |entry - SL|
        /// Shows "—" when no active trade exists.
        /// </summary>
        private void UpdateCurrentRr()
        {
            var trade = _activeTrade;
            if (trade == null || trade.StopOrder == null || trade.TargetOrder == null)
            {
                _currentRrLabel.Text = "—";
                _currentRrLabel.Foreground = FindBrush("FontControlBrush");
                return;
            }

            try
            {
                double entryPrice = trade.EntryPrice;
                double slPrice = trade.StopOrder.StopPrice;
                double tpPrice = trade.TargetOrder.LimitPrice;

                // Guard against division by zero (SL sitting exactly at entry)
                double risk = Math.Abs(entryPrice - slPrice);
                if (risk < double.Epsilon)
                {
                    _currentRrLabel.Text = "—";
                    _currentRrLabel.Foreground = FindBrush("FontControlBrush");
                    return;
                }

                double reward = Math.Abs(tpPrice - entryPrice);
                double currentRr = reward / risk;

                // Display as "1:X.X" format with color coding
                _currentRrLabel.Text = string.Format("1:{0:F1}", currentRr);

                // Color: green if RR >= 1.5, yellow if >= 1.0, red if < 1.0
                if (currentRr >= 1.5)
                    _currentRrLabel.Foreground = Brushes.LimeGreen;
                else if (currentRr >= 1.0)
                    _currentRrLabel.Foreground = Brushes.Yellow;
                else
                    _currentRrLabel.Foreground = Brushes.Red;
            }
            catch
            {
                // Order properties can throw during transitions — show dash
                _currentRrLabel.Text = "—";
                _currentRrLabel.Foreground = FindBrush("FontControlBrush");
            }
        }

        // ─── Parameter Change Events ──────────────────────────────────────────

        /// <summary>
        /// Called when Risk $, RR ratio, or ATR mult changes. Recalculates display values.
        /// </summary>
        private void OnParameterChanged(object sender, EventArgs e)
        {
            UpdateDisplayValues();
        }

        // ─── Close Orders / Flatten ──────────────────────────────────────────

        /// <summary>
        /// Cancels all working/accepted orders for the current instrument on the selected account.
        /// Iterates through account.Orders and cancels any that match the current instrument
        /// and are in a Working or Accepted state.
        /// </summary>
        private void OnCloseOrdersClick(object sender, RoutedEventArgs e)
        {
            Account account = _accountSelector.SelectedAccount;
            if (account == null || _currentInstrument == null)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot close orders — no account or instrument selected",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            try
            {
                // Collect working orders for the current instrument, then cancel them
                var ordersToCancel = new List<Order>();
                lock (account.Orders)
                {
                    foreach (Order order in account.Orders)
                    {
                        if (order.Instrument == _currentInstrument &&
                            (order.OrderState == OrderState.Working || order.OrderState == OrderState.Accepted))
                        {
                            ordersToCancel.Add(order);
                        }
                    }
                }

                int cancelCount = ordersToCancel.Count;
                foreach (Order order in ordersToCancel)
                {
                    account.Cancel(new[] { order });
                }

                // Fire bridge exit if active trade exists AND position is still open —
                // cancelling orders while in a position means the trade is being abandoned.
                // Without this, Close Orders while positioned would silently lose the trade.
                if (_activeTrade != null)
                {
                    RiskManagerBridge.FireTradeExit(new RiskMgrExitFillArgs
                    {
                        AccountName = account.Name,
                        InstrumentFullName = _currentInstrument.FullName,
                        ExitPrice = _lastPrice,
                        ExitTime = DateTime.Now,
                        ExitReason = "Flatten"
                    });
                }

                // Clear trailing stop state since we're cancelling the SL order
                CleanupActiveTrade();

                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Cancelled {0} working orders for {1}",
                        cancelCount, _currentInstrument.FullName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Error cancelling orders — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Flattens the position on the current instrument — closes the position AND cancels
        /// all working orders. Uses account.Flatten() which handles both operations atomically.
        /// </summary>
        private void OnFlattenClick(object sender, RoutedEventArgs e)
        {
            Account account = _accountSelector.SelectedAccount;
            if (account == null || _currentInstrument == null)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot flatten — no account or instrument selected",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            try
            {
                // Fire bridge exit event before flatten if there's an active trade.
                // Uses _lastPrice as best available exit price since flatten is async.
                if (_activeTrade != null)
                {
                    RiskManagerBridge.FireTradeExit(new RiskMgrExitFillArgs
                    {
                        AccountName = account.Name,
                        InstrumentFullName = _currentInstrument.FullName,
                        ExitPrice = _lastPrice,
                        ExitTime = DateTime.Now,
                        ExitReason = "Flatten"
                    });
                }

                // Flatten closes the position and cancels all orders for the instrument
                account.Flatten(new[] { _currentInstrument });

                // Clear trailing stop state since position is being flattened
                CleanupActiveTrade();

                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Flatten submitted for {0}", _currentInstrument.FullName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Error flattening — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── Order Submission ──────────────────────────────────────────────────

        /// <summary>
        /// Handles Buy Long button click. In ATR mode, submits bracket order immediately.
        /// In Manual SL mode, sets bridge flags so the RiskManagerLink indicator captures the next chart click.
        /// </summary>
        private void OnBuyLongClick(object sender, RoutedEventArgs e)
        {
            if (IsManualSlMode())
                StartManualSlWait(true);
            else
                SubmitBracketOrder(true);
        }

        /// <summary>
        /// Handles Sell Short button click. In ATR mode, submits bracket order immediately.
        /// In Manual SL mode, sets bridge flags so the RiskManagerLink indicator captures the next chart click.
        /// </summary>
        private void OnSellShortClick(object sender, RoutedEventArgs e)
        {
            if (IsManualSlMode())
                StartManualSlWait(false);
            else
                SubmitBracketOrder(false);
        }

        /// <summary>
        /// Submits only the market entry order and stores bracket parameters.
        /// SL/TP orders are deferred until the entry fills — this avoids the problem
        /// of exit orders being rejected when there's no open position yet.
        /// The actual fill price is used for SL/TP calculation, eliminating slippage misalignment.
        /// Now includes the ATR multiplier in the pending bracket state.
        /// </summary>
        /// <param name="isLong">True for long entry, false for short entry</param>
        private void SubmitBracketOrder(bool isLong)
        {
            // Double-click guard — prevent submitting a second entry while one is pending
            if (_pendingBracket != null)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Order already pending — wait for fill or rejection",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            // Validate we have all required data
            if (_currentInstrument == null || !_atrInitialized || _lastPrice <= 0)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot submit order — missing instrument, ATR, or price data",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            int qty = CalculateQuantity();
            if (qty <= 0)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot submit order — quantity is 0",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            // Get the selected account
            Account account = _accountSelector.SelectedAccount;
            if (account == null)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot submit order — no account selected",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            double rrMult = GetRRMultiplier();
            double atrMult = GetAtrMultiplier();
            OrderAction entryAction = isLong ? OrderAction.Buy : OrderAction.SellShort;

            try
            {
                // Create the market entry order only — SL/TP come after fill
                Order entryOrder = account.CreateOrder(
                    _currentInstrument,     // Instrument
                    entryAction,            // Buy or SellShort
                    OrderType.Market,       // Market order for immediate fill
                    TimeInForce.Day,        // Day order
                    qty,                    // Calculated quantity
                    0,                      // No limit price (market order)
                    0,                      // No stop price (market order)
                    string.Empty,           // No OCO for entry
                    "RiskMgr Entry",        // Signal name for identification
                    null                    // No custom ID
                );

                // Store bracket parameters for the fill callback — includes ATR multiplier
                // Capture RU values from UI on the UI thread before going async
                double ruCount = 1.0;
                double ruVal = 100.0;
                if (double.TryParse(_riskRuInput.Text, out double ruParsed)) ruCount = ruParsed;
                if (double.TryParse(_ruValueInput.Text, out double rvParsed)) ruVal = rvParsed;

                _pendingBracket = new PendingBracketState
                {
                    IsLong = isLong,
                    Quantity = qty,
                    Atr = _atr,
                    AtrMultiplier = atrMult,
                    RRMultiplier = rrMult,
                    Account = account,
                    EntryOrder = entryOrder,
                    RiskUnits = ruCount,
                    RuValue = ruVal
                };

                // Subscribe to order updates if not already subscribed
                if (!_isSubscribedToOrderUpdate)
                {
                    account.OrderUpdate += OnOrderUpdateForBracket;
                    _isSubscribedToOrderUpdate = true;
                }

                // Submit only the entry order — SL/TP will be placed on fill
                account.Submit(new[] { entryOrder });

                string direction = isLong ? "LONG" : "SHORT";
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: {0} entry submitted — {1}x {2} @ MKT (ATR mult={3}x), waiting for fill to place SL/TP",
                        direction, qty, _currentInstrument.FullName, atrMult),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                // Clean up pending state on failure
                _pendingBracket = null;
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Order submission error — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        /// <summary>
        /// Handles order update events for the pending bracket entry.
        /// On fill: calculates SL/TP from the actual fill price using ATR * AtrMultiplier,
        /// and submits OCO exit orders.
        /// On rejection/cancellation: cleans up state and logs the error.
        /// Pattern follows TradeTracker.OnOrderUpdate() using the same OrderEventArgs API.
        /// </summary>
        private void OnOrderUpdateForBracket(object sender, OrderEventArgs e)
        {
            if (_pendingBracket == null) return;
            if (e.Order == null) return;

            // Match this event to our pending entry order
            if (e.Order != _pendingBracket.EntryOrder) return;

            if (e.OrderState == OrderState.Filled)
            {
                // Entry filled — now place SL/TP using actual fill price
                try
                {
                    double fillPrice = e.AverageFillPrice;
                    var pb = _pendingBracket;

                    // Calculate SL/TP — use manual SL price if set, otherwise ATR-based
                    double slDistance, slPrice, tpPrice;
                    if (pb.ManualSlPrice > 0)
                    {
                        // Manual SL mode: SL price was set by chart click, derive distance from fill
                        slPrice = pb.ManualSlPrice;
                        slDistance = Math.Abs(fillPrice - slPrice);
                    }
                    else
                    {
                        // ATR mode: SL distance = ATR * ATR multiplier
                        slDistance = pb.Atr * pb.AtrMultiplier;
                        slPrice = pb.IsLong
                            ? RoundToTick(fillPrice - slDistance)
                            : RoundToTick(fillPrice + slDistance);
                    }
                    // TP distance = SL distance * RR multiplier, on the opposite side
                    tpPrice = pb.IsLong
                        ? RoundToTick(fillPrice + (slDistance * pb.RRMultiplier))
                        : RoundToTick(fillPrice - (slDistance * pb.RRMultiplier));

                    // Generate unique OCO ID for the stop/target pair
                    string ocoId = Guid.NewGuid().ToString("N").Substring(0, 18);
                    OrderAction exitAction = pb.IsLong ? OrderAction.Sell : OrderAction.BuyToCover;

                    // Always use StopMarket for the stop loss — guarantees a fill even on gaps.
                    // Account.Change() + StopPriceChanged works with StopMarket orders for trailing.
                    Order stopOrder = pb.Account.CreateOrder(
                        _currentInstrument,
                        exitAction,             // Sell or BuyToCover
                        OrderType.StopMarket,   // StopMarket guarantees fill; StopLimit can miss on gaps
                        TimeInForce.Gtc,        // Good till cancelled
                        pb.Quantity,
                        0,                      // Limit price unused for StopMarket
                        slPrice,                // Stop trigger price
                        ocoId,                  // OCO links stop and target
                        "RiskMgr Stop",
                        null
                    );

                    // Take profit limit order (OCO paired with stop loss)
                    Order tpOrder = pb.Account.CreateOrder(
                        _currentInstrument,
                        exitAction,
                        OrderType.Limit,        // Limit order for price target
                        TimeInForce.Gtc,
                        pb.Quantity,
                        tpPrice,                // Limit price = take profit level
                        0,                      // No stop price
                        ocoId,                  // Same OCO as stop — one cancels other
                        "RiskMgr Target",
                        null
                    );

                    // Submit the OCO exit pair now that we have an open position
                    pb.Account.Submit(new[] { stopOrder, tpOrder });

                    // Store active trade state for trailing stop functionality
                    // Trailing will only operate if _trailEnabled is true (checkbox checked)
                    _activeTrade = new ActiveTradeState
                    {
                        IsLong = pb.IsLong,
                        SlDistance = slDistance,
                        Account = pb.Account,
                        StopOrder = stopOrder,
                        TargetOrder = tpOrder,
                        EntryPrice = fillPrice
                    };

                    // Subscribe handlers to watch for SL/TP fills to clear _activeTrade
                    pb.Account.OrderUpdate += OnExitOrderUpdate;
                    // PositionUpdate fallback — catches exits if OnExitOrderUpdate somehow misses
                    pb.Account.PositionUpdate += OnPositionUpdateFallback;

                    // Fire bridge entry event so TradeTracker creates the trade from exact data
                    // instead of inferring from raw execution events (prevents phantom double-counting)
                    RiskManagerBridge.FireTradeEntry(new RiskMgrEntryFillArgs
                    {
                        AccountName = pb.Account.Name,
                        InstrumentFullName = _currentInstrument.FullName,
                        IsLong = pb.IsLong,
                        Quantity = pb.Quantity,
                        EntryPrice = fillPrice,
                        EntryTime = e.Order.Time,
                        StopPrice = slPrice,
                        TargetPrice = tpPrice,
                        Atr = pb.Atr,
                        AtrMultiplier = pb.AtrMultiplier,
                        RRMultiplier = pb.RRMultiplier,
                        RiskUnits = pb.RiskUnits,
                        RuValue = pb.RuValue,
                        SlMode = pb.ManualSlPrice > 0 ? "Manual" : "ATR"
                    });

                    string direction = pb.IsLong ? "LONG" : "SHORT";
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: {0} filled @ {1:F2} — SL={2:F2}, TP={3:F2} submitted as OCO (ATR mult={4}x)",
                            direction, fillPrice, slPrice, tpPrice, pb.AtrMultiplier),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Error submitting SL/TP after fill — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                finally
                {
                    // Clean up — unsubscribe entry handler and clear pending state
                    CleanupPendingBracket();
                }
            }
            else if (e.OrderState == OrderState.Rejected || e.OrderState == OrderState.Cancelled)
            {
                // Entry was rejected or cancelled — clean up without placing exit orders
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Entry order {0} — no SL/TP placed", e.OrderState),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                CleanupPendingBracket();
            }
        }

        /// <summary>
        /// Unsubscribes from the OrderUpdate event and clears the pending bracket state.
        /// Called after entry fill, rejection, cancellation, or window close.
        /// </summary>
        private void CleanupPendingBracket()
        {
            if (_pendingBracket != null && _isSubscribedToOrderUpdate)
            {
                try { _pendingBracket.Account.OrderUpdate -= OnOrderUpdateForBracket; }
                catch { } // Swallow — account may already be cleaned up
                _isSubscribedToOrderUpdate = false;
            }
            _pendingBracket = null;
        }

        // ─── Exit Order Monitoring (for trailing stop cleanup) ─────────────────

        /// <summary>
        /// Watches for SL or TP exit orders filling. Only reacts to Filled state to avoid
        /// OCO race conditions — when target fills, OCO cancels stop (or vice versa). If we
        /// reacted to Cancelled, we'd null _activeTrade before the actual fill arrives.
        /// Matches orders by Name string instead of reference equality for reliability.
        /// </summary>
        private void OnExitOrderUpdate(object sender, OrderEventArgs e)
        {
            try
            {
                if (_activeTrade == null || e.Order == null) return;

                // Only react to filled orders — cancellations from OCO are expected and safe to ignore
                if (e.OrderState != OrderState.Filled) return;

                // Match by order name string (not reference) — OCO race can deliver events out of order
                string name = e.Order.Name ?? "";
                if (name != "RiskMgr Stop" && name != "RiskMgr Target") return;

                // Fire bridge exit event so TradeTracker closes the trade with exact exit data
                if (_currentInstrument != null)
                {
                    string exitReason = name == "RiskMgr Stop" ? "Stop" : "Target";
                    RiskManagerBridge.FireTradeExit(new RiskMgrExitFillArgs
                    {
                        AccountName = _activeTrade.Account.Name,
                        InstrumentFullName = _currentInstrument.FullName,
                        ExitPrice = e.Order.AverageFillPrice,
                        ExitTime = e.Order.Time,
                        ExitReason = exitReason
                    });
                }

                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Exit order {0} filled — trailing stop cleared", name),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                CleanupActiveTrade();
            }
            catch (Exception ex)
            {
                // Safety net — log and clean up so we don't get stuck with stale state
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Error in OnExitOrderUpdate — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                CleanupActiveTrade();
            }
        }

        /// <summary>
        /// Safety-net fallback: if OnExitOrderUpdate misses an exit (e.g., unexpected order
        /// name or event timing), PositionUpdate catches when the position goes flat while
        /// we still have an _activeTrade. Fires the bridge exit with last known price.
        /// </summary>
        private void OnPositionUpdateFallback(object sender, PositionEventArgs e)
        {
            try
            {
                if (_activeTrade == null) return;
                if (_currentInstrument == null) return;

                // Only care about our instrument going flat
                if (e.Position == null || e.Position.Instrument != _currentInstrument) return;
                if (e.MarketPosition != MarketPosition.Flat) return;

                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: PositionUpdate fallback — position went flat for {0}, cleaning up",
                        _currentInstrument.FullName),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                // Fire bridge exit with best available data — _lastPrice as fallback exit price
                RiskManagerBridge.FireTradeExit(new RiskMgrExitFillArgs
                {
                    AccountName = _activeTrade.Account.Name,
                    InstrumentFullName = _currentInstrument.FullName,
                    ExitPrice = _lastPrice,
                    ExitTime = DateTime.Now,
                    ExitReason = "Flatten"
                });

                CleanupActiveTrade();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Error in PositionUpdate fallback — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                CleanupActiveTrade();
            }
        }

        /// <summary>
        /// Clears the active trade state and unsubscribes both exit order and position update handlers.
        /// Called when SL/TP fills, position flattened, or window closes.
        /// </summary>
        private void CleanupActiveTrade()
        {
            if (_activeTrade != null)
            {
                try { _activeTrade.Account.OrderUpdate -= OnExitOrderUpdate; }
                catch { } // Swallow — account may already be cleaned up
                try { _activeTrade.Account.PositionUpdate -= OnPositionUpdateFallback; }
                catch { } // Swallow — account may already be cleaned up
                _activeTrade = null;

                // Reset Current RR label on UI thread (cleanup may fire from background thread)
                Dispatcher.InvokeAsync(() =>
                {
                    if (_currentRrLabel != null)
                    {
                        _currentRrLabel.Text = "—";
                        _currentRrLabel.Foreground = FindBrush("FontControlBrush");
                    }
                });
            }
        }

        // ─── SL Mode Handling ─────────────────────────────────────────────────

        /// <summary>
        /// Returns true if the SL mode combo is set to "Manual" (chart-click SL placement).
        /// </summary>
        private bool IsManualSlMode()
        {
            return _slModeCombo != null && _slModeCombo.SelectedItem as string == "Manual";
        }

        /// <summary>
        /// Called when the SL Mode combo selection changes between ATR and Manual.
        /// Shows/hides the ATR Mult controls and refreshes display values.
        /// Also cancels any pending manual SL wait if switching back to ATR mode.
        /// </summary>
        private void OnSlModeChanged(object sender, SelectionChangedEventArgs e)
        {
            bool isManual = IsManualSlMode();

            // Show/hide ATR mult controls — irrelevant in Manual mode
            if (_atrMultPanel != null)
                _atrMultPanel.Visibility = isManual ? Visibility.Collapsed : Visibility.Visible;

            // If switching away from Manual while waiting for chart click, cancel the wait
            if (!isManual && RiskManagerBridge.WaitingForSlClick)
            {
                RiskManagerBridge.WaitingForSlClick = false;
                RestoreButtons();
            }

            UpdateDisplayValues();
        }

        /// <summary>
        /// Begins the manual SL placement flow via the RiskManagerBridge.
        /// Sets bridge flags so the RiskManagerLink indicator captures the next chart click.
        /// Changes buttons to "CLICK CHART FOR SL" with orange color.
        /// </summary>
        /// <param name="isLong">True for long direction, false for short</param>
        private void StartManualSlWait(bool isLong)
        {
            // Validate basic requirements before entering wait state
            if (_currentInstrument == null || _lastPrice <= 0)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot start manual SL — no instrument or price data",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            // Check if a chart is linked for this instrument via the RiskManagerLink indicator
            if (!_isLinked)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: No chart linked — add the RiskManagerLink indicator to your chart first",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            // Double-click guard — prevent starting a second wait while one is pending
            if (RiskManagerBridge.WaitingForSlClick)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Already waiting for chart click — click the chart or press Escape to cancel",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            // Store direction and set bridge flags so the indicator knows to capture the next click
            _manualSlIsLong = isLong;
            RiskManagerBridge.WaitingInstrument = _currentInstrument.FullName;
            RiskManagerBridge.WaitingForSlClick = true;

            // Change button appearance to indicate we're waiting for a chart click
            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;
                _buyButton.Content = "CLICK CHART FOR SL";
                _buyButton.Background = new SolidColorBrush(Color.FromRgb(255, 165, 0)); // Orange
                _sellButton.Content = "CLICK CHART FOR SL";
                _sellButton.Background = new SolidColorBrush(Color.FromRgb(255, 165, 0)); // Orange
            }));

            string direction = isLong ? "LONG" : "SHORT";
            NinjaTrader.Code.Output.Process(
                string.Format("RiskManager: Manual SL mode — click chart for {0} SL level (Escape/right-click to cancel)",
                    direction),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
        }

        /// <summary>
        /// Restores Buy/Sell buttons to their normal text and colors after manual SL wait ends.
        /// </summary>
        private void RestoreButtons()
        {
            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;
                _buyButton.Content = "BUY LONG";
                _buyButton.Background = Brushes.DarkGreen;
                _sellButton.Content = "SELL SHORT";
                _sellButton.Background = Brushes.DarkRed;
            }));
        }

        // ─── RiskManagerBridge Event Handlers ─────────────────────────────────

        /// <summary>
        /// Called when the RiskManagerLink indicator registers on a chart.
        /// Updates the link status label and optionally auto-syncs the instrument.
        /// </summary>
        private void OnBridgeLinked(string instrumentName, string timeframe)
        {
            _isLinked = true;
            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;
                _linkStatusLabel.Text = string.Format("Linked: {0} ({1})", instrumentName, timeframe);
                _linkStatusLabel.Foreground = Brushes.LimeGreen;

                // Auto-sync the instrument selector to match the linked chart
                var linkedInstrument = NinjaTrader.Cbi.Instrument.GetInstrument(instrumentName);
                if (linkedInstrument != null)
                    _instrumentSelector.Instrument = linkedInstrument;
            }));

            NinjaTrader.Code.Output.Process(
                string.Format("RiskManager: Chart linked — {0} ({1})", instrumentName, timeframe),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
        }

        /// <summary>
        /// Called when the RiskManagerLink indicator is removed from a chart.
        /// Clears the link status and cancels any pending SL wait.
        /// </summary>
        private void OnBridgeUnlinked(string instrumentName)
        {
            // Guard: if a new instance already registered during the debounce window,
            // skip the unlink — the bridge is already linked to the new instance.
            // This prevents flicker when closing the Indicators dialog, which destroys
            // and recreates all instances. Checking actual bridge state is more robust
            // than relying on timing alone.
            string existingInstrument, existingTimeframe;
            if (RiskManagerBridge.HasLinkedInstance(out existingInstrument, out existingTimeframe))
                return;

            _isLinked = false;
            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;
                _linkStatusLabel.Text = "No chart linked";
                _linkStatusLabel.Foreground = Brushes.Gray;
            }));

            // Cancel any pending SL wait since the chart is gone
            if (RiskManagerBridge.WaitingForSlClick)
            {
                RiskManagerBridge.WaitingForSlClick = false;
                RestoreButtons();
            }

            NinjaTrader.Code.Output.Process(
                string.Format("RiskManager: Chart unlinked — {0}", instrumentName),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
        }

        /// <summary>
        /// Called when the RiskManagerLink indicator captures a chart click for SL placement.
        /// Validates the SL price is on the correct side, calculates qty, and submits the bracket order.
        /// </summary>
        private void OnBridgeSlPriceSelected(double rawPrice)
        {
            // Marshal to the RiskManager window's UI thread — this handler is invoked
            // from the chart's mouse-handler thread via FireSlSelected(), so accessing
            // WPF DependencyObjects (_currentInstrument, _accountSelector, etc.) directly
            // would cause cross-thread exceptions.
            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;

                // Round to instrument tick size for a valid price level
                double clickedPrice = RoundToTick(rawPrice);

                // Validate SL is on the correct side of the current price
                if (_manualSlIsLong && clickedPrice >= _lastPrice)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Long SL must be BELOW current price ({0:F2}). Clicked: {1:F2} — try again",
                            _lastPrice, clickedPrice),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    // Re-enable the wait so user can try again
                    RiskManagerBridge.WaitingInstrument = _currentInstrument.FullName;
                    RiskManagerBridge.WaitingForSlClick = true;
                    return;
                }
                if (!_manualSlIsLong && clickedPrice <= _lastPrice)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Short SL must be ABOVE current price ({0:F2}). Clicked: {1:F2} — try again",
                            _lastPrice, clickedPrice),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    // Re-enable the wait so user can try again
                    RiskManagerBridge.WaitingInstrument = _currentInstrument.FullName;
                    RiskManagerBridge.WaitingForSlClick = true;
                    return;
                }

                // Calculate position size from the manual SL distance
                double slDistance = Math.Abs(_lastPrice - clickedPrice);
                int qty = CalculateQuantityFromSlDistance(slDistance);
                if (qty <= 0) qty = 1;

                double rrMult = GetRRMultiplier();

                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Manual SL clicked at {0:F2} — distance={1:F2}pts, qty={2}, RR={3}x",
                        clickedPrice, slDistance, qty, rrMult),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);

                // Restore buttons and submit the bracket order with manual SL price
                RestoreButtons();
                SubmitManualBracketOrder(_manualSlIsLong, clickedPrice, qty);
            }));
        }

        /// <summary>
        /// Called when the user cancels the manual SL wait (Escape or right-click on chart).
        /// Restores buttons to their normal state.
        /// </summary>
        private void OnBridgeSlCancelled()
        {
            // Marshal to the RiskManager window's UI thread for consistency with
            // OnBridgeSlPriceSelected — invoked from the chart's mouse-handler thread.
            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;

                RestoreButtons();

                NinjaTrader.Code.Output.Process(
                    "RiskManager: Manual SL wait cancelled",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }));
        }

        /// <summary>
        /// Calculates position size from a manual SL distance (in points).
        /// Formula: qty = Floor(riskDollars / (slDistance * pointValue))
        /// Same logic as CalculateQuantity() but uses explicit SL distance instead of ATR * mult.
        /// </summary>
        /// <param name="slDistance">SL distance in points (from current price to clicked SL level)</param>
        /// <returns>Number of contracts, minimum 1</returns>
        private int CalculateQuantityFromSlDistance(double slDistance)
        {
            double riskDollars = GetRiskDollars();
            double pointValue = GetPointValue();

            if (slDistance <= 0 || pointValue <= 0 || riskDollars <= 0)
                return 1;

            double riskPerContract = slDistance * pointValue;
            int qty = (int)Math.Floor(riskDollars / riskPerContract);
            qty = Math.Max(qty, 1);

            // Apply max quantity cap if set (0 = no cap)
            int maxQty = GetMaxQty();
            if (maxQty > 0)
                qty = Math.Min(qty, maxQty);

            return qty;
        }

        /// <summary>
        /// Submits a bracket order with a manually-specified SL price from chart click.
        /// Similar to SubmitBracketOrder() but uses the clicked SL price for position sizing
        /// and stores ManualSlPrice in PendingBracketState so the fill handler uses it directly.
        /// </summary>
        /// <param name="isLong">True for long entry, false for short entry</param>
        /// <param name="manualSlPrice">SL price from the chart click (already validated and tick-rounded)</param>
        /// <param name="qty">Position size calculated from the manual SL distance</param>
        private void SubmitManualBracketOrder(bool isLong, double manualSlPrice, int qty)
        {
            // Double-click guard — prevent submitting a second entry while one is pending
            if (_pendingBracket != null)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Order already pending — wait for fill or rejection",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            Account account = _accountSelector.SelectedAccount;
            if (account == null || _currentInstrument == null)
            {
                NinjaTrader.Code.Output.Process(
                    "RiskManager: Cannot submit order — no account or instrument selected",
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                return;
            }

            double rrMult = GetRRMultiplier();
            OrderAction entryAction = isLong ? OrderAction.Buy : OrderAction.SellShort;

            try
            {
                // Create market entry order
                Order entryOrder = account.CreateOrder(
                    _currentInstrument,
                    entryAction,
                    OrderType.Market,
                    TimeInForce.Day,
                    qty,
                    0, 0,
                    string.Empty,
                    "RiskMgr Entry",
                    null
                );

                // Capture RU values from UI on the UI thread before going async
                double ruCount = 1.0;
                double ruVal = 100.0;
                if (double.TryParse(_riskRuInput.Text, out double ruParsed)) ruCount = ruParsed;
                if (double.TryParse(_ruValueInput.Text, out double rvParsed)) ruVal = rvParsed;

                // Store bracket parameters with manual SL price — ATR values still stored for reference
                _pendingBracket = new PendingBracketState
                {
                    IsLong = isLong,
                    Quantity = qty,
                    Atr = _atr,
                    AtrMultiplier = 0, // Not used in manual mode
                    RRMultiplier = rrMult,
                    Account = account,
                    EntryOrder = entryOrder,
                    ManualSlPrice = manualSlPrice, // Key field: tells fill handler to use this SL directly
                    RiskUnits = ruCount,
                    RuValue = ruVal
                };

                // Subscribe to order updates if not already subscribed
                if (!_isSubscribedToOrderUpdate)
                {
                    account.OrderUpdate += OnOrderUpdateForBracket;
                    _isSubscribedToOrderUpdate = true;
                }

                account.Submit(new[] { entryOrder });

                string direction = isLong ? "LONG" : "SHORT";
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: {0} entry submitted — {1}x {2} @ MKT, Manual SL={3:F2}, waiting for fill",
                        direction, qty, _currentInstrument.FullName, manualSlPrice),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            catch (Exception ex)
            {
                _pendingBracket = null;
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Manual order submission error — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
        }

        // ─── Local TradeTracker Stats ──────────────────────────────────────────

        /// <summary>
        /// Reads trade stats from local TradeTracker JSON files on a background thread.
        /// Two data sets:
        /// 1. Today's trades for daily P&L and session drawdown
        /// 2. Last 30 trades (scanning back up to 7 days) for win rate, avg RR, EV, streak
        /// Updates UI labels via Dispatcher.InvokeAsync() after computation.
        /// Guarded by _isRefreshing to prevent overlapping reads.
        /// </summary>
        private void RefreshStatsAsync()
        {
            // Prevent overlapping refreshes
            if (_isRefreshing) return;
            _isRefreshing = true;

            // Capture current account name, instrument, and clear time for background thread use
            // (thread-safety: read UI-bound fields on UI thread before entering Task.Run)
            Account account = _accountSelector.SelectedAccount;
            string accountName = account != null ? account.Name : "";
            string instrumentFilter = _currentInstrument != null ? _currentInstrument.FullName : null;
            DateTime? clearTime = _statsClearTime;

            if (string.IsNullOrEmpty(accountName))
            {
                _isRefreshing = false;
                return;
            }

            Task.Run(() =>
            {
                try
                {
                    // ── Today's trades for daily P&L and session drawdown ──
                    // Filtered by account and current instrument so stats only reflect selected symbol
                    var todayTrades = ReadLocalTrades(0, accountName, instrumentFilter, clearTime);

                    // ── Last 30 trades: scan back up to 7 days to accumulate enough ──
                    var last30Trades = new List<TradeResult>();
                    var allRecentTrades = ReadLocalTrades(7, accountName, instrumentFilter, clearTime);
                    // Take most recent 30 — allRecentTrades is ordered newest-day-first
                    if (allRecentTrades.Count > 30)
                        last30Trades = allRecentTrades.GetRange(0, 30);
                    else
                        last30Trades = allRecentTrades;

                    // ── Compute metrics ──

                    // Daily P&L = sum of today's pnl_dollars
                    double dailyPnl = 0;
                    foreach (var t in todayTrades)
                        dailyPnl += t.PnlDollars;

                    // Session drawdown: track peak-to-trough of cumulative daily P&L
                    // Need trades in chronological order for drawdown calc
                    var todayChronological = new List<TradeResult>(todayTrades);
                    todayChronological.Reverse(); // Reverse so oldest first
                    double cumPnl = 0;
                    double peakPnl = 0;
                    double maxDrawdown = 0;
                    foreach (var t in todayChronological)
                    {
                        cumPnl += t.PnlDollars;
                        if (cumPnl > peakPnl) peakPnl = cumPnl;
                        double dd = peakPnl - cumPnl;
                        if (dd > maxDrawdown) maxDrawdown = dd;
                    }

                    // Trailing drawdown = current distance from peak (peak − current)
                    double trailingDd = peakPnl - cumPnl;

                    // Win rate (last 30) = count(pnl > 0) / count(non-BE) × 100
                    // Break-even trades ($0 P&L) are excluded from win/loss/EV/streak stats
                    // but still contribute to daily P&L sum and drawdown calculations above
                    int wins = 0;
                    int total = 0; // Only counts non-break-even trades
                    double sumWinPnl = 0;
                    double sumLossPnl = 0;
                    double sumWinRr = 0;
                    int winCountForRr = 0;
                    foreach (var t in last30Trades)
                    {
                        // Skip break-even trades — they aren't wins or losses
                        if (t.PnlDollars == 0) continue;

                        total++;
                        if (t.PnlDollars > 0)
                        {
                            wins++;
                            sumWinPnl += t.PnlDollars;
                            sumWinRr += t.ActualRr;
                            winCountForRr++;
                        }
                        else
                        {
                            sumLossPnl += Math.Abs(t.PnlDollars);
                        }
                    }
                    double winRate = total > 0 ? (double)wins / total * 100 : 0;

                    // Avg RR = mean of actual_rr where pnl > 0 (winners only)
                    double avgRr = winCountForRr > 0 ? sumWinRr / winCountForRr : 0;

                    // EV = (winRate × avgWin) − (lossRate × avgLoss) in dollars
                    int losses = total - wins;
                    double avgWin = wins > 0 ? sumWinPnl / wins : 0;
                    double avgLoss = losses > 0 ? sumLossPnl / losses : 0;
                    double winRateFrac = total > 0 ? (double)wins / total : 0;
                    double lossRateFrac = total > 0 ? (double)losses / total : 0;
                    double ev = (winRateFrac * avgWin) - (lossRateFrac * avgLoss);

                    // Streak: consecutive wins or losses from most recent non-BE trade
                    // last30Trades is ordered newest-first; skip $0 trades for streak purposes
                    string streak = "—";
                    if (last30Trades.Count > 0)
                    {
                        bool? firstIsWin = null;
                        int streakCount = 0;
                        foreach (var t in last30Trades)
                        {
                            // Skip break-even trades — they don't break or extend streaks
                            if (t.PnlDollars == 0) continue;

                            bool isWin = t.PnlDollars > 0;
                            if (firstIsWin == null)
                                firstIsWin = isWin;

                            if (isWin == firstIsWin)
                                streakCount++;
                            else
                                break;
                        }
                        if (firstIsWin.HasValue)
                            streak = (firstIsWin.Value ? "W" : "L") + streakCount;
                    }

                    // ── Update UI on dispatcher thread ──
                    Dispatcher.InvokeAsync(new Action(() =>
                    {
                        if (_isDisposed) return;

                        // Daily P&L in RU with color coding
                        _dailyPnlLabel.Text = FormatRu(dailyPnl);
                        _dailyPnlLabel.Foreground = dailyPnl >= 0 ? Brushes.LimeGreen : Brushes.Red;

                        // Win rate
                        _winRateLabel.Text = total > 0 ? string.Format("{0:F1}%", winRate) : "—";

                        // Avg RR (winners)
                        _avgRrLabel.Text = winCountForRr > 0 ? string.Format("{0:F2}", avgRr) : "—";

                        // EV per trade in RU
                        _evLabel.Text = total > 0 ? FormatRu(ev) : "—";
                        _evLabel.Foreground = ev >= 0 ? Brushes.LimeGreen : Brushes.Red;

                        // Streak — neutral color when no data ("—"), green for wins, red for losses
                        _streakLabel.Text = streak;
                        _streakLabel.Foreground = streak.StartsWith("W") ? Brushes.LimeGreen
                            : streak.StartsWith("L") ? Brushes.Red
                            : FindBrush("FontControlBrush");

                        // Session drawdown (max peak-to-trough) in RU
                        _sessionDdLabel.Text = maxDrawdown > 0 ? FormatRu(-maxDrawdown) : "0.00 RU";
                        _sessionDdLabel.Foreground = maxDrawdown > 0 ? Brushes.Red : FindBrush("FontControlBrush");

                        // Trailing drawdown (distance from peak) in RU
                        _trailingDdLabel.Text = trailingDd > 0 ? FormatRu(-trailingDd) : "0.00 RU";
                        _trailingDdLabel.Foreground = trailingDd > 0 ? Brushes.Red : FindBrush("FontControlBrush");
                    }));
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Stats refresh error — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                finally
                {
                    _isRefreshing = false;
                }
            });
        }

        /// <summary>
        /// Reads trades from local TradeTracker JSON files for the specified date range.
        /// Scans from today back to `daysBack` days ago, reading trades_YYYY-MM-DD.json files.
        /// Each file is a JSON array of TradeRecord objects written by TradeJsonWriter.
        /// Uses brace-depth parsing (same pattern as TradeJsonWriter.ParseExistingTrades)
        /// to split the array into individual objects, then extracts fields.
        /// Results are ordered newest-day-first, with trades within each day in file order.
        /// </summary>
        /// <param name="daysBack">Number of days to look back (0 = today only)</param>
        /// <param name="accountName">Account name to filter trades by</param>
        /// <param name="instrumentFilter">Instrument full name to filter by (e.g., "MNQ 03-26"). Null/empty = all instruments.</param>
        /// <param name="clearTime">If set, skip trades with exitTime before this cutoff (for "Clear Stats" feature)</param>
        /// <returns>List of TradeResult ordered newest-first</returns>
        private List<TradeResult> ReadLocalTrades(int daysBack, string accountName, string instrumentFilter = null, DateTime? clearTime = null)
        {
            var results = new List<TradeResult>();

            // TradeTracker writes daily files to: {UserDataDir}\TradeTracker\trades_YYYY-MM-DD.json
            string tradeDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "TradeTracker");

            if (!Directory.Exists(tradeDir))
                return results;

            // Scan from today backwards — newest day first for correct ordering
            for (int d = 0; d <= daysBack; d++)
            {
                DateTime date = DateTime.Today.AddDays(-d);
                string fileName = string.Format("trades_{0:yyyy-MM-dd}.json", date);
                string filePath = Path.Combine(tradeDir, fileName);

                if (!File.Exists(filePath))
                    continue;

                try
                {
                    string json = File.ReadAllText(filePath);
                    if (string.IsNullOrEmpty(json))
                        continue;

                    // Parse the JSON array into individual object strings using brace-depth tracking.
                    // This handles prettified/multi-line JSON correctly — unlike split on "},{".
                    var objectStrings = ParseJsonObjects(json);

                    // For newest-first ordering within each day, reverse the file-order trades
                    // (TradeTracker writes trades in chronological order within each file)
                    var dayTrades = new List<TradeResult>();
                    foreach (string objStr in objectStrings)
                    {
                        // Filter by account name — skip trades from other accounts
                        string tradeAccount = ExtractJsonString(objStr, "accountName");
                        if (!string.Equals(tradeAccount, accountName, StringComparison.OrdinalIgnoreCase))
                            continue;

                        // Filter by instrument — skip trades for other instruments (e.g., NQ when MNQ selected)
                        if (!string.IsNullOrEmpty(instrumentFilter))
                        {
                            string tradeInstrument = ExtractJsonString(objStr, "instrument");
                            if (!string.Equals(tradeInstrument, instrumentFilter, StringComparison.OrdinalIgnoreCase))
                                continue;
                        }

                        // Filter by clear time — skip trades that exited before the cutoff
                        // so "Clear Stats" only shows trades taken after the clear point
                        if (clearTime.HasValue)
                        {
                            string exitTimeStr = ExtractJsonString(objStr, "exitTime");
                            DateTime exitTime;
                            if (DateTime.TryParseExact(exitTimeStr, "yyyy-MM-ddTHH:mm:ss",
                                System.Globalization.CultureInfo.InvariantCulture,
                                System.Globalization.DateTimeStyles.None, out exitTime))
                            {
                                if (exitTime < clearTime.Value)
                                    continue;
                            }
                        }

                        double pnl = ExtractJsonDouble(objStr, "pnlDollars");
                        double rr = ExtractJsonDouble(objStr, "actualRR");
                        dayTrades.Add(new TradeResult { PnlDollars = pnl, ActualRr = rr });
                    }

                    // Reverse so most recent trade in the day comes first
                    dayTrades.Reverse();
                    results.AddRange(dayTrades);
                }
                catch (Exception ex)
                {
                    // Log but continue — one bad file shouldn't break all stats
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Error reading {0} — {1}", filePath, ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }

            return results;
        }

        /// <summary>
        /// Parses a JSON array string into individual top-level object strings.
        /// Uses brace-depth tracking to correctly handle prettified/multi-line JSON
        /// and nested objects. Same algorithm as TradeJsonWriter.ParseExistingTrades().
        /// </summary>
        /// <param name="json">Raw JSON array string (e.g., "[{...}, {...}]")</param>
        /// <returns>List of individual JSON object strings</returns>
        private List<string> ParseJsonObjects(string json)
        {
            var objects = new List<string>();
            if (string.IsNullOrEmpty(json))
                return objects;

            int depth = 0;
            int objectStart = -1;
            bool inString = false;
            bool escaped = false;

            for (int i = 0; i < json.Length; i++)
            {
                char c = json[i];

                // Handle escape sequences inside strings
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
                // Toggle string tracking on unescaped quotes
                if (c == '"')
                {
                    inString = !inString;
                    continue;
                }
                if (inString) continue;

                // Track brace depth — depth 1 = inside a top-level object
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
                        // Extract the complete object string including braces
                        objects.Add(json.Substring(objectStart, i - objectStart + 1));
                        objectStart = -1;
                    }
                }
            }

            return objects;
        }

        /// <summary>
        /// Extracts a double value from an isolated JSON object string by field name.
        /// Handles numeric values, null, and both compact and prettified JSON.
        /// Finds the value after "fieldName": and reads until the next comma, brace, or bracket.
        /// </summary>
        /// <param name="json">JSON object string (with or without outer braces)</param>
        /// <param name="fieldName">The field name to extract</param>
        /// <returns>Parsed double value, or 0 if not found or null</returns>
        private double ExtractJsonDouble(string json, string fieldName)
        {
            // Look for "fieldName":
            string searchKey = "\"" + fieldName + "\"";
            int keyIndex = json.IndexOf(searchKey);
            if (keyIndex < 0) return 0;

            // Find the colon after the key
            int colonIndex = json.IndexOf(':', keyIndex + searchKey.Length);
            if (colonIndex < 0) return 0;

            // Extract value — ends at comma, closing brace, or closing bracket
            int valueStart = colonIndex + 1;
            int valueEnd = json.Length;
            for (int i = valueStart; i < json.Length; i++)
            {
                char c = json[i];
                if (c == ',' || c == '}' || c == ']')
                {
                    valueEnd = i;
                    break;
                }
            }

            string valueStr = json.Substring(valueStart, valueEnd - valueStart).Trim().Trim('"');

            // Handle null values
            if (valueStr == "null" || string.IsNullOrEmpty(valueStr)) return 0;

            if (double.TryParse(valueStr, System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out double result))
                return result;

            return 0;
        }

        /// <summary>
        /// Extracts a string value from an isolated JSON object string by field name.
        /// Handles quoted string values and null. Used to extract account_name for filtering.
        /// </summary>
        /// <param name="json">JSON object string (with or without outer braces)</param>
        /// <param name="fieldName">The field name to extract</param>
        /// <returns>Extracted string value, or empty string if not found or null</returns>
        private string ExtractJsonString(string json, string fieldName)
        {
            // Look for "fieldName":
            string searchKey = "\"" + fieldName + "\"";
            int keyIndex = json.IndexOf(searchKey);
            if (keyIndex < 0) return "";

            // Find the colon after the key
            int colonIndex = json.IndexOf(':', keyIndex + searchKey.Length);
            if (colonIndex < 0) return "";

            // Skip whitespace after colon to find the opening quote
            int valueStart = colonIndex + 1;
            while (valueStart < json.Length && json[valueStart] == ' ') valueStart++;

            // Check for null
            if (valueStart + 3 < json.Length && json.Substring(valueStart, 4) == "null")
                return "";

            // Expect a quoted string — find opening and closing quotes
            if (valueStart >= json.Length || json[valueStart] != '"')
                return "";

            int stringStart = valueStart + 1;
            int stringEnd = json.IndexOf('"', stringStart);
            if (stringEnd < 0) return "";

            return json.Substring(stringStart, stringEnd - stringStart);
        }

        /// <summary>
        /// Simple container for parsed trade results from local JSON files.
        /// Only holds the fields we need for stats calculations.
        /// </summary>
        private class TradeResult
        {
            public double PnlDollars { get; set; }
            public double ActualRr { get; set; }
        }

        // ─── Template System ──────────────────────────────────────────────────
        // Templates store/restore all 7 UI settings as JSON files on disk.
        // Each template is a flat JSON file in the RiskManagerTemplates directory.
        // _lastUsed.txt tracks which template was most recently loaded for auto-restore.

        /// <summary>
        /// Returns the directory path for storing template files.
        /// Creates the directory if it doesn't exist.
        /// </summary>
        private string GetTemplateDirectory()
        {
            string dir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "RiskManagerTemplates");
            if (!Directory.Exists(dir))
                Directory.CreateDirectory(dir);
            return dir;
        }

        /// <summary>
        /// Serializes all 7 current UI settings into a flat JSON string.
        /// Uses StringBuilder to match the project's existing JSON-building pattern.
        /// </summary>
        private string SerializeSettingsToJson()
        {
            var sb = new System.Text.StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"ruValue\":\"{0}\",", _ruValueInput.Text);
            sb.AppendFormat("\"riskRu\":\"{0}\",", _riskRuInput.Text);
            sb.AppendFormat("\"rrIndex\":{0},", _rrCombo.SelectedIndex);
            sb.AppendFormat("\"slModeIndex\":{0},", _slModeCombo.SelectedIndex);
            sb.AppendFormat("\"atrMult\":\"{0}\",", _atrMultInput.Text);
            sb.AppendFormat("\"trailStop\":{0},", _trailStopCheckbox.IsChecked == true ? "true" : "false");
            sb.AppendFormat("\"maxQty\":\"{0}\"", _maxQtyInput.Text);
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// Parses a JSON settings string and applies all 7 values to the UI controls.
        /// Uses basic string parsing to avoid external JSON library dependencies.
        /// Guard with _isLoadingTemplate to prevent cascading change events.
        /// </summary>
        private void ApplySettingsFromJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return;

            _isLoadingTemplate = true;
            try
            {
                // Simple JSON value extraction — matches the project's lightweight approach
                string ruValue = ExtractJsonStringValue(json, "ruValue");
                string riskRu = ExtractJsonStringValue(json, "riskRu");
                int rrIndex = ExtractJsonIntValue(json, "rrIndex", 0);
                int slModeIndex = ExtractJsonIntValue(json, "slModeIndex", 1);
                string atrMult = ExtractJsonStringValue(json, "atrMult");
                bool trailStop = ExtractJsonBoolValue(json, "trailStop");
                string maxQty = ExtractJsonStringValue(json, "maxQty");

                // Apply values to UI controls
                if (!string.IsNullOrEmpty(ruValue)) _ruValueInput.Text = ruValue;
                if (!string.IsNullOrEmpty(riskRu)) _riskRuInput.Text = riskRu;
                if (rrIndex >= 0 && rrIndex < _rrCombo.Items.Count) _rrCombo.SelectedIndex = rrIndex;
                if (slModeIndex >= 0 && slModeIndex < _slModeCombo.Items.Count) _slModeCombo.SelectedIndex = slModeIndex;
                if (!string.IsNullOrEmpty(atrMult)) _atrMultInput.Text = atrMult;
                _trailStopCheckbox.IsChecked = trailStop;
                if (!string.IsNullOrEmpty(maxQty)) _maxQtyInput.Text = maxQty;

                // Update ATR mult panel visibility based on loaded SL mode
                bool isManual = _slModeCombo.SelectedItem as string == "Manual";
                if (_atrMultPanel != null)
                    _atrMultPanel.Visibility = isManual ? Visibility.Collapsed : Visibility.Visible;

                // Refresh calculated display values with new settings
                UpdateDisplayValues();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Error applying template settings — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            finally
            {
                _isLoadingTemplate = false;
            }
        }

        /// <summary>
        /// Extracts a quoted string value from JSON by key name.
        /// Example: ExtractJsonStringValue("{\"ruValue\":\"100\"}", "ruValue") → "100"
        /// </summary>
        private string ExtractJsonStringValue(string json, string key)
        {
            string search = "\"" + key + "\":\"";
            int start = json.IndexOf(search);
            if (start < 0) return null;
            start += search.Length;
            int end = json.IndexOf("\"", start);
            if (end < 0) return null;
            return json.Substring(start, end - start);
        }

        /// <summary>
        /// Extracts an integer value from JSON by key name.
        /// Example: ExtractJsonIntValue("{\"rrIndex\":2}", "rrIndex", 0) → 2
        /// </summary>
        private int ExtractJsonIntValue(string json, string key, int defaultVal)
        {
            string search = "\"" + key + "\":";
            int start = json.IndexOf(search);
            if (start < 0) return defaultVal;
            start += search.Length;
            // Read digits until comma, brace, or end
            int end = start;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-'))
                end++;
            if (int.TryParse(json.Substring(start, end - start), out int val))
                return val;
            return defaultVal;
        }

        /// <summary>
        /// Extracts a boolean value from JSON by key name.
        /// Example: ExtractJsonBoolValue("{\"trailStop\":true}", "trailStop") → true
        /// </summary>
        private bool ExtractJsonBoolValue(string json, string key)
        {
            string search = "\"" + key + "\":";
            int start = json.IndexOf(search);
            if (start < 0) return false;
            start += search.Length;
            return json.Substring(start).TrimStart().StartsWith("true");
        }

        /// <summary>
        /// Saves the current UI settings as a named template to disk.
        /// Writes JSON to {name}.json and updates _lastUsed.txt with the template name.
        /// Thread-safe via _templateLock.
        /// </summary>
        private void SaveTemplate(string name)
        {
            lock (_templateLock)
            {
                try
                {
                    string dir = GetTemplateDirectory();
                    string filePath = Path.Combine(dir, name + ".json");
                    string json = SerializeSettingsToJson();
                    File.WriteAllText(filePath, json);

                    // Update last-used tracker so this template auto-loads next time
                    File.WriteAllText(Path.Combine(dir, "_lastUsed.txt"), name);

                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Template '{0}' saved", name),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Error saving template '{0}' — {1}", name, ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
        }

        /// <summary>
        /// Loads a named template from disk and applies its settings to the UI.
        /// Updates _lastUsed.txt so this template auto-loads on next window open.
        /// Thread-safe via _templateLock.
        /// </summary>
        private void LoadTemplate(string name)
        {
            lock (_templateLock)
            {
                try
                {
                    string dir = GetTemplateDirectory();
                    string filePath = Path.Combine(dir, name + ".json");
                    if (!File.Exists(filePath)) return;

                    string json = File.ReadAllText(filePath);
                    ApplySettingsFromJson(json);

                    // Update last-used tracker
                    File.WriteAllText(Path.Combine(dir, "_lastUsed.txt"), name);

                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Template '{0}' loaded", name),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Error loading template '{0}' — {1}", name, ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
        }

        /// <summary>
        /// Returns a list of all saved template names (filenames without .json extension).
        /// Thread-safe via _templateLock.
        /// </summary>
        private List<string> GetSavedTemplateNames()
        {
            var names = new List<string>();
            lock (_templateLock)
            {
                try
                {
                    string dir = GetTemplateDirectory();
                    foreach (string file in Directory.GetFiles(dir, "*.json"))
                        names.Add(Path.GetFileNameWithoutExtension(file));
                }
                catch { }
            }
            names.Sort();
            return names;
        }

        /// <summary>
        /// Deletes a named template file from disk.
        /// If the deleted template was the last-used one, clears _lastUsed.txt.
        /// Thread-safe via _templateLock.
        /// </summary>
        private void DeleteTemplate(string name)
        {
            lock (_templateLock)
            {
                try
                {
                    string dir = GetTemplateDirectory();
                    string filePath = Path.Combine(dir, name + ".json");
                    if (File.Exists(filePath))
                        File.Delete(filePath);

                    // Clear last-used if we just deleted it
                    string lastUsedPath = Path.Combine(dir, "_lastUsed.txt");
                    if (File.Exists(lastUsedPath) && File.ReadAllText(lastUsedPath).Trim() == name)
                        File.Delete(lastUsedPath);

                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Template '{0}' deleted", name),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("RiskManager: Error deleting template '{0}' — {1}", name, ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
        }

        /// <summary>
        /// Reads _lastUsed.txt to get the name of the most recently loaded template.
        /// Returns null if no last-used template is recorded.
        /// </summary>
        private string GetLastUsedTemplateName()
        {
            lock (_templateLock)
            {
                try
                {
                    string path = Path.Combine(GetTemplateDirectory(), "_lastUsed.txt");
                    if (File.Exists(path))
                        return File.ReadAllText(path).Trim();
                }
                catch { }
            }
            return null;
        }

        /// <summary>
        /// Refreshes the template combo box with the current list of saved templates.
        /// Preserves the current selection if it still exists after refresh.
        /// </summary>
        private void RefreshTemplateCombo()
        {
            string currentSelection = _templateCombo.SelectedItem as string;
            _isLoadingTemplate = true;
            _templateCombo.Items.Clear();
            foreach (string name in GetSavedTemplateNames())
                _templateCombo.Items.Add(name);

            // Restore previous selection if it still exists
            if (!string.IsNullOrEmpty(currentSelection))
            {
                for (int i = 0; i < _templateCombo.Items.Count; i++)
                {
                    if ((string)_templateCombo.Items[i] == currentSelection)
                    {
                        _templateCombo.SelectedIndex = i;
                        break;
                    }
                }
            }
            _isLoadingTemplate = false;
        }

        /// <summary>
        /// Opens a small WPF dialog prompting the user for a template name.
        /// Returns the entered name, or null if the user cancelled.
        /// </summary>
        private string PromptTemplateName()
        {
            // Create a simple modal dialog for template naming
            var dialog = new Window
            {
                Title = "Save Template",
                Width = 300,
                Height = 130,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Owner = this,
                ResizeMode = ResizeMode.NoResize
            };

            var panel = new StackPanel { Margin = new Thickness(10) };

            panel.Children.Add(new TextBlock
            {
                Text = "Template Name:",
                Margin = new Thickness(0, 0, 0, 5),
                Foreground = Brushes.Black
            });

            var nameBox = new TextBox
            {
                Width = 260,
                Margin = new Thickness(0, 0, 0, 10)
            };
            panel.Children.Add(nameBox);

            var buttonPanel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };

            string result = null;

            var okBtn = new Button { Content = "OK", Width = 60, Margin = new Thickness(0, 0, 5, 0) };
            okBtn.Click += (s, ev) => { result = nameBox.Text.Trim(); dialog.Close(); };
            buttonPanel.Children.Add(okBtn);

            var cancelBtn = new Button { Content = "Cancel", Width = 60 };
            cancelBtn.Click += (s, ev) => dialog.Close();
            buttonPanel.Children.Add(cancelBtn);

            panel.Children.Add(buttonPanel);
            dialog.Content = panel;

            // Focus the text box when the dialog opens
            dialog.Loaded += (s, ev) => nameBox.Focus();

            // Allow Enter key to submit
            nameBox.KeyDown += (s, ev) =>
            {
                if (ev.Key == Key.Enter)
                {
                    result = nameBox.Text.Trim();
                    dialog.Close();
                }
            };

            dialog.ShowDialog();

            return string.IsNullOrEmpty(result) ? null : result;
        }

        // ─── Workspace Persistence (IWorkspacePersistence) ──────────────────
        // Save/Restore allow NinjaTrader to persist this window's settings
        // when saving/restoring workspaces, so the window survives NT restarts.

        /// <summary>
        /// Called by NinjaTrader when saving a workspace. Writes all 7 UI settings
        /// as XAttributes on the workspace XML element for this window.
        /// </summary>
        public void Save(XDocument document, XElement element)
        {
            // Store all settings as attributes on the workspace element
            element.Add(new XAttribute("ruValue", _ruValueInput.Text));
            element.Add(new XAttribute("riskRu", _riskRuInput.Text));
            element.Add(new XAttribute("rrIndex", _rrCombo.SelectedIndex));
            element.Add(new XAttribute("slModeIndex", _slModeCombo.SelectedIndex));
            element.Add(new XAttribute("atrMult", _atrMultInput.Text));
            element.Add(new XAttribute("trailStop", _trailStopCheckbox.IsChecked == true ? "1" : "0"));
            element.Add(new XAttribute("maxQty", _maxQtyInput.Text));
        }

        /// <summary>
        /// Called by NinjaTrader when restoring a workspace. Reads XAttributes
        /// and applies them to the UI controls. Null checks ensure backward
        /// compatibility with workspaces saved before this feature existed.
        /// </summary>
        public void Restore(XDocument document, XElement element)
        {
            _isLoadingTemplate = true;
            try
            {
                // Read each attribute with null checks for backward compatibility
                XAttribute attr;

                attr = element.Attribute("ruValue");
                if (attr != null) _ruValueInput.Text = attr.Value;

                attr = element.Attribute("riskRu");
                if (attr != null) _riskRuInput.Text = attr.Value;

                attr = element.Attribute("rrIndex");
                if (attr != null && int.TryParse(attr.Value, out int rrIdx) && rrIdx >= 0 && rrIdx < _rrCombo.Items.Count)
                    _rrCombo.SelectedIndex = rrIdx;

                attr = element.Attribute("slModeIndex");
                if (attr != null && int.TryParse(attr.Value, out int slIdx) && slIdx >= 0 && slIdx < _slModeCombo.Items.Count)
                    _slModeCombo.SelectedIndex = slIdx;

                attr = element.Attribute("atrMult");
                if (attr != null) _atrMultInput.Text = attr.Value;

                attr = element.Attribute("trailStop");
                if (attr != null) _trailStopCheckbox.IsChecked = attr.Value == "1";

                attr = element.Attribute("maxQty");
                if (attr != null) _maxQtyInput.Text = attr.Value;

                // Update ATR mult panel visibility based on restored SL mode
                bool isManual = _slModeCombo.SelectedItem as string == "Manual";
                if (_atrMultPanel != null)
                    _atrMultPanel.Visibility = isManual ? Visibility.Collapsed : Visibility.Visible;

                UpdateDisplayValues();
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("RiskManager: Error restoring workspace settings — {0}", ex.Message),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }
            finally
            {
                _isLoadingTemplate = false;
            }
        }

        // ─── Cleanup ───────────────────────────────────────────────────────────

        /// <summary>
        /// Called when the window is closing. Stops the stats timer, disposes BarsRequest,
        /// unsubscribes from market data, and sets the disposed flag to stop callbacks.
        /// </summary>
        protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
        {
            _isDisposed = true;

            // Stop and clean up the stats refresh timer
            if (_statsTimer != null)
            {
                _statsTimer.Stop();
                _statsTimer = null;
            }
            _isRefreshing = false;

            // Cancel any pending manual SL wait via bridge
            if (RiskManagerBridge.WaitingForSlClick)
                RiskManagerBridge.WaitingForSlClick = false;

            // Unsubscribe from all RiskManagerBridge events
            RiskManagerBridge.OnLinked -= OnBridgeLinked;
            RiskManagerBridge.OnUnlinked -= OnBridgeUnlinked;
            RiskManagerBridge.SlPriceSelected -= OnBridgeSlPriceSelected;
            RiskManagerBridge.SlCancelled -= OnBridgeSlCancelled;

            // Clean up pending bracket order subscription if still active
            CleanupPendingBracket();

            // Clean up active trade trailing stop state
            CleanupActiveTrade();

            // Clean up data subscriptions
            DisposeBarsRequest();
            UnsubscribeMarketData();

            base.OnClosing(e);
        }
    }
}
