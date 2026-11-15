// Make this a metric: a draft asked from an answer's query starts a Modeler run and a proposal; the
// Modeler's YAML is validated, installed as proposed and data-tested (problems back for repair, failures taken back);
// the run's end settles the proposal; and an admin approves or rejects it.
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveProposal,
  definitionCounts,
  draftDefinitions,
  getProposal,
  listProposals,
  ProposalProblem,
  rejectProposal,
  requestMetricDraft,
  runQuery,
  setSpendLimits,
  settleProposal,
  submitQuestion,
  verifyDefinitions,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const runs: Record<string, string> = {};
const keys = { anthropic: true } as never;

const as = () => ({ orgId: s.orgId, userId: s.userId });
const deps = () => ({ withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: keys });
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof ProposalProblem || (error as { code?: string }).code) {
      return `${(error as { code: string }).code}: ${(error as Error).message}`;
    }
    throw error;
  }
};

const DATASET = `ref: active_subscriptions
label: Active subscriptions
description: Every active subscription, with its account.
grain: one row per active subscription
usage_guidance: Use for active subscriptions.
primary_key: [id]
time_column: started_at
sql: |
  select s.id, s.account_id, s.started_at, a.is_test
  from public.subscriptions s join public.accounts a on a.id = s.account_id
  where s.status = 'active'
columns:
  - { name: id, type: number }
  - { name: account_id, type: number }
  - { name: started_at, type: time }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: customers, expr: "count(distinct account_id)" }
segments:
  - { name: exclude_test, where: "not is_test", default: true }
`;
const METRIC = `name: active_customers
label: Active customers
description: Accounts with an active subscription, by when it started; test accounts left out.
dataset: active_subscriptions
measure: customers
default_grain: month
direction: higher_is_better
`;

/** The Modeler run a proposal started, as a scripted model would leave it: finished with this outcome. */
async function finish(proposalId: string, outcome: Record<string, unknown>) {
  const [p] = await s.t.owner<{ run_id: string }[]>`select run_id from app.proposal where id = ${proposalId}`;
  await s.t
    .owner`update app.run set status = 'succeeded', outcome = ${s.t.owner.json(outcome as never)} where id = ${p?.run_id ?? ""}`;
  return p?.run_id as string;
}
const runOf = async (proposalId: string) =>
  (await s.t.owner<{ run_id: string }[]>`select run_id from app.proposal where id = ${proposalId}`)[0]
    ?.run_id as string;

beforeAll(async () => {
  s = await learnedSource();
  const r = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text: "Customers?", channel: "web", model: "m" },
  );
  for (const [alias, text] of [
    [
      "q1",
      "select count(distinct s.account_id) as customers from public.subscriptions s join public.accounts a on a.id = s.account_id where s.status = 'active' and not a.is_test",
    ],
    [
      "q2",
      "select p.name as plan, count(*) as subscriptions from public.subscriptions s join public.plans p on p.id = s.plan_id where s.status = 'active' group by p.name order by p.name",
    ],
  ] as const) {
    const q = await runQuery(s.deps, {
      orgId: s.orgId,
      connectionId: s.connectionId,
      sql: text,
      mode: "execute",
      alias,
      title: alias === "q1" ? "Active customers" : "Active by plan",
      requester: { type: "run", id: r.runId },
    });
    runs[alias] = q.queryRunId;
  }
  await s.t.owner`update app.run set status = 'succeeded' where id = ${r.runId}`;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("a draft", () => {
  let proposal = "";

  it("is asked from an answer's query: a Modeler run in a thread of its own, queued as background work, asked once", async () => {
    const asked = await requestMetricDraft(deps(), as(), { queryRunId: runs.q1 as string });
    expect(asked.status).toBe("drafting");
    proposal = asked.proposalId;
    expect(await requestMetricDraft(deps(), as(), { queryRunId: runs.q1 as string })).toEqual(asked);
    const [run] = await s.t.owner<{ profile: string; trigger: string; channel: string; text: string }[]>`
      select r.profile, r.trigger, t.channel, m.text from app.run r join app.thread t on t.id = r.thread_id
      join app.message m on m.id = r.input_message_id where r.id = ${await runOf(proposal)}`;
    expect(run).toMatchObject({ profile: "modeler", trigger: "user", channel: "modeler" });
    expect(run?.text).toContain("count(distinct s.account_id) as customers");
    expect(run?.text).toContain('Someone kept it from an answer as "Active customers"');
    const [job] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from pgboss.job where name = 'agent.background' and data->>'runId' = ${await runOf(proposal)}`;
    expect(job?.n).toBe(1);
    // A query that isn't there, or one asked in a conversation the person can't read.
    expect(await problem(requestMetricDraft(deps(), as(), { queryRunId: uuidv7() }))).toMatch(/^not_found/);
    expect(
      await problem(
        requestMetricDraft(deps(), { orgId: s.orgId, userId: uuidv7() }, { queryRunId: runs.q1 as string }),
      ),
    ).toMatch(/^not_found/);
  });

  it("takes the Modeler's YAML only when it's valid and passes its tests, giving the problems back to repair", async () => {
    const run = { orgId: s.orgId, runId: await runOf(proposal), connectionId: s.connectionId };
    const invalid = await draftDefinitions(s.deps, run, {
      metrics: [{ yaml: METRIC }],
      rationale: "Counts customers.",
    });
    expect(invalid).toMatchObject({ accepted: false, final: false });
    expect(invalid.problems.join(" ")).toMatch(/^The metric active_customers: .*active_subscriptions/);
    const broken = await draftDefinitions(s.deps, run, {
      datasets: [{ yaml: DATASET.replace("s.started_at", "s.no_such_column as started_at") }],
      metrics: [{ yaml: METRIC }],
      rationale: "Counts customers.",
    });
    expect(broken).toMatchObject({ accepted: false, final: false });
    expect(broken.problems.join(" ")).toMatch(/Active subscriptions \(dataset\): Runs on your data failed/);
    expect((await s.tenant((tx) => getProposal(tx, as(), proposal)))?.items).toEqual([]);
    const good = await draftDefinitions(s.deps, run, {
      datasets: [{ yaml: DATASET }],
      metrics: [{ yaml: METRIC, why: "What the query counts, by month." }],
      rationale: "The query counts active accounts; the dataset keeps its test filter as a default segment.",
    });
    // A draft from a query is done once its drafts pass and hold a metric.
    expect(good).toMatchObject({
      accepted: true,
      final: true,
      kept: [
        expect.objectContaining({ kind: "dataset", slug: "active_subscriptions" }),
        expect.objectContaining({ kind: "metric", slug: "active_customers" }),
      ],
    });
    const view = await s.tenant((tx) => getProposal(tx, as(), proposal));
    expect(view).toMatchObject({
      status: "drafting",
      title: "Active customers",
      from: { visible: true, queryRunId: runs.q1 },
    });
    expect(view?.items.map((i) => [i.kind, i.status, i.checks?.status, i.why])).toEqual([
      ["dataset", "proposed", "passed", null],
      ["metric", "proposed", "passed", "What the query counts, by month."],
    ]);
    // Its versions point at the proposal, written by the Modeler for whoever asked.
    const [v] = await s.t.owner<{ source: string; proposal_id: string }[]>`
      select v.source, v.proposal_id from app.context_item_version v
      where v.item_id = ${view?.items[1]?.id ?? ""}`;
    expect(v).toEqual({ source: "modeler", proposal_id: proposal });
    // Reviewed with its proposal, not as the starter pack the setup card asks for.
    expect((await s.tenant((tx) => definitionCounts(tx, s.orgId))).proposed).toBe(0);
  });

  it("stopped while its tests run (out of time), keeps only what passed: a new draft goes, a repair goes back", async () => {
    const run = { orgId: s.orgId, runId: await runOf(proposal), connectionId: s.connectionId };
    const shape = async () =>
      (await s.tenant((tx) => getProposal(tx, as(), proposal)))?.items.map((i) => [i.slug, i.body, i.checks?.status]);
    const before = await shape();
    await expect(
      draftDefinitions(
        s.deps,
        run,
        {
          // A repair of the dataset it has, and a new metric: neither gets tested.
          datasets: [{ yaml: DATASET.replace("with its account.", "with its account, repaired.") }],
          metrics: [{ yaml: METRIC.replace("name: active_customers", "name: newest_customers") }],
        },
        { signal: AbortSignal.abort(new Error("out of time")) },
      ),
    ).rejects.toThrow("out of time");
    expect(await shape()).toEqual(before);
  });

  it("opens for review once its run proposed, and an admin approves it", async () => {
    await finish(proposal, { kind: "modeler", status: "proposed", items: [] });
    expect(await settleProposal(s.deps, s.orgId, await runOf(proposal))).toBe("open");
    expect((await s.tenant((tx) => listProposals(tx, as())))[0]).toMatchObject({ id: proposal, status: "open" });
    // Someone who can't read the conversation it was asked in sees the drafts, not where they came from.
    const other = (await s.tenant((tx) => listProposals(tx, { orgId: s.orgId, userId: uuidv7() })))[0];
    expect(other).toMatchObject({
      id: proposal,
      title: null,
      rationale: null,
      sql: null,
      evidence: {},
      from: { visible: false, queryRunId: null },
    });
    expect(other?.items.map((i) => i.slug)).toEqual(["active_subscriptions", "active_customers"]);
    await s.tenant((tx) => approveProposal(tx, as(), proposal));
    expect(await problem(s.tenant((tx) => approveProposal(tx, as(), proposal)))).toBe(
      "invalid: This proposal isn't in review: it's approved.",
    );
  });

  it("closes once its drafts are verified on their own pages, and Approve on one left open succeeds", async () => {
    const drafted = async (name: string) => {
      const asked = await requestMetricDraft(deps(), as(), { queryRunId: runs.q2 as string });
      const run = { orgId: s.orgId, runId: await runOf(asked.proposalId), connectionId: s.connectionId };
      await draftDefinitions(s.deps, run, {
        metrics: [
          {
            yaml: METRIC.replace("name: active_customers", `name: ${name}`).replace(
              "label: Active customers",
              `label: ${name}`,
            ),
          },
        ],
        rationale: "x",
      });
      await finish(asked.proposalId, { kind: "modeler", status: "proposed", items: [] });
      await settleProposal(s.deps, s.orgId, run.runId);
      const view = await s.tenant((tx) => getProposal(tx, as(), asked.proposalId));
      expect(view?.status).toBe("open");
      return { id: asked.proposalId, items: view?.items.map((i) => i.id) ?? [] };
    };
    // Verified on its own page: its card closes as approved.
    const one = await drafted("verified_alone");
    await s.tenant((tx) => verifyDefinitions(tx, as(), one.items));
    expect((await s.tenant((tx) => getProposal(tx, as(), one.id)))?.status).toBe("approved");
    // Left open by an earlier build after its drafts were verified: Approve closes it instead of failing.
    const two = await drafted("verified_before");
    await s.t.owner`update app.context_item set status = 'verified', released_version = current_version
      where id = any(${two.items}::uuid[])`;
    await s.tenant((tx) => approveProposal(tx, as(), two.id));
    expect((await s.tenant((tx) => getProposal(tx, as(), two.id)))?.status).toBe("approved");
  });

  it("is rejected with a note (its drafts deleted), fails with the Modeler's reason, and is held without a budget", async () => {
    const asked = await requestMetricDraft(deps(), as(), { queryRunId: runs.q2 as string });
    const run = { orgId: s.orgId, runId: await runOf(asked.proposalId), connectionId: s.connectionId };
    await draftDefinitions(s.deps, run, {
      metrics: [
        {
          yaml: METRIC.replace("name: active_customers", "name: plan_customers").replace(
            "label: Active customers",
            "label: Plan customers",
          ),
        },
      ],
      rationale: "x",
    });
    await finish(asked.proposalId, { kind: "modeler", status: "proposed", items: [] });
    await settleProposal(s.deps, s.orgId, run.runId);
    const items = (await s.tenant((tx) => getProposal(tx, as(), asked.proposalId)))?.items.map((i) => i.id) ?? [];
    await s.tenant((tx) => rejectProposal(tx, as(), asked.proposalId, "Count accounts, not subscriptions."));
    const rejected = await s.tenant((tx) => getProposal(tx, as(), asked.proposalId));
    expect(rejected).toMatchObject({ status: "rejected", note: "Count accounts, not subscriptions.", items: [] });
    const [gone] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.context_item where id = any(${items}::uuid[]) and deleted_at is null`;
    expect(gone?.n).toBe(0);
    // Asked again, a new draft starts; the Modeler says it can't: failed, with its reason.
    const again = await requestMetricDraft(deps(), as(), { queryRunId: runs.q2 as string });
    expect(again.proposalId).not.toBe(asked.proposalId);
    await finish(again.proposalId, {
      kind: "modeler",
      status: "cannot_draft",
      items: [],
      reason: "It lists plans, not one figure.",
    });
    expect(await settleProposal(s.deps, s.orgId, await runOf(again.proposalId))).toBe("failed");
    expect((await s.tenant((tx) => getProposal(tx, as(), again.proposalId)))?.evidence.failed).toBe(
      "It lists plans, not one figure.",
    );
    // Background work off: held, with the reason, and no run.
    await s.tenant((tx) =>
      setSpendLimits(
        tx,
        { orgId: s.orgId, userId: s.userId },
        { monthlyUsd: null, dailyUsd: null, backgroundMonthlyUsd: 0 },
      ),
    );
    const held = await requestMetricDraft(deps(), as(), { queryRunId: runs.q1 as string });
    expect(held.status).toBe("held");
    const view = await s.tenant((tx) => getProposal(tx, as(), held.proposalId));
    expect(view?.heldReason).toMatch(/Background work is off/);
    expect(await runOf(held.proposalId)).toBeNull();
  });
});
