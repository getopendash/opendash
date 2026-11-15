// Product analytics (ops/analytics.ts): nothing is sent without POSTHOG_KEY; with it, an event carries ids and fixed
// words to PostHog's EU cloud, and a server error carries its type, frames and digest, never its message. A send that
// fails or hangs is dropped, never thrown.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsAssetsHost,
  analyticsConfig,
  BUDGETS,
  raiseAlert,
  stackFrames,
  track,
  trackServerError,
} from "../src";

const ORG = "0190a000-0000-7000-8000-00000000000a";
const MAYA = "0190a000-0000-7000-8000-00000000000b";
const config = { key: "phc_test", host: "https://eu.i.posthog.com" };

const sent = (send: ReturnType<typeof vi.fn>) => {
  const [url, init] = send.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
};

describe("analytics", () => {
  it("is off without POSTHOG_KEY, and on PostHog's EU cloud by default with it", () => {
    expect(analyticsConfig({})).toBeNull();
    expect(analyticsConfig({ POSTHOG_KEY: "  " })).toBeNull();
    expect(analyticsConfig({ POSTHOG_KEY: "phc_x" })).toEqual({ key: "phc_x", host: "https://eu.i.posthog.com" });
    expect(analyticsConfig({ POSTHOG_KEY: "phc_x", POSTHOG_HOST: "https://ph.example.com/" })).toEqual({
      key: "phc_x",
      host: "https://ph.example.com",
    });
    expect(analyticsAssetsHost("https://eu.i.posthog.com")).toBe("https://eu-assets.i.posthog.com");
    expect(analyticsAssetsHost("https://ph.example.com")).toBe("https://ph.example.com");
  });

  it("sends nothing when it's off", async () => {
    const send = vi.fn();
    await track({ event: "signed_up", userId: MAYA }, { config: null, send });
    await trackServerError({ error: new Error("x") }, { config: null, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a person's event with their id and the workspace as its group, bounded by the budget", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    await track(
      { event: "dashboard_published", userId: MAYA, orgId: ORG, properties: { version: 1, first: true } },
      { config, send },
    );
    const { url, body } = sent(send);
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "dashboard_published",
      distinct_id: MAYA,
      properties: { version: 1, first: true, $groups: { workspace: ORG }, $process_person_profile: true },
    });
    const [, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(BUDGETS.analytics.sendMs).toBeLessThanOrEqual(5_000);
  });

  it("sends a workspace API key's event as the workspace, with no person made for it", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    await track({ event: "question_asked", userId: null, orgId: ORG }, { config, send });
    expect(sent(send).body).toMatchObject({
      distinct_id: `workspace:${ORG}`,
      properties: { $process_person_profile: false },
    });
  });

  it("drops an event PostHog refuses or that can't be sent, without throwing", async () => {
    await expect(
      track({ event: "signed_up", userId: MAYA }, { config, send: async () => new Response(null, { status: 401 }) }),
    ).resolves.toBeUndefined();
    await expect(
      track(
        { event: "signed_up", userId: MAYA },
        {
          config,
          send: async () => {
            throw new DOMException("timed out", "TimeoutError");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("reports a server error by type, frames, digest and route template, never its message", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const error = Object.assign(new TypeError('relation "orders" does not exist: 4242'), { digest: "123456" });
    await trackServerError({ error, route: "/dashboards/[id]", kind: "render", method: "GET" }, { config, send });
    const { body } = sent(send);
    expect(JSON.stringify(body)).not.toContain("orders");
    expect(JSON.stringify(body)).not.toContain("4242");
    expect(body.event).toBe("$exception");
    expect(body.properties).toMatchObject({
      digest: "123456",
      route: "/dashboards/[id]",
      kind: "render",
      service: "web",
    });
    const [exception] = body.properties.$exception_list;
    expect(exception).toMatchObject({ type: "TypeError", value: "", stacktrace: { type: "raw" } });
    expect(exception.stacktrace.frames.length).toBeGreaterThan(0);
  });

  it("reports what stops the worker as the worker's, and something thrown that isn't an error as one", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    await trackServerError(
      {
        error: "a string with a value 4242",
        kind: "unhandled_rejection",
        service: "worker",
        mechanism: "onunhandledrejection",
      },
      { config, send },
    );
    const { body } = sent(send);
    expect(JSON.stringify(body)).not.toContain("4242");
    expect(body.properties).toMatchObject({ service: "worker", kind: "unhandled_rejection" });
    expect(body.properties.$exception_list[0]).toMatchObject({
      type: "Error",
      mechanism: { type: "onunhandledrejection", handled: false },
    });
  });

  describe("a new alert", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    const deps = (created: boolean) => ({
      withSystem: async <T>() => [{ id: "a1", created }] as T,
      log: { error: () => {} } as never,
    });
    const alert = {
      orgId: ORG,
      kind: "dead_letter" as const,
      subject: "agent.interactive.dead",
      message: "It failed.",
    };

    it("is an alert_raised event of the workspace, with its kind and subject and never its message", async () => {
      vi.stubEnv("POSTHOG_KEY", "phc_test");
      const upstream = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", upstream);
      await raiseAlert(deps(true), alert);
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
      const { body } = sent(upstream);
      expect(body).toMatchObject({
        event: "alert_raised",
        distinct_id: `workspace:${ORG}`,
        properties: { kind: "dead_letter", subject: "agent.interactive.dead", $groups: { workspace: ORG } },
      });
      expect(JSON.stringify(body)).not.toContain("It failed.");
    });

    it("isn't sent again when the open one is only counted up, or without POSTHOG_KEY", async () => {
      const upstream = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", upstream);
      vi.stubEnv("POSTHOG_KEY", "phc_test");
      await raiseAlert(deps(false), alert);
      vi.stubEnv("POSTHOG_KEY", "");
      await raiseAlert(deps(true), alert);
      await new Promise((r) => setTimeout(r, 10));
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  it("reads V8 stack frames, oldest call first", () => {
    const frames = stackFrames(
      [
        "Error: a value 42",
        "    at load (/app/apps/web/.next/server/chunks/page.js:10:5)",
        "    at /app/node_modules/next/dist/server/render.js:200:12",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
      ].join("\n"),
    );
    expect(frames.map((f) => [f.function, f.lineno, f.in_app])).toEqual([
      ["process.processTicksAndRejections", 105, false],
      ["?", 200, false],
      ["load", 10, true],
    ]);
  });
});
