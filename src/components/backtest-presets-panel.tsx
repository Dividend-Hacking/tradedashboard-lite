/**
 * BacktestPresetsPanel
 *
 * UI affordance for the Backtesting tab's preset feature. Renders a single
 * row of controls:
 *   1. A dropdown of saved presets (alphabetical by name).
 *   2. LOAD — applies the selected preset to the dashboard.
 *   3. SAVE AS — prompts for a name, captures the current dashboard state.
 *   4. UPDATE — overwrites the selected preset with current state.
 *   5. DELETE — removes the selected preset (with a confirm).
 *
 * The panel is intentionally state-light: it owns the selected dropdown
 * value and the save-name input, but every persistence call goes back to
 * the dashboard via callbacks so the parent stays the source of truth for
 * what's "active right now". The panel re-reads from localStorage after
 * each mutation via the parent's onPresetsChange — a one-way refresh that
 * guarantees the visible list matches what's saved.
 */
"use client";

import { useState, useMemo } from "react";
import { BacktestPreset } from "@/lib/utils/backtest-presets";

interface BacktestPresetsPanelProps {
  /** Current saved presets, fed in by the parent so all callers see the
   *  same list reference and re-renders cascade naturally. */
  presets: BacktestPreset[];
  /** Called when the user clicks LOAD on the selected preset. The parent
   *  is responsible for applying the preset's strategy/params/rules/filters
   *  back into its own state — this component doesn't know about any of
   *  that. */
  onLoad: (preset: BacktestPreset) => void;
  /** Called when the user clicks SAVE AS with a non-empty name. The parent
   *  takes the snapshot of its current state and persists. */
  onSaveAs: (name: string) => void;
  /** Called when the user clicks UPDATE on a selected preset. The parent
   *  overwrites that preset's payload with current state. */
  onUpdate: (preset: BacktestPreset) => void;
  /** Called when the user confirms DELETE on a selected preset. */
  onDelete: (preset: BacktestPreset) => void;
}

export function BacktestPresetsPanel({
  presets,
  onLoad,
  onSaveAs,
  onUpdate,
  onDelete,
}: BacktestPresetsPanelProps) {
  // Currently-selected preset id in the dropdown. "" = no selection (the
  // initial placeholder option). Kept here rather than in the parent
  // because a "selected to act on" choice is purely UI state — the parent
  // doesn't need to know which row the user has highlighted.
  const [selectedId, setSelectedId] = useState<string>("");

  // Whether the inline "Save As" mini-form is open. Replaces the dropdown
  // row with a name input + Save/Cancel buttons. Kept inline (vs a modal)
  // so the user doesn't lose visual context of what they're saving.
  const [savingName, setSavingName] = useState<string>("");
  const [showNameInput, setShowNameInput] = useState<boolean>(false);

  // Transient confirmation flash for the EXPORT button. After a successful
  // clipboard copy we set this to the preset id and clear it after ~1.5s,
  // which swaps the button label from "EXPORT" to "COPIED ✓" so the user
  // sees the action landed without needing a toast system.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // TO NT8 button state — three-stage:
  //   null              → idle ("TO NT8")
  //   "running"         → in flight ("CONVERTING…"), button disabled
  //   { id, message }   → flash result for ~3s; "DEPLOYED ✓" or
  //                       "FAILED — see console" depending on error.
  const [convertState, setConvertState] = useState<
    null | "running" | { id: string; ok: boolean; message: string }
  >(null);

  // Sort by name for predictable dropdown order. Memoized so the sort
  // doesn't run on every keystroke in the name input.
  const sortedPresets = useMemo(
    () => [...presets].sort((a, b) => a.name.localeCompare(b.name)),
    [presets]
  );

  const selected = sortedPresets.find((p) => p.id === selectedId) ?? null;
  const hasSelection = selected !== null;

  const handleSaveSubmit = () => {
    const trimmed = savingName.trim();
    if (!trimmed) return;
    onSaveAs(trimmed);
    setSavingName("");
    setShowNameInput(false);
  };

  const handleDelete = () => {
    if (!selected) return;
    // Native confirm so we don't have to bring in a modal lib for a single
    // destructive action. Matches the "small but real safeguard" pattern
    // used elsewhere in the app for one-off deletions.
    const ok = window.confirm(
      `Delete preset "${selected.name}"? This can't be undone.`
    );
    if (!ok) return;
    onDelete(selected);
    setSelectedId("");
  };

  // Export the selected preset to the clipboard as pretty-printed JSON.
  // Used to hand a preset to NinjaScript ports, share it across machines,
  // or paste it into a backup. We copy the full preset object verbatim
  // (including id/createdAt/updatedAt) so a paste-back via an import flow
  // could be a clean round-trip later. Falls back to a textarea+execCommand
  // path on older browsers / non-secure contexts so the button still works
  // when the page isn't served over HTTPS (e.g. local dev).
  // ── TO NT8 — one-click convert + deploy ─────────────────────────────────
  // Posts the selected preset to /api/convert-to-nt8, which writes both:
  //   - ninjatrader/strategies/presets/<ClassName>.json (the preset config)
  //   - ninjatrader/strategies/<ClassName>.cs (a thin PresetStrategy subclass)
  // and then runs deploy-nt8.sh to mirror the files into the Parallels
  // shared folder NT8 reads. After this lands, the user only needs to F5
  // in NT8's NinjaScript Editor to compile — same workflow that running
  // ninjatrader/new-strategy.sh + deploy-nt8.sh manually would produce.
  //
  // Three-stage UI feedback via convertState:
  //   - "running"  → button disabled, label "CONVERTING…"
  //   - success    → flash "DEPLOYED ✓" for 3s, log nextSteps to console
  //   - failure    → flash "FAILED" for 3s, log full response to console
  // We don't surface a modal because the panel is meant to stay compact;
  // the next-step instructions go to the console where they're easy to
  // copy and where any deploy-nt8.sh stderr can be inspected.
  const handleConvertToNt8 = async () => {
    if (!selected) return;
    setConvertState("running");
    try {
      const resp = await fetch("/api/convert-to-nt8", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: selected, deploy: true }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.success) {
        // eslint-disable-next-line no-console
        console.error("[TO NT8] conversion failed", json);
        setConvertState({
          id: selected.id,
          ok: false,
          message: json.error ?? "Failed",
        });
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[TO NT8] ${selected.name} → ${json.className}.cs\n` +
            `Next steps:\n  ${(json.nextSteps as string[]).join("\n  ")}` +
            (json.deployOutput ? `\n\nDeploy output:\n${json.deployOutput}` : ""),
        );
        setConvertState({
          id: selected.id,
          ok: true,
          message: json.deployed ? "DEPLOYED ✓" : "WROTE FILES ✓",
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[TO NT8] request error", e);
      setConvertState({
        id: selected.id,
        ok: false,
        message: "REQUEST ERROR",
      });
    }
    // Clear the flash after 3s so subsequent clicks feel responsive.
    window.setTimeout(() => setConvertState(null), 3000);
  };

  const handleExport = async () => {
    if (!selected) return;
    const json = JSON.stringify(selected, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
      } else {
        const ta = document.createElement("textarea");
        ta.value = json;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedId(selected.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Last-resort fallback: dump it to a prompt so the user can copy
      // manually. Better than silently failing on a feature whose whole
      // job is to put text on the clipboard.
      window.prompt("Copy preset JSON:", json);
    }
  };

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          Presets
        </h3>
        <span className="text-xs text-muted-foreground">
          {presets.length === 0
            ? "No saved presets"
            : `${presets.length} saved`}
        </span>
      </div>

      {showNameInput ? (
        // ── SAVE AS inline form ─────────────────────────────────────
        // Replaces the controls row while the user names a new preset.
        // Enter submits; Escape cancels. Auto-focuses on mount via the
        // input element's autoFocus attribute so the user can start
        // typing immediately.
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveSubmit();
              else if (e.key === "Escape") {
                setShowNameInput(false);
                setSavingName("");
              }
            }}
            placeholder="Preset name (e.g. NQ trend, 9:30–11:30)"
            autoFocus
            className="flex-1 min-w-0 bg-card border border-card-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
          <button
            onClick={handleSaveSubmit}
            disabled={savingName.trim().length === 0}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              savingName.trim().length === 0
                ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
            }`}
          >
            Save
          </button>
          <button
            onClick={() => {
              setShowNameInput(false);
              setSavingName("");
            }}
            className="px-3 py-1.5 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        // ── Dropdown + action buttons ───────────────────────────────
        // Standard row layout: pick from the list, then act on it. SAVE AS
        // lives here too even though it doesn't need a selection — keeping
        // all preset ops in one row keeps the UI compact.
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="flex-1 min-w-0 bg-card border border-card-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          >
            <option value="">
              {sortedPresets.length === 0
                ? "— No presets yet, click SAVE AS to create one —"
                : "— Select a preset —"}
            </option>
            {sortedPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {/* LOAD — applies the selected preset to the dashboard. Only
              enabled with a selection. */}
          <button
            onClick={() => selected && onLoad(selected)}
            disabled={!hasSelection}
            title={
              hasSelection
                ? `Apply "${selected!.name}" to the strategy, rules, and filters`
                : "Select a preset to load"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              hasSelection
                ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            LOAD
          </button>

          {/* SAVE AS — opens the inline name input. Always enabled; if the
              user is mid-config and clicks this, they get to bookmark
              wherever they are right now. */}
          <button
            onClick={() => {
              setShowNameInput(true);
              // Pre-fill with selected name + " (copy)" if a preset is
              // active so the user has a sensible starting point for
              // forking an existing config.
              setSavingName(selected ? `${selected.name} (copy)` : "");
            }}
            title="Save the current strategy, rules, and filters as a new preset"
            className="px-3 py-1.5 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            SAVE AS
          </button>

          {/* UPDATE — overwrites the selected preset with current state.
              Disabled without a selection so it can't accidentally fire on
              a fresh dashboard. */}
          <button
            onClick={() => selected && onUpdate(selected)}
            disabled={!hasSelection}
            title={
              hasSelection
                ? `Overwrite "${selected!.name}" with the current configuration`
                : "Select a preset to update"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              hasSelection
                ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            UPDATE
          </button>

          {/* EXPORT — copies the selected preset's full JSON to the
              clipboard. Used for sharing across devices, archiving, or
              feeding the NinjaScript port pipeline. Label flashes to
              "COPIED ✓" for 1.5s on success so the user has visual
              feedback without a toast. */}
          <button
            onClick={handleExport}
            disabled={!hasSelection}
            title={
              hasSelection
                ? `Copy "${selected!.name}" as JSON to the clipboard`
                : "Select a preset to export"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              hasSelection
                ? "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            {copiedId && selected && copiedId === selected.id
              ? "COPIED ✓"
              : "EXPORT"}
          </button>

          {/* TO NT8 — convert the selected preset into a deployable NT8
              strategy and rsync the files to the VM in one shot. After the
              button finishes, the user only needs to F5 in NT8 NinjaScript
              Editor to compile. Disabled without a selection or while a
              convert is in flight. */}
          <button
            onClick={handleConvertToNt8}
            disabled={!hasSelection || convertState === "running"}
            title={
              hasSelection
                ? `Generate <ClassName>.cs + <ClassName>.json under ninjatrader/strategies/, then run deploy-nt8.sh. F5 in NT8 to compile after this finishes.`
                : "Select a preset to convert"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              !hasSelection || convertState === "running"
                ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                : convertState &&
                    typeof convertState === "object" &&
                    selected &&
                    convertState.id === selected.id
                  ? convertState.ok
                    ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                    : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-accent-green/10 text-accent-green hover:bg-accent-green/20"
            }`}
          >
            {convertState === "running"
              ? "CONVERTING…"
              : convertState &&
                  typeof convertState === "object" &&
                  selected &&
                  convertState.id === selected.id
                ? convertState.message
                : "TO NT8"}
          </button>

          {/* DELETE — confirm-gated. */}
          <button
            onClick={handleDelete}
            disabled={!hasSelection}
            title={
              hasSelection
                ? `Delete "${selected!.name}"`
                : "Select a preset to delete"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              hasSelection
                ? "bg-accent-red/10 text-accent-red hover:bg-accent-red/20"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            DELETE
          </button>
        </div>
      )}

      {/* Selected preset summary — shows what'll happen when the user
          hits LOAD. Helps when several presets share a strategy and the
          name alone isn't enough to disambiguate. Only renders when a
          preset is selected. */}
      {selected && !showNameInput && (
        <div className="mt-2 text-xs text-muted-foreground">
          Strategy: <span className="text-foreground">{selected.strategyId}</span>
          {" · "}
          Filters:{" "}
          <span className="text-foreground">
            {[
              selected.filters.time.enabled && "Time",
              selected.filters.adx.enabled && "ADX",
              selected.filters.atr.enabled && "ATR",
              selected.filters.trend.enabled && "Trend",
              selected.filters.bollinger.enabled && "Bollinger",
            ]
              .filter(Boolean)
              .join(", ") || "none"}
          </span>
          {" · "}
          Updated:{" "}
          <span className="text-foreground">
            {new Date(selected.updatedAt).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
