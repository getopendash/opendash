"use server";

import { disconnectSlack, unlinkSlackIdentity } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { slackDeps, slackRevoke } from "@/lib/slack";
import { canManageTeam } from "@/lib/team";

type Result = { ok: true; message?: string } | { ok: false; message: string };

const admin = async () => {
  const viewer = await requireTenant();
  return canManageTeam(viewer.role) ? viewer : null;
};

/**
 * Disconnects the Slack workspace: its links and stored token go, and the token is given back to
 * Slack, after the change is saved; the conversations asked from it stay in OpenDash. Also forgets one Slack removed.
 */
export async function disconnectSlackAction(): Promise<Result> {
  const viewer = await admin();
  if (!viewer) return { ok: false, message: "Only owners and admins disconnect Slack." };
  const gone = await withTenant(viewer.ctx, (tx) => disconnectSlack(slackDeps, tx, viewer.ctx.orgId));
  revalidatePath("/settings/slack");
  if (gone.unreadable || (gone.token && !(await slackRevoke(gone.token)))) {
    return {
      ok: true,
      message:
        "Slack is disconnected here. Slack didn't confirm the app's access is gone: remove OpenDash in Slack too.",
    };
  }
  return { ok: true };
}

/** Unlinks someone's Slack account: their next question there asks them to link again. */
export async function unlinkSlackAction(slackUserId: string): Promise<Result> {
  const viewer = await admin();
  if (!viewer) return { ok: false, message: "Only owners and admins unlink people." };
  if (typeof slackUserId !== "string" || !/^[A-Z0-9]{2,32}$/.test(slackUserId)) {
    return { ok: false, message: "That person isn't linked." };
  }
  await withTenant(viewer.ctx, (tx) => unlinkSlackIdentity(tx, viewer.ctx.orgId, slackUserId));
  revalidatePath("/settings/slack");
  return { ok: true };
}
