"use client";

import { type ReactNode, useMemo } from "react";
import { runSteps } from "@/lib/run-steps";
import { useRunFeed } from "./use-run-feed";

/** A run that's still going: its steps keep coming. */
const ACTIVE = new Set(["queued", "running"]);

/**
 * The App while the agent works on it: a light travels round its edge, and a pill at its foot says what the agent is
 * doing now (the step the chat shows as running), until the run ends. Nothing in the App is covered or blocked. The
 * run's events are the page's one read of them, shared with the build bar.
 */
export function BuildingFrame({ runId, children }: { runId: string; children: ReactNode }) {
  const { events, status, unreadable, failing } = useRunFeed(runId);
  // Not readable here (not theirs, gone), or not answering: no indicator rather than one that never ends.
  const active = ACTIVE.has(status) && !unreadable && !failing;

  // What it's doing now: the step running last, in the chat's own words.
  const doing = useMemo(() => {
    const running = runSteps([...events], { source: "" }).filter((s) => s.status === "running");
    const step = running.at(-1);
    if (!step) return "Working on your App";
    return step.detail && step.label.startsWith("Writing") ? `${step.label} · ${step.detail}` : step.label;
  }, [events]);

  if (!active) return <>{children}</>;
  return (
    <div className="app-building flex min-h-0 flex-1 flex-col rounded-xl">
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute bottom-5 left-1/2 z-3 flex h-8 max-w-md -translate-x-1/2 items-center gap-2 rounded-full bg-accent px-3.5 text-small font-medium text-accent-foreground shadow-sm"
      >
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent-foreground motion-reduce:animate-none"
        />
        <span className="truncate">{doing}…</span>
      </div>
    </div>
  );
}
