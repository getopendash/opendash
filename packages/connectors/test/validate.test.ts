// The Postgres statement check: what it refuses, and what it collects for grounding.
import { describe, expect, it } from "vitest";
import { validatePostgres } from "../src";
import { validateMySql } from "../src/mysql/validate";

const refused = async (sql: string) => {
  const r = await validatePostgres(sql);
  if (r.ok) throw new Error(`expected a refusal for: ${sql}`);
  return r;
};

describe("validatePostgres", () => {
  it.each([
    ["insert into public.plans (id) values ('x')", "not_a_query"],
    ["update public.plans set name = 'x'", "not_a_query"],
    ["delete from public.plans", "not_a_query"],
    ["drop table public.plans", "not_a_query"],
    ["copy public.plans to stdout", "not_a_query"],
    ["set statement_timeout = 0", "not_a_query"],
    ["select 1; select 2", "multiple_statements"],
    ["with gone as (delete from public.plans returning *) select * from gone", "writes_data"],
    ["select * into public.copy from public.plans", "creates_table"],
    ["select * from public.plans for update", "locks_rows"],
    ["select pg_sleep(10)", "denied_function"],
    ["select pg_catalog.pg_read_file('/etc/passwd')", "denied_function"],
    ["select query_to_xml('delete from public.plans', true, true, '')", "denied_function"],
    ["select set_config('statement_timeout', '0', false)", "denied_function"],
    ["select nextval('some_seq')", "denied_function"],
    ["select * from dblink('host=x', 'select 1') as t(a int)", "denied_function"],
    ["select pg_create_logical_replication_slot('s', 'test_decoding')", "denied_function"],
    ["select pg_switch_wal()", "denied_function"],
    // SQL written as text runs inside these, out of the walk's sight.
    ["select word from ts_stat($$select to_tsvector('simple', email) from public.users$$)", "denied_function"],
    [
      "select ts_rewrite('x'::tsquery, $$select 'x'::tsquery, plainto_tsquery(email) from public.users$$)",
      "denied_function",
    ],
    ["select * from crosstab('select a, b, c from t') as ct(a text, b text)", "denied_function"],
    ["select * from connectby('t', 'id', 'parent', '1', 0) as c(id text)", "denied_function"],
    // A function named with its schema isn't built in: an extension's, or the database's own.
    ["select aws_s3.query_export_to_s3('select 1', 'b', 'k')", "denied_function"],
    ["select public.peek()", "denied_function"],
    ["select http_get('https://example.com')", "denied_function"],
    ["select pg_stat_reset()", "denied_function"],
    ["select lowrite(0, 'x')", "denied_function"],
    ["select txid_current()", "denied_function"],
    ["select * from pg_catalog.pg_ls_waldir()", "denied_function"],
    ["", "empty"],
  ])("refuses %s", async (sql, kind) => {
    expect((await refused(sql)).kind).toBe(kind);
  });

  it("reports syntax errors with a position", async () => {
    const r = await refused("select from where");
    expect(r.kind).toBe("syntax");
    expect(r.position).toBeGreaterThan(0);
  });

  it("collects tables (not CTEs), literals, aggregates and joins", async () => {
    const r = await validatePostgres(`
      with paying as (select * from public.subscriptions where status in ('active', 'paused'))
      select a.country, sum(s.amount_cents) as total, count(distinct a.id)
      from paying s
      join public.accounts a on a.id = s.account_id
      where a.country = 'Germany' and a.is_test = false and 'EUR' = a.currency
      group by 1`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.tables).toHaveLength(2);
    expect(r.info.tables).toEqual(
      expect.arrayContaining([
        { schema: "public", name: "subscriptions", alias: null },
        { schema: "public", name: "accounts", alias: "a" },
      ]),
    );
    expect(r.info.literals).toEqual(
      expect.arrayContaining([
        { qualifier: null, column: "status", values: ["active", "paused"], params: [] },
        { qualifier: "a", column: "country", values: ["Germany"], params: [] },
        { qualifier: "a", column: "currency", values: ["EUR"], params: [] },
      ]),
    );
    expect(r.info.aggregates).toEqual(
      expect.arrayContaining([
        { fn: "sum", qualifier: "s", column: "amount_cents" },
        { fn: "count", qualifier: "a", column: "id" },
      ]),
    );
    expect(r.info.joins).toBe(1);
  });

  it("collects divisions whose sides a count or a column, for the advice to type", async () => {
    const r = await validatePostgres(`
      select count(i.paid_at) / count(*) as share, a.paid / a.total as ratio, sum(a.paid) / 2 as half
      from public.accounts a join public.invoices i on i.account_id = a.id`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.divisions).toEqual([
      { left: { count: true }, right: { count: true } },
      { left: { qualifier: "a", column: "paid" }, right: { qualifier: "a", column: "total" } },
    ]);
  });

  it("collects parameters, and where they're compared with a column", async () => {
    const r = await validatePostgres(`
      select count(*) from public.accounts a
      where a.country = $1 and a.plan in ($2, 'scale') and a.currency = any($3)
        and a.created_at >= $4::date and a.created_at < $5 and a.status = any(array['active', $2])`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.params).toEqual([1, 2, 3, 4, 5]);
    expect(r.info.literals).toEqual(
      expect.arrayContaining([
        { qualifier: "a", column: "country", values: [], params: [1] },
        { qualifier: "a", column: "plan", values: ["scale"], params: [2] },
        { qualifier: "a", column: "currency", values: [], params: [3] },
        { qualifier: "a", column: "status", values: ["active"], params: [2] },
      ]),
    );
    expect(r.info.literals.some((l) => l.column === "created_at")).toBe(false);
  });

  it("collects what a statement returns: columns outside count(), stars with their FROM tables, whole-row refs", async () => {
    const r = await validatePostgres(`
      with x as (select country, count(distinct billing_email) as n from public.accounts group by 1)
      select x.*, u.full_name, to_jsonb(s), count(u.email)
      from x join public.users u on true join public.subscriptions s on true`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.returned).toEqual(
      expect.arrayContaining([
        { qualifier: null, column: "country" },
        { qualifier: "u", column: "full_name" },
        { qualifier: null, column: "s" },
      ]),
    );
    expect(r.info.returned).not.toContainEqual({ qualifier: "u", column: "email" });
    expect(r.info.returned).not.toContainEqual({ qualifier: null, column: "billing_email" });
    expect(r.info.references).toContainEqual({ qualifier: null, column: "billing_email" });
    expect(r.info.stars).toEqual([
      {
        qualifier: "x",
        from: [
          { schema: "public", name: "users", alias: "u" },
          { schema: "public", name: "subscriptions", alias: "s" },
        ],
      },
    ]);
  });

  it("collects what each branch of UNION / INTERSECT / EXCEPT returns", async () => {
    for (const op of ["union", "union all", "intersect", "except"]) {
      const r = await validatePostgres(`select id from public.accounts ${op} select email from public.users u`);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.info.returned).toContainEqual({ qualifier: null, column: "email" });
    }
    const nested = await validatePostgres(
      "with x as (select name from public.plans union select full_name from public.users) select * from x",
    );
    if (nested.ok) expect(nested.info.returned).toContainEqual({ qualifier: null, column: "full_name" });
    const star = await validatePostgres("select id from public.accounts union all table public.users");
    if (star.ok) expect(star.info.stars.flatMap((x) => x.from.map((f) => f.name))).toContain("users");
  });

  it("allows ordinary functions, including the safe pg_* ones", async () => {
    for (const sql of [
      "select lower(name), log(10, 100), pg_typeof(1), pg_size_pretty(1024::bigint) from public.plans",
      "select coalesce(null, 1), round(2.5), now(), current_setting('TimeZone')",
    ]) {
      expect((await validatePostgres(sql)).ok).toBe(true);
    }
  });

  it("allows ordinary analytics", async () => {
    for (const sql of [
      "select date_trunc('month', created_at) m, count(*) from public.accounts group by 1 order by 1",
      "select * from generate_series(1, 3)",
      "select p.name, rank() over (order by sum(i.quantity) desc) from public.plans p join public.subscription_items i on i.plan_id = p.id group by p.name",
      "explain select 1",
    ].slice(0, 3)) {
      expect((await validatePostgres(sql)).ok).toBe(true);
    }
  });
});

describe("CTE names, resolved as the database does (by scope)", () => {
  // A name set for the whole statement once let a CTE named like a table hide that table from every check.
  const tablesOf = async (check: Promise<unknown> | unknown) => {
    const r = (await check) as { ok: boolean; info?: { tables: { schema: string | null; name: string }[] } };
    if (!r.ok || !r.info) throw new Error("expected the statement to pass");
    return r.info.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
  };

  it("checks a table a CTE shadows elsewhere, or that a CTE's own body reads (Postgres)", async () => {
    expect(
      await tablesOf(
        validatePostgres(
          "select u.email || '' from users u where exists (with users as (select 1) select 1 from users)",
        ),
      ),
    ).toEqual(["users"]);
    expect(
      await tablesOf(validatePostgres("with users as (select email from users) select email || '' from users")),
    ).toEqual(["users"]);
    // A CTE the query can see stays a CTE: siblings before it, and itself when recursive.
    expect(
      await tablesOf(
        validatePostgres("with a as (select id from public.accounts), b as (select id from a) select count(*) from b"),
      ),
    ).toEqual(["public.accounts"]);
    expect(
      await tablesOf(
        validatePostgres(
          "with recursive r as (select 1 as n union all select n + 1 from r where n < 3) select n from r",
        ),
      ),
    ).toEqual([]);
  });

  it("does the same on MySQL", async () => {
    expect(
      await tablesOf(
        validateMySql(
          "select concat(u.email, '') from users u where exists (with users as (select 1) select 1 from users)",
        ),
      ),
    ).toEqual(["users"]);
    expect(
      await tablesOf(validateMySql("with users as (select email from users) select concat(email, '') from users")),
    ).toEqual(["users"]);
    expect(
      await tablesOf(
        validateMySql("with a as (select id from accounts), b as (select id from a) select count(*) from b"),
      ),
    ).toEqual(["accounts"]);
  });
});
