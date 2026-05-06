/**
 * ManageSectionsPanel — Modal dialog for CRUD on zone sections.
 *
 * Lets the user create new sections, rename existing ones, and delete them.
 * Deleting reassigns all zones in the deleted section to the default section
 * so no zones are ever orphaned.
 *
 * Zone counts per section are computed client-side from the zones prop
 * (already in memory via the dashboard's realtime subscription), so the
 * count stays fresh without an extra fetch.
 *
 * The 'default' section is locked: it cannot be renamed or deleted, since
 * other code paths treat it as the guaranteed fallback target.
 */

"use client";

import { useMemo, useState, useTransition } from "react";
import { TradeZone, ZoneSection } from "@/types/trade-zone";
import {
  createSection,
  deleteSection,
  renameSection,
} from "@/lib/sections-actions";

interface ManageSectionsPanelProps {
  sections: ZoneSection[];
  zones: TradeZone[];
  onClose: () => void;
}

export function ManageSectionsPanel({
  sections,
  zones,
  onClose,
}: ManageSectionsPanelProps) {
  // Zone counts keyed by section_id. NULL section_ids (legacy) roll up under
  // the default section so counts add up to the total zone pool.
  const countsBySection = useMemo(() => {
    const defaultId = sections.find((s) => s.name === "default")?.id ?? null;
    const counts = new Map<number, number>();
    for (const z of zones) {
      const key = z.section_id ?? defaultId;
      if (key === null) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [zones, sections]);

  const [newName, setNewName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Which section row is in rename mode + its draft name.
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const result = await createSection(name);
      if (result.error) setError(result.error);
      else setNewName("");
    });
  };

  const handleStartRename = (s: ZoneSection) => {
    setRenameId(s.id);
    setRenameDraft(s.name);
    setError(null);
  };

  const handleCommitRename = () => {
    if (renameId === null) return;
    const name = renameDraft.trim();
    if (!name) {
      setRenameId(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await renameSection(renameId, name);
      if (result.error) setError(result.error);
      else setRenameId(null);
    });
  };

  const handleDelete = (s: ZoneSection) => {
    const count = countsBySection.get(s.id) ?? 0;
    const confirmed = confirm(
      count > 0
        ? `Delete section "${s.name}"? ${count} zone${count > 1 ? "s" : ""} will be reassigned to "default".`
        : `Delete section "${s.name}"?`
    );
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteSection(s.id);
      if (result.error) setError(result.error);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-card border border-card-border rounded-lg p-6 w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-foreground">Manage Sections</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="mb-3 text-xs text-accent-red bg-accent-red/10 border border-accent-red/30 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {/* Sections list */}
        <div className="flex flex-col gap-1.5 mb-4 max-h-72 overflow-y-auto">
          {sections.length === 0 && (
            <p className="text-xs text-muted/60 italic">No sections yet</p>
          )}
          {sections.map((s) => {
            const isDefault = s.name === "default";
            const count = countsBySection.get(s.id) ?? 0;
            const isRenaming = renameId === s.id;
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded bg-background/50 border border-card-border"
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCommitRename();
                      else if (e.key === "Escape") setRenameId(null);
                    }}
                    onBlur={handleCommitRename}
                    className="flex-1 bg-background border border-card-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-muted"
                  />
                ) : (
                  <span className="flex-1 text-sm text-foreground">
                    {s.name}
                    {isDefault && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                        locked
                      </span>
                    )}
                  </span>
                )}
                <span className="text-xs text-muted-foreground font-mono min-w-[40px] text-right">
                  {count}
                </span>
                {!isDefault && !isRenaming && (
                  <>
                    <button
                      onClick={() => handleStartRename(s)}
                      disabled={pending}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-card border border-card-border text-muted-foreground hover:text-foreground hover:border-muted transition-colors disabled:opacity-40"
                    >
                      rename
                    </button>
                    <button
                      onClick={() => handleDelete(s)}
                      disabled={pending}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-accent-red/10 border border-accent-red/30 text-accent-red hover:bg-accent-red/20 transition-colors disabled:opacity-40"
                    >
                      delete
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Create new section */}
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
            placeholder="New section name"
            className="flex-1 bg-background border border-card-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-muted"
          />
          <button
            onClick={handleCreate}
            disabled={pending || !newName.trim()}
            className="px-3 py-1.5 rounded text-sm font-medium bg-accent-green/20 text-accent-green border border-accent-green/40 hover:bg-accent-green/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
