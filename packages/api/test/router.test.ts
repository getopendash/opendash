import { fromElsewhere } from "../src/handler";
// The API's router in-process, against a real database: the tenant middleware (signed out, no access), and Ask's
// procedures end to end through core: askable sources, submit, the conversation and its turns, events, stop.

import {
  createBoss,
  createSecretStore,
  dekAad,
  demoPack,
  generateDek,
  installDefinitions,
  installQueues,
  localKek,
} from "@opendash/core";
import { type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { createRouterClient, isDefinedError } from "@orpc/server";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiDeps, type ApiTenant, createRouter, createRpcHandler } from "../src";
import { contract, ERROR_STATUS_MAP } from "../src/contract";

let t: TestDatabase;
const kek = localKek(Buffer.alloc(32, 7).toString("base64"));
const secrets = createSecretStore({ kek });
let boss: PgBoss;
const orgId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const vera = uuidv7();
const otto = uuidv7();
const learned = uuidv7();
const fresh = uuidv7();

/** The test's "session": a header names the user; "denied" plays a member of another org. */
const resolveTenant = async (headers: Headers): Promise<ApiTenant | null> => {
  const user = headers.get("x-test-user");
  if (!user) return null;
  if (user === "denied") throw new Error("Not a member");
  if (user === "org-key") return { orgId, userId: null, channel: "api" };
  return { orgId, userId: user, channel: "web", role: user === vera ? "viewer" : user === otto ? "admin" : "member" };
};

const deps = (): ApiDeps => ({
  withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
  resolveTenant,
  boss: async () => boss,
  deploymentKeys: { gateway: false, anthropic: true, openai: false, google: false },
  secrets,
  authors: async (_org, ids) => Object.fromEntries(ids.filter((id) => id === alice).map((id) => [id, "Alice A"])),
});

const client = (user?: string) =>
  createRouterClient(createRouter(deps()), {
    context: { headers: new Headers(user ? { "x-test-user": user } : {}) },
  });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return isDefinedError(error) || (error as { code?: string }).code ? (error as { code: string }).code : "thrown";
  }
};

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Api");
  // The organization's data key, which its secrets (model keys) are encrypted under.
  await t.system.client`
    insert into app.org_key (org_id, version, wrapped_dek, kek_ref)
    values (${orgId}, 1, ${await kek.wrap(generateDek(), dekAad(orgId, 1))}, ${kek.ref})`;
  boss = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
  await boss.start();
  await installQueues(boss);
  await t.owner`
    insert into app.connection (org_id, id, name, dialect, config) values
      (${orgId}, ${learned}, 'warehouse', 'postgres', '{"host":"db"}'),
      (${orgId}, ${fresh}, 'new_db', 'postgres', '{"host":"db"}')`;
  await t.owner`
    insert into app.sync_run (org_id, id, connection_id, status, finished_at)
    values (${orgId}, ${uuidv7()}, ${learned}, 'succeeded', now())`;
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await t?.drop();
});

describe("who may call", () => {
  it("needs a signed-in member: signed out is UNAUTHORIZED, another org's member FORBIDDEN", async () => {
    expect(await code(client().threads.list({}))).toBe("UNAUTHORIZED");
    expect(await code(client("denied").threads.list({}))).toBe("FORBIDDEN");
    expect(await code(client(alice).threads.list({}))).toBe("ok");
  });

  it("validates input after access: an empty question is refused", async () => {
    expect(await code(client(alice).ask.submit({ text: "  ", connectionId: learned }))).toBe("BAD_REQUEST");
    expect(await code(client(alice).ask.submit({ text: "Hi?" }))).toBe("BAD_REQUEST");
  });
});

describe("Ask", () => {
  it("offers only sources that were learned", async () => {
    expect(await client(alice).sources.askable()).toEqual([
      { id: learned, name: "warehouse", dialect: "postgres", sample: false, failing: null },
    ]);
    expect(await code(client(alice).ask.submit({ text: "Too soon?", connectionId: fresh }))).toBe("NOT_FOUND");
  });

  it("asks, shows the conversation and its run, one run at a time, and stops it", async () => {
    const api = client(alice);
    const { threadId, runId } = await api.ask.submit({ text: "How did MRR change?", connectionId: learned });
    const jobs = async (id: string) => {
      const [job] = await t.owner<{ n: number }[]>`
        select count(*)::int as n from pgboss.job where name = 'agent.interactive' and data->>'runId' = ${id}`;
      return job?.n;
    };
    expect(await jobs(runId)).toBe(1);
    // Sent while it's worked on, a message joins it; its author can take it back until it's read.
    expect(await api.ask.submit({ text: "And churn?", threadId })).toEqual({ threadId, runId, queued: true });
    const waiting = (await api.threads.get({ threadId })).turns[0]?.followUps ?? [];
    expect(waiting).toEqual([
      { id: expect.any(String), text: "And churn?", createdAt: expect.any(String), state: "queued" },
    ]);
    const added = waiting[0]?.id as string;
    expect(await client(bob).ask.takeBack({ messageId: added })).toEqual({ takenBack: false });
    expect(await api.ask.takeBack({ messageId: added })).toEqual({ takenBack: true });
    expect(await api.ask.submit({ text: "And by plan?", threadId })).toMatchObject({ runId, queued: true });

    const thread = await api.threads.get({ threadId });
    expect(thread.turns.map((x) => [x.message.text, x.run?.status, x.followUps.map((f) => f.text)])).toEqual([
      ["How did MRR change?", "queued", ["And by plan?"]],
    ]);
    expect((await api.threads.list({ scope: "mine" })).map((x) => x.id)).toContain(threadId);
    expect(await code(client(bob).threads.get({ threadId }))).toBe("NOT_FOUND");

    const polled = await api.runs.events({ runId });
    expect(polled.run).toMatchObject({ status: "queued", outcome: null });
    expect(await api.runs.stop({ runId })).toEqual({ stopped: true });
    const after = await api.runs.events({ runId, afterSeq: 0 });
    expect(after.run).toMatchObject({ status: "cancelled", outcome: { kind: "no_answer" } });
    expect(after.events.map((e) => e.type)).toContain("run_end");
    // Stopped, what was added is the next question, with its job.
    const next = (await api.threads.get({ threadId })).turns;
    expect(next.map((x) => [x.message.text, x.run?.status, x.followUps.length])).toEqual([
      ["How did MRR change?", "cancelled", 0],
      ["And by plan?", "queued", 0],
    ]);
    expect(await jobs(next[1]?.run?.id as string)).toBe(1);
    expect(await code(api.queries.get({ queryRunId: uuidv7() }))).toBe("NOT_FOUND");
  });

  it("answers for the records behind a number: nothing for a run that isn't theirs, and bad input is refused", async () => {
    const api = client(alice);
    // A run that doesn't exist is a failed answer in words, not an error or a guess.
    expect(await api.queries.records({ queryRunId: uuidv7(), group: { time: "2026-09-01" } })).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/isn't available/),
    });
    // Pages are small, and the first thousand are all that can be listed.
    expect(await code(api.queries.records({ queryRunId: uuidv7(), pageSize: 500 }))).toBe("BAD_REQUEST");
    expect(await code(api.queries.records({ queryRunId: uuidv7(), page: 20 }))).toBe("BAD_REQUEST");
  });
});

describe("Sharing", () => {
  it("shares a conversation for reading, names its author to others, and only its author adds to it", async () => {
    const api = client(alice);
    const { threadId, runId } = await api.ask.submit({ text: "Shared churn?", connectionId: learned });
    await api.runs.stop({ runId });
    expect(await code(client(bob).threads.share({ threadId, visibility: "org" }))).toBe("NOT_FOUND");
    expect(await api.threads.share({ threadId, visibility: "org" })).toEqual({ visibility: "org" });

    const seen = await client(bob).threads.get({ threadId });
    expect(seen.thread).toMatchObject({ mine: false, visibility: "org", author: "Alice A" });
    expect((await client(bob).threads.list({})).find((x) => x.id === threadId)?.author).toBe("Alice A");
    // The conversations list's filters: shared with Bob, found by a word, stopped; nothing for a word it doesn't have.
    const ids = async (input: Parameters<ReturnType<typeof client>["threads"]["list"]>[0]) =>
      (await client(bob).threads.list(input)).map((x) => x.id);
    expect(await ids({ scope: "shared", q: "SHARED", state: "stopped" })).toEqual([threadId]);
    expect(await ids({ scope: "shared", q: "shared nothing-like-it" })).toEqual([]);
    expect(await ids({ scope: "mine", q: "shared" })).toEqual([]);
    expect(await code(client(bob).threads.list({ state: "partly" as "stopped" }))).toBe("BAD_REQUEST");
    // Stars: Bob's alone, on what he can read; not for an organization key.
    expect(await client(bob).threads.star({ threadId, starred: true })).toEqual({ starred: true });
    expect(await ids({ scope: "starred" })).toEqual([threadId]);
    expect((await api.threads.list({ scope: "starred" })).map((x) => x.id)).toEqual([]);
    expect(await code(client("org-key").threads.star({ threadId, starred: true }))).toBe("FORBIDDEN");
    expect((await api.threads.get({ threadId })).thread.author).toBeNull();
    expect(await code(client(bob).ask.submit({ text: "Me too?", threadId }))).toBe("FORBIDDEN");
    expect(await client(bob).runs.stop({ runId })).toEqual({ stopped: false });

    await api.threads.share({ threadId, visibility: "private" });
    expect(await code(client(bob).threads.get({ threadId }))).toBe("NOT_FOUND");
    expect(await code(client(bob).threads.star({ threadId, starred: false }))).toBe("NOT_FOUND");
  });

  it("shares with a project only a conversation in one, and only its author does (never an organization key)", async () => {
    const api = client(alice);
    const { threadId, runId } = await api.ask.submit({ text: "Board numbers?", connectionId: learned });
    await api.runs.stop({ runId });
    // Not in a project: nothing to share it with.
    expect(await code(api.threads.share({ threadId, visibility: "project" }))).toBe("NOT_FOUND");
    expect(await code(client("org-key").threads.share({ threadId, visibility: "project" }))).toBe("NOT_FOUND");
    expect(await code(client("org-key").threads.share({ threadId, visibility: "org" }))).toBe("NOT_FOUND");
    expect(await code(client(bob).threads.get({ threadId }))).toBe("NOT_FOUND");
  });

  it("lets a viewer read what's shared but not ask", async () => {
    expect(await code(client(vera).ask.submit({ text: "Can I?", connectionId: learned }))).toBe("FORBIDDEN");
    expect(await code(client(vera).threads.list({}))).toBe("ok");
  });
});

describe("A source's readiness", () => {
  it("is for owners and admins, on a source of the organization", async () => {
    for (const user of [alice, vera]) {
      expect(await code(client(user).sources.readiness({ connectionId: learned }))).toBe("FORBIDDEN");
    }
    const readiness = await client(otto).sources.readiness({ connectionId: learned });
    expect(readiness).toMatchObject({ score: 0, history: false });
    expect(readiness.parts.map((p) => p.key)).toEqual(["coverage", "metrics", "profiled", "queries", "evals"]);
    expect(readiness.parts[0]).toMatchObject({ detail: "No tables learned yet", next: null });
    expect(await code(client(otto).sources.readiness({ connectionId: uuidv7() }))).toBe("NOT_FOUND");
  });
});

describe("Evals", () => {
  it("are for owners and admins: members and viewers can't see them or start a run", async () => {
    for (const user of [alice, vera]) {
      expect(await code(client(user).evals.overview())).toBe("FORBIDDEN");
      expect(await code(client(user).evals.start())).toBe("FORBIDDEN");
      expect(await code(client(user).evals.setNightly({ nightly: true }))).toBe("FORBIDDEN");
    }
  });

  it("let an admin run them, one run at a time, and turn the nightly run on", async () => {
    const admin = client(otto);
    expect(await admin.evals.overview()).toMatchObject({ nightly: false, cases: [], runs: [] });
    const { evalRunId } = await admin.evals.start();
    expect(await code(admin.evals.start())).toBe("RUN_ACTIVE");
    expect(await admin.evals.run({ evalRunId })).toMatchObject({ id: evalRunId, status: "queued", results: [] });
    expect(await code(admin.evals.run({ evalRunId: uuidv7() }))).toBe("NOT_FOUND");
    expect(await admin.evals.setNightly({ nightly: true })).toEqual({ nightly: true });
    expect((await admin.evals.overview()).nightly).toBe(true);
  });
});

describe("AI models", () => {
  it("lets everyone see what they can ask with, by provider, and only admins change it", async () => {
    const models = await client(alice).ai.models();
    expect(models).toMatchObject({
      default: { model: "claude-sonnet-5-5", provider: "opendash", reasoning: "high" },
      offered: [{ provider: "opendash", label: "OpenDash", short: "OpenDash" }],
      manage: null,
    });
    expect(models.levels.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models.offered[0]?.models.find((m) => m.id === "claude-sonnet-5-5")).toMatchObject({
      levels: ["low", "medium", "high", "xhigh", "max"],
      defaultLevel: "high",
    });
    // A provider whose test failed: its admins are told, under the models; members aren't.
    const secretId = uuidv7();
    await t.owner`
      insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
      values (${orgId}, ${secretId}, 'llm_key', 1, '\\x00', '\\x00')`;
    await t.owner`
      insert into app.ai_provider (org_id, id, kind, secret_id, status, message)
      values (${orgId}, ${uuidv7()}, 'anthropic', ${secretId}, 'failed', 'The key was refused.')`;
    expect((await client(alice).ai.models()).manage).toBeNull();
    expect((await client(otto).ai.models()).manage).toEqual({ notWorking: ["Anthropic"] });
    await client(otto).ai.removeProvider({ kind: "anthropic" });
    expect((await client(otto).ai.models()).manage).toEqual({ notWorking: [] });
    for (const user of [alice, vera]) {
      expect(await code(client(user).ai.settings())).toBe("FORBIDDEN");
      expect(await code(client(user).ai.setProviderModels({ kind: "opendash", picked: ["claude-haiku-5-5"] }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await code(
          client(user).ai.testProvider({ kind: "openai", credentials: { apiKey: "sk-test-0123456789abcdefghij" } }),
        ),
      ).toBe("FORBIDDEN");
      expect(await code(client(user).ai.saveProvider({ kind: "openai", testId: uuidv7(), picked: [] }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await code(client(user).ai.setDefault({ model: "claude-haiku-5-5", provider: "opendash", reasoning: "high" })),
      ).toBe("FORBIDDEN");
    }
  });

  it("offers what an admin ticks, refuses a model it doesn't offer, and asks with the chosen one at its level", async () => {
    const admin = client(otto);
    expect(await code(admin.ai.setProviderModels({ kind: "opendash", picked: ["gpt-6.1-sol"] }))).toBe("INVALID");
    await admin.ai.setProviderModels({ kind: "opendash", picked: ["claude-sonnet-5-5", "claude-haiku-5-5"] });
    expect(await admin.ai.setDefault({ model: "claude-haiku-5-5", provider: "opendash", reasoning: "low" })).toEqual({
      model: "claude-haiku-5-5",
      provider: "opendash",
      reasoning: "low",
    });
    expect((await client(alice).ai.models()).default?.model).toBe("claude-haiku-5-5");
    expect(await code(client(alice).ask.submit({ text: "Hi?", connectionId: learned, model: "claude-opus-5-5" }))).toBe(
      "INVALID",
    );
    expect(
      await code(
        client(alice).ask.submit({
          text: "Hi?",
          connectionId: learned,
          model: "claude-sonnet-5-5",
          provider: "bedrock",
        }),
      ),
    ).toBe("INVALID");
    const { runId } = await client(alice).ask.submit({
      text: "And with Sonnet?",
      connectionId: learned,
      model: "claude-sonnet-5-5",
      reasoning: "xhigh",
    });
    const [run] = await t.owner<{ model: string; provider: string; reasoning: string }[]>`
      select model, provider, reasoning from app.run where id = ${runId}`;
    expect(run).toEqual({ model: "claude-sonnet-5-5", provider: "opendash", reasoning: "xhigh" });
  });

  it("tests typed credentials sealed, before anything is saved, and sets up only from a test that passed", async () => {
    const admin = client(otto);
    const { testId } = await admin.ai.testProvider({
      kind: "openai",
      credentials: { apiKey: "sk-test-0123456789abcdefghWXYZ" },
    });
    expect(await admin.ai.providerTest({ testId })).toMatchObject({ state: "testing", shown: { key: "…WXYZ" } });
    const view = await admin.ai.settings();
    expect(view.providers.find((p) => p.kind === "openai")?.state).toBe("not_set_up");
    expect(view.levels.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(JSON.stringify(view)).not.toContain("0123456789");
    const [row] = await t.owner<{ ciphertext: Buffer }[]>`
      select s.ciphertext from app.secret s join app.ai_provider_test p on p.org_id = s.org_id and p.secret_id = s.id
      where p.org_id = ${orgId} and p.id = ${testId}`;
    expect(row?.ciphertext.toString("utf8")).not.toContain("0123456789");
    const jobs = await t.owner<{ data: { kind: string; testId?: string } }[]>`
      select data from pgboss.job where name = 'ai_provider.test'`;
    expect(jobs.map((j) => j.data.testId)).toContain(testId);
    expect(await code(admin.ai.saveProvider({ kind: "openai", testId, picked: [] }))).toBe("INVALID");
    expect(await code(admin.ai.providerTest({ testId: uuidv7() }))).toBe("NOT_FOUND");
    expect(await code(admin.ai.testProvider({ kind: "openai", credentials: { apiKey: "not a key" } }))).toBe("INVALID");
    expect(await code(admin.ai.removeProvider({ kind: "opendash" }))).toBe("INVALID");
    expect(await code(admin.ai.removeProvider({ kind: "openai" }))).toBe("NOT_FOUND");
    expect(await code(admin.ai.retestProvider({ kind: "openai" }))).toBe("NOT_FOUND");
  });
});

describe("attachments", () => {
  it("lists what can be attached on a source, and refuses an attachment the asker can't read", async () => {
    expect(await client(alice).ask.attachable({ connectionId: learned })).toEqual(expect.any(Array));
    const missing = { kind: "guide" as const, id: "01a12345-0000-7000-8000-000000000000" };
    expect(
      await code(client(alice).ask.submit({ text: "With this?", connectionId: learned, attachments: [missing] })),
    ).toBe("INVALID");
  });
});

describe("spend limits", () => {
  it("are set by owners and admins only, and a question past one is refused as SPEND_LIMIT", async () => {
    for (const user of [alice, vera]) {
      expect(await code(client(user).usage.setLimits({ monthlyUsd: 10, dailyUsd: null }))).toBe("FORBIDDEN");
      expect(await code(client(user).usage.limits())).toBe("FORBIDDEN");
    }
    const view = await client(otto).usage.setLimits({ monthlyUsd: null, dailyUsd: 0.01 });
    // Background work keeps its own budget, $10 a month unless set (8650278).
    expect(view.limits).toEqual({ monthlyUsd: null, dailyUsd: 0.01, backgroundMonthlyUsd: 10, runCeilingUsd: 1.5 });
    await t.system.client`
      insert into app.usage_event (id, org_id, kind, qty, unit, model, cost_usd, source_type, source_id)
      values (${uuidv7()}, ${orgId}, 'llm_tokens', 10, 'tokens', 'claude-sonnet-5-5', 0.02, 'run', ${uuidv7()})`;
    expect(await code(client(alice).ask.submit({ text: "Past the limit?", connectionId: learned }))).toBe(
      "SPEND_LIMIT",
    );
    await client(otto).usage.setLimits({ monthlyUsd: null, dailyUsd: null });
  });
});

describe("the contract's errors", () => {
  it("each have an HTTP status, so a refusal is never answered as a 500", () => {
    const codes = new Set<string>();
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const def = (node as { "~orpc"?: { errorMap?: Record<string, unknown> } })["~orpc"];
      if (def?.errorMap) for (const k of Object.keys(def.errorMap)) codes.add(k);
      else for (const child of Object.values(node)) walk(child);
    };
    walk(contract);
    expect(codes.size).toBeGreaterThan(3);
    expect([...codes].filter((c) => !(c in ERROR_STATUS_MAP))).toEqual([]);
  });

  it("refuses a change to a record's work that names nothing to change, and takes one that clears a field", () => {
    type Schema = { safeParse(v: unknown): { success: boolean } };
    const [input] = (contract.dashboards.work as unknown as { "~orpc": { inputSchemas: Schema[] } })["~orpc"]
      .inputSchemas;
    if (!input) throw new Error("dashboards.work has no input schema");
    const at = { dashboardId: uuidv7(), revision: "a".repeat(64), section: "q_list" };
    expect(input.safeParse({ ...at, set: { key: "42" } }).success).toBe(false);
    expect(input.safeParse({ ...at, set: { key: "42", note: null } }).success).toBe(true);
    expect(input.safeParse(at).success).toBe(true);
  });

  it("refuses a body larger than it reads before anyone is resolved, and reads a small one", async () => {
    const handle = createRpcHandler(deps(), { prefix: "/api/rpc" });
    const post = (body: string) =>
      handle(
        new Request("http://localhost/api/rpc/learning/revert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    expect((await post(JSON.stringify({ json: { id: "x".repeat(13 * 1024 * 1024) } }))).status).toBe(413);
    // Small and signed out: it's read, and refused as it should be.
    expect((await post(JSON.stringify({ json: { id: uuidv7() } }))).status).toBe(401);
  });

  it("answers a body it can't read with 400, not 500, and logs nothing for it", async () => {
    const handle = createRpcHandler(deps(), { prefix: "/api/rpc" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handle(
        new Request("http://localhost/api/rpc/learning/revert", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": alice },
          body: "{not json",
        }),
      );
      expect(response.status).toBe(400);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("logs a call that broke by its procedure, workspace and reference, never the failed query or its values", async () => {
    // What Drizzle throws: the SQL and its parameters in the message, the database's own words in the cause.
    const failed = Object.assign(
      new Error("Failed query: select * from app.learning where id = $1\nparams: acme-secret"),
      {
        cause: { message: 'relation "app.learning" does not exist', code: "42P01" },
      },
    );
    const handle = createRpcHandler(
      {
        ...deps(),
        withTenant: async () => {
          throw failed;
        },
      },
      { prefix: "/api/rpc" },
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handle(
        new Request("http://localhost/api/rpc/learning/revert", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": otto },
          body: JSON.stringify({ json: { id: uuidv7() } }),
        }),
      );
      expect(response.status).toBe(500);
      const reference = response.headers.get("x-request-id");
      expect(reference).toMatch(/^[0-9a-f-]{36}$/);
      // Nothing of the failure reaches the caller either.
      expect(await response.text()).not.toMatch(/acme-secret|app\.learning/);

      expect(errors).toHaveBeenCalledTimes(1);
      const written = String(errors.mock.calls[0]?.[0]);
      expect(written).not.toMatch(/acme-secret|Failed query|select \*/);
      const line = JSON.parse(written);
      expect(line).toMatchObject({
        msg: "api error",
        procedure: "learning.revert",
        orgId,
        userId: otto,
        requestId: reference,
        error: 'relation "app.learning" does not exist (42P01)',
      });
      expect(line.stack.length).toBeGreaterThan(0);
      for (const frame of line.stack) expect(frame).toMatch(/^at /);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the reference a proxy gave a call, when it looks like one, and sends it back on every answer", async () => {
    const handle = createRpcHandler(deps(), { prefix: "/api/rpc" });
    const ask = (headers: Record<string, string>) =>
      handle(
        new Request("http://localhost/api/rpc/learning/revert", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ json: { id: uuidv7() } }),
        }),
      );
    expect((await ask({ "x-request-id": "req_8f2c1a7d4b" })).headers.get("x-request-id")).toBe("req_8f2c1a7d4b");
    expect((await ask({ "x-railway-request-id": "Zx9-abc_DEF.123" })).headers.get("x-request-id")).toBe(
      "Zx9-abc_DEF.123",
    );
    // Not a reference (a line break, markup, too long): one is made here instead.
    for (const given of ["a\tb c d e f g", "<script>alert(1)</script>", "x".repeat(200), "short"]) {
      expect((await ask({ "x-request-id": given })).headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("Learnings", () => {
  it("are approved, reverted, rejected and changed only by owners and admins; viewers suggest nothing", async () => {
    const id = uuidv7();
    for (const user of [alice, vera]) {
      expect(await code(client(user).learning.list())).toBe("FORBIDDEN");
      expect(await code(client(user).learning.approve({ id }))).toBe("FORBIDDEN");
      expect(await code(client(user).learning.revert({ id }))).toBe("FORBIDDEN");
      expect(await code(client(user).learning.reject({ id }))).toBe("FORBIDDEN");
      expect(await code(client(user).learning.edit({ id, synonyms: [] }))).toBe("FORBIDDEN");
    }
    expect(await code(client(vera).learning.suggest({ memoryId: uuidv7() }))).toBe("FORBIDDEN");
    // An admin on one that isn't waiting: not found, nothing approved.
    expect(await code(client(otto).learning.approve({ id }))).toBe("NOT_FOUND");
    expect(await code(client(otto).learning.edit({ id, synonyms: [] }))).toBe("NOT_FOUND");
    expect(await client(otto).learning.list()).toEqual([]);
    // Anyone sees the cards of an answer: none here.
    expect(await client(alice).learning.forRun({ runId: uuidv7() })).toEqual([]);
  });
});

describe("Dashboards", () => {
  it("are listed, opened, shared, restored and deleted, each only by whoever may", async () => {
    // Two versions written as they'd be published (the store's own checks are core's tests). Its query is on a
    // dataset this source doesn't have, so restoring a version is refused by today's checks.
    const dashboardId = uuidv7();
    const definition = (title: string) => ({
      version: 2,
      title,
      filters: {},
      queries: { q_n: { source: { connection: learned, dataset: "accounts" }, measures: { n: ["count"] } } },
    });
    await t.owner`
      insert into app.dashboard (org_id, id, title, owner_id, current_version)
      values (${orgId}, ${dashboardId}, 'Plain v2', ${alice}, 2)`;
    for (const v of [1, 2]) {
      await t.owner`
        insert into app.dashboard_version
          (org_id, dashboard_id, version, definition, runtime_hash, revision, author_id, change_note)
        values (${orgId}, ${dashboardId}, ${v}, ${t.owner.json(definition(`Plain v${v}`))}, ${"r".repeat(32)},
          ${String(v).repeat(64)}, ${alice}, ${`Plain v${v}`})`;
    }
    // Private: its owner's list and page, nobody else's.
    expect((await client(alice).dashboards.list()).map((d) => d.id)).toContain(dashboardId);
    expect((await client(bob).dashboards.list()).map((d) => d.id)).not.toContain(dashboardId);
    expect(await code(client(bob).dashboards.get({ dashboardId }))).toBe("NOT_FOUND");
    expect(await code(client(bob).dashboards.versions({ dashboardId }))).toBe("NOT_FOUND");
    // Only its owner shares it, and never an organization key.
    expect(await code(client(bob).dashboards.share({ dashboardId, visibility: "org" }))).toBe("NOT_FOUND");
    expect(await code(client("org-key").dashboards.share({ dashboardId, visibility: "org" }))).toBe("FORBIDDEN");
    expect(await code(client(alice).dashboards.share({ dashboardId, visibility: "project" }))).toBe("INVALID");
    await client(alice).dashboards.share({ dashboardId, visibility: "org" });
    expect(await client(bob).dashboards.get({ dashboardId })).toMatchObject({
      title: "Plain v2",
      mine: false,
      owner: "Alice A",
      currentVersion: 2,
    });
    expect((await client(vera).dashboards.versions({ dashboardId })).map((v) => [v.version, v.by])).toEqual([
      [2, "Alice A"],
      [1, "Alice A"],
    ]);
    // A page's queries under a revision the dashboard doesn't have: nothing there.
    expect(
      await code(
        client(bob).dashboards.query({ dashboardId, revision: "0".repeat(64), requests: [{ id: "a", query: "q_n" }] }),
      ),
    ).toBe("NOT_FOUND");
    // Restore: its owner's, against the version they saw, and only what passes today's checks.
    expect(await code(client(bob).dashboards.restore({ dashboardId, version: 1, expectedVersion: 2 }))).toBe(
      "FORBIDDEN",
    );
    expect(await code(client(alice).dashboards.restore({ dashboardId, version: 1, expectedVersion: 1 }))).toBe(
      "INVALID",
    );
    await expect(client(alice).dashboards.restore({ dashboardId, version: 1, expectedVersion: 2 })).rejects.toThrow(
      /Version 1 doesn't pass today's checks: queries\.q_n\.source\.dataset/,
    );
    expect(await client(bob).dashboards.get({ dashboardId })).toMatchObject({ currentVersion: 2 });
    // Publish: its owner's press, of the draft they saw (its revision), never the analyst's or anyone else's.
    await t.owner`
      insert into app.dashboard_draft
        (org_id, dashboard_id, definition, parts, bundle, bundle_hash, revision, runtime_hash, base_version)
      values (${orgId}, ${dashboardId}, ${t.owner.json(definition("Plain v3"))},
        ${t.owner.json({ "/App.tsx": "export default function App() { return null; }" })}, '/* the App */',
        ${"c".repeat(64)}, ${"3".repeat(64)}, ${"r".repeat(32)}, 2)`;
    expect(await code(client(bob).dashboards.publish({ dashboardId, revision: "3".repeat(64) }))).toBe("FORBIDDEN");
    expect(await code(client(alice).dashboards.publish({ dashboardId, revision: "4".repeat(64) }))).toBe("INVALID");
    // Never while what it reads isn't checked: the source has no accounts dataset yet. Once it's released, it is.
    await expect(client(alice).dashboards.publish({ dashboardId, revision: "3".repeat(64) })).rejects.toThrow(
      /accounts isn't checked right now/,
    );
    await withTenantOn(t.app, { orgId }, (tx) =>
      installDefinitions(tx, { orgId, userId: alice }, learned, demoPack("postgres"), {
        status: "verified",
        source: "pack",
      }),
    );
    expect(await client(alice).dashboards.publish({ dashboardId, revision: "3".repeat(64) })).toEqual({ version: 3 });
    expect(await client(bob).dashboards.get({ dashboardId })).toMatchObject({ title: "Plain v3", currentVersion: 3 });
    // Delete: not a member's or a viewer's; an admin's, gone for everyone.
    expect(await code(client(bob).dashboards.delete({ dashboardId }))).toBe("FORBIDDEN");
    expect(await code(client(vera).dashboards.delete({ dashboardId }))).toBe("FORBIDDEN");
    expect(await client(otto).dashboards.delete({ dashboardId })).toEqual({ deleted: true });
    expect(await code(client(alice).dashboards.get({ dashboardId }))).toBe("NOT_FOUND");
  });

  it("are shared with people by their owner, each to view or to edit, and taken back", async () => {
    // Members as Better Auth makes them: whoever is shared with must be one.
    for (const [id, role] of [
      [alice, "member"],
      [bob, "member"],
      [vera, "viewer"],
    ] as const) {
      await t.auth.client`
        insert into auth.user (id, name, email, email_verified) values (${id}, ${id}, ${`${id}@acme.test`}, true)
        on conflict (id) do nothing`;
      await t.auth.client`
        insert into auth.member (id, organization_id, user_id, role, created_at)
        values (${uuidv7()}, ${orgId}, ${id}, ${role}, now())
        on conflict (organization_id, user_id) do nothing`;
    }
    const people = async () => [
      { id: alice, name: "Alice A", email: "alice@acme.test", role: "member" },
      { id: bob, name: "Bob B", email: "bob@acme.test", role: "member" },
      { id: vera, name: "Vera V", email: "vera@acme.test", role: "viewer" },
    ];
    const as = (user: string) =>
      createRouterClient(createRouter({ ...deps(), people }), {
        context: { headers: new Headers({ "x-test-user": user }) },
      });
    const dashboardId = uuidv7();
    await t.owner`
      insert into app.dashboard (org_id, id, title, owner_id, current_version)
      values (${orgId}, ${dashboardId}, 'Team v1', ${alice}, 1)`;
    await t.owner`
      insert into app.dashboard_version (org_id, dashboard_id, version, definition, runtime_hash, revision, author_id)
      values (${orgId}, ${dashboardId}, 1, ${t.owner.json({ version: 2, title: "Team v1", filters: {}, queries: {} })},
        ${"r".repeat(32)}, ${"5".repeat(64)}, ${alice})`;
    // Private: not Bob's to open, nor to see or change who it's shared with.
    expect(await code(as(bob).dashboards.get({ dashboardId }))).toBe("NOT_FOUND");
    expect(await code(as(bob).dashboards.shares({ dashboardId }))).toBe("NOT_FOUND");
    expect(await code(as(bob).dashboards.sharePerson({ dashboardId, userId: bob, role: "edit" }))).toBe("NOT_FOUND");
    expect(await code(as("org-key").dashboards.shares({ dashboardId }))).toBe("FORBIDDEN");
    // Its owner adds Bob to view and Vera (a workspace viewer) to view; Vera never to edit.
    expect(await as(alice).dashboards.sharePerson({ dashboardId, userId: bob, role: "view" })).toEqual({
      role: "view",
    });
    expect(await code(as(alice).dashboards.sharePerson({ dashboardId, userId: vera, role: "edit" }))).toBe("INVALID");
    await as(alice).dashboards.sharePerson({ dashboardId, userId: vera, role: "view" });
    expect(await code(as(alice).dashboards.sharePerson({ dashboardId, userId: uuidv7(), role: "view" }))).toBe(
      "INVALID",
    );
    const listed = await as(alice).dashboards.shares({ dashboardId });
    expect(listed.people.map((p) => [p.name, p.email, p.role])).toEqual([
      ["Bob B", "bob@acme.test", "view"],
      ["Vera V", "vera@acme.test", "view"],
    ]);
    // Who can be added: the workspace's members but its owner, a viewer marked as one.
    expect(listed.members.map((m) => [m.name, m.viewer])).toEqual([
      ["Bob B", false],
      ["Vera V", true],
    ]);
    expect(await as(alice).dashboards.get({ dashboardId })).toMatchObject({ people: 2, canEdit: true });
    // Bob reads it, shared with him; his list says so. Viewing, he can't measure or undo its draft.
    expect(await as(bob).dashboards.get({ dashboardId })).toMatchObject({
      mine: false,
      canEdit: false,
      sharedRole: "view",
      owner: "Alice A",
      draft: null,
    });
    expect((await as(bob).dashboards.list()).find((d) => d.id === dashboardId)).toMatchObject({ sharedRole: "view" });
    expect(
      await code(as(bob).dashboards.renderCheck({ dashboardId, revision: "6".repeat(64), width: 390, findings: [] })),
    ).toBe("FORBIDDEN");
    expect(await code(as(bob).dashboards.shares({ dashboardId }))).toBe("FORBIDDEN");
    // Made an editor: the draft is his to change, never to publish, share or delete.
    await as(alice).dashboards.sharePerson({ dashboardId, userId: bob, role: "edit" });
    await t.owner`
      insert into app.dashboard_draft (org_id, dashboard_id, definition, revision, runtime_hash, base_version, updated_by)
      values (${orgId}, ${dashboardId}, ${t.owner.json({ version: 2, title: "Team v2", filters: {}, queries: {} })},
        ${"6".repeat(64)}, ${"r".repeat(32)}, 1, ${bob})`;
    expect(await as(bob).dashboards.get({ dashboardId })).toMatchObject({
      canEdit: true,
      sharedRole: "edit",
      draft: { revision: "6".repeat(64) },
    });
    expect(
      await as(bob).dashboards.renderCheck({ dashboardId, revision: "6".repeat(64), width: 390, findings: [] }),
    ).toEqual({ kept: true });
    // His draft's layout is measured by him only: in Alice's browser it would run his code over her data.
    expect(
      await as(alice).dashboards.renderCheck({ dashboardId, revision: "6".repeat(64), width: 760, findings: [] }),
    ).toEqual({ kept: false });
    expect(await code(as(bob).dashboards.publish({ dashboardId, revision: "6".repeat(64) }))).toBe("FORBIDDEN");
    expect(await code(as(bob).dashboards.share({ dashboardId, visibility: "org" }))).toBe("FORBIDDEN");
    expect(await code(as(bob).dashboards.sharePerson({ dashboardId, userId: vera, role: null }))).toBe("FORBIDDEN");
    expect(await code(as(bob).dashboards.delete({ dashboardId }))).toBe("FORBIDDEN");
    // Taken back: gone from his list and his page.
    expect(await as(alice).dashboards.sharePerson({ dashboardId, userId: bob, role: null })).toEqual({ role: null });
    expect((await as(bob).dashboards.list()).map((d) => d.id)).not.toContain(dashboardId);
    expect(await code(as(bob).dashboards.get({ dashboardId }))).toBe("NOT_FOUND");
  });
});

describe("requests from elsewhere", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://app.test/api/rpc/x", { method: "POST", headers });
  it("refuses a browser's request from another site or origin, and takes this origin's and a client's", () => {
    expect(fromElsewhere(req({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(fromElsewhere(req({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(fromElsewhere(req({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(fromElsewhere(req({ origin: "https://evil.test", host: "app.test" }))).toBe(true);
    expect(fromElsewhere(req({ origin: "http://app.test", host: "app.test" }))).toBe(false);
    expect(fromElsewhere(req({}))).toBe(false);
  });
});
