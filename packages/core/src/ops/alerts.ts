/**
 * Alerts: something that needs a person, as a row. One
 * open alert per kind and subject, for an organization or the deployment (no organization); raising it again adds to
 * its count. Each new one is also a log line at error level, which is what a host pages on, and an alert_raised event
 * where product analytics is on (./analytics). Written by the system
 * (the dispatcher, dead-letter handlers); an organization reads its own through the tenant policy, and no tenant ever
 * reads the deployment's.
 */
import { type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { track } from "./analytics";
import { type Logger, logger } from "./log";

export type AlertKind = "stuck_run" | "lost_job" | "dead_letter" | "partitions_missing" | "spend";

export interface SystemDeps {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  log?: Logger;
}

export interface AlertInput {
  /** The organization it's about; null for the deployment. */
  orgId: string | null;
  kind: AlertKind;
  subject: string;
  /** For people: what happened, and what to do. Never secrets, query text or values. */
  message: string;
  detail?: Record<string, unknown>;
}

const NIL = "00000000-0000-0000-0000-000000000000";

/** Raises an alert, or adds to the open one of its kind and subject. Logs it when it's new. */
export async function raiseAlert(
  deps: SystemDeps,
  input: AlertInput,
  now: Date = new Date(),
): Promise<{ id: string; created: boolean }> {
  const [row] = await deps.withSystem((tx) =>
    tx.execute<{ id: string; created: boolean }>(sql`
      insert into app.ops_alert (id, org_id, kind, subject, message, detail, first_seen_at, last_seen_at)
      values (${uuidv7()}, ${input.orgId}, ${input.kind}, ${input.subject}, ${input.message},
        ${JSON.stringify(input.detail ?? {})}::jsonb, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      on conflict (coalesce(org_id, ${NIL}::uuid), kind, subject) where resolved_at is null
      do update set count = app.ops_alert.count + 1, last_seen_at = excluded.last_seen_at,
        message = excluded.message, detail = excluded.detail
      returning id, (xmax = 0) as created`),
  );
  if (row?.created) {
    (deps.log ?? logger).error("alert", {
      kind: input.kind,
      subject: input.subject,
      orgId: input.orgId,
      message: input.message,
      ...input.detail,
    });
    // Product analytics, where it's on: that one was raised, its kind and subject (a queue, a run, a table), never
    // its message. Not waited on.
    void track({
      event: "alert_raised",
      userId: null,
      orgId: input.orgId,
      properties: { kind: input.kind, subject: input.subject },
    });
  }
  return { id: row?.id ?? "", created: Boolean(row?.created) };
}

/** Resolves the open alerts of a kind whose subject no longer holds (all of them, with `holding` empty). */
export async function resolveAlerts(
  deps: SystemDeps,
  kind: AlertKind,
  holding: string[],
  now: Date = new Date(),
): Promise<number> {
  const rows = await deps.withSystem((tx) =>
    tx.execute<{ id: string }>(sql`
      update app.ops_alert set resolved_at = ${now.toISOString()}::timestamptz
      where kind = ${kind} and resolved_at is null
        and subject not in (select jsonb_array_elements_text(${JSON.stringify(holding)}::jsonb))
      returning id`),
  );
  return rows.length;
}

/**
 * A job reached its dead-letter queue: its handler has failed the job's domain row, and this tells someone.
 * The job's organization, when it has one, makes it that organization's alert; otherwise it's the deployment's.
 */
export function deadLettered(
  deps: SystemDeps,
  input: { queue: string; orgId?: string | null; message: string; detail?: Record<string, unknown> },
  now: Date = new Date(),
) {
  return raiseAlert(
    deps,
    {
      orgId: input.orgId ?? null,
      kind: "dead_letter",
      subject: input.queue,
      message: input.message,
      detail: { queue: input.queue, ...input.detail },
    },
    now,
  );
}

export interface AlertView {
  id: string;
  kind: AlertKind;
  subject: string;
  message: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

/** An organization's alerts (Settings → Health): open ones, then those resolved in the last 7 days. */
export async function orgAlerts(tx: TenantTx, orgId: string): Promise<AlertView[]> {
  const rows = await tx.execute<{
    id: string;
    kind: AlertKind;
    subject: string;
    message: string;
    count: number;
    first_seen_at: string;
    last_seen_at: string;
    resolved_at: string | null;
  }>(sql`
    select id, kind, subject, message, count, first_seen_at, last_seen_at, resolved_at from app.ops_alert
    where org_id = ${orgId} and (resolved_at is null or resolved_at > now() - interval '7 days')
    order by resolved_at is not null, last_seen_at desc limit 100`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    message: r.message,
    count: r.count,
    firstSeenAt: iso(r.first_seen_at) as string,
    lastSeenAt: iso(r.last_seen_at) as string,
    resolvedAt: iso(r.resolved_at),
  }));
}
