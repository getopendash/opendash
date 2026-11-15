// The analyst reads connected services, with a scripted model (no spend) and a fake MCP
// server: it finds a service's tools and reads one as the person; someone who hasn't connected gets a Connect card that
// ends the run; a tool that asks first gets an Allow once card, and the allowance covers that exact call once; a
// shared conversation never reads a person's own account; tools that change things aren't used; a shared run's
// readers see its structure only; and nothing is offered where no service is on.
import { randomUUID } from "node:crypto";
import { mcp, runEvents, submitQuestion } from "@opendash/core";
import { type FakeMcp, fakeMcp, type LearnedSource, learnedSource } from "@opendash/core/testing";
import { withTenantOn } from "@opendash/db/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { analyst } from "../src/agents/analyst";
import { call, type Prompt, scripted, step } from "./helpers/scripted";

const NOW = new Date("2026-10-10T12:00:00Z");
let s: LearnedSource;
let tracker: FakeMcp;
let serverId = "";
let mcpDeps: mcp.McpDeps;
const member = randomUUID();
const previousFlag = process.env.OPENDASH_MCP;

const deps = (model: MockLanguageModelV4, withMcp = true): AgentDeps => ({
  withTenant: s.deps.withTenant,
  secrets: s.secrets,
  edition: "community",
  model: async () => ({
    model,
    provider: "opendash",
    route: "anthropic",
    providerOptions: {},
    keySource: "deployment",
  }),
  now: () => NOW,
  ...(withMcp ? { mcp: mcpDeps } : {}),
});

const ask = (userId: string, text: string, threadId?: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId,
      connectionId: s.connectionId,
      text,
      channel: "web",
      model: "mock",
      ...(threadId ? { threadId } : {}),
    },
  );
const run = (model: MockLanguageModelV4, runId: string, withMcp = true) =>
  runAttempt(deps(model, withMcp), { orgId: s.orgId, runId }, { workerId: "test" }, analyst);
const outcomeOf = async (runId: string) =>
  (
    await s.t.owner<{ outcome: { kind: string } & Record<string, unknown> }[]>`
    select outcome from app.run where id = ${runId}`
  )[0]?.outcome;

/** Every tool result the model was shown, as JSON. */
const results = (prompt: Prompt) =>
  prompt
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .map((p) => (p.type === "tool-result" && p.output.type === "json" ? JSON.stringify(p.output.value) : ""));

const answered = (markdown: string) =>
  step(call("answer", { status: "answered", markdown, interpretation: [], caveats: [] }));
const search = (query = "late") =>
  call("mcp_call", { server_id: serverId, tool: "search_issues", arguments: { query } });

beforeAll(async () => {
  process.env.OPENDASH_MCP = "1";
  s = await learnedSource();
  await s.t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${member}, 'Mia', ${`mia-${member}@acme.test`}, true)`;
  await s.t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${randomUUID()}, ${s.orgId}, ${member}, 'member', now())`;
  tracker = await fakeMcp();
  tracker.set({ idTokens: true });
  mcpDeps = {
    secrets: s.secrets,
    edition: "community",
    withTenant: (ctx, fn) => withTenantOn(s.t.app, ctx, fn),
    redirectUrl: "https://opendash.test/api/mcp/callback",
  };
  const owner = { orgId: s.orgId, userId: s.userId };
  serverId = (await mcp.approveServer(mcpDeps, owner, { name: "Tracker", url: tracker.url })).id;
  const started = await mcp.startConnect(mcpDeps, owner, { serverId });
  await mcp.finishConnect(mcpDeps, owner, tracker.approve(started.authorizationUrl, "owner"));
  await mcp.listServerTools(mcpDeps, owner, serverId);
});

afterAll(async () => {
  process.env.OPENDASH_MCP = previousFlag;
  await tracker?.close();
  await s?.close();
});

describe("reading a connected service as the person who asked", () => {
  it("finds the tools, reads as the asker, and the steps say which service but never what it sent", async () => {
    const q = await ask(s.userId, "Which issues are late in our tracker?");
    const { model, prompts, tools } = scripted([
      step(call("mcp_find", { query: "issue" })),
      step(search()),
      answered("Two issues are late, both yours."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(tools[0]).toEqual(expect.arrayContaining(["mcp_find", "mcp_call"]));
    const [found, read] = results(prompts.at(-1) ?? []);
    expect(found).toContain('"tool":"search_issues"');
    // A tool that changes things is offered, asking first (it adds, never deletes or overwrites).
    const listed = (
      JSON.parse(found ?? "{}") as { servers: { tools: { tool: string; asks_first?: boolean; input: string }[] }[] }
    ).servers.flatMap((x) => x.tools);
    expect(listed.find((t) => t.tool === "create_issue")?.asks_first).toBe(true);
    // Its input whole, as the service lists it.
    expect(JSON.parse(listed.find((t) => t.tool === "create_issue")?.input ?? "{}")).toMatchObject({ type: "object" });
    expect(found).not.toContain("not_usable");
    expect(read).toContain("ACME-1");
    expect(read).toContain('\\"assignee\\":\\"owner\\"');
    expect(read).toContain("the person's own account");
    expect((await outcomeOf(q.runId))?.kind).toBe("answer");
    const events = await s.t.owner<{ data: Record<string, unknown> }[]>`
      select data from app.run_event where run_id = ${q.runId} and type = 'tool_result' and data->>'tool' = 'mcp_call'`;
    expect(events[0]?.data).toMatchObject({ server: "Tracker", mcp_tool: "search_issues", scope: "personal" });
    expect(JSON.stringify(events)).not.toContain("ACME-1");
  });

  it("a tool that changes things asks the person first, showing the exact call, and nothing runs until they allow it", async () => {
    const q = await ask(s.userId, "Open an issue for the late invoice");
    const { model } = scripted([
      step(call("mcp_call", { server_id: serverId, tool: "create_issue", arguments: { title: "Late invoice" } })),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(await outcomeOf(q.runId)).toMatchObject({
      kind: "mcp_consent",
      server: "Tracker",
      tool: "create_issue",
      arguments: { title: "Late invoice" },
    });
    expect(tracker.calls.some((c) => c.tool === "create_issue")).toBe(false);
  });

  describe("a change is sent at most once in a run", () => {
    const create = () =>
      call("mcp_call", { server_id: serverId, tool: "create_issue", arguments: { title: "Late invoice" } });
    const made = () => tracker.calls.filter((c) => c.tool === "create_issue").length;
    const always = (tier: "always" | "ask") =>
      mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "create_issue", { tier });

    it("the same change asked for again in the run, by a new call, isn't made twice", async () => {
      await always("always");
      const q = await ask(s.userId, "Open an issue for the late invoice");
      const before = made();
      const { model, prompts } = scripted([step(create()), step(create()), answered("Opened it.")]);
      expect((await run(model, q.runId))?.status).toBe("succeeded");
      expect(made()).toBe(before + 1);
      expect(results(prompts.at(-1) ?? []).at(-1)).toContain("already made");
      const [sent] = await s.t.owner<{ status: string }[]>`
        select status from app.effect where channel = 'mcp' and payload->>'runId' = ${q.runId}`;
      expect(sent?.status).toBe("sent");
      await always("ask");
    });

    it("after a crash mid-send, the recovered run's call (a new call id) is refused as maybe done, never resent", async () => {
      await always("always");
      const q = await ask(s.userId, "Open an issue for the late invoice");
      // The attempt that died had claimed the send and may have sent it: its outbox row is still `sending`.
      await s.deps.withTenant(s.orgId, (tx) =>
        mcp.claimSend(tx, {
          orgId: s.orgId,
          runId: q.runId,
          toolCallId: null,
          serverId,
          tool: "create_issue",
          args: { title: "Late invoice" },
        }),
      );
      const before = made();
      const { model, prompts } = scripted([step(create()), answered("It may already be there.")]);
      expect((await run(model, q.runId))?.status).toBe("succeeded");
      expect(made()).toBe(before);
      expect(results(prompts.at(-1) ?? []).at(-1)).toContain("may already have gone");
      const [kept] = await s.t.owner<{ status: string }[]>`
        select status from app.effect where channel = 'mcp' and payload->>'runId' = ${q.runId}`;
      expect(kept?.status).toBe("sending");
      await always("ask");
    });
  });

  it("someone who hasn't connected gets a Connect card, and the run ends there", async () => {
    const before = tracker.calls.length;
    const q = await ask(member, "Which issues are late in our tracker?");
    const { model } = scripted([step(search())]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(await outcomeOf(q.runId)).toEqual({
      kind: "mcp_connect",
      serverId,
      server: "Tracker",
      // Where it is, for the service's mark on the card.
      host: new URL(tracker.url).host,
      auth: "oauth",
      state: "connect",
      scope: "personal",
      message: null,
    });
    expect(tracker.calls.length).toBe(before);
  });

  it("a shared conversation never reads a person's own account", async () => {
    const q = await ask(s.userId, "Late issues?");
    await s.t.owner`update app.thread set visibility = 'org' where id = ${q.threadId}`;
    const before = tracker.calls.length;
    const { model, prompts } = scripted([
      step(search()),
      answered("I can't read the tracker in a shared conversation."),
    ]);
    await run(model, q.runId);
    expect(results(prompts.at(-1) ?? []).at(-1)).toContain("would be seen by others");
    expect(tracker.calls.length).toBe(before);
  });

  it("a conversation Slack carries on isn't private to the person, so their own account isn't read there", async () => {
    const q = await ask(s.userId, "Late issues?");
    await s.t.owner`update app.thread set channel = 'slack' where id = ${q.threadId}`;
    const before = tracker.calls.length;
    const { model, prompts } = scripted([step(search()), answered("I can't read the tracker here.")]);
    await run(model, q.runId);
    expect(results(prompts.at(-1) ?? []).at(-1)).toContain("would be seen by others");
    expect(tracker.calls.length).toBe(before);
    await s.t.owner`update app.thread set channel = 'web' where id = ${q.threadId}`;
  });

  it("arguments with a NUL character are refused (the card couldn't show them)", async () => {
    const q = await ask(s.userId, "Late issues?");
    const before = tracker.calls.length;
    const { model, prompts } = scripted([step(search("late\u0000")), answered("I couldn't search that.")]);
    await run(model, q.runId);
    expect(results(prompts.at(-1) ?? []).at(-1)).toContain("NUL");
    expect(tracker.calls.length).toBe(before);
  });

  it("nothing is offered where connected services aren't set up", async () => {
    const q = await ask(s.userId, "Hello");
    const { model, tools } = scripted([answered("Hello.")]);
    await run(model, q.runId, false);
    expect(tools[0]).not.toContain("mcp_call");
    expect(tools[0]).not.toContain("mcp_find");
  });
});

describe("a dashboard on a connected service", () => {
  it("saves a dataset of one call as its owner, checked once, with the tool's digest; never for anyone else", async () => {
    await s.t.owner`update app.mcp_server set dashboards_allowed = true where id = ${serverId}`;
    await s.t.owner`
      update app.mcp_tool set dashboards_allowed = true, tier = 'always' where server_id = ${serverId}
        and name = 'search_issues'`;
    const issues = (path: string) => ({
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
            { name: "assignee", path, type: "string" },
          ],
          key: "key",
        },
      },
      queries: {
        q_by: {
          source: { connection: serverId, dataset: "t_issues" },
          measures: { n: ["count"] },
          by: ["assignee"],
          filters: {},
        },
      },
    });
    const q = await ask(s.userId, "Make me a dashboard of late issues by assignee");
    const { model, prompts } = scripted([
      step(call("dashboard_save", { definition: issues("owner.name") })),
      step(call("dashboard_save", { definition: issues("assignee") })),
      answered("Late issues by assignee is ready as a draft."),
    ]);
    expect((await run(model, q.runId))?.status).toBe("succeeded");
    expect(results(prompts[1] ?? []).at(-1)).toContain("Nothing in its answer is at the path of assignee");
    expect(results(prompts[2] ?? []).at(-1)).toContain('"saved":"draft"');
    const [d] = await s.t.owner<{ definition: { datasets: { t_issues: { service: { digest?: string } } } } }[]>`
      select r.definition from app.dashboard x join app.dashboard_draft r on r.dashboard_id = x.id
      where x.thread_id = ${q.threadId}`;
    const [tool] = await s.t.owner<{ digest: string }[]>`
      select digest from app.mcp_tool where server_id = ${serverId} and name = 'search_issues'`;
    expect(d?.definition.datasets.t_issues.service.digest).toBe(tool?.digest);
  });
});

describe("a tool that asks first", () => {
  let threadId = "";

  it("ends the run with an Allow once card showing exactly what would be sent", async () => {
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", { tier: "ask" });
    const before = tracker.calls.length;
    const q = await ask(s.userId, "Any late issues?");
    threadId = q.threadId;
    const { model } = scripted([step(search("overdue"))]);
    await run(model, q.runId);
    const card = await outcomeOf(q.runId);
    expect(card).toMatchObject({
      kind: "mcp_consent",
      serverId,
      server: "Tracker",
      tool: "search_issues",
      reason: "ask",
      arguments: { query: "overdue" },
    });
    expect(card?.digest).toBe(mcp.callDigest(serverId, "search_issues", { query: "overdue" }));
    expect(tracker.calls.length).toBe(before);
  });

  it("Allow once covers only the call on the card: another call asks again", async () => {
    const q = await ask(s.userId, mcp.ALLOW_ONCE, threadId);
    const before = tracker.calls.length;
    const { model, prompts } = scripted([step(search("something else"))]);
    await run(model, q.runId);
    // The conversation's earlier runs come first in what the model is shown: this run's result is the last.
    expect(results(prompts.at(-1) ?? []).at(-1) ?? "").not.toContain("ACME-1");
    expect(tracker.calls.length).toBe(before);
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "mcp_consent", arguments: { query: "something else" } });
  });

  it("allowed, it runs once; the same call in the same run asks again", async () => {
    const q = await ask(s.userId, mcp.ALLOW_ONCE, threadId);
    const before = tracker.calls.length;
    const { model, prompts } = scripted([step(search("something else")), step(search("something else"))]);
    await run(model, q.runId);
    // The allowed call's result is the last the model was shown; the same call again ended the run with a card.
    const allowed = results(prompts.at(-1) ?? []).at(-1) ?? "";
    expect(allowed).toContain('"consented":true');
    expect(allowed).toContain("ACME-1");
    expect(tracker.calls.length).toBe(before + 1);
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "mcp_consent" });
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", {
      tier: "always",
    });
  });

  it("two identical calls in one step: the allowance runs one of them", async () => {
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", { tier: "ask" });
    const q1 = await ask(s.userId, "Search for stuck issues");
    const { model: m1 } = scripted([step(search("stuck"))]);
    await run(m1, q1.runId);
    expect(await outcomeOf(q1.runId)).toMatchObject({ kind: "mcp_consent" });
    const q2 = await ask(s.userId, mcp.ALLOW_ONCE, q1.threadId);
    const before = tracker.calls.length;
    const { model: m2 } = scripted([step(search("stuck"), search("stuck"))]);
    await run(m2, q2.runId);
    expect(tracker.calls.length).toBe(before + 1);
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", {
      tier: "always",
    });
  });

  it("Allow once on a card for a tool that changed since, or another sign-in, asks again", async () => {
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", { tier: "ask" });
    const shown = async (threadId?: string, runs = false) => {
      const q = await ask(s.userId, threadId ? mcp.ALLOW_ONCE : "Search for blocked issues", threadId);
      const { model } = scripted([step(search("blocked")), ...(runs ? [answered("One is blocked.")] : [])]);
      await run(model, q.runId);
      return q;
    };
    const q1 = await shown();
    const card = await outcomeOf(q1.runId);
    expect(card).toMatchObject({ kind: "mcp_consent", binding: expect.any(String) });
    // The service lists the tool differently now (its digest): the yes on the old card isn't for it.
    const [listed] = await s.t.owner<{ digest: string }[]>`
      select digest from app.mcp_tool where server_id = ${serverId} and name = 'search_issues'`;
    await s.t
      .owner`update app.mcp_tool set digest = 'relisted' where server_id = ${serverId} and name = 'search_issues'`;
    const before = tracker.calls.length;
    const q2 = await shown(q1.threadId);
    expect(tracker.calls.length).toBe(before);
    const again = await outcomeOf(q2.runId);
    expect(again).toMatchObject({ kind: "mcp_consent", arguments: { query: "blocked" } });
    expect(again?.binding).not.toBe(card?.binding);
    // Another sign-in since that card: asked again too.
    await s.t.owner`update app.mcp_connection set revision = revision + 1 where server_id = ${serverId}`;
    const q3 = await shown(q1.threadId);
    expect(tracker.calls.length).toBe(before);
    expect(await outcomeOf(q3.runId)).toMatchObject({ kind: "mcp_consent" });
    // The latest card, allowed, runs.
    await shown(q1.threadId, true);
    expect(tracker.calls.length).toBe(before + 1);
    await s.t
      .owner`update app.mcp_tool set digest = ${listed?.digest ?? ""} where server_id = ${serverId} and name = 'search_issues'`;
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", {
      tier: "always",
    });
  });

  it("typing Allow once without a card asks again", async () => {
    const q = await ask(s.userId, mcp.ALLOW_ONCE);
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", { tier: "ask" });
    const before = tracker.calls.length;
    const { model } = scripted([step(search())]);
    await run(model, q.runId);
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "mcp_consent" });
    expect(tracker.calls.length).toBe(before);
    await mcp.updateTool(mcpDeps, { orgId: s.orgId, userId: s.userId }, serverId, "search_issues", {
      tier: "always",
    });
  });
});

describe("a conversation shared after reading a person's own account", () => {
  it("shows its other readers the structure only", async () => {
    const q = await ask(s.userId, "Late issues, please");
    const { model } = scripted([step(search()), answered("A few issues are late.")]);
    await run(model, q.runId);
    await s.t.owner`update app.thread set visibility = 'org' where id = ${q.threadId}`;
    const mine = await runEvents(s.deps, { orgId: s.orgId, userId: s.userId }, q.runId);
    const theirs = await runEvents(s.deps, { orgId: s.orgId, userId: member }, q.runId);
    const started = (events: { type: string; data: Record<string, unknown> }[]) =>
      events.find((e) => e.type === "tool_started" && e.data.tool === "mcp_call")?.data;
    expect(started(mine)).toHaveProperty("input");
    expect(theirs.length).toBeGreaterThan(0);
    expect(started(theirs)).not.toHaveProperty("input");
    expect(theirs.every((e) => (e.data as { redacted?: boolean }).redacted === true)).toBe(true);
    // A later run in the conversation carries what came back (its transcript): its readers get structure only too.
    const later = await ask(s.userId, "And which of them is oldest?", q.threadId);
    const { model: model2 } = scripted([answered("The oldest is the first one.")]);
    await run(model2, later.runId);
    const laterTheirs = await runEvents(s.deps, { orgId: s.orgId, userId: member }, later.runId);
    expect(laterTheirs.length).toBeGreaterThan(0);
    expect(laterTheirs.every((e) => (e.data as { redacted?: boolean }).redacted === true)).toBe(true);
    // Events expire; the calls they came from are kept: once the first run's events are gone, it still holds.
    await s.t.owner`delete from app.run_event where run_id = ${q.runId}`;
    const afterExpiry = await runEvents(s.deps, { orgId: s.orgId, userId: member }, later.runId);
    expect(afterExpiry.every((e) => (e.data as { redacted?: boolean }).redacted === true)).toBe(true);
  });
});

describe("an admin asked about a shared service nobody has connected", () => {
  it("gets a card that says it's the account everyone uses", async () => {
    const crm = await fakeMcp();
    crm.set({ idTokens: true });
    const owner = { orgId: s.orgId, userId: s.userId };
    const { id } = await mcp.approveServer(mcpDeps, owner, { name: "CRM", url: crm.url, access: "shared" });
    const started = await mcp.startConnect(mcpDeps, owner, { serverId: id });
    await mcp.finishConnect(mcpDeps, owner, crm.approve(started.authorizationUrl, "reporting"));
    await mcp.listServerTools(mcpDeps, owner, id);
    await mcp.disconnect(mcpDeps, owner, { serverId: id });
    const q = await ask(s.userId, "Deals this quarter?");
    const { model } = scripted([
      step(call("mcp_call", { server_id: id, tool: "search_issues", arguments: { query: "deals" } })),
    ]);
    await run(model, q.runId);
    expect(await outcomeOf(q.runId)).toMatchObject({ kind: "mcp_connect", server: "CRM", scope: "org" });
    await crm.close();
  });
});
