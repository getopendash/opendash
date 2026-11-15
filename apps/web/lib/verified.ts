import "server-only";
import { getRun, getVerifiedQuery, listDefinitions, listVerifiedQueries } from "@opendash/core";
import { type TenantTx, withTenant } from "@opendash/db";
import { teamOf } from "./team";

/** People's names by user id, for "verified by". */
const namesOf = async (orgId: string) =>
  Object.fromEntries((await teamOf(orgId)).members.map((m) => [m.userId, m.name]));

/** Metric titles by slug, for what a verified query computes. */
const metricTitles = (orgId: string) =>
  withTenant({ orgId }, async (tx) =>
    Object.fromEntries(
      (await listDefinitions(tx, orgId, {})).filter((d) => d.kind === "metric").map((d) => [d.slug, d.title] as const),
    ),
  );

/** The verified queries, with who verified each and what its metrics are called. */
export async function verifiedListFor(orgId: string) {
  const [items, names, titles] = await Promise.all([
    withTenant({ orgId }, (tx) => listVerifiedQueries(tx, orgId)),
    namesOf(orgId),
    metricTitles(orgId),
  ]);
  return items.map((v) => ({
    ...v,
    verifiedByName: v.verifiedBy ? (names[v.verifiedBy] ?? "a former member") : null,
    metricTitles: v.metrics.map((m) => titles[m] ?? m),
  }));
}

/** One verified query, and the conversation it came from when this person can see it. */
export async function verifiedFor(orgId: string, userId: string, id: string) {
  const [v, names, titles] = await Promise.all([
    withTenant({ orgId }, (tx) => getVerifiedQuery(tx, orgId, id)),
    namesOf(orgId),
    metricTitles(orgId),
  ]);
  if (!v) return null;
  const deps = { withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId: org }, fn) };
  const run = await getRun(deps, { orgId, userId }, v.spec.from.runId);
  return { ...v, names, titles, threadId: run?.thread_id ?? null };
}
