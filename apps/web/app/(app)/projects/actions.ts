"use server";

import {
  createProject,
  deleteProject,
  moveToProject,
  ProjectNotFound,
  ProjectRefused,
  type ProjectRole,
  removeProjectPerson,
  setProjectPerson,
  updateProject,
} from "@opendash/core";
import { isUuid, type TenantTx, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { actorOf } from "@/lib/projects";
import { teamOf } from "@/lib/team";

type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Runs a project change as the signed-in person; a refusal comes back as its message. */
async function run<T extends object>(
  work: (tx: TenantTx, actor: ReturnType<typeof actorOf>) => Promise<T>,
): Promise<Result<T>> {
  const viewer = await requireTenant();
  try {
    const out = await withTenant(viewer.ctx, (tx) => work(tx, actorOf(viewer)));
    // The sidebar lists the person's projects: read it again.
    revalidatePath("/", "layout");
    return { ok: true, ...out };
  } catch (error) {
    if (error instanceof ProjectRefused || error instanceof ProjectNotFound)
      return { ok: false, message: error.message };
    console.error(JSON.stringify({ msg: "project change failed", error: String(error) }));
    return { ok: false, message: "Couldn't save that. Try again." };
  }
}

const ROLES: ProjectRole[] = ["manager", "editor", "viewer"];

export async function createProjectAction(input: {
  name: string;
  description?: string;
  visibility: "private" | "org";
}): Promise<Result<{ id: string }>> {
  if (typeof input?.name !== "string" || (input.description !== undefined && typeof input.description !== "string")) {
    return { ok: false, message: "That can't be saved." };
  }
  return run(async (tx, actor) => {
    const p = await createProject(tx, actor, {
      name: String(input.name ?? ""),
      description: input.description ? String(input.description) : null,
      visibility: input.visibility === "org" ? "org" : "private",
    });
    return { id: p.id };
  });
}

export async function updateProjectAction(
  id: string,
  input: { name?: string; description?: string | null; visibility?: "private" | "org" },
): Promise<Result> {
  if (!isUuid(id)) return { ok: false, message: "That project doesn't exist." };
  // From the browser: only what's expected goes on to core.
  const { name, description, visibility } = (input ?? {}) as Record<string, unknown>;
  if (
    (name !== undefined && typeof name !== "string") ||
    (description !== undefined && description !== null && typeof description !== "string") ||
    (visibility !== undefined && visibility !== "private" && visibility !== "org")
  ) {
    return { ok: false, message: "That can't be saved." };
  }
  const change = {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description: description as string | null } : {}),
    ...(visibility !== undefined ? { visibility: visibility as "private" | "org" } : {}),
  };
  return run(async (tx, actor) => {
    await updateProject(tx, actor, id, change);
    return {};
  });
}

export async function deleteProjectAction(id: string): Promise<Result> {
  if (!isUuid(id)) return { ok: false, message: "That project doesn't exist." };
  return run(async (tx, actor) => {
    await deleteProject(tx, actor, id);
    return {};
  });
}

/** Adds someone from the organization, or changes their role. Their organization role comes from its member list. */
export async function setProjectPersonAction(id: string, userId: string, role: ProjectRole): Promise<Result> {
  if (!isUuid(id) || !isUuid(userId) || !ROLES.includes(role)) return { ok: false, message: "That can't be done." };
  const viewer = await requireTenant();
  const member = (await teamOf(viewer.ctx.orgId)).members.find((m) => m.userId === userId);
  if (!member) return { ok: false, message: "They aren't in this organization." };
  return run(async (tx, actor) => {
    await setProjectPerson(tx, actor, id, { userId, orgRole: member.role, role });
    return {};
  });
}

export async function removeProjectPersonAction(id: string, userId: string): Promise<Result> {
  if (!isUuid(id) || !isUuid(userId)) return { ok: false, message: "That can't be done." };
  return run(async (tx, actor) => {
    await removeProjectPerson(tx, actor, id, userId);
    return {};
  });
}

/** Moves the person's own conversation or dashboard into a project (or out, with `projectId` null). */
export async function moveToProjectAction(
  item: { kind: "thread" | "dashboard"; id: string },
  projectId: string | null,
  share: boolean,
): Promise<Result> {
  if (!isUuid(item.id) || (projectId !== null && !isUuid(projectId)) || !["thread", "dashboard"].includes(item.kind)) {
    return { ok: false, message: "That can't be moved." };
  }
  return run(async (tx, actor) => {
    await moveToProject(tx, actor, { kind: item.kind, id: item.id }, projectId, { share: share === true });
    return {};
  });
}
