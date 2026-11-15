// Every page and route says the same safe things to the browser: never framed by another site, no type sniffing, no
// device access, no full URL sent onward; HTTPS only once deployed. Every page frames only the frames origin (a page
// reached by moving within the app keeps the first page's policy), read on each request so a built image works on any
// address.
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { framesOriginOf, pagePolicy } from "../lib/frames-origin";
import { proxy } from "../proxy";

const headersFor = async (env: string) => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env);
  const { default: config } = await import("../next.config");
  const rules = (await config.headers?.()) ?? [];
  vi.unstubAllEnvs();
  return rules;
};

describe("security headers", () => {
  it("are sent on every route, with HSTS only in production", async () => {
    const dev = await headersFor("development");
    // Every route but a dashboard's frame (/app-frame/…), which sets its own policy (only OpenDash's page may show it).
    const SITE = "/:path((?!app-frame/).*)";
    const all = dev.find((r) => r.source === SITE);
    const sent = Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
    expect(sent).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    expect(sent["Strict-Transport-Security"]).toBeUndefined();
    // A page's content policy isn't fixed when the app is built (the proxy sends it); only the API's, which the proxy
    // doesn't see, is: its pages frame nothing.
    const fixed = dev.filter((r) => r.headers.some((h) => h.key === "Content-Security-Policy"));
    expect(fixed.map((r) => [r.source, r.headers.find((h) => h.key === "Content-Security-Policy")?.value])).toEqual([
      ["/api/:path*", "frame-ancestors 'none'; frame-src 'none'"],
    ]);

    const prod = (await headersFor("production")).find((r) => r.source === SITE);
    expect(prod?.headers.find((h) => h.key === "Strict-Transport-Security")?.value).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("the frames origin", () => {
  it("is OPENDASH_FRAMES_URL's origin, the other loopback name in development, and none in production without it", () => {
    expect(framesOriginOf({ NODE_ENV: "production", OPENDASH_FRAMES_URL: "https://frames.example.com/x" })).toBe(
      "https://frames.example.com",
    );
    expect(framesOriginOf({ NODE_ENV: "production", BETTER_AUTH_URL: "https://app.example.com" })).toBeNull();
    expect(framesOriginOf({ NODE_ENV: "development" })).toBe("http://127.0.0.1:3000");
    expect(framesOriginOf({ NODE_ENV: "development", BETTER_AUTH_URL: "http://127.0.0.1:3000" })).toBe(
      "http://localhost:3000",
    );
    expect(framesOriginOf({ NODE_ENV: "development", BETTER_AUTH_URL: "https://app.example.com" })).toBeNull();
    expect(framesOriginOf({ NODE_ENV: "production", OPENDASH_FRAMES_URL: "not a url" })).toBeNull();
  });
});

describe("every page's content policy", () => {
  it("frames only the frames origin, or nothing when there's none", () => {
    expect(pagePolicy({ NODE_ENV: "production", OPENDASH_FRAMES_URL: "https://frames.example.com" })).toBe(
      "frame-ancestors 'none'; frame-src https://frames.example.com",
    );
    expect(pagePolicy({ NODE_ENV: "production" })).toBe("frame-ancestors 'none'; frame-src 'none'");
  });

  it("is sent by the proxy as the server is set now, on pages and redirects, never on a dashboard's frame", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENDASH_FRAMES_URL", "https://frames.example.com");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.com");
    vi.stubEnv("OPENDASH_OLD_HOSTS", "go.example.com");
    const policy = (url: string) =>
      proxy(new NextRequest(url, { headers: { host: new URL(url).host } })).headers.get("Content-Security-Policy");
    expect(policy("https://app.example.com/dashboards/1")).toBe(
      "frame-ancestors 'none'; frame-src https://frames.example.com",
    );
    expect(policy("https://go.example.com/dashboards/1")).toBe(
      "frame-ancestors 'none'; frame-src https://frames.example.com",
    );
    expect(policy("https://frames.example.com/app-frame/f/token")).toBeNull();
    vi.stubEnv("OPENDASH_FRAMES_URL", "https://frames.other.example");
    expect(policy("https://app.example.com/")).toBe("frame-ancestors 'none'; frame-src https://frames.other.example");
    vi.unstubAllEnvs();
  });
});
