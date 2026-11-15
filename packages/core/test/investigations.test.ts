// The Investigator v0's lifecycle, without a model: an insight investigated when someone presses Investigate (or a
// routine asks: telling.test.ts), as background work in a thread that's nobody's conversation, its job carrying ids
// only; held when the month's background budget is spent, saying why, and started again once there's room; settled
// from its run, confirmed or not (an insight it didn't confirm stays open: a model's verdict never hides a
// detection); and its query cells open to the organization.
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getQueryCard,
  getRun,
  investigationsFor,
  listInsights,
  setSpendLimits,
  settleInvestigation,
  startInvestigation,
  watchMetric,
} from "../src";
import { actor, check, checkOf, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
let ids: Record<string, string> = {};
let monitor = "";
let insight = "";
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const deps = () => ({ withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never });
const investigation = async (insightId: string) =>
  (await s.tenant((tx) => investigationsFor(tx, s.orgId, [insightId]))).get(insightId);
const runOf = async (insightId: string) =>
  (
    await s.t.owner<{ run_id: string }[]>`
      select run_id from app.investigation where org_id = ${s.orgId} and insight_id = ${insightId}`
  )[0]?.run_id as string;
const endRun = (runId: string, status: string, outcome: unknown) =>
  s.t.owner`update app.run set status = ${status}, outcome = ${s.t.owner.json(outcome as never)}, finished_at = now()
    where org_id = ${s.orgId} and id = ${runId}`;
const writeUp = (confirmed: boolean) => ({
  kind: "investigation",
  confirmed,
  verified: true,
  moved: { rendered: "New accounts fell.", segments: [{ text: "New accounts fell." }] },
  reasons: [],
  unchecked: [],
  citations: [],
  problems: [],
});
const anotherInsight = async () => {
  const id = uuidv7();
  await s.t.owner`insert into app.insight (org_id, id, check_id, connection_id, kind, metric_id, direction, period,
      title, summary, severity, dedupe_key)
    values (${s.orgId}, ${id}, ${monitor}, ${s.connectionId}, 'anomaly', ${ids.mrr as string}, 'up', '2026-09-01',
      'Monthly recurring revenue rose more than usual in September 2026', 'It rose.', 1, ${`anomaly:${id}`})`;
  return id;
};

beforeAll(async () => {
  ({ s, ids } = await verifiedSource(NOW));
  await s.tenant((tx) => watchMetric(tx, actor(s), ids.new_accounts as string, NOW));
  monitor = (await checkOf(s, ids.new_accounts as string, "month")) as string;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("an insight's investigation", () => {
  it("starts when asked, as background work no conversation list shows, its job ids only", async () => {
    // Finding it starts nothing: the Investigator runs when a person or a routine asks.
    await check(s, ids.new_accounts as string, "month", NOW);
    insight = (await s.tenant((tx) => listInsights(tx, { orgId: s.orgId, userId: null }))).find(
      (i) => i.period === "2026-09-01",
    )?.id as string;
    expect(await investigation(insight)).toBeUndefined();
    expect(await startInvestigation(deps(), { orgId: s.orgId, insightId: insight, requestedBy: s.userId })).toEqual({
      status: "queued",
    });
    expect(await investigation(insight)).toMatchObject({ status: "queued", heldReason: null, outcome: null });
    const runId = await runOf(insight);
    const [run] = await s.t.owner<
      {
        trigger: string;
        profile: string;
        channel: string;
        created_by: string | null;
        visibility: string;
        text: string;
      }[]
    >`
      select r.trigger, r.profile, t.channel, t.created_by, t.visibility, m.text from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      join app.message m on m.org_id = r.org_id and m.id = r.input_message_id where r.id = ${runId}`;
    expect(run).toMatchObject({ trigger: "insight", profile: "investigator", channel: "insight", created_by: null });
    // The brief names the insight in words; its figures are counted again, never handed over.
    expect(run?.text).toContain("New accounts fell more than usual in September 2026");
    expect(run?.text.replaceAll("2026", "")).not.toMatch(/\d/);
    const [job] = await s.t.owner<{ data: unknown }[]>`
      select data from pgboss.job where name = 'agent.background' and data->>'runId' = ${runId}`;
    expect(job?.data).toEqual({ orgId: s.orgId, runId });
    // Nobody's conversation: no member reads it as one.
    expect(await getRun(s.deps, { orgId: s.orgId, userId: s.userId }, runId)).toBeNull();
    // Asked again, it isn't investigated twice.
    expect(await startInvestigation(deps(), { orgId: s.orgId, insightId: insight })).toEqual({ status: "queued" });
  });

  it("doesn't investigate a source's late data, and holds one when the background budget is spent", async () => {
    const late = uuidv7();
    await s.t
      .owner`insert into app.insight (org_id, id, connection_id, kind, period, title, summary, severity, dedupe_key)
      values (${s.orgId}, ${late}, ${s.connectionId}, 'data_quality', '2026-09-01', 'Late data', 'Late.', 1,
        ${`freshness:${late}`})`;
    expect(await startInvestigation(deps(), { orgId: s.orgId, insightId: late })).toEqual({
      status: "not_investigable",
    });
    const held = await anotherInsight();
    await s.t.system.client`
      insert into app.usage_event (id, org_id, kind, qty, unit, model, provider, key_source, cost_usd, source_type,
        source_id, background)
      values (${uuidv7()}, ${s.orgId}, 'llm_tokens', 100, 'tokens', 'claude-sonnet-5-5', 'anthropic', 'deployment', 10,
        'run', ${uuidv7()}, true)`;
    expect(await startInvestigation(deps(), { orgId: s.orgId, insightId: held })).toEqual({ status: "held" });
    expect((await investigation(held))?.heldReason).toMatch(/^This month's background budget \(\$10\.00\) is spent/);
    // Raised, Investigate starts it.
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: null, backgroundMonthlyUsd: 50 }));
    expect(await startInvestigation(deps(), { orgId: s.orgId, insightId: held, requestedBy: s.userId })).toEqual({
      status: "queued",
    });
    expect(await investigation(held)).toMatchObject({ status: "queued", heldReason: null });
  });

  it("settles from its run, confirmed or not, never closing the insight itself, and its cells are open", async () => {
    const runId = await runOf(insight);
    // A query of the investigation: any member opens it, as they would the check's.
    const queryRunId = uuidv7();
    await s.t.owner`insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, path,
        engine, title, compiled_sql, sql_hash, status, rows, truncated, result_schema, preview, sanity, created_at)
      values (${queryRunId}, ${s.orgId}, ${s.connectionId}, 'run', ${runId}, 'execute', 'raw_sql', 'agent_sql',
        'New accounts in September', 'select 77', 'h', 'succeeded', 1, false,
        ${s.t.owner.json([{ name: "accounts", type: "int" }])}, ${s.t.owner.json([[77]])}, '[]'::jsonb, now())`;
    expect(await getQueryCard(s.deps, { orgId: s.orgId, userId: uuidv7() }, queryRunId)).not.toBeNull();

    await endRun(runId, "succeeded", writeUp(true));
    expect(await settleInvestigation({ ...s.deps, boss: s.boss }, s.orgId, runId)).toBe("confirmed");
    expect(await investigation(insight)).toMatchObject({ status: "confirmed", queries: 1, outcome: writeUp(true) });

    const alarm = await anotherInsight();
    await startInvestigation(deps(), { orgId: s.orgId, insightId: alarm });
    const alarmRun = await runOf(alarm);
    await endRun(alarmRun, "succeeded", writeUp(false));
    expect(await settleInvestigation({ ...s.deps, boss: s.boss }, s.orgId, alarmRun)).toBe("not_confirmed");
    // A model's verdict never hides a detection: the insight stays open, saying so, for a person to dismiss.
    const [kept] = await s.t.owner<{ status: string; dismiss_reason: string | null }[]>`
      select status, dismiss_reason from app.insight where id = ${alarm}`;
    expect(kept).toEqual({ status: "new", dismiss_reason: null });
    expect(await investigation(alarm)).toMatchObject({ status: "not_confirmed", outcome: writeUp(false) });

    // A run that failed fails its investigation, and Investigate starts it again.
    const failing = await anotherInsight();
    await startInvestigation(deps(), { orgId: s.orgId, insightId: failing });
    const failedRun = await runOf(failing);
    await endRun(failedRun, "failed", { kind: "no_answer", reason: "The Investigator stopped." });
    expect(await settleInvestigation({ ...s.deps, boss: s.boss }, s.orgId, failedRun)).toBe("failed");
    expect(await startInvestigation(deps(), { orgId: s.orgId, insightId: failing })).toEqual({ status: "queued" });
    expect(await runOf(failing)).not.toBe(failedRun);
  });
});
