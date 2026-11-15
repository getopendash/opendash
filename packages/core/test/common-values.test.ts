// A glossary term's column values, read live on request: the web's request queues one read per
// column per bucket for a worker, the worker reads it through the gateway under that key, and asking again returns
// what it read. Personal data and free text are never read; nothing is kept beyond the recorded query run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCommonValues, requestCommonValues, type ValuesReadJob } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const NOW = new Date("2026-10-12T09:00:00Z");
const ask = (column: string) =>
  s.tenant((tx) =>
    requestCommonValues(
      { boss: s.boss },
      tx,
      { orgId: s.orgId, userId: s.userId },
      {
        connectionId: s.connectionId,
        column,
        now: NOW,
      },
    ),
  );
const queued = async (column: string) =>
  s.t.owner<{ data: ValuesReadJob }[]>`
    select data from pgboss.job where name = 'values.read' and data->>'column' = ${column}`;

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("a column's common values, on request", () => {
  it("queues one read, which the worker runs under its key; asking again returns what it read", async () => {
    expect(await ask("public.accounts.country")).toEqual({ status: "queued" });
    expect(await ask("public.accounts.country")).toEqual({ status: "queued" });
    const jobs = await queued("public.accounts.country");
    expect(jobs).toHaveLength(1);
    const job = jobs[0]?.data as ValuesReadJob;
    expect(job).toMatchObject({ connectionId: s.connectionId, requestedBy: s.userId });
    expect(await executeCommonValues(s.deps, job)).toBe("read");
    const answer = await ask("public.accounts.country");
    expect(answer).toMatchObject({ status: "succeeded", column: "public.accounts.country", more: false });
    if (answer.status !== "succeeded") return;
    expect(answer.values[0]).toEqual({ value: "US", rows: expect.any(Number) });
    expect(answer.values.map((v) => v.value)).toContain("DE");
    const [run] = await s.t.owner<{ title: string; requester_type: string; requester_id: string }[]>`
      select title, requester_type, requester_id from app.query_run where cache_key = ${job.cacheKey}`;
    expect(run).toEqual({
      title: "Most common values of public.accounts.country",
      requester_type: "api",
      requester_id: s.userId,
    });
  });

  it("never reads personal data, a column that's gone, or one marked personal after it was asked for", async () => {
    expect(await ask("public.users.email")).toMatchObject({ status: "failed", message: /personal data/ });
    expect(await ask("public.accounts.nope")).toMatchObject({ status: "failed", message: /isn't a column/ });
    expect(await ask("public.accounts.industry")).toEqual({ status: "queued" });
    const job = (await queued("public.accounts.industry"))[0]?.data as ValuesReadJob;
    await s.t.owner`
      update app.catalog_object set sensitivity = 'pii', sensitivity_set_by = ${s.userId}
      where org_id = ${s.orgId} and fq_name = 'public.accounts.industry'`;
    expect(await executeCommonValues(s.deps, job)).toBe("skipped");
    const [runs] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.query_run where cache_key = ${job.cacheKey}`;
    expect(runs?.n).toBe(0);
  });
});
