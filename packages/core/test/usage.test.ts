// "Used by": what depends on a metric or a dataset. A dataset counts its metrics' dependents; a dashboard someone
// keeps private is counted, never named.
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  definitionUsage,
  demoPack,
  installDefinitions,
  runMetricQuery,
  saveGoal,
  saveVerifiedQuery,
  submitQuestion,
  syncCases,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const bob = uuidv7();
const ids: Record<string, { id: string; slug: string }> = {};
let revenue = "";
const as = (userId: string) => ({ orgId: s.orgId, userId });
const usage = (kind: "dataset" | "metric", slug: string, viewer = s.userId) =>
  s.tenant((tx) =>
    definitionUsage(tx, as(viewer), { id: ids[slug]?.id as string, kind, slug, connectionId: s.connectionId }),
  );
/** A private dashboard at its first version, each query asking a dataset of the source for one of its measures. */
async function dashboard(ownerId: string, title: string, queries: { dataset: string; measure: string }[]) {
  const id = uuidv7();
  await s.t.owner`insert into app.dashboard (org_id, id, title, owner_id, current_version)
    values (${s.orgId}, ${id}, ${title}, ${ownerId}, 1)`;
  const definition = {
    queries: Object.fromEntries(
      queries.map((q) => [
        q.measure,
        {
          source: { connection: s.connectionId, dataset: q.dataset },
          measures: { [q.measure]: ["measure", q.measure] },
        },
      ]),
    ),
  };
  await s.t.owner`
    insert into app.dashboard_version (org_id, dashboard_id, version, definition, runtime_hash, revision, author_id)
    values (${s.orgId}, ${id}, 1, ${s.t.owner.json(definition)}, ${"0".repeat(64)}, ${uuidv7()}, ${ownerId})`;
  return id;
}

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, as(s.userId), s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
  );
  for (const r of await s.t.owner<{ id: string; slug: string }[]>`
    select id, slug from app.context_item where connection_id = ${s.connectionId} and kind in ('dataset', 'metric')`) {
    ids[r.slug] = r;
  }
  // Alice's dashboard on MRR, Bob's private one on churned MRR and MRR.
  revenue = await dashboard(s.userId, "Revenue", [{ dataset: "mrr_monthly", measure: "mrr" }]);
  await dashboard(bob, "Bob's churn", [
    { dataset: "churn", measure: "churned_mrr" },
    { dataset: "mrr_monthly", measure: "mrr" },
  ]);
  // A verified query saved from an answer's MRR query.
  const { runId } = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text: "MRR lately?", channel: "web", model: "m" },
  );
  const m = await runMetricQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    query: { metrics: ["mrr"], time: { grain: "month", range: { from: "2026-08-01", to: "2026-10-01" } } },
    mode: "execute",
    title: "MRR",
    requester: { type: "run", id: runId },
    now: new Date("2026-10-11T00:00:00Z"),
  });
  await s.tenant((tx) =>
    saveVerifiedQuery(tx, as(s.userId), {
      queryRunId: (m as { queryRunId: string }).queryRunId,
      question: "MRR lately?",
    }),
  );
  // Eval questions from the verified metrics.
  await s.tenant((tx) => syncCases(tx, s.orgId));
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("used by", () => {
  it("lists a metric's dashboards, naming only those the person can open, its verified queries and eval questions", async () => {
    const u = await usage("metric", "mrr");
    expect(u.metrics).toEqual([]);
    expect(u.dashboards).toEqual({ visible: [{ id: expect.any(String), title: "Revenue" }], hidden: 1 });
    expect(u.verifiedQueries.map((q) => q.title)).toEqual(["MRR lately?"]);
    expect(u.evalQuestions).toBeGreaterThan(0);
    // Bob sees his own, and Alice's once she shares it.
    expect((await usage("metric", "mrr", bob)).dashboards).toEqual({
      visible: [{ id: expect.any(String), title: "Bob's churn" }],
      hidden: 1,
    });
    await s.t.owner`update app.dashboard set visibility = 'org' where id = ${revenue}`;
    expect((await usage("metric", "mrr", bob)).dashboards.visible.map((d) => d.title)).toEqual([
      "Bob's churn",
      "Revenue",
    ]);
  });

  it("lists the goals a metric measures, on the metric and on its dataset", async () => {
    await s.tenant((tx) =>
      saveGoal(tx, as(s.userId), { metricId: ids.mrr?.id as string, target: 500_000, due: "2099-12-31" }),
    );
    expect((await usage("metric", "mrr")).goals.map((g) => g.title)).toEqual([
      "Monthly recurring revenue to $500k by Dec 31, 2099",
    ]);
    expect((await usage("dataset", "mrr_monthly")).goals).toHaveLength(1);
    expect((await usage("metric", "churned_mrr")).goals).toEqual([]);
  });

  it("gives a dataset its metrics, and what depends on them", async () => {
    const dataset = Object.keys(ids).find((slug) => slug === "mrr_monthly") as string;
    const u = await usage("dataset", dataset);
    expect(u.metrics.length).toBeGreaterThan(0);
    expect(u.dashboards.visible.map((d) => d.title)).toContain("Revenue");
    expect(u.verifiedQueries.map((q) => q.title)).toEqual(["MRR lately?"]);
  });

  it("is empty for a metric nothing uses", async () => {
    const unused = Object.keys(ids).find((slug) => !["mrr", "churned_mrr"].includes(slug) && slug.includes("csat"));
    const u = await usage("metric", unused as string);
    expect(u.dashboards).toEqual({ visible: [], hidden: 0 });
    expect(u.verifiedQueries).toEqual([]);
  });
});
