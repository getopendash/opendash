import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DefinitionEditPage } from "@/components/knowledge/definition-edit-page";
import { requireTenant } from "@/lib/auth";
import { usageFor } from "@/lib/definition-usage";
import { impactOf } from "@/lib/impact";
import { canVerify, definitionFor } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Edit metric · OpenDash" };

/** Editing a metric (a new version). Owners and admins only, like approving. */
export default async function EditMetricPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const d = await definitionFor(viewer.ctx.orgId, viewer.user.id, id);
  if (d?.kind !== "metric") notFound();
  if (!canVerify(viewer.role)) redirect(`/knowledge/metrics/${id}`);
  const impact = impactOf(await usageFor(viewer.ctx.orgId, viewer.user.id, d), d.kind);
  return (
    <DefinitionEditPage
      impact={impact}
      kind="metric"
      d={d}
      connectionId={d.connectionId}
      sourceName={d.connectionName}
      initial={d.body}
    />
  );
}
