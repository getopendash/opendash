/**
 * The audit log's writer (the open-source core): one row per security-relevant action. Called inside the action's own
 * transaction, so a row exists exactly when the action committed. Field names only, never values: `detail` takes the
 * small typed facts in AuditDetail and refuses anything that looks like a secret or free text.
 */
import { type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { AuditAction, AuditDetail, AuditTargetType } from "./actions";

export type AuditActorType = "user" | "api_key" | "scim" | "slack" | "system";

export interface AuditActor {
  type: AuditActorType;
  id?: string | null;
  /** Who it was when it happened (a person's name, a key's name, "Okta"), so the row still reads after they leave. */
  name?: string | null;
}

export interface AuditEvent<A extends AuditAction = AuditAction> {
  action: A;
  /**
   * Who did it. In a tenant transaction it may be left out: the transaction's own user is the actor then (the system
   * when it has none), with their name as a member of the organization.
   */
  actor?: AuditActor;
  target?: { type: AuditTargetType; id?: string | null; name?: string | null };
  /** The names of the fields that changed. */
  fields?: string[];
  detail?: AuditDetail[A];
  /** Sign-in events only: where the request came from. */
  ip?: string | null;
  userAgent?: string | null;
}

export class AuditDetailError extends Error {
  override name = "AuditDetailError";
}

const FIELD = /^[a-z][a-zA-Z0-9_.]{0,63}$/;
/** Keys a detail never carries, whatever the action says. */
const SECRETISH = /(secret|password|passwd|token|credential|apikey|api_key|private|cookie|session_id|authorization)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A detail is a flat object of short scalars (or a short list of them): a role, a kind, a count. Nested objects, long
 * strings and secret-looking keys are refused, so a careless call site can't log a value.
 */
export function checkedDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (SECRETISH.test(key)) throw new AuditDetailError(`audit detail key "${key}" looks like a secret`);
    const scalar = (v: unknown) =>
      v === null ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      (typeof v === "string" && v.length <= 64);
    if (Array.isArray(value)) {
      if (value.length > 20 || !value.every(scalar))
        throw new AuditDetailError(`audit detail "${key}" isn't a short list`);
    } else if (!scalar(value)) {
      throw new AuditDetailError(`audit detail "${key}" isn't a short scalar`);
    }
    out[key] = value;
  }
  return out;
}

function row(event: AuditEvent) {
  const fields = [...new Set(event.fields ?? [])];
  // Checked before it's spliced into the array literal below: letters, digits, _ and . only.
  for (const f of fields) if (!FIELD.test(f)) throw new AuditDetailError(`audit field "${f}" isn't a field name`);
  const id = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);
  return {
    id: uuidv7(),
    actorType: event.actor?.type ?? null,
    actorId: id(event.actor?.id),
    actorName: event.actor?.name?.slice(0, 200) ?? null,
    action: event.action,
    targetType: event.target?.type ?? null,
    targetId: id(event.target?.id),
    targetName: event.target?.name?.slice(0, 200) ?? null,
    fields,
    detail: checkedDetail(event.detail as Record<string, unknown> | undefined),
    ip: event.ip?.trim() || null,
    userAgent: event.userAgent?.slice(0, 400) ?? null,
  };
}

/**
 * Records an action of the organization in `tx`'s tenant context, in that transaction. A person named only by id gets
 * their name from the organization's member list (app.member_recipient).
 */
export async function audit<A extends AuditAction>(tx: TenantTx, event: AuditEvent<A>): Promise<void> {
  const r = row(event);
  await tx.execute(sql`
    insert into app.audit_log (id, org_id, actor_type, actor_id, actor_name, action, target_type, target_id,
                               target_name, fields, detail, ip, user_agent)
    select ${r.id}, app.org_id(),
           coalesce(${r.actorType}::text, case when a.actor_id is null then 'system' else 'user' end), a.actor_id,
           coalesce(${r.actorName}::text, (select m.name from app.member_recipient(a.actor_id) m)),
           ${r.action}, ${r.targetType}, ${r.targetId}::uuid, ${r.targetName},
           ${`{${r.fields.join(",")}}`}::text[], ${JSON.stringify(r.detail)}::jsonb, ${r.ip}::inet, ${r.userAgent}
    from (select coalesce(${r.actorId}::uuid, case when ${r.actorType}::text is null then app.user_id() end) as actor_id) a`);
}

/**
 * Records an action as the system role, for writers with no tenant transaction of their own: Better Auth's hooks
 * (sign-in, members, keys), which run after its commit, and the worker.
 */
export async function auditSystem<A extends AuditAction>(
  tx: SystemTx,
  orgId: string,
  event: AuditEvent<A> & { actor: AuditActor },
): Promise<void> {
  if (!UUID.test(orgId)) throw new AuditDetailError("orgId must be a uuid");
  const r = row(event);
  await tx.execute(sql`
    insert into app.audit_log (id, org_id, actor_type, actor_id, actor_name, action, target_type, target_id,
                               target_name, fields, detail, ip, user_agent)
    values (${r.id}, ${orgId}, ${r.actorType}, ${r.actorId}, ${r.actorName}, ${r.action}, ${r.targetType},
            ${r.targetId}, ${r.targetName}, ${`{${r.fields.join(",")}}`}::text[], ${JSON.stringify(r.detail)}::jsonb,
            ${r.ip}::inet, ${r.userAgent})`);
}
