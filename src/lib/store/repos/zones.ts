/**
 * ZonesRepo — trade_zones, trade_zone_bars, zone_sections.
 *
 * Trade zones are user-drawn (via NT8's TradeZone DrawingTool or the
 * practice tool's Save-as-Zone button) regions used for backtesting
 * and analysis. Each zone has a child stream of trade_zone_bars with
 * per-bar excursion analytics.
 */

import type { TradeZone, TradeZoneBar, ZoneSection } from "@/types/trade-zone";
import type { NewZone, ZoneBarInput } from "../types";

export interface ZonesRepo {
  // ── trade_zones ───────────────────────────────────────────────────────────
  listZones(): Promise<TradeZone[]>;
  /** Two-phase insert (zone, then bars). Returns the new zone id. */
  saveZone(zone: NewZone, bars: ZoneBarInput[]): Promise<{ zoneId: number }>;
  deleteZones(ids: number[]): Promise<{ deleted: number }>;

  // ── trade_zone_bars ───────────────────────────────────────────────────────
  listBarsForZone(zoneId: number): Promise<TradeZoneBar[]>;
  listBarsForZones(zoneIds: number[]): Promise<Map<number, TradeZoneBar[]>>;

  // ── zone_sections ─────────────────────────────────────────────────────────
  listSections(): Promise<ZoneSection[]>;
  createSection(name: string): Promise<ZoneSection>;
  renameSection(id: number, name: string): Promise<void>;
  deleteSection(id: number): Promise<void>;
  /** Look up a single section by name (used to find the "default" row that
   *  deleted sections' zones get reassigned to). Null if no match. */
  findSectionByName(name: string): Promise<{ id: number; name: string } | null>;
  /** Reassign every zone whose section_id == fromId to point at toId.
   *  Used when deleting a section so its zones aren't orphaned. */
  reassignZonesToSection(fromId: number, toId: number): Promise<void>;

  /** Global subscription used by the Zone Dashboard. Same semantics as
   *  TradesRepo.subscribeAll — kind is meaningful in cloud mode, local
   *  mode emits "update" for any change and relies on the consumer's
   *  upsert-on-id pattern. */
  subscribeZones(
    onChange: (row: TradeZone, kind: "insert" | "update" | "delete") => void
  ): () => void;

  /** Same shape, scoped to zone_sections. Keeps section dropdowns in
   *  sync across tabs when a section is created/renamed/deleted. */
  subscribeSections(
    onChange: (row: ZoneSection, kind: "insert" | "update" | "delete") => void
  ): () => void;

  /** Used by analyze-fetcher: zones for one section + instrument that fall
   *  inside a window. sectionId === null means "any section" (the count
   *  helper uses this). */
  listZonesInWindow(
    sectionId: number | null,
    instrument: string,
    fromIso: string,
    toIso: string
  ): Promise<TradeZone[]>;

  /** Lightweight count helper for the section picker — returns a Map of
   *  section_id → zone count for zones in the window. Bypasses the
   *  full-row fetch when only counts are needed. */
  countZonesPerSectionInWindow(
    instrument: string,
    fromIso: string,
    toIso: string
  ): Promise<Map<number, number>>;
}
