/**
 * BacktestPresetsPanel
 *
 * UI affordance for the Backtesting tab's preset feature. Renders a single
 * row of controls plus a search/filter bar:
 *   1. A bucket-filter dropdown + a free-text search input.
 *   2. A dropdown of presets matching the active filter+search, alphabetical.
 *   3. LOAD — applies the selected preset to the dashboard.
 *   4. SAVE AS — prompts for a name, captures the current dashboard state.
 *   5. UPDATE — overwrites the selected preset with current state.
 *   6. EXPORT — copies the preset JSON to the clipboard.
 *   7. TO NT8 — convert + deploy the preset to NinjaTrader 8.
 *   8. ADVANCE — moves the preset one stage forward in the pipeline.
 *   9. FAIL — moves the preset to the Failed bucket.
 *   10. DELETE — removes the selected preset (with a confirm).
 *
 * The panel is intentionally state-light: it owns the selected dropdown
 * value, the save-name input, and the local search/filter strings, but
 * every persistence call goes back to the dashboard via callbacks so the
 * parent stays the source of truth for what's "active right now". The
 * panel re-reads from localStorage after each mutation via the parent's
 * onPresetsChange — a one-way refresh that guarantees the visible list
 * matches what's saved.
 */
"use client";

import { memo, useState, useMemo } from "react";
import {
  BacktestPreset,
  PIPELINE_BUCKETS,
  PIPELINE_BUCKET_LABELS,
  type PipelineBucket,
} from "@/lib/utils/backtest-presets";

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
  /** Called when the user clicks ADVANCE (move forward one pipeline stage)
   *  or FAIL (jump to the Failed bucket). The parent persists via
   *  setPresetBucket and refreshes the list. */
  onMoveBucket: (preset: BacktestPreset, bucket: PipelineBucket) => void;
  /** Live DSL script text from the editor — overrides `selected.script`
   *  when the user clicks TO NT8. Without this, the API receives only
   *  what was last saved (or nothing for older presets) and silently
   *  falls back to the legacy strategyId template, dropping the
   *  script's `filters.X = Y` directives. Always pass the editor's
   *  current value so the export reflects unsaved changes too. */
  liveScript?: string;
  /** Live param metadata, same rationale as liveScript. */
  liveParamMeta?: BacktestPreset["paramMeta"];
  /** Live SimRules from the dashboard's rules editor — overrides
   *  `selected.rules` for TO NT8. Without this, /api/convert-to-nt8
   *  bakes the SAVED preset's rules into the C# file even after the
   *  user has edited cooldown / fillMode / etc. in the dashboard,
   *  causing NT8 to drift silently from the dashboard backtest. */
  liveRules?: BacktestPreset["rules"];
  /** Live PresetFilters from the dashboard, same rationale as
   *  liveRules. The transpiler synthesizes `filter.if` directives
   *  from legacy filters (adx, atr, trend, etc.) so a stale
   *  `selected.filters` produces stale ADX/ATR gates in NT8. */
  liveFilters?: BacktestPreset["filters"];
}

/** Tailwind classes for the small bucket badge, keyed by bucket. Each
 *  bucket has its own subtle hue so the user can scan the dropdown and
 *  see at a glance which stage a preset is in. The colors track the
 *  existing palette: muted for early stages, green for Sim/Live, amber
 *  for Out of Sample (a "yellow flag" stage), red for Failed. */
const BUCKET_BADGE_CLASS: Record<PipelineBucket, string> = {
  new: "bg-white/5 text-muted-foreground",
  in_sample: "bg-blue-500/15 text-blue-300",
  out_of_sample: "bg-amber-500/15 text-amber-300",
  sim: "bg-accent-green/15 text-accent-green",
  live: "bg-accent-green/25 text-accent-green",
  failed: "bg-accent-red/15 text-accent-red",
};

function BacktestPresetsPanelImpl({
  presets,
  onLoad,
  onSaveAs,
  onUpdate,
  onDelete,
  onMoveBucket,
  liveScript,
  liveParamMeta,
  liveRules,
  liveFilters,
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

  // Bucket filter ("all" = no filter). Lives here, not the parent — it's
  // pure UI state and doesn't affect anything outside this dropdown.
  const [bucketFilter, setBucketFilter] = useState<"all" | PipelineBucket>(
    "all"
  );
  // Free-text search across preset name. Substring, case-insensitive.
  const [search, setSearch] = useState<string>("");

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

  // Apply bucket filter + name search, then sort alphabetically.
  // Memoized so the work doesn't repeat on unrelated re-renders (the
  // parent passes a new presets array reference every time something on
  // the dashboard changes, but the contents are usually stable).
  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...presets]
      .filter((p) => {
        const b = (p.bucket ?? "new") as PipelineBucket;
        if (bucketFilter !== "all" && b !== bucketFilter) return false;
        if (q.length > 0 && !p.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [presets, bucketFilter, search]);

  const selected = filteredSorted.find((p) => p.id === selectedId) ?? null;
  const hasSelection = selected !== null;
  const selectedBucket = (selected?.bucket ?? "new") as PipelineBucket;
  // ADVANCE is allowed for everything except the last forward stage and
  // the Failed dead-end. Computed once so the disabled-state and tooltip
  // stay consistent. Cast to PipelineBucket[] so TS doesn't try to narrow
  // the array element type from `b !== "failed"` and reject calls like
  // indexOf(selectedBucket) when selectedBucket happens to be "failed".
  const forwardChain: PipelineBucket[] = PIPELINE_BUCKETS.filter(
    (b) => b !== "failed"
  ) as PipelineBucket[];
  const advanceIdx = forwardChain.indexOf(selectedBucket);
  const canAdvance =
    hasSelection && advanceIdx >= 0 && advanceIdx < forwardChain.length - 1;
  const advanceTarget: PipelineBucket | null = canAdvance
    ? forwardChain[advanceIdx + 1]
    : null;

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

  const handleAdvance = () => {
    if (!selected || !advanceTarget) return;
    onMoveBucket(selected, advanceTarget);
  };

  const handleFail = () => {
    if (!selected) return;
    if (selectedBucket === "failed") return;
    onMoveBucket(selected, "failed");
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
  const handleConvertToNt8 = async () => {
    if (!selected) return;
    setConvertState("running");
    try {
      // The DSL editor is the ONLY source of truth for rules and
      // filters. Send empty objects so the transpiler emits only the
      // `rules.X = Y` and `filter.if = …` directives parsed out of
      // the DSL itself — every field the DSL doesn't set falls back
      // to the C# class defaults in DslStrategyBase. This is what
      // keeps NT8 from quietly inheriting stale per-preset rules
      // (cooldownBetweenTrades, fillMode, etc.) that the user never
      // wrote in the script.
      const presetForExport: BacktestPreset = {
        ...selected,
        script: liveScript && liveScript.length > 0 ? liveScript : selected.script,
        paramMeta: liveParamMeta ?? selected.paramMeta,
        rules: {} as BacktestPreset["rules"],
        filters: {} as BacktestPreset["filters"],
      };
      const resp = await fetch("/api/convert-to-nt8", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: presetForExport, deploy: true }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.success) {
        console.error("[TO NT8] conversion failed", json);
        setConvertState({
          id: selected.id,
          ok: false,
          message: json.error ?? "Failed",
        });
      } else {
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
      console.error("[TO NT8] request error", e);
      setConvertState({
        id: selected.id,
        ok: false,
        message: "REQUEST ERROR",
      });
    }
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
            : filteredSorted.length === presets.length
              ? `${presets.length} saved`
              : `${filteredSorted.length} of ${presets.length}`}
        </span>
      </div>

      {/* ── Bucket filter + search row ────────────────────────────────
          Always visible (even when SAVE AS is open) so the user can see
          which slice of the catalog they're working with. The filter
          state is purely local — nothing about it persists. */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <select
          value={bucketFilter}
          onChange={(e) =>
            setBucketFilter(e.target.value as "all" | PipelineBucket)
          }
          title="Filter presets by pipeline bucket"
          className="bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
        >
          <option value="all">All buckets</option>
          {PIPELINE_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {PIPELINE_BUCKET_LABELS[b]}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search presets…"
          className="flex-1 min-w-0 bg-card border border-card-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
        />
        {(bucketFilter !== "all" || search.trim().length > 0) && (
          <button
            onClick={() => {
              setBucketFilter("all");
              setSearch("");
            }}
            className="px-2 py-1 rounded text-[10px] uppercase tracking-wider font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            title="Clear filter and search"
          >
            Clear
          </button>
        )}
      </div>

      {showNameInput ? (
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
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="flex-1 min-w-0 bg-card border border-card-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
          >
            <option value="">
              {presets.length === 0
                ? "— No presets yet, click SAVE AS to create one —"
                : filteredSorted.length === 0
                  ? "— No presets match the current filter —"
                  : "— Select a preset —"}
            </option>
            {filteredSorted.map((p) => {
              const b = (p.bucket ?? "new") as PipelineBucket;
              return (
                <option key={p.id} value={p.id}>
                  {`[${PIPELINE_BUCKET_LABELS[b]}] ${p.name}`}
                </option>
              );
            })}
          </select>

          {/* LOAD — applies the selected preset to the dashboard. */}
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

          <button
            onClick={() => {
              setShowNameInput(true);
              setSavingName(selected ? `${selected.name} (copy)` : "");
            }}
            title="Save the current strategy, rules, and filters as a new preset"
            className="px-3 py-1.5 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            SAVE AS
          </button>

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

          {/* ── Pipeline action buttons ───────────────────────────────
              ADVANCE walks the preset one step right along the forward
              chain (New → In Sample → Out of Sample → Sim → Live).
              FAIL drops it into the Failed bucket regardless of where
              it currently lives. Both no-op via disabled state when
              there's no selection or the move is impossible. */}
          <button
            onClick={handleAdvance}
            disabled={!canAdvance}
            title={
              canAdvance && advanceTarget
                ? `Move "${selected!.name}" forward → ${PIPELINE_BUCKET_LABELS[advanceTarget]}`
                : hasSelection
                  ? selectedBucket === "failed"
                    ? "Failed presets can't be advanced — drag them on the pipeline page to revive."
                    : "Already at the last pipeline stage."
                  : "Select a preset to advance"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              canAdvance
                ? "bg-blue-500/15 text-blue-300 hover:bg-blue-500/25"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            ADVANCE →
          </button>

          <button
            onClick={handleFail}
            disabled={!hasSelection || selectedBucket === "failed"}
            title={
              hasSelection
                ? selectedBucket === "failed"
                  ? `"${selected!.name}" is already in the Failed bucket.`
                  : `Move "${selected!.name}" → Failed bucket`
                : "Select a preset to fail"
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              hasSelection && selectedBucket !== "failed"
                ? "bg-accent-red/10 text-accent-red hover:bg-accent-red/20"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            FAIL
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
          name alone isn't enough to disambiguate. The bucket badge is
          rendered inline so it's the first thing the user sees. */}
      {selected && !showNameInput && (
        <div className="mt-2 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <span
            className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${BUCKET_BADGE_CLASS[selectedBucket]}`}
          >
            {PIPELINE_BUCKET_LABELS[selectedBucket]}
          </span>
          <span>
            Strategy:{" "}
            <span className="text-foreground">{selected.strategyId}</span>
          </span>
          <span>·</span>
          <span>
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
          </span>
          <span>·</span>
          <span>
            Updated:{" "}
            <span className="text-foreground">
              {new Date(selected.updatedAt).toLocaleString()}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

// Memoized to skip re-renders triggered by parent state that the panel
// doesn't read. `liveScript` does mutate on every keystroke in the
// script editor, so this memo is only fully effective when other state
// (filters, selection, etc.) changes — but the body is shallow and the
// callback props are already `useCallback`'d in the dashboard, so the
// shallow compare is otherwise stable.
export const BacktestPresetsPanel = memo(BacktestPresetsPanelImpl);
