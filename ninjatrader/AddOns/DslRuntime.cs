// DslRuntime.cs
//
// Runtime helpers for transpiled DSL strategies. The transpiler emits
// references like _dsl.BarsSinceCondition(...) / _dsl.AnyBarIn(...) and
// this AddOn provides the matching C# implementations.
//
// Design parallels src/lib/utils/strategy-evaluator.ts so the dashboard
// and NT8 produce the same per-bar values:
//
//   - FiringTracker: mirrors the firingsLong / firingsShort lists. The
//     base strategy (DslStrategyBase) pushes onto these every bar that
//     LongCondition() / ShortCondition() return true. bars_since(signal.long)
//     reads the most-recent firing index.
//
//   - BarsSinceCondition: walks back from the current bar looking for
//     the most-recent bar where a user condition was true. The transpiler
//     emits a lambda that re-evaluates the condition at any bar offset.
//
//   - AnyBarIn: re-evaluates the inner condition at offsets 0..N-1 and
//     OR-reduces. Mirrors evalAnyBarIn — special form, no eager arg
//     eval, fresh let-cache per inner bar (handled by the transpiler
//     inlining lets into the lambda body).
//
// Each generated strategy holds ONE DslRuntime instance (`_dsl`). The
// instance scopes per-call-site state (cross-up/down previous values
// keyed by slot id) so multiple cross_up calls in one script don't
// share state. Slot ids are assigned by the transpiler at AST walk
// time and remain stable across runs of the same script.

using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// Static utility class shared by the transpiler-emitted strategies +
    /// our own AddOn code. NT8 runs on the .NET Framework 4.x toolchain
    /// embedded in NinjaTrader, which does NOT expose `double.IsFinite()`
    /// (that arrived in .NET Core 2.1 / .NET Framework 4.8). The transpiler
    /// uses `IsFinite` extensively for NaN-as-fail discipline, so we
    /// route every call through this shim — one place to fix if NT8
    /// upgrades the runtime later.
    /// </summary>
    public static class Dsl
    {
        public static bool IsFinite(double x)
        {
            return !double.IsNaN(x) && !double.IsInfinity(x);
        }
    }

    /// <summary>
    /// Per-strategy runtime helper. One instance per generated strategy;
    /// constructed in DslStrategyBase.OnStateChange(State.DataLoaded).
    /// </summary>
    public class DslRuntime
    {
        // ─── Signal firing tracker ─────────────────────────────────────
        // Mirrors firingsLong / firingsShort in strategy-evaluator.ts.
        // Each entry is a CurrentBar index where the corresponding
        // signal.<side>.if last evaluated to true. The base strategy
        // pushes via OnLongFired / OnShortFired immediately after the
        // condition evaluates.
        //
        // We keep them as Lists rather than capping to "most recent"
        // so a future change that needs the full firing history (per-day
        // counts, decay-based weighting) doesn't need a schema change.

        private readonly List<int> _firingsLong = new List<int>();
        private readonly List<int> _firingsShort = new List<int>();

        public void OnLongFired(int currentBar) { _firingsLong.Add(currentBar); }
        public void OnShortFired(int currentBar) { _firingsShort.Add(currentBar); }

        /// <summary>
        /// Bars elapsed since the most recent long firing, or
        /// double.PositiveInfinity if the strategy hasn't fired a long yet.
        /// Mirrors the bars_since(signal.long) fast path in
        /// strategy-evaluator.ts:910.
        /// </summary>
        public double BarsSinceLastFiringLong(int currentBar)
        {
            if (_firingsLong.Count == 0) return double.PositiveInfinity;
            return currentBar - _firingsLong[_firingsLong.Count - 1];
        }

        public double BarsSinceLastFiringShort(int currentBar)
        {
            if (_firingsShort.Count == 0) return double.PositiveInfinity;
            return currentBar - _firingsShort[_firingsShort.Count - 1];
        }

        // ─── BarsSinceCondition (generic) ──────────────────────────────
        //
        // For bars_since(<custom condition>), the transpiler emits a
        // lambda that takes a bar-offset (0 = current bar, 1 = one bar
        // back, …) and returns true when the condition was true at that
        // offset. This helper walks offsets 0..currentBar and returns
        // the smallest k where the lambda returns true. PositiveInfinity
        // when no match.
        //
        // Mirrors evalBarsSince in strategy-evaluator.ts:910 — same cap
        // behavior, same +Infinity sentinel. Linear in CurrentBar in the
        // worst case (condition never true); typical cooldown searches
        // exit within a few bars.

        public double BarsSinceCondition(int currentBar, Func<int, bool> condAtOffset)
        {
            // currentBar is the absolute bar index (NT8 CurrentBar).
            // Offsets walk 0..currentBar; a negative resulting absolute
            // bar would be out of range so we cap at the current bar.
            for (int k = 0; k <= currentBar; k++)
            {
                if (condAtOffset(k)) return k;
            }
            return double.PositiveInfinity;
        }

        // ─── AnyBarIn ─────────────────────────────────────────────────
        //
        // Mirrors evalAnyBarIn in strategy-evaluator.ts:889.
        // any_bar_in(N, condition) is a special form: evaluate the
        // inner condition at offsets 0..N-1 from the current bar with
        // a fresh let-cache per offset, OR-reduce. The transpiler
        // inlines lets into the lambda body so we don't need per-call
        // let-cache management here.
        //
        // Edge cases:
        //   - N is non-finite (e.g. +Infinity from bars_since on a never-
        //     fired signal) → return false (0 iterations). Mirrors the
        //     dashboard which returns 0 for invalid N.
        //   - N <= 0 → return false.
        //   - N exceeds available history (currentBar+1 < N) → cap at
        //     available bars.

        // Returns 1.0 / 0.0 (NOT bool) so it composes with the rest of the
        // DSL value world — every other expression yields double, and the
        // transpiler downstream wraps results in NaN-aware double ops like
        // `double.IsNaN(x)` / `x != 0.0`. A bool return would crash those.
        public double AnyBarIn(int currentBar, double n, Func<int, bool> condAtOffset)
        {
            if (!Dsl.IsFinite(n) || n <= 0) return 0.0;
            int N = (int)System.Math.Round(n, System.MidpointRounding.AwayFromZero);
            if (N <= 0) return 0.0;
            for (int k = 0; k < N; k++)
            {
                if (currentBar - k < 0) break;
                if (condAtOffset(k)) return 1.0;
            }
            return 0.0;
        }
    }

    /// <summary>
    /// A bar in the rolling buffer used by DslIndicators. Mirrors
    /// IndicatorBar in src/lib/indicators/calculations.ts on the
    /// dashboard side; only the fields the indicators actually read.
    /// Bid/ask volumes are nullable (sentinel double.NaN) — when the
    /// underlying NT8 data series doesn't carry them (no tick channel
    /// wired), the field stays NaN and indicators that need it
    /// degrade to NaN at runtime, mirroring the dashboard's
    /// null-as-fail discipline.
    /// </summary>
    public class DslBar
    {
        public DateTime Time;
        public double   Open;
        public double   High;
        public double   Low;
        public double   Close;
        public double   Volume;
        public double   VolumeBid; // double.NaN when unavailable
        public double   VolumeAsk; // double.NaN when unavailable
    }
}
