# Trade Dashboard Lite

A stripped-down trading dashboard built around backtesting, replay/playback,
trade journaling, and (optionally) live NinjaTrader 8 streaming.

Single-user by design — each install points at its own Supabase project.

## What's in here

- **Live trading dashboard** (`/`) — Trades table + journal. Streams live bars
  from NinjaTrader if the LiveBridge AddOn is configured, otherwise just shows
  recorded trades.
- **Backtesting** (`/trade`) — DSL script editor + backtest engine + script
  reference page (`/script-reference`).
- **Replay / playback** (`/replay`) — Practice mode against historical sessions.

## Prerequisites

- Node.js 20+
- A free Supabase project (https://supabase.com/dashboard)
- (Optional) NinjaTrader 8 on a Windows machine if you want live streaming

## Setup

### 1. Clone and install

```bash
git clone <this-repo> tradedashboard-lite
cd tradedashboard-lite
npm install
```

### 2. Create your Supabase project

1. Sign up at https://supabase.com/dashboard and create a new project.
2. Once it provisions, go to **Project Settings → API** and copy:
   - `Project URL`
   - `anon public` key
3. Copy `.env.example` to `.env.local` and paste those values:
   ```bash
   cp .env.example .env.local
   ```

### 3. Apply the database schema

Open the Supabase SQL Editor (left sidebar in the dashboard) and paste the
contents of `supabase/migrations/0001_init.sql`. Click **Run**.

That creates ~28 tables, sequences, indexes, and a single seed row in
`zone_sections`. The script is idempotent, so re-running it is safe.

### 4. Run the dashboard

```bash
npm run dev
```

Open http://localhost:3000. The Trades and Backtesting tabs should both load.
Without NinjaTrader configured, live streaming will be idle — that's expected.

## NinjaTrader integration (optional)

You only need this if you want live bar streaming, position state, and
trade-completion sync from NT8 into the dashboard.

### Install the AddOns

1. On your Windows / NT8 machine, copy these directories into
   `Documents\NinjaTrader 8\bin\Custom\`:
   - `ninjatrader/AddOns/*.cs` → `bin\Custom\AddOns\`
   - `ninjatrader/Indicators/*.cs` → `bin\Custom\Indicators\`
   - `ninjatrader/DrawingTools/*.cs` → `bin\Custom\DrawingTools\`
   - Strategies you want to use from `ninjatrader/strategies/*.cs` →
     `bin\Custom\Strategies\`
2. In NT8, open the NinjaScript Editor and press **F5** to compile. Resolve
   any errors and recompile.

### Create the LiveBridge config file

The AddOns read your Supabase URL/key from a JSON file at runtime. Create
`Documents\NinjaTrader 8\livebridge.config.json`:

```json
{
  "supabaseUrl": "https://your-project-ref.supabase.co",
  "supabaseAnonKey": "your-anon-key"
}
```

Use the same URL + anon key you put in `.env.local`.

### Point the dashboard at LiveBridge

LiveBridge listens on port 8765 by default. Find the Windows machine's IP
(LAN address — `ipconfig` from a Windows shell), then in `.env.local`:

```
NEXT_PUBLIC_LIVEBRIDGE_WS_URL=ws://192.168.1.50:8765
LIVEBRIDGE_WS_URL=ws://192.168.1.50:8765
```

Restart `npm run dev`. The Trades tab's "Live" panel should now show the
WebSocket as connected and start streaming bars.

## Project layout

```
src/
  app/                 Next.js App Router routes
    page.tsx           home (Trades + Backtesting tabs)
    trade/             backtesting UI
    replay/            replay/playback UI
    script-reference/  DSL docs
    api/               server-side endpoints (scripts, replay-progress, NT8 export)
  components/          React components
  lib/                 Shared utilities (Supabase clients, indicators, backtest engine)
  types/               Shared TypeScript types
  hooks/               React hooks (chart drawings, indicators, alerts)

scripts/
  dev.mjs              Spawns next dev + ws-proxy together
  ws-proxy.mjs         localhost passthrough to LiveBridge

ninjatrader/
  AddOns/              C# AddOns for NT8 (LiveBridge, SupabaseWriter, etc.)
  Indicators/          Custom NT8 indicators
  DrawingTools/        Custom NT8 drawing tools
  strategies/          Hand-coded NT8 strategies

supabase/
  migrations/0001_init.sql   Initial schema
```

## Troubleshooting

- **"Failed to load trades"** on the home page → your Supabase env vars are
  missing or wrong, or the schema migration didn't run. Check `.env.local`
  and re-run the SQL from `supabase/migrations/0001_init.sql`.
- **Live tab shows "disconnected"** → either `NEXT_PUBLIC_LIVEBRIDGE_WS_URL`
  is unset, the URL is wrong, or LiveBridge isn't running on the NT8 box.
  You can also enter the URL manually via the gear icon in the dashboard.
- **AddOns log "LiveBridgeConfig: file not found"** in NT8's Output tab →
  create `Documents\NinjaTrader 8\livebridge.config.json` per the section above.
