// combineExtensions (extension.ts): several enterprise extensions handed to createAuth as one.
import { describe, expect, it } from "vitest";
import type { AuthAudit } from "../src/audit";
import { type AuthCore, combineExtensions } from "../src/extension";

const core: AuthCore = {
  audit: {} as AuthAudit,
  deriveSecret: (purpose) => `key-for-${purpose}`,
  memberRemoved: async () => {},
};

describe("combineExtensions", () => {
  it("asks each extension's voucher in turn, and the first that answers for its own request decides", async () => {
    const asked: string[] = [];
    const combined = combineExtensions(
      {
        vouchForNewUser: async (_user, context) => {
          asked.push("sso");
          return (context as { path?: string }).path === "/sso/callback/:providerId" ? { emailVerified: true } : null;
        },
      },
      () => ({
        vouchForNewUser: async (_user, context) => {
          asked.push("scim");
          return (context as { path?: string }).path === "/scim/v2/Users" ? { emailVerified: true, via: "scim" } : null;
        },
      }),
    )(core);
    expect(await combined.vouchForNewUser?.({ email: "a@acme.test" }, { path: "/sso/callback/:providerId" })).toEqual({
      emailVerified: true,
    });
    expect(asked).toEqual(["sso"]);
    expect(await combined.vouchForNewUser?.({ email: "a@acme.test" }, { path: "/scim/v2/Users" })).toEqual({
      emailVerified: true,
      via: "scim",
    });
    expect(await combined.vouchForNewUser?.({ email: "a@acme.test" }, { path: "/magic-link/verify" })).toBeNull();
  });

  it("joins plugins, paths and origins, wraps adapters in order, and refuses two rate limits for one pattern", async () => {
    const order: string[] = [];
    const combined = combineExtensions(
      {
        disabledPaths: ["/sso/register"],
        trustedOrigins: async () => ["https://idp.acme.test"],
        rateLimitRules: { "/sso/*": { window: 60, max: 10 } },
        adapter: (f) => {
          order.push("first");
          return f;
        },
      },
      {
        disabledPaths: ["/scim/x"],
        trustedOrigins: async () => ["https://dir.acme.test"],
        rateLimitRules: { "/scim/v2/*": { window: 60, max: 600 } },
        adapter: (f) => {
          order.push("second");
          return f;
        },
      },
    )(core);
    expect(combined.disabledPaths).toEqual(["/sso/register", "/scim/x"]);
    expect(await combined.trustedOrigins?.(undefined)).toEqual(["https://idp.acme.test", "https://dir.acme.test"]);
    expect(Object.keys(combined.rateLimitRules ?? {})).toEqual(["/sso/*", "/scim/v2/*"]);
    combined.adapter?.((() => ({})) as never);
    expect(order).toEqual(["first", "second"]);
    expect(() =>
      combineExtensions(
        { rateLimitRules: { "/scim/v2/*": { window: 60, max: 1 } } },
        { rateLimitRules: { "/scim/v2/*": { window: 60, max: 2 } } },
      )(core),
    ).toThrow(/rate limit/);
  });
});
