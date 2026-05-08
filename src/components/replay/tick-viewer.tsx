"use client";

/**
 * TickViewer — Tick-data visualization for the /replay/[sessionId] page.
 *
 * Tick sessions store their data as a gzipped CSV blob in Supabase Storage
 * (one file per session, e.g. `replay-ticks/session-503.csv.gz`) rather than
 * rows in `replay_bars`, because a busy NQ day is 3-8M trades. This component:
 *
 *   1. Downloads the gzipped blob from a server-issued signed URL.
 *   2. Decompresses it via the browser's native `DecompressionStream`.
 *   3. Parses the CSV into typed arrays (memory-efficient, cache-friendly).
 *   4. Lets the user pick any aggregation mode — time-based bars (15s, 1m,
 *      24s, etc.) or tick-count-based bars (100t, 1000t, etc.).
 *   5. Re-aggregates synchronously from the in-memory typed arrays whenever
 *      the mode changes (~10-100ms even for millions of ticks), so timeframe
 *      switching feels instant.
 *   6. Feeds the synthesized `ReplayBar[]` into the existing `ReplayChart`
 *      with practice/trade overlays disabled — v1 is read-only viewing.
 *
 * Performance budget for an 8M-tick day:
 *   download:      ~3-5s on a fast connection (~50MB gzipped)
 *   decompress:    ~0.5-1s
 *   parse:         ~2-3s (single forward pass over the text)
 *   aggregate:     ~50-200ms
 *   re-aggregate:  ~50-200ms (memoized; only runs when mode changes)
 *
 * Memory: ~100MB for the typed arrays of an 8M-tick day. Released when the
 * component unmounts (no IndexedDB cache yet).
 *
 * What this component intentionally does NOT do (follow-up work):
 *   - Practice trading on tick playback (needs a tick-aware playback engine)
 *   - Volume profile / footprint overlay
 *   - Web Worker offload (initial parse blocks the main thread for a few
 *     seconds; loading spinner makes that visible — fix later if it bites)
 *   - IndexedDB cache (re-fetch every time the page loads)
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { ReplaySession, ReplayBar } from "@/types/replay";
import type { IndicatorConfig } from "@/types/indicators";
import {
  decompressGzip,
  parseTickCsv,
  aggregateTicks,
  type ParsedTicks,
  type AggregationMode,
} from "@/lib/utils/tick-aggregation";
import {
  computeVolumeProfile,
  type VolumeProfile,
} from "@/lib/utils/volume-profile";
import { lookupTickSpec } from "@/lib/utils/futures";
import ReplayChart from "./replay-chart";

interface TickViewerProps {
  session: ReplaySession;
  /** Pre-signed Storage URL for the gzipped CSV. The page generates this
   *  server-side so this client component never needs the Supabase client. */
  signedUrl: string;
}

/** Loading phases shown to the user while the blob is being prepared. */
type LoadState =
  | { kind: "downloading"; loaded: number; total: number | null }
  | { kind: "decompressing" }
  | { kind: "parsing" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** Time-unit dropdown options when the user is in "time" mode. */
type TimeUnit = "seconds" | "minutes";

/** Quick-chip presets so the common cases are one click. */
const QUICK_CHIPS: ReadonlyArray<{ label: string; mode: AggregationMode }> = [
  { label: "15s",   mode: { kind: "time",  seconds: 15 } },
  { label: "30s",   mode: { kind: "time",  seconds: 30 } },
  { label: "1m",    mode: { kind: "time",  seconds: 60 } },
  { label: "5m",    mode: { kind: "time",  seconds: 300 } },
  { label: "15m",   mode: { kind: "time",  seconds: 900 } },
  { label: "100t",  mode: { kind: "ticks", count: 100 } },
  { label: "500t",  mode: { kind: "ticks", count: 500 } },
  { label: "1000t", mode: { kind: "ticks", count: 1000 } },
];

/** Compare two AggregationModes for chip-active highlighting. */
function modesEqual(a: AggregationMode, b: AggregationMode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "time" && b.kind === "time") return a.seconds === b.seconds;
  if (a.kind === "ticks" && b.kind === "ticks") return a.count === b.count;
  return false;
}

export default function TickViewer({ session, signedUrl }: TickViewerProps) {
  // Parsed-tick storage. Held in a ref because the typed arrays are large
  // (tens of MB) and we don't want React to capture them in render closures
  // or trigger re-renders just because they exist. Mutated exactly once
  // when parsing completes.
  const ticksRef = useRef<ParsedTicks | null>(null);

  // Load-state drives the loading-overlay UI. The "ready" transition
  // happens *after* `ticksRef.current` is set so render() can safely read it.
  const [loadState, setLoadState] = useState<LoadState>({
    kind: "downloading",
    loaded: 0,
    total: null,
  });

  // Aggregation mode. Defaults to 1-minute candles, which is familiar and
  // gives ~390-1000 bars for a typical session — comfortable for the chart.
  const [mode, setMode] = useState<AggregationMode>({ kind: "time", seconds: 60 });

  // Custom-period inputs. Kept as separate state from `mode` so users can
  // type "24" then pick a unit without us repeatedly re-aggregating on
  // intermediate keystrokes. We sync to `mode` only when both are valid.
  const [customPeriod, setCustomPeriod] = useState<string>("60");
  const [customUnit, setCustomUnit] = useState<TimeUnit>("seconds");
  const [customKind, setCustomKind] = useState<"time" | "ticks">("time");

  // Indicator configs are local-only — we don't persist tick-mode prefs to
  // the user's profile yet (would conflict with the existing
  // practice_indicators field which is OHLCV-shaped). Empty by default.
  const [indicatorConfigs, setIndicatorConfigs] = useState<IndicatorConfig[]>([]);

  // ─── Volume profile state ────────────────────────────────────────────────
  // Profile is computed lazily (only when the user toggles it on) because
  // walking 5M+ ticks costs ~10-50 ms — fine on demand, wasteful on every
  // mount. Recomputes when the bucket multiplier changes; otherwise stays
  // sticky so toggling the overlay off and on doesn't pay the cost again.
  const [profileEnabled, setProfileEnabled] = useState(false);
  // Bucket size = instrument tick × multiplier. 1 tick gives the highest
  // resolution; larger multiples produce a smoother, less noisy profile
  // that's easier to read on a long session.
  const [profileBucketMult, setProfileBucketMult] = useState(1);
  const [profileSplitBidAsk, setProfileSplitBidAsk] = useState(true);
  const [profile, setProfile] = useState<VolumeProfile | null>(null);

  // Look up the instrument's tick size once. Falls back to 0.25 (the
  // most common futures tick size) if the symbol isn't in our table —
  // the profile is still useful, just bucketed at a sensible default.
  const instrumentTickSize = useMemo(() => {
    const spec = lookupTickSpec(session.instrument);
    return spec?.tickSize ?? 0.25;
  }, [session.instrument]);

  // ─── Load pipeline ───────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 1. Download the gzipped blob, streaming so we can show progress.
        const resp = await fetch(signedUrl);
        if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

        const totalHeader = resp.headers.get("content-length");
        const total = totalHeader ? parseInt(totalHeader, 10) : null;
        if (!resp.body) throw new Error("Empty response body");

        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loaded += value.length;
            if (!cancelled) {
              setLoadState({ kind: "downloading", loaded, total });
            }
          }
        }
        if (cancelled) return;

        // Concatenate into a single buffer for DecompressionStream.
        const total2 = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(total2);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }

        // 2. Decompress.
        setLoadState({ kind: "decompressing" });
        const text = await decompressGzip(merged.buffer);
        if (cancelled) return;

        // 3. Parse. This is the longest CPU step on a busy day.
        // We yield to the event loop once before starting so the
        // "Parsing…" UI label has a chance to paint.
        setLoadState({ kind: "parsing" });
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;

        const ticks = parseTickCsv(text);
        if (cancelled) return;

        ticksRef.current = ticks;
        setLoadState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadState({ kind: "error", message });
      }
    })();

    return () => {
      cancelled = true;
      // Drop the typed arrays so V8 can reclaim ~100MB on unmount.
      ticksRef.current = null;
    };
  }, [signedUrl]);

  // ─── Aggregation ─────────────────────────────────────────────────────────

  // Recompute synthesized bars whenever the mode changes (or the load
  // pipeline transitions to "ready"). The ticksRef value is stable across
  // mode changes, so this is cheap to recompute — no re-fetch.
  // We include `loadState.kind` in the deps to retrigger after parse completes;
  // depending on `ticksRef.current` directly wouldn't work because refs
  // don't drive re-renders.
  const bars: ReplayBar[] = useMemo(() => {
    if (loadState.kind !== "ready" || !ticksRef.current) return [];
    return aggregateTicks(ticksRef.current, mode, session.id);
  }, [mode, loadState.kind, session.id]);

  // ─── Profile computation ────────────────────────────────────────────────
  // Pure derivation off the parsed tick arrays. Triggered only when the
  // overlay is enabled so the cost doesn't get paid on every page mount.
  // Recomputes when bucket multiplier flips or fresh ticks land. We deliberately
  // recompute inside an effect (not useMemo) so the heavy reduce never blocks
  // a render — if the user toggles the overlay back off mid-compute, the
  // result still arrives but the chart simply hides it.
  useEffect(() => {
    if (!profileEnabled) {
      setProfile(null);
      return;
    }
    if (loadState.kind !== "ready" || !ticksRef.current) return;

    let cancelled = false;
    // Defer one tick so the "Profile" button click can paint its loading
    // state before we hog the main thread for ~10-50 ms.
    const handle = setTimeout(() => {
      if (cancelled || !ticksRef.current) return;
      const result = computeVolumeProfile(ticksRef.current, {
        bucketSize: instrumentTickSize * profileBucketMult,
      });
      if (!cancelled) setProfile(result);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [profileEnabled, profileBucketMult, instrumentTickSize, loadState.kind]);

  // ─── Mode handlers ───────────────────────────────────────────────────────

  /** Apply a quick-chip preset. Also syncs the custom inputs so the form
   *  reflects what's active. */
  const handleChip = useCallback((m: AggregationMode) => {
    setMode(m);
    if (m.kind === "time") {
      setCustomKind("time");
      // Pick the cleaner unit representation when possible.
      if (m.seconds % 60 === 0 && m.seconds >= 60) {
        setCustomUnit("minutes");
        setCustomPeriod(String(m.seconds / 60));
      } else {
        setCustomUnit("seconds");
        setCustomPeriod(String(m.seconds));
      }
    } else {
      setCustomKind("ticks");
      setCustomPeriod(String(m.count));
    }
  }, []);

  /** Apply the current custom-period inputs. Validates positive integer. */
  const applyCustom = useCallback(() => {
    const n = Number(customPeriod);
    if (!isFinite(n) || n <= 0) return;
    if (customKind === "ticks") {
      if (!Number.isInteger(n)) return;
      setMode({ kind: "ticks", count: n });
    } else {
      const seconds = customUnit === "minutes" ? n * 60 : n;
      setMode({ kind: "time", seconds });
    }
  }, [customPeriod, customUnit, customKind]);

  // Submit the custom form on Enter.
  const onCustomKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") applyCustom();
    },
    [applyCustom]
  );

  // ─── Render helpers ──────────────────────────────────────────────────────

  const granularityLabel =
    session.granularity === "tick_bidask" ? "Tick + Bid/Ask Side" : "Tick";

  const tickCountLabel = (session.tick_count ?? ticksRef.current?.count ?? 0).toLocaleString();
  const dateStr = new Date(session.session_date + "T00:00:00").toLocaleDateString();

  // Pretty-print the active mode for the "→ X bars at Y" status text.
  const modeDescription =
    mode.kind === "time"
      ? mode.seconds % 60 === 0 && mode.seconds >= 60
        ? `${mode.seconds / 60} minute`
        : `${mode.seconds} second`
      : `${mode.count} tick`;

  // ─── Loading overlay ─────────────────────────────────────────────────────

  let loadingOverlay: React.ReactNode = null;
  if (loadState.kind !== "ready") {
    let label = "";
    let detail = "";
    if (loadState.kind === "downloading") {
      label = "Downloading tick blob…";
      const mbLoaded = (loadState.loaded / 1_048_576).toFixed(1);
      detail = loadState.total
        ? `${mbLoaded} / ${(loadState.total / 1_048_576).toFixed(1)} MB`
        : `${mbLoaded} MB`;
    } else if (loadState.kind === "decompressing") {
      label = "Decompressing…";
    } else if (loadState.kind === "parsing") {
      label = "Parsing ticks…";
      detail = "this can take a few seconds for a busy day";
    } else if (loadState.kind === "error") {
      label = "Failed to load tick data";
      detail = loadState.message;
    }
    loadingOverlay = (
      <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-20">
        <div className="bg-card border border-card-border rounded-lg p-6 max-w-sm text-center flex flex-col gap-2">
          <p className={`text-sm font-medium ${loadState.kind === "error" ? "text-accent-red" : "text-foreground"}`}>
            {label}
          </p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="relative h-full flex flex-col gap-2">
      {/* Header — instrument, date, granularity badge, raw-blob download link, back. */}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">
            {session.instrument} <span className="text-muted-foreground">— {dateStr}</span>
          </h1>
          <span className="text-xs px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green font-medium">
            {granularityLabel}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {tickCountLabel} ticks
          </span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={signedUrl}
            download
            className="text-xs text-muted-foreground hover:text-foreground"
            title="Download the raw gzipped CSV"
          >
            ↓ Raw CSV
          </a>
          <Link
            href="/replay"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back
          </Link>
        </div>
      </div>

      {/* Aggregation controls — quick chips + custom period input. */}
      <div className="flex items-center gap-3 flex-wrap px-1 py-2 border-y border-card-border text-xs">
        {/* Quick chips */}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground mr-1">Quick:</span>
          {QUICK_CHIPS.map((chip) => {
            const active = modesEqual(chip.mode, mode);
            return (
              <button
                key={chip.label}
                onClick={() => handleChip(chip.mode)}
                className={`px-2 py-1 rounded transition-colors ${
                  active
                    ? "bg-accent-green/20 text-accent-green border border-accent-green/40"
                    : "bg-background border border-card-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Custom period */}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground mr-1">Custom:</span>
          <input
            type="number"
            min={1}
            value={customPeriod}
            onChange={(e) => setCustomPeriod(e.target.value)}
            onKeyDown={onCustomKeyDown}
            className="w-16 bg-background border border-card-border rounded px-2 py-1 text-foreground
                       focus:outline-none focus:border-muted"
          />
          <select
            value={customKind === "ticks" ? "ticks" : customUnit}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "ticks") {
                setCustomKind("ticks");
              } else {
                setCustomKind("time");
                setCustomUnit(v as TimeUnit);
              }
            }}
            className="bg-background border border-card-border rounded px-2 py-1 text-foreground
                       focus:outline-none focus:border-muted"
          >
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="ticks">Ticks</option>
          </select>
          <button
            onClick={applyCustom}
            className="px-2 py-1 rounded bg-accent-green/20 text-accent-green
                       border border-accent-green/40 hover:bg-accent-green/30 transition-colors"
          >
            Apply
          </button>
        </div>

        {/* Volume profile controls — toggle, bucket multiplier, and the
            bid/ask split flag. The compute is async and stickied; flipping
            the toggle off hides the overlay without throwing the result
            away, so re-enabling is instant. The bucket multiplier expresses
            the bin width in instrument ticks (1 = native tick size, e.g.
            0.25 for NQ). Higher multiples = chunkier, smoother profile. */}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground mr-1">Profile:</span>
          <button
            onClick={() => setProfileEnabled((v) => !v)}
            className={`px-2 py-1 rounded transition-colors ${
              profileEnabled
                ? "bg-accent-green/20 text-accent-green border border-accent-green/40"
                : "bg-background border border-card-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {profileEnabled ? "On" : "Off"}
          </button>
          {profileEnabled && (
            <>
              <select
                value={profileBucketMult}
                onChange={(e) => setProfileBucketMult(Number(e.target.value))}
                className="bg-background border border-card-border rounded px-2 py-1 text-foreground
                           focus:outline-none focus:border-muted"
                title="Bucket size in instrument ticks"
              >
                <option value={1}>1× tick</option>
                <option value={2}>2× tick</option>
                <option value={4}>4× tick</option>
                <option value={8}>8× tick</option>
                <option value={16}>16× tick</option>
              </select>
              <button
                onClick={() => setProfileSplitBidAsk((v) => !v)}
                className={`px-2 py-1 rounded transition-colors ${
                  profileSplitBidAsk
                    ? "bg-background border border-card-border text-foreground"
                    : "bg-background border border-card-border text-muted-foreground hover:text-foreground"
                }`}
                title="Stack bid/ask volume per level when side data is present"
              >
                {profileSplitBidAsk ? "Bid/Ask" : "Total"}
              </button>
            </>
          )}
        </div>

        {/* Result summary */}
        <span className="text-muted-foreground ml-auto tabular-nums">
          → {bars.length.toLocaleString()} {modeDescription} bar{bars.length === 1 ? "" : "s"}
          {profileEnabled && profile && (
            <span className="ml-3">
              · {profile.levels.length} levels · {profile.totalVolume.toLocaleString()} vol
            </span>
          )}
        </span>
      </div>

      {/* Chart. We disable trade/zone overlays since this is a read-only
          viewer; ReplayChart still gives us indicators, drawings, and pan/zoom. */}
      <div className="flex-1 min-h-0 relative">
        <ReplayChart
          visibleBars={bars}
          positions={[]}
          openPosition={null}
          zones={[]}
          sessionId={String(session.id)}
          indicatorConfigs={indicatorConfigs}
          onIndicatorsChange={setIndicatorConfigs}
          showActiveZoneOverlays={false}
          showCompletedZoneOverlays={false}
          showTradeOverlays={false}
          volumeProfile={profile}
          volumeProfileSplitBidAsk={profileSplitBidAsk}
        />
      </div>

      {loadingOverlay}
    </div>
  );
}
