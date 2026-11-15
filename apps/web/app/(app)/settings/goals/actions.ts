"use server";

import { ContextProblem, deleteGoal, saveGoal } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

type Result = { ok: true } | { ok: false; message: string };

/** Sets or changes a goal: owners and admins. It applies at once. */
export async function saveGoalAction(input: {
  id?: string;
  metricId: string;
  target: number;
  due: string;
  direction?: "at_least" | "at_most";
}): Promise<Result> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins set goals." };
  if (input.id !== undefined && !isUuid(input.id)) return { ok: false, message: "That goal doesn't exist." };
  if (typeof input.metricId !== "string" || typeof input.target !== "number" || typeof input.due !== "string") {
    return { ok: false, message: "That can't be saved." };
  }
  if (input.direction !== undefined && input.direction !== "at_least" && input.direction !== "at_most") {
    return { ok: false, message: "That can't be saved." };
  }
  try {
    await withTenant(viewer.ctx, (tx) => saveGoal(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, input));
  } catch (error) {
    if (error instanceof ContextProblem) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath("/settings/goals");
  revalidatePath("/");
  return { ok: true };
}

/** Removes a goal: it leaves Home at once. */
export async function deleteGoalAction(id: string): Promise<Result> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins remove goals." };
  if (!isUuid(id)) return { ok: false, message: "That goal doesn't exist." };
  const removed = await withTenant(viewer.ctx, (tx) => deleteGoal(tx, viewer.ctx.orgId, id));
  revalidatePath("/settings/goals");
  revalidatePath("/");
  return removed ? { ok: true } : { ok: false, message: "That goal doesn't exist." };
}
