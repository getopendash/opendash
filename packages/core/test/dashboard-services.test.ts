// A dashboard reads a service: a tracker's search, as its owner's account, shaped into rows and
// counted by the same compiler (in Postgres, over the snapshot). Checked when it's saved; answered for its owner
// alone; never shared while it reads one; one call a bucket for every query on it; a revoked key leaves nothing.
import type { Definition, ServiceDataset } from "@opendash/apps/dashboard";
import { uuidv7 } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DashboardQueryJob, dashboards, mcp } from "../src";
import { member, verifiedSource } from "./helpers/checks";
import { type FakeMcp, fakeMcp } from "./helpers/fake-mcp";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let tracker: FakeMcp;
let serverId = "";
let dashboardId = "";
let revision = "";
const NOW = new Date("2026-10-11T09:00:00Z");
const bob = uuidv7();
const previousFlag = process.env.OPENDASH_MCP;
let mcpDeps: mcp.McpDeps;

const as = (userId: string) => ({ orgId: s.orgId, userId });
const withUser = <T>(orgId: string, userId: string, fn: Parameters<typeof withTenantOn<T>>[2]) =>
  withTenantOn(s.t.app, { orgId, userId }, fn);

const definition = (): Definition =>
  ({
    version: 2,
    title: "Late issues",
    filters: {},
    datasets: {
      t_issues: {
        connection: serverId,
        title: "Late issues",
        service: { tool: "search_issues", arguments: { query: "late" } },
        columns: [
          { name: "key", path: "key", type: "string" },
          { name: "title", path: "title", type: "string" },
          { name: "assignee", path: "assignee", type: "string" },
        ],
        key: "key",
        link: { column: "key", url: "https://tracker.acme.example/browse/{key}" },
      },
    },
    queries: {
      q_count: { source: { connection: serverId, dataset: "t_issues" }, measures: { n: ["count"] }, filters: {} },
      q_by: {
        source: { connection: serverId, dataset: "t_issues" },
        measures: { n: ["count"] },
        by: ["assignee"],
        filters: {},
      },
      q_in: {
        source: { connection: serverId, dataset: "t_issues" },
        measures: { n: ["count"] },
        where: [["key", "in", ["ACME-1", "ACME-9"]]],
        filters: {},
      },
      q_list: {
        source: { connection: serverId, dataset: "t_issues" },
        select: ["key", "title"],
        sort: ["key"],
        filters: {},
      },
    },
  }) as unknown as Definition;

const ask = (userId: string, requests: dashboards.DashboardRequest[]) =>
  withUser(s.orgId, userId, (tx) =>
    dashboards.requestDashboardQueries({ boss: s.boss }, tx, as(userId), { dashboardId, revision, requests, now: NOW }),
  );
const drain = async () => {
  const jobs = await s.t.owner<{ data: DashboardQueryJob }[]>`
    select data from pgboss.job where name = 'dashboard.query' and state = 'created'`;
  for (const j of jobs) {
    await dashboards.executeDashboardQuery({ ...s.deps, withUser, mcp: mcpDeps }, j.data);
  }
  await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
};

beforeAll(async () => {
  process.env.OPENDASH_MCP = "1";
  ({ s } = await verifiedSource(NOW));
  await member(s, s.userId, "maya@acme.example", "owner");
  await member(s, bob, "bob@acme.example", "member");
  mcpDeps = {
    secrets: s.secrets,
    edition: "community",
    withTenant: (ctx, fn) => withTenantOn(s.t.app, ctx, fn),
    redirectUrl: "https://opendash.test/api/mcp/callback",
  };
  tracker = await fakeMcp();
  tracker.set({ keys: { tk_live_maya_1234: "maya", tk_live_bob_5678: "bob" } });
  serverId = (await mcp.approveServer(mcpDeps, as(s.userId), { name: "Tracker", url: tracker.url, auth: "apikey" })).id;
  await mcp.putKey(mcpDeps, as(s.userId), { serverId, key: "tk_live_maya_1234" });
  // An admin lists its tools (through their own key), which keeps them.
  await mcp.listServerTools(mcpDeps, as(s.userId), serverId);
  dashboardId = await withUser(s.orgId, s.userId, (tx) =>
    dashboards.createDashboard(tx, as(s.userId), { title: "Late issues" }),
  );
}, 300_000);

afterAll(async () => {
  process.env.OPENDASH_MCP = previousFlag;
  await tracker?.close();
  await s?.close();
});

describe("a dashboard reading a service", () => {
  it("is refused at save until the tool may run in dashboards, then checked once and kept with its digest", async () => {
    const ds = definition().datasets?.t_issues as ServiceDataset;
    const probe = () =>
      dashboards.probeServiceDataset(
        { withTenant: s.deps.withTenant, mcp: mcpDeps },
        { orgId: s.orgId, owner: s.userId, name: "t_issues", ds },
      );
    expect(await probe()).toEqual({
      ok: false,
      message: "Tracker isn't allowed in dashboards: an admin turns it on under Data → Connections.",
    });
    await s.t.owner`update app.mcp_server set dashboards_allowed = true where id = ${serverId}`;
    expect((await probe()).ok).toBe(false);
    await s.t.owner`
      update app.mcp_tool set dashboards_allowed = true, tier = 'always' where server_id = ${serverId}`;
    const made = await probe();
    expect(made).toMatchObject({
      ok: true,
      rows: 2,
      sample: [
        { key: "ACME-1", title: "late 1", assignee: "maya" },
        { key: "ACME-2", title: "late 2", assignee: "maya" },
      ],
    });
    const digest = made.ok ? made.digest : "";
    const d = definition();
    const kept = d.datasets?.t_issues as ServiceDataset;
    kept.service.digest = digest;
    const saved = await withUser(s.orgId, s.userId, (tx) =>
      dashboards.saveDraft(tx, as(s.userId), dashboardId, {
        definition: d,
        // Its page, as the worker builds it: a version must have one.
        parts: {
          files: { "/App.tsx": "export default function App() { return null; }" },
          bundle: "/* the App */",
          bundleHash: "c".repeat(64),
        },
        baseVersion: 0,
      }),
    );
    expect(saved).toMatchObject({ ok: true });
    revision = saved.ok ? saved.revision : "";
  });

  it("answers its owner from one call, counted like any dataset; never anyone else", async () => {
    const calls = tracker.calls.length;
    expect((await ask(s.userId, [{ id: "a", query: "q_count" }]))?.[0]).toMatchObject({ status: "queued" });
    await ask(s.userId, [
      { id: "b", query: "q_by" },
      { id: "c", query: "q_list" },
    ]);
    await drain();
    // Three queries on one dataset: one call of the tool, as Maya.
    expect(tracker.calls.slice(calls)).toEqual([
      expect.objectContaining({ tool: "search_issues", account: "maya", args: { query: "late" } }),
    ]);
    await ask(s.userId, [{ id: "d", query: "q_in" }]);
    await drain();
    const [count, by, list, inList] = (await ask(s.userId, [
      { id: "a", query: "q_count" },
      { id: "b", query: "q_by" },
      { id: "c", query: "q_list" },
      { id: "d", query: "q_in" },
    ])) as {
      status: string;
      result: { requestId: string; columns: { name: string; values: unknown[] }[]; service?: unknown };
    }[];
    // A list of values is one bound array, as on a warehouse.
    expect(inList?.result.columns.find((c) => c.name === "n")?.values).toEqual([1]);
    // Each answer its own id, though one snapshot holds them all.
    expect(new Set([count, by, list, inList].map((a) => a?.result.requestId)).size).toBe(4);
    expect(count?.status).toBe("ok");
    expect(count?.result.columns.find((c) => c.name === "n")?.values).toEqual([2]);
    expect(by?.result.columns).toEqual([
      { name: "assignee", kind: "text", values: ["maya"] },
      { name: "n", kind: "number", values: [2] },
    ]);
    expect(list?.result.columns.find((c) => c.name === "key")?.values).toEqual(["ACME-1", "ACME-2"]);
    expect(count?.result.service).toMatchObject({ name: "Tracker", incomplete: false, cut: 0 });
    const published = await withUser(s.orgId, s.userId, (tx) =>
      dashboards.publishDraft(tx, as(s.userId), dashboardId, { revision }),
    );
    expect(published.version).toBe(1);
  });

  it("shared, each person sees it with their own account, never anyone else's", async () => {
    await withUser(s.orgId, s.userId, (tx) => dashboards.setDashboardVisibility(tx, as(s.userId), dashboardId, "org"));
    // Bob hasn't connected: he's asked to, never answered from Maya's account.
    expect((await ask(bob, [{ id: "a", query: "q_by" }]))?.[0]).toEqual({
      id: "a",
      status: "failed",
      error: "Connect your Tracker account under Data → Connections to see this: it's read with each person's own.",
    });
    await mcp.putKey(mcpDeps, as(bob), { serverId, key: "tk_live_bob_5678" });
    const calls = tracker.calls.length;
    expect((await ask(bob, [{ id: "a", query: "q_by" }]))?.[0]).toMatchObject({ status: "queued" });
    await drain();
    expect(tracker.calls.slice(calls)).toEqual([expect.objectContaining({ tool: "search_issues", account: "bob" })]);
    const [bobs] = (await ask(bob, [{ id: "a", query: "q_by" }])) as {
      status: string;
      result: { columns: { name: string; values: unknown[] }[] };
    }[];
    expect(bobs?.result.columns[0]?.values).toEqual(["bob"]);
    const [mayas] = (await ask(s.userId, [{ id: "a", query: "q_by" }])) as (typeof bobs)[];
    expect(mayas?.result.columns[0]?.values).toEqual(["maya"]);
  });

  it("stops when the tool changes, and keeps nothing when its account is gone", async () => {
    await s.t
      .owner`update app.mcp_tool set digest = 'changed' where server_id = ${serverId} and name = 'search_issues'`;
    expect((await ask(s.userId, [{ id: "a", query: "q_count" }]))?.[0]).toMatchObject({
      status: "failed",
      error: "Tracker's search_issues changed since this was built: ask the analyst to check it again.",
    });
    await s.t.owner`update app.mcp_tool set digest = reviewed_digest where server_id = ${serverId}`;
    await s.t.owner`delete from app.mcp_connection where server_id = ${serverId}`;
    expect((await ask(s.userId, [{ id: "a", query: "q_count" }]))?.[0]).toMatchObject({
      status: "failed",
      error: "Connect your Tracker account under Data → Connections to see this: it's read with each person's own.",
    });
  });
});
