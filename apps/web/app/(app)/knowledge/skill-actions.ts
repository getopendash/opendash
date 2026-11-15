"use server";

import { ContextProblem, saveSkill } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

/** Saves a skill as a draft: owners and admins write skills; approving makes it the one the analyst follows. */
export async function saveSkillAction(input: {
  id?: string;
  title: string;
  description: string;
  body: string;
  changeNote?: string;
}): Promise<{ id: string; version: number } | { message: string }> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { message: "Only owners and admins write skills." };
  if (input.id !== undefined && !isUuid(input.id)) return { message: "That skill doesn't exist." };
  const text = (v: unknown) => typeof v === "string";
  if (!text(input.title) || !text(input.description) || !text(input.body)) return { message: "That can't be saved." };
  if (input.changeNote !== undefined && !text(input.changeNote)) return { message: "That can't be saved." };
  try {
    const saved = await withTenant(viewer.ctx, (tx) =>
      saveSkill(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, input),
    );
    revalidatePath("/knowledge", "layout");
    return saved;
  } catch (error) {
    if (error instanceof ContextProblem) return { message: error.message };
    throw error;
  }
}
