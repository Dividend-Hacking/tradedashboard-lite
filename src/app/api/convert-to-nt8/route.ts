/**
 * API route: POST /api/convert-to-nt8
 *
 * Server-side endpoint that takes a dashboard preset (sent as JSON in the
 * request body), transpiles its DSL `script` into a self-contained
 * NinjaScript C# strategy, and writes the resulting .cs file so NT8 can
 * compile + run it.
 *
 * Pipeline:
 *   1. Validate the preset has a `script` field (DSL text). Legacy
 *      presets without a script get upgraded via findTemplateByLegacyId
 *      (the same shim normalizePresetForLoad uses).
 *   2. Transpile DSL → C# via src/lib/utils/nt8-transpile. The output is
 *      a self-contained Strategy subclass of DslStrategyBase.cs that
 *      embeds the preset's rules/filters as inline literals — no
 *      external JSON load required.
 *   3. Write `ninjatrader/strategies/<ClassName>.cs`.
 *   4. Optionally run ninjatrader/deploy-nt8.sh.
 *
 * After the route succeeds, the user still needs to:
 *   - Press F5 in NT8's NinjaScript Editor to compile (deploy-nt8.sh
 *     copies the file into the Parallels shared folder, but NT8 has to
 *     compile it).
 *
 * Local dev only — no auth, paths resolve via process.cwd().
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { transpileDslToCs } from "@/lib/utils/nt8-transpile";

const execAsync = promisify(exec);

// Required for the transpile path. `script` can be missing from a legacy
// preset (strategyId-based) — we'll fill it in via the legacy template
// shim before transpiling. `rules` / `filters` / `params` ride through
// as transpile inputs.
const REQUIRED_FIELDS = ["name", "rules", "filters", "params"];

/** Resolve the DSL script for a preset.
 *
 *  Returns the script directly from `preset.script`. The legacy
 *  findTemplateByLegacyId fallback was REMOVED because it silently
 *  shadowed the user's editor content with a stale built-in template,
 *  causing the dashboard and NT8 to run different strategies. Now: if
 *  preset.script is empty, return null and the API responds with a 400
 *  telling the user to re-save the preset (which captures the current
 *  editor content as the script). */
function resolveDslScript(preset: Record<string, unknown>): { script: string } | null {
  const direct = preset.script;
  if (typeof direct === "string" && direct.trim() !== "") {
    return { script: direct };
  }
  return null;
}

export async function POST(req: NextRequest) {
  let body: {
    preset?: Record<string, unknown>;
    classNameOverride?: string;
    deploy?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const preset = body.preset;
  if (!preset || typeof preset !== "object") {
    return NextResponse.json({ error: "Missing preset in body" }, { status: 400 });
  }

  // Validate the preset has every field PresetLoader.cs reads. Better to
  // fail loudly here than to write a half-baked file that NT8 silently
  // refuses at State.DataLoaded.
  for (const field of REQUIRED_FIELDS) {
    if (!(field in preset)) {
      return NextResponse.json(
        { error: `Preset is missing required field: ${field}` },
        { status: 400 }
      );
    }
  }

  // Resolve the DSL script directly from preset.script — the editor's
  // content captured at save time. No legacy-template fallback (removed
  // because it silently shadowed the user's edits with stale built-ins).
  const resolved = resolveDslScript(preset);
  if (!resolved) {
    return NextResponse.json(
      {
        error:
          "Preset has no DSL script. Re-save the preset in the dashboard — the editor's current content will be persisted as preset.script.",
      },
      { status: 400 }
    );
  }
  const { script } = resolved;

  // Build the effective params dict. preset.params is the user-tuned
  // overrides; paramMeta carries dashboard-inferred defaults for any
  // params.X reference the user never touched. Without this merge, any
  // params.X with no explicit override resolves to NaN in the transpiler
  // — which cascades through the script's signal expressions and
  // typically zeroes out signal firings (round-6 root cause). User
  // overrides win over defaults; defaults fill in the gaps.
  const paramMeta = (preset.paramMeta ?? {}) as Record<
    string,
    { default?: number } | null | undefined
  >;
  const userParams = (preset.params ?? {}) as Record<string, number>;
  const effectiveParams: Record<string, number> = {};
  for (const [k, m] of Object.entries(paramMeta)) {
    const d = m?.default;
    if (typeof d === "number" && Number.isFinite(d)) {
      effectiveParams[k] = d;
    }
  }
  for (const [k, v] of Object.entries(userParams)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      effectiveParams[k] = v;
    }
  }

  // Transpile DSL → C#. This is the only place /api/convert-to-nt8
  // generates code — same module is used by the parity harness so what's
  // tested is exactly what's deployed.
  let transpiled;
  try {
    transpiled = transpileDslToCs({
      presetName: String(preset.name ?? ""),
      classNameOverride: body.classNameOverride,
      script,
      params: effectiveParams,
      rules: (preset.rules ?? {}) as Record<string, unknown>,
      filters: (preset.filters ?? {}) as Record<string, unknown>,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Transpile error" },
      { status: 400 }
    );
  }

  // process.cwd() is the project root in `next dev` / `next start`. The
  // ninjatrader/ folder lives at the repo root, so paths resolve cleanly
  // without any environment-specific knobs.
  const repoRoot = process.cwd();
  const strategiesDir = path.join(repoRoot, "ninjatrader", "strategies");
  const csPath = path.join(strategiesDir, `${transpiled.className}.cs`);
  const className = transpiled.className;

  try {
    await fs.mkdir(strategiesDir, { recursive: true });
    await fs.writeFile(csPath, transpiled.csSource, "utf-8");
  } catch (e) {
    return NextResponse.json(
      {
        error: `Failed to write strategy file: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 500 }
    );
  }

  // Optional auto-deploy step. Off by default — deploying takes a couple
  // seconds and the user might want to batch multiple preset conversions
  // before pushing to the VM. When opted in, run deploy-nt8.sh and bubble
  // up its stdout/stderr so the UI can surface any rsync issues.
  let deployOutput: string | null = null;
  let deployError: string | null = null;
  if (body.deploy) {
    try {
      const { stdout, stderr } = await execAsync(
        "./deploy-nt8.sh",
        { cwd: path.join(repoRoot, "ninjatrader") }
      );
      deployOutput = stdout + (stderr ? `\n${stderr}` : "");
    } catch (e) {
      deployError = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({
    success: true,
    className,
    csPath,
    requiresTicks: transpiled.requiresTicks,
    warnings: transpiled.warnings,
    deployed: body.deploy === true && deployError === null,
    deployOutput,
    deployError,
    nextSteps: body.deploy
      ? deployError
        ? [
            "Deploy failed — check deployError. Run `cd ninjatrader && ./deploy-nt8.sh` manually.",
            "Press F5 in NT8 NinjaScript Editor to compile.",
            `Pick "${className}" in NT8 Strategy Analyzer.`,
          ]
        : [
            "Press F5 in NT8 NinjaScript Editor to compile.",
            `Pick "${className}" in NT8 Strategy Analyzer.`,
          ]
      : [
          "Run `cd ninjatrader && ./deploy-nt8.sh`",
          "Press F5 in NT8 NinjaScript Editor to compile.",
          `Pick "${className}" in NT8 Strategy Analyzer.`,
        ],
  });
}
