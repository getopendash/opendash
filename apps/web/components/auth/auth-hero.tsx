import { FitScale, GithubLogo, OpenDashMark, Pair } from "@opendash/ui";
import {
  ArrowUpRight,
  BadgeCheck,
  ChevronRight,
  CircleCheck,
  GitPullRequest,
  ScanSearch,
  Server,
  Sigma,
} from "lucide-react";
import type { ReactNode } from "react";

// The auth hero ("Auth Hero"): a mesh gradient with three floating glass cards showing what
// OpenDash does. Decorative: the figures are illustrations, not data.

const glass = "rounded-3xl border border-hero-glass-stroke bg-hero-glass-tint shadow-glass backdrop-blur-glass";

function Traced({ children }: { children: ReactNode }) {
  return <span className="border-border-secondary border-b font-semibold">{children}</span>;
}

function AnswerCard() {
  return (
    <div className={`${glass} mt-16 flex w-97 flex-col gap-3 p-4`}>
      <div className="flex items-center gap-2">
        <OpenDashMark className="size-4.5 text-brand" />
        <span className="flex-1 text-small font-medium">Why did churn drop in September?</span>
        <span className="flex h-5 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-micro font-medium text-success-soft-foreground">
          <BadgeCheck className="size-3" />
          Verified
        </span>
      </div>
      <p className="text-lead">
        Churned MRR fell to <Traced>$9.8k</Traced> in September, down <Traced>12.5%</Traced> from August, mostly on
        Starter.
      </p>
      <span className="flex items-center gap-2 text-small text-muted">
        <CircleCheck className="size-3.5 text-success" />4 queries · 6 checks passed
        <ChevronRight className="size-3 text-muted-tertiary" />
      </span>
    </div>
  );
}

const spark = ["h-3.5", "h-4", "h-4.5", "h-5", "h-5.5", "h-6", "h-6.5"];

function KpiCard() {
  return (
    <div className={`${glass} mr-9 flex w-58 flex-col gap-2.5 p-3.5`}>
      <div className="flex items-center justify-between text-small font-medium text-muted">
        MRR · September
        <BadgeCheck className="size-3.5 text-success" />
      </div>
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <span className="border-border-secondary border-b text-number-lg text-foreground">$412.6k</span>
          <span className="flex items-center gap-1 text-small">
            <span className="flex items-center gap-0.5 font-semibold text-success-soft-foreground">
              <ArrowUpRight className="size-3 text-success" />
              4.2%
            </span>
            <span className="text-muted-tertiary">vs Aug</span>
          </span>
        </div>
        <div className="flex h-7.5 w-16 items-end gap-0.5">
          {spark.map((h) => (
            <span key={h} className={`${h} flex-1 rounded-xs bg-accent-soft`} />
          ))}
          <span className="h-7.5 flex-1 rounded-xs bg-accent" />
        </div>
      </div>
    </div>
  );
}

const rows = [
  ["Starter", "2026-08", "5,200.00"],
  ["Starter", "2026-09", "4,100.00"],
];

function SourceCard() {
  return (
    <div className={`${glass} mt-8 ml-65 flex w-82 flex-col gap-2.5 p-3.5`}>
      <div className="flex items-center gap-2 text-small">
        <span className="font-mono text-muted-tertiary">q1</span>
        <span className="flex-1 font-medium">Churned MRR by plan</span>
        <span className="flex h-5 items-center gap-1 rounded-md bg-accent-soft px-1.5 text-micro font-medium text-accent-soft-foreground">
          <Sigma className="size-3" />
          Metric
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface font-mono text-micro">
        <div className="grid grid-cols-3 border-separator border-b bg-surface-secondary text-muted-tertiary">
          <span className="px-2 py-1.5">plan</span>
          <span className="px-2 py-1.5">month</span>
          <span className="px-2 py-1.5 text-right">churned_mrr</span>
        </div>
        {rows.map(([plan, month, value], i) => (
          <div key={month} className={`grid grid-cols-3 ${i === 0 ? "border-separator border-b" : ""}`}>
            <span className="px-2 py-1.5">{plan}</span>
            <span className="px-2 py-1.5">{month}</span>
            <span
              className={`px-2 py-1.5 text-right ${i === 1 ? "bg-accent-soft font-semibold ring-1 ring-accent ring-inset" : ""}`}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
      <span className="text-micro text-accent-soft-foreground">
        The exact cell behind $4.1k, one click from the answer
      </span>
    </div>
  );
}

const features = [
  { icon: ScanSearch, label: "Every figure traced" },
  { icon: GitPullRequest, label: "Learns only through review" },
  { icon: Server, label: "Your data stays in place" },
];

export function AuthHero() {
  return (
    <aside aria-hidden className="auth-hero hidden flex-1 flex-col gap-8 overflow-hidden rounded-sheet p-12 lg:flex">
      <span className="flex h-6.5 w-fit items-center gap-1.5 rounded-full border border-hero-glass-stroke bg-hero-glass-tint px-2.5 text-small font-medium">
        <GithubLogo className="size-3.5" />
        Open source · Self-host
      </span>
      {/* The cards keep their 720px composition and scale down to fit the space left, never clipped. */}
      <FitScale className="hidden min-h-0 flex-1 xl:block">
        <div className="flex w-180 flex-col pb-6">
          <div className="flex items-start justify-between">
            <AnswerCard />
            <KpiCard />
          </div>
          <SourceCard />
        </div>
      </FitScale>
      <div className="mt-auto flex flex-col gap-3.5">
        {/* Pair: the one big one; it looks at the pointer and hops when clicked. */}
        <Pair size={64} interactive />
        <h2 className="flex flex-col gap-3.5 text-hero">
          <span>Every number,</span>
          <span className="text-link">traced to its source.</span>
        </h2>
        <p className="max-w-130 text-heading font-normal leading-relaxed text-muted">
          Ask about your business in plain language. OpenDash answers from your own definitions, checks its math in
          code, and shows the query behind every figure.
        </p>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-small text-muted">
        {features.map(({ icon: Icon, label }) => (
          <li key={label} className="flex items-center gap-1.5">
            <Icon className="size-3.5" />
            {label}
          </li>
        ))}
      </ul>
    </aside>
  );
}
