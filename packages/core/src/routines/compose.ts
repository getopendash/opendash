/**
 * Describe it: a routine said in plain words, proposed by the composer agent and checked
 * here. The model names things as the person sees them (a metric's title, a source's, a person, a
 * #channel), never by id; this turns the names it can into the composer's draft and says which it can't, so the model
 * fixes them. What it can't tell from the words it asks back, at most three questions, each option already resolved,
 * so answering is filling the draft, with no second model call. Nothing is saved: the person checks the draft and
 * saves it, and the store checks it all again.
 */
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { type DeploymentKeys, defaultChoice } from "../ai/settings";
import { enqueue } from "../jobs/boss";
import { agentInteractiveQueue } from "../jobs/queues";
import { nextMessageSeq, type RunOutcome } from "../runs/ledger";
import { dataFence } from "../semantic/fence";
import { checkSpend } from "../usage/limits";
import { emptyDraft, parseLine, type RoutineDraft } from "./draft";
import { WEEKDAYS } from "./spec";
import { RoutineProblem } from "./store";
import type { ComposerChoices } from "./views";

/** How long a description may be. */
export const COMPOSER_MAX_CHARS = 500;
const PARTS = ["when", "what", "where"] as const;
export type ComposerPart = (typeof PARTS)[number];

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM, from 00:00 to 23:59.");

/** What a choice or the proposal sets, by name: the same words the person and the prompt use. */
const Picks = z.object({
  trigger: z.enum(["schedule", "found"]).optional(),
  repeats: z.enum(["day", "weekday", "week", "month"]).optional(),
  days: z.array(z.enum(WEEKDAYS)).max(7).optional(),
  on: z.enum(["first", "last"]).optional().describe("A monthly routine: the first or last day of the month."),
  at: Time.optional().describe("HH:MM, where the workspace is."),
  action: z.enum(["ask", "digest"]).optional(),
  question: z.string().max(500).optional().describe("A question asked each time, in the person's words."),
  source: z.string().max(200).optional().describe("The source a question asks, as listed."),
  metrics: z.array(z.string().max(200)).max(10).optional().describe("Verified metrics' titles, exactly as listed."),
  condition: z.enum(["unusual", "crosses", "goal_risk", "missing"]).optional(),
  sensitivity: z.enum(["lower", "medium", "higher"]).optional(),
  direction: z.enum(["below", "above"]).optional(),
  line: z.string().max(40).optional().describe('The line as the person said it: "400k", "38%", "1,200".'),
  tell: z.enum(["at_once", "roundup"]).optional(),
  investigate: z.boolean().optional(),
  people: z
    .array(z.string().max(120))
    .max(20)
    .optional()
    .describe('People by name, exactly as listed; "me" for the person describing it.'),
  channels: z.array(z.string().max(80)).max(10).optional().describe('Slack channels as listed: "#growth".'),
});
export type ComposerPicks = z.infer<typeof Picks>;

export const ProposeRoutine = Picks.extend({
  understood: z
    .string()
    .max(300)
    .describe("One sentence on what you understood, in plain words, and what you assumed (a time they didn't say)."),
  questions: z
    .array(
      z.object({
        part: z.enum(PARTS).describe("Which part of the routine it settles: when, what, or where."),
        ask: z.string().max(120).describe("The question, short: Which revenue?"),
        options: z
          .array(z.object({ label: z.string().max(60), set: Picks }))
          .min(2)
          .max(4)
          .describe("Two to four answers, each what it sets, by name."),
      }),
    )
    .max(3)
    .default([])
    .describe("Only what you can't tell from their words; none when it's all clear."),
});
export type ProposeRoutineInput = z.infer<typeof ProposeRoutine>;

/** A change a proposal or an answered question makes to the draft; people and channels by name (the web has them). */
export type ComposerPatch = Partial<Omit<RoutineDraft, "userIds" | "slack">> & {
  people?: string[];
  channels?: string[];
};

export interface ComposerQuestion {
  part: ComposerPart;
  ask: string;
  options: { label: string; patch: ComposerPatch }[];
}

/** What Describe it proposes: the draft so far, who it names, what it asks, and which parts are still open. */
export interface ComposerOutcome {
  kind: "composer";
  understood: string;
  draft: RoutineDraft;
  /** People and channels by name, matched to members and channels by the web, which lists them. */
  people: string[];
  channels: string[];
  questions: ComposerQuestion[];
  open: ComposerPart[];
}

/** What the agent may name: the composer's choices, and the people and channels the asker may send to. */
export interface ComposerNames {
  choices: Pick<ComposerChoices, "metrics" | "sources">;
  /** The people the asker may name (all members for owners and admins; only themselves otherwise). */
  people: string[];
  channels: string[];
  canManage: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Resolves what a proposal or a choice sets; a name it can't place is a problem the model is told to fix. */
function patchOf(picks: ComposerPicks, names: ComposerNames, problems: string[]): ComposerPatch {
  const p: ComposerPatch = {};
  const copy = [
    "trigger",
    "repeats",
    "on",
    "at",
    "action",
    "condition",
    "sensitivity",
    "direction",
    "tell",
    "investigate",
  ] as const;
  for (const k of copy) if (picks[k] !== undefined) (p as Record<string, unknown>)[k] = picks[k];
  if (picks.days?.length) p.days = [...new Set(picks.days)];
  if (picks.question !== undefined) p.question = picks.question.trim();
  if (picks.source !== undefined) {
    const c = names.choices.sources.find((x) => norm(x.name) === norm(picks.source as string));
    if (c) p.connectionId = c.id;
    else problems.push(`No source is called "${picks.source}". Use one of the listed names.`);
  }
  if (picks.metrics) {
    const ids: string[] = [];
    for (const m of picks.metrics) {
      const hit = names.choices.metrics.find((x) => norm(x.title) === norm(m));
      if (hit) ids.push(hit.id);
      else problems.push(`No verified metric is called "${m}". Use one of the listed titles, or ask which.`);
    }
    p.metricIds = [...new Set(ids)];
  }
  if (picks.line !== undefined) p.line = picks.line.trim();
  if (picks.people) {
    const listed = new Set(names.people.map(norm));
    const people = [...new Set(picks.people.map((x) => x.trim()))];
    for (const who of people) {
      if (norm(who) === "me") continue;
      if (!names.canManage) {
        problems.push("Only owners and admins send routines to others: this person can only send one to themselves.");
        break;
      }
      if (!listed.has(norm(who))) problems.push(`Nobody here is called "${who}". Use the listed names, or ask who.`);
    }
    p.people = people;
  }
  if (picks.channels) {
    const listed = new Set(names.channels.map((c) => norm(c.replace(/^#/, ""))));
    const channels = [...new Set(picks.channels.map((c) => c.trim().replace(/^#/, "")))];
    if (channels.length && !names.canManage) {
      problems.push("Only owners and admins post routines to Slack channels.");
    }
    for (const c of channels) {
      if (names.canManage && !listed.has(norm(c)))
        problems.push(`OpenDash isn't in a channel called #${c}. Use a listed one.`);
    }
    p.channels = channels;
  }
  return p;
}

/** Applies a patch to a draft (people and channels aside: the web matches those). */
export function applyPatch(d: RoutineDraft, patch: ComposerPatch): RoutineDraft {
  const { people: _people, channels: _channels, ...rest } = patch;
  return { ...d, ...rest };
}

/**
 * A proposal, checked: the draft it makes, its questions with their choices resolved, and the problems to fix (names
 * it couldn't place, a line that isn't a number). With problems, the model gets them back; the last round is kept as
 * it is, with what it couldn't place left open.
 */
export function resolveProposal(
  input: ProposeRoutineInput,
  names: ComposerNames,
  asker: string,
): { outcome: ComposerOutcome; problems: string[] } {
  const problems: string[] = [];
  const patch = patchOf(input, names, problems);
  // A trigger left out but plain from the rest (a time and an action, or metrics and what counts) is that one.
  if (!patch.trigger) {
    const scheduled = ["repeats", "days", "on", "at", "action", "question", "source"].some(
      (k) => input[k as keyof ComposerPicks] !== undefined,
    );
    const found = ["metrics", "condition", "sensitivity", "direction", "line", "tell", "investigate"].some(
      (k) => input[k as keyof ComposerPicks] !== undefined,
    );
    if (scheduled !== found) patch.trigger = scheduled ? "schedule" : "found";
  }
  // Nobody is sent it until the web matches the people named; a choice of a schedule's days follows its repeats.
  let draft = applyPatch({ ...emptyDraft(asker), userIds: [] }, patch);
  if (draft.trigger === "found" && draft.condition === "crosses") {
    draft = { ...draft, metricIds: draft.metricIds.slice(0, 1) };
    const metric = names.choices.metrics.find((m) => m.id === draft.metricIds[0]);
    if (draft.line && metric && parseLine(draft.line, metric.format) === null) {
      problems.push(`"${draft.line}" isn't a number ${metric.title} can cross: write it like 400k or 38%.`);
    }
  }
  if (draft.action === "ask" && !draft.connectionId && names.choices.sources.length === 1) {
    draft = { ...draft, connectionId: names.choices.sources[0]?.id ?? null };
  }
  const questions: ComposerQuestion[] = input.questions.map((q) => ({
    part: q.part,
    ask: q.ask.trim(),
    options: q.options.map((o) => ({ label: o.label.trim(), patch: patchOf(o.set, names, problems) })),
  }));
  const open = new Set<ComposerPart>(questions.map((q) => q.part));
  if (!draft.trigger) open.add("when");
  if (draft.trigger === "found" && !draft.metricIds.length) open.add("when");
  if (draft.trigger === "found" && draft.condition === "crosses" && !draft.line) open.add("when");
  if (draft.trigger === "schedule" && draft.action === "ask" && !draft.question) open.add("what");
  if (!patch.people?.length && !patch.channels?.length) open.add("where");
  return {
    outcome: {
      kind: "composer",
      understood: input.understood.trim(),
      draft,
      people: patch.people ?? [],
      channels: patch.channels ?? [],
      questions,
      open: PARTS.filter((x) => open.has(x)),
    },
    problems: [...new Set(problems)],
  };
}

const PEOPLE = "People you may name: ";
const CHANNELS = "Slack channels OpenDash is in: ";

/**
 * What the composer agent is told about the request, written into its run's message: the words (on one line), and
 * the people and channels this person may name (owners and admins: everyone, and the channels OpenDash is in; anyone
 * else: themselves). The lists are JSON, so the tool reads back exactly what the model was given.
 */
export function composerBrief(input: {
  text: string;
  people: string[];
  channels: string[];
  canManage: boolean;
}): string {
  const text = input.text.trim().replace(/\s+/g, " ");
  const lines = [`Describe this routine: “${text}”`];
  if (input.canManage) {
    // Names people and Slack chose for themselves: fenced as data, so a name can't pose as an instruction.
    lines.push(
      dataFence(
        "the workspace's people and channels",
        [
          `${PEOPLE}${JSON.stringify(input.people)}`,
          `${CHANNELS}${JSON.stringify(input.channels.map((c) => `#${c.replace(/^#/, "")}`))}`,
        ].join("\n"),
      ),
    );
  } else {
    lines.push("This person isn't an owner or admin: the routine can only go to them (people: me), and to no channel.");
  }
  return lines.join("\n\n");
}

/** The people and channels a brief gave the model, read back from its own lines (never from the person's words). */
export function composerBriefLists(brief: string): { people: string[]; channels: string[] } {
  const list = (prefix: string) => {
    const line = brief.split("\n").find((l) => l.startsWith(prefix));
    try {
      const v = line ? (JSON.parse(line.slice(prefix.length)) as unknown) : [];
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return { people: list(PEOPLE), channels: list(CHANNELS).map((c) => c.replace(/^#/, "")) };
}

/**
 * Starts Describe it: a run of the composer agent on the interactive queue, in a thread that's nobody's conversation
 * (channel `routine`, kept out of Ask). Its spend is the questions' (refused at a limit, like a question). A run sits
 * on a source because every run does; it's the workspace's first live one, which the composer doesn't read.
 */
export async function startComposer(
  tx: TenantTx,
  deps: { boss: PgBoss; deploymentKeys: DeploymentKeys },
  input: { orgId: string; userId: string; text: string; people: string[]; channels: string[]; canManage: boolean },
): Promise<{ runId: string }> {
  const text = input.text.trim().replace(/\s+/g, " ");
  if (text.length < 3) throw new RoutineProblem("invalid", "Say what should happen, and when.");
  if (text.length > COMPOSER_MAX_CHARS) {
    throw new RoutineProblem("invalid", `Keep it under ${COMPOSER_MAX_CHARS} characters; pick the rest below.`);
  }
  // It asks a model, at the questions' cost: not a viewer's to start (read live, whatever the page said).
  const [role] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${input.userId}) as role`);
  if (role?.role === "viewer")
    throw new RoutineProblem("forbidden", "Viewers pick each part below; Describe it is for members.");
  const [c] = await tx.execute<{ id: string }>(sql`
    select id from app.connection where org_id = ${input.orgId} and deleted_at is null
      and status not in ('disabled', 'error') order by created_at limit 1`);
  if (!c) throw new RoutineProblem("invalid", "Connect a source first: routines read its verified metrics.");
  await checkSpend(tx, input.orgId);
  const choice = await defaultChoice(tx, input.orgId, deps.deploymentKeys);
  const threadId = uuidv7();
  const messageId = uuidv7();
  const runId = uuidv7();
  await tx.execute(sql`
    insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${input.orgId}, ${threadId}, ${c.id}, ${input.userId}, ${`Describe it: ${text}`.slice(0, 80)}, 'routine',
      'private')`);
  const brief = composerBrief({ ...input, text });
  await tx.execute(sql`
    insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
    values (${input.orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, input.orgId, threadId)}, 'user',
      ${input.userId},
      ${JSON.stringify({ role: "user", content: brief })}::jsonb, ${brief})`);
  await tx.execute(sql`
    insert into app.run (org_id, id, thread_id, connection_id, trigger, profile, input_message_id, model, provider,
      reasoning)
    values (${input.orgId}, ${runId}, ${threadId}, ${c.id}, 'user', 'composer', ${messageId}, ${choice.model},
      ${choice.provider}, ${choice.reasoning})`);
  await enqueue(deps.boss, tx, agentInteractiveQueue, { orgId: input.orgId, runId }, { singletonKey: runId });
  return { runId };
}

export type ComposerResult =
  | { status: "working" }
  | { status: "done"; outcome: ComposerOutcome }
  | { status: "failed"; message: string };

/** Where a Describe it run is, for the person who started it only. */
export async function composerResult(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  runId: string,
): Promise<ComposerResult | null> {
  const [r] = await tx.execute<{ status: string; outcome: RunOutcome | null; error: string | null }>(sql`
    select r.status, r.outcome, r.error from app.run r
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where r.org_id = ${viewer.orgId} and r.id = ${runId} and r.profile = 'composer'
      and t.created_by = ${viewer.userId}`);
  if (!r) return null;
  if (r.status === "queued" || r.status === "running" || r.status === "cancelling") return { status: "working" };
  if (r.status === "succeeded" && r.outcome?.kind === "composer") return { status: "done", outcome: r.outcome };
  return {
    status: "failed",
    message: r.error ?? "It couldn't work that out. Try saying it another way, or pick below.",
  };
}
