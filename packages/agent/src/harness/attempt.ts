/**
 * One attempt's shared state. run.ts builds it, and the parts of the loop read and change it: the tool runner
 * (tool-runner.ts), the checks before each step (policy.ts) and the commit after each model call (commit.ts). It holds
 * the run, what it was prepared with, what it has spent, and the controller that ends it.
 */
import { type ClaimedRun, FenceLost } from "@opendash/core";
import type { ModelMessage, SystemModelMessage } from "ai";
import type { AgentTool, RunState, ToolContext } from "../tools/types";
import type { AgentBudget, AgentDefinition, PreparedRun } from "./agent";
import type { AgentDeps } from "./deps";
import type { Limits } from "./limits";
import type { Repair } from "./repair";
import type { InputWindow } from "./window";

export interface AttemptScope {
  deps: AgentDeps;
  run: ClaimedRun;
  agent: AgentDefinition;
  prepared: PreparedRun;
  /** The system prompt: the agent and source layers, then the conversation layer (cache.ts). */
  system: SystemModelMessage[];
  budget: AgentBudget;
  limits: Limits;
  /** Earlier attempts' working time: the run's clock goes on from there. */
  workedMs: number;
  /** What the tools read: the prepared context, the run, the gateway, what the run has spent. */
  ctx: ToolContext;
  state: RunState;
  /** Ends the attempt, aborted with why: the fence lost, a Stop, a budget spent. */
  ctl: AbortController;
  /** The attempt's signal: its controller's and the job's. */
  signal: AbortSignal;
  /** Raised when the worker is shutting down: the attempt hands off at its next step boundary. */
  drain: AbortSignal | undefined;
  /** Tool calls whose assistant message was committed, by call id: the message's id. */
  committed: Map<string, string>;
  /** Tool bodies still running. */
  inflight: Set<Promise<unknown>>;
  /** Query calls started and not yet counted (the query tools count themselves when they finish). */
  queriesRunning: number;
  /**
   * The run is wrapping up (a nudge, its budget nearly spent, its time nearly up, too many failures): the model is told
   * so, and only its ending tools run.
   */
  wrapping: boolean;
  /** The run's step count when it began wrapping up without a nudge, after which only a few more are left; or null. */
  wrapAt: number | null;
  /** Calls from a response cut off at its output limit: their input may be cut short, so none runs. */
  cut: Set<string>;
  /** The last pass ended on a response cut off at its output limit (the SDK stops there): it goes on, unnudged. */
  cutShort: boolean;
  /** Failed calls by tool and input, so one repeated unchanged is called out. */
  failures: Map<string, number>;
  /**
   * What was recorded for each call that never ran (its input didn't parse, or its response was cut off), by call id:
   * what the model is shown for it, within a pass as on a rebuild (messages.ts).
   */
  recorded: Map<string, string>;
  /** What goes with the question, after the cache: its question layer, then the agent's own block. */
  block: string;
  /** What every call sends besides the conversation (the system blocks, the tools, the block), in tokens (window.ts). */
  fixed: number;
  /** What a call may send, and what a fold brings it down to; halved once the model says the prompt is too long. */
  window: InputWindow;
  /**
   * This pass's conversation as the ledger has it, unfolded: what each step's fold is decided from, so the same
   * messages fold the same way whenever they're sent (window.ts).
   */
  raw: ModelMessage[];
  /** How many messages the last step was handed: the SDK sends those, then what that step added. */
  returned: number;
  /** Calls whose input code repaired before they ran (repair.ts), by call id: what it fixed. */
  repaired: Map<string, Repair[]>;
  /** Model calls in a row whose every tool call was malformed. */
  malformed: number;
  /** Model calls this run has made, across its passes and attempts: its step budget is the run's. */
  steps: number;
  /** The run's step count when it was nudged, after which only a few more are left; null before. */
  nudgedAt: number | null;
  started: number;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  /** The messages the last step sent, before cache points: a fold shows as a prefix that changed (cache.ts). */
  lastSent?: ModelMessage[];
  /** Why this step's prefix differs from the last one's, when it does: what a cache miss is put down to. */
  prefixBroke?: "folded";
  /** What the last call left in the cache (read and written) and when it ended: the next call should read it back. */
  lastCache?: { tokens: number; at: number };
}

/** Someone stopped the run: it ends as cancelled at the next step boundary. */
export class RunStopped extends Error {
  override name = "RunStopped";
  constructor() {
    super("The run was stopped.");
  }
}

/** The run spent its agent's dollar budget (the Investigator's $2): it ends failed, saying so. */
export class BudgetSpent extends Error {
  override name = "BudgetSpent";
}

/** A run that pauses (PreparedRun.pause) reached its ceiling, its slice's time or its steps: it ends paused, not failed. */
export class Paused extends Error {
  override name = "Paused";
  constructor(readonly reason: "ceiling" | "time" | "steps") {
    super(`The run paused: ${reason}.`);
  }
}

/** The worker is shutting down: the attempt ends at a step boundary, and its job runs again. */
export class HandOff extends Error {
  override name = "HandOff";
}

/** The run used its kind's working time: it ends failed, saying so. */
export class OutOfTime extends Error {
  override name = "OutOfTime";
  constructor() {
    super("The run used its working time.");
  }
}

/** The SDK ended the stream itself: the reason is the SDK's words, never the prompt. */
export class StreamAborted extends Error {
  override name = "StreamAborted";
  constructor(reason?: string) {
    super(reason ?? "The model's stream was aborted.");
  }
}

/** The tools that count as an agent's queries. */
export const QUERY_TOOLS = new Set(["sql_query", "metric_query"]);

/** A write that found the fence lost ends the attempt, once: a newer attempt owns the run. */
export function stopOnFence(scope: AttemptScope, error: unknown): void {
  if (error instanceof FenceLost && !scope.ctl.signal.aborted) scope.ctl.abort(error);
}

/** The run's working time so far: its earlier attempts', then this one's. */
export const workedSoFar = (scope: AttemptScope): number => scope.workedMs + (Date.now() - scope.started);

/** The agent's tool of that name, if the run was offered it. */
export const offered = (scope: AttemptScope, name: string): AgentTool | undefined =>
  scope.prepared.tools.find((t) => t.name === name);
