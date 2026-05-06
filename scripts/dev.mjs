#!/usr/bin/env node
/**
 * Dev supervisor — boots `next dev` and (optionally) the local ws-proxy as a
 * single `npm run dev` so the user never has to remember a second terminal.
 *
 * Why this exists:
 *   The dashboard's live trader needs a WebSocket connection to NinjaTrader's
 *   LiveBridge AddOn. Some browser/network combinations refuse to open a
 *   ws:// connection from http://localhost:3000 to a private-range IP, so we
 *   run a tiny pass-through proxy on ws://localhost:8766. Bundling its
 *   lifecycle into `npm run dev` makes the whole flow zero-setup when the
 *   user has NT8 wired up — and silently skipping it when they don't keeps
 *   the dev server starting fine for users running just the dashboard.
 *
 * Behavior:
 *   - ws-proxy is only spawned when a LiveBridge URL is detected in
 *     .env.local or process.env. Without it, only Next.js runs.
 *   - Both children inherit stdio so their logs interleave into this terminal.
 *   - If a required child exits, we tear the others down and exit with the
 *     same code. ws-proxy is treated as optional — its death does not kill
 *     Next.js (you can configure LiveBridge later and just restart).
 *   - SIGINT / SIGTERM are forwarded to all children before exiting.
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Minimal .env loader — reads KEY=VALUE lines from .env.local so the
 * supervisor can decide whether ws-proxy is needed before spawning it.
 * Next.js itself still owns the loading for the actual app process.
 */
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip a single pair of surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const envLocal = loadEnvFile(resolve(process.cwd(), ".env.local"));

// LiveBridge is on if either env var has a non-empty value.
const liveBridgeUrl =
  process.env.LIVEBRIDGE_WS_URL ||
  envLocal.LIVEBRIDGE_WS_URL ||
  process.env.NEXT_PUBLIC_LIVEBRIDGE_WS_URL ||
  envLocal.NEXT_PUBLIC_LIVEBRIDGE_WS_URL ||
  "";

/** @type {Array<{ name: string, proc: import("child_process").ChildProcess, optional: boolean }>} */
const children = [];
let shuttingDown = false;

function start(name, args, { optional = false } = {}) {
  const proc = spawn(npm, ["run", "--silent", ...args], {
    stdio: "inherit",
    env: process.env,
  });
  children.push({ name, proc, optional });

  proc.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (optional) {
      console.log(`[dev] ${name} exited (code=${code} signal=${signal}) — keeping siblings alive (optional)`);
      return;
    }
    console.log(`[dev] ${name} exited (code=${code} signal=${signal}) — shutting down siblings`);
    shutdown(code ?? 0);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { proc } of children) {
    if (proc.exitCode === null && !proc.killed) {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT",  () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (liveBridgeUrl) {
  // LiveBridge is configured — start the proxy first so by the time Next.js
  // is ready to serve and the browser auto-connects, the proxy is already up.
  start("ws-proxy", ["ws-proxy"], { optional: true });
} else {
  console.log("[dev] LIVEBRIDGE_WS_URL not set — skipping ws-proxy. " +
              "Set it in .env.local once you've set up NinjaTrader's LiveBridge AddOn.");
}
start("next", ["dev:next"]);
