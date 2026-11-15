"use server";

import {
  type KeyTable,
  type KeyTableView,
  keyTableChoices,
  ProjectNotFound,
  ProjectRefused,
  setKeyTables,
} from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { actorOf } from "@/lib/projects";

type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };
type Choice = Awaited<ReturnType<typeof keyTableChoices>>[number];

const refusal = (error: unknown): { ok: false; message: string } => {
  if (error instanceof ProjectRefused || error instanceof ProjectNotFound) return { ok: false, message: error.message };
  throw error;
};

/** A source's tables to pick from, most used first, with their coverage. */
export async function keyTableChoicesAction(
  projectId: string,
  connectionId: string,
): Promise<Result<{ choices: Choice[] }>> {
  if (!isUuid(projectId) || !isUuid(connectionId)) return { ok: false, message: "Pick a source." };
  const viewer = await requireTenant();
  try {
    const choices = await withTenant(viewer.ctx, (tx) => keyTableChoices(tx, actorOf(viewer), projectId, connectionId));
    return { ok: true, choices };
  } catch (error) {
    return refusal(error);
  }
}

/** Sets a project's key tables (its managers). */
export async function setKeyTablesAction(
  projectId: string,
  tables: KeyTable[],
): Promise<Result<{ tables: KeyTableView[] }>> {
  if (!isUuid(projectId) || !Array.isArray(tables)) return { ok: false, message: "That can't be saved." };
  const viewer = await requireTenant();
  try {
    const saved = await withTenant(viewer.ctx, (tx) =>
      setKeyTables(
        tx,
        actorOf(viewer),
        projectId,
        tables.slice(0, 100).map((t) => ({ connectionId: String(t?.connectionId), table: String(t?.table) })),
      ),
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, tables: saved };
  } catch (error) {
    return refusal(error);
  }
}
