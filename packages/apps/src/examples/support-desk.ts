/**
 * A reference App: a support desk on the demo company's tickets, written the way the analyst
 * writes one. Its page is its own code (a queue to work, the picked ticket, a week's volume), responsive by its own
 * CSS; it reads data only through its named queries and draws numbers with `Value`; it reuses two primitives (a chart,
 * a data grid). The tests build it; the skill points at it as an example; a check opens it in a real frame.
 */
import type { Definition } from "../dashboard/definition";

/** The App's manifest on a source whose catalog has the demo `tickets` dataset. */
export function supportDeskManifest(connection: string): Definition {
  const source = { connection, dataset: "tickets" };
  return {
    version: 2,
    title: "Support desk",
    description: "Open tickets to work through, oldest and most urgent first, and how the week is going.",
    filters: { f_period: { kind: "period", label: "Period", default: "last_12_months" } },
    pages: [],
    queries: {
      q_queue: {
        source,
        select: ["id", "priority", "status", "channel", "created_at", "account_id"],
        where: [["status", "in", ["open", "pending"]]],
        sort: ["created_at"],
        filters: { f_period: "created_at" },
        key: "id",
        rows: { pageSizes: [25, 50] },
      },
      q_open: {
        source,
        measures: { open: ["count"] },
        where: [["status", "in", ["open", "pending"]]],
        filters: { f_period: "created_at" },
      },
      q_urgent: {
        source,
        measures: { urgent: ["count"] },
        where: [
          ["status", "in", ["open", "pending"]],
          ["priority", "in", ["urgent", "high"]],
        ],
        filters: { f_period: "created_at" },
      },
      q_week: {
        source,
        measures: { tickets: ["count"] },
        by: ["created_at:week"],
        filters: { f_period: "created_at" },
      },
      q_all: {
        source,
        select: ["id", "priority", "status", "channel", "created_at", "csat"],
        sort: ["-created_at"],
        filters: { f_period: "created_at" },
        key: "id",
        rows: { pageSizes: [25, 50], conditions: true },
      },
    },
  } as Definition;
}

/** The App's files: its page, its components, its stylesheet. */
export const SUPPORT_DESK_FILES: Record<string, string> = {
  "/App.tsx": `import { useState } from "react";
import { Chart, DataGrid, Filters, Tabs, useQuery, Value } from "@opendash/app";
import { Queue } from "./components/Queue";
import { TicketPanel } from "./components/TicketPanel";

export default function App() {
  const open = useQuery("q_open");
  const urgent = useQuery("q_urgent");
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);
  const [view, setView] = useState("queue");
  return (
    <main className="@container mx-auto grid max-w-6xl gap-6 p-4 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">Support desk</h1>
          <p className="text-sm text-muted">Open tickets to work through, oldest first.</p>
        </div>
        <Filters />
      </header>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div className="flex items-baseline gap-2">
          <dt className="text-muted">Open</dt>
          <dd className="font-semibold tabular-nums">
            <Value of={open.status === "ok" ? open.cell(0, "open") : null} />
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted">Urgent or high</dt>
          <dd className="font-semibold tabular-nums">
            <Value of={urgent.status === "ok" ? urgent.cell(0, "urgent") : null} />
          </dd>
        </div>
      </dl>
      <Tabs
        tabs={[
          { id: "queue", label: "Queue" },
          { id: "all", label: "Every ticket" },
        ]}
        value={view}
        onChange={setView}
      />
      {view === "queue" ? (
        <>
          {/* The queue and the picked ticket as panes, a hairline between them; one above the other when narrow. */}
          <section className="grid border-y border-border @2xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)] @2xl:divide-x @2xl:divide-border">
            <Queue picked={picked} onPick={setPicked} />
            <TicketPanel ticket={picked} />
          </section>
          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">Tickets a week</h2>
            <Chart query="q_week" type="bar" x="created_at_week" y={["tickets"]} />
          </section>
        </>
      ) : (
        <DataGrid query="q_all" filterable pageSizes={[25, 50]} />
      )}
    </main>
  );
}
`,
  "/components/Queue.tsx": `import { useQuery } from "@opendash/app";
import { ageOf, Loading, PriorityState } from "../lib/tickets";

export function Queue({ picked, onPick }: { picked: Record<string, unknown> | null; onPick(row: Record<string, unknown>): void }) {
  const queue = useQuery("q_queue", { pageSize: 25 });
  if (queue.status === "loading" && !queue.rows.length) return <Loading rows={8} />;
  if (queue.status === "error") {
    return (
      <p className="px-3 py-6 text-sm text-danger-soft-foreground">
        The queue didn't load: {queue.error}{" "}
        <button type="button" className="underline" onClick={queue.retry}>Try again</button>
      </p>
    );
  }
  if (!queue.rows.length) return <p className="px-3 py-6 text-sm text-muted">Nothing open. The queue is clear.</p>;
  return (
    <ul aria-label="Open tickets" className="max-h-[36rem] min-w-0 divide-y divide-border overflow-y-auto">
      {queue.rows.map((row) => {
        const on = picked?.id === row.id;
        return (
          <li key={String(row.id)}>
            <button
              type="button"
              onClick={() => onPick(row)}
              aria-current={on ? "true" : undefined}
              className={
                "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-left text-sm hover:bg-surface-secondary " +
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent " +
                (on ? "bg-accent-soft" : "")
              }
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">#{String(row.id)}</span>
                <span className="block truncate text-xs text-muted">
                  {String(row.channel)} · open {ageOf(row.created_at)}
                </span>
              </span>
              <PriorityState value={String(row.priority)} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
`,
  "/components/TicketPanel.tsx": `import { ageOf, PriorityState } from "../lib/tickets";

export function TicketPanel({ ticket }: { ticket: Record<string, unknown> | null }) {
  if (!ticket) return <p className="p-4 text-sm text-muted">Pick a ticket to see who it's from and how long it's waited.</p>;
  return (
    <aside aria-label="Ticket" className="min-w-0 self-start p-4 @2xl:sticky @2xl:top-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="truncate text-base font-semibold">Ticket #{String(ticket.id)}</h2>
        <PriorityState value={String(ticket.priority)} />
      </header>
      <p className="mt-1 text-sm text-muted">
        {String(ticket.status)} · came in by {String(ticket.channel)} · open {ageOf(ticket.created_at)}
      </p>
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted">Account</dt>
        <dd className="truncate">#{String(ticket.account_id)}</dd>
        <dt className="text-muted">Channel</dt>
        <dd>{String(ticket.channel)}</dd>
      </dl>
    </aside>
  );
}
`,
  "/lib/tickets.tsx": `/** How long a ticket has been open, in days or hours. */
export function ageOf(created: unknown): string {
  const t = typeof created === "string" || typeof created === "number" ? new Date(created).getTime() : NaN;
  if (Number.isNaN(t)) return "a while";
  const hours = Math.max(0, Math.round((Date.now() - t) / 3_600_000));
  return hours < 48 ? hours + " hours" : Math.round(hours / 24) + " days";
}

/** Only what needs action is coloured: urgent and high. The rest is its word, muted. */
const TONES: Record<string, [string, string]> = {
  urgent: ["bg-danger", "text-danger-soft-foreground"],
  high: ["bg-warning", "text-warning-soft-foreground"],
};

/** A priority as a small dot and its word: never a pill. */
export function PriorityState({ value }: { value: string }) {
  const tone = TONES[value];
  if (!tone) return <span className="text-xs text-muted">{value}</span>;
  return (
    <span className={"inline-flex items-center gap-1.5 whitespace-nowrap text-xs " + tone[1]}>
      <span aria-hidden className={"size-1.5 shrink-0 rounded-full " + tone[0]} />
      {value}
    </span>
  );
}

/** While a list loads: its rows as bars, the shape of what's coming. */
export function Loading({ rows }: { rows: number }) {
  return (
    <ul aria-busy="true" className="divide-y divide-border">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="grid gap-1.5 px-3 py-2.5">
          <span className="h-3 w-2/5 animate-pulse rounded-sm bg-surface-secondary" />
          <span className="h-2.5 w-3/5 animate-pulse rounded-sm bg-surface-secondary" />
        </li>
      ))}
    </ul>
  );
}
`,
};
