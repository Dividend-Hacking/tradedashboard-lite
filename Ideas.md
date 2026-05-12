# Algo Trading Strategy Idea Pool

A reference list for short-term price action strategy brainstorming. Each idea has a one-line description, an implementation **difficulty** rating (Easy / Medium / Hard), and a **fit** rating for short-term price action bots (★★★ great / ★★ decent / ★ weak).

---

## Volume Profile / Auction

- **Naked POC retest** — Find a Point of Control from a prior session that price never returned to, then trade the reaction when price finally retests it. *Medium / ★★★*
- **Composite multi-day VP breakout** — Build a volume profile across several sessions and trade when price breaks out of the high-volume node cluster. *Medium / ★★*
- **Single print fill** — Identify thin price areas (single TPO prints) above/below current price and trade the magnet move as they get filled. *Medium / ★★★*
- **VPOC migration** — Track how the daily VPOC shifts session to session; consistent upward/downward migration signals trend direction. *Medium / ★★*
- **Initial Balance breakout / extension** — Mark the first hour's high/low and trade breakouts beyond it, often targeting IB extensions (1x, 1.5x, 2x). *Easy / ★★★*
- **Volume Delta divergence** — When price makes a new high/low but cumulative buy-sell delta doesn't confirm, fade the move. *Hard / ★★★*
- **Cumulative Delta reset** — Enter when CVD returns to a key prior level (session open, prior day close) showing exhaustion. *Hard / ★★★*
- **Footprint stacked imbalances** — Look for 3+ consecutive diagonal bid/ask imbalances on the footprint chart as a continuation or absorption signal. *Hard / ★★★*
- **Absorption at VAH/VAL** — When heavy volume hits VAH or VAL but price stalls, trade the reversal back into value. *Hard / ★★★*
- **Open Type classification** — Categorize the open (Open-Drive, Open-Test-Drive, Open-Rejection-Reverse, Open-Auction) and set directional bias for the session accordingly. *Medium / ★★★*

## VWAP Family

- **VWAP mean reversion** — Fade price when it stretches far from VWAP in a ranging session, targeting a return to the line. *Easy / ★★★*
- **VWAP standard deviation band breakout** — Trade breakouts beyond the 2nd or 3rd VWAP deviation band in trending conditions. *Easy / ★★★*
- **Anchored VWAP from HOD/LOD/swing/news** — Drop a VWAP anchored at a meaningful event and use it as dynamic support/resistance. *Easy / ★★★*
- **VWAP slope filter** — Only take longs when VWAP is sloping up and shorts when sloping down, used as a regime gate for any entry trigger. *Easy / ★★★*
- **Multi-session VWAP confluence** — When daily, weekly, and monthly VWAPs cluster, treat the zone as a high-probability reaction area. *Easy / ★★*

## Opening Range / Session

- **5/15/30-min ORB** — Mark the high and low of the first N minutes; trade the breakout with stop on the opposite side of the range. *Easy / ★★★*
- **Pre-market high/low break** — Use the pre-market range as the breakout reference instead of regular session. *Easy / ★★★*
- **Asian range fade** — In FX/crypto, fade breaks of the Asian session range during London open, betting on false breakouts. *Easy / ★★*
- **Lunch compression breakout** — Trade the breakout of the low-volume midday range (11:30–1:30 ET) heading into the afternoon push. *Easy / ★★★*
- **London/NY overlap continuation** — Take trend continuation entries during the 8–11 ET window when volume is highest. *Easy / ★★*
- **Friday close fade** — Fade strong end-of-week moves, betting on Monday reversion. *Easy / ★*
- **Monday gap fill/fade** — Trade weekend gaps either toward fill (fade) or in the direction of gap (continuation) based on size. *Easy / ★★*
- **End-of-day mean reversion** — Fade extended moves in the last 30 minutes of the session. *Easy / ★★★*

## Market Structure / SMC

- **Break of Structure entry** — Enter on a confirmed break of a prior swing high/low in the direction of the new trend. *Medium / ★★★*
- **Change of Character reversal** — When price breaks the most recent counter-trend swing, treat it as the first sign of trend reversal and enter. *Medium / ★★★*
- **Liquidity sweep fade** — When price spikes through an obvious stop cluster (prior high/low) and snaps back, fade the sweep. *Medium / ★★★*
- **Order block retest** — Mark the last opposing candle before a strong move and enter when price retests it. *Medium / ★★★*
- **Fair Value Gap fill** — Identify 3-candle imbalance gaps and enter on retracement into the gap. *Easy / ★★★*
- **Inducement + grab** — Wait for price to lure participants into a minor swing, then grab their stops before reversing — enter on the reversal. *Hard / ★★*
- **Wyckoff spring / upthrust** — Trade the false break below support (spring) or above resistance (upthrust) in an accumulation/distribution range. *Hard / ★★*
- **Equal highs/lows liquidity raid** — Target double/triple tops or bottoms as liquidity pools and enter the reversal after the sweep. *Medium / ★★★*

## Trend / Momentum

- **Donchian breakout (Turtle)** — Buy N-period highs, sell N-period lows; classic systematic trend follower. *Easy / ★★*
- **Keltner breakout** — Trade breaks of the Keltner channel (EMA + ATR bands) for momentum entries. *Easy / ★★*
- **ADX-filtered breakout** — Only take breakout signals when ADX is above a threshold (e.g. 25) confirming trend strength. *Easy / ★★*
- **MACD histogram flip** — Enter when the histogram changes sign or makes a higher-low/lower-high divergence. *Easy / ★*
- **Parabolic SAR flip** — Take entries when the SAR dot flips sides, with optional trend filter. *Easy / ★*
- **Ichimoku cloud break** — Enter on price closing through the cloud, ideally with Tenkan/Kijun cross confirmation. *Easy / ★*
- **Chandelier exit trend follower** — Use the Chandelier (ATR-trailed extreme) as both entry trigger and dynamic stop. *Easy / ★★*
- **Triple EMA stack (8/21/50)** — Enter when EMAs align in order; exit when stack breaks. *Easy / ★★*
- **Hull MA crossover** — Trade crosses of price over the Hull MA, which lags less than standard MAs. *Easy / ★★*
- **TD Sequential 9 setup** — Use DeMark's count of 9 consecutive closes vs 4 bars prior to anticipate exhaustion reversals. *Medium / ★★*
- **Vortex indicator cross** — Enter on VI+ / VI- crossovers, often with an ADX filter. *Easy / ★*

## Mean Reversion

- **RSI 2-period (Connors)** — Buy when 2-period RSI drops below 10 in an uptrend; sell the inverse. *Easy / ★★*
- **Z-score reversion** — Compute rolling z-score of price vs its mean and fade extreme readings (e.g. ±2). *Easy / ★★★*
- **Distance from MA fade** — When price is N ATRs above/below a moving average, fade the deviation. *Easy / ★★★*
- **Linear regression channel fade** — Fit a regression channel and fade touches of the outer bands. *Easy / ★★★*
- **Half-life-based entry** — Calculate mean reversion half-life of the series and size/time trades to that horizon. *Medium / ★★*
- **Pairs / cointegration** — Trade the spread between two cointegrated instruments when it diverges from its mean. *Hard / ★*
- **Hurst exponent regime gate** — Only run mean reversion strategies when Hurst is below 0.5 indicating mean-reverting regime. *Medium / ★★*

## Volatility-based

- **ATR breakout** — Enter when price moves more than N×ATR from a reference point (open, prior close). *Easy / ★★★*
- **NR4 / NR7 narrow range break** — After the narrowest range in 4 or 7 bars, trade the breakout of that bar's range. *Easy / ★★★*
- **Volatility Contraction Pattern** — Find sequences of progressively tighter ranges (Minervini-style) and trade the breakout. *Medium / ★★*
- **Bollinger band width squeeze** — Wait for BB width to hit a multi-period low, then trade the expansion breakout. *Easy / ★★★*
- **Realized vs implied vol divergence** — Trade direction based on whether RV is over- or under-pricing IV. *Hard / ★*
- **GARCH regime filter** — Use GARCH-modeled vol forecasts to switch between strategies or size positions. *Hard / ★*

## Patterns

- **Inside bar breakout** — Trade the break of an inside bar's parent bar, ideally with trend alignment. *Easy / ★★★*
- **Outside bar reversal** — When an outside bar engulfs the prior bar at a key level, trade the reversal in the engulf direction. *Easy / ★★★*
- **Engulfing reversal** — Standard bullish/bearish engulfing at support/resistance, entered on the close or next bar. *Easy / ★★★*
- **Pin bar at level** — Trade rejection candles (long wick, small body) at marked levels. *Easy / ★★★*
- **Double top/bottom** — Enter on neckline break after a second failed test of a prior extreme. *Medium / ★★*
- **Flag / pennant continuation** — Trade breakouts from short consolidations after a sharp move. *Hard / ★★*
- **Three Drives** — Three symmetrical pushes into a level, often Fibonacci-measured, then reversal. *Hard / ★*
- **Harmonic patterns** — Gartley/Bat/Crab/Butterfly Fibonacci-based reversal patterns with defined entry zones. *Hard / ★*
- **Hikkake** — A failed inside bar breakout that reverses sharply, traded in the reversal direction. *Medium / ★★★*

## Microstructure / Order Flow

- **Sweep detection** — Detect when a single market order eats multiple price levels and trade in the sweep direction (or fade exhaustion sweeps). *Hard / ★★★*
- **Tick imbalance threshold** — Track cumulative uptick vs downtick volume and trade when imbalance exceeds threshold. *Hard / ★★★*
- **Bid-ask spread anomaly** — Trade when spread widens unusually (often before news) or contracts sharply. *Hard / ★★*
- **Iceberg detection** — Identify hidden large limit orders being slowly filled and trade with the iceberg side. *Hard / ★★*
- **VPIN-based regime** — Use Volume-synchronized Probability of Informed Trading to flag toxic flow and pause/reverse. *Hard / ★★*
- **Trade size clustering** — Detect when large prints cluster (institutional activity) and follow direction. *Hard / ★★*

## Statistical / ML-ish

- **HMM regime detection** — Fit a Hidden Markov Model to returns/vol and switch strategy based on current regime state. *Hard / ★★*
- **Logistic regression on candle features** — Train logistic regression on OHLCV-derived features to predict next-bar direction. *Medium / ★★*
- **Random forest classifier entry** — Use an RF model to filter or trigger entries based on a feature set. *Medium / ★★*
- **PCA across correlated tickers** — Reduce a basket to principal components and trade the residual of an individual ticker vs its PC. *Hard / ★*
- **Autoencoder anomaly entry** — Train an autoencoder on normal market behavior; high reconstruction error flags entry opportunities. *Hard / ★*
- **Markov transition probabilities** — Discretize price action into states and trade based on historical transition probabilities. *Medium / ★★*
- **Granger causality lead/lag** — Identify instruments that Granger-cause others and trade the laggard when the leader moves. *Hard / ★*

## Confluence / Multi-Timeframe

- **HTF trend + LTF FVG entry** — Use higher-timeframe trend direction and enter on lower-timeframe fair value gap fills. *Medium / ★★★*
- **HTF order block + LTF CHOCH** — Wait for price to reach an HTF order block, then enter on an LTF change of character. *Medium / ★★★*
- **Triple screen (Elder)** — Three timeframes: HTF for trend, MTF for momentum, LTF for entry trigger. *Easy / ★★★*
- **HTF level + LTF momentum trigger** — Mark HTF S/R, drop to LTF and wait for momentum confirmation before entering. *Easy / ★★★*

## Levels / Liquidity Magnets

- **Round number magnet** — Trade reactions at psychological round numbers (e.g. 100, 4500) either as fades or breakout continuations. *Easy / ★★★*
- **Prior day high/low** — Trade either the break (continuation) or the fade (reversal) of PDH/PDL. *Easy / ★★★*
- **Weekly/monthly high/low** — Same concept on higher timeframes — high-quality reaction levels. *Easy / ★★*
- **52-week extremes** — Trade breakouts of or fades from 52-week highs/lows. *Easy / ★*
- **Globex high/low** — Use overnight session extremes as breakout/fade references for the regular session. *Easy / ★★★*

## Sentiment / External

- **Funding rate flip** — In crypto perps, trade against extreme funding (long when shorts are paying heavily, vice versa). *Easy / ★★*
- **Open interest divergence** — When price rises but OI falls (or vice versa), signals weak conviction and possible reversal. *Medium / ★★*
- **Long/short ratio extreme fade** — Fade when retail long/short ratios hit extremes, betting on liquidation. *Easy / ★★*
- **Liquidation cascade fade** — After a large liquidation event, fade the overshoot back to a mean. *Medium / ★★★*
- **Unusual options flow** — Follow large block trades or sweeps in options to bias underlying direction. *Hard / ★*
- **Put/Call ratio extremes** — Fade extreme readings in P/C ratio as contrarian sentiment signal. *Easy / ★*
- **Earnings drift (PEAD)** — Trade the multi-day drift in the direction of an earnings surprise. *Easy / ★*

## Misc Oscillators

- **Williams %R extremes** — Trade reversals when %R reaches -100 or 0 with confirmation. *Easy / ★★*
- **CCI extremes** — Fade or follow CCI moves beyond ±100 (or ±200 for extremes). *Easy / ★★*
- **Money Flow Index divergence** — Trade reversals when price and MFI diverge. *Medium / ★★*
- **Chaikin Money Flow flip** — Enter when CMF crosses zero or diverges from price. *Easy / ★*
- **Stochastic divergence** — Classic divergence between stochastic and price at extremes. *Medium / ★★*
- **Elder Ray** — Use Bull Power and Bear Power histograms relative to an EMA for entries. *Easy / ★*
- **KST oscillator** — Trade KST signal line crosses or zero-line crosses. *Easy / ★*
- **Coppock Curve** — Longer-term momentum oscillator, mainly for swing/position bias. *Easy / ★*

## Crossover / Combo Wrappers

- **Regime filter** — Detect trend vs chop (ADX, Hurst, vol) and route to the appropriate strategy. *Medium / ★★★*
- **Time-of-day filter** — Only allow signals during specific windows (e.g. first 90 min, avoid lunch). *Easy / ★★★*
- **Volume confirmation gate** — Require above-average volume on the signal bar to take the trade. *Easy / ★★★*
- **HTF trend gate on LTF trigger** — Only take LTF entries that align with HTF trend direction (universal wrapper). *Easy / ★★★*

---

## User's Original List (Reference)

- POC range breakout
- VAH / VAL Reversal / Breakout
- LVN & HVN breakout
- Kalman Filter
- Volume based Breakout (use volume as the breakout indicator instead of price)
- Super Trend (See TradingView)
- Exhaustion & Absorption reversal
- Heiken Ashi Indicator
- Squeeze Momentum indicator (look for breakouts in squeezes)
- Bollinger Reversal