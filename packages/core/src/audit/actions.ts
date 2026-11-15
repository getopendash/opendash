/**
 * What the audit log records: each action's name, how the Audit log page says it, and the group its filter puts it in.
 * Pure (constants and types), so client code may import it as @opendash/core/audit.
 */

export const AUDIT_CATEGORIES = {
  signin: "Sign-in",
  members: "Members",
  keys: "API keys",
  sources: "Sources",
  ai: "AI providers",
  sharing: "Sharing",
  knowledge: "Knowledge",
  routines: "Routines",
  slack: "Slack",
  mcp: "Connections",
  sso: "Single sign-on",
  scim: "Directory sync",
  audit: "Audit log",
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

/**
 * Every action, its label (a past-tense sentence start: "Maya Chen changed a role") and its group. The `detail` each
 * one may carry is typed in AuditDetail below; anything else is refused when it's written.
 */
export const AUDIT_ACTIONS = {
  "signin.succeeded": { label: "Signed in", category: "signin" },
  "signin.failed": { label: "Couldn't sign in", category: "signin" },
  "signin.refused": { label: "Was refused sign-in", category: "signin" },
  "two_factor.enabled": { label: "Turned on two-factor", category: "signin" },
  "two_factor.disabled": { label: "Turned off two-factor", category: "signin" },
  "password.reset": { label: "Reset their password", category: "signin" },
  "sessions.revoked": { label: "Ended sessions", category: "signin" },
  "member.invited": { label: "Invited someone", category: "members" },
  "invitation.cancelled": { label: "Cancelled an invitation", category: "members" },
  "member.joined": { label: "Joined", category: "members" },
  "member.role_changed": { label: "Changed a role", category: "members" },
  "member.removed": { label: "Removed a member", category: "members" },
  "member.left": { label: "Left the workspace", category: "members" },
  "api_key.created": { label: "Made an API key", category: "keys" },
  "api_key.revoked": { label: "Revoked an API key", category: "keys" },
  "source.created": { label: "Added a source", category: "sources" },
  "source.updated": { label: "Changed a source", category: "sources" },
  "source.deleted": { label: "Removed a source", category: "sources" },
  "ai_connection.created": { label: "Added an AI provider", category: "ai" },
  "ai_connection.updated": { label: "Changed an AI provider", category: "ai" },
  "ai_connection.deleted": { label: "Removed an AI provider", category: "ai" },
  "spend_limit.updated": { label: "Changed a spend limit", category: "ai" },
  // Public links were retired with reports: kept so the log still names what it recorded.
  "sharing.updated": { label: "Changed public sharing", category: "sharing" },
  "share_link.created": { label: "Made a public link", category: "sharing" },
  "share_link.revoked": { label: "Revoked a public link", category: "sharing" },
  "knowledge.approved": { label: "Approved knowledge", category: "knowledge" },
  "knowledge.published": { label: "Published a definition", category: "knowledge" },
  "routine.created": { label: "Made a routine that reaches outside", category: "routines" },
  "routine.updated": { label: "Changed a routine that reaches outside", category: "routines" },
  "slack.installed": { label: "Installed Slack", category: "slack" },
  "slack.removed": { label: "Removed Slack", category: "slack" },
  "mcp_server.approved": { label: "Approved an MCP server", category: "mcp" },
  "mcp_server.updated": { label: "Changed an MCP server", category: "mcp" },
  "mcp_server.removed": { label: "Removed an MCP server", category: "mcp" },
  "mcp_tool.updated": { label: "Changed an MCP tool", category: "mcp" },
  "mcp_tool.called": { label: "Changed something through a connection", category: "mcp" },
  "mcp_connection.connected": { label: "Connected an account", category: "mcp" },
  "mcp_connection.disconnected": { label: "Disconnected an account", category: "mcp" },
  "sso.provider_added": { label: "Added an identity provider", category: "sso" },
  "sso.provider_updated": { label: "Changed an identity provider", category: "sso" },
  "sso.secret_rotated": { label: "Replaced an identity provider's secret", category: "sso" },
  "sso.domain_verified": { label: "Verified a domain", category: "sso" },
  "sso.activated": { label: "Activated an identity provider", category: "sso" },
  "sso.enforced": { label: "Required single sign-on", category: "sso" },
  "sso.unenforced": { label: "Stopped requiring single sign-on", category: "sso" },
  "sso.disabled": { label: "Disabled an identity provider", category: "sso" },
  "sso.enabled": { label: "Enabled an identity provider", category: "sso" },
  "sso.provider_removed": { label: "Removed an identity provider", category: "sso" },
  "scim.connected": { label: "Connected a directory", category: "scim" },
  "scim.token_rotated": { label: "Made a new directory token", category: "scim" },
  "scim.disconnected": { label: "Disconnected the directory", category: "scim" },
  "scim.mapping_updated": { label: "Mapped a directory group", category: "scim" },
  "scim.refused": { label: "Refused someone from the directory", category: "scim" },
  "scim.owner_kept": { label: "Kept an owner the directory removed", category: "scim" },
  "audit.exported": { label: "Exported the audit log", category: "audit" },
  "audit.purged": { label: "Deleted the audit history", category: "audit" },
} as const satisfies Record<string, { label: string; category: AuditCategory }>;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (value: string): value is AuditAction => Object.hasOwn(AUDIT_ACTIONS, value);

/** The actions in a group, for the page's filter. */
export const actionsIn = (category: AuditCategory): AuditAction[] =>
  (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter((a) => AUDIT_ACTIONS[a].category === category);

/** The kinds of things an action is done to. */
export type AuditTargetType =
  | "user"
  | "member"
  | "invitation"
  | "api_key"
  | "connection"
  | "ai_connection"
  | "workspace"
  | "share_link"
  | "knowledge"
  | "routine"
  | "slack"
  | "mcp_server"
  | "sso_provider"
  | "scim_connection"
  | "scim_group";

type Role = "owner" | "admin" | "member" | "viewer";

/**
 * The facts an action may carry beyond its target and field names: never a secret and never a value someone typed into
 * a source or a setting. A role, a count, a kind or a method is fine; a password, token, key, URL or query isn't.
 */
export interface AuditDetail {
  "signin.succeeded": { method: "password" | "email_link" | "two_factor" | "sso" };
  "signin.failed": { method: "password" | "email_link" | "two_factor"; reason: "bad_credentials" | "rate_limited" };
  /** Single sign-on is required for the person's domain: a sign-in another way, or a session from before it. */
  "signin.refused": { method: "password" | "email_link" | "session"; reason: "sso_required" };
  "two_factor.enabled": Record<string, never>;
  "two_factor.disabled": Record<string, never>;
  "password.reset": Record<string, never>;
  "sessions.revoked": { count: number | null };
  "member.invited": { role: Role };
  "invitation.cancelled": { role: Role };
  "member.joined": { role: Role };
  "member.role_changed": { from: Role; to: Role };
  "member.removed": { role: Role };
  "member.left": { role: Role };
  "api_key.created": { owner: "organization" | "user"; expiresInDays: number | null };
  "api_key.revoked": { owner: "organization" | "user"; count: number };
  "source.created": { dialect: string };
  "source.updated": { dialect?: string; disabled?: boolean; column?: string; personal?: boolean };
  "source.deleted": { dialect: string };
  "ai_connection.created": { kind: string };
  "ai_connection.updated": { kind: string };
  "ai_connection.deleted": { kind: string };
  "spend_limit.updated": Record<string, never>;
  "sharing.updated": { enabled: boolean; linksEnded?: number };
  "share_link.created": { kind: string; days?: number };
  "share_link.revoked": { kind: string; reportDeleted?: boolean };
  "knowledge.approved": { kind: string; version?: number | null };
  "knowledge.published": { kind: string; version: number | null };
  "routine.created": { destinations: string[] };
  "routine.updated": { destinations: string[] };
  "slack.installed": Record<string, never>;
  "slack.removed": { by?: "uninstalled" | "tokens_revoked" };
  "mcp_server.approved": {
    access: "personal" | "shared";
    auth: "oauth" | "apikey" | "none";
    transport?: "streamable" | "sse";
    client?: "admin";
  };
  "mcp_server.updated": {
    access?: "personal" | "shared";
    status?: "active" | "disabled";
    dashboards?: boolean;
    transport?: "streamable" | "sse";
  };
  "mcp_server.removed": Record<string, never>;
  "mcp_tool.updated": { tool: string; tier?: "always" | "ask" | "blocked"; dashboards?: boolean; reviewed?: boolean };
  /** A row's action on a dashboard: the tool, and how it went. */
  "mcp_tool.called": { tool: string; via: "dashboard"; outcome: "done" | "failed" | "unknown" };
  "mcp_connection.connected": { scope: "org" | "personal"; again: boolean; kind?: "apikey" };
  "mcp_connection.disconnected": { scope: "org" | "personal" };
  "sso.provider_added": { protocol: "oidc" | "saml"; domain: string };
  "sso.provider_updated": { protocol: "oidc" | "saml"; domain: string };
  "sso.secret_rotated": { protocol: "oidc" | "saml" };
  "sso.domain_verified": { domain: string };
  "sso.activated": { domain: string };
  "sso.enforced": { domain: string; sessionsEnded: number; keysRevoked: number };
  "sso.unenforced": { domain: string };
  /** `by: "operator"`: from the server (`pnpm sso:disable`), not the settings page. */
  "sso.disabled": { domain: string; sessionsEnded: number; by?: "operator" };
  "sso.enabled": { domain: string };
  "sso.provider_removed": { domain: string; sessionsEnded: number };
  "scim.connected": { expiresInDays: number };
  "scim.token_rotated": { expiresInDays: number; ended: number };
  /** `ended`: how many of its tokens stopped working. */
  "scim.disconnected": { ended: number };
  /** `none`: the group no longer gives a role (people in only it are viewers). */
  "scim.mapping_updated": { role: Role | "none" };
  /** Only people at the workspace's verified SSO domains are added. */
  "scim.refused": { reason: "domain_not_verified" };
  /** The directory removed the workspace's last owner: kept, so the workspace isn't left without one. */
  "scim.owner_kept": Record<string, never>;
  "audit.exported": { format: "csv" | "jsonl"; rows: number; days: number };
  "audit.purged": { rows: number };
}

/** How a row reads on the Audit log page, from its action and detail. */
export function auditLine(action: string, detail: Record<string, unknown>): { label: string; note: string | null } {
  const label = isAuditAction(action) ? AUDIT_ACTIONS[action].label : action;
  const d = detail ?? {};
  const role = (r: unknown) => (typeof r === "string" ? r : "");
  const count = (n: unknown, noun: string) => `${Number(n) || 0} ${noun}${Number(n) === 1 ? "" : "s"}`;
  switch (action) {
    case "member.role_changed":
      return { label, note: `${role(d.from)} → ${role(d.to)}` };
    case "member.invited":
    case "member.joined":
    case "invitation.cancelled":
      return { label, note: d.role ? `role: ${role(d.role)}` : null };
    case "sessions.revoked":
      return {
        label,
        note: typeof d.count === "number" ? `${d.count} ${d.count === 1 ? "session" : "sessions"}` : null,
      };
    case "signin.succeeded":
      return {
        label,
        note: d.method === "sso" ? "through single sign-on" : d.method === "email_link" ? "by email link" : null,
      };
    case "signin.failed":
      return { label, note: d.reason === "rate_limited" ? "too many tries" : "wrong email or password" };
    case "signin.refused":
      return { label, note: "single sign-on is required" };
    case "sso.enforced":
      return {
        label,
        note: `${d.domain}: ended ${count(d.sessionsEnded, "session")}, revoked ${count(d.keysRevoked, "API key")}`,
      };
    case "sso.disabled":
    case "sso.provider_removed":
      return {
        label,
        note: `${d.domain}: ended ${count(d.sessionsEnded, "session")}${d.by === "operator" ? ", from the server" : ""}`,
      };
    case "sso.provider_added":
    case "sso.provider_updated":
      return { label, note: `${d.protocol === "saml" ? "SAML" : "OIDC"} · ${d.domain}` };
    case "scim.mapping_updated":
      return { label, note: d.role === "none" ? "no role" : `gives ${role(d.role)}` };
    case "scim.disconnected":
      return { label, note: `ended ${count(d.ended, "token")}` };
    case "scim.refused":
      return { label, note: "not at a verified domain" };
    case "sso.domain_verified":
    case "sso.activated":
    case "sso.unenforced":
    case "sso.enabled":
      return { label, note: typeof d.domain === "string" ? d.domain : null };
    case "api_key.created":
      return {
        label,
        note: typeof d.expiresInDays === "number" ? `expires in ${d.expiresInDays} days` : "doesn't expire",
      };
    case "api_key.revoked":
      return { label, note: typeof d.count === "number" && d.count > 1 ? `${d.count} keys` : null };
    case "sharing.updated":
      return { label, note: d.enabled ? "turned on" : "turned off" };
    case "knowledge.published":
      return { label, note: typeof d.version === "number" ? `version ${d.version}` : null };
    case "routine.created":
    case "routine.updated":
      return { label, note: Array.isArray(d.destinations) ? `to ${d.destinations.join(", ")}` : null };
    case "audit.exported":
      return { label, note: `${String(d.format).toUpperCase()}, ${d.rows} rows, last ${d.days} days` };
    case "audit.purged":
      return { label, note: `${d.rows} rows` };
    default:
      return { label, note: null };
  }
}
