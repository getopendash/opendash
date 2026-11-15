// A workspace's AI providers and its default: OpenDash works with no row, on the deployment's keys, with
// its measured models ticked; a provider's credentials are checked, sealed and never shown again past what tells them
// apart; one being tested or not working offers nothing, and OpenDash isn't used in its place; only what a provider's
// own list offers can be ticked; the default gives way to one that can run; a daily refresh never fails a provider
// it merely couldn't reach.
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AiProblem,
  type AiProviderTestJob,
  aiSettings,
  choiceForQuestion,
  type DeploymentKeys,
  defaultChoice,
  dispatchProviderRefresh,
  failProviderTest,
  offeredModels,
  openAiKeyFor,
  PROVIDER_TEST_LIMIT,
  type ProviderTestResult,
  providerForRun,
  providerTest,
  removeProvider,
  requestProviderTest,
  retestProvider,
  saveProvider,
  setDefaultModel,
  setProviderModels,
  testProvider,
} from "../src";
import { CATALOG, type CatalogModel } from "../src/ai/catalog";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
// A second provider's mechanics are tested on OpenAI, whose models OpenDash hasn't measured yet (so none can be
// offered): from the moment it's measured (below), GPT-6.1 Sol stands in for one it has. Put back at the end.
const sol = CATALOG.find((m) => m.id === "gpt-6.1-sol") as { measured: CatalogModel["measured"] };
const solMeasured = (on: boolean) => {
  sol.measured = on ? { set: "golden", passed: 20, total: 21, on: "2026-10-25" } : null;
};
const ANTHROPIC: DeploymentKeys = { gateway: false, anthropic: true, openai: false, google: false };
const ALL: DeploymentKeys = { gateway: false, anthropic: true, openai: true, google: true };
const GATEWAY: DeploymentKeys = { gateway: true, anthropic: false, openai: false, google: false };
const NONE: DeploymentKeys = { gateway: false, anthropic: false, openai: false, google: false };
const KEY = "sk-proj-test-0123456789abcdefghijQRST";

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  solMeasured(false);
  await s?.close();
});

const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "none";
  } catch (error) {
    if (error instanceof AiProblem) return `${error.code}: ${error.message}`;
    throw error;
  }
};

const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const view = (keys: DeploymentKeys) => s.tenant((tx) => aiSettings(tx, s.orgId, keys));
const offered = async (keys: DeploymentKeys) =>
  (await s.tenant((tx) => offeredModels(tx, s.orgId, keys))).offered.map((g) => [
    g.provider,
    g.models.map((m) => m.id),
  ]);
const row = async (kind: string) =>
  (
    await s.t.owner<{ status: string; message: string | null; available: object; secret_id: string | null }[]>`
      select status, message, available, secret_id from app.ai_provider where kind = ${kind}`
  )[0];

describe("OpenDash, the deployment's own", () => {
  it("works with no row, on the deployment's keys, with its measured models ticked", async () => {
    const v = await view(ANTHROPIC);
    const opendash = v.providers.find((p) => p.kind === "opendash");
    expect(opendash).toMatchObject({ state: "working", via: "direct", message: null });
    expect(opendash?.models.map((m) => [m.id, m.picked])).toEqual([
      ["claude-sonnet-5-5", true],
      ["claude-opus-5-5", true],
      ["claude-haiku-5-5", true],
      ["claude-fable-5-1", true],
    ]);
    expect(v.default).toEqual({ model: "claude-sonnet-5-5", provider: "opendash", reasoning: "high" });
    expect(v.providers.filter((p) => p.state === "not_set_up").map((p) => p.kind)).toEqual([
      "gateway",
      "openrouter",
      "anthropic",
      "openai",
      "google",
      "bedrock",
      "vertex",
    ]);
    // Through a gateway it can run every allowlisted model; only the measured ones start ticked.
    const gw = (await view(GATEWAY)).providers.find((p) => p.kind === "opendash");
    expect(gw?.via).toBe("gateway");
    expect(gw?.models.filter((m) => m.picked).map((m) => m.maker)).toEqual([
      "anthropic",
      "anthropic",
      "anthropic",
      "anthropic",
    ]);
    expect(gw?.models.find((m) => m.id === "gpt-6.1-sol")).toMatchObject({ picked: false, measured: null });
  });

  it("offers nothing on a server with no keys, and its default stays for the run to say what's missing", async () => {
    const v = await view(NONE);
    expect(v.providers[0]).toMatchObject({
      kind: "opendash",
      state: "not_working",
      message: "This server has no AI keys of its own.",
    });
    expect(v.offered).toEqual([]);
    expect(v.default).toBeNull();
    const fallback = { model: "claude-sonnet-5-5", provider: "opendash", reasoning: "high" };
    expect(await s.tenant((tx) => defaultChoice(tx, s.orgId, NONE))).toEqual(fallback);
    expect(await s.tenant((tx) => choiceForQuestion(tx, s.orgId, NONE, undefined))).toEqual(fallback);
    // Choosing the default explicitly is the same as not choosing.
    expect(await s.tenant((tx) => choiceForQuestion(tx, s.orgId, NONE, { model: "claude-sonnet-5-5" }))).toEqual(
      fallback,
    );
  });

  it("ticks only what it offers, and turned off offers nothing", async () => {
    const set = (picked: string[], enabled?: boolean, keys = ANTHROPIC) =>
      problem(
        s.tenant((tx) =>
          setProviderModels(tx, ctx(), keys, {
            kind: "opendash",
            picked,
            ...(enabled === undefined ? {} : { enabled }),
          }),
        ),
      );
    expect(await set(["gpt-6.1-sol"])).toBe("invalid: OpenDash doesn't offer GPT-6.1 Sol.");
    expect(await set(["gpt-1"])).toBe("invalid: gpt-1 isn't a model OpenDash allows.");
    expect(await set(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])).toBe("none");
    expect(await offered(ANTHROPIC)).toEqual([["opendash", ["claude-sonnet-5-5", "claude-haiku-5-5"]]]);
    expect(await set(["claude-haiku-5-5"], false)).toBe("none");
    expect((await view(ANTHROPIC)).providers[0]?.state).toBe("off");
    expect(await offered(ANTHROPIC)).toEqual([]);
    expect(await set(["claude-sonnet-5-5", "claude-haiku-5-5"], true)).toBe("none");
  });
});

describe("the default and a question's choice", () => {
  it("is a model people can pick, at a level it takes", async () => {
    const set = (model: string, provider: string, reasoning: string, keys = ANTHROPIC) =>
      s.tenant((tx) => setDefaultModel(tx, ctx(), keys, { model, provider, reasoning }));
    expect(await problem(set("claude-opus-5-5", "opendash", "high"))).toBe(
      "invalid: The default has to be a model people can pick.",
    );
    expect(await problem(set("claude-haiku-5-5", "anthropic", "high"))).toBe(
      "invalid: The default has to be a model people can pick.",
    );
    expect(await set("claude-haiku-5-5", "opendash", "xhigh")).toEqual({
      model: "claude-haiku-5-5",
      provider: "opendash",
      reasoning: "xhigh",
    });
    expect((await view(ANTHROPIC)).default).toEqual({
      model: "claude-haiku-5-5",
      provider: "opendash",
      reasoning: "xhigh",
    });
  });

  it("asks with what the person chose when it's offered, at the level they chose or its default", async () => {
    const pick = (chosen: Parameters<typeof choiceForQuestion>[3]) =>
      s.tenant((tx) => choiceForQuestion(tx, s.orgId, ANTHROPIC, chosen));
    // Nothing chosen: the default, at its level.
    expect(await pick(undefined)).toEqual({ model: "claude-haiku-5-5", provider: "opendash", reasoning: "xhigh" });
    expect(await pick({ reasoning: "low" })).toMatchObject({ model: "claude-haiku-5-5", reasoning: "low" });
    // A model named without its provider runs where it's offered; a level it doesn't take is its default.
    expect(await pick({ model: "claude-sonnet-5-5", reasoning: "max" })).toEqual({
      model: "claude-sonnet-5-5",
      provider: "opendash",
      reasoning: "max",
    });
    expect(await pick({ model: "claude-sonnet-5-5", reasoning: "loud" })).toMatchObject({ reasoning: "high" });
    expect(await problem(pick({ model: "claude-opus-5-5" }))).toBe(
      "invalid: That model isn't offered here. Choose another, or ask an admin to offer it.",
    );
    expect(await problem(pick({ model: "claude-sonnet-5-5", provider: "bedrock" }))).toBe(
      "invalid: That model isn't offered here. Choose another, or ask an admin to offer it.",
    );
  });

  it("gives way to a model that can run when the default's can't", async () => {
    // Haiku ticked off OpenDash: the default moves to OpenDash's first, at the level it had where that takes it.
    await s.tenant((tx) =>
      setProviderModels(tx, ctx(), ANTHROPIC, { kind: "opendash", picked: ["claude-sonnet-5-5"] }),
    );
    expect(await s.tenant((tx) => defaultChoice(tx, s.orgId, ANTHROPIC))).toEqual({
      model: "claude-sonnet-5-5",
      provider: "opendash",
      reasoning: "xhigh",
    });
    await s.tenant((tx) =>
      setProviderModels(tx, ctx(), ANTHROPIC, { kind: "opendash", picked: ["claude-sonnet-5-5", "claude-haiku-5-5"] }),
    );
  });
});

describe("a workspace's own provider", () => {
  it("checks typed credentials, seals them at once, and tests them before anything is saved", async () => {
    const test = (kind: string, credentials: unknown) =>
      problem(s.tenant((tx) => requestProviderTest(s.deps, tx, ctx(), { kind, credentials })));
    expect(await test("openai", { apiKey: "sk" })).toBe(
      "invalid: That doesn't look like an API key: paste the whole key.",
    );
    expect(await test("opendash", {})).toBe("invalid: OpenDash needs nothing set up.");
    expect(await test("llama", {})).toBe("invalid: That provider isn't supported.");
    const testId = await s.tenant((tx) =>
      requestProviderTest(s.deps, tx, ctx(), { kind: "openai", credentials: { apiKey: ` ${KEY} ` } }),
    );
    // Nothing about the workspace's providers changes while it's tested.
    expect((await view(ALL)).providers.find((p) => p.kind === "openai")?.state).toBe("not_set_up");
    expect(await s.tenant((tx) => providerTest(tx, s.orgId, testId))).toMatchObject({
      state: "testing",
      shown: { key: "…QRST" },
      models: [],
    });
    const [secret] = await s.t.owner<{ kind: string; ciphertext: Buffer }[]>`
      select s.kind, s.ciphertext from app.secret s
      join app.ai_provider_test t on t.org_id = s.org_id and t.secret_id = s.id where t.id = ${testId}`;
    expect(secret?.kind).toBe("llm_key");
    expect(secret?.ciphertext.includes(Buffer.from("0123456789"))).toBe(false);
    const jobs = await s.t.owner<{ data: AiProviderTestJob }[]>`
      select data from pgboss.job where name = 'ai_provider.test'`;
    expect(jobs.map((j) => [j.data.kind, j.data.testId])).toEqual([["openai", testId]]);
    // A test that hasn't passed can't be set up.
    expect(await problem(s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: [] })))).toBe(
      "invalid: Test the connection first: it has to work to be set up.",
    );
  });

  it("is set up from a test that passed, with only the models its own list offers", async () => {
    const [t] = await s.t.owner<{ id: string; secret_id: string }[]>`select id, secret_id from app.ai_provider_test`;
    const testId = t?.id as string;
    const job: AiProviderTestJob = { orgId: s.orgId, kind: "openai", secretId: t?.secret_id as string, testId };
    const seen: unknown[] = [];
    const listed = async (_kind: string, credentials: unknown): Promise<ProviderTestResult> => {
      seen.push(credentials);
      return { ok: true, available: { "gpt-6.1-sol": "gpt-6.1-sol" } };
    };
    await testProvider(s.deps, job, listed);
    // The worker opened the credentials it sealed, whole.
    expect(seen).toEqual([{ apiKey: KEY }]);
    // Not measured, so not ticked to begin with; GPT-6 Luna isn't on its list.
    expect(await s.tenant((tx) => providerTest(tx, s.orgId, testId))).toMatchObject({
      state: "ok",
      models: [{ id: "gpt-6.1-sol", picked: false }],
      missing: ["GPT-6 Luna"],
    });
    expect(
      await problem(s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: ["gpt-6-luna"] }))),
    ).toBe("invalid: OpenAI doesn't offer GPT-6 Luna.");
    // Unmeasured, it can't be offered; once OpenDash has measured it, it can.
    expect(
      await problem(s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: ["gpt-6.1-sol"] }))),
    ).toBe("invalid: GPT-6.1 Sol isn't measured yet: it can be offered once OpenDash has measured it.");
    solMeasured(true);
    expect(await problem(s.tenant((tx) => saveProvider(tx, ctx(), { kind: "anthropic", testId, picked: [] })))).toBe(
      "not_found: That test doesn't exist.",
    );
    await s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: ["gpt-6.1-sol"] }));
    // A test is used once.
    expect(await problem(s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: [] })))).toBe(
      "not_found: That test doesn't exist.",
    );
    const openai = (await view(ALL)).providers.find((p) => p.kind === "openai");
    expect(openai).toMatchObject({ state: "working", shown: { key: "…QRST" }, missing: ["GPT-6 Luna"] });
    expect(JSON.stringify(await view(ALL))).not.toContain("0123456789");
    expect(await offered(ALL)).toEqual([
      ["opendash", ["claude-sonnet-5-5", "claude-haiku-5-5"]],
      ["openai", ["gpt-6.1-sol"]],
    ]);
    expect(await s.tenant((tx) => openAiKeyFor(s.deps, tx, s.orgId))).toEqual({ apiKey: KEY });
    expect(await s.tenant((tx) => providerForRun(s.deps, tx, s.orgId, "openai", ALL))).toMatchObject({
      state: "working",
      available: { "gpt-6.1-sol": "gpt-6.1-sol" },
      picked: ["gpt-6.1-sol"],
      credentials: { apiKey: KEY },
    });
    // The same model under two providers: one named with its provider runs there.
    await s.tenant((tx) =>
      setDefaultModel(tx, ctx(), ALL, { model: "gpt-6.1-sol", provider: "openai", reasoning: "high" }),
    );
    expect(await s.tenant((tx) => choiceForQuestion(tx, s.orgId, ALL, { model: "gpt-6.1-sol" }))).toEqual({
      model: "gpt-6.1-sol",
      provider: "openai",
      reasoning: "high",
    });
  });

  it("stops working when it fails, a refresh fails it only when refused, and a dead test isn't left testing", async () => {
    const [r] = await s.t.owner<{ secret_id: string }[]>`select secret_id from app.ai_provider where kind = 'openai'`;
    const job: AiProviderTestJob = { orgId: s.orgId, kind: "openai", secretId: r?.secret_id as string };
    const down = async (): Promise<ProviderTestResult> => ({
      ok: false,
      message: "Couldn't reach OpenAI.",
      refused: false,
    });
    const refused = async (): Promise<ProviderTestResult> => ({
      ok: false,
      message: "OpenAI refused the key (401).",
      refused: true,
    });
    await testProvider(s.deps, { ...job, refresh: true }, down);
    expect((await row("openai"))?.status).toBe("ok");
    await testProvider(s.deps, { ...job, refresh: true }, refused);
    expect(await row("openai")).toMatchObject({ status: "failed", message: "OpenAI refused the key (401)." });
    // The composer offers what can run, OpenDash's first (the same model isn't ticked there), for a person to send.
    expect((await view(ALL)).default).toEqual({ model: "claude-sonnet-5-5", provider: "opendash", reasoning: "high" });
    expect(await offered(ALL)).toEqual([["opendash", ["claude-sonnet-5-5", "claude-haiku-5-5"]]]);
    // Work nobody chose for (routines, Slack, the API) is held to OpenAI, never moved: its run says OpenAI isn't working.
    const held = { model: "gpt-6.1-sol", provider: "openai", reasoning: "high" };
    expect(await s.tenant((tx) => defaultChoice(tx, s.orgId, ALL))).toEqual(held);
    expect(await s.tenant((tx) => choiceForQuestion(tx, s.orgId, ALL, undefined))).toEqual(held);
    expect(
      await s.tenant((tx) =>
        choiceForQuestion(tx, s.orgId, ALL, { model: "claude-sonnet-5-5", provider: "opendash", reasoning: "xhigh" }),
      ),
    ).toEqual({ model: "claude-sonnet-5-5", provider: "opendash", reasoning: "xhigh" });
    // Naming a model is choosing: it runs where it's offered.
    expect(await s.tenant((tx) => choiceForQuestion(tx, s.orgId, ALL, { model: "claude-sonnet-5-5" }))).toEqual({
      model: "claude-sonnet-5-5",
      provider: "opendash",
      reasoning: "high",
    });
    // Settings shows the saved default, its provider marked; changing only its thinking keeps it on OpenAI.
    expect((await view(ALL)).held).toMatchObject({
      choice: held,
      group: { provider: "openai", note: "Not working", models: [{ id: "gpt-6.1-sol" }] },
    });
    await s.tenant((tx) =>
      setDefaultModel(tx, ctx(), ALL, { model: "gpt-6.1-sol", provider: "openai", reasoning: "low" }),
    );
    expect(await s.tenant((tx) => defaultChoice(tx, s.orgId, ALL))).toEqual({ ...held, reasoning: "low" });
    expect(
      await problem(
        s.tenant((tx) =>
          setDefaultModel(tx, ctx(), ALL, { model: "gpt-6-luna", provider: "openai", reasoning: "high" }),
        ),
      ),
    ).toBe("invalid: The default has to be a model people can pick.");
    await s.tenant((tx) => setDefaultModel(tx, ctx(), ALL, held));
    // A test that never finished fails; one that passed meanwhile is left alone.
    await s.tenant((tx) => retestProvider(s.deps, tx, ctx(), "openai"));
    await failProviderTest(s.deps, job);
    expect(await row("openai")).toMatchObject({ status: "failed", message: "The test didn't finish. Test it again." });
    await testProvider(s.deps, job, async () => ({ ok: true, available: { "gpt-6.1-sol": "gpt-6.1-sol" } }));
    await failProviderTest(s.deps, job);
    expect((await row("openai"))?.status).toBe("ok");
    // A test of credentials replaced since it was queued touches nothing.
    expect(
      await testProvider(s.deps, { ...job, secretId: "0190a000-0000-7000-8000-000000000000" }, refused),
    ).toBeNull();
    expect((await row("openai"))?.status).toBe("ok");
  });

  it("refreshes every working provider with a list once a day, once", async () => {
    const deps = {
      withSystem: (fn: never) => withSystemOn(s.t.system, fn),
      withTenant: s.deps.withTenant,
      boss: s.boss,
    };
    const now = () => new Date("2026-10-21T04:41:00Z");
    expect(await dispatchProviderRefresh({ ...deps, now } as never)).toEqual({ queued: 1 });
    expect(await dispatchProviderRefresh({ ...deps, now } as never)).toEqual({ queued: 0 });
    const jobs = await s.t.owner<{ data: AiProviderTestJob }[]>`
      select data from pgboss.job where name = 'ai_provider.test' and data->>'refresh' = 'true'`;
    expect(jobs.map((j) => j.data.kind)).toEqual(["openai"]);
  });

  it("keeps working on its old key until a replacement passes and is saved, then takes only the new one", async () => {
    const before = (await row("openai"))?.secret_id as string;
    const count = async (id: string) =>
      (await s.t.owner<{ n: number }[]>`select count(*)::int as n from app.secret where id = ${id}`)[0]?.n;
    const testId = await s.tenant((tx) =>
      requestProviderTest(s.deps, tx, ctx(), { kind: "openai", credentials: { apiKey: `${KEY}9` } }),
    );
    // A test of the replacement changes nothing: the provider keeps working on the old key.
    expect(await row("openai")).toMatchObject({ status: "ok", secret_id: before });
    const [t] = await s.t.owner<
      { secret_id: string }[]
    >`select secret_id from app.ai_provider_test where id = ${testId}`;
    await testProvider(
      s.deps,
      { orgId: s.orgId, kind: "openai", secretId: t?.secret_id as string, testId },
      async () => ({ ok: true, available: { "gpt-6.1-sol": "gpt-6.1-sol", "gpt-6-luna": "gpt-6-luna" } }),
    );
    expect(await row("openai")).toMatchObject({ status: "ok", secret_id: before });
    // GPT-6 Luna isn't measured: listed, never ticked, and can't be offered.
    expect(
      await problem(
        s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: ["gpt-6.1-sol", "gpt-6-luna"] })),
      ),
    ).toBe("invalid: GPT-6 Luna isn't measured yet: it can be offered once OpenDash has measured it.");
    await s.tenant((tx) => saveProvider(tx, ctx(), { kind: "openai", testId, picked: ["gpt-6.1-sol"] }));
    expect(await count(before)).toBe(0);
    expect(await row("openai")).toMatchObject({ status: "ok", secret_id: t?.secret_id });
    // OpenAI offering another model than the default's: everyone starts on that one, on OpenAI, as background work
    // does; it never moves to the same model elsewhere. (GPT-6 Luna stands in for a measured one here too.)
    const luna = CATALOG.find((m) => m.id === "gpt-6-luna") as { measured: CatalogModel["measured"] };
    luna.measured = sol.measured;
    await s.tenant((tx) => setProviderModels(tx, ctx(), ALL, { kind: "openai", picked: ["gpt-6-luna"] }));
    const onOpenAi = { model: "gpt-6-luna", provider: "openai", reasoning: "high" };
    expect(await view(ALL)).toMatchObject({ default: onOpenAi, held: null });
    expect(await s.tenant((tx) => defaultChoice(tx, s.orgId, ALL))).toEqual(onOpenAi);
    await s.tenant((tx) => setProviderModels(tx, ctx(), ALL, { kind: "openai", picked: ["gpt-6.1-sol"] }));
    luna.measured = null;
    expect((await view(ALL)).providers.find((p) => p.kind === "openai")).toMatchObject({
      shown: { key: "…RST9" },
      missing: [],
    });
    // A model OpenDash hasn't measured is never offered, whatever was stored, so nothing runs on it.
    solMeasured(false);
    expect((await view(ALL)).providers.find((p) => p.kind === "openai")?.models).toEqual([
      expect.objectContaining({ id: "gpt-6.1-sol", picked: false }),
      expect.objectContaining({ id: "gpt-6-luna", picked: false }),
    ]);
    expect((await offered(ALL)).map(([provider]) => provider)).not.toContain("openai");
    expect(await s.tenant((tx) => providerForRun(s.deps, tx, s.orgId, "openai", ALL))).toMatchObject({ picked: [] });
    expect(
      await problem(s.tenant((tx) => setProviderModels(tx, ctx(), ALL, { kind: "openai", picked: ["gpt-6.1-sol"] }))),
    ).toBe("invalid: GPT-6.1 Sol isn't measured yet: it can be offered once OpenDash has measured it.");
    solMeasured(true);
    await s.tenant((tx) => removeProvider(tx, ctx(), "openai"));
    expect(await count(t?.secret_id as string)).toBe(0);
    expect(await problem(s.tenant((tx) => removeProvider(tx, ctx(), "openai")))).toBe(
      "not_found: That provider isn't set up.",
    );
    expect(await problem(s.tenant((tx) => removeProvider(tx, ctx(), "opendash")))).toBe(
      "invalid: OpenDash can be turned off, not removed.",
    );
    expect((await view(ALL)).providers.find((p) => p.kind === "openai")?.state).toBe("not_set_up");
  });

  it("caps tests per workspace, and drops the credentials of tests nobody saved after a day", async () => {
    const ask = () =>
      s.tenant((tx) => requestProviderTest(s.deps, tx, ctx(), { kind: "anthropic", credentials: { apiKey: KEY } }));
    const unsaved = await ask();
    const [old] = await s.t.owner<{ secret_id: string }[]>`
      select secret_id from app.ai_provider_test where id = ${unsaved}`;
    await s.t.owner`update app.ai_provider_test set created_at = now() - interval '2 days' where id = ${unsaved}`;
    await ask();
    const [gone] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.secret where id = ${old?.secret_id as string}`;
    expect(gone?.n).toBe(0);
    const results: string[] = [];
    for (let i = 0; i < PROVIDER_TEST_LIMIT.max; i++) results.push(await problem(ask()));
    expect(results.at(-1)).toBe("invalid: Too many tests in a short time. Wait a few minutes and try again.");
  });
});
