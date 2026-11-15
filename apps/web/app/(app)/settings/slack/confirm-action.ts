"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireTenant } from "@/lib/auth";
import { SLACK_INSTALL_COOKIE, SLACK_INSTALL_COOKIE_PATH } from "@/lib/slack";
import { confirmSlackInstall, type SlackInstallOutcome } from "@/lib/slack-install";
import { canManageTeam } from "@/lib/team";

const ID = /^[0-9a-f-]{36}$/i;
const CODE = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * Connects the Slack workspace an Add to Slack brought back, when this is the owner or admin
 * who started it, in the browser they started in (its cookie), with the code Slack's return carried (the address's
 * fragment, read by the page), and they pressed Connect. Its own module, so a running dev server registers it.
 */
export async function confirmSlackInstallAction(
  installId: string,
  code: string,
): Promise<{ outcome: SlackInstallOutcome | "not_allowed" }> {
  const viewer = await requireTenant();
  const userId = viewer.ctx.userId;
  if (!canManageTeam(viewer.role) || !userId) return { outcome: "not_allowed" };
  const jar = await cookies();
  const browserSecret = jar.get(SLACK_INSTALL_COOKIE)?.value ?? "";
  if (typeof installId !== "string" || typeof code !== "string" || !ID.test(installId) || !CODE.test(code)) {
    return { outcome: "not_this_browser" };
  }
  const outcome = await confirmSlackInstall({ orgId: viewer.ctx.orgId, userId }, { installId, code, browserSecret });
  // The browser's secret goes once the install is over; a confirm that didn't match leaves it for the real one.
  if (outcome !== "not_this_browser") jar.delete({ name: SLACK_INSTALL_COOKIE, path: SLACK_INSTALL_COOKIE_PATH });
  revalidatePath("/settings/slack");
  return { outcome };
}
