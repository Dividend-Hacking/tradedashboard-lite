/**
 * Server Actions for zone_sections CRUD.
 *
 * Sections are named buckets applied to trade_zones via section_id FK.
 * They let the practice session tag every captured zone with a strategy /
 * sample label, and let the risk simulator filter zones to a subset.
 *
 * A single row with name "default" is guaranteed to exist — it's created
 * by the add_zone_sections migration and is protected from deletion so
 * freshly-deleted sections have a safe fallback to reassign their zones to.
 */

"use server";

import { createClient } from "@/lib/supabase/server";
import { ZoneSection } from "@/types/trade-zone";

/** Fetch all sections ordered by name for dropdowns / management UI. */
export async function listSections(): Promise<
  { sections: ZoneSection[]; error?: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("zone_sections")
    .select("*")
    .order("name", { ascending: true });

  if (error) return { sections: [], error: error.message };
  return { sections: (data as ZoneSection[]) ?? [] };
}

/** Create a new section. Names are unique (DB constraint); surface the error
 *  message so the UI can show "already exists" without a crash. */
export async function createSection(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Section name cannot be empty" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("zone_sections")
    .insert({ name: trimmed })
    .select("*")
    .single();

  if (error || !data) {
    return { error: error?.message || "Failed to create section" };
  }
  return { success: true, section: data as ZoneSection };
}

/** Rename an existing section. The "default" row is locked — renaming it
 *  would break the deletion fallback that reassigns zones by name. */
export async function renameSection(id: number, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Section name cannot be empty" };

  const supabase = await createClient();

  // Block renaming the default section — other code paths rely on it existing.
  const { data: existing } = await supabase
    .from("zone_sections")
    .select("name")
    .eq("id", id)
    .single();
  if (existing?.name === "default") {
    return { error: "The 'default' section cannot be renamed" };
  }

  const { error } = await supabase
    .from("zone_sections")
    .update({ name: trimmed })
    .eq("id", id);

  if (error) return { error: error.message };
  return { success: true };
}

/** Delete a section and reassign all its zones to 'default'. Blocks deletion
 *  of 'default' itself. Runs the reassignment first so zones never reference
 *  a missing section row — the FK uses ON DELETE SET NULL as a safety net
 *  but the UI-level expectation is "deleted → default". */
export async function deleteSection(id: number) {
  const supabase = await createClient();

  // Look up default id + target name in one query. Block deleting default.
  const { data: sections, error: lookupError } = await supabase
    .from("zone_sections")
    .select("id, name")
    .in("id", [id]);

  if (lookupError) return { error: lookupError.message };
  if (!sections || sections.length === 0) {
    return { error: "Section not found" };
  }
  if (sections[0].name === "default") {
    return { error: "The 'default' section cannot be deleted" };
  }

  const { data: defaultRow, error: defaultError } = await supabase
    .from("zone_sections")
    .select("id")
    .eq("name", "default")
    .single();

  if (defaultError || !defaultRow) {
    return { error: "Default section missing — cannot reassign zones" };
  }

  // Phase 1: Reassign this section's zones to default so nothing ends up
  // orphaned (NULL) from the user's perspective.
  const { error: reassignError } = await supabase
    .from("trade_zones")
    .update({ section_id: defaultRow.id })
    .eq("section_id", id);

  if (reassignError) return { error: reassignError.message };

  // Phase 2: Remove the section row.
  const { error: deleteError } = await supabase
    .from("zone_sections")
    .delete()
    .eq("id", id);

  if (deleteError) return { error: deleteError.message };
  return { success: true };
}
