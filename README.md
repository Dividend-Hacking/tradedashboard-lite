# Trade Dashboard Lite

A local-first MNQ futures trading + backtesting dashboard. Includes a DSL
script editor, replay/playback, trade journaling, an Auto-trader, and
optional live NinjaTrader 8 streaming.

By default it runs **fully offline** with a local SQLite database — no
Supabase project required. Cloud mode (Supabase) is opt-in via the
**Settings** page once you've provisioned a project.

## What's in here

- **Dashboard / journal** (`/`) — Trades table, recent activity, journal.
- **Backtesting** (`/trade`) — DSL script editor + engine + tick-aware
  indicator library + interactive `/script-reference` docs.
- **Replay / practice** (`/replay`) — Tick-by-tick playback against
  historical sessions downloaded from NT8.
- **Auto-trader** (`/auto`) — Deploys backtest presets to NT8 for
  automated execution.
- **Settings** (`/settings`) — Cloud / Local toggle + NT8 endpoint config.

## Prerequisites

- Node.js 20+ (https://nodejs.org).
- C++ build tools (only because `better-sqlite3` is a native module):
  - **Windows**: install **Visual Studio Build Tools** with the
    *Desktop development with C++* workload selected
    (https://visualstudio.microsoft.com/downloads/, scroll down to
    "Tools for Visual Studio"). The older `windows-build-tools` npm
    package is deprecated and no longer works on Node 18+.
  - **macOS**: `xcode-select --install`.
- (Optional) NinjaTrader 8 — required for live streaming, automated
  execution, and tick-data downloads. **Launch NT8 once and let it
  finish its first compile** before deploying our AddOns: NT8 only
  creates the `Documents\NinjaTrader 8\bin\Custom\` subfolders during
  that initial run, and the deploy step writes into them.
- (Optional) A free Supabase project — only if you want to share state
  across machines.

## Quick start (Local mode, default)

```bash
git clone <this-repo> tradedashboard-lite
cd tradedashboard-lite
npm install
npm run dev
```

Open http://localhost:3000. The first run auto-creates the local
database at `~/.tradedashboard/local.db` and the tick-blob directory at
`~/.tradedashboard/data/ticks/`. The "Local" badge in the nav bar
confirms you're in local mode.

That's it — Trades, Backtesting, Replay, and Auto pages all work without
any further configuration.

## NinjaTrader integration (optional)

Local mode talks to NT8 over plain HTTP, so you only need this if you
want live trading, automated strategy deployment, or to download
historical / tick data from NT8 into the dashboard.

### Deploy the AddOns

**Mac (Parallels Desktop running NT8):**

```bash
cd ninjatrader && ./deploy-nt8.sh
```

This copies every AddOn, Indicator, DrawingTool, Strategy, and preset
JSON into the NT8 user folder via Parallels' shared `Documents`. After
it finishes, press **F5** in the NinjaScript Editor to compile.

**Windows (running NT8 natively):**

```powershell
cd ninjatrader
.\deploy-nt8.ps1
```

Same behavior as the Mac script — copies everything into
`%USERPROFILE%\Documents\NinjaTrader 8\bin\Custom\` and seeds
`mode.json` on first run. If PowerShell blocks the script with an
execution-policy error, run it once with:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-nt8.ps1
```

After it finishes, press **F5** in the NinjaScript Editor to compile.

**Manual fallback (Windows, if you'd rather not run the script):** copy
these into `Documents\NinjaTrader 8\bin\Custom\`:

- `ninjatrader\AddOns\*.cs` and `ninjatrader\AddOns\mode.example.json`
  → `bin\Custom\AddOns\` (rename `mode.example.json` to `mode.json`)
- `ninjatrader\Indicators\*.cs` → `bin\Custom\Indicators\`
- `ninjatrader\DrawingTools\*.cs` → `bin\Custom\DrawingTools\`
- `ninjatrader\strategies\*.cs` → `bin\Custom\Strategies\`
- `ninjatrader\strategies\presets\*.json` → `bin\Custom\presets\`

Then press **F5** in the NinjaScript Editor to compile.

### Point NT8 at the dashboard (Local mode)

The NT8 AddOns poll `mode.json` every 15 s for the dashboard URL.

1. Find the dashboard's reachable URL from NT8:
   - **Same Windows PC for both NT8 and the dashboard** — paste
     `http://localhost:3000`.
   - **Mac/Parallels** — usually `http://10.211.55.2:3000` (the
     Parallels Shared host gateway).
   - **Separate machines on a LAN** — the dashboard host's LAN IP, e.g.
     `http://192.168.1.50:3000`. The dev server already binds
     `0.0.0.0:3000`, so LAN access works without extra config (just
     allow port 3000 through the firewall).
2. Open `/settings` in the dashboard, paste the URL into the
   "NT8 endpoint" field, and click Save. The dashboard mirrors
   `mode.json` to NT8 automatically; AddOns pick up the new URL within
   ~15 s.
3. **Verify**: in NT8 → Control Center → New → NinjaScript Output. You
   should see log lines from `ModeConfig` / `LiveBridge` /
   `DataExporter` reporting the endpoint they read. Once those show
   your URL, the link is live.

## Cloud mode (opt-in, optional)

Local mode is sufficient for most workflows. Use cloud mode if you want
the same trades/zones/presets across multiple machines.

1. Sign up at https://supabase.com/dashboard, create a new project,
   and grab `Project URL` + `anon public` key from
   **Project Settings → API**.
2. Open the Supabase SQL Editor and run:
   - `supabase/migrations/0001_init.sql` (creates ~28 tables, indexes,
     seed `zone_sections` row)
   - `supabase/migrations/0002_local_mode_parity.sql` (adds tick-data
     columns + granularity)
   Both are idempotent.
3. Copy `.env.example` to `.env.local` and paste the Supabase values.
4. (Optional, for cloud-mode NT8) create
   `Documents\NinjaTrader 8\livebridge.config.json`:
   ```json
   {
     "supabaseUrl": "https://your-project-ref.supabase.co",
     "supabaseAnonKey": "your-anon-key"
   }
   ```
5. Restart `npm run dev` and visit `/settings` → flip the toggle to
   **Cloud**. The badge in the nav bar updates.

## DSL backtesting

Example scripts live in `backtests/scripts/`:

- `default.dsl` — minimal starting point
- `range_break_v4.dsl` — opening-range break
- `range_break_reversal_v5.dsl` — failed breakout reversal
- `bid_ask_delta_v1.dsl` — tick-based order-flow delta
- `volume_profile_v1.dsl` — POC / VAH / VAL volume-profile entries

The full DSL grammar, indicator catalogue (incl. tick-resolution
indicators), and signal/filter semantics are documented in
[`backtests/INSTRUCTIONS.md`](./backtests/INSTRUCTIONS.md) and on the
in-app `/script-reference` page.

## Project layout

```
src/
  app/                 Next.js App Router routes
    page.tsx           home (Trades + Zones tabs)
    trade/             live trading + chart
    auto/              auto-trader command center
    replay/            replay/playback + practice
    settings/          mode toggle + NT8 endpoint
    script-reference/  DSL docs (auto-generated from indicator library)
    zones/             trade-zone server actions
    api/local/         local-mode SQLite endpoints (PostgREST shim)
    api/nt8/           NT8 LiveBridge endpoints (per-table CRUD)
  components/          React components
  lib/
    mode.ts            cloud/local toggle source of truth
    local/             SQLite client + repos + migrations
    store/             mode-aware store abstraction
    indicators/        bar + tick indicators
    utils/             DSL parser, evaluators, backtest engine, NT8 transpiler
    supabase/          Supabase clients (cloud mode only)

scripts/
  dev.mjs              spawns next dev + ws-proxy together
  ws-proxy.mjs         localhost pass-through to LiveBridge

ninjatrader/
  deploy-nt8.sh        Mac/Parallels one-shot deploy
  deploy-nt8.ps1       Windows PowerShell one-shot deploy
  AddOns/              LiveBridge, DslRuntime, ModeConfig, etc.
  Indicators/          Custom NT8 indicators
  DrawingTools/        Custom NT8 drawing tools
  strategies/          Hand-coded + transpiled NT8 strategies
    presets/           Preset JSONs consumed by PresetStrategy

backtests/
  INSTRUCTIONS.md      DSL grammar + indicator reference
  scripts/             Example .dsl scripts
```

## Troubleshooting

- **"Failed to load trades"** in cloud mode → your Supabase env vars are
  missing or wrong, or the migrations didn't run. Check `.env.local`
  and re-run both SQL files. In local mode, this means
  `~/.tradedashboard/local.db` is unwritable — verify your home
  directory is writable.
- **Native module error on `npm install`** (`better-sqlite3` build
  failure) → install C++ build tools as described under
  [Prerequisites](#prerequisites), delete `node_modules` and
  `package-lock.json`, then re-run `npm install`. On Windows, restart
  PowerShell after installing Build Tools so `cl.exe` is on PATH.
- **`.\deploy-nt8.ps1` blocked with "running scripts is disabled on
  this system"** → run it once with `powershell -ExecutionPolicy
  Bypass -File .\deploy-nt8.ps1`, or set per-user policy with
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **`deploy-nt8.sh` / `deploy-nt8.ps1` errors with "NinjaTrader custom
  folders not found"** → NT8 hasn't been compiled at least once. Open
  NT8 → NinjaScript Editor → F5, then re-run the script. (Mac users
  also confirm Parallels Documents mirroring is enabled.)
- **NT8 AddOns can't reach the dashboard** → confirm the URL in
  `/settings` matches what NT8 can reach. From the NT8 box, open the
  URL in a browser; if it doesn't load, check Windows Firewall (allow
  inbound on port 3000) or your router. The dev server binds
  `0.0.0.0:3000` so LAN/VM access works once the firewall lets it
  through.
- **NT8 Output tab is silent after a deploy** → AddOns weren't loaded.
  Make sure F5 compiled cleanly (Output tab shows no red errors). If a
  recompile fails because NT8 is still holding old DLLs, close all NT8
  charts/strategies, recompile, reopen.
