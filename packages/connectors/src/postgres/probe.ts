/**
 * Postgres connection check: reach the host, sign in, verify the user can't change data, read the catalog.
 * Every query runs in a read-only session with a statement timeout; nothing is ever written to the customer's
 * database. Privileges are judged from the catalog (has_table_privilege and friends), not by attempting writes.
 */
import { COMMENT_READ_CHARS } from "../catalog-types";
import { NetworkRefused } from "../network";
import { friendlyError, hostPort, openSession, type PostgresConfig, reach } from "./session";

export type { PostgresConfig, SslMode } from "./session";

import type { Check, CheckKey, ProbeFacts, ProbeOptions, ProbeOutcome, ProbeResult } from "../probe-types";

export type {
  Check,
  CheckKey,
  CheckStatus,
  ProbeFacts,
  ProbeOptions,
  ProbeOutcome,
  ProbeResult,
  Step,
} from "../probe-types";

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'`;
const DATA_RELKINDS = `c.relkind in ('r', 'p', 'f')`;
const READABLE_RELKINDS = `c.relkind in ('r', 'p', 'v', 'm', 'f')`;

/** Roles that make a user unusable, whatever else it can do: they reach beyond the database's data. */
const BLOCKING_ROLES = ["pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"];

const fmt = (n: number) => n.toLocaleString("en-US");
/** The marker `pnpm demo:seed` leaves on the sample database (packages/evals, seed). */
const SAMPLE_DATA = /^opendash:sample-data\b/;

export async function probePostgres(
  config: PostgresConfig,
  password: string,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const checks: Check[] = [
    { key: "reach", status: "pending", label: `Reach ${hostPort(config)}` },
    { key: "sign-in", status: "pending", label: `Sign in as ${config.user}` },
    { key: "read-only", status: "pending", label: "Check it can't change data" },
    { key: "catalog", status: "pending", label: "Read the catalog" },
  ];
  const facts: ProbeFacts = {};
  const set = async (key: CheckKey, patch: Partial<Check>) => {
    const check = checks.find((c) => c.key === key);
    if (check) Object.assign(check, patch);
    await options.onCheck?.(checks.map((c) => ({ ...c })));
  };
  const stop = async (key: CheckKey, outcome: ProbeOutcome, message: string): Promise<ProbeResult> => {
    await set(key, { status: "fail", detail: message });
    for (const c of checks) if (c.status === "pending") c.status = "skipped";
    await options.onCheck?.(checks.map((c) => ({ ...c })));
    return { outcome, checks, facts, message };
  };

  // 1. Reach: vet the address for this edition, then open a TCP connection to it.
  await set("reach", { status: "running" });
  let address: string;
  try {
    ({ address, latencyMs: facts.latencyMs } = await reach(
      config,
      options.edition,
      options.connectTimeoutMs,
      options.signal,
    ));
  } catch (error) {
    const message =
      error instanceof NetworkRefused ? error.message : friendlyError(error, config, options.connectTimeoutMs);
    return stop("reach", "failed", message);
  }
  await set("reach", { status: "ok", label: `Reached ${hostPort(config)}`, detail: `${facts.latencyMs} ms` });

  // 2. Sign in, to the vetted address. With verify-full, TLS still verifies the host name typed.
  await set("sign-in", { status: "running" });
  const { sql, close } = openSession(config, address, password, { ...options, applicationName: "opendash-probe" });
  try {
    try {
      const [who] = await sql<{ user: string; version: string; ssl: boolean; comment: string | null }[]>`
        select current_user as user, current_setting('server_version') as version,
               coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false) as ssl,
               left(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'),
                    ${COMMENT_READ_CHARS}) as comment`;
      facts.user = who?.user;
      facts.serverVersion = who?.version;
      facts.ssl = who?.ssl ?? false;
      facts.sampleData = SAMPLE_DATA.test(who?.comment ?? "");
    } catch (error) {
      return await stop("sign-in", "failed", friendlyError(error, config, options.connectTimeoutMs));
    }
    await set("sign-in", { status: "ok", label: `Signed in as ${facts.user}`, detail: facts.ssl ? "SSL" : "No SSL" });

    // 3. Privileges. The blocking cases are checked first, so a superuser is refused, never offered an override.
    await set("read-only", { status: "running" });
    const [p] = await sql.unsafe<
      {
        superuser: boolean;
        create_role: boolean;
        bypass_rls: boolean;
        roles: string[];
        writable: number;
        privileges: string[];
      }[]
    >(`
      select r.rolsuper as superuser, r.rolcreaterole as create_role, r.rolbypassrls as bypass_rls,
        array(select g.rolname::text from pg_roles g
              where g.rolname in ('${[...BLOCKING_ROLES, "pg_write_all_data"].join("', '")}')
                and pg_has_role(current_user, g.oid, 'MEMBER')) as roles,
        (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where ${DATA_RELKINDS} and ${USER_SCHEMAS}
            and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
                 or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))) as writable,
        array(select priv from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
              where exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where ${DATA_RELKINDS} and ${USER_SCHEMAS} and has_table_privilege(c.oid, priv))) as privileges
      from pg_roles r where r.rolname = current_user`);
    const blockedBy = [
      ...(p?.superuser ? ["superuser"] : []),
      ...(p?.create_role ? ["CREATEROLE"] : []),
      ...(p?.bypass_rls ? ["BYPASSRLS"] : []),
      ...(p?.roles ?? []).filter((r) => BLOCKING_ROLES.includes(r)),
    ];
    if (blockedBy.length) {
      facts.blockedBy = blockedBy;
      return await stop(
        "read-only",
        "blocked",
        `This user is ${blockedBy.includes("superuser") ? "a superuser" : `allowed ${blockedBy.join(", ")}`}, which reaches beyond your data. Use a read-only user.`,
      );
    }
    facts.writableTables = p?.writable ?? 0;
    facts.writePrivileges = p?.privileges ?? [];
    const writesAll = (p?.roles ?? []).includes("pg_write_all_data");
    if (facts.writableTables > 0 || writesAll) {
      await set("read-only", {
        status: "warn",
        label: "Has write access",
        detail: writesAll
          ? "pg_write_all_data"
          : `${facts.writePrivileges.join(", ")} on ${fmt(facts.writableTables)} ${facts.writableTables === 1 ? "table" : "tables"}`,
      });
    } else {
      await set("read-only", { status: "ok", label: "Read-only verified", detail: "No write grants" });
    }

    // 4. What the user can read.
    await set("catalog", { status: "running" });
    const [cat] = await sql.unsafe<{ tables: number; schemas: number; columns: number }[]>(`
      select count(*)::int as tables, count(distinct c.relnamespace)::int as schemas,
        coalesce(sum((select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)), 0)::int as columns
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where ${READABLE_RELKINDS} and ${USER_SCHEMAS} and has_table_privilege(c.oid, 'SELECT')`);
    facts.tables = cat?.tables ?? 0;
    facts.schemas = cat?.schemas ?? 0;
    facts.columns = cat?.columns ?? 0;
    if (facts.tables === 0) {
      await set("catalog", {
        status: "warn",
        label: "No readable tables",
        detail: "Grant SELECT on the tables to ask about",
      });
    } else {
      await set("catalog", {
        status: "ok",
        label: `Found ${fmt(facts.tables)} ${facts.tables === 1 ? "table" : "tables"} in ${fmt(facts.schemas)} ${facts.schemas === 1 ? "schema" : "schemas"}`,
        detail: `${fmt(facts.columns)} columns`,
      });
    }
    const outcome: ProbeOutcome = checks.some((c) => c.key === "read-only" && c.status === "warn")
      ? "warning"
      : "passed";
    return { outcome, checks, facts };
  } catch (error) {
    const running = checks.find((c) => c.status === "running")?.key ?? "catalog";
    return await stop(running, "failed", friendlyError(error, config, options.connectTimeoutMs));
  } finally {
    await close();
  }
}
