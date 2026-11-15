// Definitions as governed items, and the metric path through the gateway: a pack installs as proposals, only what an
// admin verified compiles, a metric is never verified without its dataset, versions don't change once written, and
// every metric query (answered or refused) leaves a query_run that says which definitions it used.
import type { SystemTx } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { MRR_SQL } from "@opendash/evals";
import { clickhouseAvailable, mysqlAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDefinitions,
  contextForRun,
  type DefinitionDerived,
  demoPack,
  installDefinitions,
  keyMetrics,
  listContext,
  listDefinitions,
  loadSemanticModel,
  proposeMissingStarterPacks,
  proposeStarterPack,
  runMetricQuery,
  saveDefinition,
  verifyDefinitions,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const reference = async (q: string, params: unknown[] = []) =>
  Number(Object.values((await s.source.query(q, params))[0] ?? {})[0]);
const NOW = new Date("2026-10-10T12:00:00Z");
const ask = (query: Parameters<typeof runMetricQuery>[1]["query"]) =>
  runMetricQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    query,
    mode: "execute",
    title: "test",
    requester: { type: "eval", id: null },
    now: NOW,
  });
const traced = async (id: string) =>
  (
    await s.t.owner<
      {
        path: string;
        engine: string;
        semantic: { definitions: { slug: string; version: number }[] } | null;
        error: { kind: string } | null;
        compiled_sql: string;
      }[]
    >`
      select path, engine, semantic, error, compiled_sql from app.query_run where id = ${id}`
  )[0];

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);
afterAll(async () => {
  await s?.close();
});

describe("definitions", () => {
  it("proposes the sample's starter pack once (also for a source learned before packs existed), and queues its checks", async () => {
    const job = { orgId: s.orgId, connectionId: s.connectionId };
    const scheduler = {
      withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => withSystemOn(s.t.system, fn),
      withTenant: s.deps.withTenant,
      boss: s.boss,
    };
    expect(await proposeMissingStarterPacks(scheduler)).toBe(1);
    expect(await proposeMissingStarterPacks(scheduler)).toBe(0);
    expect(await s.tenant((tx) => proposeStarterPack({ boss: s.boss }, tx, job))).toBe(0);
    const ctx = { orgId: s.orgId, userId: s.userId };
    const again = await s.tenant((tx) =>
      installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
    );
    expect(again).toBe(0);
    const [queued] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from pgboss.job where name = 'definitions.check' and data->>'connectionId' = ${s.connectionId}`;
    expect(queued?.n).toBe(1);
    const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
    expect(list).toHaveLength(21);
    expect(new Set(list.map((d) => d.status))).toEqual(new Set(["proposed"]));
    expect(list.find((d) => d.slug === "mrr")).toMatchObject({
      kind: "metric",
      title: "Monthly recurring revenue",
      version: 1,
    });
    // The sample company's glossary is proposed with it, for an admin to approve; none of it reaches the analyst yet.
    const terms = await s.tenant((tx) => listContext(tx, s.orgId, "term"));
    expect(terms.map((t) => [t.title, t.status])).toEqual([
      ["Active customer", "proposed"],
      ["Enterprise", "proposed"],
      ["Fiscal year", "proposed"],
      ["Mid-market", "proposed"],
      ["SMB", "proposed"],
    ]);
    expect(terms.find((t) => t.title === "SMB")?.mapsTo).toEqual({
      column: "public.accounts.employee_band",
      values: ["1-10", "11-50"],
    });
    expect((await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId))).terms).toEqual([]);
  });

  it("stops testing when its caller does (a drafting run out of time), and records nothing", async () => {
    const stopped = AbortSignal.abort(new Error("out of time"));
    await expect(
      checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW, signal: stopped }),
    ).rejects.toThrow("out of time");
  });

  it("tests each definition against the data, through the gateway", async () => {
    expect(await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW })).toBe(21);
    const derived = await s.t.owner<{ slug: string; derived: DefinitionDerived }[]>`
      select i.slug, v.derived from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.connection_id = ${s.connectionId} and i.kind in ('dataset', 'metric')`;
    const failing = derived.filter((d) => d.derived.status !== "passed");
    expect(failing.map((d) => [d.slug, d.derived.checks.filter((c) => c.status !== "passed")])).toEqual([]);
    const mrr = derived.find((d) => d.slug === "mrr_monthly")?.derived;
    expect(mrr?.checks.map((c) => c.name)).toEqual([
      "Runs on your data",
      "Columns are as declared",
      "Grain is unique",
      "Joins are many-to-one",
      "Joins match",
      "month is filled",
    ]);
    expect(derived.find((d) => d.slug === "churned_mrr")?.derived.sample).toMatchObject({
      label: "Last month",
      period: "2026-09-01",
      value: 9800,
    });
    const [checks] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_run where requester_type = 'definition' and org_id = ${s.orgId}`;
    expect(checks?.n).toBeGreaterThan(40);
  });

  it("compiles nothing until something is verified", async () => {
    expect(await s.tenant((tx) => loadSemanticModel(tx, s.orgId, s.connectionId))).toBeNull();
    const r = await ask({ metrics: ["mrr"] });
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ kind: "semantic", message: expect.stringMatching(/no verified metrics/) });
    expect((await traced(r.queryRunId))?.path).toBe("metric");
  });

  it("never verifies a metric without its dataset", async () => {
    const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
    const id = (slug: string) => list.find((d) => d.slug === slug)?.id as string;
    const ctx = { orgId: s.orgId, userId: s.userId };
    expect(await s.tenant((tx) => verifyDefinitions(tx, ctx, [id("mrr")]))).toEqual([]);
    const verified = await s.tenant((tx) =>
      verifyDefinitions(
        tx,
        ctx,
        list.map((d) => d.id),
      ),
    );
    expect(verified).toHaveLength(21);
    const loaded = await s.tenant((tx) => loadSemanticModel(tx, s.orgId, s.connectionId));
    expect(loaded?.model.metrics.size).toBe(13);
  });

  it("gives Home its key metrics: money first, each with a year of months and the change", async () => {
    const tiles = await s.tenant((tx) => keyMetrics(tx, s.orgId));
    expect(tiles.map((t) => t.name)).toEqual(["mrr", "churned_mrr", "avg_csat", "new_accounts"]);
    const mrr = tiles[0];
    expect(mrr?.trend).toHaveLength(12);
    expect(mrr?.trend.at(-1)?.period).toBe("2026-09-01");
    expect(Number(mrr?.sample.value)).toBeCloseTo(await reference(MRR_SQL, ["2026-10-01T00:00:00Z"]), 1);
    expect(Number(mrr?.sample.previous)).toBeCloseTo(await reference(MRR_SQL, ["2026-09-01T00:00:00Z"]), 1);
  });

  it("keeps versions as they were written", async () => {
    await expect(
      s.t.owner`update app.context_item_version set body = 'changed' where org_id = ${s.orgId}`,
    ).rejects.toThrow(/never changed/);
    // derived (what the checks found) can still be written.
    await s.t.owner`update app.context_item_version set derived = derived || '{}'::jsonb where org_id = ${s.orgId}`;
  });
});

describe("the metric path", () => {
  it("answers through the gateway, and records the definitions it used", async () => {
    const r = await ask({ metrics: ["churned_mrr"], dimensions: ["plans.name"], time: { range: "last_month" } });
    expect(r.status).toBe("succeeded");
    expect(r.roles?.map((c) => c.role)).toEqual(["dimension", "measure"]);
    expect(r.rows.map((row) => row[0])).toEqual(["Starter", "Growth", "Scale"]);
    const run = await traced(r.queryRunId);
    expect(run).toMatchObject({ path: "metric", engine: "compiler" });
    expect(run?.semantic?.definitions.map((d) => [d.slug, d.version])).toEqual([
      ["churned_mrr", 1],
      ["churn", 1],
      ["plans", 1],
    ]);
  });

  it("records a query the definitions can't express, with the reason", async () => {
    const r = await ask({ metrics: ["new_accounts"], dimensions: ["subscriptions.status"] });
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("semantic");
    expect(r.error?.message).toMatch(/1:n/);
    expect(await traced(r.queryRunId)).toMatchObject({ path: "metric", compiled_sql: "", error: { kind: "semantic" } });
  });
});

describe("editing definitions", () => {
  const ctx = () => ({ orgId: s.orgId, userId: s.userId });
  const mrr = async () =>
    (await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }))).find(
      (d) => d.slug === "mrr",
    ) as NonNullable<Awaited<ReturnType<typeof listDefinitions>>[number]>;
  const body = (grain: string, dataset = "mrr_monthly", name = "mrr") =>
    `name: ${name}\nlabel: Monthly recurring revenue\ndescription: MRR at the end of each month.\ndataset: ${dataset}\nmeasure: mrr\ndefault_grain: ${grain}\nformat: usd\n`;
  const save = (input: Partial<Parameters<typeof saveDefinition>[3]> & { body: string }) =>
    s.tenant((tx) =>
      saveDefinition({ boss: s.boss }, tx, ctx(), { kind: "metric", connectionId: s.connectionId, ...input }),
    );
  let before: string;

  it("makes a new version that waits for approval, while Ask keeps the released one", async () => {
    before = (await ask({ metrics: ["mrr"], time: { range: "last_month" } })).queryRunId;
    const item = await mrr();
    const saved = await save({ id: item.id, body: body("quarter"), expectedVersion: 1, changeNote: "Quarterly" });
    expect(saved).toEqual({ ok: true, id: item.id, version: 2 });
    // Who approved version 1, and when, stay with it.
    expect(await mrr()).toMatchObject({
      version: 2,
      releasedVersion: 1,
      status: "draft",
      verifiedAt: expect.any(String),
    });
    const loaded = await s.tenant((tx) => loadSemanticModel(tx, s.orgId, s.connectionId));
    expect(loaded?.definitions.get("metric:mrr")?.version).toBe(1);
    expect(loaded?.model.metrics.get("mrr")?.default_grain).toBe("month");
  });

  it("refuses an edit on a version someone replaced, a renamed one, and one whose names don't exist", async () => {
    const item = await mrr();
    expect(await save({ id: item.id, body: body("year"), expectedVersion: 1 })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(await save({ id: item.id, body: body("year", "mrr_monthly", "mrr2") })).toMatchObject({
      ok: false,
      problems: ["The name can't change: it's mrr."],
    });
    expect(await save({ id: item.id, body: body("year", "nowhere") })).toMatchObject({
      ok: false,
      reason: "invalid",
      problems: [expect.stringMatching(/^Metric mrr: there's no dataset nowhere\. Datasets: accounts, churn/)],
    });
    expect(await save({ body: "name: [unclosed" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await save({ body: body("month") })).toMatchObject({
      ok: false,
      problems: ["There's already a metric named mrr."],
    });
  });

  it("creates a new one, tests only what changed, and approving releases it", async () => {
    const created = await save({
      body: body("month", "mrr_monthly", "paid_mrr").replace("Monthly recurring revenue", "Paid MRR"),
    });
    expect(created).toMatchObject({ ok: true, version: 1 });
    // Approving before its tests ran is refused.
    const item = await mrr();
    expect(await s.tenant((tx) => verifyDefinitions(tx, ctx(), [item.id]))).toEqual([]);
    expect(await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW })).toBe(2);
    expect(await s.tenant((tx) => verifyDefinitions(tx, ctx(), [item.id]))).toEqual([item.id]);
    expect(await mrr()).toMatchObject({ version: 2, releasedVersion: 2, status: "verified" });
    const loaded = await s.tenant((tx) => loadSemanticModel(tx, s.orgId, s.connectionId));
    expect(loaded?.model.metrics.get("mrr")?.default_grain).toBe("quarter");
    // An answer from before still names the version it used.
    expect((await traced(before))?.semantic?.definitions.find((d) => d.slug === "mrr")?.version).toBe(1);
  });
});

// The sample on ClickHouse lives in prefixed databases (<prefix>public…): the pack finds them from the source's
// default database, and every definition passes its checks there too.
const clickhouseUp = await clickhouseAvailable();
describe.skipIf(!clickhouseUp)("the starter pack on ClickHouse", () => {
  let c: LearnedSource;
  beforeAll(async () => {
    c = await learnedSource({ dialect: "clickhouse" });
  }, 300_000);
  afterAll(async () => {
    await c?.close();
  });

  it("is proposed with the source's database names, and passes its checks", async () => {
    const job = { orgId: c.orgId, connectionId: c.connectionId };
    expect(await c.tenant((tx) => proposeStarterPack({ boss: c.boss }, tx, job))).toBe(21);
    expect(await checkDefinitions(c.deps, job, { now: NOW })).toBe(21);
    const derived = await c.t.owner<{ slug: string; status: string; body: string }[]>`
      select i.slug, v.derived->>'status' as status, v.body from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.connection_id = ${c.connectionId} and i.kind in ('dataset', 'metric')`;
    expect(derived.filter((d) => d.status !== "passed").map((d) => d.slug)).toEqual([]);
    expect(derived.find((d) => d.slug === "mrr_monthly")?.body).toContain(
      `${c.clickhouse?.prefix}public.subscription_items`,
    );
  });
});

const mysqlUp = await mysqlAvailable();
describe.skipIf(!mysqlUp)("the starter pack on MySQL", () => {
  let m: LearnedSource;
  beforeAll(async () => {
    m = await learnedSource({ dialect: "mysql" });
  }, 300_000);
  afterAll(async () => {
    await m?.close();
  });

  it("is proposed with the source's database names, and passes its checks", async () => {
    const job = { orgId: m.orgId, connectionId: m.connectionId };
    expect(await m.tenant((tx) => proposeStarterPack({ boss: m.boss }, tx, job))).toBe(21);
    expect(await checkDefinitions(m.deps, job, { now: NOW })).toBe(21);
    const derived = await m.t.owner<{ slug: string; status: string; body: string }[]>`
      select i.slug, v.derived->>'status' as status, v.body from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.connection_id = ${m.connectionId} and i.kind in ('dataset', 'metric')`;
    expect(derived.filter((d) => d.status !== "passed").map((d) => d.slug)).toEqual([]);
    expect(derived.find((d) => d.slug === "mrr_monthly")?.body).toContain(`${m.prefix}public.subscription_items`);
    // The glossary's mappings name the prefixed columns, so they were proposed too.
    const terms = await m.tenant((tx) => listContext(tx, m.orgId, "term"));
    expect(terms.find((t) => t.title === "SMB")?.mapsTo?.column).toBe(`${m.prefix}public.accounts.employee_band`);
  });
});
