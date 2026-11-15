// Verified queries v0: an admin saves an answer's metric query and it's verified at once, with the spec and result
// from the query run itself; SQL, a query that didn't run, or one in a conversation the saver can't see can't be
// saved; the same question twice is refused; an edit is a new version over the same query; delete removes it.
import { uuidv7 } from "@opendash/db";
import { NOW } from "@opendash/evals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContextProblem,
  claimRun,
  deleteContextItem,
  demoPack,
  finalizeRun,
  getVerifiedQuery,
  installDefinitions,
  listVerifiedQueries,
  runMetricQuery,
  runQuery,
  saveVerifiedQuery,
  shapeOf,
  submitQuestion,
  VERIFIED_MATCH,
  verifiedFollowed,
  verifiedForQuestion,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let runId = "";
let metricRun = "";
let sqlRun = "";
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof ContextProblem) return error.message;
    throw error;
  }
};

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
  );
  ({ runId } = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      text: "How did MRR change last month?",
      channel: "web",
      model: "test-model",
    },
  ));
  const requester = { type: "run" as const, id: runId };
  const m = await runMetricQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    query: { metrics: ["mrr"], time: { grain: "month", range: { from: "2026-08-01", to: "2026-10-01" } } },
    mode: "execute",
    title: "MRR, August and September",
    requester,
    now: new Date(NOW),
  });
  metricRun = (m as { queryRunId: string }).queryRunId;
  const q = await runQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    sql: "select count(*) as n from public.accounts",
    mode: "execute",
    requester,
  });
  sqlRun = q.queryRunId;
}, 300_000);
afterAll(async () => {
  await s?.close();
});

describe("verified queries", () => {
  let id = "";

  it("saves an answer's metric query, verified, with the spec and result the query run recorded", async () => {
    ({ id } = await s.tenant((tx) =>
      saveVerifiedQuery(tx, ctx(), {
        queryRunId: metricRun,
        question: "  How did MRR change last month? ",
        phrasings: ["MRR movement in September", "how did mrr change last month?", "MRR movement in September"],
      }),
    ));
    const v = await s.tenant((tx) => getVerifiedQuery(tx, s.orgId, id));
    expect(v).toMatchObject({
      question: "How did MRR change last month?",
      // The question itself and a repeat aren't other wordings.
      phrasings: ["MRR movement in September"],
      metrics: ["mrr"],
      version: 1,
      verifiedBy: s.userId,
      connectionId: s.connectionId,
    });
    expect(v?.spec.query.time).toEqual({ grain: "month", range: { from: "2026-08-01", to: "2026-10-01" } });
    expect(v?.spec.from).toEqual({ runId, queryRunId: metricRun });
    expect(v?.spec.fingerprint).toMatchObject({ rows: 2, resultHash: expect.any(String) });
    expect(v?.spec.fingerprint.columns.map((c) => c.name)).toContain("mrr");
    const [item] = await s.t.owner<{ status: string; released_version: number; path: string }[]>`
      select status, released_version, path from app.context_item where id = ${id}`;
    expect(item).toEqual({
      status: "verified",
      released_version: 1,
      path: "/verified/how_did_mrr_change_last_month.md",
    });
    expect((await s.tenant((tx) => listVerifiedQueries(tx, s.orgId))).map((x) => x.id)).toEqual([id]);
  });

  it("refuses SQL, the same question twice, and a query the saver can't see", async () => {
    expect(
      await problem(
        s.tenant((tx) => saveVerifiedQuery(tx, ctx(), { queryRunId: sqlRun, question: "How many accounts?" })),
      ),
    ).toMatch(/Only a metric query/);
    expect(
      await problem(
        s.tenant((tx) =>
          saveVerifiedQuery(tx, ctx(), { queryRunId: metricRun, question: "How did MRR change last month?" }),
        ),
      ),
    ).toMatch(/already a verified query/);
    // The conversation is private to the one who asked.
    expect(
      await problem(
        s.tenant((tx) =>
          saveVerifiedQuery(tx, { orgId: s.orgId, userId: uuidv7() }, { queryRunId: metricRun, question: "MRR?" }),
        ),
      ),
    ).toMatch(/doesn't exist/);
    expect(
      await problem(s.tenant((tx) => saveVerifiedQuery(tx, ctx(), { queryRunId: metricRun, question: "x" }))),
    ).toMatch(/Write the question/);
  });

  it("edits as a new version over the same query, and deletes", async () => {
    const before = await s.tenant((tx) => getVerifiedQuery(tx, s.orgId, id));
    await s.tenant((tx) =>
      saveVerifiedQuery(tx, ctx(), {
        id,
        question: "How did MRR change last month?",
        phrasings: ["MRR last month vs the month before"],
      }),
    );
    const after = await s.tenant((tx) => getVerifiedQuery(tx, s.orgId, id));
    expect(after).toMatchObject({ version: 2, phrasings: ["MRR last month vs the month before"] });
    expect(after?.spec.query).toEqual(before?.spec.query);
    expect(after?.spec.from).toEqual(before?.spec.from);
    expect(await s.tenant((tx) => deleteContextItem(tx, s.orgId, id))).toBe(true);
    expect(await s.tenant((tx) => listVerifiedQueries(tx, s.orgId))).toEqual([]);
  });
});

describe("the analyst is given the verified queries like its question", () => {
  let id = "";
  const like = (q: string, mentioned: string[] = []) =>
    s.tenant((tx) => verifiedForQuestion(tx, s.orgId, s.connectionId, q, mentioned));
  beforeAll(async () => {
    ({ id } = await s.tenant((tx) =>
      saveVerifiedQuery(tx, ctx(), {
        queryRunId: metricRun,
        question: "How did MRR change last month?",
        phrasings: ["MRR movement in September", "how much did MRR grow last month"],
      }),
    ));
  });

  // Measured: other wordings score 0.45 to 0.72 against the question or a wording, other questions 0.15 to 0.31.
  it("matches other wordings of the question, and not other questions", async () => {
    expect(VERIFIED_MATCH).toBe(0.4);
    for (const q of [
      "how much did MRR move in september?",
      "MRR change last month?",
      "How did MRR change in September?",
    ]) {
      expect(
        (await like(q)).map((m) => m.id),
        q,
      ).toEqual([id]);
    }
    for (const q of [
      "How many support tickets were opened last month?",
      "What was churned MRR by plan last month?",
      "How many paying customers did we have at the end of September?",
    ]) {
      expect(await like(q), q).toEqual([]);
    }
    const [m] = await like("how much did MRR move in september?");
    expect(m?.spec.query.metrics).toEqual(["mrr"]);
  });

  it("brings a verified query over a metric the question names, however far its wording", async () => {
    // A held-out paraphrase that trigram similarity misses.
    const q = "how much did our monthly recurring revenue move in september?";
    expect(await like(q)).toEqual([]);
    expect((await like(q, ["mrr"])).map((m) => m.id)).toEqual([id]);
    // Naming another metric brings nothing over MRR.
    expect(await like("What was churned MRR by plan last month?", ["churned_mrr"])).toEqual([]);
  });

  it("counts as guiding an answer only when the run computed its metrics, once, when the run ends", async () => {
    const other = await s.tenant((tx) =>
      saveVerifiedQuery(tx, ctx(), { queryRunId: metricRun, question: "What was MRR in August and September?" }),
    );
    // The run computed MRR by month, as both verified queries do, so the one given was followed; a version that
    // doesn't exist matches nothing.
    expect(
      (
        await s.tenant((tx) =>
          verifiedFollowed(tx, s.orgId, runId, [
            { id, version: 1 },
            { id: other.id, version: 9 },
          ]),
        )
      ).sort(),
    ).toEqual([id]);
    const run = await claimRun({ withTenant: s.deps.withTenant }, { orgId: s.orgId, runId }, "w-verified");
    if (!run) throw new Error("not claimed");
    await finalizeRun({ withTenant: s.deps.withTenant }, run, "succeeded", {
      kind: "answer",
      context: [
        {
          id,
          kind: "verified_query",
          title: "How did MRR change last month?",
          version: 1,
          how: "question",
          followed: true,
        },
      ],
    } as never);
    const [row] = await s.t.owner<{ usage_count: number }[]>`select usage_count from app.context_item where id = ${id}`;
    expect(row?.usage_count).toBe(1);
  });
});

describe("a verified query's shape", () => {
  it("ignores the period and the filters' values, and nothing else", () => {
    const base = { metrics: ["mrr"], time: { grain: "month", compare: "previous_period" } };
    expect(shapeOf({ ...base, time: { ...base.time } })).toBe(shapeOf(base));
    // Another period or another plan: the same question.
    expect(shapeOf({ ...base, filters: [{ field: "plans.name", op: "eq" }] })).toBe(
      shapeOf({ ...base, filters: [{ field: "plans.name", op: "eq" }] }),
    );
    // MRR now, MRR by plan, churned MRR: other questions.
    expect(shapeOf({ metrics: ["mrr"], time: { grain: "month" } })).not.toBe(shapeOf(base));
    expect(shapeOf({ ...base, dimensions: ["plans.name"] })).not.toBe(shapeOf(base));
    expect(shapeOf({ ...base, metrics: ["churned_mrr"] })).not.toBe(shapeOf(base));
  });
});
