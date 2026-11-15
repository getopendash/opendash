/**
 * What every MCP module shares: its dependencies, the flag, problems, and the one resolver that picks the
 * connection a call may use. No fallback anywhere: a personal server uses the current person's own connection or
 * none, a shared server the workspace's one, and a run with no person only shared servers.
 */
import type { Edition } from "@opendash/connectors/network";
import { sql, type TenantCtx, type TenantTx } from "@opendash/db";
import type { SecretStore } from "../secrets/store";
import { type GuardOptions, guardedFetch, type McpFetch } from "./fetch";
import type { ConnectionCredentials } from "./provider";

export interface McpDeps {
  secrets: SecretStore;
  edition: Edition;
  /** One short transaction as the organization and person. Never held across a request to a server. */
  withTenant: <T>(ctx: TenantCtx, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** OpenDash's callback for MCP sign-ins. */
  redirectUrl: string;
  /**
   * Where OpenDash publishes its client metadata document (https), for authorization servers that take one as the
   * client ID instead of a registration. None: such a server needs a registration or a client an admin entered.
   */
  clientMetadataUrl?: string;
  /** What the authorization server shows people when it asks them to allow OpenDash. */
  clientName?: string;
  /** Tighter limits for the guarded fetch (tests); the edition always comes from `edition`. */
  guard?: Omit<GuardOptions, "edition">;
}

/** Who is asking: a person in an organization, or no one (a background run). */
export interface McpActor {
  orgId: string;
  userId: string | null;
}

export type McpProblemCode = "off" | "not_found" | "forbidden" | "invalid" | "expired" | "used" | "refused" | "failed";

/** Something a person or admin did that can't go ahead, said in words they can act on. */
export class McpProblem extends Error {
  override name = "McpProblem";
  constructor(
    readonly code: McpProblemCode,
    message: string,
  ) {
    super(message);
  }
}

/** MCP connections are on by default; OPENDASH_MCP=0 turns them off on a deployment. */
export const mcpEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.OPENDASH_MCP !== "0";

export function requireEnabled(): void {
  if (!mcpEnabled()) throw new McpProblem("off", "MCP connections aren't turned on here.");
}

export const fetchFor = (deps: McpDeps, options: { requestMs?: number } = {}): McpFetch =>
  guardedFetch({ ...deps.guard, edition: deps.edition, ...options });

/**
 * The guarded fetch for an OAuth flow (sign-in, token, refresh). An authorization server's error answer keeps only
 * its error code: the client library logs an error's description, and one could echo back what it was sent (a client
 * secret, a code), so nothing the server wrote reaches a log.
 */
export function oauthFetchFor(deps: McpDeps): McpFetch {
  const fetch = fetchFor(deps);
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return response;
    let code = "invalid_request";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,64}$/.test(body.error)) code = body.error;
    } catch {}
    const headers = new Headers({ "content-type": "application/json" });
    const authenticate = response.headers.get("www-authenticate");
    if (authenticate) headers.set("www-authenticate", authenticate);
    return new Response(JSON.stringify({ error: code }), { status: response.status, headers });
  };
}

export type ServerRow = {
  id: string;
  name: string;
  url: string;
  transport: "streamable" | "sse";
  auth: "oauth" | "apikey" | "none";
  access: "personal" | "shared";
  dashboards_allowed: boolean;
  status: "active" | "disabled";
  scopes: string | null;
  client_secret_id: string | null;
  client_source: "auto" | "admin";
  issuer: string | null;
  key_header: string | null;
  key_format: string | null;
  key_hint: string | null;
};

export const serverColumns = sql`id, name, url, transport, auth, access, dashboards_allowed, status, scopes, client_secret_id,
                                 client_source, issuer, key_header, key_format, key_hint`;

/** A server's row; `lock`: held until the transaction ends, for a change that reads and then writes it. */
export async function loadServer(
  tx: TenantTx,
  orgId: string,
  serverId: string,
  lock = false,
): Promise<ServerRow | undefined> {
  const [row] = await tx.execute<ServerRow>(sql`
    select ${serverColumns} from app.mcp_server where org_id = ${orgId} and id = ${serverId}
    ${lock ? sql`for update` : sql``}`);
  return row;
}

export async function isAdmin(tx: TenantTx, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${userId}) as role`);
  return row?.role === "owner" || row?.role === "admin";
}

export type ConnectionRow = {
  id: string;
  server_id: string;
  scope: "org" | "personal";
  scope_id: string | null;
  secret_id: string;
  issuer: string | null;
  account: string | null;
  account_key: string | null;
  discovery: Record<string, unknown> | null;
  status: "ready" | "reconnect" | "wrong_account";
  message: string | null;
  revision: number;
};

export type Resolved =
  /** A shared server's one account, or this person's own. */
  | { kind: "found"; scope: "org" | "personal"; connection: ConnectionRow }
  /** Nobody has connected the account this call needs. */
  | { kind: "missing"; scope: "org" | "personal" }
  /** A personal server, and no person to use the account of (a background run). */
  | { kind: "needs_person" };

/** The one resolver: the connection this actor's call to this server may use, and no other. */
export async function resolveConnection(tx: TenantTx, actor: McpActor, server: ServerRow): Promise<Resolved> {
  const columns = sql`id, server_id, scope, scope_id, secret_id, issuer, account, account_key, discovery, status,
                      message, revision`;
  if (server.access === "shared") {
    const [row] = await tx.execute<ConnectionRow>(sql`
      select ${columns} from app.mcp_connection
      where org_id = ${actor.orgId} and server_id = ${server.id} and scope = 'org'`);
    return row ? { kind: "found", scope: "org", connection: row } : { kind: "missing", scope: "org" };
  }
  if (!actor.userId) return { kind: "needs_person" };
  const [row] = await tx.execute<ConnectionRow>(sql`
    select ${columns} from app.mcp_connection
    where org_id = ${actor.orgId} and server_id = ${server.id} and scope = 'personal' and scope_id = ${actor.userId}`);
  return row ? { kind: "found", scope: "personal", connection: row } : { kind: "missing", scope: "personal" };
}

/** What an API key connection's secret holds. Shown only as its last four characters. */
export interface KeyCredentials {
  kind: "apikey";
  key: string;
}

/** A connection's secret: an OAuth token set with its client registration, or an API key. */
export type StoredCredentials = ConnectionCredentials | KeyCredentials;

export const isKey = (credentials: StoredCredentials | null | undefined): credentials is KeyCredentials =>
  (credentials as KeyCredentials | null | undefined)?.kind === "apikey";

/**
 * The header a call with this key sends: the server's header (Authorization by default) with its value format, where
 * `{key}` stands for the key. Before formats, Authorization carried `Bearer <key>` and any other header the bare key.
 */
export function keyHeaders(
  server: Pick<ServerRow, "key_header" | "key_format">,
  credentials: KeyCredentials,
): Record<string, string> {
  const name = server.key_header ?? "authorization";
  const format = server.key_format ?? (name.toLowerCase() === "authorization" ? "Bearer {key}" : "{key}");
  // A function, not a string: a key with a $ in it is never read as a replacement pattern.
  return { [name]: format.replace("{key}", () => credentials.key) };
}

export async function readCredentials(
  deps: McpDeps,
  tx: TenantTx,
  orgId: string,
  secretId: string,
): Promise<StoredCredentials> {
  return JSON.parse(await deps.secrets.reveal(tx, orgId, secretId, "mcp")) as StoredCredentials;
}
