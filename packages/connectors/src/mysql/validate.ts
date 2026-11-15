/**
 * The statement check for MySQL, parsed locally with node-sql-parser's MySQL grammar (Apache-2.0), as Postgres's is
 * with its own parser. It's the third layer of read-only enforcement, after the read-only user and the read-only
 * session: one SELECT (or UNION), nothing that writes, locks, reads files, sleeps, or sets variables. It also
 * collects what grounding needs: the tables, the values compared with columns, the aggregated and returned columns.
 * The server has the last word: whatever this parser accepts still runs in a read-only transaction.
 */
import sqlParser from "node-sql-parser";
import type { StatementCheck, StatementInfo } from "../dialect";
import { isMySqlFunction } from "./functions";

// A CommonJS package: its Parser comes off the default export under Node's ESM.
const parser = new sqlParser.Parser();
const OPTIONS = { database: "MySQL" };

/**
 * Functions that reach past a read-only query: files, waiting on the server or other sessions (sleep, benchmark,
 * locks, replication waits), and running code.
 */
const DENIED = [
  /^sleep$/,
  /^benchmark$/,
  /^load_file$/,
  /^(get|release|release_all|is_free|is_used)_lock$/,
  /^(master|source)_pos_wait$/,
  /^wait_for_executed_gtid_set$/,
  /^wait_until_sql_thread_after_gtids$/,
  /^sys_(exec|eval)$/,
  // Their errors quote the text they were given ("XPATH syntax error: '~…'"), a way to read a value through an
  // error; the gateway redacts quoted text from errors too, and none of them has an analytic use.
  /^(extractvalue|updatexml)$/,
  /^gtid_(subset|subtract)$/,
];
const denied = (fn: string) => DENIED.some((re) => re.test(fn));

type Node = Record<string, unknown>;
type TableRef = { schema: string | null; name: string; alias: string | null };

const isNode = (v: unknown): v is Node => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** A column_ref's column, which node-sql-parser gives as a string or as { expr: { value } }. */
const columnName = (c: unknown): string | null =>
  typeof c === "string" ? c : isNode(c) && isNode(c.expr) && typeof c.expr.value === "string" ? c.expr.value : null;

function columnRef(n: unknown): { qualifier: string | null; column: string } | null {
  if (!isNode(n) || n.type !== "column_ref") return null;
  const column = columnName(n.column);
  if (!column || column === "*") return null;
  return { qualifier: typeof n.table === "string" ? n.table : null, column };
}

const STRINGS = new Set(["single_quote_string", "double_quote_string", "string", "natural_string"]);
const isParam = (n: unknown) => isNode(n) && n.type === "origin" && n.value === "?";
const fnName = (n: Node): string => {
  if (n.type === "aggr_func") return String(n.name ?? "").toLowerCase();
  const parts = (isNode(n.name) && Array.isArray(n.name.name) ? n.name.name : []) as { value?: string }[];
  return parts
    .map((p) => String(p.value ?? ""))
    .join(".")
    .toLowerCase();
};

/** The tables directly in a FROM list (not inside subqueries): what an unqualified * expands to. */
function directTables(from: unknown): TableRef[] {
  if (!Array.isArray(from)) return [];
  return from
    .filter((f): f is Node => isNode(f) && typeof f.table === "string")
    .map((f) => ({
      schema: typeof f.db === "string" ? f.db : null,
      name: f.table as string,
      alias: typeof f.as === "string" ? f.as : null,
    }));
}

/**
 * Text the parser and the server could read differently never reaches either. MySQL runs what's inside `/*! … *\/`
 * and takes `/*+ … *\/` as hints (SET_VAR changes limits), reads `--` and `#` comments its own way, and reads
 * backslashes in strings by its sql_mode; any of them could hide a column (personal data) or a call from this check.
 * Refused outright, wherever they appear, strings included.
 */
const UNREADABLE = /\/\*|\*\/|--|#|\\/;

export function validateMySql(sql: string): StatementCheck {
  if (!sql.trim()) return { ok: false, kind: "empty", message: "There's no statement to run." };
  if (UNREADABLE.test(sql)) {
    return {
      ok: false,
      kind: "denied_clause",
      message: "Comments, # and backslashes aren't allowed in OpenDash queries on MySQL: write the query without them.",
    };
  }
  let ast: unknown;
  try {
    ast = parser.astify(sql, OPTIONS);
  } catch (error) {
    const e = error as { message?: string; location?: { start?: { offset?: number } } };
    const offset = e.location?.start?.offset;
    return {
      ok: false,
      kind: "syntax",
      message: e.message ?? "The SQL couldn't be parsed.",
      ...(offset !== undefined ? { position: offset + 1 } : {}),
    };
  }
  const stmts = (Array.isArray(ast) ? ast : [ast]).filter(isNode);
  if (stmts.length === 0) return { ok: false, kind: "empty", message: "There's no statement to run." };
  if (stmts.length > 1) return { ok: false, kind: "multiple_statements", message: "Send one statement at a time." };
  const stmt = stmts[0] as Node;
  if (stmt.type !== "select") {
    const what = String(stmt.type ?? "That statement").toUpperCase();
    return { ok: false, kind: "not_a_query", message: `${what} isn't allowed: OpenDash only runs SELECT queries.` };
  }

  const info: StatementInfo = {
    tables: [],
    literals: [],
    aggregates: [],
    joins: 0,
    references: [],
    returned: [],
    stars: [],
    params: [],
    identifiers: [],
  };
  const identifiers = new Set<string>();
  const functions = new Set<string>();
  let params = 0;
  let problem: StatementCheck | null = null;
  const fail = (kind: Exclude<StatementCheck, { ok: true }>["kind"], message: string) => {
    problem ??= { ok: false, kind, message };
  };
  const name = (s: unknown) => {
    if (typeof s === "string" && s) identifiers.add(s);
  };

  /** Columns and stars a select-list entry returns, skipping what's inside count() (no values) and subqueries. */
  const returned = (node: unknown, from: TableRef[]) => {
    if (Array.isArray(node)) {
      for (const n of node) returned(n, from);
      return;
    }
    if (!isNode(node)) return;
    if ((node.type === "aggr_func" || node.type === "function") && fnName(node) === "count") return;
    if (node.type === "select" || isNode(node.ast)) return;
    if (node.type === "column_ref") {
      if (columnName(node.column) === "*") {
        info.stars.push({ qualifier: typeof node.table === "string" ? node.table : null, from });
        return;
      }
      const ref = columnRef(node);
      if (ref) info.returned.push(ref);
      return;
    }
    for (const v of Object.values(node)) returned(v, from);
  };

  const literalOf = (n: unknown): { values: string[]; params: number[] } => {
    const items = isNode(n) && n.type === "expr_list" && Array.isArray(n.value) ? (n.value as unknown[]) : [n];
    const values: string[] = [];
    const ps: number[] = [];
    for (const item of items) {
      if (isNode(item) && STRINGS.has(String(item.type)) && typeof item.value === "string") values.push(item.value);
      // A parameter's number is its place among the statement's ?s, which the walk meets in order.
      if (isParam(item)) ps.push(params + 1 + ps.length);
    }
    return { values, params: ps };
  };

  /**
   * The CTE names a query can see: its own WITH's and those around it. A CTE's body sees the ones before it (all of
   * them under WITH RECURSIVE). Matched by exact name, so a name MySQL might fold to a CTE is still checked as a table.
   * One name set for the whole statement, as before, let a CTE named like a table hide it from every check.
   */
  const withNames = (node: Node, scope: ReadonlySet<string>) => {
    const defs = (Array.isArray(node.with) ? (node.with as Node[]) : []).flatMap((w) => {
      const n = isNode(w?.name) ? (w.name as Node).value : w?.name;
      return typeof n === "string" ? [{ name: n, def: w }] : [];
    });
    const all = new Set([...scope, ...defs.map((d) => d.name)]);
    return { defs, all, recursive: defs.some((d) => d.def?.recursive === true) };
  };

  const select = (node: Node, scope: ReadonlySet<string>) => {
    const into = node.into as Node | null | undefined;
    if (into && (into.keyword || into.expr || into.type)) {
      return fail("denied_clause", "SELECT … INTO writes a file or a variable; OpenDash only reads.");
    }
    if (node.locking_read) return fail("locks_rows", "FOR UPDATE / FOR SHARE locks rows; OpenDash only reads.");
    const from = Array.isArray(node.from) ? (node.from as unknown[]) : [];
    if (from.length > 1) info.joins += from.length - 1;
    // The parser reads a FULL JOIN; MySQL reads "full" as the first table's alias and runs an inner join, silently.
    if (from.some((f) => isNode(f) && typeof f.join === "string" && /^full\b/i.test(f.join))) {
      return fail(
        "denied_clause",
        "MySQL has no FULL JOIN (it would read full as an alias and join inner): union a LEFT JOIN with a RIGHT JOIN.",
      );
    }
    const visible = withNames(node, scope).all;
    returned(
      node.columns,
      directTables(from).filter((t) => t.schema !== null || !visible.has(t.name)),
    );
  };

  const visit = (value: unknown, scope: ReadonlySet<string>) => {
    if (problem) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, scope);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    // A query with a WITH: each CTE's body is read with the names it can see, the query itself with all of them.
    const own = withNames(node, scope);
    own.defs.forEach((d, i) => {
      name(d.name);
      const sees = own.recursive ? own.all : new Set([...scope, ...own.defs.slice(0, i).map((x) => x.name)]);
      visit(d.def?.stmt, sees);
    });
    const inner = own.all;
    if (node.type === "select") {
      select(node, scope);
      if (problem) return;
    }
    if (node.type && ["insert", "update", "delete", "replace", "create", "drop", "alter"].includes(String(node.type))) {
      return fail("writes_data", "The query changes data; OpenDash only reads.");
    }
    // A table, unless it names a CTE this query can see.
    if (
      typeof node.table === "string" &&
      ("db" in node || "as" in node) &&
      node.type !== "column_ref" &&
      (typeof node.db === "string" || !inner.has(node.table))
    ) {
      info.tables.push({
        schema: typeof node.db === "string" ? node.db : null,
        name: node.table,
        alias: typeof node.as === "string" ? node.as : null,
      });
      name(node.db);
      name(node.table);
      name(node.as);
    }
    if (node.type === "var")
      return fail("denied_clause", "Variables (@x, @@setting) aren't allowed in OpenDash queries.");
    if (node.type === "function" || node.type === "aggr_func") {
      const fn = fnName(node);
      if (denied(fn)) return fail("denied_function", `${fn}() isn't allowed in OpenDash queries.`);
      name(fn);
      if (node.type === "function") {
        // A stored or loadable function can read any table past every check: only MySQL's own run, by name, and a
        // call named with a schema is a stored function's however it's named.
        const schema = isNode(node.name) && isNode(node.name.schema) ? (node.name.schema as Node).value : null;
        if (schema)
          return fail(
            "denied_function",
            `${schema}.${fn}() isn't a built-in function; OpenDash runs MySQL's own only.`,
          );
        if (!isMySqlFunction(fn)) {
          return fail("denied_function", `${fn}() isn't one of MySQL's own functions; OpenDash runs those only.`);
        }
        functions.add(fn);
      }
      if (["sum", "avg", "count", "min", "max"].includes(fn)) {
        const arg = isNode(node.args) ? (node.args as Node).expr : null;
        const ref = columnRef(arg);
        if (ref) info.aggregates.push({ fn, ...ref });
      }
    }
    if (node.type === "column_ref") {
      const ref = columnRef(node);
      // The parser takes amount::numeric for a column of that name; MySQL doesn't parse it.
      if (ref?.column.includes("::")) {
        return fail("syntax", "MySQL casts with cast(x as decimal(12, 2)) or cast(x as char), not ::.");
      }
      if (ref) {
        info.references.push(ref);
        name(ref.qualifier);
        name(ref.column);
      }
    }
    if (typeof node.as === "string" && node.type !== "column_ref") name(node.as);
    if (isParam(node)) {
      params += 1;
      return;
    }
    if (node.type === "binary_expr") {
      const op = String(node.operator ?? "").toUpperCase();
      const left = columnRef(node.left);
      const right = columnRef(node.right);
      if (["=", "!=", "<>", "IN", "NOT IN"].includes(op) && (left || right)) {
        const found = literalOf(left ? node.right : node.left);
        if (found.values.length || found.params.length)
          info.literals.push({ ...((left ?? right) as NonNullable<typeof left>), ...found });
      }
    }
    for (const [key, v] of Object.entries(node)) {
      // The column_ref's own fields aren't nodes to walk; a WITH's bodies were read above, with their own scope.
      if (node.type === "column_ref" && (key === "column" || key === "table")) continue;
      if (key === "with") continue;
      visit(v, inner);
    }
  };
  visit(stmt, new Set());
  if (problem) return problem;
  info.params = Array.from({ length: params }, (_, i) => i + 1);
  info.identifiers = [...identifiers];
  info.functions = [...functions].sort();
  return { ok: true, info };
}
