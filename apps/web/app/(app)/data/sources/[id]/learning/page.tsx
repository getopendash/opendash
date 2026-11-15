import { learningChoice } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { notFound } from "next/navigation";
import { LearningChoiceScreen } from "@/components/sources/learning-choice";
import { requireTenant } from "@/lib/auth";
import { canManageSources, sourcePage } from "@/lib/sources";

/** What OpenDash learns of a source, opened again from its Overview (owners and admins). */
export default async function SourceLearning({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, id);
  if (!data || !canManageSources(viewer.role)) notFound();
  const choice = await withTenant(viewer.ctx, (tx) => learningChoice(tx, viewer.ctx.orgId, data.source.id));
  if (!choice) notFound();
  return (
    <div className="flex flex-col">
      <LearningChoiceScreen
        connectionId={data.source.id}
        sourceName={data.source.name}
        choice={choice}
        done={`/data/sources/${data.source.id}`}
      />
    </div>
  );
}
