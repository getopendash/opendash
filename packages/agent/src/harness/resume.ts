/**
 * Work picked up when a run resumes: its calls of a resumable tool whose work is still owed (a drafter left
 * unfinished by a crash or a shutdown) run again with the same input, before the model's next call.
 * - Only work that was admitted resumes: a call the harness refused (cut short, wrapping up, over its budget) or that
 *   failed for a reason of its own is never run here. The tool decides from what's recorded whether its work is owed.
 * - What each returns reaches the model as a report after its transcript, written as soon as that call ends, once (a
 *   later attempt never writes it again, and writes one an earlier attempt didn't get to). The transcript before it
 *   stays as it was, so the cache built on it holds; a report is never read as a nudge to end.
 * - Every call runs to its end before the attempt goes on or fails: none is left working behind a failed attempt.
 */
import { createHash } from "node:crypto";
import { appendNote, type ClaimedRun } from "@opendash/core";
import { sql } from "@opendash/db";
import type { AgentTool, ToolContext } from "../tools/types";
import type { AgentDeps } from "./deps";
import { RUN_ENDED } from "./tool-runner";

/**
 * A call's report, by its run, its tool and the work it stands for (the tool's own key, or its input): one per piece
 * of work, whatever attempt or call it came from.
 */
const reportKey = (run: ClaimedRun, tool: AgentTool, input: unknown) => {
  const work = tool.resume?.key ? tool.resume.key(input as never) : JSON.stringify(input);
  const digest = createHash("sha256").update(`${run.id} ${tool.name} ${work}`).digest("hex");
  return `opendash:report:${digest.slice(0, 32)}`;
};

export async function resumeOwed(
  deps: AgentDeps,
  run: ClaimedRun,
  tools: AgentTool[],
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<void> {
  const resumable = new Map(tools.filter((t) => t.resume).map((t) => [t.name, t]));
  if (!resumable.size) return;
  // Every call the run made, from its transcript: one interrupted before it started has no tool_call row yet.
  const messages = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ content: { content?: { type?: string; toolCallId?: string; toolName?: string; input?: unknown }[] } }>(
      sql`
        select content from app.message
        where org_id = ${run.orgId} and run_id = ${run.id} and role = 'assistant' and status = 'complete'
        order by seq`,
    ),
  );
  // Each call on its own: the same work asked for twice is two calls, one refused and the other admitted, say.
  const calls: { key: string; id: string; tool: AgentTool; input: unknown }[] = [];
  for (const m of messages) {
    for (const p of Array.isArray(m.content.content) ? m.content.content : []) {
      const tool = p.type === "tool-call" ? resumable.get(p.toolName ?? "") : undefined;
      const parsed = tool?.schema.safeParse(p.input);
      if (!tool || !parsed?.success || !p.toolCallId) continue;
      calls.push({ key: reportKey(run, tool, parsed.data), id: p.toolCallId, tool, input: parsed.data });
    }
  }
  if (!calls.length) return;
  const [recorded, reported] = await deps.withTenant(
    run.orgId,
    async (tx) =>
      [
        await tx.execute<{ call_id: string; status: string; result: unknown; error: string | null }>(sql`
          select call_id, status, result, error from app.tool_call
          where org_id = ${run.orgId} and run_id = ${run.id}
            and call_id in (${sql.join(
              calls.map((c) => sql`${c.id}`),
              sql`, `,
            )})`),
        await tx.execute<{ key: string }>(sql`
          select client_msg_id as key from app.message
          where org_id = ${run.orgId} and thread_id = ${run.threadId}
            and client_msg_id in (${sql.join(
              [...new Set(calls.map((c) => c.key))].map((k) => sql`${k}`),
              sql`, `,
            )})`),
      ] as const,
  );
  const rows = new Map(recorded.map((r) => [r.call_id, r]));
  const done = new Set(reported.map((r) => r.key));
  // Whether each call was admitted is its own: only then is the work it stands for picked up, once per piece of work.
  const owed = new Map<string, (typeof calls)[number]>();
  for (const c of calls) {
    if (done.has(c.key) || owed.has(c.key)) continue;
    const row = rows.get(c.id);
    // Refused or failed for a reason of its own: it was answered, and that's what the model has.
    if (row?.status === "failed" && row.error !== RUN_ENDED) continue;
    const interrupted = !row || row.status === "started" || row.status === "unknown" || row.status === "failed";
    const result = row?.status === "succeeded" ? row.result : undefined;
    if (await c.tool.resume?.owed(c.input as never, ctx, { interrupted, result })) owed.set(c.key, c);
  }
  if (!owed.size) return;
  const settled = await Promise.allSettled(
    [...owed.values()].map(async (c) => {
      const r = await c.tool.execute(c.input as never, ctx, { rowId: "resumed", signal });
      // Unfinished again (the worker shut down meanwhile): the next attempt picks it up, and reports it then.
      if ((r.summary as { unfinished?: unknown } | undefined)?.unfinished) return;
      await appendNote(
        deps,
        run,
        `(OpenDash) Work under way when the run restarted, picked up and now done: ${c.tool.name} ${JSON.stringify(c.input)}: ${JSON.stringify(r.value)}`,
        { kind: "report", key: c.key },
      );
    }),
  );
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}
