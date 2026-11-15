/**
 * What admins do with MCP servers: approve one, change how it's shared or whether dashboards may use it, turn
 * it off, remove it; list its tools and set each one's tier. Every write here checks the caller is an owner or admin
 * of the workspace and goes in the audit log.
 *
 * A tool's digest covers its name, title, description, input schema and hints, as the server lists them. A tool new to
 * OpenDash runs without asking (`always`) only when the server says it's read-only, otherwise it asks; and it's out of
 * dashboards until an admin lets it in. A listing that changes a tool's digest makes it `changed`: out of dashboards, and asking
 * first, until an admin reviews it.
 */
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { type McpOutcome, type ServerRef, sessionAccount, withSession } from "./executor";
import { checkAddress, McpNetworkError } from "./fetch";
import { cleanKeyFormat, cleanKeyHeader, cleanKeyHint } from "./keys";
import { isAdmin, loadServer, type McpActor, type McpDeps, McpProblem, requireEnabled, type ServerRow } from "./shared";

type Admin = McpActor & { userId: string };

async function requireAdmin(tx: TenantTx, actor: Admin): Promise<void> {
  if (!(await isAdmin(tx, actor.userId))) throw new McpProblem("forbidden", "Only an owner or admin can do that.");
}

async function adminServer(tx: TenantTx, actor: Admin, serverId: string, lock = false): Promise<ServerRow> {
  await requireAdmin(tx, actor);
  const server = await loadServer(tx, actor.orgId, serverId, lock);
  if (!server) throw new McpProblem("not_found", "That server isn't approved here.");
  return server;
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new McpProblem("invalid", "A server's name is 1 to 80 characters.");
  return trimmed;
}

function cleanScopes(scopes: string | null | undefined): string | null {
  const trimmed = scopes?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500 || !/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(trimmed)) {
    throw new McpProblem("invalid", "Scopes are words separated by single spaces.");
  }
  return trimmed;
}

/** An OAuth client an admin made at the service, for a server that can't register OpenDash itself. */
export interface EnteredClient {
  clientId: string;
  clientSecret?: string | null;
  /**
   * The authorization server it was made at, as detection found it. The client is bound to it: a sign-in that finds
   * another one stops before anything is sent there.
   */
  issuer: string;
}

function cleanClient(client: EnteredClient): { client_id: string; client_secret?: string; issuer: string } {
  const clientId = client.clientId.trim();
  const secret = client.clientSecret?.trim();
  const issuer = client.issuer?.trim() ?? "";
  let issuerUrl: URL | null = null;
  try {
    issuerUrl = new URL(issuer);
  } catch {}
  if (!issuerUrl || !["https:", "http:"].includes(issuerUrl.protocol) || issuer.length > 500) {
    throw new McpProblem("invalid", "Check how the server signs in first: a client is bound to where it was made.");
  }
  if (!clientId || clientId.length > 500 || !/^[\x21-\x7e]+$/.test(clientId)) {
    throw new McpProblem("invalid", "A client ID is up to 500 characters, with no spaces.");
  }
  if (secret !== undefined && secret !== "" && (secret.length > 2_000 || !/^[\x21-\x7e]+$/.test(secret))) {
    throw new McpProblem("invalid", "A client secret is up to 2,000 characters, with no spaces.");
  }
  return { client_id: clientId, ...(secret ? { client_secret: secret } : {}), issuer };
}

export interface ApproveServer {
  name: string;
  url: string;
  /** How it signs people in, as detection found (detect.ts). A server that needs none is always shared. */
  auth?: "oauth" | "apikey" | "none";
  transport?: "streamable" | "sse";
  access?: "personal" | "shared";
  dashboardsAllowed?: boolean;
  scopes?: string | null;
  /** OAuth: a client an admin made at the service, when it can't register OpenDash itself. */
  client?: EnteredClient | null;
  /** API key: the header it goes in (null: Authorization: Bearer), and where people find theirs. */
  keyHeader?: string | null;
  keyFormat?: string | null;
  keyHint?: string | null;
}

export async function approveServer(deps: McpDeps, actor: Admin, input: ApproveServer): Promise<{ id: string }> {
  requireEnabled();
  const name = cleanName(input.name);
  let url: URL;
  try {
    url = await checkAddress(input.url, deps.edition);
  } catch (error) {
    throw new McpProblem(
      "refused",
      error instanceof McpNetworkError ? `${error.message}.` : "That address can't be used.",
    );
  }
  const auth = input.auth ?? "oauth";
  const transport = input.transport ?? "streamable";
  // Nothing to sign in with means one connection for everyone.
  const access = auth === "none" ? "shared" : (input.access ?? "personal");
  const client = auth === "oauth" && input.client ? cleanClient(input.client) : null;
  const keyHeader = auth === "apikey" ? cleanKeyHeader(input.keyHeader) : null;
  const keyFormat = auth === "apikey" ? cleanKeyFormat(input.keyFormat) : null;
  const keyHint = auth === "apikey" ? cleanKeyHint(input.keyHint) : null;
  return deps.withTenant(actor, async (tx) => {
    await requireAdmin(tx, actor);
    const [taken] = await tx.execute<{ id: string }>(sql`
      select id from app.mcp_server where org_id = ${actor.orgId} and url = ${url.href}`);
    if (taken) throw new McpProblem("invalid", "That server is already approved.");
    const id = uuidv7();
    const clientSecretId = client ? await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(client)) : null;
    await tx.execute(sql`
      insert into app.mcp_server (org_id, id, name, url, transport, auth, access, dashboards_allowed, scopes,
                                  client_secret_id, client_source, issuer, key_header, key_format, key_hint, created_by)
      values (${actor.orgId}, ${id}, ${name}, ${url.href}, ${transport}, ${auth}, ${access},
              ${input.dashboardsAllowed ?? false}, ${cleanScopes(input.scopes)}, ${clientSecretId},
              ${client ? "admin" : "auto"}, ${client?.issuer ?? null}, ${keyHeader}, ${keyFormat}, ${keyHint}, ${actor.userId})`);
    await audit(tx, {
      action: "mcp_server.approved",
      target: { type: "mcp_server", id, name },
      detail: { access, auth, ...(transport === "sse" ? { transport } : {}), ...(client ? { client: "admin" } : {}) },
    });
    return { id };
  });
}

export interface UpdateServer {
  name?: string;
  access?: "personal" | "shared";
  dashboardsAllowed?: boolean;
  status?: "active" | "disabled";
  scopes?: string | null;
  /** Detection found it moved to the other transport. */
  transport?: "streamable" | "sse";
  /** API key servers: the header and where people find theirs. */
  keyHeader?: string | null;
  keyFormat?: string | null;
  keyHint?: string | null;
  /**
   * OAuth: replace the client with one an admin made (`null`: drop it and let OpenDash register on the next sign-in).
   * Connections keep the registration their tokens were issued to until they sign in again.
   */
  client?: EnteredClient | null;
}

/**
 * Changes a server. Switching it between personal and shared keeps the accounts already connected (people's own, or
 * the workspace's), unused until it's switched back; a call uses only what the new setting says.
 */
export async function updateServer(deps: McpDeps, actor: Admin, serverId: string, patch: UpdateServer): Promise<void> {
  requireEnabled();
  await deps.withTenant(actor, async (tx) => {
    const server = await adminServer(tx, actor, serverId, true);
    const name = patch.name === undefined ? server.name : cleanName(patch.name);
    const scopes = patch.scopes === undefined ? server.scopes : cleanScopes(patch.scopes);
    if (server.auth === "none" && patch.access === "personal") {
      throw new McpProblem("invalid", `${server.name} needs no sign-in, so there's one connection for everyone.`);
    }
    if (
      server.auth !== "apikey" &&
      (patch.keyHeader !== undefined || patch.keyFormat !== undefined || patch.keyHint !== undefined)
    ) {
      throw new McpProblem("invalid", `${server.name} doesn't take a key.`);
    }
    if (server.auth !== "oauth" && patch.client !== undefined) {
      throw new McpProblem("invalid", `${server.name} doesn't sign in with OAuth.`);
    }
    const keyHeader = patch.keyHeader === undefined ? server.key_header : cleanKeyHeader(patch.keyHeader);
    const keyFormat = patch.keyFormat === undefined ? server.key_format : cleanKeyFormat(patch.keyFormat);
    const keyHint = patch.keyHint === undefined ? server.key_hint : cleanKeyHint(patch.keyHint);
    let clientSecretId = server.client_secret_id;
    let clientSource = server.client_source;
    let issuer = server.issuer;
    if (patch.client !== undefined) {
      const client = patch.client ? cleanClient(patch.client) : null;
      clientSecretId = client ? await deps.secrets.put(tx, actor.orgId, "mcp", JSON.stringify(client)) : null;
      clientSource = client ? "admin" : "auto";
      issuer = client?.issuer ?? null;
    }
    await tx.execute(sql`
      update app.mcp_server
      set name = ${name}, access = ${patch.access ?? server.access},
          dashboards_allowed = ${patch.dashboardsAllowed ?? server.dashboards_allowed}, status = ${patch.status ?? server.status},
          scopes = ${scopes}, transport = ${patch.transport ?? server.transport}, key_header = ${keyHeader},
          key_format = ${keyFormat}, key_hint = ${keyHint}, client_secret_id = ${clientSecretId}, client_source = ${clientSource},
          issuer = ${issuer}, updated_at = now()
      where org_id = ${actor.orgId} and id = ${serverId}`);
    if (patch.client !== undefined && server.client_secret_id) {
      await tx.execute(sql`delete from app.secret where org_id = ${actor.orgId} and id = ${server.client_secret_id}`);
    }
    const fields = Object.keys(patch).filter((k) => patch[k as keyof UpdateServer] !== undefined);
    await audit(tx, {
      action: "mcp_server.updated",
      target: { type: "mcp_server", id: serverId, name },
      fields,
      detail: {
        ...(patch.access ? { access: patch.access } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.dashboardsAllowed !== undefined ? { dashboards: patch.dashboardsAllowed } : {}),
        ...(patch.transport ? { transport: patch.transport } : {}),
      },
    });
  });
}

/** Removes a server with its tools, every connection to it (everyone's) and their secrets (migration 0086). */
export async function removeServer(deps: McpDeps, actor: Admin, serverId: string): Promise<void> {
  requireEnabled();
  await deps.withTenant(actor, async (tx) => {
    const server = await adminServer(tx, actor, serverId);
    await tx.execute(sql`delete from app.mcp_server where org_id = ${actor.orgId} and id = ${serverId}`);
    await audit(tx, { action: "mcp_server.removed", target: { type: "mcp_server", id: serverId, name: server.name } });
  });
}

/** JSON with its keys sorted at every level, so a digest doesn't change with key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function toolDigest(tool: Pick<Tool, "name" | "title" | "description" | "inputSchema" | "annotations">): string {
  const listed = {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations ?? {},
  };
  return createHash("sha256").update(canonical(listed), "utf8").digest("hex");
}

const MAX_SCHEMA_BYTES = 64_000;

export interface ListedTools {
  state: "ready";
  added: string[];
  changed: string[];
  removed: string[];
  /** Tools past BUDGETS.mcp.maxTools, or with a schema too large to keep, that weren't recorded. */
  skipped: number;
}

/**
 * Lists a server's tools as this admin's session sees them (their own account on a personal server, the workspace's
 * on a shared one) and records them. Answers with what changed, or the state that kept it from listing.
 */
export async function listServerTools(
  deps: McpDeps,
  actor: Admin,
  serverId: string,
): Promise<ListedTools | Exclude<McpOutcome, { state: "ready" }>> {
  requireEnabled();
  const session = await deps.withTenant(actor, async (tx) => {
    const server = await adminServer(tx, actor, serverId);
    if (server.status !== "active") throw new McpProblem("refused", `${server.name} is turned off.`);
    return sessionAccount(deps, tx, actor, server);
  });
  if ("outcome" in session) return session.outcome as Exclude<McpOutcome, { state: "ready" }>;

  const listed = await withSession(
    deps,
    actor,
    session,
    async (client, options) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      let skipped = 0;
      for (let page = 0; page < 50; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, options);
        for (const tool of result.tools) {
          if (tools.length >= BUDGETS.mcp.maxTools) skipped++;
          else if (Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), "utf8") > MAX_SCHEMA_BYTES) skipped++;
          else tools.push(tool);
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return { tools, skipped };
    },
    BUDGETS.mcp.listMs,
  );
  if ("outcome" in listed) return listed.outcome as Exclude<McpOutcome, { state: "ready" }>;
  return deps.withTenant(actor, (tx) => recordTools(tx, actor, session.ref, listed.value.tools, listed.value.skipped));
}

async function recordTools(
  tx: TenantTx,
  actor: Admin,
  server: ServerRef,
  tools: Tool[],
  skipped: number,
): Promise<ListedTools> {
  // One listing records at a time: two at once (the add dialog's, and the page's on hearing the sign-in land) would
  // each find no tools and both insert them, the second failing on the key.
  await tx.execute(sql`select 1 from app.mcp_server where org_id = ${actor.orgId} and id = ${server.id} for update`);
  const known = await tx.execute<{ name: string; digest: string; reviewed_digest: string; status: string }>(sql`
    select name, digest, reviewed_digest, status from app.mcp_tool where org_id = ${actor.orgId} and server_id = ${server.id}`);
  const byName = new Map(known.map((t) => [t.name, t]));
  const out: ListedTools = { state: "ready", added: [], changed: [], removed: [], skipped };
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const digest = toolDigest(tool);
    const fields = {
      title: tool.title?.slice(0, 200) ?? null,
      description: tool.description?.slice(0, 4_000) ?? null,
      schema: JSON.stringify(tool.inputSchema ?? {}),
      annotations: JSON.stringify(tool.annotations ?? {}),
    };
    const before = byName.get(tool.name);
    if (!before) {
      const tier = tool.annotations?.readOnlyHint === true ? "always" : "ask";
      await tx.execute(sql`
        insert into app.mcp_tool (org_id, server_id, name, title, description, input_schema, annotations, digest,
                                  reviewed_digest, tier)
        values (${actor.orgId}, ${server.id}, ${tool.name}, ${fields.title}, ${fields.description},
                ${fields.schema}::jsonb, ${fields.annotations}::jsonb, ${digest}, ${digest}, ${tier})`);
      out.added.push(tool.name);
      continue;
    }
    const status = digest === before.reviewed_digest ? "active" : "changed";
    if (digest !== before.digest || status !== before.status) {
      await tx.execute(sql`
        update app.mcp_tool
        set title = ${fields.title}, description = ${fields.description}, input_schema = ${fields.schema}::jsonb,
            annotations = ${fields.annotations}::jsonb, digest = ${digest}, status = ${status}, listed_at = now(),
            updated_at = now()
        where org_id = ${actor.orgId} and server_id = ${server.id} and name = ${tool.name}`);
      if (status === "changed" && before.status !== "changed") out.changed.push(tool.name);
    } else {
      await tx.execute(sql`
        update app.mcp_tool set listed_at = now()
        where org_id = ${actor.orgId} and server_id = ${server.id} and name = ${tool.name}`);
    }
  }
  for (const before of known) {
    if (seen.has(before.name) || before.status === "removed") continue;
    await tx.execute(sql`
      update app.mcp_tool set status = 'removed', updated_at = now()
      where org_id = ${actor.orgId} and server_id = ${server.id} and name = ${before.name}`);
    out.removed.push(before.name);
  }
  await tx.execute(sql`
    update app.mcp_server set tools_listed_at = now() where org_id = ${actor.orgId} and id = ${server.id}`);
  return out;
}

export interface UpdateTool {
  tier?: "always" | "ask" | "blocked";
  dashboardsAllowed?: boolean;
  /** The admin has looked at a changed tool and accepts it as it's listed now. */
  reviewed?: boolean;
}

export async function updateTool(
  deps: McpDeps,
  actor: Admin,
  serverId: string,
  name: string,
  patch: UpdateTool,
): Promise<void> {
  requireEnabled();
  await deps.withTenant(actor, async (tx) => {
    const server = await adminServer(tx, actor, serverId);
    const updated = await tx.execute(sql`
      update app.mcp_tool
      set tier = coalesce(${patch.tier ?? null}, tier),
          dashboards_allowed = coalesce(${patch.dashboardsAllowed ?? null}::boolean, dashboards_allowed),
          reviewed_digest = case when ${patch.reviewed === true} then digest else reviewed_digest end,
          status = case when ${patch.reviewed === true} and status = 'changed' then 'active' else status end,
          updated_at = now()
      where org_id = ${actor.orgId} and server_id = ${serverId} and name = ${name}
      returning name`);
    if (!updated.length) throw new McpProblem("not_found", `${server.name} has no tool called ${name}.`);
    await audit(tx, {
      action: "mcp_tool.updated",
      target: { type: "mcp_server", id: serverId, name: server.name },
      fields: Object.keys(patch).filter((k) => patch[k as keyof UpdateTool] !== undefined),
      detail: {
        tool: name.slice(0, 64),
        ...(patch.tier ? { tier: patch.tier } : {}),
        ...(patch.dashboardsAllowed !== undefined ? { dashboards: patch.dashboardsAllowed } : {}),
        ...(patch.reviewed ? { reviewed: true } : {}),
      },
    });
  });
}
