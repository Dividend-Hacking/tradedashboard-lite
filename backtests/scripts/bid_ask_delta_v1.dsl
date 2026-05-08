// Bid/Ask Delta v1 — exercises the new bar-level order-flow fields and
// the tick-resolution microstructure indicators.
//
// Showcases (NEW):
//   bar fields: delta, delta_ratio, buy_pressure, bar_volume_bid,
//               bar_volume_ask, buy_volume, sell_volume
//   tick calls: tick_imbalance(N), trades_at_bid(N), trades_at_ask(N),
//               vwap_tick(N)
//
// Strategy idea: enter in the direction of dominant aggressor flow.
// Long when buyers are eating offers (positive bar delta + positive
// tick imbalance + strong buy pressure) AND price is above tick VWAP.
// Short is the mirror. Comma-stacked predicates so each line is a
// single, readable filter.
//
// NOTE: defaults are inlined as `let` bindings so this is a self-contained
// test script — no Inferred Params sidebar entry needed. To make it
// tunable later, swap any literal back to `params.X` and the dashboard
// will surface it.

// ── Inline defaults ───────────────────────────────────────────────
let imbWin           = 5      // bars in tick_imbalance window
let vwapWin          = 20     // bars in tick-VWAP window
let atrPeriod        = 14
let deltaRatioMin    = 0.3    // bar must lean ≥ 65/35 buy-or-sell
let tickImbalanceMin = 0.2    // tape must lean ≥ 60/40 over the window
let cooldownBars     = 5
let minBodyRatio     = 0.4
let buyPressureMin   = 0.6
let minTickCount     = 10

let atr   = ATR(atrPeriod)
let valid = atr > 0 && volume > 0

// ── Bar-level aggressor delta ─────────────────────────────────────
//
// `delta` is bar_volume_ask − bar_volume_bid. Positive = aggressors
// hit the ask (buying); negative = aggressors hit the bid (selling).
// `delta_ratio` is the same thing normalized to [-1, 1] so it works
// across instruments with very different per-bar volumes.
//
// Example: bar_volume_ask = 800, bar_volume_bid = 200 → delta = 600,
// delta_ratio = 0.6. Strong buy-side dominance.
let bar_delta       = delta
let bar_delta_ratio = delta_ratio
let bar_buy_press   = buy_pressure   // bar_volume_ask / bar_volume

// "Is THIS bar strongly one-sided?" Defaults around 0.3 are a reasonable
// starting point — anything more biased than 65/35 buy/sell.
let strong_buy_bar  = bar_delta_ratio >=  deltaRatioMin
let strong_sell_bar = bar_delta_ratio <= -deltaRatioMin

// ── Tick-resolution microstructure ────────────────────────────────
//
// `tick_imbalance(N)` counts (askTrades − bidTrades) / total over the
// last N bars of raw ticks. Distinct from `delta_ratio` because it
// weights by trade COUNT, not size — a single 500-lot print and 500
// 1-lots are very different here.
//
// `trades_at_ask(N)` / `trades_at_bid(N)` give the raw counts for
// optional weighting / debugging.
let tick_imb        = tick_imbalance(imbWin)
let buy_trades      = trades_at_ask(imbWin)
let sell_trades     = trades_at_bid(imbWin)

// "Has the tape been one-sided over the recent window?" Same threshold
// as the bar-level filter but measured at trade resolution.
let tick_buy_bias   = tick_imb >=  tickImbalanceMin
let tick_sell_bias  = tick_imb <= -tickImbalanceMin

// ── Tick VWAP context ─────────────────────────────────────────────
//
// `vwap_tick(N)` is true VWAP over the last N bars of raw ticks
// (Σ price·size / Σ size). Distinct from the bar-aggregated `VWAP(N)`.
// Used as a directional trend gate — only take longs above tick VWAP,
// shorts below.
let tvwap   = vwap_tick(vwapWin)
let above_v = close > tvwap
let below_v = close < tvwap

// ── Cooldown so we don't fire on every bar of a strong drive ──────
let in_long_cd  = bars_since(signal.long)  < cooldownBars
let in_short_cd = bars_since(signal.short) < cooldownBars

// ── Body sanity — avoid doji/wicky bars ───────────────────────────
let bar_range  = high - low
let body_ratio = if bar_range > 0 then abs(body) / bar_range else 0
let body_ok    = body_ratio >= minBodyRatio

// ── Final signals ─────────────────────────────────────────────────
signal.long.if = valid,
                 !in_long_cd,
                 strong_buy_bar,
                 tick_buy_bias,
                 above_v,
                 bar_buy_press >= buyPressureMin,
                 close > open,
                 body_ok

signal.short.if = valid,
                  !in_short_cd,
                  strong_sell_bar,
                  tick_sell_bias,
                  below_v,
                  bar_buy_press <= 1 - buyPressureMin,
                  close < open,
                  body_ok

// ── Print order-flow context on every entry for sanity checking ───
ontrade.print = bar_delta_ratio, "bar delta ratio"
ontrade.print = tick_imb,        "tick imb"
ontrade.print = bar_buy_press,   "buy pressure"
ontrade.print = buy_trades,      "ask-side trades"
ontrade.print = sell_trades,     "bid-side trades"
ontrade.print = tvwap,           "tick VWAP"

// ── Risk rules ────────────────────────────────────────────────────
rules.stopLossEnabled  = true
rules.stopLossPoints   = 0
rules.takeProfitEnabled = true
rules.takeProfitPoints  = 0
rules.slAtrAdjust = 2
rules.tpAtrAdjust = 3

rules.timedExitEnabled = true
rules.timedExitBars    = 40
rules.breakEvenEnabled = false
rules.positionMode     = "add-null"
rules.cooldownBetweenTradesEnabled = true
rules.cooldownBetweenTradesBars    = 0

// ── Filters ───────────────────────────────────────────────────────
filters.time.enabled = false
filters.time.windows = ["08:00-14:00"]

// Reject ultra-thin tape — if there are barely any trades over the
// window, the imbalance number is statistically meaningless.
filter.if = (tick_count(imbWin) >= minTickCount, , )
