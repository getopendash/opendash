/**
 * Draft definitions: an
 * owner or admin picks up to 10 of a source's tables and views, ranked by how the team uses them, and a Modeler run
 * drafts a dataset and a few metrics for each, through the drafting and settling Make this a metric uses
 * (`proposals.ts`). The drafts wait in Knowledge → Proposals, reviewed as the starter pack: approved, edited or
 * rejected one by one, and the proposal closes once they're all decided.
 */

import type { BuildInfo } from "@opendash/connectors";
import { isUuid, type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { DeploymentKeys } from "../ai/settings";
import type { GatewayDeps } from "../gateway/gateway";
import { enqueue } from "../jobs/boss";
import { agentBackgroundQueue } from "../jobs/queues";
import { tablePatterns } from "../sources/history";
import { type ShapeColumn, shapeHints } from "../sources/table-card";
import { BackgroundBudgetReached, checkBackgroundBudget, spendView } from "../usage/limits";
import { closeDecidedProposals, type DefinitionKind } from "./definitions";
import { dataFence, inertText } from "./fence";
import { type ProposalEvidence, ProposalProblem, type ProposalStatus, startModelerRun } from "./proposals";

/** A Postgres text[] literal, each element quoted. */
const textArray = (values: string[]) =>
  `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;

/** At most this many tables and views in one run. */
export const DRAFT_TABLES_MAX = 10;
/** The picker starts with this many of the most useful ticked. */
export const DRAFT_TABLES_SUGGESTED = 5;

/** A run's budget over its tables: 8 tool calls, 5 queries and $0.50 a table, on top of 8, 4 and $0.50. */
/**
 * From this many tables, the Modeler leads: it groups them and hands each group to a drafter, three at a
 * time. Fewer, it drafts them itself: a helper would add calls and a run for nothing.
 */
export const LEAD_FROM = 3;

export function sourceDraftBudget(tables: number): {
  maxSteps: number;
  maxToolCalls: number;
  maxQueries: number;
  maxCostUsd: number;
} {
  const n = Math.max(1, Math.min(tables, DRAFT_TABLES_MAX));
  return { maxSteps: 8 + 8 * n, maxToolCalls: 8 + 8 * n, maxQueries: 4 + 5 * n, maxCostUsd: 0.5 + 0.5 * n };
}

/** A table or view the picker offers, with what ranks it. */
export interface DraftCandidate {
  name: string;
  kind: "table" | "view";
  rows: number | null;
  /** How many of the team's queries read it (query history). */
  queries: number;
  /** How many other tables join to it. */
  joinedBy: number;
  /** The tables it joins to. */
  joins: string[];
  /** A dataset of this source reads it already. */
  modelled: boolean;
}

/**
 * A source's tables and views, most useful first: the ones the team's queries read, then the ones other tables
 * join to, then the largest; those a dataset already covers last.
 */
export async function draftCandidates(tx: TenantTx, orgId: string, connectionId: string): Promise<DraftCandidate[]> {
  if (!isUuid(connectionId)) return [];
  const rows = await tx.execute<{
    name: string;
    kind: "table" | "view";
    rows: number | null;
    queries: number;
    joined_by: number;
    joins: string[];
    modelled: boolean;
  }>(sql`
    with t as (
      select o.id, o.fq_name, o.kind, o.usage_score, nullif(o.profile->>'rows', '')::float8 as rows
      from app.catalog_object o
      where o.org_id = ${orgId} and o.connection_id = ${connectionId} and o.kind in ('table', 'view')
        and o.removed_at is null),
    refs as (
      select c.parent_id as from_id,
        lower(concat(c.profile->'references'->>'schema', '.', c.profile->'references'->>'table')) as to_name
      from app.catalog_object c
      where c.org_id = ${orgId} and c.connection_id = ${connectionId} and c.kind = 'column' and c.removed_at is null
        and c.profile ? 'references'),
    modelled as (
      select distinct lower(x) as name from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      cross join lateral jsonb_array_elements_text(coalesce(v.derived->'tables', '[]'::jsonb)) x
      where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.kind = 'dataset' and i.deleted_at is null
        and i.status <> 'deprecated')
    select t.fq_name as name, t.kind, t.rows, round(t.usage_score)::int as queries,
      (select count(distinct r.from_id) from refs r where r.to_name = lower(t.fq_name) and r.from_id <> t.id)::int
        as joined_by,
      coalesce((select array_agg(distinct r.to_name) from refs r where r.from_id = t.id and r.to_name <> lower(t.fq_name)),
        '{}') as joins,
      exists (select 1 from modelled m where m.name = lower(t.fq_name)) as modelled
    from t
    order by modelled, queries desc, joined_by desc, rows desc nulls last, name
    limit 200`);
  const names = new Map(rows.map((r) => [r.name.toLowerCase(), r.name]));
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    rows: r.rows === null ? null : Number(r.rows),
    queries: Number(r.queries),
    joinedBy: Number(r.joined_by),
    joins: r.joins.map((j) => names.get(j) ?? j).sort(),
    modelled: r.modelled,
  }));
}

/** What the picker states before it runs: the run's cap over its tables, and what's left of the background budget. */
export async function draftCost(
  tx: TenantTx,
  orgId: string,
  now = new Date(),
): Promise<{ perTableUsd: number; baseUsd: number; leftUsd: number; budgetUsd: number }> {
  const spend = await spendView(tx, orgId, now);
  const one = sourceDraftBudget(1);
  const perTableUsd = sourceDraftBudget(2).maxCostUsd - one.maxCostUsd;
  return {
    perTableUsd,
    baseUsd: one.maxCostUsd - perTableUsd,
    leftUsd: Math.max(0, spend.limits.backgroundMonthlyUsd - spend.spent.background),
    budgetUsd: spend.limits.backgroundMonthlyUsd,
  };
}

/**
 * The Modeler's brief for a source's tables: what each is, what its shape suggests (a snapshot, figures by name), how
 * the team queries it, the tables it joins that weren't picked (its relationships can point at them), and what a
 * reviewer said before.
 */
export function sourceDraftBrief(input: {
  sourceName: string;
  tables: (DraftCandidate & { patterns: string[]; hints?: string[] })[];
  partners?: { name: string; modelled: boolean }[];
  rejected: { title: string; note: string | null }[];
  /**
   * A drafter's: its group of a batch the Modeler leads, with the lead's note, ending with a brief
   * rather than finish_drafting.
   */
  group?: { note?: string };
}): string {
  const facts = (t: DraftCandidate) =>
    [
      t.kind === "view" ? "a view" : "a table",
      t.rows !== null ? `${Math.round(t.rows).toLocaleString("en-US")} rows` : null,
      t.queries ? `read by ${t.queries} of the team's queries` : null,
      t.joinedBy ? `${t.joinedBy} ${t.joinedBy === 1 ? "table joins" : "tables join"} to it` : null,
      t.joins.length ? `joins ${t.joins.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  // What the source says about its tables (names, columns in the hints, the team's queries) is data, fenced once.
  return [
    input.group
      ? `Draft the definitions of these tables of "${inertText(input.sourceName).replace(/"/g, "'")}": your part of a batch an admin picked for the team to ask about, which the Modeler leads.`
      : `Draft the definitions of these tables of "${inertText(input.sourceName).replace(/"/g, "'")}", picked by an admin for the team to ask about:`,
    input.group?.note?.trim()
      ? `The lead's note: ${dataFence("the lead's note", input.group.note.trim().slice(0, 600))}`
      : "",
    dataFence(
      "the picked tables",
      input.tables
        .map((t) =>
          [
            `- ${t.name}: ${facts(t)}.`,
            ...(t.hints ?? []).map((h) => `  ${h}`),
            ...(t.patterns.length ? ["  The team often runs:"] : []),
            ...t.patterns.map((p) => `    ${p.replace(/\s+/g, " ").slice(0, 400)}`),
          ].join("\n"),
        )
        .join("\n"),
    ),
    input.partners?.length
      ? `They join these tables, not picked: a relationship can point at one a dataset reads already; draft a small dataset for one only when a relationship needs it.\n${dataFence(
          "tables they join",
          input.partners
            .map((p) => `- ${p.name}${p.modelled ? " (a dataset reads it)" : " (no dataset yet)"}`)
            .join("\n"),
        )}`
      : "",
    input.rejected.length
      ? `A reviewer rejected earlier drafts of these tables; take their notes into account:\n${dataFence(
          "reviewer notes",
          input.rejected.map((r) => `- ${r.title}: ${r.note ?? "(no note)"}`).join("\n"),
          "admin",
        )}`
      : "",
    input.group
      ? "For each table, a dataset and the few metrics people would ask for. Test each before you propose it, propose it with propose_definitions, and end with brief, saying what you left out and why."
      : input.tables.length >= LEAD_FROM
        ? "For each table, a dataset and the few metrics people would ask for, drafted by helpers: group the tables, hand each group out with draft_tables, and end with finish_drafting, saying what was left out and why."
        : "For each table, a dataset and the few metrics people would ask for. Test each before you propose it, propose a table or two at a time with propose_definitions, and end with finish_drafting, saying what you left out and why.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Starts a Modeler run drafting definitions for a source's picked tables (owners and admins; the caller checks the
 * role), or returns the run already drafting on it. Held, with the reason, when background work's budget is spent or
 * off: a source holds one batch at most, so a request while one waits replaces what it holds. The proposal, its run,
 * thread, message and job are written together. `auto` marks automatic drafting's batches.
 */
export async function requestSourceDrafts(
  deps: { withTenant: GatewayDeps["withTenant"]; boss: PgBoss; deploymentKeys: DeploymentKeys },
  viewer: { orgId: string; userId: string },
  input: { connectionId: string; tables: string[] },
  now = new Date(),
  options: { auto?: boolean } = {},
): Promise<{ proposalId: string; status: ProposalStatus }> {
  const missing = new ProposalProblem("not_found", "That source doesn't exist.");
  if (!isUuid(input.connectionId)) throw missing;
  const picked = [...new Set(input.tables.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (!picked.length) throw new ProposalProblem("invalid", "Pick a table or view to draft from.");
  if (picked.length > DRAFT_TABLES_MAX) {
    throw new ProposalProblem("invalid", `Pick at most ${DRAFT_TABLES_MAX} tables and views.`);
  }
  return deps.withTenant(viewer.orgId, async (tx) => {
    // One run at a time per source: requests for it queue here, and the second finds the first.
    const [c] = await tx.execute<{ name: string }>(sql`
      select name from app.connection
      where org_id = ${viewer.orgId} and id = ${input.connectionId} and deleted_at is null for update`);
    if (!c) throw missing;
    const [live] = await tx.execute<{ id: string }>(sql`
      select id from app.proposal
      where org_id = ${viewer.orgId} and connection_id = ${input.connectionId} and source = 'modeler'
        and from_query_run_id is null and status = 'drafting'`);
    if (live) return { proposalId: live.id, status: "drafting" as const };
    const candidates = await draftCandidates(tx, viewer.orgId, input.connectionId);
    const tables = picked.map((p) => candidates.find((t) => t.name.toLowerCase() === p));
    const unknown = picked.filter((_, i) => !tables[i]);
    if (unknown.length) {
      throw new ProposalProblem("invalid", `${c.name} has no table or view named ${unknown.join(", ")}.`);
    }
    const chosen = tables.filter((t) => t !== undefined);
    const names = textArray(chosen.map((t) => t.name));
    const evidence = JSON.stringify(options.auto ? { auto: true } : {});
    const title = `Definitions for ${c.name}`;
    try {
      await checkBackgroundBudget(tx, viewer.orgId, now);
    } catch (error) {
      if (!(error instanceof BackgroundBudgetReached)) throw error;
      const [held] = await tx.execute<{ id: string }>(sql`
        update app.proposal set tables = ${names}::text[], held_reason = ${error.message},
          requested_by = ${viewer.userId}, evidence = (evidence - 'auto') || ${evidence}::jsonb
        where org_id = ${viewer.orgId} and connection_id = ${input.connectionId} and from_query_run_id is null
          and status = 'held'
        returning id`);
      if (held) return { proposalId: held.id, status: "held" as const };
      const proposalId = uuidv7();
      await tx.execute(sql`
        insert into app.proposal (org_id, id, connection_id, status, run_id, requested_by, tables, title, held_reason,
          evidence)
        values (${viewer.orgId}, ${proposalId}, ${input.connectionId}, 'held', null, ${viewer.userId}, ${names}::text[],
          ${title}, ${error.message}, ${evidence}::jsonb)`);
      return { proposalId, status: "held" as const };
    }
    const proposalId = uuidv7();
    const runId = await startDraftRun(tx, deps, viewer, { id: input.connectionId, name: c.name }, chosen, candidates);
    await tx.execute(sql`
      insert into app.proposal (org_id, id, connection_id, status, run_id, requested_by, tables, title, held_reason,
        evidence)
      values (${viewer.orgId}, ${proposalId}, ${input.connectionId}, 'drafting', ${runId}, ${viewer.userId},
        ${names}::text[], ${title}, null, ${evidence}::jsonb)`);
    await enqueue(deps.boss, tx, agentBackgroundQueue, { orgId: viewer.orgId, runId }, { singletonKey: runId });
    return { proposalId, status: "drafting" as const };
  });
}

/** The brief for these tables (their shapes, the team's queries, their join partners, reviewers' notes) and its run. */
async function startDraftRun(
  tx: TenantTx,
  deps: { deploymentKeys: DeploymentKeys },
  viewer: { orgId: string; userId: string },
  connection: { id: string; name: string },
  chosen: DraftCandidate[],
  candidates: DraftCandidate[],
): Promise<string> {
  return startModelerRun(tx, deps, viewer, {
    connectionId: connection.id,
    title: `Definitions for ${connection.name}`,
    brief: await draftBrief(tx, viewer.orgId, connection, chosen, candidates),
  });
}

/**
 * A drafter's brief: its group's tables of the batch, as the batch's brief gives each, and the lead's note.
 * Tables the source doesn't have are left out; none left is an error the lead is told.
 */
export async function drafterBrief(
  tx: TenantTx,
  orgId: string,
  connection: { id: string; name: string },
  tables: string[],
  note?: string,
): Promise<string> {
  const candidates = await draftCandidates(tx, orgId, connection.id);
  const chosen = tables.flatMap((t) => candidates.filter((c) => c.name.toLowerCase() === t.trim().toLowerCase()));
  if (!chosen.length)
    throw new ProposalProblem("invalid", `${connection.name} has no table named ${tables.join(", ")}.`);
  return draftBrief(tx, orgId, connection, chosen, candidates, { ...(note ? { note } : {}) });
}

async function draftBrief(
  tx: TenantTx,
  orgId: string,
  connection: { id: string; name: string },
  chosen: DraftCandidate[],
  candidates: DraftCandidate[],
  group?: { note?: string },
): Promise<string> {
  const viewer = { orgId };
  const shapes = await tableShapes(
    tx,
    viewer.orgId,
    connection.id,
    chosen.map((t) => t.name),
  );
  const chosenNames = new Set(chosen.map((t) => t.name.toLowerCase()));
  const partners = [...new Set(chosen.flatMap((t) => t.joins))]
    .filter((j) => !chosenNames.has(j.toLowerCase()))
    .map((j) => ({
      name: j,
      modelled: candidates.find((c) => c.name.toLowerCase() === j.toLowerCase())?.modelled ?? false,
    }));
  const brief = sourceDraftBrief({
    sourceName: connection.name,
    tables: await Promise.all(
      chosen.map(async (t) => ({
        ...t,
        hints: shapes.get(t.name.toLowerCase()) ?? [],
        patterns: (await tablePatterns(tx, viewer.orgId, connection.id, t.name, 2)).map((p) => p.sql),
      })),
    ),
    partners,
    rejected: await rejectedNotes(tx, viewer.orgId, connection.id, chosen),
    ...(group ? { group } : {}),
  });
  return brief;
}

/** At most this many tables in one automatic batch. */
export const AUTO_BATCH_TABLES = DRAFT_TABLES_MAX;

/**
 * The learned tables automatic drafting has still to try, most useful first: learned, not read by a
 * dataset, and in no batch of this source that got anywhere: one drafting, held, reviewed, or ended by the Modeler
 * (a rejected or left-out table isn't tried again on its own, so drafting can't loop; an admin asks for it by hand)
 * or by an admin's Stop. A batch whose run failed (an outage, a revoked key) or never ran leaves its tables to try.
 */
async function tablesToDraft(tx: TenantTx, orgId: string, connectionId: string): Promise<DraftCandidate[]> {
  const candidates = await draftCandidates(tx, orgId, connectionId);
  const rows = await tx.execute<{ name: string; tried: boolean }>(sql`
    select lower(o.fq_name) as name,
      exists (select 1 from app.proposal p
        left join app.run r on r.org_id = p.org_id and r.id = p.run_id
        where p.org_id = o.org_id and p.connection_id = o.connection_id and p.source = 'modeler'
          and p.from_query_run_id is null and lower(o.fq_name) = any(select lower(x) from unnest(p.tables) x)
          and (p.status <> 'failed' or r.status in ('succeeded', 'cancelled'))) as tried
    from app.catalog_object o
    where o.org_id = ${orgId} and o.connection_id = ${connectionId} and o.kind in ('table', 'view')
      and o.removed_at is null and o.learn`);
  const open = new Set(rows.filter((r) => !r.tried).map((r) => r.name));
  return candidates.filter((c) => !c.modelled && open.has(c.name.toLowerCase()));
}

/**
 * Automatic drafting: after a sync, and when a batch's run ends, the next up-to-10 learned
 * tables of a source are drafted, requested as the owner or admin who chose what it learns, while they still are one.
 * Only for a source whose choice an admin saved (sources connected before choosing existed start once one does), never
 * the sample, and never beside a batch drafting or held. A spent budget holds the batch, which resumes on its own.
 */
export async function requestNextDraftBatch(
  deps: { withTenant: GatewayDeps["withTenant"]; boss: PgBoss; deploymentKeys: DeploymentKeys },
  job: { orgId: string; connectionId: string },
  now = new Date(),
): Promise<{ proposalId: string; status: ProposalStatus } | null> {
  if (!isUuid(job.connectionId)) return null;
  const next = await deps.withTenant(job.orgId, async (tx) => {
    const [c] = await tx.execute<{ chooser: string | null; sample: boolean; busy: boolean; role: string | null }>(sql`
      select c.learning_chosen_by as chooser, coalesce((c.config->>'sample')::boolean, false) as sample,
        exists (select 1 from app.proposal p where p.org_id = c.org_id and p.connection_id = c.id
          and p.source = 'modeler' and p.from_query_run_id is null and p.status in ('drafting', 'held')) as busy,
        case when c.learning_chosen_by is null then null else app.member_role(c.learning_chosen_by) end as role
      from app.connection c
      where c.org_id = ${job.orgId} and c.id = ${job.connectionId} and c.deleted_at is null`);
    if (!c?.chooser || c.sample || c.busy || (c.role !== "owner" && c.role !== "admin")) return null;
    const tables = (await tablesToDraft(tx, job.orgId, job.connectionId)).slice(0, AUTO_BATCH_TABLES);
    return tables.length ? { chooser: c.chooser, tables: tables.map((t) => t.name) } : null;
  });
  if (!next) return null;
  return requestSourceDrafts(
    deps,
    { orgId: job.orgId, userId: next.chooser },
    { connectionId: job.connectionId, tables: next.tables },
    now,
    { auto: true },
  );
}

/**
 * When a source's drafting run has ended (settled), its next automatic batch: only after a run the Modeler finished,
 * never after one that failed or an admin stopped (the next sync tries again); null for any other run.
 */
export async function nextDraftBatchAfter(
  deps: { withTenant: GatewayDeps["withTenant"]; boss: PgBoss; deploymentKeys: DeploymentKeys },
  orgId: string,
  runId: string,
): Promise<{ proposalId: string; status: ProposalStatus } | null> {
  if (!isUuid(runId)) return null;
  const [p] = await deps.withTenant(orgId, (tx) =>
    tx.execute<{ connection_id: string }>(sql`
      select p.connection_id from app.proposal p
      join app.run r on r.org_id = p.org_id and r.id = p.run_id and r.status = 'succeeded'
      where p.org_id = ${orgId} and p.run_id = ${runId} and p.source = 'modeler' and p.from_query_run_id is null
        and p.status <> 'drafting'`),
  );
  return p ? requestNextDraftBatch(deps, { orgId, connectionId: p.connection_id }) : null;
}

/**
 * Resumes the batches held for the background budget, once it has room (the 5-minute schedule): each starts as its
 * requester asked, while they're still an owner or admin (else it fails, saying so), or stays held with the budget's
 * reason now. At most 50 a pass.
 */
export async function resumeHeldDrafts(
  deps: {
    withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
    withTenant: GatewayDeps["withTenant"];
    boss: PgBoss;
    deploymentKeys: DeploymentKeys;
  },
  now = new Date(),
): Promise<{ resumed: number }> {
  const held = await deps.withSystem(async (tx) => {
    // A batch on a deleted source never starts: it's closed, saying so.
    await tx.execute(sql`
      update app.proposal p set status = 'failed', held_reason = null,
        evidence = jsonb_set(p.evidence, '{failed}', to_jsonb('Its source was deleted.'::text))
      from app.connection c
      where p.status = 'held' and p.source = 'modeler' and p.from_query_run_id is null and c.org_id = p.org_id
        and c.id = p.connection_id
        and c.deleted_at is not null`);
    // Only organizations whose background budget has room now, so the ones that can't start never crowd out the rest.
    const orgs = await tx.execute<{ org_id: string }>(sql`
      select distinct org_id from app.proposal
      where status = 'held' and source = 'modeler' and from_query_run_id is null limit 500`);
    const room: string[] = [];
    for (const o of orgs) {
      const v = await spendView(tx, o.org_id, now);
      if (v.spent.background < v.limits.backgroundMonthlyUsd) room.push(o.org_id);
    }
    if (!room.length) return [];
    return tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from app.proposal
      where status = 'held' and source = 'modeler' and from_query_run_id is null and connection_id is not null
        and org_id = any(${`{${room.join(",")}}`}::uuid[])
      order by created_at limit 50`);
  });
  let resumed = 0;
  for (const h of held) {
    const started = await deps.withTenant(h.org_id, async (tx) => {
      const [p] = await tx.execute<{
        connection_id: string;
        name: string;
        tables: string[];
        requested_by: string | null;
        role: string | null;
      }>(sql`
        select p.connection_id, c.name, p.tables, p.requested_by,
          case when p.requested_by is null then null else app.member_role(p.requested_by) end as role
        from app.proposal p
        join app.connection c on c.org_id = p.org_id and c.id = p.connection_id and c.deleted_at is null
        where p.org_id = ${h.org_id} and p.id = ${h.id} and p.status = 'held'
        for update of p, c skip locked`);
      if (!p) return false;
      // Drafting spends and writes in its requester's name: only an owner's or admin's batch starts.
      if (!p.requested_by || (p.role !== "owner" && p.role !== "admin")) {
        await tx.execute(sql`
          update app.proposal set status = 'failed', held_reason = null,
            evidence = jsonb_set(evidence, '{failed}',
              to_jsonb('Who asked for it is no longer an owner or admin: an owner or admin asks again.'::text))
          where org_id = ${h.org_id} and id = ${h.id}`);
        return false;
      }
      const [busy] = await tx.execute<{ id: string }>(sql`
        select id from app.proposal where org_id = ${h.org_id} and connection_id = ${p.connection_id}
          and source = 'modeler' and from_query_run_id is null and status = 'drafting'`);
      if (busy) return false;
      try {
        await checkBackgroundBudget(tx, h.org_id, now);
      } catch (error) {
        if (!(error instanceof BackgroundBudgetReached)) throw error;
        await tx.execute(
          sql`update app.proposal set held_reason = ${error.message} where org_id = ${h.org_id} and id = ${h.id}`,
        );
        return false;
      }
      const candidates = await draftCandidates(tx, h.org_id, p.connection_id);
      const chosen = p.tables.flatMap((t) => candidates.filter((c) => c.name.toLowerCase() === t.toLowerCase()));
      if (!chosen.length) {
        await tx.execute(sql`
          update app.proposal set status = 'failed', held_reason = null,
            evidence = jsonb_set(evidence, '{failed}', to_jsonb('Its tables are gone from the source.'::text))
          where org_id = ${h.org_id} and id = ${h.id}`);
        return false;
      }
      const viewer = { orgId: h.org_id, userId: p.requested_by };
      const runId = await startDraftRun(tx, deps, viewer, { id: p.connection_id, name: p.name }, chosen, candidates);
      await tx.execute(sql`
        update app.proposal set status = 'drafting', run_id = ${runId}, held_reason = null
        where org_id = ${h.org_id} and id = ${h.id}`);
      await enqueue(deps.boss, tx, agentBackgroundQueue, { orgId: h.org_id, runId }, { singletonKey: runId });
      return true;
    });
    if (started) resumed += 1;
  }
  return { resumed };
}

/** What each table's shape suggests (`shapeHints`), from its columns, keys and how it's built, by lower-cased name. */
async function tableShapes(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  names: string[],
): Promise<Map<string, string[]>> {
  const rows = await tx.execute<{
    table: string;
    build: BuildInfo | null;
    primary_key: string[] | null;
    column: string | null;
    data_type: string | null;
    roles: string[] | null;
  }>(sql`
    select t.fq_name as table, t.schema_info as build,
      (select array_agg(k) from jsonb_array_elements_text(coalesce(t.profile->'primaryKey', '[]'::jsonb)) k) as primary_key,
      c.name as column, c.data_type,
      (select array_agg(r) from jsonb_array_elements_text(coalesce(c.profile->'roles', '[]'::jsonb)) r) as roles
    from app.catalog_object t
    left join app.catalog_object c on c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column'
      and c.removed_at is null
    where t.org_id = ${orgId} and t.connection_id = ${connectionId} and t.kind in ('table', 'view')
      and t.removed_at is null and lower(t.fq_name) = any(${textArray(names.map((n) => n.toLowerCase()))}::text[])
    order by t.fq_name, c.name`);
  const tables = new Map<string, { columns: ShapeColumn[]; build: BuildInfo | null; primaryKey: string[] }>();
  for (const r of rows) {
    const key = r.table.toLowerCase();
    const t = tables.get(key) ?? { columns: [], build: r.build, primaryKey: r.primary_key ?? [] };
    if (r.column) t.columns.push({ name: r.column, type: r.data_type, roles: r.roles ?? [] });
    tables.set(key, t);
  }
  return new Map([...tables].map(([k, t]) => [k, shapeHints(t)]));
}

/** The notes reviewers left on rejected drafts of these tables, newest first, for the next draft. */
async function rejectedNotes(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  tables: DraftCandidate[],
): Promise<{ title: string; note: string | null }[]> {
  const names = new Set(tables.map((t) => t.name.toLowerCase()));
  const rows = await tx.execute<{ rejected: NonNullable<ProposalEvidence["rejected"]> }>(sql`
    select evidence->'rejected' as rejected from app.proposal
    where org_id = ${orgId} and connection_id = ${connectionId} and source = 'modeler' and from_query_run_id is null
      and evidence ? 'rejected'
    order by created_at desc limit 10`);
  return rows
    .flatMap((r) => r.rejected)
    .filter((r) => !r.tables?.length || r.tables.some((t) => names.has(t.toLowerCase())))
    .slice(0, 10)
    .map((r) => ({ title: r.title, note: r.note }));
}

/**
 * Rejects one of a source's drafts (owners and admins; the caller checks the role) with the reviewer's note, kept
 * for the next draft of its tables. A dataset takes the metrics drafted on it along. The proposal closes once nothing
 * is left to review.
 */
export async function rejectDraft(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  itemId: string,
  note: string,
): Promise<{ rejected: string[] }> {
  const missing = new ProposalProblem("not_found", "That draft doesn't exist.");
  if (!isUuid(itemId)) throw missing;
  const [d] = await tx.execute<{
    proposal_id: string;
    kind: DefinitionKind;
    slug: string;
    connection_id: string;
  }>(sql`
    select p.id as proposal_id, i.kind, i.slug, i.connection_id from app.context_item i
    join app.proposal p on p.org_id = i.org_id and i.id = any(p.items) and p.source = 'modeler'
      and p.from_query_run_id is null and p.status = 'open'
    where i.org_id = ${viewer.orgId} and i.id = ${itemId} and i.deleted_at is null
      and i.status in ('proposed', 'needs_review')
    for update of i, p`);
  if (!d) throw missing;
  const gone = await tx.execute<{
    id: string;
    kind: DefinitionKind;
    slug: string;
    title: string;
    tables: string[] | null;
  }>(
    sql`
      update app.context_item i set deleted_at = now(), updated_at = now()
      from app.context_item_version v, app.proposal p
      where i.org_id = ${viewer.orgId} and p.org_id = i.org_id and p.id = ${d.proposal_id} and i.id = any(p.items)
        and v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        and i.deleted_at is null and i.status in ('proposed', 'needs_review')
        and (i.id = ${itemId} or (${d.kind} = 'dataset' and i.kind = 'metric' and v.spec->>'dataset' = ${d.slug}))
      returning i.id, i.kind, i.slug, i.title,
        (select array_agg(t) from jsonb_array_elements_text(coalesce(v.derived->'tables', '[]'::jsonb)) t) as tables`,
  );
  const at = new Date().toISOString();
  const kept = note.trim().slice(0, 1000) || null;
  const entries = gone.map((g) => ({
    kind: g.kind,
    slug: g.slug,
    title: g.title,
    tables: g.tables ?? [],
    note: kept,
    at,
  }));
  await tx.execute(sql`
    update app.proposal set evidence = jsonb_set(evidence, '{rejected}',
      coalesce(evidence->'rejected', '[]'::jsonb) || ${JSON.stringify(entries)}::jsonb)
    where org_id = ${viewer.orgId} and id = ${d.proposal_id}`);
  await closeDecidedProposals(tx, viewer);
  return { rejected: gone.map((g) => g.id) };
}

/**
 * One of a batch's drafters: its tables, and how far it got. `drafting` since it started; `kept` with what it
 * kept; `left_out` when it kept nothing, saying why; `stopped` when it ended without its brief.
 */
export interface DraftHelper {
  tables: string[];
  state: "drafting" | "kept" | "left_out" | "stopped";
  datasets: number;
  metrics: number;
  reason: string | null;
  startedAt: string;
}

/** Where a source's drafts are, for its Overview: a run under way, drafts waiting for review, the last that stopped. */
export interface SourceDraftState {
  /** The source's datasets and metrics: verified, and waiting for review. */
  definitions: { verified: number; proposed: number };
  drafting: {
    proposalId: string;
    tables: string[];
    startedAt: string;
    /** Whether the Modeler leads it (from LEAD_FROM tables): its helpers come as it hands its tables out. */
    leads: boolean;
    /** Its drafters, when the Modeler leads the batch: each group as it was handed out. */
    helpers: DraftHelper[];
    /** The batch's run (the lead's): its trace, and the events its card follows. */
    runId: string | null;
  } | null;
  /** Drafts from its tables waiting for review. */
  inReview: number;
  /** The last request that stopped without drafts (held, or failed), when it's the latest. */
  stopped: { status: "held" | "failed"; reason: string; at: string } | null;
  /**
   * Automatic drafting, for a source whose choice an admin saved: the batch under way or held (its number of
   * how many), the chosen tables still to draft (a held batch's included), and the background budget's room.
   */
  auto: {
    batch: number | null;
    batches: number;
    toDraft: number;
    held: { reason: string } | null;
    budget: { leftUsd: number; budgetUsd: number; spentUsd: number };
  } | null;
}

/** A drafting batch's drafters, as they were handed out. */
async function draftHelpers(tx: TenantTx, orgId: string, runId: string): Promise<DraftHelper[]> {
  const rows = await tx.execute<{
    tables: string[] | null;
    status: string;
    outcome: {
      kind?: string;
      items?: { kind: string }[];
      leftOut?: { name: string; reason: string }[];
      reason?: string;
    } | null;
    started_at: string;
  }>(sql`
    select task->'tables' as tables, status, outcome, coalesce(started_at, queued_at) as started_at from app.run
    where org_id = ${orgId} and parent_run_id = ${runId} order by queued_at`);
  return rows.map((r) => {
    const items = r.outcome?.items ?? [];
    const datasets = items.filter((i) => i.kind === "dataset").length;
    const metrics = items.filter((i) => i.kind === "metric").length;
    const ended = r.status === "succeeded" && r.outcome?.kind === "modeler";
    const state: DraftHelper["state"] = ["queued", "running", "cancelling"].includes(r.status)
      ? "drafting"
      : !ended
        ? "stopped"
        : items.length
          ? "kept"
          : "left_out";
    const why = r.outcome?.leftOut?.[0]?.reason ?? r.outcome?.reason ?? null;
    return {
      tables: r.tables ?? [],
      state,
      datasets,
      metrics,
      reason: state === "kept" || state === "drafting" ? null : why,
      startedAt: new Date(r.started_at).toISOString(),
    };
  });
}

export async function sourceDraftState(tx: TenantTx, orgId: string, connectionId: string): Promise<SourceDraftState> {
  const empty: SourceDraftState = {
    definitions: { verified: 0, proposed: 0 },
    drafting: null,
    inReview: 0,
    stopped: null,
    auto: null,
  };
  if (!isUuid(connectionId)) return empty;
  const [defs] = await tx.execute<{ verified: number; proposed: number }>(sql`
    select count(*) filter (where released_version is not null)::int as verified,
      count(*) filter (where released_version is null and status in ('proposed', 'needs_review'))::int as proposed
    from app.context_item
    where org_id = ${orgId} and connection_id = ${connectionId} and deleted_at is null and kind in ('dataset', 'metric')`);
  const proposals = await tx.execute<{
    id: string;
    status: ProposalStatus;
    tables: string[];
    created_at: string;
    held_reason: string | null;
    evidence: ProposalEvidence;
    in_review: number;
    run_id: string | null;
  }>(sql`
    select p.id, p.status, p.tables, p.created_at, p.held_reason, p.evidence, p.run_id,
      (select count(*) from app.context_item i
        where i.org_id = p.org_id and i.id = any(p.items) and i.deleted_at is null
          and i.status in ('proposed', 'needs_review'))::int as in_review
    from app.proposal p
    where p.org_id = ${orgId} and p.connection_id = ${connectionId} and p.from_query_run_id is null
    order by p.created_at desc limit 20`);
  const drafting = proposals.find((p) => p.status === "drafting");
  const latest = proposals[0];
  const helpers = drafting?.run_id ? await draftHelpers(tx, orgId, drafting.run_id) : [];
  const [c] = await tx.execute<{ chooser: string | null; sample: boolean }>(sql`
    select learning_chosen_by as chooser, coalesce((config->>'sample')::boolean, false) as sample
    from app.connection where org_id = ${orgId} and id = ${connectionId}`);
  let auto: SourceDraftState["auto"] = null;
  if (c?.chooser && !c.sample) {
    const [counted] = await tx.execute<{ batches: number }>(sql`
      select count(*)::int as batches from app.proposal p
      left join app.run r on r.org_id = p.org_id and r.id = p.run_id
      where p.org_id = ${orgId} and p.connection_id = ${connectionId} and p.from_query_run_id is null
        and p.evidence->>'auto' = 'true' and (p.status <> 'failed' or r.status in ('succeeded', 'cancelled'))`);
    const current = proposals.find((p) => (p.status === "drafting" || p.status === "held") && p.evidence.auto === true);
    const left = (await tablesToDraft(tx, orgId, connectionId)).length;
    const done = Number(counted?.batches ?? 0);
    const spend = await spendView(tx, orgId);
    auto = {
      batch: current ? done : null,
      batches: done + Math.ceil(left / AUTO_BATCH_TABLES),
      toDraft: left + (current?.status === "held" ? current.tables.length : 0),
      held: current?.status === "held" ? { reason: current.held_reason ?? "" } : null,
      budget: {
        budgetUsd: spend.limits.backgroundMonthlyUsd,
        spentUsd: spend.spent.background,
        leftUsd: Math.max(0, spend.limits.backgroundMonthlyUsd - spend.spent.background),
      },
    };
  }
  return {
    definitions: { verified: defs?.verified ?? 0, proposed: defs?.proposed ?? 0 },
    drafting: drafting
      ? {
          proposalId: drafting.id,
          tables: drafting.tables,
          startedAt: new Date(drafting.created_at).toISOString(),
          leads: drafting.tables.length >= LEAD_FROM,
          helpers,
          runId: drafting.run_id,
        }
      : null,
    inReview: proposals.filter((p) => p.status === "open").reduce((n, p) => n + Number(p.in_review), 0),
    stopped:
      latest && (latest.status === "held" || latest.status === "failed")
        ? {
            status: latest.status,
            reason: latest.held_reason ?? latest.evidence.failed ?? "It stopped before it drafted a definition.",
            at: new Date(latest.created_at).toISOString(),
          }
        : null,
    auto: auto && (auto.batch !== null || auto.toDraft > 0) ? auto : null,
  };
}
