import { Chip } from "@heroui/react";
import type { DatasetSpec, MetricSpec, ProposalView } from "@opendash/core";
import { ChevronRight, LoaderCircle, Sigma, Table2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChecksList, DatasetOverview, MetricOverview } from "@/components/knowledge/definition-page";
import { ProposalActions } from "@/components/knowledge/proposal-actions";
import { count } from "@/lib/format";
import { sourceModelFor } from "@/lib/knowledge";

export const PROPOSAL_STATUS: Record<
  ProposalView["status"],
  { label: string; color: "default" | "accent" | "success" | "warning" | "danger" }
> = {
  drafting: { label: "Drafting…", color: "accent" },
  held: { label: "Held", color: "warning" },
  failed: { label: "Couldn't draft", color: "danger" },
  open: { label: "In review", color: "accent" },
  approved: { label: "Approved", color: "success" },
  rejected: { label: "Rejected", color: "default" },
  superseded: { label: "Replaced", color: "default" },
};

const asked = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** A Modeler proposal's name: where it was drafted from, as far as the viewer may see. */
export function proposalTitle(p: ProposalView): string {
  return p.title === null ? "Drafted from a query" : `Drafted from “${p.title}”`;
}

/** How its drafts did on their tests, in a few words. */
function testsLine(p: ProposalView): string | null {
  const states = p.items.map((i) => i.checks?.status ?? null);
  if (!states.length || states.some((s) => s === null)) return null;
  if (states.includes("failed")) return "a test didn't pass";
  if (states.includes("needs_review")) return "tests passed, one needs a look";
  return "tests passed";
}

/** A row on Knowledge → Proposals, opening the proposal's own page: what it is, where from, how far, its status. */
export function ProposalRow({ p }: { p: ProposalView }) {
  const status = PROPOSAL_STATUS[p.status];
  const metric = p.items.some((i) => i.kind === "metric");
  const meta = [
    p.connectionName,
    p.items.length ? count(p.items.length, "definition") : null,
    testsLine(p),
    `asked ${asked(p.createdAt)}`,
  ].filter(Boolean);
  return (
    <ListRow
      href={`/knowledge/proposals/${p.id}`}
      icon={
        p.status === "drafting" ? (
          <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden />
        ) : metric ? (
          <Sigma className="size-4 text-muted" aria-hidden />
        ) : (
          <Table2 className="size-4 text-muted" aria-hidden />
        )
      }
      title={proposalTitle(p)}
      meta={meta.join(" · ")}
      note={
        p.status === "failed" || p.status === "held"
          ? (p.heldReason ?? p.evidence.failed ?? "It stopped before it proposed a definition.")
          : p.status === "rejected" && p.note
            ? `Rejected: ${p.note}`
            : null
      }
      status={status}
    />
  );
}

/** One row of a list of proposals: a link when there's a page to open, its status at the end. */
export function ListRow({
  href,
  icon,
  title,
  meta,
  note = null,
  status,
}: {
  href: string | null;
  icon: ReactNode;
  title: string;
  meta: string;
  note?: string | null;
  status: { label: string; color: "default" | "accent" | "success" | "warning" | "danger" };
}) {
  const body = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-secondary">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium">{title}</span>
        <span className="line-clamp-2 text-small text-muted">{meta}</span>
        {note ? <span className="text-small text-muted-tertiary">{note}</span> : null}
      </span>
      <Chip size="sm" variant="soft" color={status.color}>
        {status.label}
      </Chip>
      {href ? <ChevronRight className="size-4 shrink-0 text-muted-tertiary" aria-hidden /> : null}
    </>
  );
  const row = "flex items-center gap-3 px-4 py-3";
  return href ? (
    <Link href={href} className={`${row} transition-colors hover:bg-surface-secondary`}>
      {body}
    </Link>
  ) : (
    <div className={row}>{body}</div>
  );
}

/**
 * A proposal on its own page: one Modeler proposal (Make this a metric): its drafts with their tests, why OpenDash drafted
 * them; in review, Approve, Edit or Reject.
 */
export async function ProposalBody({ p, canApprove, orgId }: { p: ProposalView; canApprove: boolean; orgId: string }) {
  const model = p.items.length ? await sourceModelFor(orgId, p.connectionId) : null;
  return (
    <div className="flex flex-col gap-6">
      {p.status === "drafting" ? (
        <p className="text-body text-muted">
          OpenDash is drafting it from the query and testing it against your data. It shows here for review when it's
          done.
        </p>
      ) : null}
      {p.status === "failed" || p.status === "held" ? (
        <p className="text-body text-muted">
          {p.heldReason ?? p.evidence.failed ?? "It stopped before it proposed a definition."} Ask again from the
          query's card.
        </p>
      ) : null}
      {p.status === "rejected" && p.note ? <p className="text-body text-muted">Rejected: {p.note}</p> : null}
      {p.items.length ? (
        <div className="flex flex-col gap-8 @5xl/page:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-8">
            {p.items.map((i) => (
              <section key={i.id} className="flex flex-col gap-3">
                <h2 className="flex items-center gap-2 text-title">
                  {i.kind === "metric" ? (
                    <Sigma className="size-4 text-muted" aria-hidden />
                  ) : (
                    <Table2 className="size-4 text-muted" aria-hidden />
                  )}
                  {i.title}
                  <span className="text-small font-normal text-muted">
                    {i.kind === "metric" ? "Metric" : "Dataset"} · <span className="font-mono">{i.slug}</span>
                  </span>
                </h2>
                {i.kind === "metric" ? (
                  <MetricOverview spec={i.spec as MetricSpec} model={model} />
                ) : (
                  <DatasetOverview spec={i.spec as DatasetSpec} model={model} />
                )}
                <ChecksList derived={i.checks} source={p.connectionName} />
              </section>
            ))}
          </div>
          <aside className="flex shrink-0 flex-col gap-6 @5xl/page:w-72">
            {p.rationale ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-small font-medium text-muted">Why OpenDash drafted it</h3>
                <p className="text-small text-muted">{p.rationale}</p>
              </section>
            ) : null}
          </aside>
        </div>
      ) : null}
      {p.status === "open" ? (
        <ProposalActions
          proposalId={p.id}
          count={p.items.length}
          canApprove={canApprove}
          edits={p.items.map((i) => ({
            label: `Edit ${i.kind}`,
            href: `/knowledge/${i.kind === "metric" ? "metrics" : "datasets"}/${i.id}`,
          }))}
        />
      ) : null}
    </div>
  );
}

/** Where a proposal came from, for its page's header: the source, and when it was asked. */
export function ProposalOrigin({ p }: { p: ProposalView }) {
  return (
    <p className="text-body text-muted">
      {p.connectionName}
      {p.from.visible ? null : " · from an answer you can't see"}
      {` · asked ${asked(p.createdAt)}`}
    </p>
  );
}
