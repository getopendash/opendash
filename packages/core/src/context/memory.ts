/**
 * Personal memory: what a word or table means to someone, or how they
 * want answers, kept for them alone: when they ask, or, when they correct the analyst or state a
 * standing preference, always in their own words. A `context_item` of kind memory, scope personal, scope_id = its
 * owner: the tenant policy hides it from everyone else, and every query here also names the owner. Call these in a
 * transaction carrying the owner's user id.
 */
import { createHash } from "node:crypto";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { lockFor } from "../tenancy/locks";
import { ContextProblem } from "./items";

/** How long one memory can be, how many a person keeps, and how many a run is given (the newest). */
export const MEMORY_MAX = 300;
export const MEMORIES_KEPT = 50;
export const MEMORIES_GIVEN = 20;

export interface Memory {
  id: string;
  version: number;
  fact: string;
  createdAt: string;
  /** The conversation it was saved in, when it was. */
  threadId: string | null;
}

/**
 * Why a memory was kept: they asked; they corrected what a word or table means to them; or they stated a
 * standing preference about how answers should look. Only "asked" needs them to have asked.
 */
export type MemoryWhy = "asked" | "correction" | "preference";

const clean = (fact: string) => fact.replace(/\s+/g, " ").trim();

/**
 * Asking to keep something: "remember", "add it to your memory", "keep that in mind", "note this". "Memory" counts only
 * as where to put it, so "what's the memory usage?" or "save that as a dashboard" doesn't ask.
 */
const ASKS =
  /\b(remember|memori[sz]e|keep (?:this |that |it )?in mind|from now on|going forward|don'?t forget|for next time|note (?:that|this|it)|make a note)\b|\b(?:add|put|save|store|keep)\b[^.?!]{0,30}\b(?:to|in|into) (?:your |the |my )?memory\b/i;
const SMALL = new Set([
  "the",
  "and",
  "that",
  "this",
  "for",
  "not",
  "but",
  "with",
  "you",
  "your",
  "are",
  "was",
  "mean",
  "means",
]);
/** Words in any script, lowercased, without a plural s; short ones and a few fillers left out. */
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !SMALL.has(w))
    .map((w) => w.replace(/s$/, ""));

/**
 * Whether `fact` is something the person asked, in `question`, to remember (memory poisoning is cheap). The
 * question must ask to remember, and every word of the fact must be the person's own, from one thing they wrote: the
 * question, or one of their earlier messages or corrections in the conversation (`earlier`, never the analyst's). A
 * fact can leave words out, never bring new ones or piece words together from different messages, so text the
 * analyst read in a result, a guide or a tool's output can't ride along into their memory. "Add it to your memory"
 * after their correction keeps the correction.
 */
export function askedToRemember(question: string, fact: string, earlier: string[] = []): boolean {
  return ASKS.test(question) && inOwnWords(fact, [question, ...earlier]);
}

/**
 * Whether every word of `fact` is in one of `said` (the person's own messages and corrections, never the analyst's):
 * the same check whether they asked to remember it or corrected the analyst, and the one that tells a
 * statement someone made from one the Curator wrote.
 */
export function inOwnWords(fact: string, said: string[]): boolean {
  const kept = words(fact);
  if (!kept.length) return false;
  return said.some((text) => {
    const theirs = new Set(words(text));
    return kept.every((w) => theirs.has(w));
  });
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a memory kept before memories said what they're about (no `about`) defines `about`: "Paying accounts
 * means…", "By paying accounts I mean…", "…, Paying accounts are…". Only those are replaced by a new memory about the
 * same thing, never one that merely mentions it ("show paying accounts in a table"); a wrong one is the person's own,
 * and Undo brings it back.
 */
export function defines(memory: string, about: string): boolean {
  const a = escaped(about.trim()).replace(/\s+/g, "\\s+");
  if (!a) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])(?:${a}\\s+(?:means?|is|are|=|refers? to)|by\\s+${a}\\s*,?\\s+(?:I|we)\\s+mean)(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(memory.trim());
}

/**
 * Keeps `fact` for its owner: a new memory, or the one they already have that says the same. Past MEMORIES_KEPT the
 * oldest are let go; returns how many.
 */
export async function rememberFact(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: {
    fact: string;
    runId?: string | null;
    threadId?: string | null;
    why?: MemoryWhy;
    /**
     * The word or phrase it's about, in the fact ("paying accounts"): one memory per thing, the newest replacing the
     * rest.
     */
    about?: string | null;
  },
): Promise<{ id: string; fact: string; existing: boolean; letGo: number; replaced: string[] }> {
  const fact = clean(input.fact ?? "");
  if (fact.length < 3 || fact.length > MEMORY_MAX) {
    throw new ContextProblem("invalid", `Keep a memory to one sentence, 3 to ${MEMORY_MAX} characters.`);
  }
  // What it's about counts only when the fact says it.
  const aboutWords = words(input.about ?? "");
  const about =
    aboutWords.length && aboutWords.every((w) => words(fact).includes(w))
      ? clean(input.about ?? "").slice(0, 80)
      : null;
  const mine = sql`org_id = ${ctx.orgId} and kind = 'memory' and scope = 'personal' and scope_id = ${ctx.userId}
    and deleted_at is null`;
  const [same] = await tx.execute<{ id: string }>(sql`
    select id from app.context_item where ${mine} and lower(title) = lower(${fact})`);
  if (same) return { id: same.id, fact, existing: true, letGo: 0, replaced: [] };
  // One memory an answer kept unasked, counted and kept in this transaction under the run's lock, so two
  // calls at once can't both pass.
  if (input.why && input.why !== "asked" && input.runId && isUuid(input.runId)) {
    await lockFor(tx, `memory-run:${input.runId}`);
    if (await unaskedMemoriesOfRun(tx, ctx, input.runId)) {
      throw new ContextProblem(
        "invalid",
        "One memory an answer unless they ask you to remember more: this one isn't kept.",
      );
    }
  }
  // The older memories about the same thing go (Undo brings them back): one said to be about it, or one kept before
  // memories said what they're about that defines it.
  const replaced = about
    ? (
        await tx.execute<{ id: string; title: string; about: string | null }>(sql`
          select i.id, i.title, v.spec->>'about' as about from app.context_item i
          join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
          where i.org_id = ${ctx.orgId} and i.kind = 'memory' and i.scope = 'personal' and i.scope_id = ${ctx.userId}
            and i.deleted_at is null`)
      )
        .filter((m) => (m.about ? m.about.toLowerCase() === about.toLowerCase() : defines(m.title, about)))
        .map((m) => m.id)
    : [];
  if (replaced.length) {
    await tx.execute(sql`
      update app.context_item set deleted_at = now()
      where ${mine} and id in (${sql.join(
        replaced.map((r) => sql`${r}::uuid`),
        sql`, `,
      )})`);
  }
  const id = uuidv7();
  const spec = {
    fact,
    ...(input.runId && isUuid(input.runId) ? { runId: input.runId } : {}),
    ...(input.threadId && isUuid(input.threadId) ? { threadId: input.threadId } : {}),
    ...(input.why && input.why !== "asked" ? { why: input.why } : {}),
    ...(about ? { about } : {}),
    // What Undo keeps again.
    ...(replaced.length ? { replaced } : {}),
  };
  await tx.execute(sql`
    insert into app.context_item (org_id, id, kind, scope, scope_id, path, slug, title, owner_id, status,
      current_version, released_version, verified_by, verified_at)
    values (${ctx.orgId}, ${id}, 'memory', 'personal', ${ctx.userId}, ${`/memory/${ctx.userId}/${id}.md`},
      ${`m_${id.replace(/-/g, "")}`}, ${fact}, ${ctx.userId}, 'verified', 1, 1, ${ctx.userId}, now())`);
  await tx.execute(sql`
    insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source, author_id)
    values (${ctx.orgId}, ${id}, 1, ${fact}, ${createHash("sha256").update(fact).digest("hex")},
      ${JSON.stringify(spec)}::jsonb, 'user', ${ctx.userId})`);
  const dropped = await tx.execute<{ id: string }>(sql`
    update app.context_item set deleted_at = now()
    where org_id = ${ctx.orgId} and id in (
      select id from app.context_item
      where org_id = ${ctx.orgId} and kind = 'memory' and scope = 'personal' and scope_id = ${ctx.userId}
        and deleted_at is null
      order by created_at desc offset ${MEMORIES_KEPT})
    returning id`);
  return { id, fact, existing: false, letGo: dropped.length, replaced };
}

/**
 * The memories a run kept without being asked (corrections and preferences): at most one a run, so an
 * answer that keeps steering can't fill someone's memory.
 */
export async function unaskedMemoriesOfRun(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  runId: string,
): Promise<number> {
  if (!isUuid(runId)) return 0;
  const [r] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = 1
    where i.org_id = ${ctx.orgId} and i.kind = 'memory' and i.scope = 'personal' and i.scope_id = ${ctx.userId}
      and v.spec->>'runId' = ${runId} and v.spec->>'why' is not null`);
  return r?.n ?? 0;
}

/** What a run remembered for its asker, still kept: the Slack reply's "Remembered for you". */
export async function memoriesOfRun(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  runId: string,
): Promise<{ id: string; fact: string; why: MemoryWhy }[]> {
  if (!isUuid(runId)) return [];
  return tx.execute<{ id: string; fact: string; why: MemoryWhy }>(sql`
    select i.id, i.title as fact, coalesce(v.spec->>'why', 'asked') as why from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${ctx.orgId} and i.kind = 'memory' and i.scope = 'personal' and i.scope_id = ${ctx.userId}
      and i.deleted_at is null and v.spec->>'runId' = ${runId}
    order by i.created_at`);
}

/**
 * Undo of a memory the analyst kept (the answer's Undo, web and Slack): it's forgotten, and the ones it replaced (as it
 * recorded them, or as given) are kept again. Only its owner can.
 */
export async function undoRemember(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  id: string,
  replaced: string[] = [],
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [kept] = await tx.execute<{ replaced: string[] | null }>(sql`
    select v.spec->'replaced' as replaced from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${ctx.orgId} and i.id = ${id} and i.kind = 'memory' and i.scope = 'personal'
      and i.scope_id = ${ctx.userId}`);
  const forgotten = await forgetMemory(tx, ctx.orgId, ctx.userId, id);
  const older = [...new Set([...replaced, ...(Array.isArray(kept?.replaced) ? kept.replaced : [])])].filter(isUuid);
  if (forgotten) for (const r of older.slice(0, 10)) await restoreMemory(tx, ctx.orgId, ctx.userId, r);
  return forgotten;
}

/** The owner's memories, newest first. */
export async function listMemories(
  tx: TenantTx,
  orgId: string,
  userId: string,
  limit = MEMORIES_KEPT,
): Promise<Memory[]> {
  const rows = await tx.execute<{
    id: string;
    current_version: number;
    title: string;
    created_at: string;
    thread_id: string | null;
  }>(sql`
    select i.id, i.current_version, i.title, i.created_at, v.spec->>'threadId' as thread_id
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${orgId} and i.kind = 'memory' and i.scope = 'personal' and i.scope_id = ${userId}
      and i.deleted_at is null
    order by i.created_at desc limit ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    version: r.current_version,
    fact: r.title,
    createdAt: new Date(r.created_at).toISOString(),
    threadId: r.thread_id,
  }));
}

/**
 * Whether a run may use its asker's memories (given to it, or forgotten by asking): one they asked in a conversation
 * private to them, on the web or in a Slack DM. A Slack thread in a channel is private in OpenDash, but its answers
 * are posted where the channel reads them, the interpretation that names a memory among them; a question sent through
 * the API (even into their web conversation), an eval and background work aren't the person reading their own answer.
 * Chat SDK's thread id is slack:<channel>:<thread ts>; a DM's channel id starts with D.
 */
export async function memoryRoom(tx: TenantTx, orgId: string, runId: string): Promise<boolean> {
  if (!isUuid(runId)) return false;
  const [r] = await tx.execute<{ ok: boolean }>(sql`
    select t.visibility = 'private' and (
        (t.channel = 'web' and r.trigger = 'user')
        or (t.channel = 'slack' and r.trigger = 'slack'
          and exists (select 1 from app.slack_conversation c where c.org_id = t.org_id and c.thread_id = t.id)
          and not exists (
            select 1 from app.slack_conversation c where c.org_id = t.org_id and c.thread_id = t.id
              and split_part(c.slack_thread_id, ':', 2) not like 'D%'))
      ) as ok
    from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where r.org_id = ${orgId} and r.id = ${runId}`);
  return r?.ok === true;
}

/** The memories a run of this person is given: the newest MEMORIES_GIVEN. */
export const memoriesForRun = (tx: TenantTx, orgId: string, userId: string) =>
  listMemories(tx, orgId, userId, MEMORIES_GIVEN);

/**
 * Asking to let a memory go: "forget that", "stop remembering …", "you can drop that from your memory". "Don't forget"
 * asks the opposite, so it doesn't count.
 */
const FORGETS =
  /\b(?<!(?:don'?t|do not|never|not|I|we) )(?:forget|unremember)\b|\b(?:stop|quit) remembering\b|\bno longer remember\b|\b(?:remove|delete|drop|clear|erase|take)\b[^.?!]{0,30}\b(?:from|out of) (?:your |the |my )?memory\b/i;

/** Whether `question` asks the analyst to forget something it was asked to remember. */
export const askedToForget = (question: string): boolean => FORGETS.test(question);

/**
 * Lets go of the owner's memory that `text` names (the analyst's "forget that"): the one that says it, or the one
 * memory that has every word of it. Several that fit are returned for the analyst to choose between, nothing is
 * forgotten then. Undo is `restoreMemory`.
 */
export async function forgetByText(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  text: string,
): Promise<{ forgotten: Memory | null; candidates: string[] }> {
  const wanted = clean(text ?? "").toLowerCase();
  const kept = await listMemories(tx, ctx.orgId, ctx.userId);
  const asked = words(wanted);
  const exact = kept.filter((m) => m.fact.toLowerCase() === wanted);
  const fits = exact.length
    ? exact
    : asked.length
      ? kept.filter((m) => {
          const has = new Set(words(m.fact));
          return asked.every((w) => has.has(w));
        })
      : [];
  const [one] = fits;
  if (fits.length !== 1 || !one) return { forgotten: null, candidates: fits.map((m) => m.fact) };
  return { forgotten: (await forgetMemory(tx, ctx.orgId, ctx.userId, one.id)) ? one : null, candidates: [] };
}

/**
 * Keeps a forgotten memory again (Undo of "forget that"), first among the ones kept. Only its owner can. True when it's
 * remembered now, also when they had since kept the same words again (that one stays).
 */
export async function restoreMemory(tx: TenantTx, orgId: string, userId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const mine = sql`org_id = ${orgId} and kind = 'memory' and scope = 'personal' and scope_id = ${userId}`;
  const [gone] = await tx.execute<{ title: string }>(sql`
    select title from app.context_item where ${mine} and id = ${id} and deleted_at is not null`);
  if (!gone) return false;
  const [same] = await tx.execute(sql`
    select 1 from app.context_item where ${mine} and deleted_at is null and lower(title) = lower(${gone.title})`);
  if (same) return true;
  await tx.execute(sql`update app.context_item set deleted_at = null where ${mine} and id = ${id}`);
  await tx.execute(sql`
    update app.context_item set deleted_at = now()
    where org_id = ${orgId} and id in (
      select id from app.context_item where ${mine} and deleted_at is null
      order by (id = ${id}) desc, created_at desc offset ${MEMORIES_KEPT})`);
  return true;
}

/** Forgets one memory (undo, or Delete in Knowledge → Memory). Only its owner can. */
export async function forgetMemory(tx: TenantTx, orgId: string, userId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await tx.execute(sql`
    update app.context_item set deleted_at = now()
    where org_id = ${orgId} and id = ${id} and kind = 'memory' and scope = 'personal' and scope_id = ${userId}
      and deleted_at is null
    returning id`);
  return rows.length > 0;
}

/** The text of those of `ids` that are this person's own (Sources shows them to their owner only). */
export async function memoryTexts(tx: TenantTx, orgId: string, userId: string, ids: string[]) {
  const valid = ids.filter(isUuid);
  if (!valid.length) return [];
  return tx.execute<{ id: string; fact: string }>(sql`
    select id, title as fact from app.context_item
    where org_id = ${orgId} and kind = 'memory' and scope = 'personal' and scope_id = ${userId}
      and id in (${sql.join(
        valid.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
}

/** How many of the person's latest messages and corrections in a conversation a memory may come from. */
const EARLIER_KEPT = 10;

/** What the person wrote lately in a conversation: their own messages, and their corrections to its answers. */
export async function ownWordsInThread(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  threadId: string,
): Promise<string[]> {
  if (!isUuid(threadId)) return [];
  const rows = await tx.execute<{ text: string | null }>(sql`
    select text from (
      select m.text, m.created_at as at from app.message m
      -- A follow-up still queued can be taken back: not their words yet.
      where m.org_id = ${ctx.orgId} and m.thread_id = ${threadId} and m.role = 'user' and m.author_id = ${ctx.userId}
        and m.status = 'complete'
      union all
      select coalesce(f.correction->>'text', f.comment), f.updated_at from app.feedback f
      join app.run r on r.org_id = f.org_id and r.id = f.run_id
      where f.org_id = ${ctx.orgId} and r.thread_id = ${threadId} and f.user_id = ${ctx.userId} and f.kind <> 'up'
    ) said
    order by at desc limit ${EARLIER_KEPT}`);
  return rows.flatMap((r) => (r.text ? [r.text] : []));
}
