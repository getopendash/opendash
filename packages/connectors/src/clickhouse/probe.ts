/**
 * ClickHouse connection check: reach, sign in, verify the user can't change data, read the catalog. The same
 * four steps and outcomes as Postgres. Nothing is ever written; privileges come from `SHOW GRANTS FINAL` (the user's
 * grants with its roles' merged in), never from trying a write.
 *
 *   blocked (no override): ALL, access management (users, roles, quotas…), SYSTEM, INTROSPECTION, or any source
 *     privilege (FILE, URL, S3, REMOTE, MYSQL, POSTGRES…), the ClickHouse counterparts of Postgres's superuser,
 *     CREATEROLE and server-file roles: they reach beyond the data;
 *   failed (fixable): readonly = 1 on a server whose own settings don't already bound queries the way OpenDash's
 *     would (session.ts, fixedSettingsProblem); or a server older than 24.3;
 *   warning (needs the override): INSERT, ALTER, CREATE, DROP, TRUNCATE or OPTIMIZE anywhere, unless the user's profile has
 *     readonly = 1 or 2, which already stops writes to tables;
 *   passed: none of the above.
 */

import { COMMENT_READ_CHARS } from "../catalog-types";
import type { SourceConfig } from "../dialect";
import { NetworkRefused } from "../network";
import { type Check, type ProbeFacts, type ProbeOptions, type ProbeResult, stepper } from "../probe-types";
import { classifyType } from "./catalog";
import {
  fixedSettingsProblem,
  friendlyError,
  MIN_VERSION,
  openClickHouse,
  queryRows,
  queryText,
  versionOk,
} from "./session";

const fmt = (n: number) => n.toLocaleString("en-US");
const SAMPLE_DATA = /^opendash:sample-data\b/;

const BLOCKING = [
  /^ALL( PRIVILEGES)?$/,
  /^ACCESS MANAGEMENT$/,
  /^ROLE ADMIN$/,
  /^(CREATE|ALTER|DROP) (USER|ROLE|ROW POLICY|QUOTA|SETTINGS PROFILE|MASKING POLICY)$/,
  /^SYSTEM( |$)/,
  /^INTROSPECTION$/,
  /^SOURCES$/,
  /^(FILE|URL|REMOTE|MONGO|REDIS|MYSQL|POSTGRES|SQLITE|ODBC|JDBC|HDFS|S3|HIVE|AZURE|KAFKA|NATS|RABBITMQ|DISK)$/,
  /^(READ|WRITE) ON /,
  /^CREATE FUNCTION$/,
];
const WRITING = /^(INSERT|ALTER( |$)|CREATE( |$)|DROP( |$)|TRUNCATE|OPTIMIZE|UNDROP|BACKUP|MOVE PARTITION)/;

/** The privileges in "GRANT SELECT, INSERT ON db.* TO user" lines (role-membership lines have no ON). */
export function grantedPrivileges(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^GRANT (.+?) ON (\S+) TO /.exec(line.trim());
    if (!m?.[1]) continue;
    // A source privilege can carry its own target: "GRANT READ ON URL TO u" is the READ ON URL privilege.
    if (/^(READ|WRITE)$/.test(m[1]) && m[2]) out.push(`${m[1]} ON ${m[2]}`);
    else out.push(...m[1].split(/,\s*/).map((p) => p.replace(/\(.*\)$/, "").trim()));
  }
  return [...new Set(out)];
}

export async function probeClickHouse(
  config: SourceConfig,
  password: string,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const where = `${config.host}:${config.port}`;
  const checks: Check[] = [
    { key: "reach", status: "pending", label: `Reach ${where}` },
    { key: "sign-in", status: "pending", label: `Sign in as ${config.user}` },
    { key: "read-only", status: "pending", label: "Check it can't change data" },
    { key: "catalog", status: "pending", label: "Read the catalog" },
  ];
  const facts: ProbeFacts = {};
  const { set, stop } = stepper(checks, facts, options.onCheck);

  await set("reach", { status: "running" });
  const started = performance.now();
  let session: Awaited<ReturnType<typeof openClickHouse>>;
  try {
    session = await openClickHouse(config, password, {
      edition: options.edition,
      connectTimeoutMs: options.connectTimeoutMs,
      statementTimeoutMs: options.statementTimeoutMs,
      applicationName: "opendash-probe",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof NetworkRefused) return stop("reach", "failed", error.message);
    const code = (error as { code?: string }).code ?? "";
    // A network-level failure means we never got there; anything ClickHouse answered means we did.
    const network = /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|CONNECT_TIMEOUT)/.test(code);
    if (network) return stop("reach", "failed", friendlyError(error, config, options.connectTimeoutMs));
    await set("reach", { status: "ok", label: `Reached ${where}` });
    await set("sign-in", { status: "running" });
    return stop("sign-in", "failed", friendlyError(error, config, options.connectTimeoutMs));
  }
  facts.latencyMs = Math.round(performance.now() - started);
  await set("reach", { status: "ok", label: `Reached ${where}`, detail: `${facts.latencyMs} ms` });

  try {
    await set("sign-in", { status: "running" });
    facts.serverVersion = session.version;
    facts.ssl = config.sslMode !== "disable";
    if (!versionOk(session.version)) {
      return await stop(
        "sign-in",
        "failed",
        `OpenDash needs ClickHouse ${MIN_VERSION.join(".")} or newer; this server is ${session.version}.`,
      );
    }
    const fixedProblem = session.readonly === 1 ? fixedSettingsProblem(session.fixed) : null;
    if (fixedProblem) return await stop("sign-in", "failed", fixedProblem);
    const [who] = await queryRows<{ user: string; comment: string | null }>(
      session,
      `select currentUser() as user,
         (select substringUTF8(comment, 1, ${COMMENT_READ_CHARS}) from system.databases where name = currentDatabase())
           as comment`,
    );
    facts.user = who?.user;
    facts.sampleData = SAMPLE_DATA.test(who?.comment ?? "");
    await set("sign-in", {
      status: "ok",
      label: `Signed in as ${facts.user}`,
      detail: `ClickHouse ${session.version.split(".").slice(0, 2).join(".")} · ${facts.ssl ? "HTTPS" : "HTTP"}`,
    });

    await set("read-only", { status: "running" });
    const privileges = grantedPrivileges(await queryText(session, "show grants final"));
    const blockedBy = privileges.filter((p) => BLOCKING.some((re) => re.test(p)));
    if (blockedBy.length) {
      facts.blockedBy = blockedBy;
      return await stop(
        "read-only",
        "blocked",
        `This user is allowed ${blockedBy.slice(0, 4).join(", ")}${blockedBy.length > 4 ? "…" : ""}, which reaches beyond your data. Use a user with SELECT grants only.`,
      );
    }
    facts.writePrivileges = privileges.filter((p) => WRITING.test(p));
    if (facts.writePrivileges.length && session.readonly === 0) {
      await set("read-only", { status: "warn", label: "Has write access", detail: facts.writePrivileges.join(", ") });
    } else {
      await set("read-only", {
        status: "ok",
        label: "Read-only verified",
        detail: session.readonly ? `readonly = ${session.readonly}` : "No write grants",
      });
    }

    await set("catalog", { status: "running" });
    // Counted by the server: one row of totals, and one per column type (how each is read is decided here).
    const [counted] = await queryRows<{ tables: string; databases: string }>(
      session,
      `select count() as tables, uniqExact(database) as databases from system.tables
       where database not in ('system', 'INFORMATION_SCHEMA', 'information_schema') and not is_temporary`,
    );
    const types = await queryRows<{ type: string; n: string }>(
      session,
      `select type, count() as n from system.columns
       where database not in ('system', 'INFORMATION_SCHEMA', 'information_schema') group by type limit 10000`,
    );
    facts.tables = Number(counted?.tables ?? 0);
    facts.schemas = Number(counted?.databases ?? 0);
    facts.columns = types.reduce((sum, t) => sum + (classifyType(t.type) ? Number(t.n) : 0), 0);
    if (facts.tables === 0) {
      await set("catalog", {
        status: "warn",
        label: "No readable tables",
        detail: "Grant SELECT on the databases to ask about",
      });
    } else {
      await set("catalog", {
        status: "ok",
        label: `Found ${fmt(facts.tables)} ${facts.tables === 1 ? "table" : "tables"} in ${fmt(facts.schemas)} ${facts.schemas === 1 ? "database" : "databases"}`,
        detail: `${fmt(facts.columns)} columns`,
      });
    }
    const warned = checks.some((c) => c.key === "read-only" && c.status === "warn");
    return { outcome: warned ? "warning" : "passed", checks, facts };
  } catch (error) {
    const running = checks.find((c) => c.status === "running")?.key ?? "catalog";
    return await stop(running, "failed", friendlyError(error, config, options.connectTimeoutMs));
  } finally {
    await session.close();
  }
}
