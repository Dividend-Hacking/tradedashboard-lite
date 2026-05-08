// ─── ModeConfig ─────────────────────────────────────────────────────────────
//
// Switches the URL/key the rest of the AddOns use to talk to the data plane
// based on a mode.json file dropped in this folder by the web app.
//
// Two modes:
//   - Cloud (default): the existing behavior — point at the production
//     Supabase REST endpoints with the anon key.
//   - Local: the user runs the dashboard's Next.js dev server on their Mac
//     and toggled "Local Mode" in the UI. The web app writes mode.json with
//     the host URL (typically http://10.211.55.2:3000 — the Parallels
//     gateway IP) and we rewrite every Supabase REST URL to /api/nt8/<table>
//     against that host.
//
// All AddOn endpoint constants now resolve through TableUrl(table) /
// StorageObjectUrl(bucket, path), so flipping the mode at runtime takes
// effect on the next 15s polling tick — no NT8 restart required.
//
// Failure modes are intentionally lenient:
//   - mode.json missing or unreadable → cloud mode (preserves legacy behavior).
//   - mode.json with a malformed value → keep last known good values.
//
// Thread-safety: a single static lock guards the cached state so the timer
// thread reading config doesn't race with another thread refreshing it.

using System;
using System.IO;

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class ModeConfig
    {
        public enum Mode { Cloud, Local }

        // Cloud defaults — unchanged from the original hardcoded values, so a
        // missing mode.json keeps the existing behavior intact.
        private const string CLOUD_URL = "https://zidddaorklilipbxfogr.supabase.co";
        private const string CLOUD_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppZGRkYW9ya2xpbGlwYnhmb2dyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwODUwODgsImV4cCI6MjA4NjY2MTA4OH0.9ankT2x20vbSjjO77bnoSsBsVd4Un5Ganu94_CtmAjk";

        private static readonly object _lock = new object();
        private static Mode _mode = Mode.Cloud;
        private static string _endpoint = CLOUD_URL;
        private static string _apiKey = CLOUD_KEY;
        private static DateTime _lastLoad = DateTime.MinValue;
        private static readonly TimeSpan _ttl = TimeSpan.FromSeconds(15);

        // mode.json lives next to the deployed AddOn DLL/CS files. Parallels
        // mirrors $HOME/Documents/NinjaTrader 8 from the host, so the same
        // path works whether NT8 runs on the host or the VM.
        private static string ConfigPath
        {
            get
            {
                string userData = NinjaTrader.Core.Globals.UserDataDir;
                return Path.Combine(userData, "bin", "Custom", "AddOns", "mode.json");
            }
        }

        /// <summary>
        /// Reload the mode config if more than the TTL has elapsed. Cheap to
        /// call from any hot path — most calls are no-ops.
        /// </summary>
        public static void EnsureLoaded()
        {
            lock (_lock)
            {
                if (DateTime.UtcNow - _lastLoad < _ttl) return;
                TryLoad();
                _lastLoad = DateTime.UtcNow;
            }
        }

        /// <summary>Active mode (defaults to Cloud).</summary>
        public static Mode CurrentMode
        {
            get { EnsureLoaded(); return _mode; }
        }

        /// <summary>Base URL for the data plane (cloud Supabase URL or local web app host).</summary>
        public static string Endpoint
        {
            get { EnsureLoaded(); return _endpoint; }
        }

        /// <summary>API key for the data plane. Always the cloud anon key —
        /// local-mode routes ignore it but accept it.</summary>
        public static string ApiKey
        {
            get { EnsureLoaded(); return _apiKey; }
        }

        /// <summary>
        /// Build the URL for a given table. Cloud → `<endpoint>/rest/v1/<table>`,
        /// Local → `<endpoint>/api/nt8/<table>`.
        /// </summary>
        public static string TableUrl(string table)
        {
            EnsureLoaded();
            string trimmed = _endpoint.TrimEnd('/');
            if (_mode == Mode.Local)
                return trimmed + "/api/nt8/" + table;
            return trimmed + "/rest/v1/" + table;
        }

        /// <summary>
        /// Build the URL for a Storage object. Cloud →
        /// `<endpoint>/storage/v1/object/<bucket>/<path>`, Local →
        /// `<endpoint>/api/nt8/<bucket>/<path>` (the bucket name doubles as
        /// the route segment for parity with the table dispatcher).
        /// </summary>
        public static string StorageObjectUrl(string bucket, string path)
        {
            EnsureLoaded();
            string trimmed = _endpoint.TrimEnd('/');
            if (_mode == Mode.Local)
                return trimmed + "/api/nt8/" + bucket + "/" + path;
            return trimmed + "/storage/v1/object/" + bucket + "/" + path;
        }

        // ─── Internals ────────────────────────────────────────────────────

        private static void TryLoad()
        {
            try
            {
                string path = ConfigPath;
                if (!File.Exists(path)) return;
                string raw = File.ReadAllText(path);

                // Tiny manual JSON parse — NinjaTrader compiled scripts can't
                // pull in System.Text.Json or Newtonsoft. We only care about
                // three fields and they're all strings.
                string mode = ExtractString(raw, "mode");
                string endpoint = ExtractString(raw, "nt8Endpoint");
                if (string.IsNullOrEmpty(endpoint)) endpoint = ExtractString(raw, "endpoint");
                string apikey = ExtractString(raw, "key");

                if (!string.IsNullOrEmpty(mode))
                {
                    _mode = mode.Equals("local", StringComparison.OrdinalIgnoreCase)
                        ? Mode.Local : Mode.Cloud;
                }

                if (_mode == Mode.Local)
                {
                    if (!string.IsNullOrEmpty(endpoint)) _endpoint = endpoint;
                }
                else
                {
                    // Cloud mode — use the embedded defaults regardless of
                    // what's in mode.json. Lets us swap modes without losing
                    // the cloud creds.
                    _endpoint = CLOUD_URL;
                }

                if (!string.IsNullOrEmpty(apikey)) _apiKey = apikey;
                else if (_mode == Mode.Cloud) _apiKey = CLOUD_KEY;
            }
            catch
            {
                // Keep last good values — never crash an AddOn over a bad
                // config file.
            }
        }

        /// <summary>
        /// Extract a top-level string field from a small JSON object. Tolerates
        /// whitespace and escaped quotes; not a general-purpose parser.
        /// </summary>
        private static string ExtractString(string json, string key)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return null;
            string needle = "\"" + key + "\"";
            int idx = json.IndexOf(needle, StringComparison.Ordinal);
            if (idx < 0) return null;
            int colon = json.IndexOf(':', idx + needle.Length);
            if (colon < 0) return null;
            int firstQuote = json.IndexOf('"', colon + 1);
            if (firstQuote < 0) return null;
            // Walk forward looking for the unescaped closing quote.
            int i = firstQuote + 1;
            var sb = new System.Text.StringBuilder();
            while (i < json.Length)
            {
                char c = json[i];
                if (c == '\\' && i + 1 < json.Length)
                {
                    sb.Append(json[i + 1]);
                    i += 2;
                    continue;
                }
                if (c == '"') return sb.ToString();
                sb.Append(c);
                i++;
            }
            return null;
        }
    }
}
