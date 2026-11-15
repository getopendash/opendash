// Query history v0: the team's own statements turned into usage and
// patterns, matched to the catalog by the dialect's own parser, kept normalized, replaced at each mining; and a
// source whose history isn't there says why.
import { type Dialect, type DialectSession, dialectFor, type QueryHistory } from "@opendash/connectors";
import { mysqlAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mineHistory, tablePatterns } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const postgres = dialectFor("postgres");
/** Postgres's own parser and catalog, with a history the test chooses. */
const withHistory = (history: QueryHistory): Dialect => ({ ...postgres, queryHistory: async () => history });
const noSession = { close: async () => {} } as DialectSession;
const job = () => ({ orgId: s.orgId, connectionId: s.connectionId });
const usage = async (fq: string) =>
  Number(
    (
      await s.t.owner<{ usage: number }[]>`
        select usage_score as usage from app.catalog_object where connection_id = ${s.connectionId} and fq_name = ${fq}`
    )[0]?.usage,
  );

const BY_PLAN =
  "select p.name, sum(s.amount_cents) from public.subscriptions s join public.plans p on p.id = s.plan_id where s.status = $1 group by 1";
const BY_COUNTRY = "select count(*) from public.accounts where country = $1";

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("query history", () => {
  it("is skipped, saying what to turn on, when the database doesn't keep it", async () => {
    // The test database has no pg_stat_statements: the real reader, against it.
    const session = { sql: s.t.owner, close: async () => {} } as unknown as DialectSession;
    const result = await mineHistory(s.deps, job(), postgres, session);
    expect(result).toEqual({
      status: "skipped",
      reason: expect.stringMatching(/^pg_stat_statements isn't installed in this database\./),
    });
    // The sync that learned the source says so as its last step.
    const [sync] = await s.t.owner<{ steps: { key: string; status: string; detail?: string }[] }[]>`
      select steps from app.sync_run where connection_id = ${s.connectionId} order by id desc limit 1`;
    expect(sync?.steps.find((x) => x.key === "history")).toMatchObject({
      status: "skipped",
      detail: expect.stringMatching(/pg_stat_statements isn't installed/),
    });
    const mysql = await mineHistory(s.deps, job(), { ...postgres, name: "MySQL", queryHistory: undefined }, noSession);
    expect(mysql).toEqual({ status: "skipped", reason: "OpenDash doesn't read MySQL's query history yet." });
  });

  it("turns the team's statements into usage and patterns, by the tables and columns they read", async () => {
    const result = await mineHistory(
      s.deps,
      job(),
      withHistory({
        available: true,
        statements: [
          { fingerprint: "1", sql: BY_PLAN, calls: 120, totalMs: 900 },
          { fingerprint: "2", sql: BY_COUNTRY, calls: 30, totalMs: 40 },
          {
            fingerprint: "3",
            sql: "with x as (select id from public.users) select count(*) from x",
            calls: 5,
            totalMs: 2,
          },
          // Not in the catalog, partly not in it, or not parseable: skipped.
          { fingerprint: "4", sql: "select * from nowhere.unknown", calls: 999, totalMs: 1 },
          {
            fingerprint: "6",
            sql: "select a.name from public.accounts a join hidden.ledger l on l.account_id = a.id",
            calls: 999,
            totalMs: 1,
          },
          { fingerprint: "5", sql: "select from where", calls: 999, totalMs: 1 },
        ],
      }),
      noSession,
    );
    expect(result).toEqual({ status: "ok", statements: 3, tables: 4 });
    expect(await usage("public.subscriptions")).toBe(120);
    expect(await usage("public.plans")).toBe(120);
    expect(await usage("public.accounts")).toBe(30);
    expect(await usage("public.users")).toBe(5);
    expect(await usage("public.subscriptions.plan_id")).toBe(120);
    expect(await usage("public.subscriptions.status")).toBe(120);
    expect(await usage("public.plans.name")).toBe(120);
    expect(await usage("public.accounts.country")).toBe(30);
    expect(await usage("public.subscriptions.canceled_at")).toBe(0);
    expect(await s.tenant((tx) => tablePatterns(tx, s.orgId, s.connectionId, "public.subscriptions"))).toEqual([
      { sql: BY_PLAN, calls: 120 },
    ]);
  });

  it("gives a table's most-run queries first, by number of runs", async () => {
    const statements = [6, 24, 11, 100, 9].map((calls) => ({
      fingerprint: `n${calls}`,
      sql: `select count(*) from public.accounts where country = $1 and ${calls} = ${calls}`,
      calls,
      totalMs: 1,
    }));
    await mineHistory(s.deps, job(), withHistory({ available: true, statements }), noSession);
    const top = await s.tenant((tx) => tablePatterns(tx, s.orgId, s.connectionId, "public.accounts"));
    expect(top.map((p) => p.calls)).toEqual([100, 24, 11]);
  });

  it("replaces the last mining's, so a statement nobody runs any more goes away", async () => {
    await mineHistory(
      s.deps,
      job(),
      withHistory({ available: true, statements: [{ fingerprint: "2", sql: BY_COUNTRY, calls: 31, totalMs: 40 }] }),
      noSession,
    );
    expect(await usage("public.subscriptions")).toBe(0);
    expect(await usage("public.accounts")).toBe(31);
    const [n] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_pattern where connection_id = ${s.connectionId}`;
    expect(n?.n).toBe(1);
  });

  it("says why when the history has nobody else's reads, or none of known tables, and clears the last mining's", async () => {
    const none = await mineHistory(s.deps, job(), withHistory({ available: true, statements: [] }), noSession);
    expect(none).toEqual({ status: "skipped", reason: expect.stringMatching(/give OpenDash a role of its own/) });
    const [left] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_pattern where connection_id = ${s.connectionId}`;
    expect(left?.n).toBe(0);
    expect(await usage("public.accounts")).toBe(0);
    const elsewhere = await mineHistory(
      s.deps,
      job(),
      withHistory({
        available: true,
        statements: [{ fingerprint: "x", sql: "select * from nowhere.unknown", calls: 5, totalMs: 1 }],
      }),
      noSession,
    );
    expect(elsewhere).toEqual({
      status: "skipped",
      reason: "The one read in its query history isn't of a table OpenDash learned.",
    });
  });

  it("takes the tables and columns a log recorded instead of parsing (ClickHouse)", async () => {
    const result = await mineHistory(
      s.deps,
      job(),
      withHistory({
        available: true,
        statements: [
          {
            fingerprint: "ch",
            sql: "SELECT count() FROM billing.invoices WHERE status = ?",
            calls: 7,
            totalMs: 3,
            tables: ["billing.invoices"],
            columns: ["billing.invoices.status", "billing.invoices.not_a_column"],
          },
        ],
      }),
      noSession,
    );
    expect(result).toEqual({ status: "ok", statements: 1, tables: 1 });
    expect(await usage("billing.invoices")).toBe(7);
    expect(await usage("billing.invoices.status")).toBe(7);
    expect(await usage("billing.invoices.total_cents")).toBe(0);
  });
});

const mysqlUp = await mysqlAvailable();
describe.skipIf(!mysqlUp)("MySQL's recent statements", () => {
  let m: LearnedSource;
  beforeAll(async () => {
    m = await learnedSource({ dialect: "mysql" });
  }, 300_000);
  afterAll(async () => {
    await m?.close();
  });

  it("become usage and patterns from the team's reads, never from OpenDash's own", async () => {
    const my = m.mysql as NonNullable<LearnedSource["mysql"]>;
    const consumer = (on: boolean) =>
      my.exec(
        `update performance_schema.setup_consumers set ENABLED = '${on ? "YES" : "NO"}' where NAME = 'events_statements_history_long'`,
      );
    for (const table of ["setup_consumers", "events_statements_history_long"]) {
      await my.exec(`grant select on performance_schema.${table} to '${my.reader.user}'@'%'`);
    }
    await consumer(true);
    const dialect = dialectFor("mysql");
    const session = await dialect.open(
      { host: my.host, port: my.port, database: my.database, user: my.reader.user, sslMode: "disable" },
      my.reader.password,
      { edition: "community", connectTimeoutMs: 3000, statementTimeoutMs: 10_000, applicationName: "opendash-test" },
    );
    try {
      // A teammate's read, three times with different values (one digest); and one of OpenDash's own.
      for (const id of [1, 2, 3]) await my.exec(`select count(*) from {prefix}public.plans where id > ${id}`);
      await dialect.execute(session, `select name from ${m.prefix}public.plans order by name`, {
        maxRows: 100,
        maxBytes: 100_000,
        timeoutMs: 10_000,
      });
      const result = await mineHistory(m.deps, { orgId: m.orgId, connectionId: m.connectionId }, dialect, session);
      expect(result).toMatchObject({ status: "ok" });
      const plans = `${m.prefix}public.plans`.toLowerCase();
      const patterns = await m.tenant((tx) => tablePatterns(tx, m.orgId, m.connectionId, plans, 10));
      const ours = patterns.find((p) => /count/i.test(p.sql));
      expect(ours?.calls).toBe(3);
      expect(ours?.sql).not.toMatch(/> [123]\b/);
      expect(patterns.some((p) => /order by/i.test(p.sql))).toBe(false);
      const [row] = await m.t.owner<{ usage: number }[]>`
        select usage_score as usage from app.catalog_object where connection_id = ${m.connectionId} and lower(fq_name) = ${plans}`;
      expect(Number(row?.usage)).toBeGreaterThan(0);
    } finally {
      await consumer(false);
      await session.close();
    }
  });
});
