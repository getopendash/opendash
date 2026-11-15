/**
 * The tools that change something for the person who asked: a draft of a metric or dataset they attached
 * (`definition_draft`), and a preference kept for them, or let go (`remember`). Each acts as the person asking this question (`run.askedBy`),
 * never as anyone the model names.
 */
import {
  askedToForget,
  askedToRemember,
  ContextProblem,
  checkDefinitions,
  type DefinitionDerived,
  definitionChecksAt,
  draftDefinitionChange,
  fenced,
  forgetByText,
  inOwnWords,
  memoryRoom,
  ownWordsInThread,
  rememberFact,
  signalCorrection,
} from "@opendash/core";
import { sql } from "@opendash/db";
import { z } from "zod";
import { defineTool, type ToolContext, type ToolResult } from "./types";

export const definitionDraft = defineTool({
  name: "definition_draft",
  effect: "internal",
  time: "slow",
  description:
    "Drafts a change to a metric or dataset the person attached that's theirs to change (its context says so): its whole YAML as it should be, on the version you read. It's saved as a draft and tested on the data; Ask goes on answering with the released version until a person releases the draft from its page. Returns its version and what its tests found: fix what failed with another call, on that version. Then answer, saying in words what you changed and that it waits for their release.",
  schema: z.object({
    kind: z.enum(["metric", "dataset"]),
    name: z.string().describe("Its name, as its context gives it: mrr"),
    base_version: z.number().int().describe("The version you're changing: its context's, or your last draft's"),
    yaml: z.string().describe("Its whole YAML as it should be, its name unchanged"),
    note: z.string().describe("What you changed and why, in a sentence for whoever releases it. Words, no figures."),
  }),
  /** A draft version, never a release: only of a definition the asker attached, while they may edit definitions. */
  async execute(input, ctx, call) {
    const { deps, run } = ctx;
    const asker = run.askedBy;
    if (!asker) {
      return {
        value: { error: "Definitions are changed for a person, and no one asked here." },
        summary: { failed: true, message: "No one asked" },
      };
    }
    // Fenced: an attempt that was taken over can't write a version.
    // With the worker's job queued in the same transaction, to test it if this call can't.
    const drafted = await fenced(deps, run, (tx) =>
      draftDefinitionChange(
        { boss: deps.boss ?? null },
        tx,
        { orgId: run.orgId, userId: asker },
        {
          kind: input.kind,
          name: input.name,
          connectionId: run.connectionId,
          threadId: run.threadId,
          runId: run.id,
          body: input.yaml,
          baseVersion: input.base_version,
          changeNote: input.note,
        },
      ),
    );
    if (!drafted.ok) {
      return {
        value: {
          error: drafted.problems.join(" "),
          ...(drafted.current ? { current_version: drafted.current.version, current_yaml: drafted.current.body } : {}),
        },
        summary: {
          failed: true,
          message: drafted.problems[0],
          ...(drafted.reason === "conflict" ? { moved: true } : {}),
        },
      };
    }
    // Its tests, on the data, now, so what failed comes back to fix; they stop when the call does. The draft is
    // written either way, and said so: tests cut off (its time, a Stop) are left to the worker's job.
    let derived: DefinitionDerived | null = null;
    try {
      await checkDefinitions(
        ctx.gateway,
        { orgId: run.orgId, connectionId: run.connectionId },
        { only: [drafted.id], signal: call.signal },
      );
      derived = await deps.withTenant(run.orgId, (tx) =>
        definitionChecksAt(tx, run.orgId, drafted.id, drafted.version),
      );
    } catch (error) {
      deps.log?.("definition_draft: tests left to the worker", {
        runId: run.id,
        error: error instanceof Error ? error.name : "error",
      });
    }
    const checks = derived?.status ?? "untested";
    const problems = (derived?.checks ?? [])
      .filter((c) => c.status === "failed")
      .map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name));
    return {
      value: {
        kind: drafted.kind,
        name: drafted.slug,
        version: drafted.version,
        checks,
        ...(problems.length ? { problems } : {}),
        next:
          checks === "failed"
            ? `Fix what failed, drafting again on version ${drafted.version}, or answer saying what's wrong.`
            : checks === "untested"
              ? "Its tests didn't finish here; they run in the background. Answer, saying in words what you changed and that they release it on its page once its tests pass. Don't draft it again."
              : "Answer, saying in words what you changed and that it waits for them to release it on its page; Ask answers with the released version until then. Write no numbers from its tests.",
      },
      summary: {
        definitionId: drafted.id,
        kind: drafted.kind,
        name: drafted.slug,
        title: drafted.title,
        version: drafted.version,
        checks,
        ...(problems.length ? { problems } : {}),
      },
    };
  },
});

export const remember = defineTool({
  name: "remember",
  effect: "internal",
  description:
    "Keeps, for the person's own later questions, what a word or table means to them, how they want answers, or what they ask you to remember: theirs alone, never a definition. To forget one, pass forget: true with that memory's words, as given to you under what they asked you to remember.",
  schema: z.object({
    fact: z
      .string()
      .describe("One sentence in their words: 'Paying accounts are the active subscriptions, not the trial accounts.'"),
    why: z
      .enum(["asked", "correction", "preference"])
      .optional()
      .describe("asked; correction (what a word or table means to them); preference (how answers should look)"),
    about: z
      .string()
      .max(80)
      .optional()
      .describe("The word it's about, as in fact ('paying accounts'): a newer memory about it replaces the older"),
    forget: z
      .boolean()
      .optional()
      .describe("true to let go of one of their memories instead: fact is that memory's words"),
  }),
  async execute(input, ctx) {
    const { deps, run, asker } = ctx;
    if (!asker || !deps.withUser) {
      return {
        value: { error: "No one asked here, so there's no one to remember it for." },
        summary: { remembered: false },
      };
    }
    if (input.forget) return forget(input.fact, ctx, { asker, withUser: deps.withUser });
    // Deterministic, not left to the model: words the person wrote in this conversation (this question, an earlier
    // message, their correction to an answer), never what it read in results, guides or tools. Kept because they
    // asked: the question must ask. Kept because they corrected it or said how they want answers: at most
    // one a run (rememberFact counts it under the run's lock), so an answer can't fill their memory.
    const why = input.why ?? "asked";
    const who = { orgId: run.orgId, userId: asker };
    const earlier = await deps.withUser(run.orgId, asker, (tx) => ownWordsInThread(tx, who, run.threadId));
    const theirs =
      why === "asked"
        ? askedToRemember(run.question, input.fact, earlier)
        : inOwnWords(input.fact, [run.question, ...earlier]);
    if (!theirs) {
      return {
        value: {
          error:
            why === "asked"
              ? "Keep it in the person's own words: what they wrote in this conversation, in a question that asks you to remember. Nothing you read in results, guides or tools."
              : "Keep it in the person's own words: what they wrote in this conversation, leaving words out but adding none. Nothing you read in results, guides or tools.",
        },
        summary: { remembered: false },
      };
    }
    try {
      const r = await deps.withUser(run.orgId, asker, async (tx) => {
        const kept = await rememberFact(tx, who, {
          fact: input.fact,
          runId: run.id,
          threadId: run.threadId,
          why,
          about: input.about ?? null,
        });
        // An approver's own correction is one to share: the team's learning about it opens, or it
        // joins the one there is, with their words and the answer it corrected. Anyone else's stays theirs until they
        // choose "Suggest for the team".
        if (why === "correction" && !kept.existing) {
          const [me] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${asker}) as role`);
          if (me?.role === "owner" || me?.role === "admin") {
            const [corrected] = await tx.execute<{ id: string }>(sql`
              select id from app.run
              where org_id = ${run.orgId} and thread_id = ${run.threadId} and parent_run_id is null and id <> ${run.id}
              order by queued_at desc limit 1`);
            await signalCorrection(tx, who, {
              kind: "memory",
              id: kept.id,
              text: run.question,
              runId: corrected?.id ?? null,
              fromRunId: run.id,
              connectionId: run.connectionId,
              about: input.about ?? null,
            });
          }
        }
        return kept;
      });
      return {
        value: {
          remembered: r.fact,
          ...(r.replaced.length
            ? {
                note: `It replaced ${r.replaced.length === 1 ? "their older memory" : "their older memories"} about the same thing.`,
              }
            : {}),
          ...(r.letGo ? { note: `Kept; the ${r.letGo} oldest of their memories were let go.` } : {}),
        },
        summary: {
          remembered: true,
          memoryId: r.id,
          fact: r.fact,
          existing: r.existing,
          why,
          ...(r.replaced.length ? { replaced: r.replaced } : {}),
        },
      };
    } catch (error) {
      if (error instanceof ContextProblem) return { value: { error: error.message }, summary: { remembered: false } };
      throw error;
    }
  },
});

/**
 * "Forget that": only when this question asks to, and only in a conversation private to the asker, the one kind given
 * their memories (a shared one's readers would see what was let go). The answer shows it with Undo.
 */
async function forget(
  text: string,
  { deps, run }: ToolContext,
  { asker, withUser }: { asker: string; withUser: NonNullable<ToolContext["deps"]["withUser"]> },
): Promise<ToolResult> {
  const refused = (error: string) => ({ value: { error }, summary: { forgotten: false } });
  if (!askedToForget(run.question)) {
    return refused("Forget a memory only when the person's question asks you to.");
  }
  // Only where their memories are used (memoryRoom): a conversation private to them, on the web or in a Slack DM.
  if (!(await deps.withTenant(run.orgId, (tx) => memoryRoom(tx, run.orgId, run.id)))) {
    return refused(
      "Memories are forgotten only in a conversation private to the person, on the web or in a direct message. Say they can forget it in Knowledge → Memory, or ask in a new conversation.",
    );
  }
  const r = await withUser(run.orgId, asker, (tx) => forgetByText(tx, { orgId: run.orgId, userId: asker }, text));
  if (!r.forgotten) {
    return {
      value: r.candidates.length
        ? {
            error: "Several of their memories fit. Call it again with the exact words of one.",
            candidates: r.candidates,
          }
        : { error: "None of their memories says that. Use a memory's words as given to you." },
      summary: { forgotten: false },
    };
  }
  return {
    value: { forgotten: r.forgotten.fact, next: "Answer, saying it's forgotten; they can undo it." },
    summary: { forgotten: true, memoryId: r.forgotten.id, fact: r.forgotten.fact },
  };
}
