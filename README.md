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

- Node.js 20+
- (Optional) NinjaTrader 8 on a Windows machine — required for live
  streaming, automated execution, and tick-data downloads.
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

**Windows (running NT8 natively):** copy these into
`Documents\NinjaTrader 8\bin\Custom\`:

- `ninjatrader/AddOns/*.cs` and `ninjatrader/AddOns/mode.example.json`
  → `bin\Custom\AddOns\` (rename `mode.example.json` to `mode.json`)
- `ninjatrader/Indicators/*.cs` → `bin\Custom\Indicators\`
- `ninjatrader/DrawingTools/*.cs` → `bin\Custom\DrawingTools\`
- `ninjatrader/strategies/*.cs` → `bin\Custom\Strategies\`
- `ninjatrader/strategies/presets/*.json` → `bin\Custom\presets\`

Then press **F5** in the NinjaScript Editor to compile.

### Point NT8 at the dashboard (Local mode)

The NT8 AddOns poll `mode.json` every 15 s for the dashboard URL.

1. Find the dashboard's reachable IP from NT8:
   - Mac/Parallels: usually `http://10.211.55.2:3000` (the Parallels
     Shared host gateway).
   - Windows: `http://localhost:3000` if the dashboard runs on the same
     box; otherwise the dashboard host's LAN IP.
2. Open `/settings` in the dashboard, paste the URL into the
   "NT8 endpoint" field, and click Save. The dashboard mirrors
   `mode.json` to NT8 automatically; AddOns pick up the new URL within
   ~15 s.
3. NT8's Output tab will show the AddOns connecting and streaming.

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
  failure) → install your platform's C++ build tools
  (`xcode-select --install` on macOS;
  `npm install --global windows-build-tools` on Windows) and retry.
- **NT8 AddOns can't reach the dashboard** → confirm the URL in
  `/settings` matches what NT8 can reach. From the NT8 box, open the
  URL in a browser; if it doesn't load, check firewall rules. The dev
  server binds `0.0.0.0:3000` so LAN/VM access works out of the box.
- **`./deploy-nt8.sh` errors with "NinjaTrader custom folders not
  found"** → either Parallels Documents mirroring is off or NT8 hasn't
  been compiled at least once. Open NT8 → NinjaScript Editor → F5 once
  to create the folders, then re-run the script.
