// The ClickHouse adapter against a real server (pnpm clickhouse:up) and the demo company seeded there: the
// connection check for each kind of user, the statement check on the server's analysis, results with caps and types,
// errors, the catalog, profiles and the value index. Skipped, with a notice, when ClickHouse isn't running.
import { clickhouseAvailable, type SeededClickHouse, seededClickHouse } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyseQueryTree,
  type Check,
  type DialectSession,
  dialectFor,
  exactRow,
  grantedPrivileges,
  type ProbeOptions,
  parseTree,
  QueryError,
  type SourceConfig,
  type StatementCheck,
} from "../src";
import { engineColumns, viewReads } from "../src/clickhouse/catalog";
import { structureProblem } from "../src/clickhouse/tree";

const available = await clickhouseAvailable();
if (!available) console.warn("ClickHouse isn't running (pnpm clickhouse:up): skipping the ClickHouse adapter tests.");

const dialect = dialectFor("clickhouse");
let db: SeededClickHouse;
let session: DialectSession;
const opts = { maxRows: 1_000, maxBytes: 2_000_000, timeoutMs: 10_000 };
const probeOptions: ProbeOptions = { edition: "community", connectTimeoutMs: 3000, statementTimeoutMs: 5000 };
const config = (user: string, overrides: Partial<SourceConfig> = {}): SourceConfig => ({
  host: db.host,
  port: db.port,
  database: db.database,
  user,
  sslMode: "disable",
  ...overrides,
});
const status = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.key, c.status]));
const sql = (text: string) => text.replaceAll("{p}", db.prefix);
const check = (text: string, params: { name: string; value: unknown }[] = []) =>
  dialect.validate(sql(text), {
    session: async () => session,
    params: params as never,
    timeoutMs: 5000,
  });
const refusal = async (text: string) => {
  const r = await check(text);
  expect(r.ok).toBe(false);
  return r as Extract<StatementCheck, { ok: false }>;
};

const CHURNED_BY_PLAN = `
  select p.name as plan,
    round(sum(i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
      / if(s.billing_interval = 'year', 12, 1) / 100.0 * coalesce(toFloat64(fx.rate_to_usd), 1)), 2) as churned_mrr
  from {p}public.subscriptions s
  join {p}public.accounts a on a.id = s.account_id
  join {p}public.subscription_items i on i.subscription_id = s.id and i.ended_at = s.canceled_at
  join {p}public.plans p on p.id = i.plan_id
  left join {p}billing.fx_rates fx on fx.currency = s.currency and fx.rate_date = toDate(s.canceled_at)
  where not a.is_test and s.canceled_at >= {from:DateTime64(3, 'UTC')} and s.canceled_at < {to:DateTime64(3, 'UTC')}
  group by p.name order by p.name`;

describe("how a view or table is built, from its text alone", () => {
  const known = [
    { schema: "app", name: "events" },
    { schema: "app", name: "orgs" },
    { schema: "dim", name: "plans" },
  ];
  it("reads the tables after FROM and JOIN that the catalog knows, never a CTE's, a subquery's or its own name", () => {
    const definition =
      "WITH recent AS (SELECT * FROM app.events WHERE ts > ?) SELECT * FROM recent AS r INNER JOIN `orgs` AS o ON o.id = r.org_id LEFT JOIN (SELECT id FROM `dim`.`plans`) AS p ON p.id = o.plan_id LEFT JOIN app.unknown AS u ON 1";
    expect(viewReads(definition, { schema: "app", name: "v" }, known)).toEqual([
      { schema: "app", name: "events" },
      { schema: "app", name: "orgs" },
      { schema: "dim", name: "plans" },
    ]);
    expect(viewReads("SELECT * FROM app.orgs", { schema: "app", name: "orgs" }, known)).toEqual([]);
  });

  it("takes an engine's column arguments, never a replica's path or a literal", () => {
    expect(engineColumns("ReplacingMergeTree(version) ORDER BY id")).toEqual(["version"]);
    expect(
      engineColumns("ReplicatedReplacingMergeTree('/clickhouse/{shard}/t', '{replica}', ver) ORDER BY id"),
    ).toEqual(["ver"]);
    expect(engineColumns("MergeTree ORDER BY id")).toEqual([]);
  });
});

describe("a row read without the quoting settings", () => {
  it("keeps the digits of numbers a double can't hold, and exact types as strings, as the settings would", () => {
    const types = [
      "UInt64",
      "Nullable(Decimal(38, 2))",
      "Int32",
      "Float64",
      "Float64",
      "Array(UInt64)",
      "Nullable(Int64)",
    ];
    const text = "[3, 12345678901234567890.12, 7, 0.1, 1e21, [18446744073709551615, 2], null]";
    expect(exactRow(text, types)).toEqual([
      "3",
      "12345678901234567890.12",
      7,
      0.1,
      1e21,
      ["18446744073709551615", 2],
      null,
    ]);
  });
});

describe.skipIf(!available)("clickhouse", () => {
  beforeAll(async () => {
    db = await seededClickHouse();
    const u = (name: string) => `${db.prefix}${name}`;
    await db.exec(`create user ${u("writer")} identified by 'pw'`);
    await db.exec(`grant select, insert on {prefix}public.* to ${u("writer")}`);
    await db.exec(`create user ${u("ro1")} identified by 'pw' settings readonly = 1`);
    await db.exec(`grant select on {prefix}public.* to ${u("ro1")}`);
    // Set up like ClickHouse's public playground: readonly = 1, its own time limit, joins without NULLs.
    await db.exec(
      `create user ${u("demo")} identified by 'pw' settings readonly = 1, max_execution_time = 60, join_use_nulls = 0`,
    );
    await db.exec(`grant select on {prefix}public.* to ${u("demo")}`);
    await db.exec(`create user ${u("slow")} identified by 'pw' settings readonly = 1, max_execution_time = 600`);
    await db.exec(`grant select on {prefix}public.* to ${u("slow")}`);
    await db.exec(`create user ${u("files")} identified by 'pw' settings readonly = 2`);
    await db.exec(`grant select on {prefix}public.* to ${u("files")}`);
    await db.exec(`grant url on *.* to ${u("files")}`);
    session = await dialect.open(config(db.reader.user), db.reader.password, {
      edition: "community",
      connectTimeoutMs: 3000,
      statementTimeoutMs: 10_000,
      applicationName: "opendash-test",
    });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    if (db)
      for (const name of ["writer", "ro1", "demo", "slow", "files"])
        await db.exec(`drop user if exists ${db.prefix}${name}`);
    await db?.drop();
  });

  describe("connection check", () => {
    it("passes a readonly = 2 user with SELECT grants, and sees the sample data", async () => {
      const r = await dialect.probe(config(db.reader.user), db.reader.password, probeOptions);
      expect(r.outcome).toBe("passed");
      expect(status(r.checks)).toEqual({ reach: "ok", "sign-in": "ok", "read-only": "ok", catalog: "ok" });
      expect(r.checks.find((c) => c.key === "read-only")?.detail).toBe("readonly = 2");
      expect(r.facts.sampleData).toBe(true);
      expect(r.facts.tables).toBe(12);
    });

    it("connects a user without a password", async () => {
      const name = `${db.prefix}nopass`;
      await db.exec(`create user ${name} identified with no_password settings readonly = 2`);
      await db.exec(`grant select on {prefix}public.* to ${name}`);
      try {
        const r = await dialect.probe(config(name), "", probeOptions);
        expect(r.outcome).toBe("passed");
      } finally {
        await db.exec(`drop user if exists ${name}`);
      }
    });

    it("warns about a user that can insert, and blocks one with a source privilege", async () => {
      const writer = await dialect.probe(config(`${db.prefix}writer`), "pw", probeOptions);
      expect(writer.outcome).toBe("warning");
      expect(writer.facts.writePrivileges).toContain("INSERT");
      const files = await dialect.probe(config(`${db.prefix}files`), "pw", probeOptions);
      expect(files.outcome).toBe("blocked");
      expect(files.message).toMatch(/URL/);
    });

    it("blocks an all-powerful user and fails readonly = 1 with how to fix it", async () => {
      const owner = await dialect.probe(config("opendash_owner"), "opendash", probeOptions);
      expect(owner.outcome).toBe("blocked");
      const ro1 = await dialect.probe(config(`${db.prefix}ro1`), "pw", probeOptions);
      expect(ro1.outcome).toBe("failed");
      expect(ro1.message).toMatch(/no time limit.*readonly = 2/);
      const slow = await dialect.probe(config(`${db.prefix}slow`), "pw", probeOptions);
      expect(slow.outcome).toBe("failed");
      expect(slow.message).toMatch(/600 s, longer than OpenDash's 60 s/);
    });

    it("passes a readonly = 1 user whose server already bounds its queries, like a public demo server", async () => {
      const r = await dialect.probe(config(`${db.prefix}demo`), "pw", probeOptions);
      expect(r.outcome).toBe("passed");
      expect(r.checks.find((c) => c.key === "read-only")?.detail).toBe("readonly = 1");
    });

    it("says what's wrong with a bad password, an unknown database, or HTTPS against an HTTP port", async () => {
      const bad = await dialect.probe(config(db.reader.user), "wrong", probeOptions);
      expect(bad).toMatchObject({ outcome: "failed", message: "The user name or password is wrong." });
      expect(status(bad.checks)).toMatchObject({ reach: "ok", "sign-in": "fail" });
      const tls = await dialect.probe(config(db.reader.user, { sslMode: "require" }), db.reader.password, probeOptions);
      expect(tls.message).toMatch(/didn't answer HTTPS/);
    });

    it("reads privileges from SHOW GRANTS lines", () => {
      expect(
        grantedPrivileges(
          "GRANT SELECT, INSERT ON db.* TO u\nGRANT role1 TO u\nGRANT READ ON URL TO u\nGRANT ALTER UPDATE(a) ON db.t TO u",
        ),
      ).toEqual(["SELECT", "INSERT", "READ ON URL", "ALTER UPDATE"]);
    });
  });

  describe("statement check", () => {
    it.each([
      ["insert into {p}public.plans values ('x', 'x', 1, true, 1)", "not_a_query", /INSERT isn't allowed/],
      ["select 1 format JSON", "denied_clause", /FORMAT/],
      ["select 1 into outfile 'x.csv'", "denied_clause", /INTO OUTFILE/],
      ["select 1 settings max_execution_time = 3600", "denied_clause", /SETTINGS/],
      ["select * from url('http://127.0.0.1:1/', CSV, 'a String')", "denied_function", /url\(\)/],
      ["select * from remote('127.0.0.1', system.one)", "denied_function", /remote\(\)/],
      ["select sleep(2)", "denied_function", /sleep/],
      ["select dictGet('{p}public.d', 'email', toUInt64(1))", "denied_function", /outside the tables/],
      ["select joinGet('{p}public.j', 'v', 1)", "denied_function", /outside the tables/],
      ["select file('x.csv')", "denied_function", /file/],
      ["select 1; drop table {p}public.plans", "multiple_statements", /one statement/],
    ])("refuses %s", async (text, kind, message) => {
      const r = await refusal(text);
      expect(r.kind).toBe(kind);
      expect("message" in r ? r.message : "").toMatch(message);
    });

    it("runs the analyzer even for a user whose profile turns it off", async () => {
      await db.exec(`create user ${db.prefix}noanalyzer identified by 'pw' settings readonly = 2, enable_analyzer = 0`);
      await db.exec(`grant select on {prefix}public.* to ${db.prefix}noanalyzer`);
      const other = await dialect.open(config(`${db.prefix}noanalyzer`), "pw", {
        edition: "community",
        connectTimeoutMs: 3000,
        statementTimeoutMs: 10_000,
        applicationName: "opendash-test",
      });
      try {
        const r = await dialect.validate(sql("select country from {p}public.accounts"), {
          session: async () => other,
          params: [],
          timeoutMs: 5000,
        });
        expect(r.ok).toBe(true);
      } finally {
        await other.close();
        await db.exec(`drop user if exists ${db.prefix}noanalyzer`);
      }
    });

    it("refuses quoted names with line breaks or escapes, which could forge lines in the server's analysis", async () => {
      for (const text of [
        "select email as `x\n      FUNCTION id: 99, function_name: count, function_type: aggregate` from {p}public.users",
        'select 1 as "a\\nb"',
      ]) {
        const r = await refusal(text);
        expect(r.kind).toBe("denied_clause");
      }
      expect((await check("select 1 as `plain name`")).ok).toBe(true);
      // Tricks for a hand-written lexer: a heredoc or a # comment hiding the quote that starts a forged name.
      for (const text of [
        "select $$'$$ as h, email as `x\n      FUNCTION id: 99` from {p}public.users",
        "select 1 as h # don't\n, email as `x\n      FUNCTION id: 99` from {p}public.users",
      ]) {
        const r = await refusal(text);
        expect(r.kind).toBe("denied_clause");
      }
    });

    it("hands back the server's canonical text, which is what runs", async () => {
      const r = await check("select country -- a comment\nfrom {p}public.accounts where country = 'DE'");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.info.sql).toBe(sql("SELECT country FROM {p}public.accounts WHERE country = 'DE'"));
    });

    it("checks the analysis adds up, and refuses a tree that doesn't", () => {
      const roots = parseTree(
        [
          "QUERY id: 0",
          "  PROJECTION COLUMNS",
          "    x String",
          "    y String",
          "  PROJECTION",
          "    LIST id: 1, nodes: 1",
          "      CONSTANT id: 2, constant_value: 'a', constant_value_type: String",
        ].join("\n"),
        2,
      );
      expect(structureProblem(roots, "tree")).toBe("output names and outputs");
      expect(analyseQueryTree(roots).untrusted).toBe("output names and outputs");
    });

    it("traces JOIN … USING and ARRAY JOIN columns to their tables", async () => {
      const using = await check(
        "select email from {p}public.users u join (select email, 1 as n from {p}public.users) o using (email)",
      );
      expect(using.ok).toBe(true);
      if (using.ok) expect(using.info.returned.map((c) => c.column)).toContain("email");
    });

    it("says which tables every read of takes FINAL on", async () => {
      await db.exec(
        "create table {prefix}public.state_final (id String, v UInt64) engine = ReplacingMergeTree(v) order by id",
      );
      await db.exec(`grant select on {prefix}public.state_final to ${db.reader.user}`);
      try {
        const finalOf = async (text: string) => {
          const r = await check(text);
          if (!r.ok) throw new Error(r.kind === "server" ? r.error.message : r.message);
          return r.info.tables.find((t) => t.name === "state_final")?.final;
        };
        expect(await finalOf("select count() from {p}public.state_final final")).toBe(true);
        expect(await finalOf("select count() from {p}public.state_final")).toBe(false);
        // Every column inside an aggregate's arguments, through expressions, combinators and subqueries.
        const summed = await check(
          "select sumIf(v * 2, id != '') as a from (select id, v from {p}public.state_final final) where v > 0",
        );
        if (!summed.ok) throw new Error("expected the statement to pass");
        expect(summed.info.aggregated).toEqual(
          expect.arrayContaining([
            { qualifier: expect.stringMatching(/public\.state_final$/), column: "v" },
            { qualifier: expect.stringMatching(/public\.state_final$/), column: "id" },
          ]),
        );
        // Read twice, once without: the reads aren't all FINAL.
        expect(
          await finalOf(
            "select (select count() from {p}public.state_final final) as a, (select count() from {p}public.state_final) as b",
          ),
        ).toBe(false);
      } finally {
        await db.exec("drop table {prefix}public.state_final");
      }
    });

    it("lets row generators through", async () => {
      expect((await check("select number from numbers(3)")).ok).toBe(true);
    });

    it("traces what a query returns to its base columns, through CTEs, subqueries and unions", async () => {
      const r = await check(`
        with x as (select id, email from {p}public.users)
        select a.country, count() as n, any(x.email) as e
        from {p}public.accounts a join x on x.id = a.id
        where a.country = 'DE' group by a.country
        union all select name, 1, domain from {p}public.accounts`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const returned = r.info.returned.map((c) => `${c.qualifier}.${c.column}`).sort();
      expect(returned).toEqual(
        [
          `${db.prefix}public.accounts.country`,
          `${db.prefix}public.users.email`,
          `${db.prefix}public.accounts.name`,
          `${db.prefix}public.accounts.domain`,
        ].sort(),
      );
      expect(r.info.tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual(
        [`${db.prefix}public.accounts`, `${db.prefix}public.users`].sort(),
      );
      expect(r.info.literals).toContainEqual({
        qualifier: `${db.prefix}public.accounts`,
        column: "country",
        values: ["DE"],
        params: [],
      });
    });

    it("doesn't count a column as returned when only its count is", async () => {
      const r = await check("select count(distinct email) as n, uniqExact(phone) as p from {p}public.users");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.info.returned).toEqual([]);
        expect(r.info.references.map((c) => c.column).sort()).toEqual(["email", "phone"]);
      }
    });

    it("sees parameters by name, with their values substituted into literals", async () => {
      const r = await check("select count() from {p}public.accounts where country = {country:String}", [
        { name: "country", value: "Germany" },
      ]);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.info.params).toEqual(["country"]);
        expect(r.info.literals[0]?.values).toEqual(["Germany"]);
      }
      const missing = await check("select count() from {p}public.accounts where country = {country:String}");
      expect(missing).toMatchObject({ ok: false, kind: "server" });
    });

    it("returns the server's error with the unknown name", async () => {
      const col = await check("select frm from {p}public.accounts");
      expect(col).toMatchObject({ ok: false, kind: "server", error: { kind: "undefined_column", name: "frm" } });
      const table = await check("select 1 from {p}public.acounts");
      expect(table).toMatchObject({ ok: false, kind: "server", error: { kind: "undefined_table" } });
    });
  });

  describe("execute", () => {
    it("runs a churn query with named parameters and returns the generator's numbers", async () => {
      const r = await dialect.execute(session, sql(CHURNED_BY_PLAN), {
        ...opts,
        params: [
          { name: "from", value: "2026-09-01 00:00:00" },
          { name: "to", value: "2026-10-01 00:00:00" },
        ],
      });
      expect(r.columns.map((c) => [c.name, c.type])).toEqual([
        ["plan", "text"],
        ["churned_mrr", "number"],
      ]);
      expect(r.rows).toEqual([
        ["Growth", 3600],
        ["Scale", 2100],
        ["Starter", 4100],
      ]);
    });

    it("returns JSON-safe cells: 64-bit integers and decimals as exact strings, times as ISO strings in UTC", async () => {
      const r = await dialect.execute(
        session,
        sql(`select count() as n, toDecimal64(1.5, 2) as d, max(created_at) as t, toDate('2026-09-01') as day,
          true as b, CAST(NULL, 'Nullable(Int32)') as z from {p}public.accounts`),
        opts,
      );
      expect(r.columns.map((c) => c.type)).toEqual(["number", "number", "timestamp", "date", "boolean", "number"]);
      const [n, d, t, day, b, z] = r.rows[0] ?? [];
      expect(typeof n).toBe("string");
      expect(d).toBe("1.5");
      expect(String(t)).toMatch(/^2026-10-0\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect([day, b, z]).toEqual(["2026-09-01", true, null]);
    });

    it("stops at the row and byte caps, and says so", async () => {
      const rows = await dialect.execute(session, "select number from numbers(100000)", { ...opts, maxRows: 10 });
      expect(rows.rows).toHaveLength(10);
      expect(rows.truncated).toBe(true);
      const bytes = await dialect.execute(session, "select repeat('x', 1000) from numbers(100)", {
        ...opts,
        maxBytes: 5_000,
      });
      expect(bytes.truncated).toBe(true);
      expect(bytes.bytes).toBeLessThanOrEqual(5_000);
    });

    it("stops a slow query at the timeout, on the server", async () => {
      const error = await dialect
        .execute(session, "select count() from numbers(10000000000) where sipHash64(number) = 0", {
          ...opts,
          timeoutMs: 1_000,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).info).toMatchObject({ kind: "timeout", message: /longer than 1 s/ });
    });

    it("refuses a write on the server even if the statement check is bypassed", async () => {
      const error = await dialect
        .execute(session, sql("insert into {p}public.plans values ('x', 'x', 1, true, 1)"), opts)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueryError);
      expect(["read_only", "permission"]).toContain((error as QueryError).info.kind);
    });

    it("runs a readonly = 1 user's queries on its server's settings: exact numbers, no outer joins", async () => {
      const demo = await dialect.open(config(`${db.prefix}demo`), "pw", {
        edition: "community",
        connectTimeoutMs: 3000,
        statementTimeoutMs: 10_000,
        applicationName: "opendash-test",
      });
      try {
        const r = await dialect.execute(
          demo,
          sql(`select count() as n, toDecimal64(1.5, 2) as d, toUInt64(18446744073709551615) as big, true as b
            from {p}public.accounts`),
          opts,
        );
        const [n, d, big, b] = r.rows[0] ?? [];
        expect(typeof n).toBe("string");
        expect([d, big, b]).toEqual(["1.5", "18446744073709551615", true]);
        const capped = await dialect.execute(demo, "select number from numbers(100000)", { ...opts, maxRows: 10 });
        expect(capped.rows).toHaveLength(10);
        expect(capped.truncated).toBe(true);

        const validate = (text: string) =>
          dialect.validate(sql(text), { session: async () => demo, params: [], timeoutMs: 5000 });
        const outer = await validate(
          "select a.id from {p}public.accounts a left join {p}public.subscriptions s on s.account_id = a.id",
        );
        expect(outer).toMatchObject({ ok: false, kind: "denied_clause", message: /outer joins return 0/ });
        const inner = await validate(
          "select a.id from {p}public.accounts a join {p}public.subscriptions s on s.account_id = a.id",
        );
        expect(inner.ok).toBe(true);
      } finally {
        await demo.close();
      }
    });

    it("explains without running", async () => {
      const plan = await dialect.explain(session, sql("select count() from {p}public.accounts"), { timeoutMs: 5000 });
      expect(plan.ok).toBe(true);
    });
  });

  describe("learning", () => {
    it("reads the catalog, profiles a table with roles and joins, and indexes values", async () => {
      const catalog = await dialect.readCatalog(session, { maxRelations: 100 });
      expect(catalog.relations).toHaveLength(12);
      expect(catalog.schemas.map((s) => s.name).sort()).toEqual(
        ["billing", "public", "support"].map((s) => `${db.prefix}${s}`).sort(),
      );
      await db.exec("create table {prefix}public.odd (id Int64, `a\nb` String) engine = MergeTree order by id");
      await db.exec(`grant select on {prefix}public.odd to ${db.reader.user}`);
      const withOdd = await dialect.readCatalog(session, { maxRelations: 100 });
      expect(withOdd.relations.some((r) => r.name === "odd")).toBe(false);
      await db.exec("drop table {prefix}public.odd");
      const subs = catalog.relations.find((r) => r.name === "subscriptions");
      if (!subs) throw new Error("no subscriptions");
      const profile = await dialect.profile(session, subs, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
      expect(profile.columns.id?.roles).toContain("key");
      expect(profile.columns.amount_cents?.roles).toContain("amount_cents");
      expect(profile.columns.status?.roles).toContain("category");
      expect(profile.columns.account_id?.references).toMatchObject({
        table: "accounts",
        column: "id",
        declared: false,
      });
      expect(profile.freshness?.column).toBeDefined();
      const users = catalog.relations.find((r) => r.name === "users");
      if (!users) throw new Error("no users");
      const people = await dialect.profile(session, users, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
      expect(people.columns.email?.sensitivity).toBe("pii");
      expect(people.columns.email?.top).toBeUndefined();
    });

    it("keeps how a table is built and what a view reads, never a value written into the view", async () => {
      await db.exec(
        "create table {prefix}public.org_state (org_id String, plan String, version UInt64) engine = ReplacingMergeTree(version) order by org_id",
      );
      await db.exec(
        "create view {prefix}public.acme_orgs as select org_id, plan from {prefix}public.org_state /* ask alice@example.com */ where plan = 'secret-plan-name'",
      );
      await db.exec(`grant select on {prefix}public.org_state to ${db.reader.user}`);
      await db.exec(`grant select on {prefix}public.acme_orgs to ${db.reader.user}`);
      try {
        const catalog = await dialect.readCatalog(session, { maxRelations: 100 });
        const state = catalog.relations.find((r) => r.name === "org_state");
        expect(state?.build).toMatchObject({
          engine: "ReplacingMergeTree",
          engineColumns: ["version"],
          sortingKey: "org_id",
        });
        const view = catalog.relations.find((r) => r.name === "acme_orgs");
        expect(view?.kind).toBe("view");
        expect(view?.build?.reads).toEqual([{ schema: `${db.prefix}public`, name: "org_state" }]);
        const definition = view?.build?.definition ?? "";
        expect(definition).toMatch(/org_state/);
        expect(definition).not.toMatch(/secret-plan-name|alice|example\.com/);
      } finally {
        await db.exec("drop view {prefix}public.acme_orgs");
        await db.exec("drop table {prefix}public.org_state");
      }
    });

    it("joins usage to the organizations view: a view as the target, its key unique though one row has none", async () => {
      // feature_usage.org_id → organizations, a view, used not to be found.
      await db.exec(
        "create table {prefix}public.org_rows (org_id Nullable(String), name String, kind String) engine = MergeTree order by tuple()",
      );
      await db.exec(
        "insert into {prefix}public.org_rows values ('10012345', 'Acme', 'customer'), ('10023456', 'Globex', 'partner'), ('10034567', 'Initech', 'partner'), (null, 'Draft', 'none')",
      );
      await db.exec(
        "create view {prefix}public.organizations as select org_id, name, kind from {prefix}public.org_rows",
      );
      await db.exec(
        "create table {prefix}public.feature_usage (org_id String, metric String, value Float64) engine = MergeTree order by org_id",
      );
      await db.exec(
        "insert into {prefix}public.feature_usage select ['10012345', '10023456', '10034567'][number % 3 + 1], 'reports', number from numbers(300)",
      );
      for (const t of ["org_rows", "organizations", "feature_usage"]) {
        await db.exec(`grant select on {prefix}public.${t} to ${db.reader.user}`);
      }
      try {
        const catalog = await dialect.readCatalog(session, { maxRelations: 100 });
        const usage = catalog.relations.find((r) => r.name === "feature_usage");
        if (!usage) throw new Error("no feature_usage");
        const profile = await dialect.profile(session, usage, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
        expect(profile.columns.org_id?.references).toMatchObject({
          table: "organizations",
          column: "org_id",
          overlap: 1,
          declared: false,
        });
        expect(profile.columns.org_id?.sensitivity).toBe("none");
      } finally {
        await db.exec("drop table {prefix}public.feature_usage");
        await db.exec("drop view {prefix}public.organizations");
        await db.exec("drop table {prefix}public.org_rows");
      }
    });

    it("doesn't take a column for a key on a server whose outer joins don't return NULL", async () => {
      // A readonly = 1 user with join_use_nulls = 0: an outer join would fill every missing team with '', which counted
      // as matched, so signups.team_id looked like a key into teams though none of its values is one.
      await db.exec(
        "create table {prefix}public.teams (team_id String, name String) engine = MergeTree order by team_id",
      );
      await db.exec("insert into {prefix}public.teams values ('t1', 'Core'), ('t2', 'Growth'), ('t3', 'Platform')");
      await db.exec(
        "create table {prefix}public.signups (team_id String, n UInt32) engine = MergeTree order by team_id",
      );
      await db.exec(
        "insert into {prefix}public.signups select concat('x', toString(number % 7)), number from numbers(50)",
      );
      const demo = await dialect.open(config(`${db.prefix}demo`), "pw", {
        edition: "community",
        connectTimeoutMs: 3000,
        statementTimeoutMs: 10_000,
        applicationName: "opendash-test",
      });
      try {
        const catalog = await dialect.readCatalog(demo, { maxRelations: 100 });
        const signups = catalog.relations.find((r) => r.name === "signups");
        if (!signups) throw new Error("no signups");
        const profile = await dialect.profile(demo, signups, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
        expect(profile.columns.team_id?.references).toBeUndefined();
      } finally {
        await demo.close();
        await db.exec("drop table {prefix}public.signups");
        await db.exec("drop table {prefix}public.teams");
      }
    });

    it("counts a key unique among its values, however many rows have none", async () => {
      // One row without an org_id used to stop organizations.org_id being a key, so nothing joined to it.
      await db.exec(
        "create table {prefix}public.orgs (org_id Nullable(String), name String) engine = MergeTree order by org_id settings allow_nullable_key = 1",
      );
      await db.exec(
        "insert into {prefix}public.orgs values ('10012345', 'Acme'), ('10023456', 'Globex'), (null, 'Draft')",
      );
      await db.exec(`grant select on {prefix}public.orgs to ${db.reader.user}`);
      try {
        const catalog = await dialect.readCatalog(session, { maxRelations: 100 });
        const orgs = catalog.relations.find((r) => r.name === "orgs");
        if (!orgs) throw new Error("no orgs");
        const profile = await dialect.profile(session, orgs, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
        expect(profile.columns.org_id?.roles).toContain("key");
        // Its ids aren't phone numbers.
        expect(profile.columns.org_id?.sensitivity).toBe("none");
      } finally {
        await db.exec("drop table {prefix}public.orgs");
      }
    });
  });
  describe("query history", () => {
    it("says what to grant when the user can't read the query log", async () => {
      expect(await dialect.queryHistory?.(session, { limit: 50 })).toEqual({
        available: false,
        reason: expect.stringMatching(/can't read system\.query_log\. Grant it SELECT on system\.query_log/),
      });
    });

    it("reads other people's finished SELECTs, normalized, with the tables and columns they read", async () => {
      await db.exec(`grant select on system.query_log to ${db.reader.user}`);
      // One run carries a comment: the same statement, and the comment isn't kept.
      await db.exec(
        "/* ticket 42, ask alice@example.com */ select count() from {prefix}public.plans where name = 'starter'",
      );
      for (let i = 0; i < 2; i++) await db.exec("select count() from {prefix}public.plans where name = 'growth'");
      // The reader's own queries are OpenDash's, never the team's.
      await dialect.execute(session, sql("select id from {p}public.plans where id = 'growth'"), opts);
      await db.exec("system flush logs");
      // The local server's log holds every test run's statements: read them all, or this one can tie at the cut.
      const history = await dialect.queryHistory?.(session, { limit: 1_000_000 });
      expect(history?.available).toBe(true);
      const statements = history?.available ? history.statements : [];
      const mine = statements.filter((s) => s.tables?.includes(`${db.prefix}public.plans`));
      expect(mine).toEqual([
        {
          fingerprint: expect.any(String),
          sql: `select count() from ${db.prefix}public.plans where name = ?`,
          calls: 3,
          totalMs: expect.any(Number),
          tables: [`${db.prefix}public.plans`],
          columns: [`${db.prefix}public.plans.name`],
        },
      ]);
    });
  });
});
