"use client";

/**
 * AnalyzeSectionPicker — Modal used by the practice-mode "Analyze" button.
 *
 * Displays every available zone section with a per-section count of how many
 * zones in that section fall inside the currently-loaded replay session's
 * window. Single-select: the user picks one section, we close the modal, and
 * the parent loads zones for that section onto the chart.
 *
 * Counts are fetched once on mount (cheap one-column scan) and used both to
 * render the chip subtitle and to disable sections with zero matching zones.
 */

import { useEffect, useState } from "react";
import { ZoneSection } from "@/types/trade-zone";
import { ReplaySession } from "@/types/replay";
import { fetchAnalyzeZoneCounts } from "@/lib/utils/analyze-fetcher";

interface AnalyzeSectionPickerProps {
  sections: ZoneSection[];
  session: ReplaySession;
  onCancel: () => void;
  onConfirm: (sectionId: number) => void;
}

export function AnalyzeSectionPicker({
  sections,
  session,
  onCancel,
  onConfirm,
}: AnalyzeSectionPickerProps) {
  const [counts, setCounts] = useState<Map<number, number> | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pull per-section zone counts scoped to this session's window so the chip
  // subtitles ("N zones") only reflect data actually plottable on the chart.
  // Empty sections are still listed but disabled — clearer than hiding them.
  useEffect(() => {
    let cancelled = false;
    fetchAnalyzeZoneCounts(session)
      .then((c) => {
        if (!cancelled) setCounts(c);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[analyze-picker] count fetch failed:", err);
          setError("Failed to load zone counts.");
          setCounts(new Map());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const canConfirm = selected !== null && (counts?.get(selected) ?? 0) > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-card-border rounded-lg p-6 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-foreground">Analyze Section</h3>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Pick a section. Every zone in that section that falls inside this
          session will be plotted on the chart with adjustable TP / SL / TSL.
        </p>

        {/* Section list. Each row is a button; clicking selects the section.
            Sections with zero matching zones for this window are disabled so
            the user can't pick a section that would render an empty chart. */}
        <div className="space-y-1 max-h-80 overflow-y-auto pr-1 mb-4">
          {sections.length === 0 && (
            <div className="text-sm text-muted-foreground italic py-2">
              No sections exist yet.
            </div>
          )}
          {counts === null && sections.length > 0 && (
            <div className="text-sm text-muted-foreground italic py-2">
              Loading zone counts...
            </div>
          )}
          {counts !== null &&
            sections.map((s) => {
              const count = counts.get(s.id) ?? 0;
              const empty = count === 0;
              const active = selected === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => !empty && setSelected(s.id)}
                  disabled={empty}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
                    active
                      ? "bg-accent-green/20 text-accent-green"
                      : empty
                        ? "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
                        : "bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                  }`}
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs opacity-80">{count} zones</span>
                </button>
              );
            })}
        </div>

        {error && (
          <div className="text-xs text-accent-red mb-3">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => selected !== null && onConfirm(selected)}
            disabled={!canConfirm}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              canConfirm
                ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                : "bg-white/5 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            Analyze
          </button>
        </div>
      </div>
    </div>
  );
}
