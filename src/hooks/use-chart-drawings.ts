"use client";

/**
 * useChartDrawings — Shared drawing-tool state machine + chart integration.
 *
 * Consumed by both live-chart.tsx and replay-chart.tsx. Encapsulates:
 *   - React state for drawings, active tool, selection, pending 2-click shapes
 *   - Chart event subscriptions (click for draw/select, crosshair for preview)
 *   - Native handle lifecycle (price lines for horizontals, LineSeries for trends)
 *   - Viewport-change tracking so the SVG overlay re-projects rectangles /
 *     vertical lines when the user pans or zooms
 *   - Keyboard handling (Escape cancels, Delete/Backspace removes selection)
 *   - `resetKey` wipe (e.g., on instrument/timeframe switch, session change)
 *
 * Design notes:
 *  - All imperative chart work happens inside this hook so consumers only
 *    need to render a <DrawingToolbar /> and <DrawingOverlay /> with the
 *    returned prop bags.
 *  - `activeToolRef` is exposed so host components (notably live-chart.tsx)
 *    can gate their own click handlers (SL/TP drag) when a drawing tool is
 *    active — otherwise both handlers would fire on the same click.
 *  - Effects intentionally read refs inside their bodies and have empty
 *    dep arrays; the refs themselves are kept in sync with state by small
 *    mirror-effects. This avoids tearing down + rebuilding chart
 *    subscriptions on every drawing mutation.
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  type Drawing,
  type DrawingTool,
  type DrawingPoint,
  DRAWING_DEFAULT_COLOR,
} from "@/types/chart-drawings";
import {
  makeDrawingId,
  normalizeRect,
  normalizeTrendPoints,
  makeProjection,
  hitTestOverlayDrawings,
  hitTestHorizontal,
  type Projection,
} from "@/lib/utils/chart-drawings";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UseChartDrawingsArgs {
  /** Chart instance ref — owned by the host component. Populated by the
   *  host's chart-creation effect before this hook's effects run. */
  chartRef: MutableRefObject<IChartApi | null>;
  /** Candlestick series ref — used for price<->pixel conversion and for
   *  creating/removing horizontal price lines. */
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  /** DOM container that holds the chart. Observed for resize so the SVG
   *  overlay knows the current width/height. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** When this string changes, all drawings are wiped and native handles
   *  cleaned up. Use `${instrument}|${timeframe}` on live charts; use
   *  `sessionId` on replay charts. Pass a stable value on mount. */
  resetKey: string;
}

/** Preview shape kept in state between the first and second click of a
 *  2-click drawing (trend line, rectangle). Null at all other times. */
export interface PendingDraw {
  tool: DrawingTool;
  points: DrawingPoint[];
}

export interface UseChartDrawingsReturn {
  // State (read by toolbar + overlay)
  activeTool: DrawingTool;
  selectedId: string | null;
  drawings: Drawing[];
  pendingDraw: PendingDraw | null;
  hoverPoint: DrawingPoint | null;
  containerSize: { width: number; height: number };

  // Imperative refs
  /** Host components read this to decide whether to skip their own click
   *  handlers (e.g. live-chart's SL/TP drag) while a drawing tool is active. */
  activeToolRef: MutableRefObject<DrawingTool>;
  /** Live view of the drawings array for imperative consumers (e.g.
   *  the live-chart RAF tick loop that price-cross-checks alerts).
   *  Reading state through a ref avoids tearing down the RAF loop on
   *  every drawing mutation. */
  drawingsRef: MutableRefObject<Drawing[]>;

  // Actions
  setActiveTool: (tool: DrawingTool) => void;
  setSelectedId: (id: string | null) => void;
  deleteDrawing: (id: string) => void;
  clearAll: () => void;
  setDrawingColor: (id: string, color: string) => void;
  /** Mark an alert as fired — flips `armed` to false and stamps
   *  `triggeredAt`. The native-handle reconciliation effect then
   *  restyles the price line (muted color + "FIRED" title). Called
   *  imperatively from the live-chart RAF loop on a price cross. */
  fireAlert: (id: string) => void;
  /** Re-enable a previously-fired alert so it will trigger on the next
   *  cross. Exposed via the drawing toolbar's "Re-arm" button. */
  armAlert: (id: string) => void;

  /** Versioned projection function for the overlay. The version number
   *  bumps on viewport change so consumers re-render. */
  projection: Projection;
  projectionVersion: number;
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useChartDrawings({
  chartRef,
  seriesRef,
  containerRef,
  resetKey,
}: UseChartDrawingsArgs): UseChartDrawingsReturn {
  // ─── State ──────────────────────────────────────────────────────────
  const [activeTool, setActiveToolState] = useState<DrawingTool>(null);
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pendingDraw, setPendingDraw] = useState<PendingDraw | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [projectionVersion, setProjectionVersion] = useState(0);

  // ─── Refs mirroring state (so event handlers don't go stale) ────────
  const activeToolRef = useRef<DrawingTool>(null);
  const selectedIdRef = useRef<string | null>(null);
  const drawingsRef = useRef<Drawing[]>([]);
  const pendingDrawRef = useRef<PendingDraw | null>(null);

  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { drawingsRef.current = drawings; }, [drawings]);
  useEffect(() => { pendingDrawRef.current = pendingDraw; }, [pendingDraw]);

  // Map of drawing id → native lightweight-charts handles. Kept in a ref
  // so we don't recreate handles on every render.
  const handlesRef = useRef<
    Map<string, { priceLine?: unknown; lineSeries?: ISeriesApi<"Line"> }>
  >(new Map());

  // ─── Setters with side effects ──────────────────────────────────────
  const setActiveTool = useCallback((tool: DrawingTool) => {
    setActiveToolState(tool);
    setPendingDraw(null);
    // Selecting a tool clears any existing selection so the toolbar
    // stops showing color/trash affordances for the deselected drawing.
    setSelectedIdState(null);
  }, []);

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
  }, []);

  const deleteDrawing = useCallback((id: string) => {
    setDrawings((prev) => prev.filter((d) => d.id !== id));
    setSelectedIdState((prev) => (prev === id ? null : prev));
  }, []);

  const clearAll = useCallback(() => {
    setDrawings([]);
    setSelectedIdState(null);
    setPendingDraw(null);
    setActiveToolState(null);
  }, []);

  const setDrawingColor = useCallback((id: string, color: string) => {
    setDrawings((prev) => prev.map((d) => (d.id === id ? { ...d, color } : d)));
  }, []);

  // Flip an alert from armed → fired. Idempotent: calling on an
  // already-fired alert is a no-op. The `drawings` reconciliation effect
  // below picks up the state change and restyles the native price line.
  const fireAlert = useCallback((id: string) => {
    setDrawings((prev) => prev.map((d) => {
      if (d.id !== id || d.kind !== "alert" || !d.armed) return d;
      return { ...d, armed: false, triggeredAt: Date.now() };
    }));
  }, []);

  // Flip an alert from fired → armed so it can trigger again. Also
  // clears `triggeredAt` so the display is clean.
  const armAlert = useCallback((id: string) => {
    setDrawings((prev) => prev.map((d) => {
      if (d.id !== id || d.kind !== "alert") return d;
      return { ...d, armed: true, triggeredAt: undefined };
    }));
  }, []);

  // ─── Reconcile native handles when drawings change ──────────────────
  // Creates price lines + LineSeries for new drawings, updates color on
  // existing ones, removes handles for deleted drawings. Rectangles and
  // vertical lines have no native handle — rendered via SVG overlay.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    // Create / update
    for (const d of drawings) {
      const existing = handlesRef.current.get(d.id);
      if (!existing) {
        const handle: { priceLine?: unknown; lineSeries?: ISeriesApi<"Line"> } = {};
        if (d.kind === "hline") {
          handle.priceLine = series.createPriceLine({
            price: d.price,
            color: d.color,
            lineWidth: 2,
            lineStyle: 0,
            axisLabelVisible: true,
            title: "",
          });
        } else if (d.kind === "alert") {
          // Alerts render as dashed price lines with a title so they're
          // immediately distinguishable from plain hlines on the axis label.
          // Armed → full color + "ALERT"; disarmed → muted gray + "FIRED".
          handle.priceLine = series.createPriceLine({
            price: d.price,
            color: d.armed ? d.color : "#52525b",
            lineWidth: 2,
            lineStyle: 2, // Dashed
            axisLabelVisible: true,
            title: d.armed ? "ALERT" : "FIRED",
          });
        } else if (d.kind === "trend") {
          const ls = chart.addSeries(LineSeries, {
            color: d.color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          ls.setData([
            { time: d.p1.time, value: d.p1.price },
            { time: d.p2.time, value: d.p2.price },
          ]);
          handle.lineSeries = ls;
        }
        handlesRef.current.set(d.id, handle);
      } else {
        // Sync color on every render — cheap, idempotent
        if (d.kind === "hline" && existing.priceLine) {
          try {
            // Using unknown; price lines expose applyOptions at runtime
            (existing.priceLine as { applyOptions: (o: { color: string }) => void })
              .applyOptions({ color: d.color });
          } catch { /* handle torn down */ }
        } else if (d.kind === "alert" && existing.priceLine) {
          // Sync both color and title to reflect armed/fired state. This
          // runs whenever fireAlert/armAlert mutates the drawing.
          try {
            (existing.priceLine as {
              applyOptions: (o: { color: string; title: string }) => void;
            }).applyOptions({
              color: d.armed ? d.color : "#52525b",
              title: d.armed ? "ALERT" : "FIRED",
            });
          } catch { /* handle torn down */ }
        } else if (d.kind === "trend" && existing.lineSeries) {
          try { existing.lineSeries.applyOptions({ color: d.color }); } catch { /* noop */ }
        }
      }
    }

    // Remove handles for deleted drawings
    const currentIds = new Set(drawings.map((d) => d.id));
    for (const [id, handle] of Array.from(handlesRef.current.entries())) {
      if (currentIds.has(id)) continue;
      if (handle.priceLine) {
        try { series.removePriceLine(handle.priceLine as Parameters<typeof series.removePriceLine>[0]); } catch { /* noop */ }
      }
      if (handle.lineSeries) {
        try { chart.removeSeries(handle.lineSeries); } catch { /* noop */ }
      }
      handlesRef.current.delete(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawings]);

  // ─── Reset on resetKey change (instrument/timeframe/session swap) ────
  // Runs on mount (no-op — nothing to clean) and whenever the host
  // signals a context change that makes existing drawings irrelevant.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    for (const handle of handlesRef.current.values()) {
      if (handle.priceLine && series) {
        try { series.removePriceLine(handle.priceLine as Parameters<typeof series.removePriceLine>[0]); } catch { /* noop */ }
      }
      if (handle.lineSeries && chart) {
        try { chart.removeSeries(handle.lineSeries); } catch { /* noop */ }
      }
    }
    handlesRef.current.clear();
    setDrawings([]);
    setSelectedIdState(null);
    setPendingDraw(null);
    setActiveToolState(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // ─── Click handler: draw new shape OR select existing ───────────────
  // The host component's chart-creation useEffect usually runs AFTER
  // this effect (effects flush in render order; the hook is called
  // mid-component). So on mount, chartRef.current is still null. We
  // poll via requestAnimationFrame until the chart is ready and then
  // subscribe exactly once. Same pattern used for the crosshair and
  // visible-range subscriptions below.
  useEffect(() => {
    let rafId: number | null = null;
    let installed: null | { chart: IChartApi; fn: (p: MouseEventParams) => void } = null;

    const handler = (param: MouseEventParams) => {
      const series = seriesRef.current;
      if (!series || !param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;

      const tool = activeToolRef.current;

      if (tool) {
        // ─── Drawing mode ────────────────────────────────────────────
        if (tool === "hline") {
          setDrawings((prev) => [
            ...prev,
            { id: makeDrawingId(), kind: "hline", price, color: DRAWING_DEFAULT_COLOR },
          ]);
          setActiveToolState(null);
          return;
        }
        if (tool === "alert") {
          // Place an armed price-alert line at the clicked price. The
          // live-chart's RAF loop will watch for the next cross and call
          // fireAlert() at which point the line mutes and the banner +
          // sound fire. Amber matches the existing current-price line
          // color palette so the UI reads as a "price trigger" line.
          setDrawings((prev) => [
            ...prev,
            { id: makeDrawingId(), kind: "alert", price, color: "#f59e0b", armed: true },
          ]);
          setActiveToolState(null);
          return;
        }
        // Every other tool needs a bar time; bail gracefully if the
        // user clicked off the time axis.
        if (param.time === undefined) return;
        const point: DrawingPoint = { time: param.time as Time, price };

        if (tool === "vline") {
          setDrawings((prev) => [
            ...prev,
            { id: makeDrawingId(), kind: "vline", time: point.time, color: DRAWING_DEFAULT_COLOR },
          ]);
          setActiveToolState(null);
          return;
        }

        // Two-click tools — collect points
        const pending = pendingDrawRef.current;
        if (!pending || pending.points.length === 0) {
          setPendingDraw({ tool, points: [point] });
          return;
        }

        const p1 = pending.points[0];
        if (tool === "trend") {
          const normalized = normalizeTrendPoints(p1, point);
          setDrawings((prev) => [
            ...prev,
            { id: makeDrawingId(), kind: "trend", ...normalized, color: DRAWING_DEFAULT_COLOR },
          ]);
        } else if (tool === "rect") {
          const normalized = normalizeRect(p1, point);
          setDrawings((prev) => [
            ...prev,
            { id: makeDrawingId(), kind: "rect", ...normalized, color: DRAWING_DEFAULT_COLOR },
          ]);
        }
        setPendingDraw(null);
        setActiveToolState(null);
        return;
      }

      // ─── Selection mode (no tool active) ────────────────────────
      const project = makeProjection(chartRef.current, seriesRef.current);
      const overlayHit = hitTestOverlayDrawings(
        drawingsRef.current,
        param.point.x,
        param.point.y,
        project,
      );
      if (overlayHit) {
        setSelectedIdState(overlayHit);
        return;
      }
      const hlineHit = hitTestHorizontal(drawingsRef.current, price);
      if (hlineHit) {
        setSelectedIdState(hlineHit);
        return;
      }
      // Empty space → deselect
      setSelectedIdState(null);
    };

    const install = () => {
      const chart = chartRef.current;
      if (!chart) {
        rafId = requestAnimationFrame(install);
        return;
      }
      chart.subscribeClick(handler);
      installed = { chart, fn: handler };
    };
    install();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (installed) {
        try { installed.chart.unsubscribeClick(installed.fn); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Crosshair move: update hover for ghost preview + viewport bump ──
  useEffect(() => {
    let rafId: number | null = null;
    let installed: null | { chart: IChartApi; fn: (p: MouseEventParams) => void } = null;

    const handler = (param: MouseEventParams) => {
      // Always bump the projection version — cheap proxy for "something
      // on the chart moved" (pan, zoom, price scale autoscale).
      setProjectionVersion((v) => v + 1);

      const series = seriesRef.current;
      if (!series || !param.point) {
        setHoverPoint(null);
        return;
      }
      const price = series.coordinateToPrice(param.point.y);
      if (price === null || param.time === undefined) {
        setHoverPoint(null);
        return;
      }
      setHoverPoint({ time: param.time as Time, price });
    };

    const install = () => {
      const chart = chartRef.current;
      if (!chart) {
        rafId = requestAnimationFrame(install);
        return;
      }
      chart.subscribeCrosshairMove(handler);
      installed = { chart, fn: handler };
    };
    install();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (installed) {
        try { installed.chart.unsubscribeCrosshairMove(installed.fn); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Visible time-range change: bump projection ──────────────────────
  useEffect(() => {
    let rafId: number | null = null;
    let installed: null | { chart: IChartApi; fn: () => void } = null;

    const handler = () => setProjectionVersion((v) => v + 1);

    const install = () => {
      const chart = chartRef.current;
      if (!chart) {
        rafId = requestAnimationFrame(install);
        return;
      }
      chart.timeScale().subscribeVisibleTimeRangeChange(handler);
      installed = { chart, fn: handler };
    };
    install();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (installed) {
        try { installed.chart.timeScale().unsubscribeVisibleTimeRangeChange(installed.fn); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Container size observer ─────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setContainerSize({ width: el.clientWidth, height: el.clientHeight });
      setProjectionVersion((v) => v + 1);
    };
    update(); // initial
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Keyboard: Escape cancels draw/select; Delete removes selected ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingDrawRef.current) setPendingDraw(null);
        if (activeToolRef.current) setActiveToolState(null);
        if (selectedIdRef.current) setSelectedIdState(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Don't interfere with typing in inputs/textareas/editors.
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName.toLowerCase() ?? "";
        if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;
        const id = selectedIdRef.current;
        if (!id) return;
        e.preventDefault();
        setDrawings((prev) => prev.filter((d) => d.id !== id));
        setSelectedIdState(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ─── Unmount cleanup: remove any remaining native handles ───────────
  // Reads refs at cleanup time (not at effect setup) because the host's
  // chart-creation effect runs AFTER this one, so chartRef.current is
  // still null if we captured it at setup. Cleanups run in reverse order
  // at unmount, so this fires BEFORE chart.remove() and the handles are
  // still valid (wrapped in try/catch as a belt-and-braces measure).
  useEffect(() => {
    return () => {
      const series = seriesRef.current;
      const chart = chartRef.current;
      for (const handle of handlesRef.current.values()) {
        if (handle.priceLine && series) {
          try { series.removePriceLine(handle.priceLine as Parameters<typeof series.removePriceLine>[0]); } catch { /* noop */ }
        }
        if (handle.lineSeries && chart) {
          try { chart.removeSeries(handle.lineSeries); } catch { /* noop */ }
        }
      }
      handlesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Projection (recomputed on every render; cheap) ─────────────────
  const projection = makeProjection(chartRef.current, seriesRef.current);

  return {
    activeTool,
    selectedId,
    drawings,
    pendingDraw,
    hoverPoint,
    containerSize,
    activeToolRef,
    drawingsRef,
    setActiveTool,
    setSelectedId,
    deleteDrawing,
    clearAll,
    setDrawingColor,
    fireAlert,
    armAlert,
    projection,
    projectionVersion,
  };
}
