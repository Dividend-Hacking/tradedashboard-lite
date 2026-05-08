/**
 * Mode — Cloud vs Local mode source of truth.
 *
 * The web app stores a single JSON config at ~/.tradedashboard/config.json
 * that records the active mode and (when local) the URL the NT8 AddOns
 * should hit. writeMode() additionally mirrors the file to NT8's shared
 * folder at ~/Documents/NinjaTrader 8/bin/Custom/AddOns/mode.json so the
 * AddOns can pick up the change on their next 15s polling tick.
 *
 * Cloud mode preserves the original behavior — every in-scope table goes
 * through Supabase, just like before. Local mode routes everything except
 * the AI assistant to a local SQLite database (~/.tradedashboard/local.db)
 * and a tick-blob directory (~/.tradedashboard/data/ticks/).
 *
 * readMode() is request-cached via React's cache() so multiple lookups
 * inside a single server render hit disk once. writeMode() is a one-shot
 * mutation and is not cached.
 *
 * If the config file is missing or malformed, we default to "local" so
 * fresh installs work with zero Supabase setup. Cloud is opt-in via
 * the settings page once the user has provisioned a Supabase project.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cache } from "react";

export type Mode = "cloud" | "local";

export interface ModeConfig {
  mode: Mode;
  /** URL the NT8 AddOns should hit when in local mode. Pasted by the user
   *  in the settings page; usually the Parallels host gateway IP and dev
   *  server port (e.g. http://10.211.55.2:3000). Empty in cloud mode. */
  nt8Endpoint: string;
}

const DEFAULT_CONFIG: ModeConfig = {
  mode: "local",
  nt8Endpoint: "http://10.211.55.2:3000",
};

/** Absolute path to the web-side config file. */
export function configPath(): string {
  return path.join(os.homedir(), ".tradedashboard", "config.json");
}

/** Absolute path to the NT8-side mirror written by writeMode(). NT8's
 *  ModeConfig.cs reads from this exact location (it lives next to the
 *  deployed AddOn DLLs in the Parallels-shared NT8 user data directory). */
function nt8MirrorPath(): string {
  return path.join(
    os.homedir(),
    "Documents",
    "NinjaTrader 8",
    "bin",
    "Custom",
    "AddOns",
    "mode.json"
  );
}

/**
 * Read the current mode config. Cached per request via React's cache()
 * helper so multiple readMode() calls during the same server render
 * hit disk once. Returns DEFAULT_CONFIG (local) if the file is missing
 * or unreadable — fresh installs run fully offline by default.
 */
export const readMode = cache(async (): Promise<ModeConfig> => {
  try {
    const raw = await fs.promises.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ModeConfig>;
    const mode = parsed.mode === "local" || parsed.mode === "cloud" ? parsed.mode : "local";
    const nt8Endpoint =
      typeof parsed.nt8Endpoint === "string" ? parsed.nt8Endpoint : DEFAULT_CONFIG.nt8Endpoint;
    return { mode, nt8Endpoint };
  } catch {
    return DEFAULT_CONFIG;
  }
});

/**
 * Write the mode config to disk and mirror to NT8's shared folder.
 *
 * Two writes: the canonical web-side file at ~/.tradedashboard/config.json
 * and a mirror at the NT8 bin/Custom/AddOns/mode.json. The mirror is
 * what NT8's polling AddOns read; the canonical file is what the web
 * app reads on every server render. Mirror failures are non-fatal and
 * logged — the web app's mode flip still takes effect even if the NT8
 * folder isn't writable (e.g. Parallels not running).
 */
export async function writeMode(cfg: ModeConfig): Promise<void> {
  const json = JSON.stringify(cfg, null, 2);

  // Web-side canonical file.
  await fs.promises.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.promises.writeFile(configPath(), json);

  // NT8-side mirror — best effort.
  try {
    await fs.promises.mkdir(path.dirname(nt8MirrorPath()), { recursive: true });
    await fs.promises.writeFile(nt8MirrorPath(), json);
  } catch (err) {
    console.warn("[mode] could not mirror mode.json to NT8 shared folder:", err);
  }
}
