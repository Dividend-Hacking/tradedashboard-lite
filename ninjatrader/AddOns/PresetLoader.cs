// PresetLoader.cs
//
// Reads a preset JSON file off disk and produces a populated Preset POCO.
//
// Why JavaScriptSerializer? NinjaTrader 8 ships .NET Framework 4.8 with the
// System.Web assembly available, and JavaScriptSerializer ships with that
// assembly. Newtonsoft.Json is NOT reliably available in the NinjaScript
// compile environment, and System.Text.Json doesn't exist on .NET Framework.
// JavaScriptSerializer hands us a Dictionary<string, object> tree which we
// hand-walk into the strongly-typed POCO — verbose but predictable, and it
// lets us apply forward-compat defaults for any missing field (matching the
// dashboard's normalizePresetForLoad shim).
//
// Reads support both camelCase (the dashboard's TS export) and snake_case
// (the Supabase row export) for the few fields that differ — e.g.
// "strategy_id" or "strategyId", "created_at" or "createdAt" — so a preset
// JSON pasted from EITHER source loads correctly.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;

namespace NinjaTrader.NinjaScript.AddOns
{
    public static class PresetLoader
    {
        /// <summary>
        /// Load a preset from a UTF-8 JSON file. Throws on file-not-found or
        /// JSON parse failure (caller is the strategy's State.DataLoaded
        /// handler — failure there should disarm the strategy, not silently
        /// run with defaults).
        /// </summary>
        public static Preset LoadFromFile(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                throw new FileNotFoundException("Preset JSON not found: " + path);

            string json = File.ReadAllText(path);
            return ParseJson(json);
        }

        /// <summary>
        /// Parse a JSON string into a Preset. Exposed so a future feature
        /// (drop-in preset paste box, embedded resource loading) can skip
        /// the file I/O.
        /// </summary>
        public static Preset ParseJson(string json)
        {
            var serializer = new JavaScriptSerializer();
            // Lift the default 4MB cap — preset JSONs are tiny (a few KB)
            // but bumping it costs nothing and avoids surprises if a future
            // export gets verbose.
            serializer.MaxJsonLength = 16 * 1024 * 1024;

            var root = serializer.Deserialize<Dictionary<string, object>>(json);
            if (root == null)
                throw new InvalidDataException("Preset JSON parsed to null");

            return MapPreset(root);
        }

        // ─── Top-level mapper ───────────────────────────────────────────────
        private static Preset MapPreset(Dictionary<string, object> d)
        {
            var p = new Preset();

            p.Version    = GetInt(d,    "version",     1);
            p.Id         = GetString(d, "id",          "");
            p.Name       = GetString(d, "name",        "");
            // Accept either camelCase (dashboard) or snake_case (Supabase row).
            p.CreatedAt  = GetString(d, "createdAt",   GetString(d, "created_at", ""));
            p.UpdatedAt  = GetString(d, "updatedAt",   GetString(d, "updated_at", ""));
            p.StrategyId = GetString(d, "strategyId",  GetString(d, "strategy_id", ""));

            // Params dict — flatten everything to double. Values arrive as
            // either decimal (e.g. 14) or double (e.g. 0.85) depending on
            // the JSON literal; both convert via ToDouble cleanly.
            var paramsDict = GetDict(d, "params");
            if (paramsDict != null)
            {
                foreach (var kv in paramsDict)
                    p.Params[kv.Key] = ToDouble(kv.Value, 0);
            }

            // Rules — defensive defaults so a partial preset still loads.
            p.Rules = MapRules(GetDict(d, "rules"));

            // Filters — same defensive treatment.
            p.Filters = MapFilters(GetDict(d, "filters"));

            return p;
        }

        // ─── SimRules mapper ────────────────────────────────────────────────
        private static SimRules MapRules(Dictionary<string, object> d)
        {
            var r = new SimRules();
            if (d == null) return r;

            r.StopLossEnabled     = GetBool   (d, "stopLossEnabled",     r.StopLossEnabled);
            r.StopLossPoints      = GetDouble (d, "stopLossPoints",      r.StopLossPoints);
            r.TakeProfitEnabled   = GetBool   (d, "takeProfitEnabled",   r.TakeProfitEnabled);
            r.TakeProfitPoints    = GetDouble (d, "takeProfitPoints",    r.TakeProfitPoints);
            r.TrailingStopEnabled = GetBool   (d, "trailingStopEnabled", r.TrailingStopEnabled);
            r.TrailingStopPoints  = GetDouble (d, "trailingStopPoints",  r.TrailingStopPoints);

            r.TimedExitEnabled = GetBool  (d, "timedExitEnabled", r.TimedExitEnabled);
            r.TimedExitBars    = GetInt   (d, "timedExitBars",    r.TimedExitBars);
            r.BreakEvenEnabled = GetBool  (d, "breakEvenEnabled", r.BreakEvenEnabled);
            r.BreakEvenTrigger = GetDouble(d, "breakEvenTrigger", r.BreakEvenTrigger);

            r.ExitAtBarClose       = GetBool(d, "exitAtBarClose",       r.ExitAtBarClose);
            r.ExtensionBarsEnabled = GetBool(d, "extensionBarsEnabled", r.ExtensionBarsEnabled);
            r.ExtensionBars        = GetInt (d, "extensionBars",        r.ExtensionBars);

            r.SlAtrAdjust    = GetDouble(d, "slAtrAdjust",    r.SlAtrAdjust);
            r.TpAtrAdjust    = GetDouble(d, "tpAtrAdjust",    r.TpAtrAdjust);
            r.TrailAtrAdjust = GetDouble(d, "trailAtrAdjust", r.TrailAtrAdjust);
            r.BeAtrAdjust    = GetDouble(d, "beAtrAdjust",    r.BeAtrAdjust);

            r.PositionMode = GetString(d, "positionMode", r.PositionMode);

            r.ScalingEnabled    = GetBool(d, "scalingEnabled",    r.ScalingEnabled);
            r.ScalingStartSize  = GetInt (d, "scalingStartSize",  r.ScalingStartSize);
            r.ScalingWinStep    = GetInt (d, "scalingWinStep",    r.ScalingWinStep);
            r.ScalingLossStep   = GetInt (d, "scalingLossStep",   r.ScalingLossStep);
            r.ScalingMinSize    = GetInt (d, "scalingMinSize",    r.ScalingMinSize);
            r.ScalingMaxSize    = GetInt (d, "scalingMaxSize",    r.ScalingMaxSize);
            r.ScalingResetDaily = GetBool(d, "scalingResetDaily", r.ScalingResetDaily);

            r.DailyStopLossEnabled   = GetBool  (d, "dailyStopLossEnabled",   r.DailyStopLossEnabled);
            r.DailyStopLossPoints    = GetDouble(d, "dailyStopLossPoints",    r.DailyStopLossPoints);
            r.DailyTakeProfitEnabled = GetBool  (d, "dailyTakeProfitEnabled", r.DailyTakeProfitEnabled);
            r.DailyTakeProfitPoints  = GetDouble(d, "dailyTakeProfitPoints",  r.DailyTakeProfitPoints);
            r.DailyLimitExactMode    = GetBool  (d, "dailyLimitExactMode",    r.DailyLimitExactMode);

            // Per-day count caps + cooldown (post-customization additions).
            // Defaults (5 trades, 3 losses, 5min cooldown) match the
            // dashboard's DEFAULT_SIM_RULES so an older preset that
            // doesn't include these keys loads as a no-op.
            r.MaxTradesPerDayEnabled        = GetBool(d, "maxTradesPerDayEnabled",        r.MaxTradesPerDayEnabled);
            r.MaxTradesPerDay               = GetInt (d, "maxTradesPerDay",               r.MaxTradesPerDay);
            r.MaxLossesPerDayEnabled        = GetBool(d, "maxLossesPerDayEnabled",        r.MaxLossesPerDayEnabled);
            r.MaxLossesPerDay               = GetInt (d, "maxLossesPerDay",               r.MaxLossesPerDay);
            r.CooldownBetweenTradesEnabled  = GetBool(d, "cooldownBetweenTradesEnabled",  r.CooldownBetweenTradesEnabled);
            r.CooldownBetweenTradesBars     = GetInt (d, "cooldownBetweenTradesBars",     r.CooldownBetweenTradesBars);

            // Backtest-only round-trip fields. Read so a preset re-exported
            // from the dashboard parses cleanly; nothing in live execution
            // consumes them (NT8 has its own slippage/commission knobs).
            r.FillMode               = GetString(d, "fillMode",               r.FillMode);
            r.SlippagePoints         = GetDouble(d, "slippagePoints",         r.SlippagePoints);
            r.CommissionPerRoundTrip = GetDouble(d, "commissionPerRoundTrip", r.CommissionPerRoundTrip);
            r.PointValue             = GetDouble(d, "pointValue",             r.PointValue);
            r.TickConfigMode         = GetString(d, "tickConfigMode",         r.TickConfigMode);
            r.TicksPerPoint          = GetDouble(d, "ticksPerPoint",          r.TicksPerPoint);
            r.TickValue              = GetDouble(d, "tickValue",              r.TickValue);

            return r;
        }

        // ─── Filters mapper ─────────────────────────────────────────────────
        private static PresetFilters MapFilters(Dictionary<string, object> d)
        {
            var f = new PresetFilters();
            if (d == null) return f;

            var time = GetDict(d, "time");
            if (time != null)
            {
                f.Time.Enabled = GetBool  (time, "enabled", f.Time.Enabled);
                f.Time.From    = GetString(time, "from",    f.Time.From);
                f.Time.To      = GetString(time, "to",      f.Time.To);

                // Multi-window: prefer `windows` when present. Each entry
                // is `{from, to}` matching the dashboard's TimeWindow
                // shape. When `windows` is missing or empty (older
                // preset JSONs predate multi-window), synthesize a
                // single-window list from the legacy from/to so the
                // executor's evaluator always has a non-empty list.
                f.Time.Windows = new List<TimeWindow>();
                var rawWindows = GetList(time, "windows");
                if (rawWindows != null)
                {
                    foreach (var item in rawWindows)
                    {
                        var wd = item as Dictionary<string, object>;
                        if (wd == null) continue;
                        var w = new TimeWindow
                        {
                            From = GetString(wd, "from", f.Time.From),
                            To   = GetString(wd, "to",   f.Time.To),
                        };
                        f.Time.Windows.Add(w);
                    }
                }
                if (f.Time.Windows.Count == 0)
                {
                    f.Time.Windows.Add(new TimeWindow { From = f.Time.From, To = f.Time.To });
                }
                else
                {
                    // Keep the legacy from/to in sync with windows[0] so
                    // any consumer reading the old fields sees the right
                    // first-window value.
                    f.Time.From = f.Time.Windows[0].From;
                    f.Time.To   = f.Time.Windows[0].To;
                }
            }

            var adx = GetDict(d, "adx");
            if (adx != null)
            {
                f.Adx.Enabled = GetBool  (adx, "enabled", f.Adx.Enabled);
                f.Adx.Min     = GetDouble(adx, "min",     f.Adx.Min);
                f.Adx.Max     = GetDouble(adx, "max",     f.Adx.Max);
                f.Adx.Period  = GetInt   (adx, "period",  f.Adx.Period);
            }

            var atr = GetDict(d, "atr");
            if (atr != null)
            {
                f.Atr.Enabled = GetBool  (atr, "enabled", f.Atr.Enabled);
                f.Atr.Min     = GetDouble(atr, "min",     f.Atr.Min);
                f.Atr.Max     = GetDouble(atr, "max",     f.Atr.Max);
                f.Atr.Period  = GetInt   (atr, "period",  f.Atr.Period);
            }

            var trend = GetDict(d, "trend");
            if (trend != null)
            {
                f.Trend.Enabled    = GetBool  (trend, "enabled",    f.Trend.Enabled);
                f.Trend.Ema20Mode  = GetString(trend, "ema20Mode",  f.Trend.Ema20Mode);
                f.Trend.Ema200Mode = GetString(trend, "ema200Mode", f.Trend.Ema200Mode);
                f.Trend.FastPeriod = GetInt   (trend, "fastPeriod", f.Trend.FastPeriod);
                f.Trend.FastType   = GetString(trend, "fastType",   f.Trend.FastType);
                f.Trend.SlowPeriod = GetInt   (trend, "slowPeriod", f.Trend.SlowPeriod);
                f.Trend.SlowType   = GetString(trend, "slowType",   f.Trend.SlowType);
            }

            var bb = GetDict(d, "bollinger");
            if (bb != null)
            {
                f.Bollinger.Enabled = GetBool(bb, "enabled", f.Bollinger.Enabled);
                var allowed = GetList(bb, "allowed");
                if (allowed != null)
                {
                    f.Bollinger.Allowed.Clear();
                    foreach (var item in allowed)
                    {
                        if (item is string s) f.Bollinger.Allowed.Add(s);
                    }
                }
                f.Bollinger.Period = GetInt   (bb, "period", f.Bollinger.Period);
                f.Bollinger.StdDev = GetDouble(bb, "stdDev", f.Bollinger.StdDev);
            }

            // Post-customization filter sub-blocks. All three default
            // disabled, so an older preset JSON without these keys still
            // loads cleanly (each GetDict returns null, the block is
            // skipped, and the filter's default Enabled=false makes it a
            // no-op).
            var bbWidth = GetDict(d, "bbWidth");
            if (bbWidth != null)
            {
                f.BbWidth.Enabled = GetBool  (bbWidth, "enabled", f.BbWidth.Enabled);
                f.BbWidth.Min     = GetDouble(bbWidth, "min",     f.BbWidth.Min);
                f.BbWidth.Max     = GetDouble(bbWidth, "max",     f.BbWidth.Max);
            }

            var maDist = GetDict(d, "maDistance");
            if (maDist != null)
            {
                f.MaDistance.Enabled = GetBool  (maDist, "enabled", f.MaDistance.Enabled);
                f.MaDistance.Period  = GetInt   (maDist, "period",  f.MaDistance.Period);
                f.MaDistance.Type    = GetString(maDist, "type",    f.MaDistance.Type);
                f.MaDistance.Mode    = GetString(maDist, "mode",    f.MaDistance.Mode);
                f.MaDistance.Min     = GetDouble(maDist, "min",     f.MaDistance.Min);
                f.MaDistance.Max     = GetDouble(maDist, "max",     f.MaDistance.Max);
            }

            var vol = GetDict(d, "volume");
            if (vol != null)
            {
                f.Volume.Enabled  = GetBool  (vol, "enabled",  f.Volume.Enabled);
                f.Volume.Period   = GetInt   (vol, "period",   f.Volume.Period);
                f.Volume.MinRatio = GetDouble(vol, "minRatio", f.Volume.MinRatio);
                f.Volume.MaxRatio = GetDouble(vol, "maxRatio", f.Volume.MaxRatio);
            }

            var rsi = GetDict(d, "rsi");
            if (rsi != null)
            {
                f.Rsi.Enabled = GetBool  (rsi, "enabled", f.Rsi.Enabled);
                f.Rsi.Period  = GetInt   (rsi, "period",  f.Rsi.Period);
                f.Rsi.Min     = GetDouble(rsi, "min",     f.Rsi.Min);
                f.Rsi.Max     = GetDouble(rsi, "max",     f.Rsi.Max);
            }

            var adxTrend = GetDict(d, "adxTrend");
            if (adxTrend != null)
            {
                f.AdxTrend.Enabled       = GetBool  (adxTrend, "enabled",       f.AdxTrend.Enabled);
                f.AdxTrend.Mode          = GetString(adxTrend, "mode",          f.AdxTrend.Mode);
                f.AdxTrend.Lookback      = GetInt   (adxTrend, "lookback",      f.AdxTrend.Lookback);
                f.AdxTrend.FlatThreshold = GetDouble(adxTrend, "flatThreshold", f.AdxTrend.FlatThreshold);
            }

            return f;
        }

        // ─── Type-safe dictionary readers ───────────────────────────────────
        // JavaScriptSerializer types: numbers come through as int / decimal /
        // double, booleans as bool, strings as string, objects as
        // Dictionary<string, object>, arrays as ArrayList. Helpers normalize
        // each into the .NET type the POCO expects, applying a default when
        // the key is missing or the value is the wrong shape.

        private static Dictionary<string, object> GetDict(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v is Dictionary<string, object>)
                return (Dictionary<string, object>)v;
            return null;
        }

        private static System.Collections.IList GetList(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v is System.Collections.IList)
                return (System.Collections.IList)v;
            return null;
        }

        private static string GetString(Dictionary<string, object> d, string key, string fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v is string)
                return (string)v;
            return fallback;
        }

        private static bool GetBool(Dictionary<string, object> d, string key, bool fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v))
            {
                if (v is bool) return (bool)v;
                // Be lenient: "true"/"false" strings show up if a user
                // hand-edits a preset file; accept them rather than silently
                // reverting to the default.
                if (v is string)
                {
                    bool parsed;
                    if (bool.TryParse((string)v, out parsed)) return parsed;
                }
            }
            return fallback;
        }

        private static int GetInt(Dictionary<string, object> d, string key, int fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v))
                return (int)Math.Round(ToDouble(v, fallback));
            return fallback;
        }

        private static double GetDouble(Dictionary<string, object> d, string key, double fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v))
                return ToDouble(v, fallback);
            return fallback;
        }

        /// <summary>
        /// Best-effort numeric coercion. JavaScriptSerializer can hand back
        /// int, decimal, double, long, or string — Convert.ToDouble handles
        /// the numeric ones; strings get parsed in invariant culture so
        /// "0.85" parses regardless of the system locale.
        /// </summary>
        private static double ToDouble(object v, double fallback)
        {
            if (v == null) return fallback;
            try
            {
                if (v is string)
                {
                    double parsed;
                    return double.TryParse((string)v, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)
                        ? parsed
                        : fallback;
                }
                return Convert.ToDouble(v, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }
    }
}
