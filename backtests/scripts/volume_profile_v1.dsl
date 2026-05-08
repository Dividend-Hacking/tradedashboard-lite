// Volume Profile v1 — exercises the new tick-driven volume profile
// indicators alongside the bid/ask aggressor data.
//
// Showcases (NEW):
//   tick calls: POC(N), VAH(N), VAL(N), VA_width(N), dist_to_POC(N),
//               mean_trade_size(N), large_trade_count(N, threshold),
//               tick_count(N)
//   bar fields: delta, delta_ratio, buy_pressure
//
// Strategy idea: classic mean-reversion within the rolling value area.
// Long when price tags VAL with bullish tape (positive delta + buyer
// aggression). Short when price tags VAH with bearish tape. Use POC
// as the take-profit reference — most bounces from the edges of the
// value area gravitate back toward the high-volume node.
//
// Uses tick-resolution profile (computed from raw trades) so POC/VAH/
// VAL match what the chart overlay shows.
//
// NOTE: defaults are inlined as `let` bindings so this is a self-contained
// test script — no Inferred Params sidebar entry needed. To make it
// tunable later, swap any literal back to `params.X` and the dashboard
// will surface it.

// ── Inline defaults ───────────────────────────────────────────────
let pwin             = 20
let vaPct            = 0.7
let atrPeriod        = 14
let vaWidthMinAtr    = 1
let vaWidthMaxAtr    = 5
let tapeConfirmRatio = 0.2
let largePrintSize   = 5    // contracts; 5+ counts as a "large" print on NQ
let minTickCount     = 50
let minLargePrints   = 1
let cooldownBars     = 5

let atr   = ATR(atrPeriod)
let valid = atr > 0

// ── Profile levels ────────────────────────────────────────────────
//
// POC = price level with the most volume in the window.
// VAH = top of the (vaPct, default 70%) value area.
// VAL = bottom of the value area.
// VA_width = VAH − VAL (in price points). Useful as a regime gauge:
//            narrow VA = balance/coiling, wide VA = trend transition.
// dist_to_POC = (close − POC) / close. Positive when price is above
//               the POC, negative when below.
let poc        = POC(pwin, vaPct)
let vah        = VAH(pwin, vaPct)
let val_lo     = VAL(pwin, vaPct)
let va_width   = VA_width(pwin, vaPct)
let dist_poc   = dist_to_POC(pwin, vaPct)

// "Is the value area in a normal range?" If VA is super narrow we're
// in compression; if super wide we're already trending — neither is
// the playbook for a fade-the-edge mean-reversion trade.
let va_in_atr  = if atr > 0 then va_width / atr else 0
let va_normal  = va_in_atr >= vaWidthMinAtr,
                 va_in_atr <= vaWidthMaxAtr

// ── Edge tagging ──────────────────────────────────────────────────
//
// `cross_down(close, val_lo)` fires the bar close pierces below VAL —
// our long trigger candidate. cross_up over VAH for shorts. We use
// CROSSES so we fire only on the ARRIVAL bar, not every bar that
// stays beyond the edge.
let tagged_val = cross_down(close, val_lo)
let tagged_vah = cross_up(close,   vah)

// ── Bid/ask confirmation ──────────────────────────────────────────
//
// At VAL we want BUYER aggression — aggressors hitting the ask, bar
// closing in the upper half of its range. Ditto reversed at VAH.
// `delta_ratio` is the bar's normalized buy/sell pressure in [-1, 1].
let bullish_tape = delta_ratio >=  tapeConfirmRatio
let bearish_tape = delta_ratio <= -tapeConfirmRatio

let upper_close  = (close - low) >= 0.6 * (high - low)
let lower_close  = (high - close) >= 0.6 * (high - low)

// ── Tape quality — reject thin / sketchy windows ──────────────────
//
// `tick_count(N)` = total trades over last N bars. `mean_trade_size(N)`
// is Σ size / N_trades. `large_trade_count(N, threshold)` counts
// prints at or above a size cutoff (block detection).
let tcount       = tick_count(pwin)
let mean_size    = mean_trade_size(pwin)
let large_prints = large_trade_count(pwin, largePrintSize)

let liquid_enough  = tcount >= minTickCount
let blocks_present = large_prints >= minLargePrints

// ── Anti-stack: don't pile on the same VAL/VAH break ──────────────
let in_long_cd  = bars_since(signal.long)  < cooldownBars
let in_short_cd = bars_since(signal.short) < cooldownBars

// ── Final signals ─────────────────────────────────────────────────
signal.long.if = valid,
                 !in_long_cd,
                 tagged_val,
                 va_normal,
                 bullish_tape,
                 upper_close,
                 liquid_enough,
                 blocks_present

signal.short.if = valid,
                  !in_short_cd,
                  tagged_vah,
                  va_normal,
                  bearish_tape,
                  lower_close,
                  liquid_enough,
                  blocks_present

// ── Print profile context on every entry ──────────────────────────
ontrade.print = poc,          "POC"
ontrade.print = vah,          "VAH"
ontrade.print = val_lo,       "VAL"
ontrade.print = va_width,     "VA width (pts)"
ontrade.print = dist_poc,     "dist to POC (frac)"
ontrade.print = mean_size,    "mean trade size"
ontrade.print = large_prints, "large prints"
ontrade.print = delta_ratio,  "bar delta ratio"

// ── Risk rules ────────────────────────────────────────────────────
//
// Mean-reversion playbook: tight stop just past the value-area edge,
// take profit at or near the POC (the gravitational center).
rules.stopLossEnabled   = true
rules.stopLossPoints    = 0
rules.takeProfitEnabled = true
rules.takeProfitPoints  = 0
rules.slAtrAdjust       = 1.25
rules.tpAtrAdjust       = 2.5

rules.timedExitEnabled = true
rules.timedExitBars    = 30
rules.breakEvenEnabled = true
rules.breakEvenTrigger = 2
rules.positionMode     = "add-null"

rules.cooldownBetweenTradesEnabled = true
rules.cooldownBetweenTradesBars    = 8

// ── Filters ───────────────────────────────────────────────────────
filters.time.enabled = true
filters.time.windows = ["08:30-14:30"]

// Skip when value area is degenerate (NaN early in series, or zero
// width on a flat tape).
filter.if = (va_width > 0, , )
