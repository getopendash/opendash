/**
 * Routines: making, changing, pausing and listing them, and keeping the engine's metric checks in
 * step with what active routines watch. Anyone makes a routine that only tells themselves; owners and admins make the
 * rest (other people, channels, the workspace's Watching). Everything a spec names is checked when it's saved, and
 * again when it runs.
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { audit } from "../audit/write";
import type { CheckState } from "../checks/check";
import { insightReadableBy } from "../checks/insights";
import { grainsFor, type WatchableMetric, watchableMetrics } from "../checks/metrics";
import { displayMetric, type MetricFormat } from "../figures/metric";
import { enqueue, enqueueOnce } from "../jobs/boss";
import { metricCheckQueue, routineRunQueue } from "../jobs/queues";
import { threadReadableBy } from "../projects/access";
import { lockFor } from "../tenancy/locks";
import {
  type CheckGrain,
  checkHourFrom,
  isTimeZone,
  localTimeOn,
  nextCheckAt,
  nextOccurrence,
  ROUNDUP_AT,
} from "./schedule";
import { routineSentence, type SentencePart, sentenceText } from "./sentence";
import {
  asksOpenDash,
  type FoundSpec,
  needsManager,
  OWNER_CANT_REACH,
  RoutineSpec,
  SENSITIVITY,
  SlackDestination,
  VIEWERS_DONT_ASK,
  WATCHING_KEY,
} from "./spec";

export class RoutineProblem extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

/** Who's acting: owners and admins manage. */
export interface Actor {
  orgId: string;
  userId: string;
  canManage: boolean;
}

export interface RoutineInput {
  spec: unknown;
  /** The people it emails: members of the workspace. */
  userIds: string[];
  slack?: SlackDestination[];
  /** A name, for a routine that watches. */
  name?: string | null;
}

/** People a routine emails at most. */
export const MAX_RECIPIENTS = 50;
/** Slack channels a routine posts to at most. */
export const MAX_CHANNELS = 10;
/** The routines a workspace runs at most: the dispatcher shares its ticks between workspaces, and this bounds one. */
export const MAX_ROUTINES = 200;
/** The routines one person keeps at most, so no one member fills the workspace's room with ones only they can delete. */
export const MAX_ROUTINES_EACH = 50;

/**
 * Room for one more active routine of `ownerId`'s: the workspace's active routines (a paused one, as a member's who
 * left, doesn't count) and the person's own, paused or not. Under the workspace's lock, so two saves at once can't
 * both pass. `except` is the routine being resumed, already counted as theirs.
 */
async function roomForRoutine(tx: TenantTx, orgId: string, ownerId: string, except?: string): Promise<void> {
  await lockFor(tx, `routines:${orgId}`);
  const [n] = await tx.execute<{ active: number; theirs: number }>(sql`
    select count(*) filter (where status = 'active')::int as active,
      count(*) filter (where owner_id = ${ownerId})::int as theirs
    from app.routine
    where org_id = ${orgId} and deleted_at is null and id is distinct from ${except ?? null}::uuid`);
  if ((n?.active ?? 0) >= MAX_ROUTINES) {
    throw new RoutineProblem(
      "invalid",
      `A workspace runs ${MAX_ROUTINES} routines at most: pause or delete one first.`,
    );
  }
  if ((n?.theirs ?? 0) >= MAX_ROUTINES_EACH) {
    throw new RoutineProblem(
      "invalid",
      `Each person keeps ${MAX_ROUTINES_EACH} routines at most: delete one that isn't needed first.`,
    );
  }
}
/** Failed runs in a row before a routine pauses itself and says why. */
export const FAILURES_TO_PAUSE = 4;

export interface RoutineRunView {
  id: string;
  triggerKey: string;
  status: "queued" | "running" | "writing" | "waiting" | "sending" | "delivered" | "failed" | "skipped";
  at: string;
  dueAt: string | null;
  error: string | null;
  /** A scheduled question's answer, where it is: the conversation (when the viewer may read it) and the run. */
  answer: { threadId: string; runId: string } | null;
  insightIds: string[];
}

export interface RoutineView {
  id: string;
  key: string | null;
  name: string | null;
  ownerId: string;
  trigger: "schedule" | "found";
  spec: RoutineSpec;
  userIds: string[];
  slack: SlackDestination[];
  status: "active" | "paused";
  pausedReason: string | null;
  nextRunAt: string | null;
  createdAt: string;
  /** The routine as one sentence, for this viewer ("to me"). */
  sentence: SentencePart[];
  /** Whether the viewer may change it. */
  canEdit: boolean;
  lastRun: RoutineRunView | null;
}

type RoutineRow = {
  id: string;
  key: string | null;
  name: string | null;
  owner_id: string;
  trigger: "schedule" | "found";
  spec: RoutineSpec;
  user_ids: string[];
  slack: SlackDestination[];
  status: "active" | "paused";
  paused_reason: string | null;
  next_run_at: string | null;
  created_at: string;
  failure_streak: number;
};

/** The workspace's time zone: where its routines run and its metrics are checked. */
export async function orgTz(tx: TenantTx, orgId: string): Promise<string> {
  const [o] = await tx.execute<{ tz: string }>(sql`select tz from app.org where id = ${orgId}`);
  return o && isTimeZone(o.tz) ? o.tz : "UTC";
}

/** Everything a routine names, checked as it would run: the values it's saved with. */
async function validated(
  tx: TenantTx,
  actor: Actor,
  input: RoutineInput,
  existing: { key: string | null; ownerId: string } | null,
): Promise<{
  spec: RoutineSpec;
  userIds: string[];
  slack: SlackDestination[];
  name: string | null;
  metrics: WatchableMetric[];
}> {
  const parsed = RoutineSpec.safeParse(input.spec);
  if (!parsed.success) {
    throw new RoutineProblem("invalid", parsed.error.issues[0]?.message ?? "That routine isn't complete.");
  }
  const spec = parsed.data;
  const key = existing?.key ?? null;
  const ownerId = existing?.ownerId ?? actor.userId;
  if (!Array.isArray(input.userIds) || !input.userIds.every(isUuid)) {
    throw new RoutineProblem("invalid", "Pick people from the workspace.");
  }
  const userIds = [...new Set(input.userIds)];
  if (userIds.length > MAX_RECIPIENTS) {
    throw new RoutineProblem("invalid", `A routine emails ${MAX_RECIPIENTS} people at most.`);
  }
  const parsedSlack = (input.slack ?? []).map((d) => {
    const s = SlackDestination.safeParse(d);
    if (!s.success) throw new RoutineProblem("invalid", "Pick a Slack channel from the list.");
    return s.data;
  });
  const slack = parsedSlack.filter((c, i) => parsedSlack.findIndex((x) => x.channelId === c.channelId) === i);
  if (slack.length > MAX_CHANNELS) {
    throw new RoutineProblem("invalid", `A routine posts to ${MAX_CHANNELS} channels at most.`);
  }
  // The channels are the connected Slack workspace's (whether the bot is in each is checked with Slack before saving,
  // outside this transaction; a channel it left since fails at its next post).
  if (slack.length) {
    const [w] = await tx.execute<{ team_id: string; removed: boolean }>(sql`
      select team_id, removed_at is not null as removed from app.slack_workspace where org_id = ${actor.orgId}`);
    if (!w || w.removed) throw new RoutineProblem("invalid", "Connect Slack first, in Settings → Slack.");
    if (slack.some((c) => c.teamId !== w.team_id)) {
      throw new RoutineProblem("invalid", "Pick channels from the Slack workspace connected here.");
    }
  }
  if (key === null && !userIds.length && !slack.length) {
    throw new RoutineProblem("invalid", "Pick who it's for.");
  }
  if (key === WATCHING_KEY && (spec.trigger !== "found" || spec.condition.kind !== "unusual" || userIds.length)) {
    throw new RoutineProblem("invalid", "Watching keeps what's unusual in Insights; make a routine to tell people.");
  }
  if (needsManager({ key, ownerId, userIds, slack }) && !actor.canManage) {
    throw new RoutineProblem("forbidden", "Only owners and admins can make routines that reach other people.");
  }
  // It runs as its owner's, whoever saves or resumes it: one that reaches past them needs its owner to be an owner or
  // admin still, or its next run would only pause it again.
  if (needsManager({ key, ownerId, userIds, slack }) && ownerId !== actor.userId) {
    const [o] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${ownerId}) as role`);
    if (o?.role !== "owner" && o?.role !== "admin") throw new RoutineProblem("forbidden", OWNER_CANT_REACH);
  }
  // As its owner's: read live, the role a run would have.
  if (asksOpenDash(spec)) {
    const [r] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${ownerId}) as role`);
    if (r?.role === "viewer") throw new RoutineProblem("forbidden", VIEWERS_DONT_ASK);
  }
  for (const id of userIds) {
    const [member] = await tx.execute(sql`select 1 from app.member_recipient(${id})`);
    if (!member) throw new RoutineProblem("invalid", "Someone you picked isn't in the workspace any more.");
  }
  let metrics: WatchableMetric[] = [];
  if (spec.trigger === "schedule") {
    const a = spec.action;
    if (a.kind === "ask") {
      const [c] = await tx.execute(sql`
        select 1 from app.connection where org_id = ${actor.orgId} and id = ${a.connectionId} and deleted_at is null`);
      if (!c) throw new RoutineProblem("invalid", "That source doesn't exist any more.");
    }
  } else {
    metrics = await watchableMetrics(tx, actor.orgId, spec.metricIds);
    for (const id of spec.metricIds) {
      const m = metrics.find((x) => x.id === id);
      if (!m) throw new RoutineProblem("invalid", "Pick verified metrics.");
      if (!m.grain)
        throw new RoutineProblem("invalid", `${m.title} has no weeks or months to check: it needs a time field.`);
    }
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : null;
  return { spec, userIds, slack, name, metrics };
}

const nextRunOf = (spec: RoutineSpec, tz: string, now: Date) =>
  spec.trigger === "schedule" ? nextOccurrence(spec.rule, tz, now).toISOString() : null;

/** Where a routine reaches beyond its owner, for the audit log: other people by email, and Slack channels. */
const destinationsOf = (ownerId: string, userIds: string[], slack: unknown[]): string[] => [
  ...(userIds.some((u) => u !== ownerId) ? ["email"] : []),
  ...(slack.length ? ["slack"] : []),
];

/** Makes a routine. A scheduled one first runs at its next time; one that watches is checked on the next tick. */
export async function createRoutine(
  tx: TenantTx,
  actor: Actor,
  input: RoutineInput,
  now = new Date(),
): Promise<string> {
  const v = await validated(tx, actor, input, null);
  await roomForRoutine(tx, actor.orgId, actor.userId);
  const id = uuidv7();
  await tx.execute(sql`
    insert into app.routine (org_id, id, name, owner_id, trigger, spec, user_ids, slack, next_run_at)
    values (${actor.orgId}, ${id}, ${v.name}, ${actor.userId}, ${v.spec.trigger}, ${JSON.stringify(v.spec)}::jsonb,
      ${`{${v.userIds.join(",")}}`}::uuid[], ${JSON.stringify(v.slack)}::jsonb,
      ${nextRunOf(v.spec, await orgTz(tx, actor.orgId), now)})`);
  const reaches = destinationsOf(actor.userId, v.userIds, v.slack);
  if (reaches.length) {
    await audit(tx, {
      action: "routine.created",
      actor: { type: "user", id: actor.userId },
      target: { type: "routine", id, name: v.name },
      detail: { destinations: reaches },
    });
  }
  if (v.spec.trigger === "found") await reconcileChecks(tx, actor.orgId, now);
  return id;
}

/**
 * A routine that reaches only its owner (no key, no channel, nobody else): theirs alone. Nobody else lists, opens or
 * changes it, owners and admins included; they see how many there are (`othersPrivateCount`).
 */
const isPrivate = sql`(key is null and jsonb_array_length(slack) = 0
  and not exists (select 1 from unnest(user_ids) u where u <> owner_id))`;

async function loadForChange(tx: TenantTx, actor: Actor, id: string): Promise<RoutineRow> {
  const [r] = isUuid(id)
    ? await tx.execute<RoutineRow>(sql`
        select * from app.routine where org_id = ${actor.orgId} and id = ${id} and deleted_at is null
          and (owner_id = ${actor.userId} or not ${isPrivate})
        for update`)
    : [];
  if (!r) throw new RoutineProblem("not_found", "That routine doesn't exist.");
  if (r.owner_id !== actor.userId && !actor.canManage) {
    throw new RoutineProblem("forbidden", "Only its owner, or an owner or admin, can change it.");
  }
  return r;
}

/** Changes what a routine does or who it's for. Its next run is worked out again from now. */
export async function updateRoutine(
  tx: TenantTx,
  actor: Actor,
  id: string,
  input: RoutineInput,
  now = new Date(),
): Promise<void> {
  const r = await loadForChange(tx, actor, id);
  const v = await validated(tx, actor, input, { key: r.key, ownerId: r.owner_id });
  if (v.spec.trigger !== r.trigger) {
    throw new RoutineProblem("invalid", "A routine keeps its kind of trigger; make a new one instead.");
  }
  await tx.execute(sql`
    update app.routine set name = ${v.name ?? r.name}, spec = ${JSON.stringify(v.spec)}::jsonb,
      user_ids = ${`{${v.userIds.join(",")}}`}::uuid[], slack = ${JSON.stringify(v.slack)}::jsonb,
      next_run_at = ${r.status === "active" ? nextRunOf(v.spec, await orgTz(tx, actor.orgId), now) : r.next_run_at},
      updated_at = now()
    where org_id = ${actor.orgId} and id = ${r.id}`);
  // Recorded when it reaches outside, before or after: a change that stops it reaching out counts too.
  const before = destinationsOf(r.owner_id, r.user_ids, r.slack as unknown[]);
  const after = destinationsOf(r.owner_id, v.userIds, v.slack);
  if (before.length || after.length) {
    const changed = [
      ...(JSON.stringify([...r.user_ids].sort()) !== JSON.stringify([...v.userIds].sort()) ? ["recipients"] : []),
      ...(JSON.stringify(r.slack) !== JSON.stringify(v.slack) ? ["slack"] : []),
      ...(JSON.stringify(r.spec) !== JSON.stringify(v.spec) ? ["spec"] : []),
      ...((v.name ?? r.name) !== r.name ? ["name"] : []),
    ];
    await audit(tx, {
      action: "routine.updated",
      actor: { type: "user", id: actor.userId },
      target: { type: "routine", id: r.id, name: v.name ?? r.name },
      fields: changed,
      detail: { destinations: after },
    });
  }
  if (v.spec.trigger === "found") await reconcileChecks(tx, actor.orgId, now);
}

/**
 * Pauses or resumes a routine. Resumed, it starts afresh: its next time from now (the runs it missed don't run), its
 * failures forgotten.
 */
export async function setRoutineStatus(
  tx: TenantTx,
  actor: Actor,
  id: string,
  status: "active" | "paused",
  now = new Date(),
): Promise<void> {
  if (status !== "active" && status !== "paused") throw new RoutineProblem("invalid", "A routine is active or paused.");
  // The workspace's routine lock before the routine's row, as every change to its routines takes them (roomForRoutine,
  // watchMetric): never the other way round, which could deadlock against one.
  await lockFor(tx, `routines:${actor.orgId}`);
  const r = await loadForChange(tx, actor, id);
  if (r.status === status) return;
  // Resumed, it's checked as it would be saved: who may reach whom, and whether they can still open what it sends.
  if (status === "active") {
    await validated(
      tx,
      actor,
      { spec: r.spec, userIds: r.user_ids, slack: r.slack, name: r.name },
      { key: r.key, ownerId: r.owner_id },
    );
    await roomForRoutine(tx, actor.orgId, r.owner_id, r.id);
  }
  await tx.execute(sql`
    update app.routine set status = ${status}, updated_at = now(),
      paused_reason = null, failure_streak = ${status === "active" ? 0 : r.failure_streak},
      next_run_at = ${status === "active" ? nextRunOf(r.spec, await orgTz(tx, actor.orgId), now) : r.next_run_at}
    where org_id = ${actor.orgId} and id = ${r.id}`);
  if (r.trigger === "found") await reconcileChecks(tx, actor.orgId, now);
}

/** Deletes a routine. What it sent and found stays: editions in Reports, findings in Insights. */
export async function deleteRoutine(tx: TenantTx, actor: Actor, id: string, now = new Date()): Promise<void> {
  const r = await loadForChange(tx, actor, id);
  if (r.key === WATCHING_KEY)
    throw new RoutineProblem("invalid", "Watching is the workspace's own: stop watching its metrics instead.");
  await tx.execute(sql`
    update app.routine set deleted_at = now(), updated_at = now() where org_id = ${actor.orgId} and id = ${r.id}`);
  if (r.trigger === "found") await reconcileChecks(tx, actor.orgId, now);
}

/**
 * Run now (a scheduled routine: one run, its schedule as it was) or Check now (one that watches: its metrics read
 * again now; only what's filed for the first time is told).
 */
export async function runRoutineNow(
  tx: TenantTx,
  boss: PgBoss,
  actor: Actor,
  id: string,
  now = new Date(),
): Promise<"queued" | "under_way" | "checking"> {
  const r = await loadForChange(tx, actor, id);
  if (r.status !== "active") throw new RoutineProblem("invalid", "Resume it first.");
  if (r.trigger === "found") {
    const checks = await tx.execute<{ id: string }>(sql`
      select k.id from app.metric_check k
      where k.org_id = ${actor.orgId} and k.deleted_at is null
        and k.metric_id::text in (select jsonb_array_elements_text(${JSON.stringify(r.spec.trigger === "found" ? r.spec.metricIds : [])}::jsonb))`);
    for (const c of checks) {
      await enqueueOnce(boss, tx, metricCheckQueue, { orgId: actor.orgId, checkId: c.id }, { singletonKey: c.id });
    }
    return "checking";
  }
  const [busy] = await tx.execute(sql`
    select 1 from app.routine_run where org_id = ${actor.orgId} and routine_id = ${r.id}
      and status in ('queued', 'running', 'writing', 'sending')`);
  if (busy) return "under_way";
  const [run] = await tx.execute<{ id: string }>(sql`
    insert into app.routine_run (org_id, id, routine_id, trigger_key, spec_snapshot)
    values (${actor.orgId}, ${uuidv7()}, ${r.id}, ${`manual:${now.toISOString()}`}, ${JSON.stringify(r.spec)}::jsonb)
    on conflict (org_id, routine_id, trigger_key) do nothing returning id`);
  if (!run) return "under_way";
  await enqueue(boss, tx, routineRunQueue, { orgId: actor.orgId, routineRunId: run.id }, { singletonKey: run.id });
  return "queued";
}

/** The workspace's Watching routine, while it watches something: what it finds stays in Insights. */
export async function getWatching(tx: TenantTx, viewer: Actor): Promise<RoutineView | null> {
  const [w] = await tx.execute<{ id: string }>(sql`
    select id from app.routine where org_id = ${viewer.orgId} and key = ${WATCHING_KEY} and deleted_at is null`);
  return w ? ((await listRoutines(tx, viewer, { id: w.id }))[0] ?? null) : null;
}

/**
 * One-tap Watch (owners and admins): the metric joins the workspace's Watching routine, made with it the first time,
 * and is checked on the next tick.
 */
export async function watchMetric(tx: TenantTx, actor: Actor, metricId: string, now = new Date()): Promise<void> {
  if (!actor.canManage) throw new RoutineProblem("forbidden", "Only owners and admins choose what's watched.");
  // One change to the workspace's routines at a time: Watching is read after it, so it's never changed from a stale
  // copy (unwatchMetric takes it too).
  await lockFor(tx, `routines:${actor.orgId}`);
  const w = await getWatching(tx, actor);
  const spec: FoundSpec = w
    ? { ...(w.spec as FoundSpec), metricIds: [...new Set([...(w.spec as FoundSpec).metricIds, metricId])] }
    : {
        version: 1,
        trigger: "found",
        metricIds: [metricId],
        condition: { kind: "unusual", sensitivity: "medium" },
        tell: "at_once",
        investigate: false,
      };
  await validated(tx, actor, { spec, userIds: [] }, { key: WATCHING_KEY, ownerId: w?.ownerId ?? actor.userId });
  if (w) {
    await tx.execute(sql`
      update app.routine set spec = ${JSON.stringify(spec)}::jsonb, updated_at = now()
      where org_id = ${actor.orgId} and id = ${w.id}`);
  } else {
    await roomForRoutine(tx, actor.orgId, actor.userId);
    await tx.execute(sql`
      insert into app.routine (org_id, id, key, name, owner_id, trigger, spec)
      values (${actor.orgId}, ${uuidv7()}, ${WATCHING_KEY}, 'Watching', ${actor.userId}, 'found',
        ${JSON.stringify(spec)}::jsonb)`);
  }
  await reconcileChecks(tx, actor.orgId, now);
}

/** Stops watching a metric in Watching (the last one gone, so is Watching). What it found stays in Insights. */
export async function unwatchMetric(tx: TenantTx, actor: Actor, metricId: string, now = new Date()): Promise<boolean> {
  if (!actor.canManage) throw new RoutineProblem("forbidden", "Only owners and admins choose what's watched.");
  await lockFor(tx, `routines:${actor.orgId}`);
  const w = await getWatching(tx, actor);
  const spec = w?.spec as FoundSpec | undefined;
  if (!w || !spec?.metricIds.includes(metricId)) return false;
  const metricIds = spec.metricIds.filter((id) => id !== metricId);
  // Only a Watching still there: a deleted one is never brought back.
  await tx.execute(sql`
    update app.routine set spec = ${JSON.stringify({ ...spec, metricIds })}::jsonb, updated_at = now(),
      deleted_at = ${metricIds.length ? null : now.toISOString()}
    where org_id = ${actor.orgId} and id = ${w.id} and deleted_at is null`);
  await reconcileChecks(tx, actor.orgId, now);
  return true;
}

/** How unusual counts for a routine that tells what's unusual (Watching's included): its owner, or an owner or admin. */
export async function setSensitivity(
  tx: TenantTx,
  actor: Actor,
  id: string,
  sensitivity: "lower" | "medium" | "higher",
): Promise<void> {
  if (!Object.hasOwn(SENSITIVITY, sensitivity)) {
    throw new RoutineProblem("invalid", "Sensitivity is lower, medium or higher.");
  }
  const r = await loadForChange(tx, actor, id);
  if (r.spec.trigger !== "found" || r.spec.condition.kind !== "unusual") {
    throw new RoutineProblem("invalid", "Only a routine that tells what's unusual has a sensitivity.");
  }
  const spec: FoundSpec = { ...r.spec, condition: { kind: "unusual", sensitivity } };
  await tx.execute(sql`
    update app.routine set spec = ${JSON.stringify(spec)}::jsonb, updated_at = now()
    where org_id = ${actor.orgId} and id = ${r.id}`);
}

/**
 * Keeps the metric checks in step with what active routines watch: one per metric and period they need (made due
 * now), and none that nothing needs (soft-deleted, so their observations and what they found stay traceable).
 */
export async function reconcileChecks(
  tx: TenantTx,
  orgId: string,
  now = new Date(),
): Promise<{ made: number; removed: number }> {
  // One at a time per workspace: two saves at once can't both make the same check, nor one remove a check the other
  // needs. No row is shared by them all (an org or routine row lock would order against setOrgTz's), so a key.
  await lockFor(tx, `checks:${orgId}`);
  const routines = await tx.execute<{ spec: FoundSpec }>(sql`
    select spec from app.routine
    where org_id = ${orgId} and trigger = 'found' and status = 'active' and deleted_at is null`);
  const metrics = await watchableMetrics(tx, orgId, [...new Set(routines.flatMap((r) => r.spec.metricIds))]);
  const needed = new Map<string, { metricId: string; connectionId: string; grain: "week" | "month" }>();
  for (const r of routines) {
    for (const id of r.spec.metricIds) {
      const m = metrics.find((x) => x.id === id);
      if (!m?.grain) continue;
      for (const grain of grainsFor(r.spec.condition, m.grain)) {
        needed.set(`${id}:${grain}`, { metricId: id, connectionId: m.connectionId, grain });
      }
    }
  }
  const existing = await tx.execute<{ id: string; metric_id: string; grain: string }>(sql`
    select id, metric_id, grain from app.metric_check where org_id = ${orgId} and deleted_at is null`);
  const have = new Set(existing.map((c) => `${c.metric_id}:${c.grain}`));
  let made = 0;
  for (const [key, n] of needed) {
    if (have.has(key)) continue;
    await tx.execute(sql`
      insert into app.metric_check (org_id, id, metric_id, connection_id, grain, next_check_at)
      values (${orgId}, ${uuidv7()}, ${n.metricId}, ${n.connectionId}, ${n.grain}, ${now.toISOString()})`);
    made++;
  }
  const gone = existing.filter((c) => !needed.has(`${c.metric_id}:${c.grain}`)).map((c) => c.id);
  if (gone.length) {
    await tx.execute(sql`
      update app.metric_check set deleted_at = now(), updated_at = now()
      where org_id = ${orgId} and id = any(${`{${gone.join(",")}}`}::uuid[])`);
  }
  return { made, removed: gone.length };
}

/**
 * A new workspace's time zone from its creator's browser: taken only while it's still the default (UTC), by an owner
 * or admin, so it never overrides one someone chose. Whether it was taken.
 */
export async function adoptOrgTz(tx: TenantTx, actor: Actor, tz: string, now = new Date()): Promise<boolean> {
  if (!actor.canManage || !isTimeZone(tz) || tz === "UTC") return false;
  const [o] = await tx.execute<{ tz: string }>(sql`select tz from app.org where id = ${actor.orgId} for update`);
  if (o?.tz !== "UTC") return false;
  await setOrgTz(tx, actor, tz, now);
  return true;
}

/**
 * Changes the workspace's time zone (owners and admins): every scheduled routine's next time and every check's
 * next read move with it, in the same transaction.
 */
export async function setOrgTz(tx: TenantTx, actor: Actor, tz: string, now = new Date()): Promise<void> {
  if (!actor.canManage) throw new RoutineProblem("forbidden", "Only owners and admins set the workspace's time zone.");
  if (!isTimeZone(tz)) throw new RoutineProblem("invalid", "Pick a time zone from the list.");
  await tx.execute(sql`update app.org set tz = ${tz}, updated_at = now() where id = ${actor.orgId}`);
  const scheduled = await tx.execute<{ id: string; spec: RoutineSpec; next_run_at: string | null }>(sql`
    select id, spec, next_run_at from app.routine
    where org_id = ${actor.orgId} and trigger = 'schedule' and status = 'active' and deleted_at is null`);
  for (const r of scheduled) {
    // One already due still runs (the dispatcher's next tick): only what's ahead moves.
    if (r.next_run_at && new Date(r.next_run_at) <= now) continue;
    await tx.execute(sql`
      update app.routine set next_run_at = ${nextRunOf(r.spec, tz, now)}, updated_at = now()
      where org_id = ${actor.orgId} and id = ${r.id}`);
  }
  // Each waiting roundup at 07:00 of its own day where the workspace is now (one already past goes at the next release).
  const roundups = await tx.execute<{ id: string; trigger_key: string }>(sql`
    select id, trigger_key from app.routine_run
    where org_id = ${actor.orgId} and status = 'waiting' and starts_with(trigger_key, 'roundup:')`);
  for (const r of roundups) {
    await tx.execute(sql`
      update app.routine_run set due_at = ${localTimeOn(r.trigger_key.slice("roundup:".length), ROUNDUP_AT, tz).toISOString()},
        updated_at = now()
      where org_id = ${actor.orgId} and id = ${r.id}`);
  }
  // Each check's next read, at the check hour in the new zone: after the period it last judged, or tomorrow morning.
  const checks = await tx.execute<{ id: string; grain: CheckGrain; state: CheckState; next_check_at: string }>(sql`
    select id, grain, state, next_check_at from app.metric_check where org_id = ${actor.orgId} and deleted_at is null`);
  for (const c of checks) {
    if (new Date(c.next_check_at) <= now) continue;
    const next =
      c.state.lastStatus === "ok" && c.state.lastPeriod
        ? nextCheckAt(c.state.lastPeriod, c.grain, tz)
        : checkHourFrom(new Date(now.getTime() + 1), tz);
    await tx.execute(sql`
      update app.metric_check set next_check_at = ${next.toISOString()}, updated_at = now()
      where org_id = ${actor.orgId} and id = ${c.id}`);
  }
}

/**
 * Someone left the workspace: they're taken off every routine that emailed them (one left reaching nobody pauses,
 * saying so), and the routines they owned pause until an owner or admin takes them over. The dashboards shared with
 * them by name stop being shared with them: someone invited back starts with nothing shared again.
 */
export async function memberLeft(tx: TenantTx, orgId: string, userId: string): Promise<void> {
  await tx.execute(sql`delete from app.dashboard_share where org_id = ${orgId} and user_id = ${userId}::uuid`);
  await tx.execute(sql`
    update app.routine set user_ids = array_remove(user_ids, ${userId}::uuid), updated_at = now()
    where org_id = ${orgId} and ${userId}::uuid = any(user_ids) and deleted_at is null`);
  await tx.execute(sql`
    update app.routine set status = 'paused', updated_at = now(),
      paused_reason = case when owner_id = ${userId} then 'Its owner left the workspace.' else 'Nobody gets it any more.' end
    where org_id = ${orgId} and status = 'active' and deleted_at is null and key is null
      and (owner_id = ${userId} or (cardinality(user_ids) = 0 and jsonb_array_length(slack) = 0))`);
  await reconcileChecks(tx, orgId);
}

/** The names a routine's sentence needs, for this viewer. */
function sentenceOf(
  viewer: { orgId: string; userId: string; canManage: boolean },
  r: RoutineRow,
  names: {
    metrics: Map<string, { title: string; format: MetricFormat }>;
    people: Map<string, string>;
  },
  countPeople = false,
  /** Read in this channel (its post's footer): it names itself, whatever it is. */
  postedIn: string | null = null,
): SentencePart[] {
  // A private channel is named to its routine's owner, owners and admins, and itself; to anyone else, it's private.
  const knows = r.owner_id === viewer.userId || (viewer.canManage && !postedIn);
  const channelName = (c: SlackDestination) =>
    !c.private || knows || c.channelId === postedIn ? `#${c.name}` : "a private channel";
  const spec = r.spec;
  const metricTitles =
    spec.trigger === "found" ? spec.metricIds.flatMap((id) => names.metrics.get(id)?.title ?? []) : [];
  const line =
    spec.trigger === "found" && spec.condition.kind === "crosses"
      ? displayMetric(names.metrics.get(spec.metricIds[0] as string)?.format ?? "number", spec.condition.value)
      : undefined;
  return routineSentence(spec, {
    metrics: metricTitles,
    ...(line ? { line } : {}),
    // In a channel, people are counted, never named: a channel may hold guests, and a name can fall back to an address.
    people: countPeople
      ? r.user_ids.length
        ? [{ name: `${r.user_ids.length} ${r.user_ids.length === 1 ? "person" : "people"} by email`, isViewer: false }]
        : []
      : r.user_ids.map((id) => ({
          name: names.people.get(id) ?? "someone who left",
          isViewer: id === viewer.userId,
        })),
    channels: r.slack.map(channelName),
  });
}

/**
 * The workspace's routines the viewer may see (Routines: Team and Yours), newest first, each as its sentence for the
 * viewer and with its last run: their own, those that email them, those that reach past their owner (the team's), and
 * for owners and admins, all. A routine that tells only its owner is theirs alone.
 */
export async function listRoutines(
  tx: TenantTx,
  viewer: Actor,
  options: { id?: string; countPeople?: boolean; postedIn?: string } = {},
): Promise<RoutineView[]> {
  const only = options.id && isUuid(options.id) ? options.id : null;
  if (options.id && !only) return [];
  const rows = await tx.execute<RoutineRow>(sql`
    select id, key, name, owner_id, trigger, spec, user_ids, slack, status, paused_reason, next_run_at, created_at,
      failure_streak
    from app.routine where org_id = ${viewer.orgId} and deleted_at is null
      ${only ? sql`and id = ${only}` : sql``}
      -- Its owner's own, and every one that reaches past its owner; someone's private ones are theirs alone.
      and (owner_id = ${viewer.userId} or not ${isPrivate})
    order by (key is null), created_at desc, id desc`);
  if (!rows.length) return [];
  const runs = await tx.execute<{
    routine_id: string;
    id: string;
    trigger_key: string;
    status: RoutineRunView["status"];
    created_at: string;
    due_at: string | null;
    error: string | null;
    answer_thread_id: string | null;
    answer_run_id: string | null;
    insight_ids: string[];
  }>(sql`
    select distinct on (rr.routine_id) rr.routine_id, rr.id, rr.trigger_key, rr.status, rr.created_at, rr.due_at,
      rr.error, rr.insight_ids,
      case when a.outcome->>'kind' = 'answer' and t.id is not null and ${threadReadableBy(viewer.userId)}
        then a.thread_id end as answer_thread_id,
      case when a.outcome->>'kind' = 'answer' then a.id end as answer_run_id
    from app.routine_run rr
    left join app.run a on a.org_id = rr.org_id and a.id = rr.run_id
    left join app.thread t on t.org_id = a.org_id and t.id = a.thread_id
    where rr.org_id = ${viewer.orgId}
      and rr.routine_id = any(${`{${rows.map((r) => r.id).join(",")}}`}::uuid[])
    order by rr.routine_id, rr.created_at desc`);
  const metricIds = [...new Set(rows.flatMap((r) => (r.spec.trigger === "found" ? r.spec.metricIds : [])))];
  const metrics = new Map(
    (await watchableMetrics(tx, viewer.orgId, metricIds)).map((m) => [m.id, { title: m.title, format: m.format }]),
  );
  // Everyone they name, in one read (a routine's every send reads its own sentence).
  const named = [...new Set(rows.flatMap((r) => r.user_ids))];
  const people = new Map<string, string>();
  if (named.length) {
    const found = await tx.execute<{ id: string; name: string; email: string }>(sql`
      select u.id::text as id, p.name, p.email
      from unnest(${`{${named.join(",")}}`}::uuid[]) u(id) cross join lateral app.member_recipient(u.id) p`);
    for (const p of found) people.set(p.id, p.name || p.email);
  }
  const out: RoutineView[] = [];
  for (const r of rows) {
    const last = runs.find((x) => x.routine_id === r.id);
    out.push({
      id: r.id,
      key: r.key,
      name: r.name,
      ownerId: r.owner_id,
      trigger: r.trigger,
      spec: r.spec,
      userIds: r.user_ids,
      slack: r.slack,
      status: r.status,
      pausedReason: r.paused_reason,
      nextRunAt: r.status === "active" && r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      sentence: sentenceOf(viewer, r, { metrics, people }, options.countPeople, options.postedIn ?? null),
      canEdit: r.owner_id === viewer.userId || viewer.canManage,
      lastRun: last ? runView(last) : null,
    });
  }
  return out;
}

/** How many routines other people keep for themselves: what owners and admins see of them (the Team tab). */
export async function othersPrivateCount(tx: TenantTx, viewer: Actor): Promise<number> {
  const [r] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.routine
    where org_id = ${viewer.orgId} and deleted_at is null and owner_id <> ${viewer.userId} and ${isPrivate}`);
  return r?.n ?? 0;
}

/** Nobody in particular: whoever reads it in a channel, with no private access and no "me". */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * A routine's sentence as a Slack channel reads it: the people it emails counted, not named; no "me"; only what the
 * whole workspace can see, so another private channel it posts to isn't named.
 */
export async function channelSentence(
  tx: TenantTx,
  orgId: string,
  id: string,
  channelId: string,
): Promise<string | null> {
  const [r] = await listRoutines(
    tx,
    { orgId, userId: NOBODY, canManage: true },
    { id, countPeople: true, postedIn: channelId },
  );
  return r ? sentenceText(r.sentence) : null;
}

const runView = (x: {
  id: string;
  trigger_key: string;
  status: RoutineRunView["status"];
  created_at: string;
  due_at: string | null;
  error: string | null;
  answer_thread_id: string | null;
  answer_run_id: string | null;
  insight_ids: string[];
}): RoutineRunView => ({
  id: x.id,
  triggerKey: x.trigger_key,
  status: x.status,
  at: new Date(x.created_at).toISOString(),
  dueAt: x.due_at ? new Date(x.due_at).toISOString() : null,
  error: x.error,
  answer: x.answer_thread_id && x.answer_run_id ? { threadId: x.answer_thread_id, runId: x.answer_run_id } : null,
  insightIds: x.insight_ids,
});

/** A routine's watched metric, as its page shows it: how it's checked, its last check and its next. */
export interface RoutineCheck {
  metric: { id: string; title: string };
  grain: CheckGrain | null;
  state: CheckState;
  nextCheckAt: string | null;
}

/**
 * One routine, with its last 20 runs (the findings each told, by title) and, for one that watches, its metrics'
 * checks.
 */
export async function getRoutine(
  tx: TenantTx,
  viewer: Actor,
  id: string,
): Promise<
  | (RoutineView & { runs: (RoutineRunView & { insights: { id: string; title: string }[] })[]; checks: RoutineCheck[] })
  | null
> {
  if (!isUuid(id)) return null;
  const [r] = await listRoutines(tx, viewer, { id });
  if (!r) return null;
  const rows = await tx.execute<Parameters<typeof runView>[0]>(sql`
    select rr.id, rr.trigger_key, rr.status, rr.created_at, rr.due_at, rr.error, rr.insight_ids,
      case when a.outcome->>'kind' = 'answer' and t.id is not null and ${threadReadableBy(viewer.userId)}
        then a.thread_id end as answer_thread_id,
      case when a.outcome->>'kind' = 'answer' then a.id end as answer_run_id
    from app.routine_run rr
    left join app.run a on a.org_id = rr.org_id and a.id = rr.run_id
    left join app.thread t on t.org_id = a.org_id and t.id = a.thread_id
    where rr.org_id = ${viewer.orgId} and rr.routine_id = ${id} order by rr.created_at desc limit 20`);
  const insightIds = [...new Set(rows.flatMap((x) => x.insight_ids))];
  const titles = insightIds.length
    ? await tx.execute<{ id: string; title: string }>(sql`
        select n.id, n.title from app.insight n
        where n.org_id = ${viewer.orgId} and n.id = any(${`{${insightIds.join(",")}}`}::uuid[])
          and ${insightReadableBy(viewer.userId)}`)
    : [];
  const runs = rows.map((x) => ({
    ...runView(x),
    insights: x.insight_ids.flatMap((i) => titles.filter((t) => t.id === i)),
  }));
  if (r.spec.trigger !== "found" || !r.spec.metricIds.length) return { ...r, runs, checks: [] };
  const metrics = await watchableMetrics(tx, viewer.orgId, r.spec.metricIds);
  const checks = await tx.execute<{
    metric_id: string;
    grain: CheckGrain;
    state: CheckState;
    next_check_at: string;
  }>(sql`
    select metric_id, grain, state, next_check_at from app.metric_check
    where org_id = ${viewer.orgId} and deleted_at is null
      and metric_id = any(${`{${r.spec.metricIds.join(",")}}`}::uuid[])`);
  return {
    ...r,
    runs,
    checks: metrics.map((m) => {
      const c = checks.find((x) => x.metric_id === m.id && x.grain === m.grain);
      return {
        metric: { id: m.id, title: m.title },
        grain: m.grain,
        state: c?.state ?? {},
        nextCheckAt: c ? new Date(c.next_check_at).toISOString() : null,
      };
    }),
  };
}

/**
 * Takes the person off a routine that emails them (Stop, from what they get). Their own, that reached only them, is
 * deleted; one that then reaches nobody pauses, saying so.
 */
export async function leaveRoutine(tx: TenantTx, actor: Actor, id: string, now = new Date()): Promise<boolean> {
  const [r] = isUuid(id)
    ? await tx.execute<RoutineRow>(sql`
        select * from app.routine where org_id = ${actor.orgId} and id = ${id} and deleted_at is null for update`)
    : [];
  if (!r?.user_ids.includes(actor.userId)) return false;
  const left = r.user_ids.filter((u) => u !== actor.userId);
  if (r.owner_id === actor.userId && !left.length && !r.slack.length) {
    await deleteRoutine(tx, actor, id, now);
    return true;
  }
  await tx.execute(sql`
    update app.routine set user_ids = ${`{${left.join(",")}}`}::uuid[], updated_at = now(),
      status = case when ${left.length === 0 && r.slack.length === 0} then 'paused' else status end,
      paused_reason = case when ${left.length === 0 && r.slack.length === 0} then 'Nobody gets it any more.'
        else paused_reason end
    where org_id = ${actor.orgId} and id = ${id}`);
  if (r.trigger === "found") await reconcileChecks(tx, actor.orgId, now);
  return true;
}
