/**
 * kalman-ou.ts — Kalman-filtered Ornstein–Uhlenbeck mean-reversion estimator.
 *
 * Models the chosen price source as a discrete-time mean-reverting AR(1):
 *
 *     X_{t+1} = mu + phi * (X_t - mu) + eps_{t+1},  eps ~ N(0, Q)
 *
 * with noisy observations  z_t = X_t + nu_t, nu ~ N(0, R). A standard
 * scalar Kalman recursion produces an online estimate `x_t` of the latent
 * mean-reverting state. Outputs at each bar:
 *
 *   - `x`       — filtered state estimate (the "fair value" right now)
 *   - `mu`      — long-run mean from calibration (constant under "once")
 *   - `sigma`   — long-run unconditional std of the OU process
 *                 (sigma_innovation / sqrt(1 - phi^2)) — the natural scale
 *                 for `(close - kf.x) / kf.sigma` z-score divisors
 *   - `phi`     — AR(1) persistence coefficient from calibration
 *   - `P`       — current posterior state variance (filter uncertainty)
 *
 * Recalibration is "once" only in v1: (mu, phi, sigma_innov) are estimated
 * from the first `calib` bars via OLS on the AR(1) form, then frozen for
 * the remainder of the series. Rolling / expanding modes are a future
 * extension; the API space (an extra arg) is left open for them.
 *
 * `trust` ∈ (0,1) is a friendly knob for the steady-state Kalman gain:
 * the implementation sets R = Q * (1 - trust) / trust, so as the filter's
 * P converges to its steady state, K → trust. Small trust = heavy
 * smoothing toward the OU prediction; large trust = closer to raw price.
 *
 * NaN-as-fail discipline: any failure of preconditions (insufficient bars,
 * degenerate calibration, out-of-range `trust`, unknown source code)
 * returns an all-NaN bundle so downstream DSL evaluation degrades cleanly
 * via the standard NaN-rejection paths used by every other indicator here.
 */

import type { IndicatorBar } from "@/lib/indicators/calculations";

/** Numeric source codes — kept tiny so the value can be shoved into the
 *  generic indicator-arg pipeline (which stores `number[]`). The DSL
 *  layer maps the bare ident `close` / `open` / etc. to one of these
 *  before calling into the math layer. Not exposed publicly outside
 *  the indicator wiring. */
export const KALMAN_SOURCE_CODES: Record<string, number> = {
  close: 1,
  open: 2,
  high: 3,
  low: 4,
  typical: 5,
  median_price: 6,
  weighted_close: 7,
};

/** Pull the configured source value from a bar. Mirrors the source
 *  constants the strategy evaluator's `resolveIdent` already exposes
 *  (typical = (H+L+C)/3, median_price = (H+L)/2, weighted_close =
 *  (H+L+2C)/4) so `KALMAN_OU(typical, ...)` and a hand-written
 *  `(high + low + close) / 3` Kalman would agree. */
function readSource(bar: IndicatorBar, code: number): number {
  switch (code) {
    case 1: return bar.bar_close;
    case 2: return bar.bar_open;
    case 3: return bar.bar_high;
    case 4: return bar.bar_low;
    case 5: return (bar.bar_high + bar.bar_low + bar.bar_close) / 3;
    case 6: return (bar.bar_high + bar.bar_low) / 2;
    case 7: return (bar.bar_high + bar.bar_low + 2 * bar.bar_close) / 4;
    default: return NaN;
  }
}

/** Time-aligned arrays for each output field — index `i` corresponds to
 *  bars[i]. NaN slots fill the warmup window (bars 0 .. calib-1; the
 *  filter starts emitting at bar `calib`).
 *
 *  Two distinct "state" fields:
 *    - `x`       — POST-fit estimate: the Kalman posterior at bar i,
 *                  computed AFTER absorbing close[i]. Same-bar
 *                  comparisons against `x` (e.g. `(close - kf.x) /
 *                  sigma`) measure the post-fit residual, NOT the OU
 *                  innovation. Useful for "where is fair value RIGHT
 *                  NOW given everything I know including this bar."
 *    - `x_pred`  — PRE-fit prediction: `mu + phi * (x[i-1] - mu)`,
 *                  the OU model's forecast for bar i given everything
 *                  known BEFORE bar i opens. Use this as the divisor
 *                  baseline for unbiased z-scores
 *                  (`(close - kf.x_pred) / kf.sigma` is the true OU
 *                  innovation, not a post-fit residual). For honest
 *                  backtests of mean-reversion entries, prefer
 *                  `x_pred` over `x`. */
export interface KalmanOuBundle {
  x: number[];
  mu: number[];
  sigma: number[];
  phi: number[];
  P: number[];
  x_pred: number[];
}

/** Allocate an all-NaN bundle of the requested length — the standard
 *  failure return so callers don't crash on degenerate inputs. */
function nanBundle(n: number): KalmanOuBundle {
  return {
    x: new Array<number>(n).fill(NaN),
    mu: new Array<number>(n).fill(NaN),
    sigma: new Array<number>(n).fill(NaN),
    phi: new Array<number>(n).fill(NaN),
    P: new Array<number>(n).fill(NaN),
    x_pred: new Array<number>(n).fill(NaN),
  };
}

/** Compute the Kalman-OU bundle for a bar series with ROLLING
 *  calibration. At every bar `i >= calib`, the OU parameters
 *  `(mu, phi, sigma_long, Q, R)` are refit via OLS over the
 *  immediately preceding `calib` bars `[i-calib .. i-1]`, then a
 *  single Kalman step incorporates the observation at bar `i`. This
 *  has two important properties vs the previous "fit-once, freeze"
 *  semantics:
 *
 *    1. **Path-independent.** The bundle's value at any absolute bar
 *       depends only on the `calib` bars immediately preceding it
 *       and the new observation — NOT on the start of the input
 *       array. So the strategy-evaluator path (full-session bars)
 *       and the entry-context precompute path (pre-entry +
 *       post-entry combined) compute the SAME `kf.x[i]` for the same
 *       absolute bar `i` (assuming both paths see the same
 *       underlying bars). No more "two different `kf.x` for one
 *       trade" surprise.
 *
 *    2. **Out-of-sample throughout.** Calibration always trails the
 *       bar being filtered — never includes bar `i` itself or any
 *       later bar. Eliminates the in-sample bias that came from
 *       fitting `(mu, phi, sigma)` on the SAME bars the strategy
 *       later traded.
 *
 *  The OLS sufficient statistics (sum, sum-of-squares, residual SSE)
 *  are maintained as O(1) rolling updates so the per-bar cost stays
 *  flat regardless of `calib`. Pure: no I/O, no shared state — safe
 *  to call concurrently from per-zone precomputes. */
export function kalmanOuBundle(
  bars: IndicatorBar[],
  source: number,
  calib: number,
  trust: number,
): KalmanOuBundle {
  const n = bars.length;
  // Validate inputs up front — return all-NaN on any failure rather
  // than throwing, matching the rest of the calculations.ts contract.
  if (n === 0) return nanBundle(0);
  if (!Number.isFinite(source) || !KALMAN_SOURCE_CODES_REVERSE[Math.round(source)]) {
    return nanBundle(n);
  }
  const sourceCode = Math.round(source);
  const calibN = Math.round(calib);
  if (!Number.isFinite(calibN) || calibN < 3) return nanBundle(n);
  if (!Number.isFinite(trust) || trust <= 0 || trust >= 1) return nanBundle(n);
  if (n < calibN + 1) return nanBundle(n);

  // Pre-extract the source series so we touch each bar exactly once
  // (and the rolling loop reads cheap array slots, not bar fields).
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) y[i] = readSource(bars[i], sourceCode);

  // ── Initialize the filter state ──
  // The first bar we can output at is `calibN` — that's the first bar
  // where the calibration window `[0 .. calibN-1]` is fully behind us.
  // Initial filter state is seeded from `y[calibN-1]` (the most recent
  // observation BEFORE the first emit bar) so the very first Kalman
  // step at i=calibN has a sensible prior to update against. P is
  // seeded with the calibration-window long-run variance — diffuse but
  // well-scaled, converges fast.
  const out = nanBundle(n);
  let x = y[calibN - 1];
  let P = 0; // Real value set after the first calibration below.

  // OU-model state, refreshed every bar from the rolling OLS:
  let mu = NaN;
  let phi = NaN;
  let Q = NaN;
  let sigmaLong = NaN;
  let R = NaN;

  // The (y_t, y_{t+1}) pairs over the rolling window are indexed
  // t in [winStart .. winEnd-1], where for the calibration that ends
  // at bar i (exclusive) we have winStart = i-calibN, winEnd = i-1.
  // The number of pairs is `pairs = calibN - 1`, constant.
  const pairs = calibN - 1;
  const dof = pairs > 2 ? pairs - 2 : Math.max(1, pairs - 1);

  // O(1) rolling OLS sufficient stats over the y_t side of pairs:
  //   sumX  = Σ y_t        (t in window)
  //   sumY  = Σ y_{t+1}
  //   sumXX = Σ y_t^2
  //   sumXY = Σ y_t * y_{t+1}
  //   sumYY = Σ y_{t+1}^2  (used for SSE = sumYY - a*sumY - b*sumXY)
  // Maintained as the window slides forward by one bar each step.
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  // Seed the rolling sums with the very first calibration window
  // [t = 0 .. pairs-1], which uses bars [0 .. calibN-1]. Adding pair
  // t corresponds to: y_t = y[t], y_{t+1} = y[t+1].
  for (let t = 0; t < pairs; t++) {
    const yt = y[t];
    const yt1 = y[t + 1];
    sumX += yt;
    sumY += yt1;
    sumXX += yt * yt;
    sumXY += yt * yt1;
    sumYY += yt1 * yt1;
  }

  // Run the (calibrate, predict, update) loop from bar calibN onwards.
  // At each step we:
  //   1. Refit (mu, phi, Q, sigmaLong, R) from the rolling sufficient
  //      stats — these reflect the window ending at bar i-1.
  //   2. Predict: x_pred = mu + phi*(x_prev - mu); pPred = phi^2 * P + Q.
  //   3. Update with observation y[i] (or skip update on NaN obs).
  //   4. Slide the window forward: drop pair (i-calibN), add pair
  //      (i-1) using the next iteration's bars.
  for (let i = calibN; i < n; i++) {
    // Step 1: rolling OLS fit. Window covers pairs [t = i-calibN .. i-1-1],
    // i.e. bars [i-calibN .. i-1]. (After the initial seed above, this
    // window for i = calibN matches exactly.)
    const meanX = sumX / pairs;
    const meanY = sumY / pairs;
    const sxx = sumXX - sumX * meanX;
    const sxy = sumXY - sumX * meanY;
    let stepOk = sxx > 0;
    let xPred: number;
    if (stepOk) {
      let phiNew = sxy / sxx;
      if (!Number.isFinite(phiNew)) {
        stepOk = false;
      } else {
        // Stationarity guard — keep phi strictly inside the unit
        // circle so phi^2 in the sigma denominator stays away from
        // zero. A clamped phi means the window looked nearly
        // random-walk; the filter still runs but reverts very slowly,
        // which is the honest signal to surface.
        if (phiNew >= 0.999) phiNew = 0.999;
        else if (phiNew <= -0.999) phiNew = -0.999;
        const aLin = meanY - phiNew * meanX;
        // SSE via the algebraic identity
        //   SSE = Σ (y_{t+1} - a - b*y_t)^2
        //       = sumYY - 2*a*sumY - 2*b*sumXY + 2*a*b*sumX
        //         + a^2 * pairs + b^2 * sumXX
        // Cheaper than recomputing from scratch every bar, equivalent
        // to the residual-loop form used in the legacy fit-once code.
        const sse =
          sumYY
          - 2 * aLin * sumY
          - 2 * phiNew * sumXY
          + 2 * aLin * phiNew * sumX
          + aLin * aLin * pairs
          + phiNew * phiNew * sumXX;
        const Qnew = sse / dof;
        if (!(Qnew > 0)) {
          stepOk = false;
        } else {
          phi = phiNew;
          Q = Qnew;
          mu = aLin / (1 - phi);
          sigmaLong = Math.sqrt(Q / (1 - phi * phi));
          R = Q * (1 - trust) / trust;
          // First successful calibration also seeds P with the
          // long-run variance so the first Kalman update lands on a
          // diffuse-but-correctly-scaled prior. All subsequent steps
          // inherit P from the previous iteration.
          if (!Number.isFinite(P) || P === 0) {
            P = sigmaLong * sigmaLong;
          }
        }
      }
    }

    if (!stepOk) {
      // Calibration window was degenerate (constant prices, etc.) or
      // produced unusable Q/phi. Emit NaN for this bar and roll the
      // window forward without updating filter state — the next bar's
      // window may include enough variation to recover.
      out.x[i] = NaN;
      out.mu[i] = NaN;
      out.sigma[i] = NaN;
      out.phi[i] = NaN;
      out.P[i] = NaN;
      out.x_pred[i] = NaN;
    } else {
      // Step 2: predict — uses the freshly-fit (mu, phi) and the
      // previous filter state x. Capture x_pred BEFORE the update so
      // the bundle's x_pred[i] is the OU model's forecast for bar i
      // given everything known BEFORE bar i opens. This is the right
      // baseline for innovation z-scores; the post-fit `x[i]` (set
      // below) is contaminated by the bar-i observation.
      xPred = mu + phi * (x - mu);
      const pPred = phi * phi * P + Q;

      // Step 3: update.
      const z = y[i];
      if (!Number.isFinite(z)) {
        // Missing observation — propagate without updating (Kalman
        // step with infinite R, K → 0). Emit the prediction as the
        // posterior since there's no new evidence.
        x = xPred;
        P = pPred;
      } else {
        const innovVar = pPred + R;
        const K = innovVar > 0 ? pPred / innovVar : 0;
        x = xPred + K * (z - xPred);
        P = (1 - K) * pPred;
      }

      out.x[i] = x;
      out.mu[i] = mu;
      out.sigma[i] = sigmaLong;
      out.phi[i] = phi;
      out.P[i] = P;
      out.x_pred[i] = xPred;
    }

    // Step 4: slide the window forward by one bar so the NEXT
    // iteration's calibration covers [i-calibN+1 .. i]. Drop the
    // oldest pair (y[i-calibN], y[i-calibN+1]) and add the newest
    // pair (y[i-1], y[i]).
    if (i + 1 < n) {
      const dropT = i - calibN; // index of the pair leaving the window
      const yDrop = y[dropT];
      const yDropNext = y[dropT + 1];
      sumX -= yDrop;
      sumY -= yDropNext;
      sumXX -= yDrop * yDrop;
      sumXY -= yDrop * yDropNext;
      sumYY -= yDropNext * yDropNext;

      const yAdd = y[i - 1];
      const yAddNext = y[i];
      sumX += yAdd;
      sumY += yAddNext;
      sumXX += yAdd * yAdd;
      sumXY += yAdd * yAddNext;
      sumYY += yAddNext * yAddNext;
    }
  }

  return out;
}

/** Reverse lookup for source-code validation in `kalmanOuBundle`. Rebuilt
 *  once at module load — small set, never mutated. */
const KALMAN_SOURCE_CODES_REVERSE: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(KALMAN_SOURCE_CODES)) out[v] = k;
  return out;
})();

/** Per-zone bundle cache so `KALMAN_OU_x`, `KALMAN_OU_mu`, … on the same
 *  (source, calib, trust) tuple share one Kalman pass. Mirrors the
 *  ProfileCache pattern used by the volume-profile family — built once
 *  per zone in `precomputeIndicators` and threaded into every
 *  `computeIndicatorSeries` call. */
export class KalmanOuCache {
  private map = new Map<string, KalmanOuBundle>();

  constructor(private readonly bars: IndicatorBar[]) {}

  get(source: number, calib: number, trust: number): KalmanOuBundle {
    const key = `${source}:${calib}:${trust}`;
    let cached = this.map.get(key);
    if (!cached) {
      cached = kalmanOuBundle(this.bars, source, calib, trust);
      this.map.set(key, cached);
    }
    return cached;
  }
}
