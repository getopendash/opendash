// Every way an MCP server signs people in: detection before
// approving, API keys (each person's own or one for everyone, in Authorization or a header the server names), servers
// that need nothing, the older HTTP with server-sent events, OAuth clients an admin enters, and the counts admins see.
import { randomBytes } from "node:crypto";
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const fakes: FakeMcp[] = [];
let deps: mcp.McpDeps;
const previousFlag = process.env.OPENDASH_MCP;

const system = <T>(q: ReturnType<typeof sql>) =>
  withSystemOn(t.system, (tx) => tx.execute<T & Record<string, unknown>>(q));

async function member(id: string, name: string, role: string) {
  await t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${id}, ${name}, ${`${name.toLowerCase()}@acme.test`}, true)`;
  await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${id}, ${role}, now())`;
}

async function fake(behaviour: Parameters<FakeMcp["set"]>[0] = {}): Promise<FakeMcp> {
  const f = await fakeMcp();
  f.set(behaviour);
  fakes.push(f);
  return f;
}

const search = (userId: string | null, serverId: string, via: mcp.McpCall["via"] = "analyst") =>
  mcp.callTool(deps, as(userId), { serverId, tool: "search_issues", arguments: { query: "late" }, via });

const textOf = (outcome: mcp.McpOutcome) =>
  outcome.state === "ready" ? (outcome.result.content as { text: string }[])[0]?.text : null;

async function problem(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof mcp.McpProblem) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected an McpProblem");
}

const connections = (serverId: string) =>
  system<{ scope: string; scope_id: string | null; account: string | null; status: string; revision: number }>(sql`
    select scope, scope_id, account, status, revision from app.mcp_connection
    where org_id = ${orgId} and server_id = ${serverId} order by created_at`);

const mcpSecrets = async () =>
  (
    await system<{ n: number }>(sql`
      select count(*)::int as n from app.secret where org_id = ${orgId} and kind = 'mcp'`)
  )[0]?.n ?? 0;

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
  deps = {
    secrets,
    edition: "community",
    withTenant: (ctx, fn) => withTenantOn(t.app, ctx, fn),
    redirectUrl: "https://opendash.test/api/mcp/callback",
  };
});

afterAll(async () => {
  process.env.OPENDASH_MCP = previousFlag;
  await Promise.all(fakes.map((f) => f.close()));
  await t?.drop();
});

describe("detecting how a server signs people in", () => {
  it("OAuth with registration: OpenDash can register itself, nothing to paste", async () => {
    const oauth = await fake();
    const found = await mcp.detectServer(deps, asPerson(maya), { url: oauth.url });
    expect(found).toMatchObject({
      url: oauth.url,
      transport: "streamable",
      server: null,
      auth: { kind: "oauth", issuer: oauth.base, registration: "dynamic", scopes: ["issues:read"] },
    });
  });

  it("OAuth without registration: a client an admin makes, or OpenDash's metadata document where it's taken", async () => {
    const strict = await fake({ registration: false });
    expect((await mcp.detectServer(deps, asPerson(maya), { url: strict.url })).auth).toMatchObject({
      kind: "oauth",
      registration: "needs_client",
    });
    strict.set({ cimd: true });
    expect((await mcp.detectServer(deps, asPerson(maya), { url: strict.url })).auth).toMatchObject({
      registration: "needs_client",
    });
    const withDocument = { ...deps, clientMetadataUrl: "https://opendash.test/api/mcp/client" };
    expect((await mcp.detectServer(withDocument, asPerson(maya), { url: strict.url })).auth).toMatchObject({
      registration: "metadata_document",
    });
  });

  it("refused with no OAuth anywhere: an API key, whether it answers 401 or 403", async () => {
    const keyed = await fake({ keys: { zd_live_9f2c3f9a: "ops" } });
    expect((await mcp.detectServer(deps, asPerson(maya), { url: keyed.url })).auth).toEqual({
      kind: "apikey",
      status: 401,
      scheme: null,
    });
    keyed.set({ keyRefusal: 403 });
    expect((await mcp.detectServer(deps, asPerson(maya), { url: keyed.url })).auth).toMatchObject({
      kind: "apikey",
      status: 403,
    });
  });

  it("answers without a sign-in: none, with its name and its tools listed", async () => {
    const open = await fake({ auth: false });
    expect(await mcp.detectServer(deps, asPerson(maya), { url: open.url })).toMatchObject({
      transport: "streamable",
      server: { name: "acme-tracker", version: "1.0.0" },
      auth: { kind: "none", tools: 2 },
    });
  });

  it("only the older transport (HTTP with server-sent events): found, and read the same way", async () => {
    const legacy = await fake({ auth: false, sse: true });
    expect(await mcp.detectServer(deps, asPerson(maya), { url: legacy.url })).toMatchObject({
      transport: "sse",
      server: { name: "acme-tracker" },
      auth: { kind: "none", tools: 2 },
    });
    const legacyKeyed = await fake({ sse: true, keys: { sk_test_00001111: "ops" } });
    // Behind a key every request is refused alike, so the transport is found on the first call with one.
    expect(await mcp.detectServer(deps, asPerson(maya), { url: legacyKeyed.url })).toMatchObject({
      transport: "streamable",
      auth: { kind: "apikey", status: 401 },
    });
  });

  it("a public event stream whose message endpoint wants a key is a key server, not an open one", async () => {
    const half = await fake({ sse: true, openStream: true, keys: { sk_test_half_9999: "ops" } });
    expect(await mcp.detectServer(deps, asPerson(maya), { url: half.url })).toMatchObject({
      transport: "sse",
      server: null,
      auth: { kind: "apikey", status: 401 },
    });
  });

  it("only admins detect; the guard still applies; something that isn't MCP says so", async () => {
    const open = await fake({ auth: false });
    expect((await problem(mcp.detectServer(deps, asPerson(alice), { url: open.url }))).code).toBe("forbidden");
    const cloud = { ...deps, edition: "cloud" as const };
    expect((await problem(mcp.detectServer(cloud, asPerson(maya), { url: open.url }))).code).toBe("refused");
    const notMcp = await problem(mcp.detectServer(deps, asPerson(maya), { url: `${open.base}/nothing-here` }));
    expect(notMcp.code).toBe("invalid");
    expect(notMcp.message).toContain("not as an MCP server");
  });
});

describe("API keys", () => {
  let stripe: FakeMcp;
  let stripeId = "";

  it("an admin approves a key server with the header it names and where people find their key", async () => {
    stripe = await fake({
      keys: { rk_live_alice_7c21: "alice", rk_live_maya_4444: "maya" },
      keyHeader: "X-API-Key",
    });
    stripeId = (
      await mcp.approveServer(deps, asPerson(maya), {
        name: "Stripe",
        url: stripe.url,
        auth: "apikey",
        keyHeader: "X-API-Key",
        keyHint: "  Dashboard → Developers →   API keys ",
      })
    ).id;
    const [row] = await system<{ auth: string; access: string; key_header: string; key_hint: string }>(sql`
      select auth, access, key_header, key_hint from app.mcp_server where id = ${stripeId}`);
    expect(row).toEqual({
      auth: "apikey",
      access: "personal",
      key_header: "X-API-Key",
      key_hint: "Dashboard → Developers → API keys",
    });
  });

  it("a header a key can't go in is refused; Authorization may be named, and no header means Authorization", async () => {
    expect(mcp.cleanKeyHeader("")).toBeNull();
    expect(mcp.cleanKeyHeader("Authorization")).toBe("Authorization");
    expect(mcp.cleanKeyHeader(" x-api-key ")).toBe("x-api-key");
    expect(() => mcp.cleanKeyHeader("Host")).toThrow(mcp.McpProblem);
    expect(() => mcp.cleanKeyHeader("X Api Key")).toThrow(mcp.McpProblem);
  });

  it("a value format says where the key goes, and a key keeps its spaces", async () => {
    expect(mcp.cleanKeyFormat(null)).toBeNull();
    expect(mcp.cleanKeyFormat("  Token {key} ")).toBe("Token {key}");
    expect(mcp.cleanKeyFormat("{key}")).toBe("{key}");
    expect(() => mcp.cleanKeyFormat("Bearer")).toThrow(mcp.McpProblem);
    expect(() => mcp.cleanKeyFormat("{key} {key}")).toThrow(mcp.McpProblem);
    expect(() => mcp.cleanKeyFormat("Bearer {key}\r\nX-Evil: 1")).toThrow(mcp.McpProblem);
    // Before formats, a pasted Bearer was dropped; a format of its own drops its own scheme, and any other stays.
    expect(mcp.cleanKey("  Bearer rk_live_alice_7c21 ")).toBe("rk_live_alice_7c21");
    expect(mcp.cleanKey("Token abc123", "Token {key}")).toBe("abc123");
    expect(mcp.cleanKey("Token abc123", "{key}")).toBe("Token abc123");
    expect(mcp.cleanKey("Basic dXNlcjpwYXNz", "Basic {key}")).toBe("dXNlcjpwYXNz");
    expect(mcp.cleanKey("abc", "{key}")).toBe("abc");
    expect(mcp.cleanKey("two words", "{key}")).toBe("two words");
    expect(() => mcp.cleanKey("   ")).toThrow(mcp.McpProblem);
    expect(() => mcp.cleanKey("bad\nkey", "{key}")).toThrow(mcp.McpProblem);
  });

  it("a key's label never gives much of it away", async () => {
    expect(mcp.keyLabel("rk_live_alice_7c21")).toBe("••••7c21");
    expect(mcp.keyLabel("abcdefgh")).toBe("••••gh");
    expect(mcp.keyLabel("abcd")).toBe("••••d");
    expect(mcp.keyLabel("abc")).toBe("••••");
    expect(mcp.keyLabel("a")).toBe("••••");
  });

  it("the header a call sends follows the server's header and format", async () => {
    const key = { kind: "apikey" as const, key: "k_1 $& end" };
    expect(mcp.keyHeaders({ key_header: null, key_format: null }, key)).toEqual({ authorization: "Bearer k_1 $& end" });
    expect(mcp.keyHeaders({ key_header: "X-API-Key", key_format: null }, key)).toEqual({ "X-API-Key": "k_1 $& end" });
    expect(mcp.keyHeaders({ key_header: "Authorization", key_format: "Token {key}" }, key)).toEqual({
      Authorization: "Token k_1 $& end",
    });
    expect(mcp.keyHeaders({ key_header: "X-Token", key_format: "ApiKey {key}" }, key)).toEqual({
      "X-Token": "ApiKey k_1 $& end",
    });
  });

  it("a server that wants its own scheme: the header and format are kept, and a key with a space works end to end", async () => {
    const own = await fake({ keys: { "key with space": "maya" }, keyHeader: "Authorization", keyPrefix: "Token " });
    const id = (
      await mcp.approveServer(deps, asPerson(maya), {
        name: "Own scheme",
        url: own.url,
        auth: "apikey",
        keyHeader: "Authorization",
        keyFormat: "Token {key}",
      })
    ).id;
    const [row] = await system<{ key_header: string; key_format: string }>(sql`
      select key_header, key_format from app.mcp_server where id = ${id}`);
    expect(row).toEqual({ key_header: "Authorization", key_format: "Token {key}" });
    // Pasted with its scheme, spaces inside kept: the server sees `Token key with space`.
    const put = await mcp.putKey(deps, asPerson(maya), { serverId: id, key: "Token key with space" });
    expect(put).toMatchObject({ state: "ready", tools: 2 });
    expect(own.unauthorized).toBe(0);
    await own.close();
  });

  it("before Alice adds hers she's asked to; a wrong key is refused and nothing is kept", async () => {
    expect(await search(alice, stripeId)).toMatchObject({ state: "blocked", reason: "unknown_tool" });
    const before = await mcpSecrets();
    const wrong = await problem(mcp.putKey(deps, asPerson(alice), { serverId: stripeId, key: "rk_live_wrong_1234" }));
    expect(wrong).toMatchObject({ code: "refused" });
    expect(wrong.message).toMatch(/^Stripe refused it\. Check the header name/);
    expect(wrong.message).toMatch(/Nothing was saved\.$/);
    expect(await connections(stripeId)).toEqual([]);
    expect(await mcpSecrets()).toBe(before);
  });

  it("a right key is tested (tools listed, nothing called) and kept, shown by its last four", async () => {
    const calls = stripe.calls.length;
    const put = await mcp.putKey(deps, asPerson(alice), { serverId: stripeId, key: "rk_live_alice_7c21" });
    expect(put).toMatchObject({ state: "ready", label: "••••7c21", tools: 2, again: false });
    expect(stripe.calls.length).toBe(calls);
    expect(await connections(stripeId)).toEqual([
      { scope: "personal", scope_id: alice, account: "••••7c21", status: "ready", revision: 1 },
    ]);
    const [stored] = await system<{ ciphertext: Buffer }>(sql`
      select s.ciphertext from app.secret s join app.mcp_connection c on c.org_id = s.org_id and c.secret_id = s.id
      where c.server_id = ${stripeId}`);
    expect(stored?.ciphertext.toString("utf8")).not.toContain("rk_live_alice_7c21");
  });

  it("calls use each person's own key, in the server's header; Bob without one is asked to add his", async () => {
    // An admin lists the tools through their own key first.
    await mcp.putKey(deps, asPerson(maya), { serverId: stripeId, key: "rk_live_maya_4444" });
    expect(await mcp.listServerTools(deps, asPerson(maya), stripeId)).toMatchObject({ state: "ready" });
    expect(await search(bob, stripeId)).toMatchObject({ state: "connect", scope: "personal", canConnect: true });
    expect(JSON.parse(textOf(await search(alice, stripeId)) ?? "[]")[0]).toMatchObject({ assignee: "alice" });
    expect(stripe.calls.at(-1)).toMatchObject({ tool: "search_issues", account: "alice" });
    expect(await search(null, stripeId, "background")).toMatchObject({ state: "blocked", reason: "needs_person" });
  });

  it("a key the server stops taking is `reconnect` at once; a new key puts it back, one revision on", async () => {
    stripe.set({ keys: { rk_live_maya_4444: "maya", rk_live_alice_8d32: "alice" } });
    const refused = await search(alice, stripeId);
    expect(refused).toMatchObject({ state: "reconnect", scope: "personal", canConnect: true });
    expect(refused.state === "reconnect" && refused.message).toBe("The server refused this key. Add a new one.");
    expect(await search(alice, stripeId)).toMatchObject({ state: "reconnect" });
    const again = await mcp.putKey(deps, asPerson(alice), { serverId: stripeId, key: "rk_live_alice_8d32" });
    expect(again).toMatchObject({ state: "ready", label: "••••8d32", again: true });
    const mine = (await connections(stripeId)).find((c) => c.scope_id === alice);
    expect(mine).toMatchObject({ status: "ready", revision: 2 });
    expect(await search(alice, stripeId)).toMatchObject({ state: "ready" });
  });

  it("a key on a server that answers 403 is refused the same way", async () => {
    stripe.set({ keyRefusal: 403 });
    expect(
      (await problem(mcp.putKey(deps, asPerson(bob), { serverId: stripeId, key: "rk_live_nope_0000" }))).code,
    ).toBe("refused");
    stripe.set({ keyRefusal: 401 });
  });

  it("a key never follows a redirect to another origin, whatever header it goes in", async () => {
    const thief = await fake({ auth: false });
    const before = stripe.headersSeen.length;
    stripe.set({ mcpRedirect: thief.url });
    try {
      await search(alice, stripeId).catch(() => null);
    } finally {
      stripe.set({ mcpRedirect: null });
    }
    expect(stripe.headersSeen.length).toBeGreaterThan(before);
    expect(stripe.headersSeen.slice(before).some((h) => h["x-api-key"] === "rk_live_alice_8d32")).toBe(true);
    for (const h of thief.headersSeen) {
      expect(h["x-api-key"]).toBeUndefined();
      expect(h.authorization).toBeUndefined();
    }
    // The guard itself, following the redirect: only plain headers reach the other origin.
    const seen = thief.headersSeen.length;
    stripe.set({ mcpRedirect: thief.url });
    try {
      const fetch = mcp.guardedFetch({ edition: "community" });
      const res = await fetch(stripe.url, {
        method: "POST",
        headers: {
          "x-api-key": "rk_live_alice_8d32",
          authorization: "Bearer at-secret",
          "x-custom": "1",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      await res.body?.cancel();
    } finally {
      stripe.set({ mcpRedirect: null });
    }
    const forwarded = thief.headersSeen.slice(seen);
    expect(forwarded.length).toBe(1);
    expect(forwarded[0]?.["x-api-key"]).toBeUndefined();
    expect(forwarded[0]?.authorization).toBeUndefined();
    expect(forwarded[0]?.["x-custom"]).toBeUndefined();
    expect(forwarded[0]?.accept).toBe("application/json, text/event-stream");
  });

  it("two keys put at once: one wins, the other is told, and no secret is left behind", async () => {
    stripe.set({
      keys: { rk_live_maya_4444: "maya", rk_live_alice_8d32: "alice", rk_live_alice_9e43: "alice" },
    });
    const results = await Promise.allSettled([
      mcp.putKey(deps, asPerson(alice), { serverId: stripeId, key: "rk_live_alice_8d32" }),
      mcp.putKey(deps, asPerson(alice), { serverId: stripeId, key: "rk_live_alice_9e43" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as mcp.McpProblem).code).toBe("refused");
    }
    const [orphans] = await system<{ n: number }>(sql`
      select count(*)::int as n from app.secret s
      where s.org_id = ${orgId} and s.kind = 'mcp'
        and not exists (select 1 from app.mcp_connection c where c.org_id = s.org_id and c.secret_id = s.id)
        and not exists (select 1 from app.mcp_server v where v.org_id = s.org_id and v.client_secret_id = s.id)
        and not exists (select 1 from app.mcp_oauth_flow f where f.org_id = s.org_id and f.secret_id = s.id)`);
    expect(orphans?.n).toBe(0);
    expect((await connections(stripeId)).filter((c) => c.scope_id === alice)).toHaveLength(1);
    expect(await search(alice, stripeId)).toMatchObject({ state: "ready" });
    // Either key may have won; the tests after this one read Alice's as the 8d32 key, so it's put back, alone.
    expect(await mcp.putKey(deps, asPerson(alice), { serverId: stripeId, key: "rk_live_alice_8d32" })).toMatchObject({
      state: "ready",
      label: "••••8d32",
    });
  });

  it("a key server isn't signed into with OAuth", async () => {
    expect((await problem(mcp.startConnect(deps, asPerson(alice), { serverId: stripeId }))).code).toBe("invalid");
  });

  it("one key for everyone: only an admin sets it; every call (and a run for no one) uses it", async () => {
    const zendesk = await fake({ keys: { zd_live_9f2c3f9a: "ops" } });
    const { id } = await mcp.approveServer(deps, asPerson(maya), {
      name: "Zendesk",
      url: zendesk.url,
      auth: "apikey",
      access: "shared",
    });
    expect(await search(alice, id)).toMatchObject({ state: "blocked", reason: "unknown_tool" });
    expect((await problem(mcp.putKey(deps, asPerson(alice), { serverId: id, key: "zd_live_9f2c3f9a" }))).code).toBe(
      "forbidden",
    );
    expect(await mcp.putKey(deps, asPerson(maya), { serverId: id, key: "zd_live_9f2c3f9a" })).toMatchObject({
      state: "ready",
      label: "••••3f9a",
    });
    await mcp.listServerTools(deps, asPerson(maya), id);
    expect(await connections(id)).toEqual([
      { scope: "org", scope_id: null, account: "••••3f9a", status: "ready", revision: 1 },
    ]);
    for (const who of [alice, bob]) {
      expect(JSON.parse(textOf(await search(who, id)) ?? "[]")[0]).toMatchObject({ assignee: "ops" });
    }
    expect(await search(null, id, "background")).toMatchObject({ state: "ready" });
    expect(zendesk.calls.at(-1)).toMatchObject({ account: "ops" });
    zendesk.set({ keys: {} });
    expect(await search(alice, id)).toMatchObject({ state: "reconnect", scope: "org", canConnect: false });
  });
});

describe("a server that needs no sign-in", () => {
  it("is always one connection for everyone, whatever the admin picked", async () => {
    const open = await fake({ auth: false });
    const { id } = await mcp.approveServer(deps, asPerson(maya), {
      name: "Incidents",
      url: open.url,
      auth: "none",
      access: "personal",
    });
    const [row] = await system<{ access: string }>(sql`select access from app.mcp_server where id = ${id}`);
    expect(row?.access).toBe("shared");
    expect((await problem(mcp.updateServer(deps, asPerson(maya), id, { access: "personal" }))).code).toBe("invalid");
    await mcp.listServerTools(deps, asPerson(maya), id);
    expect(await search(alice, id)).toMatchObject({ state: "ready" });
    expect(await search(null, id, "background")).toMatchObject({ state: "ready" });
    expect(await connections(id)).toEqual([]);
  });

  it("a key can't be put on it, nor a sign-in started", async () => {
    const open = await fake({ auth: false });
    const { id } = await mcp.approveServer(deps, asPerson(maya), { name: "Status", url: open.url, auth: "none" });
    expect((await problem(mcp.putKey(deps, asPerson(maya), { serverId: id, key: "whatever-key-1" }))).code).toBe(
      "invalid",
    );
    expect((await problem(mcp.startConnect(deps, asPerson(maya), { serverId: id }))).code).toBe("invalid");
  });
});

describe("the older HTTP with server-sent events", () => {
  it("a server with no sign-in is called through it", async () => {
    const legacy = await fake({ auth: false, sse: true });
    const { id } = await mcp.approveServer(deps, asPerson(maya), {
      name: "Legacy",
      url: legacy.url,
      auth: "none",
      transport: "sse",
    });
    expect(await mcp.listServerTools(deps, asPerson(maya), id)).toMatchObject({ state: "ready" });
    expect(await search(alice, id)).toMatchObject({ state: "ready" });
    expect(legacy.calls.at(-1)).toMatchObject({ tool: "search_issues" });
  });

  it("with a key: found on the first call with one, recorded, and called as its account", async () => {
    const legacy = await fake({ sse: true, keys: { sk_test_alice_1111: "alice", sk_test_maya_2222: "maya" } });
    const { id } = await mcp.approveServer(deps, asPerson(maya), {
      name: "Legacy keyed",
      url: legacy.url,
      auth: "apikey",
    });
    expect((await problem(mcp.putKey(deps, asPerson(alice), { serverId: id, key: "sk_test_wrong_000" }))).code).toBe(
      "refused",
    );
    await mcp.putKey(deps, asPerson(alice), { serverId: id, key: "sk_test_alice_1111" });
    const [row] = await system<{ transport: string }>(sql`select transport from app.mcp_server where id = ${id}`);
    expect(row?.transport).toBe("sse");
    await mcp.putKey(deps, asPerson(maya), { serverId: id, key: "sk_test_maya_2222" });
    await mcp.listServerTools(deps, asPerson(maya), id);
    expect(JSON.parse(textOf(await search(alice, id)) ?? "[]")[0]).toMatchObject({ assignee: "alice" });
    legacy.set({ keys: {} });
    expect(await search(alice, id)).toMatchObject({ state: "reconnect" });
  });
});

describe("a key refused on the older transport's message endpoint", () => {
  it("is `reconnect`, though the transport throws a plain error", async () => {
    const half = await fake({ sse: true, openStream: true, keys: { sk_test_half_9999: "ops" } });
    const { id } = await mcp.approveServer(deps, asPerson(maya), {
      name: "Half open",
      url: half.url,
      auth: "apikey",
      access: "shared",
      transport: "sse",
    });
    expect((await problem(mcp.putKey(deps, asPerson(maya), { serverId: id, key: "sk_test_nope_0000" }))).code).toBe(
      "refused",
    );
    await mcp.putKey(deps, asPerson(maya), { serverId: id, key: "sk_test_half_9999" });
    await mcp.listServerTools(deps, asPerson(maya), id);
    expect(await search(alice, id)).toMatchObject({ state: "ready" });
    half.set({ keys: {} });
    expect(await search(alice, id)).toMatchObject({ state: "reconnect", scope: "org" });
  });
});

describe("an OAuth client an admin entered", () => {
  let jira: FakeMcp;
  let jiraId = "";

  it("is kept as a secret, not on the server row", async () => {
    jira = await fake({ registration: false });
    jira.preregister("od-client", "s3cret-value", deps.redirectUrl);
    jiraId = (
      await mcp.approveServer(deps, asPerson(maya), {
        name: "Jira",
        url: jira.url,
        client: { clientId: " od-client ", clientSecret: "s3cret-value", issuer: jira.base },
      })
    ).id;
    const [row] = await system<{ client_source: string; client_secret_id: string | null }>(sql`
      select client_source, client_secret_id from app.mcp_server where id = ${jiraId}`);
    expect(row?.client_source).toBe("admin");
    expect(row?.client_secret_id).toBeTruthy();
    const [stored] = await system<{ ciphertext: Buffer }>(sql`
      select ciphertext from app.secret where id = ${row?.client_secret_id ?? null}`);
    expect(stored?.ciphertext.toString("utf8")).not.toContain("s3cret-value");
  });

  it("signs in with it (its secret sent as Basic), never registering one of its own", async () => {
    const started = await mcp.startConnect(deps, asPerson(alice), { serverId: jiraId });
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("od-client");
    const back = jira.approve(started.authorizationUrl, "alice");
    expect(await mcp.finishConnect(deps, asPerson(alice), back)).toMatchObject({ state: "ready" });
    expect(jira.registrations).toBe(0);
    await mcp
      .startConnect(deps, asPerson(maya), { serverId: jiraId })
      .then((s) => mcp.finishConnect(deps, asPerson(maya), jira.approve(s.authorizationUrl, "maya")));
    await mcp.listServerTools(deps, asPerson(maya), jiraId);
    expect(JSON.parse(textOf(await search(alice, jiraId)) ?? "[]")[0]).toMatchObject({ assignee: "alice" });
  });

  it("a client the service turns down is said plainly, and nothing is registered in its place", async () => {
    await mcp.updateServer(deps, asPerson(maya), jiraId, {
      client: { clientId: "od-client", clientSecret: "wrong", issuer: jira.base },
    });
    const started = await mcp.startConnect(deps, asPerson(bob), { serverId: jiraId });
    const back = jira.approve(started.authorizationUrl, "bob");
    const refused = await problem(mcp.finishConnect(deps, asPerson(bob), back));
    expect(refused.code).toBe("refused");
    expect(refused.message).toContain("client ID an admin entered");
    expect(jira.registrations).toBe(0);
  });

  it("a client is only for OAuth servers", async () => {
    const open = await fake({ auth: false });
    const { id } = await mcp.approveServer(deps, asPerson(maya), { name: "Open", url: open.url, auth: "none" });
    expect(
      (await problem(mcp.updateServer(deps, asPerson(maya), id, { client: { clientId: "x", issuer: open.base } })))
        .code,
    ).toBe("invalid");
  });

  it("is bound to where it was made: a server that moves its sign-in elsewhere never gets the secret", async () => {
    const elsewhere = await fake({ registration: false });
    elsewhere.preregister("od-client", "s3cret-value", deps.redirectUrl);
    await mcp.updateServer(deps, asPerson(maya), jiraId, {
      client: { clientId: "od-client", clientSecret: "s3cret-value", issuer: jira.base },
    });
    jira.set({ authServer: elsewhere.base });
    const moved = await problem(mcp.startConnect(deps, asPerson(bob), { serverId: jiraId }));
    expect(moved.code).toBe("refused");
    expect(moved.message).toContain(`now signs in at ${elsewhere.base}`);
    expect(elsewhere.grants).toEqual([]);
    expect(elsewhere.registrations).toBe(0);
    jira.set({ authServer: null });
  });

  it("what a service echoes back about a refused client never reaches a log", async () => {
    await mcp.updateServer(deps, asPerson(maya), jiraId, {
      client: { clientId: "od-client", clientSecret: "echoed-s3cret", issuer: jira.base },
    });
    jira.set({ echoErrors: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = await mcp.startConnect(deps, asPerson(bob), { serverId: jiraId });
      const refused = await problem(
        mcp.finishConnect(deps, asPerson(bob), jira.approve(started.authorizationUrl, "bob")),
      );
      expect(refused.code).toBe("refused");
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain("echoed-s3cret");
      expect(refused.message).not.toContain("echoed-s3cret");
    } finally {
      warn.mockRestore();
      error.mockRestore();
      jira.set({ echoErrors: false });
    }
  });

  it("can't be stored without its issuer, even directly", async () => {
    const failed = await system(sql`update app.mcp_server set issuer = null where id = ${jiraId}`).then(
      () => null,
      (e: { cause?: { constraint_name?: string } }) => e,
    );
    expect(failed?.cause?.constraint_name).toBe("mcp_server_client_issuer_check");
  });

  it("can't be entered without knowing where it was made", async () => {
    const strict = await fake({ registration: false });
    expect(
      (
        await problem(
          mcp.approveServer(deps, asPerson(maya), {
            name: "No issuer",
            url: strict.url,
            client: { clientId: "x", issuer: "" },
          }),
        )
      ).code,
    ).toBe("invalid");
  });
});

describe("what admins see of people's own connections: counts, never who", () => {
  const counts = (userId: string) =>
    withTenantOn(t.app, as(userId), (tx) =>
      tx.execute<{ server_id: string; connected: number; attention: number }>(
        sql`select server_id, connected, attention from app.mcp_connection_counts()`,
      ),
    );

  it("an admin gets how many connected and how many need them again; a member gets nothing", async () => {
    const mine = await counts(maya);
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) expect(Object.keys(row).sort()).toEqual(["attention", "connected", "server_id"]);
    const stripe = mine.find((r) => r.connected === 2 && r.attention === 0);
    expect(stripe).toBeTruthy();
    expect(await counts(alice)).toEqual([]);
  });

  it("row security still hides Alice's connection from the admin", async () => {
    const seen = await withTenantOn(t.app, as(maya), (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from app.mcp_connection where scope = 'personal' and scope_id = ${alice}`,
      ),
    );
    expect(seen[0]?.n).toBe(0);
  });
});

describe("what Settings shows", () => {
  it("admins see every server with its counts, whose account and tools; members are refused", async () => {
    const servers = await mcp.listServers(deps, asPerson(maya));
    const stripe = servers.find((s) => s.name === "Stripe");
    expect(stripe).toMatchObject({
      auth: "apikey",
      access: "personal",
      keyHeader: "X-API-Key",
      mine: { account: "••••4444", status: "ready" },
      shared: null,
      people: { connected: 2, attention: 0 },
    });
    expect(stripe?.tools.total).toBe(2);
    const zendesk = servers.find((s) => s.name === "Zendesk");
    expect(zendesk).toMatchObject({ access: "shared", shared: { account: "••••3f9a" }, mine: null, people: null });
    expect((await problem(mcp.listServers(deps, asPerson(alice)))).code).toBe("forbidden");
  });

  it("a server's page lists its tools, read-only first", async () => {
    const stripeId = (await mcp.listServers(deps, asPerson(maya))).find((s) => s.name === "Stripe")?.id ?? "";
    const detail = await mcp.serverDetail(deps, asPerson(maya), stripeId);
    expect(detail.tools_.map((t) => [t.name, t.readOnly, t.tier])).toEqual([
      ["search_issues", true, "always"],
      ["create_issue", false, "ask"],
    ]);
    expect((await problem(mcp.serverDetail(deps, asPerson(maya), uuidv7()))).code).toBe("not_found");
  });

  it("everyone sees their own connections and the shared ones, never anyone else's", async () => {
    const mine = await mcp.myConnections(deps, asPerson(alice));
    const stripe = mine.find((c) => c.name === "Stripe");
    expect(stripe?.mine).toMatchObject({ account: "••••8d32", status: "ready" });
    const bobs = await mcp.myConnections(deps, asPerson(bob));
    expect(bobs.find((c) => c.name === "Stripe")?.mine).toBeNull();
    expect(bobs.find((c) => c.name === "Zendesk")?.shared).toMatchObject({ account: "••••3f9a" });
  });
});

describe("someone leaves the workspace", () => {
  it("their own connections, keys and unfinished sign-ins go; shared ones and everyone else's stay", async () => {
    const before = await mcp.listServers(deps, asPerson(maya));
    const stripe = before.find((s) => s.name === "Stripe");
    expect(stripe?.people?.connected).toBe(2);
    const tracker = await fake();
    const { id } = await mcp.approveServer(deps, asPerson(maya), { name: "Leaving tracker", url: tracker.url });
    await mcp.startConnect(deps, asPerson(alice), { serverId: id });
    const secretsBefore = await mcpSecrets();
    expect(await mcp.personLeft(deps, orgId, alice)).toEqual({
      connections: 3,
      signIns: 1,
    });
    expect(await mcpSecrets()).toBe(secretsBefore - 4);
    const after = await mcp.listServers(deps, asPerson(maya));
    expect(after.find((s) => s.name === "Stripe")?.people?.connected).toBe(1);
    expect(after.find((s) => s.name === "Zendesk")?.shared).toMatchObject({ account: "••••3f9a" });
    expect((await mcp.myConnections(deps, asPerson(maya))).find((c) => c.name === "Stripe")?.mine).toMatchObject({
      status: "ready",
    });
  });
});

describe("disconnecting ends the sign-in at the service too", () => {
  it("revokes the refresh and access tokens where the service takes revocations; a key has nothing to revoke", async () => {
    const tracker = await fake();
    const { id } = await mcp.approveServer(deps, asPerson(maya), { name: "Revoking tracker", url: tracker.url });
    const started = await mcp.startConnect(deps, asPerson(bob), { serverId: id });
    await mcp.finishConnect(deps, asPerson(bob), tracker.approve(started.authorizationUrl, "bob"));
    expect(await mcp.disconnect(deps, asPerson(bob), { serverId: id })).toBe(true);
    expect(tracker.revoked.map((t) => t.slice(0, 3)).sort()).toEqual(["at-", "rt-"]);
    expect(await mcp.disconnect(deps, asPerson(bob), { serverId: id })).toBe(false);
  });
});

describe("limits the caller sets, checked against what the call uses", () => {
  it("a person's own account refused where others would read it; a tool that changes things refused when only reading", async () => {
    const stripeId = (await mcp.listServers(deps, asPerson(maya))).find((s) => s.name === "Stripe")?.id ?? "";
    const noPersonal = await mcp.callTool(deps, as(maya), {
      serverId: stripeId,
      tool: "search_issues",
      arguments: { query: "x" },
      via: "analyst",
      policy: { personal: false },
    });
    expect(noPersonal).toMatchObject({ state: "blocked", reason: "personal_not_here" });
    const writes = await mcp.callTool(deps, as(maya), {
      serverId: stripeId,
      tool: "create_issue",
      arguments: { title: "x" },
      via: "analyst",
      policy: { readsOnly: true },
    });
    expect(writes).toMatchObject({ state: "blocked", reason: "changes_things" });
    const zendeskId = (await mcp.listServers(deps, asPerson(maya))).find((s) => s.name === "Zendesk")?.id ?? "";
    // A change through an account the workspace shares is refused, even agreed to: one member would act for everyone.
    expect(
      await mcp.callTool(deps, as(maya), {
        serverId: zendeskId,
        tool: "create_issue",
        arguments: { title: "x" },
        via: "analyst",
        consented: true,
      }),
    ).toMatchObject({ state: "blocked", reason: "shared_account" });
    // A shared server isn't anyone's own: allowed where a personal one isn't.
    expect(
      await mcp.callTool(deps, as(maya), {
        serverId: zendeskId,
        tool: "search_issues",
        arguments: { query: "x" },
        via: "analyst",
        policy: { personal: false, readsOnly: true },
      }),
    ).toMatchObject({ state: "reconnect" });
  });

  it("a stopped caller stops the call", async () => {
    const stripeId = (await mcp.listServers(deps, asPerson(maya))).find((s) => s.name === "Stripe")?.id ?? "";
    const stop = new AbortController();
    stop.abort(new Error("Stopped by the person"));
    await expect(
      mcp.callTool(deps, as(maya), {
        serverId: stripeId,
        tool: "search_issues",
        arguments: { query: "x" },
        via: "analyst",
        signal: stop.signal,
      }),
    ).rejects.toThrow("Stopped by the person");
  });
});
