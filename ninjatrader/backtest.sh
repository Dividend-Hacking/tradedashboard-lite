#!/usr/bin/env bash
# backtest.sh — Mac-side CLI to trigger NT8 Strategy Analyzer backtests
#
# Architecture:
#   1. Writes a JSON request to ~/Documents/NinjaTrader 8/incoming/
#   2. NT8's BacktestRunner AddOn picks it up, runs the backtest, writes a result JSON
#   3. This script polls for the result in ~/Documents/NinjaTrader 8/outgoing/
#   4. On success: copies result to backtests/results/, prints summary, uploads to Supabase
#
# Both Mac and Windows VM see ~/Documents/NinjaTrader 8/ as the same directory via
# Parallels shared folders — no SMB mount or prlctl needed for file exchange.
#
# Usage:
#   ./ninjatrader/backtest.sh \
#     --strategy NQBuyAndHold \
#     --instrument "NQ 03-26" \
#     --from 2025-01-01 \
#     --to 2025-03-01 \
#     [--timeframe 5] \
#     [--account Sim101]

set -euo pipefail

# ── Script location for relative path resolution ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load .env for Supabase credentials ──────────────────────────────────────
# .env lives next to this script in ninjatrader/.env
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  # Source only KEY=VALUE lines, skip comments and blank lines
  set -o allexport
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
  set +o allexport
fi

# ── Required environment variables ──────────────────────────────────────────
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"

# ── Argument defaults ────────────────────────────────────────────────────────
ARG_STRATEGY=""
ARG_INSTRUMENT=""
ARG_FROM=""
ARG_TO=""
ARG_TIMEFRAME="5"
ARG_ACCOUNT="Sim101"
ARG_DISCOVER=false   # Phase 1: scan NT8 backend types, dump to Output tab

# ── Parse command-line arguments ─────────────────────────────────────────────
usage() {
  echo ""
  echo "Usage: $0 --strategy NAME --instrument SYMBOL --from YYYY-MM-DD --to YYYY-MM-DD [--timeframe N] [--account NAME]"
  echo "       $0 --discover"
  echo ""
  echo "  --strategy     NinjaScript strategy class name (e.g. NQBuyAndHold)"
  echo "  --instrument   NT8 instrument full name (e.g. \"NQ 03-26\" or \"ES 06-25\")"
  echo "  --from         Backtest start date (YYYY-MM-DD)"
  echo "  --to           Backtest end date   (YYYY-MM-DD)"
  echo "  --timeframe    Bar period in minutes (default: 5)"
  echo "  --account      Simulation account name (default: Sim101)"
  echo "  --discover     Phase 1: scan NT8 backend types and dump to Output tab"
  echo "                 Read results in NT8 > Output tab after running."
  echo ""
  echo "Environment (ninjatrader/.env):"
  echo "  SUPABASE_URL       — Supabase project URL"
  echo "  SUPABASE_ANON_KEY  — Supabase anon key for REST API"
  echo ""
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strategy)    ARG_STRATEGY="$2";    shift 2 ;;
    --instrument)  ARG_INSTRUMENT="$2";  shift 2 ;;
    --from)        ARG_FROM="$2";        shift 2 ;;
    --to)          ARG_TO="$2";          shift 2 ;;
    --timeframe)   ARG_TIMEFRAME="$2";   shift 2 ;;
    --account)     ARG_ACCOUNT="$2";     shift 2 ;;
    --discover)    ARG_DISCOVER=true;    shift 1 ;;
    -h|--help)     usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# ── Discover mode: write {"type":"discover"} and poll for completion marker ──
# Phase 1 of the headless backtest plan: discover NT8 backend runner type names
# without any strategy/instrument arguments. Results go to NT8's Output tab.
if [[ "$ARG_DISCOVER" == "true" ]]; then
  NT8_DIR="$HOME/Documents/NinjaTrader 8"
  INCOMING_DIR="$NT8_DIR/incoming"
  OUTGOING_DIR="$NT8_DIR/outgoing"
  DISCOVER_RESULT="$OUTGOING_DIR/backtest_result_discover.json"

  mkdir -p "$INCOMING_DIR" "$OUTGOING_DIR"

  # Remove stale marker from a previous discover run
  rm -f "$DISCOVER_RESULT"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  NT8 BacktestRunner — Phase 1 Discovery"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Writing discover request to NT8 incoming dir..."
  echo ""

  # Write the discover request — BacktestRunner.cs checks for "type":"discover"
  cat > "$INCOMING_DIR/backtest_request.json" << 'DISCOVER_EOF'
{"type":"discover"}
DISCOVER_EOF

  echo "  Waiting for NT8 to complete discovery scan..."
  echo "  (BacktestRunner will dump results to NT8 Output tab)"
  echo ""

  # Poll for the completion marker (same mechanism as backtest results)
  TIMEOUT=120
  ELAPSED=0
  while [[ $ELAPSED -lt $TIMEOUT ]]; do
    if [[ -f "$DISCOVER_RESULT" ]]; then
      echo "✓  Discovery complete!"
      echo ""
      echo "  Next: Open NT8 Output tab to read the type scan results."
      echo "  Look for: StrategyRunner, StrategyAnalyzerTabProperties"
      echo "  and any type with Run/Start/Execute in NinjaTrader.NinjaScript / NinjaTrader.Cbi"
      echo ""
      rm -f "$DISCOVER_RESULT"
      exit 0
    fi
    sleep 5
    ELAPSED=$(( ELAPSED + 5 ))
    if (( ELAPSED % 30 == 0 )); then
      echo "  Still waiting... (${ELAPSED}s)"
    fi
  done

  echo "✗  Timed out after ${TIMEOUT}s — BacktestRunner may not be running."
  echo "  Check: NT8 > Tools > AddOns Manager > BacktestRunner = Active"
  exit 1
fi

# ── Validate required arguments ──────────────────────────────────────────────
[[ -z "$ARG_STRATEGY"   ]] && { echo "ERROR: --strategy is required";    usage; }
[[ -z "$ARG_INSTRUMENT" ]] && { echo "ERROR: --instrument is required";  usage; }
[[ -z "$ARG_FROM"       ]] && { echo "ERROR: --from is required";        usage; }
[[ -z "$ARG_TO"         ]] && { echo "ERROR: --to is required";          usage; }

# ── Validate date format (YYYY-MM-DD) ────────────────────────────────────────
validate_date() {
  local d="$1"
  if ! [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "ERROR: Invalid date format '$d' — expected YYYY-MM-DD"
    exit 1
  fi
}
validate_date "$ARG_FROM"
validate_date "$ARG_TO"

# ── Paths ─────────────────────────────────────────────────────────────────────
# Parallels mirrors ~/Documents/NinjaTrader 8/ to the Windows VM's Documents folder.
# BacktestRunner.cs reads from: {UserDataDir}\incoming\backtest_request.json
# BacktestRunner.cs writes to:  {UserDataDir}\outgoing\backtest_result_{run_id}.json
NT8_DIR="$HOME/Documents/NinjaTrader 8"
INCOMING_DIR="$NT8_DIR/incoming"
OUTGOING_DIR="$NT8_DIR/outgoing"
RESULTS_DIR="$REPO_ROOT/backtests/results"

# Create local directories if they don't exist
mkdir -p "$INCOMING_DIR" "$OUTGOING_DIR" "$RESULTS_DIR"

# ── Generate unique run_id ────────────────────────────────────────────────────
# Slug: strategy_instrument_from_to_epoch
# Instrument may have spaces — replace with hyphens for safe filenames
EPOCH="$(date +%s)"
INSTRUMENT_SLUG="${ARG_INSTRUMENT// /-}"
RUN_ID="${ARG_STRATEGY}_${INSTRUMENT_SLUG}_${ARG_FROM}_${ARG_TO}_${EPOCH}"

# ── Write request JSON to incoming directory ──────────────────────────────────
REQUEST_FILE="$INCOMING_DIR/backtest_request.json"
RESULT_FILE="$OUTGOING_DIR/backtest_result_${RUN_ID}.json"
LOCAL_RESULT="$RESULTS_DIR/${RUN_ID}.json"

cat > "$REQUEST_FILE" << EOF
{
  "run_id":            "$RUN_ID",
  "strategy":          "$ARG_STRATEGY",
  "instrument":        "$ARG_INSTRUMENT",
  "timeframe_minutes": $ARG_TIMEFRAME,
  "from_date":         "$ARG_FROM",
  "to_date":           "$ARG_TO",
  "account":           "$ARG_ACCOUNT"
}
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NT8 Backtest Runner"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Strategy:    $ARG_STRATEGY"
echo "  Instrument:  $ARG_INSTRUMENT"
echo "  Period:      $ARG_FROM → $ARG_TO"
echo "  Timeframe:   ${ARG_TIMEFRAME}min bars"
echo "  Account:     $ARG_ACCOUNT"
echo "  Run ID:      $RUN_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "▶  Request dropped — waiting for NT8 BacktestRunner to pick it up..."
echo "   (Make sure NT8 is running with BacktestRunner AddOn compiled & active)"
echo ""

# ── Poll for result ───────────────────────────────────────────────────────────
# Check every 5 seconds, timeout after 10 minutes (NT8 backtest typically takes < 2 min).
TIMEOUT_SECONDS=600
POLL_INTERVAL=5
ELAPSED=0

while [[ $ELAPSED -lt $TIMEOUT_SECONDS ]]; do
  if [[ -f "$RESULT_FILE" ]]; then
    echo "✓  Result file detected!"
    break
  fi

  # Show a progress dot every 30 seconds
  if (( ELAPSED % 30 == 0 && ELAPSED > 0 )); then
    echo "   Still waiting... (${ELAPSED}s elapsed)"
  fi

  sleep $POLL_INTERVAL
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))
done

if [[ ! -f "$RESULT_FILE" ]]; then
  echo ""
  echo "✗  ERROR: Timed out after ${TIMEOUT_SECONDS}s — no result file at:"
  echo "   $RESULT_FILE"
  echo ""
  echo "Troubleshooting:"
  echo "  1. Is NT8 running? Check Parallels Desktop."
  echo "  2. Did BacktestRunner compile? Press F5 in NinjaScript Editor."
  echo "  3. Is BacktestRunner active? Check NT8 > Tools > AddOns Manager."
  echo "  4. Check NT8 Output tab for BacktestRunner error messages."
  echo "  5. Manually inspect: $INCOMING_DIR"
  exit 1
fi

# ── Read and validate result ──────────────────────────────────────────────────
RESULT_JSON="$(cat "$RESULT_FILE")"

# Extract status field using Python3 (ships with macOS — no jq required)
parse_field() {
  python3 -c "
import json, sys
data = json.loads(sys.stdin.read().lstrip('\ufeff'))
val = data.get('$1', None)
if val is None:
  print('null')
elif isinstance(val, float):
  print(f'{val:.4f}')
else:
  print(val)
" <<< "$RESULT_JSON"
}

STATUS="$(parse_field status)"

if [[ "$STATUS" == "error" ]]; then
  ERROR_MSG="$(parse_field error)"
  echo ""
  echo "✗  Backtest returned an error:"
  echo "   $ERROR_MSG"
  echo ""
  echo "   Full result saved to: $RESULT_FILE"
  exit 1
fi

# ── Copy result to local results directory ────────────────────────────────────
cp "$RESULT_FILE" "$LOCAL_RESULT"
echo "   Result saved to: backtests/results/${RUN_ID}.json"
echo ""

# ── Print performance summary ─────────────────────────────────────────────────
NET_PROFIT="$(parse_field net_profit_dollars)"
TOTAL_TRADES="$(parse_field total_trades)"
WIN_RATE="$(parse_field win_rate_pct)"
PROFIT_FACTOR="$(parse_field profit_factor)"
SHARPE="$(parse_field sharpe_ratio)"
MAX_DD="$(parse_field max_drawdown_dollars)"
AVG_TRADE="$(parse_field avg_trade_dollars)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Backtest Results — $ARG_STRATEGY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  Net P&L:        \$%s\n"  "$NET_PROFIT"
printf "  Total Trades:    %s\n"   "$TOTAL_TRADES"
printf "  Win Rate:        %s%%\n" "$WIN_RATE"
printf "  Profit Factor:   %s\n"   "$PROFIT_FACTOR"
printf "  Sharpe Ratio:    %s\n"   "$SHARPE"
printf "  Max Drawdown:   \$%s\n"  "$MAX_DD"
printf "  Avg Trade:      \$%s\n"  "$AVG_TRADE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Upload to Supabase ────────────────────────────────────────────────────────
if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_ANON_KEY" ]]; then
  echo "⚠  Skipping Supabase upload — SUPABASE_URL or SUPABASE_ANON_KEY not set in .env"
  echo ""
else
  echo "▶  Uploading to Supabase backtest_runs table..."

  # Build the Supabase INSERT payload from the result JSON.
  # We transform our result JSON into the backtest_runs table schema using Python3.
  SUPABASE_PAYLOAD="$(python3 - <<'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    r = json.load(f)

# Map result JSON fields to backtest_runs table columns
payload = {
    "run_id":                 r.get("run_id"),
    "completed_at":           r.get("completed_at"),
    "strategy":               r.get("strategy"),
    "instrument":             r.get("instrument"),
    "timeframe_min":          r.get("timeframe_minutes"),
    "from_date":              r.get("from_date"),
    "to_date":                r.get("to_date"),
    "account":                r.get("account"),
    "status":                 r.get("status", "completed"),
    "net_profit_dollars":     r.get("net_profit_dollars"),
    "net_profit_points":      r.get("net_profit_points"),
    "total_trades":           r.get("total_trades"),
    "winning_trades":         r.get("winning_trades"),
    "losing_trades":          r.get("losing_trades"),
    "win_rate_pct":           r.get("win_rate_pct"),
    "profit_factor":          r.get("profit_factor"),
    "max_drawdown_dollars":   r.get("max_drawdown_dollars"),
    "max_drawdown_pct":       r.get("max_drawdown_pct"),
    "sharpe_ratio":           r.get("sharpe_ratio"),
    "sortino_ratio":          r.get("sortino_ratio"),
    "avg_trade_dollars":      r.get("avg_trade_dollars"),
    "avg_winner_dollars":     r.get("avg_winner_dollars"),
    "avg_loser_dollars":      r.get("avg_loser_dollars"),
    "largest_winner_dollars": r.get("largest_winner_dollars"),
    "largest_loser_dollars":  r.get("largest_loser_dollars"),
    "avg_bars_in_trade":      r.get("avg_bars_in_trade"),
    "error":                  r.get("error"),
}

print(json.dumps(payload))
PYEOF
)"$LOCAL_RESULT"
  )"

  # POST to Supabase REST API
  HTTP_STATUS="$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/rest/v1/backtest_runs" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "$SUPABASE_PAYLOAD")"

  if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "200" ]]; then
    echo "✓  Uploaded to Supabase (HTTP $HTTP_STATUS)"
  else
    echo "⚠  Supabase upload returned HTTP $HTTP_STATUS — result still saved locally"
    echo "   Retry: curl -X POST '${SUPABASE_URL}/rest/v1/backtest_runs' \\"
    echo "     -H 'apikey: ${SUPABASE_ANON_KEY}' -H 'Content-Type: application/json' \\"
    echo "     -d @$LOCAL_RESULT"
  fi

  echo ""
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
# Remove the NT8 result file from the outgoing directory (we have our local copy).
# The request file was deleted by BacktestRunner.cs after reading.
rm -f "$RESULT_FILE"

echo "✓  Done. Full results: backtests/results/${RUN_ID}.json"
echo ""
