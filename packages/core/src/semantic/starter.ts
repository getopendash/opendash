/**
 * The starter pack: when a source is learned for the first time, OpenDash proposes definitions for it, tests them
 * against the data, and an admin approves what's right. For now only the sample company has a pack (a curated one,
 * semantic/packs/demo.ts); for other sources the Modeler drafts one later.
 */

import { type SystemTx, sql, type TenantTx } from "@opendash/db";
import { demoGlossary } from "@opendash/evals";
import type { PgBoss } from "pg-boss";
import { ContextProblem, saveTerm } from "../context/items";
import { enqueueOnce } from "../jobs/boss";
import { definitionChecksQueue } from "../jobs/queues";
import { installDefinitions } from "./definitions";
import { demoPack } from "./packs/demo";

/**
 * Proposes the sample company's pack for a sample source that has no definitions yet, and queues its checks.
 * Returns how many definitions were proposed (0 when the source isn't the sample, or already has some).
 */
export async function proposeStarterPack(
  deps: { boss: PgBoss },
  tx: TenantTx,
  job: { orgId: string; connectionId: string },
): Promise<number> {
  const [c] = await tx.execute<{
    dialect: "postgres" | "clickhouse" | "mysql";
    config: { sample?: boolean; database?: string };
    has: boolean;
  }>(sql`
    select c.dialect, c.config,
      exists (select 1 from app.context_item i where i.org_id = c.org_id and i.connection_id = c.id) as has
    from app.connection c
    where c.org_id = ${job.orgId} and c.id = ${job.connectionId} and c.deleted_at is null`);
  if (c?.config.sample !== true || c.has) return 0;
  // The sample's schemas are public, billing and support. On ClickHouse and MySQL they're databases, which may share a
  // prefix (the default database is <prefix>public).
  const prefix = c.dialect === "postgres" ? "" : (c.config.database ?? "").replace(/public$/, "");
  const pack = demoPack(c.dialect, {
    public: `${prefix}public`,
    billing: `${prefix}billing`,
    support: `${prefix}support`,
  });
  const added = await installDefinitions(tx, { orgId: job.orgId, userId: null }, job.connectionId, pack, {
    status: "proposed",
    source: "pack",
  });
  // The sample company's words, proposed with its definitions: an admin approves them in Glossary. A
  // term that's already there, or whose column this source doesn't have, is skipped (both are checks, not errors).
  if (added) {
    for (const body of demoGlossary(`${prefix}public`)) {
      try {
        await saveTerm(
          tx,
          { orgId: job.orgId, userId: null },
          { body, connectionId: job.connectionId, proposed: true },
        );
      } catch (error) {
        if (!(error instanceof ContextProblem)) throw error;
      }
    }
  }
  // In the same transaction: the pack and its checks are proposed together, or not at all.
  if (added) await enqueueOnce(deps.boss, tx, definitionChecksQueue, job, { singletonKey: job.connectionId });
  return added;
}

/**
 * The same, for sample sources learned before starter packs existed (or whose proposal was missed): every few
 * minutes, the scheduler proposes the pack for a learned sample source that has never had definitions. Proposing is
 * idempotent, so a source taken twice gets one pack.
 */
export async function proposeMissingStarterPacks(deps: {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  boss: PgBoss;
}): Promise<number> {
  const missing = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select c.org_id, c.id from app.connection c
      where c.deleted_at is null and (c.config->>'sample')::boolean is true
        and exists (select 1 from app.sync_run s where s.org_id = c.org_id and s.connection_id = c.id
                    and s.status = 'succeeded')
        and not exists (select 1 from app.context_item i where i.org_id = c.org_id and i.connection_id = c.id)
      limit 20`),
  );
  let proposed = 0;
  for (const c of missing) {
    const added = await deps.withTenant(c.org_id, (tx) =>
      proposeStarterPack({ boss: deps.boss }, tx, { orgId: c.org_id, connectionId: c.id }),
    );
    if (added) proposed += 1;
  }
  return proposed;
}

/**
 * After a source is learned again, its definitions are tested again (their latest values, which Home and their pages
 * show, move with the data). Nothing to do for a source without definitions. Its own key, so a waiting check of what
 * changed doesn't swallow it.
 */
export async function refreshDefinitionChecks(
  deps: { boss: PgBoss },
  tx: TenantTx,
  job: { orgId: string; connectionId: string },
): Promise<boolean> {
  const [has] = await tx.execute<{ yes: boolean }>(sql`
    select exists (select 1 from app.context_item i
      where i.org_id = ${job.orgId} and i.connection_id = ${job.connectionId} and i.deleted_at is null) as yes`);
  if (!has?.yes) return false;
  const id = await enqueueOnce(
    deps.boss,
    tx,
    definitionChecksQueue,
    { ...job, all: true },
    {
      singletonKey: `${job.connectionId}:refresh`,
    },
  );
  return id !== null;
}
