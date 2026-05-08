# NT8 Backtest CLI

Run NinjaTrader 8 Strategy Analyzer backtests from the Mac terminal without touching the NT8 UI.

## How It Works

```
Mac: ninjatrader/backtest.sh
  │  writes backtest_request.json to ~/Documents/NinjaTrader 8/incoming/
  │
  ↓  (Parallels shared folder — both Mac and Windows VM see the same files)
  │
NT8: BacktestRunner AddOn (BacktestRunner.cs)
  │  FileSystemWatcher detects request, runs Strategy Analyzer, extracts results
  │  writes backtest_result_{run_id}.json to ~/Documents/NinjaTrader 8/outgoing/
  │
  ↓
Mac: backtest.sh polls for result
  - Saves JSON to backtests/results/{run_id}.json
  - Prints performance summary
  - Uploads row to Supabase backtest_runs table
```

## Prerequisites

1. Parallels Desktop running with NinjaTrader 8 open
2. BacktestRunner AddOn compiled in NT8 (press F5 in NinjaScript Editor after deploying)
3. BacktestRunner showing as Active in NT8 > Tools > AddOns

## Deploy the AddOn

```bash
cd ninjatrader && ./deploy-nt8.sh
# Then press F5 in NT8's NinjaScript Editor to compile
```

## Usage

```bash
./ninjatrader/backtest.sh \
  --strategy NQBuyAndHold \
  --instrument "NQ 03-26" \
  --from 2025-01-01 \
  --to 2025-03-01 \
  [--timeframe 5] \
  [--account Sim101]
```

### Arguments

| Argument | Required | Description | Example |
|---|---|---|---|
| `--strategy` | Yes | NinjaScript strategy class name (exact, case-sensitive) | `NQBuyAndHold` |
| `--instrument` | Yes | NT8 instrument full name | `"NQ 03-26"` |
| `--from` | Yes | Backtest start date | `2025-01-01` |
| `--to` | Yes | Backtest end date | `2025-03-01` |
| `--timeframe` | No | Bar period in minutes (default: 5) | `15` |
| `--account` | No | Simulation account (default: Sim101) | `Sim101` |

### Examples

```bash
# 5-minute NQ backtest for Q1 2025
./ninjatrader/backtest.sh \
  --strategy NQBuyAndHold \
  --instrument "NQ 03-26" \
  --from 2025-01-01 \
  --to 2025-03-31

# 15-minute ES backtest with a specific account
./ninjatrader/backtest.sh \
  --strategy ESMeanReversion \
  --instrument "ES 06-25" \
  --from 2024-10-01 \
  --to 2025-01-01 \
  --timeframe 15 \
  --account Sim101

# Full year backtest
./ninjatrader/backtest.sh \
  --strategy NQTripleConfirmation \
  --instrument "NQ 12-25" \
  --from 2024-01-01 \
  --to 2024-12-31 \
  --timeframe 5
```

## Output

### Terminal summary
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Backtest Results — NQBuyAndHold
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Net P&L:         $12450.00
  Total Trades:    87
  Win Rate:        58.6%
  Profit Factor:   1.84
  Sharpe Ratio:    1.2300
  Max Drawdown:    $4200.00
  Avg Trade:       $143.10
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Local JSON file
Saved to `backtests/results/{strategy}_{instrument}_{from}_{to}_{epoch}.json` with full metrics.

### Supabase
Uploaded to the `backtest_runs` table in the proforma project.
Query via: `SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT 20;`

## Result JSON Schema

```json
{
  "run_id":                 "NQBuyAndHold_NQ-03-26_2025-01-01_2025-03-31_1710000000",
  "strategy":               "NQBuyAndHold",
  "instrument":             "NQ 03-26",
  "timeframe_minutes":      5,
  "from_date":              "2025-01-01",
  "to_date":                "2025-03-31",
  "account":                "Sim101",
  "completed_at":           "2026-03-16T18:30:00Z",
  "status":                 "completed",
  "net_profit_dollars":     12450.00,
  "net_profit_points":      12450.00,
  "total_trades":           87,
  "winning_trades":         51,
  "losing_trades":          36,
  "win_rate_pct":           58.62,
  "profit_factor":          1.8400,
  "max_drawdown_dollars":   4200.00,
  "max_drawdown_pct":       0.0340,
  "sharpe_ratio":           1.2300,
  "sortino_ratio":          1.6700,
  "avg_trade_dollars":      143.10,
  "avg_winner_dollars":     485.20,
  "avg_loser_dollars":      -312.40,
  "largest_winner_dollars": 1820.00,
  "largest_loser_dollars":  -940.00,
  "avg_bars_in_trade":      8.40,
  "error":                  null
}
```

## Troubleshooting

**Script times out (no result file)**
- Is Parallels running and NT8 open?
- Did BacktestRunner compile? Check NT8 Output tab for compile errors.
- Is BacktestRunner listed as Active in NT8 > Tools > AddOns Manager?
- Check NT8 Output tab — BacktestRunner logs every step there.

**"error" status in result**
- The full error message is in the result JSON and printed in NT8's Output tab.
- Common cause: strategy name doesn't match exactly (case-sensitive), or invalid instrument name.

**NT8 Strategy Analyzer API mismatch**
- BacktestRunner.cs uses internal NT8 APIs (`StrategyAnalyzerWindow`).
- If property names don't resolve, use NT8's Assembly Browser to find the correct names:
  NinjaScript Editor > Help > Assembly Browser > search `StrategyAnalyzerWindow`

**Supabase upload fails**
- Check `ninjatrader/.env` has valid `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- The result JSON is always saved locally even if Supabase fails.
- The script prints a `curl` retry command you can run manually.

## File Locations

| Path | Description |
|---|---|
| `ninjatrader/backtest.sh` | Mac CLI entry point |
| `ninjatrader/AddOns/BacktestRunner.cs` | NT8 AddOn (FileSystemWatcher + Strategy Analyzer) |
| `ninjatrader/.env` | Supabase credentials |
| `backtests/results/` | Local JSON result files |
| `~/Documents/NinjaTrader 8/incoming/` | Request drop zone (shared folder) |
| `~/Documents/NinjaTrader 8/outgoing/` | Result pickup zone (shared folder) |
