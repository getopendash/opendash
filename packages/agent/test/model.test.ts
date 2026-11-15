// A run's model: OpenDash's own runs on the deployment's gateway when it has one, else on each maker's key;
// a workspace's provider runs on its own credentials once its test has passed, never falling back to OpenDash's while
// it doesn't; a model it no longer offers, one an admin doesn't, or one OpenDash no longer allows, fails the run at once
// with what to do. The
// level a run thinks at goes as the AI SDK's reasoning.
import {
  type AiProviderTestJob,
  requestProviderTest,
  saveProvider,
  setProviderModels,
  testProvider,
} from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelResolver, ModelUnavailable } from "../src";

let s: LearnedSource;
const KEY = "sk-ant-test-0123456789abcdefghijWXYZ";
const DEPLOYMENT = { ANTHROPIC_API_KEY: "sk-ant-deployment-key-0000000000" };

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const resolve = (
  modelId: string,
  env: NodeJS.ProcessEnv,
  provider: "opendash" | "anthropic" | "bedrock" = "opendash",
  reasoning?: "low" | "medium" | "high" | "xhigh" | "max",
) =>
  createModelResolver({ withTenant: s.deps.withTenant, secrets: s.secrets, env })({
    orgId: s.orgId,
    runId: "r",
    modelId,
    provider,
    reasoning,
  });

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (error) {
    if (error instanceof ModelUnavailable) return error.message;
    throw error;
  }
};

const idOf = (r: { model: unknown }) => (r.model as { modelId: string }).modelId;

describe("OpenDash's own runs", () => {
  it("go on the deployment's key for the model's maker, thinking at the run's level", async () => {
    const r = await resolve("claude-haiku-5-5", DEPLOYMENT, "opendash", "low");
    expect(r).toMatchObject({ provider: "opendash", route: "anthropic", keySource: "deployment", reasoning: "low" });
    expect(r.providerOptions).toEqual({});
    expect(idOf(r)).toBe("claude-haiku-5-5");
    const auto = await resolve("claude-sonnet-5-5", DEPLOYMENT);
    // None chosen: the model's default, effort high for Claude, the same as omitting it.
    expect(auto.reasoning).toBe("high");
  });

  it("go through the deployment's gateway when it has a key, by the gateway's id, asking for no training", async () => {
    const r = await resolve("claude-sonnet-5-5", { AI_GATEWAY_API_KEY: "vck_deployment_0000000000000000" });
    expect(r).toMatchObject({ route: "gateway", keySource: "deployment" });
    expect(idOf(r)).toBe("anthropic/claude-sonnet-5.5");
    expect(r.providerOptions).toEqual({ gateway: { disallowPromptTraining: true } });
  });

  it("fail at once, saying what's missing, or that a model isn't allowed", async () => {
    expect(await failure(resolve("gpt-6.1-sol", DEPLOYMENT))).toBe(
      "OpenDash doesn't offer GPT-6.1 Sol: ask again with another model.",
    );
    expect(await failure(resolve("claude-haiku-5-5", {}))).toBe(
      "There are no AI keys on this server: set up a provider in Settings → AI.",
    );
    expect(await failure(resolve("gpt-2", DEPLOYMENT))).toBe(
      "gpt-2 isn't a model OpenDash allows any more: ask again with another.",
    );
  });

  it("run only the models an admin offers, whatever asks for another (a stored default, a routine)", async () => {
    const keys = { gateway: false, anthropic: true, openai: false, google: false };
    await s.tenant((tx) =>
      setProviderModels(tx, { orgId: s.orgId, userId: s.userId }, keys, {
        kind: "opendash",
        picked: ["claude-sonnet-5-5"],
      }),
    );
    try {
      expect(await failure(resolve("claude-haiku-5-5", DEPLOYMENT))).toBe(
        "Claude Haiku 5.5 isn't offered through OpenDash here: choose another, or ask an admin to offer it in Settings → AI.",
      );
      expect((await resolve("claude-sonnet-5-5", DEPLOYMENT)).provider).toBe("opendash");
    } finally {
      await s.t.owner`delete from app.ai_provider where org_id = ${s.orgId} and kind = 'opendash'`;
    }
  });
});

describe("a workspace's own provider", () => {
  it("runs on its own key once it works, and fails rather than falling back to OpenDash's while it doesn't", async () => {
    expect(await failure(resolve("claude-sonnet-5-5", DEPLOYMENT, "anthropic"))).toBe(
      "Anthropic isn't set up any more: choose another model.",
    );
    const deps = { withTenant: s.deps.withTenant, secrets: s.secrets };
    const ctx = { orgId: s.orgId, userId: s.userId };
    // Tested before it's saved: while that runs, it isn't set up, and OpenDash isn't used in its place.
    const testId = await s.tenant((tx) =>
      requestProviderTest({ secrets: s.secrets, boss: s.boss }, tx, ctx, {
        kind: "anthropic",
        credentials: { apiKey: KEY },
      }),
    );
    expect(await failure(resolve("claude-sonnet-5-5", DEPLOYMENT, "anthropic"))).toBe(
      "Anthropic isn't set up any more: choose another model.",
    );
    const [t] = await s.t.owner<
      { secret_id: string }[]
    >`select secret_id from app.ai_provider_test where id = ${testId}`;
    await testProvider(
      deps,
      { orgId: s.orgId, kind: "anthropic", secretId: t?.secret_id as string, testId },
      async () => ({
        ok: true,
        available: { "claude-sonnet-5-5": "claude-sonnet-5-5-20260928" },
      }),
    );
    await s.tenant((tx) => saveProvider(tx, ctx, { kind: "anthropic", testId, picked: ["claude-sonnet-5-5"] }));
    // Refused later (Test again): it stops working, and its runs fail rather than fall back.
    const job: AiProviderTestJob = { orgId: s.orgId, kind: "anthropic", secretId: t?.secret_id as string };
    await testProvider(deps, job, async () => ({
      ok: false,
      message: "Anthropic refused these credentials (401).",
      refused: true,
    }));
    expect(await failure(resolve("claude-sonnet-5-5", DEPLOYMENT, "anthropic"))).toBe(
      "Anthropic isn't working: an admin can test it again in Settings → AI.",
    );
    await testProvider(deps, job, async () => ({
      ok: true,
      available: { "claude-sonnet-5-5": "claude-sonnet-5-5-20260928" },
    }));
    const r = await resolve("claude-sonnet-5-5", DEPLOYMENT, "anthropic", "max");
    expect(r).toMatchObject({ provider: "anthropic", route: "anthropic", keySource: "org", reasoning: "max" });
    // Called by the id its own list gave.
    expect(idOf(r)).toBe("claude-sonnet-5-5-20260928");
    expect(await failure(resolve("claude-opus-5-5", DEPLOYMENT, "anthropic"))).toBe(
      "Anthropic doesn't offer Claude Opus 5.5: ask again with another model.",
    );
  });
});
