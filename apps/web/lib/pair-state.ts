import type { PairState } from "@opendash/ui";
import type { RunStep } from "./run-steps";

/**
 * Pair's state for a run, from what the run block already knows, and whether it moves. Pure, so it's tested
 * on its own (test/pair-state.test.ts).
 *
 *   queued, or stopping or stopped           idle
 *   a Thinking row running, or none running  thinking (the run block's own "Thinking" row)
 *   any other step running, or finishing     working
 *   asks a question back                     listening
 *   answered                                 success
 *   not answered from the data               idle (said quietly, not a failure)
 *   failed, or couldn't finish an answer     attention
 *
 * Only a run at work moves, and a question back that's still waiting (the latest turn, and the reader can answer it);
 * every other run holds its pose, so a long conversation has at most one Pair moving.
 */
export function pairStateOf(run: {
  status: string;
  /** Succeeded, and its outcome is still landing. */
  finishing: boolean;
  outcome: { kind: string; status?: string } | null;
  error: unknown;
  steps: RunStep[];
  /** The latest turn, and the reader can ask in it. */
  waiting: boolean;
}): { state: PairState; moving: boolean } {
  const { status, outcome } = run;
  if (status === "queued") return { state: "idle", moving: true };
  if (status === "cancelling" || status === "cancelled") return { state: "idle", moving: false };
  if (status === "running") {
    // The live Thinking row runs until the model's message lands, beside what it went on to write: anything else
    // running means it's at work.
    const working = run.steps.some((s) => s.status === "running" && s.label !== "Thinking");
    return { state: working ? "working" : "thinking", moving: true };
  }
  if (run.finishing) return { state: "working", moving: true };
  if (status === "failed") return { state: "attention", moving: false };
  if (outcome?.kind === "clarify" || outcome?.kind === "paused") return { state: "listening", moving: run.waiting };
  if (outcome?.kind === "answer")
    return { state: outcome.status === "cannot_answer" ? "idle" : "success", moving: false };
  if (outcome?.kind === "no_answer" || run.error) return { state: "attention", moving: false };
  return { state: "idle", moving: false };
}
