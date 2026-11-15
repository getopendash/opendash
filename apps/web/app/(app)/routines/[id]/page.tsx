import { getAuthDatabase, memberNames } from "@opendash/auth";
import { composerChoices, displayMetric, getRoutine, needsManager, nextOccurrence, WATCHING_KEY } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoutinePage } from "@/components/routines/routine-page";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";
import { type HappensNames, whenLine } from "@/lib/routine-words";

export const metadata: Metadata = { title: "Routine · OpenDash" };
export const dynamic = "force-dynamic";

/** A routine's page: its sentence, what happens each time, its runs or its checks. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, viewer] = await Promise.all([params, requireTenant()]);
  if (!isUuid(id)) notFound();
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  const loaded = await withTenant(viewer.ctx, async (tx) => {
    const r = await getRoutine(tx, actor, id);
    if (!r) return null;
    const choices = await composerChoices(tx, actor);
    return { r, choices };
  });
  if (!loaded) notFound();
  const { r, choices } = loaded;
  const [owner] = Object.values(await memberNames(getAuthDatabase(), viewer.ctx.orgId, [r.ownerId]));
  const team = needsManager({ key: r.key, ownerId: r.ownerId, userIds: r.userIds, slack: r.slack });
  const metrics = r.spec.trigger === "found" ? r.spec.metricIds : [];
  const lineMetric = choices.metrics.find((m) => m.id === metrics[0]);
  const asked = r.spec.trigger === "schedule" && r.spec.action.kind === "ask" ? r.spec.action.connectionId : null;
  const names: HappensNames = {
    metrics: metrics.flatMap((m) => {
      const c = choices.metrics.find((x) => x.id === m);
      return c ? [{ title: c.title, others: Math.max(0, c.watchedBy - 1), grain: c.grain }] : [];
    }),
    line:
      r.spec.trigger === "found" && r.spec.condition.kind === "crosses"
        ? displayMetric(lineMetric?.format ?? "number", r.spec.condition.value)
        : null,
    source: asked ? (choices.sources.find((s) => s.id === asked)?.name ?? null) : null,
    where: r.sentence.find((p) => p.role === "where")?.text ?? null,
    team,
    first:
      r.status !== "active"
        ? null
        : r.spec.trigger === "schedule"
          ? `Next run ${whenLine(r.nextRunAt ?? nextOccurrence(r.spec.rule, choices.tz, new Date()).toISOString(), choices.tz)}.`
          : null,
  };
  return (
    <RoutinePage
      routine={r}
      names={names}
      owner={r.ownerId === viewer.user.id ? "You" : (owner ?? "Someone who left")}
      me={viewer.user.id}
      tz={choices.tz}
      canManage={actor.canManage}
      watching={r.key === WATCHING_KEY}
    />
  );
}
