/**
 * Postgres's query history: pg_stat_statements, which keeps each statement normalized ($1 for
 * every literal). Reads only, in this database, not run by the role OpenDash connects as.
 */
import { normalize, scan } from "libpg-query";
import type postgres from "postgres";
import type { QueryHistory } from "../dialect";

/**
 * pg_stat_statements keeps a statement's comments as they were written: a tool's tags, a person's notes, text anyone
 * who can query the database could plant. They're cut out with Postgres's own lexer (its positions are bytes), and
 * anything still a literal becomes a placeholder. Null when the lexer can't read it: then it isn't kept.
 */
export async function withoutComments(text: string): Promise<string | null> {
  try {
    const { tokens } = await scan(text);
    const bytes = Buffer.from(text, "utf8");
    const kept: string[] = [];
    let at = 0;
    for (const t of tokens) {
      if (t.tokenName !== "SQL_COMMENT" && t.tokenName !== "C_COMMENT") continue;
      kept.push(bytes.subarray(at, t.start).toString("utf8"));
      at = t.end;
    }
    kept.push(bytes.subarray(at).toString("utf8"));
    return (await normalize(kept.join(" "))).trim() || null;
  } catch {
    return null;
  }
}

const HIDDEN = "<insufficient privilege>";

export async function queryHistoryPostgres(sql: postgres.Sql, limit: number): Promise<QueryHistory> {
  let rows: { fingerprint: string; query: string; calls: number; total_ms: number }[];
  try {
    rows = await sql.unsafe(
      `select s.queryid::text as fingerprint, s.query, s.calls::float8 as calls, s.total_exec_time::float8 as total_ms
       from pg_stat_statements s
       where s.dbid = (select oid from pg_database where datname = current_database())
         and s.userid <> (select oid from pg_roles where rolname = current_user)
         -- Reads (after any leading comments), and the rows the role isn't allowed to see (counted below, to say so).
         and (s.query ~* '^\\s*(/\\*.*?\\*/\\s*|--[^\\n]*\\n\\s*)*(with|select)\\s' or s.query = '<insufficient privilege>')
       order by s.calls desc
       limit $1`,
      [limit],
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01") {
      return {
        available: false,
        reason:
          "pg_stat_statements isn't installed in this database. To share how your team queries it, load it (shared_preload_libraries = 'pg_stat_statements') and run create extension pg_stat_statements.",
      };
    }
    if (code === "55000") {
      return {
        available: false,
        reason:
          "pg_stat_statements is installed but not loaded. Add it to shared_preload_libraries and restart Postgres.",
      };
    }
    if (code === "42501") {
      return { available: false, reason: "The role OpenDash connects as can't read pg_stat_statements." };
    }
    throw error;
  }
  const visible = rows.filter((r) => r.query !== HIDDEN);
  if (rows.length && !visible.length) {
    return {
      available: false,
      reason:
        "The role OpenDash connects as can't see other people's statements. Grant it pg_read_all_stats to share query history.",
    };
  }
  const statements = [];
  for (const r of visible) {
    const text = await withoutComments(r.query);
    if (!text) continue;
    statements.push({
      fingerprint: r.fingerprint,
      sql: text,
      calls: Number(r.calls),
      totalMs: Math.round(Number(r.total_ms)),
    });
  }
  return { available: true, statements };
}
