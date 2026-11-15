/**
 * How long the audit log keeps its rows. 90 days on every instance; longer, up to seven years, when the deployment asks
 * for it (OPENDASH_AUDIT_RETENTION_DAYS) and its license covers the audit chain. A lapsed or broken key never shortens
 * it: history the deployment asked to keep is kept (nothing is dropped) until a valid key or a shorter setting says
 * otherwise, so a lapse can't delete what an auditor expects to find.
 */
import type { Enterprise } from "../enterprise";

export const AUDIT_RETENTION_DAYS = { base: 90, max: 7 * 366 } as const;

/** The days to keep, or null to drop nothing this time. */
export function auditRetentionDays(gate: Enterprise, configured: string | undefined): number | null {
  const asked = Number.parseInt(configured ?? "", 10);
  const wanted = Number.isFinite(asked) && asked > 0 ? asked : AUDIT_RETENTION_DAYS.base;
  if (wanted <= AUDIT_RETENTION_DAYS.base) return AUDIT_RETENTION_DAYS.base;
  if (gate.canChange("audit")) return Math.min(wanted, AUDIT_RETENTION_DAYS.max);
  const state = gate.status().state;
  // Asked for longer, and the key that allowed it lapsed or broke: keep everything rather than shorten.
  if (state === "expired" || state === "invalid") return null;
  return AUDIT_RETENTION_DAYS.base;
}
