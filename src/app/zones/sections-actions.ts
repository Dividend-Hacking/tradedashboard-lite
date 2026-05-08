/**
 * Server Actions for zone_sections CRUD.
 *
 * Sections are named buckets applied to trade_zones via section_id FK.
 * They let the practice session tag every captured zone with a strategy /
 * sample label, and let the risk simulator filter zones to a subset.
 *
 * A single row with name "default" is guaranteed to exist — it's created
 * by the add_zone_sections migration in cloud mode and seeded on first
 * call here in local mode. Protected from deletion so freshly-deleted
 * sections have a safe fallback to reassign their zones to.
 */

"use server";

import { getServerStore } from "@/lib/store/server";
import { ZoneSection } from "@/types/trade-zone";

/** Fetch all sections ordered by name for dropdowns / management UI.
 *  Seeds a "default" row if missing (local mode starts with no rows). */
export async function listSections(): Promise<
  { sections: ZoneSection[]; error?: string }
> {
  try {
    const store = await getServerStore();
    let sections = await store.zones.listSections();
    if (sections.length === 0) {
      // Local mode begins empty; seed the always-present "default" row
      // so callers (practice tool, simulator) have a fallback to reassign
      // zones to. Idempotent — UNIQUE on name protects against duplicates
      // if two requests race here.
      await store.zones.createSection("default").catch(() => {});
      sections = await store.zones.listSections();
    }
    return { sections };
  } catch (err) {
    return {
      sections: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Create a new section. Names are unique (DB constraint); surface the error
 *  message so the UI can show "already exists" without a crash. */
export async function createSection(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Section name cannot be empty" };

  try {
    const store = await getServerStore();
    const section = await store.zones.createSection(trimmed);
    return { success: true as const, section };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to create section" };
  }
}

/** Rename an existing section. The "default" row is locked — renaming it
 *  would break the deletion fallback that reassigns zones by name. */
export async function renameSection(id: number, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Section name cannot be empty" };

  try {
    const store = await getServerStore();
    // Block renaming the default section — other code paths rely on it existing.
    const sections = await store.zones.listSections();
    const target = sections.find((s) => s.id === id);
    if (target?.name === "default") {
      return { error: "The 'default' section cannot be renamed" };
    }

    await store.zones.renameSection(id, trimmed);
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a section and reassign all its zones to 'default'. Blocks deletion
 *  of 'default' itself. Runs the reassignment first so zones never reference
 *  a missing section row — the FK uses ON DELETE SET NULL as a safety net
 *  but the UI-level expectation is "deleted → default". */
export async function deleteSection(id: number) {
  try {
    const store = await getServerStore();
    const sections = await store.zones.listSections();
    const target = sections.find((s) => s.id === id);
    if (!target) return { error: "Section not found" };
    if (target.name === "default") {
      return { error: "The 'default' section cannot be deleted" };
    }

    const defaultRow = await store.zones.findSectionByName("default");
    if (!defaultRow) {
      return { error: "Default section missing — cannot reassign zones" };
    }

    // Phase 1: Reassign this section's zones to default so nothing ends up
    // orphaned (NULL) from the user's perspective.
    await store.zones.reassignZonesToSection(id, defaultRow.id);

    // Phase 2: Remove the section row.
    await store.zones.deleteSection(id);
    return { success: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
