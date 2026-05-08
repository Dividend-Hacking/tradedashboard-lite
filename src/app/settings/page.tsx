/**
 * Settings page — toggle Cloud vs Local mode and configure the NT8
 * endpoint URL.
 *
 * Server component reads the on-disk config and passes it to the client
 * form. No data is loaded from Supabase or SQLite here; the toggle is
 * purely about the persistent mode flag at ~/.tradedashboard/config.json.
 */

import { readMode } from "@/lib/mode";
import SettingsClient from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cfg = await readMode();
  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-foreground mb-1">Settings</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Configure the data backend used by NT8 downloads, trade tracking, and
        the backtesting dashboard.
      </p>
      <SettingsClient
        initialMode={cfg.mode}
        initialEndpoint={cfg.nt8Endpoint}
      />
    </div>
  );
}
