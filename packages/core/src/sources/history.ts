/**
 * Query history v0: the team's most-run reads of a
 * source, from the history its database keeps, as the last step of a sync. Each statement's tables and columns come
 * from the dialect's own analysis (or the log's record of them), matched to the catalog; a statement that reads a
 * table the catalog doesn't know is skipped. What matches becomes usage (catalog_object.usage_score) and patterns
 * (query_pattern). Statements are kept normalized, without comments: no literal values, no free text.
 */
import type { Dialect, DialectSession, HistoryStatement } from "@opendash/connectors";
import { sql, type TenantTx } from "@opendash/db";

/** The most-run statements read from the history, and kept. */
export const HISTORY_LIMIT = 500;

export type HistoryResult =
  | { status: "ok"; statements: number; tables: number }
  | { status: "skipped"; reason: string };

type CatalogRow = { id: string; fq_name: string; kind: "table" | "view" | "column"; parent: string | null };

interface Matched {
  statement: HistoryStatement;
  tables: string[];
  columns: string[];
}

/** schema.table → the catalog's id, and each table's columns by name. */
function catalogIndex(rows: CatalogRow[]) {
  const tables = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const columns = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (r.kind === "column") continue;
    const fq = r.fq_name.toLowerCase();
    tables.set(fq, r.id);
    const name = fq.split(".").pop() as string;
    byName.set(name, [...(byName.get(name) ?? []), fq]);
  }
  for (const r of rows) {
    if (r.kind !== "column") continue;
    const parts = r.fq_name.toLowerCase().split(".");
    const table = parts.slice(0, -1).join(".");
    const map = columns.get(table) ?? new Map<string, string>();
    map.set(parts[parts.length - 1] as string, r.id);
    columns.set(table, map);
  }
  return { tables, byName, columns };
}

async function match(
  dialect: Dialect,
  session: DialectSession,
  statement: HistoryStatement,
  index: ReturnType<typeof catalogIndex>,
): Promise<Matched | null> {
  const resolve = (schema: string | null, name: string) => {
    const n = name.toLowerCase();
    if (schema) return index.tables.has(`${schema.toLowerCase()}.${n}`) ? `${schema.toLowerCase()}.${n}` : null;
    const candidates = index.byName.get(n) ?? [];
    return candidates.length === 1 ? (candidates[0] as string) : null;
  };
  // Every table it reads must be one the catalog knows: a pattern never shows tables OpenDash can't see.
  if (statement.tables) {
    const found = statement.tables.map((t) => {
      const [schema, ...rest] = t.split(".");
      return rest.length ? resolve(schema as string, rest.join(".")) : resolve(null, t);
    });
    if (!found.length || found.some((t) => !t)) return null;
    const tables = [...new Set(found as string[])];
    const columns = (statement.columns ?? []).flatMap((c) => {
      const parts = c.toLowerCase().split(".");
      const id = index.columns.get(parts.slice(0, -1).join("."))?.get(parts[parts.length - 1] as string);
      return id ? [id] : [];
    });
    return { statement, tables, columns: [...new Set(columns)] };
  }
  const checked = await dialect
    .validate(statement.sql, { session: async () => session, params: [], timeoutMs: 5_000 })
    .catch(() => null);
  if (!checked?.ok) return null;
  const aliases = new Map<string, string>();
  const tables: string[] = [];
  for (const t of checked.info.tables) {
    const fq = resolve(t.schema, t.name);
    if (!fq) return null;
    tables.push(fq);
    aliases.set(t.name.toLowerCase(), fq);
    if (t.alias) aliases.set(t.alias.toLowerCase(), fq);
  }
  if (!tables.length) return null;
  const columns = new Set<string>();
  for (const ref of checked.info.references) {
    const col = ref.column.toLowerCase();
    const owners = ref.qualifier
      ? [aliases.get(ref.qualifier.toLowerCase())].filter((x): x is string => Boolean(x))
      : tables.filter((t) => index.columns.get(t)?.has(col));
    for (const owner of owners) {
      const id = index.columns.get(owner)?.get(col);
      if (id) columns.add(id);
    }
  }
  return { statement, tables: [...new Set(tables)], columns: [...columns] };
}

/** Whether the source is still there, holding it until the write commits (removeSource locks the same row, first). */
async function present(tx: TenantTx, job: { orgId: string; connectionId: string }): Promise<boolean> {
  const [c] = await tx.execute<{ id: string }>(sql`
    select id from app.connection
    where org_id = ${job.orgId} and id = ${job.connectionId} and deleted_at is null
    for share`);
  return Boolean(c);
}

const REMOVED = { status: "skipped", reason: "This source was removed." } as const;
/** Every role's statements but its own: a team that connects as OpenDash's role looks like no one. */
const NO_ONE_ELSE =
  "Its query history has no reads by anyone but the role OpenDash connects as. If your team uses that role too, give OpenDash a role of its own, so their queries can be told from its own.";

/**
 * Reads the source's history and writes what it yields, replacing the last mining's. Never throws for a history
 * that isn't there: that's `skipped`, with why.
 */
export async function mineHistory(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T> },
  job: { orgId: string; connectionId: string },
  dialect: Dialect,
  session: DialectSession,
): Promise<HistoryResult> {
  if (!dialect.queryHistory) {
    return { status: "skipped", reason: `OpenDash doesn't read ${dialect.name}'s query history yet.` };
  }
  const history = await dialect.queryHistory(session, { limit: HISTORY_LIMIT });
  if (!history.available) {
    const kept = await deps.withTenant(job.orgId, async (tx) => {
      if (!(await present(tx, job))) return false;
      await tx.execute(sql`
        delete from app.query_pattern where org_id = ${job.orgId} and connection_id = ${job.connectionId}`);
      return true;
    });
    return kept ? { status: "skipped", reason: history.reason } : REMOVED;
  }
  const rows = await deps.withTenant(job.orgId, (tx) =>
    tx.execute<CatalogRow>(sql`
      select id, fq_name, kind, parent_id as parent from app.catalog_object
      where org_id = ${job.orgId} and connection_id = ${job.connectionId} and removed_at is null
        and kind in ('table', 'view', 'column')`),
  );
  const index = catalogIndex(rows);
  const matched: Matched[] = [];
  for (const statement of history.statements) {
    const m = await match(dialect, session, statement, index);
    if (m) matched.push(m);
  }
  const usage = new Map<string, number>();
  for (const m of matched) {
    for (const fq of m.tables) {
      const id = index.tables.get(fq) as string;
      usage.set(id, (usage.get(id) ?? 0) + m.statement.calls);
    }
    for (const id of m.columns) usage.set(id, (usage.get(id) ?? 0) + m.statement.calls);
  }
  const written = await deps.withTenant(job.orgId, async (tx) => {
    if (!(await present(tx, job))) return false;
    await tx.execute(sql`
      delete from app.query_pattern where org_id = ${job.orgId} and connection_id = ${job.connectionId}`);
    for (const m of matched) {
      await tx.execute(sql`
        insert into app.query_pattern (org_id, connection_id, fingerprint, sql, calls, total_ms, tables)
        values (${job.orgId}, ${job.connectionId}, ${m.statement.fingerprint}, ${m.statement.sql.slice(0, 8000)},
          ${Math.round(m.statement.calls)}, ${Math.round(m.statement.totalMs)}, ${JSON.stringify(m.tables)}::jsonb)
        on conflict do nothing`);
    }
    await tx.execute(sql`
      update app.catalog_object set usage_score = 0
      where org_id = ${job.orgId} and connection_id = ${job.connectionId} and usage_score <> 0`);
    const scores = [...usage.entries()];
    for (let i = 0; i < scores.length; i += 500) {
      const chunk = scores.slice(i, i + 500);
      await tx.execute(sql`
        update app.catalog_object o set usage_score = u.calls
        from jsonb_to_recordset(${JSON.stringify(chunk.map(([id, calls]) => ({ id, calls })))}::jsonb)
          as u(id uuid, calls real)
        where o.org_id = ${job.orgId} and o.id = u.id`);
    }
    return true;
  });
  if (!written) return REMOVED;
  // What was there before is cleared either way; with nothing to show, say why.
  if (!history.statements.length) return { status: "skipped", reason: NO_ONE_ELSE };
  if (!matched.length) {
    const n = history.statements.length;
    return {
      status: "skipped",
      reason:
        n === 1
          ? "The one read in its query history isn't of a table OpenDash learned."
          : `None of the ${n.toLocaleString("en-US")} reads in its query history are of tables OpenDash learned.`,
    };
  }
  const tables = new Set(matched.flatMap((m) => m.tables)).size;
  return { status: "ok", statements: matched.length, tables };
}

/** A table's most-run queries (its file in the knowledge folder, the table's page): normalized, most-run first. */
export async function tablePatterns(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  table: string,
  limit = 3,
): Promise<{ sql: string; calls: number }[]> {
  // bigint arrives as text: order by the column, never by a text alias of it.
  const rows = await tx.execute<{ sql: string; calls: string }>(sql`
    select sql, calls from app.query_pattern
    where org_id = ${orgId} and connection_id = ${connectionId} and tables ? ${table.toLowerCase()}
    order by calls desc, fingerprint limit ${limit}`);
  return rows.map((r) => ({ sql: r.sql, calls: Number(r.calls) }));
}
