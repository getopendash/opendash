/**
 * What a data export carries, table by table: a workspace's (its owner asks, and gets what they can read there), and
 * one person's own in a workspace (what they made and what is about them). Every app table is either exported here
 * or listed in NOT_EXPORTED with why: `test/export.test.ts` fails for a table that is neither, so a new table is a
 * decision, never an accident.
 *
 * Rows come out as the database holds them (JSON, one row a line), less the columns in `omit`: references to stored
 * secrets, hashes of tokens, and compiled output that is rebuilt from what is exported beside it. A secret itself
 * (a database password, a model key, a Slack or MCP token) is never in an export: `secret` and `org_key` aren't
 * exported at all.
 *
 * Privacy holds inside an export as it does in the app: someone's private conversations and dashboards, their own
 * findings and a routine that reaches only them are theirs alone, owners included (projects/access.ts), so a
 * workspace's export has the asker's own and what the workspace shares, never another person's private work.
 */
import { type SQL, sql } from "@opendash/db";
import { dashboardReadableBy, othersPrivateWork, threadReadableBy } from "../projects/access";

export interface ExportSpec {
  table: string;
  /**
   * The rows to take, as a condition on the table (alias `x`), for the workspace's export (`who` asked) and for one
   * person's own. Null leaves the table out of that export.
   */
  workspace: ((who: string) => SQL) | null;
  person: ((who: string) => SQL) | null;
  /** Columns left out. */
  omit?: string[];
  /** What orders its rows when it has no `id`: an expression over `x` that is unique in the organization. */
  key?: SQL;
}

const all = () => sql`true`;
/** A conversation (alias `t`) the asker can read, as the app decides it. */
const readableThread = (who: string) => sql`(${threadReadableBy(who)} and not ${othersPrivateWork(who)})`;
const inReadableThread = (column: SQL) => (who: string) =>
  sql`exists (select 1 from app.thread t where t.org_id = x.org_id and t.id = ${column} and ${readableThread(who)})`;
const inOwnThread = (column: SQL) => (who: string) =>
  sql`exists (select 1 from app.thread t where t.org_id = x.org_id and t.id = ${column} and t.created_by = ${who}::uuid)`;
/** A run (by its id in `column`) of a conversation the asker can read, or of their own. */
const ofReadableRun = (column: SQL) => (who: string) =>
  sql`exists (select 1 from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
        where r.org_id = x.org_id and r.id = ${column} and ${readableThread(who)})`;
const ofOwnRun = (column: SQL) => (who: string) =>
  sql`exists (select 1 from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
        where r.org_id = x.org_id and r.id = ${column} and t.created_by = ${who}::uuid)`;
const inReadableDashboard = (who: string) =>
  sql`exists (select 1 from app.dashboard d
        where d.org_id = x.org_id and d.id = x.dashboard_id and ${dashboardReadableBy(who)})`;
const inOwnDashboard = (who: string) =>
  sql`exists (select 1 from app.dashboard d
        where d.org_id = x.org_id and d.id = x.dashboard_id and d.owner_id = ${who}::uuid)`;
/** A routine that reaches only its owner is theirs alone (routines/privacy.ts). */
const routineShared = sql`(x.key is not null or jsonb_array_length(x.slack) > 0
  or exists (select 1 from unnest(x.user_ids) u where u <> x.owner_id))`;

export const EXPORTED: ExportSpec[] = [
  { table: "org", workspace: all, person: null, omit: ["billing_ref"], key: sql`x.id::text` },
  { table: "connection", workspace: all, person: null, omit: ["secret_id"] },
  // Knowledge: row security already keeps another person's personal items out.
  { table: "context_item", workspace: all, person: (who) => sql`x.owner_id = ${who}::uuid` },
  {
    table: "context_item_version",
    workspace: all,
    person: (who) => sql`x.author_id = ${who}::uuid`,
    omit: ["body_hash", "derived"],
    key: sql`x.item_id::text || ':' || lpad(x.version::text, 10, '0')`,
  },
  { table: "project", workspace: all, person: (who) => sql`x.created_by = ${who}::uuid` },
  {
    table: "project_member",
    workspace: all,
    person: (who) => sql`x.principal_type = 'user' and x.principal_id = ${who}::uuid`,
    key: sql`x.project_id::text || ':' || x.principal_type || ':' || x.principal_id::text`,
  },
  {
    table: "thread",
    workspace: (who) => sql`exists (select 1 from app.thread t
      where t.org_id = x.org_id and t.id = x.id and ${readableThread(who)})`,
    person: (who) => sql`x.created_by = ${who}::uuid`,
  },
  {
    table: "message",
    workspace: inReadableThread(sql`x.thread_id`),
    person: (who) => sql`(x.author_id = ${who}::uuid or ${inOwnThread(sql`x.thread_id`)(who)})`,
  },
  {
    table: "run",
    workspace: inReadableThread(sql`x.thread_id`),
    person: inOwnThread(sql`x.thread_id`),
    omit: ["worker_id", "prompt", "candidate"],
  },
  // The queries behind those conversations, with the result preview each answer cited.
  {
    table: "query_run",
    workspace: (who) => sql`x.requester_type = 'run' and ${ofReadableRun(sql`x.requester_id`)(who)}`,
    person: (who) => sql`x.requester_type = 'run' and ${ofOwnRun(sql`x.requester_id`)(who)}`,
    omit: ["cache_key", "result_hash", "sql_hash"],
  },
  {
    table: "dashboard",
    workspace: (who) => sql`exists (select 1 from app.dashboard d
      where d.org_id = x.org_id and d.id = x.id and ${dashboardReadableBy(who)})`,
    person: (who) => sql`x.owner_id = ${who}::uuid`,
  },
  {
    table: "dashboard_version",
    workspace: inReadableDashboard,
    person: inOwnDashboard,
    // The compiled bundle is built from the definition and parts exported here.
    omit: ["bundle", "bundle_hash", "runtime_hash"],
    key: sql`x.dashboard_id::text || ':' || lpad(x.version::text, 10, '0')`,
  },
  {
    table: "dashboard_share",
    workspace: inReadableDashboard,
    person: (who) => sql`x.user_id = ${who}::uuid`,
    key: sql`x.dashboard_id::text || ':' || x.user_id::text`,
  },
  {
    table: "routine",
    workspace: (who) => sql`(x.owner_id = ${who}::uuid or ${routineShared})`,
    person: (who) => sql`(x.owner_id = ${who}::uuid or ${who}::uuid = any(x.user_ids))`,
  },
  {
    table: "insight",
    workspace: (who) => sql`(x.owner_id is null or x.owner_id = ${who}::uuid)`,
    person: (who) => sql`x.owner_id = ${who}::uuid`,
    omit: ["dedupe_key"],
  },
  { table: "todo", workspace: all, person: (who) => sql`(x.owner_id = ${who}::uuid or x.created_by = ${who}::uuid)` },
  { table: "feedback", workspace: all, person: (who) => sql`x.user_id = ${who}::uuid`, omit: ["claim_key"] },
  {
    table: "proposal",
    workspace: all,
    person: (who) => sql`x.requested_by = ${who}::uuid`,
    omit: ["dedupe_key"],
  },
  {
    table: "member_pref",
    workspace: null,
    person: (who) => sql`x.user_id = ${who}::uuid`,
    key: sql`x.user_id::text`,
  },
  {
    table: "user_mark",
    workspace: null,
    person: (who) => sql`x.user_id = ${who}::uuid`,
    key: sql`x.user_id::text || ':' || x.target_type || ':' || x.target_id::text || ':' || x.mark`,
  },
  { table: "ai_settings", workspace: all, person: null, key: sql`x.org_id::text` },
  { table: "spend_limit", workspace: all, person: null, key: sql`x.org_id::text` },
  {
    table: "usage_daily",
    workspace: all,
    person: null,
    key: sql`x.day::text || ':' || x.kind || ':' || coalesce(x.model, '') || ':' || x.key_source`,
  },
  {
    table: "mcp_server",
    workspace: all,
    person: null,
    omit: ["client_secret_id", "key_hint"],
  },
  {
    table: "slack_workspace",
    workspace: all,
    person: null,
    omit: ["secret_id"],
    key: sql`x.team_id`,
  },
  {
    table: "slack_identity",
    workspace: null,
    person: (who) => sql`x.user_id = ${who}::uuid`,
    key: sql`x.team_id || ':' || x.slack_user_id`,
  },
  // The audit log, as Settings shows it to owners and admins; a person's own actions in theirs.
  {
    table: "audit_log",
    workspace: all,
    person: (who) => sql`x.actor_id = ${who}::uuid`,
    omit: ["hash", "prev_hash", "seq"],
  },
];

/** Every other app table, and why its rows aren't in an export. */
export const NOT_EXPORTED: Record<string, string> = {
  org_key: "the workspace's wrapped encryption key",
  secret: "stored secrets (database passwords, model keys, tokens), encrypted",
  org_deletion: "the deployment's record of deleted workspaces",
  ops_tick: "the deployment's own",
  ops_alert: "operational alerts, shown in Settings → Health",
  entitlement: "what the deployment allows the workspace, not its data",
  audit_chain: "the audit log's seal (a hash)",
  catalog_object: "read from your own database: its tables and columns",
  schema_snapshot: "read from your own database",
  query_pattern: "read from your own database's query history",
  sync_run: "the log of learning runs",
  connection_test: "the log of connection checks",
  ai_provider: "a model provider's connection; its key is a stored secret",
  ai_provider_test: "the log of provider checks",
  embedding: "search vectors, computed from what is exported",
  embedding_state: "search vectors' bookkeeping",
  node: "the knowledge graph, computed from what is exported",
  edge: "the knowledge graph, computed from what is exported",
  prompt_text: "prompt layers sent to the model, kept for traces",
  run_event: "a run's live stream, kept for days",
  tool_call: "a run's trace; its queries are in query_run",
  usage_event: "metered events; usage_daily has them by day",
  effect: "the delivery outbox",
  dashboard_draft: "unpublished drafts; published versions are exported",
  dashboard_result: "a cache of query results",
  dashboard_work: "records of work kept by an App, reached only through it",
  dashboard_work_event: "records of work kept by an App, reached only through it",
  dashboard_action: "the log of an App's actions",
  dashboard_input: "an App's saved inputs",
  eval_suite: "evaluation fixtures",
  eval_case: "evaluation fixtures",
  eval_run: "evaluation fixtures",
  eval_result: "evaluation fixtures",
  investigation: "bookkeeping of a finding's investigation; its conversation is exported",
  metric_check: "schedules of metric checks",
  observation: "a metric's checked values, read from your own database",
  outcome: "a task's measured outcome, read from your own database",
  routine_run: "the log of routine runs; their conversations are exported",
  mcp_tool: "tools a connected server lists",
  mcp_connection: "a sign-in to a connected server; its token is a stored secret",
  mcp_oauth_flow: "sign-ins under way",
  slack_install: "installs under way",
  slack_link: "account links under way",
  slack_inbound: "Slack events' bookkeeping",
  slack_conversation: "which Slack thread a conversation is in",
  slack_reply: "replies' bookkeeping",
  slack_reply_message: "replies' bookkeeping",
};
