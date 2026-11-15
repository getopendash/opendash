/**
 * Reading the audit log for Settings → Audit log (owners and admins; the caller checks the role). Newest first, paged
 * by id, filtered by person, group of actions and date range.
 */
import { sql, type TenantTx, uuidv7Floor } from "@opendash/db";
import { type AuditCategory, actionsIn } from "./actions";

export interface AuditRow {
  id: string;
  createdAt: Date;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  fields: string[];
  detail: Record<string, unknown>;
  ip: string | null;
  sealed: boolean;
}

export interface AuditFilter {
  /** A person (their user id), or every actor. */
  actorId?: string | null;
  category?: AuditCategory | null;
  /** The range's start. */
  since: Date;
  /** The page before this row's id (the "Older" link). */
  before?: string | null;
  limit?: number;
}

const PAGE = 50;

export async function listAudit(
  tx: TenantTx,
  filter: AuditFilter,
): Promise<{ rows: AuditRow[]; older: string | null }> {
  const limit = Math.min(filter.limit ?? PAGE, 200);
  const actions = filter.category ? actionsIn(filter.category) : null;
  const rows = await tx.execute<{
    id: string;
    created_at: string;
    actor_type: string;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    target_name: string | null;
    fields: string[];
    detail: Record<string, unknown>;
    ip: string | null;
    sealed: boolean;
  }>(sql`
    select id, created_at, actor_type, actor_id, actor_name, action, target_type, target_id, target_name, fields,
           detail, host(ip) as ip, hash is not null as sealed
    from app.audit_log
    where id >= ${uuidv7Floor(filter.since)}::uuid and created_at >= ${filter.since.toISOString()}::timestamptz
      ${filter.actorId ? sql`and actor_id = ${filter.actorId}` : sql``}
      ${actions ? sql`and action = any(${`{${actions.join(",")}}`}::text[])` : sql``}
      ${filter.before ? sql`and id < ${filter.before}` : sql``}
    order by id desc
    limit ${limit + 1}`);
  const page = rows.slice(0, limit).map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at),
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetName: r.target_name,
    fields: r.fields ?? [],
    detail: r.detail ?? {},
    ip: r.ip,
    sealed: r.sealed,
  }));
  return { rows: page, older: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

/** The people who appear in the range, for the page's "Who" filter: the newest name each was recorded under. */
export async function auditActors(tx: TenantTx, since: Date): Promise<{ id: string; name: string }[]> {
  const rows = await tx.execute<{ id: string; name: string | null }>(sql`
    select distinct on (actor_id) actor_id as id, actor_name as name
    from app.audit_log
    where id >= ${uuidv7Floor(since)}::uuid and actor_id is not null and created_at >= ${since.toISOString()}::timestamptz
    order by actor_id, id desc`);
  return rows.map((r) => ({ id: r.id, name: r.name ?? "Someone" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** How many rows are in the range, for the page's footer. */
export async function countAudit(
  tx: TenantTx,
  since: Date,
  filter: Pick<AuditFilter, "actorId" | "category"> = {},
): Promise<number> {
  const actions = filter.category ? actionsIn(filter.category) : null;
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.audit_log
    where id >= ${uuidv7Floor(since)}::uuid and created_at >= ${since.toISOString()}::timestamptz
      ${filter.actorId ? sql`and actor_id = ${filter.actorId}` : sql``}
      ${actions ? sql`and action = any(${`{${actions.join(",")}}`}::text[])` : sql``}`);
  return row?.n ?? 0;
}
