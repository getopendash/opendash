"use client";

import { Button, Skeleton } from "@heroui/react";
import type { QueryCard as QueryCardData } from "@opendash/core";
import { CodeBlock, PathLabel } from "@opendash/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { VerifyDialog } from "@/components/verified/verify-dialog";
import { apiQueries } from "@/lib/api";
import type { MetricSpecLike } from "@/lib/metric-spec";
import { shortDuration } from "@/lib/run-steps";

const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A cell as a result grid shows it: nulls as —, a timestamp as its date (and its time unless midnight UTC). */
export function gridCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  const text = String(v);
  const t = ISO_TIME.exec(text);
  if (t) return t[2] === "00:00" && !/[1-9]/.test(t[3] ?? "") ? (t[1] as string) : `${t[1]} ${t[2]}`;
  return text;
}

/** The result preview as a mono data grid (query results stay grids), with traced cells marked. */
export function ResultGrid({
  card,
  highlight = [],
  maxRows = 20,
}: {
  card: Pick<QueryCardData, "columns" | "preview">;
  highlight?: { row: number; column: string }[];
  maxRows?: number;
}) {
  const rows = card.preview.slice(0, Math.max(maxRows, ...highlight.map((h) => h.row + 1)));
  const numeric = new Set(card.columns.filter((c) => c.type === "number").map((c) => c.name));
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse font-mono text-small">
        <thead>
          <tr className="border-b border-border bg-surface-secondary text-muted-tertiary">
            {card.columns.map((c) => (
              <th
                key={c.name}
                className={`px-2.5 py-1.5 font-normal ${numeric.has(c.name) ? "text-right" : "text-left"}`}
              >
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            // Rows are positional (the preview's order), and cells are addressed by row index.
            // biome-ignore lint/suspicious/noArrayIndexKey: a result row has no id of its own
            <tr key={r} className="border-b border-border last:border-b-0">
              {card.columns.map((c, i) => {
                const marked = highlight.some((h) => h.row === r && h.column === c.name);
                return (
                  <td
                    key={c.name}
                    className={`px-2.5 py-1.5 tabular-nums ${numeric.has(c.name) ? "text-right" : "text-left"} ${
                      marked ? "bg-accent-soft font-semibold text-accent-soft-foreground outline outline-accent" : ""
                    }`}
                  >
                    {gridCell(row[i])}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The values a query ran with: its filters and dates, which the SQL names but doesn't hold ({from:Date}, $1). */
function QueryValues({ params }: { params: NonNullable<QueryCardData["params"]> }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-small font-medium text-muted">Values it ran with</h4>
      <dl className="flex flex-col gap-0.5 font-mono text-small">
        {params.map((p) => (
          <div key={p.name} className="flex gap-3">
            <dt className="shrink-0 text-muted-tertiary">{p.name}</dt>
            <dd className="min-w-0 break-words">{gridCell(p.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * An answer's query card: what ran, how long it took, the rows it read, what its checks warned about, the SQL, the
 * values it ran with and its result.
 */
export function QueryCard({
  queryRunId,
  highlight,
  defaultOpen = false,
  note,
  verify,
  action,
  showSource = false,
}: {
  queryRunId: string;
  highlight?: { row: number; column: string }[];
  defaultOpen?: boolean;
  /** Why this query is listed though it isn't one of the run's own, or isn't cited. */
  note?: string;
  /** Offers "Save as verified" on a metric query that ran, with the question it answered. Owners and admins. */
  verify?: { question: string };
  /** Shown under it once it ran: Add to dashboard, in a conversation. */
  action?: ReactNode;
  /** Name the source it ran on: the run read more than one. */
  showSource?: boolean;
}) {
  const { data: card, error } = useQuery(apiQueries.queries.get.queryOptions({ input: { queryRunId } }));
  const [saving, setSaving] = useState(false);
  if (error) return <p className="text-small text-danger">This query can't be shown.</p>;
  if (!card) return <Skeleton className="h-24 rounded-2xl" />;
  const metric = card.path === "metric";
  const meta = [
    showSource ? `on ${card.source.name}` : null,
    card.durationMs !== null ? shortDuration(card.durationMs) : null,
    card.rows !== null ? `${card.rows.toLocaleString("en-US")} ${card.rows === 1 ? "row" : "rows"}` : null,
    `read at ${time.format(new Date(card.createdAt))}`,
  ].filter(Boolean);
  return (
    <details
      open={defaultOpen || Boolean(highlight?.length)}
      className="group flex flex-col rounded-2xl border border-border open:border-accent"
    >
      <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3 py-2.5">
        <span className="mt-0.5 font-mono text-small text-muted-tertiary">{card.alias}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-medium">{card.title ?? "Query"}</span>
          {card.status === "succeeded" ? (
            <span className="text-small text-muted-tertiary">
              {[...meta.slice(0, showSource ? 3 : 2), note].filter(Boolean).join(" · ")}
            </span>
          ) : (
            <span className="text-small text-danger">{card.error?.message ?? card.status}</span>
          )}
        </span>
        {metric ? <PathLabel path="metric" /> : null}
        <ChevronRight
          className="mt-1 size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90"
          aria-hidden
        />
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3">
        <span className="flex flex-wrap items-center gap-2 text-small text-muted-tertiary">
          <PathLabel path={metric ? "metric" : "unmodelled"} />
          {meta.join(" · ")}
        </span>
        {card.definitions.length ? (
          <span className="text-small text-muted">
            Compiled by OpenDash from{" "}
            {card.definitions.map((d, i) => (
              <span key={d.id}>
                {i > 0 ? ", " : ""}
                <Link
                  href={`/knowledge/${d.kind === "metric" ? "metrics" : "datasets"}/${d.id}`}
                  className="text-link hover:underline"
                >
                  {d.title}
                </Link>{" "}
                v{d.version}
              </span>
            ))}
            .
          </span>
        ) : null}
        {verify && metric && card.status === "succeeded" && card.metricQuery ? (
          <>
            <Button size="sm" variant="outline" className="w-fit" onPress={() => setSaving(true)}>
              <ShieldCheck className="size-3.5" aria-hidden />
              Save as verified
            </Button>
            <VerifyDialog
              target={{ queryRunId: card.id }}
              question={verify.question}
              spec={card.metricQuery as MetricSpecLike}
              titles={Object.fromEntries(
                card.definitions.filter((d) => d.kind === "metric").map((d) => [d.slug, d.title]),
              )}
              result={`Its result now: ${card.rows?.toLocaleString("en-US") ?? "no"} ${card.rows === 1 ? "row" : "rows"}. Kept with it, to notice if it changes.`}
              isOpen={saving}
              onOpenChange={setSaving}
            />
          </>
        ) : null}
        {action && card.status === "succeeded" ? <span className="w-fit">{action}</span> : null}
        {card.warnings.length ? (
          <ul className="flex flex-col gap-1">
            {card.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-small text-muted">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        ) : null}
        {/* As written (comments, line breaks); a dialect that runs its own one-line form of it shows that on demand. */}
        <CodeBlock code={card.writtenSql ?? card.sql} label="Copy SQL" wrap />
        {card.writtenSql ? (
          <details className="flex flex-col gap-1.5">
            <summary className="w-fit cursor-pointer text-small text-muted-tertiary hover:text-foreground">
              As it ran, in the server's own form
            </summary>
            <CodeBlock code={card.sql} label="Copy SQL as it ran" wrap />
          </details>
        ) : null}
        {card.params?.length ? <QueryValues params={card.params} /> : null}
        {card.columns.length ? <ResultGrid card={card} {...(highlight ? { highlight } : {})} /> : null}
        {card.truncated ? (
          <p className="text-small text-muted-tertiary">Showing the first {card.rows?.toLocaleString("en-US")} rows.</p>
        ) : null}
      </div>
    </details>
  );
}
