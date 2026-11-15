import { buttonVariants, Chip, ProgressBar } from "@heroui/react";
import {
  type DatasetSpec,
  listProposals,
  type MetricSpec,
  type ProposalItem,
  type ProposalView,
  sourceReadiness,
} from "@opendash/core";
import { withTenant } from "@opendash/db";
import { Pencil, Sigma, Table2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChecksList, DatasetOverview, MetricOverview } from "@/components/knowledge/definition-page";
import { RejectDraft } from "@/components/knowledge/reject-draft";
import { type ReviewItem, StarterPackReview } from "@/components/knowledge/starter-pack-review";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { count } from "@/lib/format";
import { canVerify, sourceModelFor } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Drafts · OpenDash" };

const undecided = (i: ProposalItem) => i.status === "proposed" || i.status === "needs_review";

/**
 * A source's drafts (Draft definitions), reviewed together: the datasets and metrics the Modeler drafted from the
 * tables picked, each with its tests and why it was drafted so; approve what's selected, edit one, or reject it with
 * a note for its next draft; and what the Modeler left out.
 */
export default async function SourceDraftsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const orgId = viewer.ctx.orgId;
  const canApprove = canVerify(viewer.role);
  const { proposals, readiness } = await withTenant({ orgId }, async (tx) => {
    const all = await listProposals(tx, { orgId, userId: viewer.user.id });
    return {
      // Its drafts from tables, any status: the source's name holds once they're all decided.
      proposals: all.filter((p) => p.connectionId === id && p.tables.length > 0),
      readiness: canApprove ? await sourceReadiness(tx, orgId, id).catch(() => null) : null,
    };
  });
  const source = proposals[0]?.connectionName;
  if (!source) notFound();
  const open = proposals.filter((p) => p.status === "open");
  const of = new Map<string, ProposalView>();
  for (const p of open) for (const i of p.items) of.set(i.id, p);
  const drafts = open.flatMap((p) => p.items.filter(undecided));
  const tables = [...new Set(open.flatMap((p) => p.tables))];
  const leftOut = open.flatMap((p) => p.evidence.leftOut ?? []);
  const stopped = open.flatMap((p) => (p.evidence.stopped ? [p.evidence.stopped] : []));
  const model = await sourceModelFor(orgId, id);
  const datasetOf = (i: ProposalItem) =>
    i.kind === "metric"
      ? (drafts.find((d) => d.kind === "dataset" && d.slug === (i.spec as MetricSpec).dataset)?.id ?? null)
      : null;
  const items: ReviewItem[] = drafts.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    slug: i.slug,
    connectionName: source,
    checks: i.checks?.status ?? null,
    datasetId: datasetOf(i),
    snapshot: i.kind === "dataset" && Boolean((i.spec as { snapshot?: unknown }).snapshot),
  }));
  const panels = Object.fromEntries(
    drafts.map((i) => {
      const metric = i.kind === "metric";
      return [
        i.id,
        <div key={i.id} className="flex flex-col gap-6">
          <header className="flex flex-wrap items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-secondary">
              {metric ? <Sigma className="size-4" aria-hidden /> : <Table2 className="size-4" aria-hidden />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-title">{i.title}</h2>
              <p className="text-small text-muted">
                {metric ? "Metric" : "Dataset"} · <span className="font-mono">{i.slug}</span>
                {i.checks?.rows !== undefined ? ` · ${i.checks.rows.toLocaleString("en-US")} rows` : ""}
              </p>
            </div>
            <span className="flex items-center gap-2">
              <Chip size="sm" variant="soft" color="accent">
                Drafted by OpenDash
              </Chip>
              {canApprove ? <RejectDraft id={i.id} title={i.title} dataset={!metric} /> : null}
              <Link
                href={`/knowledge/${metric ? "metrics" : "datasets"}/${i.id}`}
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Link>
            </span>
          </header>
          <div className="flex flex-col gap-8 @5xl/page:flex-row">
            <div className="min-w-0 flex-1">
              {metric ? (
                <MetricOverview spec={i.spec as MetricSpec} model={model} />
              ) : (
                <DatasetOverview spec={i.spec as DatasetSpec} model={model} />
              )}
            </div>
            <aside className="flex shrink-0 flex-col gap-6 @5xl/page:w-72">
              <section className="flex flex-col gap-2">
                <h3 className="text-small font-medium text-muted">Tested against your data</h3>
                <ChecksList derived={i.checks} source={source} />
              </section>
              <section className="flex flex-col gap-1.5">
                <h3 className="text-small font-medium text-muted">Why OpenDash drafted it</h3>
                <p className="text-small text-muted">
                  {i.why ?? of.get(i.id)?.rationale ?? "Drafted from the tables you picked."}
                </p>
              </section>
            </aside>
          </div>
        </div>,
      ];
    }),
  );
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Proposals", href: "/knowledge/proposals" },
          { label: source },
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 px-8 pt-8 pb-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Drafts for {source}</h1>
            <p className="max-w-reading text-body text-muted">
              {items.length
                ? `OpenDash drafted these from the ${count(tables.length, "table")} you picked and tested each against your data. Approve what's right, edit what's close, reject what isn't: your note goes to the next draft.`
                : "Every draft from the tables you picked is decided."}
            </p>
            {stopped.length ? (
              <p className="max-w-reading text-small text-warning">
                The run stopped before it finished ({stopped[0]}), so some tables may have no drafts.
              </p>
            ) : null}
          </div>
          {readiness ? (
            <div className="flex w-56 flex-col gap-1.5">
              <span className="flex items-baseline justify-between text-small">
                <Link href={`/data/sources/${id}`} className="text-muted hover:underline">
                  Readiness
                </Link>
                <span className="font-medium tabular-nums">{readiness.score}%</span>
              </span>
              <ProgressBar aria-label="Readiness" size="sm" value={readiness.score} color="accent">
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            </div>
          ) : null}
        </div>
        {items.length ? (
          <StarterPackReview
            key={items.map((i) => i.id).join(",")}
            items={items}
            panels={panels}
            canApprove={canApprove}
            drafts={{ leftOut, skipHref: `/data/sources/${id}` }}
          />
        ) : (
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-border p-5">
            <p className="text-body">Nothing left to review for {source}.</p>
            <p className="text-small text-muted">
              What you approved is in{" "}
              <Link href="/knowledge/datasets" className="text-link hover:underline">
                Datasets
              </Link>{" "}
              and{" "}
              <Link href="/knowledge/metrics" className="text-link hover:underline">
                Metrics
              </Link>
              ; Ask, dashboards and routines use it now.
            </p>
            <Link href={`/data/sources/${id}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
              Back to {source}
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
