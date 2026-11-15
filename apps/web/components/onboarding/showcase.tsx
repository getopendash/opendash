import { OpenDashMark } from "@opendash/ui";
import { ArrowUpRight, BadgeCheck, CalendarClock, CircleCheck, Hash, Mail } from "lucide-react";
import type { ReactNode } from "react";

// What OpenDash does, shown rather than told: three small scenes for the welcome (an answer, a dashboard's number, a
// routine). Decorative: the figures are illustrations, as on the sign-in screen's hero.

const glass =
  "blueprint-block flex flex-col gap-3 rounded-3xl border border-hero-glass-stroke bg-hero-glass-tint p-4 text-start shadow-glass backdrop-blur-glass";

function Traced({ children }: { children: ReactNode }) {
  return <span className="border-border-secondary border-b font-semibold">{children}</span>;
}

function Scene({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  return (
    <li className={glass}>
      <div aria-hidden className="flex min-h-28 flex-col justify-center gap-2.5 rounded-2xl bg-surface p-3.5">
        {children}
      </div>
      <div className="flex flex-col gap-0.5 px-0.5">
        <h3 className="text-heading">{title}</h3>
        <p className="text-small text-muted">{line}</p>
      </div>
    </li>
  );
}

const spark = ["h-3", "h-4", "h-3.5", "h-5", "h-5.5", "h-6", "h-6.5"];

export function Showcase() {
  return (
    <ul className="grid w-full gap-4 md:grid-cols-3">
      <Scene title="Ask in plain language" line="Every number links to the query behind it, checked before you see it.">
        <span className="flex items-center gap-1.5 text-small font-medium">
          <OpenDashMark className="size-4 shrink-0 text-brand" />
          Why did churn drop in September?
        </span>
        <p className="text-small text-muted">
          Churned MRR fell to <Traced>$9.8k</Traced>, down <Traced>12.5%</Traced> from August.
        </p>
        <span className="flex items-center gap-1.5 text-micro text-muted-tertiary">
          <CircleCheck className="size-3 text-success" />4 queries · 6 checks passed
        </span>
      </Scene>
      <Scene
        title="Turn answers into dashboards"
        line="Keep the numbers you care about in view, always from live data."
      >
        <span className="flex items-center justify-between text-small font-medium text-muted">
          MRR · September
          <BadgeCheck className="size-3.5 text-success" />
        </span>
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-number-lg">$412.6k</span>
            <span className="flex items-center gap-0.5 text-micro font-semibold text-success-soft-foreground">
              <ArrowUpRight className="size-3 text-success" />
              4.2% vs Aug
            </span>
          </div>
          <div className="flex h-7 w-20 items-end gap-0.5">
            {spark.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decorative list
              <span key={i} className={`${h} flex-1 rounded-xs bg-accent-soft`} />
            ))}
            <span className="h-7 flex-1 rounded-xs bg-accent" />
          </div>
        </div>
      </Scene>
      <Scene
        title="Let routines watch for you"
        line="A weekly summary, or a nudge when a metric moves, by email or Slack."
      >
        <span className="flex items-center gap-1.5 text-small font-medium">
          <CalendarClock className="size-4 shrink-0 text-accent" />
          Every Monday at 9:00
        </span>
        <p className="text-small text-muted">Weekly revenue summary, with what changed and why.</p>
        <span className="flex items-center gap-1.5 text-micro text-muted-tertiary">
          <span className="flex h-5 items-center gap-1 rounded-md bg-surface-secondary px-1.5">
            <Hash className="size-3" />
            growth
          </span>
          <span className="flex h-5 items-center gap-1 rounded-md bg-surface-secondary px-1.5">
            <Mail className="size-3" />
            you
          </span>
        </span>
      </Scene>
    </ul>
  );
}
