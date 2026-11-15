import { ProgressBar } from "@heroui/react";
import { CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";
import type { SetupProgress } from "@/lib/setup";

/** Home's "Finish setting up". Steps come from the workspace's real state; optional ones aren't counted. */
export function SetupChecklist({ progress }: { progress: SetupProgress }) {
  return (
    <section
      aria-labelledby="setup-title"
      className="flex flex-col gap-1.5 rounded-2xl border border-border px-4 py-3.5"
    >
      <div className="flex items-center justify-between gap-4 pb-1">
        <h2 id="setup-title" className="flex items-baseline gap-2 text-body font-medium">
          Finish setting up
          <span className="text-small font-normal text-muted">
            {progress.done} of {progress.total}
          </span>
        </h2>
        <ProgressBar
          aria-label="Setup progress"
          size="sm"
          value={progress.done}
          maxValue={progress.total}
          className="w-40"
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      </div>
      <ol className="flex flex-col">
        {progress.steps.map((step) => (
          <li key={step.key} className="flex h-9 items-center gap-3 text-body">
            {step.done ? (
              <CircleCheck className="size-4 shrink-0 text-success" aria-label="Done" />
            ) : (
              <CircleDashed className="size-4 shrink-0 text-muted-tertiary" aria-label="To do" />
            )}
            <span className={step.done ? "text-muted" : "text-foreground"}>{step.label}</span>
            {step.done && step.detail ? (
              <span className="ms-auto truncate text-small text-muted">{step.detail}</span>
            ) : !step.done && step.href ? (
              <Link href={step.href} className="ms-auto text-small text-link hover:underline">
                {step.actionLabel}
              </Link>
            ) : !step.done && step.optional ? (
              <span className="ms-auto text-small text-muted">Optional</span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
