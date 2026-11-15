/**
 * A provider instance per kind, built per run from a workspace's credentials (opened in the worker
 * only) or the deployment's own keys. Every credential and endpoint is passed explicitly: none of these SDKs may fall
 * back to the environment for a workspace's call (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, AI_GATEWAY_API_KEY,
 * OPENROUTER_API_KEY, AWS_*, GOOGLE_VERTEX_*, or Google's default login). A model is called by the id its provider
 * listed it under; the run keeps the allowlist's.
 *
 * Claude on Bedrock goes through Bedrock's Anthropic Messages endpoint, and on Vertex through Vertex's: prompt cache
 * points and thinking work as they do on Anthropic's own API (the `anthropic` options). Thinking is the AI SDK's
 * top-level `reasoning` everywhere but OpenRouter, whose provider reads only its own options.
 */
import { createBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  type BedrockCredentials,
  BUDGETS,
  type CatalogModel,
  type Credentials,
  DEPLOYMENT_ENV,
  type Effort,
  type Maker,
  type ProviderKind,
  type VertexCredentials,
} from "@opendash/core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGateway, type LanguageModel } from "ai";
import { GoogleAuth } from "google-auth-library";

/** How a call goes: a maker's own API, a gateway, or a cloud. OpenDash's own calls take a gateway or a maker's API. */
export type Route = Exclude<ProviderKind, "opendash">;

/** Where a run's model comes from: its route, and the credentials for it. */
export type Endpoint =
  | { route: "anthropic" | "openai" | "google" | "gateway" | "openrouter"; credentials: { apiKey: string } }
  | { route: "bedrock"; credentials: BedrockCredentials }
  | { route: "vertex"; credentials: VertexCredentials };

export const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  gateway: "https://ai-gateway.vercel.sh/v4/ai",
  openrouter: "https://openrouter.ai/api/v1",
  bedrockRuntime: (region: string) => `https://bedrock-runtime.${region}.amazonaws.com`,
} as const;

/** A missing credential is refused here, before any SDK can look for one in the environment. */
function required(value: string | undefined, what: string): string {
  const v = value?.trim();
  if (!v) throw new Error(`${what} is missing.`);
  return v;
}

/** A Vertex access token from the service account's own key (never Google's default login), within its time. */
export function vertexToken(credentials: VertexCredentials): () => Promise<string> {
  const auth = new GoogleAuth({
    credentials: {
      client_email: required(credentials.serviceAccount.client_email, "The service account's email"),
      private_key: required(credentials.serviceAccount.private_key, "The service account's key"),
    },
    projectId: credentials.project,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Google didn't sign the service account in.")),
        BUDGETS.aiProviderTest.listMs,
      );
    });
    try {
      const token = await Promise.race([auth.getAccessToken(), late]);
      if (!token) throw new Error("Google didn't sign the service account in.");
      return token;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A route's instance for one model, called by its listed id. */
export function languageModel(
  endpoint: Endpoint,
  maker: Maker,
  listedId: string,
  fetch: typeof globalThis.fetch,
): LanguageModel {
  switch (endpoint.route) {
    case "anthropic":
      return createAnthropic({
        apiKey: required(endpoint.credentials.apiKey, "The API key"),
        baseURL: ENDPOINTS.anthropic,
        fetch,
      })(listedId);
    case "openai":
      return createOpenAI({
        apiKey: required(endpoint.credentials.apiKey, "The API key"),
        baseURL: ENDPOINTS.openai,
        fetch,
      })(listedId);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: required(endpoint.credentials.apiKey, "The API key"),
        baseURL: ENDPOINTS.google,
        fetch,
      })(listedId);
    case "gateway":
      return createGateway({
        apiKey: required(endpoint.credentials.apiKey, "The API key"),
        baseURL: ENDPOINTS.gateway,
        fetch,
      })(listedId);
    case "openrouter":
      return createOpenRouter({
        apiKey: required(endpoint.credentials.apiKey, "The API key"),
        baseURL: ENDPOINTS.openrouter,
        fetch,
      }).chat(listedId);
    case "bedrock": {
      const c = endpoint.credentials;
      const region = required(c.region, "The region");
      // A Bedrock API key, or the access key given and nothing else: the SDK would add AWS_SESSION_TOKEN to an access
      // key passed alone, and read AWS_BEARER_TOKEN_BEDROCK unless told there's no API key (an empty one).
      const auth =
        "apiKey" in c
          ? { apiKey: required(c.apiKey, "The Bedrock API key") }
          : (() => {
              const credentials = {
                accessKeyId: required(c.accessKeyId, "The access key ID"),
                secretAccessKey: required(c.secretAccessKey, "The secret access key"),
                ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
              };
              return { apiKey: "", credentialProvider: async () => credentials };
            })();
      return createBedrockAnthropic({ ...auth, region, baseURL: ENDPOINTS.bedrockRuntime(region), fetch })(listedId);
    }
    case "vertex": {
      const c = endpoint.credentials;
      const project = required(c.project, "The project");
      const location = required(c.location, "The location");
      if (maker === "anthropic") {
        return createVertexAnthropic({ project, location, generateAuthToken: vertexToken(c), fetch })(listedId);
      }
      // An empty API key keeps Vertex off its express mode (GOOGLE_VERTEX_API_KEY); the service account signs in.
      return createVertex({
        apiKey: "",
        project,
        location,
        googleAuthOptions: {
          credentials: { client_email: c.serviceAccount.client_email, private_key: c.serviceAccount.private_key },
          projectId: project,
        },
        fetch,
      })(listedId);
    }
  }
}

/** OpenRouter takes reasoning effort up to xhigh. */
const OPENROUTER_EFFORT: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/**
 * What a call on a route sends besides the conversation: how long it thinks, Gemini's thought summaries, and, through
 * a gateway or OpenRouter, providers that don't train on prompts only.
 */
export function callOptions(
  route: Route,
  model: CatalogModel,
  effort: Effort,
): { reasoning?: Effort; providerOptions: Record<string, Record<string, unknown>> } {
  const thoughts: Record<string, Record<string, unknown>> = model.maker === "google"
    ? { google: { thinkingConfig: { includeThoughts: true } } }
    : {};
  if (route === "openrouter") {
    return {
      providerOptions: {
        openrouter: { reasoning: { effort: OPENROUTER_EFFORT[effort] }, provider: { data_collection: "deny" } },
      },
    };
  }
  if (route === "gateway") {
    return { reasoning: effort, providerOptions: { ...thoughts, gateway: { disallowPromptTraining: true } } };
  }
  return { reasoning: effort, providerOptions: thoughts };
}

/** OpenDash's own endpoint for a maker's model: the deployment's gateway when it has one, else that maker's key. */
export function deploymentEndpoint(maker: Maker, env: NodeJS.ProcessEnv): Endpoint | null {
  const gateway = env[DEPLOYMENT_ENV.gateway]?.trim();
  if (gateway) return { route: "gateway", credentials: { apiKey: gateway } };
  const key = env[DEPLOYMENT_ENV[maker]]?.trim();
  return key ? { route: maker, credentials: { apiKey: key } } : null;
}

/** A workspace provider's endpoint, from its opened credentials. */
export function workspaceEndpoint(kind: Route, credentials: Credentials): Endpoint {
  if (kind === "bedrock") return { route: kind, credentials: credentials as BedrockCredentials };
  if (kind === "vertex") return { route: kind, credentials: credentials as VertexCredentials };
  return { route: kind, credentials: credentials as { apiKey: string } };
}
