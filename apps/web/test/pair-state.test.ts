// Pair's state for a run: what the run is doing in, one state and whether it moves out.
import { describe, expect, it } from "vitest";
import { pairStateOf } from "../lib/pair-state";
import type { RunStep } from "../lib/run-steps";

const step = (label: string, status: RunStep["status"] = "ok"): RunStep => ({ key: label, label, status });
const run = (over: Partial<Parameters<typeof pairStateOf>[0]> = {}) =>
  pairStateOf({ status: "running", finishing: false, outcome: null, error: null, steps: [], waiting: false, ...over });

describe("Pair's state for a run", () => {
  it("works while a step runs, and thinks between them", () => {
    expect(run({ status: "queued" })).toEqual({ state: "idle", moving: true });
    expect(run({ steps: [step("Read context", "running")] })).toEqual({ state: "working", moving: true });
    expect(run({ steps: [step("Read context"), step("Writing a query", "running")] }).state).toBe("working");
    expect(run({ steps: [step("Read context"), step("Thinking", "running")] })).toEqual({
      state: "thinking",
      moving: true,
    });
    // The live Thinking row still runs while the answer streams after it.
    expect(run({ steps: [step("Thinking", "running"), step("Writing the answer", "running")] }).state).toBe("working");
    // Between model calls nothing runs: the run block shows its own Thinking row.
    expect(run({ steps: [step("Read context")] }).state).toBe("thinking");
    expect(run({ status: "succeeded", finishing: true })).toEqual({ state: "working", moving: true });
  });

  it("holds its pose once the run has ended", () => {
    const answer = { kind: "answer", status: "answered" };
    expect(run({ status: "succeeded", outcome: answer })).toEqual({ state: "success", moving: false });
    expect(run({ status: "succeeded", outcome: { kind: "answer", status: "cannot_answer" } }).state).toBe("idle");
    expect(run({ status: "succeeded", outcome: { kind: "no_answer" } })).toEqual({ state: "attention", moving: false });
    expect(run({ status: "failed", error: "boom" })).toEqual({ state: "attention", moving: false });
    expect(run({ status: "cancelling" })).toEqual({ state: "idle", moving: false });
    expect(run({ status: "cancelled" })).toEqual({ state: "idle", moving: false });
  });

  it("listens to a question back only while it's waiting for this reader", () => {
    const clarify = { kind: "clarify" };
    expect(run({ status: "succeeded", outcome: clarify, waiting: true })).toEqual({ state: "listening", moving: true });
    expect(run({ status: "succeeded", outcome: clarify, waiting: false })).toEqual({
      state: "listening",
      moving: false,
    });
  });
});
