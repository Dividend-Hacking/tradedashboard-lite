#!/usr/bin/env node
/**
 * Tiny WebSocket pass-through proxy.
 *
 * Listens on ws://localhost:LISTEN_PORT and forwards every frame in both
 * directions to TARGET (NT8's LiveBridge running inside the Parallels VM).
 *
 * Why this exists:
 *   Some browsers / extensions / private-network policies refuse to open a
 *   plain ws:// connection from http://localhost:3000 to a private-range IP
 *   like 10.211.55.3, even when the TCP path is provably reachable (verified
 *   via `nc` and a manual `curl` Upgrade handshake — both succeed). Routing
 *   the connection through localhost:8766 makes browser→target a same-origin-
 *   ish localhost-to-localhost call, which sidesteps every browser policy
 *   that's been blocking us.
 *
 * Usage:
 *   npm run ws-proxy                                  # uses defaults
 *   node scripts/ws-proxy.mjs ws://10.211.55.3:8765   # override target
 *   node scripts/ws-proxy.mjs ws://1.2.3.4:8765 9000  # override target + port
 *
 * Env overrides (used when argv not given):
 *   LIVEBRIDGE_WS_URL — upstream target (default ws://10.211.55.3:8765)
 *   WS_PROXY_PORT     — local listen port (default 8766)
 *
 * Dependencies:
 *   `ws` — already present transitively via @supabase/realtime-js, so no
 *   extra install is needed. Node's resolver finds it in node_modules.
 */

import { WebSocketServer, WebSocket } from "ws";

const TARGET = process.argv[2] || process.env.LIVEBRIDGE_WS_URL || "ws://10.211.55.3:8765";
const PORT = Number(process.argv[3] || process.env.WS_PROXY_PORT || 8766);

// Bind explicitly to 127.0.0.1 (not 0.0.0.0) so the proxy is unreachable from
// the LAN — it's only meant for the local browser. This also makes the
// browser's "localhost" check on the URL trivially true.
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
console.log(`[ws-proxy] listening on ws://localhost:${PORT} → ${TARGET}`);

wss.on("connection", (client) => {
  console.log("[ws-proxy] client connected");

  // Open the upstream connection to NT8 immediately. Anything the browser
  // sends before upstream is ready gets queued and flushed on `open`.
  const upstream = new WebSocket(TARGET);
  let upstreamOpen = false;
  /** @type {Array<{ data: import("ws").RawData, isBinary: boolean }>} */
  const queue = [];

  // ── upstream → client ──────────────────────────────────────────────
  upstream.on("open", () => {
    upstreamOpen = true;
    // Flush any frames the browser sent during the upstream handshake window.
    const pending = queue.splice(0);
    for (const m of pending) upstream.send(m.data, { binary: m.isBinary });
  });
  // CRITICAL: forward the isBinary flag. `ws` v8 always delivers `data` as a
  // Buffer regardless of frame type — if we don't tell `send` it was originally
  // a text frame, it ships it as binary, and the browser surfaces event.data
  // as a Blob. The live-trader expects strings (it does data.charCodeAt(9)
  // for fast tick parsing) and crashes on Blobs.
  upstream.on("message", (data, isBinary) => {
    try { client.send(data, { binary: isBinary }); } catch { /* client gone */ }
  });
  upstream.on("close", () => {
    try { client.close(); } catch { /* already closed */ }
  });
  upstream.on("error", (e) => {
    console.error("[ws-proxy] upstream error:", e.message);
    try { client.close(); } catch { /* already closed */ }
  });

  // ── client → upstream ──────────────────────────────────────────────
  client.on("message", (data, isBinary) => {
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else queue.push({ data, isBinary });
  });
  client.on("close", () => {
    console.log("[ws-proxy] client disconnected");
    try { upstream.close(); } catch { /* already closed */ }
  });
  client.on("error", () => {
    try { upstream.close(); } catch { /* already closed */ }
  });
});

wss.on("error", (e) => {
  console.error("[ws-proxy] server error:", e.message);
  process.exit(1);
});
