import { dialectFor } from "@opendash/connectors";
import {
  BUDGETS,
  type ClaimedRun,
  type ContextUse,
  contextForRun,
  conversationAttachments,
  dashboards,
  mcp,
  memoriesForRun,
  memoryRoom,
  recordContext,
  reserveForRun,
  sourceQueryError,
  toJsonb,
  verifiedForQuestion,
} from "@opendash/core";
import { sql } from "@opendash/db";
import { defineAgent } from "../../harness/agent";
import type { AgentDeps } from "../../harness/deps";
import { tablesFolder, tablesForPrompt } from "../../instructions/catalog";
import {
  attachmentsForConversation,
  fileNumbers,
  glossaryForPrompt,
  glossaryNumbers,
  memoryForConversation,
  pinnedForPrompt,
  skillsForPrompt,
  verifiedForMessage,
} from "../../instructions/context";
import { dashboardDatasetsBlock } from "../../instructions/dashboards";
import { mentionedMetrics, metricsForPrompt } from "../../instructions/metrics";
import { BUILTIN_SKILLS, builtinId, builtinPath, skillFile } from "../../skills";
import { buildAnApp } from "../../skills/build-an-app";
import { definitionDraft, remember } from "../../tools/actions";
import { DASHBOARD_TOOLS } from "../../tools/dashboards";
import { answer, clarify } from "../../tools/endings";
import { grep, ls, read } from "../../tools/files";
import { contextSearch, valueLookup } from "../../tools/knowledge";
import { MCP_TOOLS } from "../../tools/mcp";
import { metricQuery, sqlCheck, sqlQuery } from "../../tools/queries";
import {
  directoryForPrompt,
  loadSourceById,
  OTHER_SOURCES_MAX,
  sourceRegistry,
  summarizeSources,
} from "../../tools/sources";
import type { AgentTool, RunSource } from "../../tools/types";
import { analystOutcome } from "./outcome";
import { analystSections, FINISH_NUDGE, WRAP_UP } from "./prompt";

/** The Analyst's tools, in the order the model sees them. */
export const ANALYST_TOOLS: AgentTool[] = [
  contextSearch,
  ls,
  read,
  grep,
  metricQuery,
  valueLookup,
  sqlCheck,
  sqlQuery,
  definitionDraft,
  remember,
  ...MCP_TOOLS,
  ...DASHBOARD_TOOLS,
  answer,
  clarify,
] as AgentTool[];

/** The Analyst's budget: its steps, and about twice the biggest of its recorded runs. */
export const ANALYST_BUDGET = { maxSteps: BUDGETS.agent.maxSteps, ...BUDGETS.agent.analyst };

/** Tools that only make sense on a source with verified metrics. */
const NEEDS_METRICS = new Set(["metric_query"]);
/** Offered only with a metric or dataset attached that's the asker's to change. */
const NEEDS_EDITABLE_DEFINITION = new Set(["definition_draft"]);
/** Offered only where connected services are set up and on, and the workspace has one turned on. */
const MCP_TOOL_NAMES = new Set<string>(MCP_TOOLS.map((t) => t.name));

/** Offered only in a conversation about an App or a dashboard, with the build-an-app skill. */
const DASHBOARD_TOOL_NAMES = new Set<string>(DASHBOARD_TOOLS.map((t) => t.name));
/** A question that names a dashboard: a word starting "dash" (so "dashbaord" counts), "board" or "tile". */
// An App by name, or the kinds of App people ask for: a tracker, a desk.
const DASHBOARD_WORDS = /\bdash|\bboards?\b|\btiles?\b|\bapps?\b|\bapplication\b|\btracker\b|\bdesk\b/i;
/**
 * A person's run in OpenDash (no time, step or call caps; a dollar ceiling the workspace sets):
 * it works in slices a job can hold, and pauses (never fails) at its ceiling or a slice's end, saying what it spent;
 * Continue is the person's next turn. Steps, calls and queries are only there to catch a run going round in circles.
 * Slack, the API, evals and background work keep the analyst's own budget.
 */
const SLICE = { wallMs: 9 * 60_000, wrapUpAtMs: 8 * 60_000 + 30_000 };
const LOOSE = { maxSteps: 300, maxToolCalls: 600, maxQueries: 150 };

/** How a run that builds a dashboard wraps up: the draft as it stands is saved; say what's there. */
const DASHBOARD_WRAP_UP =
  "(OpenDash) Wrap up now. Asked for an App and no plan shown yet: show one now with dashboard_plan from what you've found, what's still unsure in its notes; it ends your turn. Building one: if its draft needs one last fix, save it with dashboard_save, then answer in two or three lines with what's there and what's left (status answered); the draft is kept as last saved.";
/** The nudge to finish in a conversation about a dashboard: a plan is an ending too. */
const DASHBOARD_NUDGE =
  "(OpenDash) The run needs to end now: with dashboard_plan if a dashboard was asked for and no plan is shown yet, otherwise with the answer tool, or clarify if you need the user to choose. Call one of them now.";

/** Whether this conversation built a dashboard, or an earlier question in it was given the dashboard tools. */
async function dashboardsBefore(deps: AgentDeps, run: ClaimedRun): Promise<boolean> {
  const [row] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ yes: boolean }>(sql`
      select exists (
          select 1 from app.dashboard d
          where d.org_id = ${run.orgId} and d.thread_id = ${run.threadId} and d.deleted_at is null)
        or exists (
          select 1 from app.run r
          where r.org_id = ${run.orgId} and r.thread_id = ${run.threadId} and r.id <> ${run.id}
            and r.prompt->'attached' @> ${toJsonb([{ id: builtinId(buildAnApp) }])}::jsonb) as yes`),
  );
  return Boolean(row?.yes);
}

/** Whether this run is offered the connected-service tools. */
async function servicesHere(deps: AgentDeps, run: ClaimedRun): Promise<boolean> {
  if (!deps.mcp || !mcp.mcpEnabled()) return false;
  const [row] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ yes: boolean }>(sql`
      select true as yes from app.mcp_server where org_id = ${run.orgId} and status = 'active' limit 1`),
  );
  return Boolean(row);
}

/** The source a run asks: its catalog, dialect and verified definitions (one source; the analyst reads several). */
export const loadSource = (deps: AgentDeps, run: ClaimedRun): Promise<RunSource> =>
  loadSourceById(deps, run.orgId, run.connectionId);

export const analyst = defineAgent({
  name: "analyst",
  kind: "interactive",
  tools: ANALYST_TOOLS,

  async prepare(deps, run) {
    const sources = await sourceRegistry(deps, run);
    const source = sources.main;
    // The glossary and guides an admin approved, recorded with their versions before the model sees them.
    // A learning's test is given its unreleased term too, on that run alone.
    const context = await deps.withTenant(run.orgId, (tx) =>
      contextForRun(tx, run.orgId, run.connectionId, run.candidate),
    );
    const given: ContextUse[] = [
      ...context.terms.map((t) => ({
        id: t.id,
        kind: "term" as const,
        title: t.spec.term,
        version: t.version,
        how: "glossary" as const,
      })),
      ...context.pinned.map((g) => ({
        id: g.id,
        kind: "guide" as const,
        title: g.title,
        version: g.version,
        how: "pinned" as const,
      })),
    ];
    // What the asker attached to this conversation, checked again for them now.
    const attached = await deps.withTenant(run.orgId, (tx) =>
      conversationAttachments(tx, { orgId: run.orgId, userId: run.askedBy }, run.threadId, run.connectionId, {
        canTryDrafts: run.canTryDrafts,
      }),
    );
    // Files are the asker's data, already on their message: not recorded again here, nor a piece of their App they
    // selected (kept on the message with its lines). A metric or dataset given with its YAML to change is recorded at
    // the version of that YAML, a draft when it isn't the released one.
    given.push(
      ...attached.items
        .flatMap((a) => (a.kind === "file" || a.kind === "image" || a.kind === "app_element" ? [] : [a]))
        .map((a) => {
          const definition = a.kind === "metric" || a.kind === "dataset" ? a : null;
          return {
            id: a.id,
            kind: a.kind,
            // A private dashboard's title stays its owner's: a shared conversation's readers see this record.
            title: a.kind === "dashboard" && !a.shared ? "" : a.title,
            version: definition?.current?.version ?? a.version,
            how: "attached" as const,
            ...((a.kind === "skill" && a.draft) ||
            (a.kind === "dashboard" && a.draft) ||
            (definition && (!definition.released || definition.current?.draft))
              ? { draft: true }
              : {}),
          };
        }),
    );
    const attachedIds = new Set(attached.items.map((a) => a.id));
    // The verified queries like the question: given with its message, after the cached prompt.
    const matched = source.semantic
      ? await deps.withTenant(run.orgId, (tx) =>
          verifiedForQuestion(
            tx,
            run.orgId,
            run.connectionId,
            run.question,
            mentionedMetrics(run.question, source.semantic),
          ),
        )
      : [];
    const verified = matched.filter((v) => !attachedIds.has(v.id));
    given.push(
      ...verified.map((v) => ({
        id: v.id,
        kind: "verified_query" as const,
        title: v.spec.question,
        version: v.version,
        how: "question" as const,
      })),
    );
    // The asker's own memories, recorded without their text: a shared conversation's readers see the run.
    const asker = run.askedBy;
    // Only for a run its asker asked in a conversation private to them, on the web or in a Slack DM (memoryRoom): a
    // shared one's readers, or a Slack channel's, would see what the analyst made of them.
    const room = await deps.withTenant(run.orgId, (tx) => memoryRoom(tx, run.orgId, run.id));
    // A source whose queries can't connect (its latest query was refused: a wrong password, a host gone): told before
    // anything is planned, so the analyst says so instead of querying, building or guessing around it.
    const failing = await deps
      .withTenant(run.orgId, (tx) => sourceQueryError(tx, run.orgId, run.connectionId))
      .catch(() => null);
    const memories =
      asker && deps.withUser && room
        ? await deps.withUser(run.orgId, asker, (tx) => memoriesForRun(tx, run.orgId, asker))
        : [];
    given.push(
      ...memories.map((m) => ({
        id: m.id,
        kind: "memory" as const,
        title: "",
        version: m.version,
        how: "yours" as const,
      })),
    );
    const glossary = glossaryForPrompt(context.terms);
    // What the gate lets an answer echo: the terms' defining values, not the glossary's prose; and the numbers in the
    // files the person attached, which it may repeat only as theirs, saying so.
    const definitions = glossaryNumbers(context.terms);
    const askerNumbers = fileNumbers(attached.items);
    if (given.length || askerNumbers) await recordContext(deps, run, given, definitions, askerNumbers);
    // The organization's other sources, listed by name with what each has (read cheaply: one that can't be
    // read leaves the list, never fails the question), and each further dialect's notes once.
    const listed = sources.others.slice(0, OTHER_SOURCES_MAX);
    const others = await summarizeSources(deps, run.orgId, listed).catch((error: unknown) => {
      deps.log?.("analyst: other sources left out", {
        runId: run.id,
        error: error instanceof Error ? error.name : "error",
      });
      return [];
    });
    const otherDialects = [
      ...new Map(
        listed
          .filter((o) => o.dialect !== source.dialect.id && others.some((x) => x.name === o.name))
          .map((o) => [o.dialect, dialectFor(o.dialect)] as const),
      ).values(),
    ].map((d) => ({ name: d.name, notes: d.notes() }));
    const instructions = analystSections({
      sourceName: source.name,
      dialectName: source.dialect.name,
      dialectNotes: source.dialect.notes(),
      catalog: tablesForPrompt(source.tables, tablesFolder(source.name)),
      metrics: metricsForPrompt(source.semantic),
      glossary,
      guides: pinnedForPrompt(context.pinned),
      skills: skillsForPrompt([
        ...BUILTIN_SKILLS.map((b) => ({ title: b.title, description: b.description, path: builtinPath(b) })),
        ...context.skills,
      ]),
      skillChosen: attached.items.some((a) => a.kind === "skill"),
      now: (deps.now ?? (() => new Date()))(),
      rowsShown: BUDGETS.agent.rowsToModel,
      ...(others.length ? { otherSources: directoryForPrompt(others), otherDialects } : {}),
    });
    // A conversation about a dashboard is given the dashboard tools, OpenDash's build-an-app skill and what a
    // dashboard on its source can read: when the question names one, or the conversation built one or was given them
    // before. They stay for the conversation, so "Build it", a retry or "add churn to it" keep them, and the cache holds.
    // Only for a person asking in OpenDash itself (not Slack, the API or an eval): a dashboard is its asker's, built
    // beside the conversation. A dashboard attached (@, or the panel beside it) counts as naming one.
    const person = Boolean(run.askedBy) && run.trigger === "user";
    // Where it pauses: the workspace's ceiling (Settings → Usage), or none; never past what the monthly and daily
    // limits leave. Reserved on the run, under the spend lock, so runs going on together share the room.
    const reserved = person
      ? await deps.withTenant(run.orgId, (tx) => reserveForRun(tx, run.orgId, run, deps.now?.()))
      : null;
    // A conversation that built one or was shown a plan before: this question builds (or changes) it.
    const before = person && (await dashboardsBefore(deps, run));
    // A piece of an App selected to change names its App too.
    const dashboardsHere =
      person &&
      (DASHBOARD_WORDS.test(run.question) ||
        attached.items.some((a) => a.kind === "dashboard" || a.kind === "app_element") ||
        before);
    const datasets = dashboardsHere
      ? dashboardDatasetsBlock(
          { name: source.name, connectionId: run.connectionId },
          (await deps.withTenant(run.orgId, (tx) => dashboards.dashboardCatalog(tx, run.orgId, run.connectionId)))
            ?.catalog ?? null,
          sources.others.slice(0, OTHER_SOURCES_MAX),
        )
      : null;
    // What the whole conversation is given, rebuilt every run: what's attached to it, checked again for
    // this asker, the dashboard skill, and their memory. The record keeps what it held, by id and version, the
    // memories as a count.
    const conversation = {
      text: [
        attachmentsForConversation(attached.items, attached.missing),
        dashboardsHere &&
          `When the question asks for an App (a dashboard, a tool, a page over their data) or a change to one, follow OpenDash's build-an-app skill.\n\n${skillFile(buildAnApp)}\n\n${datasets}`,
        failing &&
          `${source.name}'s latest query couldn't connect: "${failing}" Its queries will fail the same way until an admin fixes it under Data → ${source.name}. Try one query only if the question needs this source's data; when it fails like that, say so plainly in the answer (status cannot_answer) and what to fix, and don't build or change anything on it.`,
        memoryForConversation(memories),
      ]
        .filter(Boolean)
        .join("\n\n"),
      attached: [
        ...attached.items.map((a) => ({
          kind: a.kind,
          id: a.id,
          // A dashboard's draft given: what's written about it is its owner's (draftWorkIn reads this).
          ...(a.kind === "dashboard" && a.draft ? { draft: true } : {}),
          ...("current" in a && a.current
            ? { version: a.current.version }
            : "version" in a
              ? { version: a.version }
              : {}),
        })),
        ...(dashboardsHere ? [{ kind: "skill", id: builtinId(buildAnApp), version: buildAnApp.version }] : []),
      ],
      memories: memories.length,
      // The person's images, shown with the question (their bytes never go into the recorded prompt).
      ...(attached.items.some((a) => a.kind === "image")
        ? {
            images: attached.items.flatMap((a) =>
              a.kind === "image" ? [{ mediaType: a.mediaType, data: a.data }] : [],
            ),
          }
        : {}),
    };
    const editable = attached.items.some((a) => (a.kind === "metric" || a.kind === "dataset") && a.editable);
    const services = await servicesHere(deps, run);
    return {
      instructions,
      tools: ANALYST_TOOLS.filter(
        (t) =>
          (source.semantic || !NEEDS_METRICS.has(t.name)) &&
          (editable || !NEEDS_EDITABLE_DEFINITION.has(t.name)) &&
          (services || !MCP_TOOL_NAMES.has(t.name)) &&
          (dashboardsHere || !DASHBOARD_TOOL_NAMES.has(t.name)),
      ),
      context: { source, sources, context, definitions, asker, ...(askerNumbers ? { askerNumbers } : {}) },
      block: verifiedForMessage(verified),
      verified: verified.map((v) => ({ kind: "verified_query", id: v.id, version: v.version })),
      conversation,
      ...(dashboardsHere ? { ending: { wrapUp: DASHBOARD_WRAP_UP, nudge: DASHBOARD_NUDGE } } : {}),
      // A person's own run pauses at the workspace's ceiling instead of failing on a cap.
      ...(reserved
        ? {
            pause: { ceilingUsd: reserved.ceilingUsd, byLimit: reserved.byLimit },
            time: SLICE,
            budget: { ...LOOSE, maxCostUsd: reserved.spendable },
          }
        : {}),
    };
  },

  outcome: analystOutcome,

  ending: {
    reached: (results) =>
      results.some(
        (r) =>
          r.toolName === "clarify" ||
          ((r.toolName === "answer" || r.toolName === "dashboard_plan") &&
            Boolean((r.output as { accepted?: boolean } | undefined)?.accepted)) ||
          // A service the person has to connect, or a call they have to allow: their card ends the run.
          (r.toolName === "mcp_call" && Boolean((r.output as { waiting?: boolean } | undefined)?.waiting)),
      ),
    // Wrapping up, a dashboard's draft can still be opened and saved (after a refusal that it changed) before the answer.
    tools: ["answer", "clarify", "dashboard_plan", "dashboard_open", "dashboard_save"],
    wrapUp: WRAP_UP,
    nudge: FINISH_NUDGE,
    stopped: {
      unfinished: "The analyst stopped without an answer it could stand behind.",
      budget: "The analyst reached its budget before answering.",
      time: "The analyst ran out of time before an answer it could stand behind. Ask again, or ask a narrower question.",
      failing: "The analyst stopped unexpectedly. Ask again.",
    },
  },
  budget: ANALYST_BUDGET,
});
