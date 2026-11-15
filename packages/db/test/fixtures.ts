import { sql } from "drizzle-orm";
import { uuidv7 } from "../src/ids";
import type { SystemTx } from "../src/tenant";
import { orgOwners } from "./harness";

/**
 * One fixture per tenant table: inserts a row belonging to `orgId`. The tenancy suite fails if a table with RLS has
 * no fixture here, so every new table must add one (that's how it gets cross-tenant probes for free).
 */
/** A connection to hang catalog rows on. */
async function fixtureConnection(tx: SystemTx, orgId: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${id}, ${`pg-${id}`}, 'postgres')`,
  );
  return id;
}

async function fixtureThread(tx: SystemTx, orgId: string): Promise<string> {
  const connectionId = await fixtureConnection(tx, orgId);
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.thread (org_id, id, connection_id, title) values (${orgId}, ${id}, ${connectionId}, 'Q')`,
  );
  return id;
}

/** The org's Slack workspace (one per org), made once and reused by the Slack fixtures. */
async function fixtureSlackWorkspace(tx: SystemTx, orgId: string): Promise<string> {
  const teamId = `T${orgId}`;
  await tx.execute(
    sql`insert into app.slack_workspace (org_id, team_id, team_name, bot_user_id) values (${orgId}, ${teamId}, 'Acme', 'U0BOT')
        on conflict do nothing`,
  );
  return teamId;
}

async function fixtureDashboard(tx: SystemTx, orgId: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.dashboard (org_id, id, title, owner_id) values (${orgId}, ${id}, 'D', ${orgOwners.get(orgId) ?? uuidv7()})`,
  );
  return id;
}

/** A suite (scope global, so any number of fixtures fit beside the organization's one). */
async function fixtureSuite(tx: SystemTx, orgId: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(sql`insert into app.eval_suite (org_id, id, name, scope) values (${orgId}, ${id}, 'S', 'global')`);
  return id;
}

async function fixtureEvalCase(tx: SystemTx, orgId: string, suiteId: string): Promise<string> {
  const connectionId = await fixtureConnection(tx, orgId);
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.eval_case (org_id, id, suite_id, connection_id, question, question_hash, reference_spec, origin)
        values (${orgId}, ${id}, ${suiteId}, ${connectionId}, 'Q?', ${id}, '{"metrics":["m"]}', 'admin')`,
  );
  return id;
}

async function fixtureEvalRun(tx: SystemTx, orgId: string, suiteId: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.eval_run (org_id, id, suite_id, model, trigger, status)
        values (${orgId}, ${id}, ${suiteId}, 'm', 'manual', 'done')`,
  );
  return id;
}

async function fixtureItem(tx: SystemTx, orgId: string): Promise<string> {
  const connectionId = await fixtureConnection(tx, orgId);
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.context_item (org_id, id, kind, connection_id, path, slug, title, current_version)
        values (${orgId}, ${id}, 'metric', ${connectionId}, ${`/sources/${connectionId}/metrics/m.yaml`}, 'm', 'M', 1)`,
  );
  return id;
}

async function fixtureRun(tx: SystemTx, orgId: string): Promise<string> {
  const threadId = await fixtureThread(tx, orgId);
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.run (org_id, id, thread_id, model, status) values (${orgId}, ${id}, ${threadId}, 'm', 'succeeded')`,
  );
  return id;
}

/** An approved MCP server, and a secret of kind `mcp` for whatever needs one. */
async function fixtureMcpServer(tx: SystemTx, orgId: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.mcp_server (org_id, id, name, url) values (${orgId}, ${id}, 'Tracker', ${`https://mcp.acme.test/${id}`})`,
  );
  return id;
}

async function fixtureMcpSecret(tx: SystemTx, orgId: string): Promise<string> {
  const id = uuidv7();
  await tx.execute(
    sql`insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext) values (${orgId}, ${id}, 'mcp', 1, '\\x00', '\\x00')`,
  );
  return id;
}

export const fixtures: Record<string, { orgColumn: string; insert: (tx: SystemTx, orgId: string) => Promise<void> }> = {
  org: { orgColumn: "id", insert: async () => {} }, // orgs are created by the suite itself
  org_key: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${orgId}, 1, 'dek', 'kek:test')`,
      ) as unknown as Promise<void>,
  },
  member_pref: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.member_pref (org_id, user_id) values (${orgId}, ${uuidv7()})`,
      ) as unknown as Promise<void>,
  },
  user_mark: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.user_mark (org_id, user_id, target_type, target_id, mark)
            values (${orgId}, ${uuidv7()}, 'dashboard', ${uuidv7()}, 'favorite')`,
      ) as unknown as Promise<void>,
  },
  entitlement: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.entitlement (org_id, key, value) values (${orgId}, 'seats', '5')`,
      ) as unknown as Promise<void>,
  },
  secret: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
            values (${orgId}, ${uuidv7()}, 'connection', 1, '\\x00', '\\x00')`,
      ) as unknown as Promise<void>,
  },
  ops_alert: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.ops_alert (id, org_id, kind, subject, message)
            values (${uuidv7()}, ${orgId}, 'dead_letter', 'connection.test.dlq', 'A test never finished.')`,
      ) as unknown as Promise<void>,
  },
  metric_check: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.metric_check (org_id, id, metric_id, connection_id, grain, next_check_at)
            values (${orgId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'month', now())`,
      ) as unknown as Promise<void>,
  },
  observation: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.observation (org_id, check_id, period_start, value, row)
            values (${orgId}, ${uuidv7()}, '2026-09-01', 1, 0)`,
      ) as unknown as Promise<void>,
  },
  routine: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.routine (org_id, id, owner_id, trigger, spec)
            values (${orgId}, ${uuidv7()}, ${uuidv7()}, 'schedule', '{}'::jsonb)`,
      ) as unknown as Promise<void>,
  },
  routine_run: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const routineId = uuidv7();
      await tx.execute(
        sql`insert into app.routine (org_id, id, owner_id, trigger, spec)
            values (${orgId}, ${routineId}, ${uuidv7()}, 'schedule', '{}'::jsonb)`,
      );
      await tx.execute(
        sql`insert into app.routine_run (org_id, id, routine_id, trigger_key) values (${orgId}, ${uuidv7()}, ${routineId}, 'x')`,
      );
    },
  },
  slack_workspace: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureSlackWorkspace(tx, orgId);
    },
  },
  slack_identity: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const teamId = await fixtureSlackWorkspace(tx, orgId);
      // A link belongs to a member (its foreign key to auth.member): the organization's owner, from createOrg.
      await tx.execute(
        sql`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id) values (${orgId}, ${teamId}, ${`U${uuidv7()}`}, ${orgOwners.get(orgId) ?? uuidv7()})`,
      );
    },
  },
  slack_install: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.slack_install (org_id, id, user_id, browser_hash, expires_at)
            values (${orgId}, ${uuidv7()}, ${uuidv7()}, 'h', now() + interval '10 minutes')`,
      ) as unknown as Promise<void>,
  },
  slack_link: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const teamId = await fixtureSlackWorkspace(tx, orgId);
      await tx.execute(
        sql`insert into app.slack_link (org_id, id, team_id, slack_user_id, token_hash, expires_at)
            values (${orgId}, ${uuidv7()}, ${teamId}, 'U1', ${uuidv7()}, now() + interval '10 minutes')`,
      );
    },
  },
  slack_conversation: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const teamId = await fixtureSlackWorkspace(tx, orgId);
      const threadId = await fixtureThread(tx, orgId);
      await tx.execute(
        sql`insert into app.slack_conversation (org_id, team_id, slack_thread_id, slack_user_id, thread_id)
            values (${orgId}, ${teamId}, ${`slack:C1:${uuidv7()}`}, 'U1', ${threadId})`,
      );
    },
  },
  slack_reply: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const runId = await fixtureRun(tx, orgId);
      await tx.execute(
        sql`insert into app.slack_reply (org_id, run_id, team_id, slack_thread_id, slack_user_id)
            values (${orgId}, ${runId}, 'T1', 'slack:C1:1.2', 'U1')`,
      );
    },
  },
  slack_reply_message: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const runId = await fixtureRun(tx, orgId);
      await tx.execute(
        sql`insert into app.slack_reply (org_id, run_id, team_id, slack_thread_id, slack_user_id)
            values (${orgId}, ${runId}, 'T1', 'slack:C1:1.2', 'U1')`,
      );
      await tx.execute(
        sql`insert into app.slack_reply_message (org_id, run_id, part) values (${orgId}, ${runId}, 'answer')`,
      );
    },
  },
  slack_inbound: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const teamId = await fixtureSlackWorkspace(tx, orgId);
      await tx.execute(
        sql`insert into app.slack_inbound (org_id, team_id, key, kind, slack_thread_id, slack_user_id, envelope, next_at)
            values (${orgId}, ${teamId}, ${`m:D1:${uuidv7()}`}, 'message', 'slack:D1:1.2', 'U1', '{}'::jsonb, now())`,
      );
    },
  },
  embedding: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const vector = `[${new Array(1024)
        .fill(0)
        .map((_, i) => (i === 0 ? 1 : 0))
        .join(",")}]`;
      await tx.execute(
        sql`insert into app.embedding (org_id, subject_kind, subject_id, model, content_hash, vector)
            values (${orgId}, 'context_item', ${uuidv7()}, 'test/model@1024', 'h', ${vector}::public.halfvec(1024))`,
      );
    },
  },
  embedding_state: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await tx.execute(
        sql`insert into app.embedding_state (org_id, model, checked_at) values (${orgId}, 'test/model@1024', now())
            on conflict do nothing`,
      );
    },
  },
  effect: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.effect (org_id, id, purpose, source_type, channel, recipient_key, idempotency_key)
            values (${orgId}, ${uuidv7()}, 'notify', 'routine_run', 'email', 'user:x', ${`routine_run:${uuidv7()}`})`,
      ) as unknown as Promise<void>,
  },
  todo: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.todo (org_id, id, title) values (${orgId}, ${uuidv7()}, 'Find why sign-ups dropped')`,
      ) as unknown as Promise<void>,
  },
  outcome: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.outcome (org_id, id, todo_id, check_no, verdict) values (${orgId}, ${uuidv7()}, ${uuidv7()}, 1, 'no_change')`,
      ) as unknown as Promise<void>,
  },
  insight: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.insight (org_id, id, connection_id, kind, period, title, summary, severity, dedupe_key)
            values (${orgId}, ${uuidv7()}, ${uuidv7()}, 'anomaly', '2026-09-01', 'MRR rose', 'MRR rose more than usual.', 1,
              ${`anomaly:${uuidv7()}`})`,
      ) as unknown as Promise<void>,
  },
  investigation: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const insightId = uuidv7();
      await tx.execute(
        sql`insert into app.insight (org_id, id, connection_id, kind, period, title, summary, severity, dedupe_key)
            values (${orgId}, ${insightId}, ${uuidv7()}, 'anomaly', '2026-09-01', 'MRR rose', 'MRR rose more than usual.', 1,
              ${`anomaly:${uuidv7()}`})`,
      );
      await tx.execute(
        sql`insert into app.investigation (org_id, id, insight_id) values (${orgId}, ${uuidv7()}, ${insightId})`,
      );
    },
  },
  spend_limit: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.spend_limit (org_id, monthly_usd, daily_usd) values (${orgId}, 200, 5) on conflict do nothing`,
      ) as unknown as Promise<void>,
  },
  usage_daily: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.usage_daily (org_id, day, kind, model, key_source, events, qty, cost_usd, unpriced)
            values (${orgId}, '2026-10-10', 'llm_tokens', 'claude-sonnet-5-5', 'deployment', 1, 100, 0.01, 0)
            on conflict do nothing`,
      ) as unknown as Promise<void>,
  },
  ai_settings: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.ai_settings (org_id, default_model) values (${orgId}, 'claude-sonnet-5-5')
            on conflict do nothing`,
      ) as unknown as Promise<void>,
  },
  ai_provider: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const secretId = uuidv7();
      await tx.execute(
        sql`insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
            values (${orgId}, ${secretId}, 'llm_key', 1, '\\x00', '\\x00')`,
      );
      await tx.execute(
        sql`insert into app.ai_provider (org_id, id, kind, secret_id, shown)
            values (${orgId}, ${uuidv7()}, 'anthropic', ${secretId}, '{"key":"…abcd"}') on conflict do nothing`,
      );
    },
  },
  ai_provider_test: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const secretId = uuidv7();
      await tx.execute(
        sql`insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
            values (${orgId}, ${secretId}, 'llm_key', 1, '\\x00', '\\x00')`,
      );
      await tx.execute(
        sql`insert into app.ai_provider_test (org_id, id, kind, secret_id) values (${orgId}, ${uuidv7()}, 'openai', ${secretId})`,
      );
    },
  },
  mcp_server: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureMcpServer(tx, orgId);
    },
  },
  mcp_tool: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const serverId = await fixtureMcpServer(tx, orgId);
      await tx.execute(
        sql`insert into app.mcp_tool (org_id, server_id, name, digest, reviewed_digest)
            values (${orgId}, ${serverId}, 'search_issues', 'd', 'd')`,
      );
    },
  },
  mcp_connection: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const serverId = await fixtureMcpServer(tx, orgId);
      const secretId = await fixtureMcpSecret(tx, orgId);
      await tx.execute(
        sql`insert into app.mcp_connection (org_id, id, server_id, scope, secret_id)
            values (${orgId}, ${uuidv7()}, ${serverId}, 'org', ${secretId})`,
      );
    },
  },
  mcp_oauth_flow: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const serverId = await fixtureMcpServer(tx, orgId);
      const secretId = await fixtureMcpSecret(tx, orgId);
      await tx.execute(
        sql`insert into app.mcp_oauth_flow (org_id, id, server_id, scope, started_by, state_hash, secret_id, redirect_url,
                                            expires_at)
            values (${orgId}, ${uuidv7()}, ${serverId}, 'org', ${uuidv7()}, ${uuidv7()}, ${secretId},
                    'https://opendash.test/mcp/callback', now() + interval '10 minutes')`,
      );
    },
  },
  connection: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${uuidv7()}, ${`pg-${uuidv7()}`}, 'postgres')`,
      ) as unknown as Promise<void>,
  },
  connection_test: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const secretId = uuidv7();
      await tx.execute(
        sql`insert into app.secret (org_id, id, kind, key_version, nonce, ciphertext)
            values (${orgId}, ${secretId}, 'connection', 1, '\\x00', '\\x00')`,
      );
      await tx.execute(
        sql`insert into app.connection_test (org_id, id, dialect, config, secret_id)
            values (${orgId}, ${uuidv7()}, 'postgres', '{}', ${secretId})`,
      );
    },
  },
  sync_run: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const connectionId = await fixtureConnection(tx, orgId);
      await tx.execute(
        sql`insert into app.sync_run (org_id, id, connection_id) values (${orgId}, ${uuidv7()}, ${connectionId})`,
      );
    },
  },
  query_pattern: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const connectionId = await fixtureConnection(tx, orgId);
      await tx.execute(
        sql`insert into app.query_pattern (org_id, connection_id, fingerprint, sql, calls, total_ms, tables)
            values (${orgId}, ${connectionId}, ${uuidv7()}, 'select 1 from public.accounts', 3, 12, '["public.accounts"]')`,
      );
    },
  },
  schema_snapshot: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const connectionId = await fixtureConnection(tx, orgId);
      await tx.execute(
        sql`insert into app.schema_snapshot (org_id, id, connection_id, content_hash, snapshot)
            values (${orgId}, ${uuidv7()}, ${connectionId}, 'h', '{}')`,
      );
    },
  },
  catalog_object: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const connectionId = await fixtureConnection(tx, orgId);
      await tx.execute(
        sql`insert into app.catalog_object (org_id, id, connection_id, kind, fq_name, name)
            values (${orgId}, ${uuidv7()}, ${connectionId}, 'schema', 'public', 'public')`,
      );
    },
  },
  query_run: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.query_run (id, org_id, connection_id, requester_type, mode, compiled_sql, sql_hash, status)
            values (${uuidv7()}, ${orgId}, ${uuidv7()}, 'eval', 'execute', 'select 1', 'h', 'succeeded')`,
      ) as unknown as Promise<void>,
  },
  thread: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureThread(tx, orgId);
    },
  },
  message: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const threadId = await fixtureThread(tx, orgId);
      await tx.execute(
        sql`insert into app.message (org_id, id, thread_id, seq, role, content, text)
            values (${orgId}, ${uuidv7()}, ${threadId}, 1, 'user', '{"role":"user","content":"hi"}', 'hi')`,
      );
    },
  },
  run: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureRun(tx, orgId);
    },
  },
  tool_call: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const runId = await fixtureRun(tx, orgId);
      await tx.execute(
        sql`insert into app.tool_call (org_id, id, run_id, call_id, tool, args, attempt)
            values (${orgId}, ${uuidv7()}, ${runId}, 'call-1', 'value_lookup', '{}', 1)`,
      );
    },
  },
  prompt_text: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await tx.execute(
        sql`insert into app.prompt_text (org_id, sha256, text) values (${orgId}, ${uuidv7()}, 'A layer.')`,
      );
    },
  },
  run_event: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.run_event (id, org_id, run_id, attempt, seq, type)
            values (${uuidv7()}, ${orgId}, ${uuidv7()}, 1, 1, 'attempt_started')`,
      ) as unknown as Promise<void>,
  },
  context_item: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureItem(tx, orgId);
    },
  },
  context_item_version: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const itemId = await fixtureItem(tx, orgId);
      await tx.execute(
        sql`insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
            values (${orgId}, ${itemId}, 1, 'name: m', 'h', '{}', 'user')`,
      );
    },
  },
  project: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await tx.execute(
        sql`insert into app.project (org_id, id, name, slug) values (${orgId}, ${uuidv7()}, 'Board pack', ${`board-${uuidv7()}`})`,
      );
    },
  },
  project_member: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const projectId = uuidv7();
      await tx.execute(
        sql`insert into app.project (org_id, id, name, slug) values (${orgId}, ${projectId}, 'Pricing', ${`pricing-${projectId}`})`,
      );
      await tx.execute(
        sql`insert into app.project_member (org_id, project_id, principal_id, role) values (${orgId}, ${projectId}, ${orgOwners.get(orgId) ?? uuidv7()}, 'manager')`,
      );
    },
  },
  dashboard: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureDashboard(tx, orgId);
    },
  },
  dashboard_version: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_version (org_id, dashboard_id, version, definition, runtime_hash, revision)
            values (${orgId}, ${dashboardId}, 1, '{}', ${"0".repeat(64)}, ${uuidv7()})`,
      );
    },
  },
  dashboard_draft: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_draft (org_id, dashboard_id, definition) values (${orgId}, ${dashboardId}, '{}')`,
      );
    },
  },
  dashboard_work: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_work (org_id, dashboard_id, connection_id, dataset, record_key, status)
            values (${orgId}, ${dashboardId}, ${uuidv7()}, 'accounts', '1', 'To do')`,
      );
    },
  },
  dashboard_action: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_action (org_id, id, dashboard_id, revision, section, action, user_id, record_key,
              server_id, tool, arguments, arguments_hash, connection_id, account_revision, tool_digest, expires_at)
            values (${orgId}, ${uuidv7()}, ${dashboardId}, 'r', 's_list', 'a_done', ${uuidv7()}, 'ACME-1', ${uuidv7()},
              'transition', '{}'::jsonb, 'h', ${uuidv7()}, 1, 'd', now() + interval '2 minutes')`,
      );
    },
  },
  dashboard_work_event: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_work_event (org_id, id, dashboard_id, connection_id, dataset, record_key, field, value)
            values (${orgId}, ${uuidv7()}, ${dashboardId}, ${uuidv7()}, 'accounts', '1', 'status', 'To do')`,
      );
    },
  },
  dashboard_share: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_share (org_id, id, dashboard_id, user_id, role, added_by)
            values (${orgId}, ${uuidv7()}, ${dashboardId}, ${uuidv7()}, 'view', ${orgOwners.get(orgId) ?? uuidv7()})`,
      );
    },
  },
  dashboard_input: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const dashboardId = await fixtureDashboard(tx, orgId);
      await tx.execute(
        sql`insert into app.dashboard_input (org_id, dashboard_id, input, value, set_by)
            values (${orgId}, ${dashboardId}, 'i_target', 1.1, ${uuidv7()})`,
      );
    },
  },
  dashboard_result: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.dashboard_result (org_id, cache_key, status, error, expires_at)
            values (${orgId}, ${uuidv7()}, 'failed', 'x', now() + interval '5 minutes')`,
      ) as unknown as Promise<void>,
  },
  eval_suite: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureSuite(tx, orgId);
    },
  },
  eval_case: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureEvalCase(tx, orgId, await fixtureSuite(tx, orgId));
    },
  },
  eval_run: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      await fixtureEvalRun(tx, orgId, await fixtureSuite(tx, orgId));
    },
  },
  eval_result: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const suiteId = await fixtureSuite(tx, orgId);
      const caseId = await fixtureEvalCase(tx, orgId, suiteId);
      const runId = await fixtureEvalRun(tx, orgId, suiteId);
      await tx.execute(
        sql`insert into app.eval_result (org_id, eval_run_id, case_id, verdict) values (${orgId}, ${runId}, ${caseId}, 'pass')`,
      );
    },
  },
  node: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.node (org_id, id, kind, key) values (${orgId}, ${uuidv7()}, 'table', 'public.accounts')`,
      ) as unknown as Promise<void>,
  },
  edge: {
    orgColumn: "org_id",
    insert: async (tx, orgId) => {
      const [a, b] = [uuidv7(), uuidv7()];
      await tx.execute(sql`insert into app.node (org_id, id, kind, key) values
        (${orgId}, ${a}, 'term', 'term:paying account'), (${orgId}, ${b}, 'table', 'public.trial_accounts')`);
      await tx.execute(
        sql`insert into app.edge (org_id, id, rel, src_id, dst_id) values (${orgId}, ${uuidv7()}, 'IS_NOT', ${a}, ${b})`,
      );
    },
  },
  proposal: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.proposal (org_id, id, connection_id, title) values (${orgId}, ${uuidv7()}, ${uuidv7()}, 'Customers')`,
      ) as unknown as Promise<void>,
  },
  feedback: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.feedback (org_id, id, target_type, target_id, kind)
            values (${orgId}, ${uuidv7()}, 'run', ${uuidv7()}, 'up')`,
      ) as unknown as Promise<void>,
  },
  usage_event: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.usage_event (id, org_id, kind, qty, unit) values (${uuidv7()}, ${orgId}, 'llm_tokens', 1200, 'tokens')`,
      ) as unknown as Promise<void>,
  },
  audit_log: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.audit_log (id, org_id, actor_type, actor_name, action, fields)
            values (${uuidv7()}, ${orgId}, 'user', 'Maya Chen', 'source.updated', '{password}')`,
      ) as unknown as Promise<void>,
  },
  audit_chain: {
    orgColumn: "org_id",
    insert: (tx, orgId) =>
      tx.execute(
        sql`insert into app.audit_chain (org_id) values (${orgId}) on conflict do nothing`,
      ) as unknown as Promise<void>,
  },
};
