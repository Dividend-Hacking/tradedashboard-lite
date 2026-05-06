/**
 * API route: /api/scripts/[name]
 *
 * Per-file CRUD for DSL scripts on disk:
 *   - GET    → read the file's content + mtime
 *   - PUT    → atomic write; body { content }; returns the post-write mtime
 *              so the caller can suppress its own SSE echo
 *   - DELETE → remove the file
 *
 * Validation is done in `safeScriptPath()` — the `[name]` segment is
 * regex-checked AND resolved-and-bounds-checked against the scripts root.
 * Any name that fails either layer returns 400 (never reads / writes).
 *
 * Trust posture matches the rest of `/api/scripts`: dev-only, no auth,
 * same as the convert-to-nt8 route. The dashboard runs locally; the user
 * is the only caller.
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import {
  atomicWrite,
  readFileWithMtime,
  safeScriptPath,
} from "@/lib/utils/script-file-bridge";

interface RouteContext {
  params: Promise<{ name: string }>;
}

/** Resolve and validate the path. Returns either the absolute path or a
 *  400 NextResponse the caller can return directly. Inlined helper because
 *  every method needs the same prelude. */
async function resolveOr400(
  ctx: RouteContext
): Promise<{ abs: string } | { error: NextResponse }> {
  const { name } = await ctx.params;
  const abs = safeScriptPath(name);
  if (!abs) {
    return {
      error: NextResponse.json(
        {
          error:
            "Invalid script name. Must match [A-Za-z0-9._-]+\\.dsl and resolve inside backtests/scripts.",
        },
        { status: 400 }
      ),
    };
  }
  return { abs };
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const r = await resolveOr400(ctx);
  if ("error" in r) return r.error;
  try {
    const result = await readFileWithMtime(r.abs);
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { name } = await ctx.params;
    return NextResponse.json({
      name,
      content: result.content,
      mtimeMs: result.mtimeMs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest, ctx: RouteContext) {
  const r = await resolveOr400(ctx);
  if ("error" in r) return r.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON: { content: string }" },
      { status: 400 }
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { content?: unknown }).content !== "string"
  ) {
    return NextResponse.json(
      { error: "Body must include a string `content` field." },
      { status: 400 }
    );
  }
  const content = (body as { content: string }).content;
  try {
    const mtimeMs = await atomicWrite(r.abs, content);
    const { name } = await ctx.params;
    return NextResponse.json({ name, mtimeMs });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const r = await resolveOr400(ctx);
  if ("error" in r) return r.error;
  try {
    await fs.unlink(r.abs);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
