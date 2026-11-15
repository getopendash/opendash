import { type SQL, sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";
import { appRole, systemRole } from "./roles";

/**
 * The two policies every tenant table carries:
 *   tenant: opendash_app sees only rows of app.org_id() (and, for personal scope, only its own);
 *   system: opendash_system sees everything, through an explicit policy instead of BYPASSRLS.
 * The (select app.org_id()) wrapper makes Postgres evaluate it once per statement (an initplan).
 */
export function tenantPolicies(options: { orgColumn?: "org_id" | "id"; personalScope?: boolean } = {}) {
  const orgColumn = sql.raw(options.orgColumn ?? "org_id");
  const sameOrg: SQL = sql`${orgColumn} = (select app.org_id())`;
  const visible: SQL = options.personalScope
    ? sql`${sameOrg} and (scope <> 'personal' or scope_id = (select app.user_id()))`
    : sameOrg;
  return [
    // WITH CHECK uses the same predicate as USING: a user can't write a personal row owned by someone else.
    pgPolicy("tenant", { as: "permissive", for: "all", to: appRole, using: visible, withCheck: visible }),
    pgPolicy("system", { as: "permissive", for: "all", to: systemRole, using: sql`true`, withCheck: sql`true` }),
  ];
}
