/**
 * Learning from corrections. A correction someone may share opens its topic's learning, or joins it: a
 * proposal from the Curator, with the correction as evidence. Within a minute the dispatcher starts the Curator on it,
 * which proposes a term (what a word means in the data, and what it is not). Code then keeps that term as a proposed
 * version, runs its check (a query that proves it), tests it (one analyst run given the unreleased term, graded on what
 * its queries read), and decides: released by the rule when all five of its predicates hold, otherwise offered to an
 * approver as one tap. Nothing here is the Curator's to decide; it only proposes.
 */
import { isUuid, type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { stringify } from "yaml";
import { type DeploymentKeys, defaultChoice } from "../ai/settings";
import { audit } from "../audit/write";
import { approveContext, ContextProblem, saveTerm, type TermSpec } from "../context/items";
import type { GatewayDeps, QueryReads } from "../gateway/gateway";
import { runQuery } from "../gateway/gateway";
import { enqueue, enqueueOnce } from "../jobs/boss";
import { agentBackgroundQueue, learningEvaluateQueue } from "../jobs/queues";
import { type CuratorOutcome, nextMessageSeq } from "../runs/ledger";
import { BackgroundBudgetReached, checkBackgroundBudget } from "../usage/limits";

/** The Curator's runs a workspace starts in a day, at most: the rest wait (held) for the next. */
export const CURATOR_DAILY_RUNS = 20;
/** How much of one correction is kept as evidence. */
const SIGNAL_MAX = 600;
/** The proposal statuses that are still live: a new correction about the topic joins one of these. */
const LIVE = ["drafting", "held", "evaluating", "open"] as const;
const live = sql.raw(`(${LIVE.map((s) => `'${s}'`).join(", ")})`);

/** A correction, as a learning keeps it: whose, where, in their words. */
export interface LearningSignal {
  /**
   * A thumbs down with what it should have said; a correction an approver made in the chat (the analyst judged it one,
   * so it never counts as the approver saying it); one someone chose to share.
   */
  kind: "feedback" | "memory" | "suggestion";
  /** The feedback row's, or the memory's. */
  id: string;
  userId: string;
  text: string;
  /** The answer it corrected, when there is one: what that answer read is the Curator's evidence too. */
  runId: string | null;
  /** Where it was said: the answer whose block shows the learning (the corrected one for a 👎, the reply to a chat). */
  fromRunId: string | null;
  at: string;
}

/** What a learning knows about itself, kept on its proposal as it goes. */
export interface LearningEvidence {
  signals: LearningSignal[];
  /** A new correction joined it after it was structured: the rule is decided again (two people said it). */
  recheck?: boolean;
  /** What the Curator proposed. */
  learning?: NonNullable<CuratorOutcome["learning"]>;
  /** The term it keeps as a proposed version. */
  termId?: string;
  termVersion?: number;
  /** The Curator's quoted span is, word for word, in a correction: the statement is someone's, not the Curator's. */
  quoteOk?: boolean;
  check?: { queryRunId: string | null; ok: boolean; rows: number | null; why?: string };
  test?: { runId: string; ok: boolean | null; used: boolean | null; why?: string };
  /** The rule's verdict, and what it missed when it didn't release. */
  decided?: { automatic: boolean; missing: string[] };
  /** What the term's released version was before a release: Revert puts it back. */
  /** What the term was before: the version released, and who approved it (none: released by the rule). */
  before?: { releasedVersion: number | null; verifiedBy?: string | null };
  /** An approver changed it before the tap: checked and tested again, and released only by their tap. */
  edited?: { by: string; at: string };
  failed?: string;
  discarded?: string;
}

/** A text's words, lowercased, without a plural s: how a quote and the corrections are compared. */
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.replace(/s$/, ""));

/** Whether `words` appear in `text`'s words, together and in order. */
const contiguous = (words: string[], text: string[]) =>
  words.length > 0 && text.some((_, i) => words.every((w, j) => text[i + j] === w));

/**
 * The statement the rule needs: the Curator's quote is one correction's own words, together and in
 * order (at least four of them); it names the term or one of its synonyms; and it says every value the term is mapped
 * to ("active"), so what's released is what was said. Words picked from here and there, a quote that doesn't say the
 * word it's about, or a mapping its words don't state, isn't someone's statement of it.
 */
export function quotedFrom(quote: string, said: string[], names: string[], values: string[] = []): boolean {
  const q = wordsOf(quote);
  if (q.length < 4) return false;
  const named = names.map(wordsOf).filter((n) => n.length);
  if (!named.some((n) => contiguous(n, q))) return false;
  if (!values.every((v) => contiguous(wordsOf(v), q))) return false;
  return said.some((text) => contiguous(q, wordsOf(text)));
}

/** Whether a correction names the term (or a synonym): only such a one counts toward who said it. */
const names = (text: string, terms: string[]) => {
  const t = wordsOf(text);
  return terms.map(wordsOf).some((n) => n.length > 0 && contiguous(n, t));
};

/**
 * A word's topic, the same for "Paying accounts", "paying accounts" and "paying account": its words lowercased, without
 * a plural s.
 */
export function topicKey(term: string): string {
  return `term:${term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.replace(/s$/, ""))
    .join(" ")}`;
}

/**
 * A correction that may be shared (a thumbs down, an approver's own, or one its person chose to
 * share) opens its topic's learning, or joins the live one about it. Call it in the person's transaction. The
 * Curator starts on it within a minute (`startDueLearnings`).
 */
export async function signalCorrection(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  input: {
    kind: LearningSignal["kind"];
    id: string;
    text: string;
    runId: string | null;
    fromRunId?: string | null;
    connectionId: string;
    /** The word it's about, when known (a memory says it): it joins the topic's live learning. */
    about?: string | null;
  },
): Promise<{ proposalId: string; joined: boolean } | null> {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, SIGNAL_MAX);
  if (!text || !isUuid(input.connectionId) || !isUuid(input.id)) return null;
  const signal: LearningSignal = {
    kind: input.kind,
    id: input.id,
    userId: viewer.userId,
    text,
    runId: input.runId && isUuid(input.runId) ? input.runId : null,
    fromRunId:
      input.fromRunId && isUuid(input.fromRunId)
        ? input.fromRunId
        : input.runId && isUuid(input.runId)
          ? input.runId
          : null,
    at: new Date().toISOString(),
  };
  const title = `Learning: ${(input.about?.trim() || text).slice(0, 70)}`;
  const evidence: LearningEvidence = { signals: [signal] };
  const key = input.about?.trim() ? topicKey(input.about) : null;
  const [row] = await tx.execute<{ id: string; inserted: boolean }>(sql`
    insert into app.proposal as p (org_id, id, connection_id, kind, source, status, title, evidence, dedupe_key,
      requested_by)
    values (${viewer.orgId}, ${uuidv7()}, ${input.connectionId}, 'update', 'curator', 'drafting', ${title},
      ${JSON.stringify(evidence)}::jsonb, ${key}, ${viewer.userId})
    on conflict (org_id, dedupe_key) where source = 'curator' and status in ${live}
    do update set evidence = case
      when p.evidence->'signals' @> ${JSON.stringify([{ kind: signal.kind, id: signal.id }])}::jsonb then p.evidence
      else jsonb_set(p.evidence, '{signals}', coalesce(p.evidence->'signals', '[]'::jsonb) || ${JSON.stringify([signal])}::jsonb)
        || '{"recheck": true}'::jsonb
      end
    returning id, (xmax = 0) as inserted`);
  return row ? { proposalId: row.id, joined: !row.inserted } : null;
}

/**
 * A correction taken back (a 👎 undone or changed): it leaves every live learning it's evidence of, and one left with
 * none that the Curator hasn't started on is discarded.
 */
export async function withdrawSignal(
  tx: TenantTx,
  orgId: string,
  signal: Pick<LearningSignal, "kind" | "id">,
): Promise<void> {
  if (!isUuid(signal.id)) return;
  const it = JSON.stringify([{ kind: signal.kind, id: signal.id }]);
  await tx.execute(sql`
    update app.proposal set evidence = jsonb_set(evidence, '{signals}', coalesce((
        select jsonb_agg(s) from jsonb_array_elements(evidence->'signals') s
        where not (s->>'kind' = ${signal.kind} and s->>'id' = ${signal.id})), '[]'::jsonb))
    where org_id = ${orgId} and source = 'curator' and status in ${live} and evidence->'signals' @> ${it}::jsonb`);
  await tx.execute(sql`
    update app.proposal set status = 'discarded', note = 'Its correction was taken back.', decided_at = now()
    where org_id = ${orgId} and source = 'curator' and status in ('drafting', 'held') and run_id is null
      and jsonb_array_length(coalesce(evidence->'signals', '[]'::jsonb)) = 0`);
}

/** What the Curator reads for a learning: its corrections, and what the corrected answers read. */
export async function learningBrief(
  tx: TenantTx,
  orgId: string,
  proposalId: string,
): Promise<{ signals: LearningSignal[]; read: { title: string | null; tables: string[] }[] } | null> {
  if (!isUuid(proposalId)) return null;
  const [p] = await tx.execute<{ evidence: LearningEvidence }>(sql`
    select evidence from app.proposal where org_id = ${orgId} and id = ${proposalId} and source = 'curator'`);
  if (!p) return null;
  const signals = (p.evidence.signals ?? []).slice(-10);
  const runs = [...new Set(signals.flatMap((s) => (s.runId ? [s.runId] : [])))];
  const read = runs.length
    ? await tx.execute<{ title: string | null; tables: string[] }>(sql`
        select q.title, coalesce(array(select jsonb_array_elements_text(q.reads->'tables')), '{}') as tables
        from app.query_run q
        where q.org_id = ${orgId} and q.requester_type = 'run' and q.requester_id = any(${`{${runs.join(",")}}`}::uuid[])
          and q.reads is not null
        order by q.id limit 20`)
    : [];
  return { signals, read };
}

/**
 * The learnings waiting for the Curator, in every workspace: each started now, or held while its workspace's daily
 * cap or background budget is spent (and started again once it has room). One at a time a proposal, by its row lock.
 */
export async function startDueLearnings(
  deps: {
    withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
    withTenant: GatewayDeps["withTenant"];
    boss: PgBoss;
    deploymentKeys: DeploymentKeys;
  },
  now = new Date(),
): Promise<{ started: number; held: number }> {
  const due = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from app.proposal
      where source = 'curator' and status in ('drafting', 'held') and run_id is null
      order by created_at limit 50`),
  );
  let started = 0;
  let held = 0;
  for (const d of due) {
    const outcome = await deps.withTenant(d.org_id, async (tx) => {
      const [p] = await tx.execute<{ connection_id: string; title: string; requested_by: string | null }>(sql`
        select connection_id, title, requested_by from app.proposal
        where org_id = ${d.org_id} and id = ${d.id} and source = 'curator' and status in ('drafting', 'held')
          and run_id is null
        for update skip locked`);
      if (!p) return "skip" as const;
      const [today] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from app.run
        where org_id = ${d.org_id} and profile = 'curator' and queued_at > ${now.toISOString()}::timestamptz - interval '1 day'`);
      let why: string | null = (today?.n ?? 0) >= CURATOR_DAILY_RUNS ? "Today's learning runs are used up." : null;
      if (!why) {
        try {
          await checkBackgroundBudget(tx, d.org_id, now);
        } catch (error) {
          if (!(error instanceof BackgroundBudgetReached)) throw error;
          why = error.message;
        }
      }
      if (why) {
        await tx.execute(sql`
          update app.proposal set status = 'held', held_reason = ${why} where org_id = ${d.org_id} and id = ${d.id}`);
        return "held" as const;
      }
      const runId = await startCuratorRun(tx, deps, d.org_id, {
        proposalId: d.id,
        connectionId: p.connection_id,
        title: p.title,
        by: p.requested_by,
      });
      await tx.execute(sql`
        update app.proposal set status = 'drafting', held_reason = null, run_id = ${runId}
        where org_id = ${d.org_id} and id = ${d.id}`);
      await enqueue(deps.boss, tx, agentBackgroundQueue, { orgId: d.org_id, runId }, { singletonKey: runId });
      return "started" as const;
    });
    if (outcome === "started") started += 1;
    if (outcome === "held") held += 1;
  }
  return { started, held };
}

/** The Curator's run: a thread of its own (channel curator, nobody's conversation), on the workspace's model. */
async function startCuratorRun(
  tx: TenantTx,
  deps: { deploymentKeys: DeploymentKeys },
  orgId: string,
  input: { proposalId: string; connectionId: string; title: string; by: string | null },
): Promise<string> {
  const choice = await defaultChoice(tx, orgId, deps.deploymentKeys);
  const threadId = uuidv7();
  const messageId = uuidv7();
  const runId = uuidv7();
  const brief = "Learn what you can from these corrections, as one term, or say why there's nothing to learn.";
  await tx.execute(sql`
    insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${orgId}, ${threadId}, ${input.connectionId}, ${input.by}, ${input.title.slice(0, 80)}, 'curator',
      'private')`);
  await tx.execute(sql`
    insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
    values (${orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, orgId, threadId)}, 'user', null,
      ${JSON.stringify({ role: "user", content: brief })}::jsonb, ${brief})`);
  await tx.execute(sql`
    insert into app.run (org_id, id, thread_id, connection_id, trigger, profile, input_message_id, model, provider,
      reasoning, task)
    values (${orgId}, ${runId}, ${threadId}, ${input.connectionId}, 'proposal', 'curator', ${messageId}, ${choice.model},
      ${choice.provider}, ${choice.reasoning}, ${JSON.stringify({ proposalId: input.proposalId })}::jsonb)`);
  return runId;
}

/** The term the Curator proposed, as the glossary's YAML: its words, its mapping, what it is not, where it came from. */
export function learnedTermYaml(
  learning: NonNullable<CuratorOutcome["learning"]>,
  proposalId: string,
  existing: TermSpec | null,
): string {
  const spec: Record<string, unknown> = {
    term: existing?.term ?? learning.term,
    means: learning.means,
    synonyms: [...new Set([...(existing?.synonyms ?? []), ...learning.synonyms])].slice(0, 12),
    ...(learning.column
      ? { maps_to: { column: learning.column, ...(learning.values?.length ? { values: learning.values } : {}) } }
      : existing?.maps_to
        ? { maps_to: existing.maps_to }
        : {}),
    ...(learning.not.length ? { not: learning.not.slice(0, 10) } : {}),
    learned: { proposalId },
  };
  return stringify(spec);
}

/**
 * A Curator run ended: its learning kept as a proposed term version (a new term, or the next version of the one with
 * that name), its quote held to the corrections' words, and joined to its topic's live learning when there is one.
 * Returns what comes next for the proposal: its check and test (`evaluating`), or nothing (it failed, was discarded
 * or joined another).
 */
export async function settleLearning(
  deps: { withTenant: GatewayDeps["withTenant"]; boss: PgBoss | null },
  orgId: string,
  runId: string,
): Promise<{ proposalId: string; next: "evaluate" | null } | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [r] = await tx.execute<{ status: string; error: string | null; outcome: CuratorOutcome | null }>(sql`
      select status, error, outcome from app.run where org_id = ${orgId} and id = ${runId}`);
    if (!r || !["succeeded", "failed", "cancelled"].includes(r.status)) return null;
    const [p] = await tx.execute<{ id: string; connection_id: string; evidence: LearningEvidence }>(sql`
      select id, connection_id, evidence from app.proposal
      where org_id = ${orgId} and run_id = ${runId} and source = 'curator' and status = 'drafting'
      for update`);
    if (!p) return null;
    const set = async (status: string, evidence: Partial<LearningEvidence>, note: string | null = null) => {
      await tx.execute(sql`
        update app.proposal set status = ${status}, evidence = evidence || ${JSON.stringify(evidence)}::jsonb,
          note = coalesce(${note}, note), decided_at = case when ${status} in ('failed', 'discarded') then now() end
        where org_id = ${orgId} and id = ${p.id}`);
    };
    const outcome = r.outcome?.kind === "curator" ? r.outcome : null;
    if (!outcome || r.status !== "succeeded") {
      await set("failed", { failed: r.error ?? "The Curator stopped before it proposed anything." });
      return { proposalId: p.id, next: null };
    }
    if (outcome.status === "discarded" || !outcome.learning) {
      const why = outcome.reason?.slice(0, 300) || "Nothing here to learn for the team.";
      await set("discarded", { discarded: why }, why);
      return { proposalId: p.id, next: null };
    }
    const learning = await withoutTableNames(tx, orgId, p.connection_id, outcome.learning);
    const key = topicKey(learning.term);
    // The topic already has a live learning: this one's corrections join it, decided again there.
    const [other] = await tx.execute<{ id: string }>(sql`
      select id from app.proposal
      where org_id = ${orgId} and source = 'curator' and dedupe_key = ${key} and id <> ${p.id} and status in ${live}
      for update`);
    if (other) {
      await tx.execute(sql`
        update app.proposal set evidence = jsonb_set(evidence, '{signals}',
            coalesce(evidence->'signals', '[]'::jsonb) || ${JSON.stringify(p.evidence.signals ?? [])}::jsonb)
          || '{"recheck": true}'::jsonb
        where org_id = ${orgId} and id = ${other.id}`);
      await set("superseded", {}, "Joined the learning already under way about this.");
      return { proposalId: other.id, next: null };
    }
    // The term it is, by topic, whatever its spelling ("Paying account", "paying accounts"), or when it names one of a
    // term's synonyms.
    const terms = await tx.execute<{
      id: string;
      title: string;
      spec: TermSpec;
      released_version: number | null;
      verified_by: string | null;
    }>(sql`
      select i.id, i.title, v.spec, i.released_version, i.verified_by from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.org_id = ${orgId} and i.kind = 'term' and i.scope = 'org' and i.deleted_at is null`);
    const wanted = new Set([learning.term, ...learning.synonyms].map(topicKey));
    const existing =
      terms.find((t) => topicKey(t.title) === key) ??
      terms.find((t) => [t.title, ...(t.spec?.synonyms ?? [])].some((n) => wanted.has(topicKey(n))));
    let saved: { id: string; version: number };
    try {
      saved = await saveTerm(
        tx,
        { orgId, userId: null },
        {
          ...(existing ? { id: existing.id } : {}),
          body: learnedTermYaml(learning, p.id, existing?.spec ?? null),
          connectionId: p.connection_id,
          changeNote: "Learned from corrections",
          proposed: true,
        },
      );
    } catch (error) {
      if (!(error instanceof ContextProblem)) throw error;
      await set("failed", { learning, failed: error.message });
      return { proposalId: p.id, next: null };
    }
    const quoteOk = quotedFrom(
      learning.quote,
      (p.evidence.signals ?? []).map((s) => s.text),
      [learning.term, ...learning.synonyms],
      learning.values ?? [],
    );
    // Its topic's key, unless another learning about it took it meanwhile (two Curator runs settling at once): then
    // this one's corrections join that one, as above.
    const taken = await tx.execute<{ id: string }>(sql`
      update app.proposal set dedupe_key = ${key}
      where org_id = ${orgId} and id = ${p.id}
        and not exists (select 1 from app.proposal o where o.org_id = ${orgId} and o.source = 'curator'
          and o.dedupe_key = ${key} and o.id <> ${p.id} and o.status in ${live})
      returning id`);
    if (!taken.length) {
      await tx.execute(sql`
        update app.proposal o set evidence = jsonb_set(o.evidence, '{signals}',
            coalesce(o.evidence->'signals', '[]'::jsonb) || ${JSON.stringify(p.evidence.signals ?? [])}::jsonb)
          || '{"recheck": true}'::jsonb
        where o.org_id = ${orgId} and o.source = 'curator' and o.dedupe_key = ${key} and o.id <> ${p.id}
          and o.status in ${live}`);
      await set("superseded", {}, "Joined the learning already under way about this.");
      return { proposalId: p.id, next: null };
    }
    await tx.execute(sql`
      update app.proposal set status = 'evaluating', dedupe_key = ${key}, items = ${`{${saved.id}}`}::uuid[],
        title = ${`Learning: ${learning.term}`}, rationale = ${learning.means.slice(0, 600)},
        evidence = evidence || ${JSON.stringify({
          learning,
          termId: saved.id,
          termVersion: saved.version,
          quoteOk,
          before: { releasedVersion: existing?.released_version ?? null, verifiedBy: existing?.verified_by ?? null },
        } satisfies Partial<LearningEvidence>)}::jsonb
      where org_id = ${orgId} and id = ${p.id}`);
    // Its check and test next, queued with what they read, so neither exists without the other.
    if (deps.boss) {
      await enqueueOnce(deps.boss, tx, learningEvaluateQueue, { orgId, proposalId: p.id }, { singletonKey: p.id });
    }
    return { proposalId: p.id, next: "evaluate" };
  });
}

/**
 * A learning's synonyms, less any that name one of the source's tables or views ("subscriptions" for
 * subscriptions): a table's name is wider than a term mapped to some of its rows, and would bring every
 * question about the table to the term's filter.
 */
async function withoutTableNames(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  learning: NonNullable<CuratorOutcome["learning"]>,
): Promise<NonNullable<CuratorOutcome["learning"]>> {
  if (!learning.synonyms.length) return learning;
  const tables = await tx.execute<{ name: string }>(sql`
    select distinct split_part(fq_name, '.', -1) as name from app.catalog_object
    where org_id = ${orgId} and connection_id = ${connectionId} and kind in ('table', 'view') and removed_at is null`);
  const names = new Set(tables.map((t) => topicKey(t.name)));
  return { ...learning, synonyms: learning.synonyms.filter((w) => !names.has(topicKey(w))) };
}

/** One identifier as the dialect quotes it: the catalog's own names, checked when the term was kept. */
const quoted = (dialect: string, name: string) =>
  dialect === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

/** The i-th value's placeholder as the dialect binds it: never the value itself in the SQL. */
const placeholder = (dialect: string, i: number) =>
  dialect === "clickhouse" ? `{v${i}:String}` : dialect === "mysql" ? "?" : `$${i + 1}`;

/**
 * A learning's check: a query through the gateway that proves the term is true of the data now, the
 * mapped table filtered as the term says. It passes when it ran and returned rows; the query run is the proof.
 */
export async function checkLearning(
  deps: GatewayDeps,
  orgId: string,
  proposalId: string,
): Promise<LearningEvidence["check"] | null> {
  const found = await deps.withTenant(orgId, async (tx) => {
    const [p] = await tx.execute<{ connection_id: string; evidence: LearningEvidence; dialect: string }>(sql`
      select p.connection_id, p.evidence, c.dialect from app.proposal p
      join app.connection c on c.org_id = p.org_id and c.id = p.connection_id
      where p.org_id = ${orgId} and p.id = ${proposalId} and p.source = 'curator' and p.status = 'evaluating'`);
    return p ?? null;
  });
  if (!found?.evidence.learning) return null;
  const { learning, termId } = found.evidence;
  let check: NonNullable<LearningEvidence["check"]>;
  const [schema, table, column] = (learning.column ?? "").split(".");
  if (!schema || !table || !column) {
    check = { queryRunId: null, ok: false, rows: null, why: "It says no column, so there's nothing to check it on." };
  } else {
    const values = (learning.values ?? []).slice(0, 10);
    const where = values.length
      ? ` where ${quoted(found.dialect, column)} in (${values.map((_, i) => placeholder(found.dialect, i)).join(", ")})`
      : "";
    const out = await runQuery(deps, {
      orgId,
      connectionId: found.connection_id,
      sql: `select count(*) as n from ${quoted(found.dialect, schema)}.${quoted(found.dialect, table)}${where}`,
      params: values.map((value, i) => ({ name: `v${i}`, value })),
      mode: "execute",
      title: `Check: ${learning.term}`,
      requester: { type: "definition", id: termId ?? null },
    });
    const n = out.status === "succeeded" ? Number(out.rows[0]?.[0] ?? 0) : null;
    check = {
      queryRunId: out.queryRunId,
      ok: n !== null && n > 0,
      rows: n,
      ...(n === null
        ? { why: out.error?.message ?? "The check didn't run." }
        : n === 0
          ? { why: "No rows match." }
          : {}),
    };
  }
  await deps.withTenant(orgId, (tx) =>
    tx.execute(sql`
      update app.proposal set evidence = evidence || ${JSON.stringify({ check })}::jsonb
      where org_id = ${orgId} and id = ${proposalId}`),
  );
  return check;
}

/**
 * A learning's test run: the Curator's question asked once of the analyst, given the unreleased term (run.candidate)
 * and nothing else new, on the eval channel. Its spend is background work (trigger proposal). The caller runs it.
 */
export async function startLearningTest(
  deps: { withTenant: GatewayDeps["withTenant"]; deploymentKeys: DeploymentKeys },
  orgId: string,
  proposalId: string,
): Promise<string | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [p] = await tx.execute<{ connection_id: string; evidence: LearningEvidence }>(sql`
      select connection_id, evidence from app.proposal
      where org_id = ${orgId} and id = ${proposalId} and source = 'curator' and status = 'evaluating'
      for update`);
    const learning = p?.evidence.learning;
    if (!p || !learning || !p.evidence.termId || !p.evidence.termVersion) return null;
    // A retried evaluation (a worker stopped mid-test) goes on with the test it started: never a second one.
    const started = p.evidence.test?.runId;
    if (started && isUuid(started)) return started;
    try {
      await checkBackgroundBudget(tx, orgId);
    } catch (error) {
      if (!(error instanceof BackgroundBudgetReached)) throw error;
      await tx.execute(sql`
        update app.proposal set evidence = evidence || ${JSON.stringify({
          test: { runId: "", ok: null, used: null, why: error.message },
        })}::jsonb
        where org_id = ${orgId} and id = ${proposalId}`);
      return null;
    }
    const choice = await defaultChoice(tx, orgId, deps.deploymentKeys);
    const threadId = uuidv7();
    const messageId = uuidv7();
    const runId = uuidv7();
    const question = learning.question.slice(0, 300);
    await tx.execute(sql`
      insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
      values (${orgId}, ${threadId}, ${p.connection_id}, null, ${`Test: ${question}`.slice(0, 80)}, 'eval', 'private')`);
    await tx.execute(sql`
      insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
      values (${orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, orgId, threadId)}, 'user', null,
        ${JSON.stringify({ role: "user", content: question })}::jsonb, ${question})`);
    await tx.execute(sql`
      insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, provider, reasoning,
        candidate)
      values (${orgId}, ${runId}, ${threadId}, ${p.connection_id}, 'proposal', ${messageId}, ${choice.model},
        ${choice.provider}, ${choice.reasoning},
        ${JSON.stringify({ itemId: p.evidence.termId, version: p.evidence.termVersion })}::jsonb)`);
    await tx.execute(sql`
      update app.proposal set evidence = evidence || ${JSON.stringify({
        test: { runId, ok: null, used: null },
      })}::jsonb
      where org_id = ${orgId} and id = ${proposalId}`);
    return runId;
  });
}

/** What a structural test expects of an answer's queries. */
export interface StructuralExpect {
  /** It reads this table… */
  reads: string;
  /** …comparing this column with these values, when the term says so. */
  compared?: { column: string; values: string[] };
  /** It reads none of these. */
  not: string[];
}

/** The structural expectation a term makes: its mapped table and filter, and the tables it is not. */
export function expectOf(learning: NonNullable<CuratorOutcome["learning"]>): StructuralExpect | null {
  const parts = (learning.column ?? "").toLowerCase().split(".");
  if (parts.length !== 3) return null;
  const [schema, table, column] = parts as [string, string, string];
  return {
    reads: `${schema}.${table}`,
    ...(learning.values?.length ? { compared: { column, values: learning.values } } : {}),
    not: learning.not.map((t) => t.toLowerCase()),
  };
}

/** Grades what an answer's queries read against a structural expectation: pass, or why not. */
export function gradeReads(expect: StructuralExpect, reads: QueryReads[]): { ok: boolean; why?: string } {
  const tables = new Set(reads.flatMap((r) => r.tables));
  const wrong = expect.not.filter((t) => tables.has(t));
  if (wrong.length) return { ok: false, why: `It read ${wrong.join(", ")}.` };
  if (!tables.has(expect.reads)) return { ok: false, why: `It didn't read ${expect.reads}.` };
  const want = expect.compared;
  if (want) {
    const hit = reads.some((r) =>
      r.compared.some(
        (c) =>
          (c.table === null || c.table === expect.reads) &&
          c.column === want.column.toLowerCase() &&
          want.values.every((v) => c.values.some((x) => x.toLowerCase() === v.toLowerCase())),
      ),
    );
    if (!hit) return { ok: false, why: `It didn't keep to ${want.column} = ${want.values.join(", ")}.` };
  }
  return { ok: true };
}

/**
 * A learning's test run ended: graded on what its queries read, and whether its answer applied the term (an
 * interpretation line names it as the glossary's, as the analyst is told to: "Paying accounts = … (Glossary)"). The
 * test passes only when both hold.
 */
export async function gradeLearningTest(
  deps: { withTenant: GatewayDeps["withTenant"] },
  orgId: string,
  proposalId: string,
): Promise<LearningEvidence["test"] | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [p] = await tx.execute<{ evidence: LearningEvidence }>(sql`
      select evidence from app.proposal where org_id = ${orgId} and id = ${proposalId} and source = 'curator'
      for update`);
    const runId = p?.evidence.test?.runId;
    const learning = p?.evidence.learning;
    if (!p || !runId || !learning || !isUuid(runId)) return null;
    const [r] = await tx.execute<{ status: string; outcome: { kind?: string; interpretation?: string[] } | null }>(
      sql`select status, outcome from app.run where org_id = ${orgId} and id = ${runId}`,
    );
    if (!r || !["succeeded", "failed", "cancelled"].includes(r.status)) return null;
    const reads = await tx.execute<{ reads: QueryReads }>(sql`
      select reads from app.query_run
      where org_id = ${orgId} and requester_type = 'run' and requester_id = ${runId} and status = 'succeeded'
        and reads is not null`);
    const expect = expectOf(learning);
    const graded = expect
      ? gradeReads(
          expect,
          reads.map((q) => q.reads),
        )
      : { ok: false, why: "It says no table." };
    const named = [learning.term, ...learning.synonyms].map((t) => t.toLowerCase());
    const used =
      r.outcome?.kind === "answer" &&
      (r.outcome.interpretation ?? []).some(
        (line) => /glossary/i.test(line) && named.some((t) => line.toLowerCase().includes(t)),
      );
    const test: NonNullable<LearningEvidence["test"]> = {
      runId,
      ok: r.status === "succeeded" && graded.ok,
      used,
      ...(r.status !== "succeeded"
        ? { why: "The test run didn't finish." }
        : graded.why
          ? { why: graded.why }
          : !used
            ? { why: "Its answer didn't say it applied the term." }
            : {}),
    };
    await tx.execute(sql`
      update app.proposal set evidence = evidence || ${JSON.stringify({ test })}::jsonb
      where org_id = ${orgId} and id = ${proposalId}`);
    return test;
  });
}

/**
 * The rule: code releases a learning on its own only when all five hold; otherwise it waits for an
 * approver's one tap (`open`). Returns what it decided, and what it missed.
 */
export async function decideLearning(
  deps: { withTenant: GatewayDeps["withTenant"] },
  orgId: string,
  proposalId: string,
): Promise<{ automatic: boolean; missing: string[] } | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [p] = await tx.execute<{ status: string; evidence: LearningEvidence }>(sql`
      select status, evidence from app.proposal
      where org_id = ${orgId} and id = ${proposalId} and source = 'curator' and status in ('evaluating', 'open')
      for update`);
    const e = p?.evidence;
    if (!p || !e?.learning || !e.termId || !e.termVersion) return null;
    const missing: string[] = [];
    // Every name the version that would be released answers to: the Curator's term and synonyms, and the name and
    // synonyms of the draft it was kept in (a draft found by a synonym keeps its own name).
    const [kept] = await tx.execute<{ term: string | null; synonyms: string[] }>(sql`
      select v.spec->>'term' as term, coalesce(v.spec->'synonyms', '[]'::jsonb) as synonyms
      from app.context_item_version v
      where v.org_id = ${orgId} and v.item_id = ${e.termId} and v.version = ${e.termVersion}`);
    const terms = [
      ...new Set([
        e.learning.term,
        ...e.learning.synonyms,
        ...(kept?.term ? [kept.term] : []),
        ...(kept?.synonyms ?? []),
      ]),
    ];
    // 1. Stated outright: the Curator's quote is one correction's own words, naming the term.
    if (!e.quoteOk) missing.push("stated outright");
    // 2. A low-risk kind: a new term, never a change to one the team already uses (that's an approver's to make)…
    if (e.before?.releasedVersion != null) missing.push("a new term, not a change to one the team uses");
    // …and its words name no released metric or dataset, the only way a term moves a verified number.
    const words = terms.map((w) => topicKey(w));
    const named = await tx.execute<{ name: string }>(sql`
      select lower(name) as name from (
        select i.title as name from app.context_item i
        where i.org_id = ${orgId} and i.kind in ('metric', 'dataset') and i.released_version is not null
          and i.deleted_at is null
        union all
        select i.slug from app.context_item i
        where i.org_id = ${orgId} and i.kind in ('metric', 'dataset') and i.released_version is not null
          and i.deleted_at is null
        union all
        select jsonb_array_elements_text(coalesce(v.spec->'synonyms', '[]'::jsonb)) from app.context_item i
        join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
        where i.org_id = ${orgId} and i.kind in ('metric', 'dataset') and i.deleted_at is null
      ) n`);
    // …nor another released term's name or synonyms: that's a change to a term the team uses, by another name.
    const others = await tx.execute<{ name: string }>(sql`
      select i.title as name from app.context_item i
      where i.org_id = ${orgId} and i.kind = 'term' and i.released_version is not null and i.deleted_at is null
        and i.id <> ${e.termId}
      union all
      select jsonb_array_elements_text(coalesce(v.spec->'synonyms', '[]'::jsonb)) from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
      where i.org_id = ${orgId} and i.kind = 'term' and i.deleted_at is null and i.id <> ${e.termId}`);
    const collides = [...named, ...others].some((n) => words.includes(topicKey(n.name)));
    if (collides) missing.push("a low-risk kind");
    // An approver changed it: what's released then is theirs, not what was said, so it waits for their tap.
    if (e.edited) missing.push("changed by an approver, so it waits for their tap");
    // 3. Its check passed.
    if (!e.check?.ok) missing.push("its check passed");
    // 4. Its test passed, and used it.
    if (!e.test?.ok || !e.test.used) missing.push("its test passed and used it");
    // 5. Said by an approver, or by two different people: counted from what they did themselves (a 👎, Suggest), never
    // from a chat correction the analyst judged one, only through a correction that names the term, and only while
    // they're members who may correct (owner, admin or member: a viewer or someone gone never counts). What's released
    // is what they said: the quote, and every synonym it would answer to, are in the corrections of the people counted
    // (the approver's own, or the two people's), never in someone else's that merely names the term.
    const said = (e.signals ?? []).filter((s) => s.kind !== "memory" && names(s.text, terms));
    const ids = [...new Set(said.map((s) => s.userId).filter(isUuid))];
    const roles = ids.length
      ? await tx.execute<{ user_id: string; role: string | null }>(sql`
          select u::text as user_id, app.member_role(u) as role from unnest(${`{${ids.join(",")}}`}::uuid[]) as u`)
      : [];
    const roleOf = new Map(roles.map((r) => [r.user_id, r.role]));
    const people = ids.filter((id) => ["owner", "admin", "member"].includes(roleOf.get(id) ?? ""));
    const approvers = people.filter((id) => roleOf.get(id) === "owner" || roleOf.get(id) === "admin");
    const learning = e.learning;
    const stated = (by: string[]) => {
      const texts = said.filter((s) => by.includes(s.userId)).map((s) => s.text);
      return (
        quotedFrom(learning.quote, texts, terms, learning.values ?? []) &&
        terms.every((w) => texts.some((t) => names(t, [w])))
      );
    };
    const approver = approvers.find((id) => stated([id]));
    const byTwo = people.length >= 2 && stated(people);
    if (!approvers.length && people.length < 2) missing.push("said by an approver or two people");
    else if (!approver && !byTwo) missing.push("stated, synonyms too, by the people who said it");
    const automatic = missing.length === 0;
    const decided = { automatic, missing };
    if (automatic) {
      // Released as the approver who stated it; by two people, as the rule, approved by no one.
      const released = approver
        ? await approveContext(tx, { orgId, userId: approver }, [{ id: e.termId, version: e.termVersion }])
        : await tx.execute<{ id: string; title: string }>(sql`
            update app.context_item set status = 'verified', released_version = current_version, verified_by = null,
              verified_at = now(), updated_at = now()
            where org_id = ${orgId} and id = ${e.termId} and current_version = ${e.termVersion} and kind = 'term'
              and deleted_at is null and status in ('draft', 'proposed', 'needs_review')
            returning id, title`);
      // The rule's own release (two people said it) is the system's doing; an approver's is recorded as theirs.
      if (!approver && released.length) {
        await audit(tx, {
          action: "knowledge.approved",
          actor: { type: "system", name: "The learning rule" },
          target: { type: "knowledge", id: e.termId, name: (released[0] as { title?: string }).title ?? null },
          detail: { kind: "learning", version: e.termVersion },
        });
      }
      if (released.length) {
        await tx.execute(sql`
          update app.proposal set status = 'approved', decided_at = now(),
            evidence = (evidence - 'recheck') || ${JSON.stringify({ decided })}::jsonb
          where org_id = ${orgId} and id = ${proposalId}`);
        return decided;
      }
    }
    await tx.execute(sql`
      update app.proposal set status = 'open',
        evidence = (evidence - 'recheck') || ${JSON.stringify({ decided: { automatic: false, missing } })}::jsonb
      where org_id = ${orgId} and id = ${proposalId}`);
    return { automatic: false, missing };
  });
}
