/**
 * Pipeline Page (Server Shell)
 *
 * Thin server wrapper that mounts the PipelineBoard client component.
 * The board itself owns all data: it loads presets from localStorage
 * for instant render and reconciles with Supabase via
 * syncPresetsFromSupabase on mount, exactly like the backtest dashboard's
 * preset selector does. Putting the page-level fetch on the client keeps
 * the SSR pass cheap and avoids the auth/cookie dance for what is
 * fundamentally a per-browser cache view.
 */

import PipelineBoard from "@/components/pipeline/pipeline-board";

export default function PipelinePage() {
  return (
    <div className="px-4 md:px-8 py-4 h-[calc(100vh-52px)] overflow-auto">
      <PipelineBoard />
    </div>
  );
}
