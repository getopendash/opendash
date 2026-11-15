// Routines' and checks' tests: a learned demo source with its pack verified, its workspace's people, and
// a metric's checks run as the dispatcher would.
import { uuidv7 } from "@opendash/db";
import {
  type CheckGrain,
  type CheckResult,
  checkDefinitions,
  demoPack,
  installDefinitions,
  listDefinitions,
  runCheck,
  verifyDefinitions,
} from "../../src";
import { type LearnedSource, learnedSource } from "./learned-source";

/** The demo source, learned, with the demo pack's definitions checked and verified; their ids by slug. */
export async function verifiedSource(
  now: Date,
  options: Parameters<typeof learnedSource>[0] = {},
): Promise<{ s: LearnedSource; ids: Record<string, string> }> {
  const s = await learnedSource(options);
  const ctx = { orgId: s.orgId, userId: s.userId };
  await s.tenant((tx) =>
    installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx,
      list.map((d) => d.id),
    ),
  );
  return { s, ids: Object.fromEntries(list.map((d) => [d.slug, d.id])) };
}

/** Who acts: the source's owner (owners and admins manage), or someone else in the workspace. */
export const actor = (s: LearnedSource, userId = s.userId, canManage = true) => ({
  orgId: s.orgId,
  userId,
  canManage,
});

/** What the check and run jobs are given: the gateway's, the queue, and (never used without a model) the keys. */
export const jobDeps = (s: LearnedSource) => ({
  ...s.deps,
  boss: s.boss,
  deploymentKeys: { anthropic: true } as never,
});

/** A member of the workspace, who can get email (a verified address). */
export async function member(s: LearnedSource, userId: string, email: string, role = "member", verified = true) {
  await s.t.owner`insert into auth.user (id, name, email, email_verified)
    values (${userId}, ${email.split("@")[0] as string}, ${email}, ${verified})
    on conflict (id) do update set name = excluded.name, email = excluded.email, email_verified = excluded.email_verified`;
  // The source's own user is already its owner (learnedSource): this sets their role.
  await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${userId}, ${role}, now())
    on conflict (organization_id, user_id) do update set role = excluded.role`;
}

/** The metric's check by this period, or null when nothing watches it so. */
export async function checkOf(s: LearnedSource, metricId: string, grain: CheckGrain): Promise<string | null> {
  const [c] = await s.t.owner<{ id: string }[]>`
    select id from app.metric_check where org_id = ${s.orgId} and metric_id = ${metricId} and grain = ${grain}
      and deleted_at is null`;
  return c?.id ?? null;
}

/** Runs a metric's check now, as its job would. */
export async function check(s: LearnedSource, metricId: string, grain: CheckGrain, now: Date): Promise<CheckResult> {
  const checkId = await checkOf(s, metricId, grain);
  if (!checkId) throw new Error(`Nothing checks ${metricId} by ${grain}`);
  return runCheck(jobDeps(s), { orgId: s.orgId, checkId }, now);
}
