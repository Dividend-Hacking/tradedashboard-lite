/**
 * backtest-script-strategy-panel.tsx — UI surface for the script-driven
 * strategy authoring path.
 *
 * Renders three things in one panel:
 *   1. Templates picker — a dropdown of BUILTIN_STRATEGY_TEMPLATES. Selecting
 *      one calls onLoadTemplate(template), which the dashboard wires to
 *      "prepend the template's script into the editor" so users can author
 *      starting from a working strategy.
 *   2. Status line — when the script contains `signal.long.if = …` /
 *      `signal.short.if = …` statements, the engine's strategy override
 *      kicks in and the dropdown-selected strategy is bypassed. We surface
 *      that state here so users aren't surprised by the dropdown's
 *      apparent no-op.
 *   3. Inferred params sidebar — every `params.X` reference in the current
 *      script gets a numeric input. Values are persisted into
 *      `scriptParamOverrides` (controlled by the dashboard) and passed
 *      through to evaluateStrategyScript at run time.
 *
 * This panel renders unconditionally above the script editor — when the
 * script doesn't define `signal.long.if` / `signal.short.if` or any
 * `params.X` references, the panel renders empty (its body is gated on
 * having something to show).
 */

"use client";

import { memo, useMemo } from "react";
import { parseStrategyScript } from "@/lib/utils/strategy-evaluator";
import {
  BUILTIN_STRATEGY_TEMPLATES,
  type StrategyTemplate,
} from "@/lib/utils/built-in-strategies";

export interface InferredParam {
  /** Full path key, e.g. "lookback" (the part after `params.`). */
  key: string;
  /** Current value — caller's source of truth. */
  value: number;
  /** UI hints from the active template's paramMeta or the user's
   *  paramMeta on the preset, if any. */
  meta?: {
    default?: number;
    min?: number;
    max?: number;
    step?: number;
    type?: "int" | "float";
    label?: string;
    description?: string;
  };
}

interface ScriptStrategyPanelProps {
  scriptText: string;
  /** Caller's current value for each inferred params.X. Falls back to
   *  the meta.default when absent, then to 0. */
  scriptParams: Record<string, number>;
  /** Per-key paramMeta — supplied by the active preset's paramMeta or
   *  the most-recently-loaded template. */
  paramMeta: Record<string, InferredParam["meta"]>;
  onParamChange: (key: string, value: number) => void;
  onLoadTemplate: (template: StrategyTemplate) => void;
}

/** Fallback paramMeta sourced from EVERY builtin template — the first
 *  template that defines a given key wins. Used when the user opens a
 *  disk-backed .dsl file (no explicit template-load) but its `params.X`
 *  references happen to share names with builtin templates. Without
 *  this fallback the sidebar would render every input with default 0,
 *  forcing the user to manually re-enter every value. */
function buildTemplateMetaFallback(): Record<string, InferredParam["meta"]> {
  const out: Record<string, InferredParam["meta"]> = {};
  for (const t of BUILTIN_STRATEGY_TEMPLATES) {
    for (const [k, m] of Object.entries(t.paramMeta)) {
      if (!(k in out)) out[k] = m;
    }
  }
  return out;
}

const TEMPLATE_META_FALLBACK = buildTemplateMetaFallback();

function BacktestScriptStrategyPanelImpl({
  scriptText,
  scriptParams,
  paramMeta,
  onParamChange,
  onLoadTemplate,
}: ScriptStrategyPanelProps) {
  // Parse once per scriptText change. parseStrategyScript is cheap
  // (linear in script length) but useMemo lets the panel rerender on
  // unrelated state changes without re-tokenizing.
  const parsed = useMemo(() => parseStrategyScript(scriptText), [scriptText]);

  const hasSignalStmts = parsed.stmts.some((s) => s.kind === "signal");
  const inferredParams = parsed.paramRefs;

  // Filter out errors with severity "warning" — the dashboard surfaces
  // those on the editor gutter; here we only highlight ones that block
  // signal generation.
  const blockingErrors = parsed.errors.filter((e) => e.severity === "error");

  // Don't render the panel at all when the user hasn't engaged the DSL.
  // Prevents visual clutter for the legacy dropdown + paramFields flow.
  if (!hasSignalStmts && inferredParams.length === 0 && blockingErrors.length === 0) {
    return null;
  }

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm text-muted-foreground uppercase tracking-wider">
          Script Strategy
        </h3>
        <select
          onChange={(e) => {
            const id = e.target.value;
            const tpl = BUILTIN_STRATEGY_TEMPLATES.find((t) => t.id === id);
            if (tpl) onLoadTemplate(tpl);
            // Reset to placeholder so picking the same template twice still fires.
            e.target.value = "";
          }}
          defaultValue=""
          className="bg-card border border-card-border rounded-md px-2 py-1 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
        >
          <option value="" disabled>
            Load template…
          </option>
          {BUILTIN_STRATEGY_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {hasSignalStmts ? (
        <p className="text-xs text-accent-green mb-3">
          Signals are defined by the script. The strategy dropdown above is bypassed.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground mb-3">
          No <code className="text-foreground">signal.long.if</code> /{" "}
          <code className="text-foreground">signal.short.if</code> in the script —
          the strategy dropdown drives signal generation.
        </p>
      )}

      {blockingErrors.length > 0 && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <div className="font-medium mb-1">Script parse errors ({blockingErrors.length}):</div>
          <ul className="space-y-0.5">
            {blockingErrors.slice(0, 5).map((e, i) => (
              <li key={i}>
                <span className="text-red-400">L{e.line}</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inferredParams.length > 0 && (
        <>
          <div className="text-xs text-muted-foreground mb-2">
            Inferred params ({inferredParams.length}) — values feed{" "}
            <code className="text-foreground">params.X</code> at evaluation.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {inferredParams.map((fullName) => {
              // params.X — strip the prefix to get the bare key the
              // evaluator stores in paramOverrides.
              const key = fullName.replace(/^params\./, "");
              // Resolve meta from props first (template-loaded or
              // preset-saved), falling back to whatever any builtin
              // template defines for this key. This makes a freshly-
              // opened disk script display sensible defaults instead
              // of zeros.
              const meta =
                paramMeta[key] ?? TEMPLATE_META_FALLBACK[key] ?? undefined;
              const value =
                scriptParams[key] ?? meta?.default ?? 0;
              const step = meta?.step ?? (meta?.type === "int" ? 1 : 0.1);
              return (
                <label
                  key={key}
                  className="flex flex-col gap-1"
                  title={meta?.description ?? `params.${key}`}
                >
                  <span className="text-xs text-muted-foreground">
                    {meta?.label ?? key}
                  </span>
                  <input
                    type="number"
                    defaultValue={value}
                    min={meta?.min}
                    max={meta?.max}
                    step={step}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) onParamChange(key, n);
                    }}
                    className="bg-card border border-card-border rounded-md px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
                  />
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Memoized so a parent re-render with unchanged props (the common case
// during fast typing in the script editor — `scriptText` is the only
// prop that mutates per keystroke, and the panel correctly re-runs its
// `parseStrategyScript` useMemo when it does) skips the body entirely.
// Default shallow compare covers all props.
export const BacktestScriptStrategyPanel = memo(BacktestScriptStrategyPanelImpl);
