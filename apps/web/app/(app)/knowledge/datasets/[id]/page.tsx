import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DefinitionPage } from "@/components/knowledge/definition-page";
import { requireTenant } from "@/lib/auth";
import { usageFor } from "@/lib/definition-usage";
import { canVerify, definitionFor, reportsFor, sourceModelFor } from "@/lib/knowledge";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (!isUuid(id)) return { title: "Dataset · OpenDash" };
  const viewer = await requireTenant();
  const d = await definitionFor(viewer.ctx.orgId, viewer.user.id, id);
  return { title: `${d?.title ?? "Dataset"} · OpenDash` };
}

/** A dataset's page. */
export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const d = await definitionFor(viewer.ctx.orgId, viewer.user.id, id);
  if (d?.kind !== "dataset") notFound();
  const [model, reports, usage] = await Promise.all([
    sourceModelFor(viewer.ctx.orgId, d.connectionId),
    // Reports are for reviewers.
    canVerify(viewer.role) ? reportsFor(viewer.ctx.orgId, viewer.user.id, d.id) : Promise.resolve([]),
    usageFor(viewer.ctx.orgId, viewer.user.id, d),
  ]);
  return (
    <DefinitionPage
      d={d}
      model={model}
      canApprove={canVerify(viewer.role)}
      now={Date.now()}
      reports={reports}
      usage={usage}
    />
  );
}
