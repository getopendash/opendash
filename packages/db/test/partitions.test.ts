import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/ids";
import { withSystemOn, withTenantOn } from "../src/tenant";
import { createOrg, freshDatabase, pgError, type TestDatabase } from "./harness";

let t: TestDatabase;
const org = uuidv7();

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, org, "Partitions");
});

afterAll(async () => {
  await t?.drop();
});

describe("RANGE(id) partitions on uuidv7", () => {
  it("app.uuidv7_floor and app.uuidv7_ts round-trip a timestamp", async () => {
    const rows = await t.owner<{ ts: Date; ok: boolean }[]>`
      select app.uuidv7_ts(app.uuidv7_floor('2026-10-01T00:00:00Z')) as ts,
             app.uuidv7_floor('2026-10-01T00:00:00Z') < app.uuidv7_floor('2026-10-01T00:00:00.001Z') as ok`;
    expect(rows[0]?.ts.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(rows[0]?.ok).toBe(true);
  });

  it("an app-generated uuidv7 sorts after the floor of its own timestamp", async () => {
    const id = uuidv7();
    const rows = await t.owner<
      { ok: boolean }[]
    >`select app.uuidv7_floor(app.uuidv7_ts(${id}::uuid)) <= ${id}::uuid as ok`;
    expect(rows[0]?.ok).toBe(true);
  });

  it("migrations pre-create the current month plus three ahead, with nothing missing", async () => {
    const rows = await withSystemOn(t.system, (tx) =>
      tx.execute<{ missing: number }>(sql`select app.missing_partitions('usage_event', 'month', 3) as missing`),
    );
    expect(rows[0]?.missing).toBe(0);
  });

  it("query_run (monthly) and run_event (daily) have their partitions ahead, too", async () => {
    const rows = await withSystemOn(t.system, (tx) =>
      tx.execute<{ q: number; e: number }>(sql`
        select app.missing_partitions('query_run', 'month', 3) as q, app.missing_partitions('run_event', 'day', 3) as e`),
    );
    expect(rows[0]).toEqual({ q: 0, e: 0 });
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const parts = await t.owner<{ name: string }[]>`
      select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent where p.relname = 'run_event'`;
    expect(parts.map((p) => p.name)).toContain(`run_event_p${day}`);
  });

  it("ensure_partitions is idempotent", async () => {
    const rows = await withSystemOn(t.system, (tx) =>
      tx.execute<{ created: number }>(sql`select app.ensure_partitions('usage_event', 'month', 3) as created`),
    );
    expect(rows[0]?.created).toBe(0);
  });

  it("a usage event written now lands in this month's partition and is visible to its org", async () => {
    await withTenantOn(t.app, { orgId: org }, (tx) =>
      tx.execute(
        sql`insert into app.usage_event (id, org_id, kind, qty, unit) values (${uuidv7()}, ${org}, 'query', 1, 'queries')`,
      ),
    );
    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    const rows = await t.owner<{ part: string }[]>`select tableoid::regclass::text as part from app.usage_event`;
    expect(rows.map((r) => r.part)).toContain(`app.usage_event_p${month}`);
  });

  it("there is no DEFAULT partition: an id outside every partition fails loudly", async () => {
    const old = await t.owner<{ id: string }[]>`select app.uuidv7_floor('2001-01-01T00:00:00Z')::text as id`;
    const attempt = withTenantOn(t.app, { orgId: org }, (tx) =>
      tx.execute(
        sql`insert into app.usage_event (id, org_id, kind, qty, unit) values (${old[0]?.id}, ${org}, 'query', 1, 'q')`,
      ),
    );
    const error = await pgError(attempt);
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/no partition/);
  });

  it("drop_partitions_before drops only partitions older than the retention window", async () => {
    await t.owner.unsafe(`
      create table app.usage_event_p200101 partition of app.usage_event
        for values from ('${(await t.owner<{ v: string }[]>`select app.uuidv7_floor('2001-01-01')::text as v`)[0]?.v}')
        to ('${(await t.owner<{ v: string }[]>`select app.uuidv7_floor('2001-02-01')::text as v`)[0]?.v}')`);
    const dropped = await withSystemOn(t.system, (tx) =>
      tx.execute<{ name: string }>(sql`select app.drop_partitions_before('usage_event', interval '13 months') as name`),
    );
    expect(dropped.map((r) => r.name)).toEqual(["usage_event_p200101"]);
    const left = await withSystemOn(t.system, (tx) =>
      tx.execute<{ missing: number }>(sql`select app.missing_partitions('usage_event', 'month', 3) as missing`),
    );
    expect(left[0]?.missing).toBe(0);
  });
});
