/**
 * MySQL's query history (its MySQL part): the server's recent statements, from
 * performance_schema.events_statements_history_long (a ring buffer, its last 10,000 statements by default), grouped by
 * digest. Its digest summary has no per-user split, so OpenDash's own statements are told apart by the tag every one of
 * them carries (`OPENDASH_TAG`, kept in SQL_TEXT, dropped from DIGEST_TEXT). Only the normalized digest text leaves
 * (literals as `?`), only reads that ran without an error.
 *
 * It needs SELECT on two tables, never performance_schema.*: `setup_consumers` (whether the buffer is on) and
 * `events_statements_history_long`. The second holds other sessions' statement text with its values; SQL_TEXT is read
 * on the server, for the tag, and never returned.
 */
import type { QueryHistory } from "../dialect";
import { type MySqlSession, OPENDASH_TAG } from "./session";

export async function queryHistoryMySql(session: MySqlSession, limit: number): Promise<QueryHistory> {
  const rows = async <T>(sql: string, values: unknown[] = []) => (await session.conn.query(sql, values))[0] as T[];
  try {
    const [on] = await rows<{ enabled: string | null; schema_on: number }>(
      `select (select ENABLED from performance_schema.setup_consumers where NAME = 'events_statements_history_long')
         as enabled, @@performance_schema as schema_on`,
    );
    if (!on?.schema_on) {
      return { available: false, reason: "This server runs with performance_schema off, so it keeps no statements." };
    }
    if (on.enabled !== "YES") {
      return {
        available: false,
        reason:
          "This server doesn't keep its recent statements. Turn on the events_statements_history_long consumer: UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = 'events_statements_history_long'.",
      };
    }
    const found = await rows<{ fingerprint: string; sql: string; calls: number | string; total_ms: number | string }>(
      `select h.DIGEST as fingerprint, any_value(h.DIGEST_TEXT) as \`sql\`, count(*) as calls,
         round(sum(h.TIMER_WAIT) / 1e9, 3) as total_ms
       from performance_schema.events_statements_history_long h
       where h.DIGEST is not null and h.ERRORS = 0
         and (h.DIGEST_TEXT like 'SELECT %' or h.DIGEST_TEXT like 'WITH %')
         and (h.SQL_TEXT is null or h.SQL_TEXT not like ?)
       group by h.DIGEST
       order by calls desc, fingerprint
       limit ?`,
      [`${OPENDASH_TAG}%`, limit],
    );
    return {
      available: true,
      statements: found.map((r) => ({
        fingerprint: r.fingerprint,
        sql: r.sql,
        calls: Number(r.calls),
        totalMs: Number(r.total_ms),
      })),
    };
  } catch (error) {
    const message = String((error as { message?: string }).message ?? error);
    if (/command denied|access denied/i.test(message)) {
      return {
        available: false,
        reason:
          "The user OpenDash connects as can't read the server's recent statements. Grant it SELECT on performance_schema.setup_consumers and performance_schema.events_statements_history_long. That buffer holds other sessions' statements with their values; OpenDash keeps only the normalized digest, every value a placeholder.",
      };
    }
    throw error;
  }
}
