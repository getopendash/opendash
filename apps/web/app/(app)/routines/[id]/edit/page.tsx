import { getRoutine, WATCHING_KEY } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { RoutineComposer } from "@/components/routines/routine-composer";
import { requireTenant } from "@/lib/auth";
import { draftOf } from "@/lib/routine-draft";
import { composerData } from "../../composer-data";

export const metadata: Metadata = { title: "Edit routine · OpenDash" };
export const dynamic = "force-dynamic";

/** A routine, open in the composer: what starts it stays as it is. */
export default async function EditRoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, viewer] = await Promise.all([params, requireTenant()]);
  if (!isUuid(id)) notFound();
  const data = await composerData();
  const r = await withTenant(viewer.ctx, (tx) => getRoutine(tx, data.actor, id));
  if (!r) notFound();
  if (!r.canEdit) redirect(`/routines/${id}`);
  const watched = r.spec.trigger === "found" ? r.spec.metricIds : [];
  const first = data.choices.metrics.find((m) => m.id === watched[0]);
  // Someone it emails who left the workspace is listed by name only when an owner or admin opens it.
  const members = [
    ...data.members,
    ...r.userIds
      .filter((u) => !data.members.some((m) => m.userId === u))
      .map((u) => ({ userId: u, name: "Someone who left" })),
  ];
  return (
    <RoutineComposer
      id={r.id}
      initial={draftOf(r.spec, r.userIds, data.actor.userId, first?.format ?? null, r.slack)}
      choices={data.choices}
      members={members}
      me={data.actor.userId}
      ownerId={r.ownerId}
      canManage={data.actor.canManage}
      canAsk={data.canAsk}
      watching={r.key === WATCHING_KEY}
      workspace={data.workspace}
      fromPreset={false}
      slack={data.slack}
    />
  );
}
