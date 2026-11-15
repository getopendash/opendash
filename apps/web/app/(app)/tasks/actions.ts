"use server";

import { createTask, HORIZONS, setTaskStatus, TaskProblem } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { canAsk } from "@/lib/roles";

type Result = { ok: true } | { ok: false; message: string };

const refresh = () => {
  revalidatePath("/tasks");
  revalidatePath("/insights");
  revalidatePath("/");
};

async function attempt(fn: () => Promise<unknown>): Promise<Result> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TaskProblem) return { ok: false, message: error.message };
    throw error;
  }
  refresh();
  return { ok: true };
}

/** Creates a task from an insight: anyone who can ask. It's theirs, to do. */
export async function createTaskAction(input: {
  insightId: string;
  title: string;
  direction: "up" | "down";
  horizonMonths: number;
  dueAt?: string | null;
}): Promise<Result> {
  const viewer = await requireTenant();
  if (!canAsk(viewer.role)) return { ok: false, message: "Viewers read tasks; they don't create them." };
  if (
    !isUuid(input.insightId) ||
    typeof input.title !== "string" ||
    (input.direction !== "up" && input.direction !== "down") ||
    !(HORIZONS as readonly number[]).includes(input.horizonMonths) ||
    (input.dueAt != null && typeof input.dueAt !== "string")
  ) {
    return { ok: false, message: "That task can't be saved." };
  }
  const ctx = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  return attempt(() =>
    withTenant(viewer.ctx, (tx) =>
      createTask(tx, ctx, {
        insightId: input.insightId,
        title: input.title,
        direction: input.direction,
        horizonMonths: input.horizonMonths,
        dueAt: input.dueAt ?? null,
      }),
    ),
  );
}

/** Starts, finishes or dismisses a task: its owner, or an owner or admin; a viewer (even one who made it) reads it. */
export async function setTaskStatusAction(id: string, status: "in_progress" | "done" | "dismissed"): Promise<Result> {
  const viewer = await requireTenant();
  if (!canAsk(viewer.role)) return { ok: false, message: "Viewers read tasks; they don't change them." };
  if (!isUuid(id) || !["in_progress", "done", "dismissed"].includes(status)) {
    return { ok: false, message: "That task can't be changed." };
  }
  const ctx = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canVerify(viewer.role) };
  return attempt(() => withTenant(viewer.ctx, (tx) => setTaskStatus(tx, ctx, id, status)));
}
