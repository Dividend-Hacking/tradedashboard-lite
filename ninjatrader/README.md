# NinjaTrader 8 — NQ/MNQ Intraday Strategies

Top-performing intraday strategies converted from the Python backtesting engine to NinjaScript (C#) for NinjaTrader 8. Designed for backtesting and trading NQ (Nasdaq 100 E-mini) and MNQ (Micro Nasdaq 100) futures on 5-minute bars.

## Strategy Selection

Strategies were ranked by running all 27 non-crypto Python strategies against NQUSD data. The top 5 were selected for diversity across strategy types:

| Strategy | Type | NQUSD Sharpe | NQUSD PF | Trades | File |
|----------|------|-------------|---------|--------|------|
| Session Range Fade | Mean Reversion / Fade | 6.89 | 0.53 | 107 | `NQSessionRangeFade.cs` |
| Bollinger-Donchian Squeeze | Breakout | 3.09 | 0.94 | 126 | `NQBollingerDonchianSqueeze.cs` |
| VWAP Bounce Volume | Support/Resistance | 1.23 | 1.36 | 26 | `NQVwapBounceVolume.cs` |
| Triple Confirmation | Trend (Confluence) | 0.08 | 1.08 | 41 | `NQTripleConfirmation.cs` |
| VP POC Bounce | Volume Profile | -1.79 | 0.67 | 81 | `NQVPPOCBounce.cs` |
| **Buy & Hold** | **Benchmark** | — | — | — | `NQBuyAndHold.cs` |

## Dashboard Preset Strategies

Separate from the hand-ported strategies above, this folder also contains a generic **PresetStrategy** engine that runs any preset exported from the trading dashboard's Backtesting tab — no C# rewrite per preset. The three currently-shipped variants:

| Strategy | Preset | File | Notes |
|----------|--------|------|-------|
| NQTest03 | `test03` | `NQTest03.cs` | signal_v2, scaling on, timed exit, daily SL halt, NQ time window 07:30–10:00 |
| CLTest01 | `Test01 CL` | `CLTest01.cs` | signal_v2 tuned for Crude Light (CL), scaling off, ATR floor 0.03, time window 06:00–09:00 |
| NQTest03NoTimeNoDL | `test03 (no time or DL)` | `NQTest03NoTimeNoDL.cs` | Same as NQTest03 but with the time filter and daily SL disabled |

### Architecture

```
AddOns/
├── PresetSchema.cs           POCOs (Preset / SimRules / PresetFilters / Bar / Signal)
├── PresetLoader.cs           JSON → POCO (JavaScriptSerializer-based)
├── PresetIndicators.cs       ATR / EMA / ADX / Bollinger (mirror of backtest-engine.ts)
├── PresetSignals.cs          signal_v1 + signal_v2 generators
├── PresetFilterEvaluator.cs  Time / ADX / ATR / Trend / Bollinger gate
└── PresetExecutor.cs         Runtime brain — ActiveEntry, scaling, BE, daily counters

Strategies/
├── PresetStrategy.cs         Generic NT8 wrapper (loads JSON, dispatches Actions)
├── NQTest03.cs               Thin wrapper — sets ConfigPath default
├── CLTest01.cs               Thin wrapper
├── NQTest03NoTimeNoDL.cs     Thin wrapper
└── presets/
    ├── test03.json
    ├── test01_cl.json
    └── test03_no_time_or_dl.json
```

The engine is a 1:1 port of the dashboard's `auto-trader-engine.ts` + `backtest-engine.ts` math, so any preset that backtests on the dashboard runs identically here — just with native NT8 order handling instead of a browser WebSocket bridge.

### Porting a New Preset

1. **Export the preset as JSON.** In the dashboard's Backtesting tab, select the preset → click `EXPORT`. The full JSON lands on the clipboard.
2. **Save it to `Strategies/presets/<name>.json`** in this repo.
3. **Add a 6-line wrapper class** in `Strategies/<Name>.cs`:
   ```csharp
   public class MyNewPreset : PresetStrategy
   {
       protected override string DefaultConfigPath()
           => System.IO.Path.Combine(NinjaTrader.Core.Globals.UserDataDir,
                                     "bin", "Custom", "presets", "my_new_preset.json");
       protected override void OnStateChange()
       {
           base.OnStateChange();
           if (State == State.SetDefaults)
           {
               Name        = "MyNewPreset";
               Description = "Short blurb about this variant.";
           }
       }
   }
   ```
4. **Deploy + compile**: `cd ninjatrader && ./deploy-nt8.sh`, then F5 in NinjaScript Editor. The strategy appears in the Strategy Analyzer dropdown.

No engine code changes required — the `PresetStrategy` base + the AddOns/Preset* files do the entire job. JSON-only updates land via re-deploy + F5.

### Verifying Parity

After deploying, run the same date range in NT8 Strategy Analyzer that the dashboard backtests against. Entry timestamps + directions should match 1:1. Any drift is a port bug — flag it before live trading.

## Deploying to Windows VM

After editing any `.cs` strategy files on the Mac, use the deploy script to push them into the Windows VM where NinjaTrader 8 runs.

### Prerequisites

- **VMware Fusion** installed on Mac with the Windows 11 VM running
- **VMware Tools** installed and running inside the Windows VM
- A **local Windows user** (`deployer`) with write access to the NT8 Strategies folder
- **`vmrun`** on your PATH (add `/Applications/VMware Fusion.app/Contents/Library` if needed)

### Setup (one-time)

1. Create `ninjatrader/.env` with your VM credentials (already gitignored):
   ```
   VM_GUEST_USER=deployer
   VM_GUEST_PASS=<your deployer password>
   VM_ENCRYPT_PASS=<your VM encryption password>
   ```

2. In the Windows VM, grant the deployer user access to the NT8 Strategies folder (run in admin Command Prompt):
   ```
   icacls "C:\Users\jsco5\OneDrive\Documents\NinjaTrader 8\bin\Custom\Strategies" /grant deployer:(OI)(CI)F
   ```

### Deploy workflow

```bash
cd ninjatrader && ./deploy-nt8.sh
```

This copies all 6 `.cs` files from `Strategies/` into the VM's NinjaTrader folder. Then in the VM:
1. Open **NinjaScript Editor** (New > NinjaScript Editor)
2. Press **F5** to compile
3. Strategies appear in the Strategy Analyzer dropdown

### Troubleshooting

| Error | Fix |
|-------|-----|
| `Incorrect password` | Check `VM_ENCRYPT_PASS` in `.env` — this is the VM encryption password, not Windows login |
| `Invalid user name or password for the guest OS` | Check `VM_GUEST_USER` and `VM_GUEST_PASS` in `.env` |
| `The virtual machine is not powered on` | Start the Windows VM in VMware Fusion first |
| `A file was not found` | The destination path doesn't exist — verify NT8 is installed |
| `You do not have access rights` | Re-run the `icacls` grant command above in admin Command Prompt |
| CS0229 "Ambiguity" compile errors | Delete old/duplicate `.cs` files from the NT8 Strategies folder — only the `NQ*.cs` files should be there |

## Manual Installation (without VM deploy script)

### 1. Copy Strategy Files

Copy all `.cs` files from `Strategies/` to your NinjaTrader custom strategies folder:

```
C:\Users\<you>\OneDrive\Documents\NinjaTrader 8\bin\Custom\Strategies\
```

Files to copy:
- `NQSessionRangeFade.cs`
- `NQBollingerDonchianSqueeze.cs`
- `NQVwapBounceVolume.cs`
- `NQTripleConfirmation.cs`
- `NQVPPOCBounce.cs`
- `NQBuyAndHold.cs`

Each strategy is fully self-contained (inherits directly from `Strategy`) — no shared base class needed.

### 2. Compile

1. Open NinjaTrader 8
2. Go to **New > NinjaScript Editor**
3. Press **F5** or click the compile button
4. All strategies should compile without errors
5. They will appear in the Strategy Analyzer dropdown

## Running Backtests

### Strategy Analyzer Setup

1. Open **New > Strategy Analyzer**
2. Select a strategy (e.g., `NQSessionRangeFade`)
3. Configure:
   - **Instrument**: NQ 03-26 (or MNQ 03-26 for micro)
   - **Type**: Bars
   - **Value**: 5 (for 5-minute bars)
   - **From/To**: Your desired date range (recommend at least 3 months)
   - **Starting Capital**: $10,000+
4. Review strategy **Properties** panel for tunable parameters
5. Click **Run**

### Recommended Starting Configuration

Start with **1 MNQ contract** to validate strategy behavior before scaling:
- Contracts: 1
- Slippage: 2 ticks (built into base strategy)
- Commission: Set per your broker rates

## Strategy Descriptions

### NQSessionRangeFade (Mean Reversion / Fade)

Fades session extremes by entering long when price drops to the bottom 15% of the day's range, and short when price reaches the top 85%. Stochastic %K confirms oversold/overbought conditions.

**Entry (Long):** Session Range Position < 0.15, Stochastic %K < 25, Volume >= SMA
**Entry (Short):** Session Range Position > 0.85, Stochastic %K > 75, Volume >= SMA
**Exit:** Price returns to session midpoint (Long exit: range > 0.55, Short exit: range < 0.45)

**Key Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| Range Low Threshold | 0.15 | How close to session low for long entry |
| Range High Threshold | 0.85 | How close to session high for short entry |
| Stoch Oversold | 25 | Stochastic confirmation level (long) |
| Stoch Overbought | 75 | Stochastic confirmation level (short) |
| Stop Loss ATR | 1.0 | ATR-based stop loss |

---

### NQBollingerDonchianSqueeze (Breakout)

Detects volatility compression when both Bollinger Bandwidth AND Donchian Channel Width are narrow, then enters on a strong candle breakout with volume. Double squeeze = high-probability directional expansion.

**Entry (Long):** BB Width < 0.8%, Donchian Width < 0.8%, Bullish candle, Body >= 35%, Volume >= 1.1x SMA
**Entry (Short):** Same squeeze conditions with bearish candle
**Exit:** MACD Fast Histogram reverses beyond threshold

**Key Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| Bollinger Width Threshold | 0.8 | Max BB width % for squeeze |
| Donchian Width Threshold | 0.8 | Max Donchian width % for squeeze |
| Min Body % | 35 | Minimum candle body conviction |
| Stop Loss ATR | 1.5 | Wider stop for breakout trades |
| Trail Activation ATR | 1.2 | Trailing starts after 1.2 ATR move |

---

### NQVwapBounceVolume (Support/Resistance)

Enters when price pulls back within 0.4 ATR of VWAP and bounces with a strong candle and volume. VWAP acts as a dynamic intraday support/resistance level. Uses manual VWAP calculation (no Order Flow+ dependency).

**Entry (Long):** Distance from VWAP < 0.4 ATR, Bullish candle, Body >= 30%, Volume >= 1.1x SMA
**Entry (Short):** Same proximity with bearish candle
**Exit (Long):** Price falls below VWAP (support broken)
**Exit (Short):** Price rises above VWAP (resistance broken)

**Key Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| VWAP Distance ATR | 0.4 | Max distance from VWAP for "touch" |
| Min Body % | 30 | Candle body conviction |
| Stop Loss ATR | 1.3 | Stop loss distance |
| Trail Activation ATR | 0.8 | Trailing activation |

---

### NQTripleConfirmation (Trend / Confluence)

Heavy-confluence entry requiring four filters: EMA 20 trend direction, MACD histogram momentum, Stochastic in "sweet zone" (not extreme), and VWAP side. Uses manual VWAP calculation (no Order Flow+ dependency). Produces fewer but higher-quality entries.

**Entry (Long):** Close > EMA 20 by 0.05%, MACD Histogram > 0, Stoch K 20-75, Above VWAP, Volume >= 1.1x SMA
**Entry (Short):** Mirror conditions below
**Exit:** MACD histogram reverses

**Key Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| EMA Distance Long | 0.05 | Min EMA distance for trend confirm |
| Stoch Long Low/High | 20 / 75 | Sweet zone bounds (long) |
| Stop Loss ATR | 1.2 | ATR stop loss |
| Trail Activation ATR | 1.0 | Trail activates after 1.0 ATR |

---

### NQVPPOCBounce (Volume Profile)

Detects price bouncing off the Volume Profile Point of Control (highest-volume price level). Uses manual POC calculation — volume distributed across tick-level price buckets per bar, reset each session (no Order Flow+ dependency).

**Entry (Long):** Low wick touches POC zone, Close > POC, Bullish candle, Body >= 35%, Volume >= 1.1x SMA
**Entry (Short):** High wick touches POC zone, Close < POC, Bearish candle
**Exit:** Mechanical only (stop loss, trailing stop, partial TP, time exit)

**Key Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| POC Zone Width ATR | 0.5 | Distance around POC for "near" |
| Min Body % | 35 | Candle body conviction |
| Stop Loss ATR | 1.3 | ATR stop loss |
| Trail Activation ATR | 0.9 | Trail activation distance |

### NQBuyAndHold (Benchmark)

Passive long-only benchmark for comparing active strategy performance against naive buy-and-hold. No indicators, stops, or trailing — just enter long and hold.

**Daily mode** (default, `HoldForever = false`):
- Enters long on the first bar at/after `SessionStart` each day
- Flattens at `EODTime` — same as all other strategies for fair comparison

**Hold forever mode** (`HoldForever = true`):
- Enters long on the very first bar, never exits
- Measures pure passive buy-and-hold across the entire backtest period

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| Contracts | 1 | Number of contracts |
| Hold Forever | false | True = never exit; False = daily cycle |
| Close EOD | true | Flatten before close (daily mode only) |
| EOD Time | 1610 | When to flatten (HHMM) |
| Session Start | 930 | Earliest entry time |

---

## Parameter Tuning Guide

### NQ vs MNQ Differences

Both NQ and MNQ have 0.25 point tick size. The only difference is contract value:
- **NQ**: $20 per point ($5 per tick)
- **MNQ**: $2 per point ($0.50 per tick)

All ATR-based parameters auto-scale since they use the instrument's native price. No adjustments needed between NQ and MNQ.

### Tuning Tips

1. **Stop Loss ATR**: If getting stopped out too often, widen by 0.1-0.2 ATR. NQ can be more volatile than SPY.
2. **Trail Activation ATR**: If trailing stop triggers too early, increase activation. If profits are running but reversing, decrease it.
3. **Cooldown Bars**: Increase if seeing too many consecutive losing trades (overtrading).
4. **Session Times**: NQ RTH is 9:30-16:15 ET. Default EOD flatten at 16:10 leaves 5 min buffer. ETH data may need adjusted session times.
5. **Volume thresholds**: NQ futures volume patterns differ from SPY ETF. Start with lower thresholds (0.8-1.0) and increase if entry frequency is too high.

### Shared Parameters (embedded in each strategy)

Each strategy contains these configurable parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Contracts | 1 | Number of contracts |
| Stop Loss ATR | varies | ATR-based stop loss |
| Trail Activation ATR | varies | ATR move before trailing starts |
| Trail Distance ATR | varies | Distance trail sits behind best price |
| Partial TP % | varies | % of position to close at TP target |
| Partial TP Target ATR | varies | ATR distance for partial TP |
| Max Bars In Trade | varies | Force close after N bars |
| Cooldown Bars | varies | Min bars between trades |
| Close EOD | true | Flatten before close |
| EOD Time | 1610 | When to flatten (HHMM) |
| Session Start | 930 | Earliest entry time |
| Session End | 1545 | Latest entry time |
| Avoid Open Start/End | 930/945 | Skip opening volatility |
| Avoid Midday Start/End | 1145/1315 | Skip midday chop |

## Architecture

Each strategy is **self-contained** — inheriting directly from `Strategy` with all shared mechanics embedded inline. This avoids NinjaTrader 8's code generation issues with abstract base classes.

```
Strategy (NinjaTrader built-in)
├── NQSessionRangeFade      (Mean Reversion / Fade)
├── NQBollingerDonchianSqueeze  (Breakout)
├── NQVwapBounceVolume      (Support/Resistance)
├── NQTripleConfirmation    (Trend / Confluence)
├── NQVPPOCBounce           (Volume Profile)
└── NQBuyAndHold            (Benchmark)
```

Each strategy contains the full state machine inline:
- `OnStateChange()` — initializes ATR, trade state, and strategy-specific indicators
- `OnBarUpdate()` — FLAT → cooldown → session → entry; IN POSITION → EOD → TP → stop → trail → signal exit → time exit
- `IsSessionOK()` — session time filter
- `FlattenPosition()` — flatten + record cooldown
- `LongEntryCondition()` / `ShortEntryCondition()` — strategy-specific entry logic
- `LongExitCondition()` / `ShortExitCondition()` — strategy-specific exit logic
