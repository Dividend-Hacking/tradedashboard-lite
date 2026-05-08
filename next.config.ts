import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native Node module. Without this opt-out the bundler
  // tries to inline its prebuilt .node binary and the build fails. With it
  // listed here, Next requires() the package at runtime instead. Required
  // for /api/local/* and /api/nt8/* routes that talk to the local SQLite DB.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
