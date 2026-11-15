/**
 * Connecting a data source. The web app asks for a test; a worker runs it; a connection is created only from
 * a test that passed, or that found write access an admin chose to accept. A superuser (or anything else that
 * reaches beyond the data) can never be connected.
 *
 *   request: secret + connection_test (queued) + job, in one tenant transaction
 *   worker:  claim (queued → running), probe, write each step, settle (passed / warning / blocked / failed)
 *   connect: lock the test, re-check it, create the connection with the test's secret, mark the test used
 */
import {
  type Check,
  type Dialect,
  type DialectId,
  dialectFor,
  type Edition,
  type ProbeResult,
  type SourceConfig,
} from "@opendash/connectors";
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { enqueue } from "../jobs/boss";
import { type ConnectionTestJob, connectionTestQueue } from "../jobs/queues";
import { loggableError } from "../loggable";
import type { SecretStore } from "../secrets/store";
import { requestSync } from "./catalog";
import { DEFAULT_SYNC_RULE, nextRun } from "./schedule";

export type TestStatus = "queued" | "running" | "passed" | "warning" | "blocked" | "failed";

export interface ConnectionTestView {
  id: string;
  dialect: string;
  status: TestStatus;
  config: SourceConfig;
  checks: Check[];
  facts: ProbeResult["facts"];
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
  connectionId: string | null;
}

export class ConnectionError extends Error {
  override name = "ConnectionError";
  constructor(
    readonly code:
      | "TEST_NOT_FOUND"
      | "TEST_NOT_FINISHED"
      | "TEST_FAILED"
      | "TEST_BLOCKED"
      | "TEST_EXPIRED"
      | "TEST_USED"
      | "WRITE_ACCESS_NOT_ACCEPTED"
      | "PASSWORD_TOO_LONG"
      | "PASSWORD_REQUIRED"
      | "TOO_MANY_TESTS",
    message: string,
  ) {
    super(message);
  }
}

const UNUSED_TEST_RETENTION = "1 day";
/**
 * Each test makes a worker open a connection to a host someone typed, from OpenDash's addresses. Admins only, and
 * bounded per org, so the form can't be used to scan networks.
 */
export const TEST_LIMIT = { max: 30, window: "10 minutes" } as const;
export const MAX_PASSWORD_LENGTH = 1024;

export interface RequestTestInput {
  /** Which kind of database; Postgres when left out. */
  dialect?: DialectId;
  config: SourceConfig;
  /** The user's password, as typed. Empty is a password too: some users have none (trust auth, a local ClickHouse). */
  password: string;
}

/** Every test, new or a re-check, counts against the org's cap. */
export async function admitTest(tx: TenantTx, orgId: string) {
  // Lock the org row first, so parallel requests are counted one after another and can't all slip under the cap.
  // A row lock, held only for this short transaction (no advisory locks).
  await tx.execute(sql`select 1 from app.org where id = ${orgId} for update`);
  const [recent] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.connection_test
    where org_id = ${orgId} and created_at > now() - ${TEST_LIMIT.window}::interval`);
  if ((recent?.n ?? 0) >= TEST_LIMIT.max) {
    throw new ConnectionError("TOO_MANY_TESTS", "Too many checks in a short time. Wait a few minutes and try again.");
  }
}

/**
 * Unused tests' secrets don't outlive a day: tests that never became a connection, and updates that were never
 * applied. A secret a connection uses is never deleted (a kept-password update shares the source's own).
 */
export async function deleteUnusedSecrets(tx: TenantTx, orgId: string) {
  await tx.execute(sql`
    delete from app.secret s using app.connection_test t
    where t.org_id = ${orgId} and s.org_id = t.org_id and s.id = t.secret_id
      and (t.connection_id is null or (t.purpose = 'update' and t.applied_at is null))
      and t.created_at < now() - ${UNUSED_TEST_RETENTION}::interval
      and not exists (select 1 from app.connection c where c.org_id = s.org_id and c.secret_id = s.id)`);
}

export async function requestConnectionTest(
  deps: { boss: PgBoss; secrets: SecretStore },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: RequestTestInput,
): Promise<string> {
  await admitTest(tx, ctx.orgId);
  if (input.password.length > MAX_PASSWORD_LENGTH)
    throw new ConnectionError("PASSWORD_TOO_LONG", "That password is too long.");
  const dialect = input.dialect ?? "postgres";
  dialectFor(dialect); // throws for a dialect without an adapter

  await deleteUnusedSecrets(tx, ctx.orgId);

  // Stored encrypted even when empty, so a connection always has its secret and nothing treats "none" specially.
  const secretId = await deps.secrets.put(tx, ctx.orgId, "connection", input.password);

  const testId = uuidv7();
  await tx.execute(sql`
    insert into app.connection_test (org_id, id, dialect, config, secret_id, requested_by)
    values (${ctx.orgId}, ${testId}, ${dialect}, ${JSON.stringify(input.config)}::jsonb, ${secretId}, ${ctx.userId})`);
  await enqueue<ConnectionTestJob>(deps.boss, tx, connectionTestQueue, { orgId: ctx.orgId, testId });
  return testId;
}

/**
 * Test connection on a source: the same check, run again on the source's own settings with its own secret. The
 * host can't change here, so a saved password only ever goes back to the server it was saved for.
 * The result is applied to the source when the check finishes (see settle).
 */
export async function requestRetest(
  deps: { boss: PgBoss },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  connectionId: string,
): Promise<string> {
  // A check already under way is the answer to a second click.
  const [running] = await tx.execute<{ id: string }>(sql`
    select id from app.connection_test
    where org_id = ${ctx.orgId} and connection_id = ${connectionId} and purpose = 'recheck'
      and status in ('queued', 'running')
    order by created_at desc limit 1`);
  if (running) return running.id;
  await admitTest(tx, ctx.orgId);
  const [c] = await tx.execute<{
    dialect: string;
    config: SourceConfig & { sample?: boolean };
    secret_id: string | null;
  }>(sql`
    select dialect, config, secret_id from app.connection
    where org_id = ${ctx.orgId} and id = ${connectionId} and deleted_at is null and status <> 'disabled'`);
  if (!c?.secret_id) throw new ConnectionError("TEST_NOT_FOUND", "That source doesn't exist or is disabled.");
  const { sample: _sample, ...config } = c.config;
  const testId = uuidv7();
  // connection_id is set from the start: a re-check can't be used to create another connection (TEST_USED), and
  // the unused-test cleanup never touches its secret, which is the source's own.
  await tx.execute(sql`
    insert into app.connection_test (org_id, id, dialect, config, secret_id, purpose, connection_id, requested_by)
    values (${ctx.orgId}, ${testId}, ${c.dialect}, ${JSON.stringify(config)}::jsonb, ${c.secret_id}, 'recheck',
            ${connectionId}, ${ctx.userId})`);
  await enqueue<ConnectionTestJob>(deps.boss, tx, connectionTestQueue, { orgId: ctx.orgId, testId });
  return testId;
}

/** The latest check of a source: the one it was connected from, or a later re-check. */
export async function latestConnectionTest(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
): Promise<ConnectionTestView | null> {
  const [row] = await tx.execute<{ id: string }>(sql`
    select id from app.connection_test where org_id = ${orgId} and connection_id = ${connectionId}
    order by created_at desc limit 1`);
  return row ? getConnectionTest(tx, orgId, row.id) : null;
}

export async function getConnectionTest(
  tx: TenantTx,
  orgId: string,
  testId: string,
): Promise<ConnectionTestView | null> {
  const [row] = await tx.execute<{
    id: string;
    dialect: string;
    status: TestStatus;
    config: SourceConfig;
    checks: Check[];
    facts: ProbeResult["facts"];
    message: string | null;
    created_at: string;
    finished_at: string | null;
    connection_id: string | null;
  }>(sql`
    select id, dialect, status, config, checks, facts, message, created_at, finished_at, connection_id
    from app.connection_test where org_id = ${orgId} and id = ${testId}`);
  if (!row) return null;
  return {
    id: row.id,
    dialect: row.dialect,
    status: row.status,
    config: row.config,
    checks: row.checks,
    facts: row.facts,
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    connectionId: row.connection_id,
  };
}

/** The worker side of connection.test. Never throws: a failed check is a result, written to the test. */
export async function runConnectionTest(
  deps: {
    withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
    secrets: SecretStore;
    edition: Edition;
    /** Replaces the dialect's probe (tests). */
    probe?: Dialect["probe"];
  },
  job: ConnectionTestJob,
  signal?: AbortSignal,
): Promise<TestStatus | null> {
  const { orgId, testId } = job;
  try {
    const claimed = await deps.withTenant(orgId, async (tx) => {
      const [row] = await tx.execute<{ config: SourceConfig; secret_id: string; dialect: string }>(sql`
        update app.connection_test set status = 'running', started_at = now()
        where org_id = ${orgId} and id = ${testId} and status = 'queued'
        returning config, secret_id, dialect`);
      if (!row) return null;
      return {
        config: row.config,
        dialect: dialectFor(row.dialect),
        password: await deps.secrets.reveal(tx, orgId, row.secret_id, "connection"),
      };
    });
    // Already run (a duplicate delivery) or gone: nothing to do.
    if (!claimed) return null;

    const writeChecks = (checks: Check[]) =>
      deps.withTenant(orgId, (tx) =>
        tx.execute(sql`
          update app.connection_test set checks = ${JSON.stringify(checks)}::jsonb
          where org_id = ${orgId} and id = ${testId} and status = 'running'`),
      );
    const result = await (deps.probe ?? claimed.dialect.probe)(claimed.config, claimed.password, {
      edition: deps.edition,
      connectTimeoutMs: BUDGETS.connectionTest.connectMs,
      statementTimeoutMs: BUDGETS.connectionTest.statementMs,
      signal,
      onCheck: async (checks) => {
        await writeChecks(checks);
      },
    });
    await settle(
      deps,
      job,
      result.outcome,
      { checks: result.checks, facts: result.facts, message: result.message ?? null },
      { applyToSource: true },
    );
    return result.outcome;
  } catch (error) {
    console.error(JSON.stringify({ msg: "connection test crashed", testId, error: loggableError(error) }));
    await settle(deps, job, "failed", { message: "Something went wrong while checking. Try again." }).catch(() => {});
    return "failed";
  }
}

/**
 * Settles a test that hasn't finished. Also used by the dead-letter handler, for a worker that died or hung.
 *
 * With applyToSource (a probe's real result), a re-check of an existing source updates it in the same transaction:
 *   passed:  reachable and read-only; any earlier error is cleared;
 *   warning: the user can now change data. Queries still run read-only; the source shows "Can change data";
 *   blocked or failed: the source is in error with the reason, and the gateway won't query it until a check passes.
 * A worker that died says nothing about the source, so the dead-letter path never changes it.
 */
export async function settle(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T> },
  job: ConnectionTestJob,
  status: Exclude<TestStatus, "queued" | "running">,
  result: { checks?: Check[]; facts?: ProbeResult["facts"]; message: string | null },
  options: { applyToSource?: boolean } = {},
): Promise<boolean> {
  return deps.withTenant(job.orgId, async (tx) => {
    const rows = await tx.execute<{ connection_id: string | null; purpose: string }>(sql`
      update app.connection_test set
        status = ${status},
        checks = coalesce(${result.checks ? JSON.stringify(result.checks) : null}::jsonb, checks),
        facts = coalesce(${result.facts ? JSON.stringify(result.facts) : null}::jsonb, facts),
        message = ${result.message},
        finished_at = now()
      where org_id = ${job.orgId} and id = ${job.testId} and status in ('queued', 'running')
      returning connection_id, purpose`);
    const connectionId = rows[0]?.connection_id;
    // Only a re-check says something about the source as it is; an update tests settings it doesn't have yet.
    if (connectionId && rows[0]?.purpose === "recheck" && options.applyToSource) {
      const ok = status === "passed" || status === "warning";
      await tx.execute(sql`
        update app.connection set
          status = ${ok ? "ok" : "error"},
          last_error = ${ok ? null : (result.message ?? "The connection check didn't pass.")},
          read_only_verified_at = case
            when ${status} = 'passed' then now() when ${status} = 'warning' then null else read_only_verified_at end,
          updated_at = now()
        where org_id = ${job.orgId} and id = ${connectionId} and deleted_at is null and status <> 'disabled'`);
    }
    return rows.length > 0;
  });
}

export interface ConnectInput {
  testId: string;
  name?: string;
  /** The admin saw that this user can change data and connects it anyway. */
  acceptWriteAccess?: boolean;
}

/** Creates the connection and starts learning it in the same transaction. */
export async function connectFromTest(
  deps: { boss: PgBoss },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: ConnectInput,
): Promise<string> {
  const [test] = await tx.execute<{
    status: TestStatus;
    dialect: string;
    config: SourceConfig;
    facts: ProbeResult["facts"];
    secret_id: string;
    connection_id: string | null;
    fresh: boolean;
  }>(sql`
    select status, dialect, config, facts, secret_id, connection_id,
      finished_at > now() - ${`${BUDGETS.connectionTest.validForMs} milliseconds`}::interval as fresh
    from app.connection_test where org_id = ${ctx.orgId} and id = ${input.testId}
    for update`);
  if (!test) throw new ConnectionError("TEST_NOT_FOUND", "That check doesn't exist.");
  if (test.connection_id) throw new ConnectionError("TEST_USED", "This database is already connected.");
  if (test.status === "queued" || test.status === "running") {
    throw new ConnectionError("TEST_NOT_FINISHED", "The check is still running.");
  }
  if (test.status === "failed")
    throw new ConnectionError("TEST_FAILED", "The check didn't pass. Fix the settings and test again.");
  if (test.status === "blocked") {
    throw new ConnectionError(
      "TEST_BLOCKED",
      "This user reaches beyond your data and can't be connected. Use a read-only user.",
    );
  }
  if (!test.fresh) throw new ConnectionError("TEST_EXPIRED", "This check is too old. Test again.");
  if (test.status === "warning" && !input.acceptWriteAccess) {
    throw new ConnectionError("WRITE_ACCESS_NOT_ACCEPTED", "This user can change data. Confirm to connect it anyway.");
  }

  const name = await uniqueName(tx, ctx.orgId, input.name?.trim() || test.config.database);
  const id = uuidv7();
  const passed = test.status === "passed";
  await tx.execute(sql`
    insert into app.connection (org_id, id, name, dialect, config, secret_id, read_only_verified_at,
                                write_access_accepted_at, write_access_accepted_by, sync_rrule, next_sync_at)
    values (${ctx.orgId}, ${id}, ${name}, ${test.dialect},
            ${JSON.stringify({ ...test.config, ...(test.facts.sampleData ? { sample: true } : {}) })}::jsonb, ${test.secret_id},
            ${passed ? sql`now()` : null}, ${passed ? null : sql`now()`}, ${passed ? null : ctx.userId},
            ${DEFAULT_SYNC_RULE}, ${nextRun(DEFAULT_SYNC_RULE, new Date())?.toISOString() ?? null}::timestamptz)`);
  await tx.execute(sql`
    update app.connection_test set connection_id = ${id} where org_id = ${ctx.orgId} and id = ${input.testId}`);
  await audit(tx, {
    action: "source.created",
    actor: { type: "user", id: ctx.userId },
    target: { type: "connection", id, name },
    detail: { dialect: test.dialect },
  });
  await requestSync(deps, tx, ctx, id);
  return id;
}

/** "acme_production", then "acme_production 2", … among live connections (names are unique per org). */
async function uniqueName(tx: TenantTx, orgId: string, base: string): Promise<string> {
  const rows = await tx.execute<{ name: string }>(
    sql`select name from app.connection where org_id = ${orgId} and deleted_at is null`,
  );
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
