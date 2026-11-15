// A dashboard's AI summary, with a scripted model (no spend): nothing until someone asks; its
// numbers first; written from them and kept by them; a summary with a number it wasn't given is written again, then
// refused; Regenerate writes a new one; the call is counted to the person who pressed.
import {
  checkDefinitions,
  type DashboardQueryJob,
  type DashboardSummaryJob,
  dashboards,
  demoPack,
  installDefinitions,
  listDefinitions,
  verifyDefinitions,
} from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { withTenantOn } from "@opendash/db/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeSummary } from "../src";
import { scripted, step } from "./helpers/scripted";

const NOW = new Date("2026-10-10T12:00:00Z");
let s: LearnedSource;
let dashboardId = "";
let revision = "";

const viewer = () => ({ orgId: s.orgId, userId: s.userId });
const asOwner = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) =>
  withTenantOn(s.t.app, { orgId: s.orgId, userId: s.userId }, fn);
const read = (write = false, again = false, angle?: "fresh" | "lead" | "short" | "email") =>
  asOwner((tx) =>
    dashboards.summaryAnswer({ boss: s.boss }, tx, viewer(), {
      dashboardId,
      revision,
      section: "s_summary",
      filters: {},
      ...(write ? { write: true } : {}),
      ...(again ? { again: true } : {}),
      ...(angle ? { angle } : {}),
    }),
  );
const drainQueries = async () => {
  const jobs = await s.t.owner<{ data: DashboardQueryJob }[]>`
    select data from pgboss.job where name = 'dashboard.query' and state = 'created'`;
  for (const j of jobs) await dashboards.executeDashboardQuery(s.deps, j.data);
  await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
};
const write = async (model: MockLanguageModelV4) => {
  const [job] = await s.t.owner<{ data: DashboardSummaryJob }[]>`
    select data from pgboss.job where name = 'dashboard.summary' and state = 'created'`;
  await s.t.owner`delete from pgboss.job where name = 'dashboard.summary'`;
  if (!job) return "no job";
  return writeSummary(
    {
      withTenant: s.deps.withTenant,
      withUser: (orgId, userId, fn) => withTenantOn(s.t.app, { orgId, userId }, fn),
      boss: s.boss,
      model: async () => ({
        model,
        provider: "opendash",
        route: "anthropic",
        providerOptions: {},
        keySource: "deployment",
      }),
    },
    job.data,
  );
};
const text = (t: string) => step({ type: "text", text: t });

beforeAll(async () => {
  s = await learnedSource();
  const ctx = viewer();
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
  dashboardId = await asOwner((tx) => dashboards.createDashboard(tx, viewer(), { title: "Accounts" }));
  const source = { connection: s.connectionId, dataset: "accounts" };
  const saved = await asOwner((tx) =>
    dashboards.saveDraft(tx, viewer(), dashboardId, {
      baseVersion: 0,
      definition: {
        version: 2,
        title: "Accounts",
        filters: {},
        queries: { q_count: { source, measures: { n: ["count"] }, filters: {} } },
        summaries: { s_summary: { queries: ["q_count"], prompt: "How many accounts there are" } },
      },
    }),
  );
  if (!saved.ok) throw new Error(JSON.stringify(saved.problems));
  revision = saved.revision;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("a dashboard's AI summary", () => {
  it("waits for its numbers, writes nothing until asked, then writes from them only", async () => {
    expect(await read()).toEqual({ status: "waiting" });
    await drainQueries();
    expect(await read()).toMatchObject({ status: "none", sources: [{ query: "q_count" }] });
    expect(await read(true)).toEqual({ status: "writing" });
    expect(await read()).toEqual({ status: "writing" });
    const [n] = await s.source.query("select count(*)::int as n from public.accounts where not is_test");
    const count = Number(n?.n);
    const { model, prompts } = scripted([text(`There are ${count.toLocaleString("en-US")} accounts in all.`)]);
    expect(await write(model)).toBe("written");
    // The numbers went as data, with the summary's question.
    const sent = JSON.stringify(prompts[0]);
    expect(sent).toContain("How many accounts there are");
    expect(sent).toContain(String(count));
    expect(await read()).toMatchObject({
      status: "ok",
      text: `There are ${count.toLocaleString("en-US")} accounts in all.`,
    });
    // Counted to the person who pressed, on this dashboard.
    const [u] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.usage_event
      where org_id = ${s.orgId} and source_type = 'dashboard' and source_id = ${dashboardId} and user_id = ${s.userId}`;
    expect(u?.n).toBe(1);
  });

  it("writes again a summary with a number it wasn't given, then refuses it; Regenerate writes anew", async () => {
    expect(await read(true, true)).toEqual({ status: "writing" });
    const { model, prompts } = scripted([text("There are 987654 accounts."), text("Still 987654 accounts.")]);
    expect(await write(model)).toBe("failed");
    expect(JSON.stringify(prompts[1])).toContain("numbers that aren't in the data (987654)");
    expect(await read()).toEqual({
      status: "failed",
      error: "Couldn't write a summary that only uses these numbers: try again.",
    });
    expect(await read(true)).toEqual({ status: "writing" });
    const again = scripted([text("Every account is counted here.")]);
    expect(await write(again.model)).toBe("written");
    expect(await read()).toMatchObject({ status: "ok", text: "Every account is counted here." });
  });

  it("rewrites from an angle chosen by a press, says what it's written from and what it cost", async () => {
    expect(await read(true, true, "short")).toEqual({ status: "writing" });
    const short = scripted([text("Every account is here.")]);
    expect(await write(short.model)).toBe("written");
    expect(JSON.stringify(short.prompts[0])).toContain("Write one sentence only.");
    const got = await read();
    expect(got).toMatchObject({ status: "ok", sources: [{ query: "q_count" }] });
    expect(got && "cost" in got && got.cost && typeof got.cost.month).toBe("number");
  });

  it("says it failed when the worker gives up on it, and never writes that over a note written meanwhile", async () => {
    const job = async () => {
      const [j] = await s.t.owner<{ data: DashboardSummaryJob }[]>`
        select data from pgboss.job where name = 'dashboard.summary' and state = 'created'`;
      await s.t.owner`delete from pgboss.job where name = 'dashboard.summary'`;
      if (!j) throw new Error("no summary job");
      return j.data;
    };
    // A dead letter of an earlier press, after this note was written: the note stays.
    expect(await read(true, true)).toEqual({ status: "writing" });
    const earlier = await job();
    expect(await read(true, true)).toEqual({ status: "writing" });
    expect(await write(scripted([text("Every account is listed.")]).model)).toBe("written");
    await dashboards.summaryFailed(s.deps, earlier);
    expect(await read()).toMatchObject({ status: "ok", text: "Every account is listed." });
    // The job gone with no note written: the summary says so (with Write to try again), not nothing.
    expect(await read(true, true)).toEqual({ status: "writing" });
    await dashboards.summaryFailed(s.deps, await job());
    expect(await read()).toEqual({
      status: "failed",
      error: "Its summary couldn't be written: press Write to try again.",
    });
  });
});

describe("the numbers a summary may say", () => {
  const answer = (values: (number | string)[]) => ({
    query: "q",
    title: "t",
    result: {
      requestId: "r",
      dataset: "d",
      columns: [{ name: "v", kind: "number" as const, values }],
      rowCount: 2,
      total: 2,
      truncated: false,
      hidden: [],
      asOf: "",
    },
  });

  it("are the ones given, at the rounding and unit written: a share as a percent, thousands as k", () => {
    const allowed = dashboards.summaryNumbers([answer([1234.567, 0.4213, "Team 27", "2026-10-01"])]);
    expect(
      dashboards.strayNumbers("1,234.57 rose 42% (1.2k) for Team 27 on 2026-10-01 at 10:42, 2 rows, in 2026", allowed),
    ).toEqual([]);
    expect(dashboards.strayNumbers("about 1,500 more", allowed)).toEqual(["1500"]);
  });

  it("never a figure made up around a real one: another amount, a scale, a year the data hasn't", () => {
    const allowed = dashboards.summaryNumbers([answer([42])]);
    expect(dashboards.strayNumbers("$2,000 and 42 million, back in 2019", allowed)).toEqual([
      "2000",
      "42 million",
      "2019",
    ]);
    expect(dashboards.strayNumbers("42 of them", allowed)).toEqual([]);
  });
});
