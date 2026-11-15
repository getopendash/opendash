/**
 * The ledger wrapper around every tool: a call runs only once its assistant message is committed, runs exactly
 * once (a call delivered again gets its stored result), and its result and transcript entry are written in one
 * transaction, fenced to the attempt. An agent's budget holds within a step too, so calls made in parallel can't run
 * past it.
 *
 * A tool that runs out of time (its class's timeout, limits.ts) is an error the model sees, with what to try instead,
 * never a failed attempt. A read tool's call ends at its timeout even if its body doesn't stop; a tool that changes
 * something is awaited, so it must stop through its signal.
 *
 * A call whose input code repaired (repair.ts) runs repaired, and its result says what was fixed. While the run wraps
 * up, only its ending tools run; any other call is answered that it's time to finish.
 *
 * Guards: a call from a response cut off at its output limit doesn't run (its input may be cut short);
 * the same call failing again unchanged is called out to the model; and an unexpected exception reaches the model
 * only as "it failed", since its message can quote data (its name is logged).
 */
import { FenceLost, finishToolCall, startToolCall } from "@opendash/core";
import { type Tool, tool } from "ai";
import type { AgentTool } from "../tools/types";
import { type AttemptScope, QUERY_TOOLS, stopOnFence } from "./attempt";
import { OUT_OF_TIME } from "./limits";
import { repairNote } from "./repair";

/** Rejects when the signal aborts, with its reason. */
const whenAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** What the model is told of a call from a response cut off at its output limit. */
export const CUT_SHORT =
  "The response hit its output limit, so this call's input may be cut short: it didn't run. Send less in one call: a shorter input, or the work split across calls.";

/** What's recorded of a call the run's end stopped (a Stop, its time, a shutdown): fixed, so nothing it said is replayed. */
export const RUN_ENDED = "This call was stopped because the run ended before it finished.";

/** What the model is told of an exception a tool didn't expect. */
export const UNEXPECTED = "The tool failed unexpectedly. Try another way, or answer with what you have.";

/** A call's identity for the loop guard: its tool, and its input with keys in order. */
function digest(tool: string, input: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return `${tool}:${JSON.stringify(stable(input))}`;
}

/** The note on a call that failed before with the same input, from its second failure on. */
const repeated = (n: number) =>
  n >= 2 ? ` This exact call has failed ${n} times with the same input: don't call it again unchanged.` : "";

/** What the model is told of a call made while the run wraps up, with the tools that end it. */
export const wrappingUp = (endings: string[]) =>
  `It's time to finish, so this call didn't run: call ${endings.join(" or ")} with what you have.`;

/** The model's words for a call stopped at its timeout. */
const outOfTime = (t: AgentTool, ms: number) =>
  `${t.name} took longer than ${Math.round(ms / 1000)} s, so it was stopped. ${OUT_OF_TIME[t.time ?? "quick"]}`;

export function ledgeredTools(scope: AttemptScope): Record<string, Tool> {
  const { deps, run, state } = scope;
  /** One more failure of this call: how many it has now. */
  const count = (tool: string, input: unknown) => {
    const key = digest(tool, input);
    const n = (scope.failures.get(key) ?? 0) + 1;
    scope.failures.set(key, n);
    return n;
  };
  const ledgered = (t: AgentTool) => async (input: unknown, o: { toolCallId: string; abortSignal?: AbortSignal }) => {
    const work = (async () => {
      const messageId = scope.committed.get(o.toolCallId);
      if (!messageId) throw new Error("The assistant message wasn't saved, so this call can't run.");
      if (scope.signal.aborted) throw scope.signal.reason;
      const row = await startToolCall(deps, run, {
        callId: o.toolCallId,
        tool: t.name,
        effect: t.effect,
        args: input,
        messageId,
      });
      if (row.status === "succeeded") return row.result;
      if (row.status === "failed") throw new Error(row.error);
      if (scope.cut.has(o.toolCallId)) {
        await finishToolCall(deps, run, {
          callId: o.toolCallId,
          tool: t.name,
          outcome: { ok: false, error: CUT_SHORT },
        });
        throw new Error(CUT_SHORT);
      }
      // Wrapping up, only the run's ending tools run; the others stay offered, so the prompt cache holds (policy.ts).
      if (scope.wrapping && !scope.agent.ending.tools.includes(t.name)) {
        // Named from the endings this run has (a leading Modeler has no propose_definitions).
        const message = wrappingUp(
          scope.agent.ending.tools.filter((e) => scope.prepared.tools.some((p) => p.name === e)),
        );
        await finishToolCall(deps, run, { callId: o.toolCallId, tool: t.name, outcome: { ok: false, error: message } });
        throw new Error(message);
      }
      const { limits } = scope;
      // A run's ending is never refused for its count of calls (a step of parallel calls can spend it all): it's how
      // the run stops, and its dollars are the hard stop.
      const ending = scope.agent.ending.tools.includes(t.name);
      if (
        (!ending && state.toolCalls >= limits.maxToolCalls) ||
        (QUERY_TOOLS.has(t.name) && state.queries + scope.queriesRunning >= limits.maxQueries)
      ) {
        // Recorded as refused, so a later attempt replays it as such (and never picks it up as interrupted work).
        const message = "This run's budget for that is spent: finish with what you have.";
        await finishToolCall(deps, run, { callId: o.toolCallId, tool: t.name, outcome: { ok: false, error: message } });
        throw new Error(message);
      }
      state.toolCalls += 1;
      if (QUERY_TOOLS.has(t.name)) scope.queriesRunning += 1;
      const callSignal = o.abortSignal ?? scope.signal;
      try {
        const body = t.execute(input, scope.ctx, { rowId: row.id, signal: callSignal }).finally(() => {
          if (QUERY_TOOLS.has(t.name)) scope.queriesRunning -= 1;
        });
        const out = await (t.effect === "read" ? Promise.race([body, whenAborted(callSignal)]) : body);
        // A result that says it failed (a query's error, a refused save) counts toward the loop guard too.
        const failed = Boolean((out.summary as { failed?: unknown } | undefined)?.failed);
        const note = failed ? repeated(count(t.name, input)) : "";
        // A call whose input code repaired says so, to the model and in the run's steps (repair.ts).
        const fixed = scope.repaired.get(o.toolCallId);
        const object = out.value && typeof out.value === "object" && !Array.isArray(out.value);
        const value = object
          ? {
              ...(out.value as object),
              ...(note ? { note: note.trim() } : {}),
              ...(fixed ? { repaired: repairNote(fixed) } : {}),
            }
          : out.value;
        const summary = fixed ? { ...out.summary, repaired: fixed.map((r) => r.field) } : out.summary;
        await finishToolCall(deps, run, {
          callId: o.toolCallId,
          tool: t.name,
          outcome: { ok: true, value },
          queryRunId: out.queryRunId ?? null,
          ...(summary ? { summary } : {}),
        });
        return value;
      } catch (error) {
        if (error instanceof FenceLost) throw error;
        // The run ending (a Stop, its time, a shutdown, the job): recorded with a fixed message, since a later
        // attempt replays it to the model and the error's own text can quote data.
        if (scope.signal.aborted) {
          await finishToolCall(deps, run, {
            callId: o.toolCallId,
            tool: t.name,
            outcome: { ok: false, error: RUN_ENDED },
          });
          throw error;
        }
        // Its own timeout: the model is told, with what to try instead, and goes on. Anything else a tool throws is
        // unexpected (tools return their known problems as results): the model gets "it failed", the log its name.
        const timedOut = callSignal.aborted;
        if (!timedOut) {
          scope.log("tool failed unexpectedly", {
            runId: run.id,
            tool: t.name,
            error: (error as Error)?.name ?? "error",
          });
        }
        const message =
          (timedOut ? outOfTime(t, scope.limits.tools[t.time ?? "quick"]) : UNEXPECTED) +
          repeated(count(t.name, input));
        await finishToolCall(deps, run, { callId: o.toolCallId, tool: t.name, outcome: { ok: false, error: message } });
        throw new Error(message);
      }
    })();
    scope.inflight.add(work);
    work.then(
      () => scope.inflight.delete(work),
      () => scope.inflight.delete(work),
    );
    try {
      return await work;
    } catch (error) {
      stopOnFence(scope, error);
      throw error;
    }
  };
  return Object.fromEntries(
    scope.prepared.tools.map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.schema, execute: ledgered(t) }),
    ]),
  );
}
