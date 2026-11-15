"use server";

import { approveProposal, ProposalProblem, rejectDraft, rejectProposal } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

type Result = { ok: true } | { ok: false; message: string };

const decided = () => {
  revalidatePath("/knowledge/proposals", "layout");
  revalidatePath("/knowledge/metrics");
  revalidatePath("/knowledge/datasets");
};

/** Approves a Modeler proposal, releasing its definitions. Owners and admins. */
export async function approveProposalAction(id: string): Promise<Result> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins approve definitions." };
  try {
    await withTenant({ orgId: viewer.ctx.orgId }, (tx) =>
      approveProposal(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id),
    );
  } catch (error) {
    if (error instanceof ProposalProblem) return { ok: false, message: error.message };
    throw error;
  }
  decided();
  return { ok: true };
}

/** Rejects a Modeler proposal with a note for its next draft; its drafts are deleted. Owners and admins. */
export async function rejectProposalAction(id: string, note: string): Promise<Result> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins reject definitions." };
  try {
    await withTenant({ orgId: viewer.ctx.orgId }, (tx) =>
      rejectProposal(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id, note),
    );
  } catch (error) {
    if (error instanceof ProposalProblem) return { ok: false, message: error.message };
    throw error;
  }
  decided();
  return { ok: true };
}

/**
 * Rejects one of a source's drafts with a note for its next draft (a dataset takes the metrics drafted on it
 * along). Owners and admins.
 */
export async function rejectDraftAction(id: string, note: string): Promise<Result> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins reject definitions." };
  try {
    await withTenant({ orgId: viewer.ctx.orgId }, (tx) =>
      rejectDraft(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id, note),
    );
  } catch (error) {
    if (error instanceof ProposalProblem) return { ok: false, message: error.message };
    throw error;
  }
  decided();
  revalidatePath("/data/sources", "layout");
  return { ok: true };
}
