"use client";

import { Chip, Spinner } from "@heroui/react";
import type { InvestigationView } from "@opendash/core";
import { CirclePause, Info, Sparkles } from "lucide-react";
import { AnswerText, type TracedRef } from "@/components/ask/answer-text";

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "today", "yesterday", or the day. */
function when(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : DAY.format(new Date(iso));
}

/**
 * An insight's investigation on its card (the Investigator): under way, held (the budget), failed, or its
 * write-up: confirmed or not, what moved, why (most likely first), and what couldn't be checked, every figure a traced
 * cell of its own queries.
 */
export function InvestigationBlock({
  investigation: v,
  now,
  selected,
  onTrace,
}: {
  investigation: InvestigationView;
  now: number;
  /** The key of the figure being traced. */
  selected: string | null;
  onTrace: (ref: TracedRef, key: string) => void;
}) {
  if (v.status === "queued" || v.status === "running") {
    return (
      <p className="flex items-center gap-2 text-small text-muted" role="status">
        <Spinner size="sm" />
        Investigating: counting it again another way…
      </p>
    );
  }
  if (v.status === "held") {
    return (
      <p className="flex items-start gap-2 text-small text-muted-tertiary">
        <CirclePause className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Not investigated. {v.heldReason ?? "The background budget is spent."}
      </p>
    );
  }
  const o = v.outcome;
  if (v.status === "failed" || !o) {
    return (
      <p className="flex items-start gap-2 text-small text-muted-tertiary">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        The investigation didn't finish. Investigate starts it again.
      </p>
    );
  }
  const meta = [
    v.finishedAt ? `Investigated ${when(v.finishedAt, now)}` : "Investigated",
    `${v.queries} ${v.queries === 1 ? "query" : "queries"}`,
    ...(v.costUsd !== null ? [`$${v.costUsd.toFixed(2)}`] : []),
  ].join(" · ");
  return (
    <section aria-label="Investigation" className="flex flex-col gap-2.5 border-t border-border pt-3">
      <header className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-3.5 text-muted" aria-hidden />
        <span className="text-small font-semibold">Investigation</span>
        <Chip size="sm" variant="soft" color={o.confirmed ? "success" : "warning"}>
          {o.confirmed ? "Confirmed" : "Not confirmed"}
        </Chip>
        <span className="ms-auto text-small text-muted-tertiary">{meta}</span>
      </header>
      <AnswerText
        segments={o.moved.segments}
        scope="moved"
        selected={selected}
        unverified={!o.verified}
        onTrace={onTrace}
        className="text-body text-muted"
      />
      {o.reasons.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-micro font-semibold text-muted">Why, most likely first</span>
          <ol className="flex flex-col gap-1.5">
            {o.reasons.map((r, i) => (
              <li key={r.rendered} className="flex items-start gap-2.5">
                <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-micro font-semibold text-muted">
                  {i + 1}
                </span>
                <AnswerText
                  segments={r.segments}
                  scope={`reason-${i}`}
                  selected={selected}
                  unverified={!o.verified}
                  onTrace={onTrace}
                  className="min-w-0 flex-1 text-body"
                />
                <span className="shrink-0 text-small text-muted-tertiary">
                  {r.weight === "explains" ? "Explains it" : "Part of it"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {o.unchecked.length ? (
        <div className="flex items-start gap-2 rounded-lg bg-surface-secondary px-2.5 py-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1 text-small text-muted">
            {o.unchecked.map((u, i) => (
              <span key={u.rendered} className="flex flex-wrap gap-x-1">
                {i === 0 ? <span>Couldn't be checked:</span> : null}
                <AnswerText segments={u.segments} scope={`unchecked-${i}`} className="inline text-small text-muted" />
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
