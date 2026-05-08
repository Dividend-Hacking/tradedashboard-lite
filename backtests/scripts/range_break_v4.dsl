// Range Break v4 — V2 logic, idiomatic DSL.
// Showcases: let bindings, [N] indexing, cross_up, bars_since(signal.X),
// bars_since_high/low, any_bar_in, and comma-as-AND for vertical stacking.

// ── Range structure (excludes current bar) ─────────────────────────

// A nickname for the lookback param so the code below reads cleaner.
// If params.lookback is 20, then `lookback` is just 20. Now we can
// write `high(lookback)` instead of `high(params.lookback)`.
let lookback   = params.lookback

// The HIGHEST high among the last 20 bars (not counting the bar
// we're on right now). If those 20 bars peaked at $4525, then
// range_high is 4525. Think of it as the ceiling of the box price
// has been bouncing in.
let range_high = high(lookback)

// Same idea, but the FLOOR of the box. The lowest low among the
// last 20 bars. If they bottomed at $4500, range_low is 4500.
let range_low  = low(lookback)

// How TALL is that box? Just ceiling minus floor. If high=4525 and
// low=4500, range_size=25 — a 25-point box. We'll use this
// everywhere as a "size unit" for the rest of the math.
let range_size = range_high - range_low

// ── Volatility & validity ──────────────────────────────────────────

// ATR = "Average True Range" — how much price typically moves per
// bar lately. If atrPeriod is 14 and the result is 5, it means
// "recent bars have averaged about 5 points of swing each". We use
// ATR as our scale so the strategy auto-adjusts to choppy vs. calm
// markets.
let atr   = ATR(params.atrPeriod)

// A safety check: are our numbers actually usable? Right when the
// chart starts, ATR hasn't been calculated yet (NaN). And if price
// somehow didn't move at all over the lookback window, range_size
// would be 0 — dividing by it later would blow up. valid catches
// both. If valid is false, no signal can fire.
let valid = atr > 0 && range_size > 0

// ── Position-in-range — 0 at the low, 1 at the high ───────────────

// Where is price RIGHT NOW inside the box, on a 0-to-1 scale?
// Example: range_low=4500, range_high=4525, close=4520.
//   long_pos = (4520 - 4500) / 25 = 0.8
// So we're 80% of the way to the top. 0 = at the floor, 1 = at the
// ceiling, > 1 = poking out above.
let long_pos  = (close - range_low) / range_size

// Same but flipped — how close are we to the BOTTOM of the box?
// Example: close=4505, same box → short_pos = (4525-4505)/25 = 0.8
// — 80% of the way to the floor. Used for short signals.
let short_pos = (range_high - close) / range_size

// ── Momentum (postfix [N] on the bare close ident) ─────────────────

// How much did price move over the last 5 bars? close[1] means
// "yesterday's close" (1 bar ago) and close[5] means "close from
// 5 bars ago". Subtracting tells us net direction.
// Example: yesterday's close = 4520, 5 bars ago = 4510.
//   move5 = 10 (going up). Negative would mean going down.
let move5  = close[1] - close[5]

// Same idea over a longer 10-bar window. Having TWO timescales
// stops a quick one-bar jiggle from looking like real trend.
let move10 = close[1] - close[10]

// Flat-momentum filter — both windows quiet → reject.

// "What's small enough to call basically flat?" We define it as a
// fraction of ATR so the threshold scales with volatility.
// Example: flatAtrFraction=0.2, atr=5 → flat_bound = 1.0 point.
// So any 5- or 10-bar move under 1 point we'll consider flat.
let flat_bound = params.flatAtrFraction * atr

// Did price barely move in BOTH the 5-bar AND 10-bar window?
// abs() is "absolute value" — strips the sign so up-1pt and
// down-1pt are both "small". When both windows are sleepy, this
// market isn't really trending — there's nothing to "break out"
// from. is_flat=true means skip this candidate.
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

// ── Base quality (range/ATR + drift bounds) ───────────────────────

// How big is our box relative to typical bar size?
// Example: range_size=25, atr=5 → range_in_atr = 5. The box is
// 5 ATRs tall. We'll require this to fall in a "Goldilocks" range:
// not too small (no real edge to break) and not too big (already
// trending too much to call this a fresh breakout).
let range_in_atr = range_size / atr

// Across the whole lookback window, how far did price ACTUALLY
// travel from start to end? close[lookback] = close at the start
// of the window, close[1] = close yesterday. abs() because we
// don't care which direction — we just want the magnitude.
// Example: 20 bars ago close=4505, yesterday close=4523 → drift=18.
let drift        = abs(close[1] - close[lookback])

// Drift as a fraction of the box height. Tells us "did price drift
// most of the way across the box, or did it just oscillate inside?"
// Example: drift=18, range_size=25 → drift_frac = 0.72. Price
// traveled 72% of the box height — pretty trendy.
// Low drift_frac (e.g. 0.2) = sideways consolidation.
// High drift_frac (e.g. 0.8) = trending. We want LOW for V2.
let drift_frac   = drift / range_size

// Three checks the box has to pass, all comma-stacked (comma means
// AND here). The box must be:
//   1) at LEAST baseRangeAtrMin tall (e.g. 1.5 ATRs — has some edge)
//   2) at MOST baseRangeAtrMax tall (e.g. 4 ATRs — not too wide)
//   3) drift_frac BELOW baseDriftFraction (e.g. 0.5 — sideways enough)
// Together this filters for "coiled spring" boxes that breakouts
// like to happen out of.
let is_base = range_in_atr >= params.baseRangeAtrMin,
              range_in_atr <= params.baseRangeAtrMax,
              drift_frac   <  params.baseDriftFraction

// ── Cross-into-zone (the trigger bar) ─────────────────────────────

// "Did long_pos JUST cross above the entry threshold on THIS bar?"
// Example: zoneEnterV2 = 0.5.
//   - Yesterday long_pos was 0.4, today it's 0.55. → cross_up = true
//   - Yesterday it was 0.7, today 0.72. → cross_up = false
//     (already above 0.5, no fresh cross)
// We want JUST the bar where price first arrives at the breakout
// zone. Stops us from firing every single bar that price stays up there.
let long_crossed_in  = cross_up(long_pos,  params.zoneEnterV2)

// Mirror for shorts — fires on the bar short_pos crosses up
// through the same threshold (price moving DOWN through the box).
let short_crossed_in = cross_up(short_pos, params.zoneEnterV2)

// ── Stale-level detection — reject if we're poking a level that
//    was set long ago (likely a re-test, not a fresh break). Uses
//    bars_since_high/low which return the bar-distance to the
//    argmax/argmin of the rolling lookback window. ─────────────────

// HOW LONG AGO was the highest high in our box made? Returns a
// number of bars.
// Example: the high was made 3 bars ago → bs_long_level = 3.
//   The high was made 18 bars ago → bs_long_level = 18.
// Recent = "fresh level". Old = "stale level".
let bs_long_level  = bars_since_high(lookback)

// Same idea for the low — how many bars since the lowest low?
let bs_short_level = bars_since_low(lookback)

// "Are we trying to break a STALE level?" Two parts must both be true:
//   1) long_pos > staleBreakThreshold (we're poking past the high,
//      e.g. above 1.05 — clearly trying to break it)
//   2) bs_long_level > staleBarsBack (the high was set more than,
//      say, 15 bars ago — old news)
// If both are true → this is more likely a re-test of an old level,
// which tends to fail. We'll skip it.
let long_stale  = long_pos  > params.staleBreakThreshold && bs_long_level  > params.staleBarsBack

// Mirror for shorts: poking below the low + the low is old.
let short_stale = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

// ── V2-style release-on-dip lockout, expressed cleanly ────────────
//    bars_since(signal.long) returns the bar-distance to this
//    strategy's most recent prior LONG firing (+Infinity before the
//    first firing). The `any_bar_in` re-evaluates its inner
//    condition AT EACH historical bar with a fresh let-cache, so
//    long_pos rebinds correctly each iteration. The full check:
//      "I fired within the cooldown window, AND position has NOT
//       dipped below the exit threshold since."

// "How many bars ago did THIS strategy last fire a long?"
// Example: never fired yet → +Infinity (a giant number).
//   Fired 3 bars ago → long_elapsed = 3.
//   Fired 50 bars ago → long_elapsed = 50.
// We use this to enforce a cooldown after firing.
let long_elapsed   = bars_since(signal.long)

// "Are we still in the cooldown window after our last fire?"
// Example: cooldownBarsV2 = 30.
//   long_elapsed = 5 → 5 < 30 → true (still in cooldown).
//   long_elapsed = 50 → 50 < 30 → false (cooldown is over).
//   long_elapsed = +Infinity → false (never fired, no cooldown).
let long_in_window = long_elapsed < params.cooldownBarsV2

// "After our last firing, did price ever drop back below the exit
// zone?" any_bar_in scans the last N bars (where N = long_elapsed,
// the bars since we fired) and checks each one.
// Example: we fired 10 bars ago. Did long_pos go below 0.3 at any
// of those 10 bars?
//   - If yes → long_dipped = true (price retreated and came back,
//     which "releases" the lockout — fair game to fire again).
//   - If no → long_dipped = false (price has been camping in the
//     zone without coming down — don't fire again, it's the same
//     move continuing).
let long_dipped    = any_bar_in(long_elapsed, long_pos < params.zoneExitV2)

// Locked = "both" must be true: still in cooldown AND price hasn't
// taken a breath. If EITHER is false, we're free to fire again.
// !long_locked is what we'll require at the bottom.
let long_locked    = long_in_window && !long_dipped

// Same lockout machinery for shorts. Independent state — a long
// firing doesn't lock out shorts and vice versa.
let short_elapsed   = bars_since(signal.short)
let short_in_window = short_elapsed < params.cooldownBarsV2
let short_dipped    = any_bar_in(short_elapsed, short_pos < params.zoneExitV2)
let short_locked    = short_in_window && !short_dipped

// ── Body quality — trigger candle's body must dominate its range.
//    Replaces V2's bare close>open / close<open trigger so wicky /
//    doji bars are rejected. ──────────────────────────────────────

// How much did the CURRENT bar swing from top to bottom?
// Example: high=4525, low=4513 → bar_range = 12.
let bar_range  = high - low

// What fraction of the bar is "body" (open-to-close) vs. "wicks"
// (the long thin parts above and below)?
// Example: open=4515, close=4520, high=4525, low=4513.
//   body = |4520 - 4515| = 5
//   range = 12
//   body_ratio = 5/12 = 0.42 → about 42% body, 58% wicks.
// A doji has body_ratio near 0 (tiny body, big wicks).
// A strong candle has body_ratio near 1 (almost all body).
// The `if bar_range > 0` guard avoids divide-by-zero on rare
// degenerate bars where high == low.
let body_ratio = if bar_range > 0 then abs(close - open) / bar_range else 0

// "Is the candle solid enough?" minBodyRatio = 0 means accept any
// candle (the filter is off). minBodyRatio = 0.4 means require at
// least 40% body — rejects wicky / doji bars.
let body_ok    = body_ratio >= params.minBodyRatio

// ── Triggers (candle direction confirms breakout) ─────────────────

// Long trigger = green candle (close > open) AND solid enough body.
// A doji that closes 1 cent above open shouldn't count as a long.
let long_trigger  = close > open && body_ok

// Short trigger = red candle (close < open) AND solid enough body.
let short_trigger = close < open && body_ok

// ── Final signals — comma-stacked for readability ─────────────────
signal.long.if = valid,
                 !long_locked,
                 long_crossed_in,
                 is_base,
                 !is_flat,
                 !long_stale,
                 long_trigger

signal.short.if = valid,
                  !short_locked,
                  short_crossed_in,
                  is_base,
                  !is_flat,
                  !short_stale,
                  short_trigger

rules.stopLossEnabled = true
rules.stopLossPoints = 0
rules.takeProfitEnabled = true
rules.takeProfitPoints = 0
rules.positionMode = "add-close"

rules.slAtrAdjust = 20
rules.tpAtrAdjust = 4

rules.timedExitBars = 100
rules.timedExitEnabled = true

filter.if = (ATR(14) <= 10, , )
// Optional volatility gate. Single-arg form: cond true → pass,
// false → reject. Use uppercase `ATR` — lowercase `atr` compiles but
// evaluates to NaN at runtime (no such indicator). Uncomment to use.
// filter.if = ATR(14) <= 5
