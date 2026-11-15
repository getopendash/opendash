import "server-only";
import { listThreadPage } from "@opendash/core";
import { type TenantTx, withTenant } from "@opendash/db";
import { withAuthors } from "./ask";
import { filtersOf, type HistoryParams, PAGE_SIZE } from "./ask-filters";

const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };

/** One page of the conversations list for these settings, with who started each conversation and how many match. */
export async function historyFor(orgId: string, userId: string, p: HistoryParams) {
  const page = await listThreadPage(
    deps,
    { orgId, userId },
    { ...filtersOf(p), limit: PAGE_SIZE, offset: (p.page - 1) * PAGE_SIZE },
  );
  return { threads: await withAuthors(orgId, page.threads), total: page.total };
}
