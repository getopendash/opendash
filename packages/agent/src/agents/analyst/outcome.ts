/**
 * How an Analyst run ended, read from the ledger rather than memory, so a resumed attempt finds it too: a card for the
 * person (connect a service, allow a call), a clarify, or an answer the gate accepted, with the path its numbers took and the context it was given or found.
 */

import type { Plan } from "@opendash/apps/dashboard";
import {
  type AnswerInput,
  BUDGETS,
  type ClaimedRun,
  type ContextUse,
  checkAnswer,
  clarifyQuestions,
  finishedToolCalls,
  type RunOutcome,
  recordedContext,
  verifiedFollowed,
} from "@opendash/core";
import { sql } from "@opendash/db";
import type { AgentDeps } from "../../harness/deps";
import { citable } from "../../tools/endings";

/**
 * The context the run was given (its recorded event), found (context_search), and read from the knowledge folder
 *: a skill read is one it followed, a table's guides came with its file.
 */
async function usedContext(deps: AgentDeps, run: ClaimedRun): Promise<{ context?: ContextUse[] }> {
  const uses = new Map<string, ContextUse>();
  for (const u of (await recordedContext(deps, run)).items) uses.set(u.id, u);
  const results = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ data: { tool?: string; items?: ContextUse[]; guides?: ContextUse[] } }>(sql`
      select data from app.run_event
      where org_id = ${run.orgId} and run_id = ${run.id} and type = 'tool_result'
        and data->>'tool' in ('context_search', 'read')
      order by seq`),
  );
  for (const { data } of results) {
    // A verified definition read is the governed path at work, shown with its queries, not as context; one of
    // OpenDash's own skills has no page to link to, and the run's record keeps it.
    for (const f of (data.items ?? []).filter(
      (i) => (i.kind as string) !== "metric" && (i.kind as string) !== "dataset" && !i.id.startsWith("opendash/"),
    )) {
      if (!uses.has(f.id)) uses.set(f.id, { ...f, how: f.kind === "skill" ? "read" : "search" });
    }
    for (const g of data.guides ?? []) {
      if (!uses.has(g.id))
        uses.set(g.id, { id: g.id, kind: "guide", title: g.title, version: g.version, how: "table" });
    }
  }
  // A verified query it was given was followed when one of its metric queries computed the same metrics.
  const given = [...uses.values()].filter((u) => u.kind === "verified_query");
  if (given.length) {
    const followed = new Set(await deps.withTenant(run.orgId, (tx) => verifiedFollowed(tx, run.orgId, run.id, given)));
    for (const u of given) if (followed.has(u.id)) uses.set(u.id, { ...u, followed: true });
  }
  return uses.size ? { context: [...uses.values()] } : {};
}

/** A card the run ended with for the person: connect a service, or allow one call (tools/mcp.ts). */
async function mcpCard(deps: AgentDeps, run: ClaimedRun): Promise<RunOutcome | null> {
  const waiting = (await finishedToolCalls(deps, run, "mcp_call")).find((c) => c.result?.waiting === true);
  const r = waiting?.result as Record<string, unknown> | undefined;
  if (!r) return null;
  if (r.card === "mcp_connect") {
    return {
      kind: "mcp_connect",
      serverId: String(r.serverId),
      server: String(r.server),
      ...(typeof r.host === "string" ? { host: r.host } : {}),
      auth: r.auth === "apikey" ? "apikey" : "oauth",
      state: r.state === "reconnect" || r.state === "wrong_account" ? r.state : "connect",
      scope: r.scope === "org" ? "org" : "personal",
      message: typeof r.message === "string" ? r.message : null,
    };
  }
  if (r.card === "mcp_consent") {
    return {
      kind: "mcp_consent",
      serverId: String(r.serverId),
      server: String(r.server),
      ...(typeof r.host === "string" ? { host: r.host } : {}),
      tool: String(r.tool),
      reason: r.reason === "changed" ? "changed" : "ask",
      arguments: (r.arguments ?? {}) as Record<string, unknown>,
      digest: String(r.digest),
      // The tool and account the card is for: an Allow once holds only while they're still these.
      ...(typeof r.binding === "string" ? { binding: r.binding } : {}),
    };
  }
  return null;
}

/** The dashboard the run planned, as a card the person says Build it to (tools/dashboards.ts). */
async function dashboardPlan(deps: AgentDeps, run: ClaimedRun): Promise<RunOutcome | null> {
  const [plan] = await finishedToolCalls(deps, run, "dashboard_plan");
  if (!(plan?.result as { accepted?: boolean } | undefined)?.accepted) return null;
  // The plan, or a plan from before it was nested (its fields at the top), so a run that resumes after a deploy ends.
  const a = (plan?.args ?? {}) as { dashboard_id?: string; plan?: Plan } & Partial<Plan>;
  const p: Partial<Plan> | undefined = a.plan ?? (a.title && a.pages ? a : undefined);
  if (!p?.title || !p.pages) return null;
  return {
    kind: "dashboard_plan",
    dashboardId: a.dashboard_id ?? null,
    title: p.title,
    purpose: p.purpose ?? "",
    datasets: p.datasets ?? [],
    filters: p.filters ?? [],
    ...(p.nav ? { nav: p.nav } : {}),
    pages: p.pages,
    ...(p.notes?.length ? { notes: p.notes } : {}),
    ...(p.reference ? { reference: { ...p.reference, data: p.reference.data ?? [] } } : {}),
    custom: p.pages.flatMap((page) => page.sections.filter((s) => s.kind === "custom").map((s) => s.title)),
  };
}

export async function analystOutcome(deps: AgentDeps, run: ClaimedRun): Promise<RunOutcome | null> {
  const card = await mcpCard(deps, run);
  if (card) return card;
  const plan = await dashboardPlan(deps, run);
  if (plan) return plan;
  const [clarify] = await finishedToolCalls(deps, run, "clarify");
  // Its questions, or the one question of a run that asked before then and is read again.
  if (clarify) return { kind: "clarify", questions: clarifyQuestions(clarify.args) };
  const [answer] = await finishedToolCalls(deps, run, "answer");
  const result = answer?.result as
    | {
        accepted?: boolean;
        verified?: boolean;
        rendered?: string;
        caveats?: string[];
        interpretation?: string[];
        problems?: string[];
      }
    | undefined;
  if (!answer || !result?.accepted) return null;
  const args = answer.args as unknown as AnswerInput;
  // The gate is deterministic: run again on the same results, it gives the pieces the UI renders traced numbers from,
  // without sending them back to the model in the tool result.
  const results = await citable(deps, run);
  const { glossary: definitions, files: askerNumbers } = await recordedContext(deps, run);
  const gate = checkAnswer(args, {
    results,
    question: run.question,
    definitions,
    ...(askerNumbers ? { askerNumbers } : {}),
    rowsShown: BUDGETS.agent.rowsToModel,
  });
  // The answer's path (the label it shows): metric only when every query its numbers cite came from definitions.
  const figureSegments = gate.figures.flatMap((f) => [...f.value, ...(f.change?.segments ?? []), ...(f.detail ?? [])]);
  const cited = new Set(
    [
      ...gate.segments.markdown,
      ...gate.segments.caveats.flat(),
      ...gate.segments.interpretation.flat(),
      ...figureSegments,
    ].flatMap((seg) => ("ref" in seg && seg.kind === "number" ? seg.citations.map((c) => c.alias) : [])),
  );
  const path =
    cited.size > 0 && [...cited].every((a) => results.find((r) => r.alias === a)?.path === "metric")
      ? ("metric" as const)
      : ("unmodelled" as const);
  return {
    kind: "answer",
    status: args.status,
    verified: Boolean(result.verified),
    markdown: args.markdown,
    rendered: result.rendered ?? "",
    interpretation: result.interpretation ?? args.interpretation ?? [],
    caveats: [
      ...(result.caveats ?? args.caveats ?? []),
      ...(result.verified ? [] : ["Some of this answer couldn't be verified; the marked parts are unchecked."]),
    ],
    citations: gate.citations,
    values: gate.values,
    problems: result.problems ?? [],
    segments: gate.segments,
    checked: gate.checked,
    ...(gate.crossChecks.length ? { crossChecks: gate.crossChecks } : {}),
    path,
    ...(gate.charts.length ? { charts: gate.charts } : {}),
    ...(gate.title ? { title: gate.title } : {}),
    ...(gate.figures.length ? { figures: gate.figures } : {}),
    // What it can do instead (with cannot_answer) or next: plain questions, never numbers to check.
    ...(args.next?.length
      ? {
          next: args.next
            .slice(0, 3)
            .map((q) => q.trim())
            .filter(Boolean),
        }
      : {}),
    ...(await usedContext(deps, run)),
  };
}
