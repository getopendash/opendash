/**
 * The context graph in the worker: every minute, each organization whose knowledge changed since its graph
 * was projected (or with a learning under way) gets its graph rebuilt, one job an organization at a time.
 */
import {
  type GraphProjectJob,
  graphDispatchDeadLetter,
  graphDispatchQueue,
  graphProjectDeadLetter,
  graphProjectQueue,
  graphsDue,
  projectGraph,
} from "@opendash/core";
import type { SystemTx, TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";

export interface GraphCtx {
  boss: PgBoss;
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

export async function startGraph(ctx: GraphCtx): Promise<void> {
  const { boss } = ctx;
  await boss.work(graphDispatchQueue.name, async () => {
    const due = await ctx.withSystem((tx) => graphsDue(tx));
    for (const orgId of due) {
      await boss.send(graphProjectQueue.name, { orgId } satisfies GraphProjectJob, { singletonKey: orgId });
    }
  });
  await boss.schedule(graphDispatchQueue.name, "* * * * *");
  await boss.work(graphDispatchDeadLetter.name, async () => {
    ctx.log("graph dispatch dead-lettered; the next minute picks up what's due");
  });

  await boss.work<GraphProjectJob>(graphProjectQueue.name, async ([job]) => {
    if (!job) return;
    const { orgId } = job.data;
    await ctx.withTenant(orgId, (tx) => projectGraph(tx, orgId));
  });
  await boss.work<GraphProjectJob>(graphProjectDeadLetter.name, async ([job]) => {
    ctx.log("graph projection dead-lettered; the next change projects it again", { orgId: job?.data.orgId });
  });
}
