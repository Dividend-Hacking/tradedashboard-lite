/**
 * nt8-transpile/index.ts — Public entry point for the DSL → NinjaScript
 * transpiler.
 *
 * Two callers in the codebase:
 *   - /api/convert-to-nt8 (the dashboard's "TO NT8" button) — writes
 *     the generated .cs to ninjatrader/strategies/<ClassName>.cs.
 *   - scripts/parity-harness.ts (the parity test runner) — uses the
 *     same code path so what's tested is exactly what's deployed.
 *
 * The transpiler does not write files itself — it returns a
 * TranspileResult and lets the caller decide where to put the bytes.
 * This keeps the module testable in isolation (no fs side effects)
 * and lets the harness diff against a previous good output without
 * touching disk.
 */

export {
  transpileDslToCs,
  deriveClassName,
  type TranspileInput,
  type TranspileResult,
} from "./strategy-emit";
