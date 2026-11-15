// What a run streams: the answer's text read from its tool input piece by piece, and the coalescing
// bounds: how often a delta is written, how many, and that a call's tail never outlives its committed message.
import { describe, expect, it, vi } from "vitest";
import {
  ANSWER_RESERVE,
  type DeltaData,
  FieldStream,
  FLUSH_MS,
  MAX_DELTAS,
  outlineOf,
  RunDeltas,
} from "../src/harness/stream";

/** Feeds `json` to a FieldStream in pieces of `size`, returning everything it decoded. */
const streamed = (json: string, size: number, field = "markdown") => {
  const f = new FieldStream(field);
  let out = "";
  for (let i = 0; i < json.length; i += size) out += f.feed(json.slice(i, i + size));
  return out;
};

describe("the answer's text, from its streamed input", () => {
  const input = {
    status: "answered",
    charts: [{ title: "not this", markdown: "nor this" }],
    markdown: 'MRR was ⟦q1:0:mrr|currency:USD⟧.\nSay "up" — 😀 \\ done',
    interpretation: ["markdown"],
  };
  const json = JSON.stringify(input);

  it("decodes the one field, whatever the piece size, skipping the same name nested", () => {
    for (const size of [1, 2, 3, 5, 7, 64, json.length]) expect(streamed(json, size)).toBe(input.markdown);
  });

  it("decodes \\u escapes split across pieces, and stops at the field's end", () => {
    const escaped = '{"markdown":"\\u00e9t\\u00e9 \\ud83d\\ude00","next":["x"]}';
    for (const size of [1, 2, 4, 6]) expect(streamed(escaped, size)).toBe("été 😀");
  });

  it("gives nothing for input without the field, or before its value starts", () => {
    expect(streamed('{"status":"answered","caveats":[]}', 3)).toBe("");
    const f = new FieldStream("markdown");
    expect(f.feed('{"status":"answered","mark')).toBe("");
    expect(f.feed('down":"Hel')).toBe("Hel");
    expect(f.feed('lo"}')).toBe("lo");
  });
});

describe("coalescing", () => {
  const harness = (written = 0) => {
    let t = 0;
    const out: DeltaData[] = [];
    const deltas = new RunDeltas(
      async (d) => {
        out.push(d);
      },
      () => t,
      written,
    );
    deltas.part({ type: "start-step" });
    return { deltas, written: out, tick: (ms: number) => (t += ms) };
  };
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it("writes at most one delta per flush interval, and everything before the call's message", async () => {
    const { deltas, written, tick } = harness();
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: "Sept" });
    for (const piece of ["ember ", "against ", "August."]) {
      tick(10);
      deltas.part({ type: "reasoning-delta", text: piece });
    }
    await settled();
    expect(written.map((w) => w.thinking)).toEqual(["Sept"]);
    tick(FLUSH_MS);
    deltas.part({ type: "tool-input-start", id: "c1", toolName: "sql_query" });
    await deltas.endCall();
    expect(written.map((w) => [w.thinking, w.writing])).toEqual([
      ["Sept", undefined],
      ["ember against August.", ["c1"]],
    ]);
  });

  it("says a dashboard's save is being written as soon as its input starts", async () => {
    const { deltas, written, tick } = harness();
    tick(1000);
    deltas.part({ type: "tool-input-start", id: "d1", toolName: "dashboard_save" });
    await deltas.endCall();
    expect(written.map((w) => w.building)).toEqual([["d1"]]);
  });

  it("names a dashboard's pages and sections as its input arrives, in pieces, each name once", async () => {
    const { deltas, written, tick } = harness();
    tick(1000);
    deltas.part({ type: "tool-input-start", id: "p1", toolName: "dashboard_page" });
    const input =
      '{"dashboard_id":"x","page":{"id":"p_customers","title":"Customers","sections":[{"id":"s_head","kind":"kpi","title":"Who they are"},{"id":"s_sum","kind":"custom","title":"Summary \\"now\\""}';
    for (let i = 0; i < input.length; i += 20)
      deltas.part({ type: "tool-input-delta", id: "p1", delta: input.slice(i, i + 20) });
    await deltas.endCall();
    const outline = written.flatMap((w) => w.outline ?? []).at(-1);
    expect(outline).toEqual({
      callId: "p1",
      items: [
        { id: "p_customers", title: "Customers" },
        { id: "s_head", title: "Who they are" },
        { id: "s_sum", title: 'Summary "now"' },
      ],
    });
    expect(outlineOf('{"id":"s_a","title":"Half wri')).toEqual([]);
    // Whatever order its fields come in, with nested values between them.
    expect(
      outlineOf(
        '{"title":"Revenue","y":["mrr"],"list":{"title":"x"},"kind":"chart","id":"s_rev"},{"id":"s_b","title":"B"}',
      ),
    ).toEqual([
      { id: "s_rev", title: "Revenue" },
      { id: "s_b", title: "B" },
    ]);
  });

  it("flushes soon after the stream pauses, so a burst's last words don't wait for the next", async () => {
    vi.useFakeTimers();
    try {
      const { deltas, written, tick } = harness();
      tick(1000);
      deltas.part({ type: "reasoning-delta", text: "First " });
      tick(10);
      deltas.part({ type: "reasoning-delta", text: "burst." });
      await vi.advanceTimersByTimeAsync(FLUSH_MS + 10);
      expect(written.map((w) => w.thinking)).toEqual(["First ", "burst."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a call's tail that arrives after its message was committed, until the next step", async () => {
    const { deltas, written, tick } = harness();
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: "First call." });
    await deltas.endCall();
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: " (late)" });
    deltas.part({ type: "start-step" });
    deltas.part({ type: "reasoning-delta", text: "Second call." });
    await deltas.close();
    expect(written.map((w) => w.thinking)).toEqual(["First call.", "Second call."]);
  });

  it("drops a step that ended before the stream showed it start (a call that came in one burst)", async () => {
    const { deltas, written, tick } = harness();
    await deltas.endCall();
    // The second call ends before the reader sees its start: all of its parts are behind its message.
    await deltas.endCall();
    deltas.part({ type: "start-step" });
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: "behind its message" });
    deltas.part({ type: "start-step" });
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: "the third call" });
    await deltas.settle();
    expect(written.map((w) => w.thinking)).toEqual(["the third call"]);
  });

  it("keys the answer's text by its call, so a repaired answer starts over", async () => {
    const { deltas, written, tick } = harness();
    const answer = (id: string, text: string) => {
      tick(1000);
      deltas.part({ type: "tool-input-start", id, toolName: "answer" });
      deltas.part({ type: "tool-input-delta", id, delta: JSON.stringify({ markdown: text }) });
    };
    answer("a1", "MRR was 412.");
    await deltas.endCall();
    deltas.part({ type: "start-step" });
    answer("a2", "MRR was ⟦q1:0:mrr⟧.");
    await deltas.close();
    expect(written.map((w) => w.answer)).toEqual([
      { callId: "a1", text: "MRR was 412." },
      { callId: "a2", text: "MRR was ⟦q1:0:mrr⟧." },
    ]);
  });

  it("holds back half a surrogate pair", async () => {
    const { deltas, written, tick } = harness();
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: "ok \ud83d" });
    tick(1000);
    deltas.part({ type: "reasoning-delta", text: "\ude00" });
    await deltas.endCall();
    expect(written.map((w) => w.thinking)).toEqual(["ok ", "😀"]);
  });

  it("caps the run's deltas, counting earlier attempts', and keeps the last ones for the answer", async () => {
    const { deltas, written, tick } = harness(MAX_DELTAS - ANSWER_RESERVE - 5);
    for (let i = 0; i < 20; i++) {
      tick(1000);
      deltas.part({ type: "reasoning-delta", text: "x" });
    }
    await settled();
    expect(written).toHaveLength(5);
    deltas.part({ type: "tool-input-start", id: "a1", toolName: "answer" });
    for (let i = 0; i < ANSWER_RESERVE + 20; i++) {
      tick(1000);
      deltas.part({ type: "tool-input-delta", id: "a1", delta: i ? "y" : '{"markdown":"y' });
    }
    await deltas.close();
    expect(written).toHaveLength(5 + ANSWER_RESERVE);
    expect(written.at(-1)?.answer?.callId).toBe("a1");
  });

  it("stops writing, never the run, when a write fails", async () => {
    let calls = 0;
    const deltas = new RunDeltas(async () => {
      calls += 1;
      throw new Error("fence lost");
    });
    deltas.part({ type: "start-step" });
    deltas.part({ type: "reasoning-delta", text: "a" });
    await deltas.endCall();
    deltas.part({ type: "start-step" });
    deltas.part({ type: "reasoning-delta", text: "b" });
    await deltas.close();
    expect(calls).toBe(1);
  });
});
