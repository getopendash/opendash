import { dekAad, generateDek, type Kek } from "@opendash/core";
import { type SystemTx, withSystem } from "@opendash/db";
import { type AuthDatabase, authTables } from "@opendash/db/auth";
import { sql } from "drizzle-orm";

export type SystemRunner = <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;

/**
 * Creates the product-side rows for a new organization, idempotently:
 *   app.org (id = auth.organization.id) and org_key version 1, a fresh DEK wrapped by the KEK.
 * Called from the organization plugin's afterCreateOrganization hook, and by provisionMissingOrgs.
 */
export async function provisionOrg(
  input: { orgId: string; name: string },
  deps: { kek: Kek; system?: SystemRunner },
): Promise<void> {
  const system = deps.system ?? withSystem;
  const wrapped = await deps.kek.wrap(generateDek(), dekAad(input.orgId, 1));
  await system(async (tx) => {
    await tx.execute(
      sql`insert into app.org (id, name) values (${input.orgId}, ${input.name}) on conflict (id) do nothing`,
    );
    await tx.execute(
      sql`insert into app.org_key (org_id, version, wrapped_dek, kek_ref)
          values (${input.orgId}, 1, ${wrapped}, ${deps.kek.ref}) on conflict (org_id, version) do nothing`,
    );
  });
}

/**
 * Finishes setting up organizations that exist in Better Auth but have no app.org row, for example one created
 * before failed setups were undone. Idempotent: run it as often as you like (`pnpm auth:repair`). Returns the slugs
 * it set up. Reads auth tables as opendash_auth and writes app tables as opendash_system, the only roles allowed each.
 */
export async function provisionMissingOrgs(deps: {
  database: AuthDatabase;
  kek: Kek;
  system?: SystemRunner;
}): Promise<string[]> {
  const system = deps.system ?? withSystem;
  const orgs = await deps.database.db
    .select({ id: authTables.organization.id, name: authTables.organization.name, slug: authTables.organization.slug })
    .from(authTables.organization);
  const known = new Set(
    (await system((tx) => tx.execute<{ id: string }>(sql`select id::text as id from app.org`))).map((r) => r.id),
  );
  const missing = orgs.filter((o) => !known.has(o.id));
  for (const org of missing) await provisionOrg({ orgId: org.id, name: org.name }, deps);
  return missing.map((o) => o.slug ?? o.id);
}
