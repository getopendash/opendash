// The Postgres adapter against the seeded demo company: results, caps, types, timeouts, cancel, and the server
// refusing a write even when the statement check is bypassed.
import { CHURNED_MRR_BY_PLAN_SQL, generateSaas, MRR_SQL, monthMrr } from "@opendash/evals";
import { type SeededDatabase, seededDatabase } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DialectSession, dialectFor, QueryError } from "../src";

const dialect = dialectFor("postgres");
let source: SeededDatabase;
let session: DialectSession;
const opts = { maxRows: 1_000, maxBytes: 2_000_000, timeoutMs: 10_000 };
const inline = (sql: string, params: string[]) => params.reduce((s, p, i) => s.replaceAll(`$${i + 1}`, `'${p}'`), sql);

beforeAll(async () => {
  source = await seededDatabase();
  session = await dialect.open(
    { host: source.host, port: source.port, database: source.database, user: source.reader.user, sslMode: "disable" },
    source.reader.password,
    { edition: "community", connectTimeoutMs: 5_000, statementTimeoutMs: 30_000, applicationName: "opendash-test" },
  );
}, 180_000);

afterAll(async () => {
  await session?.close();
  await source?.drop();
});

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(QueryError);
  return (error as QueryError).info;
};

describe("postgres execute", () => {
  it("runs the reference queries and returns the generator's numbers", async () => {
    const mrr = await dialect.execute(session, inline(MRR_SQL, ["2026-10-01T00:00:00Z"]), opts);
    expect(mrr.columns).toEqual([{ name: "mrr", type: "number" }]);
    expect(Number(mrr.rows[0]?.[0])).toBeCloseTo(monthMrr(generateSaas(), 2026, 8), 1);
    const churn = await dialect.execute(
      session,
      inline(CHURNED_MRR_BY_PLAN_SQL, ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"]),
      opts,
    );
    expect(churn.rows).toEqual([
      ["Growth", 3600],
      ["Scale", 2100],
      ["Starter", 4100],
    ]);
  });

  it("binds parameters on the server, with types inferred from where they're used", async () => {
    const churn = await dialect.execute(session, CHURNED_MRR_BY_PLAN_SQL, {
      ...opts,
      params: [
        { name: "from", value: "2026-09-01T00:00:00Z" },
        { name: "to", value: "2026-10-01T00:00:00Z" },
      ],
    });
    expect(churn.rows).toEqual([
      ["Growth", 3600],
      ["Scale", 2100],
      ["Starter", 4100],
    ]);
    const listed = await dialect.execute(
      session,
      "select count(*)::int as n from public.accounts where country = any($1) and is_test = $2",
      {
        ...opts,
        params: [
          { name: "countries", value: ["US", "DE"] },
          { name: "test", value: false },
        ],
      },
    );
    expect(Number(listed.rows[0]?.[0])).toBeGreaterThan(0);
    // A parameter is a value, never SQL: a quote in it is just a character.
    const quoted = await dialect.execute(session, "select count(*)::int from public.accounts where name = $1", {
      ...opts,
      params: [{ name: "name", value: "x' or '1'='1" }],
    });
    expect(quoted.rows).toEqual([[0]]);
    const plan = await dialect.explain(session, "select * from public.accounts where country = $1", {
      timeoutMs: 5_000,
      params: [{ name: "country", value: "DE" }],
    });
    expect(plan.ok).toBe(true);
  });

  it("stops at the row cap and the byte cap, and says so", async () => {
    const rows = await dialect.execute(session, "select * from billing.invoices order by id", { ...opts, maxRows: 10 });
    expect(rows.rows).toHaveLength(10);
    expect(rows.truncated).toBe(true);
    const bytes = await dialect.execute(session, "select * from billing.invoices", { ...opts, maxBytes: 2_000 });
    expect(bytes.truncated).toBe(true);
    expect(bytes.bytes).toBeLessThanOrEqual(2_000);
    const all = await dialect.execute(session, "select id from public.plans", opts);
    expect(all.truncated).toBe(false);
  });

  it("reports which table column each result column copies, as the server says", async () => {
    const r = await dialect.execute(
      session,
      "select a.billing_email as x, lower(a.name) as y, count(*) over () as z from public.accounts a limit 1",
      opts,
    );
    expect(r.columns[0]?.source).toEqual({ schema: "public", table: "accounts", column: "billing_email" });
    expect(r.columns[1]?.source).toBeUndefined();
    expect(r.columns[2]?.source).toBeUndefined();
  });

  it("shortens very long text values and keeps wide rows under the byte cap", async () => {
    const r = await dialect.execute(session, "select g, repeat('x', 100000) as blob from generate_series(1, 2000) g", {
      ...opts,
      maxBytes: 200_000,
    });
    expect(r.clippedCells).toBeGreaterThan(0);
    expect(String(r.rows[0]?.[1]).length).toBe(2_001);
    expect(r.bytes).toBeLessThanOrEqual(200_000);
    expect(r.truncated).toBe(true);
  });

  it("returns JSON-safe cells: exact decimals as strings, times as ISO strings, duplicate names kept", async () => {
    const r = await dialect.execute(
      session,
      "select 1.50::numeric as n, 10::bigint as b, timestamptz '2026-09-01 00:00:00+00' as t, date '2026-09-01' as d, true as ok, null as nothing, 1 as x, 2 as x",
      opts,
    );
    expect(r.columns.map((c) => c.type)).toEqual([
      "number",
      "number",
      "timestamp",
      "date",
      "boolean",
      "text",
      "number",
      "number",
    ]);
    expect(r.rows[0]).toEqual(["1.50", "10", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", true, null, 1, 2]);
  });

  it("stops a slow query at the timeout, on the server", async () => {
    const info = await failure(
      dialect.execute(session, "select count(*) from generate_series(1, 500000000)", { ...opts, timeoutMs: 300 }),
    );
    expect(info.kind).toBe("timeout");
    expect(info.message).toMatch(/longer than/);
  });

  it("cancels on the signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const info = await failure(
      dialect.execute(session, "select count(*) from generate_series(1, 500000000)", {
        ...opts,
        signal: controller.signal,
      }),
    );
    expect(info.kind).toBe("cancelled");
  });

  it("refuses a write on the server even if the statement check is bypassed", async () => {
    const info = await failure(
      dialect.execute(
        session,
        "insert into public.plans (id, name, unit_amount_cents, per_seat, min_seats) values ('x', 'x', 1, false, 1)",
        opts,
      ),
    );
    expect(info.kind).toBe("read_only");
  });
});

describe("postgres explain and errors", () => {
  it("explains without running", async () => {
    const r = await dialect.explain(session, "select * from public.accounts", { timeoutMs: 5_000 });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.estimatedRows).toBeGreaterThan(1_000);
  });

  it("returns the server's error with its hint and position", async () => {
    const r = await dialect.explain(session, "select a.nme from public.accounts a", { timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: "undefined_column", position: 8 });
    expect(r.error.hint).toMatch(/a\.name/);
    const missing = await dialect.explain(session, "select * from public.account", { timeoutMs: 5_000 });
    expect(missing.ok ? null : missing.error.kind).toBe("undefined_table");
  });

  it("gives the model notes for this dialect", () => {
    expect(dialect.notes("17.10 (Debian)")).toMatch(/PostgreSQL 17\.10/);
    expect(dialect.notes()).toMatch(/date_trunc/);
  });
});
