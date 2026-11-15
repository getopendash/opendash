import { ProgressBar, Spinner } from "@heroui/react";
import { ArrowRight, BookCheck, Database, type LucideIcon, MessageSquareText } from "lucide-react";
import Link from "next/link";
import type { SetupStepKey } from "@/lib/setup";

export interface SetupCardData {
  done: number;
  total: number;
  next: { key: SetupStepKey; label: string; href?: string; inProgress?: boolean } | null;
}

const icons: Partial<Record<SetupStepKey, LucideIcon>> = {
  data: Database,
  "starter-pack": BookCheck,
  ask: MessageSquareText,
};

/** The sidebar's "Finish setting up" card (Sidebar → Setup Card): progress and the next step, until setup is done. */
export function SetupCard({ setup }: { setup: SetupCardData }) {
  if (!setup.next) return null;
  const Icon = icons[setup.next.key] ?? ArrowRight;
  const next = (
    <>
      {setup.next.inProgress ? (
        <Spinner size="sm" className="size-3.25 shrink-0" aria-hidden />
      ) : (
        <Icon className="size-3.25 shrink-0" aria-hidden />
      )}
      <span className="flex-1 truncate">{setup.next.inProgress ? setup.next.label : `Next: ${setup.next.label}`}</span>
      {setup.next.href ? <ArrowRight className="size-3 shrink-0" aria-hidden /> : null}
    </>
  );
  return (
    <section aria-label="Setup" className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3">
      <div className="flex items-center justify-between text-small">
        <span className="font-semibold">Finish setting up</span>
        <span className="text-muted-tertiary">
          {setup.done} of {setup.total}
        </span>
      </div>
      <ProgressBar aria-label="Setup progress" size="sm" value={setup.done} maxValue={setup.total}>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      {setup.next.href ? (
        <Link
          href={setup.next.href}
          className="flex items-center gap-1.5 text-small font-medium text-accent-soft-foreground hover:underline"
        >
          {next}
        </Link>
      ) : (
        <span className="flex items-center gap-1.5 text-small font-medium text-muted">{next}</span>
      )}
    </section>
  );
}
