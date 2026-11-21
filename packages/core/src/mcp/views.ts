/**
 * What Settings shows of MCP connections: the servers an admin approved, one server's page, and a
 * person's own connections. Nothing here reveals a secret: an account is its label (an email from the sign-in, or a
 * key's last four), and admins see only counts of people's own connections (app.mcp_connection_counts), never who.
 */
import { sql, type TenantTx } from "@opendash/db";
import {
  type ConnectionRow,
  isAdmin,
  type McpActor,
  type McpDeps,
  McpProblem,
  requireEnabled,
  resolveConnection,
  type ServerRow,
} from "./shared";

/** A connection as Settings shows it. */
export interface ConnectionView {
  account: string | null;
  status: ConnectionRow["status"];
  message: string | null;
  connectedAt: Date;
}

export interface ToolCounts {
  total: number;
  always: number;
  ask: number;
  blocked: number;
  /** Changed since an admin reviewed it: asks first until reviewed again. */
  changed: number;
}

export interface ServerView {
  id: string;
  name: string;
  url: string;
  host: string;
  transport: ServerRow["transport"];
  auth: ServerRow["auth"];
  access: ServerRow["access"];
  status: ServerRow["status"];
  /** Whether dashboards may use it. */
  dashboardsAllowed: boolean;
  keyHeader: string | null;
  keyFormat: string | null;
  keyHint: string | null;
  /** OAuth: the client is one an admin entered (else OpenDash registers itself). */
  clientEntered: boolean;
  issuer: string | null;
  toolsListedAt: Date | null;
  tools: ToolCounts;
  /** The one account everyone uses (shared servers that sign in). */
  shared: ConnectionView | null;
  /** The viewer's own account (personal servers). */
  mine: ConnectionView | null;
  /** How many people connected their own, and how many of those need to again (admins only; personal servers). */
  people: { connected: number; attention: number } | null;
}

export interface ToolView {
  name: string;
  title: string | null;
  description: string | null;
  /** What the server says about it (readOnlyHint, destructiveHint…): hints, not promises. */
  readOnly: boolean;
  tier: "always" | "ask" | "blocked";
  status: "active" | "changed" | "removed";
  dashboardsAllowed: boolean;
  /** The input it takes, as listed. */
  inputSchema: Record<string, unknown>;
}

export interface ServerDetail extends ServerView {
  tools_: ToolView[];
}

type ServerQueryRow = ServerRow & {
  tools_listed_at: Date | null;
  total: number;
  always: number;
  ask: number;
  blocked: number;
  changed: number;
};

type ConnectionQueryRow = {
  server_id: string;
  scope: "org" | "personal";
  account: string | null;
  status: ConnectionRow["status"];
  message: string | null;
  created_at: Date;
};

const viewOf = (c: ConnectionQueryRow | undefined): ConnectionView | null =>
  c ? { account: c.account, status: c.status, message: c.message, connectedAt: c.created_at } : null;

async function serverRows(tx: TenantTx, orgId: string, serverId?: string): Promise<ServerQueryRow[]> {
  return tx.execute<ServerQueryRow>(sql`
    select s.id, s.name, s.url, s.transport, s.auth, s.access, s.dashboards_allowed, s.status, s.scopes,
           s.client_secret_id, s.client_source, s.issuer, s.key_header, s.key_format, s.key_hint, s.tools_listed_at,
           count(t.name) filter (where t.status <> 'removed')::int as total,
           count(t.name) filter (where t.status = 'active' and t.tier = 'always')::int as always,
           -- A changed tool asks first until it's reviewed, whatever its tier says.
           count(t.name) filter (where t.status <> 'removed' and t.tier <> 'blocked'
                                   and (t.tier = 'ask' or t.status = 'changed'))::int as ask,
           count(t.name) filter (where t.status <> 'removed' and t.tier = 'blocked')::int as blocked,
           count(t.name) filter (where t.status = 'changed')::int as changed
    from app.mcp_server s
    left join app.mcp_tool t on t.org_id = s.org_id and t.server_id = s.id
    where s.org_id = ${orgId} ${serverId ? sql`and s.id = ${serverId}` : sql``}
    group by s.org_id, s.id
    order by s.name`);
}

/** The connections this person can see: the workspace's ones, and their own (row security hides the rest). */
async function visibleConnections(tx: TenantTx, actor: McpActor): Promise<ConnectionQueryRow[]> {
  return tx.execute<ConnectionQueryRow>(sql`
    select server_id, scope, account, status, message, created_at from app.mcp_connection
    where org_id = ${actor.orgId}
      and (scope = 'org' or (scope = 'personal' and scope_id = ${actor.userId}::uuid))`);
}

function toView(
  row: ServerQueryRow,
  connections: ConnectionQueryRow[],
  counts: Map<string, { connected: number; attention: number }> | null,
): ServerView {
  const mine = connections.find((c) => c.server_id === row.id && c.scope === "personal");
  const shared = connections.find((c) => c.server_id === row.id && c.scope === "org");
  let host = row.url;
  try {
    host = new URL(row.url).host;
  } catch {}
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    host,
    transport: row.transport,
    auth: row.auth,
    access: row.access,
    status: row.status,
    dashboardsAllowed: row.dashboards_allowed,
    keyHeader: row.key_header,
    keyFormat: row.key_format,
    keyHint: row.key_hint,
    clientEntered: row.client_source === "admin",
    issuer: row.issuer,
    toolsListedAt: row.tools_listed_at,
    tools: { total: row.total, always: row.always, ask: row.ask, blocked: row.blocked, changed: row.changed },
    // A setting switched between personal and shared keeps the other kind's accounts, unused: show what calls use.
    shared: row.access === "shared" ? viewOf(shared) : null,
    mine: row.access === "personal" ? viewOf(mine) : null,
    people: counts && row.access === "personal" ? (counts.get(row.id) ?? { connected: 0, attention: 0 }) : null,
  };
}

async function peopleCounts(tx: TenantTx) {
  const rows = await tx.execute<{ server_id: string; connected: number; attention: number }>(
    sql`select server_id, connected, attention from app.mcp_connection_counts()`,
  );
  return new Map(rows.map((r) => [r.server_id, { connected: r.connected, attention: r.attention }]));
}

/** Settings → Connections: every server approved here, for owners and admins. */
export async function listServers(deps: McpDeps, actor: McpActor & { userId: string }): Promise<ServerView[]> {
  requireEnabled();
  return deps.withTenant(actor, async (tx) => {
    if (!(await isAdmin(tx, actor.userId))) throw new McpProblem("forbidden", "Only an owner or admin can do that.");
    const [rows, connections, counts] = await Promise.all([
      serverRows(tx, actor.orgId),
      visibleConnections(tx, actor),
      peopleCounts(tx),
    ]);
    return rows.map((r) => toView(r, connections, counts));
  });
}

/** One server's page: how it signs in, who uses it, and its tools. Owners and admins. */
export async function serverDetail(
  deps: McpDeps,
  actor: McpActor & { userId: string },
  serverId: string,
): Promise<ServerDetail> {
  requireEnabled();
  return deps.withTenant(actor, async (tx) => {
    if (!(await isAdmin(tx, actor.userId))) throw new McpProblem("forbidden", "Only an owner or admin can do that.");
    const [row] = await serverRows(tx, actor.orgId, serverId);
    if (!row) throw new McpProblem("not_found", "That server isn't approved here.");
    const [connections, counts, tools] = await Promise.all([
      visibleConnections(tx, actor),
      peopleCounts(tx),
      tx.execute<{
        name: string;
        title: string | null;
        description: string | null;
        annotations: Record<string, unknown>;
        tier: ToolView["tier"];
        status: ToolView["status"];
        dashboards_allowed: boolean;
        input_schema: Record<string, unknown>;
      }>(sql`
        select name, title, description, annotations, tier, status, dashboards_allowed, input_schema from app.mcp_tool
        where org_id = ${actor.orgId} and server_id = ${serverId} and status <> 'removed'
        order by (status = 'changed') desc, coalesce(annotations ->> 'readOnlyHint' = 'true', false) desc, name`),
    ]);
    return {
      ...toView(row, connections, counts),
      tools_: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        readOnly: t.annotations?.readOnlyHint === true,
        tier: t.tier,
        status: t.status,
        dashboardsAllowed: t.dashboards_allowed,
        inputSchema: t.input_schema,
      })),
    };
  });
}

export interface MyConnection {
  id: string;
  name: string;
  host: string;
  auth: ServerRow["auth"];
  access: ServerRow["access"];
  keyHint: string | null;
  /** Personal servers: this person's own account, or none yet. */
  mine: ConnectionView | null;
  /** Shared servers: the one account everyone uses (null: no sign-in, or not connected yet). */
  shared: ConnectionView | null;
  /** How many tools it offers here. */
  tools: number;
}

/** Settings → My connections: every server turned on here, with this person's own account where it's theirs. */
export async function myConnections(deps: McpDeps, actor: McpActor & { userId: string }): Promise<MyConnection[]> {
  requireEnabled();
  return deps.withTenant(actor, async (tx) => {
    const [rows, connections] = await Promise.all([serverRows(tx, actor.orgId), visibleConnections(tx, actor)]);
    return rows
      .filter((r) => r.status === "active")
      .map((r) => {
        const view = toView(r, connections, null);
        return {
          id: view.id,
          name: view.name,
          host: view.host,
          auth: view.auth,
          access: view.access,
          keyHint: view.keyHint,
          mine: view.mine,
          shared: view.shared,
          tools: view.tools.total,
        };
      });
  });
}

export interface FoundTool {
  name: string;
  title: string | null;
  description: string | null;
  /** The server says it only reads. */
  readOnly: boolean;
  /** It asks the person before each call (its tier, or a change an admin hasn't reviewed). */
  asks: boolean;
  /** It may delete or overwrite (the server says so, or doesn't say otherwise): never called. */
  destructive: boolean;
  /** Its input, as the server lists it (JSON Schema). */
  inputSchema: Record<string, unknown>;
}

/**
 * A tool that changes things and may delete or overwrite: the server says destructiveHint, or doesn't say it isn't
 * (MCP's default for a tool that isn't read-only). OpenDash never calls one.
 */
export const changesDestructively = (hints: { readOnlyHint?: boolean; destructiveHint?: boolean } | null | undefined) =>
  hints?.readOnlyHint !== true && hints?.destructiveHint !== false;

export interface FoundServer {
  id: string;
  name: string;
  auth: ServerRow["auth"];
  access: ServerRow["access"];
  /** Whether a call can run as this person now, or what they'd have to do first. */
  state: "ready" | "connect" | "reconnect" | "wrong_account" | "needs_person";
  tools: FoundTool[];
}

/**
 * Every server turned on here, each with where this person stands and every tool on it that can be used (not blocked,
 * not gone), for the analyst's mcp_find, which picks what to show of them. A server is never left out, with or without
 * tools: one that went missing would read as one that isn't connected. Its descriptions are what servers wrote: data,
 * never instructions.
 */
export async function findTools(deps: McpDeps, actor: McpActor): Promise<FoundServer[]> {
  requireEnabled();
  return deps.withTenant(actor, async (tx) => {
    const servers = await tx.execute<ServerRow>(sql`
      select s.id, s.name, s.url, s.transport, s.auth, s.access, s.dashboards_allowed, s.status, s.scopes,
             s.client_secret_id, s.client_source, s.issuer, s.key_header, s.key_format, s.key_hint
      from app.mcp_server s where s.org_id = ${actor.orgId} and s.status = 'active' order by s.name`);
    if (!servers.length) return [];
    const tools = await tx.execute<{
      server_id: string;
      name: string;
      title: string | null;
      description: string | null;
      annotations: Record<string, unknown>;
      tier: string;
      status: string;
      input_schema: Record<string, unknown>;
    }>(sql`
      select server_id, name, title, description, annotations, tier, status, input_schema from app.mcp_tool
      where org_id = ${actor.orgId} and status <> 'removed' and tier <> 'blocked' order by name`);
    const out: FoundServer[] = [];
    for (const server of servers) {
      let state: FoundServer["state"] = "ready";
      if (server.auth !== "none") {
        const resolved = await resolveConnection(tx, actor, server);
        state =
          resolved.kind === "needs_person"
            ? "needs_person"
            : resolved.kind === "missing"
              ? "connect"
              : resolved.connection.status === "ready"
                ? "ready"
                : resolved.connection.status;
      }
      out.push({
        id: server.id,
        name: server.name,
        auth: server.auth,
        access: server.access,
        state,
        tools: tools
          .filter((t) => t.server_id === server.id)
          .map((t) => ({
            name: t.name,
            title: t.title,
            // Whole: how to call a tool well is often in the rest of its description.
            description: t.description ?? null,
            readOnly: t.annotations?.readOnlyHint === true,
            asks: t.tier === "ask" || t.status === "changed",
            destructive: changesDestructively(t.annotations),
            inputSchema: t.input_schema ?? {},
          })),
      });
    }
    return out;
  });
}
