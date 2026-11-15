/**
 * What's checked before every model call (prepareStep): the fence, so a zombie attempt stops here instead of paying
 * for another call; a Stop someone pressed; a shutdown, where the attempt hands off; the agent's budget, whose
 * dollars are a hard stop; and whether the run has to wrap up (its budget nearly spent, its working time nearly up, too
 * many failed queries, malformed calls in a row, or after a nudge). Wrapping up keeps the tools and the system text as
 * they are, so the prompt cache holds (cache.ts): the model is told in a message, and only its ending tools run
 * (tool-runner.ts). Then the step's messages: as the ledger has them, with any follow-up the asker sent meanwhile
 *, fitted to the model's window (window.ts), with their cache points.
 */
import { FOLLOW_UP_MARK, FOLLOW_UP_SEP, joinFollowUps, NOTE_MARK, stopRequested } from "@opendash/core";
import type { ModelMessage } from "ai";
import { type AttemptScope, BudgetSpent, HandOff, Paused, RunStopped, stopOnFence, workedSoFar } from "./attempt";
import { withCachePoints } from "./cache";
import { asRecorded } from "./messages";
import { fitted } from "./window";

/** Model calls in a row whose every tool call was malformed, before the run wraps up. */
export const MALFORMED_IN_A_ROW = 3;

export function beforeEachStep(scope: AttemptScope) {
  const { ctl } = scope;
  const check = checks(scope);
  return async ({ messages }: { messages: ModelMessage[] }) => {
    try {
      await check();
      // What the last step added (the SDK hands back what it was given, then that), as the ledger has it.
      scope.raw.push(...asRecorded(messages.slice(scope.returned), scope.recorded));
      // What the asker sent meanwhile, read before the next call: their message after the step it came in. Not while
      // wrapping up, when the model may only answer: it waits, and is the next run's question.
      if (!scope.wrapping && scope.agent.kind === "interactive") {
        const joined = await joinFollowUps(scope.deps, scope.run).catch((error) => {
          stopOnFence(scope, error);
          throw error;
        });
        for (const m of joined) {
          scope.raw.push({ role: "user", content: m.text, providerOptions: FOLLOW_UP_MARK });
          // The asker's words in this run (the gate, the memory tools): theirs as much as the question.
          scope.run.question = [scope.run.question, m.text].join(FOLLOW_UP_SEP);
        }
      }
      // Wrapping up is said once, as a note; after a nudge, the nudge has said it.
      const wrapUp = scope.prepared.ending?.wrapUp ?? scope.agent.ending.wrapUp;
      const told = scope.raw.some((m) => m.role === "user" && m.content === wrapUp);
      if (scope.wrapping && scope.nudgedAt === null && !told) {
        scope.raw.push({ role: "user", content: wrapUp, providerOptions: NOTE_MARK });
      }
      const fit = fitted(scope.raw, scope.fixed, scope.window);
      // Folded as far as it goes, the run's own turn is still past its window: it's sent, and the provider decides.
      if (fit.tokens > scope.window.limit) {
        scope.log("over the model's window after folding", {
          runId: scope.run.id,
          tokens: fit.tokens,
          limit: scope.window.limit,
        });
      }
      // A step sends what the last one sent and more; a fold rewrites earlier messages, so the cache can't hold.
      const before = scope.lastSent;
      scope.prefixBroke =
        before && (fit.messages.length < before.length || before.some((m, k) => fit.messages[k] !== m))
          ? "folded"
          : undefined;
      scope.lastSent = fit.messages;
      const sent = withCachePoints(fit.messages);
      scope.returned = sent.length;
      return { messages: sent };
    } catch (error) {
      // An error of ours (the database, the fence) ends the attempt as ours, never read as the model's.
      if (!ctl.signal.aborted) ctl.abort(error);
      throw error;
    }
  };
}

function checks(scope: AttemptScope) {
  const { deps, run, state, ctl } = scope;
  return async () => {
    const stop = await stopRequested(deps, run).catch((error) => {
      stopOnFence(scope, error);
      throw error;
    });
    if (stop) {
      ctl.abort(new RunStopped());
      throw new RunStopped();
    }
    // The worker is shutting down: this step boundary is where the attempt hands off, before another model call.
    if (scope.drain?.aborted) {
      ctl.abort(new HandOff());
      throw new HandOff();
    }
    const { limits } = scope;
    // A run that pauses stops at a step boundary at its ceiling or its slice's end, never wrapped up early for them.
    if (scope.prepared.pause) {
      const why =
        state.costUsd >= limits.maxCostUsd
          ? "ceiling"
          : workedSoFar(scope) >= limits.wrapUpAtMs
            ? "time"
            : scope.steps >= limits.maxSteps ||
                state.toolCalls >= limits.maxToolCalls - 2 ||
                state.queries >= limits.maxQueries
              ? "steps"
              : null;
      if (why) {
        ctl.abort(new Paused(why));
        throw new Paused(why);
      }
    } else if (state.costUsd >= limits.maxCostUsd) {
      ctl.abort(new BudgetSpent());
      throw new BudgetSpent();
    }
    const spent =
      state.queries >= limits.maxQueries ||
      state.toolCalls >= limits.maxToolCalls - 2 ||
      state.costUsd >= limits.maxCostUsd * 0.8;
    const late = workedSoFar(scope) >= limits.wrapUpAtMs;
    // Three model calls in a row whose every tool call was malformed: it's going round, so it ends.
    const stuck = scope.malformed >= MALFORMED_IN_A_ROW;
    const paces = !scope.prepared.pause && (late || spent);
    if (!scope.wrapping && (paces || stuck || state.failedQueries >= limits.maxFailedQueries)) {
      scope.wrapping = true;
      scope.wrapAt = scope.steps;
    }
  };
}
