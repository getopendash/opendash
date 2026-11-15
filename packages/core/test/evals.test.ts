// The organization's evals: the suite kept in sync with what's verified, the grader, and runs that fan out one
// job per case, skip what's done, and finish exactly once. The analyst is a stand-in here (the `ask` seam): one that
// answers from the case's own reference, one that's wrong, one whose numbers aren't traced, one that stops.
import { uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginEvalRun,
  demoPack,
  dispatchNightlyEvals,
  type EvalAnswer,
  type EvalAsk,
  type EvalCaseJob,
  EvalHandedOff,
  EvalProblem,
  type EvalRunJob,
  evalOverview,
  evalRunDetail,
  executeEvalCase,
  expectedNumbers,
  failEvalCase,
  failEvalRun,
  gradeAnswer,
  installDefinitions,
  listCases,
  matches,
  metricQuestion,
  runMetricQuery,
  saveVerifiedQuery,
  setNightlyEvals,
  startEvalRun,
  submitQuestion,
  syncCases,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let verifiedId = "";
let verifiedRanAt = "";
const NOW = new Date("2026-10-10T12:00:00Z");

const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const show = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : String(v));
const queued = async <T>(name: string, evalRunId: string) =>
  (
    await s.t.owner<{ data: T }[]>`
      select data from pgboss.job where name = ${name} and data->>'evalRunId' = ${evalRunId} order by created_on`
  ).map((j) => j.data);

/** An analyst that answers every case right: it runs the case's reference itself and cites every number. */
const perfect: EvalAsk = async (input) => {
  const c = (await s.tenant((tx) => listCases(tx, s.orgId))).find((x) => x.question === input.question);
  const r = await runMetricQuery(s.deps, {
    orgId: s.orgId,
    connectionId: input.connectionId,
    query: c?.referenceSpec ?? { metrics: ["mrr"] },
    mode: "execute",
    requester: { type: "eval", id: null },
    now: input.asOf,
  });
  const values = r.rows.flatMap((row) =>
    row.flatMap((cell, i) =>
      r.roles?.[i]?.role === "measure" && cell !== null
        ? [{ ref: `q1:0:${i}`, value: Number(cell), display: show(Number(cell)) }]
        : [],
    ),
  );
  return {
    runId: null,
    outcome: { kind: "answer", status: "answered", verified: true, rendered: "Right.", path: "metric", values },
    usage: { modelCalls: 3, costUsd: 0.01 },
  };
};

async function runAll(evalRunId: string, ask: EvalAsk) {
  const jobs = await queued<EvalCaseJob>("eval.case", evalRunId);
  // All at once: the last two to finish race to finish the run.
  await Promise.all(jobs.map((j) => executeEvalCase(s.deps, j, ask)));
  return jobs;
}

async function start(): Promise<string> {
  const { evalRunId } = await startEvalRun(s.deps, { ...ctx(), trigger: "manual", model: "test-model" });
  const [job] = await queued<EvalRunJob>("eval.run", evalRunId);
  await beginEvalRun(s.deps, job as EvalRunJob);
  return evalRunId;
}

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
  );
  // A verified query saved from an answer whose spec has the absolute dates "last month" meant when it ran.
  const { runId } = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { ...ctx(), connectionId: s.connectionId, text: "How did MRR change last month?", channel: "web", model: "m" },
  );
  const m = await runMetricQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    query: { metrics: ["mrr"], time: { range: { from: "2026-09-01", to: "2026-10-01" }, compare: "previous_period" } },
    mode: "execute",
    title: "MRR change",
    requester: { type: "run", id: runId },
    now: NOW,
  });
  ({ id: verifiedId } = await s.tenant((tx) =>
    saveVerifiedQuery(tx, ctx(), { queryRunId: m.queryRunId, question: "How did MRR change last month?" }),
  ));
  const [ran] = await s.t.owner<
    { created_at: Date }[]
  >`select created_at from app.query_run where id = ${m.queryRunId}`;
  verifiedRanAt = new Date(ran?.created_at as Date).toISOString();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("the suite", () => {
  it("asks each verified metric the way people would", () => {
    expect(metricQuestion({ title: "Monthly recurring revenue", timed: true, counts: false })).toBe(
      "What was monthly recurring revenue last month?",
    );
    expect(metricQuestion({ title: "New accounts", timed: true, counts: true })).toBe(
      "How many new accounts last month?",
    );
    expect(metricQuestion({ title: "Active subscriptions", timed: false, counts: true })).toBe(
      "How many active subscriptions are there now?",
    );
    expect(metricQuestion({ title: "Average CSAT", timed: true, counts: false })).toBe(
      "What was average CSAT last month?",
    );
  });

  it("has a case per verified metric and per verified query, and syncing again changes nothing", async () => {
    const cases = await s.tenant((tx) => syncCases(tx, s.orgId));
    const questions = cases.map((c) => c.question);
    expect(cases).toHaveLength(13 + 1);
    expect(questions).toEqual(
      expect.arrayContaining([
        "What was monthly recurring revenue last month?",
        "How many new accounts last month?",
        "How many active subscriptions are there now?",
        "What was average CSAT last month?",
      ]),
    );
    const mrr = cases.find((c) => c.question === "What was monthly recurring revenue last month?");
    expect(mrr).toMatchObject({
      origin: "onboarding",
      asOf: null,
      referenceSpec: { metrics: ["mrr"], time: { range: "last_month" } },
    });
    // A verified query is asked in its own words, as of when its query ran (its spec has that time's dates).
    const vq = cases.find((c) => c.question === "How did MRR change last month?");
    expect(vq).toMatchObject({ origin: "admin", originRef: verifiedId, asOf: verifiedRanAt });
    expect(vq?.referenceSpec?.time).toMatchObject({ range: { from: "2026-09-01", to: "2026-10-01" } });
    const again = await s.tenant((tx) => syncCases(tx, s.orgId));
    expect(again.map((c) => c.id).sort()).toEqual(cases.map((c) => c.id).sort());
  });

  it("makes a case inactive when what it was made from is gone, and active again when it's back", async () => {
    await s.t.owner`update app.context_item set deleted_at = now() where id = ${verifiedId}`;
    const without = await s.tenant((tx) => syncCases(tx, s.orgId));
    expect(without.map((c) => c.question)).not.toContain("How did MRR change last month?");
    expect((await s.tenant((tx) => listCases(tx, s.orgId))).find((c) => c.originRef === verifiedId)?.active).toBe(
      false,
    );
    await s.t.owner`update app.context_item set deleted_at = null where id = ${verifiedId}`;
    expect((await s.tenant((tx) => syncCases(tx, s.orgId))).map((c) => c.question)).toContain(
      "How did MRR change last month?",
    );
  });
});

describe("grading", () => {
  const roles = [
    { name: "month", role: "time" as const, source: "mrr_monthly.month" },
    { name: "mrr", role: "measure" as const, source: "mrr" },
  ];

  it("expects every measure cell of a small reference, and the latest period of a long one", () => {
    expect(expectedNumbers(roles, [["2026-09-01", 412600.5]], show)).toEqual([
      { label: "mrr", value: 412600.5, display: "$412.6k" },
    ]);
    const year = Array.from({ length: 12 }, (_, i) => [`2026-${String(i + 1).padStart(2, "0")}-01`, 1000 * (i + 1)]);
    expect(expectedNumbers(roles, year, show)).toEqual([
      { label: "mrr (2026-12-01)", value: 12000, display: "$12.0k" },
    ]);
    expect(expectedNumbers(roles, [["2026-09-01", null]], show)).toEqual([]);
  });

  it("matches counts exactly and other numbers within 0.5%", () => {
    expect(matches(77, 77)).toBe(true);
    expect(matches(78, 77)).toBe(false);
    expect(matches(412_600 * 1.004, 412_600.5)).toBe(true);
    expect(matches(412_600 * 1.006, 412_600.5)).toBe(false);
  });

  it("passes an answer that cites every expected number, and says why one fails", () => {
    const expected = [{ label: "mrr", value: 412600.5, display: "$412.6k" }];
    const answer = (values: number[], extra = {}) => ({
      kind: "answer",
      status: "answered",
      verified: true,
      values: values.map((v) => ({ ref: "q1:0:mrr", value: v, display: show(v) })),
      ...extra,
    });
    expect(gradeAnswer(expected, answer([412600.5]))).toMatchObject({ verdict: "pass", reason: "Cited $412.6k." });
    // $413.2k is within 0.5% of $412.6k; $425.0k isn't.
    expect(gradeAnswer(expected, answer([413200])).verdict).toBe("pass");
    expect(gradeAnswer(expected, answer([425000]))).toMatchObject({
      verdict: "fail",
      reason: "Expected $412.6k; the answer cited $425.0k.",
    });
    expect(gradeAnswer(expected, answer([412600.5], { verified: false }))).toMatchObject({
      verdict: "fail",
      untraced: true,
    });
    expect(gradeAnswer(expected, { kind: "clarify" }).reason).toMatch(/asked a question/);
    expect(gradeAnswer(expected, answer([], { status: "cannot_answer" })).reason).toMatch(/couldn't answer/);
  });
});

describe("a run", () => {
  let first = "";

  it("is one at a time, checks every active case, and finishes once when the last result is in", async () => {
    first = await start();
    await expect(startEvalRun(s.deps, { ...ctx(), trigger: "manual", model: "m" })).rejects.toBeInstanceOf(EvalProblem);
    const asked: { question: string; asOf: string }[] = [];
    const jobs = await runAll(first, async (input) => {
      asked.push({ question: input.question, asOf: input.asOf.toISOString() });
      return perfect(input);
    });
    expect(jobs).toHaveLength(14);
    const run = await s.tenant((tx) => evalRunDetail(tx, s.orgId, first));
    expect(run).toMatchObject({ status: "done", metrics: { total: 14, done: 14, passed: 14, failed: 0, untraced: 0 } });
    expect(run?.metrics.calls).toBe(42);
    expect(run?.results.every((r) => r.verdict === "pass")).toBe(true);
    // The verified query's case was asked as of its query's time; the others as of the run.
    const started = run?.startedAt as string;
    expect(asked.find((a) => a.question === "How did MRR change last month?")?.asOf).toBe(verifiedRanAt);
    expect(asked.filter((a) => a.question !== "How did MRR change last month?").every((a) => a.asOf === started)).toBe(
      true,
    );
  });

  it("skips a case that's already graded (a repeated or resumed job)", async () => {
    const [job] = await queued<EvalCaseJob>("eval.case", first);
    let called = false;
    await executeEvalCase(s.deps, job as EvalCaseJob, async (input) => {
      called = true;
      return perfect(input);
    });
    expect(called).toBe(false);
    const [n] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.eval_result where eval_run_id = ${first} and case_id = ${job?.caseId ?? ""}`;
    expect(n?.n).toBe(1);
  });

  it("fails a wrong answer with why, counts an untraced one, and an analyst that stops is an error", async () => {
    const id = await start();
    const wrong = "What was monthly recurring revenue last month?";
    const untraced = "What was churned MRR last month?";
    const stops = "How many new accounts last month?";
    await runAll(id, async (input): Promise<EvalAnswer> => {
      const right = await perfect(input);
      if (input.question === stops) throw new Error("the model timed out");
      if (input.question === wrong && right.outcome) {
        return {
          ...right,
          outcome: {
            ...right.outcome,
            values: (right.outcome.values ?? []).map((v) => ({
              ...v,
              value: Number(v.value) * 1.1,
              display: show(Number(v.value) * 1.1),
            })),
          },
        };
      }
      if (input.question === untraced && right.outcome)
        return { ...right, outcome: { ...right.outcome, verified: false } };
      return right;
    });
    const run = await s.tenant((tx) => evalRunDetail(tx, s.orgId, id));
    expect(run?.metrics).toMatchObject({ total: 14, passed: 11, failed: 2, errors: 1, untraced: 1 });
    expect(run?.results.slice(0, 3).map((r) => r.verdict)).toEqual(["fail", "fail", "error"]);
    // "Last month" is the run's: the figures depend on today, the shape of the reason doesn't.
    expect(run?.results.find((r) => r.question === wrong)?.diff?.reason).toMatch(
      /^Expected \$[\d.]+k; the answer cited \$[\d.]+k\.$/,
    );
    expect(run?.results.find((r) => r.question === stops)?.diff?.reason).toBe(
      "The analyst stopped: the model timed out",
    );
    // The suite shows each case's last result, failures first.
    const overview = await s.tenant((tx) => evalOverview(tx, s.orgId));
    expect(overview.cases[0]?.last?.verdict).not.toBe("pass");
    expect(overview.runs.map((r) => r.id).slice(0, 2)).toEqual([id, first]);
  });

  it("is an error, not a failure, when the reference can't be computed", async () => {
    const suite = await s.t.owner<{ id: string }[]>`select id from app.eval_suite where org_id = ${s.orgId}`;
    const caseId = uuidv7();
    const evalRunId = uuidv7();
    await s.t.owner`
      insert into app.eval_case (org_id, id, suite_id, connection_id, question, question_hash, reference_spec, origin)
      values (${s.orgId}, ${caseId}, ${suite[0]?.id ?? ""}, ${s.connectionId}, 'What was nothing?', ${caseId},
        '{"metrics": ["no_such_metric"]}', 'admin')`;
    await s.t.owner`
      insert into app.eval_run (org_id, id, suite_id, model, trigger, status, started_at, case_ids)
      values (${s.orgId}, ${evalRunId}, ${suite[0]?.id ?? ""}, 'm', 'manual', 'running', now(), jsonb_build_array(${caseId}::text))`;
    let asked = false;
    await executeEvalCase(s.deps, { orgId: s.orgId, evalRunId, caseId }, async (input) => {
      asked = true;
      return perfect(input);
    });
    expect(asked).toBe(false);
    const run = await s.tenant((tx) => evalRunDetail(tx, s.orgId, evalRunId));
    expect(run).toMatchObject({ status: "done", metrics: { errors: 1, failed: 0 } });
    expect(run?.results[0]?.diff?.reason).toMatch(/^Its reference didn't run/);
  });

  it("records a case its job gave up on as an error, once, and the run still finishes", async () => {
    const suite = await s.t.owner<{ id: string }[]>`select id from app.eval_suite where org_id = ${s.orgId}`;
    const caseId = uuidv7();
    const evalRunId = uuidv7();
    await s.t.owner`
      insert into app.eval_case (org_id, id, suite_id, connection_id, question, question_hash, reference_spec, origin)
      values (${s.orgId}, ${caseId}, ${suite[0]?.id ?? ""}, ${s.connectionId}, 'What stopped?', ${caseId},
        '{"metrics": ["mrr"]}', 'admin')`;
    await s.t.owner`
      insert into app.eval_run (org_id, id, suite_id, model, trigger, status, started_at, case_ids)
      values (${s.orgId}, ${evalRunId}, ${suite[0]?.id ?? ""}, 'm', 'manual', 'running', now(), jsonb_build_array(${caseId}::text))`;
    // Its dead letter, delivered twice: one result.
    await failEvalCase(s.deps, { orgId: s.orgId, evalRunId, caseId });
    await failEvalCase(s.deps, { orgId: s.orgId, evalRunId, caseId });
    const run = await s.tenant((tx) => evalRunDetail(tx, s.orgId, evalRunId));
    expect(run).toMatchObject({ status: "done", metrics: { total: 1, done: 1, errors: 1, failed: 0 } });
    expect(run?.results.map((r) => r.diff?.reason)).toEqual(["The check stopped before it finished."]);
  });

  it("refuses the second of two Run nows at once (the database's one-active-run index)", async () => {
    const both = await Promise.allSettled([
      startEvalRun(s.deps, { ...ctx(), trigger: "manual", model: "m" }),
      startEvalRun(s.deps, { ...ctx(), trigger: "manual", model: "m" }),
    ]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    const refused = both.find((b) => b.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(EvalProblem);
    // A start that fails for good doesn't leave it blocking the next one.
    const started = (both.find((b) => b.status === "fulfilled") as PromiseFulfilledResult<{ evalRunId: string }>).value;
    await failEvalRun(s.deps, { orgId: s.orgId, evalRunId: started.evalRunId });
    expect((await s.tenant((tx) => evalRunDetail(tx, s.orgId, started.evalRunId)))?.status).toBe("failed");
  });

  it("runs nightly only for organizations that turned it on", async () => {
    const deps = {
      ...s.deps,
      withSystem: <T>(fn: Parameters<typeof withSystemOn<T>>[1]) => withSystemOn(s.t.system, fn),
    };
    expect(await dispatchNightlyEvals(deps)).toEqual({ started: 0 });
    await s.tenant((tx) => setNightlyEvals(tx, s.orgId, true));
    expect(await dispatchNightlyEvals(deps)).toEqual({ started: 1 });
    // One is going now: the next night's dispatch leaves it alone.
    expect(await dispatchNightlyEvals(deps)).toEqual({ started: 0 });
  });
});

describe("a case asked while the worker shuts down", () => {
  it("leaves a case asked during a shutdown to its job's next run, recording nothing for it", async () => {
    // One eval run at a time: whatever the cases above left going ends first.
    await s.t
      .owner`update app.eval_run set status = 'failed' where org_id = ${s.orgId} and status in ('queued', 'running')`;
    const evalRunId = await start();
    const [job] = await queued<EvalCaseJob>("eval.case", evalRunId);
    await expect(
      executeEvalCase(s.deps, job as EvalCaseJob, async () => {
        throw new EvalHandedOff("Handed off.");
      }),
    ).rejects.toThrow(EvalHandedOff);
    const results = () =>
      s.t.owner<{ n: number }[]>`
        select count(*)::int as n from app.eval_result where eval_run_id = ${evalRunId} and case_id = ${job?.caseId ?? ""}`;
    expect((await results())[0]?.n).toBe(0);
    // Run again, it's asked and graded.
    await executeEvalCase(s.deps, job as EvalCaseJob, perfect);
    expect((await results())[0]?.n).toBe(1);
    // The rest of its cases, so the run finishes (one runs at a time).
    await runAll(evalRunId, perfect);
  });
});
