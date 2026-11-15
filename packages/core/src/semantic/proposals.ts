/**
 * The Modeler's proposals. Make this a metric: a person asks for a metric from an answer's query card, and a Modeler
 * run drafts its dataset and metric in the background, each validated and data-tested before it's proposed; an owner
 * or admin then approves, edits or rejects the proposal. Draft definitions (`source-drafts.ts`) runs the same Modeler
 * over a source's tables, through the same drafting and settling here.
 */
import { createHash } from "node:crypto";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { type DeploymentKeys, defaultChoice } from "../ai/settings";
import type { GatewayDeps } from "../gateway/gateway";
import { enqueue } from "../jobs/boss";
import { agentBackgroundQueue } from "../jobs/queues";
import { nextMessageSeq, visibleTo } from "../runs/ledger";
import { BackgroundBudgetReached, checkBackgroundBudget } from "../usage/limits";
import { checkDefinitions, type DefinitionDerived } from "./checks";
import { type DefinitionKind, type DefinitionStatus, validateDefinition, verifyDefinitions } from "./definitions";
import { dataFence, inertText } from "./fence";

export type ProposalStatus = "drafting" | "held" | "failed" | "open" | "approved" | "rejected" | "superseded";

/** Something about a proposal that can't be done, in words a person acts on. */
export class ProposalProblem extends Error {
  constructor(
    readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** What the drafts' tests found. */
export interface ProposalEvidence {
  /** Why it couldn't draft (a failed one). */
  failed?: string;
  /** Why a run over a source's tables stopped before it finished, when it kept drafts all the same. */
  stopped?: string;
  /** What a run over a source's tables left out, and why (Draft definitions). */
  leftOut?: { name: string; reason: string }[];
  /** Requested by automatic drafting, as the admin who chose what's learned, not by a person's ask. */
  auto?: boolean;
  /** Drafts a reviewer rejected, with their notes, for the next draft of their tables. */
  rejected?: {
    kind: DefinitionKind;
    slug: string;
    title: string;
    tables?: string[];
    note: string | null;
    at: string;
  }[];
}

export interface ProposalItem {
  id: string;
  kind: DefinitionKind;
  slug: string;
  title: string;
  status: DefinitionStatus;
  body: string;
  /** Its spec as parsed (a DatasetSpec or MetricSpec), for the review's overview. */
  spec: unknown;
  checks: DefinitionDerived | null;
  /** Why the Modeler drafted it as it did (its version's change note). */
  why: string | null;
}

/**
 * A proposal as a person sees it. Its drafts are shared knowledge, so everyone sees them; where it came from (the
 * answer, the query, why the Modeler drafted it as it did) only those who can read that answer. For anyone else
 * `from.visible` is false and those are empty.
 */
export interface ProposalView {
  id: string;
  status: ProposalStatus;
  /** The query's title; null when its origin isn't the viewer's to see. */
  title: string | null;
  connectionId: string;
  connectionName: string;
  rationale: string | null;
  evidence: ProposalEvidence;
  heldReason: string | null;
  note: string | null;
  from: { visible: boolean; queryRunId: string | null };
  /** The query it was drafted from, as written. */
  sql: string | null;
  /** The tables and views it was drafted from (Draft definitions); empty for a draft from a query. */
  tables: string[];
  items: ProposalItem[];
  requestedBy: string | null;
  reviewerId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export const pathOf = (connectionId: string, kind: DefinitionKind, slug: string) =>
  `/sources/${connectionId}/${kind === "dataset" ? "models" : "metrics"}/${slug}.yaml`;

/** At most this many of the query's rows go to the Modeler with its brief. */
const BRIEF_ROWS = 10;

/** What the Modeler is asked: the query in words, its SQL and its first rows. */
export function modelerBrief(input: {
  title: string;
  sql: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
}): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").slice(0, 60));
  const table = [
    `| ${input.columns.map((c) => c.name).join(" | ")} |`,
    `| ${input.columns.map(() => "---").join(" | ")} |`,
    ...input.rows.slice(0, BRIEF_ROWS).map((r) => `| ${input.columns.map((_, i) => cell(r[i])).join(" | ")} |`),
  ].join("\n");
  return [
    `Make this query a verified metric. Someone kept it from an answer as "${inertText(input.title).replace(/"/g, "'")}" and asked for it to become a reviewed definition.`,
    "Its SQL:",
    dataFence("the query", input.sql.trim()),
    `Its columns: ${inertText(input.columns.map((c) => `${c.name} (${c.type})`).join(", "))}. Its first rows:`,
    dataFence("its first rows", table),
    "Draft the metric it computes, and its dataset when no dataset of this source covers the table it reads. Test them with your own queries, then propose them with propose_definitions.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type Source = {
  queryRunId: string;
  connectionId: string;
  sql: string;
  title: string;
};

/** The query a request names: a query of a conversation they can read. */
async function sourceOf(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  input: { queryRunId: string },
): Promise<Source> {
  const missing = new ProposalProblem("not_found", "That query doesn't exist, or isn't one you can read.");
  if (!isUuid(input.queryRunId)) throw missing;
  const [q] = await tx.execute<{
    connection_id: string;
    compiled_sql: string;
    written_sql: string | null;
    title: string | null;
  }>(sql`
    select q.connection_id, q.compiled_sql, q.written_sql, q.title from app.query_run q
    where q.org_id = ${viewer.orgId} and q.id = ${input.queryRunId} and q.requester_type = 'run'
      and q.mode = 'execute' and q.status = 'succeeded'
      and exists (
        select 1 from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
        where r.org_id = q.org_id and r.id = q.requester_id and ${visibleTo(viewer.userId)})`);
  if (!q) throw missing;
  return {
    queryRunId: input.queryRunId,
    connectionId: q.connection_id,
    sql: q.written_sql ?? q.compiled_sql,
    title: q.title || "Query",
  };
}

/**
 * Starts a Modeler run drafting a metric from a query, or says where its draft is: one under way or in review is
 * returned as it is. Held, with the reason, when background work's budget is spent or off. The proposal, its run,
 * the run's thread (channel `modeler`, nobody's conversation) and message, and its job are written together.
 */
export async function requestMetricDraft(
  deps: { withTenant: GatewayDeps["withTenant"]; boss: PgBoss; deploymentKeys: DeploymentKeys },
  viewer: { orgId: string; userId: string },
  input: { queryRunId: string },
  now = new Date(),
): Promise<{ proposalId: string; status: ProposalStatus }> {
  return deps.withTenant(viewer.orgId, async (tx) => {
    const src = await sourceOf(tx, viewer, input);
    const [live] = await tx.execute<{ id: string; status: ProposalStatus }>(sql`
      select id, status from app.proposal
      where org_id = ${viewer.orgId} and from_query_run_id = ${src.queryRunId} and status in ('drafting', 'open')`);
    if (live) return { proposalId: live.id, status: live.status };
    const proposalId = uuidv7();
    const insert = (status: ProposalStatus, runId: string | null, heldReason: string | null) =>
      tx.execute(sql`
        insert into app.proposal (org_id, id, connection_id, status, run_id, requested_by, from_query_run_id, title,
          held_reason)
        values (${viewer.orgId}, ${proposalId}, ${src.connectionId}, ${status}, ${runId}, ${viewer.userId},
          ${src.queryRunId}, ${src.title}, ${heldReason})`);
    try {
      await checkBackgroundBudget(tx, viewer.orgId, now);
    } catch (error) {
      if (!(error instanceof BackgroundBudgetReached)) throw error;
      await insert("held", null, error.message);
      return { proposalId, status: "held" as const };
    }
    const [result] = await tx.execute<{
      result_schema: { name: string; type: string }[] | null;
      preview: unknown[][] | null;
    }>(sql`
      select result_schema, preview from app.query_run where org_id = ${viewer.orgId} and id = ${src.queryRunId}`);
    const brief = modelerBrief({
      title: src.title,
      sql: src.sql,
      columns: result?.result_schema ?? [],
      rows: result?.preview ?? [],
    });
    const runId = await startModelerRun(tx, deps, viewer, {
      connectionId: src.connectionId,
      title: `Metric from ${src.title}`,
      brief,
    });
    await insert("drafting", runId, null);
    await enqueue(deps.boss, tx, agentBackgroundQueue, { orgId: viewer.orgId, runId }, { singletonKey: runId });
    return { proposalId, status: "drafting" as const };
  });
}

/**
 * A Modeler run's thread (channel `modeler`, nobody's conversation), its brief as the message, and the run, on the
 * organization's default model. The caller writes the proposal pointing at it, then enqueues the run.
 */
export async function startModelerRun(
  tx: TenantTx,
  deps: { deploymentKeys: DeploymentKeys },
  viewer: { orgId: string; userId: string },
  input: { connectionId: string; title: string; brief: string },
): Promise<string> {
  const choice = await defaultChoice(tx, viewer.orgId, deps.deploymentKeys);
  const threadId = uuidv7();
  const messageId = uuidv7();
  const runId = uuidv7();
  await tx.execute(sql`
    insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${viewer.orgId}, ${threadId}, ${input.connectionId}, ${viewer.userId}, ${input.title.slice(0, 80)},
      'modeler', 'private')`);
  await tx.execute(sql`
    insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
    values (${viewer.orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, viewer.orgId, threadId)}, 'user',
      ${viewer.userId}, ${JSON.stringify({ role: "user", content: input.brief })}::jsonb, ${input.brief})`);
  await tx.execute(sql`
    insert into app.run (org_id, id, thread_id, trigger, profile, input_message_id, model, provider, reasoning)
    values (${viewer.orgId}, ${runId}, ${threadId}, 'user', 'modeler', ${messageId}, ${choice.model}, ${choice.provider},
      ${choice.reasoning})`);
  return runId;
}

/** One draft as `propose_definitions` gives it: YAML in the spec format, and why it's drafted so. */
export interface Draft {
  yaml: string;
  why?: string;
}

/** The Modeler's drafts as `propose_definitions` gives them: datasets first, so a metric can read one drafted with it. */
export interface DraftInput {
  datasets?: Draft[];
  metrics?: Draft[];
  /** Why these drafts, for the reviewer (a draft from a query); each draft's own why goes with it. */
  rationale?: string;
}

export interface DraftResult {
  /** Every draft of this call passed (validated and tested). */
  accepted: boolean;
  /**
   * The run can end: a draft from a query, once its drafts passed and include a metric. A run over a source's tables
   * ends when the Modeler says it's done (`finish_drafting`), never on a call's result.
   */
  final: boolean;
  /** The proposal's drafts now: the ones kept from earlier calls and this one's that passed. */
  kept: { kind: DefinitionKind; slug: string; title: string; checks: DefinitionDerived["status"] | "untested" }[];
  /**
   * This call's own drafts that are kept: what a drafter wrote, read from the ledger rather than told,
   * among a proposal other drafters write to as well.
   */
  mine: { kind: DefinitionKind; slug: string; title: string }[];
  /** What this call's drafts that didn't pass need, each naming its draft. */
  problems: string[];
}

const uuids = (ids: string[]) => `{${ids.join(",")}}`;
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

/** A draft's name in its YAML (a dataset's ref, a metric's name); null when it has none. */
const nameIn = (body: string) => /^(?:ref|name):\s*([a-z][a-z0-9_]*)\s*$/m.exec(body)?.[1] ?? null;

/** A draft this call wrote: a new item, or the next version of one it kept (a repair, with the version it replaced). */
/** A draft this call wrote: a new item, or the next version of one it kept (a repair, with the version it replaced). */
type Written = { id: string; version: number; previous: { version: number; title: string } | null };

/**
 * `propose_definitions`' work. Each draft is validated against the source's other definitions and installed as
 * proposed (`source: modeler`, pointing at the run's proposal, its why as the change note), then data-tested. A draft
 * named like one the run kept is a repair: the kept draft's next version, so a repair that fails leaves the version
 * that passed. A draft that fails validation or a test is taken back, and its problems are returned for the Modeler to
 * fix.
 */
export async function draftDefinitions(
  deps: GatewayDeps,
  /**
   * The run whose proposal it drafts into; and, for a drafter, the drafter itself, which writes into its
   * lead's proposal beside its siblings and repairs only the drafts it wrote.
   */
  run: { orgId: string; runId: string; connectionId: string; authorRunId?: string },
  input: DraftInput,
  options: { signal?: AbortSignal } = {},
): Promise<DraftResult> {
  // Datasets others in this call relate to go first, so a relationship to one proposed beside it holds.
  const targets = new Set(
    (input.datasets ?? []).flatMap((d) => [...d.yaml.matchAll(/\bto:\s*["']?([a-z][a-z0-9_]*)/g)].map((m) => m[1])),
  );
  const datasets = [...(input.datasets ?? [])].sort(
    (a, b) => Number(targets.has(nameIn(b.yaml) ?? "")) - Number(targets.has(nameIn(a.yaml) ?? "")),
  );
  const drafts = [
    ...datasets.map((d) => ({ kind: "dataset" as const, ...d })),
    ...(input.metrics ?? []).map((d) => ({ kind: "metric" as const, ...d })),
  ].filter((d) => d.yaml.trim());
  const problems: string[] = [];
  const made = await deps.withTenant(run.orgId, async (tx) => {
    const [p] = await tx.execute<{
      id: string;
      items: string[];
      requested_by: string | null;
      from_query_run_id: string | null;
    }>(sql`
      select id, items, requested_by, from_query_run_id from app.proposal
      where org_id = ${run.orgId} and run_id = ${run.runId} and status = 'drafting' for update`);
    if (!p) {
      problems.push("There's no draft request for this run.");
      return null;
    }
    if (!drafts.length) problems.push("Propose at least one dataset or metric.");
    // The drafts it kept, and whether each is still its own to repair: not approved, not edited by a person since, and
    // for a drafter, one it wrote (a sibling's draft is the sibling's).
    const author = run.authorRunId ?? null;
    const kept = p.items.length
      ? await tx.execute<{
          id: string;
          kind: DefinitionKind;
          slug: string;
          title: string;
          version: number;
          own: boolean;
          sibling: boolean;
        }>(sql`
          select i.id, i.kind, i.slug, i.title, i.current_version as version,
            (i.released_version is null and i.status in ('proposed', 'needs_review') and v.source = 'modeler'
              and v.proposal_id is not distinct from ${p.id}
              and (${author}::uuid is null or v.author_run_id = ${author}::uuid)) as own,
            (${author}::uuid is not null and v.source = 'modeler' and v.proposal_id is not distinct from ${p.id}
              and v.author_run_id is distinct from ${author}::uuid) as sibling
          from app.context_item i
          join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
          where i.org_id = ${run.orgId} and i.id = any(${uuids(p.items)}::uuid[]) and i.deleted_at is null`)
      : [];
    const written: Written[] = [];
    for (const d of drafts) {
      const named = kept.find((k) => k.kind === d.kind && k.slug === nameIn(d.yaml));
      // The Modeler never changes an approved definition, or a person's edit of its draft: that one is theirs now.
      if (named && !named.own) {
        problems.push(
          named.sibling
            ? `The ${d.kind} ${named.slug} is another helper's draft in this batch: give yours another name, or relate to it.`
            : `The ${d.kind} ${named.slug} was approved or edited by a person while you drafted: leave it as it is.`,
        );
        continue;
      }
      const repairs = named;
      const checked = await validateDefinition(tx, run, {
        kind: d.kind,
        connectionId: run.connectionId,
        body: d.yaml,
        ...(repairs ? { id: repairs.id } : {}),
      });
      if (!checked.ok) {
        problems.push(...checked.problems.map((m) => `The ${d.kind} ${nameIn(d.yaml) ?? "(unnamed)"}: ${m}`));
        continue;
      }
      // A drafted dataset says what it is and when to use it: the analyst and its reviewer read only that.
      if (d.kind === "dataset") {
        const spec = checked.spec as { description?: string; usage_guidance?: string };
        const missing = [
          spec.description ? null : "a description (what one row is and what it holds)",
          spec.usage_guidance ? null : "usage_guidance (when to use it, and when not to)",
        ].filter(Boolean);
        if (missing.length) {
          problems.push(`The dataset ${checked.slug}: give it ${missing.join(" and ")}, a sentence or two each.`);
          continue;
        }
      }
      const why = d.why?.trim() || null;
      if (repairs) {
        // Its versions are numbered on from the last one, a failed repair's included.
        const [v] = await tx.execute<{ next: number }>(sql`
          select coalesce(max(version), 0) + 1 as next from app.context_item_version
          where org_id = ${run.orgId} and item_id = ${repairs.id}`);
        const version = v?.next ?? repairs.version + 1;
        await tx.execute(sql`
          insert into app.context_item_version
            (org_id, item_id, version, body, body_hash, spec, source, author_id, change_note, proposal_id, author_run_id)
          values (${run.orgId}, ${repairs.id}, ${version}, ${d.yaml}, ${hash(d.yaml)}, ${JSON.stringify(checked.spec)}::jsonb,
            'modeler', ${p.requested_by}, ${why}, ${p.id}, ${author})`);
        await tx.execute(sql`
          update app.context_item set current_version = ${version}, title = ${checked.spec.label}, updated_at = now()
          where org_id = ${run.orgId} and id = ${repairs.id}`);
        written.push({ id: repairs.id, version, previous: { version: repairs.version, title: repairs.title } });
        continue;
      }
      const id = uuidv7();
      await tx.execute(sql`
        insert into app.context_item (org_id, id, kind, connection_id, path, slug, title, owner_id, status, current_version)
        values (${run.orgId}, ${id}, ${d.kind}, ${run.connectionId}, ${pathOf(run.connectionId, d.kind, checked.slug)},
          ${checked.slug}, ${checked.spec.label}, ${p.requested_by}, 'proposed', 1)`);
      await tx.execute(sql`
        insert into app.context_item_version
          (org_id, item_id, version, body, body_hash, spec, source, author_id, change_note, proposal_id, author_run_id)
        values (${run.orgId}, ${id}, 1, ${d.yaml}, ${hash(d.yaml)}, ${JSON.stringify(checked.spec)}::jsonb, 'modeler',
          ${p.requested_by}, ${why}, ${p.id}, ${author})`);
      written.push({ id, version: 1, previous: null });
    }
    const added = written.filter((w) => !w.previous).map((w) => w.id);
    await tx.execute(sql`
      update app.proposal set items = items || ${uuids(added)}::uuid[],
        rationale = coalesce(${input.rationale?.trim() || null}, rationale)
      where org_id = ${run.orgId} and id = ${p.id}`);
    return { proposalId: p.id, written, fromQuery: p.from_query_run_id !== null };
  });
  if (!made) return { accepted: false, final: false, kept: [], mine: [], problems };
  // Stopped partway (the call ran out of time, or the run ended): the clean-up below still runs, and what the checks
  // didn't reach counts as failing, so a new draft goes and a repair goes back. Then the stop goes on to the caller.
  let stopped: unknown = null;
  // Only what this call wrote: drafters writing to the same proposal in parallel test their own.
  const writtenIds = made.written.map((w) => w.id);
  if (made.written.length) {
    try {
      await checkDefinitions(
        deps,
        { orgId: run.orgId, connectionId: run.connectionId },
        { ...options, only: writtenIds },
      );
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      stopped = error;
    }
  }
  /** Versions a repair went back to whose tests never ran: tested after the revert commits, then judged. */
  const restored: { id: string; version: number }[] = [];
  const retest = await deps.withTenant(run.orgId, async (tx) => {
    const [p] = await tx.execute<{ items: string[] }>(sql`
      select items from app.proposal where org_id = ${run.orgId} and id = ${made.proposalId}`);
    const rows = await tx.execute<{
      id: string;
      kind: DefinitionKind;
      slug: string;
      title: string;
      version: number;
      derived: DefinitionDerived | null;
    }>(sql`
      select i.id, i.kind, i.slug, i.title, i.current_version as version, v.derived from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.org_id = ${run.orgId} and i.id = any(${uuids(p?.items ?? [])}::uuid[]) and i.deleted_at is null`);
    const passed = (d: DefinitionDerived | null) => d?.status === "passed" || d?.status === "needs_review";
    // Only drafts still at the version this call wrote: a newer one (the same author's next call, since a sibling's
    // name is refused) is that call's to judge, and its tests may not have run yet.
    const failing = rows.filter(
      (i) => made.written.some((w) => w.id === i.id && w.version === i.version) && !passed(i.derived),
    );
    for (const i of failing) {
      problems.push(
        ...(i.derived?.checks ?? [{ name: "Its tests", status: "failed" as const, detail: "They didn't run." }])
          .filter((c) => c.status === "failed")
          .map((c) => `${i.title} (${i.kind}): ${c.name} failed${c.detail ? `: ${c.detail}` : ""}.`),
      );
    }
    // A new draft that failed goes; a repair that failed goes back to the version it replaced.
    const repaired = made.written.filter((w) => w.previous && failing.some((i) => i.id === w.id));
    for (const w of repaired) {
      // Only while it's still the version this call wrote: a later repair's isn't undone by this one's failed test.
      await tx.execute(sql`
        update app.context_item set current_version = ${w.previous?.version ?? 1}, title = ${w.previous?.title ?? ""},
          updated_at = now()
        where org_id = ${run.orgId} and id = ${w.id} and current_version = ${w.version}`);
    }
    await dropWritten(
      tx,
      run.orgId,
      made.proposalId,
      failing.filter((i) => !repaired.some((w) => w.id === i.id)).map((i) => ({ id: i.id, version: i.version })),
    );
    // The metrics on a dataset whose repair failed were tested against the repair: they're tested again against the
    // version it went back to.
    const back = rows.filter((i) => i.kind === "dataset" && repaired.some((w) => w.id === i.id)).map((i) => i.slug);
    // The version a repair went back to is judged too: it may be a parallel call's of the same author's, which that
    // call never judged. One that failed is taken back; one whose tests never ran is tested, and judged after.
    const landed = repaired.length
      ? await tx.execute<{
          id: string;
          kind: DefinitionKind;
          title: string;
          version: number;
          derived: DefinitionDerived | null;
        }>(sql`
          select i.id, i.kind, i.title, i.current_version as version, v.derived from app.context_item i
          join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
          where i.org_id = ${run.orgId} and i.id = any(${uuids(repaired.map((w) => w.id))}::uuid[])
            and i.deleted_at is null`)
      : [];
    const backTo = landed.filter((i) => repaired.some((w) => w.id === i.id && w.previous?.version === i.version));
    const failedToo = backTo.filter((i) => i.derived && !passed(i.derived));
    for (const i of failedToo)
      problems.push(`${i.title} (${i.kind}): the version it went back to failed its tests too.`);
    await dropWritten(
      tx,
      run.orgId,
      made.proposalId,
      failedToo.map((i) => ({ id: i.id, version: i.version })),
    );
    restored.push(...backTo.filter((i) => !i.derived).map((i) => ({ id: i.id, version: i.version })));
    // Checks that stopped wrote nothing (their results are saved once all have run), so the metrics' results are
    // still those of the version the dataset went back to.
    if ((!back.length && !restored.length) || stopped) return [];
    if (!back.length) return restored.map((r) => r.id);
    const reset = await tx.execute<{ item_id: string }>(sql`
      update app.context_item_version v set derived = null
      from app.context_item i
      where i.org_id = ${run.orgId} and i.connection_id = ${run.connectionId} and i.kind = 'metric'
        and i.deleted_at is null and v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        and v.spec->>'dataset' = any(${`{${back.join(",")}}`}::text[])
      returning v.item_id`);
    return [...reset.map((r) => r.item_id), ...restored.map((r) => r.id)];
  });
  if (stopped) throw stopped;
  // After the revert is committed, so the tests read the version that passed: the metrics it reset, only.
  if (retest.length) {
    await checkDefinitions(deps, { orgId: run.orgId, connectionId: run.connectionId }, { ...options, only: retest });
  }
  if (restored.length) {
    await deps.withTenant(run.orgId, async (tx) => {
      const tested = await tx.execute<{
        id: string;
        kind: DefinitionKind;
        title: string;
        version: number;
        status: string | null;
      }>(sql`
        select i.id, i.kind, i.title, i.current_version as version, v.derived->>'status' as status
        from app.context_item i
        join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        where i.org_id = ${run.orgId} and i.id = any(${uuids(restored.map((r) => r.id))}::uuid[]) and i.deleted_at is null`);
      const failing = tested.filter(
        (i) =>
          restored.some((r) => r.id === i.id && r.version === i.version) &&
          i.status !== "passed" &&
          i.status !== "needs_review",
      );
      for (const i of failing) {
        problems.push(`${i.title} (${i.kind}): the version it went back to failed its tests too.`);
      }
      await dropWritten(
        tx,
        run.orgId,
        made.proposalId,
        failing.map((i) => ({ id: i.id, version: i.version })),
      );
    });
  }
  return deps.withTenant(run.orgId, async (tx) => {
    const kept = await tx.execute<{
      id: string;
      kind: DefinitionKind;
      slug: string;
      title: string;
      version: number;
      derived: DefinitionDerived | null;
    }>(sql`
      select i.id, i.kind, i.slug, i.title, i.current_version as version, v.derived from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      join app.proposal p on p.org_id = i.org_id and p.id = ${made.proposalId} and i.id = any(p.items)
      where i.org_id = ${run.orgId} and i.deleted_at is null
      order by i.kind, i.slug`);
    // A draft of this call whose tests haven't run isn't one that passed (another drafter's may be under test now). A
    // draft is this call's while it's at the version this call wrote.
    const wrote = new Map(made.written.map((w) => [w.id, w.version]));
    const ownNow = (k: { id: string; version: number }) => wrote.get(k.id) === k.version;
    for (const i of kept.filter((k) => !k.derived && ownNow(k))) {
      problems.push(`${i.title} (${i.kind}): its tests didn't run. Propose it again.`);
    }
    const accepted = problems.length === 0 && kept.length > 0;
    const metric = kept.find((i) => i.kind === "metric");
    return {
      accepted,
      final: made.fromQuery && accepted && metric !== undefined,
      kept: kept.map((i) => ({
        kind: i.kind,
        slug: i.slug,
        title: i.title,
        checks: i.derived ? i.derived.status : "untested",
      })),
      mine: kept.filter((i) => ownNow(i) && i.derived).map((i) => ({ kind: i.kind, slug: i.slug, title: i.title })),
      problems,
    };
  });
}

/** Takes some of a proposal's drafts back: they're deleted (unless released), and dropped from its items. */
async function drop(tx: TenantTx, orgId: string, proposalId: string, ids: string[]) {
  if (!ids.length) return;
  await tx.execute(sql`
    update app.context_item set deleted_at = now(), updated_at = now()
    where org_id = ${orgId} and id = any(${uuids(ids)}::uuid[]) and released_version is null`);
  await tx.execute(sql`
    update app.proposal set items = coalesce(
      (select array_agg(x) from unnest(items) x where x <> all(${uuids(ids)}::uuid[])), '{}')
    where org_id = ${orgId} and id = ${proposalId}`);
}

/**
 * Takes back drafts a drafting call wrote that failed, each only while it's still the version that call wrote: a newer
 * version (a later call's) stays, and so does its place in the proposal.
 */
async function dropWritten(tx: TenantTx, orgId: string, proposalId: string, drafts: { id: string; version: number }[]) {
  if (!drafts.length) return;
  const gone = await tx.execute<{ id: string }>(sql`
    update app.context_item i set deleted_at = now(), updated_at = now()
    from unnest(${uuids(drafts.map((d) => d.id))}::uuid[], ${`{${drafts.map((d) => d.version).join(",")}}`}::int[])
      as d(id, version)
    where i.org_id = ${orgId} and i.id = d.id and i.current_version = d.version and i.released_version is null
    returning i.id`);
  if (!gone.length) return;
  await tx.execute(sql`
    update app.proposal set items = coalesce(
      (select array_agg(x) from unnest(items) x where x <> all(${uuids(gone.map((g) => g.id))}::uuid[])), '{}')
    where org_id = ${orgId} and id = ${proposalId}`);
}

/** Takes all of a proposal's drafts back (a failed run, a rejection). */
async function takeBack(tx: TenantTx, orgId: string, proposalId: string, ids: string[]) {
  await drop(tx, orgId, proposalId, ids);
  await tx.execute(sql`update app.proposal set items = '{}' where org_id = ${orgId} and id = ${proposalId}`);
}

/**
 * Settles a proposal once its Modeler run ended: open for review when it proposed definitions that passed their
 * tests, else failed with the reason (the Modeler's own when it said it couldn't draft one).
 */
export async function settleProposal(
  deps: { withTenant: GatewayDeps["withTenant"] },
  orgId: string,
  runId: string,
): Promise<ProposalStatus | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [r] = await tx.execute<{
      status: string;
      error: string | null;
      outcome: {
        kind?: string;
        status?: string;
        reason?: string;
        leftOut?: { name: string; reason: string }[];
      } | null;
    }>(sql`select status, error, outcome from app.run where org_id = ${orgId} and id = ${runId}`);
    if (!r || !["succeeded", "failed", "cancelled"].includes(r.status)) return null;
    const [p] = await tx.execute<{
      id: string;
      items: string[];
      evidence: ProposalEvidence;
      from_query_run_id: string | null;
    }>(sql`
      select id, items, evidence, from_query_run_id from app.proposal
      where org_id = ${orgId} and run_id = ${runId} and status = 'drafting'`);
    if (!p) return null;
    const leftOut = r.outcome?.leftOut?.length ? { leftOut: r.outcome.leftOut } : {};
    // A batch over a source's tables opens only with drafts that passed, however its run ended: one that failed, or
    // was never tested (a run stopped early, a clean-up a parallel call didn't get to), goes back.
    if (p.from_query_run_id === null && p.items.length > 0) {
      const untested = await tx.execute<{ id: string }>(sql`
        select i.id from app.context_item i
        join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        where i.org_id = ${orgId} and i.id = any(${uuids(p.items)}::uuid[])
          and coalesce(v.derived->>'status', '') not in ('passed', 'needs_review')`);
      if (untested.length) {
        await drop(
          tx,
          orgId,
          p.id,
          untested.map((u) => u.id),
        );
        p.items = p.items.filter((id) => !untested.some((u) => u.id === id));
      }
    }
    const proposed = r.outcome?.kind === "modeler" && r.outcome.status === "proposed" && p.items.length > 0;
    const stopped =
      !proposed && p.from_query_run_id === null && p.items.length > 0
        ? { stopped: r.outcome?.reason ?? r.error ?? "It stopped before it finished." }
        : null;
    if (proposed || stopped) {
      await tx.execute(sql`
        update app.proposal set status = 'open', evidence = evidence || ${JSON.stringify({ ...leftOut, ...stopped })}::jsonb
        where org_id = ${orgId} and id = ${p.id}`);
      return "open";
    }
    if (p.items.length) await takeBack(tx, orgId, p.id, p.items);
    const failed =
      r.outcome?.reason ??
      (r.outcome?.kind === "modeler" && r.outcome.status === "proposed"
        ? "None of its drafts passed their tests."
        : null) ??
      (r.status === "cancelled" ? "It was stopped before it proposed a definition." : r.error) ??
      "It stopped before it proposed a definition.";
    await tx.execute(sql`
      update app.proposal set status = 'failed', decided_at = now(),
        evidence = ${JSON.stringify({ ...p.evidence, ...leftOut, failed })}::jsonb
      where org_id = ${orgId} and id = ${p.id}`);
    return "failed";
  });
}

type ProposalRow = {
  id: string;
  status: ProposalStatus;
  title: string;
  connection_id: string;
  connection_name: string;
  rationale: string | null;
  evidence: ProposalEvidence;
  held_reason: string | null;
  note: string | null;
  from_query_run_id: string | null;
  items: string[];
  requested_by: string | null;
  reviewer_id: string | null;
  created_at: string;
  decided_at: string | null;
  tables: string[];
  visible: boolean;
  sql: string | null;
};

/**
 * Whether the viewer reads a proposal's origin: the conversation its query was asked in. A source's drafts come from
 * its tables, which everyone who sees the source sees.
 */
const originReadable = (userId: string) => sql`(case when p.from_query_run_id is null
    then true
    else exists (
      select 1 from app.query_run q
      join app.run r on r.org_id = q.org_id and r.id = q.requester_id
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where q.org_id = p.org_id and q.id = p.from_query_run_id and q.requester_type = 'run' and ${visibleTo(userId)})
  end)`;

const selectProposals = (viewer: { orgId: string; userId: string }) => sql`
  select p.id, p.status, p.title, p.connection_id, c.name as connection_name, p.rationale, p.evidence, p.held_reason,
    p.note, p.from_query_run_id, p.items, p.tables,
    p.requested_by, p.reviewer_id, p.created_at, p.decided_at, ${originReadable(viewer.userId)} as visible,
    (select coalesce(q.written_sql, q.compiled_sql) from app.query_run q
      where q.org_id = p.org_id and q.id = p.from_query_run_id) as sql
  from app.proposal p
  join app.connection c on c.org_id = p.org_id and c.id = p.connection_id
  where p.org_id = ${viewer.orgId} and p.source = 'modeler'`;

async function viewsOf(tx: TenantTx, orgId: string, rows: ProposalRow[]): Promise<ProposalView[]> {
  const ids = [...new Set(rows.flatMap((r) => r.items))];
  const items = ids.length
    ? await tx.execute<{
        id: string;
        kind: DefinitionKind;
        slug: string;
        title: string;
        status: DefinitionStatus;
        body: string;
        spec: unknown;
        derived: DefinitionDerived | null;
        change_note: string | null;
      }>(sql`
        select i.id, i.kind, i.slug, i.title, i.status, v.body, v.spec, v.derived, v.change_note from app.context_item i
        join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        where i.org_id = ${orgId} and i.id = any(${`{${ids.join(",")}}`}::uuid[]) and i.deleted_at is null`)
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    title: r.visible ? r.title : null,
    connectionId: r.connection_id,
    connectionName: r.connection_name,
    rationale: r.visible ? r.rationale : null,
    evidence: r.visible ? (r.evidence ?? {}) : {},
    heldReason: r.held_reason,
    note: r.note,
    from: r.visible ? { visible: true, queryRunId: r.from_query_run_id } : { visible: false, queryRunId: null },
    sql: r.visible ? r.sql : null,
    tables: r.tables,
    items: r.items.flatMap((id) => {
      const i = byId.get(id);
      return i
        ? [
            {
              id: i.id,
              kind: i.kind,
              slug: i.slug,
              title: i.title,
              status: i.status,
              body: i.body,
              spec: i.spec,
              checks: i.derived,
              why: i.change_note,
            },
          ]
        : [];
    }),
    requestedBy: r.requested_by,
    reviewerId: r.reviewer_id,
    createdAt: new Date(r.created_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
  }));
}

/**
 * The Modeler's proposals (Knowledge → Proposals) as the viewer sees them: in review first, then the last
 * decided, newest first.
 */
export async function listProposals(tx: TenantTx, viewer: { orgId: string; userId: string }): Promise<ProposalView[]> {
  const rows = await tx.execute<ProposalRow>(sql`
    ${selectProposals(viewer)}
    order by (p.status in ('drafting', 'open', 'held')) desc, p.created_at desc limit 40`);
  return viewsOf(tx, viewer.orgId, rows);
}

export async function getProposal(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
): Promise<ProposalView | null> {
  if (!isUuid(id)) return null;
  const rows = await tx.execute<ProposalRow>(sql`${selectProposals(viewer)} and p.id = ${id}`);
  return (await viewsOf(tx, viewer.orgId, rows))[0] ?? null;
}

/** Locks a proposal that's in review, or says why it can't be decided. */
async function inReview(tx: TenantTx, orgId: string, id: string) {
  if (!isUuid(id)) throw new ProposalProblem("not_found", "That proposal doesn't exist.");
  const [p] = await tx.execute<{ status: ProposalStatus; items: string[] }>(sql`
    select status, items from app.proposal where org_id = ${orgId} and id = ${id} and source = 'modeler' for update`);
  if (!p) throw new ProposalProblem("not_found", "That proposal doesn't exist.");
  if (p.status !== "open") throw new ProposalProblem("invalid", `This proposal isn't in review: it's ${p.status}.`);
  return p;
}

/**
 * Approves a proposal (an owner's or admin's call; the caller checks the role): its definitions are verified at their
 * current versions (an edit in review included), which releases them for Ask, dashboards and routines. All or none:
 * a draft that hasn't passed its tests stops it.
 */
export async function approveProposal(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
): Promise<{ verified: string[] }> {
  const p = await inReview(tx, viewer.orgId, id);
  const verified = await verifyDefinitions(tx, viewer, p.items);
  // A draft verified on its own page already (at the version under review) counts as approved too: only one still
  // waiting, or nothing left at all, stops it.
  const [left] = await tx.execute<{ waiting: number; released: number }>(sql`
    select count(*) filter (where released_version is distinct from current_version)::int as waiting,
      count(*) filter (where released_version = current_version)::int as released
    from app.context_item
    where org_id = ${viewer.orgId} and id = any(${`{${p.items.join(",")}}`}::uuid[]) and deleted_at is null`);
  if (!left || left.waiting > 0 || left.released === 0) {
    throw new ProposalProblem(
      "invalid",
      "A draft hasn't passed its tests at its current version: fix it, then approve.",
    );
  }
  await tx.execute(sql`
    update app.proposal set status = 'approved', reviewer_id = ${viewer.userId}, decided_at = now()
    where org_id = ${viewer.orgId} and id = ${id}`);
  return { verified };
}

/** Rejects a proposal with the reviewer's note: its drafts are deleted, and the note stays for the next draft. */
export async function rejectProposal(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
  note: string,
): Promise<void> {
  const p = await inReview(tx, viewer.orgId, id);
  await takeBack(tx, viewer.orgId, id, p.items);
  await tx.execute(sql`
    update app.proposal set status = 'rejected', reviewer_id = ${viewer.userId}, decided_at = now(),
      note = ${note.trim().slice(0, 1000) || null}
    where org_id = ${viewer.orgId} and id = ${id}`);
}
