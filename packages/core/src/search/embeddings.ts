/**
 * Vectors: the workspace's released knowledge and its sources'
 * tables, each embedded once per text, and found by meaning. Embedding runs in the worker (`embed.batch`), with the
 * organization's own OpenAI key or the deployment's; without one, nothing is embedded and search stays lexical.
 */
import { createHash } from "node:crypto";
import { sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { enqueueOnce } from "../jobs/boss";
import { embedBatchQueue } from "../jobs/queues";
import type { SystemDeps } from "../ops/alerts";
import type { LedgerDeps } from "../runs/ledger";

/** The model and its size: OpenAI's small model, at 1024 dimensions, stored as halfvec(1024). */
export const EMBEDDING_MODEL = "openai/text-embedding-3-small@1024";
export const EMBEDDING_DIMENSIONS = 1024;
/** A subject's text past this is cut (the model reads about 8,000 tokens; a guide's body fits). */
export const EMBEDDING_TEXT_CHARS = 6000;
/** At most this many texts in one call to the provider. */
export const EMBEDDING_BATCH = 96;

/** What embeds texts: one organization's provider instance, made in the worker, where its key is decrypted. */
export interface Embedder {
  model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface EmbeddingSubject {
  kind: "context_item" | "catalog_object";
  id: string;
  text: string;
}

const KINDS: Record<string, string> = {
  dataset: "Dataset",
  metric: "Metric",
  term: "Glossary term",
  guide: "Guide",
  verified_query: "Verified query",
  skill: "Skill",
};

const words = (s: unknown) => (typeof s === "string" ? s.trim() : "");
const list = (s: unknown) => (Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : []);

/** One subject's text, the parts the search reads, one per line, cut to the limit. */
export function subjectText(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, EMBEDDING_TEXT_CHARS);
}

/**
 * What an organization's search embeds: its released knowledge of organization scope (never memory) and its live
 * sources' tables, each as the text the search reads: a knowledge item's kind, title, label, description, meaning,
 * synonyms and phrasings, and a guide's or skill's body; a table's name, comment and column names (never a value).
 */
export async function embeddingSubjects(tx: TenantTx, orgId: string): Promise<EmbeddingSubject[]> {
  const items = await tx.execute<{
    id: string;
    kind: string;
    title: string;
    slug: string;
    spec: Record<string, unknown>;
    body: string | null;
  }>(
    sql`
    select i.id, i.kind, i.title, i.slug, v.spec, v.body from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    where i.org_id = ${orgId} and i.deleted_at is null and i.released_version is not null and i.scope = 'org'
      and i.kind in ('dataset', 'metric', 'guide', 'term', 'verified_query', 'skill')
    order by i.id`,
  );
  const tables = await tx.execute<{
    id: string;
    fq_name: string;
    comment: string | null;
    columns: string[] | null;
  }>(sql`
    select o.id, o.fq_name, o.comment,
      (select array_agg(c.name order by c.id) from (
        select k.id, k.name from app.catalog_object k
        where k.org_id = o.org_id and k.parent_id = o.id and k.kind = 'column' and k.removed_at is null
        order by k.id limit 80) c) as columns
    from app.catalog_object o
    join app.connection n on n.org_id = o.org_id and n.id = o.connection_id and n.deleted_at is null
    where o.org_id = ${orgId} and o.kind in ('table', 'view') and o.removed_at is null
    order by o.id`);
  return [
    ...items.map((i) => ({
      kind: "context_item" as const,
      id: i.id,
      text: subjectText([
        `${KINDS[i.kind] ?? i.kind}: ${i.title}`,
        i.slug.replace(/[_-]/g, " "),
        words(i.spec.label),
        words(i.spec.description),
        words(i.spec.means),
        words(i.spec.term),
        words(i.spec.question),
        words(i.spec.use_when),
        [...list(i.spec.synonyms), ...list(i.spec.phrasings)].join(", "),
        // A guide's and a skill's own words are their body (a term's and a definition's are its fields above; a
        // verified query's body is its SQL, left out).
        i.kind === "guide" || i.kind === "skill" ? i.body : null,
      ]),
    })),
    ...tables.map((t) => ({
      kind: "catalog_object" as const,
      id: t.id,
      text: subjectText([
        `Table: ${t.fq_name}`,
        t.fq_name.replace(/[._]/g, " "),
        t.comment,
        t.columns?.length ? `Columns: ${t.columns.join(", ")}` : null,
      ]),
    })),
  ].filter((s) => s.text);
}

/** A text's hash with its model: a subject is embedded again only when either changes. */
export const contentHash = (model: string, text: string) =>
  createHash("sha256").update(`${model}\n${text}`).digest("hex");

/** A vector as pgvector reads it. */
const asVector = (values: number[]) => `[${values.join(",")}]`;

export interface EmbedResult {
  embedded: number;
  unchanged: number;
  removed: number;
}

/**
 * Embeds what changed in an organization's search since its last batch: new and changed subjects (by their text's
 * hash, under this model), in batches outside any transaction; the rows of what's gone, removed. Records when it
 * read what to embed, by the database's clock (the one every change is stamped with), so a change made while it ran
 * is picked up by the next batch.
 */
export async function embedOrganization(
  deps: Pick<LedgerDeps, "withTenant">,
  orgId: string,
  embedder: Embedder,
  options: { signal?: AbortSignal } = {},
): Promise<EmbedResult> {
  const { startedAt, subjects, stored } = await deps.withTenant(orgId, async (tx) => ({
    startedAt: (await tx.execute<{ at: string }>(sql`select transaction_timestamp()::text as at`))[0]?.at as string,
    subjects: await embeddingSubjects(tx, orgId),
    stored: await tx.execute<{ subject_kind: string; subject_id: string; model: string; content_hash: string }>(sql`
      select subject_kind, subject_id, model, content_hash from app.embedding where org_id = ${orgId}`),
  }));
  const had = new Map(stored.map((r) => [`${r.subject_kind}:${r.subject_id}`, r]));
  const wanted = subjects.map((s) => ({ ...s, hash: contentHash(embedder.model, s.text) }));
  const changed = wanted.filter((s) => had.get(`${s.kind}:${s.id}`)?.content_hash !== s.hash);
  for (let i = 0; i < changed.length; i += EMBEDDING_BATCH) {
    const batch = changed.slice(i, i + EMBEDDING_BATCH);
    const vectors = await embedder.embed(
      batch.map((s) => s.text),
      options.signal,
    );
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(
        `The embedding model returned ${vectors.length} vectors, not ${batch.length} of ${EMBEDDING_DIMENSIONS}.`,
      );
    }
    await deps.withTenant(orgId, async (tx) => {
      for (const [j, s] of batch.entries()) {
        await tx.execute(sql`
          insert into app.embedding (org_id, subject_kind, subject_id, model, content_hash, vector, embedded_at)
          values (${orgId}, ${s.kind}, ${s.id}, ${embedder.model}, ${s.hash},
            ${asVector(vectors[j] as number[])}::public.halfvec(1024), now())
          on conflict (org_id, subject_kind, subject_id) do update set model = excluded.model,
            content_hash = excluded.content_hash, vector = excluded.vector, embedded_at = excluded.embedded_at`);
      }
    });
  }
  const keep = new Set(wanted.map((s) => `${s.kind}:${s.id}`));
  const gone = stored.filter((r) => !keep.has(`${r.subject_kind}:${r.subject_id}`));
  await deps.withTenant(orgId, async (tx) => {
    for (const r of gone) {
      await tx.execute(sql`
        delete from app.embedding
        where org_id = ${orgId} and subject_kind = ${r.subject_kind} and subject_id = ${r.subject_id}`);
    }
    await markChecked(tx, orgId, embedder.model, startedAt);
  });
  return { embedded: changed.length, unchanged: wanted.length - changed.length, removed: gone.length };
}

/**
 * Records that an organization's search was checked at `at` (now, by the database's clock, when not given) with
 * `model`: the tick queues it again only for a change since. A batch that failed is marked too, so a key that keeps
 * failing isn't tried every minute (the job's own retries come first; then the next change, or the daily check).
 */
export async function markChecked(tx: TenantTx, orgId: string, model: string, at?: string): Promise<void> {
  await tx.execute(sql`
    insert into app.embedding_state (org_id, model, checked_at)
    values (${orgId}, ${model}, coalesce(${at ?? null}::timestamptz, transaction_timestamp()))
    on conflict (org_id) do update set model = excluded.model, checked_at = excluded.checked_at`);
}

/** How often an organization is checked even with nothing changed: it removes the rows of what's gone. */
export const EMBEDDING_RECHECK_HOURS = 24;

/**
 * The tick's task: `embed.batch` for each organization that can embed (an OpenAI key of its own that works, or the
 * deployment's) and has something to, whose knowledge or tables changed since its last batch, or that was last
 * checked with another model or a day ago. One queued and one running per organization.
 */
export async function queueStaleEmbeddings(
  deps: SystemDeps & { withTenant: LedgerDeps["withTenant"]; boss: PgBoss; deploymentKey: boolean },
  now = new Date(),
): Promise<number> {
  const due = await deps.withSystem((tx) =>
    tx.execute<{ id: string }>(sql`
      select o.id from app.org o
      left join app.embedding_state s on s.org_id = o.id
      where (${deps.deploymentKey} or exists (
          select 1 from app.ai_provider p where p.org_id = o.id and p.kind = 'openai' and p.status = 'ok'
            and p.enabled))
        and (exists (select 1 from app.context_item i where i.org_id = o.id and i.released_version is not null)
          or exists (select 1 from app.catalog_object c where c.org_id = o.id and c.kind in ('table', 'view')))
        and (s.org_id is null or s.model <> ${EMBEDDING_MODEL}
          or s.checked_at < ${now.toISOString()}::timestamptz - make_interval(hours => ${EMBEDDING_RECHECK_HOURS})
          or exists (select 1 from app.context_item i where i.org_id = o.id
            and greatest(i.updated_at, i.verified_at, i.deleted_at) > s.checked_at)
          or exists (select 1 from app.catalog_object c where c.org_id = o.id
            and greatest(c.updated_at, c.removed_at) > s.checked_at))
      order by s.checked_at nulls first limit 50`),
  );
  for (const o of due) {
    await deps.withTenant(o.id, (tx) =>
      enqueueOnce(deps.boss, tx, embedBatchQueue, { orgId: o.id }, { singletonKey: o.id }),
    );
  }
  return due.length;
}

export interface VectorHit {
  kind: string;
  id: string;
  connectionId: string | null;
  title: string;
  key: string;
  status: string;
  similarity: number;
}

/**
 * A vector match counts from this cosine similarity up. Measured with the embedding model: related phrases scored
 * 0.27–0.53 ("lost customers" and the churn guide 0.27, "big companies" and Enterprise 0.43), unrelated ones 0.05–0.19,
 * but for one that shares a word (employee birthdays and Enterprise, 0.39), which full text matches anyway.
 */
export const VECTOR_SIMILARITY_FLOOR = 0.25;

/** The subjects nearest a query's vector, most similar first, at or above the floor (`app.search_vectors`). */
export async function vectorSearch(
  tx: TenantTx,
  query: { model: string; vector: number[] },
  options: { kinds: readonly string[]; connectionId?: string | null; limit?: number; floor?: number },
): Promise<VectorHit[]> {
  if (query.vector.length !== EMBEDDING_DIMENSIONS) return [];
  const rows = await tx.execute<{
    kind: string;
    id: string;
    connection_id: string | null;
    title: string;
    key: string;
    status: string;
    similarity: number;
  }>(sql`
    select * from app.search_vectors(${asVector(query.vector)}::public.halfvec(1024), ${query.model},
      array[${sql.join(
        options.kinds.map((k) => sql`${k}`),
        sql`, `,
      )}]::text[],
      ${options.connectionId ?? null}::uuid, ${options.floor ?? VECTOR_SIMILARITY_FLOOR}::real, ${options.limit ?? 20})`);
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    connectionId: r.connection_id,
    title: r.title,
    key: r.key,
    status: r.status,
    similarity: Number(r.similarity),
  }));
}
