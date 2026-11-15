// The records behind a number: the list of rows a figure counts. Compiled without a database (its shape on each
// dialect, what narrows it, what is never returned), then against the learned demo company: for every metric of the
// demo pack, over a period, a group and a bucket, the records reconcile with the number (their count is a count's value,
// their own measure is every metric's value); and the real path (an answer's metric query, the queue, the worker) reads
// them for whoever can read the conversation it was asked in, and only them.
import { clickhouseSql, mysqlSql, postgresSql } from "@opendash/connectors";
import { uuidv7 } from "@opendash/db";
import { clickhouseAvailable, mysqlAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDefinitions,
  compileMetricQuery,
  compileRecordsQuery,
  demoPack,
  executeRecords,
  getQueryCard,
  installDefinitions,
  listDefinitions,
  type MetricQueryInput,
  modelFromYaml,
  RECORDS_ROW_CAP,
  type RecordsReadJob,
  type RecordsView,
  recordsKindOf,
  requestRecords,
  runMetricQuery,
  runQuery,
  SemanticError,
  type SemanticModel,
  shareThread,
  submitQuestion,
  verifyDefinitions,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const NOW = new Date("2026-10-10T12:00:00Z");
const BUILDERS = { postgres: postgresSql, clickhouse: clickhouseSql, mysql: mysqlSql };
const model = (dialect: keyof typeof BUILDERS): SemanticModel => {
  const { datasets, metrics } = demoPack(dialect === "mysql" ? "mysql" : dialect);
  const built = modelFromYaml(datasets, metrics);
  if (!built.ok) throw new Error(built.problems.join("\n"));
  return built.model;
};

describe("compiling the records behind a number", () => {
  const records = (
    q: MetricQueryInput,
    extra: Partial<Parameters<typeof compileRecordsQuery>[1]> = {},
    dialect: keyof typeof BUILDERS = "postgres",
  ) => compileRecordsQuery(model(dialect), { query: q, ...extra }, { now: NOW, sql: BUILDERS[dialect] });

  it("lists the rows a count counts: the same filters and period, no grouping, a page and a total", () => {
    const r = records(
      { metrics: ["tickets_opened"], dimensions: ["priority"], time: { grain: "month", range: "last_3_months" } },
      { group: { time: "2026-09-01", values: { priority: "urgent" } }, limit: 10, offset: 20 },
    );
    expect(r.records.kind).toBe("count");
    expect(r.sql).toContain("limit 10 offset 20");
    expect(r.sql).not.toMatch(/group by/);
    expect(r.sql).toMatch(/not is_test/);
    expect(r.sql).toMatch(/"priority" = \$\d/);
    // The clicked month is the range: September, from the 1st to the 1st.
    expect(r.range?.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(r.range?.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.records.summary.sql).toContain("count(*) as __records");
    expect(r.records.summary.sql).toContain("count(*) as __value");
    // Both statements take the same parameters in the same order.
    expect(r.records.summary.params).toEqual(r.params);
    expect(r.records.columns.map((c) => c.name)).toContain("priority");
  });

  it("lists a dataset's own columns when it has no drill, without the one a default segment filters on", () => {
    const m = model("postgres");
    const bare = { ...m, datasets: new Map([...m.datasets].map(([k, d]) => [k, { ...d, drill: undefined }])) };
    const r = compileRecordsQuery(
      bare as SemanticModel,
      { query: { metrics: ["tickets_opened"], time: { range: "last_month" } } },
      { now: NOW, sql: postgresSql },
    );
    const names = r.records.columns.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(["id", "created_at"]);
    expect(names).toContain("priority");
    expect(names).not.toContain("is_test");
    expect(r.records.noun).toBe("records");
    // The dataset's drill, when it has one, says its columns, their order and what a record is called.
    const declared = records({ metrics: ["tickets_opened"], time: { range: "last_month" } });
    expect(declared.records.noun).toBe("tickets");
    expect(declared.records.columns.map((c) => c.field)).toEqual([
      "id",
      "created_at",
      "accounts.name",
      "subject",
      "priority",
      "status",
      "channel",
      "csat",
    ]);
    expect(declared.records.columns.map((c) => c.label)).toContain("ID");
    expect(declared.records.columns.find((c) => c.field === "accounts.name")?.name).toBe("accounts__name");
  });

  it("writes a limit and offset every dialect has, and keeps the parameters in the order they're read", () => {
    for (const dialect of ["postgres", "clickhouse", "mysql"] as const) {
      const r = records(
        { metrics: ["tickets_opened"], time: { range: "last_month" } },
        { group: {}, limit: 5, offset: 5 },
        dialect,
      );
      expect(r.sql).toMatch(/limit 5 offset 5\s*$/);
      expect(r.params.map((p) => p.name)).toEqual(["range_from", "range_to"]);
    }
  });

  it("lists each entity once when a metric counts entities, and says how it is counted", () => {
    const r = records(
      { metrics: ["paying_customers"], time: { grain: "month", range: "last_3_months" } },
      {
        group: { time: "2026-09-01" },
      },
    );
    expect(r.records.kind).toBe("distinct");
    expect(r.records.entity).toBe("account_id");
    expect(r.sql).toMatch(/row_number\(\) over \(partition by "account_id"/);
    expect(r.records.summary.sql).toContain('count(distinct "account_id") as __records');
  });

  it("reads a snapshot's rows at the clicked period's last snapshot, never every month's", () => {
    const r = records(
      { metrics: ["mrr"], time: { grain: "month", range: "last_3_months" } },
      {
        group: { time: "2026-08-01" },
      },
    );
    expect(r.records.kind).toBe("sum");
    expect(r.records.valueColumn).toBe("mrr_usd");
    expect(r.records.snapshot).toBe("month");
    expect(r.sql).toContain("__latest");
    expect(r.sql).toMatch(/from __snap/);
  });

  it("is about the current state when the metric has no time", () => {
    const r = records({ metrics: ["active_subscriptions"] });
    expect(r.range).toBeNull();
    expect(r.sql).toMatch(/status = 'active'/);
  });

  it("never selects a personal column, and says which it left out", () => {
    const shown = records({ metrics: ["tickets_opened"], time: { range: "last_month" } }).records.columns.map(
      (c) => c.name,
    );
    expect(shown).toContain("subject");
    const hidden = records(
      { metrics: ["tickets_opened"], time: { range: "last_month" } },
      { hide: new Set(["subject", "requester_id"]) },
    );
    expect(hidden.records.columns.map((c) => c.name)).not.toContain("subject");
    // Not in what the statement returns (the rows it reads from carry every column, as every metric query's do).
    const returned = (sql: string) => /\nselect ([^\n]*)\nfrom __rows/.exec(sql)?.[1] ?? "";
    expect(returned(hidden.sql)).not.toContain("subject");
    expect(returned(records({ metrics: ["tickets_opened"], time: { range: "last_month" } }).sql)).toContain("subject");
    expect(hidden.records.hidden).toContain("subject");
    // A filter on one is still allowed: it counts or narrows, it never returns the value.
    expect(
      records(
        {
          metrics: ["tickets_opened"],
          time: { range: "last_month" },
          filters: [{ field: "subject", op: "=", value: "x" }],
        },
        { hide: new Set(["subject"]) },
      ).sql,
    ).toMatch(/"subject" = \$\d/);
  });

  it("refuses when everything is personal, or the counted entity is", () => {
    // Everything a payment's list shows, its account's name included.
    const columns = ["id", "created_at", "name", "status", "method", "currency", "amount"];
    expect(() =>
      records({ metrics: ["failed_payments"], time: { range: "last_month" } }, { hide: new Set(columns) }),
    ).toThrow(/personal data/);
    expect(() =>
      records({ metrics: ["paying_customers"], time: { range: "last_month" } }, { hide: new Set(["account_id"]) }),
    ).toThrow(/can't be listed by it/);
  });

  it("narrows only by what the number was grouped by, and only within the first thousand", () => {
    const q = { metrics: ["tickets_opened"], dimensions: ["priority"], time: { range: "last_month" } };
    expect(() => records(q, { group: { values: { channel: "chat" } } })).toThrow(SemanticError);
    expect(() => records(q, { group: { time: "2026-09-01" } })).toThrow(/isn't grouped by time/);
    expect(() => records(q, { limit: 50, offset: RECORDS_ROW_CAP - 49 })).toThrow(/first 1,000/);
    expect(() => records({ metrics: ["mrr", "paid_seats"] })).toThrow(/one metric at a time/);
    // A page is never more than the gateway keeps of a result.
    expect(records(q, { limit: 500 }).sql).toMatch(/limit 50 offset 0/);
    // A group's null value is a missing one.
    expect(records(q, { group: { values: { priority: null } } }).sql).toContain('"priority" is null');
  });

  it("knows what a measure adds up to", () => {
    expect(recordsKindOf("count(*)")).toEqual({ kind: "count", column: null });
    expect(recordsKindOf("count(distinct account_id)")).toEqual({ kind: "distinct", column: "account_id" });
    expect(recordsKindOf("round(sum(mrr_usd), 2)::float8")).toEqual({ kind: "sum", column: "mrr_usd" });
    expect(recordsKindOf("sum(seats)")).toEqual({ kind: "sum", column: "seats" });
    expect(recordsKindOf("round(avg(csat), 2)")).toEqual({ kind: "other", column: null });
    expect(recordsKindOf("sum(a) / sum(b)")).toEqual({ kind: "other", column: null });
  });
});

const clickhouseUp = await clickhouseAvailable();
const mysqlUp = await mysqlAvailable();

describe.each([
  { dialect: "postgres" as const, skip: false },
  { dialect: "clickhouse" as const, skip: !clickhouseUp },
  { dialect: "mysql" as const, skip: !mysqlUp },
])("the records of every demo metric on $dialect", ({ dialect, skip }) => {
  let s: LearnedSource;
  let m: SemanticModel;

  const run = async (sql: string, params: unknown[]) => {
    const r = await runQuery(s.deps, {
      orgId: s.orgId,
      connectionId: s.connectionId,
      sql,
      params: params as never,
      mode: "execute",
      requester: { type: "eval", id: null },
    });
    if (r.status !== "succeeded") throw new Error(`${r.error?.kind}: ${r.error?.message}\n${sql}`);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
  };
  const aggregate = async (query: MetricQueryInput) => {
    const c = compileMetricQuery(m, query, { now: NOW, sql: BUILDERS[dialect] });
    return run(c.sql, c.params);
  };
  const near = (a: unknown, b: unknown) =>
    Math.abs(Number(a) - Number(b)) <= Math.max(0.01, Math.abs(Number(b)) * 1e-6);

  beforeAll(async () => {
    if (skip) return;
    s = await learnedSource({ dialect });
    const { datasets, metrics } = demoPack(dialect, {
      public: `${s.prefix}public`,
      billing: `${s.prefix}billing`,
      support: `${s.prefix}support`,
    });
    const built = modelFromYaml(datasets, metrics);
    if (!built.ok) throw new Error(built.problems.join("\n"));
    m = built.model;
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it.skipIf(skip)(
    "add up to the number for every metric, over a period, a group and a bucket",
    async () => {
      const wrong: string[] = [];
      let checked = 0;
      for (const metric of m.metrics.values()) {
        const dataset = m.datasets.get(metric.dataset);
        if (!dataset) continue;
        const hasTime = metric.time_column !== "none" && Boolean(metric.time_column ?? dataset.time_column);
        const dimension = dataset.columns.find((c) => c.dimension && c.type === "string")?.name;
        const period = hasTime ? { range: "last_3_months" as const } : undefined;
        const base: MetricQueryInput = { metrics: [metric.name], ...(period ? { time: period } : {}) };
        const cases: {
          name: string;
          query: MetricQueryInput;
          group?: Parameters<typeof compileRecordsQuery>[1]["group"];
          expect: unknown;
        }[] = [];

        // The whole period.
        const whole = (await aggregate(base))[0]?.[metric.name];
        cases.push({ name: `${metric.name} over its period`, query: base, expect: whole });
        // A bucket of a trend.
        if (hasTime) {
          const grain = metric.default_grain ?? "month";
          const trend: MetricQueryInput = { metrics: [metric.name], time: { grain, range: "last_3_months" } };
          const rows = await aggregate(trend);
          const row = rows[rows.length - 1];
          if (row) {
            cases.push({
              name: `${metric.name} in the ${grain} of ${String(row[grain]).slice(0, 10)}`,
              query: trend,
              group: { time: String(row[grain]).slice(0, 10) },
              expect: row[metric.name],
            });
          }
        }
        // A group of a breakdown.
        if (dimension) {
          const split: MetricQueryInput = { ...base, dimensions: [dimension] };
          const rows = (await aggregate(split)).filter((r) => r[dimension] !== null).slice(0, 2);
          for (const row of rows) {
            cases.push({
              name: `${metric.name} where ${dimension} is ${String(row[dimension])}`,
              query: split,
              group: { values: { [dimension]: row[dimension] as string } },
              expect: row[metric.name],
            });
          }
        }

        for (const c of cases) {
          const compiled = compileRecordsQuery(
            m,
            { query: c.query, ...(c.group ? { group: c.group } : {}), limit: 25 },
            { now: NOW, sql: BUILDERS[dialect] },
          );
          const summary = (await run(compiled.records.summary.sql, compiled.records.summary.params))[0];
          const page = await run(compiled.sql, compiled.params);
          checked++;
          // Their own measure, over the records, is the number.
          if (c.expect !== null && c.expect !== undefined && !near(summary?.__value, c.expect)) {
            wrong.push(`${c.name}: value ${String(summary?.__value)} is not ${String(c.expect)}`);
          }
          // A count's records are the number.
          if (
            (compiled.records.kind === "count" || compiled.records.kind === "distinct") &&
            !near(summary?.__records, c.expect)
          ) {
            wrong.push(`${c.name}: ${String(summary?.__records)} records is not ${String(c.expect)}`);
          }
          // A page holds a page of them, each a different row.
          const total = Number(summary?.__records ?? 0);
          if (page.length !== Math.min(25, total)) wrong.push(`${c.name}: ${page.length} rows of ${total}`);
          const key = compiled.records.columns[0]?.name as string;
          if (
            compiled.records.entity &&
            new Set(page.map((r) => r[compiled.records.entity as string])).size !== page.length
          ) {
            wrong.push(`${c.name}: an entity is listed twice`);
          }
          if (
            !compiled.records.entity &&
            dataset.primary_key.length === 1 &&
            new Set(page.map((r) => r[key])).size !== page.length
          ) {
            wrong.push(`${c.name}: a record is listed twice`);
          }
        }
      }
      expect(checked).toBeGreaterThan(25);
      expect(wrong).toEqual([]);
    },
    300_000,
  );

  it.skipIf(skip)("read a snapshot at the clicked month only", async () => {
    const compiled = compileRecordsQuery(
      m,
      {
        query: { metrics: ["mrr"], time: { grain: "month", range: "last_3_months" } },
        group: { time: "2026-08-01" },
        limit: 50,
      },
      { now: NOW, sql: BUILDERS[dialect] },
    );
    const page = await run(compiled.sql, compiled.params);
    expect(page.length).toBe(50);
    expect(new Set(page.map((r) => String(r.month).slice(0, 10)))).toEqual(new Set(["2026-08-01"]));
  });

  it.skipIf(skip)("page through to the end of the list without repeating or missing a row", async () => {
    const q: MetricQueryInput = { metrics: ["tickets_opened"], time: { range: "last_3_months" } };
    const first = compileRecordsQuery(m, { query: q, limit: 50, offset: 0 }, { now: NOW, sql: BUILDERS[dialect] });
    const total = Number((await run(first.records.summary.sql, first.records.summary.params))[0]?.__records);
    const seen = new Set<string>();
    for (let offset = 0; offset < Math.min(total, 150); offset += 50) {
      const page = compileRecordsQuery(m, { query: q, limit: 50, offset }, { now: NOW, sql: BUILDERS[dialect] });
      for (const row of await run(page.sql, page.params)) seen.add(String(row.id));
    }
    expect(seen.size).toBe(Math.min(total, 150));
  });
});

describe("the records of an answer's figure", () => {
  let s: LearnedSource;
  let thread = "";
  let figure = "";
  const bob = uuidv7();
  const as = (userId: string) => ({ orgId: s.orgId, userId });
  const deps = () => ({ withTenant: s.deps.withTenant, boss: s.boss });

  beforeAll(async () => {
    s = await learnedSource();
    const ctx = { orgId: s.orgId, userId: s.userId };
    await s.tenant((tx) =>
      installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
    );
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW });
    const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
    await s.tenant((tx) =>
      verifyDefinitions(
        tx,
        ctx,
        list.map((d) => d.id),
      ),
    );
    // A question in the asker's own conversation, and the metric query its answer ran: tickets by month over a year.
    const asked = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text: "Tickets?", channel: "web", model: "m" },
    );
    thread = asked.threadId;
    const ran = await runMetricQuery(s.deps, {
      orgId: s.orgId,
      connectionId: s.connectionId,
      query: { metrics: ["tickets_opened"], time: { grain: "month", range: "last_12_months" } },
      now: NOW,
      mode: "execute",
      alias: "q1",
      requester: { type: "run", id: asked.runId },
    });
    if (ran.status !== "succeeded") throw new Error("the figure's query didn't run");
    await s.t.owner`update app.run set status = 'succeeded' where id = ${asked.runId}`;
    figure = ran.queryRunId;
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  const read = async (userId: string, extra: Partial<Parameters<typeof requestRecords>[2]> = {}) => {
    const input = { queryRunId: figure, group: { time: "2026-09-01" }, now: NOW, ...extra };
    const first = await requestRecords(deps(), as(userId), input);
    if (first.status !== "queued") return first;
    const jobs = await s.t.owner<{ data: RecordsReadJob }[]>`
      select data from pgboss.job where name = 'records.read' and data->>'queryRunId' = ${figure}
      order by created_on desc`;
    const job = jobs.find(
      (j) =>
        j.data.page === (input.page ?? 0) &&
        JSON.stringify(j.data.group ?? null) === JSON.stringify(input.group ?? null),
    );
    expect(await executeRecords(s.deps, job?.data as RecordsReadJob)).toBe("read");
    return requestRecords(deps(), as(userId), input);
  };

  const readRow = async (input: Parameters<typeof requestRecords>[2]) => {
    const jobs = await s.t.owner<{ data: RecordsReadJob }[]>`
      select data from pgboss.job where name = 'records.read' and data->>'queryRunId' = ${input.queryRunId}
      order by created_on desc`;
    const job = jobs.find((j) => j.data.row === input.row);
    expect(await executeRecords(s.deps, job?.data as RecordsReadJob)).toBe("read");
    return requestRecords(deps(), as(s.userId), input);
  };

  it("are queued for the worker once, then answered with the page, the total and what it covers", async () => {
    const [truth] = await s.source.query(
      `select count(*)::int as n from support.tickets t join public.accounts a on a.id = t.account_id
       where not a.is_test and t.created_at >= '2026-09-01' and t.created_at < '2026-10-01'`,
    );
    const answer = (await read(s.userId)) as { status: string } & RecordsView;
    expect(answer.status).toBe("succeeded");
    expect(answer.total).toBe(Number(truth?.n));
    expect(answer.value).toBe(Number(truth?.n));
    expect(answer.kind).toBe("count");
    expect(answer.rows).toHaveLength(Math.min(25, answer.total));
    expect(answer.range).toEqual({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(answer.metric).toMatchObject({ name: "tickets_opened", label: "Support tickets opened" });
    expect(answer.segments.map((x) => x.name)).toContain("exclude_test");
    expect(answer.columns.map((c) => c.name)).toContain("id");
    // Asked again in the bucket: no new job.
    const jobs = async () =>
      (await s.t.owner<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = 'records.read'`)[0]?.n;
    const before = await jobs();
    await requestRecords(deps(), as(s.userId), { queryRunId: figure, group: { time: "2026-09-01" }, now: NOW });
    expect(await jobs()).toBe(before);
  });

  it("say whether they add up to the number clicked", async () => {
    const answer = (await read(s.userId, { expected: 1 })) as RecordsView;
    expect(answer.expected).toBe(1);
    expect(answer.matches).toBe(false);
    const right = (await read(s.userId, { expected: ((await read(s.userId)) as RecordsView).total })) as RecordsView;
    expect(right.matches).toBe(true);
  });

  it("take the group and the number from a clicked row of the result", async () => {
    const card = await getQueryCard(s.deps, as(s.userId), figure);
    const rows = card?.preview ?? [];
    const last = rows.length - 1;
    expect(String(rows[last]?.[0]).slice(0, 10)).toBe("2026-09-01");
    const asked = { queryRunId: figure, row: last, now: NOW };
    const first = await requestRecords(deps(), as(s.userId), asked);
    const answer = first.status === "queued" ? ((await readRow(asked)) as RecordsView) : (first as RecordsView);
    // The row says September, and its figure is the number the list must add up to.
    expect(answer.range?.from).toBe("2026-09-01T00:00:00.000Z");
    expect(answer.expected).toBe(Number(rows[last]?.[1]));
    expect(answer.matches).toBe(true);
    expect(answer.total).toBe(Number(rows[last]?.[1]));
    expect(await requestRecords(deps(), as(s.userId), { queryRunId: figure, row: 999, now: NOW })).toMatchObject({
      status: "failed",
    });
  });

  it("page through, a page at a time", async () => {
    const second = (await read(s.userId, { page: 1 })) as RecordsView;
    const first = (await read(s.userId, { page: 0 })) as RecordsView;
    expect(second.page).toBe(1);
    expect(second.rows.length).toBeGreaterThan(0);
    const id = first.columns.findIndex((c) => c.name === "id");
    const ids = new Set([...first.rows, ...second.rows].map((r) => String(r[id])));
    expect(ids.size).toBe(first.rows.length + second.rows.length);
  });

  it("are for whoever can read the conversation, and only them", async () => {
    // The asker's alone: Bob can't read it, so can't read what's behind it; shared with the workspace, he can.
    const refused = await requestRecords(deps(), as(bob), {
      queryRunId: figure,
      group: { time: "2026-09-01" },
      now: NOW,
    });
    expect(refused).toMatchObject({ status: "failed" });
    expect(await shareThread(s.deps, as(s.userId), thread, "org")).toBe(true);
    expect(
      (await requestRecords(deps(), as(bob), { queryRunId: figure, group: { time: "2026-09-01" }, now: NOW })).status,
    ).toBe("succeeded");
  });

  it("is refused for a number written as SQL, a run that isn't there, and a group the number doesn't have", async () => {
    expect(await requestRecords(deps(), as(s.userId), { queryRunId: uuidv7() })).toMatchObject({ status: "failed" });
    const wrong = await requestRecords(deps(), as(s.userId), {
      queryRunId: figure,
      group: { values: { nope: "x" } },
      now: NOW,
    });
    expect(wrong).toMatchObject({ status: "failed", message: expect.stringMatching(/isn't a dimension/) });
  });
});
