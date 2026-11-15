// MCP connections end to end: an admin approves servers,
// people connect their own accounts through a real OAuth flow against a fake server, and every call goes through the
// one executor, which answers with the person's own data or a state with none.
import { randomBytes } from "node:crypto";
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecretStore, dekAad, generateDek, localKek, mcp } from "../src";
import { type FakeMcp, fakeMcp } from "./helpers/fake-mcp";

let t: TestDatabase;
const kek = localKek(randomBytes(32).toString("base64"));
const secrets = createSecretStore({ kek });
const orgId = uuidv7();
const maya = uuidv7(); // an admin
const alice = uuidv7();
const bob = uuidv7();
const as = (userId: string | null) => ({ orgId, userId });
const asPerson = (userId: string) => ({ orgId, userId });

let tracker: FakeMcp; // a personal server: everyone their own account
let shared: FakeMcp; // a shared server: the workspace's one account
let deps: mcp.McpDeps;
let personalId = "";
let sharedId = "";
const previousFlag = process.env.OPENDASH_MCP;

const system = <T>(q: ReturnType<typeof sql>) =>
  withSystemOn(t.system, (tx) => tx.execute<T & Record<string, unknown>>(q));

async function member(id: string, name: string, role: string) {
  await t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${id}, ${name}, ${`${name.toLowerCase()}@acme.test`}, true)`;
  await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${id}, ${role}, now())`;
}

/** Presses Connect as `userId`, signs in at the fake as `account`, and comes back. */
async function connectAs(userId: string, serverId: string, fake: FakeMcp, account: string) {
  const started = await mcp.startConnect(deps, asPerson(userId), { serverId });
  const back = fake.approve(started.authorizationUrl, account);
  return mcp.finishConnect(deps, asPerson(userId), back);
}

const search = (userId: string | null, serverId = personalId, via: mcp.McpCall["via"] = "analyst") =>
  mcp.callTool(deps, as(userId), { serverId, tool: "search_issues", arguments: { query: "late" }, via });

const textOf = (outcome: mcp.McpOutcome) =>
  outcome.state === "ready" ? (outcome.result.content as { text: string }[])[0]?.text : null;

async function problem(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof mcp.McpProblem) return error.code;
    throw error;
  }
  throw new Error("expected an McpProblem");
}

const connectionOf = async (serverId: string, scope: "org" | "personal", scopeId: string | null) =>
  (
    await system<{ id: string; secret_id: string; status: string; revision: number; refreshed_at: Date | null }>(sql`
      select id, secret_id, status, revision, refreshed_at from app.mcp_connection
      where org_id = ${orgId} and server_id = ${serverId} and scope = ${scope}
        and scope_id is not distinct from ${scopeId}::uuid`)
  )[0];

beforeAll(async () => {
  process.env.OPENDASH_MCP = "1";
  t = await freshDatabase();
  await createOrg(t, orgId, "Acme");
  const wrapped = await kek.wrap(generateDek(), dekAad(orgId, 1));
  await t.system
    .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${orgId}, 1, ${wrapped}, ${kek.ref})`;
  await member(maya, "Maya", "admin");
  await member(alice, "Alice", "member");
  await member(bob, "Bob", "member");
  tracker = await fakeMcp();
  shared = await fakeMcp();
  deps = {
    secrets,
    edition: "community",
    withTenant: (ctx, fn) => withTenantOn(t.app, ctx, fn),
    redirectUrl: "https://opendash.test/api/mcp/callback",
  };
});

afterAll(async () => {
  process.env.OPENDASH_MCP = previousFlag;
  await tracker?.close();
  await shared?.close();
  await t?.drop();
});

describe("approving a server and its tools", () => {
  it("is off when a deployment turns it off", async () => {
    process.env.OPENDASH_MCP = "0";
    expect(await problem(mcp.approveServer(deps, asPerson(maya), { name: "Tracker", url: tracker.url }))).toBe("off");
    process.env.OPENDASH_MCP = "1";
  });

  it("a member can't approve a server; an admin can, once per address", async () => {
    expect(await problem(mcp.approveServer(deps, asPerson(alice), { name: "Tracker", url: tracker.url }))).toBe(
      "forbidden",
    );
    personalId = (await mcp.approveServer(deps, asPerson(maya), { name: "Tracker", url: tracker.url })).id;
    expect(await problem(mcp.approveServer(deps, asPerson(maya), { name: "Again", url: tracker.url }))).toBe("invalid");
    const [row] = await system<{ access: string; auth: string; dashboards_allowed: boolean }>(sql`
      select access, auth, dashboards_allowed from app.mcp_server where id = ${personalId}`);
    expect(row).toEqual({ access: "personal", auth: "oauth", dashboards_allowed: false });
    const [logged] = await system<{ n: number }>(sql`
      select count(*)::int as n from app.audit_log where org_id = ${orgId} and action = 'mcp_server.approved'`);
    expect(logged?.n).toBe(1);
  });

  it("lists tools through the admin's own account: read-only ones run, the rest ask, none in dashboards", async () => {
    expect(await mcp.listServerTools(deps, asPerson(maya), personalId)).toMatchObject({
      state: "connect",
      canConnect: true,
    });
    expect(await connectAs(maya, personalId, tracker, "maya")).toMatchObject({ state: "ready" });
    expect(await problem(mcp.listServerTools(deps, asPerson(alice), personalId))).toBe("forbidden");
    const listed = await mcp.listServerTools(deps, asPerson(maya), personalId);
    expect(listed).toMatchObject({ state: "ready", removed: [], changed: [] });
    expect(listed.state === "ready" && [...listed.added].sort()).toEqual(["create_issue", "search_issues"]);
    const tools = await system<{
      name: string;
      tier: string;
      dashboards_allowed: boolean;
      digest: string;
      status: string;
    }>(sql`
      select name, tier, dashboards_allowed, digest, status from app.mcp_tool where server_id = ${personalId} order by name`);
    expect(tools.map((r) => [r.name, r.tier, r.dashboards_allowed, r.status])).toEqual([
      ["create_issue", "ask", false, "active"],
      ["search_issues", "always", false, "active"],
    ]);
    expect(tools[1]?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("listings at once of a server just connected all answer, and record its tools once", async () => {
    // The add dialog lists as the server's page, hearing the sign-in land, lists too.
    const other = await fakeMcp();
    try {
      const id = (await mcp.approveServer(deps, asPerson(maya), { name: "Other", url: other.url })).id;
      await connectAs(maya, id, other, "maya");
      const all = await Promise.all([1, 2, 3, 4].map(() => mcp.listServerTools(deps, asPerson(maya), id)));
      expect(all.map((l) => l.state)).toEqual(["ready", "ready", "ready", "ready"]);
      const added = all.flatMap((l) => (l.state === "ready" ? l.added : [])).sort();
      expect(added).toEqual(["create_issue", "search_issues"]);
      const [n] = await system<{ n: number }>(sql`
        select count(*)::int as n from app.mcp_tool where server_id = ${id}`);
      expect(n?.n).toBe(2);
    } finally {
      await other.close();
    }
  });
});

describe("Alice connects her own account", () => {
  it("signs in with PKCE and a state, in OpenDash's flow row only she can see", async () => {
    const started = await mcp.startConnect(deps, asPerson(alice), { serverId: personalId });
    const params = tracker.authorizationParams(started.authorizationUrl);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("redirect_uri")).toBe(deps.redirectUrl);
    expect(params.get("resource")).toBe(tracker.url);
    expect(started.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    // The state itself is never stored: the row holds its hash.
    const [flow] = await system<{ state_hash: string; scope: string; scope_id: string }>(sql`
      select state_hash, scope, scope_id from app.mcp_oauth_flow where started_by = ${alice}`);
    expect(flow?.scope).toBe("personal");
    expect(flow?.scope_id).toBe(alice);
    expect(flow?.state_hash).not.toBe(params.get("state"));
    const seenBy = async (userId: string) =>
      (
        await withTenantOn(t.app, as(userId), (tx) =>
          tx.execute<{ n: number }>(sql`select count(*)::int as n from app.mcp_oauth_flow where started_by = ${alice}`),
        )
      )[0]?.n;
    expect(await seenBy(alice)).toBe(1);
    expect(await seenBy(bob)).toBe(0);
    expect(await seenBy(maya)).toBe(0);

    const back = tracker.approve(started.authorizationUrl, "alice");
    const done = await mcp.finishConnect(deps, asPerson(alice), back);
    expect(done).toMatchObject({ state: "ready", again: false });

    // Used up: the row and its verifier are gone, and the same callback is refused.
    expect(await seenBy(alice)).toBe(0);
    expect(await problem(mcp.finishConnect(deps, asPerson(alice), back))).toBe("not_found");
  });

  it("keeps her tokens only encrypted, behind her personal connection", async () => {
    const connection = await connectionOf(personalId, "personal", alice);
    expect(connection?.status).toBe("ready");
    const [secret] = await system<{ kind: string; ciphertext: Buffer }>(sql`
      select kind, ciphertext from app.secret where id = ${connection?.secret_id}`);
    expect(secret?.kind).toBe("mcp");
    expect(Buffer.from(secret?.ciphertext ?? []).includes("at-alice")).toBe(false);
    const [row] = await system<Record<string, unknown>>(
      sql`select * from app.mcp_connection where id = ${connection?.id}`,
    );
    expect(JSON.stringify(row)).not.toMatch(/at-alice|rt-alice/);
    const revealed = await withTenantOn(t.app, as(alice), (tx) =>
      secrets.reveal(tx, orgId, connection?.secret_id ?? "", "mcp"),
    );
    expect(JSON.parse(revealed).tokens.access_token).toMatch(/^at-alice-/);
    // OpenDash registered once with the server, and keeps that registration for the next person.
    expect(tracker.registrations).toBe(1);
  });
});

describe("a sign-in that isn't right is refused", () => {
  it("a state OpenDash never sent", async () => {
    expect(await problem(mcp.finishConnect(deps, asPerson(bob), { state: "made-up", code: "x" }))).toBe("not_found");
  });

  it("an expired sign-in, which is then dropped", async () => {
    const started = await mcp.startConnect(deps, asPerson(bob), { serverId: personalId });
    await system(sql`update app.mcp_oauth_flow set expires_at = now() - interval '1 minute' where started_by = ${bob}`);
    const back = tracker.approve(started.authorizationUrl, "bob");
    expect(await problem(mcp.finishConnect(deps, asPerson(bob), back))).toBe("expired");
    const [left] = await system<{ n: number }>(sql`
      select count(*)::int as n from app.mcp_oauth_flow where started_by = ${bob}`);
    expect(left?.n).toBe(0);
  });

  it("someone else finishing Bob's sign-in: they can't even see it", async () => {
    const started = await mcp.startConnect(deps, asPerson(bob), { serverId: personalId });
    const back = tracker.approve(started.authorizationUrl, "bob");
    expect(await problem(mcp.finishConnect(deps, asPerson(alice), back))).toBe("not_found");
    // Bob's own callback still works afterwards.
    expect(await mcp.finishConnect(deps, asPerson(bob), back)).toMatchObject({ state: "ready" });
  });

  it("a sign-in lands only on the connection it started against", async () => {
    // Two tabs for someone not connected yet: the second connects first, so the first would land on a connection
    // made meanwhile.
    const erin = uuidv7();
    await member(erin, "Erin", "member");
    const first = await mcp.startConnect(deps, asPerson(erin), { serverId: personalId });
    const firstBack = tracker.approve(first.authorizationUrl, "erin");
    expect(await connectAs(erin, personalId, tracker, "erin")).toMatchObject({ state: "ready", again: false });
    expect(await problem(mcp.finishConnect(deps, asPerson(erin), firstBack))).toBe("refused");
    // Disconnected meanwhile: the sign-in for that connection doesn't bring it back.
    const again = await mcp.startConnect(deps, asPerson(maya), { serverId: personalId });
    const againBack = tracker.approve(again.authorizationUrl, "maya");
    await mcp.disconnect(deps, asPerson(maya), { serverId: personalId });
    expect(await problem(mcp.finishConnect(deps, asPerson(maya), againBack))).toBe("refused");
    expect(await connectAs(maya, personalId, tracker, "maya")).toMatchObject({ state: "ready", again: false });
  });

  it("a person who said no", async () => {
    const started = await mcp.startConnect(deps, asPerson(maya), { serverId: personalId });
    const state = tracker.authorizationParams(started.authorizationUrl).get("state") ?? "";
    expect(await problem(mcp.finishConnect(deps, asPerson(maya), { state, error: "access_denied" }))).toBe("refused");
    expect(await problem(mcp.finishConnect(deps, asPerson(maya), { state, code: "late" }))).toBe("not_found");
  });
});

describe("each person's own account, never anyone else's", () => {
  it("someone who hasn't connected is asked to, and nothing is sent", async () => {
    const carol = uuidv7();
    await member(carol, "Carol", "member");
    const before = tracker.calls.length;
    expect(await search(carol)).toMatchObject({ state: "connect", scope: "personal", canConnect: true });
    expect(tracker.calls.length).toBe(before);
  });

  it("Alice and Bob each get their own data, with their own token", async () => {
    const before = tracker.calls.length;
    const [a, b] = await Promise.all([search(alice), search(bob)]);
    expect(textOf(a)).toContain('"assignee":"alice"');
    expect(textOf(b)).toContain('"assignee":"bob"');
    expect(textOf(a)).not.toContain("bob");
    const made = tracker.calls.slice(before);
    expect(made.map((c) => c.account).sort()).toEqual(["alice", "bob"]);
  });

  it("row security keeps Alice's connection from Bob, for reads and writes", async () => {
    const aliceConnection = await connectionOf(personalId, "personal", alice);
    await withTenantOn(t.app, as(bob), async (tx) => {
      const seen = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from app.mcp_connection where scope_id = ${alice}`);
      expect(seen[0]?.n).toBe(0);
      const changed = await tx.execute(sql`
        update app.mcp_connection set status = 'reconnect' where id = ${aliceConnection?.id} returning id`);
      expect(changed).toHaveLength(0);
    });
    const attempt = withTenantOn(t.app, as(bob), (tx) =>
      tx.execute(sql`
        insert into app.mcp_connection (org_id, id, server_id, scope, scope_id, secret_id)
        values (${orgId}, ${uuidv7()}, ${personalId}, 'personal', ${alice}, ${aliceConnection?.secret_id})`),
    );
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("tiers, consent and dashboards", () => {
  const create = (userId: string, extra: Partial<mcp.McpCall> = {}) =>
    mcp.callTool(deps, as(userId), {
      serverId: personalId,
      tool: "create_issue",
      arguments: { title: "Renewal" },
      via: "analyst",
      ...extra,
    });

  it("an `ask` tool waits for the person to agree, then runs", async () => {
    expect(await create(alice)).toMatchObject({ state: "consent", tool: "create_issue", reason: "ask" });
    expect(textOf(await create(alice, { consented: true }))).toBe("Created ACME-9 for alice");
  });

  it("a yes given on a card holds only for the tool and the account the card was shown for", async () => {
    const asked = await create(alice);
    if (asked.state !== "consent") throw new Error(`expected a consent card, got ${asked.state}`);
    const before = tracker.calls.length;
    // The tool's listing changed since the card (its digest): asked again, nothing sent.
    const [listed] = await system<{ digest: string }>(
      sql`select digest from app.mcp_tool where server_id = ${personalId} and name = 'create_issue'`,
    );
    await system(
      sql`update app.mcp_tool set digest = 'other' where server_id = ${personalId} and name = 'create_issue'`,
    );
    const changedTool = await create(alice, { consented: { binding: asked.binding } });
    expect(changedTool).toMatchObject({ state: "consent", tool: "create_issue" });
    expect(tracker.calls.length).toBe(before);
    // Its new card's yes runs it.
    if (changedTool.state !== "consent") throw new Error("expected a consent card");
    expect(changedTool.binding).not.toBe(asked.binding);
    expect(textOf(await create(alice, { consented: { binding: changedTool.binding } }))).toBe(
      "Created ACME-9 for alice",
    );
    // Another sign-in since the card (the connection's revision moved on): asked again too.
    await system(sql`
      update app.mcp_connection set revision = revision + 1
      where server_id = ${personalId} and scope = 'personal' and scope_id = ${alice}`);
    const after = tracker.calls.length;
    expect(await create(alice, { consented: { binding: changedTool.binding } })).toMatchObject({ state: "consent" });
    expect(tracker.calls.length).toBe(after);
    await system(
      sql`update app.mcp_tool set digest = ${listed?.digest} where server_id = ${personalId} and name = 'create_issue'`,
    );
  });

  it("a blocked tool never runs; only an admin sets a tier", async () => {
    expect(await problem(mcp.updateTool(deps, asPerson(alice), personalId, "create_issue", { tier: "blocked" }))).toBe(
      "forbidden",
    );
    await mcp.updateTool(deps, asPerson(maya), personalId, "create_issue", { tier: "blocked" });
    expect(await create(alice, { consented: true })).toMatchObject({ state: "blocked", reason: "tool_blocked" });
  });

  it("a dashboard reaches only tools allowed there, on a server allowed there", async () => {
    expect(await search(alice, personalId, "dashboard")).toMatchObject({
      state: "blocked",
      reason: "not_in_dashboards",
    });
    await mcp.updateServer(deps, asPerson(maya), personalId, { dashboardsAllowed: true });
    expect(await search(alice, personalId, "dashboard")).toMatchObject({
      state: "blocked",
      reason: "not_in_dashboards",
    });
    await mcp.updateTool(deps, asPerson(maya), personalId, "search_issues", { dashboardsAllowed: true });
    expect(textOf(await search(alice, personalId, "dashboard"))).toContain('"assignee":"alice"');
  });

  it("arguments that don't fit the tool's schema are refused before anything is sent", async () => {
    const before = tracker.calls.length;
    const wrong = mcp.callTool(deps, as(alice), {
      serverId: personalId,
      tool: "search_issues",
      arguments: { query: 7 },
      via: "analyst",
    });
    expect(await problem(wrong)).toBe("invalid");
    expect(await search(alice, personalId).then((o) => o.state)).toBe("ready");
    expect(tracker.calls.length).toBe(before + 1);
  });

  it("a server's regular expressions never run, and an outsized schema makes its tool uncallable", () => {
    const schema = {
      type: "object",
      properties: {
        key: { type: "string", pattern: "^(a+)+$", format: "email" },
        tags: { type: "object", patternProperties: { "^(x+)+y$": { type: "string" } }, additionalProperties: false },
      },
    };
    expect(mcp.checkableSchema(schema)).toEqual({
      type: "object",
      properties: { key: { type: "string" }, tags: { type: "object" } },
    });
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) deep = { type: "object", properties: { next: deep } };
    expect(() => mcp.checkableSchema(deep)).toThrow(/too large/);
  });

  it("local references are inlined within the same limit; recursion and outside references aren't checked", () => {
    const shared = {
      type: "object",
      $defs: { issue: { type: "object", properties: { key: { type: "string", pattern: "(a+)+" } } } },
      properties: { first: { $ref: "#/$defs/issue" }, second: { $ref: "#/$defs/issue", description: "Another" } },
    };
    expect(mcp.checkableSchema(shared)).toEqual({
      type: "object",
      properties: {
        first: { allOf: [{ type: "object", properties: { key: { type: "string" } } }] },
        second: { allOf: [{ type: "object", properties: { key: { type: "string" } } }], description: "Another" },
      },
    });
    // A fan-out: each definition refers to the next twice, 2^20 parts once expanded.
    const defs: Record<string, unknown> = { d20: { type: "string" } };
    for (let i = 0; i < 20; i++)
      defs[`d${i}`] = { anyOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
    expect(() => mcp.checkableSchema({ $defs: defs, $ref: "#/$defs/d0" })).toThrow(/too large/);
    const recursive = {
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
      $ref: "#/$defs/node",
    };
    expect(() => mcp.checkableSchema(recursive)).toThrow(/refers to itself/);
    expect(() => mcp.checkableSchema({ $ref: "https://example.com/schema.json" })).toThrow(/not found/);
    expect(() => mcp.checkableSchema({ $dynamicRef: "#meta" })).toThrow(/not supported/);
  });

  it("an unknown tool is blocked", async () => {
    const outcome = await mcp.callTool(deps, as(alice), { serverId: personalId, tool: "drop_all", via: "analyst" });
    expect(outcome).toMatchObject({ state: "blocked", reason: "unknown_tool" });
  });
});

describe("a tool whose schema changes", () => {
  it("is `changed`: out of dashboards and asking first, until an admin reviews it", async () => {
    tracker.set({ tools: "v2" });
    const listed = await mcp.listServerTools(deps, asPerson(maya), personalId);
    expect(listed).toMatchObject({ state: "ready", changed: ["search_issues"], added: [], removed: [] });
    expect(await search(alice, personalId, "dashboard")).toMatchObject({
      state: "blocked",
      reason: "not_in_dashboards",
    });
    expect(await search(alice)).toMatchObject({ state: "consent", reason: "changed" });
    await mcp.updateTool(deps, asPerson(maya), personalId, "search_issues", { reviewed: true });
    expect(textOf(await search(alice, personalId, "dashboard"))).toContain('"assignee":"alice"');
    // Listing again with nothing new changes nothing.
    expect(await mcp.listServerTools(deps, asPerson(maya), personalId)).toMatchObject({ changed: [], added: [] });
    tracker.set({ tools: "v1" });
  });
});

describe("shared servers, and no fallback", () => {
  it("a shared server's account is the admin's to connect; everyone's calls use it", async () => {
    sharedId = (await mcp.approveServer(deps, asPerson(maya), { name: "Wiki", url: shared.url, access: "shared" })).id;
    expect(await problem(mcp.startConnect(deps, asPerson(alice), { serverId: sharedId }))).toBe("forbidden");
    expect(await mcp.listServerTools(deps, asPerson(maya), sharedId)).toMatchObject({
      state: "connect",
      scope: "org",
      canConnect: true,
    });
    expect(await connectAs(maya, sharedId, shared, "acme-bot")).toMatchObject({ state: "ready" });
    await mcp.listServerTools(deps, asPerson(maya), sharedId);
    expect(textOf(await search(alice, sharedId))).toContain('"assignee":"acme-bot"');
    expect(textOf(await search(bob, sharedId))).toContain('"assignee":"acme-bot"');
  });

  it("while it isn't connected, members hear an admin has to connect it, and admins that they can", async () => {
    expect(await mcp.disconnect(deps, asPerson(maya), { serverId: sharedId })).toBe(true);
    expect(await search(alice, sharedId)).toMatchObject({ state: "connect", scope: "org", canConnect: false });
    expect(await search(maya, sharedId)).toMatchObject({ state: "connect", scope: "org", canConnect: true });
    expect(await connectAs(maya, sharedId, shared, "acme-bot")).toMatchObject({ state: "ready", again: false });
  });

  it("only the admin who started a workspace sign-in may finish it", async () => {
    const started = await mcp.startConnect(deps, asPerson(maya), { serverId: sharedId });
    const back = shared.approve(started.authorizationUrl, "acme-bot");
    // Bob can see the workspace's sign-in row, but it isn't his.
    expect(await problem(mcp.finishConnect(deps, asPerson(bob), back))).toBe("forbidden");
  });

  it("a personal server never falls back to a workspace account", async () => {
    // Tracker was shared for a while, and the workspace's account connected then; it's personal again now.
    await mcp.updateServer(deps, asPerson(maya), personalId, { access: "shared" });
    expect(await connectAs(maya, personalId, tracker, "acme-bot")).toMatchObject({ state: "ready" });
    await mcp.updateServer(deps, asPerson(maya), personalId, { access: "personal" });
    const dana = uuidv7();
    await member(dana, "Dana", "member");
    expect(await search(dana)).toMatchObject({ state: "connect", scope: "personal" });
    expect(textOf(await search(alice))).toContain('"assignee":"alice"');
  });

  it("a run for no one uses shared servers only", async () => {
    expect(await search(alice, personalId, "background")).toMatchObject({ state: "blocked", reason: "needs_person" });
    expect(textOf(await search(null, sharedId, "background"))).toContain('"assignee":"acme-bot"');
    // Even when the person who scheduled it is named, a background call doesn't use their account.
    expect(await search(alice, personalId, "background")).toMatchObject({ state: "blocked" });
  });
});

describe("refreshing, and a refused refresh", () => {
  it("an expired access token is refreshed and written back, rotating its refresh token", async () => {
    const before = await connectionOf(personalId, "personal", alice);
    tracker.expireAccessTokens();
    expect(textOf(await search(alice))).toContain('"assignee":"alice"');
    const after = await connectionOf(personalId, "personal", alice);
    expect(tracker.grants).toContain("refresh_token");
    expect(after?.secret_id).not.toBe(before?.secret_id);
    expect(after?.refreshed_at).not.toBeNull();
    expect(after?.revision).toBe(before?.revision);
    const [old] = await system<{ n: number }>(
      sql`select count(*)::int as n from app.secret where id = ${before?.secret_id}`,
    );
    expect(old?.n).toBe(0);
  });

  it("calls that all find the token refused at once refresh it once, and all succeed", async () => {
    tracker.expireAccessTokens();
    const refreshes = tracker.grants.filter((g) => g === "refresh_token").length;
    const outcomes = await Promise.all([search(alice), search(alice), search(alice), search(alice)]);
    expect(outcomes.map((o) => o.state)).toEqual(["ready", "ready", "ready", "ready"]);
    expect(tracker.grants.filter((g) => g === "refresh_token").length).toBe(refreshes + 1);
    expect((await connectionOf(personalId, "personal", alice))?.status).toBe("ready");
  });

  it("a change whose token the server refuses isn't sent again after the refresh, whoever calls it", async () => {
    await mcp.updateTool(deps, asPerson(maya), personalId, "create_issue", { tier: "always" });
    const create = () =>
      mcp.callTool(deps, as(alice), {
        serverId: personalId,
        tool: "create_issue",
        arguments: { title: "Renewal" },
        via: "analyst",
      });
    tracker.expireAccessTokens();
    const refreshes = tracker.grants.filter((g) => g === "refresh_token").length;
    const made = tracker.calls.filter((c) => c.tool === "create_issue").length;
    // No `once` from the caller: the executor sends a change at most once by itself.
    expect(await create()).toMatchObject({ state: "blocked", reason: "try_again" });
    expect(tracker.grants.filter((g) => g === "refresh_token").length).toBe(refreshes + 1);
    expect(tracker.calls.filter((c) => c.tool === "create_issue").length).toBe(made);
    // Renewed: asked again, it's made, once.
    expect(textOf(await create())).toBe("Created ACME-9 for alice");
    expect(tracker.calls.filter((c) => c.tool === "create_issue").length).toBe(made + 1);
    await mcp.updateTool(deps, asPerson(maya), personalId, "create_issue", { tier: "blocked" });
  });

  it("a token about to expire is refreshed before the call, not after a refusal", async () => {
    tracker.set({ expiresIn: 30 });
    expect(await connectAs(alice, personalId, tracker, "alice")).toMatchObject({ state: "ready", again: true });
    tracker.set({ expiresIn: 3600 });
    const refused = tracker.unauthorized;
    const refreshes = tracker.grants.filter((g) => g === "refresh_token").length;
    expect(textOf(await search(alice))).toContain('"assignee":"alice"');
    expect(tracker.grants.filter((g) => g === "refresh_token").length).toBe(refreshes + 1);
    expect(tracker.unauthorized).toBe(refused);
  });

  it("a refused refresh asks Alice to connect again, without calling until she does", async () => {
    tracker.expireAccessTokens();
    tracker.revokeRefreshTokens();
    expect(await search(alice)).toMatchObject({ state: "reconnect", canConnect: true });
    expect((await connectionOf(personalId, "personal", alice))?.status).toBe("reconnect");
    const before = tracker.calls.length;
    expect(await search(alice)).toMatchObject({ state: "reconnect" });
    expect(tracker.calls.length).toBe(before);
    // Every token at the server was revoked, Bob's too: he's asked to connect his own account again.
    expect(await search(bob)).toMatchObject({ state: "reconnect", canConnect: true });
  });

  it("connecting again puts the same connection back, one revision on", async () => {
    const before = await connectionOf(personalId, "personal", alice);
    expect(await connectAs(alice, personalId, tracker, "alice")).toMatchObject({ state: "ready", again: true });
    const after = await connectionOf(personalId, "personal", alice);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe("ready");
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    expect(textOf(await search(alice))).toContain('"assignee":"alice"');
  });

  it("signing in again as someone else is `wrong_account` when the server says who", async () => {
    tracker.set({ idTokens: true });
    await connectAs(bob, personalId, tracker, "bob");
    tracker.expireAccessTokens();
    tracker.revokeRefreshTokens();
    expect(await search(bob)).toMatchObject({ state: "reconnect" });
    expect(await connectAs(bob, personalId, tracker, "mallory")).toMatchObject({
      state: "wrong_account",
      expected: "bob@acme.test",
    });
    expect(await search(bob)).toMatchObject({ state: "wrong_account", canConnect: true });
    expect(await connectAs(bob, personalId, tracker, "bob")).toMatchObject({ state: "ready" });
    expect(textOf(await search(bob))).toContain('"assignee":"bob"');
    tracker.set({ idTokens: false });
  });
});

describe("disconnecting", () => {
  it("removes the connection and its secret; the next call asks to connect", async () => {
    const connection = await connectionOf(personalId, "personal", alice);
    expect(await mcp.disconnect(deps, asPerson(alice), { serverId: personalId })).toBe(true);
    expect(await connectionOf(personalId, "personal", alice)).toBeUndefined();
    const [left] = await system<{ n: number }>(
      sql`select count(*)::int as n from app.secret where id = ${connection?.secret_id}`,
    );
    expect(left?.n).toBe(0);
    expect(await search(alice)).toMatchObject({ state: "connect" });
    expect(await mcp.disconnect(deps, asPerson(alice), { serverId: personalId })).toBe(false);
    // The workspace's account on a shared server is an admin's to disconnect.
    expect(await problem(mcp.disconnect(deps, asPerson(bob), { serverId: sharedId }))).toBe("forbidden");
  });
});

describe("rate limits and servers turned off", () => {
  it("a 429 is `rate_limited`, with no data", async () => {
    shared.set({ rateLimit: true });
    expect(await search(alice, sharedId)).toMatchObject({ state: "rate_limited" });
    shared.set({ rateLimit: false });
  });

  it("a disabled server is blocked, and comes back when turned on", async () => {
    await mcp.updateServer(deps, asPerson(maya), sharedId, { status: "disabled" });
    expect(await search(alice, sharedId)).toMatchObject({ state: "blocked", reason: "disabled" });
    await mcp.updateServer(deps, asPerson(maya), sharedId, { status: "active" });
    expect(await search(alice, sharedId).then((o) => o.state)).toBe("ready");
  });

  it("removing a server removes everyone's connections and secrets with it", async () => {
    const before = await system<{ n: number }>(sql`
      select count(*)::int as n from app.mcp_connection where server_id = ${personalId}`);
    expect(before[0]?.n).toBeGreaterThan(1);
    const secretIds = (
      await system<{ secret_id: string }>(sql`select secret_id from app.mcp_connection where server_id = ${personalId}`)
    ).map((r) => r.secret_id);
    await mcp.removeServer(deps, asPerson(maya), personalId);
    const [left] = await system<{ n: number }>(sql`
      select count(*)::int as n from app.secret where id = any(${`{${secretIds.join(",")}}`}::uuid[])`);
    expect(left?.n).toBe(0);
    expect(await search(alice)).toMatchObject({ state: "blocked", reason: "not_approved" });
  });
});

describe("the guard", () => {
  const cloud = () => mcp.guardedFetch({ edition: "cloud" });

  it("cloud refuses loopback and plain http before sending anything", async () => {
    await expect(cloud()(shared.url)).rejects.toMatchObject({ name: "McpNetworkError", refused: true });
    await expect(cloud()("http://example.com/mcp")).rejects.toMatchObject({ refused: true });
    const inCloud = { ...deps, edition: "cloud" as const };
    expect(await problem(mcp.approveServer(inCloud, asPerson(maya), { name: "Local", url: shared.url }))).toBe(
      "refused",
    );
  });

  it("every edition refuses link-local (cloud metadata), also when metadata or a redirect points there", async () => {
    const community = mcp.guardedFetch({ edition: "community" });
    await expect(community("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({ refused: true });
    const evil = await fakeMcp();
    try {
      const evilId = (await mcp.approveServer(deps, asPerson(maya), { name: "Evil", url: evil.url })).id;
      evil.set({ authServer: "http://169.254.169.254/" });
      expect(await problem(mcp.startConnect(deps, asPerson(alice), { serverId: evilId }))).toBe("refused");
      // Metadata that redirects there: the redirect is refused, so the metadata can't be read, and the client falls
      // back to the server's own origin as its authorization server, as MCP allows. Nothing reaches the address.
      evil.set({ authServer: null, metadataRedirect: "http://169.254.169.254/latest/meta-data" });
      await expect(community(`${evil.base}/.well-known/oauth-protected-resource`)).rejects.toMatchObject({
        refused: true,
      });
      const fallback = await mcp.startConnect(deps, asPerson(alice), { serverId: evilId });
      expect(new URL(fallback.authorizationUrl).origin).toBe(evil.base);
    } finally {
      await evil.close();
    }
  });

  it("follows at most three redirects, and stops reading past the size limit", async () => {
    const loop = await fakeMcp();
    try {
      loop.set({ metadataRedirect: `${loop.base}/.well-known/oauth-protected-resource` });
      const community = mcp.guardedFetch({ edition: "community" });
      await expect(community(`${loop.base}/.well-known/oauth-protected-resource`)).rejects.toThrow(/too many times/);
      // A redirect the caller wants back as it is (the client's transport follows within its origin itself).
      const manual = await community(`${loop.base}/.well-known/oauth-protected-resource`, { redirect: "manual" });
      expect(manual.status).toBe(302);
      loop.set({ metadataRedirect: null, metadataBytes: 50_000 });
      const small = mcp.guardedFetch({ edition: "community", responseBytes: 10_000 });
      const response = await small(`${loop.base}/.well-known/oauth-protected-resource`);
      await expect(response.text()).rejects.toThrow(/size limit/);
      const big = await community(`${loop.base}/.well-known/oauth-protected-resource`);
      expect((await big.text()).length).toBeGreaterThan(50_000);
    } finally {
      await loop.close();
    }
  });
});

describe("changes in a service", () => {
  it("never makes one that may delete or overwrite: said so, or not said otherwise", async () => {
    const { changesDestructively } = await import("../src/mcp/views");
    expect(changesDestructively({ readOnlyHint: true })).toBe(false);
    expect(changesDestructively({ readOnlyHint: false, destructiveHint: false })).toBe(false);
    expect(changesDestructively({ readOnlyHint: false, destructiveHint: true })).toBe(true);
    // MCP's default for a tool that isn't read-only is destructive.
    expect(changesDestructively({})).toBe(true);
    expect(changesDestructively(null)).toBe(true);
  });
});
