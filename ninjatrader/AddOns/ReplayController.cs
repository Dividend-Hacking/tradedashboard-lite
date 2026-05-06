#region Using declarations
using System;
using System.Linq;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using System.Xml.Linq;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    // ═══════════════════════════════════════════════════════════════════════════
    // ReplayController — NinjaTrader 8 AddOn for enhanced Market Replay control.
    //
    // Motivation:
    //   NT8's built-in Market Replay loads the last-used time on connect, forcing
    //   you to wait for full initialization before changing the start time. It also
    //   lacks bar-stepping. This AddOn adds:
    //     - Pre-connect time picker (set time BEFORE connecting so NT8 loads correctly)
    //     - Random weekday time jump for quick ad-hoc replay sessions
    //     - Play / Pause / Speed controls
    //     - Bar-step: advances one bar interval then auto-pauses (1m/5m/15m/1h/Daily)
    //
    // Architecture:
    //   ReplayController  : AddOnBase       — menu injection only, minimal class
    //   ReplayControllerWindow : NTWindow   — all UI + logic + IWorkspacePersistence
    //
    // NT8 Playback API access:
    //   Two types are needed — both instance-based, located at call time via helpers:
    //     PlaybackAdapter (NinjaTrader.Core)  — Connect/Disconnect, IsAvailable, FromEst, NowEst, PlaybackSpeed
    //     PlaybackControlCenter (NinjaTrader.Gui) — Play(), Pause(), SetPlaybackSpeed()
    //   Both resolved via reflection. If not found, _apiResolved=false and controls are inert.
    //
    // Threading:
    //   DispatcherTimer fires on the GUI thread, so all status updates / UI mutations
    //   happen without explicit Dispatcher.Invoke calls.
    // ═══════════════════════════════════════════════════════════════════════════

    /// <summary>
    /// Bootstrap AddOn — injects "Replay Controller" into Control Center → New menu.
    /// All real functionality lives in ReplayControllerWindow.
    /// </summary>
    public class ReplayController : AddOnBase
    {
        // Reference kept so we can remove the item when the Control Center closes
        private NTMenuItem _menuItem;

        /// <summary>
        /// NT8 lifecycle entry point. Only SetDefaults is used — no background work here.
        /// </summary>
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name        = "ReplayController";
                Description = "Enhanced Market Replay panel: pre-connect time picker, bar-step, random time, and transport controls";
            }
        }

        /// <summary>
        /// Called when any NT8 window is created. We look for the Control Center and
        /// inject our menu item. Also sets WorkspaceOptions on any ReplayControllerWindow
        /// instances so NT8 can save/restore the window with workspace files.
        /// </summary>
        protected override void OnWindowCreated(Window window)
        {
            // Tag ReplayControllerWindow instances for workspace persistence
            if (window is ReplayControllerWindow rcWindow)
                rcWindow.WorkspaceOptions = new WorkspaceOptions("ReplayController-" + Guid.NewGuid().ToString("N"), rcWindow);

            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null)
                return;

            // Guard against duplicate insertion after F5 recompile
            if (_menuItem != null)
                return;

            NTMenuItem newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null)
                return;

            _menuItem = new NTMenuItem
            {
                Header = "Replay Controller",
                Style  = Application.Current.TryFindResource("SubItemStyle") as Style
            };
            _menuItem.Click += OnMenuItemClick;
            newMenu.Items.Add(_menuItem);
        }

        /// <summary>
        /// Called when any NT8 window is destroyed. Remove our menu item if it's
        /// the Control Center that's closing to prevent stale/ghost entries.
        /// </summary>
        protected override void OnWindowDestroyed(Window window)
        {
            if (_menuItem != null && window is ControlCenter)
            {
                ControlCenter controlCenter = window as ControlCenter;
                NTMenuItem newMenu = controlCenter?.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
                newMenu?.Items.Remove(_menuItem);

                _menuItem.Click -= OnMenuItemClick;
                _menuItem = null;
            }
        }

        /// <summary>
        /// Opens a new ReplayControllerWindow on the UI thread.
        /// </summary>
        private void OnMenuItemClick(object sender, RoutedEventArgs e)
        {
            Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                new ReplayControllerWindow().Show();
            }));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ReplayControllerWindow — Floating panel for enhanced Market Replay control.
    // ═══════════════════════════════════════════════════════════════════════════

    /// <summary>
    /// ReplayControllerWindow — all UI and logic for replay control.
    ///
    /// Sections:
    ///   Status bar      — connection dot + text
    ///   Start Time      — DatePicker + HH:mm TextBox + Random button + Connect/Disconnect
    ///   Current Time    — live display of Playback.CurrentTime
    ///   Transport       — Play / Pause + 6 speed buttons (1x–32x)
    ///   Step Forward    — timeframe ComboBox + Next Bar button
    ///
    /// Bar-stepping mechanism:
    ///   On "Next Bar", set speed=32, record _stepTarget (next bar close snap), call Play().
    ///   DispatcherTimer polls CurrentTime; when >= _stepTarget it calls Pause() and
    ///   restores the pre-step speed.
    /// </summary>
    public class ReplayControllerWindow : NTWindow, IWorkspacePersistence
    {
        // ─── Workspace Persistence ────────────────────────────────────────────
        // Required by IWorkspacePersistence — set by ReplayController.OnWindowCreated
        public WorkspaceOptions WorkspaceOptions { get; set; }

        // ─── Reflection: Playback API ─────────────────────────────────────────
        // NT8 exposes two separate types for playback control:
        //   PlaybackAdapter       — adapter layer (Connect/Disconnect, IsAvailable, FromEst, NowEst, PlaybackSpeed)
        //   PlaybackControlCenter — WPF window (Play(), Pause(), SetPlaybackSpeed())
        // Both are instance-based; we locate live instances at call time via helper methods.
        private Type _playbackType;  // PlaybackAdapter — adapter operations
        private Type _pccType;       // PlaybackControlCenter — UI/transport operations
        private bool _apiResolved;   // true when BOTH types are resolved

        // ─── UI Controls ──────────────────────────────────────────────────────
        private Ellipse   _statusDot;       // green=connected, yellow=connecting, grey=disconnected
        private TextBlock _statusLabel;     // "Connected" / "Connecting…" / "Disconnected" / error text

        private DatePicker _datePicker;     // WPF native date picker for replay start date
        private TextBox    _timeBox;        // HH:mm free-text for the start time component

        private Button _connectButton;
        private Button _disconnectButton;

        private TextBlock _currentTimeLabel; // Shows Playback.CurrentTime while connected

        private Button   _playButton;
        private Button   _pauseButton;
        private Button[] _speedButtons;     // [0]=1x, [1]=2x, [2]=4x, [3]=8x, [4]=16x, [5]=32x
        private int      _currentSpeedIndex = 0; // index into _speedValues

        private ComboBox _timeframeCombo;   // 1m / 5m / 15m / 1h / Daily
        private Button   _stepButton;

        // ─── Speed Values ─────────────────────────────────────────────────────
        // Maps button index → actual Playback.Speed value
        private static readonly int[] _speedValues = { 1, 2, 4, 8, 16, 32 };

        // ─── Polling Timer ────────────────────────────────────────────────────
        // Fires on the GUI thread every 500 ms to update status and detect step completion
        private DispatcherTimer _pollTimer;

        // ─── Step-Forward State ───────────────────────────────────────────────
        // Set while a bar-step is in progress
        private bool     _isStepping;
        private DateTime _stepTarget;        // time at which we should Pause
        private int      _preStepSpeedIndex; // speed to restore after step completes
        private bool     _isManuallyPlaying; // tracks last explicit Play()/Pause() call — used by PlaybackIsPaused()

        // ─── Connection State Cache ───────────────────────────────────────────
        // Cached last-known connected state to detect transitions
        private bool _wasConnected;

        // ─── Diagnostic Flag ──────────────────────────────────────────────────
        // Ensures the "Playback type not found" candidate dump is only logged once
        private bool _diagnosticLogged;

        // ─── Connect Timeout ──────────────────────────────────────────────────
        // Records when Connect was last clicked; used to detect stalled connections.
        private DateTime _connectingStartTime = DateTime.MinValue;
        private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(15);

        // ─── Random Number Generator ──────────────────────────────────────────
        private readonly Random _rng = new Random();

        // ─── Timeframe Interval Map ───────────────────────────────────────────
        // Maps ComboBox index → TimeSpan for bar-step calculations
        private static readonly TimeSpan[] _tfIntervals =
        {
            TimeSpan.FromMinutes(1),
            TimeSpan.FromMinutes(5),
            TimeSpan.FromMinutes(15),
            TimeSpan.FromHours(1),
            TimeSpan.FromDays(1)
        };

        // ─── Constructor ──────────────────────────────────────────────────────

        /// <summary>
        /// Creates the window, resolves the Playback API via reflection, builds
        /// all UI elements, and starts the 500 ms polling timer.
        /// </summary>
        public ReplayControllerWindow()
        {
            Caption = "Replay Controller";
            Width   = 320;
            Height  = 420;

            // ── Resolve NinjaTrader.Cbi.Playback via reflection ──────────────
            // NT8 loads assemblies lazily, so the type may not be present yet.
            // TryResolvePlaybackType() will be retried every 500 ms from the poll
            // timer until it succeeds.
            TryResolvePlaybackType();

            // ── Build UI ─────────────────────────────────────────────────────
            BuildUI();

            // ── Start polling timer ──────────────────────────────────────────
            // DispatcherTimer fires on the GUI thread — no marshalling needed
            _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
            _pollTimer.Tick += OnPollTick;
            _pollTimer.Start();

            // Initial UI state
            UpdateControlStates(connected: false, paused: true);
        }

        // ─── UI Construction ──────────────────────────────────────────────────

        /// <summary>
        /// Builds the entire window UI programmatically (no XAML).
        /// Layout: top-down StackPanel with labeled sections.
        /// </summary>
        private void BuildUI()
        {
            // Shared style helpers
            var headerStyle = new Style(typeof(TextBlock));
            headerStyle.Setters.Add(new Setter(TextBlock.FontWeightProperty, FontWeights.SemiBold));
            headerStyle.Setters.Add(new Setter(TextBlock.MarginProperty, new Thickness(0, 8, 0, 4)));
            headerStyle.Setters.Add(new Setter(TextBlock.ForegroundProperty, new SolidColorBrush(Color.FromRgb(180, 180, 180))));

            // Root scroll container so the panel never clips on small monitors
            var scroll = new ScrollViewer
            {
                VerticalScrollBarVisibility   = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Margin = new Thickness(8)
            };

            var root = new StackPanel { Orientation = Orientation.Vertical };
            scroll.Content = root;

            // ── Status bar ───────────────────────────────────────────────────
            var statusRow = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin      = new Thickness(0, 4, 0, 4)
            };

            _statusDot = new Ellipse
            {
                Width  = 10,
                Height = 10,
                Fill   = Brushes.Gray,
                Margin = new Thickness(0, 2, 6, 0),
                VerticalAlignment = VerticalAlignment.Center
            };

            _statusLabel = new TextBlock
            {
                Text = "Disconnected",
                VerticalAlignment = VerticalAlignment.Center
            };

            statusRow.Children.Add(_statusDot);
            statusRow.Children.Add(_statusLabel);
            root.Children.Add(statusRow);

            // ── Section: Start Time ──────────────────────────────────────────
            root.Children.Add(MakeSectionHeader("Start Time"));

            // Date + Time row
            var dateTimeRow = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin      = new Thickness(0, 0, 0, 4)
            };

            _datePicker = new DatePicker
            {
                Width               = 140,
                Margin              = new Thickness(0, 0, 6, 0),
                SelectedDate        = DateTime.Today,
                VerticalAlignment   = VerticalAlignment.Center
            };

            _timeBox = new TextBox
            {
                Text              = "09:30",
                Width             = 55,
                Margin            = new Thickness(0, 0, 6, 0),
                VerticalAlignment = VerticalAlignment.Center,
                ToolTip           = "HH:mm (24-hour)"
            };
            // Validate time format when user leaves the field
            _timeBox.LostFocus += OnTimeBoxLostFocus;

            var randomBtn = new Button
            {
                Content           = "🎲 Random",
                Width             = 80,
                VerticalAlignment = VerticalAlignment.Center,
                ToolTip           = "Pick a random weekday replay time (2yr window)"
            };
            randomBtn.Click += OnRandomClick;

            dateTimeRow.Children.Add(_datePicker);
            dateTimeRow.Children.Add(_timeBox);
            dateTimeRow.Children.Add(randomBtn);
            root.Children.Add(dateTimeRow);

            // Connect / Disconnect row
            var connectRow = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin      = new Thickness(0, 0, 0, 4)
            };

            _connectButton = new Button
            {
                Content = "Connect",
                Width   = 100,
                Margin  = new Thickness(0, 0, 8, 0)
            };
            _connectButton.Click += OnConnectClick;

            _disconnectButton = new Button
            {
                Content    = "Disconnect",
                Width      = 100,
                IsEnabled  = false
            };
            _disconnectButton.Click += OnDisconnectClick;

            connectRow.Children.Add(_connectButton);
            connectRow.Children.Add(_disconnectButton);
            root.Children.Add(connectRow);

            // ── Section: Current Time ────────────────────────────────────────
            root.Children.Add(MakeSectionHeader("Current Time"));

            _currentTimeLabel = new TextBlock
            {
                Text   = "—",
                Margin = new Thickness(0, 0, 0, 4)
            };
            root.Children.Add(_currentTimeLabel);

            // ── Section: Transport ───────────────────────────────────────────
            root.Children.Add(MakeSectionHeader("Transport"));

            var transportRow = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin      = new Thickness(0, 0, 0, 4)
            };

            _playButton = new Button
            {
                Content   = "▶ Play",
                Width     = 80,
                Margin    = new Thickness(0, 0, 8, 0),
                IsEnabled = false
            };
            _playButton.Click += OnPlayClick;

            _pauseButton = new Button
            {
                Content   = "⏸ Pause",
                Width     = 80,
                IsEnabled = false
            };
            _pauseButton.Click += OnPauseClick;

            transportRow.Children.Add(_playButton);
            transportRow.Children.Add(_pauseButton);
            root.Children.Add(transportRow);

            // Speed buttons: 1x 2x 4x 8x 16x 32x
            var speedLabels = new[] { "1x", "2x", "4x", "8x", "16x", "32x" };
            _speedButtons = new Button[speedLabels.Length];

            var speedWrap = new WrapPanel
            {
                Orientation = Orientation.Horizontal,
                Margin      = new Thickness(0, 0, 0, 4)
            };

            for (int i = 0; i < speedLabels.Length; i++)
            {
                int index = i; // capture for closure
                var btn = new Button
                {
                    Content   = speedLabels[i],
                    Width     = 38,
                    Height    = 24,
                    Margin    = new Thickness(0, 0, 4, 4),
                    IsEnabled = false,
                    Tag       = index
                };
                btn.Click += (s, e) => OnSpeedClick(index);
                _speedButtons[i] = btn;
                speedWrap.Children.Add(btn);
            }
            root.Children.Add(speedWrap);

            // ── Section: Step Forward ────────────────────────────────────────
            root.Children.Add(MakeSectionHeader("Step Forward"));

            var stepRow = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin      = new Thickness(0, 0, 0, 8)
            };

            _timeframeCombo = new ComboBox
            {
                Width  = 70,
                Margin = new Thickness(0, 0, 8, 0)
            };
            foreach (var tf in new[] { "1m", "5m", "15m", "1h", "Daily" })
                _timeframeCombo.Items.Add(tf);
            _timeframeCombo.SelectedIndex = 0;

            _stepButton = new Button
            {
                Content   = "⏭ Next Bar",
                Width     = 90,
                IsEnabled = false,
                ToolTip   = "Advance one bar at max speed, then pause"
            };
            _stepButton.Click += OnStepClick;

            stepRow.Children.Add(_timeframeCombo);
            stepRow.Children.Add(_stepButton);
            root.Children.Add(stepRow);

            // Set the window content
            Content = scroll;
        }

        /// <summary>Creates a styled section header TextBlock.</summary>
        private TextBlock MakeSectionHeader(string text)
        {
            return new TextBlock
            {
                Text       = text,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Color.FromRgb(140, 180, 220)),
                Margin     = new Thickness(0, 8, 0, 4)
            };
        }

        // ─── Polling Timer ────────────────────────────────────────────────────

        /// <summary>
        /// Fires every 500 ms on the GUI thread. Updates status indicators, current time
        /// display, button states, and detects bar-step completion.
        /// Also retries Playback type resolution on each tick until it succeeds
        /// (handles NT8's lazy assembly loading).
        /// </summary>
        private void OnPollTick(object sender, EventArgs e)
        {
            // Retry type resolution on every tick until the assembly is loaded
            if (!_apiResolved)
            {
                if (TryResolvePlaybackType())
                {
                    // Type just became available — update the status display
                    _statusLabel.Text = "Disconnected";
                    _statusDot.Fill   = Brushes.Gray;
                }
                else
                    return; // still not found, nothing else to do
            }

            bool connected = PlaybackIsConnected();
            bool paused    = PlaybackIsPaused();

            // ── Update status dot and label ───────────────────────────────────
            if (connected)
            {
                _statusDot.Fill   = new SolidColorBrush(Color.FromRgb(80, 200, 80));
                _statusLabel.Text = "Connected";

                // Show current replay time
                DateTime current = PlaybackCurrentTime();
                _currentTimeLabel.Text = current == DateTime.MinValue
                    ? "—"
                    : current.ToString("yyyy-MM-dd  HH:mm:ss");

                // ── Detect step-forward completion ────────────────────────────
                if (_isStepping && current >= _stepTarget)
                {
                    _isStepping = false;
                    PlaybackPause();
                    SetPlaybackSpeed(_speedValues[_preStepSpeedIndex]);
                    _currentSpeedIndex = _preStepSpeedIndex;
                    UpdateSpeedButtonHighlight();
                    Log("ReplayController: Step complete — paused at " + current.ToString("HH:mm:ss"));
                }
            }
            else if (_statusLabel.Text == "Connecting…")
            {
                // Still waiting — check for timeout (15 s) to prevent permanent stuck state
                if (DateTime.Now - _connectingStartTime > ConnectTimeout)
                {
                    _statusDot.Fill       = Brushes.OrangeRed;
                    _statusLabel.Text     = "Connect timed out — retry";
                    _datePicker.IsEnabled = true;
                    _timeBox.IsEnabled    = true;
                    _connectingStartTime  = DateTime.MinValue;
                    Log("ReplayController: Connect timed out after 15 s. IsConnected never became true.");
                }
                else
                {
                    _statusDot.Fill = Brushes.Yellow;
                }
            }
            else
            {
                _statusDot.Fill   = Brushes.Gray;
                _statusLabel.Text = "Disconnected";
                _currentTimeLabel.Text = "—";
            }

            // ── Detect reconnect/disconnect transitions ────────────────────────
            if (!connected && _wasConnected)
            {
                // Just disconnected — re-enable date/time inputs
                _datePicker.IsEnabled = true;
                _timeBox.IsEnabled    = true;
                _isStepping           = false;
            }
            _wasConnected = connected;

            // ── Enable/disable controls based on state ────────────────────────
            UpdateControlStates(connected, paused);
        }

        /// <summary>
        /// Updates all button enabled/disabled states based on connection and playback state.
        /// Called from poll tick and on initial construction.
        /// </summary>
        private void UpdateControlStates(bool connected, bool paused)
        {
            _connectButton.IsEnabled    = !connected;
            _disconnectButton.IsEnabled = connected;

            bool canPlay  = connected && paused  && !_isStepping;
            bool canPause = connected && !paused && !_isStepping;
            bool canStep  = connected && paused  && !_isStepping;

            _playButton.IsEnabled  = canPlay;
            _pauseButton.IsEnabled = canPause;
            _stepButton.IsEnabled  = canStep;

            foreach (var btn in _speedButtons)
                btn.IsEnabled = connected && !_isStepping;
        }

        // ─── Event Handlers ───────────────────────────────────────────────────

        /// <summary>
        /// Validates the time TextBox on focus-leave. Shows red border on bad input.
        /// </summary>
        private void OnTimeBoxLostFocus(object sender, RoutedEventArgs e)
        {
            TimeSpan dummy;
            bool valid = TryParseTime(_timeBox.Text, out dummy);
            _timeBox.BorderBrush = valid
                ? SystemColors.ControlDarkBrush
                : Brushes.OrangeRed;
        }

        /// <summary>
        /// Populates DatePicker + TimeBox with a random past weekday market open time.
        /// Range: 2 years ago through 5 days ago. Time: 09:30 + 0–300 random minutes.
        /// </summary>
        private void OnRandomClick(object sender, RoutedEventArgs e)
        {
            DateTime randomTime = GenerateRandomTradeTime();
            _datePicker.SelectedDate = randomTime.Date;
            _timeBox.Text = randomTime.ToString("HH:mm");
            _timeBox.BorderBrush = SystemColors.ControlDarkBrush;
        }

        /// <summary>
        /// Validates inputs, sets Playback.ReplayFromTime BEFORE connecting (so NT8
        /// loads from the correct time), then connects the Playback connection.
        ///
        /// Connect flow:
        ///   1. Validate date selected + time parses + combined DateTime is in the past
        ///   2. SetPlaybackReplayFromTime(combinedDateTime)
        ///   3. PlaybackConnect() via reflection wrapper
        ///   4. Disable date/time inputs (can't change while connected)
        ///   5. Status → "Connecting…"
        /// </summary>
        private void OnConnectClick(object sender, RoutedEventArgs e)
        {
            // ── 0. Last-chance retry for Playback type ────────────────────────
            TryResolvePlaybackType();
            if (!_apiResolved)
            {
                _statusLabel.Text = "Playback API not available — open Market Replay from NT8 first";
                _statusDot.Fill   = Brushes.OrangeRed;
                return;
            }

            // ── 1. Validate inputs ────────────────────────────────────────────
            if (_datePicker.SelectedDate == null)
            {
                _statusLabel.Text = "Please select a date";
                _statusDot.Fill   = Brushes.OrangeRed;
                return;
            }

            TimeSpan timePart;
            if (!TryParseTime(_timeBox.Text, out timePart))
            {
                _statusLabel.Text = "Invalid time — use HH:mm";
                _statusDot.Fill   = Brushes.OrangeRed;
                _timeBox.BorderBrush = Brushes.OrangeRed;
                return;
            }

            DateTime combinedDt = _datePicker.SelectedDate.Value.Date + timePart;
            if (combinedDt >= DateTime.Now)
            {
                _statusLabel.Text = "Date/time must be in the past";
                _statusDot.Fill   = Brushes.OrangeRed;
                return;
            }

            // ── 2. Set replay start time BEFORE connecting ────────────────────
            // Setting ReplayFromTime before Connect() ensures NT8 loads data from
            // the correct time instead of the last-used time.
            SetPlaybackReplayFromTime(combinedDt);

            // ── 3. Connect via reflection wrapper ────────────────────────────
            // Errors are caught inside; if Playback isn't available the status
            // dot will remain yellow/grey and the poll timer will reflect it.
            PlaybackConnect();

            // ── 4. Disable date/time inputs while connected ───────────────────
            _datePicker.IsEnabled = false;
            _timeBox.IsEnabled    = false;

            // ── 5. Status: connecting ─────────────────────────────────────────
            _statusDot.Fill       = Brushes.Yellow;
            _statusLabel.Text     = "Connecting…";
            _connectingStartTime  = DateTime.Now;
        }

        /// <summary>
        /// Disconnects the Playback connection and resets step state.
        /// Date/time inputs are re-enabled by the poll timer on the next disconnect transition.
        /// </summary>
        private void OnDisconnectClick(object sender, RoutedEventArgs e)
        {
            // Clear step flag BEFORE disconnecting so the step completion check
            // in OnPollTick doesn't fire spuriously on the disconnect transition
            _isStepping = false;

            PlaybackDisconnect();

            _statusDot.Fill   = Brushes.Gray;
            _statusLabel.Text = "Disconnected";
            _currentTimeLabel.Text = "—";
        }

        /// <summary>Calls Playback.Play() via reflection.</summary>
        private void OnPlayClick(object sender, RoutedEventArgs e)
        {
            PlaybackPlay();
        }

        /// <summary>Calls Playback.Pause() via reflection.</summary>
        private void OnPauseClick(object sender, RoutedEventArgs e)
        {
            PlaybackPause();
        }

        /// <summary>
        /// Sets playback speed to the selected value and highlights the active button.
        /// </summary>
        private void OnSpeedClick(int index)
        {
            _currentSpeedIndex = index;
            SetPlaybackSpeed(_speedValues[index]);
            UpdateSpeedButtonHighlight();
        }

        /// <summary>
        /// Advances one bar at maximum speed, then auto-pauses.
        ///
        /// Mechanism:
        ///   1. Save current speed (to restore after step)
        ///   2. Calculate _stepTarget as the next bar's close time
        ///   3. Set speed = 32 (max)
        ///   4. Call Play()
        ///   OnPollTick() detects CurrentTime >= _stepTarget → Pause + restore speed
        /// </summary>
        private void OnStepClick(object sender, RoutedEventArgs e)
        {
            // Guard: must be connected, paused, and not already stepping
            if (!PlaybackIsConnected() || !PlaybackIsPaused() || _isStepping)
                return;

            DateTime current  = PlaybackCurrentTime();
            TimeSpan interval = _tfIntervals[_timeframeCombo.SelectedIndex];

            _stepTarget        = SnapToNextBarClose(current, interval);
            _preStepSpeedIndex = _currentSpeedIndex;
            _isStepping        = true;

            SetPlaybackSpeed(32);
            PlaybackPlay();

            Log(string.Format("ReplayController: Stepping from {0} to {1}",
                current.ToString("HH:mm:ss"), _stepTarget.ToString("HH:mm:ss")));
        }

        // ─── Playback API Reflection Wrappers ─────────────────────────────────
        // All methods catch exceptions and return safe defaults on failure.
        // This ensures any NT8 version changes or API surface shifts don't crash the AddOn.

        /// <summary>
        /// Attempts to resolve both NT8 playback types from all currently-loaded assemblies.
        /// NT8 loads assemblies lazily, so the first call (in the constructor) may fail while
        /// subsequent calls (from the poll timer) succeed once the assemblies are loaded.
        ///
        /// Requires BOTH types to be found before setting _apiResolved:
        ///   PlaybackAdapter       — NinjaTrader.Core — adapter operations
        ///   PlaybackControlCenter — NinjaTrader.Gui  — UI/transport operations
        ///
        /// Returns true if types were newly resolved (first combined success).
        /// </summary>
        private bool TryResolvePlaybackType()
        {
            if (_apiResolved) return false; // already found, nothing to do

            // Two separate types needed:
            //   PlaybackAdapter        — Connect/Disconnect, IsAvailable, FromEst, NowEst, PlaybackSpeed
            //   PlaybackControlCenter  — Play(), Pause(), SetPlaybackSpeed()
            // Both are instance-based; we find instances at call time via helper methods.
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (_playbackType == null)
                        _playbackType = asm.GetType("NinjaTrader.Adapter.PlaybackAdapter");
                    if (_pccType == null)
                        _pccType = asm.GetType("NinjaTrader.Gui.Data.PlaybackControlCenter");
                }
                catch { }
            }

            if (_playbackType != null && _pccType != null)
            {
                _apiResolved = true;
                Log("ReplayController: API resolved — PlaybackAdapter + PlaybackControlCenter");
                return true;
            }

            // Still missing — log once for diagnosis
            if (!_diagnosticLogged)
            {
                _diagnosticLogged = true;
                Log("ReplayController: Waiting for types — "
                    + (_playbackType == null ? "PlaybackAdapter missing" : "PlaybackAdapter OK") + ", "
                    + (_pccType      == null ? "PlaybackControlCenter missing" : "PlaybackControlCenter OK"));
            }
            return false;
        }

        /// <summary>
        /// Finds the live PlaybackControlCenter WPF window by iterating Application.Current.Windows.
        /// Returns null if the window is not open (user hasn't opened Market Replay panel).
        /// </summary>
        private object GetPlaybackControlCenter()
        {
            if (_pccType == null) return null;
            try
            {
                foreach (System.Windows.Window w in System.Windows.Application.Current.Windows)
                    if (w.GetType() == _pccType) return w;
            }
            catch { }
            return null;
        }

        /// <summary>
        /// Finds the PlaybackAdapter instance by scanning the PlaybackControlCenter window's
        /// private fields for a value whose runtime type IS PlaybackAdapter.
        /// This avoids depending on obfuscated field names — the adapter is always present
        /// as a field on the window, regardless of what NT8 named it internally.
        /// Returns null if window is not open or adapter field not found.
        /// </summary>
        private object GetPlaybackAdapter()
        {
            if (_playbackType == null) return null;
            object pcc = GetPlaybackControlCenter();
            if (pcc == null)
            {
                Log("ReplayController: GetPlaybackAdapter — PlaybackControlCenter window not found (open Market Replay first)");
                return null;
            }
            try
            {
                // Walk the full inheritance chain to catch fields in base classes too
                Type t = pcc.GetType();
                while (t != null && t != typeof(object))
                {
                    foreach (var fi in t.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public))
                    {
                        try
                        {
                            object val = fi.GetValue(pcc);
                            if (val != null && _playbackType.IsAssignableFrom(val.GetType()))
                                return val;
                        }
                        catch { }
                    }
                    t = t.BaseType;
                }
            }
            catch { }
            Log("ReplayController: GetPlaybackAdapter — no PlaybackAdapter field found on PlaybackControlCenter");
            return null;
        }

        /// <summary>
        /// Returns true when the PlaybackAdapter is available (connected/active).
        /// Uses the instance IsAvailable property rather than the old static IsConnected.
        /// </summary>
        private bool PlaybackIsConnected()
        {
            object adapter = GetPlaybackAdapter();
            if (adapter == null) return false;
            try
            {
                var prop = _playbackType.GetProperty("IsAvailable",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                return prop != null && (bool)prop.GetValue(adapter);
            }
            catch { return false; }
        }

        /// <summary>
        /// Returns the current replay time via PlaybackAdapter.NowEst (instance property).
        /// Returns DateTime.MinValue if the adapter is unavailable.
        /// </summary>
        private DateTime PlaybackCurrentTime()
        {
            object adapter = GetPlaybackAdapter();
            if (adapter == null) return DateTime.MinValue;
            try
            {
                var prop = _playbackType.GetProperty("NowEst",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                return prop != null ? (DateTime)prop.GetValue(adapter) : DateTime.MinValue;
            }
            catch { return DateTime.MinValue; }
        }

        /// <summary>
        /// Returns whether playback is currently paused.
        /// No direct IsPaused equivalent exists on PlaybackAdapter or PlaybackControlCenter,
        /// so we track it ourselves: PlaybackPlay() sets _isManuallyPlaying=true,
        /// PlaybackPause() sets it false. Default is true (paused — safe default).
        /// </summary>
        private bool PlaybackIsPaused() => !_isManuallyPlaying;

        /// <summary>
        /// Sets PlaybackAdapter.FromEst to the given DateTime.
        /// Call this BEFORE Connect() so NT8 loads data from the correct time.
        /// Maps to the old ReplayFromTime concept — FromEst is the confirmed instance property name.
        /// </summary>
        private void SetPlaybackReplayFromTime(DateTime dt)
        {
            object adapter = GetPlaybackAdapter();
            if (adapter == null) return;
            try
            {
                var prop = _playbackType.GetProperty("FromEst",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                prop?.SetValue(adapter, dt);
            }
            catch (Exception ex) { Log("ReplayController: SetPlaybackReplayFromTime error — " + ex.Message); }
        }

        /// <summary>
        /// Sets PlaybackAdapter.PlaybackSpeed to the given integer value (e.g. 1, 2, 4, 8, 16, 32).
        /// Maps to the old static Speed property — PlaybackSpeed is the confirmed instance property name.
        /// </summary>
        private void SetPlaybackSpeed(int speed)
        {
            object adapter = GetPlaybackAdapter();
            if (adapter == null) return;
            try
            {
                var prop = _playbackType.GetProperty("PlaybackSpeed",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                prop?.SetValue(adapter, speed);
            }
            catch (Exception ex) { Log("ReplayController: SetPlaybackSpeed error — " + ex.Message); }
        }

        /// <summary>
        /// Calls PlaybackControlCenter.Play() instance method and sets _isManuallyPlaying=true.
        /// The PCC window must be open; if not, logs a message and returns.
        /// </summary>
        private void PlaybackPlay()
        {
            object pcc = GetPlaybackControlCenter();
            if (pcc == null) { Log("ReplayController: PlaybackPlay — PCC window not found"); return; }
            try
            {
                var method = _pccType.GetMethod("Play",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, Type.EmptyTypes, null);
                method?.Invoke(pcc, null);
                _isManuallyPlaying = true;
            }
            catch (Exception ex) { Log("ReplayController: PlaybackPlay error — " + ex.Message); }
        }

        /// <summary>
        /// Calls PlaybackControlCenter.Pause() instance method and sets _isManuallyPlaying=false.
        /// The PCC window must be open; if not, logs a message and returns.
        /// </summary>
        private void PlaybackPause()
        {
            object pcc = GetPlaybackControlCenter();
            if (pcc == null) { Log("ReplayController: PlaybackPause — PCC window not found"); return; }
            try
            {
                var method = _pccType.GetMethod("Pause",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, Type.EmptyTypes, null);
                method?.Invoke(pcc, null);
                _isManuallyPlaying = false;
            }
            catch (Exception ex) { Log("ReplayController: PlaybackPause error — " + ex.Message); }
        }

        /// <summary>
        /// Calls PlaybackAdapter.Connect() instance method.
        /// Tries the no-arg overload first; falls back to the first available Connect overload
        /// to handle potential API variations across NT8 versions.
        /// </summary>
        private void PlaybackConnect()
        {
            object adapter = GetPlaybackAdapter();
            if (adapter == null) { Log("ReplayController: PlaybackConnect — adapter not found (open Market Replay panel first)"); return; }
            try
            {
                // Try no-arg Connect() first; if that overload doesn't exist, find any Connect method
                var method = _playbackType.GetMethod("Connect",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, Type.EmptyTypes, null)
                    ?? _playbackType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                                    .FirstOrDefault(m => m.Name == "Connect");
                method?.Invoke(adapter, method.GetParameters().Length == 0 ? null : new object[method.GetParameters().Length]);
            }
            catch (Exception ex) { Log("ReplayController: PlaybackConnect error — " + ex.Message); }
        }

        /// <summary>
        /// Calls PlaybackAdapter.Disconnect() instance method and clears _isManuallyPlaying.
        /// </summary>
        private void PlaybackDisconnect()
        {
            object adapter = GetPlaybackAdapter();
            if (adapter == null) return;
            try
            {
                var method = _playbackType.GetMethod("Disconnect",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, Type.EmptyTypes, null);
                method?.Invoke(adapter, null);
                _isManuallyPlaying = false;
            }
            catch (Exception ex) { Log("ReplayController: PlaybackDisconnect error — " + ex.Message); }
        }

        // ─── Calculation Helpers ──────────────────────────────────────────────

        /// <summary>
        /// Calculates the next bar close time by snapping current time forward to
        /// the next multiple of the given interval.
        ///
        /// Example: current=09:32, interval=5m → snap to 09:35 (next 5-min close)
        /// Uses integer tick math to avoid floating-point drift.
        /// </summary>
        private static DateTime SnapToNextBarClose(DateTime current, TimeSpan interval)
        {
            long ticks         = current.Ticks;
            long intervalTicks = interval.Ticks;
            // Integer division truncates to bar open; +1 gives next bar close
            return new DateTime(((ticks / intervalTicks) + 1) * intervalTicks);
        }

        /// <summary>
        /// Generates a random weekday market-hours DateTime in the last 2 years,
        /// excluding the last 5 days (to avoid potential data gaps near today).
        ///
        /// Time: 09:30 Eastern + 0–300 random minutes (up to ~14:30 Eastern)
        /// Days: skips Saturday and Sunday.
        /// </summary>
        private DateTime GenerateRandomTradeTime()
        {
            DateTime start    = DateTime.Now.AddYears(-2);
            DateTime end      = DateTime.Now.AddDays(-5);
            int totalDays     = Math.Max(1, (int)(end - start).TotalDays);

            DateTime date;
            do
            {
                date = start.AddDays(_rng.Next(totalDays));
            }
            while (date.DayOfWeek == DayOfWeek.Saturday || date.DayOfWeek == DayOfWeek.Sunday);

            int minuteOffset = _rng.Next(0, 300); // 0–5 hours after 09:30
            return date.Date.AddHours(9).AddMinutes(30 + minuteOffset);
        }

        /// <summary>
        /// Tries to parse a string as HH:mm. Returns true and sets result on success.
        /// Accepts both "9:30" and "09:30" formats.
        /// </summary>
        private static bool TryParseTime(string text, out TimeSpan result)
        {
            result = TimeSpan.Zero;
            if (string.IsNullOrWhiteSpace(text))
                return false;

            // Try HH:mm and H:mm
            string[] formats = { @"h\:mm", @"hh\:mm", @"H\:mm", @"HH\:mm" };
            foreach (string fmt in formats)
            {
                if (TimeSpan.TryParseExact(text.Trim(), fmt, null, out result))
                    return true;
            }
            return false;
        }

        /// <summary>
        /// Highlights the currently active speed button with a colored border.
        /// All other speed buttons get the default border.
        /// </summary>
        private void UpdateSpeedButtonHighlight()
        {
            for (int i = 0; i < _speedButtons.Length; i++)
            {
                _speedButtons[i].BorderBrush     = i == _currentSpeedIndex
                    ? new SolidColorBrush(Color.FromRgb(80, 180, 255))
                    : SystemColors.ControlDarkBrush;
                _speedButtons[i].BorderThickness = i == _currentSpeedIndex
                    ? new Thickness(2)
                    : new Thickness(1);
            }
        }

        // ─── Workspace Persistence (IWorkspacePersistence) ───────────────────
        // Saves/restores: timeframe ComboBox selection + last-entered time string.
        // The date picker is intentionally NOT persisted (ephemeral session-specific choice).

        /// <summary>
        /// Called by NT8 when saving a workspace. Writes timeframe index and time text
        /// as XML attributes on the workspace element for this window.
        /// </summary>
        public void Save(XDocument document, XElement element)
        {
            element.Add(new XAttribute("timeframeIndex", _timeframeCombo.SelectedIndex));
            element.Add(new XAttribute("timeText",       _timeBox.Text ?? "09:30"));
        }

        /// <summary>
        /// Called by NT8 when restoring a workspace. Reads XML attributes and applies
        /// them to controls. Null checks ensure compatibility with older workspace files.
        /// </summary>
        public void Restore(XDocument document, XElement element)
        {
            try
            {
                XAttribute tfAttr = element.Attribute("timeframeIndex");
                if (tfAttr != null && int.TryParse(tfAttr.Value, out int tfIdx)
                    && tfIdx >= 0 && tfIdx < _timeframeCombo.Items.Count)
                {
                    _timeframeCombo.SelectedIndex = tfIdx;
                }

                XAttribute timeAttr = element.Attribute("timeText");
                if (timeAttr != null && !string.IsNullOrEmpty(timeAttr.Value))
                {
                    _timeBox.Text = timeAttr.Value;
                }
            }
            catch (Exception ex)
            {
                Log("ReplayController: Error restoring workspace — " + ex.Message);
            }
        }

        // ─── Cleanup ──────────────────────────────────────────────────────────

        /// <summary>
        /// Stops the polling timer when the window closes to prevent timer callbacks
        /// on a disposed window. Called by NTWindow's built-in closing logic.
        /// </summary>
        protected override void OnClosed(EventArgs e)
        {
            _pollTimer?.Stop();
            _pollTimer = null;
            base.OnClosed(e);
        }

        // ─── Utility ──────────────────────────────────────────────────────────

        /// <summary>Writes a message to NT8's Output tab for debugging.</summary>
        private static void Log(string message)
        {
            NinjaTrader.Code.Output.Process(message, NinjaTrader.NinjaScript.PrintTo.OutputTab1);
        }
    }
}
