import "server-only";
import type { ThreadListing } from "@opendash/api";
import { getAuthDatabase, memberNames } from "@opendash/auth";
import { getThread, type ThreadSummary } from "@opendash/core";
import { type TenantTx, withTenant } from "@opendash/db";
import { cache } from "react";

/** The run ledger's reads from a server component: tenant-scoped like every database access. */
const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };

/** A conversation the viewer can see, or null; loaded once per request (metadata and page). */
export const threadFor = cache((orgId: string, userId: string, threadId: string) =>
  getThread(deps, { orgId, userId }, threadId),
);

/** Adds who started each conversation someone else started (names live on the auth side). */
export async function withAuthors(orgId: string, threads: ThreadSummary[]): Promise<ThreadListing[]> {
  const others = [...new Set(threads.filter((t) => !t.mine && t.createdBy).map((t) => t.createdBy as string))];
  const names = others.length ? await memberNames(getAuthDatabase(), orgId, others) : {};
  return threads.map((t) => ({ ...t, author: !t.mine && t.createdBy ? (names[t.createdBy] ?? null) : null }));
}
