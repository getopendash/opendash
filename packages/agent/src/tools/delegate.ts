/**
 * draft_tables: the Modeler, leading a batch, hands a group of its tables to a drafter, a child run on the
 * same ledger, and gets back what it kept and left out.
 * - A step's calls run at once (the SDK runs them together); three drafters at most at a time, the rest wait a turn.
 * - One drafter per group: handed out again, it's the same drafter, resumed where it stopped or its result once it
 *   ended; two calls for it at once share one run of it. A drafter left unfinished when the lead's attempt ended is
 *   picked up when the lead resumes, before its next model call (`resume`), never left to the model to ask for again.
 *   It's claimed only while this attempt holds the lead.
 * - Its dollars are the lead's: a fair share of what the lead has left less what drafters under way reserved, split
 *   between the groups that could still start now (the turns free, or the groups still to draft if fewer), its group's
 *   budget at most; with none running, what's left. Reserved isn't spent: a group whose share is too small waits for a
 *   drafter under way to end, and is refused only when the lead's money is gone. What it spends counts against the
 *   lead however its run ends, once; when that can't be read, its whole cap does (it fails closed).
 * - It has the lead's time before the lead must wrap up, beyond what it worked before. The worker's shutdown hands it
 *   off, and a group still waiting then isn't started.
 */
import {
  childRun,
  drafterBrief,
  fenced,
  findChildRun,
  type ModelerOutcome,
  ProposalProblem,
  recordChild,
  runSpent,
  sourceDraftBudget,
} from "@opendash/core";
import { sql } from "@opendash/db";
import { z } from "zod";
import { draftedBy } from "../agents/modeler/drafter";
import { runAttempt } from "../harness/run";
import { defineTool, type ToolContext, type ToolResult } from "./types";

/** Drafters under way at once, per lead. */
const AT_ONCE = 3;

/** Less than this left for a group, it isn't worth starting. */
const FLOOR_USD = 0.05;

/** A lead's drafting in this attempt (per its run state): its turns, its reservations and what each child cost it. */
interface Lead {
  /** Calls holding a turn. */
  running: number;
  /** Calls whose drafter is running now: only they can end and free money. */
  active: number;
  /** Dollars the active drafters may still spend. */
  reserved: number;
  /** Calls waiting for a turn or for money, woken whenever a drafter ends. */
  waiting: (() => void)[];
  /** Per child: what of its spend the lead's budget already counts (runSpent counted it up to the attempt's start). */
  charged: Map<string, number>;
  /** Per child: its run under way, which a second call for it shares. */
  inFlight: Map<string, Promise<ToolResult>>;
}
const leads = new WeakMap<object, Lead>();

const leadOf = (ctx: ToolContext): Lead => {
  const found = leads.get(ctx.state);
  if (found) return found;
  const lead: Lead = { running: 0, active: 0, reserved: 0, waiting: [], charged: new Map(), inFlight: new Map() };
  leads.set(ctx.state, lead);
  return lead;
};

/**
 * Until something changes (a turn freed, money freed), the call stops or the worker starts shutting down: either way it
 * leaves the waiting list.
 */
function changed(lead: Lead, signal: AbortSignal, drain?: AbortSignal) {
  signal.throwIfAborted();
  if (drain?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      drain?.removeEventListener("abort", done);
      const i = lead.waiting.indexOf(done);
      if (i >= 0) lead.waiting.splice(i, 1);
      resolve();
    };
    lead.waiting.push(done);
    signal.addEventListener("abort", done, { once: true });
    // The worker shutting down wakes it too: a group still waiting then isn't started.
    drain?.addEventListener("abort", done, { once: true });
  });
}

function wake(lead: Lead) {
  for (const w of [...lead.waiting]) w();
}

/** A child's state as the ledger has it: its status, its attempts so far, what it spent over them, and its outcome. */
async function childState(ctx: ToolContext, runId: string) {
  const [r] = await ctx.deps.withTenant(ctx.run.orgId, (tx) =>
    tx.execute<{ status: string; attempt: number; cost: number; outcome: unknown }>(sql`
      select status, attempt, coalesce((usage->>'costUsd')::float8, 0) as cost, outcome from app.run
      where org_id = ${ctx.run.orgId} and id = ${runId}`),
  );
  return {
    status: r?.status ?? "failed",
    attempt: Number(r?.attempt ?? 0),
    cost: Number(r?.cost ?? 0),
    outcome: (r?.outcome ?? null) as unknown,
  };
}

/**
 * The groups that could want money now or soon, this call's included, as the ledger has them: the lead's drafters not
 * ended (those running in this attempt among them), and the batch's tables no drafter has yet (each could be a group).
 */
async function groupsWanting(ctx: ToolContext) {
  const { orgId, id } = ctx.run;
  const [r] = await ctx.deps.withTenant(orgId, (tx) =>
    tx.execute<{ open: number; uncovered: number }>(sql`
      select
        (select count(*)::int from app.run c where c.org_id = ${orgId} and c.parent_run_id = ${id}
          and c.status in ('queued', 'running')) as open,
        (select count(*)::int from unnest(p.tables) t where lower(t) not in (
          select lower(x) from app.run c, jsonb_array_elements_text(c.task->'tables') x
          where c.org_id = ${orgId} and c.parent_run_id = ${id})) as uncovered
      from app.proposal p where p.org_id = ${orgId} and p.run_id = ${id}`),
  );
  return (r?.open ?? 1) + (r?.uncovered ?? 0);
}

const ENDED = new Set(["succeeded", "failed", "cancelled"]);

/** A group's tables, each once whatever its case. */
const tablesOf = (input: { tables: string[] }) => {
  const seen = new Set<string>();
  return input.tables.map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
};

/** What the lead hears of a drafter, from the ledger: its status, what it kept and left out. */
async function reportOf(ctx: ToolContext, runId: string, tables: string[], unfinished: boolean): Promise<ToolResult> {
  const after = await childState(ctx, runId);
  const report = await draftedBy(ctx.deps, { ...ctx.run, id: runId, parentRunId: ctx.run.id });
  const ended = after.outcome as ModelerOutcome | { kind: "no_answer"; reason: string } | null;
  const status = unfinished ? "unfinished" : after.status === "succeeded" ? "done" : "stopped";
  const kept = report.kept.map((i) => `${i.kind} ${i.slug}`);
  const notes = unfinished
    ? "The worker stopped while it drafted: it goes on when the batch does."
    : ended?.kind === "no_answer"
      ? ended.reason
      : report.notes;
  return {
    value: { tables, status, kept, left_out: report.leftOut, ...(notes ? { notes } : {}) },
    summary: { runId, tables, status, kept, leftOut: report.leftOut, ...(unfinished ? { unfinished: true } : {}) },
  };
}

/** Runs the drafter for `runId` to its end (or its hand-off) and settles what it spent, however it ends. */
async function drive(ctx: ToolContext, lead: Lead, runId: string, tables: string[], signal: AbortSignal) {
  if (!lead.charged.has(runId)) lead.charged.set(runId, (await childState(ctx, runId)).cost);
  const before = await childState(ctx, runId);
  if (ENDED.has(before.status)) return await reportOf(ctx, runId, tables, false);
  // The worker shutting down: a drafter not started yet isn't, and the lead's next attempt picks it up.
  const draining = () => ctx.attempt.drain?.aborted === true;
  if (draining()) return await reportOf(ctx, runId, tables, true);
  let turn = false;
  let reserved = 0;
  // Its start was said: only then is its end, once, however the call ends.
  let started = false;
  try {
    while (lead.running >= AT_ONCE) {
      await changed(lead, signal, ctx.attempt.drain);
      if (draining()) return await reportOf(ctx, runId, tables, true);
    }
    lead.running += 1;
    turn = true;
    // Money: a fair share of what the lead hasn't spent, less what drafters under way may still spend, between the
    // groups that could start now. Short only because of what's reserved, it waits for one of them to end; short of
    // what's left, it's refused.
    for (;;) {
      const wanting = await groupsWanting(ctx);
      // Read after the ledger, together: the drafters running now hold their reservations, the rest share what's left.
      const among = Math.max(1, Math.min(AT_ONCE, wanting) - lead.active);
      const left = ctx.attempt.maxCostUsd - ctx.state.costUsd;
      const budget = sourceDraftBudget(tables.length).maxCostUsd;
      let want = Math.min(budget, (left - lead.reserved) / among);
      // Nothing running, no share is kept back for groups that may come: one group can still use what's left.
      if (want < FLOOR_USD && lead.active === 0) want = Math.min(budget, left);
      if (want >= FLOOR_USD) {
        reserved = want;
        break;
      }
      if (left < FLOOR_USD || lead.active === 0) {
        return {
          value: {
            error: "The batch's budget can't cover another group: end with finish_drafting, naming what's left.",
          },
        };
      }
      await changed(lead, signal, ctx.attempt.drain);
      if (draining()) return await reportOf(ctx, runId, tables, true);
    }
    lead.reserved += reserved;
    lead.active += 1;
    // Its limits are over all its attempts: what it worked before, and the lead's time left now.
    const { workedMs } = await runSpent(ctx.deps, { orgId: ctx.run.orgId, id: runId, attempt: before.attempt + 1 });
    if (draining()) return await reportOf(ctx, runId, tables, true);
    const share = Math.max(60_000, ctx.attempt.timeLeftMs());
    await follow(ctx, "child_started", { runId, tables });
    started = true;
    const r = await runAttempt(
      ctx.deps,
      { orgId: ctx.run.orgId, runId },
      {
        workerId: ctx.attempt.workerId,
        // Claimed only while this attempt still holds the lead: a lead that lost its fence can't take its drafter.
        parent: { id: ctx.run.id, attempt: ctx.run.attempt },
        signal,
        ...(ctx.attempt.drain ? { drain: ctx.attempt.drain } : {}),
        limits: {
          maxCostUsd: before.cost + reserved,
          wallMs: workedMs + share,
          wrapUpAtMs: workedMs + Math.round(share * 0.8),
        },
      },
    );
    // Awaited here, not returned: the finally below awaits too, and a promise returned past it would reject with no
    // one listening yet (the worker exits on an unhandled rejection).
    // Not claimed (another attempt holds it) or handed off: unfinished, for the attempt that goes on.
    return await reportOf(ctx, runId, tables, r === null || r.status === "handed_off");
  } finally {
    // What it spent is the lead's, once, however its run ended (an answer, an error, a hand-off, a stop).
    const after = await childState(ctx, runId).catch(() => null);
    const read = after !== null;
    if (after) {
      const counted = lead.charged.get(runId) ?? after.cost;
      ctx.state.costUsd += Math.max(0, after.cost - counted);
      lead.charged.set(runId, Math.max(counted, after.cost));
    }
    // Its spend couldn't be read: the lead counts the most it could have spent, its cap, so nothing more is granted
    // against money it may have used (it fails closed). A later read refunds nothing; the lead's next attempt reads
    // the exact figure from the ledger.
    if (!read && reserved) {
      const counted = lead.charged.get(runId) ?? before.cost;
      const cap = before.cost + reserved;
      ctx.state.costUsd += Math.max(0, cap - counted);
      lead.charged.set(runId, Math.max(counted, cap));
    }
    if (reserved) {
      lead.reserved -= reserved;
      lead.active -= 1;
    }
    if (turn) lead.running -= 1;
    wake(lead);
    // Only a drafter this call started ends here: one it never started had no start to follow. One handed off (a
    // shutdown) ends too, for this attempt: the next one says its start again when it picks it up.
    if (started) {
      await follow(ctx, "child_ended", {
        runId,
        tables,
        ...(after ? { status: after.status, costUsd: after.cost } : {}),
      });
    }
  }
}

/**
 * The lead's word that a drafter started or ended, for the drafting card to follow. Never fails the call:
 * the trace reads the drafter's own rows, so a lost one (the lead's fence gone, the database busy) costs only a refresh.
 */
async function follow(
  ctx: ToolContext,
  type: "child_started" | "child_ended",
  data: { runId: string; tables: string[]; status?: string; costUsd?: number },
) {
  await recordChild(ctx.deps, ctx.run, type, data).catch(() => {});
}

export const draftTables = defineTool({
  name: "draft_tables",
  effect: "internal",
  time: "child",
  description:
    "Hands a group of the batch's tables (one to three: a table and the lookups only it joins) to a helper, which reads them, checks them on the data, proposes their datasets and metrics, and returns what it kept and left out. Calls in one step run at the same time, three at most; a group handed out before returns that helper's result.",
  schema: z.object({
    tables: z.array(z.string()).min(1).max(3).describe("The group's tables, as the message names them (schema.table)"),
    note: z
      .string()
      .optional()
      .describe(
        "What the helper should know: a dataset already drafted it can relate to, a join to check. Words only.",
      ),
  }),
  resume: {
    // Owed when the call's outcome never reached the model (it was interrupted, or its drafter handed off) and its
    // drafter was started: one exists only once the call got past every refusal. An ended one is only reported.
    async owed(input, ctx, recorded) {
      const handedOff = (recorded.result as { status?: string } | undefined)?.status === "unfinished";
      if (!recorded.interrupted && !handedOff) return false;
      const id = await ctx.deps.withTenant(ctx.run.orgId, (tx) =>
        findChildRun(tx, ctx.run, { tables: tablesOf(input) }),
      );
      return id !== null;
    },
    // A group's drafter, whatever the order or case of its tables, or the note it came with.
    key: (input) => JSON.stringify([...new Set(tablesOf(input).map((t) => t.toLowerCase()))].sort()),
  },
  async execute(input, ctx, call) {
    const { orgId } = ctx.run;
    const tables = tablesOf(input);
    const [p] = await ctx.deps.withTenant(orgId, (tx) =>
      tx.execute<{ tables: string[] }>(sql`
        select tables from app.proposal where org_id = ${orgId} and run_id = ${ctx.run.id}`),
    );
    const batch = new Set((p?.tables ?? []).map((t) => t.toLowerCase()));
    const stray = tables.filter((t) => !batch.has(t.toLowerCase()));
    if (stray.length) {
      return {
        value: {
          error: `${stray.join(", ")} ${stray.length === 1 ? "isn't" : "aren't"} in this batch: hand out only its tables, as the message names them.`,
        },
      };
    }
    const lead = leadOf(ctx);
    // No drafter is started for a group the lead's money can't cover.
    const started = await ctx.deps.withTenant(orgId, (tx) => findChildRun(tx, ctx.run, { tables }));
    if (!started && ctx.attempt.maxCostUsd - ctx.state.costUsd < FLOOR_USD) {
      return {
        value: { error: "The batch's budget can't cover another group: end with finish_drafting, naming what's left." },
      };
    }
    // The brief is read before the lead's row is locked, so a step's handouts don't wait on each other's reads.
    let brief = "";
    if (!started) {
      try {
        brief = await ctx.deps.withTenant(orgId, (tx) =>
          drafterBrief(tx, orgId, { id: ctx.run.connectionId, name: ctx.source.name }, tables, input.note),
        );
      } catch (error) {
        if (error instanceof ProposalProblem) return { value: { error: error.message } };
        throw error;
      }
    }
    const child = await fenced(ctx.deps, ctx.run, (tx) =>
      childRun(tx, ctx.run, {
        profile: "drafter",
        task: { tables },
        title: `Drafting ${tables.join(", ")}`,
        brief: async () => brief,
      }),
    );
    // Two calls for one drafter at once share its run: it runs once, and is charged once.
    const under = lead.inFlight.get(child.runId);
    if (under) return under;
    const run = drive(ctx, lead, child.runId, tables, call.signal);
    lead.inFlight.set(child.runId, run);
    try {
      return await run;
    } finally {
      lead.inFlight.delete(child.runId);
    }
  },
});
