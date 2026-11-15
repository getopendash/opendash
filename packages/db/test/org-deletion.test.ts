/**
 * Deleting an organization. Two of them get a row in every app table (the tenancy suite's fixtures); one is deleted
 * the way the product does it, as the auth role, by its auth.organization row. Everything a foreign key reaches goes
 * in that statement, the deletion is recorded, and what's left is exactly what the purge removes. A new table whose
 * rows survive both fails here.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/ids";
import { markOrgPurged, ORG_PURGED_TABLES, purgeOrgRows, unpurgedOrgs } from "../src/org-deletion";
import { withSystemOn } from "../src/tenant";
import { fixtures } from "./fixtures";
import { createOrg, createOwner, freshDatabase, type TestDatabase } from "./harness";

let t: TestDatabase;
const gone = uuidv7();
const kept = uuidv7();
let tables: string[] = [];

/** How many rows each app table holds for an organization (app.org by its id). */
async function rowsOf(orgId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const column = table === "org" ? "id" : "org_id";
    const [row] = await t.owner.unsafe<{ n: number }[]>(
      `select count(*)::int as n from app.${table} where ${column} = $1`,
      [orgId],
    );
    counts[table] = row?.n ?? 0;
  }
  return counts;
}
const withRows = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table]) => table)
    .sort();

beforeAll(async () => {
  t = await freshDatabase();
  tables = (
    await t.owner<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
        and c.relname <> 'org_deletion'
      order by c.relname`
  ).map((r) => r.relname);
  tables.push("org");
  for (const [id, name] of [
    [gone, "Gone"],
    [kept, "Kept"],
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

describe("deleting an organization", () => {
  it("starts with a row in every app table, for both", async () => {
    expect(Object.entries(await rowsOf(gone)).filter(([, n]) => n === 0)).toEqual([]);
    expect(Object.entries(await rowsOf(kept)).filter(([, n]) => n === 0)).toEqual([]);
  });

  it("isn't the system's to purge while it exists", async () => {
    await expect(withSystemOn(t.system, (tx) => purgeOrgRows(tx, gone))).rejects.toThrow(/deleted organization/);
    expect(withRows(await rowsOf(gone))).toContain("query_run");
  });

  it("takes everything a foreign key reaches in one statement, as the auth role, and records it", async () => {
    const before = await rowsOf(kept);
    await t.auth.client`delete from auth.organization where id = ${gone}`;

    // Its members went with it (Better Auth's tables), and its record was written by the trigger.
    const [members] = await t.auth.client<{ n: number }[]>`
      select count(*)::int as n from auth.member where organization_id = ${gone}`;
    expect(members?.n).toBe(0);
    expect(await withSystemOn(t.system, (tx) => unpurgedOrgs(tx))).toEqual([gone]);

    // What's left is what no foreign key reaches, and nothing else: exactly the purge's tables.
    expect(withRows(await rowsOf(gone))).toEqual([...ORG_PURGED_TABLES].sort());
    // The other organization lost nothing.
    expect(await rowsOf(kept)).toEqual(before);
  });

  it("is purged in batches until nothing is left, and only then marked done", async () => {
    // A batch of one: each call removes at most a row per table, and says how many went.
    let calls = 0;
    for (;;) {
      const removed = await withSystemOn(t.system, (tx) => purgeOrgRows(tx, gone, 1));
      if (removed === 0) break;
      expect(removed).toBeLessThanOrEqual(ORG_PURGED_TABLES.length);
      if (++calls > 50) throw new Error("the purge never finishes");
    }
    expect(withRows(await rowsOf(gone))).toEqual([]);
    await withSystemOn(t.system, (tx) => markOrgPurged(tx, gone));
    expect(await withSystemOn(t.system, (tx) => unpurgedOrgs(tx))).toEqual([]);
    const [record] = await withSystemOn(t.system, (tx) =>
      tx.execute<{ purged: boolean }>(
        sql`select purged_at is not null as purged from app.org_deletion where org_id = ${gone}::uuid`,
      ),
    );
    expect(record?.purged).toBe(true);
  });

  it("leaves the other organization whole, and refuses to purge it or one that never existed", async () => {
    expect(Object.entries(await rowsOf(kept)).filter(([, n]) => n === 0)).toEqual([]);
    await expect(withSystemOn(t.system, (tx) => purgeOrgRows(tx, kept))).rejects.toThrow(/deleted organization/);
    await expect(withSystemOn(t.system, (tx) => purgeOrgRows(tx, uuidv7()))).rejects.toThrow(/deleted organization/);
  });

  it("no tenant reads the record of deletions", async () => {
    const rows = await t.app.client`select * from app.org_deletion`;
    expect(rows.length).toBe(0);
  });
});
