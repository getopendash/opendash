// Each kind of provider: its calls go where its own credentials say, with them, never where the
// environment would send them (every fallback each SDK reads is set to a decoy here); its test reads its own list,
// meets it with the allowlist and asks the cheapest model once; a failure says what the provider said, never the key,
// and a refusal counts as refused, a rate limit doesn't; a daily refresh only reads the list; Vertex is asked model by
// model.
import { CATALOG, type Credentials, catalogModel } from "@opendash/core";
import { generateText } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { callOptions, checkProvider, type Endpoint, languageModel } from "../src";

const auths = vi.hoisted((): unknown[] => []);
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      auths.push(options);
    }
    async getAccessToken() {
      return "vertex-token";
    }
    async getClient() {
      return { getAccessToken: async () => ({ token: "vertex-token" }) };
    }
  },
}));

const DECOYS: Record<string, string> = {
  ANTHROPIC_API_KEY: "decoy-anthropic",
  ANTHROPIC_BASE_URL: "https://decoy.example/anthropic",
  OPENAI_API_KEY: "decoy-openai",
  OPENAI_BASE_URL: "https://decoy.example/openai",
  GOOGLE_GENERATIVE_AI_API_KEY: "decoy-google",
  AI_GATEWAY_API_KEY: "decoy-gateway",
  OPENROUTER_API_KEY: "decoy-openrouter",
  AWS_ACCESS_KEY_ID: "AKIADECOYDECOYDECOY0",
  AWS_SECRET_ACCESS_KEY: "decoy-secret-decoy-secret-decoy-secret",
  AWS_SESSION_TOKEN: "decoy-session",
  AWS_BEARER_TOKEN_BEDROCK: "decoy-bedrock-bearer",
  AWS_REGION: "us-west-2",
  AWS_ENDPOINT_URL: "https://decoy.example/aws",
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://decoy.example/bedrock",
  GOOGLE_VERTEX_API_KEY: "decoy-vertex-key",
  GOOGLE_VERTEX_PROJECT: "decoy-project",
  GOOGLE_VERTEX_LOCATION: "us-central1",
  GOOGLE_APPLICATION_CREDENTIALS: "/decoy/credentials.json",
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(DECOYS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Seen = { url: string; headers: Record<string, string>; body: unknown };

/** A fetch that records each request and answers from `reply`. */
function recorder(reply: (url: string) => Response = () => new Response("{}", { status: 401 })) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.body ? await req.text() : null;
    seen.push({
      url: req.url,
      headers: Object.fromEntries(req.headers.entries()),
      body: body ? JSON.parse(body) : null,
    });
    return reply(req.url);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const claudeReply = () =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 1 },
  });

/** One call through a kind's instance; the reply is a refusal, so only the request matters. */
async function oneCall(endpoint: Endpoint, model: string, listedId = model) {
  const { fetch, seen } = recorder();
  const maker = catalogModel(model)?.maker ?? "anthropic";
  await generateText({ model: languageModel(endpoint, maker, listedId, fetch), prompt: "Hi", maxRetries: 0 }).catch(
    () => null,
  );
  return seen[0] as Seen;
}

const KEY = "sk-test-0123456789abcdefghijWXYZ";

describe("a provider's calls", () => {
  it("go to each maker's own API with the key they were given", async () => {
    const a = await oneCall({ route: "anthropic", credentials: { apiKey: KEY } }, "claude-haiku-5-5");
    expect(a.url).toBe("https://api.anthropic.com/v1/messages");
    expect(a.headers["x-api-key"]).toBe(KEY);
    const o = await oneCall({ route: "openai", credentials: { apiKey: KEY } }, "gpt-6-luna");
    expect(new URL(o.url).origin).toBe("https://api.openai.com");
    expect(o.headers.authorization).toBe(`Bearer ${KEY}`);
    const g = await oneCall({ route: "google", credentials: { apiKey: KEY } }, "gemini-3.8-flash");
    expect(g.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(g.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("go through a gateway or OpenRouter with the workspace's key, never the deployment's", async () => {
    const gw = await oneCall(
      { route: "gateway", credentials: { apiKey: KEY } },
      "claude-sonnet-5-5",
      "anthropic/claude-sonnet-5.5",
    );
    expect(gw.url).toBe("https://ai-gateway.vercel.sh/v4/ai/language-model");
    expect(gw.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(gw.headers["ai-language-model-id"]).toBe("anthropic/claude-sonnet-5.5");
    const or = await oneCall(
      { route: "openrouter", credentials: { apiKey: KEY } },
      "gpt-6.1-sol",
      "openai/gpt-6.1-sol",
    );
    expect(or.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(or.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("sign Bedrock's calls with the access key given, in its region, never AWS_*", async () => {
    const b = await oneCall(
      {
        route: "bedrock",
        credentials: {
          region: "eu-central-1",
          accessKeyId: "AKIAGIVENGIVENGIVEN0",
          secretAccessKey: "given-secret-given-secret-given-secret",
        },
      },
      "claude-sonnet-5-5",
      "eu.anthropic.claude-sonnet-5-5-v1:0",
    );
    expect(b.url).toBe(
      "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-5-v1%3A0/invoke",
    );
    expect(b.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAGIVENGIVENGIVEN0\/\d{8}\/eu-central-1\/bedrock\//,
    );
    expect(b.headers["x-amz-security-token"]).toBeUndefined();
    const k = await oneCall(
      { route: "bedrock", credentials: { region: "us-east-1", apiKey: "ABSK-given-bedrock-api-key-0000" } },
      "claude-haiku-5-5",
      "us.anthropic.claude-haiku-5-5-v1:0",
    );
    expect(new URL(k.url).host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(k.headers.authorization).toBe("Bearer ABSK-given-bedrock-api-key-0000");
  });

  it("sign Vertex's calls in with the service account given, in its project and location", async () => {
    auths.length = 0;
    const credentials = {
      project: "acme-analytics",
      location: "europe-west4",
      serviceAccount: { client_email: "opendash@acme-analytics.iam.gserviceaccount.com", private_key: "PRIVATE KEY" },
    };
    const claude = await oneCall({ route: "vertex", credentials }, "claude-haiku-5-5");
    expect(claude.url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/acme-analytics/locations/europe-west4/publishers/anthropic/models/claude-haiku-5-5:rawPredict",
    );
    expect(claude.headers.authorization).toBe("Bearer vertex-token");
    const gemini = await oneCall({ route: "vertex", credentials }, "gemini-3.8-flash");
    expect(new URL(gemini.url).pathname).toBe(
      "/v1beta1/projects/acme-analytics/locations/europe-west4/publishers/google/models/gemini-3.8-flash:generateContent",
    );
    expect(gemini.headers.authorization).toBe("Bearer vertex-token");
    expect(gemini.headers["x-goog-api-key"]).toBeUndefined();
    // Every sign-in had the service account's own key: none fell back to Google's default login.
    expect(auths.length).toBeGreaterThan(0);
    for (const a of auths) {
      expect(a).toMatchObject({
        credentials: { client_email: credentials.serviceAccount.client_email, private_key: "PRIVATE KEY" },
      });
    }
  });

  it("refuse a blank credential before any SDK can look for one", () => {
    expect(() =>
      languageModel({ route: "anthropic", credentials: { apiKey: " " } }, "anthropic", "claude-haiku-5-5", fetch),
    ).toThrow("The API key is missing.");
  });

  it("think through OpenRouter's own options, and ask gateways for providers that don't train on prompts", () => {
    const sonnet = catalogModel("claude-sonnet-5-5") as (typeof CATALOG)[number];
    const gemini = catalogModel("gemini-3.8-flash") as (typeof CATALOG)[number];
    expect(callOptions("openrouter", sonnet, "max")).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: "xhigh" }, provider: { data_collection: "deny" } } },
    });
    expect(callOptions("gateway", gemini, "high")).toEqual({
      reasoning: "high",
      providerOptions: {
        google: { thinkingConfig: { includeThoughts: true } },
        gateway: { disallowPromptTraining: true },
      },
    });
    expect(callOptions("bedrock", sonnet, "low")).toEqual({ reasoning: "low", providerOptions: {} });
  });
});

describe("a provider's test", () => {
  const anthropic: Credentials = { apiKey: KEY };

  it("reads its list, meets it with the allowlist, and asks the cheapest model once", async () => {
    const { fetch, seen } = recorder((url) =>
      url.endsWith("/models?limit=1000")
        ? json({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }, { id: "claude-opus-5" }] })
        : claudeReply(),
    );
    expect(await checkProvider("anthropic", anthropic, { fetch })).toEqual({
      ok: true,
      available: { "claude-sonnet-5-5": "claude-sonnet-5-5", "claude-haiku-5-5": "claude-haiku-5-5" },
    });
    expect(seen.map((r) => r.url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/messages",
    ]);
    expect(seen[1]?.body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16 });
  });

  it("only reads the list on a daily refresh", async () => {
    const { fetch, seen } = recorder(() => json({ data: [{ id: "claude-haiku-5-5" }] }));
    expect(await checkProvider("anthropic", anthropic, { fetch, refresh: true })).toEqual({
      ok: true,
      available: { "claude-haiku-5-5": "claude-haiku-5-5" },
    });
    expect(seen).toHaveLength(1);
  });

  it("says a refused key is refused, and a rate limit or an outage isn't", async () => {
    const refused = recorder(() => json({}, 401));
    expect(await checkProvider("openai", { apiKey: KEY }, { fetch: refused.fetch })).toEqual({
      ok: false,
      message: "OpenAI refused these credentials (401) without saying why.",
      refused: true,
    });
    const limited = recorder((url) =>
      url.endsWith("/models") ? json({ data: [{ id: "gpt-6-luna" }] }) : json({ error: { message: "slow down" } }, 429),
    );
    expect(await checkProvider("openai", { apiKey: KEY }, { fetch: limited.fetch })).toEqual({
      ok: true,
      available: { "gpt-6-luna": "gpt-6-luna" },
    });
    const down = recorder(() => json({ error: { message: "The server is overloaded. Try again later." } }, 503));
    expect(await checkProvider("openai", { apiKey: KEY }, { fetch: down.fetch })).toEqual({
      ok: false,
      message: "OpenAI said (503): The server is overloaded. Try again later.",
      refused: false,
    });
  });

  it("says what the provider said, without the key it echoed", async () => {
    const echoed = recorder(() =>
      json({ error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error" } }, 401),
    );
    const result = await checkProvider("openai", { apiKey: KEY }, { fetch: echoed.fetch });
    expect(result).toEqual({ ok: false, message: "OpenAI said (401): Incorrect API key provided: …", refused: true });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("says why a gateway's free credits can't run a model, and counts it refused", async () => {
    // The gateway's answer as recorded: a 403 it files as an internal error.
    const why =
      "Free tier users do not have access to this model. Upgrade to paid credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up for unrestricted access.";
    const { fetch } = recorder((url) =>
      url.endsWith("/v1/credits")
        ? json({ balance: "4.34", total_used: "0.66" })
        : url.endsWith("/v1/models")
          ? json({ data: [{ id: "anthropic/claude-haiku-5.5" }] })
          : json({ error: { message: why, type: "no_providers_available", param: { statusCode: 403 } } }, 403),
    );
    expect(await checkProvider("gateway", { apiKey: KEY }, { fetch })).toEqual({
      ok: false,
      message: `Vercel AI Gateway said (403): ${why}`,
      refused: true,
    });
  });

  it("says why it couldn't reach a provider", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
    }) as unknown as typeof globalThis.fetch;
    expect(await checkProvider("openai", { apiKey: KEY }, { fetch })).toEqual({
      ok: false,
      message: "Couldn't reach OpenAI: its address didn't resolve (ENOTFOUND).",
      refused: false,
    });
  });

  it("says what's missing when a provider offers none of the allowed models", async () => {
    const { fetch } = recorder(() => json({ models: [{ name: "models/gemini-1.5-flash" }] }));
    expect(await checkProvider("google", { apiKey: KEY }, { fetch })).toEqual({
      ok: false,
      message: "Google Gemini offers none of the models OpenDash allows.",
      refused: false,
    });
  });

  it("checks a gateway key on its credits, and OpenRouter's on its key", async () => {
    const gw = recorder((url) => (url.endsWith("/credits") ? json({}, 401) : json({ data: [] })));
    expect(await checkProvider("gateway", { apiKey: KEY }, { fetch: gw.fetch })).toMatchObject({
      ok: false,
      refused: true,
    });
    expect(gw.seen[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/credits");
    const or = recorder((url) => (url.endsWith("/key") ? json({}, 401) : json({ data: [] })));
    expect(await checkProvider("openrouter", { apiKey: KEY }, { fetch: or.fetch })).toMatchObject({ refused: true });
    expect(or.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("lists Bedrock's inference profiles signed, and says when the user can't list them", async () => {
    const credentials = {
      region: "eu-central-1",
      accessKeyId: "AKIAGIVENGIVENGIVEN0",
      secretAccessKey: "given-secret-given-secret-given-secret",
    };
    const denied = recorder(() =>
      json({ message: "User is not authorized to perform: bedrock:ListInferenceProfiles" }, 403),
    );
    expect(await checkProvider("bedrock", credentials, { fetch: denied.fetch })).toEqual({
      ok: false,
      message:
        "Amazon Bedrock said (403): User is not authorized to perform: bedrock:ListInferenceProfiles. Give this user bedrock:ListInferenceProfiles in eu-central-1.",
      refused: true,
    });
    expect(denied.seen[0]?.url).toMatch(/^https:\/\/bedrock\.eu-central-1\.amazonaws\.com\/inference-profiles\?/);
    expect(denied.seen[0]?.headers.authorization).toMatch(/Credential=AKIAGIVENGIVENGIVEN0\//);
    const listed = recorder((url) =>
      url.includes("/inference-profiles")
        ? json({
            inferenceProfileSummaries: [
              { inferenceProfileId: "eu.anthropic.claude-haiku-5-5-v1:0" },
              { inferenceProfileId: "global.anthropic.claude-haiku-5-5-v1:0" },
            ],
          })
        : claudeReply(),
    );
    expect(await checkProvider("bedrock", credentials, { fetch: listed.fetch })).toEqual({
      ok: true,
      available: { "claude-haiku-5-5": "eu.anthropic.claude-haiku-5-5-v1:0" },
    });
  });

  it("asks Vertex each allowed model once, and keeps those that answer", async () => {
    const { fetch, seen } = recorder((url) => (url.includes("claude-haiku-5-5") ? claudeReply() : json({}, 404)));
    const result = await checkProvider(
      "vertex",
      {
        project: "acme-analytics",
        location: "europe-west4",
        serviceAccount: { client_email: "opendash@acme-analytics.iam.gserviceaccount.com", private_key: "PRIVATE KEY" },
      },
      { fetch },
    );
    expect(result).toEqual({ ok: true, available: { "claude-haiku-5-5": "claude-haiku-5-5" } });
    // Claude's and Gemini's allowlisted models, each once.
    expect(seen).toHaveLength(CATALOG.filter((m) => m.maker !== "openai").length);
  });
});
