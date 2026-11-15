// A run followed by two pieces of one page (the build bar and the App's glowing edge): read once, each event kept once,
// read again while it goes on, never again once it ends, can't be read, or nothing follows it.
import { describe, expect, it } from "vitest";
import { createRunFeeds } from "@/lib/run-feed";
import type { RunEventLike } from "@/lib/run-steps";

const event = (seq: number): RunEventLike => ({
  seq,
  attempt: 1,
  type: "note",
  data: {},
  createdAt: "2026-11-09T10:00:00.000Z",
});
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(answers: (() => { events: RunEventLike[]; run: { status: string } })[]) {
  const reads: { runId: string; afterSeq: number }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const feeds = createRunFeeds(
    async (runId, afterSeq) => {
      reads.push({ runId, afterSeq });
      const next = answers.shift();
      if (!next) throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
      return next();
    },
    {
      set: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clear: (t) => {
        (t as { cleared: boolean }).cleared = true;
      },
    },
  );
  const due = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { feeds, reads, timers, due };
}

describe("a run's feed", () => {
  it("is read once for every piece following it, each event kept once, until the run ends", async () => {
    const { feeds, reads, due } = harness([
      () => ({ events: [event(1), event(2)], run: { status: "running" } }),
      () => ({ events: [event(2), event(3)], run: { status: "succeeded" } }),
    ]);
    let told = 0;
    const bar = feeds.subscribe("r1", () => told++);
    const edge = feeds.subscribe("r1", () => told++);
    await tick();
    expect(reads).toEqual([{ runId: "r1", afterSeq: 0 }]);
    expect(feeds.get("r1")).toMatchObject({ status: "running", loaded: true });
    expect(feeds.get("r1").events.map((e) => e.seq)).toEqual([1, 2]);
    expect(told).toBe(2);
    due();
    await tick();
    expect(reads.at(-1)).toEqual({ runId: "r1", afterSeq: 2 });
    expect(feeds.get("r1").events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(feeds.get("r1").status).toBe("succeeded");
    // Ended: nothing more is read.
    due();
    await tick();
    expect(reads).toHaveLength(2);
    bar();
    edge();
  });

  it("stops reading once nothing follows it, and starts afresh when something does again", async () => {
    const { feeds, reads, timers } = harness([
      () => ({ events: [event(1)], run: { status: "running" } }),
      () => ({ events: [event(1)], run: { status: "running" } }),
    ]);
    const stop = feeds.subscribe("r2", () => {});
    await tick();
    stop();
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect(feeds.get("r2")).toMatchObject({ loaded: false, events: [] });
    feeds.subscribe("r2", () => {});
    await tick();
    expect(reads.map((r) => r.afterSeq)).toEqual([0, 0]);
  });

  it("reads a run this person can't read as ended, and tries again after any other failure", async () => {
    const { feeds, reads, timers, due } = harness([
      () => {
        throw new Error("The network went away.");
      },
    ]);
    feeds.subscribe("r3", () => {});
    await tick();
    expect(feeds.get("r3")).toMatchObject({ failing: true, status: "running" });
    expect(timers.at(-1)?.ms).toBe(3000);
    due();
    await tick();
    expect(reads).toHaveLength(2);
    expect(feeds.get("r3")).toMatchObject({ unreadable: true, status: "failed", loaded: true, failing: false });
  });
});
