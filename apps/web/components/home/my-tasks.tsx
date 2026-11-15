import type { TaskView } from "@opendash/core";
import { Circle, CircleDot } from "lucide-react";
import Link from "next/link";

const DUE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Home's My tasks, the viewer's open tasks. */
export function MyTasks({ tasks }: { tasks: TaskView[] }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-heading">
          My tasks
          <span className="text-small font-normal text-muted-tertiary">yours, open</span>
        </h2>
        <Link href="/tasks" className="text-small text-link hover:underline">
          All tasks
        </Link>
      </header>
      <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
        {tasks.map((t) => (
          <li key={t.id} className="flex min-h-10 items-center gap-2.5 border-b border-border px-3.5 last:border-b-0">
            {t.status === "in_progress" ? (
              <CircleDot className="size-3.5 shrink-0 text-accent" aria-hidden />
            ) : (
              <Circle className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
            )}
            <Link href="/tasks" className="min-w-0 flex-1 truncate py-2 text-body font-medium hover:underline">
              {t.title}
            </Link>
            <span className="shrink-0 text-small text-muted-tertiary">
              {t.status === "in_progress" ? "In progress" : "To do"}
              {t.dueAt ? ` · due ${DUE.format(new Date(`${t.dueAt}T00:00:00Z`))}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
