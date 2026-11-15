/**
 * Datasets and metrics as governed items (context_item / context_item_version): installing a pack as
 * proposals, verifying them, and loading what's verified for a source as a semantic model.
 *
 * No releases yet: the agent reads each verified item's current version, and every metric query records the
 * versions it compiled from (query_run.semantic).
 */
import { createHash } from "node:crypto";
import { type SQL, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { parse as parseYaml } from "yaml";
import { audit } from "../audit/write";
import { enqueueOnce } from "../jobs/boss";
import { definitionChecksQueue } from "../jobs/queues";
import { visibleTo } from "../runs/ledger";
import type { DefinitionDerived } from "./checks";
import { modelFromYaml } from "./load";
import { buildModel, type SemanticModel, withoutDangling } from "./model";
import { DatasetSpec, MetricSpec, parseSpec } from "./spec";

export type DefinitionKind = "dataset" | "metric";
export type DefinitionStatus = "draft" | "proposed" | "verified" | "needs_review" | "deprecated";

/** What a definition's checks found at its current version (null while they haven't run). */
export type CheckStatus = "passed" | "needs_review" | "failed";

export interface DefinitionSummary {
  id: string;
  kind: DefinitionKind;
  slug: string;
  title: string;
  description: string | null;
  connectionId: string;
  connectionName: string;
  ownerId: string | null;
  status: DefinitionStatus;
  version: number;
  /** The version Ask uses (the last one approved), or null when none was. */
  releasedVersion: number | null;
  checks: CheckStatus | null;
  /** A dataset's grain and number of measures; a metric's dataset (its ref). */
  grain: string | null;
  measures: number;
  dataset: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  updatedAt: string;
}

const pathOf = (connectionId: string, kind: DefinitionKind, slug: string) =>
  `/sources/${connectionId}/${kind === "dataset" ? "models" : "metrics"}/${slug}.yaml`;

/**
 * Adds a pack's datasets and metrics to a source, each as version 1 with the given status (a starter pack is
 * proposed; an admin verifies it). Items that already exist are left alone, so installing twice changes nothing.
 * Returns how many were added.
 */
export async function installDefinitions(
  tx: TenantTx,
  ctx: { orgId: string; userId: string | null },
  connectionId: string,
  pack: { datasets: string[]; metrics: string[] },
  options: { status: DefinitionStatus; source: "pack" | "import" | "user" },
): Promise<number> {
  const built = modelFromYaml(pack.datasets, pack.metrics);
  if (!built.ok) throw new Error(`The pack doesn't hold together: ${built.problems.join(" ")}`);
  const items: { kind: DefinitionKind; slug: string; title: string; body: string; spec: unknown }[] = [
    ...pack.datasets.map((body) => {
      const spec = (parseSpec(DatasetSpec, body) as { ok: true; spec: DatasetSpec }).spec;
      return { kind: "dataset" as const, slug: spec.ref, title: spec.label, body, spec };
    }),
    ...pack.metrics.map((body) => {
      const spec = (parseSpec(MetricSpec, body) as { ok: true; spec: MetricSpec }).spec;
      return { kind: "metric" as const, slug: spec.name, title: spec.label, body, spec };
    }),
  ];
  let added = 0;
  for (const item of items) {
    const id = uuidv7();
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into app.context_item (org_id, id, kind, connection_id, path, slug, title, owner_id, status,
        current_version, released_version, verified_by, verified_at)
      values (${ctx.orgId}, ${id}, ${item.kind}, ${connectionId}, ${pathOf(connectionId, item.kind, item.slug)},
        ${item.slug}, ${item.title}, ${ctx.userId}, ${options.status}, 1,
        ${options.status === "verified" ? 1 : null},
        ${options.status === "verified" ? ctx.userId : null}, ${options.status === "verified" ? sql`now()` : null})
      on conflict do nothing
      returning id`);
    if (!row) continue;
    await tx.execute(sql`
      insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source, author_id)
      values (${ctx.orgId}, ${id}, 1, ${item.body}, ${createHash("sha256").update(item.body).digest("hex")},
        ${JSON.stringify(item.spec)}::jsonb, ${options.source}, ${ctx.userId})`);
    added++;
  }
  return added;
}

/** A source's datasets and metrics (or every source's), with their status: Knowledge's lists. */
export async function listDefinitions(
  tx: TenantTx,
  orgId: string,
  filter: { connectionId?: string; kind?: DefinitionKind; status?: DefinitionStatus } = {},
): Promise<DefinitionSummary[]> {
  return listDefinitionRows(
    tx,
    orgId,
    sql`${filter.connectionId ? sql`and i.connection_id = ${filter.connectionId}` : sql``}
      ${filter.kind ? sql`and i.kind = ${filter.kind}` : sql``}
      ${filter.status ? sql`and i.status = ${filter.status}` : sql``}`,
  );
}

async function listDefinitionRows(tx: TenantTx, orgId: string, where: SQL) {
  const rows = await tx.execute<{
    id: string;
    kind: DefinitionKind;
    slug: string;
    title: string;
    description: string | null;
    connection_id: string;
    connection_name: string;
    owner_id: string | null;
    status: DefinitionStatus;
    current_version: number;
    released_version: number | null;
    verified_at: Date | null;
    verified_by: string | null;
    updated_at: Date;
    derived_status: CheckStatus | null;
    grain: string | null;
    measures: number;
    dataset: string | null;
  }>(sql`
    select i.id, i.kind, i.slug, i.title, v.spec->>'description' as description, i.connection_id,
      c.name as connection_name, i.owner_id, i.status, i.current_version, i.released_version, i.verified_at, i.verified_by, i.updated_at,
      v.derived->>'status' as derived_status, v.spec->>'grain' as grain,
      coalesce(jsonb_array_length(v.spec->'measures'), 0)::int as measures, v.spec->>'dataset' as dataset
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id and c.deleted_at is null
    where i.org_id = ${orgId} and i.deleted_at is null and i.kind in ('dataset', 'metric') ${where}
    order by i.kind, i.title`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    description: r.description,
    connectionId: r.connection_id,
    connectionName: r.connection_name,
    ownerId: r.owner_id,
    status: r.status,
    version: r.current_version,
    releasedVersion: r.released_version,
    checks: r.derived_status,
    grain: r.grain,
    measures: r.measures,
    dataset: r.dataset,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    verifiedBy: r.verified_by,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

/**
 * Verifies definitions at their current version (an admin's call; the caller checks the role), which makes that
 * version the released one Ask uses. Only a version that passed its tests, and a metric only with its dataset, so a
 * released metric never points at a dataset that isn't. Returns the ids verified.
 */
export async function verifyDefinitions(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  ids: string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const list = sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  const rows = await tx.execute<{ id: string; kind: string; title: string; version: number }>(sql`
    update app.context_item i set status = 'verified', released_version = i.current_version,
      verified_by = ${ctx.userId}, verified_at = now(), updated_at = now()
    where i.org_id = ${ctx.orgId} and i.id in ${list} and i.deleted_at is null
      and i.status in ('draft', 'proposed', 'needs_review')
      -- Only a version that passed its tests (a warning is the reviewer's call).
      and exists (
        select 1 from app.context_item_version cv
        where cv.org_id = i.org_id and cv.item_id = i.id and cv.version = i.current_version
          and cv.derived->>'status' in ('passed', 'needs_review'))
      and (i.kind <> 'metric' or exists (
        select 1 from app.context_item_version v
        join app.context_item d on d.org_id = v.org_id and d.kind = 'dataset' and d.connection_id = i.connection_id
          and d.slug = v.spec->>'dataset' and d.deleted_at is null
          and (d.released_version is not null or d.id in ${list})
        where v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version))
    returning i.id, i.kind, i.title, i.current_version as version`);
  for (const r of rows) {
    await audit(tx, {
      action: "knowledge.published",
      actor: { type: "user", id: ctx.userId },
      target: { type: "knowledge", id: r.id, name: r.title },
      detail: { kind: r.kind, version: r.version },
    });
  }
  if (rows.length) await closeDecidedProposals(tx, ctx);
  return rows.map((r) => r.id);
}

/**
 * Closes the proposals that have nothing left to review: approved when any of their drafts was, rejected when none
 * was (each one rejected or deleted). A draft from a query too: its drafts verified on their own pages decide it, so
 * its card doesn't wait in review for an Approve with nothing left to do.
 */
export async function closeDecidedProposals(tx: TenantTx, ctx: { orgId: string; userId: string }): Promise<void> {
  await tx.execute(sql`
    update app.proposal p set decided_at = now(), reviewer_id = ${ctx.userId},
      status = case when exists (
        select 1 from app.context_item i
        where i.org_id = p.org_id and i.id = any(p.items) and i.released_version is not null
      ) then 'approved' else 'rejected' end
    where p.org_id = ${ctx.orgId} and p.status = 'open' and p.source = 'modeler'
      and not exists (
        select 1 from app.context_item i
        where i.org_id = p.org_id and i.id = any(p.items) and i.deleted_at is null
          and i.status in ('draft', 'proposed', 'needs_review'))`);
}

/**
 * The released definitions of a source don't make a model (a dataset approved without a measure a released metric
 * uses): nothing on that source compiles until one of them is fixed.
 */
export class ModelBroken extends Error {}

export interface LoadedModel {
  model: SemanticModel;
  /** Each definition the model holds, at the version it was read: what a metric query records. */
  definitions: Map<string, { id: string; kind: DefinitionKind; slug: string; version: number }>;
}

/**
 * The released datasets and metrics of a source (each at the version last approved, even while a newer draft waits),
 * as a model the compiler takes, or null when it has none (`includeUnverified` reads every current version, drafts
 * and proposals too, for the pages that show them; never for answers). A relationship to a dataset that isn't verified is left out, as is a metric whose dataset isn't, so what
 * an admin verified always compiles on its own.
 */
export async function loadSemanticModel(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  options: { includeUnverified?: boolean } = {},
): Promise<LoadedModel | null> {
  const rows = await tx.execute<{ id: string; kind: DefinitionKind; slug: string; version: number; spec: unknown }>(
    sql`
    select i.id, i.kind, i.slug, v.version, v.spec
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id
      and v.version = ${options.includeUnverified ? sql`i.current_version` : sql`i.released_version`}
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.deleted_at is null
      and ${options.includeUnverified ? sql`i.status <> 'deprecated'` : sql`i.released_version is not null`}
      and i.kind in ('dataset', 'metric')
    order by i.kind, i.slug`,
  );
  const { datasets, metrics } = withoutDangling(
    rows.filter((r) => r.kind === "dataset").map((r) => DatasetSpec.parse(r.spec)),
    rows.filter((r) => r.kind === "metric").map((r) => MetricSpec.parse(r.spec)),
  );
  if (!metrics.length) return null;
  const built = buildModel(datasets, metrics);
  if (!built.ok) throw new ModelBroken(`The verified definitions don't hold together: ${built.problems.join(" ")}`);
  const definitions = new Map(
    rows.map((r) => [`${r.kind}:${r.slug}`, { id: r.id, kind: r.kind, slug: r.slug, version: r.version }]),
  );
  return { model: built.model, definitions };
}

export interface DefinitionVersion {
  version: number;
  source: string;
  authorId: string | null;
  changeNote: string | null;
  createdAt: string;
}

export interface DefinitionDetail extends DefinitionSummary {
  body: string;
  /** The released version's YAML while a newer version waits: what the draft is shown against. */
  released: { version: number; body: string } | null;
  spec: DatasetSpec | MetricSpec;
  /** What the checks found at this version, or null while they haven't run. */
  derived: DefinitionDerived | null;
  versions: DefinitionVersion[];
  /** Conversations whose answers used it, newest first, among those the viewer can see. */
  recentAnswers: { threadId: string; title: string; at: string }[];
}

/** One definition at its current version, with its history: a definition's page. */
export async function getDefinition(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  id: string,
): Promise<DefinitionDetail | null> {
  const [summary] = await listDefinitionRows(tx, viewer.orgId, sql`and i.id = ${id}`);
  if (!summary) return null;
  const [current] = await tx.execute<{ body: string; spec: unknown; derived: unknown }>(sql`
    select body, spec, derived from app.context_item_version
    where org_id = ${viewer.orgId} and item_id = ${id} and version = ${summary.version}`);
  const versions = await tx.execute<{
    version: number;
    source: string;
    author_id: string | null;
    change_note: string | null;
    created_at: Date;
  }>(sql`
    select version, source, author_id, change_note, created_at from app.context_item_version
    where org_id = ${viewer.orgId} and item_id = ${id} order by version desc`);
  const [released] =
    summary.releasedVersion !== null && summary.releasedVersion !== summary.version
      ? await tx.execute<{ version: number; body: string }>(sql`
          select version, body from app.context_item_version
          where org_id = ${viewer.orgId} and item_id = ${id} and version = ${summary.releasedVersion}`)
      : [];
  const answers = await tx.execute<{ thread_id: string; title: string; at: Date }>(sql`
    select t.id as thread_id, t.title, max(q.created_at) as at
    from app.query_run q
    join app.run r on r.org_id = q.org_id and r.id = q.requester_id
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where q.org_id = ${viewer.orgId} and q.requester_type = 'run' and q.status = 'succeeded'
      and q.semantic->'definitions' @> ${JSON.stringify([{ id }])}::jsonb
      and t.deleted_at is null and ${visibleTo(viewer.userId)}
    group by t.id, t.title order by at desc limit 5`);
  if (!current) return null;
  return {
    ...summary,
    body: current.body,
    released: released ? { version: released.version, body: released.body } : null,
    spec: (summary.kind === "dataset" ? DatasetSpec : MetricSpec).parse(current.spec),
    derived: (current.derived ?? null) as DefinitionDetail["derived"],
    versions: versions.map((v) => ({
      version: v.version,
      source: v.source,
      authorId: v.author_id,
      changeNote: v.change_note,
      createdAt: new Date(v.created_at).toISOString(),
    })),
    recentAnswers: answers.map((a) => ({ threadId: a.thread_id, title: a.title, at: new Date(a.at).toISOString() })),
  };
}

/**
 * How far the starter pack is (the setup checklist): definitions waiting for review, and verified ones. A Modeler's
 * draft from a query (Make this a metric) isn't part of the starter pack: it's reviewed on its own card. Its drafts
 * from a source's tables (Draft definitions) are.
 */
export async function definitionCounts(tx: TenantTx, orgId: string): Promise<{ proposed: number; verified: number }> {
  const [row] = await tx.execute<{ proposed: number; verified: number }>(sql`
    select count(*) filter (where i.status = 'proposed' and not exists (
        select 1 from app.proposal p
        where p.org_id = i.org_id and i.id = any(p.items) and p.from_query_run_id is not null
      ))::int as proposed,
      count(*) filter (where i.released_version is not null)::int as verified
    from app.context_item i
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id and c.deleted_at is null
    where i.org_id = ${orgId} and i.deleted_at is null and i.kind in ('dataset', 'metric')`);
  return { proposed: row?.proposed ?? 0, verified: row?.verified ?? 0 };
}

export type SaveResult =
  | { ok: true; id: string; version: number }
  | { ok: false; problems: string[]; reason: "invalid" | "conflict" | "not_found" };

/** Which step a definition's YAML failed at, for the editor's checks: parse, spec, name, then the model. */
export type ValidationStage = "yaml" | "spec" | "name" | "model";

export type Validation =
  | {
      ok: true;
      spec: DatasetSpec | MetricSpec;
      slug: string;
      /** How many fields the YAML sets (the editor's "Matches the spec · 11 fields"). */
      fields: number;
      existing: { id: string; current_version: number; connection_id: string } | null;
      connectionId: string;
    }
  | { ok: false; stage: ValidationStage; reason: "invalid" | "conflict" | "not_found"; problems: string[] };

interface DefinitionInput {
  id?: string;
  kind: DefinitionKind;
  connectionId: string;
  body: string;
  changeNote?: string;
  expectedVersion?: number;
}

/**
 * Checks a definition the way saving does, without writing anything (the editor calls it as someone types): the YAML
 * parses, matches its kind's spec, keeps its name, and fits with the source's other definitions (every name it
 * uses, and every name that uses it, still exists). `lock` takes the item's row, for a save.
 */
export async function validateDefinition(
  tx: TenantTx,
  ctx: { orgId: string },
  input: DefinitionInput,
  options: { lock?: boolean } = {},
): Promise<Validation> {
  const parsed = input.kind === "dataset" ? parseSpec(DatasetSpec, input.body) : parseSpec(MetricSpec, input.body);
  if (!parsed.ok) {
    const yaml = parsed.problems[0]?.startsWith("Not valid YAML");
    return { ok: false, stage: yaml ? "yaml" : "spec", reason: "invalid", problems: parsed.problems };
  }
  const spec = parsed.spec as DatasetSpec | MetricSpec;
  const slug = "ref" in spec ? spec.ref : spec.name;

  let existing: { id: string; slug: string; current_version: number; connection_id: string } | undefined;
  if (input.id) {
    [existing] = await tx.execute<{ id: string; slug: string; current_version: number; connection_id: string }>(sql`
      select id, slug, current_version, connection_id from app.context_item
      where org_id = ${ctx.orgId} and id = ${input.id} and kind = ${input.kind} and deleted_at is null
      ${options.lock ? sql`for update` : sql``}`);
    if (!existing) {
      return { ok: false, stage: "name", reason: "not_found", problems: ["That definition doesn't exist."] };
    }
    if (existing.slug !== slug) {
      return {
        ok: false,
        stage: "name",
        reason: "invalid",
        problems: [`The name can't change: it's ${existing.slug}.`],
      };
    }
    if (input.expectedVersion !== undefined && existing.current_version !== input.expectedVersion) {
      return {
        ok: false,
        stage: "name",
        reason: "conflict",
        problems: [
          `Someone saved version ${existing.current_version} while you were editing version ${input.expectedVersion}. Reload to see it.`,
        ],
      };
    }
  }
  const connectionId = existing?.connection_id ?? input.connectionId;

  // The source's other definitions at their current versions, with this one in its new form.
  const others = await tx.execute<{ kind: DefinitionKind; slug: string; spec: unknown }>(sql`
    select i.kind, i.slug, v.spec from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${ctx.orgId} and i.connection_id = ${connectionId} and i.deleted_at is null
      and i.status <> 'deprecated' and i.kind in ('dataset', 'metric')`);
  if (!existing && others.some((o) => o.kind === input.kind && o.slug === slug)) {
    return {
      ok: false,
      stage: "name",
      reason: "invalid",
      problems: [`There's already a ${input.kind} named ${slug}.`],
    };
  }
  const rest = others.filter((o) => !(o.kind === input.kind && o.slug === slug));
  const datasets = [
    ...rest.filter((o) => o.kind === "dataset").map((o) => DatasetSpec.parse(o.spec)),
    ...(input.kind === "dataset" ? [spec as DatasetSpec] : []),
  ];
  const metrics = [
    ...rest.filter((o) => o.kind === "metric").map((o) => MetricSpec.parse(o.spec)),
    ...(input.kind === "metric" ? [spec as MetricSpec] : []),
  ];
  // The others as they hold together; this one is checked as written.
  const whole = withoutDangling(datasets, metrics, {
    kind: input.kind,
    name: input.kind === "dataset" ? (spec as DatasetSpec).ref : (spec as MetricSpec).name,
  });
  const built = buildModel(whole.datasets, whole.metrics);
  if (!built.ok) return { ok: false, stage: "model", reason: "invalid", problems: built.problems };
  const fields = Object.keys(parseYaml(input.body) ?? {}).length;
  return { ok: true, spec, slug, fields, existing: existing ?? null, connectionId };
}

/**
 * Saves a definition (from its page's editor, or a new one), validated as above. An edit is a new version: the Verified
 * badge clears, the released version keeps answering until the new one is approved (who approved it, and when, stay
 * with it), and its tests are queued in the same transaction. The name (the slug) is fixed once created, since paths
 * and other definitions point at it. `expectedVersion` refuses an edit made on a version someone else has since
 * replaced.
 */
export async function saveDefinition(
  deps: { boss: PgBoss },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: DefinitionInput,
): Promise<SaveResult> {
  const checked = await validateDefinition(tx, ctx, input, { lock: true });
  if (!checked.ok) return { ok: false, reason: checked.reason, problems: checked.problems };
  const { spec, slug, existing, connectionId } = checked;
  const title = spec.label;

  const id = existing?.id ?? uuidv7();
  const version = existing ? await nextVersion(tx, ctx.orgId, id) : 1;
  if (existing) {
    await tx.execute(sql`
      update app.context_item set current_version = ${version}, title = ${title}, status = 'draft', draft = null,
        updated_at = now()
      where org_id = ${ctx.orgId} and id = ${id}`);
  } else {
    await tx.execute(sql`
      insert into app.context_item (org_id, id, kind, connection_id, path, slug, title, owner_id, status,
        current_version)
      values (${ctx.orgId}, ${id}, ${input.kind}, ${connectionId}, ${pathOf(connectionId, input.kind, slug)},
        ${slug}, ${title}, ${ctx.userId}, 'draft', 1)`);
  }
  await tx.execute(sql`
    insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source, author_id,
      change_note)
    values (${ctx.orgId}, ${id}, ${version}, ${input.body}, ${createHash("sha256").update(input.body).digest("hex")},
      ${JSON.stringify(spec)}::jsonb, 'user', ${ctx.userId}, ${input.changeNote?.trim() || null})`);
  await queueDefinitionChecks(deps, tx, { orgId: ctx.orgId, connectionId });
  return { ok: true, id, version };
}

/**
 * Queues the tests of a source's definitions not tested yet, with the transaction that wrote them; `afterSeconds`
 * holds the job back (a caller testing what it wrote first leaves it nothing to do).
 */
export async function queueDefinitionChecks(
  deps: { boss: PgBoss },
  tx: TenantTx,
  job: { orgId: string; connectionId: string },
  afterSeconds?: number,
): Promise<void> {
  await enqueueOnce(deps.boss, tx, definitionChecksQueue, job, {
    singletonKey: job.connectionId,
    ...(afterSeconds ? { startAfter: afterSeconds } : {}),
  });
}

/** A definition's next version: on from its last one, a discarded draft's included. */
async function nextVersion(tx: TenantTx, orgId: string, id: string): Promise<number> {
  const [v] = await tx.execute<{ next: number }>(sql`
    select coalesce(max(version), 0) + 1 as next from app.context_item_version
    where org_id = ${orgId} and item_id = ${id}`);
  return v?.next ?? 1;
}

export type DefinitionDraftResult =
  | { ok: true; id: string; kind: DefinitionKind; slug: string; title: string; version: number }
  | {
      ok: false;
      reason: "invalid" | "conflict" | "not_found" | "forbidden" | "unchanged";
      problems: string[];
      /** On a conflict: the version now, to make the change again on. */
      current?: { version: number; body: string };
    };

/**
 * The analyst's change to a metric or dataset: a new draft version, as the YAML editor's save makes one,
 * by the person asking (source `agent`, and the run that wrote it). Only for one they attached to their own question
 * in this conversation, while they're an owner or admin (their role now, not what the run was told), and only on the
 * version it read: a version saved meanwhile is refused, with the current one to make the change again on. It never
 * releases: Ask answers with the released version until a person releases this one, after its tests pass. The caller
 * runs its tests once this has committed (`checkDefinitions`); with `boss`, the worker's job is queued with the write,
 * a minute on, to run them if the caller couldn't. The same draft made again by the same run (its call was cut off
 * after the write) is the version it made, not a conflict.
 */
export async function draftDefinitionChange(
  deps: { boss?: PgBoss | null },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: {
    kind: DefinitionKind;
    name: string;
    connectionId: string;
    threadId: string;
    runId: string;
    body: string;
    baseVersion: number;
    changeNote?: string;
  },
): Promise<DefinitionDraftResult> {
  const [member] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${ctx.userId}) as role`);
  if (member?.role !== "owner" && member?.role !== "admin") {
    return { ok: false, reason: "forbidden", problems: ["Only owners and admins change metrics and datasets."] };
  }
  const [item] = await tx.execute<{ id: string }>(sql`
    select i.id from app.context_item i
    where i.org_id = ${ctx.orgId} and i.kind = ${input.kind} and i.slug = ${input.name}
      and i.connection_id = ${input.connectionId} and i.deleted_at is null and i.scope = 'org'
      and i.status <> 'deprecated'
      and exists (
        select 1 from app.message m
        where m.org_id = i.org_id and m.thread_id = ${input.threadId} and m.role = 'user'
          and m.author_id = ${ctx.userId} and m.status = 'complete'
          and m.attachments @> jsonb_build_array(jsonb_build_object('kind', i.kind, 'id', i.id::text)))`);
  if (!item) {
    return {
      ok: false,
      reason: "not_found",
      problems: [
        `The ${input.kind} ${input.name} isn't one they attached to this conversation, so it isn't yours to change. They can attach it from its page (Ask about this).`,
      ],
    };
  }
  const hash = createHash("sha256").update(input.body).digest("hex");
  const checked = await validateDefinition(
    tx,
    ctx,
    {
      id: item.id,
      kind: input.kind,
      connectionId: input.connectionId,
      body: input.body,
      expectedVersion: input.baseVersion,
    },
    { lock: true },
  );
  const [now] = await tx.execute<{
    version: number;
    body: string;
    body_hash: string;
    author_run_id: string | null;
    title: string;
  }>(sql`
    select v.version, v.body, v.body_hash, v.author_run_id, i.title from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${ctx.orgId} and i.id = ${item.id}`);
  if (now && now.version !== input.baseVersion && now.author_run_id === input.runId && now.body_hash === hash) {
    return { ok: true, id: item.id, kind: input.kind, slug: input.name, title: now.title, version: now.version };
  }
  if (!checked.ok) {
    return {
      ok: false,
      reason: checked.reason,
      problems: checked.problems,
      ...(checked.reason === "conflict" && now ? { current: { version: now.version, body: now.body } } : {}),
    };
  }
  if (now?.body_hash === hash) {
    return {
      ok: false,
      reason: "unchanged",
      problems: [`That's version ${now.version} as it is: change something, or answer without a draft.`],
    };
  }
  const version = await nextVersion(tx, ctx.orgId, item.id);
  // A released one is a draft again until it's approved; one still proposed stays so, as OpenDash's.
  await tx.execute(sql`
    update app.context_item set current_version = ${version}, title = ${checked.spec.label},
      status = case when status = 'verified' then 'draft' else status end, draft = null, updated_at = now()
    where org_id = ${ctx.orgId} and id = ${item.id}`);
  await tx.execute(sql`
    insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source, author_id,
      change_note, author_run_id)
    values (${ctx.orgId}, ${item.id}, ${version}, ${input.body}, ${hash}, ${JSON.stringify(checked.spec)}::jsonb,
      'agent', ${ctx.userId}, ${input.changeNote?.trim() || null}, ${input.runId})`);
  if (deps.boss) {
    await queueDefinitionChecks({ boss: deps.boss }, tx, { orgId: ctx.orgId, connectionId: input.connectionId }, 60);
  }
  return { ok: true, id: item.id, kind: input.kind, slug: checked.slug, title: checked.spec.label, version };
}

/** What a definition's tests found at a version, or null while they haven't run. */
export async function definitionChecksAt(
  tx: TenantTx,
  orgId: string,
  id: string,
  version: number,
): Promise<DefinitionDerived | null> {
  const [v] = await tx.execute<{ derived: DefinitionDerived | null }>(sql`
    select derived from app.context_item_version where org_id = ${orgId} and item_id = ${id} and version = ${version}`);
  return v?.derived ?? null;
}

/**
 * Releases a definition's draft from its page: the version the person saw, once its tests passed, as
 * approving does (`verifyDefinitions`). A version saved meanwhile (the analyst's next) is refused, to be seen first.
 * The caller checks the role, as for approving.
 */
export async function releaseDraft(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { id: string; expectedVersion: number },
): Promise<
  | { ok: true; kind: DefinitionKind; connectionId: string }
  | { ok: false; reason: "invalid" | "conflict" | "not_found"; problems: string[] }
> {
  const [item] = await tx.execute<{
    kind: DefinitionKind;
    connection_id: string;
    current_version: number;
    checks: CheckStatus | null;
  }>(sql`
    select i.kind, i.connection_id, i.current_version, v.derived->>'status' as checks from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${ctx.orgId} and i.id = ${input.id} and i.kind in ('dataset', 'metric') and i.deleted_at is null
    for update of i`);
  if (!item) return { ok: false, reason: "not_found", problems: ["That definition doesn't exist."] };
  if (item.current_version !== input.expectedVersion) {
    return {
      ok: false,
      reason: "conflict",
      problems: [`Version ${item.current_version} was saved meanwhile. Reload to see it before releasing.`],
    };
  }
  if (item.checks === null) {
    return { ok: false, reason: "invalid", problems: ["Its tests haven't finished: release it once they pass."] };
  }
  if (item.checks === "failed") {
    return { ok: false, reason: "invalid", problems: ["Its tests failed, so it can't be released."] };
  }
  const released = await verifyDefinitions(tx, ctx, [input.id]);
  if (!released.length) {
    return {
      ok: false,
      reason: "invalid",
      problems: [
        item.kind === "metric"
          ? "Its dataset isn't released: release the dataset first."
          : "It can't be released as it is.",
      ],
    };
  }
  return { ok: true, kind: item.kind, connectionId: item.connection_id };
}

/**
 * Discards a metric's or dataset's draft: it's back at its released version, as it was approved. The draft
 * stays in its versions. Only over a released version, and only the draft the person saw (`expectedVersion`): one
 * saved meanwhile is theirs to see first. The caller checks the role, as for approving.
 */
export async function discardDraft(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { id: string; expectedVersion: number },
): Promise<
  { ok: true; version: number } | { ok: false; reason: "invalid" | "conflict" | "not_found"; problems: string[] }
> {
  const [item] = await tx.execute<{ current_version: number; released_version: number | null; label: string | null }>(
    sql`
    select i.current_version, i.released_version, v.spec->>'label' as label from app.context_item i
    left join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    where i.org_id = ${ctx.orgId} and i.id = ${input.id} and i.kind in ('dataset', 'metric') and i.deleted_at is null
    for update of i`,
  );
  if (!item) return { ok: false, reason: "not_found", problems: ["That definition doesn't exist."] };
  if (item.released_version === null) {
    return {
      ok: false,
      reason: "invalid",
      problems: ["It was never released, so there's nothing to go back to: edit it, or delete it."],
    };
  }
  if (item.current_version === item.released_version) {
    return { ok: false, reason: "invalid", problems: ["There's no draft to discard."] };
  }
  if (item.current_version !== input.expectedVersion) {
    return {
      ok: false,
      reason: "conflict",
      problems: [`Version ${item.current_version} was saved meanwhile. Reload to see it before discarding.`],
    };
  }
  await tx.execute(sql`
    update app.context_item set current_version = released_version, status = 'verified',
      title = coalesce(${item.label}, title), draft = null, updated_at = now()
    where org_id = ${ctx.orgId} and id = ${input.id}`);
  await closeDecidedProposals(tx, ctx);
  return { ok: true, version: item.released_version };
}

export interface KeyMetric {
  id: string;
  name: string;
  title: string;
  /** Other names people use (an acronym reads better in a question: MRR). */
  synonyms: string[];
  format: "number" | "usd" | "percent";
  direction: "higher_is_better" | "lower_is_better" | "neutral";
  connectionName: string;
  sample: NonNullable<DefinitionDerived["sample"]>;
  trend: NonNullable<DefinitionDerived["trend"]>;
  checkedAt: string;
}

/**
 * Home's key metrics: the released metrics over time, with their latest tested values, the ones about money first,
 * then those that have a direction. No new queries: the values are what their tests read (refreshed after each sync),
 * so a tile shows the same figure as the metric's page.
 */
export async function keyMetrics(tx: TenantTx, orgId: string, limit = 4): Promise<KeyMetric[]> {
  const rows = await tx.execute<{
    id: string;
    slug: string;
    title: string;
    spec: MetricSpec;
    measure_format: string | null;
    derived: DefinitionDerived | null;
    connection_name: string;
  }>(sql`
    select i.id, i.slug, i.title, v.spec, c.name as connection_name, v.derived,
      (select m->>'format' from app.context_item d
        join app.context_item_version dv on dv.org_id = d.org_id and dv.item_id = d.id and dv.version = d.released_version
        cross join lateral jsonb_array_elements(dv.spec->'measures') m
        where d.org_id = i.org_id and d.connection_id = i.connection_id and d.kind = 'dataset' and d.deleted_at is null
          and d.slug = v.spec->>'dataset' and m->>'name' = v.spec->>'measure' limit 1) as measure_format
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id and c.deleted_at is null
    where i.org_id = ${orgId} and i.kind = 'metric' and i.deleted_at is null and i.released_version is not null`);
  const metrics = rows
    .filter((r) => r.derived?.sample?.period && r.derived.trend?.length)
    .map((r) => {
      const spec = MetricSpec.parse(r.spec);
      const format = (spec.format ?? r.measure_format ?? "number") as KeyMetric["format"];
      return {
        id: r.id,
        name: r.slug,
        title: r.title,
        synonyms: spec.synonyms,
        format,
        direction: spec.direction,
        connectionName: r.connection_name,
        sample: r.derived?.sample as KeyMetric["sample"],
        trend: r.derived?.trend as KeyMetric["trend"],
        checkedAt: r.derived?.checkedAt as string,
        // Money first, then what should go up, then what should go down.
        score:
          (format === "usd" ? 2 : 0) +
          (spec.direction === "higher_is_better" ? 1 : spec.direction === "lower_is_better" ? 0.5 : 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return metrics.slice(0, limit).map(({ score: _score, ...m }) => m);
}
