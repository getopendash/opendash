import "server-only";
import { authBaseUrl, combineExtensions, getAuthDatabase } from "@opendash/auth";
import { createOrgSealer, kekFromEnv } from "@opendash/core";
import type { Enterprise } from "@opendash/core/enterprise";
import { withSystem, withTenant } from "@opendash/db";
import { auditChain } from "@opendash/ee/audit";
import { licenseGate } from "@opendash/ee/license";
import { directorySync } from "@opendash/ee/scim";
import { singleSignOn } from "@opendash/ee/sso";

let gate: Enterprise | undefined;
let sso: ReturnType<typeof singleSignOn> | undefined;
let scim: ReturnType<typeof directorySync> | undefined;
let authServer: (() => { api: unknown }) | undefined;

const authServerOf = () => {
  if (!authServer) throw new Error("The auth server isn't made yet");
  return authServer();
};

/** Directory sync, made on first use. */
function directorySyncOf() {
  scim ??= directorySync({
    database: getAuthDatabase(),
    origin: new URL(authBaseUrl()).origin,
    auth: authServerOf,
    tenant: (ctx, fn) => withTenant(ctx, fn),
    gate: () => enterprise(),
  });
  return scim;
}

/** Single sign-on, made on first use (after the server has read its settings). */
function singleSignOnOf() {
  sso ??= singleSignOn({
    database: getAuthDatabase(),
    sealer: createOrgSealer({ kek: kekFromEnv, run: (orgId, fn) => withTenant({ orgId }, fn) }),
    origin: new URL(authBaseUrl()).origin,
    auth: authServerOf,
    tenant: (ctx, fn) => withTenant(ctx, fn),
    system: withSystem,
    gate: () => enterprise(),
  });
  return sso;
}

/**
 * The enterprise features this build carries and the license that unlocks them. The key is checked once, the first time
 * it's asked, so after the server has read its settings. The only file in the web app that imports ee/ (lint enforces
 * it): a build without ee/ returns `communityEdition(process.env.NODE_ENV === "production")` from
 * @opendash/core/enterprise here instead, and `enterpriseAuth` returns undefined.
 */
export const enterprise = (): Enterprise => {
  gate ??= { ...licenseGate(), audit: auditChain(), sso: singleSignOnOf().manage, scim: directorySyncOf().manage };
  return gate;
};

/**
 * Whether people here see licensing at all: the License page, "Enterprise" badges, what a key would unlock. Not on the
 * licensor's own service (a service key), where there's nothing for them to act on.
 */
export const licensingShown = (): boolean => enterprise().status().state !== "service";

/**
 * What this build adds to the auth server (single sign-on and directory sync); `server` is that server, for the
 * plugins' own in-process calls.
 */
export function enterpriseAuth(server: () => { api: unknown }) {
  authServer = server;
  return combineExtensions(singleSignOnOf().auth, directorySyncOf().auth);
}
