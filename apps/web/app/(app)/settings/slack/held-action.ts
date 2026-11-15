"use server";

import { heldSlackInstall } from "@opendash/core";
import { sql, withTenant } from "@opendash/db";
import { cookies } from "next/headers";
import { requireTenant } from "@/lib/auth";
import { SLACK_INSTALL_COOKIE } from "@/lib/slack";
import { canManageTeam } from "@/lib/team";

const ID = /^[0-9a-f-]{36}$/i;
const CODE = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * Back from Slack: which Slack workspace this Add to Slack would connect, and to which OpenDash workspace, so
 * the page asks before it does. Only for the person who started it, in the browser they started in, with Slack's code.
 * Its own module, so a running dev server registers it.
 */
export async function heldSlackInstallAction(
  installId: string,
  code: string,
): Promise<{ teamName: string; workspace: string } | null> {
  const viewer = await requireTenant();
  const userId = viewer.ctx.userId;
  if (!canManageTeam(viewer.role) || !userId) return null;
  if (typeof installId !== "string" || typeof code !== "string" || !ID.test(installId) || !CODE.test(code)) return null;
  const browserSecret = (await cookies()).get(SLACK_INSTALL_COOKIE)?.value ?? "";
  return withTenant(viewer.ctx, async (tx) => {
    const team = await heldSlackInstall(tx, { orgId: viewer.ctx.orgId, userId }, { installId, code, browserSecret });
    if (!team) return null;
    const [org] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${viewer.ctx.orgId}`);
    return { teamName: team.teamName, workspace: org?.name ?? "this workspace" };
  });
}
