/**
 * The one executor: the analyst's tools, dashboards' bridge and any later door call a server's tool only
 * through callTool. It answers with the tool's result (`ready`) or one of six states that carry no data at all:
 *   connect        no account connected; `canConnect` says whether this person can connect it;
 *   reconnect      the account's sign-in expired, was revoked or refused;
 *   wrong_account  someone signed in again as a different account than the connection holds;
 *   consent        the tool's tier is `ask` (or it changed since an admin reviewed it) and the person hasn't agreed;
 *   blocked        not approved, turned off, a blocked or unknown tool, not allowed in dashboards, or no person to act as;
 *   rate_limited   the server said to slow down.
 * A server that fails or doesn't answer throws McpCallFailed: that isn't a state of access.
 *
 * Nothing is cached or recorded here. A call reads in one short transaction, calls outside any, and writes back
 * refreshed tokens (or `reconnect`) in short transactions of their own.
 *
 * A server that takes an API key gets it in a header on every request; a key it refuses is `reconnect` straight away
 * (there's nothing to refresh). A server that only speaks the older HTTP with server-sent events is called through
 * that transport; everything else about the call is the same.
 */

import { createHash } from "node:crypto";
import {
  type CallToolResult,
  Client,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { sql, type TenantTx } from "@opendash/db";
import { BUDGETS } from "../budgets";
import { type McpFetch, McpNetworkError } from "./fetch";
import { NeedsRefresh, NeedsSignIn, OpenDashOAuthProvider } from "./provider";
import { expiresSoon, RefreshFailed, refreshSession } from "./refresh";
import {
  type ConnectionRow,
  fetchFor,
  isAdmin,
  isKey,
  keyHeaders,
  loadServer,
  type McpActor,
  type McpDeps,
  McpProblem,
  readCredentials,
  requireEnabled,
  resolveConnection,
  type ServerRow,
  type StoredCredentials,
} from "./shared";
import { changesDestructively } from "./views";

export type McpState = "ready" | "connect" | "reconnect" | "wrong_account" | "consent" | "blocked" | "rate_limited";

export type BlockedReason =
  | "personal_not_here"
  | "changes_things"
  | "destructive"
  | "shared_account"
  | "not_approved"
  | "disabled"
  | "unknown_tool"
  | "tool_blocked"
  | "not_in_dashboards"
  | "needs_person"
  | "address_refused"
  /** A change is made by a person with their own account: never the workspace's one. */
  | "own_account"
  /** The account or the tool isn't the one the person confirmed: nothing was sent. */
  | "changed_since"
  /** The server refused the sign-in for a change: it was renewed, nothing was changed, and it isn't sent again. */
  | "try_again";

export interface ServerRef {
  id: string;
  name: string;
}

export type McpOutcome =
  /** `scope`: whose account the call ran as: the person's own, the workspace's one, or none (no sign-in). */
  | { state: "ready"; server: ServerRef; scope: "org" | "personal" | null; result: CallToolResult }
  | { state: "connect"; server: ServerRef; scope: "org" | "personal"; canConnect: boolean }
  | { state: "reconnect"; server: ServerRef; scope: "org" | "personal"; canConnect: boolean; message: string | null }
  | {
      state: "wrong_account";
      server: ServerRef;
      scope: "org" | "personal";
      canConnect: boolean;
      message: string | null;
    }
  /** `binding`: the tool as listed now and the account it would run as (consentBinding), for the card to keep. */
  | { state: "consent"; server: ServerRef; tool: string; reason: "ask" | "changed"; binding: string }
  | { state: "blocked"; server: ServerRef | null; reason: BlockedReason; message: string }
  | { state: "rate_limited"; server: ServerRef };

export interface McpCall {
  serverId: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** Who's calling: the analyst for a person, a dashboard a person is viewing, or a run on no one's behalf. */
  via: "analyst" | "dashboard" | "background";
  /**
   * The person agreed to this one call of an `ask` tool: outright (a caller that checks the tool and account itself,
   * with `policy.expect`), or to the tool and account a consent outcome named (its `binding`): then it counts only
   * while both are still those, and otherwise the call asks again.
   */
  consented?: boolean | { binding: string };
  /**
   * Limits the caller sets, checked against the server and tool rows this call actually uses (not a copy read
   * earlier): `personal: false` refuses a person's own account (the caller's audience isn't only them); `readsOnly`
   * refuses a tool the server doesn't say only reads.
   */
  policy?: {
    personal?: boolean;
    readsOnly?: boolean;
    /** Only the caller's own account on a personal server (a change a person makes): never a shared one. */
    ownAccount?: boolean;
    /** What the person confirmed: the call runs only if the connection, its account and the tool are still these. */
    expect?: { connectionId: string; accountRevision: number; digest: string };
  };
  /**
   * Sent at most once: no second attempt after an authorization refusal (a change must never be made twice). A tool
   * that doesn't say it only reads is always sent so, whatever the caller says.
   */
  once?: boolean;
  /** Never sent after this (epoch ms): a change still waiting past it is dropped before it goes. */
  deadline?: number;
  /** Ends the call (and any refresh or request it's waiting on) when the caller stops. */
  signal?: AbortSignal;
}

/** The server failed, timed out or answered with something that isn't MCP. Shown as an error, never as data. */
export class McpCallFailed extends Error {
  override name = "McpCallFailed";
}

/** The largest arguments a call may send, as JSON. */
const MAX_ARGUMENT_BYTES = 64_000;

/**
 * What a person's yes on a card is to besides the call itself: the tool as listed (its digest covers its name,
 * description, schema and annotations) and the account it runs as (the connection, and its revision, which a new
 * sign-in or key moves on). A tool that changed what it says it does, or another sign-in, since the card is asked
 * about again.
 */
export const consentBinding = (toolDigest: string, connection: { id: string; revision: number } | null): string =>
  createHash("sha256")
    .update(JSON.stringify([toolDigest, connection?.id ?? null, connection?.revision ?? null]), "utf8")
    .digest("hex");

type ToolRow = {
  name: string;
  annotations: Record<string, unknown>;
  input_schema: Record<string, unknown>;
  digest: string;
  status: "active" | "changed" | "removed";
  tier: "always" | "ask" | "blocked";
  dashboards_allowed: boolean;
};

const ajv = new AjvJsonSchemaValidator();
const validators = new Map<string, (input: unknown) => { valid: boolean; errorMessage?: string }>();

const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 5_000;
/** Keywords whose regular expressions a server writes: one could take the process down on a crafted argument. */
const REGEX_KEYWORDS = new Set(["pattern", "patternProperties", "format"]);

/** Keywords that point elsewhere: inlined (local ones) or refused, so a schema's size is what it expands to. */
const REF_KEYWORDS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const DEFINITION_KEYWORDS = new Set(["$defs", "definitions", "$anchor", "$dynamicAnchor", "$recursiveAnchor", "$id"]);

/** What a local JSON pointer (`#/$defs/item`) names in the schema, or undefined. */
function pointed(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * A tool's schema as OpenDash checks arguments against it: the server's own, minus what runs a regular expression the
 * server chose (a catastrophic one would block the process), so the check is a little looser and the server still
 * checks the rest. Where `patternProperties` went, `additionalProperties` goes too, or allowed names would be refused.
 * Local references are inlined, counted as they expand; a reference to itself (recursion) or outside the schema
 * makes the schema uncheckable, and so does one nested deeper than 32 levels or past 5,000 parts once expanded. A
 * schema that can't be checked can't be called.
 */
export function checkableSchema(schema: unknown): unknown {
  let nodes = 0;
  const walk = (node: unknown, depth: number, refs: readonly string[]): unknown => {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) throw new Error("schema too large");
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1, refs));
    if (!node || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (REGEX_KEYWORDS.has(key) || DEFINITION_KEYWORDS.has(key)) continue;
      if (key === "additionalProperties" && "patternProperties" in source) continue;
      if (REF_KEYWORDS.has(key)) {
        if (key !== "$ref" || typeof value !== "string") throw new Error("schema reference not supported");
        if (refs.includes(value)) throw new Error("schema refers to itself");
        const target = pointed(schema, value);
        if (target === undefined) throw new Error("schema reference not found");
        const inlined = walk(target, depth + 1, [...refs, value]);
        // A $ref beside other keywords: both apply (JSON Schema 2019-09 and later).
        out.allOf = [...((out.allOf as unknown[] | undefined) ?? []), inlined];
        continue;
      }
      out[key] = walk(value, depth + 1, refs);
    }
    return out;
  };
  return walk(schema, 0, []);
}

/** Checks arguments against the tool's schema as listed (cached per schema digest, a few hundred at most). */
function checkArguments(tool: ToolRow, args: Record<string, unknown>): void {
  const size = Buffer.byteLength(JSON.stringify(args), "utf8");
  if (size > MAX_ARGUMENT_BYTES) throw new McpProblem("invalid", `The arguments for ${tool.name} are too large.`);
  let validate = validators.get(tool.digest);
  if (!validate) {
    try {
      validate = ajv.getValidator(checkableSchema(tool.input_schema) as never);
    } catch {
      throw new McpProblem("invalid", `${tool.name}'s schema can't be checked, so OpenDash won't call it.`);
    }
    if (validators.size >= 500) validators.delete(validators.keys().next().value as string);
    validators.set(tool.digest, validate);
  }
  const verdict = validate(args);
  if (!verdict.valid)
    throw new McpProblem("invalid", `The arguments for ${tool.name} don't fit: ${verdict.errorMessage}`);
}

/** Checks a call's arguments against a tool's listed schema (a row's action, before the person confirms it). */
export function checkToolArguments(
  tool: { name: string; digest: string; input_schema: Record<string, unknown> },
  args: Record<string, unknown>,
): void {
  checkArguments(tool as ToolRow, args);
}

/** Every error in a chain of causes. */
function* causes(error: unknown): Generator<unknown> {
  for (let e = error, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) yield e;
}

const statusOf = (e: unknown): number | undefined =>
  SdkHttpError.isInstance(e)
    ? (e as { data?: { status?: number } }).data?.status
    : e instanceof SseError
      ? (e as { code?: number }).code
      : undefined;

const needsSignIn = (error: unknown) =>
  [...causes(error)].some(
    (e) =>
      e instanceof NeedsSignIn || e instanceof NeedsRefresh || UnauthorizedError.isInstance(e) || statusOf(e) === 401,
  );

/** A key the server turned down: 401, or 403 (some servers answer a missing or wrong key with it). */
const keyRefused = (error: unknown) =>
  [...causes(error)].some((e) => UnauthorizedError.isInstance(e) || statusOf(e) === 401 || statusOf(e) === 403);

const rateLimited = (error: unknown) => [...causes(error)].some((e) => statusOf(e) === 429);

const refusedAddress = (error: unknown) =>
  [...causes(error)].find((e): e is McpNetworkError => e instanceof McpNetworkError && e.refused);

/** The server and account a session runs as, once every check has passed. */
export interface Session {
  server: ServerRow;
  ref: ServerRef;
  connection: ConnectionRow | null;
  credentials: StoredCredentials | null;
}

const blocked = (server: ServerRef | null, reason: BlockedReason, message: string): { outcome: McpOutcome } => ({
  outcome: { state: "blocked", server, reason, message },
});

/**
 * The account a session with this server runs as: none for a server that needs no sign-in, else the one connection
 * the resolver picks (an OAuth sign-in or an API key), ready, with its credentials read. Otherwise the state that says
 * why not.
 */
export async function sessionAccount(
  deps: McpDeps,
  tx: TenantTx,
  who: McpActor,
  server: ServerRow,
): Promise<{ outcome: McpOutcome } | Session> {
  const ref = { id: server.id, name: server.name };
  if (server.auth === "none") return { server, ref, connection: null, credentials: null };
  const resolved = await resolveConnection(tx, who, server);
  if (resolved.kind === "needs_person") {
    return blocked(ref, "needs_person", `${server.name} uses each person's own account, and this runs for no one.`);
  }
  const canConnect = resolved.scope === "personal" || (await isAdmin(tx, who.userId));
  if (resolved.kind === "missing")
    return { outcome: { state: "connect", server: ref, scope: resolved.scope, canConnect } };
  const connection = resolved.connection;
  if (connection.status !== "ready") {
    return {
      outcome: {
        state: connection.status,
        server: ref,
        scope: resolved.scope,
        canConnect,
        message: connection.message,
      },
    };
  }
  const credentials = await readCredentials(deps, tx, who.orgId, connection.secret_id);
  return { server, ref, connection, credentials };
}

/** Calls one tool of an approved server as this person (or no one), through the connection the resolver picks. */
export async function callTool(deps: McpDeps, actor: McpActor, call: McpCall): Promise<McpOutcome> {
  requireEnabled();
  // A background run acts for no one, whoever scheduled it: it may use shared servers only.
  const who: McpActor = call.via === "background" ? { orgId: actor.orgId, userId: null } : actor;
  const args = call.arguments ?? {};

  const prepared = await deps.withTenant(
    who,
    async (tx): Promise<{ outcome: McpOutcome } | (Session & { changes: boolean })> => {
      const server = await loadServer(tx, who.orgId, call.serverId);
      if (!server) return blocked(null, "not_approved", "That server isn't approved here.");
      const ref = { id: server.id, name: server.name };
      if (server.status !== "active") return blocked(ref, "disabled", `${server.name} is turned off.`);
      if (call.via === "dashboard" && !server.dashboards_allowed) {
        return blocked(ref, "not_in_dashboards", `Dashboards can't use ${server.name}.`);
      }
      const [tool] = await tx.execute<ToolRow>(sql`
      select name, annotations, input_schema, digest, status, tier, dashboards_allowed from app.mcp_tool
      where org_id = ${who.orgId} and server_id = ${server.id} and name = ${call.tool}`);
      if (!tool || tool.status === "removed") {
        return blocked(ref, "unknown_tool", `${server.name} has no tool called ${call.tool}.`);
      }
      if (tool.tier === "blocked")
        return blocked(ref, "tool_blocked", `An admin blocked ${server.name}'s ${tool.name}.`);
      if (call.policy?.readsOnly && tool.annotations?.readOnlyHint !== true) {
        return blocked(ref, "changes_things", `${tool.name} can change things in ${server.name}, and this only reads.`);
      }
      // A change that may delete or overwrite is never made: other changes yes, each one agreed to; destructive ones
      // stay off.
      if (changesDestructively(tool.annotations)) {
        return blocked(
          ref,
          "destructive",
          `${tool.name} can delete or overwrite in ${server.name}: OpenDash doesn't call it.`,
        );
      }
      // A change is made only as the person, through their own account: never through an account the workspace shares,
      // where one member's Allow would act for everyone.
      if (
        tool.annotations?.readOnlyHint !== true &&
        (server.access !== "personal" || server.auth === "none" || !who.userId)
      ) {
        return blocked(
          ref,
          "shared_account",
          `${tool.name} would change things in ${server.name} through an account the workspace shares: OpenDash only makes changes through a person's own account.`,
        );
      }
      if (call.policy?.personal === false && server.access === "personal" && server.auth !== "none") {
        return blocked(
          ref,
          "personal_not_here",
          `${server.name} uses each person's own account, and what it reads here would be seen by others.`,
        );
      }
      // In a dashboard, only tools an admin allowed there, unchanged since they reviewed them.
      if (call.via === "dashboard" && (!tool.dashboards_allowed || tool.status !== "active")) {
        return blocked(ref, "not_in_dashboards", `Dashboards can't use ${server.name}'s ${tool.name}.`);
      }
      if (call.policy?.ownAccount && (server.access !== "personal" || server.auth === "none" || !who.userId)) {
        return blocked(
          ref,
          "own_account",
          `Changes in ${server.name} are made by a person with their own account, and ${server.name} is connected once for the workspace.`,
        );
      }
      checkArguments(tool, args);
      const session = await sessionAccount(deps, tx, who, server);
      if ("outcome" in session) return session;
      const expect = call.policy?.expect;
      if (
        expect &&
        (tool.digest !== expect.digest ||
          session.connection?.id !== expect.connectionId ||
          session.connection?.revision !== expect.accountRevision ||
          session.connection?.scope !== "personal")
      ) {
        return blocked(
          ref,
          "changed_since",
          `Your ${server.name} account or its ${tool.name} changed since you confirmed: nothing was sent.`,
        );
      }
      // Asked last: there's no point agreeing to a call that couldn't run.
      // The admin's tier decides: `ask` (every new tool starts there) shows the person the exact call first; `always`
      // runs, a change too when it adds and never deletes or overwrites (only a destructive one is never called).
      // A yes given on a card holds only for the tool and the account the card was shown for: a tool that changed what
      // it says it does, or another sign-in, since then is asked about again.
      const asks = tool.tier === "ask" || tool.status === "changed";
      const binding = consentBinding(tool.digest, session.connection);
      const agreed =
        call.consented === true || (typeof call.consented === "object" && call.consented.binding === binding);
      if (asks && !agreed) {
        const reason = tool.status === "changed" ? "changed" : "ask";
        return { outcome: { state: "consent", server: ref, tool: tool.name, reason, binding } };
      }
      // A tool that doesn't say it only reads is sent at most once, for every caller (a refusal of its sign-in renews
      // it and stops there): a change must never be made twice.
      return { ...session, changes: tool.annotations?.readOnlyHint !== true };
    },
  );
  if ("outcome" in prepared) return prepared.outcome;
  if (call.deadline !== undefined && Date.now() > call.deadline) {
    return blocked(prepared.ref, "try_again", "It took too long to get ready: nothing was sent. Try again.").outcome;
  }
  const ran = await withSession(
    deps,
    who,
    prepared,
    (client, options) => client.callTool({ name: call.tool, arguments: args }, options),
    BUDGETS.mcp.callMs,
    call.signal,
    (call.once ?? false) || prepared.changes,
  );
  return "outcome" in ran
    ? ran.outcome
    : {
        state: "ready",
        server: prepared.ref,
        scope: prepared.connection?.scope ?? null,
        result: ran.value as CallToolResult,
      };
}

/**
 * Runs `work` on a client connected to the session's server, as its account. Tokens that expire within a minute are
 * refreshed first; a token the server refuses is refreshed once (refresh.ts: one refresh per connection at a time)
 * and the work tried again. A sign-in the server won't refresh marks the connection `reconnect`.
 */
export async function withSession<T>(
  deps: McpDeps,
  who: McpActor,
  given: Session,
  work: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>,
  budgetMs: number = BUDGETS.mcp.callMs,
  stop?: AbortSignal,
  /** No second attempt after a refusal: the sign-in is renewed for next time, and the caller is told nothing ran. */
  sendOnce = false,
): Promise<{ value: T } | { outcome: McpOutcome }> {
  let session = given;
  if (isKey(session.credentials)) return withKey(deps, who, session, work, budgetMs, stop);
  if (session.credentials && expiresSoon(session.credentials)) {
    const fresh = await refreshing(deps, who, session);
    if ("outcome" in fresh) return fresh;
    session = fresh.session;
  }
  for (let attempt = 0; ; attempt++) {
    stop?.throwIfAborted();
    const ran = await once(deps, who, session, work, budgetMs, stop);
    if (!("refused" in ran)) return ran;
    const connection = session.connection as ConnectionRow;
    if (attempt === 0) {
      const fresh = await refreshing(deps, who, session);
      if ("outcome" in fresh) return fresh;
      session = fresh.session;
      if (sendOnce) {
        return blocked(
          session.ref,
          "try_again",
          `${session.ref.name} asked for your sign-in again; it was renewed and nothing was changed. Try once more.`,
        );
      }
      continue;
    }
    // Refused again with tokens just refreshed: only a new sign-in helps.
    const message = "The server refused this account. Connect again.";
    const canConnect = await deps.withTenant(who, async (tx) => {
      await tx.execute(sql`
        update app.mcp_connection set status = 'reconnect', message = ${message}, updated_at = now()
        where org_id = ${who.orgId} and id = ${connection.id} and secret_id = ${connection.secret_id}`);
      return connection.scope === "personal" || isAdmin(tx, who.userId);
    });
    return { outcome: { state: "reconnect", server: session.ref, scope: connection.scope, canConnect, message } };
  }
}

/** A session on an API key: one try; a key the server turns down marks its connection `reconnect`. */
async function withKey<T>(
  deps: McpDeps,
  who: McpActor,
  session: Session,
  work: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>,
  budgetMs: number,
  stop?: AbortSignal,
): Promise<{ value: T } | { outcome: McpOutcome }> {
  const ran = await once(deps, who, session, work, budgetMs, stop);
  if (!("refused" in ran)) return ran;
  const message = "The server refused this key. Add a new one.";
  const connection = session.connection;
  const scope = connection?.scope ?? (session.server.access === "shared" ? "org" : "personal");
  const canConnect = await deps.withTenant(who, async (tx) => {
    if (connection) {
      await tx.execute(sql`
        update app.mcp_connection set status = 'reconnect', message = ${message}, updated_at = now()
        where org_id = ${who.orgId} and id = ${connection.id} and secret_id = ${connection.secret_id}`);
    }
    return scope === "personal" || isAdmin(tx, who.userId);
  });
  return { outcome: { state: "reconnect", server: session.ref, scope, canConnect, message } };
}

async function refreshing(deps: McpDeps, who: McpActor, session: Session) {
  try {
    return await refreshSession(deps, who, session);
  } catch (error) {
    if (error instanceof RefreshFailed) throw new McpCallFailed(error.message, { cause: error });
    throw error;
  }
}

/** Not a Streamable HTTP endpoint: what a server that only speaks the older transport answers a POST with. */
const notStreamable = (error: unknown) => [...causes(error)].some((e) => statusOf(e) === 404 || statusOf(e) === 405);

/**
 * One connection to the server and the work on it; `refused` when the server turned the access token or key down.
 * A server recorded as Streamable HTTP that turns out to speak only the older transport (detection can't tell while
 * every request is refused for want of a sign-in) is connected through that instead, and recorded so.
 */
async function once<T>(
  deps: McpDeps,
  who: McpActor,
  session: Session,
  work: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>,
  budgetMs: number,
  stop?: AbortSignal,
): Promise<{ value: T } | { outcome: McpOutcome } | { refused: true }> {
  const { server, ref, connection, credentials } = session;
  const key = isKey(credentials) ? credentials : null;
  const provider =
    connection && credentials && !isKey(credentials)
      ? new OpenDashOAuthProvider({
          mode: "call",
          redirectUrl: deps.redirectUrl,
          clientName: deps.clientName ?? "OpenDash",
          scopes: server.scopes,
          client: credentials.client,
          tokens: credentials.tokens,
          discovery: connection.discovery as never,
        })
      : undefined;
  // What the server answered, whatever the transport makes of it (the older one throws plain errors on a POST).
  const seen = { refused: false, limited: false };
  // A tool call's request may take as long as the call may (a service's own AI building a metric takes tens of
  // seconds; at the 15 s a sign-in's request gets, Fullstory's build_metric never answered).
  const guarded = fetchFor(deps, { requestMs: BUDGETS.mcp.callMs });
  const fetch: McpFetch = async (input, init) => {
    const signal = stop ? (init?.signal ? AbortSignal.any([init.signal, stop]) : stop) : init?.signal;
    const response = await guarded(input, { ...init, ...(signal ? { signal } : {}) });
    if (response.status === 401 || response.status === 403) seen.refused = true;
    if (response.status === 429) seen.limited = true;
    return response;
  };
  const transportAs = (transport: ServerRow["transport"]) =>
    transportFor(
      deps,
      { url: server.url, transport },
      {
        ...(provider ? { authProvider: provider } : {}),
        ...(key ? { requestInit: { headers: keyHeaders(server, key) } } : {}),
        fetch,
      },
    );
  const newClient = () => new Client({ name: deps.clientName ?? "OpenDash", version: "1.0.0" });
  let client = newClient();
  const timeout = AbortSignal.timeout(budgetMs);
  const options = { signal: stop ? AbortSignal.any([timeout, stop]) : timeout, timeout: budgetMs };
  try {
    try {
      await client.connect(transportAs(server.transport), options);
    } catch (error) {
      if (server.transport !== "streamable" || !notStreamable(error)) throw error;
      await client.close().catch(() => {});
      client = newClient();
      await client.connect(transportAs("sse"), options);
      await deps.withTenant(who, (tx) =>
        tx.execute(sql`
          update app.mcp_server set transport = 'sse', updated_at = now()
          where org_id = ${who.orgId} and id = ${server.id} and transport = 'streamable'`),
      );
    }
    return { value: await work(client, options) };
  } catch (error) {
    if (key ? keyRefused(error) || seen.refused : connection && needsSignIn(error)) return { refused: true };
    if (rateLimited(error) || seen.limited) return { outcome: { state: "rate_limited", server: ref } };
    const refused = refusedAddress(error);
    if (refused) return blocked(ref, "address_refused", refused.message);
    if (stop?.aborted) throw stop.reason ?? new Error("Stopped");
    throw new McpCallFailed(`${server.name} didn't answer.`, { cause: error });
  } finally {
    await client.close().catch(() => {});
  }
}

/** The client transport for this server: Streamable HTTP, or the older HTTP with server-sent events. */
export function transportFor(
  deps: McpDeps,
  server: Pick<ServerRow, "url" | "transport">,
  options: { authProvider?: OpenDashOAuthProvider; requestInit?: RequestInit; fetch?: McpFetch },
): StreamableHTTPClientTransport | SSEClientTransport {
  const { fetch = fetchFor(deps), ...rest } = options;
  if (server.transport === "sse") return new SSEClientTransport(new URL(server.url), { ...rest, fetch });
  return new StreamableHTTPClientTransport(new URL(server.url), { ...rest, fetch });
}
