"use server";

import {
  type ComposerResult,
  composerResult,
  deploymentKeys,
  RoutineProblem,
  SpendLimitReached,
  startComposer,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";
import { queue } from "@/lib/sources";
import { teamOf } from "@/lib/team";

/**
 * Describe it: the person's words to the composer agent, with whom they may name. Owners and admins
 * name anyone in the workspace (by display name: no address goes to a model) and the channels the composer listed;
 * anyone else, only themselves. Its spend is the questions'.
 */
export async function describeRoutineAction(
  text: string,
  channels: string[],
): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
  if (typeof text !== "string" || !Array.isArray(channels)) return { ok: false, message: "Say what should happen." };
  const viewer = await requireTenant();
  const canManage = canManageTeam(viewer.role);
  const people = canManage
    ? (await teamOf(viewer.ctx.orgId)).members.flatMap((m) => (m.name.trim() ? [m.name.trim().slice(0, 120)] : []))
    : [];
  const named = canManage
    ? channels.filter((c): c is string => typeof c === "string" && c.length <= 80).slice(0, 200)
    : [];
  try {
    const { runId } = await withTenant(viewer.ctx, async (tx) =>
      startComposer(
        tx,
        { boss: await queue(), deploymentKeys: deploymentKeys() },
        {
          orgId: viewer.ctx.orgId,
          userId: viewer.user.id,
          text,
          people,
          channels: named,
          canManage,
        },
      ),
    );
    return { ok: true, runId };
  } catch (error) {
    if (error instanceof RoutineProblem || error instanceof SpendLimitReached)
      return { ok: false, message: error.message };
    throw error;
  }
}

/** Where a Describe it run is: still working, its proposal, or why it couldn't. */
export async function describeResultAction(runId: string): Promise<ComposerResult> {
  if (!isUuid(runId)) return { status: "failed", message: "That isn't one of yours." };
  const viewer = await requireTenant();
  const out = await withTenant(viewer.ctx, (tx) =>
    composerResult(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, runId),
  );
  return out ?? { status: "failed", message: "That isn't one of yours." };
}
