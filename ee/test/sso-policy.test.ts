// Single sign-on's rules on their own (policy.ts) and the sealed settings (sealed-adapter.ts).
import { randomBytes } from "node:crypto";
import { createOrgSealer, localKek } from "@opendash/core";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeProbe, txtCarries } from "../src/sso/dns";
import {
  callbackProviderId,
  emailDomain,
  isSessionGuardExempt,
  maxSsoAuthAgeHours,
  PROVIDER_ID_MAX,
  refuseEnforcedSession,
  ssoDnsLabel,
  trustedIdpOrigins,
} from "../src/sso/policy";
import { ssoSecretCodec } from "../src/sso/sealed-adapter";

describe("the rules", () => {
  it("fits the TXT record's label in one DNS label", () => {
    expect(ssoDnsLabel("acme-okta")).toBe("_opendash-verification-acme-okta");
    expect(PROVIDER_ID_MAX).toBe(40);
    expect(ssoDnsLabel("a".repeat(PROVIDER_ID_MAX)).length).toBe(63);
  });

  it("reads the provider from the route the router matched, never from a pattern", () => {
    expect(callbackProviderId({ path: "/sso/callback/:providerId", params: { providerId: "acme-okta" } })).toBe(
      "acme-okta",
    );
    expect(callbackProviderId({ path: "/sso/saml2/sp/acs/:providerId", params: { providerId: "acme-saml" } })).toBe(
      "acme-saml",
    );
    expect(callbackProviderId({ path: "/sso/callback/:providerId", params: { providerId: ":providerId" } })).toBeNull();
    expect(callbackProviderId({ path: "/sign-in/sso", params: { providerId: "acme-okta" } })).toBeNull();
    expect(callbackProviderId(undefined)).toBeNull();
  });

  it("treats a subdomain as a different domain", () => {
    expect(emailDomain("Maya@Acme.COM ")).toBe("acme.com");
    expect(emailDomain("sam@eu.acme.com")).not.toBe("acme.com");
  });

  it("refuses a session that isn't the enforcing provider's, or is past the age bound", () => {
    const provider = { providerId: "acme-okta", status: "active" };
    const now = new Date("2026-10-25T12:00:00Z");
    const fresh = {
      authenticationMethod: "sso",
      ssoProviderId: "acme-okta",
      authenticatedAt: new Date("2026-10-25T08:00:00Z"),
    };
    expect(refuseEnforcedSession(fresh, provider, now, 12)).toBeNull();
    expect(refuseEnforcedSession({ ...fresh, authenticationMethod: null }, provider, now, 12)).toBe("not_sso");
    expect(refuseEnforcedSession({ ...fresh, ssoProviderId: "acme-entra" }, provider, now, 12)).toBe("other_provider");
    expect(refuseEnforcedSession(fresh, { ...provider, status: "disabled" }, now, 12)).toBe("provider_inactive");
    expect(refuseEnforcedSession(fresh, provider, now, 3)).toBe("too_old");
    expect(refuseEnforcedSession({ ...fresh, authenticatedAt: null }, provider, now, 12)).toBe("too_old");
  });

  it("lets a refused session sign in again or out, and nothing else", () => {
    for (const path of [
      "/sign-in/sso",
      "/sign-out",
      "/get-session",
      "/magic-link/verify",
      "/sso/callback/:providerId",
    ]) {
      expect(isSessionGuardExempt(path)).toBe(true);
    }
    for (const path of ["/organization/list", "/api-key/create", "/organization/invite-member", "/sso/register"]) {
      expect(isSessionGuardExempt(path)).toBe(false);
    }
  });

  it("takes the session age and trusted origins from settings, refusing bad ones at once", () => {
    expect(maxSsoAuthAgeHours({})).toBe(12);
    expect(maxSsoAuthAgeHours({ OPENDASH_SSO_MAX_AUTH_AGE_HOURS: "8" })).toBe(8);
    expect(() => maxSsoAuthAgeHours({ OPENDASH_SSO_MAX_AUTH_AGE_HOURS: "-1" })).toThrow();
    expect(trustedIdpOrigins("", true)).toContain("https://graph.microsoft.com");
    expect(trustedIdpOrigins("https://login.acme.com/x", true)).toContain("https://login.acme.com");
    expect(() => trustedIdpOrigins("http://keycloak.local:8080", true)).toThrow(/https/);
    expect(trustedIdpOrigins("http://localhost:8080", false)).toContain("http://localhost:8080");
  });

  it("finds the record however a DNS provider spelled it, and says what it saw", () => {
    expect(txtCarries(["abc"], "_x", "abc")).toBe(true);
    expect(txtCarries(["_x=abc"], "_x", "abc")).toBe(true);
    expect(txtCarries(['"abc"'], "_x", "abc")).toBe(false);
    const name = "_opendash-verification-acme-okta.acme.com";
    expect(describeProbe({ authoritative: true, records: [], doubled: ["abc"] }, "acme.com", name, "abc")).toMatch(
      /added the domain/,
    );
    expect(describeProbe({ authoritative: true, records: ["other"], doubled: [] }, "acme.com", name, "abc")).toMatch(
      /acme.com's own nameservers have a TXT record/,
    );
    expect(describeProbe({ authoritative: false, records: [], doubled: [] }, "acme.com", name, "abc")).toMatch(
      /Our DNS resolver has no TXT record/,
    );
  });
});

describe("sealed settings", () => {
  let t: TestDatabase;
  const orgA = "0192f0a0-0000-7000-8000-0000000000a1";
  const orgB = "0192f0a0-0000-7000-8000-0000000000b2";
  beforeAll(async () => {
    t = await freshDatabase();
    await createOrg(t, orgA, "Acme");
    await createOrg(t, orgB, "Lumen");
    for (const org of [orgA, orgB]) {
      await t.system.client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref, state)
        values (${org}, 1, ${await kek.wrap(randomBytes(32), `org_key:${org}:1`)}, 'local:v1', 'active')`;
    }
  }, 60_000);
  afterAll(() => t?.drop());
  const kek = localKek(randomBytes(32).toString("base64"));

  it("opens only for its organization and its provider and field, and never serves a value in the clear", async () => {
    const codec = ssoSecretCodec(createOrgSealer({ kek, run: (org, fn) => withTenantOn(t.app, { orgId: org }, fn) }));
    const row = { organizationId: orgA, providerId: "acme-okta", oidcConfig: '{"clientSecret":"s3cret"}' };
    const sealed = await codec.seal(row);
    expect(String(sealed.oidcConfig)).toMatch(/^odk1\.1\./);
    expect(String(sealed.oidcConfig)).not.toContain("s3cret");
    expect((await codec.open(sealed)).oidcConfig).toBe(row.oidcConfig);
    await expect(codec.open({ ...sealed, organizationId: orgB })).rejects.toThrow();
    await expect(codec.open({ ...sealed, providerId: "acme-entra" })).rejects.toThrow();
    await expect(codec.open({ ...sealed, samlConfig: sealed.oidcConfig, oidcConfig: null })).rejects.toThrow();
    await expect(codec.open({ ...row })).rejects.toThrow(/in the clear/);
    await expect(codec.seal({ providerId: "x", oidcConfig: "{}" })).rejects.toThrow(/organization/);
  });
});
