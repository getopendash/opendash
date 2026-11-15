// A stand-in for a remote MCP server and its authorization server (FakeMcp), for the MCP connection tests.
// On one loopback port it serves what a real one does: protected-resource and authorization-server metadata, dynamic
// client registration, a PKCE authorization-code grant and refresh tokens that rotate, and a stateless Streamable
// HTTP endpoint whose tools answer with the signed-in account's own issues. A test plays the person at the
// authorization page with `approve`, and reads what each call carried from `calls`.
//
// It can also be a server that takes API keys instead (`keys`: no OAuth metadata at all), one that needs nothing
// (`auth: false`), one with no dynamic registration (`registration: false`, with clients made by `preregister`), and
// one that speaks only the older HTTP with server-sent events (`sse`).
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type JSONRPCMessage,
  McpServer,
  type Transport,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export interface FakeMcpCall {
  tool: string;
  /** The account whose token came with it, or null when none did. */
  account: string | null;
  token: string | null;
  args: Record<string, unknown>;
}

export interface FakeBehaviour {
  /** The MCP endpoint wants a bearer token (else it answers anyone). */
  auth: boolean;
  /** The MCP endpoint answers 429. */
  rateLimit: boolean;
  /** Token responses carry an ID token naming the account. */
  idTokens: boolean;
  /** v2 adds a `limit` argument to search_issues, so its listed schema (and digest) changes. */
  tools: "v1" | "v2";
  /** What the protected-resource metadata names as its authorization server; null: this fake. */
  authServer: string | null;
  /** The protected-resource metadata redirects here instead of answering. */
  metadataRedirect: string | null;
  /** The protected-resource metadata is padded to this many bytes. */
  metadataBytes: number;
  /** What token responses say about how long an access token lasts, in seconds. */
  expiresIn: number;
  /** An API key server: these keys (to the account each belongs to) are accepted, and there's no OAuth anywhere. */
  keys: Record<string, string> | null;
  /** The header a key goes in; null: Authorization: Bearer. */
  keyHeader: string | null;
  /** What comes before the key in that header's value (`Token `); null: nothing (the bare key, or Bearer in Authorization). */
  keyPrefix: string | null;
  /** How a missing or wrong key is answered. */
  keyRefusal: 401 | 403;
  /** What search_issues answers instead of its two issues (a richer answer, for a dashboard's browser check). */
  issues: Record<string, unknown>[] | null;
  /** A transition_issue tool too (it changes things): moves one of `issues` to another status. */
  transitions: boolean;
  /** The authorization server offers dynamic client registration. */
  registration: boolean;
  /** Only the older HTTP with server-sent events: GET opens the stream, POSTs go to the endpoint it names. */
  sse: boolean;
  /** The authorization server takes a client metadata document (an https URL) as the client ID. */
  cimd: boolean;
  /** The MCP endpoint answers every request with a 307 to this address. */
  mcpRedirect: string | null;
  /** The older transport's event stream opens for anyone; only its message endpoint wants a key or token. */
  openStream: boolean;
  /** A refused client is told why, with what it sent echoed back (as careless servers do). */
  echoErrors: boolean;
  /** A browser at the authorization page signs in as this account at once and is sent back (dev checks). */
  autoApproveAs: string | null;
}

export interface FakeMcp {
  /** The MCP endpoint. */
  url: string;
  /** The origin, which is also the authorization server's issuer. */
  base: string;
  calls: FakeMcpCall[];
  /** The headers of every request to the MCP endpoint. */
  headersSeen: Record<string, string>[];
  /** Tokens revoked at /revoke (RFC 7009). */
  revoked: string[];
  /** How many clients registered, and every token request's grant. */
  registrations: number;
  grants: string[];
  /** How many calls the MCP endpoint turned away for want of a valid token. */
  unauthorized: number;
  /** A client an admin made at the service (no dynamic registration): its ID, secret (or none) and redirect. */
  preregister(clientId: string, secret: string | null, redirectUri: string): void;
  /** The person at the authorization page signs in as `account` and allows OpenDash: the callback's parameters. */
  approve(authorizationUrl: string, account: string): { code: string; state: string; iss: string };
  /** The authorization page as the person's browser would see it: the parameters OpenDash sent. */
  authorizationParams(authorizationUrl: string): URLSearchParams;
  /** Every access token stops working (as when they expire): the next call has to refresh. */
  expireAccessTokens(): void;
  /** Every refresh token stops working (as when access is revoked): the next refresh is refused. */
  revokeRefreshTokens(): void;
  set(behaviour: Partial<FakeBehaviour>): void;
  close(): Promise<void>;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64url");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

export async function fakeMcp(): Promise<FakeMcp> {
  const behaviour: FakeBehaviour = {
    auth: true,
    rateLimit: false,
    idTokens: false,
    tools: "v1",
    authServer: null,
    metadataRedirect: null,
    metadataBytes: 0,
    expiresIn: 3600,
    keys: null,
    keyHeader: null,
    keyPrefix: null,
    keyRefusal: 401,
    issues: null,
    transitions: false,
    registration: true,
    sse: false,
    cimd: false,
    mcpRedirect: null,
    openStream: false,
    echoErrors: false,
    autoApproveAs: null,
  };
  let unauthorized = 0;
  const clients = new Map<string, { redirectUris: string[]; secret?: string }>();
  let registered = 0;
  const streams = new Map<string, { res: ServerResponse; transport: SseTransport }>();
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; account: string; used: boolean }
  >();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, { account: string; clientId: string }>();
  const calls: FakeMcpCall[] = [];
  const grants: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const revoked: string[] = [];
  let counter = 0;
  let base = "";

  const issue = (account: string, clientId: string) => {
    counter++;
    const access = `at-${account}-${counter}`;
    const refresh = `rt-${account}-${counter}`;
    accessTokens.set(access, account);
    refreshTokens.set(refresh, { account, clientId });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: behaviour.expiresIn,
      refresh_token: refresh,
      ...(behaviour.idTokens
        ? { id_token: `${b64({ alg: "none" })}.${b64({ sub: `sub-${account}`, email: `${account}@acme.test` })}.` }
        : {}),
    };
  };

  /** The MCP server for one request, its tools answering as the token's account. */
  const mcpFor = () => {
    const server = new McpServer({ name: "acme-tracker", version: "1.0.0" });
    const accountOf = (ctx: { http?: { authInfo?: { token: string } } }) => {
      const token = ctx.http?.authInfo?.token ?? null;
      return { token, account: token ? (accessTokens.get(token) ?? null) : null };
    };
    const record = (tool: string, ctx: Parameters<typeof accountOf>[0], args: Record<string, unknown>) => {
      const who = accountOf(ctx);
      calls.push({ tool, ...who, args });
      return who.account ?? "anyone";
    };
    const search =
      behaviour.tools === "v1"
        ? z.object({ query: z.string() })
        : z.object({ query: z.string(), limit: z.number().int().max(50).optional() });
    server.registerTool(
      "search_issues",
      { description: "Searches the issues you can see.", inputSchema: search, annotations: { readOnlyHint: true } },
      async (args, ctx) => {
        const account = record("search_issues", ctx as never, args);
        const issues =
          behaviour.issues ?? [1, 2].map((n) => ({ key: `ACME-${n}`, title: `${args.query} ${n}`, assignee: account }));
        return { content: [{ type: "text", text: JSON.stringify(issues) }] };
      },
    );
    if (behaviour.transitions) {
      server.registerTool(
        "transition_issue",
        {
          description: "Moves an issue to another status.",
          inputSchema: z.object({ issue: z.string().max(40), to: z.enum(["Open", "In progress", "Done"]) }),
        },
        async (args, ctx) => {
          const account = record("transition_issue", ctx as never, args);
          const found = behaviour.issues?.find((i) => i.key === args.issue) as
            | { fields?: { status?: { name?: string } } }
            | undefined;
          if (!found?.fields?.status) {
            return { isError: true, content: [{ type: "text", text: `${args.issue} doesn't exist.` }] };
          }
          found.fields.status.name = args.to;
          return { content: [{ type: "text", text: `${args.issue} moved to ${args.to} by ${account}.` }] };
        },
      );
    }
    server.registerTool(
      "create_issue",
      {
        description: "Creates an issue.",
        inputSchema: z.object({ title: z.string().max(200) }),
        // Adds, never deletes or overwrites: a change OpenDash may make once the person allows it.
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async (args, ctx) => {
        const account = record("create_issue", ctx as never, args);
        return { content: [{ type: "text", text: `Created ACME-9 for ${account}` }] };
      },
    );

    return server;
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const resourceMetadata = () => ({
    resource: `${base}/mcp`,
    authorization_servers: [behaviour.authServer ?? base],
    scopes_supported: ["issues:read"],
    ...(behaviour.metadataBytes ? { padding: "x".repeat(behaviour.metadataBytes) } : {}),
  });

  const approveUrl = (authorizationUrl: string, account: string) => {
    const params = new URL(authorizationUrl).searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const client = clients.get(clientId);
    if (!client?.redirectUris.includes(redirectUri)) throw new Error("unknown client or redirect");
    if (params.get("code_challenge_method") !== "S256") throw new Error("no PKCE");
    counter++;
    const code = `code-${counter}`;
    codes.set(code, {
      clientId,
      redirectUri,
      challenge: params.get("code_challenge") ?? "",
      account,
      used: false,
    });
    return { code, state: params.get("state") ?? "", iss: base };
  };

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", base);
      const body = await readBody(req);
      if (behaviour.keys && url.pathname.startsWith("/.well-known/")) {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (behaviour.metadataRedirect) {
          res.writeHead(302, { location: behaviour.metadataRedirect });
          res.end();
          return;
        }
        json(res, 200, resourceMetadata());
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(behaviour.registration ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
          scopes_supported: ["issues:read"],
          authorization_response_iss_parameter_supported: true,
          ...(behaviour.cimd ? { client_id_metadata_document_supported: true } : {}),
          revocation_endpoint: `${base}/revoke`,
        });
        return;
      }
      if (url.pathname === "/authorize" && req.method === "GET" && behaviour.autoApproveAs) {
        const back = approveUrl(url.href, behaviour.autoApproveAs);
        const to = new URL(url.searchParams.get("redirect_uri") ?? "");
        to.searchParams.set("code", back.code);
        to.searchParams.set("state", back.state);
        to.searchParams.set("iss", back.iss);
        res.writeHead(302, { location: to.href }).end();
        return;
      }
      if (url.pathname === "/revoke" && req.method === "POST") {
        const form = new URLSearchParams(body.toString("utf8"));
        const token = form.get("token") ?? "";
        if (refreshTokens.delete(token) || accessTokens.delete(token)) revoked.push(token);
        res.writeHead(200).end();
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        if (!behaviour.registration) {
          res.writeHead(404).end();
          return;
        }
        const metadata = JSON.parse(body.toString("utf8")) as { redirect_uris?: string[] };
        registered++;
        const clientId = `client-${clients.size + 1}`;
        clients.set(clientId, { redirectUris: metadata.redirect_uris ?? [] });
        json(res, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body.toString("utf8"));
        const grant = form.get("grant_type") ?? "";
        grants.push(grant);
        // A client with a secret authenticates (Basic); one without names itself in the form.
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        const [basicId, basicSecret] = basic
          ? Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent)
          : [];
        const clientId = basicId ?? form.get("client_id") ?? "";
        const client = clients.get(clientId);
        if (client?.secret !== undefined && client.secret !== basicSecret) {
          json(res, 401, {
            error: "invalid_client",
            ...(behaviour.echoErrors ? { error_description: `bad client ${clientId}:${basicSecret ?? ""}` } : {}),
          });
          return;
        }
        if (grant === "authorization_code") {
          const code = codes.get(form.get("code") ?? "");
          if (
            !code ||
            code.used ||
            code.clientId !== clientId ||
            code.redirectUri !== form.get("redirect_uri") ||
            sha256(form.get("code_verifier") ?? "") !== code.challenge
          ) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          code.used = true;
          json(res, 200, issue(code.account, code.clientId));
          return;
        }
        if (grant === "refresh_token") {
          const held = refreshTokens.get(form.get("refresh_token") ?? "");
          if (!held || held.clientId !== clientId) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          // Rotation: the refresh token used is spent.
          refreshTokens.delete(form.get("refresh_token") ?? "");
          json(res, 200, issue(held.account, held.clientId));
          return;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (url.pathname === "/mcp" || url.pathname === "/mcp/messages") {
        headersSeen.push({ ...(req.headers as Record<string, string>) });
        if (behaviour.mcpRedirect) {
          res.writeHead(307, { location: behaviour.mcpRedirect }).end();
          return;
        }
        if (behaviour.rateLimit) {
          json(res, 429, { error: "slow down" }, { "retry-after": "30" });
          return;
        }
        // Who's calling: an access token, or a key (as the account it belongs to).
        let bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
        // The stream's own address is open (GET, and a POST there is just 405); its message endpoint isn't.
        const publicStream = behaviour.sse && behaviour.openStream && url.pathname === "/mcp";
        if (publicStream) {
          // Anyone may open the stream; what's sent on it is checked at the message endpoint.
        } else if (behaviour.keys) {
          const raw = behaviour.keyHeader ? req.headers[behaviour.keyHeader.toLowerCase()] : bearer;
          const prefix = behaviour.keyPrefix ?? "";
          const key = typeof raw === "string" && raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
          const account = key ? behaviour.keys[key] : undefined;
          if (!account) {
            unauthorized++;
            json(res, behaviour.keyRefusal, { error: "missing or wrong key" });
            return;
          }
          bearer = `key-${account}`;
          accessTokens.set(bearer, account);
        } else if (behaviour.auth && (!bearer || !accessTokens.has(bearer))) {
          unauthorized++;
          json(
            res,
            401,
            { error: "invalid_token" },
            {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
          return;
        }
        const authInfo = bearer ? { authInfo: { token: bearer, clientId: "fake", scopes: [] } } : {};
        if (behaviour.sse) {
          if (url.pathname === "/mcp" && req.method === "GET") {
            const sessionId = randomUUID();
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);
            const transport = new SseTransport(res);
            streams.set(sessionId, { res, transport });
            const server = mcpFor();
            await server.connect(transport);
            req.on("close", () => {
              streams.delete(sessionId);
              void server.close();
            });
            return;
          }
          if (url.pathname === "/mcp/messages" && req.method === "POST") {
            const stream = streams.get(url.searchParams.get("sessionId") ?? "");
            if (!stream) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(202).end();
            stream.transport.onmessage?.(
              JSON.parse(body.toString("utf8")) as JSONRPCMessage,
              {
                ...authInfo,
              } as never,
            );
            return;
          }
          res.writeHead(405).end();
          return;
        }
        if (req.method !== "POST" || url.pathname !== "/mcp") {
          res.writeHead(405).end();
          return;
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const request = new Request(`${base}/mcp`, { method: "POST", headers, body });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = mcpFor();
        await server.connect(transport);
        const response = await transport.handleRequest(request, authInfo);
        const out: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          out[k] = v;
        });
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
        await server.close();
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  return {
    url: `${base}/mcp`,
    base,
    calls,
    headersSeen,
    revoked,
    get registrations() {
      return registered;
    },
    preregister(clientId, secret, redirectUri) {
      clients.set(clientId, { redirectUris: [redirectUri], ...(secret !== null ? { secret } : {}) });
    },
    get unauthorized() {
      return unauthorized;
    },
    grants,
    authorizationParams: (authorizationUrl) => new URL(authorizationUrl).searchParams,
    approve: (authorizationUrl, account) => approveUrl(authorizationUrl, account),
    expireAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    set: (next) => Object.assign(behaviour, next),
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams.values()) stream.res.end();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** The server side of the older transport: each message goes down the event stream. */
class SseTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  constructor(private readonly res: ServerResponse) {}
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
  async close(): Promise<void> {
    this.res.end();
    this.onclose?.();
  }
}
