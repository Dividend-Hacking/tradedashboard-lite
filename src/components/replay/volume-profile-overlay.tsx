"use client";

/**
 * VolumeProfileOverlay — SVG histogram drawn on top of the
 * lightweight-charts candle layer. Each price level becomes one
 * horizontal bar; longest bar = highest-volume level.
 *
 * Why an SVG sibling instead of a chart series:
 *   Lightweight-charts has no built-in histogram-by-price primitive.
 *   We could fake it with many thin LineSeries, but that loses pixel
 *   control over bar widths and forces every level to live on the
 *   timeline (which they don't — VP is fixed-x, varies-y). An SVG
 *   sibling positioned via `series.priceToCoordinate()` keeps the
 *   profile glued to the price axis no matter how the chart pans /
 *   zooms / autoscales.
 *
 * Render loop:
 *   Lightweight-charts can change the visible price range at any time
 *   (autoscale on data update, manual zoom, indicator panes pushing
 *   pane bounds). It exposes a logical-range subscription for time but
 *   no equivalent for the price scale, so we use a requestAnimationFrame
 *   poll while the profile is mounted. The work per frame is ~one
 *   priceToCoordinate call per level (typically 30-200 levels) plus a
 *   single React state update if any coordinate changed — cheap enough
 *   to run continuously.
 *
 * Layout:
 *   Profile occupies a fixed `widthPx` slice on the LEFT side of the
 *   chart, leaving the right price scale untouched. Bars grow
 *   left-to-right from the chart's left edge so they don't fight the
 *   axis labels on the right.
 *
 * Bid/ask split:
 *   When `splitBidAsk` is true and the level has any side data, we
 *   render two stacked rectangles per bar: ask volume (buy-aggressor)
 *   on the left in green, bid volume (sell-aggressor) on the right in
 *   red, with any unattributed remainder filled in muted grey. When
 *   the toggle is off, a single neutral bar is drawn. POC and value-
 *   area styling sits on top of either layout.
 */

import { useEffect, useRef, useState } from "react";
import type { ISeriesApi, Time } from "lightweight-charts";
import type { VolumeProfile } from "@/lib/utils/volume-profile";

interface VolumeProfileOverlayProps {
  profile: VolumeProfile;
  /** Live ref to the candlestick series so we can call
   *  `priceToCoordinate(price)` on every render frame. The component
   *  doesn't keep its own copy of the chart; it just polls. */
  seriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  /** Total chart container size — drives the SVG viewBox so bar
   *  widths and the right-edge clip both stay correct on resize. */
  width: number;
  height: number;
  /** Histogram width in px, measured from the chart's LEFT edge. */
  widthPx?: number;
  /** Render bid/ask stacked bars when side data is present. */
  splitBidAsk?: boolean;
}

/** Per-level layout result computed each rAF tick. Stored in state so
 *  the SVG re-renders only when y coordinates actually change. */
interface LevelLayout {
  yTop: number;
  yBottom: number;
  total: number;
  bid: number;
  ask: number;
  isPoc: boolean;
  inValueArea: boolean;
}

const PROFILE_DEFAULT_WIDTH_PX = 180;

export default function VolumeProfileOverlay({
  profile,
  seriesRef,
  width,
  height,
  widthPx = PROFILE_DEFAULT_WIDTH_PX,
  splitBidAsk = true,
}: VolumeProfileOverlayProps) {
  const [layouts, setLayouts] = useState<LevelLayout[]>([]);
  const [pocY, setPocY] = useState<number | null>(null);
  const [vahY, setVahY] = useState<number | null>(null);
  const [valY, setValY] = useState<number | null>(null);

  // Cache the last frame's serialized state so we can short-circuit the
  // setLayouts call when nothing moved (typical case while the chart
  // sits idle). Avoids spurious React renders inside the rAF loop.
  const lastSigRef = useRef<string>("");

  useEffect(() => {
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const series = seriesRef.current;
      if (!series || profile.levels.length === 0) {
        // No series yet (chart still mounting) or empty profile — keep
        // the layout empty and try again next frame.
        if (lastSigRef.current !== "empty") {
          setLayouts([]);
          setPocY(null);
          setVahY(null);
          setValY(null);
          lastSigRef.current = "empty";
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      // Build layouts. priceToCoordinate returns null when the price
      // is outside the visible range — skip those levels entirely so a
      // zoomed-in chart only paints the slice the user can see.
      const next: LevelLayout[] = [];
      const sigParts: string[] = [];
      for (const lvl of profile.levels) {
        const yTop = series.priceToCoordinate(lvl.priceHigh as number);
        const yBottom = series.priceToCoordinate(lvl.priceLow as number);
        if (yTop == null || yBottom == null) continue;

        const isPoc =
          profile.poc != null &&
          lvl.priceLow <= profile.poc &&
          profile.poc < lvl.priceHigh;
        const inValueArea =
          profile.val != null &&
          profile.vah != null &&
          lvl.priceHigh > profile.val &&
          lvl.priceLow < profile.vah;

        next.push({
          yTop,
          yBottom,
          total: lvl.totalVolume,
          bid: lvl.bidVolume,
          ask: lvl.askVolume,
          isPoc,
          inValueArea,
        });
        // Round to whole pixels in the signature so sub-pixel jitter
        // doesn't trigger renders every frame.
        sigParts.push(`${Math.round(yTop)}:${Math.round(yBottom)}`);
      }

      const newPocY =
        profile.poc != null ? series.priceToCoordinate(profile.poc as number) : null;
      const newVahY =
        profile.vah != null ? series.priceToCoordinate(profile.vah as number) : null;
      const newValY =
        profile.val != null ? series.priceToCoordinate(profile.val as number) : null;

      const sig = sigParts.join("|") + `#${Math.round(newPocY ?? -1)}/${Math.round(newVahY ?? -1)}/${Math.round(newValY ?? -1)}`;
      if (sig !== lastSigRef.current) {
        setLayouts(next);
        setPocY(newPocY);
        setVahY(newVahY);
        setValY(newValY);
        lastSigRef.current = sig;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [profile, seriesRef]);

  if (profile.levels.length === 0 || width === 0 || height === 0) {
    return null;
  }

  // Bar widths are scaled to the longest level so the longest bar fills
  // the entire overlay width. Leaving a small right-side gutter keeps
  // the profile from running into the candle bodies.
  const RIGHT_GUTTER_PX = 4;
  const usableWidth = Math.max(0, widthPx - RIGHT_GUTTER_PX);
  const maxVol = profile.maxLevelVolume || 1;

  return (
    <svg
      // z-20 keeps the histogram above the chart's own canvases (which
      // sit in their own stacking context inside containerRef) but below
      // the drawing layer (z-30) so user-drawn lines stay legible. Match
      // it to whatever DrawingOverlay uses if that ever changes.
      className="pointer-events-none absolute inset-0 z-20"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Translucent backdrop so the profile reads as its own layer
          even on a busy chart. Only covers the histogram band on the
          left edge; the rest of the chart shows through. */}
      <rect x={0} y={0} width={widthPx} height={height} fill="rgba(17, 17, 24, 0.55)" />

      {/* Value area shaded band — drawn under the bars so they can sit
          on top with full opacity. Skipped when VAH/VAL haven't been
          computed yet (empty profile). */}
      {vahY != null && valY != null && (
        <rect
          x={0}
          y={Math.min(vahY, valY)}
          width={widthPx}
          height={Math.abs(valY - vahY)}
          fill="rgba(139, 92, 246, 0.08)"
        />
      )}

      {layouts.map((lvl, i) => {
        // Bar height in px. Lightweight-charts can return tiny sub-pixel
        // values when the price scale is zoomed way out — clamp to at
        // least 1 px so every level is still visible.
        const barTop = Math.min(lvl.yTop, lvl.yBottom);
        const barHeight = Math.max(1, Math.abs(lvl.yBottom - lvl.yTop));
        const totalWidth = (lvl.total / maxVol) * usableWidth;

        // Color the bar based on POC / VA membership. POC is the brightest
        // accent; VA bars are tinted; the rest are a muted grey so the
        // profile's center of gravity stands out at a glance.
        const baseFill = lvl.isPoc
          ? "#f59e0b"
          : lvl.inValueArea
            ? "#a78bfa"
            : "#475569";

        if (!splitBidAsk || (lvl.bid === 0 && lvl.ask === 0)) {
          // Plain single-color bar — used when the dataset has no side
          // attribution or the user has turned the split off.
          return (
            <rect
              key={i}
              x={0}
              y={barTop}
              width={totalWidth}
              height={barHeight}
              fill={baseFill}
              opacity={0.85}
            />
          );
        }

        // Stacked bid/ask bar. Order: ask (green, buy-aggressor) on the
        // left because lifting the ask is the canonical "bullish" print
        // and traders read profiles left→right; bid (red) on the right;
        // any unattributed leftover gets the base color so the totals
        // still match `lvl.total`.
        const askWidth = (lvl.ask / maxVol) * usableWidth;
        const bidWidth = (lvl.bid / maxVol) * usableWidth;
        const restWidth = Math.max(0, totalWidth - askWidth - bidWidth);

        return (
          <g key={i} opacity={0.9}>
            <rect x={0} y={barTop} width={askWidth} height={barHeight} fill="#22c55e" />
            <rect
              x={askWidth}
              y={barTop}
              width={bidWidth}
              height={barHeight}
              fill="#ef4444"
            />
            {restWidth > 0 && (
              <rect
                x={askWidth + bidWidth}
                y={barTop}
                width={restWidth}
                height={barHeight}
                fill={baseFill}
              />
            )}
            {/* POC outline highlight overlays the stacked bar so the
                level reads as the focal point even in split mode. */}
            {lvl.isPoc && (
              <rect
                x={0}
                y={barTop}
                width={totalWidth}
                height={barHeight}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={1}
              />
            )}
          </g>
        );
      })}

      {/* POC line — extends across the full chart so it doubles as a
          visible support/resistance reference. Drawn last so it sits
          above the bars. */}
      {pocY != null && (
        <line
          x1={0}
          y1={pocY}
          x2={width}
          y2={pocY}
          stroke="#f59e0b"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      )}
      {/* Value-area edges — thin dashed lines across the chart so the
          70% volume band is legible at a glance without having to read
          the histogram colors. */}
      {vahY != null && (
        <line
          x1={0}
          y1={vahY}
          x2={width}
          y2={vahY}
          stroke="#a78bfa"
          strokeWidth={1}
          strokeDasharray="2 4"
          opacity={0.7}
        />
      )}
      {valY != null && (
        <line
          x1={0}
          y1={valY}
          x2={width}
          y2={valY}
          stroke="#a78bfa"
          strokeWidth={1}
          strokeDasharray="2 4"
          opacity={0.7}
        />
      )}

      {/* Compact legend in the upper-left of the histogram. Shows the
          POC price and VA range so users don't have to estimate them
          off the bars. */}
      {profile.poc != null && (
        <g>
          <text
            x={6}
            y={14}
            fill="#f59e0b"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fontSize={10}
          >
            POC {profile.poc.toFixed(2)}
          </text>
          {profile.vah != null && profile.val != null && (
            <text
              x={6}
              y={28}
              fill="#a78bfa"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fontSize={10}
            >
              VA {profile.val.toFixed(2)} – {profile.vah.toFixed(2)}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}

// Re-exported so callers don't have to import lightweight-charts' Time
// type just to declare a series ref. (Kept narrow to the candlestick
// shape we use in ReplayChart.)
export type CandleSeriesRef = React.RefObject<ISeriesApi<"Candlestick"> | null>;
export type { Time };
