import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native Node module. Without this opt-out the bundler
  // tries to inline its prebuilt .node binary and the build fails. With it
  // listed here, Next requires() the package at runtime instead. Required
  // for /api/local/* and /api/nt8/* routes that talk to the local SQLite DB.
  serverExternalPackages: ["better-sqlite3"],
  // Silence Next 16's per-request "GET /api/... 200 in Xms" dev logs.
  // The realtime client and NT8 LiveBridge poll several endpoints on a tight
  // interval, which floods the terminal and hides anything else useful.
  // Compile errors, warnings, and explicit console.log output are unaffected.
  logging: {
    incomingRequests: false,
  },
};

export default nextConfig;
