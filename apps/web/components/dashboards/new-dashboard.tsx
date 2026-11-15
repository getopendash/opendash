"use client";

import { Button } from "@heroui/react";
import { LayoutDashboard, Plus } from "lucide-react";
import { usePanel } from "@/components/panel/panel-context";

/**
 * Starting a dashboard: the analyst opens beside the page on a new conversation with the ask begun, so the person says
 * what it's for (or attaches a sketch of one they like). The plan comes back first; Build it lands the pages here.
 */
const START = "Build me a dashboard for ";

/** Asks people often start from, each naming a reader and a job (dashboard-design: start from the job). */
const STARTERS = [
  {
    title: "Customer health",
    line: "For the success team: who's at risk and who needs a call this week",
    ask: "Build me a dashboard for the success team: each customer's health, who's at risk, and who needs a call this week.",
  },
  {
    title: "Revenue review",
    line: "MRR against last year, and what moved it",
    ask: "Build me a dashboard for a monthly revenue review: MRR against last year, new, expansion and churn, and what moved it.",
  },
  {
    title: "A queue to work through",
    line: "Open tickets, oldest and most urgent first, with who owns each",
    ask: "Build me a dashboard for the support team to work through open tickets: oldest and most urgent first, with who owns each.",
  },
];

/** The page's own action: "New dashboard", beside its title. */
export function NewDashboardButton() {
  const panel = usePanel();
  return (
    <Button size="sm" onPress={() => panel.show({ threadId: null, text: START, intent: "dashboard" })}>
      <Plus className="size-3.5" aria-hidden />
      New dashboard
    </Button>
  );
}

/** No dashboards yet: what one is, and a start from a job people often have. */
export function NoDashboards() {
  const panel = usePanel();
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <LayoutDashboard className="size-6 text-muted" aria-hidden />
      <div className="flex flex-col gap-1.5">
        <p className="text-lead">No dashboards yet</p>
        <p className="max-w-reading text-body text-muted">
          Say who it's for and what they decide with it. The analyst shows a plan first, then builds it here while you
          watch. A sketch or a screenshot of one you like helps.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {STARTERS.map((s) => (
          <Button
            key={s.title}
            size="sm"
            variant="secondary"
            onPress={() => panel.show({ threadId: null, text: s.ask, intent: "dashboard" })}
          >
            {s.title}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Above the list: three starts that name a reader and a job, quiet rows of a title and a line, never
 * cards that shout. Pressing one opens the analyst beside the page with the ask begun, not sent: the person finishes it.
 */
export function StartFromAJob() {
  const panel = usePanel();
  return (
    <section aria-labelledby="start-from-a-job" className="flex flex-col gap-2">
      <h2 id="start-from-a-job" className="text-micro font-medium tracking-wide text-muted-tertiary uppercase">
        Start from a job
      </h2>
      <div className="grid grid-cols-1 gap-2 @2xl/page:grid-cols-3">
        {STARTERS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => panel.show({ threadId: null, text: s.ask, intent: "dashboard" })}
            className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-default focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="text-small font-medium">{s.title}</span>
            <span className="line-clamp-2 text-small text-muted">{s.line}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
