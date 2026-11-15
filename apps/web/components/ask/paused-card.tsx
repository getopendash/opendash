"use client";

import { Button } from "@heroui/react";
import type { RunOutcome } from "@opendash/core";
import { CirclePause, Play } from "lucide-react";
import Link from "next/link";

type Paused = Extract<RunOutcome, { kind: "paused" }>;

const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * A run that paused: at the workspace's ceiling, or after a long stretch of work. Everything it
 * did is kept; Continue is the next turn, which picks up from it. Never a failure.
 */
export function PausedCard({
  outcome,
  question,
  can,
  onAsk,
}: {
  outcome: Paused;
  /** The question it was working on: Continue carries it, so what it asked for (a "remember this") still counts. */
  question: string;
  can: boolean;
  onAsk?: (text: string) => void;
}) {
  const why =
    outcome.reason === "limit"
      ? `It reached what's left of this workspace's spend limit (${money(outcome.spentUsd)} spent). An owner or admin can raise it in Settings → Usage.`
      : outcome.reason === "ceiling" && outcome.ceilingUsd !== null
        ? `It reached this workspace's ceiling for one run: ${money(outcome.spentUsd)} of ${money(outcome.ceilingUsd)}.`
        : outcome.reason === "ceiling"
          ? `It spent ${money(outcome.spentUsd)}.`
          : "It worked for a long stretch without finishing.";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <CirclePause className="size-4 text-muted" aria-hidden />
        <span className="text-body font-medium">Paused</span>
      </div>
      <p className="text-body text-muted">
        {why} Everything it did is kept: Continue picks up where it stopped, and nothing runs twice.
      </p>
      {can && onAsk ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onPress={() => onAsk(`Continue with: ${question}`)}>
            <Play className="size-3.5" aria-hidden />
            Continue
          </Button>
          {outcome.reason === "ceiling" ? (
            <Link href="/settings/usage" className="text-small text-muted hover:text-foreground">
              The ceiling is in Settings → Usage
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
