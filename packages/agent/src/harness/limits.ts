/**
 * The limits a run works within, from its agent's kind and budget:
 * - its working time and when it wraps up, counted over its attempts (a retry never starts a fresh clock);
 * - its steps, and the few left after a nudge;
 * - its tool calls, queries and dollars;
 * - how many failed queries make it wrap up, and how many failed attempts end it;
 * - how long each class of tool may take;
 * - how much a model call may send, by its model's window and price line.
 * A model call's own silence is bounded in its stream (model.ts), never here: a step's tools run between model
 * calls, and their time isn't the model's. Tests pass smaller limits through runAttempt.
 */
import { BUDGETS } from "@opendash/core";
import type { ToolTime } from "../tools/types";
import type { AgentBudget, AgentDefinition } from "./agent";
import { type InputWindow, inputWindow } from "./window";

export interface Limits extends AgentBudget {
  wallMs: number;
  wrapUpAtMs: number;
  /** The steps left after the nudge, which may only end the run. */
  nudgeSteps: number;
  maxFailedQueries: number;
  attemptFailures: number;
  /** How long a tool of each class may take before it's stopped, and the model is told so. */
  tools: Record<ToolTime, number>;
  /** What a model call may send, by its model (window.ts). */
  window: InputWindow;
}

export function limitsFor(
  agent: AgentDefinition,
  model: string,
  budget?: AgentBudget,
  override: Partial<Limits> = {},
): Limits {
  const a = BUDGETS.agent;
  return {
    window: inputWindow(model),
    ...a.kinds[agent.kind],
    ...(budget ?? agent.budget),
    nudgeSteps: a.nudgeSteps,
    maxFailedQueries: a.maxFailedQueries,
    attemptFailures: a.attemptFailures,
    tools: { quick: a.tools.quickMs, query: a.tools.queryMs, slow: a.tools.slowMs, child: a.tools.childMs },
    ...override,
  };
}

/** What a tool that ran out of time should try instead, by its class. */
export const OUT_OF_TIME: Record<ToolTime, string> = {
  quick: "Try it again, or go on without it.",
  query: "Make it lighter: a shorter period, fewer columns, or aggregate before you join.",
  slow: "Do less in one call: fewer drafts, or fewer tiles that take filters.",
  child: "Hand it fewer tables at once, or end with what's done.",
};
