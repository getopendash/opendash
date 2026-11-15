"use server";

import { ContextProblem, deleteContextItem, saveVerifiedQuery } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

type Result = { id: string; version: number } | { message: string };

async function admin() {
  const viewer = await requireTenant();
  return canVerify(viewer.role) ? viewer : null;
}

const words = (list: unknown) =>
  Array.isArray(list) ? list.filter((w): w is string => typeof w === "string").slice(0, 20) : [];

/**
 * Saves an answer's metric query as a verified query, or a new version of one (its question and wordings).
 * Owners and admins; the query comes from the query run on the server, never from here.
 */
export async function saveVerifiedAction(input: {
  id?: string;
  queryRunId?: string;
  question: string;
  phrasings?: string[];
  changeNote?: string;
}): Promise<Result> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins verify queries." };
  if (input.id && !isUuid(input.id)) return { message: "That verified query doesn't exist." };
  if (!input.id && !(input.queryRunId && isUuid(input.queryRunId))) return { message: "That query doesn't exist." };
  try {
    const r = await withTenant(viewer.ctx, (tx) =>
      saveVerifiedQuery(
        tx,
        { orgId: viewer.ctx.orgId, userId: viewer.user.id },
        {
          ...(input.id ? { id: input.id } : { queryRunId: input.queryRunId as string }),
          question: typeof input.question === "string" ? input.question : "",
          phrasings: words(input.phrasings),
          ...(typeof input.changeNote === "string" && input.changeNote ? { changeNote: input.changeNote } : {}),
        },
      ),
    );
    revalidatePath("/knowledge", "layout");
    return r;
  } catch (error) {
    if (error instanceof ContextProblem) return { message: error.message };
    throw error;
  }
}

/** Deletes a verified query: the analyst stops being given it at once. */
export async function deleteVerifiedAction(id: string): Promise<{ message?: string }> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins delete verified queries." };
  const ok = await withTenant(viewer.ctx, (tx) => deleteContextItem(tx, viewer.ctx.orgId, id));
  revalidatePath("/knowledge", "layout");
  return ok ? {} : { message: "It was already deleted." };
}
