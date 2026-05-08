/**
 * Server actions for the Settings page. Writes mode + endpoint to the
 * disk config and revalidates every route so the next navigation re-
 * renders against the new mode.
 */

"use server";

import { revalidatePath } from "next/cache";
import { writeMode, type ModeConfig } from "@/lib/mode";

export async function setModeAction(cfg: ModeConfig): Promise<void> {
  await writeMode(cfg);
  // 'layout' scope invalidates every route under the root layout —
  // including all server components — so the next navigation reads the
  // new mode. We deliberately don't hot-flip running tabs; that would
  // require tearing down every Supabase Realtime channel and restarting
  // every polling loop atomically, which is fragile. The settings UI
  // shows a "refresh to apply" banner instead.
  revalidatePath("/", "layout");
}
