"use client";

import { Skeleton, Spinner } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { EvalResultView } from "@opendash/core";
import { DataTable, dataColumns, PathLabel, useDataTable } from "@opendash/ui";
import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { apiQueries } from "@/lib/api";
import { shortDateTime, usd } from "@/lib/format";
import { runWhen, VerdictChip } from "./verdict";

const c = dataColumns<EvalResultView>();
const columns = c.columns([
  c.accessor("question", {
    header: "Question",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
  }),
  c.accessor("verdict", {
    header: "Result",
    meta: { className: "whitespace-nowrap" },
    cell: ({ getValue }) => <VerdictChip verdict={getValue()} />,
  }),
  c.accessor((r) => r.diff?.reason ?? "", {
    id: "why",
    header: "Why",
    meta: { className: "hidden min-w-80 @4xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-small text-muted">{getValue() || "—"}</span>,
  }),
  c.accessor((r) => r.diff?.path ?? "", {
    id: "path",
    header: "Path",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ getValue }) =>
      getValue() === "metric" || getValue() === "unmodelled" ? (
        <PathLabel path={getValue() as "metric" | "unmodelled"} />
      ) : null,
  }),
  c.accessor((r) => r.diff?.seconds ?? 0, {
    id: "took",
    header: "Took",
    meta: { align: "end", className: "whitespace-nowrap tabular-nums" },
    cell: ({ getValue }) => <span className="text-muted">{getValue() ? `${Math.round(getValue())}s` : ""}</span>,
  }),
]);

/** One case that didn't pass: what was expected, what the answer cited, the answer itself. */
function Detail({ r }: { r: EvalResultView }) {
  const d = r.diff;
  const row = (k: string, v: string) => (
    <div className="flex flex-col gap-0.5 @2xl/page:flex-row @2xl/page:gap-3">
      <dt className="w-36 shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0">{v}</dd>
    </div>
  );
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <header className="flex items-center gap-2">
        <VerdictChip verdict={r.verdict} />
        <h3 className="text-body font-semibold">{r.question}</h3>
      </header>
      <dl className="flex flex-col gap-2 text-body">
        {d?.reason ? row("Why", d.reason) : null}
        {d?.expected.length ? row("Expected", d.expected.map((e) => `${e.display} (${e.label})`).join(", ")) : null}
        {d && r.verdict === "fail" ? row("It cited", d.cited.map((x) => x.display).join(", ") || "no numbers") : null}
        {d?.answer ? row("The answer", d.answer) : null}
        {d?.asOf ? row("Asked as of", shortDateTime(d.asOf)) : null}
      </dl>
    </section>
  );
}

/** Q2: one run of the evals: every case it checks with its result and why, failures first, then what they said. */
export function EvalRunView({ evalRunId }: { evalRunId: string }) {
  const options = apiQueries.evals.run.queryOptions({ input: { evalRunId } });
  const view = useQuery({
    ...options,
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 3000 : false),
  });
  const table = useDataTable({ columns, data: view.data?.results ?? [], getRowId: (r) => r.caseId });
  if (view.error && isDefinedError(view.error) && view.error.code === "NOT_FOUND") notFound();
  const r = view.data;
  const m = r?.metrics ?? {};
  const going = r && (r.status === "queued" || r.status === "running");
  const stats: [string, string, string][] = [
    ["Passed", String(m.passed ?? 0), "Answers that cited every expected number"],
    ["Failed", String(m.failed ?? 0), "A different number, or no answer"],
    ["Couldn't check", String(m.errors ?? 0), "No reference to grade against, or the analyst stopped"],
    ["Untraced", String(m.untraced ?? 0), "A number in an answer that isn't from a query"],
  ];
  const title = r ? `Run of ${shortDateTime(r.createdAt)}` : "Run";
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Evals", href: "/knowledge/evals" },
          { label: title },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">{title}</h1>
            <p className="text-body text-muted">
              {r
                ? `${runWhen(r)} · ${m.total ?? 0} checks · ${m.calls ?? 0} model calls · ${usd(m.costUsd ?? 0)}. Each reference was recomputed on the data as it was then.`
                : ""}
            </p>
          </div>
          {!r ? <Skeleton className="h-28 rounded-2xl" /> : null}
          {going ? (
            <p className="flex items-center gap-2 text-body text-muted">
              <Spinner size="sm" />
              {r?.status === "queued"
                ? "Starting…"
                : `Checked ${m.done ?? 0} of ${m.total ?? 0}. This page follows it.`}
            </p>
          ) : null}
          {r ? (
            <div className="grid gap-3 @2xl/page:grid-cols-2 @5xl/page:grid-cols-4">
              {stats.map(([label, value, note]) => (
                <section key={label} className="flex flex-col gap-1 rounded-2xl border border-border p-4">
                  <span className="text-small text-muted">{label}</span>
                  <span className="text-lead tabular-nums">{value}</span>
                  <span className="text-small text-muted-tertiary">{note}</span>
                </section>
              ))}
            </div>
          ) : null}
          {r?.results.length ? (
            <DataTable table={table} label="Results" footer={`${r.results.length} checks · failed first`} />
          ) : null}
          {r?.results
            .filter((x) => x.verdict === "fail" || x.verdict === "error")
            .map((x) => (
              <Detail key={x.caseId} r={x} />
            ))}
        </div>
      </div>
    </>
  );
}
