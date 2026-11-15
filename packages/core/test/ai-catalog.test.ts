// The allowlist, the kinds of provider and a provider's list met with the allowlist: only
// allowlisted models are found, each by the id its provider lists it under, never a near name; every thinking level
// sends what the SDK takes for that model, and Auto what it was measured on; credentials are checked once, with every
// field a kind needs, and Settings shows only enough of them to tell which they are.
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  catalogModel,
  checkCredentials,
  defaultLevelOf,
  effortOf,
  KINDS,
  levelFor,
  levelsOf,
  matchListed,
  parseListed,
  probeIds,
  shownOf,
} from "../src";

// Trimmed from the public lists (https://ai-gateway.vercel.sh/v1/models and https://openrouter.ai/api/v1/models,
// read 2026-10-20): the allowlisted ids and the near names around them.
const GATEWAY = [
  "anthropic/claude-fable-5",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-fable-5.1-batch",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-fast",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-opus-5.5-fast",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5.5-batch",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-batch",
  "google/gemini-3.8-flash",
  "google/gemini-3.8-flash-tts",
  "openai/gpt-6-luna",
  "openai/gpt-6-luna-fast",
  "openai/gpt-6-sol",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-sol-batch",
  "meta/llama-5-405b",
];
const OPENROUTER = [
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-haiku-5.5:batch",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-sol-pro",
  "google/gemini-3.8-flash",
  "google/gemini-3.7-flash",
  "someone/claude-sonnet-5.5",
];

describe("the allowlist", () => {
  it("prices each model it can, and each starts at its maker's default level", () => {
    for (const m of CATALOG) {
      if (m.price) expect(m.price.input > 0 && m.price.output > 0).toBe(true);
    }
    // Claude: effort high is what omitting it does; adaptive thinking comes with it.
    expect(defaultLevelOf("claude-sonnet-5-5")).toBe("high");
    expect(defaultLevelOf("gpt-6.1-sol")).toBe("medium");
    expect(defaultLevelOf("gemini-3.8-flash")).toBe("high");
    // A level is sent as itself; one a model doesn't take is its default.
    expect(effortOf("claude-sonnet-5-5", "xhigh")).toBe("xhigh");
    expect(effortOf("gemini-3.8-flash", "medium")).toBe("low");
  });

  it("names each model on the gateway as its public list does", () => {
    for (const m of CATALOG) expect(GATEWAY).toContain(m.gateway);
    expect(
      matchListed(
        "gateway",
        CATALOG.map((m) => m.gateway),
      ),
    ).toEqual(Object.fromEntries(CATALOG.map((m) => [m.id, m.gateway])));
  });

  it("offers each model only its own levels, and a level it doesn't take is the nearest it does", () => {
    expect(levelsOf("claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(levelsOf("gemini-3.1-pro-preview")).toEqual(["low", "high"]);
    expect(levelFor("gemini-3.1-pro-preview", "xhigh")).toBe("high");
    expect(levelFor("gpt-6.1-sol", "xhigh")).toBe("high");
    expect(levelFor("gemini-3.1-pro-preview", "medium")).toBe("low");
    expect(levelFor("claude-haiku-5-5", "xhigh")).toBe("xhigh");
    expect(levelFor("claude-haiku-5-5", "loud")).toBe("high");
    expect(levelFor("gpt-6.1-sol", undefined)).toBe("medium");
    expect(effortOf("gemini-3.1-pro-preview", "max")).toBe("high");
  });
});

describe("a provider's list met with the allowlist", () => {
  it("finds every allowlisted model on the gateway by its listed id, and nothing near it", () => {
    expect(matchListed("gateway", GATEWAY)).toEqual({
      "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
      "claude-opus-5-5": "anthropic/claude-opus-5.5",
      "claude-haiku-5-5": "anthropic/claude-haiku-5.5",
      "claude-fable-5-1": "anthropic/claude-fable-5.1",
      "gpt-6.1-sol": "openai/gpt-6.1-sol",
      "gpt-6-luna": "openai/gpt-6-luna",
      "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
      "gemini-3.8-flash": "google/gemini-3.8-flash",
    });
  });

  it("takes no variant (:batch, -pro) and no one else's model with the same name", () => {
    expect(matchListed("openrouter", OPENROUTER)).toEqual({
      "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
      "claude-haiku-5-5": "anthropic/claude-haiku-5.5",
      "gpt-6.1-sol": "openai/gpt-6.1-sol",
      "gemini-3.8-flash": "google/gemini-3.8-flash",
    });
  });

  it("matches each listed id to at most one allowlisted model", () => {
    for (const id of [...GATEWAY, ...OPENROUTER]) {
      expect(Object.keys(matchListed("gateway", [id])).length).toBeLessThanOrEqual(1);
    }
    expect(matchListed("gateway", ["anthropic/claude-opus-5"])).toEqual({});
  });

  it("keeps a maker's own key to its own models, and its dated ids to the plain one", () => {
    expect(
      matchListed("anthropic", ["claude-sonnet-5-5-20260928", "claude-sonnet-5-5", "claude-haiku-5-5-20260928"]),
    ).toEqual({ "claude-sonnet-5-5": "claude-sonnet-5-5", "claude-haiku-5-5": "claude-haiku-5-5-20260928" });
    expect(matchListed("google", ["models/gemini-3.8-flash", "models/gemini-3.1-pro-preview"])).toEqual({
      "gemini-3.1-pro-preview": "models/gemini-3.1-pro-preview",
      "gemini-3.8-flash": "models/gemini-3.8-flash",
    });
    // An OpenAI key lists no Claude model, and a Claude id under it isn't one it can run.
    expect(matchListed("openai", ["gpt-6.1-sol", "claude-sonnet-5-5"])).toEqual({ "gpt-6.1-sol": "gpt-6.1-sol" });
  });

  it("prefers a Bedrock profile in the region's geography, then a global one", () => {
    expect(
      matchListed("bedrock", [
        "global.anthropic.claude-sonnet-5-5-v1:0",
        "eu.anthropic.claude-sonnet-5-5-v1:0",
        "global.anthropic.claude-opus-5-5-v1:0",
        "eu.anthropic.claude-opus-5-v1:0",
        "eu.meta.llama-5-v1:0",
      ]),
    ).toEqual({
      "claude-sonnet-5-5": "eu.anthropic.claude-sonnet-5-5-v1:0",
      "claude-opus-5-5": "global.anthropic.claude-opus-5-5-v1:0",
    });
    expect(parseListed("us.anthropic.claude-haiku-5-5-v1:0")).toEqual({
      maker: "anthropic",
      name: "claude-haiku-5-5",
      geography: "us",
    });
  });

  it("probes Vertex with the Claude and Gemini models, by their own ids", () => {
    expect(Object.keys(probeIds("vertex")).sort()).toEqual(
      CATALOG.filter((m) => m.maker !== "openai")
        .map((m) => m.id)
        .sort(),
    );
    expect(KINDS.bedrock.serves).toEqual(["anthropic"]);
  });
});

describe("a connection's credentials", () => {
  it("takes an API key whole, and refuses a blank or spaced one", () => {
    expect(checkCredentials("gateway", { apiKey: "  vck_0123456789abcdefghijklmnop  " })).toEqual({
      ok: true,
      credentials: { apiKey: "vck_0123456789abcdefghijklmnop" },
    });
    expect(checkCredentials("anthropic", { apiKey: "" })).toMatchObject({ ok: false });
    expect(checkCredentials("openai", { apiKey: "sk-proj 0123456789 abcdefghij" })).toMatchObject({ ok: false });
  });

  it("needs Bedrock's region and an access key with its secret, or a Bedrock API key", () => {
    const keys = { region: "eu-central-1", accessKeyId: "AKIAEXAMPLE000000000", secretAccessKey: "x".repeat(40) };
    expect(checkCredentials("bedrock", keys)).toMatchObject({ ok: true });
    expect(checkCredentials("bedrock", { ...keys, sessionToken: "" })).toEqual({ ok: true, credentials: keys });
    expect(checkCredentials("bedrock", { region: "eu-central-1" })).toEqual({
      ok: false,
      message: "Enter an access key ID and secret, or a Bedrock API key.",
    });
    expect(checkCredentials("bedrock", { ...keys, secretAccessKey: "" })).toMatchObject({ ok: false });
    expect(checkCredentials("bedrock", { ...keys, region: "cn-north-1" })).toMatchObject({ ok: false });
    expect(
      checkCredentials("bedrock", { region: "us-east-1", apiKey: "ABSKQmVkcm9ja0FQSUtleS0xMjM0NTY3ODkw" }),
    ).toMatchObject({ ok: true });
  });

  it("keeps only the service account's email and key from Vertex's JSON file", () => {
    const file = JSON.stringify({
      type: "service_account",
      project_id: "acme-analytics",
      private_key_id: "abc",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
      client_email: "opendash@acme-analytics.iam.gserviceaccount.com",
    });
    const checked = checkCredentials("vertex", {
      project: "acme-analytics",
      location: "europe-west4",
      serviceAccount: file,
    });
    expect(checked).toEqual({
      ok: true,
      credentials: {
        project: "acme-analytics",
        location: "europe-west4",
        serviceAccount: {
          client_email: "opendash@acme-analytics.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
        },
      },
    });
    expect(
      checkCredentials("vertex", { project: "acme-analytics", location: "europe-west4", serviceAccount: "{}" }),
    ).toEqual({ ok: false, message: "Paste the service account's JSON key file, as Google gave it." });
    if (checked.ok) {
      expect(shownOf("vertex", checked.credentials)).toEqual({
        project: "acme-analytics",
        location: "europe-west4",
        account: "opendash@acme-analytics.iam.gserviceaccount.com",
      });
    }
  });

  it("shows a key's ending and nothing more", () => {
    expect(shownOf("openrouter", { apiKey: "sk-or-v1-0123456789abcdefWXYZ" })).toEqual({ key: "…WXYZ" });
    expect(
      shownOf("bedrock", { region: "eu-central-1", accessKeyId: "AKIAEXAMPLE00007Q2F", secretAccessKey: "s" }),
    ).toEqual({ region: "eu-central-1", key: "…7Q2F" });
    expect(catalogModel("claude-sonnet-5-5")?.maker).toBe("anthropic");
  });
});
