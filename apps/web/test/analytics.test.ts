// Product analytics in the web app: the /ingest relay is there only with POSTHOG_KEY, passes on the body and what
// describes it (never cookies or the person's address), stays on PostHog's hosts and refuses a body past its budget;
// and every browser event loses its URLs' queries, its page title and any error message before it's sent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrub } from "../components/shell/analytics";

const route = await import("../app/ingest/[...path]/route");
const params = (...path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the /ingest relay", () => {
  it("isn't there without POSTHOG_KEY", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("POSTHOG_KEY", "");
    const res = await route.POST(
      new Request("http://localhost:3000/ingest/i/v0/e", { method: "POST" }),
      params("i", "v0", "e"),
    );
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("relays an event batch to PostHog's EU cloud with its body and type, and nothing of the person's", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const upstream = vi.fn(
      async () => new Response('{"status":"Ok"}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", upstream);
    const res = await route.POST(
      new Request("http://localhost:3000/ingest/i/v0/e?compression=gzip-js&ver=1", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          cookie: "better-auth.session_token=secret",
          "x-forwarded-for": "203.0.113.7",
        },
        body: "batch",
      }),
      params("i", "v0", "e"),
    );
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e?compression=gzip-js&ver=1");
    const sent = new Headers(init.headers);
    expect(sent.get("content-type")).toBe("text/plain");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("batch");
  });

  it("fetches PostHog's scripts from its assets host", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const upstream = vi.fn(async () => new Response("js", { headers: { "content-type": "application/javascript" } }));
    vi.stubGlobal("fetch", upstream);
    await route.GET(
      new Request("http://localhost:3000/ingest/static/web-vitals.js"),
      params("static", "web-vitals.js"),
    );
    expect(upstream).toHaveBeenCalledWith("https://eu-assets.i.posthog.com/static/web-vitals.js", expect.anything());
  });

  it("stays on PostHog's host, and refuses a body past its budget", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const climbing = await route.GET(new Request("http://localhost:3000/ingest/x"), params("..", "admin"));
    expect(climbing.status).toBe(404);
    const big = await route.POST(
      new Request("http://localhost:3000/ingest/i/v0/e", { method: "POST", body: "x".repeat(1_000_001) }),
      params("i", "v0", "e"),
    );
    expect(big.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("a browser event", () => {
  it("keeps URLs without their query or fragment, and no page title or error message", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://opendash.example.com/ask/new?q=revenue%20by%20region#top",
      $referrer: "https://opendash.example.com/unsubscribe?t=token",
      $pathname: "/ask/new",
      title: "Weekly revenue review · OpenDash",
      $exception_list: [{ type: "SyntaxError", value: 'Unexpected token, "4242" is not valid JSON' }],
    };
    scrub(properties);
    expect(properties).toEqual({
      $current_url: "https://opendash.example.com/ask/new",
      $referrer: "https://opendash.example.com/unsubscribe",
      $pathname: "/ask/new",
      $exception_list: [{ type: "SyntaxError", value: "" }],
    });
  });
});
