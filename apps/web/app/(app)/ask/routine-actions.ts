"use server";

import { answerForRoutine, watchedByRoutines } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { MetricWatch } from "@/components/routines/watch-choices";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";

/**
 * Watch on an answer: the verified metrics it read, each with who watches it already, for someone
 * who can read its conversation.
 */
export async function answerWatchAction(
  runId: string,
): Promise<
  | { ok: true; canManage: boolean; metrics: { metric: { id: string; title: string }; watch: MetricWatch }[] }
  | { ok: false; message: string }
> {
  const viewer = await requireTenant();
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  return withTenant(viewer.ctx, async (tx) => {
    const answer = await answerForRoutine(tx, actor, runId);
    if (!answer) return { ok: false as const, message: "That answer can't be watched." };
    const watched = new Map((await watchedByRoutines(tx, actor)).map((w) => [w.metric.id, w]));
    return {
      ok: true as const,
      canManage: actor.canManage,
      metrics: answer.metrics.map((m) => {
        const w = watched.get(m.id);
        return {
          metric: { id: m.id, title: m.title },
          watch: { watchers: w?.watchers ?? [], others: w?.others ?? 0 },
        };
      }),
    };
  });
}
