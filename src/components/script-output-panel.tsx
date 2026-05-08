"use client";

/**
 * script-output-panel.tsx — Renders the script-driven outputs.
 *
 * Two sections, both automatically empty (rendering an "empty state"
 * message) when the user hasn't written any directives:
 *
 *   1. Strategy — one row per `print = ...` line. Evaluated against the
 *      run's SimSummary; values formatted with sensible precision and
 *      copy-to-clipboard on click.
 *   2. Per Trade — one row per simulated trade, with a column per unique
 *      `ontrade.print = ...` label. Sticky header, monospace numbers.
 *      Caps at 500 visible rows (with a footer count) so a 5,000-trade
 *      run doesn't blow up rendering when this panel is expanded.
 *
 * Lives in the right rail of script mode (under the editor). The
 * dashboard ALSO surfaces the same data inline (summary prints become
 * stat cards; per-trade prints become extra columns in simulator-table)
 * — this panel is just the "console-style" alternate view for users who
 * prefer to scan their outputs in one place.
 */

import React from "react";
import type { SimZoneResult } from "@/lib/utils/zone-simulator";

const MAX_ROWS = 500;

export interface SummaryPrint {
  label: string;
  source: string;
  value: number;
}

export interface ScriptOutputPanelProps {
  summaryPrints: SummaryPrint[];
  trades: SimZoneResult[];
  /** Ordered list of per-trade print labels (column headers). Derived
   *  from the user's `ontrade.print` directives in script-apply order. */
  tradePrintLabels: string[];
  warnings?: string[];
  /** Per-directive optimization history (Script v3). Empty/undefined
   *  when the script has no Optimize.X.Y(...) directives. Each entry
   *  records the value the optimizer applied for a specific trade
   *  (`value` = post-smoothing), plus the pre-smoothing best-trial
   *  value (`rawValue`), the smoothing window, and the local
   *  objective. `rawValue` and `smoothWindow` are optional for
   *  back-compat with records produced before SMA smoothing existed. */
  optimizationHistory?: Record<
    string,
    Array<{
      tradeIndex: number;
      value: number;
      rawValue?: number;
      smoothWindow?: number;
      objective: number;
      trialsRun: number;
    }>
  >;
}

/** Format a number for display. Big numbers get thousands separators;
 *  small fractional numbers get up to 4 decimals; NaN renders as "—". */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function ScriptOutputPanelImpl({
  summaryPrints,
  trades,
  tradePrintLabels,
  warnings,
  optimizationHistory,
}: ScriptOutputPanelProps) {
  const hasSummary = summaryPrints.length > 0;
  const hasPerTrade = tradePrintLabels.length > 0 && trades.length > 0;
  const overflow = trades.length > MAX_ROWS;
  const visibleTrades = overflow ? trades.slice(0, MAX_ROWS) : trades;
  const optimizePaths = optimizationHistory ? Object.keys(optimizationHistory) : [];
  const hasOptimization = optimizePaths.length > 0;

  return (
    <div className="bg-card border border-card-border rounded-lg p-4 space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Output</h3>
        <span className="text-xs text-muted-foreground">
          {hasSummary || hasPerTrade || hasOptimization
            ? `${summaryPrints.length} strategy · ${tradePrintLabels.length} per-trade${hasOptimization ? ` · ${optimizePaths.length} optimize` : ""}`
            : "no directives"}
        </span>
      </div>

      {warnings && warnings.length > 0 && (
        <div className="border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs rounded-md px-3 py-2 max-h-32 overflow-y-auto">
          <div className="font-medium mb-1">{warnings.length} warning{warnings.length === 1 ? "" : "s"}:</div>
          <ul className="space-y-1 font-mono">
            {warnings.slice(0, 8).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {warnings.length > 8 && (
              <li className="opacity-70">… and {warnings.length - 8} more</li>
            )}
          </ul>
        </div>
      )}

      {/* ── Optimization section ──────────────────────────────────── */}
      {hasOptimization && (
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
            Optimization
          </div>
          <div className="space-y-2">
            {optimizePaths.map((path) => {
              const records = optimizationHistory![path];
              const last = records.length > 0 ? records[records.length - 1] : null;
              // Applied (smoothed) values — what the strategy actually
              // ran with. The primary trace and stats use these.
              const values = records.map((r) => r.value);
              // Raw pre-smoothing values — drawn as a faint background
              // trace ONLY when smoothing visibly altered them. When
              // smoothing is off (window ≤ 1) every rawValue equals
              // value, so the dual-line render collapses to one line.
              const rawValues = records.map((r) =>
                r.rawValue === undefined ? r.value : r.rawValue
              );
              const hasDistinctRaw = records.some(
                (r) => r.rawValue !== undefined && r.rawValue !== r.value
              );
              // Min/max/mean computed across BOTH traces so the
              // sparkline's y-range encloses every dot — otherwise the
              // raw trace could spike outside the smoothed range and
              // get clipped at the box edge.
              const allValues = hasDistinctRaw ? [...values, ...rawValues] : values;
              const minV = allValues.length > 0 ? Math.min(...allValues) : 0;
              const maxV = allValues.length > 0 ? Math.max(...allValues) : 0;
              const meanV =
                values.length > 0
                  ? values.reduce((s, v) => s + v, 0) / values.length
                  : 0;
              // Smoothing window — read from the latest record (it's
              // the same on every record for a given directive but
              // stored per-row so we don't need a side prop). Falsy
              // means smoothing not active (legacy record or window 0/1).
              const smoothWindow =
                last && last.smoothWindow !== undefined && last.smoothWindow > 1
                  ? last.smoothWindow
                  : null;
              return (
                <div
                  key={path}
                  className="border border-card-border rounded-md p-2.5 bg-background/40"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <code className="text-xs font-mono text-sky-300 truncate">
                        {path}
                      </code>
                      {smoothWindow !== null && (
                        <span className="text-[10px] text-muted-foreground/80 font-mono shrink-0">
                          smooth {smoothWindow}
                        </span>
                      )}
                    </div>
                    {last ? (
                      <span className="text-xs font-mono text-accent-green tabular-nums">
                        last {fmt(last.value)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-amber-400">warming up…</span>
                    )}
                  </div>
                  {/* Sparkline — 200×40 viewBox, traces the applied
                      (smoothed) value as the primary line. When
                      smoothing actually altered values, the raw
                      pre-smoothing series is overlaid as a faint
                      background trace so the user can see the noise
                      damping at a glance. Reference lines (min/max
                      faint dotted, mean dashed) anchor against the
                      smoothed series. Skipped when only 1 sample. */}
                  {records.length >= 2 && (
                    <Sparkline
                      values={values}
                      rawValues={hasDistinctRaw ? rawValues : undefined}
                      mean={meanV}
                      min={minV}
                      max={maxV}
                      className="mt-1"
                    />
                  )}
                  {/* Stats grid — high / low / avg / updates as a
                      4-column block so the user can quickly read off
                      each summary stat without parsing a sentence. */}
                  <div className="grid grid-cols-4 gap-2 mt-2 text-[10px]">
                    <div className="flex flex-col">
                      <span className="text-muted-foreground/70 uppercase tracking-wider">
                        High
                      </span>
                      <span className="text-accent-green font-mono tabular-nums">
                        {fmt(maxV)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-muted-foreground/70 uppercase tracking-wider">
                        Low
                      </span>
                      <span className="text-accent-red font-mono tabular-nums">
                        {fmt(minV)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-muted-foreground/70 uppercase tracking-wider">
                        Avg
                      </span>
                      <span className="text-foreground/90 font-mono tabular-nums">
                        {fmt(meanV)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-muted-foreground/70 uppercase tracking-wider">
                        Updates
                      </span>
                      <span className="text-muted-foreground font-mono tabular-nums">
                        {records.length}
                      </span>
                    </div>
                  </div>
                  {last && Number.isFinite(last.objective) && (
                    <div className="mt-1.5 text-[10px] text-muted-foreground">
                      objective {fmt(last.objective)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Strategy section ───────────────────────────────────────── */}
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Strategy</div>
        {!hasSummary && (
          <div className="text-xs text-muted-foreground italic">
            No <code className="font-mono bg-[#1e1e2a] px-1 rounded">print = …</code> directives.
          </div>
        )}
        {hasSummary && (
          <div className="space-y-1">
            {summaryPrints.map((p, i) => (
              <div
                key={i}
                className="flex items-baseline justify-between gap-3 py-1 px-2 rounded hover:bg-[#1e1e2a] cursor-pointer group"
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    navigator.clipboard.writeText(String(p.value)).catch(() => {});
                  }
                }}
                title="Click to copy value"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground truncate">{p.label}</div>
                  {p.label !== p.source && (
                    <div className="text-[10px] text-muted-foreground font-mono truncate">{p.source}</div>
                  )}
                </div>
                <div className="text-sm font-mono text-accent-green tabular-nums">{fmt(p.value)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Per-trade section ──────────────────────────────────────── */}
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
          Per Trade {overflow && <span className="text-amber-400">(showing first {MAX_ROWS} of {trades.length})</span>}
        </div>
        {!hasPerTrade && (
          <div className="text-xs text-muted-foreground italic">
            No <code className="font-mono bg-[#1e1e2a] px-1 rounded">ontrade.print = …</code> directives.
          </div>
        )}
        {hasPerTrade && (
          <div className="overflow-x-auto -mx-4 px-4 max-h-96 overflow-y-auto border border-[#1e1e2a] rounded-md">
            <table className="text-xs font-mono w-full">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-card-border">
                  <th className="text-left px-2 py-1 text-muted-foreground font-medium">#</th>
                  <th className="text-left px-2 py-1 text-muted-foreground font-medium">Entry</th>
                  {tradePrintLabels.map((l) => (
                    <th key={l} className="text-right px-2 py-1 text-muted-foreground font-medium">{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleTrades.map((t, i) => (
                  <tr key={t.zoneId} className="border-b border-[#1e1e2a]/50 hover:bg-[#1e1e2a]/40">
                    <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1 text-muted-foreground">{shortTime(t.startTime)}</td>
                    {tradePrintLabels.map((l) => (
                      <td key={l} className="px-2 py-1 text-right tabular-nums">
                        {fmt(t.script_prints?.[l] ?? NaN)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Memoized so the panel skips re-renders during fast typing in the
// script editor. None of its props (summary prints, trades,
// tradePrintLabels, optimizationHistory, warnings) mutate per keystroke
// — they're derived from `appliedScriptText` snapshots, not the live
// `scriptText` — so default shallow compare keeps the body stable
// throughout an editing burst.
export const ScriptOutputPanel = React.memo(ScriptOutputPanelImpl);

function shortTime(iso: string): string {
  // Cheap "MM-DD HH:MM" formatter without pulling in a dep. Falls back
  // to the raw string if the format is unexpected.
  if (iso.length < 16) return iso;
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** Inline sparkline rendered as an SVG polyline with optional
 *  high/low/avg reference lines overlaid. Used by the Optimization
 *  section to show the trajectory of an optimized value across signals.
 *  Auto-scales the y-axis to the data's min/max so a flat-line series
 *  still renders as a centered horizontal stroke.
 *
 *  Reference lines:
 *    - max: faint dotted line at the top of the trace's range
 *    - min: faint dotted line at the bottom
 *    - mean: dashed line in the middle, color-matched to the trace so
 *            the user can immediately see how the current value
 *            compares to the long-run average
 *
 *  All three lines are optional — when omitted, the sparkline renders
 *  as a plain polyline. The viewBox is taller (40px vs 24px before) so
 *  the reference lines have visual room to read against the trace. */
function Sparkline({
  values,
  rawValues,
  mean,
  min,
  max,
  className,
}: {
  values: number[];
  /** Optional pre-smoothing series. When provided AND distinct from
   *  `values`, drawn as a faint background polyline so the user can
   *  see the raw optimizer output alongside the smoothed series the
   *  strategy actually used. */
  rawValues?: number[];
  mean?: number;
  min?: number;
  max?: number;
  className?: string;
}) {
  const W = 200;
  const H = 40;
  if (values.length < 2) return null;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1; // avoid /0 on a flat series
  const stepX = W / (values.length - 1);
  // Tiny vertical padding so the trace doesn't kiss the box edges
  // (and so reference lines stay visible at min/max).
  const PAD = 2;
  const yFor = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const toPoints = (series: number[]) =>
    series
      .map((v, i) => `${(i * stepX).toFixed(1)},${yFor(v).toFixed(1)}`)
      .join(" ");
  const points = toPoints(values);
  const rawPoints =
    rawValues && rawValues.length === values.length ? toPoints(rawValues) : null;
  const meanY = mean !== undefined ? yFor(mean) : null;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`w-full h-10 ${className ?? ""}`}
      preserveAspectRatio="none"
    >
      {/* Min / max reference lines — faint dotted, hugging the top
          and bottom of the trace's range. Help the user tell at a
          glance "this point is near the all-time high" vs "near the
          all-time low" without consulting the stats grid below. */}
      <line
        x1={0}
        y1={yFor(hi)}
        x2={W}
        y2={yFor(hi)}
        stroke="currentColor"
        strokeWidth="0.5"
        strokeDasharray="2 3"
        className="text-accent-green/50"
      />
      <line
        x1={0}
        y1={yFor(lo)}
        x2={W}
        y2={yFor(lo)}
        stroke="currentColor"
        strokeWidth="0.5"
        strokeDasharray="2 3"
        className="text-accent-red/50"
      />
      {/* Mean reference line — dashed, neutral white, runs through
          the middle so the user can see at a glance whether the
          current value is above or below the long-run average. */}
      {meanY !== null && (
        <line
          x1={0}
          y1={meanY}
          x2={W}
          y2={meanY}
          stroke="currentColor"
          strokeWidth="0.6"
          strokeDasharray="4 3"
          className="text-foreground/40"
        />
      )}
      {/* Raw (pre-smoothing) trace — drawn BEFORE the smoothed line so
          it sits in the background. Faint, thin stroke so it reads
          as a noise envelope rather than competing with the primary
          series. Only rendered when the caller provided a distinct
          rawValues array. */}
      {rawPoints !== null && (
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          points={rawPoints}
          className="text-foreground/25"
        />
      )}
      {/* The trace itself — drawn last so it sits on top of the
          reference lines and the raw trace. */}
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={points}
        className="text-accent-green"
      />
    </svg>
  );
}
