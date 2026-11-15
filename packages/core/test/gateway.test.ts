// The query gateway against the learned demo company: reference numbers, refusals at every layer, grounding with
// suggestions, sanity checks, caps, and a query_run for everything.
import { CHURNED_MRR_BY_PLAN_SQL, generateSaas, MRR_SQL, monthMrr } from "@opendash/evals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emptyResult,
  getSource,
  loadCatalogIndex,
  lookupLiveValues,
  nameWritten,
  type QueryRequest,
  redactError,
  runQuery,
  sourceExposure,
  sourceQueryError,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const inline = (sql: string, params: string[]) => params.reduce((q, p, i) => q.replaceAll(`$${i + 1}`, `'${p}'`), sql);
const ask = (sql: string, extra: Partial<QueryRequest> = {}) =>
  runQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    sql,
    mode: "execute",
    requester: { type: "eval", id: null },
    ...extra,
  });
const traced = async (id: string) =>
  (
    await s.t.owner<
      {
        status: string;
        mode: string;
        rows: number | null;
        error: { kind: string } | null;
        preview: unknown[][] | null;
        sanity: unknown[];
      }[]
    >`
      select status, mode, rows, error, preview, sanity from app.query_run where id = ${id}`
  )[0];

beforeAll(async () => {
  s = await learnedSource({
    setup: `create table public.integrations (id int primary key, kind text, api_token text);
            insert into public.integrations select g, 'slack', 'tok_' || g from generate_series(1, 5) g;`,
  });
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("running queries", () => {
  it("never reaches the source for a run already cancelled: it's recorded as cancelled", async () => {
    const stop = new AbortController();
    stop.abort();
    const out = await ask("select count(*) from public.plans", { signal: stop.signal });
    expect(out).toMatchObject({ status: "cancelled", error: { kind: "cancelled" } });
    expect(await traced(out.queryRunId)).toMatchObject({ status: "cancelled" });
    const explained = await ask("select count(*) from public.plans", { signal: stop.signal, mode: "explain" });
    expect(explained).toMatchObject({ status: "cancelled" });
  });

  it("returns the demo company's reference numbers, and records the run", async () => {
    const mrr = await ask(inline(MRR_SQL, ["2026-10-01T00:00:00Z"]), { title: "MRR, September 2026" });
    expect(mrr.status).toBe("succeeded");
    expect(Number(mrr.rows[0]?.[0])).toBeCloseTo(monthMrr(generateSaas(), 2026, 8), 1);
    const run = await traced(mrr.queryRunId);
    expect(run).toMatchObject({ status: "succeeded", mode: "execute", rows: 1 });
    expect(run?.preview?.[0]).toEqual(mrr.rows[0]);

    const churn = await ask(inline(CHURNED_MRR_BY_PLAN_SQL, ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"]));
    expect(churn.rows).toEqual([
      ["Growth", 3600],
      ["Scale", 2100],
      ["Starter", 4100],
    ]);
  });

  it("records what a statement read: its tables and the values it compared columns with", async () => {
    const out = await ask(
      "select p.name, count(*) as n from public.subscriptions s join public.plans p on p.id = s.plan_id where s.status = 'active' and p.name in ('Growth', 'Scale') group by p.name",
    );
    expect(out.status).toBe("succeeded");
    const [row] = await s.t.owner<{ reads: unknown }[]>`select reads from app.query_run where id = ${out.queryRunId}`;
    expect(row?.reads).toEqual({
      tables: ["public.subscriptions", "public.plans"],
      compared: [
        { table: "public.subscriptions", column: "status", values: ["active"] },
        { table: "public.plans", column: "name", values: ["Growth", "Scale"] },
      ],
    });
    // A refused one says what it would have read, too.
    const refused = await ask("select api_token from public.integrations");
    const [kept] = await s.t.owner<{ reads: { tables: string[] } | null }[]>`
      select reads from app.query_run where id = ${refused.queryRunId}`;
    expect(kept?.reads?.tables).toEqual(["public.integrations"]);
  });

  it("warns when a query divides integers, with the cast to use", async () => {
    const r = await ask(
      "select count(*) filter (where i.status = 'paid') / count(*) as share, count(*) / count(*) as again, sum(i.total_cents)::numeric / count(*) as average from billing.invoices i",
      { advise: true },
    );
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("succeeded");
    expect(r.warnings).toContain(
      "count(…) / count(…) divides integers, so Postgres rounds it down: cast one side first (count(…)::numeric / count(…)).",
    );
    expect(r.warnings.filter((w) => w.includes("divides integers"))).toHaveLength(1);
  });

  it("keeps a bounded preview and says when a result was cut", async () => {
    const all = await ask("select id, total_cents from billing.invoices order by id");
    expect(all.truncated).toBe(true);
    expect(all.rows.length).toBeLessThanOrEqual(100);
    expect(all.warnings.join(" ")).toMatch(/Only the first 1000 rows/);
  });
});

describe("refusals, at every layer", () => {
  it.each([
    [
      "insert into public.plans (id, name, unit_amount_cents, per_seat, min_seats) values ('x', 'x', 1, false, 1)",
      "refused",
    ],
    ["select 1; delete from public.plans", "refused"],
    ["with gone as (delete from public.plans returning *) select * from gone", "refused"],
    ["select pg_sleep(30)", "refused"],
    ["selec 1", "syntax"],
  ])("%s", async (sql, kind) => {
    const r = await ask(sql);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe(kind);
    expect((await traced(r.queryRunId))?.status).toBe("failed");
  });

  it("doesn't query a disabled source, or one whose last check failed, until a check passes", async () => {
    const set = (status: string, error: string | null) =>
      s.t.owner`update app.connection set status = ${status}, last_error = ${error} where id = ${s.connectionId}`;
    await set("error", "This user reaches beyond your data.");
    await expect(ask("select count(*) from public.plans")).rejects.toThrow(/failed its last check: This user reaches/);
    await set("disabled", null);
    await expect(ask("select count(*) from public.plans")).rejects.toThrow(/disabled/);
    await set("ok", null);
    expect((await ask("select count(*) from public.plans")).status).toBe("succeeded");
  });
});

describe("a source whose queries can't connect", () => {
  it("shows as failing with the reason until a query gets through", async () => {
    const user = (name: string) =>
      s.t
        .owner`update app.connection set config = jsonb_set(config, '{user}', ${s.t.owner.json(name)}) where id = ${s.connectionId}`;
    const [row] = await s.t.owner<{ was: string }[]>`
      select config->>'user' as was from app.connection where id = ${s.connectionId}`;
    const was = row?.was ?? "";
    const read = () => s.deps.withTenant(s.orgId, (tx) => sourceQueryError(tx, s.orgId, s.connectionId));
    const status = async () =>
      (await s.deps.withTenant(s.orgId, (tx) => getSource(tx, s.orgId, s.connectionId)))?.status;
    expect(await read()).toBeNull();
    try {
      await user("nobody_here");
      const refused = await ask("select count(*) from public.plans");
      expect(refused).toMatchObject({ status: "failed", error: { kind: "connection" } });
      expect(await read()).toMatch(/password|user|authentic/i);
      expect(await status()).toBe("failing");
      // A query refused for its own reasons says nothing about the source.
      await user(was);
      expect((await ask("delete from public.plans")).status).toBe("failed");
      expect(await status()).toBe("failing");
      expect((await ask("select count(*) from public.plans")).status).toBe("succeeded");
      expect(await read()).toBeNull();
      expect(await status()).not.toBe("failing");
    } finally {
      await user(was);
    }
  });
});

describe("source limits", () => {
  it("reads no more rows than the source allows", async () => {
    await s.t.owner`update app.connection set limits = ${s.t.owner.json({ maxRows: 10 })} where id = ${s.connectionId}`;
    const r = await ask("select id from public.accounts order by id");
    expect(r.status).toBe("succeeded");
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    await s.t.owner`update app.connection set limits = '{}'::jsonb where id = ${s.connectionId}`;
    expect((await ask("select id from public.accounts order by id limit 20")).rows).toHaveLength(20);
  });
});

describe("grounding", () => {
  it("rejects a table the catalog doesn't have and names the closest ones", async () => {
    const r = await ask("select count(*) from public.account");
    expect(r.error).toMatchObject({ kind: "unknown_table" });
    expect(r.error?.suggestions?.[0]).toBe("public.accounts");
  });

  it("explains an unknown column with the closest real columns", async () => {
    const r = await ask("select a.nme from public.accounts a");
    expect(r.error?.kind).toBe("undefined_column");
    expect(r.error?.suggestions).toContain("public.accounts.name");
  });

  it("runs a query with parameters, and records them with their names", async () => {
    const r = await ask(CHURNED_MRR_BY_PLAN_SQL, {
      params: [
        { name: "from", value: "2026-09-01T00:00:00Z" },
        { name: "to", value: "2026-10-01T00:00:00Z" },
      ],
    });
    expect(r.status).toBe("succeeded");
    expect(r.rows).toEqual([
      ["Growth", 3600],
      ["Scale", 2100],
      ["Starter", 4100],
    ]);
    const [stored] = await s.t.owner<{ params: unknown; compiled_sql: string; written_sql: string | null }[]>`
      select params, compiled_sql, written_sql from app.query_run where id = ${r.queryRunId}`;
    expect(stored?.params).toEqual([
      { name: "from", value: "2026-09-01T00:00:00Z" },
      { name: "to", value: "2026-10-01T00:00:00Z" },
    ]);
    expect(stored?.compiled_sql).toBe(CHURNED_MRR_BY_PLAN_SQL);
    // Postgres runs the statement as written: there's no second text to keep.
    expect(stored?.written_sql).toBeNull();
  });

  it("grounds parameter values like literals, looked up live when the result found nothing", async () => {
    const one = await ask("select count(*) from public.accounts a where a.country = $1", {
      params: [{ name: "country", value: "Germany" }],
    });
    const note = one.warnings.find((w) => w.includes("'Germany'"));
    expect(note).toMatch(/\$1 country/);
    expect(note).toMatch(/isn't a value of public\.accounts\.country\. Its most common values: .*'DE'/);
    // Kept with the query, so its card shows it after the run.
    expect((await traced(one.queryRunId))?.sanity).toContainEqual({ check: "value", status: "warn", message: note });
    // An empty result: the value the column has says nothing, the one it doesn't is named.
    const list = await ask(
      "select count(*) from public.accounts where country = any($1) and created_at > now() + interval '10 years'",
      { params: [{ name: "countries", value: ["DE", "Frankreich"] }] },
    );
    expect(list.warnings.some((w) => w.includes("'Frankreich'"))).toBe(true);
    expect(list.warnings.some((w) => w.startsWith("'DE'"))).toBe(false);
  });

  it.each([
    ["select count(*) from public.accounts where country = $1", [], /uses \$1 but no parameters were given/],
    [
      "select count(*) from public.accounts where country = $2",
      [
        { name: "a", value: "DE" },
        { name: "b", value: "US" },
      ],
      /\$1 \(a\) isn't used/,
    ],
    ["select count(*) from public.accounts", [{ name: "country", value: "DE" }], /isn't used in the SQL/],
    ["select count(*) from public.accounts where country = $1", [{ name: "Country!", value: "DE" }], /name/],
    [
      "select count(*) from public.accounts where country = $1",
      [{ name: "c", value: { nested: true } as never }],
      /a value is text/,
    ],
  ])("refuses parameters that don't fit the SQL: %s", async (sql, params, message) => {
    const r = await ask(sql, { params });
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("refused");
    expect(r.error?.message).toMatch(message);
  });

  it("warns when a literal isn't a value of its column, and lists what it has: in another case, containing it, or the most common", async () => {
    const r = await ask("select count(*) from public.accounts a where a.country = 'Germany'");
    expect(r.status).toBe("succeeded");
    const note = r.warnings.find((w) => w.includes("'Germany'"));
    expect(note).toMatch(/isn't a value of public\.accounts\.country/);
    expect(note).toMatch(/'DE'/);
    const cased = await ask("select count(*) from public.accounts a where a.country = 'de'");
    expect(cased.warnings).toContain("'de' matches public.accounts.country only as 'DE' (different case); use 'DE'.");
    const part = await ask("select count(*) from billing.payments where method = 'sepa'");
    expect(part.warnings.join(" ")).toMatch(
      /'sepa' isn't a value of billing\.payments\.method\. Values that contain it: 'sepa_debit'/,
    );
    // A result that found something isn't checked: no warehouse query is spent on it.
    const fine = await ask("select count(*) from public.accounts where country = 'DE'");
    expect(fine.warnings.filter((w) => w.includes("'DE'"))).toEqual([]);
    const [runs] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_run where org_id = ${s.orgId} and id = ${fine.queryRunId}`;
    expect(runs?.n).toBe(1);
  });

  it("calls a result empty when it has no rows, or one row whose numbers are all zero or empty", () => {
    const n = { name: "n", type: "number" as const };
    const label = { name: "plan", type: "text" as const };
    expect(emptyResult({ columns: [n], rows: [] })).toBe(true);
    expect(emptyResult({ columns: [n], rows: [["0"]] })).toBe(true);
    expect(emptyResult({ columns: [n, n], rows: [[null, 0]] })).toBe(true);
    expect(emptyResult({ columns: [n], rows: [["3"]] })).toBe(false);
    expect(emptyResult({ columns: [label], rows: [["Growth"]] })).toBe(false);
    expect(
      emptyResult({
        columns: [label, n],
        rows: [
          ["Growth", 0],
          ["Scale", 0],
        ],
      }),
    ).toBe(false);
  });

  it("checks without running: grounding plus the server's plan", async () => {
    const ok = await ask("select count(*) from public.accounts", { mode: "explain" });
    expect(ok).toMatchObject({ status: "succeeded", rows: [] });
    expect((await traced(ok.queryRunId))?.mode).toBe("explain");
    const bad = await ask("select nope from public.accounts", { mode: "explain" });
    expect(bad.error?.kind).toBe("undefined_column");
  });
});

describe("sanity checks", () => {
  it("flags zero rows", async () => {
    const r = await ask("select id, name from public.accounts where created_at > date '2099-01-01'");
    expect(r.checks.find((c) => c.check === "zero_rows")?.status).toBe("warn");
  });

  it("flags a sum after a join that repeats rows (fan-out)", async () => {
    const r = await ask(`
      select sum(s.amount_cents) from public.subscriptions s
      join billing.invoices i on i.subscription_id = s.id`);
    expect(r.checks.find((c) => c.check === "fan_out")).toMatchObject({ status: "warn" });
    const safe = await ask("select sum(amount_cents) from public.subscriptions");
    expect(safe.checks.find((c) => c.check === "fan_out")?.status).toBe("pass");
  });

  it("flags a partial last period", async () => {
    // Months up to the one under way, whenever it runs: the demo data ends on a fixed day (AS_OF), so its own months
    // stop being current once the calendar passes it.
    const r = await ask(`
      select m as month, count(*) from public.accounts
      cross join generate_series(date_trunc('month', now()) - interval '2 months', date_trunc('month', now()),
        interval '1 month') m
      group by 1 order by 1`);
    expect(r.checks.find((c) => c.check === "partial_period")).toMatchObject({ status: "warn" });
  });

  it("flags empty measures", async () => {
    const r = await ask(
      "select a.id, max(s.canceled_at) as last_cancel, sum(case when false then 1 end) as nothing from public.accounts a left join public.subscriptions s on s.account_id = a.id group by a.id limit 5",
    );
    expect(r.checks.find((c) => c.check === "null_measures")?.status).toBe("warn");
  });
});

describe("personal and secret data", () => {
  it.each([
    "select email from public.users",
    "select u.full_name, count(*) from public.users u group by 1",
    "select * from public.users limit 5",
    "select u.* from public.users u",
    "select to_jsonb(u) from public.users u limit 1",
    "select string_agg(email, ', ') from public.users",
    "with x as (select billing_email from public.accounts) select * from x",
    "select id::text from public.accounts union select email from public.users",
    "select name from public.plans union all table public.users",
    "select (u).email from public.users u",
    "with x as (select 1) select (select email from public.users limit 1) as e from x",
    "select lower(email) from public.users",
  ])("never returns their values: %s", async (sql) => {
    const r = await ask(sql);
    expect(r.error?.kind).toBe("personal_data");
    expect(r.error?.message).toMatch(/personal data/);
    expect(r.rows).toEqual([]);
  });

  it("has a second check that doesn't depend on reading the SQL: the server's column sources", async () => {
    const index = await s.tenant((tx) => loadCatalogIndex(tx, s.orgId, s.connectionId));
    expect(
      sourceExposure(
        [
          { name: "contact", type: "text", source: { schema: "public", table: "users", column: "email" } },
          { name: "n", type: "number" },
        ],
        index,
      ),
    ).toEqual(["public.users.email"]);
    expect(
      sourceExposure(
        [{ name: "x", type: "text", source: { schema: "public", table: "accounts", column: "country" } }],
        index,
      ),
    ).toEqual([]);
  });

  it("still lets a query count and filter on them", async () => {
    const counted = await ask("select count(distinct email) from public.users where email like '%.test'");
    expect(counted.status).toBe("succeeded");
    const grouped = await ask(
      "with x as (select country, count(distinct billing_email) as n from public.accounts group by 1) select * from x",
    );
    expect(grouped.status).toBe("succeeded");
  });

  it("refuses any use of a secret column", async () => {
    const r = await ask("select count(*) from public.integrations where api_token = 'tok_1'");
    expect(r.error?.kind).toBe("personal_data");
    expect(r.error?.message).toMatch(/public\.integrations\.api_token is a secret/);
    const fine = await ask("select kind, count(*) from public.integrations group by 1");
    expect(fine.status).toBe("succeeded");
  });
});

describe("value lookup, read live", () => {
  const look = (term: string, columns: string[]) =>
    lookupLiveValues(s.deps, {
      orgId: s.orgId,
      connectionId: s.connectionId,
      dialect: "postgres",
      requester: { type: "eval", id: null },
      term,
      columns,
    });

  it("reads the values of each named column that contain the term, most common first, as recorded queries", async () => {
    const [plans] = await look("grow", ["public.plans.name"]);
    expect(plans).toMatchObject({ column: "public.plans.name", match: "contains", values: [{ value: "Growth" }] });
    const [run] = await s.t.owner<{ title: string; requester_type: string }[]>`
      select title, requester_type from app.query_run where id = ${plans && "queryRunId" in plans ? plans.queryRunId : null}`;
    expect(run).toEqual({ title: "Values of public.plans.name containing “grow”", requester_type: "eval" });
  });

  it("gives a column's most common values when none contains the term, so Germany still finds 'DE'", async () => {
    const [country] = await look("Germany", ["public.accounts.country"]);
    expect(country).toMatchObject({ match: "common" });
    expect(country && "values" in country ? country.values.map((v) => v.value) : []).toContain("DE");
    const [method] = await look("sepa debit", ["billing.payments.method"]);
    expect(method && "values" in method ? method.values.map((v) => v.value) : []).toContain("sepa_debit");
  });

  it("never returns personal data, and says why for a column it can't read", async () => {
    const [email, nope] = await look("billing@", ["public.users.email", "public.nope.name"]);
    expect(email).toMatchObject({ column: "public.users.email", problem: expect.stringMatching(/personal data/) });
    expect(nope).toMatchObject({ column: "public.nope.name", problem: expect.any(String) });
  });
});

// Runs last: it changes the source and the catalog.
describe("closing the gaps around personal data", () => {
  it("refuses a table the catalog hasn't learned, even when the last sync was capped", async () => {
    await s.source.exec(`create table public.contacts (id int, email text); insert into public.contacts values (1, 'maya@acme.com');
      grant select on public.contacts to ${s.source.reader.user}`);
    await s.t
      .owner`update app.sync_run set facts = facts || '{"truncated": true}' where connection_id = ${s.connectionId}`;
    const r = await ask("select email from public.contacts");
    expect(r.error?.kind).toBe("unknown_table");
    expect(r.error?.message).toMatch(/only the first tables were learned/);
    expect(JSON.stringify(r)).not.toContain("maya@");
  });

  it("names an unknown name only when every part of it is an identifier the statement wrote", () => {
    expect(nameWritten("public.acounts", ["public", "acounts", "count"])).toBe(true);
    expect(nameWritten("maya@acme.com", ["com", "maya"])).toBe(false);
    expect(nameWritten("Omar", [])).toBe(false);
  });

  it("never sends data back in an error from a cast that reads a value as a name or a query", async () => {
    for (const sql of [
      "select count(*) from public.users where email::regclass is not null",
      "select count(*) from public.users where full_name::regclass is not null",
      "select count(*) from public.users where split_part(full_name, ' ', 1)::regclass is not null",
      "select count(*) from public.users where full_name::regproc is not null",
      "select count(*) from public.users where (full_name || ' &')::tsquery is not null",
    ]) {
      const r = await ask(sql);
      expect(r.status).toBe("failed");
      expect(JSON.stringify(r)).not.toMatch(/@|Lopez|Maya|[A-Z][a-z]+ [A-Z][a-z]+/);
    }
  });

  it("closes known holes: a CTE named like a table, an alias bound twice, SQL run inside a function", async () => {
    // Each once returned public.users.email past every check.
    for (const sql of [
      "select u.email || '' from public.users u where exists (with users as (select 1) select 1 from users)",
      "with users as (select email from public.users) select email || '' from users",
      "select u.email || '' from public.users u where exists (select 1 from public.accounts u where u.id = 1)",
    ]) {
      const r = await ask(sql);
      expect(r.status).toBe("failed");
      expect(r.error?.kind).toBe("personal_data");
      expect(JSON.stringify(r)).not.toMatch(/@/);
    }
    // An operator the database defines, in a statement that calls no function: the server is asked all the same.
    await s.source.exec(`create function public.leak_op(text, int) returns boolean language sql security definer
        as $$ select exists (select 1 from public.users) $$;
      create operator public.===> (leftarg = text, rightarg = int, function = public.leak_op)`);
    try {
      const op = await ask("select 'a'::text ===> 1 as x");
      expect(op.error?.kind).toBe("refused");
      expect(op.error?.message).toMatch(/operator ===> is defined in the database/);
    } finally {
      await s.source.exec("drop operator public.===> (text, int); drop function public.leak_op(text, int)");
    }
    const inside = await ask("select word from ts_stat($$select to_tsvector('simple', email) from public.users$$)");
    expect(inside.error?.kind).toBe("refused");
    expect(inside.error?.message).toMatch(/ts_stat\(\) isn't allowed/);
  });

  it("never sends data back inside a server error", async () => {
    const r = await ask("select count(*) from public.users where email::int > 0");
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("type");
    expect(r.error?.message).toMatch(/invalid input syntax for type integer/);
    expect(JSON.stringify(r)).not.toMatch(/@/);
    const [stored] = await s.t.owner<{ error: unknown }[]>`select error from app.query_run where id = ${r.queryRunId}`;
    expect(JSON.stringify(stored?.error)).not.toMatch(/@/);
    // A value with quotes of its own: they once ended the redaction early, and the email came through.
    const quoted = await ask(`select count(*) from public.users where ('"' || email || '"')::int = 0`);
    expect(quoted.status).toBe("failed");
    expect(JSON.stringify(quoted)).not.toMatch(/@/);
    expect(
      redactError({ kind: "type", message: `invalid input syntax for type integer: ""omar@example.com""` }).message,
    ).toBe('invalid input syntax for type integer: "…"');
    expect(redactError({ kind: "type", message: "Truncated incorrect DOUBLE value: 'O'Brien Omar'" }).message).toBe(
      "Truncated incorrect DOUBLE value: '…'",
    );
    // Out-of-range errors quote the value mid-sentence.
    const digits = await ask(
      "select count(*) from public.users where regexp_replace(phone, '[^0-9]', '', 'g')::int > 0",
    );
    expect(digits.status).toBe("failed");
    expect(digits.error?.message).toMatch(/out of range/);
    expect(digits.error?.message).not.toMatch(/\d{7,}/);
    expect(JSON.stringify(digits)).not.toMatch(/555/);
  });

  it("stops returning a column's values as soon as an admin marks it personal data, before any re-sync", async () => {
    const look = () =>
      lookupLiveValues(s.deps, {
        orgId: s.orgId,
        connectionId: s.connectionId,
        dialect: "postgres",
        requester: { type: "eval", id: null },
        term: "sepa",
        columns: ["billing.payments.method"],
      });
    expect((await look())[0]).toMatchObject({ match: "contains" });
    await s.t.owner`
      update app.catalog_object set sensitivity = 'pii', sensitivity_set_by = ${s.userId}
      where org_id = ${s.orgId} and fq_name = 'billing.payments.method'`;
    expect((await look())[0]).toMatchObject({ problem: expect.stringMatching(/personal data/) });
    const literal = await ask("select count(*) from billing.payments where method = 'sepa'");
    expect(literal.warnings.join(" ")).not.toMatch(/sepa_debit/);
  });
});
