/**
 * PipelineBoard
 *
 * Kanban-style board for the /pipeline page. Renders six columns — one per
 * pipeline bucket — and lets the user drag a preset from one column into
 * another to move it through the strategy lifecycle:
 *
 *   New → In Sample → Out of Sample → Sim → Live
 *                                        ↘ Failed
 *
 * Click on a card to open a detail panel that shows when the preset was
 * created / last updated, lets the user rename or delete it, and exposes
 * a bucket dropdown as a fallback for users who can't or don't want to
 * drag.
 *
 * Data flow mirrors the backtest dashboard's preset selector:
 *   - On mount, hydrate state from localStorage (synchronous) for an
 *     instant first paint, then kick off syncPresetsFromSupabase to
 *     reconcile against the cloud / SQLite copy.
 *   - Subscribe to PRESETS_CHANGED_EVENT so changes from the dashboard
 *     (or another tab) reflect here without a manual refresh.
 *
 * Drag implementation is plain HTML5 drag-and-drop — no extra dep needed
 * for a simple "drop on this column" gesture. The dragged preset id rides
 * in dataTransfer so even a hot-reload mid-drag won't corrupt the state.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadPresets,
  syncPresetsFromSupabase,
  setPresetBucket,
  renamePreset,
  deletePreset,
  PIPELINE_BUCKETS,
  PIPELINE_BUCKET_LABELS,
  PRESETS_CHANGED_EVENT,
  type BacktestPreset,
  type PipelineBucket,
} from "@/lib/utils/backtest-presets";

/** Tailwind class fragments for the column header chip per bucket. Same
 *  palette as the badge in the preset selector so the user sees a
 *  consistent visual language across the app. */
const BUCKET_HEADER_CLASS: Record<PipelineBucket, string> = {
  new: "bg-white/5 text-muted-foreground border-white/10",
  in_sample: "bg-blue-500/15 text-blue-300 border-blue-500/25",
  out_of_sample: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  sim: "bg-accent-green/15 text-accent-green border-accent-green/25",
  live: "bg-accent-green/25 text-accent-green border-accent-green/40",
  failed: "bg-accent-red/15 text-accent-red border-accent-red/25",
};

/** Short helper text shown under each column header. Helps a new user
 *  understand what each stage is for without needing a separate doc. */
const BUCKET_DESCRIPTION: Record<PipelineBucket, string> = {
  new: "Just created — not validated yet.",
  in_sample: "Tuned on the in-sample data window.",
  out_of_sample: "Validated against held-out data.",
  sim: "Running in simulator / paper trading.",
  live: "Promoted to live trading.",
  failed: "Decommissioned — kept for reference.",
};

export default function PipelineBoard() {
  // Local mirror of the preset list. Hydrated from localStorage on mount
  // so the board paints instantly; reconciled with Supabase right after.
  const [presets, setPresets] = useState<BacktestPreset[]>([]);

  // Currently-open detail card id. null = no panel open. Owned here so
  // the panel survives a presets refresh (we re-find by id instead of
  // holding the preset object).
  const [openId, setOpenId] = useState<string | null>(null);

  // Tracks which column the user is currently dragging over so we can
  // give visual feedback (a brighter border) on the drop target. null
  // when no drag is in flight.
  const [dragOverBucket, setDragOverBucket] = useState<PipelineBucket | null>(
    null
  );

  // ── Hydration + sync ────────────────────────────────────────────
  // We deliberately set state inside this effect rather than via lazy
  // useState initializer — `loadPresets()` reads `window.localStorage`
  // which is not available during SSR. Doing it on mount keeps the
  // server-rendered HTML stable (always []) and only diverges once we
  // hit the client, matching the same pattern the backtest dashboard
  // uses for its own presets list.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPresets(loadPresets());
    syncPresetsFromSupabase().catch(() => {});
    const onChanged = () => setPresets(loadPresets());
    window.addEventListener(PRESETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PRESETS_CHANGED_EVENT, onChanged);
  }, []);

  // Group presets by bucket. Memoized because a sort + bucket walk runs
  // every render and the parent re-renders on every cross-tab event. The
  // dependency on `presets` keeps it cheap when the list is stable.
  const presetsByBucket = useMemo(() => {
    const grouped: Record<PipelineBucket, BacktestPreset[]> = {
      new: [],
      in_sample: [],
      out_of_sample: [],
      sim: [],
      live: [],
      failed: [],
    };
    for (const p of presets) {
      const b = (p.bucket ?? "new") as PipelineBucket;
      if (!grouped[b]) {
        // Defensive: if a stored preset has a bucket we don't recognize,
        // dump it in "new" rather than dropping it from the UI.
        grouped.new.push(p);
      } else {
        grouped[b].push(p);
      }
    }
    // Sort each column by updatedAt DESC so the most recently touched
    // presets are at the top — matches the dashboard's natural ordering.
    for (const b of PIPELINE_BUCKETS) {
      grouped[b].sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      );
    }
    return grouped;
  }, [presets]);

  const open = openId ? presets.find((p) => p.id === openId) ?? null : null;

  // ── Drag handlers ───────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, presetId: string) => {
      e.dataTransfer.setData("text/preset-id", presetId);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, bucket: PipelineBucket) => {
      // Required to make the column a valid drop target.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragOverBucket !== bucket) setDragOverBucket(bucket);
    },
    [dragOverBucket]
  );

  const handleDragLeave = useCallback(
    (_e: React.DragEvent<HTMLDivElement>, bucket: PipelineBucket) => {
      // Only clear the highlight if we're actually leaving THIS bucket
      // — drag-leave fires for child elements too.
      setDragOverBucket((cur) => (cur === bucket ? null : cur));
    },
    []
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, bucket: PipelineBucket) => {
      e.preventDefault();
      setDragOverBucket(null);
      const id = e.dataTransfer.getData("text/preset-id");
      if (!id) return;
      const updated = setPresetBucket(id, bucket);
      if (updated) setPresets(loadPresets());
    },
    []
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Strategy Pipeline
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Drag presets between buckets to track them through the
            in-sample → out-of-sample → sim → live lifecycle. Click a card
            to view details, rename, or delete.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {presets.length} preset{presets.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* ── Kanban columns ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {PIPELINE_BUCKETS.map((bucket) => {
          const items = presetsByBucket[bucket];
          const isOver = dragOverBucket === bucket;
          return (
            <div
              key={bucket}
              onDragOver={(e) => handleDragOver(e, bucket)}
              onDragLeave={(e) => handleDragLeave(e, bucket)}
              onDrop={(e) => handleDrop(e, bucket)}
              className={`bg-card border rounded-lg p-3 flex flex-col min-h-[200px] transition-colors ${
                isOver
                  ? "border-accent-green/60 bg-accent-green/5"
                  : "border-card-border"
              }`}
            >
              <div
                className={`flex items-center justify-between px-2 py-1 rounded border ${BUCKET_HEADER_CLASS[bucket]}`}
              >
                <span className="text-xs uppercase tracking-wider font-semibold">
                  {PIPELINE_BUCKET_LABELS[bucket]}
                </span>
                <span className="text-[10px] opacity-80">{items.length}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1 mb-2 px-1">
                {BUCKET_DESCRIPTION[bucket]}
              </p>

              <div className="flex-1 space-y-2">
                {items.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground/60 text-center py-6 border border-dashed border-card-border rounded">
                    Drop presets here
                  </div>
                ) : (
                  items.map((p) => (
                    <PresetCard
                      key={p.id}
                      preset={p}
                      onClick={() => setOpenId(p.id)}
                      onDragStart={(e) => handleDragStart(e, p.id)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Detail / edit modal ────────────────────────────────────
          Keying on `open.id` remounts the panel whenever the user opens
          a different preset, so the local name input always re-seeds
          from props without needing an in-effect setState. */}
      {open && (
        <PresetDetailPanel
          key={open.id}
          preset={open}
          onClose={() => setOpenId(null)}
          onChange={() => setPresets(loadPresets())}
          onDeleted={() => {
            setPresets(loadPresets());
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * A single draggable preset card. Pure presentation + a click-to-open
 * surface. The drag wiring lives on the parent column but the card has
 * to be `draggable` for HTML5 DnD to fire.
 */
function PresetCard({
  preset,
  onClick,
  onDragStart,
}: {
  preset: BacktestPreset;
  onClick: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const updated = new Date(preset.updatedAt);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="bg-background border border-card-border rounded p-2 cursor-grab active:cursor-grabbing hover:border-accent-green/40 transition-colors"
      title="Drag to a different bucket, or click to view details"
    >
      <div className="text-xs font-medium text-foreground truncate">
        {preset.name}
      </div>
      <div className="text-[10px] text-muted-foreground mt-1 truncate">
        {preset.strategyId}
      </div>
      <div className="text-[10px] text-muted-foreground/70 mt-1">
        Updated {updated.toLocaleDateString()} {updated.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </div>
    </div>
  );
}

/**
 * Detail panel rendered as a centered overlay (modal-ish, but without a
 * heavy dep). Shows full timestamps, lets the user rename inline, change
 * the bucket via dropdown (parallel to drag), and delete with a confirm.
 *
 * We deliberately don't expose strategy/params/rules editing here — the
 * canonical place for that is the backtest dashboard. Putting another
 * editor here would split the source of truth.
 */
function PresetDetailPanel({
  preset,
  onClose,
  onChange,
  onDeleted,
}: {
  preset: BacktestPreset;
  onClose: () => void;
  onChange: () => void;
  onDeleted: () => void;
}) {
  // The parent re-mounts this panel via `key={open.id}` so a fresh
  // `useState(preset.name)` always picks up the current preset's name —
  // no re-seed effect needed.
  const [name, setName] = useState(preset.name);

  const created = new Date(preset.createdAt);
  const updated = new Date(preset.updatedAt);
  const bucket = (preset.bucket ?? "new") as PipelineBucket;

  const filtersOn: string[] = [];
  if (preset.filters?.time?.enabled) filtersOn.push("Time");
  if (preset.filters?.adx?.enabled) filtersOn.push("ADX");
  if (preset.filters?.atr?.enabled) filtersOn.push("ATR");
  if (preset.filters?.trend?.enabled) filtersOn.push("Trend");
  if (preset.filters?.bollinger?.enabled) filtersOn.push("Bollinger");

  const handleRename = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === preset.name) return;
    renamePreset(preset.id, trimmed);
    onChange();
  };

  const handleBucket = (b: PipelineBucket) => {
    if (b === bucket) return;
    setPresetBucket(preset.id, b);
    onChange();
  };

  const handleDelete = () => {
    const ok = window.confirm(
      `Delete preset "${preset.name}"? This can't be undone.`
    );
    if (!ok) return;
    deletePreset(preset.id);
    onDeleted();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-card-border rounded-lg shadow-xl w-full max-w-lg p-5"
        // Stop click bubbling so clicking inside the panel doesn't close it.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Preset Details
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Edit the name or move to another bucket. Strategy logic edits
              live on the backtest dashboard.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Name
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                }}
                className="flex-1 bg-background border border-card-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
              <button
                onClick={handleRename}
                disabled={
                  name.trim().length === 0 || name.trim() === preset.name
                }
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  name.trim().length === 0 || name.trim() === preset.name
                    ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                    : "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                }`}
              >
                Rename
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Bucket
            </label>
            <select
              value={bucket}
              onChange={(e) => handleBucket(e.target.value as PipelineBucket)}
              className="w-full bg-background border border-card-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
            >
              {PIPELINE_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {PIPELINE_BUCKET_LABELS[b]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-card-border">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Strategy
              </div>
              <div className="text-sm text-foreground mt-1 truncate">
                {preset.strategyId}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Filters
              </div>
              <div className="text-sm text-foreground mt-1 truncate">
                {filtersOn.length === 0 ? "none" : filtersOn.join(", ")}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Created
              </div>
              <div className="text-sm text-foreground mt-1">
                {created.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Last updated
              </div>
              <div className="text-sm text-foreground mt-1">
                {updated.toLocaleString()}
              </div>
            </div>
          </div>

          <div className="flex justify-between pt-3 border-t border-card-border">
            <button
              onClick={handleDelete}
              className="px-3 py-1.5 rounded text-xs font-medium bg-accent-red/15 text-accent-red hover:bg-accent-red/25 transition-colors"
            >
              Delete preset
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded text-xs font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
