"use client";

/**
 * useChartIndicators — Shared indicator-series lifecycle manager.
 *
 * Consumed by both live-chart.tsx and replay-chart.tsx. For every enabled
 * IndicatorConfig, this hook:
 *   - Creates the appropriate lightweight-charts v5 series (LineSeries for
 *     overlays like SMA/EMA; HistogramSeries for volume; LineSeries in a
 *     fresh pane for ATR / ADX).
 *   - Recomputes values from the bars array and pushes them via setData().
 *   - Restyles or recomputes when the config's color/period changes without
 *     tearing down the whole series.
 *   - Removes the series when the config is disabled, removed, or when the
 *     host signals a context reset via `resetKey`.
 *
 * Design notes:
 *  - Pane allocation: overlays always live on pane 0 (the price pane).
 *    Sub-indicators get pane indices in the order their enabled configs
 *    appear in the array — first enabled sub-indicator = pane 1, second =
 *    pane 2, etc. Indices are recomputed on every reconcile so disabling a
 *    middle sub-indicator collapses cleanly with no orphan panes.
 *  - Pane indices on existing series can shift (e.g. disabling the ATR
 *    above ADX shifts ADX from pane 2 to pane 1). When this happens we
 *    tear down and recreate the sub-indicator series since
 *    lightweight-charts' pane-move API isn't exposed uniformly across
 *    versions.
 *  - All imperative chart work is done here; consumers just pass configs
 *    in and render <IndicatorPanel /> to drive the configs array.
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import {
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { IndicatorConfig, IndicatorKind } from "@/types/indicators";
import { INDICATOR_DEFAULTS } from "@/types/indicators";
import type { IndicatorBar } from "@/lib/indicators/calculations";
import {
  sma,
  ema,
  volume,
  atr,
  adx,
  signalTriangles,
  signalTrianglesV2,
  signalTrianglesV3,
  regime,
} from "@/lib/indicators/calculations";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UseChartIndicatorsArgs<TBar extends IndicatorBar> {
  /** Chart instance ref — owned by the host component. Populated before
   *  this hook's effects run (host's chart-creation useEffect fires
   *  before the bars effect that drives us). */
  chartRef: MutableRefObject<IChartApi | null>;
  /** Candlestick series ref — unused directly but held in case future
   *  indicator kinds need price-scale alignment with price. */
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  /** Source of truth for OHLCV data. Any shape with bar_time / OHLCV
   *  fields works. The hook recomputes every indicator whenever this
   *  array changes (new tick, new bar, reseed, instrument switch). */
  bars: TBar[];
  /** User configuration — the array the IndicatorPanel mutates. Order
   *  defines pane order for enabled sub-indicators. */
  configs: IndicatorConfig[];
  /** When this string changes, all indicator series are torn down and
   *  the internal handle map is cleared. Host passes e.g.
   *  `${instrument}|${timeframe}` on live, `sessionId` on replay. */
  resetKey: string;
}

/** Internal bookkeeping per config id — the series we created plus the
 *  snapshot of the fields that influenced its creation so we can detect
 *  drift (period change → recompute, pane shift → rebuild). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySeries = ISeriesApi<any>;

interface IndicatorHandle {
  series: AnySeries;
  /** Markers plugin attached to `series`. Only populated for the
   *  "signal" kind, which renders as triangle markers on an invisible
   *  carrier line series. Other kinds leave this undefined. */
  markers?: ISeriesMarkersPluginApi<Time>;
  kind: IndicatorKind;
  period: number | undefined;
  color: string;
  paneIndex: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Resolve the period for a config, falling back to the kind's default
 *  when the user hasn't customized one. Volume has no period — callers
 *  should ignore the returned value for that kind. */
function effectivePeriod(config: IndicatorConfig): number | undefined {
  return config.period ?? INDICATOR_DEFAULTS[config.kind].period;
}

/** Build the (time, value) points for a given config and bar window.
 *  Returns `null` for volume (which produces histogram points handled
 *  separately). Keeps the switch next to where it's used instead of
 *  plumbing generic data through the reconcile loop. */
function computeLineData(config: IndicatorConfig, bars: IndicatorBar[]) {
  const period = effectivePeriod(config);
  switch (config.kind) {
    case "sma":    return period ? sma(bars, period) : [];
    case "ema":    return period ? ema(bars, period) : [];
    case "atr":    return period ? atr(bars, period) : [];
    case "adx":    return period ? adx(bars, period) : [];
    case "volume": return null;
    // Signal kinds render via the markers plugin, not a line — return
    // null so the standard line-data path is skipped. Marker
    // computation happens in the reconcile loop, alongside volume's
    // special case.
    case "signal":    return null;
    case "signal_v2": return null;
    case "signal_v3": return null;
    // Regime renders as a histogram (ADX value, regime-colored bars) in
    // its own sub-pane — handled in the reconcile loop alongside volume.
    case "regime":    return null;
  }
}

/** Determine whether an indicator kind renders on the main price pane
 *  (overlay) or in its own stacked pane below. Drives both the initial
 *  addSeries call and the pane-index allocator. */
function isOverlay(kind: IndicatorKind): boolean {
  return INDICATOR_DEFAULTS[kind].pane === "overlay";
}

/** Build a kind-label → title function for the price-axis label.
 *  Showing e.g. "EMA 20" next to the line's last value makes it easy to
 *  distinguish multiple overlays at a glance. Volume shows "Vol". */
function seriesTitle(config: IndicatorConfig): string {
  const period = effectivePeriod(config);
  switch (config.kind) {
    case "sma":       return `SMA ${period}`;
    case "ema":       return `EMA ${period}`;
    case "atr":       return `ATR ${period}`;
    case "adx":       return `ADX ${period}`;
    case "volume":    return "Vol";
    case "signal":    return `Signal ${period}`;
    case "signal_v2": return `Signal v2 ${period}`;
    case "signal_v3": return `Signal v3 ${period}`;
    // Regime title shows the EMA bias period — that's the only user-facing
    // knob; ADX/ATR/chop thresholds are internal constants.
    case "regime":    return `Regime ${period}`;
  }
}

/** Tear down everything an indicator handle owns: detach the markers
 *  plugin (if any — currently signal-only), then remove the series.
 *  Order matters — detach first so the plugin doesn't reference a
 *  removed series at unmount. Wrapped in try/catch since either step
 *  may already be torn down by a resetKey wipe or chart unmount. */
function disposeHandle(handle: IndicatorHandle, chart: IChartApi): void {
  if (handle.markers) {
    try { handle.markers.detach(); } catch { /* already detached */ }
  }
  try { chart.removeSeries(handle.series); } catch { /* already removed */ }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useChartIndicators<TBar extends IndicatorBar>({
  chartRef,
  seriesRef,
  bars,
  configs,
  resetKey,
}: UseChartIndicatorsArgs<TBar>): void {
  // Map of config id → handle. Persisted across renders so we can diff
  // against the incoming configs array and only mutate what's changed.
  const handlesRef = useRef<Map<string, IndicatorHandle>>(new Map());

  // ─── Reset on resetKey change ────────────────────────────────────────
  // Runs on mount (no-op) and whenever the host signals a context change
  // (instrument/timeframe/session swap) that makes existing indicator
  // series irrelevant — their X-coords would be wrong on the new data.
  useEffect(() => {
    const chart = chartRef.current;
    for (const handle of handlesRef.current.values()) {
      if (chart) disposeHandle(handle, chart);
    }
    handlesRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // ─── Reconcile + data push ───────────────────────────────────────────
  // Fires on every configs or bars change. Three-phase:
  //   1. Allocate pane indices for enabled sub-indicators (overlays
  //      always pane 0).
  //   2. For each config: remove (if disabled/pane-shifted), create (if
  //      missing), or restyle/recompute (if color/period changed).
  //   3. Remove handles for ids no longer in the configs array.
  //
  // On first mount the host's chart-creation effect hasn't necessarily
  // run yet (React runs effects in registration order, and this hook
  // is called from inside the host component's render — before the
  // host's own useEffect). We poll via requestAnimationFrame until the
  // chart is ready; the poll self-cancels on cleanup or once the work
  // runs. Same pattern as useChartDrawings.
  useEffect(() => {
    let rafId: number | null = null;
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      const chart = chartRef.current;
      if (!chart) {
        rafId = requestAnimationFrame(run);
        return;
      }

      // Phase 1: pane allocation. Walk configs in order; give each
      // enabled sub-indicator the next available pane index starting
      // at 1 (pane 0 is reserved for price + overlay indicators).
      const paneByConfigId = new Map<string, number>();
      let nextSubPane = 1;
      for (const cfg of configs) {
        if (!cfg.enabled) continue;
        if (isOverlay(cfg.kind)) {
          paneByConfigId.set(cfg.id, 0);
        } else {
          paneByConfigId.set(cfg.id, nextSubPane);
          nextSubPane += 1;
        }
      }

      // Phase 2: per-config create / update / remove.
      for (const cfg of configs) {
        const existing = handlesRef.current.get(cfg.id);

        if (!cfg.enabled) {
          // Disabled → remove the series but keep the config alive in
          // the array so the user's period/color choice isn't lost.
          if (existing) {
            disposeHandle(existing, chart);
            handlesRef.current.delete(cfg.id);
          }
          continue;
        }

        const paneIndex = paneByConfigId.get(cfg.id)!;
        const period = effectivePeriod(cfg);

        // If pane index shifted (e.g. disabling an ATR above this ADX
        // moved us from pane 2 → pane 1) or the kind changed somehow,
        // tear down so we recreate on the right pane. Kind changes
        // shouldn't happen in practice — configs have stable ids per
        // kind — but the guard is cheap.
        if (existing && (existing.paneIndex !== paneIndex || existing.kind !== cfg.kind)) {
          disposeHandle(existing, chart);
          handlesRef.current.delete(cfg.id);
        }

        let handle = handlesRef.current.get(cfg.id);

        if (!handle) {
          // Create the series on the correct pane. lightweight-charts
          // v5 accepts pane index as the third arg to addSeries.
          let series: AnySeries;
          let markersPlugin: ISeriesMarkersPluginApi<Time> | undefined;
          if (cfg.kind === "volume") {
            series = chart.addSeries(
              HistogramSeries,
              {
                priceFormat: { type: "volume" },
                // Own price scale in the volume pane so the histogram
                // isn't squashed against an indicator's price scale.
                priceScaleId: "",
                title: seriesTitle(cfg),
              },
              paneIndex,
            );
          } else if (cfg.kind === "regime") {
            // Regime: histogram in its own sub-pane. Bar height = ADX,
            // bar color = regime tier (set per-point in the calculator).
            // Use a one-decimal price format so the ADX value reads
            // naturally on the price scale (vs. volume's K/M format).
            series = chart.addSeries(
              HistogramSeries,
              {
                priceFormat: { type: "price", precision: 1, minMove: 0.1 },
                // Own price scale anchored to its own pane — same
                // pattern volume uses to avoid scale collisions when
                // multiple sub-pane indicators stack.
                priceScaleId: "",
                title: seriesTitle(cfg),
              },
              paneIndex,
            );
          } else if (cfg.kind === "signal" || cfg.kind === "signal_v2" || cfg.kind === "signal_v3") {
            // Signal kinds: triangle markers anchored to the
            // candlestick series itself. We can't render markers on a
            // dataless carrier line — the chart culls a series with no
            // data, which hides any markers attached to it. Instead we
            // attach a fresh markers plugin directly to the host's
            // candlestick series; lightweight-charts allows multiple
            // marker plugins per series (each manages its own set), so
            // this coexists with the trade-marker plugin already on
            // that series, AND with multiple signal indicators.
            //
            // We still create a 1-pt invisible LineSeries as the
            // `series` field so the handle's bookkeeping (cleanup,
            // pane-index tracking, kind diff) keeps working uniformly
            // — but it carries no data and is never seen by the user.
            // It also acts as the canonical "remove this on disable"
            // target so we don't accidentally remove the candlestick
            // series.
            series = chart.addSeries(
              LineSeries,
              {
                color: "rgba(0,0,0,0)",
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                title: seriesTitle(cfg),
              },
              paneIndex,
            );
            // Attach the markers plugin to the host candlestick series
            // (NOT the placeholder line above). Falls back to the
            // placeholder if the host series ref is somehow null at
            // construction time, which is defensive — by the time the
            // reconcile effect runs the host always has its candle
            // series mounted.
            const markerHost = seriesRef.current ?? series;
            markersPlugin = createSeriesMarkers(markerHost, []);
          } else {
            series = chart.addSeries(
              LineSeries,
              {
                color: cfg.color,
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: true,
                crosshairMarkerVisible: false,
                title: seriesTitle(cfg),
              },
              paneIndex,
            );
          }
          handle = {
            series,
            markers: markersPlugin,
            kind: cfg.kind,
            period,
            color: cfg.color,
            paneIndex,
          };
          handlesRef.current.set(cfg.id, handle);
        } else {
          // Restyle if color drifted. Period drift triggers a recompute
          // in the data push below — applyOptions is sufficient for
          // color + title since the X-values don't shift.
          // Signal kinds are excluded: their carrier line is intentionally
          // transparent and the user-visible color is applied per-marker
          // in the data push below (signalTriangles* take a color arg).
          if (handle.color !== cfg.color) {
            if (cfg.kind !== "signal" && cfg.kind !== "signal_v2" && cfg.kind !== "signal_v3") {
              try {
                (handle.series as unknown as { applyOptions: (o: Record<string, unknown>) => void })
                  .applyOptions({ color: cfg.color });
              } catch { /* noop */ }
            }
            handle.color = cfg.color;
          }
          // Period change → update title to reflect the new period.
          if (handle.period !== period) {
            try {
              (handle.series as unknown as { applyOptions: (o: Record<string, unknown>) => void })
                .applyOptions({ title: seriesTitle(cfg) });
            } catch { /* noop */ }
            handle.period = period;
          }
        }

        // Always push fresh data — bars may have advanced even when the
        // config didn't change. setData() is O(n) but n is bounded by
        // a few hundred bars in the live chart; measured fine in
        // practice and simpler than maintaining an append cursor per
        // indicator.
        if (cfg.kind === "volume") {
          const data = volume(bars);
          try { handle.series.setData(data); } catch { /* series torn down */ }
        } else if (cfg.kind === "regime") {
          // Regime: per-bar histogram points where value=ADX and the
          // per-point `color` field carries the regime tier. The user's
          // configured `period` drives the EMA bias period; ADX/ATR/chop
          // thresholds are internal calibration constants.
          const emaPeriod = period ?? 20;
          const data = regime(bars, emaPeriod);
          try { handle.series.setData(data); } catch { /* series torn down */ }
        } else if (cfg.kind === "signal" || cfg.kind === "signal_v2" || cfg.kind === "signal_v3") {
          // Recompute triangle markers from the current bars window.
          // Period drives the pre-entry range lookback (default 20).
          // Markers must be sorted by time per lightweight-charts; the
          // calculators emit them in bar order so a re-sort would be
          // a no-op — skipped for cost. Dispatch on kind so v1 / v2 /
          // v3 can coexist with their own state-machine logic.
          const lookback = period ?? 20;
          const markersList: SeriesMarker<Time>[] =
            cfg.kind === "signal"
              ? signalTriangles(bars, lookback, cfg.color)
              : cfg.kind === "signal_v2"
                ? signalTrianglesV2(bars, lookback, cfg.color)
                : signalTrianglesV3(bars, lookback, cfg.color);
          if (handle.markers) {
            try { handle.markers.setMarkers(markersList); } catch { /* torn down */ }
          }
        } else {
          const data = computeLineData(cfg, bars);
          if (data) {
            try { handle.series.setData(data); } catch { /* series torn down */ }
          }
        }
      }

      // Phase 3: remove handles whose configs are no longer present.
      const currentIds = new Set(configs.map((c) => c.id));
      for (const [id, handle] of Array.from(handlesRef.current.entries())) {
        if (currentIds.has(id)) continue;
        disposeHandle(handle, chart);
        handlesRef.current.delete(id);
      }
    };

    run();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configs, bars]);

  // ─── Unmount cleanup ────────────────────────────────────────────────
  // Cleanups fire in reverse-registration order, so this runs BEFORE
  // the host's chart.remove() — handles are still valid. We
  // intentionally read the refs at cleanup time (not at setup time):
  // the chart is created by the host's useEffect that runs AFTER this
  // one, so capturing chartRef.current at setup would give us null.
  // Wrapped in try/catch for the edge case where a series was already
  // removed by a resetKey change.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const chart = chartRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const handles = handlesRef.current;
      for (const handle of handles.values()) {
        if (chart) disposeHandle(handle, chart);
      }
      handles.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

}
