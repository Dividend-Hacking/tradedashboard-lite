#!/usr/bin/env node
/**
 * Dev supervisor — boots `next dev` and the local ws-proxy as a single
 * `npm run dev` so the user never has to remember a second terminal.
 *
 * Why this exists:
 *   The dashboard's live trader needs a WebSocket connection to NT8 inside
 *   the Parallels VM. Some browser/network combinations refuse to open a
 *   ws:// connection from http://localhost:3000 to a private-range IP, so
 *   we run a tiny pass-through proxy on ws://localhost:8766 (see
 *   scripts/ws-proxy.mjs). Bundling its lifecycle into `npm run dev` makes
 *   the whole flow zero-setup.
 *
 * Behavior:
 *   - Starts both children with stdio:inherit so their logs interleave
 *     directly into this terminal, prefixed by which process produced them.
 *   - If either child exits, we tear the other down and exit with the same
 *     code — keeps the supervisor and its children's lifetimes coupled.
 *   - SIGINT (Ctrl-C) and SIGTERM are forwarded to both children before
 *     exiting, so nothing is left dangling on the system.
 */

import { spawn } from "child_process";

// Use `npm run` for both children so PATH is set up the same way the user
// would get it from a regular `npm run` invocation (node_modules/.bin in
// PATH, lifecycle env vars present). The .cmd suffix is needed on Windows.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** @type {Array<{ name: string, proc: import("child_process").ChildProcess }>} */
const children = [];
let shuttingDown = false;

/** Spawn one named child and register it for cleanup on shutdown. */
function start(name, args) {
  const proc = spawn(npm, ["run", "--silent", ...args], {
    stdio: "inherit",
    env: process.env,
  });
  children.push({ name, proc });

  proc.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[dev] ${name} exited (code=${code} signal=${signal}) — shutting down siblings`);
    shutdown(code ?? 0);
  });
}

/** Kill every still-running child, then exit the supervisor. */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { proc } of children) {
    if (proc.exitCode === null && !proc.killed) {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  // Give children a beat to flush their stdio before we exit.
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT",  () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Order matters slightly: start the proxy first so by the time Next.js is
// ready to serve and the browser auto-connects, the proxy is already up.
start("ws-proxy",    ["ws-proxy"]);
start("next",        ["dev:next"]);
