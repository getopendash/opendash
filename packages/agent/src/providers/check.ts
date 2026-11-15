/**
 * A provider's test (the worker's `ai_provider.test`): it reads what the provider can run from its own
 * list, meets that with the allowlist, and asks the cheapest model it found one tiny question, so a key with no
 * credit or no access to its models fails here and not on someone's question. Vertex AI has no list that says what a
 * project can run, so each allowlisted model is asked instead, a few at a time. A daily refresh only reads the list.
 *
 * A failure says what the provider said, in its own words and with its status (said.ts), with the credentials and
 * anything shaped like a key taken out; our words are used only when it gave none, or never answered. A refusal (401,
 * 402, 403) counts as refused, and the provider stops working; a provider that can't be reached, or is only rate
 * limited, doesn't.
 */
import {
  type Available,
  type BedrockCredentials,
  BUDGETS,
  CATALOG,
  type Credentials,
  catalogModel,
  KINDS,
  type Maker,
  matchListed,
  type ProviderKind,
  type ProviderTestResult,
  probeIds,
  testModelOf,
} from "@opendash/core";
import { APICallError, generateText } from "ai";
import { AwsClient } from "aws4fetch";
import { ENDPOINTS, type Endpoint, languageModel, type Route, workspaceEndpoint } from "./build";
import { readFailure, redact, toldBy, wordsIn } from "./said";

/** A list the provider answered with an error, saying what it said; refused when it turned the credentials down. */
class Turned extends Error {
  constructor(
    readonly refused: boolean,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof globalThis.fetch;

const GATEWAY_API = "https://ai-gateway.vercel.sh/v1";

/** The statuses that mean the provider won't serve these credentials: a bad key, no credit, or not allowed. */
const REFUSING = new Set([401, 402, 403]);

/** The values of the credentials tested, which never go into a message. */
function secretsOf(endpoint: Endpoint): string[] {
  switch (endpoint.route) {
    case "bedrock": {
      const c = endpoint.credentials;
      return "apiKey" in c ? [c.apiKey] : [c.accessKeyId, c.secretAccessKey, c.sessionToken ?? ""];
    }
    case "vertex":
      return [endpoint.credentials.serviceAccount.private_key];
    default:
      return [endpoint.credentials.apiKey];
  }
}

/** What an error response said, as a failure for a person. */
async function turned(res: Response, label: string, secrets: readonly string[], hint = ""): Promise<Turned> {
  const words = wordsIn(await res.text().catch(() => ""));
  const told = toldBy(label, { status: res.status, words: words ? redact(words, secrets) : null });
  return new Turned(REFUSING.has(res.status), hint ? `${told} ${hint}` : told);
}

async function getJson(fetch: Fetch, url: string, init: RequestInit, label: string, secrets: readonly string[]) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(BUDGETS.aiProviderTest.listMs) });
  if (!res.ok) throw await turned(res, label, secrets);
  return res.json().catch(() => {
    throw new Turned(false, `${label} answered with a list OpenDash couldn't read.`);
  }) as Promise<unknown>;
}

const ids = (rows: unknown, key: string): string[] =>
  Array.isArray(rows) ? rows.flatMap((r) => (typeof r?.[key] === "string" ? [r[key] as string] : [])) : [];

/** The model ids a provider lists for these credentials. */
export async function listModels(endpoint: Endpoint, fetch: Fetch = globalThis.fetch): Promise<string[]> {
  const label = KINDS[endpoint.route].label;
  const secrets = secretsOf(endpoint);
  switch (endpoint.route) {
    case "anthropic": {
      const body = (await getJson(
        fetch,
        `${ENDPOINTS.anthropic}/models?limit=1000`,
        { headers: { "x-api-key": endpoint.credentials.apiKey, "anthropic-version": "2023-06-01" } },
        label,
        secrets,
      )) as { data?: unknown };
      return ids(body.data, "id");
    }
    case "openai": {
      const body = (await getJson(
        fetch,
        `${ENDPOINTS.openai}/models`,
        { headers: { authorization: `Bearer ${endpoint.credentials.apiKey}` } },
        label,
        secrets,
      )) as { data?: unknown };
      return ids(body.data, "id");
    }
    case "google": {
      const out: string[] = [];
      let page = "";
      for (let i = 0; i < 5; i++) {
        const body = (await getJson(
          fetch,
          `${ENDPOINTS.google}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
          { headers: { "x-goog-api-key": endpoint.credentials.apiKey } },
          label,
          secrets,
        )) as { models?: unknown; nextPageToken?: string };
        out.push(...ids(body.models, "name"));
        if (!body.nextPageToken) break;
        page = body.nextPageToken;
      }
      return out;
    }
    case "gateway": {
      // Its credits need the key, so a revoked key is refused here; its models list is the same for everyone.
      const auth = { headers: { authorization: `Bearer ${endpoint.credentials.apiKey}` } };
      await getJson(fetch, `${GATEWAY_API}/credits`, auth, label, secrets);
      const body = (await getJson(fetch, `${GATEWAY_API}/models`, auth, label, secrets)) as { data?: unknown };
      return ids(body.data, "id");
    }
    case "openrouter": {
      const auth = { headers: { authorization: `Bearer ${endpoint.credentials.apiKey}` } };
      await getJson(fetch, `${ENDPOINTS.openrouter}/key`, auth, label, secrets);
      const body = (await getJson(fetch, `${ENDPOINTS.openrouter}/models`, auth, label, secrets)) as { data?: unknown };
      return ids(body.data, "id");
    }
    case "bedrock":
      return bedrockProfiles(endpoint.credentials, fetch, secrets);
    case "vertex":
      return [];
  }
}

/** The inference profiles Bedrock offers in the region (needs bedrock:ListInferenceProfiles). */
async function bedrockProfiles(c: BedrockCredentials, fetch: Fetch, secrets: readonly string[]): Promise<string[]> {
  const label = KINDS.bedrock.label;
  const out: string[] = [];
  const base = `https://bedrock.${c.region}.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000`;
  const aws =
    "apiKey" in c
      ? null
      : new AwsClient({
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
          region: c.region,
          service: "bedrock",
        });
  let next = "";
  for (let i = 0; i < 5; i++) {
    const url = `${base}${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`;
    const signal = AbortSignal.timeout(BUDGETS.aiProviderTest.listMs);
    const res = aws
      ? await fetch(await aws.sign(url, { method: "GET" }).then((r) => new Request(r, { signal })))
      : await fetch(url, { headers: { authorization: `Bearer ${"apiKey" in c ? c.apiKey : ""}` }, signal });
    if (!res.ok) {
      const words = wordsIn(await res.text().catch(() => ""));
      const told = toldBy(label, { status: res.status, words: words ? redact(words, secrets) : null });
      // Signed in, but not allowed to list: which permission to add.
      const listing = REFUSING.has(res.status) && /not authorized|accessdenied/i.test(words ?? "");
      throw new Turned(
        REFUSING.has(res.status),
        listing ? `${told} Give this user bedrock:ListInferenceProfiles in ${c.region}.` : told,
      );
    }
    const body = (await res.json().catch(() => {
      throw new Turned(false, `${label} answered with a list OpenDash couldn't read.`);
    })) as { inferenceProfileSummaries?: unknown; nextToken?: string };
    out.push(...ids(body.inferenceProfileSummaries, "inferenceProfileId"));
    if (!body.nextToken) break;
    next = body.nextToken;
  }
  return out;
}

/**
 * What a failed call says, for a person, and whether the provider refused the credentials. The status decides that,
 * not the error's class: the gateway files a refusal it has no class for (free credits that don't cover a model, 403)
 * as an internal error.
 */
export function callFailure(
  label: string,
  error: unknown,
  secrets: readonly string[] = [],
): { ok: true } | { ok: false; message: string; refused: boolean } {
  const said = readFailure(error, secrets, BUDGETS.aiProviderTest.callMs);
  const name = (error as { name?: string })?.name ?? "";
  if (said.status === 429 || name === "GatewayRateLimitError") return { ok: true };
  const refused =
    (said.status !== undefined && REFUSING.has(said.status)) ||
    name === "GatewayAuthenticationError" ||
    name === "GatewayInsufficientFundsError";
  return { ok: false, message: toldBy(label, said), refused };
}

/** One tiny question to a model, with no retries, no thinking to speak of, and nothing recorded of it. */
async function tinyCall(endpoint: Endpoint, maker: Maker, listedId: string, fetch: Fetch): Promise<void> {
  await generateText({
    model: languageModel(endpoint, maker, listedId, fetch),
    prompt: "Reply with the word OK.",
    maxOutputTokens: 16,
    maxRetries: 0,
    reasoning: "low",
    abortSignal: AbortSignal.timeout(BUDGETS.aiProviderTest.callMs),
    telemetry: { functionId: "opendash.provider_test", recordInputs: false, recordOutputs: false },
  });
}

/** The cheapest model it found, the one the call is made with: Claude's first, then the others'. */
function cheapest(available: Available): { maker: Maker; id: string } | null {
  for (const maker of ["anthropic", "openai", "google"] as const) {
    const m = testModelOf(maker, Object.keys(available));
    if (m) return { maker, id: m.id };
  }
  return null;
}

/** Vertex: each allowlisted Claude and Gemini model asked once, a few at a time; those that answer are its models. */
async function probe(endpoint: Endpoint, location: string, fetch: Fetch): Promise<ProviderTestResult> {
  const label = KINDS.vertex.label;
  const tries = Object.entries(probeIds("vertex"));
  const found: Available = {};
  const seen: { refusal: string | null; other: string | null } = { refusal: null, other: null };
  for (let i = 0; i < tries.length; i += BUDGETS.aiProviderTest.probeConcurrency) {
    await Promise.all(
      tries.slice(i, i + BUDGETS.aiProviderTest.probeConcurrency).map(async ([id, listed]) => {
        const maker = catalogModel(id)?.maker as Maker;
        try {
          await tinyCall(endpoint, maker, listed, fetch);
          found[id] = listed;
        } catch (error) {
          const f = callFailure(label, error, secretsOf(endpoint));
          if (f.ok) found[id] = listed;
          else if (f.refused) seen.refusal = f.message;
          // A model this project hasn't turned on, or that isn't in this location, isn't one of its models.
          else if (!APICallError.isInstance(error) || error.statusCode !== 404) seen.other = f.message;
        }
      }),
    );
  }
  const available = Object.fromEntries(CATALOG.filter((m) => m.id in found).map((m) => [m.id, found[m.id] as string]));
  if (Object.keys(available).length) return { ok: true, available };
  if (seen.refusal) return { ok: false, message: seen.refusal, refused: true };
  return {
    ok: false,
    message:
      seen.other ??
      `None of the models OpenDash allows answered in ${location}: turn Claude or Gemini on in the project's Model Garden.`,
    refused: false,
  };
}

/**
 * The worker's `ai_provider.test` for a workspace's provider: its list met with the allowlist, then one tiny call
 * (none on a refresh). Never throws: a failure is a result.
 */
export async function checkProvider(
  kind: ProviderKind,
  credentials: Credentials,
  options: { refresh?: boolean; fetch?: Fetch } = {},
): Promise<ProviderTestResult> {
  if (kind === "opendash") return { ok: false, message: "OpenDash isn't tested here.", refused: false };
  const fetch = options.fetch ?? globalThis.fetch;
  const label = KINDS[kind].label;
  let endpoint: Endpoint;
  try {
    endpoint = workspaceEndpoint(kind as Route, credentials);
  } catch {
    return { ok: false, message: "Some of its settings are missing. Save them again.", refused: true };
  }
  if (endpoint.route === "vertex") return probe(endpoint, endpoint.credentials.location, fetch);
  let available: Available;
  try {
    available = matchListed(kind, await listModels(endpoint, fetch));
  } catch (error) {
    if (error instanceof Turned) return { ok: false, message: error.message, refused: error.refused };
    // It never answered: why, as far as the error says.
    const said = readFailure(error, secretsOf(endpoint), BUDGETS.aiProviderTest.listMs);
    return { ok: false, message: toldBy(label, said), refused: false };
  }
  if (!Object.keys(available).length) {
    const where = kind === "bedrock" ? ` in ${(credentials as BedrockCredentials).region}` : "";
    return { ok: false, message: `${label} offers none of the models OpenDash allows${where}.`, refused: false };
  }
  if (options.refresh) return { ok: true, available };
  const test = cheapest(available) as { maker: Maker; id: string };
  try {
    await tinyCall(endpoint, test.maker, available[test.id] as string, fetch);
  } catch (error) {
    const f = callFailure(label, error, secretsOf(endpoint));
    if (!f.ok) return f;
  }
  return { ok: true, available };
}
