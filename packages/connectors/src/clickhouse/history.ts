/**
 * ClickHouse's query history: system.query_log over the last 30 days, finished initial SELECTs
 * only, not run by the user OpenDash connects as. Normalized with normalizeQueryKeepNames (every literal a `?`, every
 * comment dropped): plain
 * normalizeQuery also hides any name with digits in it, and its hash merges one query over different databases. The
 * log records each query's tables and columns, so nothing is parsed.
 */
import type { QueryHistory } from "../dialect";
import { type ClickHouseSession, queryRows } from "./session";

export async function queryHistoryClickHouse(session: ClickHouseSession, limit: number): Promise<QueryHistory> {
  try {
    const rows = await queryRows<{
      fingerprint: string;
      sql: string;
      calls: string;
      total_ms: string;
      read_tables: string[];
      read_columns: string[];
    }>(
      session,
      `select toString(normalizedQueryHashKeepNames(query)) as fingerprint,
         any(normalizeQueryKeepNames(query)) as sql,
         count() as calls, sum(query_duration_ms) as total_ms, groupUniqArrayArray(tables) as read_tables,
         groupUniqArrayArray(columns) as read_columns
       from system.query_log
       where type = 'QueryFinish' and query_kind = 'Select' and is_initial_query
         and user != currentUser() and event_date >= today() - 30
       group by fingerprint
       order by calls desc
       limit {limit:UInt32}`,
      { params: { limit } },
    );
    return {
      available: true,
      statements: rows.map((r) => ({
        fingerprint: r.fingerprint,
        sql: r.sql,
        calls: Number(r.calls),
        totalMs: Number(r.total_ms),
        tables: r.read_tables.filter((t) => !t.startsWith("system.")),
        columns: r.read_columns.filter((c) => !c.startsWith("system.")),
      })),
    };
  } catch (error) {
    const message = String((error as { message?: string }).message ?? error);
    if (/ACCESS_DENIED|Not enough privileges/i.test(message)) {
      return {
        available: false,
        reason: "The user OpenDash connects as can't read system.query_log. Grant it SELECT on system.query_log.",
      };
    }
    if (/UNKNOWN_TABLE|doesn't exist/i.test(message)) {
      return { available: false, reason: "This server doesn't keep a query log (system.query_log)." };
    }
    throw error;
  }
}
