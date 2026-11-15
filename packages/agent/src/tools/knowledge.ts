/**
 * The tools that look things up in what OpenDash knows about the source, besides its folder (files.ts): where a value
 * lives (`value_lookup`), and the glossary, guides and verified queries the team approved by words or meaning
 * (`context_search`). Text the team wrote reaches the model fenced as data.
 */
import { BUDGETS, LIVE_VALUES, lookupLiveValues, searchContext } from "@opendash/core";
import { z } from "zod";
import { guideBlock, termBlock, verifiedSearchBlock } from "../instructions/context";
import { sourceParam } from "./shared";
import { unknownSource } from "./sources";
import { defineTool } from "./types";

export const contextSearch = defineTool({
  name: "context_search",
  effect: "read",
  description:
    "Searches the glossary and guides your team approved for a word or topic the question uses that isn't defined above. Returns matching terms and guides as data.",
  schema: z.object({
    query: z.string().describe("A word or topic from the question: enterprise, fiscal year, how refunds count"),
  }),
  async execute(input, { deps, run }, call) {
    // By meaning too, when the organization can embed: its query's vector, or its words alone if that fails.
    const embedder = await deps.embedder?.(run.orgId).catch(() => null);
    const vector = embedder
      ? await embedder
          .embed(
            [input.query.slice(0, 200)],
            AbortSignal.any([call.signal, AbortSignal.timeout(BUDGETS.embed.queryMs)]),
          )
          .then(([v]) => (v ? { model: embedder.model, vector: v } : undefined))
          .catch((error: unknown) => {
            deps.log?.("context_search: searching by words, the query wasn't embedded", {
              runId: run.id,
              error: error instanceof Error ? error.name : "error",
            });
            return undefined;
          })
      : undefined;
    const found = await deps.withTenant(run.orgId, (tx) =>
      searchContext(tx, run.orgId, run.connectionId, input.query, 5, vector),
    );
    return {
      value: {
        results: found.map((f) => ({
          kind: f.kind,
          title: f.title,
          content:
            f.kind === "guide"
              ? guideBlock(f)
              : f.kind === "verified_query"
                ? verifiedSearchBlock(f.body)
                : termBlock(f.body, f.learned),
        })),
        ...(found.length ? {} : { note: "Nothing approved matches. Use the most common business reading and say so." }),
      },
      summary: {
        query: input.query,
        byMeaning: Boolean(vector),
        found: found.length,
        items: found.map((f) => ({ id: f.id, kind: f.kind, title: f.title, version: f.version })),
      },
    };
  },
});

export const valueLookup = defineTool({
  name: "value_lookup",
  effect: "read",
  description:
    "How a value the user typed is written in the source, read from it now: the values of each column you name that contain the term (case-insensitive, most common first), or, when none does, that column's most common values. Use it before filtering on a value the user typed. Name the catalog's columns that could hold it.",
  schema: z.object({
    term: z.string().describe("A value the user mentioned: Germany, enterprise, Acme Corp"),
    columns: z
      .array(z.string())
      .min(1)
      .max(LIVE_VALUES.columns)
      .describe("schema.table.column for each column that could hold it, from the catalog: public.accounts.country"),
    source: sourceParam,
  }),
  async execute(input, ctx, call) {
    const { run } = ctx;
    const source = await ctx.sources.pick(input.source);
    if (!source) return unknownSource(input.source ?? "", ctx.sources);
    // Only the catalog's columns are read; a name it doesn't have is answered without a query.
    const known = new Map(
      source.tables.flatMap((t) =>
        t.columns.map((c) => [`${t.schema}.${t.name}.${c.name}`.toLowerCase(), { t, c }] as const),
      ),
    );
    const named = input.columns.map((n) => ({ asked: n, hit: known.get(n.trim().toLowerCase()) }));
    const read = await lookupLiveValues(ctx.gateway, {
      orgId: run.orgId,
      connectionId: source.connectionId,
      dialect: source.dialect.id,
      requester: ctx.requester,
      toolCallId: call.rowId,
      signal: call.signal,
      term: input.term,
      columns: named.flatMap((n) => (n.hit ? [`${n.hit.t.schema}.${n.hit.t.name}.${n.hit.c.name}`] : [])),
    });
    const columns = [
      ...read.map((r) =>
        "problem" in r ? { column: r.column, problem: r.problem } : (({ queryRunId: _, ...v }) => v)(r),
      ),
      ...named
        .filter((n) => !n.hit)
        .map((n) => ({
          column: n.asked,
          problem: "Not a column in this source's catalog: name it as schema.table.column.",
        })),
    ];
    const term = input.term.trim().toLowerCase();
    const contains = read.flatMap((r) => ("values" in r && r.match === "contains" ? [r] : []));
    const pick = contains.flatMap((r) => r.values.map((v) => ({ column: r.column, value: v.value })));
    const best = pick.find((p) => p.value.toLowerCase() === term) ?? pick[0];
    return {
      value: { term: input.term, columns },
      // What the run's steps show: Matched "Germany" · country = 'DE', or no match.
      summary: {
        term: input.term,
        columns: columns.length,
        matches: pick.length,
        // The columns no value contained it in, whose most common values were read instead.
        common: read.flatMap((r) => ("values" in r && r.match === "common" ? [r.column.split(".").at(-1)] : [])),
        ...(best
          ? {
              best: {
                table: best.column.split(".").slice(0, -1).join("."),
                column: best.column.split(".").at(-1),
                value: best.value,
                match: best.value.toLowerCase() === term ? "exact" : "contains",
              },
            }
          : {}),
      },
    };
  },
});
