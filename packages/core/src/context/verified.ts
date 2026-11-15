/**
 * Verified queries v0: a question someone checked, and the metric query
 * that answered it right. Saved by an admin from an answer's query, and verified on save (saving is the review). Only
 * metric queries: they recompile from verified definitions on every use, so they follow the definitions; SQL waits
 * for reviewed proposals. The analyst follows one as a template, adapting the period, never replays it.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { stringify as toYaml } from "yaml";
import { z } from "zod";
import { audit } from "../audit/write";
import { visibleTo } from "../runs/ledger";
import { MetricQuery } from "../semantic/spec";
import { ContextProblem, slugOf, writeVersion } from "./items";

const Wording = z.string().trim().min(3).max(300);

export const VerifiedQuerySpec = z.object({
  question: Wording,
  phrasings: z.array(Wording).max(12).default([]),
  /** The metric query that answered it, as it ran (from the query run, never the client). */
  query: MetricQuery,
  /** The definitions it compiled from, at the versions it read them. */
  definitions: z.array(z.object({ id: z.string(), version: z.number().int() })).default([]),
  /** Its result when saved, to notice when it changes: columns, row count, the gateway's hash of the rows. */
  fingerprint: z.object({
    columns: z.array(z.object({ name: z.string(), type: z.string() })),
    rows: z.number().int().nullable(),
    resultHash: z.string().nullable(),
    savedAt: z.string(),
  }),
  /** Where it came from: the answer's run and its query run. */
  from: z.object({ runId: z.string(), queryRunId: z.string() }),
});
export type VerifiedQuerySpec = z.infer<typeof VerifiedQuerySpec>;

export interface VerifiedQuerySummary {
  id: string;
  question: string;
  phrasings: string[];
  metrics: string[];
  dimensions: string[];
  connectionId: string | null;
  version: number;
  usageCount: number;
  verifiedBy: string | null;
  updatedAt: string;
}

export interface VerifiedQueryDetail extends VerifiedQuerySummary {
  spec: VerifiedQuerySpec;
  versions: { version: number; createdAt: string; changeNote: string | null; authorId: string | null }[];
}

/**
 * Saves the query behind an answer as a verified query, verified at once: a new one from `queryRunId`, or a new
 * version of `id` (its question and wordings; the query stays the one it was saved from). The query run must be an
 * answer's metric query that succeeded, and visible to the person saving it.
 */
export async function saveVerifiedQuery(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { id?: string; queryRunId?: string; question: string; phrasings?: string[]; changeNote?: string },
): Promise<{ id: string; version: number }> {
  let base: Pick<VerifiedQuerySpec, "query" | "definitions" | "fingerprint" | "from">;
  let connectionId: string | null;
  if (input.id) {
    const current = await getVerifiedQuery(tx, ctx.orgId, input.id);
    if (!current) throw new ContextProblem("not_found", "That verified query doesn't exist.");
    base = current.spec;
    connectionId = current.connectionId;
  } else {
    if (!input.queryRunId || !isUuid(input.queryRunId))
      throw new ContextProblem("not_found", "That query doesn't exist.");
    const [q] = await tx.execute<{
      id: string;
      requester_id: string;
      connection_id: string;
      path: string;
      status: string;
      semantic: { query: unknown; definitions?: { id: string; version: number }[] } | null;
      result_schema: { name: string; type: string }[] | null;
      rows: number | null;
      result_hash: string | null;
    }>(sql`
      select q.id, q.requester_id, q.connection_id, q.path, q.status, q.semantic, q.result_schema, q.rows, q.result_hash
      from app.query_run q
      where q.org_id = ${ctx.orgId} and q.id = ${input.queryRunId} and q.requester_type = 'run' and q.mode = 'execute'
        and exists (
          select 1 from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
          where r.org_id = q.org_id and r.id = q.requester_id and ${visibleTo(ctx.userId)})`);
    if (!q) throw new ContextProblem("not_found", "That query doesn't exist.");
    if (q.path !== "metric" || !q.semantic) {
      throw new ContextProblem("invalid", "Only a metric query can be verified: SQL waits for a reviewed proposal.");
    }
    if (q.status !== "succeeded") throw new ContextProblem("invalid", "Only a query that ran can be verified.");
    const query = MetricQuery.safeParse(q.semantic.query);
    if (!query.success) throw new ContextProblem("invalid", "That query's spec can't be read.");
    base = {
      query: query.data,
      definitions: (q.semantic.definitions ?? []).map((d) => ({ id: d.id, version: d.version })),
      fingerprint: {
        columns: (q.result_schema ?? []).map((c) => ({ name: c.name, type: c.type })),
        rows: q.rows,
        resultHash: q.result_hash,
        savedAt: new Date().toISOString(),
      },
      from: { runId: q.requester_id, queryRunId: q.id },
    };
    connectionId = q.connection_id;
  }
  const question = (input.question ?? "").trim();
  const phrasings = [...new Set((input.phrasings ?? []).map((p) => p.trim()).filter(Boolean))].filter(
    (p) => p.toLowerCase() !== question.toLowerCase(),
  );
  const parsed = VerifiedQuerySpec.safeParse({ ...base, question, phrasings });
  if (!parsed.success) {
    throw new ContextProblem(
      "invalid",
      parsed.error.issues.some((i) => i.path[0] === "question")
        ? "Write the question, as people would ask it (3 to 300 characters)."
        : parsed.error.issues.some((i) => i.path[0] === "phrasings")
          ? "Keep to 12 other wordings, each 3 to 300 characters."
          : "That query can't be saved.",
    );
  }
  const spec = parsed.data;
  const saved = await writeVersion(tx, ctx, {
    ...(input.id ? { id: input.id } : {}),
    kind: "verified_query",
    title: spec.question,
    slug: slugOf(spec.question),
    connectionId,
    body: toYaml({ question: spec.question, phrasings: spec.phrasings, query: spec.query }),
    spec,
    ...(input.changeNote ? { changeNote: input.changeNote } : {}),
  });
  // Saving is the review: the version saved is the one the analyst reads.
  await tx.execute(sql`
    update app.context_item set status = 'verified', released_version = ${saved.version}, verified_by = ${ctx.userId},
      verified_at = now(), updated_at = now()
    where org_id = ${ctx.orgId} and id = ${saved.id}`);
  await audit(tx, {
    action: "knowledge.published",
    actor: { type: "user", id: ctx.userId },
    target: { type: "knowledge", id: saved.id, name: spec.question },
    detail: { kind: "verified_query", version: saved.version },
  });
  return saved;
}

type Row = {
  id: string;
  connection_id: string | null;
  current_version: number;
  usage_count: number;
  verified_by: string | null;
  updated_at: string;
  spec: VerifiedQuerySpec;
};

const summaryOf = (r: Row): VerifiedQuerySummary => ({
  id: r.id,
  question: r.spec.question,
  phrasings: r.spec.phrasings ?? [],
  metrics: r.spec.query.metrics,
  dimensions: r.spec.query.dimensions ?? [],
  connectionId: r.connection_id,
  version: r.current_version,
  usageCount: r.usage_count,
  verifiedBy: r.verified_by,
  updatedAt: new Date(r.updated_at).toISOString(),
});

const selectVerified = sql`
  select i.id, i.connection_id, i.current_version, i.usage_count, i.verified_by, i.updated_at, v.spec
  from app.context_item i
  join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version`;

/** The verified queries, most used first. */
export async function listVerifiedQueries(tx: TenantTx, orgId: string): Promise<VerifiedQuerySummary[]> {
  const rows = await tx.execute<Row>(sql`
    ${selectVerified}
    where i.org_id = ${orgId} and i.kind = 'verified_query' and i.deleted_at is null and i.scope = 'org'
    order by i.usage_count desc, i.updated_at desc`);
  return rows.map(summaryOf);
}

/** One verified query, with its versions. */
export async function getVerifiedQuery(tx: TenantTx, orgId: string, id: string): Promise<VerifiedQueryDetail | null> {
  if (!isUuid(id)) return null;
  const [r] = await tx.execute<Row>(sql`
    ${selectVerified}
    where i.org_id = ${orgId} and i.id = ${id} and i.kind = 'verified_query' and i.deleted_at is null`);
  if (!r) return null;
  const versions = await tx.execute<{
    version: number;
    created_at: string;
    change_note: string | null;
    author_id: string | null;
  }>(sql`
    select version, created_at, change_note, author_id from app.context_item_version
    where org_id = ${orgId} and item_id = ${id} order by version desc`);
  return {
    ...summaryOf(r),
    spec: r.spec,
    versions: versions.map((v) => ({
      version: v.version,
      createdAt: new Date(v.created_at).toISOString(),
      changeNote: v.change_note,
      authorId: v.author_id,
    })),
  };
}

/** A verified query the analyst is given for a question: its spec at the released version, and how well it matched. */
export type MatchedVerified = {
  id: string;
  version: number;
  spec: VerifiedQuerySpec;
  score: number;
};

/** How alike a question must be to a verified question or one of its wordings (trigram similarity) to be given. */
export const VERIFIED_MATCH = 0.4;

/**
 * The verified queries on this source like `question`, best first (packing quota: at most three): those whose
 * question or a wording is alike by trigram similarity (VERIFIED_MATCH), and those over a metric the question names
 * (`mentioned`, by name, label or synonym), which paraphrases reach when their words don't. Ranked by similarity, a
 * named metric adding to it.
 */
export async function verifiedForQuestion(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  question: string,
  mentioned: string[] = [],
  limit = 3,
): Promise<MatchedVerified[]> {
  const q = question.trim().toLowerCase().slice(0, 300);
  if (!q) return [];
  const named = JSON.stringify(mentioned);
  return tx.execute<MatchedVerified>(sql`
    with v as (
      select i.id, v.version, v.spec,
        greatest(
          similarity(lower(i.title), ${q}),
          coalesce((select max(similarity(lower(p), ${q})) from jsonb_array_elements_text(v.spec->'phrasings') p), 0)
        ) as score
      from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
      where i.org_id = ${orgId} and i.kind = 'verified_query' and i.deleted_at is null and i.scope = 'org'
        and i.released_version is not null and i.connection_id = ${connectionId}
    )
    select id, version, spec,
      (score + case when spec->'query'->'metrics' ?| array(select jsonb_array_elements_text(${named}::jsonb))
        then 0.3 else 0 end)::float8 as score
    from v
    where score >= ${VERIFIED_MATCH} or spec->'query'->'metrics' ?| array(select jsonb_array_elements_text(${named}::jsonb))
    order by score desc limit ${limit}`);
}

type QueryShape = {
  metrics?: string[];
  dimensions?: string[];
  filters?: { field: string; op: string }[];
  time?: { grain?: string; compare?: string };
};

/**
 * A metric query's shape: what it computes and how it's broken down, without the period or the filters' values, which
 * the analyst is meant to adapt to the question. Two queries of one shape ask the same thing of different data.
 */
export const shapeOf = (q: QueryShape | null | undefined) =>
  JSON.stringify([
    [...(q?.metrics ?? [])].sort(),
    [...(q?.dimensions ?? [])].sort(),
    (q?.filters ?? []).map((f) => `${f.field} ${f.op}`).sort(),
    q?.time?.grain ?? null,
    q?.time?.compare ?? null,
  ]);

/**
 * The verified queries a run followed: of those it was given (at the versions it was given), the ones a metric query
 * of the run matched in shape (shapeOf). Read-only: the run's finalize counts them, exactly once.
 */
export async function verifiedFollowed(
  tx: TenantTx,
  orgId: string,
  runId: string,
  given: { id: string; version: number }[],
): Promise<string[]> {
  if (!given.length) return [];
  const [specs, ran] = await Promise.all([
    tx.execute<{ id: string; query: QueryShape }>(sql`
      select v.item_id as id, v.spec->'query' as query from app.context_item_version v
      where v.org_id = ${orgId} and (v.item_id, v.version) in (${sql.join(
        given.map((g) => sql`(${g.id}::uuid, ${g.version}::int)`),
        sql`, `,
      )})`),
    tx.execute<{ query: QueryShape }>(sql`
      select q.semantic->'query' as query from app.query_run q
      where q.org_id = ${orgId} and q.requester_type = 'run' and q.requester_id = ${runId} and q.path = 'metric'
        and q.status = 'succeeded' and q.semantic is not null`),
  ]);
  const computed = new Set(ran.map((r) => shapeOf(r.query)));
  return specs.filter((v) => computed.has(shapeOf(v.query))).map((v) => v.id);
}
