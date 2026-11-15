/**
 * The link that opens a dashboard's frame. The frames origin serves frames without a session (it's another site, so
 * the browser sends it no OpenDash cookie), so the page that may show the dashboard signs what the frame needs: the
 * bundle's hash and the dashboard's title, until a time. Nothing in it is secret; the signature stops anyone making frames for
 * bundles they were never shown.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { BUDGETS } from "../budgets";

export interface FrameClaims {
  /** The App's bundle's sha256, hex; empty before its code is built. */
  h: string;
  /** The dashboard's title, for the frame document's own. */
  t: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}

const keyOf = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "", "opendash dashboard frame v1", 32));
const sign = (secret: string, payload: string) =>
  createHmac("sha256", keyOf(secret)).update(payload).digest("base64url");

export function signFrameToken(
  secret: string,
  input: { bundleHash: string | null; title: string },
  now = Date.now(),
): string {
  const claims: FrameClaims = {
    h: input.bundleHash ?? "",
    t: input.title.slice(0, 120),
    e: Math.floor(now / 1000) + BUDGETS.dashboards.frameSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** The claims of a frame link this server signed and that hasn't expired; null for anything else. */
export function readFrameToken(secret: string, token: string, now = Date.now()): FrameClaims | null {
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined || token.length > 1_000) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FrameClaims;
    if (typeof claims.h !== "string" || !/^([0-9a-f]{64})?$/.test(claims.h)) return null;
    if (typeof claims.t !== "string" || typeof claims.e !== "number" || claims.e * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}
