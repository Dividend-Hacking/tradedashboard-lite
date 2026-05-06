#region Using declarations
using System;
using System.IO;
using System.Text.RegularExpressions;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// LiveBridgeConfig — Centralized loader for the user's Supabase URL and
    /// anon key, read at runtime from a JSON file so this repo can ship with
    /// no hardcoded credentials.
    ///
    /// Config file location:
    ///   %USERPROFILE%\Documents\NinjaTrader 8\livebridge.config.json
    ///
    /// Expected format:
    ///   {
    ///     "supabaseUrl": "https://yourproject.supabase.co",
    ///     "supabaseAnonKey": "eyJ..."
    ///   }
    ///
    /// Loaded once on first access and cached. If the file is missing or
    /// malformed, all properties return empty strings — callers should treat
    /// that as "no Supabase configured" and skip their HTTP calls (the
    /// dashboard surfaces the missing config separately via env vars).
    ///
    /// We deliberately avoid taking a hard dependency on Newtonsoft.Json or
    /// any other parser — only two top-level string fields are needed, so a
    /// minimal regex extraction keeps the AddOn self-contained.
    /// </summary>
    public static class LiveBridgeConfig
    {
        private static readonly object _lock = new object();
        private static bool _loaded = false;
        private static string _url = "";
        private static string _anonKey = "";

        /// <summary>Supabase project URL (no trailing slash). Empty if unconfigured.</summary>
        public static string Url
        {
            get { EnsureLoaded(); return _url; }
        }

        /// <summary>Supabase anon JWT. Empty if unconfigured.</summary>
        public static string AnonKey
        {
            get { EnsureLoaded(); return _anonKey; }
        }

        /// <summary>True if both URL and key were successfully loaded.</summary>
        public static bool IsConfigured
        {
            get { EnsureLoaded(); return _url.Length > 0 && _anonKey.Length > 0; }
        }

        /// <summary>
        /// Resolves to %USERPROFILE%\Documents\NinjaTrader 8\livebridge.config.json
        /// on Windows. Override via the LIVEBRIDGE_CONFIG_PATH environment
        /// variable (useful for tests or non-default NT install dirs).
        /// </summary>
        private static string GetConfigPath()
        {
            string env = Environment.GetEnvironmentVariable("LIVEBRIDGE_CONFIG_PATH");
            if (!string.IsNullOrEmpty(env)) return env;

            string docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.Combine(docs, "NinjaTrader 8", "livebridge.config.json");
        }

        /// <summary>
        /// Reads + parses the config file once on first access. All later
        /// reads are served from the cached values. Failures are logged to
        /// NT8's Output tab but do not throw, so a missing config never
        /// crashes a strategy or AddOn.
        /// </summary>
        private static void EnsureLoaded()
        {
            if (_loaded) return;
            lock (_lock)
            {
                if (_loaded) return;
                _loaded = true;

                try
                {
                    string path = GetConfigPath();
                    if (!File.Exists(path))
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("LiveBridgeConfig: file not found at {0}. " +
                                          "Create it with {{\"supabaseUrl\":..., \"supabaseAnonKey\":...}} " +
                                          "to enable Supabase syncing.", path),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        return;
                    }

                    string json = File.ReadAllText(path);
                    _url = ExtractField(json, "supabaseUrl").TrimEnd('/');
                    _anonKey = ExtractField(json, "supabaseAnonKey");

                    if (_url.Length == 0 || _anonKey.Length == 0)
                    {
                        NinjaTrader.Code.Output.Process(
                            "LiveBridgeConfig: supabaseUrl or supabaseAnonKey missing/empty in config file.",
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("LiveBridgeConfig: failed to load — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            }
        }

        /// <summary>
        /// Pulls a top-level "field": "value" pair out of a JSON string.
        /// Tolerant of whitespace and surrounding fields; does not handle
        /// escaped quotes inside the value (anon keys + URLs never contain them).
        /// Returns "" when the field is absent or unmatchable.
        /// </summary>
        private static string ExtractField(string json, string field)
        {
            // Match: "field"  :  "value"   — captures everything up to the closing quote.
            string pattern = "\"" + Regex.Escape(field) + "\"\\s*:\\s*\"([^\"]*)\"";
            Match m = Regex.Match(json, pattern);
            return m.Success ? m.Groups[1].Value : "";
        }
    }
}
