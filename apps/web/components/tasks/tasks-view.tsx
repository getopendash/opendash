"use client";

import type { TaskView } from "@opendash/core";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CellTrace } from "@/components/insights/cell-trace";
import { TopBar } from "@/components/shell/top-bar";
import { TaskCard } from "./task-card";

/** Q4: the tasks, open or done, with an outcome's figure traced beside them. */
export function TasksView({
  tasks,
  closed,
  openCount,
  canManage,
  canAsk,
}: {
  tasks: TaskView[];
  closed: boolean;
  openCount: number;
  canManage: boolean;
  /** Viewers read tasks; they don't change them, even their own. */
  canAsk: boolean;
}) {
  const [trace, setTrace] = useState<TaskView | null>(null);
  const cell = trace?.outcome?.observed && trace.metric ? trace.outcome.observed : null;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar crumbs={[{ label: "Tasks" }]} />
        <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-display">Tasks</h1>
              <p className="text-body text-muted">
                What the team decided to do about what moved. Done ones are checked against what the metric would have
                done anyway.
              </p>
            </div>
            <nav
              aria-label="Which tasks"
              className="flex w-fit items-center gap-0.5 rounded-xl bg-surface-secondary p-0.5"
            >
              {[
                { href: "/tasks", label: `Open · ${openCount}`, active: !closed },
                { href: "/tasks?status=closed", label: "Done", active: closed },
              ].map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={t.active ? "page" : undefined}
                  className={`rounded-lg px-2.5 py-1 text-small ${t.active ? "bg-surface font-medium" : "text-muted hover:text-foreground"}`}
                >
                  {t.label}
                </Link>
              ))}
            </nav>
            {tasks.length ? (
              <div className="flex flex-col gap-3">
                {tasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    canChange={canAsk && (t.mine || canManage)}
                    traced={trace?.id === t.id}
                    onTrace={setTrace}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
                <ListChecks className="size-6 text-muted" aria-hidden />
                <p className="text-lead">{closed ? "Nothing done yet" : "No open tasks"}</p>
                <p className="max-w-reading text-body text-muted">
                  {closed
                    ? "Done tasks show here, each with its outcome once the months after it close."
                    : "Create a task from an insight, and it's checked against its metric once it's done."}
                </p>
                {!closed ? (
                  <Link href="/insights" className="text-body text-link hover:underline">
                    Open Insights
                  </Link>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
      {trace && cell && trace.metric ? (
        <div className="enter-slide absolute inset-0 z-40 flex bg-surface @5xl/page:static @5xl/page:z-auto">
          <CellTrace
            cell={{
              ...cell,
              of: { metric: trace.metric, period: cell.period },
              ranBy: "Run by the task's outcome check",
              note: `The projection (${trace.outcome?.projected?.display ?? ""}) isn't a query cell: it extends how ${trace.metric.title} changed in the months before the task.`,
            }}
            onClose={() => setTrace(null)}
          />
        </div>
      ) : null}
    </div>
  );
}
