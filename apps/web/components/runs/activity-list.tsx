"use client";

import { Skeleton, Tabs } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { usePanel } from "@/components/panel/panel-context";
import { apiQueries } from "@/lib/api";
import { duration } from "@/lib/run-timeline";

const KIND: Record<string, string> = {
  analyst: "Analyst",
  modeler: "Modeler",
  drafter: "Drafter",
  investigator: "Investigator",
  reviewer: "Reviewer",
};
const STATUS: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  cancelling: "Stopping",
  succeeded: "Done",
  cancelled: "Stopped",
  failed: "Failed",
};
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Activity's runs: what each was, who asked, how it went, its time and cost; each opens its trace. */
export function ActivityList() {
  const panel = usePanel();
  const [only, setOnly] = useState<"all" | "background">("all");
  const [now, setNow] = useState(() => Date.now());
  const runs = useQuery({
    ...apiQueries.runs.recent.queryOptions({
      input: { limit: 50, ...(only === "background" ? { background: true } : {}) },
    }),
    refetchInterval: (q) =>
      q.state.data?.some((r) => ["queued", "running", "cancelling"].includes(r.status)) ? 5_000 : false,
  });
  const list = runs.data ?? [];
  // A run that works goes on counting its time.
  const working = list.some((r) => ["queued", "running", "cancelling"].includes(r.status));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [working]);
  const total = list.reduce((n, r) => n + r.costUsd, 0);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs selectedKey={only} onSelectionChange={(k) => setOnly(k === "background" ? "background" : "all")}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="Which runs">
              <Tabs.Tab id="all" className="whitespace-nowrap">
                All
              </Tabs.Tab>
              <Tabs.Tab id="background" className="whitespace-nowrap">
                Background work
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <span className="text-small text-muted-tertiary tabular-nums">
          {list.length} runs · ${total.toFixed(2)}
        </span>
      </div>
      {runs.isPending ? <Skeleton className="h-48 rounded-2xl" /> : null}
      {!runs.isPending && !list.length ? <p className="text-body text-muted">No runs yet.</p> : null}
      {list.length ? (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-small">
            <thead className="bg-surface-secondary text-muted-tertiary">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Run</th>
                <th className="px-4 py-2 text-end font-medium">Time</th>
                <th className="px-4 py-2 text-start font-medium">Status</th>
                <th className="px-4 py-2 text-end font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((r) => {
                const working = ["queued", "running", "cancelling"].includes(r.status);
                const ended = r.finishedAt ? Date.parse(r.finishedAt) : now;
                return (
                  <tr key={r.runId} className="hover:bg-surface-secondary">
                    <th scope="row" className="px-4 py-2.5 text-start font-normal">
                      <button
                        type="button"
                        onClick={() => panel.show({ view: "trace", runId: r.runId })}
                        className="flex flex-col text-start"
                      >
                        <span className="font-medium text-foreground hover:underline">{r.title}</span>
                        <span className="text-muted-tertiary">
                          {[
                            `${KIND[r.profile] ?? r.profile}${r.helpers ? ` · ${r.helpers} helpers` : ""}`,
                            r.background ? "OpenDash" : (r.askedByName ?? "A teammate"),
                            WHEN.format(new Date(r.queuedAt)),
                          ].join(" · ")}
                        </span>
                      </button>
                    </th>
                    <td className="whitespace-nowrap px-4 py-2.5 text-end text-muted tabular-nums">
                      {duration(ended - Date.parse(r.queuedAt))}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-2.5 ${working ? "text-accent" : r.status === "failed" ? "text-danger" : "text-muted"}`}
                    >
                      {STATUS[r.status] ?? r.status}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-end tabular-nums">${r.costUsd.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
