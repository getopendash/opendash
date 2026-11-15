/**
 * The license gate: a key of our own, `odl1.<payload>.<signature>`, signed with Ed25519 by the licensor and verified
 * offline against the public keys in keys.ts, so an instance without internet access works. The signature covers
 * `odl1.<payload>`; the payload names the key that signed it (`kid`).
 *
 * Two kinds: a customer's license (features, an expiry, optionally seats and an instance), and the service key the
 * licensor signs once for its own service (`service: true`, nothing else): no expiry to renew and no address to move.
 */
import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import {
  ENTERPRISE_FEATURES,
  type Enterprise,
  type EnterpriseFeature,
  type License,
  type LicenseStatus,
} from "@opendash/core/enterprise";
import { ISSUER_KEYS } from "./keys";

const PREFIX = "odl1";
/** Owners are told from this long before a key expires. */
const EXPIRES_SOON_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_A_KEY = "It isn't an OpenDash license key.";

interface LicensePayload {
  kid: string;
  licensee: string;
  features: string[];
  seats?: number;
  expires: string;
  instance?: string;
  issued: string;
}

interface ServicePayload {
  kid: string;
  licensee: string;
  service: true;
  issued: string;
}

type Payload = LicensePayload | ServicePayload;

/** A public key's id: the first 16 hex digits of its SPKI's SHA-256, so the licensor and every instance agree. */
export function keyId(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);
}

/** A public key as keys.ts holds it: its SPKI, in base64. */
export const encodePublicKey = (publicKey: KeyObject): string =>
  publicKey.export({ type: "spki", format: "der" }).toString("base64");

const isFeature = (name: string): name is EnterpriseFeature =>
  (ENTERPRISE_FEATURES as readonly string[]).includes(name);

const originOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export interface LicenseTerms {
  licensee: string;
  features: EnterpriseFeature[];
  expires: Date;
  seats?: number;
  /** The instance's address; only its origin is kept. */
  instance?: string;
}

/** Signs a license with the licensor's Ed25519 private key. */
export function issueLicense(terms: LicenseTerms, privateKey: KeyObject, issued = new Date()): string {
  if (!terms.licensee.trim()) throw new Error("A license names its licensee.");
  if (Number.isNaN(terms.expires.getTime())) throw new Error("A license has an expiry date.");
  const instance = terms.instance === undefined ? null : originOf(terms.instance);
  if (terms.instance !== undefined && !instance) throw new Error("The instance must be a web address.");
  const payload: LicensePayload = {
    kid: keyId(createPublicKey(privateKey)),
    licensee: terms.licensee.trim(),
    features: [...new Set(terms.features)],
    ...(terms.seats ? { seats: terms.seats } : {}),
    expires: terms.expires.toISOString(),
    ...(instance ? { instance } : {}),
    issued: issued.toISOString(),
  };
  return signedKey(payload, privateKey);
}

/** Signs the service key for the licensor's own service: every feature, no expiry, no address. */
export function issueServiceKey(licensee: string, privateKey: KeyObject, issued = new Date()): string {
  if (!licensee.trim()) throw new Error("A service key names its service.");
  const payload: ServicePayload = {
    kid: keyId(createPublicKey(privateKey)),
    licensee: licensee.trim(),
    service: true,
    issued: issued.toISOString(),
  };
  return signedKey(payload, privateKey);
}

function signedKey(payload: Payload, privateKey: KeyObject): string {
  const signed = `${PREFIX}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
}

function payloadOf(value: unknown): Payload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 500;
  const date = (v: unknown) => text(v) && !Number.isNaN(Date.parse(v as string));
  if (!text(p.kid) || !text(p.licensee) || !date(p.issued)) return null;
  if (p.service !== undefined) {
    // A service key carries nothing else: a key mixing both kinds isn't one the licensor issues.
    const only = Object.keys(p).every((k) => ["kid", "licensee", "service", "issued"].includes(k));
    return p.service === true && only ? (p as unknown as ServicePayload) : null;
  }
  if (!date(p.expires)) return null;
  if (!Array.isArray(p.features) || !p.features.every((f) => typeof f === "string")) return null;
  if (p.seats !== undefined && !(Number.isInteger(p.seats) && (p.seats as number) > 0)) return null;
  if (p.instance !== undefined && !(text(p.instance) && originOf(p.instance as string) === p.instance)) return null;
  return p as unknown as LicensePayload;
}

export type Verified =
  | { ok: true; license: License }
  | { ok: true; service: { licensee: string } }
  | { ok: false; reason: string };

/**
 * Checks a key's form, its signer and signature, and its instance. Its expiry isn't checked here: an instance
 * that runs past it reads it each time it's asked (licenseGate's status).
 */
export function verifyLicense(
  key: string,
  options: { keys: Readonly<Record<string, string>>; instance: string | null },
): Verified {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: NOT_A_KEY };
  const [, body, signature] = parts as [string, string, string];
  let payload: Payload | null;
  try {
    payload = payloadOf(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    payload = null;
  }
  if (!payload) return { ok: false, reason: NOT_A_KEY };
  const spki = options.keys[payload.kid];
  if (!spki) return { ok: false, reason: "It was signed by a key this version of OpenDash doesn't know." };
  let signed = false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    signed = verify(null, Buffer.from(`${PREFIX}.${body}`), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, reason: "Its signature doesn't match." };
  if ("service" in payload) return { ok: true, service: { licensee: payload.licensee } };
  if (payload.instance && payload.instance !== options.instance) {
    return { ok: false, reason: `It's for another instance (${payload.instance}).` };
  }
  return {
    ok: true,
    license: {
      licensee: payload.licensee,
      features: payload.features.filter(isFeature),
      seats: payload.seats ?? null,
      expiresAt: new Date(payload.expires).toISOString(),
      instance: payload.instance ?? null,
    },
  };
}

/**
 * The gate for this process, from its settings: OPENDASH_LICENSE_KEY, NODE_ENV, and BETTER_AUTH_URL (the instance's
 * address, which a key for one instance must match). The key's signature is checked once, here.
 */
export function licenseGate(
  env: NodeJS.ProcessEnv = process.env,
  options: { keys?: Readonly<Record<string, string>>; now?: () => Date } = {},
): Enterprise {
  const production = env.NODE_ENV === "production";
  const key = env.OPENDASH_LICENSE_KEY?.trim();
  const verified = key
    ? verifyLicense(key, { keys: options.keys ?? ISSUER_KEYS, instance: originOf(env.BETTER_AUTH_URL) })
    : null;
  const now = options.now ?? (() => new Date());
  const status = (): LicenseStatus => {
    if (!verified) return { state: "none" };
    if (!verified.ok) return { state: "invalid", reason: verified.reason };
    if ("service" in verified) return { state: "service", licensee: verified.service.licensee };
    const left = Date.parse(verified.license.expiresAt) - now().getTime();
    if (left <= 0) return { state: "expired", license: verified.license };
    return { state: "valid", license: verified.license, expiresSoon: left <= EXPIRES_SOON_MS };
  };
  return {
    production,
    status,
    canChange(feature) {
      if (!production) return true;
      const s = status();
      return s.state === "service" || (s.state === "valid" && s.license.features.includes(feature));
    },
  };
}
