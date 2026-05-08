// Signal V2 — V1 + cross-into-zone + lockout + base filter

// Pre-entry range_size (excludes current bar).
let range_high = high(params.lookback)
let range_low  = low(params.lookback)
let range_size      = range_high - range_low

let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

let bs_long_level  = bars_since_high(params.lookback)
let bs_short_level = bars_since_low(params.lookback)
let long_stale     = long_pos > params.staleBreakThreshold && bs_long_level > params.staleBarsBack
let short_stale    = short_pos > params.staleBreakThreshold && bs_short_level > params.staleBarsBack

// Base filter: range_size/ATR within bounds AND drift below threshold.
// Drift = |close[1] - close[lookback]| / range_size.
let range_in_atr = range_size / atr
let drift        = abs(close[1] - close[params.lookback])
let drift_frac   = drift / range_size
let is_base      = range_in_atr >= params.baseRangeAtrMin
                && range_in_atr <= params.baseRangeAtrMax
                && drift_frac   <  params.baseDriftFraction

// Cross-into-zone — position transitions from < enter to >= enter.
let long_crossed_in  = cross_up(long_pos,  params.zoneEnterV2)
let short_crossed_in = cross_up(short_pos, params.zoneEnterV2)

// Lockout state — fires set bars_since(signal); release after either
// the cooldown bars elapse OR position dips below the exit threshold.
let long_elapsed       = bars_since(signal.long)
let long_in_window     = long_elapsed < params.cooldownBarsV2
let long_released      = any_bar_in(long_elapsed, long_pos < params.zoneExitV2)
let long_locked        = long_in_window && !long_released

let short_elapsed      = bars_since(signal.short)
let short_in_window    = short_elapsed < params.cooldownBarsV2
let short_released     = any_bar_in(short_elapsed, short_pos < params.zoneExitV2)
let short_locked       = short_in_window && !short_released

// Setup gates (same as V1).
let long_at_edge      = long_pos >= params.atEdgeThreshold
let long_near_edge    = long_pos >= params.nearEdgeThreshold
let long_pullback_min = 0 - params.pullbackAtrFraction * atr
let long_pullback_ok  = move5 >= long_pullback_min && move5 <= 0
let long_setup        = long_at_edge || (long_near_edge && long_pullback_ok)

let short_at_edge      = short_pos >= params.atEdgeThreshold
let short_near_edge    = short_pos >= params.nearEdgeThreshold
let short_pullback_max = params.pullbackAtrFraction * atr
let short_pullback_ok  = move5 >= 0 && move5 <= short_pullback_max
let short_setup        = short_at_edge || (short_near_edge && short_pullback_ok)

let long_trigger  = close > open
let short_trigger = close < open

signal.long.if = valid,
                 !long_locked,
                 long_crossed_in,
                 is_base,
                 !is_flat,
                 long_setup,
                 !long_stale,
                 long_trigger

signal.short.if = valid,
                  !short_locked,
                  short_crossed_in,
                  is_base,
                  !is_flat,
                  short_setup,
                  !short_stale,
                  short_trigger


// ── existing script preserved below ──
// Range Break v4 — V2 logic, idiomatic DSL.
// Showcases: let bindings, [N] indexing, cross_up, bars_since(signal.X),
// any_bar_in, and comma-as-AND for vertical stacking.

// ── Range structure (excludes current bar) ─────────────────────────
let lookback   = params.lookback
let range_high = high(lookback)
let range_low  = low(lookback)
let range_size = range_high - range_low

// ── Volatility & validity ──────────────────────────────────────────
let atr   = ATR(params.atrPeriod)
let valid = atr > 0 && range_size > 0

// ── Position-in-range — 0 at the low, 1 at the high ───────────────
let long_pos  = (close - range_low) / range_size
let short_pos = (range_high - close) / range_size

// ── Momentum (postfix [N] on the bare `close` ident) ──────────────
let move5  = close[1] - close[5]
let move10 = close[1] - close[10]

// Flat-momentum filter — both windows quiet → reject.
let flat_bound = params.flatAtrFraction * atr
let is_flat    = abs(move5) < flat_bound && abs(move10) < flat_bound

// ── Base quality (range/ATR + drift bounds) ───────────────────────
let range_in_atr = range_size / atr
let drift        = abs(close[1] - close[lookback])
let drift_frac   = drift / range_size
let is_base = range_in_atr >= params.baseRangeAtrMin,
              range_in_atr <= params.baseRangeAtrMax,
              drift_frac   <  params.baseDriftFraction

// ── Cross-into-zone (the trigger bar) ─────────────────────────────
let long_crossed_in  = cross_up(long_pos,  params.zoneEnterV2)
let short_crossed_in = cross_up(short_pos, params.zoneEnterV2)

// ── Cooldown via self-reference — much cleaner than V2's stateful
//    `longLockedSinceBar` machinery. bars_since(signal.long) returns
//    +Infinity before the first firing, so the comparison is false
//    until the strategy has actually fired once. ──────────────────
let in_long_cooldown  = bars_since(signal.long)  < params.cooldownBarsV2
let in_short_cooldown = bars_since(signal.short) < params.cooldownBarsV2

// ── Fresh-break filter — reject signals when the level was already
//    taken out in the last N bars. Showcases any_bar_in re-evaluating
//    its inner condition at every historical bar. ──────────────────
let long_recently_tagged  = any_bar_in(params.staleBarsBack, close > range_high * params.staleBreakThreshold)
let short_recently_tagged = any_bar_in(params.staleBarsBack, close < range_low  / params.staleBreakThreshold)

// ── Body quality — trigger candle's body must dominate its range ──
let bar_range = high - low
let body_ratio = if bar_range > 0 then abs(close - open) / bar_range else 0
let body_ok    = body_ratio >= params.minBodyRatio

// ── Triggers (candle direction confirms breakout) ─────────────────
let long_trigger  = close > open && body_ok
let short_trigger = close < open && body_ok

// ── Final signals — comma-stacked for readability ─────────────────
signal.long.if = valid,
                 !in_long_cooldown,
                 long_crossed_in,
                 is_base,
                 !is_flat,
                 !long_recently_tagged,
                 long_trigger

signal.short.if = valid,
                  !in_short_cooldown,
                  short_crossed_in,
                  is_base,
                  !is_flat,
                  !short_recently_tagged,
                  short_trigger


// ── existing script preserved below ──
// ── Strategy ──


// ── Risk rules — Exits ──
rules.stopLossEnabled = false
rules.stopLossPoints = 0
rules.takeProfitEnabled = false
rules.takeProfitPoints = 0
rules.trailingStopEnabled = false
rules.trailingStopPoints = 8
rules.timedExitEnabled = false
rules.timedExitBars = 20
rules.breakEvenEnabled = false
rules.breakEvenTrigger = 5
rules.exitAtBarClose = true
rules.extensionBarsEnabled = false
rules.extensionBars = 20

// ── Risk rules — ATR adjust ──
rules.slAtrAdjust = optimize.sharpe.trades(10, 1, 10) smooth(10)
rules.tpAtrAdjust = optimize.sharpe.trades(10, 1, 10) smooth(10)
rules.trailAtrAdjust = 0
rules.beAtrAdjust = 0
Warmup = false
OptimizeAll = true
// ── Risk rules — Position overlap ──
rules.positionMode = "add-close"

// ── Risk rules — Scaling ──
rules.scalingEnabled = false
rules.scalingStartSize = 1
rules.scalingWinStep = 1
rules.scalingLossStep = 1
rules.scalingMinSize = 1
rules.scalingMaxSize = 5
rules.scalingResetDaily = false

// ── Risk rules — Daily limits ──
rules.dailyStopLossEnabled = false
rules.dailyStopLossPoints = 50
rules.dailyTakeProfitEnabled = false
rules.dailyTakeProfitPoints = 50
rules.dailyLimitExactMode = false
rules.maxTradesPerDayEnabled = false
rules.maxTradesPerDay = 5
rules.maxLossesPerDayEnabled = false
rules.maxLossesPerDay = 3
rules.cooldownBetweenTradesEnabled = false
rules.cooldownBetweenTradesBars = 5

// ── Risk rules — Fills & Costs ──
rules.fillMode = "next_open"
rules.tickConfigMode = "auto"
rules.pointValue = 20
rules.ticksPerPoint = 4
rules.tickValue = 5
rules.slippagePoints = 0
rules.commissionPerRoundTrip = 0

// ── Filters — Time of day ──
filters.time.enabled = false
filters.time.from = "09:30"
filters.time.to = "16:00"
filters.time.windows = ["09:30-16:00"]

// ── Filters — Bollinger ──
filters.bollinger.enabled = false
filters.bollinger.allowed = ["above_upper", "inside", "below_lower"]
filters.bollinger.period = 20
filters.bollinger.stdDev = 2

// ── Filters — BB width ──
filters.bbWidth.enabled = false
filters.bbWidth.min = 0
filters.bbWidth.max = 1000

// ── Filters — RSI ──
filters.rsi.enabled = false
filters.rsi.period = 14
filters.rsi.min = 0
filters.rsi.max = 100

// ── Filters — ADX direction ──
filters.adxTrend.enabled = false
filters.adxTrend.mode = "rising"
filters.adxTrend.lookback = 5
filters.adxTrend.flatThreshold = 1

// ── Filters — Conditional (filter.if templates) ──

// ADX range gate — drop the `, , pass` tail to enable.
filter.if = (ADX(14) >= 20 && ADX(14) <= 60, , pass)

// ATR range gate — restrict to a volatility band (in points).
filter.if = (ATR(14) >= optimize.sharpe.trades(10, 1, 10) smooth(10) && ATR(14) <= optimize.sharpe.trades(10, 5, 20) smooth(10), , )

// Trend alignment — trade ONLY in the direction of the fast MA.
// (When activated, rejects every counter-trend signal.)
filter.if = ((direction > 0 && close > EMA(200)) || (direction < 0 && close < EMA(200)), , )

// Volume surge — require entry volume above its 20-bar average.
filter.if = (volume / volume(20) >= 1.5, , pass)

// MA distance — entry must be within N ATRs of the reference MA.
filter.if = (abs(close - EMA(50)) / ATR(14) <= 2, , pass)

// ── Advanced examples (commented) ────────────────────────────
// Adaptive stop — tighten SL on strong trend, widen on weak. 3-arg form:
// filter.if = (ADX(14) > 25, rules.stopLossPoints = 8, rules.stopLossPoints = 15)

// Reject + log on weak volume. NOTE: defining if_false REPLACES the
// default-reject — you must write `reject` explicitly to keep it.
// filter.if = (volume / volume(20) >= 1.0, , print(volume / volume(20), "vol ratio"); reject)

// Nested — only allow longs above EMA20 when ADX > 25:
// filter.if = (ADX(14) > 25, filter.if = (close > EMA(20), , reject), reject)

// See the script reference (download button) for full grammar, all action statements,
// and the verdict-replacement rule for if_true / if_false slots.
