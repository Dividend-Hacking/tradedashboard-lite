/**
 * Formatting Utilities
 *
 * Pure helper functions for displaying trade data in the UI.
 * All functions handle null/undefined gracefully, returning
 * a dash "—" placeholder when no value is available.
 */

/**
 * Format a number as USD currency (e.g. "$1,234.50" or "-$500.00").
 * Returns "—" for null/undefined values.
 */
export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a number as a percentage string (e.g. "65.4%").
 * Input should be a decimal (0.654) or a whole number (65.4) depending on context.
 * The `alreadyPercent` flag indicates the value is already in percent form.
 */
export function formatPercent(
  value: number | null | undefined,
  alreadyPercent = false,
  decimals: number = 1
): string {
  if (value == null) return "—";
  const pct = alreadyPercent ? value : value * 100;
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Parse a DB timestamp string into its raw parts WITHOUT timezone conversion.
 * Supabase timestamps are already in the user's local timezone — using new Date()
 * would incorrectly apply a timezone offset. This extracts the values literally.
 */
export function parseRawTimestamp(timestamp: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
} {
  // Date-only inputs ("YYYY-MM-DD") would otherwise be mangled by the
  // timezone-stripping regex below — its `[+-]\d{2}$` branch happily matches
  // the trailing "-25" of a date and lops the day off, producing
  // year/month/day = 2026/4/undefined. Detect the date-only shape (10 chars,
  // no T or space) and short-circuit before the regex ever runs.
  const isDateOnly =
    timestamp.length === 10 && !timestamp.includes("T") && !timestamp.includes(" ");
  const clean = isDateOnly
    ? timestamp
    : timestamp.replace(/([+-]\d{2}(:\d{2})?|Z)$/, "").replace(" ", "T");
  const [datePart, timePart] = clean.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = (timePart || "0:0:0").split(":").map(Number);
  return { year, month, day, hour, minute, second: second || 0 };
}

/**
 * Convert a DB timestamp to a UTC unix timestamp (seconds) without timezone conversion.
 * Use this for chart libraries that expect unix timestamps.
 */
export function rawTimestampToUnix(timestamp: string): number {
  const { year, month, day, hour, minute, second } = parseRawTimestamp(timestamp);
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/**
 * Get the hour (0-23) from a DB timestamp without timezone conversion.
 */
export function rawHour(timestamp: string): number {
  return parseRawTimestamp(timestamp).hour;
}

/**
 * Get the day of week (0=Sun..6=Sat) from a DB timestamp without timezone conversion.
 */
export function rawDayOfWeek(timestamp: string): number {
  const { year, month, day } = parseRawTimestamp(timestamp);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Get the date portion (YYYY-MM-DD) from a DB timestamp without timezone conversion.
 */
export function rawDateString(timestamp: string): string {
  const { year, month, day } = parseRawTimestamp(timestamp);
  return `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/**
 * Format a DB timestamp to a short readable date (e.g. "Mar 13, 2026").
 * Does NOT apply timezone conversion.
 */
export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  const { year, month, day } = parseRawTimestamp(isoString);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month - 1]} ${day}, ${year}`;
}

/**
 * Format a DB timestamp to just the time (e.g. "9:30 AM").
 * Does NOT apply timezone conversion.
 */
export function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  const { hour, minute } = parseRawTimestamp(isoString);
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${minute.toString().padStart(2, "0")} ${ampm}`;
}

/**
 * Format a generic number to a fixed number of decimal places.
 * Returns "—" for null/undefined values.
 * Useful for rendering numeric trade fields (points, R multiples, etc.).
 */
export function formatNumber(
  value: number | null | undefined,
  decimals: number = 2
): string {
  if (value == null) return "—";
  return value.toFixed(decimals);
}
