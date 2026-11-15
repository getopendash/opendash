// The readiness score: five equal parts, each with what to do next, on the demo source as
// it's learned, as its definitions are verified and tested, with a query history, and with eval runs.
import { dialectFor } from "@opendash/connectors";
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDefinitions, demoPack, installDefinitions, mineHistory, type Readiness, sourceReadiness } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const NOW = new Date("2026-10-11T12:00:00Z");
const readiness = () => s.tenant((tx) => sourceReadiness(tx, s.orgId, s.connectionId));
const part = (r: Readiness, key: string) => r.parts.find((p) => p.key === key);

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("readiness", () => {
  it("on a source just learned: its key tables profiled, nothing verified, no evals", async () => {
    const r = await readiness();
    expect(r.history).toBe(false);
    expect(part(r, "coverage")).toMatchObject({
      score: 0,
      detail: "0 of 10 key tables",
      next: { action: "verify_dataset", table: expect.stringMatching(/^[a-z_]+\.[a-z_]+$/) },
    });
    expect(part(r, "metrics")).toMatchObject({ score: 0, detail: "0 of 5", next: { label: "Verify 5 more metrics" } });
    expect(part(r, "profiled")).toMatchObject({ score: 1, detail: "10 of 10 key tables", next: null });
    expect(part(r, "queries")).toMatchObject({ score: 0, detail: "0 of 10" });
    expect(part(r, "evals")).toMatchObject({ score: 0, next: { action: "add_evals" } });
    expect(r.score).toBe(20);
  });

  it("counts verified definitions, and the tables a dataset covers once it's tested", async () => {
    const ctx = { orgId: s.orgId, userId: s.userId };
    await s.tenant((tx) =>
      installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
    );
    // Verified before they were tested: what they cover isn't known yet.
    const before = await readiness();
    expect(part(before, "coverage")?.next).toEqual({
      action: "sync",
      label: "Sync now to see which tables 8 datasets cover",
    });
    expect(part(before, "metrics")).toMatchObject({ score: 1, detail: "13 verified", next: null });
    expect(part(before, "queries")).toMatchObject({ score: 0, detail: "0 of 10" });

    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW });
    const [subscriptions] = await s.t.owner<{ tables: string[] }[]>`
      select v.derived->'tables' as tables from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.connection_id = ${s.connectionId} and i.kind = 'dataset' and i.slug = 'subscriptions'`;
    expect(subscriptions?.tables).toContain("public.subscriptions");
    const after = await readiness();
    const coverage = part(after, "coverage");
    expect(coverage?.score).toBeGreaterThan(0);
    expect(coverage?.next?.action).toBe("verify_dataset");
    // A deleted definition doesn't count.
    const [gone] = await s.t.owner<{ id: string }[]>`
      update app.context_item set deleted_at = now()
      where id = (select id from app.context_item where connection_id = ${s.connectionId} and kind = 'metric' limit 1)
      returning id`;
    expect(part(await readiness(), "metrics")?.detail).toBe("12 verified");
    await s.t.owner`update app.context_item set deleted_at = null where id = ${gone?.id ?? ""}`;
  });

  it("ranks tables by the team's own queries when the source has a history", async () => {
    await mineHistory(
      s.deps,
      { orgId: s.orgId, connectionId: s.connectionId },
      {
        ...dialectFor("postgres"),
        queryHistory: async () => ({
          available: true,
          statements: [
            { fingerprint: "1", sql: "select count(*) from public.users where role = $1", calls: 90, totalMs: 9 },
            {
              fingerprint: "2",
              sql: "select count(*) from public.subscriptions where status = $1",
              calls: 40,
              totalMs: 4,
            },
          ],
        }),
      },
      { close: async () => {} },
    );
    const r = await readiness();
    expect(r.history).toBe(true);
    const coverage = part(r, "coverage");
    expect(coverage?.detail).toMatch(/^\d of 2 most-used tables$/);
    // public.users has no dataset in the pack.
    expect(coverage).toMatchObject({
      score: 0.5,
      detail: "1 of 2 most-used tables",
      next: { action: "verify_dataset", label: "Verify a dataset over public.users", table: "public.users" },
    });
  });

  it("takes the pass rate of this source's questions from the latest finished run", async () => {
    const suite = uuidv7();
    const [a, b] = [uuidv7(), uuidv7()];
    await s.t.owner`insert into app.eval_suite (org_id, id, name, scope) values (${s.orgId}, ${suite}, 'Org', 'org')`;
    for (const id of [a, b]) {
      await s.t.owner`
        insert into app.eval_case (org_id, id, suite_id, connection_id, question, question_hash, reference_spec, origin)
        values (${s.orgId}, ${id}, ${suite}, ${s.connectionId}, ${`Question ${id}?`}, ${id}, '{"metrics":["mrr"]}', 'admin')`;
    }
    expect(part(await readiness(), "evals")).toMatchObject({ detail: "Not run yet", next: { label: "Run evals" } });
    const run = async (finishedAt: string, verdicts: [string, string][]) => {
      const id = uuidv7();
      await s.t.owner`
        insert into app.eval_run (org_id, id, suite_id, model, trigger, status, finished_at)
        values (${s.orgId}, ${id}, ${suite}, 'm', 'manual', 'done', ${finishedAt})`;
      for (const [caseId, verdict] of verdicts) {
        await s.t.owner`
          insert into app.eval_result (org_id, eval_run_id, case_id, verdict) values (${s.orgId}, ${id}, ${caseId}, ${verdict})`;
      }
    };
    await run("2026-10-09T00:00:00Z", [
      [a, "pass"],
      [b, "pass"],
    ]);
    await run("2026-10-10T00:00:00Z", [
      [a, "pass"],
      [b, "fail"],
    ]);
    expect(part(await readiness(), "evals")).toMatchObject({
      score: 0.5,
      detail: "1 of 2 checks passed in the latest run",
      next: { action: "run_evals", label: "Fix what failed, then run evals again" },
    });
  });
});
