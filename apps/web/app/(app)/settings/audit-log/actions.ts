"use server";

import type { AuditVerifyResult } from "@opendash/core/enterprise";
import { auditAccess, tenantRun } from "@/lib/audit-log";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/team";

/** Verify: walks the workspace's audit chain from its first remaining event. Owners and admins, licensed. */
export async function verifyAuditChain(): Promise<AuditVerifyResult | { message: string }> {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) return { message: "Only owners and admins verify the audit log." };
  const { chain } = auditAccess();
  if (!chain) return { message: "Verifying the audit log needs an Enterprise license." };
  return chain.verify(tenantRun(viewer.ctx.orgId, viewer.user.id), viewer.ctx.orgId);
}
