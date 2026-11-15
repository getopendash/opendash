import { ProgressBar } from "@heroui/react";
import type { Readiness, ReadinessAction } from "@opendash/core";
import { CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";
import { ReadinessSync } from "./readiness-sync";

/** Where each next step is done. A sync (the top bar's Sync now) indexes values and tests every definition again. */
const HREF: Record<Exclude<ReadinessAction, "sync" | "learn">, string> = {
  verify_dataset: "/knowledge/datasets",
  verify_metrics: "/knowledge/metrics",
  verify_queries: "/knowledge/verified",
  add_evals: "/knowledge/evals",
  run_evals: "/knowledge/evals",
};

/** How ready a source is to answer questions, out of 100, with what to do next. Owners and admins only. */
export function ReadinessPanel({
  sourceId,
  name,
  readiness,
}: {
  sourceId: string;
  name: string;
  readiness: Readiness;
}) {
  return (
    <section aria-labelledby="readiness-title" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="readiness-title" className="text-body font-medium">
          Readiness
        </h2>
        <span className="text-small text-muted-tertiary">Only admins see this</span>
      </div>
      <div className="flex flex-col rounded-2xl border border-border">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3">
          <span className="flex items-baseline gap-1">
            <span className="text-number-lg tabular-nums">{readiness.score}</span>
            <span className="text-small text-muted-tertiary">/ 100</span>
          </span>
          <span className="min-w-0 flex-1 text-small text-muted">
            How ready {name} is to answer questions: five equal parts, each with what to do next.
          </span>
        </div>
        <ul className="flex flex-col divide-y divide-border">
          {readiness.parts.map((p) => {
            const done = p.score >= 1;
            return (
              <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                {done ? (
                  <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <CircleDashed className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                )}
                <span className="flex min-w-48 flex-1 flex-col">
                  <span className="text-small">{p.label}</span>
                  <span className="text-small text-muted-tertiary">{p.detail}</span>
                </span>
                <ProgressBar
                  aria-label={`${p.label}: ${p.detail}`}
                  size="sm"
                  value={Math.round(p.score * 100)}
                  color={done ? "success" : "accent"}
                  className="w-24"
                >
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
                <span className="flex w-full justify-end text-small font-medium @xl/page:w-72">
                  {p.next ? (
                    p.next.action === "sync" ? (
                      <ReadinessSync sourceId={sourceId} label={p.next.label} />
                    ) : (
                      <Link
                        href={p.next.action === "learn" ? `/data/sources/${sourceId}/learning` : HREF[p.next.action]}
                        className="text-right text-link hover:underline"
                      >
                        {p.next.label}
                      </Link>
                    )
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
