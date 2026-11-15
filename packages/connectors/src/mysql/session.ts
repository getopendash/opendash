/**
 * A connection to a customer's MySQL, the only way connectors open one: the host is vetted for this edition
 * and the connection goes to the vetted address (with verify-full, TLS still checks the typed name). The session is
 * read-only (transaction_read_only), runs in UTC, and every query gets a server-side time limit. Nothing here ever
 * writes to the customer's database.
 */
import { connect, isIP } from "node:net";
import mysql, { type Connection } from "mysql2/promise";
import { type DialectSession, QueryError } from "../dialect";
import type { PostgresConfig } from "../postgres/session";
import { certificateAdvice, trustedCa, verifies } from "../tls";

export { reach } from "../network";

export const hostPort = (c: PostgresConfig) => `${c.host}:${c.port}`;

export function friendlyError(error: unknown, config: PostgresConfig, timeoutMs: number): string {
  const e = error as { code?: string; errno?: number; message?: string };
  switch (e.code) {
    case "ER_ACCESS_DENIED_ERROR":
      return "The user name or password is wrong.";
    case "ER_DBACCESS_DENIED_ERROR":
      return `This user can't open the database ${config.database}. Grant it SELECT there.`;
    case "ER_BAD_DB_ERROR":
      return `There's no database called ${config.database}.`;
    case "ER_HOST_NOT_PRIVILEGED":
      return "The server refused this user from OpenDash's address. Allow it from there.";
    case "ECONNREFUSED":
      return `Nothing is accepting connections on ${hostPort(config)}.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Couldn't find ${config.host}. Check the host name.`;
    case "ETIMEDOUT":
      return `No answer from ${hostPort(config)} within ${timeoutMs / 1000} s. Check the firewall or IP allowlist.`;
    default:
      if (/self[- ]signed|certificate|unable to verify|does not match|altnames/i.test(e.message ?? "")) {
        return certificateAdvice(config);
      }
      if (/does not support secure connection|ssl.*not.*support/i.test(e.message ?? "")) {
        return "The server doesn't accept SSL connections. Use SSL mode “disable” only on a private network.";
      }
      return e.message ?? "Something went wrong.";
  }
}

/**
 * TLS for a connection to the vetted address (../tls.ts). mysql2 names the server, and checks the certificate's names,
 * only from its `host` and only with `verifyIdentity`: so `host` is the name typed and the socket is opened to the
 * vetted address apart from it (`mysqlSettings`).
 */
function tls(config: PostgresConfig) {
  if (config.sslMode === "disable") return undefined;
  if (!verifies(config)) return { rejectUnauthorized: false };
  const ca = trustedCa(config);
  return { rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) };
}

/** MySQL 8.4's default sql_mode: what the statement check (node-sql-parser's MySQL grammar) reads SQL as. */
export const SQL_MODE =
  "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

export interface SessionOptions {
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
  signal?: AbortSignal;
}

export interface MySqlSession extends DialectSession {
  conn: Connection;
  /** Stops the query running on this connection, from another one (the cap, or a cancelled run). */
  kill: () => Promise<void>;
}

/**
 * Every statement OpenDash sends starts with this comment, so the server's own history can leave OpenDash's queries out
 * (MySQL's digest summary has no per-user split; SQL_TEXT keeps a leading comment, DIGEST_TEXT drops it).
 */
export const OPENDASH_TAG = "/* opendash */";

const tagged = (q: unknown): unknown =>
  typeof q === "string"
    ? `${OPENDASH_TAG} ${q}`
    : q &&
        typeof q === "object" &&
        typeof (q as { sql?: unknown }).sql === "string" &&
        Object.getPrototypeOf(q) === Object.prototype
      ? { ...(q as object), sql: `${OPENDASH_TAG} ${(q as { sql: string }).sql}` }
      : q;

/** MySQL's BOOLEAN is TINYINT(1): read it as a boolean, as Postgres and ClickHouse return theirs. */
const typeCast = (field: { type: string; length: number; string: () => string | null }, next: () => unknown) =>
  field.type === "TINY" && field.length === 1 ? ((v) => (v === null ? null : v === "1"))(field.string()) : next();

/**
 * mysql2's settings for a connection to the vetted address: each connection (the session's, and the one that stops its
 * query) opens its own socket there, while mysql2 knows the server by the name typed, which TLS checks.
 */
export function mysqlSettings(config: PostgresConfig, address: string, password: string, options: SessionOptions) {
  return {
    host: config.host,
    port: config.port,
    stream: () => {
      const socket = connect({ host: address, port: config.port, noDelay: true, keepAlive: true });
      // A host typed as an IP: mysql2 then gives TLS no name, and Node checks the certificate against the socket's
      // own host, which it records only for names (else "localhost"). Recorded here: the certificate must name it.
      if (isIP(config.host)) (socket as unknown as { _host?: string })._host = config.host;
      return socket;
    },
    user: config.user,
    password,
    database: config.database,
    ssl: tls(config),
    connectTimeout: options.connectTimeoutMs,
    // Exact values stay strings (decimals, big integers); times come as text and are read as UTC.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    timezone: "Z",
    typeCast,
    connectAttributes: { program_name: options.applicationName },
  } as const;
}

/** A read-only connection to the vetted address. Aborting the signal closes it. */
export async function openSession(
  config: PostgresConfig,
  address: string,
  password: string,
  options: SessionOptions,
): Promise<MySqlSession> {
  const settings = mysqlSettings(config, address, password, options);
  const conn = await mysql.createConnection(settings as never);
  // Tag at the driver: the promise API and the streaming path both send through the core connection's query.
  const core = (conn as unknown as { connection: { query: (...args: unknown[]) => unknown } }).connection;
  const send = core.query.bind(core);
  core.query = (q: unknown, ...rest: unknown[]) => send(tagged(q), ...rest);
  const abort = () => conn.destroy();
  // Cancelled while it connected: closed at once, never used.
  if (options.signal?.aborted) {
    conn.destroy();
    throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    // A known sql_mode (MySQL 8.4's default), whatever the server's: ANSI_QUOTES would make "x" a column to the server
    // and a string to the statement check, and PIPES_AS_CONCAT or NO_BACKSLASH_ESCAPES would change how it reads too.
    await conn.query(
      `set session sql_mode = '${SQL_MODE}', session time_zone = '+00:00', session transaction_read_only = 1, session max_execution_time = ${Math.max(1, Math.floor(options.statementTimeoutMs))}`,
    );
  } catch (error) {
    conn.destroy();
    throw error;
  }
  return {
    conn,
    kill: async () => {
      const side = await mysql.createConnection(settings as never).catch(() => null);
      if (!side) return;
      try {
        await side.query(`kill query ${Number(conn.threadId)}`);
      } catch {
        // It already ended.
      } finally {
        await side.end().catch(() => side.destroy());
      }
    },
    close: async () => {
      options.signal?.removeEventListener("abort", abort);
      await conn.end().catch(() => conn.destroy());
    },
  };
}
