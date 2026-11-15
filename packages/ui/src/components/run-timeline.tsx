"use client";

import type { ReactNode } from "react";

/** What a stretch of a run's time was spent on. */
export type TimelineKind = "model" | "tool" | "wait" | "running" | "span";

export interface TimelineRow {
  id: string;
  label: string;
  /** 0: the run; 1: its model calls; 2: a helper's (a drafter). */
  level: 0 | 1 | 2;
  icon?: ReactNode;
  /** Its time, as a person reads it ("6.1s", "2m 35s"). */
  time?: string;
  /** Each stretch, as fractions of the timeline (0 its start, 1 its end or now). */
  segments: { from: number; to: number; kind: TimelineKind }[];
}

const FILL: Record<TimelineKind, string> = {
  model: "fill-accent",
  tool: "fill-muted-tertiary",
  wait: "fill-default",
  running: "fill-accent-soft stroke-accent",
  span: "fill-default",
};

const INDENT = ["ps-1", "ps-5", "ps-9"] as const;
const W = 1000;

/** One row's bars: an SVG on a fixed scale, so they line up with every other row and the ticks above. */
function Bars({ row, marks }: { row: TimelineRow; marks: number[] }) {
  return (
    <svg
      viewBox={`0 0 ${W} 12`}
      preserveAspectRatio="none"
      className="h-3 w-full overflow-visible"
      role="img"
      aria-label={`${row.label}: ${row.segments.length} ${row.segments.length === 1 ? "stretch" : "stretches"}`}
    >
      {row.segments.map((s, i) => {
        const x = Math.max(0, Math.min(W, s.from * W));
        // A call of a few milliseconds still shows: at least a sliver.
        const width = Math.max(5, Math.min(W, s.to * W) - x - 1);
        const thin = s.kind === "span";
        return (
          <rect
            // Two calls can run the same stretch (draft_tables × 4, two still going): by place, not by stretch.
            // biome-ignore lint/suspicious/noArrayIndexKey: the segments are redrawn whole, never reordered
            key={i}
            x={x}
            y={thin ? 5 : 1}
            width={width}
            height={thin ? 2 : 10}
            className={FILL[s.kind]}
            strokeWidth={s.kind === "running" ? 1 : 0}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {marks.map((m, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: two attempts can start in the same instant
          key={i}
          x1={m * W}
          x2={m * W}
          y1={-4}
          y2={16}
          className="stroke-warning"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/**
 * A run's timeline: each model call and tool call on one time axis, helpers as lanes beside each other,
 * a new attempt marked across every row. Rows can be chosen, to show their calls below.
 */
export function RunTimeline({
  rows,
  ticks,
  marks = [],
  selected = null,
  onSelect,
}: {
  rows: TimelineRow[];
  /** The axis's labels, spread evenly from its start to its end ("0s", "30s", …). */
  ticks: string[];
  /** Where a new attempt began, as fractions of the timeline. */
  marks?: number[];
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="@container flex flex-col">
      <div className="flex items-center gap-3 pb-1 @lg:gap-4">
        <span className="w-36 shrink-0 text-small text-muted-tertiary @lg:w-56">Step</span>
        <span className="flex min-w-0 flex-1 justify-between text-micro text-muted-tertiary tabular-nums">
          {ticks.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a just-started run's ticks all read "0.0s"
            <span key={i}>{t}</span>
          ))}
        </span>
      </div>
      <ol className="flex flex-col">
        {rows.map((row) => {
          const label = (
            <span className={`flex w-36 shrink-0 items-center gap-1.5 @lg:w-56 ${INDENT[row.level]}`}>
              {row.icon ? <span className="flex shrink-0 text-muted">{row.icon}</span> : null}
              <span title={row.label} className={`truncate text-small ${row.level === 0 ? "font-semibold" : ""}`}>
                {row.label}
              </span>
              {row.time ? (
                <span className="ms-auto shrink-0 text-micro text-muted-tertiary tabular-nums">{row.time}</span>
              ) : null}
            </span>
          );
          const body = (
            <>
              {label}
              <span className="flex min-w-0 flex-1">
                <Bars row={row} marks={marks} />
              </span>
            </>
          );
          return (
            <li key={row.id}>
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={selected === row.id}
                  onClick={() => onSelect(row.id)}
                  className={`flex w-full items-center gap-3 rounded-lg py-1.5 text-start hover:bg-surface-secondary @lg:gap-4 ${
                    selected === row.id ? "bg-surface-secondary" : ""
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-3 py-1.5 @lg:gap-4">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
