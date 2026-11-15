/**
 * API keys: a server that takes a key in a header instead of an OAuth sign-in. Each
 * person adds their own on a personal server; an admin adds the one everyone uses on a shared one. A key is tested
 * before it's kept: OpenDash lists the server's tools with it and calls none. It's a secret of kind `mcp` behind its
 * connection, like a token set, and only its last four characters are ever shown.
 */
import { sql, uuidv7 } from "@opendash/db";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { type McpOutcome, withSession } from "./executor";
import {
  isAdmin,
  type KeyCredentials,
  loadServer,
  type McpActor,
  type McpDeps,
  McpProblem,
  requireEnabled,
  resolveConnection,
  type ServerRow,
} from "./shared";

const MAX_KEY = 4_096;
/** Where the key goes in a header's value. */
const KEY_SLOT = "{key}";

/**
 * A key as people paste it: trimmed, and only what a header value can carry (printable ASCII; spaces inside are fine,
 * for a scheme the server wants kept with it). A pasted `Bearer abc` is the key `abc` where the header's own format
 * starts with `Bearer` (and, before formats, on any server); a server whose format is the bare `{key}` gets it as typed.
 */
export function cleanKey(key: string, format?: string | null): string {
  let trimmed = key.trim();
  const prefix = (format ?? "Bearer {key}").split(KEY_SLOT)[0]?.trim() ?? "";
  if (prefix && trimmed.toLowerCase().startsWith(`${prefix.toLowerCase()} `))
    trimmed = trimmed.slice(prefix.length).trim();
  if (trimmed.length < 1 || trimmed.length > MAX_KEY) {
    throw new McpProblem("invalid", `A key is 1 to ${MAX_KEY} characters.`);
  }
  if (!/^[\x20-\x7e]+$/.test(trimmed)) throw new McpProblem("invalid", "That key has characters a header can't carry.");
  return trimmed;
}

/** Headers a key may never go in: the request's own, the transport's, and ones that carry other credentials. */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

/**
 * The header a key goes in: null for Authorization, else a header the server names, as HTTP allows header names, and
 * not one the request or the transport sets itself. Authorization may be named too, to give it a format of its own.
 */
export function cleanKeyHeader(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(trimmed)) {
    throw new McpProblem("invalid", "A header name is letters, digits and dashes, like X-API-Key.");
  }
  if (RESERVED_HEADERS.has(trimmed.toLowerCase()) || trimmed.toLowerCase().startsWith("proxy-")) {
    throw new McpProblem("invalid", `A key can't go in ${trimmed}.`);
  }
  return trimmed;
}

/**
 * What the header's value is, with `{key}` where the key goes: `Bearer {key}`, `Token {key}`, `ApiKey {key}`, or just
 * `{key}`. Null: the default for its header (Bearer in Authorization, the bare key elsewhere).
 */
export function cleanKeyFormat(format: string | null | undefined): string | null {
  const trimmed = format?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) throw new McpProblem("invalid", "A value format is at most 100 characters.");
  if (trimmed.split(KEY_SLOT).length !== 2) {
    throw new McpProblem("invalid", "Put {key} once where the key goes, like Bearer {key}.");
  }
  if (!/^[\x20-\x7e]+$/.test(trimmed)) throw new McpProblem("invalid", "A header value is plain text.");
  return trimmed;
}

/** Where people find their key, in the admin's words. */
export function cleanKeyHint(hint: string | null | undefined): string | null {
  const trimmed = hint?.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length > 300) throw new McpProblem("invalid", "Where to find a key is at most 300 characters.");
  return trimmed;
}

/**
 * How a key is shown: its last four characters, and fewer on a short key: at most a quarter of it, so a label never
 * gives away the key itself (a key of 3 characters shows none).
 */
export function keyLabel(key: string): string {
  const shown = Math.min(4, Math.floor(key.length / 4));
  return `••••${shown ? key.slice(-shown) : ""}`;
}

export interface PutKey {
  state: "ready";
  connectionId: string;
  /** The key as it's shown: its last four characters. */
  label: string;
  /** How many tools the server listed with it. */
  tools: number;
  /** A key replaced one already there. */
  again: boolean;
}

/** Why a key wasn't kept, in words for the person. */
function refusal(outcome: McpOutcome, server: ServerRow): McpProblem {
  if (outcome.state === "rate_limited") {
    return new McpProblem("failed", `${server.name} asked OpenDash to slow down. Try the key again in a minute.`);
  }
  if (outcome.state === "blocked") return new McpProblem("refused", outcome.message);
  return new McpProblem(
    "refused",
    `${server.name} refused it. Check the header name, and that the value is complete as the service wants it, like "Basic …" or "Bearer …". Nothing was saved.`,
  );
}

/**
 * Tests a key and keeps it: a person's own on a personal server, or (an admin's to set) the one everyone uses on a
 * shared one. A key the server turns down is never stored. A new key replaces the old one on the same connection.
 */
export async function putKey(
  deps: McpDeps,
  actor: McpActor & { userId: string },
  input: { serverId: string; key: string },
): Promise<PutKey> {
  requireEnabled();
  const ctx = { orgId: actor.orgId, userId: actor.userId };
  const before = await deps.withTenant(ctx, async (tx) => {
    const server = await loadServer(tx, actor.orgId, input.serverId);
    if (!server) throw new McpProblem("not_found", "That server isn't approved here.");
    if (server.status !== "active") throw new McpProblem("refused", `${server.name} is turned off.`);
    if (server.auth !== "apikey") throw new McpProblem("invalid", `${server.name} doesn't take a key.`);
    if (server.access === "shared" && !(await isAdmin(tx, actor.userId))) {
      throw new McpProblem("forbidden", `Only an admin can set the key everyone uses for ${server.name}.`);
    }
    const existing = await resolveConnection(tx, actor, server);
    if (existing.kind === "needs_person") throw new McpProblem("forbidden", `${server.name} needs a person.`);
    return { server, existing };
  });
  const { server } = before;
  const key = cleanKey(input.key, server.key_format);
  const credentials: KeyCredentials = { kind: "apikey", key };

  // Tested with nothing stored: the tools it lists, and no call.
  const tested = await withSession(
    deps,
    actor,
    { server, ref: { id: server.id, name: server.name }, connection: null, credentials },
    async (client, options) => {
      let count = 0;
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, options);
        count += result.tools.length;
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return count;
    },
    BUDGETS.mcp.listMs,
  );
  if ("outcome" in tested) throw refusal(tested.outcome, server);

  // Kept only if nothing changed the connection while the key was tested: the same connection, holding the same
  // secret (or still none). A conflict throws inside the transaction, so the new secret goes with it.
  const changed = () =>
    new McpProblem("refused", `The key for ${server.name} changed while this one was tested. Try again.`);
  const heldSecret = before.existing.kind === "found" ? before.existing.connection.secret_id : null;
  return deps.withTenant(ctx, async (tx) => {
    const now = await resolveConnection(tx, actor, server);
    if (now.kind === "needs_person") throw new McpProblem("forbidden", `${server.name} needs a person.`);
    if ((now.kind === "found" ? now.connection.secret_id : null) !== heldSecret) throw changed();
    const secretId = await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(credentials));
    const label = keyLabel(key);
    let connectionId: string;
    if (now.kind === "found") {
      connectionId = now.connection.id;
      const updated = await tx.execute(sql`
        update app.mcp_connection
        set secret_id = ${secretId}, account = ${label}, account_key = null, issuer = null, discovery = null,
            status = 'ready', message = null, revision = revision + 1, connected_by = ${actor.userId},
            updated_at = now(), refreshed_at = null
        where org_id = ${actor.orgId} and id = ${connectionId} and secret_id = ${heldSecret}
        returning id`);
      if (!updated.length) throw changed();
      await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${heldSecret}`);
    } else {
      connectionId = uuidv7();
      const conflict =
        now.scope === "personal"
          ? sql`on conflict (org_id, server_id, scope_id) where scope = 'personal' do nothing`
          : sql`on conflict (org_id, server_id) where scope = 'org' do nothing`;
      const inserted = await tx.execute(sql`
        insert into app.mcp_connection (org_id, id, server_id, scope, scope_id, secret_id, account, connected_by)
        values (${actor.orgId}, ${connectionId}, ${server.id}, ${now.scope},
                ${now.scope === "personal" ? actor.userId : null}, ${secretId}, ${label}, ${actor.userId})
        ${conflict}
        returning id`);
      if (!inserted.length) throw changed();
    }
    await audit(tx, {
      action: "mcp_connection.connected",
      target: { type: "mcp_server", id: server.id, name: server.name },
      detail: { scope: now.scope, kind: "apikey", again: now.kind === "found" },
    });
    return { state: "ready", connectionId, label, tools: tested.value, again: now.kind === "found" };
  });
}
