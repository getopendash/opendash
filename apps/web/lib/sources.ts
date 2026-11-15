import "server-only";
import {
  type ConnectionTestView,
  getSource as coreGetSource,
  listSources as coreListSources,
  createBoss,
  createSecretStore,
  getSyncRun,
  kekFromEnv,
  latestConnectionTest,
  type SecretStore,
  type SourceSummary,
  type SyncRunView,
} from "@opendash/core";
import { type TenantCtx, withTenant } from "@opendash/db";
import { cache } from "react";

export type { SourceSummary };

/**
 * Server-side plumbing for connecting sources: the secret store and the pg-boss producer. Both are process-wide and
 * survive dev reloads (globalThis), so a hot reload doesn't open another pool.
 */
type Producer = ReturnType<typeof createBoss>;
const shared = globalThis as unknown as { openDashQueue?: Promise<Producer>; openDashSecrets?: SecretStore };

export function secretStore(): SecretStore {
  shared.openDashSecrets ??= createSecretStore({ kek: () => kekFromEnv() });
  return shared.openDashSecrets;
}

/** The producer: enqueues inside tenant transactions; it never runs jobs (workers do). */
export function queue(): Promise<Producer> {
  shared.openDashQueue ??= (async () => {
    const url = process.env.DATABASE_QUEUE_URL;
    if (!url) throw new Error("Set DATABASE_QUEUE_URL (opendash_queue) so the web app can queue work.");
    const boss = createBoss(url, "producer");
    await boss.start();
    return boss;
  })().catch((error: unknown) => {
    shared.openDashQueue = undefined;
    throw error;
  });
  return shared.openDashQueue;
}

/** Only owners and admins connect or change sources; everyone in the org can see them. */
export const canManageSources = (role: string) => role === "owner" || role === "admin";

/** OpenDash Cloud's fixed outbound addresses, shown next to the connection form so they can be allowlisted. */
export const egressAddresses = () =>
  (process.env.OPENDASH_EGRESS_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

/** The org's live sources with their status. */
export function listSources(ctx: TenantCtx): Promise<SourceSummary[]> {
  return withTenant(ctx, (tx) => coreListSources(tx, ctx.orgId));
}

/** One live source, or null. */
export function getSource(ctx: TenantCtx, id: string): Promise<SourceSummary | null> {
  return withTenant(ctx, (tx) => coreGetSource(tx, ctx.orgId, id));
}

export interface SourcePageData {
  source: SourceSummary;
  /** The latest learning run. */
  run: SyncRunView | null;
  /** The latest connection check. */
  test: ConnectionTestView | null;
}

/** What a source's pages share (the layout's header and top bar, then the tab): loaded once per request. */
export const sourcePage = cache(async (orgId: string, userId: string, id: string): Promise<SourcePageData | null> => {
  const ctx = { orgId, userId };
  const source = await getSource(ctx, id);
  if (!source) return null;
  const [run, test] = await withTenant(ctx, (tx) =>
    Promise.all([
      source.syncRunId ? getSyncRun(tx, orgId, source.syncRunId) : null,
      latestConnectionTest(tx, orgId, source.id),
    ]),
  );
  return { source, run, test };
});
