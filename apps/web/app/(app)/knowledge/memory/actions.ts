"use server";

import { ContextProblem, forgetMemory, memoryTexts, rememberFact, restoreMemory, undoRemember } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";

/**
 * Remembers what this person chose: their own, in a transaction carrying their user id, so the tenant
 * policy keeps it theirs. Returns the memories kept, by id, for Undo.
 */
export async function rememberAction(input: {
  facts: string[];
  threadId?: string | null;
}): Promise<{ saved: { id: string; fact: string }[]; letGo: number } | { message: string }> {
  const viewer = await requireTenant();
  const facts = Array.isArray(input?.facts)
    ? input.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 10)
    : [];
  if (!facts.length) return { message: "Choose or write what to remember." };
  const threadId = typeof input.threadId === "string" && isUuid(input.threadId) ? input.threadId : null;
  try {
    const out = await withTenant(viewer.ctx, async (tx) => {
      const saved: { id: string; fact: string }[] = [];
      let letGo = 0;
      for (const fact of facts) {
        const r = await rememberFact(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, { fact, threadId });
        saved.push({ id: r.id, fact: r.fact });
        letGo += r.letGo;
      }
      return { saved, letGo };
    });
    revalidatePath("/knowledge/memory");
    return out;
  } catch (error) {
    if (error instanceof ContextProblem) return { message: error.message };
    throw error;
  }
}

/** Forgets memories of this person's (Undo, Forget). Anyone else's ids forget nothing. */
export async function forgetAction(ids: string[]): Promise<{ forgotten: number }> {
  const viewer = await requireTenant();
  const valid = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && isUuid(id)).slice(0, 50) : [];
  let forgotten = 0;
  await withTenant(viewer.ctx, async (tx) => {
    for (const id of valid) if (await forgetMemory(tx, viewer.ctx.orgId, viewer.user.id, id)) forgotten += 1;
  });
  revalidatePath("/knowledge/memory");
  return { forgotten };
}

/**
 * Undo of a memory the analyst kept under an answer: forgotten, and the older ones it replaced about the same
 * thing kept again. This person's own only.
 */
export async function undoRememberAction(id: string, replaced: string[] = []): Promise<{ forgotten: boolean }> {
  const viewer = await requireTenant();
  if (typeof id !== "string" || !isUuid(id)) return { forgotten: false };
  const older = Array.isArray(replaced) ? replaced.filter((r) => typeof r === "string" && isUuid(r)).slice(0, 10) : [];
  const forgotten = await withTenant(viewer.ctx, (tx) =>
    undoRemember(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id, older),
  );
  revalidatePath("/knowledge/memory");
  return { forgotten };
}

/** Keeps again a memory of this person's that the analyst forgot when asked (Undo). Anyone else's: nothing. */
export async function restoreAction(id: string): Promise<{ restored: boolean }> {
  const viewer = await requireTenant();
  if (typeof id !== "string" || !isUuid(id)) return { restored: false };
  const restored = await withTenant(viewer.ctx, (tx) => restoreMemory(tx, viewer.ctx.orgId, viewer.user.id, id));
  revalidatePath("/knowledge/memory");
  return { restored };
}

/** The text of the memories a run was given, for its asker only (Sources → Context); anyone else gets none. */
export async function memoryTextsAction(ids: string[]): Promise<{ id: string; fact: string }[]> {
  const viewer = await requireTenant();
  const valid = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && isUuid(id)).slice(0, 50) : [];
  if (!valid.length) return [];
  return withTenant(viewer.ctx, (tx) => memoryTexts(tx, viewer.ctx.orgId, viewer.user.id, valid));
}
