/**
 * BacktestScriptDocs
 * ───────────────────
 * Right-edge slide-out panel that lists every variable the script DSL
 * exposes, grouped by section. Drives directly off SCRIPT_SCHEMA — the
 * single source of truth — so adding a row to the schema automatically
 * surfaces it here. No duplicated docs to drift.
 *
 * Includes a small search box that fuzzy-matches on path AND description,
 * since the schema has 50+ entries and scrolling gets old.
 *
 * Why a panel instead of a separate route? Users opening the docs are
 * almost always mid-edit and want the schema next to the editor. A
 * slide-out keeps both visible simultaneously without the editor losing
 * its scroll position.
 */

"use client";

import { useMemo, useState } from "react";
import { SCRIPT_SCHEMA, ScriptSchemaEntry } from "@/lib/utils/backtest-script";

interface BacktestScriptDocsProps {
  open: boolean;
  onClose: () => void;
}

/** Format the default value for display in the docs row. Mirrors the
 *  same syntax the script accepts so users can copy/paste a default
 *  straight into their editor. */
function formatDefault(entry: ScriptSchemaEntry): string {
  const v = entry.default;
  if (Array.isArray(v)) return `[${v.map((x) => `"${x}"`).join(", ")}]`;
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Pretty-print numeric ranges. Returns empty string for non-numeric
 *  entries since the docs panel suppresses the column for those rows. */
function formatRange(entry: ScriptSchemaEntry): string {
  if (entry.type !== "int" && entry.type !== "float") return "";
  const parts: string[] = [];
  if (entry.min !== undefined) parts.push(`min ${entry.min}`);
  if (entry.max !== undefined) parts.push(`max ${entry.max}`);
  if (entry.step !== undefined) parts.push(`step ${entry.step}`);
  return parts.join(" · ");
}

export function BacktestScriptDocs({ open, onClose }: BacktestScriptDocsProps) {
  const [query, setQuery] = useState("");

  // Group schema entries by section, preserving SCRIPT_SCHEMA's order so
  // sections appear in the same sequence as in a serialized script.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? SCRIPT_SCHEMA.filter(
          (e) =>
            e.path.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            e.section.toLowerCase().includes(q)
        )
      : SCRIPT_SCHEMA;

    const sections: { name: string; rows: ScriptSchemaEntry[] }[] = [];
    for (const e of filtered) {
      const last = sections[sections.length - 1];
      if (last && last.name === e.section) {
        last.rows.push(e);
      } else {
        sections.push({ name: e.section, rows: [e] });
      }
    }
    return sections;
  }, [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Click-away backdrop. Subtle so it doesn't fight with the chart
          colors underneath. */}
      <button
        aria-label="Close docs"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      {/* Slide-out panel — fixed width, right edge. The script editor stays
          fully visible behind the backdrop, so users can ctrl-F and copy. */}
      <div className="ml-auto h-full w-[520px] max-w-[90vw] bg-card border-l border-card-border shadow-2xl flex flex-col">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Script reference
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Every variable you can set in script mode. {SCRIPT_SCHEMA.length} entries.
            </p>
          </div>
          <button
            onClick={onClose}
            className="px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="px-4 py-2 border-b border-card-border">
          <input
            type="text"
            placeholder="Search by path, section, or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-background border border-card-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-accent-blue"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {grouped.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-6">
              No entries match “{query}”.
            </div>
          )}
          {grouped.map((sec) => (
            <div key={sec.name}>
              <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                {sec.name}
              </h3>
              <div className="space-y-2">
                {sec.rows.map((entry) => (
                  <div
                    key={entry.path}
                    className="bg-background/40 border border-card-border rounded-md p-2"
                  >
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <code className="text-xs text-sky-300 font-mono">
                        {entry.path}
                      </code>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        {entry.type}
                        {entry.options && entry.type !== "stringArray"
                          ? ` · ${entry.options.length} options`
                          : ""}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      {entry.description}
                    </p>
                    {/* Defaults / ranges / options strip. We render whichever
                        of these the entry actually carries — keeps rows
                        compact for boolean toggles. */}
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] font-mono text-muted-foreground/80">
                      <span>
                        default <span className="text-foreground/80">{formatDefault(entry)}</span>
                      </span>
                      {formatRange(entry) && <span>{formatRange(entry)}</span>}
                      {entry.options && (
                        <span>
                          options{" "}
                          <span className="text-foreground/80">
                            {entry.options.map((o) => `"${o}"`).join(" | ")}
                          </span>
                        </span>
                      )}
                      {entry.strategies && entry.strategies.length > 0 && (
                        <span>
                          strategies{" "}
                          <span className="text-foreground/80">
                            {entry.strategies.join(", ")}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
