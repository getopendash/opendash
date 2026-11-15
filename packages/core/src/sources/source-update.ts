/**
 * Changing an existing source (Settings, Reconnect). New settings or a new password are a test first
 * (connection_test, purpose "update"), run by the worker like any check; they're applied to the source only once that
 * test passes (or warns and an admin accepts), and only once. The saved password is reused only when the host and
 * port stay the same and SSL isn't weakened, so it never goes to another server or unencrypted.
 * Renaming and disabling need no test.
 */
import type { SourceConfig } from "@opendash/connectors";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { enqueue } from "../jobs/boss";
import { type ConnectionTestJob, connectionTestQueue } from "../jobs/queues";
import type { SecretStore } from "../secrets/store";
import { requestSync } from "./catalog";
import { admitTest, ConnectionError, MAX_PASSWORD_LENGTH, type TestStatus } from "./connections";

const SSL_STRENGTH: Record<string, number> = { disable: 0, require: 1, "verify-full": 2 };

/**
 * The saved password may go with the new settings only to the same server (host and port) and over a connection at
 * least as protected as before: a weaker SSL mode could send it unencrypted (ClickHouse's HTTP sends it as is), and a
 * verified one that trusts another CA could send it to a server that CA vouches for, not the one it was saved for.
 */
const keepsPasswordSafe = (saved: SourceConfig, next: SourceConfig) =>
  saved.host.trim().toLowerCase() === next.host.trim().toLowerCase() &&
  Number(saved.port) === Number(next.port) &&
  (SSL_STRENGTH[next.sslMode] ?? -1) >= (SSL_STRENGTH[saved.sslMode] ?? Number.POSITIVE_INFINITY) &&
  (saved.sslMode !== "verify-full" || (saved.ca ?? "") === (next.ca ?? ""));

async function liveSource(tx: TenantTx, orgId: string, id: string) {
  if (!isUuid(id)) return null;
  const [c] = await tx.execute<{
    name: string;
    dialect: string;
    config: SourceConfig & { sample?: boolean };
    secret_id: string | null;
    status: "ok" | "error" | "disabled";
  }>(sql`
    select name, dialect, config, secret_id, status from app.connection
    where org_id = ${orgId} and id = ${id} and deleted_at is null
    for update`);
  return c ?? null;
}

export interface SourceUpdateInput {
  /** The settings to test; the dialect can't change. */
  config: SourceConfig;
  /** As typed. Left out to keep the saved one, which is allowed only on the same host and port. */
  password?: string;
}

/** Queues a test of new settings for a source. Returns the test's id; the form polls it like a new source's. */
export async function requestSourceUpdate(
  deps: { boss: PgBoss; secrets: SecretStore },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  connectionId: string,
  input: SourceUpdateInput,
): Promise<string> {
  const c = await liveSource(tx, ctx.orgId, connectionId);
  if (!c?.secret_id) throw new ConnectionError("TEST_NOT_FOUND", "That source doesn't exist.");
  await admitTest(tx, ctx.orgId);
  let secretId: string;
  if (input.password === undefined) {
    if (!keepsPasswordSafe(c.config, input.config)) {
      throw new ConnectionError(
        "PASSWORD_REQUIRED",
        "Enter the password to connect to a different server, with a weaker SSL mode, or trusting another CA.",
      );
    }
    secretId = c.secret_id;
  } else {
    if (input.password.length > MAX_PASSWORD_LENGTH) {
      throw new ConnectionError("PASSWORD_TOO_LONG", "That password is too long.");
    }
    secretId = await deps.secrets.put(tx, ctx.orgId, "connection", input.password);
  }
  const testId = uuidv7();
  await tx.execute(sql`
    insert into app.connection_test (org_id, id, dialect, config, secret_id, purpose, connection_id, requested_by)
    values (${ctx.orgId}, ${testId}, ${c.dialect}, ${JSON.stringify(input.config)}::jsonb, ${secretId}, 'update',
            ${connectionId}, ${ctx.userId})`);
  await enqueue<ConnectionTestJob>(deps.boss, tx, connectionTestQueue, { orgId: ctx.orgId, testId });
  return testId;
}

/**
 * Applies a passed (or accepted) update test to its source: the new settings and secret, the read-only verdict, any
 * error cleared; the old secret is deleted (with the checks that used it); the source is learned again.
 */
export async function applySourceUpdate(
  deps: { boss: PgBoss },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  connectionId: string,
  input: { testId: string; acceptWriteAccess?: boolean },
): Promise<void> {
  if (!isUuid(input.testId)) throw new ConnectionError("TEST_NOT_FOUND", "That check doesn't exist.");
  const [test] = await tx.execute<{
    status: TestStatus;
    purpose: string;
    connection_id: string | null;
    config: SourceConfig;
    facts: { sampleData?: boolean };
    secret_id: string;
    applied_at: string | null;
    fresh: boolean;
  }>(sql`
    select status, purpose, connection_id, config, facts, secret_id, applied_at,
      finished_at > now() - ${`${BUDGETS.connectionTest.validForMs} milliseconds`}::interval as fresh
    from app.connection_test where org_id = ${ctx.orgId} and id = ${input.testId}
    for update`);
  if (test?.purpose !== "update" || test.connection_id !== connectionId) {
    throw new ConnectionError("TEST_NOT_FOUND", "That check doesn't exist.");
  }
  if (test.applied_at) throw new ConnectionError("TEST_USED", "These settings were already saved.");
  if (test.status === "queued" || test.status === "running") {
    throw new ConnectionError("TEST_NOT_FINISHED", "The check is still running.");
  }
  if (test.status === "failed") {
    throw new ConnectionError("TEST_FAILED", "The check didn't pass. Fix the settings and test again.");
  }
  if (test.status === "blocked") {
    throw new ConnectionError(
      "TEST_BLOCKED",
      "This user reaches beyond your data and can't be connected. Use a read-only user.",
    );
  }
  if (!test.fresh) throw new ConnectionError("TEST_EXPIRED", "This check is too old. Test again.");
  if (test.status === "warning" && !input.acceptWriteAccess) {
    throw new ConnectionError("WRITE_ACCESS_NOT_ACCEPTED", "This user can change data. Confirm to save it anyway.");
  }
  const c = await liveSource(tx, ctx.orgId, connectionId);
  if (!c) throw new ConnectionError("TEST_NOT_FOUND", "That source doesn't exist.");

  const passed = test.status === "passed";
  const config = { ...test.config, ...(test.facts.sampleData ? { sample: true } : {}) };
  await tx.execute(sql`
    update app.connection set
      config = ${JSON.stringify(config)}::jsonb, secret_id = ${test.secret_id},
      status = case when status = 'disabled' then 'disabled' else 'ok' end, last_error = null,
      read_only_verified_at = ${passed ? sql`now()` : null},
      write_access_accepted_at = ${passed ? null : sql`now()`}, write_access_accepted_by = ${passed ? null : ctx.userId},
      updated_at = now()
    where org_id = ${ctx.orgId} and id = ${connectionId}`);
  await tx.execute(sql`
    update app.connection_test set applied_at = now() where org_id = ${ctx.orgId} and id = ${input.testId}`);
  if (c.secret_id && c.secret_id !== test.secret_id) {
    await tx.execute(sql`
      delete from app.secret s where s.org_id = ${ctx.orgId} and s.id = ${c.secret_id}
        and not exists (select 1 from app.connection o where o.org_id = s.org_id and o.secret_id = s.id)`);
  }
  // The settings that changed, by name; a new secret is the password changing (its value is never read here).
  const saved = c.config as unknown as Record<string, unknown>;
  const next = config as unknown as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(saved), ...Object.keys(next)])].filter(
    (k) => k !== "sample" && JSON.stringify(saved[k]) !== JSON.stringify(next[k]),
  );
  if (c.secret_id !== test.secret_id) changed.push("password");
  if (!passed) changed.push("writeAccessAccepted");
  await audit(tx, {
    action: "source.updated",
    actor: { type: "user", id: ctx.userId },
    target: { type: "connection", id: connectionId, name: c.name },
    fields: changed,
    detail: { dialect: c.dialect },
  });
  if (c.status !== "disabled") await requestSync(deps, tx, ctx, connectionId);
}

/** Renames a source; names are unique per organization, ignoring case. */
export async function renameSource(
  tx: TenantTx,
  ctx: { orgId: string },
  connectionId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid" | "taken" }> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 63 || /\p{Cc}/u.test(trimmed)) return { ok: false, reason: "invalid" };
  const c = await liveSource(tx, ctx.orgId, connectionId);
  if (!c) return { ok: false, reason: "not_found" };
  const [taken] = await tx.execute<{ id: string }>(sql`
    select id from app.connection
    where org_id = ${ctx.orgId} and id <> ${connectionId} and deleted_at is null and lower(name) = lower(${trimmed})`);
  if (taken) return { ok: false, reason: "taken" };
  await tx.execute(sql`
    update app.connection set name = ${trimmed}, updated_at = now() where org_id = ${ctx.orgId} and id = ${connectionId}`);
  await audit(tx, {
    action: "source.updated",
    target: { type: "connection", id: connectionId, name: trimmed },
    fields: ["name"],
    detail: { dialect: c.dialect },
  });
  return { ok: true };
}

/**
 * Disables a source (no queries, syncs or checks; Settings → Danger zone) or enables it again. Enabled, it is in error if its
 * last check failed, until a check passes.
 */
export async function setSourceDisabled(
  tx: TenantTx,
  ctx: { orgId: string },
  connectionId: string,
  disabled: boolean,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  const c = await liveSource(tx, ctx.orgId, connectionId);
  if (!c) return { ok: false, reason: "not_found" };
  await tx.execute(sql`
    update app.connection set
      status = ${disabled ? sql`'disabled'` : sql`case when last_error is null then 'ok' else 'error' end`},
      updated_at = now()
    where org_id = ${ctx.orgId} and id = ${connectionId}`);
  if (disabled) {
    await tx.execute(sql`
      update app.sync_run set status = 'failed', finished_at = now(), message = 'This source was disabled.'
      where org_id = ${ctx.orgId} and connection_id = ${connectionId} and status in ('queued', 'running')`);
  }
  await audit(tx, {
    action: "source.updated",
    target: { type: "connection", id: connectionId, name: c.name },
    fields: ["disabled"],
    detail: { dialect: c.dialect, disabled },
  });
  return { ok: true };
}
