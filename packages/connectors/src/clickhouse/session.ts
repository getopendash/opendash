/**
 * A connection to a customer's ClickHouse over its HTTP interface. Like Postgres:
 *   - the host is vetted for this edition, and every request goes to the vetted address: the HTTP agent's DNS lookup
 *     answers only that address, while with verify-full TLS still checks the certificate against the host name the
 *     user typed (../tls.ts);
 *   - every query is read-only and bounded on the server: `readonly = 1` when the user may still write (a user whose
 *     profile already has `readonly = 2` can't write tables, and can't change `readonly` either), a server-side time
 *     limit, a row cap, standard NULLs in joins, UTC, and a cancel when the client goes away.
 * A user with `readonly = 1` can't change any setting, so its server's own must already be what OpenDash would set: a
 * time limit no longer than ours, the analyzer and UTC (fixedSettingsProblem). A public demo server such as ClickHouse's
 * playground is set up like that. Its queries carry no settings; the statement check refuses outer joins when its
 * joins don't return NULL, and results are read with exact numbers without the quoting settings (dialect.ts).
 */
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { type ClickHouseClient, ClickHouseLogLevel, type ClickHouseSettings, createClient } from "@clickhouse/client";
import type { DialectSession, OpenOptions, SourceConfig } from "../dialect";
import { reach } from "../network";
import { certificateAdvice, trustedCa, verifies } from "../tls";

export interface ClickHouseSession extends DialectSession {
  client: ClickHouseClient;
  config: SourceConfig;
  /** The user's readonly level from its profile: 0 (OpenDash sets readonly = 1 per query), 1 or 2. */
  readonly: number;
  /** For a readonly = 1 user, the server's settings its queries run with, since it can't change them; else null. */
  fixed: FixedSettings | null;
  version: string;
  statementTimeoutMs: number;
}

export interface FixedSettings {
  /** max_execution_time; 0 is none. */
  timeLimitSeconds: number;
  /** timeout_overflow_mode is `throw`, so a query past the limit fails rather than returning part of its result. */
  overflowThrows: boolean;
  analyzer: boolean;
  /** join_use_nulls: outer joins return NULL for missing rows, not the type's default. */
  joinNulls: boolean;
  timezone: string;
}

/** The longest server time limit a readonly = 1 user may have: the gateway's own per-query budget (budgets.test.ts). */
export const MAX_FIXED_TIME_LIMIT_SECONDS = 60;

/** Why a readonly = 1 user's server settings don't bound and shape queries the way OpenDash's would; null if they do. */
export function fixedSettingsProblem(fixed: FixedSettings | null): string | null {
  const fix = "Give it readonly = 2 instead (it stays read-only).";
  if (!fixed) return `This user has readonly = 1, so OpenDash can't set its per-query settings. ${fix}`;
  if (!(fixed.timeLimitSeconds > 0) || !fixed.overflowThrows) {
    return `This user has readonly = 1 and its server sets no time limit, so OpenDash can't bound its queries. ${fix}`;
  }
  if (fixed.timeLimitSeconds > MAX_FIXED_TIME_LIMIT_SECONDS) {
    return `This user has readonly = 1 and its server's time limit is ${fixed.timeLimitSeconds} s, longer than OpenDash's ${MAX_FIXED_TIME_LIMIT_SECONDS} s. ${fix}`;
  }
  if (!fixed.analyzer) {
    return `This user has readonly = 1 and the query analyzer off, which OpenDash's statement check needs. ${fix}`;
  }
  if (!/^(Etc\/)?(UTC|UCT|Universal|Zulu)$/.test(fixed.timezone)) {
    return `This user has readonly = 1 and its server's time zone is ${fixed.timezone}, not UTC. ${fix}`;
  }
  return null;
}

/** The oldest ClickHouse with the query analyzer on by default, which the statement check relies on. */
export const MIN_VERSION = [24, 3] as const;

export const versionOk = (version: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_VERSION[0] || (major === MIN_VERSION[0] && minor >= MIN_VERSION[1]);
};

const hostPort = (c: SourceConfig) => `${c.host}:${c.port}`;

export function friendlyError(error: unknown, config: SourceConfig, timeoutMs: number): string {
  const outer = error as { code?: string; message?: string; type?: string; cause?: unknown };
  const cause = outer.cause as { code?: string } | undefined;
  const e = (cause && typeof cause === "object" && cause.code ? cause : outer) as typeof outer;
  const message = e.message ?? "";
  switch (e.code) {
    case "516":
    case "192":
      return "The user name or password is wrong.";
    case "81":
      return `There's no database called ${config.database}, or this user can't see it.`;
    case "164":
      return "This user has readonly = 1, so OpenDash can't set its per-query time limit. Give it readonly = 2 instead (it stays read-only).";
    case "ECONNREFUSED":
      return `Nothing is accepting connections on ${hostPort(config)}.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Couldn't find ${config.host}. Check the host name.`;
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
      return `No answer from ${hostPort(config)} within ${timeoutMs / 1000} s. Check the firewall or IP allowlist.`;
    default:
      if (/self[- ]signed|certificate|unable to verify/i.test(message)) return certificateAdvice(config);
      if (
        /wrong version number|EPROTO|socket hang up|ECONNRESET|packet length too long/i.test(`${e.code} ${message}`)
      ) {
        return config.sslMode === "disable"
          ? `${hostPort(config)} didn't answer plain HTTP. Use an SSL mode for the HTTPS port (usually 8443).`
          : `${hostPort(config)} didn't answer HTTPS. Check the port (HTTPS is usually 8443), or use SSL mode “disable” for plain HTTP on a private network (usually 8123).`;
      }
      return message.replace(/\s*\(version [^)]*\)\s*$/, "") || "Something went wrong.";
  }
}

/** Settings on every query: bounded, UTC, SQL-standard joins, exact numbers as strings, cancelled with the client. */
export function querySettings(session: ClickHouseSession, timeoutMs: number): ClickHouseSettings {
  // A readonly = 1 user's server already has them (fixedSettingsProblem), and refuses any sent.
  if (session.readonly === 1) return {};
  return {
    ...(session.readonly === 0 ? { readonly: "1" } : {}),
    // The statement check reads the analyzer's query tree, so the analyzer must also run the query: a profile
    // that turns it off would make the query that runs differ from the one checked.
    enable_analyzer: 1,
    max_execution_time: Math.max(1, Math.ceil(timeoutMs / 1000)),
    timeout_overflow_mode: "throw",
    join_use_nulls: 1,
    session_timezone: "UTC",
    cancel_http_readonly_queries_on_client_close: 1,
    output_format_json_quote_64bit_integers: 1,
    output_format_json_quote_decimals: 1,
  } as ClickHouseSettings;
}

/** The text of a query's result (EXPLAIN output, SHOW GRANTS…), with the session's settings. */
export async function queryText(
  session: ClickHouseSession,
  query: string,
  options: { params?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const rs = await session.client.query({
    query,
    format: "TabSeparatedRaw",
    clickhouse_settings: querySettings(session, options.timeoutMs ?? session.statementTimeoutMs),
    ...(options.params ? { query_params: options.params } : {}),
    ...(options.signal ? { abort_signal: options.signal } : {}),
  });
  return rs.text();
}

/** Rows as objects, for the catalog and the profiler. */
export async function queryRows<T extends Record<string, unknown>>(
  session: ClickHouseSession,
  query: string,
  options: { params?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T[]> {
  const rs = await session.client.query({
    query,
    format: "JSONEachRow",
    clickhouse_settings: querySettings(session, options.timeoutMs ?? session.statementTimeoutMs),
    ...(options.params ? { query_params: options.params } : {}),
    ...(options.signal ? { abort_signal: options.signal } : {}),
  });
  return rs.json<T>();
}

/** Opens a client to the vetted address and learns the user's readonly level and the server version. */
export async function openClickHouse(
  config: SourceConfig,
  password: string,
  options: OpenOptions,
): Promise<ClickHouseSession> {
  const { address } = await reach(config, options.edition, options.connectTimeoutMs, options.signal);
  const family = isIP(address) === 6 ? 6 : 4;
  // DNS for this client answers only the vetted address, so a changed answer (rebinding) can't redirect it.
  const lookup = (
    _host: string,
    opts: { all?: boolean },
    cb: (error: null, address: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    if (opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
  const tls = config.sslMode !== "disable";
  const agent = tls
    ? new HttpsAgent({
        keepAlive: true,
        maxSockets: 2,
        lookup,
        rejectUnauthorized: verifies(config),
        ...(trustedCa(config) ? { ca: trustedCa(config) } : {}),
      })
    : new HttpAgent({ keepAlive: true, maxSockets: 2, lookup });
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  const client = createClient({
    url: `${tls ? "https" : "http"}://${host}:${config.port}`,
    username: config.user,
    password,
    database: config.database,
    application: options.applicationName,
    request_timeout: options.statementTimeoutMs + options.connectTimeoutMs,
    compression: { request: false, response: false },
    // http_agent is marked experimental in @clickhouse/client 1.23; it's how the DNS pin above is applied. If an
    // update drops it, connecting by host name after vetting would reopen a DNS-rebinding window: don't.
    http_agent: agent,
    set_basic_auth_header: true,
    // The client's own logger would print failed queries, SQL included; errors are handled (and redacted) by callers.
    log: { level: ClickHouseLogLevel.OFF },
  });
  const close = async () => {
    options.signal?.removeEventListener("abort", abort);
    await client.close().catch(() => {});
    agent.destroy();
  };
  const abort = () => void close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    // No settings on this first query: a readonly = 1 user can't change any, and this is how we find out.
    const rs = await client.query({
      query: "select toUInt8(getSetting('readonly')) as readonly, version() as version",
      format: "JSONEachRow",
      ...(options.signal ? { abort_signal: options.signal } : {}),
    });
    const [who] = await rs.json<{ readonly: number; version: string }>();
    const readonly = Number(who?.readonly ?? 0);
    let fixed: FixedSettings | null = null;
    if (readonly === 1) {
      const settings = await client.query({
        query: `select toFloat64(getSetting('max_execution_time')) as time_limit, toString(getSetting('timeout_overflow_mode')) as overflow,
          toBool(getSetting('enable_analyzer')) as analyzer, toBool(getSetting('join_use_nulls')) as join_nulls, timezone() as tz`,
        format: "JSONEachRow",
        ...(options.signal ? { abort_signal: options.signal } : {}),
      });
      const [s] = await settings.json<{
        time_limit: number;
        overflow: string;
        analyzer: boolean;
        join_nulls: boolean;
        tz: string;
      }>();
      fixed = {
        timeLimitSeconds: Number(s?.time_limit ?? 0),
        overflowThrows: s?.overflow === "throw",
        analyzer: s?.analyzer === true,
        joinNulls: s?.join_nulls === true,
        timezone: s?.tz ?? "",
      };
    }
    return {
      client,
      config,
      readonly,
      fixed,
      version: who?.version ?? "",
      statementTimeoutMs: options.statementTimeoutMs,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
