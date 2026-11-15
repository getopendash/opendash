import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { auditRetentionDays } from "@opendash/core";
import { ENTERPRISE_FEATURES } from "@opendash/core/enterprise";
import { describe, expect, it } from "vitest";
import { encodePublicKey, issueLicense, issueServiceKey, keyId, licenseGate, verifyLicense } from "../src/license";

const day = 24 * 60 * 60 * 1000;
const pair = () => generateKeyPairSync("ed25519");
const licensor = pair();
const keys = { [keyId(licensor.publicKey)]: encodePublicKey(licensor.publicKey) };
const instance = "https://opendash.acme.com";
const now = new Date("2026-10-25T12:00:00Z");

const issue = (
  overrides: Partial<Parameters<typeof issueLicense>[0]> = {},
  privateKey: KeyObject = licensor.privateKey,
) =>
  issueLicense(
    {
      licensee: "Acme Inc.",
      features: ["sso", "scim", "audit"],
      expires: new Date(now.getTime() + 365 * day),
      ...overrides,
    },
    privateKey,
    now,
  );
const gate = (env: NodeJS.ProcessEnv, at = now) => licenseGate(env, { keys, now: () => at });
const production = (key?: string) => ({ NODE_ENV: "production", BETTER_AUTH_URL: instance, OPENDASH_LICENSE_KEY: key });

describe("a license key", () => {
  it("verifies when the licensor signed it, and says what it covers", () => {
    const verified = verifyLicense(issue({ seats: 150, instance: `${instance}/settings` }), { keys, instance });
    expect(verified).toEqual({
      ok: true,
      license: {
        licensee: "Acme Inc.",
        features: ["sso", "scim", "audit"],
        seats: 150,
        expiresAt: new Date(now.getTime() + 365 * day).toISOString(),
        instance,
      },
    });
  });

  it("is refused when its payload was changed, its signer is unknown, or it's for another instance", () => {
    const key = issue();
    const [prefix, body, signature] = key.split(".");
    const payload = JSON.parse(Buffer.from(body as string, "base64url").toString());
    const changed = Buffer.from(JSON.stringify({ ...payload, licensee: "Someone else" })).toString("base64url");
    expect(verifyLicense(`${prefix}.${changed}.${signature}`, { keys, instance })).toEqual({
      ok: false,
      reason: "Its signature doesn't match.",
    });
    expect(verifyLicense(issue({}, pair().privateKey), { keys, instance })).toEqual({
      ok: false,
      reason: "It was signed by a key this version of OpenDash doesn't know.",
    });
    expect(verifyLicense(issue({ instance: "https://other.example.com" }), { keys, instance })).toEqual({
      ok: false,
      reason: "It's for another instance (https://other.example.com).",
    });
  });

  it("is refused when it isn't one at all", () => {
    for (const key of ["nope", "odl1.e30.", "odl1.%%%.abc", `odl2.${issue().slice(5)}`, "odl1.e30.AAAA"]) {
      expect(verifyLicense(key, { keys, instance })).toEqual({
        ok: false,
        reason: "It isn't an OpenDash license key.",
      });
    }
  });

  it("keeps only the features this version knows", () => {
    const key = issue({ features: ["sso", "dashboards" as never] });
    expect(verifyLicense(key, { keys, instance })).toMatchObject({ ok: true, license: { features: ["sso"] } });
  });
});

describe("the gate", () => {
  it("lets every feature be set up outside production, with or without a key, and still shows the key's verdict", () => {
    const none = gate({ NODE_ENV: "development" });
    expect(none.status()).toEqual({ state: "none" });
    expect(none.canChange("sso")).toBe(true);
    const forged = gate({ NODE_ENV: "test", OPENDASH_LICENSE_KEY: "nope" });
    expect(forged.status()).toEqual({ state: "invalid", reason: "It isn't an OpenDash license key." });
    expect(forged.canChange("scim")).toBe(true);
  });

  it("in production, lets a feature be set up only with a valid key that covers it", () => {
    expect(gate(production()).canChange("sso")).toBe(false);
    expect(gate(production("nope")).canChange("sso")).toBe(false);
    const sso = gate(production(issue({ features: ["sso"] })));
    expect(sso.status()).toMatchObject({ state: "valid", expiresSoon: false });
    expect(sso.canChange("sso")).toBe(true);
    expect(sso.canChange("scim")).toBe(false);
  });

  it("reads the expiry each time: soon within 30 days, then expired, and changes stop", () => {
    const key = issue({ expires: new Date(now.getTime() + 40 * day) });
    let at = now;
    const g = licenseGate(production(key), { keys, now: () => at });
    expect(g.status()).toMatchObject({ state: "valid", expiresSoon: false });
    at = new Date(now.getTime() + 20 * day);
    expect(g.status()).toMatchObject({ state: "valid", expiresSoon: true });
    expect(g.canChange("audit")).toBe(true);
    at = new Date(now.getTime() + 41 * day);
    expect(g.status()).toMatchObject({ state: "expired", license: { licensee: "Acme Inc." } });
    expect(g.canChange("audit")).toBe(false);
  });

  it("refuses a key for another instance by the instance's address", () => {
    const g = gate({
      ...production(issue({ instance: "https://opendash.acme.com" })),
      BETTER_AUTH_URL: "https://x.example",
    });
    expect(g.status()).toEqual({ state: "invalid", reason: "It's for another instance (https://opendash.acme.com)." });
  });
});

/** A key the licensor signed over any payload: what a tampered or hand-made key would be, signed for real. */
const signedOver = (payload: Record<string, unknown>) => {
  const body = `odl1.${Buffer.from(JSON.stringify({ kid: keyId(licensor.publicKey), ...payload })).toString("base64url")}`;
  return `${body}.${sign(null, Buffer.from(body), licensor.privateKey).toString("base64url")}`;
};

describe("the service key", () => {
  const service = () => issueServiceKey("OpenDash Cloud", licensor.privateKey, now);

  it("verifies as the licensor's service, with no expiry, seats or instance", () => {
    expect(verifyLicense(service(), { keys, instance })).toEqual({ ok: true, service: { licensee: "OpenDash Cloud" } });
  });

  it("lets every feature be set up in production, on any address, years later", () => {
    const g = licenseGate(
      { NODE_ENV: "production", BETTER_AUTH_URL: "https://app.example.com", OPENDASH_LICENSE_KEY: service() },
      { keys, now: () => new Date(now.getTime() + 20 * 365 * day) },
    );
    expect(g.status()).toEqual({ state: "service", licensee: "OpenDash Cloud" });
    for (const feature of ENTERPRISE_FEATURES) expect(g.canChange(feature)).toBe(true);
    expect(auditRetentionDays(g, "2000")).toBe(2000);
    expect(auditRetentionDays(g, undefined)).toBe(90);
  });

  it("is refused when another key signed it, or it mixes in a license's terms", () => {
    expect(verifyLicense(issueServiceKey("OpenDash Cloud", pair().privateKey, now), { keys, instance })).toEqual({
      ok: false,
      reason: "It was signed by a key this version of OpenDash doesn't know.",
    });
    const issued = now.toISOString();
    for (const extra of [{ expires: issued }, { instance }, { seats: 5 }, { features: ["sso"] }]) {
      const key = signedOver({ licensee: "OpenDash Cloud", service: true, issued, ...extra });
      expect(verifyLicense(key, { keys, instance })).toEqual({
        ok: false,
        reason: "It isn't an OpenDash license key.",
      });
    }
    const notTrue = signedOver({ licensee: "x", service: "yes", issued, expires: issued, features: [] });
    expect(verifyLicense(notTrue, { keys, instance })).toEqual({
      ok: false,
      reason: "It isn't an OpenDash license key.",
    });
  });

  it("is refused when a key's payload is turned into a service key, keeping a trusted signer's signature", () => {
    const issued = now.toISOString();
    const swap = (key: string, payload: Record<string, unknown>) => {
      const [prefix, , signature] = key.split(".");
      const body = Buffer.from(JSON.stringify({ kid: keyId(licensor.publicKey), ...payload })).toString("base64url");
      return `${prefix}.${body}.${signature}`;
    };
    for (const key of [issue(), service()]) {
      const forged = swap(key, { licensee: "Someone else", service: true, issued });
      expect(verifyLicense(forged, { keys, instance })).toEqual({ ok: false, reason: "Its signature doesn't match." });
      expect(licenseGate({ NODE_ENV: "production", OPENDASH_LICENSE_KEY: forged }, { keys }).canChange("sso")).toBe(
        false,
      );
    }
  });

  it("refuses to be issued without a name", () => {
    expect(() => issueServiceKey(" ", licensor.privateKey)).toThrow(/names its service/);
  });
});

describe("issuing", () => {
  it("refuses a license without a licensee, an expiry, or a web address for its instance", () => {
    expect(() => issue({ licensee: " " })).toThrow(/licensee/);
    expect(() => issue({ expires: new Date("nope") })).toThrow(/expiry/);
    expect(() => issue({ instance: "not a url" })).toThrow(/web address/);
  });
});
