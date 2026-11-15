import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { secret } from "./sources";

/**
 * An MCP server an admin approved for the workspace. People connect their own accounts to a `personal`
 * server; a `shared` server has one account, connected by an admin, that everyone's calls use. A server signs people
 * in with OAuth, takes an API key, or needs nothing (and then it's always shared). Its OAuth client registration is one
 * secret of kind `mcp`: made on the first connect (dynamic registration) and bound to the authorization server that
 * issued it, or entered by an admin for a server that can't register OpenDash itself.
 */
export const mcpServer = app
  .table(
    "mcp_server",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      name: text("name").notNull(),
      /** The server's MCP endpoint. */
      url: text("url").notNull(),
      /** How OpenDash talks to it: Streamable HTTP, or the older HTTP with server-sent events. */
      transport: text("transport").notNull().default("streamable"),
      /** How people sign in to it: OAuth, an API key, or nothing (a server that needs no account). */
      auth: text("auth").notNull().default("oauth"),
      /** For an API key: the header it goes in; null: `Authorization`. */
      keyHeader: text("key_header"),
      /**
       * For an API key: what the header's value is, with `{key}` where the key goes (`Bearer {key}`, `Token {key}`,
       * `{key}`). Null: `Bearer {key}` in Authorization, and the bare key in any other header.
       */
      keyFormat: text("key_format"),
      /** For an API key: where people find theirs, in the admin's words. */
      keyHint: text("key_hint"),
      /** Who made the OAuth client registration: OpenDash on the first connect, or an admin who entered one. */
      clientSource: text("client_source").notNull().default("auto"),
      access: text("access").notNull().default("personal"),
      /** Whether dashboards may read it at all; each tool says so too. */
      dashboardsAllowed: boolean("dashboards_allowed").notNull().default(false),
      status: text("status").notNull().default("active"),
      /** The OAuth scopes to ask for; null: what the server's metadata offers. */
      scopes: text("scopes"),
      /** OpenDash's client registration at the server's authorization server: a secret of kind `mcp`. */
      clientSecretId: uuid("client_secret_id"),
      /** The authorization server that registration belongs to. */
      issuer: text("issuer"),
      toolsListedAt: timestamp("tools_listed_at", { withTimezone: true }),
      createdBy: uuid("created_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      uniqueIndex("mcp_server_url_uq").on(t.orgId, t.url),
      foreignKey({ columns: [t.orgId, t.clientSecretId], foreignColumns: [secret.orgId, secret.id] }),
      check("mcp_server_auth_check", sql`${t.auth} in ('oauth', 'apikey', 'none')`),
      check("mcp_server_access_check", sql`${t.access} in ('personal', 'shared')`),
      check("mcp_server_none_shared_check", sql`${t.auth} <> 'none' or ${t.access} = 'shared'`),
      check("mcp_server_transport_check", sql`${t.transport} in ('streamable', 'sse')`),
      check("mcp_server_client_source_check", sql`${t.clientSource} in ('auto', 'admin')`),
      // A client an admin entered is bound to the authorization server it was made at.
      check("mcp_server_client_issuer_check", sql`${t.clientSource} <> 'admin' or ${t.issuer} is not null`),
      check("mcp_server_status_check", sql`${t.status} in ('active', 'disabled')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A tool an approved server offers, as it was last listed. Its tier says whether a call runs (`always`), waits for the
 * person to agree (`ask`) or never runs (`blocked`). A tool whose name, description, schema or hints change is
 * `changed` and left out of dashboards until an admin reviews it; one the server stopped offering is `removed`.
 */
export const mcpTool = app
  .table(
    "mcp_tool",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      serverId: uuid("server_id").notNull(),
      name: text("name").notNull(),
      title: text("title"),
      description: text("description"),
      inputSchema: jsonb("input_schema").notNull().default({}),
      /** The server's hints (readOnlyHint, destructiveHint, …): what it says, not what we trust. */
      annotations: jsonb("annotations").notNull().default({}),
      /** sha256 over the name, description, input schema and hints, as listed. */
      digest: text("digest").notNull(),
      /** The digest an admin last accepted; a listing with another one makes the tool `changed`. */
      reviewedDigest: text("reviewed_digest").notNull(),
      status: text("status").notNull().default("active"),
      tier: text("tier").notNull().default("ask"),
      dashboardsAllowed: boolean("dashboards_allowed").notNull().default(false),
      listedAt: timestamp("listed_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.serverId, t.name] }),
      foreignKey({ columns: [t.orgId, t.serverId], foreignColumns: [mcpServer.orgId, mcpServer.id] }).onDelete(
        "cascade",
      ),
      check("mcp_tool_status_check", sql`${t.status} in ('active', 'changed', 'removed')`),
      check("mcp_tool_tier_check", sql`${t.tier} in ('always', 'ask', 'blocked')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One account connected to an approved server: a person's own (`personal`, `scope_id` the person) or the workspace's
 * one account for a shared server (`org`). Its token set, or its API key, is a secret of kind `mcp`. Row security
 * hides a personal connection from everyone but its person, and core reads a token only through the connection it
 * resolved for the current person, so the row is the personal boundary. Admins see only counts of personal
 * connections (`app.mcp_connection_counts`, migration 0089).
 */
export const mcpConnection = app
  .table(
    "mcp_connection",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      serverId: uuid("server_id").notNull(),
      scope: text("scope").notNull(),
      scopeId: uuid("scope_id"),
      secretId: uuid("secret_id").notNull(),
      /** The authorization server that issued its tokens. */
      issuer: text("issuer"),
      /** The account as people may see it (an email or a name), when the server said. Never a secret. */
      account: text("account"),
      /** The account's stable id at the issuer, when known: a reconnect as anyone else is `wrong_account`. */
      accountKey: text("account_key"),
      /** The server's OAuth metadata as discovered when it connected (public), so a call needn't discover it again. */
      discovery: jsonb("discovery"),
      status: text("status").notNull().default("ready"),
      /** Why it needs reconnecting, in words a person can act on. */
      message: text("message"),
      /**
       * While a call refreshes its tokens: one refresh at a time per connection, across processes, since a refresh token
       * that rotates works once. Other calls wait for the new tokens instead of refreshing too.
       */
      refreshingUntil: timestamp("refreshing_until", { withTimezone: true }),
      /** Goes up whenever its tokens are replaced by a new sign-in: part of any cache key over its results. */
      revision: integer("revision").notNull().default(1),
      connectedBy: uuid("connected_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.serverId], foreignColumns: [mcpServer.orgId, mcpServer.id] }).onDelete(
        "cascade",
      ),
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }),
      uniqueIndex("mcp_connection_org_uq").on(t.orgId, t.serverId).where(sql`${t.scope} = 'org'`),
      uniqueIndex("mcp_connection_personal_uq").on(t.orgId, t.serverId, t.scopeId).where(sql`${t.scope} = 'personal'`),
      check("mcp_connection_scope_check", sql`${t.scope} in ('org', 'personal')`),
      check("mcp_connection_scope_id_check", sql`(${t.scope} = 'personal') = (${t.scopeId} is not null)`),
      check("mcp_connection_status_check", sql`${t.status} in ('ready', 'reconnect', 'wrong_account')`),
      ...tenantPolicies({ personalScope: true }),
    ],
  )
  .enableRLS();

/**
 * A sign-in in flight: made when someone presses Connect, used once by the callback, gone after ten minutes. Its PKCE
 * verifier is a secret of kind `mcp` (deleting the secret deletes the flow). It's bound to the person who started it,
 * the server, the connection's scope and the authorization server it went to; the callback finds it by a hash of
 * `state`, never the state itself.
 */
export const mcpOauthFlow = app
  .table(
    "mcp_oauth_flow",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      serverId: uuid("server_id").notNull(),
      /** The scope of the connection it makes: personal flows are visible only to their person. */
      scope: text("scope").notNull(),
      scopeId: uuid("scope_id"),
      startedBy: uuid("started_by").notNull(),
      /** sha256 of the `state` sent to the authorization server, base64url. */
      stateHash: text("state_hash").notNull(),
      secretId: uuid("secret_id").notNull(),
      issuer: text("issuer"),
      discovery: jsonb("discovery"),
      redirectUrl: text("redirect_url").notNull(),
      /** The connection it signs in again, if any. */
      connectionId: uuid("connection_id"),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      uniqueIndex("mcp_oauth_flow_state_uq").on(t.orgId, t.stateHash),
      index("mcp_oauth_flow_expires_idx").on(t.expiresAt),
      foreignKey({ columns: [t.orgId, t.serverId], foreignColumns: [mcpServer.orgId, mcpServer.id] }).onDelete(
        "cascade",
      ),
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }).onDelete("cascade"),
      check("mcp_oauth_flow_scope_check", sql`${t.scope} in ('org', 'personal')`),
      check("mcp_oauth_flow_scope_id_check", sql`(${t.scope} = 'personal') = (${t.scopeId} is not null)`),
      ...tenantPolicies({ personalScope: true }),
    ],
  )
  .enableRLS();
