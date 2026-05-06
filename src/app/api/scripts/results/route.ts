/**
 * API route: POST /api/scripts/results
 *
 * Persists a per-run snapshot of a dashboard backtest to disk so Claude
 * Code (or any other terminal-side tool) can read and analyse it without
 * having to drive the browser. The dashboard fires this fire-and-forget
 * after each Run-button click when an `activeScriptName` is set.
 *
 * Body shape:
 *   {
 *     scriptName: string,    // e.g. "default.dsl"
 *     payload:    object,    // the buildDetailedExport() return value
 *     csv:        string,    // the buildNt8ComparableTradesCsv() string
 *     summary?:   object     // RunSummary from buildRunSummary() — lean
 *                            // funnel + stats + per-trade rows. Optional
 *                            // for back-compat with older clients; when
 *                            // present, written as <base>__<ISO>.summary.json
 *                            // alongside the .json/.csv pair.
 *   }
 *
 * Output:
 *   - backtests/dashboard-results/<base>__<ISO>.json          (full payload, ~MB)
 *   - backtests/dashboard-results/<base>__<ISO>.csv           (per-trade rows)
 *   - backtests/dashboard-results/<base>__<ISO>.summary.json  (lean ~KB)
 *
 *   <base> is the script name without its .dsl suffix; <ISO> is a
 *   filename-safe ISO timestamp (colons replaced with `-`).
 *
 * No symlink to "latest" — Claude Code can find the newest with `ls -t`.
 *
 * Trust posture: dev-only, no auth (same as the rest of `/api/scripts`).
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  ensureDir,
  resultsDir,
  safeScriptPath,
} from "@/lib/utils/script-file-bridge";

/** ISO timestamp safe for use in a filename. ISO 8601's `:` separator is
 *  legal on macOS/Linux but breaks Windows; we replace it preemptively so
 *  files round-trip across platforms (and so they sort cleanly in a
 *  cross-platform `ls`). */
function fileSafeIso(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, "-");
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON: { scriptName, payload, csv }" },
      { status: 400 }
    );
  }

  const b = body as {
    scriptName?: unknown;
    payload?: unknown;
    csv?: unknown;
    summary?: unknown;
  };
  if (
    typeof b.scriptName !== "string" ||
    !b.payload ||
    typeof b.payload !== "object" ||
    typeof b.csv !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          "Body must include scriptName: string, payload: object, csv: string.",
      },
      { status: 400 }
    );
  }
  // Summary is optional for back-compat — older dashboard builds don't
  // send it. When present it must be an object (we serialize it as JSON).
  if (b.summary !== undefined && (typeof b.summary !== "object" || b.summary === null)) {
    return NextResponse.json(
      { error: "summary, when provided, must be an object." },
      { status: 400 }
    );
  }

  // Reuse the script-name validator so the basename we derive can never
  // contain `..` or path separators. We don't write into `scriptsDir()`
  // here — only borrow the validator — so the absence of a corresponding
  // .dsl file is not an error.
  if (!safeScriptPath(b.scriptName)) {
    return NextResponse.json(
      { error: "Invalid scriptName." },
      { status: 400 }
    );
  }

  const base = b.scriptName.replace(/\.dsl$/, "");
  const stamp = fileSafeIso();
  const dir = resultsDir();
  await ensureDir(dir);

  const jsonPath = path.join(dir, `${base}__${stamp}.json`);
  const csvPath = path.join(dir, `${base}__${stamp}.csv`);
  const summaryPath = path.join(dir, `${base}__${stamp}.summary.json`);

  try {
    // Build the write list dynamically so the summary file is only
    // created when the client provided one. Older clients without
    // summary support produce only the .json + .csv pair, same as
    // before this field was added.
    const writes: Array<Promise<void>> = [
      fs.writeFile(jsonPath, JSON.stringify(b.payload, null, 2), "utf8"),
      fs.writeFile(csvPath, b.csv, "utf8"),
    ];
    if (b.summary) {
      writes.push(
        fs.writeFile(summaryPath, JSON.stringify(b.summary, null, 2), "utf8")
      );
    }
    await Promise.all(writes);
    return NextResponse.json({
      ok: true,
      jsonPath: path.relative(process.cwd(), jsonPath),
      csvPath: path.relative(process.cwd(), csvPath),
      ...(b.summary
        ? { summaryPath: path.relative(process.cwd(), summaryPath) }
        : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
