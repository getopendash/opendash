// The query gateway on a MySQL source: the demo company in MySQL, connected through the normal check and learned by
// the normal sync, then queried. The same guarantees as on Postgres and ClickHouse: personal data and secrets never
// returned, no data inside an error, literals grounded, unlearned tables refused, suggestions, and a query_run for
// everything. Skipped when MySQL isn't up.
import { mysqlAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupLiveValues, type QueryRequest, runQuery } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const available = await mysqlAvailable();
if (!available) console.warn("MySQL isn't running (pnpm mysql:up): skipping the MySQL gateway tests.");

let s: LearnedSource;
const p = () => s.mysql?.prefix ?? "";
const q = (sql: string) => sql.replaceAll("{p}", p());
const ask = (sql: string, extra: Partial<QueryRequest> = {}) =>
  runQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    sql: q(sql),
    mode: "execute",
    requester: { type: "eval", id: null },
    ...extra,
  });

describe.skipIf(!available)("gateway on MySQL", () => {
  beforeAll(async () => {
    s = await learnedSource({ dialect: "mysql" });
  }, 300_000);

  afterAll(async () => {
    await s?.close();
  });

  it("learned the source: personal data flagged", async () => {
    const rows = await s.t.owner<{ fq_name: string; sensitivity: string }[]>`
      select fq_name, sensitivity from app.catalog_object
      where connection_id = ${s.connectionId} and kind = 'column' and sensitivity <> 'none' order by fq_name`;
    const flagged = Object.fromEntries(rows.map((r) => [r.fq_name.replace(p(), ""), r.sensitivity]));
    expect(flagged).toMatchObject({ "public.users.email": "pii", "public.users.full_name": "pii" });
  });

  it("runs a query with parameters, bound by the server, and records them", async () => {
    const r = await ask(
      `select pl.name as plan, count(*) as churned
       from {p}public.subscriptions s join {p}public.plans pl on pl.id = s.plan_id
       join {p}public.accounts a on a.id = s.account_id
       where not a.is_test and s.canceled_at >= ? and s.canceled_at < ?
       group by pl.name order by pl.name`,
      {
        params: [
          { name: "from", value: "2026-09-01 00:00:00" },
          { name: "to", value: "2026-10-01 00:00:00" },
        ],
      },
    );
    expect(r.status).toBe("succeeded");
    expect(r.rows.map((row) => row[0])).toEqual(["Growth", "Scale", "Starter"]);
  });

  it.each([
    "select email from {p}public.users",
    "select u.full_name, count(*) from {p}public.users u group by u.full_name",
    "with x as (select email from {p}public.users) select * from x",
    "select max(email) from {p}public.users",
    "select name from {p}public.plans union all select email from {p}public.users",
    "select * from {p}public.users",
    "select lower(email) as e from {p}public.users",
    "select group_concat(email) from {p}public.users",
    "select (select email from {p}public.users limit 1) as x",
    "select t.e from (select email as e from {p}public.users) t",
  ])("never returns personal data: %s", async (sql) => {
    const r = await ask(sql);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("personal_data");
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });

  it("never sends data back inside a server error", async () => {
    // MySQL quotes the value that failed ("Incorrect string value: 'maya@…' for function uuid_to_bin"): the gateway
    // strips quoted text from every error that isn't a name it can check.
    const echoed = await ask("select count(*) from {p}public.users where uuid_to_bin(email) is not null");
    expect(echoed.status).toBe("failed");
    expect(echoed.error?.message).toMatch(/Incorrect string value: '…' for function uuid_to_bin/);
    for (const sql of [
      "select count(*) from {p}public.users where uuid_to_bin(email) is not null",
      "select count(*) from {p}public.users where cast(email as json) is not null",
      "select count(*) from {p}public.users where json_extract(full_name, '$') is not null",
      "select count(*) from {p}public.users where st_geomfromtext(email) is not null",
    ]) {
      const r = await ask(sql);
      expect(r.status).toBe("failed");
      expect(JSON.stringify(r)).not.toMatch(/@|[A-Z][a-z]+ [A-Z][a-z]+/);
      const [stored] = await s.t.owner<
        { error: unknown }[]
      >`select error from app.query_run where id = ${r.queryRunId}`;
      expect(JSON.stringify(stored?.error)).not.toMatch(/@/);
    }
    // Functions whose errors quote the text they're given are refused before they run.
    for (const sql of [
      "select count(*) from {p}public.users where extractvalue(1, concat('~', email)) is not null",
      "select updatexml(null, concat('~', (select email from {p}public.users limit 1)), null) as x",
      "select gtid_subset((select email from {p}public.users limit 1), '') as x",
    ]) {
      const r = await ask(sql);
      expect(r.status).toBe("failed");
      expect(r.error?.kind).toBe("refused");
      expect(JSON.stringify(r)).not.toMatch(/@/);
    }
  });

  it("still counts and filters on personal data", async () => {
    const counted = await ask("select count(distinct email) as n from {p}public.users");
    expect(counted.status).toBe("succeeded");
    const filtered = await ask("select count(*) as n from {p}public.users where email like '%@%'");
    expect(filtered.status).toBe("succeeded");
  });

  it("grounds literals live when the result found nothing", async () => {
    const literal = await ask("select count(*) as n from {p}public.accounts where country = 'Germany'");
    const note = literal.warnings.find((w) => w.includes("'Germany'"));
    expect(note).toMatch(/isn't a value of .*accounts\.country/);
    expect(note).toMatch(/'DE'/);
  });

  it("looks values up live: those that contain a term, or the most common", async () => {
    const look = (term: string, column: string) =>
      lookupLiveValues(s.deps, {
        orgId: s.orgId,
        connectionId: s.connectionId,
        dialect: "mysql",
        requester: { type: "eval", id: null },
        term,
        columns: [q(column)],
      });
    const [plans] = await look("grow", "{p}public.plans.name");
    expect(plans).toMatchObject({ match: "contains", values: [{ value: "Growth" }] });
    const [country] = await look("Germany", "{p}public.accounts.country");
    expect(country).toMatchObject({ match: "common" });
    expect(country && "values" in country ? country.values.map((v) => v.value) : []).toContain("DE");
  });

  it("refuses unlearned tables and statements that aren't one read-only SELECT, recording each", async () => {
    for (const sql of [
      "select user from mysql.user",
      "select table_name from information_schema.tables",
      "insert into {p}public.plans values ('x', 'x', 1, true, 1)",
      "select * from {p}public.plans into outfile '/tmp/plans.csv'",
      "select sleep(1)",
    ]) {
      const r = await ask(sql);
      expect(r.status).toBe("failed");
      const [row] = await s.t.owner<{ status: string }[]>`select status from app.query_run where id = ${r.queryRunId}`;
      expect(row?.status).toBe("failed");
    }
    const typo = await ask("select countr from {p}public.accounts");
    expect(typo.error?.kind).toBe("undefined_column");
    expect(typo.error?.suggestions?.some((x) => x.endsWith("accounts.country"))).toBe(true);
  });
});
