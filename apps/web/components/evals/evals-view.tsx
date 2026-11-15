"use client";

import { Button, Chip, Skeleton, Spinner, Switch, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { EvalCaseView } from "@opendash/core";
import { DataTable, dataColumns, PathLabel, useDataTable } from "@opendash/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Play, Sigma } from "lucide-react";
import Link from "next/link";
import { TopBar } from "@/components/shell/top-bar";
import { apiQueries } from "@/lib/api";
import { shortDate, shortDateTime, usd } from "@/lib/format";
import { RunScore, runWhen, VerdictChip } from "./verdict";

const c = dataColumns<EvalCaseView>();
const columns = c.columns([
  c.accessor("question", {
    header: "Question",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
  }),
  c.accessor((v) => v.metric ?? (v.origin === "correction" ? "Team learning" : "Verified query"), {
    id: "from",
    header: "From",
    meta: { className: "hidden whitespace-nowrap @4xl/page:table-cell" },
    cell: ({ row: { original: v } }) =>
      v.metric ? (
        <Chip size="sm" variant="soft" color="accent" className="gap-1">
          <Sigma className="size-3" aria-hidden />
          {v.metric}
        </Chip>
      ) : (
        <Chip size="sm" variant="soft">
          {v.origin === "correction" ? "Team learning" : "Verified query"}
        </Chip>
      ),
  }),
  c.accessor((v) => v.asOf ?? "", {
    id: "asOf",
    header: "As of",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-muted">{getValue() ? shortDate(getValue()) : "Now"}</span>,
  }),
  c.accessor((v) => v.last?.verdict ?? "", {
    id: "last",
    header: "Last result",
    meta: { className: "min-w-80" },
    cell: ({ row: { original: v } }) =>
      v.last ? (
        <span className="flex min-w-0 items-center gap-2">
          <VerdictChip verdict={v.last.verdict} />
          <span className={`truncate text-small ${v.last.verdict === "pass" ? "text-muted" : ""}`}>
            {v.last.reason}
          </span>
        </span>
      ) : (
        <span className="text-small text-muted-tertiary">Not run yet</span>
      ),
  }),
  c.accessor((v) => v.last?.path ?? "", {
    id: "path",
    header: "Path",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ getValue }) =>
      getValue() === "metric" || getValue() === "unmodelled" ? (
        <PathLabel path={getValue() as "metric" | "unmodelled"} />
      ) : null,
  }),
]);

const active = (status: string) => status === "queued" || status === "running";
const message = (e: unknown, fallback: string) => (isDefinedError(e) ? (e as { message: string }).message : fallback);

/**
 * Q1: the organization's evals. Every verified metric and verified query, asked of the analyst and graded against
 * its reference recomputed on today's data; Run now, the nightly switch, and the recent runs. While a run is going the
 * page follows it.
 */
export function EvalsView() {
  const queryClient = useQueryClient();
  const options = apiQueries.evals.overview.queryOptions();
  const view = useQuery({
    ...options,
    refetchInterval: (q) => (q.state.data?.runs.some((r) => active(r.status)) ? 3000 : false),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey });
  const start = useMutation(apiQueries.evals.start.mutationOptions());
  const nightly = useMutation(apiQueries.evals.setNightly.mutationOptions());
  const data = view.data;
  const going = data?.runs.find((r) => active(r.status));
  const last = data?.runs.find((r) => r.status === "done");
  const table = useDataTable({ columns, data: data?.cases ?? [], getRowId: (v) => v.id });
  const fromMetrics = data?.cases.filter((x) => x.metric).length ?? 0;

  return (
    <>
      <TopBar
        crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Evals" }]}
        action={
          <Button
            size="sm"
            isPending={start.isPending}
            isDisabled={!!going || !data?.cases.length}
            onPress={() =>
              start.mutate(undefined, {
                onSuccess: () => {
                  toast.success(`Checking ${data?.cases.length ?? 0} questions. This takes a few minutes.`);
                  void refresh();
                },
                onError: (e) => toast.danger(message(e, "Couldn't start the run.")),
              })
            }
          >
            <Play className="size-3.5" aria-hidden />
            Run now
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Evals</h1>
            <p className="max-w-reading text-body text-muted">
              Each verified metric and verified query, asked of the analyst as a question and graded against its
              reference, recomputed on today's data. A check fails when the answer doesn't cite the reference's numbers.
            </p>
          </div>
          {!data ? (
            <Skeleton className="h-28 rounded-2xl" />
          ) : (
            <div className="grid gap-3 @2xl/page:grid-cols-2 @5xl/page:grid-cols-4">
              <section className="flex flex-col gap-1 rounded-2xl border border-border p-4">
                <span className="text-small text-muted">{going ? "Running now" : "Last run"}</span>
                {going ? (
                  <span className="flex items-center gap-2 text-lead">
                    <Spinner size="sm" />
                    Checked {going.metrics.done ?? 0} of {going.metrics.total ?? data.cases.length}
                  </span>
                ) : last ? (
                  <span className="flex items-center gap-2 text-lead">
                    <RunScore metrics={last.metrics} />
                  </span>
                ) : (
                  <span className="text-lead">Not run yet</span>
                )}
                <span className="text-small text-muted-tertiary">
                  {going ? runWhen(going) : last ? runWhen(last) : "Run now checks every question below."}
                </span>
              </section>
              <section className="flex flex-col gap-1 rounded-2xl border border-border p-4">
                <span className="text-small text-muted">Untraced answers</span>
                <span className="text-lead tabular-nums">{last ? (last.metrics.untraced ?? 0) : "—"}</span>
                <span className="text-small text-muted-tertiary">A number in an answer that isn't from a query</span>
              </section>
              <section className="flex flex-col gap-1 rounded-2xl border border-border p-4">
                <span className="text-small text-muted">Cost</span>
                <span className="text-lead tabular-nums">{last ? usd(last.metrics.costUsd ?? 0) : "—"}</span>
                <span className="text-small text-muted-tertiary">
                  {last
                    ? `${last.metrics.calls ?? 0} model calls · about ${Math.round((last.metrics.calls ?? 0) / Math.max(1, last.metrics.total ?? 1))} a check`
                    : "About three model calls a check"}
                </span>
              </section>
              <section className="flex flex-col gap-2 rounded-2xl border border-border p-4">
                <Switch
                  size="sm"
                  isSelected={nightly.isPending ? !!nightly.variables?.nightly : data.nightly}
                  isDisabled={nightly.isPending}
                  onChange={(on) =>
                    nightly.mutate(
                      { nightly: on },
                      {
                        onSuccess: () => void refresh(),
                        onError: (e) => toast.danger(message(e, "Couldn't change it.")),
                      },
                    )
                  }
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <span className="text-body">Run every night</span>
                  </Switch.Content>
                </Switch>
                <span className="text-small text-muted-tertiary">
                  {data.nightly ? "On" : "Off"}. At 03:00 UTC
                  {last?.metrics.costUsd ? `, about ${usd(last.metrics.costUsd)} a night` : ""}. It runs only when an
                  admin turns it on.
                </span>
              </section>
            </div>
          )}
          {data && !data.cases.length ? (
            <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
              Nothing to check yet. Each verified metric and verified query becomes a check: verify the starter pack's
              definitions in Knowledge → Proposals, or save a verified query from an answer.
            </p>
          ) : null}
          {data?.cases.length ? (
            <DataTable
              table={table}
              label="Checks"
              rowHref={(v) => (v.last ? `/knowledge/evals/${v.last.evalRunId}` : undefined)}
              footer={`${data.cases.length} checks · ${fromMetrics} from verified metrics, ${data.cases.length - fromMetrics} from verified queries`}
            />
          ) : null}
          {data?.runs.length ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-body font-semibold">Recent runs</h2>
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {data.runs.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/knowledge/evals/${r.id}`}
                      className="flex h-11 items-center gap-3 px-4 text-body hover:bg-default"
                    >
                      <span className="w-44 shrink-0 font-medium">{shortDateTime(r.createdAt)}</span>
                      {active(r.status) ? (
                        <Chip size="sm" variant="soft">
                          <Spinner size="sm" />
                          {r.status === "queued"
                            ? "Queued"
                            : `Checked ${r.metrics.done ?? 0} of ${r.metrics.total ?? "…"}`}
                        </Chip>
                      ) : r.status === "failed" ? (
                        <Chip size="sm" variant="soft" color="danger">
                          Stopped
                        </Chip>
                      ) : (
                        <RunScore metrics={r.metrics} chip />
                      )}
                      <span className="truncate text-small text-muted">
                        {r.trigger === "schedule" ? "Nightly" : `Run now by ${r.requester ?? "an admin"}`}
                      </span>
                      <span className="flex-1" />
                      <span className="text-small text-muted-tertiary tabular-nums">
                        {r.metrics.costUsd ? usd(r.metrics.costUsd) : ""}
                      </span>
                      <ChevronRight className="size-3.5 text-muted-tertiary" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
