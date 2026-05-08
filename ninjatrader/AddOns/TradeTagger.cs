#region Using declarations
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using System.Xml.Linq;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ═══════════════════════════════════════════════════════════════════════════
    // TradeSummary — Data model for a single trade displayed in the tagger UI.
    // Contains both read-only trade data (from Supabase) and editable tag fields
    // that the user can modify. Changes are PATCHed back to Supabase.
    // ═══════════════════════════════════════════════════════════════════════════

    public class TradeSummary
    {
        // ─── Read-only trade data (populated from Supabase GET or TradeCompletedArgs) ───
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

        // ─── Trade status ──────────────────────────────────────────────────────
        // True while the trade is still open (entry filled, no exit yet).
        // TradeTagger uses this to show "(OPEN)" display and update-in-place on completion.
        public bool IsOpen { get; set; }

        // ─── Editable tag fields (user can modify via UI, PATCHed to Supabase) ───
        public string Notes { get; set; }
        public string TradeGrade { get; set; }
        public string TradeMistake { get; set; }
        public string TradeRegime { get; set; }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradeTagger — Bootstrap AddOn that injects a "Trade Tagger" menu item
    // into the Control Center's "New" menu. Same pattern as RiskManager AddOnBase.
    // ═══════════════════════════════════════════════════════════════════════════

    public class TradeTagger : AddOnBase
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
                    Name = "TradeTagger";
                    Description = "Manual trade annotation window for grading, tagging, and noting completed trades";
                    break;
            }
        }

        /// <summary>
        /// Called when any NinjaTrader window is created. Injects "Trade Tagger" menu item
        /// into the Control Center's "New" menu.
        /// </summary>
        protected override void OnWindowCreated(Window window)
        {
            // Set WorkspaceOptions on TradeTaggerWindow instances so NinjaTrader
            // can save/restore this window type when saving/restoring workspaces.
            if (window is TradeTaggerWindow ttWindow)
                ttWindow.WorkspaceOptions = new WorkspaceOptions("TradeTagger-" + Guid.NewGuid().ToString("N"), ttWindow);

            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null)
                return;

            // Guard against duplicate insertion (e.g., after F5 recompile)
            if (_menuItem != null)
                return;

            // Find the "New" menu in the Control Center's menu bar
            NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null)
                return;

            // Create our custom menu item with NinjaTrader's standard styling
            _menuItem = new NTMenuItem()
            {
                Header = "Trade Tagger",
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
                ControlCenter controlCenter = window as ControlCenter;
                NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
                if (newMenu != null)
                    newMenu.Items.Remove(_menuItem);

                _menuItem.Click -= OnMenuItemClick;
                _menuItem = null;
            }
        }

        /// <summary>
        /// Menu click handler — opens a new TradeTaggerWindow instance.
        /// </summary>
        private void OnMenuItemClick(object sender, RoutedEventArgs e)
        {
            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                new TradeTaggerWindow().Show();
            }));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TradeTaggerWindow — NTWindow for manually annotating completed trades.
    //
    // Features:
    // - Auto-loads today's trades from Supabase on open
    // - Prev/Next navigation through today's trades
    // - Auto-navigates to new trades as they complete (via TradeTrackerBridge)
    // - Grade, Mistake, Regime dropdowns + free-text Notes
    // - Auto-saves to Supabase via PATCH with 1.5s debounce timer
    // - Flushes pending saves on navigation and window close
    //
    // Thread safety: Supabase GET/PATCH runs on background threads via Task.Run.
    // All UI updates go through Dispatcher.InvokeAsync(). _isDisposed guard
    // prevents callbacks from touching disposed resources.
    // ═══════════════════════════════════════════════════════════════════════════

    public class TradeTaggerWindow : NTWindow, IWorkspacePersistence
    {
        // ─── Workspace Persistence ────────────────────────────────────────────
        // IWorkspacePersistence lets NinjaTrader save/restore this window with workspace files.
        // TradeTagger auto-loads trades on open, so Save/Restore just need to exist —
        // the window will repopulate itself when re-created.
        public WorkspaceOptions WorkspaceOptions { get; set; }

        // ─── Supabase Connection Constants ─────────────────────────────────────
        // Self-contained — duplicated from SupabaseWriter so TradeTagger has no
        // coupling to TradeTracker's internal classes.
        private const string SUPABASE_URL = "https://zidddaorklilipbxfogr.supabase.co";
        private const string SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppZGRkYW9ya2xpbGlwYnhmb2dyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwODUwODgsImV4cCI6MjA4NjY2MTA4OH0.9ankT2x20vbSjjO77bnoSsBsVd4Un5Ganu94_CtmAjk";
        private const string TRADES_ENDPOINT = SUPABASE_URL + "/rest/v1/trades";

        // ─── Dropdown option arrays ────────────────────────────────────────────
        // Empty string = "not tagged yet" → maps to null in PATCH body
        private static readonly string[] GRADE_OPTIONS = { "", "A+", "A", "B", "C", "F" };
        private static readonly string[] MISTAKE_OPTIONS = { "", "None", "Early Entry", "Late Entry",
            "Early Exit", "Late Exit", "Moved Stop", "Revenge Trade", "FOMO", "Oversized" };
        private static readonly string[] REGIME_OPTIONS = { "", "Trending", "Rangebound", "Consolidation",
            "Chop", "Breakout" };

        // ─── State ─────────────────────────────────────────────────────────────
        private List<TradeSummary> _trades = new List<TradeSummary>();
        private int _currentIndex = -1;
        private bool _isDisposed = false;
        private bool _isLoadingTrade = false;   // Prevents save triggers during programmatic UI population
        private bool _isDirty = false;          // True when unsaved changes exist
        private DispatcherTimer _saveTimer;     // 1.5s debounce timer for auto-save

        // ─── UI Controls ───────────────────────────────────────────────────────
        private TextBlock _headerInstrument;
        private TextBlock _headerPrices;
        private TextBlock _headerPnl;
        private TextBlock _headerTime;
        private ComboBox _gradeCombo;
        private ComboBox _mistakeCombo;
        private ComboBox _regimeCombo;
        private TextBox _notesBox;
        private Button _prevButton;
        private Button _nextButton;
        private Button _refreshButton;
        private TextBlock _navLabel;

        // ─── Constructor ───────────────────────────────────────────────────────

        public TradeTaggerWindow()
        {
            Caption = "Trade Tagger";
            Width = 400;
            Height = 520;

            // Build the entire UI programmatically (no XAML)
            BuildUI();

            // Wire control event handlers AFTER UI is built
            _gradeCombo.SelectionChanged += OnTagChanged;
            _mistakeCombo.SelectionChanged += OnTagChanged;
            _regimeCombo.SelectionChanged += OnTagChanged;
            _notesBox.TextChanged += OnTagChanged;
            _prevButton.Click += OnPrevClick;
            _nextButton.Click += OnNextClick;
            _refreshButton.Click += OnRefreshClick;

            // Subscribe to trade lifecycle events from TradeTracker
            TradeTrackerBridge.OnTradeCompleted += OnTradeCompleted;
            TradeTrackerBridge.OnTradeOpened += OnTradeOpened;

            // Initialize the debounce timer — 1.5s interval, stopped by default.
            // When the timer ticks, it fires the PATCH and stops itself.
            _saveTimer = new DispatcherTimer();
            _saveTimer.Interval = TimeSpan.FromMilliseconds(1500);
            _saveTimer.Tick += OnSaveTimerTick;

            // Load today's trades from Supabase in the background
            LoadTodaysTradesAsync();
        }

        // ─── UI Construction ───────────────────────────────────────────────────

        /// <summary>
        /// Builds the entire TradeTagger UI programmatically using a WPF Grid.
        /// No XAML — all controls created in code, same approach as RiskManagerWindow.
        /// Layout: 15 rows, 2 columns. Top section = trade info (read-only),
        /// middle = tag dropdowns + notes, bottom = prev/next navigation.
        /// </summary>
        private void BuildUI()
        {
            var grid = new Grid();
            grid.Margin = new Thickness(12);

            // Define 2 columns: labels (auto) and controls (stretch)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            // Define 15 rows for the layout
            for (int i = 0; i < 15; i++)
            {
                if (i == 12) // Notes TextBox row gets extra height
                    grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(100) });
                else
                    grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            }

            // Use NinjaTrader theme brushes for consistent appearance
            Brush fontBrush = Application.Current.TryFindResource("FontControlBrush") as Brush ?? Brushes.White;

            // ── Row 0: Header ──
            var title = new TextBlock
            {
                Text = "Trade Tagger",
                FontSize = 16,
                FontWeight = FontWeights.Bold,
                HorizontalAlignment = HorizontalAlignment.Center,
                Foreground = fontBrush,
                Margin = new Thickness(0, 0, 0, 6)
            };
            Grid.SetRow(title, 0);
            Grid.SetColumnSpan(title, 2);
            grid.Children.Add(title);

            // ── Row 1: Separator ──
            grid.Children.Add(MakeSeparator(1));

            // ── Row 2: Instrument + Direction ──
            _headerInstrument = new TextBlock
            {
                Text = "No trades today",
                FontSize = 14,
                FontWeight = FontWeights.SemiBold,
                Foreground = fontBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 6, 0, 2)
            };
            Grid.SetRow(_headerInstrument, 2);
            Grid.SetColumnSpan(_headerInstrument, 2);
            grid.Children.Add(_headerInstrument);

            // ── Row 3: Entry/Exit prices ──
            _headerPrices = new TextBlock
            {
                Text = "",
                Foreground = fontBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 2, 0, 2)
            };
            Grid.SetRow(_headerPrices, 3);
            Grid.SetColumnSpan(_headerPrices, 2);
            grid.Children.Add(_headerPrices);

            // ── Row 4: P&L (green/red) ──
            _headerPnl = new TextBlock
            {
                Text = "",
                FontWeight = FontWeights.SemiBold,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 2, 0, 2)
            };
            Grid.SetRow(_headerPnl, 4);
            Grid.SetColumnSpan(_headerPnl, 2);
            grid.Children.Add(_headerPnl);

            // ── Row 5: Entry/Exit times ──
            _headerTime = new TextBlock
            {
                Text = "",
                Foreground = fontBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 2, 0, 6)
            };
            Grid.SetRow(_headerTime, 5);
            Grid.SetColumnSpan(_headerTime, 2);
            grid.Children.Add(_headerTime);

            // ── Row 6: Separator ──
            grid.Children.Add(MakeSeparator(6));

            // ── Row 7: Grade dropdown ──
            grid.Children.Add(MakeLabel("Grade:", 7, fontBrush));
            _gradeCombo = MakeComboBox(GRADE_OPTIONS, 7);
            grid.Children.Add(_gradeCombo);

            // ── Row 8: Mistake dropdown ──
            grid.Children.Add(MakeLabel("Mistake:", 8, fontBrush));
            _mistakeCombo = MakeComboBox(MISTAKE_OPTIONS, 8);
            grid.Children.Add(_mistakeCombo);

            // ── Row 9: Regime dropdown ──
            grid.Children.Add(MakeLabel("Regime:", 9, fontBrush));
            _regimeCombo = MakeComboBox(REGIME_OPTIONS, 9);
            grid.Children.Add(_regimeCombo);

            // ── Row 10: Separator ──
            grid.Children.Add(MakeSeparator(10));

            // ── Row 11: Notes label ──
            grid.Children.Add(MakeLabel("Notes:", 11, fontBrush));

            // ── Row 12: Notes TextBox (multiline) ──
            _notesBox = new TextBox
            {
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Margin = new Thickness(0, 4, 0, 4),
                Height = 90
            };
            Grid.SetRow(_notesBox, 12);
            Grid.SetColumnSpan(_notesBox, 2);
            grid.Children.Add(_notesBox);

            // ── Row 13: Separator ──
            grid.Children.Add(MakeSeparator(13));

            // ── Row 14: Navigation — [< Prev] | "Trade X of Y" | [Next >] | [Refresh] ──
            var navPanel = new Grid();
            navPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            navPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            navPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            navPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            navPanel.Margin = new Thickness(0, 6, 0, 0);

            _prevButton = new Button
            {
                Content = "< Prev",
                IsEnabled = false,
                Margin = new Thickness(0, 0, 4, 0)
            };
            Grid.SetColumn(_prevButton, 0);
            navPanel.Children.Add(_prevButton);

            _navLabel = new TextBlock
            {
                Text = "No trades",
                Foreground = fontBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(_navLabel, 1);
            navPanel.Children.Add(_navLabel);

            _nextButton = new Button
            {
                Content = "Next >",
                IsEnabled = false,
                Margin = new Thickness(4, 0, 0, 0)
            };
            Grid.SetColumn(_nextButton, 2);
            navPanel.Children.Add(_nextButton);

            // Refresh button — re-fetches today's trades from Supabase (source of truth)
            // Useful when auto-navigate misses a trade closed via SL/TP
            _refreshButton = new Button
            {
                Content = "↻",
                ToolTip = "Refresh trades from Supabase",
                Margin = new Thickness(4, 0, 0, 0),
                Padding = new Thickness(6, 2, 6, 2)
            };
            Grid.SetColumn(_refreshButton, 3);
            navPanel.Children.Add(_refreshButton);

            Grid.SetRow(navPanel, 14);
            Grid.SetColumnSpan(navPanel, 2);
            grid.Children.Add(navPanel);

            // Set the grid as the window content
            Content = grid;
        }

        /// <summary>Creates a label TextBlock positioned in the specified grid row, column 0.</summary>
        private TextBlock MakeLabel(string text, int row, Brush foreground)
        {
            var label = new TextBlock
            {
                Text = text,
                Foreground = foreground,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 4, 8, 4)
            };
            Grid.SetRow(label, row);
            Grid.SetColumn(label, 0);
            return label;
        }

        /// <summary>Creates a ComboBox with the given items, positioned in the specified grid row, column 1.</summary>
        private ComboBox MakeComboBox(string[] items, int row)
        {
            var combo = new ComboBox { Margin = new Thickness(0, 4, 0, 4) };
            foreach (var item in items)
                combo.Items.Add(item);
            combo.SelectedIndex = 0;
            Grid.SetRow(combo, row);
            Grid.SetColumn(combo, 1);
            return combo;
        }

        /// <summary>Creates a horizontal Separator spanning both columns at the specified row.</summary>
        private Separator MakeSeparator(int row)
        {
            var sep = new Separator { Margin = new Thickness(0, 4, 0, 4) };
            Grid.SetRow(sep, row);
            Grid.SetColumnSpan(sep, 2);
            return sep;
        }

        // ─── Load Today's Trades from Supabase ────────────────────────────────

        /// <summary>
        /// Fetches today's trades from Supabase via GET request on a background thread.
        /// Parses the JSON response manually (NT8 has no JSON deserializer) and populates
        /// the _trades list. Navigates to the most recent trade after loading.
        /// </summary>
        private void LoadTodaysTradesAsync()
        {
            Task.Run(() =>
            {
                try
                {
                    // Build the GET URL with PostgREST filters for today's trades.
                    // Include trade_status to identify open vs closed trades.
                    // Order by entry_time (not exit_time) so open trades with null exit_time sort correctly.
                    string today = DateTime.Today.ToString("yyyy-MM-dd");
                    string selectFields = "entry_time,exit_time,instrument,direction,entry_price,exit_price,"
                        + "pnl_points,pnl_dollars,actual_rr,account_name,notes,trade_grade,trade_mistake,trade_regime,trade_status";
                    string url = string.Format(
                        "{0}?select={1}&entry_time=gte.{2}T00:00:00&order=entry_time.asc",
                        TRADES_ENDPOINT, selectFields, today);

                    // Create the HTTP GET request
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "GET";
                    request.Timeout = 10000;
                    request.Headers.Add("apikey", SUPABASE_ANON_KEY);
                    request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);

                    string responseBody;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                    {
                        responseBody = reader.ReadToEnd();
                    }

                    // Parse the JSON array response into TradeSummary objects
                    var trades = ParseTradesJson(responseBody);

                    // Marshal results to the UI thread
                    if (_isDisposed) return;
                    Dispatcher.InvokeAsync(new Action(() =>
                    {
                        if (_isDisposed) return;
                        _trades = trades;
                        _currentIndex = _trades.Count > 0 ? _trades.Count - 1 : -1;
                        DisplayCurrentTrade();
                    }));
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTagger: Failed to load trades — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        // ─── JSON Parsing Helpers ──────────────────────────────────────────────
        // NT8 has no JSON deserializer. These simple string-search helpers parse the
        // flat, predictable PostgREST GET response using indexOf + substring.

        /// <summary>
        /// Parses a PostgREST JSON array response into a list of TradeSummary objects.
        /// Splits by "},{" to isolate individual trade objects, then extracts fields.
        /// </summary>
        private List<TradeSummary> ParseTradesJson(string json)
        {
            var result = new List<TradeSummary>();
            if (string.IsNullOrEmpty(json) || json == "[]")
                return result;

            // Remove the outer array brackets
            json = json.Trim();
            if (json.StartsWith("[")) json = json.Substring(1);
            if (json.EndsWith("]")) json = json.Substring(0, json.Length - 1);

            // Split by "},{" to separate individual trade objects
            // Re-add the braces that were consumed by the split
            string[] parts = json.Split(new string[] { "},{" }, StringSplitOptions.RemoveEmptyEntries);

            for (int i = 0; i < parts.Length; i++)
            {
                string obj = parts[i];
                // Restore braces consumed by split
                if (!obj.StartsWith("{")) obj = "{" + obj;
                if (!obj.EndsWith("}")) obj = obj + "}";

                try
                {
                    var trade = new TradeSummary
                    {
                        EntryTime = ExtractJsonDateTime(obj, "entry_time"),
                        ExitTime = ExtractJsonDateTime(obj, "exit_time"),
                        Instrument = ExtractJsonString(obj, "instrument"),
                        Direction = ExtractJsonString(obj, "direction"),
                        AccountName = ExtractJsonString(obj, "account_name"),
                        EntryPrice = ExtractJsonDouble(obj, "entry_price"),
                        ExitPrice = ExtractJsonDouble(obj, "exit_price"),
                        PnlPoints = ExtractJsonDouble(obj, "pnl_points"),
                        PnlDollars = ExtractJsonDouble(obj, "pnl_dollars"),
                        ActualRR = ExtractJsonDouble(obj, "actual_rr"),
                        Notes = ExtractJsonString(obj, "notes"),
                        TradeGrade = ExtractJsonString(obj, "trade_grade"),
                        TradeMistake = ExtractJsonString(obj, "trade_mistake"),
                        TradeRegime = ExtractJsonString(obj, "trade_regime"),
                        // Set IsOpen based on trade_status — "open" means trade is still in play
                        IsOpen = (ExtractJsonString(obj, "trade_status") == "open")
                    };
                    result.Add(trade);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTagger: Failed to parse trade object — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }

            return result;
        }

        /// <summary>
        /// Extracts a string value for the given JSON key. Returns empty string if not found or null.
        /// Handles both quoted strings and JSON null literals.
        /// </summary>
        private string ExtractJsonString(string json, string key)
        {
            // Look for "key": pattern
            string search = "\"" + key + "\":";
            int idx = json.IndexOf(search);
            if (idx < 0) return "";

            int valueStart = idx + search.Length;
            // Skip whitespace
            while (valueStart < json.Length && json[valueStart] == ' ') valueStart++;

            if (valueStart >= json.Length) return "";

            // Check for null
            if (json.Length >= valueStart + 4 && json.Substring(valueStart, 4) == "null")
                return "";

            // Check for quoted string
            if (json[valueStart] == '"')
            {
                int strStart = valueStart + 1;
                int strEnd = strStart;
                // Find closing quote (handle escaped quotes)
                while (strEnd < json.Length)
                {
                    if (json[strEnd] == '\\')
                    {
                        strEnd += 2; // Skip escaped character
                        continue;
                    }
                    if (json[strEnd] == '"')
                        break;
                    strEnd++;
                }
                return json.Substring(strStart, strEnd - strStart)
                    .Replace("\\n", "\n")
                    .Replace("\\r", "\r")
                    .Replace("\\t", "\t")
                    .Replace("\\\"", "\"")
                    .Replace("\\\\", "\\");
            }

            return "";
        }

        /// <summary>
        /// Extracts a numeric (double) value for the given JSON key. Returns 0 if not found or null.
        /// </summary>
        private double ExtractJsonDouble(string json, string key)
        {
            string search = "\"" + key + "\":";
            int idx = json.IndexOf(search);
            if (idx < 0) return 0;

            int valueStart = idx + search.Length;
            while (valueStart < json.Length && json[valueStart] == ' ') valueStart++;

            if (valueStart >= json.Length) return 0;
            if (json.Length >= valueStart + 4 && json.Substring(valueStart, 4) == "null")
                return 0;

            // Read until comma, closing brace, or end of string
            int valueEnd = valueStart;
            while (valueEnd < json.Length && json[valueEnd] != ',' && json[valueEnd] != '}')
                valueEnd++;

            string numStr = json.Substring(valueStart, valueEnd - valueStart).Trim();
            double result;
            if (double.TryParse(numStr, System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out result))
                return result;
            return 0;
        }

        /// <summary>
        /// Extracts a DateTime value for the given JSON key. Returns DateTime.MinValue if not found.
        /// Handles ISO 8601 format strings from PostgREST (e.g., "2026-03-12T10:32:15").
        /// </summary>
        private DateTime ExtractJsonDateTime(string json, string key)
        {
            string str = ExtractJsonString(json, key);
            if (string.IsNullOrEmpty(str)) return DateTime.MinValue;

            DateTime result;
            if (DateTime.TryParse(str, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out result))
                return result;
            return DateTime.MinValue;
        }

        // ─── Display Current Trade ─────────────────────────────────────────────

        /// <summary>
        /// Populates all UI controls with data from _trades[_currentIndex].
        /// If no trades exist, shows "No trades today" and disables all controls.
        /// Uses _isLoadingTrade guard to prevent OnTagChanged from firing save
        /// when we programmatically set dropdown/notes values.
        /// </summary>
        private void DisplayCurrentTrade()
        {
            if (_trades.Count == 0 || _currentIndex < 0 || _currentIndex >= _trades.Count)
            {
                // No trades to show — display placeholder and disable controls
                _headerInstrument.Text = "No trades today";
                _headerPrices.Text = "";
                _headerPnl.Text = "";
                _headerTime.Text = "";
                _navLabel.Text = "No trades";

                _isLoadingTrade = true;
                _gradeCombo.SelectedIndex = 0;
                _mistakeCombo.SelectedIndex = 0;
                _regimeCombo.SelectedIndex = 0;
                _notesBox.Text = "";
                _isLoadingTrade = false;

                _gradeCombo.IsEnabled = false;
                _mistakeCombo.IsEnabled = false;
                _regimeCombo.IsEnabled = false;
                _notesBox.IsEnabled = false;
                _prevButton.IsEnabled = false;
                _nextButton.IsEnabled = false;
                return;
            }

            var trade = _trades[_currentIndex];

            // ── Set read-only trade info labels ──
            _headerInstrument.Text = string.Format("{0}  |  {1}", trade.Instrument, trade.Direction);

            if (trade.IsOpen)
            {
                // Open trade display — show entry data with "(OPEN)" indicators
                _headerPrices.Text = string.Format("Entry: {0}  Exit: Awaiting exit...",
                    trade.EntryPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

                _headerPnl.Text = "(OPEN)";
                _headerPnl.Foreground = Brushes.DodgerBlue;

                _headerTime.Text = string.Format("{0} — ...",
                    trade.EntryTime.ToString("h:mm:ss tt"));
            }
            else
            {
                // Closed trade display — existing logic
                _headerPrices.Text = string.Format("Entry: {0}  Exit: {1}",
                    trade.EntryPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture),
                    trade.ExitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

                // P&L with green/red coloring — positive = green, negative = red
                string pnlSign = trade.PnlPoints >= 0 ? "+" : "";
                _headerPnl.Text = string.Format("P&L: {0}{1} pts (${2})  |  {3}R",
                    pnlSign,
                    trade.PnlPoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture),
                    trade.PnlDollars.ToString("F2", System.Globalization.CultureInfo.InvariantCulture),
                    trade.ActualRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
                _headerPnl.Foreground = trade.PnlPoints >= 0 ? Brushes.Green : Brushes.Red;

                _headerTime.Text = string.Format("{0} — {1}",
                    trade.EntryTime.ToString("h:mm:ss tt"),
                    trade.ExitTime.ToString("h:mm:ss tt"));
            }

            // ── Set editable tag controls (with save guard) ──
            _isLoadingTrade = true;

            _gradeCombo.IsEnabled = true;
            _mistakeCombo.IsEnabled = true;
            _regimeCombo.IsEnabled = true;
            _notesBox.IsEnabled = true;

            // Set dropdown selections — find the matching item or default to index 0 (empty)
            _gradeCombo.SelectedIndex = FindComboIndex(_gradeCombo, trade.TradeGrade);
            _mistakeCombo.SelectedIndex = FindComboIndex(_mistakeCombo, trade.TradeMistake);
            _regimeCombo.SelectedIndex = FindComboIndex(_regimeCombo, trade.TradeRegime);
            _notesBox.Text = trade.Notes ?? "";

            _isLoadingTrade = false;

            // ── Update navigation controls ──
            _prevButton.IsEnabled = _currentIndex > 0;
            _nextButton.IsEnabled = _currentIndex < _trades.Count - 1;
            _navLabel.Text = string.Format("Trade {0} of {1}", _currentIndex + 1, _trades.Count);
        }

        /// <summary>
        /// Finds the index of a value in a ComboBox's items. Returns 0 (empty) if not found.
        /// </summary>
        private int FindComboIndex(ComboBox combo, string value)
        {
            if (string.IsNullOrEmpty(value)) return 0;
            for (int i = 0; i < combo.Items.Count; i++)
            {
                if (string.Equals(combo.Items[i] as string, value, StringComparison.OrdinalIgnoreCase))
                    return i;
            }
            return 0;
        }

        // ─── Auto-Save with Debounce ───────────────────────────────────────────

        /// <summary>
        /// Fired when any editable control (grade, mistake, regime, notes) changes.
        /// Updates the in-memory TradeSummary and restarts the 1.5s debounce timer.
        /// Skipped when _isLoadingTrade is true (programmatic population, not user edit).
        /// </summary>
        private void OnTagChanged(object sender, EventArgs e)
        {
            // Don't trigger save when we're programmatically populating controls
            if (_isLoadingTrade) return;
            if (_currentIndex < 0 || _currentIndex >= _trades.Count) return;

            // Update the in-memory trade with current control values
            var trade = _trades[_currentIndex];
            trade.TradeGrade = _gradeCombo.SelectedItem as string ?? "";
            trade.TradeMistake = _mistakeCombo.SelectedItem as string ?? "";
            trade.TradeRegime = _regimeCombo.SelectedItem as string ?? "";
            trade.Notes = _notesBox.Text ?? "";

            // Mark dirty and restart the debounce timer
            _isDirty = true;
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        /// <summary>
        /// Fires 1.5s after the last tag change. Captures the current trade's data
        /// and PATCHes it to Supabase on a background thread. Stops itself after firing.
        /// </summary>
        private void OnSaveTimerTick(object sender, EventArgs e)
        {
            _saveTimer.Stop();

            if (!_isDirty) return;
            if (_currentIndex < 0 || _currentIndex >= _trades.Count) return;

            // Capture trade data for the background PATCH
            var trade = _trades[_currentIndex];
            _isDirty = false;

            PatchTradeTagAsync(trade);
        }

        /// <summary>
        /// Immediately flushes any pending save. Called before navigation (prev/next)
        /// and on window close to ensure no tag edits are lost.
        /// </summary>
        private void FlushPendingSave()
        {
            if (!_isDirty) return;
            _saveTimer.Stop();

            if (_currentIndex < 0 || _currentIndex >= _trades.Count) return;

            var trade = _trades[_currentIndex];
            _isDirty = false;

            PatchTradeTagAsync(trade);
        }

        /// <summary>
        /// PATCHes the tag fields (grade, mistake, regime, notes) to Supabase on a
        /// background thread. Uses PostgREST query-string filters to target the correct row.
        /// Empty dropdown values map to JSON null (cleared tags).
        /// </summary>
        private void PatchTradeTagAsync(TradeSummary trade)
        {
            // Capture all values on the UI thread before switching to background
            string entryTime = trade.EntryTime.ToString("yyyy-MM-ddTHH:mm:ss");
            string exitTime = trade.ExitTime.ToString("yyyy-MM-ddTHH:mm:ss");
            string instrument = trade.Instrument;
            string accountName = trade.AccountName;
            string grade = trade.TradeGrade;
            string mistake = trade.TradeMistake;
            string regime = trade.TradeRegime;
            string notes = trade.Notes;

            Task.Run(() =>
            {
                try
                {
                    // Build the PATCH URL with PostgREST query-string filters (WHERE clause)
                    string url = string.Format(
                        "{0}?entry_time=eq.{1}&exit_time=eq.{2}&instrument=eq.{3}&account_name=eq.{4}",
                        TRADES_ENDPOINT,
                        Uri.EscapeDataString(entryTime),
                        Uri.EscapeDataString(exitTime),
                        Uri.EscapeDataString(instrument),
                        Uri.EscapeDataString(accountName));

                    // Build JSON body — empty strings map to null (clears the tag in Supabase)
                    var sb = new StringBuilder();
                    sb.Append("{");
                    sb.AppendFormat("\"trade_grade\":{0},", FormatJsonStringOrNull(grade));
                    sb.AppendFormat("\"trade_mistake\":{0},", FormatJsonStringOrNull(mistake));
                    sb.AppendFormat("\"trade_regime\":{0},", FormatJsonStringOrNull(regime));
                    sb.AppendFormat("\"notes\":{0}", FormatJsonStringOrNull(notes));
                    sb.Append("}");

                    string json = sb.ToString();

                    // Create and send the HTTP PATCH request
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "PATCH";
                    request.ContentType = "application/json";
                    request.Timeout = 10000;
                    request.Headers.Add("apikey", SUPABASE_ANON_KEY);
                    request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
                    request.Headers.Add("Prefer", "return=minimal");

                    byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
                    request.ContentLength = bodyBytes.Length;

                    using (Stream requestStream = request.GetRequestStream())
                    {
                        requestStream.Write(bodyBytes, 0, bodyBytes.Length);
                    }

                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        int statusCode = (int)response.StatusCode;
                        if (statusCode >= 200 && statusCode < 300)
                        {
                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeTagger: Saved tags for {0} {1}",
                                    instrument, exitTime),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                        else
                        {
                            NinjaTrader.Code.Output.Process(
                                string.Format("TradeTagger: PATCH unexpected status {0} for {1}",
                                    statusCode, instrument),
                                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        }
                    }
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTagger: Failed to save tags — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// Formats a string value as a JSON quoted string, or as the JSON null literal
        /// if the string is empty. This maps empty dropdown selections to null in Supabase
        /// (meaning "not tagged yet") rather than storing empty strings.
        /// </summary>
        private string FormatJsonStringOrNull(string value)
        {
            if (string.IsNullOrEmpty(value))
                return "null";
            // Escape special characters for JSON safety
            string escaped = value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
            return "\"" + escaped + "\"";
        }

        // ─── Navigation ────────────────────────────────────────────────────────

        /// <summary>
        /// Navigate to the previous trade. Flushes pending save first to avoid losing edits.
        /// </summary>
        private void OnPrevClick(object sender, RoutedEventArgs e)
        {
            FlushPendingSave();
            if (_currentIndex > 0)
            {
                _currentIndex--;
                DisplayCurrentTrade();
            }
        }

        /// <summary>
        /// Navigate to the next trade. Flushes pending save first to avoid losing edits.
        /// </summary>
        private void OnNextClick(object sender, RoutedEventArgs e)
        {
            FlushPendingSave();
            if (_currentIndex < _trades.Count - 1)
            {
                _currentIndex++;
                DisplayCurrentTrade();
            }
        }

        /// <summary>
        /// Refresh button handler — flushes any pending save, then re-fetches today's
        /// trades from Supabase. This is the reliable fallback when auto-navigate doesn't
        /// fire (e.g., trades closed via SL/TP where event ordering may cause a race condition).
        /// </summary>
        private void OnRefreshClick(object sender, RoutedEventArgs e)
        {
            FlushPendingSave();
            LoadTodaysTradesAsync();
        }

        // ─── Open Trade Display ──────────────────────────────────────────────

        /// <summary>
        /// Called by TradeTrackerBridge when a new trade opens (entry fills). Creates an
        /// open TradeSummary with IsOpen=true and zero/default exit fields, appends it
        /// to _trades, and navigates to it so the user sees the trade in real-time.
        /// </summary>
        private void OnTradeOpened(TradeOpenedArgs args)
        {
            if (_isDisposed) return;

            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;

                FlushPendingSave();

                // Create an open trade summary with entry-only data
                var trade = new TradeSummary
                {
                    EntryTime = args.EntryTime,
                    ExitTime = DateTime.MinValue,
                    Instrument = args.Instrument,
                    Direction = args.Direction,
                    AccountName = args.AccountName,
                    EntryPrice = args.EntryPrice,
                    ExitPrice = 0,
                    PnlPoints = 0,
                    PnlDollars = 0,
                    ActualRR = 0,
                    IsOpen = true,
                    Notes = "",
                    TradeGrade = "",
                    TradeMistake = "",
                    TradeRegime = ""
                };

                _trades.Add(trade);
                _currentIndex = _trades.Count - 1;
                DisplayCurrentTrade();

                NinjaTrader.Code.Output.Process(
                    string.Format("TradeTagger: Open trade displayed — {0} {1} @ {2:F2}",
                        args.Direction, args.Instrument, args.EntryPrice),
                    NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            }));
        }

        // ─── Auto-Navigate on Trade Completion ─────────────────────────────────

        /// <summary>
        /// Called by TradeTrackerBridge when a new trade completes. Fires from TradeTracker's
        /// background thread, so we marshal to the UI thread via Dispatcher.InvokeAsync.
        /// Searches backwards for a matching open trade to update-in-place; if none found,
        /// appends as a new completed trade (existing behavior).
        /// </summary>
        private void OnTradeCompleted(TradeCompletedArgs args)
        {
            if (_isDisposed) return;

            Dispatcher.InvokeAsync(new Action(() =>
            {
                if (_isDisposed) return;

                // Flush any pending save for the current trade before switching
                FlushPendingSave();

                // Search backwards for an existing open trade matching this completion.
                // Match on instrument + account + entry_time within 2s tolerance.
                // If found, update-in-place so tags/notes added while open are preserved.
                int matchIndex = -1;
                for (int i = _trades.Count - 1; i >= 0; i--)
                {
                    var existing = _trades[i];
                    if (existing.IsOpen &&
                        existing.Instrument == args.Instrument &&
                        existing.AccountName == args.AccountName &&
                        Math.Abs((existing.EntryTime - args.EntryTime).TotalSeconds) < 2)
                    {
                        matchIndex = i;
                        break;
                    }
                }

                if (matchIndex >= 0)
                {
                    // Update the existing open trade in-place with exit data
                    var existing = _trades[matchIndex];
                    existing.ExitTime = args.ExitTime;
                    existing.ExitPrice = args.ExitPrice;
                    existing.PnlPoints = args.PnlPoints;
                    existing.PnlDollars = args.PnlDollars;
                    existing.ActualRR = args.ActualRR;
                    existing.IsOpen = false;

                    _currentIndex = matchIndex;
                    DisplayCurrentTrade();

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTagger: Updated open trade in-place — {0} {1}",
                            args.Direction, args.Instrument),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
                else
                {
                    // No matching open trade — append as a new completed trade
                    var trade = new TradeSummary
                    {
                        EntryTime = args.EntryTime,
                        ExitTime = args.ExitTime,
                        Instrument = args.Instrument,
                        Direction = args.Direction,
                        AccountName = args.AccountName,
                        EntryPrice = args.EntryPrice,
                        ExitPrice = args.ExitPrice,
                        PnlPoints = args.PnlPoints,
                        PnlDollars = args.PnlDollars,
                        ActualRR = args.ActualRR,
                        IsOpen = false,
                        Notes = "",
                        TradeGrade = "",
                        TradeMistake = "",
                        TradeRegime = ""
                    };

                    _trades.Add(trade);
                    _currentIndex = _trades.Count - 1;
                    DisplayCurrentTrade();

                    NinjaTrader.Code.Output.Process(
                        string.Format("TradeTagger: Auto-navigated to new trade — {0} {1}",
                            args.Direction, args.Instrument),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }));
        }

        // ─── Workspace Persistence (IWorkspacePersistence) ──────────────────
        // TradeTagger auto-loads today's trades on open, so workspace persistence
        // only needs to re-open the window — no settings to save/restore.

        /// <summary>
        /// Called by NinjaTrader when saving a workspace. Empty body because
        /// TradeTagger has no settings to persist — it loads trades on construction.
        /// </summary>
        public void Save(XDocument document, XElement element)
        {
            // No settings to persist — trades auto-load from Supabase on window open
        }

        /// <summary>
        /// Called by NinjaTrader when restoring a workspace. Empty body because
        /// TradeTagger has no settings to restore — it loads trades on construction.
        /// </summary>
        public void Restore(XDocument document, XElement element)
        {
            // No settings to restore — trades auto-load from Supabase on window open
        }

        // ─── Cleanup ───────────────────────────────────────────────────────────

        /// <summary>
        /// Called when the window is closing. Flushes pending saves, stops the timer,
        /// and unsubscribes from TradeTrackerBridge events to prevent memory leaks.
        /// </summary>
        protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
        {
            _isDisposed = true;

            // Flush any pending tag save before closing
            FlushPendingSave();

            // Stop and clean up the debounce timer
            if (_saveTimer != null)
            {
                _saveTimer.Stop();
                _saveTimer.Tick -= OnSaveTimerTick;
                _saveTimer = null;
            }

            // Unsubscribe from trade lifecycle events
            TradeTrackerBridge.OnTradeCompleted -= OnTradeCompleted;
            TradeTrackerBridge.OnTradeOpened -= OnTradeOpened;

            base.OnClosing(e);
        }
    }
}
