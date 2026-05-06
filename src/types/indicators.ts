/**
 * indicators.ts — Shared types for the chart indicator system.
 *
 * Indicators are client-computed overlays on the lightweight-charts v5
 * candlestick chart. The same type shape is persisted as JSONB in two
 * `trader_preferences` columns:
 *   - live_indicators     → used by the Live Trader chart
 *   - practice_indicators → used by the Practice / Replay chart
 *
 * Multiple instances of the same `kind` are allowed (e.g. EMA 9 +
 * EMA 20 + EMA 200); `id` disambiguates them. Array order = pane order
 * for sub-pane indicators (volume / ATR / ADX each occupy their own pane
 * under the price pane, in the order they appear in the array).
 */

/** Every indicator kind the starter library supports. Add new kinds by
 *  extending this union and the INDICATOR_DEFAULTS map below, then
 *  implementing a calculator in `src/lib/indicators/calculations.ts`
 *  and a series-creation branch in `use-chart-indicators.ts`. */
export type IndicatorKind = "sma" | "ema" | "volume" | "atr" | "adx" | "signal" | "signal_v2" | "signal_v3" | "regime";

/** A single configured indicator instance. `enabled: false` keeps the
 *  row (period / color) in the config so toggling off/on doesn't lose
 *  user customizations. */
export interface IndicatorConfig {
  /** Stable uuid — survives reorder / toggle / period edits. Used as
   *  the map key in the indicators hook's handles ref. */
  id: string;
  kind: IndicatorKind;
  /** Soft toggle. When false the config is kept in the array but no
   *  series is mounted on the chart. */
  enabled: boolean;
  /** Hex color (from DRAWING_COLOR_PRESETS). For overlays (sma / ema) it
   *  colors the line; for volume it tints the up/down histogram pair. */
  color: string;
  /** Lookback window. Ignored for `volume` (which has no period). All
   *  other kinds require a positive integer. Falls back to the kind's
   *  default when missing. */
  period?: number;
}

/** Where an indicator renders. Overlays draw on the main price pane;
 *  sub-indicators get their own pane stacked below. Used by the hook
 *  when allocating pane indices. */
export type IndicatorPane = "overlay" | "sub";

/** Per-kind default period, color, label, and pane placement. The UI
 *  reads this to populate "Add indicator" buttons; the hook reads
 *  `pane` to decide whether a new series goes on pane 0 or a fresh
 *  pane index below. */
export const INDICATOR_DEFAULTS: Record<
  IndicatorKind,
  { period?: number; color: string; label: string; pane: IndicatorPane }
> = {
  sma:    { period: 20, color: "#f59e0b", label: "SMA",    pane: "overlay" },
  ema:    { period: 20, color: "#22d3ee", label: "EMA",    pane: "overlay" },
  volume: {             color: "#64748b", label: "Volume", pane: "sub"     },
  atr:    { period: 14, color: "#a78bfa", label: "ATR",    pane: "sub"     },
  adx:    { period: 14, color: "#f472b6", label: "ADX",    pane: "sub"     },
  // Signal — triangle-marker indicator that fires on a 20-bar pre-entry
  // range break / pullback combo. `period` is reused as the pre-entry
  // range lookback (default 20 bars). Renders on the price pane as an
  // overlay so the triangles draw next to the candles they tag.
  signal: { period: 20, color: "#fbbf24", label: "Signal", pane: "overlay" },
  // Signal v2 — stricter version of `signal`. Differences vs v1:
  //   1. Fires only on the bar that CROSSES INTO the zone (prior bar
  //      below threshold, current bar above) — not every bar that
  //      happens to sit in the zone.
  //   2. Per-direction lockout after firing — re-arms only when price
  //      clearly leaves the zone (position < 0.3) OR a 30-bar
  //      cooldown expires.
  //   3. Base filter — pre-entry window must look like an actual base:
  //      range size in [1.5, 4.0] × ATR and end-to-end drift across
  //      the window < 0.5 × range. Screens out trending lookbacks.
  // Default teal so it's visually distinct from the amber v1 markers
  // when both are enabled side by side for comparison.
  signal_v2: { period: 20, color: "#14b8a6", label: "Signal v2", pane: "overlay" },
  // Signal v3 — V2 + multi-bar acceptance (in-zone for N consecutive
  // bars before firing) + body/range trigger (|close-open| / (high-low)
  // must clear a minimum). Tightens V2's two noisiest gates for fast /
  // low-timeframe data. Tunables (acceptance bars, body ratio min) are
  // baked as indicator constants — surface stays single-period.
  // Default purple so V1 (amber) / V2 (teal) / V3 (purple) read at a
  // glance when stacked on the same chart.
  signal_v3: { period: 20, color: "#a855f7", label: "Signal v3", pane: "overlay" },
  // Regime — trade-or-stand-aside classifier rendered as a sub-pane
  // histogram. Each bar's height encodes ADX(14) magnitude; each bar's
  // color encodes the regime decision (LONG / SHORT / stand-aside flavor).
  // `period` drives the EMA period for the directional bias rule
  // (default 20). The user-picked `color` is decorative only — actual
  // bar colors are fixed per regime state inside the calculator (same
  // pattern volume uses for its red/green tint).
  regime: { period: 20, color: "#94a3b8", label: "Regime", pane: "sub" },
};

/** Ordered list of kinds to show as "Add …" buttons in the panel.
 *  Kept as a const so the UI renders them in a stable order regardless
 *  of object-key iteration. */
export const INDICATOR_KINDS: IndicatorKind[] = ["sma", "ema", "volume", "atr", "adx", "signal", "signal_v2", "signal_v3", "regime"];

/** Build a fresh config for a given kind using the kind's defaults.
 *  Callers supply the uuid (via crypto.randomUUID) so this helper stays
 *  pure and testable. */
export function makeDefaultIndicator(kind: IndicatorKind, id: string): IndicatorConfig {
  const d = INDICATOR_DEFAULTS[kind];
  return {
    id,
    kind,
    enabled: true,
    color: d.color,
    period: d.period,
  };
}
