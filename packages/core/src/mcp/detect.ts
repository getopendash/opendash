/**
 * Finding out how a server signs people in, before an admin approves it. The admin
 * pastes an address; OpenDash asks the server to start an MCP session without signing in, and reads the answer:
 *   - it answers: it needs no sign-in (and its tools are listed straight away);
 *   - 401 with OAuth metadata (a protected-resource document, or an authorization server at its origin): it signs in
 *     with OAuth. OpenDash then says whether it can register itself there (dynamic registration, or a client metadata
 *     document) or needs a client an admin makes at the service;
 *   - 401 or 403 without any: it takes an API key;
 *   - it doesn't take a Streamable HTTP request (404, 405, …): the older HTTP with server-sent events is tried, and
 *     read the same way.
 * Everything goes through the guarded fetch, within one budget, and nothing is stored: approving is a separate step.
 */
import {
  Client,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/client";
import { BUDGETS } from "../budgets";
import { transportFor } from "./executor";
import { checkAddress, type McpFetch, McpNetworkError } from "./fetch";
import { fetchFor, isAdmin, type McpActor, type McpDeps, McpProblem, requireEnabled } from "./shared";

export type DetectedAuth =
  /** It answered without a sign-in. `tools`: how many it lists (null when listing them failed). */
  | { kind: "none"; tools: number | null }
  | {
      kind: "oauth";
      /** The authorization server, as its metadata names itself. */
      issuer: string | null;
      /**
       * How OpenDash gets a client there: it registers itself (`dynamic`), its client metadata document is the client
       * ID (`metadata_document`), or an admin enters a client they made at the service (`needs_client`).
       */
      registration: "dynamic" | "metadata_document" | "needs_client";
      /** The scopes the server or its authorization server offers. */
      scopes: string[];
    }
  /** It refused a request without credentials and offered no OAuth. `scheme`: what WWW-Authenticate named, if any. */
  | { kind: "apikey"; status: 401 | 403; scheme: string | null };

export interface Detection {
  /** The address as OpenDash will store it. */
  url: string;
  host: string;
  transport: "streamable" | "sse";
  /** What the server calls itself, when it answered an MCP request (a server that needs a sign-in doesn't). */
  server: { name: string; version: string | null } | null;
  auth: DetectedAuth;
}

/** Statuses that mean "not a Streamable HTTP endpoint", so the older transport is worth trying. */
const NOT_STREAMABLE = new Set([400, 404, 405, 406, 415]);

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "OpenDash", version: "1.0.0" },
    },
  });
}

/** The first word of WWW-Authenticate (Bearer, Basic, …), if the server sent one. */
function schemeOf(response: Response): string | null {
  const header = response.headers.get("www-authenticate")?.trim();
  const scheme = header?.split(/\s+/)[0];
  return scheme && /^[A-Za-z][A-Za-z0-9._~+-]{0,31}$/.test(scheme) ? scheme : null;
}

/** OAuth when the server or its origin publishes the metadata; else an API key. */
async function classify(
  deps: McpDeps,
  fetch: McpFetch,
  url: URL,
  response: Response,
  status: 401 | 403,
): Promise<DetectedAuth> {
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  await response.body?.cancel().catch(() => {});
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>> | undefined;
  try {
    info = await discoverOAuthServerInfo(url, { resourceMetadataUrl, fetchFn: fetch });
  } catch (error) {
    if (error instanceof McpNetworkError && error.refused) {
      throw new McpProblem("refused", `OpenDash doesn't connect to where ${url.host} signs in: ${error.message}.`);
    }
    info = undefined;
  }
  const metadata = info?.authorizationServerMetadata;
  if (!metadata) return { kind: "apikey", status, scheme: schemeOf(response) };
  const registration = metadata.registration_endpoint
    ? "dynamic"
    : metadata.client_id_metadata_document_supported === true && deps.clientMetadataUrl
      ? "metadata_document"
      : "needs_client";
  const scopes = info?.resourceMetadata?.scopes_supported ?? metadata.scopes_supported ?? [];
  return {
    kind: "oauth",
    issuer: typeof metadata.issuer === "string" ? metadata.issuer : null,
    registration,
    scopes: scopes.filter((s): s is string => typeof s === "string").slice(0, 50),
  };
}

/** Ends the session a probe may have opened (best effort). */
async function closeProbe(fetch: McpFetch, url: URL, response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
  const session = response.headers.get("mcp-session-id");
  if (!session) return;
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": session } })
    .then((r) => r.body?.cancel())
    .catch(() => {});
}

/**
 * What the server calls itself and how many tools it lists, for a server that answered without a sign-in. A server can
 * still refuse after that (a public event stream whose message endpoint wants a sign-in): the refusal is kept, to be
 * read like any other.
 */
async function describe(
  deps: McpDeps,
  fetch: McpFetch,
  deadline: AbortSignal,
  url: URL,
  transport: "streamable" | "sse",
): Promise<{ server: Detection["server"]; tools: number | null; refusal: Response | null }> {
  let refusal: Response | null = null;
  const watched: McpFetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!refusal && (response.status === 401 || response.status === 403)) refusal = response.clone();
    return response;
  };
  const client = new Client({ name: deps.clientName ?? "OpenDash", version: "1.0.0" });
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(BUDGETS.mcp.listMs)]);
  const options = { signal, timeout: BUDGETS.mcp.listMs };
  try {
    await client.connect(transportFor(deps, { url: url.href, transport }, { fetch: watched }), options);
    const version = client.getServerVersion();
    const server = version?.name ? { name: version.name.slice(0, 120), version: version.version ?? null } : null;
    let tools = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, options);
      tools += result.tools.length;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { server, tools, refusal: null };
  } catch {
    return { server: null, tools: null, refusal };
  } finally {
    await client.close().catch(() => {});
  }
}

/** A server that answered, described; or, when describing it ran into a refusal, the sign-in that refusal asks for. */
async function answered(
  deps: McpDeps,
  fetch: McpFetch,
  deadline: AbortSignal,
  url: URL,
  transport: "streamable" | "sse",
): Promise<Detection> {
  const described = await describe(deps, fetch, deadline, url, transport);
  const base = { url: url.href, host: url.host, transport };
  if (described.refusal) {
    const refusal: Response = described.refusal;
    const status = refusal.status as 401 | 403;
    return { ...base, server: null, auth: await classify(deps, fetch, url, refusal, status) };
  }
  return { ...base, server: described.server, auth: { kind: "none", tools: described.tools } };
}

export async function detectServer(
  deps: McpDeps,
  actor: McpActor & { userId: string },
  input: { url: string },
): Promise<Detection> {
  requireEnabled();
  await deps.withTenant(actor, async (tx) => {
    if (!(await isAdmin(tx, actor.userId))) throw new McpProblem("forbidden", "Only an owner or admin can do that.");
  });
  let url: URL;
  try {
    url = await checkAddress(input.url.trim(), deps.edition);
  } catch (error) {
    throw new McpProblem(
      "refused",
      error instanceof McpNetworkError ? `${error.message}.` : "That address can't be used.",
    );
  }
  // One budget for the whole detection, however many requests discovery makes.
  const guarded = fetchFor(deps);
  const deadline = AbortSignal.timeout(BUDGETS.mcp.detectMs);
  const fetch: McpFetch = (target, init) =>
    guarded(target, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  const unreachable = (error: unknown) =>
    error instanceof McpNetworkError && error.refused
      ? new McpProblem("refused", `${error.message}.`)
      : new McpProblem("failed", `OpenDash couldn't reach ${url.host}. Check the address, or try again in a minute.`);

  let probe: Response;
  try {
    probe = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initializeBody(),
    });
  } catch (error) {
    throw unreachable(error);
  }

  const transport: "streamable" | "sse" = "streamable";
  if (NOT_STREAMABLE.has(probe.status)) {
    await probe.body?.cancel().catch(() => {});
    let sse: Response;
    try {
      sse = await fetch(url, { method: "GET", headers: { accept: "text/event-stream" } });
    } catch (error) {
      throw unreachable(error);
    }
    const isStream = (sse.headers.get("content-type") ?? "").includes("text/event-stream");
    if (sse.ok && isStream) {
      await sse.body?.cancel().catch(() => {});
      return answered(deps, fetch, deadline, url, "sse");
    }
    if (sse.status === 401 || sse.status === 403) {
      return {
        url: url.href,
        host: url.host,
        transport: "sse",
        server: null,
        auth: await classify(deps, fetch, url, sse, sse.status),
      };
    }
    await sse.body?.cancel().catch(() => {});
    if (sse.status === 410) {
      throw new McpProblem(
        "invalid",
        `${url.host} retired this address (HTTP 410). Try its newer one, usually ending in /mcp.`,
      );
    }
    throw new McpProblem(
      "invalid",
      `${url.host} answered, but not as an MCP server (HTTP ${probe.status}). Check the address: it's usually the one ending in /mcp or /sse.`,
    );
  }
  if (probe.status === 401 || probe.status === 403) {
    return {
      url: url.href,
      host: url.host,
      transport,
      server: null,
      auth: await classify(deps, fetch, url, probe, probe.status),
    };
  }
  if (probe.ok) {
    await closeProbe(fetch, url, probe);
    return answered(deps, fetch, deadline, url, "streamable");
  }
  await probe.body?.cancel().catch(() => {});
  if (probe.status === 429)
    throw new McpProblem("failed", `${url.host} asked OpenDash to slow down. Try again in a minute.`);
  throw new McpProblem("failed", `${url.host} answered with an error (HTTP ${probe.status}). Try again later.`);
}
