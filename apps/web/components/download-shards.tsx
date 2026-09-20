"use client";

import { useEffect, useRef, useState } from "react";
import { Progress } from "@repo/ui/primitives/progress";

// Animated shard visual for a download: a row of shard cells that light up as
// each shard lands, with a merged block growing behind them. Each newly-landed
// shard also spawns a "ghost" that flies from its slot into the centre — the
// literal "shards merging" gesture the download widget is meant to show.
//
// Shard counts can be in the hundreds; rendering one DOM node per shard would
// jank the floating widget, so the slots are capped and the completed count is
// scaled proportionally. The bar is decorative, not a precise readout (the byte
// counter below it carries the exact numbers), so the cap is a fair trade.

const MAX_SLOTS = 40;
const FLY_MS = 700;

interface DownloadShardsProps {
  completed: number;
  total: number;
  status: "active" | "done" | "error";
  className?: string;
}

export function DownloadShards({ completed, total, status, className = "" }: DownloadShardsProps) {
  const slots = Math.min(total > 0 ? total : 0, MAX_SLOTS);
  const filled = total > 0 ? Math.round((completed / total) * slots) : 0;
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  const active = status === "active";

  // Ghosts that just landed; removed once their flight animation finishes.
  const [ghosts, setGhosts] = useState<{ id: number; slot: number }[]>([]);
  const previous = useRef(filled);
  const nextId = useRef(0);

  useEffect(() => {
    const before = previous.current;
    if (filled > before) {
      // Only the shards that advanced since the last render fly; replaying every
      // completed slot on each update would turn the bar into a strobe.
      const added = Array.from({ length: filled - before }, (_, i) => ({
        id: nextId.current++,
        slot: before + i,
      }));
      setGhosts((existing) => [...existing, ...added]);
      previous.current = filled;
      const ids = new Set(added.map((ghost) => ghost.id));
      const timer = setTimeout(
        () => setGhosts((existing) => existing.filter((ghost) => !ids.has(ghost.id))),
        FLY_MS,
      );
      return () => clearTimeout(timer);
    }
    previous.current = filled;
  }, [filled, slots, active]);

  // No shard count yet (key unlock / catalog lookup): fall back to the plain bar
  // so the widget still shows motion before the first progress event lands.
  if (slots === 0) {
    return <Progress value={pct} className={className} />;
  }

  return (
    <div className={`relative h-6 ${className}`}>
      {/* Merged block: grows from the centre as shards accumulate. */}
      <div
        className="absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-md accent-gradient transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(pct, 4)}%` }}
      />
      {/* Shard slots, scaled to the file's shard count. */}
      <div
        className="absolute inset-0 grid gap-px"
        style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: slots }, (_, index) => (
          <span
            key={index}
            className={`rounded-[3px] border transition-colors duration-300 ${
              index < filled
                ? "border-accent/50 bg-accent/25"
                : "border-border bg-background/60"
            } ${index === filled - 1 && active ? "shard-land" : ""}`}
          />
        ))}
      </div>
      {/* Landed shards fly into the merged block and fade. */}
      {active &&
        ghosts.map((ghost) => (
          <span
            key={ghost.id}
            aria-hidden
            className="shard-fly-merge pointer-events-none absolute top-1/2 h-3 w-3 rounded-sm accent-gradient"
            style={{
              left: `${((ghost.slot + 0.5) / slots) * 100}%`,
              animationDuration: `${FLY_MS}ms`,
            }}
          />
        ))}
    </div>
  );
}
