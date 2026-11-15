/**
 * Single sign-on: OIDC and SAML 2.0 identity providers per workspace, with a lifecycle (draft, verified by DNS,
 * active after a test sign-in, then enforced by domain) and Disable as the way back in. Built on `@better-auth/sso`;
 * the auth server gets it through `auth`, the settings page through `manage`.
 */
import type { AuthAudit, AuthExtension } from "@opendash/auth";
import type { OrgSealer } from "@opendash/core";
import type { Enterprise, EnterpriseSso } from "@opendash/core/enterprise";
import type { SystemTx, TenantTx } from "@opendash/db";
import type { AuthDatabase } from "@opendash/db/auth";
import type { TxtLookup } from "./dns";
import { ssoManager } from "./manage";
import { ssoAuthExtension } from "./plugin";

export interface SingleSignOnDeps {
  database: AuthDatabase;
  sealer: OrgSealer;
  /** BETTER_AUTH_URL's origin. */
  origin: string;
  /** The auth server, for the plugin's own endpoints (made lazily: the server is made with this extension). */
  auth: () => { api: unknown };
  tenant: <T>(ctx: { orgId: string; userId: string }, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  system: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  gate: () => Pick<Enterprise, "canChange">;
  /** Tests: DNS as the domain's nameservers would answer. */
  dns?: TxtLookup;
}

export function singleSignOn(deps: SingleSignOnDeps): {
  auth: (core: { audit: AuthAudit }) => AuthExtension;
  manage: EnterpriseSso;
} {
  return {
    auth: ssoAuthExtension({ database: deps.database, sealer: deps.sealer, appOrigin: deps.origin }),
    manage: ssoManager(deps),
  };
}

export { disableProvider } from "./manage";
export { PROVIDER_ID_MAX, SSO_DNS_TOKEN_PREFIX, ssoDnsLabel } from "./policy";
export { forgetProviderCaches } from "./store";
