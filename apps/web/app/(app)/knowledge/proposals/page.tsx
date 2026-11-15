import { Chip } from "@heroui/react";
import { type DatasetSpec, listProposals, type MetricSpec, type ProposalView } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { ChevronRight, GitPullRequestArrow, LoaderCircle, Sigma, Table2 } from "lucide-react";
import type { Metadata } from "next";
import { ChecksList, DatasetOverview, MetricOverview } from "@/components/knowledge/definition-page";
import { ListRow, PROPOSAL_STATUS, ProposalRow } from "@/components/knowledge/proposal-detail";
import { type ReviewItem, StarterPackReview } from "@/components/knowledge/starter-pack-review";
import { LearningsReview } from "@/components/learning/learning-card";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { count } from "@/lib/format";
import { canVerify, definitionFor, definitionsFor, sourceModelFor } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Proposals · OpenDash" };

/** How long a decided proposal stays listed under Decided. */
const DECIDED_DAYS = 30;
const LIVE = new Set<ProposalView["status"]>(["drafting", "open", "held", "failed"]);

/**
 * The way in to a source's drafts (Draft definitions), one row per source: drafting, waiting for review (on the
 * source's own page), or stopped with why.
 */
function SourceDraftsRow({ proposals }: { proposals: ProposalView[] }) {
  const first = proposals[0];
  if (!first) return null;
  const drafting = proposals.find((p) => p.status === "drafting");
  const open = proposals.filter((p) => p.status === "open");
  const waiting = open.flatMap((p) => p.items.filter((i) => i.status === "proposed" || i.status === "needs_review"));
  const stopped = proposals.find((p) => p.status === "held" || p.status === "failed");
  const tables = [...new Set(open.flatMap((p) => p.tables))];
  const meta = waiting.length
    ? `${count(waiting.length, "draft")} from ${count(tables.length, "table")} you picked, each tested against your data`
    : drafting
      ? `Drafting from ${drafting.tables.join(", ")}`
      : "Definitions drafted from the tables you picked";
  return (
    <ListRow
      href={waiting.length ? `/knowledge/proposals/sources/${first.connectionId}` : null}
      icon={
        drafting && !waiting.length ? (
          <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden />
        ) : (
          <Table2 className="size-4 text-muted" aria-hidden />
        )
      }
      title={`Drafts for ${first.connectionName}`}
      meta={meta}
      note={
        stopped && !drafting && !waiting.length
          ? `${stopped.status === "held" ? "Held: " : "Stopped: "}${stopped.heldReason ?? stopped.evidence.failed ?? "It stopped before it drafted a definition."}`
          : null
      }
      status={PROPOSAL_STATUS[waiting.length ? "open" : drafting ? "drafting" : (stopped?.status ?? "open")]}
    />
  );
}

/**
 * The definitions OpenDash proposed, as a list: the learnings waiting for a tap first, then
 * what waits for review, one row each (a source's drafts, reviewed on its source's page; a draft from a query, on its
 * own page), then what was decided lately, folded away; or the sample's starter pack, each with its tests.
 */
export default async function ProposalsPage() {
  const viewer = await requireTenant();
  const orgId = viewer.ctx.orgId;
  const drafts = await withTenant({ orgId }, (tx) => listProposals(tx, { orgId, userId: viewer.user.id }));
  // A source's drafts (Draft definitions) have tables; a draft from a query has none.
  const fromQueries = drafts.filter((p) => p.tables.length === 0);
  const since = Date.now() - DECIDED_DAYS * 86_400_000;
  const waiting = fromQueries.filter((p) => LIVE.has(p.status));
  const decided = fromQueries.filter(
    (p) => !LIVE.has(p.status) && new Date(p.decidedAt ?? p.createdAt).getTime() > since,
  );
  const bySource = new Map<string, ProposalView[]>();
  for (const p of drafts) {
    if (!p.tables.length || p.status === "approved" || p.status === "rejected" || p.status === "superseded") continue;
    bySource.set(p.connectionId, [...(bySource.get(p.connectionId) ?? []), p]);
  }
  // A Modeler proposal's drafts are reviewed with it, not as part of the sample's starter pack.
  const drafted = new Set(drafts.flatMap((p) => p.items.map((i) => i.id)));
  const proposed = (await definitionsFor(orgId)).filter(
    (d) => (d.status === "proposed" || d.status === "needs_review") && !drafted.has(d.id),
  );
  const details = (await Promise.all(proposed.map((d) => definitionFor(orgId, viewer.user.id, d.id)))).filter(
    (d) => d !== null,
  );
  const models = new Map(
    await Promise.all(
      [...new Set(details.map((d) => d.connectionId))].map(
        async (id) => [id, await sourceModelFor(orgId, id)] as const,
      ),
    ),
  );
  const items: ReviewItem[] = details.map((d) => {
    const model = models.get(d.connectionId) ?? null;
    const dataset = d.kind === "metric" ? model?.definitions.get(`dataset:${(d.spec as MetricSpec).dataset}`) : null;
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      slug: d.slug,
      connectionName: d.connectionName,
      checks: d.checks,
      datasetId: dataset && proposed.some((p) => p.id === dataset.id) ? dataset.id : null,
      snapshot: d.kind === "dataset" && Boolean((d.spec as { snapshot?: unknown }).snapshot),
    };
  });
  const panels = Object.fromEntries(
    details.map((d) => {
      const model = models.get(d.connectionId) ?? null;
      const metric = d.kind === "metric";
      return [
        d.id,
        <div key={d.id} className="flex flex-col gap-6">
          <header className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-secondary">
              {metric ? <Sigma className="size-4" aria-hidden /> : <Table2 className="size-4" aria-hidden />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-title">{d.title}</h2>
              <p className="text-small text-muted">
                {metric ? "Metric" : "Dataset"} · <span className="font-mono">{d.slug}</span> · {d.connectionName}
                {d.derived?.rows !== undefined ? ` · ${d.derived.rows.toLocaleString("en-US")} rows` : ""}
              </p>
            </div>
            <Chip size="sm" variant="soft" color="accent">
              Drafted by OpenDash
            </Chip>
          </header>
          <div className="flex flex-col gap-8 @5xl/page:flex-row">
            <div className="min-w-0 flex-1">
              {metric ? (
                <MetricOverview spec={d.spec as MetricSpec} model={model} />
              ) : (
                <DatasetOverview spec={d.spec as DatasetSpec} model={model} />
              )}
            </div>
            <aside className="flex shrink-0 flex-col gap-6 @5xl/page:w-72">
              <section className="flex flex-col gap-2">
                <h3 className="text-small font-medium text-muted">Tested against your data</h3>
                <ChecksList derived={d.derived} source={d.connectionName} />
              </section>
              <section className="flex flex-col gap-1.5">
                <h3 className="text-small font-medium text-muted">Why OpenDash drafted it</h3>
                <p className="text-small text-muted">
                  It's part of the sample company's starter pack, built from the definitions its numbers are calibrated
                  against.
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
      <TopBar crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Proposals" }]} />
      {/* The starter pack's review fills the sheet and scrolls in its own panes; everything else scrolls the page. */}
      <div
        className={`flex flex-1 flex-col gap-6 px-8 pt-8 ${items.length ? "min-h-0 pb-6" : "overflow-y-auto pb-16"}`}
      >
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">{items.length ? "Review your starter pack" : "Proposals"}</h1>
          <p className="max-w-reading text-body text-muted">
            {items.length
              ? "OpenDash drafted these from your data and tested each one against it. Approve what's right; you can change anything later."
              : "Definitions OpenDash proposes, from your data and from how your team asks, wait here for review."}
          </p>
        </div>
        {canVerify(viewer.role) ? <LearningsReview /> : null}
        {bySource.size || waiting.length ? (
          <section className="flex flex-col gap-3" aria-label="Waiting for review">
            <h2 className="text-title">Waiting for review</h2>
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {[...bySource.entries()].map(([id, list]) => (
                <SourceDraftsRow key={id} proposals={list} />
              ))}
              {waiting.map((p) => (
                <ProposalRow key={p.id} p={p} />
              ))}
            </div>
          </section>
        ) : null}
        {items.length ? (
          <StarterPackReview items={items} panels={panels} canApprove={canVerify(viewer.role)} />
        ) : bySource.size || waiting.length ? null : (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border py-16 text-center">
            <GitPullRequestArrow className="size-5 text-muted" aria-hidden />
            <p className="text-body">No definitions waiting for review.</p>
          </div>
        )}
        {decided.length && !items.length ? (
          <details className="group flex flex-col">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-small font-medium text-muted">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
              Decided in the last {DECIDED_DAYS} days
              <span className="font-normal text-muted-tertiary">{decided.length}</span>
            </summary>
            <div className="mt-2.5 flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {decided.map((p) => (
                <ProposalRow key={p.id} p={p} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </>
  );
}
