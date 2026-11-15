"use server";

import { approveContext, ContextProblem, deleteContextItem, saveGuide, saveTerm } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

type Result = { id: string; version: number } | { message: string };

/** Admins write the glossary and guides; members read them. */
async function admin() {
  const viewer = await requireTenant();
  return canVerify(viewer.role) ? viewer : null;
}

const done = () => {
  revalidatePath("/knowledge", "layout");
};

async function attempt(fn: () => Promise<{ id: string; version: number }>): Promise<Result> {
  try {
    const r = await fn();
    done();
    return r;
  } catch (error) {
    if (error instanceof ContextProblem) return { message: error.message };
    throw error;
  }
}

/** Saves a term from its YAML as a draft (approve makes it the one the analyst reads). */
export async function saveTermAction(input: {
  id?: string;
  body: string;
  connectionId?: string | null;
  changeNote?: string;
}): Promise<Result> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins write the glossary." };
  if (input.id && !isUuid(input.id)) return { message: "That term doesn't exist." };
  return attempt(() =>
    withTenant(viewer.ctx, (tx) => saveTerm(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, input)),
  );
}

/** Saves a guide as a draft. */
export async function saveGuideAction(input: {
  id?: string;
  title: string;
  body: string;
  pinned: boolean;
  connectionId?: string | null;
  table?: string | null;
  changeNote?: string;
}): Promise<Result> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins write guides." };
  if (input.id && !isUuid(input.id)) return { message: "That guide doesn't exist." };
  return attempt(() =>
    withTenant(viewer.ctx, (tx) => saveGuide(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, input)),
  );
}

/** Approves terms and guides at the versions the reviewer saw: they reach the analyst from the next question. */
export async function approveContextAction(
  items: { id: string; version: number }[],
): Promise<{ approved: number } | { message: string }> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins approve." };
  if (!Array.isArray(items)) return { message: "Nothing to approve." };
  const approved = await withTenant(viewer.ctx, (tx) =>
    approveContext(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, items.slice(0, 200)),
  );
  done();
  return { approved: approved.length };
}

/** Deletes a term or guide: it stops reaching the analyst at once. */
export async function deleteContextAction(id: string): Promise<{ message?: string }> {
  const viewer = await admin();
  if (!viewer) return { message: "Only owners and admins delete." };
  const ok = await withTenant(viewer.ctx, (tx) => deleteContextItem(tx, viewer.ctx.orgId, id));
  done();
  return ok ? {} : { message: "It was already deleted." };
}
