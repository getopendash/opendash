/**
 * An App's AI summary: the words one of its summaries shows, written on request from the answers
 * its queries have under the page's filters, the same cache the page reads. A note is kept by the numbers it was
 * written from (not by the moment), so it stays while they don't change, and a new answer with other numbers asks for
 * a new one. The writing itself (a model call, checked so it only uses the numbers it was given) runs in the worker.
 */
import { createHash } from "node:crypto";
import type { WireResult } from "@opendash/apps/protocol";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { enqueueOnce } from "../jobs/boss";
import { type DashboardSummaryJob, dashboardSummaryQueue } from "../jobs/queues";
import type { Viewer } from "../runs/ledger";
import { checkSpend, SpendLimitReached } from "../usage/limits";
import { type DashboardRequest, requestDashboardQueries } from "./data";
import { ACTIONS_OFF, actionsOff, definitionAt } from "./store";

/** What a summary shows now. */
export type SummaryAnswer =
  | { status: "none"; sources?: SummarySource[] }
  /** Its numbers are still loading: ask again. */
  | { status: "waiting" }
  | { status: "writing" }
  /**
   * `sources`: what it's written from, each opening its rows; `cost`: what the note cost and what the dashboard's
   * summaries spent this month (owners and admins only: the API drops it for others).
   */
  | { status: "ok"; text: string; writtenAt: string; sources: SummarySource[]; cost?: SummaryCost }
  /** Written from older numbers (filters or data changed since): shown as such, with Refresh. */
  | { status: "stale"; text: string; writtenAt: string; sources: SummarySource[] }
  | { status: "failed"; error: string };

export interface SummarySource {
  query: string;
  title: string;
}

export interface SummaryCost {
  /** This note, both attempts. */
  note: number;
  /** The dashboard's summaries this month. */
  month: number;
}

/** How a rewrite reads: the same facts in new words, or another angle. Never free text. */
export const SUMMARY_ANGLES = ["fresh", "lead", "short", "email"] as const;
export type SummaryAngle = (typeof SUMMARY_ANGLES)[number];

/** The answers a summary is written from, by query, under the page's filters. */
export interface Gathered {
  prompt: string | null;
  answers: { query: string; title: string; result: WireResult }[];
  noteKey: string;
}

const NOTE_DAYS = 30;
/** Summaries a person writes in an hour, at most (each is up to two model calls). */
const SUMMARIES_AN_HOUR = 20;

/** The summary's answers, all of them in (else what's still to come), and the note's key. */
export async function gatherSummary(
  deps: { boss: PgBoss },
  tx: TenantTx,
  viewer: Viewer,
  input: { dashboardId: string; revision: string; section: string; filters: Record<string, string | string[]> },
): Promise<Gathered | SummaryAnswer | null> {
  const at = await definitionAt(tx, viewer, input.dashboardId, input.revision);
  if (!at) return null;
  // One of the App's summaries, by its id.
  const own = Object.hasOwn(at.definition.summaries ?? {}, input.section)
    ? at.definition.summaries?.[input.section]
    : undefined;
  if (!own) return { status: "failed", error: "There's no summary here." };
  const { queries, prompt } = own;
  const requests: DashboardRequest[] = queries.map((q) => ({ id: q, query: q, filters: input.filters }));
  const got = await requestDashboardQueries(deps, tx, viewer, {
    dashboardId: input.dashboardId,
    revision: input.revision,
    requests,
  });
  if (!got) return null;
  const failed = got.find((a) => a.status === "failed") as { error: string } | undefined;
  if (failed) return { status: "failed", error: `Its numbers didn't load: ${failed.error}` };
  if (got.some((a) => a.status !== "ok")) return { status: "waiting" };
  const answers = got.map((a) => {
    const result = (a as { result: WireResult }).result;
    // What a person calls it: the query's name in words.
    const title = a.id.replace(/^q_/, "").replace(/_/g, " ");
    return { query: a.id, title, result };
  });
  // Keyed by what it's written from: the summary, its prompt and every value it reads (never the time).
  const noteKey = `note:${createHash("sha256")
    .update(
      JSON.stringify({
        dashboard: input.dashboardId,
        section: input.section,
        prompt: prompt ?? null,
        // Everything the model is given: the revision drawn (a draft's never shows on the published one), each
        // answer's title and its values.
        revision: input.revision,
        numbers: answers.map((a) => [a.query, a.title, a.result.columns.map((c) => [c.name, c.values])]),
      }),
    )
    .digest("hex")
    .slice(0, 40)}`;
  return { prompt: prompt ?? null, answers, noteKey };
}

/**
 * What a summary section shows: the note written from these numbers, or none; with `write`, the writing is asked for
 * (`again`: the one there is dropped first, a new one written).
 */
export async function summaryAnswer(
  deps: { boss: PgBoss },
  tx: TenantTx,
  viewer: Viewer,
  input: {
    dashboardId: string;
    revision: string;
    section: string;
    filters: Record<string, string | string[]>;
    write?: boolean;
    again?: boolean;
    angle?: SummaryAngle;
  },
): Promise<SummaryAnswer | null> {
  if (!isUuid(input.dashboardId)) return null;
  // Writing a note is a model call the viewer pays for, from a prompt in the App's definition: not from a draft
  // someone else saved last (its definition is theirs), until the viewer saves it or its owner publishes it.
  if (input.write) {
    const at = await definitionAt(tx, viewer, input.dashboardId, input.revision);
    if (at && actionsOff(at, viewer)) return { status: "failed", error: ACTIONS_OFF };
  }
  const gathered = await gatherSummary(deps, tx, viewer, input);
  if (!gathered || !("noteKey" in gathered)) return gathered;
  const sources = gathered.answers.map((a) => ({ query: a.query, title: a.title }));
  if (input.write && input.again) {
    await tx.execute(sql`
      delete from app.dashboard_result where org_id = ${viewer.orgId} and cache_key = ${gathered.noteKey}`);
  }
  const [kept] = await tx.execute<{
    status: string;
    result: { text: string; writtenAt: string; cost?: number } | null;
    error: string | null;
  }>(sql`
    select status, result, error from app.dashboard_result
    where org_id = ${viewer.orgId} and cache_key = ${gathered.noteKey} and expires_at > now()`);
  if (kept?.status === "ok" && kept.result) {
    const [month] = await tx.execute<{ usd: string | null }>(sql`
      select sum(cost_usd)::text as usd from app.usage_event
      where org_id = ${viewer.orgId} and source_type = 'dashboard' and source_id = ${input.dashboardId}
        and id >= app.uuidv7_floor(date_trunc('month', now()))`);
    return {
      status: "ok",
      text: kept.result.text,
      writtenAt: kept.result.writtenAt,
      sources,
      ...(typeof kept.result.cost === "number"
        ? { cost: { note: kept.result.cost, month: Number(month?.usd ?? 0) } }
        : {}),
    };
  }
  if (kept?.status === "failed" && !input.write)
    return { status: "failed", error: kept.error ?? "It couldn't be written." };
  if (!input.write) {
    const [queued] = await tx.execute<{ yes: boolean }>(sql`
      select true as yes from pgboss.job where name = ${dashboardSummaryQueue.name}
        and singleton_key = ${gathered.noteKey} and state in ('created', 'retry', 'active') limit 1`);
    if (queued) return { status: "writing" };
    // Its last note, written from other numbers: shown as such (Refresh writes it from these).
    const [last] = viewer.userId
      ? await tx.execute<{ result: { text: string; writtenAt: string } | null }>(sql`
          select result from app.dashboard_result
          where org_id = ${viewer.orgId}
            and cache_key = ${lastKey(input.dashboardId, input.section, input.revision, viewer.userId)}
            and expires_at > now()`)
      : [];
    return last?.result
      ? { status: "stale", text: last.result.text, writtenAt: last.result.writtenAt, sources }
      : { status: "none", sources };
  }
  if (!viewer.userId) return { status: "failed", error: "A summary is written for a person: sign in." };
  // The workspace's spending limits hold here as they do for a question; and a person writes at most a few an hour.
  try {
    await checkSpend(tx, viewer.orgId);
  } catch (error) {
    if (error instanceof SpendLimitReached) return { status: "failed", error: error.message };
    throw error;
  }
  const [recent] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.usage_event
    where org_id = ${viewer.orgId} and user_id = ${viewer.userId} and source_type = 'dashboard'
      and id >= app.uuidv7_floor(now() - interval '1 hour')`);
  if ((recent?.n ?? 0) >= SUMMARIES_AN_HOUR * 2) {
    return { status: "failed", error: `You've written ${SUMMARIES_AN_HOUR} summaries this hour: try again later.` };
  }
  if (kept?.status === "failed") {
    await tx.execute(sql`
      delete from app.dashboard_result where org_id = ${viewer.orgId} and cache_key = ${gathered.noteKey}`);
  }
  const job: DashboardSummaryJob = {
    orgId: viewer.orgId,
    dashboardId: input.dashboardId,
    revision: input.revision,
    section: input.section,
    filters: input.filters,
    noteKey: gathered.noteKey,
    askedBy: viewer.userId,
    ...(input.angle && input.angle !== "fresh" ? { angle: input.angle } : {}),
  };
  await enqueueOnce(deps.boss, tx, dashboardSummaryQueue, job, { singletonKey: gathered.noteKey });
  return { status: "writing" };
}

/** Where a section's last note is kept, whatever numbers it was written from. */
/**
 * Where a section's last note is kept for one person, whatever numbers it was written from: another reader's numbers
 * (their own account's, on a personal service) are never shown to them as "older".
 */
const lastKey = (dashboardId: string, section: string, revision: string, userId: string) =>
  `notelast:${createHash("sha256").update(`${dashboardId}:${section}:${revision}:${userId}`).digest("hex").slice(0, 40)}`;

/** Keeps what was written (or why it couldn't be), under its numbers' key; a note also as its section's last. */
export async function keepSummary(
  tx: TenantTx,
  orgId: string,
  noteKey: string,
  note: { text: string; writtenAt: string; cost?: number } | { error: string },
  section?: { dashboardId: string; section: string; revision: string; userId: string } | null,
  /** Never over a good note still fresh (a dead letter's, after another press wrote one). */
  keepGood = false,
) {
  if ("text" in note && section) {
    await tx.execute(sql`
      insert into app.dashboard_result (org_id, cache_key, status, result, expires_at)
      values (${orgId}, ${lastKey(section.dashboardId, section.section, section.revision, section.userId)}, 'ok',
        ${JSON.stringify({ text: note.text, writtenAt: note.writtenAt })}::jsonb,
        now() + make_interval(days => ${NOTE_DAYS}))
      on conflict (org_id, cache_key) do update set result = excluded.result, created_at = now(),
        expires_at = excluded.expires_at`);
  }
  await tx.execute(sql`
    insert into app.dashboard_result (org_id, cache_key, status, result, error, expires_at)
    values (${orgId}, ${noteKey}, ${"text" in note ? "ok" : "failed"},
      ${"text" in note ? JSON.stringify(note) : null}::jsonb, ${"error" in note ? note.error : null},
      now() + make_interval(days => ${"text" in note ? NOTE_DAYS : 0}, mins => ${"text" in note ? 0 : 10}))
    on conflict (org_id, cache_key) do update set status = excluded.status, result = excluded.result,
      error = excluded.error, created_at = now(), expires_at = excluded.expires_at
    where not ${keepGood} or app.dashboard_result.status = 'failed' or app.dashboard_result.expires_at <= now()`);
}

/**
 * Its dead letter (the worker gave up on it after its retries): a failed note under its key, so the summary says it
 * couldn't be written (with Write to try again) instead of going back to nothing once the job is gone. Never over a
 * note written meanwhile.
 */
export async function summaryFailed(
  deps: { withTenant<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> },
  job: DashboardSummaryJob,
) {
  await deps.withTenant(job.orgId, (tx) =>
    keepSummary(
      tx,
      job.orgId,
      job.noteKey,
      { error: "Its summary couldn't be written: press Write to try again." },
      null,
      true,
    ),
  );
}

/** What a summary may say: every number in its answers (strings' digits too, a label like "Team 27"), and their years. */
export interface Allowed {
  values: number[];
  /** Numbers written inside text values: ids and labels, said as they are. */
  words: Set<string>;
  years: Set<string>;
}

/** The numbers a summary's answers hold: what its words are checked against. */
export function summaryNumbers(answers: Gathered["answers"]): Allowed {
  const values: number[] = [];
  const words = new Set<string>();
  const years = new Set<string>();
  for (const a of answers) {
    values.push(a.result.rowCount);
    for (const c of a.result.columns) {
      for (const v of c.values) {
        if (typeof v === "number" && Number.isFinite(v)) values.push(v);
        else if (typeof v === "string") {
          for (const n of v.match(/\d[\d,.]*/g) ?? []) words.add(n.replace(/,/g, ""));
          const y = /^(\d{4})-\d{2}/.exec(v);
          if (y?.[1]) years.add(y[1]);
        }
      }
    }
  }
  return { values, words, years };
}

const SCALES: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

/**
 * The figures in a text that aren't among its answers' numbers: each read with its unit (42% or 0.42 as a share,
 * 1.2k, 3 million) and matched within the rounding it's written at. Dates and times written out aren't figures;
 * a year is, unless the answers' dates have it.
 */
export function strayNumbers(text: string, allowed: Allowed): string[] {
  const cleaned = text.replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
  const re = /(-?\d[\d,]*(?:\.\d+)?)\s*(%|k\b|m\b|bn\b|thousand\b|million\b|billion\b)?/gi;
  const out = new Set<string>();
  for (const m of cleaned.matchAll(re)) {
    const raw = (m[1] ?? "").replace(/,/g, "");
    const unit = (m[2] ?? "").toLowerCase();
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const decimals = raw.includes(".") ? (raw.split(".")[1]?.length ?? 0) : 0;
    const half = 0.5 * 10 ** -decimals;
    let ok: boolean;
    if (unit === "%") {
      ok = allowed.values.some(
        (v) => Math.abs(v * 100 - n) <= half || Math.abs(Math.abs(v) * 100 - n) <= half || Math.abs(v - n) <= half,
      );
    } else if (unit && SCALES[unit]) {
      const scale = SCALES[unit] as number;
      ok = allowed.values.some((v) => Math.abs(Math.abs(v) - Math.abs(n) * scale) <= half * scale);
    } else {
      ok =
        allowed.values.some((v) => Math.abs(Math.abs(v) - Math.abs(n)) <= half) ||
        allowed.words.has(raw) ||
        (/^\d{4}$/.test(raw) && allowed.years.has(raw));
    }
    if (!ok) out.add(`${raw}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`);
  }
  return [...out];
}
