/**
 * A connection to a customer's Postgres, the only way connectors open one: the host is vetted for this
 * edition and the session goes to the vetted address (with verify-full, TLS still checks the typed name), it's
 * read-only, and every statement has a server-side timeout. Nothing here ever writes to the customer's database.
 */
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import postgres from "postgres";
import { certificateAdvice, trustedCa, verifies } from "../tls";

export { reach, tcpReach } from "../network";

export type SslMode = "disable" | "require" | "verify-full";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  /** verify-full only: the CA (PEM) that signed the server's certificate, trusted instead of the public ones. */
  ca?: string;
}

export const hostPort = (c: PostgresConfig) => `${c.host}:${c.port}`;

export function friendlyError(error: unknown, config: PostgresConfig, timeoutMs: number): string {
  const e = error as { code?: string; message?: string };
  switch (e.code) {
    case "28P01":
      return "The user name or password is wrong.";
    case "28000":
      return "The server refused this user. Check pg_hba.conf allows it from OpenDash.";
    case "3D000":
      return `There's no database called ${config.database}.`;
    case "ECONNREFUSED":
      return `Nothing is accepting connections on ${hostPort(config)}.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Couldn't find ${config.host}. Check the host name.`;
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
      return `No answer from ${hostPort(config)} within ${timeoutMs / 1000} s. Check the firewall or IP allowlist.`;
    default:
      if (/self[- ]signed|certificate|unable to verify/i.test(e.message ?? "")) return certificateAdvice(config);
      if (/does not support SSL|server does not support/i.test(e.message ?? "")) {
        return "The server doesn't accept SSL connections. Use SSL mode “disable” only on a private network.";
      }
      return e.message ?? "Something went wrong.";
  }
}

/**
 * TLS settings for a connection made to the vetted address (../tls.ts). With verify-full the certificate is checked
 * against the host the user typed: a name through servername, so it works when OpenDash connects by IP; an IP by its
 * own check, since postgres.js then gives TLS no host at all and Node would check against "localhost".
 */
export function tlsOptions(config: PostgresConfig):
  | false
  | {
      rejectUnauthorized: boolean;
      servername?: string;
      ca?: string;
      checkServerIdentity?: (name: string, cert: PeerCertificate) => Error | undefined;
    } {
  if (config.sslMode === "disable") return false;
  const rejectUnauthorized = verifies(config);
  const ca = trustedCa(config);
  const typedIp = isIP(config.host) > 0;
  return {
    rejectUnauthorized,
    ...(typedIp ? {} : { servername: config.host }),
    ...(typedIp && rejectUnauthorized
      ? { checkServerIdentity: (_name: string, cert: PeerCertificate) => checkServerIdentity(config.host, cert) }
      : {}),
    ...(ca ? { ca } : {}),
  };
}

export interface SessionOptions {
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
  signal?: AbortSignal;
}

/** A read-only, single-connection client to the vetted address. Aborting the signal closes it. */
export function openSession(config: PostgresConfig, address: string, password: string, options: SessionOptions) {
  const sql = postgres({
    host: address,
    port: config.port,
    database: config.database,
    username: config.user,
    password,
    ssl: tlsOptions(config),
    max: 1,
    prepare: false,
    connect_timeout: Math.ceil(options.connectTimeoutMs / 1000),
    idle_timeout: 1,
    onnotice: () => {},
    connection: {
      application_name: options.applicationName,
      statement_timeout: options.statementTimeoutMs,
      default_transaction_read_only: true,
      TimeZone: "UTC",
      // Unqualified table names mean public.<name> to the server, exactly as the gateway's checks resolve them.
      search_path: "public",
    },
  });
  const abort = () => void sql.end({ timeout: 0 });
  options.signal?.addEventListener("abort", abort, { once: true });
  return {
    sql,
    close: async () => {
      options.signal?.removeEventListener("abort", abort);
      await sql.end({ timeout: 1 }).catch(() => {});
    },
  };
}
