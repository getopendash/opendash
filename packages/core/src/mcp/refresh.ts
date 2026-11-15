/**
 * Refreshing a connection's tokens, one refresh at a time per connection. A refresh token that rotates
 * works once, so two calls that refresh at once would leave one of them refused and the connection wrongly asking to
 * sign in again. Whoever claims the connection's lease (`refreshing_until`, a few seconds, in its own short
 * transaction) refreshes; the others wait for its new tokens and use those. The lease is in the database, so this holds
 * across the API and the workers; one left behind by a process that died just runs out.
 */
import {
  discoverOAuthServerInfo,
  type OAuthDiscoveryState,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
} from "@modelcontextprotocol/client";
import { sql } from "@opendash/db";
import { BUDGETS } from "../budgets";
import type { McpOutcome, Session } from "./executor";
import { McpNetworkError } from "./fetch";
import { credentialsOf } from "./provider";
import {
  isAdmin,
  isKey,
  type McpActor,
  type McpDeps,
  oauthFetchFor,
  readCredentials,
  type StoredCredentials,
} from "./shared";

/** Refreshed this long before the server said the token expires. */
const EARLY_MS = 60_000;
const WAIT_STEP_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const expiresSoon = (credentials: StoredCredentials, now = Date.now()): boolean =>
  !isKey(credentials) && typeof credentials.expiresAt === "number" && credentials.expiresAt - now < EARLY_MS;

/** A refresh the server refused for good: only a new sign-in helps. */
const refusedForGood = (error: unknown) =>
  error instanceof OAuthError &&
  [OAuthErrorCode.InvalidGrant, OAuthErrorCode.InvalidClient, OAuthErrorCode.UnauthorizedClient].includes(
    error.code as never,
  );

export class RefreshFailed extends Error {
  override name = "RefreshFailed";
}

async function reconnectOutcome(deps: McpDeps, who: McpActor, session: Session, message: string | null) {
  const connection = session.connection as NonNullable<Session["connection"]>;
  const canConnect = connection.scope === "personal" || (await deps.withTenant(who, (tx) => isAdmin(tx, who.userId)));
  return { state: "reconnect" as const, server: session.ref, scope: connection.scope, canConnect, message };
}

/** The session with fresh tokens: refreshed here, or by whichever call held the lease. Or the state that stops it. */
export async function refreshSession(
  deps: McpDeps,
  who: McpActor,
  session: Session,
): Promise<{ session: Session } | { outcome: McpOutcome }> {
  const connection = session.connection;
  const credentials = session.credentials;
  if (!connection || !credentials || isKey(credentials)) return { session };
  const basedOn = connection.secret_id;
  const leaseMs = BUDGETS.mcp.refreshLeaseMs;
  const deadline = Date.now() + leaseMs + 2_000;

  type Step =
    | { kind: "gone" }
    | { kind: "stopped"; status: string; message: string | null }
    | { kind: "fresh"; session: Session }
    /** Signed in again meanwhile (another account, maybe): never used for a call checked against the earlier one. */
    | { kind: "replaced" }
    | { kind: "claimed" }
    | { kind: "wait" };
  for (;;) {
    const step = await deps.withTenant(who, async (tx): Promise<Step> => {
      const [row] = await tx.execute<{
        secret_id: string;
        revision: number;
        status: string;
        message: string | null;
        busy: boolean;
      }>(sql`
        select secret_id, revision, status, message, coalesce(refreshing_until > now(), false) as busy
        from app.mcp_connection where org_id = ${who.orgId} and id = ${connection.id}`);
      if (!row) return { kind: "gone" };
      if (row.status !== "ready") return { kind: "stopped", status: row.status, message: row.message };
      if (row.revision !== connection.revision) return { kind: "replaced" };
      if (row.secret_id !== basedOn) {
        const fresh = await readCredentials(deps, tx, who.orgId, row.secret_id);
        const next = { ...session, connection: { ...connection, secret_id: row.secret_id }, credentials: fresh };
        return { kind: "fresh", session: next };
      }
      if (row.busy) return { kind: "wait" };
      const claimed = await tx.execute(sql`
        update app.mcp_connection set refreshing_until = now() + make_interval(secs => ${leaseMs / 1000})
        where org_id = ${who.orgId} and id = ${connection.id} and secret_id = ${basedOn}
          and (refreshing_until is null or refreshing_until <= now())
        returning id`);
      return claimed.length ? { kind: "claimed" } : { kind: "wait" };
    });
    if (step.kind === "gone") {
      return { outcome: { state: "connect", server: session.ref, scope: connection.scope, canConnect: true } };
    }
    if (step.kind === "stopped") {
      const outcome = await reconnectOutcome(deps, who, session, step.message);
      return { outcome: { ...outcome, state: step.status === "wrong_account" ? "wrong_account" : "reconnect" } };
    }
    if (step.kind === "fresh") return { session: step.session };
    if (step.kind === "replaced") {
      return {
        outcome: {
          state: "blocked",
          server: session.ref,
          reason: "changed_since",
          message: `Your ${session.server.name} account was signed in again meanwhile: nothing was sent. Try again.`,
        },
      };
    }
    if (step.kind === "claimed") break;
    if (Date.now() > deadline) throw new RefreshFailed(`${session.server.name} is taking too long to sign in again.`);
    await sleep(WAIT_STEP_MS);
  }

  const release = (status: "ready" | "reconnect", message: string | null) =>
    deps.withTenant(who, (tx) =>
      tx.execute(sql`
        update app.mcp_connection set refreshing_until = null, status = ${status}, message = ${message},
               updated_at = case when ${status} = 'reconnect' then now() else updated_at end
        where org_id = ${who.orgId} and id = ${connection.id} and secret_id = ${basedOn}`),
    );
  const refreshToken = credentials.tokens.refresh_token;
  if (!refreshToken) {
    const message = "The sign-in expired. Connect again.";
    await release("reconnect", message);
    return { outcome: await reconnectOutcome(deps, who, session, message) };
  }

  let tokens: Awaited<ReturnType<typeof refreshAuthorization>>;
  try {
    const fetchFn = oauthFetchFor(deps);
    let discovery = connection.discovery as OAuthDiscoveryState | null;
    if (!discovery?.authorizationServerUrl) {
      const info = await discoverOAuthServerInfo(session.server.url, { fetchFn });
      discovery = {
        authorizationServerUrl: String(info.authorizationServerUrl),
        authorizationServerMetadata: info.authorizationServerMetadata,
        resourceMetadata: info.resourceMetadata,
      };
    }
    tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation: credentials.client,
      refreshToken,
      resource: discovery.resourceMetadata?.resource,
      fetchFn,
    });
  } catch (error) {
    if (refusedForGood(error)) {
      const message = "The sign-in expired or was revoked. Connect again.";
      await release("reconnect", message);
      return { outcome: await reconnectOutcome(deps, who, session, message) };
    }
    await release("ready", null);
    if (error instanceof McpNetworkError && error.refused) {
      return { outcome: { state: "blocked", server: session.ref, reason: "address_refused", message: error.message } };
    }
    throw new RefreshFailed(`${session.server.name} didn't answer while signing in again.`, { cause: error });
  }

  const issuer = (credentials.tokens as { issuer?: string }).issuer;
  const next = credentialsOf({ ...tokens, ...(issuer ? { issuer } : {}) }, credentials.client);
  const secretId = await deps.withTenant(who, async (tx) => {
    const id = await deps.secrets.put(tx, who.orgId, "mcp", JSON.stringify(next));
    const updated = await tx.execute(sql`
      update app.mcp_connection
      set secret_id = ${id}, refreshing_until = null, refreshed_at = now(), updated_at = now()
      where org_id = ${who.orgId} and id = ${connection.id} and secret_id = ${basedOn}
      returning id`);
    // The lease ran out and someone else refreshed meanwhile: theirs stands, and this call uses its own once.
    await tx.execute(sql`delete from app.secret where org_id = ${who.orgId} and id = ${updated.length ? basedOn : id}`);
    return updated.length ? id : basedOn;
  });
  return { session: { ...session, connection: { ...connection, secret_id: secretId }, credentials: next } };
}
