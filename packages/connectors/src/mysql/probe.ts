/**
 * MySQL connection check: reach the host, sign in, verify the user can't change data, read the catalog. Every
 * query runs on a read-only session with a time limit; nothing is written to the customer's database. Privileges are
 * judged from SHOW GRANTS (with any roles granted), not by attempting writes.
 */
import { NetworkRefused } from "../network";
import type { PostgresConfig } from "../postgres/session";
import { type Check, type ProbeFacts, type ProbeOptions, type ProbeResult, stepper } from "../probe-types";
import { friendlyError, hostPort, openSession, reach } from "./session";

/** Databases that are the server's own, never a source's data. */
export const SYSTEM_DATABASES = ["mysql", "sys", "information_schema", "performance_schema"];
const SYSTEM = `table_schema not in (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(", ")})`;

/**
 * Privileges that reach beyond the data, whatever else the user can do: files, other sessions, the binary log (all
 * data, as it changes), users and grants, the server itself. Any of these, anywhere, and the user can't be used.
 */
const BLOCKING = new Set([
  "FILE",
  "SUPER",
  "PROCESS",
  "SHUTDOWN",
  "RELOAD",
  "CREATE USER",
  "GRANT OPTION",
  "REPLICATION SLAVE",
  "REPLICATION CLIENT",
  "CREATE TABLESPACE",
]);
/** Privileges that change data or definitions: allowed only with the explicit override. */
const WRITES = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "INDEX",
  "CREATE VIEW",
  "TRIGGER",
  "EVENT",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "EXECUTE",
  "LOCK TABLES",
  "CREATE TEMPORARY TABLES",
  "REFERENCES",
]);

const fmt = (n: number) => n.toLocaleString("en-US");
const SAMPLE_DATA = "opendash:sample-data%";

export interface Grant {
  privileges: string[];
  /** `*.*` (global), `db.*` or `db.table`. */
  scope: string;
}

/** The privileges and scope of each GRANT line; role grants (GRANT `r`@`%` TO …) are returned apart. */
export function parseGrants(lines: string[]): { grants: Grant[]; roles: string[] } {
  const grants: Grant[] = [];
  const roles: string[] = [];
  for (const line of lines) {
    const m = /^GRANT (.+?) ON (?:(?:TABLE|FUNCTION|PROCEDURE) )?(\S+) TO /i.exec(line);
    if (m) {
      // Column privileges ("SELECT (a, b)") keep their name only.
      const privileges = (m[1] as string)
        .replace(/\([^)]*\)/g, "")
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);
      grants.push({ privileges, scope: (m[2] as string).replaceAll("`", "") });
      continue;
    }
    const r = /^GRANT (.+?) TO /i.exec(line);
    if (r && !/ ON /i.test(line)) roles.push(...(r[1] as string).split(",").map((x) => x.trim()));
  }
  return { grants, roles };
}

/** What a set of grants allows, for the read-only check. */
export function judgeGrants(grants: Grant[]) {
  const blockedBy = new Set<string>();
  const writes = new Set<string>();
  const writeScopes = new Set<string>();
  for (const g of grants) {
    const global = g.scope === "*.*";
    for (const p of g.privileges) {
      if (BLOCKING.has(p) || p.endsWith("_ADMIN") || (global && p === "ALL PRIVILEGES")) blockedBy.add(p);
      else if (WRITES.has(p) || p === "ALL PRIVILEGES" || p === "ALL") {
        writes.add(p === "ALL" ? "ALL PRIVILEGES" : p);
        writeScopes.add(g.scope);
      }
    }
  }
  return { blockedBy: [...blockedBy], writes: [...writes], writeScopes: [...writeScopes] };
}

export async function probeMySql(
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
  const { set, stop } = stepper(checks, facts, options.onCheck);

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

  await set("sign-in", { status: "running" });
  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession(config, address, password, { ...options, applicationName: "opendash-probe" });
  } catch (error) {
    return stop("sign-in", "failed", friendlyError(error, config, options.connectTimeoutMs));
  }
  const rows = async <T>(sql: string) => (await session.conn.query(sql))[0] as T[];
  try {
    const [who] = await rows<{ user: string; version: string }>("select current_user() as user, version() as version");
    const [cipher] = await rows<{ Value: string }>("show session status like 'Ssl_cipher'");
    const [marker] = await rows<{ n: number }>(
      `select count(*) as n from information_schema.tables where ${SYSTEM} and table_comment like '${SAMPLE_DATA}'`,
    );
    facts.user = who?.user;
    facts.serverVersion = who?.version;
    facts.ssl = Boolean(cipher?.Value);
    facts.sampleData = Number(marker?.n ?? 0) > 0;
    await set("sign-in", { status: "ok", label: `Signed in as ${facts.user}`, detail: facts.ssl ? "SSL" : "No SSL" });

    // The privileges, roles included. The blocking ones are checked first: such a user is refused, never offered an
    // override.
    await set("read-only", { status: "running" });
    const lines = (await rows<Record<string, string>>("show grants")).map((r) => Object.values(r)[0] as string);
    let { grants, roles } = parseGrants(lines);
    if (roles.length) {
      const using = (
        await rows<Record<string, string>>(`show grants for current_user() using ${roles.join(", ")}`)
      ).map((r) => Object.values(r)[0] as string);
      grants = parseGrants(using).grants;
    }
    const judged = judgeGrants(grants);
    if (judged.blockedBy.length) {
      facts.blockedBy = judged.blockedBy;
      return await stop(
        "read-only",
        "blocked",
        `This user is allowed ${judged.blockedBy.join(", ")}, which reaches beyond your data. Use a read-only user.`,
      );
    }
    facts.writePrivileges = judged.writes;
    if (judged.writes.length) {
      const scoped = judged.writeScopes.map((s) => s.split("."));
      const [w] = scoped.length
        ? await rows<{ n: number }>(
            `select count(*) as n from information_schema.tables where ${SYSTEM} and (${scoped
              .map(([db, t]) =>
                db === "*"
                  ? "true"
                  : `(table_schema = ${session.conn.escape(db)}${t && t !== "*" ? ` and table_name = ${session.conn.escape(t)}` : ""})`,
              )
              .join(" or ")})`,
          )
        : [{ n: 0 }];
      facts.writableTables = Number(w?.n ?? 0);
      await set("read-only", {
        status: "warn",
        label: "Has write access",
        detail: `${judged.writes.join(", ")} on ${fmt(facts.writableTables)} ${facts.writableTables === 1 ? "table" : "tables"}`,
      });
    } else {
      facts.writableTables = 0;
      await set("read-only", { status: "ok", label: "Read-only verified", detail: "No write grants" });
    }

    await set("catalog", { status: "running" });
    // Aliases quoted: TABLES, SCHEMAS and COLUMNS are MySQL keywords.
    const [cat] = await rows<{ tables: number; schemas: number; columns: number }>(
      `select count(*) as \`tables\`, count(distinct t.table_schema) as \`schemas\`,
         coalesce(sum((select count(*) from information_schema.columns c
           where c.table_schema = t.table_schema and c.table_name = t.table_name)), 0) as \`columns\`
       from information_schema.tables t where t.${SYSTEM}`,
    );
    facts.tables = Number(cat?.tables ?? 0);
    facts.schemas = Number(cat?.schemas ?? 0);
    facts.columns = Number(cat?.columns ?? 0);
    if (facts.tables === 0) {
      await set("catalog", {
        status: "warn",
        label: "No readable tables",
        detail: "Grant SELECT on the tables to ask about",
      });
    } else {
      await set("catalog", {
        status: "ok",
        label: `Found ${fmt(facts.tables)} ${facts.tables === 1 ? "table" : "tables"} in ${fmt(facts.schemas)} ${facts.schemas === 1 ? "database" : "databases"}`,
        detail: `${fmt(facts.columns)} columns`,
      });
    }
    const outcome = checks.some((c) => c.key === "read-only" && c.status === "warn") ? "warning" : "passed";
    return { outcome, checks, facts };
  } catch (error) {
    const running = checks.find((c) => c.status === "running")?.key ?? "catalog";
    return await stop(running, "failed", friendlyError(error, config, options.connectTimeoutMs));
  } finally {
    await session.close();
  }
}
