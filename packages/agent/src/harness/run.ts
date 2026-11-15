/**
 * One attempt at an agent run, the same for every agent (agent.ts): AI SDK's
 * ToolLoopAgent drives the loop; the run ledger makes it durable:
 *   - the assistant message is committed in onLanguageModelCallEnd, before any of its tool calls run, and a failed
 *     commit aborts the run (the SDK swallows errors thrown there): commit.ts;
 *   - every tool runs through the ledger wrapper: it refuses a call whose message wasn't committed, and a call
 *     delivered again gets its stored result instead of running twice: tool-runner.ts;
 *   - every write is fenced by the attempt, so a zombie attempt stops at its next write, and before each model call the
 *     fence, a Stop and the agent's budget are checked: policy.ts;
 *   - the loop stops when the agent says the run ended (the Analyst: an accepted answer or a clarify, never the
 *     first call to answer, since the gate may send it back for repair).
 * The agent decides the prompt, the tools and the ending; this file owns the claim, the attempt's state
 * (attempt.ts), the nudge and the finish. The worker (agent.interactive), evals and `pnpm ask` all come through here.
 */

import {
  type AgentRunJob,
  type AttemptEnd,
  appendNote,
  claimRun,
  FenceLost,
  finalizeRun,
  type RunOutcome,
  rebuildTranscript,
  recordAttemptEnd,
  recordDelta,
  recordPrompt,
  runSpent,
  track,
} from "@opendash/core";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { type ModelMessage, type StopCondition, type Tool, ToolLoopAgent, zodSchema } from "ai";
import { compose } from "../instructions/compose";
import { withBlock, withImages } from "../instructions/context";
import type { ToolContext } from "../tools/types";
import type { AgentDefinition } from "./agent";
import {
  type AttemptScope,
  BudgetSpent,
  HandOff,
  OutOfTime,
  Paused,
  RunStopped,
  StreamAborted,
  workedSoFar,
} from "./attempt";
import { systemBlocks } from "./cache";
import { onCallEnd } from "./commit";
import type { AgentDeps, AttemptResult } from "./deps";
import { type Limits, limitsFor } from "./limits";
import type { ResolvedModel } from "./model";
import { MODEL_REFUSED, readModelError, WORK_TOO_LONG } from "./model-errors";
import { beforeEachStep } from "./policy";
import { repairCalls } from "./repair";
import { resumeOwed } from "./resume";
import { RunDeltas, type StreamPart } from "./stream";
import { ledgeredTools } from "./tool-runner";
import { forRoute } from "./transcript";
import { fitted, harder, tokensOf } from "./window";

const tracer = trace.getTracer("opendash.agent");

/** The AI SDK's telemetry for the analyst: its model and tool spans, without recording what was sent or answered. */

/**
 * How long one attempt waits for a busy provider before handing the run back to the job's retry: the SDK has already
 * retried twice in a few seconds (honouring Retry-After); these are the patient waits after it.
 */
export const BUSY_WAITS_MS = [10_000, 30_000];

/** Waits `ms`, or until `signal` aborts, whichever comes first; never throws. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export const ANALYST_TELEMETRY = { functionId: "opendash.analyst", recordInputs: false, recordOutputs: false } as const;

// The default analyst model lives in core, so the API can queue runs without loading the AI SDK.
export { DEFAULT_MODEL } from "@opendash/core";
export type { AgentDeps, AttemptResult } from "./deps";

/**
 * What a caller may pass besides the job: its worker, the job's signal, the worker's drain (raised on shutdown, so the
 * attempt hands off at its next step boundary), and (in tests) smaller limits.
 */
export interface AttemptOptions {
  workerId: string;
  signal?: AbortSignal;
  drain?: AbortSignal;
  limits?: Partial<Limits>;
  /** A child run's: the parent's attempt that runs it, which must still hold the parent for it to claim. */
  parent?: { id: string; attempt: number };
  /** The waits for a busy provider in this attempt (tests shorten them); BUSY_WAITS_MS by default. */
  busyWaitsMs?: number[];
}

/**
 * One attempt at a run, as the job its profile names (agents/jobs.ts): the worker, evals, Slack and child runs all
 * come through here without naming an agent. A test may pass the job's definition (one it changed); it must still be
 * the run's own job.
 */
export function runAttempt(
  deps: AgentDeps,
  job: AgentRunJob,
  options: AttemptOptions,
  agent?: AgentDefinition,
): Promise<AttemptResult> {
  // One `agent.run` span per attempt (opt-in with an exporter); the AI SDK's model and tool spans
  // and the gateway's query spans nest under it. Ids and outcomes only: never the question, prompt or answer.
  return tracer.startActiveSpan(
    "agent.run",
    { attributes: { "opendash.org_id": job.orgId, "opendash.run_id": job.runId } },
    async (span) => {
      try {
        const result = await attempt(deps, job, options, agent, span);
        span.setAttribute("opendash.status", result?.status ?? "not_claimed");
        if (result && "outcome" in result) span.setAttribute("opendash.outcome", result.outcome);
        if (result?.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

async function attempt(
  deps: AgentDeps,
  job: AgentRunJob,
  options: AttemptOptions,
  given: AgentDefinition | undefined,
  span: Span,
): Promise<AttemptResult> {
  const run = await claimRun(deps, job, options.workerId, options.parent ? { parent: options.parent } : {});
  if (!run) return null;
  const log = deps.log ?? (() => {});
  const ctl = new AbortController();
  const signal = options.signal ? AbortSignal.any([ctl.signal, options.signal]) : ctl.signal;
  const started = Date.now();
  /**
   * Why this attempt ended without ending the run (attempt_ended), when it goes back to its job: best-effort, since it
   * then rethrows anyway, and the next attempt counts an unrecorded end as a failure.
   */
  const ended = (reason: AttemptEnd) =>
    recordAttemptEnd(deps, run, reason).catch((error: unknown) => {
      log("couldn't record the attempt's end", { runId: run.id, reason, error: (error as Error)?.name ?? "error" });
    });
  /** The run's end, with why its attempt ended, in one transaction. */
  const finish = async (
    status: "succeeded" | "failed" | "cancelled",
    outcome: RunOutcome,
    reason: AttemptEnd,
    error: string | null = null,
  ) => {
    await finalizeRun(deps, run, status, outcome, error, reason);
    // Product analytics, where it's on: how someone's question ended. Not a child run's or background work's.
    if (!run.parentRunId && !run.background) {
      void track({
        event: "question_finished",
        userId: run.askedBy,
        orgId: run.orgId,
        properties: {
          status,
          outcome: outcome.kind,
          answer: outcome.kind === "answer" ? outcome.status : null,
          verified: outcome.kind === "answer" ? outcome.verified : null,
          profile: run.profile,
          seconds: Math.round((Date.now() - started) / 1000),
        },
      });
    }
    return { status, outcome: outcome.kind } as const;
  };
  let wall: ReturnType<typeof setTimeout> | undefined;

  try {
    if (run.cancelRequested) return await finish("cancelled", { kind: "no_answer", reason: "Stopped." }, "stopped");
    // The run's job is its profile's; a definition passed in (a test's) must be that job, never another.
    // Looked up here, not imported at the top: the jobs' own tools run child runs through this file (the Modeler's
    // drafter), so a top-level import would load them in a circle.
    const agent = given ?? (await import("../agents/jobs")).jobFor(run.profile);
    span.setAttribute("opendash.profile", run.profile);
    if (!agent || agent.name !== run.profile) {
      return await finish(
        "failed",
        { kind: "no_answer", reason: `This run is the ${run.profile}'s, not the ${given?.name ?? "known jobs"}'s.` },
        "error",
      );
    }
    // An earlier attempt may have got the answer through and died before finalizing.
    const earlier = await agent.outcome(deps, run);
    if (earlier) return await finish("succeeded", earlier, "finished");

    // What the run has used, across its attempts: its budget and its clock go on from there.
    const { deltas: streamed, workedMs, failedAttempts, modelCalls, nudged, ...state } = await runSpent(deps, run);
    const general = limitsFor(agent, run.model, undefined, options.limits);
    if (failedAttempts >= general.attemptFailures) {
      return await finish(
        "failed",
        { kind: "no_answer", reason: agent.ending.stopped.failing },
        "error",
        `${failedAttempts} attempts failed`,
      );
    }
    // Its time is checked once it's prepared: a run may have more than its kind's (a dashboard's build), and a retry of
    // one handed off after the kind's time has its own left.
    const prepared = await agent.prepare(deps, run);
    // A run is offered only its agent's own tools: those its definition was checked with (agent.ts).
    const own = new Set(agent.tools.map((t) => t.name));
    const stray = prepared.tools.find((t) => !own.has(t.name));
    if (stray) throw new Error(`The ${agent.name} agent was offered ${stray.name}, which isn't one of its tools.`);
    const budget = prepared.budget ?? agent.budget;
    const limits = limitsFor(agent, run.model, budget, { ...(prepared.time ?? {}), ...options.limits });
    /** What a paused run says: why, what it spent, and its ceiling. */
    const paused = (why: "ceiling" | "time" | "steps") => ({
      kind: "paused" as const,
      // At its cost, it's the workspace's limits that stopped it when they left less than its ceiling.
      reason: why === "ceiling" && prepared.pause?.byLimit ? ("limit" as const) : why,
      spentUsd: Math.round(state.costUsd * 100) / 100,
      ceilingUsd: prepared.pause?.ceilingUsd ?? null,
    });
    if (workedMs >= (options.limits?.wallMs ?? limits.wallMs)) {
      // A retry of a run that pauses, past its slice (a pause that didn't finalize): it pauses, never fails.
      if (prepared.pause) return await finish("succeeded", paused("time"), "paused");
      return await finish("failed", { kind: "no_answer", reason: agent.ending.stopped.time }, "out_of_time");
    }
    /** What a run too long for the model says: a person's conversation can start again; a background run's work can't. */
    const tooLong = agent.kind === "interactive" ? MODEL_REFUSED.too_long : WORK_TOO_LONG;
    const ctx: ToolContext = {
      ...prepared.context,
      deps,
      run,
      gateway: { withTenant: deps.withTenant, secrets: deps.secrets, edition: deps.edition },
      requester: { type: "run", id: run.id },
      state,
      attempt: {
        workerId: options.workerId,
        ...(options.drain ? { drain: options.drain } : {}),
        maxCostUsd: limits.maxCostUsd,
        // Until it must wrap up: a child it runs ends by then.
        timeLeftMs: () => limits.wrapUpAtMs - (workedMs + (Date.now() - started)),
        // A bigger budget from now on: the policy, the step count and the clock read `limits` as they go;
        // only the hard stop on time was set once, so it's set again. What a test fixed stays fixed.
        raise: (to) => {
          const fixed = options.limits ?? {};
          for (const key of ["maxSteps", "maxToolCalls", "maxQueries", "maxCostUsd", "wallMs", "wrapUpAtMs"] as const) {
            if (fixed[key] === undefined) limits[key] = Math.max(limits[key], to[key]);
          }
          ctx.attempt.maxCostUsd = limits.maxCostUsd;
          if (wall) {
            clearTimeout(wall);
            wall = setTimeout(
              () => ctl.abort(new OutOfTime()),
              Math.max(0, limits.wallMs - (workedMs + (Date.now() - started))),
            );
            wall.unref?.();
          }
        },
      },
    };
    const { layers } = compose(prepared.instructions);
    const block = [layers.question.trim(), prepared.block ?? ""].filter(Boolean).join("\n\n");
    const scope: AttemptScope = {
      deps,
      run,
      agent,
      prepared,
      system: systemBlocks(layers, prepared.conversation?.text),
      block,
      fixed: 0,
      window: limits.window,
      raw: [],
      returned: 0,
      budget,
      limits,
      workedMs,
      ctx,
      state,
      ctl,
      signal,
      drain: options.drain,
      committed: new Map(),
      inflight: new Set(),
      queriesRunning: 0,
      wrapping: nudged,
      wrapAt: null,
      cut: new Set(),
      cutShort: false,
      failures: new Map(),
      recorded: new Map(),
      repaired: new Map(),
      malformed: 0,
      steps: modelCalls,
      nudgedAt: nudged ? modelCalls : null,
      started,
      log,
    };
    // What every call sends besides the conversation: the system blocks, the tools as the model reads them, and what
    // goes with the question.
    const toolsSent = await Promise.all(
      prepared.tools.map(async (t) => ({
        name: t.name,
        description: t.description,
        inputSchema: await zodSchema(t.schema).jsonSchema,
      })),
    );
    scope.fixed = tokensOf(scope.system) + tokensOf(toolsSent) + tokensOf(scope.block);
    // The run's working time is a hard stop: whatever is running is stopped, and the run says it ran out of time.
    wall = setTimeout(() => ctl.abort(new OutOfTime()), Math.max(0, limits.wallMs - workedMs));
    wall.unref?.();

    const tools: Record<string, Tool> = ledgeredTools(scope);
    const reached: StopCondition<typeof tools> = ({ steps }) =>
      agent.ending.reached(
        (steps.at(-1)?.toolResults ?? []).map((r) => ({ toolName: r.toolName, output: r.output as unknown })),
      );
    // The run's steps, across its passes and attempts: its own budget, or the few left after a nudge or a wrap-up.
    const stepsUsed: StopCondition<typeof tools> = () => {
      const left = [scope.nudgedAt, scope.wrapAt].flatMap((at) => (at === null ? [] : [at + limits.nudgeSteps]));
      return scope.steps >= Math.min(limits.maxSteps, ...left);
    };

    let resolved: ResolvedModel;
    try {
      resolved = await deps.model({
        orgId: run.orgId,
        runId: run.id,
        modelId: run.model,
        provider: run.provider,
        reasoning: run.reasoning,
      });
      trace.getActiveSpan()?.setAttributes({
        "opendash.attempt": run.attempt,
        "opendash.model": run.model,
        "opendash.provider": resolved.provider,
        "opendash.route": resolved.route,
        "opendash.reasoning": run.reasoning,
        "opendash.key_source": resolved.keySource,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "No model is available.";
      return await finish("failed", { kind: "no_answer", reason }, "model_refused", reason);
    }
    // What this attempt sends, kept before its first model call: memory as a count, never its text.
    await recordPrompt(deps, run, {
      agent: layers.agent,
      source: layers.source,
      question: block,
      verified: prepared.verified ?? [],
      tools: prepared.tools.map((t) => t.name),
      attached: prepared.conversation?.attached ?? [],
      memories: prepared.conversation?.memories ?? 0,
    });
    // What the run streams while it works: only an interactive agent's, for someone watching; never a
    // background run's or an eval's.
    const deltas =
      agent.kind !== "interactive" || run.background || run.trigger === "eval"
        ? null
        : new RunDeltas((data) => recordDelta(deps, run, { ...data }), Date.now, streamed);
    // The SDK's own error printer would log the whole error, request included: only its name and status here.
    const quiet = {
      onError: ({ error }: { error: unknown }) => {
        const e = error as { name?: string; statusCode?: number };
        log("model stream error", { runId: run.id, name: e?.name, status: e?.statusCode });
      },
    };
    const loop = new ToolLoopAgent({
      ...(quiet as object),
      model: resolved.model,
      // With an exporter, spans carry timings, usage and ids; never the prompt or the output (a question, its data).
      telemetry: ANALYST_TELEMETRY,
      // The agent layer, then the source layer, each a cache point (cache.ts); the question layer goes with the question.
      instructions: scope.system,
      tools,
      toolOrder: prepared.tools.map((t) => t.name),
      stopWhen: [reached, stepsUsed],
      // Tools only: each by its class. A model call's silence is bounded in its own stream (model.ts); the SDK's
      // stepMs and chunkMs would count a step's tool time as the model's.
      timeout: {
        toolMs: limits.tools.quick,
        tools: Object.fromEntries(
          prepared.tools
            .filter((t) => t.time && t.time !== "quick")
            .map((t) => [`${t.name}Ms`, limits.tools[t.time ?? "quick"]]),
        ),
      },
      // How long it thinks: the SDK's reasoning, or the route's own options where it takes it there.
      ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
      ...(Object.keys(resolved.providerOptions).length ? { providerOptions: resolved.providerOptions as never } : {}),
      prepareStep: beforeEachStep(scope),
      repairToolCall: repairCalls(scope),
      onLanguageModelCallEnd: onCallEnd(scope, resolved, deltas),
    });

    // Work its last attempt left unfinished (a drafter cut off), picked up before the model goes on. Ended
    // meanwhile (its time, a lost fence, the job), the attempt ends as the loop's would; failed, as an error of ours.
    if (run.attempt > 1) {
      try {
        await resumeOwed(deps, run, prepared.tools, ctx, signal);
      } catch (error) {
        const why = ctl.signal.aborted ? ctl.signal.reason : null;
        if (why instanceof FenceLost || error instanceof FenceLost) return null;
        if (why instanceof OutOfTime) {
          return await finish("failed", { kind: "no_answer", reason: agent.ending.stopped.time }, "out_of_time");
        }
        if (options.signal?.aborted) {
          await ended(options.drain?.aborted ? "shutdown" : "job_expired");
          throw new Error("The attempt was stopped (job expired or worker shutting down).");
        }
        await ended("error");
        throw new Error(`The attempt failed picking up its work: ${(error as Error)?.name ?? "Error"}`);
      }
    }

    /** A prompt the model found too long is folded harder and sent once more, never resent as it was. */
    let foldHarder = false;
    /** Waits for a busy provider taken in this attempt (BUSY_WAITS_MS), after the SDK's own quick retries. */
    let busyWaits = 0;
    const waits = options.busyWaitsMs ?? deps.busyWaitsMs ?? BUSY_WAITS_MS;
    /** Passes that ended on a response cut off at its output limit, each followed by another (never a nudge). */
    let cutPasses = 0;
    for (;;) {
      const transcript = (await rebuildTranscript(deps, run)) as ModelMessage[];
      // What belongs to this run alone (the date, the insight it checks, the verified queries like it) goes with its
      // question; earlier questions came back with theirs (rebuildTranscript).
      // Another route's reasoning in the transcript (a conversation that changed model or provider) isn't replayed.
      const messages = forRoute(
        withImages(withBlock(transcript, scope.block), prepared.conversation?.images),
        resolved.route,
      );
      if (foldHarder) {
        const now = fitted(messages, scope.fixed, limits.window).tokens;
        const tighter = harder(limits.window, now);
        // Nothing more to fold: sending it again would fail the same way.
        if (fitted(messages, scope.fixed, tighter).tokens >= now) {
          return await finish("failed", { kind: "no_answer", reason: tooLong }, "model_too_long", "model too_long");
        }
        scope.window = tighter;
      }
      // Each step's messages are fitted to the window from this pass's conversation (policy.ts, window.ts).
      scope.raw = [];
      scope.returned = 0;
      let again = false;
      try {
        const result = await loop.stream({ messages, abortSignal: signal });
        for await (const part of result.fullStream) {
          // A failed or aborted stream ends with a part, not a throw: both go to the handling below.
          if (part.type === "error") throw part.error;
          if (part.type === "abort")
            throw ctl.signal.reason ?? options.signal?.reason ?? new StreamAborted(part.reason);
          deltas?.part(part as StreamPart);
        }
      } catch (error) {
        // The SDK ends the stream at once on an abort, with tools still running: they end first (they stop through
        // their signal), so nothing is written after the run is finalized.
        await Promise.allSettled([...scope.inflight]);
        const why = ctl.signal.aborted ? ctl.signal.reason : null;
        if (why instanceof FenceLost) return null;
        if (why instanceof RunStopped) {
          return await finish("cancelled", { kind: "no_answer", reason: "Stopped." }, "stopped");
        }
        if (why instanceof Paused) return await finish("succeeded", paused(why.reason), "paused");
        if (why instanceof BudgetSpent) {
          return await finish("failed", { kind: "no_answer", reason: agent.ending.stopped.budget }, "budget");
        }
        // A run that pauses pauses at the slice's hard end too (the step boundary's check came first, mostly).
        if (why instanceof OutOfTime && prepared.pause) return await finish("succeeded", paused("time"), "paused");
        if (why instanceof OutOfTime) {
          return await finish("failed", { kind: "no_answer", reason: agent.ending.stopped.time }, "out_of_time");
        }
        // Handed off for a shutdown: what ran is saved, and the next attempt goes on from it. Not a failure.
        if (why instanceof HandOff) {
          await ended("shutdown");
          return { status: "handed_off" } as const;
        }
        if (options.signal?.aborted) {
          // Stopped by pg-boss: its grace ran out mid-step at a shutdown (not a failure), or the job expired.
          await ended(options.drain?.aborted ? "shutdown" : "job_expired");
          throw new Error("The attempt was stopped (job expired or worker shutting down).");
        }
        // An error of ours (a commit that failed, the database before a step): the attempt failed, not the model.
        if (why) {
          await ended("error");
          throw new Error(`The attempt failed: ${(why as Error)?.name ?? "Error"}`);
        }
        // A model error, by what it means (model-errors.ts). No prompt or response bodies in what we rethrow or log.
        const e = error as { name?: string; statusCode?: number };
        const read = readModelError(error);
        log("model call failed", { runId: run.id, name: e.name, status: e.statusCode, kind: read.kind });
        if (read.kind === "too_long" && !foldHarder) {
          foldHarder = true;
          again = true;
        } else if (read.kind === "busy" && busyWaits < waits.length && !signal.aborted) {
          // A busy provider (a rate limit, an overload) is waited out here first, so a minute's storm doesn't spend the
          // run's attempts. The wait ends early when the run's time or job does; the next pass then ends as those do.
          const ms = waits[busyWaits] as number;
          busyWaits += 1;
          log("model busy, waiting", { runId: run.id, ms, status: read.status });
          await pause(ms, signal);
          again = true;
        } else if (read.kind === "busy" || read.kind === "stalled") {
          // The job retries later, from the saved transcript.
          await ended(read.kind === "stalled" ? "model_stalled" : "model_busy");
          throw new Error(`The model call failed: ${e.name ?? "Error"}${e.statusCode ? ` (${e.statusCode})` : ""}`);
        } else {
          // Retrying can't help: the run ends now, saying what to do.
          return await finish(
            "failed",
            { kind: "no_answer", reason: read.kind === "too_long" ? tooLong : MODEL_REFUSED[read.kind] },
            read.kind === "too_long" ? "model_too_long" : "model_refused",
            `model ${read.kind}${read.status ? ` (${read.status})` : ""}`,
          );
        }
      } finally {
        await Promise.allSettled([...scope.inflight]);
        await deltas?.settle();
      }
      if (again) continue;
      const why = ctl.signal.aborted ? ctl.signal.reason : null;
      if (why instanceof FenceLost) return null;
      if (why instanceof RunStopped) {
        return await finish("cancelled", { kind: "no_answer", reason: "Stopped." }, "stopped");
      }
      const outcome = await agent.outcome(deps, run);
      if (outcome) return await finish("succeeded", outcome, "finished");
      // The SDK stops at a response cut off at its output limit; its calls were answered with why, so the model
      // sends them again whole in another pass, twice at most.
      if (scope.cutShort && cutPasses < 2) {
        scope.cutShort = false;
        cutPasses += 1;
        continue;
      }
      // A run that pauses and used its money, steps or slice pauses; otherwise it's nudged to end, once. Its cost
      // first: the last call can cross the ceiling with no step boundary after it.
      if (prepared.pause && state.costUsd >= limits.maxCostUsd) {
        return await finish("succeeded", paused("ceiling"), "paused");
      }
      if (prepared.pause && (scope.steps >= limits.maxSteps || workedSoFar(scope) >= limits.wrapUpAtMs)) {
        return await finish("succeeded", paused(scope.steps >= limits.maxSteps ? "steps" : "time"), "paused");
      }
      if (scope.nudgedAt !== null || workedSoFar(scope) >= limits.wrapUpAtMs) {
        return await finish("failed", { kind: "no_answer", reason: agent.ending.stopped.unfinished }, "finished");
      }
      await appendNote(deps, run, prepared.ending?.nudge ?? agent.ending.nudge);
      scope.nudgedAt = scope.steps;
      // A wrap-up's steps may be spent by now: the nudge counts its own from here.
      scope.wrapAt = null;
      scope.wrapping = true;
    }
  } catch (error) {
    if (error instanceof FenceLost) return null;
    throw error;
  } finally {
    clearTimeout(wall);
  }
}
