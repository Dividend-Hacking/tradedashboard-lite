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
 *  bars[i]. NaN slots fill the warmup window (bars 0 .. calib-2). */
export interface KalmanOuBundle {
  x: number[];
  mu: number[];
  sigma: number[];
  phi: number[];
  P: number[];
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
  };
}

/** Compute the Kalman-OU bundle for a bar series. See file-level doc
 *  for the model and parameter conventions. Pure: no I/O, no shared
 *  state — safe to call concurrently from per-zone precomputes. */
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

  // ── 1. Calibration: OLS on AR(1) over the first `calibN` source values.
  //
  //   y_{t+1} = a + b * y_t + e_t
  //
  // We need at least 2 (y_t, y_{t+1}) pairs — i.e. calibN >= 3 to be
  // stable; the early-out above enforces that. Build the y series first
  // so we touch each bar exactly once.
  const ySeries = new Array<number>(calibN);
  for (let i = 0; i < calibN; i++) ySeries[i] = readSource(bars[i], sourceCode);

  let sumX = 0;
  let sumY = 0;
  const pairs = calibN - 1;
  for (let t = 0; t < pairs; t++) {
    sumX += ySeries[t];
    sumY += ySeries[t + 1];
  }
  const meanX = sumX / pairs;
  const meanY = sumY / pairs;

  let sxx = 0;
  let sxy = 0;
  for (let t = 0; t < pairs; t++) {
    const dx = ySeries[t] - meanX;
    sxx += dx * dx;
    sxy += dx * (ySeries[t + 1] - meanY);
  }
  // Degenerate calibration window (constant series → no x-variance) —
  // the AR(1) slope is undefined, so abort with all-NaN.
  if (sxx <= 0) return nanBundle(n);

  let phi = sxy / sxx;
  // Stationarity guard: |phi| < 1 is required for a finite long-run
  // variance. Clamp slightly inside the unit circle so phi^2 in the
  // sigma denominator below stays away from zero. A clamped phi means
  // the calibration was nearly random-walk; the filter still runs but
  // reverts very slowly, which is the honest signal to surface.
  if (!Number.isFinite(phi)) return nanBundle(n);
  if (phi >= 0.999) phi = 0.999;
  if (phi <= -0.999) phi = -0.999;

  const a = meanY - phi * meanX;
  const muVal = a / (1 - phi);

  // Residual variance from the calibration regression — this is Q, the
  // per-step OU innovation variance. Use the unbiased denominator
  // (pairs - 2) when feasible; fall back to (pairs - 1) for very small
  // calibration windows so we never divide by zero.
  let sse = 0;
  for (let t = 0; t < pairs; t++) {
    const fitted = a + phi * ySeries[t];
    const r = ySeries[t + 1] - fitted;
    sse += r * r;
  }
  const dof = pairs > 2 ? pairs - 2 : Math.max(1, pairs - 1);
  const Q = sse / dof;
  if (!(Q > 0)) return nanBundle(n);
  const sigmaLong = Math.sqrt(Q / (1 - phi * phi));

  // Map `trust` to observation noise so the steady-state Kalman gain
  // converges to `trust`. (Solving K_inf = P_inf / (P_inf + R) with the
  // Riccati fixed point under the AR(1) dynamics gives this relation
  // approximately; exact at phi = 0, very close for moderate phi.)
  const R = Q * (1 - trust) / trust;

  // ── 2. Initialize the filter at the last calibration bar so we start
  //      emitting non-NaN values right at index `calibN - 1`. The state
  //      seed is the most recent observation; the variance seed is the
  //      long-run unconditional variance (the most diffuse honest prior
  //      consistent with the model — converges fast under updates).
  const out = nanBundle(n);
  let x = ySeries[calibN - 1];
  let P = sigmaLong * sigmaLong;
  out.x[calibN - 1] = x;
  out.mu[calibN - 1] = muVal;
  out.sigma[calibN - 1] = sigmaLong;
  out.phi[calibN - 1] = phi;
  out.P[calibN - 1] = P;

  // ── 3. Run the Kalman recursion forward. The update uses the new
  //      observation z_t at bar i — the standard predict / gain / update
  //      / variance-shrink quartet. We never re-estimate (mu, phi, Q):
  //      that's the "recalibrate=once" semantics.
  for (let i = calibN; i < n; i++) {
    const z = readSource(bars[i], sourceCode);
    if (!Number.isFinite(z)) {
      // Missing observation — propagate without updating. The math is
      // identical to a Kalman step with infinite R (gain -> 0); we
      // simplify by just running the predict and skipping the update.
      const xPred = muVal + phi * (x - muVal);
      const pPred = phi * phi * P + Q;
      x = xPred;
      P = pPred;
    } else {
      const xPred = muVal + phi * (x - muVal);
      const pPred = phi * phi * P + Q;
      const innovVar = pPred + R;
      // Numerically pPred + R can never be 0 here (R > 0 since trust < 1
      // and Q > 0, plus phi^2*P >= 0), but guard anyway for safety.
      const K = innovVar > 0 ? pPred / innovVar : 0;
      x = xPred + K * (z - xPred);
      P = (1 - K) * pPred;
    }
    out.x[i] = x;
    out.mu[i] = muVal;
    out.sigma[i] = sigmaLong;
    out.phi[i] = phi;
    out.P[i] = P;
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
