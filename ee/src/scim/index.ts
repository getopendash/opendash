/**
 * Directory sync: a workspace's identity provider adds, changes and removes its people over SCIM 2.0, only at the
 * workspace's verified single sign-on domains, with roles from its groups. Built on `@better-auth/scim`; the auth
 * server gets it through `auth`, the settings page through `manage`.
 */
import type { AuthCore, AuthExtension } from "@opendash/auth";
import type { Enterprise, EnterpriseScim } from "@opendash/core/enterprise";
import type { TenantTx } from "@opendash/db";
import type { AuthDatabase } from "@opendash/db/auth";
import { scimManager } from "./manage";
import { scimAuthExtension } from "./plugin";

export interface DirectorySyncDeps {
  database: AuthDatabase;
  /** BETTER_AUTH_URL's origin: the directory calls `<origin>/api/auth/scim/v2`. */
  origin: string;
  auth: () => { api: unknown };
  tenant: <T>(ctx: { orgId: string; userId: string }, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  gate: () => Pick<Enterprise, "canChange">;
}

export function directorySync(deps: DirectorySyncDeps): {
  auth: (core: AuthCore) => AuthExtension;
  manage: EnterpriseScim;
} {
  return { auth: scimAuthExtension({ database: deps.database }), manage: scimManager(deps) };
}
