"use server";

import {
  createFolder,
  deleteFolder,
  type FolderView,
  moveToFolder,
  ProjectNotFound,
  ProjectRefused,
  renameFolder,
} from "@opendash/core";
import { isUuid, type TenantTx, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { actorOf } from "@/lib/projects";

type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Runs a folder change as the signed-in person; a refusal comes back as its message. */
async function run<T extends object>(
  projectId: string,
  work: (tx: TenantTx, actor: ReturnType<typeof actorOf>) => Promise<T>,
): Promise<Result<T>> {
  const viewer = await requireTenant();
  try {
    const out = await withTenant(viewer.ctx, (tx) => work(tx, actorOf(viewer)));
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, ...out };
  } catch (error) {
    if (error instanceof ProjectRefused || error instanceof ProjectNotFound) {
      return { ok: false, message: error.message };
    }
    console.error(JSON.stringify({ msg: "folder change failed", error: String(error) }));
    return { ok: false, message: "Couldn't save that. Try again." };
  }
}

const bad = { ok: false as const, message: "That can't be changed." };

/** A new folder in a project. */
export async function createFolderAction(projectId: string, name: string): Promise<Result<{ folder: FolderView }>> {
  if (!isUuid(projectId) || typeof name !== "string") return bad;
  return run(projectId, async (tx, actor) => ({ folder: await createFolder(tx, actor, projectId, name) }));
}

/** Renames one of a project's folders. */
export async function renameFolderAction(projectId: string, folderId: string, name: string): Promise<Result> {
  if (!isUuid(projectId) || !isUuid(folderId) || typeof name !== "string") return bad;
  return run(projectId, async (tx, actor) => {
    await renameFolder(tx, actor, folderId, name);
    return {};
  });
}

/** Deletes a folder; what was in it stays in the project. */
export async function deleteFolderAction(projectId: string, folderId: string): Promise<Result> {
  if (!isUuid(projectId) || !isUuid(folderId)) return bad;
  return run(projectId, async (tx, actor) => {
    await deleteFolder(tx, actor, folderId);
    return {};
  });
}

/** Puts the person's own conversation or dashboard in a folder of its project, or in none. */
export async function moveToFolderAction(
  projectId: string,
  item: { kind: "thread" | "dashboard"; id: string },
  folderId: string | null,
): Promise<Result> {
  if (
    !isUuid(projectId) ||
    !isUuid(item?.id) ||
    !["thread", "dashboard"].includes(item.kind) ||
    (folderId !== null && !isUuid(folderId))
  ) {
    return bad;
  }
  return run(projectId, async (tx, actor) => {
    await moveToFolder(tx, actor, { kind: item.kind, id: item.id }, folderId);
    return {};
  });
}
