"use server";

import { confirmPassword, deleteOrganization, getAuthDatabase, isOwnerRole } from "@opendash/auth";
import { loggableError } from "@opendash/core";
import { requireTenant } from "@/lib/auth";
import { releaseSlack } from "@/lib/data";
import { currentWorkspace } from "@/lib/workspace";

export type DeleteResult = { ok: true } | { ok: false; field: "name" | "password" | null; message: string };

/**
 * Deletes the workspace and everything in it, for good: its owners only, signed in as themselves, who type its name
 * and (when their account has one) their password. Its members, sources, knowledge, conversations, dashboards,
 * routines, keys and Slack connection go at once; nobody can open it a moment later, and nothing brings it back.
 */
export async function deleteWorkspaceAction(input: { name: string; password: string }): Promise<DeleteResult> {
  const viewer = await requireTenant();
  if (!isOwnerRole(viewer.role)) {
    return { ok: false, field: null, message: "Only a workspace's owners delete it." };
  }
  const ws = await currentWorkspace();
  if (typeof input?.name !== "string" || input.name.trim() !== ws.org.name.trim()) {
    return { ok: false, field: "name", message: "That isn't this workspace's name." };
  }
  const database = getAuthDatabase();
  const password = await confirmPassword(database, viewer.user.id, input.password);
  if (password === "wrong") return { ok: false, field: "password", message: "That password isn't right." };

  const orgId = viewer.ctx.orgId;
  await releaseSlack(orgId);
  try {
    await deleteOrganization(database, orgId);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "workspace not deleted", orgId, error: loggableError(error) }));
    return { ok: false, field: null, message: "The workspace couldn't be deleted. Nothing was removed: try again." };
  }
  // The id alone: the name went with the workspace.
  console.info(JSON.stringify({ level: "info", msg: "workspace deleted", orgId, by: viewer.user.id }));
  return { ok: true };
}
