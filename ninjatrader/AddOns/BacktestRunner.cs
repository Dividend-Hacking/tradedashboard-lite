#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Reflection;
using System.Threading.Tasks;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// BacktestRunner — NinjaTrader 8 AddOn that automates Strategy Analyzer backtests
    /// from a Mac-side CLI without requiring manual UI interaction.
    ///
    /// Architecture (shared-folder message bus):
    ///   Mac writes backtest_request.json  →  {UserDataDir}\incoming\
    ///   NT8 reads request, runs backtest, writes result JSON  →  {UserDataDir}\outgoing\
    ///   Mac polls for result, saves locally, uploads to Supabase
    ///
    /// The incoming/outgoing folders are the Parallels Documents mirror, so both Mac and
    /// Windows VM see the same files without any network/SMB configuration.
    ///
    /// Lifecycle:
    ///   1. Active: create directories, start FileSystemWatcher + 30s fallback timer
    ///   2. Request arrives: parse JSON, launch Strategy Analyzer on GUI thread
    ///   3. Backtest completes: extract SystemPerformance, write result JSON to outgoing
    ///   4. Mac CLI detects result file, uploads to Supabase, cleans up
    ///
    /// Request JSON schema (written by Mac backtest.sh):
    /// {
    ///   "run_id":            "NQBuyAndHold_NQ-03-26_2025-01-01_2025-03-01_1710000000",
    ///   "strategy":          "NQBuyAndHold",
    ///   "instrument":        "NQ 03-26",
    ///   "timeframe_minutes": 5,
    ///   "from_date":         "2025-01-01",
    ///   "to_date":           "2025-03-01",
    ///   "account":           "Sim101"
    /// }
    ///
    /// Result JSON is written to: {UserDataDir}\outgoing\backtest_result_{run_id}.json
    /// </summary>
    public class BacktestRunner : AddOnBase
    {
        // ─── Constants ───────────────────────────────────────────────────────────

        /// <summary>Name of the incoming request file (fixed — only one backtest at a time)</summary>
        private const string REQUEST_FILENAME = "backtest_request.json";

        /// <summary>Prefix for result files in the outgoing directory</summary>
        private const string RESULT_PREFIX = "backtest_result_";

        /// <summary>Max minutes to wait for a backtest to complete before timing out</summary>
        private const int BACKTEST_TIMEOUT_MINUTES = 30;

        /// <summary>Polling interval (ms) for checking if backtest is still running</summary>
        private const int POLL_INTERVAL_MS = 2000;

        // ─── State ───────────────────────────────────────────────────────────────

        /// <summary>FileSystemWatcher monitoring the incoming directory for request files</summary>
        private FileSystemWatcher _watcher;

        /// <summary>Fallback polling timer — FileSystemWatcher can miss events under load</summary>
        private Timer _pollTimer;

        /// <summary>Lock to prevent concurrent backtest executions</summary>
        private readonly object _stateLock = new object();

        /// <summary>True while a backtest is in progress — prevents re-entrant runs</summary>
        private bool _isRunning;

        /// <summary>Absolute path to the incoming request directory (on Windows FS)</summary>
        private string _incomingDir;

        /// <summary>Absolute path to the outgoing result directory (on Windows FS)</summary>
        private string _outgoingDir;

        // ─── AddOnBase Lifecycle ─────────────────────────────────────────────────

        /// <summary>
        /// NinjaTrader lifecycle state machine entry point.
        /// SetDefaults: register name/description shown in NT8 AddOn Manager.
        /// Active: start watching for requests.
        /// Terminated: clean up all resources.
        /// </summary>
        protected override void OnStateChange()
        {
            switch (State)
            {
                case State.SetDefaults:
                    Name        = "BacktestRunner";
                    Description = "Automated backtest agent — watches for JSON requests and runs Strategy Analyzer, writing results to a shared folder for Mac CLI collection";
                    break;

                case State.Active:
                    InitializeDirectories();
                    StartFileWatcher();
                    StartFallbackPoller();

                    // Check immediately in case a request was dropped while NT8 was restarting
                    ProcessRequestIfPresent();

                    Log("BacktestRunner: Active — watching for requests in:\n  " + _incomingDir);
                    break;

                case State.Terminated:
                    _watcher?.Dispose();
                    _pollTimer?.Dispose();
                    break;
            }
        }

        // ─── Initialization ──────────────────────────────────────────────────────

        /// <summary>
        /// Creates the incoming and outgoing directories under NinjaTrader's UserDataDir.
        /// UserDataDir resolves to C:\Users\{user}\Documents\NinjaTrader 8 on Windows,
        /// which Parallels mirrors to ~/Documents/NinjaTrader 8 on Mac.
        /// </summary>
        private void InitializeDirectories()
        {
            _incomingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "incoming");
            _outgoingDir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "outgoing");

            Directory.CreateDirectory(_incomingDir);
            Directory.CreateDirectory(_outgoingDir);
        }

        /// <summary>
        /// Creates a FileSystemWatcher on the incoming directory filtered to the request filename.
        /// Responds to both Created (new drop) and Changed (overwrite/touch) events so
        /// repeated runs with the same filename are always detected.
        /// </summary>
        private void StartFileWatcher()
        {
            _watcher = new FileSystemWatcher(_incomingDir, REQUEST_FILENAME)
            {
                NotifyFilter           = NotifyFilters.FileName | NotifyFilters.LastWrite,
                EnableRaisingEvents    = true
            };

            _watcher.Created += (s, e) => OnRequestDetected();
            _watcher.Changed += (s, e) => OnRequestDetected();
        }

        /// <summary>
        /// Starts a 30-second periodic timer as a fallback for missed FileSystemWatcher events.
        /// FSW can silently drop events on Windows when the file is written from a network
        /// mount (Parallels shared folder) — the timer ensures we never miss a request.
        /// </summary>
        private void StartFallbackPoller()
        {
            _pollTimer = new Timer(
                callback: _ => ProcessRequestIfPresent(),
                state:    null,
                dueTime:  TimeSpan.FromSeconds(30),
                period:   TimeSpan.FromSeconds(30));
        }

        // ─── Request Detection ───────────────────────────────────────────────────

        /// <summary>
        /// Called by the FileSystemWatcher when the request file appears or changes.
        /// Runs request processing on a background thread (FSW callbacks must return quickly).
        /// </summary>
        private void OnRequestDetected()
        {
            Task.Run(() => ProcessRequestIfPresent());
        }

        /// <summary>
        /// Checks if the request file exists and, if so, processes it.
        /// Lock-guarded to prevent concurrent runs if both FSW and poller fire simultaneously.
        /// </summary>
        private void ProcessRequestIfPresent()
        {
            string requestPath = Path.Combine(_incomingDir, REQUEST_FILENAME);
            if (!File.Exists(requestPath)) return;

            lock (_stateLock)
            {
                if (_isRunning)
                {
                    Log("BacktestRunner: Request received but a backtest is already running — ignoring");
                    return;
                }
                _isRunning = true;
            }

            // Process on a dedicated thread so we don't block the poller/FSW callback
            Task.Run(async () =>
            {
                try
                {
                    await HandleRequest(requestPath);
                }
                finally
                {
                    lock (_stateLock) _isRunning = false;
                }
            });
        }

        // ─── Request Processing ──────────────────────────────────────────────────

        /// <summary>
        /// Main handler: reads the request file, runs the backtest, writes the result.
        /// Supports two request types:
        ///   - "discover": scans loaded assemblies and dumps backend type info to NT8 Output tab
        ///   - normal backtest: runs Strategy Analyzer via ICommand, polls for result file
        ///
        /// Any exception at the top level is caught and written as an error result so
        /// the Mac CLI always gets a response (never hangs waiting for a file that won't come).
        /// </summary>
        private async Task HandleRequest(string requestPath)
        {
            BacktestRequest request = null;

            try
            {
                // Small delay to ensure the file is fully flushed before we read it
                await Task.Delay(500);

                string json = File.ReadAllText(requestPath);

                // ── Discover mode: scan assemblies and dump type info to Output tab ──
                // Triggered by {"type":"discover"} — no strategy/instrument fields needed.
                // This is Phase 1: we learn exact backend type names before implementing
                // the headless runner in Phase 2.
                string requestType = ExtractJsonString(json, "type");
                if (requestType == "discover")
                {
                    SafeDelete(requestPath);
                    Log("BacktestRunner: *** DISCOVER MODE — scanning NT8 backend types ***");
                    await Task.Run(() => RunDiscovery());
                    Log("BacktestRunner: *** DISCOVER COMPLETE — check Output tab ***");
                    // Write a marker file so --discover in backtest.sh knows we're done
                    WriteDiscoverResult();
                    return;
                }

                request = ParseRequest(json);

                if (request == null)
                {
                    Log("BacktestRunner: Failed to parse request JSON — malformed or missing fields");
                    WriteErrorResult("unknown", "Failed to parse request JSON");
                    return;
                }

                Log(string.Format("BacktestRunner: Starting backtest — {0} on {1} ({2}min) {3} → {4}",
                    request.Strategy, request.Instrument, request.TimeframeMinutes,
                    request.FromDate, request.ToDate));

                // Delete the request file before running so a stale file doesn't re-trigger
                // on the next NT8 restart. Do this AFTER parsing — we have all the data we need.
                SafeDelete(requestPath);

                // Run the backtest (dispatched to GUI thread internally)
                BacktestResult result = await RunStrategyAnalyzer(request);

                // Write result JSON to outgoing directory for Mac CLI to pick up
                WriteResultFile(result);

                Log(string.Format("BacktestRunner: Completed — {0} | Net P&L: ${1:F2} | Trades: {2} | Win%: {3:F1}",
                    request.RunId, result.NetProfitDollars, result.TotalTrades, result.WinRatePct));
            }
            catch (Exception ex)
            {
                Log("BacktestRunner: Error processing request — " + ex.Message + "\n" + ex.StackTrace);

                // Always write an error result so the Mac CLI gets a response instead of timing out
                string runId = request?.RunId ?? "unknown";
                WriteErrorResult(runId, ex.Message);
            }
        }

        // ─── Phase 1: Runtime Type Discovery ──────────────────────────────────────

        /// <summary>
        /// Scans ALL loaded assemblies looking for non-GUI backend types that could be
        /// used to run backtests headlessly. Results are printed to NT8's Output tab.
        ///
        /// What we're looking for (to replace the GUI-based ICommand approach):
        ///   - StrategyRunner: likely the direct backend that SA's ViewModel wraps
        ///   - StrategyAnalyzerTabProperties: may have a non-GUI Run() method
        ///   - Any type in NinjaTrader.NinjaScript / NinjaTrader.Cbi with Run/Start/Execute
        ///
        /// Phase 2 will use the exact type names and signatures discovered here to
        /// instantiate and invoke the runner directly without any WPF/Dispatcher involvement.
        /// </summary>
        private void RunDiscovery()
        {
            var sb = new StringBuilder();

            sb.AppendLine("=== BacktestRunner: Phase 1 Discovery ===");
            sb.AppendLine("Looking for non-GUI Strategy/Backtest/Runner types...");
            sb.AppendLine("");

            // ── Pass 1: Find ALL types matching name criteria, excluding GUI namespaces ──
            // We exclude anything in .Gui. or .Windows. since we want the backend only.
            var candidates = new List<Type>();
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException rtle) { types = rtle.Types; }

                if (types == null) continue;

                foreach (Type t in types)
                {
                    if (t == null) continue;
                    string ns   = t.Namespace ?? "";
                    string name = t.Name      ?? "";

                    // Skip GUI and WPF types — we only want backend engine types
                    if (ns.Contains(".Gui.")    || ns.EndsWith(".Gui"))    continue;
                    if (ns.Contains(".Windows.") || ns.EndsWith(".Windows")) continue;

                    // Include types whose name contains Strategy, Backtest, or Runner
                    bool nameMatch = name.Contains("Strategy")  ||
                                     name.Contains("Backtest")  ||
                                     name.Contains("Runner");
                    if (!nameMatch) continue;

                    candidates.Add(t);
                }
            }

            sb.AppendLine(string.Format("Found {0} candidate types (non-GUI, name contains Strategy/Backtest/Runner):", candidates.Count));
            sb.AppendLine("");

            foreach (Type t in candidates)
            {
                DumpType(sb, t, brief: true);
            }

            // ── Pass 2: Deep dump of high-value targets ──────────────────────────────
            // These are the types most likely to be the headless runner. We log every
            // constructor and method (public + private) so Phase 2 knows the exact call.
            string[] highValueNames = new[]
            {
                "StrategyRunner",
                "StrategyAnalyzerTabProperties",
                "StrategyAnalyzerEngine",
                "BacktestEngine",
                "BacktestRunner"
            };

            sb.AppendLine("");
            sb.AppendLine("=== Deep dump of high-value target types ===");

            foreach (string targetName in highValueNames)
            {
                bool found = false;
                foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Type[] types;
                    try { types = asm.GetTypes(); }
                    catch (ReflectionTypeLoadException rtle) { types = rtle.Types; }
                    if (types == null) continue;

                    foreach (Type t in types)
                    {
                        if (t == null || t.Name != targetName) continue;
                        DumpType(sb, t, brief: false);
                        found = true;
                    }
                }
                if (!found)
                    sb.AppendLine(string.Format("  [{0}] — NOT FOUND in any loaded assembly", targetName));
            }

            // ── Pass 3: All types in NinjaTrader.NinjaScript + NinjaTrader.Cbi with Run/Start/Execute ──
            // Even if we don't hit the exact target names above, any type with a
            // Run/Start/Execute method in these core namespaces is a candidate.
            sb.AppendLine("");
            sb.AppendLine("=== Types in NinjaTrader.NinjaScript / NinjaTrader.Cbi with Run/Start/Execute methods ===");

            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException rtle) { types = rtle.Types; }
                if (types == null) continue;

                foreach (Type t in types)
                {
                    if (t == null) continue;
                    string ns = t.Namespace ?? "";
                    if (!ns.StartsWith("NinjaTrader.NinjaScript") && !ns.StartsWith("NinjaTrader.Cbi")) continue;
                    if (ns.Contains(".Gui")) continue;

                    // Check if it has any Run/Start/Execute methods
                    MethodInfo[] methods;
                    try { methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static); }
                    catch { continue; }

                    bool hasRunMethod = false;
                    foreach (MethodInfo m in methods)
                    {
                        string mn = m.Name;
                        if (mn == "Run" || mn == "Start" || mn == "Execute" || mn == "RunBacktest" || mn == "StartBacktest")
                        {
                            hasRunMethod = true;
                            break;
                        }
                    }
                    if (!hasRunMethod) continue;

                    DumpType(sb, t, brief: false);
                }
            }

            // Output in chunks — NT8 Output tab has a line limit per Process() call
            string output = sb.ToString();
            int chunkSize = 4000;
            for (int i = 0; i < output.Length; i += chunkSize)
            {
                int len = Math.Min(chunkSize, output.Length - i);
                Log(output.Substring(i, len));
            }
        }

        /// <summary>
        /// Logs a type's full name, declaring assembly, constructors, and methods to a StringBuilder.
        /// brief=true: just the type name + namespace
        /// brief=false: full constructor + method signatures (public and private)
        /// </summary>
        private static void DumpType(StringBuilder sb, Type t, bool brief)
        {
            sb.AppendLine(string.Format("  TYPE: {0}", t.FullName));
            sb.AppendLine(string.Format("    Assembly: {0}", t.Assembly.GetName().Name));

            if (brief)
            {
                // For brief mode, also list method names to help identify runners
                MethodInfo[] methods;
                try { methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static); }
                catch { methods = new MethodInfo[0]; }

                var methodNames = new List<string>();
                foreach (MethodInfo m in methods)
                    if (!m.IsSpecialName) methodNames.Add(m.Name);

                sb.AppendLine(string.Format("    Methods: {0}", string.Join(", ", methodNames.ToArray())));
                return;
            }

            // ── Full dump: constructors ──
            ConstructorInfo[] ctors;
            try { ctors = t.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance); }
            catch { ctors = new ConstructorInfo[0]; }

            sb.AppendLine(string.Format("    Constructors ({0}):", ctors.Length));
            foreach (ConstructorInfo c in ctors)
            {
                var paramParts = new List<string>();
                foreach (ParameterInfo p in c.GetParameters())
                    paramParts.Add(string.Format("{0} {1}", p.ParameterType.Name, p.Name));
                sb.AppendLine(string.Format("      ctor({0})", string.Join(", ", paramParts.ToArray())));
            }

            // ── Full dump: methods ──
            MethodInfo[] allMethods;
            try { allMethods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static); }
            catch { allMethods = new MethodInfo[0]; }

            sb.AppendLine(string.Format("    Methods ({0}):", allMethods.Length));
            foreach (MethodInfo m in allMethods)
            {
                if (m.IsSpecialName) continue; // skip property getters/setters
                var paramParts = new List<string>();
                foreach (ParameterInfo p in m.GetParameters())
                    paramParts.Add(string.Format("{0} {1}", p.ParameterType.Name, p.Name));
                string modifier = m.IsStatic ? "static " : "";
                sb.AppendLine(string.Format("      {0}{1} {2}({3})",
                    modifier, m.ReturnType.Name, m.Name, string.Join(", ", paramParts.ToArray())));
            }

            // ── Properties (for context) ──
            PropertyInfo[] props;
            try { props = t.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static); }
            catch { props = new PropertyInfo[0]; }

            if (props.Length > 0)
            {
                var propNames = new List<string>();
                foreach (PropertyInfo p in props) propNames.Add(p.Name);
                sb.AppendLine(string.Format("    Properties: {0}", string.Join(", ", propNames.ToArray())));
            }

            sb.AppendLine("");
        }

        /// <summary>
        /// Writes a marker file to outgoing/ so the --discover flag in backtest.sh
        /// can detect that discovery has completed (same polling mechanism as results).
        /// </summary>
        private void WriteDiscoverResult()
        {
            string outputPath = Path.Combine(_outgoingDir, RESULT_PREFIX + "discover.json");
            string json = "{\"run_id\":\"discover\",\"status\":\"discover_complete\",\"error\":null}";
            File.WriteAllText(outputPath, json, new System.Text.UTF8Encoding(false));
            Log("BacktestRunner: Discovery marker written to " + outputPath);
        }

        // ─── Strategy Analyzer Automation ────────────────────────────────────────

        /// <summary>
        /// Runs a backtest by instantiating the strategy directly and calling RunBacktest()
        /// on the StrategyBase instance — no Strategy Analyzer GUI involvement.
        ///
        /// Architecture (Phase 3 — zero SA window):
        ///   Step 1: Find the strategy type in loaded assemblies via reflection
        ///   Step 2: Create instance, set all properties (instrument, dates, BarsPeriod, RunId, AutoExport)
        ///   Step 3: Call RunBacktest() (or RunBacktestInternal()) from a Task.Run background thread
        ///   Step 4: Poll for backtest_result_{RunId}.json written by strategy at State.Terminated
        ///   Step 5: Parse and return the result
        ///
        /// Why bypass the Strategy Analyzer GUI entirely:
        ///   Every prior approach (ICommand, StrategyRunner, SA ViewModel) ultimately touched WPF
        ///   objects that live on the GUI thread.  The GUI thread blocks, deadlocks, or freezes
        ///   because NT8's GUI was never designed to be driven programmatically.
        ///   Solution: StrategyBase.RunBacktest() is an instance method on NinjaTrader.Core
        ///   (confirmed by Phase 1 discovery scan in nt8doc.md).  We create the instance, set
        ///   properties via reflection, and invoke RunBacktest() from a background thread — the
        ///   GUI thread is never touched, so NT8's own callbacks fire freely.
        ///
        /// API used (confirmed via Phase 1 runtime scan, nt8doc.md):
        ///   StrategyBase.RunBacktest()            — instance, void, synchronous
        ///   StrategyBase.RunBacktestInternal()    — fallback if RunBacktest not accessible
        ///   StrategyBase.InstrumentOrInstrumentList, From, To, StartDate, EndDate
        ///   StrategyBase.Account, IncludeTradeHistoryInBacktest, BarsPeriod
        ///   NQBuyAndHold.RunId, NQBuyAndHold.AutoExport — custom export trigger properties
        /// </summary>
        private async Task<BacktestResult> RunStrategyAnalyzer(BacktestRequest request)
        {
            // Parse dates from ISO-8601 strings provided by Mac CLI
            DateTime startDate = DateTime.ParseExact(request.FromDate, "yyyy-MM-dd", CultureInfo.InvariantCulture);
            DateTime endDate   = DateTime.ParseExact(request.ToDate,   "yyyy-MM-dd", CultureInfo.InvariantCulture);

            // ── Step 1: Find the strategy type directly in loaded assemblies ─────────────
            // We bypass the Strategy Analyzer GUI entirely.  StrategyBase.RunBacktest() is
            // an instance method on NinjaTrader.Core, so we only need the type — no SA window,
            // no ViewModel, no dispatcher involvement.
            Type strategyType = null;
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                strategyType = asm.GetType("NinjaTrader.NinjaScript.Strategies." + request.Strategy);
                if (strategyType != null) break;
            }
            if (strategyType == null)
                throw new Exception("Strategy type not found: " + request.Strategy +
                    " — is it compiled in NT8? Press F5 in NT8 to compile, then retry.");

            Log("BacktestRunner: Found strategy type " + strategyType.FullName);

            // ── Step 2: Create instance and set all backtest parameters via reflection ────
            // We use dynamic + try/catch for each property so that properties that don't exist
            // on a given strategy version are silently skipped rather than aborting the run.
            dynamic strategy = Activator.CreateInstance(strategyType);

            // Core StrategyBase properties
            try { strategy.InstrumentOrInstrumentList = request.Instrument; } catch { }
            // Date range — StrategyBase uses From/To; some versions use StartDate/EndDate
            try { strategy.From      = startDate; } catch { }
            try { strategy.To        = endDate;   } catch { }
            try { strategy.StartDate = startDate; } catch { }
            try { strategy.EndDate   = endDate;   } catch { }
            try { strategy.Account   = request.Account; } catch { }
            try { strategy.IncludeTradeHistoryInBacktest = true; } catch { }
            try
            {
                strategy.BarsPeriod = new NinjaTrader.Data.BarsPeriod
                {
                    BarsPeriodType = NinjaTrader.Data.BarsPeriodType.Minute,
                    Value          = request.TimeframeMinutes
                };
            }
            catch { }

            // NQBuyAndHold-specific AutoExport properties — tells the strategy to write
            // backtest_result_{RunId}.json to outgoing/ when it reaches State.Terminated
            try { strategy.RunId      = request.RunId; }
            catch { Log("BacktestRunner: Note — strategy has no RunId property"); }

            try { strategy.AutoExport = true; }
            catch { Log("BacktestRunner: Note — strategy has no AutoExport property"); }

            Log("BacktestRunner: Strategy configured — instrument=" + request.Instrument +
                " from=" + request.FromDate + " to=" + request.ToDate +
                " RunId=" + request.RunId);

            // ── Step 3: Call RunBacktest() from a background thread ───────────────────────
            // RunBacktest() is an instance method on StrategyBase (confirmed by Phase 1 discovery).
            // We invoke it via reflection from Task.Run so the GUI thread stays free for NT8's
            // own bar-building and data-loading callbacks.  The call is synchronous — it blocks
            // until the strategy reaches State.Terminated.
            //
            // A parallel heartbeat timer fires every 30s while the backtest runs, logging elapsed
            // time and CurrentBar so we can tell whether NT8 is still making progress or has hung.
            Exception runError = null;
            var startedAt = DateTime.UtcNow;
            var cts       = new CancellationTokenSource();

            // Heartbeat: logs every 30s while RunBacktest() is blocking so the Output tab
            // shows progress instead of going silent for the entire backtest duration.
            var heartbeat = Task.Run(async () =>
            {
                while (!cts.Token.IsCancellationRequested)
                {
                    // Swallow the TaskCanceledException so we don't crash on shutdown
                    await Task.Delay(30000, cts.Token).ContinueWith(_ => { });
                    if (cts.Token.IsCancellationRequested) break;

                    int elapsed = (int)(DateTime.UtcNow - startedAt).TotalSeconds;

                    // Try to read CurrentBar via reflection — gives us a progress indicator.
                    // Wrapped in try/catch because the property may not exist on all NT8 versions.
                    string extra = "";
                    try
                    {
                        extra = "  CurrentBar=" + ((object)strategy).GetType()
                            .GetProperty("CurrentBar", BindingFlags.Public | BindingFlags.Instance)
                            ?.GetValue((object)strategy);
                    }
                    catch { }

                    Log(string.Format("BacktestRunner: still running... ({0}s elapsed){1}", elapsed, extra));
                }
            });

            // Run the blocking backtest on a background thread so the heartbeat can fire
            await Task.Run(() =>
            {
                try
                {
                    var runMethod = strategyType.GetMethod("RunBacktest",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

                    // Fall back to RunBacktestInternal if RunBacktest isn't directly on the type
                    if (runMethod == null)
                        runMethod = strategyType.GetMethod("RunBacktestInternal",
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

                    if (runMethod == null)
                        throw new Exception("Neither RunBacktest nor RunBacktestInternal found on " +
                            strategyType.FullName + " — check nt8doc.md for current member list");

                    Log("BacktestRunner: Invoking " + runMethod.Name + "() on " + strategyType.Name);
                    runMethod.Invoke((object)strategy, null);
                    Log("BacktestRunner: " + runMethod.Name + "() returned — backtest complete");
                }
                catch (Exception ex) { runError = ex; }
            });

            // Stop the heartbeat and wait for it to exit cleanly
            cts.Cancel();
            await heartbeat;

            if (runError != null) throw runError;
            Log("BacktestRunner: Polling for result file written by strategy at State.Terminated...");

            // ── Step 4: Poll for the result FILE (not the VM) ─────────────────────────────
            // The strategy writes backtest_result_{RunId}.json to outgoing/ at State.Terminated.
            // We poll every POLL_INTERVAL_MS until the file appears or we time out.
            // This is completely decoupled from WPF — just a File.Exists check.
            string resultFile = Path.Combine(_outgoingDir, RESULT_PREFIX + request.RunId + ".json");
            var deadline      = DateTime.UtcNow.AddMinutes(BACKTEST_TIMEOUT_MINUTES);

            // Since RunBacktest() is synchronous, the strategy has already reached State.Terminated
            // by this point and should have written the result file.  A brief yield lets the OS
            // flush any pending file-write buffers before we check for the file.
            await Task.Delay(500);

            Log("BacktestRunner: Polling for result file: " + resultFile);

            while (DateTime.UtcNow < deadline)
            {
                await Task.Delay(POLL_INTERVAL_MS);

                if (File.Exists(resultFile))
                {
                    Log("BacktestRunner: Result file found — reading");
                    break;
                }
            }

            if (!File.Exists(resultFile))
                throw new TimeoutException(string.Format(
                    "Result file not found after {0} minutes. File expected: {1}",
                    BACKTEST_TIMEOUT_MINUTES, resultFile));

            // ── Step 5: Read the result file and return BacktestResult ───────────────────
            // The strategy already wrote the complete JSON with the same schema as
            // BuildResultJson — we parse it using the same ExtractJsonString helpers.
            string resultJson = File.ReadAllText(resultFile, new System.Text.UTF8Encoding(false));
            return ParseResultJson(request, resultJson);
        }

        /// <summary>
        /// Parses the JSON result file written by the strategy's ExportResults() method.
        /// Uses the same string-scanning helpers as ParseRequest — no JSON library needed.
        /// </summary>
        private BacktestResult ParseResultJson(BacktestRequest request, string json)
        {
            // Extract numeric fields — if parsing fails, default to 0.0
            double ParseDouble(string key)
            {
                string search = "\"" + key + "\"";
                int keyIdx = json.IndexOf(search, StringComparison.Ordinal);
                if (keyIdx < 0) return 0.0;
                int colonIdx = json.IndexOf(':', keyIdx + search.Length);
                if (colonIdx < 0) return 0.0;
                int start = colonIdx + 1;
                while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
                int end = start;
                while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-' || json[end] == '.')) end++;
                if (end == start) return 0.0;
                return double.TryParse(json.Substring(start, end - start),
                    System.Globalization.NumberStyles.Any,
                    CultureInfo.InvariantCulture, out double v) ? v : 0.0;
            }

            int totalTrades   = (int)ParseDouble("total_trades");
            int winningTrades = (int)ParseDouble("winning_trades");
            int losingTrades  = (int)ParseDouble("losing_trades");

            return new BacktestResult
            {
                RunId              = request.RunId,
                Strategy           = request.Strategy,
                Instrument         = request.Instrument,
                TimeframeMinutes   = request.TimeframeMinutes,
                FromDate           = request.FromDate,
                ToDate             = request.ToDate,
                Account            = request.Account,
                CompletedAt        = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Status             = "completed",
                Error              = null,

                NetProfitDollars   = ParseDouble("net_profit_dollars"),
                NetProfitPoints    = ParseDouble("net_profit_points"),

                TotalTrades        = totalTrades,
                WinningTrades      = winningTrades,
                LosingTrades       = losingTrades,
                WinRatePct         = ParseDouble("win_rate_pct"),

                ProfitFactor       = ParseDouble("profit_factor"),
                MaxDrawdownDollars = ParseDouble("max_drawdown_dollars"),
                MaxDrawdownPct     = ParseDouble("max_drawdown_pct"),
                SharpeRatio        = ParseDouble("sharpe_ratio"),
                SortinoRatio       = ParseDouble("sortino_ratio"),

                AvgTradeDollars    = ParseDouble("avg_trade_dollars"),
                AvgWinnerDollars   = ParseDouble("avg_winner_dollars"),
                AvgLoserDollars    = ParseDouble("avg_loser_dollars"),
                LargestWinnerDollars = ParseDouble("largest_winner_dollars"),
                LargestLoserDollars  = ParseDouble("largest_loser_dollars"),
                AvgBarsInTrade     = ParseDouble("avg_bars_in_trade")
            };
        }

        // ─── File I/O ────────────────────────────────────────────────────────────

        /// <summary>
        /// Writes the result JSON to the outgoing directory.
        /// Filename: backtest_result_{run_id}.json — matches what Mac CLI polls for.
        /// </summary>
        private void WriteResultFile(BacktestResult result)
        {
            string filename   = RESULT_PREFIX + result.RunId + ".json";
            string outputPath = Path.Combine(_outgoingDir, filename);
            string json       = BuildResultJson(result);

            // UTF8Encoding(false) = no BOM — Python's json.loads rejects BOM-prefixed files
            File.WriteAllText(outputPath, json, new System.Text.UTF8Encoding(false));
            Log("BacktestRunner: Result written to " + outputPath);
        }

        /// <summary>
        /// Writes an error result JSON so the Mac CLI always gets a response.
        /// Status = "error", error field contains the exception message.
        /// </summary>
        private void WriteErrorResult(string runId, string errorMessage)
        {
            var result = new BacktestResult
            {
                RunId       = runId ?? "unknown",
                Status      = "error",
                CompletedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Error       = errorMessage
            };

            WriteResultFile(result);
        }

        /// <summary>
        /// Builds a JSON string from a BacktestResult using StringBuilder + InvariantCulture.
        /// This mirrors the pattern in SupabaseWriter.cs — NT8 has no JSON serializer,
        /// so we build the string manually to avoid adding assembly references.
        /// All numeric values use G format with InvariantCulture to ensure period decimal separators.
        /// </summary>
        private string BuildResultJson(BacktestResult r)
        {
            var sb = new StringBuilder();
            sb.Append("{");

            // Identity
            sb.AppendFormat("\"run_id\":\"{0}\",",        EscapeJson(r.RunId));
            sb.AppendFormat("\"strategy\":\"{0}\",",      EscapeJson(r.Strategy ?? ""));
            sb.AppendFormat("\"instrument\":\"{0}\",",    EscapeJson(r.Instrument ?? ""));
            sb.AppendFormat("\"timeframe_minutes\":{0},", r.TimeframeMinutes);
            sb.AppendFormat("\"from_date\":\"{0}\",",     EscapeJson(r.FromDate ?? ""));
            sb.AppendFormat("\"to_date\":\"{0}\",",       EscapeJson(r.ToDate ?? ""));
            sb.AppendFormat("\"account\":\"{0}\",",       EscapeJson(r.Account ?? ""));

            // Timestamps and status
            sb.AppendFormat("\"completed_at\":\"{0}\",", EscapeJson(r.CompletedAt ?? ""));
            sb.AppendFormat("\"status\":\"{0}\",",        EscapeJson(r.Status ?? "unknown"));

            // P&L
            sb.AppendFormat("\"net_profit_dollars\":{0},",  F2(r.NetProfitDollars));
            sb.AppendFormat("\"net_profit_points\":{0},",   F2(r.NetProfitPoints));

            // Trade counts
            sb.AppendFormat("\"total_trades\":{0},",    r.TotalTrades);
            sb.AppendFormat("\"winning_trades\":{0},",  r.WinningTrades);
            sb.AppendFormat("\"losing_trades\":{0},",   r.LosingTrades);
            sb.AppendFormat("\"win_rate_pct\":{0},",    F2(r.WinRatePct));

            // Risk metrics
            sb.AppendFormat("\"profit_factor\":{0},",       F4(r.ProfitFactor));
            sb.AppendFormat("\"max_drawdown_dollars\":{0},", F2(r.MaxDrawdownDollars));
            sb.AppendFormat("\"max_drawdown_pct\":{0},",    F4(r.MaxDrawdownPct));
            sb.AppendFormat("\"sharpe_ratio\":{0},",         F4(r.SharpeRatio));
            sb.AppendFormat("\"sortino_ratio\":{0},",        F4(r.SortinoRatio));

            // Per-trade stats
            sb.AppendFormat("\"avg_trade_dollars\":{0},",   F2(r.AvgTradeDollars));
            sb.AppendFormat("\"avg_winner_dollars\":{0},",  F2(r.AvgWinnerDollars));
            sb.AppendFormat("\"avg_loser_dollars\":{0},",   F2(r.AvgLoserDollars));
            sb.AppendFormat("\"largest_winner_dollars\":{0},", F2(r.LargestWinnerDollars));
            sb.AppendFormat("\"largest_loser_dollars\":{0},",  F2(r.LargestLoserDollars));
            sb.AppendFormat("\"avg_bars_in_trade\":{0},",   F2(r.AvgBarsInTrade));

            // Error (null or string) — last field, no trailing comma
            if (r.Error == null)
                sb.Append("\"error\":null");
            else
                sb.AppendFormat("\"error\":\"{0}\"", EscapeJson(r.Error));

            sb.Append("}");
            return sb.ToString();
        }

        // ─── Utility ─────────────────────────────────────────────────────────────

        /// <summary>Parses minimal JSON fields from the request file using simple string scanning.
        /// NT8 has no JSON parser, so we extract fields with basic string operations.
        /// The Mac CLI writes well-structured JSON so this is safe for our use case.</summary>
        private BacktestRequest ParseRequest(string json)
        {
            try
            {
                // Simple extraction using string operations (no Newtonsoft/System.Text.Json in NT8)
                string runId      = ExtractJsonString(json, "run_id");
                string strategy   = ExtractJsonString(json, "strategy");
                string instrument = ExtractJsonString(json, "instrument");
                string account    = ExtractJsonString(json, "account");
                string fromDate   = ExtractJsonString(json, "from_date");
                string toDate     = ExtractJsonString(json, "to_date");
                int    timeframe  = ExtractJsonInt(json,    "timeframe_minutes");

                // Validate required fields
                if (string.IsNullOrEmpty(strategy) || string.IsNullOrEmpty(instrument) ||
                    string.IsNullOrEmpty(fromDate)  || string.IsNullOrEmpty(toDate))
                {
                    Log("BacktestRunner: Missing required JSON fields in request");
                    return null;
                }

                return new BacktestRequest
                {
                    RunId            = runId,
                    Strategy         = strategy,
                    Instrument       = instrument,
                    Account          = account ?? "Sim101",
                    FromDate         = fromDate,
                    ToDate           = toDate,
                    TimeframeMinutes = timeframe > 0 ? timeframe : 5
                };
            }
            catch (Exception ex)
            {
                Log("BacktestRunner: JSON parse error — " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Extracts a string value from a JSON object by key.
        /// Handles the format: "key":"value" with optional whitespace.
        /// </summary>
        private string ExtractJsonString(string json, string key)
        {
            string search = "\"" + key + "\"";
            int keyIdx = json.IndexOf(search, StringComparison.Ordinal);
            if (keyIdx < 0) return null;

            int colonIdx = json.IndexOf(':', keyIdx + search.Length);
            if (colonIdx < 0) return null;

            // Skip whitespace after colon
            int start = colonIdx + 1;
            while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;

            if (start >= json.Length || json[start] != '"') return null;
            start++; // skip opening quote

            int end = json.IndexOf('"', start);
            if (end < 0) return null;

            return json.Substring(start, end - start);
        }

        /// <summary>Extracts an integer value from a JSON object by key.</summary>
        private int ExtractJsonInt(string json, string key)
        {
            string search = "\"" + key + "\"";
            int keyIdx = json.IndexOf(search, StringComparison.Ordinal);
            if (keyIdx < 0) return 0;

            int colonIdx = json.IndexOf(':', keyIdx + search.Length);
            if (colonIdx < 0) return 0;

            int start = colonIdx + 1;
            while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;

            // Read digits
            int end = start;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;

            if (end == start) return 0;
            return int.TryParse(json.Substring(start, end - start), out int val) ? val : 0;
        }

        /// <summary>Formats a double to 2 decimal places using InvariantCulture (period separator).</summary>
        private static string F2(double v) => v.ToString("F2", CultureInfo.InvariantCulture);

        /// <summary>Formats a double to 4 decimal places using InvariantCulture (period separator).</summary>
        private static string F4(double v) => v.ToString("F4", CultureInfo.InvariantCulture);

        /// <summary>Escapes special characters for safe embedding in JSON string values.</summary>
        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return s ?? "";
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }

        /// <summary>Deletes a file without throwing if it doesn't exist or access is denied.</summary>
        private void SafeDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch (Exception ex) { Log("BacktestRunner: Warning — could not delete " + path + ": " + ex.Message); }
        }

        /// <summary>Writes a message to NT8's Output tab (OutputTab1) for debugging.</summary>
        private static void Log(string message)
        {
            NinjaTrader.Code.Output.Process(message, NinjaTrader.NinjaScript.PrintTo.OutputTab1);
        }
    }

    // ─── Data Transfer Objects ────────────────────────────────────────────────────

    /// <summary>
    /// Parsed backtest request from the Mac CLI's JSON file.
    /// All fields are strings/ints to avoid locale-dependent parsing issues.
    /// </summary>
    internal class BacktestRequest
    {
        public string RunId            { get; set; }
        public string Strategy         { get; set; }
        public string Instrument       { get; set; }
        public int    TimeframeMinutes { get; set; }
        public string FromDate         { get; set; }
        public string ToDate           { get; set; }
        public string Account          { get; set; }
    }

    /// <summary>
    /// Backtest performance results extracted from NT8's SystemPerformance.
    /// Serialized to JSON and written to the outgoing directory for Mac CLI pickup.
    /// </summary>
    internal class BacktestResult
    {
        public string RunId              { get; set; }
        public string Strategy           { get; set; }
        public string Instrument         { get; set; }
        public int    TimeframeMinutes   { get; set; }
        public string FromDate           { get; set; }
        public string ToDate             { get; set; }
        public string Account            { get; set; }
        public string CompletedAt        { get; set; }
        public string Status             { get; set; }
        public string Error              { get; set; }

        public double NetProfitDollars   { get; set; }
        public double NetProfitPoints    { get; set; }
        public int    TotalTrades        { get; set; }
        public int    WinningTrades      { get; set; }
        public int    LosingTrades       { get; set; }
        public double WinRatePct         { get; set; }
        public double ProfitFactor       { get; set; }
        public double MaxDrawdownDollars { get; set; }
        public double MaxDrawdownPct     { get; set; }
        public double SharpeRatio        { get; set; }
        public double SortinoRatio       { get; set; }
        public double AvgTradeDollars    { get; set; }
        public double AvgWinnerDollars   { get; set; }
        public double AvgLoserDollars    { get; set; }
        public double LargestWinnerDollars { get; set; }
        public double LargestLoserDollars  { get; set; }
        public double AvgBarsInTrade     { get; set; }
    }
}
