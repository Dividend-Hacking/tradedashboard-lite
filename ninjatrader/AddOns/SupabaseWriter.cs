#region Using declarations
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// SupabaseWriter — Lightweight HTTP client that POSTs completed trades to Supabase.
    ///
    /// Design:
    /// - Fire-and-forget async: uses Task.Run to POST in the background so TradeTracker
    ///   doesn't wait for the HTTP response (trade processing is never blocked)
    /// - Manual JSON body: builds PostgREST-compatible JSON using StringBuilder (same
    ///   pattern as TradeRecord.ToJson) — NT8 has no JSON serializer available
    /// - HTTP via WebRequest: NT8 runs on .NET Framework 4.8, so we use HttpWebRequest
    ///   (HttpClient isn't available without extra assembly references)
    /// - Error handling: catches all exceptions and logs to Output tab — never crashes
    ///   the AddOn. If the POST fails, the trade is still saved locally via TradeJsonWriter.
    ///
    /// The Supabase REST API (PostgREST) expects:
    ///   POST /rest/v1/trades
    ///   Headers: apikey, Authorization: Bearer {key}, Content-Type: application/json
    ///   Body: JSON object with column names matching the trades table schema
    /// </summary>
    public class SupabaseWriter
    {
        // ─── Endpoint resolution ─────────────────────────────────────────────────
        // These were hardcoded Supabase URLs; they now resolve through
        // ModeConfig so the same AddOn works against the production Supabase
        // database (cloud mode) or the dashboard's local SQLite via /api/nt8/*
        // (local mode). Mode-flips take effect on the next polling tick.

        private static string SUPABASE_URL => ModeConfig.Endpoint;
        private static string SUPABASE_ANON_KEY => ModeConfig.ApiKey;

        /// <summary>
        /// REST endpoint for the trades table. Resolves to
        /// `<endpoint>/rest/v1/trades` in cloud mode and
        /// `<endpoint>/api/nt8/trades` in local mode.
        /// </summary>
        private static string TRADES_ENDPOINT => ModeConfig.TableUrl("trades");

        /// <summary>
        /// Endpoint for trade_bars — OHLC candles captured around each live trade.
        /// Populated after the parent trade row exists so we can key bars by trade_id FK.
        /// </summary>
        private static string TRADE_BARS_ENDPOINT => ModeConfig.TableUrl("trade_bars");

        // ─── Public API ──────────────────────────────────────────────────────────

        /// <summary>
        /// Asynchronously POSTs a completed trade to Supabase.
        /// Fire-and-forget: runs on a background thread so the caller (TradeTracker)
        /// is never blocked. If the POST fails, the error is logged but not thrown.
        /// </summary>
        /// <param name="trade">The completed TradeRecord to store in Supabase</param>
        public void WriteTradeAsync(TradeRecord trade)
        {
            // Fire-and-forget on a ThreadPool thread
            Task.Run(() =>
            {
                try
                {
                    PostTrade(trade);
                }
                catch (Exception ex)
                {
                    // Catch-all safety net — log and swallow so the AddOn never crashes
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: Unexpected error — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// Asynchronously PATCHes post-exit excursion data to an existing Supabase trade row.
        /// Fire-and-forget: runs on a background thread, same pattern as WriteTradeAsync.
        ///
        /// Uses PostgREST horizontal filtering to target the specific row:
        ///   PATCH /rest/v1/trades?entry_time=eq.{}&exit_time=eq.{}&instrument=eq.{}&account_name=eq.{}
        /// The exit_time filter is critical for uniqueness — two trades can share the same
        /// entry_time (rapid back-to-back trades) but will always have different exit_times.
        /// </summary>
        /// <param name="state">The finalized post-exit tracking state with MFE/MAE data</param>
        public void UpdatePostExitAsync(PostExitTrackingState state)
        {
            // Fire-and-forget on a ThreadPool thread
            Task.Run(() =>
            {
                try
                {
                    PatchPostExit(state);
                }
                catch (Exception ex)
                {
                    // Catch-all safety net — log and swallow so the AddOn never crashes
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: Unexpected error in post-exit PATCH — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        // ─── P/L Correction PATCH ─────────────────────────────────────────────────

        /// <summary>
        /// Asynchronously PATCHes the P/L fields on an existing trade row in Supabase.
        /// Called from OnTradeUpdate after HandleTradeExit has already written the trade.
        /// NT8's TradeUpdate fires after ExecutionUpdate/PositionUpdate, so this acts as
        /// a post-hoc correction with authoritative fill-based P/L values.
        /// Fire-and-forget: runs on a background thread, same pattern as WriteTradeAsync.
        /// </summary>
        /// <param name="instrument">Instrument full name for row targeting</param>
        /// <param name="accountName">Account name for row targeting</param>
        /// <param name="entryTime">Entry time for row targeting</param>
        /// <param name="exitPrice">NT8's authoritative exit price</param>
        /// <param name="pnlPoints">Per-contract P/L in points (derived from ProfitCurrency)</param>
        /// <param name="pnlDollars">Total P/L in dollars (NT8's ProfitCurrency)</param>
        public void PatchTradePnlAsync(string instrument, string accountName,
            DateTime entryTime, double exitPrice, double pnlPoints, double pnlDollars)
        {
            Task.Run(() =>
            {
                try
                {
                    PatchTradePnl(instrument, accountName, entryTime, exitPrice, pnlPoints, pnlDollars);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: P&L correction PATCH failed — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// PATCHes exit_price, pnl_points, and pnl_dollars on the most recent matching trade row.
        /// Uses PostgREST query-string filters (entry_time + instrument + account_name) to target
        /// the correct row, with order=created_at.desc&limit=1 to get the most recent match.
        /// </summary>
        private void PatchTradePnl(string instrument, string accountName,
            DateTime entryTime, double exitPrice, double pnlPoints, double pnlDollars)
        {
            // Build PATCH URL with PostgREST filters targeting the specific trade row
            string entryTimeFilter = Uri.EscapeDataString(entryTime.ToString("yyyy-MM-ddTHH:mm:ss"));
            string instrumentFilter = Uri.EscapeDataString(instrument);
            string accountFilter = Uri.EscapeDataString(accountName);

            string url = string.Format(
                "{0}?entry_time=eq.{1}&instrument=eq.{2}&account_name=eq.{3}&order=created_at.desc&limit=1",
                TRADES_ENDPOINT, entryTimeFilter, instrumentFilter, accountFilter);

            // Build JSON body — only the 3 P/L-related columns
            string json = string.Format(
                "{{\"exit_price\":{0},\"pnl_points\":{1},\"pnl_dollars\":{2}}}",
                exitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture),
                pnlPoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture),
                pnlDollars.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

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

            // Send the request and check the response
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;

                    if (statusCode >= 200 && statusCode < 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: P&L correction PATCH — {0} {1} (exit {2:F2}, {3:F2} pts, ${4:F2})",
                                accountName, instrument, exitPrice, pnlPoints, pnlDollars),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: P&L correction PATCH unexpected status {0} for {1}",
                                statusCode, instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (WebException wex)
            {
                // Read the actual PostgREST error from the response body
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: P&L correction PATCH HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw so PatchTradePnlAsync's catch logs the failure
            }
        }

        // ─── Orphan Cleanup ────────────────────────────────────────────────────────

        /// <summary>
        /// Fire-and-forget DELETE that removes any orphaned "open" entry row after a race condition.
        /// Called from HandleTradeExit's full-POST fallback branch. Waits 2 seconds before firing
        /// to ensure any in-flight entry POST has completed, then DELETEs the orphan row.
        ///
        /// The trade_status=eq.open filter guarantees this can never delete the correct "closed" row
        /// that the exit's full POST just created — only the stale "open" row from the entry POST.
        /// </summary>
        /// <param name="state">The open trade state used to build the filter query</param>
        public void DeleteOpenEntryAsync(OpenTradeState state)
        {
            Task.Run(async () =>
            {
                try
                {
                    // Wait 2 seconds for any in-flight entry POST to complete before deleting
                    await Task.Delay(2000);

                    // Build DELETE URL with PostgREST filters targeting the orphaned open row
                    string entryTimeFilter = Uri.EscapeDataString(state.EntryTime.ToString("yyyy-MM-ddTHH:mm:ss"));
                    string instrumentFilter = Uri.EscapeDataString(state.Instrument);
                    string accountFilter = Uri.EscapeDataString(state.AccountName);

                    string url = string.Format(
                        "{0}?entry_time=eq.{1}&instrument=eq.{2}&account_name=eq.{3}&trade_status=eq.open",
                        TRADES_ENDPOINT, entryTimeFilter, instrumentFilter, accountFilter);

                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "DELETE";
                    request.Timeout = 10000;

                    request.Headers.Add("apikey", SUPABASE_ANON_KEY);
                    request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);

                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Orphan cleanup DELETE — {0} {1} (status {2})",
                                state.Direction, state.Instrument, (int)response.StatusCode),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                catch (Exception ex)
                {
                    // Non-critical — if the entry POST never completed, there's nothing to delete.
                    // Log and swallow so the AddOn never crashes.
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: Orphan cleanup DELETE failed (non-critical) — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        // ─── Entry POST (Write-at-Entry) ──────────────────────────────────────────

        /// <summary>
        /// Asynchronously POSTs a partial trade row at entry time.
        /// Fire-and-forget: if this succeeds, state.EntryWrittenToSupabase is set true
        /// so that HandleTradeExit will PATCH instead of POST. If it fails, the flag
        /// stays false and exit falls back to a full POST (identical to pre-change behavior).
        /// </summary>
        /// <param name="state">The open trade state to write entry data for</param>
        public void WriteEntryAsync(OpenTradeState state)
        {
            Task.Run(() =>
            {
                try
                {
                    // Race condition guard: if the trade already closed before this
                    // ThreadPool thread ran, skip the entry POST to prevent creating
                    // an orphaned "open" row that the exit's full POST will duplicate.
                    if (state.TradeAlreadyClosed)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Skipping entry POST — trade already closed ({0} {1})",
                                state.Direction, state.Instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        return;
                    }

                    PostEntry(state);
                    // Mark success so exit path uses PATCH instead of full POST
                    state.EntryWrittenToSupabase = true;
                }
                catch (Exception ex)
                {
                    // Entry POST failed — EntryWrittenToSupabase stays false,
                    // so exit will fall back to full POST (no data loss)
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: Entry POST failed — {0} (will fall back to full POST at exit)", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// POSTs a partial trade row to Supabase at entry time.
        /// Contains only entry-time fields (no exit price/time/P&L) and trade_status='open'.
        /// The row will be PATCHed with exit data when the trade closes.
        /// </summary>
        private void PostEntry(OpenTradeState state)
        {
            string json = BuildEntryJson(state);

            // Diagnostic log — shows exact JSON body before sending so we can catch runtime issues
            NinjaTrader.Code.Output.Process(
                string.Format("Supabase: Entry POST body — {0}", json),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(TRADES_ENDPOINT);
            request.Method = "POST";
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

            // Wrap GetResponse in WebException catch to surface PostgREST error details.
            // Without this, 4xx/5xx errors throw a WebException with a generic message
            // like "The remote server returned an error" — the actual error body (containing
            // constraint violations, malformed JSON details, etc.) is never read.
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;

                    if (statusCode >= 200 && statusCode < 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Entry POST — {0} {1} @ {2:F2} (trade_status=open)",
                                state.Direction, state.Instrument, state.EntryPrice),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Entry POST unexpected status {0} for {1}",
                                statusCode, state.Instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (WebException wex)
            {
                // Read the actual PostgREST error from the response body
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Entry POST HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw so WriteEntryAsync's catch logs + keeps EntryWrittenToSupabase = false
            }
        }

        /// <summary>
        /// Asynchronously PATCHes exit data onto an existing 'open' trade row in Supabase.
        /// Fire-and-forget: used for RiskManager trades where WriteEntryAsync succeeded.
        /// Targets the row using entry_time + instrument + account_name + trade_status=open.
        /// </summary>
        /// <param name="trade">The completed TradeRecord with exit data to patch</param>
        public void UpdateTradeExitAsync(TradeRecord trade)
        {
            Task.Run(() =>
            {
                try
                {
                    PatchTradeExit(trade);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: Exit PATCH failed — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// PATCHes exit-time fields onto an existing 'open' trade row in Supabase.
        /// Uses PostgREST query-string filters to target the specific row:
        ///   entry_time + instrument + account_name + trade_status=open
        /// The trade_status filter prevents matching old closed trades with the same entry_time.
        /// Sets trade_status to 'closed' as part of the update.
        /// </summary>
        private void PatchTradeExit(TradeRecord trade)
        {
            // Build PATCH URL with PostgREST filters targeting the open entry row
            string entryTimeFilter = Uri.EscapeDataString(trade.EntryTime.ToString("yyyy-MM-ddTHH:mm:ss"));
            string instrumentFilter = Uri.EscapeDataString(trade.Instrument);
            string accountFilter = Uri.EscapeDataString(trade.AccountName);

            string url = string.Format(
                "{0}?entry_time=eq.{1}&instrument=eq.{2}&account_name=eq.{3}&trade_status=eq.open",
                TRADES_ENDPOINT, entryTimeFilter, instrumentFilter, accountFilter);

            string json = BuildExitPatchJson(trade);

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

            // Wrap GetResponse in WebException catch to surface PostgREST error details
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;

                    if (statusCode >= 200 && statusCode < 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Exit PATCH — {0} {1} ({2:F2} pts, {3:F2}R)",
                                trade.Direction, trade.Instrument, trade.PnlPoints, trade.ActualRR),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Exit PATCH unexpected status {0} for {1}",
                                statusCode, trade.Instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (WebException wex)
            {
                // Read the actual PostgREST error from the response body
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Exit PATCH HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw so UpdateTradeExitAsync's catch logs the failure
            }
        }

        // ─── HTTP PATCH Logic ────────────────────────────────────────────────────

        /// <summary>
        /// PATCHes the post-exit excursion fields on an existing trade row in Supabase.
        /// Uses PostgREST query-string filters to target the correct row.
        ///
        /// PostgREST PATCH semantics:
        /// - Method: PATCH (partial update — only specified columns are modified)
        /// - URL query params filter which rows to update (like a WHERE clause)
        /// - Body: JSON with only the columns to update
        /// </summary>
        private void PatchPostExit(PostExitTrackingState state)
        {
            // Calculate final post-exit metrics
            double mfePoints = state.GetPostExitMfePoints();
            double mfeR = state.GetPostExitMfeR();
            double maePoints = state.GetPostExitMaePoints();

            // Build the PATCH URL with PostgREST query-string filters
            // These filters act as a WHERE clause to target the specific trade row.
            // We include exit_time to prevent collisions when two trades share the same
            // entry_time (e.g., rapid back-to-back trades). Without exit_time, PostgREST
            // would PATCH all matching rows with the second trade's post-exit data.
            string entryTimeFilter = Uri.EscapeDataString(state.EntryTime.ToString("yyyy-MM-ddTHH:mm:ss"));
            string exitTimeFilter = Uri.EscapeDataString(state.ExitTime.ToString("yyyy-MM-ddTHH:mm:ss"));
            string instrumentFilter = Uri.EscapeDataString(state.Instrument);
            string accountFilter = Uri.EscapeDataString(state.AccountName);

            string url = string.Format(
                "{0}?entry_time=eq.{1}&exit_time=eq.{2}&instrument=eq.{3}&account_name=eq.{4}",
                TRADES_ENDPOINT, entryTimeFilter, exitTimeFilter, instrumentFilter, accountFilter);

            // Build the JSON body — only the 3 post-exit columns
            string json = BuildPostExitJson(mfePoints, mfeR, maePoints);

            // Create the HTTP request
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "PATCH";
            request.ContentType = "application/json";
            request.Timeout = 10000; // 10 second timeout

            // Supabase required headers (same as POST)
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            // Write the JSON body to the request stream
            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
            {
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            // Send the request and check the response.
            // Wrap in WebException catch to surface PostgREST error details.
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;

                    if (statusCode >= 200 && statusCode < 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Updated post-exit — {0} {1} (MFE: {2:F2} pts / {3:F2}R, MAE: {4:F2} pts)",
                                state.Direction, state.Instrument, mfePoints, mfeR, maePoints),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Post-exit PATCH unexpected status {0} for {1}",
                                statusCode, state.Instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (WebException wex)
            {
                // Read the actual PostgREST error from the response body
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Post-exit PATCH HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw so UpdatePostExitAsync's catch logs the failure
            }
        }

        /// <summary>
        /// Builds a minimal JSON body containing only the 3 post-exit columns.
        /// Used for the PATCH request — only these fields are updated on the existing row.
        /// </summary>
        private string BuildPostExitJson(double mfePoints, double mfeR, double maePoints)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"post_exit_mfe_points\":{0},", mfePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"post_exit_mfe_r\":{0},", mfeR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"post_exit_mae_points\":{0}", maePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.Append("}");
            return sb.ToString();
        }

        // ─── HTTP POST Logic ─────────────────────────────────────────────────────

        /// <summary>
        /// Builds the JSON payload from a TradeRecord and POSTs it to the Supabase
        /// trades table via the PostgREST REST API.
        ///
        /// Uses HttpWebRequest (.NET Framework 4.8 compatible) with:
        /// - apikey header (required by Supabase API gateway)
        /// - Authorization Bearer token (used by PostgREST for RLS policy evaluation)
        /// - Prefer: return=minimal (skip returning the inserted row — saves bandwidth)
        /// </summary>
        private void PostTrade(TradeRecord trade)
        {
            // Build the JSON body with flattened context fields
            string json = BuildTradeJson(trade);

            // Create the HTTP request
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(TRADES_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 10000; // 10 second timeout — don't hang forever

            // Supabase required headers
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            // Write the JSON body to the request stream
            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;

            using (Stream requestStream = request.GetRequestStream())
            {
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            // Send the request and check the response.
            // Wrap in WebException catch to surface PostgREST error details.
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;

                    if (statusCode >= 200 && statusCode < 300)
                    {
                        // Success — PostgREST returns 201 Created for inserts
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Posted trade — {0} {1} ({2:F2} pts)",
                                trade.Direction, trade.Instrument, trade.PnlPoints),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        // Unexpected status code — log it
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: Unexpected status {0} for {1} {2}",
                                statusCode, trade.Direction, trade.Instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
            }
            catch (WebException wex)
            {
                // Read the actual PostgREST error from the response body
                if (wex.Response is HttpWebResponse errResponse)
                {
                    using (var reader = new StreamReader(errResponse.GetResponseStream()))
                    {
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: POST HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw; // Re-throw so WriteTradeAsync's catch logs the failure
            }
        }

        // ─── JSON Builder ────────────────────────────────────────────────────────

        /// <summary>
        /// Builds a flat JSON object matching the Supabase trades table schema.
        /// Context fields are flattened into top-level columns (ctx_* prefix).
        /// CustomTags serialized as a JSONB object.
        ///
        /// Uses invariant culture formatting for all numeric values to avoid
        /// locale-dependent decimal separators (e.g., comma vs period).
        /// </summary>
        private string BuildTradeJson(TradeRecord trade)
        {
            var sb = new StringBuilder();
            sb.Append("{");

            // Core trade data
            sb.AppendFormat("\"entry_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", trade.EntryTime);
            sb.AppendFormat("\"exit_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", trade.ExitTime);
            // Real wall-clock timestamps — differ from entry/exit_time during playback
            sb.AppendFormat("\"real_entry_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", trade.RealEntryTime);
            sb.AppendFormat("\"real_exit_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", trade.RealExitTime);
            sb.AppendFormat("\"instrument\":\"{0}\",", EscapeJson(trade.Instrument));
            sb.AppendFormat("\"direction\":\"{0}\",", EscapeJson(trade.Direction));
            sb.AppendFormat("\"entry_price\":{0},", trade.EntryPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"exit_price\":{0},", trade.ExitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

            // DIAG [direction-flip]: value serialized into the outgoing JSON body. If this matches
            // the [3/exit] log but the DB row still shows the opposite, the flip is in the POST
            // response handling or in a downstream writer (trigger / second PATCH / frontend).
            NinjaTrader.Code.Output.Process(
                string.Format("DIAG DIR [4/json]: instrument={0} serialized_direction={1} pnlPts={2:F2}",
                    trade.Instrument, trade.Direction, trade.PnlPoints),
                NinjaTrader.NinjaScript.PrintTo.OutputTab1);
            sb.AppendFormat("\"stop_loss_price\":{0},", trade.StopLossPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"quantity\":{0},", trade.Quantity);
            sb.AppendFormat("\"pnl_points\":{0},", trade.PnlPoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"pnl_dollars\":{0},", trade.PnlDollars.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"strategy_signal_name\":\"{0}\",", EscapeJson(trade.StrategySignalName));
            sb.AppendFormat("\"account_name\":\"{0}\",", EscapeJson(trade.AccountName));

            // RR analysis
            sb.AppendFormat("\"initial_stop_distance\":{0},", trade.InitialStopDistance.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"actual_rr\":{0},", trade.ActualRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"take_profit_price\":{0},", trade.TakeProfitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"setup_rr\":{0},", trade.SetupRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mfe_points\":{0},", trade.MfePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mae_points\":{0},", trade.MaePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mfe_r_multiple\":{0},", trade.MfeRMultiple.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mae_r_multiple\":{0},", trade.MaeRMultiple.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

            // Market context — flattened from the nested Context object into ctx_* columns
            MarketContext ctx = trade.Context ?? new MarketContext();
            sb.AppendFormat("\"ctx_atr14\":{0},", ctx.Atr14.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_price_vs_ema20\":\"{0}\",", EscapeJson(ctx.PriceVsEMA20));
            sb.AppendFormat("\"ctx_dist_ema20_atr\":{0},", ctx.DistanceFromEMA20_ATR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_price_vs_ema200\":\"{0}\",", EscapeJson(ctx.PriceVsEMA200));
            sb.AppendFormat("\"ctx_dist_ema200_atr\":{0},", ctx.DistanceFromEMA200_ATR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_bollinger_pos\":\"{0}\",", EscapeJson(ctx.BollingerPosition));
            sb.AppendFormat("\"ctx_market_regime\":\"{0}\",", EscapeJson(ctx.MarketRegime));
            sb.AppendFormat("\"ctx_adx14\":{0},", ctx.Adx14.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_bollinger_bw\":{0},", ctx.BollingerBandwidth.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_atr14_15s\":{0},", ctx.Atr14_15s.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));

            // RiskManager metadata (defaults to 0/"" for non-RiskManager trades)
            sb.AppendFormat("\"risk_units\":{0},", trade.RiskUnits.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"atr_multiplier\":{0},", trade.AtrMultiplier.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"rr_multiplier\":{0},", trade.RRMultiplier.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"sl_mode\":\"{0}\",", EscapeJson(trade.SlMode ?? ""));

            // Trade status — full POST means the trade is already closed
            sb.Append("\"trade_status\":\"closed\",");

            // Custom tags — serialized as JSONB
            sb.Append("\"custom_tags\":{");
            if (trade.CustomTags != null && trade.CustomTags.Count > 0)
            {
                int i = 0;
                foreach (var kvp in trade.CustomTags)
                {
                    if (i > 0) sb.Append(",");

                    sb.AppendFormat("\"{0}\":", EscapeJson(kvp.Key));

                    // Handle different value types for JSON serialization
                    if (kvp.Value == null)
                        sb.Append("null");
                    else if (kvp.Value is string)
                        sb.AppendFormat("\"{0}\"", EscapeJson(kvp.Value.ToString()));
                    else if (kvp.Value is bool)
                        sb.Append((bool)kvp.Value ? "true" : "false");
                    else if (kvp.Value is double || kvp.Value is float)
                        sb.Append(Convert.ToDouble(kvp.Value).ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                    else
                        sb.Append(kvp.Value.ToString());

                    i++;
                }
            }
            sb.Append("}");

            sb.Append("}");
            return sb.ToString();
        }

        // ─── Entry/Exit JSON Builders ──────────────────────────────────────────

        /// <summary>
        /// Builds a JSON body for the entry-time POST. Contains only fields available
        /// at entry (no exit price/time/P&L). Sets trade_status to 'open'.
        /// Includes context fields, RiskManager metadata, and bracket prices.
        /// </summary>
        private string BuildEntryJson(OpenTradeState state)
        {
            // Calculate initial stop distance and setup RR from bracket prices
            double initialStopDist = Math.Abs(state.EntryPrice - state.InitialStopPrice);
            double setupRR = 0;
            if (initialStopDist > 0 && state.TpWasDetected)
            {
                double tpDist = state.Direction == "Long"
                    ? state.InitialTpPrice - state.EntryPrice
                    : state.EntryPrice - state.InitialTpPrice;
                if (tpDist > 0)
                    setupRR = tpDist / initialStopDist;
            }

            MarketContext ctx = state.EntryContext ?? new MarketContext();

            var sb = new StringBuilder();
            sb.Append("{");

            // Core entry fields (the 4 NOT NULL columns)
            sb.AppendFormat("\"entry_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", state.EntryTime);
            // Real wall-clock timestamp at entry — differs from entry_time during playback
            sb.AppendFormat("\"real_entry_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", state.RealEntryTime);
            sb.AppendFormat("\"instrument\":\"{0}\",", EscapeJson(state.Instrument));
            sb.AppendFormat("\"direction\":\"{0}\",", EscapeJson(state.Direction));
            sb.AppendFormat("\"entry_price\":{0},", state.EntryPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

            // Bracket and quantity data available at entry
            sb.AppendFormat("\"stop_loss_price\":{0},", state.InitialStopPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"take_profit_price\":{0},", state.InitialTpPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"quantity\":{0},", state.Quantity > 0 ? state.Quantity : 1);
            sb.AppendFormat("\"account_name\":\"{0}\",", EscapeJson(state.AccountName));
            sb.AppendFormat("\"strategy_signal_name\":\"{0}\",", EscapeJson("RiskMgr Entry"));

            // RR analysis fields available at entry
            sb.AppendFormat("\"initial_stop_distance\":{0},", initialStopDist.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"setup_rr\":{0},", setupRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));

            // RiskManager metadata
            sb.AppendFormat("\"risk_units\":{0},", state.RiskUnits.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"atr_multiplier\":{0},", state.AtrMultiplier.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"rr_multiplier\":{0},", state.RRMultiplier.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"sl_mode\":\"{0}\",", EscapeJson(state.SlMode ?? ""));

            // Market context at entry — flattened into ctx_* columns
            sb.AppendFormat("\"ctx_atr14\":{0},", ctx.Atr14.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_price_vs_ema20\":\"{0}\",", EscapeJson(ctx.PriceVsEMA20));
            sb.AppendFormat("\"ctx_dist_ema20_atr\":{0},", ctx.DistanceFromEMA20_ATR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_price_vs_ema200\":\"{0}\",", EscapeJson(ctx.PriceVsEMA200));
            sb.AppendFormat("\"ctx_dist_ema200_atr\":{0},", ctx.DistanceFromEMA200_ATR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_bollinger_pos\":\"{0}\",", EscapeJson(ctx.BollingerPosition));
            sb.AppendFormat("\"ctx_market_regime\":\"{0}\",", EscapeJson(ctx.MarketRegime));
            sb.AppendFormat("\"ctx_adx14\":{0},", ctx.Adx14.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_bollinger_bw\":{0},", ctx.BollingerBandwidth.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"ctx_atr14_15s\":{0},", ctx.Atr14_15s.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));

            // Trade status — 'open' at entry, will be PATCHed to 'closed' at exit
            sb.Append("\"trade_status\":\"open\"");

            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// Builds a JSON body for the exit-time PATCH. Contains only fields that become
        /// available at exit: exit price/time, P&L, MFE/MAE, actual RR, and signal name.
        /// Sets trade_status to 'closed'.
        /// </summary>
        private string BuildExitPatchJson(TradeRecord trade)
        {
            var sb = new StringBuilder();
            sb.Append("{");

            sb.AppendFormat("\"exit_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", trade.ExitTime);
            // Real wall-clock timestamp at exit — differs from exit_time during playback
            sb.AppendFormat("\"real_exit_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", trade.RealExitTime);
            sb.AppendFormat("\"exit_price\":{0},", trade.ExitPrice.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"pnl_points\":{0},", trade.PnlPoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"pnl_dollars\":{0},", trade.PnlDollars.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"actual_rr\":{0},", trade.ActualRR.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mfe_points\":{0},", trade.MfePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mae_points\":{0},", trade.MaePoints.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mfe_r_multiple\":{0},", trade.MfeRMultiple.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"mae_r_multiple\":{0},", trade.MaeRMultiple.ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
            sb.AppendFormat("\"strategy_signal_name\":\"{0}\",", EscapeJson(trade.StrategySignalName));
            sb.Append("\"trade_status\":\"closed\"");

            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// Escapes special characters for safe JSON string embedding.
        /// Handles backslash, double-quote, newline, carriage return, and tab.
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

        // ─── Trade Bars ─────────────────────────────────────────────────────────

        /// <summary>
        /// One OHLC bar captured around a live trade. The consumer assigns bar_index
        /// (trade-local, 0-based) before passing the list to WriteTradeBarsAsync so
        /// the entry bar, exit bar, and relative ordering are preserved.
        /// </summary>
        public class TradeBarData
        {
            public int BarIndex;
            public DateTime BarTime;
            public double Open;
            public double High;
            public double Low;
            public double Close;
            public long Volume;
            public bool IsEntryBar;
            public bool IsExitBar;
        }

        /// <summary>
        /// Asynchronously persists a window of OHLC bars tied to a completed trade.
        ///
        /// The parent trade row is written by WriteTradeAsync / UpdateTradeExitAsync on
        /// a background thread, so on entry we SELECT /rest/v1/trades filtered by
        /// (entry_time + exit_time + instrument + account_name) — the same unique key
        /// combination used by PatchPostExit — to resolve the trade_id PostgREST
        /// auto-assigned. Then we batch-insert the bars with that FK.
        ///
        /// Fire-and-forget with retry: if the trade row is not yet visible we retry a
        /// few times with backoff (the trade POST runs on a separate ThreadPool thread
        /// and may not have committed yet). Failures are logged and swallowed so the
        /// AddOn never crashes over bar capture.
        /// </summary>
        public void WriteTradeBarsAsync(TradeRecord trade, System.Collections.Generic.List<TradeBarData> bars)
        {
            if (bars == null || bars.Count == 0) return;

            Task.Run(async () =>
            {
                try
                {
                    long tradeId = await ResolveTradeIdWithRetry(trade);
                    if (tradeId <= 0)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: trade_bars skipped — could not resolve trade_id for {0} {1}",
                                trade.Direction, trade.Instrument),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                        return;
                    }

                    PostTradeBars(tradeId, bars);
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process(
                        string.Format("Supabase: WriteTradeBarsAsync error — {0}", ex.Message),
                        NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                }
            });
        }

        /// <summary>
        /// Polls the trades table for the newly-inserted row's id, with backoff.
        /// Returns -1 if not found after all attempts.
        /// </summary>
        private async Task<long> ResolveTradeIdWithRetry(TradeRecord trade)
        {
            int[] delaysMs = { 300, 700, 1500, 3000, 5000 };
            foreach (int delay in delaysMs)
            {
                await Task.Delay(delay);
                long id = TryGetTradeId(trade);
                if (id > 0) return id;
            }
            return -1;
        }

        /// <summary>
        /// GETs /rest/v1/trades?entry_time=eq...&exit_time=eq...&instrument=eq...&account_name=eq...
        /// and parses the id out of the first row. Returns -1 if no match.
        /// </summary>
        private long TryGetTradeId(TradeRecord trade)
        {
            try
            {
                string entryTimeFilter = Uri.EscapeDataString(trade.EntryTime.ToString("yyyy-MM-ddTHH:mm:ss"));
                string exitTimeFilter = Uri.EscapeDataString(trade.ExitTime.ToString("yyyy-MM-ddTHH:mm:ss"));
                string instrumentFilter = Uri.EscapeDataString(trade.Instrument);
                string accountFilter = Uri.EscapeDataString(trade.AccountName);

                string url = string.Format(
                    "{0}?select=id&entry_time=eq.{1}&exit_time=eq.{2}&instrument=eq.{3}&account_name=eq.{4}&order=id.desc&limit=1",
                    TRADES_ENDPOINT, entryTimeFilter, exitTimeFilter, instrumentFilter, accountFilter);

                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.Timeout = 10000;
                request.Headers.Add("apikey", SUPABASE_ANON_KEY);
                request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    return ParseFirstId(body);
                }
            }
            catch
            {
                return -1;
            }
        }

        /// <summary>
        /// Naive id extractor for a PostgREST array body like: [{"id":1234}].
        /// Manual parse because NT8 has no JSON deserializer on the classpath.
        /// </summary>
        private static long ParseFirstId(string body)
        {
            if (string.IsNullOrEmpty(body)) return -1;
            int idx = body.IndexOf("\"id\"", StringComparison.Ordinal);
            if (idx < 0) return -1;
            int colon = body.IndexOf(':', idx);
            if (colon < 0) return -1;
            int i = colon + 1;
            while (i < body.Length && (body[i] == ' ' || body[i] == '\t')) i++;
            int start = i;
            while (i < body.Length && (char.IsDigit(body[i]) || body[i] == '-')) i++;
            if (i == start) return -1;
            long val;
            if (long.TryParse(body.Substring(start, i - start), out val)) return val;
            return -1;
        }

        /// <summary>
        /// Batch-POSTs the bar array to /rest/v1/trade_bars with the resolved trade_id FK.
        /// PostgREST accepts a JSON array for bulk insert. Single request — bar counts
        /// per trade are small (window of ~25 + hold length) so chunking isn't needed.
        /// </summary>
        private void PostTradeBars(long tradeId, System.Collections.Generic.List<TradeBarData> bars)
        {
            var sb = new StringBuilder();
            sb.Append("[");
            for (int i = 0; i < bars.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var b = bars[i];
                sb.Append("{");
                sb.AppendFormat("\"trade_id\":{0},", tradeId);
                sb.AppendFormat("\"bar_index\":{0},", b.BarIndex);
                sb.AppendFormat("\"bar_time\":\"{0:yyyy-MM-ddTHH:mm:ss}\",", b.BarTime);
                sb.AppendFormat("\"bar_open\":{0},", b.Open.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_high\":{0},", b.High.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_low\":{0},", b.Low.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_close\":{0},", b.Close.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                sb.AppendFormat("\"bar_volume\":{0},", b.Volume);
                sb.AppendFormat("\"is_entry_bar\":{0},", b.IsEntryBar ? "true" : "false");
                sb.AppendFormat("\"is_exit_bar\":{0}", b.IsExitBar ? "true" : "false");
                sb.Append("}");
            }
            sb.Append("]");
            string json = sb.ToString();

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(TRADE_BARS_ENDPOINT);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 15000;
            request.Headers.Add("apikey", SUPABASE_ANON_KEY);
            request.Headers.Add("Authorization", "Bearer " + SUPABASE_ANON_KEY);
            request.Headers.Add("Prefer", "return=minimal");

            byte[] bodyBytes = Encoding.UTF8.GetBytes(json);
            request.ContentLength = bodyBytes.Length;
            using (Stream requestStream = request.GetRequestStream())
            {
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    int statusCode = (int)response.StatusCode;
                    if (statusCode >= 200 && statusCode < 300)
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: trade_bars — inserted {0} bars for trade_id {1}", bars.Count, tradeId),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                    else
                    {
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: trade_bars unexpected status {0} for trade_id {1}", statusCode, tradeId),
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
                        string errorBody = reader.ReadToEnd();
                        NinjaTrader.Code.Output.Process(
                            string.Format("Supabase: trade_bars POST HTTP {0} — {1}",
                                (int)errResponse.StatusCode, errorBody),
                            NinjaTrader.NinjaScript.PrintTo.OutputTab1);
                    }
                }
                throw;
            }
        }
    }
}
