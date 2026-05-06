"use client";

/**
 * PlaybackControls — Transport controls for the market replay.
 *
 * Play/pause, step forward/back, speed selector, progress slider,
 * and current bar time display. Keyboard shortcuts are handled by
 * the parent replay-viewer component.
 */

import { ReplayState, REPLAY_SPEEDS, getProgress, isAtEnd, isAtStart, getCurrentBar } from "@/lib/utils/replay-engine";
import { formatTime } from "@/lib/utils/format";

interface PlaybackControlsProps {
  state: ReplayState;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onJumpTo: (index: number) => void;
  onSetSpeed: (speed: number) => void;
  onReset: () => void;
}

export default function PlaybackControls({
  state,
  onTogglePlay,
  onStepForward,
  onStepBackward,
  onJumpTo,
  onSetSpeed,
  onReset,
}: PlaybackControlsProps) {
  const progress = getProgress(state);
  const atEnd = isAtEnd(state);
  const atStart = isAtStart(state);
  const currentBar = getCurrentBar(state);

  const timeDisplay = currentBar ? formatTime(currentBar.bar_time) : "--:--:--";

  // Format bar counter
  const barCounter = `${state.currentIndex} / ${state.bars.length}`;

  return (
    <div className="bg-card border border-card-border rounded-lg p-3 flex flex-col gap-3">
      {/* Progress slider */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground w-16 text-right font-mono">
          {timeDisplay}
        </span>
        <input
          type="range"
          min={0}
          max={state.bars.length}
          value={state.currentIndex}
          onChange={(e) => onJumpTo(parseInt(e.target.value))}
          className="flex-1 h-1.5 accent-accent-green cursor-pointer"
        />
        <span className="text-xs text-muted-foreground w-20 font-mono">
          {barCounter}
        </span>
      </div>

      {/* Transport buttons + speed */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {/* Reset */}
          <button
            onClick={onReset}
            disabled={atStart}
            className="px-2 py-1.5 rounded text-xs bg-card border border-card-border
                       text-muted-foreground hover:text-foreground hover:border-muted
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Reset (Home)"
          >
            ⏮
          </button>

          {/* Step Back */}
          <button
            onClick={onStepBackward}
            disabled={atStart}
            className="px-2 py-1.5 rounded text-xs bg-card border border-card-border
                       text-muted-foreground hover:text-foreground hover:border-muted
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Step Back (←)"
          >
            ◀
          </button>

          {/* Play/Pause */}
          <button
            onClick={onTogglePlay}
            disabled={atEnd && !state.isPlaying}
            className="px-4 py-1.5 rounded text-sm font-medium bg-card border border-card-border
                       text-foreground hover:border-accent-green
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Play/Pause (Space)"
          >
            {state.isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>

          {/* Step Forward */}
          <button
            onClick={onStepForward}
            disabled={atEnd}
            className="px-2 py-1.5 rounded text-xs bg-card border border-card-border
                       text-muted-foreground hover:text-foreground hover:border-muted
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Step Forward (→)"
          >
            ▶
          </button>
        </div>

        {/* Speed selector */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">Speed:</span>
          {REPLAY_SPEEDS.map((speed) => (
            <button
              key={speed}
              onClick={() => onSetSpeed(speed)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                state.speed === speed
                  ? "bg-accent-green/20 text-accent-green border border-accent-green/40"
                  : "bg-card border border-card-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
