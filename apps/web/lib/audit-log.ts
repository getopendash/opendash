import "server-only";
import { AUDIT_CATEGORIES, type AuditCategory, auditRetentionDays } from "@opendash/core";
import type { RunAudit } from "@opendash/core/enterprise";
import { withTenant } from "@opendash/db";
import { enterprise } from "@/enterprise";

/**
 * Settings → Audit log: what the page and its export read. The last 90 days on every instance; with a license that
 * covers the audit chain, the chain's state, Verify, exports, and ranges up to the retention.
 */
export function auditAccess() {
  const gate = enterprise();
  const chain = gate.audit && gate.canChange("audit") ? gate.audit : null;
  const retention = auditRetentionDays(gate, process.env.OPENDASH_AUDIT_RETENTION_DAYS) ?? 90;
  // Only ranges the instance keeps: a year is offered when it keeps one.
  const ranges = [7, 30, 90, ...(chain ? [365, retention].filter((d) => d > 90 && d <= retention) : [])];
  return { chain, ranges: [...new Set(ranges)].sort((a, b) => a - b) };
}

export interface AuditQuery {
  who: string | null;
  what: AuditCategory | null;
  days: number;
  before: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page's filters from its address, each checked; anything else falls back to all of it, 90 days. */
export function auditQuery(params: Record<string, string | string[] | undefined>, ranges: number[]): AuditQuery {
  const one = (k: string) => {
    const v = params[k];
    return typeof v === "string" ? v : null;
  };
  const who = one("who");
  const what = one("what");
  const days = Number(one("days"));
  const before = one("before");
  return {
    who: who && UUID.test(who) ? who : null,
    what: what && Object.hasOwn(AUDIT_CATEGORIES, what) ? (what as AuditCategory) : null,
    days: ranges.includes(days) ? days : 90,
    before: before && UUID.test(before) ? before : null,
  };
}

export const sinceDays = (days: number, now = Date.now()) => new Date(now - days * 86_400_000);

/** A reader of the organization's rows for ee/'s chain: the tenant's own transaction. */
export const tenantRun =
  (orgId: string, userId: string): RunAudit =>
  (fn) =>
    withTenant({ orgId, userId }, fn);
