"use client";

import { buttonVariants } from "@heroui/react";
import { GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** One definition draft a run made, as its `definition_draft` result says. */
export interface DraftMade {
  id: string;
  kind: "metric" | "dataset";
  title: string;
  version: number;
  checks: string;
}

const CHECKS: Record<string, string> = {
  passed: "its tests passed",
  needs_review: "a test warned",
  failed: "its tests failed",
  untested: "its tests run next",
};

/**
 * Under an answer, a metric or dataset the analyst drafted a change to: Ask uses it once a person releases it on its
 * page, which this opens (beside the conversation, when the panel is open). Said so it stays true after a release or
 * a Discard.
 */
export function DraftNote({ draft }: { draft: DraftMade }) {
  const href = `/knowledge/${draft.kind === "metric" ? "metrics" : "datasets"}/${draft.id}`;
  const here = usePathname() === href;
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface-secondary px-3 py-2 text-small">
      <GitCompareArrows
        className={`size-3.5 shrink-0 ${draft.checks === "failed" ? "text-warning" : "text-accent"}`}
        aria-hidden
      />
      <span className="flex-1 text-muted">
        Drafted version {draft.version} of {draft.title}: {CHECKS[draft.checks] ?? CHECKS.untested}. Ask uses it only
        once someone releases it{here ? " on this page" : ""}.
      </span>
      {here ? null : (
        <Link href={href} className={buttonVariants({ size: "sm", variant: "ghost" })}>
          Review it
        </Link>
      )}
    </div>
  );
}
