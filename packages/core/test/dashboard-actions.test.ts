// A dashboard's row actions and the loose ends of reading a service: each read is
// recorded for the person it read as; a number's rows come from the read it was made from; a row's action is
// prepared as an effect, confirmed, sent once with the person's own account, and settled once.
import type { Definition, ServiceDataset } from "@opendash/apps/dashboard";
import { uuidv7 } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DashboardQueryJob, dashboards, getQueryCard, mcp } from "../src";
import { member, verifiedSource } from "./helpers/checks";
import { type FakeMcp, fakeMcp } from "./helpers/fake-mcp";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let tracker: FakeMcp;
let serverId = "";
let dashboardId = "";
let revision = "";
const NOW = new Date();
const bob = uuidv7();
const previousFlag = process.env.OPENDASH_MCP;
let mcpDeps: mcp.McpDeps;

const as = (userId: string) => ({ orgId: s.orgId, userId });
const withUser = <T>(orgId: string, userId: string, fn: Parameters<typeof withTenantOn<T>>[2]) =>
  withTenantOn(s.t.app, { orgId, userId }, fn);

const definition = (digest: string): Definition =>
  ({
    version: 2,
    title: "Late issues",
    filters: {},
    datasets: {
      t_issues: {
        connection: serverId,
        title: "Late issues",
        service: { tool: "search_issues", arguments: { query: "late" }, digest },
        columns: [
          { name: "key", path: "key", type: "string" },
          { name: "title", path: "title", type: "string" },
          { name: "assignee", path: "assignee", type: "string" },
        ],
        key: "key",
      },
    },
    queries: {
      q_count: { source: { connection: serverId, dataset: "t_issues" }, measures: { n: ["count"] }, filters: {} },
      q_list: {
        source: { connection: serverId, dataset: "t_issues" },
        select: ["key", "title"],
        sort: ["key"],
        filters: {},
        key: "key",
        work: { statuses: ["To do", "Done"] },
        actions: [
          {
            id: "a_file",
            label: "File it",
            connection: serverId,
            tool: "create_issue",
            arguments: { title: "{key}" },
            confirm: "File {key} again?",
          },
        ],
      },
    },
  }) as unknown as Definition;

type Ok = { status: "ok"; result: { columns: { name: string; values: unknown[] }[]; service?: { snapshot?: string } } };
const ask = (userId: string, requests: dashboards.DashboardRequest[], retry = false) =>
  withUser(s.orgId, userId, (tx) =>
    dashboards.requestDashboardQueries({ boss: s.boss }, tx, as(userId), {
      dashboardId,
      revision,
      requests,
      now: NOW,
      retry,
    }),
  );
const drain = async () => {
  const jobs = await s.t.owner<{ data: DashboardQueryJob }[]>`
    select data from pgboss.job where name = 'dashboard.query' and state = 'created'`;
  for (const j of jobs) await dashboards.executeDashboardQuery({ ...s.deps, withUser, mcp: mcpDeps }, j.data);
  await s.t.owner`delete from pgboss.job where name = 'dashboard.query'`;
};
// Asked as the page asks after a change (a retry: the same answers, asked for again).
const answered = async (userId: string, requests: dashboards.DashboardRequest[]) => {
  await ask(userId, requests, true);
  await drain();
  return (await ask(userId, requests)) as unknown as Ok[];
};
const prepare = (userId: string, key: unknown, snapshot?: string) =>
  withUser(s.orgId, userId, (tx) =>
    dashboards.prepareAction(tx, as(userId), {
      dashboardId,
      revision,
      section: "q_list",
      action: "a_file",
      key,
      ...(snapshot ? { snapshot } : {}),
    }),
  );
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "ran",
    (e: Error) => e.message,
  );

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
  await mcp.listServerTools(mcpDeps, as(s.userId), serverId);
  await s.t.owner`update app.mcp_server set dashboards_allowed = true where id = ${serverId}`;
  await s.t.owner`
    update app.mcp_tool set dashboards_allowed = true, tier = 'always' where server_id = ${serverId}
      and name = 'search_issues'`;
  const ds = definition("").datasets?.t_issues as ServiceDataset;
  const made = await dashboards.probeServiceDataset(
    { withTenant: s.deps.withTenant, mcp: mcpDeps },
    { orgId: s.orgId, owner: s.userId, name: "t_issues", ds },
  );
  dashboardId = await withUser(s.orgId, s.userId, (tx) =>
    dashboards.createDashboard(tx, as(s.userId), { title: "Late issues" }),
  );
  const saved = await withUser(s.orgId, s.userId, (tx) =>
    dashboards.saveDraft(tx, as(s.userId), dashboardId, {
      definition: definition(made.ok ? made.digest : ""),
      // Its page, as the worker builds it: a version must have one.
      parts: {
        files: { "/App.tsx": "export default function App() { return null; }" },
        bundle: "/* the App */",
        bundleHash: "c".repeat(64),
      },
      baseVersion: 0,
    }),
  );
  revision = saved.ok ? saved.revision : "";
  await withUser(s.orgId, s.userId, (tx) => dashboards.publishDraft(tx, as(s.userId), dashboardId, { revision }));
  await withUser(s.orgId, s.userId, (tx) => dashboards.setDashboardVisibility(tx, as(s.userId), dashboardId, "org"));
}, 300_000);

afterAll(async () => {
  process.env.OPENDASH_MCP = previousFlag;
  await tracker?.close();
  await s?.close();
});

describe("reading a service", () => {
  it("records each read for the person it read as, without its rows", async () => {
    const [count] = await answered(s.userId, [{ id: "a", query: "q_count" }]);
    expect(count?.status).toBe("ok");
    const snapshot = count?.result.service?.snapshot ?? "";
    expect(snapshot).toMatch(/^[0-9a-f-]{36}$/);
    const [run] = await s.t.owner<
      { path: string; engine: string; preview: unknown; rows: number; semantic: unknown }[]
    >`
      select path, engine, preview, rows, semantic from app.query_run where id = ${snapshot}`;
    expect(run).toMatchObject({ path: "mcp", engine: "mcp", preview: null, rows: 2 });
    expect(run?.semantic).toMatchObject({ mcp: { tool: "search_issues", reader: s.userId, scope: "personal" } });
    // Maya reads her own record (named for the service); Bob, who reads the dashboard, never reads hers.
    const card = await getQueryCard(s.deps, as(s.userId), snapshot);
    expect(card?.source.name).toBe("Tracker");
    expect(await getQueryCard(s.deps, as(bob), snapshot)).toBeNull();
  });

  it("opens a number's rows from the read it was made from, and says so when that read is gone", async () => {
    const [count] = await answered(s.userId, [{ id: "a", query: "q_count" }]);
    const pin = count?.result.service?.snapshot ?? "";
    const [rows] = await answered(s.userId, [{ id: "r", drill: "q_count", pin }]);
    expect(rows?.status).toBe("ok");
    expect(rows?.result.columns.find((c) => c.name === "key")?.values).toEqual(["ACME-1", "ACME-2"]);
    const [gone] = (await ask(s.userId, [{ id: "r", drill: "q_count", pin: uuidv7() }])) as unknown as {
      status: string;
      error: string;
    }[];
    expect(gone).toMatchObject({ status: "failed", error: expect.stringContaining("aren't kept any more") });
  });
});

describe("a row's action", () => {
  let snapshot = "";
  beforeAll(async () => {
    const [list] = await answered(s.userId, [{ id: "l", query: "q_list" }]);
    snapshot = list?.result.service?.snapshot ?? "";
  });

  it("is refused for a row that isn't in the list shown, and while the tool isn't allowed in dashboards", async () => {
    expect(await refusal(prepare(s.userId, "ACME-7", snapshot))).toContain("isn't in the list as it was read");
    expect(await refusal(prepare(s.userId, "ACME-1"))).toBe("Refresh the list first.");
    expect(await refusal(prepare(s.userId, "ACME-1", snapshot))).toContain("isn't allowed in dashboards now");
    await s.t.owner`
      update app.mcp_tool set dashboards_allowed = true where server_id = ${serverId} and name = 'create_issue'`;
  });

  it("shows exactly what it sends, runs once with the person's own account, and a replay reads how it went", async () => {
    const prepared = await prepare(s.userId, "ACME-1", snapshot);
    expect(prepared).toMatchObject({
      question: "File ACME-1 again?",
      server: "Tracker",
      tool: "create_issue",
      arguments: { title: "ACME-1" },
    });
    const calls = tracker.calls.length;
    const ran = await dashboards.runAction(mcpDeps, as(s.userId), prepared.ticket);
    expect(ran).toEqual({ status: "done", result: "Created ACME-9 for maya", again: false });
    expect(tracker.calls.slice(calls)).toEqual([
      expect.objectContaining({ tool: "create_issue", account: "maya", args: { title: "ACME-1" } }),
    ]);
    // Run again (a lost answer, a second press): how it settled, and nothing sent.
    expect(await dashboards.runAction(mcpDeps, as(s.userId), prepared.ticket)).toEqual({
      status: "done",
      result: "Created ACME-9 for maya",
      again: true,
    });
    expect(tracker.calls.length).toBe(calls + 1);
    // Someone else's ticket isn't theirs to run.
    expect(await refusal(dashboards.runAction(mcpDeps, as(bob), prepared.ticket))).toContain("isn't one you prepared");
    const [audited] = await s.t.owner<{ detail: unknown }[]>`
      select detail from app.audit_log where org_id = ${s.orgId} and action = 'mcp_tool.called'`;
    expect(audited?.detail).toEqual({ tool: "create_issue", via: "dashboard", outcome: "done" });
    // The service changed: what was read from it is read again (the pinned read stays for open drills).
    const [left] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.dashboard_result where org_id = ${s.orgId} and cache_key like 'svc:%'`;
    expect(left?.n).toBe(0);
  });

  it("sends nothing once its ticket is old, or when the tool changed after it was shown", async () => {
    const old = await prepare(s.userId, "ACME-2", snapshot);
    await s.t.owner`update app.dashboard_action set expires_at = now() - interval '1 second' where id = ${old.ticket}`;
    expect(await refusal(dashboards.runAction(mcpDeps, as(s.userId), old.ticket))).toContain("press the action again");
    const [list] = await answered(s.userId, [{ id: "l", query: "q_list" }]);
    const shown = await prepare(s.userId, "ACME-2", list?.result.service?.snapshot ?? "");
    await s.t.owner`update app.mcp_tool set digest = 'changed' where server_id = ${serverId} and name = 'create_issue'`;
    const calls = tracker.calls.length;
    expect(await dashboards.runAction(mcpDeps, as(s.userId), shown.ticket)).toMatchObject({
      status: "failed",
      result: expect.stringContaining("changed since you confirmed"),
    });
    expect(tracker.calls.length).toBe(calls);
    await s.t.owner`update app.mcp_tool set digest = reviewed_digest where server_id = ${serverId}`;
  });

  it("sends nothing once the person can't read the dashboard any more (a share removed, it deleted)", async () => {
    const [list] = await answered(s.userId, [{ id: "l", query: "q_list" }]);
    const shown = await prepare(s.userId, "ACME-2", list?.result.service?.snapshot ?? "");
    await s.t.owner`update app.dashboard set deleted_at = now() where id = ${dashboardId}`;
    const calls = tracker.calls.length;
    expect(await refusal(dashboards.runAction(mcpDeps, as(s.userId), shown.ticket))).toContain(
      "isn't one you can read any more",
    );
    expect(tracker.calls.length).toBe(calls);
    await s.t.owner`update app.dashboard set deleted_at = null where id = ${dashboardId}`;
    await s.t.owner`delete from app.dashboard_action where id = ${shown.ticket}`;
  });

  it("settles a change whose process stopped as unknown, and runs one change at a time on a row", async () => {
    const [list] = await answered(s.userId, [{ id: "l", query: "q_list" }]);
    const snap = list?.result.service?.snapshot ?? "";
    // One left running by a process that stopped: settled unknown when looked at, never sent again.
    const stuck = await prepare(s.userId, "ACME-1", snap);
    await s.t.owner`
      update app.dashboard_action set status = 'running', ran_at = now() - interval '10 minutes' where id = ${stuck.ticket}`;
    const calls = tracker.calls.length;
    expect(await dashboards.runAction(mcpDeps, as(s.userId), stuck.ticket)).toMatchObject({
      status: "unknown",
      again: true,
    });
    // A row with a change running: a second one waits.
    const first = await prepare(s.userId, "ACME-2", snap);
    const second = await prepare(s.userId, "ACME-2", snap);
    await s.t.owner`update app.dashboard_action set status = 'running', ran_at = now() where id = ${first.ticket}`;
    expect(await refusal(dashboards.runAction(mcpDeps, as(s.userId), second.ticket))).toContain(
      "Another change to this row is running",
    );
    expect(tracker.calls.length).toBe(calls);
    await s.t.owner`update app.dashboard_action set status = 'done', settled_at = now() where id = ${first.ticket}`;
  });

  it("never sends a change past its deadline", async () => {
    const calls = tracker.calls.length;
    const late = await mcp.callTool(mcpDeps, as(s.userId), {
      serverId,
      tool: "create_issue",
      arguments: { title: "ACME-1" },
      via: "dashboard",
      consented: true,
      once: true,
      deadline: Date.now() - 1,
      policy: { readsOnly: false, ownAccount: true },
    });
    expect(late).toMatchObject({ state: "blocked", reason: "try_again" });
    expect(tracker.calls.length).toBe(calls);
  });

  it("never keeps a read that began before a change", async () => {
    const before = await withUser(s.orgId, s.userId, (tx) => dashboards.serviceGeneration(tx, s.orgId));
    await withUser(s.orgId, s.userId, (tx) => dashboards.serviceChanged(tx, s.orgId));
    const after = await withUser(s.orgId, s.userId, (tx) => dashboards.serviceGeneration(tx, s.orgId));
    expect(after).not.toBe(before);
    expect(after).not.toBe("");
  });

  it("answers work only for rows in the reader's own read of a personal list", async () => {
    const [list] = await answered(s.userId, [{ id: "l", query: "q_list" }]);
    const snap = list?.result.service?.snapshot ?? "";
    const at = { dashboardId, revision, section: "q_list" };
    await withUser(s.orgId, s.userId, (tx) =>
      dashboards.setWork(tx, as(s.userId), { ...at, key: "ACME-1", status: "Done", snapshot: snap }),
    );
    const read = (keys: string[], snapshot?: string) =>
      withUser(s.orgId, s.userId, (tx) =>
        dashboards.readWork(tx, as(s.userId), { ...at, keys, ...(snapshot ? { snapshot } : {}) }),
      );
    expect((await read(["ACME-1", "ACME-77"], snap))?.map((w) => w.key)).toEqual(["ACME-1"]);
    expect(await read(["ACME-1"])).toEqual([]);
    expect(
      await refusal(
        withUser(s.orgId, s.userId, (tx) =>
          dashboards.setWork(tx, as(s.userId), { ...at, key: "ACME-77", status: "Done", snapshot: snap }),
        ),
      ),
    ).toContain("isn't in the list as you see it");
    expect(
      await withUser(s.orgId, s.userId, (tx) => dashboards.readWorkHistory(tx, as(s.userId), { ...at, key: "ACME-1" })),
    ).toEqual([]);
  });

  it("is refused on a server connected once for the workspace", async () => {
    const [list] = await answered(s.userId, [{ id: "l", query: "q_list" }]);
    await s.t.owner`update app.mcp_server set access = 'shared' where id = ${serverId}`;
    expect(await refusal(prepare(s.userId, "ACME-1", list?.result.service?.snapshot ?? ""))).toMatch(
      /made by a person with their own account|isn't connected for the workspace/,
    );
    await s.t.owner`update app.mcp_server set access = 'personal' where id = ${serverId}`;
  });
});

describe("a draft an editor saved", () => {
  it("names only services the editor reads themselves, and its actions are off for its owner until they save it", async () => {
    await withUser(s.orgId, s.userId, (tx) =>
      dashboards.shareDashboard(tx, as(s.userId), dashboardId, { userId: bob, role: "edit" }),
    );
    const page = await withUser(s.orgId, s.userId, (tx) => dashboards.getDashboard(tx, as(s.userId), dashboardId));
    const save = (userId: string, title: string) =>
      withUser(s.orgId, userId, (tx) =>
        dashboards.saveDraft(tx, as(userId), dashboardId, {
          definition: { ...page?.version?.definition, title },
          baseVersion: page?.currentVersion ?? 0,
        }),
      );
    // Bob has no Tracker account of his own: his draft can't name it.
    expect(await save(bob, "Late issues, Bob's")).toMatchObject({
      ok: false,
      problems: [{ path: "datasets.t_issues", message: expect.stringMatching(/^You can't read it yourself: Connect/) }],
    });
    await mcp.putKey(mcpDeps, as(bob), { serverId, key: "tk_live_bob_5678" });
    const his = await save(bob, "Late issues, Bob's");
    expect(his).toMatchObject({ ok: true });
    const prepareOn = (userId: string, rev: string) =>
      withUser(s.orgId, userId, (tx) =>
        dashboards.prepareAction(tx, as(userId), {
          dashboardId,
          revision: rev,
          section: "q_list",
          action: "a_file",
          key: "ACME-1",
        }),
      );
    // His code, Maya's account: nothing is prepared to be sent.
    const calls = tracker.calls.length;
    expect(await refusal(prepareOn(s.userId, his.ok ? his.revision : ""))).toBe(dashboards.ACTIONS_OFF);
    expect(tracker.calls.length).toBe(calls);
    // Saved by Maya herself, her draft's actions are hers again (the next check is the list's own).
    const mine = await save(s.userId, "Late issues, Maya's");
    expect(await refusal(prepareOn(s.userId, mine.ok ? mine.revision : ""))).toBe("Refresh the list first.");
    await s.t.owner`delete from app.dashboard_draft where dashboard_id = ${dashboardId}`;
    await s.t.owner`delete from app.dashboard_share where dashboard_id = ${dashboardId}`;
  });
});
