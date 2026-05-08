/**
 * JSONB ↔ TEXT translation for SQLite.
 *
 * Postgres jsonb columns (custom_tags, params, rules, filters,
 * live_indicators, practice_indicators, chart_overlays, dashboard
 * state, livebridge_endpoint.candidates) are stored as TEXT in SQLite.
 * Repos use these helpers at the boundary so the JS-side shape stays
 * identical to the cloud one.
 *
 * Both helpers tolerate already-typed values: writeJson on a string
 * passes it through unchanged (assumed to already be JSON), and
 * readJson on a non-string returns it as-is. This keeps the call
 * sites tolerant of upgrade migrations or hand-written test data.
 */

export function writeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function readJson<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  if (value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Translate a SQLite INTEGER (0/1) into a JS boolean. NULL → null. */
export function readBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  return Number(value) !== 0;
}

/** Translate a JS boolean into a SQLite INTEGER. null/undefined → null. */
export function writeBool(value: unknown): 0 | 1 | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}
