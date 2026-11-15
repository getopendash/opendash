import { buttonVariants } from "@heroui/react";
import type { DefinitionKind } from "@opendash/core";
import { GitPullRequestArrow, Plus } from "lucide-react";
import Link from "next/link";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify, definitionsFor } from "@/lib/knowledge";
import { DefinitionsTable } from "./definitions-table";

const COPY = {
  metric: {
    title: "Metrics",
    lead: "The numbers your team agreed on. Ask answers with these first, and labels every number that came from one.",
  },
  dataset: {
    title: "Datasets",
    lead: "Governed tables the metrics are built on: one row per something, with measures, segments and joins.",
  },
} as const;

/** Knowledge's list of one kind, with the proposals waiting for review. */
export async function KnowledgeList({ kind }: { kind: DefinitionKind }) {
  const viewer = await requireTenant();
  const all = await definitionsFor(viewer.ctx.orgId);
  const proposed = all.filter((d) => d.status === "proposed");
  const sources = [...new Set(proposed.map((d) => d.connectionName))];
  return (
    <>
      <TopBar
        crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: COPY[kind].title }]}
        action={
          canVerify(viewer.role) ? (
            <Link
              href={`/knowledge/${kind === "metric" ? "metrics" : "datasets"}/new`}
              className={`${buttonVariants({ size: "sm" })} gap-1`}
            >
              <Plus className="size-3.5" aria-hidden />
              New {kind}
            </Link>
          ) : undefined
        }
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">{COPY[kind].title}</h1>
            <p className="text-body text-muted">{COPY[kind].lead}</p>
          </div>
          {proposed.length ? (
            <div className="flex items-center gap-3 rounded-2xl bg-accent-soft px-4 py-3 text-body text-accent-soft-foreground">
              <GitPullRequestArrow className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">
                {proposed.length} {proposed.length === 1 ? "definition is" : "definitions are"} waiting for review: the
                starter pack for {sources.join(", ")}.
              </span>
              <Link href="/knowledge/proposals" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                Review
              </Link>
            </div>
          ) : null}
          <DefinitionsTable
            kind={kind}
            definitions={all.filter((d) => d.kind === kind)}
            datasets={all.filter((d) => d.kind === "dataset")}
          />
        </div>
      </div>
    </>
  );
}
