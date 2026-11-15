/**
 * A source's query limits (Settings → Query limits): how many queries run on it at once, how long one may run, and how many
 * rows one reads. They protect the customer's database and are shared by everything that queries it. Admins can
 * only tighten them: each is clamped to the gateway's own budget (budgets.ts), so the time budgets' inequalities
 * hold whatever is stored (connection.limits).
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";

export interface SourceLimits {
  /** Queries at once, per worker process. */
  parallel: number;
  statementMs: number;
  maxRows: number;
}

export const LIMIT_RANGES: Record<keyof SourceLimits, { min: number; max: number }> = {
  parallel: { min: 1, max: BUDGETS.gateway.perConnection },
  statementMs: { min: 5_000, max: BUDGETS.gateway.statementMs },
  maxRows: { min: 10, max: BUDGETS.gateway.maxRows },
};

const clamp = (value: unknown, { min, max }: { min: number; max: number }) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : max;

/** The limits that apply, from what's stored: anything missing or out of range falls back to the budget's. */
export function effectiveLimits(stored: unknown): SourceLimits {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<Record<keyof SourceLimits, unknown>>;
  return {
    parallel: clamp(s.parallel, LIMIT_RANGES.parallel),
    statementMs: clamp(s.statementMs, LIMIT_RANGES.statementMs),
    maxRows: clamp(s.maxRows, LIMIT_RANGES.maxRows),
  };
}

export type LimitErrors = Partial<Record<keyof SourceLimits, string>>;

/** Stores a source's limits after checking each is a whole number within its range. */
export async function setSourceLimits(
  tx: TenantTx,
  ctx: { orgId: string },
  connectionId: string,
  limits: SourceLimits,
): Promise<{ ok: true } | { ok: false; errors?: LimitErrors; reason?: "not_found" }> {
  const errors: LimitErrors = {};
  for (const key of Object.keys(LIMIT_RANGES) as (keyof SourceLimits)[]) {
    const v = limits?.[key];
    const { min, max } = LIMIT_RANGES[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors[key] = key === "statementMs" ? `${min / 1000} to ${max / 1000} seconds` : `${min} to ${max}`;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (!isUuid(connectionId)) return { ok: false, reason: "not_found" };
  const rows = await tx.execute<{ id: string; name: string; dialect: string }>(sql`
    update app.connection set limits = ${JSON.stringify({
      parallel: limits.parallel,
      statementMs: limits.statementMs,
      maxRows: limits.maxRows,
    })}::jsonb, updated_at = now()
    where org_id = ${ctx.orgId} and id = ${connectionId} and deleted_at is null
    returning id, name, dialect`);
  const [c] = rows;
  if (!c) return { ok: false, reason: "not_found" };
  await audit(tx, {
    action: "source.updated",
    target: { type: "connection", id: connectionId, name: c.name },
    fields: ["limits"],
    detail: { dialect: c.dialect },
  });
  return { ok: true };
}
