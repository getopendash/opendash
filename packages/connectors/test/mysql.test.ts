// The MySQL adapter against a real server (pnpm mysql:up) and the demo company seeded there: the connection check for
// each kind of user, the statement check, results with caps and types, refusals on the server, the catalog, profiles
// and the value index. Skipped, with a notice, when MySQL isn't running.
import { mysqlAvailable, type SeededMySql, seededMySql } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Check,
  type DialectSession,
  dialectFor,
  judgeGrants,
  type ProbeOptions,
  parseGrants,
  QueryError,
  type SourceConfig,
  type StatementCheck,
} from "../src";

const available = await mysqlAvailable();
if (!available) console.warn("MySQL isn't running (pnpm mysql:up): skipping the MySQL adapter tests.");

const dialect = dialectFor("mysql");
let db: SeededMySql;
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
const check = (text: string) =>
  dialect.validate(sql(text), { session: async () => session, params: [], timeoutMs: 5000 });
const refusal = async (text: string) => {
  const r = await check(text);
  expect(r.ok, text).toBe(false);
  return r as Extract<StatementCheck, { ok: false }>;
};

const CHURNED_BY_PLAN = `
  select p.name as plan,
    round(sum(i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
      / (case when s.billing_interval = 'year' then 12 else 1 end) / 100.0 * coalesce(fx.rate_to_usd, 1)), 2) as churned_mrr
  from {p}public.subscriptions s
  join {p}public.accounts a on a.id = s.account_id
  join {p}public.subscription_items i on i.subscription_id = s.id and i.ended_at = s.canceled_at
  join {p}public.plans p on p.id = i.plan_id
  left join {p}billing.fx_rates fx on fx.currency = s.currency and fx.rate_date = date(s.canceled_at)
  where not a.is_test and s.canceled_at >= ? and s.canceled_at < ?
  group by p.name order by p.name`;

describe.skipIf(!available)("mysql", () => {
  const users = ["writer", "files", "proc"];
  beforeAll(async () => {
    db = await seededMySql();
    const u = (name: string) => `'${db.prefix}${name}'@'%'`;
    for (const name of users) await db.exec(`create user ${u(name)} identified by 'pw'`);
    await db.exec(`grant select, insert on {prefix}public.* to ${u("writer")}`);
    await db.exec(`grant select on {prefix}public.* to ${u("files")}`);
    await db.exec(`grant file on *.* to ${u("files")}`);
    await db.exec(`grant select on {prefix}public.* to ${u("proc")}`);
    await db.exec(`grant process on *.* to ${u("proc")}`);
    session = await dialect.open(config(db.reader.user), db.reader.password, {
      edition: "community",
      connectTimeoutMs: 3000,
      statementTimeoutMs: 10_000,
      applicationName: "opendash-test",
    });
  }, 300_000);

  afterAll(async () => {
    await session?.close();
    if (db) for (const name of users) await db.exec(`drop user if exists '${db.prefix}${name}'@'%'`);
    await db?.drop();
  });

  describe("connection check", () => {
    it("passes a user with SELECT grants only, and sees the sample data", async () => {
      const r = await dialect.probe(config(db.reader.user), db.reader.password, probeOptions);
      expect(r.outcome).toBe("passed");
      expect(status(r.checks)).toEqual({ reach: "ok", "sign-in": "ok", "read-only": "ok", catalog: "ok" });
      expect(r.facts).toMatchObject({ sampleData: true, tables: 12, schemas: 3, writableTables: 0 });
    });

    it("warns about a user that can insert, and blocks one that can read files or other sessions", async () => {
      const writer = await dialect.probe(config(`${db.prefix}writer`), "pw", probeOptions);
      expect(writer.outcome).toBe("warning");
      expect(writer.facts.writePrivileges).toContain("INSERT");
      expect(writer.facts.writableTables).toBe(5);
      const files = await dialect.probe(config(`${db.prefix}files`), "pw", probeOptions);
      expect(files).toMatchObject({ outcome: "blocked", message: expect.stringMatching(/FILE/) });
      const proc = await dialect.probe(config(`${db.prefix}proc`), "pw", probeOptions);
      expect(proc.outcome).toBe("blocked");
      const root = await dialect.probe(config("root"), "opendash", probeOptions);
      expect(root.outcome).toBe("blocked");
    });

    it("says what's wrong with a bad password or an unknown database", async () => {
      const bad = await dialect.probe(config(db.reader.user), "wrong", probeOptions);
      expect(bad).toMatchObject({ outcome: "failed", message: "The user name or password is wrong." });
      expect(status(bad.checks)).toMatchObject({ reach: "ok", "sign-in": "fail" });
      const nodb = await dialect.probe(
        config(db.reader.user, { database: `${db.prefix}nope` }),
        db.reader.password,
        probeOptions,
      );
      expect(nodb.outcome).toBe("failed");
      expect(nodb.message).toMatch(/can't open the database|no database/);
    });

    it("reads privileges and roles from SHOW GRANTS lines", () => {
      const { grants, roles } = parseGrants([
        "GRANT USAGE ON *.* TO `u`@`%`",
        "GRANT SELECT, INSERT, UPDATE (`a`, `b`) ON `db`.* TO `u`@`%`",
        "GRANT `analyst`@`%` TO `u`@`%`",
        "GRANT BACKUP_ADMIN ON *.* TO `u`@`%`",
      ]);
      expect(grants.map((g) => [g.scope, g.privileges])).toEqual([
        ["*.*", ["USAGE"]],
        ["db.*", ["SELECT", "INSERT", "UPDATE"]],
        ["*.*", ["BACKUP_ADMIN"]],
      ]);
      expect(roles).toEqual(["`analyst`@`%`"]);
      expect(judgeGrants(grants)).toMatchObject({ blockedBy: ["BACKUP_ADMIN"], writes: ["INSERT", "UPDATE"] });
      expect(judgeGrants([{ scope: "*.*", privileges: ["ALL PRIVILEGES"] }]).blockedBy).toEqual(["ALL PRIVILEGES"]);
    });
  });

  describe("statement check", () => {
    it("refuses what writes, locks, reads files, waits or sets variables", async () => {
      expect((await refusal("update {p}public.plans set name = 'x'")).kind).toBe("not_a_query");
      expect((await refusal("delete from {p}public.plans")).kind).toBe("not_a_query");
      expect((await refusal("select 1; select 2")).kind).toBe("multiple_statements");
      expect((await refusal("select * from {p}public.plans into outfile '/tmp/x'")).kind).toBe("denied_clause");
      expect((await refusal("select * from {p}public.plans for update")).kind).toBe("locks_rows");
      expect((await refusal("select * from {p}public.plans lock in share mode")).kind).toBe("locks_rows");
      expect((await refusal("select sleep(5)")).kind).toBe("denied_function");
      expect((await refusal("select load_file('/etc/passwd')")).kind).toBe("denied_function");
      expect((await refusal("select benchmark(1000000, md5('x'))")).kind).toBe("denied_function");
      expect((await refusal("select get_lock('x', 10)")).kind).toBe("denied_function");
      expect((await refusal("select @@hostname")).kind).toBe("denied_clause");
      expect((await refusal("select @x := 1")).kind).toBe("denied_clause");
      expect((await refusal("select * from {p}public.plans where (select sleep(1)) = 0")).kind).toBe("denied_function");
      expect((await refusal("selec 1")).kind).toBe("syntax");
      // What the parser accepts and MySQL reads otherwise: a FULL JOIN would run as an inner join with "full" an
      // alias, silently; a :: cast doesn't parse there. Each is told what to write instead.
      for (const full of [
        "select count(*) from {p}public.plans a full join {p}public.plans b using (id)",
        "select count(*) from {p}public.plans a full outer join {p}public.plans b on a.id = b.id",
      ]) {
        expect(await refusal(full), full).toMatchObject({
          kind: "denied_clause",
          message: expect.stringMatching(/LEFT JOIN with a RIGHT JOIN/),
        });
      }
      expect(await refusal("select id::char from {p}public.plans")).toMatchObject({
        kind: "syntax",
        message: expect.stringMatching(/cast\(x as decimal/),
      });
      expect((await check("select '::x', 'fe80::1' as ip from {p}public.plans")).ok).toBe(true);
      // What the server would read and the parser wouldn't: executable comments and hints, -- and #, backslashes.
      for (const hidden of [
        "select u.id /*! , u.email */ from {p}public.users u",
        "select /*+ SET_VAR(max_execution_time = 0) */ 1",
        "select 1 /* note */",
        "select u.id--x\n, u.email from {p}public.users u",
        "select u.id # x\n, u.email from {p}public.users u",
        "select 'a\\', u.email, '' from {p}public.users u",
      ]) {
        expect((await refusal(hidden)).kind, hidden).toBe("denied_clause");
      }
    });

    it("collects tables (not CTEs), literals, parameters in order, aggregates and what's returned", async () => {
      const r = await check(`
        with x as (select a.id from {p}public.accounts a where a.country = 'DE' and a.industry in ('Retail', 'SaaS') and a.id > ?)
        select x.id, count(*) as n, sum(s.amount_cents) as total
        from x join {p}public.subscriptions s on s.account_id = x.id
        where s.status = ? group by x.id`);
      if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.info.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
        `${db.prefix}public.accounts`,
        `${db.prefix}public.subscriptions`,
      ]);
      expect(r.info.literals).toEqual([
        { qualifier: "a", column: "country", values: ["DE"], params: [] },
        { qualifier: "a", column: "industry", values: ["Retail", "SaaS"], params: [] },
        { qualifier: "s", column: "status", values: [], params: [2] },
      ]);
      expect(r.info.params).toEqual([1, 2]);
      expect(r.info.aggregates).toEqual([{ fn: "sum", qualifier: "s", column: "amount_cents" }]);
      const key = (c: { qualifier: string | null; column: string }) => `${c.qualifier}.${c.column}`;
      expect(r.info.returned.map(key).sort()).toEqual(["a.id", "s.amount_cents", "x.id"]);
      expect(r.info.joins).toBe(1);
      const star = await check("select * from {p}public.plans union all select * from {p}public.plans p");
      if (!star.ok) throw new Error("star");
      expect(star.info.stars.map((s) => s.from.map((t) => t.name))).toEqual([["plans"], ["plans"]]);
    });
  });

  describe("execute", () => {
    it("runs a churn query with parameters and returns the generator's numbers", async () => {
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
      expect(r.rows.map(([plan, mrr]) => [plan, Number(mrr)])).toEqual([
        ["Growth", 3600],
        ["Scale", 2100],
        ["Starter", 4100],
      ]);
      expect(r.columns[0]?.source).toMatchObject({ table: "plans", column: "name" });
    });

    it("returns JSON-safe cells: big integers and decimals as exact strings, times as ISO strings in UTC", async () => {
      const r = await dialect.execute(
        session,
        sql(`select count(*) as n, cast(1.5 as decimal(10, 2)) as d, max(created_at) as t, date('2026-09-01') as day,
          max(is_test) as b, cast(null as signed) as z from {p}public.accounts`),
        opts,
      );
      expect(r.columns.map((c) => c.type)).toEqual(["number", "number", "timestamp", "date", "number", "number"]);
      const [n, d, t, day, , z] = r.rows[0] ?? [];
      expect(typeof n).toBe("string");
      expect(d).toBe("1.50");
      expect(String(t)).toMatch(/^2026-10-0\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect([day, z]).toEqual(["2026-09-01", null]);
      const flags = await dialect.execute(session, sql("select is_test from {p}public.accounts limit 1"), opts);
      expect(flags.columns[0]?.type).toBe("boolean");
      expect(typeof flags.rows[0]?.[0]).toBe("boolean");
    });

    it("stops at the row and byte caps on the server, keeps the connection, and says so", async () => {
      const big = sql("select a.id from {p}public.accounts a cross join {p}public.accounts b order by a.id, b.id");
      const rows = await dialect.execute(session, big, { ...opts, maxRows: 10 });
      expect(rows.rows).toHaveLength(10);
      expect(rows.truncated).toBe(true);
      const bytes = await dialect.execute(session, sql("select repeat('x', 1000) from {p}public.accounts"), {
        ...opts,
        maxBytes: 5_000,
      });
      expect(bytes.truncated).toBe(true);
      expect(bytes.bytes).toBeLessThanOrEqual(5_000);
      const after = await dialect.execute(session, "select 1 as one", opts);
      expect(after.rows).toEqual([["1"]]);
    });

    it("stops a slow query at the timeout, on the server", async () => {
      const error = await dialect
        .execute(
          session,
          // A condition on every row, so the server has to evaluate the 6.5 billion of them.
          sql(
            "select count(*) from {p}public.accounts a cross join {p}public.accounts b cross join {p}public.accounts c where a.id + b.id * 7 + c.id * 13 = 1",
          ),
          { ...opts, timeoutMs: 1_000 },
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).info).toMatchObject({ kind: "timeout", message: /longer than 1 s/ });
    });

    it("reads SQL in a known sql_mode, so a double-quoted name is a string as the check reads it", async () => {
      const r = await dialect.execute(session, sql(`select "email" as v from {p}public.users limit 1`), opts);
      expect(r.rows).toEqual([["email"]]);
    });

    it("refuses a write on the server even if the statement check is bypassed", async () => {
      const error = await dialect
        .execute(session, sql("insert into {p}public.plans values ('x', 'x', 1, true, 1)"), opts)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueryError);
      expect(["read_only", "permission"]).toContain((error as QueryError).info.kind);
    });

    it("explains without running, and names an unknown column", async () => {
      const plan = await dialect.explain(session, sql("select count(*) from {p}public.accounts"), { timeoutMs: 5000 });
      expect(plan.ok).toBe(true);
      const bad = await dialect.explain(session, sql("select a.nope from {p}public.accounts a"), { timeoutMs: 5000 });
      expect(bad).toMatchObject({ ok: false, error: { kind: "undefined_column", name: "nope" } });
    });
  });

  describe("query history", () => {
    it("says which two tables to grant and which consumer to turn on, then reads the team's, never OpenDash's own", async () => {
      const consumer = (on: boolean) =>
        db.exec(
          `update performance_schema.setup_consumers set ENABLED = '${on ? "YES" : "NO"}' where NAME = 'events_statements_history_long'`,
        );
      const reader = `'${db.reader.user}'@'%'`;
      // Without the grant: says which two tables to grant, never performance_schema.*.
      const denied = await dialect.queryHistory?.(session, { limit: 50 });
      expect(denied).toMatchObject({
        available: false,
        reason: expect.stringMatching(/setup_consumers and .*events_statements_history_long/),
      });
      await db.exec(`grant select on performance_schema.setup_consumers to ${reader}`);
      await db.exec(`grant select on performance_schema.events_statements_history_long to ${reader}`);
      await consumer(false);
      const off = await dialect.queryHistory?.(session, { limit: 50 });
      expect(off).toMatchObject({ available: false, reason: expect.stringMatching(/events_statements_history_long/) });
      await consumer(true);
      try {
        // A teammate's query (another user, on its own connection), and OpenDash's own through its session.
        await db.exec(sql("select count(*) from {p}public.plans where id > 1"));
        await dialect.execute(session, sql("select count(*) as n from {p}public.accounts where id > ?"), {
          ...opts,
          params: [{ name: "id", value: 1 }],
        });
        const history = await dialect.queryHistory?.(session, { limit: 500 });
        expect(history?.available).toBe(true);
        const statements = history?.available ? history.statements : [];
        // This run's statements (the server's buffer keeps others' from before).
        const texts = statements.map((s) => s.sql.toLowerCase()).filter((t) => t.includes(db.prefix.toLowerCase()));
        expect(texts.some((t) => t.includes("plans"))).toBe(true);
        expect(texts.some((t) => t.includes("accounts") && t.includes("count"))).toBe(false);
        expect(statements.every((s) => /^(select|with) /i.test(s.sql) && s.calls >= 1)).toBe(true);
        // Literals are the digest's `?`, never the value.
        expect(texts.find((t) => t.includes("plans"))).toMatch(/> \?/);
        // The digest's own spelling (`db` . `t`, COUNT ( * )) reads as a statement, its tables found, as core does.
        const digest = statements.find((s) => s.sql.includes(`${db.prefix}public`) && /plans/i.test(s.sql))
          ?.sql as string;
        const read = await dialect.validate(digest, { session: async () => session, params: [], timeoutMs: 5000 });
        expect(read.ok ? read.info.tables.map((t) => `${t.schema}.${t.name}`) : read).toEqual([
          `${db.prefix}public.plans`,
        ]);
      } finally {
        await consumer(false);
      }
    });
  });

  describe("functions the database defines", () => {
    it("runs MySQL's own functions only: a stored one, named or qualified, is refused before anything runs", async () => {
      await db.exec(
        "create function {prefix}public.peek_emails() returns text reads sql data deterministic return (select group_concat(email) from {prefix}public.users)",
      );
      try {
        const check = (sql: string) =>
          dialect.validate(sql, { session: async () => session, params: [], timeoutMs: 5_000 });
        expect(await check("select peek_emails() as e")).toMatchObject({ ok: false, kind: "denied_function" });
        expect(await check(`select ${db.prefix}public.peek_emails() as e`)).toMatchObject({
          ok: false,
          kind: "denied_function",
        });
        expect((await check("select count(*), max(created_at), date_format(now(), '%Y') from accounts")).ok).toBe(true);
        // By exact name: no prefix makes a name MySQL's own.
        expect(await check("select st_peek() as e")).toMatchObject({ ok: false, kind: "denied_function" });
        // A listed name the database defines a function by too (one an older server may not have built in) is asked
        // of the server, and refused. A reader sees the functions it may call (EXECUTE, from its next connection).
        await db.exec(
          "create function {prefix}public.json_pretty(j text) returns text reads sql data deterministic return (select group_concat(email) from {prefix}public.users)",
        );
        await db.exec(`grant execute on {prefix}public.* to '${db.reader.user}'@'%'`);
        const fresh = await dialect.open(config(db.reader.user), db.reader.password, {
          edition: "community",
          connectTimeoutMs: 3000,
          statementTimeoutMs: 10_000,
          applicationName: "opendash-test",
        });
        try {
          const shadowed = await check("select json_pretty('{}') as e");
          if (!shadowed.ok) throw new Error("expected json_pretty() to parse");
          expect(await dialect.refuseCalls?.(fresh, shadowed.info)).toMatch(
            /json_pretty\(\) is defined in the database/,
          );
          const plain = await check("select count(*), max(created_at) from accounts");
          if (!plain.ok) throw new Error("expected a count to parse");
          expect(await dialect.refuseCalls?.(fresh, plain.info)).toBeNull();
        } finally {
          await fresh.close();
          await db.exec(`revoke execute on {prefix}public.* from '${db.reader.user}'@'%'`);
        }
      } finally {
        await db.exec("drop function {prefix}public.peek_emails");
        await db.exec("drop function if exists {prefix}public.json_pretty");
      }
    });
  });

  describe("learning", () => {
    it("keeps a view's definition without the values written into it, and the tables it reads", async () => {
      await db.exec(
        "create view {prefix}public.acme_accounts as select a.id, a.country from {prefix}public.accounts a /* ask alice@example.com */ where a.country = 'secret-country'",
      );
      await db.exec(`grant show view on {prefix}public.* to '${db.reader.user}'@'%'`);
      // A database grant reaches a session at its next connection: a reader granted SHOW VIEW has it from the start.
      const fresh = await dialect.open(config(db.reader.user), db.reader.password, {
        edition: "community",
        connectTimeoutMs: 3000,
        statementTimeoutMs: 10_000,
        applicationName: "opendash-test",
      });
      try {
        const catalog = await dialect.readCatalog(fresh, { maxRelations: 100 });
        const view = catalog.relations.find((r) => r.name === "acme_accounts");
        expect(view?.kind).toBe("view");
        expect(view?.build?.reads).toEqual([{ schema: `${db.prefix}public`, name: "accounts" }]);
        expect(view?.build?.definition).toMatch(/accounts/);
        expect(view?.build?.definition).not.toMatch(/secret-country|alice|example\.com/);
      } finally {
        await fresh.close();
        await db.exec("drop view {prefix}public.acme_accounts");
      }
    });

    it("reads the catalog with its keys and joins, profiles tables, and indexes values", async () => {
      const catalog = await dialect.readCatalog(session, { maxRelations: 100 });
      expect(catalog.relations).toHaveLength(12);
      expect(catalog.schemas.map((s) => s.name).sort()).toEqual(
        ["billing", "public", "support"].map((s) => `${db.prefix}${s}`).sort(),
      );
      const subs = catalog.relations.find((r) => r.name === "subscriptions");
      if (!subs) throw new Error("no subscriptions");
      expect(subs.primaryKey).toEqual(["id"]);
      expect(subs.foreignKeys).toContainEqual({
        columns: ["account_id"],
        refSchema: `${db.prefix}public`,
        refTable: "accounts",
        refColumns: ["id"],
      });
      expect(subs.columns.find((c) => c.name === "amount_cents")?.comment).toMatch(/cents/);
      const profile = await dialect.profile(session, subs, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
      expect(profile.columns.id?.roles).toContain("key");
      expect(profile.columns.amount_cents?.roles).toContain("amount_cents");
      expect(profile.columns.status?.roles).toContain("category");
      expect(profile.columns.account_id?.references).toMatchObject({ table: "accounts", column: "id", declared: true });
      expect(profile.freshness?.max).toMatch(/Z$/);
      const people = catalog.relations.find((r) => r.name === "users");
      if (!people) throw new Error("no users");
      const userProfile = await dialect.profile(session, people, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
      expect(userProfile.columns.email?.sensitivity).toBe("pii");
    });
  });
});
