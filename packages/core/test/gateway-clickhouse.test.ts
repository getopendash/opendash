// The query gateway on a ClickHouse source: the demo company in ClickHouse, connected through the normal check and
// learned by the normal sync, then queried. The same guarantees as on Postgres: reference numbers, personal data and
// secrets never returned (traced by the server through CTEs, subqueries and unions), literals and parameters
// grounded, unknown tables refused, suggestions, and a query_run for everything. Skipped when ClickHouse isn't up.
import { clickhouseAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDefinitions, installDefinitions, lookupLiveValues, type QueryRequest, runQuery } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const available = await clickhouseAvailable();
if (!available) console.warn("ClickHouse isn't running (pnpm clickhouse:up): skipping the ClickHouse gateway tests.");

let s: LearnedSource;
const p = () => s.clickhouse?.prefix ?? "";
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

describe.skipIf(!available)("gateway on ClickHouse", () => {
  beforeAll(async () => {
    s = await learnedSource({
      dialect: "clickhouse",
      clickhouseSetup: [
        "create table {prefix}public.integrations (id Int64, kind String, api_token String) engine = MergeTree order by id",
        "insert into {prefix}public.integrations select number, 'slack', concat('tok_', toString(number)) from numbers(5)",
        // A plan changed once: two versions of one row until parts merge.
        "create table {prefix}billing.plan_states (id Int64, plan String, version UInt64) engine = ReplacingMergeTree(version) order by id",
        "insert into {prefix}billing.plan_states values (1, 'starter', 1)",
        "insert into {prefix}billing.plan_states values (1, 'growth', 2)",
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await s?.close();
  });

  it("holds a draft dataset to the advice, and leaves a released one's retest alone", async () => {
    const dataset = (ref: string, from: string) => `ref: ${ref}
label: Plan states
description: Each plan's latest state.
grain: one row per plan
usage_guidance: Use for plans.
primary_key: [id]
sql: |
  select id, plan from ${q(from)}
columns:
  - { name: id, type: number }
  - { name: plan, type: string, dimension: true }
measures:
  - { name: plans, expr: "count()" }
`;
    await s.tenant((tx) =>
      installDefinitions(
        tx,
        { orgId: s.orgId, userId: s.userId },
        s.connectionId,
        {
          datasets: [
            dataset("plan_states_raw", "{p}billing.plan_states"),
            dataset("plan_states_final", "{p}billing.plan_states final"),
          ],
          metrics: [],
        },
        { status: "proposed", source: "user" },
      ),
    );
    const firstCheck = async () => {
      const rows = await s.t.owner<{ slug: string; check: { status: string; detail: string } }[]>`
        select i.slug, v.derived->'checks'->0 as check from app.context_item i
        join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        where i.connection_id = ${s.connectionId} and i.slug like 'plan_states_%'`;
      return Object.fromEntries(rows.map((r) => [r.slug, r.check]));
    };
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId });
    expect(await firstCheck()).toEqual({
      plan_states_raw: {
        name: "Runs on your data",
        status: "failed",
        detail: expect.stringContaining("is a ReplacingMergeTree"),
      },
      plan_states_final: expect.objectContaining({ status: "passed", detail: "1 row" }),
    });
    // Released, it's an admin's: retested as it is.
    await s.t.owner`
      update app.context_item set released_version = current_version, status = 'verified'
      where connection_id = ${s.connectionId} and slug = 'plan_states_raw'`;
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { all: true });
    expect((await firstCheck()).plan_states_raw).toMatchObject({ status: "passed", detail: "2 rows" });
  });

  it("learned the source: tables, roles and personal data", async () => {
    const rows = await s.t.owner<{ fq_name: string; sensitivity: string }[]>`
      select fq_name, sensitivity from app.catalog_object
      where connection_id = ${s.connectionId} and kind = 'column' and sensitivity <> 'none' order by fq_name`;
    const flagged = Object.fromEntries(rows.map((r) => [r.fq_name.replace(p(), ""), r.sensitivity]));
    expect(flagged).toMatchObject({
      "public.users.email": "pii",
      "public.users.full_name": "pii",
      "public.integrations.api_token": "secret",
    });
    const [conn] = await s.t.owner<{ dialect: string; sample: boolean }[]>`
      select dialect, (config->>'sample')::boolean as sample from app.connection where id = ${s.connectionId}`;
    expect(conn).toEqual({ dialect: "clickhouse", sample: true });
  });

  it("runs a query with named parameters and records them", async () => {
    const r = await ask(
      `select p.name as plan, count() as churned
       from {p}public.subscriptions s join {p}public.plans p on p.id = s.plan_id
       join {p}public.accounts a on a.id = s.account_id
       where not a.is_test and s.canceled_at >= {from:DateTime64(3, 'UTC')} and s.canceled_at < {to:DateTime64(3, 'UTC')}
       group by p.name order by p.name`,
      {
        params: [
          { name: "from", value: "2026-09-01 00:00:00" },
          { name: "to", value: "2026-10-01 00:00:00" },
        ],
      },
    );
    expect(r.status).toBe("succeeded");
    expect(r.rows.map((row) => row[0])).toEqual(["Growth", "Scale", "Starter"]);
    const [stored] = await s.t.owner<{ params: { name: string }[] }[]>`
      select params from app.query_run where id = ${r.queryRunId}`;
    expect(stored?.params.map((x) => x.name)).toEqual(["from", "to"]);
  });

  it("runs the server's one-line form of a statement, and keeps it as written for reading", async () => {
    const written = q(`-- Paying accounts only
select count() as accounts
from {p}public.accounts
where not is_test`);
    const r = await ask(written);
    expect(r.status).toBe("succeeded");
    const [stored] = await s.t.owner<{ compiled_sql: string; written_sql: string | null }[]>`
      select compiled_sql, written_sql from app.query_run where id = ${r.queryRunId}`;
    expect(stored?.written_sql).toBe(written);
    expect(stored?.compiled_sql).not.toMatch(/Paying accounts|\n/);
    expect(stored?.compiled_sql).toMatch(/^SELECT count\(\) AS accounts FROM /);
  });

  it.each([
    "select email from {p}public.users",
    "select u.full_name, count() from {p}public.users u group by u.full_name",
    "with x as (select email from {p}public.users) select * from x",
    "select any(email) from {p}public.users",
    "select name from {p}public.plans union all select email from {p}public.users",
    "select * from {p}public.users",
    "with (select email from {p}public.users limit 1) as x select x",
    "select lower(email) as e from {p}public.users",
    "select arrayJoin(groupArray(email)) from {p}public.users",
    "select `x y`, n from (select email as `x y`, 1 as n from {p}public.users) t",
    "select email from {p}public.users u join (select email from {p}public.users) o using (email)",
  ])("never returns personal data: %s", async (sql) => {
    const r = await ask(sql);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("personal_data");
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });

  it("never sends data back inside a server error, and records the text that ran", async () => {
    const r = await ask("select count() from {p}public.users where toInt64(email) > 0");
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("type");
    expect(r.error?.message).toMatch(/CANNOT_PARSE/);
    expect(JSON.stringify(r)).not.toMatch(/@/);
    // Functions that read a value as SQL or as a name: their errors would quote it, at run time or while the
    // analyzer folds constants.
    for (const sql of [
      "select count() from {p}public.users where formatQuery(email) != ''",
      "with (select email from {p}public.users limit 1) as e select formatQuery(e)",
      "with (select email from {p}public.users limit 1) as e select hasColumnInTable(e, 't', 'c')",
      "with (select splitByChar(' ', full_name)[1] from {p}public.users limit 1) as e select hasColumnInTable(e, 't', 'c')",
      // "com" written as a name must not let "maya@acme.com" through as a name the statement wrote.
      "with (select email from {p}public.users limit 1) as e select hasColumnInTable(e, 't', 'c') as com",
    ]) {
      const leak = await ask(sql);
      expect(leak.status).toBe("failed");
      expect(JSON.stringify(leak)).not.toMatch(/@|`[A-Z][a-z]+`/);
    }
    const ok = await ask("select count() as n from {p}public.accounts -- trailing comment");
    const [row] = await s.t.owner<{ compiled_sql: string }[]>`
      select compiled_sql from app.query_run where id = ${ok.queryRunId}`;
    expect(row?.compiled_sql).toBe(q("SELECT count() AS n FROM {p}public.accounts"));
  });

  it("still counts and filters on personal data, and never reads a secret", async () => {
    const counted = await ask("select count(distinct email) as n, uniqExact(phone) as p from {p}public.users");
    expect(counted.status).toBe("succeeded");
    const filtered = await ask("select count() from {p}public.users where email like '%@%'");
    expect(filtered.status).toBe("succeeded");
    const secret = await ask("select count() from {p}public.integrations where api_token = 'x'");
    expect(secret.error?.kind).toBe("personal_data");
    expect(secret.error?.message).toMatch(/secret/);
  });

  it("grounds literals and parameters live when the result found nothing", async () => {
    const literal = await ask("select count() from {p}public.accounts where country = 'Germany'");
    const note = literal.warnings.find((w) => w.includes("'Germany'"));
    expect(note).toMatch(/isn't a value of .*accounts\.country/);
    expect(note).toMatch(/'DE'/);
    const param = await ask("select count() from {p}public.accounts where country = {country:String}", {
      params: [{ name: "country", value: "Germany" }],
    });
    expect(param.warnings.some((w) => w.includes("'Germany'"))).toBe(true);
    const cased = await ask("select count() from {p}public.accounts where country = 'de'");
    expect(cased.warnings.join(" ")).toMatch(/'de' matches .*accounts\.country only as 'DE'/);
  });

  it("looks values up live: those that contain a term, or the most common", async () => {
    const look = (term: string, column: string) =>
      lookupLiveValues(s.deps, {
        orgId: s.orgId,
        connectionId: s.connectionId,
        dialect: "clickhouse",
        requester: { type: "eval", id: null },
        term,
        columns: [q(column)],
      });
    const [plans] = await look("GROW", "{p}public.plans.name");
    expect(plans).toMatchObject({ match: "contains", values: [{ value: "Growth" }] });
    const [country] = await look("Germany", "{p}public.accounts.country");
    expect(country).toMatchObject({ match: "common" });
    expect(country && "values" in country ? country.values.map((v) => v.value) : []).toContain("DE");
  });

  it("refuses a ReplacingMergeTree read without FINAL, with the fix, checked or run, and reads it with FINAL", async () => {
    for (const mode of ["explain", "execute"] as const) {
      const r = await ask("select count() as plans from {p}billing.plan_states", { mode, advise: true });
      expect(r.status).toBe("failed");
      expect(r.error).toMatchObject({
        kind: "refused",
        message: expect.stringContaining(
          `Read it with FINAL to count each key once: from ${p()}billing.plan_states FINAL`,
        ),
      });
    }
    const final = await ask("select count() as plans from {p}billing.plan_states final", { advise: true });
    expect(final).toMatchObject({ status: "succeeded", rows: [["1"]] });
    // SQL the model didn't write (a saved tile, a value read, a verified definition's) runs as it always has.
    for (const extra of [{}, { semantic: { query: { metrics: ["plans"] }, definitions: [] } }]) {
      const other = await ask("select count() as plans from {p}billing.plan_states", extra);
      expect(other).toMatchObject({ status: "succeeded", rows: [["2"]] });
    }
  });

  it("says what ClickHouse needs instead for an error it's known for, from its code", async () => {
    const r = await ask("select sum(count()) as n from {p}public.accounts");
    expect(r.status).toBe("failed");
    expect(r.error?.fix).toMatch(/aggregate in a subquery first/);
  });

  it("refuses unlearned tables, unused or missing parameters, and suggests names for unknown columns", async () => {
    // system.settings is readable by every user, so only the catalog check stops it; system.users the server refuses.
    const system = await ask("select name from system.settings");
    expect(system.error?.kind).toBe("unknown_table");
    // A query without FROM reads ClickHouse's one-row system.one, which is fine.
    const constant = await ask("select toStartOfMonth(toDate('2026-09-15')) as m");
    expect(constant.status).toBe("succeeded");
    const users = await ask("select name from system.users");
    expect(users.status).toBe("failed");
    expect(["unknown_table", "permission"]).toContain(users.error?.kind);
    const unused = await ask("select count() from {p}public.accounts", { params: [{ name: "country", value: "DE" }] });
    expect(unused.error).toMatchObject({ kind: "refused", message: /country isn't used/ });
    const missing = await ask("select count() from {p}public.accounts where country = {country:String}");
    expect(missing.error?.message).toMatch(/uses \{country\} but no parameter has that name/);
    const typo = await ask("select countr from {p}public.accounts");
    expect(typo.error?.kind).toBe("undefined_column");
    expect(typo.error?.suggestions?.some((x) => x.endsWith("accounts.country"))).toBe(true);
  });

  it("refuses a column the catalog hasn't seen yet (added since the last sync), stars included", async () => {
    await s.clickhouse?.exec(
      "alter table {prefix}public.integrations add column contact String default 'a@example.com'",
    );
    try {
      const named = await ask("select contact from {p}public.integrations");
      expect(named.error).toMatchObject({
        kind: "refused",
        message: expect.stringMatching(/isn't in the catalog yet/),
      });
      const star = await ask("select * from {p}public.integrations");
      expect(star.error?.message).toMatch(/in the catalog yet/);
      expect(JSON.stringify(star)).not.toMatch(/example\.com/);
    } finally {
      await s.clickhouse?.exec("alter table {prefix}public.integrations drop column contact");
    }
  });

  it("refuses statements that aren't one read-only SELECT, and records every refusal", async () => {
    for (const sql of [
      "insert into {p}public.plans values ('x', 'x', 1, true, 1)",
      "select 1 format JSON",
      "select * from url('http://127.0.0.1:1/', CSV, 'a String')",
    ]) {
      const r = await ask(sql);
      expect(r.status).toBe("failed");
      const [row] = await s.t.owner<{ status: string }[]>`select status from app.query_run where id = ${r.queryRunId}`;
      expect(row?.status).toBe("failed");
    }
  });
});
