// A run's trace as its timeline draws it: model calls timed from what ended before them, tool calls where
// they ran, drafters as lanes (waiting for a turn, then working), a new attempt marked, the axis spread evenly.
import type { RunTrace, TraceView } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { duration, timelineOf } from "../lib/run-timeline";

const T0 = Date.parse("2026-10-16T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const usage = { inputTokens: 12400, cachedInputTokens: 6200, outputTokens: 600 };

const drafter = (
  id: string,
  queued: number,
  started: number | null,
  steps: [number, number, number][],
  finished: number | null,
): RunTrace => ({
  run: {
    id,
    orgId: "o",
    threadId: "t",
    profile: "drafter",
    model: "m",
    trigger: "user",
    status: finished === null ? "running" : "succeeded",
    attempt: 1,
    error: null,
    outcome: null,
    queuedAt: iso(queued),
    finishedAt: finished === null ? null : iso(finished),
  },
  attempts: started === null ? [] : [{ attempt: 1, started: iso(started), reason: "" }],
  prompt: null,
  steps: steps.map(([at, a, z], i) => ({
    seq: i + 1,
    at: iso(at),
    model: "claude-haiku-4-5",
    usage,
    costUsd: 0.012,
    stopReason: null,
    calls: [
      { tool: "propose_definitions", status: "succeeded", ms: (z - a) * 1000, startedAt: iso(a), finishedAt: iso(z) },
    ],
  })),
  followUps: [],
});

const view: TraceView = {
  title: "Drafting 4 tables on warehouse",
  redacted: false,
  totals: { ms: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, helpers: 2 },
  trace: {
    run: {
      id: "lead",
      orgId: "o",
      threadId: "t",
      profile: "modeler",
      model: "m",
      trigger: "user",
      status: "running",
      attempt: 2,
      error: null,
      outcome: null,
      queuedAt: iso(-1),
      finishedAt: null,
    },
    attempts: [
      { attempt: 1, started: iso(0), ended: iso(50), reason: "shutdown" },
      { attempt: 2, started: iso(52), reason: "" },
    ],
    prompt: null,
    steps: [
      {
        seq: 1,
        at: iso(6),
        model: "claude-haiku-4-5",
        usage,
        costUsd: 0.008,
        stopReason: null,
        calls: [
          {
            tool: "draft_tables",
            status: "succeeded",
            ms: 68_000,
            startedAt: iso(6),
            finishedAt: iso(74),
            tables: ["public.accounts", "public.plans"],
            child: drafter(
              "d1",
              6,
              6,
              [
                [14, 14, 16],
                [27, 27, 33],
              ],
              74,
            ),
          },
          {
            tool: "draft_tables",
            status: "started",
            ms: null,
            startedAt: iso(6),
            tables: ["support.tickets"],
            child: drafter("d2", 6, 74, [[83, 83, 86]], null),
          },
        ],
      },
    ],
    followUps: [],
  },
};

describe("timelineOf", () => {
  const model = timelineOf(view, T0 + 160_000);

  it("lays the run over its time, its model call from the attempt's start, and a lane per drafter", () => {
    expect(model.rows.map((r) => [r.kind, r.level, r.label])).toEqual([
      ["run", 0, "Drafting 4 tables on warehouse"],
      ["step", 1, "draft_tables × 2"],
      ["helper", 2, "public.accounts, public.plans"],
      ["helper", 2, "support.tickets"],
    ]);
    expect(model.rows[0]).toMatchObject({ state: "working", time: "2m 40s" });
    // The model call ran from the attempt's start (0s) to its message (6s), of 160s.
    expect(model.rows[1]?.segments[0]).toEqual({ from: 0, to: 6 / 160, kind: "model" });
  });

  it("shows a drafter waiting for a turn, then working on to now", () => {
    const [, , done, waiting] = model.rows;
    expect(done?.state).toBe("done");
    expect(done?.segments.some((s) => s.kind === "wait")).toBe(false);
    expect(waiting?.state).toBe("working");
    expect(waiting?.segments[0]).toEqual({ from: 6 / 160, to: 74 / 160, kind: "wait" });
    expect(waiting?.segments.at(-1)).toEqual({ from: 86 / 160, to: 1, kind: "running" });
    // Its calls are its detail: the model call's tokens and cost, then the tool's time.
    expect(waiting?.detail[0]).toMatchObject({ tokens: "12.4k in · 50% cached · 600 out", cost: "$0.012" });
  });

  it("marks the attempt after the first, and spreads the axis evenly", () => {
    expect(model.marks).toEqual([52 / 160]);
    expect(model.attempts).toEqual(["Attempt 2 began at 0:52, after attempt 1 ended: shutdown."]);
    expect(model.ticks).toEqual(["0.0s", "40s", "1m 20s", "2m 00s", "2m 40s"]);
  });

  it("says a time as a person reads it", () => {
    expect([duration(400), duration(6100), duration(155_000), duration(3_725_000)]).toEqual([
      "0.4s",
      "6.1s",
      "2m 35s",
      "1h 02m",
    ]);
  });
});
