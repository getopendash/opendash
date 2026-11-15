/**
 * Connecting an account to an approved MCP server: a person their own on a personal server, an admin the
 * workspace's one on a shared server. Sign-in happens in OpenDash's own page, never in an App.
 *
 * startConnect discovers the server's authorization server, registers OpenDash with it the first time, and returns
 * where to send the person; the PKCE verifier and that registration wait in a sign-in row for ten minutes.
 * finishConnect takes the callback's `state` and `code`: the row is found by a hash of the state, must be the
 * caller's own, unexpired and unused, and is used up before the code is exchanged.
 *
 * Every request in between goes through the guarded fetch, outside any transaction.
 */
import { createHash, randomBytes } from "node:crypto";
import { auth, type OAuthDiscoveryState, type StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import { sql, uuidv7 } from "@opendash/db";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { McpNetworkError } from "./fetch";
import {
  accountOf,
  ClientRefused,
  credentialsOf,
  type FlowSecret,
  IssuerMoved,
  issuerOf,
  OpenDashOAuthProvider,
} from "./provider";
import { revokeAtServer } from "./revoke";
import {
  isAdmin,
  loadServer,
  type McpActor,
  type McpDeps,
  McpProblem,
  oauthFetchFor,
  readCredentials,
  requireEnabled,
  resolveConnection,
  type ServerRow,
} from "./shared";

const hashState = (state: string) => createHash("sha256").update(state, "utf8").digest("base64url");

/** The registration to reuse: one made for this deployment's callback. */
function reusable(client: StoredOAuthClientInformation | undefined, redirectUrl: string) {
  if (!client) return undefined;
  const uris = (client as { redirect_uris?: unknown }).redirect_uris;
  return Array.isArray(uris) && !uris.includes(redirectUrl) ? undefined : client;
}

/** A failure on the way to the server, in words for the person; the cause stays out of it. */
function signInProblem(error: unknown, server: ServerRow): McpProblem {
  if (error instanceof McpProblem) return error;
  if (error instanceof IssuerMoved) {
    return new McpProblem(
      "refused",
      `${server.name} now signs in at ${error.found}, not where its client was made. An admin needs to check it in Settings → Connections.`,
    );
  }
  if (error instanceof ClientRefused) {
    return new McpProblem(
      "refused",
      `${server.name}'s sign-in didn't accept the client ID an admin entered. Check it in Settings → Connections.`,
    );
  }
  if (error instanceof McpNetworkError && error.refused) {
    return new McpProblem("refused", `OpenDash doesn't connect to where ${server.name} signs in: ${error.message}.`);
  }
  return new McpProblem("failed", `Couldn't start signing in to ${server.name}. Try again in a minute.`);
}

/** Who may connect the account this server uses, and which connection that would be. */
async function connectScope(
  tx: Parameters<Parameters<McpDeps["withTenant"]>[1]>[0],
  actor: McpActor & { userId: string },
  server: ServerRow,
): Promise<"org" | "personal"> {
  if (server.status !== "active") throw new McpProblem("refused", `${server.name} is turned off.`);
  if (server.auth === "apikey") throw new McpProblem("invalid", `${server.name} takes an API key, not a sign-in.`);
  if (server.auth !== "oauth") throw new McpProblem("invalid", `${server.name} needs no sign-in.`);
  if (server.access === "shared") {
    if (!(await isAdmin(tx, actor.userId))) {
      throw new McpProblem("forbidden", `Only an admin can connect the account everyone uses for ${server.name}.`);
    }
    return "org";
  }
  return "personal";
}

export interface StartedConnect {
  authorizationUrl: string;
  expiresAt: Date;
}

export async function startConnect(
  deps: McpDeps,
  actor: McpActor & { userId: string },
  input: { serverId: string },
): Promise<StartedConnect> {
  requireEnabled();
  const ctx = { orgId: actor.orgId, userId: actor.userId };
  const before = await deps.withTenant(ctx, async (tx) => {
    const server = await loadServer(tx, actor.orgId, input.serverId);
    if (!server) throw new McpProblem("not_found", "That server isn't approved here.");
    const scope = await connectScope(tx, actor, server);
    const existing = await resolveConnection(tx, actor, server);
    const cached = server.client_secret_id
      ? (JSON.parse(
          await deps.secrets.reveal(tx, actor.orgId, server.client_secret_id, "mcp"),
        ) as StoredOAuthClientInformation)
      : undefined;
    return {
      server,
      scope,
      connectionId: existing.kind === "found" ? existing.connection.id : null,
      // A client an admin entered is used as it is: it's theirs to fix, never replaced by a registration.
      client: server.client_source === "admin" ? cached : reusable(cached, deps.redirectUrl),
    };
  });
  const { server } = before;

  const state = randomBytes(32).toString("base64url");
  const provider = new OpenDashOAuthProvider({
    mode: "connect",
    redirectUrl: deps.redirectUrl,
    clientName: deps.clientName ?? "OpenDash",
    scopes: server.scopes,
    state,
    client: before.client,
    registration: server.client_source !== "admin",
    expectedIssuer: server.client_source === "admin" ? server.issuer : null,
    ...(deps.clientMetadataUrl ? { clientMetadataUrl: deps.clientMetadataUrl } : {}),
  });
  try {
    const result = await auth(provider, {
      serverUrl: server.url,
      scope: server.scopes ?? undefined,
      fetchFn: oauthFetchFor(deps),
    });
    if (result !== "REDIRECT" || !provider.authorizationUrl || !provider.savedVerifier) {
      throw new McpProblem("failed", `${server.name} didn't ask anyone to sign in.`);
    }
  } catch (error) {
    throw signInProblem(error, server);
  }
  const authorizationUrl = provider.authorizationUrl;
  // The person's browser goes there: an http(s) address only, and https in cloud.
  const allowed = deps.edition === "cloud" ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(authorizationUrl.protocol)) {
    throw new McpProblem("refused", `${server.name} asked to sign in somewhere OpenDash doesn't send people.`);
  }
  const client = provider.client;
  if (!client) throw new McpProblem("failed", `${server.name} didn't register OpenDash.`);
  const discovery = provider.savedDiscovery ?? null;
  const issuer = issuerOf(discovery);

  return deps.withTenant(ctx, async (tx) => {
    if (provider.registeredClient && server.client_source === "auto") {
      // Kept on the server for the next person; a sign-in that started meanwhile keeps its own copy in its flow.
      const clientSecretId = await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(client));
      const replaced = await tx.execute<{ id: string }>(sql`
        update app.mcp_server set client_secret_id = ${clientSecretId}, issuer = ${issuer}, updated_at = now()
        where org_id = ${actor.orgId} and id = ${server.id}
          and client_secret_id is not distinct from ${server.client_secret_id}::uuid
        returning id`);
      const unused = replaced.length ? server.client_secret_id : clientSecretId;
      if (unused) await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${unused}`);
    }
    const flowSecret: FlowSecret = { codeVerifier: provider.savedVerifier as string, client };
    const secretId = await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(flowSecret));
    // Sign-ins nobody finished, of this person's (and the workspace's): their secrets go, and the rows with them.
    await tx.execute(sql`
      delete from app.secret s using app.mcp_oauth_flow f
      where f.org_id = ${actor.orgId} and s.org_id = f.org_id and s.id = f.secret_id and f.expires_at < now()`);
    const [flow] = await tx.execute<{ expires_at: Date }>(sql`
      insert into app.mcp_oauth_flow (org_id, id, server_id, scope, scope_id, started_by, state_hash, secret_id, issuer,
                                      discovery, redirect_url, connection_id, expires_at)
      values (${actor.orgId}, ${uuidv7()}, ${server.id}, ${before.scope},
              ${before.scope === "personal" ? actor.userId : null}, ${actor.userId}, ${hashState(state)}, ${secretId},
              ${issuer}, ${discovery ? JSON.stringify(discovery) : null}::jsonb, ${deps.redirectUrl}, ${before.connectionId},
              now() + make_interval(secs => ${BUDGETS.mcp.flowMs / 1000}))
      returning expires_at`);
    return { authorizationUrl: authorizationUrl.href, expiresAt: new Date(flow?.expires_at ?? Date.now()) };
  });
}

export type FinishedConnect = { server: { id: string; name: string }; scope: "org" | "personal" } & (
  | { state: "ready"; connectionId: string; account: string | null; again: boolean }
  /** Signed in as someone other than the account this connection holds; nothing was replaced. */
  | { state: "wrong_account"; connectionId: string; account: string | null; expected: string | null }
);

type FlowRow = {
  id: string;
  server_id: string;
  scope: "org" | "personal";
  started_by: string;
  secret_id: string;
  issuer: string | null;
  discovery: OAuthDiscoveryState | null;
  redirect_url: string;
  connection_id: string | null;
  used_at: Date | null;
  live: boolean;
};

export async function finishConnect(
  deps: McpDeps,
  actor: McpActor & { userId: string },
  params: { state: string; code?: string | null; iss?: string | null; error?: string | null },
): Promise<FinishedConnect> {
  requireEnabled();
  const ctx = { orgId: actor.orgId, userId: actor.userId };
  const dropFlow = (secretId: string) =>
    deps.withTenant(ctx, (tx) =>
      tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${secretId}`),
    );

  const taken = await deps.withTenant(ctx, async (tx) => {
    const [flow] = await tx.execute<FlowRow>(sql`
      select id, server_id, scope, started_by, secret_id, issuer, discovery, redirect_url, connection_id, used_at,
             expires_at > now() as live
      from app.mcp_oauth_flow where org_id = ${actor.orgId} and state_hash = ${hashState(params.state)}
      for update`);
    if (!flow) throw new McpProblem("not_found", "That sign-in isn't one OpenDash started. Press Connect again.");
    // A workspace connection's sign-in is visible to every member; only the person who started it may finish it.
    if (flow.started_by !== actor.userId) throw new McpProblem("forbidden", "Someone else started that sign-in.");
    if (flow.used_at) throw new McpProblem("used", "That sign-in was already used. Press Connect again.");
    // Used up before anything else, so the same callback can't be replayed while this one runs.
    await tx.execute(
      sql`update app.mcp_oauth_flow set used_at = now() where org_id = ${actor.orgId} and id = ${flow.id}`,
    );
    if (!flow.live) return { flow, expired: true as const };
    const server = await loadServer(tx, actor.orgId, flow.server_id);
    if (!server) throw new McpProblem("not_found", "That server isn't approved here any more.");
    const scope = await connectScope(tx, actor, server);
    if (scope !== flow.scope) throw new McpProblem("refused", `${server.name} changed how it's shared. Connect again.`);
    if (flow.redirect_url !== deps.redirectUrl) throw new McpProblem("refused", "That sign-in came back elsewhere.");
    const secret = JSON.parse(await deps.secrets.reveal(tx, actor.orgId, flow.secret_id, "mcp")) as FlowSecret;
    return { flow, server, secret, expired: false as const };
  });
  if (taken.expired) {
    await dropFlow(taken.flow.secret_id);
    throw new McpProblem("expired", "That sign-in took too long. Press Connect again.");
  }
  const { flow, server, secret } = taken;
  if (params.error || !params.code) {
    await dropFlow(flow.secret_id);
    throw new McpProblem("refused", `${server.name} didn't allow OpenDash to connect.`);
  }

  const provider = new OpenDashOAuthProvider({
    mode: "connect",
    redirectUrl: deps.redirectUrl,
    clientName: deps.clientName ?? "OpenDash",
    scopes: server.scopes,
    client: secret.client,
    registration: server.client_source !== "admin",
    expectedIssuer: server.client_source === "admin" ? server.issuer : null,
    codeVerifier: secret.codeVerifier,
    discovery: flow.discovery,
  });
  try {
    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: params.code,
      iss: params.iss ?? undefined,
      scope: server.scopes ?? undefined,
      fetchFn: oauthFetchFor(deps),
    });
    if (result !== "AUTHORIZED" || !provider.savedTokens) {
      throw new McpProblem("failed", `${server.name} didn't finish signing in.`);
    }
  } catch (error) {
    await dropFlow(flow.secret_id);
    if (error instanceof McpProblem) throw error;
    if (
      (error instanceof McpNetworkError && error.refused) ||
      error instanceof ClientRefused ||
      error instanceof IssuerMoved
    ) {
      throw signInProblem(error, server);
    }
    throw new McpProblem("failed", `${server.name} didn't accept the sign-in. Press Connect again.`);
  }
  const tokens = provider.savedTokens;
  const issuer = issuerOf(flow.discovery) ?? flow.issuer;
  const account = accountOf(tokens);
  const credentials = credentialsOf(tokens, provider.client ?? secret.client);

  return deps.withTenant(ctx, async (tx) => {
    const existing = await resolveConnection(tx, actor, server);
    // A sign-in lands only on the connection it started against (or none): one connected, replaced or disconnected
    // meanwhile, in another tab or by another admin, isn't overwritten.
    const now = existing.kind === "found" ? existing.connection.id : null;
    if (now !== flow.connection_id) {
      await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${flow.secret_id}`);
      throw new McpProblem(
        "refused",
        `The account for ${server.name} changed while you signed in. Press Connect again.`,
      );
    }
    let result: FinishedConnect;
    if (existing.kind === "found") {
      const held = existing.connection;
      const otherIssuer = held.issuer !== null && issuer !== null && held.issuer !== issuer;
      const otherAccount = held.account_key !== null && account.key !== null && held.account_key !== account.key;
      if (otherIssuer || otherAccount) {
        // A ready connection stays as it was; one waiting to be signed in again says why it still isn't.
        await tx.execute(sql`
          update app.mcp_connection
          set status = case when status = 'ready' then 'ready' else 'wrong_account' end,
              message = case when status = 'ready' then message
                             else ${`Signed in as ${account.label ?? "another account"}, not the one connected.`} end,
              updated_at = now()
          where org_id = ${actor.orgId} and id = ${held.id}`);
        await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${flow.secret_id}`);
        return {
          server: { id: server.id, name: server.name },
          scope: flow.scope,
          state: "wrong_account",
          connectionId: held.id,
          account: account.label,
          expected: held.account,
        };
      }
      const secretId = await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(credentials));
      await tx.execute(sql`
        update app.mcp_connection
        set secret_id = ${secretId}, issuer = ${issuer}, account = coalesce(${account.label}, account),
            account_key = coalesce(${account.key}, account_key),
            discovery = ${flow.discovery ? JSON.stringify(flow.discovery) : null}::jsonb, status = 'ready', message = null,
            revision = revision + 1, connected_by = ${actor.userId}, updated_at = now(), refreshed_at = null
        where org_id = ${actor.orgId} and id = ${held.id}`);
      await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${held.secret_id}`);
      result = {
        server: { id: server.id, name: server.name },
        scope: flow.scope,
        state: "ready",
        connectionId: held.id,
        account: account.label ?? held.account,
        again: true,
      };
    } else if (existing.kind === "missing") {
      const id = uuidv7();
      const secretId = await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(credentials));
      await tx.execute(sql`
        insert into app.mcp_connection (org_id, id, server_id, scope, scope_id, secret_id, issuer, account, account_key,
                                        discovery, connected_by)
        values (${actor.orgId}, ${id}, ${server.id}, ${existing.scope},
                ${existing.scope === "personal" ? actor.userId : null}, ${secretId}, ${issuer}, ${account.label},
                ${account.key}, ${flow.discovery ? JSON.stringify(flow.discovery) : null}::jsonb, ${actor.userId})`);
      result = {
        server: { id: server.id, name: server.name },
        scope: flow.scope,
        state: "ready",
        connectionId: id,
        account: account.label,
        again: false,
      };
    } else {
      throw new McpProblem("forbidden", `${server.name} needs a person to connect.`);
    }
    await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${flow.secret_id}`);
    await audit(tx, {
      action: "mcp_connection.connected",
      target: { type: "mcp_server", id: server.id, name: server.name },
      detail: { scope: flow.scope, again: result.state === "ready" && result.again },
    });
    return result;
  });
}

/**
 * Removes the account this person (or, for a shared server, an admin) connected, and ends its sign-in at the service
 * where the service takes revocations. False when there was none.
 */
export async function disconnect(
  deps: McpDeps,
  actor: McpActor & { userId: string },
  input: { serverId: string },
): Promise<boolean> {
  requireEnabled();
  const gone = await deps.withTenant({ orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const server = await loadServer(tx, actor.orgId, input.serverId);
    if (!server) throw new McpProblem("not_found", "That server isn't approved here.");
    if (server.access === "shared" && !(await isAdmin(tx, actor.userId))) {
      throw new McpProblem("forbidden", `Only an admin can disconnect the account everyone uses for ${server.name}.`);
    }
    const resolved = await resolveConnection(tx, actor, server);
    if (resolved.kind !== "found") return null;
    const credentials = await readCredentials(deps, tx, actor.orgId, resolved.connection.secret_id).catch(() => null);
    // The row first, then its secret, which nothing points at any more.
    await tx.execute(
      sql`delete from app.mcp_connection where org_id = ${actor.orgId} and id = ${resolved.connection.id}`,
    );
    await tx.execute(
      sql`delete from app.secret where org_id = ${actor.orgId} and id = ${resolved.connection.secret_id}`,
    );
    await audit(tx, {
      action: "mcp_connection.disconnected",
      target: { type: "mcp_server", id: server.id, name: server.name },
      detail: { scope: resolved.scope },
    });
    return { credentials, discovery: resolved.connection.discovery };
  });
  if (!gone) return false;
  await revokeAtServer(deps, gone.credentials, gone.discovery);
  return true;
}
