import { Meter } from "@heroui/react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { goalRow } from "@/lib/goal-rows";

type Row = ReturnType<typeof goalRow>;

/**
 * Home's Goals: each goal's metric now against its target, and the time left (values as of each metric's last test);
 * with a watched metric, whether it's on course.
 */
export function Goals({ goals }: { goals: Row[] }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-heading">
          Goals
          <span className="text-small font-normal text-muted-tertiary">
            set by your admins · values as of each metric's last test
          </span>
        </h2>
        <Link href="/settings/goals" className="text-small text-link hover:underline">
          All goals
        </Link>
      </header>
      <div className="grid gap-3 @2xl/page:grid-cols-2 @5xl/page:grid-cols-3">
        {goals.map((g) => (
          <Link
            key={g.id}
            href={g.metricId ? `/knowledge/metrics/${g.metricId}` : "/settings/goals"}
            className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 hover:bg-default"
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-body font-medium">{g.title.replace(/ by [^,]+, \d{4}$/, "")}</span>
              <span className="shrink-0 text-small text-muted-tertiary">by {g.due}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-title font-semibold tabular-nums">{g.current ?? "—"}</span>
              <span className="text-small text-muted">target {g.target}</span>
            </span>
            <Meter value={g.bar * 100} color={g.tone} size="sm" aria-label={g.standing}>
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
            <span className="text-small text-muted-tertiary">
              {g.standing} · {g.time}
            </span>
            {g.forecast ? (
              <span className="flex items-center gap-1.5 text-small text-muted">
                {g.forecast.onCourse ? (
                  <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
                )}
                {g.forecast.text}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </section>
  );
}
