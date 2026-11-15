/**
 * The Modeler's tools (Make this a metric; Draft definitions): its drafts, proposed for review once
 * they're valid and pass their tests (`propose_definitions`, whose problems come back for repair as the answer gate's
 * do); and its endings: done with a source's tables (`finish_drafting`, with what it left out), or why it can't draft
 * a metric from a query (`cannot_draft`). A drafter, its helper on a group of a batch, proposes into the
 * lead's proposal the same way and ends with `brief`.
 */
import { draftDefinitions } from "@opendash/core";
import { z } from "zod";
import { defineTool } from "./types";

const draft = (what: string) =>
  z.object({
    yaml: z.string().describe(what),
    why: z
      .string()
      .optional()
      .describe(
        "Why it's drafted so, for the reviewer: its grain and key as you checked them, a segment and why, a unit. Words, no figures.",
      ),
  });

export const proposeDefinitions = defineTool({
  name: "propose_definitions",
  effect: "internal",
  time: "slow",
  description:
    "Proposes drafts for an admin's review: datasets (YAML), and metrics on them or on this source's datasets. Each is checked against the spec and the source's other definitions, then tested on the data (it runs; its columns are as declared; its grain is unique; a metric has values). A draft named like one you proposed before replaces it, as its repair. Propose a dataset before (or with, ahead of) those that relate to it. Returns what's kept and the problems to fix; from a query, a result with final: true ends the run.",
  schema: z.object({
    datasets: z
      .array(
        draft(
          "A dataset's YAML: ref, label, description, grain, usage_guidance, primary_key, time_column, sql, columns, measures, segments, relationships, and snapshot when its rows are states",
        ),
      )
      .optional()
      .describe("New datasets, only for tables no dataset of this source covers"),
    metrics: z
      .array(draft("A metric's YAML: name, label, description, dataset, measure, and how it's read"))
      .optional()
      .describe("Metrics, each one measure of one dataset"),
    rationale: z
      .string()
      .optional()
      .describe(
        "From a query: why these definitions, for the reviewer (what the query counts, what you kept or changed and why). Words, no figures.",
      ),
  }),
  async execute(input, ctx, call) {
    // Its tests run on the data and stop when the call does (out of time, or the run stopped). A drafter's drafts go
    // to the proposal of the Modeler that leads it.
    const r = await draftDefinitions(
      ctx.gateway,
      {
        orgId: ctx.run.orgId,
        runId: ctx.run.parentRunId ?? ctx.run.id,
        connectionId: ctx.run.connectionId,
        // A drafter writes as itself, and repairs only what it wrote.
        ...(ctx.run.parentRunId ? { authorRunId: ctx.run.id } : {}),
      },
      input,
      { signal: call.signal },
    );
    const note = {
      passed: "",
      needs_review: " (a test warned)",
      failed: " (its tests failed)",
      untested: " (not tested yet)",
    };
    const kept = r.kept.map((i) => `${i.kind} ${i.slug}${note[i.checks as keyof typeof note] ?? ""}`);
    const yours = r.mine.map((i) => `${i.kind} ${i.slug}`);
    return {
      value: { accepted: r.accepted, final: r.final, kept, yours, problems: r.problems },
      summary: { accepted: r.accepted, final: r.final, items: r.kept, mine: r.mine, problems: r.problems },
    };
  },
});

export const finishDrafting = defineTool({
  name: "finish_drafting",
  effect: "internal",
  description:
    "Ends a run over a source's tables, once the drafts you could make pass their tests: what's kept goes to an admin for review. Name what you left out (a table, a metric) and why.",
  schema: z.object({
    left_out: z
      .array(
        z.object({
          name: z.string().describe("The table or the definition left out"),
          reason: z.string().describe("Why, in a sentence for the reviewer"),
        }),
      )
      .describe("What you didn't propose, and why (empty when you proposed every table)"),
  }),
  async execute(input) {
    return { value: { ended: true }, summary: { leftOut: input.left_out } };
  },
});

export const cannotDraft = defineTool({
  name: "cannot_draft",
  effect: "internal",
  description:
    "Ends the run without a draft, saying why, for whoever asked: the query isn't one metric (a list of rows, a mix of unrelated figures), or the source can't support one. Use it only when no draft can pass.",
  schema: z.object({
    reason: z.string().describe("Why, in one or two sentences for a person: what would make it draftable"),
  }),
  async execute(input) {
    return { value: { ended: true }, summary: { reason: input.reason } };
  },
});

/** A drafter's ending: what the lead needs from its group. What it kept is read from its own proposals. */
export const brief = defineTool({
  name: "brief",
  effect: "internal",
  description:
    "Ends your part of the batch, once the drafts you could make for your tables pass their tests; the lead reads it. Name what you left out (a table, a metric, a relationship to a table another helper drafts) and why. What you kept is read from your propose_definitions calls.",
  schema: z.object({
    left_out: z
      .array(
        z.object({
          name: z.string().describe("The table or the definition left out"),
          reason: z.string().describe("Why, in a sentence for the reviewer"),
        }),
      )
      .describe("What you didn't propose, and why (empty when you proposed every table)"),
    notes: z
      .string()
      .optional()
      .describe(
        "What the lead should know, in a sentence or two (a relationship to add once another table is drafted). Words, no figures.",
      ),
  }),
  async execute(input) {
    return { value: { ended: true }, summary: { leftOut: input.left_out, notes: input.notes ?? "" } };
  },
});
