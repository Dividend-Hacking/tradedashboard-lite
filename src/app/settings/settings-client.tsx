"use client";

/**
 * Settings form — radio buttons for Cloud / Local mode plus a free-text
 * field for the NT8 endpoint URL (only meaningful in local mode).
 *
 * On submit the form calls `setModeAction`, which writes the config and
 * revalidates every route. The form-level local state ('saved'/'error')
 * gives the user immediate feedback without waiting for the page reload.
 */

import { useState, type FormEvent } from "react";
import type { Mode, ModeConfig } from "@/lib/mode";
import { setModeAction } from "./actions";

interface Props {
  initialMode: Mode;
  initialEndpoint: string;
}

export default function SettingsClient({ initialMode, initialEndpoint }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [endpoint, setEndpoint] = useState<string>(initialEndpoint);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const dirty = mode !== initialMode || endpoint !== initialEndpoint;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const cfg: ModeConfig = { mode, nt8Endpoint: endpoint };
      await setModeAction(cfg);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <fieldset>
        <legend className="text-sm font-semibold text-foreground mb-2">Mode</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-3 cursor-pointer p-3 rounded border border-card-border hover:border-muted">
            <input
              type="radio"
              name="mode"
              value="cloud"
              checked={mode === "cloud"}
              onChange={() => setMode("cloud")}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm text-foreground">Cloud</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                NT8 downloads, trade tracking, and the backtesting dashboard
                use the existing Supabase database. Default behavior.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer p-3 rounded border border-card-border hover:border-muted">
            <input
              type="radio"
              name="mode"
              value="local"
              checked={mode === "local"}
              onChange={() => setMode("local")}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm text-foreground">Local</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                The same data flows go through a SQLite database at{" "}
                <code className="text-xs">~/.tradedashboard/local.db</code>
                {" "}with tick blobs in{" "}
                <code className="text-xs">~/.tradedashboard/data/ticks/</code>.
                Starts empty — your cloud data is preserved and accessible by
                switching back. The AI assistant always uses Supabase
                regardless of mode.
              </div>
            </div>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-foreground mb-2">
          NT8 Endpoint URL
        </legend>
        <p className="text-xs text-muted-foreground mb-2">
          The URL the NinjaTrader AddOns should hit when in local mode. From a
          Parallels VM, the host Mac is usually reachable at{" "}
          <code className="text-xs">http://10.211.55.2:3000</code>. The web app
          mirrors this into{" "}
          <code className="text-xs">~/Documents/NinjaTrader 8/bin/Custom/AddOns/mode.json</code>
          {" "}so the AddOns pick it up on their next 15s poll.
        </p>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="http://10.211.55.2:3000"
          className="w-full px-3 py-1.5 text-sm bg-card border border-card-border rounded text-foreground"
        />
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || status === "saving"}
          className="px-4 py-1.5 text-sm rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        {status === "saved" && dirty === false && (
          <span className="text-xs text-muted-foreground">
            Saved. Reload pages to apply the new mode.
          </span>
        )}
        {status === "error" && (
          <span className="text-xs text-accent-red">
            Failed: {error}
          </span>
        )}
      </div>
    </form>
  );
}
