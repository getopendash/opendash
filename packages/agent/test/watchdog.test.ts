// The model call's own watchdog: a provider's fetch whose response must start, and keep streaming,
// within its limits. Only the call is timed: nothing runs while no request is open, so a step's tools can take their time.
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { ModelStalled, watchedFetch } from "../src/harness/model";
import { readModelError } from "../src/harness/model-errors";

const limits = { firstByteMs: 60, idleMs: 60 };
const enc = new TextEncoder();

/** A fake provider: its response's chunks, each after its delay; a negative delay never comes. */
const provider =
  (delays: number[]): typeof fetch =>
  async (_input, init) => {
    const signal = init?.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const [i, ms] of delays.entries()) {
          if (ms < 0) return;
          await new Promise((r) => setTimeout(r, ms));
          if (signal.aborted) return;
          controller.enqueue(enc.encode(`c${i};`));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };

const readAll = async (res: Response) => await res.text();

describe("a model call's watchdog", () => {
  it("lets a healthy stream through, however long it runs", async () => {
    const res = await watchedFetch(provider([10, 30, 30, 30, 30]), limits)("https://model", {});
    expect(await readAll(res)).toBe("c0;c1;c2;c3;c4;");
  });

  it("stops a response that never starts", async () => {
    const never: typeof fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    await expect(watchedFetch(never, limits)("https://model", {})).rejects.toBeInstanceOf(ModelStalled);
  });

  it("stops a stream that goes quiet", async () => {
    const res = await watchedFetch(provider([10, 20, -1]), limits)("https://model", {});
    await expect(readAll(res)).rejects.toBeInstanceOf(ModelStalled);
  });

  it("leaves the caller's own abort as it is", async () => {
    const ctl = new AbortController();
    const never: typeof fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const pending = watchedFetch(never, { firstByteMs: 5_000, idleMs: 5_000 })("https://model", { signal: ctl.signal });
    ctl.abort(new Error("stopped by the run"));
    await expect(pending).rejects.toThrow("stopped by the run");
  });
});

describe("through a provider", () => {
  it("a stream that goes quiet ends the call as stalled, which the job retries", async () => {
    // Anthropic's stream starts, then goes quiet.
    const sse: typeof fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            ),
          );
          signal.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const anthropic = createAnthropic({ apiKey: "test", fetch: watchedFetch(sse, limits) });
    const result = streamText({ model: anthropic("claude-test"), prompt: "Hello", maxRetries: 0 });
    // The provider wraps the stalled stream ("Failed to process successful response"), as a part or a throw; the
    // run's loop handles both, and the watchdog's error is still in what it wraps.
    let failure: unknown = null;
    try {
      for await (const part of result.fullStream) if (part.type === "error") failure = part.error;
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBeNull();
    expect(readModelError(failure).kind).toBe("stalled");
  });
});
