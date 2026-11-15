/**
 * The organization's eval suite: one suite, its cases kept
 * in sync with what admins verified. A case per verified metric, from a template, and a case per verified query, in
 * its own words. A case whose metric or verified query is gone turns inactive; its results stay.
 */
import { createHash } from "node:crypto";
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import { expectOf, type StructuralExpect } from "../learning/curator";
import type { CuratorOutcome } from "../runs/ledger";
import { loadSemanticModel } from "../semantic/definitions";
import { metricTimeColumn, type SemanticModel } from "../semantic/model";
import type { MetricQueryInput } from "../semantic/spec";

export interface EvalCase {
  id: string;
  connectionId: string;
  question: string;
  /** Asked as of this time (a verified query's spec carries the dates it ran with); null: as of the run. */
  asOf: string | null;
  /** A metric query whose numbers the answer must cite; null for a structural case. */
  referenceSpec: MetricQueryInput | null;
  /** A structural case: graded on what the answer's queries read, not on numbers. */
  expect: StructuralExpect | null;
  /** onboarding: a verified metric's; admin: a verified query's; correction: a released learning's. */
  origin: "onboarding" | "admin" | "correction";
  originRef: string | null;
  active: boolean;
}

/** The organization's suite, made the first time it's needed. */
export async function ensureSuite(tx: TenantTx, orgId: string): Promise<{ id: string; nightly: boolean }> {
  const [found] = await tx.execute<{ id: string; nightly: boolean }>(sql`
    select id, nightly from app.eval_suite where org_id = ${orgId} and scope = 'org'`);
  if (found) return found;
  const [made] = await tx.execute<{ id: string; nightly: boolean }>(sql`
    insert into app.eval_suite (org_id, id, name, scope) values (${orgId}, ${uuidv7()}, 'Evals', 'org')
    on conflict (org_id) where scope = 'org' do update set updated_at = app.eval_suite.updated_at
    returning id, nightly`);
  return made as { id: string; nightly: boolean };
}

/** Of the source and the question as people would retype it: case, spacing and a final "?" don't make another case. */
export function questionHash(connectionId: string, question: string): string {
  const normal = question.trim().toLowerCase().replace(/\s+/g, " ").replace(/\?+$/, "");
  return createHash("sha256").update(`${connectionId}\n${normal}`).digest("hex");
}

/** "Monthly recurring revenue" reads as "monthly recurring revenue", "MRR" and "CSAT" stay as they are. */
const inSentence = (label: string) => label.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());

/**
 * The question a verified metric is checked with: "What was monthly recurring revenue last month?" for an amount
 * over time, "How many new accounts last month?" for a count or quantity, and the current state for a metric without
 * time.
 */
export function metricQuestion(metric: { title: string; timed: boolean; counts: boolean }): string {
  const what = inSentence(metric.title);
  if (metric.timed) return metric.counts ? `How many ${what} last month?` : `What was ${what} last month?`;
  return metric.counts ? `How many ${what} are there now?` : `What is ${what} now?`;
}

interface Desired {
  connectionId: string;
  question: string;
  asOf: string | null;
  referenceSpec: MetricQueryInput | null;
  expect?: StructuralExpect | null;
  origin: "onboarding" | "admin" | "correction";
  originRef: string;
}

/** What the suite should hold: a case per verified metric and per verified query on a source that's in use. */
async function desiredCases(tx: TenantTx, orgId: string): Promise<Desired[]> {
  // The released metrics of each source in use, read as the compiler reads them: whether a metric has time, and
  // whether it counts, come from its definition.
  const items = await tx.execute<{ id: string; connection_id: string; slug: string; title: string }>(sql`
    select i.id, i.connection_id, i.slug, i.title from app.context_item i
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id
    where i.org_id = ${orgId} and i.kind = 'metric' and i.deleted_at is null and i.released_version is not null
      and c.deleted_at is null and c.status <> 'disabled'
    order by i.title`);
  const models = new Map<string, SemanticModel | null>();
  for (const connectionId of new Set(items.map((i) => i.connection_id))) {
    models.set(connectionId, (await loadSemanticModel(tx, orgId, connectionId))?.model ?? null);
  }
  const metrics = items.flatMap((i) => {
    const model = models.get(i.connection_id);
    const metric = model?.metrics.get(i.slug);
    const dataset = metric ? model?.datasets.get(metric.dataset) : undefined;
    if (!metric || !dataset) return [];
    const measure = dataset.measures.find((m) => m.name === metric.measure);
    const format = metric.format ?? measure?.format ?? "number";
    // A count or a summed quantity (accounts, seats) is "how many"; an amount, a share or an average is "what".
    const counts = format === "number" && !/\bavg\s*\(|\//i.test(measure?.expr ?? "");
    return [{ ...i, timed: metricTimeColumn(metric, dataset) !== null, counts }];
  });
  const verified = await tx.execute<{
    id: string;
    connection_id: string;
    question: string;
    query: MetricQueryInput;
    query_run_id: string | null;
  }>(sql`
    select i.id, i.connection_id, v.spec->>'question' as question, v.spec->'query' as query,
      v.spec->'from'->>'queryRunId' as query_run_id
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id
    where i.org_id = ${orgId} and i.kind = 'verified_query' and i.deleted_at is null and i.scope = 'org'
      and c.deleted_at is null and c.status <> 'disabled'
    order by i.created_at`);
  const asOf = verified.length
    ? await tx.execute<{ id: string; at: string }>(sql`
        select r.id, r.created_at as at from app.query_run r
        where r.org_id = ${orgId} and r.id in (${sql.join(
          verified.flatMap((v) => (v.query_run_id ? [sql`${v.query_run_id}::uuid`] : [])).concat([sql`null::uuid`]),
          sql`, `,
        )})`)
    : [];
  const ranAt = new Map(asOf.map((r) => [r.id, new Date(r.at).toISOString()]));
  // A released learning's question: the team's word, still read from the right table, nightly too.
  const learned = await tx.execute<{
    connection_id: string;
    term_id: string;
    learning: NonNullable<CuratorOutcome["learning"]>;
  }>(sql`
    select p.connection_id, p.evidence->>'termId' as term_id, p.evidence->'learning' as learning
    from app.proposal p
    join app.connection c on c.org_id = p.org_id and c.id = p.connection_id
    join app.context_item i on i.org_id = p.org_id and i.id = (p.evidence->>'termId')::uuid
    where p.org_id = ${orgId} and p.source = 'curator' and p.status = 'approved' and i.released_version is not null
      and i.deleted_at is null and c.deleted_at is null and c.status <> 'disabled'
    order by p.created_at`);
  const structural = learned.flatMap((l) => {
    const expect = expectOf(l.learning);
    return expect && l.learning.question
      ? [
          {
            connectionId: l.connection_id,
            question: l.learning.question,
            asOf: null,
            referenceSpec: null,
            expect,
            origin: "correction" as const,
            originRef: l.term_id,
          },
        ]
      : [];
  });
  return [
    ...metrics.map((m) => ({
      connectionId: m.connection_id,
      question: metricQuestion(m),
      asOf: null,
      referenceSpec: { metrics: [m.slug], ...(m.timed ? { time: { range: "last_month" as const } } : {}) },
      origin: "onboarding" as const,
      originRef: m.id,
    })),
    // A verified query is asked as of when its query ran: its spec has the dates "last month" meant then.
    ...verified.map((v) => ({
      connectionId: v.connection_id,
      question: v.question,
      asOf: (v.query_run_id && ranAt.get(v.query_run_id)) || null,
      referenceSpec: v.query,
      origin: "admin" as const,
      originRef: v.id,
    })),
    ...structural,
  ];
}

/**
 * Brings the suite's cases in line with what's verified: new ones added, changed ones updated, ones whose origin is
 * gone made inactive. Returns the active cases, in a stable order. Idempotent.
 */
export async function syncCases(tx: TenantTx, orgId: string): Promise<EvalCase[]> {
  const suite = await ensureSuite(tx, orgId);
  const desired = await desiredCases(tx, orgId);
  // A verified query asked like a template wins (it's later in the list): an admin checked its answer.
  const byHash = new Map(desired.map((d) => [questionHash(d.connectionId, d.question), d]));
  for (const [hash, d] of byHash) {
    await tx.execute(sql`
      insert into app.eval_case (org_id, id, suite_id, connection_id, question, question_hash, as_of, reference_spec,
        expect, origin, origin_ref, active)
      values (${orgId}, ${uuidv7()}, ${suite.id}, ${d.connectionId}, ${d.question}, ${hash}, ${d.asOf}::timestamptz,
        ${d.referenceSpec ? JSON.stringify(d.referenceSpec) : null}::jsonb, ${d.expect ? JSON.stringify(d.expect) : null}::jsonb,
        ${d.origin}, ${d.originRef}, true)
      on conflict (org_id, suite_id, question_hash) do update set
        question = excluded.question, as_of = excluded.as_of, reference_spec = excluded.reference_spec,
        expect = excluded.expect, origin = excluded.origin, origin_ref = excluded.origin_ref, active = true,
        updated_at = now()
      where (app.eval_case.question, app.eval_case.as_of, app.eval_case.reference_spec, app.eval_case.expect,
          app.eval_case.origin, app.eval_case.origin_ref, app.eval_case.active)
        is distinct from (excluded.question, excluded.as_of, excluded.reference_spec, excluded.expect, excluded.origin,
          excluded.origin_ref, true)`);
  }
  const keep = [...byHash.keys()];
  await tx.execute(sql`
    update app.eval_case set active = false, updated_at = now()
    where org_id = ${orgId} and suite_id = ${suite.id} and active
      ${
        keep.length
          ? sql`and question_hash not in (${sql.join(
              keep.map((h) => sql`${h}`),
              sql`, `,
            )})`
          : sql``
      }`);
  return listCases(tx, orgId, { activeOnly: true });
}

type CaseRow = {
  id: string;
  connection_id: string;
  question: string;
  as_of: string | null;
  reference_spec: MetricQueryInput | null;
  expect: StructuralExpect | null;
  origin: EvalCase["origin"];
  origin_ref: string | null;
  active: boolean;
};

const caseOf = (r: CaseRow): EvalCase => ({
  id: r.id,
  connectionId: r.connection_id,
  question: r.question,
  asOf: r.as_of ? new Date(r.as_of).toISOString() : null,
  referenceSpec: r.reference_spec,
  expect: r.expect ?? null,
  origin: r.origin,
  originRef: r.origin_ref,
  active: r.active,
});

/** The suite's cases: verified queries first, then metrics, by question. */
export async function listCases(tx: TenantTx, orgId: string, options: { activeOnly?: boolean } = {}) {
  const rows = await tx.execute<CaseRow>(sql`
    select c.id, c.connection_id, c.question, c.as_of, c.reference_spec, c.expect, c.origin, c.origin_ref, c.active
    from app.eval_case c join app.eval_suite s on s.org_id = c.org_id and s.id = c.suite_id and s.scope = 'org'
    where c.org_id = ${orgId} ${options.activeOnly ? sql`and c.active` : sql``}
    order by c.active desc, (c.origin = 'admin') desc, c.question`);
  return rows.map(caseOf);
}

export async function getCase(tx: TenantTx, orgId: string, caseId: string): Promise<EvalCase | null> {
  const [r] = await tx.execute<CaseRow>(sql`
    select id, connection_id, question, as_of, reference_spec, expect, origin, origin_ref, active
    from app.eval_case where org_id = ${orgId} and id = ${caseId}`);
  return r ? caseOf(r) : null;
}
