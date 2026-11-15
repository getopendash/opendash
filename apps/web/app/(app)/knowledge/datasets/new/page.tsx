import { askableSources } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DefinitionEditPage, templateFor } from "@/components/knowledge/definition-edit-page";
import { requireTenant } from "@/lib/auth";
import { canVerify, sourceModelFor } from "@/lib/knowledge";

export const metadata: Metadata = { title: "New dataset · OpenDash" };

/** The definition editor for a new dataset, on a source that was learned (?source= picks one; the first otherwise). */
export default async function NewDatasetPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const [{ source }, viewer] = await Promise.all([searchParams, requireTenant()]);
  if (!canVerify(viewer.role)) redirect("/knowledge/datasets");
  const sources = await withTenant(viewer.ctx, (tx) => askableSources(tx, viewer.ctx.orgId));
  const chosen = sources.find((s) => s.id === source) ?? sources[0];
  if (!chosen) redirect("/data/sources");
  const model = await sourceModelFor(viewer.ctx.orgId, chosen.id);
  return (
    <DefinitionEditPage
      kind="dataset"
      d={null}
      connectionId={chosen.id}
      sourceName={chosen.name}
      initial={templateFor("dataset", model)}
    />
  );
}
