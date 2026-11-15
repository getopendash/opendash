// The routes anyone can reach without signing in, with the database stood in. An unsubscribe link (RFC 8058) stops
// only the email its signed token names: from a mail client's button with the token in the address, or the page's
// small form, which comes back to say so; a token that isn't ours stops nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");

const core = vi.hoisted(() => ({
  applyUnsubscribe: vi.fn(async () => true),
}));

vi.mock("@opendash/core", async (actual) => ({ ...(await actual<object>()), ...core }));
vi.mock("@opendash/db", async (actual) => ({
  ...(await actual<object>()),
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

const { unsubscribeToken } = await import("@opendash/core");
const unsubscribe = await import("../app/api/unsubscribe/route");

const ORG = "0190a000-0000-7000-8000-00000000000a";
const MAYA = "0190a000-0000-7000-8000-00000000000b";
const ROUTINE = "0190a000-0000-7000-8000-00000000000c";

const _post = (url: string, body: unknown) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
    body: text,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an unsubscribe link", () => {
  const target = { orgId: ORG, userId: MAYA, routineId: ROUTINE };
  const token = unsubscribeToken("test-secret-test-secret-test-secret-1234", target);

  it("stops the one email its token names, from a mail client's one-click button", async () => {
    const res = await unsubscribe.POST(
      new Request(`http://localhost:3000/api/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(core.applyUnsubscribe).toHaveBeenCalledWith(expect.anything(), target);
  });

  it("stops nothing for a token that isn't ours, or a form that's too big to read", async () => {
    const forged = `${token.split(".")[0]}.AAAA`;
    const bad = await unsubscribe.POST(
      new Request(`http://localhost:3000/api/unsubscribe?t=${encodeURIComponent(forged)}`, { method: "POST" }),
    );
    expect(bad.status).toBe(400);
    const big = await unsubscribe.POST(
      new Request("http://localhost:3000/api/unsubscribe", {
        method: "POST",
        headers: { "content-length": "100000" },
        body: "x",
      }),
    );
    expect(big.status).toBe(400);
    expect(core.applyUnsubscribe).not.toHaveBeenCalled();
  });

  it("brings the page's own form back to say it's done", async () => {
    const form = new URLSearchParams({ t: token, from: "page" }).toString();
    const res = await unsubscribe.POST(
      new Request("http://localhost:3000/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(form.length) },
        body: form,
      }),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/unsubscribe");
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("done")).toBe("1");
    expect(core.applyUnsubscribe).toHaveBeenCalledWith(expect.anything(), target);
  });
});
