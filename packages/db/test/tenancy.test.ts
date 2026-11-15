/**
 * Tenancy suite ("CI checks"). Table-agnostic: it discovers every table
 * in schema `app`, so a new table is checked automatically and fails until it has policies and a fixture.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/ids";
import { TenantContextError, withSystemOn, withTenantOn } from "../src/tenant";
import { fixtures } from "./fixtures";
import { createOrg, createOwner, freshDatabase, pgError, type TestDatabase } from "./harness";

let t: TestDatabase;
const orgA = uuidv7();
const orgB = uuidv7();
let tables: string[] = [];
/**
 * The system's alone: RLS on and only the system policy, so no tenant reads a row (the ops tick's tables, and the
 * record of organizations that were deleted).
 */
const SYSTEM_ONLY = new Set(["ops_tick", "org_deletion"]);

beforeAll(async () => {
  t = await freshDatabase();
  tables = (
    await t.owner<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
      order by c.relname`
  ).map((r) => r.relname);

  for (const [id, name] of [
    [orgA, "Org A"],
    [orgB, "Org B"],
  ] as const) {
    await createOrg(t, id, name);
    await createOwner(t, id);
    await withSystemOn(t.system, async (tx) => {
      for (const fixture of Object.values(fixtures)) await fixture.insert(tx, id);
    });
  }
});

afterAll(async () => {
  await t?.drop();
});

describe("schema inventory", () => {
  it("discovers the tenant tables", () => {
    expect(tables).toEqual(
      expect.arrayContaining(["org", "org_key", "member_pref", "user_mark", "entitlement", "usage_event"]),
    );
  });

  it("every app table has a fixture (so it gets cross-tenant probes)", () => {
    expect(tables.filter((name) => !fixtures[name] && !SYSTEM_ONLY.has(name))).toEqual([]);
  });

  it("every app table has RLS enabled with both the tenant and system policies", async () => {
    const rows = await t.owner<{ relname: string; rls: boolean; policies: string[] | null }[]>`
      select c.relname, c.relrowsecurity as rls,
             array_agg(p.policyname || ':' || array_to_string(p.roles, ',') order by p.policyname)
               filter (where p.policyname is not null) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
      group by c.relname, c.relrowsecurity`;
    for (const row of rows) {
      expect.soft(row.rls, `${row.relname}: RLS enabled`).toBe(true);
      expect
        .soft(row.policies, `${row.relname}: policies`)
        .toEqual(
          SYSTEM_ONLY.has(row.relname) ? ["system:opendash_system"] : ["system:opendash_system", "tenant:opendash_app"],
        );
    }
  });

  it("partitions have RLS enabled with no policies, so direct reads see nothing", async () => {
    const rows = await t.owner<{ relname: string; rls: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relispartition and c.relkind = 'r'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect.soft(row.rls, `${row.relname}: RLS`).toBe(true);
      expect.soft(row.policies, `${row.relname}: no policies`).toBe(0);
    }
    const partition = rows[0]?.relname ?? "";
    const visible = await withTenantOn(t.app, { orgId: orgA }, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier("app")}.${sql.identifier(partition)}`,
      ),
    );
    expect(visible[0]?.n).toBe(0);
  });

  it("SECURITY DEFINER functions pin search_path, take no org_id argument and aren't executable by PUBLIC", async () => {
    const rows = await t.owner<
      { proname: string; config: string[] | null; args: string | null; public_exec: boolean }[]
    >`
      select p.proname, p.proconfig as config, pg_get_function_arguments(p.oid) as args,
             has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.prosecdef`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect
        .soft(
          row.config?.some((c) => c.startsWith("search_path=")),
          `${row.proname}: search_path`,
        )
        .toBe(true);
      expect.soft(row.args ?? "", `${row.proname}: no org_id param`).not.toMatch(/\borg_id\b/);
      expect.soft(row.public_exec, `${row.proname}: not PUBLIC`).toBe(false);
    }
  });

  it("the app and system roles can't bypass RLS", async () => {
    const rows = await t.owner<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('opendash_app', 'opendash_system')`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.rolbypassrls || row.rolsuper, row.rolname).toBe(false);
  });
});

describe("auth schema isolation", () => {
  it("the app and system roles have no privileges on any auth table", async () => {
    const rows = await t.owner<{ role: string; table: string }[]>`
      select r.rolname as role, c.relname as table
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('opendash_app'), ('opendash_system')) as r(rolname)
      where n.nspname = 'auth' and c.relkind = 'r'
        and has_table_privilege(r.rolname, c.oid, 'select, insert, update, delete')`;
    expect(rows).toEqual([]);
  });

  it("the auth role can reach the auth tables but nothing in app", async () => {
    const auth = await t.owner<
      { ok: boolean }[]
    >`select has_table_privilege('opendash_auth', 'auth.session', 'select') as ok`;
    const app = await t.owner<
      { ok: boolean }[]
    >`select has_table_privilege('opendash_auth', 'app.org', 'select') as ok`;
    expect(auth[0]?.ok).toBe(true);
    expect(app[0]?.ok).toBe(false);
  });
});

describe("cross-tenant probes", () => {
  it.each(Object.entries(fixtures))("%s: org A sees its own rows and none of org B's", async (table, { orgColumn }) => {
    const col = sql.identifier(orgColumn);
    const tbl = sql`${sql.identifier("app")}.${sql.identifier(table)}`;
    const counts = await withTenantOn(t.app, { orgId: orgA }, async (tx) => {
      const own = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${tbl} where ${col} = ${orgA}`);
      const other = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${tbl} where ${col} = ${orgB}`);
      const all = await tx.execute<{ n: number }>(sql`select count(distinct ${col})::int as n from ${tbl}`);
      return { own: own[0]?.n, other: other[0]?.n, orgs: all[0]?.n };
    });
    // Non-empty under the right context: catches policies that silently deny everything.
    expect(counts.own).toBeGreaterThan(0);
    expect(counts.other).toBe(0);
    expect(counts.orgs).toBe(1);
  });

  it.each(Object.keys(fixtures).filter((name) => name !== "org"))(
    "%s: org A can't write a row for org B",
    async (table) => {
      const attempt = withTenantOn(t.app, { orgId: orgA }, async (tx) => {
        await fixtures[table]?.insert(tx as never, orgB);
      });
      const error = await pgError(attempt);
      expect(error.code).toBe("42501");
      // A table the app role may not write at all (audit_chain, the sealer's) refuses by privilege instead.
      expect(error.message).toMatch(/row-level security|permission denied for table/);
    },
  );

  it("with no tenant context, the app role sees nothing (fails closed)", async () => {
    const rows = await t.app.client<{ n: number }[]>`select count(*)::int as n from app.org`;
    expect(rows[0]?.n).toBe(0);
  });

  it("the system role sees every org through its explicit policy", async () => {
    const rows = await withSystemOn(t.system, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from app.org`),
    );
    expect(rows[0]?.n).toBe(2);
  });

  it("tenant context doesn't leak across pooled transactions", async () => {
    await withTenantOn(t.app, { orgId: orgA }, async () => {});
    const rows = await t.app.client<{ org: string | null }[]>`select app.org_id()::text as org`;
    expect(rows[0]?.org).toBeNull();
  });
});

describe("personal scope", () => {
  it("someone else's personal item hides its versions too, for reads and writes", async () => {
    const owner = uuidv7();
    const other = uuidv7();
    const item = uuidv7();
    await withSystemOn(t.system, async (tx) => {
      await tx.execute(sql`
        insert into app.context_item (org_id, id, kind, scope, scope_id, path, slug, title, current_version)
        values (${orgA}, ${item}, 'memory', 'personal', ${owner}, ${`/me/${item}.md`}, ${item}, 'Mine', 1)`);
      await tx.execute(sql`
        insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
        values (${orgA}, ${item}, 1, 'my note', 'h', '{}', 'user')`);
    });
    const seen = (userId: string) =>
      withTenantOn(t.app, { orgId: orgA, userId }, async (tx) => {
        const items = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from app.context_item where id = ${item}`,
        );
        const versions = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from app.context_item_version where item_id = ${item}`,
        );
        return [items[0]?.n, versions[0]?.n];
      });
    expect(await seen(owner)).toEqual([1, 1]);
    expect(await seen(other)).toEqual([0, 0]);
    const write = withTenantOn(t.app, { orgId: orgA, userId: other }, (tx) =>
      tx.execute(sql`
        insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
        values (${orgA}, ${item}, 2, 'not yours', 'h', '{}', 'user')`),
    );
    expect((await pgError(write)).message).toMatch(/row-level security/);
  });
});

describe("withTenant", () => {
  it("rejects a non-uuid org id before touching the database", async () => {
    expect(() => withTenantOn(t.app, { orgId: "' or 1=1 --" }, async () => {})).toThrow(TenantContextError);
  });

  it("has the role defaults from the bootstrap", async () => {
    const rows = await t.app.client<{ s: string; i: string }[]>`
      select current_setting('statement_timeout') as s, current_setting('idle_in_transaction_session_timeout') as i`;
    expect(rows[0]).toEqual({ s: "15s", i: "30s" });
  });
});
